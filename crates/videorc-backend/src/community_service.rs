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
    CohostUtteranceStatus, CohostUtteranceTrigger, CohostUtteranceTriggerKind,
};
use crate::community::{
    ChatCommand, CohostLinkMade, CohostWelcomeBack, CommunityAccepted, CommunityExportResult,
    CommunityIdParams, CommunityImportResult, CommunityLinkKind, CommunityLinkParams,
    CommunityListPage, CommunityListParams, CommunityPathParams, CommunityPerson,
    CommunityPersonIdParams, CommunityPersonParams, CommunitySettings, CommunitySuggestionParams,
    CommunitySummary, CommunityUnlinkParams, CommunityUnlinkResult, CommunityUpdateParams,
    LINK_MADE_TTL, LinkClaim, LinkOutcome, PendingLinks, ViewerArrival, account_key,
    command_bubble_line, parse_chat_command, platform_has_identity,
};
use crate::community_store::{
    CommunityError, CommunityExportFile, CommunityRowFacts, PRUNED_AT_SETTING_KEY,
};
use crate::live_chat::{LiveChatEventType, LiveChatMessage};
use crate::state::AppState;
use crate::storage::Database;
use crate::streaming::StreamPlatform;

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
}

#[derive(Default)]
pub struct CommunityRuntime {
    /// The community block of the Buddy settings, read without the engine
    /// lock on the delivery path. `None` until first read.
    settings: Option<CommunitySettings>,
    session: Option<SessionCommunity>,
    pending_writes: usize,
    backfill_running: bool,
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
    /// Arrival rows the bubble (or a Suggest card) already welcomed: the
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
/// cleared.
pub(crate) fn session_ended(state: &AppState) {
    state.community.lock().session = None;
    let state = state.clone();
    tokio::spawn(async move {
        state.cohost.lock().await.community.clear();
    });
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
            let runtime = state.community.lock();
            let Some(session) = runtime
                .session
                .as_ref()
                .filter(|session| session.session_id == session_id)
            else {
                return;
            };
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

pub async fn export(
    state: &AppState,
    params: CommunityPathParams,
) -> Result<CommunityExportResult, CommunityError> {
    let path = params.path.trim().to_string();
    if path.is_empty() {
        return Err(CommunityError::Invalid("path is required.".to_string()));
    }
    blocking(state, move |database| {
        let file = database.community_export(Utc::now())?;
        let json = serde_json::to_vec_pretty(&file)
            .map_err(|error| CommunityError::Storage(error.to_string()))?;
        std::fs::write(&path, &json)
            .map_err(|error| CommunityError::Invalid(format!("Could not write {path}: {error}")))?;
        Ok(CommunityExportResult {
            people: u32::try_from(file.people.len()).unwrap_or(u32::MAX),
            bytes: json.len() as u64,
        })
    })
    .await
}

pub async fn import(
    state: &AppState,
    params: CommunityPathParams,
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
}
