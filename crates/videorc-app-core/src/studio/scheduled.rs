//! S3.5d: Upcoming as the Studio runs it (`hooks/use-scheduled-streams.ts`):
//! the saved streams and what each platform can do, read on each connection
//! (with a check of every published event on its platform) and on
//! `scheduledStreams.changed`; every change runs as an operation followed
//! to its end (`runScheduledOperation`), one event pending at a time. A
//! window focus reads the list again, and asks the platforms again at most
//! every five minutes (`FOCUS_PROVIDER_REFRESH_MS`).

use std::time::Duration;

use serde_json::{Value, json};

use super::{Studio, StudioBackend};
use crate::client::RpcError;
use crate::livestream::scheduled::{self, Capabilities, Event};
use crate::livestream::{methods, scheduled_copy as copy};
use crate::user_error::{Failure, UserError, UserErrorContext, user_error_message};

/// `scheduledStreams.changed`.
pub const CHANGED_EVENT: &str = "scheduledStreams.changed";
/// How many published events a provider check reads at most.
const REFRESH_LIMIT: usize = 100;
/// A focus asks the platforms again at most this often: every provider
/// check re-reads each saved event, which spends YouTube quota.
pub const FOCUS_PROVIDER_REFRESH_MS: i64 = 5 * 60_000;
/// A failed operation's code: Electron throws its message alone, so no code
/// maps it to a known sentence.
const OPERATION_FAILED_CODE: &str = "scheduled-operation";

/// `focusRefreshesProviders`.
pub fn focus_refreshes_providers(last_provider_refresh_ms: i64, now_ms: i64) -> bool {
    now_ms - last_provider_refresh_ms >= FOCUS_PROVIDER_REFRESH_MS
}

/// `userErrorMessage(...).text`.
fn error_text(copy: &UserError) -> String {
    format!("{}. {}", copy.title, copy.description)
}

/// Upcoming's state.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ScheduledState {
    pub events: Vec<Event>,
    pub capabilities: Option<Capabilities>,
    pub error: Option<String>,
    /// Nothing read yet on this connection.
    pub loaded: bool,
    pub refreshing: bool,
    /// The events a change is running on, each once.
    pub pending: Vec<String>,
    pub last_checked_at: Option<String>,
    /// How many changes run on each pending event (`pending`'s counted map).
    pending_counts: Vec<(String, u32)>,
    /// When the platforms were last asked (`lastProviderRefresh`, epoch ms).
    last_provider_refresh_ms: i64,
}

impl ScheduledState {
    fn start_pending(&mut self, event_id: &str) {
        match self
            .pending_counts
            .iter_mut()
            .find(|(id, _)| id == event_id)
        {
            Some((_, count)) => *count += 1,
            None => self.pending_counts.push((event_id.to_string(), 1)),
        }
        self.pending = self
            .pending_counts
            .iter()
            .map(|(id, _)| id.clone())
            .collect();
    }

    fn finish_pending(&mut self, event_id: &str) {
        if let Some(index) = self
            .pending_counts
            .iter()
            .position(|(id, _)| id == event_id)
        {
            self.pending_counts[index].1 -= 1;
            if self.pending_counts[index].1 == 0 {
                self.pending_counts.remove(index);
            }
        }
        self.pending = self
            .pending_counts
            .iter()
            .map(|(id, _)| id.clone())
            .collect();
    }
}

/// `scheduledStreams.{method}`: the requests and operations Upcoming and the
/// Go Live dialog run.
pub(crate) fn scheduled_method(name: &str) -> Option<&'static str> {
    Some(match name {
        "list" => "scheduledStreams.list",
        "capabilities" => "scheduledStreams.capabilities",
        "get" => methods::SCHEDULED_GET,
        "operation" => methods::SCHEDULED_OPERATION,
        "candidates" => "scheduledStreams.candidates",
        "resolveTime" => "scheduledStreams.resolveTime",
        "saveDraft" => "scheduledStreams.saveDraft",
        "update" => "scheduledStreams.update",
        "schedule" => "scheduledStreams.schedule",
        "refresh" => "scheduledStreams.refresh",
        "duplicate" => "scheduledStreams.duplicate",
        "cancel" => "scheduledStreams.cancel",
        "recover" => "scheduledStreams.recover",
        "prepareForGoLive" => "scheduledStreams.prepareForGoLive",
        "activate" => "scheduledStreams.activate",
        "releasePreparation" => "scheduledStreams.releasePreparation",
        // The Go Live dialog's (S3.5c) and the lifecycle's.
        "create" => "scheduledStreams.create",
        "retry" => "scheduledStreams.retry",
        "reconcile" => "scheduledStreams.reconcile",
        "markEnded" => "scheduledStreams.markEnded",
        "delete" => "scheduledStreams.delete",
        _ => return None,
    })
}

/// `ACTION_VERBS`: the verb a failed change names.
fn action_verb(action: &str) -> &'static str {
    match action {
        "cancel" => "cancel",
        "schedule" => "schedule",
        "duplicate" => "duplicate",
        "refresh" => "refresh",
        "recover" => "recover",
        _ => "update",
    }
}

fn unknown(name: &str) -> RpcError {
    RpcError::new(
        methods::SCHEDULED_OPERATION,
        "unknown-operation",
        name.to_string(),
    )
}

impl<B: StudioBackend> Studio<B> {
    pub fn scheduled(&self) -> tokio::sync::watch::Receiver<ScheduledState> {
        self.scheduled_tx.subscribe()
    }

    pub fn scheduled_now(&self) -> ScheduledState {
        self.scheduled_tx.borrow().clone()
    }

    fn edit_scheduled(&self, edit: impl FnOnce(&mut ScheduledState)) {
        self.scheduled_tx.send_if_modified(|state| {
            let before = state.clone();
            edit(state);
            *state != before
        });
    }

    /// Electron's hook throws "Videorc is reconnecting." for a read or a
    /// change while the backend is away; the same sentence here.
    fn reconnecting(method: &str) -> RpcError {
        RpcError::new(method, "reconnecting", copy::RECONNECTING.to_string())
    }

    /// `request(method, params)`: one of Upcoming's reads.
    pub async fn scheduled_request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let method = scheduled_method(method).ok_or_else(|| unknown(method))?;
        if !self.is_connected() {
            return Err(Self::reconnecting(method));
        }
        self.backend.livestream_request(method, params).await
    }

    /// `runScheduledOperation`: the operation, followed until it settles
    /// (500 ms apart, three minutes at most); its result, or why it failed.
    pub(crate) async fn run_scheduled_operation(
        &self,
        action: &str,
        mut params: Value,
    ) -> Result<Value, RpcError> {
        let method = scheduled_method(action).ok_or_else(|| unknown(action))?;
        if !self.is_connected() {
            return Err(Self::reconnecting(method));
        }
        if params.get("operationId").and_then(Value::as_str).is_none() {
            params["operationId"] = Value::String(uuid::Uuid::new_v4().to_string());
        }
        let operation_id = params["operationId"].clone();
        let mut operation = self.backend.livestream_request(method, params).await?;
        let deadline = std::time::Instant::now() + Duration::from_secs(180);
        while operation.get("state").and_then(Value::as_str) == Some("pending")
            && std::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(500)).await;
            operation = self
                .backend
                .livestream_request(
                    methods::SCHEDULED_OPERATION,
                    json!({ "operationId": operation_id }),
                )
                .await?;
        }
        if operation.get("state").and_then(Value::as_str) != Some("complete") {
            let message = operation
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| {
                    if operation.get("state").and_then(Value::as_str) == Some("pending") {
                        copy::OPERATION_STILL_RUNNING.to_string()
                    } else {
                        copy::OPERATION_DID_NOT_FINISH.to_string()
                    }
                });
            return Err(RpcError::new(method, OPERATION_FAILED_CODE, message));
        }
        Ok(operation.get("result").cloned().unwrap_or(Value::Null))
    }

    /// `reload(refreshProvider)`: the list and the capabilities; with a
    /// provider check, every published event is read again on its platform.
    pub async fn reload_scheduled(&self, refresh_provider: bool) -> Result<(), RpcError> {
        let list = self.scheduled_request("list", json!({})).await?;
        let capabilities = self.scheduled_request("capabilities", json!({})).await?;
        let events: Vec<Event> = serde_json::from_value(list).unwrap_or_default();
        let capabilities: Capabilities = serde_json::from_value(capabilities).unwrap_or_default();
        let available = capabilities.available;
        self.edit_scheduled(|state| {
            state.events = events.clone();
            state.capabilities = Some(capabilities);
            state.loaded = true;
        });
        if refresh_provider && available {
            let started = chrono::Utc::now().timestamp_millis();
            self.edit_scheduled(|state| state.last_provider_refresh_ms = started);
            for event in events
                .iter()
                .filter(|e| {
                    e.provider_event_id.is_some()
                        && e.operation_state.as_deref() != Some("pending")
                        && e.lifecycle != "canceled"
                })
                .take(REFRESH_LIMIT)
            {
                if self
                    .run_scheduled_operation(
                        "refresh",
                        json!({ "eventId": event.id, "expectedRevision": event.revision }),
                    )
                    .await
                    .is_err()
                {
                    self.edit_scheduled(|state| {
                        state.error = Some(copy::REFRESH_FAILED.to_string());
                    });
                }
            }
            let list = self.scheduled_request("list", json!({})).await?;
            let events: Vec<Event> = serde_json::from_value(list).unwrap_or_default();
            let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            self.edit_scheduled(|state| {
                state.events = events;
                state.last_checked_at = Some(now);
            });
        }
        Ok(())
    }

    /// The bootstrap's read: the list with a provider check.
    pub(super) async fn read_scheduled(&self) {
        if !self.is_connected() {
            self.edit_scheduled(|state| {
                state.error = Some(copy::RECONNECTING_REOPEN.to_string());
                state.loaded = true;
            });
            return;
        }
        if let Err(error) = self.reload_scheduled(true).await {
            let copy = user_error_message(
                Failure::Rpc(&error),
                Some(UserErrorContext {
                    action: "load",
                    object: "upcoming streams",
                }),
            );
            self.edit_scheduled(|state| {
                state.error = Some(error_text(&copy));
                state.loaded = true;
            });
        }
    }

    /// Refresh: the provider check again. A failed reload sets no line; a
    /// failed event check says so (`REFRESH_FAILED`).
    pub async fn refresh_scheduled(&self) {
        self.edit_scheduled(|state| state.refreshing = true);
        let _ = self.reload_scheduled(true).await;
        self.edit_scheduled(|state| state.refreshing = false);
    }

    /// The window's focus: the list again, and the platforms too once five
    /// minutes have passed since they were last asked.
    pub async fn scheduled_focus(&self) {
        let last = self.scheduled_now().last_provider_refresh_ms;
        let providers = focus_refreshes_providers(last, chrono::Utc::now().timestamp_millis());
        if self.reload_scheduled(providers).await.is_err() {
            self.edit_scheduled(|state| state.error = Some(copy::SHOWING_LOADED_LAST.to_string()));
        }
    }

    /// `scheduledStreams.changed`.
    pub(super) async fn handle_scheduled_event(&self, event: &str) -> bool {
        if event != CHANGED_EVENT {
            return false;
        }
        let _ = self.reload_scheduled(false).await;
        true
    }

    /// `mutate(action, params)`: one change on one event, its failure in the
    /// streamer's words, the list read again either way.
    pub async fn scheduled_mutate(&self, action: &str, params: Value) -> Result<Value, RpcError> {
        if !self.is_connected() {
            let method = scheduled_method(action).unwrap_or(methods::SCHEDULED_OPERATION);
            return Err(Self::reconnecting(method));
        }
        let event_id = params
            .get("eventId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        self.edit_scheduled(|state| {
            state.start_pending(&event_id);
            state.error = None;
        });
        let result = self.run_scheduled_operation(action, params).await;
        if let Err(error) = &result {
            let copy = user_error_message(
                Failure::Rpc(error),
                Some(UserErrorContext {
                    action: action_verb(action),
                    object: "the event",
                }),
            );
            self.edit_scheduled(|state| state.error = Some(error_text(&copy)));
        }
        let _ = self.reload_scheduled(false).await;
        self.edit_scheduled(|state| state.finish_pending(&event_id));
        result
    }

    /// Use for Go Live: the event on its signed-in destination, saved.
    pub async fn use_scheduled_for_go_live(
        &self,
        target_id: &str,
        event: &Event,
    ) -> Result<(), String> {
        let config = self.snapshot().settings.capture_doc;
        let mut probe = config.clone();
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        scheduled::select_for_target(&mut probe, target_id, event, &now).map_err(str::to_string)?;
        let target = target_id.to_string();
        let event = event.clone();
        self.update_capture_config(move |config| {
            let _ = scheduled::select_for_target(config, &target, &event, &now);
            crate::livestream::targets::bridge_streaming_to_legacy(config);
        })
        .await
        .map_err(|error| error.message)
    }
}
