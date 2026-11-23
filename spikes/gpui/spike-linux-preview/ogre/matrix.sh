#!/bin/bash
# Plan 260 S0.3 matrix: 1920x1080 frames, warm-up 3 s, live 60 s, still 20 s, resize 5 s.
cd "$(dirname "$0")"
temp() { sensors 2>/dev/null | awk '/Package id 0/ {print $4}'; }
mhz() { awk '/cpu MHz/ {s+=$4; n++} END {printf "%.0f", s/n}' /proc/cpuinfo; }
FULL=(--seconds 60 --still 20 --resize 5)
CAD=(--seconds 30 --still 5 --presentation)
run() { echo "== $1 $(date +%T) pkg=$(temp) mhz=$(mhz)"; ./run.sh "$@"; echo "   after pkg=$(temp) mhz=$(mhz)"; sleep 20; }
run wl-native-30 wayland --fps 30 "${FULL[@]}"
run wl-native-60 wayland --fps 60 "${FULL[@]}"
run wl-native-30-pres wayland --fps 30 "${CAD[@]}"
run wl-native-60-pres wayland --fps 60 "${CAD[@]}"
run wl-native-30-nooverlay wayland --fps 30 "${FULL[@]}" --no-overlay
run wl-image-30 wayland --fps 30 --route image "${FULL[@]}"
run wl-image-60 wayland --fps 60 --route image "${FULL[@]}"
run x11-native-30 x11 --fps 30 "${FULL[@]}"
run x11-native-60 x11 --fps 60 "${FULL[@]}"
run x11-image-30 x11 --fps 30 --route image "${FULL[@]}"
run x11-image-60 x11 --fps 60 --route image "${FULL[@]}"
echo "MATRIX DONE $(date +%T)"
