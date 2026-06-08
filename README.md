# 1Password Autofill Server

Local macOS watcher that unlocks the 1Password browser extension prompt.

When this prompt appears:

```text
1Passwordがブラウザ拡張機能のロックを解除しようとしています。
```

the server brings the 1Password prompt forward, types the configured password, and clicks the unlock arrow.

## Requirements

- macOS
- Node.js 18 or newer
- Swift toolchain at `/usr/bin/swift`
- Accessibility permission for the app that launches the server

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
  "pollMs": 1000,
  "submitRetryMs": 2000,
  "fillText": "Your 1password password",
  "startEnabled": true,
  "dryRun": false,
  "autoClick": true
}
```

Environment override example:

```sh
FILL_TEXT='Your 1password password' AUTO_CLICK=false npm start
```

Dry run, which detects prompts but does not type or click:

```sh
DRY_RUN=true npm start
```

Start the HTTP server paused:

```sh
START_ENABLED=false npm start
```

## Clicking Behavior

The server does not rely on AppleScript `click at` for the unlock button. It:

1. Finds the 1Password prompt by its text.
2. Finds the password field and types `fillText`.
3. Finds the unlock arrow button from Accessibility.
4. Clicks the button center using `native-click.swift`.

`native-click.swift` posts a real mouse event through Quartz `CGEvent`, which is more reliable for the 1Password Electron UI.

If the prompt remains visible after submit, the server retries every `submitRetryMs` milliseconds and sends Return as a fallback.

## launchd

Install as a user LaunchAgent:

```sh
cd /Users/yukito-nonaka/infra-and-virtualization/2026/onepassword-autofill-server
chmod +x run-server.sh native-click.swift
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

If `native-click.swift` does not click, also check:

```text
System Settings -> Privacy & Security -> Input Monitoring
```

## Notes

- The prompt window is brought to the front before typing.
- The server is intended for local use only and binds to `127.0.0.1` by default.
- Keep real passwords out of tracked files.
