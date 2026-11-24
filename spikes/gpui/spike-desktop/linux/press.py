#!/usr/bin/env python3
"""Plan 260 S0.7 on Linux: press spike-desktop's check buttons through
AT-SPI, by role and name, in order.

    press.py <app-name-hint> "<button name>[@<seconds to wait after>]" ...

Run with DBUS_SESSION_BUS_ADDRESS pointing at the session bus the spike
uses (with org.a11y.Bus IsEnabled = true). Prints one JSON line per press.
"""

import json
import sys
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402


def find(node, role, name, depth=0):
    if node is None or depth > 30:
        return None
    try:
        if node.get_role_name() == role and (node.get_name() or "") == name:
            return node
        count = node.get_child_count()
    except Exception:
        return None
    for i in range(count):
        try:
            hit = find(node.get_child_at_index(i), role, name, depth + 1)
        except Exception:
            hit = None
        if hit is not None:
            return hit
    return None


def app_named(hint, wait=20.0):
    deadline = time.time() + wait
    while time.time() < deadline:
        desktop = Atspi.get_desktop(0)
        for i in range(desktop.get_child_count()):
            app = desktop.get_child_at_index(i)
            if app is not None and hint in (app.get_name() or "") and app.get_child_count() > 0:
                return app
        time.sleep(0.5)
    return None


def main():
    Atspi.init()
    hint = sys.argv[1]
    app = app_named(hint)
    if app is None:
        print(json.dumps({"error": f"{hint} not on the accessibility bus"}))
        return 1
    for spec in sys.argv[2:]:
        name, _, after = spec.partition("@")
        node = None
        for _ in range(20):
            node = find(app, "button", name)
            if node is not None:
                break
            time.sleep(0.25)
        if node is None:
            print(json.dumps({"press": name, "found": False}, ensure_ascii=False))
            continue
        action = node.get_action_iface()
        ok = action.do_action(0) if action is not None and action.get_n_actions() else False
        print(json.dumps({"press": name, "found": True, "ok": bool(ok), "t": round(time.time(), 3)}, ensure_ascii=False))
        sys.stdout.flush()
        time.sleep(float(after) if after else 1.0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
