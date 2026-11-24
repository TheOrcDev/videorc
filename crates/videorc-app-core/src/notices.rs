//! Toasts from the session (plan 260 S1.6a, from `videorc-rust`'s plan 220
//! S3.0f): the news the session, the backend and the app give the streamer,
//! as Electron's renderer toasts it, in plain data. The app turns a
//! [`Notice`] into the main window's toast and runs its buttons.
//!
//! **Plan 250 (#1528) moved most of this news behind the bell.** Today's
//! Electron shows one entry per subject in the notification centre and pops
//! up only an urgent one while recording or live, a press's answer, and a
//! refused start. That routing (`lib/notifications/*`, `notify.ts`,
//! `quiet-while-live.ts`, `user-pressed.ts`) lands with the notification
//! centre in S1.6e; until then this module keeps the pre-bell toasts, with
//! the words and rules caught up where they don't depend on the bell.
//!
//! Ported, word for word:
//!
//! - `lib/toast.ts`: the raw-text guard (`guardToastText`, S3.0h: a
//!   provider's HTML, escaped entities or JSON never reach a toast; the raw
//!   text goes to the log and to Copy, and the toast offers Export support
//!   bundle), the durations (`defaultToastDuration`) and the Copy an error
//!   toast offers, after the durations ([`ToastRequest::finish`]).
//! - `lib/notify-once.ts`: one toast per key within 30 s ([`NotifyOnce`]).
//! - `lib/session-runtime-recovery.ts`: `showSessionFinished` ("Recording
//!   saved", the end of the stream's live news, the microphone notice's
//!   `ended` phase), `showRecordingFailure`, `microphoneLossPresentation` and
//!   `showMicrophoneLoss`, `showSessionHealthEvent` with the startup, quality,
//!   audio and live output news and the separate files, `showBackendLifecycle`,
//!   `showPremiumUpgrade`, `showPlaybackProblem`, and the recovery after a
//!   reconnect (`sessionRuntimeRecoveryPlan`, `completeSessionRuntimeRecovery`).
//! - `lib/session-runtime-notice.ts`: the microphone notice's titles.
//! - `lib/session-start-failure.ts`: the refused start's toast with Retry.
//! - `lib/studio-health.ts`: `recordingStartupHealthToast`.
//! - `lib/separate-source-recordings-view.ts`: `separateFileFailedToast`.
//! - `lib/stream-target-notices.ts` and `lib/studio-toasts.ts`: one toast per
//!   destination that stops, reconnects, isn't received or comes back.
//! - `lib/finalization-toast.ts`: the MP4 export after a take.
//! - `lib/replay-buffer.ts` and `shared/clip-marks.ts`: the clip saved, a
//!   save that failed, the ring that stopped, a clip mark.
//! - `lib/session-stop.ts`: "Press again to end the livestream".
//!
//! A button whose page or window the Rust app does not have yet is left out
//! rather than shown dead: none today. Open Health joined with Health
//! (S3.0g), Resume System audio with S3.1d, Open in Library and Retry export
//! with the Library (S3.7a), and Open Output with the Output page (S3.6a).
//! `docs/rust-ui/screens.md` (toasts) lists them.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use regex::Regex;
use serde::Deserialize;
use videorc_protocol::streaming::StreamTargetState;
use videorc_protocol::{
    ClipMarkedEvent, HealthEvent, HealthLevel, RecordingFinalizationEvent,
    RecordingFinalizationState, RecordingState, RecordingStatus, ReplayBufferState,
    ReplaySaveFailedEvent, ReplaySavedEvent, ReplayStateEvent, SessionListItem,
};

use crate::studio::session::{
    END_LIVESTREAM_ARMED_TOAST, RECORDING_STOPPED_UNEXPECTEDLY_TOAST_ID, RecordingFailedNotice,
    SESSION_START_FAILED_TOAST_ID, SESSION_START_FAILED_TOAST_TITLE, SessionActivity,
    SessionEffect, SessionStartFailure, StopRequest, session_is_live, session_is_replay_only,
    session_start_failed_title,
};
use crate::studio::timecode::format_timecode;
use crate::supervisor::{BackendState, GAVE_UP_REASON};

// ── What a toast is ─────────────────────────────────────────────────────

/// The toast's type: it picks the icon and colours it, nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeKind {
    /// `toast.message`: no icon.
    Message,
    Success,
    Info,
    Warning,
    Error,
    /// `toast.loading`: the spinner; it never times out on its own.
    Loading,
}

/// How long a toast stays up, resolved (`defaultToastDuration`, or the
/// caller's explicit duration).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeLifetime {
    For(Duration),
    /// sonner's `Infinity`: until it is acted on or closed.
    UntilClosed,
}

/// What a toast's button does. The app runs it; the toast closes after.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoticeAction {
    /// Play: the recording in the system's player (Electron's
    /// `openManagedSession`). Without a session there is nothing to open.
    PlayRecording { session_id: Option<String> },
    /// Show in Finder (Explorer, the folder): the session's file.
    RevealSession { session_id: String },
    /// Retry: the start that failed, again (`retrySessionStart`).
    RetryStart,
    /// View Premium: the Premium page in the browser.
    OpenUrl { url: String },
    /// Copy: the toast's words on the clipboard.
    Copy { text: String },
    /// S3.0g: Open Health (`openHealthToastAction`), the door's one name.
    OpenHealth,
    /// S3.0g: Show in Finder for an exported support bundle (main's
    /// `revealSupportBundle`: only a bundle file in the backend's
    /// `support-bundles` folder).
    RevealSupportBundle { path: String },
    /// S3.0h: Export support bundle, on a toast whose details the guard
    /// withheld (`registerSupportBundleExport`'s exporter: Health's export).
    ExportSupportBundle,
    /// S3.0j: Sign in (`beginVideorcSignIn`): the account's sign-in in the
    /// browser.
    SignIn,
    /// S3.1g: a page of the main window (`openWorkspaceTab`), offered only
    /// while the page is in this build.
    OpenPage(crate::nav::PageId),
    /// S3.1g: Undo on "Chat hidden in Studio": Chat in Studio back on.
    ShowStudioChat,
    /// S3.1c: Use it on "{device} is back": the source a stand-in held for,
    /// switched back.
    UseSource {
        kind: crate::studio::source_selection::SourceKind,
        device_id: String,
    },
    /// S3.1d: Resume on "System audio paused" (plan 076): System audio on
    /// again (`requestSystemAudioResume`).
    ResumeSystemAudio,
    /// S3.7a: Open in Library (`openWorkspaceTab('library', sessionId)`):
    /// the Library, showing and focusing the recording when there is one.
    OpenLibrary { session_id: Option<String> },
    /// S3.7a: Retry export on "MP4 export failed" (`remuxSession`).
    RetryExport { session_id: String },
    /// S3.6c: "Use 1080p · 30 fps" on "… is too heavy for this computer":
    /// the recording preset the performance check recommends.
    ApplyVideoPreset { preset: String },
    /// S3.10c: Buddy → Clean cut on a recording (`openCleanCut`): an
    /// automatic cut's Open Clean cut.
    OpenCleanCut { session_id: String },
    /// S3.10f: the ready toast's Review (`openCleanCut({ review: true })`):
    /// that cut's review on Buddy → Clean cut.
    ReviewCleanCut(Box<CleanCutReviewAsk>),
}

/// S3.10f: which cut the ready toast's Review opens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanCutReviewAsk {
    pub session_id: String,
    pub job_id: String,
    pub condensed: bool,
}

/// A toast's button: its words and what it does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoticeButton {
    pub label: String,
    pub action: NoticeAction,
}

/// What closing a toast with its close button does (sonner's `onDismiss`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeClose {
    /// The refused start's toast: the Session line goes with it.
    DismissStartFailure,
}

/// One toast, ready to show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    /// One id per kind of toast: a newer one replaces the older in place.
    /// `None` stacks.
    pub id: Option<String>,
    pub kind: NoticeKind,
    pub title: String,
    pub description: Option<String>,
    pub action: Option<NoticeButton>,
    pub cancel: Option<NoticeButton>,
    pub lifetime: NoticeLifetime,
    pub on_close: Option<NoticeClose>,
}

/// What the main window's toaster does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoticeCommand {
    Show(Notice),
    /// `toast.dismiss(id)`.
    Dismiss(String),
}

impl NoticeCommand {
    pub fn notice(&self) -> Option<&Notice> {
        match self {
            NoticeCommand::Show(notice) => Some(notice),
            NoticeCommand::Dismiss(_) => None,
        }
    }
}

fn ms(millis: u64) -> NoticeLifetime {
    NoticeLifetime::For(Duration::from_millis(millis))
}

/// The words.
pub mod copy {
    /// `COPY_ERROR_LABEL`: every error toast offers it.
    pub const COPY_ERROR: &str = "Copy";
    /// S3.5e: `showXPlaybackEvent` (`lib/session-runtime-recovery.ts`).
    pub const X_WATCHABLE: &str = "Viewers can watch your X broadcast";
    pub const X_PREPARING: &str = "X is still preparing your stream";
    pub const X_PREPARING_DESCRIPTION: &str = "Viewers may see a loading spinner for a few minutes. Keep streaming. Videorc keeps checking.";
    pub const X_NEVER_SHOWED: &str = "X never showed your stream";
    pub const X_NEVER_SHOWED_DESCRIPTION: &str = "Viewers saw a loading spinner. Your local recording is unaffected; the next Go Live uses a replacement source if this repeats.";
    /// `sessionRuntimeNoticeTitle` for a session that died.
    pub const LIVESTREAM_STOPPED_UNEXPECTEDLY: &str = "Livestream stopped unexpectedly";
    pub const RECORDING_STOPPED_UNEXPECTEDLY: &str = "Recording stopped unexpectedly";
    /// `recordingFailurePresentation`'s message when the backend gave none.
    pub const COULDNT_FINISH_LIVESTREAM: &str = "Videorc couldn't finish this livestream.";
    pub const COULDNT_FINISH_RECORDING: &str = "Videorc couldn't finish this recording.";
    pub const RECORDING_SAVED: &str = "Recording saved";
    pub const PLAY: &str = "Play";
    /// S3.7a: the Library's door on a toast.
    pub const OPEN_IN_LIBRARY: &str = "Open in Library";
    /// S3.7a: "MP4 export failed"'s button.
    pub const RETRY_EXPORT: &str = "Retry export";
    pub const RETRY: &str = "Retry";
    pub const VIEW_PREMIUM: &str = "View Premium";
    pub const PLAYBACK_PROBLEM: &str = "Couldn't play this recording";
    pub const BACKEND_RECOVERING: &str = "Videorc is recovering";
    pub const BACKEND_FAILED: &str = "Videorc can't recover on its own";
    pub const BACKEND_LOST: &str = "Videorc needs a restart";
    pub const QUIT_AND_REOPEN: &str = "Quit and reopen Videorc.";
    pub const DROPPED_FRAMES: &str = "This recording has dropped frames";
    pub const NO_SOUND: &str = "Recording has no sound";
    pub const MICROPHONE_SILENT: &str = "Microphone is silent";
    pub const SEPARATE_FILES_SHED_TITLE: &str =
        "Separate files stopped so the main recording keeps up";
    pub const SEPARATE_FILES_SHED_DESCRIPTION: &str = "Your Mac fell behind encoding the separate files. The separate files keep what they recorded, and your Combined recording keeps going.";
    pub const MP4_FINALIZING_DESCRIPTION: &str =
        "Your recording is safe. Long recordings can take several minutes to save as MP4.";
    pub const MP4_READY: &str = "MP4 ready";
    pub const MP4_EXPORT_FAILED: &str = "MP4 export failed";
    pub const ORIGINAL_RECORDING_SAFE: &str = "Your original recording is safe.";
    pub const CLIP_SAVED: &str = "Clip saved";
    pub const CLIP_SAVE_FAILED: &str = "Couldn't save the clip";
    pub const CLIPS_STOPPED: &str = "Clips stopped";
    /// `CLIPS_LABEL`: the Output section and its switch (CONTEXT.md: a
    /// clip is the saved video, Clips the section; never "replay").
    pub const CLIPS: &str = "Clips";
    /// `KEEP_LAST_SECONDS_LABEL`: the Clips switch.
    pub const KEEP_LAST_SECONDS: &str = "Keep the last seconds";
    /// `CLIP_MARK_IN_REPORT`.
    pub const CLIP_MARK_IN_REPORT: &str = "It's in your stream report in Buddy.";
    pub const CLIPS_OFF_NOTHING_RECORDING: &str = "Clips are off, and nothing is recording.";
    pub const CLIPS_OFF_DESCRIPTION: &str =
        "Turn on Keep the last seconds on the Output page, or start a recording.";
    pub const OTHER_DESTINATION_KEEPS_STREAMING: &str = "The other destination keeps streaming.";
    pub const NO_OTHER_DESTINATION: &str =
        "No other destination is streaming, so viewers see nothing.";
    pub const VIEWERS_SEE_NOTHING: &str = "Viewers see nothing until it's back.";
    pub const NOT_RECEIVING_DESCRIPTION: &str =
        "Videorc is still sending it. Check the platform’s live dashboard.";
    /// S3.0g: the support bundle's toasts (`exportSupportBundle`), whose
    /// words live with the export (`studio::support_bundle_copy`).
    pub use crate::studio::support_bundle_copy::{
        EXPORT_FAILED as SUPPORT_BUNDLE_EXPORT_FAILED, EXPORTED as SUPPORT_BUNDLE_EXPORTED,
        REVEAL_FAILED as SUPPORT_BUNDLE_REVEAL_FAILED, UNKNOWN_REASON,
    };
    /// `OFFLINE_REASON` (`lib/user-error.ts`), the same words as a start's.
    pub const OFFLINE_REASON: &str = crate::studio::start_blocked_copy::RECONNECTING;
    /// S3.0h: `TOAST_DETAILS_SAVED`, what a toast says in place of a
    /// withheld message.
    pub const DETAILS_SAVED: &str = "Details were saved for support.";
    /// S3.0h: `SUPPORT_BUNDLE_LABEL`, the action a withheld message offers
    /// (Health's button, `health_page::SUPPORT_BUNDLE_LABEL`, says the same).
    pub const EXPORT_SUPPORT_BUNDLE: &str = "Export support bundle";
}

/// S3.0g: "Support bundle exported" with the file's name, and Show in
/// Finder, for 15 s (`exportSupportBundle`).
pub fn support_bundle_exported(path: &str) -> NoticeCommand {
    let name = std::path::Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_string();
    NoticeCommand::Show(
        ToastRequest::success(copy::SUPPORT_BUNDLE_EXPORTED)
            .description(name)
            .action(
                reveal_in_file_manager_label(),
                NoticeAction::RevealSupportBundle {
                    path: path.to_string(),
                },
            )
            .duration(ms(15_000))
            .finish(),
    )
}

/// S3.0g: Show in Finder found no bundle to show (`reportError(error,
/// {action: 'show', object: 'the support bundle'})`).
pub fn support_bundle_reveal_failed() -> Notice {
    ToastRequest::error(copy::SUPPORT_BUNDLE_REVEAL_FAILED)
        .description(copy::UNKNOWN_REASON)
        .action(
            crate::studio::health_page::OPEN_HEALTH_LABEL,
            NoticeAction::OpenHealth,
        )
        .duration(NoticeLifetime::For(WITH_DESCRIPTION))
        .finish()
}

/// S3.0g: the export failed. While the engine is away it says so
/// (`exportSupportBundle`'s own toast); otherwise `reportError`'s unknown
/// cause: the next step, with the door to Health on the toast's timed life.
pub fn support_bundle_export_failed(offline: bool) -> NoticeCommand {
    let request = ToastRequest::error(copy::SUPPORT_BUNDLE_EXPORT_FAILED);
    NoticeCommand::Show(
        if offline {
            request.description(copy::OFFLINE_REASON)
        } else {
            request
                .description(copy::UNKNOWN_REASON)
                .action(
                    crate::studio::health_page::OPEN_HEALTH_LABEL,
                    NoticeAction::OpenHealth,
                )
                .duration(NoticeLifetime::For(WITH_DESCRIPTION))
        }
        .finish(),
    )
}

/// `VIDEORC_PREMIUM_URL` (the production origin).
pub const VIDEORC_PREMIUM_URL: &str = "https://www.videorc.com/premium";

/// The toast ids the session's news shares.
pub mod ids {
    pub const MICROPHONE_INPUT_LOST: &str = "microphone-input-lost";
    /// S3.5e: X's playback check (`notifyOnce('x-playback', …)`).
    pub const X_PLAYBACK: &str = "x-playback";
    pub const STREAM_OUTPUT: &str = "stream-output";
    /// Plan 218: the stream's frame rate, and what its connection carries.
    pub const STREAM_DELIVERY: &str = "stream-delivery";
    pub const STREAM_UPLINK: &str = "stream-uplink";
    pub const SCREEN_CAPTURE: &str = "screen-capture";
    pub const HOST_OVERLOADED: &str = "host-overloaded";
    pub const DISK_SPACE_LOW: &str = "disk-space-low";
    pub const SYSTEM_AUDIO_ECHO: &str = "system-audio-echo-paused";
    pub const RECORDING_STARTUP_UNSTEADY: &str = "recording-startup-cadence-unsteady";
    pub const BACKEND_LIFECYCLE: &str = "backend-lifecycle";
    pub const END_LIVESTREAM_ARMED: &str = "end-livestream-armed";
    pub const GLOBAL_SHORTCUTS_CONFLICT: &str = "global-shortcuts-conflict";
    pub const CLIPS: &str = "clips";
    pub const CLIP_MARKED: &str = "clip-marked";
}

/// `revealInFileManagerLabel`: this computer's file manager.
pub fn reveal_in_file_manager_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "Show in Finder"
    } else if cfg!(target_os = "windows") {
        "Show in Explorer"
    } else {
        "Show in folder"
    }
}

// ── lib/toast.ts ────────────────────────────────────────────────────────

/// sonner's `TOAST_LIFETIME`: a one-line toast.
pub const ONE_LINE: Duration = Duration::from_millis(4_000);
/// `TOAST_WITH_DESCRIPTION_MS`.
pub const WITH_DESCRIPTION: Duration = Duration::from_millis(8_000);

/// A toast as a caller asks for it (`toast.<kind>(title, options)`), before
/// `lib/toast.ts` resolves its duration and gives an error its Copy.
#[derive(Debug, Clone)]
pub struct ToastRequest {
    kind: NoticeKind,
    title: String,
    id: Option<String>,
    description: Option<String>,
    action: Option<NoticeButton>,
    cancel: Option<NoticeButton>,
    duration: Option<NoticeLifetime>,
    on_close: Option<NoticeClose>,
}

impl ToastRequest {
    pub fn new(kind: NoticeKind, title: impl Into<String>) -> Self {
        Self {
            kind,
            title: title.into(),
            id: None,
            description: None,
            action: None,
            cancel: None,
            duration: None,
            on_close: None,
        }
    }
    pub fn message(title: impl Into<String>) -> Self {
        Self::new(NoticeKind::Message, title)
    }
    pub fn success(title: impl Into<String>) -> Self {
        Self::new(NoticeKind::Success, title)
    }
    pub fn info(title: impl Into<String>) -> Self {
        Self::new(NoticeKind::Info, title)
    }
    pub fn warning(title: impl Into<String>) -> Self {
        Self::new(NoticeKind::Warning, title)
    }
    pub fn error(title: impl Into<String>) -> Self {
        Self::new(NoticeKind::Error, title)
    }
    pub fn loading(title: impl Into<String>) -> Self {
        Self::new(NoticeKind::Loading, title)
    }
    pub fn id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }
    /// A description only when there is one (`description: undefined`).
    pub fn maybe_description(mut self, description: Option<String>) -> Self {
        self.description = description;
        self
    }
    pub fn action(mut self, label: impl Into<String>, action: NoticeAction) -> Self {
        self.action = Some(NoticeButton {
            label: label.into(),
            action,
        });
        self
    }
    pub fn cancel(mut self, label: impl Into<String>, action: NoticeAction) -> Self {
        self.cancel = Some(NoticeButton {
            label: label.into(),
            action,
        });
        self
    }
    pub fn duration(mut self, lifetime: NoticeLifetime) -> Self {
        self.duration = Some(lifetime);
        self
    }
    pub fn on_close(mut self, close: NoticeClose) -> Self {
        self.on_close = Some(close);
        self
    }

    /// `guardOptions`: the title and the description through the raw-text
    /// guard (a withheld message offers Export support bundle when the
    /// toast has no action of its own: the Rust app's toasts are the main
    /// window's, which exports through Health), the duration from the
    /// toast's final shape (an explicit one wins; a loading toast takes
    /// none), then an error's Copy in the action slot, else the cancel slot.
    /// Copy alone never keeps an error up: the duration is settled before it.
    pub fn finish(self) -> Notice {
        // The raw text goes to the log (Electron's `console.warn`) and to
        // Copy, never to the toast.
        let mut withheld = Vec::new();
        let mut title = self.title;
        let guarded = guard_toast_text(&title);
        if let Some(raw) = guarded.withheld {
            eprintln!("[toast] withheld raw provider text from a toast title: {raw}");
            title = guarded.text;
            withheld.push(raw);
        }
        let mut description = self.description;
        if let Some(text) = description.as_deref() {
            let guarded = guard_toast_text(text);
            if let Some(raw) = guarded.withheld {
                eprintln!("[toast] withheld raw provider text from a toast description: {raw}");
                description = Some(guarded.text);
                withheld.push(raw);
            }
        }
        let mut action = self.action;
        let mut cancel = self.cancel;
        if action.is_none()
            && (title == copy::DETAILS_SAVED || description.as_deref() == Some(copy::DETAILS_SAVED))
        {
            action = Some(NoticeButton {
                label: copy::EXPORT_SUPPORT_BUNDLE.to_string(),
                action: NoticeAction::ExportSupportBundle,
            });
        }
        let lifetime = match (self.kind, self.duration) {
            (_, Some(explicit)) => explicit,
            (NoticeKind::Loading, None) => NoticeLifetime::UntilClosed,
            (_, None) if action.is_some() || cancel.is_some() => NoticeLifetime::UntilClosed,
            (_, None) if description.is_some() => NoticeLifetime::For(WITH_DESCRIPTION),
            (_, None) => NoticeLifetime::For(ONE_LINE),
        };
        if self.kind == NoticeKind::Error {
            let text = error_copy_text(&title, description.as_deref(), &withheld);
            if !text.is_empty() {
                let copy = NoticeButton {
                    label: copy::COPY_ERROR.to_string(),
                    action: NoticeAction::Copy { text },
                };
                if action.is_none() {
                    action = Some(copy);
                } else if cancel.is_none() {
                    cancel = Some(copy);
                }
                // With both slots taken Electron puts Copy after the
                // description; the Rust toast has no such place yet.
            }
        }
        Notice {
            id: self.id,
            kind: self.kind,
            title,
            description,
            action,
            cancel,
            lifetime,
            on_close: self.on_close,
        }
    }
}

/// `errorToastCopyText`: the words the toast shows, a line each, then each
/// raw text the guard withheld.
pub fn error_copy_text(title: &str, description: Option<&str>, withheld: &[String]) -> String {
    let mut lines = Vec::new();
    if !title.is_empty() {
        lines.push(title.to_string());
    }
    if let Some(description) = description.filter(|text| !text.is_empty()) {
        lines.push(description.to_string());
    }
    lines.extend(withheld.iter().map(|raw| format!("Details: {raw}")));
    lines.join("\n")
}

// ── lib/toast.ts: guardToastText ────────────────────────────────────────

/// What [`guard_toast_text`] made of a string: the words to show, and the
/// raw text when it altered it (`None` when it is clean).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardedText {
    pub text: String,
    pub withheld: Option<String>,
}

struct GuardPatterns {
    ipc_prefix: Regex,
    html_tag: Regex,
    entity: Regex,
    json_blob: Regex,
    whitespace: Regex,
}

fn guard_patterns() -> &'static GuardPatterns {
    static PATTERNS: OnceLock<GuardPatterns> = OnceLock::new();
    PATTERNS.get_or_init(|| GuardPatterns {
        // `ELECTRON_IPC_ERROR_PREFIX` (`lib/ipc-error-message.ts`).
        ipc_prefix: Regex::new(r"^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?")
            .expect("ipc prefix"),
        html_tag: Regex::new(r"</?[a-zA-Z!][^>]*>").expect("html tag"),
        entity: Regex::new(r"&(?:lt|gt|quot|amp|apos|#\d+|#x[0-9a-fA-F]+);").expect("entity"),
        json_blob: Regex::new(r#"[{\[]\s*["'][^"']*["']\s*:|"error"\s*:|\\"[a-zA-Z]+\\"\s*:"#)
            .expect("json blob"),
        whitespace: Regex::new(r"\s+").expect("whitespace"),
    })
}

/// `decodeEntity`: a known name, or a decimal or hex code point; anything
/// else stays as written.
fn decode_entity(entity: &str) -> String {
    let known = match entity {
        "&lt;" => Some("<"),
        "&gt;" => Some(">"),
        "&quot;" => Some("\""),
        "&amp;" => Some("&"),
        "&apos;" => Some("'"),
        _ => None,
    };
    if let Some(known) = known {
        return known.to_string();
    }
    let body = entity.trim_start_matches("&#").trim_end_matches(';');
    let code = match body.strip_prefix('x') {
        Some(hex) => u32::from_str_radix(hex, 16).ok(),
        None => body.parse::<u32>().ok(),
    };
    code.and_then(char::from_u32)
        .map(String::from)
        .unwrap_or_else(|| entity.to_string())
}

/// `guardToastText` (plan 174 S2.4, a backstop behind typed copy): strips
/// Electron's remote-method wrapper and HTML tags, decodes escaped
/// entities (and strips the tags they hid), and replaces anything that
/// still looks like a JSON blob with "Details were saved for support.".
pub fn guard_toast_text(raw: &str) -> GuardedText {
    let p = guard_patterns();
    let mut text = p.ipc_prefix.replace(raw, "").into_owned();
    let mut altered = text != raw;
    if p.html_tag.is_match(&text) {
        text = p.html_tag.replace_all(&text, " ").into_owned();
        altered = true;
    }
    if p.entity.is_match(&text) {
        text = p
            .entity
            .replace_all(&text, |caps: &regex::Captures<'_>| decode_entity(&caps[0]))
            .into_owned();
        altered = true;
    }
    // Decoding may have revealed tags (`&lt;a href…&gt;`): strip once more.
    if p.html_tag.is_match(&text) {
        text = p.html_tag.replace_all(&text, " ").into_owned();
        altered = true;
    }
    if p.json_blob.is_match(&text) || text.contains(['{', '}']) {
        text = copy::DETAILS_SAVED.to_string();
        altered = true;
    } else {
        text = p.whitespace.replace_all(&text, " ").trim().to_string();
        if altered && text.is_empty() {
            text = copy::DETAILS_SAVED.to_string();
        }
    }
    GuardedText {
        text,
        withheld: altered.then(|| raw.to_string()),
    }
}

// ── lib/notify-once.ts ──────────────────────────────────────────────────

/// `NOTIFY_ONCE_WINDOW_MS`.
pub const NOTIFY_ONCE_WINDOW: Duration = Duration::from_millis(30_000);

/// `notifyOnceId`: the same key within the window keeps its toast id (and
/// refreshes the window), so a producer that keeps firing stays one toast.
#[derive(Debug, Default)]
pub struct NotifyOnce {
    recent: HashMap<String, (Instant, String)>,
    sequence: u64,
}

impl NotifyOnce {
    pub fn id(&mut self, key: &str, now: Instant) -> String {
        if let Some((shown_at, id)) = self.recent.get(key).cloned()
            && now.saturating_duration_since(shown_at) < NOTIFY_ONCE_WINDOW
        {
            self.recent.insert(key.to_string(), (now, id.clone()));
            return id;
        }
        // A new key is the moment to forget the keys whose window passed.
        self.recent.retain(|_, (shown_at, _)| {
            now.saturating_duration_since(*shown_at) < NOTIFY_ONCE_WINDOW
        });
        self.sequence += 1;
        let id = format!("once:{key}:{}", self.sequence);
        self.recent.insert(key.to_string(), (now, id.clone()));
        id
    }
}

// ── the session's activity ──────────────────────────────────────────────

/// `SessionRuntimeActivity`: what the session did, or the Clips ring.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeActivity {
    Recording,
    LiveStream,
    RecordAndStream,
    Clips,
}

impl From<SessionActivity> for RuntimeActivity {
    fn from(activity: SessionActivity) -> Self {
        match activity {
            SessionActivity::Recording => RuntimeActivity::Recording,
            SessionActivity::LiveStream => RuntimeActivity::LiveStream,
            SessionActivity::RecordAndStream => RuntimeActivity::RecordAndStream,
        }
    }
}

impl RuntimeActivity {
    /// `activityIsLive`.
    pub fn is_live(self) -> bool {
        !matches!(self, RuntimeActivity::Recording | RuntimeActivity::Clips)
    }

    /// `activitySavesRecording`.
    pub fn saves_recording(self) -> bool {
        !matches!(self, RuntimeActivity::LiveStream | RuntimeActivity::Clips)
    }
}

// ── the session's end, and its failure ──────────────────────────────────

/// `showSessionFinished`'s "Recording saved": Play (the Library when it
/// won't play) and Open in Library, for 12 s.
pub fn recording_saved(session_id: Option<&str>) -> Notice {
    ToastRequest::success(copy::RECORDING_SAVED)
        .action(
            copy::PLAY,
            NoticeAction::PlayRecording {
                session_id: session_id.map(str::to_string),
            },
        )
        .cancel(
            copy::OPEN_IN_LIBRARY,
            NoticeAction::OpenLibrary {
                session_id: session_id.map(str::to_string),
            },
        )
        .duration(ms(12_000))
        .finish()
}

/// `showRecordingFailure`: the persistent "stopped unexpectedly", with the
/// file in the file manager when one was being saved.
pub fn recording_failure(notice: &RecordingFailedNotice) -> Vec<NoticeCommand> {
    let activity = RuntimeActivity::from(notice.activity);
    let mut request = ToastRequest::error(notice.title())
        .id(RECORDING_STOPPED_UNEXPECTEDLY_TOAST_ID)
        .description(notice.message.clone())
        .duration(NoticeLifetime::UntilClosed);
    if activity.saves_recording() {
        request = request.action(
            copy::OPEN_IN_LIBRARY,
            NoticeAction::OpenLibrary {
                session_id: notice.session_id.clone(),
            },
        );
    }
    if activity.saves_recording()
        && let Some(session_id) = &notice.session_id
        && notice.output_path.is_some()
    {
        request = request.cancel(
            reveal_in_file_manager_label(),
            NoticeAction::RevealSession {
                session_id: session_id.clone(),
            },
        );
    }
    vec![
        NoticeCommand::Dismiss(ids::MICROPHONE_INPUT_LOST.to_string()),
        NoticeCommand::Show(request.finish()),
    ]
}

/// `isPremiumUpgradeMessage`: `/\b(?:Videorc\s+)?Premium\b/i`.
pub fn is_premium_upgrade_message(message: &str) -> bool {
    let lowered = message.to_ascii_lowercase();
    let bytes = lowered.as_bytes();
    let word = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    lowered.match_indices("premium").any(|(at, found)| {
        let before = at.checked_sub(1).map(|i| bytes[i]);
        let after = bytes.get(at + found.len()).copied();
        !before.is_some_and(word) && !after.is_some_and(word)
    })
}

/// `showPremiumUpgrade`: a plan limit is news about Premium, not a failure.
pub fn premium_upgrade(title: &str, description: Option<&str>) -> Notice {
    ToastRequest::info(title)
        .maybe_description(description.map(str::to_string))
        .duration(ms(15_000))
        .action(
            copy::VIEW_PREMIUM,
            NoticeAction::OpenUrl {
                url: VIDEORC_PREMIUM_URL.to_string(),
            },
        )
        .finish()
}

/// `reportSessionStartFailure`'s toast (`sessionStartFailureToastOptions`):
/// Retry, until it is acted on or closed; closing it dismisses the Session
/// line too. A Premium refusal offers the upgrade instead.
pub fn start_failure(failure: &SessionStartFailure) -> Notice {
    if is_premium_upgrade_message(&failure.message) {
        return premium_upgrade(&failure.message, None);
    }
    ToastRequest::error(session_start_failed_title(failure.kind))
        .id(SESSION_START_FAILED_TOAST_ID)
        .description(failure.message.clone())
        .duration(NoticeLifetime::UntilClosed)
        .action(copy::RETRY, NoticeAction::RetryStart)
        .on_close(NoticeClose::DismissStartFailure)
        .finish()
}

/// `showPlaybackProblem` without the reason (a Play that couldn't, where no
/// Library is the answer: the Library's own Play).
pub fn playback_problem(session_id: &str) -> Notice {
    ToastRequest::error(copy::PLAYBACK_PROBLEM)
        .id(format!("playback-problem:{session_id}"))
        .action(
            reveal_in_file_manager_label(),
            NoticeAction::RevealSession {
                session_id: session_id.to_string(),
            },
        )
        .finish()
}

/// "Press again to end the livestream" for the arm window, plain.
pub fn end_livestream_armed() -> Notice {
    ToastRequest::message(END_LIVESTREAM_ARMED_TOAST)
        .id(ids::END_LIVESTREAM_ARMED)
        .duration(NoticeLifetime::For(
            crate::studio::session::END_LIVESTREAM_ARM_WINDOW,
        ))
        .finish()
}

/// The global shortcuts registrar's conflict toast (S2.6a's words).
pub fn global_shortcut_conflict(title: &str, description: &str) -> Notice {
    ToastRequest::error(title)
        .description(description)
        .id(ids::GLOBAL_SHORTCUTS_CONFLICT)
        .finish()
}

// ── showBackendLifecycle ────────────────────────────────────────────────

/// `showBackendLifecycle` from the supervisor: a restart under way, a
/// backend that will not come back, and the running one dismissing either.
/// The Rust supervisor's one `Failed` state is Electron's `failed` when the
/// restarts gave up, and its `lost` otherwise (the backend's ownership).
pub fn backend_lifecycle(state: &BackendState) -> Option<NoticeCommand> {
    match state {
        BackendState::Restarting { attempt, .. } => Some(NoticeCommand::Show(
            ToastRequest::warning(copy::BACKEND_RECOVERING)
                .id(ids::BACKEND_LIFECYCLE)
                .description(format!("Restarting automatically (attempt {attempt})…"))
                .finish(),
        )),
        BackendState::Failed { reason, .. } => Some(NoticeCommand::Show(
            ToastRequest::error(if reason == GAVE_UP_REASON {
                copy::BACKEND_FAILED
            } else {
                copy::BACKEND_LOST
            })
            .id(ids::BACKEND_LIFECYCLE)
            .description(copy::QUIT_AND_REOPEN)
            .duration(NoticeLifetime::UntilClosed)
            .finish(),
        )),
        BackendState::Ready { .. } => {
            Some(NoticeCommand::Dismiss(ids::BACKEND_LIFECYCLE.to_string()))
        }
        BackendState::Starting { .. }
        | BackendState::Stopping { .. }
        | BackendState::Stopped { .. } => None,
    }
}

// ── the microphone notice (lib/session-runtime-notice.ts) ───────────────

/// Issue 1064: the bus reads the microphone as digital silence.
pub const MICROPHONE_SILENT_CODE: &str = "microphone-silent";

/// Where the session is when its microphone notice is raised.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicrophonePhase {
    Active,
    Ending,
    Ended,
}

/// One audio input the session lost.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioIssue {
    pub code: String,
    pub message: String,
}

/// The `microphone-input-lost` runtime notice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MicrophoneNotice {
    pub audio_issues: Vec<AudioIssue>,
    pub activity: RuntimeActivity,
    pub phase: MicrophonePhase,
    pub message: String,
    pub session_id: Option<String>,
}

/// `sessionRuntimeNoticeTitle` for the microphone notice.
pub fn microphone_notice_title(notice: &MicrophoneNotice) -> String {
    let clips = notice.activity == RuntimeActivity::Clips;
    let live = notice.activity.is_live();
    let ended = notice.phase == MicrophonePhase::Ended;
    if notice
        .audio_issues
        .iter()
        .all(|issue| issue.code == MICROPHONE_SILENT_CODE)
    {
        let title = if ended {
            if clips {
                "Microphone was silent: Clips contain silence"
            } else if live {
                "Microphone was silent during the livestream"
            } else {
                "Microphone was silent: saved recording contains silence"
            }
        } else if clips {
            "Your microphone is silent in Clips"
        } else if live {
            "Your microphone is silent on the livestream"
        } else {
            "Your microphone is silent in the recording"
        };
        return title.to_string();
    }
    if notice
        .audio_issues
        .iter()
        .any(|issue| issue.code != "microphone-input-lost")
    {
        let sources: HashSet<&str> = notice
            .audio_issues
            .iter()
            .map(|issue| {
                if issue.code.starts_with("microphone-") {
                    "microphone"
                } else if issue.code == "system-audio-lost" {
                    "system"
                } else {
                    "both"
                }
            })
            .collect();
        let subject = if sources.len() > 1 || sources.contains("both") {
            "Microphone and system audio lost"
        } else if sources.contains("system") {
            "System audio lost"
        } else {
            "Microphone audio couldn't be recorded"
        };
        return if ended {
            format!("{subject}: saved session has missing audio")
        } else {
            subject.to_string()
        };
    }
    let title = match (clips, notice.phase) {
        (true, MicrophonePhase::Ended) => "Microphone stopped: Clips contain silence",
        (true, MicrophonePhase::Ending) => "Microphone stopped: Clips finishing with silence",
        (true, MicrophonePhase::Active) => "Microphone stopped: Clips continue with silence",
        (false, MicrophonePhase::Ended) if live => "Microphone stopped during the livestream",
        (false, MicrophonePhase::Ended) => "Microphone stopped: saved recording contains silence",
        (false, MicrophonePhase::Ending) if live => "Microphone stopped as the livestream ends",
        (false, MicrophonePhase::Ending) => "Microphone stopped: finishing recording with silence",
        (false, MicrophonePhase::Active) if live => {
            "Microphone stopped: livestream continues with silence"
        }
        (false, MicrophonePhase::Active) => "Microphone stopped: recording continues with silence",
    };
    title.to_string()
}

/// The microphone notice's toast: a warning, until closed.
fn microphone_toast(notice: &MicrophoneNotice) -> Notice {
    ToastRequest::warning(microphone_notice_title(notice))
        .id(ids::MICROPHONE_INPUT_LOST)
        .description(notice.message.clone())
        .duration(NoticeLifetime::UntilClosed)
        .finish()
}

/// The runtime notice the Studio holds now (`sessionRuntimeNoticeRef`).
#[derive(Debug, Clone, Copy)]
pub enum CurrentNotice<'a> {
    None,
    /// "Stopped unexpectedly": it outranks the microphone.
    Failure,
    Microphone(&'a MicrophoneNotice),
}

/// `microphoneLossPresentation`: the notice for a lost (or silent) audio
/// input, when it belongs to the running session or the one that just
/// ended, once per input per session. `None` when it is not news.
pub fn microphone_loss_presentation(
    event: &HealthEvent,
    recording: &RecordingStatus,
    last_session_id: Option<&str>,
    last_activity: RuntimeActivity,
    current_dedupe_key: Option<&str>,
    current: CurrentNotice<'_>,
) -> Option<(String, MicrophoneNotice)> {
    let active = matches!(
        recording.state,
        RecordingState::Recording | RecordingState::Streaming
    );
    let correlated_active =
        active && (event.session_id.is_none() || event.session_id == recording.session_id);
    let correlated_terminal = event.session_id.is_some()
        && event.session_id.as_deref() == last_session_id
        && matches!(
            recording.state,
            RecordingState::Stopping | RecordingState::Idle
        );
    if !correlated_active && !correlated_terminal {
        return None;
    }
    let dedupe_key = event
        .session_id
        .clone()
        .or_else(|| last_session_id.map(str::to_string))
        .unwrap_or_else(|| "active-session".to_string());
    let previous: Vec<AudioIssue> = match current {
        CurrentNotice::Microphone(notice) if notice.session_id == event.session_id => {
            if notice.audio_issues.is_empty() {
                vec![AudioIssue {
                    code: "microphone-input-lost".to_string(),
                    message: notice.message.clone(),
                }]
            } else {
                notice.audio_issues.clone()
            }
        }
        _ => Vec::new(),
    };
    if previous
        .iter()
        .any(|issue| issue.code == event.code || issue.code == "audio-inputs-lost")
        || (current_dedupe_key == Some(dedupe_key.as_str())
            && matches!(current, CurrentNotice::None))
    {
        return None;
    }
    let mut audio_issues = previous;
    audio_issues.push(AudioIssue {
        code: event.code.clone(),
        message: event.message.clone(),
    });
    // Go Live reports `recording` with a stream URL: still a live session.
    // A buffer-only Clips session is not a recording.
    let activity = if session_is_replay_only(recording) {
        RuntimeActivity::Clips
    } else if active {
        SessionActivity::of(recording).into()
    } else {
        last_activity
    };
    let phase = if active {
        MicrophonePhase::Active
    } else if matches!(recording.state, RecordingState::Stopping) {
        MicrophonePhase::Ending
    } else {
        MicrophonePhase::Ended
    };
    let message = audio_issues
        .iter()
        .map(|issue| issue.message.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    Some((
        dedupe_key,
        MicrophoneNotice {
            audio_issues,
            activity,
            phase,
            message,
            session_id: event.session_id.clone(),
        },
    ))
}

/// The codes the microphone notice takes (`isSessionAudioLossCode` and the
/// silence of issue 1064).
pub fn takes_microphone_notice(code: &str) -> bool {
    is_session_audio_loss_code(code) || code == MICROPHONE_SILENT_CODE
}

/// `isSessionAudioLossCode`.
pub fn is_session_audio_loss_code(code: &str) -> bool {
    matches!(
        code,
        "microphone-input-lost" | "microphone-timeline-lost" | "system-audio-lost"
    )
}

// ── showSessionHealthEvent ──────────────────────────────────────────────

/// `recordingStartupHealthToast`: the startup barrier's news, keyed.
pub fn recording_startup_health_toast(event: &HealthEvent) -> Option<Notice> {
    let warning = |id: &str, title: &str, description: String, millis: u64| {
        ToastRequest::warning(title)
            .id(id)
            .description(description)
            .duration(ms(millis))
            .finish()
    };
    match event.code.as_str() {
        "recording-startup-cadence-unsteady" => Some(warning(
            ids::RECORDING_STARTUP_UNSTEADY,
            "The first seconds may stutter",
            "Videorc took a moment to settle when the recording started. Check its start."
                .to_string(),
            15_000,
        )),
        "recording-output-stepped-down" => Some(warning(
            "recording-output-stepped-down",
            "Recording at a lower resolution",
            event.message.clone(),
            20_000,
        )),
        "recording-degraded" => Some(warning(
            "recording-degraded",
            "Recording is falling behind",
            event.message.clone(),
            20_000,
        )),
        "microphone-capture-worker-fallback" => Some(warning(
            "microphone-capture-worker-fallback",
            "Microphone can't be changed until you stop",
            event.message.clone(),
            15_000,
        )),
        "microphone-capture-worker-unavailable" => Some(warning(
            "microphone-capture-worker-unavailable",
            "Going on without a microphone",
            event.message.clone(),
            20_000,
        )),
        // It shares the start failure's key, so the refused start's Retry
        // updates it in place.
        "recording-startup-barrier-timeout" if matches!(event.level, HealthLevel::Error) => Some(
            ToastRequest::error(SESSION_START_FAILED_TOAST_TITLE)
                .id(SESSION_START_FAILED_TOAST_ID)
                .description(event.message.clone())
                .duration(NoticeLifetime::UntilClosed)
                .finish(),
        ),
        _ => None,
    }
}

/// `showLiveOutputNews` (plan 087, plan 218, plan 219): what happens to the
/// live output mid-session; each pair shares a key, so the good news
/// replaces the bad.
pub fn live_output_news(event: &HealthEvent) -> Option<Notice> {
    let message = event.message.clone();
    let request = match event.code.as_str() {
        "stream-output-failed" => ToastRequest::error("Your stream stopped")
            .id(ids::STREAM_OUTPUT)
            .duration(NoticeLifetime::UntilClosed),
        "stream-output-stalled" => ToastRequest::warning("Your stream is frozen")
            .id(ids::STREAM_OUTPUT)
            .duration(NoticeLifetime::UntilClosed),
        "stream-output-resumed" => ToastRequest::success("Your stream is moving again")
            .id(ids::STREAM_OUTPUT)
            .duration(ms(8_000)),
        "stream-delivery-degraded" => ToastRequest::warning("Your stream is choppy")
            .id(ids::STREAM_DELIVERY)
            .duration(NoticeLifetime::UntilClosed),
        "stream-delivery-recovered" => ToastRequest::success("Your stream is smooth again")
            .id(ids::STREAM_DELIVERY)
            .duration(ms(8_000)),
        "stream-leg-overflow" => ToastRequest::warning("Your connection can’t keep up")
            .id(ids::STREAM_UPLINK)
            .duration(ms(20_000)),
        "stream-bitrate-lowered" => {
            ToastRequest::warning("Stream quality lowered to fit your connection")
                .id(ids::STREAM_UPLINK)
                .duration(ms(15_000))
        }
        "stream-bitrate-floor" => ToastRequest::warning("Your connection can’t carry this stream")
            .id(ids::STREAM_UPLINK)
            .duration(ms(30_000)),
        "stream-bitrate-restored" => ToastRequest::success("Stream quality is back")
            .id(ids::STREAM_UPLINK)
            .duration(ms(8_000)),
        "screen-capture-stopped" => {
            let error = matches!(event.level, HealthLevel::Error);
            ToastRequest::new(
                if error {
                    NoticeKind::Error
                } else {
                    NoticeKind::Warning
                },
                "Screen capture stopped",
            )
            .id(ids::SCREEN_CAPTURE)
            .duration(if error {
                NoticeLifetime::UntilClosed
            } else {
                ms(20_000)
            })
        }
        "screen-capture-restored" => ToastRequest::success("Screen capture is back")
            .id(ids::SCREEN_CAPTURE)
            .duration(ms(8_000)),
        "screen-window-out-of-sight" => ToastRequest::warning("Window out of sight")
            .id(ids::SCREEN_CAPTURE)
            .duration(ms(20_000)),
        "screen-window-back" => ToastRequest::success("The window is back")
            .id(ids::SCREEN_CAPTURE)
            .duration(ms(8_000)),
        "host-overloaded" => ToastRequest::warning("This computer is overloaded")
            .id(ids::HOST_OVERLOADED)
            .duration(ms(20_000)),
        "disk-space-low" => ToastRequest::warning("Recording space is low")
            .id(ids::DISK_SPACE_LOW)
            .duration(ms(20_000)),
        _ => return None,
    };
    Some(request.description(message).finish())
}

/// `separateFileRoleFromMessage`: `screen` or `camera`, named first.
fn separate_file_role(message: &str) -> Option<&'static str> {
    let trimmed = message.trim();
    for role in ["screen", "camera"] {
        if trimmed.len() >= role.len()
            && trimmed.is_char_boundary(role.len())
            && trimmed[..role.len()].eq_ignore_ascii_case(role)
            && !trimmed[role.len()..]
                .chars()
                .next()
                .is_some_and(|next| next.is_ascii_alphanumeric() || next == '_')
        {
            return Some(role);
        }
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SeparateFileFailure {
    Capture,
    Encoder,
    Writer,
    Audio,
    Short,
    Missing,
    Placement,
    Ownership,
    Interrupted,
}

/// `separateFileFailureKind`: the first of `SEPARATE_FILE_FAILURES` the
/// reason matches, case-insensitively.
fn separate_file_failure(reason: &str) -> Option<SeparateFileFailure> {
    let text = reason.to_lowercase();
    let has = |needle: &str| text.contains(needle);
    let after = |first: &str, then: &str| {
        text.find(first)
            .is_some_and(|at| text[at + first.len()..].contains(then))
    };
    if has("capture failed after source recovery") {
        Some(SeparateFileFailure::Capture)
    } else if has("encoder failed")
        || has("encoder writer could not be reaped")
        || has("encoder teardown failed")
    {
        Some(SeparateFileFailure::Encoder)
    } else if has("muxer exited")
        || has("muxer failed")
        || has("muxer exceeded")
        || after("could not reap ", "muxer")
        || has("recording supervisor failed")
    {
        Some(SeparateFileFailure::Writer)
    } else if has("audio failed") || has("audio bus ended") || has("audio teardown failed") {
        Some(SeparateFileFailure::Audio)
    } else if has("artifact ended at") || has("artifact duration could not be verified") {
        Some(SeparateFileFailure::Short)
    } else if has("file was missing after stop") {
        Some(SeparateFileFailure::Missing)
    } else if has("could not bind") || has("could not publish") || has("could not persist") {
        Some(SeparateFileFailure::Placement)
    } else if has("separate recording ownership could not be verified") {
        Some(SeparateFileFailure::Ownership)
    } else if has("partial media is available for recovery") {
        Some(SeparateFileFailure::Interrupted)
    } else {
        None
    }
}

/// `separateFileFailureSentence`.
fn separate_file_failure_sentence(kind: SeparateFileFailure, role: Option<&str>) -> &'static str {
    match kind {
        SeparateFileFailure::Capture if role == Some("camera") => {
            "The camera stopped sending video and couldn't be restarted."
        }
        SeparateFileFailure::Capture => {
            "The screen stopped sending video and couldn't be restarted."
        }
        SeparateFileFailure::Encoder => "Videorc couldn't keep encoding this file.",
        SeparateFileFailure::Writer => "Videorc couldn't keep writing this file.",
        SeparateFileFailure::Audio => "This file's audio stopped.",
        SeparateFileFailure::Short => "This file ended before the take did.",
        SeparateFileFailure::Missing => "This file wasn't there when you stopped recording.",
        SeparateFileFailure::Placement => "Videorc couldn't place this file beside your recording.",
        SeparateFileFailure::Ownership => "Videorc couldn't confirm this file after it restarted.",
        SeparateFileFailure::Interrupted => "Videorc closed before this file finished.",
    }
}

/// `separateFileFailedToast`: the take's Screen or Camera file stopped.
pub fn separate_file_failed_copy(message: &str, take_running: bool) -> (String, String) {
    let role = separate_file_role(message);
    let name = match role {
        Some("camera") => "Camera file",
        Some("screen") => "Screen file",
        _ => "Separate file",
    };
    let kind = separate_file_failure(message);
    let sentence = kind
        .map(|kind| separate_file_failure_sentence(kind, role))
        .unwrap_or("Videorc couldn't finish this file.");
    if take_running {
        return (
            format!("{name} stopped"),
            format!("{sentence} Your Combined recording keeps going."),
        );
    }
    let title = if matches!(
        kind,
        Some(SeparateFileFailure::Missing | SeparateFileFailure::Ownership)
    ) {
        format!("{name} wasn't saved")
    } else {
        format!("{name} stopped early")
    };
    (title, sentence.to_string())
}

/// `showSessionAudioNews` (plan 076): what the audio bus reports
/// mid-session. The echo pause's Resume turns System audio on again
/// (S3.1d).
fn session_audio_news(event: &HealthEvent, once: &mut NotifyOnce, now: Instant) -> Option<Notice> {
    let message = event.message.clone();
    let keyed = |once: &mut NotifyOnce, key: &str, request: ToastRequest| {
        request
            .id(once.id(key, now))
            .description(message.clone())
            .finish()
    };
    match event.code.as_str() {
        "microphone-noise-reduction-silenced" => Some(keyed(
            once,
            &event.code,
            ToastRequest::warning("Microphone silenced for a moment").duration(ms(12_000)),
        )),
        "system-audio-echo-paused" => Some(
            ToastRequest::warning("System audio paused: your stream was echoing")
                .id(ids::SYSTEM_AUDIO_ECHO)
                .description(message.clone())
                .duration(NoticeLifetime::UntilClosed)
                .action("Resume", NoticeAction::ResumeSystemAudio)
                .finish(),
        ),
        "audio-output-stalled" => Some(keyed(
            once,
            "audio-output-stalled",
            ToastRequest::warning("Audio dropped for a moment").duration(ms(12_000)),
        )),
        "microphone-timeline-recovered" | "microphone-input-recovered" => Some(keyed(
            once,
            &event.code,
            ToastRequest::success("Microphone is back").duration(ms(8_000)),
        )),
        "microphone-signal-recovered" => Some(keyed(
            once,
            &event.code,
            ToastRequest::success("Your microphone has sound again").duration(ms(8_000)),
        )),
        _ => None,
    }
}

// ── lib/stream-target-notices.ts ────────────────────────────────────────

/// `stream.targets`' payload, as far as the toasts read it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamTargetsSnapshot {
    #[serde(default)]
    pub session_id: Option<String>,
    pub targets: Vec<StreamTargetRuntime>,
}

/// One destination's runtime state.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamTargetRuntime {
    pub target_id: String,
    pub label: String,
    pub state: StreamTargetState,
    #[serde(default)]
    pub message: Option<String>,
}

/// `destinationLabel`: a retired default (`RETIRED_DESTINATION_LABELS`)
/// reads as its platform.
pub fn destination_label(label: &str) -> &str {
    match label {
        "X / Twitter" => "X",
        other => other,
    }
}

/// `otherDestinationsLine`.
pub fn other_destinations_line(others_on_air: usize) -> Option<String> {
    match others_on_air {
        0 => None,
        1 => Some(copy::OTHER_DESTINATION_KEEPS_STREAMING.to_string()),
        n => Some(format!("The other {n} destinations keep streaming.")),
    }
}

/// `streamTargetNotices` and `streamTargetToast`: a destination is news
/// when it stops, starts reconnecting, its platform stops receiving it, or
/// it comes back; one id per destination, so "{X} is back" replaces the
/// bad news in place. Bad news stays until the good news replaces it.
pub fn stream_target_notices(
    previous: &BTreeMap<String, StreamTargetState>,
    targets: &[StreamTargetRuntime],
) -> Vec<Notice> {
    let mut notices = Vec::new();
    for target in targets {
        let before = previous.get(&target.target_id).copied();
        if before == Some(target.state) {
            continue;
        }
        let id = format!("stream-target:{}", target.target_id);
        let label = destination_label(&target.label);
        let others = other_destinations_line(
            targets
                .iter()
                .filter(|other| {
                    other.target_id != target.target_id && other.state == StreamTargetState::Live
                })
                .count(),
        );
        let request = match target.state {
            StreamTargetState::Failed => {
                ToastRequest::error(format!("Streaming to {label} stopped"))
                    .description(
                        target
                            .message
                            .clone()
                            .or(others)
                            .unwrap_or_else(|| copy::NO_OTHER_DESTINATION.to_string()),
                    )
                    .duration(NoticeLifetime::UntilClosed)
            }
            StreamTargetState::Reconnecting => {
                ToastRequest::warning(format!("{label} is reconnecting"))
                    .description(match others {
                        Some(others) => {
                            format!("Viewers there see nothing until it's back. {others}")
                        }
                        None => copy::VIEWERS_SEE_NOTHING.to_string(),
                    })
                    .duration(NoticeLifetime::UntilClosed)
            }
            StreamTargetState::Warning => {
                ToastRequest::warning(format!("{label} isn't receiving your stream"))
                    .description(copy::NOT_RECEIVING_DESCRIPTION)
                    .duration(NoticeLifetime::UntilClosed)
            }
            StreamTargetState::Live
                if matches!(
                    before,
                    Some(
                        StreamTargetState::Reconnecting
                            | StreamTargetState::Warning
                            | StreamTargetState::Failed
                    )
                ) =>
            {
                ToastRequest::success(format!("{label} is back"))
                    .description(format!("Streaming to {label} resumed."))
            }
            _ => continue,
        };
        notices.push(request.id(id).finish());
    }
    notices
}

// ── lib/finalization-toast.ts ───────────────────────────────────────────

/// `finalizationToastId`: one toast per recording.
pub fn finalization_toast_id(session_id: &str) -> String {
    format!("finalization-{session_id}")
}

/// `finalizingBadgeLabel`.
pub fn finalizing_label(progress_percent: Option<u8>) -> String {
    match progress_percent {
        Some(percent) if percent > 0 && percent < 100 => format!("Saving MP4 · {percent}%"),
        _ => "Saving MP4…".to_string(),
    }
}

/// `showMp4Finalizing`: the spinner while the export runs.
pub fn mp4_finalizing(session_id: &str, progress_percent: Option<u8>) -> Notice {
    ToastRequest::loading(finalizing_label(progress_percent))
        .id(finalization_toast_id(session_id))
        .duration(NoticeLifetime::UntilClosed)
        .description(copy::MP4_FINALIZING_DESCRIPTION)
        .finish()
}

/// `showMp4Ready`: always with its reveal.
pub fn mp4_ready(session_id: &str) -> Notice {
    ToastRequest::success(copy::MP4_READY)
        .id(finalization_toast_id(session_id))
        .duration(ms(15_000))
        .action(
            reveal_in_file_manager_label(),
            NoticeAction::RevealSession {
                session_id: session_id.to_string(),
            },
        )
        .finish()
}

/// `exportSpaceRefusal`: the backend's no-room refusal of an MP4 export,
/// whole, else nothing.
pub fn export_space_refusal(reason: Option<&str>) -> Option<String> {
    const HEAD: &str = "Not enough disk space to finish the MP4 (needs ";
    const TAIL: &str = " free). Your recording is safe as MKV; free some space and use Export MP4.";
    let reason = reason?.trim();
    let middle = reason.strip_prefix(HEAD)?.strip_suffix(TAIL)?;
    let (needs, free) = middle.split_once(", ")?;
    let plain = |part: &str| !part.is_empty() && !part.contains(['(', ')', ',']);
    (plain(needs) && plain(free)).then(|| reason.to_string())
}

/// `showMp4ExportFailed`: Retry export runs the export again.
pub fn mp4_export_failed(session_id: &str, reason: Option<&str>) -> Notice {
    ToastRequest::error(copy::MP4_EXPORT_FAILED)
        .id(finalization_toast_id(session_id))
        .duration(NoticeLifetime::UntilClosed)
        .description(
            export_space_refusal(reason)
                .unwrap_or_else(|| copy::ORIGINAL_RECORDING_SAFE.to_string()),
        )
        .action(
            copy::RETRY_EXPORT,
            NoticeAction::RetryExport {
                session_id: session_id.to_string(),
            },
        )
        .finish()
}

// ── lib/replay-buffer.ts and shared/clip-marks.ts ───────────────────────

/// `CLIP_MARK_CLIP_SAVED_REASON`: the ring saved the clip, which says so.
pub const CLIP_MARK_CLIP_SAVED_REASON: &str = "clip-saved";

/// `showClipSaved`.
pub fn clip_saved(event: &ReplaySavedEvent) -> Notice {
    let held = format_timecode((event.covered_seconds.max(0.0).round() as i64) * 1000);
    ToastRequest::success(copy::CLIP_SAVED)
        .id(format!("{}-saved-{}", ids::CLIPS, event.save_id))
        .duration(ms(12_000))
        .description(if event.complete {
            format!("Last {held}.")
        } else {
            format!("Last {held}, the buffer was still filling.")
        })
        .action(
            reveal_in_file_manager_label(),
            NoticeAction::RevealSession {
                session_id: event.replay_session_id.clone(),
            },
        )
        .finish()
}

/// `showClipSaveFailed`.
pub fn clip_save_failed(event: &ReplaySaveFailedEvent) -> Notice {
    ToastRequest::error(copy::CLIP_SAVE_FAILED)
        .id(format!("{}-failed-{}", ids::CLIPS, event.save_id))
        .duration(ms(10_000))
        .description(event.message.clone())
        .finish()
}

/// `showClipsStopped`: the ring ended with its session.
pub fn clips_stopped(reason: Option<&str>) -> Notice {
    ToastRequest::warning(copy::CLIPS_STOPPED)
        .id(ids::CLIPS)
        .duration(ms(10_000))
        .description(reason.map(str::to_string).unwrap_or_else(|| {
            format!(
                "Turn on {} again on the Output page.",
                copy::KEEP_LAST_SECONDS
            )
        }))
        .finish()
}

/// The Clips toasts' door to the Output page (replay-buffer.ts's
/// `openOutput`, `openWorkspaceTab('recording')`).
pub const OPEN_OUTPUT: &str = "Open Output";

fn open_output() -> NoticeAction {
    NoticeAction::OpenPage(crate::nav::PageId::Recording)
}

/// `clipMarkedToast`: where the mark landed, or why nothing was kept. A
/// recording that never went live has no stream report to point at. The
/// warning carries the Studio's door to the Output page (`door`, its label:
/// use-studio's own "Open Output", S3.6a).
pub fn clip_marked(event: &ClipMarkedEvent, streaming: bool, door: &str) -> Option<Notice> {
    if event.reason.as_deref() == Some(CLIP_MARK_CLIP_SAVED_REASON) {
        return None;
    }
    let request = if event.saved {
        let at = format_timecode((event.at_seconds.max(0.0) * 1000.0) as i64);
        ToastRequest::success(format!("Clip marked at {at}"))
            .maybe_description(streaming.then(|| copy::CLIP_MARK_IN_REPORT.to_string()))
    } else {
        ToastRequest::warning(copy::CLIPS_OFF_NOTHING_RECORDING)
            .description(copy::CLIPS_OFF_DESCRIPTION)
            .action(door, open_output())
    };
    Some(request.id(ids::CLIP_MARKED).finish())
}

/// The ring's state, for [`nothing_to_clip`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipsState {
    Off,
    Starting,
    On,
    Error,
}

/// `showNothingToClip`: a Clip press with nothing to save says which, and
/// points at the one switch with Open Output (S3.6a); the Stream Manager's
/// Clip (S3.2a), ⌘K and the clip keys raise it.
pub fn nothing_to_clip(state: ClipsState, enabled: bool, blocked_reason: Option<&str>) -> Notice {
    let request = if let Some(reason) = blocked_reason {
        ToastRequest::warning("Clips are off on this computer")
            .description(reason)
            .action(OPEN_OUTPUT, open_output())
    } else if !enabled {
        ToastRequest::warning("Clips are off")
            .description(format!(
                "Turn on {} on the Output page, or start a recording.",
                copy::KEEP_LAST_SECONDS
            ))
            .action(OPEN_OUTPUT, open_output())
    } else if state == ClipsState::Starting {
        ToastRequest::info("Clips are still starting").description("Try again in a moment.")
    } else {
        ToastRequest::warning("Nothing to clip yet").description(
            "The last seconds are not being kept right now. Start a recording, or go live.",
        )
    };
    request.id(ids::CLIPS).finish()
}

/// `showClipsCouldNotStart`.
pub fn clips_could_not_start(reason: &str) -> Notice {
    ToastRequest::error("Clips couldn't start")
        .id(ids::CLIPS)
        .duration(ms(10_000))
        .description(reason)
        .finish()
}

/// Which source an automatic fallback changed (`AutomaticSourceFallbackEvent`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FallbackSource {
    Screen,
    Camera,
    Microphone,
}

/// `SOURCE_FALLBACK_NOUNS`.
fn fallback_noun(source: FallbackSource) -> &'static str {
    match source {
        FallbackSource::Screen => "Screen",
        FallbackSource::Camera => "Camera",
        FallbackSource::Microphone => "Microphone",
    }
}

/// `sourceFallbackTitle`: "Camera switched to FaceTime HD Camera", or
/// "Camera turned off"; "A source changed" without an event.
pub fn source_fallback_title(
    fallback: Option<(Option<FallbackSource>, Option<&str>, bool)>,
) -> String {
    let Some((source, next_name, has_next)) = fallback else {
        return "A source changed".to_string();
    };
    let noun = source.map(fallback_noun).unwrap_or("A source");
    match next_name.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => format!("{noun} switched to {name}"),
        None if has_next => format!("{noun} switched"),
        None => format!("{noun} turned off"),
    }
}

/// `showSourceFallbackActiveSession`: a source the session uses changed on
/// its own. The source selection controller (S3.1c) raises it.
pub fn source_fallback_active_session(
    live: bool,
    fallback: Option<(Option<FallbackSource>, Option<&str>, bool)>,
) -> Notice {
    ToastRequest::warning(source_fallback_title(fallback))
        .description(if live {
            "Your stream uses it now. Check the output before you continue."
        } else {
            "Your recording uses it now. Check the output before you continue."
        })
        .duration(ms(10_000))
        .id("source-reconciliation:active-session")
        .finish()
}

// ── the recovery after a reconnect ──────────────────────────────────────

/// `SESSION_LIST_PAGE_LIMIT`: the first page the bootstrap reads.
pub const SESSION_LIST_PAGE_LIMIT: usize = 50;
/// `SESSION_DETAIL_BUFFER_LIMIT`: the health events read for a session.
pub const SESSION_DETAIL_BUFFER_LIMIT: usize = 120;

/// `SessionRuntimeRecoveryPlan`.
#[derive(Debug, Clone, Default)]
pub struct RecoveryPlan {
    pub failure_session_id: Option<String>,
    pub failure_summary: Option<SessionListItem>,
    pub health_session_id: Option<String>,
}

fn ran(state: &RecordingState) -> bool {
    matches!(
        state,
        RecordingState::Recording | RecordingState::Streaming | RecordingState::Stopping
    )
}

/// `sessionRuntimeRecoveryPlan`: which session failed while the Studio was
/// away (the status still says so, or the Library row does), and whose
/// health events to read.
pub fn session_runtime_recovery_plan(
    recording: &RecordingStatus,
    sessions: &[SessionListItem],
    prior_session_id: Option<&str>,
    prior_state: &RecordingState,
) -> RecoveryPlan {
    let prior_was_active = ran(prior_state);
    let current_owns_runtime = ran(&recording.state);
    let prior_can_be_recovered =
        !current_owns_runtime || recording.session_id.as_deref() == prior_session_id;
    let missed_failure = match prior_session_id {
        Some(prior) if prior_was_active && prior_can_be_recovered => sessions
            .iter()
            .find(|session| session.id == prior && session.status == "failed"),
        _ => None,
    };
    let authoritative_failure = match (&recording.state, &recording.session_id) {
        (RecordingState::Failed, Some(id)) => sessions
            .iter()
            .find(|session| &session.id == id && session.status == "failed"),
        _ => None,
    };
    let failure_summary = authoritative_failure.or(missed_failure).cloned();
    let failure_session_id = if matches!(recording.state, RecordingState::Failed) {
        recording
            .session_id
            .clone()
            .or_else(|| failure_summary.as_ref().map(|summary| summary.id.clone()))
            .or_else(|| {
                prior_was_active
                    .then(|| prior_session_id.map(str::to_string))
                    .flatten()
            })
    } else {
        missed_failure.map(|summary| summary.id.clone())
    };
    let active_summary = match &recording.session_id {
        Some(id) if current_owns_runtime => sessions.iter().find(|session| &session.id == id),
        _ => None,
    };
    let health_session_id = failure_session_id.clone().or_else(|| {
        active_summary
            .filter(|summary| summary.health_event_count > 0)
            .map(|summary| summary.id.clone())
    });
    RecoveryPlan {
        failure_session_id,
        failure_summary,
        health_session_id,
    }
}

/// `sessionModeActivity`: a stored session's mode as what it did.
pub fn session_mode_activity(mode: &str) -> SessionActivity {
    let value = mode.to_lowercase();
    if !value.contains("stream") {
        SessionActivity::Recording
    } else if value.contains("record") {
        SessionActivity::RecordAndStream
    } else {
        SessionActivity::LiveStream
    }
}

/// What the Studio missed while it was away (`SessionRuntimeRecovery`).
#[derive(Debug, Clone)]
pub enum RuntimeRecovery {
    RecordingFailed {
        status: RecordingStatus,
        activity: SessionActivity,
    },
    MicrophoneLost(HealthEvent),
}

/// `completeSessionRuntimeRecovery`.
pub fn complete_session_runtime_recovery(
    plan: &RecoveryPlan,
    recording: &RecordingStatus,
    events: &[HealthEvent],
    prior_state: &RecordingState,
    prior_activity: Option<SessionActivity>,
) -> Option<RuntimeRecovery> {
    let latest = |matches: &dyn Fn(&HealthEvent) -> bool| events.iter().rev().find(|e| matches(e));
    if let Some(failure_session_id) = &plan.failure_session_id {
        let latest_failure = latest(&|event| matches!(event.level, HealthLevel::Error));
        let failed = matches!(recording.state, RecordingState::Failed);
        let output_path = recording.output_path.clone().or_else(|| {
            plan.failure_summary
                .as_ref()
                .and_then(|summary| summary.output_path.clone())
        });
        let message = failed
            .then(|| recording.message.clone())
            .flatten()
            .or_else(|| latest_failure.map(|event| event.message.clone()));
        let mut status = if failed {
            recording.clone()
        } else {
            RecordingStatus {
                state: RecordingState::Failed,
                session_id: None,
                output_path: None,
                stream_url: None,
                started_at: None,
                audio_tracks: Vec::new(),
                pipeline: None,
                duration_ms: None,
                message: None,
                replay_only: false,
                accepts_live_scene_edits: None,
            }
        };
        status.session_id = Some(failure_session_id.clone());
        if output_path.is_some() {
            status.output_path = output_path;
        }
        if message.is_some() {
            status.message = message;
        }
        // The stored mode says what the session did; without a row, the
        // Studio's last sighting (the state alone reads Go Live as a
        // recording, plan 174 B-6).
        let activity = match &plan.failure_summary {
            Some(summary) => session_mode_activity(&summary.mode),
            None => prior_activity.unwrap_or(if matches!(prior_state, RecordingState::Streaming) {
                SessionActivity::LiveStream
            } else {
                SessionActivity::Recording
            }),
        };
        return Some(RuntimeRecovery::RecordingFailed { status, activity });
    }
    // #1528: one event per source, the latest loss still open: a source's
    // own recovery closes it, so a reconnect never brings back a microphone
    // problem that already ended. A Map's order: a new loss moves its source
    // last, and the last open loss is the one the notice is about.
    let mut by_source: Vec<(&str, &HealthEvent)> = Vec::new();
    for event in events {
        let source = if event.code.starts_with("microphone-") {
            "microphone"
        } else {
            "system"
        };
        if is_session_audio_loss_code(&event.code) {
            by_source.retain(|(seen, _)| *seen != source);
            by_source.push((source, event));
        } else if is_session_audio_recovery_code(&event.code) {
            by_source.retain(|(seen, _)| *seen != source);
        }
    }
    let loss = by_source.last().map(|(_, event)| (*event).clone())?;
    by_source.retain(|(_, event)| event.session_id == loss.session_id);
    if by_source.len() > 1 {
        let message = by_source
            .iter()
            .map(|(_, event)| event.message.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        return Some(RuntimeRecovery::MicrophoneLost(HealthEvent {
            code: "audio-inputs-lost".to_string(),
            message,
            ..loss
        }));
    }
    Some(RuntimeRecovery::MicrophoneLost(loss))
}

// ── the session's notices, over time ────────────────────────────────────

/// What the toasts read about the session at the moment.
#[derive(Debug, Clone, Copy)]
pub struct SessionContext<'a> {
    /// `recordingRef.current`.
    pub status: &'a RecordingStatus,
    /// `lastRecordingSessionIdRef`.
    pub last_session_id: Option<&'a str>,
    /// `lastSessionActivityRef`.
    pub activity: SessionActivity,
    /// The "stopped unexpectedly" notice is up.
    pub failure_notice: bool,
}

/// The toasts' memory between events: the microphone notice and its
/// dedupe, the quality toast's sessions, the keyed notices, the
/// destinations' last states and the MP4 exports announced.
#[derive(Debug, Default)]
pub struct SessionNotices {
    microphone: Option<MicrophoneNotice>,
    /// `microphoneInputLostSessionRef`.
    microphone_dedupe: Option<String>,
    /// `qualityToastSessionsRef`.
    quality_shown: HashSet<String>,
    once: NotifyOnce,
    /// `streamTargetStatesRef`.
    stream_targets: BTreeMap<String, StreamTargetState>,
    /// `announcedFinalizationsRef`.
    announced_finalizations: HashSet<String>,
    /// S3.5e: `xPlaybackToastsRef`: one toast per broadcast and status.
    x_playback_shown: HashSet<String>,
}

/// S3.5e: `XPlaybackEvent` (`streamTargets.x.playback`): the backend's
/// check that X plays the broadcast, re-sent while it polls.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XPlaybackEvent {
    pub broadcast_id: String,
    /// `verified`, `pending` or `failed`.
    pub status: String,
    #[serde(default)]
    pub share_url: String,
}

fn dismiss(id: &str) -> NoticeCommand {
    NoticeCommand::Dismiss(id.to_string())
}

impl SessionNotices {
    pub fn new() -> Self {
        Self::default()
    }

    /// The microphone notice, while it is up.
    pub fn microphone_notice(&self) -> Option<&MicrophoneNotice> {
        self.microphone.as_ref()
    }

    /// `clearSessionRuntimeState`'s part here: a new session or a new start
    /// makes the old notices stale.
    fn clear_runtime(&mut self) -> Vec<NoticeCommand> {
        self.microphone_dedupe = None;
        self.dismiss_runtime_notice()
    }

    /// `dismissSessionRuntimeNotice`: both runtime toasts go.
    pub fn dismiss_runtime_notice(&mut self) -> Vec<NoticeCommand> {
        self.microphone = None;
        vec![
            dismiss(RECORDING_STOPPED_UNEXPECTEDLY_TOAST_ID),
            dismiss(ids::MICROPHONE_INPUT_LOST),
        ]
    }

    /// `noteSessionStartAttempt`: the last refusal and the runtime notices
    /// go when Record or Go Live is pressed again.
    pub fn start_attempted(&mut self) -> Vec<NoticeCommand> {
        let mut commands = vec![dismiss(SESSION_START_FAILED_TOAST_ID)];
        commands.extend(self.clear_runtime());
        commands
    }

    /// `dismissSessionStartFailure`.
    pub fn start_failure_dismissed() -> Vec<NoticeCommand> {
        vec![dismiss(SESSION_START_FAILED_TOAST_ID)]
    }

    /// `requestStopSession`: an armed hotkey says so; a stop takes the arm
    /// toast away.
    pub fn stop_requested(request: &StopRequest) -> Vec<NoticeCommand> {
        match request {
            StopRequest::Stop => vec![dismiss(ids::END_LIVESTREAM_ARMED)],
            StopRequest::Armed => vec![NoticeCommand::Show(end_livestream_armed())],
            StopRequest::Confirm(_) => Vec::new(),
        }
    }

    /// One session effect.
    pub fn on_effect(&mut self, effect: &SessionEffect) -> Vec<NoticeCommand> {
        match effect {
            SessionEffect::SessionStarted { .. } => self.clear_runtime(),
            SessionEffect::SessionEnded => {
                // The destinations reset with the session; the armed
                // hotkey means nothing now.
                self.stream_targets.clear();
                vec![dismiss(ids::END_LIVESTREAM_ARMED)]
            }
            SessionEffect::SessionFinished {
                session_id,
                activity,
                ..
            } => self.session_finished(session_id.as_deref(), (*activity).into()),
            SessionEffect::RecordingFailed(notice) => {
                // The failure outranks and replaces the microphone notice.
                self.microphone = None;
                recording_failure(notice)
            }
            SessionEffect::StartFailed(failure) => {
                vec![NoticeCommand::Show(start_failure(failure))]
            }
            SessionEffect::WentLive | SessionEffect::RecordingSaved { .. } => Vec::new(),
        }
    }

    /// `showSessionFinished`: the live stream's news ends with it, the
    /// microphone notice moves to the past tense, and a saved recording
    /// gets Play.
    fn session_finished(
        &mut self,
        session_id: Option<&str>,
        activity: RuntimeActivity,
    ) -> Vec<NoticeCommand> {
        let mut commands = vec![dismiss(ids::STREAM_DELIVERY), dismiss(ids::STREAM_UPLINK)];
        if let Some(notice) = self.microphone.as_mut()
            && notice.phase != MicrophonePhase::Ended
        {
            notice.phase = MicrophonePhase::Ended;
            commands.push(NoticeCommand::Show(microphone_toast(notice)));
        }
        if activity.saves_recording() {
            commands.push(NoticeCommand::Show(recording_saved(session_id)));
        }
        commands
    }

    /// `publishMicrophoneInputLost`: once per input per session; a failure
    /// notice outranks it.
    pub fn microphone_loss(
        &mut self,
        event: &HealthEvent,
        session: SessionContext<'_>,
    ) -> Vec<NoticeCommand> {
        let current = if session.failure_notice {
            CurrentNotice::Failure
        } else {
            match &self.microphone {
                Some(notice) => CurrentNotice::Microphone(notice),
                None => CurrentNotice::None,
            }
        };
        let Some((dedupe_key, notice)) = microphone_loss_presentation(
            event,
            session.status,
            session.last_session_id,
            session.activity.into(),
            self.microphone_dedupe.as_deref(),
            current,
        ) else {
            return Vec::new();
        };
        self.microphone_dedupe = Some(dedupe_key);
        if session.failure_notice {
            return Vec::new();
        }
        // System-only losses have the mixer's state; no toast for them.
        let quiet = notice
            .audio_issues
            .iter()
            .all(|issue| issue.code == "system-audio-lost");
        let toast = microphone_toast(&notice);
        self.microphone = Some(notice);
        if quiet {
            Vec::new()
        } else {
            vec![NoticeCommand::Show(toast)]
        }
    }

    /// A `health.event`: the microphone notice, or `showSessionHealthEvent`
    /// for the running (or last) session's events.
    pub fn on_health_event(
        &mut self,
        event: &HealthEvent,
        session: SessionContext<'_>,
        now: Instant,
    ) -> Vec<NoticeCommand> {
        if takes_microphone_notice(&event.code) {
            return self.microphone_loss(event, session);
        }
        let mut commands = Vec::new();
        // Plan 076: a loss that recovered clears its notice. Only the audio's
        // own recoveries (#1528): disk space or the connection coming back
        // says nothing about a microphone that is still lost.
        if audio_recovery(&event.code) && self.microphone.is_some() {
            self.microphone_dedupe = None;
            commands.extend(self.dismiss_runtime_notice());
        }
        let current_session = session
            .status
            .session_id
            .as_deref()
            .or(session.last_session_id);
        if event
            .session_id
            .as_deref()
            .is_some_and(|id| Some(id) != current_session)
        {
            return commands;
        }
        // A delayed active-only warning never shows after its session.
        if event.code == "recording-degraded"
            && (!matches!(
                session.status.state,
                RecordingState::Recording | RecordingState::Streaming
            ) || event.session_id != session.status.session_id)
        {
            return commands;
        }
        commands.extend(self.session_health_event(event, session.status, now));
        commands
    }

    /// `showSessionHealthEvent`.
    fn session_health_event(
        &mut self,
        event: &HealthEvent,
        recording: &RecordingStatus,
        now: Instant,
    ) -> Vec<NoticeCommand> {
        let mut commands = Vec::new();
        let session_key = event.session_id.as_deref().unwrap_or("take");
        // Plan 198 (D1) and plan 200 D1: the separate files, each with
        // the door to Health (S3.0g).
        if event.code == "separate-source-recordings-role-failed" {
            let take_running = recording.session_id == event.session_id
                && matches!(
                    recording.state,
                    RecordingState::Recording | RecordingState::Streaming
                );
            let (title, description) = separate_file_failed_copy(&event.message, take_running);
            let role = separate_file_role(&event.message).unwrap_or("file");
            let id = self
                .once
                .id(&format!("separate-file:{session_key}:{role}"), now);
            commands.push(NoticeCommand::Show(
                ToastRequest::warning(title)
                    .id(id)
                    .description(description)
                    .action(
                        crate::studio::health_page::OPEN_HEALTH_LABEL,
                        NoticeAction::OpenHealth,
                    )
                    .duration(NoticeLifetime::For(WITH_DESCRIPTION))
                    .finish(),
            ));
            return commands;
        }
        if event.code == "separate-source-recordings-shed" {
            let id = self
                .once
                .id(&format!("separate-files-shed:{session_key}"), now);
            commands.push(NoticeCommand::Show(
                ToastRequest::warning(copy::SEPARATE_FILES_SHED_TITLE)
                    .id(id)
                    .description(copy::SEPARATE_FILES_SHED_DESCRIPTION)
                    .action(
                        crate::studio::health_page::OPEN_HEALTH_LABEL,
                        NoticeAction::OpenHealth,
                    )
                    .duration(NoticeLifetime::For(WITH_DESCRIPTION))
                    .finish(),
            ));
            return commands;
        }
        if let Some(notice) = recording_startup_health_toast(event) {
            commands.push(NoticeCommand::Show(notice));
        }
        if event.code.starts_with("recording-quality-") {
            if event.code != "recording-quality-not-100"
                || !matches!(event.level, HealthLevel::Warn)
            {
                return commands;
            }
            let key = event
                .session_id
                .clone()
                .unwrap_or_else(|| event.message.clone());
            if !self.quality_shown.insert(key) {
                return commands;
            }
            commands.push(NoticeCommand::Show(
                ToastRequest::warning(copy::DROPPED_FRAMES)
                    .description(event.message.clone())
                    .duration(ms(15_000))
                    .action(
                        copy::OPEN_IN_LIBRARY,
                        NoticeAction::OpenLibrary {
                            session_id: event.session_id.clone(),
                        },
                    )
                    .finish(),
            ));
            return commands;
        }
        if event.code == "mic-silent" {
            let error = matches!(event.level, HealthLevel::Error);
            commands.push(NoticeCommand::Show(
                ToastRequest::new(
                    if error {
                        NoticeKind::Error
                    } else {
                        NoticeKind::Warning
                    },
                    if error {
                        copy::NO_SOUND
                    } else {
                        copy::MICROPHONE_SILENT
                    },
                )
                .description(event.message.clone())
                .duration(ms(15_000))
                .finish(),
            ));
        }
        if let Some(notice) = session_audio_news(event, &mut self.once, now) {
            commands.push(NoticeCommand::Show(notice));
        }
        if let Some(notice) = live_output_news(event) {
            commands.push(NoticeCommand::Show(notice));
        }
        commands
    }

    /// `stream.targets`: the destinations' transitions that are news.
    pub fn on_stream_targets(&mut self, targets: &[StreamTargetRuntime]) -> Vec<NoticeCommand> {
        if targets.is_empty() {
            self.stream_targets.clear();
            return Vec::new();
        }
        let notices = stream_target_notices(&self.stream_targets, targets);
        self.stream_targets = targets
            .iter()
            .map(|target| (target.target_id.clone(), target.state))
            .collect();
        notices.into_iter().map(NoticeCommand::Show).collect()
    }

    /// S3.5e: `showXPlaybackEvent`, once per broadcast and status (the
    /// backend re-checks on a timer); each state replaces the last
    /// (`notifyOnce('x-playback', …)`).
    pub fn on_x_playback(&mut self, event: &XPlaybackEvent, now: Instant) -> Vec<NoticeCommand> {
        if !self
            .x_playback_shown
            .insert(format!("{}:{}", event.broadcast_id, event.status))
        {
            return Vec::new();
        }
        let id = self.once.id(ids::X_PLAYBACK, now);
        let request = match event.status.as_str() {
            "verified" => {
                ToastRequest::success(copy::X_WATCHABLE).description(event.share_url.clone())
            }
            "pending" => {
                ToastRequest::warning(copy::X_PREPARING).description(copy::X_PREPARING_DESCRIPTION)
            }
            _ => ToastRequest::error(copy::X_NEVER_SHOWED)
                .description(copy::X_NEVER_SHOWED_DESCRIPTION),
        };
        vec![NoticeCommand::Show(request.id(id).finish())]
    }

    /// `recording.finalization`: the export's spinner, "MP4 ready" once per
    /// take, or the failure.
    pub fn on_finalization(&mut self, event: &RecordingFinalizationEvent) -> Vec<NoticeCommand> {
        match event.state {
            RecordingFinalizationState::Finalizing => {
                self.announced_finalizations.remove(&event.session_id);
                vec![NoticeCommand::Show(mp4_finalizing(
                    &event.session_id,
                    event.progress_percent,
                ))]
            }
            RecordingFinalizationState::Finalized => {
                if self
                    .announced_finalizations
                    .insert(event.session_id.clone())
                {
                    vec![NoticeCommand::Show(mp4_ready(&event.session_id))]
                } else {
                    Vec::new()
                }
            }
            RecordingFinalizationState::Failed => vec![NoticeCommand::Show(mp4_export_failed(
                &event.session_id,
                event.error.as_deref(),
            ))],
            RecordingFinalizationState::None => Vec::new(),
        }
    }

    /// `clip.marked`: one toast per mark (the ring's own save says "Clip
    /// saved" instead).
    pub fn on_clip_marked(
        &mut self,
        event: &ClipMarkedEvent,
        recording: &RecordingStatus,
        door: &str,
    ) -> Vec<NoticeCommand> {
        clip_marked(event, session_is_live(recording), door)
            .map(NoticeCommand::Show)
            .into_iter()
            .collect()
    }

    /// `replay.state`: the ring died with its session.
    pub fn on_replay_state(&mut self, event: &ReplayStateEvent) -> Vec<NoticeCommand> {
        if event.state == ReplayBufferState::Error {
            vec![NoticeCommand::Show(clips_stopped(event.reason.as_deref()))]
        } else {
            Vec::new()
        }
    }

    /// `replay.saved`.
    pub fn on_replay_saved(&mut self, event: &ReplaySavedEvent) -> Vec<NoticeCommand> {
        vec![NoticeCommand::Show(clip_saved(event))]
    }

    /// `replay.saveFailed`.
    pub fn on_replay_save_failed(&mut self, event: &ReplaySaveFailedEvent) -> Vec<NoticeCommand> {
        vec![NoticeCommand::Show(clip_save_failed(event))]
    }
}

/// `isSessionAudioRecoveryCode`: the recovery that ends one of the
/// session's audio losses.
pub fn is_session_audio_recovery_code(code: &str) -> bool {
    matches!(
        code,
        "microphone-input-recovered" | "microphone-timeline-recovered" | "system-audio-recovered"
    )
}

/// `/^(?:microphone-(?:input|timeline|signal)|system-audio)-recovered$/`:
/// the audio's own recoveries, the only ones that clear the microphone
/// notice.
pub fn audio_recovery(code: &str) -> bool {
    matches!(
        code,
        "microphone-input-recovered"
            | "microphone-timeline-recovered"
            | "microphone-signal-recovered"
            | "system-audio-recovered"
    )
}

#[cfg(test)]
#[path = "notices_tests.rs"]
mod tests;
