#!/bin/sh
# Dispatch: reach the computer that runs Hermes from anywhere, with Sign in with Nous.
#
#   curl -fsSL https://raw.githubusercontent.com/mrcharlesiv/dispatch/main/connect.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/mrcharlesiv/dispatch/main/connect.sh | sh -s -- off
#   (also: status, --dry-run)
#
# Downloads connect/ into ~/.config/dispatch-edge/connect and runs it with Node (the Node Hermes ships is fine).
set -eu
SOURCE="https://raw.githubusercontent.com/mrcharlesiv/dispatch/main/connect"
DIR="$HOME/.config/dispatch-edge/connect"

usable() { [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null; }
NODE="$(command -v node 2>/dev/null || true)"
usable "$NODE" || NODE="$(ls -d "$HOME"/.hermes/tools/node-*/bin/node 2>/dev/null | tail -1 || true)"
if ! usable "$NODE"; then
  echo "Dispatch needs Node.js 20 or newer, which Hermes normally includes. Install Hermes first: https://hermes-agent.nousresearch.com/docs/"
  exit 1
fi

mkdir -p "$DIR"
chmod 700 "$HOME/.config/dispatch-edge" "$DIR" 2>/dev/null || true
for file in dispatch-connect.mjs dispatch-edge.mjs qr.mjs; do
  curl -fsSL "$SOURCE/$file" -o "$DIR/$file.tmp"
  mv "$DIR/$file.tmp" "$DIR/$file"
done

# Piped into sh, stdin is the script: give the sign-in steps the terminal back when there is one.
if (exec </dev/tty) 2>/dev/null; then exec "$NODE" "$DIR/dispatch-connect.mjs" "$@" </dev/tty; fi
exec "$NODE" "$DIR/dispatch-connect.mjs" "$@"
