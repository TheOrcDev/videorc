#!/bin/bash
# Types into the NESTED Xwayland (:1) only, never the owner's :0.
set -u
B=$HOME/linux-beta/plan260-s0-5
NP=$(cat $B/nested/nested.pid)
XW=$(pgrep -P "$NP" -x Xwayland | head -1)
owner=$(ss -xlp | grep "/tmp/.X11-unix/X1 " | grep -o "Xwayland\",pid=[0-9]*" | head -1 | cut -d= -f2)
if [ -z "$XW" ] || [ "$owner" != "$XW" ]; then echo "REFUSING: :1 is not my nested Xwayland ($owner vs $XW)"; exit 2; fi
export DBUS_SESSION_BUS_ADDRESS=$(cat $B/fcitx5.bus)
k() { DISPLAY=:1 xdotool "$@"; sleep 0.6; }
shot() { WAYLAND_DISPLAY=wayland-2 timeout 5 grim $B/shots/$1-$2.png; }
k key shift; fcitx5-remote -s mozc; sleep 0.5; echo "im: $(fcitx5-remote -n) state $(fcitx5-remote)"
k type --delay 80 nihon; shot $1 ja-1-marked-kana
k key space; k key space; sleep 1.5; shot $1 ja-2-candidates
k key Return; shot $1 ja-3-committed
fcitx5-remote -s pinyin; sleep 0.5; echo "im: $(fcitx5-remote -n) state $(fcitx5-remote)"
k type --delay 80 zhongwen; sleep 1.5; shot $1 zh-1-marked-pinyin
k key space; shot $1 zh-2-committed
fcitx5-remote -s keyboard-us; sleep 0.3; echo "im: $(fcitx5-remote -n)"
k type " ok"; shot $1 end
