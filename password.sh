#!/usr/bin/env bash
# Sets a new sign-in password for Agent Express (Fun Edition) (press Enter at the prompt for a generated one), and restarts it.
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.sh" password "$@"
