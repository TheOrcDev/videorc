//! A GPUI window's accessibility tree as the UI driver's [`UiNode`]s (plan
//! 260 S2.5): `Window::debug_a11y_tree_json` read as data.
//!
//! GPUI builds an AccessKit tree each frame once assistive technology (or
//! the app itself, for the smokes: `apps/videorc/src/smoke`) has activated
//! it, and keeps the last one for that dump: the root, the focus, and each
//! node keyed by a short id (`a`, `b` …) with its AccessKit id, its children
//! and its `aria` part (role, label, value, description, placeholder, the
//! toggled, expanded and selected states, the actions it supports). A debug
//! build adds the element id that created the node and the view that
//! rendered it.
//!
//! What gpui-pre 0.3.14's dump leaves out, and what the driver does about
//! it (each a reported gap, `docs/gpui/ui-driver.md`):
//!
//! - **Bounds.** GPUI gives each node its rect (`accesskit::Node::bounds`,
//!   physical pixels). Videorc's `patches/gpui-pre` prints them as AccessKit's
//!   `{x0, y0, x1, y1}`; they are read here and turned into window points.
//!   A node without a rect still has [`UiNode::bounds`] as `None`.
//! - **Disabled and clipped.** The dump has no disabled flag and no
//!   clipping, so every node reads enabled and visible (a `disabled: true`
//!   in `aria`, should it appear, is honoured).
//! - **Author ids.** `accessibility_id` is not printed; the element id
//!   (debug builds) is the id a selector matches.

use std::collections::HashSet;

use serde_json::{Map, Value};

use super::ui_tree::{UiBounds, UiNode};

/// How deep the walk goes before it gives up on a malformed tree.
const MAX_DEPTH: usize = 512;

/// `Role::TextInput` → `text-input`: AccessKit's role, as `{:?}` prints it,
/// in the kebab case the selectors use.
pub fn kebab_role(debug_name: &str) -> String {
    let mut out = String::with_capacity(debug_name.len() + 4);
    for (index, ch) in debug_name.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if index > 0 {
                out.push('-');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// Reads the dump; an error, by name, when GPUI has no frame yet
/// (accessibility was not active) or the text is not the dump's shape.
pub fn parse_gpui_tree(text: &str) -> Result<UiNode, String> {
    let dump: Value =
        serde_json::from_str(text).map_err(|error| format!("Not GPUI's tree: {error}"))?;
    let nodes = dump
        .get("nodes")
        .and_then(Value::as_object)
        .ok_or("GPUI's tree has no nodes.")?;
    let root = dump
        .get("root")
        .and_then(Value::as_str)
        .ok_or("GPUI's tree has no root yet (accessibility is not active).")?;
    let focus = dump
        .get("active_descendant_focus")
        .and_then(Value::as_str)
        .or_else(|| dump.get("gpui_focus").and_then(Value::as_str));
    let scale = dump
        .pointer("/frame/scale_factor")
        .and_then(Value::as_f64)
        .filter(|scale| scale.is_finite() && *scale > 0.0)
        .unwrap_or(1.0);
    let reader = Reader {
        nodes,
        focus,
        scale,
    };
    let mut seen = HashSet::new();
    reader
        .node(root, 0, &mut seen)
        .ok_or_else(|| format!("GPUI's tree names a root ({root}) it does not hold."))
}

struct Reader<'a> {
    nodes: &'a Map<String, Value>,
    focus: Option<&'a str>,
    scale: f64,
}

impl Reader<'_> {
    fn node(&self, key: &str, depth: usize, seen: &mut HashSet<String>) -> Option<UiNode> {
        if depth > MAX_DEPTH || !seen.insert(key.to_string()) {
            return None;
        }
        let raw = self.nodes.get(key)?;
        let aria = raw.get("aria").and_then(Value::as_object);
        let text = |name: &str| {
            aria.and_then(|aria| aria.get(name))
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        let flag = |name: &str| {
            aria.and_then(|aria| aria.get(name))
                .and_then(Value::as_bool)
        };
        let debug_role = text("role").unwrap_or_else(|| "Unknown".to_string());
        let role = kebab_role(&debug_role);
        let password = role == "password-input";
        let checked = text("toggled").and_then(|toggled| match toggled.as_str() {
            "True" => Some(true),
            "False" => Some(false),
            // `Mixed` reads as neither, as a DOM `indeterminate` does.
            _ => None,
        });
        let actions = aria
            .and_then(|aria| aria.get("on_action"))
            .and_then(Value::as_array)
            .map(|actions| {
                actions
                    .iter()
                    .filter_map(Value::as_str)
                    .map(kebab_role)
                    .collect()
            })
            .unwrap_or_default();
        let ids = raw
            .get("element_id")
            .and_then(Value::as_str)
            .map(|id| match raw.get("view").and_then(Value::as_str) {
                // The view's type name, without its module path, qualifies
                // the id (`StudioPage::record`), so `record` and the
                // qualified form both match.
                Some(view) => vec![format!(
                    "{}::{id}",
                    view.rsplit("::").next().unwrap_or(view)
                )],
                None => vec![id.to_string()],
            })
            .unwrap_or_default();
        let children = raw
            .get("children")
            .and_then(Value::as_array)
            .map(|children| {
                children
                    .iter()
                    .filter_map(Value::as_str)
                    .filter_map(|child| self.node(child, depth + 1, seen))
                    .collect()
            })
            .unwrap_or_default();
        Some(UiNode {
            role,
            label: text("label").unwrap_or_default(),
            value: text("value"),
            description: text("description"),
            placeholder: text("placeholder"),
            checked,
            expanded: flag("expanded"),
            selected: flag("selected"),
            enabled: flag("disabled") != Some(true),
            read_only: flag("read_only") == Some(true),
            focused: self.focus == Some(key),
            visible: true,
            password,
            bounds: raw.get("bounds").and_then(|bounds| self.bounds(bounds)),
            ids,
            type_name: raw
                .get("view")
                .and_then(Value::as_str)
                .map(|view| view.rsplit("::").next().unwrap_or(view).to_string()),
            actions,
            children,
            handle: raw
                .get("accesskit_id")
                .and_then(Value::as_str)
                .and_then(|id| id.parse().ok())
                .unwrap_or(0),
        })
    }

    /// AccessKit's rect, physical pixels as GPUI sets it, in window points.
    fn bounds(&self, value: &Value) -> Option<UiBounds> {
        let side = |name: &str| value.get(name).and_then(Value::as_f64);
        let (x0, y0, x1, y1) = (side("x0")?, side("y0")?, side("x1")?, side("y1")?);
        (x1 >= x0 && y1 >= y0).then(|| UiBounds {
            x: x0 / self.scale,
            y: y0 / self.scale,
            width: (x1 - x0) / self.scale,
            height: (y1 - y0) / self.scale,
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::smoke::ui_tree::UiSelector;

    /// A dump in gpui-pre 0.3.14's shape (`window/a11y/debug.rs`), with a
    /// debug build's provenance and one node that carries bounds.
    fn dump() -> String {
        json!({
            "root": "a",
            "gpui_focus": "d",
            "active_descendant_focus": null,
            "frame": {"frame_number": 3, "node_count": 5, "scale_factor": 2.0, "window_title": "Videorc"},
            "nodes": {
                "a": {"accesskit_id": "0", "children": ["b", "c"], "aria": {"role": "Window", "label": "Videorc"}},
                "b": {
                    "accesskit_id": "11", "element_id": "record", "view": "videorc::studio::StudioPage",
                    "bounds": {"x0": 20.0, "y0": 40.0, "x1": 220.0, "y1": 100.0},
                    "aria": {"role": "Button", "label": "Record", "on_action": ["Click", "Focus"]}
                },
                "c": {"accesskit_id": "12", "children": ["d", "e", "a"], "aria": {"role": "Group", "label": "Go live"}},
                "d": {"accesskit_id": "13", "aria": {"role": "TextInput", "label": "Server URL", "value": "rtmp://x", "on_action": ["Focus", "SetValue"]}},
                "e": {"accesskit_id": "14", "aria": {"role": "Switch", "label": "Keep on top", "toggled": "True", "disabled": true}}
            }
        })
        .to_string()
    }

    #[test]
    fn a_gpui_frame_reads_as_the_driver_s_tree() {
        let root = parse_gpui_tree(&dump()).unwrap();
        assert_eq!(root.role, "window");
        assert_eq!(root.label, "Videorc");
        let record = UiSelector::label("Record").find(&root).unwrap();
        assert_eq!(record.role, "button");
        assert_eq!(record.handle, 11);
        assert_eq!(record.actions, ["click", "focus"]);
        assert_eq!(record.ids, ["StudioPage::record"]);
        assert_eq!(record.type_name.as_deref(), Some("StudioPage"));
        // Physical pixels at 2x, in points.
        assert_eq!(
            record.bounds,
            Some(UiBounds {
                x: 10.0,
                y: 20.0,
                width: 100.0,
                height: 30.0
            })
        );
        let by_id = UiSelector {
            id: Some("record".into()),
            ..UiSelector::default()
        };
        assert_eq!(by_id.find(&root).map(|node| node.handle), Some(11));
        let url = UiSelector::label("Server URL").find(&root).unwrap();
        assert_eq!(url.role, "text-input");
        assert!(url.focused);
        assert_eq!(url.bounds, None);
        assert_eq!(url.actions, ["focus", "set-value"]);
        let switch = UiSelector::label("Keep on top").find(&root).unwrap();
        assert_eq!(switch.checked, Some(true));
        assert!(!switch.enabled);
        // The cycle back to the root is dropped, not walked forever.
        assert_eq!(root.children[1].children.len(), 2);
    }

    #[test]
    fn no_frame_yet_is_said_by_name() {
        let empty = json!({"root": null, "nodes": {}}).to_string();
        assert!(parse_gpui_tree(&empty).unwrap_err().contains("not active"));
        assert!(parse_gpui_tree("nope").is_err());
    }

    #[test]
    fn roles_read_in_kebab_case() {
        assert_eq!(kebab_role("Button"), "button");
        assert_eq!(kebab_role("TextInput"), "text-input");
        assert_eq!(kebab_role("CheckBox"), "check-box");
        assert_eq!(kebab_role("ListItem"), "list-item");
        assert_eq!(kebab_role("SetValue"), "set-value");
    }
}
