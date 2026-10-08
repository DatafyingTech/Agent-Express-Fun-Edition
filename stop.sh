#!/usr/bin/env bash
# Stops Hearth and the agents it started. ./start.sh (or logging in again, with autostart on) brings it back.
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.sh" stop "$@"
