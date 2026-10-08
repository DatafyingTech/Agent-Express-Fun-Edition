#!/usr/bin/env bash
# Starts Hearth in the background if it isn't running, then opens it in your browser.
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.sh" start --open "$@"
