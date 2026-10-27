//! `tools/call` (plan 209 S3): one agent call, from the catalog to a result.
//!
//! Every call is checked against the tool's input schema, admitted by the
//! agent's rate family, logged to Activity, and then either run in the
//! backend through the same Rust function its RPC calls, or relayed to the
//! Studio as an `agent.intent` event that the renderer's action executor
//! answers with `agent.intent.ack`. Results are a short text line plus
//! `structuredContent`; refusals are results with `isError: true` and the
//! app's own sentence, never a protocol error (an agent reads the sentence).

use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

use rmcp::model::{CallToolRequestParams, CallToolResult, ContentBlock};
use serde_json::{Value, json};

use crate::agent_mcp::{self, AgentIntentAck, GO_LIVE_INTENT_TIMEOUT, STUDIO_INTENT_TIMEOUT};
use crate::agent_registry::AgentIdentity;
use crate::agent_tools::{self, AgentTool, AgentToolRunsIn};
use crate::state::AppState;
use crate::storage::AgentActivityOutcome;

pub const STUDIO_CLOSED: &str = "Videorc's Studio isn't open.";
pub const STUDIO_TIMEOUT: &str = "Videorc's Studio didn't answer in time.";
pub const STUDIO_GONE: &str = "Videorc's Studio went away before answering.";
pub const DONE: &str = "Done.";
/// The Activity list's argument summary stays short.
const SUMMARY_MAX_CHARS: usize = 160;

/// What a tool did, in the agent's words and the Activity list's.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolOutcome {
    pub outcome: AgentActivityOutcome,
    pub text: String,
    pub structured: Option<Value>,
}

impl ToolOutcome {
    pub fn ok(text: impl Into<String>, structured: Option<Value>) -> Self {
        Self {
            outcome: AgentActivityOutcome::Ok,
            text: text.into(),
            structured,
        }
    }

    pub fn refused(text: impl Into<String>) -> Self {
        Self {
            outcome: AgentActivityOutcome::Refused,
            text: text.into(),
            structured: None,
        }
    }

    pub fn failed(text: impl Into<String>) -> Self {
        Self {
            outcome: AgentActivityOutcome::Failed,
            text: text.into(),
            structured: None,
        }
    }

    pub fn timeout(text: impl Into<String>) -> Self {
        Self {
            outcome: AgentActivityOutcome::Timeout,
            text: text.into(),
            structured: None,
        }
    }

    pub fn into_result(self) -> CallToolResult {
        let content = vec![ContentBlock::text(self.text)];
        let mut result = if self.outcome == AgentActivityOutcome::Ok {
            CallToolResult::success(content)
        } else {
            CallToolResult::error(content)
        };
        result.structured_content = self.structured;
        result
    }
}

/// A backend tool's executor: the same Rust function its RPC calls.
pub type BackendExecutor = for<'a> fn(
    &'a AppState,
    &'a AgentIdentity,
    Value,
) -> Pin<Box<dyn Future<Output = ToolOutcome> + Send + 'a>>;

/// The backend executors by tool name. Adding a backend tool to the catalog
/// means adding its arm here; a test holds the two lists together.
pub fn backend_executor(name: &str) -> Option<BackendExecutor> {
    match name {
        "add_marker" => Some(|state, agent, args| Box::pin(add_marker(state, agent, args))),
        "set_banner" => Some(|state, agent, args| Box::pin(set_banner(state, agent, args))),
        _ => None,
    }
}

/// One `tools/call`, start to finish, with its Activity row.
pub async fn call_tool(
    state: &AppState,
    agent: &AgentIdentity,
    request: CallToolRequestParams,
) -> CallToolResult {
    agent_mcp::touch_agent(state, agent);
    let name = request.name.to_string();
    let arguments = request
        .arguments
        .map(Value::Object)
        .unwrap_or_else(|| json!({}));
    let summary = summarize_arguments(&arguments);
    let outcome = match agent_tools::catalog().tool(&name) {
        Some(tool) => run_tool(state, agent, tool, arguments).await,
        None => ToolOutcome::refused(format!(
            "Videorc has no tool named `{name}`. Call tools/list for the tools it has."
        )),
    };
    agent_mcp::log_activity(
        state,
        agent,
        &name,
        summary,
        outcome.outcome,
        Some(outcome.text.clone()),
    );
    outcome.into_result()
}

/// Validate, admit, run. Pure in its inputs; the Activity row is the caller's.
pub async fn run_tool(
    state: &AppState,
    agent: &AgentIdentity,
    tool: &AgentTool,
    arguments: Value,
) -> ToolOutcome {
    if let Err(sentence) = tool.validate_arguments(&arguments) {
        return ToolOutcome::refused(sentence);
    }
    let admitted = state
        .agents
        .lock()
        .limiter
        .admit(&agent.id, tool.rate_family, Instant::now());
    if let Err(sentence) = admitted {
        return ToolOutcome::refused(sentence);
    }
    match tool.runs_in {
        AgentToolRunsIn::Backend => match backend_executor(&tool.name) {
            Some(run) => run(state, agent, arguments).await,
            None => ToolOutcome::failed(format!("Videorc can't run `{}` yet.", tool.name)),
        },
        AgentToolRunsIn::Studio => {
            let wait = if tool.name == "go_live" {
                GO_LIVE_INTENT_TIMEOUT
            } else {
                STUDIO_INTENT_TIMEOUT
            };
            relay_studio_intent(state, agent, tool, arguments, wait).await
        }
    }
}

/// A Studio tool becomes an `agent.intent` event the renderer executes
/// through the same handlers as the buttons, answered by `agent.intent.ack`.
pub async fn relay_studio_intent(
    state: &AppState,
    agent: &AgentIdentity,
    tool: &AgentTool,
    arguments: Value,
    wait: Duration,
) -> ToolOutcome {
    if !state.agents.studio_open() {
        return ToolOutcome::refused(STUDIO_CLOSED);
    }
    let (sender, receiver) = tokio::sync::oneshot::channel::<AgentIntentAck>();
    let intent_id = {
        let mut runtime = state.agents.lock();
        runtime.next_intent += 1;
        let intent_id = format!("ai-{}", runtime.next_intent);
        runtime.pending_intents.insert(intent_id.clone(), sender);
        intent_id
    };
    state.emit_event(
        "agent.intent",
        json!({
            "intentId": intent_id,
            "agentId": agent.id,
            "agentName": agent.name,
            "tool": tool.name,
            "args": arguments,
        }),
    );
    match tokio::time::timeout(wait, receiver).await {
        Ok(Ok(ack)) if ack.ok => {
            ToolOutcome::ok(ack.message.unwrap_or_else(|| DONE.to_string()), ack.result)
        }
        Ok(Ok(ack)) => ToolOutcome::refused(
            ack.message
                .unwrap_or_else(|| "Videorc couldn't do that.".to_string()),
        ),
        // The sender was dropped: the port closed (Stop) mid-call.
        Ok(Err(_)) => ToolOutcome::failed(STUDIO_GONE),
        Err(_) => {
            state.agents.lock().pending_intents.remove(&intent_id);
            ToolOutcome::timeout(STUDIO_TIMEOUT)
        }
    }
}

/// `agent.intent.ack` (renderer-only): the Studio's answer reaches the
/// waiting call. False when nothing waits for that id (late or unknown).
pub fn ack_studio_intent(state: &AppState, ack: AgentIntentAck) -> bool {
    let sender = state.agents.lock().pending_intents.remove(&ack.intent_id);
    sender.is_some_and(|sender| sender.send(ack).is_ok())
}

/// `agent.surface.publish` (renderer-only): the Studio's projection for
/// `get_status` and the `list_*` tools (S6). Deduped; returns whether it
/// changed.
pub fn publish_surface(state: &AppState, surface: Value) -> bool {
    let mut runtime = state.agents.lock();
    if runtime.surface.as_ref() == Some(&surface) {
        return false;
    }
    runtime.surface = Some(surface);
    true
}

/// A short, single-line rendering of the arguments for the Activity list.
pub fn summarize_arguments(arguments: &Value) -> String {
    let text = match arguments {
        Value::Object(fields) if fields.is_empty() => String::new(),
        other => other.to_string(),
    };
    if text.chars().count() <= SUMMARY_MAX_CHARS {
        return text;
    }
    let mut cut: String = text.chars().take(SUMMARY_MAX_CHARS - 1).collect();
    cut.push('…');
    cut
}

fn clock(seconds: f64) -> String {
    let whole = seconds.max(0.0).round() as u64;
    format!("{}:{:02}", whole / 60, whole % 60)
}

// ---------------------------------------------------------------------------
// Backend executors
// ---------------------------------------------------------------------------

async fn add_marker(state: &AppState, _agent: &AgentIdentity, args: Value) -> ToolOutcome {
    let title = args
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_string);
    let session_id = state
        .recording
        .lock()
        .await
        .as_ref()
        .map(|active| active.session_id.clone());
    let Some(session_id) = session_id else {
        return ToolOutcome::refused("Start a recording or livestream before making a marker.");
    };
    let params = crate::session_markers::CreateMarkerParams {
        operation_id: uuid::Uuid::new_v4().to_string(),
        session_id,
        label: title,
    };
    match crate::session_markers::create_manual(state, params).await {
        Ok(marker) => {
            let text = match &marker.label {
                Some(label) => format!("Marker \"{label}\" added at {}.", clock(marker.at_seconds)),
                None => format!("Marker added at {}.", clock(marker.at_seconds)),
            };
            let mut structured = json!({
                "markerId": marker.id,
                "sessionId": marker.session_id,
                "atSeconds": marker.at_seconds,
            });
            if let Some(label) = marker.label {
                structured["title"] = Value::String(label);
            }
            ToolOutcome::ok(text, Some(structured))
        }
        Err(error) => ToolOutcome::refused(error.to_string()),
    }
}

fn banners_projection(banners: &[crate::protocol::Banner]) -> Value {
    json!({
        "banners": banners
            .iter()
            .map(|banner| json!({ "id": banner.id, "name": banner.name, "shown": banner.shown }))
            .collect::<Vec<_>>()
    })
}

fn banner_sentence(error: anyhow::Error) -> String {
    let text = error.to_string();
    if text == "Banner not found." {
        "That banner isn't available anymore.".to_string()
    } else {
        text
    }
}

async fn set_banner(state: &AppState, _agent: &AgentIdentity, args: Value) -> ToolOutcome {
    let shown = args.get("shown").and_then(Value::as_bool).unwrap_or(false);
    let banner_id = args.get("bannerId").and_then(Value::as_str);
    if shown {
        let Some(banner_id) = banner_id else {
            return ToolOutcome::refused("Say which banner to show: bannerId.");
        };
        return match crate::banners::show_banner_and_publish(state, banner_id).await {
            Ok(banner) => match state.database.list_banners() {
                Ok(banners) => ToolOutcome::ok(
                    format!("{} is showing.", banner.name),
                    Some(banners_projection(&banners)),
                ),
                Err(error) => ToolOutcome::failed(error.to_string()),
            },
            Err(error) => ToolOutcome::refused(banner_sentence(error)),
        };
    }
    match crate::banners::hide_banners_and_publish(state, banner_id).await {
        Ok(banners) => {
            let text = match banner_id {
                Some(id) => banners
                    .iter()
                    .find(|banner| banner.id == id)
                    .map(|banner| format!("{} is hidden.", banner.name))
                    .unwrap_or_else(|| "Hidden.".to_string()),
                None => "Every banner is hidden.".to_string(),
            };
            ToolOutcome::ok(text, Some(banners_projection(&banners)))
        }
        Err(error) => ToolOutcome::refused(banner_sentence(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_mcp::test_support::{connect_agent, post, rpc, serve, test_state};
    use futures_util::{SinkExt, StreamExt};
    use std::sync::atomic::Ordering;

    #[test]
    fn every_backend_tool_has_one_executor_and_studio_tools_none() {
        for tool in &agent_tools::catalog().tools {
            assert_eq!(
                backend_executor(&tool.name).is_some(),
                tool.runs_in == AgentToolRunsIn::Backend,
                "{}",
                tool.name
            );
        }
        assert!(backend_executor("notify").is_none());
        assert!(backend_executor("fs_read").is_none());
    }

    #[tokio::test]
    async fn tools_call_runs_a_backend_tool_through_the_router() {
        let state = test_state();
        let address = serve(&state).await;
        let (agent, token) = connect_agent(&state, "Claude Code");

        // Hide-all on an empty board succeeds and projects the list.
        let answer: Value = post(
            address,
            Some(&token),
            rpc(
                1,
                "tools/call",
                json!({ "name": "set_banner", "arguments": { "shown": false } }),
            ),
        )
        .await
        .json()
        .await
        .unwrap();
        assert_eq!(answer["result"]["isError"], false, "{answer}");
        assert_eq!(
            answer["result"]["content"][0]["text"],
            "Every banner is hidden."
        );
        assert_eq!(
            answer["result"]["structuredContent"],
            json!({ "banners": [] })
        );

        // A marker with nothing running: the app's own sentence, isError.
        let answer: Value = post(
            address,
            Some(&token),
            rpc(
                2,
                "tools/call",
                json!({ "name": "add_marker", "arguments": { "title": "intro done" } }),
            ),
        )
        .await
        .json()
        .await
        .unwrap();
        assert_eq!(answer["result"]["isError"], true, "{answer}");
        assert_eq!(
            answer["result"]["content"][0]["text"],
            "Start a recording or livestream before making a marker."
        );
        assert!(
            answer.get("error").is_none(),
            "a refusal is never a protocol error"
        );

        // Arguments are checked against the schema before anything runs.
        let answer: Value = post(
            address,
            Some(&token),
            rpc(
                3,
                "tools/call",
                json!({ "name": "set_banner", "arguments": { "shown": "yes" } }),
            ),
        )
        .await
        .json()
        .await
        .unwrap();
        assert_eq!(answer["result"]["isError"], true);
        assert_eq!(
            answer["result"]["content"][0]["text"],
            "arguments.shown must be true or false."
        );
        let answer: Value = post(
            address,
            Some(&token),
            rpc(
                4,
                "tools/call",
                json!({ "name": "set_banner", "arguments": { "shown": true, "bannerId": "gone" } }),
            ),
        )
        .await
        .json()
        .await
        .unwrap();
        assert_eq!(
            answer["result"]["content"][0]["text"],
            "That banner isn't available anymore."
        );

        // An unknown tool is a refusal too.
        let answer: Value = post(
            address,
            Some(&token),
            rpc(
                5,
                "tools/call",
                json!({ "name": "fs_read", "arguments": {} }),
            ),
        )
        .await
        .json()
        .await
        .unwrap();
        assert_eq!(answer["result"]["isError"], true);
        assert!(
            answer["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("no tool named `fs_read`")
        );

        // Every call landed in Activity, newest first, with its outcome.
        let page = agent_mcp::activity(&state, agent_mcp::ActivityListParams::default()).unwrap();
        let rows: Vec<(String, AgentActivityOutcome)> = page
            .entries
            .iter()
            .map(|entry| (entry.tool.clone(), entry.outcome))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("fs_read".to_string(), AgentActivityOutcome::Refused),
                ("set_banner".to_string(), AgentActivityOutcome::Refused),
                ("set_banner".to_string(), AgentActivityOutcome::Refused),
                ("add_marker".to_string(), AgentActivityOutcome::Refused),
                ("set_banner".to_string(), AgentActivityOutcome::Ok),
            ]
        );
        assert_eq!(page.entries[4].summary, "{\"shown\":false}");
        assert_eq!(page.entries[4].agent_id, agent.id);
        assert!(agent_mcp::status(&state).agents[0].connected);
    }

    #[tokio::test]
    async fn a_studio_tool_is_relayed_to_the_renderer_and_acked() {
        let state = test_state();
        let address = serve(&state).await;
        let (_, token) = connect_agent(&state, "Claude Desktop");

        // No Studio attached: the sentence, no event.
        let answer: Value = post(
            address,
            Some(&token),
            rpc(
                1,
                "tools/call",
                json!({ "name": "notify", "arguments": { "message": "hi" } }),
            ),
        )
        .await
        .json()
        .await
        .unwrap();
        assert_eq!(answer["result"]["isError"], true);
        assert_eq!(answer["result"]["content"][0]["text"], STUDIO_CLOSED);

        // A renderer socket on the real /ws handler.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_address = listener.local_addr().unwrap();
        let app = axum::Router::new()
            .route("/ws", axum::routing::get(crate::ws_handler))
            .with_state(state.clone());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let (mut socket, _) =
            tokio_tungstenite::connect_async(format!("ws://{ws_address}/ws?token={}", state.token))
                .await
                .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while state.agents.renderer_sockets.load(Ordering::Relaxed) == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the renderer socket is counted");

        // The fake Studio: answer the intent through the renderer-only RPC.
        let studio = tokio::spawn(async move {
            let mut seen = None;
            while let Some(Ok(message)) = socket.next().await {
                let Ok(text) = message.to_text() else {
                    continue;
                };
                let value: Value = serde_json::from_str(text).unwrap_or(Value::Null);
                if value["event"] == "agent.intent" {
                    let payload = value["payload"].clone();
                    let ack = json!({
                        "id": "ack",
                        "method": "agent.intent.ack",
                        "params": {
                            "intentId": payload["intentId"],
                            "ok": true,
                            "message": format!("Shown: {}", payload["args"]["message"].as_str().unwrap()),
                            "result": { "shown": true }
                        }
                    });
                    socket
                        .send(tokio_tungstenite::tungstenite::Message::Text(
                            ack.to_string().into(),
                        ))
                        .await
                        .unwrap();
                    seen = Some(payload);
                }
                if value["id"] == "ack" {
                    assert_eq!(value["ok"], true, "{value}");
                    break;
                }
            }
            seen.expect("the renderer saw the intent")
        });

        let answer: Value = post(
            address,
            Some(&token),
            rpc(
                2,
                "tools/call",
                json!({ "name": "notify", "arguments": { "message": "the sponsor banner is up" } }),
            ),
        )
        .await
        .json()
        .await
        .unwrap();
        assert_eq!(answer["result"]["isError"], false, "{answer}");
        assert_eq!(
            answer["result"]["content"][0]["text"],
            "Shown: the sponsor banner is up"
        );
        assert_eq!(
            answer["result"]["structuredContent"],
            json!({ "shown": true })
        );
        let intent = tokio::time::timeout(Duration::from_secs(5), studio)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(intent["agentName"], "Claude Desktop");
        assert_eq!(intent["tool"], "notify");
        assert_eq!(
            intent["args"],
            json!({ "message": "the sponsor banner is up" })
        );
        assert!(intent["intentId"].as_str().unwrap().starts_with("ai-"));
        assert!(state.agents.lock().pending_intents.is_empty());
        let page = agent_mcp::activity(&state, agent_mcp::ActivityListParams::default()).unwrap();
        assert_eq!(page.entries[0].outcome, AgentActivityOutcome::Ok);
        assert_eq!(
            page.entries[0].message.as_deref(),
            Some("Shown: the sponsor banner is up")
        );
    }

    #[tokio::test]
    async fn an_unanswered_intent_times_out_and_a_refusal_keeps_the_sentence() {
        let state = test_state();
        let (agent, _) = connect_agent(&state, "Cursor");
        let tool = agent_tools::catalog().tool("notify").unwrap().clone();
        state
            .agents
            .renderer_sockets
            .fetch_add(1, Ordering::Relaxed);
        let outcome = relay_studio_intent(
            &state,
            &agent,
            &tool,
            json!({ "message": "x" }),
            Duration::from_millis(50),
        )
        .await;
        assert_eq!(outcome, ToolOutcome::timeout(STUDIO_TIMEOUT));
        assert!(state.agents.lock().pending_intents.is_empty());
        assert!(!ack_studio_intent(
            &state,
            AgentIntentAck {
                intent_id: "ai-1".to_string(),
                ok: true,
                message: None,
                result: None
            }
        ));

        // A refusal from the Studio keeps its sentence.
        let state_for_ack = state.clone();
        let answer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let intent_id = state_for_ack
                .agents
                .lock()
                .pending_intents
                .keys()
                .next()
                .cloned()
                .unwrap();
            ack_studio_intent(
                &state_for_ack,
                AgentIntentAck {
                    intent_id,
                    ok: false,
                    message: Some("Pick a screen or a camera first.".to_string()),
                    result: None,
                },
            )
        });
        let outcome = relay_studio_intent(
            &state,
            &agent,
            &tool,
            json!({ "message": "x" }),
            Duration::from_secs(5),
        )
        .await;
        assert!(answer.await.unwrap());
        assert_eq!(
            outcome,
            ToolOutcome::refused("Pick a screen or a camera first.")
        );
        let result = outcome.into_result();
        assert_eq!(result.is_error, Some(true));
    }

    #[test]
    fn surface_publish_dedupes_and_summaries_stay_short() {
        let state = test_state();
        assert!(publish_surface(&state, json!({ "scenes": [] })));
        assert!(!publish_surface(&state, json!({ "scenes": [] })));
        assert!(publish_surface(&state, json!({ "scenes": ["a"] })));
        assert_eq!(summarize_arguments(&json!({})), "");
        assert_eq!(summarize_arguments(&json!({ "a": 1 })), "{\"a\":1}");
        let long = summarize_arguments(&json!({ "message": "x".repeat(500) }));
        assert_eq!(long.chars().count(), SUMMARY_MAX_CHARS);
        assert!(long.ends_with('…'));
        assert_eq!(clock(0.0), "0:00");
        assert_eq!(clock(125.4), "2:05");
    }
}
