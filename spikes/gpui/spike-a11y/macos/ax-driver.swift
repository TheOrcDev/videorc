// Plan 260 S0.6 on macOS without VoiceOver: read spike-a11y's window through
// the macOS Accessibility API (AXUIElement, the API VoiceOver reads) and
// drive it, as `linux/atspi-driver.py` does over AT-SPI.
//
//   swift ax-driver.swift <pid> [report.json]
//
// The process running it needs Accessibility access (System Settings →
// Privacy & Security → Accessibility). The spike's window must stay visible:
// GPUI doesn't draw a covered window, so its tree doesn't update either.
//
// Prints a short verdict list and writes the full report: the tree, what
// VoiceOver would say for each node (its name and role description, a list's
// item count and each item's place), and every check.

import AppKit
import ApplicationServices
import Foundation

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

let arguments = CommandLine.arguments
guard arguments.count >= 2, let pid = pid_t(arguments[1]) else {
    fail("usage: swift ax-driver.swift <pid> [report.json]", 2)
}
let reportPath: String? = arguments.count > 2 ? arguments[2] : nil

guard AXIsProcessTrusted() else {
    fail(
        "This process has no Accessibility access: allow it in System Settings → "
            + "Privacy & Security → Accessibility, then run again.",
        3)
}

let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 2.0)

// ── Reading the tree ────────────────────────────────────────────────────

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &raw) == .success else {
        return nil
    }
    return raw
}

func text(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = attribute(element, name) as? String, !value.isEmpty else { return nil }
    return value
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func role(_ element: AXUIElement) -> String { text(element, kAXRoleAttribute) ?? "?" }

/// The name VoiceOver reads: the title, else the description (AccessKit puts
/// `aria_label` in one of them).
func name(_ element: AXUIElement) -> String {
    text(element, kAXTitleAttribute) ?? text(element, kAXDescriptionAttribute) ?? ""
}

func actions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success,
        let list = names as? [String]
    else { return [] }
    return list
}

func press(_ element: AXUIElement) -> String {
    let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
    return result == .success ? "pressed" : "press failed (\(result.rawValue))"
}

func findAll(
    _ element: AXUIElement, depth: Int = 0, _ matches: (AXUIElement) -> Bool
) -> [AXUIElement] {
    var found: [AXUIElement] = []
    if matches(element) { found.append(element) }
    if depth < 30 {
        for child in children(element) {
            found += findAll(child, depth: depth + 1, matches)
        }
    }
    return found
}

func find(_ wantRole: String, _ wantName: String) -> [AXUIElement] {
    findAll(app) { role($0) == wantRole && name($0) == wantName }
}

struct Node: Encodable {
    var role: String
    var subrole: String?
    var name: String
    var roleDescription: String?
    var value: String?
    var help: String?
    var selected: Bool?
    var actions: [String]
    var children: [Node]
}

func walk(_ element: AXUIElement, depth: Int = 0) -> Node {
    let value = attribute(element, kAXValueAttribute).map { "\($0)" }
    return Node(
        role: role(element),
        subrole: text(element, kAXSubroleAttribute),
        name: name(element),
        roleDescription: text(element, kAXRoleDescriptionAttribute),
        value: value,
        help: text(element, kAXHelpAttribute),
        selected: attribute(element, kAXSelectedAttribute) as? Bool,
        actions: actions(element),
        children: depth < 14 ? children(element).map { walk($0, depth: depth + 1) } : [])
}

/// What VoiceOver would say, node by node: "Scenes, list, 6 items",
/// "Interview, 4 of 6", "Record, button".
func spoken(_ element: AXUIElement, inList: (Int, Int)? = nil, into lines: inout [String]) {
    let label = name(element)
    let kind = text(element, kAXRoleDescriptionAttribute) ?? role(element)
    let kids = children(element)
    if role(element) == kAXListRole {
        lines.append("\(label), \(kind), \(kids.count) items")
    } else if let place = inList, !label.isEmpty {
        lines.append("\(label), \(place.0) of \(place.1)")
    } else if role(element) == kAXStaticTextRole,
        let value = attribute(element, kAXValueAttribute) as? String, !value.isEmpty
    {
        lines.append(value)
    } else if !label.isEmpty {
        lines.append("\(label), \(kind)")
    }
    let isList = role(element) == kAXListRole
    for (index, child) in kids.enumerated() {
        spoken(child, inList: isList ? (index + 1, kids.count) : nil, into: &lines)
    }
}

// ── The checks ──────────────────────────────────────────────────────────

struct Check: Encodable {
    var check: String
    var ok: Bool
    var detail: String
}

struct Report: Encodable {
    var pid: Int32
    var nodeCount: Int
    var tree: Node?
    var spoken: [String]
    var checks: [Check]
}

var checks: [Check] = []
func check(_ label: String, _ ok: Bool, _ detail: String) {
    checks.append(Check(check: label, ok: ok, detail: detail))
}

func pause(_ seconds: Double) { Thread.sleep(forTimeInterval: seconds) }

// Keep the window in front: GPUI doesn't draw (or update the tree of) a
// covered window.
NSRunningApplication(processIdentifier: pid)?.activate(options: [])

// AccessKit activates lazily: the first query sees only the frame, the full
// tree follows a frame later.
var ready = false
for _ in 0..<80 {
    if !findAll(app, { role($0) == kAXButtonRole && !name($0).isEmpty }).isEmpty {
        ready = true
        break
    }
    pause(0.25)
}
check("the tree reaches the platform", ready, ready ? "named buttons found" : "no named button in 20 s")

let record = find(kAXButtonRole, "Record")
check("find button 'Record' by role and name", !record.isEmpty, "\(record.count) found")
if let button = record.first {
    check("press Record", true, press(button))
    pause(0.8)
    let stop = find(kAXButtonRole, "Stop recording")
    let status = findAll(app) { ["Recording", "Ready"].contains(name($0)) }.map(name)
    check(
        "Record became 'Stop recording'", !stop.isEmpty,
        "buttons named Stop recording: \(stop.count); status: \(status)")
    if let stopButton = stop.first {
        _ = press(stopButton)
        pause(0.5)
    }
}

let lists = find(kAXListRole, "Scenes")
let items = lists.first.map(children) ?? []
check(
    "list 'Scenes' with six named items", lists.count == 1 && items.count == 6,
    "lists: \(lists.count); items: \(items.map(name))")
if items.count > 1 {
    check("press the second list item", true, press(items[1]))
    pause(0.5)
    let selected = (lists.first.map(children) ?? []).filter {
        (attribute($0, kAXSelectedAttribute) as? Bool) == true
    }.map(name)
    check("the second item is selected", selected == [name(items[1])], "selected: \(selected)")
}

func dialogs() -> [AXUIElement] {
    // The dialog comes through as a window inside the app's window (an
    // `AXWindow` "Delete …?"), or with a dialog subrole.
    findAll(app) { element in
        let label = name(element)
        let subrole = text(element, kAXSubroleAttribute) ?? ""
        return (role(element) == kAXWindowRole && label.hasPrefix("Delete ") && label.hasSuffix("?"))
            || subrole == kAXDialogSubrole || subrole == kAXSystemDialogSubrole
    }
}

let delete = find(kAXButtonRole, "Delete scene…")
check("find 'Delete scene…'", !delete.isEmpty, "\(delete.count) found")
if let opener = delete.first {
    _ = press(opener)
    pause(0.8)
    let open = dialogs()
    let described = open.map { "\(name($0)) — help: \(text($0, kAXHelpAttribute) ?? "none")" }
    check("the dialog is in the tree", !open.isEmpty, "\(described)")
    if let dialog = open.first {
        let buttons = findAll(dialog) { role($0) == kAXButtonRole }.map(name)
        check(
            "the dialog has its title, description and both buttons",
            buttons.contains("Cancel") && buttons.contains("Delete")
                && text(dialog, kAXHelpAttribute) != nil,
            "buttons: \(buttons)")
    }
    let still = find(kAXButtonRole, "Delete scene…")
    check(
        "the background is hidden while the dialog is open", still.isEmpty,
        "'Delete scene…' still reachable: \(still.count)")
    let cancel = open.flatMap { dialog in
        findAll(dialog) { role($0) == kAXButtonRole && name($0) == "Cancel" }
    }
    check("press Cancel in the dialog", !cancel.isEmpty, cancel.first.map(press) ?? "no Cancel")
    pause(0.8)
    check("the dialog left the tree", dialogs().isEmpty, "dialogs left: \(dialogs().count)")
    let focused = (attribute(app, kAXFocusedUIElementAttribute)).map { value -> String in
        let element = value as! AXUIElement
        return "\(role(element)) '\(name(element))'"
    }
    check(
        "focus returned to the control that opened the dialog",
        focused?.contains("Delete scene") == true, "focused: \(focused ?? "nothing")")
}

var lines: [String] = []
spoken(app, into: &lines)
let report = Report(
    pid: pid,
    nodeCount: findAll(app) { _ in true }.count,
    tree: walk(app),
    spoken: lines,
    checks: checks)

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
let data = try! encoder.encode(report)
if let path = reportPath {
    FileManager.default.createFile(atPath: path, contents: data)
}
print("nodes: \(report.nodeCount)")
print("VoiceOver would say:")
for line in lines { print("  \(line)") }
for entry in checks { print("\(entry.ok ? "PASS" : "FAIL")  \(entry.check): \(entry.detail)") }
