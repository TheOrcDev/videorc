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
    /// MCP image content after the text (`get_picture`): base64 and its
    /// MIME type.
    pub image: Option<(String, String)>,
    /// A Studio call that ended before the Studio answered (a timeout, or
    /// Stop closing the port): its intent id, so the caller hands its
    /// Activity row to `attach_activity_row` for a late ack. Never on the
    /// wire.
    pub unanswered_intent: Option<String>,
}

impl ToolOutcome {
    pub fn ok(text: impl Into<String>, structured: Option<Value>) -> Self {
        Self {
            outcome: AgentActivityOutcome::Ok,
            text: text.into(),
            structured,
            image: None,
            unanswered_intent: None,
        }
    }

    pub fn refused(text: impl Into<String>) -> Self {
        Self::without_result(AgentActivityOutcome::Refused, text)
    }

    pub fn failed(text: impl Into<String>) -> Self {
        Self::without_result(AgentActivityOutcome::Failed, text)
    }

    pub fn timeout(text: impl Into<String>) -> Self {
        Self::without_result(AgentActivityOutcome::Timeout, text)
    }

    fn without_result(outcome: AgentActivityOutcome, text: impl Into<String>) -> Self {
        Self {
            outcome,
            text: text.into(),
            structured: None,
            image: None,
            unanswered_intent: None,
        }
    }

    fn unanswered(mut self, intent_id: String) -> Self {
        self.unanswered_intent = Some(intent_id);
        self
    }

    pub fn with_image(mut self, base64: String, mime_type: &str) -> Self {
        self.image = Some((base64, mime_type.to_string()));
        self
    }

    pub fn into_result(self) -> CallToolResult {
        let mut content = vec![ContentBlock::text(self.text)];
        if let Some((data, mime_type)) = self.image {
            content.push(ContentBlock::image(data, mime_type));
        }
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
    use crate::agent_look as look;
    match name {
        "get_status" => Some(|state, agent, args| Box::pin(look::get_status(state, agent, args))),
        "get_picture" => Some(|state, agent, args| Box::pin(look::get_picture(state, agent, args))),
        "list_scenes" => Some(|state, agent, args| Box::pin(look::list_scenes(state, agent, args))),
        "list_sources" => {
            Some(|state, agent, args| Box::pin(look::list_sources(state, agent, args)))
        }
        "list_assets" => Some(|state, agent, args| Box::pin(look::list_assets(state, agent, args))),
        "read_chat" => Some(|state, agent, args| Box::pin(look::read_chat(state, agent, args))),
        "list_destinations" => {
            Some(|state, agent, args| Box::pin(look::list_destinations(state, agent, args)))
        }
        "list_recordings" => {
            Some(|state, agent, args| Box::pin(look::list_recordings(state, agent, args)))
        }
        "get_recording" => {
            Some(|state, agent, args| Box::pin(look::get_recording(state, agent, args)))
        }
        "save_clip" => Some(|state, agent, args| Box::pin(look::save_clip(state, agent, args))),
        "add_marker" => Some(|state, agent, args| Box::pin(add_marker(state, agent, args))),
        "set_banner" => Some(|state, agent, args| Box::pin(set_banner(state, agent, args))),
        // PR B (plan 209 S11).
        "edit_banner" => Some(|state, agent, args| Box::pin(edit_banner(state, agent, args))),
        // Plan 209 PR B, S12 to S15 (agent_chat.rs, agent_prepare.rs,
        // agent_library.rs).
        "send_chat_message" => Some(|state, agent, args| {
            Box::pin(crate::agent_chat::send_chat_message(state, agent, args))
        }),
        "remove_chat_message" => Some(|state, agent, args| {
            Box::pin(crate::agent_chat::remove_chat_message(state, agent, args))
        }),
        "buddy_say" => {
            Some(|state, agent, args| Box::pin(crate::agent_chat::buddy_say(state, agent, args)))
        }
        "schedule_stream" => Some(|state, agent, args| {
            Box::pin(crate::agent_prepare::schedule_stream(state, agent, args))
        }),
        "rename_recording" => Some(|state, agent, args| {
            Box::pin(crate::agent_library::rename_recording(state, agent, args))
        }),
        "start_clean_cut" => Some(|state, agent, args| {
            Box::pin(crate::agent_library::start_clean_cut(state, agent, args))
        }),
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
    let tool = agent_tools::catalog().tool(&name);
    let outcome = match tool {
        Some(tool) => run_tool(state, agent, tool, arguments.clone()).await,
        None => ToolOutcome::refused(format!(
            "Videorc has no tool named `{name}`. Call tools/list for the tools it has."
        )),
    };
    // D11: a successful onAir call carries its filled notice on the
    // `agents.activity` event; the Studio shows it.
    let notice = tool
        .filter(|tool| tool.on_air && outcome.outcome == AgentActivityOutcome::Ok)
        .and_then(|tool| tool.fill_notice(&agent.name, &arguments, outcome.structured.as_ref()));
    let row = agent_mcp::log_activity(
        state,
        agent,
        &name,
        summary,
        outcome.outcome,
        Some(outcome.text.clone()),
        notice,
    );
    if let Some(intent_id) = outcome.unanswered_intent.as_deref() {
        attach_activity_row(state, intent_id, row);
    }
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
    // Review fix 1: the Studio drops an intent it hasn't started once its
    // deadline (epoch ms, this call's wait) passed or a cancel moved the
    // generation on.
    let deadline_at = chrono::Utc::now().timestamp_millis()
        + i64::try_from(wait.as_millis()).unwrap_or(i64::MAX / 2);
    let (intent_id, generation) = {
        let mut runtime = state.agents.lock();
        runtime.next_intent += 1;
        let intent_id = format!("ai-{}", runtime.next_intent);
        runtime.pending_intents.insert(
            intent_id.clone(),
            agent_mcp::PendingIntent {
                sender,
                call: agent_mcp::IntentCall {
                    agent: agent.clone(),
                    tool: tool.name.clone(),
                    arguments: arguments.clone(),
                },
            },
        );
        (intent_id, runtime.intent_generation)
    };
    state.emit_event(
        "agent.intent",
        json!({
            "intentId": intent_id,
            "agentId": agent.id,
            "agentName": agent.name,
            "tool": tool.name,
            "args": arguments,
            "deadlineAt": deadline_at,
            "generation": generation,
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
        // The sender was dropped: the port closed (Stop) mid-call. `stop`
        // kept the call as unanswered.
        Ok(Err(_)) => ToolOutcome::failed(STUDIO_GONE).unanswered(intent_id),
        Err(_) => {
            let mut runtime = state.agents.lock();
            if let Some(pending) = runtime.pending_intents.remove(&intent_id) {
                runtime.keep_unanswered(intent_id.clone(), pending.call, None);
            }
            ToolOutcome::timeout(STUDIO_TIMEOUT).unanswered(intent_id)
        }
    }
}

/// `agent.intent.ack` (renderer-only): the Studio's answer reaches the
/// waiting call. True when a waiting call took it. An ack for a call that
/// already ended (timed out, or cut by Stop) is late: if the Studio did it
/// after all, the call's Activity row says so and its notice fires (review
/// fix 1). False for a late or unknown id.
pub fn ack_studio_intent(state: &AppState, ack: AgentIntentAck) -> bool {
    let late = {
        let mut runtime = state.agents.lock();
        if let Some(pending) = runtime.pending_intents.remove(&ack.intent_id) {
            match pending.sender.send(ack) {
                Ok(()) => return true,
                // The call timed out a moment ago and its row isn't written
                // yet: keep the answer for it.
                Err(ack) => {
                    runtime.keep_unanswered(ack.intent_id.clone(), pending.call, Some(ack));
                    return false;
                }
            }
        }
        match runtime.unanswered.get_mut(&ack.intent_id) {
            None => return false,
            Some(kept) if kept.row.is_none() => {
                kept.ack = Some(ack);
                return false;
            }
            Some(_) => runtime
                .unanswered
                .remove(&ack.intent_id)
                .map(|kept| (kept, ack)),
        }
    };
    if let Some((kept, ack)) = late
        && let Some(row) = kept.row
    {
        finish_late(state, &kept.call, row, ack);
    }
    false
}

/// The Activity row of a call that ended unanswered: a late ack updates it.
/// An ack that came first is applied now.
pub fn attach_activity_row(
    state: &AppState,
    intent_id: &str,
    row: crate::storage::AgentActivityEntry,
) {
    let kept = {
        let mut runtime = state.agents.lock();
        match runtime.unanswered.get_mut(intent_id) {
            None => return,
            Some(kept) if kept.ack.is_none() => {
                kept.row = Some(row);
                return;
            }
            Some(_) => runtime.unanswered.remove(intent_id),
        }
    };
    if let Some(kept) = kept
        && let Some(ack) = kept.ack
    {
        finish_late(state, &kept.call, row, ack);
    }
}

/// The Studio did it after all: the row takes the answer's outcome and
/// sentence, and an `onAir` tool's notice fires ("Claude Desktop started the
/// livestream."). A late refusal changes nothing: the call already said why
/// it ended, and nothing happened.
fn finish_late(
    state: &AppState,
    call: &agent_mcp::IntentCall,
    mut row: crate::storage::AgentActivityEntry,
    ack: AgentIntentAck,
) {
    if !ack.ok {
        return;
    }
    let text = ack.message.unwrap_or_else(|| DONE.to_string());
    row.outcome = AgentActivityOutcome::Ok;
    row.message = Some(agent_mcp::clip_chars(
        &text,
        agent_mcp::ACTIVITY_MESSAGE_MAX_CHARS,
    ));
    if let Err(error) =
        state
            .database
            .update_agent_activity_outcome(&row.id, row.outcome, row.message.as_deref())
    {
        tracing::warn!("Could not update the agent's activity: {error:#}");
    }
    let notice = agent_tools::catalog()
        .tool(&call.tool)
        .filter(|tool| tool.on_air)
        .and_then(|tool| tool.fill_notice(&call.agent.name, &call.arguments, ack.result.as_ref()));
    agent_mcp::announce_activity(state, &row, notice);
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
    agent_mcp::clip_chars(&text, SUMMARY_MAX_CHARS)
}

pub(crate) fn clock(seconds: f64) -> String {
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
    // A session that only feeds the Clips ring (plan 181) records nothing a
    // marker could land in.
    let status = crate::current_recording_status(state).await;
    let session_id = status.session_id.filter(|_| !status.replay_only);
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

// ---------------------------------------------------------------------------
// PR B: editing banners (plan 209 S11)
// ---------------------------------------------------------------------------

/// One agent import at a time: the Studio's imports ride their socket's
/// AssetImport lane, an agent's ride this (decode and scale are heavy).
static AGENT_BANNER_IMPORT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub const EDIT_BANNER_EMPTY: &str = "Say what to do: path imports an image on this computer as a banner, bannerId with name renames one.";
pub const EDIT_BANNER_BOTH: &str =
    "Say one thing: path imports an image, bannerId with name renames a banner.";
pub const EDIT_BANNER_NAME_MISSING: &str = "Say the banner's new name: name.";
pub const EDIT_BANNER_RELATIVE: &str = "Give the image's full path on this computer.";
pub const EDIT_BANNER_NO_FILE: &str = "There's no image file at that path.";
pub const EDIT_BANNER_SAVE_FAILED: &str = "Videorc couldn't save that banner.";

/// A banner as an agent reads it (D9): never its files or where they live.
fn banner_projection(banner: &crate::protocol::Banner) -> Value {
    json!({
        "id": banner.id,
        "name": banner.name,
        "shown": banner.shown,
        "width": banner.width,
        "height": banner.height,
    })
}

/// An import's refusal in the import's own words, except that a sentence
/// naming Videorc's own Banners folder (app data, D9) is never passed on.
fn banner_import_sentence(error: &anyhow::Error, assets_dir: &std::path::Path) -> String {
    let text = error.to_string();
    let dir = assets_dir.to_string_lossy();
    if !dir.is_empty() && text.contains(dir.as_ref()) {
        EDIT_BANNER_SAVE_FAILED.to_string()
    } else {
        text
    }
}

fn text_argument<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// `edit_banner`: import an image on this computer as a banner (the
/// Assets page's Import, `banners::import_banner`), or rename one (its
/// rename, `banners.update`'s update). Banners are images; an imported one
/// is hidden until it is shown.
async fn edit_banner(state: &AppState, _agent: &AgentIdentity, args: Value) -> ToolOutcome {
    let path = text_argument(&args, "path");
    let banner_id = text_argument(&args, "bannerId");
    let name = text_argument(&args, "name");
    match (path, banner_id) {
        (Some(_), Some(_)) => ToolOutcome::refused(EDIT_BANNER_BOTH),
        (None, None) => ToolOutcome::refused(EDIT_BANNER_EMPTY),
        (Some(path), None) => {
            import_banner_image(state, std::path::PathBuf::from(path), name).await
        }
        (None, Some(banner_id)) => {
            let Some(name) = name else {
                return ToolOutcome::refused(EDIT_BANNER_NAME_MISSING);
            };
            match rename_banner(state, banner_id, name) {
                Ok(banner) => {
                    let _ = crate::banners::on_banners_changed(state).await;
                    ToolOutcome::ok(
                        format!("The banner is now called {}.", banner.name),
                        Some(json!({ "banner": banner_projection(&banner) })),
                    )
                }
                Err(error) => ToolOutcome::refused(banner_sentence(error)),
            }
        }
    }
}

fn rename_banner(
    state: &AppState,
    banner_id: &str,
    name: &str,
) -> anyhow::Result<crate::protocol::Banner> {
    let update = crate::banners::BannerUpdate {
        name: Some(crate::banners::normalize_banner_name(name)?),
        ..Default::default()
    };
    state.database.update_banner(banner_id, update)
}

async fn import_banner_image(
    state: &AppState,
    source: std::path::PathBuf,
    name: Option<&str>,
) -> ToolOutcome {
    if !source.is_absolute() {
        return ToolOutcome::refused(EDIT_BANNER_RELATIVE);
    }
    if !std::fs::metadata(&source).is_ok_and(|metadata| metadata.is_file()) {
        return ToolOutcome::refused(EDIT_BANNER_NO_FILE);
    }
    let _turn = AGENT_BANNER_IMPORT.lock().await;
    let database = state.database.clone();
    let assets_dir = database.banner_assets_dir();
    let imported =
        tokio::task::spawn_blocking(move || crate::banners::import_banner(&database, &source))
            .await
            .unwrap_or_else(|error| Err(anyhow::anyhow!("Image import worker failed: {error}")));
    let mut banner = match imported {
        Ok(banner) => banner,
        Err(error) => return ToolOutcome::refused(banner_import_sentence(&error, &assets_dir)),
    };
    if let Some(name) = name {
        match rename_banner(state, &banner.id, name) {
            Ok(renamed) => banner = renamed,
            Err(error) => {
                let _ = crate::banners::on_banners_changed(state).await;
                return ToolOutcome::refused(format!(
                    "Imported {}, but {}",
                    banner.name,
                    lowercase_first(&error.to_string())
                ));
            }
        }
    }
    let _ = crate::banners::on_banners_changed(state).await;
    ToolOutcome::ok(
        format!(
            "Imported {} as a banner. It stays hidden until it is shown.",
            banner.name
        ),
        Some(json!({ "banner": banner_projection(&banner) })),
    )
}

fn lowercase_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().chain(chars).collect(),
        None => String::new(),
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

        // The Studio's socket on the real /ws handler: it says it runs
        // agent intents.
        let ws_address = serve_ws(&state).await;
        let mut socket = open_renderer_socket(ws_address, &state.token).await;
        let answer = ws_request(&mut socket, "listen", "agent.intent.listen", json!({})).await;
        assert_eq!(answer["ok"], true, "{answer}");
        assert!(
            state.agents.studio_open(),
            "the listening socket is counted"
        );

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

        let mut events = state.events.subscribe();
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
        // D11: the onAir call's filled notice rides the activity event (and
        // never the stored row).
        let mut notices = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event.event == "agents.activity" {
                notices.push(event.payload["notice"].clone());
            }
        }
        assert_eq!(
            notices,
            vec![json!("Claude Desktop: the sponsor banner is up")]
        );
        let stored = serde_json::to_value(&page.entries[0]).unwrap();
        assert!(stored.get("notice").is_none());
    }

    type TestSocket = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    /// The real `/ws` handler on an ephemeral port.
    async fn serve_ws(state: &AppState) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new()
            .route("/ws", axum::routing::get(crate::ws_handler))
            .with_state(state.clone());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        address
    }

    /// A socket with the given token, after its `backend.ready`.
    async fn open_renderer_socket(address: std::net::SocketAddr, token: &str) -> TestSocket {
        let (mut socket, _) =
            tokio_tungstenite::connect_async(format!("ws://{address}/ws?token={token}"))
                .await
                .unwrap();
        next_matching(&mut socket, |value| value["event"] == "backend.ready").await;
        socket
    }

    async fn next_matching(socket: &mut TestSocket, wanted: impl Fn(&Value) -> bool) -> Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(Ok(message)) = socket.next().await {
                let Ok(text) = message.to_text() else {
                    continue;
                };
                let value: Value = serde_json::from_str(text).unwrap_or(Value::Null);
                if wanted(&value) {
                    return value;
                }
            }
            panic!("the socket closed");
        })
        .await
        .expect("the socket answered")
    }

    async fn ws_request(socket: &mut TestSocket, id: &str, method: &str, params: Value) -> Value {
        let request = json!({ "id": id, "method": method, "params": params });
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                request.to_string().into(),
            ))
            .await
            .unwrap();
        next_matching(socket, |value| value["id"] == id).await
    }

    /// Fix for S7's second socket: the Agents store's socket (narrowed to
    /// the status and activity events) and a Settings row's own client (not
    /// narrowed at all) are renderer sockets that never run an intent. Only
    /// a socket that listens counts, so with just those attached a Studio
    /// tool answers at once instead of waiting out the 15 s timeout.
    #[tokio::test]
    async fn only_a_listening_socket_counts_as_the_studio() {
        let state = test_state();
        let address = serve(&state).await;
        let (_, token) = connect_agent(&state, "Claude Desktop");
        let ws_address = serve_ws(&state).await;

        let mut store = open_renderer_socket(ws_address, &state.token).await;
        let narrowed = ws_request(
            &mut store,
            "included",
            "events.setIncluded",
            json!({ "events": ["agents.status", "agents.activity"] }),
        )
        .await;
        assert_eq!(narrowed["ok"], true, "{narrowed}");
        let mut settings_row = open_renderer_socket(ws_address, &state.token).await;
        assert!(!state.agents.studio_open());

        let started = Instant::now();
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
        assert_eq!(answer["result"]["isError"], true, "{answer}");
        assert_eq!(answer["result"]["content"][0]["text"], STUDIO_CLOSED);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "answered at once, not after the intent timeout: {:?}",
            started.elapsed()
        );
        assert!(state.agents.lock().pending_intents.is_empty());

        // Neither socket ever receives an intent, even one emitted anyway;
        // the next status event is the first thing each sees.
        state.emit_event(
            "agent.intent",
            json!({ "intentId": "ai-x", "agentId": "a", "agentName": "A", "tool": "notify", "args": {} }),
        );
        state.emit_event("agents.status", crate::agent_mcp::status(&state));
        for socket in [&mut store, &mut settings_row] {
            let first = next_matching(socket, |value| {
                value["event"] == "agent.intent" || value["event"] == "agents.status"
            })
            .await;
            assert_eq!(first["event"], "agents.status", "{first}");
        }

        // The Studio's socket listens: now it counts, until it closes.
        let mut studio = open_renderer_socket(ws_address, &state.token).await;
        ws_request(&mut studio, "listen", "agent.intent.listen", json!({})).await;
        assert!(state.agents.studio_open());
        drop(studio);
        tokio::time::timeout(Duration::from_secs(5), async {
            while state.agents.studio_open() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("a closed Studio socket stops counting");

        // Main's admin socket can't listen.
        let mut admin = open_renderer_socket(ws_address, &state.admin_token).await;
        let refused = ws_request(&mut admin, "listen", "agent.intent.listen", json!({})).await;
        assert_eq!(refused["ok"], false, "{refused}");
        assert_eq!(refused["error"]["code"], "forbidden-method");
        assert!(!state.agents.studio_open());
    }

    #[tokio::test]
    async fn an_unanswered_intent_times_out_and_a_refusal_keeps_the_sentence() {
        let state = test_state();
        let (agent, _) = connect_agent(&state, "Cursor");
        let tool = agent_tools::catalog().tool("notify").unwrap().clone();
        state.agents.studio_sockets.fetch_add(1, Ordering::Relaxed);
        let outcome = relay_studio_intent(
            &state,
            &agent,
            &tool,
            json!({ "message": "x" }),
            Duration::from_millis(50),
        )
        .await;
        assert_eq!(outcome.outcome, AgentActivityOutcome::Timeout);
        assert_eq!(outcome.text, STUDIO_TIMEOUT);
        assert_eq!(outcome.unanswered_intent.as_deref(), Some("ai-1"));
        assert!(state.agents.lock().pending_intents.is_empty());
        // Late: nothing waits for it any more.
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

    /// The Studio's `agent.intent` events and cancels as a listening socket
    /// would see them.
    fn intent_events(
        events: &mut tokio::sync::broadcast::Receiver<crate::protocol::ServerEvent>,
    ) -> Vec<(String, Value)> {
        let mut seen = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event.event.starts_with("agent.intent") || event.event == "agents.activity" {
                seen.push((event.event.clone(), event.payload.clone()));
            }
        }
        seen
    }

    /// Review fix 1: a call that timed out is still finished by the Studio's
    /// late ack, in either order (the ack before or after the caller wrote
    /// the row), and only when the Studio did it.
    #[tokio::test]
    async fn a_late_ack_finishes_the_activity_row_and_fires_the_notice() {
        let state = test_state();
        let (agent, _) = connect_agent(&state, "Claude Desktop");
        let tool = agent_tools::catalog().tool("notify").unwrap().clone();
        state.agents.studio_sockets.fetch_add(1, Ordering::Relaxed);
        let mut events = state.events.subscribe();
        let args = json!({ "message": "the sponsor banner is up" });

        // The usual order: timeout, the row, then the ack.
        let outcome = relay_studio_intent(
            &state,
            &agent,
            &tool,
            args.clone(),
            Duration::from_millis(20),
        )
        .await;
        let intent = intent_events(&mut events).remove(0).1;
        assert_eq!(intent["generation"], 0);
        assert!(
            intent["deadlineAt"].as_i64().unwrap() > chrono::Utc::now().timestamp_millis() - 5_000
        );
        let row = agent_mcp::log_activity(
            &state,
            &agent,
            "notify",
            String::new(),
            outcome.outcome,
            Some(outcome.text.clone()),
            None,
        );
        attach_activity_row(
            &state,
            outcome.unanswered_intent.as_deref().unwrap(),
            row.clone(),
        );
        intent_events(&mut events);
        let late = ack_studio_intent(
            &state,
            AgentIntentAck {
                intent_id: "ai-1".to_string(),
                ok: true,
                message: Some("Shown.".to_string()),
                result: Some(json!({ "shown": true })),
            },
        );
        assert!(!late, "nothing was waiting");
        let stored = agent_mcp::activity(&state, agent_mcp::ActivityListParams::default())
            .unwrap()
            .entries;
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].id, row.id);
        assert_eq!(stored[0].outcome, AgentActivityOutcome::Ok);
        assert_eq!(stored[0].message.as_deref(), Some("Shown."));
        let announced = intent_events(&mut events);
        assert_eq!(announced.len(), 1, "{announced:?}");
        assert_eq!(announced[0].1["id"], json!(row.id));
        assert_eq!(announced[0].1["outcome"], "ok");
        assert_eq!(
            announced[0].1["notice"],
            "Claude Desktop: the sponsor banner is up"
        );
        assert!(state.agents.lock().unanswered.is_empty());

        // The ack first, then the row: applied when the row arrives.
        let outcome = relay_studio_intent(
            &state,
            &agent,
            &tool,
            args.clone(),
            Duration::from_millis(20),
        )
        .await;
        let intent_id = outcome.unanswered_intent.clone().unwrap();
        ack_studio_intent(
            &state,
            AgentIntentAck {
                intent_id: intent_id.clone(),
                ok: true,
                message: None,
                result: None,
            },
        );
        let row = agent_mcp::log_activity(
            &state,
            &agent,
            "notify",
            String::new(),
            outcome.outcome,
            Some(outcome.text.clone()),
            None,
        );
        attach_activity_row(&state, &intent_id, row.clone());
        let stored = agent_mcp::activity(&state, agent_mcp::ActivityListParams::default())
            .unwrap()
            .entries;
        assert_eq!(stored[0].id, row.id);
        assert_eq!(stored[0].outcome, AgentActivityOutcome::Ok);
        assert_eq!(stored[0].message.as_deref(), Some(DONE));

        // A late refusal changes nothing: nothing happened.
        let outcome =
            relay_studio_intent(&state, &agent, &tool, args, Duration::from_millis(20)).await;
        let intent_id = outcome.unanswered_intent.clone().unwrap();
        let row = agent_mcp::log_activity(
            &state,
            &agent,
            "notify",
            String::new(),
            outcome.outcome,
            Some(outcome.text.clone()),
            None,
        );
        attach_activity_row(&state, &intent_id, row.clone());
        intent_events(&mut events);
        ack_studio_intent(
            &state,
            AgentIntentAck {
                intent_id,
                ok: false,
                message: Some("Stopped before it ran.".to_string()),
                result: None,
            },
        );
        let stored = agent_mcp::activity(&state, agent_mcp::ActivityListParams::default())
            .unwrap()
            .entries;
        assert_eq!(stored[0].id, row.id);
        assert_eq!(stored[0].outcome, AgentActivityOutcome::Timeout);
        assert!(intent_events(&mut events).is_empty());
    }

    /// Review fix 1: Stop ends every agent's waiting call ("went away") and
    /// keeps it for a late ack, cancels what the Studio queued, and never
    /// touches Buddy's. Remove cancels that agent's intents only.
    #[tokio::test]
    async fn stop_and_remove_cancel_agent_intents_but_never_buddys() {
        let state = test_state();
        let (agent, _) = connect_agent(&state, "Cursor");
        let tool = agent_tools::catalog().tool("notify").unwrap().clone();
        state.agents.studio_sockets.fetch_add(1, Ordering::Relaxed);
        let mut events = state.events.subscribe();

        let agent_call = {
            let state = state.clone();
            let agent = agent.clone();
            let tool = tool.clone();
            tokio::spawn(async move {
                relay_studio_intent(
                    &state,
                    &agent,
                    &tool,
                    json!({ "message": "x" }),
                    Duration::from_secs(5),
                )
                .await
            })
        };
        let buddy_call = {
            let state = state.clone();
            let tool = tool.clone();
            tokio::spawn(async move {
                relay_studio_intent(
                    &state,
                    &crate::buddy_act::identity(),
                    &tool,
                    json!({ "message": "y" }),
                    Duration::from_secs(5),
                )
                .await
            })
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            while state.agents.lock().pending_intents.len() < 2 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();

        agent_mcp::disable(&state).unwrap();
        let outcome = agent_call.await.unwrap();
        assert_eq!(outcome.outcome, AgentActivityOutcome::Failed);
        assert_eq!(outcome.text, STUDIO_GONE);
        let cut = outcome.unanswered_intent.unwrap();
        assert!(state.agents.lock().unanswered.contains_key(&cut));
        // Buddy's call still waits for its own answer.
        let buddy_id = {
            let runtime = state.agents.lock();
            assert_eq!(runtime.pending_intents.len(), 1);
            runtime.pending_intents.keys().next().cloned().unwrap()
        };
        assert!(ack_studio_intent(
            &state,
            AgentIntentAck {
                intent_id: buddy_id,
                ok: true,
                message: None,
                result: None,
            }
        ));
        assert_eq!(buddy_call.await.unwrap().outcome, AgentActivityOutcome::Ok);

        let cancels: Vec<Value> = intent_events(&mut events)
            .into_iter()
            .filter(|(event, _)| event == "agent.intent.cancel")
            .map(|(_, payload)| payload)
            .collect();
        assert_eq!(cancels, vec![json!({ "generation": 1 })]);

        // Remove: that agent's intents, by id; later intents carry the new
        // generation.
        agent_mcp::remove_agent(
            &state,
            agent_mcp::AgentIdParams {
                id: agent.id.clone(),
            },
        )
        .unwrap();
        let cancels: Vec<Value> = intent_events(&mut events)
            .into_iter()
            .filter(|(event, _)| event == "agent.intent.cancel")
            .map(|(_, payload)| payload)
            .collect();
        assert_eq!(
            cancels,
            vec![json!({ "generation": 2, "agentId": agent.id })]
        );
        let _ = relay_studio_intent(
            &state,
            &crate::buddy_act::identity(),
            &tool,
            json!({ "message": "z" }),
            Duration::from_millis(10),
        )
        .await;
        let intent = intent_events(&mut events)
            .into_iter()
            .find(|(event, _)| event == "agent.intent")
            .unwrap()
            .1;
        assert_eq!(intent["generation"], 2);
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

    // PR B (plan 209 S11): edit_banner imports an image on this computer as a
    // banner and renames one, through the Assets page's own functions, and
    // never names a file Videorc keeps.
    #[tokio::test]
    async fn edit_banner_imports_an_image_and_renames_a_banner() {
        let dir = std::env::temp_dir().join(format!(
            "videorc-agent-edit-banner-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let (events, _) = tokio::sync::broadcast::channel(64);
        let state = AppState::new(
            "renderer-token".to_string(),
            1234,
            events,
            crate::storage::Database::open_file_for_tests(&dir.join("videorc.sqlite3")),
        );
        let agent = AgentIdentity {
            id: "agent-1".to_string(),
            name: "Claude Code".to_string(),
        };
        let image = dir.join("Sponsor strip.png");
        image::RgbaImage::from_pixel(1200, 200, image::Rgba([240, 80, 40, 255]))
            .save(&image)
            .unwrap();

        let imported =
            edit_banner(&state, &agent, json!({ "path": image.to_string_lossy() })).await;
        assert_eq!(
            imported.outcome,
            AgentActivityOutcome::Ok,
            "{}",
            imported.text
        );
        assert_eq!(
            imported.text,
            "Imported Sponsor strip as a banner. It stays hidden until it is shown."
        );
        let banner = imported.structured.clone().unwrap()["banner"].clone();
        assert_eq!(banner["name"], "Sponsor strip");
        assert_eq!(banner["shown"], false);
        assert_eq!(banner["width"], 1200);
        // D9: an id and a name, never the stored file or its folder.
        let wire = imported.structured.unwrap().to_string();
        assert!(!wire.contains(".png"), "{wire}");
        assert!(!wire.contains(&dir.to_string_lossy().to_string()), "{wire}");
        let id = banner["id"].as_str().unwrap().to_string();
        assert_eq!(state.database.list_banners().unwrap().len(), 1);

        // Rename, the Assets page's own rename.
        let renamed = edit_banner(
            &state,
            &agent,
            json!({ "bannerId": id, "name": "  Sponsor  " }),
        )
        .await;
        assert_eq!(
            renamed.outcome,
            AgentActivityOutcome::Ok,
            "{}",
            renamed.text
        );
        assert_eq!(renamed.text, "The banner is now called Sponsor.");
        assert_eq!(state.database.list_banners().unwrap()[0].name, "Sponsor");

        // An import can carry its name too.
        let named = edit_banner(
            &state,
            &agent,
            json!({ "path": image.to_string_lossy(), "name": "Sponsor 2" }),
        )
        .await;
        assert_eq!(named.outcome, AgentActivityOutcome::Ok, "{}", named.text);
        assert_eq!(named.structured.unwrap()["banner"]["name"], "Sponsor 2");

        // Refusals, each in its own sentence.
        for (args, sentence) in [
            (json!({}), EDIT_BANNER_EMPTY.to_string()),
            (
                json!({ "path": image.to_string_lossy(), "bannerId": "x" }),
                EDIT_BANNER_BOTH.to_string(),
            ),
            (
                json!({ "bannerId": "x" }),
                EDIT_BANNER_NAME_MISSING.to_string(),
            ),
            (
                json!({ "path": "Sponsor strip.png" }),
                EDIT_BANNER_RELATIVE.to_string(),
            ),
            (
                json!({ "path": dir.to_string_lossy() }),
                EDIT_BANNER_NO_FILE.to_string(),
            ),
            (
                json!({ "bannerId": "gone", "name": "New" }),
                "That banner isn't available anymore.".to_string(),
            ),
        ] {
            let outcome = edit_banner(&state, &agent, args.clone()).await;
            assert_eq!(outcome, ToolOutcome::refused(sentence), "{args}");
        }
        // A file that isn't an image is refused in the import's own words.
        let text = dir.join("notes.txt");
        std::fs::write(&text, "not an image").unwrap();
        let refused = edit_banner(&state, &agent, json!({ "path": text.to_string_lossy() })).await;
        assert_eq!(refused.outcome, AgentActivityOutcome::Refused);
        assert!(!refused.text.contains("Banners"), "{}", refused.text);
        assert_eq!(state.database.list_banners().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_banner_import_never_names_videorc_s_banner_folder() {
        let assets = std::path::Path::new("/Users/me/Library/Application Support/Videorc/Banners");
        let named = anyhow::anyhow!(
            "Could not create /Users/me/Library/Application Support/Videorc/Banners"
        );
        assert_eq!(
            banner_import_sentence(&named, assets),
            EDIT_BANNER_SAVE_FAILED
        );
        let own = anyhow::anyhow!("Could not open /Users/me/Desktop/logo.png");
        assert_eq!(
            banner_import_sentence(&own, assets),
            "Could not open /Users/me/Desktop/logo.png"
        );
    }
}
