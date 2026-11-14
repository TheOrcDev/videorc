//! The stream report email (plan 237, Phase C): about a minute after a live
//! stream ends, the numbers of `stream_report::build_report` go to
//! videorc.com (`POST /api/desktop/stream-report`), which emails them to the
//! signed-in account's own address and keeps none of them.
//!
//! - An observer reads `recording.status` and `stream.targets` from the event
//!   bus. A live session that ran 5 minutes or more (D5) becomes a row in
//!   `stream_report_emails`, due 60 s after the end so the last viewer poll,
//!   the chat totals and Buddy's community block settle (D6). The row holds
//!   no numbers: the report is built from the session's rows when it is
//!   sent, and deleting the session deletes the row.
//! - A sender sends due rows one at a time: it checks the row's account is
//!   still the signed-in one, asks the web whether the account wants these
//!   emails (`GET /api/account/stream-report-email`), and only then sends the
//!   numbers. A report older than 3 days is dropped; a sign-out or another
//!   account drops it too, so one account's report never reaches another.
//! - YouTube's numbers go like every other platform's (owner, plan 237 D3):
//!   the privacy policy says so, and the next YouTube compliance report must
//!   tell Google that stream statistics now pass through videorc.com.
//! - `VIDEORC_STREAM_REPORT_EMAIL=0` turns it all off for a run (smokes and
//!   the live lab set it). Nothing here touches the recording or stream path:
//!   a failure only means no email.
//!
//! The renderer's switch (Livestream → After the stream) reads and writes the
//! web preference through `streamReport.email.get` / `.set`, and
//! `streamReport.email.sendLast` sends the latest ended live session's report
//! now. Each RPC gives up after `RPC_BUDGET`, inside the backend's 10 s
//! mutation watchdog, so a slow videorc.com never restarts the backend.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Notify, broadcast};

use crate::protocol::{AccountStatus, RecordingState, RecordingStatus, ServerEvent};
use crate::state::AppState;
use crate::storage::Database;
use crate::stream_report::{MIN_STREAM_SECONDS, StreamReport};
use crate::streaming::{StreamPlatform, StreamTargetsSnapshot};

/// `0` / `false` / `no` / `off` turns the email off for this run. Nothing
/// turns it on.
pub const DISABLE_ENV_VAR: &str = "VIDEORC_STREAM_REPORT_EMAIL";
pub const REPORT_PATH: &str = "/api/desktop/stream-report";
pub const PREFERENCE_PATH: &str = "/api/account/stream-report-email";
/// D6: the wait after the end before the report is built.
pub const SETTLE: Duration = Duration::from_secs(60);
/// D6: a report not sent within 3 days of the stream is dropped.
const MAX_AGE: TimeDelta = TimeDelta::days(3);
/// Retries before a report is given up.
const MAX_ATTEMPTS: u32 = 10;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// An RPC's whole budget: the account read, the wait for the send lock and
/// every web call. The backend restarts a mutation that runs past
/// `WEBSOCKET_MUTATION_MAX_EXECUTION_AGE` (10 s, main.rs), even mid-stream, so
/// these give up well before it. A send cut off here may still arrive: the web
/// can finish what it started.
const RPC_BUDGET: Duration = Duration::from_secs(8);
/// Leave startup alone before sending what an earlier run left due.
const STARTUP_DELAY: Duration = Duration::from_secs(30);
const RETRY_MIN: Duration = Duration::from_secs(60);
const RETRY_MAX: Duration = Duration::from_secs(30 * 60);

const STATUS_QUEUED: &str = "queued";
const STATUS_SENT: &str = "sent";
const STATUS_DISABLED: &str = "disabled";
const STATUS_DROPPED: &str = "dropped";
const STATUS_EXPIRED: &str = "expired";
const STATUS_FAILED: &str = "failed";

// ---------------------------------------------------------------------------
// Wire types (renderer)
// ---------------------------------------------------------------------------

/// `streamReport.email.get` / `.set`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamReportEmailState {
    pub signed_in: bool,
    /// Where the email goes: the account's own address.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// The account's choice; `null` when it could not be read (signed out,
    /// offline, or a videorc.com without the route).
    pub enabled: Option<bool>,
    /// `VIDEORC_STREAM_REPORT_EMAIL=0` turned it off for this run.
    pub env_disabled: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamReportEmailSetParams {
    pub enabled: bool,
}

/// What "Send the last one" did.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StreamReportSendStatus {
    Sent,
    AlreadySent,
    /// The account turned these emails off.
    Disabled,
    /// No live session to report on.
    NoStream,
    SignedOut,
    /// Ten reports in a day already.
    RateLimited,
    /// Off for this run, or a videorc.com without the route.
    Unavailable,
    Failed,
}

/// `streamReport.email.sendLast`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamReportSendResult {
    pub status: StreamReportSendStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

// ---------------------------------------------------------------------------
// The live session tracker (pure)
// ---------------------------------------------------------------------------

/// A live session that just ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EndedLive {
    pub session_id: String,
    pub platforms: Vec<StreamPlatform>,
    pub seconds_live: i64,
}

#[derive(Debug)]
struct TrackedSession {
    session_id: String,
    live: bool,
    started_at: DateTime<Utc>,
    platforms: Vec<StreamPlatform>,
}

/// Folds `recording.status` and `stream.targets` into "this live session
/// ended". A recording-only session never counts; neither does a session
/// whose end never came (the next start replaces it).
#[derive(Debug, Default)]
pub(crate) struct LiveTracker {
    active: Option<TrackedSession>,
    early_targets: Option<StreamTargetsSnapshot>,
}

impl LiveTracker {
    pub(crate) fn observe(&mut self, event: &ServerEvent, now: DateTime<Utc>) -> Option<EndedLive> {
        match event.event.as_str() {
            "recording.status" => {
                let status = RecordingStatus::deserialize(&event.payload).ok()?;
                self.observe_status(&status, now)
            }
            "stream.targets" => {
                let snapshot = StreamTargetsSnapshot::deserialize(&event.payload).ok()?;
                match self.active.as_mut() {
                    Some(session) if session.session_id == snapshot.session_id => {
                        add_platforms(session, &snapshot);
                    }
                    _ => self.early_targets = Some(snapshot),
                }
                None
            }
            _ => None,
        }
    }

    fn observe_status(
        &mut self,
        status: &RecordingStatus,
        now: DateTime<Utc>,
    ) -> Option<EndedLive> {
        match status.state {
            RecordingState::Recording | RecordingState::Streaming => {
                let session_id = status.session_id.as_deref()?;
                // Only presence is read: the stream URL never leaves here.
                let live = status.stream_url.is_some()
                    || matches!(status.state, RecordingState::Streaming);
                if let Some(session) = self
                    .active
                    .as_mut()
                    .filter(|session| session.session_id == session_id)
                {
                    session.live |= live;
                    return None;
                }
                let started_at = status
                    .started_at
                    .as_deref()
                    .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                    .map(|value| value.with_timezone(&Utc))
                    .unwrap_or(now);
                let mut session = TrackedSession {
                    session_id: session_id.to_string(),
                    live,
                    started_at,
                    platforms: Vec::new(),
                };
                if let Some(snapshot) = self
                    .early_targets
                    .take()
                    .filter(|snapshot| snapshot.session_id == session_id)
                {
                    add_platforms(&mut session, &snapshot);
                }
                self.active = Some(session);
                None
            }
            RecordingState::Idle | RecordingState::Failed => {
                let matches = self.active.as_ref().is_some_and(|session| {
                    status
                        .session_id
                        .as_deref()
                        .is_none_or(|id| id == session.session_id)
                });
                if !matches {
                    return None;
                }
                let session = self.active.take()?;
                if !session.live {
                    return None;
                }
                let seconds_live = status
                    .duration_ms
                    .map(|ms| ms.max(0) / 1000)
                    .unwrap_or_else(|| (now - session.started_at).num_seconds().max(0));
                let mut platforms = session.platforms;
                platforms.sort_by_key(|platform| *platform as u8);
                platforms.dedup();
                Some(EndedLive {
                    session_id: session.session_id,
                    platforms,
                    seconds_live,
                })
            }
            RecordingState::Starting | RecordingState::Stopping => None,
        }
    }
}

fn add_platforms(session: &mut TrackedSession, snapshot: &StreamTargetsSnapshot) {
    for target in &snapshot.targets {
        if !session.platforms.contains(&target.platform) {
            session.platforms.push(target.platform);
        }
    }
    if !snapshot.targets.is_empty() {
        session.live = true;
    }
}

/// D5: long enough to be worth an email.
pub(crate) fn worth_a_report(ended: &EndedLive) -> bool {
    ended.seconds_live >= MIN_STREAM_SECONDS
}

// ---------------------------------------------------------------------------
// Web answers (pure)
// ---------------------------------------------------------------------------

/// `POST /api/desktop/stream-report`'s answer, as the sender acts on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PostAnswer {
    Sent,
    AlreadySent,
    Disabled,
    RateLimited,
    /// 401: the session is gone.
    Unauthorized,
    /// 404: a videorc.com without the route.
    Missing,
    /// Any other 4xx: sending it again cannot help.
    Refused(u16),
    /// 408, 5xx or no answer.
    Retry,
}

pub(crate) fn classify_post(status: u16, body_status: Option<&str>) -> PostAnswer {
    match status {
        200..=299 => match body_status {
            Some("already-sent") => PostAnswer::AlreadySent,
            Some("disabled") => PostAnswer::Disabled,
            _ => PostAnswer::Sent,
        },
        401 => PostAnswer::Unauthorized,
        404 => PostAnswer::Missing,
        408 => PostAnswer::Retry,
        429 => PostAnswer::RateLimited,
        400..=499 => PostAnswer::Refused(status),
        _ => PostAnswer::Retry,
    }
}

/// `GET` / `PUT /api/account/stream-report-email`'s answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PreferenceAnswer {
    Known {
        enabled: bool,
        email: Option<String>,
    },
    Unauthorized,
    Missing,
    Retry,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WirePreference {
    enabled: bool,
    #[serde(default)]
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WireSendAnswer {
    #[serde(default)]
    status: Option<String>,
}

pub(crate) fn classify_preference(status: u16, body: Option<&str>) -> PreferenceAnswer {
    match status {
        200..=299 => {
            match body.and_then(|body| serde_json::from_str::<WirePreference>(body).ok()) {
                Some(preference) => PreferenceAnswer::Known {
                    enabled: preference.enabled,
                    email: preference.email.filter(|email| !email.trim().is_empty()),
                },
                None => PreferenceAnswer::Retry,
            }
        }
        401 | 403 => PreferenceAnswer::Unauthorized,
        404 => PreferenceAnswer::Missing,
        _ => PreferenceAnswer::Retry,
    }
}

/// 60 s, doubling per failed attempt, at most 30 min.
pub(crate) fn retry_delay(attempts: u32) -> Duration {
    RETRY_MIN
        .saturating_mul(2u32.saturating_pow(attempts.saturating_sub(1).min(16)))
        .min(RETRY_MAX)
}

fn env_disables(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        )
    })
}

fn same_account(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

// ---------------------------------------------------------------------------
// The queue (SQLite)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct QueuedReport {
    pub session_id: String,
    pub report_id: String,
    pub platforms: Vec<StreamPlatform>,
    pub account_email: String,
    pub due_at: DateTime<Utc>,
    pub ended_at: DateTime<Utc>,
    pub attempts: u32,
}

fn parse_utc(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Queues one ended live session. A session already queued or sent keeps its
/// row. Returns whether a row was added.
pub(crate) fn enqueue(
    database: &Database,
    ended: &EndedLive,
    account_email: &str,
    now: DateTime<Utc>,
) -> anyhow::Result<bool> {
    let conn = database.lock()?;
    let due_at = now + TimeDelta::from_std(SETTLE).unwrap_or(TimeDelta::seconds(60));
    let added = conn.execute(
        "INSERT INTO stream_report_emails (
            session_id, report_id, platforms_json, account_email, status, due_at, ended_at,
            attempts, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?7)
         ON CONFLICT(session_id) DO NOTHING",
        params![
            ended.session_id,
            uuid::Uuid::new_v4().to_string(),
            serde_json::to_string(&ended.platforms)?,
            account_email.trim(),
            STATUS_QUEUED,
            stamp(due_at),
            stamp(now),
        ],
    )?;
    Ok(added == 1)
}

pub(crate) fn queued_reports(database: &Database) -> anyhow::Result<Vec<QueuedReport>> {
    let conn = database.lock()?;
    let mut statement = conn.prepare(
        "SELECT session_id, report_id, platforms_json, account_email, due_at, ended_at, attempts
         FROM stream_report_emails WHERE status = ?1 ORDER BY due_at ASC",
    )?;
    let rows = statement.query_map(params![STATUS_QUEUED], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, i64>(6)?,
        ))
    })?;
    let mut reports = Vec::new();
    for row in rows {
        let (session_id, report_id, platforms, account_email, due_at, ended_at, attempts) = row?;
        let (Some(due_at), Some(ended_at)) = (parse_utc(&due_at), parse_utc(&ended_at)) else {
            continue;
        };
        reports.push(QueuedReport {
            session_id,
            report_id,
            platforms: serde_json::from_str(&platforms).unwrap_or_default(),
            account_email,
            due_at,
            ended_at,
            attempts: u32::try_from(attempts).unwrap_or(0),
        });
    }
    Ok(reports)
}

fn set_status(
    database: &Database,
    session_id: &str,
    status: &str,
    now: DateTime<Utc>,
) -> anyhow::Result<()> {
    let conn = database.lock()?;
    conn.execute(
        "UPDATE stream_report_emails SET status = ?2, updated_at = ?3 WHERE session_id = ?1",
        params![session_id, status, stamp(now)],
    )?;
    Ok(())
}

fn reschedule(
    database: &Database,
    session_id: &str,
    attempts: u32,
    due_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> anyhow::Result<()> {
    let conn = database.lock()?;
    conn.execute(
        "UPDATE stream_report_emails SET attempts = ?2, due_at = ?3, updated_at = ?4
         WHERE session_id = ?1",
        params![session_id, i64::from(attempts), stamp(due_at), stamp(now)],
    )?;
    Ok(())
}

/// A sign-out or another account: every queued report of anyone else is
/// dropped, never sent later to the wrong inbox.
pub(crate) fn drop_other_accounts(
    database: &Database,
    current_email: Option<&str>,
    now: DateTime<Utc>,
) -> anyhow::Result<usize> {
    let mut dropped = 0;
    for report in queued_reports(database)? {
        let keep = current_email.is_some_and(|email| same_account(email, &report.account_email));
        if !keep {
            set_status(database, &report.session_id, STATUS_DROPPED, now)?;
            dropped += 1;
        }
    }
    Ok(dropped)
}

/// The destinations a session went live to, when the observer saw them.
fn saved_platforms(database: &Database, session_id: &str) -> Vec<StreamPlatform> {
    let Ok(conn) = database.lock() else {
        return Vec::new();
    };
    conn.query_row(
        "SELECT platforms_json FROM stream_report_emails WHERE session_id = ?1",
        params![session_id],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|json| serde_json::from_str(&json).ok())
    .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/// Held in `AppState`.
#[derive(Debug, Default)]
pub struct StreamReportRuntime {
    env_disabled: AtomicBool,
    /// The web answered 404: an older deploy. Quiet for the rest of this run.
    web_missing: AtomicBool,
    /// Wakes the sender: a row was queued, or the account changed.
    wake: Notify,
    /// One send at a time, automatic or "Send the last one".
    send_lock: Mutex<()>,
}

/// The signed-in account's address, or `None`.
async fn signed_in_email(state: &AppState) -> Option<String> {
    let session = state.account_session.lock().await;
    let account = crate::account::current_account(session.as_ref());
    if account.status != AccountStatus::SignedIn {
        return None;
    }
    account.email.filter(|email| !email.trim().is_empty())
}

/// What the sender needs to reach the web as the signed-in account.
#[derive(Debug, Clone)]
pub(crate) struct WebAccess {
    pub base_url: String,
    pub token: String,
    pub email: String,
}

async fn web_access(state: &AppState) -> Option<WebAccess> {
    // The address and the token are one identity: read both under the account
    // transition lock, as an account refresh does (account.rs), so a sign-in
    // between the two reads can't pair one account's address with another's
    // token. The lock comes before `account_session`, the same order as there.
    let _transition = state.account_auth_transition.lock().await;
    let email = signed_in_email(state).await?;
    let token = crate::account::stored_session_token()?;
    Some(WebAccess {
        base_url: crate::videorc_api::api_base_url(),
        token,
        email,
    })
}

fn http_client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(crate::performance_check::desktop_user_agent())
        .build()
        .ok()
}

pub(crate) async fn fetch_preference(
    client: &reqwest::Client,
    web: &WebAccess,
) -> PreferenceAnswer {
    let request = client
        .get(format!("{}{PREFERENCE_PATH}", web.base_url))
        .bearer_auth(&web.token);
    preference_answer(request.send().await).await
}

async fn put_preference(
    client: &reqwest::Client,
    web: &WebAccess,
    enabled: bool,
) -> PreferenceAnswer {
    let request = client
        .put(format!("{}{PREFERENCE_PATH}", web.base_url))
        .bearer_auth(&web.token)
        .json(&serde_json::json!({ "enabled": enabled }));
    preference_answer(request.send().await).await
}

async fn preference_answer(
    response: Result<reqwest::Response, reqwest::Error>,
) -> PreferenceAnswer {
    match response {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response.text().await.ok();
            classify_preference(status, body.as_deref())
        }
        Err(_) => PreferenceAnswer::Retry,
    }
}

pub(crate) async fn post_report(
    client: &reqwest::Client,
    web: &WebAccess,
    report: &StreamReport,
) -> PostAnswer {
    let response = client
        .post(format!("{}{REPORT_PATH}", web.base_url))
        .bearer_auth(&web.token)
        .json(report)
        .send()
        .await;
    match response {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response.text().await.ok();
            let body_status = body
                .as_deref()
                .and_then(|body| serde_json::from_str::<WireSendAnswer>(body).ok())
                .and_then(|answer| answer.status);
            classify_post(status, body_status.as_deref())
        }
        Err(_) => PostAnswer::Retry,
    }
}

/// What became of one due report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Delivery {
    Sent,
    Disabled,
    Dropped,
    Expired,
    /// Try again at this time.
    Retry(DateTime<Utc>),
    Failed,
}

/// Sends one due report as `web`'s account. Never panics, never blocks the
/// stream: every failure becomes a status.
pub(crate) async fn deliver(
    state: &AppState,
    client: &reqwest::Client,
    web: Option<&WebAccess>,
    report: &QueuedReport,
    now: DateTime<Utc>,
) -> Delivery {
    if now - report.ended_at > MAX_AGE {
        return Delivery::Expired;
    }
    let Some(web) = web.filter(|web| same_account(&web.email, &report.account_email)) else {
        return Delivery::Dropped;
    };
    if state.stream_report.web_missing.load(Ordering::Acquire) {
        return Delivery::Dropped;
    }
    let retry_or_fail = || {
        let attempts = report.attempts.saturating_add(1);
        if attempts >= MAX_ATTEMPTS {
            Delivery::Failed
        } else {
            Delivery::Retry(
                now + TimeDelta::from_std(retry_delay(attempts)).unwrap_or(TimeDelta::minutes(30)),
            )
        }
    };
    // The account's choice comes first: an "off" account sends no numbers.
    match fetch_preference(client, web).await {
        PreferenceAnswer::Known { enabled: false, .. } => return Delivery::Disabled,
        PreferenceAnswer::Known { enabled: true, .. } => {}
        PreferenceAnswer::Unauthorized => return Delivery::Dropped,
        PreferenceAnswer::Missing => {
            state
                .stream_report
                .web_missing
                .store(true, Ordering::Release);
            return Delivery::Dropped;
        }
        PreferenceAnswer::Retry => return retry_or_fail(),
    }
    let built = crate::stream_report::load_report(
        &state.database,
        &report.session_id,
        report.report_id.clone(),
        report.platforms.clone(),
    );
    let built = match built {
        Ok(Some(built)) => built,
        Ok(None) => return Delivery::Dropped,
        Err(error) => {
            tracing::warn!("Stream report: could not read the session: {error:#}");
            return retry_or_fail();
        }
    };
    match post_report(client, web, &built).await {
        PostAnswer::Sent | PostAnswer::AlreadySent => Delivery::Sent,
        PostAnswer::Disabled => Delivery::Disabled,
        PostAnswer::Missing => {
            state
                .stream_report
                .web_missing
                .store(true, Ordering::Release);
            Delivery::Dropped
        }
        PostAnswer::RateLimited | PostAnswer::Unauthorized => Delivery::Dropped,
        PostAnswer::Refused(status) => {
            tracing::warn!("Stream report: videorc.com refused the report ({status}); dropped it.");
            Delivery::Dropped
        }
        PostAnswer::Retry => retry_or_fail(),
    }
}

/// Records what became of one report.
fn settle(database: &Database, report: &QueuedReport, delivery: Delivery, now: DateTime<Utc>) {
    let result = match delivery {
        Delivery::Sent => set_status(database, &report.session_id, STATUS_SENT, now),
        Delivery::Disabled => set_status(database, &report.session_id, STATUS_DISABLED, now),
        Delivery::Dropped => set_status(database, &report.session_id, STATUS_DROPPED, now),
        Delivery::Expired => set_status(database, &report.session_id, STATUS_EXPIRED, now),
        Delivery::Failed => set_status(database, &report.session_id, STATUS_FAILED, now),
        Delivery::Retry(due_at) => reschedule(
            database,
            &report.session_id,
            report.attempts.saturating_add(1),
            due_at,
            now,
        ),
    };
    if let Err(error) = result {
        tracing::warn!("Stream report: could not save the report's status: {error:#}");
    }
    tracing::info!(
        "Stream report for session {}: {delivery:?}",
        report.session_id
    );
}

/// Sends every due report; returns when the next one is due.
async fn send_due(state: &AppState, client: &reqwest::Client) -> Option<DateTime<Utc>> {
    let _guard = state.stream_report.send_lock.lock().await;
    let reports = match queued_reports(&state.database) {
        Ok(reports) => reports,
        Err(error) => {
            // Look again later; without a time the sender would sleep until
            // the next stream queued a report.
            tracing::warn!("Stream report: queue unreadable: {error:#}");
            return Some(
                Utc::now() + TimeDelta::from_std(RETRY_MIN).unwrap_or(TimeDelta::minutes(1)),
            );
        }
    };
    let mut next_due: Option<DateTime<Utc>> = None;
    for report in reports {
        let now = Utc::now();
        if report.due_at > now {
            next_due = Some(next_due.map_or(report.due_at, |due| due.min(report.due_at)));
            continue;
        }
        let web = web_access(state).await;
        let delivery = deliver(state, client, web.as_ref(), &report, now).await;
        settle(&state.database, &report, delivery, Utc::now());
        if let Delivery::Retry(due_at) = delivery {
            next_due = Some(next_due.map_or(due_at, |due| due.min(due_at)));
        }
    }
    next_due
}

/// Boot: read the run's switch, then start the observer and the sender.
/// Never fails the backend.
pub(crate) fn spawn(state: &AppState) {
    let disabled = env_disables(std::env::var(DISABLE_ENV_VAR).ok().as_deref());
    state
        .stream_report
        .env_disabled
        .store(disabled, Ordering::Release);
    if disabled {
        return;
    }
    tokio::spawn(run_observer(state.clone(), state.events.subscribe()));
    tokio::spawn(run_sender(state.clone()));
}

async fn run_observer(state: AppState, mut events: broadcast::Receiver<ServerEvent>) {
    let mut tracker = LiveTracker::default();
    loop {
        let event = match events.recv().await {
            Ok(event) => event,
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => return,
        };
        // A benchmark session (Health → performance check) is not a stream.
        if state.performance_check.suppresses_event(&event.event) {
            continue;
        }
        if event.event == "account.changed" {
            let email = signed_in_email(&state).await;
            match drop_other_accounts(&state.database, email.as_deref(), Utc::now()) {
                Ok(0) => {}
                Ok(dropped) => tracing::info!(
                    "Stream report: the account changed; dropped {dropped} queued report(s)."
                ),
                Err(error) => tracing::warn!("Stream report: {error:#}"),
            }
            continue;
        }
        let Some(ended) = tracker.observe(&event, Utc::now()) else {
            continue;
        };
        if !worth_a_report(&ended) {
            continue;
        }
        // Signed out: nobody to email.
        let Some(email) = signed_in_email(&state).await else {
            continue;
        };
        match enqueue(&state.database, &ended, &email, Utc::now()) {
            Ok(true) => state.stream_report.wake.notify_one(),
            Ok(false) => {}
            Err(error) => tracing::warn!("Stream report: could not queue the report: {error:#}"),
        }
    }
}

async fn run_sender(state: AppState) {
    let Some(client) = http_client() else {
        return;
    };
    tokio::time::sleep(STARTUP_DELAY).await;
    loop {
        let next_due = send_due(&state, &client).await;
        let wait = next_due.map(|due| (due - Utc::now()).to_std().unwrap_or_default());
        tokio::select! {
            () = state.stream_report.wake.notified() => {}
            () = sleep_for(wait) => {}
        }
    }
}

async fn sleep_for(wait: Option<Duration>) {
    match wait {
        Some(wait) => tokio::time::sleep(wait).await,
        None => std::future::pending().await,
    }
}

// ---------------------------------------------------------------------------
// RPCs
// ---------------------------------------------------------------------------

/// `streamReport.email.get`: the account's choice, read from the web.
pub(crate) async fn current_state(state: &AppState) -> StreamReportEmailState {
    if let Ok(snapshot) = tokio::time::timeout(RPC_BUDGET, read_state(state)).await {
        return snapshot;
    }
    // videorc.com is slow: the choice is unknown for now.
    let email = signed_in_email(state).await;
    StreamReportEmailState {
        signed_in: email.is_some(),
        email,
        enabled: None,
        env_disabled: state.stream_report.env_disabled.load(Ordering::Acquire),
    }
}

async fn read_state(state: &AppState) -> StreamReportEmailState {
    let env_disabled = state.stream_report.env_disabled.load(Ordering::Acquire);
    let Some(web) = web_access(state).await else {
        // Signed out, or signed in without a readable session token.
        let email = signed_in_email(state).await;
        return StreamReportEmailState {
            signed_in: email.is_some(),
            email,
            enabled: None,
            env_disabled,
        };
    };
    let Some(client) = http_client() else {
        return state_for(&web, None, env_disabled);
    };
    let answer = fetch_preference(&client, &web).await;
    preference_state(&web, answer, env_disabled)
}

/// `streamReport.email.set`.
pub(crate) async fn set_enabled(
    state: &AppState,
    enabled: bool,
) -> anyhow::Result<StreamReportEmailState> {
    tokio::time::timeout(RPC_BUDGET, save_enabled(state, enabled))
        .await
        .unwrap_or_else(|_| Err(anyhow::anyhow!("videorc.com didn't answer. Try again.")))
}

async fn save_enabled(state: &AppState, enabled: bool) -> anyhow::Result<StreamReportEmailState> {
    let env_disabled = state.stream_report.env_disabled.load(Ordering::Acquire);
    let Some(web) = web_access(state).await else {
        anyhow::bail!("Sign in to Videorc to get a report by email.");
    };
    let client = http_client().ok_or_else(|| anyhow::anyhow!("No HTTP client."))?;
    match put_preference(&client, &web, enabled).await {
        answer @ PreferenceAnswer::Known { .. } => Ok(preference_state(&web, answer, env_disabled)),
        PreferenceAnswer::Unauthorized => anyhow::bail!("Sign in to Videorc again."),
        PreferenceAnswer::Missing => anyhow::bail!("videorc.com can't send stream reports yet."),
        PreferenceAnswer::Retry => anyhow::bail!("videorc.com didn't answer. Try again."),
    }
}

fn state_for(web: &WebAccess, enabled: Option<bool>, env_disabled: bool) -> StreamReportEmailState {
    StreamReportEmailState {
        signed_in: true,
        email: Some(web.email.clone()),
        enabled,
        env_disabled,
    }
}

fn preference_state(
    web: &WebAccess,
    answer: PreferenceAnswer,
    env_disabled: bool,
) -> StreamReportEmailState {
    match answer {
        PreferenceAnswer::Known { enabled, email } => StreamReportEmailState {
            signed_in: true,
            email: email.or_else(|| Some(web.email.clone())),
            enabled: Some(enabled),
            env_disabled,
        },
        _ => state_for(web, None, env_disabled),
    }
}

/// `streamReport.email.sendLast`: the latest ended live session's report,
/// now, to the account's own address. A fresh report id each time: the
/// streamer asked for another copy. Ignores the 5-minute floor (it is the
/// owner's preview).
pub(crate) async fn send_last(state: &AppState) -> StreamReportSendResult {
    match tokio::time::timeout(RPC_BUDGET, send_last_now(state)).await {
        Ok(result) => result,
        Err(_) => {
            tracing::warn!(
                "Stream report: Send the last one ran out of its {}s budget.",
                RPC_BUDGET.as_secs()
            );
            StreamReportSendResult {
                status: StreamReportSendStatus::Failed,
                email: None,
            }
        }
    }
}

async fn send_last_now(state: &AppState) -> StreamReportSendResult {
    let result = |status, email: Option<&str>| StreamReportSendResult {
        status,
        email: email.map(str::to_string),
    };
    if state.stream_report.env_disabled.load(Ordering::Acquire) {
        return result(StreamReportSendStatus::Unavailable, None);
    }
    let Some(web) = web_access(state).await else {
        return result(StreamReportSendStatus::SignedOut, None);
    };
    let Some(client) = http_client() else {
        return result(StreamReportSendStatus::Failed, Some(&web.email));
    };
    let status = send_last_as(state, &client, &web).await;
    result(status, Some(&web.email))
}

/// "Send the last one" as `web`'s account. The account's choice comes first,
/// as for an automatic report: an "off" account sends no numbers.
pub(crate) async fn send_last_as(
    state: &AppState,
    client: &reqwest::Client,
    web: &WebAccess,
) -> StreamReportSendStatus {
    let _guard = state.stream_report.send_lock.lock().await;
    match fetch_preference(client, web).await {
        PreferenceAnswer::Known { enabled: false, .. } => return StreamReportSendStatus::Disabled,
        PreferenceAnswer::Known { enabled: true, .. } => {}
        PreferenceAnswer::Unauthorized => return StreamReportSendStatus::SignedOut,
        PreferenceAnswer::Missing => return StreamReportSendStatus::Unavailable,
        PreferenceAnswer::Retry => return StreamReportSendStatus::Failed,
    }
    let session_id = match crate::stream_report::latest_ended_live_session(&state.database) {
        Ok(Some(session_id)) => session_id,
        Ok(None) => return StreamReportSendStatus::NoStream,
        Err(error) => {
            tracing::warn!("Stream report: {error:#}");
            return StreamReportSendStatus::Failed;
        }
    };
    let built = crate::stream_report::load_report(
        &state.database,
        &session_id,
        uuid::Uuid::new_v4().to_string(),
        saved_platforms(&state.database, &session_id),
    );
    let built = match built {
        Ok(Some(built)) => built,
        Ok(None) => return StreamReportSendStatus::NoStream,
        Err(error) => {
            tracing::warn!("Stream report: could not read the session: {error:#}");
            return StreamReportSendStatus::Failed;
        }
    };
    match post_report(client, web, &built).await {
        PostAnswer::Sent => StreamReportSendStatus::Sent,
        PostAnswer::AlreadySent => StreamReportSendStatus::AlreadySent,
        PostAnswer::Disabled => StreamReportSendStatus::Disabled,
        PostAnswer::RateLimited => StreamReportSendStatus::RateLimited,
        PostAnswer::Unauthorized => StreamReportSendStatus::SignedOut,
        PostAnswer::Missing => StreamReportSendStatus::Unavailable,
        PostAnswer::Refused(_) | PostAnswer::Retry => StreamReportSendStatus::Failed,
    }
}

#[cfg(test)]
pub(crate) mod tests_support {
    use super::*;

    /// A finished live session row with the columns the report reads.
    pub(crate) fn seed_live_session(
        database: &Database,
        id: &str,
        started_at: &str,
        ended_at: &str,
    ) {
        let conn = database.lock().unwrap();
        conn.execute(
            "INSERT INTO sessions (
                id, title, started_at, ended_at, status, mode, sources_json, layout_json,
                output_json
             ) VALUES (?1, 'Friday stream', ?2, ?3, 'completed', 'stream', '{}', '{}', '{}')",
            params![id, started_at, ended_at],
        )
        .unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::seed_live_session;
    use super::*;
    use crate::streaming::{StreamTargetRuntime, StreamTargetState};
    use axum::extract::State;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use serde_json::json;
    use std::sync::Arc;
    use std::sync::Mutex as StdMutex;

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-14T18:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
            + TimeDelta::seconds(seconds)
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
                    redacted_url: None,
                    uplink_overflows: None,
                    uplink_overflow_at: None,
                })
                .collect(),
        };
        ServerEvent {
            event: "stream.targets".to_string(),
            payload: serde_json::to_value(snapshot).unwrap(),
        }
    }

    #[test]
    fn a_live_session_end_carries_its_destinations() {
        let mut tracker = LiveTracker::default();
        assert_eq!(
            tracker.observe(
                &status(
                    "streaming",
                    "s1",
                    json!({ "startedAt": at(0).to_rfc3339() })
                ),
                at(0)
            ),
            None
        );
        tracker.observe(
            &targets("s1", &[StreamPlatform::Twitch, StreamPlatform::Youtube]),
            at(1),
        );
        let ended = tracker
            .observe(
                &status("idle", "s1", json!({ "durationMs": 600_000 })),
                at(600),
            )
            .unwrap();
        assert_eq!(ended.session_id, "s1");
        assert_eq!(
            ended.platforms,
            vec![StreamPlatform::Youtube, StreamPlatform::Twitch]
        );
        assert_eq!(ended.seconds_live, 600);
        assert!(worth_a_report(&ended));
    }

    #[test]
    fn targets_before_the_running_status_still_count() {
        let mut tracker = LiveTracker::default();
        tracker.observe(&targets("s1", &[StreamPlatform::Kick]), at(0));
        tracker.observe(&status("recording", "s1", json!({})), at(0));
        let ended = tracker
            .observe(&status("idle", "s1", json!({})), at(400))
            .unwrap();
        assert_eq!(ended.platforms, vec![StreamPlatform::Kick]);
        assert_eq!(ended.seconds_live, 400);
    }

    #[test]
    fn recording_only_and_short_streams_get_no_report() {
        let mut tracker = LiveTracker::default();
        tracker.observe(&status("recording", "rec", json!({})), at(0));
        assert_eq!(
            tracker.observe(&status("idle", "rec", json!({})), at(900)),
            None
        );
        tracker.observe(&status("streaming", "short", json!({})), at(0));
        let short = tracker
            .observe(&status("idle", "short", json!({})), at(120))
            .unwrap();
        assert!(!worth_a_report(&short), "D5: under 5 minutes");
        // An end for another session changes nothing.
        tracker.observe(&status("streaming", "a", json!({})), at(0));
        assert_eq!(
            tracker.observe(&status("idle", "b", json!({})), at(900)),
            None
        );
    }

    #[test]
    fn web_answers_map_to_actions() {
        assert_eq!(classify_post(200, Some("sent")), PostAnswer::Sent);
        assert_eq!(classify_post(200, None), PostAnswer::Sent);
        assert_eq!(
            classify_post(200, Some("already-sent")),
            PostAnswer::AlreadySent
        );
        assert_eq!(classify_post(200, Some("disabled")), PostAnswer::Disabled);
        assert_eq!(classify_post(401, None), PostAnswer::Unauthorized);
        assert_eq!(classify_post(404, None), PostAnswer::Missing);
        assert_eq!(classify_post(429, None), PostAnswer::RateLimited);
        assert_eq!(classify_post(400, None), PostAnswer::Refused(400));
        assert_eq!(classify_post(413, None), PostAnswer::Refused(413));
        assert_eq!(classify_post(408, None), PostAnswer::Retry);
        assert_eq!(classify_post(503, None), PostAnswer::Retry);
        assert_eq!(
            classify_preference(200, Some(r#"{"enabled":false,"email":"a@b.c"}"#)),
            PreferenceAnswer::Known {
                enabled: false,
                email: Some("a@b.c".to_string())
            }
        );
        assert_eq!(
            classify_preference(200, Some("nope")),
            PreferenceAnswer::Retry
        );
        assert_eq!(
            classify_preference(401, None),
            PreferenceAnswer::Unauthorized
        );
        assert_eq!(classify_preference(404, None), PreferenceAnswer::Missing);
        assert_eq!(classify_preference(502, None), PreferenceAnswer::Retry);
    }

    #[test]
    fn retries_back_off_to_half_an_hour() {
        assert_eq!(retry_delay(1), Duration::from_secs(60));
        assert_eq!(retry_delay(2), Duration::from_secs(120));
        assert_eq!(retry_delay(20), RETRY_MAX);
        assert!(env_disables(Some("0")) && env_disables(Some(" OFF ")));
        assert!(!env_disables(Some("1")) && !env_disables(None));
    }

    fn ended(session_id: &str) -> EndedLive {
        EndedLive {
            session_id: session_id.to_string(),
            platforms: vec![StreamPlatform::Twitch],
            seconds_live: 3_600,
        }
    }

    #[test]
    fn the_queue_keeps_one_row_per_session_and_drops_other_accounts() {
        let database = Database::open_in_memory_for_tests();
        seed_live_session(
            &database,
            "s1",
            "2026-11-14T18:00:00Z",
            "2026-11-14T19:00:00Z",
        );
        seed_live_session(
            &database,
            "s2",
            "2026-11-14T20:00:00Z",
            "2026-11-14T21:00:00Z",
        );
        assert!(enqueue(&database, &ended("s1"), "Ada@Example.com", at(0)).unwrap());
        assert!(!enqueue(&database, &ended("s1"), "ada@example.com", at(5)).unwrap());
        assert!(enqueue(&database, &ended("s2"), "bo@example.com", at(10)).unwrap());
        let queued = queued_reports(&database).unwrap();
        assert_eq!(queued.len(), 2);
        assert_eq!(queued[0].due_at, at(60), "D6: due a minute after the end");
        assert_eq!(queued[0].platforms, vec![StreamPlatform::Twitch]);
        assert_eq!(
            drop_other_accounts(&database, Some("ada@example.com"), at(20)).unwrap(),
            1
        );
        let left = queued_reports(&database).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].session_id, "s1");
        assert_eq!(drop_other_accounts(&database, None, at(30)).unwrap(), 1);
        assert!(queued_reports(&database).unwrap().is_empty());
        // Deleting the session deletes its report row.
        database
            .lock()
            .unwrap()
            .execute("DELETE FROM sessions WHERE id = 's1'", [])
            .unwrap();
        assert_eq!(
            saved_platforms(&database, "s1"),
            Vec::<StreamPlatform>::new()
        );
    }

    /// A fake videorc.com: the preference answer, the report answer, and
    /// what the desktop sent.
    #[derive(Clone)]
    struct FakeWeb {
        preference: Arc<StdMutex<(u16, serde_json::Value)>>,
        report: Arc<StdMutex<(u16, serde_json::Value)>>,
        received: Arc<StdMutex<Vec<(String, serde_json::Value)>>>,
    }

    async fn fake_web(
        preference: (u16, serde_json::Value),
        report: (u16, serde_json::Value),
    ) -> (String, FakeWeb) {
        let web = FakeWeb {
            preference: Arc::new(StdMutex::new(preference)),
            report: Arc::new(StdMutex::new(report)),
            received: Arc::new(StdMutex::new(Vec::new())),
        };
        let app = Router::new()
            .route(
                PREFERENCE_PATH,
                get(
                    |State(web): State<FakeWeb>, headers: axum::http::HeaderMap| async move {
                        let auth = headers
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default()
                            .to_string();
                        web.received
                            .lock()
                            .unwrap()
                            .push((format!("GET {auth}"), json!(null)));
                        let (status, body) = web.preference.lock().unwrap().clone();
                        (StatusCode::from_u16(status).unwrap(), Json(body)).into_response()
                    },
                ),
            )
            .route(
                REPORT_PATH,
                post(
                    |State(web): State<FakeWeb>, Json(body): Json<serde_json::Value>| async move {
                        web.received
                            .lock()
                            .unwrap()
                            .push(("POST".to_string(), body));
                        let (status, body) = web.report.lock().unwrap().clone();
                        (StatusCode::from_u16(status).unwrap(), Json(body)).into_response()
                    },
                ),
            )
            .with_state(web.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), web)
    }

    fn test_state() -> AppState {
        AppState::new(
            "test".into(),
            1234,
            tokio::sync::broadcast::channel(64).0,
            Database::open_in_memory_for_tests(),
        )
    }

    fn queued(state: &AppState) -> QueuedReport {
        seed_live_session(
            &state.database,
            "live-1",
            "2026-11-14T18:00:00Z",
            "2026-11-14T19:00:00Z",
        );
        state
            .database
            .add_session_log(
                "live-1",
                crate::protocol::HealthLevel::Info,
                crate::viewer_stats::VIEWER_SAMPLE_LOG_CODE,
                r#"{"sessionId":"live-1","platforms":[{"platform":"youtube","count":30},{"platform":"twitch","count":12}],"total":42,"at":"2026-11-14T18:10:00Z"}"#,
                None,
            )
            .unwrap();
        enqueue(
            &state.database,
            &EndedLive {
                session_id: "live-1".to_string(),
                platforms: vec![StreamPlatform::Youtube, StreamPlatform::Twitch],
                seconds_live: 3_600,
            },
            "ada@example.com",
            at(3_600),
        )
        .unwrap();
        queued_reports(&state.database).unwrap().remove(0)
    }

    fn access(base_url: &str, email: &str) -> WebAccess {
        WebAccess {
            base_url: base_url.to_string(),
            token: "session-token".to_string(),
            email: email.to_string(),
        }
    }

    #[tokio::test]
    async fn a_due_report_is_sent_with_every_platform_youtube_included() {
        let state = test_state();
        let report = queued(&state);
        let (base, web) = fake_web(
            (200, json!({ "enabled": true, "email": "ada@example.com" })),
            (200, json!({ "status": "sent" })),
        )
        .await;
        let client = http_client().unwrap();
        let delivery = deliver(
            &state,
            &client,
            Some(&access(&base, "ADA@example.com")),
            &report,
            at(3_700),
        )
        .await;
        assert_eq!(delivery, Delivery::Sent);
        let received = web.received.lock().unwrap().clone();
        assert_eq!(
            received[0].0, "GET Bearer session-token",
            "preference first"
        );
        let body = &received[1].1;
        assert_eq!(body["version"], 1);
        assert_eq!(body["reportId"], report.report_id);
        assert!(body.get("youtubeOmitted").is_none());
        // D3: YouTube's 30 and Twitch's 12 are one total.
        assert_eq!(body["viewers"]["peak"], 42);
        assert_eq!(body["viewers"]["coverage"], json!(["youtube", "twitch"]));
        assert_eq!(body["platforms"], json!(["youtube", "twitch"]));
        settle(&state.database, &report, delivery, at(3_700));
        assert!(queued_reports(&state.database).unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_account_that_turned_it_off_sends_no_numbers() {
        let state = test_state();
        let report = queued(&state);
        let (base, web) = fake_web((200, json!({ "enabled": false })), (500, json!({}))).await;
        let client = http_client().unwrap();
        let delivery = deliver(
            &state,
            &client,
            Some(&access(&base, "ada@example.com")),
            &report,
            at(3_700),
        )
        .await;
        assert_eq!(delivery, Delivery::Disabled);
        assert_eq!(web.received.lock().unwrap().len(), 1, "no POST");
    }

    #[tokio::test]
    async fn web_failures_retry_refusals_drop_and_404_quiets_the_run() {
        let state = test_state();
        let report = queued(&state);
        let client = http_client().unwrap();
        let (base, web) = fake_web((200, json!({ "enabled": true })), (503, json!({}))).await;
        let ada = access(&base, "ada@example.com");
        let delivery = deliver(&state, &client, Some(&ada), &report, at(3_700)).await;
        assert_eq!(delivery, Delivery::Retry(at(3_760)));
        *web.report.lock().unwrap() = (429, json!({}));
        assert_eq!(
            deliver(&state, &client, Some(&ada), &report, at(3_700)).await,
            Delivery::Dropped
        );
        *web.report.lock().unwrap() = (400, json!({}));
        assert_eq!(
            deliver(&state, &client, Some(&ada), &report, at(3_700)).await,
            Delivery::Dropped
        );
        // Retries run out.
        let tired = QueuedReport {
            attempts: MAX_ATTEMPTS - 1,
            ..report.clone()
        };
        *web.report.lock().unwrap() = (502, json!({}));
        assert_eq!(
            deliver(&state, &client, Some(&ada), &tired, at(3_700)).await,
            Delivery::Failed
        );
        // An older videorc.com: dropped, and nothing more is asked this run.
        *web.preference.lock().unwrap() = (404, json!({}));
        assert_eq!(
            deliver(&state, &client, Some(&ada), &report, at(3_700)).await,
            Delivery::Dropped
        );
        let asked = web.received.lock().unwrap().len();
        *web.preference.lock().unwrap() = (200, json!({ "enabled": true }));
        assert_eq!(
            deliver(&state, &client, Some(&ada), &report, at(3_700)).await,
            Delivery::Dropped
        );
        assert_eq!(web.received.lock().unwrap().len(), asked);
    }

    #[test]
    fn every_rpc_gives_up_inside_the_mutation_watchdog() {
        // A mutation past the watchdog restarts the backend, even mid-stream.
        assert!(RPC_BUDGET + Duration::from_secs(1) < crate::WEBSOCKET_MUTATION_MAX_EXECUTION_AGE);
        assert!(
            RPC_BUDGET < REQUEST_TIMEOUT,
            "the budget, not the client, cuts an RPC off"
        );
    }

    #[tokio::test]
    async fn send_the_last_one_asks_the_account_first_and_skips_a_running_stream() {
        let state = test_state();
        let _ = queued(&state);
        let client = http_client().unwrap();
        // Off: no numbers leave the computer.
        let (base, web) = fake_web((200, json!({ "enabled": false })), (200, json!({}))).await;
        let ada = access(&base, "ada@example.com");
        assert_eq!(
            send_last_as(&state, &client, &ada).await,
            StreamReportSendStatus::Disabled
        );
        assert_eq!(web.received.lock().unwrap().len(), 1, "no POST");
        // On, with a stream still running: the ended one goes.
        {
            let conn = state.database.lock().unwrap();
            conn.execute(
                "INSERT INTO sessions (
                    id, title, started_at, status, mode, sources_json, layout_json, output_json
                 ) VALUES ('live-2', 'Live now', '2026-11-14T21:00:00Z', 'running', 'stream',
                    '{}', '{}', '{}')",
                [],
            )
            .unwrap();
        }
        *web.preference.lock().unwrap() = (200, json!({ "enabled": true }));
        *web.report.lock().unwrap() = (200, json!({ "status": "sent" }));
        assert_eq!(
            send_last_as(&state, &client, &ada).await,
            StreamReportSendStatus::Sent
        );
        let received = web.received.lock().unwrap().clone();
        let body = &received.last().unwrap().1;
        assert_eq!(body["endedAt"], "2026-11-14T19:00:00Z");
        assert_eq!(body["viewers"]["peak"], 42);
    }

    #[tokio::test]
    async fn another_account_signed_out_or_a_stale_report_never_sends() {
        let state = test_state();
        let report = queued(&state);
        let (base, web) = fake_web((200, json!({ "enabled": true })), (200, json!({}))).await;
        let client = http_client().unwrap();
        assert_eq!(
            deliver(
                &state,
                &client,
                Some(&access(&base, "bo@example.com")),
                &report,
                at(3_700)
            )
            .await,
            Delivery::Dropped
        );
        assert_eq!(
            deliver(&state, &client, None, &report, at(3_700)).await,
            Delivery::Dropped
        );
        assert_eq!(
            deliver(
                &state,
                &client,
                Some(&access(&base, "ada@example.com")),
                &report,
                at(3_600 + 4 * 24 * 3_600)
            )
            .await,
            Delivery::Expired,
            "D6: older than 3 days"
        );
        assert!(web.received.lock().unwrap().is_empty());
    }
}
