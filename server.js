#!/usr/bin/env node

// 1Password browser-extension unlock-prompt autofill watcher.
//
// Design constraints (see README):
//   - No mouse-coordinate clicks. Acts only through the Accessibility API
//     (AXPress) and, when escalation is needed, the keyboard.
//   - Does not move/steal the user's mouse. The keyboard fallback only
//     activates the 1Password process (window focus), never the pointer.
//   - The secret (fillText) is never logged, printed, written to /status,
//     nor embedded in the osascript command line. It is handed to osascript
//     via an environment variable and read with `system attribute`.
//   - Tolerant to wording changes: matches by any of promptTexts OR any
//     promptKeywordGroups (all terms in a group present) OR window name.
//   - Confirms an unlock by observing that the prompt window disappeared,
//     escalating set-value -> keyboard until it is gone.
//   - Only ever inspects 1Password process windows. Never deep-walks Chrome
//     (that hangs), so "processNames" must stay 1Password-only.

const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONFIG = {
  bindHost: "127.0.0.1",
  port: 17381,
  pollMs: 200,
  deepPollMs: 1000,
  osascriptTimeoutMs: 6000,
  // While a prompt stays visible, wait this long after an attempt before
  // escalating to the next (more forceful) attempt.
  submitRetryMs: 1200,
  fillText: "Your 1password password",
  startEnabled: true,
  dryRun: false,
  autoSubmit: true,
  promptText: "1Passwordがブラウザ拡張機能のロックを解除しようとしています。",
  promptTexts: [
    "1Passwordがブラウザ拡張機能のロックを解除しようとしています。",
    "1Passwordがブラウザ拡張機能のロックを解除しようとしています",
    "1Passwordはロックを解除しようとしています",
    "ロックスクリーン — 1Password",
    "ロックスクリーン",
    "ブラウザ拡張機能のロックを解除",
    "ロックを解除しようとしています",
    "1Password is trying to unlock",
    "browser extension",
  ],
  // Each inner group matches when ALL of its terms appear in the window's
  // text. This survives copy/wording changes that break exact phrase match.
  promptKeywordGroups: [
    ["1Password", "ロック", "解除"],
    ["1Password", "ロックスクリーン"],
    ["ブラウザ", "拡張", "ロック", "解除"],
    ["1Password", "unlock"],
    ["browser", "extension", "unlock"],
  ],
  processNames: ["1Password", "1Password Browser Helper"],
  // After a non-intrusive attempt, how long to wait before re-checking that
  // the prompt is gone (used by /trigger's synchronous verify).
  verifyDelayMs: 700,
};

function readConfigFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, "config.json");
const LOCAL_CONFIG_PATH =
  process.env.LOCAL_CONFIG_PATH || path.join(__dirname, "config.local.json");
const fileConfig = {
  ...readConfigFile(CONFIG_PATH),
  ...readConfigFile(LOCAL_CONFIG_PATH),
};
const config = {
  ...DEFAULT_CONFIG,
  ...fileConfig,
};

const HOST = process.env.BIND_HOST || config.bindHost;
const PORT = Number.parseInt(process.env.PORT || String(config.port), 10);
const POLL_MS = Number.parseInt(process.env.POLL_MS || String(config.pollMs), 10);
const DEEP_POLL_MS = Number.parseInt(
  process.env.DEEP_POLL_MS || String(config.deepPollMs),
  10
);
const OSASCRIPT_TIMEOUT_MS = Number.parseInt(
  process.env.OSASCRIPT_TIMEOUT_MS || String(config.osascriptTimeoutMs),
  10
);
const SUBMIT_RETRY_MS = Number.parseInt(
  process.env.SUBMIT_RETRY_MS || String(config.submitRetryMs),
  10
);
const VERIFY_DELAY_MS = Number.parseInt(
  process.env.VERIFY_DELAY_MS || String(config.verifyDelayMs),
  10
);
// SECRET. Never log this, never put it in /status, never embed it in the
// osascript command line. It is only ever passed via the child's env.
const FILL_TEXT = process.env.FILL_TEXT || config.fillText;
const FILL_TEXT_CONFIGURED = Boolean(FILL_TEXT && FILL_TEXT !== DEFAULT_CONFIG.fillText);

const START_ENABLED =
  process.env.START_ENABLED === undefined
    ? Boolean(config.startEnabled)
    : process.env.START_ENABLED !== "false";
const DRY_RUN =
  process.env.DRY_RUN === undefined ? Boolean(config.dryRun) : process.env.DRY_RUN === "true";
const AUTO_SUBMIT =
  process.env.AUTO_SUBMIT !== undefined
    ? process.env.AUTO_SUBMIT !== "false"
    : Boolean(config.autoSubmit);
const PROMPT_TEXTS = (
  process.env.PROMPT_TEXTS
    ? process.env.PROMPT_TEXTS.split("|")
    : process.env.PROMPT_TEXT
      ? [process.env.PROMPT_TEXT]
      : config.promptTexts || [config.promptText]
).filter(Boolean);
const PROMPT_KEYWORD_GROUPS = (
  process.env.PROMPT_KEYWORD_GROUPS
    ? process.env.PROMPT_KEYWORD_GROUPS.split("|").map((group) =>
        group.split(",").map((term) => term.trim()).filter(Boolean)
      )
    : config.promptKeywordGroups || []
).filter((group) => Array.isArray(group) && group.length > 0);
const PROCESS_NAMES = (
  process.env.PROCESS_NAMES
    ? process.env.PROCESS_NAMES.split(",")
    : config.processNames
)
  .map((name) => name.trim())
  .filter(Boolean);

const state = {
  enabled: START_ENABLED,
  dryRun: DRY_RUN,
  autoSubmit: AUTO_SUBMIT,
  promptVisible: false,
  pollMs: POLL_MS,
  deepPollMs: DEEP_POLL_MS,
  osascriptTimeoutMs: OSASCRIPT_TIMEOUT_MS,
  submitRetryMs: SUBMIT_RETRY_MS,
  verifyDelayMs: VERIFY_DELAY_MS,
  // boolean only -- the secret itself is never exposed.
  fillTextConfigured: FILL_TEXT_CONFIGURED,
  promptTextCount: PROMPT_TEXTS.length,
  promptKeywordGroupCount: PROMPT_KEYWORD_GROUPS.length,
  processNames: PROCESS_NAMES,
  // Counters / timestamps. None of these carry secret material.
  checks: 0,
  attemptCount: 0, // total fill/submit attempts across all episodes
  typedCount: 0,
  submittedCount: 0,
  unlockConfirmedCount: 0, // prompts confirmed gone after our action
  currentEpisodeAttempts: 0, // attempts against the currently-visible prompt
  lastActionMode: null, // "axfill" | "keyboard" | null
  lastCheckAt: null,
  lastDeepCheckAt: null,
  lastFoundAt: null,
  lastTypedAt: null,
  lastSubmittedAt: null,
  lastUnlockConfirmedAt: null,
  lastTriggerAt: null,
  lastTriggerResult: null, // sanitized {found, unlocked, via}
  lastDurationMs: null,
  lastResult: null, // result CODE only (no field values)
  lastWindow: null, // window name (e.g. "ロックスクリーン") -- not secret
  lastProcess: null,
  lastError: null,
};

let inFlight = false;
let timer = null;
let server = null;
let lastActionMs = 0;
let lastDeepMs = 0;

// ---------------------------------------------------------------------------
// AppleScript generation
// ---------------------------------------------------------------------------

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function appleScriptList(values) {
  if (!values.length) return "{}";
  return `{${values.map(appleScriptString).join(", ")}}`;
}

function appleScriptListOfLists(values) {
  if (!values.length) return "{}";
  return `{${values.map(appleScriptList).join(", ")}}`;
}

// mode: "detect" | "axfill" | "keyboard"
// deep: when true, scan window contents text (slower); when false, match by
//       window name only (cheap, run every poll).
function buildScript({ mode, deep }) {
  const promptTexts = appleScriptList(PROMPT_TEXTS);
  const keywordGroups = appleScriptListOfLists(PROMPT_KEYWORD_GROUPS);
  const processNames = appleScriptList(PROCESS_NAMES);
  const deepFlag = deep ? "true" : "false";
  const modeStr = appleScriptString(mode);

  return `
set promptTexts to ${promptTexts}
set keywordGroups to ${keywordGroups}
set processNames to ${processNames}
set deepScan to ${deepFlag}
set runMode to ${modeStr}

-- The secret is read from the environment, never from the script source.
set fillText to ""
if runMode is not "detect" then
  try
    set fillText to (system attribute "OP_FILL_TEXT")
  end try
end if

on textContainsAny(candidateText, patterns)
  repeat with patternText in patterns
    try
      ignoring case
        if candidateText contains (patternText as text) then return true
      end ignoring
    end try
  end repeat
  return false
end textContainsAny

on textHasAllGroups(candidateText, groups)
  repeat with grp in groups
    set allPresent to true
    repeat with term in grp
      try
        ignoring case
          if candidateText does not contain (term as text) then set allPresent to false
        end ignoring
      on error
        set allPresent to false
      end try
      if not allPresent then exit repeat
    end repeat
    if allPresent and (count of grp) > 0 then return true
  end repeat
  return false
end textHasAllGroups

-- Build one text blob from a window's static elements. Reads only name and
-- description (never value), so typed/secure content can never be captured.
on windowTextBlob(w)
  set acc to ""
  try
    tell application "System Events" to set els to entire contents of w
    repeat with el in els
      try
        tell application "System Events" to set acc to acc & " " & (name of el as text)
      end try
      try
        tell application "System Events" to set acc to acc & " " & (description of el as text)
      end try
    end repeat
  end try
  return acc
end windowTextBlob

on windowName(w)
  set wn to ""
  try
    tell application "System Events" to set wn to name of w as text
  end try
  return wn
end windowName

on windowMatches(w, promptTexts, keywordGroups, deepScan)
  set wn to my windowName(w)
  -- NOTE: deliberately do NOT match a bare "1Password" window name. The
  -- unlocked main app window is also named "1Password"; matching it would let
  -- the keyboard fallback type the master password into the search box. We
  -- match distinctive lock-screen wording instead, and every action path is
  -- additionally gated on the presence of a secure password field.
  if wn contains "ロックスクリーン" then return true
  if my textContainsAny(wn, promptTexts) then return true
  if not deepScan then return false
  set blob to my windowTextBlob(w)
  if my textContainsAny(blob, promptTexts) then return true
  if my textHasAllGroups(blob, keywordGroups) then return true
  return false
end windowMatches

on buttonLabel(el)
  set parts to {}
  try
    tell application "System Events" to set end of parts to name of el as text
  end try
  try
    tell application "System Events" to set end of parts to description of el as text
  end try
  set AppleScript's text item delimiters to " "
  set joined to parts as text
  set AppleScript's text item delimiters to ""
  return joined
end buttonLabel

-- True iff the element is the secure password field. 1Password reports it as
-- role AXTextField with subrole AXSecureTextField, so we must check subrole.
on isSecureField(el)
  try
    tell application "System Events" to set elSubrole to subrole of el as text
    if elSubrole is "AXSecureTextField" then return true
  end try
  try
    tell application "System Events" to set elRole to role of el as text
    if elRole is "AXSecureTextField" then return true
  end try
  return false
end isSecureField

-- Fill the secure field via the Accessibility value and try a non-intrusive
-- submit (AXConfirm on the field, then any explicitly named unlock button).
-- Secure-field-only on purpose: never type the master password into a plain,
-- visible field. Does not move the mouse or bring the app forward.
-- Returns: "NOFIELD" | "FILLED".
on axfillAndSubmit(w, fillText)
  if fillText is "" then return "NOFIELD"
  try
    tell application "System Events" to set els to entire contents of w
  on error
    return "NOFIELD"
  end try
  set fieldRef to missing value
  repeat with el in els
    if my isSecureField(el) then
      set fieldRef to el
      exit repeat
    end if
  end repeat
  if fieldRef is missing value then return "NOFIELD"
  try
    tell application "System Events"
      set focused of fieldRef to true
      set value of fieldRef to fillText
    end tell
  end try
  -- Non-intrusive submit attempt 1: confirm the field directly.
  try
    tell application "System Events" to perform action "AXConfirm" of fieldRef
  end try
  -- Non-intrusive submit attempt 2: press an explicitly named unlock button.
  -- (No blind "press the only button" fallback: the unlock control is often
  -- unnamed and a lone visible button may be the show-password toggle.)
  my pressNamedUnlock(w)
  return "FILLED"
end axfillAndSubmit

-- Press a button whose label clearly names the unlock/approve action. Skips
-- destructive and window-control buttons. Returns "PRESS" or "".
on pressNamedUnlock(w)
  set actionNames to {"ロック解除", "Unlock", "承認", "Approve", "許可", "Allow", "サインインして解除", "Sign In"}
  set skipNames to {"キャンセル", "Cancel", "閉じる", "Close", "フルスクリーン", "しまう", "Minimize", "Zoom", "パスワードを表示", "Reveal", "Show"}
  set skipSubroles to {"AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton"}
  try
    tell application "System Events" to set els to entire contents of w
  on error
    return ""
  end try
  repeat with el in els
    try
      tell application "System Events" to set elRole to role of el as text
      if elRole is "AXButton" then
        set elSubrole to ""
        try
          tell application "System Events" to set elSubrole to subrole of el as text
        end try
        if my textContainsAny(elSubrole, skipSubroles) is false then
          set lbl to my buttonLabel(el)
          if my textContainsAny(lbl, skipNames) is false and my textContainsAny(lbl, actionNames) then
            try
              tell application "System Events" to perform action "AXPress" of el
              delay 0.15
              return "PRESS"
            end try
          end if
        end if
      end if
    end try
  end repeat
  return ""
end pressNamedUnlock

-- Keyboard fallback. Brings the owning process forward (window focus only;
-- the mouse is never moved), focuses the field, replaces its content, and
-- presses Return. Allowed by spec when set-value does not register as input.
on keyboardSubmit(processName, w, fillText)
  if fillText is "" then return false
  -- Refuse to type unless there is a real secure field to focus. This is the
  -- guard that prevents keystrokes from leaking into a mis-detected window.
  set foundField to false
  try
    tell application "System Events" to set els to entire contents of w
    repeat with el in els
      if my isSecureField(el) then
        set foundField to true
        exit repeat
      end if
    end repeat
  end try
  if not foundField then return false
  try
    tell application "System Events" to set frontmost of process processName to true
  end try
  delay 0.2
  -- Re-focus the secure field now that the app is frontmost.
  try
    tell application "System Events" to set els to entire contents of w
    repeat with el in els
      if my isSecureField(el) then
        tell application "System Events" to set focused of el to true
        exit repeat
      end if
    end repeat
  end try
  delay 0.05
  try
    tell application "System Events"
      keystroke "a" using {command down}
      delay 0.05
      keystroke fillText
      delay 0.08
      key code 36
    end tell
    return true
  on error
    return false
  end try
end keyboardSubmit

tell application "System Events"
  set sawProcess to false
  repeat with processNameItem in processNames
    set processName to processNameItem as text
    if exists process processName then
      set sawProcess to true
      tell process processName
        repeat with w in windows
          if my windowMatches(w, promptTexts, keywordGroups, deepScan) then
            set wn to my windowName(w)
            if runMode is "detect" then
              return "PROMPT" & "\\t" & processName & "\\t" & wn
            else if runMode is "axfill" then
              set fillRes to my axfillAndSubmit(w, fillText)
              if fillRes is "FILLED" then return "AXFILL_PRESS" & "\\t" & processName & "\\t" & wn
              -- No secure field: not a real unlock prompt; take no action.
              return "PROMPT_NOFIELD" & "\\t" & processName & "\\t" & wn
            else
              set ok to my keyboardSubmit(processName, w, fillText)
              if ok then return "KEYBOARD_DONE" & "\\t" & processName & "\\t" & wn
              return "KEYBOARD_FAILED" & "\\t" & processName & "\\t" & wn
            end if
          end if
        end repeat
      end tell
    end if
  end repeat
  if not sawProcess then return "NONE\\tNO_PROCESS"
end tell

return "NONE"
`;
}

// ---------------------------------------------------------------------------
// osascript runner
// ---------------------------------------------------------------------------

// includeSecret: when true, OP_FILL_TEXT is injected into the child's env so
// the AppleScript can read it via `system attribute`. The secret never appears
// in argv (so it stays out of `ps`).
function runOsascript(script, includeSecret) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (includeSecret) {
      env.OP_FILL_TEXT = FILL_TEXT;
    } else {
      delete env.OP_FILL_TEXT;
    }

    const child = spawn("osascript", ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`osascript timed out after ${OSASCRIPT_TIMEOUT_MS} ms`));
    }, OSASCRIPT_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error((stderr || stdout || `osascript exited ${code}`).trim()));
      }
    });
  });
}

function parseResult(raw) {
  const [code, proc, win] = String(raw).split("\t");
  return { code: code || "NONE", proc: proc || null, win: win || null };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordConfirmedUnlock() {
  state.unlockConfirmedCount += 1;
  state.lastUnlockConfirmedAt = new Date().toISOString();
}

function resetEpisode() {
  state.promptVisible = false;
  state.currentEpisodeAttempts = 0;
  lastActionMs = 0;
}

// ---------------------------------------------------------------------------
// Detection + escalation
// ---------------------------------------------------------------------------

async function detect() {
  const nowMs = Date.now();
  // Cheap name-only scan every poll.
  let raw = await runOsascript(buildScript({ mode: "detect", deep: false }), false);
  let parsed = parseResult(raw);
  // Slower content scan only on the deep cadence, and only if cheap missed.
  if (parsed.code === "NONE" && nowMs - lastDeepMs >= DEEP_POLL_MS) {
    lastDeepMs = nowMs;
    state.lastDeepCheckAt = new Date().toISOString();
    raw = await runOsascript(buildScript({ mode: "detect", deep: true }), false);
    parsed = parseResult(raw);
  }
  return parsed;
}

function applyActionResult(parsed) {
  state.lastResult = parsed.code;
  state.lastWindow = parsed.win;
  state.lastProcess = parsed.proc;
  state.attemptCount += 1;
  state.currentEpisodeAttempts += 1;
  lastActionMs = Date.now();
  if (parsed.code === "AXFILL_PRESS" || parsed.code === "AXFILL_NOPRESS") {
    state.typedCount += 1;
    state.lastTypedAt = new Date().toISOString();
    state.lastActionMode = "axfill";
    if (parsed.code === "AXFILL_PRESS") {
      state.submittedCount += 1;
      state.lastSubmittedAt = new Date().toISOString();
    }
  } else if (parsed.code === "KEYBOARD_DONE") {
    state.typedCount += 1;
    state.submittedCount += 1;
    state.lastTypedAt = new Date().toISOString();
    state.lastSubmittedAt = new Date().toISOString();
    state.lastActionMode = "keyboard";
  }
}

async function pollOnce() {
  if (!state.enabled || inFlight) return;
  inFlight = true;
  state.checks += 1;
  state.lastCheckAt = new Date().toISOString();
  const startedAt = Date.now();

  try {
    const det = await detect();
    state.lastError = null;

    if (det.code === "NONE") {
      // If we had been working an episode and it is now gone, the prompt
      // was dismissed -- treat as a confirmed unlock.
      if (state.promptVisible && state.currentEpisodeAttempts > 0) {
        recordConfirmedUnlock();
      }
      resetEpisode();
      state.lastResult = "NONE";
      state.lastWindow = null;
      state.lastProcess = null;
      state.lastDurationMs = Date.now() - startedAt;
      return;
    }

    // A prompt is present.
    state.promptVisible = true;
    state.lastFoundAt = new Date().toISOString();
    state.lastWindow = det.win;
    state.lastProcess = det.proc;
    state.lastResult = det.code;

    if (DRY_RUN || !AUTO_SUBMIT) {
      state.lastDurationMs = Date.now() - startedAt;
      return;
    }

    // Escalation ladder. First attempt is the non-intrusive set-value path.
    // If the prompt is still up after submitRetryMs, escalate to keyboard.
    let mode = null;
    if (state.currentEpisodeAttempts === 0) {
      mode = "axfill";
    } else if (Date.now() - lastActionMs >= SUBMIT_RETRY_MS) {
      mode = "keyboard";
    }

    if (mode) {
      const actionRaw = await runOsascript(buildScript({ mode, deep: true }), true);
      applyActionResult(parseResult(actionRaw));
    }

    state.lastDurationMs = Date.now() - startedAt;
  } catch (error) {
    state.lastError = error.message;
  } finally {
    inFlight = false;
  }
}

// Forced, synchronous unlock attempt for manual use. Escalates set-value ->
// keyboard and confirms success by re-checking that the prompt disappeared.
async function forceUnlock() {
  state.lastTriggerAt = new Date().toISOString();

  if (DRY_RUN) {
    const det = await detect();
    const result = { found: det.code !== "NONE", unlocked: false, via: "dry-run" };
    state.lastTriggerResult = result;
    return result;
  }

  // Attempt 1: non-intrusive set-value + AXPress.
  const r1 = parseResult(await runOsascript(buildScript({ mode: "axfill", deep: true }), true));
  if (r1.code === "NONE") {
    const result = { found: false, unlocked: false, via: null };
    state.lastTriggerResult = result;
    return result;
  }
  state.promptVisible = true;
  state.lastFoundAt = new Date().toISOString();
  state.lastWindow = r1.win;
  state.lastProcess = r1.proc;
  applyActionResult(r1);

  await sleep(VERIFY_DELAY_MS);
  let check = await detect();
  if (check.code === "NONE") {
    recordConfirmedUnlock();
    resetEpisode();
    const result = { found: true, unlocked: true, via: "axfill" };
    state.lastTriggerResult = result;
    return result;
  }

  // Attempt 2: keyboard fallback.
  const r2 = parseResult(await runOsascript(buildScript({ mode: "keyboard", deep: true }), true));
  applyActionResult(r2);
  await sleep(VERIFY_DELAY_MS + 200);
  check = await detect();
  const unlocked = check.code === "NONE";
  if (unlocked) {
    recordConfirmedUnlock();
    resetEpisode();
  }
  const result = { found: true, unlocked, via: "keyboard" };
  state.lastTriggerResult = result;
  return result;
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch (e) {
    sendJson(res, 400, { error: "Bad request" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/status") {
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "POST" && url.pathname === "/trigger") {
    if (inFlight) {
      sendJson(res, 409, { ok: false, error: "Another check is in flight; try again." });
      return;
    }
    inFlight = true;
    try {
      const result = await forceUnlock();
      sendJson(res, 200, { ok: true, ...result, lastResult: state.lastResult, lastWindow: state.lastWindow });
    } catch (error) {
      state.lastError = error.message;
      sendJson(res, 500, { ok: false, error: error.message });
    } finally {
      inFlight = false;
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/pause") {
    state.enabled = false;
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "POST" && url.pathname === "/resume") {
    state.enabled = true;
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "POST" && url.pathname === "/reset") {
    resetEpisode();
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "POST" && url.pathname === "/stop") {
    sendJson(res, 200, { ok: true, message: "Stopping server." });
    clearInterval(timer);
    server.close(() => process.exit(0));
    return;
  }

  sendJson(res, 404, {
    error: "Not found",
    endpoints: [
      "GET /status",
      "POST /trigger",
      "POST /pause",
      "POST /resume",
      "POST /reset",
      "POST /stop",
    ],
  });
}

server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    try {
      sendJson(res, 500, { ok: false, error: error.message });
    } catch (e) {
      // response already sent
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`1Password autofill watcher listening on http://${HOST}:${PORT}`);
  console.log(
    `Polling every ${POLL_MS} ms; fill text configured: ${FILL_TEXT_CONFIGURED ? "yes" : "no"}.`
  );
  console.log(`osascript timeout is ${OSASCRIPT_TIMEOUT_MS} ms.`);
  console.log(`Watching processes: ${PROCESS_NAMES.join(", ")}`);
  console.log(
    `Prompt patterns: ${PROMPT_TEXTS.length} text, ${PROMPT_KEYWORD_GROUPS.length} keyword groups.`
  );
  console.log(`Auto submit is ${AUTO_SUBMIT ? "enabled" : "disabled"}.`);
  if (AUTO_SUBMIT) {
    console.log(
      `Escalates set-value -> keyboard after ${SUBMIT_RETRY_MS} ms if the prompt remains visible.`
    );
  }
  if (!START_ENABLED) {
    console.log("Watcher starts paused because START_ENABLED=false.");
  }
  if (DRY_RUN) {
    console.log("Dry run is enabled; prompts are detected but no text is typed.");
  }
});

timer = setInterval(pollOnce, POLL_MS);
pollOnce();
