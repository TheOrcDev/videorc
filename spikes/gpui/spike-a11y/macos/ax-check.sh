#!/bin/sh
# Plan 260 S0.6 on macOS without VoiceOver (the owner's call, 2026-11-24):
# build spike-a11y, open its window, read and drive it through the macOS
# Accessibility API (ax-driver.swift), then close it.
#
#   spikes/gpui/spike-a11y/macos/ax-check.sh [report.json]
#
# Needs: Accessibility access for the terminal that runs it, and the
# spike's window left uncovered while it runs (about 15 s). Stops only the
# spike it started.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
workspace=$(cd "$here/../.." && pwd)
report=${1:-"$workspace/spike-a11y-ax-report.json"}

cd "$workspace"
binary=$(cargo build --release -p spike-a11y --message-format=json-render-diagnostics \
    | sed -n 's/.*"executable":"\([^"]*spike-a11y\)".*/\1/p' | tail -n 1)
if [ -z "$binary" ] || [ ! -x "$binary" ]; then
    echo "spike-a11y did not build" >&2
    exit 1
fi

"$binary" --seconds 120 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT INT TERM

# The window opens; AccessKit fills its tree on the first query (the driver
# waits for it too).
sleep 3
swift "$here/ax-driver.swift" "$pid" "$report"
echo "report: $report"
