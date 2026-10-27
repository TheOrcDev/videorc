//! The agent tool catalog (plan 209 S1): what AI agents may ask Videorc to
//! do, read from `protocol-fixtures/agent-tools.json` at compile time.
//!
//! One catalog names every tool, its schemas, its MCP hints, where it runs
//! (`backend` or `studio`), whether Buddy may use it (D15), whether it earns a
//! Studio notice (D11) and its rate family (Security table). The backend's
//! `/mcp` endpoint, the `videorc-mcp` bridge, the renderer and the Buddy
//! planner request all read it; `apps/desktop/src/shared/agent-tools.ts` is
//! its TypeScript twin and a test on each side pins them to the same file.
//!
//! This module depends on `serde` and `serde_json` only: the bridge binary
//! includes it by `#[path]` and must stay free of the backend's other
//! modules.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The catalog as shipped, byte for byte.
pub const CATALOG_JSON: &str = include_str!("../../../protocol-fixtures/agent-tools.json");

/// D10: about forty tools, never two hundred eighty.
pub const MAX_TOOLS: usize = 45;
pub const MAX_TOOL_NAME_CHARS: usize = 40;
/// Every description says when to use the tool and what the streamer sees,
/// in one to three sentences.
pub const MIN_DESCRIPTION_CHARS: usize = 40;
pub const MAX_DESCRIPTION_CHARS: usize = 400;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentToolCatalog {
    pub version: u32,
    /// The server name agent apps show (`mcp__videorc__…`), D21.
    pub server_name: String,
    pub server_title: String,
    /// The `initialize` result's instructions.
    pub instructions: String,
    pub tools: Vec<AgentTool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTool {
    pub name: String,
    pub title: String,
    pub description: String,
    /// JSON Schema 2020-12, the subset `compile_schema` accepts.
    pub input_schema: Value,
    pub output_schema: Value,
    pub annotations: AgentToolAnnotations,
    pub runs_in: AgentToolRunsIn,
    /// D15: Buddy's planner may return this tool.
    pub buddy: bool,
    /// D11: the Studio shows a notice naming the agent when it runs.
    pub on_air: bool,
    pub rate_family: AgentRateFamily,
    /// The notice sentence, with `{agent}` and `{field}` placeholders filled
    /// from the call's arguments, then its structured result (`fill_notice`).
    pub notice: Option<String>,
}

/// MCP tool annotations. All hints, honest ones (D2).
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentToolAnnotations {
    pub read_only_hint: bool,
    pub destructive_hint: bool,
    pub idempotent_hint: bool,
    pub open_world_hint: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentToolRunsIn {
    /// The same Rust function its RPC calls.
    Backend,
    /// Relayed to the renderer's Studio action executor.
    Studio,
}

/// The per-agent rate families from the plan's Security table. The limits
/// themselves live beside the limiter in `agent_mcp.rs`.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum AgentRateFamily {
    Read,
    Action,
    Chat,
    Removal,
    Session,
}

/// The compiled-in catalog. The fixture is validated by `parse_catalog` on
/// first use; a broken fixture cannot ship because both test suites parse it.
pub fn catalog() -> &'static AgentToolCatalog {
    static CATALOG: OnceLock<AgentToolCatalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        parse_catalog(CATALOG_JSON).expect("protocol-fixtures/agent-tools.json is valid")
    })
}

/// Parse and check a catalog: unique snake_case names, at most `MAX_TOOLS`,
/// and every schema compiles.
pub fn parse_catalog(json: &str) -> Result<AgentToolCatalog, String> {
    let catalog: AgentToolCatalog =
        serde_json::from_str(json).map_err(|error| format!("agent-tools.json: {error}"))?;
    if catalog.tools.len() > MAX_TOOLS {
        return Err(format!(
            "agent-tools.json lists {} tools; the catalog holds at most {MAX_TOOLS}.",
            catalog.tools.len()
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    for tool in &catalog.tools {
        if !is_snake_case_name(&tool.name) {
            return Err(format!(
                "Tool name `{}` must be snake_case (a to z, 0 to 9, underscores), 1 to {MAX_TOOL_NAME_CHARS} characters.",
                tool.name
            ));
        }
        if !seen.insert(tool.name.as_str()) {
            return Err(format!("Tool name `{}` is listed twice.", tool.name));
        }
        if tool.title.trim().is_empty() {
            return Err(format!("Tool `{}` needs a title.", tool.name));
        }
        let description_chars = tool.description.chars().count();
        if !(MIN_DESCRIPTION_CHARS..=MAX_DESCRIPTION_CHARS).contains(&description_chars) {
            return Err(format!(
                "Tool `{}` description is {description_chars} characters; it must be {MIN_DESCRIPTION_CHARS} to {MAX_DESCRIPTION_CHARS}.",
                tool.name
            ));
        }
        compile_schema(&tool.input_schema)
            .map_err(|error| format!("Tool `{}` inputSchema: {error}", tool.name))?;
        compile_schema(&tool.output_schema)
            .map_err(|error| format!("Tool `{}` outputSchema: {error}", tool.name))?;
        if tool.input_schema.get("type") != Some(&Value::String("object".to_string())) {
            return Err(format!(
                "Tool `{}` inputSchema must be an object schema.",
                tool.name
            ));
        }
        if tool.on_air != tool.notice.is_some() {
            return Err(format!(
                "Tool `{}`: onAir tools carry a notice sentence and only they do.",
                tool.name
            ));
        }
    }
    Ok(catalog)
}

pub fn is_snake_case_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_TOOL_NAME_CHARS
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        && !name.starts_with('_')
        && !name.ends_with('_')
        && !name.contains("__")
}

impl AgentToolCatalog {
    pub fn tool(&self, name: &str) -> Option<&AgentTool> {
        self.tools.iter().find(|tool| tool.name == name)
    }

    /// The `tools/list` result's `tools` array.
    pub fn mcp_tools(&self) -> Vec<Value> {
        self.tools.iter().map(AgentTool::mcp_tool).collect()
    }
}

impl AgentTool {
    /// The MCP `Tool` wire shape: name, title, description, both schemas and
    /// the annotations. The catalog's own fields (`runsIn`, `buddy`, …) stay
    /// inside Videorc.
    pub fn mcp_tool(&self) -> Value {
        serde_json::json!({
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "inputSchema": self.input_schema,
            "outputSchema": self.output_schema,
            "annotations": self.annotations,
        })
    }

    /// Check a call's arguments against the input schema. The sentence names
    /// the argument so an agent can fix the call.
    pub fn validate_arguments(&self, arguments: &Value) -> Result<(), String> {
        validate_value(&self.input_schema, arguments, "arguments")
    }

    /// D11: the notice sentence with `{agent}` and every `{field}` filled,
    /// fields from the call's arguments first, then its structured result
    /// (`stop` names what it stopped). `None` for a tool without a notice.
    /// The TypeScript twin is `agentToolNotice`.
    pub fn fill_notice(
        &self,
        agent: &str,
        arguments: &Value,
        result: Option<&Value>,
    ) -> Option<String> {
        let mut text = self.notice.as_ref()?.replace("{agent}", agent);
        for fields in [Some(arguments), result].into_iter().flatten() {
            let Some(fields) = fields.as_object() else {
                continue;
            };
            for (key, value) in fields {
                let placeholder = format!("{{{key}}}");
                if !text.contains(&placeholder) {
                    continue;
                }
                let shown = match value {
                    Value::String(text) => text.clone(),
                    Value::Null => String::new(),
                    other => other.to_string(),
                };
                text = text.replace(&placeholder, &shown);
            }
        }
        Some(text)
    }
}

// ---------------------------------------------------------------------------
// JSON Schema (2020-12) subset
// ---------------------------------------------------------------------------

/// The keywords the catalog may use. Anything else fails to compile so a typo
/// (`"type": "strnig"`, `"require"`) cannot ship as a silently ignored key.
const SCHEMA_KEYWORDS: &[&str] = &[
    "type",
    "title",
    "description",
    "default",
    "properties",
    "required",
    "additionalProperties",
    "enum",
    "const",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
    "items",
    "oneOf",
    "anyOf",
];

const SCHEMA_TYPES: &[&str] = &[
    "object", "string", "number", "integer", "boolean", "array", "null",
];

/// Check that a schema uses only the supported subset, with well-formed
/// values. Returns a sentence naming the first problem.
pub fn compile_schema(schema: &Value) -> Result<(), String> {
    compile_schema_at(schema, "#")
}

fn compile_schema_at(schema: &Value, path: &str) -> Result<(), String> {
    let Some(object) = schema.as_object() else {
        return Err(format!("{path} must be a schema object."));
    };
    for key in object.keys() {
        if !SCHEMA_KEYWORDS.contains(&key.as_str()) {
            return Err(format!("{path} uses the unsupported keyword `{key}`."));
        }
    }
    let has_type = object.contains_key("type");
    let has_alternatives = object.contains_key("oneOf") || object.contains_key("anyOf");
    if !has_type
        && !has_alternatives
        && !object.contains_key("enum")
        && !object.contains_key("const")
    {
        return Err(format!(
            "{path} needs a `type`, an `enum`, a `const`, a `oneOf` or an `anyOf`."
        ));
    }
    if let Some(kind) = object.get("type") {
        let names: Vec<&str> = match kind {
            Value::String(name) => vec![name.as_str()],
            Value::Array(items) => items
                .iter()
                .map(|item| item.as_str().unwrap_or(""))
                .collect(),
            _ => {
                return Err(format!(
                    "{path}.type must be a type name or a list of them."
                ));
            }
        };
        for name in &names {
            if !SCHEMA_TYPES.contains(name) {
                return Err(format!("{path}.type `{name}` is not a JSON Schema type."));
            }
        }
    }
    for (key, expected) in [("title", "text"), ("description", "text")] {
        if let Some(value) = object.get(key)
            && !value.is_string()
        {
            return Err(format!("{path}.{key} must be {expected}."));
        }
    }
    if let Some(properties) = object.get("properties") {
        let Some(properties) = properties.as_object() else {
            return Err(format!("{path}.properties must be an object."));
        };
        for (name, child) in properties {
            compile_schema_at(child, &format!("{path}.properties.{name}"))?;
        }
    }
    if let Some(required) = object.get("required") {
        let Some(required) = required.as_array() else {
            return Err(format!("{path}.required must be a list of field names."));
        };
        let properties = object.get("properties").and_then(Value::as_object);
        for name in required {
            let Some(name) = name.as_str() else {
                return Err(format!("{path}.required must hold field names."));
            };
            if !properties.is_some_and(|properties| properties.contains_key(name)) {
                return Err(format!(
                    "{path}.required names `{name}`, which is not in properties."
                ));
            }
        }
    }
    if let Some(additional) = object.get("additionalProperties")
        && !additional.is_boolean()
    {
        return Err(format!(
            "{path}.additionalProperties must be true or false."
        ));
    }
    if let Some(choices) = object.get("enum") {
        let Some(choices) = choices.as_array() else {
            return Err(format!("{path}.enum must be a list."));
        };
        if choices.is_empty() {
            return Err(format!("{path}.enum must list at least one value."));
        }
    }
    for key in ["minLength", "maxLength", "minItems", "maxItems"] {
        if let Some(value) = object.get(key)
            && !value.is_u64()
        {
            return Err(format!("{path}.{key} must be a whole number."));
        }
    }
    for key in ["minimum", "maximum"] {
        if let Some(value) = object.get(key)
            && !value.is_number()
        {
            return Err(format!("{path}.{key} must be a number."));
        }
    }
    if let Some(items) = object.get("items") {
        compile_schema_at(items, &format!("{path}.items"))?;
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(alternatives) = object.get(key) {
            let Some(alternatives) = alternatives.as_array() else {
                return Err(format!("{path}.{key} must be a list of schemas."));
            };
            if alternatives.is_empty() {
                return Err(format!("{path}.{key} must list at least one schema."));
            }
            for (index, alternative) in alternatives.iter().enumerate() {
                compile_schema_at(alternative, &format!("{path}.{key}[{index}]"))?;
            }
        }
    }
    Ok(())
}

fn type_matches(name: &str, value: &Value) -> bool {
    match name {
        "object" => value.is_object(),
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.is_i64() || value.is_u64(),
        "boolean" => value.is_boolean(),
        "array" => value.is_array(),
        "null" => value.is_null(),
        _ => false,
    }
}

fn type_sentence(name: &str) -> &'static str {
    match name {
        "object" => "an object",
        "string" => "text",
        "number" => "a number",
        "integer" => "a whole number",
        "boolean" => "true or false",
        "array" => "a list",
        "null" => "null",
        _ => "another type",
    }
}

/// Validate a value against a compiled schema. `path` names the value in the
/// sentence (`arguments`, `arguments.title`).
pub fn validate_value(schema: &Value, value: &Value, path: &str) -> Result<(), String> {
    let Some(object) = schema.as_object() else {
        return Err(format!("{path} has no schema."));
    };
    if let Some(expected) = object.get("const")
        && value != expected
    {
        return Err(format!("{path} must be {expected}."));
    }
    if let Some(choices) = object.get("enum").and_then(Value::as_array)
        && !choices.contains(value)
    {
        let shown: Vec<String> = choices.iter().map(Value::to_string).collect();
        return Err(format!("{path} must be one of {}.", shown.join(", ")));
    }
    if let Some(kind) = object.get("type") {
        let names: Vec<&str> = match kind {
            Value::String(name) => vec![name.as_str()],
            Value::Array(items) => items.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        if !names.iter().any(|name| type_matches(name, value)) {
            let wanted: Vec<&str> = names.iter().map(|name| type_sentence(name)).collect();
            return Err(format!("{path} must be {}.", wanted.join(" or ")));
        }
    }
    if let Some(text) = value.as_str() {
        let chars = text.chars().count();
        if let Some(min) = object.get("minLength").and_then(Value::as_u64)
            && (chars as u64) < min
        {
            return Err(if min == 1 {
                format!("{path} must not be empty.")
            } else {
                format!("{path} must be at least {min} characters.")
            });
        }
        if let Some(max) = object.get("maxLength").and_then(Value::as_u64)
            && (chars as u64) > max
        {
            return Err(format!("{path} must be at most {max} characters."));
        }
    }
    if let Some(number) = value.as_f64() {
        if let Some(min) = object.get("minimum").and_then(Value::as_f64)
            && number < min
        {
            return Err(format!("{path} must be at least {min}."));
        }
        if let Some(max) = object.get("maximum").and_then(Value::as_f64)
            && number > max
        {
            return Err(format!("{path} must be at most {max}."));
        }
    }
    if let Some(items) = value.as_array() {
        if let Some(min) = object.get("minItems").and_then(Value::as_u64)
            && (items.len() as u64) < min
        {
            return Err(format!("{path} must list at least {min} items."));
        }
        if let Some(max) = object.get("maxItems").and_then(Value::as_u64)
            && (items.len() as u64) > max
        {
            return Err(format!("{path} must list at most {max} items."));
        }
        if let Some(item_schema) = object.get("items") {
            for (index, item) in items.iter().enumerate() {
                validate_value(item_schema, item, &format!("{path}[{index}]"))?;
            }
        }
    }
    if let Some(fields) = value.as_object() {
        let properties = object.get("properties").and_then(Value::as_object);
        if let Some(required) = object.get("required").and_then(Value::as_array) {
            for name in required.iter().filter_map(Value::as_str) {
                if !fields.contains_key(name) {
                    return Err(format!("{path}.{name} is required."));
                }
            }
        }
        let additional_allowed = object
            .get("additionalProperties")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        for (name, field) in fields {
            match properties.and_then(|properties| properties.get(name)) {
                Some(child) => validate_value(child, field, &format!("{path}.{name}"))?,
                None if additional_allowed => {}
                None => return Err(format!("{path} has no field `{name}`.")),
            }
        }
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(alternatives) = object.get(key).and_then(Value::as_array) {
            let matches = alternatives
                .iter()
                .filter(|alternative| validate_value(alternative, value, path).is_ok())
                .count();
            let wanted = if key == "oneOf" {
                matches == 1
            } else {
                matches >= 1
            };
            if !wanted {
                return Err(format!("{path} does not match any of its allowed shapes."));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RPC method namespaces that must never appear in agent-facing text:
    /// methods are not tools (D10), and an agent reading a method name would
    /// try to call it.
    const METHOD_NAMESPACES: &[&str] = &[
        "session.",
        "sessions.",
        "banners.",
        "remote.",
        "cohost.",
        "liveChat.",
        "scene.",
        "sounds.",
        "screens.",
        "captions.",
        "streamTargets.",
        "overlays.",
        "comments.",
        "clip.",
        "replay.",
        "agents.",
        "agent.",
        "preview.",
        "account.",
        "platformAccounts.",
    ];

    /// `namespace.identifier`, not the word "banners" ending a sentence.
    fn mentions_method(text: &str, namespace: &str) -> bool {
        let mut from = 0;
        while let Some(at) = text[from..].find(namespace) {
            let after = from + at + namespace.len();
            if text[after..]
                .chars()
                .next()
                .is_some_and(|next| next.is_ascii_alphabetic() || next == '_')
            {
                return true;
            }
            from = after;
        }
        false
    }

    fn every_string(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::String(text) => out.push(text.clone()),
            Value::Array(items) => items.iter().for_each(|item| every_string(item, out)),
            Value::Object(fields) => fields.values().for_each(|item| every_string(item, out)),
            _ => {}
        }
    }

    #[test]
    fn the_shipped_catalog_parses_and_keeps_its_rules() {
        let catalog = catalog();
        assert_eq!(catalog.version, 1);
        assert_eq!(catalog.server_name, "videorc");
        assert!(!catalog.tools.is_empty());
        assert!(catalog.tools.len() <= MAX_TOOLS);
        let mut names: Vec<&str> = catalog
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect();
        let count = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), count, "tool names must be unique");
        for tool in &catalog.tools {
            assert!(is_snake_case_name(&tool.name), "{}", tool.name);
            let length = tool.description.chars().count();
            assert!(
                (MIN_DESCRIPTION_CHARS..=MAX_DESCRIPTION_CHARS).contains(&length),
                "{} description is {length} characters",
                tool.name
            );
            assert!(compile_schema(&tool.input_schema).is_ok());
            assert!(compile_schema(&tool.output_schema).is_ok());
        }
        // The instructions carry the four sentences the plan asks for.
        for needle in ["get_status", "viewers", "public", "Trash"] {
            assert!(catalog.instructions.contains(needle), "{needle}");
        }
    }

    #[test]
    fn no_catalog_text_mentions_a_method_name() {
        let raw: Value = serde_json::from_str(CATALOG_JSON).unwrap();
        let mut strings = Vec::new();
        every_string(&raw, &mut strings);
        assert!(!mentions_method("the banners. Chat", "banners."));
        assert!(mentions_method("call banners.show now", "banners."));
        for text in strings {
            for namespace in METHOD_NAMESPACES {
                assert!(
                    !mentions_method(&text, namespace),
                    "catalog text mentions the method namespace `{namespace}`: {text}"
                );
            }
        }
    }

    #[test]
    fn every_tool_carries_the_full_field_set_and_honest_notice_pairing() {
        let raw: Value = serde_json::from_str(CATALOG_JSON).unwrap();
        let expected = [
            "name",
            "title",
            "description",
            "inputSchema",
            "outputSchema",
            "annotations",
            "runsIn",
            "buddy",
            "onAir",
            "rateFamily",
            "notice",
        ];
        // serde_json sorts object keys; compare the sets.
        let mut expected: Vec<&str> = expected.to_vec();
        expected.sort_unstable();
        for tool in raw["tools"].as_array().unwrap() {
            let mut keys: Vec<&str> = tool
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            keys.sort_unstable();
            assert_eq!(keys, expected, "{}", tool["name"]);
            assert_eq!(
                tool["onAir"].as_bool().unwrap(),
                !tool["notice"].is_null(),
                "{}",
                tool["name"]
            );
        }
    }

    #[test]
    fn a_schema_typo_fails_the_catalog() {
        let broken = CATALOG_JSON.replacen("\"type\": \"string\"", "\"type\": \"strnig\"", 1);
        let error = parse_catalog(&broken).unwrap_err();
        assert!(error.contains("strnig"), "{error}");
        let misspelt_keyword = CATALOG_JSON.replacen("\"required\"", "\"require\"", 1);
        let error = parse_catalog(&misspelt_keyword).unwrap_err();
        assert!(error.contains("require"), "{error}");
        let duplicate =
            CATALOG_JSON.replacen("\"name\": \"notify\"", "\"name\": \"add_marker\"", 1);
        assert!(parse_catalog(&duplicate).unwrap_err().contains("twice"));
        let camel = CATALOG_JSON.replacen("\"name\": \"notify\"", "\"name\": \"notifyMe\"", 1);
        assert!(parse_catalog(&camel).unwrap_err().contains("snake_case"));
        let unknown_field =
            CATALOG_JSON.replacen("\"buddy\": false", "\"buddy\": false, \"x\": 1", 1);
        assert!(parse_catalog(&unknown_field).is_err());
        let notice_without_on_air = CATALOG_JSON.replacen("\"onAir\": true", "\"onAir\": false", 1);
        assert!(
            parse_catalog(&notice_without_on_air)
                .unwrap_err()
                .contains("onAir")
        );
    }

    #[test]
    fn descriptions_outside_40_to_400_characters_fail_the_catalog() {
        let mut raw: Value = serde_json::from_str(CATALOG_JSON).unwrap();
        raw["tools"][0]["description"] = Value::String("Too short to say when.".to_string());
        let error = parse_catalog(&raw.to_string()).unwrap_err();
        assert!(error.contains("must be 40 to 400"), "{error}");
        raw["tools"][0]["description"] = Value::String("x".repeat(401));
        assert!(parse_catalog(&raw.to_string()).is_err());
    }

    #[test]
    fn arguments_are_checked_against_the_input_schema_with_sentences() {
        let catalog = catalog();
        let notify = catalog.tool("notify").unwrap();
        assert!(
            notify
                .validate_arguments(&serde_json::json!({ "message": "hi" }))
                .is_ok()
        );
        assert_eq!(
            notify.validate_arguments(&serde_json::json!({})),
            Err("arguments.message is required.".to_string())
        );
        assert_eq!(
            notify.validate_arguments(&serde_json::json!({ "message": "" })),
            Err("arguments.message must not be empty.".to_string())
        );
        assert_eq!(
            notify.validate_arguments(&serde_json::json!({ "message": 4 })),
            Err("arguments.message must be text.".to_string())
        );
        assert_eq!(
            notify.validate_arguments(&serde_json::json!({ "message": "hi", "loud": true })),
            Err("arguments has no field `loud`.".to_string())
        );
        assert_eq!(
            notify.validate_arguments(&serde_json::json!({ "message": "x".repeat(201) })),
            Err("arguments.message must be at most 200 characters.".to_string())
        );
        assert_eq!(
            notify.validate_arguments(&serde_json::json!([])),
            Err("arguments must be an object.".to_string())
        );
        let set_banner = catalog.tool("set_banner").unwrap();
        assert!(
            set_banner
                .validate_arguments(&serde_json::json!({ "shown": false }))
                .is_ok()
        );
        assert_eq!(
            set_banner.validate_arguments(&serde_json::json!({ "shown": "yes" })),
            Err("arguments.shown must be true or false.".to_string())
        );
    }

    #[test]
    fn the_validator_covers_the_rest_of_the_subset() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "seconds": { "type": "integer", "enum": [30, 60] },
                "gain": { "type": "number", "minimum": -30, "maximum": 10 },
                "ids": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 2 },
                "place": { "oneOf": [ { "type": "string" }, { "type": "null" } ] },
                "mode": { "const": "fast" }
            },
            "required": ["seconds"]
        });
        compile_schema(&schema).unwrap();
        let ok = serde_json::json!({ "seconds": 30, "gain": 0, "ids": ["a"], "place": null, "mode": "fast", "extra": 1 });
        assert!(validate_value(&schema, &ok, "arguments").is_ok());
        assert_eq!(
            validate_value(&schema, &serde_json::json!({ "seconds": 45 }), "arguments"),
            Err("arguments.seconds must be one of 30, 60.".to_string())
        );
        assert_eq!(
            validate_value(
                &schema,
                &serde_json::json!({ "seconds": 30, "gain": 11 }),
                "arguments"
            ),
            Err("arguments.gain must be at most 10.".to_string())
        );
        assert_eq!(
            validate_value(
                &schema,
                &serde_json::json!({ "seconds": 30, "ids": [] }),
                "arguments"
            ),
            Err("arguments.ids must list at least 1 items.".to_string())
        );
        assert_eq!(
            validate_value(
                &schema,
                &serde_json::json!({ "seconds": 30, "ids": [1] }),
                "arguments"
            ),
            Err("arguments.ids[0] must be text.".to_string())
        );
        assert_eq!(
            validate_value(
                &schema,
                &serde_json::json!({ "seconds": 30, "place": 2 }),
                "arguments"
            ),
            Err("arguments.place does not match any of its allowed shapes.".to_string())
        );
        assert_eq!(
            validate_value(
                &schema,
                &serde_json::json!({ "seconds": 30, "mode": "slow" }),
                "arguments"
            ),
            Err("arguments.mode must be \"fast\".".to_string())
        );
        assert!(
            compile_schema(&serde_json::json!({ "type": "object", "required": ["x"] })).is_err()
        );
        assert!(compile_schema(&serde_json::json!({ "description": "no type" })).is_err());
        assert!(compile_schema(&serde_json::json!({ "type": "string", "pattern": "x" })).is_err());
    }

    #[test]
    fn notices_fill_the_agent_the_arguments_and_the_result() {
        let catalog = catalog();
        let notify = catalog.tool("notify").unwrap();
        assert_eq!(
            notify.fill_notice(
                "Claude Desktop",
                &serde_json::json!({ "message": "the sponsor banner is up" }),
                None
            ),
            Some("Claude Desktop: the sponsor banner is up".to_string())
        );
        let stop = catalog.tool("stop").unwrap();
        assert!(stop.on_air);
        assert_eq!(
            stop.fill_notice(
                "Cursor",
                &serde_json::json!({}),
                Some(&serde_json::json!({ "stopped": "livestream" }))
            ),
            Some("Cursor ended the livestream.".to_string())
        );
        assert_eq!(
            catalog
                .tool("add_marker")
                .unwrap()
                .fill_notice("Cursor", &serde_json::json!({}), None),
            None
        );
    }

    #[test]
    fn the_pr_a_tools_run_where_the_plan_says() {
        let catalog = catalog();
        let backend = [
            "get_status",
            "get_picture",
            "list_scenes",
            "list_sources",
            "list_assets",
            "read_chat",
            "list_destinations",
            "list_recordings",
            "get_recording",
            "save_clip",
            "add_marker",
            "set_banner",
        ];
        let studio = [
            "start_recording",
            "stop",
            "switch_scene",
            "set_audio",
            "set_takeover",
            "play_sound",
            "stop_sounds",
            "set_highlight",
            "open_window",
            "notify",
        ];
        for name in backend {
            assert_eq!(
                catalog.tool(name).map(|tool| tool.runs_in),
                Some(AgentToolRunsIn::Backend),
                "{name}"
            );
        }
        for name in studio {
            assert_eq!(
                catalog.tool(name).map(|tool| tool.runs_in),
                Some(AgentToolRunsIn::Studio),
                "{name}"
            );
        }
        // PR B adds tools beside these (their own test below).
        assert!(catalog.tools.len() >= backend.len() + studio.len());
        // D15: Buddy never reads one take's files, never opens windows.
        for name in ["get_recording", "open_window", "notify"] {
            assert!(!catalog.tool(name).unwrap().buddy, "{name}");
        }
        // D11: the two PR A tools that earn a notice.
        let on_air: Vec<&str> = catalog
            .tools
            .iter()
            .filter(|tool| {
                tool.on_air
                    && (backend.contains(&tool.name.as_str())
                        || studio.contains(&tool.name.as_str()))
            })
            .map(|tool| tool.name.as_str())
            .collect();
        assert_eq!(on_air, ["stop", "notify"]);
        // Every read is a read, honestly hinted.
        for tool in &catalog.tools {
            assert_eq!(
                tool.annotations.read_only_hint,
                tool.rate_family == AgentRateFamily::Read,
                "{}",
                tool.name
            );
        }
        assert!(catalog.tool("stop").unwrap().annotations.destructive_hint);
    }

    /// Plan 209 PR B, Run the show and Arrange the picture (S10, S11,
    /// S11b): where each runs, its rate family and notice. Buddy may use all
    /// of them (D15).
    #[test]
    fn the_pr_b_run_the_show_and_arrange_tools_run_where_the_plan_says() {
        let catalog = catalog();
        let expected: &[(&str, AgentToolRunsIn, AgentRateFamily, bool)] = &[(
            "go_live",
            AgentToolRunsIn::Studio,
            AgentRateFamily::Session,
            true,
        )];
        for (name, runs_in, rate_family, on_air) in expected {
            let tool = catalog
                .tool(name)
                .unwrap_or_else(|| panic!("{name} is listed"));
            assert_eq!(tool.runs_in, *runs_in, "{name}");
            assert_eq!(tool.rate_family, *rate_family, "{name}");
            assert_eq!(tool.on_air, *on_air, "{name}");
            assert!(tool.buddy, "{name}: D15");
        }
        assert_eq!(
            catalog
                .tool("go_live")
                .unwrap()
                .fill_notice("Claude Desktop", &serde_json::json!({}), None)
                .as_deref(),
            Some("Claude Desktop started the livestream.")
        );
        assert!(catalog.tool("go_live").unwrap().annotations.open_world_hint);
    }

    #[test]
    fn mcp_tool_shape_keeps_catalog_fields_inside_videorc() {
        let catalog = catalog();
        let notify = catalog.tool("notify").unwrap();
        let wire = notify.mcp_tool();
        assert_eq!(wire["name"], "notify");
        assert_eq!(wire["title"], "Show a notice");
        assert_eq!(wire["annotations"]["readOnlyHint"], false);
        assert_eq!(wire["outputSchema"]["type"], "object");
        for internal in ["runsIn", "buddy", "onAir", "rateFamily", "notice"] {
            assert!(
                wire.get(internal).is_none(),
                "catalog-only field {internal} stays inside Videorc"
            );
        }
        assert_eq!(catalog.mcp_tools().len(), catalog.tools.len());
    }
}
