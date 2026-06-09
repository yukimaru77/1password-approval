#!/bin/zsh
set -eu

cd "$(dirname "$0")"

export PATH="$HOME/.nodenv/shims:$HOME/.nodenv/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export BIND_HOST="${BIND_HOST:-127.0.0.1}"
export PORT="${PORT:-17381}"
export POLL_MS="${POLL_MS:-200}"
export DEEP_POLL_MS="${DEEP_POLL_MS:-1000}"
export OSASCRIPT_TIMEOUT_MS="${OSASCRIPT_TIMEOUT_MS:-3000}"
export SUBMIT_RETRY_MS="${SUBMIT_RETRY_MS:-500}"
export AUTO_SUBMIT="${AUTO_SUBMIT:-true}"

exec node server.js
