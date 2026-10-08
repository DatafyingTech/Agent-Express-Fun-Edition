#!/usr/bin/env bash
# Stops Hearth and removes its login service and Tailscale share. Your workspace and this folder are kept.
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.sh" uninstall "$@"
