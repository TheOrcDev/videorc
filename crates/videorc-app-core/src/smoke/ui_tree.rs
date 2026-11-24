//! The UI driver's window model (plan 260 S2.5, from plan 220 S3.0b): a
//! window's accessibility tree as plain data, the selectors the smokes find
//! elements with, and the JSON the `ui-*` commands answer with.
//!
//! The GPUI app reads a window's tree from GPUI's AccessKit frame
//! ([`super::gpui_tree`] turns `Window::debug_a11y_tree_json` into a
//! [`UiNode`] tree: what VoiceOver, Narrator and Orca read), and keeps each
//! node's AccessKit id beside it ([`UiNode::handle`]) for the actions.
//! Everything that needs no GPUI lives here, so it is tested without a
//! window.
//!
//! A selector names an element the way a smoke reads the screen: its
//! accessible label (the words a screen reader says), its role (AccessKit's,
//! in kebab case), its value, and its element id (the GPUI element id that
//! created it, `record`, or a qualified `SessionTransport::record`). Every
//! field given must match; `within` scopes the search to the descendants of
//! the first visible match of another selector; `index` picks the nth match
//! in tree order (the first by default, as `document.querySelector` does).
//! Only visible elements match.

use serde_json::{Map, Value, json};

/// The longest label, id or value a selector may carry.
pub const MAX_SELECTOR_TEXT: usize = 1_000;
/// How deep `within` may nest.
pub const MAX_SELECTOR_DEPTH: usize = 4;

/// An element's rect in the window, in logical points, top-left origin.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct UiBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl UiBounds {
    pub fn json(&self) -> Value {
        let round = |value: f64| (value * 100.0).round() / 100.0;
        json!({
            "x": round(self.x),
            "y": round(self.y),
            "width": round(self.width),
            "height": round(self.height),
        })
    }

    pub fn center(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }
}

/// One accessible element of a window.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UiNode {
    /// AccessKit's role in kebab case (`button`, `text-input`, `switch`,
    /// `check-box` …); `window` for the root.
    pub role: String,
    pub label: String,
    pub value: Option<String>,
    pub description: Option<String>,
    pub placeholder: Option<String>,
    /// Only for a checkable element.
    pub checked: Option<bool>,
    /// Only for an expandable element.
    pub expanded: Option<bool>,
    /// Only for a selectable item.
    pub selected: Option<bool>,
    pub enabled: bool,
    pub read_only: bool,
    pub focused: bool,
    /// Not clipped away (a closed `if` is not in the tree at all).
    pub visible: bool,
    /// A password field: its value is masked unless a find asks to reveal it.
    pub password: bool,
    /// In window points. `None` while GPUI's frame does not carry it (the
    /// pointer then has no target: see [`super::gpui_tree`]).
    pub bounds: Option<UiBounds>,
    /// The element ids it answers to: the GPUI element id that created it
    /// (debug builds name it), then the author id it gives assistive
    /// technology (`accessibility_id`), when either is known.
    pub ids: Vec<String>,
    /// The view that rendered it (`StudioPage` …), debug builds only.
    pub type_name: Option<String>,
    /// The accessible actions it takes, AccessKit's in kebab case (`click`,
    /// `focus`, `set-value` …).
    pub actions: Vec<String>,
    pub children: Vec<UiNode>,
    /// The node's AccessKit id in the frame it came from (not serialized).
    pub handle: u64,
}

impl UiNode {
    /// The node as the commands answer it, with its children to `depth`
    /// levels (`None`: all of them).
    pub fn json(&self, reveal: bool, depth: Option<usize>) -> Value {
        let mut object = Map::new();
        object.insert("role".into(), json!(self.role));
        object.insert("label".into(), json!(self.label));
        if let Some(value) = &self.value {
            let shown = if self.password && !reveal {
                "•".repeat(value.chars().count())
            } else {
                value.clone()
            };
            object.insert("value".into(), json!(shown));
        }
        let mut optional = |key: &str, value: Option<Value>| {
            if let Some(value) = value {
                object.insert(key.into(), value);
            }
        };
        optional(
            "description",
            self.description.as_ref().map(|text| json!(text)),
        );
        optional(
            "placeholder",
            self.placeholder.as_ref().map(|text| json!(text)),
        );
        optional("checked", self.checked.map(Value::Bool));
        optional("expanded", self.expanded.map(Value::Bool));
        optional("selected", self.selected.map(Value::Bool));
        optional("id", self.ids.first().map(|id| json!(id)));
        optional("ids", (self.ids.len() > 1).then(|| json!(self.ids)));
        optional("type", self.type_name.as_ref().map(|name| json!(name)));
        optional("password", self.password.then_some(Value::Bool(true)));
        object.insert("enabled".into(), Value::Bool(self.enabled));
        object.insert("readOnly".into(), Value::Bool(self.read_only));
        object.insert("focused".into(), Value::Bool(self.focused));
        object.insert("visible".into(), Value::Bool(self.visible));
        object.insert(
            "bounds".into(),
            self.bounds.map_or(Value::Null, |bounds| bounds.json()),
        );
        object.insert("actions".into(), json!(self.actions));
        match depth {
            Some(0) => {
                object.insert("childCount".into(), json!(self.children.len()));
            }
            _ => {
                let next = depth.map(|depth| depth - 1);
                object.insert(
                    "children".into(),
                    Value::Array(
                        self.children
                            .iter()
                            .map(|child| child.json(reveal, next))
                            .collect(),
                    ),
                );
            }
        }
        Value::Object(object)
    }

    /// The node and its descendants, in tree order (pre-order).
    pub fn walk(&self) -> Vec<&UiNode> {
        let mut out = Vec::new();
        let mut stack = vec![self];
        while let Some(node) = stack.pop() {
            out.push(node);
            stack.extend(node.children.iter().rev());
        }
        out
    }

    /// The node that has the keyboard focus, if any.
    pub fn focused_node(&self) -> Option<&UiNode> {
        self.walk().into_iter().find(|node| node.focused)
    }

    /// Every visible label under this node, in tree order, for an error that
    /// says what the window shows (as Electron's open-tab quotes the page).
    pub fn visible_text(&self, limit: usize) -> String {
        let mut words: Vec<&str> = Vec::new();
        for node in self.walk() {
            if node.visible && !node.label.is_empty() && node.role != "window" {
                words.push(&node.label);
            }
        }
        let mut text = words.join(" · ");
        if text.chars().count() > limit {
            text = text.chars().take(limit).collect::<String>() + "…";
        }
        text
    }
}

/// What a `ui-*` command looks for.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UiSelector {
    pub label: Option<String>,
    pub id: Option<String>,
    pub role: Option<String>,
    pub value: Option<String>,
    /// The nth match in tree order.
    pub index: usize,
    pub within: Option<Box<UiSelector>>,
}

impl UiSelector {
    pub fn label(label: &str) -> Self {
        Self {
            label: Some(label.to_string()),
            ..Self::default()
        }
    }

    /// A selector names at least one of label, id and role.
    pub fn is_empty(&self) -> bool {
        self.label.is_none() && self.id.is_none() && self.role.is_none() && self.value.is_none()
    }

    /// Whether `node` itself matches (visibility aside).
    pub fn matches(&self, node: &UiNode) -> bool {
        self.label.as_ref().is_none_or(|label| &node.label == label)
            && self.role.as_ref().is_none_or(|role| &node.role == role)
            && self
                .value
                .as_ref()
                .is_none_or(|value| node.value.as_ref() == Some(value))
            && self.id.as_ref().is_none_or(|id| id_matches(node, id))
    }

    /// Every visible match under `root` (scoped by `within`), in tree order.
    pub fn find_all<'a>(&self, root: &'a UiNode) -> Vec<&'a UiNode> {
        let scope = match &self.within {
            Some(within) => match within.find(root) {
                Some(scope) => scope,
                None => return Vec::new(),
            },
            None => root,
        };
        scope
            .walk()
            .into_iter()
            .skip(1)
            .filter(|node| node.visible && self.matches(node))
            .collect()
    }

    /// The `index`th visible match.
    pub fn find<'a>(&self, root: &'a UiNode) -> Option<&'a UiNode> {
        self.find_all(root).into_iter().nth(self.index)
    }

    /// The selector as the errors and answers name it.
    pub fn describe(&self) -> String {
        let mut parts = Vec::new();
        if let Some(role) = &self.role {
            parts.push(format!("role {role}"));
        }
        if let Some(label) = &self.label {
            parts.push(format!("label {label:?}"));
        }
        if let Some(id) = &self.id {
            parts.push(format!("id {id}"));
        }
        if let Some(value) = &self.value {
            parts.push(format!("value {value:?}"));
        }
        if self.index > 0 {
            parts.push(format!("match {}", self.index + 1));
        }
        let mut text = parts.join(", ");
        if let Some(within) = &self.within {
            text.push_str(&format!(" within ({})", within.describe()));
        }
        text
    }

    pub fn json(&self) -> Value {
        let mut object = Map::new();
        if let Some(label) = &self.label {
            object.insert("label".into(), json!(label));
        }
        if let Some(id) = &self.id {
            object.insert("id".into(), json!(id));
        }
        if let Some(role) = &self.role {
            object.insert("role".into(), json!(role));
        }
        if let Some(value) = &self.value {
            object.insert("value".into(), json!(value));
        }
        if self.index > 0 {
            object.insert("index".into(), json!(self.index));
        }
        if let Some(within) = &self.within {
            object.insert("within".into(), within.json());
        }
        Value::Object(object)
    }

    /// Reads a selector from a command's parameters: `label`, `id`, `role`,
    /// `value`, `index` and `within` (a nested selector object). `None` when
    /// none of label, id, role and value is given.
    pub fn parse(params: &Map<String, Value>) -> Result<Option<Self>, String> {
        Self::parse_at(params, 0)
    }

    fn parse_at(params: &Map<String, Value>, depth: usize) -> Result<Option<Self>, String> {
        if depth > MAX_SELECTOR_DEPTH {
            return Err(format!(
                "A selector's within nests at most {MAX_SELECTOR_DEPTH} deep."
            ));
        }
        let text = |key: &str| -> Result<Option<String>, String> {
            match params.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(text))
                    if !text.is_empty() && text.chars().count() <= MAX_SELECTOR_TEXT =>
                {
                    Ok(Some(text.clone()))
                }
                Some(_) => Err(format!(
                    "A selector's {key} is a non-empty string of at most {MAX_SELECTOR_TEXT} characters."
                )),
            }
        };
        let role = text("role")?;
        if let Some(role) = &role
            && !role
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'-')
        {
            return Err(format!(
                "A selector's role is AccessKit's kebab-case role (button, text-input, switch …), not {role:?}."
            ));
        }
        let index = match params.get("index") {
            None | Some(Value::Null) => 0,
            Some(value) => value
                .as_u64()
                .filter(|index| *index < 10_000)
                .ok_or("A selector's index is a whole number from 0.")?
                as usize,
        };
        let within = match params.get("within") {
            None | Some(Value::Null) => None,
            Some(Value::Object(within)) => Some(Box::new(
                Self::parse_at(within, depth + 1)?
                    .ok_or("A selector's within names a label, id, role or value.")?,
            )),
            Some(_) => return Err("A selector's within is a selector object.".into()),
        };
        let selector = Self {
            label: text("label")?,
            id: text("id")?,
            role,
            value: text("value")?,
            index,
            within,
        };
        Ok((!selector.is_empty()).then_some(selector))
    }
}

/// `SessionTransport::record` matches `SessionTransport::record` and
/// `record` (a view-qualified id); a qualified id never matches another component's. Any of the
/// node's ids may match.
fn id_matches(node: &UiNode, wanted: &str) -> bool {
    node.ids.iter().any(|id| {
        if wanted.contains("::") {
            id == wanted
        } else {
            id.rsplit("::").next() == Some(wanted)
        }
    })
}

/// The parameter keys a selector reads, so a command can refuse the others.
pub const SELECTOR_KEYS: &[&str] = &["label", "id", "role", "value", "index", "within"];

#[cfg(test)]
mod tests {
    use super::*;

    fn node(role: &str, label: &str) -> UiNode {
        UiNode {
            role: role.to_string(),
            label: label.to_string(),
            enabled: true,
            visible: true,
            ..UiNode::default()
        }
    }

    fn window() -> UiNode {
        let mut record = node("button", "Record");
        record.ids = vec![
            "SessionTransport::record".into(),
            "Studio::transport".into(),
        ];
        record.handle = 1;
        let mut go_live = node("button", "Go Live…");
        go_live.handle = 2;
        let mut hidden = node("button", "Record");
        hidden.visible = false;
        hidden.handle = 3;
        let mut status = node("text", "Session status");
        status.value = Some("Ready".into());
        status.handle = 4;
        let mut key = node("text-input", "Stream key");
        key.value = Some("secret".into());
        key.password = true;
        key.focused = true;
        key.handle = 6;
        let mut sheet = node("groupbox", "Go live");
        sheet.handle = 5;
        sheet.children = vec![key];
        let mut inspector = node("groupbox", "Inspector");
        inspector.handle = 7;
        inspector.children = vec![record, go_live, hidden, status];
        let mut root = node("window", "Videorc");
        root.children = vec![inspector, sheet];
        root
    }

    fn parse(value: Value) -> Result<Option<UiSelector>, String> {
        UiSelector::parse(value.as_object().unwrap())
    }

    #[test]
    fn a_selector_matches_every_field_it_names_on_visible_elements_only() {
        let root = window();
        let record = parse(json!({"label": "Record", "role": "button"}))
            .unwrap()
            .unwrap();
        let found = record.find_all(&root);
        assert_eq!(found.len(), 1, "the hidden Record does not match");
        assert_eq!(found[0].handle, 1);
        assert_eq!(
            parse(json!({"id": "record"}))
                .unwrap()
                .unwrap()
                .find(&root)
                .map(|node| node.handle),
            Some(1)
        );
        assert_eq!(
            parse(json!({"id": "SessionTransport::record"}))
                .unwrap()
                .unwrap()
                .find(&root)
                .map(|node| node.handle),
            Some(1)
        );
        assert_eq!(
            parse(json!({"id": "transport"}))
                .unwrap()
                .unwrap()
                .find(&root)
                .map(|node| node.handle),
            Some(1),
            "a wrapper's id names the element inside it"
        );
        assert!(
            parse(json!({"id": "Other::record"}))
                .unwrap()
                .unwrap()
                .find(&root)
                .is_none()
        );
        assert_eq!(
            parse(json!({"role": "button", "index": 1}))
                .unwrap()
                .unwrap()
                .find(&root)
                .map(|node| node.handle),
            Some(2)
        );
        assert_eq!(
            parse(json!({"label": "Session status", "value": "Ready"}))
                .unwrap()
                .unwrap()
                .find(&root)
                .map(|node| node.handle),
            Some(4)
        );
        // The root itself never matches.
        assert!(
            parse(json!({"role": "window"}))
                .unwrap()
                .unwrap()
                .find(&root)
                .is_none()
        );
    }

    #[test]
    fn within_scopes_the_search_to_a_subtree() {
        let root = window();
        let in_sheet = parse(json!({"role": "text-input", "within": {"label": "Go live"}}))
            .unwrap()
            .unwrap();
        assert_eq!(in_sheet.find(&root).map(|node| node.handle), Some(6));
        let record_in_sheet = parse(json!({"label": "Record", "within": {"label": "Go live"}}))
            .unwrap()
            .unwrap();
        assert!(record_in_sheet.find(&root).is_none());
        assert_eq!(
            in_sheet.describe(),
            "role text-input within (label \"Go live\")"
        );
    }

    #[test]
    fn selectors_are_bounded_and_need_a_field() {
        assert_eq!(parse(json!({})), Ok(None));
        assert_eq!(parse(json!({"index": 2})), Ok(None));
        for bad in [
            json!({"label": ""}),
            json!({"label": 3}),
            json!({"label": "x".repeat(MAX_SELECTOR_TEXT + 1)}),
            json!({"role": "Button"}),
            json!({"role": "button", "index": -1}),
            json!({"role": "button", "index": 1.5}),
            json!({"role": "button", "within": "x"}),
            json!({"role": "button", "within": {"index": 1}}),
        ] {
            assert!(parse(bad.clone()).is_err(), "{bad}");
        }
        let mut deep = json!({"role": "button"});
        for _ in 0..=MAX_SELECTOR_DEPTH {
            deep = json!({"role": "button", "within": deep});
        }
        assert!(parse(deep).is_err());
    }

    #[test]
    fn the_json_masks_passwords_and_stops_at_the_depth() {
        let root = window();
        let tree = root.json(false, None);
        let key = &tree["children"][1]["children"][0];
        assert_eq!(key["value"], json!("••••••"));
        assert_eq!(key["password"], json!(true));
        assert_eq!(key["focused"], json!(true));
        assert_eq!(
            root.json(true, None)["children"][1]["children"][0]["value"],
            json!("secret")
        );
        let shallow = root.json(false, Some(1));
        assert_eq!(shallow["children"][0]["childCount"], json!(4));
        assert!(shallow["children"][0].get("children").is_none());
        // The record node carries its id and no checked state (not checkable).
        let record = &tree["children"][0]["children"][0];
        assert_eq!(record["id"], json!("SessionTransport::record"));
        assert_eq!(
            record["ids"],
            json!(["SessionTransport::record", "Studio::transport"])
        );
        assert!(record.get("checked").is_none());
        assert!(record.get("handle").is_none());
        assert_eq!(root.focused_node().map(|node| node.handle), Some(6));
        assert_eq!(
            root.visible_text(200),
            "Inspector · Record · Go Live… · Session status · Go live · Stream key"
        );
    }
}
