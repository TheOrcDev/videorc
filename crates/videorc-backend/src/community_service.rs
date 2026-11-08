//! Know your viewers across platforms (plan 225): what runs on `AppState`.
//!
//! The runtime holds, per live-chat session, the people already given an
//! arrival (one per person per stream, whichever account chats first, B1),
//! the pending `!link` words (D4 b, in memory only), and the count of
//! detached store writes. The engine's [`CommunityLane`] carries "Welcome
//! back" and "Linked … Undo" on `cohost.state` (D11, D4). The RPC handlers
//! (`cohost.community.*`), the backfill (A3) and the retention job (A4) live
//! here too, every store call off the runtime in `spawn_blocking`.
//!
//! Chat delivery never waits on the store (D14): the arrival lookup rides
//! the first-time marker's blocking read, and every write is a detached
//! task that runs after delivery, outside every fence. Nothing here sends a
//! chat message: a command's reply is a `bubble-only` line in Bubble mode,
//! and nothing at all in Suggest or Off (D13).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use tokio::sync::Notify;

use crate::cohost::{
    COHOST_STATE_EVENT, CohostTalkMode, CohostUtterance, CohostUtteranceState,
    CohostUtteranceStatus, CohostUtteranceTrigger, CohostUtteranceTriggerKind, truncate_utf16,
};
use crate::community::{
    ChatCommand, CohostLinkMade, CohostWelcomeBack, CommunityAccepted, CommunityExportParams,
    CommunityExportResult, CommunityIdParams, CommunityImportParams, CommunityImportResult,
    CommunityLinkKind, CommunityLinkParams, CommunityListPage, CommunityListParams,
    CommunityPerson, CommunityPersonIdParams, CommunityPersonParams, CommunitySettings,
    CommunitySuggestionParams, CommunitySummary, CommunityUnlinkParams, CommunityUnlinkResult,
    CommunityUpdateParams, LINK_MADE_TTL, LinkClaim, LinkOutcome, PendingLinks, ReportArrival,
    ViewerArrival, account_key, command_bubble_line, parse_chat_command, platform_has_identity,
    report_community,
};
use crate::community_store::{
    CommunityError, CommunityExportFile, CommunityRowFacts, PRUNED_AT_SETTING_KEY,
};
use crate::live_chat::{LiveChatEventType, LiveChatMessage};
use crate::state::AppState;
use crate::storage::Database;
use crate::streaming::StreamPlatform;
use crate::videorc_api::{
    COHOST_MEMORY_ADDS_MAX, COHOST_MEMORY_MAX_BODY_BYTES, COHOST_MEMORY_MESSAGE_MAX_CHARS,
    COHOST_MEMORY_MESSAGES_MAX, COHOST_MEMORY_NAME_MAX_CHARS, COHOST_MEMORY_NOTE_MAX_CHARS,
    COHOST_MEMORY_PEOPLE_MAX, COHOST_MEMORY_PROMPT_VERSION, COHOST_MEMORY_SUMMARY_MAX_CHARS,
    COHOST_MEMORY_TEXT_MAX_CHARS, CohostApiError, CohostApiErrorKind, CohostMemoryCounts,
    CohostMemoryKnown, CohostMemoryMessage, CohostMemoryPerson, CohostMemoryRequest,
    CohostMemoryResponse, CohostTickPersona,
};

pub const COMMUNITY_CHANGED_EVENT: &str = "cohost.community.changed";
/// "Welcome back" keeps a returning person this long (D11), at most this
/// many, like "Say hi".
pub const WELCOME_BACK_WINDOW: Duration = Duration::from_secs(15 * 60);
pub const WELCOME_BACK_MAX: usize = 8;
/// One arrival reaction per wave (D9): at most one every this long.
pub const ARRIVAL_REACTION_GAP: Duration = Duration::from_secs(20);
/// The retention job runs at start and then every day (D3).
const PRUNE_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// The backfill reports progress every this many sessions.
const BACKFILL_PROGRESS_EVERY: u32 = 5;

// --- The runtime --------------------------------------------------------------

#[derive(Default)]
struct SessionCommunity {
    session_id: String,
    /// People already given an arrival this stream.
    arrived: HashSet<String>,
    /// `account_key` → person id, from the arrival lookup, so the
    /// "Welcome back" row knows its person without a second read.
    people_by_key: HashMap<String, String>,
    links: PendingLinks,
    streamer_keys: Option<HashSet<String>>,
    /// D14: a store error is logged once per session.
    store_error_logged: bool,
    /// D15: what the report's Community block counts, kept as it happens.
    report_arrivals: Vec<ReportArrival>,
    links_made: u32,
    opt_outs: u32,
    /// D10: a Buddy session with consent to process chat ran during this
    /// stream, so the memory pass may send its chat after it ends.
    consented: bool,
}

/// The most arrivals one stream's report keeps in memory.
const REPORT_ARRIVALS_MAX: usize = 2_000;

#[derive(Default)]
pub struct CommunityRuntime {
    /// The community block of the Buddy settings, read without the engine
    /// lock on the delivery path. `None` until first read.
    settings: Option<CommunitySettings>,
    session: Option<SessionCommunity>,
    pending_writes: usize,
    backfill_running: bool,
    /// `cohost.memory` from the capability read (D10): queued passes run
    /// only while the web says 1 or more. `None` until the first read.
    web_memory_version: Option<u32>,
    /// One memory job loop at a time.
    memory_jobs_running: bool,
    last_arrival_reaction: Option<Instant>,
    /// Tests: every line handed to the bubble, in order.
    #[cfg(test)]
    bubble_lines: Vec<String>,
}

pub struct CommunityShared {
    runtime: StdMutex<CommunityRuntime>,
    writes_done: Notify,
}

pub type CommunitySlot = Arc<CommunityShared>;

pub fn new_slot() -> CommunitySlot {
    Arc::new(CommunityShared {
        runtime: StdMutex::new(CommunityRuntime::default()),
        writes_done: Notify::new(),
    })
}

impl CommunityShared {
    fn lock(&self) -> std::sync::MutexGuard<'_, CommunityRuntime> {
        self.runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The community settings as the delivery path reads them: the cached
/// block, else loaded once from `app_settings`.
pub(crate) fn settings_snapshot(database: &Database, slot: &CommunitySlot) -> CommunitySettings {
    if let Some(settings) = slot.lock().settings.clone() {
        return settings;
    }
    let settings = crate::cohost::load_cohost_settings(database).community;
    slot.lock().settings = Some(settings.clone());
    settings
}

/// `cohost.settings.set` mirrors the block here.
pub(crate) fn sync_settings(state: &AppState, settings: &CommunitySettings) {
    state.community.lock().settings = Some(settings.clone());
}

/// `cohost.start` with consent to process chat (D10): the stream's memory
/// pass may send its chat once it ends.
pub(crate) fn note_cohost_consent(state: &AppState, session_id: &str, consent: bool) {
    if !consent {
        return;
    }
    let mut runtime = state.community.lock();
    if let Some(session) = runtime
        .session
        .as_mut()
        .filter(|session| session.session_id == session_id)
    {
        session.consented = true;
    }
}

/// `cohost.memory` from the capability read (D10). Turning on runs the
/// queued passes.
pub(crate) fn set_memory_capability(state: &AppState, version: Option<u32>) {
    let turned_on = {
        let mut runtime = state.community.lock();
        let before = runtime.web_memory_version.unwrap_or(0);
        runtime.web_memory_version = version;
        before < 1 && version.unwrap_or(0) >= 1
    };
    if turned_on {
        spawn_memory_jobs(state);
    }
}

/// Whether the next arrival may make Buddy react (D9: one wave per 20 s).
pub(crate) fn arrival_reaction_due(slot: &CommunitySlot, now: Instant) -> bool {
    let mut runtime = slot.lock();
    let due = runtime
        .last_arrival_reaction
        .is_none_or(|last| now.saturating_duration_since(last) >= ARRIVAL_REACTION_GAP);
    if due {
        runtime.last_arrival_reaction = Some(now);
    }
    due
}

// --- The engine's lane (cohost.state) -------------------------------------------

/// "Welcome back" and "Linked … Undo" on `cohost.state` (D11, D4 b),
/// following the live-chat session like the automatic chat lane.
#[derive(Debug, Default)]
pub struct CommunityLane {
    welcome_back: Vec<(CohostWelcomeBack, String, Instant)>,
    link_made: Vec<(CohostLinkMade, Instant)>,
    /// Arrival rows the bubble welcomed, or whose Suggest card was posted or
    /// dismissed: the
    /// greeting pass runs on the delivery, the arrival write after it, so
    /// a welcomed row never joins the list late.
    welcomed: std::collections::VecDeque<String>,
}

/// Welcomed row ids remembered, so a late arrival write cannot list them.
const WELCOMED_REMEMBERED: usize = 64;

impl CommunityLane {
    /// A returning person arrived (`message_id` is their arrival row).
    pub(crate) fn note_arrival(
        &mut self,
        entry: CohostWelcomeBack,
        message_id: String,
        now: Instant,
    ) {
        if self.welcomed.contains(&message_id) {
            return;
        }
        self.welcome_back
            .retain(|(waiting, _, _)| waiting.person_id != entry.person_id);
        self.welcome_back.push((entry, message_id, now));
        while self.welcome_back.len() > WELCOME_BACK_MAX {
            self.welcome_back.remove(0);
        }
    }

    /// The bubble welcomed the arrival row: the row leaves (or never joins).
    pub(crate) fn note_welcomed(&mut self, message_ids: &[String]) -> bool {
        for message_id in message_ids {
            if !self.welcomed.contains(message_id) {
                self.welcomed.push_back(message_id.clone());
            }
        }
        while self.welcomed.len() > WELCOMED_REMEMBERED {
            self.welcomed.pop_front();
        }
        let before = self.welcome_back.len();
        self.welcome_back
            .retain(|(_, message_id, _)| !message_ids.contains(message_id));
        before != self.welcome_back.len()
    }

    /// The streamer waved: the row leaves.
    pub(crate) fn note_waved(&mut self, person_id: &str) -> bool {
        let before = self.welcome_back.len();
        self.welcome_back
            .retain(|(waiting, _, _)| waiting.person_id != person_id);
        before != self.welcome_back.len()
    }

    pub(crate) fn note_link_made(&mut self, link: CohostLinkMade, now: Instant) {
        self.link_made.push((link, now));
    }

    /// An Undo or a `!unlink` took the account out: the card leaves.
    pub(crate) fn note_unlinked(&mut self, account_key: &str) -> bool {
        let before = self.link_made.len();
        self.link_made
            .retain(|(link, _)| link.account_key != account_key);
        before != self.link_made.len()
    }

    pub(crate) fn welcome_back(&self, now: Instant) -> Vec<CohostWelcomeBack> {
        self.welcome_back
            .iter()
            .filter(|(_, _, at)| now.saturating_duration_since(*at) < WELCOME_BACK_WINDOW)
            .map(|(entry, _, _)| entry.clone())
            .collect()
    }

    pub(crate) fn link_made(&self, now: Instant) -> Vec<CohostLinkMade> {
        self.link_made
            .iter()
            .filter(|(_, at)| now.saturating_duration_since(*at) < LINK_MADE_TTL)
            .map(|(link, _)| link.clone())
            .collect()
    }

    pub(crate) fn clear(&mut self) {
        self.welcome_back.clear();
        self.link_made.clear();
        self.welcomed.clear();
    }
}

// --- Live-chat hooks ---------------------------------------------------------------

/// A chat session started (`liveChat.start`): the stream row, the
/// streamer's keys, a fresh arrival set, and the engine lane cleared.
pub(crate) fn session_started(state: &AppState, session_id: &str, platforms: Vec<StreamPlatform>) {
    {
        let mut runtime = state.community.lock();
        runtime.session = Some(SessionCommunity {
            session_id: session_id.to_string(),
            ..Default::default()
        });
    }
    let state = state.clone();
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        state.cohost.lock().await.community.clear();
        let database = state.database.clone();
        let record_session_id = session_id.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            database.community_record_stream(&record_session_id, Utc::now(), &platforms)?;
            database.community_streamer_keys()
        })
        .await;
        match outcome {
            Ok(Ok(keys)) => {
                let mut runtime = state.community.lock();
                if let Some(session) = runtime.session.as_mut()
                    && session.session_id == session_id
                {
                    session.streamer_keys = Some(keys);
                }
            }
            Ok(Err(error)) => state.emit_log(
                "warn",
                format!("Community: could not record the stream: {error:#}"),
            ),
            Err(error) => state.emit_log(
                "warn",
                format!("Community: the stream record task failed: {error}"),
            ),
        }
    });
}

/// The chat session ended: pending `!link` words die with it; the lane is
/// cleared; the report's Community block (D15) is written once the
/// session's detached store writes have landed.
pub(crate) fn session_ended(state: &AppState) {
    let ended = state.community.lock().session.take();
    let state = state.clone();
    tokio::spawn(async move {
        state.cohost.lock().await.community.clear();
        if let Some(ended) = ended {
            let session_id = ended.session_id.clone();
            let consented = ended.consented;
            write_report_community(&state, ended).await;
            // D10: the memory pass, after the report's counts are in.
            enqueue_memory_pass(&state, &session_id, consented).await;
        }
    });
}

/// How long the report waits for the session's last store writes.
const REPORT_WRITES_WAIT: Duration = Duration::from_secs(10);

/// D15: fold the Community block into the session's Buddy report. Nothing
/// is written for a stream nobody came back to and nobody new chatted in.
async fn write_report_community(state: &AppState, ended: SessionCommunity) {
    let settings = settings_snapshot(&state.database, &state.community);
    if !settings.enabled {
        return;
    }
    wait_for_pending_writes(state, REPORT_WRITES_WAIT).await;
    let database = state.database.clone();
    let session_id = ended.session_id.clone();
    let saved_session_id = session_id.clone();
    let threshold = settings.regular_streams;
    let outcome = tokio::task::spawn_blocking(move || {
        let (first_timers, stayed) = database.community_session_first_timers(&session_id)?;
        let block = report_community(
            &ended.report_arrivals,
            first_timers,
            stayed,
            ended.links_made,
            ended.opt_outs,
            threshold,
        );
        if block.is_empty() {
            return Ok(false);
        }
        let report = crate::protocol::CohostSessionReport::community_only(
            &session_id,
            block,
            &Utc::now().to_rfc3339(),
        );
        database.upsert_cohost_report(&report)
    })
    .await;
    match outcome {
        // An open Reports tab asks again (plan 119's event).
        Ok(Ok(true)) => state.emit_event(
            crate::cohost::COHOST_REPORT_SAVED_EVENT,
            crate::protocol::CohostReportSavedEvent {
                session_id: saved_session_id,
            },
        ),
        Ok(Ok(false)) => {}
        Ok(Err(error)) => state.emit_log(
            "warn",
            format!("Community: could not write the report's Community block: {error:#}"),
        ),
        Err(error) => state.emit_log(
            "warn",
            format!("Community: the report task failed: {error}"),
        ),
    }
}

/// Wait (bounded) until every detached store write has landed.
async fn wait_for_pending_writes(state: &AppState, limit: Duration) {
    let deadline = Instant::now() + limit;
    loop {
        if state.community.lock().pending_writes == 0 || Instant::now() >= deadline {
            return;
        }
        let _ = tokio::time::timeout(
            Duration::from_millis(200),
            state.community.writes_done.notified(),
        )
        .await;
    }
}

/// B1, D14: the arrival lookup, inside the same blocking read as the
/// first-time marker. One indexed read per fresh account. A store error
/// leaves every row without `arrival` and logs once per session. Returns
/// `account_key` → arrival for the returning people of this batch.
pub(crate) fn lookup_arrivals_blocking(
    database: &Database,
    slot: &CommunitySlot,
    session_id: &str,
    fresh: &[(StreamPlatform, String)],
    now: DateTime<Utc>,
) -> (HashMap<String, ViewerArrival>, Option<String>) {
    let settings = settings_snapshot(database, slot);
    if !settings.enabled || fresh.is_empty() {
        return (HashMap::new(), None);
    }
    // The runtime lock is held across the read so two batches never give
    // one person two arrivals. It is a std mutex inside `spawn_blocking`;
    // nothing async waits on it, and the store lock is taken inside it, so
    // nothing may take the runtime lock while holding the store's.
    let mut runtime = slot.lock();
    let Some(session) = runtime.session.as_mut() else {
        return (HashMap::new(), None);
    };
    if session.session_id != session_id {
        return (HashMap::new(), None);
    }
    let streamer_keys = match session.streamer_keys.clone() {
        Some(keys) => keys,
        None => match database.community_streamer_keys() {
            Ok(keys) => {
                session.streamer_keys = Some(keys.clone());
                keys
            }
            Err(_) => HashSet::new(),
        },
    };
    let mut arrived = std::mem::take(&mut session.arrived);
    let looked_up = database.community_lookup_arrivals(
        session_id,
        fresh,
        &streamer_keys,
        &mut arrived,
        now,
        settings.regular_streams,
        settings.remember,
    );
    session.arrived = arrived;
    match looked_up {
        Ok(lookups) => {
            let mut arrivals = HashMap::new();
            for lookup in lookups {
                if let Some(person_id) = lookup.person_id.clone() {
                    session.people_by_key.insert(lookup.key.clone(), person_id);
                }
                if let Some(arrival) = lookup.arrival {
                    arrivals.insert(lookup.key, arrival);
                }
            }
            (arrivals, None)
        }
        Err(error) => {
            let log = (!session.store_error_logged).then(|| {
                format!("Community: the arrival lookup failed; chat goes on without it: {error:#}")
            });
            session.store_error_logged = true;
            (HashMap::new(), log)
        }
    }
}

/// B1, B2, D14: a batch was delivered. One detached task writes it to the
/// store (one transaction), lists the arrivals under "Welcome back", and
/// answers the viewers' `!` commands. Never awaited by the delivery path.
pub(crate) fn record_delivered(state: &AppState, session_id: &str, messages: Vec<LiveChatMessage>) {
    if messages.is_empty() {
        return;
    }
    {
        let mut runtime = state.community.lock();
        runtime.pending_writes = runtime.pending_writes.saturating_add(1);
    }
    let state = state.clone();
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        record_delivered_task(&state, &session_id, messages).await;
        let mut runtime = state.community.lock();
        runtime.pending_writes = runtime.pending_writes.saturating_sub(1);
        drop(runtime);
        state.community.writes_done.notify_waiters();
    });
}

async fn record_delivered_task(state: &AppState, session_id: &str, messages: Vec<LiveChatMessage>) {
    let settings = settings_snapshot(&state.database, &state.community);
    let streamer_keys = {
        let runtime = state.community.lock();
        runtime
            .session
            .as_ref()
            .filter(|session| session.session_id == session_id)
            .and_then(|session| session.streamer_keys.clone())
    };
    let streamer_keys = match streamer_keys {
        Some(keys) => keys,
        None => {
            let database = state.database.clone();
            tokio::task::spawn_blocking(move || database.community_streamer_keys())
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default()
        }
    };
    let mut changed = false;
    if settings.enabled {
        let rows: Vec<CommunityRowFacts> = messages
            .iter()
            .filter_map(|message| CommunityRowFacts::from_message(message, &streamer_keys))
            .collect();
        if !rows.is_empty() {
            let database = state.database.clone();
            match tokio::task::spawn_blocking(move || {
                database.community_record_batch(&rows, Utc::now())
            })
            .await
            {
                Ok(Ok(outcome)) => {
                    changed = !outcome.new_accounts.is_empty() || outcome.suggestions_made > 0;
                }
                Ok(Err(error)) => log_store_error_once(state, session_id, &error),
                Err(error) => state.emit_log(
                    "warn",
                    format!("Community: the store write task failed: {error}"),
                ),
            }
        }
        // "Welcome back" (D11): the arrival rows of this batch.
        let arrivals: Vec<(CohostWelcomeBack, String)> = {
            let mut runtime = state.community.lock();
            let Some(session) = runtime
                .session
                .as_mut()
                .filter(|session| session.session_id == session_id)
            else {
                return;
            };
            // D15: the report counts what the arrival rows said.
            for message in &messages {
                if let Some(arrival) = message.arrival.clone()
                    && session.report_arrivals.len() < REPORT_ARRIVALS_MAX
                {
                    session.report_arrivals.push(ReportArrival {
                        name: message.author_name.trim().to_string(),
                        platform: message.platform,
                        arrival,
                    });
                }
            }
            messages
                .iter()
                .filter_map(|message| {
                    let arrival = message.arrival.clone()?;
                    let author_id = message.author_id.as_deref()?;
                    let key = account_key(message.platform, author_id);
                    let person_id = session.people_by_key.get(&key)?.clone();
                    Some((
                        CohostWelcomeBack {
                            person_id,
                            author_key: key,
                            name: message.author_name.trim().to_string(),
                            platform: message.platform,
                            arrival,
                            first_seen_at: message.received_at.clone(),
                        },
                        message.id.clone(),
                    ))
                })
                .collect()
        };
        if !arrivals.is_empty() {
            let now = Instant::now();
            let mut engine = state.cohost.lock().await;
            for (entry, message_id) in arrivals {
                engine.community.note_arrival(entry, message_id, now);
            }
            drop(engine);
            publish_cohost_state(state).await;
        }
    }
    // The viewers' commands (D13, D4 b) work with the store off too: they
    // are the deletion path.
    for message in &messages {
        if !matches!(
            message.event_type,
            LiveChatEventType::Message | LiveChatEventType::Paid
        ) || message.is_deleted
            || !message.message_text.trim_start().starts_with('!')
        {
            continue;
        }
        let Some(command) = parse_chat_command(&message.message_text) else {
            continue;
        };
        let Some(author_id) = message
            .author_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        if !platform_has_identity(message.platform) {
            continue;
        }
        let key = account_key(message.platform, author_id);
        if streamer_keys.contains(&key)
            || message.author_roles.iter().any(|role| {
                matches!(
                    role.trim().to_ascii_lowercase().as_str(),
                    "owner" | "broadcaster"
                )
            })
        {
            // The streamer's own `!link` does nothing (B2).
            continue;
        }
        if run_chat_command(state, session_id, message, &key, command).await {
            changed = true;
        }
    }
    if changed {
        emit_changed(state).await;
    }
}

/// D15: count something for this session's report.
fn count_for_report(state: &AppState, session_id: &str, count: impl FnOnce(&mut SessionCommunity)) {
    let mut runtime = state.community.lock();
    if let Some(session) = runtime
        .session
        .as_mut()
        .filter(|session| session.session_id == session_id)
    {
        count(session);
    }
}

/// D15: a link the streamer made while a chat session runs counts in that
/// session's report.
fn count_link_for_live_report(state: &AppState) {
    if let Some(session) = state.community.lock().session.as_mut() {
        session.links_made = session.links_made.saturating_add(1);
    }
}

fn log_store_error_once(state: &AppState, session_id: &str, error: &anyhow::Error) {
    let mut runtime = state.community.lock();
    let log = match runtime.session.as_mut() {
        Some(session) if session.session_id == session_id => {
            let first = !session.store_error_logged;
            session.store_error_logged = true;
            first
        }
        _ => true,
    };
    drop(runtime);
    if log {
        state.emit_log(
            "warn",
            format!("Community: the store write failed; chat goes on without it: {error:#}"),
        );
    }
}

/// One `!` command (B2). Returns whether the community changed.
async fn run_chat_command(
    state: &AppState,
    session_id: &str,
    message: &LiveChatMessage,
    key: &str,
    command: ChatCommand,
) -> bool {
    let database = state.database.clone();
    let name = message.author_name.trim().to_string();
    let now = Utc::now();
    let talk = state.cohost.lock().await.settings().auto_chat.talk();
    let mut changed = false;
    let mut line: Option<String> = None;
    match &command {
        ChatCommand::ForgetMe => {
            let forget_key = key.to_string();
            match tokio::task::spawn_blocking(move || {
                database.community_forget_account(&forget_key, now)
            })
            .await
            {
                Ok(Ok(_)) => {
                    changed = true;
                    line = command_bubble_line(talk, &command, &name, None);
                    count_for_report(state, session_id, |session| {
                        session.opt_outs = session.opt_outs.saturating_add(1)
                    });
                    state.emit_log(
                        "info",
                        format!(
                            "Community: a viewer asked to be forgotten ({}).",
                            crate::streaming::stream_platform_label(message.platform)
                        ),
                    );
                }
                Ok(Err(error)) => log_store_error_once(state, session_id, &error),
                Err(error) => {
                    state.emit_log("warn", format!("Community: !forgetme failed: {error}"))
                }
            }
        }
        ChatCommand::RememberMe => {
            let remember_key = key.to_string();
            match tokio::task::spawn_blocking(move || {
                database.community_remember_account(&remember_key)
            })
            .await
            {
                Ok(Ok(true)) => {
                    changed = true;
                    line = command_bubble_line(talk, &command, &name, None);
                }
                Ok(Ok(false)) => {}
                Ok(Err(error)) => log_store_error_once(state, session_id, &error),
                Err(error) => {
                    state.emit_log("warn", format!("Community: !rememberme failed: {error}"))
                }
            }
        }
        ChatCommand::Unlink => {
            let unlink_key = key.to_string();
            match tokio::task::spawn_blocking(move || database.community_unlink(&unlink_key, now))
                .await
            {
                Ok(Ok(_)) => {
                    changed = true;
                    line = command_bubble_line(talk, &command, &name, None);
                    let mut engine = state.cohost.lock().await;
                    if engine.community.note_unlinked(key) {
                        drop(engine);
                        publish_cohost_state(state).await;
                    }
                }
                Ok(Err(CommunityError::NotFound)) => {}
                Ok(Err(error)) => {
                    state.emit_log("warn", format!("Community: !unlink failed: {error}"))
                }
                Err(error) => state.emit_log("warn", format!("Community: !unlink failed: {error}")),
            }
        }
        ChatCommand::Link(word) => {
            let person_key = key.to_string();
            let person_id =
                tokio::task::spawn_blocking(move || database.community_account_person(&person_key))
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .flatten();
            let Some(person_id) = person_id else {
                return false;
            };
            let claim = LinkClaim {
                account_key: key.to_string(),
                platform: message.platform,
                person_id,
                name: name.clone(),
                at: Instant::now(),
            };
            let outcome = {
                let mut runtime = state.community.lock();
                match runtime
                    .session
                    .as_mut()
                    .filter(|session| session.session_id == session_id)
                {
                    Some(session) => session.links.claim(word, claim),
                    None => LinkOutcome::Ignored,
                }
            };
            match outcome {
                LinkOutcome::Waiting | LinkOutcome::Ignored => {}
                LinkOutcome::Linked { first, second } => {
                    let database = state.database.clone();
                    let (a, b) = (first.person_id.clone(), second.person_id.clone());
                    match tokio::task::spawn_blocking(move || {
                        database.community_link(&a, &b, CommunityLinkKind::SelfLink, now)
                    })
                    .await
                    {
                        Ok(Ok(kept)) => {
                            changed = true;
                            count_for_report(state, session_id, |session| {
                                session.links_made = session.links_made.saturating_add(1)
                            });
                            line = command_bubble_line(
                                talk,
                                &command,
                                &name,
                                Some((&first.name, first.platform, &second.name, second.platform)),
                            );
                            let link = CohostLinkMade {
                                person_id: kept,
                                names: [first.name.clone(), second.name.clone()],
                                platforms: [first.platform, second.platform],
                                account_key: second.account_key.clone(),
                                at: now.to_rfc3339(),
                            };
                            state
                                .cohost
                                .lock()
                                .await
                                .community
                                .note_link_made(link, Instant::now());
                            publish_cohost_state(state).await;
                        }
                        Ok(Err(error)) => {
                            state.emit_log("warn", format!("Community: !link failed: {error}"))
                        }
                        Err(error) => {
                            state.emit_log("warn", format!("Community: !link failed: {error}"))
                        }
                    }
                }
                LinkOutcome::Cancelled { first, second } => {
                    let database = state.database.clone();
                    let (a, b) = (first.account_key.clone(), second.account_key.clone());
                    if let Ok(Ok(())) = tokio::task::spawn_blocking(move || {
                        database.community_link_cancelled(&a, &b, now)
                    })
                    .await
                    {
                        changed = true;
                    }
                }
            }
        }
    }
    if let Some(text) = line {
        say_in_bubble(state, text, Some(message.id.clone())).await;
    }
    changed
}

/// A community line for the bubble (D13, D4 b): `bubble-only`, no
/// destination, through the plan 211 queue. The caller only passes a line
/// in Bubble mode; the utterance has no send path whatever the mode.
async fn say_in_bubble(state: &AppState, text: String, event_id: Option<String>) {
    #[cfg(test)]
    state.community.lock().bubble_lines.push(text.clone());
    let utterance = CohostUtterance {
        id: format!("community-{}", uuid::Uuid::new_v4()),
        text,
        state: CohostUtteranceState::Talk,
        trigger: CohostUtteranceTrigger {
            kind: CohostUtteranceTriggerKind::Community,
            event_id,
            message_id: None,
        },
        destination_ids: Vec::new(),
        status: CohostUtteranceStatus::BubbleOnly,
        at: Utc::now().to_rfc3339(),
        expires_at: None,
        milestone: None,
    };
    crate::buddy_overlay::queue_for_utterance(state, &utterance, None).await;
}

async fn publish_cohost_state(state: &AppState) {
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let snapshot = state.cohost.lock().await.snapshot();
    state.emit_event(COHOST_STATE_EVENT, snapshot);
    drop(lifecycle_delivery);
}

/// Tests: the lines handed to the bubble so far.
#[cfg(test)]
pub(crate) fn bubble_lines(state: &AppState) -> Vec<String> {
    state.community.lock().bubble_lines.clone()
}

/// Tests: `!link` words waiting for their pair.
#[cfg(test)]
pub(crate) fn pending_link_words(state: &AppState) -> usize {
    state
        .community
        .lock()
        .session
        .as_ref()
        .map_or(0, |session| session.links.waiting())
}

/// Tests: wait until every detached store write landed.
#[cfg(test)]
pub(crate) async fn wait_for_writes(state: &AppState) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if state.community.lock().pending_writes == 0 {
            return;
        }
        if Instant::now() >= deadline {
            return;
        }
        let _ = tokio::time::timeout(
            Duration::from_millis(200),
            state.community.writes_done.notified(),
        )
        .await;
    }
}

// --- Events --------------------------------------------------------------------

async fn current_summary(state: &AppState) -> Result<CommunitySummary, CommunityError> {
    let settings = settings_snapshot(&state.database, &state.community);
    let running = state.community.lock().backfill_running;
    let database = state.database.clone();
    tokio::task::spawn_blocking(move || {
        let progress = database.community_backfill_progress();
        database.community_summary(Utc::now(), settings.regular_streams, progress.wire(running))
    })
    .await
    .map_err(|error| CommunityError::Storage(error.to_string()))?
    .map_err(CommunityError::from)
}

/// `cohost.community.changed`: the summary, after anything that changed it.
pub(crate) async fn emit_changed(state: &AppState) {
    match current_summary(state).await {
        Ok(summary) => state.emit_event(COMMUNITY_CHANGED_EVENT, summary),
        Err(error) => state.emit_log("warn", format!("Community: {error}")),
    }
}

// --- RPCs -------------------------------------------------------------------------

async fn blocking<T, F>(state: &AppState, work: F) -> Result<T, CommunityError>
where
    T: Send + 'static,
    F: FnOnce(Database) -> Result<T, CommunityError> + Send + 'static,
{
    let database = state.database.clone();
    tokio::task::spawn_blocking(move || work(database))
        .await
        .map_err(|error| CommunityError::Storage(error.to_string()))?
}

fn threshold(state: &AppState) -> u32 {
    settings_snapshot(&state.database, &state.community).regular_streams
}

pub async fn summary(state: &AppState) -> Result<CommunitySummary, CommunityError> {
    current_summary(state).await
}

/// `cohost.community.suggestions` (D12 "Links that need you"): every open
/// suggestion and cancelled `!link`, newest first.
pub async fn suggestions(
    state: &AppState,
) -> Result<crate::community::CommunitySuggestionsPage, CommunityError> {
    blocking(state, move |database| {
        Ok(crate::community::CommunitySuggestionsPage {
            suggestions: database
                .community_open_suggestions()?
                .into_iter()
                .take(500)
                .collect(),
        })
    })
    .await
}

pub async fn list(
    state: &AppState,
    params: CommunityListParams,
) -> Result<CommunityListPage, CommunityError> {
    let threshold = threshold(state);
    blocking(state, move |database| {
        database
            .community_list(&params, Utc::now(), threshold)
            .map_err(CommunityError::from)
    })
    .await
}

pub async fn person(
    state: &AppState,
    params: CommunityPersonParams,
) -> Result<CommunityPerson, CommunityError> {
    let threshold = threshold(state);
    blocking(state, move |database| {
        database.community_person(&params, Utc::now(), threshold)
    })
    .await
}

async fn person_by_id(
    state: &AppState,
    person_id: String,
) -> Result<CommunityPerson, CommunityError> {
    person(
        state,
        CommunityPersonParams {
            person_id: Some(person_id),
            ..Default::default()
        },
    )
    .await
}

pub async fn update(
    state: &AppState,
    params: CommunityUpdateParams,
) -> Result<CommunityPerson, CommunityError> {
    let person_id = params.person_id.trim().to_string();
    if person_id.is_empty() {
        return Err(CommunityError::Invalid("personId is required.".to_string()));
    }
    let id = person_id.clone();
    blocking(state, move |database| {
        database.community_update(&id, params.note.as_deref(), params.status, Utc::now())
    })
    .await?;
    emit_changed(state).await;
    person_by_id(state, person_id).await
}

/// `cohost.community.link` (D4 a): the streamer's "Same person as…".
pub async fn link(
    state: &AppState,
    params: CommunityLinkParams,
) -> Result<CommunityPerson, CommunityError> {
    let (a, b) = (
        params.person_id.trim().to_string(),
        params.other_person_id.trim().to_string(),
    );
    if a.is_empty() || b.is_empty() {
        return Err(CommunityError::Invalid(
            "personId and otherPersonId are required.".to_string(),
        ));
    }
    let kept = blocking(state, move |database| {
        database.community_link(&a, &b, CommunityLinkKind::Manual, Utc::now())
    })
    .await?;
    count_link_for_live_report(state);
    emit_changed(state).await;
    person_by_id(state, kept).await
}

/// `cohost.community.unlink` (D4): "Not the same person", or the Undo of a
/// `!link` card.
pub async fn unlink(
    state: &AppState,
    params: CommunityUnlinkParams,
) -> Result<CommunityUnlinkResult, CommunityError> {
    let key = params.account_key.trim().to_string();
    if key.is_empty() {
        return Err(CommunityError::Invalid(
            "accountKey is required.".to_string(),
        ));
    }
    let undo_key = key.clone();
    let person_id = blocking(state, move |database| {
        database.community_unlink(&undo_key, Utc::now())
    })
    .await?;
    let mut engine = state.cohost.lock().await;
    let card_left = engine.community.note_unlinked(&key);
    drop(engine);
    if card_left {
        publish_cohost_state(state).await;
    }
    emit_changed(state).await;
    Ok(CommunityUnlinkResult { person_id })
}

pub async fn suggestion_dismiss(
    state: &AppState,
    params: CommunitySuggestionParams,
) -> Result<CommunityAccepted, CommunityError> {
    let (a, b) = (
        params.account_a.trim().to_string(),
        params.account_b.trim().to_string(),
    );
    if a.is_empty() || b.is_empty() {
        return Err(CommunityError::Invalid(
            "accountA and accountB are required.".to_string(),
        ));
    }
    blocking(state, move |database| {
        database
            .community_suggestion_dismiss(&a, &b)
            .map_err(CommunityError::from)
    })
    .await?;
    emit_changed(state).await;
    Ok(CommunityAccepted { accepted: true })
}

/// "Same person" on a suggestion (D4 c): the two accounts' people join.
pub async fn suggestion_accept(
    state: &AppState,
    params: CommunitySuggestionParams,
) -> Result<CommunityPerson, CommunityError> {
    let (a, b) = (
        params.account_a.trim().to_string(),
        params.account_b.trim().to_string(),
    );
    if a.is_empty() || b.is_empty() {
        return Err(CommunityError::Invalid(
            "accountA and accountB are required.".to_string(),
        ));
    }
    let kept = blocking(state, move |database| {
        database.community_suggestion_accept(&a, &b, Utc::now())
    })
    .await?;
    count_link_for_live_report(state);
    emit_changed(state).await;
    person_by_id(state, kept).await
}

pub async fn forget(
    state: &AppState,
    params: CommunityPersonIdParams,
) -> Result<CommunityAccepted, CommunityError> {
    let person_id = params.person_id.trim().to_string();
    if person_id.is_empty() {
        return Err(CommunityError::Invalid("personId is required.".to_string()));
    }
    let id = person_id.clone();
    blocking(state, move |database| {
        database.community_forget_person(&id, Utc::now())
    })
    .await?;
    let mut engine = state.cohost.lock().await;
    let row_left = engine.community.note_waved(&person_id);
    drop(engine);
    if row_left {
        publish_cohost_state(state).await;
    }
    emit_changed(state).await;
    Ok(CommunityAccepted { accepted: true })
}

pub async fn forget_all(state: &AppState) -> Result<CommunityAccepted, CommunityError> {
    blocking(state, move |database| {
        database
            .community_forget_all()
            .map_err(CommunityError::from)
    })
    .await?;
    {
        let mut runtime = state.community.lock();
        if let Some(session) = runtime.session.as_mut() {
            session.arrived.clear();
            session.people_by_key.clear();
            session.links.clear();
        }
    }
    state.cohost.lock().await.community.clear();
    publish_cohost_state(state).await;
    emit_changed(state).await;
    Ok(CommunityAccepted { accepted: true })
}

pub async fn memory_delete(
    state: &AppState,
    params: CommunityIdParams,
) -> Result<CommunityAccepted, CommunityError> {
    let id = params.id.trim().to_string();
    if id.is_empty() {
        return Err(CommunityError::Invalid("id is required.".to_string()));
    }
    blocking(state, move |database| {
        database
            .community_memory_delete(&id)
            .map_err(CommunityError::from)
    })
    .await?;
    Ok(CommunityAccepted { accepted: true })
}

/// `cohost.community.wave` (B5, D11): the regular reaction and, in Bubble
/// mode, "Hey {name}!" in the bubble. Never chat. The person leaves
/// "Welcome back".
pub async fn wave(
    state: &AppState,
    params: CommunityPersonIdParams,
) -> Result<CommunityAccepted, CommunityError> {
    let person_id = params.person_id.trim().to_string();
    if person_id.is_empty() {
        return Err(CommunityError::Invalid("personId is required.".to_string()));
    }
    let person = person_by_id(state, person_id.clone()).await?;
    wave_at(state, &person_id, &person.name).await;
    Ok(CommunityAccepted { accepted: true })
}

/// The wave itself, shared with the voice command (B5).
pub(crate) async fn wave_at(state: &AppState, person_id: &str, name: &str) {
    state
        .buddy_sprite
        .notify(crate::buddy_animator::BuddyAnimatorEvent::Trigger {
            trigger: crate::buddy_pet::BuddyTrigger::Regular,
            reaction: None,
        });
    let talk = state.cohost.lock().await.settings().auto_chat.talk();
    if talk == CohostTalkMode::Bubble {
        say_in_bubble(state, format!("Hey {}!", name.trim()), None).await;
    }
    let mut engine = state.cohost.lock().await;
    let row_left = engine.community.note_waved(person_id);
    drop(engine);
    if row_left {
        publish_cohost_state(state).await;
    }
}

/// B5: "Buddy, remember that {name} {fact}" after the streamer's yes: the
/// fact joins the person's note (never the AI memory list), within the
/// note's 300 characters.
pub(crate) async fn append_note(state: &AppState, person_id: &str, fact: &str) {
    let fact = fact.trim();
    if person_id.trim().is_empty() || fact.is_empty() {
        return;
    }
    let Ok(person) = person_by_id(state, person_id.to_string()).await else {
        return;
    };
    let mut note = person.note.trim().to_string();
    if !note.is_empty() {
        note.push_str("; ");
    }
    note.push_str(fact);
    let id = person_id.to_string();
    if let Err(error) = blocking(state, move |database| {
        database.community_update(&id, Some(&note), None, Utc::now())
    })
    .await
    {
        state.emit_log(
            "warn",
            format!("Community: could not save the note: {error}"),
        );
        return;
    }
    emit_changed(state).await;
}

/// The name an export gets inside the chosen folder: `videorc-community-
/// <date>.json`, with a counter once that day's file exists, so an export
/// never overwrites an earlier one.
pub(crate) fn export_file_name(directory: &std::path::Path, today: chrono::NaiveDate) -> String {
    let base = format!("videorc-community-{}", today.format("%Y-%m-%d"));
    let mut name = format!("{base}.json");
    let mut counter = 2u32;
    while directory.join(&name).exists() {
        name = format!("{base}-{counter}.json");
        counter = counter.saturating_add(1);
    }
    name
}

/// Export… (D12): the whole store as one JSON file in the folder main's
/// picker issued (an `output-directory` capability, consumed in `main.rs`;
/// the renderer never names a path).
pub async fn export(
    state: &AppState,
    params: CommunityExportParams,
) -> Result<CommunityExportResult, CommunityError> {
    let directory = params.output_directory.trim().to_string();
    if directory.is_empty() {
        return Err(CommunityError::Invalid(
            "outputDirectory is required.".to_string(),
        ));
    }
    blocking(state, move |database| {
        let now = Utc::now();
        let directory = std::path::PathBuf::from(directory);
        if !directory.is_dir() {
            return Err(CommunityError::Invalid(format!(
                "{} is not a folder.",
                directory.display()
            )));
        }
        let file = database.community_export(now)?;
        let json = serde_json::to_vec_pretty(&file)
            .map_err(|error| CommunityError::Storage(error.to_string()))?;
        let file_name = export_file_name(&directory, now.date_naive());
        let path = directory.join(&file_name);
        std::fs::write(&path, &json).map_err(|error| {
            CommunityError::Invalid(format!("Could not write {}: {error}", path.display()))
        })?;
        Ok(CommunityExportResult {
            people: u32::try_from(file.people.len()).unwrap_or(u32::MAX),
            bytes: json.len() as u64,
            file_name,
        })
    })
    .await
}

/// Import… (D12): one export file main's picker issued (an `input-file`
/// capability, consumed in `main.rs`), merged into the store.
pub async fn import(
    state: &AppState,
    params: CommunityImportParams,
) -> Result<CommunityImportResult, CommunityError> {
    let path = params.path.trim().to_string();
    if path.is_empty() {
        return Err(CommunityError::Invalid("path is required.".to_string()));
    }
    let result = blocking(state, move |database| {
        let bytes = std::fs::read(&path)
            .map_err(|error| CommunityError::Invalid(format!("Could not read {path}: {error}")))?;
        let file: CommunityExportFile = serde_json::from_slice(&bytes)
            .map_err(|error| CommunityError::Invalid(format!("Not a community export: {error}")))?;
        let (people, merged) = database.community_import(&file, Utc::now())?;
        Ok(CommunityImportResult { people, merged })
    })
    .await?;
    emit_changed(state).await;
    Ok(result)
}

// --- Buddy remembers: the memory pass (D10, F3) -------------------------------------

/// A pass that could not run is retried for this long, then dropped.
const MEMORY_JOB_MAX_AGE_DAYS: i64 = 7;
/// Queued passes are looked at this soon after start, then this often.
const MEMORY_JOBS_FIRST_DELAY: Duration = Duration::from_secs(45);
const MEMORY_JOBS_EVERY: Duration = Duration::from_secs(30 * 60);
/// A person needs this many messages this stream to be in the pass.
const MEMORY_MESSAGES_MIN: usize = 2;

/// Between attempts: 5 minutes, then doubling, at most 6 hours.
fn memory_job_backoff(attempts: u32) -> chrono::Duration {
    let minutes = 5i64.saturating_mul(1i64 << attempts.saturating_sub(1).min(8));
    chrono::Duration::minutes(minutes.min(6 * 60))
}

/// A stream ended (D10): queue its pass when "Buddy remembers" is on and a
/// consented Buddy session ran, then try the queue.
async fn enqueue_memory_pass(state: &AppState, session_id: &str, consented: bool) {
    let settings = settings_snapshot(&state.database, &state.community);
    if !settings.enabled || !settings.remember || !consented {
        return;
    }
    let database = state.database.clone();
    let id = session_id.to_string();
    match tokio::task::spawn_blocking(move || {
        database.community_memory_job_enqueue(&id, Utc::now())
    })
    .await
    {
        Ok(Ok(())) => run_memory_jobs(state).await,
        Ok(Err(error)) => state.emit_log(
            "warn",
            format!("Community: could not queue the memory pass: {error:#}"),
        ),
        Err(error) => state.emit_log(
            "warn",
            format!("Community: the memory queue task failed: {error}"),
        ),
    }
}

fn spawn_memory_jobs(state: &AppState) {
    let state = state.clone();
    tokio::spawn(async move {
        run_memory_jobs(&state).await;
    });
}

/// The queued passes against the real route. Signed out, nothing runs and
/// nothing is counted: the passes wait.
pub(crate) async fn run_memory_jobs(state: &AppState) {
    // A unit test never reaches the real route (the secrets store falls
    // back to the process environment there): tests drive
    // `run_memory_jobs_with` with a fake.
    #[cfg(test)]
    {
        let _ = state;
        return;
    }
    #[cfg(not(test))]
    {
        let Some(token) = crate::account::stored_session_token() else {
            return;
        };
        run_memory_jobs_with(state, crate::cohost::premium_entitled(), |request| {
            let token = token.clone();
            async move {
                match crate::videorc_api::VideorcApiClient::new() {
                    Ok(client) => client.post_cohost_memory(&token, &request).await,
                    Err(error) => Err(CohostApiError::network(error.to_string())),
                }
            }
        })
        .await;
    }
}

/// The queued passes, one at a time (D10): a pass whose session is gone or
/// older than seven days is dropped; one tried too recently waits; the
/// rest need Premium, "Buddy remembers" and the web's `cohost.memory`, else
/// they keep waiting. A 403 or a 429 keeps the pass for later; anything
/// else retries sooner. Nothing here ever waits on chat, and chat never
/// waits on this (D14).
pub(crate) async fn run_memory_jobs_with<F, Fut>(state: &AppState, premium: bool, post: F)
where
    F: Fn(CohostMemoryRequest) -> Fut,
    Fut: std::future::Future<Output = Result<CohostMemoryResponse, CohostApiError>>,
{
    {
        let mut runtime = state.community.lock();
        if runtime.memory_jobs_running {
            return;
        }
        runtime.memory_jobs_running = true;
    }
    run_memory_jobs_inner(state, premium, &post).await;
    state.community.lock().memory_jobs_running = false;
}

async fn run_memory_jobs_inner<F, Fut>(state: &AppState, premium: bool, post: &F)
where
    F: Fn(CohostMemoryRequest) -> Fut,
    Fut: std::future::Future<Output = Result<CohostMemoryResponse, CohostApiError>>,
{
    let database = state.database.clone();
    let jobs = match tokio::task::spawn_blocking(move || database.community_memory_jobs()).await {
        Ok(Ok(jobs)) => jobs,
        Ok(Err(error)) => {
            state.emit_log(
                "warn",
                format!("Community: could not read the memory passes: {error:#}"),
            );
            return;
        }
        Err(error) => {
            state.emit_log(
                "warn",
                format!("Community: the memory pass task failed: {error}"),
            );
            return;
        }
    };
    for job in jobs {
        let now = Utc::now();
        let session_id = job.session_id.clone();
        let database = state.database.clone();
        let too_old = now.signed_duration_since(job.created_at)
            > chrono::Duration::days(MEMORY_JOB_MAX_AGE_DAYS);
        let exists = {
            let database = database.clone();
            let id = session_id.clone();
            tokio::task::spawn_blocking(move || database.session_exists(&id))
                .await
                .ok()
                .and_then(Result::ok)
        };
        if too_old || exists == Some(false) {
            let id = session_id.clone();
            let _ = tokio::task::spawn_blocking(move || database.community_memory_job_delete(&id))
                .await;
            state.emit_log(
                "info",
                format!(
                    "Community: the memory pass for {session_id} is dropped ({}).",
                    if too_old {
                        "older than a week"
                    } else {
                        "its stream was deleted"
                    }
                ),
            );
            continue;
        }
        if exists.is_none() {
            continue;
        }
        if let Some(last) = job.last_attempt_at
            && now < last + memory_job_backoff(job.attempts)
        {
            continue;
        }
        let settings = settings_snapshot(&state.database, &state.community);
        if !settings.enabled || !settings.remember || !premium {
            continue;
        }
        if state.community.lock().web_memory_version.unwrap_or(0) < 1 {
            continue;
        }
        let built = {
            let database = database.clone();
            let id = session_id.clone();
            let threshold = settings.regular_streams;
            tokio::task::spawn_blocking(move || {
                build_memory_request(&database, &id, now, threshold)
            })
            .await
        };
        let (request, plan) = match built {
            Ok(Ok(Some(built))) => built,
            Ok(Ok(None)) => {
                // Nobody chatted twice: there is nothing to learn from.
                let id = session_id.clone();
                let _ =
                    tokio::task::spawn_blocking(move || database.community_memory_job_delete(&id))
                        .await;
                continue;
            }
            Ok(Err(error)) => {
                let message = format!("{error:#}");
                let id = session_id.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    database.community_memory_job_attempted(&id, &message, now)
                })
                .await;
                state.emit_log(
                    "warn",
                    format!(
                        "Community: could not build the memory pass for {session_id}: {error:#}"
                    ),
                );
                continue;
            }
            Err(error) => {
                state.emit_log(
                    "warn",
                    format!("Community: the memory pass task failed: {error}"),
                );
                continue;
            }
        };
        match post(request).await {
            Ok(response) => {
                let id = session_id.clone();
                let applied = tokio::task::spawn_blocking(move || {
                    let (learned, summary) =
                        apply_memory_response(&database, &id, &plan, &response, now)?;
                    write_memory_report(&database, &id, learned, summary, now)?;
                    database.community_memory_job_delete(&id)?;
                    Ok::<u32, anyhow::Error>(learned)
                })
                .await;
                match applied {
                    Ok(Ok(learned)) => {
                        state.emit_log(
                            "info",
                            format!(
                                "Community: Buddy's memory pass for {session_id} learned {learned} thing(s)."
                            ),
                        );
                        state.emit_event(
                            crate::cohost::COHOST_REPORT_SAVED_EVENT,
                            crate::protocol::CohostReportSavedEvent {
                                session_id: session_id.clone(),
                            },
                        );
                        emit_changed(state).await;
                    }
                    Ok(Err(error)) => state.emit_log(
                        "warn",
                        format!(
                            "Community: could not keep the memory pass for {session_id}: {error:#}"
                        ),
                    ),
                    Err(error) => state.emit_log(
                        "warn",
                        format!("Community: the memory pass task failed: {error}"),
                    ),
                }
            }
            Err(error) => {
                let message = error.message().to_string();
                let id = session_id.clone();
                let noted = message.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    database.community_memory_job_attempted(&id, &noted, now)
                })
                .await;
                let kept = matches!(
                    error.kind,
                    CohostApiErrorKind::PremiumRequired
                        | CohostApiErrorKind::Unauthorized
                        | CohostApiErrorKind::ConsentRequired
                        | CohostApiErrorKind::QuotaExhausted { .. }
                );
                state.emit_log(
                    "info",
                    format!(
                        "Community: the memory pass for {session_id} {}: {message}",
                        if kept {
                            "waits for later"
                        } else {
                            "retries later"
                        }
                    ),
                );
            }
        }
    }
}

/// What applying an answer needs to know about the request it answers:
/// each ref's person, their accounts by platform (a new memory lands on
/// the account whose words taught it) and the memory ids they own.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct MemoryPlan {
    people: Vec<MemoryPlanPerson>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MemoryPlanPerson {
    reference: String,
    person_id: String,
    accounts: Vec<(String, StreamPlatform)>,
    memory_ids: HashSet<String>,
}

/// The pass's request for a stream (D10): the people who chatted at least
/// twice (never a YouTube message, never a bot, never anyone forgotten or
/// the streamer), at most 15 by message count, each with their newest 20
/// messages, what Buddy knows and the streamer's note; the stream's counts
/// and title from its report; the persona. `None` when nobody qualifies.
/// The body is kept under the route's 128 KB by dropping the quietest
/// people.
pub(crate) fn build_memory_request(
    database: &Database,
    session_id: &str,
    now: DateTime<Utc>,
    threshold: u32,
) -> anyhow::Result<Option<(CohostMemoryRequest, MemoryPlan)>> {
    let streamer_keys = database.community_streamer_keys()?;
    let messages = database.list_live_chat_messages(session_id)?;
    // Per account key: (name, platform, at, text), oldest first.
    let mut by_key: HashMap<String, Vec<(StreamPlatform, DateTime<Utc>, String)>> = HashMap::new();
    let mut names: HashMap<String, String> = HashMap::new();
    for message in &messages {
        // A YouTube message never leaves the computer for this (D3, D10).
        if message.platform == StreamPlatform::Youtube {
            continue;
        }
        let Some(facts) = CommunityRowFacts::from_message(message, &streamer_keys) else {
            continue;
        };
        if !facts.counts {
            continue;
        }
        let text = truncate_utf16(message.message_text.trim(), COHOST_MEMORY_MESSAGE_MAX_CHARS);
        if text.is_empty() {
            continue;
        }
        let key = facts.key();
        names.insert(key.clone(), facts.name.clone());
        by_key
            .entry(key)
            .or_default()
            .push((facts.platform, facts.at, text));
    }
    if by_key.is_empty() {
        return Ok(None);
    }
    let keys: Vec<String> = by_key.keys().cloned().collect();
    let (person_of, people) = database.community_memory_people(&keys, now, threshold)?;
    // Messages per person, over all their accounts.
    let mut rows_by_person: HashMap<String, Vec<(StreamPlatform, DateTime<Utc>, String)>> =
        HashMap::new();
    for (key, rows) in by_key {
        let Some(person_id) = person_of.get(&key) else {
            continue;
        };
        rows_by_person
            .entry(person_id.clone())
            .or_default()
            .extend(rows);
    }
    let mut ranked: Vec<(String, Vec<(StreamPlatform, DateTime<Utc>, String)>)> = rows_by_person
        .into_iter()
        .filter(|(_, rows)| rows.len() >= MEMORY_MESSAGES_MIN)
        .collect();
    ranked.sort_by(|(a_id, a), (b_id, b)| b.len().cmp(&a.len()).then_with(|| a_id.cmp(b_id)));
    let report = database.get_cohost_report(session_id)?;
    let counts = report
        .as_ref()
        .and_then(|report| report.community.as_ref())
        .map(|community| CohostMemoryCounts {
            regulars_back: community.regulars_back,
            first_timers: community.first_timers,
            first_timers_stayed: community.first_timers_stayed,
            comebacks: community.comebacks,
        })
        .unwrap_or_default();
    let stream_title = report
        .as_ref()
        .and_then(|report| report.stream_title.clone())
        .map(|title| truncate_utf16(title.trim(), 300))
        .filter(|title| !title.is_empty());
    let persona = {
        let settings = crate::cohost::load_cohost_settings(database);
        let name = truncate_utf16(
            settings.persona.name.trim(),
            crate::cohost::COHOST_PERSONA_NAME_MAX_CHARS,
        );
        (!name.is_empty()).then(|| CohostTickPersona {
            name,
            personality: truncate_utf16(
                &settings.persona.personality,
                crate::cohost::COHOST_PERSONA_PERSONALITY_MAX_CHARS,
            ),
        })
    };
    let mut wire_people = Vec::new();
    let mut plan = MemoryPlan::default();
    for (index, (person_id, mut rows)) in ranked
        .into_iter()
        .take(COHOST_MEMORY_PEOPLE_MAX)
        .enumerate()
    {
        let Some(facts) = people.get(&person_id) else {
            continue;
        };
        rows.sort_by(|a, b| a.1.cmp(&b.1));
        let newest: Vec<CohostMemoryMessage> = rows
            .iter()
            .rev()
            .take(COHOST_MEMORY_MESSAGES_MAX)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|(platform, at, text)| CohostMemoryMessage {
                at: at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                platform: *platform,
                text: text.clone(),
            })
            .collect();
        let mut platforms: Vec<StreamPlatform> = facts
            .accounts
            .iter()
            .map(|(_, platform)| *platform)
            .collect();
        platforms.sort_by_key(|platform| crate::streaming::stream_platform_id(*platform));
        platforms.dedup();
        if platforms.is_empty() {
            continue;
        }
        let reference = format!("p{}", index + 1);
        let known: Vec<CohostMemoryKnown> = facts
            .memories
            .iter()
            .take(crate::community_store::MEMORY_PER_PERSON_MAX)
            .map(|memory| CohostMemoryKnown {
                id: memory.id.clone(),
                text: truncate_utf16(memory.text.trim(), COHOST_MEMORY_TEXT_MAX_CHARS),
            })
            .filter(|memory| !memory.text.is_empty())
            .collect();
        let note = truncate_utf16(facts.note.trim(), COHOST_MEMORY_NOTE_MAX_CHARS);
        wire_people.push(CohostMemoryPerson {
            r#ref: reference.clone(),
            name: truncate_utf16(facts.name.trim(), COHOST_MEMORY_NAME_MAX_CHARS),
            platforms,
            regular: facts.regular,
            streams: facts.streams,
            messages: newest,
            memories: (!known.is_empty()).then_some(known),
            note: (!note.is_empty()).then_some(note),
        });
        plan.people.push(MemoryPlanPerson {
            reference,
            person_id: person_id.clone(),
            accounts: facts.accounts.clone(),
            memory_ids: facts
                .memories
                .iter()
                .map(|memory| memory.id.clone())
                .collect(),
        });
    }
    if wire_people.is_empty() {
        return Ok(None);
    }
    let mut request = CohostMemoryRequest {
        prompt_version: COHOST_MEMORY_PROMPT_VERSION,
        client_version: crate::cohost::DESKTOP_CLIENT_VERSION.to_string(),
        session_client_id: session_id.to_string(),
        consent_to_process_chat: true,
        persona,
        stream_title,
        counts,
        people: wire_people,
    };
    // The route refuses a bigger body: drop the quietest people first.
    while request.people.len() > 1
        && serde_json::to_vec(&request)
            .map(|body| body.len())
            .unwrap_or(usize::MAX)
            > COHOST_MEMORY_MAX_BODY_BYTES - 2048
    {
        request.people.pop();
        plan.people.pop();
    }
    Ok(Some((request, plan)))
}

/// The answer, applied (D10): per person in the plan, at most two new
/// memories (on the account of the platform that taught them), the
/// updates and removals of their own ids; anything for a ref or an id the
/// request did not send is ignored. Returns how many were learned and the
/// audience summary.
pub(crate) fn apply_memory_response(
    database: &Database,
    session_id: &str,
    plan: &MemoryPlan,
    response: &CohostMemoryResponse,
    now: DateTime<Utc>,
) -> anyhow::Result<(u32, Option<String>)> {
    let mut learned = 0u32;
    let mut answered: HashSet<&str> = HashSet::new();
    for result in &response.people {
        let Some(person) = plan
            .people
            .iter()
            .find(|person| person.reference == result.r#ref)
        else {
            continue;
        };
        if !answered.insert(person.reference.as_str()) {
            continue;
        }
        let adds: Vec<(String, String)> = result
            .add
            .iter()
            .take(COHOST_MEMORY_ADDS_MAX)
            .filter_map(|add| {
                let text = truncate_utf16(add.text.trim(), COHOST_MEMORY_TEXT_MAX_CHARS);
                if text.is_empty() || text.contains('\n') {
                    return None;
                }
                let account = person
                    .accounts
                    .iter()
                    .find(|(_, platform)| *platform == add.platform)
                    .or_else(|| person.accounts.first())?;
                Some((text, account.0.clone()))
            })
            .collect();
        let updates: Vec<(String, String)> = result
            .update
            .iter()
            .filter(|known| person.memory_ids.contains(&known.id))
            .filter_map(|known| {
                let text = truncate_utf16(known.text.trim(), COHOST_MEMORY_TEXT_MAX_CHARS);
                (!text.is_empty() && !text.contains('\n')).then(|| (known.id.clone(), text))
            })
            .collect();
        let removes: Vec<String> = result
            .remove
            .iter()
            .filter(|id| person.memory_ids.contains(*id))
            .cloned()
            .collect();
        if adds.is_empty() && updates.is_empty() && removes.is_empty() {
            continue;
        }
        learned = learned.saturating_add(database.community_memories_apply(
            &person.person_id,
            session_id,
            &adds,
            &updates,
            &removes,
            now,
        )?);
    }
    let summary = response
        .summary
        .as_deref()
        .map(|summary| {
            truncate_utf16(
                summary
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .trim(),
                COHOST_MEMORY_SUMMARY_MAX_CHARS,
            )
        })
        .filter(|summary| !summary.is_empty());
    Ok((learned, summary))
}

/// The pass's two lines in the report (D15): what was learned and the
/// audience summary, folded into the session's Community block.
fn write_memory_report(
    database: &Database,
    session_id: &str,
    learned: u32,
    summary: Option<String>,
    now: DateTime<Utc>,
) -> anyhow::Result<()> {
    let mut block = database
        .get_cohost_report(session_id)?
        .and_then(|report| report.community)
        .unwrap_or_default();
    block.memories_learned = learned;
    if summary.is_some() {
        block.summary = summary;
    }
    database.upsert_cohost_report(&crate::protocol::CohostSessionReport::community_only(
        session_id,
        block,
        &now.to_rfc3339(),
    ))?;
    Ok(())
}

// --- Jobs: backfill (A3) and retention (A4) ------------------------------------------

/// At app start: the retention prune now and every day, and the backfill
/// once (resumable).
pub fn spawn_startup_jobs(state: &AppState) {
    let retention = state.clone();
    tokio::spawn(async move {
        loop {
            run_prune(&retention).await;
            tokio::time::sleep(PRUNE_EVERY).await;
        }
    });
    // D10: the memory passes a quit left queued, once the capability read
    // and sign-in had a moment, then every half hour.
    let memory = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(MEMORY_JOBS_FIRST_DELAY).await;
        loop {
            run_memory_jobs(&memory).await;
            tokio::time::sleep(MEMORY_JOBS_EVERY).await;
        }
    });
    let backfill = state.clone();
    tokio::spawn(async move {
        run_backfill(&backfill).await;
    });
}

pub(crate) async fn run_prune(state: &AppState) {
    let database = state.database.clone();
    match tokio::task::spawn_blocking(move || {
        let now = Utc::now();
        let removed = database.community_prune(now)?;
        database.save_setting(PRUNED_AT_SETTING_KEY, &now.to_rfc3339())?;
        Ok::<u32, anyhow::Error>(removed)
    })
    .await
    {
        Ok(Ok(removed)) => {
            if removed > 0 {
                state.emit_log(
                    "info",
                    format!("Community: {removed} account(s) left the store (retention)."),
                );
                emit_changed(state).await;
            }
        }
        Ok(Err(error)) => state.emit_log(
            "warn",
            format!("Community: the retention prune failed: {error:#}"),
        ),
        Err(error) => state.emit_log(
            "warn",
            format!("Community: the retention task failed: {error}"),
        ),
    }
}

/// The backfill (A3): every past session with chat, oldest first, resumed
/// from the saved cursor; progress through `cohost.community.changed`;
/// marked done in `app_settings`. A second run changes nothing.
pub(crate) async fn run_backfill(state: &AppState) {
    let database = state.database.clone();
    let mut progress = tokio::task::spawn_blocking(move || database.community_backfill_progress())
        .await
        .unwrap_or_default();
    if progress.done {
        return;
    }
    if !settings_snapshot(&state.database, &state.community).enabled {
        return;
    }
    let database = state.database.clone();
    let (sessions, streamer_keys) = match tokio::task::spawn_blocking(move || {
        Ok::<_, anyhow::Error>((
            database.community_backfill_sessions()?,
            database.community_streamer_keys()?,
        ))
    })
    .await
    {
        Ok(Ok(found)) => found,
        Ok(Err(error)) => {
            state.emit_log(
                "warn",
                format!("Community: the backfill could not list sessions: {error:#}"),
            );
            return;
        }
        Err(_) => return,
    };
    progress.sessions_total = u32::try_from(sessions.len()).unwrap_or(u32::MAX);
    state.community.lock().backfill_running = true;
    emit_changed(state).await;
    let cursor = progress.cursor.clone();
    let after_cursor = |session_id: &str, started_at: DateTime<Utc>| -> bool {
        let Some(cursor) = cursor.as_deref() else {
            return true;
        };
        let Some((cursor_at, cursor_id)) = cursor.split_once('|') else {
            return true;
        };
        let key = (started_at.to_rfc3339(), session_id.to_string());
        key > (cursor_at.to_string(), cursor_id.to_string())
    };
    let mut since_report = 0u32;
    for (session_id, started_at) in sessions {
        if !after_cursor(&session_id, started_at) {
            continue;
        }
        let database = state.database.clone();
        let keys = streamer_keys.clone();
        let id = session_id.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            database.community_backfill_session(&id, started_at, &keys, Utc::now())
        })
        .await;
        match outcome {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                state.emit_log(
                    "warn",
                    format!("Community: the backfill stopped at session {session_id}: {error:#}"),
                );
                state.community.lock().backfill_running = false;
                emit_changed(state).await;
                return;
            }
            Err(_) => {
                state.community.lock().backfill_running = false;
                return;
            }
        }
        progress.sessions_done = progress.sessions_done.saturating_add(1);
        progress.cursor = Some(format!("{}|{}", started_at.to_rfc3339(), session_id));
        let database = state.database.clone();
        let saved = progress.clone();
        let _ =
            tokio::task::spawn_blocking(move || database.community_save_backfill_progress(&saved))
                .await;
        since_report += 1;
        if since_report >= BACKFILL_PROGRESS_EVERY {
            since_report = 0;
            emit_changed(state).await;
        }
    }
    progress.done = true;
    let database = state.database.clone();
    let saved = progress.clone();
    let _ = tokio::task::spawn_blocking(move || database.community_save_backfill_progress(&saved))
        .await;
    state.community.lock().backfill_running = false;
    state.emit_log(
        "info",
        format!(
            "Community: backfill done, {} session(s) folded in.",
            progress.sessions_done
        ),
    );
    emit_changed(state).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cohost::{CohostAutoChat, CohostSettings, CohostTalkMode};
    use crate::live_chat::{fake_message, try_deliver_messages};
    use crate::protocol::CohostSettingsPatch;
    use tokio::sync::broadcast;

    fn test_state() -> AppState {
        let (events, _) = broadcast::channel(256);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        )
    }

    async fn start_session(state: &AppState, session_id: &str) -> u64 {
        state
            .database
            .ensure_fake_live_chat_session(session_id)
            .unwrap();
        state
            .database
            .community_record_stream(
                session_id,
                Utc::now(),
                &[StreamPlatform::Twitch, StreamPlatform::Youtube],
            )
            .unwrap();
        let generation = {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session(session_id.to_string(), Vec::new());
            coordinator.session_generation()
        };
        session_started(
            state,
            session_id,
            vec![StreamPlatform::Twitch, StreamPlatform::Youtube],
        );
        tokio::task::yield_now().await;
        generation
    }

    fn row(
        session_id: &str,
        platform: StreamPlatform,
        author: &str,
        name: &str,
        seq: u32,
        text: &str,
    ) -> LiveChatMessage {
        let mut message = fake_message(session_id, platform, None, seq);
        message.author_id = Some(author.to_string());
        message.author_name = name.to_string();
        message.message_text = text.to_string();
        message
    }

    async fn deliver(state: &AppState, generation: u64, messages: Vec<LiveChatMessage>) {
        try_deliver_messages(state, generation, messages)
            .await
            .unwrap();
        wait_for_writes(state).await;
    }

    async fn set_talk(state: &AppState, talk: CohostTalkMode) {
        let settings = CohostSettings {
            enabled: true,
            auto_chat: CohostAutoChat {
                talk: Some(talk),
                ..CohostAutoChat::default()
            },
            ..CohostSettings::default()
        };
        crate::cohost::set_cohost_settings(
            state,
            CohostSettingsPatch {
                enabled: Some(true),
                auto_chat: Some(settings.auto_chat),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }

    /// B2: `!forgetme` forgets on the spot in every talk mode; the bubble
    /// says one line in Bubble mode and nothing in Off or Suggest; nothing
    /// is ever sent to chat (the lane counts zero sends, and a community
    /// line has no destination).
    #[tokio::test]
    async fn forgetme_works_in_every_talk_mode_and_only_bubble_says_a_line() {
        for (talk, lines) in [
            (CohostTalkMode::Off, 0),
            (CohostTalkMode::Suggest, 0),
            (CohostTalkMode::Bubble, 1),
        ] {
            let state = test_state();
            set_talk(&state, talk).await;
            let generation = start_session(&state, "s1").await;
            deliver(
                &state,
                generation,
                vec![row("s1", StreamPlatform::Twitch, "ada", "Ada", 1, "hello")],
            )
            .await;
            assert!(
                state
                    .database
                    .community_account_person("twitch:ada")
                    .unwrap()
                    .is_some(),
                "{talk:?}: Ada was learned"
            );
            deliver(
                &state,
                generation,
                vec![row(
                    "s1",
                    StreamPlatform::Twitch,
                    "ada",
                    "Ada",
                    2,
                    " !ForgetMe ",
                )],
            )
            .await;
            assert_eq!(
                state
                    .database
                    .community_account_person("twitch:ada")
                    .unwrap(),
                None,
                "{talk:?}: Ada is forgotten"
            );
            let said = bubble_lines(&state);
            assert_eq!(said.len(), lines, "{talk:?}: {said:?}");
            if lines == 1 {
                assert_eq!(said[0], "Done, Ada. I've forgotten you.");
            }
            let snapshot = state.cohost.lock().await.snapshot();
            assert_eq!(
                snapshot.auto_chat_sends, 0,
                "{talk:?}: nothing reached chat"
            );
            // A community line never enters the lane's cards (it has no
            // send path); the lane's own greeting card in Suggest mode is
            // the streamer's to post, as before.
            assert!(
                snapshot
                    .utterances
                    .iter()
                    .filter(|u| u.trigger.kind == CohostUtteranceTriggerKind::Community)
                    .all(|u| u.destination_ids.is_empty()),
                "{talk:?}: no community line names a chat destination"
            );
            assert!(
                snapshot
                    .utterances
                    .iter()
                    .all(|u| !u.text.contains("forgotten you")),
                "{talk:?}: a community line is never a card"
            );
            // Later chat from the forgotten account changes nothing.
            deliver(
                &state,
                generation,
                vec![row("s1", StreamPlatform::Twitch, "ada", "Ada", 3, "back?")],
            )
            .await;
            assert_eq!(
                state
                    .database
                    .community_account_person("twitch:ada")
                    .unwrap(),
                None
            );
            // `!rememberme` lifts it.
            deliver(
                &state,
                generation,
                vec![row(
                    "s1",
                    StreamPlatform::Twitch,
                    "ada",
                    "Ada",
                    4,
                    "!rememberme",
                )],
            )
            .await;
            deliver(
                &state,
                generation,
                vec![row(
                    "s1",
                    StreamPlatform::Twitch,
                    "ada",
                    "Ada",
                    5,
                    "hi again",
                )],
            )
            .await;
            assert!(
                state
                    .database
                    .community_account_person("twitch:ada")
                    .unwrap()
                    .is_some(),
                "{talk:?}"
            );
        }
    }

    /// B2, D4 b: `!link <word>` from two platforms within the window joins
    /// the two accounts into one person, puts the "Linked … Undo" card on
    /// the state, and the Undo splits them; the streamer's own `!link` does
    /// nothing.
    #[tokio::test]
    async fn link_words_join_two_accounts_with_an_undo_and_never_from_the_streamer() {
        let state = test_state();
        set_talk(&state, CohostTalkMode::Bubble).await;
        let generation = start_session(&state, "s1").await;
        deliver(
            &state,
            generation,
            vec![
                row("s1", StreamPlatform::Twitch, "ada", "Ada", 1, "hello"),
                row(
                    "s1",
                    StreamPlatform::Youtube,
                    "UCada",
                    "ada_dev",
                    2,
                    "hello from yt",
                ),
            ],
        )
        .await;
        let twitch = state
            .database
            .community_account_person("twitch:ada")
            .unwrap()
            .unwrap();
        let youtube = state
            .database
            .community_account_person("youtube:UCada")
            .unwrap()
            .unwrap();
        assert_ne!(twitch, youtube);
        // The streamer's own `!link` (a broadcaster row) does nothing.
        let mut own = row(
            "s1",
            StreamPlatform::Twitch,
            "me",
            "Streamer",
            3,
            "!link pixel42",
        );
        own.author_roles = vec!["broadcaster".to_string()];
        deliver(&state, generation, vec![own]).await;
        assert_eq!(pending_link_words(&state), 0);
        deliver(
            &state,
            generation,
            vec![row(
                "s1",
                StreamPlatform::Twitch,
                "ada",
                "Ada",
                4,
                "!link pixel42",
            )],
        )
        .await;
        assert_eq!(pending_link_words(&state), 1);
        assert!(
            bubble_lines(&state).is_empty(),
            "a waiting word says nothing"
        );
        deliver(
            &state,
            generation,
            vec![row(
                "s1",
                StreamPlatform::Youtube,
                "UCada",
                "ada_dev",
                5,
                "!link Pixel42",
            )],
        )
        .await;
        assert_eq!(pending_link_words(&state), 0, "the word is single-use");
        assert_eq!(
            state
                .database
                .community_account_person("youtube:UCada")
                .unwrap()
                .unwrap(),
            twitch,
            "one person now"
        );
        assert_eq!(
            bubble_lines(&state),
            ["Linked: Ada on Twitch and ada_dev on YouTube."]
        );
        let snapshot = state.cohost.lock().await.snapshot();
        assert_eq!(snapshot.link_made.len(), 1);
        assert_eq!(
            snapshot.link_made[0].names,
            ["Ada".to_string(), "ada_dev".to_string()]
        );
        assert_eq!(snapshot.link_made[0].account_key, "youtube:UCada");
        // Undo: the YouTube account becomes its own person again and the
        // card leaves.
        let undone = unlink(
            &state,
            CommunityUnlinkParams {
                account_key: "youtube:UCada".to_string(),
            },
        )
        .await
        .unwrap();
        assert_ne!(undone.person_id, twitch);
        assert!(state.cohost.lock().await.snapshot().link_made.is_empty());
        // A same-platform claim burns the word and lists the pair.
        deliver(
            &state,
            generation,
            vec![
                row("s1", StreamPlatform::Twitch, "bo", "Bo", 6, "!link teacup"),
                row("s1", StreamPlatform::Twitch, "cy", "Cy", 7, "!link teacup"),
            ],
        )
        .await;
        assert_eq!(pending_link_words(&state), 0);
        let summary = summary(&state).await.unwrap();
        assert_eq!(summary.links_pending, 1);
        assert_eq!(summary.people, 4);
    }

    /// Owner call 2026-11-08 (plan 225 C3): in Suggest mode the "Welcome
    /// back" row stays while its welcome card waits, and leaves when the
    /// card is dismissed (or posted).
    #[tokio::test]
    async fn a_suggest_welcome_card_keeps_the_welcome_back_row_until_dismissed() {
        let state = test_state();
        set_talk(&state, CohostTalkMode::Suggest).await;
        let first = start_session(&state, "s1").await;
        deliver(
            &state,
            first,
            vec![row("s1", StreamPlatform::Twitch, "ada", "Ada", 1, "hello")],
        )
        .await;
        crate::live_chat::stop_live_chat(&state).await;
        let second = start_session(&state, "s2").await;
        deliver(
            &state,
            second,
            vec![row("s2", StreamPlatform::Twitch, "ada", "Ada", 2, "back")],
        )
        .await;
        let snapshot = state.cohost.lock().await.snapshot();
        let card = snapshot
            .utterances
            .iter()
            .find(|utterance| {
                utterance.trigger.kind == CohostUtteranceTriggerKind::Greeting
                    && utterance.status == CohostUtteranceStatus::Proposed
            })
            .cloned()
            .expect("Suggest proposes the welcome as a card");
        assert_eq!(
            snapshot.welcome_back.len(),
            1,
            "the row stays beside the card"
        );
        crate::cohost::dismiss_utterance(
            &state,
            crate::protocol::CohostUtteranceParams {
                session_id: "s2".to_string(),
                utterance_id: card.id.clone(),
            },
        )
        .await
        .unwrap();
        assert!(
            state.cohost.lock().await.snapshot().welcome_back.is_empty(),
            "a dismissed card takes the row off"
        );
    }

    /// D15: when the chat session ends, its report gains the Community
    /// block: the first-timers from the store, and nothing about a
    /// returning non-regular beyond being counted nowhere.
    #[tokio::test]
    async fn the_session_end_writes_the_reports_community_block() {
        let state = test_state();
        set_talk(&state, CohostTalkMode::Bubble).await;
        let first = start_session(&state, "s1").await;
        deliver(
            &state,
            first,
            vec![row("s1", StreamPlatform::Twitch, "ada", "Ada", 1, "hello")],
        )
        .await;
        crate::live_chat::stop_live_chat(&state).await;
        let second = start_session(&state, "s2").await;
        deliver(
            &state,
            second,
            vec![
                row("s2", StreamPlatform::Twitch, "ada", "Ada", 2, "back"),
                row("s2", StreamPlatform::Twitch, "bo", "Bo", 3, "first time"),
            ],
        )
        .await;
        crate::live_chat::stop_live_chat(&state).await;
        let deadline = Instant::now() + Duration::from_secs(10);
        let community = loop {
            let report = state.database.get_cohost_report("s2").unwrap();
            if let Some(community) = report.and_then(|report| report.community) {
                break community;
            }
            assert!(
                Instant::now() < deadline,
                "the Community block never landed"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        assert_eq!(community.first_timers, 1);
        assert_eq!(community.regulars_back, 0);
        assert!(community.regulars.is_empty());
        assert!(community.summary.is_none());
        // The report reads back as JSON without a null anywhere.
        let json = serde_json::to_string(&community).unwrap();
        assert!(!json.contains("null"));
    }

    /// B1: the arrival rides the delivery, once per person per stream, for
    /// returning people only; "Welcome back" lists them; a wave takes them
    /// off; the store's switch off stops the learning.
    #[tokio::test]
    async fn arrivals_land_on_the_first_row_of_a_returning_person_and_welcome_back_lists_them() {
        let state = test_state();
        set_talk(&state, CohostTalkMode::Bubble).await;
        let first = start_session(&state, "s1").await;
        deliver(
            &state,
            first,
            vec![
                row("s1", StreamPlatform::Twitch, "ada", "Ada", 1, "hello"),
                row(
                    "s1",
                    StreamPlatform::Twitch,
                    "nightbot",
                    "Nightbot",
                    2,
                    "!commands",
                ),
            ],
        )
        .await;
        crate::live_chat::stop_live_chat(&state).await;
        let second = start_session(&state, "s2").await;
        deliver(
            &state,
            second,
            vec![
                row("s2", StreamPlatform::Twitch, "ada", "Ada", 3, "back again"),
                row("s2", StreamPlatform::Twitch, "ada", "Ada", 4, "second row"),
                row(
                    "s2",
                    StreamPlatform::Twitch,
                    "newcomer",
                    "New",
                    5,
                    "first time",
                ),
                row(
                    "s2",
                    StreamPlatform::Twitch,
                    "nightbot",
                    "Nightbot",
                    6,
                    "!commands",
                ),
            ],
        )
        .await;
        let rows = state
            .database
            .list_live_chat_messages_recent("s2", 10)
            .unwrap();
        let by_seq = |seq: u32| {
            rows.iter()
                .find(|m| m.provider_message_id == format!("fake-{seq}"))
                .unwrap()
                .clone()
        };
        let arrival = by_seq(3).arrival.expect("Ada's arrival row");
        assert_eq!(arrival.streams, 2);
        assert_eq!(arrival.in_a_row, 2);
        assert!(!arrival.regular);
        assert!(by_seq(4).arrival.is_none(), "later rows stay quiet");
        assert!(by_seq(5).arrival.is_none(), "a first-timer never arrives");
        assert!(
            by_seq(5).first_message,
            "the first-chat marker is untouched"
        );
        assert!(by_seq(6).arrival.is_none(), "a bot never arrives");
        let snapshot = state.cohost.lock().await.snapshot();
        assert_eq!(snapshot.welcome_back.len(), 1);
        assert_eq!(snapshot.welcome_back[0].name, "Ada");
        assert_eq!(snapshot.welcome_back[0].arrival.streams, 2);
        let person_id = snapshot.welcome_back[0].person_id.clone();
        wave(&state, CommunityPersonIdParams { person_id })
            .await
            .unwrap();
        assert!(state.cohost.lock().await.snapshot().welcome_back.is_empty());
        assert_eq!(
            bubble_lines(&state).last().map(String::as_str),
            Some("Hey Ada!")
        );
        // A blocked store (its tables gone) never blocks delivery: the row
        // is delivered without an arrival, and the error is logged once.
        state
            .database
            .lock()
            .unwrap()
            .execute_batch("DROP TABLE community_accounts;")
            .unwrap();
        deliver(
            &state,
            second,
            vec![row(
                "s2",
                StreamPlatform::Twitch,
                "late",
                "Late",
                7,
                "still delivered",
            )],
        )
        .await;
        let rows = state
            .database
            .list_live_chat_messages_recent("s2", 10)
            .unwrap();
        assert!(rows.iter().any(|m| m.provider_message_id == "fake-7"));
        assert!(
            rows.iter()
                .all(|m| m.provider_message_id != "fake-7" || m.arrival.is_none())
        );
    }

    /// Plan 225 D12: Export… writes a dated file into the chosen folder
    /// (never overwriting the day's earlier export), and Import… reads one
    /// back. The paths here are what `main.rs` hands in after consuming the
    /// picker's capabilities; a renderer path never reaches these.
    #[tokio::test]
    async fn export_writes_a_dated_file_into_the_folder_and_import_reads_it_back() {
        let state = test_state();
        let generation = start_session(&state, "session-export").await;
        deliver(
            &state,
            generation,
            vec![
                row(
                    "session-export",
                    StreamPlatform::Twitch,
                    "1",
                    "Ada",
                    1,
                    "hi",
                ),
                row("session-export", StreamPlatform::Kick, "2", "Bo", 2, "hey"),
            ],
        )
        .await;
        wait_for_writes(&state).await;
        let folder =
            std::env::temp_dir().join(format!("videorc-community-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        let first = export(
            &state,
            CommunityExportParams {
                output_directory: folder.display().to_string(),
            },
        )
        .await
        .unwrap();
        assert_eq!(first.people, 2);
        assert!(first.file_name.starts_with("videorc-community-"));
        assert!(first.file_name.ends_with(".json"));
        assert!(first.bytes > 0);
        assert!(folder.join(&first.file_name).is_file());
        let second = export(
            &state,
            CommunityExportParams {
                output_directory: folder.display().to_string(),
            },
        )
        .await
        .unwrap();
        assert_ne!(
            second.file_name, first.file_name,
            "never overwrites the day's export"
        );
        assert!(second.file_name.ends_with("-2.json"));

        let empty = export(
            &state,
            CommunityExportParams {
                output_directory: String::new(),
            },
        )
        .await;
        assert!(matches!(empty, Err(CommunityError::Invalid(_))));
        let not_a_folder = export(
            &state,
            CommunityExportParams {
                output_directory: folder.join(&first.file_name).display().to_string(),
            },
        )
        .await;
        assert!(matches!(not_a_folder, Err(CommunityError::Invalid(_))));

        // A fresh store reads the file back: both people, nothing merged.
        let other = test_state();
        let imported = import(
            &other,
            CommunityImportParams {
                path: folder.join(&first.file_name).display().to_string(),
            },
        )
        .await
        .unwrap();
        assert_eq!(imported.people, 2);
        assert_eq!(imported.merged, 0);
        assert_eq!(summary(&other).await.unwrap().people, 2);
        let garbage = folder.join("not-an-export.json");
        std::fs::write(&garbage, b"{\"nope\": true}").unwrap();
        let refused = import(
            &other,
            CommunityImportParams {
                path: garbage.display().to_string(),
            },
        )
        .await;
        assert!(matches!(refused, Err(CommunityError::Invalid(_))));
        let _ = std::fs::remove_dir_all(&folder);
    }

    // --- Buddy remembers: the memory pass (D10, F3) -------------------------------

    use std::sync::atomic::{AtomicUsize, Ordering};

    fn remember_on(state: &AppState) {
        sync_settings(
            state,
            &CommunitySettings {
                remember: true,
                ..Default::default()
            },
        );
        state.community.lock().web_memory_version = Some(1);
    }

    fn person_at(state: &AppState, platform: StreamPlatform, author_id: &str) -> CommunityPerson {
        state
            .database
            .community_person(
                &crate::community::CommunityPersonParams {
                    platform: Some(platform),
                    author_id: Some(author_id.to_string()),
                    ..Default::default()
                },
                Utc::now(),
                3,
            )
            .unwrap()
    }

    /// The stream ended: its report block is written and its pass queued,
    /// without the real runner (which a unit test never reaches).
    async fn end_and_queue(state: &AppState, session_id: &str) {
        wait_for_writes(state).await;
        let ended = state.community.lock().session.take().unwrap();
        write_report_community(state, ended).await;
        state
            .database
            .community_memory_job_enqueue(session_id, Utc::now())
            .unwrap();
    }

    fn memory_answer(
        reference: &str,
        text: &str,
        platform: StreamPlatform,
    ) -> CohostMemoryResponse {
        CohostMemoryResponse {
            people: vec![crate::videorc_api::CohostMemoryPersonResult {
                r#ref: reference.to_string(),
                add: vec![crate::videorc_api::CohostMemoryAdd {
                    text: text.to_string(),
                    platform,
                }],
                update: Vec::new(),
                remove: Vec::new(),
            }],
            summary: Some(
                "Ada came back and is learning Rust.   Nobody else chatted twice.".to_string(),
            ),
            model: "fake".to_string(),
            usage: None,
        }
    }

    #[tokio::test]
    async fn the_memory_pass_sends_twice_chatters_without_youtube_and_keeps_the_answer() {
        let state = test_state();
        remember_on(&state);
        let generation = start_session(&state, "s-memory").await;
        note_cohost_consent(&state, "s-memory", true);
        deliver(
            &state,
            generation,
            vec![
                row(
                    "s-memory",
                    StreamPlatform::Twitch,
                    "1",
                    "Ada",
                    1,
                    "I'm learning Rust",
                ),
                row(
                    "s-memory",
                    StreamPlatform::Twitch,
                    "1",
                    "Ada",
                    2,
                    "the borrow checker hates me",
                ),
                row(
                    "s-memory",
                    StreamPlatform::Twitch,
                    "1",
                    "Ada",
                    3,
                    "anyway hi",
                ),
                row(
                    "s-memory",
                    StreamPlatform::Kick,
                    "2",
                    "Bo",
                    4,
                    "one message only",
                ),
                row(
                    "s-memory",
                    StreamPlatform::Youtube,
                    "3",
                    "Kim",
                    5,
                    "youtube one",
                ),
                row(
                    "s-memory",
                    StreamPlatform::Youtube,
                    "3",
                    "Kim",
                    6,
                    "youtube two",
                ),
            ],
        )
        .await;
        end_and_queue(&state, "s-memory").await;
        assert_eq!(state.database.community_memory_jobs().unwrap().len(), 1);

        let seen: Arc<StdMutex<Vec<CohostMemoryRequest>>> = Arc::new(StdMutex::new(Vec::new()));
        let record = seen.clone();
        run_memory_jobs_with(&state, true, |request| {
            record.lock().unwrap().push(request);
            async { Ok(memory_answer("p1", "Learning Rust", StreamPlatform::Twitch)) }
        })
        .await;
        let requests = seen.lock().unwrap().clone();
        assert_eq!(requests.len(), 1, "one pass for the stream");
        let request = &requests[0];
        assert_eq!(request.prompt_version, 1);
        assert!(request.consent_to_process_chat);
        assert_eq!(request.session_client_id, "s-memory");
        assert_eq!(
            request.people.len(),
            1,
            "Bo chatted once and Kim is on YouTube: {:?}",
            request.people
        );
        let ada = &request.people[0];
        assert_eq!(ada.r#ref, "p1");
        assert_eq!(ada.name, "Ada");
        assert_eq!(ada.platforms, vec![StreamPlatform::Twitch]);
        assert_eq!(ada.messages.len(), 3);
        assert_eq!(ada.messages[0].text, "I'm learning Rust", "oldest first");
        assert!(ada.memories.is_none() && ada.note.is_none());
        let json = serde_json::to_string(request).unwrap();
        assert!(
            !json.contains("youtube") && !json.contains("Kim") && !json.contains("youtube one"),
            "a YouTube message never leaves the computer: {json}"
        );
        assert_eq!(
            request.counts.first_timers, 3,
            "the report's counts ride along"
        );

        let person = person_at(&state, StreamPlatform::Twitch, "1");
        assert_eq!(person.memories.len(), 1);
        assert_eq!(person.memories[0].text, "Learning Rust");
        assert_eq!(person.memories[0].account_key, "twitch:1");
        assert_eq!(person.memories[0].session_id.as_deref(), Some("s-memory"));
        let community = state
            .database
            .get_cohost_report("s-memory")
            .unwrap()
            .unwrap()
            .community
            .unwrap();
        assert_eq!(community.memories_learned, 1);
        assert_eq!(
            community.summary.as_deref(),
            Some("Ada came back and is learning Rust. Nobody else chatted twice.")
        );
        assert_eq!(community.first_timers, 3, "the counts survive the pass");
        assert!(
            state.database.community_memory_jobs().unwrap().is_empty(),
            "the pass is done"
        );
    }

    #[tokio::test]
    async fn a_refused_memory_pass_waits_and_a_week_old_one_is_dropped() {
        let state = test_state();
        remember_on(&state);
        let generation = start_session(&state, "s-wait").await;
        note_cohost_consent(&state, "s-wait", true);
        deliver(
            &state,
            generation,
            vec![
                row("s-wait", StreamPlatform::Twitch, "1", "Ada", 1, "hi"),
                row(
                    "s-wait",
                    StreamPlatform::Twitch,
                    "1",
                    "Ada",
                    2,
                    "hello again",
                ),
            ],
        )
        .await;
        end_and_queue(&state, "s-wait").await;
        let calls = Arc::new(AtomicUsize::new(0));
        let refuse = |calls: Arc<AtomicUsize>| {
            move |_request: CohostMemoryRequest| {
                calls.fetch_add(1, Ordering::SeqCst);
                async {
                    Err(crate::videorc_api::classify_cohost_failure(
                        403,
                        "memory-disabled",
                        "Memory is off.".to_string(),
                        None,
                    ))
                }
            }
        };
        run_memory_jobs_with(&state, true, refuse(calls.clone())).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let jobs = state.database.community_memory_jobs().unwrap();
        assert_eq!(jobs.len(), 1, "a 403 keeps the pass for later");
        assert_eq!(jobs[0].attempts, 1);
        assert_eq!(jobs[0].last_error.as_deref(), Some("Memory is off."));
        assert!(jobs[0].last_attempt_at.is_some());
        assert!(
            person_at(&state, StreamPlatform::Twitch, "1")
                .memories
                .is_empty()
        );
        // Tried a moment ago: not asked again yet.
        run_memory_jobs_with(&state, true, refuse(calls.clone())).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // Without Premium, "Buddy remembers" or the web's route, it waits unasked.
        state
            .database
            .community_memory_job_backdate("s-wait", Utc::now() - chrono::Duration::days(1))
            .unwrap();
        run_memory_jobs_with(&state, false, refuse(calls.clone())).await;
        state.community.lock().web_memory_version = Some(0);
        run_memory_jobs_with(&state, true, refuse(calls.clone())).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        state.community.lock().web_memory_version = Some(1);
        // A week old: dropped without asking.
        state
            .database
            .community_memory_job_backdate("s-wait", Utc::now() - chrono::Duration::days(8))
            .unwrap();
        run_memory_jobs_with(&state, true, refuse(calls.clone())).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(state.database.community_memory_jobs().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_memory_pass_whose_stream_was_deleted_is_dropped_unasked() {
        let state = test_state();
        remember_on(&state);
        state
            .database
            .community_memory_job_enqueue("ghost-session", Utc::now())
            .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        run_memory_jobs_with(&state, true, move |_request| {
            count.fetch_add(1, Ordering::SeqCst);
            async { Ok(CohostMemoryResponse::default()) }
        })
        .await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(state.database.community_memory_jobs().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_malformed_memory_answer_applies_nothing() {
        let state = test_state();
        remember_on(&state);
        let generation = start_session(&state, "s-bad").await;
        note_cohost_consent(&state, "s-bad", true);
        deliver(
            &state,
            generation,
            vec![
                row("s-bad", StreamPlatform::Twitch, "1", "Ada", 1, "hi"),
                row(
                    "s-bad",
                    StreamPlatform::Twitch,
                    "1",
                    "Ada",
                    2,
                    "I collect keyboards",
                ),
            ],
        )
        .await;
        end_and_queue(&state, "s-bad").await;
        // An answer the desktop cannot read: nothing applied, tried again later.
        run_memory_jobs_with(&state, true, |_request| async {
            Err(CohostApiError::malformed_response(200, "not the contract"))
        })
        .await;
        assert!(
            person_at(&state, StreamPlatform::Twitch, "1")
                .memories
                .is_empty()
        );
        let jobs = state.database.community_memory_jobs().unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].attempts, 1);
        // An answer about people and memories the request never sent: nothing
        // applied, and the pass is done.
        state
            .database
            .community_memory_job_backdate("s-bad", Utc::now() - chrono::Duration::hours(1))
            .unwrap();
        run_memory_jobs_with(&state, true, |_request| async {
            Ok(CohostMemoryResponse {
                people: vec![
                    crate::videorc_api::CohostMemoryPersonResult {
                        r#ref: "p9".to_string(),
                        add: vec![crate::videorc_api::CohostMemoryAdd {
                            text: "Should not land".to_string(),
                            platform: StreamPlatform::Twitch,
                        }],
                        update: Vec::new(),
                        remove: Vec::new(),
                    },
                    crate::videorc_api::CohostMemoryPersonResult {
                        r#ref: "p1".to_string(),
                        add: Vec::new(),
                        update: vec![crate::videorc_api::CohostMemoryKnown {
                            id: "not-hers".to_string(),
                            text: "Rewritten".to_string(),
                        }],
                        remove: vec!["not-hers".to_string()],
                    },
                ],
                summary: None,
                model: "fake".to_string(),
                usage: None,
            })
        })
        .await;
        assert!(
            person_at(&state, StreamPlatform::Twitch, "1")
                .memories
                .is_empty()
        );
        assert!(state.database.community_memory_jobs().unwrap().is_empty());
        let community = state
            .database
            .get_cohost_report("s-bad")
            .unwrap()
            .unwrap()
            .community
            .unwrap();
        assert_eq!(community.memories_learned, 0);
        assert!(community.summary.is_none());
    }

    #[tokio::test]
    async fn a_memory_from_a_pass_follows_its_account_through_a_split() {
        let state = test_state();
        remember_on(&state);
        let generation = start_session(&state, "s-split").await;
        note_cohost_consent(&state, "s-split", true);
        deliver(
            &state,
            generation,
            vec![
                row("s-split", StreamPlatform::Twitch, "1", "Ada", 1, "hi"),
                row("s-split", StreamPlatform::Twitch, "1", "Ada", 2, "evening"),
                row(
                    "s-split",
                    StreamPlatform::Kick,
                    "9",
                    "ada",
                    3,
                    "I stream on Kick at night",
                ),
                row("s-split", StreamPlatform::Kick, "9", "ada", 4, "late shift"),
            ],
        )
        .await;
        wait_for_writes(&state).await;
        let twitch = person_at(&state, StreamPlatform::Twitch, "1").id;
        let kick = person_at(&state, StreamPlatform::Kick, "9").id;
        state
            .database
            .community_link(&twitch, &kick, CommunityLinkKind::Manual, Utc::now())
            .unwrap();
        end_and_queue(&state, "s-split").await;
        let seen: Arc<StdMutex<Vec<CohostMemoryRequest>>> = Arc::new(StdMutex::new(Vec::new()));
        let record = seen.clone();
        run_memory_jobs_with(&state, true, |request| {
            record.lock().unwrap().push(request);
            async {
                Ok(memory_answer(
                    "p1",
                    "Streams on Kick at night",
                    StreamPlatform::Kick,
                ))
            }
        })
        .await;
        let request = seen.lock().unwrap().clone().remove(0);
        assert_eq!(request.people.len(), 1, "one linked person");
        assert_eq!(request.people[0].messages.len(), 4);
        let mut platforms = request.people[0].platforms.clone();
        platforms.sort_by_key(|platform| crate::streaming::stream_platform_id(*platform));
        assert_eq!(
            platforms,
            vec![StreamPlatform::Kick, StreamPlatform::Twitch]
        );
        let linked = person_at(&state, StreamPlatform::Twitch, "1");
        assert_eq!(linked.memories.len(), 1);
        assert_eq!(
            linked.memories[0].account_key, "kick:9",
            "the Kick message taught it"
        );
        // Not the same person after all: the memory goes with the Kick account.
        state
            .database
            .community_unlink("kick:9", Utc::now())
            .unwrap();
        assert!(
            person_at(&state, StreamPlatform::Twitch, "1")
                .memories
                .is_empty()
        );
        let split = person_at(&state, StreamPlatform::Kick, "9");
        assert_eq!(split.memories.len(), 1);
        assert_eq!(split.memories[0].text, "Streams on Kick at night");
    }
}
