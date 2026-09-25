#!/usr/bin/env bash
# Starts Ideabro inside a GitHub Codespace and makes port 8787 public, so APIMart can
# download uploaded images from https://<codespace>-8787.app.github.dev/files/...
set -u
cd "$(dirname "$0")/.."

# Rebuild if the code changed since the last build (e.g. after a git pull).
if [ ! -d web/dist ] || [ -n "$(find web/src server/src shared -newer web/dist -print -quit 2>/dev/null)" ]; then
  echo "Building Ideabro…"
  npm run build
fi

# Make the port public once the server is listening (APIMart can't log in to GitHub).
(
  for _ in $(seq 1 30); do
    sleep 2
    if curl -fs http://localhost:8787/api/health >/dev/null 2>&1; then
      if gh codespace ports visibility 8787:public -c "${CODESPACE_NAME:-}" >/dev/null 2>&1; then
        echo "✔ Port 8787 is public — APIMart can fetch your uploads."
      else
        echo "⚠ Could not make port 8787 public automatically."
        echo "  Open the PORTS tab, right-click 8787 → Port Visibility → Public."
      fi
      break
    fi
  done
) &

echo "Starting Ideabro on port 8787…"
exec npm start
