#!/usr/bin/env bash
# Install the agentcast hook + skill into Hermes Agent (default profile).
# Usage: bash hermes/install.sh            (symlinks, so `git pull` updates them)
#        HERMES_HOME=~/.hermes-work bash hermes/install.sh   (another profile)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"

if [ ! -d "$HOME_DIR" ]; then
  echo "Hermes home not found: $HOME_DIR (install Hermes Agent first)" >&2
  exit 1
fi
mkdir -p "$HOME_DIR/hooks" "$HOME_DIR/skills"

link() {
  local src="$1" dst="$2"
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    echo "skip: $dst exists and is not a symlink" >&2
    return
  fi
  ln -sfn "$src" "$dst"
  echo "linked $dst -> $src"
}
# the Hermes skill shares the Claude Code skill's scripts
ln -sfn "../../../skill/live-view/scripts" "$HERE/skills/agentcast/scripts"

link "$HERE/hooks/agentcast"  "$HOME_DIR/hooks/agentcast"
link "$HERE/skills/agentcast" "$HOME_DIR/skills/agentcast"

if [ ! -f "$HOME/.config/live-view.json" ] && [ -z "${LIVE_VIEW_URL:-}" ]; then
  echo
  echo "Next: create ~/.config/live-view.json"
  echo '  { "url": "https://<app>.onrender.com", "token": "<PUSH_TOKEN>" }'
fi
echo
echo "Restart the Hermes gateway so it loads the hook; the log should show:"
echo "  [hooks] Loaded hook 'agentcast' for events: [...]"
