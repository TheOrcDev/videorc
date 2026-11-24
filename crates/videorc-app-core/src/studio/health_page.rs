//! The Health page (plan 220 S3.0g), as plain data the UI copies:
//! `lib/health-checks.ts` (every check, the verdict, the words for a stage,
//! a log level and a cut log), `components/tabs/diagnostics-tab.tsx` (the
//! metric groups and their formatters), `lib/record-latency.ts`'s timeline
//! words, `lib/backend-crash-view.ts` (the engine's last exit) and
//! `lib/studio-health.ts`'s `studioHealth` (the Studio's capture alert, for
//! the preview panel's slice).
//!
//! The page answers "is anything wrong?" first: one verdict, the checks that
//! need attention (the rest behind "Show all checks"), the support bundle,
//! and the engineering numbers folded into one closed "Technical details";
//! a group in it that is unhealthy opens itself.
//!
//! The diagnostics are read from the backend's JSON (`diagnostics.stats`,
//! `stream.health`, `preview.*.status`) the way the renderer reads them: a
//! field that is absent is the placeholder, a counter that is absent is 0.
//! A test checks that every field read here is one the backend's
//! `DiagnosticStats` writes.

use std::time::Instant;

use serde_json::Value;
use videorc_protocol::{
    CompositorFramePipelineStatus, HealthLevel, RecordingPipelineStage,
    RecordingPipelineStageState, RecordingPipelineStatus, SessionLogEntry, VirtualCameraState,
    VirtualCameraStatus,
};

use super::health::{HealthSummary, HealthTelemetry};
use super::virtual_camera::{VIDEORC_CAMERA, camera_copy, camera_hidden};
use crate::crash_log::CrashRecord;
use crate::log::LogLine;
use crate::notices::{NoticeCommand, ToastRequest};

/// `NO_VALUE` (`lib/format.ts`): what a value that isn't there reads as.
pub const NO_VALUE: &str = "–";

/// `OPEN_HEALTH_LABEL` (`lib/health-door.ts`): the door's one name.
pub const OPEN_HEALTH_LABEL: &str = "Open Health";

/// `SUPPORT_BUNDLE_LABEL` (`lib/toast.ts`): the export's one name.
pub const SUPPORT_BUNDLE_LABEL: &str = "Export support bundle";

/// The words the page shows besides its checks and metrics.
pub mod copy {
    pub const CHECKS_TITLE: &str = "Checks";
    pub const CHECKS_DESCRIPTION: &str = "Is anything wrong right now?";
    pub const CHECKS_LIST_LABEL: &str = "Checks";
    pub const SUPPORT_BUNDLE_TITLE: &str = "Support bundle";
    pub const SUPPORT_BUNDLE_DESCRIPTION: &str =
        "Redacted logs and Health's checks in one file, to send with a problem report.";
    pub const SUPPORT_BUNDLE_PENDING: &str = "Exporting…";
    pub const TECHNICAL_DETAILS: &str = "Technical details";
    pub const SHOW_FEWER_CHECKS: &str = "Show fewer checks";
    /// `Show all checks ({count})`.
    pub fn show_all_checks(count: usize) -> String {
        format!("Show all checks ({count})")
    }
    pub const NEEDS_A_LOOK: &str = ", needs a look";
    pub const FFMPEG_MISSING_TITLE: &str = "Videorc's recorder isn't available";
    pub const FFMPEG_MISSING_DEV: &str =
        "For local development, install FFmpeg with “brew install ffmpeg”.";
    pub const FFMPEG_MISSING_PACKAGED: &str =
        "It ships with Videorc, so this usually means the install is damaged. Reinstall Videorc.";
    pub const NOTHING_RECORDING: &str = "Nothing is recording.";
    pub const NO_RECORDINGS: &str = "No recordings yet.";
    pub const LOADING_LOG: &str = "Loading the log…";
    pub const LOG_FAILED: &str = "Couldn't load this recording's log. Try again in a moment.";
    pub const LOG_EMPTY: &str = "This recording has no log lines.";
    pub const APP_LOG_EMPTY: &str = "No log lines yet.";
    pub const LOG_OF_THIS_RECORDING: &str = "Log of this recording";
    pub const LOG_OF_THE_LAST_RECORDING: &str = "Log of the last recording";
    pub const APP_LOG: &str = "App log";
    /// `Showing the last {APP_LOG_LIMIT} lines. The support bundle keeps more.`
    pub fn app_log_cut(limit: usize) -> String {
        format!("Showing the last {limit} lines. The support bundle keeps more.")
    }
    pub const ENGINE_RESTARTED: &str = "Videorc's engine restarted";
    pub const ENGINE_STOPPED: &str = "Videorc's engine stopped unexpectedly";
    pub const ENGINE_PRINTED_NOTHING: &str = "It printed nothing before it stopped.";
    /// `The support bundle includes its last {plural(n, 'output line')}.`
    pub fn crash_bundle_note(lines: usize) -> String {
        format!(
            "The support bundle includes its last {}.",
            super::plural(lines as i64, "output line")
        )
    }
}

/// How many log lines each log shows; the support bundle keeps more.
pub const RECORDING_LOG_LIMIT: usize = 120;
pub const APP_LOG_LIMIT: usize = 80;

// ── the shared formatters (`lib/format.ts`, `lib/format-video.ts`) ──────

/// `toLocaleString()` of a whole number, as en-US groups it ("1,204").
pub fn group_thousands(value: i64) -> String {
    let digits = value.unsigned_abs().to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3 + 1);
    if value < 0 {
        out.push('-');
    }
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// `plural`: "1 drop", "12 drops", "1,204 viewers".
pub fn plural(count: i64, one: &str) -> String {
    let many = format!("{one}s");
    format!(
        "{} {}",
        group_thousands(count),
        if count == 1 { one } else { many.as_str() }
    )
}

/// JavaScript's `Math.round`: halves go up.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `formatMetric`: "29.9 fps", "1.00 x", or the placeholder.
pub fn format_metric(value: Option<f64>, suffix: &str) -> String {
    match value {
        Some(value) if suffix == "fps" => format!("{value:.1} {suffix}"),
        Some(value) => format!("{value:.2} {suffix}"),
        None => NO_VALUE.to_string(),
    }
}

/// `formatDroppedFrames`: "1 drop", "12 drops", or the placeholder.
pub fn format_dropped_frames(value: Option<f64>) -> String {
    value.map_or_else(
        || NO_VALUE.to_string(),
        |value| plural(value as i64, "drop"),
    )
}

/// `formatBitrate`: always megabits, one decimal at most ("6 Mbps").
pub fn format_bitrate(kbps: Option<f64>) -> Option<String> {
    let kbps = kbps.filter(|kbps| kbps.is_finite() && *kbps >= 0.0)?;
    let mbps = js_round(kbps / 100.0) / 10.0;
    Some(format!("{} Mbps", trim_decimals(mbps, 1)))
}

/// `formatFrameRate`: "30 fps", "29.97 fps".
pub fn format_frame_rate(fps: f64) -> String {
    let rounded = js_round(fps * 100.0) / 100.0;
    format!("{} fps", trim_decimals(rounded, 2))
}

/// A number with at most `places` decimals and no trailing zeros, grouped
/// as `toLocaleString(undefined, { maximumFractionDigits })` writes it.
fn trim_decimals(value: f64, places: usize) -> String {
    let text = format!("{value:.places$}");
    let (whole, fraction) = text.split_once('.').unwrap_or((&text, ""));
    let fraction = fraction.trim_end_matches('0');
    let whole = whole
        .parse::<i64>()
        .map_or(whole.to_string(), group_thousands);
    if fraction.is_empty() {
        whole
    } else {
        format!("{whole}.{fraction}")
    }
}

/// `statusWordFromValue`: `device-missing` reads "Device missing".
pub fn status_word_from_value(value: &str) -> String {
    let spaced = value
        .split(['-', '_'])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let mut chars = spaced.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// `sentenceCase` in `health-checks.ts`: the word, or the placeholder.
fn sentence_case(value: &str) -> String {
    let word = status_word_from_value(value);
    if word.is_empty() {
        NO_VALUE.to_string()
    } else {
        word
    }
}

/// `compactTime`: the clock time of an ISO timestamp, in this Mac's time
/// zone ("14:03:22"); the timestamp itself when it doesn't read.
pub fn compact_time(timestamp: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(timestamp) {
        Ok(at) => at
            .with_timezone(&chrono::Local)
            .format("%H:%M:%S")
            .to_string(),
        Err(_) => timestamp.to_string(),
    }
}

// ── the diagnostics as the renderer reads them ───────────────────────────

/// One object of the backend's JSON (`diagnostics.stats`, a status), read
/// field by field as the renderer reads it. Every key is the wire's
/// camelCase name.
#[derive(Clone, Copy)]
pub struct Fields<'a>(&'a Value);

static NULL: Value = Value::Null;

impl<'a> Fields<'a> {
    pub fn of(value: Option<&'a Value>) -> Self {
        Self(value.unwrap_or(&NULL))
    }
    fn get(self, key: &str) -> Option<&'a Value> {
        self.0.get(key).filter(|value| !value.is_null())
    }
    /// A number, or none (`typeof value === 'number'`).
    pub fn num(self, key: &str) -> Option<f64> {
        self.get(key).and_then(Value::as_f64)
    }
    /// A counter: absent is 0.
    pub fn count(self, key: &str) -> f64 {
        self.num(key).unwrap_or(0.0)
    }
    pub fn text(self, key: &str) -> Option<&'a str> {
        self.get(key).and_then(Value::as_str)
    }
    pub fn flag(self, key: &str) -> bool {
        self.get(key).and_then(Value::as_bool).unwrap_or(false)
    }
    pub fn strings(self, key: &str) -> Vec<&'a str> {
        self.get(key)
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default()
    }
    pub fn object(self, key: &str) -> Fields<'a> {
        Fields::of(self.get(key))
    }
    /// A map's entries in the order the backend wrote them.
    pub fn entries(self, key: &str) -> Vec<(&'a str, Fields<'a>)> {
        self.get(key)
            .and_then(Value::as_object)
            .map(|map| {
                map.iter()
                    .map(|(name, value)| (name.as_str(), Fields(value)))
                    .collect()
            })
            .unwrap_or_default()
    }
    pub fn present(self) -> bool {
        !self.0.is_null()
    }
}

// ── the checks (`lib/health-checks.ts`) ──────────────────────────────────

/// What a check means, never how it looks (`StatusTone`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Neutral,
    Good,
    Warn,
    Error,
}

impl Tone {
    pub fn as_str(self) -> &'static str {
        match self {
            Tone::Neutral => "neutral",
            Tone::Good => "good",
            Tone::Warn => "warn",
            Tone::Error => "error",
        }
    }
}

/// A check's state in words and its tone (`CheckWords`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckWords {
    pub value: String,
    pub tone: Tone,
}

fn words(value: impl Into<String>, tone: Tone) -> CheckWords {
    CheckWords {
        value: value.into(),
        tone,
    }
}

/// One Health check (`HealthCheck`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthCheck {
    pub id: &'static str,
    pub label: &'static str,
    pub value: String,
    pub tone: Tone,
}

/// `checkNeedsAttention`: amber or red needs the streamer; neutral never.
pub fn check_needs_attention(tone: Tone) -> bool {
    matches!(tone, Tone::Warn | Tone::Error)
}

/// `formatBytes` (Health's): "12.5 MiB", "300 KiB", or the placeholder.
pub fn format_bytes(value: Option<f64>) -> String {
    match value {
        None => NO_VALUE.to_string(),
        Some(value) if value < 1024.0 * 1024.0 => format!("{:.0} KiB", value / 1024.0),
        Some(value) => format!("{:.1} MiB", value / (1024.0 * 1024.0)),
    }
}

/// `slowdownCheck`: the part the backend measured as the slowest.
pub fn slowdown_check(bottleneck: &str) -> CheckWords {
    match bottleneck {
        "audio" => words("Microphone", Tone::Warn),
        "capture" => words("Capture", Tone::Warn),
        "render" => words("Rendering", Tone::Warn),
        "encoder" => words("Encoder", Tone::Warn),
        "preview" => words("Preview", Tone::Warn),
        "device" => words("Device", Tone::Error),
        "unknown" => words("Measuring…", Tone::Neutral),
        _ => words("None found", Tone::Good),
    }
}

/// `slowdownAdvice`: what to do about a slowdown; none when nothing is slow.
pub fn slowdown_advice(bottleneck: &str) -> Option<&'static str> {
    match bottleneck {
        "encoder" => Some(
            "Videorc is encoding slower than real time. Lower the bitrate or the resolution if your video looks laggy.",
        ),
        "capture" | "render" => Some(
            "Capture isn't keeping up with the frame rate. Lower the resolution or close heavy apps if your video looks laggy.",
        ),
        "audio" => Some("The microphone dropped audio. Check it in Sources, or close heavy apps."),
        "preview" => Some("The preview dropped frames. Your recording isn't affected."),
        "device" => Some(
            "A capture device stopped responding. Check its cable, then choose it again in Sources.",
        ),
        _ => None,
    }
}

/// `RECORDING_AT_RISK_ADVICE`.
pub const RECORDING_AT_RISK_ADVICE: &str =
    "Your recording may stutter or have gaps. Technical details below say why.";

pub fn recording_check(stats: Fields) -> CheckWords {
    if stats.flag("recordingAtRisk") {
        return words("At risk", Tone::Error);
    }
    if stats.flag("recordingProtected") {
        return words("Protected", Tone::Good);
    }
    if stats
        .text("activeOutputMode")
        .is_some_and(|mode| !mode.is_empty())
    {
        return words("Active", Tone::Good);
    }
    words("Idle", Tone::Neutral)
}

/// `stats.droppedFrames || streamHealth?.droppedFrames`: a 0 falls through.
fn dropped_or_health(stats: Fields, stream: Fields) -> Option<f64> {
    match stats.num("droppedFrames") {
        Some(drops) if drops != 0.0 => Some(drops),
        _ => stream.num("droppedFrames"),
    }
}

pub fn encoder_check(stats: Fields, stream: Fields) -> CheckWords {
    let speed = stats.num("encoderSpeed").or(stream.num("speed"));
    let drops = dropped_or_health(stats, stream).unwrap_or(0.0);
    if drops > 0.0 {
        return words(plural(drops as i64, "dropped frame"), Tone::Warn);
    }
    match speed {
        Some(speed) => words(
            format!("{speed:.2}×"),
            if speed < 0.98 { Tone::Warn } else { Tone::Good },
        ),
        None => words("Idle", Tone::Neutral),
    }
}

/// A truthy number (`stats.renderFps && …`).
fn truthy(value: Option<f64>) -> Option<f64> {
    value.filter(|value| *value != 0.0 && !value.is_nan())
}

pub fn rendering_check(stats: Fields) -> CheckWords {
    if let Some(target) = truthy(stats.num("targetFps")).or(truthy(stats.num("previewTargetFps"))) {
        let budget = 1000.0 / target.max(1.0);
        if stats
            .num("compositorTickGapP95Ms")
            .is_some_and(|gap| gap > budget * 1.5)
        {
            return words("Uneven frames", Tone::Warn);
        }
        if stats
            .num("compositorTickGapMaxMs")
            .is_some_and(|gap| gap > budget * 3.0)
        {
            return words("Frame spikes", Tone::Warn);
        }
    }
    if let (Some(render), Some(target)) = (
        truthy(stats.num("renderFps")),
        truthy(stats.num("targetFps")),
    ) && render < target * 0.9
    {
        return words("Below frame rate", Tone::Warn);
    }
    if let (Some(frame), Some(target)) = (
        truthy(stats.num("previewRenderFrameTimeP95Ms")),
        truthy(stats.num("previewTargetFps")),
    ) && frame > (1000.0 / target.max(1.0)) * 1.5
    {
        return words("Slow frames", Tone::Warn);
    }
    match truthy(stats.num("renderFps")) {
        Some(fps) => words(format_metric(Some(fps), "fps"), Tone::Good),
        None => words("Idle", Tone::Neutral),
    }
}

/// `sourcesCheck`: "Dropping frames" is present tense (#981): it reads the
/// drop window, never the run totals.
pub fn sources_check(stats: Fields, capture_dropping: bool) -> CheckWords {
    if stats.flag("deviceDisconnected") {
        return words("Device disconnected", Tone::Error);
    }
    if !stats.strings("duplicateCaptureSources").is_empty() {
        return words("Captured twice", Tone::Warn);
    }
    if capture_dropping {
        return words("Dropping frames", Tone::Warn);
    }
    if let (Some(capture), Some(target)) = (
        truthy(stats.num("captureFps")),
        truthy(stats.num("targetFps")),
    ) && capture < target * 0.9
    {
        return words("Capture slow", Tone::Warn);
    }
    words("Healthy", Tone::Good)
}

/// `previewStateLabel`.
pub fn preview_state_label(state: &str) -> String {
    match state {
        "connecting" => "Connecting…".to_string(),
        "live" => "Running".to_string(),
        "reconnecting" => "Reconnecting…".to_string(),
        "unavailable" => "Unavailable".to_string(),
        other => status_word_from_value(other),
    }
}

/// `previewSourceStateLabel`: a source producing frames is "Receiving";
/// the idle `device-missing` / `source-missing` reads "Not running".
pub fn preview_source_state_label(state: &str) -> String {
    match state {
        "starting" => "Starting…".to_string(),
        "live" => "Receiving".to_string(),
        "permission-needed" => "Needs permission".to_string(),
        "disconnected" => "Disconnected".to_string(),
        "device-missing" | "source-missing" => "Not running".to_string(),
        "failed" => "Failed".to_string(),
        other => status_word_from_value(other),
    }
}

/// `previewSourceCheck`.
pub fn preview_source_check(state: &str) -> CheckWords {
    let value = preview_source_state_label(state);
    match state {
        "live" => words(value, Tone::Good),
        "permission-needed" | "failed" => words(value, Tone::Error),
        _ => words(value, Tone::Neutral),
    }
}

/// `cameraSendsNoVideo`.
pub fn camera_sends_no_video(camera: Fields) -> bool {
    camera.text("state") == Some("live") && camera.flag("noVideo")
}

/// `cameraCheck` (plan 216 D2): a camera that is on but sends no video.
pub fn camera_check(camera: Fields) -> CheckWords {
    if camera_sends_no_video(camera) {
        return words("No video", Tone::Warn);
    }
    preview_source_check(camera.text("state").unwrap_or("device-missing"))
}

/// `cameraNoVideoLine` (`lib/source-status.ts`): "MacBook Pro Camera isn't
/// sending video.", by name where Videorc knows it.
pub fn camera_no_video_line(name: Option<&str>) -> String {
    let name = name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("Your camera");
    format!("{name} isn't sending video.")
}

/// `cameraNoVideoAdvice`.
pub fn camera_no_video_advice(camera: Fields, name: Option<&str>) -> Option<String> {
    camera_sends_no_video(camera).then(|| {
        format!(
            "{} Close other apps that use it, or choose another camera in Sources.",
            camera_no_video_line(name)
        )
    })
}

pub fn preview_check(live_state: &str, camera_state: &str, screen_state: &str) -> CheckWords {
    let value = preview_state_label(live_state);
    if camera_state == "permission-needed" || screen_state == "permission-needed" {
        return words("Needs permission", Tone::Error);
    }
    if live_state == "live" {
        return words(value, Tone::Good);
    }
    words(
        value,
        if live_state == "unavailable" {
            Tone::Warn
        } else {
            Tone::Neutral
        },
    )
}

/// `isNativePreviewCapability`: Metal is native only on macOS; Windows needs
/// the backend's D3D11 presenter. A browser window never is.
pub fn is_native_preview_capability(
    transport: Option<&str>,
    backing: Option<&str>,
    host_kind: Option<&str>,
    platform: &str,
) -> bool {
    (platform == "darwin"
        && transport == Some("native-surface")
        && backing == Some("cametal-layer"))
        || (platform == "win32"
            && transport == Some("d3d11-shared-texture")
            && backing == Some("directcomposition-swapchain")
            && host_kind == Some("backend-d3d11-presenter"))
}

/// What `previewSpeedCheck` reads.
#[derive(Clone, Copy)]
pub struct PreviewInputs<'a> {
    pub stats: Fields<'a>,
    pub expects_camera: bool,
    pub expects_screen: bool,
    pub native_preview_surface_enabled: bool,
    pub platform: &'a str,
    pub camera: Fields<'a>,
    pub live: Fields<'a>,
    pub screen: Fields<'a>,
    pub surface: Fields<'a>,
}

impl PreviewInputs<'_> {
    fn camera_state(&self) -> &str {
        self.camera.text("state").unwrap_or("device-missing")
    }
    fn screen_state(&self) -> &str {
        self.screen.text("state").unwrap_or("source-missing")
    }
    fn live_state(&self) -> &str {
        self.live.text("state").unwrap_or("unavailable")
    }
}

/// `previewSpeedCheck`: why the preview isn't smooth, if it isn't.
pub fn preview_speed_check(input: &PreviewInputs) -> CheckWords {
    let stats = input.stats;
    let synthetic = input.native_preview_surface_enabled
        && input.surface.text("source").unwrap_or("synthetic") == "synthetic";
    let check_camera = input.expects_camera && !synthetic;
    let check_screen = input.expects_screen && !synthetic;
    if (check_camera && input.camera_state() == "permission-needed")
        || (check_screen && input.screen_state() == "permission-needed")
    {
        return words("Needs permission", Tone::Error);
    }
    if check_camera && input.camera_state() == "failed" {
        return words("Camera failed", Tone::Error);
    }
    if check_screen && input.screen_state() == "failed" {
        return words("Screen failed", Tone::Error);
    }
    let transport = stats.text("previewTransport");
    let unavailable = transport == Some("unavailable");
    let fallback_tone = if unavailable {
        Tone::Neutral
    } else {
        Tone::Warn
    };
    if transport == Some("cpu-shared-memory") {
        // Plan 220 S4.1d: the platform's own CPU preview, named for what it
        // is (never native, never a fallback from something better).
        return words("CPU preview", Tone::Neutral);
    }
    if !input.native_preview_surface_enabled {
        return words("Fallback", fallback_tone);
    }
    if transport == Some("electron-proof-surface") {
        return words("Fallback", Tone::Warn);
    }
    if !is_native_preview_capability(
        transport,
        stats.text("previewSurfaceBacking"),
        input.surface.text("nativePreviewHostKind"),
        input.platform,
    ) {
        return words("Fallback", fallback_tone);
    }
    let target = stats
        .num("previewTargetFps")
        .or(input.surface.num("targetFps"))
        .unwrap_or(60.0);
    let minimum = target * 0.9;
    if check_camera
        && input.camera_state() == "live"
        && !camera_sends_no_video(input.camera)
        && input
            .camera
            .num("sourceFps")
            .is_some_and(|fps| fps < minimum)
    {
        return words("Camera slow", Tone::Warn);
    }
    if check_screen
        && input.screen_state() == "live"
        && input
            .screen
            .num("sourceFps")
            .is_some_and(|fps| fps < minimum)
    {
        return words("Screen slow", Tone::Warn);
    }
    if stats
        .num("previewRenderFrameTimeP95Ms")
        .is_some_and(|frame| frame > (1000.0 / target.max(1.0)) * 1.5)
    {
        return words("Slow rendering", Tone::Warn);
    }
    if stats
        .num("previewPresentFps")
        .is_some_and(|fps| fps < minimum)
    {
        return words("Slow display", Tone::Warn);
    }
    if stats.count("previewDroppedFrames") > 0.0
        || stats.count("previewRepeatedFrames") > target
        || stats
            .num("previewCompositorFrameLag")
            .is_some_and(|lag| lag > 2.0)
        || stats
            .num("previewInputToPresentLatencyP95Ms")
            .is_some_and(|latency| latency > 50.0)
        || stats
            .num("previewInputToPresentLatencyMs")
            .is_some_and(|latency| latency > 150.0)
    {
        return words("App busy", Tone::Warn);
    }
    if input.live_state() != "live" {
        return words("Measuring…", Tone::Neutral);
    }
    words("Smooth", Tone::Good)
}

/// `previewPathCheck`: only the platform's own presenter is "Native".
pub fn preview_path_check(
    transport: Option<&str>,
    backing: Option<&str>,
    host_kind: Option<&str>,
    platform: &str,
) -> CheckWords {
    if transport.is_some()
        && backing.is_some()
        && is_native_preview_capability(transport, backing, host_kind, platform)
    {
        return words("Native", Tone::Good);
    }
    match transport {
        Some("native-surface" | "d3d11-shared-texture") => words("Native, unconfirmed", Tone::Warn),
        Some("electron-proof-surface") => words("Fallback window", Tone::Warn),
        Some("latest-jpeg-polling") => words("Fallback (JPEG)", Tone::Warn),
        Some("mjpeg-stream") => words("Fallback (MJPEG)", Tone::Warn),
        // Plan 220 S4.1d: the CPU preview over shared memory, by name.
        Some("cpu-shared-memory") => words(
            if cfg!(target_os = "windows") {
                "Windows CPU preview"
            } else {
                "Linux CPU preview"
            },
            Tone::Neutral,
        ),
        _ => words("Off", Tone::Neutral),
    }
}

/// `destinationsCheck`, over the `stream.targets` states.
pub fn destinations_check(states: &[&str]) -> CheckWords {
    if states.is_empty() {
        return words("Idle", Tone::Neutral);
    }
    let in_state = |state: &str| states.iter().filter(|each| **each == state).count();
    let failed = in_state("failed");
    if failed > 0 {
        return words(format!("{failed} failed"), Tone::Warn);
    }
    let reconnecting = in_state("reconnecting");
    if reconnecting > 0 {
        return words(format!("{reconnecting} reconnecting"), Tone::Warn);
    }
    let not_receiving = in_state("warning");
    if not_receiving > 0 {
        return words(format!("{not_receiving} not receiving"), Tone::Warn);
    }
    let on_air = in_state("live");
    if on_air > 0 {
        return words(format!("{on_air} of {} on air", states.len()), Tone::Good);
    }
    let connecting = in_state("connecting");
    if connecting > 0 {
        return words(format!("{connecting} connecting"), Tone::Neutral);
    }
    words("Ready", Tone::Neutral)
}

pub fn memory_check(bytes: Option<f64>) -> CheckWords {
    let Some(bytes) = bytes else {
        return words(NO_VALUE, Tone::Neutral);
    };
    let mib = bytes / (1024.0 * 1024.0);
    words(
        format_bytes(Some(bytes)),
        if mib >= 2048.0 {
            Tone::Error
        } else if mib >= 1024.0 {
            Tone::Warn
        } else {
            Tone::Good
        },
    )
}

/// `fileRepairCheck`: running is in passing, never amber.
pub fn file_repair_check(stats: Fields) -> CheckWords {
    if stats.flag("ffmpegMaintenanceCancelRequested") {
        return words("Canceling…", Tone::Neutral);
    }
    if stats.flag("ffmpegMaintenanceRunning") {
        return words("Running", Tone::Neutral);
    }
    if stats
        .text("ffmpegMaintenanceDeferredReason")
        .is_some_and(|reason| !reason.is_empty())
    {
        return words("Waiting", Tone::Neutral);
    }
    words("Idle", Tone::Good)
}

/// `healthChecks`: every check, in the order "Show all checks" lists them.
pub fn health_checks(
    input: &PreviewInputs,
    stream: Fields,
    destination_states: &[&str],
    capture_dropping: bool,
) -> Vec<HealthCheck> {
    let stats = input.stats;
    let check = |id, label, words: CheckWords| HealthCheck {
        id,
        label,
        value: words.value,
        tone: words.tone,
    };
    vec![
        check("recording", "Recording", recording_check(stats)),
        check(
            "slowdown",
            "Slowdown",
            slowdown_check(stats.text("bottleneck").unwrap_or("none")),
        ),
        check("encoder", "Encoder", encoder_check(stats, stream)),
        check("rendering", "Rendering", rendering_check(stats)),
        check("sources", "Sources", sources_check(stats, capture_dropping)),
        check("camera", "Camera", camera_check(input.camera)),
        check(
            "screen",
            "Screen",
            preview_source_check(input.screen_state()),
        ),
        check(
            "preview",
            "Preview",
            preview_check(
                input.live_state(),
                input.camera_state(),
                input.screen_state(),
            ),
        ),
        check("preview-speed", "Preview speed", preview_speed_check(input)),
        check(
            "preview-path",
            "Preview path",
            preview_path_check(
                stats.text("previewTransport"),
                stats.text("previewSurfaceBacking"),
                input.surface.text("nativePreviewHostKind"),
                input.platform,
            ),
        ),
        check(
            "destinations",
            "Destinations",
            destinations_check(destination_states),
        ),
        check(
            "memory",
            "Memory",
            memory_check(stats.num("backendRssBytes")),
        ),
        check("file-repair", "File repair", file_repair_check(stats)),
    ]
}

/// The verdict's tone (`HealthVerdict['variant']`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerdictVariant {
    Success,
    Warning,
    Destructive,
}

impl VerdictVariant {
    pub fn as_str(self) -> &'static str {
        match self {
            VerdictVariant::Success => "success",
            VerdictVariant::Warning => "warning",
            VerdictVariant::Destructive => "destructive",
        }
    }
}

/// The one answer Health leads with (`HealthVerdict`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthVerdict {
    pub variant: VerdictVariant,
    pub title: String,
    pub description: Option<String>,
}

/// `healthVerdict`: `warnings` name the actionable warnings and count like
/// the checks. Red when a check is red, amber otherwise.
pub fn health_verdict(
    checks: &[HealthCheck],
    warnings: &[String],
    advice: Option<String>,
) -> HealthVerdict {
    let attention: Vec<&HealthCheck> = checks
        .iter()
        .filter(|check| check_needs_attention(check.tone))
        .collect();
    let names: Vec<&str> = warnings
        .iter()
        .map(String::as_str)
        .chain(attention.iter().map(|check| check.label))
        .collect();
    if names.is_empty() {
        return HealthVerdict {
            variant: VerdictVariant::Success,
            title: "Everything looks healthy".to_string(),
            description: None,
        };
    }
    let verb = if names.len() == 1 { "needs" } else { "need" };
    HealthVerdict {
        variant: if attention.iter().any(|check| check.tone == Tone::Error) {
            VerdictVariant::Destructive
        } else {
            VerdictVariant::Warning
        },
        title: format!(
            "{} {verb} attention: {}",
            plural(names.len() as i64, "thing"),
            names.join(", ")
        ),
        description: advice,
    }
}

/// `pipelineStageLabel`.
pub fn pipeline_stage_label(stage: &RecordingPipelineStage) -> &'static str {
    match stage {
        RecordingPipelineStage::Capture => "Capture",
        RecordingPipelineStage::Render => "Rendering",
        RecordingPipelineStage::VideoEncoder => "Video encoder",
        RecordingPipelineStage::AudioEncoder => "Audio encoder",
        RecordingPipelineStage::Muxer => "File writer",
    }
}

/// `pipelineStateWords`: transitional states are neutral, not amber.
pub fn pipeline_state_words(state: &RecordingPipelineStageState) -> CheckWords {
    match state {
        RecordingPipelineStageState::Pending => words("Waiting", Tone::Neutral),
        RecordingPipelineStageState::Starting => words("Starting…", Tone::Neutral),
        RecordingPipelineStageState::Running => words("Running", Tone::Good),
        RecordingPipelineStageState::Finalizing => words("Finishing…", Tone::Neutral),
        RecordingPipelineStageState::Finished => words("Finished", Tone::Good),
        RecordingPipelineStageState::Failed => words("Failed", Tone::Error),
        RecordingPipelineStageState::Skipped => words("Skipped", Tone::Neutral),
    }
}

/// `logLevelLabel`.
pub fn log_level_label(level: &str) -> String {
    match level {
        "info" => "Info".to_string(),
        "warn" => "Warning".to_string(),
        "error" => "Error".to_string(),
        other => sentence_case(other),
    }
}

/// `logTruncationNote`: "Showing the last 120 of 342 lines.", or none.
pub fn log_truncation_note(shown: usize, total: usize) -> Option<String> {
    (total > shown).then(|| {
        format!(
            "Showing the last {} of {}.",
            group_thousands(shown as i64),
            plural(total as i64, "line")
        )
    })
}

// ── the metric groups (`diagnostics-tab.tsx`) ────────────────────────────

/// `formatMs`.
pub fn format_ms(value: Option<f64>) -> String {
    value.map_or_else(|| NO_VALUE.to_string(), |value| format!("{value:.0} ms"))
}

fn format_kbps(value: Option<f64>) -> String {
    format_bitrate(value).unwrap_or_else(|| NO_VALUE.to_string())
}

/// `formatOptionalCounter`.
pub fn format_optional_counter(value: Option<f64>) -> String {
    match value.filter(|value| value.is_finite()) {
        Some(value) => group_thousands(js_round(value).max(0.0) as i64),
        None => NO_VALUE.to_string(),
    }
}

fn format_frame_lag(value: Option<f64>) -> String {
    value.map_or_else(
        || NO_VALUE.to_string(),
        |value| plural(js_round(value) as i64, "frame"),
    )
}

fn format_coverage(value: Option<f64>) -> String {
    value.map_or_else(
        || NO_VALUE.to_string(),
        |value| format!("{:.0}%", value * 100.0),
    )
}

/// `formatLatencyMs`.
pub fn format_latency_ms(value: Option<f64>) -> String {
    match value.filter(|value| value.is_finite()) {
        Some(value) => format!("{} ms", js_round(value) as i64),
        None => NO_VALUE.to_string(),
    }
}

/// `formatTimelineSummary`.
pub fn format_timeline_summary(timeline: Fields) -> String {
    if !timeline.present() {
        return NO_VALUE.to_string();
    }
    let cold = match timeline.object("cold").0.as_bool() {
        Some(true) => " · cold",
        Some(false) => " · warm",
        None => "",
    };
    let origin = timeline
        .num("clickToOriginMs")
        .map(|ms| format!(" · {} ms click→engine", ms as i64))
        .unwrap_or_default();
    format!(
        "{} · {}{cold}{origin}",
        format_latency_ms(timeline.num("totalMs")),
        timeline.text("outcome").unwrap_or_default()
    )
}

/// `formatSlowestPhase` over `slowestTimelinePhase`.
pub fn format_slowest_phase(timeline: Fields) -> String {
    let marks = timeline
        .0
        .get("marks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut previous = 0.0;
    let mut slowest: Option<(String, f64)> = None;
    for mark in &marks {
        let mark = Fields(mark);
        let at = mark.count("atMs");
        let delta = (at - previous).max(0.0);
        previous = at;
        if slowest.as_ref().is_none_or(|(_, longest)| delta > *longest) {
            slowest = Some((mark.text("phase").unwrap_or_default().to_string(), delta));
        }
    }
    slowest.map_or_else(
        || NO_VALUE.to_string(),
        |(phase, delta)| format!("{phase} · {}", format_latency_ms(Some(delta))),
    )
}

/// `formatWebSocketQueue`.
pub fn format_web_socket_queue(queue: Fields) -> String {
    let oldest = queue
        .num("oldestAgeMs")
        .map_or_else(|| NO_VALUE.to_string(), |ms| format!("{} ms", ms as i64));
    format!(
        "{}/{} current/max · {oldest} oldest · {} coalesced · {} evicted/dropped",
        queue.count("currentDepth") as i64,
        queue.count("maxDepth") as i64,
        queue.count("coalescedCount") as i64,
        queue.count("evictedOrDroppedCount") as i64
    )
}

fn format_preview_source_status(
    state: &str,
    source_fps: Option<f64>,
    drops: Option<f64>,
) -> String {
    let fps = source_fps.map_or_else(|| NO_VALUE.to_string(), |fps| format!("{fps:.1} fps"));
    format!(
        "{}, {fps}, {}",
        preview_source_state_label(state),
        plural(drops.unwrap_or(0.0) as i64, "drop")
    )
}

/// `formatFfmpegStatus`: the recorder's version, or that it is missing.
pub fn format_ffmpeg_status(summary: &HealthSummary) -> String {
    match &summary.backend {
        None => "Checking…".to_string(),
        Some(health) if !health.ffmpeg.available => "Missing".to_string(),
        Some(health) => match health.ffmpeg.version.as_deref() {
            Some(version) if !version.is_empty() => format!("Ready · {version}"),
            _ => "Ready".to_string(),
        },
    }
}

fn format_ffmpeg_work(stats: Fields) -> String {
    if stats.flag("ffmpegMaintenanceCancelRequested") {
        return "Canceling file repair".to_string();
    }
    if stats.flag("ffmpegCaptureActive") {
        return "Capturing".to_string();
    }
    if stats.flag("ffmpegFinalizingActive") {
        return "Finishing a recording".to_string();
    }
    if stats.flag("ffmpegMaintenanceRunning") {
        return "Repairing files".to_string();
    }
    stats
        .text("ffmpegMaintenanceDeferredReason")
        .filter(|reason| !reason.is_empty())
        .unwrap_or("Idle")
        .to_string()
}

fn format_source_registry(stats: Fields) -> String {
    let entries = stats
        .object("sourceRegistry")
        .0
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if entries.is_empty() {
        return NO_VALUE.to_string();
    }
    entries
        .iter()
        .map(|entry| {
            let entry = Fields(entry);
            let key = entry.object("key");
            let consumers = entry.strings("consumers");
            format!(
                "{}:{} {} [{}] {}",
                key.text("kind").unwrap_or_default(),
                key.text("id").unwrap_or_default(),
                entry.text("status").unwrap_or_default(),
                if consumers.is_empty() {
                    "no consumers".to_string()
                } else {
                    consumers.join(", ")
                },
                entry.text("identityConfidence").unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn format_preview_transport(transport: Option<&str>) -> &'static str {
    match transport {
        Some("native-surface") => "Native",
        Some("d3d11-shared-texture") => "D3D11",
        Some("electron-proof-surface") => "Fallback window",
        Some("latest-jpeg-polling") => "JPEG",
        Some("mjpeg-stream") => "MJPEG",
        Some("cpu-shared-memory") => "CPU preview (shared memory)",
        _ => "Unavailable",
    }
}

fn format_preview_surface_backing(backing: Option<&str>) -> &'static str {
    match backing {
        Some("cametal-layer") => "CAMetalLayer",
        Some("directcomposition-swapchain") => "DirectComposition swap chain",
        Some("electron-browser-window") => "Browser window",
        Some("slint-image") => "Drawn by the app",
        // Plan 220 S4.2c: the Linux CPU preview's surfaces, by name.
        Some("wl-shm-subsurface") => "Wayland subsurface (shared memory)",
        Some("x11-shm-child-window") => "X11 child window (shared memory)",
        _ => NO_VALUE,
    }
}

fn format_encoder(encoder: Option<&str>) -> &'static str {
    match encoder {
        Some("software-x264") => "Software (x264)",
        Some("hardware-videotoolbox") => "Hardware (VideoToolbox)",
        Some("hardware-vaapi") => "Hardware (VAAPI)",
        Some("hardware-media-foundation") => "Hardware (MediaFoundation)",
        Some("software-media-foundation") => "Software (MediaFoundation)",
        Some("software-open-h264") => "Software (OpenH264)",
        Some("hardware-qsv") => "Hardware (Intel Quick Sync)",
        _ => NO_VALUE,
    }
}

/// `formatGraphicsPath`: the GPU path, or the CPU fallback with its reason.
fn format_graphics_path(stats: Fields) -> String {
    match stats.text("compositorBackend") {
        Some("metal") => "Metal".to_string(),
        Some("d3d11") => "D3D11".to_string(),
        Some("cpu") => "CPU".to_string(),
        Some("cpu-fallback") => {
            let frames = plural(stats.count("compositorCpuFallbackFrames") as i64, "frame");
            let reason = stats
                .text("compositorFallbackReason")
                .filter(|reason| !reason.is_empty())
                .map(|reason| format!(": {reason}"))
                .unwrap_or_default();
            format!("CPU fallback ({frames}){reason}")
        }
        _ => NO_VALUE.to_string(),
    }
}

fn format_image_polls(stats: Fields) -> String {
    let counts = stats.object("previewImagePollCounts");
    if !counts.present() {
        return NO_VALUE.to_string();
    }
    let n = |key| counts.count(key) as i64;
    let total = n("cameraPng")
        + n("screenPng")
        + n("productionPng")
        + n("cameraBmp")
        + n("screenBmp")
        + n("liveJpeg")
        + n("liveMjpeg");
    if total == 0 {
        return "0".to_string();
    }
    format!(
        "{total} (PNG camera {}, screen {}, program {}; BMP camera {}, screen {}; JPEG {}, MJPEG {})",
        n("cameraPng"),
        n("screenPng"),
        n("productionPng"),
        n("cameraBmp"),
        n("screenBmp"),
        n("liveJpeg"),
        n("liveMjpeg")
    )
}

fn format_source_fps(stats: Fields) -> String {
    let entries = stats.entries("previewSourceFps");
    if entries.is_empty() {
        return NO_VALUE.to_string();
    }
    entries
        .iter()
        .map(|(source, fps)| format!("{source}: {:.1}", fps.0.as_f64().unwrap_or(0.0)))
        .collect::<Vec<_>>()
        .join(", ")
}

/// One number in a group (`DiagnosticMetric`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Metric {
    pub label: String,
    pub value: String,
}

fn metric(label: impl Into<String>, value: impl Into<String>) -> Metric {
    Metric {
        label: label.into(),
        value: value.into(),
    }
}

/// One line of a log (`LogRow`): the level as a word, its code only when it
/// says more, the source, the time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogRowView {
    pub level: String,
    /// `destructive`, `warning` or `outline` (`levelBadgeVariant`).
    pub badge: &'static str,
    pub code: String,
    pub source: String,
    pub time: String,
    pub message: String,
}

fn level_badge(level: &str) -> &'static str {
    match level {
        "error" => "destructive",
        "warn" => "warning",
        _ => "outline",
    }
}

/// The engine's last exit (`LastEngineCrash`), a record of the past.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrashNote {
    pub intentional: bool,
    pub title: String,
    pub description: String,
}

/// One theme of numbers (`MetricGroup`): it opens itself while `attention`
/// holds, until the streamer opens or closes it by hand (the UI keeps that).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetricGroupView {
    pub id: &'static str,
    pub title: String,
    pub meta: String,
    pub attention: bool,
    pub metrics: Vec<Metric>,
    /// The Pipeline's stages: the stage, its detail, its state.
    pub stages: Vec<(String, String, CheckWords)>,
    /// A line in place of the content (nothing recording, no log lines).
    pub empty: String,
    /// `empty` carries the warning glyph (a log that didn't load).
    pub empty_warns: bool,
    /// The device list's warnings no Sources alert covers.
    pub warnings: Vec<String>,
    pub crash: Option<CrashNote>,
    /// A log's lines, oldest first.
    pub logs: Vec<LogRowView>,
    /// A log's lines are shown in a scroll box.
    pub is_log: bool,
    /// What was cut, under a log.
    pub note: String,
    /// S3.6a: the group's one button (Videorc Camera's Remove).
    pub action: Option<GroupAction>,
}

impl MetricGroupView {
    fn new(id: &'static str, title: impl Into<String>) -> Self {
        Self {
            id,
            title: title.into(),
            meta: String::new(),
            attention: false,
            metrics: Vec::new(),
            stages: Vec::new(),
            empty: String::new(),
            empty_warns: false,
            warnings: Vec::new(),
            crash: None,
            logs: Vec::new(),
            is_log: false,
            note: String::new(),
            action: None,
        }
    }
}

/// A group's one button (Videorc Camera's Remove), and whether it waits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupAction {
    pub label: String,
    pub disabled: bool,
}

/// Plan 220 S3.6a: what Health's Videorc Camera group reads (plan 214 E3).
#[derive(Debug, Clone, Copy, Default)]
pub struct CameraGroupInputs<'a> {
    pub status: Option<&'a VirtualCameraStatus>,
    /// `compositor.status`' frame pipeline, once read (unread: "–").
    pub pipeline: Option<&'a CompositorFramePipelineStatus>,
    /// The Studio's link to Videorc.
    pub connected: bool,
    /// Remove Videorc Camera runs.
    pub removing: bool,
}

/// `VideorcCameraMetrics`: the state, the apps using it and what its output
/// did (A4's counters); on macOS, Remove Videorc Camera. Not there where
/// this computer can't have the camera (the hide rule).
pub fn camera_group(camera: &CameraGroupInputs, platform: &str) -> Option<MetricGroupView> {
    let status = camera
        .status
        .filter(|status| !camera_hidden(Some(status)))?;
    let mut group = MetricGroupView::new("videorc-camera", VIDEORC_CAMERA);
    group.attention = !status.available || status.state == VirtualCameraState::Unavailable;
    // A4 leaves each counter off the wire while it is 0; unread is "–".
    let pipeline = camera.pipeline;
    let counter = |value: Option<u64>| match pipeline {
        Some(_) => format_optional_counter(Some(value.unwrap_or(0) as f64)),
        None => NO_VALUE.to_string(),
    };
    group.metrics = vec![
        metric("State", camera_copy::state_label(status.state)),
        metric(
            "Apps using it",
            status.viewers.map_or_else(
                || NO_VALUE.to_string(),
                |viewers| plural(i64::from(viewers), "app"),
            ),
        ),
        metric(
            "Frames sent",
            counter(pipeline.map(|pipeline| pipeline.virtual_camera_pushed)),
        ),
        metric(
            "Repeated frames",
            counter(pipeline.map(|pipeline| pipeline.virtual_camera_repeated)),
        ),
        metric(
            "Slowest conversion",
            match pipeline {
                Some(pipeline) => format_ms(Some(pipeline.virtual_camera_convert_ms_max)),
                None => NO_VALUE.to_string(),
            },
        ),
    ];
    if platform == "darwin" && status.available {
        group.action = Some(GroupAction {
            label: camera_copy::REMOVE.to_string(),
            disabled: !camera.connected || camera.removing,
        });
    }
    Some(group)
}

/// Remove Videorc Camera's answer: "Videorc Camera removed" (with what the
/// removal said), or why it didn't go.
pub fn camera_removal_notice(ok: bool, message: Option<&str>) -> NoticeCommand {
    let request = if ok {
        ToastRequest::success(camera_copy::REMOVED).maybe_description(message.map(str::to_string))
    } else {
        ToastRequest::error("Couldn't remove Videorc Camera")
            .description(message.unwrap_or("Try again in a moment."))
    };
    NoticeCommand::Show(request.finish())
}

/// `backendCrashExitLabel`.
pub fn crash_exit_label(record: &CrashRecord) -> String {
    if let Some(signal) = &record.signal {
        return format!("signal {signal}");
    }
    match (record.code, &record.windows_status) {
        (Some(code), Some(status)) => format!("code 0x{:08X} {status}", code as u32),
        (Some(code), None) => format!("code {code}"),
        (None, _) => "unknown exit".to_string(),
    }
}

/// `formatBackendUptime`.
pub fn format_backend_uptime(uptime_ms: u64) -> String {
    let ms = uptime_ms as f64;
    if ms < 1_000.0 {
        format!("{}ms", js_round(ms).max(0.0) as u64)
    } else if ms < 60_000.0 {
        format!("{:.1}s", ms / 1_000.0)
    } else if ms < 3_600_000.0 {
        format!("{}min", js_round(ms / 60_000.0) as u64)
    } else {
        format!("{:.1}h", ms / 3_600_000.0)
    }
}

/// `backendCrashView`'s headline: the Rust panic hook's line when the tail
/// has one, otherwise the last line the process printed.
pub fn crash_headline(record: &CrashRecord) -> Option<String> {
    for line in record.stderr_tail.iter().rev() {
        let trimmed = line.trim();
        if !trimmed.starts_with("{\"panic\":") {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let Some(message) = parsed.get("panic").and_then(Value::as_str) else {
            continue;
        };
        let location = parsed
            .get("location")
            .and_then(Value::as_str)
            .map(|location| format!(" ({location})"))
            .unwrap_or_default();
        return Some(format!("panic: {message}{location}"));
    }
    record.stderr_tail.last().cloned()
}

/// `LastEngineCrash`'s words.
pub fn crash_note(record: &CrashRecord) -> CrashNote {
    let title = format!(
        "{} at {}",
        if record.intentional {
            copy::ENGINE_RESTARTED
        } else {
            copy::ENGINE_STOPPED
        },
        compact_time(&record.at)
    );
    let attempt = record
        .attempt
        .map(|attempt| format!(" · restart {attempt}"))
        .unwrap_or_default();
    let description = [
        format!(
            "Run {} · {} · after {}{attempt}",
            record.generation,
            crash_exit_label(record),
            format_backend_uptime(record.uptime_ms)
        ),
        crash_headline(record).unwrap_or_else(|| copy::ENGINE_PRINTED_NOTHING.to_string()),
        copy::crash_bundle_note(record.stderr_tail.len()),
    ]
    .join("\n");
    CrashNote {
        intentional: record.intentional,
        title,
        description,
    }
}

/// The recording log the page shows: whose it is and how far it loaded.
#[derive(Debug, Clone, Default)]
pub struct RecordingLog {
    /// The session the log belongs to: the current one, else the newest.
    pub session_id: Option<String>,
    pub title: Option<String>,
    /// The session's own count of log lines (`sessionLogCount`).
    pub log_count: u64,
    /// The session is the one recording now.
    pub current: bool,
    pub loading: bool,
    pub failed: bool,
    pub entries: Vec<SessionLogEntry>,
}

/// Everything the page reads besides the diagnostics.
pub struct PageInputs<'a> {
    pub telemetry: &'a HealthTelemetry,
    pub summary: &'a HealthSummary,
    /// The capture config's sources (`captureConfig.sources`).
    pub capture_sources: Fields<'a>,
    pub native_preview_surface_enabled: bool,
    /// Electron's `process.platform`: `darwin`, `win32` or `linux`.
    pub platform: &'a str,
    /// A development build (`import.meta.env.DEV`).
    pub development: bool,
    pub pipeline: Option<&'a RecordingPipelineStatus>,
    pub device_warnings: &'a [String],
    pub recording_log: &'a RecordingLog,
    pub app_log: &'a [LogLine],
    pub crash: Option<&'a CrashRecord>,
    /// S3.1a: the last click-to-status samples (`recordLatency`).
    pub record_latency: &'a super::latency::RecordLatency,
    /// S3.6a: Videorc Camera's group.
    pub camera: CameraGroupInputs<'a>,
    pub now: Instant,
}

/// The page, ready to draw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthPageView {
    pub verdict: HealthVerdict,
    pub checks: Vec<HealthCheck>,
    pub ffmpeg_missing: Option<&'static str>,
    pub groups: Vec<MetricGroupView>,
}

/// The view's platform word for `cfg!(target_os)`.
pub fn current_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

/// `unknownDeviceWarnings`: what the device list reported that no Sources
/// alert covers (the permission warnings are Sources' own).
pub fn unknown_device_warnings(warnings: &[String]) -> Vec<String> {
    warnings
        .iter()
        .filter(|warning| !is_permission_warning(warning))
        .cloned()
        .collect()
}

/// `PERMISSION_WARNING` (`lib/source-status.ts`):
/// `/(camera|microphone|screen recording) permission/i`.
fn is_permission_warning(warning: &str) -> bool {
    let lower = warning.to_lowercase();
    [
        "camera permission",
        "microphone permission",
        "screen recording permission",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// `DiagnosticsTab`, as data.
pub fn health_page(inputs: &PageInputs) -> HealthPageView {
    let telemetry = inputs.telemetry;
    let stats = Fields::of(telemetry.diagnostics.as_ref());
    let stream = Fields::of(telemetry.stream_health.as_ref());
    let sources = inputs.capture_sources;
    let preview = PreviewInputs {
        stats,
        expects_camera: sources.text("cameraId").is_some_and(|id| !id.is_empty()),
        expects_screen: sources.text("screenId").is_some_and(|id| !id.is_empty())
            || sources.text("windowId").is_some_and(|id| !id.is_empty()),
        native_preview_surface_enabled: inputs.native_preview_surface_enabled,
        platform: inputs.platform,
        camera: Fields::of(telemetry.preview_camera.as_ref()),
        live: Fields::of(telemetry.preview_live.as_ref()),
        screen: Fields::of(telemetry.preview_screen.as_ref()),
        surface: Fields::of(telemetry.preview_surface.as_ref()),
    };
    let destination_states: Vec<&str> = telemetry
        .stream_targets
        .iter()
        .filter_map(|target| target.get("state").and_then(Value::as_str))
        .collect();
    let checks = health_checks(
        &preview,
        stream,
        &destination_states,
        telemetry.capture_dropping(inputs.now),
    );
    let advice = camera_no_video_advice(preview.camera, sources.text("cameraName"))
        .or_else(|| slowdown_advice(stats.text("bottleneck").unwrap_or("none")).map(str::to_string))
        .or_else(|| {
            stats
                .flag("recordingAtRisk")
                .then(|| RECORDING_AT_RISK_ADVICE.to_string())
        });
    let verdict = health_verdict(&checks, &[], advice);
    let needs = |ids: &[&str]| {
        checks
            .iter()
            .any(|check| ids.contains(&check.id) && check_needs_attention(check.tone))
    };
    let ffmpeg_missing = inputs
        .summary
        .backend
        .as_ref()
        .is_some_and(|health| !health.ffmpeg.available);
    let mac = inputs.platform == "darwin";
    let device_warnings = unknown_device_warnings(inputs.device_warnings);

    let mut groups = Vec::new();

    let mut overview = MetricGroupView::new("overview", "Overview");
    overview.attention = needs(&["recording", "slowdown", "encoder"]);
    overview.metrics = overview_metrics(stats, stream);
    groups.push(overview);

    let mut start_stop = MetricGroupView::new("start-and-stop", "Start and stop");
    let start = stats.object("recordingStartTimeline");
    let stop = stats.object("recordingStopTimeline");
    start_stop.metrics = vec![
        // S3.1a: the click-to-status samples (`recordLatency.start` and
        // `.stop`), the placeholder before a take.
        metric(
            "Click → recording",
            format_latency_ms(
                inputs
                    .record_latency
                    .start
                    .as_ref()
                    .map(|sample| sample.to_done_ms as f64),
            ),
        ),
        metric(
            "Click → idle",
            format_latency_ms(
                inputs
                    .record_latency
                    .stop
                    .as_ref()
                    .map(|sample| sample.to_done_ms as f64),
            ),
        ),
        metric("Start timeline", format_timeline_summary(start)),
        metric("Slowest start phase", format_slowest_phase(start)),
        metric("Stop timeline", format_timeline_summary(stop)),
        metric("Slowest stop phase", format_slowest_phase(stop)),
    ];
    groups.push(start_stop);

    let mut connection = MetricGroupView::new("app-connection", "App connection");
    connection.metrics = connection_metrics(stats.object("websocketTransport"));
    groups.push(connection);

    let mut preview_group = MetricGroupView::new("preview", "Preview");
    preview_group.attention = needs(&[
        "camera",
        "screen",
        "preview",
        "preview-speed",
        "preview-path",
    ]);
    preview_group.metrics = preview_metrics(&preview, mac);
    groups.push(preview_group);

    let mut encoder = MetricGroupView::new("recording-and-encoder", "Recording and encoder");
    encoder.attention = needs(&["recording", "encoder"]) || ffmpeg_missing;
    encoder.metrics = encoder_metrics(stats, stream, inputs.summary, mac);
    groups.push(encoder);

    let mut system = MetricGroupView::new("system-and-sources", "System and sources");
    system.attention = needs(&["sources", "memory"]) || !device_warnings.is_empty();
    system.metrics = system_metrics(stats);
    system.warnings = device_warnings;
    groups.push(system);
    if let Some(camera) = camera_group(&inputs.camera, inputs.platform) {
        groups.push(camera);
    }

    let mut pipeline = MetricGroupView::new("pipeline", "Pipeline");
    match inputs.pipeline {
        Some(status) => {
            pipeline.attention = status
                .stages
                .iter()
                .any(|stage| stage.state == RecordingPipelineStageState::Failed);
            pipeline.stages = status
                .stages
                .iter()
                .map(|stage| {
                    (
                        pipeline_stage_label(&stage.stage).to_string(),
                        stage.detail.clone().unwrap_or_default(),
                        pipeline_state_words(&stage.state),
                    )
                })
                .collect();
        }
        None => pipeline.empty = copy::NOTHING_RECORDING.to_string(),
    }
    groups.push(pipeline);

    groups.push(recording_log_group(inputs.recording_log));
    groups.push(app_log_group(inputs.app_log, inputs.crash));

    HealthPageView {
        verdict,
        checks,
        ffmpeg_missing: ffmpeg_missing.then_some(if inputs.development {
            copy::FFMPEG_MISSING_DEV
        } else {
            copy::FFMPEG_MISSING_PACKAGED
        }),
        groups,
    }
}

fn overview_metrics(stats: Fields, stream: Fields) -> Vec<Metric> {
    let mut metrics = Vec::new();
    if stats.flag("recordingAtRisk") {
        let reasons = stats.strings("recordingRiskReasons").join("; ");
        metrics.push(metric(
            "Why the recording is at risk",
            if reasons.is_empty() {
                NO_VALUE.to_string()
            } else {
                reasons
            },
        ));
    }
    let queue = |role: &str| {
        let key = |part: &str| format!("encoderBridge{role}Queue{part}");
        format!(
            "{} · {} oldest · {} pressure · {} dropped",
            stats.count(&key("Depth")) as i64,
            format_metric(stats.num(&key("OldestFrameAgeMs")), "ms"),
            stats.count(&key("CapacityPressureEvents")) as i64,
            stats.count(&key("DroppedFrames")) as i64
        )
    };
    metrics.extend([
        metric(
            "Output mode",
            stats
                .text("activeOutputMode")
                .filter(|mode| !mode.is_empty())
                .map_or_else(|| "Idle".to_string(), status_word_from_value),
        ),
        metric(
            "Target frame rate",
            truthy(stats.num("targetFps")).map_or_else(|| NO_VALUE.to_string(), format_frame_rate),
        ),
        metric(
            "Scene version",
            stats.num("activeSceneRevision").map_or_else(
                || NO_VALUE.to_string(),
                |revision| (revision as i64).to_string(),
            ),
        ),
        metric(
            "Capture FPS",
            format_metric(stats.num("captureFps").or(stream.num("fps")), "fps"),
        ),
        metric(
            "Render FPS",
            format_metric(stats.num("renderFps").or(stream.num("fps")), "fps"),
        ),
        metric(
            "Skipped frames",
            (stats.count("skippedFrames") as i64).to_string(),
        ),
        metric(
            "Dropped frames",
            format_dropped_frames(dropped_or_health(stats, stream)),
        ),
        metric(
            "Encoder speed",
            format_metric(stats.num("encoderSpeed").or(stream.num("speed")), "x"),
        ),
        metric(
            "Bridge queue",
            (stats.count("encoderBridgeQueueDepth") as i64).to_string(),
        ),
        metric("Recording queue", queue("Recording")),
        metric("Stream queue", queue("Stream")),
        metric(
            "Bridge FPS",
            format_metric(stats.num("encoderBridgeInputFps"), "fps"),
        ),
        metric(
            "Bridge drops",
            (stats.count("encoderBridgeDroppedFrames") as i64).to_string(),
        ),
        metric(
            "Bridge error",
            stats
                .text("encoderBridgeError")
                .unwrap_or(NO_VALUE)
                .to_string(),
        ),
    ]);
    metrics
}

fn connection_metrics(transport: Fields) -> Vec<Metric> {
    let mut metrics = vec![
        metric(
            "Reliable responses",
            format_web_socket_queue(transport.object("reliableResponseQueue")),
        ),
        metric(
            "Incoming commands",
            format_web_socket_queue(transport.object("incomingCommandQueue")),
        ),
        metric(
            "Coalesced telemetry",
            format_web_socket_queue(transport.object("coalescedTelemetryQueue")),
        ),
        metric(
            "Slow-peer disconnects",
            (transport.count("slowPressureDisconnectCount") as i64).to_string(),
        ),
    ];
    for (lane, stats) in transport.entries("commandLanes") {
        metrics.push(metric(
            format!("{} lane", status_word_from_value(lane)),
            format!(
                "{} · {} expired · {} rejected",
                format_web_socket_queue(stats.object("queue")),
                stats.count("expiredBeforeDispatchCount") as i64,
                stats.count("rejectedBeforeDispatchCount") as i64
            ),
        ));
    }
    metrics
}

fn preview_metrics(input: &PreviewInputs, mac: bool) -> Vec<Metric> {
    let stats = input.stats;
    let mut metrics = vec![
        metric(
            "Preview mode",
            format_preview_transport(stats.text("previewTransport")),
        ),
        metric("Graphics", format_graphics_path(stats)),
        metric("Preview source FPS", format_source_fps(stats)),
        metric(
            "Preview present FPS",
            format_metric(stats.num("previewPresentFps"), "fps"),
        ),
        metric(
            "Preview target",
            format_metric(stats.num("previewTargetFps"), "fps"),
        ),
        metric("Preview cadence", format_ms(stats.num("previewLatencyMs"))),
        metric("Preview age", format_ms(stats.num("previewFrameAgeMs"))),
        metric(
            "Input to present",
            format_ms(stats.num("previewInputToPresentLatencyMs")),
        ),
        metric(
            "Render p95",
            format_ms(stats.num("previewRenderFrameTimeP95Ms")),
        ),
        metric(
            "Tick gap p95",
            format_ms(stats.num("compositorTickGapP95Ms")),
        ),
        metric(
            "Tick gap max",
            format_ms(stats.num("compositorTickGapMaxMs")),
        ),
        metric(
            "Source fetch p95",
            format_ms(stats.num("compositorSourceFetchP95Ms")),
        ),
    ];
    if mac {
        metrics.push(metric(
            "Metal p95",
            format_ms(stats.num("compositorGpuTotalP95Ms")),
        ));
    }
    metrics.extend([
        metric(
            "Preview lag",
            format_frame_lag(stats.num("previewCompositorFrameLag")),
        ),
        metric(
            "Preview drops",
            (stats.count("previewDroppedFrames") as i64).to_string(),
        ),
        metric(
            "Camera age",
            format_ms(
                stats
                    .num("previewCameraFrameAgeMs")
                    .or(input.camera.num("frameAgeMs")),
            ),
        ),
        metric(
            "Screen age",
            format_ms(
                stats
                    .num("previewScreenFrameAgeMs")
                    .or(input.screen.num("frameAgeMs")),
            ),
        ),
        metric(
            "Repeated frames",
            (stats.count("previewRepeatedFrames") as i64).to_string(),
        ),
        metric(
            "Surface resizes",
            (stats.count("previewSurfaceResizeCount") as i64).to_string(),
        ),
        metric(
            "Camera source",
            format_preview_source_status(
                input.camera_state(),
                stats
                    .num("previewCameraSourceFps")
                    .or(input.camera.num("sourceFps")),
                stats
                    .num("previewCameraDroppedFrames")
                    .or(input.camera.num("droppedFrames")),
            ),
        ),
        metric(
            "Screen source",
            format_preview_source_status(
                input.screen_state(),
                stats
                    .num("previewScreenSourceFps")
                    .or(input.screen.num("sourceFps")),
                stats
                    .num("previewScreenDroppedFrames")
                    .or(input.screen.num("droppedFrames")),
            ),
        ),
        metric(
            "Surface state",
            format!(
                "{}, {}",
                status_word_from_value(input.surface.text("state").unwrap_or("unavailable")),
                plural(input.surface.count("framesRendered") as i64, "frame")
            ),
        ),
        metric(
            "Surface backing",
            format_preview_surface_backing(
                stats
                    .text("previewSurfaceBacking")
                    .or(input.surface.text("backing")),
            ),
        ),
    ]);
    metrics
}

fn encoder_metrics(
    stats: Fields,
    stream: Fields,
    summary: &HealthSummary,
    mac: bool,
) -> Vec<Metric> {
    let c = |key: &str| (stats.count(key) as i64).to_string();
    let ms = |key: &str| format_ms(stats.num(key));
    let mut metrics = vec![
        metric("FFmpeg", format_ffmpeg_status(summary)),
        metric("Microphone drops", c("micDroppedFrames")),
        metric(
            "Microphone coverage",
            format_coverage(stats.num("micCaptureCoverage")),
        ),
        metric("Encoder", format_encoder(stats.text("encodeBackend"))),
        metric(
            "Requested output",
            stats
                .text("encoderBridgeRequestedVideoOutput")
                .unwrap_or(NO_VALUE),
        ),
        metric(
            "Effective output",
            stats
                .text("encoderBridgeEffectiveVideoOutput")
                .unwrap_or(NO_VALUE),
        ),
        metric(
            "Output fallback",
            stats
                .text("encoderBridgeEncodedOutputFallbackReason")
                .unwrap_or(NO_VALUE),
        ),
        metric(
            "Stream bitrate",
            format_kbps(stats.num("streamMeasuredBitrateKbps")),
        ),
        metric(
            "Stream bitrate range",
            format!(
                "{} / {}",
                format_kbps(stats.num("streamMeasuredBitrateMinKbps")),
                format_kbps(stats.num("streamMeasuredBitrateMaxKbps"))
            ),
        ),
        metric(
            "Stream bytes",
            format_bytes(stats.num("streamOutputTotalBytes")),
        ),
        metric(
            "Stream duplicated",
            format_optional_counter(stats.num("streamDuplicatedFrames")),
        ),
        metric(
            "Stream dropped",
            format_optional_counter(stream.num("droppedFrames").or(stats.num("droppedFrames"))),
        ),
        metric(
            "Stream coalesced",
            format_optional_counter(if stats.flag("encoderBridgeSeparateOutputEncodersActive") {
                stats.num("encoderBridgeStreamQueueDroppedFrames")
            } else {
                stats.num("encoderBridgeOutputQueueDroppedFrames")
            }),
        ),
        metric("Recording repeats", c("encoderBridgeRepeatedFrames")),
        metric("Repeat bursts", c("encoderBridgeRepeatedFrameBursts")),
        metric("Repeat max run", c("encoderBridgeMaxRepeatedFrameRun")),
        metric("Synthetic frames", c("encoderBridgeSyntheticFrames")),
        metric("Bridge source age", ms("encoderBridgeSourceAgeMs")),
        metric("Source age p95", ms("encoderBridgeSourceAgeP95Ms")),
        metric("Repeat age p95", ms("encoderBridgeRepeatedFrameAgeP95Ms")),
        metric("Bridge wait p95", ms("encoderBridgeCompositorWaitP95Ms")),
        metric("Writer total p95", ms("encoderBridgeWriterLoopP95Ms")),
        metric("Writer active p95", ms("encoderBridgeWriterActiveP95Ms")),
    ];
    if mac {
        metrics.extend([
            metric(
                "FIFO enqueue p95",
                ms("encoderBridgeVideoToolboxFifoEnqueueP95Ms"),
            ),
            metric(
                "FIFO enqueue max",
                ms("encoderBridgeVideoToolboxFifoEnqueueMaxMs"),
            ),
        ]);
    }
    metrics.extend([
        metric(
            "Record writer p95",
            ms("encoderBridgeRecordingWriterLoopP95Ms"),
        ),
        metric(
            "Stream writer p95",
            ms("encoderBridgeStreamWriterLoopP95Ms"),
        ),
        metric(
            "Deadline lag",
            format!(
                "{} / {}",
                ms("encoderBridgeDeadlineLagP95Ms"),
                c("encoderBridgeLateDeadlineTicks")
            ),
        ),
    ]);
    if mac {
        metrics.extend([
            metric("Metal targets", c("encoderBridgeMetalTargetFrames")),
            metric(
                "VT probe",
                format!(
                    "{} / {}",
                    c("encoderBridgeVideoToolboxProbeFrames"),
                    format_bytes(stats.num("encoderBridgeVideoToolboxProbeBytes"))
                ),
            ),
            metric(
                "VT output",
                format!(
                    "{} / {}",
                    c("encoderBridgeVideoToolboxOutputFrames"),
                    format_bytes(stats.num("encoderBridgeVideoToolboxOutputBytes"))
                ),
            ),
            metric(
                "VT encode max",
                ms("encoderBridgeVideoToolboxOutputEncodeMs"),
            ),
        ]);
    }
    metrics
}

fn system_metrics(stats: Fields) -> Vec<Metric> {
    let duplicates = stats.strings("duplicateCaptureSources").join(", ");
    vec![
        metric("Image polls", format_image_polls(stats)),
        metric(
            "Device state",
            if stats.flag("deviceDisconnected") {
                "Disconnected"
            } else {
                "Connected"
            },
        ),
        metric("FFmpeg work", format_ffmpeg_work(stats)),
        metric(
            "FFmpeg processes",
            (stats.count("activeFfmpegProcesses") as i64).to_string(),
        ),
        metric(
            "FFprobe processes",
            (stats.count("activeFfprobeProcesses") as i64).to_string(),
        ),
        metric("Engine memory", format_bytes(stats.num("backendRssBytes"))),
        metric(
            "Duplicate capture",
            if duplicates.is_empty() {
                NO_VALUE.to_string()
            } else {
                duplicates
            },
        ),
        metric(
            "Source try-locks",
            format!(
                "Camera {}, screen {}",
                stats.count("compositorCameraSourceTryLockMisses") as i64,
                stats.count("compositorScreenSourceTryLockMisses") as i64
            ),
        ),
        metric(
            "Source frame store",
            format!(
                "{}, {}, {} replaced",
                plural(
                    stats.count("previewSourceFrameBufferCount") as i64,
                    "buffer"
                ),
                format_bytes(stats.num("previewSourceFrameBytes")),
                stats.count("previewSourceFrameDroppedFrames") as i64
            ),
        ),
        metric("Source registry", format_source_registry(stats)),
    ]
}

fn session_log_row(entry: &SessionLogEntry) -> LogRowView {
    let level = match entry.level {
        HealthLevel::Info => "info",
        HealthLevel::Warn => "warn",
        HealthLevel::Error => "error",
    };
    LogRowView {
        level: log_level_label(level),
        badge: level_badge(level),
        code: if entry.code != level {
            entry.code.clone()
        } else {
            String::new()
        },
        source: entry.source_id.clone().unwrap_or_default(),
        time: compact_time(&entry.created_at),
        message: entry.message.clone(),
    }
}

fn recording_log_group(log: &RecordingLog) -> MetricGroupView {
    let mut group = MetricGroupView::new(
        "recording-log",
        if log.current {
            copy::LOG_OF_THIS_RECORDING
        } else {
            copy::LOG_OF_THE_LAST_RECORDING
        },
    );
    group.is_log = true;
    group.meta = log.title.clone().unwrap_or_default();
    let shown = log.entries.len().min(RECORDING_LOG_LIMIT);
    group.note = log_truncation_note(shown, log.entries.len().max(log.log_count as usize))
        .unwrap_or_default();
    if log.session_id.is_none() {
        group.empty = copy::NO_RECORDINGS.to_string();
    } else if log.loading && log.entries.is_empty() {
        group.empty = copy::LOADING_LOG.to_string();
    } else if log.failed && log.entries.is_empty() {
        group.empty = copy::LOG_FAILED.to_string();
        group.empty_warns = true;
    } else if log.entries.is_empty() {
        group.empty = copy::LOG_EMPTY.to_string();
    } else {
        group.logs = log.entries[log.entries.len() - shown..]
            .iter()
            .map(session_log_row)
            .collect();
    }
    group
}

fn app_log_group(lines: &[LogLine], crash: Option<&CrashRecord>) -> MetricGroupView {
    let mut group = MetricGroupView::new("app-log", copy::APP_LOG);
    group.is_log = true;
    group.meta = plural(lines.len() as i64, "line");
    group.crash = crash.map(crash_note);
    if lines.len() >= APP_LOG_LIMIT {
        group.note = copy::app_log_cut(APP_LOG_LIMIT);
    }
    if lines.is_empty() {
        group.empty = copy::APP_LOG_EMPTY.to_string();
    } else {
        group.logs = lines[lines.len().saturating_sub(APP_LOG_LIMIT)..]
            .iter()
            .map(|line| {
                let level = line.level.as_str();
                LogRowView {
                    level: log_level_label(level),
                    badge: level_badge(level),
                    code: String::new(),
                    source: String::new(),
                    time: compact_time(&line.timestamp),
                    message: line.message.clone(),
                }
            })
            .collect();
    }
    group
}

// ── the Studio's capture alert (`lib/studio-health.ts`) ──────────────────

/// `StudioHealth`: the Studio's at-a-glance preview health.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StudioHealth {
    pub tone: Tone,
    pub value: &'static str,
    pub detail: Option<&'static str>,
}

const PREVIEW_PRESENT_BUDGET_P95_MS: f64 = 75.0;
const PREVIEW_PRESENT_BUDGET_P99_MS: f64 = 150.0;

/// `studioHealth`: Degraded whenever the compositor fell back to the CPU
/// (the Studio's capture alert, whose door is Open Health); Fallback and
/// Lagging as warnings; quiet otherwise.
pub fn studio_health(
    stats: Fields,
    active: bool,
    platform: &str,
    host_kind: Option<&str>,
) -> StudioHealth {
    let native_expected = platform == "darwin" || platform == "win32";
    let transport = stats.text("previewTransport");
    let native_live = is_native_preview_capability(
        transport,
        stats.text("previewSurfaceBacking"),
        host_kind,
        platform,
    );
    if stats.text("compositorBackend") == Some("cpu-fallback")
        || (active && native_expected && stats.count("compositorCpuFallbackFrames") > 0.0)
    {
        return StudioHealth {
            tone: Tone::Error,
            value: "Degraded",
            detail: Some(
                "The preview may not match your recording. Videorc is drawing it without the graphics card, so it can stutter.",
            ),
        };
    }
    if native_expected
        && !native_live
        && matches!(
            transport,
            Some(
                "latest-jpeg-polling"
                    | "mjpeg-stream"
                    | "electron-proof-surface"
                    | "native-surface"
                    | "d3d11-shared-texture"
            )
        )
    {
        return StudioHealth {
            tone: Tone::Warn,
            value: "Fallback",
            detail: Some("The preview is on a fallback path, so it may stutter."),
        };
    }
    if stats
        .num("previewInputToPresentLatencyP95Ms")
        .is_some_and(|p95| p95 > PREVIEW_PRESENT_BUDGET_P95_MS)
        || stats
            .num("previewInputToPresentLatencyP99Ms")
            .is_some_and(|p99| p99 > PREVIEW_PRESENT_BUDGET_P99_MS)
    {
        return StudioHealth {
            tone: Tone::Warn,
            value: "Lagging",
            detail: Some("The preview is running behind what you do."),
        };
    }
    if stats
        .text("compositorBackend")
        .is_none_or(|backend| backend.is_empty())
    {
        return StudioHealth {
            tone: Tone::Neutral,
            value: "Idle",
            detail: None,
        };
    }
    StudioHealth {
        tone: Tone::Good,
        value: if active { "Running" } else { "Ready" },
        detail: None,
    }
}

#[cfg(test)]
#[path = "health_page_tests.rs"]
mod tests;
