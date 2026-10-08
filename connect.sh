#!/bin/sh
# Hermes HQ: reach the computer that runs Hermes from anywhere, with Sign in with Nous.
#
#   curl -fsSL https://raw.githubusercontent.com/mrcharlesiv/hermes-hq/main/connect.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/mrcharlesiv/hermes-hq/main/connect.sh | sh -s -- off
#   (also: status, --dry-run)
#
# Downloads connect/ into ~/.config/hermes-hq-edge/connect and runs it with Node (the Node Hermes ships is fine).
# A setup from before the rename (~/.config/dispatch-edge, com.dispatch.edge) is moved over by hermes-hq-connect.
# Source of truth: hermes-ios gateway-edge/ (this file, hermes-hq-connect.mjs, hermes-hq-edge.mjs, qr.mjs), and
# hermes-ios desktop-plugin/hermes-hq-theme/plugin.js, published as connect/hermes-hq-theme.js.
set -eu
SOURCE="https://raw.githubusercontent.com/mrcharlesiv/hermes-hq/main/connect"
DIR="$HOME/.config/hermes-hq-edge/connect"

usable() { [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null; }
NODE="$(command -v node 2>/dev/null || true)"
usable "$NODE" || NODE="$(ls -d "$HOME"/.hermes/tools/node-*/bin/node 2>/dev/null | tail -1 || true)"
if ! usable "$NODE"; then
  echo "Hermes HQ needs Node.js 20 or newer, which Hermes normally includes. Install Hermes first: https://hermes-agent.nousresearch.com/docs/"
  exit 1
fi

mkdir -p "$DIR"
chmod 700 "$HOME/.config/hermes-hq-edge" "$DIR" 2>/dev/null || true
for file in hermes-hq-connect.mjs hermes-hq-edge.mjs qr.mjs; do
  curl -fsSL "$SOURCE/$file" -o "$DIR/$file.tmp"
  mv "$DIR/$file.tmp" "$DIR/$file"
done
# The Hermes HQ theme for desktop Hermes: optional, so a failed download never stops the setup.
if curl -fsSL "$SOURCE/hermes-hq-theme.js" -o "$DIR/hermes-hq-theme.js.tmp" 2>/dev/null; then
  mv "$DIR/hermes-hq-theme.js.tmp" "$DIR/hermes-hq-theme.js"
else
  rm -f "$DIR/hermes-hq-theme.js.tmp"
fi

# Piped into sh, stdin is the script: give the sign-in steps the terminal back when there is one.
if (exec </dev/tty) 2>/dev/null; then exec "$NODE" "$DIR/hermes-hq-connect.mjs" "$@" </dev/tty; fi
exec "$NODE" "$DIR/hermes-hq-connect.mjs" "$@"
