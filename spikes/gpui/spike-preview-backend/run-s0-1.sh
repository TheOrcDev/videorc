#!/bin/zsh
# Plan 260 S0.1: one measured run of the GPUI preview spike against the real backend.
# Usage: run-s0-1.sh <out-dir> [spike args...]
# Takes ~/videorc-app-run.lock, refuses while the owner is on air, samples
# only its own PIDs (the spike and the backend it spawned), never kills others.
set -u
OUT=${1:?out dir}; shift
mkdir -p "$OUT"
SPIKE=${SPIKE:-$HOME/projects/.targets/260-l1/release/spike-preview-backend}
BACKEND=${BACKEND:-$HOME/projects/.targets/260-l1/release/videorc-backend}
WORKSPACE=${WORKSPACE:-$HOME/projects/videorc-wt-260-l1}
PROFILE=$(mktemp -d /tmp/videorc-s0-1-profile.XXXXXX)

if [[ -e "$HOME/Library/Application Support/Videorc/on-air.json" ]]; then
  echo "on-air.json exists: the owner is live; not running" >&2; exit 3
fi
if ! mkdir "$HOME/videorc-app-run.lock" 2>/dev/null; then
  echo "~/videorc-app-run.lock is held; not running" >&2; exit 4
fi
echo "$$ plan-260-s0.1 $(date)" > "$HOME/videorc-app-run.lock/owner"
trap 'rm -rf "$HOME/videorc-app-run.lock"' EXIT

{
  echo "start $(date '+%F %T %Z')"
  uptime
  echo "--- top CPU processes before the run"
  ps -Ao pcpu,rss,comm -r | head -15
  echo "--- free disk"; df -h / | tail -1
  echo "--- displays"; system_profiler SPDisplaysDataType 2>/dev/null | grep -E "Resolution|Refresh|Main Display" | head -6
} > "$OUT/host-before.txt"

"$SPIKE" --backend "$BACKEND" --workspace "$WORKSPACE" --profile "$PROFILE" \
  --report "$OUT/report.json" --shots "$OUT" --keep-on-top "$@" > "$OUT/run.log" 2>&1 &
SPIKE_PID=$!
echo "spike pid $SPIKE_PID" | tee "$OUT/pids.txt"

BACKEND_PID=""
echo "t,spike_pcpu,spike_rss_kb,backend_pcpu,backend_rss_kb,load1" > "$OUT/ps.csv"
T0=$(date +%s)
while kill -0 $SPIKE_PID 2>/dev/null; do
  if [[ -z "$BACKEND_PID" ]]; then
    BACKEND_PID=$(pgrep -P $SPIKE_PID videorc-backend | head -1)
    [[ -n "$BACKEND_PID" ]] && echo "backend pid $BACKEND_PID" | tee -a "$OUT/pids.txt"
  fi
  S=$(ps -o pcpu=,rss= -p $SPIKE_PID 2>/dev/null | awk '{print $1","$2}')
  B=","
  [[ -n "$BACKEND_PID" ]] && B=$(ps -o pcpu=,rss= -p $BACKEND_PID 2>/dev/null | awk '{print $1","$2}')
  L=$(sysctl -n vm.loadavg | awk '{print $2}')
  echo "$(( $(date +%s) - T0 )),${S:-,},${B:-,},$L" >> "$OUT/ps.csv"
  sleep 2
done
wait $SPIKE_PID; echo "spike exit $?" >> "$OUT/pids.txt"
if [[ -n "$BACKEND_PID" ]] && kill -0 $BACKEND_PID 2>/dev/null; then
  echo "backend $BACKEND_PID still alive after the spike; stopping our own PID" | tee -a "$OUT/pids.txt"
  kill $BACKEND_PID
fi
{ echo "end $(date '+%F %T %Z')"; uptime; ps -Ao pcpu,rss,comm -r | head -15; } > "$OUT/host-after.txt"
rm -rf "$PROFILE"
echo "done: $OUT"
