#!/usr/bin/env node

const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONFIG = {
  bindHost: "127.0.0.1",
  port: 17381,
  pollMs: 1000,
  submitRetryMs: 2000,
  fillText: "Your 1password password",
  startEnabled: true,
  dryRun: false,
  autoClick: true,
  clickHelper: path.join(__dirname, "native-click.swift"),
  promptText: "1Passwordがブラウザ拡張機能のロックを解除しようとしています。",
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
const SUBMIT_RETRY_MS = Number.parseInt(
  process.env.SUBMIT_RETRY_MS || String(config.submitRetryMs),
  10
);
const FILL_TEXT = process.env.FILL_TEXT || config.fillText;
const START_ENABLED =
  process.env.START_ENABLED === undefined ? Boolean(config.startEnabled) : process.env.START_ENABLED !== "false";
const DRY_RUN =
  process.env.DRY_RUN === undefined ? Boolean(config.dryRun) : process.env.DRY_RUN === "true";
const AUTO_CLICK =
  process.env.AUTO_CLICK === undefined ? Boolean(config.autoClick) : process.env.AUTO_CLICK !== "false";
const CLICK_HELPER = process.env.CLICK_HELPER || config.clickHelper;
const PROMPT_TEXT =
  process.env.PROMPT_TEXT || config.promptText;

const state = {
  enabled: START_ENABLED,
  dryRun: DRY_RUN,
  autoClick: AUTO_CLICK,
  clickHelper: CLICK_HELPER,
  promptVisible: false,
  pollMs: POLL_MS,
  fillText: FILL_TEXT,
  promptText: PROMPT_TEXT,
  checks: 0,
  typedCount: 0,
  clickedCount: 0,
  submitRetryMs: SUBMIT_RETRY_MS,
  lastCheckAt: null,
  lastFoundAt: null,
  lastTypedAt: null,
  lastClickedAt: null,
  lastSubmitAttemptAt: null,
  lastResult: null,
  lastError: null,
};

let inFlight = false;
let timer = null;
let server = null;

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildScript({ shouldType, shouldSubmit }) {
  const promptText = appleScriptString(PROMPT_TEXT);
  const fillText = appleScriptString(shouldType ? FILL_TEXT : "");
  const shouldSubmitScript = shouldSubmit ? "true" : "false";
  const clickHelper = appleScriptString(CLICK_HELPER);

  return `
set promptText to ${promptText}
set fillText to ${fillText}
set shouldSubmit to ${shouldSubmitScript}
set clickHelper to ${clickHelper}

on promptExists(promptText)
  tell application "System Events"
    if not (exists process "1Password") then return false

    tell process "1Password"
      repeat with checkWindow in windows
        try
          repeat with checkElement in entire contents of checkWindow
            try
              set checkName to name of checkElement as text
              if checkName contains promptText then return true
            end try
            try
              set checkValue to value of checkElement as text
              if checkValue contains promptText then return true
            end try
          end repeat
        end try
      end repeat
    end tell
  end tell

  return false
end promptExists

tell application "System Events"
  if not (exists process "1Password") then return "NOT_FOUND\\tNO_PROCESS"

  tell process "1Password"
    repeat with w in windows
      set matched to false
      set windowName to "unknown"
      try
        set windowName to name of w as text
      end try

      try
        set xs to entire contents of w
        repeat with x in xs
          try
            set elementName to name of x as text
            if elementName contains promptText then set matched to true
          end try
          try
            set elementValue to value of x as text
            if elementValue contains promptText then set matched to true
          end try
          if matched then exit repeat
        end repeat
      end try

      if matched then
        if fillText is "" and not shouldSubmit then return "FOUND\\t" & windowName

        set frontmost to true
        try
          perform action "AXRaise" of w
        end try
        delay 0.05

        try
          set targetField to missing value
          repeat with x in xs
            try
              if (role of x as text) is "AXTextField" then
                set targetField to x
                exit repeat
              end if
            end try
          end repeat

          if targetField is missing value then return "FOUND\\t" & windowName & "\\tNO_FIELD"

          set focused of targetField to true
          delay 0.05
          if fillText is not "" then
            keystroke "a" using command down
            delay 0.02
            keystroke fillText
            delay 0.15
          end if

          if shouldSubmit then
            delay 0.15
            try
              set submitButton to missing value
              repeat with x in xs
                try
                  if (role of x as text) is "AXButton" then
                    set buttonName to ""
                    try
                      set buttonName to name of x as text
                    end try

                    if buttonName does not contain "キャンセル" and buttonName does not contain "閉じる" and buttonName does not contain "フルスクリーン" and buttonName does not contain "しまう" then
                      set submitButton to x
                      exit repeat
                    end if
                  end if
                end try
              end repeat

              if submitButton is not missing value then
                set buttonPosition to position of submitButton
                set buttonSize to size of submitButton
                set clickX to (item 1 of buttonPosition) + round((item 1 of buttonSize) / 2)
                set clickY to (item 2 of buttonPosition) + round((item 2 of buttonSize) / 2)
              else
                set windowPosition to position of w
                set windowSize to size of w
                set clickX to (item 1 of windowPosition) + (item 1 of windowSize) - 44
                set fieldPosition to position of targetField
                set fieldSize to size of targetField
                set clickY to (item 2 of fieldPosition) + round((item 2 of fieldSize) / 2)
              end if

              do shell script quoted form of clickHelper & " " & clickX & " " & clickY
              delay 0.25

              if my promptExists(promptText) then
                key code 36
                if fillText is "" then
                  return "FOUND_SUBMITTED_RETURN\\t" & windowName & "\\tCOORD:" & clickX & "," & clickY
                end if
                return "FOUND_TYPED_SUBMITTED_RETURN\\t" & windowName & "\\tCOORD:" & clickX & "," & clickY
              end if

              if fillText is "" then
                return "FOUND_SUBMITTED\\t" & windowName & "\\tCOORD:" & clickX & "," & clickY
              end if

              return "FOUND_TYPED_SUBMITTED\\t" & windowName & "\\tCOORD:" & clickX & "," & clickY
            on error clickErrMsg number clickErrNo
              return "FOUND\\t" & windowName & "\\tSUBMIT_ERROR:" & clickErrNo & ":" & clickErrMsg
            end try
          end if

          return "FOUND_TYPED\\t" & windowName
        on error errMsg number errNo
          return "FOUND\\t" & windowName & "\\tTYPE_ERROR:" & errNo & ":" & errMsg
        end try
      end if
    end repeat
  end tell
end tell

return "NOT_FOUND"
`;
}

function runOsascript(script) {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error((stderr || stdout || `osascript exited ${code}`).trim()));
      }
    });
  });
}

async function pollOnce() {
  if (!state.enabled || inFlight) return;

  inFlight = true;
  state.checks += 1;
  state.lastCheckAt = new Date().toISOString();

  try {
    const nowMs = Date.now();
    const lastSubmitMs = state.lastSubmitAttemptAt ? Date.parse(state.lastSubmitAttemptAt) : 0;
    const shouldType = !state.promptVisible && !DRY_RUN;
    const shouldSubmit =
      AUTO_CLICK &&
      !DRY_RUN &&
      (!state.promptVisible || nowMs - lastSubmitMs >= SUBMIT_RETRY_MS);
    const result = await runOsascript(buildScript({ shouldType, shouldSubmit }));
    state.lastResult = result;
    state.lastError = null;

    if (result.startsWith("FOUND")) {
      state.promptVisible = true;
      state.lastFoundAt = new Date().toISOString();

      if (result.startsWith("FOUND_TYPED")) {
        state.typedCount += 1;
        state.lastTypedAt = new Date().toISOString();
      }

      if (result.includes("_SUBMITTED")) {
        state.clickedCount += 1;
        state.lastClickedAt = new Date().toISOString();
        state.lastSubmitAttemptAt = state.lastClickedAt;
      }
    } else {
      state.promptVisible = false;
      state.lastSubmitAttemptAt = null;
    }
  } catch (error) {
    state.lastError = error.message;
  } finally {
    inFlight = false;
  }
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function handleRequest(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/status") {
    sendJson(res, 200, state);
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
    state.promptVisible = false;
    state.lastSubmitAttemptAt = null;
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
    endpoints: ["GET /status", "POST /pause", "POST /resume", "POST /reset", "POST /stop"],
  });
}

server = http.createServer(handleRequest);
server.listen(PORT, HOST, () => {
  console.log(`1Password autofill watcher listening on http://${HOST}:${PORT}`);
  console.log(
    `Polling every ${POLL_MS} ms; will type ${JSON.stringify(FILL_TEXT)} once per prompt visibility.`
  );
  console.log(`Auto click is ${AUTO_CLICK ? "enabled" : "disabled"}.`);
  if (AUTO_CLICK) {
    console.log(`Submit retry interval is ${SUBMIT_RETRY_MS} ms while the prompt remains visible.`);
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
