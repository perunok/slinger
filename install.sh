#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

APP_NAME="Slinger"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/slinger"
APP_EXEC="${APP_DIR}/slinger"
APP_ICON="${APP_DIR}/icon.png"
APP_DB="${APP_DIR}/slinger.db"
DESKTOP_FILE="$HOME/.local/share/applications/slinger.desktop"

SOURCE_APP="${SCRIPT_DIR}/slinger"
SOURCE_ICON="${SCRIPT_DIR}/icon.png"

if [[ ! -f "$SOURCE_APP" ]]; then
  echo "Could not find app binary at:"
  echo "  $SOURCE_APP"
  exit 1
fi

if [[ ! -f "$SOURCE_ICON" ]]; then
  echo "Could not find icon at:"
  echo "  $SOURCE_ICON"
  exit 1
fi

echo "Installing ${APP_NAME}..."

mkdir -p "$APP_DIR"
mkdir -p "$HOME/.local/share/applications"

if [[ "$SOURCE_APP" != "$APP_EXEC" ]]; then
  mv -f "$SOURCE_APP" "$APP_EXEC"
fi

if [[ "$SOURCE_ICON" != "$APP_ICON" ]]; then
  mv -f "$SOURCE_ICON" "$APP_ICON"
fi

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=${APP_NAME}
Comment=Slinger API Client
Exec=${APP_EXEC}
Icon=${APP_ICON}
Path=${APP_DIR}
Terminal=false
Categories=Development;Network;
StartupNotify=true
EOF

chmod +x "$APP_EXEC"
chmod +x "$DESKTOP_FILE"

update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

echo
echo "Installation completed."
echo "Application installed at:"
echo "  $APP_EXEC"
echo
echo "Application data directory:"
echo "  $APP_DIR"
echo
if [[ -f "$APP_DB" ]]; then
  echo "Existing database preserved at:"
  echo "  $APP_DB"
else
  echo "Database will be created on first launch at:"
  echo "  $APP_DB"
fi
echo
echo "Application launcher created:"
echo "  $DESKTOP_FILE"
echo
echo "You can now search for 'Slinger' in your application menu."
