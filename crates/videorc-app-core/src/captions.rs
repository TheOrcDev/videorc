//! The Captions page and the Captions reader (plan 260 Phase 3, L2): their
//! words, the caption lines and the rule that starts and stops captions
//! with a session, as Electron has them in `lib/captions-page-view.ts`,
//! `lib/captions-ui.ts`, `lib/caption-languages.ts`,
//! `lib/caption-overlay.ts`'s style table and `lib/state-labels.ts`. The
//! GPUI screens (`apps/videorc/src/screens/captions`) draw these.
//!
//! The Go Live rules (fps, one stream quality, Linux) stay in
//! [`crate::livestream::captions_preflight`]; this module reads them.

pub mod overlay;

use serde::Deserialize;
use serde_json::Value;

use crate::account::entitlements::EntitlementGate;
use crate::livestream::captions_preflight::{self as preflight, BurnTarget};
use crate::livestream::plan;

// --- the words ---

/// The page's section title and the switch's label.
pub const LIVE_CAPTIONS: &str = "Live captions";
/// The Captions page's one line (owner, 2026-11-20).
pub const PANEL_DESCRIPTION: &str = "Turn on Live captions to put what you say on your livestream, in every scene. On a livestream, captions need 30 fps or less, and one stream quality when you also record.";
/// The switch's line while it is off.
pub const OFF_HINT: &str = "Puts captions on your livestream. Your microphone is transcribed only while you record or go live.";
pub const RETRY: &str = "Retry";
pub const ROOM_TITLE: &str = "Host microphone only";
pub const ROOM_DESCRIPTION: &str = "Captions and Sidekick hear your published microphone. Muting it stops speech uploads. Guests and soundboard audio are excluded. Cloud caption timing and program delivery have not been qualified.";
pub const BLOCKER_TITLE: &str = "Captions can't go out on your next livestream";
pub const OUTPUTS_LABEL: &str = "Show captions on";
/// `SESSION_LOCK_REASON`: a session keeps the outputs and language it
/// started with.
pub const SESSION_LOCK_REASON: &str =
    "Locked while you're recording or live. Changes apply the next time you record or go live.";
pub const MICROPHONE: &str = "Microphone";
pub const PLACEMENT: &str = "Placement";
pub const ALLOWANCE: &str = "Allowance";
pub const ELSEWHERE_LABEL: &str = "Captions on other pages";
pub const STYLE: &str = "Style";
pub const STYLE_DESCRIPTION: &str = "Appearance updates live without restarting captions.";
pub const STYLE_LABEL: &str = "Caption style";
/// The words on each Style chip's swatch.
pub const STYLE_SAMPLE: &str = "Make every word count";
pub const TEXT_SIZE: &str = "Text size";
pub const TEXT_SIZE_LABEL: &str = "Caption text size";
pub const LANGUAGE: &str = "Spoken language";
pub const LANGUAGE_HINT: &str = "Auto-detect works for most conversations.";
pub const LISTENING: &str = "Listening…";
pub const PRIVACY_NOTE: &str = "When Live captions is on, Videorc sends your microphone audio to its transcription service only while you record or go live.";
/// The reader window's name (`WINDOW_NAMES.captions`).
pub const READER_NAME: &str = "Captions reader";
pub const PREVIEW_TITLE: &str = "Caption preview";
pub const PREVIEW_DESCRIPTION: &str = "The selected style at your current video aspect ratio.";
pub const PREVIEW_SAMPLE_BADGE: &str = "Sample";
pub const PREVIEW_LATEST_BADGE: &str = "Latest caption";
pub const PREVIEW_BACKGROUND: &str = "Preview background";
/// What the preview shows before a caption has arrived.
pub const PREVIEW_SAMPLE: &str = "Your words become clear, live captions.";
/// The longest side the backend draws a page sample at
/// (`captions.preview.render`'s contract).
pub const PREVIEW_MAX_SIDE: u32 = 4096;
pub const TRANSCRIPT_TITLE: &str = "Host transcript";
pub const TRANSCRIPT_NOTE: &str = "Saved on this computer. Times follow each processed microphone source; alignment with the cloud recording is unmeasured.";
pub const TRANSCRIPT_REFRESH: &str = "Refresh transcript";
pub const TRANSCRIPT_FAILED: &str = "The host transcript is unavailable for this room.";
pub const TRANSCRIPT_LABEL: &str = "Saved host transcript";
/// Electron's Microphone row when no microphone is chosen, and when the
/// chosen one is gone.
pub const MICROPHONE_OFF: &str = "Off";
pub const MICROPHONE_MISSING: &str = "Not connected";

/// The backend's methods and events the page and the reader use.
pub mod methods {
    pub const START: &str = "captions.start";
    pub const STOP: &str = "captions.stop";
    pub const STYLE_SET: &str = "captions.style.set";
    pub const PREVIEW_RENDER: &str = "captions.preview.render";
    pub const TRANSCRIPT: &str = "cloud.speech.transcript";
    pub const ENTITLEMENTS_GET: &str = "entitlements.get";
    pub const OVERLAY_LAYOUT_GET: &str = "overlays.layout.get";
    /// The streamer moved the captions in Scene.
    pub const OVERLAY_LAYOUT_EVENT: &str = "overlays.layout";
    /// The bar on one compositor target, drawn by the backend from the text.
    pub const OVERLAY_SET: &str = "captions.overlay.set";
    pub const OVERLAY_CLEAR: &str = "captions.overlay.clear";
    /// The bar while a talk-show room is open.
    pub const ROOM_OVERLAY: &str = "cloud.speech.overlay";
    pub const UPDATE_EVENT: &str = "captions.update";
    pub const CLEARED_EVENT: &str = "captions.cleared";
    pub const ENTITLEMENTS_EVENT: &str = "entitlements.updated";
}

/// `CAPTION_LANGUAGES`: what `update_settings` accepts too.
pub const LANGUAGES: &[(&str, &str)] = &[
    ("auto", "Auto-detect"),
    ("en", "English"),
    ("es", "Spanish"),
    ("fr", "French"),
    ("de", "German"),
    ("pt", "Portuguese"),
    ("it", "Italian"),
];

/// One caption look from `CAPTION_STYLE_DEFINITIONS`: what the page shows
/// of it. The pixels are the backend's (`overlay_raster::caption`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptionStyle {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
}

pub const STYLES: &[CaptionStyle] = &[
    CaptionStyle {
        id: "classic",
        label: "Classic",
        description: "Clean outlined subtitles that stay legible over any video.",
    },
    CaptionStyle {
        id: "glass",
        label: "Glass",
        description: "Videorc black glass with a polished edge and soft elevation.",
    },
    CaptionStyle {
        id: "lower-third",
        label: "Lower third",
        description: "A wide, left-aligned broadcast band for conversations.",
    },
    CaptionStyle {
        id: "high-contrast",
        label: "High contrast",
        description: "Opaque black and bold white for maximum readability.",
    },
];

/// A style by id; an unknown id reads as Glass, as the preview's label does.
pub fn style(id: &str) -> CaptionStyle {
    STYLES
        .iter()
        .copied()
        .find(|style| style.id == id)
        .unwrap_or(STYLES[1])
}

pub const TEXT_SIZES: &[(&str, &str)] = &[("s", "Small"), ("m", "Medium"), ("l", "Large")];

/// `CAPTIONS_OUTPUT_OPTIONS`.
pub const OUTPUT_OPTIONS: &[(&str, &str)] = &[
    ("stream", "Live stream only"),
    ("both", "Live stream and recording"),
];

/// The preview's stand-in backdrops: content, not chrome.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PreviewBackdrop {
    Dark,
    Light,
    #[default]
    Mixed,
}

impl PreviewBackdrop {
    pub const ALL: [PreviewBackdrop; 3] = [Self::Dark, Self::Light, Self::Mixed];

    pub fn id(self) -> &'static str {
        match self {
            Self::Dark => "dark",
            Self::Light => "light",
            Self::Mixed => "motion",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Dark => "Dark",
            Self::Light => "Light",
            Self::Mixed => "Mixed",
        }
    }

    pub fn parse(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|backdrop| backdrop.id() == id)
    }
}

/// `captionsOutputsDescription`: a vertical destination shares the
/// recording's picture with the horizontal stream (plan 077).
pub fn outputs_description(outputs: &str, vertical_leg_armed: bool) -> &'static str {
    if vertical_leg_armed {
        return "A vertical destination shares the recording picture with the horizontal stream, so captions on stream are in the recording too.";
    }
    if outputs == "both" {
        "Your recording also gets a copy with captions."
    } else {
        "Your recording stays clean."
    }
}

// --- the status ---

/// `CaptionsStatus`, as much of it as the page and the reader read.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Status {
    pub state: String,
    pub message: Option<String>,
    pub reason_code: Option<String>,
    pub desired_enabled: Option<bool>,
    pub remaining_seconds: Option<f64>,
}

impl Status {
    /// The Studio's `captions_status`; idle until it is read.
    pub fn of(value: Option<&Value>) -> Self {
        let mut status = value
            .and_then(|value| serde_json::from_value::<Status>(value.clone()).ok())
            .unwrap_or_default();
        if status.state.is_empty() {
            status.state = "idle".into();
        }
        status
    }

    /// `captionsStatusIsActive`.
    pub fn is_active(&self) -> bool {
        matches!(
            self.state.as_str(),
            "starting" | "listening" | "reconnecting" | "degraded" | "live"
        )
    }

    /// `captionsEnabled`: the switch when given, else what the backend says.
    fn enabled(&self, enabled: Option<bool>) -> bool {
        enabled
            .or(self.desired_enabled)
            .unwrap_or(self.state != "idle")
    }

    /// `captionsStatusLabel`: the same word on the page and in the reader.
    pub fn label(&self, enabled: Option<bool>, session_active: bool) -> &'static str {
        if !self.enabled(enabled) {
            return "Off";
        }
        match self.state.as_str() {
            "starting" => "Starting…",
            "listening" | "live" => "Listening",
            "reconnecting" => "Reconnecting…",
            "degraded" if self.reason_code.as_deref() == Some("service-unavailable") => "Paused",
            "degraded" => "Higher delay",
            "blocked" => "Blocked",
            "error" => "Failed",
            "ready" => "Ready",
            _ if session_active => "Waiting…",
            _ => "Ready",
        }
    }

    /// `captionsStatusTone`.
    pub fn tone(&self, enabled: Option<bool>) -> Tone {
        if !self.enabled(enabled) {
            return Tone::Neutral;
        }
        match self.state.as_str() {
            "listening" | "live" => Tone::Good,
            "reconnecting" | "degraded" => Tone::Warn,
            "blocked" | "error" => Tone::Error,
            _ => Tone::Neutral,
        }
    }

    /// `captionsStatusDetail`: the line under the word while captions are on.
    pub fn detail(&self, session_active: bool) -> String {
        let message = |fallback: &str| self.message.clone().unwrap_or_else(|| fallback.into());
        match self.state.as_str() {
            "starting" => "Connecting to transcription…".into(),
            "listening" | "live" => "Your microphone is being transcribed.".into(),
            "reconnecting" => "Trying to restore live captions.".into(),
            "degraded" => message("Captions are continuing in 3-second chunks."),
            "blocked" => message("Captions need attention before they can start."),
            "error" => message("Captions stopped unexpectedly."),
            "ready" if session_active => "Ready to listen to your microphone.".into(),
            "ready" => "Starts with your next recording or livestream.".into(),
            _ if session_active => "Waiting for the caption service.".into(),
            _ => "Starts with your next recording or livestream.".into(),
        }
    }

    /// `captionsAllowanceLabel`: the month's caption minutes, or none until
    /// they are known.
    pub fn allowance(&self) -> Option<String> {
        let seconds = self.remaining_seconds.filter(|s| s.is_finite())?;
        let minutes = (seconds / 60.0).ceil().max(0.0) as i64;
        Some(format!(
            "{} min left this month",
            crate::format::grouped(minutes)
        ))
    }
}

/// A status word's tone, for the kit's status dot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Neutral,
    Good,
    Warn,
    Error,
}

/// What the reader says instead of, or above, the captions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReaderNotice {
    pub text: String,
    /// A failure: shown even over earlier lines, read as an alert.
    pub failed: bool,
}

/// `captionsReaderNotice`.
pub fn reader_notice(status: &Status, line_count: usize) -> Option<ReaderNotice> {
    let notice = |text: String, failed: bool| Some(ReaderNotice { text, failed });
    if status.reason_code.as_deref() == Some("service-unavailable") || status.state == "blocked" {
        return notice(
            status.message.clone().unwrap_or_else(|| {
                "Captions need attention before they can start. Open Captions.".into()
            }),
            true,
        );
    }
    if status.state == "error" {
        return notice(
            status.message.clone().unwrap_or_else(|| {
                "Captions stopped unexpectedly. Open Captions to try again.".into()
            }),
            true,
        );
    }
    if line_count > 0 {
        return None;
    }
    let waiting = "Captions show here when you record or go live.";
    match status.state.as_str() {
        "idle" if status.desired_enabled == Some(true) => notice(waiting.into(), false),
        "idle" => notice(
            "Live captions are off. Turn them on in Captions, then record or go live.".into(),
            false,
        ),
        "ready" => notice(waiting.into(), false),
        "starting" => notice("Starting captions…".into(), false),
        "reconnecting" => notice("Reconnecting captions…".into(), false),
        "degraded" => notice(
            status
                .message
                .clone()
                .unwrap_or_else(|| "Captions are continuing in 3-second chunks.".into()),
            false,
        ),
        _ => notice(LISTENING.into(), false),
    }
}

// --- the lines ---

/// `CaptionsUpdate`: one line as the backend sends it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionLine {
    pub session_client_id: String,
    pub seq: u64,
    /// `partial` replaces the same seq; `final` (or none) is settled.
    #[serde(default)]
    pub kind: Option<String>,
    pub text: String,
}

impl CaptionLine {
    pub fn is_partial(&self) -> bool {
        self.kind.as_deref() == Some("partial")
    }

    /// `captionLineIdentity`, for element ids.
    pub fn identity(&self) -> String {
        format!("{}:{}", self.session_client_id, self.seq)
    }
}

/// Lines kept for the page's strip and the reader.
pub const MAX_LINES: usize = 50;
/// The page's strip shows the last three.
pub const STRIP_LINES: usize = 3;
/// The reader shows the last eight.
pub const READER_LINES: usize = 8;

/// The caption lines the page and the reader share: `appendCaptionLine`
/// with the session floor (`captionLineAboveFloor`), so a previous video's
/// late line never shows in the next one.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Lines {
    lines: Vec<CaptionLine>,
    floor: Option<(String, u64)>,
}

impl Lines {
    pub fn all(&self) -> &[CaptionLine] {
        &self.lines
    }

    pub fn tail(&self, count: usize) -> &[CaptionLine] {
        &self.lines[self.lines.len().saturating_sub(count)..]
    }

    pub fn latest(&self) -> Option<&CaptionLine> {
        self.lines.last()
    }

    /// `latestFinalCaptionText`: screen readers hear settled lines only.
    pub fn latest_final(&self) -> Option<&str> {
        self.lines
            .iter()
            .rev()
            .find(|line| !line.is_partial())
            .map(|line| line.text.as_str())
    }

    /// `captions.update`. True when the lines changed.
    pub fn apply_update(&mut self, payload: &Value) -> bool {
        let Ok(line) = serde_json::from_value::<CaptionLine>(payload.clone()) else {
            return false;
        };
        if let Some((session, seq)) = &self.floor
            && *session == line.session_client_id
            && line.seq <= *seq
        {
            return false;
        }
        self.append(line)
    }

    fn append(&mut self, line: CaptionLine) -> bool {
        if line.text.trim().is_empty() {
            return false;
        }
        match self.lines.last() {
            Some(last) if last.session_client_id != line.session_client_id => {
                self.lines = vec![line];
            }
            Some(last) if last.seq == line.seq => {
                *self.lines.last_mut().expect("a last line") = line;
            }
            Some(last) if line.seq < last.seq => return false,
            _ => {
                self.lines.push(line);
                let extra = self.lines.len().saturating_sub(MAX_LINES);
                self.lines.drain(..extra);
            }
        }
        true
    }

    /// `captions.cleared`.
    pub fn clear(&mut self) -> bool {
        self.floor = None;
        let had = !self.lines.is_empty();
        self.lines.clear();
        had
    }

    /// A capture session's rising edge: the lines start empty and nothing
    /// at or below the last line seen may come back.
    pub fn session_started(&mut self) -> bool {
        if let Some(last) = self.lines.last() {
            self.floor = Some((last.session_client_id.clone(), last.seq));
        }
        let had = !self.lines.is_empty();
        self.lines.clear();
        had
    }
}

// --- the runtime rule ---

/// `decideCaptionsRuntimeIntent`'s answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeIntent {
    Start,
    Stop,
    None,
}

/// `decideCaptionsRuntimeIntent`: the stored switch against the backend's
/// intent. One attempt per toggle, session and connection, so a blocked
/// provider never spins.
pub fn runtime_intent(
    persisted_enabled: bool,
    suppress_for_session: bool,
    capture_active: bool,
    status: &Status,
    start_attempted: bool,
    stop_attempted: bool,
) -> RuntimeIntent {
    let should_enable = persisted_enabled && !suppress_for_session;
    let backend_has_intent = status.state != "idle" || status.desired_enabled == Some(true);
    if !should_enable {
        return if backend_has_intent && !stop_attempted {
            RuntimeIntent::Stop
        } else {
            RuntimeIntent::None
        };
    }
    if status.is_active() {
        return RuntimeIntent::None;
    }
    if status.state == "ready" && status.desired_enabled != Some(false) && !capture_active {
        return RuntimeIntent::None;
    }
    if start_attempted {
        RuntimeIntent::None
    } else {
        RuntimeIntent::Start
    }
}

/// `captions.start`'s params: the chosen language, none for Auto-detect.
pub fn start_params(language: &str) -> Value {
    if language == "auto" || language.is_empty() {
        serde_json::json!({})
    } else {
        serde_json::json!({ "language": language })
    }
}

/// `captions.style.set`'s params from the stored captions block.
pub fn style_params(captions: &Value) -> Value {
    serde_json::json!({
        "position": captions["position"].as_str().unwrap_or("bottom"),
        "textSize": captions["textSize"].as_str().unwrap_or("m"),
        "styleId": captions["styleId"].as_str().unwrap_or("classic"),
        "styleRevision": captions["styleRevision"].as_u64().unwrap_or(0),
    })
}

// --- the page ---

/// `captionPreviewCanvas`: 960 px wide at the video's aspect, at least
/// 360 tall, a narrow portrait video shrunk to 4096 tall.
pub fn preview_canvas(width: u32, height: u32) -> (u32, u32) {
    let canvas_width = 960.0_f64;
    let aspect = f64::from(width) / f64::from(height.max(1));
    let canvas_height = (canvas_width / aspect).round().max(360.0);
    if canvas_height <= f64::from(PREVIEW_MAX_SIDE) {
        return (canvas_width as u32, canvas_height as u32);
    }
    (
        (f64::from(PREVIEW_MAX_SIDE) * aspect).round().max(2.0) as u32,
        PREVIEW_MAX_SIDE,
    )
}

/// `captionsPlacementSummary`: Scene places the bar; whether it shows is
/// Live captions alone.
pub fn placement_summary(bottom: bool) -> &'static str {
    if bottom { "Bottom" } else { "Top" }
}

/// Whether the captions' rect in `overlays.layout.get`'s answer hugs the
/// bottom, in this orientation (`horizontal` or `vertical`).
pub fn placement_bottom(layout: &Value, vertical: bool) -> Option<bool> {
    let rect = &layout["captions"][if vertical { "vertical" } else { "horizontal" }];
    let y = rect["y"].as_f64()?;
    let h = rect["h"].as_f64()?;
    Some(y + h / 2.0 >= 0.5)
}

/// What the page reads besides the capture config.
pub struct PageInputs<'a> {
    pub capture: &'a Value,
    pub status: &'a Status,
    /// A recording or livestream runs.
    pub session_active: bool,
    /// A talk-show room is open (Guests).
    pub room_open: bool,
    pub gate: &'a EntitlementGate,
    /// `process.platform`'s words: `darwin`, `win32`, `linux`.
    pub platform: &'a str,
    /// The chosen microphone's name in the device list, when it is there.
    pub microphone_device: Option<&'a str>,
    /// From `overlays.layout.get`; none until it is read.
    pub placement_bottom: Option<bool>,
}

/// The page, decided: every word and every lock.
#[derive(Debug, Clone, PartialEq)]
pub struct PageView {
    pub enabled: bool,
    /// The lock leads and every control under it is off.
    pub locked: Option<String>,
    pub can_toggle: bool,
    pub status_word: &'static str,
    pub status_tone: Tone,
    /// The switch's line: the status detail while on, the hint while off.
    pub switch_line: String,
    pub show_retry: bool,
    pub room_open: bool,
    pub platform_unavailable: bool,
    pub livestream_blocker: Option<&'static str>,
    pub outputs: String,
    pub outputs_locked: bool,
    pub outputs_description: &'static str,
    pub microphone: String,
    pub placement: Option<&'static str>,
    pub allowance: Option<String>,
    pub style_id: String,
    pub text_size: String,
    pub language: String,
    pub language_locked: bool,
    pub language_description: &'static str,
    /// The live strip shows while captions run or lines remain.
    pub show_strip: bool,
    pub position_top: bool,
}

/// The Captions page (`CaptionsControls`).
pub fn page(inputs: &PageInputs<'_>) -> PageView {
    let capture = inputs.capture;
    let captions = &capture["captions"];
    let text = |key: &str, fallback: &str| {
        captions[key]
            .as_str()
            .filter(|value| !value.is_empty())
            .unwrap_or(fallback)
            .to_string()
    };
    let enabled = captions["enabled"].as_bool().unwrap_or(false);
    let speech_active = inputs.session_active || inputs.room_open;
    let locked = inputs.gate.reason().map(str::to_string);
    let platform_unavailable =
        !inputs.room_open && preflight::platform_unavailable_reason(inputs.platform).is_some();
    let outputs = text("burnTarget", "stream");
    let livestream_blocker = if enabled && !platform_unavailable && !inputs.room_open {
        livestream_blocker(capture, &outputs)
    } else {
        None
    };
    let can_toggle = (inputs.gate.allowed() && !platform_unavailable) || enabled;
    let show_retry =
        enabled && speech_active && matches!(inputs.status.state.as_str(), "blocked" | "error");
    let switch_line = if enabled {
        inputs.status.detail(speech_active)
    } else {
        OFF_HINT.to_string()
    };
    let vertical_leg_armed =
        !inputs.room_open && crate::studio::capture_config::simulcast_armed(capture);
    let sources = &capture["sources"];
    let microphone = match sources["microphoneId"].as_str().filter(|id| !id.is_empty()) {
        None => MICROPHONE_OFF.to_string(),
        Some(_) => inputs
            .microphone_device
            .map(str::to_string)
            .or_else(|| {
                sources["microphoneName"]
                    .as_str()
                    .filter(|name| !name.is_empty())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| MICROPHONE_MISSING.to_string()),
    };
    PageView {
        enabled,
        locked,
        can_toggle,
        status_word: inputs.status.label(Some(enabled), speech_active),
        status_tone: inputs.status.tone(Some(enabled)),
        switch_line,
        show_retry,
        room_open: inputs.room_open,
        platform_unavailable,
        livestream_blocker,
        outputs_description: outputs_description(&outputs, vertical_leg_armed),
        outputs,
        outputs_locked: inputs.session_active,
        microphone,
        placement: inputs.placement_bottom.map(placement_summary),
        allowance: inputs.status.allowance(),
        style_id: text("styleId", "classic"),
        text_size: text("textSize", "m"),
        language: text("language", "auto"),
        language_locked: speech_active,
        language_description: if speech_active {
            SESSION_LOCK_REASON
        } else {
            LANGUAGE_HINT
        },
        show_strip: inputs.status.is_active(),
        position_top: captions["position"].as_str() == Some("top"),
    }
}

/// `livestreamCaptionsBlockerFor`: the rule today's setup would break.
fn livestream_blocker(capture: &Value, outputs: &str) -> Option<&'static str> {
    let recording = plan::recording_video(capture);
    let go_live = plan::go_live_plan(capture, &recording, false);
    let streams: Vec<plan::Video> = go_live
        .targets
        .iter()
        .map(|(.., video)| video.clone())
        .collect();
    let burn = if outputs == "both" {
        BurnTarget::Both
    } else {
        BurnTarget::Stream
    };
    preflight::livestream_blocker(
        true,
        burn,
        capture["recordEnabled"].as_bool().unwrap_or(false),
        &recording,
        &streams,
    )
    .map(|rule| rule.description())
}

/// `cloud.speech.transcript`'s rows, newest first: `12.3s` and the words.
pub fn transcript_rows(answer: &Value) -> Vec<(String, String)> {
    let mut rows: Vec<(String, String)> = answer
        .as_array()
        .map(|cues| {
            cues.iter()
                .map(|cue| {
                    (
                        format!("{:.1}s", cue["offsetSeconds"].as_f64().unwrap_or(0.0)),
                        cue["text"].as_str().unwrap_or_default().to_string(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    rows.reverse();
    rows
}

/// Standard base64, padded or not: `captions.preview.render`'s PNG.
pub fn decode_base64(text: &str) -> Option<Vec<u8>> {
    fn value(byte: u8) -> Option<u32> {
        Some(u32::from(match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        }))
    }
    let bytes: Vec<u8> = text
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    let bytes = match bytes.iter().position(|&byte| byte == b'=') {
        Some(pad) => {
            if bytes[pad..].iter().any(|&byte| byte != b'=') {
                return None;
            }
            &bytes[..pad]
        }
        None => &bytes[..],
    };
    if bytes.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut n = 0u32;
        for (index, &byte) in chunk.iter().enumerate() {
            n |= value(byte)? << (18 - 6 * index);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn status(value: Value) -> Status {
        Status::of(Some(&value))
    }

    fn line(session: &str, seq: u64, kind: &str, text: &str) -> Value {
        json!({ "sessionClientId": session, "seq": seq, "kind": kind, "text": text, "chunkSeconds": 3 })
    }

    #[test]
    fn a_partial_replaces_its_seq_and_a_new_session_resets() {
        let mut lines = Lines::default();
        assert!(lines.apply_update(&line("a", 1, "partial", "hel")));
        assert!(lines.apply_update(&line("a", 1, "final", "hello")));
        assert_eq!(lines.all().len(), 1);
        assert_eq!(lines.latest_final(), Some("hello"));
        assert!(!lines.apply_update(&line("a", 0, "final", "old")));
        assert!(!lines.apply_update(&line("a", 2, "final", "  ")));
        assert!(lines.apply_update(&line("b", 1, "final", "next")));
        assert_eq!(lines.all().len(), 1);
        assert_eq!(lines.all()[0].text, "next");
    }

    #[test]
    fn a_previous_videos_late_line_never_comes_back() {
        let mut lines = Lines::default();
        lines.apply_update(&line("a", 4, "final", "end of the last video"));
        assert!(lines.session_started());
        assert!(!lines.apply_update(&line("a", 4, "final", "end of the last video")));
        assert!(lines.apply_update(&line("a", 5, "final", "new video")));
        assert_eq!(lines.tail(8).len(), 1);
    }

    #[test]
    fn lines_keep_the_last_fifty() {
        let mut lines = Lines::default();
        for seq in 0..60 {
            lines.apply_update(&line("a", seq, "final", "x"));
        }
        assert_eq!(lines.all().len(), MAX_LINES);
        assert_eq!(lines.tail(STRIP_LINES)[2].seq, 59);
    }

    #[test]
    fn the_status_word_follows_the_switch_then_the_state() {
        let idle = Status::of(None);
        assert_eq!(idle.label(Some(false), false), "Off");
        assert_eq!(idle.label(Some(true), false), "Ready");
        assert_eq!(idle.label(Some(true), true), "Waiting…");
        assert_eq!(idle.label(None, false), "Off");
        let paused = status(json!({ "state": "degraded", "reasonCode": "service-unavailable" }));
        assert_eq!(paused.label(Some(true), true), "Paused");
        assert_eq!(paused.tone(Some(true)), Tone::Warn);
        assert_eq!(status(json!({ "state": "live" })).tone(None), Tone::Good);
    }

    #[test]
    fn the_reader_shows_a_failure_over_lines() {
        let failed = status(json!({ "state": "error" }));
        let notice = reader_notice(&failed, 3).unwrap();
        assert!(notice.failed);
        assert!(reader_notice(&status(json!({ "state": "live" })), 3).is_none());
        let off = reader_notice(&Status::of(None), 0).unwrap();
        assert!(off.text.starts_with("Live captions are off."));
        let on = reader_notice(
            &status(json!({ "state": "idle", "desiredEnabled": true })),
            0,
        );
        assert_eq!(
            on.unwrap().text,
            "Captions show here when you record or go live."
        );
    }

    #[test]
    fn captions_start_with_a_session_once_and_stop_when_turned_off() {
        let idle = Status::of(None);
        assert_eq!(
            runtime_intent(true, false, true, &idle, false, false),
            RuntimeIntent::Start
        );
        assert_eq!(
            runtime_intent(true, false, true, &idle, true, false),
            RuntimeIntent::None
        );
        let ready = status(json!({ "state": "ready", "desiredEnabled": true }));
        assert_eq!(
            runtime_intent(true, false, false, &ready, false, false),
            RuntimeIntent::None
        );
        assert_eq!(
            runtime_intent(false, false, true, &ready, false, false),
            RuntimeIntent::Stop
        );
        assert_eq!(
            runtime_intent(false, false, true, &ready, false, true),
            RuntimeIntent::None
        );
        assert_eq!(
            runtime_intent(false, false, false, &idle, false, false),
            RuntimeIntent::None
        );
    }

    #[test]
    fn the_allowance_is_whole_minutes() {
        let status = status(json!({ "state": "ready", "remainingSeconds": 74_001 }));
        assert_eq!(status.allowance().unwrap(), "1,234 min left this month");
        assert!(Status::of(None).allowance().is_none());
    }

    #[test]
    fn the_preview_canvas_keeps_the_aspect() {
        assert_eq!(preview_canvas(1920, 1080), (960, 540));
        assert_eq!(preview_canvas(1080, 1920), (960, 1707));
        assert_eq!(preview_canvas(3840, 720), (960, 360));
        assert_eq!(preview_canvas(360, 1920).1, PREVIEW_MAX_SIDE);
    }

    #[test]
    fn placement_reads_the_rects_centre() {
        let layout = json!({ "captions": {
            "horizontal": { "x": 0.1, "y": 0.8, "w": 0.8, "h": 0.1 },
            "vertical": { "x": 0.1, "y": 0.05, "w": 0.8, "h": 0.1 },
        }});
        assert_eq!(placement_bottom(&layout, false), Some(true));
        assert_eq!(placement_bottom(&layout, true), Some(false));
        assert_eq!(placement_bottom(&json!({}), false), None);
    }

    #[test]
    fn base64_round_trips_padded_and_bare() {
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("aGVsbG8").unwrap(), b"hello");
        assert_eq!(
            decode_base64("iVBORw0KGgo=").unwrap()[..4],
            [0x89, b'P', b'N', b'G']
        );
        assert!(decode_base64("a=b=").is_none());
        assert!(decode_base64("*").is_none());
    }

    #[test]
    fn transcript_rows_are_newest_first() {
        let rows = transcript_rows(&json!([
            { "offsetSeconds": 1.24, "text": "first" },
            { "offsetSeconds": 4.0, "text": "second" },
        ]));
        assert_eq!(rows[0], ("4.0s".to_string(), "second".to_string()));
        assert_eq!(rows[1].0, "1.2s");
    }

    #[test]
    fn styles_and_languages_match_electron() {
        assert_eq!(STYLES.len(), 4);
        assert_eq!(style("lower-third").label, "Lower third");
        assert_eq!(style("nope").label, "Glass");
        assert_eq!(LANGUAGES[0], ("auto", "Auto-detect"));
        assert_eq!(start_params("auto"), json!({}));
        assert_eq!(start_params("fr"), json!({ "language": "fr" }));
    }
}
