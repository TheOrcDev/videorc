//! Anonymous usage stats (Settings → General → Privacy, "Share anonymous
//! usage stats", on by default): one small event to videorc.com when a
//! recording or livestream starts and one when it stops, so the project can
//! count how many installs actually stream each week, signed in or not.
//!
//! An event carries a random install id (made on first launch, kept in
//! `app_settings`), its own event id, start or stop, live or recording only,
//! the desktop version, the OS, how many destinations and which platforms,
//! and on stop the duration. Never stream keys, URLs, titles, chat, channel
//! names or recording content. A signed-in desktop also sends its Bearer
//! session token so the web can link the event to the account; the desktop
//! never names a user id itself. Contract: videorc-web
//! `docs/stream-telemetry.md` (`POST /api/desktop/stream-events`).
//!
//! It never touches the recording path. An observer task reads the backend
//! event bus (`recording.status`, `stream.targets`), and a sender task owns a
//! small queue persisted in `app_settings`, so a session offline or a web
//! outage only delays delivery. Turning the setting off stops both at once
//! and empties the queue. `VIDEORC_USAGE_STATS=0` forces it off for a run
//! (live lab, packaged-app smokes); it can only turn sharing off.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Notify, broadcast, mpsc};

use crate::protocol::{RecordingState, RecordingStatus, ServerEvent};
use crate::state::AppState;
use crate::streaming::{StreamTargetsSnapshot, stream_platform_id};

/// `app_settings` key holding a JSON boolean. Absent means on.
pub const ENABLED_SETTING_KEY: &str = "usageStats.enabled";
/// `app_settings` key holding this install's random UUID.
pub const INSTALL_ID_SETTING_KEY: &str = "usageStats.installId";
/// `app_settings` key holding the events not yet delivered.
const QUEUE_SETTING_KEY: &str = "usageStats.queue";
/// `0` / `false` / `no` / `off` turns sharing off for this run, whatever the
/// setting says. Nothing turns it on.
pub const DISABLE_ENV_VAR: &str = "VIDEORC_USAGE_STATS";

const EVENTS_PATH: &str = "/api/desktop/stream-events";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// A few sessions' worth; past it the oldest event goes first.
const QUEUE_CAP: usize = 50;
/// Older undelivered events are dropped (the privacy policy says a week).
const MAX_EVENT_AGE: chrono::TimeDelta = chrono::TimeDelta::days(7);
/// The server refuses longer sessions; a week of streaming is a clock bug.
const MAX_DURATION_SECONDS: u64 = 7 * 24 * 60 * 60;
/// Leave startup alone before sending what an earlier run left queued.
const STARTUP_FLUSH_DELAY: Duration = Duration::from_secs(30);
const RETRY_MIN: Duration = Duration::from_secs(30);
const RETRY_MAX: Duration = Duration::from_secs(30 * 60);
/// A live session's start waits this long for its `stream.targets`, then is
/// sent with what is known.
const TARGETS_WAIT: chrono::TimeDelta = chrono::TimeDelta::seconds(15);
const FACT_CHANNEL_CAPACITY: usize = 32;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StreamEventKind {
    StreamStart,
    StreamStop,
}

/// `live`: at least one destination (it may also record). `recording`: a
/// file only.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SessionMode {
    Live,
    Recording,
}

/// The JSON body of `POST /api/desktop/stream-events`. Field names are the
/// web contract.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamEventPayload {
    pub event_id: String,
    pub install_id: String,
    pub event: StreamEventKind,
    pub mode: SessionMode,
    pub app_version: String,
    pub os: String,
    pub destinations_count: u32,
    pub platforms: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct QueuedEvent {
    payload: StreamEventPayload,
    queued_at: DateTime<Utc>,
    #[serde(default)]
    attempts: u32,
}

/// `usageStats.get` / `usageStats.set`.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageStatsState {
    /// Events are being shared right now.
    pub enabled: bool,
    /// `VIDEORC_USAGE_STATS=0` turned sharing off for this run.
    pub env_disabled: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UsageStatsSetParams {
    pub enabled: bool,
}

// ---------------------------------------------------------------------------
// Session tracker (pure)
// ---------------------------------------------------------------------------

/// One start or stop the tracker saw, before ids and versions are added.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionFact {
    pub event: StreamEventKind,
    pub mode: SessionMode,
    pub destinations_count: u32,
    pub platforms: Vec<String>,
    pub duration_seconds: Option<u64>,
}

#[derive(Debug)]
struct TrackedSession {
    session_id: String,
    mode: SessionMode,
    started_at: DateTime<Utc>,
    /// Sharing was on when the session started. A session started while it
    /// was off stays unshared, so the web never sees half of one.
    shared: bool,
    start_sent: bool,
    destinations_count: u32,
    platforms: Vec<String>,
    /// A live start waiting for its `stream.targets` gives up here.
    targets_deadline: Option<DateTime<Utc>>,
}

/// Folds `recording.status` and `stream.targets` into one start and one stop
/// per session. A running status opens a session: a recording-only one starts
/// at once; a live one waits for its destinations (`stream.targets`, emitted
/// right after the running status) or `TARGETS_WAIT`. The terminal status
/// (idle or failed) closes it. A refused start never reached running, so it
/// is never counted.
#[derive(Debug, Default)]
pub(crate) struct SessionTracker {
    active: Option<TrackedSession>,
    /// Targets that arrived before their session's running status.
    early_targets: Option<StreamTargetsSnapshot>,
}

impl SessionTracker {
    /// `sharing` is whether usage stats are on at this moment.
    pub(crate) fn observe(
        &mut self,
        event: &ServerEvent,
        now: DateTime<Utc>,
        sharing: bool,
    ) -> Vec<SessionFact> {
        match event.event.as_str() {
            "recording.status" => match RecordingStatus::deserialize(&event.payload) {
                Ok(status) => self.observe_status(&status, now, sharing),
                Err(_) => Vec::new(),
            },
            "stream.targets" => match StreamTargetsSnapshot::deserialize(&event.payload) {
                Ok(snapshot) => self.observe_targets(snapshot, sharing),
                Err(_) => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    /// When a live start stops waiting for its destinations.
    pub(crate) fn next_deadline(&self) -> Option<DateTime<Utc>> {
        self.active
            .as_ref()
            .filter(|session| !session.start_sent)
            .and_then(|session| session.targets_deadline)
    }

    /// Sends a live start whose destinations never arrived.
    pub(crate) fn poll_deadline(&mut self, now: DateTime<Utc>, sharing: bool) -> Vec<SessionFact> {
        let Some(session) = self.active.as_mut() else {
            return Vec::new();
        };
        if session.start_sent
            || session
                .targets_deadline
                .is_none_or(|deadline| now < deadline)
        {
            return Vec::new();
        }
        start_fact(session, sharing).into_iter().collect()
    }

    fn observe_status(
        &mut self,
        status: &RecordingStatus,
        now: DateTime<Utc>,
        sharing: bool,
    ) -> Vec<SessionFact> {
        match status.state {
            RecordingState::Recording | RecordingState::Streaming => {
                let Some(session_id) = status.session_id.as_deref() else {
                    return Vec::new();
                };
                if self
                    .active
                    .as_ref()
                    .is_some_and(|session| session.session_id == session_id)
                {
                    return Vec::new();
                }
                // Only presence is read: the stream URL never leaves here.
                let mode = if status.stream_url.is_some()
                    || matches!(status.state, RecordingState::Streaming)
                {
                    SessionMode::Live
                } else {
                    SessionMode::Recording
                };
                let started_at = status
                    .started_at
                    .as_deref()
                    .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                    .map(|value| value.with_timezone(&Utc))
                    .unwrap_or(now);
                let mut session = TrackedSession {
                    session_id: session_id.to_string(),
                    mode,
                    started_at,
                    shared: sharing,
                    start_sent: false,
                    destinations_count: 0,
                    platforms: Vec::new(),
                    targets_deadline: None,
                };
                let early = self
                    .early_targets
                    .take()
                    .filter(|snapshot| snapshot.session_id == session_id);
                let facts = match (mode, early) {
                    (SessionMode::Recording, _) => start_fact(&mut session, sharing),
                    (SessionMode::Live, Some(snapshot)) => {
                        apply_targets(&mut session, &snapshot);
                        start_fact(&mut session, sharing)
                    }
                    (SessionMode::Live, None) => {
                        session.targets_deadline = Some(now + TARGETS_WAIT);
                        None
                    }
                };
                // A session that never reported its end (a missed terminal
                // status) is replaced, never closed with a made-up stop.
                self.active = Some(session);
                facts.into_iter().collect()
            }
            RecordingState::Idle | RecordingState::Failed => {
                let matches = self.active.as_ref().is_some_and(|session| {
                    status
                        .session_id
                        .as_deref()
                        .is_none_or(|id| id == session.session_id)
                });
                if !matches {
                    return Vec::new();
                }
                let Some(mut session) = self.active.take() else {
                    return Vec::new();
                };
                let mut facts = Vec::new();
                facts.extend(start_fact(&mut session, sharing));
                if session.shared && sharing {
                    let duration_seconds = status
                        .duration_ms
                        .map(|ms| u64::try_from(ms.max(0)).unwrap_or(0) / 1000)
                        .unwrap_or_else(|| {
                            u64::try_from((now - session.started_at).num_seconds().max(0))
                                .unwrap_or(0)
                        })
                        .min(MAX_DURATION_SECONDS);
                    facts.push(SessionFact {
                        event: StreamEventKind::StreamStop,
                        mode: session.mode,
                        destinations_count: session.destinations_count,
                        platforms: session.platforms.clone(),
                        duration_seconds: Some(duration_seconds),
                    });
                }
                facts
            }
            RecordingState::Starting | RecordingState::Stopping => Vec::new(),
        }
    }

    fn observe_targets(
        &mut self,
        snapshot: StreamTargetsSnapshot,
        sharing: bool,
    ) -> Vec<SessionFact> {
        match self.active.as_mut() {
            Some(session) if session.session_id == snapshot.session_id => {
                if session.start_sent || session.mode != SessionMode::Live {
                    return Vec::new();
                }
                apply_targets(session, &snapshot);
                start_fact(session, sharing).into_iter().collect()
            }
            _ => {
                self.early_targets = Some(snapshot);
                Vec::new()
            }
        }
    }
}

fn apply_targets(session: &mut TrackedSession, snapshot: &StreamTargetsSnapshot) {
    let mut platforms: Vec<String> = snapshot
        .targets
        .iter()
        .map(|target| stream_platform_id(target.platform).to_string())
        .collect();
    platforms.sort();
    platforms.dedup();
    session.destinations_count = u32::try_from(snapshot.targets.len()).unwrap_or(u32::MAX);
    session.platforms = platforms;
}

/// The session's start, once. A live session whose destinations never
/// arrived still went live to at least one.
fn start_fact(session: &mut TrackedSession, sharing: bool) -> Option<SessionFact> {
    if session.start_sent {
        return None;
    }
    session.start_sent = true;
    session.targets_deadline = None;
    if session.mode == SessionMode::Live && session.destinations_count == 0 {
        session.destinations_count = 1;
    }
    (session.shared && sharing).then(|| SessionFact {
        event: StreamEventKind::StreamStart,
        mode: session.mode,
        destinations_count: session.destinations_count,
        platforms: session.platforms.clone(),
        duration_seconds: None,
    })
}

// ---------------------------------------------------------------------------
// Delivery decisions (pure)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SendOutcome {
    /// Stored (202) or already stored: drop it from the queue.
    Delivered,
    /// The web refused the event itself (a 4xx other than 408 and 429):
    /// sending it again cannot help, so drop it.
    Refused,
    /// Try again later: 408, 429, 5xx or no answer.
    Retry { after: Option<Duration> },
}

pub(crate) fn classify_response(status: u16, retry_after: Option<Duration>) -> SendOutcome {
    match status {
        200..=299 => SendOutcome::Delivered,
        408 | 429 => SendOutcome::Retry { after: retry_after },
        400..=499 => SendOutcome::Refused,
        _ => SendOutcome::Retry { after: retry_after },
    }
}

/// 30 s, doubling per failed attempt, at most 30 min; a longer Retry-After
/// wins, up to an hour.
pub(crate) fn retry_delay(attempts: u32, retry_after: Option<Duration>) -> Duration {
    let backoff = RETRY_MIN
        .saturating_mul(2u32.saturating_pow(attempts.saturating_sub(1).min(16)))
        .min(RETRY_MAX);
    retry_after
        .map(|after| after.min(Duration::from_secs(60 * 60)))
        .map_or(backoff, |after| after.max(backoff))
}

/// Drops expired events and keeps the newest `QUEUE_CAP`. Returns whether
/// anything changed.
fn prune_queue(queue: &mut Vec<QueuedEvent>, now: DateTime<Utc>) -> bool {
    let before = queue.len();
    queue.retain(|item| now - item.queued_at <= MAX_EVENT_AGE);
    if queue.len() > QUEUE_CAP {
        let excess = queue.len() - QUEUE_CAP;
        queue.drain(..excess);
    }
    queue.len() != before
}

fn env_disables(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        )
    })
}

fn valid_install_id(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| !id.is_nil())
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/// Held in `AppState`. Off until boot reads the setting.
#[derive(Debug, Default)]
pub struct UsageStatsRuntime {
    enabled: AtomicBool,
    env_disabled: AtomicBool,
    /// Wakes the sender when the setting changes.
    changed: Notify,
    /// Serializes every read-modify-write of the persisted queue.
    queue_lock: Mutex<()>,
}

impl UsageStatsRuntime {
    fn sharing(&self) -> bool {
        self.enabled.load(Ordering::Acquire) && !self.env_disabled.load(Ordering::Acquire)
    }

    fn state(&self) -> UsageStatsState {
        UsageStatsState {
            enabled: self.sharing(),
            env_disabled: self.env_disabled.load(Ordering::Acquire),
        }
    }
}

fn load_enabled_setting(state: &AppState) -> bool {
    state
        .database
        .load_setting::<bool>(ENABLED_SETTING_KEY)
        .unwrap_or_else(|error| {
            tracing::warn!("Could not read the usage stats setting: {error}");
            None
        })
        .unwrap_or(true)
}

/// This install's id, made and saved the first time it is asked for.
fn ensure_install_id(state: &AppState) -> Option<String> {
    match state
        .database
        .load_setting::<String>(INSTALL_ID_SETTING_KEY)
    {
        Ok(Some(id)) if valid_install_id(&id) => return Some(id.to_ascii_lowercase()),
        Ok(_) => {}
        Err(error) => {
            tracing::warn!("Could not read the install id: {error}");
            return None;
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    match state.database.save_setting(INSTALL_ID_SETTING_KEY, &id) {
        Ok(()) => Some(id),
        Err(error) => {
            tracing::warn!("Could not save the install id: {error}");
            None
        }
    }
}

pub(crate) fn current_state(state: &AppState) -> UsageStatsState {
    state.usage_stats.state()
}

/// Settings → General → Privacy. Off takes effect before this returns:
/// nothing new is queued and the queue is emptied.
pub(crate) async fn set_enabled(
    state: &AppState,
    enabled: bool,
) -> anyhow::Result<UsageStatsState> {
    state.database.save_setting(ENABLED_SETTING_KEY, &enabled)?;
    let runtime = &state.usage_stats;
    runtime.enabled.store(enabled, Ordering::Release);
    if !runtime.sharing() {
        let _guard = runtime.queue_lock.lock().await;
        state
            .database
            .save_setting(QUEUE_SETTING_KEY, &Vec::<QueuedEvent>::new())?;
    }
    runtime.changed.notify_one();
    Ok(runtime.state())
}

/// Boot: read the setting, make the install id, start the observer and the
/// sender. Never fails the backend.
pub(crate) fn spawn(state: &AppState) {
    let runtime = state.usage_stats.clone();
    runtime.env_disabled.store(
        env_disables(std::env::var(DISABLE_ENV_VAR).ok().as_deref()),
        Ordering::Release,
    );
    runtime
        .enabled
        .store(load_enabled_setting(state), Ordering::Release);
    let Some(install_id) = ensure_install_id(state) else {
        return;
    };
    let (facts, receiver) = mpsc::channel(FACT_CHANNEL_CAPACITY);
    tokio::spawn(run_observer(state.clone(), state.events.subscribe(), facts));
    tokio::spawn(run_sender(state.clone(), install_id, receiver));
}

async fn run_observer(
    state: AppState,
    mut events: broadcast::Receiver<ServerEvent>,
    facts: mpsc::Sender<SessionFact>,
) {
    let mut tracker = SessionTracker::default();
    loop {
        let deadline = tracker.next_deadline().map(|deadline| {
            let wait = (deadline - Utc::now()).to_std().unwrap_or_default();
            tokio::time::Instant::now() + wait
        });
        let observed = tokio::select! {
            received = events.recv() => match received {
                // A benchmark session (Health → performance check) is hidden
                // from every client; it is not a session the user started.
                Ok(event) if state.performance_check.suppresses_event(&event.event) => Vec::new(),
                Ok(event) => tracker.observe(&event, Utc::now(), state.usage_stats.sharing()),
                Err(broadcast::error::RecvError::Lagged(_)) => Vec::new(),
                Err(broadcast::error::RecvError::Closed) => return,
            },
            () = sleep_until_deadline(deadline) => {
                tracker.poll_deadline(Utc::now(), state.usage_stats.sharing())
            }
        };
        for fact in observed {
            // Never waits: a full channel drops the fact rather than lag the bus.
            if facts.try_send(fact).is_err() {
                tracing::debug!("Usage stats: dropped an event (sender busy).");
            }
        }
    }
}

async fn sleep_until_deadline(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

async fn run_sender(state: AppState, install_id: String, mut facts: mpsc::Receiver<SessionFact>) {
    let Some(client) = http_client() else {
        return;
    };
    let endpoint = format!("{}{EVENTS_PATH}", crate::videorc_api::api_base_url());
    let runtime = state.usage_stats.clone();
    let mut next_flush = Some(tokio::time::Instant::now() + STARTUP_FLUSH_DELAY);
    // Set while the web asked to wait: a new event joins the queue but does
    // not jump that wait.
    let mut backoff_until: Option<tokio::time::Instant> = None;
    let soonest = |backoff_until: Option<tokio::time::Instant>| {
        let now = tokio::time::Instant::now();
        backoff_until.map_or(now, |until| until.max(now))
    };
    loop {
        tokio::select! {
            received = facts.recv() => {
                let Some(fact) = received else { return };
                if runtime.sharing() {
                    enqueue(&state, payload_for(&install_id, fact)).await;
                    next_flush = Some(soonest(backoff_until));
                }
            }
            () = runtime.changed.notified() => {
                next_flush = runtime.sharing().then(|| soonest(backoff_until));
            }
            () = sleep_until_deadline(next_flush) => {
                backoff_until = flush(&state, &client, &endpoint)
                    .await
                    .map(|after| tokio::time::Instant::now() + after);
                next_flush = backoff_until;
            }
        }
    }
}

fn payload_for(install_id: &str, fact: SessionFact) -> StreamEventPayload {
    StreamEventPayload {
        event_id: uuid::Uuid::new_v4().to_string(),
        install_id: install_id.to_string(),
        event: fact.event,
        mode: fact.mode,
        app_version: crate::performance_check::desktop_app_version(),
        os: std::env::consts::OS.to_string(),
        destinations_count: fact.destinations_count,
        platforms: fact.platforms,
        duration_seconds: fact.duration_seconds,
    }
}

fn load_queue(state: &AppState) -> Vec<QueuedEvent> {
    state
        .database
        .load_setting::<Vec<QueuedEvent>>(QUEUE_SETTING_KEY)
        .unwrap_or_else(|error| {
            tracing::warn!("Usage stats queue unreadable, starting empty: {error}");
            None
        })
        .unwrap_or_default()
}

fn save_queue(state: &AppState, queue: &[QueuedEvent]) {
    if let Err(error) = state.database.save_setting(QUEUE_SETTING_KEY, &queue) {
        tracing::warn!("Could not save the usage stats queue: {error}");
    }
}

async fn enqueue(state: &AppState, payload: StreamEventPayload) {
    let _guard = state.usage_stats.queue_lock.lock().await;
    let now = Utc::now();
    let mut queue = load_queue(state);
    queue.push(QueuedEvent {
        payload,
        queued_at: now,
        attempts: 0,
    });
    prune_queue(&mut queue, now);
    save_queue(state, &queue);
}

/// Sends queued events oldest first until the queue is empty (None) or the
/// web asks to wait (the delay before the next try).
async fn flush(state: &AppState, client: &reqwest::Client, endpoint: &str) -> Option<Duration> {
    loop {
        if !state.usage_stats.sharing() {
            return None;
        }
        let next = {
            let _guard = state.usage_stats.queue_lock.lock().await;
            let mut queue = load_queue(state);
            if prune_queue(&mut queue, Utc::now()) {
                save_queue(state, &queue);
            }
            queue.first().cloned()
        };
        let item = next?;
        let outcome = send(client, endpoint, &item.payload).await;
        let _guard = state.usage_stats.queue_lock.lock().await;
        let mut queue = load_queue(state);
        let position = queue
            .iter()
            .position(|queued| queued.payload.event_id == item.payload.event_id);
        match outcome {
            SendOutcome::Delivered | SendOutcome::Refused => {
                if let Some(position) = position {
                    queue.remove(position);
                    save_queue(state, &queue);
                }
                if outcome == SendOutcome::Refused {
                    tracing::debug!("Usage stats: the web refused an event; dropped it.");
                }
            }
            SendOutcome::Retry { after } => {
                let attempts = item.attempts.saturating_add(1);
                if let Some(position) = position
                    && let Some(queued) = queue.get_mut(position)
                {
                    queued.attempts = attempts;
                    save_queue(state, &queue);
                }
                return Some(retry_delay(attempts, after));
            }
        }
    }
}

async fn send(
    client: &reqwest::Client,
    endpoint: &str,
    payload: &StreamEventPayload,
) -> SendOutcome {
    let mut request = client.post(endpoint).json(payload);
    // Read at send time: the web links the event to whoever is signed in
    // now, and a signed-out desktop sends none.
    if let Some(token) = crate::account::stored_session_token() {
        request = request.bearer_auth(token);
    }
    match request.send().await {
        Ok(response) => {
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse::<u64>().ok())
                .map(Duration::from_secs);
            classify_response(response.status().as_u16(), retry_after)
        }
        Err(_) => SendOutcome::Retry { after: None },
    }
}

fn http_client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(concat!("Videorc-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::streaming::{StreamPlatform, StreamTargetRuntime, StreamTargetState};
    use serde_json::json;

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-13T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
            + chrono::TimeDelta::seconds(seconds)
    }

    fn status(state: &str, session_id: &str, extra: serde_json::Value) -> ServerEvent {
        let mut payload = json!({ "state": state, "sessionId": session_id });
        if let (Some(payload), Some(extra)) = (payload.as_object_mut(), extra.as_object()) {
            payload.extend(extra.clone());
        }
        ServerEvent {
            event: "recording.status".to_string(),
            payload,
        }
    }

    fn targets(session_id: &str, platforms: &[StreamPlatform]) -> ServerEvent {
        let snapshot = StreamTargetsSnapshot {
            session_id: session_id.to_string(),
            targets: platforms
                .iter()
                .enumerate()
                .map(|(index, platform)| StreamTargetRuntime {
                    target_id: format!("target-{index}"),
                    platform: *platform,
                    label: format!("Destination {index}"),
                    state: StreamTargetState::Connecting,
                    message: None,
                    redacted_url: Some("rtmp://example.invalid/live/••••".to_string()),
                })
                .collect(),
        };
        ServerEvent {
            event: "stream.targets".to_string(),
            payload: serde_json::to_value(snapshot).unwrap(),
        }
    }

    fn live_running(session_id: &str) -> ServerEvent {
        status(
            "recording",
            session_id,
            json!({
                "outputPath": "/tmp/videorc/a.mkv",
                "streamUrl": "rtmp://example.invalid/live/••••",
                "startedAt": "2026-10-13T12:00:00Z"
            }),
        )
    }

    #[test]
    fn a_recording_starts_at_once_and_stops_with_its_duration() {
        let mut tracker = SessionTracker::default();
        let started = tracker.observe(
            &status(
                "recording",
                "s1",
                json!({ "outputPath": "/tmp/a.mkv", "startedAt": "2026-10-13T12:00:00Z" }),
            ),
            at(0),
            true,
        );
        assert_eq!(
            started,
            vec![SessionFact {
                event: StreamEventKind::StreamStart,
                mode: SessionMode::Recording,
                destinations_count: 0,
                platforms: Vec::new(),
                duration_seconds: None,
            }]
        );
        let stopped = tracker.observe(
            &status("idle", "s1", json!({ "durationMs": 125_900 })),
            at(130),
            true,
        );
        assert_eq!(stopped.len(), 1);
        assert_eq!(stopped[0].event, StreamEventKind::StreamStop);
        assert_eq!(stopped[0].duration_seconds, Some(125));
        assert_eq!(tracker.next_deadline(), None);
    }

    #[test]
    fn a_live_start_waits_for_its_destinations_and_names_each_platform_once() {
        let mut tracker = SessionTracker::default();
        assert!(tracker.observe(&live_running("s1"), at(0), true).is_empty());
        assert_eq!(tracker.next_deadline(), Some(at(15)));
        let started = tracker.observe(
            &targets(
                "s1",
                &[
                    StreamPlatform::Youtube,
                    StreamPlatform::Twitch,
                    StreamPlatform::Youtube,
                ],
            ),
            at(1),
            true,
        );
        assert_eq!(
            started,
            vec![SessionFact {
                event: StreamEventKind::StreamStart,
                mode: SessionMode::Live,
                destinations_count: 3,
                platforms: vec!["twitch".to_string(), "youtube".to_string()],
                duration_seconds: None,
            }]
        );
        // Later per-target state changes re-emit the snapshot: no second start.
        assert!(
            tracker
                .observe(&targets("s1", &[StreamPlatform::Youtube]), at(2), true)
                .is_empty()
        );
        let stopped = tracker.observe(&status("idle", "s1", json!({})), at(3_600), true);
        assert_eq!(stopped.len(), 1);
        assert_eq!(stopped[0].mode, SessionMode::Live);
        assert_eq!(stopped[0].destinations_count, 3);
        // No durationMs: measured from startedAt.
        assert_eq!(stopped[0].duration_seconds, Some(3_600));
    }

    #[test]
    fn targets_that_arrive_before_the_running_status_still_count() {
        let mut tracker = SessionTracker::default();
        assert!(
            tracker
                .observe(&targets("s1", &[StreamPlatform::Kick]), at(0), true)
                .is_empty()
        );
        let started = tracker.observe(&live_running("s1"), at(1), true);
        assert_eq!(started.len(), 1);
        assert_eq!(started[0].platforms, vec!["kick".to_string()]);
    }

    #[test]
    fn a_live_start_without_destinations_goes_out_at_the_deadline() {
        let mut tracker = SessionTracker::default();
        tracker.observe(
            &status(
                "streaming",
                "s1",
                json!({ "streamUrl": "rtmp://x.invalid/••••" }),
            ),
            at(0),
            true,
        );
        assert!(tracker.poll_deadline(at(14), true).is_empty());
        let started = tracker.poll_deadline(at(15), true);
        assert_eq!(started.len(), 1);
        assert_eq!(started[0].mode, SessionMode::Live);
        assert_eq!(started[0].destinations_count, 1);
        assert_eq!(tracker.next_deadline(), None);
        assert!(tracker.poll_deadline(at(30), true).is_empty());
    }

    #[test]
    fn a_session_that_ends_before_its_destinations_sends_start_then_stop() {
        let mut tracker = SessionTracker::default();
        tracker.observe(&live_running("s1"), at(0), true);
        let facts = tracker.observe(
            &status("failed", "s1", json!({ "durationMs": 2_000 })),
            at(2),
            true,
        );
        assert_eq!(
            facts.iter().map(|fact| fact.event).collect::<Vec<_>>(),
            vec![StreamEventKind::StreamStart, StreamEventKind::StreamStop]
        );
    }

    #[test]
    fn a_refused_start_and_another_sessions_end_are_not_counted() {
        let mut tracker = SessionTracker::default();
        assert!(
            tracker
                .observe(&status("failed", "never-ran", json!({})), at(0), true)
                .is_empty()
        );
        tracker.observe(
            &status("recording", "s1", json!({ "outputPath": "/tmp/a.mkv" })),
            at(0),
            true,
        );
        assert!(
            tracker
                .observe(&status("idle", "s0", json!({})), at(5), true)
                .is_empty()
        );
        // Repeated running statuses for the same session start it once.
        assert!(
            tracker
                .observe(
                    &status("recording", "s1", json!({ "outputPath": "/tmp/a.mkv" })),
                    at(6),
                    true
                )
                .is_empty()
        );
        assert!(
            tracker
                .observe(&status("starting", "s2", json!({})), at(7), true)
                .is_empty()
        );
    }

    #[test]
    fn nothing_is_shared_while_off_and_a_session_never_shares_half() {
        let mut tracker = SessionTracker::default();
        // Started while off: neither half goes out, even if turned on mid-way.
        assert!(
            tracker
                .observe(
                    &status("recording", "s1", json!({ "outputPath": "/tmp/a.mkv" })),
                    at(0),
                    false
                )
                .is_empty()
        );
        assert!(
            tracker
                .observe(&status("idle", "s1", json!({})), at(10), true)
                .is_empty()
        );
        // Started while on, turned off before the end: no stop.
        assert_eq!(
            tracker
                .observe(
                    &status("recording", "s2", json!({ "outputPath": "/tmp/b.mkv" })),
                    at(20),
                    true
                )
                .len(),
            1
        );
        assert!(
            tracker
                .observe(&status("idle", "s2", json!({})), at(30), false)
                .is_empty()
        );
    }

    #[test]
    fn the_payload_carries_no_stream_details_and_matches_the_web_contract() {
        let mut fact = SessionFact {
            event: StreamEventKind::StreamStop,
            mode: SessionMode::Live,
            destinations_count: 2,
            platforms: vec!["twitch".to_string(), "youtube".to_string()],
            duration_seconds: Some(42),
        };
        let payload = payload_for("6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7", fact.clone());
        let value = serde_json::to_value(&payload).unwrap();
        let mut keys: Vec<_> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "appVersion",
                "destinationsCount",
                "durationSeconds",
                "event",
                "eventId",
                "installId",
                "mode",
                "os",
                "platforms",
            ]
        );
        assert_eq!(value["event"], "stream_stop");
        assert_eq!(value["mode"], "live");
        assert_eq!(value["os"], std::env::consts::OS);
        assert!(uuid::Uuid::parse_str(&payload.event_id).is_ok());

        fact.event = StreamEventKind::StreamStart;
        fact.duration_seconds = None;
        let start = serde_json::to_value(payload_for("id", fact)).unwrap();
        assert!(start.get("durationSeconds").is_none());
        assert_ne!(
            payload_for(
                "id",
                SessionFact {
                    event: StreamEventKind::StreamStart,
                    mode: SessionMode::Recording,
                    destinations_count: 0,
                    platforms: Vec::new(),
                    duration_seconds: None,
                }
            )
            .event_id,
            payload.event_id
        );
    }

    #[test]
    fn durations_are_clamped_to_a_week() {
        let mut tracker = SessionTracker::default();
        tracker.observe(
            &status("recording", "s1", json!({ "outputPath": "/tmp/a.mkv" })),
            at(0),
            true,
        );
        let stopped = tracker.observe(
            &status(
                "idle",
                "s1",
                json!({ "durationMs": 30_i64 * 24 * 60 * 60 * 1000 }),
            ),
            at(1),
            true,
        );
        assert_eq!(stopped[0].duration_seconds, Some(MAX_DURATION_SECONDS));
    }

    #[test]
    fn responses_are_delivered_dropped_or_retried() {
        assert_eq!(classify_response(202, None), SendOutcome::Delivered);
        assert_eq!(classify_response(400, None), SendOutcome::Refused);
        assert_eq!(classify_response(413, None), SendOutcome::Refused);
        assert_eq!(
            classify_response(429, Some(Duration::from_secs(60))),
            SendOutcome::Retry {
                after: Some(Duration::from_secs(60))
            }
        );
        assert_eq!(
            classify_response(408, None),
            SendOutcome::Retry { after: None }
        );
        assert_eq!(
            classify_response(503, None),
            SendOutcome::Retry { after: None }
        );
    }

    #[test]
    fn retries_back_off_and_honor_a_longer_retry_after() {
        assert_eq!(retry_delay(1, None), Duration::from_secs(30));
        assert_eq!(retry_delay(2, None), Duration::from_secs(60));
        assert_eq!(retry_delay(3, None), Duration::from_secs(120));
        assert_eq!(retry_delay(40, None), RETRY_MAX);
        assert_eq!(
            retry_delay(1, Some(Duration::from_secs(3_600))),
            Duration::from_secs(3_600)
        );
        assert_eq!(
            retry_delay(1, Some(Duration::from_secs(86_400))),
            Duration::from_secs(3_600)
        );
        assert_eq!(
            retry_delay(3, Some(Duration::from_secs(1))),
            Duration::from_secs(120)
        );
    }

    #[test]
    fn the_queue_drops_week_old_events_and_keeps_the_newest_fifty() {
        let item = |seconds: i64, attempts: u32| QueuedEvent {
            payload: payload_for(
                "install",
                SessionFact {
                    event: StreamEventKind::StreamStart,
                    mode: SessionMode::Recording,
                    destinations_count: 0,
                    platforms: Vec::new(),
                    duration_seconds: None,
                },
            ),
            queued_at: at(seconds),
            attempts,
        };
        let mut queue = vec![item(-8 * 24 * 60 * 60, 1), item(0, 2)];
        assert!(prune_queue(&mut queue, at(1)));
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].attempts, 2);

        let mut full: Vec<_> = (0..60).map(|index| item(index, 0)).collect();
        assert!(prune_queue(&mut full, at(61)));
        assert_eq!(full.len(), QUEUE_CAP);
        assert_eq!(full[0].queued_at, at(10));
        assert!(!prune_queue(&mut full, at(61)));
    }

    #[test]
    fn the_env_switch_only_turns_sharing_off() {
        for off in ["0", "false", "OFF", " no "] {
            assert!(env_disables(Some(off)), "{off}");
        }
        for other in ["1", "true", "on", ""] {
            assert!(!env_disables(Some(other)), "{other}");
        }
        assert!(!env_disables(None));
    }

    #[test]
    fn install_ids_must_be_real_uuids() {
        assert!(valid_install_id("6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7"));
        assert!(!valid_install_id("00000000-0000-0000-0000-000000000000"));
        assert!(!valid_install_id("install-1"));
        assert!(!valid_install_id(""));
    }

    #[test]
    fn set_params_refuse_unknown_fields() {
        assert!(serde_json::from_value::<UsageStatsSetParams>(json!({ "enabled": false })).is_ok());
        assert!(
            serde_json::from_value::<UsageStatsSetParams>(json!({ "enabled": false, "x": 1 }))
                .is_err()
        );
        assert_eq!(
            serde_json::to_value(UsageStatsState {
                enabled: true,
                env_disabled: false
            })
            .unwrap(),
            json!({ "enabled": true, "envDisabled": false })
        );
    }
}
