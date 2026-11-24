#!/bin/bash
# A private session bus with its own AT-SPI bus, so turning accessibility on
# touches no other app in the owner's session.
B=$HOME/linux-beta/plan260-s0-6
echo "$DBUS_SESSION_BUS_ADDRESS" > $B/session.bus
exec env -u WAYLAND_DISPLAY -u DISPLAY /usr/lib/at-spi-bus-launcher --launch-immediately
