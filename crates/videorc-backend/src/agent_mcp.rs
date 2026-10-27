//! The Agents listener (plan 209 S2): Videorc MCP on its own loopback port.
//!
//! This is deliberately its own `Router` on its own `TcpListener`, like Phone
//! remote's. The main router serves preview frames, posters, OAuth callbacks
//! and `/ws`; none of that is reachable through this port, and this router
//! serves `/mcp` and nothing else. The listener exists only while Agents is
//! on: off means the port is closed (D5).
//!
//! Admission, in order (Security table): `Host` must be this listener's own
//! loopback authority (else 421, DNS rebinding), any `Origin` header is
//! refused (403, a browser page), only POST exists (405), and a Bearer token
//! must belong to a connected agent (else 401). The agent's identity rides
//! the request to the tool executors; per-agent rate limits run per call.
//!
//! The MCP framing itself (JSON-RPC over Streamable HTTP, stateless, JSON
//! responses) is `rmcp`'s; `agent_call.rs` (S3) answers `tools/call`.
//!
//! The Agent role (`BackendRole::Agent`) exists only here: `/ws` never
//! authenticates an agent token, and `backend_authority` admits the role to
//! no websocket method.

use std::collections::{HashMap, VecDeque};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use axum::Router;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use serde::{Deserialize, Serialize};

use crate::agent_registry::{AgentClientKind, AgentIdentity, AgentLastAction, AgentRegistry};
use crate::agent_tools::AgentRateFamily;
use crate::backend_authority::BackendRole;
use crate::state::AppState;
use crate::storage::{AgentActivityEntry, AgentActivityOutcome};

pub const AGENT_PREFERRED_PORT: u16 = 7440;
/// 7440 to 7449; Phone remote scans 7420 to 7429.
pub const AGENT_PORT_SCAN: u16 = 10;
pub const AGENT_PROTOCOL: u32 = 1;
/// A tool call is a few hundred bytes; a 256 KiB body is already an attack.
pub const MAX_REQUEST_BODY_BYTES: usize = 256 * 1024;
/// S3: how long a Studio tool waits for the renderer's ack.
pub const STUDIO_INTENT_TIMEOUT: Duration = Duration::from_secs(15);
pub const GO_LIVE_INTENT_TIMEOUT: Duration = Duration::from_secs(60);
pub const ACTIVITY_LIST_DEFAULT: usize = 100;

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/// The Studio's answer to an `agent.intent` event (S3).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentIntentAck {
    pub intent_id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
}

/// Why the listener could not bind, as Settings branches on it (S7).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentBindErrorKind {
    /// Every port from 7440 to 7449 is taken by another app.
    PortsBusy,
    /// Anything else the OS said (a refused or unavailable address).
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentBindError {
    pub kind: AgentBindErrorKind,
    /// The OS's own words, for the log and the console; Settings shows copy.
    pub message: String,
}

#[derive(Default)]
pub struct AgentMcpRuntime {
    pub bound_port: Option<u16>,
    pub bind_error: Option<AgentBindError>,
    server: Option<tokio::sync::oneshot::Sender<()>>,
    pub limiter: AgentRateLimiter,
    /// S3: Studio intents waiting for their ack, by intent id.
    pub pending_intents: HashMap<String, tokio::sync::oneshot::Sender<AgentIntentAck>>,
    pub next_intent: u64,
    /// S3: the Studio's projection for `get_status` and the `list_*` tools,
    /// published through `agent.surface.publish` and deduped.
    pub surface: Option<serde_json::Value>,
}

pub struct AgentMcpShared {
    pub runtime: StdMutex<AgentMcpRuntime>,
    /// Sockets that run agent intents: the Studio's, once it asked with
    /// `agent.intent.listen`. A Studio tool needs one (S3). Other renderer
    /// sockets (the Agents store, a Settings row's own client) never count:
    /// they would neither run nor ack an intent.
    pub studio_sockets: AtomicUsize,
}

pub type AgentMcpSlot = std::sync::Arc<AgentMcpShared>;

pub fn new_agent_mcp_slot() -> AgentMcpSlot {
    std::sync::Arc::new(AgentMcpShared {
        runtime: StdMutex::new(AgentMcpRuntime::default()),
        studio_sockets: AtomicUsize::new(0),
    })
}

impl AgentMcpShared {
    pub fn lock(&self) -> std::sync::MutexGuard<'_, AgentMcpRuntime> {
        self.runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn studio_open(&self) -> bool {
        self.studio_sockets.load(Ordering::Relaxed) > 0
    }
}

/// One socket counted in `studio_sockets` (`agent.intent.listen`) until it
/// closes. A Drop guard, so every exit path of the socket uncounts it.
pub struct StudioSocketGuard(AppState);

impl StudioSocketGuard {
    pub fn attach(state: &AppState) -> Self {
        state.agents.studio_sockets.fetch_add(1, Ordering::Relaxed);
        Self(state.clone())
    }
}

impl Drop for StudioSocketGuard {
    fn drop(&mut self) {
        self.0.agents.studio_sockets.fetch_sub(1, Ordering::Relaxed);
    }
}

fn registry(state: &AppState) -> std::sync::MutexGuard<'_, AgentRegistry> {
    state
        .agent_registry
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// Rate limits (Security table)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct RateRule {
    pub count: usize,
    pub window: Duration,
    /// The refusal's noun phrase ("20 actions every 10 seconds").
    pub sentence: &'static str,
}

/// Per agent: 20 actions per 10 s; chat posts 1 per 2 s and 20 a minute;
/// removals 10 a minute; go_live and stop once per 10 s. Reads are bounded
/// too, generously, so a polling loop cannot starve the Studio.
pub fn rate_rules(family: AgentRateFamily) -> &'static [RateRule] {
    const SECONDS_2: Duration = Duration::from_secs(2);
    const SECONDS_10: Duration = Duration::from_secs(10);
    const MINUTE: Duration = Duration::from_secs(60);
    match family {
        AgentRateFamily::Read => &[RateRule {
            count: 60,
            window: SECONDS_10,
            sentence: "60 reads every 10 seconds",
        }],
        AgentRateFamily::Action => &[RateRule {
            count: 20,
            window: SECONDS_10,
            sentence: "20 actions every 10 seconds",
        }],
        AgentRateFamily::Chat => &[
            RateRule {
                count: 1,
                window: SECONDS_2,
                sentence: "one chat message every 2 seconds",
            },
            RateRule {
                count: 20,
                window: MINUTE,
                sentence: "20 chat messages a minute",
            },
        ],
        AgentRateFamily::Removal => &[RateRule {
            count: 10,
            window: MINUTE,
            sentence: "10 removals a minute",
        }],
        AgentRateFamily::Session => &[RateRule {
            count: 1,
            window: SECONDS_10,
            sentence: "one go-live or stop every 10 seconds",
        }],
    }
}

#[derive(Debug, Default)]
pub struct AgentRateLimiter {
    windows: HashMap<(String, AgentRateFamily), VecDeque<Instant>>,
}

impl AgentRateLimiter {
    /// Admit a call or refuse it with the sentence the agent reads.
    pub fn admit(
        &mut self,
        agent_id: &str,
        family: AgentRateFamily,
        now: Instant,
    ) -> std::result::Result<(), String> {
        let rules = rate_rules(family);
        let longest = rules
            .iter()
            .map(|rule| rule.window)
            .max()
            .unwrap_or_default();
        let key = (agent_id.to_string(), family);
        let window = self.windows.entry(key).or_default();
        while window
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) >= longest)
        {
            window.pop_front();
        }
        for rule in rules {
            let inside = window
                .iter()
                .filter(|at| now.saturating_duration_since(**at) < rule.window)
                .count();
            if inside >= rule.count {
                return Err(format!("Slow down: at most {}.", rule.sentence));
            }
        }
        window.push_back(now);
        // Keys for removed agents expire with their windows.
        self.windows.retain(|_, window| !window.is_empty());
        Ok(())
    }

    pub fn forget(&mut self, agent_id: &str) {
        self.windows.retain(|(id, _), _| id != agent_id);
    }
}

// ---------------------------------------------------------------------------
// Status and the renderer/admin RPCs
// ---------------------------------------------------------------------------

/// Renderer/admin-only. Carries no token: tokens exist once, in
/// `agents.create`'s answer.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub id: String,
    pub name: String,
    pub client: AgentClientKind,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_action: Option<AgentLastAction>,
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentsStatus {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bind_error: Option<String>,
    /// What Settings branches on; `bind_error` keeps the OS's words.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bind_error_kind: Option<AgentBindErrorKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discovery_path: Option<String>,
    pub agents: Vec<AgentSummary>,
    pub connected_count: usize,
    pub studio_open: bool,
}

/// `agents.create`'s answer: the one time the token exists in the clear.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCreated {
    pub agent: AgentSummary,
    pub token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentParams {
    pub name: String,
    pub client: AgentClientKind,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentIdParams {
    pub id: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityListParams {
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub agent_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPage {
    pub entries: Vec<AgentActivityEntry>,
}

pub fn status(state: &AppState) -> AgentsStatus {
    seed_last_actions(state);
    let now = Instant::now();
    let registry = registry(state);
    let (port, bind_error) = {
        let runtime = state.agents.lock();
        (runtime.bound_port, runtime.bind_error.clone())
    };
    AgentsStatus {
        enabled: registry.persisted.enabled,
        port,
        bind_error_kind: bind_error.as_ref().map(|error| error.kind),
        bind_error: bind_error.map(|error| error.message),
        discovery_path: discovery_path(state.database.path())
            .map(|path| path.display().to_string()),
        agents: registry
            .persisted
            .agents
            .iter()
            .map(|agent| AgentSummary {
                id: agent.id.clone(),
                name: agent.name.clone(),
                client: agent.client,
                created_at: agent.created_at.clone(),
                last_used_at: agent.last_used_at.clone(),
                last_action: registry.last_action(&agent.id).cloned(),
                connected: registry.connected(&agent.id, now),
            })
            .collect(),
        connected_count: registry.connected_count(now),
        studio_open: state.agents.studio_open(),
    }
}

/// The last action lives in memory; after a restart each agent's newest
/// Activity row says what it did last, so Settings never reads "Last seen"
/// for an agent that acted. Asked once per agent, outside the registry lock.
fn seed_last_actions(state: &AppState) {
    let missing = registry(state).last_actions_to_seed();
    for id in missing {
        match state.database.list_agent_activity(1, Some(&id)) {
            Ok(rows) => registry(state).seed_last_action(
                &id,
                rows.into_iter().next().map(|row| AgentLastAction {
                    tool: row.tool,
                    at: row.at,
                    outcome: row.outcome,
                }),
            ),
            // Not marked as seeded: the next status read asks again.
            Err(error) => tracing::warn!("Could not read the agent's last action: {error:#}"),
        }
    }
}

pub fn publish_status(state: &AppState) -> AgentsStatus {
    let status = status(state);
    state.emit_event("agents.status", status.clone());
    status
}

fn persist(state: &AppState) -> Result<()> {
    registry(state).persist()
}

pub async fn enable(state: &AppState) -> Result<AgentsStatus> {
    registry(state).persisted.enabled = true;
    persist(state)?;
    start_if_enabled(state).await;
    sync_discovery_file(state)?;
    Ok(publish_status(state))
}

/// Off, and Stop (D12): the port closes, every agent reads as disconnected,
/// and the next bridge call answers "Turn on Agents in Videorc → Settings →
/// Remote." The agents and their tokens stay for the next switch-on.
pub fn disable(state: &AppState) -> Result<AgentsStatus> {
    {
        let mut registry = registry(state);
        registry.persisted.enabled = false;
        registry.disconnect_all();
    }
    persist(state)?;
    stop(state);
    sync_discovery_file(state)?;
    Ok(publish_status(state))
}

pub fn create_agent(
    state: &AppState,
    params: CreateAgentParams,
) -> std::result::Result<AgentCreated, String> {
    let created_at = chrono::Utc::now().to_rfc3339();
    let (record, token) = registry(state).create(&params.name, params.client, &created_at)?;
    if let Err(error) = persist(state) {
        // An agent that would vanish on restart is worse than no agent.
        registry(state).remove(&record.id);
        return Err(format!("Couldn't save the agent: {error:#}"));
    }
    let status = publish_status(state);
    let agent = status
        .agents
        .into_iter()
        .find(|agent| agent.id == record.id)
        .ok_or_else(|| "Couldn't save the agent.".to_string())?;
    Ok(AgentCreated { agent, token })
}

/// Remove revokes the token at once: the next call with it answers 401.
pub fn remove_agent(state: &AppState, params: AgentIdParams) -> Result<AgentsStatus> {
    let removed = registry(state).remove(&params.id);
    if removed {
        persist(state)?;
        state.agents.lock().limiter.forget(&params.id);
    }
    Ok(publish_status(state))
}

pub fn activity(state: &AppState, params: ActivityListParams) -> Result<ActivityPage> {
    let entries = state.database.list_agent_activity(
        params.limit.unwrap_or(ACTIVITY_LIST_DEFAULT),
        params.agent_id.as_deref(),
    )?;
    Ok(ActivityPage { entries })
}

/// Every action lands here: the row, the `agents.activity` event and the
/// agent's last action for Settings.
///
/// `notice` (D11) is the filled catalog sentence of a successful `onAir`
/// call ("Claude Desktop ended the livestream."). It rides the event only,
/// never the stored row: the Studio shows it once, as it happens, and the
/// Activity list already says what ran.
pub fn log_activity(
    state: &AppState,
    agent: &AgentIdentity,
    tool: &str,
    summary: String,
    outcome: AgentActivityOutcome,
    message: Option<String>,
    notice: Option<String>,
) {
    let entry = AgentActivityEntry {
        id: uuid::Uuid::new_v4().to_string(),
        at: chrono::Utc::now().to_rfc3339(),
        agent_id: agent.id.clone(),
        agent_name: agent.name.clone(),
        tool: activity_tool_label(tool),
        summary,
        outcome,
        message: message.map(|text| clip_chars(&text, ACTIVITY_MESSAGE_MAX_CHARS)),
    };
    if let Err(error) = state.database.insert_agent_activity(&entry) {
        tracing::warn!("Could not record agent activity: {error:#}");
    }
    registry(state).record_action(
        &agent.id,
        AgentLastAction {
            tool: entry.tool.clone(),
            at: entry.at.clone(),
            outcome,
        },
    );
    let notice = notice
        .filter(|_| outcome == AgentActivityOutcome::Ok)
        .map(|text| clip_chars(&text, ACTIVITY_MESSAGE_MAX_CHARS));
    match (notice, serde_json::to_value(&entry)) {
        (Some(notice), Ok(serde_json::Value::Object(mut fields))) => {
            fields.insert("notice".to_string(), serde_json::Value::String(notice));
            state.emit_event("agents.activity", serde_json::Value::Object(fields));
        }
        _ => state.emit_event("agents.activity", entry),
    }
}

/// The strict contract bounds an activity row (`backend-rpc-contract.ts`):
/// a tool label of 1 to 40 characters and a message of at most 2,048. An
/// agent can call a tool name or pass an argument of any length, and the
/// refusal sentence may quote it, so both are clipped before the row exists.
pub const ACTIVITY_TOOL_MAX_CHARS: usize = 40;
pub const ACTIVITY_MESSAGE_MAX_CHARS: usize = 1_000;

pub fn activity_tool_label(tool: &str) -> String {
    let label: String = tool
        .chars()
        .filter(|character| !character.is_control())
        .collect();
    let label = clip_chars(label.trim(), ACTIVITY_TOOL_MAX_CHARS);
    if label.is_empty() {
        "unknown".to_string()
    } else {
        label
    }
}

/// At most `max` characters, the last one an ellipsis when cut.
pub fn clip_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

/// A call or heartbeat from an agent: presence for the Session line, and
/// `lastUsedAt` persisted at most once a minute.
pub fn touch_agent(state: &AppState, agent: &AgentIdentity) {
    let now = Instant::now();
    let (was_connected, persist_due, start_watch) = {
        let mut registry = registry(state);
        let was = registry.connected(&agent.id, now);
        let due = registry.touch(&agent.id, now, &chrono::Utc::now().to_rfc3339());
        (was, due, registry.claim_presence_watch())
    };
    if persist_due && let Err(error) = persist(state) {
        tracing::warn!("Could not persist the agent's last use: {error:#}");
    }
    if !was_connected {
        publish_status(state);
    }
    if start_watch {
        spawn_presence_watch(state);
    }
}

/// Presence ends without a call: the agent app quits and its bridge stops
/// pinging. While any agent is connected one task sleeps until the next
/// 45 s lapse and publishes `agents.status` when an agent dropped out, so
/// the Session line and Settings never poll. It ends with the last agent.
fn spawn_presence_watch(state: &AppState) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        // No runtime (a synchronous caller): nothing can sleep. Release the
        // claim so the next touch tries again.
        registry(state).release_presence_watch();
        return;
    };
    runtime.spawn(watch_presence(state.clone()));
}

async fn watch_presence(state: AppState) {
    let mut connected = registry(&state).connected_ids(Instant::now());
    loop {
        let (next, now_connected) = {
            let mut registry = registry(&state);
            let now = Instant::now();
            (
                registry.next_presence_lapse(now),
                registry.connected_ids(now),
            )
        };
        if connected.iter().any(|id| !now_connected.contains(id)) {
            publish_status(&state);
        }
        connected = now_connected;
        let Some(lapse) = next else {
            return;
        };
        tokio::time::sleep_until(tokio::time::Instant::from_std(lapse)).await;
    }
}

// ---------------------------------------------------------------------------
// Discovery file: `agents.json` next to the database (0600, no secret)
// ---------------------------------------------------------------------------

/// What the bridge reads (S4): the protocol, whether Agents is on, the port
/// while it is, and the backend's pid so a stale file after a crash is told
/// apart from a running app. Never a token.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentsDiscovery {
    pub protocol: u32,
    pub pid: u32,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

pub fn discovery_path(database_path: &Path) -> Option<PathBuf> {
    if database_path.to_string_lossy() == ":memory:" {
        return None;
    }
    Some(database_path.with_file_name("agents.json"))
}

/// Written while the backend runs, removed at shutdown. Born 0600: a
/// create-then-chmod sequence leaves a umask window, and even a secret-free
/// file should not announce the port to other local users.
pub fn write_discovery(path: &Path, discovery: &AgentsDiscovery) -> Result<()> {
    let body = serde_json::to_vec_pretty(discovery)?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("Could not write {}", path.display()))?;
        file.write_all(&body)
            .with_context(|| format!("Could not write {}", path.display()))?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("Could not restrict permissions on {}", path.display()))?;
    }
    #[cfg(not(unix))]
    std::fs::write(path, body).with_context(|| format!("Could not write {}", path.display()))?;
    Ok(())
}

pub fn remove_discovery(path: &Path) {
    let _ = std::fs::remove_file(path);
}

pub fn sync_discovery_file(state: &AppState) -> Result<()> {
    let Some(path) = discovery_path(state.database.path()) else {
        return Ok(());
    };
    let enabled = registry(state).persisted.enabled;
    let port = state.agents.lock().bound_port;
    write_discovery(
        &path,
        &AgentsDiscovery {
            protocol: AGENT_PROTOCOL,
            pid: std::process::id(),
            enabled,
            port: if enabled { port } else { None },
        },
    )
}

// ---------------------------------------------------------------------------
// The listener
// ---------------------------------------------------------------------------

async fn bind_listener(
    preferred: u16,
) -> std::result::Result<tokio::net::TcpListener, AgentBindError> {
    let mut candidates = vec![preferred];
    candidates.extend(
        (AGENT_PREFERRED_PORT..AGENT_PREFERRED_PORT + AGENT_PORT_SCAN)
            .filter(|port| *port != preferred),
    );
    let mut failures = Vec::new();
    for port in &candidates {
        match tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, *port)).await {
            Ok(listener) => return Ok(listener),
            Err(error) => failures.push(error),
        }
    }
    // An explicit error in Settings, never a silent random port: agent app
    // configs point at a stable one.
    Err(bind_failure(&failures))
}

/// Ports busy only when every port was taken (`AddrInUse`); a refused or
/// unavailable address is something else, and quitting an app won't fix it.
fn bind_failure(failures: &[std::io::Error]) -> AgentBindError {
    let last_error = failures.last().map(ToString::to_string).unwrap_or_default();
    let busy = !failures.is_empty()
        && failures
            .iter()
            .all(|error| error.kind() == std::io::ErrorKind::AddrInUse);
    let (first, last) = (
        AGENT_PREFERRED_PORT,
        AGENT_PREFERRED_PORT + AGENT_PORT_SCAN - 1,
    );
    if busy {
        AgentBindError {
            kind: AgentBindErrorKind::PortsBusy,
            message: format!(
                "Ports {first}–{last} are all in use ({last_error}). Quit the app using them and turn Agents on again."
            ),
        }
    } else {
        AgentBindError {
            kind: AgentBindErrorKind::Other,
            message: format!("Agents couldn't open a port from {first} to {last} ({last_error})."),
        }
    }
}

/// Bind and serve if Agents is on. Idempotent.
pub async fn start_if_enabled(state: &AppState) {
    let (enabled, preferred) = {
        let registry = registry(state);
        (
            registry.persisted.enabled,
            registry.persisted.port.unwrap_or(AGENT_PREFERRED_PORT),
        )
    };
    if !enabled || state.agents.lock().bound_port.is_some() {
        return;
    }
    match bind_listener(preferred).await {
        Ok(listener) => {
            let port = listener
                .local_addr()
                .map(|addr| addr.port())
                .unwrap_or(preferred);
            let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
            {
                let mut runtime = state.agents.lock();
                runtime.bound_port = Some(port);
                runtime.bind_error = None;
                runtime.server = Some(shutdown_tx);
            }
            let port_changed = {
                let mut registry = registry(state);
                let changed = registry.persisted.port != Some(port);
                registry.persisted.port = Some(port);
                changed
            };
            if port_changed && let Err(error) = persist(state) {
                tracing::warn!("Could not persist the Agents port: {error:#}");
            }
            let app = router(state.clone());
            let serve_state = state.clone();
            tokio::spawn(async move {
                let served = axum::serve(
                    listener,
                    app.into_make_service_with_connect_info::<SocketAddr>(),
                )
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
                if let Err(error) = &served {
                    tracing::warn!("Agents listener failed: {error}");
                }
                // A clean shutdown was accounted for by `stop`; only a serve
                // FAILURE clears the live port here.
                if served.is_err() {
                    let mut runtime = serve_state.agents.lock();
                    if runtime.bound_port == Some(port) {
                        runtime.bound_port = None;
                    }
                }
            });
            state.emit_log("info", format!("Agents listening on 127.0.0.1:{port}/mcp."));
        }
        Err(error) => {
            state.emit_log("warn", format!("Agents could not start: {}", error.message));
            state.agents.lock().bind_error = Some(error);
        }
    }
}

/// Close the port. Pending Studio intents are dropped, so their calls end.
/// Does not change the persisted switch.
pub fn stop(state: &AppState) {
    let mut runtime = state.agents.lock();
    if let Some(shutdown) = runtime.server.take() {
        let _ = shutdown.send(());
    }
    runtime.bound_port = None;
    runtime.bind_error = None;
    runtime.pending_intents.clear();
}

/// Shutdown: close the port and remove the discovery file.
pub fn shutdown(state: &AppState) {
    stop(state);
    if let Some(path) = discovery_path(state.database.path()) {
        remove_discovery(&path);
    }
}

// ---------------------------------------------------------------------------
// The router: `/mcp` and nothing else
// ---------------------------------------------------------------------------

pub fn router(state: AppState) -> Router {
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_max_request_body_bytes(MAX_REQUEST_BODY_BYTES);
    let service_state = state.clone();
    let service = StreamableHttpService::new(
        move || {
            Ok(VideorcMcp {
                state: service_state.clone(),
            })
        },
        std::sync::Arc::new(NeverSessionManager::default()),
        config,
    );
    Router::new()
        .nest_service("/mcp", service)
        .layer(axum::middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

/// `Host` must be this listener's own loopback authority. A DNS-rebinding
/// page reaches us under its own hostname and is refused before any route.
fn host_is_this_listener(headers: &HeaderMap, bound_port: Option<u16>) -> bool {
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let (name, port) = match host.rsplit_once(':') {
        Some((name, port)) if port.chars().all(|character| character.is_ascii_digit()) => {
            (name, port.parse::<u16>().ok())
        }
        _ => (host, None),
    };
    if name != "localhost" && name != "127.0.0.1" {
        return false;
    }
    match (port, bound_port) {
        (Some(port), Some(bound)) => port == bound,
        _ => true,
    }
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    (scheme.eq_ignore_ascii_case("bearer") && !token.trim().is_empty()).then(|| token.trim())
}

fn plain(status: StatusCode, body: &'static str) -> Response {
    let mut response = (status, body).into_response();
    harden(response.headers_mut());
    response
}

fn harden(headers: &mut axum::http::HeaderMap) {
    for (name, value) in [
        (header::CACHE_CONTROL, "no-store"),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::REFERRER_POLICY, "no-referrer"),
        (header::X_FRAME_OPTIONS, "DENY"),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
    // Never a CORS header: a page's cross-site request stays unreadable.
    headers.remove(header::ACCESS_CONTROL_ALLOW_ORIGIN);
}

async fn guard(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    let bound_port = state.agents.lock().bound_port;
    if !host_is_this_listener(request.headers(), bound_port) {
        return plain(StatusCode::MISDIRECTED_REQUEST, "");
    }
    // Native clients send no Origin; a browser page always does.
    if request.headers().contains_key(header::ORIGIN) {
        return plain(StatusCode::FORBIDDEN, "");
    }
    if request.method() != Method::POST {
        let mut response = plain(StatusCode::METHOD_NOT_ALLOWED, "");
        response
            .headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("POST"));
        return response;
    }
    let identity = bearer_token(request.headers()).and_then(|token| {
        crate::agent_registry::AgentRegistry::authenticate(&registry(&state), token)
    });
    let Some(identity) = identity else {
        let mut response = plain(StatusCode::UNAUTHORIZED, "");
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            HeaderValue::from_static("Bearer realm=\"Videorc\""),
        );
        return response;
    };
    // Stop (D12) closes the port, but a kept-alive connection can still
    // carry one more request while the server drains: refuse it here.
    if !registry(&state).persisted.enabled {
        return plain(StatusCode::SERVICE_UNAVAILABLE, "");
    }
    // The role and the identity ride the request to the tool executors.
    request.extensions_mut().insert(BackendRole::Agent);
    request.extensions_mut().insert(identity);
    let mut response = next.run(request).await;
    harden(response.headers_mut());
    response
}

// ---------------------------------------------------------------------------
// The MCP server
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct VideorcMcp {
    pub state: AppState,
}

/// Who called, from the guard's extensions on the request parts rmcp copies
/// into the context. Only a request the guard admitted as the Agent role
/// carries one.
pub fn identity_from_context(
    context: &rmcp::service::RequestContext<rmcp::RoleServer>,
) -> Option<AgentIdentity> {
    let parts = context.extensions.get::<axum::http::request::Parts>()?;
    if parts.extensions.get::<BackendRole>() != Some(&BackendRole::Agent) {
        return None;
    }
    parts.extensions.get::<AgentIdentity>().cloned()
}

impl rmcp::ServerHandler for VideorcMcp {
    fn get_info(&self) -> rmcp::model::ServerConfig {
        let catalog = crate::agent_tools::catalog();
        rmcp::model::ServerConfig::new(
            rmcp::model::ServerCapabilities::builder()
                .enable_tools()
                .enable_prompts()
                .build(),
        )
        .with_instructions(catalog.instructions.clone())
        .with_server_info(
            // The app's own version (the crate stays at 0.9.0).
            rmcp::model::Implementation::new(
                catalog.server_name.clone(),
                crate::performance_check::desktop_app_version(),
            )
            .with_title(catalog.server_title.clone()),
        )
    }

    async fn ping(
        &self,
        context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> std::result::Result<(), rmcp::ErrorData> {
        // The bridge's heartbeat: presence for the Session line.
        if let Some(agent) = identity_from_context(&context) {
            touch_agent(&self.state, &agent);
        }
        Ok(())
    }

    async fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> std::result::Result<rmcp::model::ListToolsResult, rmcp::ErrorData> {
        let tools = crate::agent_tools::catalog()
            .mcp_tools()
            .into_iter()
            .map(|tool| {
                serde_json::from_value::<rmcp::model::Tool>(tool)
                    .map_err(|error| rmcp::ErrorData::internal_error(error.to_string(), None))
            })
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rmcp::model::ListToolsResult {
            tools,
            ..Default::default()
        })
    }

    /// S22: the fixed prompts ("Go-live checklist", "Stream recap"). The
    /// bridge answers the same list offline from the same fixture.
    async fn list_prompts(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> std::result::Result<rmcp::model::ListPromptsResult, rmcp::ErrorData> {
        let prompts = crate::agent_prompts::prompts()
            .prompts
            .iter()
            .map(|prompt| {
                rmcp::model::Prompt::new(
                    prompt.name.clone(),
                    Some(prompt.description.clone()),
                    None,
                )
                .with_title(prompt.title.clone())
            })
            .collect();
        Ok(rmcp::model::ListPromptsResult {
            prompts,
            ..Default::default()
        })
    }

    async fn get_prompt(
        &self,
        request: rmcp::model::GetPromptRequestParams,
        _context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> std::result::Result<rmcp::model::GetPromptResponse, rmcp::ErrorData> {
        let Some(prompt) = crate::agent_prompts::prompts().prompt(&request.name) else {
            return Err(rmcp::ErrorData::invalid_params(
                crate::agent_prompts::unknown_prompt(&request.name),
                None,
            ));
        };
        Ok(
            rmcp::model::GetPromptResult::new(vec![rmcp::model::PromptMessage::new_text(
                rmcp::model::Role::User,
                prompt.text.clone(),
            )])
            .with_description(prompt.description.clone())
            .into(),
        )
    }

    async fn call_tool(
        &self,
        request: rmcp::model::CallToolRequestParams,
        context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> std::result::Result<rmcp::model::CallToolResponse, rmcp::ErrorData> {
        let Some(agent) = identity_from_context(&context) else {
            return Err(rmcp::ErrorData::internal_error(
                "Videorc could not tell which agent called.",
                None,
            ));
        };
        Ok(crate::agent_call::call_tool(&self.state, &agent, request)
            .await
            .into())
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::storage::Database;

    pub fn test_state() -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(64);
        let state = AppState::new(
            "renderer-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        );
        // The test secret store is one process-global cache: an agent made by
        // a parallel test must not be loaded here.
        *state.agent_registry.lock().unwrap() = AgentRegistry::default();
        state
    }

    /// Serve the Agents router on an ephemeral port and record it as bound.
    pub async fn serve(state: &AppState) -> SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        {
            let mut runtime = state.agents.lock();
            runtime.bound_port = Some(address.port());
            runtime.server = Some(shutdown_tx);
        }
        state.agent_registry.lock().unwrap().persisted.enabled = true;
        let app = router(state.clone());
        tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
        });
        address
    }

    /// An agent in the registry, without touching the secret store.
    pub fn connect_agent(state: &AppState, name: &str) -> (AgentIdentity, String) {
        let (record, token) = state
            .agent_registry
            .lock()
            .unwrap()
            .create(name, AgentClientKind::ClaudeCode, "2026-10-27T10:00:00Z")
            .unwrap();
        (
            AgentIdentity {
                id: record.id,
                name: record.name,
            },
            token,
        )
    }

    pub fn rpc(id: u64, method: &str, params: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    }

    pub async fn post(
        address: SocketAddr,
        token: Option<&str>,
        body: serde_json::Value,
    ) -> reqwest::Response {
        let client = reqwest::Client::new();
        let mut request = client
            .post(format!("http://{address}/mcp"))
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", "2025-06-18")
            .body(body.to_string());
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        request.send().await.unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    #[tokio::test]
    async fn the_guards_refuse_rebinding_pages_other_methods_and_strangers() {
        let state = test_state();
        let address = serve(&state).await;
        let (_, token) = connect_agent(&state, "Claude Code");
        let client = reqwest::Client::new();
        let ping = rpc(1, "ping", serde_json::json!({}));

        // A page in the browser: Origin present → 403, whatever the token.
        let response = client
            .post(format!("http://{address}/mcp"))
            .header("origin", "http://127.0.0.1:5173")
            .bearer_auth(&token)
            .json(&ping)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 403);
        assert!(
            response
                .headers()
                .get("access-control-allow-origin")
                .is_none()
        );

        // DNS rebinding: the attacker's hostname → 421; a wrong port too.
        for host in ["evil.example", "evil.example:7440", "127.0.0.1:1"] {
            let response = client
                .post(format!("http://{address}/mcp"))
                .header("host", host)
                .bearer_auth(&token)
                .json(&ping)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 421, "{host}");
        }
        for host in [
            format!("localhost:{}", address.port()),
            "127.0.0.1".to_string(),
        ] {
            // Streamable HTTP: a client accepts JSON and SSE (else 406).
            let response = client
                .post(format!("http://{address}/mcp"))
                .header("host", &host)
                .header("accept", "application/json, text/event-stream")
                .bearer_auth(&token)
                .json(&ping)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200, "{host}");
        }

        // Only POST exists.
        let response = client
            .get(format!("http://{address}/mcp"))
            .header("accept", "text/event-stream")
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 405);
        assert_eq!(response.headers()["allow"], "POST");

        // No token, a wrong token, the renderer token, the admin token: 401.
        for wrong in [None, Some("vrc_agent_nope"), Some("renderer-token")] {
            let response = post(address, wrong, ping.clone()).await;
            assert_eq!(response.status(), 401, "{wrong:?}");
            assert!(
                response.headers()["www-authenticate"]
                    .to_str()
                    .unwrap()
                    .starts_with("Bearer")
            );
        }
        let admin = state.admin_token.clone();
        assert_eq!(
            post(address, Some(&admin), ping.clone()).await.status(),
            401
        );

        // The main router's routes are structurally absent here.
        for path in ["/health", "/ws", "/preview/live.jpg", "/oauth/callback"] {
            let response = client
                .get(format!("http://{address}{path}"))
                .bearer_auth(&token)
                .send()
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                405,
                "{path} must not exist on the Agents port"
            );
        }
        let response = post(address, Some(&token), ping).await;
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["cache-control"], "no-store");
    }

    #[tokio::test]
    async fn initialize_and_tools_list_answer_from_the_catalog() {
        let state = test_state();
        let address = serve(&state).await;
        let (_, token) = connect_agent(&state, "Cursor");
        let initialize = rpc(
            1,
            "initialize",
            serde_json::json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "test", "version": "0" }
            }),
        );
        let answer: serde_json::Value = post(address, Some(&token), initialize)
            .await
            .json()
            .await
            .unwrap();
        assert_eq!(answer["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(answer["result"]["serverInfo"]["name"], "videorc");
        assert_eq!(
            answer["result"]["instructions"],
            crate::agent_tools::catalog().instructions
        );
        assert!(answer["result"]["capabilities"]["tools"].is_object());
        assert!(answer["result"]["capabilities"]["prompts"].is_object());

        let answer: serde_json::Value = post(
            address,
            Some(&token),
            rpc(2, "tools/list", serde_json::json!({})),
        )
        .await
        .json()
        .await
        .unwrap();
        assert_eq!(
            answer["result"]["tools"],
            serde_json::Value::Array(crate::agent_tools::catalog().mcp_tools())
        );
        let raw = answer.to_string();
        assert!(
            !raw.contains("runsIn") && !raw.contains("rateFamily"),
            "{raw}"
        );
    }

    #[tokio::test]
    async fn prompts_list_and_get_answer_from_the_fixture() {
        let state = test_state();
        let address = serve(&state).await;
        let (_, token) = connect_agent(&state, "Claude Desktop");
        let answer: serde_json::Value = post(
            address,
            Some(&token),
            rpc(1, "prompts/list", serde_json::json!({})),
        )
        .await
        .json()
        .await
        .unwrap();
        // The same wire shape the bridge answers offline.
        assert_eq!(
            answer["result"]["prompts"],
            serde_json::Value::Array(crate::agent_prompts::prompts().mcp_prompts())
        );

        for prompt in &crate::agent_prompts::prompts().prompts {
            let answer: serde_json::Value = post(
                address,
                Some(&token),
                rpc(2, "prompts/get", serde_json::json!({ "name": prompt.name })),
            )
            .await
            .json()
            .await
            .unwrap();
            let expected = prompt.mcp_get_result();
            assert_eq!(answer["result"]["description"], expected["description"]);
            assert_eq!(answer["result"]["messages"], expected["messages"]);
        }

        let answer: serde_json::Value = post(
            address,
            Some(&token),
            rpc(
                3,
                "prompts/get",
                serde_json::json!({ "name": "end_stream" }),
            ),
        )
        .await
        .json()
        .await
        .unwrap();
        assert_eq!(answer["error"]["code"], -32602, "{answer}");
        assert_eq!(
            answer["error"]["message"],
            crate::agent_prompts::unknown_prompt("end_stream")
        );
        // A prompt is text, not an action: nothing lands in Activity.
        assert!(
            activity(&state, ActivityListParams::default())
                .unwrap()
                .entries
                .is_empty()
        );
    }

    #[tokio::test]
    async fn a_removed_agent_is_cut_and_disable_closes_the_port() {
        let state = test_state();
        let address = serve(&state).await;
        let (first, token) = connect_agent(&state, "First");
        let (_, second_token) = connect_agent(&state, "Second");
        let ping = rpc(1, "ping", serde_json::json!({}));
        assert_eq!(
            post(address, Some(&token), ping.clone()).await.status(),
            200
        );
        assert!(state.agent_registry.lock().unwrap().remove(&first.id));
        assert_eq!(
            post(address, Some(&token), ping.clone()).await.status(),
            401
        );
        assert_eq!(
            post(address, Some(&second_token), ping.clone())
                .await
                .status(),
            200
        );

        stop(&state);
        assert!(state.agents.lock().bound_port.is_none());
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let refused = reqwest::Client::new()
                    .post(format!("http://{address}/mcp"))
                    .bearer_auth(&second_token)
                    .json(&ping)
                    .send()
                    .await
                    .is_err();
                if refused {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the port closes");
    }

    #[test]
    fn rate_limits_follow_the_security_table() {
        let mut limiter = AgentRateLimiter::default();
        let start = Instant::now();
        for _ in 0..20 {
            limiter.admit("a", AgentRateFamily::Action, start).unwrap();
        }
        assert_eq!(
            limiter.admit("a", AgentRateFamily::Action, start + Duration::from_secs(9)),
            Err("Slow down: at most 20 actions every 10 seconds.".to_string())
        );
        // Another agent, and another family, are not held back.
        limiter.admit("b", AgentRateFamily::Action, start).unwrap();
        limiter.admit("a", AgentRateFamily::Read, start).unwrap();
        limiter
            .admit(
                "a",
                AgentRateFamily::Action,
                start + Duration::from_secs(10),
            )
            .unwrap();

        limiter.admit("a", AgentRateFamily::Chat, start).unwrap();
        assert_eq!(
            limiter.admit("a", AgentRateFamily::Chat, start + Duration::from_secs(1)),
            Err("Slow down: at most one chat message every 2 seconds.".to_string())
        );
        for index in 1..20 {
            limiter
                .admit(
                    "a",
                    AgentRateFamily::Chat,
                    start + Duration::from_secs(2 * index),
                )
                .unwrap();
        }
        assert_eq!(
            limiter.admit("a", AgentRateFamily::Chat, start + Duration::from_secs(41)),
            Err("Slow down: at most 20 chat messages a minute.".to_string())
        );

        limiter.admit("a", AgentRateFamily::Session, start).unwrap();
        assert!(
            limiter
                .admit(
                    "a",
                    AgentRateFamily::Session,
                    start + Duration::from_secs(5)
                )
                .is_err()
        );
        for _ in 0..10 {
            limiter.admit("a", AgentRateFamily::Removal, start).unwrap();
        }
        assert!(
            limiter
                .admit(
                    "a",
                    AgentRateFamily::Removal,
                    start + Duration::from_secs(59)
                )
                .is_err()
        );
        limiter.forget("a");
        limiter.admit("a", AgentRateFamily::Session, start).unwrap();
    }

    #[test]
    fn discovery_file_is_owner_only_and_carries_no_secret() {
        let dir =
            std::env::temp_dir().join(format!("videorc-agents-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("videorc.sqlite3");
        let path = discovery_path(&db).unwrap();
        assert!(path.ends_with("agents.json"));
        write_discovery(
            &path,
            &AgentsDiscovery {
                protocol: AGENT_PROTOCOL,
                pid: 42,
                enabled: true,
                port: Some(7441),
            },
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "discovery file must be owner-only");
        }
        let body: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(body["port"], 7441);
        assert_eq!(body["protocol"], 1);
        assert_eq!(body["enabled"], true);
        let keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        // serde_json's map is sorted: the exact set, no token among it.
        assert_eq!(keys, ["enabled", "pid", "port", "protocol"]);
        write_discovery(
            &path,
            &AgentsDiscovery {
                protocol: AGENT_PROTOCOL,
                pid: 42,
                enabled: false,
                port: None,
            },
        )
        .unwrap();
        let body: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(body.get("port").is_none(), "{body}");
        remove_discovery(&path);
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
        assert!(discovery_path(Path::new(":memory:")).is_none());
    }

    #[test]
    fn status_never_serialises_a_token_or_null() {
        let state = test_state();
        let (agent, token) = connect_agent(&state, "Codex");
        touch_agent(&state, &agent);
        let status = status(&state);
        assert_eq!(status.agents.len(), 1);
        assert!(status.agents[0].connected);
        assert_eq!(status.connected_count, 1);
        assert!(!status.studio_open);
        let serialized = serde_json::to_string(&status).unwrap();
        assert!(!serialized.contains(&token));
        assert!(!serialized.contains("tokenHash"));
        assert!(!serialized.contains("null"), "{serialized}");
        assert!(serialized.contains("\"client\":\"claude-code\""));
    }

    #[test]
    fn activity_rows_are_capped_and_listed_newest_first() {
        let state = test_state();
        let (agent, _) = connect_agent(&state, "Claude Desktop");
        let mut events = state.events.subscribe();
        for index in 0..3 {
            log_activity(
                &state,
                &agent,
                "notify",
                format!("{{\"message\":\"{index}\"}}"),
                AgentActivityOutcome::Ok,
                None,
                None,
            );
        }
        let page = activity(&state, ActivityListParams::default()).unwrap();
        assert_eq!(page.entries.len(), 3);
        assert_eq!(page.entries[0].summary, "{\"message\":\"2\"}");
        assert_eq!(
            activity(
                &state,
                ActivityListParams {
                    limit: Some(1),
                    agent_id: Some(agent.id.clone())
                }
            )
            .unwrap()
            .entries
            .len(),
            1
        );
        assert!(
            activity(
                &state,
                ActivityListParams {
                    limit: None,
                    agent_id: Some("other".to_string())
                }
            )
            .unwrap()
            .entries
            .is_empty()
        );
        let mut seen = 0;
        while let Ok(event) = events.try_recv() {
            if event.event == "agents.activity" {
                seen += 1;
                assert_eq!(event.payload["agentName"], "Claude Desktop");
                assert!(event.payload.get("message").is_none());
            }
        }
        assert_eq!(seen, 3);
        assert_eq!(
            status(&state).agents[0].last_action.as_ref().unwrap().tool,
            "notify"
        );

        // Caps: rows beyond 1,000, and rows older than 30 days. Timestamps
        // are relative to now: an insert prunes against the real clock.
        let recent = chrono::Utc::now() - chrono::Duration::hours(2);
        for index in 0..crate::storage::AGENT_ACTIVITY_MAX_ROWS + 5 {
            state
                .database
                .insert_agent_activity(&AgentActivityEntry {
                    id: format!("row-{index:05}"),
                    at: (recent + chrono::Duration::seconds(index as i64)).to_rfc3339(),
                    agent_id: agent.id.clone(),
                    agent_name: agent.name.clone(),
                    tool: "notify".to_string(),
                    summary: String::new(),
                    outcome: AgentActivityOutcome::Refused,
                    message: Some("no".to_string()),
                })
                .unwrap();
        }
        assert_eq!(
            state.database.agent_activity_count().unwrap(),
            crate::storage::AGENT_ACTIVITY_MAX_ROWS as i64
        );
        state
            .database
            .prune_agent_activity_for_test(
                recent + chrono::Duration::days(crate::storage::AGENT_ACTIVITY_MAX_DAYS + 1),
            )
            .unwrap();
        assert_eq!(state.database.agent_activity_count().unwrap(), 0);
    }

    #[test]
    fn activity_rows_stay_inside_the_contract_bounds() {
        assert_eq!(activity_tool_label("set_banner"), "set_banner");
        assert_eq!(activity_tool_label(""), "unknown");
        assert_eq!(activity_tool_label("\u{0}\n"), "unknown");
        let long = activity_tool_label(&"x".repeat(500));
        assert_eq!(long.chars().count(), ACTIVITY_TOOL_MAX_CHARS);
        assert!(long.ends_with('…'));
        assert_eq!(clip_chars("short", 10), "short");
        let state = test_state();
        let (agent, _) = connect_agent(&state, "Cursor");
        log_activity(
            &state,
            &agent,
            &"y".repeat(300),
            String::new(),
            AgentActivityOutcome::Refused,
            Some("z".repeat(5_000)),
            Some("never shown for a refusal".to_string()),
        );
        let row = &activity(&state, ActivityListParams::default())
            .unwrap()
            .entries[0];
        assert_eq!(row.tool.chars().count(), ACTIVITY_TOOL_MAX_CHARS);
        assert_eq!(
            row.message.as_ref().unwrap().chars().count(),
            ACTIVITY_MESSAGE_MAX_CHARS
        );
    }

    #[tokio::test]
    async fn a_draining_listener_refuses_once_agents_is_off() {
        let state = test_state();
        let address = serve(&state).await;
        let (_, token) = connect_agent(&state, "Codex");
        let ping = rpc(1, "ping", serde_json::json!({}));
        assert_eq!(
            post(address, Some(&token), ping.clone()).await.status(),
            200
        );
        state.agent_registry.lock().unwrap().persisted.enabled = false;
        assert_eq!(post(address, Some(&token), ping).await.status(), 503);
    }

    #[test]
    fn a_bind_failure_says_ports_busy_only_when_every_port_was_taken() {
        let busy = || std::io::Error::from(std::io::ErrorKind::AddrInUse);
        let failures: Vec<_> = (0..AGENT_PORT_SCAN).map(|_| busy()).collect();
        let error = bind_failure(&failures);
        assert_eq!(error.kind, AgentBindErrorKind::PortsBusy);
        assert!(error.message.starts_with("Ports 7440–7449 are all in use"));
        let mut mixed: Vec<_> = (1..AGENT_PORT_SCAN).map(|_| busy()).collect();
        mixed.push(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert_eq!(bind_failure(&mixed).kind, AgentBindErrorKind::Other);
        assert_eq!(bind_failure(&[]).kind, AgentBindErrorKind::Other);

        // The kind rides the status beside the OS's words, and neither is
        // there (never null) while the listener is fine.
        let state = test_state();
        let fine = serde_json::to_value(status(&state)).unwrap();
        assert!(fine.get("bindError").is_none());
        assert!(fine.get("bindErrorKind").is_none());
        state.agents.lock().bind_error = Some(error);
        let failed = serde_json::to_value(status(&state)).unwrap();
        assert_eq!(failed["bindErrorKind"], "ports-busy");
        assert!(failed["bindError"].as_str().unwrap().contains("all in use"));
        stop(&state);
        assert!(status(&state).bind_error_kind.is_none());
    }

    #[tokio::test]
    async fn a_lapsed_presence_publishes_the_status_once() {
        let state = test_state();
        let (agent, _) = connect_agent(&state, "Claude Desktop");
        let mut events = state.events.subscribe();
        // Heard from 44.7 s ago: connected for 300 ms more.
        let heard = Instant::now()
            - (crate::agent_registry::AGENT_PRESENCE_WINDOW - Duration::from_millis(300));
        {
            let mut registry = state.agent_registry.lock().unwrap();
            registry.touch(&agent.id, heard, "2026-10-27T10:00:00Z");
            assert!(registry.claim_presence_watch());
        }
        assert_eq!(status(&state).connected_count, 1);
        spawn_presence_watch(&state);
        let lapsed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let event = events.recv().await.unwrap();
                if event.event == "agents.status" {
                    return event.payload;
                }
            }
        })
        .await
        .expect("a lapse publishes agents.status");
        assert_eq!(lapsed["connectedCount"], 0);
        assert_eq!(lapsed["agents"][0]["connected"], false);
        // The watch ended with the last agent: one event, and the next
        // touch starts a new watch.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(events.try_recv().is_err());
        assert!(state.agent_registry.lock().unwrap().claim_presence_watch());
    }

    #[test]
    fn last_action_survives_a_restart_from_the_newest_activity_row() {
        let state = test_state();
        let (agent, _) = connect_agent(&state, "Cursor");
        let (quiet, _) = connect_agent(&state, "Codex");
        let row = |id: &str, at: &str, tool: &str, outcome| AgentActivityEntry {
            id: id.to_string(),
            at: at.to_string(),
            agent_id: agent.id.clone(),
            agent_name: agent.name.clone(),
            tool: tool.to_string(),
            summary: String::new(),
            outcome,
            message: None,
        };
        let recent = chrono::Utc::now() - chrono::Duration::minutes(5);
        let older = (recent - chrono::Duration::minutes(1)).to_rfc3339();
        let newest = recent.to_rfc3339();
        // Written by the last run; this registry (a restart) remembers nothing.
        for entry in [
            row("r1", &older, "notify", AgentActivityOutcome::Ok),
            row("r2", &newest, "switch_scene", AgentActivityOutcome::Refused),
        ] {
            state.database.insert_agent_activity(&entry).unwrap();
        }
        let status = status(&state);
        let seeded = status
            .agents
            .iter()
            .find(|summary| summary.id == agent.id)
            .unwrap();
        assert_eq!(
            seeded.last_action,
            Some(AgentLastAction {
                tool: "switch_scene".to_string(),
                at: newest,
                outcome: AgentActivityOutcome::Refused,
            })
        );
        let never = status
            .agents
            .iter()
            .find(|summary| summary.id == quiet.id)
            .unwrap();
        assert!(never.last_action.is_none());
        assert!(
            state
                .agent_registry
                .lock()
                .unwrap()
                .last_actions_to_seed()
                .is_empty()
        );
    }

    #[test]
    fn host_and_bearer_parsing() {
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("127.0.0.1:7440"));
        assert!(host_is_this_listener(&headers, Some(7440)));
        assert!(!host_is_this_listener(&headers, Some(7441)));
        assert!(host_is_this_listener(&headers, None));
        headers.insert("host", HeaderValue::from_static("localhost"));
        assert!(host_is_this_listener(&headers, Some(7440)));
        headers.insert("host", HeaderValue::from_static("192.168.1.2:7440"));
        assert!(!host_is_this_listener(&headers, Some(7440)));
        headers.insert("host", HeaderValue::from_static("[::1]:7440"));
        assert!(!host_is_this_listener(&headers, Some(7440)));
        assert!(!host_is_this_listener(&HeaderMap::new(), Some(7440)));

        let mut headers = HeaderMap::new();
        assert_eq!(bearer_token(&headers), None);
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer vrc_agent_x"),
        );
        assert_eq!(bearer_token(&headers), Some("vrc_agent_x"));
        headers.insert("authorization", HeaderValue::from_static("Basic abc"));
        assert_eq!(bearer_token(&headers), None);
        headers.insert("authorization", HeaderValue::from_static("Bearer "));
        assert_eq!(bearer_token(&headers), None);
    }
}
