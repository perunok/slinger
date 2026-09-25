#!/usr/bin/env bash
# Runs a command inside a private D-Bus session with an unlocked, empty gnome-keyring, so the
# OS keychain (Secret Service) works headless: CI e2e runs, containers, SSH sessions.
#
#   scripts/with-keyring.sh <command> [args...]
#
# Needs: dbus-run-session (package dbus-daemon) and gnome-keyring. The keyring lives in
# $XDG_DATA_HOME/keyrings; point XDG_DATA_HOME at a temp dir to keep your real keyring untouched.
set -euo pipefail
if [ "$#" -eq 0 ]; then
  echo "usage: with-keyring.sh <command> [args...]" >&2
  exit 2
fi
exec dbus-run-session -- bash -c '
  set -euo pipefail
  # --unlock reads the password from stdin and creates the login keyring on first use.
  # The password protects nothing here: the keyring is throwaway.
  eval "$(printf "%s" "slinger-ci" | gnome-keyring-daemon --unlock --components=secrets)"
  export GNOME_KEYRING_CONTROL
  exec "$@"
' with-keyring "$@"
