//! Live Chat Co-host engine (plan: "2026-08-22 - Videorc Live Chat Co-host").
//!
//! One backend-owned state machine per live-chat session: it watches delivered
//! chat rows, batches the delta into periodic `POST /api/ai/cohost/tick`
//! calls (bearer-authed, Premium + consent gated), merges the server's
//! open-question set, flags, and mood, and publishes every change to renderers
//! as the non-coalescible `cohost.state` event. The renderer never talks to
//! the web.
//!
//! Live state stays in memory: raw drafts, chat text and the transcript are
//! cleared when the session stops. After each stream a short report (counts
//! by outcome, the questions and what became of them, the promises still
//! open) is saved on this computer in `cohost_reports` and deleted with the
//! recording (plan 119 decision 6). It never holds chat text beyond the
//! question wording, and nothing of it reaches a server.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio::task::JoinHandle;

use crate::captions::{CaptionUpdateKind, CaptionsUpdate, ListenStop};
use crate::cohost_ack::{
    AuthorLedger, DeadAirLane, GreetedHow, dead_air_due, dead_air_text, match_candidates,
    name_forms_match, name_match_forms, name_tokens,
};
use crate::cohost_command::{
    CommandKind, CommandSession, CommandTarget, DetectContext, DetectedCommand, is_command_word,
};
use crate::comment_highlight::{CommentHighlightPhase, CommentHighlightState};
use crate::live_chat::{LiveChatEventType, LiveChatMessage, LiveChatMessageFragment};
use crate::live_chat_moderation::{
    ModerationOperation, ModerationOutcomeCode, ModerationPhase, ModerationRefusal,
    ModerationRequest, ModerationSource, RemoveConfirmMode,
};
use crate::protocol::{
    COHOST_REPORT_ASKERS_CAP, COHOST_REPORT_OPEN_PROMISES_CAP, COHOST_REPORT_QUESTIONS_CAP,
    COHOST_SESSION_REPORT_VERSION, CohostAuthorParams, CohostCommandChooseParams,
    CohostCommandParams, CohostFlagParams, CohostPromiseParams, CohostQuestionParams,
    CohostRecapParams, CohostReportAlert, CohostReportChat, CohostReportCommands,
    CohostReportFlagKindCount, CohostReportFlagSeverityCount, CohostReportFlags,
    CohostReportGreetings, CohostReportOpenPromise, CohostReportPayload, CohostReportPromises,
    CohostReportQuestion, CohostReportQuestionOutcome, CohostReportQuestions, CohostReportRecap,
    CohostReportSavedEvent, CohostSessionReport, CohostSettingsPatch, CohostStartParams, FeatureId,
};
use crate::state::AppState;
use crate::storage::Database;
use crate::streaming::{StreamPlatform, stream_platform_label};
use crate::twitch_chat::gif_title;
use crate::videorc_api::{
    COHOST_COMMAND_MAX_CANDIDATES, COHOST_SPOTLIGHT_MAX_BODY_BYTES, CohostApiError,
    CohostApiErrorKind, CohostCommandCandidate, CohostCommandRequest, CohostCommandResponse,
    CohostSpotlightCandidate, CohostSpotlightRequest, CohostSpotlightResponse, CohostTickMessage,
    CohostTickOpenPromise, CohostTickOpenQuestion, CohostTickPromise, CohostTickQuestion,
    CohostTickRequest, CohostTickResponse, VideorcApiClient,
};

pub const COHOST_STATE_EVENT: &str = "cohost.state";
/// Plan 119 S1: a session's report was saved (or folded into the one there).
pub const COHOST_REPORT_SAVED_EVENT: &str = "cohost.report.saved";
/// Pinned by the desktop; the server rejects unknown versions with 400
/// `prompt-version-unsupported`. A session that gets that answer drops one
/// step down `COHOST_PROMPT_VERSION_LADDER` (3 → 2 → 1) until it ends
/// (server rollback); a rejected v1 tick is a real failure.
pub const COHOST_PROMPT_VERSION: u32 = 3;
pub const COHOST_PROMPT_VERSION_LADDER: [u32; 3] = [3, 2, 1];
/// `rules` ride every version from v2 on, whatever the pinned version.
const COHOST_PROMPT_VERSION_RULES_MIN: u32 = 2;
/// Transcript, summary, promises, recap, on-topic (plan 068 D7).
const COHOST_PROMPT_VERSION_SPEECH_MIN: u32 = 3;
pub const COHOST_SETTINGS_KEY: &str = "cohostSettings";
pub const COHOST_NOTES_MAX_CHARS: usize = 4000;
/// The server rejects more or longer rules as `invalid-request`, so settings
/// are normalised to these caps before they are stored or sent.
pub const COHOST_RULES_MAX: usize = 10;
pub const COHOST_RULE_MAX_CHARS: usize = 120;
const DESKTOP_CLIENT_VERSION: &str = concat!("videorc-desktop/", env!("CARGO_PKG_VERSION"));

const TICK_MESSAGE_TEXT_MAX_CHARS: usize = 500;
/// Newest messages kept per tick; older delta rows are counted as dropped.
const TICK_DELTA_CAP: usize = 60;
const TICK_OPEN_QUESTIONS_CAP: usize = 40;
const TICK_BURST_THRESHOLD: usize = 5;
const TICK_IDLE_INTERVAL: Duration = Duration::from_secs(20);
/// Contract floor between two tick requests. Independent of the HTTP timeout:
/// ticks never overlap, so a slow tick delays the next one rather than
/// shortening the gap.
pub(crate) const TICK_MIN_GAP: Duration = Duration::from_secs(8);
/// v3 cadence (plan 068 D7): a tick goes out on speech alone once this many
/// transcript chars arrived since the previous tick and the idle interval
/// passed, even with an empty chat delta.
pub(crate) const TICK_TRANSCRIPT_MIN_NEW_CHARS: usize = 200;
/// Server caps on the v3 request (`cohost.ts`); the server truncates the
/// transcript itself, the promise list it rejects.
const TICK_TRANSCRIPT_MAX_CHARS: usize = 1500;
const TICK_SUMMARY_MAX_CHARS: usize = 600;
const TICK_OPEN_PROMISES_CAP: usize = 20;
const PROMISE_TEXT_MAX_CHARS: usize = 160;
const TOPIC_MAX_CHARS: usize = 60;
pub(crate) const RECAP_MAX_CHARS: usize = 140;
/// Renderer contract bounds (`cohostQuestionSchema`), in UTF-16 units.
const QUESTION_TEXT_MAX_UNITS: usize = 2000;
const QUESTION_ASKER_MAX_UNITS: usize = 512;
/// Renderer contract bounds (`cohostListeningSchema`), in UTF-16 units.
const LISTENING_REASON_CODE_MAX_UNITS: usize = 128;
const LISTENING_MESSAGE_MAX_UNITS: usize = 2000;
/// A recap (server or drafted) leaves the state after this long.
pub(crate) const RECAP_TTL: Duration = Duration::from_secs(5 * 60);
/// A promise with no trigger reminds the streamer after this long.
pub(crate) const PROMISE_DEFAULT_REMINDER: Duration = Duration::from_secs(20 * 60);
/// Pending transcript kept between ticks; only the newest
/// `TICK_TRANSCRIPT_MAX_CHARS` go out, the rest is context lost anyway.
const TRANSCRIPT_PENDING_CAP_CHARS: usize = 4 * TICK_TRANSCRIPT_MAX_CHARS;
/// Hard cap on the detail message carried on the wire; server envelope
/// messages are one sentence, and a proxy error page must not become a toast.
const ERROR_DETAIL_MESSAGE_MAX_CHARS: usize = 400;
const BACKOFF_STEPS_SECS: [u64; 5] = [5, 10, 20, 40, 60];
const QUOTA_DEFAULT_RETRY: Duration = Duration::from_secs(3600);
/// How often a paused precondition (signed out, Basic, no consent) is re-read.
const PRECONDITION_RECHECK: Duration = Duration::from_secs(5);
const SCHEDULER_POLL: Duration = Duration::from_secs(1);
const KNOWN_MESSAGE_IDS_CAP: usize = 5000;
const FLAGS_CAP: usize = 50;
const HIGHLIGHTS_CAP: usize = 5;
/// An alert kind is only shown once two different viewers said it within this
/// window — one confused viewer is not a broken stream.
const ALERT_CORROBORATION_WINDOW: Duration = Duration::from_secs(60);
const ALERT_MIN_AUTHORS: usize = 2;
/// A report stops counting (and its kind leaves the state) after this long.
const ALERT_EXPIRY: Duration = Duration::from_secs(120);
const ALLOWED_ROLES: [&str; 5] = ["mod", "owner", "subscriber", "member", "vip"];
/// Automatic on-stream cards (plan 060, D4-D6, D10). The engine decides, the
/// renderer only renders and sets the card. At most one automatic card every
/// `AUTO_HIGHLIGHT_COOLDOWN`, measured from the end of the previous card
/// (whoever set it); never a message older than `AUTO_HIGHLIGHT_MAX_AGE`;
/// never while chat tension is at or above the ceiling.
pub(crate) const AUTO_HIGHLIGHT_COOLDOWN: Duration = Duration::from_secs(45);
pub(crate) const AUTO_HIGHLIGHT_MAX_AGE: Duration = Duration::from_secs(120);
const AUTO_HIGHLIGHT_TENSION_CEILING: f64 = 0.7;
/// An open high-priority question has no server score; it competes at this
/// baseline plus the asker's role bonus.
const AUTO_HIGHLIGHT_QUESTION_SCORE: f64 = 0.5;
/// Not the same highlight type this many times in a row when another exists.
const AUTO_HIGHLIGHT_TYPE_RUN: usize = 3;
const AUTO_HIGHLIGHT_ROLE_BONUS_MEMBER: f64 = 0.15;
const AUTO_HIGHLIGHT_ROLE_BONUS_MOD: f64 = 0.10;
/// A voice card may be re-set once while the match persists; the refresh is
/// due when this little of the first lifetime is left (10 s + 10 s = 20 s max).
const AUTO_HIGHLIGHT_VOICE_REFRESH_WINDOW: Duration = Duration::from_secs(2);
/// A decision the renderer never turned into a live card stops counting as
/// "applying" after this long (the message may have left the snapshot).
const AUTO_HIGHLIGHT_APPLY_TIMEOUT: Duration = Duration::from_secs(8);
/// The spotlight lane (plan 060 S3, D7, D12): what the streamer says, from the
/// live-caption finals, against the comments they might be talking about. A
/// fast lane with its own cadence and breaker; it never touches the tick.
pub(crate) const SPOTLIGHT_TRANSCRIPT_WINDOW: Duration = Duration::from_secs(20);
pub(crate) const SPOTLIGHT_TRANSCRIPT_MAX_CHARS: usize = 800;
/// A call waits this long after the latest final (the next final is usually
/// on its way) and never comes closer than the min gap to the previous call.
pub(crate) const SPOTLIGHT_DEBOUNCE: Duration = Duration::from_secs(1);
pub(crate) const SPOTLIGHT_MIN_GAP: Duration = Duration::from_millis(2500);
const SPOTLIGHT_QUESTION_CANDIDATES_CAP: usize = 10;
const SPOTLIGHT_CANDIDATES_CAP: usize = 20;
/// Server caps on one candidate (`cohost-spotlight.ts`); a candidate that
/// cannot fit is left out rather than failing the whole call.
const SPOTLIGHT_CANDIDATE_ID_MAX_CHARS: usize = 200;
const SPOTLIGHT_AUTHOR_MAX_CHARS: usize = 120;
const SPOTLIGHT_QUESTION_ID_MAX_CHARS: usize = 80;
pub(crate) const SPOTLIGHT_MESSAGE_MAX_AGE: Duration = Duration::from_secs(120);
/// A match stays the spotlight this long unless a later call refreshes it.
pub(crate) const SPOTLIGHT_EXPIRY: Duration = Duration::from_secs(15);
/// Desktop-owned thresholds on the server's raw probabilities. UNVALIDATED
/// starting values (plan 060 P7): mirror `SPOTLIGHT_REFERENCE_THRESHOLDS`.
const SPOTLIGHT_ABOUT_THRESHOLD: f64 = 0.75;
const SPOTLIGHT_ANSWERED_THRESHOLD: f64 = 0.8;
/// Consecutive calls that must say "answered" before a question is resolved.
const SPOTLIGHT_ANSWERED_STREAK: u32 = 2;
/// Breaker: this many failures in a row close the lane for `SPOTLIGHT_BREAKER_OFF`;
/// "not on this server" answers (404, disabled, unconfigured, no Premium)
/// close it for `SPOTLIGHT_UNAVAILABLE_OFF`; a quota answer for Retry-After.
const SPOTLIGHT_BREAKER_FAILURES: usize = 3;
const SPOTLIGHT_BREAKER_OFF: Duration = Duration::from_secs(60);
const SPOTLIGHT_UNAVAILABLE_OFF: Duration = Duration::from_secs(300);
/// Voice-resolved questions the streamer can still put back (D9).
const RECENTLY_RESOLVED_CAP: usize = 3;
const RECENTLY_RESOLVED_TTL: Duration = Duration::from_secs(60);

// --- Wire enums --------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CohostTone {
    #[default]
    Friendly,
    Short,
    Professional,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostStatus {
    Off,
    Listening,
    Paused,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostReason {
    PremiumRequired,
    ConsentRequired,
    SessionExpired,
    SignedOut,
    QuotaExhausted,
    ServerUnconfigured,
    Network,
    GatewayError,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CohostPriority {
    High,
    #[default]
    Normal,
    Low,
    /// Forward tolerance: a priority this build does not know. Never reaches
    /// the renderer — `apply_response` reads it as `normal`.
    #[serde(other)]
    Unknown,
}

/// When a promise reminder fires (plan 068 D8). `Unknown` is forward
/// tolerance on the wire and is read as `none` (20 minutes after first seen).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CohostPromiseTriggerKind {
    #[default]
    None,
    Viewers,
    Minutes,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostMood {
    Hype,
    Calm,
    Tense,
    Mixed,
    /// Forward tolerance; read as `mixed`, never sent to the renderer.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostFlagKind {
    Toxicity,
    Spam,
    SelfPromo,
    PersonalInfo,
    Hate,
    Harassment,
    Threat,
    Sexual,
    Scam,
    SelfHarm,
    Spoiler,
    Impersonation,
    Rule,
    /// Forward tolerance: the vocabulary will grow. An unknown kind is kept
    /// and reaches the renderer as `unknown`, which renders as "Flagged".
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostFlagSeverity {
    High,
    Medium,
    Low,
    /// Forward tolerance; read as `medium`, never sent to the renderer.
    #[serde(other)]
    Unknown,
}

/// Who a flagged message is aimed at. Absent means nobody in particular.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostFlagTarget {
    Streamer,
    Viewer,
    Group,
    /// Forward tolerance; read as absent.
    #[serde(other)]
    Unknown,
}

/// A moderation action the server SUGGESTS. The desktop only labels it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostFlagAction {
    Hide,
    Timeout,
    Ban,
    /// Forward tolerance; read as absent.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CohostHighlightType {
    Question,
    Joke,
    Praise,
    Insight,
    Milestone,
    #[default]
    Other,
    /// Forward tolerance; read as `other`.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum CohostAlertKind {
    Audio,
    Video,
    StreamHealth,
    Game,
    Other,
    /// Forward tolerance; read as `other` ("something is wrong").
    #[serde(other)]
    Unknown,
}

/// Where an automatic on-stream card came from.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostAutoHighlightSource {
    /// The server's safety-gated `highlights[]`.
    Pick,
    /// An open question with priority `high`.
    Question,
    /// The comment the streamer is talking about (voice spotlight, plan 060 S3).
    Voice,
    /// The streamer asked for it by voice (plan 140 S3, contract part C). The
    /// renderer's schema reads the source as a free string, so this is not a
    /// new closed enum value on the wire.
    Command,
}

/// One automatic "put this on stream" command. The renderer keys on
/// `generation` and sets the card with always-set semantics; it keeps no
/// history and makes no decision of its own.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostAutoHighlight {
    pub generation: u64,
    pub message_id: String,
    pub source: CohostAutoHighlightSource,
    /// The same message is re-set while still live (voice only, once).
    pub refresh: bool,
}

/// The comment the streamer is talking about right now (plan 060 S3): the
/// best spotlight match at or above the `about` threshold, refreshed while it
/// persists, gone after `SPOTLIGHT_EXPIRY`. The renderer pins and marks it
/// (pull-up); with `voiceHighlight` the engine also puts it on stream.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohostSpotlight {
    pub message_id: String,
    /// The open question this message asked, when it is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question_id: Option<String>,
    /// The server's `about` probability (0..1).
    pub score: f64,
    /// When this message became the spotlight (ISO-8601).
    pub at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostResolveReason {
    /// The streamer answered it on air (two spotlight calls in a row agreed).
    Voice,
}

/// A question the engine resolved by itself, kept for a minute so the streamer
/// can put it back with `cohost.question.restore` (D9).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostRecentlyResolved {
    pub question: CohostQuestion,
    pub reason: CohostResolveReason,
    pub resolved_at: String,
}

// --- Listening (plan 068) -------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostListeningState {
    Off,
    Starting,
    On,
    Blocked,
}

/// Whether Golem hears the streamer right now (plan 068 D2). Owned by the
/// caption coordinator's listen intent; every optional field is omitted when
/// absent because the renderer contract rejects `null`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostListening {
    pub state: CohostListeningState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining_seconds: Option<u64>,
}

impl CohostListening {
    pub fn off() -> Self {
        Self {
            state: CohostListeningState::Off,
            reason_code: None,
            message: None,
            remaining_seconds: None,
        }
    }

    pub fn starting() -> Self {
        Self {
            state: CohostListeningState::Starting,
            reason_code: None,
            message: None,
            remaining_seconds: None,
        }
    }

    pub fn on(remaining_seconds: Option<u64>) -> Self {
        Self {
            state: CohostListeningState::On,
            reason_code: None,
            message: None,
            remaining_seconds,
        }
    }

    /// The server's code and message ride as-is, bounded like the renderer
    /// contract (a non-empty code, UTF-16 lengths).
    pub fn blocked(reason_code: impl Into<String>, message: impl Into<String>) -> Self {
        let reason_code =
            truncate_utf16(reason_code.into().trim(), LISTENING_REASON_CODE_MAX_UNITS);
        Self {
            state: CohostListeningState::Blocked,
            reason_code: Some(if reason_code.is_empty() {
                "unknown".to_string()
            } else {
                reason_code
            }),
            message: Some(truncate_utf16(&message.into(), LISTENING_MESSAGE_MAX_UNITS)),
            remaining_seconds: None,
        }
    }
}

// --- Persona and automatic chat (plan 164 S-A2) --------------------------------

/// The creature's name: 1 to 24 UTF-16 units, trimmed.
pub const COHOST_PERSONA_NAME_MAX_CHARS: usize = 24;
pub const COHOST_PERSONA_PERSONALITY_MAX_CHARS: usize = 1200;
pub const COHOST_GREETING_TEMPLATES_MAX: usize = 60;
pub const COHOST_GREETING_TEXT_MAX_CHARS: usize = 200;
/// A persona image path is `<personaId>/<state>.<ext>` under the managed
/// golem-assets root (plan 164 D20); the renderer turns it into a protocol URL.
const COHOST_PERSONA_IMAGE_PATH_MAX_CHARS: usize = 256;
/// The persona a fresh install has: the bundled default pack under this id.
pub const COHOST_DEFAULT_PERSONA_ID: &str = "default";
pub const COHOST_DEFAULT_PERSONA_NAME: &str = "Golem";

/// The avatar's state images (plan 164 D16). `idle` is required on stream;
/// the others fall back to it when missing.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum CohostAvatarState {
    Idle,
    Talk,
    Laugh,
    Think,
}

impl CohostAvatarState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Talk => "talk",
            Self::Laugh => "laugh",
            Self::Think => "think",
        }
    }
}

/// How the comic bubble is drawn (plan 164 D17).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CohostBubbleStyle {
    #[default]
    Speech,
    Thought,
    Shout,
}

/// Where the persona's images came from. `default` means the bundled pack.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CohostPersonaSource {
    #[default]
    Default,
    Uploaded,
    Generated,
}

/// One relative asset path per state. Absent, never null (the renderer
/// contract rejects null).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CohostPersonaImages {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub talk: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub laugh: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub think: Option<String>,
}

impl CohostPersonaImages {
    fn entries(&self) -> [(CohostAvatarState, Option<&str>); 4] {
        [
            (CohostAvatarState::Idle, self.idle.as_deref()),
            (CohostAvatarState::Talk, self.talk.as_deref()),
            (CohostAvatarState::Laugh, self.laugh.as_deref()),
            (CohostAvatarState::Think, self.think.as_deref()),
        ]
    }
}

/// The user's creature (plan 164): its name, personality and looks. Lives in
/// `cohostSettings.persona`; the images are relative paths under the managed
/// golem-assets root, owned by main (uploads) or the backend (generation).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostPersona {
    /// Names the asset folder; regenerated by "Start over".
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub personality: String,
    #[serde(default)]
    pub bubble_style: CohostBubbleStyle,
    #[serde(default)]
    pub images: CohostPersonaImages,
    #[serde(default)]
    pub source: CohostPersonaSource,
}

impl Default for CohostPersona {
    fn default() -> Self {
        Self {
            id: COHOST_DEFAULT_PERSONA_ID.to_string(),
            name: COHOST_DEFAULT_PERSONA_NAME.to_string(),
            personality: String::new(),
            bubble_style: CohostBubbleStyle::Speech,
            images: CohostPersonaImages::default(),
            source: CohostPersonaSource::Default,
        }
    }
}

/// The chat posting mode (plan 164 D4): everything is off by default.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CohostAutoChatMode {
    #[default]
    Off,
    Suggest,
    Auto,
}

/// The activity kinds a greeting template answers (plan 164). Closed: an
/// unknown kind is refused at the wire, never stored.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostActivityTemplateKind {
    Follow,
    Sub,
    Resub,
    SubGift,
    CommunitySubGift,
    Membership,
    Cheer,
    Kicks,
    SuperChat,
    SuperSticker,
    Raid,
    WatchStreak,
    PowerUp,
    Redemption,
}

/// The platforms a template may be limited to; omitted means any.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CohostGreetingPlatform {
    Twitch,
    Youtube,
    Kick,
    X,
}

/// The avatar state an utterance shows (plan 164 D18); never `idle`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CohostUtteranceState {
    #[default]
    Talk,
    Laugh,
    Think,
}

/// A greeting written by the user, with `{name}`-style fields resolved in
/// Phase D (plan 164 S-D1).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostGreetingTemplate {
    pub id: String,
    pub kind: CohostActivityTemplateKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<CohostGreetingPlatform>,
    pub text: String,
    #[serde(default)]
    pub state: CohostUtteranceState,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CohostGreetingsSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub templates: Vec<CohostGreetingTemplate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostCooldownBehaviour {
    #[serde(default)]
    pub enabled: bool,
    pub cooldown_seconds: u32,
}

/// The automatic behaviours (plan 164 D5), each behind its own switch under
/// the mode. Phase A stores them; Phase D acts on them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostAutoChat {
    #[serde(default)]
    pub mode: CohostAutoChatMode,
    #[serde(default)]
    pub greetings: CohostGreetingsSettings,
    #[serde(default = "default_answers")]
    pub answers: CohostCooldownBehaviour,
    #[serde(default = "default_banter")]
    pub banter: CohostCooldownBehaviour,
}

fn default_answers() -> CohostCooldownBehaviour {
    CohostCooldownBehaviour {
        enabled: false,
        cooldown_seconds: 20,
    }
}

fn default_banter() -> CohostCooldownBehaviour {
    CohostCooldownBehaviour {
        enabled: false,
        cooldown_seconds: 240,
    }
}

impl Default for CohostAutoChat {
    fn default() -> Self {
        Self {
            mode: CohostAutoChatMode::Off,
            greetings: CohostGreetingsSettings::default(),
            answers: default_answers(),
            banter: default_banter(),
        }
    }
}

fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// A stored image path is one folder (the persona id) and one file, never a
/// parent step or an absolute path: it is joined under the managed root.
fn persona_image_path_ok(path: &str) -> bool {
    !path.is_empty()
        && utf16_len(path) <= COHOST_PERSONA_IMAGE_PATH_MAX_CHARS
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.contains("..")
        && !path.contains('\\')
        && path.matches('/').count() == 1
}

/// The persona as the wire may carry it, trimmed: the name must be 1 to 24
/// characters, the personality at most 1200, the id a plain token, every
/// image path a relative `<id>/<file>` (plan 164 S-A2). The reason names the
/// field so the renderer can show it inline.
pub(crate) fn validate_persona(persona: &CohostPersona) -> Result<CohostPersona, String> {
    let mut valid = persona.clone();
    valid.name = persona.name.trim().to_string();
    if valid.name.is_empty() {
        return Err("The Golem needs a name.".to_string());
    }
    if utf16_len(&valid.name) > COHOST_PERSONA_NAME_MAX_CHARS {
        return Err(format!(
            "The name is at most {COHOST_PERSONA_NAME_MAX_CHARS} characters."
        ));
    }
    if valid.id.is_empty()
        || valid.id.len() > 128
        || !valid
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("The persona id must be a plain token.".to_string());
    }
    if utf16_len(&valid.personality) > COHOST_PERSONA_PERSONALITY_MAX_CHARS {
        return Err(format!(
            "The personality is at most {COHOST_PERSONA_PERSONALITY_MAX_CHARS} characters."
        ));
    }
    for (state, path) in valid.images.entries() {
        if let Some(path) = path
            && !persona_image_path_ok(path)
        {
            return Err(format!(
                "The {} image path is not a managed asset path.",
                state.as_str()
            ));
        }
    }
    Ok(valid)
}

/// The automatic chat settings as the wire may carry them: at most 60
/// templates, each 1 to 200 characters of text with a plain id (plan 164
/// S-A2). Unknown kinds never reach here: the closed enum refuses them.
pub(crate) fn validate_auto_chat(auto_chat: &CohostAutoChat) -> Result<CohostAutoChat, String> {
    let mut valid = auto_chat.clone();
    if valid.greetings.templates.len() > COHOST_GREETING_TEMPLATES_MAX {
        return Err(format!(
            "At most {COHOST_GREETING_TEMPLATES_MAX} greeting templates."
        ));
    }
    for template in &mut valid.greetings.templates {
        template.text = template.text.trim().to_string();
        if template.id.trim().is_empty() || template.id.len() > 128 {
            return Err("A greeting template needs an id.".to_string());
        }
        if template.text.is_empty() {
            return Err("A greeting template needs some text.".to_string());
        }
        if utf16_len(&template.text) > COHOST_GREETING_TEXT_MAX_CHARS {
            return Err(format!(
                "A greeting is at most {COHOST_GREETING_TEXT_MAX_CHARS} characters."
            ));
        }
    }
    for (label, behaviour) in [("answers", &valid.answers), ("banter", &valid.banter)] {
        if behaviour.cooldown_seconds == 0 || behaviour.cooldown_seconds > 3600 {
            return Err(format!("The {label} cooldown is 1 to 3600 seconds."));
        }
    }
    Ok(valid)
}

// --- Settings ----------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostSettings {
    pub enabled: bool,
    pub tone: CohostTone,
    pub notes: String,
    /// Golem's picks go on stream by themselves (server highlights and
    /// high-priority questions, with the engine's cadence rules).
    pub auto_highlight: bool,
    /// The comment the streamer is talking about goes on stream by itself.
    /// `default` so a settings row from before the field still loads.
    #[serde(default)]
    pub voice_highlight: bool,
    /// Plain-language chat rules the co-host flags against (wire v2). `default`
    /// so a settings row from before the field still loads.
    #[serde(default)]
    pub rules: Vec<String>,
    /// Golem hears the microphone for the whole live stream, as text, even
    /// with live captions off (plan 068 D2). `default` so a settings row from
    /// before the field still loads.
    #[serde(default)]
    pub listen: bool,
    /// "Commands need 'Golem' first" (plan 140 S3): the structured phrases
    /// ("remove it from our chat") stop working without the wake word.
    /// Default off. `default` so a settings row from before the field loads.
    #[serde(default)]
    pub wake_word_required: bool,
    /// How a voice removal is confirmed (plan 140 S3): `confirm` (the
    /// default) waits for a yes; `countdown` runs after 5 s unless cancelled,
    /// except on YouTube, which always waits. `default` for older rows.
    #[serde(default)]
    pub remove_confirm: RemoveConfirmMode,
    /// The user's creature (plan 164 S-A2). `default` so a settings row from
    /// before the field loads as the bundled default pack.
    #[serde(default)]
    pub persona: CohostPersona,
    /// Automatic chat (plan 164 S-A2): mode off and every behaviour disabled
    /// by default. `default` so a settings row from before the field loads.
    #[serde(default)]
    pub auto_chat: CohostAutoChat,
}

impl Default for CohostSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            tone: CohostTone::Friendly,
            notes: String::new(),
            auto_highlight: false,
            voice_highlight: false,
            rules: Vec::new(),
            listen: false,
            wake_word_required: false,
            remove_confirm: RemoveConfirmMode::Confirm,
            persona: CohostPersona::default(),
            auto_chat: CohostAutoChat::default(),
        }
    }
}

impl CohostSettings {
    fn normalized(mut self) -> Self {
        self.notes = truncate_utf16(&self.notes, COHOST_NOTES_MAX_CHARS);
        self.rules = normalize_rules(self.rules);
        self
    }

    fn apply(&mut self, patch: CohostSettingsPatch) {
        if let Some(enabled) = patch.enabled {
            self.enabled = enabled;
        }
        if let Some(tone) = patch.tone {
            self.tone = tone;
        }
        if let Some(notes) = patch.notes {
            self.notes = truncate_utf16(&notes, COHOST_NOTES_MAX_CHARS);
        }
        if let Some(auto_highlight) = patch.auto_highlight {
            self.auto_highlight = auto_highlight;
        }
        if let Some(voice_highlight) = patch.voice_highlight {
            self.voice_highlight = voice_highlight;
        }
        if let Some(rules) = patch.rules {
            self.rules = normalize_rules(rules);
        }
        if let Some(listen) = patch.listen {
            self.listen = listen;
        }
        if let Some(wake_word_required) = patch.wake_word_required {
            self.wake_word_required = wake_word_required;
        }
        if let Some(remove_confirm) = patch.remove_confirm {
            self.remove_confirm = remove_confirm;
        }
        if let Some(persona) = patch.persona {
            self.persona = persona;
        }
        if let Some(auto_chat) = patch.auto_chat {
            self.auto_chat = auto_chat;
        }
    }

    /// The patch with its persona and automatic chat validated and trimmed,
    /// or the first reason it is refused (plan 164 S-A2). Checked before
    /// anything is stored, so a refused patch changes nothing.
    fn validated_patch(patch: CohostSettingsPatch) -> Result<CohostSettingsPatch, CohostError> {
        let mut patch = patch;
        if let Some(persona) = patch.persona.take() {
            patch.persona = Some(validate_persona(&persona).map_err(CohostError::InvalidPersona)?);
        }
        if let Some(auto_chat) = patch.auto_chat.take() {
            patch.auto_chat =
                Some(validate_auto_chat(&auto_chat).map_err(CohostError::InvalidAutoChat)?);
        }
        Ok(patch)
    }
}

/// Trimmed, non-empty, at most `COHOST_RULES_MAX` rules of at most
/// `COHOST_RULE_MAX_CHARS` characters — exactly what the server accepts.
fn normalize_rules(rules: Vec<String>) -> Vec<String> {
    rules
        .iter()
        .map(|rule| truncate_utf16(rule.trim(), COHOST_RULE_MAX_CHARS))
        .map(|rule| rule.trim_end().to_string())
        .filter(|rule| !rule.is_empty())
        .take(COHOST_RULES_MAX)
        .collect()
}

pub fn load_cohost_settings(database: &Database) -> CohostSettings {
    match database.load_setting::<CohostSettings>(COHOST_SETTINGS_KEY) {
        Ok(Some(settings)) => settings.normalized(),
        Ok(None) => CohostSettings::default(),
        Err(error) => {
            tracing::warn!("Could not read Golem settings; using defaults: {error:#}");
            CohostSettings::default()
        }
    }
}

/// The longest prefix of `value` within `max_units` UTF-16 code units, cut
/// on a char boundary. Every text bound this engine meets counts UTF-16: the
/// renderer contract (`string.length`) and the web's zod limits alike, so an
/// emoji is two units, never one char.
pub(crate) fn truncate_utf16(value: &str, max_units: usize) -> String {
    let mut units = 0;
    for (index, ch) in value.char_indices() {
        units += ch.len_utf16();
        if units > max_units {
            return value[..index].to_string();
        }
    }
    value.to_string()
}

// --- Renderer-facing state -----------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostQuestion {
    pub id: String,
    pub text: String,
    pub message_ids: Vec<String>,
    pub askers: Vec<String>,
    pub platforms: Vec<StreamPlatform>,
    pub priority: CohostPriority,
    pub suggested_reply: String,
    pub from_notes: bool,
    pub first_seen_at: String,
    pub updated_at: String,
    /// v3: about what the streamer is talking about right now. Omitted while
    /// false (the renderer contract treats it as optional).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub on_topic: bool,
}

/// One promise the streamer made out loud (plan 068 D8): private until they
/// act on it. `value` is the viewer count or the minutes for that kind.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostPromiseTrigger {
    pub kind: CohostPromiseTriggerKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostPromise {
    pub id: String,
    pub text: String,
    pub trigger: CohostPromiseTrigger,
    pub first_seen_at: String,
}

/// The engine's latest met trigger, keyed on the promise: the renderer toasts
/// once per promise id. Replaced by the next one, cleared with its promise.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostPromiseReminder {
    pub promise_id: String,
    pub text: String,
    pub at: String,
}

/// A recap for viewers who asked what they missed, or one the streamer
/// drafted from the summary. Never posted by Golem; gone after `RECAP_TTL`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostRecap {
    pub text: String,
    pub at: String,
    pub expires_at: String,
}

/// A first-time chatter nobody greeted yet (plan 068 D9): "Say hi".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostSayHi {
    /// The engine's per-author key; `cohost.author.greeted` takes it back.
    pub author_key: String,
    pub name: String,
    pub platform: StreamPlatform,
    pub first_seen_at: String,
}

/// A private dead-air suggestion (plan 068 D9): the renderer toasts each
/// `key` once. Gone from the state after `DEAD_AIR_NUDGE_TTL`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostDeadAirNudge {
    pub key: String,
    pub text: String,
    pub at: String,
}

// --- Voice commands (plan 140 S3; contract part B) ------------------------------

/// What a voice command asked for. `confirm` and `cancel` answer the open
/// card, so they update that command instead of standing on their own.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostCommandKind {
    Highlight,
    Clear,
    Remove,
    Confirm,
    Cancel,
    Unknown,
}

/// Where the latest voice command stands.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostCommandStatus {
    /// It happened: highlighted, cleared, removed or hidden.
    Done,
    /// No comment matched, or Golem didn't catch what was said.
    NotFound,
    /// A chooser is open: `candidates` holds the comments to pick from.
    Ambiguous,
    /// A card waits for a yes: a voice removal (`operationId`), or a highlight
    /// of a comment Golem flagged. While a confirmed removal runs at the
    /// platform the status stays `confirm`, without `expiresAt`.
    Confirm,
    /// Chat moderation refused, or the removal failed.
    Refused,
    /// Paused by Videorc (kill switch) or not on this plan (Premium).
    Unavailable,
    Cancelled,
    /// Nobody answered in time; nothing happened.
    Expired,
}

/// The comment a command points at, as its card shows it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostCommandTarget {
    pub message_id: String,
    pub author_name: String,
    pub platform: StreamPlatform,
    /// At most 140 UTF-16 units of the message.
    pub excerpt: String,
}

/// The latest voice command and what became of it (contract part B). The
/// renderer draws the command strip, the removal card and the chooser from
/// it; answers go back through `cohost.command.*`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostCommand {
    /// `cmd-<uuid>`; the `cohost.command.*` RPCs take it back.
    pub id: String,
    /// The words that made the command, as Golem heard them.
    pub heard: String,
    pub kind: CohostCommandKind,
    pub status: CohostCommandStatus,
    /// One plain sentence for the strip and the card.
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<CohostCommandTarget>,
    /// The chooser's comments, at most three; omitted while empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<CohostCommandTarget>,
    /// The chat moderation operation behind a removal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    /// The audit reason heard with a removal ("toxic", "spam").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// When the command reached its current status (RFC 3339).
    pub at: String,
    /// When the open card or chooser expires; omitted when nothing waits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CohostSwitchState {
    On,
    Paused,
}

/// The remote kill switches (contract part D) as the renderer shows them:
/// "Voice commands are paused by Videorc." and "Removing messages is paused
/// by Videorc." Omitted from the state while both are on.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostCommandAvailability {
    pub voice_commands: CohostSwitchState,
    pub remove: CohostSwitchState,
}

/// `cohost.command.*` refusals: `invalid-params` (no command id, or a pick
/// past the chooser), `not-pending` (no such command is waiting for that
/// answer: it was answered, replaced or expired).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CohostCommandError {
    pub code: &'static str,
    pub message: String,
}

impl CohostCommandError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "invalid-params",
            message: message.into(),
        }
    }

    fn not_pending() -> Self {
        Self {
            code: "not-pending",
            message: "No Golem command is waiting for that answer.".to_string(),
        }
    }
}

/// The v2 extras are absent keys when the server did not send them — never
/// `null`: the renderer contract rejects null for optional fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohostFlag {
    pub message_id: String,
    pub kind: CohostFlagKind,
    pub severity: CohostFlagSeverity,
    pub reason: String,
    pub at: String,
    /// 0..1. The renderer's Sensitivity control filters on it; a flag without
    /// one always shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<CohostFlagTarget>,
    /// Suggested action — a label only, the desktop never acts on a flag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<CohostFlagAction>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub also_kinds: Vec<CohostFlagKind>,
    /// The streamer rule this message broke, resolved from the tick's
    /// `ruleIndex` against the rules that tick actually sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
}

/// A comment the server suggests showing on stream. Suggest-first: nothing is
/// highlighted because of this entry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohostHighlight {
    pub message_id: String,
    pub score: f64,
    #[serde(rename = "type")]
    pub highlight_type: CohostHighlightType,
}

/// One entry per alert kind viewers reported in the last `ALERT_EXPIRY`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostAlert {
    pub kind: CohostAlertKind,
    /// Distinct authors who reported it.
    pub viewers: u32,
    pub last_seen_at: String,
    /// At least two distinct authors reported it within 60 s of each other.
    pub active: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohostMoodScores {
    pub hype: f64,
    pub tension: f64,
    pub confusion: f64,
}

/// What the last failed tick actually said, so the toast, the chip and a bug
/// report can name the error instead of "AI returned an error". `code` is the
/// server's envelope code verbatim (or a desktop-assigned `network` /
/// `timeout` / `malformed-response`), `status` the HTTP status when one was
/// received. Cleared the moment the engine is listening again.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostErrorDetail {
    pub code: String,
    pub message: String,
    pub status: Option<u16>,
}

impl CohostErrorDetail {
    pub fn new(code: impl Into<String>, message: impl Into<String>, status: Option<u16>) -> Self {
        let message: String = message.into();
        Self {
            code: code.into(),
            message: truncate_utf16(message.trim(), ERROR_DETAIL_MESSAGE_MAX_CHARS),
            status,
        }
    }
}

/// The `cohost.state` event payload and the result of every `cohost.*` RPC.
/// Nullable fields serialize as explicit `null` (the renderer reducer keys on
/// them), never as absent keys. `detail` and the presence fields are
/// additionally `default` on read so a payload from before they existed still
/// parses. The wire-v2 fields are the exception: they are omitted while empty
/// (`skip_serializing_if`), because the renderer contract treats them as
/// optional and rejects `null`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohostState {
    pub session_id: Option<String>,
    pub status: CohostStatus,
    pub reason: Option<CohostReason>,
    /// Present only while `reason` describes a failed tick (status `error`, or
    /// `paused` by the server: quota, Premium, consent).
    #[serde(default)]
    pub detail: Option<CohostErrorDetail>,
    pub questions: Vec<CohostQuestion>,
    pub flags: Vec<CohostFlag>,
    pub mood: Option<CohostMood>,
    pub last_tick_at: Option<String>,
    pub tick_seq: u64,
    pub partial: bool,
    /// A tick HTTP request is outstanding right now ("thinking").
    #[serde(default)]
    pub tick_in_flight: bool,
    /// Delta messages collected but not yet sent in a tick — "I've seen your
    /// chat and I'm on it".
    #[serde(default)]
    pub pending_messages: u32,
    /// ISO-8601 instant of the scheduler's earliest possible next pass, present
    /// only while `pending_messages > 0`: the burst rule (>= 5 pending) fires as
    /// soon as the 8 s min gap allows, the trickle rule at anchor + 20 s, and a
    /// backoff/quota window pushes both back.
    #[serde(default)]
    pub next_tick_at: Option<String>,
    /// Session total of chat messages noted to the engine (entered a delta).
    #[serde(default)]
    pub messages_seen: u64,
    /// Distinct question ids this session ever surfaced — lifetime count, not
    /// the open count.
    #[serde(default)]
    pub questions_total: u64,
    /// Latest tick's suggested comments, best first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub highlights: Vec<CohostHighlight>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alerts: Vec<CohostAlert>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mood_scores: Option<CohostMoodScores>,
    /// The engine's latest automatic on-stream command (plan 060 S1). Omitted
    /// until the engine made one this session; the renderer acts on a new
    /// `generation` only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_highlight: Option<CohostAutoHighlight>,
    /// The comment the streamer is talking about (plan 060 S3). Omitted
    /// while there is none, or once it expired.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spotlight: Option<CohostSpotlight>,
    /// Questions the engine resolved on its own in the last minute, oldest
    /// first, at most three. Omitted while empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recently_resolved: Vec<CohostRecentlyResolved>,
    /// Whether Golem hears the streamer (plan 068). Omitted without a session
    /// or by a backend from before the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listening: Option<CohostListening>,
    /// What the streamer is talking about (plan 068 D7, v3). Omitted until
    /// the server said so.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    /// Open promises, oldest first, at most 20. Omitted while empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub promises: Vec<CohostPromise>,
    /// The latest met promise trigger; omitted until one fired.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promise_reminder: Option<CohostPromiseReminder>,
    /// Omitted while there is no recap, or once it expired.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recap: Option<CohostRecap>,
    /// First-time chatters not greeted yet, first seen within 15 minutes,
    /// oldest first, at most five (plan 068 D9). Omitted while empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub say_hi: Vec<CohostSayHi>,
    /// The latest dead-air nudge while it is fresh; omitted otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dead_air_nudge: Option<CohostDeadAirNudge>,
    /// The latest voice command (plan 140 S3); omitted until one was heard
    /// this session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<CohostCommand>,
    /// The voice-command kill switches; omitted while both are on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_availability: Option<CohostCommandAvailability>,
}

impl CohostState {
    pub fn off() -> Self {
        Self {
            session_id: None,
            status: CohostStatus::Off,
            reason: None,
            detail: None,
            questions: Vec::new(),
            flags: Vec::new(),
            mood: None,
            last_tick_at: None,
            tick_seq: 0,
            partial: false,
            tick_in_flight: false,
            pending_messages: 0,
            next_tick_at: None,
            messages_seen: 0,
            questions_total: 0,
            highlights: Vec::new(),
            alerts: Vec::new(),
            mood_scores: None,
            auto_highlight: None,
            spotlight: None,
            recently_resolved: Vec::new(),
            listening: None,
            topic: None,
            promises: Vec::new(),
            promise_reminder: None,
            recap: None,
            say_hi: Vec::new(),
            dead_air_nudge: None,
            command: None,
            command_availability: None,
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CohostError {
    #[error("Golem is turned off in Settings.")]
    Disabled,
    /// Plan 140 S1: Golem is Premium only, enforced here and not just by the
    /// renderer's `liveCohostGate`.
    #[error("Golem requires Videorc Premium.")]
    PremiumRequired,
    #[error("Golem needs the active live chat session; sessionId did not match.")]
    SessionMismatch,
    #[error("sessionId and the question, message, promise or author id are required.")]
    InvalidParams,
    #[error("Golem has nothing to recap yet: no summary has arrived this session.")]
    NoSummary,
    #[error("Could not persist Golem settings: {0}")]
    Storage(String),
    /// Plan 164 S-A2: the persona on a settings patch is out of bounds.
    #[error("{0}")]
    InvalidPersona(String),
    /// Plan 164 S-A2: the automatic chat settings on a patch are out of bounds.
    #[error("{0}")]
    InvalidAutoChat(String),
}

impl CohostError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Disabled => "cohost-disabled",
            Self::PremiumRequired => "premium-required",
            Self::SessionMismatch => "cohost-session-mismatch",
            Self::InvalidParams => "invalid-params",
            Self::NoSummary => "cohost-no-summary",
            Self::Storage(_) => "cohost-settings-storage-failed",
            Self::InvalidPersona(_) => "cohost-persona-invalid",
            Self::InvalidAutoChat(_) => "cohost-auto-chat-invalid",
        }
    }
}

// --- Engine ----------------------------------------------------------------------

pub type CohostSlot = Arc<Mutex<CohostEngine>>;

pub fn new_cohost_slot(settings: CohostSettings) -> CohostSlot {
    Arc::new(Mutex::new(CohostEngine::new(settings)))
}

// --- Transcript window (plan 060 S3) -------------------------------------------

/// The last seconds of the streamer's live captions, as the spotlight lane
/// sends them: finals only, at most `SPOTLIGHT_TRANSCRIPT_WINDOW` old and
/// `SPOTLIGHT_TRANSCRIPT_MAX_CHARS` long (oldest finals leave first). Behind a
/// std mutex on `AppState`, never the engine's async lock: the caption
/// coordinator appends and returns, and never waits on a tick.
#[derive(Debug, Default)]
pub struct TranscriptWindow {
    finals: VecDeque<TranscriptFinal>,
    chars: usize,
    /// Bumped per appended final; the lane calls once per change.
    version: u64,
    last_final_at: Option<Instant>,
}

#[derive(Debug, Clone)]
struct TranscriptFinal {
    at: Instant,
    text: String,
    chars: usize,
}

/// What the lane reads on a pass: the joined window text and its identity.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct TranscriptSnapshot {
    pub(crate) text: String,
    pub(crate) version: u64,
    pub(crate) last_final_at: Option<Instant>,
}

impl TranscriptWindow {
    /// Append one final. Whitespace is collapsed; an empty final is ignored;
    /// a single final longer than the cap keeps its tail. Amortised constant
    /// time: every final is trimmed out at most once.
    pub(crate) fn push(&mut self, text: &str, now: Instant) {
        let mut text: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() {
            return;
        }
        let mut chars = text.chars().count();
        if chars > SPOTLIGHT_TRANSCRIPT_MAX_CHARS {
            text = text
                .chars()
                .skip(chars - SPOTLIGHT_TRANSCRIPT_MAX_CHARS)
                .collect();
            chars = SPOTLIGHT_TRANSCRIPT_MAX_CHARS;
        }
        self.trim_older_than(now);
        self.finals.push_back(TranscriptFinal {
            at: now,
            text,
            chars,
        });
        self.chars += chars;
        // The cap is on the joined text the server sees: the separators count.
        while self.joined_chars() > SPOTLIGHT_TRANSCRIPT_MAX_CHARS {
            if let Some(oldest) = self.finals.pop_front() {
                self.chars -= oldest.chars;
            }
        }
        self.version = self.version.wrapping_add(1);
        self.last_final_at = Some(now);
    }

    fn joined_chars(&self) -> usize {
        self.chars + self.finals.len().saturating_sub(1)
    }

    fn trim_older_than(&mut self, now: Instant) {
        while self.finals.front().is_some_and(|oldest| {
            now.saturating_duration_since(oldest.at) >= SPOTLIGHT_TRANSCRIPT_WINDOW
        }) {
            if let Some(oldest) = self.finals.pop_front() {
                self.chars -= oldest.chars;
            }
        }
    }

    pub(crate) fn snapshot(&self, now: Instant) -> TranscriptSnapshot {
        let text = self
            .finals
            .iter()
            .filter(|final_| now.saturating_duration_since(final_.at) < SPOTLIGHT_TRANSCRIPT_WINDOW)
            .map(|final_| final_.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        TranscriptSnapshot {
            text,
            version: self.version,
            last_final_at: self.last_final_at,
        }
    }

    pub(crate) fn clear(&mut self) {
        self.finals.clear();
        self.chars = 0;
        self.last_final_at = None;
        self.version = self.version.wrapping_add(1);
    }
}

pub type CohostTranscriptSlot = Arc<std::sync::Mutex<TranscriptWindow>>;

pub fn new_cohost_transcript_slot() -> CohostTranscriptSlot {
    Arc::new(std::sync::Mutex::new(TranscriptWindow::default()))
}

// --- Recent speech (plan 068 S3) ----------------------------------------------------

/// How long a transcript final stays readable by the later slices (Clip
/// that, the tick transcript, greeting by voice).
pub const RECENT_SPEECH_WINDOW: Duration = Duration::from_secs(5 * 60);

/// One settled transcript final with its file-time window.
#[derive(Debug, Clone, PartialEq)]
pub struct RecentSpeechFinal {
    /// Monotonic arrival time; the window is trimmed against it.
    pub at: Instant,
    /// Seconds from the capture epoch (file time) to the final's first sample.
    pub offset_seconds: f64,
    pub duration_seconds: f64,
    pub text: String,
    /// Word timing relative to `offset_seconds` (empty on the realtime path
    /// and older web deploys).
    pub segments: Vec<crate::captions::CaptionSegment>,
    /// Captions were presenting when this final landed.
    pub presented: bool,
}

/// The last five minutes of transcript finals, in memory, in arrival order.
/// Both caption intents feed it (plan 068 D1); a session boundary clears it
/// with the spotlight transcript. Behind a std mutex on `AppState`: the caption
/// task appends and returns, and never waits on the engine.
#[derive(Debug, Default)]
pub struct RecentSpeech {
    finals: VecDeque<RecentSpeechFinal>,
    /// Bumped per append and per clear; readers poll with it.
    version: u64,
}

/// What a reader gets when the buffer changed since the version it saw. The
/// tick scheduler polls it for the v3 transcript (plan 068 S5); Clip that and
/// greeting by voice read it too.
#[derive(Debug, Clone, PartialEq)]
pub struct RecentSpeechSnapshot {
    pub finals: Vec<RecentSpeechFinal>,
    pub version: u64,
}

impl RecentSpeech {
    pub(crate) fn push(&mut self, final_: RecentSpeechFinal) {
        let now = final_.at;
        self.trim_older_than(now);
        self.finals.push_back(final_);
        self.version = self.version.wrapping_add(1);
    }

    fn trim_older_than(&mut self, now: Instant) {
        while self
            .finals
            .front()
            .is_some_and(|oldest| now.saturating_duration_since(oldest.at) >= RECENT_SPEECH_WINDOW)
        {
            self.finals.pop_front();
        }
    }

    /// `None` when nothing changed since `seen_version`; otherwise every final
    /// still inside the window at `now`, oldest first, with the new version.
    pub(crate) fn since(
        &self,
        seen_version: Option<u64>,
        now: Instant,
    ) -> Option<RecentSpeechSnapshot> {
        if seen_version == Some(self.version) {
            return None;
        }
        Some(RecentSpeechSnapshot {
            finals: self
                .finals
                .iter()
                .filter(|final_| now.saturating_duration_since(final_.at) < RECENT_SPEECH_WINDOW)
                .cloned()
                .collect(),
            version: self.version,
        })
    }

    pub(crate) fn clear(&mut self) {
        self.finals.clear();
        self.version = self.version.wrapping_add(1);
    }

    #[allow(dead_code)]
    pub fn version(&self) -> u64 {
        self.version
    }
}

pub type CohostRecentSpeechSlot = Arc<std::sync::Mutex<RecentSpeech>>;

pub fn new_cohost_recent_speech_slot() -> CohostRecentSpeechSlot {
    Arc::new(std::sync::Mutex::new(RecentSpeech::default()))
}

// --- Voice activity (plan 068 D9) ---------------------------------------------------

/// What the caption task observed on the microphone frames it received.
/// Computed on the caption task, never on the audio thread. The tap is
/// post-mute, so a muted microphone is exact digital silence here (so is a
/// lost device's generated silence); a live microphone never is, even in a
/// quiet room.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct VoiceActivity {
    /// Last monotonic instant a frame carried speech-level energy.
    pub last_voice_at: Option<Instant>,
    /// Last monotonic instant any frame reached the caption task.
    pub last_frame_at: Option<Instant>,
    /// Last monotonic instant a frame was not exact digital silence.
    pub last_signal_at: Option<Instant>,
    /// Start of the current run of live-signal frames (a gap longer than
    /// `VOICE_FRAME_STALE` starts a new one): the dead-air clock never counts
    /// a mute as quiet.
    pub live_since: Option<Instant>,
}

pub type CohostVoiceSlot = Arc<std::sync::Mutex<VoiceActivity>>;

pub fn new_cohost_voice_slot() -> CohostVoiceSlot {
    Arc::new(std::sync::Mutex::new(VoiceActivity::default()))
}

/// Caption-task hook: one received frame, `raw` as the session bus emitted it
/// (post gain and mute) and `mono` already downmixed to 16 kHz.
pub(crate) fn note_voice_frame(state: &AppState, raw: &[f32], mono: &[i16], now: Instant) {
    let voiced = crate::captions::pcm_has_voice(mono);
    let signal = raw.iter().any(|sample| *sample != 0.0);
    if let Ok(mut voice) = state.cohost_voice.lock() {
        voice.last_frame_at = Some(now);
        if signal {
            if voice.last_signal_at.is_none_or(|last| {
                now.saturating_duration_since(last) > crate::cohost_ack::VOICE_FRAME_STALE
            }) {
                voice.live_since = Some(now);
            }
            voice.last_signal_at = Some(now);
        }
        if voiced {
            voice.last_voice_at = Some(now);
        }
    }
}

/// The latest voice-activity observation (the dead-air nudge reads it).
pub fn voice_activity(state: &AppState) -> VoiceActivity {
    state
        .cohost_voice
        .lock()
        .map(|voice| *voice)
        .unwrap_or_default()
}

/// The recent-speech buffer if it changed since `seen_version` (`None` to
/// read unconditionally). The tick scheduler polls it every pass.
pub fn recent_speech_since(
    state: &AppState,
    seen_version: Option<u64>,
) -> Option<RecentSpeechSnapshot> {
    state
        .cohost_recent_speech
        .lock()
        .ok()
        .and_then(|speech| speech.since(seen_version, Instant::now()))
}

/// Why the scheduler did not send a request on this pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TickGate {
    /// Scheduler must exit: its session/generation was replaced.
    Stopped,
    /// Nothing to do right now.
    Idle,
    /// A precondition is unmet; the engine is paused with the reason.
    Paused(CohostReason),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct PreparedTick {
    pub(crate) request: CohostTickRequest,
    pub(crate) generation: u64,
}

/// What the spotlight lane does on this pass.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SpotlightPass {
    /// Its session/generation was replaced or the co-host was turned off.
    Stopped,
    Idle,
    Send(PreparedSpotlight),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct PreparedSpotlight {
    pub(crate) request: CohostSpotlightRequest,
    pub(crate) generation: u64,
}

/// What one spotlight answer (or failure) changed, for the emit and the log.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct SpotlightOutcome {
    /// The state snapshot differs: spotlight set, refreshed or cleared, or a
    /// question resolved.
    pub(crate) changed: bool,
    /// A new message became the spotlight: `(message_id, about)`.
    pub(crate) spotlight_set: Option<(String, f64)>,
    /// Question ids resolved by voice on this answer.
    pub(crate) resolved: Vec<String>,
    /// The breaker closed the lane for this long.
    pub(crate) lane_off_for: Option<Duration>,
}

/// What one "Say hi" / dead-air pass changed (plan 068 D9).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct AcknowledgementPass {
    /// The state snapshot differs: "Say hi" changed or a nudge fired.
    pub(crate) changed: bool,
    /// The nudge that just fired, for the log.
    pub(crate) nudge: Option<String>,
}

/// One viewer saying "something is broken" (`alerts[]`), kept until it expires
/// so the state can count distinct authors per kind.
#[derive(Debug, Clone)]
struct AlertReport {
    kind: CohostAlertKind,
    author: String,
    at: Instant,
    at_iso: String,
}

struct CohostSession {
    session_id: String,
    generation: u64,
    consent: bool,
    /// Whether Golem hears the streamer this session (plan 068).
    listening: Option<CohostListening>,
    stream_title: Option<String>,
    status: CohostStatus,
    reason: Option<CohostReason>,
    detail: Option<CohostErrorDetail>,
    questions: Vec<CohostQuestion>,
    flags: Vec<CohostFlag>,
    mood: Option<CohostMood>,
    tick_seq: u64,
    partial: bool,
    started_at: Instant,
    last_tick_at: Option<Instant>,
    last_tick_iso: Option<String>,
    /// `(received_at, id)` of the newest noted message; rows at or before it
    /// are replays and never re-enter the delta.
    cursor: Option<(String, String)>,
    /// Oldest-first delta since the last tick, capped to the newest
    /// `TICK_DELTA_CAP` rows.
    pending: VecDeque<CohostTickMessage>,
    dropped: u64,
    known_ids: VecDeque<String>,
    known_set: HashSet<String>,
    dismissed_questions: HashSet<String>,
    dismissed_flags: HashSet<String>,
    backoff_index: usize,
    next_attempt_at: Option<Instant>,
    in_flight: bool,
    /// Session total of messages that entered a delta (presence indicator).
    messages_seen: u64,
    /// Every question id this session ever surfaced, so `questions_total`
    /// counts each grouped question exactly once across ticks.
    counted_question_ids: HashSet<String>,
    questions_total: u64,
    /// Wire version this session speaks: v2 until the server answers
    /// `prompt-version-unsupported`, then v1 until the session ends.
    prompt_version: u32,
    /// The version fallback just happened: the rejected batch is back in the
    /// delta and goes out again as soon as the min gap allows.
    version_retry: bool,
    /// What the outstanding tick sent: the batch (restored on a version
    /// fallback) and the rules its `ruleIndex` values point into.
    in_flight_messages: Vec<CohostTickMessage>,
    in_flight_dropped: u64,
    in_flight_rules: Vec<String>,
    /// Author identity, roles and note time per known message id: distinct-author
    /// alert counts and the automatic-card rules read it.
    known: HashMap<String, KnownMessage>,
    /// Known rows that were deleted after they were sent in a tick.
    deleted_ids: HashSet<String>,
    highlights: Vec<CohostHighlight>,
    alert_reports: Vec<AlertReport>,
    mood_scores: Option<CohostMoodScores>,
    /// Automatic on-stream cards (plan 060 S1). All of it is per session: a
    /// new session starts with no history, like the dismissed sets.
    auto: AutoHighlightLedger,
    /// The spotlight lane (plan 060 S3), per session like the tick state.
    spotlight: SpotlightLane,
    /// Voice-resolved questions the streamer can put back, oldest first.
    recently_resolved: Vec<ResolvedRecord>,
    /// v3 (plan 068 D7/D8). The rolling summary the server returned last and
    /// the desktop echoes; the current topic; the open promises with their
    /// bookkeeping; the recap; and the transcript cursor into the
    /// recent-speech buffer.
    summary: String,
    topic: Option<String>,
    promises: Vec<CohostPromise>,
    /// Monotonic first-seen per open promise id, for the minutes trigger.
    promise_seen: HashMap<String, Instant>,
    /// Done or dismissed ids: never return from a later tick.
    closed_promises: HashSet<String>,
    /// Ids whose trigger already fired: one reminder per promise.
    reminded_promises: HashSet<String>,
    promise_reminder: Option<CohostPromiseReminder>,
    next_promise_seq: u64,
    recap: Option<CohostRecap>,
    recap_expires_at: Option<Instant>,
    /// Recent-speech version the scheduler last read, and the arrival time of
    /// the newest final already folded into `transcript_pending`.
    speech_version: Option<u64>,
    speech_cursor: Option<Instant>,
    /// Finals since the previous tick, oldest first, capped to the newest
    /// `TRANSCRIPT_PENDING_CAP_CHARS`.
    transcript_pending: String,
    /// What the outstanding tick sent, restored on a version fallback.
    in_flight_transcript: String,
    /// A v3 tick succeeded this session: the server speaks v3, so a tick
    /// with speech and no chat is safe to send. A rolled-back server would
    /// answer a chat-less tick `invalid-request`, not
    /// `prompt-version-unsupported`, so speech alone waits for this.
    v3_confirmed: bool,
    /// Sign-out forgot the speech the in-flight tick carried: drop its answer.
    discard_in_flight: bool,
    /// Chat you haven't acknowledged (plan 068 D9): who chatted this session
    /// and who was greeted, and the dead-air nudge.
    ledger: AuthorLedger,
    dead_air: DeadAirLane,
    /// Wall-clock start, for the report (plan 119 S1).
    started_at_iso: String,
    /// What this session's report will say (plan 119 S1).
    report: ReportLedger,
    /// Plan 140 S3: the latest voice command and the card it holds open.
    command: Option<CommandRecord>,
    /// Removal operations voice commands created this session, for the
    /// report: each terminal outcome is counted once.
    command_operations: HashMap<String, CommandOperationTrack>,
}

/// What the engine remembers about one chat row it noted.
#[derive(Debug, Clone)]
struct KnownMessage {
    /// Platform-qualified author key (`alert_author_key`).
    author: String,
    /// Display name, as the tick sent it.
    author_name: String,
    /// Normalised roles (`normalize_role`).
    roles: Vec<String>,
    /// Text as the tick sent it (trimmed, capped), for spotlight candidates.
    text: String,
    /// Provider timestamp as the tick sent it.
    at: String,
    noted_at: Instant,
    /// Plan 140 S3: the platform a command card names.
    platform: StreamPlatform,
    /// A Twitch notification row that arrived as a message: voice commands
    /// never target it (it has no deletable id).
    notification: bool,
}

/// The spotlight lane's per-session memory: cadence, breaker, the current
/// spotlight and the "answered" streaks behind a voice resolve.
#[derive(Debug, Default)]
struct SpotlightLane {
    seq: u64,
    in_flight: bool,
    last_call_at: Option<Instant>,
    /// Transcript version the last call sent; `None` before the first call.
    last_version: Option<u64>,
    failures: usize,
    off_until: Option<Instant>,
    /// Calls in a row that said "answered" per open question id.
    answered_streak: HashMap<String, u32>,
    current: Option<SpotlightRecord>,
}

/// Plan 140 S8: the cloud command parser's client side. Engine-wide, so a
/// quota pause outlives a session restart.
#[derive(Debug, Default)]
struct CommandParserLane {
    /// `features.cohostCommandEnabled` from the last capability read. Off
    /// until the web says otherwise: nothing is sent while it is off.
    enabled: bool,
    seq: u64,
    in_flight: bool,
    last_call_at: Option<Instant>,
    /// A 429 (`Retry-After`) or an unavailable route pauses the parser.
    off_until: Option<Instant>,
}

/// One parse on its way: the request, and the command card that was
/// current when it left (a newer command since makes the answer stale).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreparedCommandParse {
    pub(crate) request: CohostCommandRequest,
    command_id: Option<String>,
}

/// What a wake-word utterance the grammar missed turned into.
#[derive(Debug, Clone, PartialEq, Eq)]
enum UnknownCommandResolution {
    /// The parser read it: run it like a spoken command.
    Resolved(CommandKind, Vec<String>),
    /// "Golem didn't catch that".
    Unheard,
    /// A newer command, or a session change, landed while the parser was
    /// thinking: say nothing.
    Superseded,
}

#[derive(Debug, Clone)]
struct SpotlightRecord {
    message_id: String,
    question_id: Option<String>,
    score: f64,
    at_iso: String,
    expires_at: Instant,
    expires_at_iso: String,
}

#[derive(Debug, Clone)]
struct ResolvedRecord {
    entry: CohostRecentlyResolved,
    at: Instant,
}

/// A card the engine saw live on the overlay.
#[derive(Debug, Clone)]
struct ObservedCard {
    message_id: String,
    /// The engine asked for this card (else the streamer set it by hand).
    engine_set: bool,
    expires_at: Instant,
}

/// An automatic command the renderer has not turned into a live card yet.
#[derive(Debug, Clone)]
struct PendingAutoRequest {
    message_id: String,
    asked_at: Instant,
    /// A voice refresh re-sets a card that is still live: it is fulfilled
    /// only once the observed card's expiry moves forward, never by the old
    /// card still being there.
    refresh: bool,
}

/// Session-scoped memory behind the automatic-card rules.
#[derive(Debug, Default)]
struct AutoHighlightLedger {
    /// The latest command, as published in `cohost.state`.
    latest: Option<CohostAutoHighlight>,
    /// Outstanding command (cleared when its card shows up live, or times out).
    requested: Option<PendingAutoRequest>,
    /// The card currently live on the overlay, as last observed.
    card: Option<ObservedCard>,
    /// When the previous card left the stream (its expiry, or an earlier clear).
    last_card_end: Option<Instant>,
    /// Message ids that were on stream this session, automatically or by hand.
    shown: HashSet<String>,
    /// Message ids the report already counted as on stream. Apart from
    /// `shown`, which an engine command fills when it is issued: counting off
    /// `shown` missed every automatic, voice and command card.
    counted_on_stream: HashSet<String>,
    /// Author key of the previous automatic card.
    last_author: Option<String>,
    /// Types of the recent automatic cards, oldest first (bounded).
    recent_types: Vec<CohostHighlightType>,
    /// The voice card that already got its one refresh.
    voice_refreshed: Option<String>,
}

/// Plan 119 S1: the counters and logs behind one session's report. Every
/// user or engine action bumps exactly one counter, when it changed the
/// state; the question log keeps the latest outcome per id. Built into a
/// `CohostSessionReport` once, at stop.
#[derive(Debug, Default)]
struct ReportLedger {
    questions_marked_answered: u64,
    questions_dismissed: u64,
    questions_replied: u64,
    questions_answered_on_air: u64,
    questions_restored: u64,
    questions_shown_on_stream: u64,
    /// Distinct comments on stream this session, automatic or by hand.
    shown_on_stream: u64,
    flags_raised: u64,
    flags_dismissed: u64,
    flag_kinds: Vec<CohostReportFlagKindCount>,
    flag_severities: Vec<CohostReportFlagSeverityCount>,
    promises_heard: u64,
    promises_kept: u64,
    promises_dismissed: u64,
    promises_reminded: u64,
    recap_offered: u64,
    recap_drafted: u64,
    recap_dismissed: u64,
    alerts: Vec<CohostReportAlert>,
    /// First seen first, at most `COHOST_REPORT_QUESTIONS_CAP`.
    questions: Vec<CohostReportQuestion>,
    /// Plan 140 S3: what voice commands did, counts only.
    commands: CohostReportCommands,
}

impl ReportLedger {
    /// A question in the open set after a tick (new, or kept): log it, or
    /// refresh its wording, askers, platforms and priority. Its outcome and
    /// first-seen time stay.
    fn note_question(&mut self, question: &CohostQuestion) {
        let askers: Vec<String> = question
            .askers
            .iter()
            .take(COHOST_REPORT_ASKERS_CAP)
            .cloned()
            .collect();
        if let Some(entry) = self
            .questions
            .iter_mut()
            .find(|entry| entry.id == question.id)
        {
            entry.text = question.text.clone();
            entry.askers = askers;
            entry.platforms = question.platforms.clone();
            entry.priority = question.priority;
            return;
        }
        if self.questions.len() >= COHOST_REPORT_QUESTIONS_CAP {
            return;
        }
        self.questions.push(CohostReportQuestion {
            id: question.id.clone(),
            text: question.text.clone(),
            askers,
            platforms: question.platforms.clone(),
            priority: question.priority,
            first_seen_at: question.first_seen_at.clone(),
            outcome: CohostReportQuestionOutcome::Open,
        });
    }

    /// An open question left the open set for `outcome`.
    fn question_closed(&mut self, question_id: &str, outcome: CohostReportQuestionOutcome) {
        match outcome {
            CohostReportQuestionOutcome::MarkedAnswered => self.questions_marked_answered += 1,
            CohostReportQuestionOutcome::Dismissed => self.questions_dismissed += 1,
            CohostReportQuestionOutcome::Replied => self.questions_replied += 1,
            CohostReportQuestionOutcome::AnsweredOnAir => self.questions_answered_on_air += 1,
            // Not closes; callers never pass them.
            CohostReportQuestionOutcome::Open | CohostReportQuestionOutcome::Shown => {}
        }
        self.set_outcome(question_id, outcome);
    }

    /// A voice-resolved question went back to the open set.
    fn question_restored(&mut self, question_id: &str) {
        self.questions_restored += 1;
        self.set_outcome(question_id, CohostReportQuestionOutcome::Open);
    }

    /// A comment went on stream, counted once per message. When it carries an
    /// open question, that question reads `shown` until something closes it.
    fn comment_shown(&mut self, question_id: Option<&str>) {
        self.shown_on_stream += 1;
        let Some(question_id) = question_id else {
            return;
        };
        self.questions_shown_on_stream += 1;
        if let Some(entry) = self
            .questions
            .iter_mut()
            .find(|entry| entry.id == question_id)
            && entry.outcome == CohostReportQuestionOutcome::Open
        {
            entry.outcome = CohostReportQuestionOutcome::Shown;
        }
    }

    fn set_outcome(&mut self, question_id: &str, outcome: CohostReportQuestionOutcome) {
        if let Some(entry) = self
            .questions
            .iter_mut()
            .find(|entry| entry.id == question_id)
        {
            entry.outcome = outcome;
        }
    }

    /// A new flagged message id (each counted once, whatever later ticks say).
    fn flag_raised(&mut self, kind: CohostFlagKind, severity: CohostFlagSeverity) {
        self.flags_raised += 1;
        match self.flag_kinds.iter_mut().find(|count| count.kind == kind) {
            Some(count) => count.count += 1,
            None => self
                .flag_kinds
                .push(CohostReportFlagKindCount { kind, count: 1 }),
        }
        match self
            .flag_severities
            .iter_mut()
            .find(|count| count.severity == severity)
        {
            Some(count) => count.count += 1,
            None => self
                .flag_severities
                .push(CohostReportFlagSeverityCount { severity, count: 1 }),
        }
    }

    /// The alerts as the state shows them after a tick that reported some:
    /// the peak distinct-viewer count per kind, and whether it was ever
    /// corroborated.
    fn note_alerts(&mut self, alerts: &[CohostAlert], now_iso: &str) {
        for alert in alerts {
            match self
                .alerts
                .iter_mut()
                .find(|entry| entry.kind == alert.kind)
            {
                Some(entry) => {
                    entry.peak_viewers = entry.peak_viewers.max(alert.viewers);
                    entry.active |= alert.active;
                }
                None => self.alerts.push(CohostReportAlert {
                    kind: alert.kind,
                    peak_viewers: alert.viewers,
                    active: alert.active,
                    first_seen_at: now_iso.to_string(),
                }),
            }
        }
    }
}

// --- Voice commands: the engine's side (plan 140 S3) -------------------------------
//
// A detected command (`cohost_command`) runs on its own task, never on the
// tick pass. Under the engine lock it re-checks its session generation and
// the gates (Premium, the kill switches), resolves its target from what the
// engine already knows (`known`, flags, the spotlight, the open questions)
// and updates `CohostState.command`. Anything slow runs after the lock: the
// clear, and every chat moderation call. Removals are chat moderation's
// durable operations (`live_chat_moderation`); their changes come back
// through `note_moderation_operation`.

/// How long a chooser or a highlight confirm card waits for an answer. A
/// removal card is its moderation operation's (`confirmBy`/`executeAt`).
#[cfg(not(test))]
pub(crate) const COMMAND_CARD_TTL: Duration = Duration::from_secs(20);
#[cfg(test)]
pub(crate) const COMMAND_CARD_TTL: Duration = Duration::from_millis(300);
/// A spoken name matches authors who wrote within this long.
const COMMAND_NAME_WINDOW: Duration = Duration::from_secs(10 * 60);
/// A second command that lands on the same comment this soon is the same
/// request: the detector reports a name a chunk boundary cut twice
/// ("coders", then "coders x").
const COMMAND_SAME_TARGET_WINDOW: Duration = Duration::from_secs(10);
/// A clear this soon after a voice removal opened corrects it: "remove it",
/// then "from the screen" in the next final.
const COMMAND_CORRECTION_WINDOW: Duration = Duration::from_secs(6);
/// "This one" for a removal reaches back this far for a flag.
const COMMAND_FLAG_MAX_AGE_SECS: i64 = 120;
/// A chooser lists at most this many comments.
const COMMAND_CANDIDATES_CAP: usize = 3;
/// A card's excerpt, in UTF-16 units (like the moderation audit row).
const COMMAND_EXCERPT_MAX_UNITS: usize = 140;
/// What Golem heard, as the strip shows it.
const COMMAND_HEARD_MAX_UNITS: usize = 300;

/// Plan 140 S8, desktop-owned thresholds (contract part E): the cloud parser
/// acts only when its intent is at least this sure...
pub(crate) const COMMAND_PARSE_INTENT_THRESHOLD: f64 = 0.7;
/// ...and, for a highlight or a removal, on comments at least this likely.
pub(crate) const COMMAND_PARSE_TARGET_THRESHOLD: f64 = 0.75;
/// At most one parse per this long, and never two at once.
const COMMAND_PARSE_MIN_GAP: Duration = Duration::from_secs(3);
/// An in-flight mark older than this is stale (its task died): the client
/// gives up at 2.5 s.
const COMMAND_PARSE_IN_FLIGHT_MAX: Duration = Duration::from_secs(10);
/// A 429 without a readable `Retry-After` pauses the parser this long.
const COMMAND_PARSE_QUOTA_PAUSE: Duration = Duration::from_secs(5 * 60);
/// The route is off, or this account cannot use it: ask again later.
const COMMAND_PARSE_UNAVAILABLE_PAUSE: Duration = Duration::from_secs(5 * 60);
/// No pause, whatever the server says, outlasts a day.
const COMMAND_PARSE_MAX_PAUSE: Duration = Duration::from_secs(24 * 60 * 60);

const COMMAND_VOICE_PAUSED: &str = "Voice commands are paused by Videorc.";
const COMMAND_SIGNED_OUT: &str = "Cancelled because you signed out.";
const COMMAND_STOPPED_LISTENING: &str = "Cancelled because Golem stopped listening.";

/// What a voice command's card waits for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommandPending {
    /// Nothing: the command is finished.
    None,
    /// A chooser: picking one runs the command on it.
    Choice,
    /// A highlight of a comment Golem flagged (high severity) waits for a yes.
    HighlightConfirm,
    /// The removal request is on its way to chat moderation.
    Requesting,
    /// A voice removal waits for an answer, or for its countdown.
    Removal,
    /// A confirmed removal is running at the platform.
    Removing,
}

/// The verb of a new command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommandIntent {
    Highlight,
    Clear,
    Remove,
}

impl CommandIntent {
    fn kind(self) -> CohostCommandKind {
        match self {
            Self::Highlight => CohostCommandKind::Highlight,
            Self::Clear => CohostCommandKind::Clear,
            Self::Remove => CohostCommandKind::Remove,
        }
    }
}

/// The engine's side of the latest command: its wire shape plus what the
/// rules need.
#[derive(Debug, Clone)]
struct CommandRecord {
    wire: CohostCommand,
    /// `None` for an utterance Golem did not understand.
    intent: Option<CommandIntent>,
    pending: CommandPending,
    /// When it was heard: the same-target and correction windows count from here.
    heard_at: Instant,
    /// The comments it resolved to: one, or the chooser's.
    resolved: Vec<String>,
    /// The moderation phase last applied: 0 none, 1 pending, 2 running, 3 over.
    operation_rank: u8,
    /// The command may remove on a countdown (`NewCommand::countdown_allowed`);
    /// a removal picked from its chooser keeps the rule.
    countdown_allowed: bool,
}

impl CommandRecord {
    fn new(command: &NewCommand, ctx: &CommandContext) -> Self {
        let mut record = Self::with(
            command.intent.kind(),
            Some(command.intent),
            &command.heard,
            // Only a removal carries its reason: it is the audit reason.
            command
                .reason
                .clone()
                .filter(|_| command.intent == CommandIntent::Remove),
            ctx,
        );
        record.countdown_allowed = command.countdown_allowed();
        record
    }

    /// The confirm mode a removal from this command runs in: the setting,
    /// unless the command may not count down.
    fn removal_mode(&self, setting: RemoveConfirmMode) -> RemoveConfirmMode {
        if self.countdown_allowed {
            setting
        } else {
            RemoveConfirmMode::Confirm
        }
    }

    fn unheard(heard: &str, ctx: &CommandContext) -> Self {
        Self::with(CohostCommandKind::Unknown, None, heard, None, ctx)
    }

    fn with(
        kind: CohostCommandKind,
        intent: Option<CommandIntent>,
        heard: &str,
        reason: Option<String>,
        ctx: &CommandContext,
    ) -> Self {
        Self {
            wire: CohostCommand {
                id: format!("cmd-{}", uuid::Uuid::new_v4()),
                heard: truncate_utf16(heard.trim(), COMMAND_HEARD_MAX_UNITS),
                kind,
                status: CohostCommandStatus::Done,
                message: String::new(),
                target: None,
                candidates: Vec::new(),
                operation_id: None,
                reason,
                at: ctx.now_iso(),
                expires_at: None,
            },
            intent,
            pending: CommandPending::None,
            heard_at: ctx.now,
            resolved: Vec::new(),
            operation_rank: 0,
            countdown_allowed: false,
        }
    }

    /// Nothing more to answer: the command reached `status`.
    fn finish(&mut self, status: CohostCommandStatus, message: impl Into<String>, now_iso: &str) {
        self.pending = CommandPending::None;
        self.wire.status = status;
        self.wire.message = message.into();
        self.wire.expires_at = None;
        self.wire.at = now_iso.to_string();
    }

    /// "coders_x's comment", for the strip and the card.
    fn comment(&self) -> String {
        comment_of(
            self.wire
                .target
                .as_ref()
                .map(|target| target.author_name.as_str())
                .unwrap_or_default(),
        )
    }
}

/// A removal a voice command created, for the report.
#[derive(Debug, Clone, Copy, Default)]
struct CommandOperationTrack {
    /// Its terminal outcome was counted.
    counted: bool,
    /// A newer command or a session boundary replaced its card: that
    /// cancellation is not the streamer's "no" and is not counted.
    superseded: bool,
}

/// How a command's target resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
enum CommandResolution {
    /// Nothing matched; the sentence says so.
    NotFound(String),
    One(String),
    /// A chooser, in the order its card lists them, at most three.
    Several(Vec<String>),
}

/// How a new command names its target.
#[derive(Debug, Clone, PartialEq, Eq)]
enum CommandTargetSpec {
    /// The local grammar's target (S2).
    Spoken {
        target: CommandTarget,
        question: bool,
    },
    /// Message ids a cloud parser picked (S8, `execute_resolved_command`).
    Resolved(Vec<String>),
}

#[derive(Debug, Clone)]
struct NewCommand {
    intent: CommandIntent,
    spec: CommandTargetSpec,
    heard: String,
    reason: Option<String>,
    /// Addressed with the wake word ("Golem, ..."). A structured phrase
    /// heard without it is `false`.
    wake_word: bool,
}

impl NewCommand {
    /// Only an explicit command may remove on a countdown: the wake word,
    /// read by the local grammar. A structured phrase without the wake word,
    /// or a target the cloud parser picked, always waits for a yes (plan 140
    /// review): deleting chat is irreversible.
    fn countdown_allowed(&self) -> bool {
        self.wake_word && matches!(self.spec, CommandTargetSpec::Spoken { .. })
    }
}

/// An answer to the open card, by voice or through `cohost.command.*`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommandAnswer {
    Confirm,
    Cancel,
    Choose(u8),
}

/// What a command step reads before the engine lock: the gates and the
/// comment on stream.
#[derive(Debug, Clone)]
struct CommandContext {
    premium: bool,
    voice_enabled: bool,
    remove_enabled: bool,
    /// The comment on stream right now (`comments.highlight`, live).
    on_stream: Option<String>,
    now: Instant,
    now_utc: chrono::DateTime<chrono::Utc>,
}

impl CommandContext {
    fn availability(&self) -> Option<CohostCommandAvailability> {
        command_availability(self.voice_enabled, self.remove_enabled)
    }

    fn now_iso(&self) -> String {
        self.now_utc.to_rfc3339()
    }
}

/// What a consent change left for after the engine lock.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ConsentUpdate {
    /// The replacement scheduler generation.
    generation: u64,
    /// The voice removal the closed card was waiting on: cancel it.
    abandoned_removal: Option<String>,
}

/// A removal to ask chat moderation for, after the engine lock.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CommandRemovalRequest {
    command_id: String,
    message_id: String,
    reason: Option<String>,
    confirm_mode: RemoveConfirmMode,
}

/// The work a command step leaves for after the engine lock.
#[derive(Debug, Default)]
struct CommandEffects {
    /// The visible state changed.
    emit: bool,
    /// Removals a newer command replaced: cancelled first, results ignored.
    cancel_superseded: Vec<String>,
    clear_highlight: bool,
    /// Expire this card (command id, its `expiresAt`) unless answered first.
    expire_card: Option<(String, String)>,
    request_removal: Option<CommandRemovalRequest>,
    /// The streamer said yes to this removal operation.
    confirm_removal: Option<String>,
    /// The streamer said no to this removal operation.
    cancel_removal: Option<String>,
}

/// The kill switches as the state carries them: absent while both are on.
fn command_availability(
    voice_enabled: bool,
    remove_enabled: bool,
) -> Option<CohostCommandAvailability> {
    let switch = |on: bool| {
        if on {
            CohostSwitchState::On
        } else {
            CohostSwitchState::Paused
        }
    };
    (!(voice_enabled && remove_enabled)).then_some(CohostCommandAvailability {
        voice_commands: switch(voice_enabled),
        remove: switch(remove_enabled),
    })
}

/// The gates a command must pass when it runs, and every answer that acts:
/// the voice kill switch, Premium, and for a removal the remove switch.
fn command_gate(ctx: &CommandContext, intent: Option<CommandIntent>) -> Option<&'static str> {
    if !ctx.voice_enabled {
        Some(COMMAND_VOICE_PAUSED)
    } else if !ctx.premium {
        Some(crate::live_chat_moderation::PREMIUM_REQUIRED_MESSAGE)
    } else if intent == Some(CommandIntent::Remove) && !ctx.remove_enabled {
        Some(crate::live_chat_moderation::REMOVE_PAUSED_MESSAGE)
    } else {
        None
    }
}

/// "coders_x's comment"; "the comment" for a nameless author.
fn comment_of(name: &str) -> String {
    let name = name.trim();
    if name.is_empty() {
        "the comment".to_string()
    } else {
        format!("{name}'s comment")
    }
}

fn chooser_message(count: usize) -> String {
    let keys = match count {
        0 | 1 => "press 1".to_string(),
        2 => "press 1 or 2".to_string(),
        count => format!("press 1 to {count}"),
    };
    format!("Which comment? Say 'the first one' or {keys}.")
}

/// The flag kind in the highlight confirm card's words.
fn command_flag_label(kind: CohostFlagKind) -> Option<&'static str> {
    Some(match kind {
        CohostFlagKind::Toxicity => "toxic",
        CohostFlagKind::Spam => "spam",
        CohostFlagKind::SelfPromo => "self-promotion",
        CohostFlagKind::PersonalInfo => "personal info",
        CohostFlagKind::Hate => "hate",
        CohostFlagKind::Harassment => "harassment",
        CohostFlagKind::Threat => "threat",
        CohostFlagKind::Sexual => "sexual",
        CohostFlagKind::Scam => "scam",
        CohostFlagKind::SelfHarm => "self-harm",
        CohostFlagKind::Spoiler => "spoiler",
        CohostFlagKind::Impersonation => "impersonation",
        CohostFlagKind::Rule => "a chat rule",
        CohostFlagKind::Unknown => return None,
    })
}

/// A flag raised at `at` (RFC 3339) is recent enough for "this one".
fn command_flag_is_recent(at: &str, now_utc: chrono::DateTime<chrono::Utc>) -> bool {
    chrono::DateTime::parse_from_rfc3339(at).is_ok_and(|at| {
        now_utc.signed_duration_since(at.with_timezone(&chrono::Utc))
            <= chrono::Duration::seconds(COMMAND_FLAG_MAX_AGE_SECS)
    })
}

/// Whole seconds until `at` (RFC 3339), at least one.
fn seconds_until(at: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(at)
        .map(|at| {
            let millis = at
                .with_timezone(&chrono::Utc)
                .signed_duration_since(chrono::Utc::now())
                .num_milliseconds();
            (millis + 999) / 1000
        })
        .unwrap_or(1)
        .max(1)
}

/// Moderation phases only move forward on a command card.
fn command_operation_rank(phase: ModerationPhase) -> u8 {
    match phase {
        ModerationPhase::PendingConfirm => 1,
        ModerationPhase::Executing => 2,
        ModerationPhase::Cancelled
        | ModerationPhase::Expired
        | ModerationPhase::Removed
        | ModerationPhase::HiddenLocally
        | ModerationPhase::Failed
        | ModerationPhase::DeliveryUnknown => 3,
    }
}

/// A moderation operation's phase, as its command card says it (contract
/// part B's mapping).
fn apply_operation_to_record(
    record: &mut CommandRecord,
    operation: &ModerationOperation,
    now_iso: &str,
) {
    let comment = if record.wire.target.is_some() {
        record.comment()
    } else {
        comment_of(&operation.author_name)
    };
    let platform = stream_platform_label(operation.platform);
    record.wire.operation_id = Some(operation.operation_id.clone());
    match operation.phase {
        ModerationPhase::PendingConfirm => {
            record.pending = CommandPending::Removal;
            record.wire.status = CohostCommandStatus::Confirm;
            record.wire.expires_at = operation
                .confirm_by
                .clone()
                .or_else(|| operation.execute_at.clone());
            record.wire.message = match (&operation.confirm_by, &operation.execute_at) {
                (None, Some(execute_at)) => {
                    let seconds = seconds_until(execute_at);
                    let unit = if seconds == 1 { "second" } else { "seconds" };
                    format!("Removing {comment} in {seconds} {unit}.")
                }
                _ => format!("Remove {comment}?"),
            };
            record.wire.at = now_iso.to_string();
        }
        ModerationPhase::Executing => {
            record.pending = CommandPending::Removing;
            record.wire.status = CohostCommandStatus::Confirm;
            record.wire.expires_at = None;
            record.wire.message = format!("Removing {comment}…");
            record.wire.at = now_iso.to_string();
        }
        ModerationPhase::Removed => {
            let message = if operation.outcome_code == Some(ModerationOutcomeCode::NotFound) {
                format!("{platform} had already removed {comment}.")
            } else {
                format!("Removed {comment} from {platform}.")
            };
            record.finish(CohostCommandStatus::Done, message, now_iso);
        }
        ModerationPhase::HiddenLocally => record.finish(
            CohostCommandStatus::Done,
            operation
                .outcome
                .clone()
                .unwrap_or_else(|| format!("Hid {comment} in Videorc.")),
            now_iso,
        ),
        ModerationPhase::Cancelled => record.finish(
            CohostCommandStatus::Cancelled,
            operation
                .outcome
                .clone()
                .unwrap_or_else(|| "Cancelled. Nothing was removed.".to_string()),
            now_iso,
        ),
        ModerationPhase::Expired => record.finish(
            CohostCommandStatus::Expired,
            "Nothing was removed.",
            now_iso,
        ),
        ModerationPhase::Failed | ModerationPhase::DeliveryUnknown => record.finish(
            CohostCommandStatus::Refused,
            operation
                .outcome
                .clone()
                .unwrap_or_else(|| format!("Could not remove {comment}.")),
            now_iso,
        ),
    }
}

impl CohostSession {
    fn new(
        session_id: String,
        generation: u64,
        consent: bool,
        stream_title: Option<String>,
        now: Instant,
    ) -> Self {
        Self {
            session_id,
            generation,
            consent,
            stream_title,
            status: if consent {
                CohostStatus::Listening
            } else {
                CohostStatus::Paused
            },
            reason: (!consent).then_some(CohostReason::ConsentRequired),
            detail: None,
            questions: Vec::new(),
            flags: Vec::new(),
            mood: None,
            tick_seq: 0,
            partial: false,
            started_at: now,
            last_tick_at: None,
            last_tick_iso: None,
            cursor: None,
            pending: VecDeque::new(),
            dropped: 0,
            known_ids: VecDeque::new(),
            known_set: HashSet::new(),
            dismissed_questions: HashSet::new(),
            dismissed_flags: HashSet::new(),
            backoff_index: 0,
            next_attempt_at: None,
            in_flight: false,
            messages_seen: 0,
            counted_question_ids: HashSet::new(),
            questions_total: 0,
            prompt_version: COHOST_PROMPT_VERSION,
            version_retry: false,
            in_flight_messages: Vec::new(),
            in_flight_dropped: 0,
            in_flight_rules: Vec::new(),
            known: HashMap::new(),
            deleted_ids: HashSet::new(),
            highlights: Vec::new(),
            alert_reports: Vec::new(),
            mood_scores: None,
            auto: AutoHighlightLedger::default(),
            spotlight: SpotlightLane::default(),
            recently_resolved: Vec::new(),
            listening: None,
            summary: String::new(),
            topic: None,
            promises: Vec::new(),
            promise_seen: HashMap::new(),
            closed_promises: HashSet::new(),
            reminded_promises: HashSet::new(),
            promise_reminder: None,
            next_promise_seq: 0,
            recap: None,
            recap_expires_at: None,
            speech_version: None,
            speech_cursor: None,
            transcript_pending: String::new(),
            in_flight_transcript: String::new(),
            v3_confirmed: false,
            discard_in_flight: false,
            ledger: AuthorLedger::default(),
            dead_air: DeadAirLane::default(),
            started_at_iso: chrono::Utc::now().to_rfc3339(),
            report: ReportLedger::default(),
            command: None,
            command_operations: HashMap::new(),
        }
    }

    /// What this session's report says (plan 119 S1): the counters and logs
    /// kept while live, the open promises, and the ledger's greetings. Built
    /// once, at stop; `ended_at` is the stop time.
    fn report(&self, ended_at: &str) -> CohostSessionReport {
        let greetings = self.ledger.greeting_counts();
        CohostSessionReport {
            version: COHOST_SESSION_REPORT_VERSION,
            session_id: self.session_id.clone(),
            started_at: self.started_at_iso.clone(),
            ended_at: ended_at.to_string(),
            segments: 1,
            stream_title: self.stream_title.clone(),
            messages_seen: self.messages_seen,
            shown_on_stream: self.report.shown_on_stream,
            questions: CohostReportQuestions {
                total: self.questions_total,
                marked_answered: self.report.questions_marked_answered,
                dismissed: self.report.questions_dismissed,
                replied: self.report.questions_replied,
                answered_on_air: self.report.questions_answered_on_air,
                restored: self.report.questions_restored,
                shown_on_stream: self.report.questions_shown_on_stream,
                items: self.report.questions.clone(),
            },
            flags: CohostReportFlags {
                raised: self.report.flags_raised,
                dismissed: self.report.flags_dismissed,
                by_kind: self.report.flag_kinds.clone(),
                by_severity: self.report.flag_severities.clone(),
            },
            promises: CohostReportPromises {
                heard: self.report.promises_heard,
                kept: self.report.promises_kept,
                dismissed: self.report.promises_dismissed,
                reminded: self.report.promises_reminded,
                open: self
                    .promises
                    .iter()
                    .take(COHOST_REPORT_OPEN_PROMISES_CAP)
                    .map(|promise| CohostReportOpenPromise {
                        text: promise.text.clone(),
                        first_seen_at: promise.first_seen_at.clone(),
                    })
                    .collect(),
            },
            greetings: CohostReportGreetings {
                first_timers: greetings.first_timers,
                first_timers_greeted: greetings.first_timers_greeted,
                by_voice: greetings.by_voice,
                by_chat: greetings.by_chat,
                on_stream: greetings.on_stream,
                manual: greetings.manual,
            },
            alerts: self.report.alerts.clone(),
            recap: CohostReportRecap {
                offered: self.report.recap_offered,
                drafted: self.report.recap_drafted,
                dismissed: self.report.recap_dismissed,
            },
            commands: (!self.report.commands.is_empty()).then(|| self.report.commands.clone()),
        }
    }

    /// Sign-out: everything this session learned from speech goes (see
    /// `purge_speech_for_sign_out`). Chat state stays. Returns the voice
    /// removal its closed card was waiting on, for the caller to cancel.
    #[must_use]
    fn forget_speech(&mut self) -> Option<String> {
        self.transcript_pending.clear();
        self.in_flight_transcript.clear();
        self.summary.clear();
        self.topic = None;
        self.promises.clear();
        self.promise_seen.clear();
        self.closed_promises.clear();
        self.reminded_promises.clear();
        self.promise_reminder = None;
        self.recap = None;
        self.recap_expires_at = None;
        for question in &mut self.questions {
            question.on_topic = false;
        }
        self.ledger.forget_voice();
        // The tick in flight carried the transcript and returns what it
        // heard: its answer is dropped, never applied.
        if self.in_flight {
            self.discard_in_flight = true;
        }
        // Plan 140 S3: a card a voice command opened closes with what was
        // heard; the caller cancels its removal.
        self.abandon_command(COMMAND_SIGNED_OUT, &chrono::Utc::now().to_rfc3339())
    }

    fn snapshot(&self) -> CohostState {
        self.snapshot_at(Instant::now())
    }

    fn snapshot_at(&self, now: Instant) -> CohostState {
        let next_tick_at = next_tick_due_at(
            self.cadence_pending(),
            self.last_tick_at.unwrap_or(self.started_at),
            self.last_tick_at,
            self.next_attempt_at,
            now,
        )
        .map(|due| iso_after(now, due));
        CohostState {
            session_id: Some(self.session_id.clone()),
            status: self.status,
            reason: self.reason,
            detail: self.detail.clone(),
            questions: self.questions.clone(),
            flags: self.flags.clone(),
            mood: self.mood,
            last_tick_at: self.last_tick_iso.clone(),
            tick_seq: self.tick_seq,
            partial: self.partial,
            tick_in_flight: self.in_flight,
            pending_messages: u32::try_from(self.pending.len()).unwrap_or(u32::MAX),
            next_tick_at,
            messages_seen: self.messages_seen,
            questions_total: self.questions_total,
            highlights: self.highlights.clone(),
            alerts: self.alerts_at(now),
            mood_scores: self.mood_scores,
            auto_highlight: self.auto.latest.clone(),
            spotlight: self.spotlight_at(now),
            recently_resolved: self.recently_resolved_at(now),
            listening: self.listening.clone(),
            topic: self.topic.clone(),
            promises: self.promises.clone(),
            promise_reminder: self.promise_reminder.clone(),
            recap: self.recap_at(now),
            say_hi: self.ledger.say_hi(now),
            dead_air_nudge: self.dead_air.current(now),
            command: self.command.as_ref().map(|record| record.wire.clone()),
            // The engine sets the kill switches; the session never knows them.
            command_availability: None,
        }
    }

    /// The recap as the wire sees it: `None` once it expired.
    fn recap_at(&self, now: Instant) -> Option<CohostRecap> {
        self.recap
            .as_ref()
            .filter(|_| self.recap_expires_at.is_some_and(|until| now < until))
            .cloned()
    }

    fn speaks_v3(&self) -> bool {
        self.prompt_version >= COHOST_PROMPT_VERSION_SPEECH_MIN
    }

    /// Transcript chars waiting for the next tick, as the cadence sees them:
    /// nothing below v3, where the transcript never goes out, and nothing
    /// until a v3 tick succeeded this session (a speech-only tick to a server
    /// without v3 fails validation instead of falling back). Until then the
    /// transcript rides the next chat tick.
    fn transcript_pending_chars(&self) -> usize {
        if self.speaks_v3() && self.v3_confirmed {
            self.transcript_pending.chars().count()
        } else {
            0
        }
    }

    /// Fold the finals that arrived since the cursor into the pending
    /// transcript. Returns how many chars were added.
    fn note_speech(&mut self, snapshot: &RecentSpeechSnapshot) -> usize {
        self.speech_version = Some(snapshot.version);
        let mut added = 0;
        for final_ in &snapshot.finals {
            if self.speech_cursor.is_some_and(|cursor| final_.at <= cursor) {
                continue;
            }
            self.speech_cursor = Some(final_.at);
            let text = final_.text.trim();
            if text.is_empty() {
                continue;
            }
            // Plan 068 D9: a viewer's name in what the streamer said greets
            // them. Same fold as the tick transcript, one pass per final.
            self.ledger.greet_by_voice(text, final_.at);
            if !self.transcript_pending.is_empty() {
                self.transcript_pending.push(' ');
            }
            self.transcript_pending.push_str(text);
            added += text.chars().count();
        }
        self.transcript_pending =
            keep_newest_utf16(&self.transcript_pending, TRANSCRIPT_PENDING_CAP_CHARS);
        added
    }

    /// Pending count as the cadence rules see it. After a version fallback the
    /// restored batch counts as a burst, so it is retried as soon as the 8 s
    /// min gap allows instead of waiting out the 20 s trickle rule.
    fn cadence_pending(&self) -> usize {
        if self.version_retry && !self.pending.is_empty() {
            self.pending.len().max(TICK_BURST_THRESHOLD)
        } else {
            self.pending.len()
        }
    }

    /// One entry per alert kind with an unexpired report, in first-reported
    /// order. `active` needs two distinct authors within the corroboration
    /// window; a single viewer never raises the chip.
    fn alerts_at(&self, now: Instant) -> Vec<CohostAlert> {
        let live: Vec<&AlertReport> = self
            .alert_reports
            .iter()
            .filter(|report| now.saturating_duration_since(report.at) < ALERT_EXPIRY)
            .collect();
        let mut kinds: Vec<CohostAlertKind> = Vec::new();
        for report in &live {
            if !kinds.contains(&report.kind) {
                kinds.push(report.kind);
            }
        }
        kinds
            .into_iter()
            .filter_map(|kind| {
                let reports: Vec<&AlertReport> = live
                    .iter()
                    .copied()
                    .filter(|report| report.kind == kind)
                    .collect();
                let last = reports.iter().max_by_key(|report| report.at)?;
                let authors: HashSet<&str> = reports
                    .iter()
                    .map(|report| report.author.as_str())
                    .collect();
                let active = reports.iter().any(|anchor| {
                    let corroborating: HashSet<&str> = reports
                        .iter()
                        .filter(|report| {
                            report.at >= anchor.at
                                && report.at.duration_since(anchor.at) <= ALERT_CORROBORATION_WINDOW
                        })
                        .map(|report| report.author.as_str())
                        .collect();
                    corroborating.len() >= ALERT_MIN_AUTHORS
                });
                Some(CohostAlert {
                    kind,
                    viewers: u32::try_from(authors.len()).unwrap_or(u32::MAX),
                    last_seen_at: last.at_iso.clone(),
                    active,
                })
            })
            .collect()
    }

    fn remember_id(&mut self, id: &str, known: KnownMessage) {
        if self.known_set.insert(id.to_string()) {
            self.known_ids.push_back(id.to_string());
            self.known.insert(id.to_string(), known);
            while self.known_ids.len() > KNOWN_MESSAGE_IDS_CAP {
                if let Some(evicted) = self.known_ids.pop_front() {
                    self.known_set.remove(&evicted);
                    self.known.remove(&evicted);
                    self.deleted_ids.remove(&evicted);
                }
            }
        }
    }

    /// Buffer eligible rows newer than the cursor. Tombstones for a pending
    /// row pull it out of the delta (deleted messages never reach the model).
    /// `now` is when the engine saw the rows: the automatic-card age rule
    /// counts from it, never from a provider timestamp.
    fn note_messages(&mut self, messages: &[LiveChatMessage], now: Instant) -> usize {
        let mut noted = 0;
        let mut ordered: Vec<&LiveChatMessage> = messages
            .iter()
            .filter(|message| message.session_id == self.session_id)
            .collect();
        ordered.sort_by(|a, b| (&a.received_at, &a.id).cmp(&(&b.received_at, &b.id)));
        for message in ordered {
            if message.is_deleted || message.event_type == LiveChatEventType::Deleted {
                self.pending.retain(|pending| pending.id != message.id);
                // A deleted comment is never suggested for the stream, and
                // never stays the spotlight.
                if self.known_set.contains(&message.id) {
                    self.deleted_ids.insert(message.id.clone());
                    self.highlights
                        .retain(|highlight| highlight.message_id != message.id);
                    self.drop_spotlight_for(&message.id);
                }
                continue;
            }
            let key = (message.received_at.clone(), message.id.clone());
            if self.cursor.as_ref().is_some_and(|cursor| key <= *cursor)
                || self.known_set.contains(&message.id)
            {
                continue;
            }
            self.cursor = Some(key);
            self.ledger.note_message(
                &alert_author_key(message),
                message,
                message
                    .author_roles
                    .iter()
                    .any(|role| normalize_role(role).as_deref() == Some("owner")),
                now,
            );
            let Some(mapped) = tick_message_from_chat(message) else {
                continue;
            };
            self.remember_id(
                &message.id,
                KnownMessage {
                    author: alert_author_key(message),
                    author_name: mapped.author.clone(),
                    roles: mapped.roles.clone().unwrap_or_default(),
                    text: mapped.text.clone(),
                    at: mapped.at.clone(),
                    noted_at: now,
                    platform: message.platform,
                    notification: message
                        .raw_provider_type
                        .as_deref()
                        .is_some_and(|kind| kind.starts_with("channel.chat.notification")),
                },
            );
            self.pending.push_back(mapped);
            while self.pending.len() > TICK_DELTA_CAP {
                self.pending.pop_front();
                self.dropped = self.dropped.saturating_add(1);
            }
            noted += 1;
        }
        self.messages_seen = self.messages_seen.saturating_add(noted as u64);
        noted
    }

    fn tick_due(&self, now: Instant) -> bool {
        if self.in_flight {
            return false;
        }
        if self.next_attempt_at.is_some_and(|at| now < at) {
            return false;
        }
        tick_due(
            self.cadence_pending(),
            self.transcript_pending_chars(),
            self.last_tick_at.unwrap_or(self.started_at),
            self.last_tick_at,
            now,
        )
    }

    fn build_request(&mut self, settings: &CohostSettings, now: Instant) -> CohostTickRequest {
        self.tick_seq = self.tick_seq.saturating_add(1);
        self.last_tick_at = Some(now);
        self.in_flight = true;
        self.version_retry = false;
        let speaks_v3 = self.speaks_v3();
        let mut messages: Vec<CohostTickMessage> = self.pending.drain(..).collect();
        if !speaks_v3 {
            // A v1/v2 body stays exactly what those desktops send.
            for message in &mut messages {
                message.first_message = None;
            }
        }
        let dropped_messages = std::mem::take(&mut self.dropped);
        // v1 fallback: no `rules` key at all, so the body stays byte-identical
        // to what a v1 desktop sends. From v2 on the rules always ride.
        let rules = (self.prompt_version >= COHOST_PROMPT_VERSION_RULES_MIN)
            .then(|| settings.rules.clone());
        self.in_flight_messages = messages.clone();
        self.in_flight_dropped = dropped_messages;
        self.in_flight_rules = rules.clone().unwrap_or_default();
        let transcript_pending = std::mem::take(&mut self.transcript_pending);
        let transcript = if speaks_v3 && !transcript_pending.trim().is_empty() {
            let newest = keep_newest_utf16(transcript_pending.trim(), TICK_TRANSCRIPT_MAX_CHARS);
            self.in_flight_transcript = newest.clone();
            Some(newest)
        } else {
            self.in_flight_transcript.clear();
            None
        };
        let summary = (speaks_v3 && !self.summary.is_empty()).then(|| self.summary.clone());
        let open_promises = (speaks_v3 && !self.promises.is_empty()).then(|| {
            self.promises
                .iter()
                .take(TICK_OPEN_PROMISES_CAP)
                .map(|promise| CohostTickOpenPromise {
                    id: promise.id.clone(),
                    text: truncate_utf16(&promise.text, PROMISE_TEXT_MAX_CHARS),
                })
                .collect()
        });
        let open_questions = self
            .questions
            .iter()
            .take(TICK_OPEN_QUESTIONS_CAP)
            .map(|question| CohostTickOpenQuestion {
                id: question.id.clone(),
                text: question.text.clone(),
                count: u32::try_from(question.askers.len().max(1)).unwrap_or(u32::MAX),
            })
            .collect();
        CohostTickRequest {
            client_version: DESKTOP_CLIENT_VERSION.to_string(),
            session_client_id: self.session_id.clone(),
            tick_seq: self.tick_seq,
            prompt_version: self.prompt_version,
            consent_to_process_chat: self.consent,
            tone: settings.tone,
            notes: settings.notes.clone(),
            rules,
            stream_title: self.stream_title.clone(),
            open_questions,
            messages,
            dropped_messages,
            transcript,
            summary,
            open_promises,
        }
    }

    /// Merge a successful tick. `questions` is the full open set: existing ids
    /// keep `first_seen_at`, `resolved` ids leave, dismissed ids never return,
    /// and message ids are sanitized against rows this engine actually sent.
    /// With `keepQuestions` (v2) the server skipped regeneration: the open set
    /// stays as it is and only `resolved` ids leave.
    fn apply_response(
        &mut self,
        response: CohostTickResponse,
        dropped: u64,
        now: Instant,
        now_iso: &str,
    ) {
        self.in_flight = false;
        let sent_messages = self.in_flight_messages.len();
        self.in_flight_messages.clear();
        self.in_flight_dropped = 0;
        self.in_flight_transcript.clear();
        let sent_rules = std::mem::take(&mut self.in_flight_rules);
        self.backoff_index = 0;
        self.next_attempt_at = None;
        self.status = CohostStatus::Listening;
        self.reason = None;
        self.detail = None;
        self.last_tick_iso = Some(now_iso.to_string());
        self.partial = dropped > 0;
        if self.speaks_v3() {
            self.v3_confirmed = true;
        }
        // Mood reads chat. A speech-only tick (v3, no chat in the batch) had
        // no chat to read: the last mood stays, like the suggestions below.
        if sent_messages > 0 {
            self.mood = response.mood.map(|mood| match mood {
                CohostMood::Unknown => CohostMood::Mixed,
                known => known,
            });
            self.mood_scores = response.mood_scores.map(|scores| CohostMoodScores {
                hype: unit_interval(scores.hype).unwrap_or(0.0),
                tension: unit_interval(scores.tension).unwrap_or(0.0),
                confusion: unit_interval(scores.confusion).unwrap_or(0.0),
            });
        }

        let resolved: HashSet<String> = response.resolved.into_iter().collect();
        if response.keep_questions {
            self.questions
                .retain(|question| !resolved.contains(&question.id));
        } else {
            self.replace_questions(response.questions, &resolved, now_iso);
        }

        // v3 (plan 068 D7/D8): the latest response's summary and topic win
        // when present; a response without them (v2 fallback) keeps the last.
        if let Some(summary) = response.summary {
            self.summary = truncate_utf16(summary.trim(), TICK_SUMMARY_MAX_CHARS);
        }
        if let Some(topic) = response.topic {
            let topic = truncate_utf16(topic.trim(), TOPIC_MAX_CHARS);
            self.topic = (!topic.is_empty()).then_some(topic);
        }
        let fulfilled: HashSet<String> = response.fulfilled_promise_ids.into_iter().collect();
        // The transcript showed an open promise was kept (plan 119 report).
        let kept_now = self
            .promises
            .iter()
            .filter(|promise| fulfilled.contains(&promise.id))
            .count() as u64;
        self.report.promises_kept = self.report.promises_kept.saturating_add(kept_now);
        for id in &fulfilled {
            self.closed_promises.insert(id.clone());
        }
        if let Some(promises) = response.promises {
            self.replace_promises(promises, now, now_iso);
        } else if !fulfilled.is_empty() {
            self.promises
                .retain(|promise| !fulfilled.contains(&promise.id));
        }
        if self
            .promise_reminder
            .as_ref()
            .is_some_and(|reminder| !self.promises.iter().any(|p| p.id == reminder.promise_id))
        {
            self.promise_reminder = None;
        }
        if let Some(recap) = response
            .recap
            .map(|recap| truncate_utf16(recap.trim(), RECAP_MAX_CHARS))
            .filter(|recap| !recap.is_empty())
        {
            self.report.recap_offered += 1;
            self.set_recap(recap, now, now_iso);
        }

        for flag in response.flags {
            if !self.known_set.contains(&flag.message_id)
                || self.dismissed_flags.contains(&flag.message_id)
                || self
                    .flags
                    .iter()
                    .any(|existing| existing.message_id == flag.message_id)
            {
                continue;
            }
            let mut also_kinds: Vec<CohostFlagKind> = Vec::new();
            for kind in flag.also_kinds {
                if kind != CohostFlagKind::Unknown
                    && kind != flag.kind
                    && !also_kinds.contains(&kind)
                {
                    also_kinds.push(kind);
                }
            }
            let severity = match flag.severity {
                CohostFlagSeverity::Unknown => CohostFlagSeverity::Medium,
                known => known,
            };
            self.report.flag_raised(flag.kind, severity);
            self.flags.push(CohostFlag {
                message_id: flag.message_id,
                kind: flag.kind,
                severity,
                reason: flag.reason,
                at: now_iso.to_string(),
                confidence: flag.confidence.and_then(unit_interval),
                target: flag
                    .target
                    .filter(|target| *target != CohostFlagTarget::Unknown),
                action: flag
                    .action
                    .filter(|action| *action != CohostFlagAction::Unknown),
                also_kinds,
                // Resolved against the rules THIS tick sent: the streamer may
                // have edited the list while the request was in flight.
                rule: (flag.kind == CohostFlagKind::Rule)
                    .then(|| flag.rule_index.and_then(|index| sent_rules.get(index)))
                    .flatten()
                    .cloned(),
            });
        }
        while self.flags.len() > FLAGS_CAP {
            self.flags.remove(0);
        }
        // A tick may flag what the spotlight lane matched a moment ago.
        if let Some(flagged) = self
            .spotlight
            .current
            .as_ref()
            .map(|current| current.message_id.clone())
            .filter(|id| self.flags.iter().any(|flag| &flag.message_id == id))
        {
            self.drop_spotlight_for(&flagged);
        }

        // Latest set wins. A flagged (or flag-dismissed) or deleted message is
        // never suggested, whatever the server ranked. A speech-only tick (v3,
        // no chat in the batch) that ranked nothing had nothing to rank: the
        // current suggestions stay, re-filtered.
        let incoming = if sent_messages == 0 && response.highlights.is_empty() {
            self.highlights
                .iter()
                .map(|kept| crate::videorc_api::CohostTickHighlight {
                    message_id: kept.message_id.clone(),
                    score: kept.score,
                    highlight_type: kept.highlight_type,
                })
                .collect()
        } else {
            response.highlights
        };
        let mut highlights: Vec<CohostHighlight> = Vec::new();
        for highlight in incoming {
            let id = &highlight.message_id;
            if !self.known_set.contains(id)
                || self.deleted_ids.contains(id)
                || self.dismissed_flags.contains(id)
                || self.flags.iter().any(|flag| &flag.message_id == id)
                || highlights.iter().any(|kept| &kept.message_id == id)
            {
                continue;
            }
            highlights.push(CohostHighlight {
                message_id: highlight.message_id,
                score: unit_interval(highlight.score).unwrap_or(0.0),
                highlight_type: match highlight.highlight_type {
                    CohostHighlightType::Unknown => CohostHighlightType::Other,
                    known => known,
                },
            });
            if highlights.len() >= HIGHLIGHTS_CAP {
                break;
            }
        }
        self.highlights = highlights;

        self.alert_reports
            .retain(|report| now.saturating_duration_since(report.at) < ALERT_EXPIRY);
        let mut alerts_reported = false;
        for alert in response.alerts {
            let Some(author) = self.known.get(&alert.message_id) else {
                continue;
            };
            self.alert_reports.push(AlertReport {
                kind: match alert.kind {
                    CohostAlertKind::Unknown => CohostAlertKind::Other,
                    known => known,
                },
                author: author.author.clone(),
                at: now,
                at_iso: now_iso.to_string(),
            });
            alerts_reported = true;
        }
        if alerts_reported {
            let current = self.alerts_at(now);
            self.report.note_alerts(&current, now_iso);
        }
    }

    fn replace_questions(
        &mut self,
        incoming_questions: Vec<CohostTickQuestion>,
        resolved: &HashSet<String>,
        now_iso: &str,
    ) {
        let mut next_questions = Vec::with_capacity(incoming_questions.len());
        for incoming in incoming_questions {
            if incoming.id.trim().is_empty()
                || resolved.contains(&incoming.id)
                || self.dismissed_questions.contains(&incoming.id)
            {
                continue;
            }
            let existing = self
                .questions
                .iter()
                .find(|question| question.id == incoming.id);
            // The server only sees (and validates against) the current batch,
            // and openQuestions carry no ids, so a kept question must keep the
            // sources it accumulated in earlier ticks: union, never replace.
            let mut message_ids: Vec<String> = existing
                .map(|question| question.message_ids.clone())
                .unwrap_or_default();
            for id in incoming.message_ids {
                if self.known_set.contains(&id) && !message_ids.contains(&id) {
                    message_ids.push(id);
                }
            }
            if self.counted_question_ids.insert(incoming.id.clone()) {
                self.questions_total = self.questions_total.saturating_add(1);
            }
            let question = CohostQuestion {
                id: incoming.id,
                // Bounded like the renderer contract (UTF-16), whatever the
                // server sent: one oversized string would drop every state.
                text: truncate_utf16(&incoming.text, QUESTION_TEXT_MAX_UNITS),
                message_ids,
                askers: incoming
                    .askers
                    .iter()
                    .map(|asker| truncate_utf16(asker, QUESTION_ASKER_MAX_UNITS))
                    .collect(),
                platforms: incoming.platforms,
                priority: match incoming.priority {
                    CohostPriority::Unknown => CohostPriority::Normal,
                    known => known,
                },
                suggested_reply: truncate_utf16(&incoming.suggested_reply, QUESTION_TEXT_MAX_UNITS),
                from_notes: incoming.from_notes,
                first_seen_at: existing
                    .map(|question| question.first_seen_at.clone())
                    .unwrap_or_else(|| now_iso.to_string()),
                updated_at: now_iso.to_string(),
                on_topic: incoming.on_topic,
            };
            self.report.note_question(&question);
            next_questions.push(question);
            if next_questions.len() >= TICK_OPEN_QUESTIONS_CAP {
                break;
            }
        }
        self.questions = next_questions;
    }

    /// Merge the server's full open promise set, like questions: an echoed
    /// id keeps `first_seen_at`, a new promise (no id) gets a desktop id,
    /// closed ids (done, dismissed, fulfilled) never return. Text is capped
    /// to what the server accepts back.
    fn replace_promises(&mut self, incoming: Vec<CohostTickPromise>, now: Instant, now_iso: &str) {
        let mut next: Vec<CohostPromise> = Vec::with_capacity(incoming.len());
        for promise in incoming {
            let text = truncate_utf16(promise.text.trim(), PROMISE_TEXT_MAX_CHARS);
            if text.is_empty() {
                continue;
            }
            let id = promise
                .id
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty());
            let existing = match &id {
                Some(id) => self.promises.iter().find(|p| &p.id == id),
                // A new promise the server failed to echo: the same words are
                // the same promise.
                None => self.promises.iter().find(|p| p.text == text),
            };
            let heard_now = existing.is_none();
            let id = match (existing, id) {
                (Some(existing), _) => existing.id.clone(),
                (None, Some(id)) => id,
                (None, None) => {
                    self.next_promise_seq = self.next_promise_seq.saturating_add(1);
                    format!("p_{}", self.next_promise_seq)
                }
            };
            if self.closed_promises.contains(&id) || next.iter().any(|p| p.id == id) {
                continue;
            }
            let value = promise
                .trigger
                .value
                .filter(|value| value.is_finite() && *value > 0.0)
                .map(|value| value.round() as u64);
            let kind = match (promise.trigger.kind, value) {
                (CohostPromiseTriggerKind::Viewers, Some(_)) => CohostPromiseTriggerKind::Viewers,
                (CohostPromiseTriggerKind::Minutes, Some(_)) => CohostPromiseTriggerKind::Minutes,
                _ => CohostPromiseTriggerKind::None,
            };
            let trigger = CohostPromiseTrigger {
                kind,
                value: (kind != CohostPromiseTriggerKind::None)
                    .then_some(value)
                    .flatten(),
            };
            self.promise_seen.entry(id.clone()).or_insert(now);
            if heard_now {
                self.report.promises_heard += 1;
            }
            next.push(CohostPromise {
                id,
                text,
                trigger,
                first_seen_at: existing
                    .map(|p| p.first_seen_at.clone())
                    .unwrap_or_else(|| now_iso.to_string()),
            });
            if next.len() >= TICK_OPEN_PROMISES_CAP {
                break;
            }
        }
        self.promise_seen
            .retain(|id, _| next.iter().any(|p| &p.id == id));
        self.promises = next;
    }

    /// One scheduler pass over the open promises: a met trigger sets the
    /// reminder once per promise. `viewers` is the current fresh total, or
    /// `None` when no sampler reported.
    fn check_promises(&mut self, viewers: Option<u64>, now: Instant, now_iso: &str) -> bool {
        let mut fired: Option<CohostPromiseReminder> = None;
        for promise in &self.promises {
            if self.reminded_promises.contains(&promise.id) {
                continue;
            }
            let Some(seen) = self.promise_seen.get(&promise.id).copied() else {
                continue;
            };
            let elapsed = now.saturating_duration_since(seen);
            let met = promise_trigger_met(promise.trigger, viewers, elapsed);
            if !met {
                continue;
            }
            fired = Some(CohostPromiseReminder {
                promise_id: promise.id.clone(),
                text: promise.text.clone(),
                at: now_iso.to_string(),
            });
            break;
        }
        let Some(reminder) = fired else {
            return false;
        };
        self.reminded_promises.insert(reminder.promise_id.clone());
        self.report.promises_reminded += 1;
        self.promise_reminder = Some(reminder);
        true
    }

    /// Done and dismiss share one engine outcome: the promise leaves, its id
    /// never returns, and a reminder about it leaves with it. The report
    /// counts them apart (`kept`).
    fn close_promise(&mut self, promise_id: &str, kept: bool) -> bool {
        let before = self.promises.len();
        self.promises.retain(|promise| promise.id != promise_id);
        self.promise_seen.remove(promise_id);
        self.closed_promises.insert(promise_id.to_string());
        if self
            .promise_reminder
            .as_ref()
            .is_some_and(|reminder| reminder.promise_id == promise_id)
        {
            self.promise_reminder = None;
        }
        let changed = before != self.promises.len();
        if changed {
            if kept {
                self.report.promises_kept += 1;
            } else {
                self.report.promises_dismissed += 1;
            }
        }
        changed
    }

    fn set_recap(&mut self, text: String, now: Instant, now_iso: &str) {
        self.recap = Some(CohostRecap {
            text,
            at: now_iso.to_string(),
            expires_at: iso_after(now, now + RECAP_TTL),
        });
        self.recap_expires_at = Some(now + RECAP_TTL);
    }

    fn dismiss_recap(&mut self, now: Instant) -> bool {
        let had = self.recap_at(now).is_some();
        self.recap = None;
        self.recap_expires_at = None;
        if had {
            self.report.recap_dismissed += 1;
        }
        had
    }

    /// A recap drafted from the latest summary, no network call.
    fn draft_recap(&mut self, now: Instant, now_iso: &str) -> Result<(), CohostError> {
        let draft = recap_draft(&self.summary, RECAP_MAX_CHARS);
        if draft.is_empty() {
            return Err(CohostError::NoSummary);
        }
        self.report.recap_drafted += 1;
        self.set_recap(draft, now, now_iso);
        Ok(())
    }

    // --- Chat you haven't acknowledged (plan 068 D9) ---------------------------

    /// One scheduler pass: "Say hi" changed (a new first-timer, a greeting, an
    /// entry aging out), or the dead-air nudge fired (its text returned).
    fn refresh_acknowledgement(
        &mut self,
        voice: VoiceActivity,
        now: Instant,
        now_iso: &str,
    ) -> AcknowledgementPass {
        let say_hi_changed = self.ledger.say_hi_changed(now);
        let say_hi = self.ledger.say_hi(now);
        let waiting = !self.questions.is_empty() || !say_hi.is_empty();
        let nudge = dead_air_due(voice, waiting, self.dead_air.last_at(), now)
            .then(|| dead_air_text(&self.questions, &say_hi))
            .flatten()
            .map(|text| {
                self.dead_air
                    .fire(self.generation, text, now, now_iso)
                    .text
                    .clone()
            });
        AcknowledgementPass {
            changed: say_hi_changed || nudge.is_some(),
            nudge,
        }
    }

    /// The streamer's own send landed (`sent` or `partial`). A reply to a
    /// question answers it and greets whoever asked; the name or `@handle`
    /// of anyone in the text greets them.
    fn own_send_delivered(&mut self, text: &str, question_id: Option<&str>, now: Instant) -> bool {
        let mut changed = false;
        if let Some(question_id) = question_id {
            let askers: Vec<String> = self
                .questions
                .iter()
                .find(|question| question.id == question_id)
                .map(|question| {
                    question
                        .message_ids
                        .iter()
                        .filter_map(|id| self.known.get(id).map(|known| known.author.clone()))
                        .collect()
                })
                .unwrap_or_default();
            for author in askers {
                changed |= self.ledger.greet(&author, GreetedHow::Chat, now);
            }
            changed |= self.close_question(question_id, CohostReportQuestionOutcome::Replied);
        }
        changed |= self.ledger.greet_by_chat(text, now) > 0;
        changed
    }

    fn apply_failure(&mut self, error: &CohostApiError, now: Instant) {
        self.in_flight = false;
        let batch = std::mem::take(&mut self.in_flight_messages);
        let batch_dropped = std::mem::take(&mut self.in_flight_dropped);
        let batch_transcript = std::mem::take(&mut self.in_flight_transcript);
        self.in_flight_rules.clear();
        if let Some(lower) = (error.kind == CohostApiErrorKind::PromptVersionUnsupported)
            .then(|| fallback_prompt_version(self.prompt_version))
            .flatten()
        {
            // The server rolled back a version. Not a failure the streamer
            // should see: no pause, no error status, no backoff. Speak the
            // next version down for the rest of the session and put the
            // rejected batch (and its transcript) back in front of whatever
            // arrived meanwhile so nothing is lost.
            self.prompt_version = lower;
            self.version_retry = true;
            self.dropped = self.dropped.saturating_add(batch_dropped);
            for message in batch.into_iter().rev() {
                self.pending.push_front(message);
            }
            while self.pending.len() > TICK_DELTA_CAP {
                self.pending.pop_front();
                self.dropped = self.dropped.saturating_add(1);
            }
            if !batch_transcript.is_empty() {
                let mut restored = batch_transcript;
                if !self.transcript_pending.is_empty() {
                    restored.push(' ');
                    restored.push_str(&self.transcript_pending);
                }
                self.transcript_pending =
                    keep_newest_utf16(&restored, TRANSCRIPT_PENDING_CAP_CHARS);
            }
            return;
        }
        let reason = error.reason();
        match error.kind {
            CohostApiErrorKind::QuotaExhausted { retry_after } => {
                self.status = CohostStatus::Paused;
                self.next_attempt_at = Some(now + retry_after.unwrap_or(QUOTA_DEFAULT_RETRY));
            }
            CohostApiErrorKind::PremiumRequired | CohostApiErrorKind::ConsentRequired => {
                self.status = CohostStatus::Paused;
                self.next_attempt_at = Some(now + PRECONDITION_RECHECK);
            }
            _ => {
                self.status = CohostStatus::Error;
                let step = BACKOFF_STEPS_SECS[self.backoff_index.min(BACKOFF_STEPS_SECS.len() - 1)];
                self.backoff_index = (self.backoff_index + 1).min(BACKOFF_STEPS_SECS.len() - 1);
                self.next_attempt_at = Some(now + Duration::from_secs(step));
            }
        }
        self.reason = Some(reason);
        // Every failed tick carries what the server (or the transport) said;
        // the renderer decides how much of it to show per reason.
        self.detail = Some(error.detail.clone());
    }

    /// A local precondition pause (signed out, Basic, no consent). Not a tick
    /// failure, so any earlier tick detail is stale and leaves with it.
    fn pause(&mut self, reason: CohostReason, now: Instant) -> bool {
        let changed = self.status != CohostStatus::Paused || self.reason != Some(reason);
        self.status = CohostStatus::Paused;
        self.reason = Some(reason);
        self.detail = None;
        self.next_attempt_at = Some(now + PRECONDITION_RECHECK);
        changed
    }

    /// Answered, dismissed, replied and answered on air share one engine
    /// outcome: the question leaves the open set and its id never returns
    /// from a later tick. The report tells them apart by `outcome`, counted
    /// only when the question was open.
    fn close_question(&mut self, question_id: &str, outcome: CohostReportQuestionOutcome) -> bool {
        let before = self.questions.len();
        self.questions.retain(|question| question.id != question_id);
        self.dismissed_questions.insert(question_id.to_string());
        let changed = before != self.questions.len();
        if changed {
            self.report.question_closed(question_id, outcome);
        }
        changed
    }

    fn mark_answered(&mut self, question_id: &str) -> bool {
        self.close_question(question_id, CohostReportQuestionOutcome::MarkedAnswered)
    }

    fn dismiss_question(&mut self, question_id: &str) -> bool {
        self.close_question(question_id, CohostReportQuestionOutcome::Dismissed)
    }

    fn dismiss_flag(&mut self, message_id: &str) -> bool {
        let before = self.flags.len();
        self.highlights
            .retain(|highlight| highlight.message_id != message_id);
        self.flags.retain(|flag| flag.message_id != message_id);
        self.dismissed_flags.insert(message_id.to_string());
        self.drop_spotlight_for(message_id);
        let changed = before != self.flags.len();
        if changed {
            self.report.flags_dismissed += 1;
        }
        changed
    }

    /// Plan 140 S4: the streamer removed (or hid) the message, so its flag is
    /// resolved. Like a dismissal it leaves for good and never comes back as a
    /// spotlight or suggestion, but it is not counted as dismissed.
    fn resolve_flag(&mut self, message_id: &str) -> bool {
        let before = self.flags.len();
        self.highlights
            .retain(|highlight| highlight.message_id != message_id);
        self.flags.retain(|flag| flag.message_id != message_id);
        self.dismissed_flags.insert(message_id.to_string());
        self.drop_spotlight_for(message_id);
        before != self.flags.len()
    }

    // --- Voice commands (plan 140 S3) ----------------------------------------

    /// A known comment a voice command may point at: never the streamer's
    /// own, never a deleted one (tombstones included), never a notification
    /// row. Flags do not exclude: the streamer asked.
    fn command_target_eligible(&self, message_id: &str) -> Option<&KnownMessage> {
        let known = self.known.get(message_id)?;
        if self.deleted_ids.contains(message_id)
            || known.notification
            || known.roles.iter().any(|role| role == "owner")
        {
            return None;
        }
        Some(known)
    }

    /// The card's view of a comment.
    fn command_target(&self, message_id: &str) -> Option<CohostCommandTarget> {
        let known = self.known.get(message_id)?;
        Some(CohostCommandTarget {
            message_id: message_id.to_string(),
            author_name: known.author_name.clone(),
            platform: known.platform,
            excerpt: truncate_utf16(known.text.trim(), COMMAND_EXCERPT_MAX_UNITS),
        })
    }

    /// Up to `limit` comments a command may point at, newest first.
    fn newest_command_messages(&self, limit: usize) -> Vec<String> {
        self.known_ids
            .iter()
            .rev()
            .filter(|id| self.command_target_eligible(id).is_some())
            .take(limit)
            .cloned()
            .collect()
    }

    /// The newest comment that asked an open question, by `author` when
    /// given (a platform-qualified author key).
    fn newest_open_question_message(&self, author: Option<&str>) -> Option<String> {
        let asked: HashSet<&str> = self
            .questions
            .iter()
            .flat_map(|question| question.message_ids.iter().map(String::as_str))
            .collect();
        self.known_ids
            .iter()
            .rev()
            .find(|id| {
                asked.contains(id.as_str())
                    && self
                        .command_target_eligible(id)
                        .is_some_and(|known| author.is_none_or(|author| known.author == author))
            })
            .cloned()
    }

    /// Decision 5: where a command's words point.
    fn resolve_command_target(
        &self,
        intent: CommandIntent,
        spec: &CommandTargetSpec,
        on_stream: Option<&str>,
        now: Instant,
        now_utc: chrono::DateTime<chrono::Utc>,
    ) -> CommandResolution {
        let nothing = || {
            CommandResolution::NotFound(
                match intent {
                    CommandIntent::Remove => "Golem couldn't find a comment to remove.",
                    CommandIntent::Highlight | CommandIntent::Clear => {
                        "Golem couldn't find a comment to show."
                    }
                }
                .to_string(),
            )
        };
        match spec {
            CommandTargetSpec::Resolved(ids) => {
                let mut eligible: Vec<String> = Vec::new();
                for id in ids {
                    if self.command_target_eligible(id).is_some() && !eligible.contains(id) {
                        eligible.push(id.clone());
                    }
                }
                eligible.truncate(COMMAND_CANDIDATES_CAP);
                match eligible.len() {
                    0 => {
                        CommandResolution::NotFound("Golem couldn't find that comment.".to_string())
                    }
                    1 => CommandResolution::One(eligible.remove(0)),
                    _ => CommandResolution::Several(eligible),
                }
            }
            CommandTargetSpec::Spoken { target, question } => match target {
                CommandTarget::Name(name) => self.resolve_command_name(name, *question, now),
                CommandTarget::Last => {
                    let question_first = (*question)
                        .then(|| self.newest_open_question_message(None))
                        .flatten();
                    match question_first.or_else(|| self.newest_command_messages(1).pop()) {
                        Some(id) => CommandResolution::One(id),
                        None => nothing(),
                    }
                }
                CommandTarget::Deixis => match intent {
                    CommandIntent::Remove => self.resolve_removal_deixis(on_stream, now, now_utc),
                    CommandIntent::Highlight | CommandIntent::Clear => {
                        match self.highlight_deixis(now) {
                            Some(id) => CommandResolution::One(id),
                            None => nothing(),
                        }
                    }
                },
                CommandTarget::None => CommandResolution::NotFound(
                    "Golem couldn't tell which comment you mean.".to_string(),
                ),
            },
        }
    }

    /// "The comment from coders x": authors whose name the spoken words
    /// match, newest first, among comments of the last ten minutes (command
    /// words stripped first). A name that matches as a whole ("coders x" for
    /// coders_x) beats one that matches only in part (coders_y also has
    /// "coders"). One author: their newest comment, or with "question" their
    /// newest open question. Several: a chooser. None: "couldn't find".
    fn resolve_command_name(
        &self,
        spoken: &str,
        question: bool,
        now: Instant,
    ) -> CommandResolution {
        let not_found = || {
            CommandResolution::NotFound(format!(
                "Golem couldn't find a comment from {}.",
                spoken.trim()
            ))
        };
        let words: Vec<String> = name_tokens(spoken)
            .into_iter()
            .filter(|word| !is_command_word(word))
            .collect();
        if words.is_empty() {
            return not_found();
        }
        let candidates = match_candidates(&words);
        let spoken_joined = words.concat();
        // (author key, how specific the match is, that author's newest comment)
        let mut matched: Vec<(&str, u8, &str)> = Vec::new();
        let mut seen_authors: HashSet<&str> = HashSet::new();
        for id in self.known_ids.iter().rev() {
            let Some(known) = self.known.get(id) else {
                continue;
            };
            // `known_ids` is note order: everything after this is older.
            if now.saturating_duration_since(known.noted_at) > COMMAND_NAME_WINDOW {
                break;
            }
            if self.command_target_eligible(id).is_none()
                || !seen_authors.insert(known.author.as_str())
            {
                continue;
            }
            let forms = name_match_forms(&known.author_name);
            if !name_forms_match(&words, &candidates, &forms) {
                continue;
            }
            let display_joined = name_tokens(&known.author_name).concat();
            let specificity = if display_joined == spoken_joined {
                3
            } else if candidates.contains(&display_joined) {
                2
            } else {
                1
            };
            matched.push((known.author.as_str(), specificity, id.as_str()));
        }
        let Some(best) = matched.iter().map(|(_, specificity, _)| *specificity).max() else {
            return not_found();
        };
        let mut ids: Vec<String> = Vec::new();
        for &(author, specificity, newest) in &matched {
            if specificity != best {
                continue;
            }
            let id = question
                .then(|| self.newest_open_question_message(Some(author)))
                .flatten()
                .unwrap_or_else(|| newest.to_string());
            if !ids.contains(&id) {
                ids.push(id);
            }
            if ids.len() >= COMMAND_CANDIDATES_CAP {
                break;
            }
        }
        match ids.len() {
            0 => not_found(),
            1 => CommandResolution::One(ids.remove(0)),
            _ => CommandResolution::Several(ids),
        }
    }

    /// "Show this one": the comment the streamer is talking about (the
    /// spotlight, while it lasts), else the newest open question, else the
    /// newest comment.
    fn highlight_deixis(&self, now: Instant) -> Option<String> {
        self.spotlight
            .current
            .as_ref()
            .filter(|current| {
                now < current.expires_at && current.score >= SPOTLIGHT_ABOUT_THRESHOLD
            })
            .map(|current| current.message_id.clone())
            .filter(|id| self.command_target_eligible(id).is_some())
            .or_else(|| self.newest_open_question_message(None))
            .or_else(|| self.newest_command_messages(1).pop())
    }

    /// Plan 140 S8: the comments a parsed command may point at, newest
    /// first (the same eligibility as a spoken command).
    fn command_parse_candidates(&self) -> Vec<CohostCommandCandidate> {
        self.newest_command_messages(COHOST_COMMAND_MAX_CANDIDATES)
            .into_iter()
            .filter_map(|id| self.command_parse_candidate(&id))
            .collect()
    }

    fn command_parse_candidate(&self, message_id: &str) -> Option<CohostCommandCandidate> {
        let known = self.command_target_eligible(message_id)?;
        Some(CohostCommandCandidate {
            id: message_id.to_string(),
            author: known.author_name.clone(),
            text: known.text.clone(),
            at: known.at.clone(),
        })
    }

    /// "This one" for the parser: the live spotlight, else the comment on
    /// stream. The request always carries it as a candidate.
    fn command_parse_focus(&self, on_stream: Option<&str>, now: Instant) -> Option<String> {
        self.spotlight
            .current
            .as_ref()
            .filter(|current| {
                now < current.expires_at && current.score >= SPOTLIGHT_ABOUT_THRESHOLD
            })
            .map(|current| current.message_id.as_str())
            .filter(|id| self.command_target_eligible(id).is_some())
            .or_else(|| on_stream.filter(|id| self.command_target_eligible(id).is_some()))
            .map(str::to_string)
    }

    /// "Remove this one": the comment on stream, the newest flag of the last
    /// two minutes that is not deleted, and the spotlight. One of them goes
    /// to the confirm card; several (deduped) to the chooser. With none, a
    /// chooser of the newest comments: never a guess.
    fn resolve_removal_deixis(
        &self,
        on_stream: Option<&str>,
        now: Instant,
        now_utc: chrono::DateTime<chrono::Utc>,
    ) -> CommandResolution {
        let mut ids: Vec<String> = Vec::new();
        let mut consider = |id: &str| {
            if self.command_target_eligible(id).is_some() && !ids.iter().any(|seen| seen == id) {
                ids.push(id.to_string());
            }
        };
        if let Some(id) = on_stream {
            consider(id);
        }
        if let Some(flag) = self.flags.iter().rev().find(|flag| {
            self.command_target_eligible(&flag.message_id).is_some()
                && command_flag_is_recent(&flag.at, now_utc)
        }) {
            consider(flag.message_id.as_str());
        }
        if let Some(current) = self
            .spotlight
            .current
            .as_ref()
            .filter(|current| now < current.expires_at)
        {
            consider(current.message_id.as_str());
        }
        match ids.len() {
            0 => {
                let recent = self.newest_command_messages(COMMAND_CANDIDATES_CAP);
                if recent.is_empty() {
                    CommandResolution::NotFound(
                        "Golem couldn't find a comment to remove.".to_string(),
                    )
                } else {
                    CommandResolution::Several(recent)
                }
            }
            1 => CommandResolution::One(ids.remove(0)),
            _ => CommandResolution::Several(ids),
        }
    }

    /// Newest wins: the open card closes for a newer command. A pending
    /// removal is cancelled after the lock, and that cancellation is not
    /// counted (the streamer moved on; they did not say no). A removal that
    /// already runs runs on, and its outcome still counts.
    fn supersede_command(&mut self) -> Vec<String> {
        let mut cancel = Vec::new();
        if let Some(record) = self.command.as_mut() {
            if record.pending == CommandPending::Removal
                && let Some(operation_id) = record.wire.operation_id.clone()
            {
                self.command_operations
                    .entry(operation_id.clone())
                    .or_default()
                    .superseded = true;
                cancel.push(operation_id);
            }
            record.pending = CommandPending::None;
        }
        cancel
    }

    /// A session boundary (a consent change, sign-out) closes the open card.
    /// Like `supersede_command`, it returns the pending removal: the caller
    /// cancels it after the engine lock (`cancel_abandoned_removal`), never
    /// trusting the slot mirror, which a concurrent command step may rewrite
    /// before `clear_transcript` reads it. Nothing here is counted.
    fn abandon_command(&mut self, message: &str, now_iso: &str) -> Option<String> {
        let record = self.command.as_mut()?;
        if matches!(
            record.pending,
            CommandPending::None | CommandPending::Removing
        ) {
            return None;
        }
        let mut cancel = None;
        if record.pending == CommandPending::Removal
            && let Some(operation_id) = record.wire.operation_id.clone()
        {
            self.command_operations
                .entry(operation_id.clone())
                .or_default()
                .superseded = true;
            cancel = Some(operation_id);
        }
        record.finish(CohostCommandStatus::Cancelled, message, now_iso);
        cancel
    }

    /// A new voice command, under the engine lock. Newest wins: it replaces
    /// the open card (a pending removal is cancelled after the lock). A
    /// second command that lands on the same comment within ten seconds is
    /// the same request and changes nothing.
    fn begin_command(
        &mut self,
        command: NewCommand,
        ctx: &CommandContext,
        confirm_mode: RemoveConfirmMode,
        auto_generation: &mut u64,
    ) -> CommandEffects {
        let mut effects = CommandEffects {
            emit: true,
            ..CommandEffects::default()
        };
        let now_iso = ctx.now_iso();
        if let Some(message) = command_gate(ctx, Some(command.intent)) {
            effects.cancel_superseded = self.supersede_command();
            let mut record = CommandRecord::new(&command, ctx);
            record.finish(CohostCommandStatus::Unavailable, message, &now_iso);
            self.command = Some(record);
            return effects;
        }
        if command.intent == CommandIntent::Clear {
            // "Remove it" then "from the screen": the removal was never meant.
            let correction = self.command.as_ref().is_some_and(|record| {
                record.intent == Some(CommandIntent::Remove)
                    && matches!(
                        record.pending,
                        CommandPending::Requesting | CommandPending::Removal
                    )
                    && ctx.now.saturating_duration_since(record.heard_at)
                        <= COMMAND_CORRECTION_WINDOW
            });
            effects.cancel_superseded = self.supersede_command();
            let had_card = ctx.on_stream.is_some() || self.auto.requested.is_some();
            // A command card the renderer has not set yet must not appear
            // after the clear.
            self.auto.requested = None;
            self.auto.latest = None;
            let message = match (had_card, correction) {
                (true, true) => "Cleared the highlight. Nothing was removed.",
                (true, false) => "Cleared the highlight.",
                (false, true) => "Nothing was on stream. Nothing was removed.",
                (false, false) => "Nothing was on stream.",
            };
            if had_card {
                self.report.commands.cleared += 1;
            }
            let mut record = CommandRecord::new(&command, ctx);
            record.finish(CohostCommandStatus::Done, message, &now_iso);
            self.command = Some(record);
            effects.clear_highlight = true;
            return effects;
        }
        let resolution = self.resolve_command_target(
            command.intent,
            &command.spec,
            ctx.on_stream.as_deref(),
            ctx.now,
            ctx.now_utc,
        );
        let resolved: Vec<String> = match &resolution {
            CommandResolution::One(id) => vec![id.clone()],
            CommandResolution::Several(ids) => ids.clone(),
            CommandResolution::NotFound(_) => Vec::new(),
        };
        let same_request = !resolved.is_empty()
            && self.command.as_ref().is_some_and(|record| {
                record.intent == Some(command.intent)
                    && record.resolved == resolved
                    && ctx.now.saturating_duration_since(record.heard_at)
                        <= COMMAND_SAME_TARGET_WINDOW
                    && !matches!(
                        record.wire.status,
                        CohostCommandStatus::Cancelled
                            | CohostCommandStatus::Expired
                            | CohostCommandStatus::Refused
                            | CohostCommandStatus::Unavailable
                            | CohostCommandStatus::NotFound
                    )
            });
        if same_request {
            return CommandEffects::default();
        }
        effects.cancel_superseded = self.supersede_command();
        let mut record = CommandRecord::new(&command, ctx);
        record.resolved = resolved;
        match resolution {
            CommandResolution::NotFound(message) => {
                record.finish(CohostCommandStatus::NotFound, message, &now_iso);
                self.report.commands.not_found += 1;
            }
            CommandResolution::Several(ids) => {
                self.open_chooser(&mut record, &ids, ctx, &mut effects)
            }
            CommandResolution::One(message_id) => match command.intent {
                CommandIntent::Remove => self.open_removal_request(
                    &mut record,
                    &message_id,
                    confirm_mode,
                    &now_iso,
                    &mut effects,
                ),
                CommandIntent::Highlight => self.highlight_or_ask(
                    &mut record,
                    &message_id,
                    ctx,
                    auto_generation,
                    &mut effects,
                ),
                // A clear returned above; it has no target.
                CommandIntent::Clear => {}
            },
        }
        self.command = Some(record);
        effects
    }

    /// Several comments fit: the chooser opens for 20 s.
    fn open_chooser(
        &self,
        record: &mut CommandRecord,
        ids: &[String],
        ctx: &CommandContext,
        effects: &mut CommandEffects,
    ) {
        let candidates: Vec<CohostCommandTarget> = ids
            .iter()
            .filter_map(|id| self.command_target(id))
            .take(COMMAND_CANDIDATES_CAP)
            .collect();
        let expires_at = iso_after(ctx.now, ctx.now + COMMAND_CARD_TTL);
        record.pending = CommandPending::Choice;
        record.wire.status = CohostCommandStatus::Ambiguous;
        record.wire.message = chooser_message(candidates.len());
        record.wire.candidates = candidates;
        record.wire.target = None;
        record.wire.expires_at = Some(expires_at.clone());
        record.wire.at = ctx.now_iso();
        effects.expire_card = Some((record.wire.id.clone(), expires_at));
    }

    /// One comment to remove: chat moderation opens the card (after the
    /// lock); until it answers, the card shows without `operationId`.
    fn open_removal_request(
        &self,
        record: &mut CommandRecord,
        message_id: &str,
        confirm_mode: RemoveConfirmMode,
        now_iso: &str,
        effects: &mut CommandEffects,
    ) {
        record.wire.target = self.command_target(message_id);
        record.wire.candidates.clear();
        record.wire.operation_id = None;
        record.resolved = vec![message_id.to_string()];
        record.pending = CommandPending::Requesting;
        record.operation_rank = 0;
        record.wire.status = CohostCommandStatus::Confirm;
        record.wire.message = format!("Remove {}?", record.comment());
        record.wire.expires_at = None;
        record.wire.at = now_iso.to_string();
        effects.request_removal = Some(CommandRemovalRequest {
            command_id: record.wire.id.clone(),
            message_id: message_id.to_string(),
            reason: record.wire.reason.clone(),
            confirm_mode: record.removal_mode(confirm_mode),
        });
    }

    /// One comment to show: on stream now (`CohostAutoHighlight`, source
    /// `command`, past the automatic cadence rules: the streamer asked),
    /// unless Golem flagged it high: then it asks first.
    fn highlight_or_ask(
        &mut self,
        record: &mut CommandRecord,
        message_id: &str,
        ctx: &CommandContext,
        auto_generation: &mut u64,
        effects: &mut CommandEffects,
    ) {
        record.wire.target = self.command_target(message_id);
        record.wire.candidates.clear();
        record.resolved = vec![message_id.to_string()];
        let flagged = self
            .flags
            .iter()
            .find(|flag| flag.message_id == message_id && flag.severity == CohostFlagSeverity::High)
            .map(|flag| flag.kind);
        if let Some(kind) = flagged {
            let expires_at = iso_after(ctx.now, ctx.now + COMMAND_CARD_TTL);
            record.pending = CommandPending::HighlightConfirm;
            record.wire.status = CohostCommandStatus::Confirm;
            record.wire.message = match command_flag_label(kind) {
                Some(label) => format!("Golem flagged this ({label}). Show it anyway?"),
                None => "Golem flagged this. Show it anyway?".to_string(),
            };
            record.wire.expires_at = Some(expires_at.clone());
            record.wire.at = ctx.now_iso();
            effects.expire_card = Some((record.wire.id.clone(), expires_at));
            return;
        }
        self.apply_command_highlight(
            message_id,
            ctx.on_stream.as_deref(),
            auto_generation,
            ctx.now,
        );
        let message = format!("Highlighted {}.", record.comment());
        record.finish(CohostCommandStatus::Done, message, &ctx.now_iso());
        self.report.commands.highlighted += 1;
    }

    /// Issue the on-stream command the renderer executes exactly once per
    /// generation. Re-setting the card that is already live is a refresh.
    fn apply_command_highlight(
        &mut self,
        message_id: &str,
        on_stream: Option<&str>,
        auto_generation: &mut u64,
        now: Instant,
    ) {
        let author = self
            .known
            .get(message_id)
            .map(|known| known.author.clone())
            .unwrap_or_default();
        *auto_generation = auto_generation.wrapping_add(1).max(1);
        self.apply_auto_decision(
            AutoHighlightDecision {
                message_id: message_id.to_string(),
                author,
                source: CohostAutoHighlightSource::Command,
                highlight_type: None,
                refresh: on_stream == Some(message_id),
            },
            *auto_generation,
            now,
        );
    }

    /// An answer to the open card. `command_id` pins the card a renderer
    /// showed; a voice answer takes whatever is open.
    fn answer_command(
        &mut self,
        command_id: Option<&str>,
        answer: CommandAnswer,
        ctx: &CommandContext,
        confirm_mode: RemoveConfirmMode,
        auto_generation: &mut u64,
    ) -> Result<CommandEffects, CohostCommandError> {
        let Some(mut record) = self.command.take() else {
            return Err(CohostCommandError::not_pending());
        };
        let result = self.answer_record(
            &mut record,
            command_id,
            answer,
            ctx,
            confirm_mode,
            auto_generation,
        );
        self.command = Some(record);
        result
    }

    fn answer_record(
        &mut self,
        record: &mut CommandRecord,
        command_id: Option<&str>,
        answer: CommandAnswer,
        ctx: &CommandContext,
        confirm_mode: RemoveConfirmMode,
        auto_generation: &mut u64,
    ) -> Result<CommandEffects, CohostCommandError> {
        if command_id.is_some_and(|id| id != record.wire.id) {
            return Err(CohostCommandError::not_pending());
        }
        let mut effects = CommandEffects {
            emit: true,
            ..CommandEffects::default()
        };
        let now_iso = ctx.now_iso();
        match (record.pending, answer) {
            (CommandPending::Choice, CommandAnswer::Choose(index)) => {
                let Some(message_id) = record
                    .wire
                    .candidates
                    .get(usize::from(index))
                    .map(|candidate| candidate.message_id.clone())
                else {
                    return Err(CohostCommandError::invalid(format!(
                        "Pick one of the {} comments.",
                        record.wire.candidates.len()
                    )));
                };
                if let Some(message) = command_gate(ctx, record.intent) {
                    record.finish(CohostCommandStatus::Unavailable, message, &now_iso);
                    return Ok(effects);
                }
                match record.intent {
                    Some(CommandIntent::Remove) => self.open_removal_request(
                        record,
                        &message_id,
                        confirm_mode,
                        &now_iso,
                        &mut effects,
                    ),
                    _ => self.highlight_or_ask(
                        record,
                        &message_id,
                        ctx,
                        auto_generation,
                        &mut effects,
                    ),
                }
            }
            (CommandPending::Choice, CommandAnswer::Cancel) => {
                record.finish(CohostCommandStatus::Cancelled, "Cancelled.", &now_iso);
                self.report.commands.cancelled += 1;
            }
            (CommandPending::HighlightConfirm, CommandAnswer::Confirm) => {
                if let Some(message) = command_gate(ctx, record.intent) {
                    record.finish(CohostCommandStatus::Unavailable, message, &now_iso);
                    return Ok(effects);
                }
                let Some(message_id) = record.resolved.first().cloned() else {
                    return Err(CohostCommandError::not_pending());
                };
                if self.command_target_eligible(&message_id).is_none() {
                    // Deleted (or gone) while the card was open.
                    record.finish(
                        CohostCommandStatus::NotFound,
                        "That comment is gone.",
                        &now_iso,
                    );
                    self.report.commands.not_found += 1;
                    return Ok(effects);
                }
                self.apply_command_highlight(
                    &message_id,
                    ctx.on_stream.as_deref(),
                    auto_generation,
                    ctx.now,
                );
                let message = format!("Highlighted {}.", record.comment());
                record.finish(CohostCommandStatus::Done, message, &now_iso);
                self.report.commands.highlighted += 1;
            }
            (CommandPending::HighlightConfirm, CommandAnswer::Cancel) => {
                record.finish(
                    CohostCommandStatus::Cancelled,
                    "Cancelled. Nothing was shown.",
                    &now_iso,
                );
                self.report.commands.cancelled += 1;
            }
            (CommandPending::Removal, CommandAnswer::Confirm) => {
                let Some(operation_id) = record.wire.operation_id.clone() else {
                    return Err(CohostCommandError::not_pending());
                };
                if let Some(message) = command_gate(ctx, record.intent) {
                    // It cannot run now: cancel it rather than leave it to a
                    // countdown. Not the streamer's "no", so not counted.
                    self.command_operations
                        .entry(operation_id.clone())
                        .or_default()
                        .superseded = true;
                    effects.cancel_superseded.push(operation_id);
                    record.finish(CohostCommandStatus::Unavailable, message, &now_iso);
                    return Ok(effects);
                }
                record.pending = CommandPending::Removing;
                record.wire.message = format!("Removing {}…", record.comment());
                record.wire.expires_at = None;
                record.wire.at = now_iso;
                effects.confirm_removal = Some(operation_id);
            }
            (CommandPending::Removal, CommandAnswer::Cancel) => {
                let Some(operation_id) = record.wire.operation_id.clone() else {
                    return Err(CohostCommandError::not_pending());
                };
                // The operation's cancellation updates the card.
                effects.emit = false;
                effects.cancel_removal = Some(operation_id);
            }
            _ => return Err(CohostCommandError::not_pending()),
        }
        Ok(effects)
    }

    /// Golem was addressed and understood nothing: "Golem didn't catch
    /// that: '…'". Never while a card is open: an unclear utterance must not
    /// close a card the streamer may still answer.
    fn note_unheard_command(&mut self, heard: &str, ctx: &CommandContext) -> bool {
        if self
            .command
            .as_ref()
            .is_some_and(|record| record.pending != CommandPending::None)
        {
            return false;
        }
        let now_iso = ctx.now_iso();
        let mut record = CommandRecord::unheard(heard, ctx);
        if let Some(message) = command_gate(ctx, None) {
            record.finish(CohostCommandStatus::Unavailable, message, &now_iso);
        } else {
            let message = format!("Golem didn't catch that: '{}'.", record.wire.heard);
            record.finish(CohostCommandStatus::NotFound, message, &now_iso);
            self.report.commands.not_found += 1;
        }
        self.command = Some(record);
        true
    }

    /// Chat moderation answered the removal request a command made. Returns
    /// whether the card changed, and the operation to cancel when the
    /// command was replaced while its request was on the way.
    fn settle_command_removal(
        &mut self,
        command_id: &str,
        result: Result<ModerationOperation, ModerationRefusal>,
        now_iso: &str,
    ) -> (bool, Option<String>) {
        let current = self.command.as_ref().is_some_and(|record| {
            record.wire.id == command_id && record.pending == CommandPending::Requesting
        });
        match result {
            Ok(operation) if !current => (false, Some(operation.operation_id)),
            Ok(operation) => {
                self.command_operations.insert(
                    operation.operation_id.clone(),
                    CommandOperationTrack::default(),
                );
                if let Some(record) = self.command.as_mut() {
                    record.wire.operation_id = Some(operation.operation_id.clone());
                }
                (self.apply_command_operation(&operation, now_iso), None)
            }
            Err(_) if !current => (false, None),
            Err(refusal) => {
                let unavailable = matches!(refusal.code, "premium-required" | "disabled");
                if let Some(record) = self.command.as_mut() {
                    let status = if unavailable {
                        CohostCommandStatus::Unavailable
                    } else {
                        CohostCommandStatus::Refused
                    };
                    record.finish(status, refusal.message, now_iso);
                }
                if !unavailable {
                    self.report.commands.failed += 1;
                }
                (true, None)
            }
        }
    }

    /// A change of a removal a voice command created. Counts its terminal
    /// outcome once for the report, and moves the command's card along while
    /// it is still the latest command. Phases only move forward: an older
    /// change that lands late changes nothing.
    fn apply_command_operation(&mut self, operation: &ModerationOperation, now_iso: &str) -> bool {
        let Some(track) = self.command_operations.get_mut(&operation.operation_id) else {
            return false;
        };
        if operation.phase.is_terminal() && !track.counted {
            track.counted = true;
            let commands = &mut self.report.commands;
            match operation.phase {
                ModerationPhase::Removed => commands.removed += 1,
                ModerationPhase::HiddenLocally => commands.hidden_locally += 1,
                ModerationPhase::Cancelled => {
                    if !track.superseded {
                        commands.cancelled += 1;
                    }
                }
                ModerationPhase::Expired => commands.expired += 1,
                ModerationPhase::Failed | ModerationPhase::DeliveryUnknown => commands.failed += 1,
                ModerationPhase::PendingConfirm | ModerationPhase::Executing => {}
            }
        }
        let Some(record) = self.command.as_mut().filter(|record| {
            record.wire.operation_id.as_deref() == Some(operation.operation_id.as_str())
        }) else {
            return false;
        };
        let rank = command_operation_rank(operation.phase);
        if rank <= record.operation_rank {
            return false;
        }
        record.operation_rank = rank;
        apply_operation_to_record(record, operation, now_iso);
        true
    }

    /// A chooser or highlight card nobody answered in time. `expires_at`
    /// pins the card the timer was armed for: a chooser that became a
    /// confirm card has a timer of its own.
    fn expire_command(&mut self, command_id: &str, expires_at: &str, now_iso: &str) -> bool {
        let Some(record) = self.command.as_mut() else {
            return false;
        };
        if record.wire.id != command_id || record.wire.expires_at.as_deref() != Some(expires_at) {
            return false;
        }
        let message = match record.pending {
            CommandPending::Choice => "No comment was picked.",
            CommandPending::HighlightConfirm => "No answer. Nothing was shown.",
            CommandPending::None
            | CommandPending::Requesting
            | CommandPending::Removal
            | CommandPending::Removing => return false,
        };
        record.finish(CohostCommandStatus::Expired, message, now_iso);
        self.report.commands.expired += 1;
        true
    }

    // --- Spotlight lane (plan 060 S3) ----------------------------------------

    /// The spotlight as the wire sees it: `None` once it expired.
    fn spotlight_at(&self, now: Instant) -> Option<CohostSpotlight> {
        self.spotlight
            .current
            .as_ref()
            .filter(|current| now < current.expires_at)
            .map(|current| CohostSpotlight {
                message_id: current.message_id.clone(),
                question_id: current.question_id.clone(),
                score: current.score,
                at: current.at_iso.clone(),
                expires_at: current.expires_at_iso.clone(),
            })
    }

    /// The message the Voice source may put on stream right now.
    fn spotlight_message_id(&self, now: Instant) -> Option<&str> {
        self.spotlight
            .current
            .as_ref()
            .filter(|current| now < current.expires_at)
            .map(|current| current.message_id.as_str())
    }

    fn drop_spotlight_for(&mut self, message_id: &str) {
        if self
            .spotlight
            .current
            .as_ref()
            .is_some_and(|current| current.message_id == message_id)
        {
            self.spotlight.current = None;
        }
    }

    /// Clear an expired spotlight. True when one just left (news for the
    /// renderer: the pull-up must go).
    fn expire_spotlight(&mut self, now: Instant) -> bool {
        if self
            .spotlight
            .current
            .as_ref()
            .is_some_and(|current| now >= current.expires_at)
        {
            self.spotlight.current = None;
            return true;
        }
        false
    }

    fn recently_resolved_at(&self, now: Instant) -> Vec<CohostRecentlyResolved> {
        self.recently_resolved
            .iter()
            .filter(|record| now.saturating_duration_since(record.at) < RECENTLY_RESOLVED_TTL)
            .map(|record| record.entry.clone())
            .collect()
    }

    /// Resolve an open question because the streamer answered it on air:
    /// it leaves the open set like `mark_answered`, and is kept for a minute
    /// so the streamer can put it back.
    fn resolve_by_voice(&mut self, question_id: &str, now: Instant, now_iso: &str) -> bool {
        let Some(question) = self
            .questions
            .iter()
            .find(|question| question.id == question_id)
            .cloned()
        else {
            return false;
        };
        self.close_question(question_id, CohostReportQuestionOutcome::AnsweredOnAir);
        self.recently_resolved
            .retain(|record| now.saturating_duration_since(record.at) < RECENTLY_RESOLVED_TTL);
        self.recently_resolved.push(ResolvedRecord {
            entry: CohostRecentlyResolved {
                question,
                reason: CohostResolveReason::Voice,
                resolved_at: now_iso.to_string(),
            },
            at: now,
        });
        while self.recently_resolved.len() > RECENTLY_RESOLVED_CAP {
            self.recently_resolved.remove(0);
        }
        true
    }

    /// `cohost.question.restore`: a recently voice-resolved question goes back
    /// to the open set, may return from later ticks again, and leaves the
    /// recently-resolved list. False when it is not there (or too old).
    fn restore_question(&mut self, question_id: &str, now: Instant) -> bool {
        self.recently_resolved
            .retain(|record| now.saturating_duration_since(record.at) < RECENTLY_RESOLVED_TTL);
        let Some(index) = self
            .recently_resolved
            .iter()
            .position(|record| record.entry.question.id == question_id)
        else {
            return false;
        };
        let record = self.recently_resolved.remove(index);
        self.dismissed_questions.remove(question_id);
        self.spotlight.answered_streak.remove(question_id);
        if !self
            .questions
            .iter()
            .any(|question| question.id == question_id)
        {
            self.questions.push(record.entry.question);
        }
        self.report.question_restored(question_id);
        true
    }

    /// Safety at send time and at receipt: known, not deleted, not flagged or
    /// flag-dismissed, never the broadcaster.
    fn spotlight_eligible(&self, message_id: &str) -> Option<&KnownMessage> {
        let known = self.known.get(message_id)?;
        if self.deleted_ids.contains(message_id)
            || self.dismissed_flags.contains(message_id)
            || self.flags.iter().any(|flag| flag.message_id == message_id)
            || known.roles.iter().any(|role| role == "owner")
        {
            return None;
        }
        Some(known)
    }

    fn spotlight_candidate(
        &self,
        message_id: &str,
        question: Option<&CohostQuestion>,
    ) -> Option<CohostSpotlightCandidate> {
        if message_id.chars().count() > SPOTLIGHT_CANDIDATE_ID_MAX_CHARS {
            return None;
        }
        let known = self.spotlight_eligible(message_id)?;
        let author = truncate_utf16(known.author_name.trim(), SPOTLIGHT_AUTHOR_MAX_CHARS);
        // A question id the server would reject makes the row a plain
        // candidate: still "about", no "answered".
        let question = question
            .filter(|question| question.id.chars().count() <= SPOTLIGHT_QUESTION_ID_MAX_CHARS);
        Some(CohostSpotlightCandidate {
            id: message_id.to_string(),
            text: known.text.clone(),
            author: if author.is_empty() {
                "Viewer".to_string()
            } else {
                author
            },
            roles: (!known.roles.is_empty()).then(|| known.roles.clone()),
            at: known.at.clone(),
            question_id: question.map(|question| question.id.clone()),
            question_text: question
                .map(|question| truncate_utf16(question.text.trim(), TICK_MESSAGE_TEXT_MAX_CHARS))
                .filter(|text| !text.is_empty()),
        })
    }

    /// Open questions first (the first `SPOTLIGHT_QUESTION_CANDIDATES_CAP`
    /// eligible ones by priority, then recency; the first message carries
    /// the question), then
    /// the newest eligible messages of the last `SPOTLIGHT_MESSAGE_MAX_AGE`,
    /// `SPOTLIGHT_CANDIDATES_CAP` in total. Ids are unique.
    fn spotlight_candidates(&self, now: Instant) -> Vec<CohostSpotlightCandidate> {
        let mut candidates: Vec<CohostSpotlightCandidate> = Vec::new();
        let mut ids: HashSet<&str> = HashSet::new();
        let mut questions: Vec<&CohostQuestion> = self.questions.iter().collect();
        questions.sort_by(|a, b| {
            priority_rank(a.priority)
                .cmp(&priority_rank(b.priority))
                .then_with(|| b.updated_at.cmp(&a.updated_at))
                .then_with(|| a.id.cmp(&b.id))
        });
        for question in questions {
            if candidates.len() >= SPOTLIGHT_QUESTION_CANDIDATES_CAP {
                break;
            }
            let Some(message_id) = question.message_ids.first() else {
                continue;
            };
            if ids.contains(message_id.as_str()) {
                continue;
            }
            if let Some(candidate) = self.spotlight_candidate(message_id, Some(question)) {
                ids.insert(message_id.as_str());
                candidates.push(candidate);
            }
        }
        // `known_ids` is note order, so the tail is the newest.
        for message_id in self.known_ids.iter().rev() {
            if candidates.len() >= SPOTLIGHT_CANDIDATES_CAP {
                break;
            }
            let Some(known) = self.known.get(message_id) else {
                continue;
            };
            if now.saturating_duration_since(known.noted_at) > SPOTLIGHT_MESSAGE_MAX_AGE {
                break;
            }
            if ids.contains(message_id.as_str()) {
                continue;
            }
            if let Some(candidate) = self.spotlight_candidate(message_id, None) {
                ids.insert(message_id.as_str());
                candidates.push(candidate);
            }
        }
        candidates
    }

    fn build_spotlight_request(
        &mut self,
        transcript: &TranscriptSnapshot,
        candidates: Vec<CohostSpotlightCandidate>,
        now: Instant,
    ) -> CohostSpotlightRequest {
        self.spotlight.seq = self.spotlight.seq.saturating_add(1);
        self.spotlight.in_flight = true;
        self.spotlight.last_call_at = Some(now);
        self.spotlight.last_version = Some(transcript.version);
        let mut request = CohostSpotlightRequest {
            client_version: DESKTOP_CLIENT_VERSION.to_string(),
            session_client_id: self.session_id.clone(),
            consent_to_process_chat: self.consent,
            transcript: transcript.text.clone(),
            seq: self.spotlight.seq,
            candidates,
        };
        trim_spotlight_request_to_budget(&mut request, COHOST_SPOTLIGHT_MAX_BODY_BYTES);
        request
    }

    /// Merge one spotlight answer. The best `about` at or above the threshold
    /// becomes (or refreshes) the spotlight — highest score, tie to the
    /// earliest message; a match on a message that is flagged, deleted or
    /// unknown by now is dropped. `answered` at or above its threshold on
    /// `SPOTLIGHT_ANSWERED_STREAK` calls in a row resolves the question.
    fn apply_spotlight_response(
        &mut self,
        response: CohostSpotlightResponse,
        now: Instant,
        now_iso: &str,
    ) -> SpotlightOutcome {
        self.spotlight.in_flight = false;
        self.spotlight.failures = 0;
        self.spotlight.off_until = None;
        let mut outcome = SpotlightOutcome::default();

        let mut best: Option<(String, Option<String>, f64, String)> = None;
        let mut hits: HashSet<String> = HashSet::new();
        for matched in &response.matches {
            let Some(known) = self.spotlight_eligible(&matched.message_id) else {
                continue;
            };
            let about = unit_interval(matched.about).unwrap_or(0.0);
            if about >= SPOTLIGHT_ABOUT_THRESHOLD {
                let better = match &best {
                    None => true,
                    Some((_, _, best_about, best_at)) => {
                        about > *best_about || (about == *best_about && known.at < *best_at)
                    }
                };
                if better {
                    best = Some((
                        matched.message_id.clone(),
                        matched.question_id.clone(),
                        about,
                        known.at.clone(),
                    ));
                }
            }
            if let (Some(question_id), Some(answered)) = (
                &matched.question_id,
                matched.answered.and_then(unit_interval),
            ) && answered >= SPOTLIGHT_ANSWERED_THRESHOLD
                && self
                    .questions
                    .iter()
                    .any(|question| &question.id == question_id)
            {
                hits.insert(question_id.clone());
            }
        }

        if self.expire_spotlight(now) {
            outcome.changed = true;
        }
        if let Some((message_id, question_id, about, _)) = best {
            let expires_at = now + SPOTLIGHT_EXPIRY;
            let expires_at_iso = iso_after(now, expires_at);
            match self.spotlight.current.as_mut() {
                Some(current) if current.message_id == message_id => {
                    current.score = about;
                    current.question_id = question_id;
                    current.expires_at = expires_at;
                    current.expires_at_iso = expires_at_iso;
                }
                _ => {
                    self.spotlight.current = Some(SpotlightRecord {
                        message_id: message_id.clone(),
                        question_id,
                        score: about,
                        at_iso: now_iso.to_string(),
                        expires_at,
                        expires_at_iso,
                    });
                    outcome.spotlight_set = Some((message_id, about));
                }
            }
            outcome.changed = true;
        }

        // A call that does not say "answered" breaks the streak.
        self.spotlight
            .answered_streak
            .retain(|question_id, _| hits.contains(question_id));
        let mut resolve: Vec<String> = Vec::new();
        for question_id in hits {
            let streak = self
                .spotlight
                .answered_streak
                .entry(question_id.clone())
                .or_insert(0);
            *streak += 1;
            if *streak >= SPOTLIGHT_ANSWERED_STREAK {
                resolve.push(question_id);
            }
        }
        resolve.sort();
        for question_id in resolve {
            self.spotlight.answered_streak.remove(&question_id);
            if self.resolve_by_voice(&question_id, now, now_iso) {
                outcome.changed = true;
                outcome.resolved.push(question_id);
            }
        }
        outcome
    }

    /// The lane's breaker (D12: degrade to nothing). Nothing here touches the
    /// tick's status, reason, detail or backoff.
    fn apply_spotlight_failure(
        &mut self,
        error: &CohostApiError,
        now: Instant,
    ) -> SpotlightOutcome {
        self.spotlight.in_flight = false;
        // "Two consecutive calls" means consecutive answers: a hit, a failed
        // call, then a hit is not a streak.
        self.spotlight.answered_streak.clear();
        let unavailable = error.detail.status == Some(404)
            || error.kind == CohostApiErrorKind::PremiumRequired
            || matches!(
                error.detail.code.as_str(),
                "spotlight-disabled" | "judge-unconfigured" | "premium-required"
            );
        let off = if unavailable {
            Some(SPOTLIGHT_UNAVAILABLE_OFF)
        } else if let CohostApiErrorKind::QuotaExhausted { retry_after } = error.kind {
            Some(retry_after.unwrap_or(SPOTLIGHT_UNAVAILABLE_OFF))
        } else {
            self.spotlight.failures += 1;
            (self.spotlight.failures >= SPOTLIGHT_BREAKER_FAILURES).then_some(SPOTLIGHT_BREAKER_OFF)
        };
        if let Some(off) = off {
            self.spotlight.failures = 0;
            self.spotlight.off_until = Some(now + off);
        }
        SpotlightOutcome {
            lane_off_for: off,
            ..SpotlightOutcome::default()
        }
    }

    // --- Automatic on-stream cards (plan 060 S1) -----------------------------

    /// Record what the comment-highlight overlay shows right now. A live card
    /// the engine asked for settles its request; any live card counts as shown
    /// this session (never re-shown automatically); a card leaving the stream
    /// fixes the cooldown anchor at its expiry or its earlier clear.
    fn observe_overlay(&mut self, overlay: &OverlayObservation, now: Instant) {
        match overlay.live_message_id.as_deref() {
            Some(message_id) => {
                let observed_expiry = now + overlay.remaining;
                let requested = self.auto.requested.as_ref().is_some_and(|request| {
                    request.message_id == message_id
                        && (!request.refresh
                            || !self.auto.card.as_ref().is_some_and(|card| {
                                observed_expiry <= card.expires_at + Duration::from_secs(1)
                            }))
                });
                if requested {
                    // Fulfilled: the wire command leaves the snapshot so a
                    // renderer that (re)connects later never replays it.
                    self.auto.requested = None;
                    self.auto.latest = None;
                }
                let engine_set = requested
                    || self
                        .auto
                        .card
                        .as_ref()
                        .is_some_and(|card| card.message_id == message_id && card.engine_set);
                self.auto.card = Some(ObservedCard {
                    message_id: message_id.to_string(),
                    engine_set,
                    expires_at: observed_expiry,
                });
                self.auto.shown.insert(message_id.to_string());
                if self.auto.counted_on_stream.insert(message_id.to_string()) {
                    // Plan 119: the report counts each comment on stream once
                    // and marks the open question it carries as shown.
                    let question_id = self
                        .questions
                        .iter()
                        .find(|question| question.message_ids.iter().any(|id| id == message_id))
                        .map(|question| question.id.clone());
                    self.report.comment_shown(question_id.as_deref());
                }
                // Plan 068 D9: their message on stream acknowledges them.
                if let Some(author) = self.known.get(message_id).map(|known| known.author.clone()) {
                    self.ledger.greet(&author, GreetedHow::Highlight, now);
                }
            }
            None => {
                if let Some(card) = self.auto.card.take() {
                    self.auto.last_card_end = Some(card.expires_at.min(now));
                }
            }
        }
        // A command the renderer never fulfilled (message gone from its
        // snapshot, card ineligible) must not block the policy for ever.
        if self.auto.requested.as_ref().is_some_and(|request| {
            now.saturating_duration_since(request.asked_at) > AUTO_HIGHLIGHT_APPLY_TIMEOUT
        }) {
            self.auto.requested = None;
            self.auto.latest = None;
        }
    }

    /// One candidate with the safety facts read at fire time, or `None` for a
    /// message the engine never noted (or evicted).
    fn auto_candidate(
        &self,
        message_id: &str,
        source: CohostAutoHighlightSource,
        highlight_type: CohostHighlightType,
        score: f64,
        now: Instant,
    ) -> Option<AutoHighlightCandidate> {
        let known = self.known.get(message_id)?;
        Some(AutoHighlightCandidate {
            message_id: message_id.to_string(),
            author: known.author.clone(),
            roles: known.roles.clone(),
            source,
            highlight_type,
            score,
            age: now.saturating_duration_since(known.noted_at),
            flagged: self.flags.iter().any(|flag| flag.message_id == message_id),
            flag_dismissed: self.dismissed_flags.contains(message_id),
            deleted: self.deleted_ids.contains(message_id),
        })
    }

    fn auto_highlight_input(
        &self,
        picks_enabled: bool,
        voice_enabled: bool,
        voice: Option<AutoHighlightCandidate>,
        now: Instant,
    ) -> AutoHighlightInput {
        let card = match (&self.auto.card, &self.auto.requested) {
            (Some(card), _) => AutoHighlightCard::Live {
                message_id: card.message_id.clone(),
                engine_set: card.engine_set,
                remaining: card.expires_at.saturating_duration_since(now),
            },
            (None, Some(_)) => AutoHighlightCard::Applying,
            (None, None) => AutoHighlightCard::None,
        };
        let mut candidates: Vec<AutoHighlightCandidate> = Vec::new();
        for highlight in &self.highlights {
            if let Some(candidate) = self.auto_candidate(
                &highlight.message_id,
                CohostAutoHighlightSource::Pick,
                highlight.highlight_type,
                highlight.score,
                now,
            ) {
                candidates.push(candidate);
            }
        }
        for question in &self.questions {
            if question.priority != CohostPriority::High {
                continue;
            }
            let Some(message_id) = question.message_ids.first() else {
                continue;
            };
            // A server pick of the same message already carries a real score.
            if candidates
                .iter()
                .any(|candidate| &candidate.message_id == message_id)
            {
                continue;
            }
            if let Some(candidate) = self.auto_candidate(
                message_id,
                CohostAutoHighlightSource::Question,
                CohostHighlightType::Question,
                AUTO_HIGHLIGHT_QUESTION_SCORE,
                now,
            ) {
                candidates.push(candidate);
            }
        }
        AutoHighlightInput {
            picks_enabled,
            voice_enabled,
            card,
            since_last_card_end: self
                .auto
                .last_card_end
                .map(|end| now.saturating_duration_since(end)),
            last_author: self.auto.last_author.clone(),
            recent_types: self.auto.recent_types.clone(),
            tension: self.mood_scores.map(|scores| scores.tension),
            candidates,
            voice_refreshed: voice.as_ref().is_some_and(|voice| {
                self.auto.voice_refreshed.as_deref() == Some(voice.message_id.as_str())
            }),
            voice,
            shown: self.auto.shown.clone(),
        }
    }

    /// Record a decision and turn it into the command the renderer executes.
    fn apply_auto_decision(
        &mut self,
        decision: AutoHighlightDecision,
        generation: u64,
        now: Instant,
    ) -> CohostAutoHighlight {
        if decision.refresh {
            self.auto.voice_refreshed = Some(decision.message_id.clone());
        }
        self.auto.requested = Some(PendingAutoRequest {
            message_id: decision.message_id.clone(),
            asked_at: now,
            refresh: decision.refresh,
        });
        self.auto.shown.insert(decision.message_id.clone());
        self.auto.last_author = Some(decision.author);
        if let Some(highlight_type) = decision.highlight_type {
            self.auto.recent_types.push(highlight_type);
            while self.auto.recent_types.len() > AUTO_HIGHLIGHT_TYPE_RUN {
                self.auto.recent_types.remove(0);
            }
        }
        let command = CohostAutoHighlight {
            generation,
            message_id: decision.message_id,
            source: decision.source,
            refresh: decision.refresh,
        };
        self.auto.latest = Some(command.clone());
        command
    }
}

/// The comment-highlight overlay as the automatic-card rules see it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct OverlayObservation {
    /// The message on stream right now (`phase == live`), else `None`.
    pub(crate) live_message_id: Option<String>,
    /// Time left on that card; zero when unknown.
    pub(crate) remaining: Duration,
}

impl OverlayObservation {
    pub(crate) fn from_highlight(highlight: &CommentHighlightState) -> Self {
        if highlight.phase != CommentHighlightPhase::Live {
            return Self::default();
        }
        let remaining = highlight
            .expires_at
            .as_deref()
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
            .and_then(|at| {
                (at.with_timezone(&chrono::Utc) - chrono::Utc::now())
                    .to_std()
                    .ok()
            })
            .unwrap_or_default();
        Self {
            live_message_id: highlight.message_id.clone(),
            remaining,
        }
    }
}

/// One message the automatic-card policy may put on stream, with every
/// safety fact read at fire time (a later tick can flag what an earlier one
/// suggested).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AutoHighlightCandidate {
    pub(crate) message_id: String,
    /// Platform-qualified author key.
    pub(crate) author: String,
    /// Normalised roles (`mod`, `owner`, `subscriber`, `member`, `vip`).
    pub(crate) roles: Vec<String>,
    pub(crate) source: CohostAutoHighlightSource,
    pub(crate) highlight_type: CohostHighlightType,
    /// Server score (Pick) or the question baseline; unused for Voice.
    pub(crate) score: f64,
    /// Since the engine noted the message.
    pub(crate) age: Duration,
    pub(crate) flagged: bool,
    pub(crate) flag_dismissed: bool,
    pub(crate) deleted: bool,
}

/// What is on stream when the policy runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AutoHighlightCard {
    None,
    /// The engine asked for a card the renderer has not set yet.
    Applying,
    Live {
        message_id: String,
        /// The engine asked for it (false: the streamer set it by hand).
        engine_set: bool,
        remaining: Duration,
    },
}

/// Plain input of `auto_highlight_pick`: everything the rules need, nothing
/// they must look up.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AutoHighlightInput {
    /// `settings.auto_highlight`: Pick and Question sources.
    pub(crate) picks_enabled: bool,
    /// `settings.voice_highlight`: the Voice source.
    pub(crate) voice_enabled: bool,
    pub(crate) card: AutoHighlightCard,
    /// Since the previous card (whoever set it) left the stream; `None` when
    /// no card has been on stream this session.
    pub(crate) since_last_card_end: Option<Duration>,
    /// Author key of the previous automatic card.
    pub(crate) last_author: Option<String>,
    /// Types of the recent automatic cards, oldest first.
    pub(crate) recent_types: Vec<CohostHighlightType>,
    /// `mood_scores.tension` from the latest tick.
    pub(crate) tension: Option<f64>,
    /// Pick and Question candidates.
    pub(crate) candidates: Vec<AutoHighlightCandidate>,
    /// The comment the streamer is talking about right now (source Voice).
    pub(crate) voice: Option<AutoHighlightCandidate>,
    /// The voice card already had its one refresh.
    pub(crate) voice_refreshed: bool,
    /// Message ids that were on stream this session.
    pub(crate) shown: HashSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AutoHighlightDecision {
    pub(crate) message_id: String,
    pub(crate) author: String,
    pub(crate) source: CohostAutoHighlightSource,
    /// `None` for a voice card: it takes no part in the type-run rule.
    pub(crate) highlight_type: Option<CohostHighlightType>,
    pub(crate) refresh: bool,
}

impl AutoHighlightDecision {
    fn show(candidate: &AutoHighlightCandidate, refresh: bool) -> Self {
        Self {
            message_id: candidate.message_id.clone(),
            author: candidate.author.clone(),
            source: candidate.source,
            highlight_type: (candidate.source != CohostAutoHighlightSource::Voice)
                .then_some(candidate.highlight_type),
            refresh,
        }
    }
}

/// D5: a small additive bonus, never a filter. The best role counts once.
fn auto_highlight_role_bonus(roles: &[String]) -> f64 {
    roles
        .iter()
        .map(|role| match role.as_str() {
            "member" | "subscriber" | "vip" => AUTO_HIGHLIGHT_ROLE_BONUS_MEMBER,
            "mod" => AUTO_HIGHLIGHT_ROLE_BONUS_MOD,
            _ => 0.0,
        })
        .fold(0.0, f64::max)
}

/// D6 at fire time: not flagged now, not flag-dismissed, not deleted, and
/// never the broadcaster's own message.
fn auto_highlight_safe(candidate: &AutoHighlightCandidate) -> bool {
    !candidate.flagged
        && !candidate.flag_dismissed
        && !candidate.deleted
        && !candidate.roles.iter().any(|role| role == "owner")
}

/// The type the last `AUTO_HIGHLIGHT_TYPE_RUN - 1` automatic cards all had.
fn auto_highlight_run_type(recent: &[CohostHighlightType]) -> Option<CohostHighlightType> {
    let run = AUTO_HIGHLIGHT_TYPE_RUN - 1;
    if recent.len() < run {
        return None;
    }
    let tail = &recent[recent.len() - run..];
    let last = *tail.last()?;
    tail.iter().all(|kind| *kind == last).then_some(last)
}

/// The automatic on-stream card policy, pure for the test matrix (plan 060,
/// D4, D5, D6, D10). At most one automatic card per `AUTO_HIGHLIGHT_COOLDOWN`
/// from the previous card's end; never while a card is live or applying;
/// never the previous automatic author; never older than
/// `AUTO_HIGHLIGHT_MAX_AGE`; not the same type three times in a row when an
/// alternative exists; never at tension >= 0.7; never the broadcaster; the
/// safety gate re-checked now; never a message already shown this session.
/// Voice bypasses the cooldown and the age rule, may refresh its own card
/// once while the match persists, and never replaces a card the streamer set
/// by hand. Ties: score desc, then oldest, then id.
pub(crate) fn auto_highlight_pick(input: &AutoHighlightInput) -> Option<AutoHighlightDecision> {
    if input
        .tension
        .is_some_and(|tension| tension >= AUTO_HIGHLIGHT_TENSION_CEILING)
    {
        return None;
    }
    let voice = input
        .voice
        .as_ref()
        .filter(|voice| input.voice_enabled && voice.source == CohostAutoHighlightSource::Voice);
    match &input.card {
        AutoHighlightCard::Applying => return None,
        AutoHighlightCard::Live {
            message_id,
            engine_set,
            remaining,
        } => {
            // The only thing allowed over a live card: one refresh of the
            // engine's own voice card while the same match persists.
            let voice = voice?;
            if !engine_set
                || voice.message_id != *message_id
                || input.voice_refreshed
                || *remaining > AUTO_HIGHLIGHT_VOICE_REFRESH_WINDOW
                || !auto_highlight_safe(voice)
            {
                return None;
            }
            return Some(AutoHighlightDecision::show(voice, true));
        }
        AutoHighlightCard::None => {}
    }
    let not_previous_author = |candidate: &AutoHighlightCandidate| {
        input.last_author.as_deref() != Some(candidate.author.as_str())
    };
    if let Some(voice) = voice.filter(|voice| {
        auto_highlight_safe(voice)
            && not_previous_author(voice)
            && !input.shown.contains(&voice.message_id)
    }) {
        return Some(AutoHighlightDecision::show(voice, false));
    }
    if !input.picks_enabled {
        return None;
    }
    if input
        .since_last_card_end
        .is_some_and(|since| since < AUTO_HIGHLIGHT_COOLDOWN)
    {
        return None;
    }
    let eligible: Vec<&AutoHighlightCandidate> = input
        .candidates
        .iter()
        .filter(|candidate| {
            candidate.source != CohostAutoHighlightSource::Voice
                && auto_highlight_safe(candidate)
                && not_previous_author(candidate)
                && candidate.age <= AUTO_HIGHLIGHT_MAX_AGE
                && !input.shown.contains(&candidate.message_id)
        })
        .collect();
    let pool: Vec<&AutoHighlightCandidate> = match auto_highlight_run_type(&input.recent_types) {
        Some(run)
            if eligible
                .iter()
                .any(|candidate| candidate.highlight_type != run) =>
        {
            eligible
                .into_iter()
                .filter(|candidate| candidate.highlight_type != run)
                .collect()
        }
        _ => eligible,
    };
    let effective = |candidate: &AutoHighlightCandidate| {
        candidate.score + auto_highlight_role_bonus(&candidate.roles)
    };
    pool.into_iter()
        .min_by(|a, b| {
            effective(b)
                .partial_cmp(&effective(a))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.age.cmp(&a.age))
                .then_with(|| a.message_id.cmp(&b.message_id))
        })
        .map(|candidate| AutoHighlightDecision::show(candidate, false))
}

/// Cadence rule, pure for the test matrix: tick when at least five new rows
/// arrived, or at least one arrived and 20 s passed since the anchor (last
/// tick, else engine start), or (v3, plan 068 D7) at least
/// `TICK_TRANSCRIPT_MIN_NEW_CHARS` of transcript arrived and 20 s passed since
/// the anchor even with an empty delta; never within 8 s of the previous
/// tick; never with nothing to send. Callers pass `transcript_chars` as 0
/// below v3.
pub(crate) fn tick_due(
    pending: usize,
    transcript_chars: usize,
    anchor: Instant,
    last_tick: Option<Instant>,
    now: Instant,
) -> bool {
    let speech_ready = transcript_chars >= TICK_TRANSCRIPT_MIN_NEW_CHARS;
    if pending == 0 && !speech_ready {
        return false;
    }
    if last_tick.is_some_and(|last| now.duration_since(last) < TICK_MIN_GAP) {
        return false;
    }
    if pending >= TICK_BURST_THRESHOLD {
        return true;
    }
    now.duration_since(anchor) >= TICK_IDLE_INTERVAL
}

/// The next version down the ladder after `current`, `None` at the bottom.
pub(crate) fn fallback_prompt_version(current: u32) -> Option<u32> {
    let index = COHOST_PROMPT_VERSION_LADDER
        .iter()
        .position(|version| *version == current)?;
    COHOST_PROMPT_VERSION_LADDER.get(index + 1).copied()
}

/// Whether a promise trigger is met (plan 068 D8): `viewers` at or above the
/// fresh total, `minutes` elapsed since first seen, and `none` (or an
/// unknown kind) `PROMISE_DEFAULT_REMINDER` after first seen.
pub(crate) fn promise_trigger_met(
    trigger: CohostPromiseTrigger,
    viewers: Option<u64>,
    elapsed: Duration,
) -> bool {
    match (trigger.kind, trigger.value) {
        (CohostPromiseTriggerKind::Viewers, Some(value)) => viewers.is_some_and(|v| v >= value),
        (CohostPromiseTriggerKind::Minutes, Some(value)) => {
            elapsed >= Duration::from_secs(value.saturating_mul(60))
        }
        _ => elapsed >= PROMISE_DEFAULT_REMINDER,
    }
}

/// The newest `max_units` UTF-16 code units of `value`, cut on a char
/// boundary (never a split code point or surrogate pair).
fn keep_newest_utf16(value: &str, max_units: usize) -> String {
    let mut units = 0;
    for (index, ch) in value.char_indices().rev() {
        units += ch.len_utf16();
        if units > max_units {
            return value[index + ch.len_utf8()..].to_string();
        }
    }
    value.to_string()
}

/// A recap draft from the summary: the first `max_units` UTF-16 code units,
/// cut at a word boundary (the last whitespace inside the cap), trimmed;
/// empty when the summary is.
pub(crate) fn recap_draft(summary: &str, max_units: usize) -> String {
    let summary = summary.split_whitespace().collect::<Vec<_>>().join(" ");
    let head = truncate_utf16(&summary, max_units);
    if head.len() == summary.len() {
        return summary;
    }
    // A word that ends exactly at the cap is whole: keep it.
    if summary[head.len()..].starts_with(char::is_whitespace) {
        return head.trim_end().to_string();
    }
    match head.rfind(char::is_whitespace) {
        Some(cut) if cut > 0 => head[..cut].trim_end().to_string(),
        _ => head.trim_end().to_string(),
    }
}

/// Spotlight cadence, pure for the test matrix (D7): a call goes out when the
/// transcript window changed since the last call, at least
/// `SPOTLIGHT_DEBOUNCE` after the latest final, at least `SPOTLIGHT_MIN_GAP`
/// after the previous call, never while one is outstanding, never while the
/// breaker holds the lane, never on an empty window.
pub(crate) fn spotlight_due(
    window: &TranscriptSnapshot,
    last_version: Option<u64>,
    last_call_at: Option<Instant>,
    in_flight: bool,
    off_until: Option<Instant>,
    now: Instant,
) -> bool {
    if in_flight || window.text.is_empty() {
        return false;
    }
    if off_until.is_some_and(|until| now < until) {
        return false;
    }
    if last_version == Some(window.version) {
        return false;
    }
    let Some(last_final) = window.last_final_at else {
        return false;
    };
    if now.saturating_duration_since(last_final) < SPOTLIGHT_DEBOUNCE {
        return false;
    }
    if last_call_at.is_some_and(|last| now.saturating_duration_since(last) < SPOTLIGHT_MIN_GAP) {
        return false;
    }
    true
}

/// Drop candidates from the end (the oldest plain messages go first, the
/// questions last) until the JSON body fits the server's byte budget. At
/// least one candidate always stays.
pub(crate) fn trim_spotlight_request_to_budget(
    request: &mut CohostSpotlightRequest,
    max_bytes: usize,
) {
    while request.candidates.len() > 1
        && serde_json::to_vec(request)
            .map(|body| body.len())
            .unwrap_or(0)
            > max_bytes
    {
        request.candidates.pop();
    }
}

fn priority_rank(priority: CohostPriority) -> u8 {
    match priority {
        CohostPriority::High => 0,
        CohostPriority::Normal => 1,
        CohostPriority::Low => 2,
        CohostPriority::Unknown => 3,
    }
}

/// Earliest instant the scheduler could send the next tick, pure for the test
/// matrix and `None` on an empty delta. The burst rule (>= 5 pending) fires as
/// soon as the 8 s min gap allows; the trickle rule fires at anchor + 20 s; a
/// backoff/quota `next_attempt_at` pushes both back. Never in the past.
pub(crate) fn next_tick_due_at(
    pending: usize,
    anchor: Instant,
    last_tick: Option<Instant>,
    next_attempt_at: Option<Instant>,
    now: Instant,
) -> Option<Instant> {
    if pending == 0 {
        return None;
    }
    let mut due = if pending >= TICK_BURST_THRESHOLD {
        now
    } else {
        anchor + TICK_IDLE_INTERVAL
    };
    if let Some(last) = last_tick {
        due = due.max(last + TICK_MIN_GAP);
    }
    if let Some(attempt) = next_attempt_at {
        due = due.max(attempt);
    }
    Some(due.max(now))
}

/// Wall-clock ISO-8601 for a monotonic instant `due` relative to `now`.
fn iso_after(now: Instant, due: Instant) -> String {
    let delta = chrono::Duration::from_std(due.saturating_duration_since(now))
        .unwrap_or_else(|_| chrono::Duration::zero());
    (chrono::Utc::now() + delta).to_rfc3339()
}

/// Emission bucket for `pending_messages`: `cohost.state` is pushed when the
/// bucket changes (0 -> 1, then every +5), never per message.
pub(crate) fn pending_bucket(pending: usize) -> usize {
    if pending == 0 {
        0
    } else {
        1 + (pending - 1) / 5
    }
}

/// Map one chat row onto the tick wire shape. Non-`message` events (paid,
/// membership, system, moderation), tombstones, and custom RTMP rows (no chat
/// platform) are excluded.
pub(crate) fn tick_message_from_chat(message: &LiveChatMessage) -> Option<CohostTickMessage> {
    if message.is_deleted || message.event_type != LiveChatEventType::Message {
        return None;
    }
    if message.platform == StreamPlatform::Custom {
        return None;
    }
    let text = truncate_utf16(
        tick_text_with_gifs(&message.message_text, &message.fragments).trim(),
        TICK_MESSAGE_TEXT_MAX_CHARS,
    );
    if text.is_empty() {
        return None;
    }
    let roles: Vec<String> = message
        .author_roles
        .iter()
        .filter_map(|role| normalize_role(role))
        .collect();
    Some(CohostTickMessage {
        id: message.id.clone(),
        platform: message.platform,
        author: message.author_name.clone(),
        roles: (!roles.is_empty()).then_some(roles),
        text,
        at: message.published_at.clone(),
        first_message: Some(message.first_message),
    })
}

/// What Golem reads for a message with Twitch GIFs (plan 155, D7). The raw
/// text is the GIPHY title in brackets (`[Y A Y Yes GIF]`), which reads as a
/// viewer's words. A GIF alone becomes `sent a GIF: <title>`; a GIF among
/// words becomes `(GIF: <title>)` in its place. Without a gif fragment the
/// text is returned as is.
pub(crate) fn tick_text_with_gifs(text: &str, fragments: &[LiveChatMessageFragment]) -> String {
    if !fragments
        .iter()
        .any(|fragment| fragment.fragment_type == "gif")
    {
        return text.to_string();
    }
    let only_gifs = fragments
        .iter()
        .all(|fragment| fragment.fragment_type == "gif" || fragment.text.trim().is_empty());
    if only_gifs {
        let titles: Vec<String> = fragments
            .iter()
            .filter(|fragment| fragment.fragment_type == "gif")
            .map(|fragment| gif_title(&fragment.text))
            .collect();
        return format!("sent a GIF: {}", titles.join(", "));
    }
    fragments
        .iter()
        .map(|fragment| {
            if fragment.fragment_type == "gif" {
                format!("(GIF: {})", gif_title(&fragment.text))
            } else {
                fragment.text.clone()
            }
        })
        .collect::<String>()
}

/// Who counts as one viewer for alert corroboration: the platform account when
/// the provider gave one, else the display name.
fn alert_author_key(message: &LiveChatMessage) -> String {
    let author = message
        .author_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| message.author_name.trim());
    format!(
        "{}:{author}",
        serde_json::to_string(&message.platform).unwrap_or_default()
    )
}

/// A wire probability clamped to 0..1; NaN/infinite reads as absent.
fn unit_interval(value: f64) -> Option<f64> {
    value.is_finite().then(|| value.clamp(0.0, 1.0))
}

fn normalize_role(role: &str) -> Option<String> {
    let normalized = match role.trim().to_ascii_lowercase().as_str() {
        "moderator" | "mod" => "mod",
        "broadcaster" | "owner" => "owner",
        "subscriber" => "subscriber",
        "member" | "founder" => "member",
        "vip" => "vip",
        _ => return None,
    };
    ALLOWED_ROLES
        .contains(&normalized)
        .then(|| normalized.to_string())
}

pub struct CohostEngine {
    settings: CohostSettings,
    generation: u64,
    session: Option<CohostSession>,
    scheduler: Option<JoinHandle<()>>,
    /// The spotlight lane's own poll loop (plan 060 S3): it shares the engine
    /// lock but never the tick's await, so a slow tick cannot delay it.
    spotlight_scheduler: Option<JoinHandle<()>>,
    /// Engine-wide counter for automatic-card commands: never repeats across
    /// sessions, so the renderer can key on it alone.
    auto_highlight_generation: u64,
    /// The voice-command kill switches as last read (plan 140 S3); `None`
    /// while both are on. Every state carries it, Golem running or not.
    command_availability: Option<CohostCommandAvailability>,
    /// The cloud command parser (plan 140 S8).
    command_parser: CommandParserLane,
}

impl CohostEngine {
    pub fn new(settings: CohostSettings) -> Self {
        // Plan 164 S-A7: the persona's name wakes the Golem from the start.
        crate::cohost_command::set_persona_wake_tokens(&settings.persona.name);
        Self {
            settings: settings.normalized(),
            generation: 0,
            session: None,
            scheduler: None,
            spotlight_scheduler: None,
            auto_highlight_generation: 0,
            command_availability: None,
            command_parser: CommandParserLane::default(),
        }
    }

    // --- Cloud command parser (plan 140 S8) ----------------------------------

    /// `features.cohostCommandEnabled` from the last capability read.
    pub(crate) fn set_command_parser_enabled(&mut self, enabled: bool) {
        self.command_parser.enabled = enabled;
    }

    /// Whether a parse may go out for `scope` now: the capability, Premium,
    /// the voice kill switch, Golem on with this session and its consent to
    /// process chat, nothing in flight, and the gap and any pause over.
    fn command_parser_ready(
        &self,
        scope: &CommandSession,
        premium: bool,
        voice_enabled: bool,
        now: Instant,
    ) -> bool {
        let lane = &self.command_parser;
        let in_flight = lane.in_flight
            && lane
                .last_call_at
                .is_some_and(|at| now.saturating_duration_since(at) < COMMAND_PARSE_IN_FLIGHT_MAX);
        lane.enabled
            && premium
            && voice_enabled
            && self.settings.enabled
            && !in_flight
            && lane.off_until.is_none_or(|until| now >= until)
            && lane
                .last_call_at
                .is_none_or(|at| now.saturating_duration_since(at) >= COMMAND_PARSE_MIN_GAP)
            && self.session.as_ref().is_some_and(|session| {
                session.session_id == scope.session_id
                    && session.generation == scope.generation
                    && session.consent
            })
    }

    /// The parse to send for `heard`, marked in flight; `None` when the
    /// parser may not run or nothing is left to send.
    fn prepare_command_parse(
        &mut self,
        scope: &CommandSession,
        heard: &str,
        on_stream: Option<&str>,
        premium: bool,
        voice_enabled: bool,
        now: Instant,
    ) -> Option<PreparedCommandParse> {
        if !self.command_parser_ready(scope, premium, voice_enabled, now) {
            return None;
        }
        let session = self.session.as_ref()?;
        let seq = self.command_parser.seq.saturating_add(1);
        let focus = session.command_parse_focus(on_stream, now);
        let mut candidates = session.command_parse_candidates();
        // An older focus rides along; shaping keeps it within the cap.
        if let Some(focus) = focus.as_deref()
            && !candidates.iter().any(|candidate| candidate.id == focus)
            && let Some(candidate) = session.command_parse_candidate(focus)
        {
            candidates.push(candidate);
        }
        let request = CohostCommandRequest::shaped(
            DESKTOP_CLIENT_VERSION,
            &session.session_id,
            seq,
            heard,
            focus.as_deref(),
            candidates,
        )?;
        let command_id = session
            .command
            .as_ref()
            .map(|record| record.wire.id.clone());
        self.command_parser.seq = seq;
        self.command_parser.in_flight = true;
        self.command_parser.last_call_at = Some(now);
        Some(PreparedCommandParse {
            request,
            command_id,
        })
    }

    /// Settle the lane after a parse; true when the answer still belongs to
    /// `scope` and no newer command was heard while it was out.
    fn finish_command_parse(
        &mut self,
        scope: &CommandSession,
        prepared: &PreparedCommandParse,
        result: &Result<CohostCommandResponse, CohostApiError>,
        now: Instant,
    ) -> bool {
        self.command_parser.in_flight = false;
        if let Err(error) = result
            && let Some(pause) = command_parse_pause(error)
        {
            self.command_parser.off_until = now.checked_add(pause);
        }
        self.session.as_ref().is_some_and(|session| {
            session.session_id == scope.session_id
                && session.generation == scope.generation
                && session.command.as_ref().map(|record| &record.wire.id)
                    == prepared.command_id.as_ref()
        })
    }

    pub fn settings(&self) -> &CohostSettings {
        &self.settings
    }

    pub fn snapshot(&self) -> CohostState {
        let mut state = self
            .session
            .as_ref()
            .map(CohostSession::snapshot)
            .unwrap_or_else(CohostState::off);
        state.command_availability = self.command_availability;
        state
    }

    /// True when the kill switches changed since the last read.
    fn set_command_availability(
        &mut self,
        availability: Option<CohostCommandAvailability>,
    ) -> bool {
        let changed = self.command_availability != availability;
        self.command_availability = availability;
        changed
    }

    /// What the detector must know without this lock: the wake-word setting,
    /// whether a card or a chooser waits, and the removal a boundary cancels.
    fn command_slot_mirror(&self) -> (DetectContext, Option<String>) {
        let record = self
            .session
            .as_ref()
            .and_then(|session| session.command.as_ref());
        let pending = record.map_or(CommandPending::None, |record| record.pending);
        (
            DetectContext {
                require_wake_word: self.settings.wake_word_required,
                awaiting_answer: matches!(
                    pending,
                    CommandPending::Removal | CommandPending::HighlightConfirm
                ),
                awaiting_choice: pending == CommandPending::Choice,
            },
            record
                .filter(|record| record.pending == CommandPending::Removal)
                .and_then(|record| record.wire.operation_id.clone()),
        )
    }

    /// The running session as a voice command's scope.
    fn current_command_scope(&self) -> Option<CommandSession> {
        self.session.as_ref().map(|session| CommandSession {
            session_id: session.session_id.clone(),
            generation: session.generation,
        })
    }

    /// The running session a command was heard for: same session, same
    /// generation (a consent change or a restart since makes it stale).
    fn command_session_mut(&mut self, scope: &CommandSession) -> Option<&mut CohostSession> {
        self.session.as_mut().filter(|session| {
            session.session_id == scope.session_id && session.generation == scope.generation
        })
    }

    /// Plan 140 S3: a new command for `scope`; `None` when its session is gone.
    fn begin_command(
        &mut self,
        scope: &CommandSession,
        command: NewCommand,
        ctx: &CommandContext,
    ) -> Option<CommandEffects> {
        let confirm_mode = self.settings.remove_confirm;
        let session = self.session.as_mut().filter(|session| {
            session.session_id == scope.session_id && session.generation == scope.generation
        })?;
        Some(session.begin_command(
            command,
            ctx,
            confirm_mode,
            &mut self.auto_highlight_generation,
        ))
    }

    /// Plan 140 S3: an answer to the open card of `scope`'s session.
    fn answer_command(
        &mut self,
        scope: &CommandSession,
        command_id: Option<&str>,
        answer: CommandAnswer,
        ctx: &CommandContext,
    ) -> Result<CommandEffects, CohostCommandError> {
        let confirm_mode = self.settings.remove_confirm;
        let Some(session) = self.session.as_mut().filter(|session| {
            session.session_id == scope.session_id && session.generation == scope.generation
        }) else {
            return Err(CohostCommandError::not_pending());
        };
        session.answer_command(
            command_id,
            answer,
            ctx,
            confirm_mode,
            &mut self.auto_highlight_generation,
        )
    }

    fn is_running_for(&self, session_id: &str) -> bool {
        self.session
            .as_ref()
            .is_some_and(|session| session.session_id == session_id)
    }

    /// Consent changes retire cloud work, not the chat session or its history.
    /// Return the replacement scheduler generation only when consent changed,
    /// with the voice removal its closed card was waiting on: the caller
    /// cancels it after the engine lock (`cancel_abandoned_removal`).
    fn update_consent(&mut self, consent: bool) -> Option<ConsentUpdate> {
        if self.session.as_ref()?.consent == consent {
            return None;
        }
        if let Some(handle) = self.scheduler.take() {
            handle.abort();
        }
        if let Some(handle) = self.spotlight_scheduler.take() {
            handle.abort();
        }
        self.generation = self.generation.wrapping_add(1);
        let session = self.session.as_mut()?;
        session.generation = self.generation;
        session.consent = consent;
        session.in_flight = false;
        session.discard_in_flight = false;
        // Keep the chat delta when its pending answer is retired. A later
        // grant can process it without losing messages or restarting history.
        for message in std::mem::take(&mut session.in_flight_messages)
            .into_iter()
            .rev()
        {
            session.pending.push_front(message);
        }
        session.dropped = session
            .dropped
            .saturating_add(std::mem::take(&mut session.in_flight_dropped));
        while session.pending.len() > TICK_DELTA_CAP {
            session.pending.pop_front();
            session.dropped = session.dropped.saturating_add(1);
        }
        session.in_flight_rules.clear();
        session.in_flight_transcript.clear();
        session.transcript_pending.clear();
        session.speech_version = None;
        session.speech_cursor = None;
        session.spotlight.in_flight = false;
        session.spotlight.last_version = None;
        session.spotlight.answered_streak.clear();
        session.spotlight.current = None;
        session.auto.latest = None;
        session.auto.requested = None;
        session.status = if consent {
            CohostStatus::Listening
        } else {
            CohostStatus::Paused
        };
        session.reason = (!consent).then_some(CohostReason::ConsentRequired);
        session.detail = None;
        session.next_attempt_at = None;
        // Plan 140 S3: listening restarts under the new consent; a card a
        // voice command opened closes with it, and the caller cancels its
        // removal.
        let abandoned_removal =
            session.abandon_command(COMMAND_STOPPED_LISTENING, &chrono::Utc::now().to_rfc3339());
        Some(ConsentUpdate {
            generation: self.generation,
            abandoned_removal,
        })
    }

    /// Begin a session at `now`. Returns the new generation the scheduler must
    /// own; a late response from any earlier generation is dropped.
    fn start_session(
        &mut self,
        session_id: String,
        consent: bool,
        stream_title: Option<String>,
        now: Instant,
    ) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.session = Some(CohostSession::new(
            session_id,
            self.generation,
            consent,
            stream_title,
            now,
        ));
        self.generation
    }

    /// End the session: abort its schedulers, retire its generation and hand
    /// back its report (plan 119 S1) for the caller to save once the engine
    /// lock is released. `None` when nothing was running.
    fn stop_session(&mut self) -> Option<CohostSessionReport> {
        if let Some(handle) = self.scheduler.take() {
            handle.abort();
        }
        if let Some(handle) = self.spotlight_scheduler.take() {
            handle.abort();
        }
        self.generation = self.generation.wrapping_add(1);
        let session = self.session.take()?;
        Some(session.report(&chrono::Utc::now().to_rfc3339()))
    }

    pub(crate) fn note_messages(&mut self, messages: &[LiveChatMessage]) -> usize {
        self.note_messages_at(messages, Instant::now())
    }

    fn note_messages_at(&mut self, messages: &[LiveChatMessage], now: Instant) -> usize {
        self.session
            .as_mut()
            .map(|session| session.note_messages(messages, now))
            .unwrap_or(0)
    }

    /// One scheduler pass of the automatic-card policy (plan 060 S1). The
    /// overlay is observed on every pass (so the ledger stays true while the
    /// setting is off); the pick runs only while listening with picks or
    /// voice enabled. The Voice source is the session's live spotlight (S3).
    /// Returns the new command when the engine decided.
    pub(crate) fn evaluate_auto_highlight(
        &mut self,
        generation: u64,
        overlay: &OverlayObservation,
        now: Instant,
    ) -> Option<CohostAutoHighlight> {
        let picks_enabled = self.settings.auto_highlight;
        let voice_enabled = self.settings.voice_highlight;
        let session = self.session.as_mut()?;
        if session.generation != generation {
            return None;
        }
        session.observe_overlay(overlay, now);
        if session.status != CohostStatus::Listening || !(picks_enabled || voice_enabled) {
            return None;
        }
        let voice = session
            .spotlight_message_id(now)
            .map(str::to_string)
            .and_then(|message_id| {
                session.auto_candidate(
                    &message_id,
                    CohostAutoHighlightSource::Voice,
                    CohostHighlightType::Other,
                    0.0,
                    now,
                )
            });
        let input = session.auto_highlight_input(picks_enabled, voice_enabled, voice, now);
        let decision = auto_highlight_pick(&input)?;
        self.auto_highlight_generation = self.auto_highlight_generation.wrapping_add(1).max(1);
        Some(session.apply_auto_decision(decision, self.auto_highlight_generation, now))
    }

    #[cfg(test)]
    fn snapshot_at_for_test(&self, now: Instant) -> CohostState {
        let mut state = self
            .session
            .as_ref()
            .map(|session| session.snapshot_at(now))
            .unwrap_or_else(CohostState::off);
        state.command_availability = self.command_availability;
        state
    }

    /// Messages buffered for the next tick (0 without a session).
    pub(crate) fn pending_len(&self) -> usize {
        self.session
            .as_ref()
            .map(|session| session.pending.len())
            .unwrap_or(0)
    }

    fn highlights_len(&self) -> usize {
        self.session
            .as_ref()
            .map(|session| session.highlights.len())
            .unwrap_or(0)
    }

    fn has_spotlight(&self) -> bool {
        self.session
            .as_ref()
            .is_some_and(|session| session.spotlight.current.is_some())
    }

    /// One pass of the spotlight lane (plan 060 S3, D7). Same run
    /// preconditions as the tick (enabled, Premium, consent, signed in) but a
    /// silent `Idle` instead of a paused reason: the tick owns the pause and
    /// its copy. Sends only while listening, on the lane's own cadence, with
    /// at least one candidate.
    pub(crate) fn prepare_spotlight(
        &mut self,
        generation: u64,
        signed_in: bool,
        premium: bool,
        transcript: &TranscriptSnapshot,
        now: Instant,
    ) -> SpotlightPass {
        if !self.settings.enabled {
            return SpotlightPass::Stopped;
        }
        let Some(session) = self.session.as_mut() else {
            return SpotlightPass::Stopped;
        };
        if session.generation != generation {
            return SpotlightPass::Stopped;
        }
        if session.status != CohostStatus::Listening || !premium || !session.consent || !signed_in {
            return SpotlightPass::Idle;
        }
        if !spotlight_due(
            transcript,
            session.spotlight.last_version,
            session.spotlight.last_call_at,
            session.spotlight.in_flight,
            session.spotlight.off_until,
            now,
        ) {
            return SpotlightPass::Idle;
        }
        let candidates = session.spotlight_candidates(now);
        if candidates.is_empty() {
            return SpotlightPass::Idle;
        }
        SpotlightPass::Send(PreparedSpotlight {
            request: session.build_spotlight_request(transcript, candidates, now),
            generation,
        })
    }

    /// Merge a spotlight outcome. `None` (and nothing changes) when the
    /// answer belongs to a replaced session or generation.
    pub(crate) fn apply_spotlight_result(
        &mut self,
        generation: u64,
        result: Result<CohostSpotlightResponse, CohostApiError>,
        now: Instant,
        now_iso: &str,
    ) -> Option<SpotlightOutcome> {
        let session = self.session.as_mut()?;
        if session.generation != generation {
            return None;
        }
        Some(match result {
            Ok(response) => session.apply_spotlight_response(response, now, now_iso),
            Err(error) => session.apply_spotlight_failure(&error, now),
        })
    }

    /// Drop an expired spotlight; true when the state just changed.
    pub(crate) fn expire_spotlight(&mut self, generation: u64, now: Instant) -> bool {
        self.session
            .as_mut()
            .filter(|session| session.generation == generation)
            .is_some_and(|session| session.expire_spotlight(now))
    }

    fn restore_question(
        &mut self,
        session_id: &str,
        question_id: &str,
        now: Instant,
    ) -> Result<bool, CohostError> {
        let Some(session) = self.session.as_mut() else {
            return Err(CohostError::SessionMismatch);
        };
        if session.session_id != session_id {
            return Err(CohostError::SessionMismatch);
        }
        Ok(session.restore_question(question_id, now))
    }

    /// Decide whether the scheduler owning `generation` should send a tick now.
    /// `signed_in`, `premium`, and the session's consent are the run
    /// preconditions; each maps to a paused reason rather than a request.
    pub(crate) fn prepare_tick(
        &mut self,
        generation: u64,
        signed_in: bool,
        premium: bool,
        now: Instant,
    ) -> Result<PreparedTick, TickGate> {
        if !self.settings.enabled {
            return Err(TickGate::Stopped);
        }
        let settings = self.settings.clone();
        let Some(session) = self.session.as_mut() else {
            return Err(TickGate::Stopped);
        };
        if session.generation != generation {
            return Err(TickGate::Stopped);
        }
        if session.in_flight || session.next_attempt_at.is_some_and(|at| now < at) {
            return Err(TickGate::Idle);
        }
        let precondition = if !premium {
            Some(CohostReason::PremiumRequired)
        } else if !session.consent {
            Some(CohostReason::ConsentRequired)
        } else if !signed_in {
            Some(CohostReason::SignedOut)
        } else {
            None
        };
        if let Some(reason) = precondition {
            return Err(if session.pause(reason, now) {
                TickGate::Paused(reason)
            } else {
                TickGate::Idle
            });
        }
        if !session.tick_due(now) {
            return Err(TickGate::Idle);
        }
        Ok(PreparedTick {
            request: session.build_request(&settings, now),
            generation,
        })
    }

    /// Merge a tick outcome. Returns false (and changes nothing) when the
    /// response belongs to a replaced session or generation.
    pub(crate) fn apply_tick_result(
        &mut self,
        generation: u64,
        dropped: u64,
        result: Result<CohostTickResponse, CohostApiError>,
        now: Instant,
        now_iso: &str,
    ) -> bool {
        let Some(session) = self.session.as_mut() else {
            return false;
        };
        if session.generation != generation {
            return false;
        }
        if std::mem::take(&mut session.discard_in_flight) {
            session.in_flight = false;
            session.in_flight_messages.clear();
            session.in_flight_dropped = 0;
            session.in_flight_rules.clear();
            session.in_flight_transcript.clear();
            return true;
        }
        match result {
            Ok(response) => session.apply_response(response, dropped, now, now_iso),
            Err(error) => session.apply_failure(&error, now),
        }
        true
    }

    fn mark_answered(&mut self, session_id: &str, question_id: &str) -> Result<bool, CohostError> {
        Ok(self.session_for_mut(session_id)?.mark_answered(question_id))
    }

    /// `cohost.question.dismiss`: the same engine outcome as answered, counted
    /// apart in the report.
    fn dismiss_question(
        &mut self,
        session_id: &str,
        question_id: &str,
    ) -> Result<bool, CohostError> {
        Ok(self
            .session_for_mut(session_id)?
            .dismiss_question(question_id))
    }

    /// The recent-speech version the running session (of `generation`) last
    /// folded in; `None` when that session is gone.
    pub(crate) fn seen_speech_version(&self, generation: u64) -> Option<Option<u64>> {
        self.session
            .as_ref()
            .filter(|session| session.generation == generation)
            .map(|session| session.speech_version)
    }

    /// Fold new transcript finals into the running session's pending
    /// transcript. Returns the chars added (0 for a replaced session).
    pub(crate) fn note_speech(
        &mut self,
        generation: u64,
        snapshot: &RecentSpeechSnapshot,
    ) -> usize {
        match self.session.as_mut() {
            Some(session) if session.generation == generation => session.note_speech(snapshot),
            _ => 0,
        }
    }

    /// One pass over the promise triggers (plan 068 D8). True when a reminder
    /// fired and the state changed.
    pub(crate) fn check_promises(
        &mut self,
        generation: u64,
        viewers: Option<u64>,
        now: Instant,
        now_iso: &str,
    ) -> bool {
        match self.session.as_mut() {
            Some(session) if session.generation == generation => {
                session.check_promises(viewers, now, now_iso)
            }
            _ => false,
        }
    }

    /// One pass of "Say hi" and the dead-air nudge (plan 068 D9).
    pub(crate) fn refresh_acknowledgement(
        &mut self,
        generation: u64,
        voice: VoiceActivity,
        now: Instant,
        now_iso: &str,
    ) -> AcknowledgementPass {
        match self.session.as_mut() {
            Some(session) if session.generation == generation => {
                session.refresh_acknowledgement(voice, now, now_iso)
            }
            _ => AcknowledgementPass::default(),
        }
    }

    /// Greeting lines queued since the last call, for the backend log.
    pub(crate) fn take_greeting_log(&mut self) -> Vec<String> {
        self.session
            .as_mut()
            .map(|session| session.ledger.take_log())
            .unwrap_or_default()
    }

    fn mark_author_greeted(
        &mut self,
        session_id: &str,
        author_key: &str,
        now: Instant,
    ) -> Result<bool, CohostError> {
        Ok(self
            .session_for_mut(session_id)?
            .ledger
            .greet(author_key, GreetedHow::Manual, now))
    }

    fn note_own_send(&mut self, session_id: &str, text: &str, now: Instant) {
        if let Ok(session) = self.session_for_mut(session_id) {
            session.ledger.note_own_send(text, now);
        }
    }

    fn own_send_delivered(
        &mut self,
        session_id: &str,
        text: &str,
        question_id: Option<&str>,
        now: Instant,
    ) -> bool {
        self.session_for_mut(session_id)
            .is_ok_and(|session| session.own_send_delivered(text, question_id, now))
    }

    fn session_for_mut(&mut self, session_id: &str) -> Result<&mut CohostSession, CohostError> {
        match self.session.as_mut() {
            Some(session) if session.session_id == session_id => Ok(session),
            _ => Err(CohostError::SessionMismatch),
        }
    }

    fn close_promise(
        &mut self,
        session_id: &str,
        promise_id: &str,
        kept: bool,
    ) -> Result<bool, CohostError> {
        Ok(self
            .session_for_mut(session_id)?
            .close_promise(promise_id, kept))
    }

    fn dismiss_recap(&mut self, session_id: &str, now: Instant) -> Result<bool, CohostError> {
        Ok(self.session_for_mut(session_id)?.dismiss_recap(now))
    }

    fn draft_recap(
        &mut self,
        session_id: &str,
        now: Instant,
        now_iso: &str,
    ) -> Result<(), CohostError> {
        self.session_for_mut(session_id)?.draft_recap(now, now_iso)
    }

    fn dismiss_flag(&mut self, session_id: &str, message_id: &str) -> Result<bool, CohostError> {
        let Some(session) = self.session.as_mut() else {
            return Err(CohostError::SessionMismatch);
        };
        if session.session_id != session_id {
            return Err(CohostError::SessionMismatch);
        }
        Ok(session.dismiss_flag(message_id))
    }

    fn resolve_flag(&mut self, session_id: &str, message_id: &str) -> Result<bool, CohostError> {
        let Some(session) = self.session.as_mut() else {
            return Err(CohostError::SessionMismatch);
        };
        if session.session_id != session_id {
            return Err(CohostError::SessionMismatch);
        }
        Ok(session.resolve_flag(message_id))
    }
}

// --- AppState integration ------------------------------------------------------------

fn emit_state(state: &AppState, snapshot: &CohostState, _lifecycle_delivery: &OwnedMutexGuard<()>) {
    state.emit_event(COHOST_STATE_EVENT, snapshot.clone());
}

/// Caption-coordinator hook (plan 060 S3): a settled caption joins the
/// transcript window. Finals only — a partial is replaced by its final. Lock,
/// append, return: no await, no engine lock, nothing the audio path waits on.
pub(crate) fn note_caption_final(state: &AppState, update: &CaptionsUpdate) {
    if update.kind != CaptionUpdateKind::Final {
        return;
    }
    if let Ok(mut window) = state.cohost_transcript.lock() {
        window.push(&update.text, Instant::now());
    }
}

/// Golem learns a transcript final only when the caption coordinator still
/// owns its admitted speech epoch. Caption callbacks route clip marks through
/// their immutable recording owner independently, before this admission gate.
/// The caller checks ownership and calls this synchronously under that lock;
/// a consent boundary cannot land between the check and the append.
pub(crate) fn note_transcript_final(
    state: &AppState,
    update: &CaptionsUpdate,
    final_: RecentSpeechFinal,
    orcle_owned: bool,
) {
    if final_.text.trim().is_empty() {
        return;
    }
    if !orcle_owned {
        return;
    }
    note_caption_final(state, update);
    let heard = detect_voice_command(state, update, &final_);
    if let Ok(mut speech) = state.cohost_recent_speech.lock() {
        speech.push(final_);
    }
    if let Some((session, command)) = heard {
        dispatch_detected_command(state.clone(), session, command);
    }
}

/// Plan 140 S2: the pure command detector reads the final while a Golem
/// session is armed (`arm_command_detector`). Std mutex, no await: the
/// caption task observes and returns, like the buffers above. The context
/// (the wake-word setting, an open card or chooser) is the engine's mirror
/// (`mirror_command_slot`), so no engine lock is needed here.
fn detect_voice_command(
    state: &AppState,
    update: &CaptionsUpdate,
    final_: &RecentSpeechFinal,
) -> Option<(CommandSession, DetectedCommand)> {
    // Contract part D: `voiceCommands: false` stops command detection.
    if !crate::service_flags::orcle_voice_commands_enabled(state) {
        return None;
    }
    let mut commands = state.cohost_commands.lock().ok()?;
    let session = commands.session.clone()?;
    let context = commands.context;
    let command = commands.detector.observe_final(
        &update.session_client_id,
        update.seq,
        &final_.text,
        final_.at,
        &context,
    )?;
    Some((session, command))
}

/// Plan 140: a detected command leaves the caption path at once and runs on
/// its own task, never inline in `note_transcript_final` and never on the
/// tick pass, which can wait 12 s. The gates (Premium, the kill switches,
/// the session generation) are checked again when it runs.
pub(crate) fn dispatch_detected_command(
    state: AppState,
    session: CommandSession,
    command: DetectedCommand,
) {
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        tracing::warn!(
            "Heard a Golem command ({}) but no runtime is available to run it.",
            command.kind.label()
        );
        return;
    };
    handle.spawn(async move {
        run_detected_command(&state, &session, command, premium_entitled()).await;
    });
}

/// Plan 140 S2: voice commands are heard for this engine session only. Armed
/// when a session starts, or hears again after sign-in; `clear_transcript`
/// disarms it on every stop and at sign-out. Nothing waits for an answer in
/// a session that just (re)started.
fn arm_command_detector(
    state: &AppState,
    session_id: &str,
    generation: u64,
    require_wake_word: bool,
) {
    if let Ok(mut commands) = state.cohost_commands.lock() {
        commands.detector.clear();
        commands.session = Some(CommandSession {
            session_id: session_id.to_string(),
            generation,
        });
        commands.context = DetectContext {
            require_wake_word,
            awaiting_answer: false,
            awaiting_choice: false,
        };
    }
}

/// A session boundary forgets what was said: the next session's spotlight
/// never sees the previous stream's words, and no half-said voice command
/// completes across it. A voice removal still waiting for an answer is
/// cancelled (plan 140 S3): every stop, replacing start, consent change and
/// sign-out passes here, and none of them may leave a removal to run later.
fn clear_transcript(state: &AppState) {
    if let Ok(mut window) = state.cohost_transcript.lock() {
        window.clear();
    }
    if let Ok(mut speech) = state.cohost_recent_speech.lock() {
        speech.clear();
    }
    let pending_operation = match state.cohost_commands.lock() {
        Ok(mut commands) => {
            commands.detector.clear();
            commands.session = None;
            commands.context.awaiting_answer = false;
            commands.context.awaiting_choice = false;
            commands.pending_operation.take()
        }
        Err(_) => None,
    };
    if let Some(operation_id) = pending_operation
        && let Ok(handle) = tokio::runtime::Handle::try_current()
    {
        let state = state.clone();
        handle.spawn(async move {
            if let Err(refusal) = crate::live_chat_moderation::cancel(&state, &operation_id).await {
                tracing::debug!(
                    "A Golem removal was no longer pending at a session boundary: {refusal}"
                );
            }
        });
    }
}

/// Mirror what the detector must know into its slot (plan 140 S3). Called
/// under the engine lock after every command change, so the mirror never
/// trails a newer change; the caption task reads it without that lock.
fn mirror_command_slot(state: &AppState, engine: &CohostEngine) {
    // Plan 164 S-A7: the wake words follow the persona's name on every
    // settings change, for the detector and the marker grammar alike.
    crate::cohost_command::set_persona_wake_tokens(&engine.settings.persona.name);
    let (context, pending_operation) = engine.command_slot_mirror();
    if let Ok(mut commands) = state.cohost_commands.lock() {
        commands.context = context;
        commands.pending_operation = pending_operation;
    }
}

/// The voice-command kill switches as they are now (contract part D).
fn command_availability_now(state: &AppState) -> Option<CohostCommandAvailability> {
    command_availability(
        crate::service_flags::orcle_voice_commands_enabled(state),
        crate::service_flags::orcle_remove_enabled(state),
    )
}

/// The engine's snapshot with the kill switches as they are now.
async fn fresh_snapshot(state: &AppState) -> CohostState {
    let availability = command_availability_now(state);
    let mut engine = state.cohost.lock().await;
    engine.set_command_availability(availability);
    engine.snapshot()
}

/// The comment on stream right now, if any.
async fn live_card_message_id(state: &AppState) -> Option<String> {
    let highlight = state.comment_highlight.lock().await;
    (highlight.phase == CommentHighlightPhase::Live)
        .then(|| highlight.message_id.clone())
        .flatten()
}

/// Everything a command step reads before the engine lock.
async fn command_context(state: &AppState, premium: bool) -> CommandContext {
    CommandContext {
        premium,
        voice_enabled: crate::service_flags::orcle_voice_commands_enabled(state),
        remove_enabled: crate::service_flags::orcle_remove_enabled(state),
        on_stream: live_card_message_id(state).await,
        now: Instant::now(),
        now_utc: chrono::Utc::now(),
    }
}

/// One heard command, on its own task (plan 140 S3). Answers (yes, no, the
/// first one) go to the open card; a new command replaces it.
async fn run_detected_command(
    state: &AppState,
    scope: &CommandSession,
    command: DetectedCommand,
    premium: bool,
) {
    tracing::info!(
        session_id = %scope.session_id,
        generation = scope.generation,
        kind = %command.kind.label(),
        target = %command.target.describe(),
        question = command.question,
        reason = command.reason.as_deref().unwrap_or("none"),
        wake_word = command.wake_word,
        "Golem heard a command: '{}'.",
        command.heard
    );
    let intent = match command.kind {
        CommandKind::Confirm => {
            return answer_by_voice(state, scope, CommandAnswer::Confirm, premium).await;
        }
        CommandKind::Cancel => {
            return answer_by_voice(state, scope, CommandAnswer::Cancel, premium).await;
        }
        CommandKind::Choose(index) => {
            return answer_by_voice(state, scope, CommandAnswer::Choose(index), premium).await;
        }
        CommandKind::Unknown => {
            // Only a clearly addressed "Golem" earns a reply.
            if !command.wake_word {
                return;
            }
            let resolution = resolve_unknown_command(state, scope, &command.heard, premium).await;
            return match resolution {
                UnknownCommandResolution::Resolved(kind, message_ids) => {
                    execute_resolved_command(
                        state,
                        scope,
                        kind,
                        message_ids,
                        command.heard,
                        command.reason,
                    )
                    .await
                }
                UnknownCommandResolution::Unheard => {
                    note_unheard_command(state, scope, &command.heard, premium).await
                }
                UnknownCommandResolution::Superseded => {
                    tracing::info!(
                        "Golem dropped a parsed command: a newer command or session came first."
                    );
                }
            };
        }
        CommandKind::Highlight => CommandIntent::Highlight,
        CommandKind::Clear => CommandIntent::Clear,
        CommandKind::Remove => CommandIntent::Remove,
    };
    run_new_command(
        state,
        scope,
        NewCommand {
            intent,
            spec: CommandTargetSpec::Spoken {
                target: command.target,
                question: command.question,
            },
            heard: command.heard,
            reason: command.reason,
            wake_word: command.wake_word,
        },
        premium,
    )
    .await;
}

/// Plan 140 S8: every wake-word utterance the local grammar could not read
/// is offered to the cloud command parser first, when the web enabled it
/// (`features.cohostCommandEnabled`), on Premium, with the voice kill switch
/// on, a Golem session for `scope` and its consent to process chat. One
/// call at most, never retried, on this command's own task with no lock
/// held across it. Any failure, timeout or doubt is "didn't catch that".
async fn resolve_unknown_command(
    state: &AppState,
    scope: &CommandSession,
    heard: &str,
    premium: bool,
) -> UnknownCommandResolution {
    resolve_unknown_command_with(
        state,
        scope,
        heard,
        premium,
        crate::account::stored_session_token,
        |token: String, request: CohostCommandRequest| async move {
            match VideorcApiClient::new() {
                Ok(client) => client.post_cohost_command(&token, &request).await,
                Err(error) => Err(CohostApiError::network(error.to_string())),
            }
        },
    )
    .await
}

/// `resolve_unknown_command` with the token read and the call injected.
/// Nothing, not even the stored token, is read while the parser may not run.
async fn resolve_unknown_command_with<T, C, F>(
    state: &AppState,
    scope: &CommandSession,
    heard: &str,
    premium: bool,
    token: T,
    call: C,
) -> UnknownCommandResolution
where
    T: FnOnce() -> Option<String>,
    C: FnOnce(String, CohostCommandRequest) -> F,
    F: std::future::Future<Output = Result<CohostCommandResponse, CohostApiError>>,
{
    let voice_enabled = crate::service_flags::orcle_voice_commands_enabled(state);
    let ready = {
        let engine = state.cohost.lock().await;
        engine.command_parser_ready(scope, premium, voice_enabled, Instant::now())
    };
    if !ready {
        return UnknownCommandResolution::Unheard;
    }
    let Some(token) = token() else {
        return UnknownCommandResolution::Unheard;
    };
    let on_stream = live_card_message_id(state).await;
    let prepared = {
        let mut engine = state.cohost.lock().await;
        engine.prepare_command_parse(
            scope,
            heard,
            on_stream.as_deref(),
            premium,
            voice_enabled,
            Instant::now(),
        )
    };
    let Some(prepared) = prepared else {
        return UnknownCommandResolution::Unheard;
    };
    let result = call(token, prepared.request.clone()).await;
    let current = {
        let mut engine = state.cohost.lock().await;
        engine.finish_command_parse(scope, &prepared, &result, Instant::now())
    };
    let response = match result {
        Ok(response) => response,
        Err(error) => {
            tracing::info!(
                code = %error.detail.code,
                status = ?error.detail.status,
                "Golem's command parser failed: {}",
                error.message()
            );
            return if current {
                UnknownCommandResolution::Unheard
            } else {
                UnknownCommandResolution::Superseded
            };
        }
    };
    if !current {
        return UnknownCommandResolution::Superseded;
    }
    match interpret_command_parse(&prepared.request, &response) {
        Some((kind, message_ids)) => {
            tracing::info!(
                kind = %kind.label(),
                targets = message_ids.len(),
                "Golem's command parser read '{heard}'."
            );
            UnknownCommandResolution::Resolved(kind, message_ids)
        }
        None => {
            tracing::info!(
                choice = %response.intent.choice,
                "Golem's command parser was not sure enough about '{heard}'."
            );
            UnknownCommandResolution::Unheard
        }
    }
}

/// Plan 140 S8, the desktop's thresholds over one parser answer (pure). The
/// intent acts at `COMMAND_PARSE_INTENT_THRESHOLD` and never as `none`; a
/// clear needs no comment. A highlight or a removal takes the comments the
/// request sent at `COMMAND_PARSE_TARGET_THRESHOLD` or more, likeliest first
/// (ties in answer order), at most a chooser's worth: one acts, several
/// open the chooser, none is "didn't catch that". An answer for another
/// `seq` is ignored.
pub(crate) fn interpret_command_parse(
    request: &CohostCommandRequest,
    response: &CohostCommandResponse,
) -> Option<(CommandKind, Vec<String>)> {
    if response.seq != request.seq {
        return None;
    }
    let choice = response.intent.choice.trim();
    let kind = match choice {
        "highlight" => CommandKind::Highlight,
        "remove" => CommandKind::Remove,
        "clear" => CommandKind::Clear,
        _ => return None,
    };
    let confidence = response.intent.probabilities.of(choice);
    if !(confidence.is_finite() && confidence >= COMMAND_PARSE_INTENT_THRESHOLD) {
        return None;
    }
    if kind == CommandKind::Clear {
        return Some((kind, Vec::new()));
    }
    let mut targets: Vec<(&str, f64)> = Vec::new();
    for target in &response.targets {
        let id = target.message_id.as_str();
        let likely =
            target.probability.is_finite() && target.probability >= COMMAND_PARSE_TARGET_THRESHOLD;
        let sent = request
            .candidates
            .iter()
            .any(|candidate| candidate.id == id);
        if likely && sent && !targets.iter().any(|(seen, _)| *seen == id) {
            targets.push((id, target.probability));
        }
    }
    if targets.is_empty() {
        return None;
    }
    targets.sort_by(|a, b| b.1.total_cmp(&a.1));
    targets.truncate(COMMAND_CANDIDATES_CAP);
    Some((
        kind,
        targets.into_iter().map(|(id, _)| id.to_string()).collect(),
    ))
}

/// How long one failed parse pauses the parser: a 429 until `Retry-After`,
/// an unavailable route or account for a while; a slow or broken answer not
/// at all (the 3 s gap still applies).
fn command_parse_pause(error: &CohostApiError) -> Option<Duration> {
    let pause = match &error.kind {
        CohostApiErrorKind::QuotaExhausted { retry_after } => {
            (*retry_after).unwrap_or(COMMAND_PARSE_QUOTA_PAUSE)
        }
        CohostApiErrorKind::ServerUnconfigured
        | CohostApiErrorKind::PremiumRequired
        | CohostApiErrorKind::Unauthorized
        | CohostApiErrorKind::ConsentRequired
        | CohostApiErrorKind::PromptVersionUnsupported => COMMAND_PARSE_UNAVAILABLE_PAUSE,
        CohostApiErrorKind::InvalidRequest
        | CohostApiErrorKind::GatewayError
        | CohostApiErrorKind::Network
        | CohostApiErrorKind::MalformedResponse => return None,
    };
    Some(pause.min(COMMAND_PARSE_MAX_PAUSE))
}

/// The capability read (`GET /api/ai/capabilities`, at launch, sign-in and
/// every entitlement refresh) turns the cloud command parser on or off.
pub(crate) async fn set_command_parser_capability(state: &AppState, enabled: bool) {
    state
        .cohost
        .lock()
        .await
        .set_command_parser_enabled(enabled);
}

/// Run a command whose target is already known as message ids (plan 140
/// S8's cloud parser). One eligible id acts (a highlight, or a removal card),
/// several open the chooser (at most three), none says "couldn't find".
/// Every gate applies, as for a spoken command.
pub(crate) async fn execute_resolved_command(
    state: &AppState,
    session: &CommandSession,
    kind: CommandKind,
    target_message_ids: Vec<String>,
    heard: String,
    reason: Option<String>,
) {
    let intent = match kind {
        CommandKind::Highlight => CommandIntent::Highlight,
        CommandKind::Clear => CommandIntent::Clear,
        CommandKind::Remove => CommandIntent::Remove,
        CommandKind::Confirm
        | CommandKind::Cancel
        | CommandKind::Choose(_)
        | CommandKind::Unknown => {
            return;
        }
    };
    run_new_command(
        state,
        session,
        NewCommand {
            intent,
            spec: CommandTargetSpec::Resolved(target_message_ids),
            heard,
            reason,
            // Heard through the wake word, but the cloud parser picked the
            // target: `countdown_allowed` is false either way.
            wake_word: true,
        },
        premium_entitled(),
    )
    .await;
}

/// A new command: decide under the engine lock, act after it.
async fn run_new_command(
    state: &AppState,
    scope: &CommandSession,
    command: NewCommand,
    premium: bool,
) {
    let ctx = command_context(state, premium).await;
    let effects = {
        let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
        let (effects, snapshot) = {
            let mut engine = state.cohost.lock().await;
            engine.set_command_availability(ctx.availability());
            let Some(effects) = engine.begin_command(scope, command, &ctx) else {
                tracing::info!("Golem dropped a voice command: its session changed.");
                return;
            };
            mirror_command_slot(state, &engine);
            // A removal card shows once chat moderation opened it
            // (`request_command_removal`), with its operation.
            let snapshot =
                (effects.emit && effects.request_removal.is_none()).then(|| engine.snapshot());
            (effects, snapshot)
        };
        if let Some(snapshot) = snapshot {
            emit_state(state, &snapshot, &lifecycle_delivery);
        }
        effects
    };
    run_command_effects(state, scope, effects, false).await;
}

/// A voice answer. Answers are never deduped by the detector, so one that
/// finds nothing waiting is dropped here.
async fn answer_by_voice(
    state: &AppState,
    scope: &CommandSession,
    answer: CommandAnswer,
    premium: bool,
) {
    if let Err(error) = answer_command_with(state, Some(scope), None, answer, premium, false).await
    {
        tracing::debug!(
            code = error.code,
            "Golem dropped a voice answer: {}",
            error.message
        );
    }
}

/// An answer to the open card, by voice (`voice_scope`) or by RPC
/// (`command_id`). A yes to a removal runs it after the lock; the RPC path
/// does that in the background (`background_confirm`), since the platform
/// can take up to about 16 s.
async fn answer_command_with(
    state: &AppState,
    voice_scope: Option<&CommandSession>,
    command_id: Option<&str>,
    answer: CommandAnswer,
    premium: bool,
    background_confirm: bool,
) -> Result<CohostState, CohostCommandError> {
    let ctx = command_context(state, premium).await;
    let (scope, effects) = {
        let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
        let (scope, effects, snapshot) = {
            let mut engine = state.cohost.lock().await;
            engine.set_command_availability(ctx.availability());
            let scope = match voice_scope {
                Some(scope) => scope.clone(),
                None => engine
                    .current_command_scope()
                    .ok_or_else(CohostCommandError::not_pending)?,
            };
            let effects = engine.answer_command(&scope, command_id, answer, &ctx)?;
            mirror_command_slot(state, &engine);
            // A pick that opens a removal card shows once chat moderation
            // opened it, with its operation (`request_command_removal`).
            let snapshot =
                (effects.emit && effects.request_removal.is_none()).then(|| engine.snapshot());
            (scope, effects, snapshot)
        };
        if let Some(snapshot) = snapshot {
            emit_state(state, &snapshot, &lifecycle_delivery);
        }
        (scope, effects)
    };
    run_command_effects(state, &scope, effects, background_confirm).await;
    Ok(fresh_snapshot(state).await)
}

/// The work a command step left for after the engine lock: never under it.
async fn run_command_effects(
    state: &AppState,
    scope: &CommandSession,
    effects: CommandEffects,
    background_confirm: bool,
) {
    // Replaced removals first: a new request for the same comment would
    // otherwise find the old one still pending.
    for operation_id in &effects.cancel_superseded {
        if let Err(refusal) = crate::live_chat_moderation::cancel(state, operation_id).await {
            tracing::debug!("A replaced Golem removal was no longer pending: {refusal}");
        }
    }
    if effects.clear_highlight {
        crate::comment_highlight::clear_comment_highlight(state).await;
    }
    if let Some((command_id, expires_at)) = effects.expire_card {
        spawn_command_card_timer(state, scope, command_id, expires_at);
    }
    if let Some(request) = effects.request_removal {
        request_command_removal(state, scope, request).await;
    }
    if let Some(operation_id) = effects.confirm_removal {
        if background_confirm {
            let state = state.clone();
            tokio::spawn(async move {
                confirm_command_removal(&state, &operation_id).await;
            });
        } else {
            confirm_command_removal(state, &operation_id).await;
        }
    }
    if let Some(operation_id) = effects.cancel_removal {
        cancel_command_removal(state, &operation_id).await;
    }
}

/// A chooser or highlight card closes as expired after `COMMAND_CARD_TTL`
/// unless it was answered first. The timer re-checks under the lock and is
/// never aborted: a stale one finds another card (or none) and does nothing.
fn spawn_command_card_timer(
    state: &AppState,
    scope: &CommandSession,
    command_id: String,
    expires_at: String,
) {
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let state = state.clone();
    let scope = scope.clone();
    handle.spawn(async move {
        tokio::time::sleep(COMMAND_CARD_TTL).await;
        let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
        let snapshot = {
            let mut engine = state.cohost.lock().await;
            let now_iso = chrono::Utc::now().to_rfc3339();
            let expired = engine
                .command_session_mut(&scope)
                .is_some_and(|session| session.expire_command(&command_id, &expires_at, &now_iso));
            if !expired {
                return;
            }
            mirror_command_slot(&state, &engine);
            engine.snapshot()
        };
        emit_state(&state, &snapshot, &lifecycle_delivery);
    });
}

/// Ask chat moderation for the removal a command resolved (an
/// `orcle-voice` request, re-checked for Premium and the kill switch
/// there), then show its card.
async fn request_command_removal(
    state: &AppState,
    scope: &CommandSession,
    request: CommandRemovalRequest,
) {
    let result = crate::live_chat_moderation::request(
        state,
        ModerationRequest {
            operation_id: uuid::Uuid::new_v4().to_string(),
            message_id: request.message_id.clone(),
            source: ModerationSource::OrcleVoice,
            reason: request.reason.clone(),
            confirm_mode: request.confirm_mode,
        },
    )
    .await
    // Storage holds the freshest copy: a countdown may have moved it on.
    .map(|operation| {
        state
            .database
            .get_chat_moderation_operation(&operation.operation_id)
            .ok()
            .flatten()
            .unwrap_or(operation)
    });
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let (snapshot, orphan) = {
        let mut engine = state.cohost.lock().await;
        let now_iso = chrono::Utc::now().to_rfc3339();
        let (changed, orphan) = match engine.command_session_mut(scope) {
            Some(session) => session.settle_command_removal(&request.command_id, result, &now_iso),
            None => (false, result.ok().map(|operation| operation.operation_id)),
        };
        mirror_command_slot(state, &engine);
        (changed.then(|| engine.snapshot()), orphan)
    };
    if let Some(snapshot) = snapshot {
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
    drop(lifecycle_delivery);
    if let Some(operation_id) = orphan {
        // Replaced (or its session ended) while the request was on its way:
        // no card is left to answer it, so nothing may wait for an answer.
        if let Err(refusal) = crate::live_chat_moderation::cancel(state, &operation_id).await {
            tracing::debug!("A replaced Golem removal was no longer pending: {refusal}");
        }
    }
}

/// The streamer said yes: chat moderation runs the removal (up to about
/// 16 s at the platform), never under the engine lock. The outcome reaches
/// the card through `sync_command_operation`.
async fn confirm_command_removal(state: &AppState, operation_id: &str) {
    let operation = match crate::live_chat_moderation::confirm(state, operation_id).await {
        Ok(operation) => Some(operation),
        Err(refusal) => {
            tracing::info!("A Golem removal could not run: {refusal}");
            state
                .database
                .get_chat_moderation_operation(operation_id)
                .ok()
                .flatten()
        }
    };
    if let Some(operation) = operation {
        sync_command_operation(state, operation).await;
    }
}

/// The streamer said no: chat moderation cancels it; nothing is removed.
async fn cancel_command_removal(state: &AppState, operation_id: &str) {
    let operation = match crate::live_chat_moderation::cancel(state, operation_id).await {
        Ok(operation) => Some(operation),
        Err(refusal) => {
            tracing::info!("A Golem removal could not be cancelled: {refusal}");
            state
                .database
                .get_chat_moderation_operation(operation_id)
                .ok()
                .flatten()
        }
    };
    if let Some(operation) = operation {
        sync_command_operation(state, operation).await;
    }
}

/// Apply the freshest copy of a voice removal to the command that asked
/// for it, and to the report.
async fn sync_command_operation(state: &AppState, operation: ModerationOperation) {
    let operation = state
        .database
        .get_chat_moderation_operation(&operation.operation_id)
        .ok()
        .flatten()
        .unwrap_or(operation);
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let snapshot = {
        let mut engine = state.cohost.lock().await;
        let now_iso = chrono::Utc::now().to_rfc3339();
        let changed = engine
            .session
            .as_mut()
            .is_some_and(|session| session.apply_command_operation(&operation, &now_iso));
        if !changed {
            return;
        }
        mirror_command_slot(state, &engine);
        engine.snapshot()
    };
    emit_state(state, &snapshot, &lifecycle_delivery);
}

/// Chat moderation's hook (plan 140 S3), called next to every
/// `liveChat.moderationOperation` emit: in `request`, `begin_execution` and
/// `finish_locked`, under the moderation runtime's lock. It takes no lock of
/// its own and never waits: a task updates the command that asked for the
/// removal (and the report), from the stored copy, so an older change that
/// lands late never wins. Manual removals are not commands.
pub(crate) fn note_moderation_operation(state: &AppState, operation: &ModerationOperation) {
    if operation.source != ModerationSource::OrcleVoice {
        return;
    }
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let state = state.clone();
    let operation = operation.clone();
    handle.spawn(async move {
        sync_command_operation(&state, operation).await;
    });
}

/// Golem was addressed and understood nothing.
async fn note_unheard_command(
    state: &AppState,
    scope: &CommandSession,
    heard: &str,
    premium: bool,
) {
    let ctx = command_context(state, premium).await;
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let snapshot = {
        let mut engine = state.cohost.lock().await;
        engine.set_command_availability(ctx.availability());
        let changed = engine
            .command_session_mut(scope)
            .is_some_and(|session| session.note_unheard_command(heard, &ctx));
        if !changed {
            return;
        }
        mirror_command_slot(state, &engine);
        engine.snapshot()
    };
    emit_state(state, &snapshot, &lifecycle_delivery);
}

/// `cohost.command.choose` (plan 140 S3): pick a comment from the chooser.
pub async fn choose_command(
    state: &AppState,
    params: CohostCommandChooseParams,
) -> Result<CohostState, CohostCommandError> {
    answer_command_rpc(
        state,
        &params.command_id,
        CommandAnswer::Choose(params.index),
    )
    .await
}

/// `cohost.command.confirm` (plan 140 S3): yes to the open card. A removal
/// runs in the background; its outcome arrives as `cohost.state`.
pub async fn confirm_command(
    state: &AppState,
    params: CohostCommandParams,
) -> Result<CohostState, CohostCommandError> {
    answer_command_rpc(state, &params.command_id, CommandAnswer::Confirm).await
}

/// `cohost.command.cancel` (plan 140 S3): no to the open card or chooser.
pub async fn cancel_command(
    state: &AppState,
    params: CohostCommandParams,
) -> Result<CohostState, CohostCommandError> {
    answer_command_rpc(state, &params.command_id, CommandAnswer::Cancel).await
}

async fn answer_command_rpc(
    state: &AppState,
    command_id: &str,
    answer: CommandAnswer,
) -> Result<CohostState, CohostCommandError> {
    let command_id = command_id.trim();
    if command_id.is_empty() {
        return Err(CohostCommandError::invalid("commandId is required."));
    }
    answer_command_with(
        state,
        None,
        Some(command_id),
        answer,
        premium_entitled(),
        true,
    )
    .await
}

/// Caption-coordinator hook: the listen intent changed state on its own
/// (provider confirmed, allowance exhausted, audio path lost). Publishes the
/// session snapshot when a session is running; never called under the
/// lifecycle fence.
#[cfg(test)]
pub(crate) async fn publish_listening(state: &AppState, listening: CohostListening) {
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    publish_listening_under_fence(state, listening, &lifecycle_delivery).await;
}

/// `publish_listening` for a state the caption task decided on in
/// `listen_epoch`: dropped when the listen intent ended since (an explicit
/// stop, sign-out), so a late `on` never overwrites what the stop published.
/// The epoch is checked under the lifecycle fence the stop paths publish
/// under.
pub(crate) async fn publish_listening_for_epoch(
    state: &AppState,
    listen_epoch: u64,
    listening: CohostListening,
) {
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    if crate::captions::current_listen_epoch(state).await != listen_epoch {
        return;
    }
    publish_listening_under_fence(state, listening, &lifecycle_delivery).await;
}

async fn publish_listening_under_fence(
    state: &AppState,
    listening: CohostListening,
    lifecycle_delivery: &OwnedMutexGuard<()>,
) {
    let snapshot = {
        let mut engine = state.cohost.lock().await;
        let Some(session) = engine.session.as_mut() else {
            return;
        };
        if session.listening.as_ref() == Some(&listening) {
            return;
        }
        session.listening = Some(listening);
        engine.snapshot()
    };
    emit_state(state, &snapshot, lifecycle_delivery);
}

/// Sign-out is a privacy boundary for what Golem heard (plan 068 review):
/// the spotlight transcript, the recent-speech buffer, the Clip that tail and
/// voice activity go, and so do the session's pending transcript, summary,
/// topic, promises, recap, on-topic marks and voice greetings; a tick in
/// flight is dropped when it answers. Nothing heard under this account can
/// ride a tick under the next one. Listening reads `blocked` (`signed-out`)
/// until `resume_listen_after_sign_in`. The caption teardown already ended
/// the listen intent and joined its task before this runs.
pub(crate) async fn purge_speech_for_sign_out(state: &AppState) {
    clear_transcript(state);
    if let Ok(mut detector) = state.clip_marks.lock() {
        detector.forget_words();
    }
    if let Ok(mut voice) = state.cohost_voice.lock() {
        *voice = VoiceActivity::default();
    }
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let (snapshot, abandoned_removal) = {
        let mut engine = state.cohost.lock().await;
        let Some(session) = engine.session.as_mut() else {
            return;
        };
        let abandoned_removal = session.forget_speech();
        if session
            .listening
            .as_ref()
            .is_some_and(|listening| listening.state != CohostListeningState::Off)
        {
            session.listening = Some(CohostListening::blocked(
                "signed-out",
                "Sign in so Golem can hear you.",
            ));
        }
        // Plan 140 S3: the closed card waits for nothing any more.
        mirror_command_slot(state, &engine);
        (engine.snapshot(), abandoned_removal)
    };
    // Nothing asked under this account runs under the next.
    cancel_abandoned_removal(state, abandoned_removal).await;
    emit_state(state, &snapshot, &lifecycle_delivery);
}

/// Cancel the voice removal a session boundary closed (`abandon_command`).
/// Called after the engine lock; a removal already answered or run is
/// "not pending" and left alone.
async fn cancel_abandoned_removal(state: &AppState, operation_id: Option<String>) {
    let Some(operation_id) = operation_id else {
        return;
    };
    if let Err(refusal) = crate::live_chat_moderation::cancel(state, &operation_id).await {
        tracing::debug!("An abandoned Golem removal was no longer pending: {refusal}");
    }
}

/// Sign-in completed: a running Golem session with listening on hears the
/// streamer again (its consent still decides, as at start).
pub(crate) async fn resume_listen_after_sign_in(state: &AppState) {
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let running = {
        let engine = state.cohost.lock().await;
        engine
            .session
            .as_ref()
            .filter(|_| engine.settings.enabled)
            .map(|session| {
                (
                    session.session_id.clone(),
                    session.generation,
                    session.consent,
                    engine.settings.listen,
                    engine.settings.wake_word_required,
                )
            })
    };
    let Some((session_id, generation, consent, listen, wake_word_required)) = running else {
        return;
    };
    // Sign-out disarmed voice commands with the transcript; they resume with
    // listening (plan 140 S2).
    arm_command_detector(state, &session_id, generation, wake_word_required);
    if consent {
        crate::captions::grant_orcle_speech(state).await;
    }
    start_listen_if_wanted(state, &session_id, consent, listen).await;
    let snapshot = fresh_snapshot(state).await;
    emit_state(state, &snapshot, &lifecycle_delivery);
}

/// Record the listen intent's admission result on the running session. The
/// caller is under the lifecycle fence and emits the snapshot itself.
async fn record_listening(state: &AppState, session_id: &str, listening: CohostListening) {
    let mut engine = state.cohost.lock().await;
    if let Some(session) = engine
        .session
        .as_mut()
        .filter(|session| session.session_id == session_id)
    {
        session.listening = Some(listening);
    }
}

/// Start the listen intent for a running session when the setting and the
/// per-session consent both allow it (plan 068 D2). Never fails the session.
async fn start_listen_if_wanted(state: &AppState, session_id: &str, consent: bool, listen: bool) {
    let listening = if !listen {
        CohostListening::off()
    } else if !consent {
        CohostListening::blocked(
            "consent-required",
            "Golem can hear you once cloud AI consent is on.",
        )
    } else {
        crate::captions::start_listen_for_cohost(state, session_id).await
    };
    record_listening(state, session_id, listening).await;
}

/// A running Golem session for `session_id`, without its schedulers, for the
/// stop-path tests outside this module.
#[cfg(test)]
pub(crate) async fn start_cohost_session_for_test(state: &AppState, session_id: &str) {
    state
        .cohost
        .lock()
        .await
        .start_session(session_id.to_string(), true, None, Instant::now());
}

pub async fn cohost_status(state: &AppState) -> CohostState {
    // The kill switches ride every state, Golem running or not (plan 140).
    fresh_snapshot(state).await
}

pub async fn get_cohost_settings(state: &AppState) -> CohostSettings {
    state.cohost.lock().await.settings().clone()
}

/// Persist a settings patch and apply it to the running engine. Turning the
/// co-host off stops an active session immediately.
pub async fn set_cohost_settings(
    state: &AppState,
    patch: CohostSettingsPatch,
) -> Result<CohostSettings, CohostError> {
    let patch = CohostSettings::validated_patch(patch)?;
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let mut engine = state.cohost.lock().await;
    let mut next = engine.settings.clone();
    next.apply(patch);
    state
        .database
        .save_setting(COHOST_SETTINGS_KEY, &next)
        .map_err(|error| CohostError::Storage(error.to_string()))?;
    let listen_changed = engine.settings.listen != next.listen;
    engine.settings = next.clone();
    // Plan 140 S3: the detector reads the wake-word setting from its slot.
    mirror_command_slot(state, &engine);
    let report = if !next.enabled && engine.session.is_some() {
        engine.stop_session()
    } else {
        None
    };
    let stopped = report.is_some();
    let running = engine
        .session
        .as_ref()
        .map(|session| (session.session_id.clone(), session.consent));
    let snapshot = engine.snapshot();
    drop(engine);
    save_session_report(state, report);
    if !next.enabled || !next.listen {
        crate::captions::retire_marker_voice(state).await;
        if running.is_none() {
            crate::captions::stop_listen(state).await;
        }
    }
    if stopped {
        crate::captions::retire_orcle_speech(state).await;
        clear_transcript(state);
        crate::captions::stop_listen(state).await;
        state.emit_log("info", "Golem stopped: turned off in Settings.");
        emit_state(state, &snapshot, &lifecycle_delivery);
        return Ok(next);
    }
    // Toggling listening mid-session starts or stops the intent in place.
    if listen_changed && let Some((session_id, consent)) = running {
        if !next.listen {
            crate::captions::stop_listen(state).await;
        }
        start_listen_if_wanted(state, &session_id, consent, next.listen).await;
        let snapshot = state.cohost.lock().await.snapshot();
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
    Ok(next)
}

/// Start the engine for the active live-chat session. Consent is renderer-owned
/// (the cloud-AI consent toggle lives in renderer storage), so the renderer
/// passes it explicitly; without it the engine pauses with `consent-required`
/// instead of ever sending chat to the server.
pub async fn start_cohost(
    state: &AppState,
    params: CohostStartParams,
) -> Result<CohostState, CohostError> {
    start_cohost_if_entitled(state, params, premium_entitled()).await
}

/// Plan 140 S1: Golem is Premium only, in the backend too. The renderer gate
/// (`liveCohostGate`) stays, but a `cohost.start` from a Basic account is
/// refused here with `premium-required`, whatever the renderer believes. The
/// decision is passed in, like `prepare_tick`'s, so the gate is testable
/// without touching the process-wide entitlement snapshot.
async fn start_cohost_if_entitled(
    state: &AppState,
    params: CohostStartParams,
    premium: bool,
) -> Result<CohostState, CohostError> {
    if !premium {
        return Err(CohostError::PremiumRequired);
    }
    start_cohost_after_chat_validation(
        state,
        params,
        std::future::ready(()),
        std::future::ready(()),
    )
    .await
}

async fn start_cohost_after_chat_validation<F, G>(
    state: &AppState,
    params: CohostStartParams,
    after_chat_validation: F,
    before_state_emit: G,
) -> Result<CohostState, CohostError>
where
    F: std::future::Future<Output = ()>,
    G: std::future::Future<Output = ()>,
{
    let session_id = params.session_id.trim().to_string();
    if session_id.is_empty() {
        return Err(CohostError::InvalidParams);
    }
    let consent = params.consent_to_process_chat;
    if !consent {
        crate::captions::retire_marker_voice(state).await;
    }
    // Chat replacement/retirement and co-host admission are one session
    // lifecycle transaction. Keep this fence from validation through the
    // authoritative state publication, but never hold the chat coordinator
    // lock while awaiting the co-host lock.
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let chat_session_id = state
        .live_chat
        .lock()
        .await
        .session_id()
        .map(str::to_string);
    if chat_session_id.as_deref() != Some(session_id.as_str()) {
        return Err(CohostError::SessionMismatch);
    }
    after_chat_validation.await;

    let mut engine = state.cohost.lock().await;
    if !engine.settings.enabled {
        return Err(CohostError::Disabled);
    }
    if engine.is_running_for(&session_id) {
        let Some(ConsentUpdate {
            generation,
            abandoned_removal,
        }) = engine.update_consent(consent)
        else {
            return Ok(engine.snapshot());
        };
        let listen = engine.settings.listen;
        let wake_word_required = engine.settings.wake_word_required;
        engine.scheduler = Some(spawn_scheduler(state.clone(), generation));
        engine.spotlight_scheduler = Some(spawn_spotlight_scheduler(state.clone(), generation));
        drop(engine);
        // The removal asked under the old consent never runs under the new.
        cancel_abandoned_removal(state, abandoned_removal).await;
        // Invalidate delayed listen publications and capture-resume admissions
        // before reflecting the new consent. Explicit captions keep their task.
        crate::captions::retire_orcle_speech(state).await;
        crate::captions::stop_listen(state).await;
        clear_transcript(state);
        arm_command_detector(state, &session_id, generation, wake_word_required);
        if consent {
            crate::captions::grant_orcle_speech(state).await;
        }
        start_listen_if_wanted(state, &session_id, consent, listen).await;
        let snapshot = fresh_snapshot(state).await;
        before_state_emit.await;
        emit_state(state, &snapshot, &lifecycle_delivery);
        return Ok(snapshot);
    }
    // A replacing start ends the previous session: its report is saved
    // below, once the engine lock is released.
    let replaced = engine.stop_session();
    let generation = engine.start_session(
        session_id.clone(),
        params.consent_to_process_chat,
        params
            .stream_title
            .map(|title| title.trim().to_string())
            .filter(|title| !title.is_empty()),
        Instant::now(),
    );
    engine.scheduler = Some(spawn_scheduler(state.clone(), generation));
    engine.spotlight_scheduler = Some(spawn_spotlight_scheduler(state.clone(), generation));
    let listen = engine.settings.listen;
    let wake_word_required = engine.settings.wake_word_required;
    drop(engine);
    save_session_report(state, replaced);
    crate::captions::retire_orcle_speech(state).await;
    crate::captions::stop_listen(state).await;
    clear_transcript(state);
    arm_command_detector(state, &session_id, generation, wake_word_required);
    if consent {
        crate::captions::grant_orcle_speech(state).await;
    }
    // The listen intent joins after the session exists (it reports into the
    // session) and before the first state emit (so the renderer sees it at
    // once). It never fails or delays the session.
    start_listen_if_wanted(state, &session_id, consent, listen).await;
    let snapshot = fresh_snapshot(state).await;
    before_state_emit.await;
    state.emit_log("info", format!("Golem listening for session {session_id}."));
    emit_state(state, &snapshot, &lifecycle_delivery);
    drop(lifecycle_delivery);
    Ok(snapshot)
}

pub async fn stop_cohost(state: &AppState) -> CohostState {
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    stop_cohost_under_lifecycle_fence(
        state,
        &lifecycle_delivery,
        std::future::ready(()),
        ListenStop::Abort,
        None,
    )
    .await
}

/// Plan 140 S1: Golem is Premium only. Called after every
/// `entitlements.updated` publication: when `LiveCohost` is no longer
/// entitled, a running session stops through the normal stop path (its report
/// is saved) and the stopped state carries the reason, so the renderer can
/// tell the streamer in one line. A signed-out account has no Premium either;
/// its reason says so instead. Returns whether a session was stopped.
pub(crate) async fn stop_cohost_if_premium_lapsed(state: &AppState) -> bool {
    if premium_entitled() {
        return false;
    }
    crate::captions::retire_marker_voice(state).await;
    if state.cohost.lock().await.session.is_none() {
        crate::captions::stop_listen(state).await;
    }
    let reason = if crate::account::stored_session_token().is_some() {
        CohostReason::PremiumRequired
    } else {
        CohostReason::SignedOut
    };
    stop_cohost_for_premium_lapse(state, reason).await
}

/// The lapse stop with the decision made: the same fence and stop path as
/// `cohost.stop`, plus the reason on the published off state.
async fn stop_cohost_for_premium_lapse(state: &AppState, reason: CohostReason) -> bool {
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    if state.cohost.lock().await.session.is_none() {
        return false;
    }
    let snapshot = stop_cohost_under_lifecycle_fence(
        state,
        &lifecycle_delivery,
        std::future::ready(()),
        ListenStop::Abort,
        Some(reason),
    )
    .await;
    snapshot.reason == Some(reason)
}

async fn stop_cohost_under_lifecycle_fence<F>(
    state: &AppState,
    lifecycle_delivery: &OwnedMutexGuard<()>,
    before_state_emit: F,
    listen_stop: ListenStop,
    stopped_reason: Option<CohostReason>,
) -> CohostState
where
    F: std::future::Future<Output = ()>,
{
    let mut engine = state.cohost.lock().await;
    let report = engine.stop_session();
    let stopped = report.is_some();
    let mut snapshot = engine.snapshot();
    drop(engine);
    save_session_report(state, report);
    if stopped {
        // The off state names why the backend ended the session (a Premium
        // lapse); a streamer's own Stop carries no reason, as before.
        snapshot.reason = stopped_reason;
        crate::captions::retire_orcle_speech(state).await;
        clear_transcript(state);
        crate::captions::stop_listen_with(state, listen_stop).await;
    }
    before_state_emit.await;
    if stopped {
        match stopped_reason {
            Some(CohostReason::PremiumRequired) => {
                state.emit_log("warn", "Golem stopped: Videorc Premium is required.");
            }
            Some(CohostReason::SignedOut) => {
                state.emit_log("warn", "Golem stopped: sign in to Videorc to use it.");
            }
            Some(reason) => state.emit_log(
                "warn",
                format!(
                    "Golem stopped: {}.",
                    serde_json::to_string(&reason).unwrap_or_default()
                ),
            ),
            None => state.emit_log("info", "Golem stopped."),
        }
        emit_state(state, &snapshot, lifecycle_delivery);
    }
    snapshot
}

/// Live-chat session boundary (stop, or a replacing start): drop the engine
/// session so no late tick can publish into the next stream. `listen_stop`
/// says whether a listen-only transcription task ends now (an explicit stop,
/// a replacing start) or drains with the capture that is ending
/// (`session.stop`), so the stream's last words reach its SRT and Clip that.
pub(crate) async fn stop_cohost_for_session_end_under_lifecycle_fence(
    state: &AppState,
    lifecycle_delivery: &OwnedMutexGuard<()>,
    listen_stop: ListenStop,
) {
    stop_cohost_under_lifecycle_fence(
        state,
        lifecycle_delivery,
        std::future::ready(()),
        listen_stop,
        None,
    )
    .await;
}

/// Recording monitors are generation-late by construction: final media work
/// can overlap admission of a replacement session. Stop the co-host only when
/// it still belongs to the recording session that just retired.
pub(crate) async fn stop_cohost_for_session_end_if_matching_before_emit<F>(
    state: &AppState,
    expected_session_id: &str,
    lifecycle_delivery: &OwnedMutexGuard<()>,
    before_state_emit: F,
) where
    F: std::future::Future<Output = ()>,
{
    stop_cohost_for_session_end_if_matching_impl(
        state,
        expected_session_id,
        lifecycle_delivery,
        before_state_emit,
    )
    .await;
}

async fn stop_cohost_for_session_end_if_matching_impl<F>(
    state: &AppState,
    expected_session_id: &str,
    lifecycle_delivery: &OwnedMutexGuard<()>,
    before_state_emit: F,
) where
    F: std::future::Future<Output = ()>,
{
    let mut engine = state.cohost.lock().await;
    if !engine.is_running_for(expected_session_id) {
        return;
    }
    let report = engine.stop_session();
    let stopped = report.is_some();
    let snapshot = engine.snapshot();
    drop(engine);
    save_session_report(state, report);
    if stopped {
        crate::captions::retire_orcle_speech(state).await;
        clear_transcript(state);
        // The recording monitor retires its capture next: the listen task
        // drains there (`finish_captions_for_capture`) instead of aborting.
        crate::captions::stop_listen_with(state, ListenStop::DrainWithCapture).await;
    }
    before_state_emit.await;
    if stopped {
        state.emit_log("info", "Golem stopped.");
        emit_state(state, &snapshot, lifecycle_delivery);
    }
}

/// Plan 119 S1: save the report a stopped session left and tell renderers,
/// once the engine lock is released. The session row may be gone (a chat
/// session that was never persisted, or a deleted recording): then the report
/// is skipped and logged. Nothing here fails the stop.
fn save_session_report(state: &AppState, report: Option<CohostSessionReport>) {
    let Some(report) = report else {
        return;
    };
    let session_id = report.session_id.clone();
    match state.database.upsert_cohost_report(&report) {
        Ok(true) => {
            state.emit_log(
                "info",
                format!(
                    "Golem saved the report for session {session_id}: {} question(s), {} flag(s), {} open promise(s).",
                    report.questions.total,
                    report.flags.raised,
                    report.promises.open.len()
                ),
            );
            state.emit_event(
                COHOST_REPORT_SAVED_EVENT,
                CohostReportSavedEvent { session_id },
            );
        }
        Ok(false) => state.emit_log(
            "info",
            format!("Golem report for session {session_id} skipped: the session row is gone."),
        ),
        Err(error) => state.emit_log(
            "warn",
            format!("Golem report for session {session_id} could not be saved: {error}"),
        ),
    }
}

/// `cohost.report.get`: the saved report (null when Golem left none), the
/// session's moments (computed now, never stored) and its chat totals.
pub async fn get_session_report(
    state: &AppState,
    session_id: &str,
) -> anyhow::Result<CohostReportPayload> {
    let report = state.database.get_cohost_report(session_id)?;
    let moments = crate::moments::session_moments(state, session_id)
        .await?
        .map(|found| found.moments)
        .unwrap_or_default();
    let by_platform = state
        .database
        .live_chat_message_counts_by_platform(session_id)?;
    let messages: u64 = by_platform.iter().map(|count| count.messages).sum();
    Ok(CohostReportPayload {
        session_id: session_id.to_string(),
        report,
        moments,
        chat: CohostReportChat {
            messages,
            by_platform,
        },
    })
}

/// `cohost.report.latest`: the newest session that has a report, else the
/// newest session that streamed; `None` when there is neither.
pub async fn latest_session_report(
    state: &AppState,
) -> anyhow::Result<Option<CohostReportPayload>> {
    let session_id = match state.database.latest_cohost_report_session_id()? {
        Some(session_id) => Some(session_id),
        None => state.database.latest_streamed_session_id()?,
    };
    let Some(session_id) = session_id else {
        return Ok(None);
    };
    Ok(Some(get_session_report(state, &session_id).await?))
}

/// Delivery-path hook: remember eligible rows for the next tick. Rows from a
/// different session are ignored by the engine's own guard. The UI learns
/// about queued chat when `pending_messages` crosses an emission bucket
/// (0 -> 1, then every +5) — a reaction per wave, never a per-message storm.
pub(crate) async fn note_messages_under_lifecycle_fence(
    state: &AppState,
    lifecycle_delivery: &OwnedMutexGuard<()>,
    messages: &[LiveChatMessage],
) {
    if messages.is_empty() {
        return;
    }
    let snapshot = {
        let mut engine = state.cohost.lock().await;
        if engine.session.is_none() {
            return;
        }
        let bucket_before = pending_bucket(engine.pending_len());
        let highlights_before = engine.highlights_len();
        let spotlight_before = engine.has_spotlight();
        engine.note_messages(messages);
        let bucket_after = pending_bucket(engine.pending_len());
        // A tombstone that pulled a suggested comment (or the spotlight) is
        // also news: the renderer must stop offering it now, not at the
        // next tick.
        if bucket_before == bucket_after
            && highlights_before == engine.highlights_len()
            && spotlight_before == engine.has_spotlight()
        {
            return;
        }
        engine.snapshot()
    };
    emit_state(state, &snapshot, lifecycle_delivery);
}

#[cfg(test)]
async fn note_messages(state: &AppState, messages: &[LiveChatMessage]) {
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    note_messages_under_lifecycle_fence(state, &lifecycle_delivery, messages).await;
}

pub async fn mark_question_answered(
    state: &AppState,
    params: CohostQuestionParams,
) -> Result<CohostState, CohostError> {
    if params.session_id.trim().is_empty() || params.question_id.trim().is_empty() {
        return Err(CohostError::InvalidParams);
    }
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let mut engine = state.cohost.lock().await;
    let changed = engine.mark_answered(&params.session_id, &params.question_id)?;
    let snapshot = engine.snapshot();
    drop(engine);
    if changed {
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
    Ok(snapshot)
}

/// Dismiss and answered share one outcome for the engine: the question leaves
/// the open set and its id never returns from a later tick. The report counts
/// a dismiss apart from an answer (plan 119).
pub async fn dismiss_question(
    state: &AppState,
    params: CohostQuestionParams,
) -> Result<CohostState, CohostError> {
    if params.session_id.trim().is_empty() || params.question_id.trim().is_empty() {
        return Err(CohostError::InvalidParams);
    }
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let mut engine = state.cohost.lock().await;
    let changed = engine.dismiss_question(&params.session_id, &params.question_id)?;
    let snapshot = engine.snapshot();
    drop(engine);
    if changed {
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
    Ok(snapshot)
}

/// `cohost.question.restore` (D9): put a voice-resolved question back. The
/// open set gets it, the dismissed set forgets it, the recently-resolved list
/// drops it; a question that is not there (or older than a minute) is a
/// no-op with the current state.
pub async fn restore_question(
    state: &AppState,
    params: CohostQuestionParams,
) -> Result<CohostState, CohostError> {
    if params.session_id.trim().is_empty() || params.question_id.trim().is_empty() {
        return Err(CohostError::InvalidParams);
    }
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let mut engine = state.cohost.lock().await;
    let changed =
        engine.restore_question(&params.session_id, &params.question_id, Instant::now())?;
    let snapshot = engine.snapshot();
    drop(engine);
    if changed {
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
    Ok(snapshot)
}

/// `liveChat.send` start hook: remember the text, so its echo in chat proves
/// which author is the streamer (plan 068 D9). No emit.
pub(crate) async fn note_own_send_started(state: &AppState, session_id: &str, text: &str) {
    state
        .cohost
        .lock()
        .await
        .note_own_send(session_id, text, Instant::now());
}

/// `liveChat.send` completion hook: a terminal sent/partial delivery that
/// carried `inReplyToQuestionId` clears that question and greets whoever
/// asked it; a name or `@handle` in the text greets that viewer (plan 068
/// D9). A mismatched session is not an error here — the send already
/// succeeded.
pub(crate) async fn note_own_send_delivered(
    state: &AppState,
    session_id: &str,
    text: &str,
    question_id: Option<&str>,
) {
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let mut engine = state.cohost.lock().await;
    let changed = engine.own_send_delivered(session_id, text, question_id, Instant::now());
    let log = engine.take_greeting_log();
    let snapshot = engine.snapshot();
    drop(engine);
    for line in log {
        state.emit_log("info", line);
    }
    if changed {
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
}

/// `cohost.author.greeted` (plan 068 D9): the streamer says they greeted a
/// viewer; "Say hi" drops them. An unknown or already greeted key is a no-op
/// with the current state.
pub async fn mark_author_greeted(
    state: &AppState,
    params: CohostAuthorParams,
) -> Result<CohostState, CohostError> {
    if params.session_id.trim().is_empty() || params.author_key.trim().is_empty() {
        return Err(CohostError::InvalidParams);
    }
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let mut engine = state.cohost.lock().await;
    let changed =
        engine.mark_author_greeted(&params.session_id, &params.author_key, Instant::now())?;
    let log = engine.take_greeting_log();
    let snapshot = engine.snapshot();
    drop(engine);
    for line in log {
        state.emit_log("info", line);
    }
    if changed {
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
    Ok(snapshot)
}

pub async fn dismiss_flag(
    state: &AppState,
    params: CohostFlagParams,
) -> Result<CohostState, CohostError> {
    if params.session_id.trim().is_empty() || params.message_id.trim().is_empty() {
        return Err(CohostError::InvalidParams);
    }
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let mut engine = state.cohost.lock().await;
    let changed = engine.dismiss_flag(&params.session_id, &params.message_id)?;
    let snapshot = engine.snapshot();
    drop(engine);
    if changed {
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
    Ok(snapshot)
}

/// Chat moderation hook (plan 140 S4): a message the streamer removed or hid
/// takes its flag with it. A deletion alone never cleared flags; this does,
/// without counting a dismissal. Silent when Golem is off or on another
/// session. Called after the tombstone delivery, never under its fence.
pub(crate) async fn resolve_flag_for_removed_message(
    state: &AppState,
    session_id: &str,
    message_id: &str,
) {
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let snapshot = {
        let mut engine = state.cohost.lock().await;
        match engine.resolve_flag(session_id, message_id) {
            Ok(true) => engine.snapshot(),
            Ok(false) | Err(_) => return,
        }
    };
    emit_state(state, &snapshot, &lifecycle_delivery);
}

/// `cohost.promise.done` (plan 068 D8): the promise leaves and its id never
/// returns from a later tick; the report counts it kept (plan 119).
pub async fn promise_done(
    state: &AppState,
    params: CohostPromiseParams,
) -> Result<CohostState, CohostError> {
    close_promise_with(state, params, true).await
}

/// `cohost.promise.dismiss`: the same engine outcome as done, counted as
/// dismissed in the report.
pub async fn dismiss_promise(
    state: &AppState,
    params: CohostPromiseParams,
) -> Result<CohostState, CohostError> {
    close_promise_with(state, params, false).await
}

async fn close_promise_with(
    state: &AppState,
    params: CohostPromiseParams,
    kept: bool,
) -> Result<CohostState, CohostError> {
    if params.session_id.trim().is_empty() || params.promise_id.trim().is_empty() {
        return Err(CohostError::InvalidParams);
    }
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let mut engine = state.cohost.lock().await;
    let changed = engine.close_promise(&params.session_id, &params.promise_id, kept)?;
    let snapshot = engine.snapshot();
    drop(engine);
    if changed {
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
    Ok(snapshot)
}

/// `cohost.recap.dismiss`: the recap card leaves; nothing was posted.
pub async fn dismiss_recap(
    state: &AppState,
    params: CohostRecapParams,
) -> Result<CohostState, CohostError> {
    if params.session_id.trim().is_empty() {
        return Err(CohostError::InvalidParams);
    }
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let mut engine = state.cohost.lock().await;
    let changed = engine.dismiss_recap(&params.session_id, Instant::now())?;
    let snapshot = engine.snapshot();
    drop(engine);
    if changed {
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
    Ok(snapshot)
}

/// `cohost.recap.draft`: a recap from the latest summary, no network call.
/// The draft rides the state as `recap` (the renderer pre-fills the composer
/// from it); `cohost-no-summary` when nothing has been summarised yet.
pub async fn draft_recap(
    state: &AppState,
    params: CohostRecapParams,
) -> Result<CohostState, CohostError> {
    if params.session_id.trim().is_empty() {
        return Err(CohostError::InvalidParams);
    }
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let mut engine = state.cohost.lock().await;
    engine.draft_recap(
        &params.session_id,
        Instant::now(),
        &chrono::Utc::now().to_rfc3339(),
    )?;
    let snapshot = engine.snapshot();
    drop(engine);
    emit_state(state, &snapshot, &lifecycle_delivery);
    Ok(snapshot)
}

/// The fresh viewer total across every sampler, `None` when none reported.
fn current_viewer_total(state: &AppState) -> Option<u64> {
    state
        .viewer_aggregator
        .lock()
        .ok()
        .and_then(|aggregator| aggregator.current_total(chrono::Utc::now()))
}

pub(crate) fn premium_entitled() -> bool {
    crate::entitlements::require_feature(
        &crate::entitlements::current_entitlements(),
        FeatureId::LiveCohost,
    )
    .is_ok()
}

fn spawn_scheduler(state: AppState, generation: u64) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(SCHEDULER_POLL).await;
            if !run_scheduler_pass(&state, generation).await {
                break;
            }
        }
    })
}

/// One scheduler pass. Returns false when the scheduler must exit.
async fn run_scheduler_pass(state: &AppState, generation: u64) -> bool {
    let token = crate::account::stored_session_token();
    let premium = premium_entitled();
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    // Automatic on-stream cards: read the overlay first (its own lock, never
    // nested with the engine's), then let the engine decide. The Voice
    // source is the session's live spotlight (plan 060 S3).
    let overlay = OverlayObservation::from_highlight(&*state.comment_highlight.lock().await);
    let auto_command = {
        let mut engine = state.cohost.lock().await;
        engine
            .evaluate_auto_highlight(generation, &overlay, Instant::now())
            .map(|command| (command, engine.snapshot()))
    };
    if let Some((command, snapshot)) = auto_command {
        state.emit_log(
            "info",
            format!(
                "Golem puts {} on stream ({}{}).",
                command.message_id,
                serde_json::to_string(&command.source).unwrap_or_default(),
                if command.refresh { ", refresh" } else { "" }
            ),
        );
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
    // Plan 140 S3: a kill switch the service flags flipped reaches the state
    // within a pass.
    let availability = command_availability_now(state);
    let availability_snapshot = {
        let mut engine = state.cohost.lock().await;
        engine
            .set_command_availability(availability)
            .then(|| engine.snapshot())
    };
    if let Some(snapshot) = availability_snapshot {
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
    // v3 (plan 068): fold what the streamer said since the last pass into the
    // pending transcript (the buffer's own lock, never nested with the
    // engine's), then check the promise triggers against the fresh viewer
    // total.
    let seen_speech = state.cohost.lock().await.seen_speech_version(generation);
    let Some(seen_speech) = seen_speech else {
        return false;
    };
    let speech = recent_speech_since(state, seen_speech);
    let viewers = current_viewer_total(state);
    // Plan 068 D9: the same fold greets viewers named out loud; then "Say hi"
    // and the dead-air nudge read the caption task's voice activity (its own
    // lock, never nested with the engine's).
    let voice = voice_activity(state);
    let (reminded, nudged, greetings, snapshot) = {
        let mut engine = state.cohost.lock().await;
        if let Some(snapshot) = &speech {
            engine.note_speech(generation, snapshot);
        }
        let now = Instant::now();
        let now_iso = chrono::Utc::now().to_rfc3339();
        let reminded = engine.check_promises(generation, viewers, now, &now_iso);
        let acknowledged = engine.refresh_acknowledgement(generation, voice, now, &now_iso);
        let snapshot = (reminded || acknowledged.changed).then(|| engine.snapshot());
        (
            reminded,
            acknowledged.nudge,
            engine.take_greeting_log(),
            snapshot,
        )
    };
    for line in greetings {
        state.emit_log("info", line);
    }
    if let Some(snapshot) = snapshot {
        if reminded && let Some(reminder) = &snapshot.promise_reminder {
            state.emit_log(
                "info",
                format!("Golem reminds you of a promise: {}", reminder.text),
            );
        }
        if let Some(text) = nudged {
            state.emit_log("info", format!("Golem nudges you: {text}"));
        }
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
    let prepared = {
        let mut engine = state.cohost.lock().await;
        let prepared = engine.prepare_tick(generation, token.is_some(), premium, Instant::now());
        match prepared {
            // The snapshot taken here carries tick_in_flight=true and the
            // drained delta; emitting it below is the "thinking..." signal.
            Ok(prepared) => Ok((prepared, engine.snapshot())),
            Err(TickGate::Stopped) => return false,
            Err(TickGate::Idle) => return true,
            Err(TickGate::Paused(reason)) => Err((reason, engine.snapshot())),
        }
    };
    let (prepared, in_flight_snapshot) = match prepared {
        Ok(prepared) => prepared,
        Err((reason, snapshot)) => {
            state.emit_log(
                "warn",
                format!(
                    "Golem paused: {}.",
                    serde_json::to_string(&reason).unwrap_or_default()
                ),
            );
            emit_state(state, &snapshot, &lifecycle_delivery);
            return true;
        }
    };
    // tick_in_flight toggles true exactly here and false in apply_tick_result;
    // both edges reach the renderer (this emit, and the post-tick emit below).
    emit_state(state, &in_flight_snapshot, &lifecycle_delivery);
    drop(lifecycle_delivery);
    let Some(token) = token else {
        return true;
    };
    let dropped = prepared.request.dropped_messages;
    let message_count = prepared.request.messages.len();
    let result = match VideorcApiClient::new() {
        Ok(client) => client.post_cohost_tick(&token, &prepared.request).await,
        Err(error) => Err(CohostApiError::network(error.to_string())),
    };
    let log = match &result {
        Ok(response) => Some((
            "info",
            format!(
                "Golem tick {} merged: {} message(s), {} open question(s), {} flag(s).",
                prepared.request.tick_seq,
                message_count,
                response.questions.len(),
                response.flags.len()
            ),
        )),
        Err(error)
            if error.kind == CohostApiErrorKind::PromptVersionUnsupported
                && fallback_prompt_version(prepared.request.prompt_version).is_some() =>
        {
            Some((
                "info",
                format!(
                    "Golem tick {}: the server does not speak tick contract v{}; using v{} for the rest of this session.",
                    prepared.request.tick_seq,
                    prepared.request.prompt_version,
                    fallback_prompt_version(prepared.request.prompt_version).unwrap_or(1)
                ),
            ))
        }
        Err(error) => Some((
            "warn",
            format!(
                "Golem tick {} failed ({}, {}{}): {}",
                prepared.request.tick_seq,
                serde_json::to_string(&error.reason()).unwrap_or_default(),
                error.detail.code,
                error
                    .detail
                    .status
                    .map(|status| format!(", HTTP {status}"))
                    .unwrap_or_default(),
                error.message()
            ),
        )),
    };
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let snapshot = {
        let mut engine = state.cohost.lock().await;
        let applied = engine.apply_tick_result(
            prepared.generation,
            dropped,
            result,
            Instant::now(),
            &chrono::Utc::now().to_rfc3339(),
        );
        if !applied {
            state.emit_log(
                "warn",
                "Golem tick response dropped: its session was replaced.",
            );
            return false;
        }
        engine.snapshot()
    };
    if let Some((level, message)) = log {
        state.emit_log(level, message);
    }
    emit_state(state, &snapshot, &lifecycle_delivery);
    true
}

fn spawn_spotlight_scheduler(state: AppState, generation: u64) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(SCHEDULER_POLL).await;
            if !run_spotlight_pass(&state, generation).await {
                break;
            }
        }
    })
}

/// Read and prepare one spotlight admission under the authoritative lifecycle
/// fence. A consent/session boundary must also retire the transcript snapshot.
async fn prepare_spotlight_pass<F>(
    state: &AppState,
    generation: u64,
    signed_in: bool,
    premium: bool,
    before_delivery: F,
) -> (OwnedMutexGuard<()>, Option<CohostState>, SpotlightPass)
where
    F: std::future::Future<Output = ()>,
{
    before_delivery.await;
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let now = Instant::now();
    let transcript = state
        .cohost_transcript
        .lock()
        .map(|window| window.snapshot(now))
        .unwrap_or_default();
    let (expired, pass) = {
        let mut engine = state.cohost.lock().await;
        // The pull-up leaves the state the second it is stale, whether or
        // not a call goes out.
        let expired = engine
            .expire_spotlight(generation, now)
            .then(|| engine.snapshot());
        let pass = engine.prepare_spotlight(generation, signed_in, premium, &transcript, now);
        (expired, pass)
    };
    (lifecycle_delivery, expired, pass)
}

/// One pass of the spotlight lane (plan 060 S3). Its own loop, not the tick
/// scheduler's: that pass awaits the tick request inline (up to 12 s) and
/// D7 says the lane never waits on the tick. Both share the engine lock, so
/// a tick and a spotlight answer merge in whichever order they land.
/// Returns false when the lane must exit.
async fn run_spotlight_pass(state: &AppState, generation: u64) -> bool {
    let token = crate::account::stored_session_token();
    let premium = premium_entitled();
    let (lifecycle_delivery, expired, pass) = prepare_spotlight_pass(
        state,
        generation,
        token.is_some(),
        premium,
        std::future::ready(()),
    )
    .await;
    if let Some(snapshot) = expired {
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
    let prepared = match pass {
        SpotlightPass::Stopped => return false,
        SpotlightPass::Idle => return true,
        SpotlightPass::Send(prepared) => prepared,
    };
    drop(lifecycle_delivery);
    let result = match (token, VideorcApiClient::new()) {
        (Some(token), Ok(client)) => {
            client
                .post_cohost_spotlight(&token, &prepared.request)
                .await
        }
        (None, _) => Err(CohostApiError::network(
            "Signed out before the spotlight call.",
        )),
        (_, Err(error)) => Err(CohostApiError::network(error.to_string())),
    };
    let failure = result.as_ref().err().map(|error| {
        format!(
            "{}{}",
            error.detail.code,
            error
                .detail
                .status
                .map(|status| format!(", HTTP {status}"))
                .unwrap_or_default()
        )
    });
    let lifecycle_delivery = state.live_chat_persistence.begin_delivery().await;
    let (outcome, snapshot) = {
        let mut engine = state.cohost.lock().await;
        let Some(outcome) = engine.apply_spotlight_result(
            prepared.generation,
            result,
            Instant::now(),
            &chrono::Utc::now().to_rfc3339(),
        ) else {
            return false;
        };
        let snapshot = outcome.changed.then(|| engine.snapshot());
        (outcome, snapshot)
    };
    if let Some((message_id, about)) = &outcome.spotlight_set {
        state.emit_log(
            "info",
            format!(
                "Golem spotlight: the streamer is talking about {message_id} (about {about:.2})."
            ),
        );
    }
    for question_id in &outcome.resolved {
        state.emit_log(
            "info",
            format!("Golem marks question {question_id} answered on air."),
        );
    }
    if let (Some(off), Some(failure)) = (outcome.lane_off_for, failure) {
        // Quiet by design (D12): a log line, never a toast, never the tick.
        state.emit_log(
            "info",
            format!(
                "Golem spotlight lane paused for {} s after {failure}.",
                off.as_secs()
            ),
        );
    }
    if let Some(snapshot) = snapshot {
        emit_state(state, &snapshot, &lifecycle_delivery);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_chat::live_chat_message_id;
    use crate::storage::Database;
    use crate::videorc_api::{CohostTickAlert, CohostTickFlag, CohostTickQuestion};
    use tokio::sync::broadcast;

    fn test_state() -> AppState {
        let (events, _) = broadcast::channel(64);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        )
    }

    fn chat_message(session_id: &str, seq: u32, received_at: &str) -> LiveChatMessage {
        let provider_message_id = format!("m-{seq}");
        LiveChatMessage {
            id: live_chat_message_id(
                session_id,
                StreamPlatform::Twitch,
                None,
                &provider_message_id,
            ),
            provider_message_id,
            platform: StreamPlatform::Twitch,
            target_id: None,
            session_id: session_id.to_string(),
            author_id: Some(format!("viewer-{}", seq % 3)),
            author_name: format!("Viewer {}", seq % 3),
            author_avatar_url: None,
            author_badges: Vec::new(),
            author_roles: vec!["moderator".to_string(), "unknown-role".to_string()],
            published_at: format!("2026-08-22T10:00:{:02}Z", seq % 60),
            received_at: received_at.to_string(),
            message_text: format!("What keyboard is that? #{seq}"),
            fragments: Vec::new(),
            event_type: LiveChatEventType::Message,
            amount_text: None,
            is_deleted: false,
            raw_provider_type: Some("twitch".to_string()),
            details: None,
            reply: None,
            first_message: false,
            author_affiliation: None,
        }
    }

    /// A classified server failure with its envelope, as `post_cohost_tick`
    /// would return it.
    fn server_error(status: u16, code: &str, message: &str) -> CohostApiError {
        crate::videorc_api::classify_cohost_failure(status, code, message.to_string(), None)
    }

    fn enabled_settings() -> CohostSettings {
        CohostSettings {
            enabled: true,
            tone: CohostTone::Short,
            notes: "Keyboard: Keychron Q1".to_string(),
            auto_highlight: false,
            voice_highlight: false,
            rules: Vec::new(),
            listen: false,
            wake_word_required: false,
            remove_confirm: RemoveConfirmMode::Confirm,
            persona: CohostPersona::default(),
            auto_chat: CohostAutoChat::default(),
        }
    }

    fn running_engine(now: Instant) -> (CohostEngine, u64) {
        let mut engine = CohostEngine::new(enabled_settings());
        let generation = engine.start_session(
            "session-1".to_string(),
            true,
            Some("Rust night".into()),
            now,
        );
        (engine, generation)
    }

    fn messages(session_id: &str, range: std::ops::Range<u32>) -> Vec<LiveChatMessage> {
        range
            .map(|seq| {
                chat_message(
                    session_id,
                    seq,
                    &format!("2026-08-22T10:{:02}:{:02}Z", 1 + seq / 60, seq % 60),
                )
            })
            .collect()
    }

    fn response(questions: Vec<CohostTickQuestion>) -> CohostTickResponse {
        CohostTickResponse {
            prompt_version: COHOST_PROMPT_VERSION,
            questions,
            resolved: Vec::new(),
            flags: Vec::new(),
            mood: Some(CohostMood::Hype),
            ..CohostTickResponse::default()
        }
    }

    fn flag(
        message_id: &str,
        kind: CohostFlagKind,
        severity: CohostFlagSeverity,
    ) -> CohostTickFlag {
        CohostTickFlag {
            message_id: message_id.to_string(),
            kind,
            severity,
            reason: "reason".to_string(),
            confidence: None,
            target: None,
            action: None,
            also_kinds: Vec::new(),
            rule_index: None,
        }
    }

    fn question(id: &str, message_ids: &[&str]) -> CohostTickQuestion {
        CohostTickQuestion {
            id: id.to_string(),
            text: "What keyboard is that?".to_string(),
            message_ids: message_ids.iter().map(|id| id.to_string()).collect(),
            askers: vec!["Viewer 0".to_string(), "Viewer 1".to_string()],
            platforms: vec![StreamPlatform::Twitch],
            priority: CohostPriority::High,
            suggested_reply: "Keychron Q1!".to_string(),
            from_notes: true,
            on_topic: false,
        }
    }

    fn secs(value: u64) -> Duration {
        Duration::from_secs(value)
    }

    #[test]
    fn cadence_matrix_matches_the_contract() {
        let start = Instant::now();
        // 0 new → never.
        assert!(!tick_due(0, 0, start, None, start + secs(60)));
        // ≥5 new → immediately (no previous tick).
        assert!(tick_due(5, 0, start, None, start + secs(1)));
        // 1 new → only after 20 s since the anchor.
        assert!(!tick_due(1, 0, start, None, start + secs(19)));
        assert!(tick_due(1, 0, start, None, start + secs(20)));
        // Never < 8 s after the previous tick, even for a burst.
        let last = start + secs(30);
        assert!(!tick_due(50, 0, last, Some(last), last + secs(7)));
        assert!(tick_due(50, 0, last, Some(last), last + secs(8)));
        // 1 new after a tick: waits for the 20 s idle window.
        assert!(!tick_due(1, 0, last, Some(last), last + secs(19)));
        assert!(tick_due(1, 0, last, Some(last), last + secs(20)));
        // 4 new after a tick: still below the burst threshold.
        assert!(!tick_due(4, 0, last, Some(last), last + secs(12)));
        // v3 (plan 068 D7): 200 transcript chars tick on their own once the
        // idle interval passed, never before, never under the 8 s floor,
        // never at 199 chars.
        assert!(!tick_due(0, 199, start, None, start + secs(60)));
        assert!(!tick_due(0, 200, start, None, start + secs(19)));
        assert!(tick_due(0, 200, start, None, start + secs(20)));
        assert!(!tick_due(0, 5000, last, Some(last), last + secs(7)));
        assert!(!tick_due(0, 5000, last, Some(last), last + secs(19)));
        assert!(tick_due(0, 5000, last, Some(last), last + secs(20)));
        // Speech never turns a trickle into a burst.
        assert!(!tick_due(1, 5000, last, Some(last), last + secs(19)));
        assert!(tick_due(1, 5000, last, Some(last), last + secs(20)));
    }

    // --- Automatic on-stream cards (plan 060 S1) -----------------------------

    fn auto_candidate(
        id: &str,
        author: &str,
        score: f64,
        highlight_type: CohostHighlightType,
    ) -> AutoHighlightCandidate {
        AutoHighlightCandidate {
            message_id: id.to_string(),
            author: author.to_string(),
            roles: Vec::new(),
            source: CohostAutoHighlightSource::Pick,
            highlight_type,
            score,
            age: secs(10),
            flagged: false,
            flag_dismissed: false,
            deleted: false,
        }
    }

    fn auto_input(candidates: Vec<AutoHighlightCandidate>) -> AutoHighlightInput {
        AutoHighlightInput {
            picks_enabled: true,
            voice_enabled: true,
            card: AutoHighlightCard::None,
            since_last_card_end: None,
            last_author: None,
            recent_types: Vec::new(),
            tension: Some(0.2),
            candidates,
            voice: None,
            voice_refreshed: false,
            shown: HashSet::new(),
        }
    }

    fn picked(input: &AutoHighlightInput) -> Option<String> {
        auto_highlight_pick(input).map(|decision| decision.message_id)
    }

    #[test]
    fn auto_highlight_matrix_matches_the_contract() {
        use CohostHighlightType::{Joke, Praise};
        let joke = auto_candidate("m-joke", "twitch:alice", 0.8, Joke);
        let praise = auto_candidate("m-praise", "twitch:bob", 0.6, Praise);
        let base = auto_input(vec![joke.clone(), praise.clone()]);

        // Best score wins; no card yet this session means no cooldown.
        let decision = auto_highlight_pick(&base).unwrap();
        assert_eq!(
            decision,
            AutoHighlightDecision {
                message_id: "m-joke".into(),
                author: "twitch:alice".into(),
                source: CohostAutoHighlightSource::Pick,
                highlight_type: Some(Joke),
                refresh: false,
            }
        );

        // Cooldown: 45 s from the previous card's end, whoever set it.
        let mut input = base.clone();
        input.since_last_card_end = Some(secs(44));
        assert_eq!(picked(&input), None);
        input.since_last_card_end = Some(secs(45));
        assert_eq!(picked(&input).as_deref(), Some("m-joke"));

        // Never while a card is live or applying.
        input = base.clone();
        input.card = AutoHighlightCard::Live {
            message_id: "m-other".into(),
            engine_set: true,
            remaining: secs(5),
        };
        assert_eq!(picked(&input), None);
        input.card = AutoHighlightCard::Applying;
        assert_eq!(picked(&input), None);

        // Never the previous automatic author.
        input = base.clone();
        input.last_author = Some("twitch:alice".into());
        assert_eq!(picked(&input).as_deref(), Some("m-praise"));

        // Not the same type three times in a row when an alternative exists.
        input = base.clone();
        input.recent_types = vec![Joke, Joke];
        assert_eq!(picked(&input).as_deref(), Some("m-praise"));
        input.candidates = vec![joke.clone()];
        assert_eq!(picked(&input).as_deref(), Some("m-joke"));
        input.candidates = vec![joke.clone(), praise.clone()];
        input.recent_types = vec![Praise, Joke];
        assert_eq!(picked(&input).as_deref(), Some("m-joke"));

        // Never a message older than 120 s.
        input = base.clone();
        input.candidates[0].age = secs(120);
        assert_eq!(picked(&input).as_deref(), Some("m-joke"));
        input.candidates[0].age = secs(121);
        assert_eq!(picked(&input).as_deref(), Some("m-praise"));

        // Never while tension is 0.7 or higher.
        input = base.clone();
        input.tension = Some(0.7);
        assert_eq!(picked(&input), None);
        input.tension = Some(0.69);
        assert_eq!(picked(&input).as_deref(), Some("m-joke"));
        input.tension = None;
        assert_eq!(picked(&input).as_deref(), Some("m-joke"));

        // Never the broadcaster.
        input = base.clone();
        input.candidates[0].roles = vec!["owner".into(), "mod".into()];
        assert_eq!(picked(&input).as_deref(), Some("m-praise"));

        // Safety gate at fire time: flagged since, flag-dismissed, deleted.
        input = base.clone();
        input.candidates[0].flagged = true;
        assert_eq!(picked(&input).as_deref(), Some("m-praise"));
        input = base.clone();
        input.candidates[0].flag_dismissed = true;
        assert_eq!(picked(&input).as_deref(), Some("m-praise"));
        input = base.clone();
        input.candidates[0].deleted = true;
        assert_eq!(picked(&input).as_deref(), Some("m-praise"));

        // Shown once per session.
        input = base.clone();
        input.shown.insert("m-joke".into());
        assert_eq!(picked(&input).as_deref(), Some("m-praise"));
        input.shown.insert("m-praise".into());
        assert_eq!(picked(&input), None);

        // Role bonus on top of the server score: +0.15 member/subscriber/vip,
        // +0.10 mod, best role once.
        input = base.clone();
        input.candidates[1].roles = vec!["subscriber".into()];
        assert_eq!(picked(&input).as_deref(), Some("m-joke")); // 0.75 < 0.8
        input.candidates[1].score = 0.7;
        assert_eq!(picked(&input).as_deref(), Some("m-praise")); // 0.85 > 0.8
        input.candidates[1].roles = vec!["mod".into()];
        assert_eq!(picked(&input).as_deref(), Some("m-joke")); // 0.80 does not beat 0.8
        input.candidates[1].roles = vec!["mod".into(), "vip".into()];
        assert_eq!(picked(&input).as_deref(), Some("m-praise")); // best role once: 0.85

        // A high-priority question competes at 0.5 plus the role bonus.
        let mut question = auto_candidate("m-q", "twitch:dave", 0.5, CohostHighlightType::Question);
        question.source = CohostAutoHighlightSource::Question;
        input = auto_input(vec![praise.clone(), question.clone()]);
        assert_eq!(picked(&input).as_deref(), Some("m-praise"));
        input.candidates[1].roles = vec!["vip".into()];
        assert_eq!(picked(&input).as_deref(), Some("m-q")); // 0.65 > 0.6
        assert_eq!(
            auto_highlight_pick(&input).unwrap().source,
            CohostAutoHighlightSource::Question
        );

        // Deterministic ties: equal score and age fall back to the id.
        let mut a = auto_candidate("m-b", "twitch:x", 0.5, Joke);
        let b = auto_candidate("m-a", "twitch:y", 0.5, Joke);
        input = auto_input(vec![a.clone(), b.clone()]);
        assert_eq!(picked(&input).as_deref(), Some("m-a"));
        a.age = secs(20);
        input = auto_input(vec![a, b]);
        assert_eq!(picked(&input).as_deref(), Some("m-b"));

        // Picks need the setting.
        input = base.clone();
        input.picks_enabled = false;
        assert_eq!(picked(&input), None);
    }

    #[test]
    fn auto_highlight_voice_rules() {
        use CohostHighlightType::{Joke, Other};
        let joke = auto_candidate("m-joke", "twitch:alice", 0.8, Joke);
        let mut voice = auto_candidate("m-voice", "twitch:carol", 0.0, Other);
        voice.source = CohostAutoHighlightSource::Voice;
        voice.age = secs(600);
        let mut base = auto_input(vec![joke]);
        base.voice = Some(voice.clone());
        base.since_last_card_end = Some(secs(3));

        // Voice bypasses the cooldown and the age rule.
        assert_eq!(
            auto_highlight_pick(&base).unwrap(),
            AutoHighlightDecision {
                message_id: "m-voice".into(),
                author: "twitch:carol".into(),
                source: CohostAutoHighlightSource::Voice,
                highlight_type: None,
                refresh: false,
            }
        );

        // Voice needs its own setting; picks stay under the cooldown.
        let mut input = base.clone();
        input.voice_enabled = false;
        assert_eq!(picked(&input), None);
        input.since_last_card_end = Some(secs(45));
        assert_eq!(picked(&input).as_deref(), Some("m-joke"));

        // A pick candidate never rides in through the voice slot, and a voice
        // candidate never rides in through the pick list.
        input = base.clone();
        input.voice.as_mut().unwrap().source = CohostAutoHighlightSource::Pick;
        assert_eq!(picked(&input), None);
        input = base.clone();
        input.voice = None;
        input.candidates.push(voice.clone());
        input.since_last_card_end = None;
        assert_eq!(picked(&input).as_deref(), Some("m-joke"));

        // Voice never replaces a card the streamer set by hand, nor another
        // engine card.
        input = base.clone();
        input.card = AutoHighlightCard::Live {
            message_id: "m-manual".into(),
            engine_set: false,
            remaining: secs(1),
        };
        assert_eq!(picked(&input), None);
        input.card = AutoHighlightCard::Live {
            message_id: "m-joke".into(),
            engine_set: true,
            remaining: secs(1),
        };
        assert_eq!(picked(&input), None);
        input.card = AutoHighlightCard::Applying;
        assert_eq!(picked(&input), None);

        // One refresh of its own card, when the match persists into the last
        // seconds of the first lifetime.
        let own_card = |remaining: Duration| AutoHighlightCard::Live {
            message_id: "m-voice".into(),
            engine_set: true,
            remaining,
        };
        input = base.clone();
        input.card = own_card(secs(2));
        let refresh = auto_highlight_pick(&input).unwrap();
        assert!(refresh.refresh);
        assert_eq!(refresh.message_id, "m-voice");
        input.card = own_card(secs(3));
        assert_eq!(picked(&input), None);
        input.card = own_card(secs(2));
        input.voice_refreshed = true;
        assert_eq!(picked(&input), None);
        input.voice_refreshed = false;
        input.voice.as_mut().unwrap().flagged = true;
        assert_eq!(picked(&input), None);
        // A card set by hand is never refreshed, even for the same message.
        input = base.clone();
        input.card = AutoHighlightCard::Live {
            message_id: "m-voice".into(),
            engine_set: false,
            remaining: secs(1),
        };
        assert_eq!(picked(&input), None);

        // Everything else still applies: the safety gate, the broadcaster,
        // the previous author, tension, and shown-once after the card ended.
        input = base.clone();
        input.voice.as_mut().unwrap().flagged = true;
        assert_eq!(picked(&input), None);
        input = base.clone();
        input.voice.as_mut().unwrap().deleted = true;
        assert_eq!(picked(&input), None);
        input = base.clone();
        input.voice.as_mut().unwrap().roles = vec!["owner".into()];
        assert_eq!(picked(&input), None);
        input = base.clone();
        input.last_author = Some("twitch:carol".into());
        assert_eq!(picked(&input), None);
        input = base.clone();
        input.tension = Some(0.7);
        assert_eq!(picked(&input), None);
        input = base.clone();
        input.shown.insert("m-voice".into());
        assert_eq!(picked(&input), None);
    }

    fn tick_highlight(
        message_id: &str,
        score: f64,
        highlight_type: CohostHighlightType,
    ) -> crate::videorc_api::CohostTickHighlight {
        crate::videorc_api::CohostTickHighlight {
            message_id: message_id.to_string(),
            score,
            highlight_type,
        }
    }

    fn live_card(message_id: &str, remaining: Duration) -> OverlayObservation {
        OverlayObservation {
            live_message_id: Some(message_id.to_string()),
            remaining,
        }
    }

    #[test]
    fn engine_auto_highlight_reads_engine_state_and_the_overlay() {
        let start = Instant::now();
        let mut engine = CohostEngine::new(CohostSettings {
            auto_highlight: true,
            ..enabled_settings()
        });
        let generation = engine.start_session("session-1".to_string(), true, None, start);
        let rows = messages("session-1", 0..3);
        engine.note_messages_at(&rows, start);
        let mut tick = response(Vec::new());
        tick.highlights = vec![
            tick_highlight(&rows[1].id, 0.9, CohostHighlightType::Joke),
            tick_highlight(&rows[0].id, 0.7, CohostHighlightType::Praise),
        ];
        let t = start + secs(20);
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), t, "2026-08-22T10:00:20Z"));
        let idle = OverlayObservation::default();

        // The best pick fires once and rides the snapshot.
        let command = engine
            .evaluate_auto_highlight(generation, &idle, t)
            .unwrap();
        assert_eq!(
            command,
            CohostAutoHighlight {
                generation: 1,
                message_id: rows[1].id.clone(),
                source: CohostAutoHighlightSource::Pick,
                refresh: false,
            }
        );
        assert_eq!(engine.snapshot().auto_highlight, Some(command.clone()));
        let json = serde_json::to_value(engine.snapshot()).unwrap();
        assert_eq!(json["autoHighlight"]["source"], "pick");
        assert_eq!(json["autoHighlight"]["generation"], 1);

        // Applying: nothing else fires until the card shows up.
        assert!(
            engine
                .evaluate_auto_highlight(generation, &idle, t + secs(1))
                .is_none()
        );
        // Live: nothing fires while it is on stream, and the fulfilled
        // command leaves the snapshot (a reconnecting renderer must never
        // replay it).
        let live = live_card(&rows[1].id, secs(10));
        assert!(
            engine
                .evaluate_auto_highlight(generation, &live, t + secs(2))
                .is_none()
        );
        assert_eq!(engine.snapshot().auto_highlight, None);
        // It expires at t+12; the next pick waits 45 s from then and skips
        // the previous author's row if it were the same person (it is not).
        assert!(
            engine
                .evaluate_auto_highlight(generation, &idle, t + secs(13))
                .is_none()
        );
        assert!(
            engine
                .evaluate_auto_highlight(generation, &idle, t + secs(56))
                .is_none()
        );
        let second = engine
            .evaluate_auto_highlight(generation, &idle, t + secs(57))
            .unwrap();
        assert_eq!(second.message_id, rows[0].id);
        assert_eq!(second.generation, 2);
        assert_eq!(engine.snapshot().auto_highlight, Some(second));

        // A replaced generation never decides.
        assert!(
            engine
                .evaluate_auto_highlight(generation + 1, &idle, t + secs(120))
                .is_none()
        );
    }

    #[test]
    fn engine_auto_highlight_command_is_dropped_when_the_renderer_never_serves_it() {
        let start = Instant::now();
        let mut engine = CohostEngine::new(CohostSettings {
            auto_highlight: true,
            ..enabled_settings()
        });
        let generation = engine.start_session("session-1".to_string(), true, None, start);
        let rows = messages("session-1", 0..2);
        engine.note_messages_at(&rows, start);
        let mut tick = response(Vec::new());
        tick.highlights = vec![tick_highlight(&rows[0].id, 0.9, CohostHighlightType::Joke)];
        let t = start + secs(20);
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), t, "2026-08-22T10:00:20Z"));
        let idle = OverlayObservation::default();
        let command = engine
            .evaluate_auto_highlight(generation, &idle, t)
            .unwrap();
        assert_eq!(engine.snapshot().auto_highlight, Some(command));

        // The card never shows up (message gone from the renderer's list):
        // after the apply timeout the command leaves the snapshot, and the
        // message is not asked for again.
        assert!(
            engine
                .evaluate_auto_highlight(generation, &idle, t + AUTO_HIGHLIGHT_APPLY_TIMEOUT)
                .is_none()
        );
        assert!(engine.snapshot().auto_highlight.is_some());
        assert!(
            engine
                .evaluate_auto_highlight(
                    generation,
                    &idle,
                    t + AUTO_HIGHLIGHT_APPLY_TIMEOUT + secs(1)
                )
                .is_none()
        );
        assert_eq!(engine.snapshot().auto_highlight, None);
        // Still the only suggestion, still not asked for again.
        assert!(
            engine
                .evaluate_auto_highlight(generation, &idle, t + secs(60))
                .is_none()
        );
    }

    #[test]
    fn engine_auto_highlight_counts_manual_cards_and_forgets_on_restart() {
        let start = Instant::now();
        let mut engine = CohostEngine::new(CohostSettings {
            auto_highlight: true,
            ..enabled_settings()
        });
        let generation = engine.start_session("session-1".to_string(), true, None, start);
        let rows = messages("session-1", 0..3);
        engine.note_messages_at(&rows, start);
        let mut tick = response(Vec::new());
        tick.highlights = vec![
            tick_highlight(&rows[0].id, 0.9, CohostHighlightType::Joke),
            tick_highlight(&rows[1].id, 0.8, CohostHighlightType::Praise),
            tick_highlight(&rows[2].id, 0.5, CohostHighlightType::Insight),
        ];
        let t = start + secs(20);
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), t, "2026-08-22T10:00:20Z"));
        let idle = OverlayObservation::default();

        // The streamer shows the best row by hand (H): it is shown for the
        // session and the cooldown runs from its expiry.
        let manual = live_card(&rows[0].id, secs(4));
        assert!(
            engine
                .evaluate_auto_highlight(generation, &manual, t)
                .is_none()
        );
        assert!(
            engine
                .evaluate_auto_highlight(generation, &idle, t + secs(5))
                .is_none()
        );
        assert!(
            engine
                .evaluate_auto_highlight(generation, &idle, t + secs(48))
                .is_none()
        );
        let first = engine
            .evaluate_auto_highlight(generation, &idle, t + secs(49))
            .unwrap();
        assert_eq!(first.message_id, rows[1].id);

        // The renderer never sets it (message gone): the request times out
        // and the policy moves on without re-asking for the same message.
        assert!(
            engine
                .evaluate_auto_highlight(generation, &idle, t + secs(50))
                .is_none()
        );
        let next = engine
            .evaluate_auto_highlight(generation, &idle, t + secs(58))
            .unwrap();
        assert_eq!(next.message_id, rows[2].id);
        assert_eq!(next.generation, 2);

        // A tombstone for a pending pick drops it at fire time.
        let generation = engine.start_session("session-2".to_string(), true, None, start);
        let rows = messages("session-2", 0..2);
        engine.note_messages_at(&rows, start);
        let mut tick = response(Vec::new());
        tick.highlights = vec![
            tick_highlight(&rows[0].id, 0.9, CohostHighlightType::Joke),
            tick_highlight(&rows[1].id, 0.4, CohostHighlightType::Praise),
        ];
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), t, "2026-08-22T10:00:20Z"));
        let mut tombstone = rows[0].clone();
        tombstone.is_deleted = true;
        engine.note_messages_at(&[tombstone], t);
        // No history carried over: the new session fires at once, with the
        // engine-wide generation still counting up.
        let command = engine
            .evaluate_auto_highlight(generation, &idle, t + secs(1))
            .unwrap();
        assert_eq!(command.message_id, rows[1].id);
        assert_eq!(command.generation, 3);

        // The setting off: the overlay is still observed, nothing fires.
        let mut off = CohostEngine::new(enabled_settings());
        let generation = off.start_session("session-3".to_string(), true, None, start);
        let rows = messages("session-3", 0..1);
        off.note_messages_at(&rows, start);
        let mut tick = response(Vec::new());
        tick.highlights = vec![tick_highlight(&rows[0].id, 0.9, CohostHighlightType::Joke)];
        assert!(off.apply_tick_result(generation, 0, Ok(tick), t, "2026-08-22T10:00:20Z"));
        assert!(off.evaluate_auto_highlight(generation, &idle, t).is_none());
        assert_eq!(off.snapshot().auto_highlight, None);
        assert!(
            serde_json::to_value(off.snapshot())
                .unwrap()
                .get("autoHighlight")
                .is_none()
        );
    }

    // --- Spotlight lane (plan 060 S3) ------------------------------------------

    const ISO: &str = "2026-08-22T10:00:20Z";

    fn transcript(text: &str, version: u64, last_final_at: Instant) -> TranscriptSnapshot {
        TranscriptSnapshot {
            text: text.to_string(),
            version,
            last_final_at: Some(last_final_at),
        }
    }

    fn spotlight_match(
        message_id: &str,
        about: f64,
        question: Option<(&str, f64)>,
    ) -> crate::videorc_api::CohostSpotlightMatch {
        crate::videorc_api::CohostSpotlightMatch {
            message_id: message_id.to_string(),
            question_id: question.map(|(id, _)| id.to_string()),
            about,
            answered: question.map(|(_, answered)| answered),
        }
    }

    fn spotlight_response(
        matches: Vec<crate::videorc_api::CohostSpotlightMatch>,
    ) -> CohostSpotlightResponse {
        CohostSpotlightResponse {
            seq: 1,
            matches,
            usage: None,
        }
    }

    /// Drive one spotlight call through `prepare_spotlight`; the transcript
    /// changed (`version`) and its last final landed one second ago. A fresh
    /// chat row lands first so the 120 s candidate window is never empty
    /// however far the test clock has moved.
    fn send_spotlight(
        engine: &mut CohostEngine,
        generation: u64,
        version: u64,
        now: Instant,
    ) -> Option<PreparedSpotlight> {
        let seq = 1000 + u32::try_from(version).unwrap_or(0);
        let fresh = chat_message(
            "session-1",
            seq,
            &format!("2026-08-22T12:{:02}:{:02}Z", (seq / 60) % 60, seq % 60),
        );
        engine.note_messages_at(&[fresh], now);
        match engine.prepare_spotlight(
            generation,
            true,
            true,
            &transcript("so about the keyboard", version, now - secs(1)),
            now,
        ) {
            SpotlightPass::Send(prepared) => Some(prepared),
            _ => None,
        }
    }

    #[test]
    fn transcript_window_trims_by_time_and_chars() {
        let start = Instant::now();
        let mut window = TranscriptWindow::default();
        window.push("  hello   world ", start);
        assert_eq!(window.snapshot(start).text, "hello world");
        assert_eq!(window.snapshot(start).version, 1);
        // An empty final is not news.
        window.push("   ", start + secs(1));
        assert_eq!(window.snapshot(start + secs(1)).version, 1);
        window.push("second", start + secs(5));
        let snapshot = window.snapshot(start + secs(5));
        assert_eq!(snapshot.text, "hello world second");
        assert_eq!(snapshot.version, 2);
        assert_eq!(snapshot.last_final_at, Some(start + secs(5)));
        // Time: a final leaves the snapshot 20 s after it landed, and is
        // trimmed for real on the next push.
        assert_eq!(window.snapshot(start + secs(19)).text, "hello world second");
        assert_eq!(window.snapshot(start + secs(20)).text, "second");
        window.push("third", start + secs(21));
        assert_eq!(window.finals.len(), 2);
        assert_eq!(window.snapshot(start + secs(21)).text, "second third");
        assert_eq!(window.snapshot(start + secs(60)).text, "");
        window.clear();
        assert_eq!(window.snapshot(start + secs(21)).text, "");
        assert_eq!(window.snapshot(start + secs(21)).last_final_at, None);
        assert_eq!(window.finals.len(), 0);

        // Chars: the joined text never exceeds 800; the oldest finals go.
        let mut window = TranscriptWindow::default();
        for step in 0..10u64 {
            window.push(&"a".repeat(100), start + Duration::from_millis(step));
        }
        let text = window.snapshot(start + secs(1)).text;
        assert!(text.chars().count() <= SPOTLIGHT_TRANSCRIPT_MAX_CHARS);
        assert_eq!(window.finals.len(), 7);
        assert_eq!(text.chars().count(), 7 * 100 + 6);
        // One oversized final keeps its tail.
        let mut window = TranscriptWindow::default();
        window.push(&format!("{}TAIL", "b".repeat(900)), start);
        let text = window.snapshot(start).text;
        assert_eq!(text.chars().count(), SPOTLIGHT_TRANSCRIPT_MAX_CHARS);
        assert!(text.ends_with("TAIL"));
    }

    #[test]
    fn spotlight_cadence_matrix_matches_the_contract() {
        let start = Instant::now();
        let empty = TranscriptSnapshot {
            text: String::new(),
            version: 3,
            last_final_at: Some(start),
        };
        // Nothing said: never.
        assert!(!spotlight_due(
            &empty,
            None,
            None,
            false,
            None,
            start + secs(5)
        ));
        // First call: one second after the final.
        let first = transcript("words", 1, start);
        assert!(!spotlight_due(
            &first,
            None,
            None,
            false,
            None,
            start + Duration::from_millis(999)
        ));
        assert!(spotlight_due(
            &first,
            None,
            None,
            false,
            None,
            start + secs(1)
        ));
        // Never while one is outstanding.
        assert!(!spotlight_due(
            &first,
            None,
            None,
            true,
            None,
            start + secs(5)
        ));
        // The window did not change since the last call: never.
        assert!(!spotlight_due(
            &first,
            Some(1),
            Some(start + secs(1)),
            false,
            None,
            start + secs(30)
        ));
        // Changed, but within 2.5 s of the previous call: wait.
        let second = transcript("more words", 2, start + secs(1));
        let last_call = Some(start + secs(1));
        assert!(!spotlight_due(
            &second,
            Some(1),
            last_call,
            false,
            None,
            start + secs(3)
        ));
        assert!(spotlight_due(
            &second,
            Some(1),
            last_call,
            false,
            None,
            start + Duration::from_millis(3500)
        ));
        // Breaker: closed until `off_until`, then open.
        let off = Some(start + secs(60));
        assert!(!spotlight_due(
            &second,
            Some(1),
            None,
            false,
            off,
            start + secs(59)
        ));
        assert!(spotlight_due(
            &second,
            Some(1),
            None,
            false,
            off,
            start + secs(60)
        ));
    }

    #[test]
    fn spotlight_breaker_transitions_including_retry_after() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..3);
        engine.note_messages_at(&rows, start);
        let mut t = start + secs(2);
        let mut version = 1;
        let fail = |engine: &mut CohostEngine, t: Instant, version: u64, error: CohostApiError| {
            let prepared = send_spotlight(engine, generation, version, t).expect("lane open");
            assert_eq!(prepared.generation, generation);
            engine
                .apply_spotlight_result(generation, Err(error), t, ISO)
                .unwrap()
        };

        // Two failures in a row: the lane stays open.
        for _ in 0..2 {
            let outcome = fail(
                &mut engine,
                t,
                version,
                server_error(502, "ai-gateway-error", "boom"),
            );
            assert_eq!(outcome.lane_off_for, None);
            assert!(!outcome.changed);
            t += secs(3);
            version += 1;
        }
        // The third closes it for 60 s.
        let outcome = fail(
            &mut engine,
            t,
            version,
            server_error(502, "ai-gateway-error", "boom"),
        );
        assert_eq!(outcome.lane_off_for, Some(secs(60)));
        t += secs(3);
        version += 1;
        assert!(send_spotlight(&mut engine, generation, version, t).is_none());
        t += secs(60);
        version += 1;
        assert!(send_spotlight(&mut engine, generation, version, t).is_some());
        // A success resets the count: two more failures keep it open.
        assert!(
            engine
                .apply_spotlight_result(generation, Ok(spotlight_response(Vec::new())), t, ISO)
                .unwrap()
                .lane_off_for
                .is_none()
        );
        t += secs(3);
        version += 1;
        for _ in 0..2 {
            let outcome = fail(
                &mut engine,
                t,
                version,
                CohostApiError::timeout("Golem did not answer within 3 s."),
            );
            assert_eq!(outcome.lane_off_for, None);
            t += secs(3);
            version += 1;
        }
        // The tick's state never moved: still listening, no reason, no detail.
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.status, CohostStatus::Listening);
        assert_eq!(snapshot.reason, None);
        assert_eq!(snapshot.detail, None);
        assert!(!snapshot.tick_in_flight);

        // "Not on this server" answers close the lane for five minutes.
        for error in [
            server_error(404, "not-found", "no route"),
            server_error(503, "spotlight-disabled", "off"),
            server_error(503, "judge-unconfigured", "no model"),
            server_error(403, "premium-required", "upgrade"),
        ] {
            let outcome = fail(&mut engine, t, version, error);
            assert_eq!(outcome.lane_off_for, Some(secs(300)));
            t += secs(3);
            version += 1;
            assert!(send_spotlight(&mut engine, generation, version, t).is_none());
            t += secs(300);
            version += 1;
            assert!(send_spotlight(&mut engine, generation, version, t).is_some());
            engine.apply_spotlight_result(generation, Ok(spotlight_response(Vec::new())), t, ISO);
            t += secs(3);
            version += 1;
        }
        // Quota: off until Retry-After; without one, the unavailable window.
        let quota = crate::videorc_api::classify_cohost_failure(
            429,
            "quota-exhausted",
            "later".to_string(),
            Some("42"),
        );
        let outcome = fail(&mut engine, t, version, quota);
        assert_eq!(outcome.lane_off_for, Some(secs(42)));
        t += secs(3);
        version += 1;
        assert!(send_spotlight(&mut engine, generation, version, t).is_none());
        t += secs(40);
        version += 1;
        assert!(send_spotlight(&mut engine, generation, version, t).is_some());
        let outcome = engine
            .apply_spotlight_result(
                generation,
                Err(server_error(429, "quota-exhausted", "later")),
                t,
                ISO,
            )
            .unwrap();
        assert_eq!(outcome.lane_off_for, Some(secs(300)));
        assert_eq!(engine.snapshot().status, CohostStatus::Listening);
        assert_eq!(engine.snapshot().reason, None);
    }

    #[test]
    fn spotlight_preconditions_and_stop_conditions() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..2);
        engine.note_messages_at(&rows, start);
        let t = start + secs(2);
        let window = transcript("words", 1, t - secs(1));
        // Not Premium / signed out: idle, never a pause of its own.
        assert_eq!(
            engine.prepare_spotlight(generation, true, false, &window, t),
            SpotlightPass::Idle
        );
        assert_eq!(
            engine.prepare_spotlight(generation, false, true, &window, t),
            SpotlightPass::Idle
        );
        assert_eq!(engine.snapshot().status, CohostStatus::Listening);
        // A replaced generation stops the lane.
        assert_eq!(
            engine.prepare_spotlight(generation + 1, true, true, &window, t),
            SpotlightPass::Stopped
        );
        // Paused engine (tick precondition): idle.
        engine
            .session
            .as_mut()
            .unwrap()
            .pause(CohostReason::SignedOut, t);
        assert_eq!(
            engine.prepare_spotlight(generation, true, true, &window, t),
            SpotlightPass::Idle
        );
        engine.session.as_mut().unwrap().status = CohostStatus::Listening;
        // No candidates (nothing noted in the last 120 s): idle.
        let mut empty = CohostEngine::new(enabled_settings());
        let empty_generation = empty.start_session("session-2".to_string(), true, None, start);
        assert_eq!(
            empty.prepare_spotlight(empty_generation, true, true, &window, t),
            SpotlightPass::Idle
        );
        // All good: the request carries the transcript, the seq and consent.
        let SpotlightPass::Send(prepared) =
            engine.prepare_spotlight(generation, true, true, &window, t)
        else {
            panic!("expected a spotlight call");
        };
        assert_eq!(prepared.request.seq, 1);
        assert_eq!(prepared.request.transcript, "words");
        assert!(prepared.request.consent_to_process_chat);
        assert_eq!(prepared.request.session_client_id, "session-1");
        assert_eq!(prepared.request.candidates.len(), 2);
        let json = serde_json::to_value(&prepared.request).unwrap();
        assert_eq!(
            json.as_object().unwrap().keys().collect::<Vec<_>>(),
            [
                "candidates",
                "clientVersion",
                "consentToProcessChat",
                "seq",
                "sessionClientId",
                "transcript"
            ]
        );
        assert_eq!(json["candidates"][0]["roles"], serde_json::json!(["mod"]));
        assert!(json["candidates"][0].get("questionId").is_none());
        // Turned off: stopped.
        engine.settings.enabled = false;
        assert_eq!(
            engine.prepare_spotlight(generation, true, true, &window, t),
            SpotlightPass::Stopped
        );
    }

    #[test]
    fn spotlight_merges_with_a_concurrent_tick() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..6);
        engine.note_messages_at(&rows, start);
        let t = start + secs(2);
        // The spotlight call goes out first...
        let prepared = send_spotlight(&mut engine, generation, 1, t).unwrap();
        // ...then a burst tick goes out and lands while it is outstanding.
        let tick = engine.prepare_tick(generation, true, true, t).unwrap();
        assert!(engine.snapshot().tick_in_flight);
        assert!(engine.apply_tick_result(
            tick.generation,
            0,
            Ok(response(vec![question("q-1", &[&rows[0].id])])),
            t + secs(1),
            ISO
        ));
        // The spotlight answer lands last: both merge by message id.
        let outcome = engine
            .apply_spotlight_result(
                prepared.generation,
                Ok(spotlight_response(vec![
                    spotlight_match(&rows[0].id, 0.9, Some(("q-1", 0.85))),
                    spotlight_match(&rows[1].id, 0.7, None),
                ])),
                t + secs(2),
                ISO,
            )
            .unwrap();
        assert!(outcome.changed);
        assert_eq!(outcome.spotlight_set, Some((rows[0].id.clone(), 0.9)));
        assert!(outcome.resolved.is_empty());
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.questions.len(), 1);
        assert_eq!(snapshot.tick_seq, 1);
        assert!(!snapshot.tick_in_flight);
        assert_eq!(snapshot.status, CohostStatus::Listening);
        let spotlight = snapshot.spotlight.unwrap();
        assert_eq!(spotlight.message_id, rows[0].id);
        assert_eq!(spotlight.question_id.as_deref(), Some("q-1"));
        assert_eq!(spotlight.score, 0.9);
        assert_eq!(spotlight.at, ISO);
        assert!(chrono::DateTime::parse_from_rfc3339(&spotlight.expires_at).is_ok());

        // The other order: a tick that flags the spotlit message while the
        // next spotlight call is outstanding clears the spotlight, and the
        // spotlight answer for that message is dropped on receipt.
        let t2 = t + secs(5);
        let prepared = send_spotlight(&mut engine, generation, 2, t2).unwrap();
        let tick = engine
            .prepare_tick(generation, true, true, t2 + secs(10))
            .unwrap_err();
        assert_eq!(tick, TickGate::Idle);
        let mut flagged = response(Vec::new());
        flagged.keep_questions = true;
        flagged.flags = vec![flag(
            &rows[0].id,
            CohostFlagKind::Harassment,
            CohostFlagSeverity::High,
        )];
        engine.session.as_mut().unwrap().in_flight = true;
        assert!(engine.apply_tick_result(generation, 0, Ok(flagged), t2 + secs(1), ISO));
        assert_eq!(engine.snapshot().spotlight, None);
        let outcome = engine
            .apply_spotlight_result(
                prepared.generation,
                Ok(spotlight_response(vec![spotlight_match(
                    &rows[0].id,
                    0.99,
                    None,
                )])),
                t2 + secs(2),
                ISO,
            )
            .unwrap();
        assert_eq!(outcome.spotlight_set, None);
        assert_eq!(engine.snapshot().spotlight, None);
        assert_eq!(engine.snapshot().questions.len(), 1);
        // A late answer for a replaced session changes nothing.
        assert!(
            engine
                .apply_spotlight_result(
                    generation + 1,
                    Ok(spotlight_response(vec![spotlight_match(
                        &rows[1].id,
                        0.99,
                        None
                    )])),
                    t2 + secs(3),
                    ISO,
                )
                .is_none()
        );
        assert_eq!(engine.snapshot().spotlight, None);
    }

    #[test]
    fn spotlight_candidates_cap_exclude_owner_flagged_deleted_old_and_fit_the_budget() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        // An old row (noted 121 s ago), the broadcaster, a row that gets
        // flagged, a row that gets deleted, then 30 fresh rows.
        let old = messages("session-1", 0..1);
        engine.note_messages_at(&old, start - secs(121));
        let mut owner = chat_message("session-1", 1, "2026-08-22T10:01:01Z");
        owner.author_roles = vec!["broadcaster".to_string()];
        engine.note_messages_at(&[owner.clone()], start - secs(60));
        let rows = messages("session-1", 2..34);
        engine.note_messages_at(&rows, start - secs(30));
        let flagged_id = rows[0].id.clone();
        let deleted_id = rows[1].id.clone();
        // Twelve open questions with mixed priorities; each first message is a
        // fresh row. The tick also flags one row.
        let mut tick = response(
            (0..12)
                .map(|index| {
                    let mut item = question(&format!("q-{index:02}"), &[&rows[2 + index].id]);
                    item.priority = if index % 3 == 0 {
                        CohostPriority::High
                    } else if index % 3 == 1 {
                        CohostPriority::Normal
                    } else {
                        CohostPriority::Low
                    };
                    item
                })
                .collect(),
        );
        tick.flags = vec![flag(
            &flagged_id,
            CohostFlagKind::Spam,
            CohostFlagSeverity::Medium,
        )];
        // A question whose first message is the flagged row: no candidate.
        tick.questions.push(question("q-flagged", &[&flagged_id]));
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), start - secs(20), ISO));
        let mut tombstone = rows[1].clone();
        tombstone.is_deleted = true;
        engine.note_messages_at(&[tombstone], start - secs(10));

        let now = start;
        let candidates = engine.session.as_ref().unwrap().spotlight_candidates(now);
        assert_eq!(candidates.len(), SPOTLIGHT_CANDIDATES_CAP);
        let ids: HashSet<&str> = candidates.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids.len(), candidates.len(), "ids are unique");
        assert!(!ids.contains(old[0].id.as_str()), "older than 120 s");
        assert!(!ids.contains(owner.id.as_str()), "the broadcaster");
        assert!(!ids.contains(flagged_id.as_str()), "flagged");
        assert!(!ids.contains(deleted_id.as_str()), "deleted");
        // Questions first: ten of them, high priority first, then normal.
        let with_question: Vec<&CohostSpotlightCandidate> = candidates
            .iter()
            .filter(|c| c.question_id.is_some())
            .collect();
        assert_eq!(with_question.len(), SPOTLIGHT_QUESTION_CANDIDATES_CAP);
        assert!(
            candidates[..SPOTLIGHT_QUESTION_CANDIDATES_CAP]
                .iter()
                .all(|c| c.question_id.is_some())
        );
        let question_ids: Vec<&str> = with_question
            .iter()
            .map(|c| c.question_id.as_deref().unwrap())
            .collect();
        assert_eq!(
            question_ids,
            [
                "q-00", "q-03", "q-06", "q-09", "q-01", "q-04", "q-07", "q-10", "q-02", "q-05"
            ]
        );
        assert_eq!(
            with_question[0].question_text.as_deref(),
            Some("What keyboard is that?")
        );
        assert_eq!(with_question[0].text, rows[2].message_text.trim());
        // Then the newest plain messages, newest first.
        let plain: Vec<&str> = candidates[SPOTLIGHT_QUESTION_CANDIDATES_CAP..]
            .iter()
            .map(|c| c.id.as_str())
            .collect();
        assert_eq!(plain.len(), 10);
        assert_eq!(plain[0], rows[31].id);
        let mut sorted = plain.clone();
        sorted.sort_by(|a, b| b.cmp(a));
        assert_eq!(plain, sorted, "newest first");
        assert!(plain.iter().all(|id| !question_ids.contains(id)));

        // Byte budget: candidates leave from the end until the body fits;
        // at least one always stays.
        let mut request = CohostSpotlightRequest {
            client_version: "videorc-desktop/test".to_string(),
            session_client_id: "session-1".to_string(),
            consent_to_process_chat: true,
            transcript: "t".repeat(800),
            seq: 1,
            candidates: (0..20)
                .map(|index| CohostSpotlightCandidate {
                    id: format!("m-{index}"),
                    text: "x".repeat(500),
                    author: "y".repeat(120),
                    roles: None,
                    at: ISO.to_string(),
                    question_id: None,
                    question_text: None,
                })
                .collect(),
        };
        let full = serde_json::to_vec(&request).unwrap().len();
        assert!(
            full <= COHOST_SPOTLIGHT_MAX_BODY_BYTES,
            "20 max candidates fit: {full}"
        );
        trim_spotlight_request_to_budget(&mut request, COHOST_SPOTLIGHT_MAX_BODY_BYTES);
        assert_eq!(request.candidates.len(), 20);
        trim_spotlight_request_to_budget(&mut request, 4000);
        assert!(request.candidates.len() < 20 && !request.candidates.is_empty());
        assert!(serde_json::to_vec(&request).unwrap().len() <= 4000);
        assert_eq!(request.candidates[0].id, "m-0");
        trim_spotlight_request_to_budget(&mut request, 10);
        assert_eq!(request.candidates.len(), 1);
    }

    #[test]
    fn voice_resolve_needs_two_consecutive_hits_and_restore_puts_it_back() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..3);
        engine.note_messages_at(&rows, start);
        let t = start + secs(2);
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(vec![
                question("q-1", &[&rows[0].id]),
                question("q-2", &[&rows[1].id]),
            ])),
            t,
            ISO
        ));
        let template = engine.snapshot().questions[0].clone();
        let answered = |engine: &mut CohostEngine, at: Instant, hits: &[(&str, &str, f64)]| {
            engine
                .apply_spotlight_result(
                    generation,
                    Ok(spotlight_response(
                        hits.iter()
                            .map(|(id, question_id, answered)| {
                                spotlight_match(id, 0.9, Some((question_id, *answered)))
                            })
                            .collect(),
                    )),
                    at,
                    ISO,
                )
                .unwrap()
        };
        // One hit does nothing.
        let outcome = answered(&mut engine, t + secs(3), &[(&rows[0].id, "q-1", 0.9)]);
        assert!(outcome.resolved.is_empty());
        assert_eq!(engine.snapshot().questions.len(), 2);
        assert!(engine.snapshot().recently_resolved.is_empty());
        // A call without the hit breaks the streak; the next hit starts over.
        answered(&mut engine, t + secs(6), &[(&rows[0].id, "q-1", 0.3)]);
        let outcome = answered(&mut engine, t + secs(9), &[(&rows[0].id, "q-1", 0.95)]);
        assert!(outcome.resolved.is_empty());
        assert_eq!(engine.snapshot().questions.len(), 2);
        // Two in a row: resolved with reason voice, kept for a minute.
        let outcome = answered(
            &mut engine,
            t + secs(12),
            &[(&rows[0].id, "q-1", 0.8), (&rows[1].id, "q-2", 0.79)],
        );
        assert_eq!(outcome.resolved, vec!["q-1".to_string()]);
        assert!(outcome.changed);
        let snapshot = engine.snapshot();
        assert_eq!(
            snapshot
                .questions
                .iter()
                .map(|q| q.id.as_str())
                .collect::<Vec<_>>(),
            ["q-2"]
        );
        assert_eq!(snapshot.recently_resolved.len(), 1);
        assert_eq!(snapshot.recently_resolved[0].question.id, "q-1");
        assert_eq!(
            snapshot.recently_resolved[0].reason,
            CohostResolveReason::Voice
        );
        assert_eq!(snapshot.recently_resolved[0].resolved_at, ISO);
        let json = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(json["recentlyResolved"][0]["reason"], "voice");
        assert_eq!(json["recentlyResolved"][0]["resolvedAt"], ISO);
        assert!(json["recentlyResolved"][0]["question"]["messageIds"].is_array());
        // A later tick cannot bring it back: it is dismissed.
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(vec![
                question("q-1", &[&rows[0].id]),
                question("q-2", &[&rows[1].id]),
            ])),
            t + secs(20),
            ISO
        ));
        assert_eq!(engine.snapshot().questions.len(), 1);

        // Restore: back in the open set, out of the dismissed set and the
        // recently-resolved list; a second restore is a no-op.
        assert_eq!(
            engine.restore_question("session-x", "q-1", t + secs(21)),
            Err(CohostError::SessionMismatch)
        );
        assert_eq!(
            engine.restore_question("session-1", "q-1", t + secs(21)),
            Ok(true)
        );
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.questions.len(), 2);
        assert!(snapshot.questions.iter().any(|q| q.id == "q-1"));
        assert!(snapshot.recently_resolved.is_empty());
        assert!(
            !engine
                .session
                .as_ref()
                .unwrap()
                .dismissed_questions
                .contains("q-1")
        );
        assert!(
            serde_json::to_value(&snapshot)
                .unwrap()
                .get("recentlyResolved")
                .is_none()
        );
        assert_eq!(
            engine.restore_question("session-1", "q-1", t + secs(22)),
            Ok(false)
        );
        // The next tick keeps it (not dismissed any more).
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(vec![question("q-1", &[&rows[0].id])])),
            t + secs(30),
            ISO
        ));
        assert_eq!(engine.snapshot().questions.len(), 1);
        assert_eq!(engine.snapshot().questions[0].id, "q-1");

        // Resolve again; after the minute it can no longer be restored and
        // leaves the state; at most three are kept.
        answered(&mut engine, t + secs(33), &[(&rows[0].id, "q-1", 0.9)]);
        answered(&mut engine, t + secs(36), &[(&rows[0].id, "q-1", 0.9)]);
        assert_eq!(
            engine
                .snapshot_at_for_test(t + secs(36))
                .recently_resolved
                .len(),
            1
        );
        assert!(
            engine
                .snapshot_at_for_test(t + secs(96))
                .recently_resolved
                .is_empty()
        );
        assert_eq!(
            engine.restore_question("session-1", "q-1", t + secs(96)),
            Ok(false)
        );
        let session = engine.session.as_mut().unwrap();
        for index in 0..5 {
            session.questions.push(CohostQuestion {
                id: format!("q-many-{index}"),
                ..template.clone()
            });
            assert!(session.resolve_by_voice(&format!("q-many-{index}"), t + secs(100), ISO));
        }
        assert_eq!(session.recently_resolved.len(), RECENTLY_RESOLVED_CAP);
        assert_eq!(session.recently_resolved[0].entry.question.id, "q-many-2");
    }

    #[test]
    fn spotlight_expiry_refresh_tombstone_and_dismissed_flag() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..3);
        engine.note_messages_at(&rows, start);
        let t = start + secs(2);
        let outcome = engine
            .apply_spotlight_result(
                generation,
                Ok(spotlight_response(vec![
                    // Same score: the earliest message wins the tie.
                    spotlight_match(&rows[1].id, 0.8, None),
                    spotlight_match(&rows[0].id, 0.8, None),
                    spotlight_match(&rows[2].id, 0.74, None),
                    spotlight_match("unknown-id", 1.0, None),
                ])),
                t,
                ISO,
            )
            .unwrap();
        assert_eq!(outcome.spotlight_set, Some((rows[0].id.clone(), 0.8)));
        let json = serde_json::to_value(engine.snapshot_at_for_test(t)).unwrap();
        assert_eq!(json["spotlight"]["messageId"], rows[0].id);
        assert!(json["spotlight"].get("questionId").is_none());
        assert_eq!(json["spotlight"]["score"], 0.8);
        // Below the threshold: nothing changes, the spotlight stays.
        let outcome = engine
            .apply_spotlight_result(
                generation,
                Ok(spotlight_response(vec![spotlight_match(
                    &rows[2].id,
                    0.5,
                    None,
                )])),
                t + secs(3),
                ISO,
            )
            .unwrap();
        assert!(!outcome.changed);
        assert_eq!(
            engine
                .snapshot_at_for_test(t + secs(3))
                .spotlight
                .unwrap()
                .message_id,
            rows[0].id
        );
        // A repeat match refreshes: still the same id, later expiry, no "set".
        let outcome = engine
            .apply_spotlight_result(
                generation,
                Ok(spotlight_response(vec![spotlight_match(
                    &rows[0].id,
                    0.95,
                    None,
                )])),
                t + secs(10),
                ISO,
            )
            .unwrap();
        assert!(outcome.changed);
        assert_eq!(outcome.spotlight_set, None);
        assert!(!engine.expire_spotlight(generation, t + secs(24)));
        let spotlight = engine.snapshot_at_for_test(t + secs(24)).spotlight.unwrap();
        assert_eq!(spotlight.message_id, rows[0].id);
        assert_eq!(spotlight.score, 0.95);
        assert_eq!(spotlight.at, ISO);
        // Expiry: gone 15 s after the last refresh, reported exactly once.
        assert!(
            engine
                .expire_spotlight(generation + 1, t + secs(25))
                .eq(&false)
        );
        assert_eq!(
            engine.snapshot_at_for_test(t + secs(25)).spotlight,
            None,
            "the snapshot never shows an expired spotlight"
        );
        assert!(engine.expire_spotlight(generation, t + secs(25)));
        assert!(!engine.expire_spotlight(generation, t + secs(26)));
        assert!(!engine.has_spotlight());

        // Tombstone: the spotlit message is deleted → the spotlight leaves.
        engine.apply_spotlight_result(
            generation,
            Ok(spotlight_response(vec![spotlight_match(
                &rows[1].id,
                0.9,
                None,
            )])),
            t + secs(30),
            ISO,
        );
        assert!(engine.has_spotlight());
        let mut tombstone = rows[1].clone();
        tombstone.is_deleted = true;
        engine.note_messages_at(&[tombstone], t + secs(31));
        assert!(!engine.has_spotlight());
        assert_eq!(engine.snapshot_at_for_test(t + secs(31)).spotlight, None);
        // A deleted message never matches again.
        let outcome = engine
            .apply_spotlight_result(
                generation,
                Ok(spotlight_response(vec![spotlight_match(
                    &rows[1].id,
                    0.9,
                    None,
                )])),
                t + secs(34),
                ISO,
            )
            .unwrap();
        assert_eq!(outcome.spotlight_set, None);
        assert!(!engine.has_spotlight());

        // Dismissing a flag on the spotlit message clears it too.
        engine.apply_spotlight_result(
            generation,
            Ok(spotlight_response(vec![spotlight_match(
                &rows[2].id,
                0.9,
                None,
            )])),
            t + secs(37),
            ISO,
        );
        assert!(engine.has_spotlight());
        engine.dismiss_flag("session-1", &rows[2].id).unwrap();
        assert!(!engine.has_spotlight());
    }

    #[test]
    fn spotlight_match_on_a_flagged_message_is_dropped_and_voice_feeds_the_pick() {
        let start = Instant::now();
        let mut engine = CohostEngine::new(CohostSettings {
            voice_highlight: true,
            ..enabled_settings()
        });
        let generation = engine.start_session("session-1".to_string(), true, None, start);
        let rows = messages("session-1", 0..3);
        engine.note_messages_at(&rows, start);
        let t = start + secs(2);
        let mut tick = response(Vec::new());
        tick.flags = vec![flag(
            &rows[1].id,
            CohostFlagKind::Harassment,
            CohostFlagSeverity::High,
        )];
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), t, ISO));
        let outcome = engine
            .apply_spotlight_result(
                generation,
                Ok(spotlight_response(vec![
                    spotlight_match(&rows[1].id, 0.99, None),
                    spotlight_match(&rows[2].id, 0.8, None),
                ])),
                t + secs(1),
                ISO,
            )
            .unwrap();
        assert_eq!(outcome.spotlight_set, Some((rows[2].id.clone(), 0.8)));

        // The Voice source reads the live spotlight: with `voiceHighlight`
        // the engine puts it on stream at once (no cooldown, no age rule).
        let idle = OverlayObservation::default();
        let command = engine
            .evaluate_auto_highlight(generation, &idle, t + secs(2))
            .unwrap();
        assert_eq!(command.message_id, rows[2].id);
        assert_eq!(command.source, CohostAutoHighlightSource::Voice);
        assert!(!command.refresh);
        // Once expired, nothing more fires.
        assert!(
            engine
                .evaluate_auto_highlight(generation, &idle, t + secs(40))
                .is_none()
        );
        // The setting off: the spotlight still rides the state (pull-up is
        // always on), but never goes on stream.
        let mut quiet = CohostEngine::new(enabled_settings());
        let generation = quiet.start_session("session-2".to_string(), true, None, start);
        let rows = messages("session-2", 0..1);
        quiet.note_messages_at(&rows, start);
        quiet.apply_spotlight_result(
            generation,
            Ok(spotlight_response(vec![spotlight_match(
                &rows[0].id,
                0.9,
                None,
            )])),
            t,
            ISO,
        );
        assert!(quiet.snapshot_at_for_test(t).spotlight.is_some());
        assert!(
            quiet
                .evaluate_auto_highlight(generation, &idle, t + secs(1))
                .is_none()
        );
    }

    #[test]
    fn overlay_observation_reads_the_highlight_state() {
        let idle = CommentHighlightState::default();
        assert_eq!(
            OverlayObservation::from_highlight(&idle),
            OverlayObservation::default()
        );
        let live = CommentHighlightState {
            session_id: Some("session-1".into()),
            message_id: Some("m-1".into()),
            generation: 3,
            phase: CommentHighlightPhase::Live,
            expires_at: Some((chrono::Utc::now() + chrono::Duration::seconds(9)).to_rfc3339()),
            reason: None,
        };
        let observed = OverlayObservation::from_highlight(&live);
        assert_eq!(observed.live_message_id.as_deref(), Some("m-1"));
        assert!(observed.remaining > secs(7) && observed.remaining <= secs(9));
        let expired = CommentHighlightState {
            expires_at: Some((chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339()),
            ..live.clone()
        };
        assert_eq!(
            OverlayObservation::from_highlight(&expired).remaining,
            Duration::ZERO
        );
        let failed = CommentHighlightState {
            phase: CommentHighlightPhase::Failed,
            ..live
        };
        assert_eq!(
            OverlayObservation::from_highlight(&failed).live_message_id,
            None
        );
    }

    #[test]
    fn engine_cadence_honors_backoff_and_in_flight() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        engine.note_messages(&messages("session-1", 0..5));
        let prepared = engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        assert_eq!(prepared.request.tick_seq, 1);
        assert_eq!(prepared.request.messages.len(), 5);
        // In flight: no second request.
        engine.note_messages(&messages("session-1", 5..10));
        assert_eq!(
            engine
                .prepare_tick(generation, true, true, start + secs(2))
                .err(),
            Some(TickGate::Idle)
        );
        // A network failure schedules a 5 s backoff before the next attempt.
        let failure = Err(CohostApiError::network("offline"));
        assert!(engine.apply_tick_result(generation, 0, failure, start + secs(2), "now"));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.status, CohostStatus::Error);
        assert_eq!(snapshot.reason, Some(CohostReason::Network));
        assert_eq!(
            engine
                .prepare_tick(generation, true, true, start + secs(6))
                .err(),
            Some(TickGate::Idle)
        );
        // 8 s min gap dominates here (last tick at +1 s): due from +9 s.
        assert!(
            engine
                .prepare_tick(generation, true, true, start + secs(9))
                .is_ok()
        );
    }

    #[test]
    fn backoff_ladder_is_5_10_20_40_60_capped() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let mut now = start;
        let mut observed = Vec::new();
        for _ in 0..6 {
            engine.note_messages(&messages("session-1", 0..5));
            // Force the next attempt to be due regardless of the min gap.
            {
                let session = engine.session.as_mut().unwrap();
                session.last_tick_at = None;
                session.known_set.clear();
                session.known_ids.clear();
                session.cursor = None;
            }
            now += secs(61);
            let prepared = engine.prepare_tick(generation, true, true, now).unwrap();
            assert!(!prepared.request.messages.is_empty());
            engine.apply_tick_result(
                generation,
                0,
                Err(server_error(502, "ai-gateway-error", "boom")),
                now,
                "now",
            );
            let next = engine.session.as_ref().unwrap().next_attempt_at.unwrap();
            observed.push(next.duration_since(now).as_secs());
        }
        assert_eq!(observed, vec![5, 10, 20, 40, 60, 60]);
        assert_eq!(engine.snapshot().reason, Some(CohostReason::GatewayError));
    }

    #[test]
    fn delta_cursor_caps_to_newest_sixty_and_counts_dropped() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let noted = engine.note_messages(&messages("session-1", 0..75));
        assert_eq!(noted, 75);
        // Replays at or before the cursor are ignored.
        assert_eq!(engine.note_messages(&messages("session-1", 10..20)), 0);
        let prepared = engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        assert_eq!(prepared.request.messages.len(), TICK_DELTA_CAP);
        assert_eq!(prepared.request.dropped_messages, 15);
        assert_eq!(
            prepared.request.messages.first().unwrap().id,
            chat_message("session-1", 15, "").id
        );
        assert_eq!(
            prepared.request.messages.last().unwrap().id,
            chat_message("session-1", 74, "").id
        );
        // The delta is consumed: nothing pending afterwards.
        engine.apply_tick_result(
            generation,
            prepared.request.dropped_messages,
            Ok(response(Vec::new())),
            start + secs(2),
            "2026-08-22T10:02:00Z",
        );
        let snapshot = engine.snapshot();
        assert!(snapshot.partial);
        assert_eq!(snapshot.tick_seq, 1);
        assert_eq!(
            snapshot.last_tick_at.as_deref(),
            Some("2026-08-22T10:02:00Z")
        );
        assert_eq!(
            engine
                .prepare_tick(generation, true, true, start + secs(60))
                .err(),
            Some(TickGate::Idle)
        );
    }

    #[test]
    fn deleted_system_and_custom_rows_never_enter_a_batch() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let mut rows = messages("session-1", 0..6);
        rows[0].is_deleted = true;
        rows[1].event_type = LiveChatEventType::System;
        rows[2].event_type = LiveChatEventType::Moderation;
        rows[3].platform = StreamPlatform::Custom;
        rows[4].event_type = LiveChatEventType::Paid;
        rows.push(chat_message("other-session", 99, "2026-08-22T10:05:00Z"));
        engine.note_messages(&rows);
        // A tombstone for a pending row removes it.
        let mut tombstone = chat_message("session-1", 5, "2026-08-22T10:09:00Z");
        tombstone.is_deleted = true;
        tombstone.event_type = LiveChatEventType::Deleted;
        engine.note_messages(&[tombstone]);
        assert_eq!(
            engine
                .prepare_tick(generation, true, true, start + secs(30))
                .err(),
            Some(TickGate::Idle)
        );
    }

    #[test]
    fn request_json_matches_the_wire_contract() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let mut row = chat_message("session-1", 1, "2026-08-22T10:01:01Z");
        row.message_text = "x".repeat(600);
        engine.note_messages(&[row.clone()]);
        {
            let session = engine.session.as_mut().unwrap();
            session.questions.push(CohostQuestion {
                id: "q_1".to_string(),
                text: "What keyboard?".to_string(),
                message_ids: vec![row.id.clone()],
                askers: vec!["a".to_string(), "b".to_string(), "c".to_string()],
                platforms: vec![StreamPlatform::Twitch],
                priority: CohostPriority::Normal,
                suggested_reply: String::new(),
                from_notes: false,
                first_seen_at: "t0".to_string(),
                updated_at: "t0".to_string(),
                on_topic: false,
            });
        }
        let prepared = engine
            .prepare_tick(generation, true, true, start + secs(20))
            .unwrap();
        let json = serde_json::to_value(&prepared.request).unwrap();
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "clientVersion",
                "consentToProcessChat",
                "droppedMessages",
                "messages",
                "notes",
                "openQuestions",
                "promptVersion",
                "rules",
                "sessionClientId",
                "streamTitle",
                "tickSeq",
                "tone",
            ]
        );
        assert_eq!(json["promptVersion"], 3);
        // v3 keys ride only with content: nothing said, nothing summarised, no
        // promise → no transcript/summary/openPromises key at all.
        assert_eq!(json["rules"], serde_json::json!([]));
        assert_eq!(json["tickSeq"], 1);
        assert_eq!(json["consentToProcessChat"], true);
        assert_eq!(json["tone"], "short");
        assert_eq!(json["streamTitle"], "Rust night");
        assert_eq!(json["sessionClientId"], "session-1");
        assert_eq!(json["droppedMessages"], 0);
        assert_eq!(json["openQuestions"][0]["id"], "q_1");
        assert_eq!(json["openQuestions"][0]["count"], 3);
        let message = &json["messages"][0];
        let mut message_keys: Vec<&str> = message
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        message_keys.sort_unstable();
        assert_eq!(
            message_keys,
            vec![
                "at",
                "author",
                "firstMessage",
                "id",
                "platform",
                "roles",
                "text"
            ]
        );
        assert_eq!(message["firstMessage"], false);
        assert_eq!(message["platform"], "twitch");
        assert_eq!(message["author"], "Viewer 1");
        assert_eq!(message["roles"], serde_json::json!(["mod"]));
        assert_eq!(message["at"], "2026-08-22T10:00:01Z");
        assert_eq!(message["text"].as_str().unwrap().chars().count(), 500);
        assert!(json.get("streamTitle").is_some());
    }

    #[test]
    fn state_merge_keeps_first_seen_applies_resolved_and_honors_dismissed() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..5);
        engine.note_messages(&rows);
        let prepared = engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        let first = response(vec![
            question("q_1", &[rows[0].id.as_str(), "unknown-id"]),
            question("q_2", &[rows[1].id.as_str()]),
            question("q_3", &[rows[2].id.as_str()]),
        ]);
        assert!(engine.apply_tick_result(prepared.generation, 0, Ok(first), start + secs(2), "t1"));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.status, CohostStatus::Listening);
        assert_eq!(snapshot.mood, Some(CohostMood::Hype));
        assert_eq!(snapshot.questions.len(), 3);
        assert_eq!(snapshot.questions[0].first_seen_at, "t1");
        // Unknown message ids are sanitized away.
        assert_eq!(snapshot.questions[0].message_ids, vec![rows[0].id.clone()]);

        // Answered + dismissed leave the open set and never return.
        assert!(engine.mark_answered("session-1", "q_2").unwrap());
        assert!(!engine.mark_answered("session-1", "q_2").unwrap());
        assert_eq!(
            engine.mark_answered("session-2", "q_1"),
            Err(CohostError::SessionMismatch)
        );

        engine.note_messages(&messages("session-1", 5..10));
        let prepared = engine
            .prepare_tick(generation, true, true, start + secs(30))
            .unwrap();
        assert_eq!(prepared.request.open_questions.len(), 2);
        let mut second = response(vec![
            question("q_1", &[rows[1].id.as_str(), "unknown-id"]),
            question("q_2", &[rows[1].id.as_str()]),
            question("q_4", &[rows[4].id.as_str()]),
        ]);
        second.resolved = vec!["q_3".to_string()];
        second.flags = vec![
            flag(
                &rows[3].id,
                CohostFlagKind::Spam,
                CohostFlagSeverity::Medium,
            ),
            flag(
                "not-ours",
                CohostFlagKind::Toxicity,
                CohostFlagSeverity::High,
            ),
        ];
        assert!(engine.apply_tick_result(generation, 0, Ok(second), start + secs(31), "t2"));
        let snapshot = engine.snapshot();
        let ids: Vec<&str> = snapshot
            .questions
            .iter()
            .map(|question| question.id.as_str())
            .collect();
        assert_eq!(ids, vec!["q_1", "q_4"]);
        assert_eq!(snapshot.questions[0].first_seen_at, "t1");
        assert_eq!(snapshot.questions[0].updated_at, "t2");
        // Kept questions union their sources across ticks (the server only
        // validates ids against the current batch).
        assert_eq!(
            snapshot.questions[0].message_ids,
            vec![rows[0].id.clone(), rows[1].id.clone()]
        );
        assert_eq!(snapshot.questions[1].first_seen_at, "t2");
        assert_eq!(snapshot.flags.len(), 1);
        assert_eq!(snapshot.flags[0].message_id, rows[3].id);
        assert_eq!(snapshot.flags[0].at, "t2");

        assert!(engine.dismiss_flag("session-1", &rows[3].id).unwrap());
        assert!(engine.snapshot().flags.is_empty());
    }

    #[test]
    fn v2_request_carries_the_normalised_rules() {
        let start = Instant::now();
        let mut engine = CohostEngine::new(CohostSettings {
            rules: vec![
                "  No spoilers  ".to_string(),
                String::new(),
                "r".repeat(COHOST_RULE_MAX_CHARS + 30),
            ]
            .into_iter()
            .chain((0..20).map(|index| format!("rule {index}")))
            .collect(),
            ..enabled_settings()
        });
        let generation = engine.start_session("session-1".to_string(), true, None, start);
        engine.note_messages(&messages("session-1", 0..5));
        let prepared = engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        let rules = prepared.request.rules.clone().unwrap();
        assert_eq!(rules.len(), COHOST_RULES_MAX);
        assert_eq!(rules[0], "No spoilers");
        assert_eq!(rules[1].chars().count(), COHOST_RULE_MAX_CHARS);
        assert!(
            rules
                .iter()
                .all(|rule| !rule.is_empty() && rule.chars().count() <= COHOST_RULE_MAX_CHARS)
        );
    }

    #[test]
    fn prompt_version_unsupported_walks_the_ladder_3_2_1_without_pausing() {
        let start = Instant::now();
        let mut engine = CohostEngine::new(CohostSettings {
            rules: vec!["No spoilers".to_string()],
            ..enabled_settings()
        });
        let generation = engine.start_session(
            "session-1".to_string(),
            true,
            Some("Rust night".into()),
            start,
        );
        let rows = messages("session-1", 0..2);
        engine.note_messages(&rows);
        engine.note_speech(generation, &speech(&[(start, "we are talking")]));
        let v3 = engine
            .prepare_tick(generation, true, true, start + secs(20))
            .unwrap();
        assert_eq!(v3.request.prompt_version, 3);
        assert_eq!(v3.request.rules, Some(vec!["No spoilers".to_string()]));
        assert_eq!(v3.request.transcript.as_deref(), Some("we are talking"));
        assert_eq!(v3.request.messages[0].first_message, Some(false));

        // Server rolled back to v2: not an error the streamer sees, no
        // backoff. The batch AND the transcript are back in the delta.
        assert!(engine.apply_tick_result(
            generation,
            0,
            Err(server_error(
                400,
                "prompt-version-unsupported",
                "promptVersion 3 is not supported."
            )),
            start + secs(21),
            "t1",
        ));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.status, CohostStatus::Listening);
        assert_eq!(snapshot.reason, None);
        assert_eq!(snapshot.detail, None);
        assert!(!snapshot.tick_in_flight);
        assert_eq!(snapshot.pending_messages, 2);
        assert_eq!(
            engine.session.as_ref().unwrap().transcript_pending,
            "we are talking"
        );

        // Retried as soon as the contract's 8 s floor allows — not after the
        // 20 s trickle wait two pending rows would normally get.
        assert_eq!(
            engine.prepare_tick(generation, true, true, start + secs(27)),
            Err(TickGate::Idle)
        );
        let v2 = engine
            .prepare_tick(generation, true, true, start + secs(28))
            .unwrap();
        assert_eq!(v2.request.prompt_version, 2);
        // v2 keeps the rules (the gate is `>= 2`, not `== pinned`) and drops
        // every v3 key: byte-identical to what a v2 desktop sends.
        assert_eq!(v2.request.rules, Some(vec!["No spoilers".to_string()]));
        assert_eq!(v2.request.messages.len(), 2);
        assert_eq!(v2.request.messages[0].first_message, None);
        let json = serde_json::to_value(&v2.request).unwrap();
        for key in ["transcript", "summary", "openPromises"] {
            assert!(json.get(key).is_none(), "{key} must not ride a v2 body");
        }
        assert!(json["messages"][0].get("firstMessage").is_none());
        assert_eq!(json.as_object().unwrap().len(), 12);
        // The transcript waits for a server that can take it; below v3 it
        // never drives the cadence.
        assert_eq!(
            engine.session.as_ref().unwrap().transcript_pending_chars(),
            0
        );

        // v2 rejected too: down to v1, no `rules` key at all.
        assert!(engine.apply_tick_result(
            generation,
            0,
            Err(server_error(400, "prompt-version-unsupported", "no v2")),
            start + secs(29),
            "t2",
        ));
        assert_eq!(engine.snapshot().status, CohostStatus::Listening);
        let v1 = engine
            .prepare_tick(generation, true, true, start + secs(37))
            .unwrap();
        assert_eq!(v1.request.prompt_version, 1);
        assert_eq!(v1.request.rules, None);
        assert_eq!(v1.request.messages, v2.request.messages);
        let json = serde_json::to_value(&v1.request).unwrap();
        assert!(json.get("rules").is_none());
        assert_eq!(json["promptVersion"], 1);
        assert_eq!(json.as_object().unwrap().len(), 11);

        // v1 for the rest of the session, back on the normal cadence.
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(Vec::new())),
            start + secs(38),
            "t3"
        ));
        engine.note_messages(&messages("session-1", 2..4));
        assert_eq!(
            engine.prepare_tick(generation, true, true, start + secs(50)),
            Err(TickGate::Idle)
        );
        let next = engine
            .prepare_tick(generation, true, true, start + secs(58))
            .unwrap();
        assert_eq!(next.request.prompt_version, 1);

        // A v1 rejection is a real failure, as before.
        assert!(engine.apply_tick_result(
            generation,
            0,
            Err(server_error(400, "prompt-version-unsupported", "no")),
            start + secs(59),
            "t4",
        ));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.status, CohostStatus::Error);
        assert_eq!(snapshot.reason, Some(CohostReason::ServerUnconfigured));
        assert_eq!(fallback_prompt_version(3), Some(2));
        assert_eq!(fallback_prompt_version(2), Some(1));
        assert_eq!(fallback_prompt_version(1), None);
        assert_eq!(fallback_prompt_version(9), None);

        // A new session starts on v3 again.
        let generation = engine.start_session("session-2".to_string(), true, None, start);
        engine.note_messages(&messages("session-2", 0..5));
        let fresh = engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        assert_eq!(fresh.request.prompt_version, 3);
    }

    fn speech(finals: &[(Instant, &str)]) -> RecentSpeechSnapshot {
        RecentSpeechSnapshot {
            finals: finals
                .iter()
                .map(|(at, text)| RecentSpeechFinal {
                    at: *at,
                    offset_seconds: 0.0,
                    duration_seconds: 1.0,
                    text: text.to_string(),
                    segments: Vec::new(),
                    presented: false,
                })
                .collect(),
            version: finals.len() as u64,
        }
    }

    fn tick_promise(
        id: Option<&str>,
        text: &str,
        kind: CohostPromiseTriggerKind,
        value: Option<f64>,
    ) -> CohostTickPromise {
        CohostTickPromise {
            id: id.map(str::to_string),
            text: text.to_string(),
            trigger: crate::videorc_api::CohostTickPromiseTrigger { kind, value },
        }
    }

    #[test]
    fn v3_request_carries_speech_and_the_response_feeds_topic_summary_and_on_topic() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let mut row = chat_message("session-1", 1, "2026-08-22T10:01:01Z");
        row.first_message = true;
        engine.note_messages(&[row.clone()]);
        // Finals fold in once: the cursor skips what an earlier pass read.
        let snapshot = speech(&[
            (start + secs(1), " hello chat "),
            (start + secs(2), "today"),
        ]);
        assert_eq!(engine.note_speech(generation, &snapshot), 15);
        assert_eq!(engine.note_speech(generation, &snapshot), 0);
        assert_eq!(engine.seen_speech_version(generation), Some(Some(2)));
        assert_eq!(engine.seen_speech_version(generation + 1), None);

        let prepared = engine
            .prepare_tick(generation, true, true, start + secs(20))
            .unwrap();
        let json = serde_json::to_value(&prepared.request).unwrap();
        assert_eq!(json["promptVersion"], 3);
        assert_eq!(json["transcript"], "hello chat today");
        // Nothing to echo yet: absent keys, never empty ones.
        assert!(json.get("summary").is_none());
        assert!(json.get("openPromises").is_none());
        assert_eq!(json["messages"][0]["firstMessage"], true);
        assert_eq!(json.as_object().unwrap().len(), 13);

        let mut answer = response(vec![question("q_1", &[row.id.as_str()])]);
        answer.questions[0].on_topic = true;
        answer.summary = Some(format!("  {}  ", "s".repeat(700)));
        answer.topic = Some(format!("{} tail", "t".repeat(70)));
        answer.promises = Some(vec![tick_promise(
            None,
            "Giveaway",
            CohostPromiseTriggerKind::Viewers,
            Some(100.0),
        )]);
        answer.recap = Some(format!("{}", "r".repeat(200)));
        assert!(engine.apply_tick_result(generation, 0, Ok(answer), start + secs(21), "t1"));
        let state = engine.snapshot();
        assert!(state.questions[0].on_topic);
        assert_eq!(state.topic.as_deref().map(|t| t.chars().count()), Some(60));
        assert_eq!(state.promises.len(), 1);
        assert_eq!(state.promises[0].id, "p_1");
        assert_eq!(state.promises[0].first_seen_at, "t1");
        assert_eq!(
            state.recap.as_ref().map(|r| r.text.chars().count()),
            Some(RECAP_MAX_CHARS)
        );
        assert_eq!(
            engine.session.as_ref().unwrap().summary.chars().count(),
            600
        );
        // The state serialises the on-topic flag only when set.
        let wire = serde_json::to_value(&state).unwrap();
        assert_eq!(wire["questions"][0]["onTopic"], true);
        assert_eq!(wire["promises"][0]["trigger"]["kind"], "viewers");
        assert_eq!(wire["promises"][0]["trigger"]["value"], 100);

        // The next tick echoes the summary and the open promises (capped).
        engine.note_messages(&messages("session-1", 2..7));
        let next = engine
            .prepare_tick(generation, true, true, start + secs(30))
            .unwrap();
        assert_eq!(
            next.request.summary.as_deref().map(|s| s.chars().count()),
            Some(600)
        );
        assert_eq!(
            next.request.open_promises,
            Some(vec![CohostTickOpenPromise {
                id: "p_1".to_string(),
                text: "Giveaway".to_string(),
            }])
        );
        // Nothing new was said: no transcript key.
        assert!(next.request.transcript.is_none());

        // A response without the v3 keys (v2 fallback shape) keeps what the
        // session has; an on-topic flag that is absent reads false.
        let mut plain = response(vec![question("q_1", &[row.id.as_str()])]);
        plain.summary = None;
        plain.topic = None;
        plain.promises = None;
        assert!(engine.apply_tick_result(generation, 0, Ok(plain), start + secs(31), "t2"));
        let state = engine.snapshot();
        assert!(!state.questions[0].on_topic);
        assert!(
            serde_json::to_value(&state).unwrap()["questions"][0]
                .get("onTopic")
                .is_none()
        );
        assert_eq!(state.topic.as_deref().map(|t| t.chars().count()), Some(60));
        assert_eq!(state.promises.len(), 1);
        assert_eq!(
            engine.session.as_ref().unwrap().summary.chars().count(),
            600
        );
        // An empty topic clears it.
        let mut cleared = response(Vec::new());
        cleared.topic = Some("   ".to_string());
        engine.note_messages(&messages("session-1", 7..12));
        engine
            .prepare_tick(generation, true, true, start + secs(40))
            .unwrap();
        assert!(engine.apply_tick_result(generation, 0, Ok(cleared), start + secs(41), "t3"));
        assert_eq!(engine.snapshot().topic, None);
    }

    #[test]
    fn speech_alone_ticks_on_v3_after_200_chars_and_20_seconds_but_never_below_v3() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        // The server already answered a v3 tick (the rule before that has
        // its own test).
        engine.session.as_mut().unwrap().v3_confirmed = true;
        let long = "w".repeat(199);
        engine.note_speech(generation, &speech(&[(start + secs(1), &long)]));
        // 199 chars: not enough, even after the idle interval.
        assert_eq!(
            engine.prepare_tick(generation, true, true, start + secs(30)),
            Err(TickGate::Idle)
        );
        let more = speech(&[(start + secs(1), &long), (start + secs(2), "x")]);
        assert_eq!(engine.note_speech(generation, &more), 1);
        // 200 chars but only 19 s since the anchor.
        assert_eq!(
            engine.prepare_tick(generation, true, true, start + secs(19)),
            Err(TickGate::Idle)
        );
        let prepared = engine
            .prepare_tick(generation, true, true, start + secs(20))
            .unwrap();
        assert!(prepared.request.messages.is_empty());
        assert_eq!(
            prepared
                .request
                .transcript
                .as_deref()
                .map(|t| t.chars().count()),
            Some(201)
        );
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(Vec::new())),
            start + secs(21),
            "t1"
        ));

        // The pending transcript is capped to the newest 1500 chars on the
        // wire, and never below the 8 s floor.
        let huge = "h".repeat(2000);
        let again = speech(&[
            (start + secs(1), &long),
            (start + secs(2), "x"),
            (start + secs(22), &huge),
        ]);
        engine.note_speech(generation, &again);
        assert_eq!(
            engine.prepare_tick(generation, true, true, start + secs(27)),
            Err(TickGate::Idle)
        );
        let prepared = engine
            .prepare_tick(generation, true, true, start + secs(40))
            .unwrap();
        assert_eq!(
            prepared
                .request
                .transcript
                .as_deref()
                .map(|t| t.chars().count()),
            Some(TICK_TRANSCRIPT_MAX_CHARS)
        );
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(Vec::new())),
            start + secs(41),
            "t2"
        ));

        // A speech-only tick that ranked nothing keeps the suggestions a chat
        // tick produced; one that ranks something replaces them.
        engine.note_messages(&messages("session-1", 0..5));
        let chat_tick = engine
            .prepare_tick(generation, true, true, start + secs(60))
            .unwrap();
        let mut ranked = response(Vec::new());
        ranked.highlights = vec![tick_highlight(
            &chat_tick.request.messages[0].id,
            0.9,
            CohostHighlightType::Joke,
        )];
        assert!(engine.apply_tick_result(generation, 0, Ok(ranked), start + secs(61), "t3"));
        assert_eq!(engine.highlights_len(), 1);
        let speech_only = speech(&[
            (start + secs(1), &long),
            (start + secs(2), "x"),
            (start + secs(22), &huge),
            (start + secs(62), &huge),
        ]);
        engine.note_speech(generation, &speech_only);
        let quiet = engine
            .prepare_tick(generation, true, true, start + secs(90))
            .unwrap();
        assert!(quiet.request.messages.is_empty());
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(Vec::new())),
            start + secs(91),
            "t4"
        ));
        assert_eq!(engine.highlights_len(), 1);

        // Below v3 the same speech never makes a tick.
        engine.session.as_mut().unwrap().prompt_version = 2;
        let later = speech(&[
            (start + secs(1), &long),
            (start + secs(2), "x"),
            (start + secs(22), &huge),
            (start + secs(62), &huge),
            (start + secs(100), &huge),
        ]);
        engine.note_speech(generation, &later);
        assert_eq!(
            engine.prepare_tick(generation, true, true, start + secs(120)),
            Err(TickGate::Idle)
        );
        assert_eq!(engine.snapshot().pending_messages, 0);
    }

    #[test]
    fn promises_merge_like_questions_and_triggers_remind_once() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..5);
        engine.note_messages(&rows);
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        let mut first = response(Vec::new());
        first.promises = Some(vec![
            tick_promise(
                None,
                "Giveaway",
                CohostPromiseTriggerKind::Viewers,
                Some(100.0),
            ),
            tick_promise(None, "Build", CohostPromiseTriggerKind::Minutes, Some(10.0)),
            tick_promise(None, "Later", CohostPromiseTriggerKind::None, None),
            // Forward tolerance: an unknown kind reads as none; a value on
            // `none` is dropped; a long text is capped; an empty one skipped.
            tick_promise(
                None,
                "Someday",
                CohostPromiseTriggerKind::Unknown,
                Some(5.0),
            ),
            tick_promise(
                None,
                &"l".repeat(200),
                CohostPromiseTriggerKind::None,
                Some(3.0),
            ),
            tick_promise(None, "   ", CohostPromiseTriggerKind::None, None),
        ]);
        assert!(engine.apply_tick_result(generation, 0, Ok(first), start + secs(2), "t1"));
        let state = engine.snapshot();
        let ids: Vec<&str> = state.promises.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["p_1", "p_2", "p_3", "p_4", "p_5"]);
        assert_eq!(
            state.promises[3].trigger,
            CohostPromiseTrigger {
                kind: CohostPromiseTriggerKind::None,
                value: None,
            }
        );
        assert_eq!(
            state.promises[4].text.chars().count(),
            PROMISE_TEXT_MAX_CHARS
        );
        assert_eq!(state.promise_reminder, None);

        // Triggers: viewers at or above, minutes since first seen, none after
        // 20 minutes; each fires once, the first met promise per pass.
        assert!(!engine.check_promises(generation, Some(99), start + secs(3), "t2"));
        assert!(!engine.check_promises(generation, None, start + secs(3), "t2"));
        assert!(engine.check_promises(generation, Some(100), start + secs(4), "t3"));
        let reminder = engine.snapshot().promise_reminder.unwrap();
        assert_eq!(
            (
                reminder.promise_id.as_str(),
                reminder.text.as_str(),
                reminder.at.as_str()
            ),
            ("p_1", "Giveaway", "t3")
        );
        assert!(!engine.check_promises(generation, Some(500), start + secs(5), "t4"));
        assert_eq!(engine.snapshot().promise_reminder.unwrap().at, "t3");
        assert!(engine.check_promises(generation, None, start + secs(2 + 600), "t5"));
        assert_eq!(
            engine.snapshot().promise_reminder.unwrap().promise_id,
            "p_2"
        );
        assert!(engine.check_promises(generation, None, start + secs(2 + 1200), "t6"));
        assert_eq!(
            engine.snapshot().promise_reminder.unwrap().promise_id,
            "p_3"
        );
        assert!(engine.check_promises(generation, None, start + secs(2 + 1200), "t7"));
        assert_eq!(
            engine.snapshot().promise_reminder.unwrap().promise_id,
            "p_4"
        );
        assert!(engine.check_promises(generation, None, start + secs(2 + 1200), "t8"));
        assert_eq!(
            engine.snapshot().promise_reminder.unwrap().promise_id,
            "p_5"
        );
        assert!(!engine.check_promises(generation, Some(1000), start + secs(9999), "t9"));
        // A replaced generation changes nothing.
        assert!(!engine.check_promises(generation + 1, Some(1000), start + secs(9999), "t9"));

        // Done/dismiss close the promise, its id never returns, and a
        // reminder about it leaves with it.
        assert!(engine.close_promise("session-1", "p_5", true).unwrap());
        assert!(!engine.close_promise("session-1", "p_5", true).unwrap());
        assert_eq!(engine.snapshot().promise_reminder, None);
        assert_eq!(
            engine.close_promise("session-2", "p_1", false),
            Err(CohostError::SessionMismatch)
        );
        assert!(engine.close_promise("session-1", "p_1", false).unwrap());

        // The next full set: echoed ids keep first_seen_at, a closed id is
        // ignored, a new promise with an existing text keeps that id, an
        // unknown echoed id is taken as is, and fulfilled ids close.
        engine.note_messages(&messages("session-1", 5..10));
        engine
            .prepare_tick(generation, true, true, start + secs(20))
            .unwrap();
        let mut second = response(Vec::new());
        second.promises = Some(vec![
            tick_promise(
                Some("p_1"),
                "Giveaway",
                CohostPromiseTriggerKind::Viewers,
                Some(100.0),
            ),
            tick_promise(
                Some("p_2"),
                "Build (edited)",
                CohostPromiseTriggerKind::Minutes,
                Some(1.0),
            ),
            tick_promise(None, "Later", CohostPromiseTriggerKind::None, None),
            tick_promise(
                Some("srv_9"),
                "Server-minted",
                CohostPromiseTriggerKind::None,
                None,
            ),
            tick_promise(
                None,
                "Brand new",
                CohostPromiseTriggerKind::Viewers,
                Some(1.0),
            ),
        ]);
        second.fulfilled_promise_ids = vec!["p_4".to_string()];
        assert!(engine.apply_tick_result(generation, 0, Ok(second), start + secs(21), "t10"));
        let state = engine.snapshot();
        let ids: Vec<(&str, &str, &str)> = state
            .promises
            .iter()
            .map(|p| (p.id.as_str(), p.text.as_str(), p.first_seen_at.as_str()))
            .collect();
        assert_eq!(
            ids,
            vec![
                ("p_2", "Build (edited)", "t1"),
                ("p_3", "Later", "t1"),
                ("srv_9", "Server-minted", "t10"),
                ("p_6", "Brand new", "t10"),
            ]
        );
        // p_2 already reminded: a lower trigger never fires it again; the
        // brand-new one fires on its own trigger.
        assert!(engine.check_promises(generation, Some(1), start + secs(22), "t11"));
        assert_eq!(
            engine.snapshot().promise_reminder.unwrap().promise_id,
            "p_6"
        );

        // A v2-shaped answer (no promises key) with fulfilled ids only removes.
        engine.note_messages(&messages("session-1", 10..15));
        engine
            .prepare_tick(generation, true, true, start + secs(40))
            .unwrap();
        let mut third = response(Vec::new());
        third.promises = None;
        third.fulfilled_promise_ids = vec!["p_6".to_string()];
        assert!(engine.apply_tick_result(generation, 0, Ok(third), start + secs(41), "t12"));
        let state = engine.snapshot();
        assert_eq!(state.promises.len(), 3);
        assert_eq!(state.promise_reminder, None);
        assert!(
            serde_json::to_value(&state)
                .unwrap()
                .get("promiseReminder")
                .is_none()
        );

        // A new session forgets every promise and reminder.
        let generation = engine.start_session("session-2".to_string(), true, None, start);
        assert!(engine.snapshot().promises.is_empty());
        assert!(!engine.check_promises(generation, Some(1000), start + secs(9999), "t13"));
    }

    #[test]
    fn recap_rides_five_minutes_and_a_draft_cuts_the_summary_at_a_word() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        assert_eq!(
            engine.draft_recap("session-1", start, "t0"),
            Err(CohostError::NoSummary)
        );
        engine.note_messages(&messages("session-1", 0..5));
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        let mut answer = response(Vec::new());
        answer.recap = Some("  So far: unboxed the parts.  ".to_string());
        answer.summary = Some(
            "We unboxed the keyboard, compared three switch types, and started the build with the plate and the stabilisers before chat asked about the case colour"
                .to_string(),
        );
        assert!(engine.apply_tick_result(generation, 0, Ok(answer), start + secs(2), "t1"));
        let recap = engine.snapshot().recap.unwrap();
        assert_eq!(recap.text, "So far: unboxed the parts.");
        assert_eq!(recap.at, "t1");
        assert!(chrono::DateTime::parse_from_rfc3339(&recap.expires_at).is_ok());
        assert!(
            engine
                .snapshot_at_for_test(start + secs(2 + 299))
                .recap
                .is_some()
        );
        assert!(
            engine
                .snapshot_at_for_test(start + secs(2 + 300))
                .recap
                .is_none()
        );
        assert!(engine.dismiss_recap("session-1", start + secs(3)).unwrap());
        assert!(!engine.dismiss_recap("session-1", start + secs(3)).unwrap());
        assert_eq!(
            engine.dismiss_recap("session-2", start),
            Err(CohostError::SessionMismatch)
        );
        assert!(
            serde_json::to_value(engine.snapshot())
                .unwrap()
                .get("recap")
                .is_none()
        );

        // The draft: from the summary, no network, at most 140 chars cut at
        // a word boundary; it rides the state like a server recap.
        engine
            .draft_recap("session-1", start + secs(4), "t2")
            .unwrap();
        let draft = engine.snapshot().recap.unwrap();
        assert_eq!(
            draft.text,
            "We unboxed the keyboard, compared three switch types, and started the build with the plate and the stabilisers before chat asked about the"
        );
        assert!(draft.text.chars().count() <= RECAP_MAX_CHARS);
        assert_eq!(draft.at, "t2");
        assert_eq!(recap_draft("short summary", 140), "short summary");
        assert_eq!(recap_draft("   spaced   out  ", 140), "spaced out");
        assert_eq!(recap_draft(&"x".repeat(150), 140).chars().count(), 140);
        assert_eq!(recap_draft("", 140), "");
        assert_eq!(recap_draft("one two three", 7), "one two");
        assert_eq!(recap_draft("one two three", 8), "one two");
    }

    #[test]
    fn promise_trigger_matrix_matches_the_contract() {
        let viewers = CohostPromiseTrigger {
            kind: CohostPromiseTriggerKind::Viewers,
            value: Some(100),
        };
        assert!(!promise_trigger_met(viewers, None, secs(99_999)));
        assert!(!promise_trigger_met(viewers, Some(99), secs(0)));
        assert!(promise_trigger_met(viewers, Some(100), secs(0)));
        let minutes = CohostPromiseTrigger {
            kind: CohostPromiseTriggerKind::Minutes,
            value: Some(10),
        };
        assert!(!promise_trigger_met(minutes, Some(1000), secs(599)));
        assert!(promise_trigger_met(minutes, None, secs(600)));
        for kind in [
            CohostPromiseTriggerKind::None,
            CohostPromiseTriggerKind::Unknown,
        ] {
            let none = CohostPromiseTrigger { kind, value: None };
            assert!(!promise_trigger_met(none, Some(1000), secs(1199)));
            assert!(promise_trigger_met(none, None, secs(1200)));
        }
        // Chat rows carry the first-message flag onto the v3 wire.
        let mut row = chat_message("session-1", 1, "2026-08-22T10:01:01Z");
        row.first_message = true;
        assert_eq!(
            tick_message_from_chat(&row).unwrap().first_message,
            Some(true)
        );
        // Off-state wire: none of the v3 keys, never null.
        let json = serde_json::to_value(CohostState::off()).unwrap();
        for key in ["topic", "promises", "promiseReminder", "recap"] {
            assert!(json.get(key).is_none(), "{key} must be absent while empty");
        }
    }

    /// Plan 155, D7: Golem hears a Twitch GIF as an action with its title,
    /// never as the bracketed GIPHY title pretending to be the viewer's words.
    #[test]
    fn orcle_reads_a_twitch_gif_as_an_action_with_its_title() {
        let gif = |text: &str| LiveChatMessageFragment {
            fragment_type: "gif".into(),
            text: text.into(),
            image_url: Some("https://media2.giphy.com/media/aUovxH8Vf9qDu/giphy.gif".into()),
            zero_width: false,
        };
        let words = |text: &str| LiveChatMessageFragment {
            fragment_type: "text".into(),
            text: text.into(),
            image_url: None,
            zero_width: false,
        };
        assert_eq!(
            tick_text_with_gifs("[Y A Y Yes GIF]", &[gif("[Y A Y Yes GIF]")]),
            "sent a GIF: Y A Y Yes"
        );
        assert_eq!(
            tick_text_with_gifs(
                "gg [Y A Y Yes GIF] wow",
                &[words("gg "), gif("[Y A Y Yes GIF]"), words(" wow")]
            ),
            "gg (GIF: Y A Y Yes) wow"
        );
        // A refused GIF (no URL) still reads as a GIF, by its title.
        let mut refused = gif("[Nope GIF]");
        refused.image_url = None;
        assert_eq!(
            tick_text_with_gifs("[Nope GIF]", &[refused]),
            "sent a GIF: Nope"
        );
        assert_eq!(tick_text_with_gifs("hello", &[words("hello")]), "hello");
        assert_eq!(tick_text_with_gifs("hello", &[]), "hello");

        let mut row = chat_message("session-1", 1, "2026-08-22T10:01:01Z");
        row.message_text = "[Y A Y Yes GIF]".into();
        row.fragments = vec![gif("[Y A Y Yes GIF]")];
        assert_eq!(
            tick_message_from_chat(&row).unwrap().text,
            "sent a GIF: Y A Y Yes"
        );
    }

    #[test]
    fn unknown_enum_values_and_extra_fields_still_apply() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..5);
        engine.note_messages(&rows);
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        let body = serde_json::json!({
            "promptVersion": 3,
            "somethingNew": { "nested": [1, 2, 3] },
            "questions": [{
                "id": "q_1",
                "text": "What keyboard?",
                "messageIds": [rows[0].id],
                "priority": "urgent",
                "futureField": true
            }],
            "mood": "chaotic",
            "moodScores": { "hype": 1.7, "tension": 0.4, "boredom": 0.9 },
            "flags": [
                { "messageId": rows[1].id, "kind": "brigading", "severity": "critical",
                  "reason": "new kind", "target": "bots", "action": "shadowban",
                  "alsoKinds": ["scam", "brigading"], "confidence": 0.8, "extra": 1 },
                { "messageId": rows[2].id, "kind": "hate", "severity": "high" },
                { "messageId": rows[3].id, "kind": 7, "severity": "high" },
                "not-an-object"
            ],
            "highlights": [
                { "messageId": rows[4].id, "score": 0.9, "type": "meme" },
                { "score": 0.5 }
            ],
            "alerts": [
                { "messageId": rows[0].id, "kind": "chat-bridge", "confidence": 0.7 }
            ]
        });
        let response: CohostTickResponse = serde_json::from_value(body).unwrap();
        assert!(engine.apply_tick_result(generation, 0, Ok(response), start + secs(2), "t1"));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.status, CohostStatus::Listening);
        assert_eq!(snapshot.mood, Some(CohostMood::Mixed));
        assert_eq!(snapshot.questions[0].priority, CohostPriority::Normal);
        assert_eq!(
            snapshot.mood_scores,
            Some(CohostMoodScores {
                hype: 1.0,
                tension: 0.4,
                confusion: 0.0
            })
        );
        // Unknown kind is kept for a generic render; the unreadable items
        // (non-string kind, non-object) are dropped on their own.
        assert_eq!(snapshot.flags.len(), 2);
        assert_eq!(snapshot.flags[0].kind, CohostFlagKind::Unknown);
        assert_eq!(snapshot.flags[0].severity, CohostFlagSeverity::Medium);
        assert_eq!(snapshot.flags[0].target, None);
        assert_eq!(snapshot.flags[0].action, None);
        assert_eq!(snapshot.flags[0].also_kinds, vec![CohostFlagKind::Scam]);
        assert_eq!(snapshot.flags[0].confidence, Some(0.8));
        assert_eq!(snapshot.flags[1].kind, CohostFlagKind::Hate);
        assert_eq!(snapshot.highlights.len(), 1);
        assert_eq!(
            snapshot.highlights[0].highlight_type,
            CohostHighlightType::Other
        );
        assert_eq!(snapshot.alerts.len(), 1);
        assert_eq!(snapshot.alerts[0].kind, CohostAlertKind::Other);

        // What reaches the renderer: "unknown" only as a flag kind, and no
        // nulls for the optional v2 fields.
        let wire = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(wire["flags"][0]["kind"], "unknown");
        let flag = wire["flags"][1].as_object().unwrap();
        for key in ["confidence", "target", "action", "alsoKinds", "rule"] {
            assert!(!flag.contains_key(key), "{key} must be absent, not null");
        }
    }

    #[test]
    fn keep_questions_keeps_the_open_set_and_only_removes_resolved() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..5);
        engine.note_messages(&rows);
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        let first = response(vec![
            question("q_1", &[rows[0].id.as_str()]),
            question("q_2", &[rows[1].id.as_str()]),
        ]);
        assert!(engine.apply_tick_result(generation, 0, Ok(first), start + secs(2), "t1"));

        engine.note_messages(&messages("session-1", 5..10));
        engine
            .prepare_tick(generation, true, true, start + secs(30))
            .unwrap();
        let kept: CohostTickResponse = serde_json::from_value(serde_json::json!({
            "promptVersion": 2,
            "questions": [],
            "resolved": ["q_2"],
            "keepQuestions": true,
            "mood": "calm"
        }))
        .unwrap();
        assert!(engine.apply_tick_result(generation, 0, Ok(kept), start + secs(31), "t2"));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.questions.len(), 1);
        assert_eq!(snapshot.questions[0].id, "q_1");
        // Untouched, not re-stamped: the server did not regenerate it.
        assert_eq!(snapshot.questions[0].updated_at, "t1");
        assert_eq!(snapshot.questions_total, 2);

        // Without the flag an empty `questions` still means "none open" (v1).
        engine.note_messages(&messages("session-1", 10..15));
        engine
            .prepare_tick(generation, true, true, start + secs(60))
            .unwrap();
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(Vec::new())),
            start + secs(61),
            "t3"
        ));
        assert!(engine.snapshot().questions.is_empty());
    }

    #[test]
    fn flag_extras_ride_the_state_and_rule_index_resolves_to_the_sent_rule() {
        let start = Instant::now();
        let mut engine = CohostEngine::new(CohostSettings {
            rules: vec!["No spoilers".to_string(), "English only".to_string()],
            ..enabled_settings()
        });
        let generation = engine.start_session("session-1".to_string(), true, None, start);
        let rows = messages("session-1", 0..5);
        engine.note_messages(&rows);
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        // The streamer edits the list while the tick is in flight; the index
        // still means what it meant when the request was built.
        engine.settings.rules = vec!["Be kind".to_string()];
        let mut tick = response(Vec::new());
        tick.flags = vec![
            CohostTickFlag {
                confidence: Some(0.93),
                target: Some(CohostFlagTarget::Streamer),
                action: Some(CohostFlagAction::Timeout),
                also_kinds: vec![CohostFlagKind::Scam, CohostFlagKind::Harassment],
                ..flag(
                    &rows[0].id,
                    CohostFlagKind::Harassment,
                    CohostFlagSeverity::High,
                )
            },
            CohostTickFlag {
                rule_index: Some(1),
                ..flag(&rows[1].id, CohostFlagKind::Rule, CohostFlagSeverity::Low)
            },
            CohostTickFlag {
                rule_index: Some(9),
                ..flag(&rows[2].id, CohostFlagKind::Rule, CohostFlagSeverity::Low)
            },
            // A rule index on a non-rule flag means nothing.
            CohostTickFlag {
                rule_index: Some(0),
                ..flag(&rows[3].id, CohostFlagKind::Spam, CohostFlagSeverity::Low)
            },
        ];
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), start + secs(2), "t1"));
        let flags = engine.snapshot().flags;
        assert_eq!(flags[0].confidence, Some(0.93));
        assert_eq!(flags[0].target, Some(CohostFlagTarget::Streamer));
        assert_eq!(flags[0].action, Some(CohostFlagAction::Timeout));
        assert_eq!(flags[0].also_kinds, vec![CohostFlagKind::Scam]);
        assert_eq!(flags[1].rule.as_deref(), Some("English only"));
        assert_eq!(flags[2].rule, None);
        assert_eq!(flags[3].rule, None);
        let wire = serde_json::to_value(&flags[0]).unwrap();
        assert_eq!(wire["target"], "streamer");
        assert_eq!(wire["action"], "timeout");
        assert_eq!(wire["alsoKinds"], serde_json::json!(["scam"]));
    }

    #[test]
    fn a_removed_message_resolves_its_flag_without_counting_a_dismissal() {
        // Plan 140 S4: the moderation engine resolves the flag of a message
        // the streamer removed; a deletion alone never did.
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..TICK_BURST_THRESHOLD as u32);
        engine.note_messages(&rows);
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        let mut tick = response(Vec::new());
        tick.flags = vec![
            flag(
                &rows[0].id,
                CohostFlagKind::Harassment,
                CohostFlagSeverity::High,
            ),
            flag(&rows[1].id, CohostFlagKind::Spam, CohostFlagSeverity::Low),
        ];
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), start + secs(2), "t1"));
        assert_eq!(engine.snapshot().flags.len(), 2);

        assert!(engine.resolve_flag("session-1", &rows[0].id).unwrap());
        let flags = engine.snapshot().flags;
        assert_eq!(flags.len(), 1);
        assert_eq!(flags[0].message_id, rows[1].id);
        assert_eq!(
            engine.session.as_ref().unwrap().report.flags_dismissed,
            0,
            "a removal is not a dismissal"
        );
        // Resolved for good: a second resolve changes nothing, and a tick
        // may not raise the same flag again.
        assert!(!engine.resolve_flag("session-1", &rows[0].id).unwrap());
        assert!(
            engine
                .session
                .as_ref()
                .unwrap()
                .dismissed_flags
                .contains(&rows[0].id)
        );
        assert_eq!(
            engine.resolve_flag("other-session", &rows[1].id),
            Err(CohostError::SessionMismatch)
        );
        // An unflagged message resolves to "nothing changed".
        assert!(!engine.resolve_flag("session-1", &rows[2].id).unwrap());
    }

    #[test]
    fn highlights_keep_the_latest_validated_set_and_never_a_flagged_or_deleted_row() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..8);
        engine.note_messages(&rows);
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        let highlight = |id: &str, score: f64| crate::videorc_api::CohostTickHighlight {
            message_id: id.to_string(),
            score,
            highlight_type: CohostHighlightType::Joke,
        };
        let mut tick = response(Vec::new());
        tick.flags = vec![flag(
            &rows[1].id,
            CohostFlagKind::Spam,
            CohostFlagSeverity::Low,
        )];
        tick.highlights = vec![
            highlight(&rows[0].id, 0.9),
            highlight(&rows[1].id, 0.8),
            highlight("not-ours", 0.7),
            highlight(&rows[0].id, 0.6),
            highlight(&rows[2].id, 0.5),
        ];
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), start + secs(2), "t1"));
        let ids = |engine: &CohostEngine| -> Vec<String> {
            engine
                .snapshot()
                .highlights
                .into_iter()
                .map(|highlight| highlight.message_id)
                .collect()
        };
        assert_eq!(ids(&engine), vec![rows[0].id.clone(), rows[2].id.clone()]);

        // A tombstone pulls the suggestion at once, and keeps it out later.
        let mut deleted = rows[0].clone();
        deleted.is_deleted = true;
        engine.note_messages(&[deleted]);
        assert_eq!(ids(&engine), vec![rows[2].id.clone()]);

        // Dismissing a flag does not make that message suggestible.
        assert!(engine.dismiss_flag("session-1", &rows[1].id).unwrap());
        engine.note_messages(&messages("session-1", 8..13));
        engine
            .prepare_tick(generation, true, true, start + secs(30))
            .unwrap();
        let mut tick = response(Vec::new());
        tick.highlights = (0..8)
            .map(|index| highlight(&rows[index].id, 0.5))
            .collect();
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), start + secs(31), "t2"));
        let kept = ids(&engine);
        assert_eq!(kept.len(), HIGHLIGHTS_CAP);
        assert!(!kept.contains(&rows[0].id));
        assert!(!kept.contains(&rows[1].id));

        // The latest set wins: a tick without highlights clears them.
        engine.note_messages(&messages("session-1", 13..18));
        engine
            .prepare_tick(generation, true, true, start + secs(60))
            .unwrap();
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(Vec::new())),
            start + secs(61),
            "t3"
        ));
        assert!(ids(&engine).is_empty());
    }

    #[test]
    fn alerts_need_two_distinct_authors_within_a_minute_and_expire() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        // chat_message authors cycle viewer-0, viewer-1, viewer-2.
        let rows = messages("session-1", 0..6);
        engine.note_messages(&rows);
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        let alert = |id: &str, kind: CohostAlertKind| crate::videorc_api::CohostTickAlert {
            message_id: id.to_string(),
            kind,
            confidence: Some(0.9),
        };
        let mut tick = response(Vec::new());
        tick.alerts = vec![
            alert(&rows[0].id, CohostAlertKind::Audio),
            // Same author again: still one viewer.
            alert(&rows[3].id, CohostAlertKind::Audio),
            alert("not-ours", CohostAlertKind::Audio),
            alert(&rows[1].id, CohostAlertKind::Video),
        ];
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), start + secs(2), "t1"));
        let session = engine.session.as_ref().unwrap();
        let alerts = session.alerts_at(start + secs(2));
        assert_eq!(alerts.len(), 2);
        assert_eq!(alerts[0].kind, CohostAlertKind::Audio);
        assert_eq!(alerts[0].viewers, 1);
        assert!(!alerts[0].active);
        assert!(!alerts[1].active);

        // A second author 70 s later is outside the corroboration window...
        engine.note_messages(&messages("session-1", 6..11));
        engine
            .prepare_tick(generation, true, true, start + secs(71))
            .unwrap();
        let mut tick = response(Vec::new());
        tick.alerts = vec![alert(&rows[1].id, CohostAlertKind::Audio)];
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), start + secs(72), "t2"));
        let session = engine.session.as_ref().unwrap();
        let alerts = session.alerts_at(start + secs(72));
        assert_eq!(alerts[0].viewers, 2);
        assert_eq!(alerts[0].last_seen_at, "t2");
        assert!(!alerts[0].active);

        // ...a third one 20 s after that is inside it.
        engine.note_messages(&messages("session-1", 11..16));
        engine
            .prepare_tick(generation, true, true, start + secs(91))
            .unwrap();
        let mut tick = response(Vec::new());
        tick.alerts = vec![alert(&rows[2].id, CohostAlertKind::Audio)];
        assert!(engine.apply_tick_result(generation, 0, Ok(tick), start + secs(92), "t3"));
        let session = engine.session.as_ref().unwrap();
        let alerts = session.alerts_at(start + secs(92));
        let audio = alerts
            .iter()
            .find(|alert| alert.kind == CohostAlertKind::Audio)
            .unwrap();
        assert!(audio.active);
        assert_eq!(audio.viewers, 3);
        let wire = serde_json::to_value(audio).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({ "kind": "audio", "viewers": 3, "lastSeenAt": "t3", "active": true })
        );
        // The lone video report from t+2 is still listed, never active.
        assert!(
            alerts
                .iter()
                .any(|alert| alert.kind == CohostAlertKind::Video && !alert.active)
        );

        // Reports expire 120 s after they were seen: at t+193 only the t+92
        // report is left, so audio is one viewer again and video is gone.
        let alerts = session.alerts_at(start + secs(193));
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].viewers, 1);
        assert!(!alerts[0].active);
        assert!(session.alerts_at(start + secs(212)).is_empty());
    }

    #[test]
    fn settings_from_before_rules_still_load_and_rules_round_trip() {
        let legacy: CohostSettings = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "tone": "short",
            "notes": "n",
            "autoHighlight": false
        }))
        .unwrap();
        assert!(legacy.rules.is_empty());

        let database = Database::open_in_memory_for_tests();
        let mut settings = CohostSettings::default();
        settings.apply(CohostSettingsPatch {
            rules: Some(
                (0..14)
                    .map(|index| format!("  rule {index} {}", "x".repeat(200)))
                    .collect(),
            ),
            ..CohostSettingsPatch::default()
        });
        assert_eq!(settings.rules.len(), COHOST_RULES_MAX);
        assert!(
            settings
                .rules
                .iter()
                .all(|rule| rule.chars().count() == COHOST_RULE_MAX_CHARS
                    && rule.starts_with("rule"))
        );
        database
            .save_setting(COHOST_SETTINGS_KEY, &settings)
            .unwrap();
        assert_eq!(load_cohost_settings(&database), settings);
        assert_eq!(
            serde_json::to_value(CohostSettings::default()).unwrap()["rules"],
            serde_json::json!([])
        );
        // An absent patch field leaves the list alone; an empty one clears it.
        settings.apply(CohostSettingsPatch::default());
        assert_eq!(settings.rules.len(), COHOST_RULES_MAX);
        settings.apply(CohostSettingsPatch {
            rules: Some(Vec::new()),
            ..CohostSettingsPatch::default()
        });
        assert!(settings.rules.is_empty());
    }

    #[test]
    fn late_response_for_a_replaced_session_is_dropped() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..5);
        engine.note_messages(&rows);
        let prepared = engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        assert!(engine.stop_session().is_some());
        assert_eq!(engine.snapshot(), CohostState::off());
        // Same generation id, but no session: dropped.
        assert!(!engine.apply_tick_result(
            prepared.generation,
            0,
            Ok(response(vec![question("q_1", &[rows[0].id.as_str()])])),
            start + secs(2),
            "t1"
        ));
        // A replacement session with a newer generation also drops it.
        let next_generation = engine.start_session("session-2".to_string(), true, None, start);
        assert_ne!(next_generation, prepared.generation);
        assert!(!engine.apply_tick_result(
            prepared.generation,
            0,
            Ok(response(vec![question("q_1", &[rows[0].id.as_str()])])),
            start + secs(2),
            "t1"
        ));
        assert!(engine.snapshot().questions.is_empty());
        assert_eq!(engine.snapshot().session_id.as_deref(), Some("session-2"));
        assert_eq!(
            engine.prepare_tick(prepared.generation, true, true, start + secs(3)),
            Err(TickGate::Stopped)
        );
    }

    #[test]
    fn failure_reasons_map_to_status_and_retry_windows() {
        let start = Instant::now();
        let cases = [
            (
                server_error(401, "unauthorized", "x"),
                CohostStatus::Error,
                CohostReason::SessionExpired,
                5,
            ),
            (
                server_error(403, "premium-required", "x"),
                CohostStatus::Paused,
                CohostReason::PremiumRequired,
                5,
            ),
            (
                server_error(400, "consent-required", "x"),
                CohostStatus::Paused,
                CohostReason::ConsentRequired,
                5,
            ),
            (
                crate::videorc_api::classify_cohost_failure(
                    429,
                    "quota-exhausted",
                    "x".into(),
                    Some("120"),
                ),
                CohostStatus::Paused,
                CohostReason::QuotaExhausted,
                120,
            ),
            (
                server_error(429, "quota-exhausted", "x"),
                CohostStatus::Paused,
                CohostReason::QuotaExhausted,
                3600,
            ),
            (
                server_error(503, "cohost-disabled", "x"),
                CohostStatus::Error,
                CohostReason::ServerUnconfigured,
                5,
            ),
            (
                server_error(400, "prompt-version-unsupported", "x"),
                CohostStatus::Error,
                CohostReason::ServerUnconfigured,
                5,
            ),
            (
                server_error(502, "ai-gateway-error", "x"),
                CohostStatus::Error,
                CohostReason::GatewayError,
                5,
            ),
            (
                server_error(400, "invalid-request", "x"),
                CohostStatus::Error,
                CohostReason::GatewayError,
                5,
            ),
            (
                CohostApiError::malformed_response(200, "x"),
                CohostStatus::Error,
                CohostReason::GatewayError,
                5,
            ),
            (
                CohostApiError::network("x"),
                CohostStatus::Error,
                CohostReason::Network,
                5,
            ),
            (
                CohostApiError::timeout("x"),
                CohostStatus::Error,
                CohostReason::Network,
                5,
            ),
        ];
        for (error, status, reason, retry_secs) in cases {
            let (mut engine, generation) = running_engine(start);
            if error.kind == CohostApiErrorKind::PromptVersionUnsupported {
                // Only a rejected v1 tick is a failure; a rejected v2 tick is
                // the silent fallback (covered by its own test).
                engine.session.as_mut().unwrap().prompt_version = 1;
            }
            engine.note_messages(&messages("session-1", 0..5));
            engine
                .prepare_tick(generation, true, true, start + secs(1))
                .unwrap();
            assert!(engine.apply_tick_result(generation, 0, Err(error.clone()), start, "t"));
            let snapshot = engine.snapshot();
            assert_eq!(snapshot.status, status, "{error:?}");
            assert_eq!(snapshot.reason, Some(reason), "{error:?}");
            // Every failed tick exposes what was actually said.
            assert_eq!(snapshot.detail, Some(error.detail.clone()), "{error:?}");
            let next = engine.session.as_ref().unwrap().next_attempt_at.unwrap();
            assert_eq!(
                next.duration_since(start).as_secs(),
                retry_secs,
                "{error:?}"
            );
        }
    }

    #[test]
    fn failed_tick_detail_is_captured_and_cleared_on_recovery() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        assert_eq!(engine.snapshot().detail, None);

        // 502 from the 2026-08-23 incident: code + message + status all ride
        // the snapshot.
        engine.note_messages(&messages("session-1", 0..5));
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        assert!(engine.apply_tick_result(
            generation,
            0,
            Err(server_error(
                502,
                "ai-gateway-error",
                "The Golem tick failed on every configured model."
            )),
            start + secs(2),
            "t1"
        ));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.status, CohostStatus::Error);
        assert_eq!(snapshot.reason, Some(CohostReason::GatewayError));
        assert_eq!(
            snapshot.detail,
            Some(CohostErrorDetail {
                code: "ai-gateway-error".to_string(),
                message: "The Golem tick failed on every configured model.".to_string(),
                status: Some(502),
            })
        );

        // A later 400 replaces it wholesale (no stale status from the 502).
        engine.note_messages(&messages("session-1", 5..10));
        engine
            .prepare_tick(generation, true, true, start + secs(10))
            .unwrap();
        assert!(engine.apply_tick_result(
            generation,
            0,
            Err(server_error(400, "invalid-request", "messages: too long")),
            start + secs(11),
            "t2"
        ));
        assert_eq!(
            engine.snapshot().detail,
            Some(CohostErrorDetail {
                code: "invalid-request".to_string(),
                message: "messages: too long".to_string(),
                status: Some(400),
            })
        );

        // A timeout has no HTTP status and the desktop's own code.
        engine.note_messages(&messages("session-1", 10..15));
        engine
            .prepare_tick(generation, true, true, start + secs(30))
            .unwrap();
        assert!(engine.apply_tick_result(
            generation,
            0,
            Err(CohostApiError::timeout("Golem did not answer within 12 s.")),
            start + secs(42),
            "t3"
        ));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.reason, Some(CohostReason::Network));
        assert_eq!(
            snapshot.detail,
            Some(CohostErrorDetail {
                code: "timeout".to_string(),
                message: "Golem did not answer within 12 s.".to_string(),
                status: None,
            })
        );

        // Recovery: a merged tick clears reason and detail together.
        engine.note_messages(&messages("session-1", 15..20));
        engine
            .prepare_tick(generation, true, true, start + secs(80))
            .unwrap();
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(Vec::new())),
            start + secs(81),
            "t4"
        ));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.status, CohostStatus::Listening);
        assert_eq!(snapshot.reason, None);
        assert_eq!(snapshot.detail, None);
    }

    #[test]
    fn precondition_pause_drops_stale_tick_detail() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        engine.note_messages(&messages("session-1", 0..5));
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        assert!(engine.apply_tick_result(
            generation,
            0,
            Err(server_error(502, "ai-gateway-error", "boom")),
            start + secs(2),
            "t1"
        ));
        assert!(engine.snapshot().detail.is_some());
        // Signed out while backing off: the pause is local, not a tick result.
        assert_eq!(
            engine.prepare_tick(generation, false, true, start + secs(10)),
            Err(TickGate::Paused(CohostReason::SignedOut))
        );
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.status, CohostStatus::Paused);
        assert_eq!(snapshot.detail, None);
    }

    #[test]
    fn error_detail_message_is_trimmed_and_capped() {
        let long = "x".repeat(1000);
        let detail = CohostErrorDetail::new("ai-gateway-error", format!("  {long}  "), Some(502));
        assert_eq!(
            detail.message.chars().count(),
            ERROR_DETAIL_MESSAGE_MAX_CHARS
        );
        assert_eq!(detail.code, "ai-gateway-error");
        assert_eq!(detail.status, Some(502));
    }

    #[test]
    fn state_without_detail_key_still_parses_and_serializes_explicit_null() {
        let legacy: CohostState = serde_json::from_value(serde_json::json!({
            "sessionId": null,
            "status": "off",
            "reason": null,
            "questions": [],
            "flags": [],
            "mood": null,
            "lastTickAt": null,
            "tickSeq": 0,
            "partial": false
        }))
        .unwrap();
        assert_eq!(legacy, CohostState::off());
        let wire = serde_json::to_value(CohostState::off()).unwrap();
        assert_eq!(wire["detail"], serde_json::Value::Null);
        let errored = CohostState {
            status: CohostStatus::Error,
            reason: Some(CohostReason::GatewayError),
            detail: Some(CohostErrorDetail::new(
                "ai-gateway-error",
                "boom",
                Some(502),
            )),
            ..CohostState::off()
        };
        assert_eq!(
            serde_json::to_value(&errored).unwrap()["detail"],
            serde_json::json!({ "code": "ai-gateway-error", "message": "boom", "status": 502 })
        );
        let timed_out = CohostState {
            detail: Some(CohostErrorDetail::new("timeout", "slow", None)),
            ..CohostState::off()
        };
        assert_eq!(
            serde_json::to_value(&timed_out).unwrap()["detail"]["status"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn tick_timeout_exceeds_min_gap_and_an_in_flight_tick_only_delays_the_next() {
        // The HTTP timeout (12 s) is headroom; the cadence floor stays 8 s.
        assert!(crate::videorc_api::COHOST_TICK_TIMEOUT > TICK_MIN_GAP);
        assert_eq!(TICK_MIN_GAP.as_secs(), 8);

        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        engine.note_messages(&messages("session-1", 0..5));
        let sent_at = start + secs(1);
        engine
            .prepare_tick(generation, true, true, sent_at)
            .unwrap();
        // A burst arrives while the request is still out: never a second
        // request in flight, even once the 8 s gap has passed.
        engine.note_messages(&messages("session-1", 5..10));
        for offset in [2, 8, 9, 12] {
            assert_eq!(
                engine
                    .prepare_tick(generation, true, true, sent_at + secs(offset))
                    .err(),
                Some(TickGate::Idle),
                "+{offset}s"
            );
        }
        // The slow tick lands at +12 s: the gap since it was SENT is already
        // ≥ 8 s, so the delayed next tick goes out right away.
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(Vec::new())),
            sent_at + secs(12),
            "t1"
        ));
        let next = engine
            .prepare_tick(generation, true, true, sent_at + secs(12))
            .unwrap();
        assert_eq!(next.request.tick_seq, 2);
        assert_eq!(next.request.messages.len(), 5);
    }

    #[test]
    fn preconditions_pause_with_reasons_and_success_resumes_without_losing_state() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..5);
        engine.note_messages(&rows);
        assert_eq!(
            engine.prepare_tick(generation, true, false, start + secs(1)),
            Err(TickGate::Paused(CohostReason::PremiumRequired))
        );
        // Same pause again: no repeated emission.
        assert_eq!(
            engine.prepare_tick(generation, true, false, start + secs(7)),
            Err(TickGate::Idle)
        );
        // The 5 s precondition re-check window is honored.
        assert_eq!(
            engine.prepare_tick(generation, false, true, start + secs(8)),
            Err(TickGate::Idle)
        );
        assert_eq!(
            engine.prepare_tick(generation, false, true, start + secs(13)),
            Err(TickGate::Paused(CohostReason::SignedOut))
        );
        engine.session.as_mut().unwrap().consent = false;
        assert_eq!(
            engine.prepare_tick(generation, true, true, start + secs(19)),
            Err(TickGate::Paused(CohostReason::ConsentRequired))
        );
        engine.session.as_mut().unwrap().consent = true;
        let prepared = engine
            .prepare_tick(generation, true, true, start + secs(25))
            .unwrap();
        assert_eq!(
            prepared.request.messages.len(),
            5,
            "pending delta survived the pauses"
        );
        engine.apply_tick_result(
            generation,
            0,
            Ok(response(vec![question("q_1", &[rows[0].id.as_str()])])),
            start + secs(26),
            "t1",
        );
        assert_eq!(engine.snapshot().status, CohostStatus::Listening);
        assert_eq!(engine.snapshot().reason, None);

        // Disabled settings stop the scheduler on its next pass.
        engine.settings.enabled = false;
        assert_eq!(
            engine.prepare_tick(generation, true, true, start + secs(40)),
            Err(TickGate::Stopped)
        );
    }

    #[test]
    fn role_normalization_matches_the_server_enum() {
        assert_eq!(normalize_role("moderator").as_deref(), Some("mod"));
        assert_eq!(normalize_role("broadcaster").as_deref(), Some("owner"));
        assert_eq!(normalize_role("founder").as_deref(), Some("member"));
        assert_eq!(normalize_role("VIP").as_deref(), Some("vip"));
        assert_eq!(normalize_role("subscriber").as_deref(), Some("subscriber"));
        assert_eq!(normalize_role("verified"), None);
    }

    #[test]
    fn settings_persona_and_auto_chat_round_trip_and_default_for_older_rows() {
        let database = Database::open_in_memory_for_tests();
        // A row from before plan 164 loads with the default persona and
        // everything automatic off.
        database
            .save_setting(
                COHOST_SETTINGS_KEY,
                &serde_json::json!({
                    "enabled": true,
                    "tone": "short",
                    "notes": "",
                    "autoHighlight": false
                }),
            )
            .unwrap();
        let loaded = load_cohost_settings(&database);
        assert_eq!(loaded.persona, CohostPersona::default());
        assert_eq!(loaded.persona.id, COHOST_DEFAULT_PERSONA_ID);
        assert_eq!(loaded.persona.name, COHOST_DEFAULT_PERSONA_NAME);
        assert_eq!(loaded.auto_chat.mode, CohostAutoChatMode::Off);
        assert!(!loaded.auto_chat.greetings.enabled);
        assert!(loaded.auto_chat.greetings.templates.is_empty());
        assert!(!loaded.auto_chat.answers.enabled);
        assert_eq!(loaded.auto_chat.answers.cooldown_seconds, 20);
        assert!(!loaded.auto_chat.banter.enabled);
        assert_eq!(loaded.auto_chat.banter.cooldown_seconds, 240);

        let mut settings = CohostSettings::default();
        settings.apply(CohostSettingsPatch {
            persona: Some(CohostPersona {
                id: "p-1".to_string(),
                name: "Grum the Goblin".to_string(),
                personality: "Cheerful goblin merchant".to_string(),
                bubble_style: CohostBubbleStyle::Shout,
                images: CohostPersonaImages {
                    idle: Some("p-1/idle.png".to_string()),
                    laugh: Some("p-1/laugh.webp".to_string()),
                    ..CohostPersonaImages::default()
                },
                source: CohostPersonaSource::Uploaded,
            }),
            auto_chat: Some(CohostAutoChat {
                mode: CohostAutoChatMode::Suggest,
                greetings: CohostGreetingsSettings {
                    enabled: true,
                    templates: vec![CohostGreetingTemplate {
                        id: "t-1".to_string(),
                        kind: CohostActivityTemplateKind::Follow,
                        platform: Some(CohostGreetingPlatform::Twitch),
                        text: "Welcome to the horde, {name}".to_string(),
                        state: CohostUtteranceState::Laugh,
                        enabled: true,
                    }],
                },
                answers: CohostCooldownBehaviour {
                    enabled: true,
                    cooldown_seconds: 30,
                },
                banter: default_banter(),
            }),
            ..CohostSettingsPatch::default()
        });
        database
            .save_setting(COHOST_SETTINGS_KEY, &settings)
            .unwrap();
        assert_eq!(load_cohost_settings(&database), settings);
        let json = serde_json::to_value(&settings).unwrap();
        assert_eq!(json["persona"]["name"], "Grum the Goblin");
        assert_eq!(json["persona"]["bubbleStyle"], "shout");
        assert_eq!(json["persona"]["source"], "uploaded");
        assert_eq!(json["persona"]["images"]["idle"], "p-1/idle.png");
        // Absent states are omitted, never null (the renderer contract).
        assert!(json["persona"]["images"].get("talk").is_none());
        assert_eq!(json["autoChat"]["mode"], "suggest");
        assert_eq!(
            json["autoChat"]["greetings"]["templates"][0]["kind"],
            "follow"
        );
        assert_eq!(
            json["autoChat"]["greetings"]["templates"][0]["platform"],
            "twitch"
        );
        assert_eq!(
            json["autoChat"]["greetings"]["templates"][0]["state"],
            "laugh"
        );
        assert_eq!(json["autoChat"]["answers"]["cooldownSeconds"], 30);
        assert_eq!(json["autoChat"]["banter"]["cooldownSeconds"], 240);
    }

    #[test]
    fn settings_patch_refuses_an_out_of_bounds_persona_and_an_unknown_template_kind() {
        let persona = |name: &str, personality: &str| CohostPersona {
            name: name.to_string(),
            personality: personality.to_string(),
            ..CohostPersona::default()
        };
        assert_eq!(
            validate_persona(&persona("  Grum ", "")).unwrap().name,
            "Grum"
        );
        assert_eq!(
            validate_persona(&persona("   ", "")).unwrap_err(),
            "The Golem needs a name."
        );
        assert!(validate_persona(&persona(&"n".repeat(25), "")).is_err());
        assert!(validate_persona(&persona("Grum", &"p".repeat(1201))).is_err());
        let mut bad_path = persona("Grum", "");
        bad_path.images.idle = Some("../idle.png".to_string());
        assert_eq!(
            validate_persona(&bad_path).unwrap_err(),
            "The idle image path is not a managed asset path."
        );
        bad_path.images.idle = Some("/tmp/idle.png".to_string());
        assert!(validate_persona(&bad_path).is_err());
        bad_path.images.idle = Some("p-1/idle.png".to_string());
        assert!(validate_persona(&bad_path).is_ok());
        let refused = CohostSettings::validated_patch(CohostSettingsPatch {
            persona: Some(persona("", "")),
            ..CohostSettingsPatch::default()
        })
        .unwrap_err();
        assert_eq!(refused.code(), "cohost-persona-invalid");

        let template = |text: &str| CohostGreetingTemplate {
            id: "t".to_string(),
            kind: CohostActivityTemplateKind::Cheer,
            platform: None,
            text: text.to_string(),
            state: CohostUtteranceState::Talk,
            enabled: true,
        };
        let auto_chat = |templates: Vec<CohostGreetingTemplate>| CohostAutoChat {
            greetings: CohostGreetingsSettings {
                enabled: true,
                templates,
            },
            ..CohostAutoChat::default()
        };
        assert_eq!(
            validate_auto_chat(&auto_chat(vec![template("  hi {name} ")]))
                .unwrap()
                .greetings
                .templates[0]
                .text,
            "hi {name}"
        );
        assert_eq!(
            validate_auto_chat(&auto_chat(vec![template("   ")])).unwrap_err(),
            "A greeting template needs some text."
        );
        assert!(validate_auto_chat(&auto_chat(vec![template(&"x".repeat(201))])).is_err());
        assert!(validate_auto_chat(&auto_chat(vec![template("hi"); 61])).is_err());
        let refused = CohostSettings::validated_patch(CohostSettingsPatch {
            auto_chat: Some(auto_chat(vec![template("")])),
            ..CohostSettingsPatch::default()
        })
        .unwrap_err();
        assert_eq!(refused.code(), "cohost-auto-chat-invalid");
        // The kind enum is closed: an unknown kind never deserializes.
        let unknown = serde_json::from_value::<CohostSettingsPatch>(serde_json::json!({
            "autoChat": {
                "mode": "off",
                "greetings": {
                    "enabled": true,
                    "templates": [{ "id": "t", "kind": "hype-train", "text": "hi", "state": "talk", "enabled": true }]
                },
                "answers": { "enabled": false, "cooldownSeconds": 20 },
                "banter": { "enabled": false, "cooldownSeconds": 240 }
            }
        }))
        .unwrap_err();
        assert!(unknown.to_string().contains("hype-train"), "{unknown}");
    }

    #[test]
    fn settings_round_trip_through_storage_and_cap_notes() {
        let database = Database::open_in_memory_for_tests();
        assert_eq!(load_cohost_settings(&database), CohostSettings::default());
        let mut settings = CohostSettings::default();
        settings.apply(CohostSettingsPatch {
            enabled: Some(true),
            tone: Some(CohostTone::Professional),
            notes: Some("n".repeat(COHOST_NOTES_MAX_CHARS + 25)),
            auto_highlight: Some(true),
            voice_highlight: None,
            rules: Some(vec!["  No spoilers ".to_string(), "   ".to_string()]),
            listen: None,
            wake_word_required: None,
            remove_confirm: None,
            persona: None,
            auto_chat: None,
        });
        assert_eq!(settings.notes.chars().count(), COHOST_NOTES_MAX_CHARS);
        assert_eq!(settings.rules, vec!["No spoilers".to_string()]);
        database
            .save_setting(COHOST_SETTINGS_KEY, &settings)
            .unwrap();
        assert_eq!(load_cohost_settings(&database), settings);
        let json = serde_json::to_value(&settings).unwrap();
        assert_eq!(json["tone"], "professional");
        assert_eq!(json["autoHighlight"], true);
        assert_eq!(json["enabled"], true);
    }

    #[test]
    fn state_wire_shape_uses_explicit_nulls() {
        let json = serde_json::to_value(CohostState::off()).unwrap();
        assert_eq!(json["sessionId"], serde_json::Value::Null);
        assert_eq!(json["status"], "off");
        assert_eq!(json["reason"], serde_json::Value::Null);
        assert_eq!(json["mood"], serde_json::Value::Null);
        assert_eq!(json["lastTickAt"], serde_json::Value::Null);
        assert_eq!(json["tickSeq"], 0);
        assert_eq!(json["partial"], false);
        assert_eq!(json["questions"], serde_json::json!([]));
        assert_eq!(json["flags"], serde_json::json!([]));
        // Presence fields always ride the wire, defaults included.
        assert_eq!(json["tickInFlight"], false);
        assert_eq!(json["pendingMessages"], 0);
        assert_eq!(json["nextTickAt"], serde_json::Value::Null);
        assert_eq!(json["messagesSeen"], 0);
        assert_eq!(json["questionsTotal"], 0);
        // Wire-v2 fields are omitted while empty — never null (the renderer
        // contract rejects null for optional fields).
        for key in ["highlights", "alerts", "moodScores"] {
            assert!(json.get(key).is_none(), "{key} must be absent while empty");
        }
    }

    #[test]
    fn state_without_presence_fields_still_parses_to_defaults() {
        // A payload from before the presence fields existed (<= 0.9.70).
        let legacy: CohostState = serde_json::from_value(serde_json::json!({
            "sessionId": "session-1",
            "status": "listening",
            "reason": null,
            "detail": null,
            "questions": [],
            "flags": [],
            "mood": null,
            "lastTickAt": "2026-08-22T10:00:20Z",
            "tickSeq": 2,
            "partial": false
        }))
        .unwrap();
        assert!(!legacy.tick_in_flight);
        assert_eq!(legacy.pending_messages, 0);
        assert_eq!(legacy.next_tick_at, None);
        assert_eq!(legacy.messages_seen, 0);
        assert_eq!(legacy.questions_total, 0);
    }

    #[test]
    fn pending_bucket_emits_at_one_then_every_five() {
        let cases = [
            (0, 0),
            (1, 1),
            (2, 1),
            (5, 1),
            (6, 2),
            (10, 2),
            (11, 3),
            (60, 12),
        ];
        for (pending, bucket) in cases {
            assert_eq!(pending_bucket(pending), bucket, "pending={pending}");
        }
    }

    #[test]
    fn next_tick_due_at_matches_both_scheduler_rules() {
        let start = Instant::now();
        let now = start + secs(2);
        // Empty delta: no next pass to announce.
        assert_eq!(next_tick_due_at(0, start, None, None, now), None);
        // Trickle rule: 1..4 pending fire at anchor + 20 s.
        assert_eq!(
            next_tick_due_at(1, start, None, None, now),
            Some(start + secs(20))
        );
        assert_eq!(
            next_tick_due_at(4, start, None, None, now),
            Some(start + secs(20))
        );
        // Burst rule: >= 5 pending fire immediately without a previous tick...
        assert_eq!(next_tick_due_at(5, start, None, None, now), Some(now));
        // ...and as soon as the 8 s min gap allows after one.
        let last = start + secs(1);
        assert_eq!(
            next_tick_due_at(9, last, Some(last), None, now),
            Some(last + secs(8))
        );
        // Trickle after a tick: the 20 s rule dominates the 8 s floor.
        assert_eq!(
            next_tick_due_at(1, last, Some(last), None, now),
            Some(last + secs(20))
        );
        // A backoff/quota window pushes both rules back.
        let attempt = start + secs(40);
        assert_eq!(
            next_tick_due_at(5, last, Some(last), Some(attempt), now),
            Some(attempt)
        );
        // The announced pass is never in the past.
        let late = start + secs(90);
        assert_eq!(
            next_tick_due_at(1, last, Some(last), Some(attempt), late),
            Some(late)
        );
    }

    #[test]
    fn tick_in_flight_toggles_around_the_request_on_success_and_failure() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        assert!(!engine.snapshot().tick_in_flight);
        engine.note_messages(&messages("session-1", 0..7));
        let queued = engine
            .session
            .as_ref()
            .unwrap()
            .snapshot_at(start + secs(1));
        assert_eq!(queued.pending_messages, 7);
        assert!(!queued.tick_in_flight);
        assert!(
            queued.next_tick_at.is_some(),
            "pending messages must announce the next pass"
        );

        // Sending drains the delta and raises tick_in_flight until the result.
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        let in_flight = engine.snapshot();
        assert!(in_flight.tick_in_flight);
        assert_eq!(in_flight.pending_messages, 0);
        assert_eq!(in_flight.next_tick_at, None);
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(vec![question("q_1", &[])])),
            start + secs(2),
            "t1"
        ));
        let merged = engine.snapshot();
        assert!(!merged.tick_in_flight);
        assert_eq!(merged.pending_messages, 0);
        assert_eq!(merged.messages_seen, 7);
        assert_eq!(merged.questions_total, 1);

        // Failure path clears the flag too.
        engine.note_messages(&messages("session-1", 7..14));
        engine
            .prepare_tick(generation, true, true, start + secs(30))
            .unwrap();
        assert!(engine.snapshot().tick_in_flight);
        assert!(engine.apply_tick_result(
            generation,
            0,
            Err(CohostApiError::network("offline")),
            start + secs(31),
            "t2"
        ));
        let failed = engine.snapshot();
        assert!(!failed.tick_in_flight);
        assert_eq!(failed.pending_messages, 0);
        assert_eq!(failed.messages_seen, 14);
    }

    #[test]
    fn questions_total_counts_each_grouped_id_once_for_the_session() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..5);
        engine.note_messages(&rows);
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(vec![
                question("q_1", &[rows[0].id.as_str()]),
                question("q_2", &[rows[1].id.as_str()]),
            ])),
            start + secs(2),
            "t1"
        ));
        assert_eq!(engine.snapshot().questions_total, 2);

        // A kept id does not re-count; a dismissed id keeps its count; a new
        // id adds one.
        assert!(engine.mark_answered("session-1", "q_2").unwrap());
        engine.note_messages(&messages("session-1", 5..10));
        engine
            .prepare_tick(generation, true, true, start + secs(30))
            .unwrap();
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(vec![
                question("q_1", &[rows[2].id.as_str()]),
                question("q_3", &[rows[3].id.as_str()]),
            ])),
            start + secs(31),
            "t2"
        ));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.questions_total, 3);
        assert_eq!(snapshot.questions.len(), 2, "open count stays distinct");
        assert_eq!(snapshot.messages_seen, 10);
    }

    #[tokio::test]
    async fn note_messages_emits_only_on_bucket_crossings() {
        let state = test_state();
        {
            let mut engine = state.cohost.lock().await;
            engine.settings.enabled = true;
            engine.start_session("session-1".to_string(), true, None, Instant::now());
        }
        let mut events = state.events.subscribe();
        let drain_states = |events: &mut broadcast::Receiver<crate::protocol::ServerEvent>| {
            let mut states = Vec::new();
            while let Ok(event) = events.try_recv() {
                if event.event == COHOST_STATE_EVENT {
                    states.push(event.payload);
                }
            }
            states
        };

        // 0 -> 1 crosses into the first bucket: one emit.
        note_messages(&state, &messages("session-1", 0..1)).await;
        let states = drain_states(&mut events);
        assert_eq!(states.len(), 1);
        assert_eq!(states[0]["pendingMessages"], 1);
        assert!(states[0]["nextTickAt"].is_string());
        assert_eq!(states[0]["tickInFlight"], false);

        // 1 -> 4 stays inside the bucket: silent.
        note_messages(&state, &messages("session-1", 1..4)).await;
        assert!(drain_states(&mut events).is_empty());

        // 4 -> 7 crosses into the second bucket: one emit.
        note_messages(&state, &messages("session-1", 4..7)).await;
        let states = drain_states(&mut events);
        assert_eq!(states.len(), 1);
        assert_eq!(states[0]["pendingMessages"], 7);

        // No engine session: never an emit.
        state.cohost.lock().await.stop_session();
        note_messages(&state, &messages("session-1", 7..9)).await;
        assert!(drain_states(&mut events).is_empty());
    }

    #[tokio::test]
    async fn start_requires_enabled_settings_and_the_active_chat_session() {
        let state = test_state();
        let params = CohostStartParams {
            session_id: "session-1".to_string(),
            consent_to_process_chat: true,
            stream_title: None,
        };
        assert_eq!(
            start_cohost(&state, params.clone()).await,
            Err(CohostError::SessionMismatch)
        );
        state
            .live_chat
            .lock()
            .await
            .start_session("session-1".to_string(), Vec::new());
        assert_eq!(
            start_cohost(&state, params.clone()).await,
            Err(CohostError::Disabled)
        );
        assert_eq!(CohostError::Disabled.code(), "cohost-disabled");

        let settings = set_cohost_settings(
            &state,
            CohostSettingsPatch {
                enabled: Some(true),
                tone: None,
                notes: Some("hello".to_string()),
                auto_highlight: None,
                voice_highlight: None,
                rules: None,
                listen: None,
                wake_word_required: None,
                remove_confirm: None,
                persona: None,
                auto_chat: None,
            },
        )
        .await
        .unwrap();
        assert!(settings.enabled);
        assert_eq!(load_cohost_settings(&state.database), settings);

        let mut events = state.events.subscribe();
        let started = start_cohost(&state, params.clone()).await.unwrap();
        assert_eq!(started.status, CohostStatus::Listening);
        assert_eq!(started.session_id.as_deref(), Some("session-1"));
        let mut saw_state_event = false;
        while let Ok(event) = events.try_recv() {
            if event.event == COHOST_STATE_EVENT {
                saw_state_event = true;
            }
        }
        assert!(saw_state_event, "cohost.start must emit cohost.state");
        // No-op when already running for that session.
        let again = start_cohost(&state, params).await.unwrap();
        assert_eq!(again, started);

        // Delivered rows are noted; answered-after-send clears the question.
        note_messages(&state, &messages("session-1", 0..3)).await;
        assert_eq!(
            state
                .cohost
                .lock()
                .await
                .session
                .as_ref()
                .unwrap()
                .pending
                .len(),
            3
        );
        state
            .cohost
            .lock()
            .await
            .session
            .as_mut()
            .unwrap()
            .questions
            .push(CohostQuestion {
                id: "q_1".to_string(),
                text: "?".to_string(),
                message_ids: Vec::new(),
                askers: Vec::new(),
                platforms: Vec::new(),
                priority: CohostPriority::Normal,
                suggested_reply: String::new(),
                from_notes: false,
                first_seen_at: "t".to_string(),
                updated_at: "t".to_string(),
                on_topic: false,
            });
        note_own_send_delivered(&state, "session-1", "Keychron Q1!", Some("q_1")).await;
        assert!(cohost_status(&state).await.questions.is_empty());

        // Turning the setting off stops the session.
        set_cohost_settings(
            &state,
            CohostSettingsPatch {
                enabled: Some(false),
                tone: None,
                notes: None,
                auto_highlight: None,
                voice_highlight: None,
                rules: None,
                listen: None,
                wake_word_required: None,
                remove_confirm: None,
                persona: None,
                auto_chat: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(cohost_status(&state).await, CohostState::off());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_replacement_cannot_overtake_a_validated_cohost_start() {
        use std::future::Future as _;
        use std::task::Poll;

        let state = test_state();
        state
            .live_chat
            .lock()
            .await
            .start_session("session-a".to_string(), Vec::new());
        state.cohost.lock().await.settings.enabled = true;

        let (validated_tx, validated_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let start_state = state.clone();
        let start = tokio::spawn(async move {
            start_cohost_after_chat_validation(
                &start_state,
                CohostStartParams {
                    session_id: "session-a".to_string(),
                    consent_to_process_chat: true,
                    stream_title: None,
                },
                async move {
                    let _ = validated_tx.send(());
                    let _ = resume_rx.await;
                },
                std::future::ready(()),
            )
            .await
        });
        validated_rx
            .await
            .expect("co-host start validates the original chat session");

        let replacement_params: crate::live_chat::LiveChatStartParams =
            serde_json::from_value(serde_json::json!({
                "sessionId": "session-b",
                "platforms": []
            }))
            .expect("replacement live-chat params");
        let mut replacement = Box::pin(crate::live_chat::start_live_chat(
            &state,
            replacement_params,
        ));
        let completed_during_gap = std::future::poll_fn(|context| {
            Poll::Ready(match replacement.as_mut().poll(context) {
                Poll::Ready(snapshot) => Some(snapshot),
                Poll::Pending => None,
            })
        })
        .await;
        assert!(
            completed_during_gap.is_none(),
            "chat replacement must wait for the validated co-host start lifecycle transaction"
        );

        resume_tx.send(()).expect("resume co-host start");
        let started = start
            .await
            .expect("co-host start task")
            .expect("start co-host for original session");
        assert_eq!(started.session_id.as_deref(), Some("session-a"));

        let replacement = replacement.await;
        assert_eq!(replacement.session_id.as_deref(), Some("session-b"));
        assert_eq!(cohost_status(&state).await, CohostState::off());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn start_cohost_emission_order_survives_chat_replacement() {
        use std::future::Future as _;
        use std::task::Poll;

        let state = test_state();
        state
            .live_chat
            .lock()
            .await
            .start_session("session-a".to_string(), Vec::new());
        state.cohost.lock().await.settings.enabled = true;
        let mut events = state.events.subscribe();

        let (captured_tx, captured_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let start_state = state.clone();
        let start = tokio::spawn(async move {
            start_cohost_after_chat_validation(
                &start_state,
                CohostStartParams {
                    session_id: "session-a".to_string(),
                    consent_to_process_chat: true,
                    stream_title: None,
                },
                std::future::ready(()),
                async move {
                    let _ = captured_tx.send(());
                    let _ = resume_rx.await;
                },
            )
            .await
        });
        captured_rx
            .await
            .expect("co-host start captures the original session state");

        let replacement_params: crate::live_chat::LiveChatStartParams =
            serde_json::from_value(serde_json::json!({
                "sessionId": "session-b",
                "platforms": []
            }))
            .expect("replacement live-chat params");
        let mut replacement = Box::pin(crate::live_chat::start_live_chat(
            &state,
            replacement_params,
        ));
        let completed_during_emit_gap = std::future::poll_fn(|context| {
            Poll::Ready(match replacement.as_mut().poll(context) {
                Poll::Ready(snapshot) => Some(snapshot),
                Poll::Pending => None,
            })
        })
        .await;

        resume_tx.send(()).expect("resume co-host state emit");
        let started = start
            .await
            .expect("co-host start task")
            .expect("start original co-host");
        assert_eq!(started.session_id.as_deref(), Some("session-a"));
        let replacement = match completed_during_emit_gap {
            Some(snapshot) => snapshot,
            None => replacement.await,
        };
        assert_eq!(replacement.session_id.as_deref(), Some("session-b"));
        assert_eq!(cohost_status(&state).await, CohostState::off());

        let mut states = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event.event == COHOST_STATE_EVENT {
                states.push(event.payload);
            }
        }
        let final_event = states.last().expect("co-host state events");
        assert_eq!(final_event["status"], "off");
        assert_eq!(final_event["sessionId"], serde_json::Value::Null);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn public_stop_cohost_emission_order_survives_fenced_start() {
        use std::future::Future as _;
        use std::task::Poll;

        let state = test_state();
        state
            .live_chat
            .lock()
            .await
            .start_session("session-a".to_string(), Vec::new());
        state.cohost.lock().await.settings.enabled = true;
        let mut events = state.events.subscribe();
        let (captured_tx, captured_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let start_state = state.clone();
        let start = tokio::spawn(async move {
            start_cohost_after_chat_validation(
                &start_state,
                CohostStartParams {
                    session_id: "session-a".to_string(),
                    consent_to_process_chat: true,
                    stream_title: None,
                },
                std::future::ready(()),
                async move {
                    let _ = captured_tx.send(());
                    let _ = resume_rx.await;
                },
            )
            .await
        });
        captured_rx
            .await
            .expect("co-host start captures listening state");

        let mut stop = Box::pin(stop_cohost(&state));
        let completed_during_emit_gap = std::future::poll_fn(|context| {
            Poll::Ready(match stop.as_mut().poll(context) {
                Poll::Ready(snapshot) => Some(snapshot),
                Poll::Pending => None,
            })
        })
        .await;
        resume_tx.send(()).expect("resume co-host start emit");
        start
            .await
            .expect("co-host start task")
            .expect("co-host start result");
        let stopped = match completed_during_emit_gap {
            Some(snapshot) => snapshot,
            None => stop.await,
        };
        assert_eq!(stopped, CohostState::off());
        assert_eq!(cohost_status(&state).await, CohostState::off());

        let mut states = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event.event == COHOST_STATE_EVENT {
                states.push(event.payload);
            }
        }
        let final_event = states.last().expect("co-host state events");
        assert_eq!(final_event["status"], "off");
        assert_eq!(final_event["sessionId"], serde_json::Value::Null);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn settings_stop_emission_order_survives_fenced_start() {
        use std::future::Future as _;
        use std::task::Poll;

        let state = test_state();
        state
            .live_chat
            .lock()
            .await
            .start_session("session-a".to_string(), Vec::new());
        state.cohost.lock().await.settings.enabled = true;
        let mut events = state.events.subscribe();
        let (captured_tx, captured_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let start_state = state.clone();
        let start = tokio::spawn(async move {
            start_cohost_after_chat_validation(
                &start_state,
                CohostStartParams {
                    session_id: "session-a".to_string(),
                    consent_to_process_chat: true,
                    stream_title: None,
                },
                std::future::ready(()),
                async move {
                    let _ = captured_tx.send(());
                    let _ = resume_rx.await;
                },
            )
            .await
        });
        captured_rx
            .await
            .expect("co-host start captures listening state");

        let mut disable = Box::pin(set_cohost_settings(
            &state,
            CohostSettingsPatch {
                enabled: Some(false),
                ..Default::default()
            },
        ));
        let completed_during_emit_gap = std::future::poll_fn(|context| {
            Poll::Ready(match disable.as_mut().poll(context) {
                Poll::Ready(result) => Some(result),
                Poll::Pending => None,
            })
        })
        .await;
        resume_tx.send(()).expect("resume co-host start emit");
        start
            .await
            .expect("co-host start task")
            .expect("co-host start result");
        let settings = match completed_during_emit_gap {
            Some(result) => result,
            None => disable.await,
        }
        .expect("disable co-host settings");
        assert!(!settings.enabled);
        assert_eq!(cohost_status(&state).await, CohostState::off());

        let mut states = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event.event == COHOST_STATE_EVENT {
                states.push(event.payload);
            }
        }
        let final_event = states.last().expect("co-host state events");
        assert_eq!(final_event["status"], "off");
        assert_eq!(final_event["sessionId"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn live_chat_stop_clears_the_engine_session() {
        let state = test_state();
        state
            .live_chat
            .lock()
            .await
            .start_session("session-1".to_string(), Vec::new());
        set_cohost_settings(
            &state,
            CohostSettingsPatch {
                enabled: Some(true),
                tone: None,
                notes: None,
                auto_highlight: None,
                voice_highlight: None,
                rules: None,
                listen: None,
                wake_word_required: None,
                remove_confirm: None,
                persona: None,
                auto_chat: None,
            },
        )
        .await
        .unwrap();
        start_cohost(
            &state,
            CohostStartParams {
                session_id: "session-1".to_string(),
                consent_to_process_chat: true,
                stream_title: None,
            },
        )
        .await
        .unwrap();
        crate::live_chat::stop_live_chat(&state).await;
        assert_eq!(cohost_status(&state).await, CohostState::off());
        assert!(state.cohost.lock().await.scheduler.is_none());
    }

    // --- Plan 068 S3: listen setting, listening state, recent speech --------

    #[tokio::test]
    async fn listen_setting_round_trips_and_defaults_off() {
        let state = test_state();
        let settings = set_cohost_settings(
            &state,
            CohostSettingsPatch {
                listen: Some(true),
                ..CohostSettingsPatch::default()
            },
        )
        .await
        .unwrap();
        assert!(settings.listen);
        assert_eq!(load_cohost_settings(&state.database), settings);
        assert_eq!(
            serde_json::to_value(&settings).unwrap()["listen"],
            serde_json::Value::Bool(true)
        );
        let legacy: CohostSettings = serde_json::from_value(serde_json::json!({
            "enabled": true, "tone": "short", "notes": "", "autoHighlight": false
        }))
        .unwrap();
        assert!(!legacy.listen);
        assert!(!CohostSettings::default().listen);
    }

    #[test]
    fn state_serialization_omits_listening_when_none_and_never_writes_null() {
        let off = serde_json::to_value(CohostState::off()).unwrap();
        assert!(off.get("listening").is_none());
        let mut state = CohostState::off();
        state.listening = Some(CohostListening::on(None));
        let wire = serde_json::to_value(&state).unwrap();
        assert_eq!(wire["listening"], serde_json::json!({ "state": "on" }));
        state.listening = Some(CohostListening::blocked(
            "no-microphone",
            "Select a microphone.",
        ));
        let wire = serde_json::to_value(&state).unwrap();
        assert_eq!(
            wire["listening"],
            serde_json::json!({
                "state": "blocked",
                "reasonCode": "no-microphone",
                "message": "Select a microphone."
            })
        );
        let parsed: CohostState = serde_json::from_value(wire).unwrap();
        assert_eq!(parsed, state);
        let starting = serde_json::to_value(CohostListening::starting()).unwrap();
        assert_eq!(starting, serde_json::json!({ "state": "starting" }));
    }

    #[test]
    fn recent_speech_keeps_five_minutes_and_reports_versions() {
        let mut speech = RecentSpeech::default();
        let now = Instant::now();
        let final_at = |at: Instant, text: &str, offset: f64| RecentSpeechFinal {
            at,
            offset_seconds: offset,
            duration_seconds: 3.0,
            text: text.to_string(),
            segments: Vec::new(),
            presented: false,
        };
        assert!(speech.since(None, now).is_some());
        assert!(speech.since(Some(speech.version()), now).is_none());
        let old = now
            .checked_sub(RECENT_SPEECH_WINDOW + Duration::from_secs(1))
            .expect("monotonic clock has room");
        speech.push(final_at(old, "too old", 0.0));
        speech.push(final_at(now, "fresh", 30.0));
        let snapshot = speech.since(None, now).unwrap();
        assert_eq!(
            snapshot
                .finals
                .iter()
                .map(|f| f.text.as_str())
                .collect::<Vec<_>>(),
            vec!["fresh"]
        );
        assert_eq!(snapshot.finals[0].offset_seconds, 30.0);
        assert!(speech.since(Some(snapshot.version), now).is_none());
        speech.push(final_at(now, "later", 33.0));
        let next = speech.since(Some(snapshot.version), now).unwrap();
        assert_eq!(next.finals.len(), 2);
        assert_ne!(next.version, snapshot.version);
        speech.clear();
        let cleared = speech.since(Some(next.version), now).unwrap();
        assert!(cleared.finals.is_empty());
    }

    #[tokio::test]
    async fn transcript_final_feeds_both_buffers_and_a_session_boundary_clears_them() {
        let state = test_state();
        let update = CaptionsUpdate {
            session_client_id: "captions-test".to_string(),
            seq: 1,
            kind: CaptionUpdateKind::Final,
            text: "clip that".to_string(),
            chunk_seconds: 3,
            remaining_seconds: None,
        };
        note_transcript_final(
            &state,
            &update,
            RecentSpeechFinal {
                at: Instant::now(),
                offset_seconds: 12.0,
                duration_seconds: 3.0,
                text: "clip that".to_string(),
                segments: Vec::new(),
                presented: false,
            },
            true,
        );
        assert_eq!(
            state
                .cohost_transcript
                .lock()
                .unwrap()
                .snapshot(Instant::now())
                .text,
            "clip that"
        );
        let speech = recent_speech_since(&state, None).unwrap();
        assert_eq!(speech.finals.len(), 1);
        assert_eq!(speech.finals[0].offset_seconds, 12.0);
        clear_transcript(&state);
        assert!(recent_speech_since(&state, None).unwrap().finals.is_empty());
        assert!(
            state
                .cohost_transcript
                .lock()
                .unwrap()
                .snapshot(Instant::now())
                .text
                .is_empty()
        );

        // Voice activity: a quiet frame is a frame, a loud one is a voice.
        let before = voice_activity(&state);
        assert_eq!(before, VoiceActivity::default());
        let t0 = Instant::now();
        // A muted microphone: frames arrive, exact digital silence.
        note_voice_frame(&state, &[0.0; 640], &vec![0i16; 320], t0);
        assert_eq!(voice_activity(&state).last_frame_at, Some(t0));
        assert_eq!(voice_activity(&state).last_voice_at, None);
        assert_eq!(voice_activity(&state).last_signal_at, None);
        assert_eq!(voice_activity(&state).live_since, None);
        // A quiet room is a live signal (the noise floor), not a voice.
        let t_quiet = t0 + Duration::from_millis(10);
        note_voice_frame(&state, &[0.000_01; 640], &vec![0i16; 320], t_quiet);
        assert_eq!(voice_activity(&state).last_signal_at, Some(t_quiet));
        assert_eq!(voice_activity(&state).live_since, Some(t_quiet));
        assert_eq!(voice_activity(&state).last_voice_at, None);
        let loud: Vec<i16> = (0..320)
            .map(|i| if i % 2 == 0 { 3_000 } else { -3_000 })
            .collect();
        let t1 = t0 + Duration::from_millis(20);
        note_voice_frame(&state, &[0.1; 640], &loud, t1);
        assert_eq!(voice_activity(&state).last_voice_at, Some(t1));
        // The live run continues; a gap longer than the stale window (a
        // mute) starts a new one.
        assert_eq!(voice_activity(&state).live_since, Some(t_quiet));
        let t2 = t1 + Duration::from_secs(10);
        note_voice_frame(&state, &[0.1; 640], &loud, t2);
        assert_eq!(voice_activity(&state).live_since, Some(t2));
    }

    #[tokio::test]
    async fn same_chat_start_applies_consent_in_both_directions_without_resetting_history() {
        let state = test_state();
        state
            .live_chat
            .lock()
            .await
            .start_session("session-1".to_string(), Vec::new());
        set_cohost_settings(
            &state,
            CohostSettingsPatch {
                enabled: Some(true),
                listen: Some(true),
                ..CohostSettingsPatch::default()
            },
        )
        .await
        .unwrap();
        let mut params = CohostStartParams {
            session_id: "session-1".into(),
            consent_to_process_chat: true,
            stream_title: Some("Same stream".into()),
        };
        start_cohost(&state, params.clone()).await.unwrap();
        assert!(crate::captions::listen_wanted_for_test(&state).await);
        let now = Instant::now();
        let (started_at, before) = {
            let mut engine = state.cohost.lock().await;
            let generation = engine.session.as_ref().unwrap().generation;
            let rows = messages("session-1", 0..5);
            engine.note_messages_at(&rows, now);
            engine.apply_tick_result(
                generation,
                0,
                Ok(response(vec![question("q_keep", &[rows[0].id.as_str()])])),
                now,
                "before",
            );
            (
                engine.session.as_ref().unwrap().started_at,
                engine.snapshot(),
            )
        };
        let mut events = state.events.subscribe();

        params.consent_to_process_chat = false;
        let revoked = start_cohost(&state, params.clone()).await.unwrap();
        {
            let mut engine = state.cohost.lock().await;
            let session = engine.session.as_ref().unwrap();
            assert!(
                !session.consent,
                "same-session RPC must store revoked consent"
            );
            assert_eq!(session.started_at, started_at);
            assert_eq!(revoked.questions, before.questions);
            assert_eq!(revoked.tick_seq, before.tick_seq);
            let generation = session.generation;
            assert!(
                engine
                    .prepare_tick(generation, true, true, now + secs(30))
                    .is_err()
            );
        }
        assert_eq!(revoked.status, CohostStatus::Paused);
        assert_eq!(revoked.reason, Some(CohostReason::ConsentRequired));
        assert_eq!(
            revoked.listening,
            Some(CohostListening::blocked(
                "consent-required",
                "Golem can hear you once cloud AI consent is on."
            ))
        );
        assert!(!crate::captions::listen_wanted_for_test(&state).await);
        let published = events.try_recv().unwrap();
        assert_eq!(published.event, COHOST_STATE_EVENT);
        assert_eq!(published.payload, serde_json::to_value(&revoked).unwrap());

        params.consent_to_process_chat = true;
        let granted = start_cohost(&state, params.clone()).await.unwrap();
        assert_eq!(granted.questions, before.questions);
        assert_eq!(granted.status, CohostStatus::Listening);
        assert_eq!(granted.reason, None);
        assert!(crate::captions::listen_wanted_for_test(&state).await);
        let generation = {
            let mut engine = state.cohost.lock().await;
            let session = engine.session.as_ref().unwrap();
            assert!(session.consent);
            assert_eq!(session.started_at, started_at);
            let generation = session.generation;
            let prepared = engine
                .prepare_tick(generation, true, true, now + secs(40))
                .unwrap();
            assert!(prepared.request.consent_to_process_chat);
            generation
        };
        let published = events.try_recv().unwrap();
        assert_eq!(published.event, COHOST_STATE_EVENT);
        assert_eq!(published.payload, serde_json::to_value(&granted).unwrap());
        let again = start_cohost(&state, params).await.unwrap();
        assert!(again.tick_in_flight);
        assert_eq!(
            state
                .cohost
                .lock()
                .await
                .session
                .as_ref()
                .unwrap()
                .generation,
            generation
        );
        assert!(
            events.try_recv().is_err(),
            "unchanged consent stays idempotent"
        );
        assert_eq!(state.live_chat.lock().await.session_id(), Some("session-1"));
        stop_cohost(&state).await;
    }

    #[tokio::test]
    async fn spotlight_admission_reads_transcript_after_the_lifecycle_boundary() {
        let state = test_state();
        let now = Instant::now();
        let generation = {
            let mut engine = state.cohost.lock().await;
            engine.settings = enabled_settings();
            let generation = engine.start_session("session-1".into(), true, None, now);
            engine.note_messages_at(&messages("session-1", 0..5), now);
            generation
        };
        state
            .cohost_transcript
            .lock()
            .unwrap()
            .push("retired speech", now - secs(1));
        let held_delivery = state.live_chat_persistence.begin_delivery().await;
        let (queued_tx, queued_rx) = tokio::sync::oneshot::channel();
        let pass_state = state.clone();
        let admission = tokio::spawn(async move {
            prepare_spotlight_pass(&pass_state, generation, true, true, async {
                queued_tx.send(()).unwrap();
            })
            .await
        });
        tokio::time::timeout(secs(1), queued_rx)
            .await
            .unwrap()
            .unwrap();
        // Consent/session retirement owns this same fence and clears speech
        // before acknowledging the boundary. The queued scheduler must read it
        // afterward, even when its generation already belongs to the new intent.
        clear_transcript(&state);
        drop(held_delivery);
        let (_delivery, _, pass) = tokio::time::timeout(secs(1), admission)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            pass,
            SpotlightPass::Idle,
            "retired snapshot cannot admit new-generation spotlight work"
        );
    }

    #[tokio::test]
    async fn consent_epochs_drop_delayed_tick_spotlight_and_speech_without_losing_chat() {
        let state = test_state();
        state
            .live_chat
            .lock()
            .await
            .start_session("session-1".into(), Vec::new());
        set_cohost_settings(
            &state,
            CohostSettingsPatch {
                enabled: Some(true),
                listen: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let params = CohostStartParams {
            session_id: "session-1".into(),
            consent_to_process_chat: true,
            stream_title: None,
        };
        start_cohost(&state, params.clone()).await.unwrap();
        let now = Instant::now();
        let rows = messages("session-1", 0..5);
        let (tick, spotlight) = {
            let mut engine = state.cohost.lock().await;
            let generation = engine.session.as_ref().unwrap().generation;
            engine.note_messages_at(&rows, now);
            let tick = engine
                .prepare_tick(generation, true, true, now + secs(1))
                .unwrap();
            let spotlight = send_spotlight(&mut engine, generation, 1, now + secs(1)).unwrap();
            (tick, spotlight)
        };
        let listen_epoch = crate::captions::current_listen_epoch(&state).await;
        let revoked = start_cohost(
            &state,
            CohostStartParams {
                consent_to_process_chat: false,
                ..params.clone()
            },
        )
        .await
        .unwrap();
        assert!(!revoked.tick_in_flight);
        assert_eq!(
            revoked.pending_messages as usize,
            tick.request.messages.len() + 1,
            "retired tick restores its chat delta"
        );
        let mut events = state.events.subscribe();
        for grant in [false, true] {
            if grant {
                start_cohost(&state, params.clone()).await.unwrap();
            }
            let expected = state.cohost.lock().await.snapshot();
            {
                let mut engine = state.cohost.lock().await;
                let generation = engine.session.as_ref().unwrap().generation;
                assert_ne!(generation, tick.generation);
                assert_eq!(engine.generation, generation);
                assert!(!engine.scheduler.as_ref().unwrap().is_finished());
                assert!(!engine.spotlight_scheduler.as_ref().unwrap().is_finished());
                assert!(!engine.apply_tick_result(
                    tick.generation,
                    0,
                    Ok(response(vec![question("q_late", &[rows[0].id.as_str()])])),
                    now + secs(2),
                    "late"
                ));
                assert!(
                    engine
                        .apply_spotlight_result(
                            spotlight.generation,
                            Ok(spotlight_response(vec![spotlight_match(
                                &rows[0].id,
                                0.95,
                                None
                            )])),
                            now + secs(2),
                            "late"
                        )
                        .is_none()
                );
                assert_eq!(
                    engine.note_speech(tick.generation, &speech(&[(now, "stale words")])),
                    0
                );
                let mut actual = engine.snapshot();
                // nextTickAt projects a monotonic deadline onto wall time on
                // each snapshot, so its sub-microsecond spelling can drift.
                assert_eq!(
                    actual.next_tick_at.is_some(),
                    expected.next_tick_at.is_some()
                );
                actual.next_tick_at = expected.next_tick_at.clone();
                assert_eq!(actual, expected);
                if grant {
                    let next = engine
                        .prepare_tick(generation, true, true, now + secs(30))
                        .unwrap();
                    assert_eq!(
                        &next.request.messages[..tick.request.messages.len()],
                        tick.request.messages.as_slice()
                    );
                    assert!(next.request.transcript.is_none());
                } else {
                    assert!(
                        engine
                            .prepare_tick(generation, true, true, now + secs(30))
                            .is_err()
                    );
                    assert_eq!(
                        engine.prepare_spotlight(
                            generation,
                            true,
                            true,
                            &TranscriptSnapshot::default(),
                            now + secs(30)
                        ),
                        SpotlightPass::Idle
                    );
                }
            }
            while events.try_recv().is_ok() {}
            crate::cohost::publish_listening_for_epoch(
                &state,
                listen_epoch,
                CohostListening::on(Some(120)),
            )
            .await;
            assert!(
                events.try_recv().is_err(),
                "stale speech readiness never publishes"
            );
            assert_ne!(
                cohost_status(&state).await.listening,
                Some(CohostListening::on(Some(120)))
            );
        }
        stop_cohost(&state).await;
    }

    #[tokio::test]
    async fn start_with_listen_reports_a_quiet_block_and_stop_ends_the_intent() {
        let state = test_state();
        let mut events = state.events.subscribe();
        let drain_states = |events: &mut broadcast::Receiver<crate::protocol::ServerEvent>| {
            let mut states = Vec::new();
            while let Ok(event) = events.try_recv() {
                if event.event == COHOST_STATE_EVENT {
                    states.push(event.payload);
                }
            }
            states
        };
        state
            .live_chat
            .lock()
            .await
            .start_session("session-1".to_string(), Vec::new());
        set_cohost_settings(
            &state,
            CohostSettingsPatch {
                enabled: Some(true),
                listen: Some(true),
                ..CohostSettingsPatch::default()
            },
        )
        .await
        .unwrap();

        // No consent: Golem never starts the intent.
        let started = start_cohost(
            &state,
            CohostStartParams {
                session_id: "session-1".to_string(),
                consent_to_process_chat: false,
                stream_title: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            started.listening.as_ref().map(|listening| listening.state),
            Some(CohostListeningState::Blocked)
        );
        assert_eq!(
            started
                .listening
                .as_ref()
                .and_then(|listening| listening.reason_code.as_deref()),
            Some("consent-required")
        );
        assert!(!crate::captions::listen_wanted_for_test(&state).await);
        stop_cohost(&state).await;

        // Consent, no capture: the intent is wanted and quietly blocked.
        drain_states(&mut events);
        let started = start_cohost(
            &state,
            CohostStartParams {
                session_id: "session-1".to_string(),
                consent_to_process_chat: true,
                stream_title: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            started
                .listening
                .as_ref()
                .and_then(|listening| listening.reason_code.as_deref()),
            Some("no-capture")
        );
        assert!(crate::captions::listen_wanted_for_test(&state).await);
        let states = drain_states(&mut events);
        assert_eq!(states.len(), 1);
        assert_eq!(states[0]["listening"]["state"], "blocked");
        assert_eq!(states[0]["listening"]["reasonCode"], "no-capture");

        // Toggling the setting mid-session stops and restarts the intent.
        set_cohost_settings(
            &state,
            CohostSettingsPatch {
                listen: Some(false),
                ..CohostSettingsPatch::default()
            },
        )
        .await
        .unwrap();
        assert!(!crate::captions::listen_wanted_for_test(&state).await);
        let states = drain_states(&mut events);
        assert_eq!(states.len(), 1);
        assert_eq!(
            states[0]["listening"],
            serde_json::json!({ "state": "off" })
        );
        set_cohost_settings(
            &state,
            CohostSettingsPatch {
                listen: Some(true),
                ..CohostSettingsPatch::default()
            },
        )
        .await
        .unwrap();
        assert!(crate::captions::listen_wanted_for_test(&state).await);
        let states = drain_states(&mut events);
        assert_eq!(states[0]["listening"]["reasonCode"], "no-capture");

        // A task-side change publishes into the running session only.
        publish_listening(&state, CohostListening::on(Some(120))).await;
        let states = drain_states(&mut events);
        assert_eq!(
            states[0]["listening"],
            serde_json::json!({ "state": "on", "remainingSeconds": 120 })
        );
        publish_listening(&state, CohostListening::on(Some(120))).await;
        assert!(
            drain_states(&mut events).is_empty(),
            "no emit without a change"
        );

        // Every Golem stop ends the intent.
        stop_cohost(&state).await;
        assert!(!crate::captions::listen_wanted_for_test(&state).await);
        assert_eq!(cohost_status(&state).await.listening, None);
        publish_listening(&state, CohostListening::on(None)).await;
        assert!(
            drain_states(&mut events)
                .iter()
                .all(|s| s["listening"].is_null())
        );
    }

    // --- Plan 068 S6: chat you haven't acknowledged ---------------------------

    fn first_timer(seq: u32, name: &str) -> LiveChatMessage {
        let mut message = chat_message("session-1", seq, &format!("2026-09-27T10:00:{seq:02}Z"));
        message.author_id = Some(format!("id-{name}"));
        message.author_name = name.to_string();
        message.author_roles = Vec::new();
        message.message_text = format!("first time here #{seq}");
        message.first_message = true;
        message
    }

    fn say_hi_names(engine: &CohostEngine, at: Instant) -> Vec<String> {
        engine
            .snapshot_at_for_test(at)
            .say_hi
            .into_iter()
            .map(|entry| entry.name)
            .collect()
    }

    #[test]
    fn say_hi_follows_voice_highlight_reply_mention_and_the_greeted_button() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let knight = first_timer(1, "x_Dark_Knight_x");
        let bo = first_timer(2, "Bo");
        let anna = first_timer(3, "Anna");
        let sam = first_timer(4, "Sam");
        let dee = first_timer(5, "Dee");
        let mut owner = first_timer(6, "TheStreamer");
        owner.author_roles = vec!["broadcaster".to_string()];
        let mut regular = first_timer(7, "Regular");
        regular.first_message = false;
        for (index, row) in [&knight, &bo, &anna, &sam, &dee, &owner, &regular]
            .into_iter()
            .enumerate()
        {
            engine.note_messages_at(std::slice::from_ref(row), start + secs(index as u64));
        }
        // Oldest first; never the broadcaster, never a returning chatter.
        assert_eq!(
            say_hi_names(&engine, start + secs(8)),
            ["x_Dark_Knight_x", "Bo", "Anna", "Sam", "Dee"]
        );
        let wire = serde_json::to_value(engine.snapshot_at_for_test(start + secs(8))).unwrap();
        assert_eq!(
            wire["sayHi"][0],
            serde_json::json!({
                "authorKey": "\"twitch\":id-x_Dark_Knight_x",
                "name": "x_Dark_Knight_x",
                "platform": "twitch",
                "firstSeenAt": "2026-09-27T10:00:01Z"
            })
        );
        assert!(wire.get("deadAirNudge").is_none());

        // Voice: the same fold as the tick transcript greets by name.
        engine.note_speech(
            generation,
            &speech(&[(start + secs(10), "Oh hey Dark Night, welcome in")]),
        );
        assert_eq!(
            say_hi_names(&engine, start + secs(10)),
            ["Bo", "Anna", "Sam", "Dee"]
        );
        // The transcript still reaches the tick.
        assert!(
            engine
                .session
                .as_ref()
                .unwrap()
                .transcript_pending
                .contains("Dark Night")
        );

        // Their message on stream greets them.
        engine.evaluate_auto_highlight(generation, &live_card(&bo.id, secs(8)), start + secs(11));
        assert_eq!(
            say_hi_names(&engine, start + secs(11)),
            ["Anna", "Sam", "Dee"]
        );

        // A reply to their question greets whoever asked, and answers it.
        engine
            .session
            .as_mut()
            .unwrap()
            .questions
            .push(CohostQuestion {
                id: "q_anna".to_string(),
                text: "Which switches?".to_string(),
                message_ids: vec![anna.id.clone()],
                askers: vec!["Anna".to_string()],
                platforms: vec![StreamPlatform::Twitch],
                priority: CohostPriority::Normal,
                suggested_reply: String::new(),
                from_notes: false,
                first_seen_at: ISO.to_string(),
                updated_at: ISO.to_string(),
                on_topic: false,
            });
        assert!(engine.own_send_delivered(
            "session-1",
            "Gateron browns!",
            Some("q_anna"),
            start + secs(12)
        ));
        assert!(engine.snapshot().questions.is_empty());
        assert_eq!(say_hi_names(&engine, start + secs(12)), ["Sam", "Dee"]);

        // A name or @handle in the streamer's own send greets them.
        assert!(engine.own_send_delivered("session-1", "welcome in @Sam!", None, start + secs(13)));
        assert!(!engine.own_send_delivered("session-1", "thanks chat", None, start + secs(13)));
        assert!(!engine.own_send_delivered("other", "hi Dee", None, start + secs(13)));
        assert_eq!(say_hi_names(&engine, start + secs(13)), ["Dee"]);

        // The Greeted button.
        let dee_key = alert_author_key(&dee);
        assert_eq!(
            engine.mark_author_greeted("other", &dee_key, start + secs(14)),
            Err(CohostError::SessionMismatch)
        );
        assert_eq!(
            engine.mark_author_greeted("session-1", "nobody", start + secs(14)),
            Ok(false)
        );
        assert_eq!(
            engine.mark_author_greeted("session-1", &dee_key, start + secs(14)),
            Ok(true)
        );
        assert_eq!(
            engine.mark_author_greeted("session-1", &dee_key, start + secs(14)),
            Ok(false)
        );
        assert!(say_hi_names(&engine, start + secs(14)).is_empty());
        let log = engine.take_greeting_log();
        assert_eq!(log.len(), 5, "{log:?}");
        assert!(log[0].contains("x_Dark_Knight_x (twitch) was greeted by voice"));
        assert!(log[1].contains("Bo (twitch) was greeted on stream"));
        assert!(log[2].contains("Anna (twitch) was greeted in chat"));
        assert!(log[4].contains("Dee (twitch) was greeted by hand"));
        assert!(
            serde_json::to_value(engine.snapshot())
                .unwrap()
                .get("sayHi")
                .is_none()
        );
    }

    #[test]
    fn the_echo_of_the_streamers_own_send_never_asks_to_say_hi() {
        let start = Instant::now();
        let (mut engine, _) = running_engine(start);
        engine.note_own_send("session-1", "Welcome in everyone, great to see you", start);
        let mut echo = first_timer(1, "StreamerOnX");
        echo.platform = StreamPlatform::X;
        echo.message_text = "Welcome in everyone, great to see you".to_string();
        engine.note_messages_at(&[echo], start + secs(2));
        assert!(say_hi_names(&engine, start + secs(2)).is_empty());
    }

    #[test]
    fn dead_air_nudge_fires_once_per_two_minutes_with_a_fresh_key() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        engine.note_messages_at(&[first_timer(1, "Sam")], start);
        let quiet = |now: Instant| VoiceActivity {
            last_voice_at: Some(start),
            last_frame_at: Some(now),
            last_signal_at: Some(now),
            live_since: Some(start),
        };
        // The first pass publishes "Say hi"; nothing to nudge yet.
        let first = engine.refresh_acknowledgement(
            generation,
            quiet(start + secs(1)),
            start + secs(1),
            ISO,
        );
        assert_eq!(
            first,
            AcknowledgementPass {
                changed: true,
                nudge: None
            }
        );
        assert_eq!(
            engine.refresh_acknowledgement(
                generation,
                quiet(start + secs(2)),
                start + secs(2),
                ISO
            ),
            AcknowledgementPass::default()
        );
        // Twenty quiet seconds with a first-timer waiting.
        let at = start + secs(20);
        let pass = engine.refresh_acknowledgement(generation, quiet(at), at, ISO);
        assert!(pass.changed);
        assert_eq!(
            pass.nudge.as_deref(),
            Some("Dead air: say hi to Sam, it's their first chat.")
        );
        let nudge = engine.snapshot_at_for_test(at).dead_air_nudge.unwrap();
        assert_eq!(nudge.at, ISO);
        // Not again within two minutes; the nudge leaves the state on its own.
        let later = at + secs(60);
        assert!(
            !engine
                .refresh_acknowledgement(generation, quiet(later), later, ISO)
                .changed
        );
        assert_eq!(engine.snapshot_at_for_test(later).dead_air_nudge, None);
        // A question now waits: it wins over saying hi, with a new key.
        engine
            .session
            .as_mut()
            .unwrap()
            .questions
            .push(CohostQuestion {
                id: "q_1".to_string(),
                text: "What keyboard is that?".to_string(),
                message_ids: Vec::new(),
                askers: vec!["Sam".to_string()],
                platforms: vec![StreamPlatform::Twitch],
                priority: CohostPriority::High,
                suggested_reply: String::new(),
                from_notes: false,
                first_seen_at: ISO.to_string(),
                updated_at: ISO.to_string(),
                on_topic: false,
            });
        let again = at + secs(120);
        let pass = engine.refresh_acknowledgement(generation, quiet(again), again, ISO);
        assert_eq!(
            pass.nudge.as_deref(),
            Some("Dead air: answer Sam's question: “What keyboard is that?”")
        );
        let second = engine.snapshot_at_for_test(again).dead_air_nudge.unwrap();
        assert_ne!(second.key, nudge.key);
        // No frames (listening and captions off): no signal, no nudge.
        let silent = VoiceActivity::default();
        let much_later = again + secs(600);
        assert_eq!(
            engine
                .refresh_acknowledgement(generation, silent, much_later, ISO)
                .nudge,
            None
        );
        // A replaced generation changes nothing.
        assert_eq!(
            engine.refresh_acknowledgement(generation + 1, quiet(much_later), much_later, ISO),
            AcknowledgementPass::default()
        );
    }

    #[tokio::test]
    async fn author_greeted_rpc_validates_and_publishes() {
        let state = test_state();
        let mut events = state.events.subscribe();
        state
            .live_chat
            .lock()
            .await
            .start_session("session-1".to_string(), Vec::new());
        set_cohost_settings(
            &state,
            CohostSettingsPatch {
                enabled: Some(true),
                ..CohostSettingsPatch::default()
            },
        )
        .await
        .unwrap();
        start_cohost(
            &state,
            CohostStartParams {
                session_id: "session-1".to_string(),
                consent_to_process_chat: true,
                stream_title: None,
            },
        )
        .await
        .unwrap();
        note_messages(&state, &[first_timer(1, "Sam")]).await;
        let key = cohost_status(&state).await.say_hi[0].author_key.clone();
        assert_eq!(
            mark_author_greeted(
                &state,
                CohostAuthorParams {
                    session_id: "session-1".to_string(),
                    author_key: " ".to_string(),
                },
            )
            .await,
            Err(CohostError::InvalidParams)
        );
        assert_eq!(
            mark_author_greeted(
                &state,
                CohostAuthorParams {
                    session_id: "other".to_string(),
                    author_key: key.clone(),
                },
            )
            .await,
            Err(CohostError::SessionMismatch)
        );
        while events.try_recv().is_ok() {}
        let greeted = mark_author_greeted(
            &state,
            CohostAuthorParams {
                session_id: "session-1".to_string(),
                author_key: key.clone(),
            },
        )
        .await
        .unwrap();
        assert!(greeted.say_hi.is_empty());
        let mut saw_state = false;
        while let Ok(event) = events.try_recv() {
            if event.event == COHOST_STATE_EVENT {
                saw_state = true;
                assert!(event.payload.get("sayHi").is_none());
            }
        }
        assert!(saw_state, "a greeting publishes the state");
        // Again: a no-op, no emit.
        mark_author_greeted(
            &state,
            CohostAuthorParams {
                session_id: "session-1".to_string(),
                author_key: key,
            },
        )
        .await
        .unwrap();
        assert!(
            std::iter::from_fn(|| events.try_recv().ok())
                .all(|event| event.event != COHOST_STATE_EVENT)
        );
        stop_cohost(&state).await;
    }

    // --- Plan 068 review fixes ------------------------------------------------

    /// Finding 7 and 8: speech alone never ticks until a v3 tick succeeded
    /// this session (a rolled-back server answers a chat-less tick
    /// `invalid-request`); until then the transcript rides chat ticks. And a
    /// speech-only tick, which read no chat, keeps the chat mood.
    #[test]
    fn speech_alone_waits_for_a_v3_answer_and_keeps_the_chat_mood() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let long = "w".repeat(250);
        engine.note_speech(generation, &speech(&[(start + secs(1), &long)]));
        assert_eq!(
            engine.prepare_tick(generation, true, true, start + secs(30)),
            Err(TickGate::Idle),
            "no speech-only tick before a v3 answer"
        );
        engine.note_messages(&messages("session-1", 0..5));
        let chat = engine
            .prepare_tick(generation, true, true, start + secs(31))
            .unwrap();
        assert_eq!(chat.request.prompt_version, 3);
        assert_eq!(chat.request.transcript.as_deref(), Some(long.as_str()));
        let mut answer = response(Vec::new());
        answer.mood_scores = Some(crate::videorc_api::CohostTickMoodScores {
            hype: 0.9,
            tension: 0.1,
            confusion: 0.2,
        });
        assert!(engine.apply_tick_result(generation, 0, Ok(answer), start + secs(32), "t1"));
        let chat_mood = engine.snapshot();
        assert_eq!(chat_mood.mood, Some(CohostMood::Hype));
        assert!(chat_mood.mood_scores.is_some());

        // Confirmed: speech alone ticks now.
        engine.note_speech(
            generation,
            &speech(&[(start + secs(1), &long), (start + secs(40), &long)]),
        );
        let quiet = engine
            .prepare_tick(generation, true, true, start + secs(60))
            .unwrap();
        assert!(quiet.request.messages.is_empty());
        let mut calm = response(Vec::new());
        calm.mood = Some(CohostMood::Calm);
        calm.mood_scores = None;
        assert!(engine.apply_tick_result(generation, 0, Ok(calm), start + secs(61), "t2"));
        let after = engine.snapshot();
        assert_eq!(
            after.mood, chat_mood.mood,
            "a speech-only tick keeps the mood"
        );
        assert_eq!(after.mood_scores, chat_mood.mood_scores);

        // A chat tick replaces it as always.
        engine.note_messages(&messages("session-1", 5..10));
        engine
            .prepare_tick(generation, true, true, start + secs(80))
            .unwrap();
        let mut tense = response(Vec::new());
        tense.mood = Some(CohostMood::Tense);
        assert!(engine.apply_tick_result(generation, 0, Ok(tense), start + secs(81), "t3"));
        assert_eq!(engine.snapshot().mood, Some(CohostMood::Tense));
        assert_eq!(engine.snapshot().mood_scores, None);

        // A server without v3: the chat tick carrying speech falls back to
        // v2, and speech alone never ticks for the rest of the session.
        let (mut engine, generation) = running_engine(start);
        engine.note_speech(generation, &speech(&[(start + secs(1), &long)]));
        engine.note_messages(&messages("session-1", 0..5));
        engine
            .prepare_tick(generation, true, true, start + secs(20))
            .unwrap();
        assert!(engine.apply_tick_result(
            generation,
            0,
            Err(server_error(400, "prompt-version-unsupported", "no v3")),
            start + secs(21),
            "t"
        ));
        let retry = engine
            .prepare_tick(generation, true, true, start + secs(30))
            .unwrap();
        assert_eq!(retry.request.prompt_version, 2);
        assert!(retry.request.transcript.is_none());
        assert!(engine.apply_tick_result(
            generation,
            0,
            Ok(response(Vec::new())),
            start + secs(31),
            "t2"
        ));
        engine.note_speech(
            generation,
            &speech(&[(start + secs(1), &long), (start + secs(32), &long)]),
        );
        assert_eq!(
            engine.prepare_tick(generation, true, true, start + secs(90)),
            Err(TickGate::Idle)
        );
    }

    fn utf16(value: &str) -> usize {
        value.encode_utf16().count()
    }

    /// Finding 9: every text the engine emits and the renderer contract (or
    /// the web's zod) bounds is capped in UTF-16 units, cut on a char: an
    /// emoji at the boundary never overflows and never splits.
    #[test]
    fn every_bounded_text_counts_utf16_units_with_emoji_at_the_boundary() {
        assert_eq!(truncate_utf16("ab😀", 3), "ab");
        assert_eq!(truncate_utf16("ab😀", 4), "ab😀");
        assert_eq!(truncate_utf16("ab😀c", 5), "ab😀c");
        assert_eq!(keep_newest_utf16("😀ab", 3), "ab");
        assert_eq!(keep_newest_utf16("😀ab", 4), "😀ab");
        // A recap draft: 137 letters, a space, then an emoji word that would
        // end at 142 units. It is cut at the word, never mid-emoji.
        let summary = format!("{} 😀😀", "a".repeat(137));
        let draft = recap_draft(&summary, RECAP_MAX_CHARS);
        assert_eq!(draft, "a".repeat(137));
        let exact = format!("{} 😀", "a".repeat(137));
        assert_eq!(recap_draft(&exact, RECAP_MAX_CHARS), exact);
        assert_eq!(utf16(&recap_draft(&"😀".repeat(100), RECAP_MAX_CHARS)), 140);

        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let mut row = chat_message("session-1", 1, "2026-08-22T10:01:01Z");
        row.author_name = "😀".repeat(300);
        row.first_message = true;
        engine.note_messages(&[row.clone()]);
        engine
            .prepare_tick(generation, true, true, start + secs(20))
            .unwrap();
        let mut answer = response(vec![question("q_1", &[row.id.as_str()])]);
        answer.questions[0].text = "😀".repeat(1_500);
        answer.questions[0].suggested_reply = "😀".repeat(1_500);
        answer.questions[0].askers = vec!["😀".repeat(400)];
        answer.recap = Some(format!("{}😀", "r".repeat(139)));
        answer.topic = Some("😀".repeat(40));
        answer.summary = Some("😀".repeat(400));
        answer.promises = Some(vec![tick_promise(
            None,
            &"😀".repeat(100),
            CohostPromiseTriggerKind::Minutes,
            Some(1.0),
        )]);
        assert!(engine.apply_tick_result(generation, 0, Ok(answer), start + secs(21), "t1"));
        assert!(engine.check_promises(generation, None, start + secs(90), "t2"));
        let state = engine.snapshot();
        assert_eq!(
            state.recap.as_ref().map(|r| r.text.clone()),
            Some("r".repeat(139))
        );
        assert_eq!(state.topic.as_deref().map(utf16), Some(60));
        assert!(utf16(&state.promises[0].text) <= 160);
        assert!(utf16(&state.promise_reminder.as_ref().unwrap().text) <= 160);
        assert!(utf16(&state.questions[0].text) <= 2_000);
        assert!(utf16(&state.questions[0].suggested_reply) <= 2_000);
        assert!(utf16(&state.questions[0].askers[0]) <= 512);
        assert!(utf16(&state.say_hi[0].name) <= 512);
        assert!(!state.say_hi[0].name.is_empty());
        assert!(utf16(&engine.session.as_ref().unwrap().summary) <= TICK_SUMMARY_MAX_CHARS);
        // The echoes the web's zod bounds hard stay inside them too.
        engine.note_messages(&messages("session-1", 2..7));
        let next = engine
            .prepare_tick(generation, true, true, start + secs(40))
            .unwrap();
        assert!(utf16(&next.request.open_promises.as_ref().unwrap()[0].text) <= 160);
        assert!(utf16(next.request.summary.as_deref().unwrap()) <= TICK_SUMMARY_MAX_CHARS);

        // Listening carries the server's words, bounded, never an empty code.
        let blocked = CohostListening::blocked("", "😀".repeat(1_500));
        assert_eq!(blocked.reason_code.as_deref(), Some("unknown"));
        assert!(utf16(blocked.message.as_deref().unwrap()) <= 2_000);
    }

    /// Finding 4: sign-out purges everything Golem heard under the account,
    /// blocks listening, and drops the answer of a tick in flight.
    #[tokio::test]
    async fn sign_out_purges_what_orcle_heard_and_blocks_listening() {
        let state = test_state();
        let start = Instant::now();
        note_transcript_final(
            &state,
            &CaptionsUpdate {
                session_client_id: "captions-test".to_string(),
                seq: 1,
                kind: CaptionUpdateKind::Final,
                text: "okay clip".to_string(),
                chunk_seconds: 3,
                remaining_seconds: None,
            },
            RecentSpeechFinal {
                at: start,
                offset_seconds: 12.0,
                duration_seconds: 3.0,
                text: "okay clip".to_string(),
                segments: Vec::new(),
                presented: false,
            },
            true,
        );
        state.cohost_voice.lock().unwrap().last_voice_at = Some(start);
        {
            let mut engine = state.cohost.lock().await;
            engine.settings = enabled_settings();
            let generation = engine.start_session("session-1".to_string(), true, None, start);
            let mut row = chat_message("session-1", 1, "2026-08-22T10:01:01Z");
            row.author_name = "Jonathan".to_string();
            row.first_message = true;
            engine.note_messages(&[row]);
            engine.note_speech(
                generation,
                &speech(&[(
                    start + secs(1),
                    "welcome jonathan, the setup at ten viewers",
                )]),
            );
            // The tick in flight carries that transcript.
            engine.note_messages(&messages("session-1", 2..7));
            let in_flight = engine
                .prepare_tick(generation, true, true, start + secs(20))
                .unwrap();
            assert!(in_flight.request.transcript.is_some());
            engine.note_speech(
                generation,
                &speech(&[
                    (
                        start + secs(1),
                        "welcome jonathan, the setup at ten viewers",
                    ),
                    (start + secs(21), "and more words"),
                ]),
            );
            let session = engine.session.as_mut().unwrap();
            assert!(session.ledger.author_greeted_by_voice_for_test());
            session.summary = "We built a keyboard.".to_string();
            session.topic = Some("Keyboards".to_string());
            session.promises = vec![CohostPromise {
                id: "p_1".to_string(),
                text: "Show the setup".to_string(),
                trigger: CohostPromiseTrigger {
                    kind: CohostPromiseTriggerKind::Viewers,
                    value: Some(10),
                },
                first_seen_at: "t0".to_string(),
            }];
            session.set_recap("You missed the build.".to_string(), start, "t0");
            session.listening = Some(CohostListening::on(Some(600)));
        }
        let mut events = state.events.subscribe();

        purge_speech_for_sign_out(&state).await;

        assert_eq!(
            state
                .cohost_transcript
                .lock()
                .unwrap()
                .snapshot(Instant::now())
                .text,
            ""
        );
        assert!(recent_speech_since(&state, None).is_some_and(|speech| speech.finals.is_empty()));
        assert_eq!(voice_activity(&state), VoiceActivity::default());
        let emitted = events.try_recv().expect("the purge publishes the state");
        assert_eq!(emitted.event, COHOST_STATE_EVENT);
        assert_eq!(emitted.payload["listening"]["state"], "blocked");
        assert_eq!(emitted.payload["listening"]["reasonCode"], "signed-out");
        let mut engine = state.cohost.lock().await;
        let generation = {
            let session = engine.session.as_ref().unwrap();
            assert!(session.transcript_pending.is_empty());
            assert!(session.summary.is_empty());
            assert_eq!(session.topic, None);
            assert!(session.promises.is_empty());
            assert!(session.recap.is_none());
            assert!(!session.ledger.author_greeted_by_voice_for_test());
            session.generation
        };
        // The answer to the tick that carried the purged words never lands.
        let mut late = response(Vec::new());
        late.summary = Some("What they said before signing out.".to_string());
        late.topic = Some("Keyboards".to_string());
        assert!(engine.apply_tick_result(generation, 0, Ok(late), start + secs(30), "t9"));
        let session = engine.session.as_ref().unwrap();
        assert!(!session.in_flight);
        assert!(session.summary.is_empty());
        assert_eq!(session.topic, None);
        drop(engine);

        // Without a session the purge still clears the buffers, quietly.
        let quiet = test_state();
        let mut quiet_events = quiet.events.subscribe();
        purge_speech_for_sign_out(&quiet).await;
        assert!(quiet_events.try_recv().is_err());
    }

    /// Finding 4: sign-in resumes listening for a session still running with
    /// listening on (here it waits for a capture, as at any start).
    #[tokio::test]
    async fn sign_in_resumes_listening_for_a_running_session() {
        let _caption_test_guard = crate::captions::caption_lifecycle_test_lock().lock().await;
        let state = test_state();
        {
            let mut engine = state.cohost.lock().await;
            engine.settings = CohostSettings {
                listen: true,
                ..enabled_settings()
            };
            engine.start_session("session-1".to_string(), true, None, Instant::now());
            engine.session.as_mut().unwrap().listening = Some(CohostListening::blocked(
                "signed-out",
                "Sign in so Golem can hear you.",
            ));
        }
        let mut events = state.events.subscribe();
        resume_listen_after_sign_in(&state).await;
        let listening = state.cohost.lock().await.snapshot().listening.unwrap();
        assert_eq!(listening.state, CohostListeningState::Blocked);
        assert_eq!(listening.reason_code.as_deref(), Some("no-capture"));
        assert!(crate::captions::listen_wanted_for_test(&state).await);
        assert_eq!(events.try_recv().unwrap().event, COHOST_STATE_EVENT);
        crate::captions::stop_listen(&state).await;

        // Listening off in settings: sign-in leaves it alone.
        state.cohost.lock().await.settings.listen = false;
        resume_listen_after_sign_in(&state).await;
        assert!(!crate::captions::listen_wanted_for_test(&state).await);
    }

    /// Finding 2: the recording monitor's Golem stop (a capture end) leaves
    /// the listen-only task to drain in `finish_captions_for_capture`; an
    /// explicit `cohost.stop` still ends it at once.
    #[tokio::test]
    async fn a_capture_end_stop_lets_the_listen_task_drain_and_an_explicit_stop_aborts() {
        let _caption_test_guard = crate::captions::caption_lifecycle_test_lock().lock().await;
        let state = test_state();
        {
            let mut engine = state.cohost.lock().await;
            engine.settings = enabled_settings();
            engine.start_session("rec-1".to_string(), true, None, Instant::now());
        }
        crate::captions::install_listen_only_test_task(&state).await;
        let fence = state.live_chat_persistence.begin_delivery().await;
        stop_cohost_for_session_end_if_matching_before_emit(
            &state,
            "rec-1",
            &fence,
            std::future::ready(()),
        )
        .await;
        drop(fence);
        assert!(state.cohost.lock().await.session.is_none());
        assert!(!crate::captions::listen_wanted_for_test(&state).await);
        assert!(
            crate::captions::caption_task_alive_for_test(&state).await,
            "the stream's last chunks still drain"
        );
        crate::captions::finish_captions_for_capture(&state, "rec-1").await;
        assert!(!crate::captions::caption_task_alive_for_test(&state).await);

        state
            .cohost
            .lock()
            .await
            .start_session("rec-2".to_string(), true, None, Instant::now());
        crate::captions::install_listen_only_test_task(&state).await;
        stop_cohost(&state).await;
        assert!(!crate::captions::caption_task_alive_for_test(&state).await);
    }

    // --- Plan 119 S1: the Golem report -------------------------------------------

    fn overlay(message_id: &str, remaining: Duration) -> OverlayObservation {
        OverlayObservation {
            live_message_id: Some(message_id.to_string()),
            remaining,
        }
    }

    #[test]
    fn report_counts_an_engine_set_card_once_it_reaches_the_stream() {
        // Plan 140 S9: issuing a card (command, voice or pick) marks it
        // `shown` for the pick rules at once, which used to stop the report
        // from ever counting it when it went live.
        let start = Instant::now();
        let (mut engine, _generation) = running_engine(start);
        let rows = messages("session-1", 0..2);
        engine.note_messages(&rows);
        {
            let session = engine.session.as_mut().unwrap();
            let mut generation = 0;
            session.apply_command_highlight(&rows[1].id, None, &mut generation, start + secs(1));
            // Issued, not on stream yet: nothing to count.
            session.observe_overlay(&OverlayObservation::default(), start + secs(2));
            session.observe_overlay(&overlay(&rows[1].id, secs(10)), start + secs(3));
            // The same card observed again is not a second showing.
            session.observe_overlay(&overlay(&rows[1].id, secs(9)), start + secs(4));
        }
        let report = engine
            .stop_session()
            .expect("a running session leaves a report");
        assert_eq!(report.shown_on_stream, 1);
    }

    #[test]
    fn report_counts_each_question_outcome_exactly_once() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..6);
        engine.note_messages(&rows);
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        assert!(
            engine.apply_tick_result(
                generation,
                0,
                Ok(response(
                    (1..=6)
                        .map(|index| question(
                            &format!("q_{index}"),
                            &[rows[index - 1].id.as_str()]
                        ))
                        .collect()
                )),
                start + secs(2),
                "t1"
            )
        );

        assert!(engine.mark_answered("session-1", "q_1").unwrap());
        assert!(engine.dismiss_question("session-1", "q_2").unwrap());
        assert!(engine.own_send_delivered(
            "session-1",
            "Keychron Q1!",
            Some("q_3"),
            start + secs(3)
        ));
        {
            let session = engine.session.as_mut().unwrap();
            assert!(session.resolve_by_voice("q_4", start + secs(4), "t4"));
            assert!(session.restore_question("q_4", start + secs(5)));
            session.observe_overlay(&overlay(&rows[4].id, secs(10)), start + secs(6));
            // The same card observed again is not a second showing.
            session.observe_overlay(&overlay(&rows[4].id, secs(9)), start + secs(7));
        }
        // Closing a question that already left changes nothing.
        assert!(!engine.mark_answered("session-1", "q_1").unwrap());
        assert!(!engine.dismiss_question("session-1", "q_3").unwrap());

        let report = engine
            .stop_session()
            .expect("a running session leaves a report");
        assert_eq!(engine.snapshot(), CohostState::off());
        assert_eq!(report.version, 1);
        assert_eq!(report.session_id, "session-1");
        assert_eq!(report.segments, 1);
        assert_eq!(report.stream_title.as_deref(), Some("Rust night"));
        assert_eq!(report.messages_seen, 6);
        assert_eq!(report.shown_on_stream, 1);
        let questions = &report.questions;
        assert_eq!(questions.total, 6);
        assert_eq!(
            (
                questions.marked_answered,
                questions.dismissed,
                questions.replied,
                questions.answered_on_air,
                questions.restored,
                questions.shown_on_stream,
            ),
            (1, 1, 1, 1, 1, 1)
        );
        let outcome = |id: &str| {
            questions
                .items
                .iter()
                .find(|item| item.id == id)
                .unwrap_or_else(|| panic!("{id} is logged"))
                .outcome
        };
        assert_eq!(outcome("q_1"), CohostReportQuestionOutcome::MarkedAnswered);
        assert_eq!(outcome("q_2"), CohostReportQuestionOutcome::Dismissed);
        assert_eq!(outcome("q_3"), CohostReportQuestionOutcome::Replied);
        assert_eq!(
            outcome("q_4"),
            CohostReportQuestionOutcome::Open,
            "a restore reopens"
        );
        assert_eq!(outcome("q_5"), CohostReportQuestionOutcome::Shown);
        assert_eq!(outcome("q_6"), CohostReportQuestionOutcome::Open);
        assert_eq!(questions.items[0].askers, vec!["Viewer 0", "Viewer 1"]);
        assert_eq!(questions.items[0].platforms, vec![StreamPlatform::Twitch]);
        assert_eq!(questions.items[0].priority, CohostPriority::High);
        assert_eq!(questions.items[0].first_seen_at, "t1");
        assert!(report.flags.by_kind.is_empty() && report.alerts.is_empty());
    }

    #[test]
    fn report_counts_flags_promises_recap_and_alerts_once_each() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..6);
        engine.note_messages(&rows);
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        let mut answer = response(Vec::new());
        answer.flags = vec![
            flag(
                rows[0].id.as_str(),
                CohostFlagKind::Spam,
                CohostFlagSeverity::Low,
            ),
            flag(
                rows[1].id.as_str(),
                CohostFlagKind::Spam,
                CohostFlagSeverity::High,
            ),
            flag(
                rows[2].id.as_str(),
                CohostFlagKind::Toxicity,
                CohostFlagSeverity::Unknown,
            ),
            // The same message flagged again is the same flag.
            flag(
                rows[0].id.as_str(),
                CohostFlagKind::Scam,
                CohostFlagSeverity::High,
            ),
        ];
        answer.promises = Some(vec![
            tick_promise(
                None,
                "Giveaway at 100 viewers",
                CohostPromiseTriggerKind::Viewers,
                Some(100.0),
            ),
            tick_promise(
                None,
                "Raid someone after",
                CohostPromiseTriggerKind::None,
                None,
            ),
            tick_promise(None, "Show the repo", CohostPromiseTriggerKind::None, None),
        ]);
        answer.summary = Some("We built the thing and it works.".to_string());
        answer.recap = Some("Recap: we built the thing.".to_string());
        // Two different viewers say the audio broke: an active alert.
        answer.alerts = vec![
            CohostTickAlert {
                message_id: rows[3].id.clone(),
                kind: CohostAlertKind::Audio,
                confidence: None,
            },
            CohostTickAlert {
                message_id: rows[4].id.clone(),
                kind: CohostAlertKind::Audio,
                confidence: None,
            },
        ];
        assert!(engine.apply_tick_result(generation, 0, Ok(answer), start + secs(2), "t1"));

        // Flags: dismissing one counts once.
        assert!(
            engine
                .dismiss_flag("session-1", rows[0].id.as_str())
                .unwrap()
        );
        assert!(
            !engine
                .dismiss_flag("session-1", rows[0].id.as_str())
                .unwrap()
        );

        // Promises: a met trigger reminds once; done and dismiss count apart.
        let promise_ids: Vec<String> = engine
            .snapshot()
            .promises
            .iter()
            .map(|promise| promise.id.clone())
            .collect();
        assert_eq!(promise_ids.len(), 3);
        assert!(engine.check_promises(generation, Some(150), start + secs(3), "t2"));
        assert!(
            engine
                .close_promise("session-1", &promise_ids[0], true)
                .unwrap()
        );
        assert!(
            engine
                .close_promise("session-1", &promise_ids[1], false)
                .unwrap()
        );
        assert!(
            !engine
                .close_promise("session-1", &promise_ids[1], false)
                .unwrap()
        );

        // Recap: offered by the server, dismissed, then drafted by hand.
        assert!(engine.dismiss_recap("session-1", start + secs(3)).unwrap());
        assert!(!engine.dismiss_recap("session-1", start + secs(3)).unwrap());
        engine
            .draft_recap("session-1", start + secs(4), "t3")
            .unwrap();

        // The transcript shows the last promise was kept.
        engine.note_messages(&messages("session-1", 6..12));
        engine
            .prepare_tick(generation, true, true, start + secs(30))
            .unwrap();
        let mut second = response(Vec::new());
        second.fulfilled_promise_ids = vec![promise_ids[2].clone()];
        second.promises = Some(Vec::new());
        assert!(engine.apply_tick_result(generation, 0, Ok(second), start + secs(31), "t4"));
        assert!(engine.snapshot().promises.is_empty());

        let report = engine.stop_session().unwrap();
        assert_eq!(report.flags.raised, 3);
        assert_eq!(report.flags.dismissed, 1);
        assert_eq!(
            report.flags.by_kind,
            vec![
                CohostReportFlagKindCount {
                    kind: CohostFlagKind::Spam,
                    count: 2,
                },
                CohostReportFlagKindCount {
                    kind: CohostFlagKind::Toxicity,
                    count: 1,
                },
            ]
        );
        assert_eq!(
            report.flags.by_severity,
            vec![
                CohostReportFlagSeverityCount {
                    severity: CohostFlagSeverity::Low,
                    count: 1,
                },
                CohostReportFlagSeverityCount {
                    severity: CohostFlagSeverity::High,
                    count: 1,
                },
                CohostReportFlagSeverityCount {
                    severity: CohostFlagSeverity::Medium,
                    count: 1,
                },
            ],
            "an unknown severity reads medium"
        );
        assert_eq!(
            (
                report.promises.heard,
                report.promises.kept,
                report.promises.dismissed,
                report.promises.reminded,
            ),
            (3, 2, 1, 1)
        );
        assert!(report.promises.open.is_empty());
        assert_eq!(
            (
                report.recap.offered,
                report.recap.drafted,
                report.recap.dismissed
            ),
            (1, 1, 1)
        );
        assert_eq!(
            report.alerts,
            vec![CohostReportAlert {
                kind: CohostAlertKind::Audio,
                peak_viewers: 2,
                active: true,
                first_seen_at: "t1".to_string(),
            }]
        );
        assert_eq!(report.messages_seen, 12);
    }

    #[test]
    fn open_promises_ride_the_report_and_the_question_log_is_capped() {
        let start = Instant::now();
        let (mut engine, generation) = running_engine(start);
        let rows = messages("session-1", 0..5);
        engine.note_messages(&rows);
        engine
            .prepare_tick(generation, true, true, start + secs(1))
            .unwrap();
        let mut answer = response(Vec::new());
        answer.promises = Some(vec![tick_promise(
            None,
            "Giveaway at 100 viewers",
            CohostPromiseTriggerKind::Viewers,
            Some(100.0),
        )]);
        assert!(engine.apply_tick_result(generation, 0, Ok(answer), start + secs(2), "t1"));
        // The log caps at 200 questions; the lifetime count keeps growing.
        {
            let session = engine.session.as_mut().unwrap();
            for index in 0..(COHOST_REPORT_QUESTIONS_CAP + 25) {
                session.counted_question_ids.insert(format!("q_{index}"));
                session.questions_total += 1;
                session.report.note_question(&CohostQuestion {
                    id: format!("q_{index}"),
                    text: "?".to_string(),
                    message_ids: Vec::new(),
                    askers: (0..8).map(|asker| format!("Viewer {asker}")).collect(),
                    platforms: Vec::new(),
                    priority: CohostPriority::Normal,
                    suggested_reply: String::new(),
                    from_notes: false,
                    first_seen_at: "t".to_string(),
                    updated_at: "t".to_string(),
                    on_topic: false,
                });
            }
        }
        let report = engine.stop_session().unwrap();
        assert_eq!(report.promises.heard, 1);
        assert_eq!(
            report.promises.open,
            vec![CohostReportOpenPromise {
                text: "Giveaway at 100 viewers".to_string(),
                first_seen_at: "t1".to_string(),
            }]
        );
        assert_eq!(
            report.questions.total,
            COHOST_REPORT_QUESTIONS_CAP as u64 + 25
        );
        assert_eq!(report.questions.items.len(), COHOST_REPORT_QUESTIONS_CAP);
        assert_eq!(
            report.questions.items[0].askers.len(),
            COHOST_REPORT_ASKERS_CAP,
            "at most five asker names per logged question"
        );
    }

    fn saved_report_ids(
        events: &mut broadcast::Receiver<crate::protocol::ServerEvent>,
    ) -> Vec<String> {
        let mut ids = Vec::new();
        loop {
            match events.try_recv() {
                Ok(event) if event.event == COHOST_REPORT_SAVED_EVENT => ids.push(
                    event.payload["sessionId"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                ),
                Ok(_) => {}
                Err(broadcast::error::TryRecvError::Lagged(_)) => {}
                Err(_) => break,
            }
        }
        ids
    }

    fn start_params(session_id: &str) -> CohostStartParams {
        CohostStartParams {
            session_id: session_id.to_string(),
            consent_to_process_chat: true,
            stream_title: Some("Night one".to_string()),
        }
    }

    async fn enable_orcle(state: &AppState, enabled: bool) {
        set_cohost_settings(
            state,
            CohostSettingsPatch {
                enabled: Some(enabled),
                ..CohostSettingsPatch::default()
            },
        )
        .await
        .unwrap();
    }

    /// Every stop path leaves a report once the engine lock is released, and
    /// announces it. A missing session row skips the save instead of failing.
    #[tokio::test]
    async fn every_stop_path_saves_a_report_and_announces_it() {
        let state = test_state();
        let mut events = state.events.subscribe();

        // Settings off.
        state
            .database
            .ensure_fake_live_chat_session("s-settings")
            .unwrap();
        state
            .live_chat
            .lock()
            .await
            .start_session("s-settings".to_string(), Vec::new());
        enable_orcle(&state, true).await;
        start_cohost(&state, start_params("s-settings"))
            .await
            .unwrap();
        note_messages(&state, &messages("s-settings", 0..3)).await;
        enable_orcle(&state, false).await;
        let report = state
            .database
            .get_cohost_report("s-settings")
            .unwrap()
            .expect("turning Golem off saves the report");
        assert_eq!(report.messages_seen, 3);
        assert_eq!(report.stream_title.as_deref(), Some("Night one"));
        assert_eq!(report.segments, 1);
        assert_eq!(saved_report_ids(&mut events), vec!["s-settings"]);

        // Explicit stop.
        enable_orcle(&state, true).await;
        state
            .database
            .ensure_fake_live_chat_session("s-stop")
            .unwrap();
        state
            .live_chat
            .lock()
            .await
            .start_session("s-stop".to_string(), Vec::new());
        start_cohost(&state, start_params("s-stop")).await.unwrap();
        stop_cohost(&state).await;
        assert!(
            state
                .database
                .get_cohost_report("s-stop")
                .unwrap()
                .is_some()
        );
        assert_eq!(saved_report_ids(&mut events), vec!["s-stop"]);

        // A replacing start saves the session it replaces.
        state.database.ensure_fake_live_chat_session("s-a").unwrap();
        state.database.ensure_fake_live_chat_session("s-b").unwrap();
        state
            .live_chat
            .lock()
            .await
            .start_session("s-a".to_string(), Vec::new());
        start_cohost(&state, start_params("s-a")).await.unwrap();
        state
            .live_chat
            .lock()
            .await
            .start_session("s-b".to_string(), Vec::new());
        start_cohost(&state, start_params("s-b")).await.unwrap();
        assert!(state.database.get_cohost_report("s-a").unwrap().is_some());
        assert_eq!(state.database.get_cohost_report("s-b").unwrap(), None);
        assert_eq!(saved_report_ids(&mut events), vec!["s-a"]);

        // The recording monitor's session-end stop.
        let fence = state.live_chat_persistence.begin_delivery().await;
        stop_cohost_for_session_end_if_matching_before_emit(
            &state,
            "s-b",
            &fence,
            std::future::ready(()),
        )
        .await;
        drop(fence);
        assert!(state.database.get_cohost_report("s-b").unwrap().is_some());
        assert_eq!(saved_report_ids(&mut events), vec!["s-b"]);

        // Nothing running: nothing saved, nothing announced.
        stop_cohost(&state).await;
        assert!(saved_report_ids(&mut events).is_empty());

        // No session row (a chat session nothing persisted): skipped.
        state
            .live_chat
            .lock()
            .await
            .start_session("s-ghost".to_string(), Vec::new());
        start_cohost(&state, start_params("s-ghost")).await.unwrap();
        stop_cohost(&state).await;
        assert_eq!(state.database.get_cohost_report("s-ghost").unwrap(), None);
        assert!(saved_report_ids(&mut events).is_empty());
        assert_eq!(
            state.database.latest_cohost_report_session_id().unwrap(),
            Some("s-b".to_string()),
            "the newest session with a report"
        );
    }

    /// Plan 140 S1: Golem is Premium only in the backend too. A Basic account's
    /// start is refused before any chat validation or state publication, with
    /// the plan's code and copy; the same start with Premium runs.
    #[tokio::test]
    async fn start_is_refused_without_premium() {
        let state = test_state();
        state
            .database
            .ensure_fake_live_chat_session("s-basic")
            .unwrap();
        state
            .live_chat
            .lock()
            .await
            .start_session("s-basic".to_string(), Vec::new());
        enable_orcle(&state, true).await;
        let mut events = state.events.subscribe();

        let refused = start_cohost_if_entitled(&state, start_params("s-basic"), false)
            .await
            .expect_err("a Basic account cannot start Golem");
        assert_eq!(refused, CohostError::PremiumRequired);
        assert_eq!(refused.code(), "premium-required");
        assert_eq!(refused.to_string(), "Golem requires Videorc Premium.");
        assert_eq!(cohost_status(&state).await, CohostState::off());
        // Nothing was published: the renderer keeps its locked Golem card.
        assert!(events.try_recv().is_err());

        let started = start_cohost_if_entitled(&state, start_params("s-basic"), true)
            .await
            .expect("Premium starts Golem");
        assert_eq!(started.session_id.as_deref(), Some("s-basic"));
        stop_cohost(&state).await;
    }

    /// Plan 140 S1: a mid-session Premium lapse ends Golem through the normal
    /// stop path. The report is saved and announced, the published off state
    /// names the reason, and nothing happens while Premium holds or when
    /// nothing is running.
    #[tokio::test]
    async fn a_premium_lapse_stops_orcle_and_saves_its_report() {
        let state = test_state();
        state
            .database
            .ensure_fake_live_chat_session("s-lapse")
            .unwrap();
        state
            .live_chat
            .lock()
            .await
            .start_session("s-lapse".to_string(), Vec::new());
        enable_orcle(&state, true).await;
        start_cohost(&state, start_params("s-lapse")).await.unwrap();
        note_messages(&state, &messages("s-lapse", 0..4)).await;
        // A debug build without the Basic override resolves to the Developer
        // tier, so the live check keeps the session.
        assert!(!stop_cohost_if_premium_lapsed(&state).await);
        assert_eq!(
            cohost_status(&state).await.session_id.as_deref(),
            Some("s-lapse")
        );
        let mut events = state.events.subscribe();

        assert!(stop_cohost_for_premium_lapse(&state, CohostReason::PremiumRequired).await);
        assert_eq!(cohost_status(&state).await, CohostState::off());
        let report = state
            .database
            .get_cohost_report("s-lapse")
            .unwrap()
            .expect("the lapse saves the report");
        assert_eq!(report.messages_seen, 4);
        let mut seen = Vec::new();
        while let Ok(event) = events.try_recv() {
            seen.push(event);
        }
        assert!(
            seen.iter().any(|event| {
                event.event == COHOST_REPORT_SAVED_EVENT && event.payload["sessionId"] == "s-lapse"
            }),
            "the saved report is announced"
        );
        let published = seen
            .iter()
            .filter(|event| event.event == COHOST_STATE_EVENT)
            .last()
            .expect("the stopped state is published");
        assert_eq!(published.payload["status"], "off");
        assert_eq!(published.payload["sessionId"], serde_json::Value::Null);
        assert_eq!(published.payload["reason"], "premium-required");

        // Nothing running: nothing to stop, nothing published.
        assert!(!stop_cohost_for_premium_lapse(&state, CohostReason::PremiumRequired).await);
        assert!(events.try_recv().is_err());
    }

    /// Golem turned off and back on mid-stream: one report, merged.
    #[tokio::test]
    async fn orcle_off_and_on_mid_stream_folds_into_one_report() {
        let state = test_state();
        state.database.ensure_fake_live_chat_session("s-1").unwrap();
        state
            .live_chat
            .lock()
            .await
            .start_session("s-1".to_string(), Vec::new());
        enable_orcle(&state, true).await;
        start_cohost(&state, start_params("s-1")).await.unwrap();
        note_messages(&state, &messages("s-1", 0..3)).await;
        enable_orcle(&state, false).await;
        assert_eq!(
            state
                .database
                .get_cohost_report("s-1")
                .unwrap()
                .unwrap()
                .messages_seen,
            3
        );

        enable_orcle(&state, true).await;
        start_cohost(&state, start_params("s-1")).await.unwrap();
        note_messages(&state, &messages("s-1", 3..8)).await;
        stop_cohost(&state).await;

        let merged = state.database.get_cohost_report("s-1").unwrap().unwrap();
        assert_eq!(merged.segments, 2);
        assert_eq!(merged.messages_seen, 8);
        assert_eq!(merged.version, 1);

        let payload = get_session_report(&state, "s-1").await.unwrap();
        assert_eq!(payload.session_id, "s-1");
        assert_eq!(payload.report, Some(merged));
        assert!(payload.moments.is_empty());
        assert_eq!(
            payload.chat.messages, 0,
            "noted rows were never persisted here"
        );
        let latest = latest_session_report(&state).await.unwrap().unwrap();
        assert_eq!(latest.session_id, "s-1");
        assert_eq!(
            get_session_report(&state, "missing").await.unwrap().report,
            None
        );
    }

    // --- Voice commands (plan 140 S3) -------------------------------------------

    const COMMAND_SESSION: &str = "command-session";

    fn command_row(
        seq: u32,
        author: &str,
        platform: StreamPlatform,
        text: &str,
    ) -> LiveChatMessage {
        let provider_message_id = format!("command-{seq}");
        LiveChatMessage {
            id: live_chat_message_id(COMMAND_SESSION, platform, None, &provider_message_id),
            provider_message_id,
            platform,
            target_id: None,
            session_id: COMMAND_SESSION.to_string(),
            author_id: Some(format!("{author}-id")),
            author_name: author.to_string(),
            author_avatar_url: None,
            author_badges: Vec::new(),
            author_roles: Vec::new(),
            published_at: chrono::Utc::now().to_rfc3339(),
            received_at: format!("2026-10-04T12:{:02}:{:02}Z", seq / 60, seq % 60),
            message_text: text.to_string(),
            fragments: Vec::new(),
            event_type: LiveChatEventType::Message,
            amount_text: None,
            is_deleted: false,
            raw_provider_type: Some("fake".to_string()),
            details: None,
            reply: None,
            first_message: false,
            author_affiliation: None,
        }
    }

    fn command_ctx(now: Instant) -> CommandContext {
        CommandContext {
            premium: true,
            voice_enabled: true,
            remove_enabled: true,
            on_stream: None,
            now,
            now_utc: chrono::Utc::now(),
        }
    }

    fn command_engine(now: Instant, rows: &[LiveChatMessage]) -> (CohostEngine, CommandSession) {
        let mut engine = CohostEngine::new(enabled_settings());
        let generation = engine.start_session(COMMAND_SESSION.to_string(), true, None, now);
        engine.note_messages_at(rows, now);
        (
            engine,
            CommandSession {
                session_id: COMMAND_SESSION.to_string(),
                generation,
            },
        )
    }

    fn spoken(intent: CommandIntent, target: CommandTarget) -> NewCommand {
        NewCommand {
            intent,
            spec: CommandTargetSpec::Spoken {
                target,
                question: false,
            },
            heard: "orcle test".to_string(),
            reason: None,
            wake_word: true,
        }
    }

    fn resolved_removal(message_id: &str) -> NewCommand {
        NewCommand {
            intent: CommandIntent::Remove,
            spec: CommandTargetSpec::Resolved(vec![message_id.to_string()]),
            heard: "orcle remove that one".to_string(),
            reason: Some("toxic".to_string()),
            wake_word: true,
        }
    }

    fn named(name: &str) -> CommandTarget {
        CommandTarget::Name(name.to_string())
    }

    fn current_command(engine: &CohostEngine) -> CohostCommand {
        engine.snapshot().command.expect("a command")
    }

    fn command_counts(engine: &CohostEngine) -> CohostReportCommands {
        engine.session.as_ref().unwrap().report.commands.clone()
    }

    fn open_question(id: &str, message_ids: &[&str]) -> CohostQuestion {
        CohostQuestion {
            id: id.to_string(),
            text: "Is Rust hard?".to_string(),
            message_ids: message_ids.iter().map(|id| id.to_string()).collect(),
            askers: Vec::new(),
            platforms: vec![StreamPlatform::Twitch],
            priority: CohostPriority::Normal,
            suggested_reply: String::new(),
            from_notes: false,
            first_seen_at: "2026-10-04T12:00:00Z".to_string(),
            updated_at: "2026-10-04T12:00:00Z".to_string(),
            on_topic: false,
        }
    }

    fn command_flag(message_id: &str, severity: CohostFlagSeverity, at: String) -> CohostFlag {
        CohostFlag {
            message_id: message_id.to_string(),
            kind: CohostFlagKind::Harassment,
            severity,
            reason: "Insults a viewer.".to_string(),
            at,
            confidence: None,
            target: None,
            action: None,
            also_kinds: Vec::new(),
            rule: None,
        }
    }

    fn spotlight_on(message_id: &str, now: Instant) -> SpotlightRecord {
        SpotlightRecord {
            message_id: message_id.to_string(),
            question_id: None,
            score: 0.9,
            at_iso: chrono::Utc::now().to_rfc3339(),
            expires_at: now + secs(10),
            expires_at_iso: chrono::Utc::now().to_rfc3339(),
        }
    }

    fn voice_operation(message: &LiveChatMessage, phase: ModerationPhase) -> ModerationOperation {
        let now = chrono::Utc::now();
        ModerationOperation {
            operation_id: uuid::Uuid::new_v4().to_string(),
            session_id: COMMAND_SESSION.to_string(),
            message_id: message.id.clone(),
            platform: message.platform,
            target_id: None,
            provider_message_id: message.provider_message_id.clone(),
            author_name: message.author_name.clone(),
            excerpt: message.message_text.clone(),
            source: ModerationSource::OrcleVoice,
            reason: Some("toxic".to_string()),
            phase,
            confirm_mode: RemoveConfirmMode::Confirm,
            requires_explicit_confirm: true,
            confirm_by: Some((now + chrono::Duration::seconds(20)).to_rfc3339()),
            execute_at: None,
            outcome: None,
            outcome_code: None,
            attempts: 0,
            created_at: now.to_rfc3339(),
            updated_at: now.to_rfc3339(),
        }
    }

    /// The command resolves to `message`, and chat moderation opens its card.
    fn open_removal_card(
        engine: &mut CohostEngine,
        scope: &CommandSession,
        command: NewCommand,
        ctx: &CommandContext,
        message: &LiveChatMessage,
    ) -> ModerationOperation {
        let effects = engine.begin_command(scope, command, ctx).unwrap();
        let request = effects.request_removal.expect("a removal request");
        assert_eq!(request.message_id, message.id);
        assert!(
            !engine.command_slot_mirror().0.awaiting_answer,
            "nothing to answer before chat moderation opened the card"
        );
        let operation = voice_operation(message, ModerationPhase::PendingConfirm);
        let session = engine.session.as_mut().unwrap();
        let (changed, orphan) = session.settle_command_removal(
            &request.command_id,
            Ok(operation.clone()),
            &chrono::Utc::now().to_rfc3339(),
        );
        assert!(changed && orphan.is_none());
        operation
    }

    fn detected(
        kind: CommandKind,
        target: CommandTarget,
        heard: &str,
        reason: Option<&str>,
    ) -> DetectedCommand {
        DetectedCommand {
            kind,
            target,
            question: false,
            reason: reason.map(str::to_string),
            heard: heard.to_string(),
            wake_word: true,
        }
    }

    fn command_provider_row() -> crate::live_chat::LiveChatProviderState {
        crate::live_chat::LiveChatProviderState {
            id: crate::streaming::stream_platform_id(StreamPlatform::Twitch).to_string(),
            platform: StreamPlatform::Twitch,
            target_id: None,
            account_id: None,
            account_label: None,
            read: crate::live_chat::CommentsReadState::Ready,
            write: crate::live_chat::CommentsWriteState::Ready,
            moderate: None,
            state: crate::live_chat::LiveChatProviderConnectionState::Connected,
            message: "ready".to_string(),
            last_connected_at: None,
            last_message_at: None,
            last_error: None,
            retry_at: None,
        }
    }

    /// A Twitch chat session holding `rows` (with `sender` as its delete
    /// credentials) and a Golem session on it that noted them.
    async fn command_state(
        rows: &[LiveChatMessage],
        sender: Option<crate::live_chat::ChatSenderConfig>,
    ) -> (AppState, CommandSession) {
        let state = test_state();
        state
            .database
            .ensure_fake_live_chat_session(COMMAND_SESSION)
            .unwrap();
        crate::live_chat_moderation::set_premium_check_for_tests(&state, Arc::new(|| true)).await;
        {
            let mut coordinator = state.live_chat.lock().await;
            coordinator.start_session(COMMAND_SESSION.to_string(), vec![command_provider_row()]);
            if let Some(sender) = sender {
                coordinator.register_sender(
                    crate::streaming::stream_platform_id(StreamPlatform::Twitch).to_string(),
                    sender,
                );
            }
            for row in rows {
                coordinator.ingest(row.clone());
                state.database.save_live_chat_message(row).unwrap();
            }
        }
        let generation = {
            let mut engine = state.cohost.lock().await;
            engine.settings = enabled_settings();
            let generation =
                engine.start_session(COMMAND_SESSION.to_string(), true, None, Instant::now());
            engine.note_messages(rows);
            generation
        };
        arm_command_detector(&state, COMMAND_SESSION, generation, false);
        (
            state,
            CommandSession {
                session_id: COMMAND_SESSION.to_string(),
                generation,
            },
        )
    }

    fn fake_deletes() -> Option<crate::live_chat::ChatSenderConfig> {
        Some(crate::live_chat::ChatSenderConfig::Fake(
            crate::live_chat::FakeChatSendBehavior::Sent,
        ))
    }

    async fn state_command(state: &AppState) -> CohostCommand {
        state
            .cohost
            .lock()
            .await
            .snapshot()
            .command
            .expect("a command")
    }

    async fn state_counts(state: &AppState) -> CohostReportCommands {
        state
            .cohost
            .lock()
            .await
            .session
            .as_ref()
            .unwrap()
            .report
            .commands
            .clone()
    }

    async fn wait_for_command(
        state: &AppState,
        what: &str,
        done: impl Fn(&CohostCommand) -> bool,
    ) -> CohostCommand {
        let deadline = Instant::now() + secs(3);
        loop {
            let command = state.cohost.lock().await.snapshot().command;
            if let Some(command) = command.filter(|command| done(command)) {
                return command;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn wait_for_operation_phase(
        state: &AppState,
        operation_id: &str,
        phase: ModerationPhase,
    ) {
        let deadline = Instant::now() + secs(3);
        loop {
            let stored = state
                .database
                .get_chat_moderation_operation(operation_id)
                .unwrap()
                .unwrap();
            if stored.phase == phase {
                return;
            }
            assert!(Instant::now() < deadline, "{stored:?}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn show_on_stream(state: &AppState, message_id: &str) {
        let mut highlight = state.comment_highlight.lock().await;
        highlight.session_id = Some(COMMAND_SESSION.to_string());
        highlight.message_id = Some(message_id.to_string());
        highlight.phase = CommentHighlightPhase::Live;
        highlight.generation = highlight.generation.wrapping_add(1).max(1);
    }

    fn caption_final(seq: u64) -> CaptionsUpdate {
        CaptionsUpdate {
            session_client_id: "command-captions".to_string(),
            seq,
            kind: CaptionUpdateKind::Final,
            text: String::new(),
            chunk_seconds: 3,
            remaining_seconds: None,
        }
    }

    fn spoken_final(text: &str) -> RecentSpeechFinal {
        RecentSpeechFinal {
            at: Instant::now(),
            offset_seconds: 0.0,
            duration_seconds: 3.0,
            text: text.to_string(),
            segments: Vec::new(),
            presented: false,
        }
    }

    fn set_orcle_flags(state: &AppState, orcle: &str) {
        let flags = crate::service_flags::parse_service_flags(
            &format!(r#"{{"version":1,"orcle":{orcle}}}"#),
            chrono::Utc::now(),
        )
        .unwrap();
        crate::youtube_quota::apply_service_flags(state, flags);
    }

    #[test]
    fn command_wire_shapes_are_additive_and_old_settings_load_with_the_defaults() {
        // No command and both switches on: the state serializes as before.
        let off = serde_json::to_value(CohostState::off()).unwrap();
        assert!(off.get("command").is_none());
        assert!(off.get("commandAvailability").is_none());
        let (engine, _) = command_engine(Instant::now(), &[]);
        let running = serde_json::to_value(engine.snapshot()).unwrap();
        assert!(running.get("command").is_none());
        assert!(running.get("commandAvailability").is_none());

        // Settings from before plan 140 load with the defaults, and the
        // patch carries both new fields (kebab-case confirm mode).
        let legacy: CohostSettings = serde_json::from_value(serde_json::json!({
            "enabled": true, "tone": "short", "notes": "", "autoHighlight": false
        }))
        .unwrap();
        assert!(!legacy.wake_word_required);
        assert_eq!(legacy.remove_confirm, RemoveConfirmMode::Confirm);
        let wire = serde_json::to_value(&legacy).unwrap();
        assert_eq!(wire["wakeWordRequired"], serde_json::json!(false));
        assert_eq!(wire["removeConfirm"], "confirm");
        let patch: CohostSettingsPatch = serde_json::from_value(serde_json::json!({
            "wakeWordRequired": true, "removeConfirm": "countdown"
        }))
        .unwrap();
        let mut settings = CohostSettings::default();
        settings.apply(patch);
        assert!(settings.wake_word_required);
        assert_eq!(settings.remove_confirm, RemoveConfirmMode::Countdown);
        assert!(
            serde_json::from_value::<CohostSettingsPatch>(serde_json::json!({
                "removeConfirm": "auto"
            }))
            .is_err()
        );
        assert!(
            serde_json::to_value(CohostSettingsPatch::default())
                .unwrap()
                .get("wakeWordRequired")
                .is_none()
        );

        // A command: camelCase keys, kebab-case enums, empty optionals omitted.
        let command = CohostCommand {
            id: "cmd-1".to_string(),
            heard: "orcle highlight coders x".to_string(),
            kind: CohostCommandKind::Highlight,
            status: CohostCommandStatus::NotFound,
            message: "Golem couldn't find a comment from coders x.".to_string(),
            target: None,
            candidates: Vec::new(),
            operation_id: None,
            reason: None,
            at: "2026-10-04T12:00:00Z".to_string(),
            expires_at: None,
        };
        assert_eq!(
            serde_json::to_value(&command).unwrap(),
            serde_json::json!({
                "id": "cmd-1",
                "heard": "orcle highlight coders x",
                "kind": "highlight",
                "status": "not-found",
                "message": "Golem couldn't find a comment from coders x.",
                "at": "2026-10-04T12:00:00Z"
            })
        );
        // The kill switches: omitted while both are on.
        assert_eq!(command_availability(true, true), None);
        assert_eq!(
            serde_json::to_value(command_availability(false, true)).unwrap(),
            serde_json::json!({ "voiceCommands": "paused", "remove": "on" })
        );
        // A session report with no command counted carries no `commands` key.
        let (mut engine, _) = command_engine(Instant::now(), &[]);
        let report = serde_json::to_value(engine.stop_session().unwrap()).unwrap();
        assert!(report.get("commands").is_none());
    }

    #[test]
    fn spoken_names_match_authors_of_the_last_ten_minutes() {
        let start = Instant::now();
        let old = command_row(1, "OldTimer", StreamPlatform::Twitch, "hello from before");
        let rows = vec![
            command_row(2, "coders_x", StreamPlatform::Twitch, "first from coders"),
            command_row(3, "someone_else", StreamPlatform::Youtube, "hi all"),
            command_row(4, "coders_x", StreamPlatform::Twitch, "is rust hard?"),
        ];
        let mut engine = CohostEngine::new(enabled_settings());
        engine.start_session(COMMAND_SESSION.to_string(), true, None, start);
        engine.note_messages_at(std::slice::from_ref(&old), start);
        engine.note_messages_at(&rows, start + secs(300));
        let session = engine.session.as_mut().unwrap();
        let now = start + secs(660);

        // "coders X", "codersx", "Coders_X": coders_x, their newest comment.
        for spoken in ["coders x", "codersx", "Coders_X"] {
            assert_eq!(
                session.resolve_command_name(spoken, false, now),
                CommandResolution::One(rows[2].id.clone()),
                "{spoken}"
            );
        }
        // "Question" prefers their newest open question.
        session.questions = vec![open_question("q-1", &[rows[0].id.as_str()])];
        assert_eq!(
            session.resolve_command_name("coders x", true, now),
            CommandResolution::One(rows[0].id.clone())
        );
        assert_eq!(
            session.resolve_command_name("coders x", false, now),
            CommandResolution::One(rows[2].id.clone())
        );
        // Older than ten minutes is out of reach; within them it is found.
        assert_eq!(
            session.resolve_command_name("old timer", false, now),
            CommandResolution::NotFound(
                "Golem couldn't find a comment from old timer.".to_string()
            )
        );
        assert_eq!(
            session.resolve_command_name("old timer", false, start + secs(500)),
            CommandResolution::One(old.id.clone())
        );
        // Nobody by that name, or nothing left once command words go.
        assert!(matches!(
            session.resolve_command_name("ziggy stardust", false, now),
            CommandResolution::NotFound(_)
        ));
        assert!(matches!(
            session.resolve_command_name("the comment", false, now),
            CommandResolution::NotFound(_)
        ));
    }

    #[test]
    fn a_whole_name_beats_a_partial_one_and_several_people_open_a_chooser() {
        let now = Instant::now();
        let rows = vec![
            command_row(1, "coders_x", StreamPlatform::Twitch, "rust is great"),
            command_row(2, "coders_y", StreamPlatform::Youtube, "which editor?"),
        ];
        let (engine, _) = command_engine(now, &rows);
        let session = engine.session.as_ref().unwrap();
        // coders_y also has "coders", but only coders_x is "coders x".
        assert_eq!(
            session.resolve_command_name("coders x", false, now),
            CommandResolution::One(rows[0].id.clone())
        );
        // "Coders" alone fits both: a chooser, the newest author first.
        assert_eq!(
            session.resolve_command_name("coders", false, now),
            CommandResolution::Several(vec![rows[1].id.clone(), rows[0].id.clone()])
        );
        // The same name on two platforms is two people: a chooser too.
        let twins = vec![
            command_row(3, "PixelPal", StreamPlatform::Twitch, "gg"),
            command_row(4, "PixelPal", StreamPlatform::Kick, "gg wp"),
        ];
        let (engine, _) = command_engine(now, &twins);
        let session = engine.session.as_ref().unwrap();
        assert_eq!(
            session.resolve_command_name("pixel pal", false, now),
            CommandResolution::Several(vec![twins[1].id.clone(), twins[0].id.clone()])
        );
    }

    #[test]
    fn show_this_one_prefers_the_spotlight_then_an_open_question_then_the_newest() {
        let now = Instant::now();
        let rows = vec![
            command_row(1, "ada", StreamPlatform::Twitch, "talking point"),
            command_row(2, "bob", StreamPlatform::Twitch, "is rust hard?"),
            command_row(3, "cy", StreamPlatform::Twitch, "newest"),
        ];
        let (mut engine, _) = command_engine(now, &rows);
        let session = engine.session.as_mut().unwrap();
        assert_eq!(session.highlight_deixis(now), Some(rows[2].id.clone()));
        session.questions = vec![open_question("q-1", &[rows[1].id.as_str()])];
        assert_eq!(session.highlight_deixis(now), Some(rows[1].id.clone()));
        session.spotlight.current = Some(spotlight_on(&rows[0].id, now));
        assert_eq!(session.highlight_deixis(now), Some(rows[0].id.clone()));
        // An expired spotlight no longer counts.
        assert_eq!(
            session.highlight_deixis(now + secs(11)),
            Some(rows[1].id.clone())
        );
        // "Show the last comment" is the newest, whatever is talked about.
        assert_eq!(
            session.resolve_command_target(
                CommandIntent::Highlight,
                &CommandTargetSpec::Spoken {
                    target: CommandTarget::Last,
                    question: false,
                },
                None,
                now,
                chrono::Utc::now(),
            ),
            CommandResolution::One(rows[2].id.clone())
        );
    }

    #[test]
    fn remove_this_one_weighs_the_card_on_stream_a_fresh_flag_and_the_spotlight() {
        let now = Instant::now();
        let now_utc = chrono::Utc::now();
        let names = ["ada", "bob", "cy", "dee", "eve"];
        let rows: Vec<LiveChatMessage> = names
            .iter()
            .enumerate()
            .map(|(index, name)| {
                command_row(index as u32 + 1, name, StreamPlatform::Twitch, "some words")
            })
            .collect();
        let ids: Vec<String> = rows.iter().map(|row| row.id.clone()).collect();
        let (mut engine, _) = command_engine(now, &rows);
        let session = engine.session.as_mut().unwrap();
        // Nothing on stream, flagged or talked about: never a guess, a
        // chooser of the newest three.
        assert_eq!(
            session.resolve_removal_deixis(None, now, now_utc),
            CommandResolution::Several(vec![ids[4].clone(), ids[3].clone(), ids[2].clone()])
        );
        // Only the card on stream: that one.
        assert_eq!(
            session.resolve_removal_deixis(Some(ids[0].as_str()), now, now_utc),
            CommandResolution::One(ids[0].clone())
        );
        // A fresh flag on another comment: a chooser, the card on stream first.
        session.flags.push(command_flag(
            &ids[1],
            CohostFlagSeverity::High,
            now_utc.to_rfc3339(),
        ));
        assert_eq!(
            session.resolve_removal_deixis(Some(ids[0].as_str()), now, now_utc),
            CommandResolution::Several(vec![ids[0].clone(), ids[1].clone()])
        );
        // The flagged comment is the one on stream: deduped to one.
        assert_eq!(
            session.resolve_removal_deixis(Some(ids[1].as_str()), now, now_utc),
            CommandResolution::One(ids[1].clone())
        );
        // The spotlight joins as the third.
        session.spotlight.current = Some(spotlight_on(&ids[2], now));
        assert_eq!(
            session.resolve_removal_deixis(Some(ids[0].as_str()), now, now_utc),
            CommandResolution::Several(vec![ids[0].clone(), ids[1].clone(), ids[2].clone()])
        );
        session.spotlight.current = None;
        // A flag older than two minutes no longer counts.
        session.flags[0].at = (now_utc - chrono::Duration::seconds(121)).to_rfc3339();
        assert_eq!(
            session.resolve_removal_deixis(Some(ids[0].as_str()), now, now_utc),
            CommandResolution::One(ids[0].clone())
        );
        // The newest flag counts, not the first one raised.
        session.flags[0].at = now_utc.to_rfc3339();
        session.flags.push(command_flag(
            &ids[3],
            CohostFlagSeverity::Low,
            now_utc.to_rfc3339(),
        ));
        assert_eq!(
            session.resolve_removal_deixis(None, now, now_utc),
            CommandResolution::One(ids[3].clone())
        );
        // A deleted comment never counts, flagged or not.
        session.deleted_ids.insert(ids[3].clone());
        assert_eq!(
            session.resolve_removal_deixis(None, now, now_utc),
            CommandResolution::One(ids[1].clone())
        );
    }

    #[test]
    fn commands_never_point_at_the_streamer_a_tombstone_or_a_notification_row() {
        let now = Instant::now();
        let mut owner = command_row(1, "streamer_bob", StreamPlatform::Twitch, "welcome in");
        owner.author_roles = vec!["broadcaster".to_string()];
        let mut raid = command_row(2, "raider_joe", StreamPlatform::Twitch, "raiding with 20");
        raid.raw_provider_type = Some("channel.chat.notification:raid".to_string());
        let ann = command_row(3, "viewer_ann", StreamPlatform::Twitch, "bad words");
        let (mut engine, scope) = command_engine(now, &[owner.clone(), raid.clone(), ann.clone()]);
        let mut tombstone = ann.clone();
        tombstone.is_deleted = true;
        tombstone.event_type = LiveChatEventType::Deleted;
        engine.note_messages_at(&[tombstone], now);
        {
            let session = engine.session.as_ref().unwrap();
            for name in ["streamer bob", "raider joe", "viewer ann"] {
                assert!(
                    matches!(
                        session.resolve_command_name(name, false, now),
                        CommandResolution::NotFound(_)
                    ),
                    "{name}"
                );
            }
            assert!(session.newest_command_messages(3).is_empty());
            assert_eq!(session.highlight_deixis(now), None);
            assert_eq!(
                session.resolve_removal_deixis(Some(owner.id.as_str()), now, chrono::Utc::now()),
                CommandResolution::NotFound("Golem couldn't find a comment to remove.".to_string())
            );
        }
        // An id handed in from elsewhere (S8) gets the same rules.
        let mut ctx = command_ctx(now);
        ctx.on_stream = Some(owner.id.clone());
        engine
            .begin_command(
                &scope,
                NewCommand {
                    intent: CommandIntent::Highlight,
                    spec: CommandTargetSpec::Resolved(vec![owner.id.clone(), raid.id.clone()]),
                    heard: "orcle show that".to_string(),
                    reason: None,
                    wake_word: true,
                },
                &ctx,
            )
            .unwrap();
        let command = current_command(&engine);
        assert_eq!(command.status, CohostCommandStatus::NotFound);
        assert_eq!(command.message, "Golem couldn't find that comment.");
        assert!(engine.snapshot().auto_highlight.is_none());
    }

    #[test]
    fn a_highlight_command_puts_the_comment_on_stream_with_source_command() {
        let now = Instant::now();
        let rows = vec![
            command_row(1, "coders_x", StreamPlatform::Twitch, "is rust hard?"),
            command_row(2, "ada", StreamPlatform::Youtube, "hello"),
        ];
        let (mut engine, scope) = command_engine(now, &rows);
        let effects = engine
            .begin_command(
                &scope,
                spoken(CommandIntent::Highlight, named("coders x")),
                &command_ctx(now),
            )
            .unwrap();
        assert!(effects.emit);
        assert!(effects.request_removal.is_none() && effects.cancel_superseded.is_empty());
        let state = engine.snapshot();
        let auto = state.auto_highlight.clone().unwrap();
        assert_eq!(auto.source, CohostAutoHighlightSource::Command);
        assert_eq!(auto.message_id, rows[0].id);
        assert!(!auto.refresh);
        assert_eq!(serde_json::to_value(&auto).unwrap()["source"], "command");
        let command = state.command.unwrap();
        assert_eq!(command.kind, CohostCommandKind::Highlight);
        assert_eq!(command.status, CohostCommandStatus::Done);
        assert_eq!(command.message, "Highlighted coders_x's comment.");
        let target = command.target.unwrap();
        assert_eq!(target.platform, StreamPlatform::Twitch);
        assert_eq!(target.excerpt, "is rust hard?");
        assert_eq!(command.expires_at, None);

        // The automatic cadence never holds a command back: the next one goes
        // straight out with a new generation.
        engine
            .begin_command(
                &scope,
                spoken(CommandIntent::Highlight, named("ada")),
                &command_ctx(now + secs(1)),
            )
            .unwrap();
        let next = engine.snapshot().auto_highlight.unwrap();
        assert_eq!(next.message_id, rows[1].id);
        assert!(next.generation > auto.generation);
        assert_eq!(command_counts(&engine).highlighted, 2);
        // Re-setting the card already on stream is a refresh.
        let mut ctx = command_ctx(now + secs(2));
        ctx.on_stream = Some(rows[0].id.clone());
        engine
            .begin_command(
                &scope,
                spoken(CommandIntent::Highlight, named("coders x")),
                &ctx,
            )
            .unwrap();
        assert!(engine.snapshot().auto_highlight.unwrap().refresh);
        // A stale session generation drops the command.
        let stale = CommandSession {
            session_id: COMMAND_SESSION.to_string(),
            generation: scope.generation + 1,
        };
        assert!(
            engine
                .begin_command(
                    &stale,
                    spoken(CommandIntent::Highlight, named("ada")),
                    &command_ctx(now)
                )
                .is_none()
        );
    }

    #[test]
    fn a_highlight_of_a_comment_orcle_flagged_high_asks_first() {
        let now = Instant::now();
        let rows = vec![
            command_row(1, "grumpy_gus", StreamPlatform::Twitch, "you are bad"),
            command_row(2, "meh_mel", StreamPlatform::Twitch, "check my channel"),
        ];
        let (mut engine, scope) = command_engine(now, &rows);
        {
            let session = engine.session.as_mut().unwrap();
            let at = chrono::Utc::now().to_rfc3339();
            session.flags.push(command_flag(
                &rows[0].id,
                CohostFlagSeverity::High,
                at.clone(),
            ));
            session
                .flags
                .push(command_flag(&rows[1].id, CohostFlagSeverity::Medium, at));
        }
        let effects = engine
            .begin_command(
                &scope,
                spoken(CommandIntent::Highlight, named("grumpy gus")),
                &command_ctx(now),
            )
            .unwrap();
        assert!(effects.expire_card.is_some());
        let card = current_command(&engine);
        assert_eq!(card.status, CohostCommandStatus::Confirm);
        assert_eq!(card.kind, CohostCommandKind::Highlight);
        assert_eq!(
            card.message,
            "Golem flagged this (harassment). Show it anyway?"
        );
        assert!(card.expires_at.is_some() && card.operation_id.is_none());
        assert!(
            engine.snapshot().auto_highlight.is_none(),
            "nothing on stream before a yes"
        );
        assert!(engine.command_slot_mirror().0.awaiting_answer);
        // Yes: on stream, source command.
        engine
            .answer_command(
                &scope,
                None,
                CommandAnswer::Confirm,
                &command_ctx(now + secs(1)),
            )
            .unwrap();
        let shown = engine.snapshot();
        assert_eq!(shown.auto_highlight.unwrap().message_id, rows[0].id);
        let done = shown.command.unwrap();
        assert_eq!(done.id, card.id);
        assert_eq!(done.status, CohostCommandStatus::Done);
        assert!(!engine.command_slot_mirror().0.awaiting_answer);
        // No: nothing shown, counted as cancelled.
        engine
            .begin_command(
                &scope,
                spoken(CommandIntent::Highlight, named("grumpy gus")),
                &command_ctx(now + secs(20)),
            )
            .unwrap();
        let generation = engine.snapshot().auto_highlight.map(|auto| auto.generation);
        engine
            .answer_command(
                &scope,
                None,
                CommandAnswer::Cancel,
                &command_ctx(now + secs(21)),
            )
            .unwrap();
        let cancelled = current_command(&engine);
        assert_eq!(cancelled.status, CohostCommandStatus::Cancelled);
        assert_eq!(cancelled.message, "Cancelled. Nothing was shown.");
        assert_eq!(
            engine.snapshot().auto_highlight.map(|auto| auto.generation),
            generation
        );
        // A medium flag is the streamer's call: shown at once.
        engine
            .begin_command(
                &scope,
                spoken(CommandIntent::Highlight, named("meh mel")),
                &command_ctx(now + secs(40)),
            )
            .unwrap();
        assert_eq!(current_command(&engine).status, CohostCommandStatus::Done);
        let counts = command_counts(&engine);
        assert_eq!((counts.highlighted, counts.cancelled), (2, 1));
    }

    #[test]
    fn a_chooser_opens_for_several_matches_and_a_pick_runs_the_command() {
        let now = Instant::now();
        let rows = vec![
            command_row(1, "coders_x", StreamPlatform::Twitch, "rust is great"),
            command_row(2, "coders_y", StreamPlatform::Youtube, "which editor?"),
        ];
        let (mut engine, scope) = command_engine(now, &rows);
        let effects = engine
            .begin_command(
                &scope,
                spoken(CommandIntent::Highlight, named("coders")),
                &command_ctx(now),
            )
            .unwrap();
        let (timer_id, timer_expires) = effects.expire_card.clone().unwrap();
        let chooser = current_command(&engine);
        assert_eq!(chooser.status, CohostCommandStatus::Ambiguous);
        assert_eq!(chooser.id, timer_id);
        assert_eq!(chooser.expires_at.as_deref(), Some(timer_expires.as_str()));
        assert_eq!(
            chooser.message,
            "Which comment? Say 'the first one' or press 1 or 2."
        );
        assert_eq!(
            chooser
                .candidates
                .iter()
                .map(|candidate| candidate.author_name.as_str())
                .collect::<Vec<_>>(),
            vec!["coders_y", "coders_x"]
        );
        assert!(chooser.target.is_none());
        assert!(engine.command_slot_mirror().0.awaiting_choice);
        assert!(engine.snapshot().auto_highlight.is_none());
        // A pick past the list, for another card, or a yes are refused, and
        // change nothing.
        assert_eq!(
            engine
                .answer_command(&scope, None, CommandAnswer::Choose(2), &command_ctx(now))
                .unwrap_err()
                .code,
            "invalid-params"
        );
        assert_eq!(
            engine
                .answer_command(
                    &scope,
                    Some("cmd-other"),
                    CommandAnswer::Choose(0),
                    &command_ctx(now)
                )
                .unwrap_err()
                .code,
            "not-pending"
        );
        assert_eq!(
            engine
                .answer_command(&scope, None, CommandAnswer::Confirm, &command_ctx(now))
                .unwrap_err()
                .code,
            "not-pending"
        );
        assert_eq!(current_command(&engine), chooser);
        // "The second one": coders_x goes on stream.
        engine
            .answer_command(
                &scope,
                Some(chooser.id.as_str()),
                CommandAnswer::Choose(1),
                &command_ctx(now + secs(1)),
            )
            .unwrap();
        let picked = current_command(&engine);
        assert_eq!(picked.id, chooser.id, "the same command, answered");
        assert_eq!(picked.status, CohostCommandStatus::Done);
        assert_eq!(picked.message, "Highlighted coders_x's comment.");
        assert!(picked.candidates.is_empty());
        assert_eq!(
            engine.snapshot().auto_highlight.unwrap().message_id,
            rows[0].id
        );
        assert!(!engine.command_slot_mirror().0.awaiting_choice);
        // The chooser's timer finds an answered card and does nothing.
        assert!(!engine.session.as_mut().unwrap().expire_command(
            &timer_id,
            &timer_expires,
            "2026-10-04T12:00:20Z"
        ));
        // A removal chooser: the pick asks chat moderation for that one.
        let effects = engine
            .begin_command(
                &scope,
                spoken(CommandIntent::Remove, named("coders")),
                &command_ctx(now + secs(30)),
            )
            .unwrap();
        assert!(effects.request_removal.is_none());
        let effects = engine
            .answer_command(
                &scope,
                None,
                CommandAnswer::Choose(0),
                &command_ctx(now + secs(31)),
            )
            .unwrap();
        let request = effects.request_removal.unwrap();
        assert_eq!(request.message_id, rows[1].id);
        assert_eq!(request.confirm_mode, RemoveConfirmMode::Confirm);
        let card = current_command(&engine);
        assert_eq!(
            (card.kind, card.status),
            (CohostCommandKind::Remove, CohostCommandStatus::Confirm)
        );
        assert_eq!(
            card.operation_id, None,
            "chat moderation has not opened it yet"
        );
        assert!(!engine.command_slot_mirror().0.awaiting_answer);
    }

    #[test]
    fn a_name_cut_by_a_chunk_boundary_is_one_request_and_the_newest_command_wins() {
        let now = Instant::now();
        let rows = vec![
            command_row(1, "coders_x", StreamPlatform::Twitch, "you are trash"),
            command_row(2, "ada", StreamPlatform::Youtube, "hello"),
        ];
        let (mut engine, scope) = command_engine(now, &rows);
        // "remove the comment from coders" ... "coders x" in the next final.
        let operation = open_removal_card(
            &mut engine,
            &scope,
            spoken(CommandIntent::Remove, named("coders")),
            &command_ctx(now),
            &rows[0],
        );
        let card = current_command(&engine);
        assert_eq!(
            card.operation_id.as_deref(),
            Some(operation.operation_id.as_str())
        );
        assert!(engine.command_slot_mirror().0.awaiting_answer);
        assert_eq!(
            engine.command_slot_mirror().1.as_deref(),
            Some(operation.operation_id.as_str())
        );
        let again = engine
            .begin_command(
                &scope,
                spoken(CommandIntent::Remove, named("coders x")),
                &command_ctx(now + secs(3)),
            )
            .unwrap();
        assert!(
            !again.emit && again.request_removal.is_none() && again.cancel_superseded.is_empty()
        );
        assert_eq!(
            current_command(&engine),
            card,
            "the same request changes nothing"
        );

        // A different command replaces the card and cancels its removal.
        let effects = engine
            .begin_command(
                &scope,
                spoken(CommandIntent::Highlight, named("ada")),
                &command_ctx(now + secs(4)),
            )
            .unwrap();
        assert_eq!(
            effects.cancel_superseded,
            vec![operation.operation_id.clone()]
        );
        assert_eq!(current_command(&engine).kind, CohostCommandKind::Highlight);
        assert_eq!(engine.command_slot_mirror().1, None);
        // Its cancellation lands later: not the streamer's "no", never counted.
        let mut cancelled = operation.clone();
        cancelled.phase = ModerationPhase::Cancelled;
        cancelled.outcome = Some("Cancelled. Nothing was removed.".to_string());
        assert!(
            !engine
                .session
                .as_mut()
                .unwrap()
                .apply_command_operation(&cancelled, "2026-10-04T12:00:05Z"),
            "the card moved on"
        );
        assert_eq!(command_counts(&engine).cancelled, 0);
        // The same highlight again within ten seconds is the same request...
        let same = engine
            .begin_command(
                &scope,
                spoken(CommandIntent::Highlight, named("ada")),
                &command_ctx(now + secs(5)),
            )
            .unwrap();
        assert!(!same.emit);
        // ...after them it is a new one.
        let later = engine
            .begin_command(
                &scope,
                spoken(CommandIntent::Highlight, named("ada")),
                &command_ctx(now + secs(15)),
            )
            .unwrap();
        assert!(later.emit);
        assert_eq!(command_counts(&engine).highlighted, 2);
        // A chooser replaced by a newer command is not counted as cancelled.
        engine
            .begin_command(
                &scope,
                NewCommand {
                    intent: CommandIntent::Highlight,
                    spec: CommandTargetSpec::Resolved(vec![rows[0].id.clone(), rows[1].id.clone()]),
                    heard: "orcle show one of those".to_string(),
                    reason: None,
                    wake_word: true,
                },
                &command_ctx(now + secs(30)),
            )
            .unwrap();
        assert_eq!(
            current_command(&engine).status,
            CohostCommandStatus::Ambiguous
        );
        engine
            .begin_command(
                &scope,
                spoken(CommandIntent::Clear, CommandTarget::None),
                &command_ctx(now + secs(31)),
            )
            .unwrap();
        assert_eq!(current_command(&engine).kind, CohostCommandKind::Clear);
        assert_eq!(command_counts(&engine).cancelled, 0);
    }

    #[test]
    fn remove_it_then_from_the_screen_is_a_correction() {
        let now = Instant::now();
        let rows = vec![command_row(
            1,
            "coders_x",
            StreamPlatform::Twitch,
            "spam link",
        )];
        let (mut engine, scope) = command_engine(now, &rows);
        let on_stream = |at: Instant| {
            let mut ctx = command_ctx(at);
            ctx.on_stream = Some(rows[0].id.clone());
            ctx
        };
        // "Golem, remove it": the card on stream is the one.
        let operation = open_removal_card(
            &mut engine,
            &scope,
            spoken(CommandIntent::Remove, CommandTarget::Deixis),
            &on_stream(now),
            &rows[0],
        );
        // "...from the screen" in the next final: a clear, two seconds later.
        let effects = engine
            .begin_command(
                &scope,
                spoken(CommandIntent::Clear, CommandTarget::Deixis),
                &on_stream(now + secs(2)),
            )
            .unwrap();
        assert_eq!(
            effects.cancel_superseded,
            vec![operation.operation_id.clone()]
        );
        assert!(effects.clear_highlight);
        let cleared = current_command(&engine);
        assert_eq!(
            (cleared.kind, cleared.status),
            (CohostCommandKind::Clear, CohostCommandStatus::Done)
        );
        assert_eq!(
            cleared.message,
            "Cleared the highlight. Nothing was removed."
        );
        // The removal's cancellation is not counted; the clear is.
        let mut cancelled = operation;
        cancelled.phase = ModerationPhase::Cancelled;
        engine
            .session
            .as_mut()
            .unwrap()
            .apply_command_operation(&cancelled, "2026-10-04T12:00:03Z");
        let counts = command_counts(&engine);
        assert_eq!((counts.cleared, counts.cancelled), (1, 0));
        // A clear long after a removal card opened just clears; newest still wins.
        let operation = open_removal_card(
            &mut engine,
            &scope,
            spoken(CommandIntent::Remove, CommandTarget::Deixis),
            &on_stream(now + secs(30)),
            &rows[0],
        );
        let effects = engine
            .begin_command(
                &scope,
                spoken(CommandIntent::Clear, CommandTarget::Deixis),
                &on_stream(now + secs(40)),
            )
            .unwrap();
        assert_eq!(effects.cancel_superseded, vec![operation.operation_id]);
        assert_eq!(current_command(&engine).message, "Cleared the highlight.");
        // Nothing on stream: it says so, and it is not counted.
        engine
            .begin_command(
                &scope,
                spoken(CommandIntent::Clear, CommandTarget::None),
                &command_ctx(now + secs(50)),
            )
            .unwrap();
        assert_eq!(current_command(&engine).message, "Nothing was on stream.");
        assert_eq!(command_counts(&engine).cleared, 2);
    }

    #[test]
    fn a_removal_card_follows_its_operation_and_the_report_counts_the_outcome() {
        let now = Instant::now();
        let names = ["ada", "bob", "cy", "dee", "eve", "fay"];
        let rows: Vec<LiveChatMessage> = names
            .iter()
            .enumerate()
            .map(|(index, name)| {
                command_row(index as u32 + 1, name, StreamPlatform::Twitch, "rude words")
            })
            .collect();
        let (mut engine, scope) = command_engine(now, &rows);
        let hidden = "Hidden in Videorc. Viewers on Twitch still see it. Reconnect Twitch to let Golem remove messages.";
        let outcomes = [
            (
                ModerationPhase::Removed,
                None,
                CohostCommandStatus::Done,
                "Removed ada's comment from Twitch.",
            ),
            (
                ModerationPhase::HiddenLocally,
                Some(hidden),
                CohostCommandStatus::Done,
                hidden,
            ),
            (
                ModerationPhase::Cancelled,
                Some("Cancelled. Nothing was removed."),
                CohostCommandStatus::Cancelled,
                "Cancelled. Nothing was removed.",
            ),
            (
                ModerationPhase::Expired,
                Some("No answer in 20 seconds. Nothing was removed."),
                CohostCommandStatus::Expired,
                "Nothing was removed.",
            ),
            (
                ModerationPhase::Failed,
                Some("Twitch refused the removal."),
                CohostCommandStatus::Refused,
                "Twitch refused the removal.",
            ),
            (
                ModerationPhase::DeliveryUnknown,
                Some("Twitch did not answer in time. Check chat to see whether it was removed."),
                CohostCommandStatus::Refused,
                "Twitch did not answer in time. Check chat to see whether it was removed.",
            ),
        ];
        for (index, (phase, outcome, status, message)) in outcomes.into_iter().enumerate() {
            let at = now + secs(20 * (index as u64 + 1));
            let operation = open_removal_card(
                &mut engine,
                &scope,
                resolved_removal(&rows[index].id),
                &command_ctx(at),
                &rows[index],
            );
            let card = current_command(&engine);
            assert_eq!(card.status, CohostCommandStatus::Confirm);
            assert_eq!(card.reason.as_deref(), Some("toxic"));
            assert_eq!(card.expires_at, operation.confirm_by);
            assert_eq!(card.message, format!("Remove {}'s comment?", names[index]));
            let session = engine.session.as_mut().unwrap();
            if phase != ModerationPhase::Cancelled && phase != ModerationPhase::Expired {
                // Confirmed: it runs at the platform.
                let mut running = operation.clone();
                running.phase = ModerationPhase::Executing;
                assert!(session.apply_command_operation(&running, "2026-10-04T12:00:00Z"));
                let removing = session.command.as_ref().unwrap();
                assert_eq!(removing.pending, CommandPending::Removing);
                assert_eq!(removing.wire.status, CohostCommandStatus::Confirm);
                assert_eq!(removing.wire.expires_at, None);
                assert_eq!(
                    removing.wire.message,
                    format!("Removing {}'s comment…", names[index])
                );
            }
            let mut finished = operation.clone();
            finished.phase = phase;
            finished.outcome = outcome.map(str::to_string);
            assert!(session.apply_command_operation(&finished, "2026-10-04T12:00:01Z"));
            let wire = &session.command.as_ref().unwrap().wire;
            assert_eq!(wire.status, status, "{phase:?}");
            assert_eq!(wire.message, message, "{phase:?}");
            assert_eq!(wire.expires_at, None);
            // A late copy of an older change, or the same one twice: nothing.
            assert!(!session.apply_command_operation(&operation, "2026-10-04T12:00:02Z"));
            assert!(!session.apply_command_operation(&finished, "2026-10-04T12:00:02Z"));
        }
        let counts = command_counts(&engine);
        assert_eq!(counts.removed, 1);
        assert_eq!(counts.hidden_locally, 1);
        assert_eq!(counts.cancelled, 1);
        assert_eq!(counts.expired, 1);
        assert_eq!(counts.failed, 2);
        assert!(!engine.command_slot_mirror().0.awaiting_answer);

        // Countdown mode: the card says when it runs.
        let message = &rows[0];
        let effects = engine
            .begin_command(
                &scope,
                resolved_removal(&message.id),
                &command_ctx(now + secs(200)),
            )
            .unwrap();
        let request = effects.request_removal.unwrap();
        let mut countdown = voice_operation(message, ModerationPhase::PendingConfirm);
        countdown.confirm_mode = RemoveConfirmMode::Countdown;
        countdown.requires_explicit_confirm = false;
        countdown.confirm_by = None;
        countdown.execute_at =
            Some((chrono::Utc::now() + chrono::Duration::seconds(5)).to_rfc3339());
        engine.session.as_mut().unwrap().settle_command_removal(
            &request.command_id,
            Ok(countdown.clone()),
            "2026-10-04T12:05:00Z",
        );
        let card = current_command(&engine);
        assert_eq!(card.expires_at, countdown.execute_at);
        assert!(
            card.message.starts_with("Removing ada's comment in ")
                && card.message.ends_with("seconds."),
            "{}",
            card.message
        );
        assert!(
            engine.command_slot_mirror().0.awaiting_answer,
            "a no still stops it"
        );
    }

    #[tokio::test]
    async fn a_voice_removal_opens_a_card_and_a_spoken_yes_removes_the_comment() {
        let rows = vec![
            command_row(
                1,
                "coders_x",
                StreamPlatform::Twitch,
                "this stream is trash",
            ),
            command_row(2, "ada", StreamPlatform::Twitch, "hello"),
        ];
        let (state, scope) = command_state(&rows, fake_deletes()).await;
        // Golem flagged it a moment ago: "this one" is that comment.
        state
            .cohost
            .lock()
            .await
            .session
            .as_mut()
            .unwrap()
            .flags
            .push(command_flag(
                &rows[0].id,
                CohostFlagSeverity::High,
                chrono::Utc::now().to_rfc3339(),
            ));
        run_detected_command(
            &state,
            &scope,
            detected(
                CommandKind::Remove,
                CommandTarget::Deixis,
                "this one is toxic remove it from our chat",
                Some("toxic"),
            ),
            true,
        )
        .await;
        let card = state_command(&state).await;
        assert_eq!(
            (card.kind, card.status),
            (CohostCommandKind::Remove, CohostCommandStatus::Confirm)
        );
        assert_eq!(card.message, "Remove coders_x's comment?");
        assert_eq!(card.reason.as_deref(), Some("toxic"));
        assert_eq!(card.heard, "this one is toxic remove it from our chat");
        let operation_id = card
            .operation_id
            .clone()
            .expect("chat moderation opened the card");
        let operation = state
            .database
            .get_chat_moderation_operation(&operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(operation.phase, ModerationPhase::PendingConfirm);
        assert_eq!(operation.source, ModerationSource::OrcleVoice);
        assert_eq!(operation.message_id, rows[0].id);
        assert_eq!(operation.reason.as_deref(), Some("toxic"));
        assert_eq!(card.expires_at, operation.confirm_by);
        {
            let slot = state.cohost_commands.lock().unwrap();
            assert!(slot.context.awaiting_answer);
            assert_eq!(
                slot.pending_operation.as_deref(),
                Some(operation_id.as_str())
            );
        }

        // "Yes, remove it."
        run_detected_command(
            &state,
            &scope,
            detected(
                CommandKind::Confirm,
                CommandTarget::None,
                "yes remove it",
                None,
            ),
            true,
        )
        .await;
        let done = state_command(&state).await;
        assert_eq!(done.id, card.id);
        assert_eq!(done.status, CohostCommandStatus::Done);
        assert_eq!(done.message, "Removed coders_x's comment from Twitch.");
        let row = state
            .live_chat
            .lock()
            .await
            .message(&rows[0].id)
            .cloned()
            .unwrap();
        assert!(row.is_deleted);
        assert_eq!(
            row.raw_provider_type.as_deref(),
            Some(crate::live_chat_moderation::REMOVED_PROVIDER_TYPE)
        );
        assert_eq!(state_counts(&state).await.removed, 1);
        {
            let slot = state.cohost_commands.lock().unwrap();
            assert!(!slot.context.awaiting_answer);
            assert_eq!(slot.pending_operation, None);
        }
        // A late copy of an older change changes nothing.
        let stale = ModerationOperation {
            phase: ModerationPhase::PendingConfirm,
            ..operation
        };
        assert!(
            !state
                .cohost
                .lock()
                .await
                .session
                .as_mut()
                .unwrap()
                .apply_command_operation(&stale, "2026-10-04T12:00:00Z")
        );
        // A second "yes" finds nothing waiting.
        run_detected_command(
            &state,
            &scope,
            detected(CommandKind::Confirm, CommandTarget::None, "yes", None),
            true,
        )
        .await;
        assert_eq!(state_command(&state).await, done);
        assert_eq!(state_counts(&state).await.removed, 1);
    }

    #[tokio::test]
    async fn a_spoken_no_cancels_the_removal_and_keeps_the_comment() {
        let rows = vec![command_row(
            1,
            "coders_x",
            StreamPlatform::Twitch,
            "spam link",
        )];
        let (state, scope) = command_state(&rows, fake_deletes()).await;
        show_on_stream(&state, &rows[0].id).await;
        run_detected_command(
            &state,
            &scope,
            detected(
                CommandKind::Remove,
                CommandTarget::Deixis,
                "remove it from chat",
                None,
            ),
            true,
        )
        .await;
        let card = state_command(&state).await;
        let operation_id = card.operation_id.clone().unwrap();
        run_detected_command(
            &state,
            &scope,
            detected(CommandKind::Cancel, CommandTarget::None, "no", None),
            true,
        )
        .await;
        let cancelled = state_command(&state).await;
        assert_eq!(cancelled.id, card.id);
        assert_eq!(cancelled.status, CohostCommandStatus::Cancelled);
        assert_eq!(cancelled.message, "Cancelled. Nothing was removed.");
        let stored = state
            .database
            .get_chat_moderation_operation(&operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.phase, ModerationPhase::Cancelled);
        assert!(
            !state
                .live_chat
                .lock()
                .await
                .message(&rows[0].id)
                .unwrap()
                .is_deleted
        );
        assert_eq!(state_counts(&state).await.cancelled, 1);
        assert!(
            !state
                .cohost_commands
                .lock()
                .unwrap()
                .context
                .awaiting_answer
        );
    }

    #[tokio::test]
    async fn countdown_mode_removes_unless_cancelled_and_the_card_follows() {
        let rows = vec![command_row(
            1,
            "coders_x",
            StreamPlatform::Twitch,
            "spam link",
        )];
        let (state, scope) = command_state(&rows, fake_deletes()).await;
        state.cohost.lock().await.settings.remove_confirm = RemoveConfirmMode::Countdown;
        show_on_stream(&state, &rows[0].id).await;
        run_detected_command(
            &state,
            &scope,
            detected(
                CommandKind::Remove,
                CommandTarget::Deixis,
                "remove it from chat",
                None,
            ),
            true,
        )
        .await;
        let card = state_command(&state).await;
        assert_eq!(card.status, CohostCommandStatus::Confirm);
        let operation = state
            .database
            .get_chat_moderation_operation(card.operation_id.as_deref().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(operation.confirm_mode, RemoveConfirmMode::Countdown);
        assert_eq!(card.expires_at, operation.execute_at);
        // Nobody says no: chat moderation runs it, and the card follows
        // through the moderation hook alone.
        let removed = wait_for_command(&state, "the countdown removal", |command| {
            command.status == CohostCommandStatus::Done
        })
        .await;
        assert_eq!(removed.message, "Removed coders_x's comment from Twitch.");
        assert_eq!(state_counts(&state).await.removed, 1);
    }

    #[test]
    fn only_an_explicit_spoken_command_removes_on_a_countdown() {
        let now = Instant::now();
        let rows = vec![
            command_row(1, "ada", StreamPlatform::Twitch, "spam link"),
            command_row(2, "coders_x", StreamPlatform::Twitch, "spam one"),
            command_row(3, "coders_y", StreamPlatform::Twitch, "spam two"),
        ];
        let (mut engine, scope) = command_engine(now, &rows);
        engine.settings.remove_confirm = RemoveConfirmMode::Countdown;
        let mut at = 0;
        let mut mode_for = |engine: &mut CohostEngine, command: NewCommand| {
            at += 60;
            engine
                .begin_command(&scope, command, &command_ctx(now + secs(at)))
                .unwrap()
                .request_removal
                .map(|request| request.confirm_mode)
        };
        // "Golem, remove ada's comment": the setting applies.
        assert_eq!(
            mode_for(&mut engine, spoken(CommandIntent::Remove, named("ada"))),
            Some(RemoveConfirmMode::Countdown)
        );
        // The structured phrase heard without the wake word waits for a yes.
        let mut structured = spoken(CommandIntent::Remove, named("ada"));
        structured.wake_word = false;
        assert!(!structured.countdown_allowed());
        assert_eq!(
            mode_for(&mut engine, structured),
            Some(RemoveConfirmMode::Confirm)
        );
        // A target the cloud parser picked waits for a yes.
        let resolved = resolved_removal(&rows[0].id);
        assert!(!resolved.countdown_allowed());
        assert_eq!(
            mode_for(&mut engine, resolved),
            Some(RemoveConfirmMode::Confirm)
        );
        // A removal picked from a structured command's chooser keeps the rule.
        let mut chooser = spoken(CommandIntent::Remove, named("coders"));
        chooser.wake_word = false;
        assert_eq!(mode_for(&mut engine, chooser), None);
        let request = engine
            .answer_command(
                &scope,
                None,
                CommandAnswer::Choose(0),
                &command_ctx(now + secs(at + 1)),
            )
            .unwrap()
            .request_removal
            .unwrap();
        assert_eq!(request.confirm_mode, RemoveConfirmMode::Confirm);
    }

    #[tokio::test]
    async fn a_structured_removal_waits_for_a_yes_in_countdown_mode() {
        let rows = vec![command_row(
            1,
            "coders_x",
            StreamPlatform::Twitch,
            "spam link",
        )];
        let (state, scope) = command_state(&rows, fake_deletes()).await;
        state.cohost.lock().await.settings.remove_confirm = RemoveConfirmMode::Countdown;
        show_on_stream(&state, &rows[0].id).await;
        let mut command = detected(
            CommandKind::Remove,
            CommandTarget::Deixis,
            "remove it from our chat",
            None,
        );
        command.wake_word = false;
        run_detected_command(&state, &scope, command, true).await;
        let card = state_command(&state).await;
        assert_eq!(card.status, CohostCommandStatus::Confirm);
        let operation = state
            .database
            .get_chat_moderation_operation(card.operation_id.as_deref().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(operation.confirm_mode, RemoveConfirmMode::Confirm);
        assert_eq!(operation.execute_at, None, "no countdown runs it");
        assert_eq!(operation.phase, ModerationPhase::PendingConfirm);
    }

    #[tokio::test]
    async fn a_cloud_parsed_removal_waits_for_a_yes_in_countdown_mode() {
        let rows = vec![command_row(
            1,
            "coders_x",
            StreamPlatform::Twitch,
            "spam link",
        )];
        let (state, scope) = command_state(&rows, fake_deletes()).await;
        state.cohost.lock().await.settings.remove_confirm = RemoveConfirmMode::Countdown;
        // What `execute_resolved_command` builds for the cloud parser's pick.
        run_new_command(&state, &scope, resolved_removal(&rows[0].id), true).await;
        let card = state_command(&state).await;
        assert_eq!(card.status, CohostCommandStatus::Confirm);
        let operation = state
            .database
            .get_chat_moderation_operation(card.operation_id.as_deref().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(operation.confirm_mode, RemoveConfirmMode::Confirm);
        assert_eq!(operation.execute_at, None, "no countdown runs it");
    }

    #[tokio::test]
    async fn a_platform_that_cannot_delete_hides_the_comment_and_the_card_says_so() {
        let rows = vec![command_row(
            1,
            "coders_x",
            StreamPlatform::Twitch,
            "spam link",
        )];
        // No delete credentials: Twitch is missing the scope.
        let (state, scope) = command_state(&rows, None).await;
        run_new_command(&state, &scope, resolved_removal(&rows[0].id), true).await;
        run_detected_command(
            &state,
            &scope,
            detected(CommandKind::Confirm, CommandTarget::None, "do it", None),
            true,
        )
        .await;
        let hidden = state_command(&state).await;
        assert_eq!(hidden.status, CohostCommandStatus::Done);
        assert!(
            hidden
                .message
                .starts_with("Hidden in Videorc. Viewers on Twitch still see it."),
            "{}",
            hidden.message
        );
        let counts = state_counts(&state).await;
        assert_eq!((counts.hidden_locally, counts.removed), (1, 0));
    }

    #[tokio::test]
    async fn removal_refusals_show_as_refused_or_unavailable() {
        let names = [
            "ada", "bob", "cy", "dee", "eve", "fay", "gil", "hal", "ida", "jon", "kim",
        ];
        let rows: Vec<LiveChatMessage> = names
            .iter()
            .enumerate()
            .map(|(index, name)| {
                command_row(index as u32 + 1, name, StreamPlatform::Twitch, "rude words")
            })
            .collect();
        let (state, scope) = command_state(&rows, fake_deletes()).await;
        let no_operations = |state: &AppState| {
            state
                .database
                .list_chat_moderation_operations(COMMAND_SESSION, 200)
                .unwrap()
                .is_empty()
        };

        // Premium lapsed: refused at once, nothing asked of chat moderation.
        run_new_command(&state, &scope, resolved_removal(&rows[0].id), false).await;
        let refused = state_command(&state).await;
        assert_eq!(refused.status, CohostCommandStatus::Unavailable);
        assert_eq!(refused.message, "Golem requires Videorc Premium.");
        assert!(no_operations(&state));

        // Removing paused by Videorc: the same, with its own line.
        set_orcle_flags(&state, r#"{"remove":false}"#);
        run_new_command(&state, &scope, resolved_removal(&rows[0].id), true).await;
        let paused = state_command(&state).await;
        assert_eq!(paused.status, CohostCommandStatus::Unavailable);
        assert_eq!(paused.message, "Removing messages is paused by Videorc.");
        assert!(no_operations(&state));
        assert_eq!(
            cohost_status(&state).await.command_availability,
            Some(CohostCommandAvailability {
                voice_commands: CohostSwitchState::On,
                remove: CohostSwitchState::Paused,
            })
        );
        set_orcle_flags(&state, "{}");

        // Chat moderation's own Premium check refuses: unavailable too.
        crate::live_chat_moderation::set_premium_check_for_tests(&state, Arc::new(|| false)).await;
        run_new_command(&state, &scope, resolved_removal(&rows[0].id), true).await;
        let premium = state_command(&state).await;
        assert_eq!(premium.status, CohostCommandStatus::Unavailable);
        assert_eq!(premium.message, "Golem requires Videorc Premium.");
        crate::live_chat_moderation::set_premium_check_for_tests(&state, Arc::new(|| true)).await;

        // The rate limit: ten removals a minute, then a plain refusal.
        for row in &rows[..crate::live_chat_moderation::RATE_LIMIT_PER_MINUTE] {
            crate::live_chat_moderation::request(
                &state,
                ModerationRequest {
                    operation_id: uuid::Uuid::new_v4().to_string(),
                    message_id: row.id.clone(),
                    source: ModerationSource::Manual,
                    reason: None,
                    confirm_mode: RemoveConfirmMode::Confirm,
                },
            )
            .await
            .unwrap();
        }
        run_new_command(&state, &scope, resolved_removal(&rows[10].id), true).await;
        let limited = state_command(&state).await;
        assert_eq!(limited.status, CohostCommandStatus::Refused);
        assert_eq!(
            limited.message,
            format!(
                "At most {} messages can be removed per minute.",
                crate::live_chat_moderation::RATE_LIMIT_PER_MINUTE
            )
        );
        let counts = state_counts(&state).await;
        assert_eq!(
            counts.failed, 1,
            "only the refusal counts, not the unavailable ones"
        );
        assert_eq!(counts.removed, 0, "manual removals are not commands");
    }

    #[tokio::test]
    async fn the_voice_kill_switch_stops_detection_and_every_command() {
        let rows = vec![command_row(1, "coders_x", StreamPlatform::Twitch, "hello")];
        let (state, scope) = command_state(&rows, None).await;
        set_orcle_flags(&state, r#"{"voiceCommands":false}"#);
        // Detection stops.
        assert!(
            detect_voice_command(
                &state,
                &caption_final(1),
                &spoken_final("Golem, highlight coders x.")
            )
            .is_none()
        );
        // A command already on its way is refused when it runs.
        run_detected_command(
            &state,
            &scope,
            detected(
                CommandKind::Highlight,
                named("coders x"),
                "highlight coders x",
                None,
            ),
            true,
        )
        .await;
        let refused = state_command(&state).await;
        assert_eq!(refused.status, CohostCommandStatus::Unavailable);
        assert_eq!(refused.message, "Voice commands are paused by Videorc.");
        assert!(
            state
                .cohost
                .lock()
                .await
                .snapshot()
                .auto_highlight
                .is_none()
        );
        assert_eq!(
            cohost_status(&state).await.command_availability,
            Some(CohostCommandAvailability {
                voice_commands: CohostSwitchState::Paused,
                remove: CohostSwitchState::On,
            })
        );
        // Back on: heard again, and the state stops saying paused.
        set_orcle_flags(&state, "{}");
        let (_, command) = detect_voice_command(
            &state,
            &caption_final(2),
            &spoken_final("Golem, highlight coders x."),
        )
        .unwrap();
        assert_eq!(command.kind, CommandKind::Highlight);
        assert_eq!(cohost_status(&state).await.command_availability, None);
    }

    #[tokio::test]
    async fn the_wake_word_setting_persists_and_reaches_the_detector() {
        let state = test_state();
        let settings = set_cohost_settings(
            &state,
            CohostSettingsPatch {
                wake_word_required: Some(true),
                remove_confirm: Some(RemoveConfirmMode::Countdown),
                ..CohostSettingsPatch::default()
            },
        )
        .await
        .unwrap();
        assert!(settings.wake_word_required);
        assert_eq!(settings.remove_confirm, RemoveConfirmMode::Countdown);
        assert_eq!(load_cohost_settings(&state.database), settings);
        assert!(
            state
                .cohost_commands
                .lock()
                .unwrap()
                .context
                .require_wake_word
        );
        // An armed session hears it: a structured phrase alone is nothing...
        arm_command_detector(&state, "session-1", 1, true);
        assert!(
            detect_voice_command(
                &state,
                &caption_final(1),
                &spoken_final("This one is toxic. Remove it from our chat.")
            )
            .is_none()
        );
        // ...with "Golem" first it is a command.
        let (session, command) = detect_voice_command(
            &state,
            &caption_final(2),
            &spoken_final("Golem, remove it from our chat."),
        )
        .unwrap();
        assert_eq!(session.session_id, "session-1");
        assert_eq!(command.kind, CommandKind::Remove);
        assert!(command.wake_word);
        // Without the setting the structured phrase works on its own.
        set_cohost_settings(
            &state,
            CohostSettingsPatch {
                wake_word_required: Some(false),
                ..CohostSettingsPatch::default()
            },
        )
        .await
        .unwrap();
        assert!(
            !state
                .cohost_commands
                .lock()
                .unwrap()
                .context
                .require_wake_word
        );
        let (_, command) = detect_voice_command(
            &state,
            &caption_final(3),
            &spoken_final("Highlight the comment from coders x."),
        )
        .unwrap();
        assert_eq!(command.kind, CommandKind::Highlight);
        assert!(!command.wake_word);
    }

    #[tokio::test]
    async fn an_unanswered_chooser_expires_and_nothing_happens() {
        let rows = vec![
            command_row(1, "coders_x", StreamPlatform::Twitch, "rust is great"),
            command_row(2, "coders_y", StreamPlatform::Twitch, "which editor?"),
        ];
        let (state, scope) = command_state(&rows, None).await;
        run_detected_command(
            &state,
            &scope,
            detected(
                CommandKind::Highlight,
                named("coders"),
                "highlight coders",
                None,
            ),
            true,
        )
        .await;
        let chooser = state_command(&state).await;
        assert_eq!(chooser.status, CohostCommandStatus::Ambiguous);
        assert!(
            state
                .cohost_commands
                .lock()
                .unwrap()
                .context
                .awaiting_choice
        );
        let expired = wait_for_command(&state, "the chooser to expire", |command| {
            command.status == CohostCommandStatus::Expired
        })
        .await;
        assert_eq!(expired.id, chooser.id);
        assert_eq!(expired.message, "No comment was picked.");
        assert_eq!(expired.expires_at, None);
        assert!(
            state
                .cohost
                .lock()
                .await
                .snapshot()
                .auto_highlight
                .is_none()
        );
        assert!(
            !state
                .cohost_commands
                .lock()
                .unwrap()
                .context
                .awaiting_choice
        );
        assert_eq!(state_counts(&state).await.expired, 1);
    }

    #[tokio::test]
    async fn a_session_boundary_cancels_an_open_voice_removal() {
        let rows = vec![command_row(
            1,
            "coders_x",
            StreamPlatform::Twitch,
            "spam link",
        )];
        let (state, scope) = command_state(&rows, fake_deletes()).await;
        run_new_command(&state, &scope, resolved_removal(&rows[0].id), true).await;
        let card = state_command(&state).await;
        let operation_id = card.operation_id.clone().unwrap();
        // Consent changed: listening restarts, and so does everything heard.
        let update = state.cohost.lock().await.update_consent(false).unwrap();
        assert_eq!(
            update.abandoned_removal.as_deref(),
            Some(operation_id.as_str())
        );
        clear_transcript(&state);
        wait_for_operation_phase(&state, &operation_id, ModerationPhase::Cancelled).await;
        let closed = wait_for_command(&state, "the card to close", |command| {
            command.status == CohostCommandStatus::Cancelled
        })
        .await;
        assert_eq!(closed.id, card.id);
        assert!(
            !state
                .live_chat
                .lock()
                .await
                .message(&rows[0].id)
                .unwrap()
                .is_deleted
        );
        assert_eq!(
            state_counts(&state).await.cancelled,
            0,
            "not the streamer's no"
        );
        let slot = state.cohost_commands.lock().unwrap();
        assert_eq!(slot.pending_operation, None);
        assert!(slot.session.is_none() && !slot.context.awaiting_answer);
    }

    #[tokio::test]
    async fn withdrawing_consent_cancels_a_pending_voice_removal() {
        let rows = vec![command_row(
            1,
            "coders_x",
            StreamPlatform::Twitch,
            "spam link",
        )];
        let (state, scope) = command_state(&rows, fake_deletes()).await;
        run_new_command(&state, &scope, resolved_removal(&rows[0].id), true).await;
        let operation_id = state_command(&state).await.operation_id.unwrap();
        let mut params = start_params(COMMAND_SESSION);
        params.consent_to_process_chat = false;
        start_cohost_if_entitled(&state, params, true)
            .await
            .expect("the consent change applies");
        wait_for_operation_phase(&state, &operation_id, ModerationPhase::Cancelled).await;
        assert!(
            !state
                .live_chat
                .lock()
                .await
                .message(&rows[0].id)
                .unwrap()
                .is_deleted
        );
    }

    /// The slot mirror is not the only record: a command step that rewrites
    /// it between the consent change and `clear_transcript` (here, a mirror
    /// after the card closed) must not leave the removal pending.
    #[tokio::test]
    async fn an_abandoned_removal_is_cancelled_even_when_the_mirror_moved_on() {
        let rows = vec![command_row(
            1,
            "coders_x",
            StreamPlatform::Twitch,
            "spam link",
        )];
        let (state, scope) = command_state(&rows, fake_deletes()).await;
        run_new_command(&state, &scope, resolved_removal(&rows[0].id), true).await;
        let operation_id = state_command(&state).await.operation_id.unwrap();
        let abandoned = {
            let mut engine = state.cohost.lock().await;
            let update = engine.update_consent(false).unwrap();
            // The race: a concurrent command step mirrors the closed card.
            mirror_command_slot(&state, &engine);
            update.abandoned_removal
        };
        assert_eq!(
            state.cohost_commands.lock().unwrap().pending_operation,
            None
        );
        clear_transcript(&state);
        cancel_abandoned_removal(&state, abandoned).await;
        let stored = state
            .database
            .get_chat_moderation_operation(&operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.phase, ModerationPhase::Cancelled);
        // Sign-out returns its removal the same way.
        let rows = vec![command_row(2, "ada", StreamPlatform::Twitch, "scam link")];
        let (state, scope) = command_state(&rows, fake_deletes()).await;
        run_new_command(&state, &scope, resolved_removal(&rows[0].id), true).await;
        let operation_id = state_command(&state).await.operation_id.unwrap();
        let abandoned = state
            .cohost
            .lock()
            .await
            .session
            .as_mut()
            .unwrap()
            .forget_speech();
        assert_eq!(abandoned.as_deref(), Some(operation_id.as_str()));
    }

    #[tokio::test]
    async fn orcle_says_it_did_not_catch_an_unclear_request_unless_a_card_is_open() {
        let rows = vec![
            command_row(1, "coders_x", StreamPlatform::Twitch, "rust is great"),
            command_row(2, "coders_y", StreamPlatform::Twitch, "which editor?"),
        ];
        let (state, scope) = command_state(&rows, None).await;
        let unclear = |wake_word: bool| DetectedCommand {
            kind: CommandKind::Unknown,
            target: CommandTarget::None,
            question: false,
            reason: None,
            heard: "what is the weather".to_string(),
            wake_word,
        };
        run_detected_command(&state, &scope, unclear(true), true).await;
        let unheard = state_command(&state).await;
        assert_eq!(
            (unheard.kind, unheard.status),
            (CohostCommandKind::Unknown, CohostCommandStatus::NotFound)
        );
        assert_eq!(
            unheard.message,
            "Golem didn't catch that: 'what is the weather'."
        );
        assert_eq!(state_counts(&state).await.not_found, 1);
        // Never without the wake word.
        run_detected_command(&state, &scope, unclear(false), true).await;
        assert_eq!(state_command(&state).await, unheard);
        // An open chooser stays open.
        run_detected_command(
            &state,
            &scope,
            detected(
                CommandKind::Highlight,
                named("coders"),
                "highlight coders",
                None,
            ),
            true,
        )
        .await;
        let chooser = state_command(&state).await;
        run_detected_command(&state, &scope, unclear(true), true).await;
        assert_eq!(state_command(&state).await, chooser);
        assert_eq!(state_counts(&state).await.not_found, 1);
    }

    #[tokio::test]
    async fn command_answers_need_the_open_card() {
        let empty = test_state();
        assert_eq!(
            confirm_command(
                &empty,
                CohostCommandParams {
                    command_id: "cmd-1".to_string()
                }
            )
            .await
            .unwrap_err()
            .code,
            "not-pending"
        );
        assert_eq!(
            cancel_command(
                &empty,
                CohostCommandParams {
                    command_id: "  ".to_string()
                }
            )
            .await
            .unwrap_err()
            .code,
            "invalid-params"
        );
        let rows = vec![
            command_row(1, "coders_x", StreamPlatform::Twitch, "rust is great"),
            command_row(2, "coders_y", StreamPlatform::Twitch, "which editor?"),
        ];
        let (state, scope) = command_state(&rows, fake_deletes()).await;
        run_detected_command(
            &state,
            &scope,
            detected(CommandKind::Remove, named("coders"), "remove coders", None),
            true,
        )
        .await;
        let chooser = state_command(&state).await;
        assert_eq!(chooser.status, CohostCommandStatus::Ambiguous);
        // A stale id, an answer the card does not take, a pick past the list.
        assert_eq!(
            choose_command(
                &state,
                CohostCommandChooseParams {
                    command_id: "cmd-stale".to_string(),
                    index: 0
                }
            )
            .await
            .unwrap_err()
            .code,
            "not-pending"
        );
        assert_eq!(
            confirm_command(
                &state,
                CohostCommandParams {
                    command_id: chooser.id.clone()
                }
            )
            .await
            .unwrap_err()
            .code,
            "not-pending"
        );
        assert_eq!(
            choose_command(
                &state,
                CohostCommandChooseParams {
                    command_id: chooser.id.clone(),
                    index: 2
                }
            )
            .await
            .unwrap_err()
            .code,
            "invalid-params"
        );
        // A pick opens the removal card, and the RPC returns it.
        let opened = answer_command_with(
            &state,
            None,
            Some(chooser.id.as_str()),
            CommandAnswer::Choose(1),
            true,
            true,
        )
        .await
        .unwrap()
        .command
        .unwrap();
        assert_eq!(opened.id, chooser.id);
        assert_eq!(opened.status, CohostCommandStatus::Confirm);
        assert_eq!(opened.target.as_ref().unwrap().author_name, "coders_x");
        assert!(opened.operation_id.is_some());
        // Yes through the RPC: it returns at once, the removal follows.
        let answered = answer_command_with(
            &state,
            None,
            Some(opened.id.as_str()),
            CommandAnswer::Confirm,
            true,
            true,
        )
        .await
        .unwrap()
        .command
        .unwrap();
        assert_eq!(answered.id, opened.id);
        assert!(
            matches!(
                answered.status,
                CohostCommandStatus::Confirm | CohostCommandStatus::Done
            ),
            "{answered:?}"
        );
        let removed = wait_for_command(&state, "the removal", |command| {
            command.status == CohostCommandStatus::Done
        })
        .await;
        assert_eq!(removed.message, "Removed coders_x's comment from Twitch.");
        // Answered: the same id is no longer pending.
        assert_eq!(
            cancel_command(
                &state,
                CohostCommandParams {
                    command_id: opened.id.clone()
                }
            )
            .await
            .unwrap_err()
            .code,
            "not-pending"
        );
    }

    // --- Cloud command parser (plan 140 S8) ----------------------------------

    fn parse_request(seq: u64, ids: &[&str]) -> CohostCommandRequest {
        CohostCommandRequest::shaped(
            "videorc-desktop/test",
            COMMAND_SESSION,
            seq,
            "orcle show what they just asked",
            None,
            ids.iter()
                .map(|id| CohostCommandCandidate {
                    id: id.to_string(),
                    author: "viewer".to_string(),
                    text: "a comment".to_string(),
                    at: "2026-10-04T12:00:00Z".to_string(),
                })
                .collect(),
        )
        .expect("a request")
    }

    fn parse_answer(
        seq: u64,
        choice: &str,
        confidence: f64,
        targets: &[(&str, f64)],
    ) -> CohostCommandResponse {
        let mut probabilities =
            serde_json::json!({ "highlight": 0.0, "remove": 0.0, "clear": 0.0, "none": 0.0 });
        probabilities[choice] = serde_json::json!(confidence);
        serde_json::from_value(serde_json::json!({
            "seq": seq,
            "intent": { "choice": choice, "probabilities": probabilities },
            "targets": targets
                .iter()
                .map(|(id, probability)| serde_json::json!({ "messageId": id, "probability": probability }))
                .collect::<Vec<_>>(),
            "usage": { "inputTokens": 310, "model": "jev", "outputTokens": 6 }
        }))
        .unwrap()
    }

    #[test]
    fn the_cloud_parser_acts_only_at_the_desktop_thresholds() {
        let request = parse_request(7, &["m1", "m2", "m3", "m4", "m5"]);
        let ids = |ids: &[&str]| ids.iter().map(|id| id.to_string()).collect::<Vec<_>>();
        // One likely comment acts.
        assert_eq!(
            interpret_command_parse(
                &request,
                &parse_answer(7, "highlight", 0.9, &[("m1", 0.88), ("m2", 0.2)])
            ),
            Some((CommandKind::Highlight, ids(&["m1"])))
        );
        // Several open the chooser: likeliest first, at most three.
        assert_eq!(
            interpret_command_parse(
                &request,
                &parse_answer(
                    7,
                    "remove",
                    COMMAND_PARSE_INTENT_THRESHOLD,
                    &[("m1", 0.8), ("m2", 0.95), ("m3", 0.75), ("m4", 0.9)]
                )
            ),
            Some((CommandKind::Remove, ids(&["m2", "m4", "m1"])))
        );
        assert_eq!(
            interpret_command_parse(
                &request,
                &parse_answer(7, "remove", 0.8, &[("m3", 0.8), ("m5", 0.8)])
            ),
            Some((CommandKind::Remove, ids(&["m3", "m5"]))),
            "ties keep the answer's order"
        );
        // A clear needs no comment.
        assert_eq!(
            interpret_command_parse(&request, &parse_answer(7, "clear", 0.8, &[])),
            Some((CommandKind::Clear, Vec::new()))
        );
        // A repeated target counts once.
        assert_eq!(
            interpret_command_parse(
                &request,
                &parse_answer(7, "highlight", 0.9, &[("m1", 0.9), ("m1", 0.8)])
            ),
            Some((CommandKind::Highlight, ids(&["m1"])))
        );
        // Doubt is "didn't catch that".
        for (answer, why) in [
            (
                parse_answer(7, "highlight", 0.69, &[("m1", 0.99)]),
                "an unsure intent",
            ),
            (parse_answer(7, "none", 0.99, &[("m1", 0.99)]), "none"),
            (
                parse_answer(7, "highlight", 0.9, &[("m1", 0.74)]),
                "no comment at the target threshold",
            ),
            (
                parse_answer(7, "remove", 0.9, &[]),
                "a removal without a comment",
            ),
            (
                parse_answer(7, "highlight", 0.9, &[("elsewhere", 0.99)]),
                "a comment Golem never sent",
            ),
            (
                parse_answer(8, "highlight", 0.9, &[("m1", 0.9)]),
                "another seq",
            ),
            (
                parse_answer(7, "dance", 0.99, &[("m1", 0.9)]),
                "a choice this build does not know",
            ),
            (CohostCommandResponse::default(), "an empty answer"),
        ] {
            assert_eq!(interpret_command_parse(&request, &answer), None, "{why}");
        }
        assert_eq!(COMMAND_PARSE_INTENT_THRESHOLD, 0.7);
        assert_eq!(COMMAND_PARSE_TARGET_THRESHOLD, 0.75);
    }

    #[test]
    fn a_429_pauses_the_cloud_parser_until_retry_after_and_a_slow_answer_does_not() {
        use crate::videorc_api::classify_cohost_failure;
        let failure = |status: u16, code: &str, retry_after: Option<&str>| {
            classify_cohost_failure(status, code, "no".to_string(), retry_after)
        };
        assert_eq!(
            command_parse_pause(&failure(429, "quota-exhausted", Some("120"))),
            Some(Duration::from_secs(120))
        );
        assert_eq!(
            command_parse_pause(&failure(429, "quota-exhausted", None)),
            Some(COMMAND_PARSE_QUOTA_PAUSE)
        );
        assert_eq!(
            command_parse_pause(&failure(429, "quota-exhausted", Some("99999999"))),
            Some(COMMAND_PARSE_MAX_PAUSE)
        );
        for (status, code) in [
            (503, "command-disabled"),
            (503, "judge-unconfigured"),
            (503, "ai-gateway-not-configured"),
            (403, "premium-required"),
            (403, "ai-user-disabled"),
        ] {
            assert_eq!(
                command_parse_pause(&failure(status, code, None)),
                Some(COMMAND_PARSE_UNAVAILABLE_PAUSE),
                "{code}"
            );
        }
        for error in [
            failure(504, "judge-timeout", None),
            failure(502, "ai-gateway-error", None),
            CohostApiError::timeout("slow"),
            CohostApiError::network("down"),
            CohostApiError::malformed_response(200, "odd"),
        ] {
            assert_eq!(command_parse_pause(&error), None, "{}", error.detail.code);
        }
    }

    #[test]
    fn the_cloud_parser_is_off_by_default_and_one_call_at_a_time_when_on() {
        let rows = vec![
            command_row(1, "coders_x", StreamPlatform::Twitch, "rust is great"),
            command_row(2, "ada", StreamPlatform::Twitch, "which editor?"),
        ];
        let now = Instant::now();
        let mut engine = CohostEngine::new(enabled_settings());
        let generation = engine.start_session(COMMAND_SESSION.to_string(), true, None, now);
        engine.note_messages(&rows);
        let scope = CommandSession {
            session_id: COMMAND_SESSION.to_string(),
            generation,
        };
        let heard = "  orcle show what ada asked ";
        // Off until the capability read says otherwise.
        assert!(!engine.command_parser_ready(&scope, true, true, now));
        assert_eq!(
            engine.prepare_command_parse(&scope, heard, None, true, true, now),
            None
        );
        engine.set_command_parser_enabled(true);
        assert!(
            !engine.command_parser_ready(&scope, false, true, now),
            "Basic"
        );
        assert!(
            !engine.command_parser_ready(&scope, true, false, now),
            "the voice kill switch"
        );
        let stale = CommandSession {
            session_id: COMMAND_SESSION.to_string(),
            generation: generation + 1,
        };
        assert!(!engine.command_parser_ready(&stale, true, true, now));

        let prepared = engine
            .prepare_command_parse(&scope, heard, None, true, true, now)
            .expect("a parse");
        let request = &prepared.request;
        assert_eq!(request.seq, 1);
        assert_eq!(request.utterance, "orcle show what ada asked");
        assert!(request.consent_to_process_chat);
        assert_eq!(request.session_client_id, COMMAND_SESSION);
        assert_eq!(
            request
                .candidates
                .iter()
                .map(|candidate| candidate.id.as_str())
                .collect::<Vec<_>>(),
            vec![rows[1].id.as_str(), rows[0].id.as_str()],
            "newest first"
        );
        assert_eq!(request.candidates[0].author, "ada");
        assert_eq!(request.candidates[0].text, "which editor?");
        assert_eq!(request.focus_message_id, None);
        assert_eq!(request.validate(), Ok(()));

        // One in flight at a time, then the gap.
        assert!(!engine.command_parser_ready(&scope, true, true, now + Duration::from_secs(5)));
        let slow: Result<CohostCommandResponse, CohostApiError> =
            Err(CohostApiError::timeout("slow"));
        assert!(engine.finish_command_parse(
            &scope,
            &prepared,
            &slow,
            now + Duration::from_millis(2_500)
        ));
        assert!(!engine.command_parser_ready(&scope, true, true, now + Duration::from_secs(2)));
        assert!(engine.command_parser_ready(&scope, true, true, now + COMMAND_PARSE_MIN_GAP));

        // The comment on stream is "this one" without a spotlight.
        let later = now + COMMAND_PARSE_MIN_GAP;
        let prepared = engine
            .prepare_command_parse(
                &scope,
                "orcle that one",
                Some(rows[0].id.as_str()),
                true,
                true,
                later,
            )
            .expect("a second parse");
        assert_eq!(prepared.request.seq, 2);
        assert_eq!(
            prepared.request.focus_message_id.as_deref(),
            Some(rows[0].id.as_str())
        );
        // A 429 waits for Retry-After.
        let quota: Result<CohostCommandResponse, CohostApiError> =
            Err(crate::videorc_api::classify_cohost_failure(
                429,
                "quota-exhausted",
                "Daily limit".to_string(),
                Some("120"),
            ));
        engine.finish_command_parse(&scope, &prepared, &quota, later);
        assert!(!engine.command_parser_ready(&scope, true, true, later + Duration::from_secs(60)));
        assert!(engine.command_parser_ready(&scope, true, true, later + Duration::from_secs(120)));

        // Turned off again (or no consent): nothing.
        engine.set_command_parser_enabled(false);
        assert!(!engine.command_parser_ready(&scope, true, true, later + Duration::from_secs(600)));
        engine.set_command_parser_enabled(true);
        engine.session.as_mut().unwrap().consent = false;
        assert!(!engine.command_parser_ready(&scope, true, true, later + Duration::from_secs(600)));
    }

    #[tokio::test]
    async fn the_cloud_parser_resolves_a_paraphrase_and_falls_back_on_any_failure() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let rows = vec![
            command_row(
                1,
                "coders_x",
                StreamPlatform::Twitch,
                "how do lifetimes work?",
            ),
            command_row(2, "ada", StreamPlatform::Twitch, "hello"),
        ];
        let (state, scope) = command_state(&rows, None).await;
        let heard = "orcle show what coders x just asked";
        let tokens = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let token = {
            let tokens = tokens.clone();
            move || -> Option<String> {
                tokens.fetch_add(1, Ordering::SeqCst);
                Some("bearer".to_string())
            }
        };
        let failing = |error: CohostApiError| {
            let calls = calls.clone();
            move |_token: String, _request: CohostCommandRequest| {
                calls.fetch_add(1, Ordering::SeqCst);
                async move { Err::<CohostCommandResponse, CohostApiError>(error) }
            }
        };

        // Capability off (the default): no token read, nothing sent.
        assert_eq!(
            resolve_unknown_command_with(
                &state,
                &scope,
                heard,
                true,
                token.clone(),
                failing(CohostApiError::network("never"))
            )
            .await,
            UnknownCommandResolution::Unheard
        );
        assert_eq!(tokens.load(Ordering::SeqCst), 0);
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        // On: the paraphrase resolves to coders_x's comment.
        set_command_parser_capability(&state, true).await;
        let sent = Arc::new(std::sync::Mutex::new(None::<CohostCommandRequest>));
        let resolution =
            resolve_unknown_command_with(&state, &scope, heard, true, token.clone(), {
                let sent = sent.clone();
                move |bearer: String, request: CohostCommandRequest| {
                    assert_eq!(bearer, "bearer");
                    let target = request
                        .candidates
                        .iter()
                        .find(|candidate| candidate.author == "coders_x")
                        .map(|candidate| candidate.id.clone())
                        .unwrap();
                    let response =
                        parse_answer(request.seq, "highlight", 0.91, &[(target.as_str(), 0.88)]);
                    *sent.lock().unwrap() = Some(request);
                    async move { Ok::<CohostCommandResponse, CohostApiError>(response) }
                }
            })
            .await;
        assert_eq!(
            resolution,
            UnknownCommandResolution::Resolved(CommandKind::Highlight, vec![rows[0].id.clone()])
        );
        let request = sent.lock().unwrap().clone().expect("one request");
        assert_eq!(request.utterance, heard);
        assert_eq!(request.candidates.len(), 2);
        assert!(!state.cohost.lock().await.command_parser.in_flight);

        // A timeout and an error envelope are "didn't catch that", never a retry.
        for error in [
            CohostApiError::timeout("Golem did not answer within 2 s."),
            crate::videorc_api::classify_cohost_failure(
                504,
                "judge-timeout",
                "slow".to_string(),
                None,
            ),
        ] {
            state.cohost.lock().await.command_parser.last_call_at = None;
            let before = calls.load(Ordering::SeqCst);
            assert_eq!(
                resolve_unknown_command_with(
                    &state,
                    &scope,
                    heard,
                    true,
                    token.clone(),
                    failing(error)
                )
                .await,
                UnknownCommandResolution::Unheard
            );
            assert_eq!(calls.load(Ordering::SeqCst), before + 1, "exactly one call");
        }

        // A 429 pauses the parser: the next utterance is not sent.
        state.cohost.lock().await.command_parser.last_call_at = None;
        let quota = crate::videorc_api::classify_cohost_failure(
            429,
            "quota-exhausted",
            "Daily limit".to_string(),
            Some("600"),
        );
        assert_eq!(
            resolve_unknown_command_with(
                &state,
                &scope,
                heard,
                true,
                token.clone(),
                failing(quota)
            )
            .await,
            UnknownCommandResolution::Unheard
        );
        state.cohost.lock().await.command_parser.last_call_at = None;
        let before = calls.load(Ordering::SeqCst);
        assert_eq!(
            resolve_unknown_command_with(
                &state,
                &scope,
                heard,
                true,
                token.clone(),
                failing(CohostApiError::network("never"))
            )
            .await,
            UnknownCommandResolution::Unheard
        );
        assert_eq!(calls.load(Ordering::SeqCst), before, "paused");
    }

    #[tokio::test]
    async fn a_parsed_command_never_replaces_a_command_heard_while_it_was_out() {
        let rows = vec![
            command_row(
                1,
                "coders_x",
                StreamPlatform::Twitch,
                "this stream is trash",
            ),
            command_row(2, "ada", StreamPlatform::Twitch, "hello"),
        ];
        let (state, scope) = command_state(&rows, None).await;
        set_command_parser_capability(&state, true).await;
        let inner_state = state.clone();
        let inner_scope = scope.clone();
        let resolution = resolve_unknown_command_with(
            &state,
            &scope,
            "orcle get rid of that nonsense",
            true,
            || Some("bearer".to_string()),
            move |_token: String, request: CohostCommandRequest| {
                let response = parse_answer(
                    request.seq,
                    "remove",
                    0.95,
                    &[(request.candidates[0].id.as_str(), 0.95)],
                );
                async move {
                    // The streamer moved on while the parser thought.
                    run_detected_command(
                        &inner_state,
                        &inner_scope,
                        detected(
                            CommandKind::Highlight,
                            CommandTarget::Last,
                            "highlight the last comment",
                            None,
                        ),
                        true,
                    )
                    .await;
                    Ok::<CohostCommandResponse, CohostApiError>(response)
                }
            },
        )
        .await;
        assert_eq!(resolution, UnknownCommandResolution::Superseded);
        assert_eq!(
            state_command(&state).await.kind,
            CohostCommandKind::Highlight
        );
    }
}
