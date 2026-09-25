#!/bin/bash
# Installs a built Slinger AppImage for the current user (Linux) and creates a desktop launcher.
#
#   ./install.sh [path/to/Slinger-x.y.z.AppImage]
#
# Build the AppImage first with `npm run electron:build` (output in ./release). Installing the
# .deb with `sudo dpkg -i release/*.deb` is the system-wide alternative and needs no script.
# Slinger's data lives in the Electron user-data directory (~/.config/Slinger), not here.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="Slinger"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/slinger"
APP_EXEC="${APP_DIR}/Slinger.AppImage"
APP_ICON="${APP_DIR}/icon.png"
DESKTOP_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/applications/slinger.desktop"

SOURCE_APP="${1:-}"
if [[ -z "$SOURCE_APP" ]]; then
  SOURCE_APP="$(ls -t "${SCRIPT_DIR}"/release/*.AppImage 2>/dev/null | head -n1 || true)"
fi
SOURCE_ICON="${SCRIPT_DIR}/build/icon.png"

if [[ -z "$SOURCE_APP" || ! -f "$SOURCE_APP" ]]; then
  echo "No AppImage found. Build one with 'npm run electron:build' or pass its path as an argument."
  exit 1
fi
if [[ ! -f "$SOURCE_ICON" ]]; then
  echo "Could not find icon at: $SOURCE_ICON"
  exit 1
fi

echo "Installing ${APP_NAME}..."
mkdir -p "$APP_DIR" "$(dirname "$DESKTOP_FILE")"
cp -f "$SOURCE_APP" "$APP_EXEC"
cp -f "$SOURCE_ICON" "$APP_ICON"
chmod +x "$APP_EXEC"

cat > "$DESKTOP_FILE" <<DESKTOP
[Desktop Entry]
Version=1.0
Type=Application
Name=${APP_NAME}
Comment=Slinger API Client
Exec=${APP_EXEC}
Icon=${APP_ICON}
Terminal=false
Categories=Development;Network;
StartupNotify=true
DESKTOP
chmod +x "$DESKTOP_FILE"
update-desktop-database "$(dirname "$DESKTOP_FILE")" 2>/dev/null || true

echo "Installed: $APP_EXEC"
echo "Launcher:  $DESKTOP_FILE"
echo "You can now search for '${APP_NAME}' in your application menu."
