#!/bin/bash
# A private fcitx5 for the nested compositor: its own D-Bus session and a copy
# of the config, connected only to the nested Wayland display and its Xwayland.
B=$HOME/linux-beta/plan260-s0-5
echo "$DBUS_SESSION_BUS_ADDRESS" > $B/fcitx5.bus
exec env -u WAYLAND_SOCKET XDG_CONFIG_HOME=$B/xdg-config WAYLAND_DISPLAY="$1" DISPLAY="$2" fcitx5 --disable notificationitem,clipboard
