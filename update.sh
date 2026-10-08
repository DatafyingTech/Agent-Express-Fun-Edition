#!/usr/bin/env bash
# Updates Agent Express (Fun Edition): git pull (or the newest tarball), reinstall, rebuild and restart, keeping your settings.
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.sh" update "$@"
