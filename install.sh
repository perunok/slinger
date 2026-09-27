#!/bin/bash
# Installs a built Slinger for the current user and adds a `slinger` terminal command.
#
#   ./install.sh [path/to/Slinger-x.y.z.AppImage | path/to/Slinger-x.y.z-mac-<arch>.dmg]
#
# Linux: copies the AppImage to ~/.local/share/slinger and creates a desktop launcher. Installing the
#        .deb with `sudo dpkg -i release/*.deb` is the system-wide alternative and needs no script.
# macOS: copies Slinger.app out of the DMG into /Applications (~/Applications when that is not
#        writable). Build the DMG with `npm run electron:build -- --mac dmg -c.mac.identity=-`.
#
# Without an argument the newest matching build in ./release is used. The `slinger` command goes to
# $SLINGER_BIN_DIR, else ~/.local/bin on Linux and the first writable of /opt/homebrew/bin and
# /usr/local/bin on macOS (falling back to ~/.local/bin).
# Slinger's data lives in the Electron user-data directory, not here, so reinstalling keeps it.
# Written for bash 3.2 (the macOS /bin/bash).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="Slinger"

newest() {
  ls -t "$@" 2>/dev/null | head -n1 || true
}

# Writes stdin to <bin dir>/slinger as an executable and says whether that directory is on PATH.
install_command() {
  local bin_dir="$1"
  local target="${bin_dir}/slinger"
  mkdir -p "$bin_dir"
  cat > "$target"
  chmod +x "$target"
  echo "Command:   $target"
  case ":${PATH}:" in
    *":${bin_dir}:"*) echo "Type 'slinger' in a terminal to open ${APP_NAME}." ;;
    *) echo "Add ${bin_dir} to your PATH to use the 'slinger' command." ;;
  esac
}

install_linux() {
  local app_dir="${XDG_DATA_HOME:-$HOME/.local/share}/slinger"
  local app_exec="${app_dir}/Slinger.AppImage"
  local app_icon="${app_dir}/icon.png"
  local desktop_file="${XDG_DATA_HOME:-$HOME/.local/share}/applications/slinger.desktop"
  local source_app="${1:-$(newest "${SCRIPT_DIR}"/release/*.AppImage)}"
  local source_icon="${SCRIPT_DIR}/build/icon.png"

  if [[ -z "$source_app" || ! -f "$source_app" ]]; then
    echo "No AppImage found. Build one with 'npm run electron:build' or pass its path as an argument."
    exit 1
  fi
  if [[ ! -f "$source_icon" ]]; then
    echo "Could not find icon at: $source_icon"
    exit 1
  fi

  echo "Installing ${APP_NAME}..."
  mkdir -p "$app_dir" "$(dirname "$desktop_file")"
  cp -f "$source_app" "$app_exec"
  cp -f "$source_icon" "$app_icon"
  chmod +x "$app_exec"

  cat > "$desktop_file" <<DESKTOP
[Desktop Entry]
Version=1.0
Type=Application
Name=${APP_NAME}
Comment=Slinger API Client
Exec=${app_exec}
Icon=${app_icon}
Terminal=false
Categories=Development;Network;
StartupNotify=true
DESKTOP
  chmod +x "$desktop_file"
  update-desktop-database "$(dirname "$desktop_file")" 2>/dev/null || true

  echo "Installed: $app_exec"
  echo "Launcher:  $desktop_file"
  # Detached, so the terminal is free again and closing it does not quit the app.
  install_command "${SLINGER_BIN_DIR:-$HOME/.local/bin}" <<COMMAND
#!/bin/sh
# Starts ${APP_NAME} in the background (written by install.sh).
nohup "${app_exec}" "\$@" >/dev/null 2>&1 &
COMMAND
  echo "You can also search for '${APP_NAME}' in your application menu."
}

install_macos() {
  local arch
  case "$(uname -m)" in
    arm64) arch="arm64" ;;
    *) arch="x64" ;;
  esac
  local dmg="${1:-$(newest "${SCRIPT_DIR}"/release/*-mac-"${arch}".dmg)}"
  if [[ -z "$dmg" || ! -f "$dmg" ]]; then
    echo "No ${arch} DMG found in ./release. Build one with"
    echo "  npm run electron:build -- --mac dmg -c.mac.identity=-"
    echo "or pass the path of a downloaded DMG as an argument."
    exit 1
  fi

  local dest_dir="/Applications"
  [[ -w "$dest_dir" ]] || dest_dir="$HOME/Applications"
  local dest="${dest_dir}/${APP_NAME}.app"
  if pgrep -f "${dest}/Contents/MacOS/" >/dev/null 2>&1; then
    echo "${APP_NAME} is running from ${dest}. Quit it first, then run this script again."
    exit 1
  fi

  echo "Installing ${APP_NAME} from $(basename "$dmg")..."
  local mount
  mount="$(hdiutil attach -nobrowse -readonly -noautoopen "$dmg" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -n1)"
  if [[ -z "$mount" || ! -d "${mount}/${APP_NAME}.app" ]]; then
    [[ -n "$mount" ]] && hdiutil detach "$mount" -quiet || true
    echo "Could not find ${APP_NAME}.app inside $dmg"
    exit 1
  fi
  # Copy next to the destination first, so a failed copy never leaves the old install half-replaced.
  local staging="${dest_dir}/.${APP_NAME}.app.installing"
  mkdir -p "$dest_dir"
  rm -rf "$staging"
  if ! ditto "${mount}/${APP_NAME}.app" "$staging"; then
    rm -rf "$staging"
    hdiutil detach "$mount" -quiet || true
    echo "Copying ${APP_NAME}.app to ${dest_dir} failed."
    exit 1
  fi
  hdiutil detach "$mount" -quiet || true
  rm -rf "$dest"
  mv "$staging" "$dest"

  echo "Installed: $dest"
  local bin_dir="${SLINGER_BIN_DIR:-}"
  if [[ -z "$bin_dir" ]]; then
    for candidate in /opt/homebrew/bin /usr/local/bin; do
      if [[ -d "$candidate" && -w "$candidate" ]]; then
        bin_dir="$candidate"
        break
      fi
    done
  fi
  install_command "${bin_dir:-$HOME/.local/bin}" <<COMMAND
#!/bin/sh
# Opens ${APP_NAME} (written by install.sh).
exec open -a "${dest}" --args "\$@"
COMMAND
  echo "${APP_NAME} is also in Launchpad and Spotlight."
  # A downloaded DMG carries the quarantine flag; builds without a Developer ID certificate are
  # ad-hoc signed, so Gatekeeper asks once.
  if xattr -p com.apple.quarantine "$dest" >/dev/null 2>&1; then
    echo "First launch: right-click ${APP_NAME} in ${dest_dir} and choose Open (the build is not notarized)."
  fi
}

case "$(uname -s)" in
  Darwin) install_macos "${1:-}" ;;
  Linux) install_linux "${1:-}" ;;
  *)
    echo "install.sh supports Linux and macOS. On Windows run the NSIS installer from ./release."
    exit 1
    ;;
esac
