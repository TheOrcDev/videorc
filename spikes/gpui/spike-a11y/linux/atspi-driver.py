#!/usr/bin/env python3
"""Plan 260 S0.6 on Linux: read spike-a11y's tree over AT-SPI and drive it.

Run with DBUS_SESSION_BUS_ADDRESS pointing at the session bus the spike
uses (whose org.a11y.Bus has IsEnabled = true). Prints one JSON report:
the tree as AT-SPI sees it, then each check (find by role and name, press,
read back).
"""

import json
import sys
import time

import os
import subprocess

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

APP_HINT = sys.argv[1] if len(sys.argv) > 1 else "spike-a11y"
OUT = sys.argv[2] if len(sys.argv) > 2 else None


def role(node):
    try:
        return node.get_role_name()
    except Exception as error:  # a node that went away
        return f"<{error}>"


def name(node):
    try:
        return node.get_name() or ""
    except Exception:
        return ""


def states(node):
    try:
        st = node.get_state_set()
        return sorted(
            Atspi.StateType(s).value_nick
            for s in range(Atspi.StateType.LAST_DEFINED)
            if st.contains(Atspi.StateType(s))
        )
    except Exception:
        return []


def actions(node):
    try:
        act = node.get_action_iface()
        if act is None:
            return []
        return [act.get_action_name(i) for i in range(act.get_n_actions())]
    except Exception:
        return []


def attributes(node):
    try:
        return dict(node.get_attributes() or {})
    except Exception:
        return {}


def walk(node, depth=0, limit=12):
    entry = {
        "role": role(node),
        "name": name(node),
    }
    desc = ""
    try:
        desc = node.get_description() or ""
    except Exception:
        pass
    if desc:
        entry["description"] = desc
    st = [s for s in states(node) if s in ("focusable", "focused", "selected", "selectable", "checked", "modal", "showing", "visible", "enabled", "active", "pressed")]
    if st:
        entry["states"] = st
    acts = actions(node)
    if acts:
        entry["actions"] = acts
    attrs = attributes(node)
    if attrs:
        entry["attributes"] = attrs
    if depth < limit:
        kids = []
        try:
            count = node.get_child_count()
        except Exception:
            count = 0
        for i in range(count):
            try:
                child = node.get_child_at_index(i)
            except Exception:
                child = None
            if child is not None:
                kids.append(walk(child, depth + 1, limit))
        if kids:
            entry["children"] = kids
    return entry


def find_app():
    desktop = Atspi.get_desktop(0)
    names = []
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is None:
            continue
        names.append(name(app))
        if APP_HINT in name(app).lower() or APP_HINT in str(app.get_process_id()):
            return app, names
    return None, names


def find_all(node, want_role=None, want_name=None, out=None, depth=0):
    if out is None:
        out = []
    if node is None or depth > 30:
        return out
    if (want_role is None or role(node) == want_role) and (
        want_name is None or name(node) == want_name
    ):
        out.append(node)
    try:
        count = node.get_child_count()
    except Exception:
        count = 0
    for i in range(count):
        try:
            find_all(node.get_child_at_index(i), want_role, want_name, out, depth + 1)
        except Exception:
            pass
    return out


def shot(label):
    """A screenshot of the nested compositor, when SHOTS names a folder."""
    folder = os.environ.get("SHOTS")
    if folder:
        subprocess.run(
            ["grim", os.path.join(folder, f"a11y-{label}.png")],
            env={**os.environ, "WAYLAND_DISPLAY": os.environ.get("SHOT_DISPLAY", "wayland-2")},
            timeout=5,
            check=False,
        )


def press(node):
    act = node.get_action_iface()
    if act is None or act.get_n_actions() == 0:
        return f"no action on {role(node)} {name(node)!r}"
    names = [act.get_action_name(i) for i in range(act.get_n_actions())]
    index = names.index("click") if "click" in names else 0
    ok = act.do_action(index)
    return f"{names[index]} -> {ok}"


def main():
    Atspi.init()
    report = {"checks": []}
    deadline = time.time() + 20
    app = None
    names = []
    while time.time() < deadline:
        app, names = find_app()
        if app is not None and app.get_child_count() > 0:
            break
        time.sleep(0.5)
    report["apps_on_bus"] = names
    if app is None:
        report["error"] = "spike-a11y is not on the accessibility bus"
        print(json.dumps(report, ensure_ascii=False, indent=1))
        return 1
    # AccessKit fills the tree a frame after the first query.
    for _ in range(20):
        if len(find_all(app, "button")) > 0:
            break
        time.sleep(0.25)
    report["app"] = {"name": name(app), "pid": app.get_process_id(), "toolkit": app.get_toolkit_name() if hasattr(app, "get_toolkit_name") else None}
    report["tree"] = walk(app)
    report["node_count"] = len(find_all(app))

    def check(label, ok, detail):
        report["checks"].append({"check": label, "ok": bool(ok), "detail": detail})

    record = find_all(app, "button", "Record")
    check("find button 'Record' by role and name", record, f"{len(record)} found")
    if record:
        check("press Record", True, press(record[0]))
        time.sleep(0.8)
        shot("1-recording")
        stop = find_all(app, "button", "Stop recording")
        status = [name(n) for n in find_all(app) if name(n) in ("Recording", "Ready")]
        check("Record became 'Stop recording'", stop, f"buttons named Stop recording: {len(stop)}; status labels: {status}")
        if stop:
            press(stop[0])
            time.sleep(0.5)

    lists = find_all(app, "list", "Scenes")
    items = find_all(lists[0], "list item") if lists else []
    check(
        "list 'Scenes' with its items",
        lists and len(items) == 6,
        {"lists": len(lists), "items": [{"name": name(i), "states": states(i), "attributes": attributes(i), "actions": actions(i)} for i in items]},
    )
    if items:
        check("press the second list item", True, press(items[1]))
        time.sleep(0.5)
        sel = [name(i) for i in find_all(lists[0], "list item") if "selected" in states(i)]
        check("the second item is selected", sel == [name(items[1])], f"selected: {sel}")

    delete = find_all(app, "button", "Delete scene…")
    check("find 'Delete scene…'", delete, f"{len(delete)} found")
    if delete:
        press(delete[0])
        time.sleep(0.8)
        shot("2-dialog-open")
        dialogs = [n for n in find_all(app) if role(n) in ("alert", "dialog", "alert dialog")]
        detail = [walk(d, 0, 4) for d in dialogs]
        check("the dialog is in the tree", dialogs, detail)
        still = find_all(app, "button", "Delete scene…")
        check("the background is hidden while the dialog is open", not still, f"'Delete scene…' still reachable: {len(still)}")
        cancel = []
        for d in dialogs:
            cancel += find_all(d, "button", "Cancel")
        if not cancel:
            cancel = find_all(app, "button", "Cancel")
        check("press Cancel in the dialog", cancel, press(cancel[0]) if cancel else "no Cancel")
        time.sleep(0.8)
        shot("3-dialog-closed")
        gone = [n for n in find_all(app) if role(n) in ("alert", "dialog", "alert dialog")]
        check("the dialog left the tree", not gone, f"dialogs left: {len(gone)}")
        focused = [f"{role(n)} {name(n)!r}" for n in find_all(app) if "focused" in states(n)]
        check("focus returned to the control that opened the dialog", any("Delete scene" in f for f in focused), f"focused: {focused}")

    text = json.dumps(report, ensure_ascii=False, indent=1)
    if OUT:
        with open(OUT, "w") as f:
            f.write(text)
    print(json.dumps({"apps_on_bus": names, "node_count": report["node_count"], "checks": [(c["check"], c["ok"]) for c in report["checks"]]}, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
