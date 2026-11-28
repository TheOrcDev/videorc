//! Agent intents and link (plan 209 S6, Electron's `lib/agent-studio-link.ts`
//! and `lib/studio-actions/agent.ts`):
//!
//! - Calls `agent.intent.listen` on every `backend.ready` so the backend routes
//!   `agent.intent` and `agent.intent.cancel` to this Studio socket and
//!   `get_status` reports `studioOpen: true`.
//! - Reads `agents.status` and follows `agents.status` events to toggle
//!   [`super::agent_surface`] publishing (`agents_enabled || buddy_can_act`).
//! - Runs incoming `agent.intent` calls sequentially on a FIFO agents lane,
//!   checking cancellation (`agent.intent.cancel`, generation-scoped) and
//!   `deadlineAt` before starting, enforcing D15 Buddy allowlist a second time,
//!   and always answering with `agent.intent.ack` (`{intentId, ok, message?, result?}`).
//! - Forwards `rename_recording` activity and `delete_recording` / `export_recording`
//!   calls to the GPUI app's Library via [`Studio::set_agent_app_listener`].

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use super::agent_surface::AgentSurfaceState;
use super::{Studio, StudioBackend};
use crate::client::methods::AgentIntentAckParams;

/// Sidekick's agent id (`BUDDY_AGENT_ID`): a non-targeted cancel ("Stop agents",
/// "Off") does not cancel Buddy, and Buddy is restricted to [`BUDDY_ALLOWED_STUDIO_TOOLS`].
pub const BUDDY_AGENT_ID: &str = "buddy";

/// How long Library actions (`delete_recording`, `export_recording`) wait for
/// the app listener before answering unavailable (generous enough for
/// `export_recording`'s 10 s short-export wait).
pub const AGENT_APP_TIMEOUT: Duration = Duration::from_secs(14);

/// Every `runsIn: studio` tool in `protocol-fixtures/agent-tools.json`.
pub const STUDIO_AGENT_TOOLS: [&str; 25] = [
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
    "hide_screen",
    "go_live",
    "set_sources",
    "set_captions",
    "set_background",
    "get_scene_layout",
    "move_on_scene",
    "set_scene_item",
    "set_buddy",
    "update_stream_info",
    "set_destinations",
    "get_settings",
    "update_settings",
    "delete_recording",
    "export_recording",
];

/// Every `runsIn: studio` tool with `buddy: true` in `protocol-fixtures/agent-tools.json`.
pub const BUDDY_ALLOWED_STUDIO_TOOLS: [&str; 18] = [
    "start_recording",
    "stop",
    "switch_scene",
    "set_audio",
    "set_takeover",
    "play_sound",
    "stop_sounds",
    "set_highlight",
    "hide_screen",
    "go_live",
    "set_sources",
    "set_captions",
    "set_background",
    "get_scene_layout",
    "move_on_scene",
    "set_scene_item",
    "set_buddy",
    "update_stream_info",
];

/// What an agent reads when the Studio cannot run its call (`AGENT_INTENT_COPY`).
pub mod copy {
    pub const UNKNOWN_TOOL: &str = "Videorc can't run that tool from the Studio.";
    pub const NOT_BUDDYS: &str = "Sidekick can't use that tool.";
    pub const FAILED: &str = "Something went wrong in Videorc.";
    pub const CANCELLED: &str = "Agents were stopped in Videorc, so that never ran.";
    pub const LATE: &str = "Videorc was busy too long, so that never ran.";
}

/// One tool call relayed by the backend on `agent.intent`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentIntentEnvelope {
    pub intent_id: String,
    pub agent_id: String,
    #[serde(default)]
    pub agent_name: String,
    pub tool: String,
    #[serde(default)]
    pub args: Value,
    #[serde(default)]
    pub deadline_at: Option<u64>,
    #[serde(default)]
    pub generation: Option<u64>,
}

/// A cancel signal relayed by the backend on `agent.intent.cancel`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentIntentCancel {
    pub generation: u64,
    #[serde(default)]
    pub agent_id: Option<String>,
}

/// The body of `agent.intent.ack` (beyond `intentId`).
#[derive(Debug, Clone, PartialEq)]
pub struct AgentIntentOutcome {
    pub ok: bool,
    pub message: Option<String>,
    pub result: Option<Value>,
}

impl AgentIntentOutcome {
    pub fn ok(message: impl Into<String>, result: Value) -> Self {
        let msg = message.into();
        Self {
            ok: true,
            message: (!msg.is_empty()).then_some(msg),
            result: Some(result),
        }
    }

    pub fn refused(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: Some(message.into()),
            result: None,
        }
    }
}

/// Whether `cancel` reaches `intent` (`agentCancelReaches`): its agent's
/// (Remove), or any agent's except Buddy's (Stop agents, Off), sent in an
/// older generation.
pub fn agent_cancel_reaches(intent: &AgentIntentEnvelope, cancel: &AgentIntentCancel) -> bool {
    if intent
        .generation
        .is_some_and(|generation| generation >= cancel.generation)
    {
        return false;
    }
    match cancel.agent_id.as_deref() {
        None => intent.agent_id != BUDDY_AGENT_ID,
        Some(target) => intent.agent_id == target,
    }
}

/// Why an intent the Studio hasn't started never runs (`agentIntentDropReason`).
pub fn agent_intent_drop_reason(
    intent: &AgentIntentEnvelope,
    cancelled: bool,
    now_ms: u64,
) -> Option<&'static str> {
    if cancelled {
        return Some(copy::CANCELLED);
    }
    if intent
        .deadline_at
        .is_some_and(|deadline| now_ms >= deadline)
    {
        return Some(copy::LATE);
    }
    None
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Actions only the GPUI app's Library layer can perform for agents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppAgentAction {
    /// Two-phase delete through `Library::delete` (Trash / smoke Trash stand-in).
    DeleteRecording { recording_id: String },
    /// Export MP4 through `Library::remux` (waiting up to 10 s for a short export).
    ExportRecording {
        recording_id: String,
        session_active: bool,
    },
    /// Fire-and-forget: an agent renamed a recording in the backend; refresh Library.
    RecordingRenamed,
}

/// Answer from the GPUI app listener for an [`AppAgentAction`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppAgentAnswer {
    Deleted {
        title: Option<String>,
    },
    Exported {
        already_mp4: bool,
        exported: bool,
        path: Option<String>,
    },
    Notified,
}

/// One request sent from `Studio` to the GPUI app's agent-Library bridge.
#[derive(Debug)]
pub struct AppAgentIntent {
    pub action: AppAgentAction,
    pub reply: Option<oneshot::Sender<Result<AppAgentAnswer, String>>>,
}

impl AppAgentIntent {
    pub fn answer(self, result: Result<AppAgentAnswer, String>) {
        if let Some(reply) = self.reply {
            let _ = reply.send(result);
        }
    }
}

struct HeldIntent {
    envelope: AgentIntentEnvelope,
    cancelled: Arc<AtomicBool>,
}

/// All agent link state owned by [`Studio`], behind `Studio::agent` mutex.
#[derive(Default)]
pub(super) struct AgentLinkState {
    pub(super) surface: AgentSurfaceState,
    /// Queued intents awaiting their turn on the FIFO agents lane.
    queue: VecDeque<(AgentIntentEnvelope, Arc<AtomicBool>)>,
    /// All queued + currently running intents until their ack, for cancel routing.
    held: Vec<HeldIntent>,
    /// GPUI app listener for Library actions (`delete_recording`, `export_recording`,
    /// `rename_recording` refresh).
    pub(super) app_listener: Option<mpsc::UnboundedSender<AppAgentIntent>>,
}

impl AgentLinkState {
    pub(super) fn forget_connection(&mut self) {
        self.surface.forget_connection();
    }

    fn enqueue(&mut self, envelope: AgentIntentEnvelope) {
        let cancelled = Arc::new(AtomicBool::new(false));
        self.held.push(HeldIntent {
            envelope: envelope.clone(),
            cancelled: cancelled.clone(),
        });
        self.queue.push_back((envelope, cancelled));
    }

    fn apply_cancel(&mut self, cancel: &AgentIntentCancel) {
        for held in &self.held {
            if agent_cancel_reaches(&held.envelope, cancel) {
                held.cancelled.store(true, Ordering::Release);
            }
        }
    }

    fn pop_next(&mut self) -> Option<(AgentIntentEnvelope, Arc<AtomicBool>)> {
        self.queue.pop_front()
    }

    fn release(&mut self, intent_id: &str) {
        if let Some(pos) = self
            .held
            .iter()
            .position(|h| h.envelope.intent_id == intent_id)
        {
            self.held.remove(pos);
        }
    }
}

impl<B: StudioBackend> Studio<B> {
    /// Installs the GPUI app's Library listener for agent file actions
    /// (`delete_recording`, `export_recording`, `rename_recording` refresh).
    pub fn set_agent_app_listener(&self, listener: Option<mpsc::UnboundedSender<AppAgentIntent>>) {
        self.agent_lock().app_listener = listener;
    }

    pub(super) async fn ask_agent_app(
        &self,
        action: AppAgentAction,
    ) -> Result<AppAgentAnswer, String> {
        let listener = self.agent_lock().app_listener.clone();
        let Some(listener) = listener else {
            return Err(super::agent_tools::copy::LIBRARY_UNAVAILABLE.to_string());
        };
        let (reply, answer) = oneshot::channel();
        if listener
            .send(AppAgentIntent {
                action,
                reply: Some(reply),
            })
            .is_err()
        {
            return Err(super::agent_tools::copy::LIBRARY_UNAVAILABLE.to_string());
        }
        match tokio::time::timeout(AGENT_APP_TIMEOUT, answer).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) | Err(_) => Err(copy::FAILED.to_string()),
        }
    }

    pub(super) fn notify_agent_recording_renamed(&self) {
        let listener = self.agent_lock().app_listener.clone();
        if let Some(listener) = listener {
            let _ = listener.send(AppAgentIntent {
                action: AppAgentAction::RecordingRenamed,
                reply: None,
            });
        }
    }

    /// Kicks the connection hook (`agent.intent.listen` + `agents.status`) on
    /// this connection.
    pub(super) fn kick_agent_connect(&self) {
        self.agent_connect_kick.notify_one();
    }

    /// Runs `agent.intent.listen` and reads `agents.status` whenever kicked.
    /// Driven by [`Studio::drive`].
    pub(super) async fn connect_agent_link_when_kicked(self: &Arc<Self>) {
        loop {
            self.agent_connect_kick.notified().await;
            self.connect_agent_link().await;
        }
    }

    /// Calls `agent.intent.listen` and reads `agents.status` once.
    #[doc(hidden)]
    pub async fn connect_agent_link(&self) {
        if let Err(error) = self.backend.agent_intent_listen().await {
            self.config.logger.warn(format!(
                "[agents] Could not run agent intents: {} ({})",
                error.message, error.code
            ));
        }
        match self.backend.agents_status().await {
            Ok(status) => self.apply_agents_status(&status),
            Err(error) => {
                self.config.logger.warn(format!(
                    "[agents] status unavailable: {} ({})",
                    error.message, error.code
                ));
            }
        }
        // Publish immediately if enabled (either Agents is on or Buddy can act).
        let snapshot = self.snapshot();
        self.note_agent_surface(&snapshot);
    }

    /// Handles `agent.intent`, `agent.intent.cancel`, `agents.status`, and
    /// `agents.activity`. Returns true if handled exclusively (so `Studio` can
    /// short-circuit if appropriate; note `agents.activity` returns false so
    /// other listeners aren't disturbed, though Studio itself has no other
    /// handler for it).
    pub(super) fn handle_agent_event(&self, event: &str, payload: &Value) -> bool {
        use crate::client::names;
        match event {
            names::AGENT_INTENT => {
                match serde_json::from_value::<AgentIntentEnvelope>(payload.clone()) {
                    Ok(envelope) => {
                        self.agent_lock().enqueue(envelope);
                        self.agent_intent_kick.notify_one();
                    }
                    Err(error) => {
                        self.config.logger.warn(format!(
                            "[agents] agent.intent payload did not read ({error})."
                        ));
                    }
                }
                true
            }
            names::AGENT_INTENT_CANCEL => {
                match serde_json::from_value::<AgentIntentCancel>(payload.clone()) {
                    Ok(cancel) => self.agent_lock().apply_cancel(&cancel),
                    Err(error) => {
                        self.config.logger.warn(format!(
                            "[agents] agent.intent.cancel payload did not read ({error})."
                        ));
                    }
                }
                true
            }
            names::AGENTS_STATUS => {
                self.apply_agents_status(payload);
                true
            }
            names::AGENTS_ACTIVITY => {
                if payload.get("outcome").and_then(Value::as_str) == Some("ok")
                    && payload.get("tool").and_then(Value::as_str) == Some("rename_recording")
                {
                    self.notify_agent_recording_renamed();
                }
                false
            }
            _ => false,
        }
    }

    /// Runs queued agent intents sequentially on the agents lane, acking each.
    /// Driven by [`Studio::drive`].
    pub(super) async fn run_agent_intents_when_kicked(self: &Arc<Self>) {
        loop {
            self.agent_intent_kick.notified().await;
            loop {
                let next = { self.agent_lock().pop_next() };
                let Some((envelope, cancelled)) = next else {
                    break;
                };
                self.run_agent_intent_with_cancel(envelope, cancelled).await;
            }
        }
    }

    /// Runs one agent intent and sends `agent.intent.ack` (for tests without a driver).
    #[doc(hidden)]
    pub async fn run_agent_intent(self: &Arc<Self>, envelope: AgentIntentEnvelope) {
        let cancelled = Arc::new(AtomicBool::new(false));
        self.run_agent_intent_with_cancel(envelope, cancelled).await;
    }

    async fn run_agent_intent_with_cancel(
        self: &Arc<Self>,
        envelope: AgentIntentEnvelope,
        cancelled: Arc<AtomicBool>,
    ) {
        let intent_id = envelope.intent_id.clone();
        let outcome = self.dispatch_agent_intent(&envelope, &cancelled).await;
        self.agent_lock().release(&intent_id);
        let _ = self
            .backend
            .agent_intent_ack(AgentIntentAckParams {
                intent_id,
                ok: outcome.ok,
                message: outcome.message,
                result: outcome.result,
            })
            .await;
    }

    /// Evaluates drop/catalog/Buddy guards, then runs the tool executor.
    pub(crate) async fn dispatch_agent_intent(
        self: &Arc<Self>,
        envelope: &AgentIntentEnvelope,
        cancelled: &Arc<AtomicBool>,
    ) -> AgentIntentOutcome {
        if let Some(reason) =
            agent_intent_drop_reason(envelope, cancelled.load(Ordering::Acquire), now_epoch_ms())
        {
            return AgentIntentOutcome::refused(reason);
        }
        if !STUDIO_AGENT_TOOLS.contains(&envelope.tool.as_str()) {
            return AgentIntentOutcome::refused(copy::UNKNOWN_TOOL);
        }
        // D15, a second time: Buddy never reaches a non-Buddy tool handler.
        if envelope.agent_id == BUDDY_AGENT_ID
            && !BUDDY_ALLOWED_STUDIO_TOOLS.contains(&envelope.tool.as_str())
        {
            return AgentIntentOutcome::refused(copy::NOT_BUDDYS);
        }
        self.execute_agent_tool(envelope, cancelled).await
    }
}

#[cfg(test)]
#[path = "agent_tests.rs"]
mod tests;
