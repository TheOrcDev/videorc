#!/bin/bash
# Plan 260 S0.3: one spike run inside the nested Hyprland.
#   run.sh <label> wayland|x11 [spike args...]
# Screenshots of the nested output at +8 s and +20 s into the live phase.
set -u
BASE=${S03_BASE:-$HOME/linux-beta/plan260-s0-3}
LABEL=$1; SESSION=$2; shift 2
NPID=$(cat $BASE/nested/nested.pid)
WL=$(cat $BASE/nested/wayland-display)
XD=$(cat $BASE/nested/x-display)
BIN=${S03_BIN:-$BASE/spike/target/release/spike-linux-preview-gpui}
PIDS=(--compositor-pid "$NPID")
XWPID=$(pgrep -P "$NPID" -x Xwayland | head -1)
[ -n "$XWPID" ] && PIDS+=(--compositor-pid "$XWPID")
if [ "$SESSION" = wayland ]; then
  ENV=(env -u DISPLAY WAYLAND_DISPLAY=$WL)
else
  ENV=(env -u WAYLAND_DISPLAY DISPLAY=$XD)
fi
"${ENV[@]}" "$BIN" --label "$LABEL" --out $BASE/runs/$LABEL.json "${PIDS[@]}" "$@" \
  > $BASE/runs/$LABEL.log 2>&1 &
APP=$!
# warm-up is 3 s; shoot 8 s and 20 s into live.
( sleep 11; WAYLAND_DISPLAY=$WL timeout 5 grim $BASE/shots/$LABEL-live-a.png
  sleep 12; WAYLAND_DISPLAY=$WL timeout 5 grim $BASE/shots/$LABEL-live-b.png ) &
SHOOT=$!
# Busiest core's clock every 2 s while the app runs (ogre's PROCHOT pins it at 800 MHz).
( while kill -0 $APP 2>/dev/null; do sort -n /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq | tail -1; sleep 2; done ) > $BASE/runs/$LABEL.clocks &
CLK=$!
wait $APP; echo "app exit=$?"
wait $CLK 2>/dev/null
echo "clock MHz p50 $(sort -n $BASE/runs/$LABEL.clocks | awk '{a[NR]=$1} END {print int(a[int((NR+1)/2)]/1000)}') min $(sort -n $BASE/runs/$LABEL.clocks | head -1 | awk '{print int($1/1000)}') max $(sort -n $BASE/runs/$LABEL.clocks | tail -1 | awk '{print int($1/1000)}')"
kill $SHOOT 2>/dev/null; wait $SHOOT 2>/dev/null
grep -E "^\[|panick|error" $BASE/runs/$LABEL.log | head -20
