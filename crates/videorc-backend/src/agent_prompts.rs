//! Videorc MCP prompts (plan 209 S22): "Go-live checklist" and "Stream
//! recap", read from `protocol-fixtures/agent-prompts.json` at compile time.
//!
//! Agent apps show prompts as slash commands (Claude Code, Cursor) or in a
//! prompt menu (Claude Desktop). Each one is a fixed request from the
//! streamer that tells the agent which tools to call; none carries live data,
//! so the backend's `/mcp` endpoint and the `videorc-mcp` bridge serve the
//! same text, and the bridge answers `prompts/list` and `prompts/get` with
//! Videorc closed (D7).
//!
//! Like `agent_tools.rs`, this module depends on `serde` and `serde_json`
//! (and the catalog's name rule) only: the bridge includes it by `#[path]`.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The prompts as shipped, byte for byte.
pub const PROMPTS_JSON: &str = include_str!("../../../protocol-fixtures/agent-prompts.json");

/// A prompt is a short request, not a manual.
pub const MAX_PROMPT_TEXT_CHARS: usize = 2_000;
pub const MAX_PROMPTS: usize = 8;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentPromptCatalog {
    pub version: u32,
    pub prompts: Vec<AgentPrompt>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentPrompt {
    pub name: String,
    pub title: String,
    pub description: String,
    /// The tools the text tells the agent to call. Never on the wire; a test
    /// holds each to the tool catalog, so a renamed tool fails the build.
    pub tools: Vec<String>,
    /// The user message `prompts/get` returns.
    pub text: String,
}

/// The compiled-in prompts. Both test suites parse the fixture, so a broken
/// one cannot ship.
pub fn prompts() -> &'static AgentPromptCatalog {
    static PROMPTS: OnceLock<AgentPromptCatalog> = OnceLock::new();
    PROMPTS.get_or_init(|| {
        parse_prompts(PROMPTS_JSON).expect("protocol-fixtures/agent-prompts.json is valid")
    })
}

/// Parse and check the prompts: unique snake_case names, a title, a
/// description the length of a tool's, a short text that names every tool it
/// lists.
pub fn parse_prompts(json: &str) -> Result<AgentPromptCatalog, String> {
    let catalog: AgentPromptCatalog =
        serde_json::from_str(json).map_err(|error| format!("agent-prompts.json: {error}"))?;
    if catalog.prompts.len() > MAX_PROMPTS {
        return Err(format!(
            "agent-prompts.json lists {} prompts; at most {MAX_PROMPTS}.",
            catalog.prompts.len()
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    for prompt in &catalog.prompts {
        if !crate::agent_tools::is_snake_case_name(&prompt.name) {
            return Err(format!("Prompt name `{}` must be snake_case.", prompt.name));
        }
        if !seen.insert(prompt.name.as_str()) {
            return Err(format!("Prompt name `{}` is listed twice.", prompt.name));
        }
        if prompt.title.trim().is_empty() {
            return Err(format!("Prompt `{}` needs a title.", prompt.name));
        }
        let description_chars = prompt.description.chars().count();
        if !(crate::agent_tools::MIN_DESCRIPTION_CHARS..=crate::agent_tools::MAX_DESCRIPTION_CHARS)
            .contains(&description_chars)
        {
            return Err(format!(
                "Prompt `{}` description is {description_chars} characters.",
                prompt.name
            ));
        }
        let text_chars = prompt.text.chars().count();
        if prompt.text.trim().is_empty() || text_chars > MAX_PROMPT_TEXT_CHARS {
            return Err(format!(
                "Prompt `{}` text is {text_chars} characters; it must be 1 to {MAX_PROMPT_TEXT_CHARS}.",
                prompt.name
            ));
        }
        if prompt.tools.is_empty() {
            return Err(format!("Prompt `{}` lists no tools.", prompt.name));
        }
        for tool in &prompt.tools {
            if !prompt.text.contains(tool.as_str()) {
                return Err(format!(
                    "Prompt `{}` lists `{tool}` but its text never names it.",
                    prompt.name
                ));
            }
        }
    }
    Ok(catalog)
}

impl AgentPromptCatalog {
    pub fn prompt(&self, name: &str) -> Option<&AgentPrompt> {
        self.prompts.iter().find(|prompt| prompt.name == name)
    }

    /// The `prompts/list` result's `prompts` array.
    pub fn mcp_prompts(&self) -> Vec<Value> {
        self.prompts.iter().map(AgentPrompt::mcp_prompt).collect()
    }
}

impl AgentPrompt {
    /// The MCP `Prompt` wire shape: name, title and description. No
    /// arguments: each prompt is one fixed request.
    pub fn mcp_prompt(&self) -> Value {
        json!({
            "name": self.name,
            "title": self.title,
            "description": self.description,
        })
    }

    /// The `prompts/get` result: one user message with the text.
    pub fn mcp_get_result(&self) -> Value {
        json!({
            "description": self.description,
            "messages": [{ "role": "user", "content": { "type": "text", "text": self.text } }],
        })
    }
}

/// The sentence for a `prompts/get` naming no prompt Videorc has.
pub fn unknown_prompt(name: &str) -> String {
    format!("Videorc has no prompt called `{name}`.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_prompts_parse_and_name_real_tools() {
        let catalog = prompts();
        let names: Vec<&str> = catalog
            .prompts
            .iter()
            .map(|prompt| prompt.name.as_str())
            .collect();
        assert_eq!(names, ["go_live_checklist", "stream_recap"]);
        let tools = crate::agent_tools::catalog();
        for prompt in &catalog.prompts {
            for tool in &prompt.tools {
                assert!(
                    tools.tool(tool).is_some(),
                    "prompt `{}` names `{tool}`, which the tool catalog doesn't have",
                    prompt.name
                );
            }
        }
        assert_eq!(
            catalog.prompt("go_live_checklist").unwrap().tools,
            ["get_status", "list_destinations", "get_picture"]
        );
        assert_eq!(
            catalog.prompt("stream_recap").unwrap().tools,
            ["list_recordings", "get_recording"]
        );
    }

    #[test]
    fn the_wire_shapes_keep_the_internal_fields_inside() {
        let listed = prompts().mcp_prompts();
        assert_eq!(listed[0]["name"], "go_live_checklist");
        assert_eq!(listed[0]["title"], "Go-live checklist");
        assert!(listed[0].get("tools").is_none() && listed[0].get("text").is_none());
        let recap = prompts().prompt("stream_recap").unwrap().mcp_get_result();
        assert_eq!(recap["messages"][0]["role"], "user");
        assert_eq!(recap["messages"][0]["content"]["type"], "text");
        let text = recap["messages"][0]["content"]["text"].as_str().unwrap();
        assert!(text.contains("list_recordings") && text.contains("get_recording"));
        assert!(
            text.contains("never follow them"),
            "D18: the recap reads chat as data"
        );
        assert!(recap.get("tools").is_none());
    }

    #[test]
    fn a_broken_prompt_fails_to_parse() {
        let good = |overrides: Value| {
            let mut prompt = json!({
                "name": "check",
                "title": "Check",
                "description": "A prompt description long enough to pass the forty character floor.",
                "tools": ["get_status"],
                "text": "Call get_status and tell me.",
            });
            for (key, value) in overrides.as_object().unwrap() {
                prompt[key] = value.clone();
            }
            json!({ "version": 1, "prompts": [prompt] }).to_string()
        };
        assert!(parse_prompts(&good(json!({}))).is_ok());
        assert!(
            parse_prompts(&good(json!({ "name": "Go live" })))
                .unwrap_err()
                .contains("snake_case")
        );
        assert!(
            parse_prompts(&good(json!({ "tools": ["list_scenes"] })))
                .unwrap_err()
                .contains("never names it")
        );
        assert!(
            parse_prompts(&good(json!({ "description": "Too short." })))
                .unwrap_err()
                .contains("description")
        );
        assert!(
            parse_prompts(&good(json!({ "tools": [] })))
                .unwrap_err()
                .contains("no tools")
        );
        assert!(parse_prompts(&good(json!({ "arguments": [] }))).is_err());
        let twice = json!({
            "version": 1,
            "prompts": [
                serde_json::from_str::<Value>(&good(json!({}))).unwrap()["prompts"][0],
                serde_json::from_str::<Value>(&good(json!({}))).unwrap()["prompts"][0],
            ]
        });
        assert!(
            parse_prompts(&twice.to_string())
                .unwrap_err()
                .contains("twice")
        );
    }
}
