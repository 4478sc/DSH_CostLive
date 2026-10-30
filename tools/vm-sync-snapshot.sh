#!/bin/bash
# Build an incremental tar of the VM's DSH session logs + projection cache.
# Usage: dsh-vm-snapshot.sh <last-ref-epoch> [dsh-home]
# Prints START=<epoch> and SIZE=<bytes>; the host stores START only after a
# successful pull, so a failed transfer simply re-sends the same files.
set -u
REF="${1:-0}"
HOME_DIR="${2:-$HOME/.dsh}"
OUT=/tmp/dsh-inc.tgz
START=$(date +%s)
cd "$HOME_DIR" || exit 2
if [ "$REF" -le 0 ]; then
  find sessions storages/session_projcache -type f -print0 2>/dev/null | tar --null -T - -czf "$OUT" || true
else
  SINCE=$((REF - 5))
  find sessions storages/session_projcache -type f -newermt "@$SINCE" -print0 2>/dev/null | tar --null -T - -czf "$OUT" || true
fi
if [ ! -f "$OUT" ]; then
  echo "ERROR=no archive" >&2
  exit 1
fi
echo "START=$START"
echo "SIZE=$(stat -c %s "$OUT")"