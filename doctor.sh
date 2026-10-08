#!/usr/bin/env bash
# Checks everything Hearth needs and prints a fix for each problem. ./doctor.sh --force also applies the fixes it can.
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.sh" doctor "$@"
