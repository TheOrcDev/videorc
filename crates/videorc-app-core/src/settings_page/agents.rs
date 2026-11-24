//! Settings → Remote → Agents and Connect an agent… (plan 220 S3.11c):
//! `components/settings/agents-section.tsx`, `connect-agent-dialog.tsx`,
//! `lib/agents-view.ts`, `lib/agent-connect-lines.ts` and
//! `shared/agent-config-entry.ts`, as values the app shows.
//!
//! The backend runs the agents (`agents.status`, `.enable`, `.disable`,
//! `.create`, `.remove`, `agents.activity.list` and the `agents.status` and
//! `agents.activity` events). "Add to …" writes the app's own config file;
//! in Electron main does it (`main/agent-config-install.ts`, with the
//! bridge's `prepareBridge`), and the GPUI app's desktop layer will (plan 260
//! S2.6a), from the same entry ([`connect_line`] and
//! `protocol-fixtures/agent-config-entries.json`). The token an agent gets lives
//! only in the dialog, once: never in a store, drawn masked until Show
//! token, since Settings may be on stream.

use std::sync::OnceLock;

use chrono::{DateTime, Local, Utc};
use serde::Deserialize;
use serde_json::Value;

/// The page's and the dialog's words.
pub mod copy {
    pub const AGENTS: &str = "Agents";
    /// `AGENTS_SWITCH_LABEL`.
    pub const SWITCH_LABEL: &str = "Let AI agents control Videorc";
    /// `AGENTS_HELP`.
    pub const HELP: &str = "Agents on this computer can run everything in Videorc: scenes, sounds, recording, going live, chat and your Library.";
    /// `AGENTS_OFF_HINT`.
    pub const OFF_HINT: &str =
        "Turn this on, then connect Claude, Cursor, Codex or another AI app on this computer.";
    pub const OFF_WITH_AGENTS: &str =
        "Agents is off. Your agents connect again when you turn it on.";
    /// `AGENTS_PORTS_BUSY`.
    pub const PORTS_BUSY: &str = "Ports 7440 to 7449 are all in use, so agents can't reach Videorc. Quit the app using them, then turn this off and on again.";
    /// `AGENTS_BIND_FAILED`.
    pub const BIND_FAILED: &str = "Videorc couldn't open a port for agents, so they can't reach it. Turn this off and on again, or restart Videorc.";
    /// `AGENT_BRIDGE_MISSING`.
    pub const BRIDGE_MISSING: &str = "This copy of Videorc is missing its agent bridge, so agents can't connect. Reinstall Videorc, then try again.";
    /// `CONNECT_AGENT_COMMAND`.
    pub const CONNECT_COMMAND: &str = "Connect an agent…";
    pub const AGENT_APPS: &str = "Agent apps";
    pub const YOUR_AGENTS: &str = "Your agents";
    pub const ACTIVITY: &str = "Activity";
    pub const ALL_AGENTS: &str = "All agents";
    pub const ACTIVITY_FROM: &str = "Activity from";
    pub const AGENT_ACTIVITY: &str = "Agent activity";
    pub const NO_ACTIONS: &str = "No actions yet.";
    pub const LOADING_ACTIVITY: &str = "Loading activity…";
    pub const CONNECTED: &str = "Connected";
    pub const REMOVE_MENU: &str = "Remove…";
    pub const REMOVE_CONFIRM: &str = "Remove agent";
    pub const REMOVE_DESCRIPTION: &str = "Its token stops working at once, so the app can't reach Videorc. Connect it again for a new token.";
    pub const NEVER_USED: &str = "Never used";
    pub const LAST_SEEN: &str = "Last seen";

    pub const CONNECT_TITLE: &str = "Connect an agent";
    pub const CONNECT_DESCRIPTION: &str =
        "Choose the app and name it. Videorc then shows the line to paste into that app.";
    pub const APP: &str = "App";
    pub const NAME: &str = "Name";
    pub const NAME_DESCRIPTION: &str = "Activity and the Studio show it by this name.";
    pub const NAME_DESCRIPTION_OFF: &str =
        "Activity and the Studio show it by this name. Connecting turns Agents on.";
    pub const CANCEL: &str = "Cancel";
    pub const CONNECT: &str = "Connect";
    pub const CONNECTING: &str = "Connecting…";
    pub const SHOWN_ONCE: &str = "Shown once";
    pub const SHOW_TOKEN: &str = "Show token";
    pub const HIDE_TOKEN: &str = "Hide token";
    pub const COPY: &str = "Copy";
    pub const COPIED: &str = "Copied";
    pub const COPY_FAILED: &str = "Couldn't copy the line.";
    pub const TOKEN_NOTE: &str = "The line holds this agent's token, and Videorc shows it only now. Lost it? Remove the agent and connect it again.";
    pub const ADDING: &str = "Adding…";
    pub const DONE: &str = "Done";
    /// `AGENT_BRIDGE_MOVE_FIRST`.
    pub const MOVE_FIRST: &str = "Move Videorc to Applications first.";
    /// `AGENT_BRIDGE_MOVE_FIRST_DETAIL`.
    pub const MOVE_FIRST_DETAIL: &str = "Videorc is running from a disk image or a temporary copy, so an agent's line would stop working. Open it from Applications, then connect.";

    /// `Remove ${name ?? 'this agent'}?`.
    pub fn remove_title(name: Option<&str>) -> String {
        format!("Remove {}?", name.unwrap_or("this agent"))
    }

    /// `More actions for ${agent.name}`.
    pub fn more_actions(name: &str) -> String {
        format!("More actions for {name}")
    }

    /// `Connect ${name}`.
    pub fn connect_named(name: &str) -> String {
        format!("Connect {name}")
    }

    /// `Add to ${appLabel}`.
    pub fn add_to(app: &str) -> String {
        format!("Add to {app}")
    }

    /// The failure "Add to …" says when the config could not be written.
    pub fn add_failed(app: &str) -> String {
        format!("Couldn't add Videorc to {app}. Copy the line instead.")
    }

    /// "Claude Desktop connected", "2 agents connected".
    pub fn connected_count(count: usize) -> String {
        format!("{count} connected right now.")
    }
}

/// `agents.status`'s agent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub connected: bool,
    #[serde(default)]
    pub last_action: Option<LastAction>,
    #[serde(default)]
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastAction {
    pub tool: String,
    pub at: String,
}

/// `AgentsStatus`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsStatus {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub bind_error_kind: Option<String>,
    #[serde(default)]
    pub agents: Vec<AgentSummary>,
}

/// `AgentActivityEntry`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub id: String,
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub agent_name: String,
    #[serde(default)]
    pub tool: String,
    #[serde(default)]
    pub outcome: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub at: String,
}

/// `AGENT_ACTIVITY_ROWS`.
pub const ACTIVITY_ROWS: usize = 100;

/// `withLastAction`: the agent's row learns its last action from the event.
pub fn with_last_action(status: &mut AgentsStatus, entry: &ActivityEntry) {
    for agent in &mut status.agents {
        if agent.id == entry.agent_id {
            agent.last_action = Some(LastAction {
                tool: entry.tool.clone(),
                at: entry.at.clone(),
            });
        }
    }
}

/// The catalog's titles (`protocol-fixtures/agent-tools.json`).
fn tool_titles() -> &'static Vec<(String, String)> {
    static TITLES: OnceLock<Vec<(String, String)>> = OnceLock::new();
    TITLES.get_or_init(|| {
        let catalog: Value = serde_json::from_str(include_str!(
            "../../../../protocol-fixtures/agent-tools.json"
        ))
        .unwrap_or(Value::Null);
        catalog
            .get("tools")
            .and_then(Value::as_array)
            .map(|tools| {
                tools
                    .iter()
                    .filter_map(|tool| {
                        Some((
                            tool.get("name")?.as_str()?.to_string(),
                            tool.get("title")?.as_str()?.to_string(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default()
    })
}

/// `agentToolTitle`: the catalog's title, else the tool's name.
pub fn tool_title(name: &str) -> String {
    tool_titles()
        .iter()
        .find(|(tool, _)| tool == name)
        .map(|(_, title)| title.clone())
        .unwrap_or_else(|| name.to_string())
}

/// `agentsBindErrorCopy`.
pub fn bind_error_copy(kind: &str) -> &'static str {
    if kind == "ports-busy" {
        copy::PORTS_BUSY
    } else {
        copy::BIND_FAILED
    }
}

/// `connectedAgents`.
fn connected(status: &AgentsStatus) -> usize {
    if !status.enabled {
        return 0;
    }
    status.agents.iter().filter(|agent| agent.connected).count()
}

/// `agentsSummaryLine`: the apps it works with, or how many are connected.
pub fn summary_line(status: &AgentsStatus) -> String {
    if status.agents.is_empty() {
        return "Claude Desktop, Claude Code, Cursor, Codex, VS Code or another AI app on this computer.".to_string();
    }
    match connected(status) {
        0 => "None connected right now.".to_string(),
        count => copy::connected_count(count),
    }
}

/// `agentLastActionView`: what and when.
pub fn last_action(agent: &AgentSummary, now: DateTime<Utc>) -> (String, Option<String>) {
    if let Some(action) = &agent.last_action {
        return (
            tool_title(&action.tool),
            Some(crate::format::format_relative_time(&action.at, now)),
        );
    }
    if let Some(at) = &agent.last_used_at {
        return (
            copy::LAST_SEEN.to_string(),
            Some(crate::format::format_relative_time(at, now)),
        );
    }
    (copy::NEVER_USED.to_string(), None)
}

/// `agentOutcomeView`: the word and its dot's tone.
pub fn outcome_view(outcome: &str) -> (&'static str, &'static str) {
    match outcome {
        "refused" => ("Refused", "warn"),
        "failed" => ("Failed", "error"),
        "timeout" => ("Timed out", "error"),
        _ => ("Done", "neutral"),
    }
}

/// `activityArgumentsLabel`: the call's JSON read back as "key: value".
pub fn activity_arguments_label(summary: &str) -> String {
    let trimmed = summary.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(trimmed) {
        return map
            .iter()
            .map(|(key, value)| match value {
                Value::String(text) => format!("{key}: {text}"),
                other => format!("{key}: {other}"),
            })
            .collect::<Vec<_>>()
            .join(", ");
    }
    trimmed.to_string()
}

/// `activityTimeLabel`: the clock today, the day and time before.
pub fn activity_time_label(at: &str, now: DateTime<Utc>) -> String {
    let Ok(when) = DateTime::parse_from_rfc3339(at) else {
        return String::new();
    };
    let when = when.with_timezone(&Local);
    if when.date_naive() == now.with_timezone(&Local).date_naive() {
        crate::format::compact_time(at)
    } else {
        when.format("%b %-d, %H:%M").to_string()
    }
}

/// The activity row's line under its title: the arguments when it ran, the
/// reason when it didn't.
pub fn activity_detail(entry: &ActivityEntry) -> String {
    if entry.outcome == "ok" {
        activity_arguments_label(&entry.summary)
    } else {
        entry.message.clone().unwrap_or_default()
    }
}

/// `agentRefusalMessage`: the backend's own sentence when it is copy.
pub fn refusal_message(code: Option<&str>, message: &str) -> Option<String> {
    if code != Some("agents") {
        return None;
    }
    // "Couldn't save the agent: <os error>" carries raw text: not copy.
    (!message.contains(": ")).then(|| message.to_string())
}

// --- Connect --------------------------------------------------------------------

/// `AGENT_APPS`: the picker's apps, in order.
pub const AGENT_APPS: [(&str, &str); 6] = [
    ("claude-desktop", "Claude Desktop"),
    ("claude-code", "Claude Code"),
    ("cursor", "Cursor"),
    ("codex", "Codex"),
    ("vs-code", "VS Code"),
    ("other", "Other"),
];

/// `agentAppLabel`.
pub fn app_label(client: &str) -> &'static str {
    AGENT_APPS
        .iter()
        .find(|(id, _)| *id == client)
        .map(|(_, label)| *label)
        .unwrap_or("Other")
}

/// `defaultAgentName`.
pub fn default_agent_name(client: &str) -> &'static str {
    if client == "other" {
        "My agent"
    } else {
        app_label(client)
    }
}

/// `AGENT_NAME_MAX_CHARS`: the backend keeps 40 characters of a name.
pub const AGENT_NAME_MAX_CHARS: usize = 40;

/// `AGENT_SERVER_NAME`.
pub const SERVER_NAME: &str = "videorc";
/// `AGENT_TOKEN_ENV`.
pub const TOKEN_ENV: &str = "VIDEORC_AGENT_TOKEN";

/// `AgentConnectLine`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectLine {
    pub label: &'static str,
    pub where_: &'static str,
    pub text: String,
}

fn json_text(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// `JSON.stringify({[root]: {videorc: entry}}, null, 2)`, in the entry's
/// own key order.
fn json_config(app: &str, bridge: &str, token: &str) -> String {
    let root = if app == "vs-code" {
        "servers"
    } else {
        "mcpServers"
    };
    let kind = if app == "vs-code" {
        "      \"type\": \"stdio\",\n"
    } else {
        ""
    };
    format!(
        "{{\n  \"{root}\": {{\n    \"{SERVER_NAME}\": {{\n{kind}      \"command\": {},\n      \"args\": [],\n      \"env\": {{\n        \"{TOKEN_ENV}\": {}\n      }}\n    }}\n  }}\n}}",
        json_text(bridge),
        json_text(token)
    )
}

/// `tomlString`.
pub fn toml_string(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                out.push_str(&format!("\\u{:04x}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `isWindowsPath`.
fn is_windows_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/'))
        || path.starts_with("\\\\")
}

/// `shellArgument`.
fn shell_argument(value: &str, windows: bool) -> String {
    let plain = !value.is_empty()
        && value.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(
                    c,
                    '_' | '@' | '%' | '+' | '=' | ':' | ',' | '.' | '/' | '\\' | '-'
                )
        })
        && !(!windows && value.contains('\\'));
    if plain {
        return value.to_string();
    }
    if windows {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

/// `agentConnectLine`: the config for `client`, with the bridge's path and
/// the agent's token.
pub fn connect_line(client: &str, bridge: &str, token: &str) -> ConnectLine {
    match client {
        "claude-desktop" => ConnectLine {
            label: "claude_desktop_config.json",
            where_: "In Claude Desktop, open Settings → Developer → Edit Config. Add the videorc entry to mcpServers in claude_desktop_config.json, save, then quit and reopen Claude Desktop.",
            text: json_config(client, bridge, token),
        },
        "claude-code" => {
            let windows = is_windows_path(bridge);
            let assignment = format!("{TOKEN_ENV}={token}");
            let parts = [
                "claude",
                "mcp",
                "add",
                "--scope",
                "user",
                SERVER_NAME,
                "--env",
                &assignment,
                "--",
                bridge,
            ];
            ConnectLine {
                label: "Terminal",
                where_: "Run this in a terminal. Claude Code then reaches Videorc from every project.",
                text: parts
                    .iter()
                    .map(|part| shell_argument(part, windows))
                    .collect::<Vec<_>>()
                    .join(" "),
            }
        }
        "cursor" => ConnectLine {
            label: "mcp.json",
            where_: "Add the videorc entry to mcpServers in .cursor/mcp.json in your home folder (Cursor Settings → MCP), then turn videorc on there.",
            text: json_config(client, bridge, token),
        },
        "codex" => ConnectLine {
            label: "config.toml",
            where_: "Add this to config.toml in the .codex folder in your home folder, then restart Codex.",
            text: [
                format!("[mcp_servers.{SERVER_NAME}]"),
                format!("command = {}", toml_string(bridge)),
                "args = []".to_string(),
                format!("env = {{ {TOKEN_ENV} = {} }}", toml_string(token)),
            ]
            .join("\n"),
        },
        "vs-code" => ConnectLine {
            label: "mcp.json",
            where_: "In VS Code, run MCP: Open User Configuration and add the videorc entry to servers in mcp.json.",
            text: json_config(client, bridge, token),
        },
        _ => ConnectLine {
            label: "Command and variable",
            where_: "Add Videorc to your agent app as a local (stdio) MCP server: this command, with this environment variable.",
            text: {
                let assignment = format!("{TOKEN_ENV}={token}");
                [
                    format!("Command: {bridge}"),
                    format!("Environment: {assignment}"),
                ]
                .join("\n")
            },
        },
    }
}

/// `maskedAgentToken`.
pub fn masked_token(token: &str) -> String {
    let prefix = if token.starts_with("vrc_agent_") {
        "vrc_agent_"
    } else {
        ""
    };
    format!("{prefix}{}", "•".repeat(12))
}

/// `agentConnectLineDisplay`: the token masked until shown.
pub fn line_display(line: &ConnectLine, token: &str, shown: bool) -> String {
    if shown || token.is_empty() {
        line.text.clone()
    } else {
        line.text.replace(token, &masked_token(token))
    }
}

/// `agentBridgeRunsFromTemporaryCopy`: a disk image or macOS's per-launch
/// AppTranslocation copy.
pub fn runs_from_temporary_copy(path: &str) -> bool {
    if path.contains("/AppTranslocation/") {
        return true;
    }
    // `^/Volumes/[^/]+/[^/]+\.app/`
    let Some(rest) = path.strip_prefix("/Volumes/") else {
        return false;
    };
    let mut parts = rest.splitn(3, '/');
    let (Some(volume), Some(app), Some(_)) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !volume.is_empty() && app.len() > 4 && app.ends_with(".app")
}

/// `agentBridgePathRefusal`.
pub fn bridge_path_refusal(path: &str) -> Option<&'static str> {
    runs_from_temporary_copy(path).then_some(copy::MOVE_FIRST)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FIXTURE: &str = include_str!("../../../../protocol-fixtures/agent-config-entries.json");

    #[test]
    fn the_lines_match_the_pinned_entries() {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let bridge = case["bridgePath"].as_str().unwrap();
            let token = case["token"].as_str().unwrap();
            assert_eq!(
                runs_from_temporary_copy(bridge),
                case["temporaryCopy"].as_bool().unwrap(),
                "{bridge}"
            );
            for app in ["claude-desktop", "cursor", "vs-code"] {
                let text = connect_line(app, bridge, token).text;
                let parsed: Value = serde_json::from_str(&text).unwrap();
                let root = case["jsonRootKey"][app].as_str().unwrap();
                assert_eq!(parsed[root][SERVER_NAME], case["json"][app], "{app}");
            }
            if let Some(lines) = case.get("codexTomlLines").and_then(Value::as_array) {
                let want: Vec<&str> = lines.iter().map(|l| l.as_str().unwrap()).collect();
                assert_eq!(connect_line("codex", bridge, token).text, want.join("\n"));
            }
        }
    }

    #[test]
    fn json_keeps_electrons_key_order_and_the_token_hides() {
        let line = connect_line("vs-code", "/b/videorc-mcp", "vrc_agent_ab");
        assert_eq!(
            line.text,
            "{\n  \"servers\": {\n    \"videorc\": {\n      \"type\": \"stdio\",\n      \"command\": \"/b/videorc-mcp\",\n      \"args\": [],\n      \"env\": {\n        \"VIDEORC_AGENT_TOKEN\": \"vrc_agent_ab\"\n      }\n    }\n  }\n}"
        );
        assert_eq!(
            line_display(&line, "vrc_agent_ab", false)
                .matches("vrc_agent_••••••••••••")
                .count(),
            1
        );
        let code = connect_line(
            "claude-code",
            "/Users/me/My Apps/videorc-mcp",
            "vrc_agent_ab",
        );
        assert_eq!(
            code.text,
            "claude mcp add --scope user videorc --env VIDEORC_AGENT_TOKEN=vrc_agent_ab -- '/Users/me/My Apps/videorc-mcp'"
        );
        let windows = connect_line("claude-code", "C:\\Videorc\\videorc-mcp.exe", "t");
        assert!(windows.text.ends_with(" -- C:\\Videorc\\videorc-mcp.exe"));
        assert_eq!(
            connect_line("other", "/b", "t").text,
            "Command: /b\nEnvironment: VIDEORC_AGENT_TOKEN=t"
        );
        assert_eq!(default_agent_name("other"), "My agent");
        assert_eq!(default_agent_name("cursor"), "Cursor");
        assert_eq!(
            bridge_path_refusal("/Volumes/Videorc/Videorc.app/Contents/Resources/videorc-mcp"),
            Some(copy::MOVE_FIRST)
        );
        assert_eq!(
            bridge_path_refusal("/Volumes/SSD/Applications/Videorc.app/x"),
            None
        );
    }

    #[test]
    fn the_rows_read_as_the_section_says_them() {
        let status: AgentsStatus = serde_json::from_value(json!({
            "enabled": true,
            "agents": [
                {"id": "a", "name": "Claude Desktop", "connected": true,
                 "lastAction": {"tool": "nope.unknown", "at": "2026-11-12T11:56:00Z"}},
                {"id": "b", "name": "Cursor", "connected": false},
            ],
        }))
        .unwrap();
        assert_eq!(summary_line(&status), "1 connected right now.");
        let now = DateTime::parse_from_rfc3339("2026-11-12T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            last_action(&status.agents[0], now),
            ("nope.unknown".to_string(), Some("4m".to_string()))
        );
        assert_eq!(
            last_action(&status.agents[1], now),
            ("Never used".to_string(), None)
        );
        assert_eq!(
            summary_line(&AgentsStatus::default()),
            "Claude Desktop, Claude Code, Cursor, Codex, VS Code or another AI app on this computer."
        );
        assert_eq!(outcome_view("timeout"), ("Timed out", "error"));
        assert_eq!(
            activity_arguments_label("{\"bannerId\":\"sponsor\",\"shown\":false}"),
            "bannerId: sponsor, shown: false"
        );
        assert_eq!(activity_arguments_label("{\"clipped"), "{\"clipped");
        assert_eq!(
            refusal_message(Some("agents"), "Name the agent first."),
            Some("Name the agent first.".into())
        );
        assert_eq!(
            refusal_message(Some("agents"), "Couldn't save the agent: disk"),
            None
        );
        assert!(!tool_titles().is_empty(), "the catalog's titles");
        let first = &tool_titles()[0];
        assert_eq!(tool_title(&first.0), first.1);
    }
}
