#!/usr/bin/env bash
# Snapshot entrypoint. Daytona runs it on every sandbox start, so the daemon comes
# back after stop/start with no exec call. The loop restarts a crashed daemon
# without involving the control plane. It never exits (Daytona expects a
# long-running entrypoint).
set -u
mkdir -p "${WORKSPACE_DIR:-/workspace}"
cd /opt/runner || exit 1
while :; do
  node --enable-source-maps dist/daemon.mjs
  code=$?
  if [ "${code}" -eq 3 ]; then
    # Token revoked (sandbox being deleted) or protocol mismatch: back off hard.
    echo "[entrypoint] daemon refused by control plane; retrying in 60s" >&2
    sleep 60
  else
    echo "[entrypoint] daemon exited with ${code}; restarting in 1s" >&2
    sleep 1
  fi
done
