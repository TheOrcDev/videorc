//! Clean cut's card (plan 260 S1.6e; Electron's `lib/clean-cut-view.ts`
//! and the card's part of `lib/clean-cut-auto.ts`): "Stop recording, and
//! the edited version is already there." Everything here is a pure
//! derivation of the job snapshots, the Library rows and the capability
//! block, so the card, the review, the ready toast and their tests cannot
//! disagree. The "every recording" preference itself is
//! `studio::families::clean_cut_auto` (`videorc.cleanCutAuto`, '1' or '0').

use serde_json::Value;
use videorc_protocol::{
    CleanCutEdlSummary, CleanCutJob, CleanCutJobState, CleanCutMode, RecordingFinalizationState,
    SessionListItem,
};

use crate::account::entitlements::{EntitlementGate, VIDEORC_PREMIUM_URL};
use crate::client::RpcError;
use crate::format::{day_label, format_timecode, grouped, is_auto_session_title};
use crate::library::page::{CleanCutCapture, CleanCutRules};
use crate::stream_manager::buddy::cloud_ai_uses;
use crate::user_error::{Failure, user_error_message};

// --- Capabilities ----------------------------------------------------------------

/// The `cleanCut` block of `ai.capabilities.get` (contract part B).
#[derive(Debug, Clone, PartialEq)]
pub struct CleanCutCapabilities {
    pub supported: bool,
    pub available: bool,
    /// Open string: `disabled`, `blocked`, `premium-required`,
    /// `provider-unconfigured`, `quota-exhausted`, or newer codes.
    pub reason_code: Option<String>,
    pub monthly_seconds_limit: Option<f64>,
    pub remaining_seconds: Option<f64>,
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

/// `cleanCutCapabilities`: the Clean cut block, read loosely. A server that
/// omits it does not offer Clean cut, and a partial block never fails.
pub fn clean_cut_capabilities(capabilities: Option<&Value>) -> Option<CleanCutCapabilities> {
    let block = capabilities?.get("cleanCut")?;
    if !block.is_object() {
        return None;
    }
    Some(CleanCutCapabilities {
        supported: block.get("supported").and_then(Value::as_bool) == Some(true),
        available: block.get("available").and_then(Value::as_bool) == Some(true),
        reason_code: block
            .get("reasonCode")
            .and_then(Value::as_str)
            .map(str::to_string),
        monthly_seconds_limit: finite(block.get("monthlySecondsLimit")),
        remaining_seconds: finite(block.get("remainingSeconds")),
    })
}

// --- Copy ------------------------------------------------------------------------

pub const CLEAN_CUT_TITLE: &str = "Clean cut";

/// The website's words (plan 119 S5), so the app and the site sell one thing.
pub const CLEAN_CUT_DESCRIPTION: &str = "Stop recording, and the edited version is already there. Silences, ums, and retakes removed, within a monthly allowance.";

pub const CLEAN_CUT_AUTO_LABEL: &str = "Make a clean cut of every recording";

pub const CLEAN_CUT_SIGNED_OUT_REASON: &str = "Sign in to use Clean cut, part of Videorc Premium.";

/// Its fix is the status line's "Allow cloud AI…" (plan 174 E-6).
pub const CLEAN_CUT_CONSENT_OFF_REASON: &str = "Cloud AI isn't allowed, so Clean cut can't run.";

pub const CLEAN_CUT_NO_RECORDINGS: &str =
    "Record something, and its clean cut shows up here when you stop.";

pub const CONDENSED_TOO_SHORT: &str = "Condensed is for recordings of 25 minutes or more.";

/// The Recordings section's line.
pub const RECORDINGS_DESCRIPTION: &str = "Pick a recording to cut, or review a cut you made.";

/// A recording without a title.
pub const UNTITLED: &str = "Untitled recording";

/// The recordings list's line when the search found nothing.
pub fn no_recordings_match(query: &str) -> String {
    format!("No recordings match “{}”.", query.trim())
}

/// "Show all (12)" / "Show fewer".
pub fn show_all_label(show_all: bool, count: usize) -> String {
    if show_all {
        "Show fewer".to_string()
    } else {
        format!("Show all ({count})")
    }
}

/// "Make a clean cut" / "Make a condensed cut".
pub fn make_label(mode: CleanCutMode) -> &'static str {
    match mode {
        CleanCutMode::Condensed => "Make a condensed cut",
        CleanCutMode::Clean => "Make a clean cut",
    }
}

/// The failed status alert's title.
pub fn failed_title(mode: CleanCutMode) -> &'static str {
    match mode {
        CleanCutMode::Condensed => "The condensed cut failed",
        CleanCutMode::Clean => "The clean cut failed",
    }
}

/// The toast when `cleanCut.start` is refused.
pub fn start_failed_title(mode: CleanCutMode) -> &'static str {
    match mode {
        CleanCutMode::Condensed => "Couldn't start the condensed cut",
        CleanCutMode::Clean => "Couldn't start the clean cut",
    }
}

/// The toast when `cleanCut.render` is refused.
pub const RENDER_FAILED_TITLE: &str = "Couldn't redo the clean cut";

/// The toast when `cleanCut.cancel` is refused.
pub const CANCEL_FAILED_TITLE: &str = "Couldn't cancel the clean cut";

/// "2 unsaved changes in its review" (E-5).
pub fn unsaved_label(changes: usize) -> String {
    format!(
        "{} in its review",
        crate::format::plural(
            i64::try_from(changes).unwrap_or(i64::MAX),
            "unsaved change",
            None
        )
    )
}

// --- Consent ---------------------------------------------------------------------

/// What asked for consent: the "every recording" switch, or one cut.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConsentAsk {
    Auto,
    Start {
        session_id: String,
        mode: CleanCutMode,
        target_minutes: u32,
    },
}

/// The heading over the rest of the list: what the same switch also allows.
pub const CLEAN_CUT_CONSENT_ALSO: &str = "Allowing cloud AI also covers Sidekick:";

/// "Turn on Clean cut?" / "Make a clean cut?".
pub fn consent_title(ask: &ConsentAsk) -> &'static str {
    match ask {
        ConsentAsk::Auto => "Turn on Clean cut?",
        ConsentAsk::Start { .. } => "Make a clean cut?",
    }
}

/// "Allow and turn on" / "Allow and make it".
pub fn consent_accept(ask: &ConsentAsk) -> &'static str {
    match ask {
        ConsentAsk::Auto => "Allow and turn on",
        ConsentAsk::Start { .. } => "Allow and make it",
    }
}

/// The dialog's decline.
pub const CONSENT_DECLINE: &str = "Not now";

/// `cloudAiUsesLedBy(CLOUD_AI_CLEAN_CUT_USE)`: Clean cut's own line leads,
/// then everything else the one switch also allows (plan 174 E-13).
pub fn consent_uses() -> (String, Vec<String>) {
    let uses = cloud_ai_uses();
    let lead = uses[uses.len() - 1].clone();
    let others = uses.into_iter().filter(|use_| *use_ != lead).collect();
    (lead, others)
}

// --- Rules -----------------------------------------------------------------------

/// Decision 11: shorter recordings are not cut.
pub const CLEAN_CUT_MIN_SOURCE_MS: i64 = 10_000;
/// S19: Condensed is offered from 25 minutes.
pub const CONDENSED_MIN_SOURCE_MS: i64 = 25 * 60_000;
/// S19: the target lengths, in minutes.
pub const CONDENSED_TARGET_MINUTES: [u32; 4] = [10, 15, 20, 30];
pub const CONDENSED_DEFAULT_TARGET_MINUTES: u32 = 15;
/// Recordings the picker offers, newest first.
pub const CLEAN_CUT_PICKER_LIMIT: usize = 20;
/// Rows the recordings list shows before "Show all".
pub const CLEAN_CUT_LIST_CAP: usize = 6;

const CLEAN_CUT_SOURCE_MODES: [&str; 3] = ["cloud-recording", "record", "record+stream"];

/// `CleanCutEligibility`: `Err` carries the plain reason.
pub type Eligibility = Result<(), &'static str>;

/// `cleanCutEligibility`, mirrored from the backend's `resolve_source`: a
/// finished Videorc recording (mode `record` or `record+stream`) with its
/// MP4, at least ten seconds long, neither imported nor derived. The backend
/// checks again; this only keeps the UI from offering what it would refuse.
pub fn eligibility(session: &SessionListItem) -> Eligibility {
    if session.status != "completed"
        || session.finalization_state == Some(RecordingFinalizationState::Finalizing)
    {
        return Err("Clean cut is available once the recording has finished.");
    }
    if session.mode == "imported" {
        return Err("Imported videos aren't supported yet.");
    }
    if session.derived_from_session_id.is_some()
        || session.processing_kind.is_some()
        || session.clean_cut_of_session_id.is_some()
    {
        return Err("A cleaned or cut copy can't be cut again.");
    }
    if !CLEAN_CUT_SOURCE_MODES.contains(&session.mode.as_str()) {
        return Err("Only recordings can be cut. This session was streamed without recording.");
    }
    if session
        .duration_ms
        .is_none_or(|ms| ms < CLEAN_CUT_MIN_SOURCE_MS)
    {
        return Err("Recordings shorter than 10 seconds can't be cut.");
    }
    let mp4 = session.mp4_path.as_deref().unwrap_or_default();
    if mp4.is_empty() || !mp4.to_lowercase().ends_with(".mp4") {
        return Err("The recording's MP4 file is missing.");
    }
    Ok(())
}

/// `isCleanCutEligible`.
pub fn is_eligible(session: &SessionListItem) -> bool {
    eligibility(session).is_ok()
}

/// `condensedEligibility`: an eligible recording of at least 25 minutes.
pub fn condensed_eligibility(session: &SessionListItem) -> Eligibility {
    eligibility(session)?;
    if session.duration_ms.unwrap_or(0) >= CONDENSED_MIN_SOURCE_MS {
        Ok(())
    } else {
        Err(CONDENSED_TOO_SHORT)
    }
}

/// `recentCleanCutRecordings`: eligible recordings, newest first.
pub fn recent_recordings(sessions: &[SessionListItem], limit: usize) -> Vec<&SessionListItem> {
    let mut rows: Vec<&SessionListItem> = sessions.iter().filter(|s| is_eligible(s)).collect();
    // Newest first: the stamps are RFC 3339, so they sort as text.
    rows.sort_by(|left, right| left.started_at.cmp(&right.started_at).reverse());
    rows.truncate(limit);
    rows
}

/// `matchCleanCutRecordings`: a recording matches on its title or on when
/// it ran, as the row shows it, case-insensitive. An empty query keeps all.
pub fn match_recordings<'a>(
    sessions: &[&'a SessionListItem],
    query: &str,
) -> Vec<&'a SessionListItem> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return sessions.to_vec();
    }
    sessions
        .iter()
        .copied()
        .filter(|session| {
            format!("{} {}", session.title, day_label(&session.started_at))
                .to_lowercase()
                .contains(&needle)
        })
        .collect()
}

/// `cleanCutRecordingFacts`: its length, then when it ran. An automatic
/// title already says when, so the row adds no second clock.
pub fn recording_facts(session: &SessionListItem) -> String {
    let length = session.duration_ms.map(format_cut_clock);
    let when = (!is_auto_session_title(&session.title)).then(|| day_label(&session.started_at));
    [length, when]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
}

/// `condensedTargetSeconds`: seconds for `cleanCut.start`; the contract
/// allows 120..3600.
pub fn condensed_target_seconds(minutes: u32) -> u32 {
    minutes.saturating_mul(60).clamp(120, 3_600)
}

// --- Jobs ------------------------------------------------------------------------

/// `isCleanCutJobActive`: a worker owns the job (or is about to). Unlike
/// the protocol's `is_active`, `ready` counts: its render waits for the slot.
pub fn is_job_active(job: &CleanCutJob) -> bool {
    matches!(
        job.state,
        CleanCutJobState::Queued
            | CleanCutJobState::Transcribing
            | CleanCutJobState::Analyzing
            | CleanCutJobState::Ready
            | CleanCutJobState::Rendering
            | CleanCutJobState::Validating
    )
}

/// `cleanCutJobEditable`: `cleanCut.updateEdl` and `cleanCut.render` accept
/// these.
pub fn job_editable(job: &CleanCutJob) -> bool {
    matches!(
        job.state,
        CleanCutJobState::Ready | CleanCutJobState::Completed | CleanCutJobState::Failed
    )
}

/// `upsertCleanCutJob`: one entry per job id; a snapshot older than the one
/// held is ignored.
pub fn upsert_job(jobs: &[CleanCutJob], job: CleanCutJob) -> Vec<CleanCutJob> {
    let Some(index) = jobs.iter().position(|entry| entry.id == job.id) else {
        let mut next = Vec::with_capacity(jobs.len() + 1);
        next.push(job);
        next.extend_from_slice(jobs);
        return next;
    };
    let mut next = jobs.to_vec();
    if jobs[index].updated_at <= job.updated_at {
        next[index] = job;
    }
    next
}

/// `latestCleanCutJob`: the newest job for one recording and mode.
pub fn latest_job<'a>(
    jobs: &'a [CleanCutJob],
    session_id: &str,
    mode: CleanCutMode,
) -> Option<&'a CleanCutJob> {
    newest(
        jobs.iter()
            .filter(|job| job.source_session_id == session_id && job.mode == mode),
    )
}

/// `latestCleanCutJobAnyMode`: the newest job for one recording.
pub fn latest_job_any_mode<'a>(
    jobs: &'a [CleanCutJob],
    session_id: &str,
) -> Option<&'a CleanCutJob> {
    newest(
        jobs.iter()
            .filter(|job| job.source_session_id == session_id),
    )
}

fn newest<'a>(jobs: impl Iterator<Item = &'a CleanCutJob>) -> Option<&'a CleanCutJob> {
    let mut latest: Option<&CleanCutJob> = None;
    for job in jobs {
        if latest.is_none_or(|held| job.created_at > held.created_at) {
            latest = Some(job);
        }
    }
    latest
}

// --- Time ------------------------------------------------------------------------

/// `formatCutClock`: "42:10", "1:02:10", as the clip marks show it.
pub fn format_cut_clock(ms: i64) -> String {
    format_timecode(ms.max(0), false)
}

fn clock(ms: u64) -> String {
    format_cut_clock(i64::try_from(ms).unwrap_or(i64::MAX))
}

/// `cleanCutDurationsLabel`: "42:10 → 31:05".
pub fn durations_label(summary: &CleanCutEdlSummary) -> String {
    format!(
        "{} → {}",
        clock(summary.duration_ms),
        clock(summary.kept_ms)
    )
}

/// `cleanCutSavedMs`: the difference of the two clocks shown, so 42:10 →
/// 31:05 always reads 11:05, never 11:04 from leftover milliseconds.
pub fn saved_ms(duration_ms: u64, kept_ms: u64) -> u64 {
    (duration_ms / 1000).saturating_sub(kept_ms / 1000) * 1000
}

/// `cleanCutSavedLabel`: "11:05 shorter".
pub fn saved_label(summary: &CleanCutEdlSummary) -> String {
    format!(
        "{} shorter",
        clock(saved_ms(summary.duration_ms, summary.kept_ms))
    )
}

/// `cleanCutMinutesLeftLabel`: "1,083 min left this month"; `None` when the
/// allowance is unlimited or unknown.
pub fn minutes_left_label(capabilities: Option<&CleanCutCapabilities>) -> Option<String> {
    let remaining = capabilities?.remaining_seconds?;
    if remaining <= 0.0 {
        return Some("No minutes left this month".to_string());
    }
    let minutes = (remaining / 60.0).floor() as i64;
    Some(format!("{} min left this month", grouped(minutes)))
}

// --- Status ----------------------------------------------------------------------

/// `CleanCutStatusKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusKind {
    None,
    Waiting,
    Queued,
    Transcribing,
    Analyzing,
    Cutting,
    Checking,
    Ready,
    Failed,
    Cancelled,
}

impl StatusKind {
    /// A worker runs: the row's glyph is a spinner.
    pub fn working(self) -> bool {
        matches!(
            self,
            StatusKind::Queued
                | StatusKind::Transcribing
                | StatusKind::Analyzing
                | StatusKind::Cutting
                | StatusKind::Checking
        )
    }
}

/// What Retry does: render the cut list again, or start over (resumes the
/// transcript).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Retry {
    Render,
    Start,
}

/// `CleanCutStatusView`: the card row and the review footer for one job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusView {
    pub kind: StatusKind,
    /// "Transcribing 40%", "Ready", "Failed".
    pub label: String,
    /// "42:10 → 31:05 · 11:05 shorter", the failure in plain words, or none.
    pub detail: Option<String>,
    /// A worker owns the job: Cancel is offered, Make is not.
    pub busy: bool,
    /// 0..100 while a step reports progress.
    pub percent: Option<u32>,
    /// The cut list exists, so the review can open.
    pub can_review: bool,
    /// `None` when there is nothing to retry.
    pub retry: Option<Retry>,
}

fn percent_of(progress: f64) -> u32 {
    // `Math.round`: halves up.
    (progress * 100.0 + 0.5).floor().clamp(0.0, 99.0) as u32
}

fn waiting_label(capture: CleanCutCapture) -> &'static str {
    if capture.streaming {
        "Waiting until you stop streaming"
    } else {
        "Waiting until you stop recording"
    }
}

/// `cleanCutStatusView`.
pub fn status_view(job: Option<&CleanCutJob>, capture: CleanCutCapture) -> StatusView {
    let base = |kind: StatusKind, label: &str| StatusView {
        kind,
        label: label.to_string(),
        detail: None,
        busy: false,
        percent: None,
        can_review: false,
        retry: None,
    };
    let Some(job) = job else {
        return base(StatusKind::None, "Not cut yet");
    };
    let has_cut_list = job.edl_summary.is_some();
    let working = |kind: StatusKind, label: &str| StatusView {
        busy: true,
        can_review: has_cut_list,
        ..base(kind, label)
    };
    match job.state {
        CleanCutJobState::Queued => {
            if capture.active {
                return working(StatusKind::Waiting, waiting_label(capture));
            }
            let label = if job.step.as_deref() == Some("render") {
                "Waiting to cut"
            } else {
                "Waiting to start"
            };
            working(StatusKind::Queued, label)
        }
        CleanCutJobState::Transcribing => {
            let percent = percent_of(job.progress);
            StatusView {
                percent: Some(percent),
                ..working(
                    StatusKind::Transcribing,
                    &format!("Transcribing {percent}%"),
                )
            }
        }
        CleanCutJobState::Analyzing => {
            let label = if job.step.as_deref() == Some("cut-list") {
                "Building the cut list"
            } else if job.mode == CleanCutMode::Condensed {
                "Picking the best parts"
            } else {
                "Finding retakes"
            };
            working(StatusKind::Analyzing, label)
        }
        // The cut list is built; the render waits for the maintenance slot.
        CleanCutJobState::Ready => {
            if capture.active {
                working(StatusKind::Waiting, waiting_label(capture))
            } else {
                working(StatusKind::Queued, "Waiting to cut")
            }
        }
        CleanCutJobState::Rendering => {
            let percent = percent_of(job.progress);
            StatusView {
                percent: Some(percent),
                ..working(StatusKind::Cutting, &format!("Cutting {percent}%"))
            }
        }
        CleanCutJobState::Validating => working(StatusKind::Checking, "Checking the cut"),
        CleanCutJobState::Completed => StatusView {
            detail: job
                .edl_summary
                .as_ref()
                .map(|summary| format!("{} · {}", durations_label(summary), saved_label(summary))),
            can_review: has_cut_list,
            ..base(StatusKind::Ready, "Ready")
        },
        CleanCutJobState::Failed => StatusView {
            detail: Some(failure_copy(
                job.error_code.as_deref(),
                job.error_message.as_deref(),
            )),
            can_review: has_cut_list,
            retry: Some(if has_cut_list {
                Retry::Render
            } else {
                Retry::Start
            }),
            ..base(StatusKind::Failed, "Failed")
        },
        CleanCutJobState::Cancelled => StatusView {
            retry: Some(Retry::Start),
            ..base(StatusKind::Cancelled, "Canceled")
        },
    }
}

/// The chip's tone: a spinner, a success icon or an alert icon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChipTone {
    Working,
    Ready,
    Failed,
}

/// `CleanCutRowChip`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowChip {
    /// "Transcribing 40%", "Cut ready", "Condensed ready", "Cut failed".
    pub label: String,
    pub tone: ChipTone,
}

/// `cleanCutRowChip`: the chip on a recording in the list, from its newest
/// cut in either mode, in the status row's words. `None` when there is
/// nothing to say: an uncut recording stays quiet.
pub fn row_chip(job: Option<&CleanCutJob>, capture: CleanCutCapture) -> Option<RowChip> {
    let status = status_view(job, capture);
    if status.busy {
        return Some(RowChip {
            label: status.label,
            tone: ChipTone::Working,
        });
    }
    match status.kind {
        StatusKind::Ready => Some(RowChip {
            label: if job.is_some_and(|job| job.mode == CleanCutMode::Condensed) {
                "Condensed ready".to_string()
            } else {
                "Cut ready".to_string()
            },
            tone: ChipTone::Ready,
        }),
        StatusKind::Failed => Some(RowChip {
            label: "Cut failed".to_string(),
            tone: ChipTone::Failed,
        }),
        _ => None,
    }
}

fn known_failure(code: &str) -> Option<&'static str> {
    Some(match code {
        "clean-cut-monthly-quota-exhausted" => {
            "This month's Clean cut minutes ran out. Retry next month; nothing done so far is lost."
        }
        "clean-cut-daily-quota-exhausted" => {
            "You made the most clean cuts for today. Retry tomorrow."
        }
        "clean-cut-disabled" => "Clean cut is paused on Videorc's side. Retry later.",
        "clean-cut-provider-unconfigured" => {
            "Clean cut isn't set up on Videorc's side yet. Retry later."
        }
        "premium-required" => "Clean cut needs Videorc Premium.",
        "signed-out" => "Sign in to Videorc, then retry.",
        "network" => "Videorc couldn't be reached. Retry when you're online.",
        "source-changed" => "The recording changed while it was being cut. Retry to start over.",
        "insufficient-space" => "There isn't enough free disk space for the cut copy.",
        "render-invalid" => {
            "The cut didn't pass its checks, so it wasn't saved. Retry to cut again."
        }
        "ffmpeg-unsupported" => "This computer's video encoder couldn't make the cut.",
        "file-missing" => "The recording file is missing.",
        "no-speech" => "No speech found, so there's nothing to cut.",
        "no-audio" => "This recording has no audio to transcribe.",
        _ => return None,
    })
}

const UNKNOWN_FAILURE: &str = "Clean cut stopped before it finished.";

/// `cleanCutFailureCopy`: known codes get our copy, anything else keeps the
/// server's message.
pub fn failure_copy(code: Option<&str>, message: Option<&str>) -> String {
    if let Some(known) = code.and_then(known_failure) {
        return known.to_string();
    }
    match message.map(str::trim) {
        Some(text) if !text.is_empty() => text.to_string(),
        _ => UNKNOWN_FAILURE.to_string(),
    }
}

/// `cleanCutErrorReason` (plan 174 S2.4): a failed call in plain words.
/// Clean cut's own codes keep their sentence; anything else gets the
/// generic next step, never raw text (the caller logs the raw text).
pub fn error_reason(error: &RpcError) -> String {
    if let Some(known) = known_failure(&error.code) {
        return known.to_string();
    }
    user_error_message(Failure::Rpc(error), None).description
}

/// `cleanCutUnavailableReason`: why the capability block says no.
pub fn unavailable_reason(reason_code: Option<&str>) -> String {
    let known = match reason_code {
        Some("disabled") => Some("Clean cut is paused on Videorc's side. Try again later."),
        Some("blocked") => Some("Cloud AI isn't available for this account."),
        Some("premium-required") => Some("Clean cut is part of Videorc Premium."),
        Some("provider-unconfigured") => {
            Some("Clean cut isn't set up on Videorc's side yet. Try again later.")
        }
        Some("quota-exhausted") => Some("This month's Clean cut minutes are used up."),
        _ => None,
    };
    if let Some(known) = known {
        return known.to_string();
    }
    match reason_code {
        Some(code) if !code.is_empty() => {
            format!("Clean cut isn't available right now ({code}).")
        }
        _ => "Clean cut isn't available right now.".to_string(),
    }
}

/// What unlocks Clean cut for this account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnlockAction {
    SignIn,
    ViewPremium { url: String },
}

/// `CleanCutUnlock`: the action and its one plain line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unlock {
    pub action: Option<UnlockAction>,
    pub reason: String,
}

/// `cleanCutUnlock`: the account first (sign in, then Premium), then the
/// server's capability block. Unknown capabilities block nothing: the
/// backend checks them again when a job starts.
pub fn unlock(
    signed_in: bool,
    gate: &EntitlementGate,
    capabilities: Option<&CleanCutCapabilities>,
) -> Option<Unlock> {
    if !signed_in {
        return Some(Unlock {
            action: Some(UnlockAction::SignIn),
            reason: CLEAN_CUT_SIGNED_OUT_REASON.to_string(),
        });
    }
    if let EntitlementGate::Locked {
        reason,
        upgrade_url,
        ..
    } = gate
    {
        return Some(Unlock {
            action: upgrade_url.map(|url| UnlockAction::ViewPremium {
                url: url.to_string(),
            }),
            reason: reason.clone(),
        });
    }
    let capabilities = capabilities?;
    if capabilities.available {
        return None;
    }
    let code = capabilities.reason_code.as_deref();
    if code == Some("premium-required") {
        return Some(Unlock {
            action: Some(UnlockAction::ViewPremium {
                url: VIDEORC_PREMIUM_URL.to_string(),
            }),
            reason: unavailable_reason(code),
        });
    }
    if !capabilities.supported && code.is_none() {
        return Some(Unlock {
            action: None,
            reason: "Clean cut isn't available yet.".to_string(),
        });
    }
    Some(Unlock {
        action: None,
        reason: unavailable_reason(code),
    })
}

/// `CleanCutAutoStatusKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoStatusKind {
    Off,
    On,
    Attention,
}

/// `CleanCutAutoStatus`: the line under "Make a clean cut of every
/// recording".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoStatus {
    pub kind: AutoStatusKind,
    pub label: &'static str,
    pub reason: Option<String>,
    /// The one fix the line offers: cloud AI consent, asked in its dialog.
    pub allow_cloud_ai: bool,
}

/// `cleanCutAutoStatus`.
pub fn auto_status(
    on: bool,
    unlock: Option<&Unlock>,
    consented: bool,
    capture_active: bool,
) -> AutoStatus {
    let status = |kind, label, reason: Option<String>, allow_cloud_ai| AutoStatus {
        kind,
        label,
        reason,
        allow_cloud_ai,
    };
    if !on {
        return status(AutoStatusKind::Off, "Off", None, false);
    }
    if let Some(unlock) = unlock {
        return status(
            AutoStatusKind::Attention,
            "Needs attention",
            Some(unlock.reason.clone()),
            false,
        );
    }
    if !consented {
        return status(
            AutoStatusKind::Attention,
            "Needs attention",
            Some(CLEAN_CUT_CONSENT_OFF_REASON.to_string()),
            true,
        );
    }
    let label = if capture_active {
        "On, cuts this recording when you stop"
    } else {
        "On, cuts every recording when you stop"
    };
    status(AutoStatusKind::On, label, None, false)
}

/// `cleanCutReadyTitle`: "Your clean cut is ready (42:10 → 31:05)".
pub fn ready_title(job: &CleanCutJob) -> String {
    let what = if job.mode == CleanCutMode::Condensed {
        "Your condensed cut is ready"
    } else {
        "Your clean cut is ready"
    };
    match &job.edl_summary {
        Some(summary) => format!("{what} ({})", durations_label(summary)),
        None => what.to_string(),
    }
}

/// `cleanCutModeLabel`.
pub fn mode_label(mode: CleanCutMode) -> &'static str {
    match mode {
        CleanCutMode::Condensed => "Condensed",
        CleanCutMode::Clean => "Clean cut",
    }
}

/// The Library's view of these rules ([`CleanCutRules`]).
#[derive(Debug, Clone, Copy, Default)]
pub struct Rules;

impl CleanCutRules for Rules {
    fn is_active(&self, job: &CleanCutJob) -> bool {
        is_job_active(job)
    }

    fn is_eligible(&self, session: &SessionListItem) -> bool {
        is_eligible(session)
    }

    fn status_label(&self, job: &CleanCutJob, capture: CleanCutCapture) -> String {
        status_view(Some(job), capture).label
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use videorc_protocol::FeatureId;

    use super::*;

    const MIN: i64 = 60_000;

    fn merge(mut base: Value, overrides: Value) -> Value {
        if let (Some(base), Some(overrides)) = (base.as_object_mut(), overrides.as_object()) {
            for (key, value) in overrides {
                if value.is_null() {
                    base.remove(key);
                } else {
                    base.insert(key.clone(), value.clone());
                }
            }
        }
        base
    }

    fn session(overrides: Value) -> SessionListItem {
        let base = json!({
            "id": "rec-1",
            "title": "Building a Rust CLI",
            "startedAt": "2026-10-03T14:02:00Z",
            "durationMs": 42 * MIN + 10_000,
            "status": "completed",
            "mode": "record",
            "mp4Path": "/videos/rust-cli.mp4",
            "finalizationState": "finalized",
            "healthEventCount": 0,
            "sessionLogCount": 0,
            "aiArtifactCount": 0,
            "commentCount": 0
        });
        serde_json::from_value(merge(base, overrides)).expect("session")
    }

    fn job(overrides: Value) -> CleanCutJob {
        let base = json!({
            "id": "job-1",
            "sourceSessionId": "rec-1",
            "mode": "clean",
            "state": "queued",
            "progress": 0,
            "edlRevision": 0,
            "createdAt": "2026-10-03T15:00:00Z",
            "updatedAt": "2026-10-03T15:00:00Z"
        });
        serde_json::from_value(merge(base, overrides)).expect("job")
    }

    fn summary() -> Value {
        json!({
            "durationMs": 42 * MIN + 10_000,
            "keptMs": 31 * MIN + 5_000,
            "removalCount": 63,
            "byKind": []
        })
    }

    fn summary_value() -> CleanCutEdlSummary {
        serde_json::from_value(summary()).expect("summary")
    }

    const IDLE: CleanCutCapture = CleanCutCapture {
        active: false,
        streaming: false,
    };

    fn basic() -> EntitlementGate {
        EntitlementGate::Locked {
            feature_id: FeatureId::CloudAi,
            reason: "Cloud AI requires Videorc Premium.".to_string(),
            upgrade_url: Some(VIDEORC_PREMIUM_URL),
            allow_fix_action: false,
        }
    }

    fn capabilities() -> CleanCutCapabilities {
        CleanCutCapabilities {
            supported: true,
            available: true,
            reason_code: None,
            monthly_seconds_limit: Some(72_000.0),
            remaining_seconds: Some(64_000.0),
        }
    }

    fn reason(overrides: Value) -> Option<&'static str> {
        eligibility(&session(overrides)).err()
    }

    #[test]
    fn sells_the_same_thing_as_the_website() {
        assert_eq!(
            CLEAN_CUT_DESCRIPTION,
            "Stop recording, and the edited version is already there. Silences, ums, and retakes removed, within a monthly allowance."
        );
        assert_eq!(CLEAN_CUT_AUTO_LABEL, "Make a clean cut of every recording");
    }

    #[test]
    fn keeps_every_line_plain() {
        for line in [
            CLEAN_CUT_DESCRIPTION.to_string(),
            CLEAN_CUT_AUTO_LABEL.to_string(),
            CLEAN_CUT_SIGNED_OUT_REASON.to_string(),
            CLEAN_CUT_CONSENT_OFF_REASON.to_string(),
            CLEAN_CUT_NO_RECORDINGS.to_string(),
            CONDENSED_TOO_SHORT.to_string(),
            failure_copy(Some("clean-cut-monthly-quota-exhausted"), None),
            unavailable_reason(Some("quota-exhausted")),
        ] {
            assert!(!line.contains('—'), "{line}");
            let lower = line.to_lowercase();
            assert!(
                !lower.contains("cohost") && !lower.contains("co-host"),
                "{line}"
            );
        }
    }

    #[test]
    fn reads_the_capability_block_loosely() {
        assert_eq!(clean_cut_capabilities(None), None);
        assert_eq!(clean_cut_capabilities(Some(&json!({}))), None);
        assert_eq!(
            clean_cut_capabilities(Some(&json!({
                "cleanCut": { "supported": true, "available": false, "reasonCode": "quota-exhausted" }
            }))),
            Some(CleanCutCapabilities {
                supported: true,
                available: false,
                reason_code: Some("quota-exhausted".to_string()),
                monthly_seconds_limit: None,
                remaining_seconds: None,
            })
        );
        assert_eq!(
            clean_cut_capabilities(Some(&json!({
                "cleanCut": { "supported": true, "available": true, "remainingSeconds": 64_000 }
            })))
            .and_then(|caps| caps.remaining_seconds),
            Some(64_000.0)
        );
    }

    #[test]
    fn accepts_a_finished_recording_with_its_mp4() {
        assert_eq!(eligibility(&session(json!({}))), Ok(()));
        assert!(is_eligible(&session(json!({ "mode": "record+stream" }))));
    }

    #[test]
    fn refuses_what_the_backend_refuses_with_a_plain_reason() {
        assert!(
            reason(json!({ "status": "running" }))
                .unwrap()
                .contains("once the recording has finished")
        );
        assert!(
            reason(json!({ "finalizationState": "finalizing" }))
                .unwrap()
                .contains("once the recording has finished")
        );
        assert_eq!(
            reason(json!({ "mode": "imported" })),
            Some("Imported videos aren't supported yet.")
        );
        for derived in [
            json!({ "derivedFromSessionId": "rec-0" }),
            json!({ "cleanCutOfSessionId": "rec-0" }),
            json!({ "processingKind": "noise-cleanup" }),
        ] {
            assert!(reason(derived).unwrap().contains("can't be cut again"));
        }
        assert!(
            reason(json!({ "mode": "stream", "mp4Path": null }))
                .unwrap()
                .contains("Only recordings")
        );
        assert!(
            reason(json!({ "durationMs": 9_999 }))
                .unwrap()
                .contains("shorter than 10 seconds")
        );
        assert!(
            reason(json!({ "durationMs": null }))
                .unwrap()
                .contains("shorter than 10 seconds")
        );
        assert!(
            reason(json!({ "mp4Path": null }))
                .unwrap()
                .contains("MP4 file is missing")
        );
        assert!(
            reason(json!({ "mp4Path": "/videos/rust-cli.mkv" }))
                .unwrap()
                .contains("MP4 file is missing")
        );
    }

    #[test]
    fn offers_condensed_from_25_minutes() {
        assert!(condensed_eligibility(&session(json!({ "durationMs": 25 * MIN }))).is_ok());
        assert_eq!(
            condensed_eligibility(&session(json!({ "durationMs": 25 * MIN - 1 }))),
            Err(CONDENSED_TOO_SHORT)
        );
        assert!(
            condensed_eligibility(&session(
                json!({ "mode": "imported", "durationMs": 60 * MIN })
            ))
            .is_err()
        );
    }

    #[test]
    fn lists_eligible_recordings_newest_first_within_the_limit() {
        let rows = [
            session(json!({ "id": "old", "startedAt": "2026-10-01T10:00:00Z" })),
            session(
                json!({ "id": "stream-only", "mode": "stream", "startedAt": "2026-10-04T10:00:00Z" }),
            ),
            session(json!({ "id": "new", "startedAt": "2026-10-03T10:00:00Z" })),
            session(
                json!({ "id": "short", "durationMs": 5_000, "startedAt": "2026-10-03T11:00:00Z" }),
            ),
        ];
        let ids = |limit| {
            recent_recordings(&rows, limit)
                .iter()
                .map(|row| row.id.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(CLEAN_CUT_PICKER_LIMIT), ["new", "old"]);
        assert_eq!(ids(1), ["new"]);
    }

    #[test]
    fn searches_by_title_or_when_it_ran_case_insensitive() {
        let rust = session(json!({ "id": "rust", "title": "Building a Rust CLI" }));
        let auto = session(json!({
            "id": "auto",
            "title": "Session 2026-10-08 19:42",
            "startedAt": "2026-10-08T17:42:00Z"
        }));
        let rows = [&rust, &auto];
        let ids = |query| {
            match_recordings(&rows, query)
                .iter()
                .map(|row| row.id.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids("  "), ["rust", "auto"]);
        assert_eq!(ids("rust"), ["rust"]);
        assert_eq!(ids("10-08"), ["auto"]);
        assert!(ids("nope").is_empty());
    }

    #[test]
    fn says_a_rows_length_and_when_it_ran() {
        assert!(recording_facts(&session(json!({}))).starts_with("42:10 · "));
        assert_eq!(
            recording_facts(&session(json!({ "title": "Session 2026-10-03 16:02" }))),
            "42:10"
        );
        assert_eq!(
            recording_facts(&session(
                json!({ "title": "Session 2026-10-03 16:02", "durationMs": null })
            )),
            ""
        );
    }

    #[test]
    fn sends_the_condensed_target_in_seconds_inside_the_contract_range() {
        assert_eq!(CONDENSED_TARGET_MINUTES, [10, 15, 20, 30]);
        assert_eq!(condensed_target_seconds(15), 900);
        assert_eq!(condensed_target_seconds(1), 120);
        assert_eq!(condensed_target_seconds(90), 3_600);
    }

    #[test]
    fn chips_a_recordings_newest_cut_and_stays_quiet_without_one() {
        let jobs = [
            job(json!({ "id": "clean", "mode": "clean", "createdAt": "2026-10-03T15:00:00Z" })),
            job(
                json!({ "id": "condensed", "mode": "condensed", "createdAt": "2026-10-03T16:00:00Z" }),
            ),
        ];
        assert_eq!(
            latest_job_any_mode(&jobs, "rec-1").map(|job| job.id.as_str()),
            Some("condensed")
        );
        assert_eq!(latest_job_any_mode(&jobs, "rec-2"), None);
        assert_eq!(row_chip(None, IDLE), None);
        assert_eq!(
            row_chip(Some(&job(json!({ "state": "cancelled" }))), IDLE),
            None
        );
        let chip = |overrides: Value, capture| row_chip(Some(&job(overrides)), capture);
        assert_eq!(
            chip(json!({ "state": "completed" }), IDLE),
            Some(RowChip {
                label: "Cut ready".into(),
                tone: ChipTone::Ready
            })
        );
        assert_eq!(
            chip(json!({ "state": "completed", "mode": "condensed" }), IDLE),
            Some(RowChip {
                label: "Condensed ready".into(),
                tone: ChipTone::Ready
            })
        );
        assert_eq!(
            chip(json!({ "state": "failed" }), IDLE),
            Some(RowChip {
                label: "Cut failed".into(),
                tone: ChipTone::Failed
            })
        );
        assert_eq!(
            chip(json!({ "state": "rendering", "progress": 0.4 }), IDLE),
            Some(RowChip {
                label: "Cutting 40%".into(),
                tone: ChipTone::Working
            })
        );
        assert_eq!(
            chip(
                json!({ "state": "queued" }),
                CleanCutCapture {
                    active: true,
                    streaming: false
                }
            ),
            Some(RowChip {
                label: "Waiting until you stop recording".into(),
                tone: ChipTone::Working
            })
        );
    }

    #[test]
    fn keeps_one_entry_per_job_and_never_goes_back() {
        let queued = job(json!({}));
        let transcribing =
            job(json!({ "state": "transcribing", "updatedAt": "2026-10-03T15:01:00Z" }));
        assert_eq!(upsert_job(&[], queued.clone()), [queued.clone()]);
        assert_eq!(
            upsert_job(std::slice::from_ref(&queued), transcribing.clone()),
            [transcribing.clone()]
        );
        assert_eq!(
            upsert_job(std::slice::from_ref(&transcribing), queued.clone()),
            [transcribing]
        );
        let other = job(json!({ "id": "job-2" }));
        assert_eq!(
            upsert_job(std::slice::from_ref(&queued), other.clone()),
            [other, queued]
        );
    }

    #[test]
    fn finds_the_newest_job_of_a_recording_and_mode() {
        let jobs = [
            job(json!({ "id": "a", "createdAt": "2026-10-01T00:00:00Z" })),
            job(json!({ "id": "c", "mode": "condensed", "createdAt": "2026-10-03T00:00:00Z" })),
            job(json!({ "id": "b", "createdAt": "2026-10-02T00:00:00Z" })),
            job(json!({ "id": "d", "sourceSessionId": "rec-2" })),
        ];
        let id = |session: &str, mode| latest_job(&jobs, session, mode).map(|job| job.id.clone());
        assert_eq!(id("rec-1", CleanCutMode::Clean).as_deref(), Some("b"));
        assert_eq!(id("rec-1", CleanCutMode::Condensed).as_deref(), Some("c"));
        assert_eq!(id("rec-9", CleanCutMode::Clean), None);
    }

    #[test]
    fn knows_which_states_a_worker_owns_and_which_accept_edits() {
        let state = |state: &str| job(json!({ "state": state }));
        assert!(is_job_active(&state("rendering")));
        assert!(!is_job_active(&state("completed")));
        assert!(job_editable(&state("ready")));
        assert!(job_editable(&state("completed")));
        assert!(job_editable(&state("failed")));
        assert!(!job_editable(&state("rendering")));
        assert!(!job_editable(&state("validating")));
    }

    #[test]
    fn reads_like_the_clip_marks() {
        assert_eq!(format_cut_clock(42 * MIN + 10_000), "42:10");
        assert_eq!(format_cut_clock(62 * MIN + 10_000), "1:02:10");
        assert_eq!(format_cut_clock(-5), "0:00");
        assert_eq!(durations_label(&summary_value()), "42:10 → 31:05");
        assert_eq!(saved_label(&summary_value()), "11:05 shorter");
    }

    #[test]
    fn saves_the_difference_of_the_two_clocks() {
        // 42:10.000 → 31:05.640 shows 31:05, so it saves 11:05, not 11:04.
        assert_eq!(saved_ms(2_530_000, 1_865_640), 665_000);
        assert_eq!(clock(saved_ms(2_530_000, 1_865_640)), "11:05");
        assert_eq!(saved_ms(1_000, 2_000), 0);
    }

    #[test]
    fn says_the_minutes_left_this_month_or_nothing_when_unlimited() {
        assert_eq!(minutes_left_label(None), None);
        let with = |remaining| CleanCutCapabilities {
            remaining_seconds: remaining,
            ..capabilities()
        };
        assert_eq!(minutes_left_label(Some(&with(None))), None);
        assert_eq!(
            minutes_left_label(Some(&with(Some(64_000.0)))).as_deref(),
            Some("1,066 min left this month")
        );
        assert_eq!(
            minutes_left_label(Some(&with(Some(0.0)))).as_deref(),
            Some("No minutes left this month")
        );
    }

    #[test]
    fn says_what_a_recording_without_a_cut_can_do() {
        let view = status_view(None, IDLE);
        assert_eq!(view.kind, StatusKind::None);
        assert_eq!(view.label, "Not cut yet");
        assert!(!view.busy);
        assert_eq!(view.retry, None);
    }

    #[test]
    fn waits_for_the_capture_to_end_before_any_heavy_work() {
        let on_air = CleanCutCapture {
            active: true,
            streaming: true,
        };
        let recording = CleanCutCapture {
            active: true,
            streaming: false,
        };
        assert_eq!(
            status_view(Some(&job(json!({}))), on_air).label,
            "Waiting until you stop streaming"
        );
        assert_eq!(
            status_view(Some(&job(json!({}))), recording).label,
            "Waiting until you stop recording"
        );
        assert_eq!(
            status_view(
                Some(&job(json!({ "state": "ready", "edlSummary": summary() }))),
                on_air
            )
            .kind,
            StatusKind::Waiting
        );
    }

    #[test]
    fn names_each_step_with_progress_where_there_is_one() {
        let view = |overrides: Value| status_view(Some(&job(overrides)), IDLE);
        assert_eq!(view(json!({})).label, "Waiting to start");
        assert_eq!(
            view(json!({ "step": "render", "edlSummary": summary() })).label,
            "Waiting to cut"
        );
        let transcribing = view(json!({ "state": "transcribing", "progress": 0.4 }));
        assert_eq!(transcribing.kind, StatusKind::Transcribing);
        assert_eq!(transcribing.label, "Transcribing 40%");
        assert_eq!(transcribing.percent, Some(40));
        assert!(transcribing.busy);
        assert_eq!(
            view(json!({ "state": "analyzing", "step": "analyze" })).label,
            "Finding retakes"
        );
        assert_eq!(
            view(json!({ "state": "analyzing", "step": "analyze", "mode": "condensed" })).label,
            "Picking the best parts"
        );
        assert_eq!(
            view(json!({ "state": "analyzing", "step": "cut-list" })).label,
            "Building the cut list"
        );
        let ready = view(json!({ "state": "ready", "edlSummary": summary() }));
        assert_eq!(ready.label, "Waiting to cut");
        assert!(ready.can_review);
        let cutting =
            view(json!({ "state": "rendering", "progress": 0.63, "edlSummary": summary() }));
        assert_eq!(cutting.kind, StatusKind::Cutting);
        assert_eq!(cutting.label, "Cutting 63%");
        assert_eq!(cutting.percent, Some(63));
        assert!(cutting.can_review);
        assert_eq!(
            view(json!({ "state": "validating", "edlSummary": summary() })).label,
            "Checking the cut"
        );
    }

    #[test]
    fn shows_a_finished_cut_as_original_to_cut_and_what_it_saved() {
        let view = status_view(
            Some(&job(json!({
                "state": "completed",
                "edlSummary": summary(),
                "outputSessionId": "out-1"
            }))),
            IDLE,
        );
        assert_eq!(view.kind, StatusKind::Ready);
        assert_eq!(view.label, "Ready");
        assert_eq!(
            view.detail.as_deref(),
            Some("42:10 → 31:05 · 11:05 shorter")
        );
        assert!(!view.busy);
        assert!(view.can_review);
        assert_eq!(view.retry, None);
    }

    #[test]
    fn retries_a_failed_render_by_cutting_again_and_an_earlier_failure_by_starting_over() {
        let render = status_view(
            Some(&job(json!({
                "state": "failed",
                "edlSummary": summary(),
                "errorCode": "render-invalid",
                "errorMessage": "x"
            }))),
            IDLE,
        );
        assert_eq!(render.kind, StatusKind::Failed);
        assert_eq!(render.retry, Some(Retry::Render));
        assert!(render.can_review);
        let start = status_view(
            Some(&job(json!({
                "state": "failed",
                "errorCode": "clean-cut-monthly-quota-exhausted",
                "errorMessage": "Quota."
            }))),
            IDLE,
        );
        assert_eq!(start.retry, Some(Retry::Start));
        assert!(!start.can_review);
        assert_eq!(
            start.detail.as_deref(),
            Some(
                "This month's Clean cut minutes ran out. Retry next month; nothing done so far is lost."
            )
        );
        let cancelled = status_view(Some(&job(json!({ "state": "cancelled" }))), IDLE);
        assert_eq!(cancelled.kind, StatusKind::Cancelled);
        assert_eq!(cancelled.retry, Some(Retry::Start));
    }

    #[test]
    fn maps_known_codes_to_plain_words_and_keeps_the_server_message_otherwise() {
        assert_eq!(
            failure_copy(Some("clean-cut-daily-quota-exhausted"), Some("x")),
            "You made the most clean cuts for today. Retry tomorrow."
        );
        assert_eq!(
            failure_copy(Some("network"), Some("socket hang up")),
            "Videorc couldn't be reached. Retry when you're online."
        );
        assert_eq!(
            failure_copy(Some("insufficient-space"), None),
            "There isn't enough free disk space for the cut copy."
        );
        assert_eq!(
            failure_copy(Some("some-new-code"), Some("The server said why.")),
            "The server said why."
        );
        assert_eq!(
            failure_copy(None, Some("   ")),
            "Clean cut stopped before it finished."
        );
    }

    #[test]
    fn asks_to_sign_in_first_then_for_premium() {
        assert_eq!(
            unlock(false, &basic(), None),
            Some(Unlock {
                action: Some(UnlockAction::SignIn),
                reason: CLEAN_CUT_SIGNED_OUT_REASON.to_string()
            })
        );
        assert_eq!(
            unlock(true, &basic(), None),
            Some(Unlock {
                action: Some(UnlockAction::ViewPremium {
                    url: "https://www.videorc.com/premium".to_string()
                }),
                reason: "Cloud AI requires Videorc Premium.".to_string()
            })
        );
    }

    #[test]
    fn blocks_nothing_while_the_capability_block_is_unknown_or_available() {
        assert_eq!(unlock(true, &EntitlementGate::Allowed, None), None);
        assert_eq!(
            unlock(true, &EntitlementGate::Allowed, Some(&capabilities())),
            None
        );
    }

    #[test]
    fn says_why_the_server_cant_offer_it() {
        let unavailable = |supported, code: Option<&str>| CleanCutCapabilities {
            supported,
            available: false,
            reason_code: code.map(str::to_string),
            ..capabilities()
        };
        assert_eq!(
            unlock(
                true,
                &EntitlementGate::Allowed,
                Some(&unavailable(true, Some("quota-exhausted")))
            ),
            Some(Unlock {
                action: None,
                reason: "This month's Clean cut minutes are used up.".to_string()
            })
        );
        let premium = unlock(
            true,
            &EntitlementGate::Allowed,
            Some(&unavailable(true, Some("premium-required"))),
        )
        .and_then(|unlock| unlock.action);
        assert!(
            matches!(premium, Some(UnlockAction::ViewPremium { url }) if url.contains("/premium"))
        );
        assert_eq!(
            unlock(
                true,
                &EntitlementGate::Allowed,
                Some(&unavailable(false, None))
            )
            .map(|unlock| unlock.reason)
            .as_deref(),
            Some("Clean cut isn't available yet.")
        );
        assert_eq!(
            unavailable_reason(Some("brand-new")),
            "Clean cut isn't available right now (brand-new)."
        );
    }

    #[test]
    fn auto_status_is_off_on_or_needs_attention_with_the_reason() {
        assert_eq!(
            auto_status(false, None, true, false),
            AutoStatus {
                kind: AutoStatusKind::Off,
                label: "Off",
                reason: None,
                allow_cloud_ai: false
            }
        );
        assert_eq!(
            auto_status(true, None, true, false).label,
            "On, cuts every recording when you stop"
        );
        assert_eq!(
            auto_status(true, None, true, true).label,
            "On, cuts this recording when you stop"
        );
        // Plan 174 E-6: the line offers its fix, never a pointer to a retired tab.
        assert_eq!(
            auto_status(true, None, false, false),
            AutoStatus {
                kind: AutoStatusKind::Attention,
                label: "Needs attention",
                reason: Some(CLEAN_CUT_CONSENT_OFF_REASON.to_string()),
                allow_cloud_ai: true
            }
        );
        assert_eq!(
            CLEAN_CUT_CONSENT_OFF_REASON,
            "Cloud AI isn't allowed, so Clean cut can't run."
        );
        let paused = Unlock {
            action: None,
            reason: "Paused.".to_string(),
        };
        assert_eq!(
            auto_status(true, Some(&paused), true, false)
                .reason
                .as_deref(),
            Some("Paused.")
        );
    }

    #[test]
    fn ready_title_names_the_cut_and_its_two_lengths() {
        assert_eq!(
            ready_title(&job(json!({ "mode": "clean", "edlSummary": summary() }))),
            "Your clean cut is ready (42:10 → 31:05)"
        );
        assert_eq!(
            ready_title(&job(
                json!({ "mode": "condensed", "edlSummary": summary() })
            )),
            "Your condensed cut is ready (42:10 → 31:05)"
        );
        assert_eq!(
            ready_title(&job(json!({ "mode": "clean" }))),
            "Your clean cut is ready"
        );
    }

    #[test]
    fn downloaded_cloud_takes_use_existing_clean_cut_eligibility() {
        assert!(is_eligible(&session(json!({ "mode": "cloud-recording" }))));
        assert!(!is_eligible(&session(
            json!({ "mode": "cloud-recording", "mp4Path": null })
        )));
    }

    #[test]
    fn the_consent_dialog_leads_with_clean_cuts_own_use() {
        let (lead, others) = consent_uses();
        assert!(lead.starts_with("Clean cut uploads a recording's audio, never the video"));
        assert_eq!(others.len(), 5);
        assert!(!others.contains(&lead));
        let start = ConsentAsk::Start {
            session_id: "rec-1".into(),
            mode: CleanCutMode::Clean,
            target_minutes: CONDENSED_DEFAULT_TARGET_MINUTES,
        };
        assert_eq!(consent_title(&ConsentAsk::Auto), "Turn on Clean cut?");
        assert_eq!(consent_title(&start), "Make a clean cut?");
        assert_eq!(consent_accept(&ConsentAsk::Auto), "Allow and turn on");
        assert_eq!(consent_accept(&start), "Allow and make it");
    }
}
