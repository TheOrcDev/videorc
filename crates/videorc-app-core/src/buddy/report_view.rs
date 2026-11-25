//! Sidekick → Reports (`lib/buddy-report-view.ts`, plan 119 S3): what
//! Sidekick caught in one stream, from `cohost.report.get` /
//! `cohost.report.latest`. Everything here is a pure derivation of that
//! payload and the Library's session row, so the card and its tests cannot
//! disagree about a count. The card's own words (`buddy-report-card.tsx`,
//! `hooks/use-buddy-report.ts`) live here too.

use chrono::DateTime;
use serde::Deserialize;
use videorc_protocol::cohost::{CohostAlertKind, CohostPriority, CohostUtteranceTriggerKind};
use videorc_protocol::community::{ViewerMilestone, ViewerMilestoneKind};
use videorc_protocol::streaming::StreamPlatform;
use videorc_protocol::{
    ClipMoment, ClipMomentSource, CohostReportChat, CohostReportCommands, CohostReportCommunity,
    CohostReportGreetingsSkipped, CohostReportPayload, CohostReportPostResult,
    CohostReportPostSource, CohostReportQuestion, CohostReportQuestionOutcome,
    CohostReportQuestions, CohostSessionReport,
};

use super::chat::display_name;
use super::moments::{CHAT_LABEL, MANUAL_LABEL, VOICE_LABEL};
use crate::chat::arrival::ordinal;
use crate::chat::view::platform_label;
use crate::format::{day_label, duration_ms_label, format_timecode, grouped};
use crate::stream_manager::buddy::askers_label;

/// `BUDDY_REPORT_DESCRIPTION`: the website's line for the report, word for
/// word (plan 119 S5).
pub const DESCRIPTION: &str = "Sidekick saves a short report on your computer: questions caught and missed, flags, promises, first-timers greeted, and the moments you marked by saying clip that.";
/// `BUDDY_REPORT_EMPTY`.
pub const EMPTY: &str = "The report appears here after your first stream with Sidekick.";
/// `BUDDY_REPORT_OFF`.
pub const OFF: &str = "Sidekick was off for this stream.";
/// `BUDDY_REPORT_TURN_ON`.
pub const TURN_ON: &str = "Turn on Sidekick to also catch questions.";
/// `BUDDY_REPORT_NEXT_STREAM`.
pub const NEXT_STREAM: &str = "It joins your next stream.";
/// `BUDDY_REPORT_UNTITLED`.
pub const UNTITLED: &str = "Untitled stream";
/// `BUDDY_REPORT_EMPTY_TITLE`: the empty Reports tab's heading (plan 150).
pub const EMPTY_TITLE: &str = "No stream reports yet";
/// `BUDDY_REPORT_READ_ERROR` (`use-buddy-report.ts`).
pub const READ_ERROR: &str = "Couldn't read this report.";
/// `REPORT_SUMMARY_LOCK_REASON`: why the audience summary is locked
/// (plan 225 D15, Premium D6).
pub const SUMMARY_LOCK_REASON: &str =
    "Sidekick writes two sentences about your audience with Premium.";

// The card's words (`buddy-report-card.tsx`).
pub const STREAM_REPORT: &str = "Stream report";
pub const MARKERS: &str = "Markers";
/// The picker's accessible name, and its words with no stream chosen.
pub const STREAM: &str = "Stream";
pub const LOADING: &str = "Loading the report…";
pub const TRY_AGAIN: &str = "Try again";
pub const COMMUNITY: &str = "Community";
pub const COMMANDS: &str = "Commands";
pub const SAID_ON_STREAM: &str = "Said on stream";
pub const POSTED_AS_YOU: &str = "Posted as you";
pub const MISSED_QUESTIONS: &str = "Missed questions";
pub const OPEN_PROMISES: &str = "Open promises";
pub const MOMENTS: &str = "Moments";
pub const ALERTS: &str = "Alerts";
pub const REGULARS_BACK: &str = "Regulars back";
pub const MILESTONES: &str = "Milestones";
/// A missed question's priority tag.
pub const HIGH: &str = "High";
pub const SHOW_FEWER: &str = "Show fewer";

/// "Show all 8".
pub fn show_all(count: usize) -> String {
    format!("Show all {count}")
}

/// A capped list's heading: "Moments · 8".
pub fn list_label(label: &str, count: usize) -> String {
    format!("{label} · {count}")
}

/// `BUDDY_REPORT_LIST_CAP`: rows a list shows before "Show all".
pub const LIST_CAP: usize = 5;
/// `BUDDY_REPORT_SWITCHER_LIMIT`: streams the switcher offers, newest first.
pub const SWITCHER_LIMIT: usize = 20;

/// `formatReportCount`: a whole count with thousands separators.
pub fn format_report_count(value: u64) -> String {
    grouped(i64::try_from(value).unwrap_or(i64::MAX))
}

/// The wire id of a platform (`StreamPlatform`'s kebab-case name).
pub fn platform_id(platform: StreamPlatform) -> &'static str {
    match platform {
        StreamPlatform::Youtube => "youtube",
        StreamPlatform::Twitch => "twitch",
        StreamPlatform::Kick => "kick",
        StreamPlatform::X => "x",
        StreamPlatform::Facebook => "facebook",
        StreamPlatform::Tiktok => "tiktok",
        StreamPlatform::Instagram => "instagram",
        StreamPlatform::Custom => "custom",
    }
}

/// `BuddyReportStat`: a number over its label; `of` is the whole it is out
/// of ("of 3 first-timers"), shown muted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stat {
    pub id: &'static str,
    pub value: String,
    pub of: Option<String>,
    pub label: &'static str,
}

/// `BuddyReportPlatform`: one platform's chat count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformCount {
    pub platform: StreamPlatform,
    pub messages: u64,
    /// "Twitch: 60 messages", for the icon's tooltip and screen readers.
    pub label: String,
}

/// `BuddyReportChatView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatView {
    pub messages: u64,
    /// "84 chat messages", "No chat messages".
    pub label: String,
    /// Busiest first, one entry per platform.
    pub platforms: Vec<PlatformCount>,
}

/// `BuddyReportQuestionRow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionRow {
    pub id: String,
    pub text: String,
    /// "Ada +2", empty when nobody was named.
    pub askers: String,
    /// Every name, for the tooltip.
    pub askers_title: String,
    pub platforms: Vec<StreamPlatform>,
    pub high: bool,
    /// Time into the stream ("12:04"), or none when unknown.
    pub at: Option<String>,
}

/// `BuddyReportPromiseRow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromiseRow {
    pub key: String,
    pub text: String,
    pub at: Option<String>,
}

/// `BuddyReportMomentRow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MomentRow {
    pub key: String,
    pub kind: ClipMomentSource,
    pub label: String,
    pub excerpt: String,
    /// "4:35–5:12" in recording time.
    pub range: String,
}

/// `BuddyReportAlertRow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlertRow {
    pub key: String,
    pub kind: CohostAlertKind,
    pub label: &'static str,
    /// "3 viewers": the most who said it at once.
    pub viewers: String,
    pub at: Option<String>,
}

/// `BuddyReportSessionOption`: one stream the switcher offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionOption {
    pub id: String,
    pub title: String,
    /// The session's start, as Library shows it.
    pub date: String,
}

/// `BuddyReportCommandCount`: one count of the "Commands" row (plan 140 S3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandCount {
    pub id: &'static str,
    pub value: String,
    pub label: &'static str,
}

/// `BuddyReportCommandsView`: what voice commands did, counts only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandsView {
    /// "6 commands", "1 command".
    pub total: String,
    /// The non-zero counts, in a fixed order.
    pub counts: Vec<CommandCount>,
}

/// `BuddyReportPostRow`: one line Sidekick posted as you (plan 164 D10).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostRow {
    pub id: String,
    pub trigger: &'static str,
    pub text: String,
    pub platforms: Vec<StreamPlatform>,
    pub result: CohostReportPostResult,
    pub result_label: &'static str,
    pub at: Option<String>,
    /// Plan 192 S2.2: who wrote a greeting, "AI" or "Line"; none when the
    /// report doesn't say (other posts, older reports).
    pub source: Option<&'static str>,
}

/// `BuddyReportSaidRow`: one line Sidekick said in its bubble on stream
/// (plan 211 D11). A post's row without platforms or a result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaidRow {
    pub id: String,
    pub trigger: &'static str,
    pub text: String,
    pub at: Option<String>,
    /// Greetings only: "AI" or "Line"; none when the report doesn't say.
    pub source: Option<&'static str>,
}

/// `BuddyReportGreetingSkipsView` (plan 192 D7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GreetingSkipsView {
    /// How many were skipped, all reasons together ("3"). Held greetings
    /// are not counted: they wait their turn and go out later.
    pub total: String,
    /// "Greetings skipped: 3 had no line. 2 greetings waited their turn."
    pub sentence: String,
}

/// One regular the Community block names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegularRow {
    pub key: String,
    pub name: String,
    pub platforms: Vec<StreamPlatform>,
    pub streams: String,
}

/// One milestone the Community block names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MilestoneRow {
    pub key: String,
    pub name: String,
    pub platform: StreamPlatform,
    pub label: String,
}

/// `BuddyReportCommunityView` (plan 225 D15): the Community block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommunityView {
    /// Regulars who chatted this stream (the D10 offer needs to know).
    pub regulars_back: u32,
    pub stats: Vec<Stat>,
    /// "1 new regular · 1 link made · 1 opt-out"; none when all are zero.
    pub line: Option<String>,
    pub regulars: Vec<RegularRow>,
    pub milestones: Vec<MilestoneRow>,
    /// Premium's two sentences; none until the memory pass writes them.
    pub summary: Option<String>,
}

/// Why nothing was caught, and what to do about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub title: &'static str,
    pub hint: &'static str,
}

/// `kind: 'report' | 'buddy-off'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShownKind {
    Report,
    /// The stream left chat and moments, but no report.
    BuddyOff,
}

/// A stream the card can show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShownReport {
    pub kind: ShownKind,
    pub session_id: String,
    pub title: String,
    pub date: Option<String>,
    pub duration: Option<String>,
    pub chat: ChatView,
    /// Empty when Sidekick was off.
    pub stats: Vec<Stat>,
    /// Sidekick-off only.
    pub note: Option<Note>,
    pub missed: Vec<QuestionRow>,
    pub promises: Vec<PromiseRow>,
    pub moments: Vec<MomentRow>,
    pub alerts: Vec<AlertRow>,
    /// Plan 140 S3: none when no voice command was counted (or Sidekick was off).
    pub commands: Option<CommandsView>,
    /// Plan 211 D11: what Sidekick said in its bubble, oldest first.
    pub said: Vec<SaidRow>,
    /// Plan 164 D10: what Sidekick posted as you, oldest first.
    pub posts: Vec<PostRow>,
    /// Plan 192 D7: none when every greeting went out (or Sidekick was off).
    pub greeting_skips: Option<GreetingSkipsView>,
    /// Plan 225 D15: who came; none for an older report or an empty stream.
    pub community: Option<CommunityView>,
}

/// `BuddyReportView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReportView {
    Empty { message: &'static str },
    Shown(Box<ShownReport>),
}

/// The Library row the switcher and the card read (`SessionSummary`'s
/// `id`, `title`, `startedAt`, `durationMs`, `mode` and `status`), from
/// `sessions.list`'s items.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReportSession {
    pub id: String,
    pub title: String,
    pub started_at: String,
    pub duration_ms: Option<i64>,
    pub mode: String,
    pub status: String,
}

/// `BuddyReportViewInput`.
#[derive(Debug, Clone, Copy)]
pub struct ReportViewInput<'a> {
    /// The backend's answer; none when no stream exists yet.
    pub payload: Option<&'a CohostReportPayload>,
    /// The Library row of the payload's session, when the loaded list has it.
    pub session: Option<&'a ReportSession>,
    /// Sidekick Live's stored switch, for what the Sidekick-off note asks for.
    pub buddy_on: bool,
    /// The streamer's name for the avatar, for the skip line.
    pub name: Option<&'a str>,
}

// --- Questions ---------------------------------------------------------------

/// `BuddyQuestionTally`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuestionTally {
    pub caught: u64,
    pub answered_on_air: u64,
    pub replied: u64,
    pub missed: u64,
}

/// `questionTally`: while the log holds every question its outcomes are the
/// truth (a restore undoes an answer, a counter cannot); past its cap the
/// counters decide. Missed means still open at the end.
pub fn question_tally(questions: &CohostReportQuestions) -> QuestionTally {
    let outcomes = |outcome: CohostReportQuestionOutcome| -> u64 {
        questions
            .items
            .iter()
            .filter(|item| item.outcome == outcome)
            .count() as u64
    };
    if questions.items.len() as u64 >= questions.total {
        return QuestionTally {
            caught: questions.items.len() as u64,
            answered_on_air: outcomes(CohostReportQuestionOutcome::AnsweredOnAir),
            replied: outcomes(CohostReportQuestionOutcome::Replied),
            missed: outcomes(CohostReportQuestionOutcome::Open),
        };
    }
    let signed = |value: u64| i64::try_from(value).unwrap_or(i64::MAX);
    let closed = signed(questions.answered_on_air)
        .saturating_add(signed(questions.replied))
        .saturating_add(signed(questions.marked_answered))
        .saturating_add(signed(questions.dismissed))
        .saturating_add(signed(questions.shown_on_stream))
        .saturating_sub(signed(questions.restored));
    let total = signed(questions.total);
    let unanswered = total.saturating_sub(closed).clamp(0, total);
    QuestionTally {
        caught: questions.total,
        answered_on_air: questions.answered_on_air,
        replied: questions.replied,
        missed: outcomes(CohostReportQuestionOutcome::Open).max(unanswered.unsigned_abs()),
    }
}

/// `missedQuestions`: the questions still open at the end, first seen first.
pub fn missed_questions(questions: &CohostReportQuestions) -> Vec<&CohostReportQuestion> {
    questions
        .items
        .iter()
        .filter(|item| item.outcome == CohostReportQuestionOutcome::Open)
        .collect()
}

fn unique_platforms(platforms: &[StreamPlatform]) -> Vec<StreamPlatform> {
    let mut unique = Vec::with_capacity(platforms.len());
    for platform in platforms {
        if !unique.contains(platform) {
            unique.push(*platform);
        }
    }
    unique
}

// --- Chat --------------------------------------------------------------------

/// `chatMessagesLabel`.
pub fn chat_messages_label(messages: u64) -> String {
    match messages {
        0 => "No chat messages".into(),
        1 => "1 chat message".into(),
        _ => format!("{} chat messages", format_report_count(messages)),
    }
}

/// `reportPlatforms`: one entry per platform (an older backend could repeat
/// one), busiest first, platforms without a message left out.
pub fn report_platforms(chat: &CohostReportChat) -> Vec<PlatformCount> {
    let mut totals: Vec<(StreamPlatform, u64)> = Vec::new();
    for entry in &chat.by_platform {
        match totals
            .iter_mut()
            .find(|(platform, _)| *platform == entry.platform)
        {
            Some((_, total)) => *total = total.saturating_add(entry.messages),
            None => totals.push((entry.platform, entry.messages)),
        }
    }
    totals.retain(|(_, messages)| *messages > 0);
    totals.sort_by(|(left, a), (right, b)| {
        b.cmp(a)
            .then_with(|| platform_id(*left).cmp(platform_id(*right)))
    });
    totals
        .into_iter()
        .map(|(platform, messages)| PlatformCount {
            platform,
            messages,
            label: format!(
                "{}: {}",
                platform_label(platform_id(platform)),
                if messages == 1 {
                    "1 message".to_string()
                } else {
                    format!("{} messages", format_report_count(messages))
                }
            ),
        })
        .collect()
}

// --- Moments -----------------------------------------------------------------

/// `momentKind`: an older backend omits the source; that moment is a chat peak.
pub fn moment_kind(moment: &ClipMoment) -> ClipMomentSource {
    moment.source.unwrap_or(ClipMomentSource::Chat)
}

/// `momentLabel`: marks say who placed them; a chat peak keeps the
/// backend's reason. A voice mark keeps its own phrase.
pub fn moment_label(moment: &ClipMoment) -> String {
    let reason = moment.reason.trim();
    match moment_kind(moment) {
        ClipMomentSource::Voice if reason.is_empty() => VOICE_LABEL.into(),
        ClipMomentSource::Manual => MANUAL_LABEL.into(),
        ClipMomentSource::Chat if reason.is_empty() => CHAT_LABEL.into(),
        ClipMomentSource::Voice | ClipMomentSource::Chat => reason.into(),
    }
}

fn clock(ms: u64) -> String {
    format_timecode(i64::try_from(ms).unwrap_or(i64::MAX), false)
}

/// `formatMomentRange`: "4:35–5:12", recording time; one clock when the
/// range is empty.
pub fn format_moment_range(start_ms: u64, end_ms: u64) -> String {
    if end_ms > start_ms {
        format!("{}–{}", clock(start_ms), clock(end_ms))
    } else {
        clock(start_ms)
    }
}

/// `reportMoments`: the streamer's marks first, then chat peaks, each in
/// recording order.
pub fn report_moments(moments: &[ClipMoment]) -> Vec<MomentRow> {
    let rank = |moment: &ClipMoment| u8::from(moment_kind(moment) == ClipMomentSource::Chat);
    let mut sorted: Vec<&ClipMoment> = moments.iter().collect();
    sorted.sort_by(|left, right| {
        rank(left)
            .cmp(&rank(right))
            .then_with(|| left.start_ms.cmp(&right.start_ms))
    });
    sorted
        .into_iter()
        .enumerate()
        .map(|(index, moment)| {
            let kind = moment_kind(moment);
            MomentRow {
                key: format!("{index}-{}-{}", moment_kind_id(kind), moment.start_ms),
                kind,
                label: moment_label(moment),
                excerpt: moment.excerpt.trim().to_string(),
                range: format_moment_range(moment.start_ms, moment.end_ms),
            }
        })
        .collect()
}

fn moment_kind_id(kind: ClipMomentSource) -> &'static str {
    match kind {
        ClipMomentSource::Voice => "voice",
        ClipMomentSource::Manual => "manual",
        ClipMomentSource::Chat => "chat",
    }
}

// --- Alerts ------------------------------------------------------------------

/// `reportAlertLabel`.
pub fn report_alert_label(kind: CohostAlertKind) -> &'static str {
    match kind {
        CohostAlertKind::Audio => "Chat said: no audio",
        CohostAlertKind::Video => "Chat said: video problem",
        CohostAlertKind::StreamHealth => "Chat said: stream is lagging",
        CohostAlertKind::Game => "Chat said: game problem",
        CohostAlertKind::Other | CohostAlertKind::Unknown => "Chat said: something was wrong",
    }
}

// --- Time --------------------------------------------------------------------

fn parse_ms(at: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(at)
        .ok()
        .map(|at| at.timestamp_millis())
}

/// `streamOffsetLabel`: how far into the stream `at` was ("12:04"); none
/// when either time is unreadable.
pub fn stream_offset_label(at: &str, started_at: Option<&str>) -> Option<String> {
    let start = parse_ms(started_at?)?;
    let at = parse_ms(at)?;
    Some(format_timecode(at.saturating_sub(start).max(0), false))
}

fn report_span_ms(report: Option<&CohostSessionReport>) -> Option<i64> {
    let report = report?;
    let span = parse_ms(&report.ended_at)?.saturating_sub(parse_ms(&report.started_at)?);
    (span > 0).then_some(span)
}

// --- Stats -------------------------------------------------------------------

fn stat(id: &'static str, value: u64, label: &'static str) -> Stat {
    Stat {
        id,
        value: format_report_count(value),
        of: None,
        label,
    }
}

fn report_stats(report: &CohostSessionReport) -> Vec<Stat> {
    let tally = question_tally(&report.questions);
    let greetings = &report.greetings;
    vec![
        stat("questions", tally.caught, "Questions caught"),
        stat("answered-on-air", tally.answered_on_air, "Answered on air"),
        stat("replied", tally.replied, "Replied"),
        stat("missed", tally.missed, "Missed"),
        stat("flags", report.flags.raised, "Flags"),
        stat("promises-kept", report.promises.kept, "Promises kept"),
        stat(
            "promises-open",
            report.promises.open.len() as u64,
            "Promises open",
        ),
        Stat {
            of: Some(format_report_count(greetings.first_timers)),
            ..stat(
                "first-timers",
                greetings.first_timers_greeted,
                "First-timers greeted",
            )
        },
        stat("on-screen", report.shown_on_stream, "On screen"),
    ]
}

// --- Voice commands (plan 140 S3) --------------------------------------------

/// `reportCommands`: the "Commands" row, the non-zero counts in a fixed
/// order; none when none counted.
pub fn report_commands(commands: Option<&CohostReportCommands>) -> Option<CommandsView> {
    let commands = commands?;
    let counts: Vec<(&'static str, u64, &'static str)> = [
        ("highlighted", commands.highlighted, "Highlighted"),
        ("cleared", commands.cleared, "Cleared"),
        ("removed", commands.removed, "Removed"),
        (
            "hidden-locally",
            commands.hidden_locally,
            "Hidden in Videorc",
        ),
        ("cancelled", commands.cancelled, "Canceled"),
        ("expired", commands.expired, "No answer"),
        ("failed", commands.failed, "Failed"),
        ("not-found", commands.not_found, "Not found"),
    ]
    .into_iter()
    .filter(|(_, count, _)| *count > 0)
    .collect();
    let total = counts
        .iter()
        .fold(0u64, |sum, (_, count, _)| sum.saturating_add(*count));
    if total == 0 {
        return None;
    }
    Some(CommandsView {
        total: if total == 1 {
            "1 command".into()
        } else {
            format!("{} commands", format_report_count(total))
        },
        counts: counts
            .into_iter()
            .map(|(id, count, label)| CommandCount {
                id,
                value: format_report_count(count),
                label,
            })
            .collect(),
    })
}

// --- Greetings skipped (plan 192 D7, plan 211 D9) ----------------------------

/// `reportGreetingSkips`: the non-zero reasons as one plain line, none when
/// there are none. Neither said nor posted ("skipped"), so the line reads
/// true for Bubble and Suggest alike, and for older reports.
pub fn report_greeting_skips(
    skipped: Option<&CohostReportGreetingsSkipped>,
    name: Option<&str>,
) -> Option<GreetingSkipsView> {
    let skipped = skipped?;
    let who = display_name(name);
    let were = |one: bool| if one { "was" } else { "were" };
    let reasons: Vec<(u64, String)> = [
        (skipped.no_line, "had no line".to_string()),
        // "{name} talks: Off" (plan 211 D1).
        (skipped.mode_off, format!("came while {who} was set to Off")),
        (skipped.stale, String::new()),
        (skipped.deduped, String::new()),
        (skipped.destination_failed, "couldn't be sent".to_string()),
        (
            skipped.youtube_paused,
            "came while YouTube chat was paused".to_string(),
        ),
        // Plan 211 D9: Bubble, with the avatar on no output.
        (
            skipped.no_bubble,
            format!("came while {who} wasn't on stream"),
        ),
    ]
    .into_iter()
    .enumerate()
    .filter(|(_, (count, _))| *count > 0)
    .map(|(index, (count, clause))| {
        let clause = match index {
            2 => format!("{} too old to greet", were(count == 1)),
            3 => format!("{} already greeted", were(count == 1)),
            _ => clause,
        };
        (count, clause)
    })
    .collect();
    // A held greeting waited for the limits and went out later (or in a
    // collapsed burst), so it is said apart from the ones skipped.
    let held = skipped.held;
    if reasons.is_empty() && held == 0 {
        return None;
    }
    let mut sentences = Vec::new();
    if !reasons.is_empty() {
        let parts: Vec<String> = reasons
            .iter()
            .map(|(count, clause)| format!("{} {clause}", format_report_count(*count)))
            .collect();
        sentences.push(format!("Greetings skipped: {}.", parts.join(", ")));
    }
    if held > 0 {
        sentences.push(if held == 1 {
            "1 greeting waited its turn.".to_string()
        } else {
            format!("{} greetings waited their turn.", format_report_count(held))
        });
    }
    let total = reasons
        .iter()
        .fold(0u64, |sum, (count, _)| sum.saturating_add(*count));
    Some(GreetingSkipsView {
        total: format_report_count(total),
        sentence: sentences.join(" "),
    })
}

// --- Community (plan 225 D15) ------------------------------------------------

fn count_words(count: u32, one: &str, many: &str) -> String {
    format!(
        "{} {}",
        format_report_count(u64::from(count)),
        if count == 1 { one } else { many }
    )
}

/// `milestoneLabel`: "10th stream", "5 in a row", "1 year".
pub fn milestone_label(milestone: &ViewerMilestone) -> String {
    match milestone.kind {
        ViewerMilestoneKind::Streams => format!("{} stream", ordinal(milestone.value)),
        ViewerMilestoneKind::Row => format!("{} in a row", milestone.value),
        ViewerMilestoneKind::Anniversary => "1 year".to_string(),
    }
}

/// `reportCommunity`: the Community block, or none for a report without one.
pub fn report_community(community: Option<&CohostReportCommunity>) -> Option<CommunityView> {
    let community = community?;
    let extras: Vec<String> = [
        (community.new_regulars, "new regular", "new regulars"),
        (community.links_made, "link made", "links made"),
        (
            community.memories_learned,
            "memory learned",
            "memories learned",
        ),
        // Opt-outs are counted, never named (D13).
        (community.opt_outs, "opt-out", "opt-outs"),
    ]
    .into_iter()
    .filter(|(count, _, _)| *count > 0)
    .map(|(count, one, many)| count_words(count, one, many))
    .collect();
    Some(CommunityView {
        regulars_back: community.regulars_back,
        stats: vec![
            stat(
                "regulars-back",
                u64::from(community.regulars_back),
                "Regulars back",
            ),
            Stat {
                of: Some(format_report_count(u64::from(community.first_timers))),
                ..stat(
                    "first-timers-stayed",
                    u64::from(community.first_timers_stayed),
                    "First-timers stayed 40+ min",
                )
            },
            stat("comebacks", u64::from(community.comebacks), "Comebacks"),
            stat(
                "milestones",
                community.milestones.len() as u64,
                "Milestones",
            ),
        ],
        line: (!extras.is_empty()).then(|| extras.join(" · ")),
        regulars: community
            .regulars
            .iter()
            .enumerate()
            .map(|(index, person)| RegularRow {
                key: format!("{index}-{}", person.name),
                name: person.name.clone(),
                platforms: if person.platforms.is_empty() {
                    vec![person.platform]
                } else {
                    unique_platforms(&person.platforms)
                },
                streams: count_words(person.streams, "stream", "streams"),
            })
            .collect(),
        milestones: community
            .milestones
            .iter()
            .enumerate()
            .map(|(index, entry)| MilestoneRow {
                key: format!("{index}-{}", entry.name),
                name: entry.name.clone(),
                platform: entry.platform,
                label: milestone_label(&entry.milestone),
            })
            .collect(),
        summary: community
            .summary
            .as_deref()
            .map(str::trim)
            .filter(|summary| !summary.is_empty())
            .map(str::to_string),
    })
}

/// A report Sidekick itself never wrote to (plan 225 D15): the community
/// store folded its block into an otherwise empty report, so the stream
/// still reads as Sidekick-off, with its Community block.
fn only_community(report: &CohostSessionReport) -> bool {
    report.segments == 0
        && report.posts.is_empty()
        && report.said.is_empty()
        && report.greetings.skipped.is_none()
        && report.commands.is_none()
}

// --- The card ----------------------------------------------------------------

/// Plan 192 S2.2: a small neutral tag on a greeting.
fn post_source_label(source: CohostReportPostSource) -> &'static str {
    match source {
        CohostReportPostSource::Ai => "AI",
        CohostReportPostSource::Line => "Line",
    }
}

fn post_trigger_label(trigger: CohostUtteranceTriggerKind) -> &'static str {
    match trigger {
        CohostUtteranceTriggerKind::Greeting => "Greeting",
        CohostUtteranceTriggerKind::Answer => "Answer",
        CohostUtteranceTriggerKind::Banter => "Banter",
        CohostUtteranceTriggerKind::Manual => "Say",
        CohostUtteranceTriggerKind::Community => "Community",
    }
}

fn post_result_label(result: CohostReportPostResult) -> &'static str {
    match result {
        CohostReportPostResult::Sent => "Posted",
        CohostReportPostResult::Partial => "Posted in part",
        CohostReportPostResult::Failed => "Not sent",
    }
}

/// `buddyReportView`.
pub fn report_view(input: ReportViewInput<'_>) -> ReportView {
    let Some(payload) = input.payload else {
        return ReportView::Empty { message: EMPTY };
    };
    let report = payload.report.as_ref();
    let started_at = input
        .session
        .map(|session| session.started_at.as_str())
        .or_else(|| report.map(|report| report.started_at.as_str()));
    let duration_ms = input
        .session
        .and_then(|session| session.duration_ms)
        .or_else(|| report_span_ms(report));
    let chat = ChatView {
        messages: payload.chat.messages,
        label: chat_messages_label(payload.chat.messages),
        platforms: report_platforms(&payload.chat),
    };
    let title = report
        .and_then(|report| report.stream_title.as_deref())
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .or_else(|| {
            input
                .session
                .map(|session| session.title.trim())
                .filter(|title| !title.is_empty())
        })
        .unwrap_or(UNTITLED)
        .to_string();
    let mut shown = ShownReport {
        kind: ShownKind::BuddyOff,
        session_id: payload.session_id.clone(),
        title,
        date: started_at.map(day_label),
        duration: duration_ms.map(|ms| duration_ms_label(Some(ms))),
        chat,
        stats: Vec::new(),
        note: None,
        missed: Vec::new(),
        promises: Vec::new(),
        moments: report_moments(&payload.moments),
        alerts: Vec::new(),
        commands: None,
        said: Vec::new(),
        posts: Vec::new(),
        greeting_skips: None,
        community: report_community(report.and_then(|report| report.community.as_ref())),
    };
    let Some(report) = report.filter(|report| !only_community(report)) else {
        shown.note = Some(Note {
            title: OFF,
            hint: if input.buddy_on { NEXT_STREAM } else { TURN_ON },
        });
        return ReportView::Shown(Box::new(shown));
    };
    let offset = |at: &str| stream_offset_label(at, started_at);
    shown.kind = ShownKind::Report;
    shown.stats = report_stats(report);
    shown.missed = missed_questions(&report.questions)
        .into_iter()
        .map(|question| QuestionRow {
            id: question.id.clone(),
            text: question.text.clone(),
            askers: askers_label(&question.askers),
            askers_title: question.askers.join(", "),
            platforms: unique_platforms(&question.platforms),
            high: question.priority == CohostPriority::High,
            at: offset(&question.first_seen_at),
        })
        .collect();
    shown.promises = report
        .promises
        .open
        .iter()
        .enumerate()
        .map(|(index, promise)| PromiseRow {
            key: format!("{index}-{}", promise.first_seen_at),
            text: promise.text.clone(),
            at: offset(&promise.first_seen_at),
        })
        .collect();
    shown.alerts = report
        .alerts
        .iter()
        .enumerate()
        .map(|(index, alert)| AlertRow {
            key: format!("{index}-{}", alert_kind_id(alert.kind)),
            kind: alert.kind,
            label: report_alert_label(alert.kind),
            viewers: if alert.peak_viewers == 1 {
                "1 viewer".to_string()
            } else {
                format!(
                    "{} viewers",
                    format_report_count(u64::from(alert.peak_viewers))
                )
            },
            at: offset(&alert.first_seen_at),
        })
        .collect();
    shown.commands = report_commands(report.commands.as_ref());
    // An older report has no `said`: nothing to show, never an error.
    shown.said = report
        .said
        .iter()
        .map(|line| SaidRow {
            id: line.id.clone(),
            trigger: post_trigger_label(line.trigger),
            text: line.text.clone(),
            at: offset(&line.at),
            source: line.source.map(post_source_label),
        })
        .collect();
    shown.posts = report
        .posts
        .iter()
        .map(|post| PostRow {
            id: post.id.clone(),
            trigger: post_trigger_label(post.trigger),
            text: post.text.clone(),
            platforms: unique_platforms(&post.destinations),
            result: post.result,
            result_label: post_result_label(post.result),
            at: offset(&post.at),
            source: post.source.map(post_source_label),
        })
        .collect();
    shown.greeting_skips = report_greeting_skips(report.greetings.skipped.as_ref(), input.name);
    ReportView::Shown(Box::new(shown))
}

fn alert_kind_id(kind: CohostAlertKind) -> &'static str {
    match kind {
        CohostAlertKind::Audio => "audio",
        CohostAlertKind::Video => "video",
        CohostAlertKind::StreamHealth => "stream-health",
        CohostAlertKind::Game => "game",
        CohostAlertKind::Other | CohostAlertKind::Unknown => "other",
    }
}

// --- Lists and the switcher --------------------------------------------------

/// `capReportList`: the first `cap` rows unless expanded, and how many stay
/// behind "Show all".
pub fn cap_report_list<T>(items: &[T], expanded: bool, cap: usize) -> (&[T], usize) {
    if expanded || items.len() <= cap {
        (items, 0)
    } else {
        (&items[..cap], items.len() - cap)
    }
}

/// `isReportableStream`: a stream that ended. It went out live (`stream`,
/// `record+stream`, or an older row's `streaming`) and is not the one
/// running now, whose report is only saved when it stops.
pub fn is_reportable_stream(session: &ReportSession) -> bool {
    session.mode.contains("stream") && session.status != "running"
}

fn recent_streams(sessions: &[ReportSession]) -> Vec<&ReportSession> {
    let mut streams: Vec<&ReportSession> = sessions
        .iter()
        .filter(|session| is_reportable_stream(session))
        .collect();
    streams.sort_by(|left, right| right.started_at.cmp(&left.started_at));
    streams.truncate(SWITCHER_LIMIT);
    streams
}

/// `newestStreamedSessionId`: the stream "Last stream" means, the newest
/// one that ended. None while the loaded Library holds none (the card then
/// asks `cohost.report.latest`).
pub fn newest_streamed_session_id(sessions: &[ReportSession]) -> Option<String> {
    recent_streams(sessions)
        .first()
        .map(|session| session.id.clone())
}

/// `reportSessionOptions`: recent streams, newest first, plus the shown one
/// when the loaded Library page does not reach it.
pub fn report_session_options(
    sessions: &[ReportSession],
    shown: Option<SessionOption>,
) -> Vec<SessionOption> {
    let mut options: Vec<SessionOption> = recent_streams(sessions)
        .into_iter()
        .map(|session| SessionOption {
            id: session.id.clone(),
            title: Some(session.title.trim())
                .filter(|title| !title.is_empty())
                .unwrap_or(UNTITLED)
                .to_string(),
            date: day_label(&session.started_at),
        })
        .collect();
    if let Some(shown) = shown
        && !options.iter().any(|option| option.id == shown.id)
    {
        options.push(shown);
    }
    options
}

/// `reportSessionChoice`: picking the newest stream follows "Last stream"
/// again (none), so the next stream that ends takes its place; any other
/// pick holds that session.
pub fn report_session_choice(session_id: &str, newest_id: Option<&str>) -> Option<String> {
    (Some(session_id) != newest_id).then(|| session_id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn question(overrides: Value) -> Value {
        merge(
            json!({
                "id": "q1",
                "text": "What keyboard is that?",
                "priority": "normal",
                "firstSeenAt": "2026-08-22T10:12:04Z",
                "outcome": "open"
            }),
            overrides,
        )
    }

    fn questions(overrides: Value) -> Value {
        merge(
            json!({
                "total": 0,
                "markedAnswered": 0,
                "dismissed": 0,
                "replied": 0,
                "answeredOnAir": 0,
                "restored": 0,
                "shownOnStream": 0
            }),
            overrides,
        )
    }

    fn merge(mut base: Value, overrides: Value) -> Value {
        if let (Some(base), Value::Object(overrides)) = (base.as_object_mut(), overrides) {
            for (key, value) in overrides {
                if value.is_null() {
                    base.remove(&key);
                } else {
                    base.insert(key, value);
                }
            }
        }
        base
    }

    fn report(overrides: Value) -> Value {
        merge(
            json!({
                "version": 1,
                "sessionId": "stream-1",
                "startedAt": "2026-08-22T10:00:30Z",
                "endedAt": "2026-08-22T11:30:00Z",
                "segments": 1,
                "streamTitle": "Rust night",
                "messagesSeen": 84,
                "shownOnStream": 2,
                "questions": questions(json!({
                    "total": 5,
                    "markedAnswered": 1,
                    "dismissed": 1,
                    "replied": 1,
                    "answeredOnAir": 1,
                    "items": [
                        question(json!({ "id": "q1", "outcome": "replied" })),
                        question(json!({
                            "id": "q2",
                            "text": "Which editor theme?",
                            "askers": ["Ada", "Grace", "Linus"],
                            "platforms": ["twitch", "youtube", "twitch"],
                            "priority": "high",
                            "firstSeenAt": "2026-08-22T10:20:00Z"
                        })),
                        question(json!({ "id": "q3", "outcome": "answered-on-air" })),
                        question(json!({ "id": "q4", "outcome": "marked-answered" })),
                        question(json!({ "id": "q5", "outcome": "dismissed" }))
                    ]
                })),
                "flags": { "raised": 2, "dismissed": 1 },
                "promises": {
                    "heard": 2,
                    "kept": 1,
                    "dismissed": 0,
                    "reminded": 1,
                    "open": [{ "text": "Giveaway at 100 viewers", "firstSeenAt": "2026-08-22T10:05:00Z" }]
                },
                "greetings": {
                    "firstTimers": 3,
                    "firstTimersGreeted": 2,
                    "byVoice": 1,
                    "byChat": 1,
                    "onStream": 0,
                    "manual": 0
                },
                "alerts": [
                    { "kind": "audio", "peakViewers": 3, "active": true, "firstSeenAt": "2026-08-22T10:40:00Z" },
                    { "kind": "game", "peakViewers": 1, "active": false, "firstSeenAt": "2026-08-22T11:02:10Z" }
                ],
                "recap": { "offered": 1, "drafted": 0, "dismissed": 1 }
            }),
            overrides,
        )
    }

    fn moments() -> Value {
        json!([
            {
                "startMs": 280_000,
                "endMs": 325_000,
                "reason": "Chat spiked: 9 messages in 30s",
                "excerpt": "chat is going wild right now",
                "source": "chat"
            },
            { "startMs": 724_200, "endMs": 754_200, "reason": "Marked", "excerpt": "", "source": "manual" },
            {
                "startMs": 275_400,
                "endMs": 312_000,
                "reason": "You said 'clip that'",
                "excerpt": "  and it actually works first try clip that ",
                "source": "voice"
            }
        ])
    }

    fn payload(overrides: Value) -> CohostReportPayload {
        serde_json::from_value(merge(
            json!({
                "sessionId": "stream-1",
                "report": report(json!({})),
                "moments": moments(),
                "chat": {
                    "messages": 84,
                    "byPlatform": [
                        { "platform": "twitch", "messages": 60 },
                        { "platform": "youtube", "messages": 24 }
                    ]
                }
            }),
            overrides,
        ))
        .expect("payload")
    }

    /// `payload({ report: null })`: the merge drops nulls, so set it after.
    fn payload_without_report() -> CohostReportPayload {
        CohostReportPayload {
            report: None,
            ..payload(json!({}))
        }
    }

    fn session_row() -> ReportSession {
        ReportSession {
            id: "stream-1".into(),
            title: "Friday stream".into(),
            started_at: "2026-08-22T10:00:00Z".into(),
            duration_ms: Some(5_400_000),
            mode: "record+stream".into(),
            status: "completed".into(),
        }
    }

    fn view(
        payload: &CohostReportPayload,
        session: Option<&ReportSession>,
        buddy_on: bool,
    ) -> ShownReport {
        view_named(payload, session, buddy_on, None)
    }

    fn view_named(
        payload: &CohostReportPayload,
        session: Option<&ReportSession>,
        buddy_on: bool,
        name: Option<&str>,
    ) -> ShownReport {
        match report_view(ReportViewInput {
            payload: Some(payload),
            session,
            buddy_on,
            name,
        }) {
            ReportView::Shown(shown) => *shown,
            ReportView::Empty { .. } => panic!("expected a report"),
        }
    }

    fn questions_of(value: Value) -> CohostReportQuestions {
        serde_json::from_value(questions(value)).expect("questions")
    }

    fn skips(value: Value) -> CohostReportGreetingsSkipped {
        serde_json::from_value(value).expect("skips")
    }

    #[test]
    fn says_what_the_report_holds_in_the_websites_words() {
        assert_eq!(
            DESCRIPTION,
            "Sidekick saves a short report on your computer: questions caught and missed, flags, promises, first-timers greeted, and the moments you marked by saying clip that."
        );
        assert_eq!(
            EMPTY,
            "The report appears here after your first stream with Sidekick."
        );
        assert_eq!(TURN_ON, "Turn on Sidekick to also catch questions.");
        for copy in [DESCRIPTION, EMPTY, OFF, TURN_ON, NEXT_STREAM] {
            assert!(!copy.contains('—'));
            let lower = copy.to_lowercase();
            assert!(!lower.contains("co-host") && !lower.contains("publish"));
        }
    }

    #[test]
    fn tally_reads_outcomes_from_the_log_while_it_holds_every_question() {
        let report: CohostSessionReport = serde_json::from_value(report(json!({}))).unwrap();
        assert_eq!(
            question_tally(&report.questions),
            QuestionTally {
                caught: 5,
                answered_on_air: 1,
                replied: 1,
                missed: 1
            }
        );
    }

    #[test]
    fn tally_counts_shown_as_handled_and_restored_as_missed() {
        let tally = question_tally(&questions_of(json!({
            "total": 3,
            "answeredOnAir": 2,
            "restored": 1,
            "items": [
                question(json!({ "id": "a", "outcome": "shown" })),
                question(json!({ "id": "b", "outcome": "open" })),
                question(json!({ "id": "c", "outcome": "answered-on-air" }))
            ]
        })));
        assert_eq!(
            tally,
            QuestionTally {
                caught: 3,
                answered_on_air: 1,
                replied: 0,
                missed: 1
            }
        );
    }

    #[test]
    fn tally_falls_back_to_the_counters_past_the_log_cap() {
        let items: Vec<Value> = (0..200)
            .map(|index| {
                question(json!({
                    "id": format!("q{index}"),
                    "outcome": if index < 10 { "open" } else { "replied" }
                }))
            })
            .collect();
        assert_eq!(
            question_tally(&questions_of(json!({
                "total": 260,
                "replied": 190,
                "answeredOnAir": 20,
                "markedAnswered": 5,
                "dismissed": 5,
                "shownOnStream": 5,
                "restored": 5,
                "items": items.clone()
            }))),
            QuestionTally {
                caught: 260,
                answered_on_air: 20,
                replied: 190,
                missed: 40
            }
        );
        // The open questions the log holds are a floor; the count never
        // leaves 0..total.
        assert_eq!(
            question_tally(&questions_of(
                json!({ "total": 210, "replied": 400, "items": items })
            ))
            .missed,
            10
        );
        assert_eq!(
            question_tally(&questions_of(json!({ "total": 4 }))),
            QuestionTally {
                caught: 4,
                answered_on_air: 0,
                replied: 0,
                missed: 4
            }
        );
    }

    #[test]
    fn lists_missed_questions_in_the_order_they_were_first_seen() {
        let log = questions_of(json!({
            "total": 3,
            "items": [
                question(json!({ "id": "first", "outcome": "open" })),
                question(json!({ "id": "answered", "outcome": "replied" })),
                question(json!({ "id": "second", "outcome": "open" }))
            ]
        }));
        let ids: Vec<&str> = missed_questions(&log)
            .into_iter()
            .map(|item| item.id.as_str())
            .collect();
        assert_eq!(ids, ["first", "second"]);
        assert!(missed_questions(&questions_of(json!({}))).is_empty());
    }

    #[test]
    fn groups_each_platform_once_busiest_first_and_drops_platforms_without_chat() {
        let chat: CohostReportChat = serde_json::from_value(json!({
            "messages": 92,
            "byPlatform": [
                { "platform": "youtube", "messages": 24 },
                { "platform": "kick", "messages": 0 },
                { "platform": "twitch", "messages": 50 },
                { "platform": "x", "messages": 4 },
                { "platform": "twitch", "messages": 10 },
                { "platform": "tiktok", "messages": 4 }
            ]
        }))
        .unwrap();
        let rows: Vec<(StreamPlatform, u64, String)> = report_platforms(&chat)
            .into_iter()
            .map(|entry| (entry.platform, entry.messages, entry.label))
            .collect();
        assert_eq!(
            rows,
            [
                (
                    StreamPlatform::Twitch,
                    60,
                    "Twitch: 60 messages".to_string()
                ),
                (
                    StreamPlatform::Youtube,
                    24,
                    "YouTube: 24 messages".to_string()
                ),
                (StreamPlatform::Tiktok, 4, "TikTok: 4 messages".to_string()),
                (StreamPlatform::X, 4, "X: 4 messages".to_string()),
            ]
        );
        let one: CohostReportChat = serde_json::from_value(
            json!({ "messages": 1, "byPlatform": [{ "platform": "kick", "messages": 1 }] }),
        )
        .unwrap();
        assert_eq!(report_platforms(&one)[0].label, "Kick: 1 message");
    }

    #[test]
    fn names_the_chat_total() {
        assert_eq!(chat_messages_label(0), "No chat messages");
        assert_eq!(chat_messages_label(1), "1 chat message");
        assert_eq!(chat_messages_label(84), "84 chat messages");
        assert_eq!(chat_messages_label(12_480), "12,480 chat messages");
    }

    #[test]
    fn puts_the_streamers_marks_first_then_chat_peaks_each_in_recording_order() {
        let moments: Vec<ClipMoment> = serde_json::from_value(moments()).unwrap();
        let rows = report_moments(&moments);
        let summary: Vec<(ClipMomentSource, &str, &str)> = rows
            .iter()
            .map(|row| (row.kind, row.label.as_str(), row.range.as_str()))
            .collect();
        assert_eq!(
            summary,
            [
                (ClipMomentSource::Voice, "You said 'clip that'", "4:35–5:12"),
                (ClipMomentSource::Manual, "Marked", "12:04–12:34"),
                (
                    ClipMomentSource::Chat,
                    "Chat spiked: 9 messages in 30s",
                    "4:40–5:25"
                ),
            ]
        );
        assert_eq!(rows[0].excerpt, "and it actually works first try clip that");
        let keys: std::collections::HashSet<&str> =
            rows.iter().map(|row| row.key.as_str()).collect();
        assert_eq!(keys.len(), rows.len());
    }

    #[test]
    fn labels_marks_by_who_placed_them_and_keeps_the_phrase_a_voice_mark_heard() {
        let moments: Vec<ClipMoment> = serde_json::from_value(json!([
            { "startMs": 0, "endMs": 30_000, "reason": "You said 'clip it'", "excerpt": "", "source": "voice" },
            { "startMs": 40_000, "endMs": 70_000, "reason": "", "excerpt": "", "source": "voice" },
            { "startMs": 80_000, "endMs": 110_000, "reason": "Clip", "excerpt": "", "source": "manual" },
            { "startMs": 5_000, "endMs": 50_000, "reason": "Chat spiked: 4 messages in 30s", "excerpt": "" }
        ]))
        .unwrap();
        let rows = report_moments(&moments);
        assert_eq!(rows[0].label, "You said 'clip it'");
        assert_eq!(rows[1].label, "You said 'clip that'");
        assert_eq!(rows[2].label, "Marked");
        // An older backend sends no source: that moment is a chat peak.
        assert_eq!(rows[3].kind, ClipMomentSource::Chat);
    }

    #[test]
    fn reads_recording_time_as_m_ss_or_h_mm_ss_from_an_hour() {
        assert_eq!(format_moment_range(275_400, 312_000), "4:35–5:12");
        assert_eq!(format_moment_range(3_590_000, 3_635_000), "59:50–1:00:35");
        assert_eq!(format_moment_range(12_000, 12_000), "0:12");
    }

    #[test]
    fn builds_the_full_card_from_a_saved_report() {
        let session = session_row();
        let view = view(&payload(json!({})), Some(&session), true);
        assert_eq!(view.kind, ShownKind::Report);
        assert_eq!(view.session_id, "stream-1");
        // The stream's own title wins over the Library name.
        assert_eq!(view.title, "Rust night");
        assert_eq!(view.date, Some(day_label(&session.started_at)));
        assert_eq!(view.duration.as_deref(), Some("1:30:00"));
        assert_eq!(view.chat.label, "84 chat messages");
        let platforms: Vec<StreamPlatform> = view
            .chat
            .platforms
            .iter()
            .map(|entry| entry.platform)
            .collect();
        assert_eq!(platforms, [StreamPlatform::Twitch, StreamPlatform::Youtube]);
        assert_eq!(view.note, None);
        let stats: Vec<(&str, &str, Option<&str>)> = view
            .stats
            .iter()
            .map(|stat| (stat.label, stat.value.as_str(), stat.of.as_deref()))
            .collect();
        assert_eq!(
            stats,
            [
                ("Questions caught", "5", None),
                ("Answered on air", "1", None),
                ("Replied", "1", None),
                ("Missed", "1", None),
                ("Flags", "2", None),
                ("Promises kept", "1", None),
                ("Promises open", "1", None),
                ("First-timers greeted", "2", Some("3")),
                ("On screen", "2", None),
            ]
        );
        assert_eq!(
            view.missed,
            [QuestionRow {
                id: "q2".into(),
                text: "Which editor theme?".into(),
                askers: "Ada +2".into(),
                askers_title: "Ada, Grace, Linus".into(),
                platforms: vec![StreamPlatform::Twitch, StreamPlatform::Youtube],
                high: true,
                // Time into the stream, from the session's own start.
                at: Some("20:00".into()),
            }]
        );
        let promises: Vec<(&str, Option<&str>)> = view
            .promises
            .iter()
            .map(|promise| (promise.text.as_str(), promise.at.as_deref()))
            .collect();
        assert_eq!(promises, [("Giveaway at 100 viewers", Some("5:00"))]);
        let alerts: Vec<(&str, &str, Option<&str>)> = view
            .alerts
            .iter()
            .map(|alert| (alert.label, alert.viewers.as_str(), alert.at.as_deref()))
            .collect();
        assert_eq!(
            alerts,
            [
                ("Chat said: no audio", "3 viewers", Some("40:00")),
                ("Chat said: game problem", "1 viewer", Some("1:02:10")),
            ]
        );
        let kinds: Vec<ClipMomentSource> = view.moments.iter().map(|moment| moment.kind).collect();
        assert_eq!(
            kinds,
            [
                ClipMomentSource::Voice,
                ClipMomentSource::Manual,
                ClipMomentSource::Chat
            ]
        );
    }

    #[test]
    fn names_and_times_the_stream_from_the_report_alone_without_the_library_row() {
        let shown = view(
            &payload(json!({ "report": report(json!({ "streamTitle": null })) })),
            None,
            true,
        );
        assert_eq!(shown.title, "Untitled stream");
        assert_eq!(shown.date, Some(day_label("2026-08-22T10:00:30Z")));
        assert_eq!(shown.duration.as_deref(), Some("1:29:30"));
        assert_eq!(shown.promises[0].at.as_deref(), Some("4:30"));

        let session = session_row();
        let named = view(
            &payload(json!({ "report": report(json!({ "streamTitle": "  " })) })),
            Some(&session),
            true,
        );
        assert_eq!(named.title, "Friday stream");
    }

    #[test]
    fn keeps_moments_and_chat_for_a_stream_sidekick_missed() {
        let session = session_row();
        let off = view(&payload_without_report(), Some(&session), false);
        assert_eq!(off.kind, ShownKind::BuddyOff);
        assert_eq!(off.title, "Friday stream");
        assert_eq!(
            off.note,
            Some(Note {
                title: "Sidekick was off for this stream.",
                hint: "Turn on Sidekick to also catch questions."
            })
        );
        assert!(off.stats.is_empty());
        assert!(off.missed.is_empty());
        assert_eq!(off.moments.len(), 3);
        assert_eq!(off.chat.label, "84 chat messages");

        let on = view(&payload_without_report(), Some(&session), true);
        assert_eq!(
            on.note.map(|note| note.hint),
            Some("It joins your next stream.")
        );
    }

    #[test]
    fn is_empty_before_the_first_stream() {
        assert_eq!(
            report_view(ReportViewInput {
                payload: None,
                session: None,
                buddy_on: false,
                name: None,
            }),
            ReportView::Empty {
                message: "The report appears here after your first stream with Sidekick."
            }
        );
    }

    #[test]
    fn shows_zeros_for_a_quiet_stream_instead_of_hiding_the_counts() {
        let session = session_row();
        let quiet = view(
            &payload(json!({
                "moments": [],
                "chat": { "messages": 0, "byPlatform": [] },
                "report": report(json!({
                    "questions": questions(json!({})),
                    "flags": { "raised": 0, "dismissed": 0 },
                    "promises": { "heard": 0, "kept": 0, "dismissed": 0, "reminded": 0 },
                    "greetings": {
                        "firstTimers": 0,
                        "firstTimersGreeted": 0,
                        "byVoice": 0,
                        "byChat": 0,
                        "onStream": 0,
                        "manual": 0
                    },
                    "alerts": null,
                    "shownOnStream": 0
                }))
            })),
            Some(&session),
            true,
        );
        assert!(quiet.stats.iter().all(|stat| stat.value == "0"));
        assert_eq!(
            quiet.chat,
            ChatView {
                messages: 0,
                label: "No chat messages".into(),
                platforms: Vec::new()
            }
        );
        assert!(quiet.missed.is_empty());
        assert!(quiet.promises.is_empty());
        assert!(quiet.moments.is_empty());
        assert!(quiet.alerts.is_empty());
        assert_eq!(quiet.commands, None);
    }

    #[test]
    fn counts_what_voice_commands_did_non_zero_counts_only() {
        let counts = json!({
            "highlighted": 3,
            "cleared": 1,
            "removed": 1,
            "hiddenLocally": 1,
            "cancelled": 0,
            "expired": 1,
            "failed": 0,
            "notFound": 2
        });
        let commands: CohostReportCommands = serde_json::from_value(counts.clone()).unwrap();
        let row = |id, value: &str, label| CommandCount {
            id,
            value: value.into(),
            label,
        };
        assert_eq!(
            report_commands(Some(&commands)),
            Some(CommandsView {
                total: "9 commands".into(),
                counts: vec![
                    row("highlighted", "3", "Highlighted"),
                    row("cleared", "1", "Cleared"),
                    row("removed", "1", "Removed"),
                    row("hidden-locally", "1", "Hidden in Videorc"),
                    row("expired", "1", "No answer"),
                    row("not-found", "2", "Not found"),
                ]
            })
        );
        let only_removed = CohostReportCommands {
            highlighted: 0,
            cleared: 0,
            hidden_locally: 0,
            expired: 0,
            not_found: 0,
            ..commands
        };
        assert_eq!(
            report_commands(Some(&only_removed)),
            Some(CommandsView {
                total: "1 command".into(),
                counts: vec![row("removed", "1", "Removed")]
            })
        );
        // A report from before voice commands, or one where nothing counted.
        assert_eq!(report_commands(None), None);
        assert_eq!(
            report_commands(Some(&CohostReportCommands::default())),
            None
        );
        // The card's view carries it; a stream Sidekick missed has none.
        let session = session_row();
        let shown = view(
            &payload(json!({ "report": report(json!({ "commands": counts })) })),
            Some(&session),
            true,
        );
        assert_eq!(
            shown.commands.map(|commands| commands.total).as_deref(),
            Some("9 commands")
        );
        let off = view(&payload_without_report(), Some(&session), true);
        assert_eq!(off.commands, None);
    }

    #[test]
    fn tags_each_greeting_with_who_wrote_it_and_nothing_else() {
        let session = session_row();
        let shown = view(
            &payload(json!({ "report": report(json!({ "posts": [
                {
                    "id": "u1",
                    "at": "2026-08-22T10:01:30Z",
                    "trigger": "greeting",
                    "text": "Hi Ana, welcome to the stream!",
                    "destinations": ["twitch"],
                    "result": "sent",
                    "source": "ai"
                },
                {
                    "id": "u2",
                    "at": "2026-08-22T10:02:30Z",
                    "trigger": "greeting",
                    "text": "Welcome back, Bo!",
                    "destinations": ["youtube", "youtube"],
                    "result": "partial",
                    "source": "line"
                },
                {
                    "id": "u3",
                    "at": "2026-08-22T10:03:30Z",
                    "trigger": "manual",
                    "text": "hello",
                    "destinations": ["twitch"],
                    "result": "sent"
                }
            ] })) })),
            Some(&session),
            true,
        );
        assert_eq!(
            shown.posts[0],
            PostRow {
                id: "u1".into(),
                trigger: "Greeting",
                text: "Hi Ana, welcome to the stream!".into(),
                platforms: vec![StreamPlatform::Twitch],
                result: CohostReportPostResult::Sent,
                result_label: "Posted",
                at: Some("1:30".into()),
                source: Some("AI"),
            }
        );
        assert_eq!(shown.posts[1].id, "u2");
        assert_eq!(shown.posts[1].platforms, [StreamPlatform::Youtube]);
        assert_eq!(shown.posts[1].result_label, "Posted in part");
        assert_eq!(shown.posts[1].source, Some("Line"));
        // A Say post (and any older row) carries no source: no tag.
        assert_eq!(shown.posts[2].id, "u3");
        assert_eq!(shown.posts[2].trigger, "Say");
        assert_eq!(shown.posts[2].source, None);
    }

    #[test]
    fn lists_what_sidekick_said_on_stream_oldest_first_apart_from_what_it_posted() {
        let session = session_row();
        let shown = view(
            &payload(json!({ "report": report(json!({ "said": [
                {
                    "id": "b1",
                    "at": "2026-08-22T10:01:30Z",
                    "trigger": "greeting",
                    "text": "Welcome, Ada!",
                    "source": "line"
                },
                { "id": "b2", "at": "2026-08-22T10:04:05Z", "trigger": "answer", "text": "@Ada Rust today!" },
                { "id": "b3", "at": "2026-08-22T10:09:00Z", "trigger": "manual", "text": "brb" },
                {
                    "id": "b4",
                    "at": "2026-08-22T10:12:00Z",
                    "trigger": "greeting",
                    "text": "Welcome Ada, Bo and Kim!",
                    "source": "ai"
                }
            ] })) })),
            Some(&session),
            true,
        );
        let said = |id: &str, trigger, text: &str, at: &str, source| SaidRow {
            id: id.into(),
            trigger,
            text: text.into(),
            at: Some(at.into()),
            source,
        };
        assert_eq!(
            shown.said,
            [
                said("b1", "Greeting", "Welcome, Ada!", "1:30", Some("Line")),
                said("b2", "Answer", "@Ada Rust today!", "4:05", None),
                said("b3", "Say", "brb", "9:00", None),
                said(
                    "b4",
                    "Greeting",
                    "Welcome Ada, Bo and Kim!",
                    "12:00",
                    Some("AI")
                ),
            ]
        );
        // Posts stay chat-only.
        assert!(shown.posts.is_empty());
        // An older report without `said`, and a stream Sidekick missed.
        assert!(
            view(&payload(json!({})), Some(&session), true)
                .said
                .is_empty()
        );
        assert!(
            view(&payload_without_report(), Some(&session), true)
                .said
                .is_empty()
        );
    }

    #[test]
    fn says_in_plain_words_why_greetings_were_skipped() {
        // Held greetings went out later: said apart, never counted as skipped.
        assert_eq!(
            report_greeting_skips(Some(&skips(json!({ "noLine": 3, "held": 2 }))), None),
            Some(GreetingSkipsView {
                total: "3".into(),
                sentence: "Greetings skipped: 3 had no line. 2 greetings waited their turn.".into()
            })
        );
        assert_eq!(
            report_greeting_skips(Some(&skips(json!({ "held": 1 }))), None),
            Some(GreetingSkipsView {
                total: "0".into(),
                sentence: "1 greeting waited its turn.".into()
            })
        );
        assert_eq!(
            report_greeting_skips(
                Some(&skips(json!({
                    "youtubePaused": 1,
                    "destinationFailed": 1,
                    "held": 1,
                    "deduped": 1,
                    "stale": 1,
                    "modeOff": 1,
                    "noLine": 1,
                    "noBubble": 1
                }))),
                Some("Golmar")
            ),
            Some(GreetingSkipsView {
                total: "7".into(),
                sentence: "Greetings skipped: 1 had no line, 1 came while Golmar was set to Off, 1 was too old to greet, 1 was already greeted, 1 couldn't be sent, 1 came while YouTube chat was paused, 1 came while Golmar wasn't on stream. 1 greeting waited its turn.".into()
            })
        );
        assert_eq!(
            report_greeting_skips(Some(&skips(json!({ "stale": 2, "deduped": 1200 }))), None)
                .map(|view| view.sentence)
                .as_deref(),
            Some("Greetings skipped: 2 were too old to greet, 1,200 were already greeted.")
        );
        // Plan 211 D9: Bubble with the avatar on no output, named; the
        // default avatar's name, Flint, without one (plan 239 D2).
        assert_eq!(
            report_greeting_skips(Some(&skips(json!({ "noBubble": 46 }))), Some("Golmar")),
            Some(GreetingSkipsView {
                total: "46".into(),
                sentence: "Greetings skipped: 46 came while Golmar wasn't on stream.".into()
            })
        );
        assert_eq!(
            report_greeting_skips(Some(&skips(json!({ "noBubble": 2, "modeOff": 3 }))), None)
                .map(|view| view.sentence)
                .as_deref(),
            Some(
                "Greetings skipped: 3 came while Flint was set to Off, 2 came while Flint wasn't on stream."
            )
        );
        // Absent (an older report, or every greeting went out) or all zero.
        assert_eq!(report_greeting_skips(None, None), None);
        assert_eq!(report_greeting_skips(Some(&skips(json!({}))), None), None);
        assert_eq!(
            report_greeting_skips(Some(&skips(json!({ "noLine": 0 }))), None),
            None
        );
        // The card's view carries it, with the avatar's name passed through.
        let session = session_row();
        let with_skips = |skipped: Value| {
            payload(json!({ "report": report(json!({ "greetings": {
                "firstTimers": 3,
                "firstTimersGreeted": 2,
                "byVoice": 1,
                "byChat": 1,
                "onStream": 0,
                "manual": 0,
                "skipped": skipped
            } })) }))
        };
        assert_eq!(
            view(
                &with_skips(json!({ "noLine": 3, "held": 2 })),
                Some(&session),
                true
            )
            .greeting_skips
            .map(|view| view.sentence)
            .as_deref(),
            Some("Greetings skipped: 3 had no line. 2 greetings waited their turn.")
        );
        assert_eq!(
            view_named(
                &with_skips(json!({ "noBubble": 4 })),
                Some(&session),
                true,
                Some("Golmar")
            )
            .greeting_skips
            .map(|view| view.sentence)
            .as_deref(),
            Some("Greetings skipped: 4 came while Golmar wasn't on stream.")
        );
        assert_eq!(
            view(&payload(json!({})), Some(&session), true).greeting_skips,
            None
        );
        assert_eq!(
            view(&payload_without_report(), Some(&session), true).greeting_skips,
            None
        );
    }

    #[test]
    fn times_events_into_the_stream_and_gives_up_on_unreadable_times() {
        assert_eq!(
            stream_offset_label("2026-08-22T10:12:04Z", Some("2026-08-22T10:00:00Z")).as_deref(),
            Some("12:04")
        );
        assert_eq!(
            stream_offset_label("2026-08-22T09:59:00Z", Some("2026-08-22T10:00:00Z")).as_deref(),
            Some("0:00")
        );
        assert_eq!(
            stream_offset_label("later", Some("2026-08-22T10:00:00Z")),
            None
        );
        assert_eq!(stream_offset_label("2026-08-22T10:12:04Z", None), None);
        assert_eq!(
            report_alert_label(CohostAlertKind::StreamHealth),
            "Chat said: stream is lagging"
        );
        assert_eq!(
            report_alert_label(CohostAlertKind::Unknown),
            "Chat said: something was wrong"
        );
    }

    #[test]
    fn shows_five_rows_then_the_rest_behind_show_all() {
        let rows: Vec<usize> = (0..8).collect();
        assert_eq!(cap_report_list(&rows, false, LIST_CAP), (&rows[..5], 3));
        assert_eq!(cap_report_list(&rows, true, LIST_CAP), (&rows[..], 0));
        assert_eq!(
            cap_report_list(&rows[..5], false, LIST_CAP),
            (&rows[..5], 0)
        );
        let none: [usize; 0] = [];
        assert_eq!(cap_report_list(&none, false, LIST_CAP), (&none[..], 0));
        assert_eq!(show_all(8), "Show all 8");
    }

    fn switch_row(
        id: &str,
        title: &str,
        started_at: &str,
        mode: &str,
        status: &str,
    ) -> ReportSession {
        ReportSession {
            id: id.into(),
            title: title.into(),
            started_at: started_at.into(),
            duration_ms: None,
            mode: mode.into(),
            status: status.into(),
        }
    }

    fn switch_sessions() -> Vec<ReportSession> {
        vec![
            switch_row(
                "old",
                "Old stream",
                "2026-08-01T10:00:00Z",
                "stream",
                "completed",
            ),
            switch_row(
                "recording",
                "Tutorial",
                "2026-08-30T10:00:00Z",
                "record",
                "completed",
            ),
            switch_row(
                "new",
                "",
                "2026-08-29T10:00:00Z",
                "record+stream",
                "completed",
            ),
            switch_row(
                "legacy",
                "Friday stream",
                "2026-07-01T10:00:00Z",
                "streaming",
                "completed",
            ),
            switch_row(
                "live",
                "Friday stream",
                "2026-09-01T10:00:00Z",
                "record+stream",
                "running",
            ),
            switch_row(
                "imported",
                "Friday stream",
                "2026-09-02T10:00:00Z",
                "imported",
                "completed",
            ),
        ]
    }

    #[test]
    fn offers_streams_that_ended_newest_first() {
        let sessions = switch_sessions();
        assert!(is_reportable_stream(&switch_row(
            "a",
            "",
            "",
            "record+stream",
            "completed"
        )));
        assert!(!is_reportable_stream(&switch_row(
            "a",
            "",
            "",
            "record",
            "completed"
        )));
        assert!(!is_reportable_stream(&switch_row(
            "a",
            "",
            "",
            "record+stream",
            "running"
        )));
        assert_eq!(
            newest_streamed_session_id(&sessions).as_deref(),
            Some("new")
        );
        assert_eq!(newest_streamed_session_id(&sessions[1..2]), None);
        let option = |id: &str, title: &str, at: &str| SessionOption {
            id: id.into(),
            title: title.into(),
            date: day_label(at),
        };
        assert_eq!(
            report_session_options(&sessions, None),
            [
                option("new", "Untitled stream", "2026-08-29T10:00:00Z"),
                option("old", "Old stream", "2026-08-01T10:00:00Z"),
                option("legacy", "Friday stream", "2026-07-01T10:00:00Z"),
            ]
        );
    }

    #[test]
    fn lists_at_most_twenty_plus_the_shown_stream_when_the_library_page_ends_before_it() {
        let many: Vec<ReportSession> = (0..30)
            .map(|index| {
                switch_row(
                    &format!("s{index}"),
                    "Friday stream",
                    &format!("2026-08-01T{index:02}:00:00.000Z"),
                    "record+stream",
                    "completed",
                )
            })
            .collect();
        let options = report_session_options(&many, None);
        assert_eq!(options.len(), SWITCHER_LIMIT);
        assert_eq!(options[0].id, "s29");
        let shown = SessionOption {
            id: "archived".into(),
            title: "Old one".into(),
            date: "Jan 1".into(),
        };
        assert_eq!(
            report_session_options(&many, Some(shown.clone())).last(),
            Some(&shown)
        );
        assert_eq!(
            report_session_options(
                &many,
                Some(SessionOption {
                    id: "s29".into(),
                    ..shown
                })
            )
            .len(),
            SWITCHER_LIMIT
        );
    }

    #[test]
    fn follows_the_last_stream_again_when_the_newest_one_is_picked() {
        assert_eq!(report_session_choice("new", Some("new")), None);
        assert_eq!(
            report_session_choice("old", Some("new")).as_deref(),
            Some("old")
        );
        assert_eq!(report_session_choice("old", None).as_deref(), Some("old"));
    }

    fn community() -> Value {
        json!({
            "regularsBack": 12,
            "regulars": [
                { "name": "Ada", "platform": "twitch", "platforms": ["twitch", "youtube"], "streams": 14 },
                { "name": "Bo", "platform": "kick", "streams": 1 }
            ],
            "newRegulars": 1,
            "comebacks": 2,
            "firstTimers": 5,
            "firstTimersStayed": 3,
            "milestones": [
                { "name": "Kim", "platform": "twitch", "milestone": { "kind": "streams", "value": 10 } }
            ],
            "linksMade": 1,
            "memoriesLearned": 0,
            "optOuts": 1
        })
    }

    #[test]
    fn an_older_report_without_the_community_block_renders_as_before() {
        let session = session_row();
        let shown = view(&payload(json!({})), Some(&session), true);
        assert_eq!(shown.kind, ShownKind::Report);
        assert_eq!(shown.community, None);
    }

    #[test]
    fn shows_the_community_stats_row_the_quiet_line_and_the_names() {
        let session = session_row();
        let shown = view(
            &payload(json!({ "report": report(json!({ "community": community() })) })),
            Some(&session),
            true,
        );
        let community = shown.community.expect("community");
        let stats: Vec<(&str, &str, Option<&str>)> = community
            .stats
            .iter()
            .map(|stat| (stat.label, stat.value.as_str(), stat.of.as_deref()))
            .collect();
        assert_eq!(
            stats,
            [
                ("Regulars back", "12", None),
                ("First-timers stayed 40+ min", "3", Some("5")),
                ("Comebacks", "2", None),
                ("Milestones", "1", None),
            ]
        );
        // Opt-outs are counted, never named.
        assert_eq!(
            community.line.as_deref(),
            Some("1 new regular · 1 link made · 1 opt-out")
        );
        assert_eq!(
            community.regulars,
            [
                RegularRow {
                    key: "0-Ada".into(),
                    name: "Ada".into(),
                    platforms: vec![StreamPlatform::Twitch, StreamPlatform::Youtube],
                    streams: "14 streams".into()
                },
                RegularRow {
                    key: "1-Bo".into(),
                    name: "Bo".into(),
                    platforms: vec![StreamPlatform::Kick],
                    streams: "1 stream".into()
                },
            ]
        );
        assert_eq!(community.milestones[0].label, "10th stream");
        assert_eq!(community.summary, None);
    }

    #[test]
    fn a_stream_sidekick_never_joined_still_reads_as_sidekick_off_with_its_community_block() {
        let session = session_row();
        let mut block = community();
        block["summary"] = json!("Rust learners came back in force.");
        let shown = view(
            &payload(json!({ "report": report(json!({
                "segments": 0,
                "community": block
            })) })),
            Some(&session),
            false,
        );
        assert_eq!(shown.kind, ShownKind::BuddyOff);
        assert!(shown.stats.is_empty());
        assert_eq!(
            shown
                .community
                .and_then(|community| community.summary)
                .as_deref(),
            Some("Rust learners came back in force.")
        );
    }
}
