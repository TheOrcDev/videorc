#!/usr/bin/env python3
"""Plan 260 S0.7 on Linux: stand-ins for the desktop's session services on a
private session bus, so the spike's notification and sleep guard can be
checked without reaching the owner's desktop.

- org.freedesktop.Notifications (what notify-rust, and so GPUI, calls)
- org.freedesktop.ScreenSaver at /org/freedesktop/ScreenSaver and
  /ScreenSaver (Inhibit / UnInhibit, what Chromium calls for Electron's
  powerSaveBlocker, and what hypridle implements)

Every call is appended to the log file (JSON lines). Run it with
DBUS_SESSION_BUS_ADDRESS set to the private bus.
"""

import json
import sys
import time

from gi.repository import Gio, GLib

LOG = sys.argv[1] if len(sys.argv) > 1 else "fake-session-services.jsonl"

NOTIFICATIONS_XML = """
<node>
  <interface name="org.freedesktop.Notifications">
    <method name="GetCapabilities"><arg type="as" direction="out"/></method>
    <method name="Notify">
      <arg type="s" direction="in"/><arg type="u" direction="in"/>
      <arg type="s" direction="in"/><arg type="s" direction="in"/>
      <arg type="s" direction="in"/><arg type="as" direction="in"/>
      <arg type="a{sv}" direction="in"/><arg type="i" direction="in"/>
      <arg type="u" direction="out"/>
    </method>
    <method name="CloseNotification"><arg type="u" direction="in"/></method>
    <method name="GetServerInformation">
      <arg type="s" direction="out"/><arg type="s" direction="out"/>
      <arg type="s" direction="out"/><arg type="s" direction="out"/>
    </method>
    <signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
    <signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
  </interface>
</node>
"""

SCREENSAVER_XML = """
<node>
  <interface name="org.freedesktop.ScreenSaver">
    <method name="Inhibit">
      <arg type="s" direction="in"/><arg type="s" direction="in"/>
      <arg type="u" direction="out"/>
    </method>
    <method name="UnInhibit"><arg type="u" direction="in"/></method>
  </interface>
</node>
"""

state = {"next_id": 1, "inhibitors": {}}


def log(entry):
    entry["t"] = round(time.time(), 3)
    with open(LOG, "a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def on_notifications(conn, sender, path, iface, method, params, invocation):
    args = params.unpack()
    if method == "GetCapabilities":
        invocation.return_value(GLib.Variant("(as)", (["body", "actions"],)))
    elif method == "GetServerInformation":
        invocation.return_value(GLib.Variant("(ssss)", ("fake", "plan260", "1", "1.2")))
    elif method == "Notify":
        nid = state["next_id"]
        state["next_id"] += 1
        app, _replaces, icon, summary, body, actions, hints, timeout = args
        log({"call": "Notify", "id": nid, "app": app, "summary": summary, "body": body,
             "actions": actions, "icon": icon, "timeout": timeout, "hints": sorted(hints.keys())})
        invocation.return_value(GLib.Variant("(u)", (nid,)))
    elif method == "CloseNotification":
        log({"call": "CloseNotification", "id": args[0]})
        invocation.return_value(None)


def on_screensaver(conn, sender, path, iface, method, params, invocation):
    args = params.unpack()
    if method == "Inhibit":
        cookie = state["next_id"]
        state["next_id"] += 1
        state["inhibitors"][cookie] = args
        log({"call": "Inhibit", "path": path, "app": args[0], "reason": args[1],
             "cookie": cookie, "held": len(state["inhibitors"])})
        invocation.return_value(GLib.Variant("(u)", (cookie,)))
    elif method == "UnInhibit":
        state["inhibitors"].pop(args[0], None)
        log({"call": "UnInhibit", "path": path, "cookie": args[0],
             "held": len(state["inhibitors"])})
        invocation.return_value(None)


def main():
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    notif = Gio.DBusNodeInfo.new_for_xml(NOTIFICATIONS_XML).interfaces[0]
    saver = Gio.DBusNodeInfo.new_for_xml(SCREENSAVER_XML).interfaces[0]
    bus.register_object("/org/freedesktop/Notifications", notif, on_notifications, None, None)
    for path in ("/org/freedesktop/ScreenSaver", "/ScreenSaver"):
        bus.register_object(path, saver, on_screensaver, None, None)
    for name in ("org.freedesktop.Notifications", "org.freedesktop.ScreenSaver"):
        Gio.bus_own_name_on_connection(bus, name, Gio.BusNameOwnerFlags.NONE, None, None)
    log({"call": "ready", "bus": bus.get_unique_name()})
    GLib.MainLoop().run()


if __name__ == "__main__":
    main()
