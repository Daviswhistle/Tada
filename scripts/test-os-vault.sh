#!/usr/bin/env bash
# Isolated hosted-runner fixture only. No provider credential is used.
set -euo pipefail
umask 077
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
export XDG_DATA_HOME="$fixture/data"
export XDG_RUNTIME_DIR="$fixture/runtime"
mkdir -m 700 -- "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR"
dbus-run-session -- bash -euo pipefail -c '
  gnome-keyring-daemon --components=secrets --daemonize --unlock <<< "tada-isolated-ci-fixture" > /dev/null
  cargo test --locked -p tada-credential --features os-vault-tests os_tests:: -- --nocapture --test-threads=1
'
