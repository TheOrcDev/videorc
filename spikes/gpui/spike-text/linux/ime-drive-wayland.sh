#!/bin/bash
# Types into the NESTED compositor only (never the owner's locked session).
# ime-drive.sh <label>   (the spike must already be running with --ime-wait)
set -u
B=$HOME/linux-beta/plan260-s0-5
NP=$(cat $B/nested/nested.pid)
WL=wayland-2
owner=$(ss -xlp | grep "/run/user/1000/$WL " | grep -o "pid=[0-9]*" | head -1 | cut -d= -f2)
if [ "$owner" != "$NP" ] || [ "$(cat /proc/$NP/comm)" != "Hyprland" ]; then
  echo "REFUSING: $WL is not my nested Hyprland ($owner vs $NP)"; exit 2
fi
export DBUS_SESSION_BUS_ADDRESS=$(cat $B/fcitx5.bus)
k() { WAYLAND_DISPLAY=$WL wtype "$@"; sleep 0.6; }
shot() { WAYLAND_DISPLAY=$WL timeout 5 grim $B/shots/$1-$2.png; }
fcitx5-remote -s mozc; sleep 0.5; echo "im: $(fcitx5-remote -n)"
k -d 60 nihon; shot $1 ja-1-marked-kana
k -k space; sleep 0.4; shot $1 ja-2-converted-candidates
k -k Return; shot $1 ja-3-committed
fcitx5-remote -s pinyin; sleep 0.5; echo "im: $(fcitx5-remote -n)"
k -d 60 zhongwen; shot $1 zh-1-marked-pinyin
k -k space; shot $1 zh-2-committed
fcitx5-remote -s keyboard-us; sleep 0.3; echo "im: $(fcitx5-remote -n)"
k " ok"; shot $1 end
