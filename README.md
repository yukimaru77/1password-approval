# 1Password Autofill Server

Local macOS watcher that unlocks the 1Password browser extension prompt.

When this prompt appears:

```text
1Passwordがブラウザ拡張機能のロックを解除しようとしています。
```

the server fills the configured password into the prompt's secure field and
presses the unlock button — entirely through the Accessibility API. It never
moves the mouse and never clicks screen coordinates. It confirms success by
observing that the prompt window disappeared, escalating to a keyboard fallback
if a plain Accessibility `set value` did not register as input.

## Requirements

- macOS
- Node.js 18 or newer
- Accessibility permission for the app that launches the server (and for
  `/usr/bin/osascript` when run from the LaunchAgent)

## Setup

Create a local config file:

```sh
cd /Users/yukito-nonaka/infra-and-virtualization/2026/onepassword-autofill-server
cp config.example.json config.local.json
```

Edit `config.local.json` and set:

```json
{
  "fillText": "Your 1password password"
}
```

`config.local.json` is ignored by Git. Do not commit a real 1Password password.

## Run

```sh
cd /Users/yukito-nonaka/infra-and-virtualization/2026/onepassword-autofill-server
npm start
```

Or:

```sh
./run-server.sh
```

The default server URL is:

```text
http://127.0.0.1:17381
```

## API

Status:

```sh
curl http://127.0.0.1:17381/status
```

The status response reports whether `fillText` is configured, but never returns
the secret itself, and carries no field values — only result codes, counters,
timestamps, and (non-secret) window names.

Force a one-shot unlock attempt right now, regardless of poll timing or state.
It tries the non-intrusive `set value` path, re-checks that the prompt is gone,
and escalates to the keyboard fallback if needed. The JSON reports whether the
prompt was `found` and whether it was `unlocked` (confirmed gone):

```sh
curl -X POST http://127.0.0.1:17381/trigger
# {"ok":true,"found":true,"unlocked":true,"via":"axfill", ...}
```

Pause and resume:

```sh
curl -X POST http://127.0.0.1:17381/pause
curl -X POST http://127.0.0.1:17381/resume
```

Re-arm while the same prompt is still visible:

```sh
curl -X POST http://127.0.0.1:17381/reset
```

Stop:

```sh
curl -X POST http://127.0.0.1:17381/stop
```

## Configuration

Configuration is merged in this order:

1. Built-in defaults
2. `config.json`
3. `config.local.json`
4. Environment variables

Tracked example:

```sh
config.example.json
```

Local secret config:

```sh
config.local.json
```

Useful options:

```json
{
  "bindHost": "127.0.0.1",
  "port": 17381,
  "pollMs": 200,
  "deepPollMs": 1000,
  "osascriptTimeoutMs": 3000,
  "submitRetryMs": 500,
  "fillText": "Your 1password password",
  "startEnabled": true,
  "dryRun": false,
  "autoSubmit": true,
  "promptTexts": [
    "1Passwordがブラウザ拡張機能のロックを解除しようとしています。",
    "1Passwordはロックを解除しようとしています",
    "ロックスクリーン — 1Password",
    "ロックスクリーン",
    "ブラウザ拡張機能のロックを解除",
    "ロックを解除しようとしています",
    "1Password is trying to unlock",
    "browser extension"
  ],
  "promptKeywordGroups": [
    ["1Password", "ロック", "解除"],
    ["1Password", "ロックスクリーン"],
    ["ブラウザ", "拡張", "ロック", "解除"],
    ["1Password", "unlock"],
    ["browser", "extension", "unlock"]
  ],
  "processNames": ["1Password", "1Password Browser Helper"]
}
```

Environment override example:

```sh
FILL_TEXT='Your 1password password' AUTO_SUBMIT=false npm start
```

Dry run, which detects prompts but does not type or submit:

```sh
DRY_RUN=true npm start
```

Start the HTTP server paused:

```sh
START_ENABLED=false npm start
```

## Submit Behavior

The server never uses mouse coordinates and never moves the pointer. It only
ever inspects the windows of the 1Password processes (never Chrome's
Accessibility tree, which hangs). For each poll:

1. **Detect.** A cheap window-name scan runs every poll; a deeper window-text
   scan runs on the `deepPollMs` cadence. A window matches if its text matches
   any `promptTexts` phrase, or all terms of any `promptKeywordGroups` entry, or
   its name contains a lock-screen marker. A match is only ever acted on if the
   window actually contains a secure password field — so the unlocked main app
   window (also named "1Password") is never mistaken for a prompt.
2. **Fill + press (non-intrusive).** Sets the secure field's Accessibility
   value to `fillText` and presses the unlock/approve button via `AXPress`. This
   does not move the mouse or bring any window forward.
3. **Verify.** On a later poll, if the prompt window has disappeared, the unlock
   is counted as confirmed (`unlockConfirmedCount`).
4. **Escalate (keyboard fallback).** If the prompt is still visible after
   `submitRetryMs`, the server brings the owning 1Password process forward
   (window focus only — the mouse is untouched), focuses the secure field, and
   types `fillText` followed by Return. This handles the case where a plain
   `set value` is not registered as real input. It refuses to type unless a
   secure field is present.

The secret is handed to `osascript` through an environment variable read with
`system attribute`, so it never appears on the command line (and thus never in
`ps`).

## launchd

Install as a user LaunchAgent:

```sh
cd /Users/yukito-nonaka/infra-and-virtualization/2026/onepassword-autofill-server
chmod +x run-server.sh
cp launchd/com.local.onepassword-autofill-server.plist ~/Library/LaunchAgents/
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.local.onepassword-autofill-server.plist
launchctl enable "gui/$(id -u)/com.local.onepassword-autofill-server"
```

Unload:

```sh
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.local.onepassword-autofill-server.plist
```

Logs:

```sh
tail -f server.log
tail -f server.err.log
```

## macOS Permissions

The process that starts the server needs Accessibility permission.

Open:

```text
System Settings -> Privacy & Security -> Accessibility
```

Enable your terminal app, Node.js, or the launcher used by `launchd`.

When running as the bundled LaunchAgent, macOS may report:

```text
osascriptには補助アクセスは許可されません
```

In that case, add and enable `/usr/bin/osascript` in Accessibility. If the file
picker does not show it, press `Cmd+Shift+G`, enter `/usr/bin/osascript`, and add
that executable.

## Notes

- The non-intrusive path neither moves the mouse nor changes window focus. Only
  the keyboard fallback brings the 1Password process forward (focus only).
- `processNames` must stay 1Password-only. Adding Chrome makes the deep
  Accessibility scan walk Chrome's tree, which hangs.
- The server is intended for local use only and binds to `127.0.0.1` by default.
- Keep real passwords out of tracked files (`config.local.json` is gitignored).
