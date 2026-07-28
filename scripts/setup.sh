#!/usr/bin/env bash
# One-command setup for OurAdventureBook (macOS).
# Installs Node deps, a Python venv with Pillow, and osxphotos (if pipx exists).
set -e
cd "$(dirname "$0")/.."

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m⚠\033[0m %s\n" "$1"; }

bold "OurAdventureBook — setup"

# --- Node ---
if ! command -v node >/dev/null 2>&1; then
  echo "✖ Node.js not found. Install Node 18+ (https://nodejs.org) and re-run."
  exit 1
fi
ok "Node $(node -v)"

bold "Installing Node dependencies…"
npm install --no-fund --no-audit
ok "Node packages installed"

# --- Python venv + Pillow ---
if ! command -v python3 >/dev/null 2>&1; then
  echo "✖ Python 3 not found. Install it (e.g. brew install python) and re-run."
  exit 1
fi
bold "Setting up Python (isolated venv) + Pillow…"
python3 -m venv .venv
./.venv/bin/python -m pip install --quiet --upgrade pip
./.venv/bin/python -m pip install --quiet Pillow pillow-heif
ok "Pillow (+ HEIC support) ready in ./.venv"

# --- osxphotos (needed to import photos from Apple Photos) ---
bold "Checking osxphotos…"
if command -v osxphotos >/dev/null 2>&1; then
  ok "osxphotos $(osxphotos --version 2>/dev/null | tail -1)"
elif command -v pipx >/dev/null 2>&1; then
  pipx install osxphotos && ok "osxphotos installed via pipx"
else
  warn "osxphotos not found. Install it with:"
  echo "      brew install pipx && pipx install osxphotos"
fi

echo
bold "Almost done!"
echo "  1) Grant your terminal Full Disk Access:"
echo "     System Settings → Privacy & Security → Full Disk Access → add your terminal"
echo "  2) Start the app:  npm run dev"
echo "     then open http://localhost:5173"
