//! S1.6g: the rest of what the Studio screen draws, as pure views: the
//! watchdog's cards (`components/studio/watchdog-alert-card.tsx` and
//! `SessionNotices`), the cloud's Resume notice and its End livestream
//! question (`components/studio/cloud-resume-notice.tsx` and
//! `CloudResumeSlot`), the talk show's room as the Studio reads it
//! (`StudioTransport`, `StudioStagePanel`, `use-talk-show-room.ts`), and
//! the Preview stage's buttons (`StudioPreviewPanel` and
//! `DetachedPreviewCard`).
//!
//! Each view takes the Studio's state and decides every word, tone and
//! enabled state; the screen draws it and runs the named action. The
//! Preview's titles and the dock's hidden reasons are the preview crate's
//! (`videorc_preview::words`), which depends on this one.

use serde::Deserialize;
use serde_json::Value;

use super::StudioSnapshot;
use super::cloud::CloudState;
use super::session::{END_LIVESTREAM_LABEL, END_LIVESTREAM_TITLE, KEEP_STREAMING_LABEL};
use super::watchdog_alerts::SnoozeScope;
use crate::livestream::cloud_show::{
    END_CLOUD_SHOW_DESCRIPTION, ENDING_LABEL, NoticeAction, ResumeNotice, cloud_resume_notice,
    notice_action_label, rejoining_resume_notice,
};
use crate::livestream::cloud_status::CloudStatus;
use crate::livestream::watchdog::{WatchdogAlert, WatchdogAlertFix, visible_watchdog_alerts};
use crate::notices::MICROPHONE_SILENT_CODE;

// ---------------------------------------------------------------------------
// The watchdog's cards
// ---------------------------------------------------------------------------

/// The card's tone rides on the Alert's icon; nothing else is tinted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardTone {
    Destructive,
    Warning,
    Default,
}

/// `watchdogCardVariant`: critical is destructive, warning is warning, any
/// other severity is plain.
pub fn watchdog_card_tone(severity: &str) -> CardTone {
    match severity {
        "critical" => CardTone::Destructive,
        "warning" => CardTone::Warning,
        _ => CardTone::Default,
    }
}

pub const GOT_IT_LABEL: &str = "Got it";
pub const I_MEANT_TO_LABEL: &str = "I meant to";
pub const SEEN_LABEL: &str = "Seen";
pub const SNOOZE_TEN_MINUTES_LABEL: &str = "Snooze 10 min";
pub const SOURCE_CLOUD_LINE: &str = "Source: Videorc Cloud";

/// `watchdogQuietLabel`: I meant to is the mute's own quiet button (D3);
/// every other check says Got it.
pub fn watchdog_quiet_label(check: &str) -> &'static str {
    if check == "mic-muted" {
        I_MEANT_TO_LABEL
    } else {
        GOT_IT_LABEL
    }
}

/// What the quiet button does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuietAction {
    /// Got it: `Studio::acknowledge_watchdog_alert`.
    Acknowledge,
    /// I meant to: `Studio::snooze_watchdog_alert(id, SnoozeScope::Stream)`.
    Snooze(SnoozeScope),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuietButton {
    pub label: &'static str,
    pub action: QuietAction,
    /// Got it is off once the alert is acknowledged (it reads Seen).
    pub enabled: bool,
}

/// The kebab's one item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnoozeItem {
    pub label: &'static str,
    pub scope: SnoozeScope,
    /// The kebab's accessible name: "More for {title}".
    pub menu_label: String,
}

/// One card, as `WatchdogAlertCard` draws it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchdogCardView {
    pub id: String,
    pub check: String,
    pub tone: CardTone,
    /// The backend's exact words.
    pub title: String,
    pub detail: String,
    /// "Source: Videorc Cloud" when the runner made the reading (D9).
    pub source_line: Option<&'static str>,
    /// The first fix, a primary button.
    pub primary_fix: Option<WatchdogAlertFix>,
    /// The rest, ghost buttons.
    pub more_fixes: Vec<WatchdogAlertFix>,
    /// Absent on the compact card.
    pub quiet: Option<QuietButton>,
    /// Absent on the compact card.
    pub snooze: Option<SnoozeItem>,
}

/// `WatchdogAlertCard`. `compact` is the Stream Manager's hover card: the
/// fixes only (that window has no backend socket for the rest, A6).
pub fn watchdog_card(alert: &WatchdogAlert, compact: bool) -> WatchdogCardView {
    let mut fixes = alert.fixes.iter().cloned();
    let primary_fix = fixes.next();
    let more_fixes = fixes.collect();
    let quiet = (!compact).then(|| {
        let label = watchdog_quiet_label(&alert.check);
        if label == I_MEANT_TO_LABEL {
            QuietButton {
                label,
                action: QuietAction::Snooze(SnoozeScope::Stream),
                enabled: true,
            }
        } else {
            let acknowledged = alert.state == "acknowledged";
            QuietButton {
                label: if acknowledged { SEEN_LABEL } else { label },
                action: QuietAction::Acknowledge,
                enabled: !acknowledged,
            }
        }
    });
    let snooze = (!compact).then(|| SnoozeItem {
        label: SNOOZE_TEN_MINUTES_LABEL,
        scope: SnoozeScope::TenMinutes,
        menu_label: format!("More for {}", alert.title),
    });
    WatchdogCardView {
        id: alert.id.clone(),
        check: alert.check.clone(),
        tone: watchdog_card_tone(&alert.severity),
        title: alert.title.clone(),
        detail: alert.detail.clone(),
        source_line: (alert.source == "cloud").then_some(SOURCE_CLOUD_LINE),
        primary_fix,
        more_fixes,
        quiet,
        snooze,
    }
}

/// `SessionNotices`' cards: the visible alerts, worst and oldest first.
/// While the session's own silence notice is up (issue 1064), the
/// watchdog's `mic-silent` draws no second card.
pub fn watchdog_cards(
    alerts: &[WatchdogAlert],
    silence_notice_shown: bool,
) -> Vec<WatchdogCardView> {
    visible_watchdog_alerts(alerts)
        .into_iter()
        .filter(|alert| !(silence_notice_shown && alert.check == "mic-silent"))
        .map(|alert| watchdog_card(alert, false))
        .collect()
}

/// `runWatchdogFix`: what a fix's button does, through the Studio's own
/// actions (D2: nothing new of its own).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchdogFixAction {
    /// The deck's `micUnmute`.
    Unmute,
    /// The deck's `takeoverHide`.
    EndTakeover,
    /// The Takeover list (`assets`): the chosen takeover is the streamer's
    /// pick.
    OpenTakeovers,
    /// The Scenes list (`layouts`): re-applying the sources is its job.
    OpenScenes,
    /// The door to the Microphone row (`openStudioAudio`), never the bare tab.
    OpenAudio,
    OpenHealth,
    /// The Livestream page (`live`).
    OpenLivestream,
    /// The platform's dashboard, in the browser.
    OpenUrl(String),
    /// `Studio::reconnect_watchdog_destination(target_id)`.
    ReconnectDestination(String),
}

/// `runWatchdogFix`'s switch. A fix it does not know, a dashboard with no
/// page and a reconnect with no target do nothing.
pub fn watchdog_fix_action(
    alert: &WatchdogAlert,
    fix: &WatchdogAlertFix,
) -> Option<WatchdogFixAction> {
    Some(match fix.kind.as_str() {
        "unmute" => WatchdogFixAction::Unmute,
        "end-takeover" => WatchdogFixAction::EndTakeover,
        "show-brb" => WatchdogFixAction::OpenTakeovers,
        "switch-scene" => WatchdogFixAction::OpenScenes,
        "open-audio" => WatchdogFixAction::OpenAudio,
        "open-health" => WatchdogFixAction::OpenHealth,
        "open-livestream" => WatchdogFixAction::OpenLivestream,
        "open-platform-dashboard" => WatchdogFixAction::OpenUrl(fix.url.clone()?),
        "reconnect-destination" => {
            WatchdogFixAction::ReconnectDestination(alert.target_id.clone()?)
        }
        _ => return None,
    })
}

/// `REMOTE_INTENT_COPY.microphone`: the warning toast of an Unmute fix the
/// session refused.
pub const UNMUTE_FIX_FAILED: &str = "Couldn't change the microphone.";
/// `REMOTE_INTENT_COPY.takeoverHide`: the warning toast of an End takeover
/// fix that did not land.
pub const END_TAKEOVER_FIX_FAILED: &str = "Couldn't hide the takeover.";

/// `SessionNotices`' `silenceNoticeShown`: the runtime notice is the
/// microphone's, and only about silence (issue 1064). The failure outranks
/// it, as the runtime alert does.
pub fn silence_notice_shown(snapshot: &StudioSnapshot) -> bool {
    snapshot.session.notice.is_none()
        && snapshot
            .session
            .microphone_notice
            .as_ref()
            .is_some_and(|notice| {
                notice
                    .audio_issues
                    .iter()
                    .all(|issue| issue.code == MICROPHONE_SILENT_CODE)
            })
}

// ---------------------------------------------------------------------------
// The cloud's Resume notice
// ---------------------------------------------------------------------------

/// Where Resume goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeTarget {
    /// A talk show rejoins its room (`talkShow.resumeRoom`): no local
    /// session, so no local source can block it.
    Room,
    /// A solo show's own start (`resumeCloudShow`), bound to the live show,
    /// with no dialog. Never Go Live.
    CloudShow,
}

/// `CloudResumeSlot` and `CloudResumeNotice`, drawn above Session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudResumeCardView {
    /// The words, after `rejoiningResumeNotice` while the Studio rejoins.
    pub notice: ResumeNotice,
    pub resume_label: &'static str,
    pub resume_enabled: bool,
    /// Why Go Live can't run, said on hover (not while pending).
    pub resume_hover: Option<String>,
    pub resume_target: ResumeTarget,
    pub end_label: &'static str,
    /// End livestream never waits for a rejoin.
    pub end_enabled: bool,
}

/// What the slot reads.
#[derive(Debug, Clone, Copy, Default)]
pub struct CloudResumeInputs<'a> {
    pub status: Option<&'a CloudStatus>,
    /// A local session runs (the notice is then away).
    pub session_active: bool,
    /// The talk show is asking for its room back by itself after a backend
    /// restart (`talkShow.rejoining`).
    pub talk_rejoining: bool,
    /// A start is on its way.
    pub pending: bool,
    /// Why Go Live can't run right now.
    pub blocked_reason: Option<&'a str>,
}

/// `CloudResumeSlot`: `None` when no show waits.
pub fn cloud_resume_card(inputs: CloudResumeInputs<'_>) -> Option<CloudResumeCardView> {
    let notice = cloud_resume_notice(inputs.status, inputs.session_active)?;
    let talk = inputs
        .status
        .and_then(|status| status.show.as_ref())
        .is_some_and(|show| show.kind.as_deref() == Some("talk"));
    let blocked = if talk { None } else { inputs.blocked_reason };
    let rejoining = talk && inputs.talk_rejoining && notice.action == NoticeAction::Resume;
    let notice = if rejoining {
        rejoining_resume_notice(notice)
    } else {
        notice
    };
    Some(CloudResumeCardView {
        resume_label: notice_action_label(&notice, inputs.pending, rejoining),
        resume_enabled: !(inputs.pending || rejoining || blocked.is_some()),
        resume_hover: blocked.filter(|_| !inputs.pending).map(str::to_string),
        resume_target: if talk {
            ResumeTarget::Room
        } else {
            ResumeTarget::CloudShow
        },
        end_label: END_LIVESTREAM_LABEL,
        end_enabled: !inputs.pending,
        notice,
    })
}

/// The notice's End livestream question: the same words every in-app stop
/// asks, and `Studio::end_cloud_show` on yes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndCloudShowQuestion {
    pub title: &'static str,
    pub description: &'static str,
    pub confirm_label: &'static str,
    pub cancel_label: &'static str,
    /// Both buttons wait while the end runs.
    pub enabled: bool,
}

pub fn end_cloud_show_question(ending: bool) -> EndCloudShowQuestion {
    EndCloudShowQuestion {
        title: END_LIVESTREAM_TITLE,
        description: END_CLOUD_SHOW_DESCRIPTION,
        confirm_label: if ending {
            ENDING_LABEL
        } else {
            END_LIVESTREAM_LABEL
        },
        cancel_label: KEEP_STREAMING_LABEL,
        enabled: !ending,
    }
}

// ---------------------------------------------------------------------------
// The talk show's room
// ---------------------------------------------------------------------------

/// `CloudRoomStatus`, the fields the Studio screen reads. The room's people,
/// stage and requests are the Guests screen's.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RoomFacts {
    phase: String,
    live: bool,
    connected: bool,
    host_away: bool,
    door_open: bool,
    message: Option<String>,
}

/// `CloudRecordingStatus` (D10): the cloud recording of the program.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RecordingFacts {
    active: bool,
    since: Option<String>,
    seconds: u64,
    problem: Option<String>,
}

fn read<T: Default + for<'de> Deserialize<'de>>(value: Option<&Value>) -> Option<T> {
    value.map(|value| serde_json::from_value(value.clone()).unwrap_or_default())
}

/// Record's words while the room's cloud recording runs (`recordStopLabel`).
pub const STOP_CLOUD_RECORDING_LABEL: &str = "Stop recording";
/// `RecordButton`'s `stopping` words.
pub const STOPPING_LABEL: &str = "Stopping…";

/// The transport's own outputs while the room is open (`talkShowOutputs`):
/// the cloud recording and the room's platform legs, and Stop recording
/// runs `talkShow.stopCloudRecording` (`Studio::stop_cloud_recording`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TalkShowOutputs {
    pub recording: bool,
    pub live: bool,
    /// Stop recording's request is out: Record reads "Stopping…"
    /// (`stopRequestPending`).
    pub stopping: bool,
}

/// The talk show's room as the Studio screen reads it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TalkShowRoomView {
    /// `closed`, `opening`, `open` or `closing`; `closed` with no room.
    pub phase: String,
    pub open: bool,
    /// On air: the runner holds platform legs for this room (never its
    /// phase).
    pub live: bool,
    /// The runner is in the LiveKit room.
    pub connected: bool,
    pub host_away: bool,
    pub door_open: bool,
    pub message: Option<String>,
    /// The cloud recording of the program runs.
    pub recording: bool,
    pub recording_since: Option<String>,
    pub recording_seconds: u64,
    pub recording_problem: Option<String>,
    /// `Studio::stop_cloud_recording` is waiting on the backend.
    pub recording_stopping: bool,
    /// Plan 224 D7 (C-G5): the Show stage replaces the Preview while the
    /// room is open.
    pub preview_replaced: bool,
    /// `host:<showId>` while the room is open, for "You" on the stage.
    pub host_identity: Option<String>,
    /// The Session section's Guests row shows (`GuestsSessionRow`).
    pub guests_row: bool,
}

impl TalkShowRoomView {
    /// `StudioTransport`'s `talkShowOutputs`: only while the room is open.
    pub fn transport_outputs(&self) -> Option<TalkShowOutputs> {
        self.open.then(|| TalkShowOutputs {
            recording: self.recording,
            live: self.live,
            stopping: self.recording_stopping,
        })
    }
}

/// `talk_show_room` over the Studio's whole cloud state: the status, and
/// whether Stop recording's request is out.
pub fn talk_show_room_in(state: &CloudState) -> TalkShowRoomView {
    TalkShowRoomView {
        recording_stopping: state.recording_stop_pending,
        ..talk_show_room(state.status.as_ref())
    }
}

/// Whether a status says the cloud recording runs (`cloudStatus.recording.active`).
pub fn cloud_recording_active(status: Option<&CloudStatus>) -> bool {
    read::<RecordingFacts>(status.and_then(|status| status.recording.as_ref()))
        .is_some_and(|recording| recording.active)
}

/// `use-talk-show-room.ts`'s reading of `cloudStatus.room` and `.recording`.
pub fn talk_show_room(status: Option<&CloudStatus>) -> TalkShowRoomView {
    let room: Option<RoomFacts> = read(status.and_then(|status| status.room.as_ref()));
    let recording: RecordingFacts =
        read(status.and_then(|status| status.recording.as_ref())).unwrap_or_default();
    let room = room.unwrap_or_default();
    let phase = if room.phase.is_empty() {
        "closed".to_string()
    } else {
        room.phase
    };
    let open = phase == "open";
    let show_id = status
        .and_then(|status| status.show.as_ref())
        .map(|show| show.id.as_str())
        .filter(|id| !id.is_empty());
    TalkShowRoomView {
        open,
        live: room.live,
        connected: room.connected,
        host_away: room.host_away,
        door_open: room.door_open,
        message: room.message,
        recording: recording.active,
        recording_since: recording.since,
        recording_seconds: recording.seconds,
        recording_problem: recording.problem,
        recording_stopping: false,
        preview_replaced: open,
        host_identity: show_id.filter(|_| open).map(|id| format!("host:{id}")),
        guests_row: open,
        phase,
    }
}

// ---------------------------------------------------------------------------
// The Preview stage
// ---------------------------------------------------------------------------

/// `PreviewWindowState['mode']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PreviewMode {
    #[default]
    Docked,
    Floating,
}

/// `PreviewWindowState`, the fields the Studio's stage reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PreviewWindowState {
    pub open: bool,
    /// The remembered mode: the Preview shortcut opens the window in it.
    pub mode: PreviewMode,
    pub always_on_top: bool,
}

/// What a stage button does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewAction {
    /// Moves the open, floating Preview into the stage (`setPreviewWindowMode('docked')`).
    Stick,
    /// Shows the open window, or opens it in the remembered mode.
    BringToFront,
    Close,
    /// Opens the closed Preview stuck to the app.
    OpenDocked,
    /// Opens the closed Preview in its own window.
    OpenFloating,
    /// The no-surface path's Open preview.
    Open,
    /// The no-surface path's Retry preview (when its words say it can).
    Retry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ButtonLook {
    Primary,
    Secondary,
    Outline,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewButton {
    pub label: &'static str,
    pub action: PreviewAction,
    pub look: ButtonLook,
    /// The Preview shortcut's keys ride on this button.
    pub shortcut: bool,
}

pub const SHOW_HERE_LABEL: &str = "Show here";
pub const BRING_TO_FRONT_LABEL: &str = "Bring to front";
pub const CLOSE_PREVIEW_LABEL: &str = "Close Preview";
pub const OPEN_IN_ITS_OWN_WINDOW_LABEL: &str = "Open in its own window";
pub const OPEN_PREVIEW_LABEL: &str = "Open preview";
pub const RETRY_PREVIEW_LABEL: &str = "Retry preview";
pub const KEEP_ON_TOP_LABEL: &str = "Keep on top of other apps";
pub const PREVIEW_SECTION_TITLE: &str = "Preview";
/// `PREVIEW_REPLACED_BY_SHOW_STAGE` (`preview-stage.tsx`): the Show stage's
/// card while the talk-show room is open (P122 / P147).
pub const PREVIEW_REPLACED_BY_SHOW_STAGE: &str =
    "The Show stage replaces the Preview while the room is open.";

/// The Studio's Preview stage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewStageView {
    /// Stuck to the app: the native surface is the pane, with no section
    /// header; the docked frame's own row carries the dock actions.
    pub docked: bool,
    /// The section's title while not docked (the stage itself offers Open,
    /// Stick, Pop out and Close: no header icons repeat them).
    pub section_title: Option<&'static str>,
    /// The detached card's buttons; empty while docked.
    pub buttons: Vec<PreviewButton>,
    /// "Keep on top of other apps" and its switch, while the window floats.
    pub keep_on_top: Option<bool>,
}

/// `StudioPreviewPanel` and `DetachedPreviewCard`'s buttons. `retryable`
/// is the no-surface words' own flag (`previewDisabledCopy`). The
/// permission button and the words are the preview crate's.
pub fn preview_stage(
    window: PreviewWindowState,
    native_surface: bool,
    retryable: bool,
) -> PreviewStageView {
    let docked = native_surface && window.open && window.mode == PreviewMode::Docked;
    if docked {
        return PreviewStageView {
            docked,
            section_title: None,
            buttons: Vec::new(),
            keep_on_top: None,
        };
    }
    let button = |label, action, look, shortcut| PreviewButton {
        label,
        action,
        look,
        shortcut,
    };
    let (buttons, keep_on_top) = match (native_surface, window.open) {
        (true, true) => (
            vec![
                button(
                    SHOW_HERE_LABEL,
                    PreviewAction::Stick,
                    ButtonLook::Primary,
                    false,
                ),
                button(
                    BRING_TO_FRONT_LABEL,
                    PreviewAction::BringToFront,
                    ButtonLook::Secondary,
                    false,
                ),
                button(
                    CLOSE_PREVIEW_LABEL,
                    PreviewAction::Close,
                    ButtonLook::Outline,
                    false,
                ),
            ],
            Some(window.always_on_top),
        ),
        (true, false) => (
            vec![
                button(
                    SHOW_HERE_LABEL,
                    PreviewAction::OpenDocked,
                    ButtonLook::Primary,
                    window.mode == PreviewMode::Docked,
                ),
                button(
                    OPEN_IN_ITS_OWN_WINDOW_LABEL,
                    PreviewAction::OpenFloating,
                    ButtonLook::Outline,
                    window.mode == PreviewMode::Floating,
                ),
            ],
            None,
        ),
        (false, open) => {
            let mut buttons = Vec::new();
            if !open {
                buttons.push(button(
                    OPEN_PREVIEW_LABEL,
                    PreviewAction::Open,
                    ButtonLook::Outline,
                    true,
                ));
            }
            if retryable {
                buttons.push(button(
                    RETRY_PREVIEW_LABEL,
                    PreviewAction::Retry,
                    ButtonLook::Outline,
                    false,
                ));
            }
            (buttons, None)
        }
    };
    PreviewStageView {
        docked,
        section_title: Some(PREVIEW_SECTION_TITLE),
        buttons,
        keep_on_top,
    }
}

#[cfg(test)]
#[path = "screen_views_tests.rs"]
mod tests;
