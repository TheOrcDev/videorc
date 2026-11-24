//! The Sources page as data (plan 220 S3.4a, caught up in plan 260 S1.6b
//! part 5b): `components/tabs/sources-tab.tsx`,
//! `components/sources/video-sources.tsx`, `source-item.tsx` and
//! `source-permission-alerts.tsx`, with the rules they read
//! (`lib/source-status.ts`, `lib/source-facts.ts`,
//! `lib/screen-share-recovery.ts`, `lib/source-permissions.ts`,
//! `lib/camera-format-shortfall.ts`, `lib/camera-frame-rate.ts`).
//!
//! The page is the home of every capture device (one home per control). Its
//! header says what the page is for and holds Refresh; the permission
//! alerts lead it (one per missing grant, each with the one action that
//! fixes it, and a quiet line when the device list holds anything else);
//! then the Video column (Screen and Camera, each one source item: the
//! glyph, the title, the status chip, the picker with the live switch's
//! line, the facts or the camera's format shortfall, the chip's hint) and
//! the Audio column ([`super::sources_audio`]).
//!
//! Part 5b adds Electron's newer pieces: the Screen item says whose screen
//! it is (the scene on stream, plan 231 D2) with Open Scenes (D8); the
//! Camera item has the Low-light compensation switch (issue #1066,
//! [`super::camera_low_light`]) where the camera has the control, and its
//! low frame rate line names the switch while it is on.
//!
//! The grants the alerts read are Settings → Permissions' rows
//! ([`PermissionInputs`]); L4's system access reads them, and the page only
//! words them.
//!
//! The picks themselves are the Studio's (`source_selection`,
//! `source_actions`): the page and the Studio's Sources mirror choose
//! through the same core state, so the two never disagree.

use serde_json::Value;
use videorc_protocol::{Device, DeviceStatus};

use super::StudioSnapshot;
use super::camera_frame_rate::{
    CameraLowFrameRate, camera_expected_fps, camera_low_frame_rate_line,
};
use super::camera_low_light;
use super::health::HealthTelemetry;
use super::health_page::format_frame_rate;
use super::live_sources::switch_status_line;
use super::source_selection::{
    PickerInput, SourceKind, SourceStandIn, camera_picker_devices, capture_picker_devices,
    picker_view, source_stand_in, stand_in_line,
};
use super::sources_section::SourceRowView;
use crate::desktop::permissions::SystemPermissionPane;
use crate::scenes::v2::layout_shows_screen;

/// The page's words (P3-D2: Electron's exactly).
pub mod copy {
    pub const TITLE: &str = "Sources";
    pub const REFRESH: &str = "Refresh";
    pub const REFRESHING: &str = "Refreshing…";
    pub const REFRESH_TOOLTIP: &str = "Look again for screens, windows, cameras and microphones";
    pub const VIDEO: &str = "Video";
    pub const VIDEO_DESCRIPTION: &str = "What people see.";
    pub const VIDEO_DESCRIPTION_LIVE: &str =
        "What people see. A new source takes over once it sends fresh frames.";
    /// The screen picker's name (`label="Screen / window"`, hidden).
    pub const SCREEN_PICKER: &str = "Screen / window";
    pub const SYNTHETIC: &str = "Synthetic diagnostic source";
    pub const SYNTHETIC_DESCRIPTION: &str =
        "Development only. A frame-number and timecode screen for regression tests.";
    pub const DEVICE_PROBLEM: &str = "Videorc couldn't check every device.";
    pub const DESCRIPTION: &str = "What gets recorded and streamed. Changes apply live.";
    pub const DESCRIPTION_LINUX: &str = "What gets recorded and streamed. On Linux, change them while nothing is recording or live.";
    /// `SOURCE_RECEIVING_LABEL`.
    pub const RECEIVING: &str = "Receiving";
    /// `SOURCE_STAND_IN_LABEL`.
    pub const STAND_IN: &str = "Stand-in";
    /// `SCREEN_SHARE_DIALOG_PENDING_MESSAGE` (the backend's).
    pub const SHARE_DIALOG_PENDING: &str =
        "Waiting for you to choose a screen in the share dialog.";
    /// The pickers' "no device" items (`noneLabel`).
    pub const NONE: &str = "None";
    pub const OFF: &str = "Off";
    /// `SCREEN_SHARE_DIALOG_LOST_MESSAGE` (the backend's).
    pub const SHARE_DIALOG_LOST: &str =
        "The screen share dialog closed unexpectedly. Choose your screen again.";
    /// The Screen item's door to Studio's Scenes section (plan 231 D8).
    pub const OPEN_SCENES: &str = "Open Scenes";
}

/// `sourcesPageDescription(platform)`.
pub fn sources_page_description(platform: &str) -> &'static str {
    if platform == "linux" {
        copy::DESCRIPTION_LINUX
    } else {
        copy::DESCRIPTION
    }
}

/// `StatusTone` of a source's chip.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ChipTone {
    #[default]
    Neutral,
    Good,
    Warn,
    Error,
}

impl ChipTone {
    pub fn as_str(self) -> &'static str {
        match self {
            ChipTone::Neutral => "neutral",
            ChipTone::Good => "good",
            ChipTone::Warn => "warn",
            ChipTone::Error => "error",
        }
    }
}

/// `SourceStatus`: the header's one chip and what to do about it, in words
/// (a visible line in the row's body, plan 174 C-10).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SourceStatus {
    pub label: String,
    pub tone: ChipTone,
    pub hint: Option<String>,
}

impl SourceStatus {
    pub fn new(label: impl Into<String>, tone: ChipTone) -> Self {
        Self {
            label: label.into(),
            tone,
            hint: None,
        }
    }

    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

/// `SelectedDeviceStatus`: the selected device's listing, or `Missing`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectedDevice {
    Listed(DeviceStatus),
    Missing,
}

/// `selectedDeviceStatus(devices, selectedId)`.
pub fn selected_device_status(
    devices: &[Device],
    selected: Option<&str>,
) -> Option<SelectedDevice> {
    let selected = selected?;
    Some(
        devices
            .iter()
            .find(|device| device.id == selected)
            .map_or(SelectedDevice::Missing, |device| {
                SelectedDevice::Listed(device.status.clone())
            }),
    )
}

/// `CAMERA_STALE_WARN_MS`.
pub const CAMERA_STALE_WARN_MS: u64 = 3000;

/// What `preview.camera.status` / `preview.screen.status` say, as the chip
/// reads them (the backend's JSON, kept by the Studio's telemetry).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PreviewSource<'a> {
    pub state: Option<&'a str>,
    pub frame_age_ms: Option<f64>,
    pub message: Option<&'a str>,
    pub no_video: bool,
}

impl<'a> PreviewSource<'a> {
    pub fn of(status: Option<&'a Value>) -> Self {
        let Some(status) = status else {
            return Self::default();
        };
        Self {
            state: status.get("state").and_then(Value::as_str),
            frame_age_ms: status.get("frameAgeMs").and_then(Value::as_f64),
            message: status.get("message").and_then(Value::as_str),
            no_video: status.get("noVideo").and_then(Value::as_bool) == Some(true),
        }
    }
}

/// The two kinds a video row is (`kind: 'screen' | 'camera'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoKind {
    Screen,
    Camera,
}

/// `videoSourceStatus`'s input.
#[derive(Debug, Clone, Default)]
pub struct VideoStatusInput<'a> {
    pub kind: Option<VideoKind>,
    pub selected: bool,
    pub switching: bool,
    pub device: Option<SelectedDevice>,
    pub preview: PreviewSource<'a>,
    pub name: Option<&'a str>,
    pub stand_in: Option<SourceStandIn>,
    pub low_frame_rate: Option<CameraLowFrameRate>,
    /// Issue #1066: the camera's low-light compensation is on.
    pub low_light_compensation: bool,
}

/// `cameraNoVideoLine` (Health says the same with its own advice).
pub fn camera_no_video_line(name: Option<&str>) -> String {
    let name = name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("Your camera");
    format!("{name} isn't sending video.")
}

fn not_found(kind: VideoKind) -> SourceStatus {
    SourceStatus::new("Not found", ChipTone::Warn).hint(match kind {
        VideoKind::Screen => "That screen or window is gone. Choose another.",
        VideoKind::Camera => "It isn't connected. Reconnect it, or choose another.",
    })
}

fn switching_status() -> SourceStatus {
    SourceStatus::new("Switching", ChipTone::Warn)
}

/// `videoSourceStatus`: what the preview pipeline says about the selected
/// source right now, with a stand-in's line riding under it.
pub fn video_source_status(input: &VideoStatusInput<'_>) -> Option<SourceStatus> {
    let status = pipeline_source_status(input);
    let Some(stand_in) = input.stand_in.as_ref() else {
        return status;
    };
    if input.switching || !input.selected {
        return status;
    }
    match status {
        None => {
            Some(SourceStatus::new(copy::STAND_IN, ChipTone::Neutral).hint(stand_in_line(stand_in)))
        }
        Some(status) if status.hint.is_some() => Some(status),
        Some(status) => Some(status.hint(stand_in_line(stand_in))),
    }
}

fn pipeline_source_status(input: &VideoStatusInput<'_>) -> Option<SourceStatus> {
    let kind = input.kind.unwrap_or(VideoKind::Screen);
    if input.switching {
        return Some(switching_status());
    }
    if !input.selected {
        return None;
    }
    let preview = &input.preview;
    match preview.state {
        Some("disconnected") => {
            let mut status = SourceStatus::new("Disconnected", ChipTone::Warn);
            status.hint = preview.message.map(str::to_string);
            return Some(status);
        }
        Some("live") => {
            if kind == VideoKind::Camera && preview.no_video {
                return Some(SourceStatus::new("No video", ChipTone::Warn).hint(format!(
                    "{} Close other apps that use it, or choose another camera.",
                    camera_no_video_line(input.name)
                )));
            }
            if kind == VideoKind::Camera
                && let Some(age) = preview.frame_age_ms
                && age > CAMERA_STALE_WARN_MS as f64
            {
                return Some(
                    SourceStatus::new(format!("Stale {}s", js_round(age / 1000.0)), ChipTone::Warn)
                        .hint("No fresh frames. Choose it again to restart it."),
                );
            }
            if kind == VideoKind::Camera
                && let Some(low) = input.low_frame_rate
            {
                return Some(SourceStatus::new("Low frame rate", ChipTone::Warn).hint(
                    camera_low_frame_rate_line(input.name, low, input.low_light_compensation),
                ));
            }
            return Some(SourceStatus::new(copy::RECEIVING, ChipTone::Good));
        }
        _ => {}
    }
    if preview.state == Some("permission-needed")
        || input.device == Some(SelectedDevice::Listed(DeviceStatus::PermissionRequired))
    {
        return Some(SourceStatus::new("Needs permission", ChipTone::Warn));
    }
    if matches!(
        input.device,
        Some(SelectedDevice::Missing | SelectedDevice::Listed(DeviceStatus::Unavailable))
    ) {
        return Some(not_found(kind));
    }
    match preview.state {
        Some("starting") => Some(if preview.message == Some(copy::SHARE_DIALOG_PENDING) {
            SourceStatus::new("Waiting for you", ChipTone::Warn)
                .hint("Choose a screen in the share dialog. It may be behind this window.")
        } else {
            SourceStatus::new("Starting", ChipTone::Warn)
        }),
        Some("failed") => Some(
            SourceStatus::new("Failed", ChipTone::Error)
                .hint("Couldn't start it. Choose it again to retry."),
        ),
        _ => None,
    }
}

/// `screenShareLostStatus`: a Linux share dialog that went away.
pub fn screen_share_lost_status(
    selected: bool,
    switching: bool,
    preview: &PreviewSource<'_>,
) -> Option<SourceStatus> {
    (selected
        && !switching
        && preview.state == Some("permission-needed")
        && preview.message == Some(copy::SHARE_DIALOG_LOST))
    .then(|| {
        SourceStatus::new("Not shared", ChipTone::Warn).hint(
            "The share dialog closed unexpectedly. Select Refresh to choose your screen again.",
        )
    })
}

/// `screenShareNeedsAsking`: a Linux portal source that is neither live
/// nor waiting on its dialog is asked again by Refresh.
pub fn screen_share_needs_asking(selected_id: Option<&str>, state: Option<&str>) -> bool {
    let id = selected_id.unwrap_or_default();
    (id.starts_with("screen:portal:") || id.starts_with("window:portal:"))
        && state != Some("live")
        && state != Some("starting")
}

/// JavaScript's `Math.round` (halves round up).
fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

fn dimension(status: &Value, key: &str) -> Option<f64> {
    status.get(key).and_then(Value::as_f64)
}

/// `formatResolution`: "1920 × 1080".
pub fn format_resolution(width: f64, height: f64) -> String {
    format!("{} × {}", js_round(width), js_round(height))
}

fn dimensions(width: Option<f64>, height: Option<f64>) -> Option<String> {
    let (width, height) = (width?, height?);
    (width > 0.0 && height > 0.0).then(|| format_resolution(width, height))
}

/// `screenFacts`: the screen's size while it's live (no frame rate: a
/// screen delivers only when it changes).
pub fn screen_facts(status: Option<&Value>) -> Option<String> {
    let status = status?;
    if status.get("state").and_then(Value::as_str) != Some("live") {
        return None;
    }
    dimensions(
        dimension(status, "nativeWidth"),
        dimension(status, "nativeHeight"),
    )
    .or_else(|| dimensions(dimension(status, "width"), dimension(status, "height")))
}

/// `cameraFacts`: the negotiated format and the rate it runs at.
pub fn camera_facts(status: Option<&Value>) -> Option<String> {
    let status = status?;
    if status.get("state").and_then(Value::as_str) != Some("live") {
        return None;
    }
    let size = dimensions(
        dimension(status, "selectedFormatWidth"),
        dimension(status, "selectedFormatHeight"),
    )
    .or_else(|| {
        dimensions(
            dimension(status, "actualWidth"),
            dimension(status, "actualHeight"),
        )
    })?;
    Some(match camera_expected_fps(status) {
        Some(fps) => format!("{size} · {}", format_frame_rate(js_round(fps) as f64)),
        None => size,
    })
}

/// `CameraFormatShortfall` (plan 024 S5).
#[derive(Debug, Clone, PartialEq)]
pub struct CameraFormatShortfall {
    pub fps_unmet: bool,
    pub resolution_unmet: bool,
    pub requested_width: f64,
    pub requested_height: f64,
    pub requested_fps: f64,
    pub selected_width: f64,
    pub selected_height: f64,
    pub selected_max_fps: f64,
    pub single_format: bool,
}

const FPS_TOLERANCE: f64 = 1.0;

/// "Requested WxH@FPS" in the camera's status message.
fn requested_camera_fps(message: Option<&str>) -> Option<f64> {
    let message = message?;
    let at = message.find("Requested")?;
    let rest = message[at + "Requested".len()..].trim_start();
    let (size, after) = rest.split_once('@')?;
    let (width, height) = size.split_once('x')?;
    if width.is_empty()
        || height.is_empty()
        || !width.chars().all(|c| c.is_ascii_digit())
        || !height.chars().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let number: String = after
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let fps: f64 = number.parse().ok()?;
    (fps.is_finite() && fps > 0.0).then_some(fps)
}

/// `cameraFormatShortfall(diagnosticStats)`.
pub fn camera_format_shortfall(stats: Option<&Value>) -> Option<CameraFormatShortfall> {
    let stats = stats?;
    if stats.get("previewCameraState").and_then(Value::as_str) != Some("live") {
        return None;
    }
    let number = |key: &str| stats.get(key).and_then(Value::as_f64);
    let requested_width = number("previewCameraRequestedWidth")?;
    let requested_height = number("previewCameraRequestedHeight")?;
    let selected_width = number("previewCameraSelectedFormatWidth")?;
    let selected_height = number("previewCameraSelectedFormatHeight")?;
    let selected_max_fps = number("previewCameraSelectedFormatMaxFps")?;
    let requested_fps = requested_camera_fps(
        stats
            .get("previewCameraStatusMessage")
            .and_then(Value::as_str),
    )?;
    let fps_unmet = selected_max_fps + FPS_TOLERANCE < requested_fps;
    let resolution_unmet = selected_width < requested_width || selected_height < requested_height;
    if !fps_unmet && !resolution_unmet {
        return None;
    }
    let formats = stats
        .get("previewCameraCapabilityFormats")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    Some(CameraFormatShortfall {
        fps_unmet,
        resolution_unmet,
        requested_width,
        requested_height,
        requested_fps,
        selected_width,
        selected_height,
        selected_max_fps,
        single_format: formats == 1,
    })
}

/// `cameraFormatShortfallMessage`.
pub fn camera_format_shortfall_message(shortfall: &CameraFormatShortfall) -> String {
    let selected = format!(
        "{} at {}",
        format_resolution(shortfall.selected_width, shortfall.selected_height),
        format_frame_rate(js_round(shortfall.selected_max_fps) as f64)
    );
    if shortfall.fps_unmet && shortfall.single_format {
        return format!(
            "This camera only offers {selected}, so it can't reach {}. If it's a capture device, set the connected HDMI source to a 60Hz/30Hz (NTSC) mode.",
            format_frame_rate(shortfall.requested_fps)
        );
    }
    if shortfall.fps_unmet {
        return format!(
            "This camera's closest format is {selected}, below the requested {}. Recording will run at {}.",
            format_frame_rate(shortfall.requested_fps),
            format_frame_rate(js_round(shortfall.selected_max_fps) as f64)
        );
    }
    format!(
        "This camera's closest format is {selected}, so the image is upscaled to fill the {} canvas.",
        format_resolution(shortfall.requested_width, shortfall.requested_height)
    )
}

/// `unknownDeviceWarnings`: the device list's warnings that are not about
/// a permission (the curated alerts own those).
pub fn unknown_device_warnings(warnings: &[String]) -> Vec<&str> {
    warnings
        .iter()
        .map(String::as_str)
        .filter(|warning| {
            let lower = warning.to_lowercase();
            ![
                "camera permission",
                "microphone permission",
                "screen recording permission",
            ]
            .iter()
            .any(|needle| lower.contains(needle))
        })
        .collect()
}

// ── The permission alerts ────────────────────────────────────────────────

/// `SystemAccessState`: a grant as Settings → Permissions reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantState {
    Granted,
    NotGranted,
    FirstUse,
    DeviceIssue,
    Waiting,
    NeedsRelaunch,
    NotRequired,
    Unavailable,
}

/// `SystemAccessAction`: the one action that fixes a grant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantAction {
    RequestMediaAccess,
    OpenSettings,
    Relaunch,
}

/// One grant's row (`SystemAccessRow`'s state, whether it is still being
/// checked, its detail line) with its action (`systemAccessAction`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantRow {
    pub state: GrantState,
    pub checking: bool,
    pub detail: String,
    pub action: Option<GrantAction>,
}

/// `SourcePermissionAlert`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourcePermissionAlert {
    pub pane: SystemPermissionPane,
    pub title: String,
    pub description: String,
    pub action_label: String,
}

fn pane_name(pane: SystemPermissionPane) -> &'static str {
    match pane {
        SystemPermissionPane::Camera => "Camera",
        SystemPermissionPane::Microphone => "Microphone",
        _ => "Screen Recording",
    }
}

/// `openPermissionSettingsLabel`: "Open Camera settings".
pub fn open_permission_settings_label(pane: SystemPermissionPane) -> String {
    format!("Open {} settings", pane_name(pane))
}

/// `platformCopy(platform).osName`.
pub fn os_name(platform: &str) -> &'static str {
    match platform {
        "darwin" => "macOS",
        "win32" => "Windows",
        _ => "Linux",
    }
}

/// `osSettingsName(platform)`.
pub fn os_settings_name(platform: &str) -> &'static str {
    match platform {
        "darwin" => "System Settings",
        "win32" => "Windows Settings",
        _ => "system settings",
    }
}

/// `systemAccessActionLabel(action, platform)`.
pub fn grant_action_label(action: Option<GrantAction>, platform: &str) -> Option<String> {
    Some(match action? {
        GrantAction::RequestMediaAccess => "Allow…".to_string(),
        GrantAction::Relaunch => "Reopen Videorc".to_string(),
        GrantAction::OpenSettings => format!("Open {}…", os_settings_name(platform)),
    })
}

/// `privacyPath`: where the grant lives.
fn privacy_path(platform: &str, pane: SystemPermissionPane) -> String {
    let settings = os_settings_name(platform);
    match platform {
        "darwin" => format!("{settings} → Privacy & Security → {}", pane_name(pane)),
        "win32" => format!("{settings} → Privacy & security → {}", pane_name(pane)),
        _ => settings.to_string(),
    }
}

/// `MediaPermissionInput`: a camera or microphone grant.
#[derive(Debug, Clone, Default)]
pub struct MediaPermissionInput {
    pub state: Option<GrantState>,
    pub action: Option<GrantAction>,
    pub chosen: bool,
    pub detail: Option<String>,
}

fn media_alert(
    pane: SystemPermissionPane,
    input: &MediaPermissionInput,
    platform: &str,
    target: &str,
) -> Option<SourcePermissionAlert> {
    let missing = matches!(
        input.state,
        Some(GrantState::FirstUse | GrantState::NotGranted | GrantState::Waiting)
    );
    let action = input.action?;
    if !missing || !input.chosen {
        return None;
    }
    let noun = if pane == SystemPermissionPane::Camera {
        "camera"
    } else {
        "microphone"
    };
    let description = match input.detail.as_deref().filter(|detail| !detail.is_empty()) {
        Some(detail) => detail.to_string(),
        None if action == GrantAction::RequestMediaAccess => {
            format!("{} asks once. Choose Allow.", os_name(platform))
        }
        None if platform == "win32" => format!(
            "In {}, turn on access and “Let desktop apps access your {noun}”.",
            privacy_path(platform, pane)
        ),
        None => format!("Turn on {target} in {}.", privacy_path(platform, pane)),
    };
    Some(SourcePermissionAlert {
        pane,
        title: format!("{} permission is required for {target}.", pane_name(pane)),
        description,
        action_label: if action == GrantAction::RequestMediaAccess {
            "Allow…".to_string()
        } else {
            open_permission_settings_label(pane)
        },
    })
}

/// What the alerts and the camera chip read about the grants: the
/// platform, the name the grants are for, and Settings → Permissions' rows
/// (none where the platform has no such grant, as on Linux).
#[derive(Debug, Clone, Default)]
pub struct PermissionInputs<'a> {
    /// `runtimeInfo.platform`: darwin, win32 or linux.
    pub platform: &'a str,
    pub target_name: &'a str,
    pub screen: Option<GrantRow>,
    pub camera: Option<GrantRow>,
    pub microphone: Option<GrantRow>,
    /// `isMediaAccessSnapshotReady`: the camera and microphone states are
    /// known (before that, no media alert shows).
    pub media_known: bool,
}

impl PermissionInputs<'_> {
    fn media(&self, row: Option<&GrantRow>, chosen: bool) -> MediaPermissionInput {
        let state = row.filter(|_| self.media_known).map(|row| row.state);
        MediaPermissionInput {
            state,
            action: row.and_then(|row| row.action),
            chosen,
            detail: row.map(|row| row.detail.clone()),
        }
    }

    /// `videoPermissionState`'s camera half: the chip says it needs
    /// permission (the picker never locks: Off must stay reachable).
    pub fn camera_permission_required(&self) -> bool {
        self.camera.as_ref().is_some_and(|row| {
            !row.checking
                && matches!(
                    row.state,
                    GrantState::FirstUse | GrantState::NotGranted | GrantState::Waiting
                )
        })
    }
}

/// `sourcePermissionAlerts`: Screen Recording, Camera, Microphone, in page
/// order. Camera and microphone only for a source someone chose.
pub fn source_permission_alerts(
    input: &PermissionInputs<'_>,
    camera_chosen: bool,
    microphone_chosen: bool,
) -> Vec<SourcePermissionAlert> {
    permission_alerts(
        input.platform,
        input.target_name,
        input.screen.as_ref(),
        &input.media(input.camera.as_ref(), camera_chosen),
        &input.media(input.microphone.as_ref(), microphone_chosen),
    )
}

/// `sourcePermissionAlerts` over the screen's row and the media inputs, as
/// Electron's takes them.
pub fn permission_alerts(
    platform: &str,
    target: &str,
    screen: Option<&GrantRow>,
    camera: &MediaPermissionInput,
    microphone: &MediaPermissionInput,
) -> Vec<SourcePermissionAlert> {
    let mut alerts = Vec::new();
    if let Some(row) = screen
        && !row.checking
        && let Some(action_label) = grant_action_label(row.action, platform)
    {
        alerts.push(SourcePermissionAlert {
            pane: SystemPermissionPane::ScreenRecording,
            title: if row.state == GrantState::NeedsRelaunch {
                "Reopen Videorc to record your screen.".to_string()
            } else {
                format!("Screen Recording permission is required for {target}.")
            },
            description: if row.detail.is_empty() {
                format!("{} asks once. Choose Allow.", os_name(platform))
            } else {
                row.detail.clone()
            },
            action_label,
        });
    }
    for (pane, input) in [
        (SystemPermissionPane::Camera, camera),
        (SystemPermissionPane::Microphone, microphone),
    ] {
        if let Some(alert) = media_alert(pane, input, platform, target) {
            alerts.push(alert);
        }
    }
    alerts
}

// ── The Video column ─────────────────────────────────────────────────────

/// `screenSceneLine` (plan 231 D2, D8): the scene on stream, whose screen
/// the Screen picker changes. A scene whose layout draws no screen (Camera
/// only) says so: the capture still running under it (D18) isn't its
/// screen.
pub fn screen_scene_line(name: &str, shows_screen: bool) -> String {
    if shows_screen {
        format!("Shown by “{name}”, the scene on stream. Each scene keeps its own screen.")
    } else {
        format!("“{name}”, the scene on stream, shows no screen. Each scene keeps its own screen.")
    }
}

/// The scene the Screen picker changes (`ScreenScene`), with its line and
/// the door to Studio's Scenes section (the section door is the shell's).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenSceneView {
    pub name: String,
    /// Its layout draws the screen (Camera only doesn't).
    pub shows_screen: bool,
    pub line: String,
    pub open_label: &'static str,
}

/// The Low-light compensation switch (issue #1066), only where the camera
/// in use has the control.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LowLightSwitchView {
    pub label: &'static str,
    pub description: &'static str,
    pub checked: bool,
    /// Videorc is away, or a save runs.
    pub disabled: bool,
}

/// One video row: the picker row, with the page's chip, facts and the
/// camera's shortfall.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct VideoSourceView {
    pub row: SourceRowView,
    pub status: Option<SourceStatus>,
    pub facts: Option<String>,
    /// The camera's format shortfall, in place of the facts.
    pub shortfall: Option<String>,
    /// The picker is off (a switch can't run, a scene is changing, or
    /// nothing can be captured).
    pub disabled: bool,
    /// The Screen item: the scene on stream, once the library is read.
    pub scene: Option<ScreenSceneView>,
    /// The Camera item: Low-light compensation, where it can be set.
    pub low_light: Option<LowLightSwitchView>,
}

/// The development switch (`import.meta.env.DEV`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SyntheticView {
    pub checked: bool,
    pub disabled: bool,
}

/// The page, as one value.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SourcesPageView {
    pub description: &'static str,
    pub refreshing: bool,
    pub alerts: Vec<SourcePermissionAlert>,
    pub device_problem: bool,
    pub video_description: &'static str,
    pub screen: VideoSourceView,
    pub camera: VideoSourceView,
    pub synthetic: Option<SyntheticView>,
}

/// What the page reads besides the Studio's snapshot.
pub struct SourcesPageInput<'a> {
    pub snapshot: &'a StudioSnapshot,
    /// The previews' statuses, the diagnostics and the slow-camera watch.
    pub telemetry: &'a HealthTelemetry,
    pub permissions: PermissionInputs<'a>,
    /// A development build: the synthetic switch shows.
    pub development: bool,
    pub refreshing: bool,
}

fn source_text<'a>(sources: &'a Value, key: &str) -> Option<&'a str> {
    sources
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// The scene on stream, as the Screen item names it (`savedScenes.find(id
/// === activeSavedSceneId)`); none before the library is read.
pub fn screen_scene(snapshot: &StudioSnapshot) -> Option<ScreenSceneView> {
    let scenes = &snapshot.scenes;
    let id = scenes.on_stream_id.as_deref()?;
    let scene = scenes.scenes.iter().find(|scene| scene.id == id)?;
    let shows_screen = layout_shows_screen(&scene.visual["layout"]);
    Some(ScreenSceneView {
        line: screen_scene_line(&scene.name, shows_screen),
        name: scene.name.clone(),
        shows_screen,
        open_label: copy::OPEN_SCENES,
    })
}

/// `SourcesTab` with `SourcePermissionAlerts` and `VideoSources`.
pub fn sources_page_view(input: &SourcesPageInput<'_>) -> SourcesPageView {
    let snapshot = input.snapshot;
    let devices = &snapshot.sources.devices.devices;
    let sources = snapshot
        .settings
        .capture_doc
        .get("sources")
        .cloned()
        .unwrap_or(Value::Null);
    let session = &snapshot.session;
    let owns = session.phase.is_active() && !session.status.replay_only;
    let session_active = owns || session.start_pending || session.stop_pending;
    let pending = snapshot.live_sources.pending;
    // `layoutSwitchPending`: a scene change holds both pickers.
    let layout_switch_pending = snapshot.scenes.pending_layout.is_some();
    let connected = matches!(snapshot.connection, super::Connection::Connected { .. });

    let capture_devices = capture_picker_devices(devices);
    let find = |id: Option<&str>| -> Option<&Device> {
        let id = id?;
        devices.iter().find(|device| device.id == id)
    };
    let discovery_pending = !connected || !snapshot.sources.devices_known;
    // `allowCaptureNone`: idle, or the session's capture can be None.
    let allow_capture_none = !owns
        || snapshot
            .live_sources
            .snapshot
            .as_ref()
            .and_then(|sources| sources.capability(SourceKind::Capture))
            .is_some_and(|capability| capability.allows_none);
    let screen_locked = !capture_devices.is_empty()
        && capture_devices
            .iter()
            .all(|device| device.status == DeviceStatus::PermissionRequired);
    let camera_permission_required = input.permissions.camera_permission_required();
    let [capture_reason, camera_reason, _] = snapshot.source_reasons.clone();

    // The screen.
    let selected_capture = source_text(&sources, "screenId")
        .or_else(|| source_text(&sources, "windowId"))
        .or_else(|| source_text(&sources, "wantedWindowId"))
        .or_else(|| source_text(&sources, "wantedScreenId"));
    let screen_preview = PreviewSource::of(input.telemetry.preview_screen.as_ref());
    let screen_switching = pending == Some(SourceKind::Capture);
    let screen_status = screen_share_lost_status(
        selected_capture.is_some(),
        screen_switching,
        &screen_preview,
    )
    .or_else(|| {
        video_source_status(&VideoStatusInput {
            kind: Some(VideoKind::Screen),
            selected: selected_capture.is_some(),
            switching: screen_switching,
            device: selected_device_status(devices, selected_capture),
            preview: screen_preview.clone(),
            name: None,
            stand_in: source_stand_in(&sources, SourceKind::Capture, devices),
            low_frame_rate: None,
            low_light_compensation: false,
        })
    });
    let screen = VideoSourceView {
        disabled: screen_locked || capture_reason.is_some() || layout_switch_pending,
        facts: selected_capture.and_then(|_| screen_facts(input.telemetry.preview_screen.as_ref())),
        // The page's own picker (`DevicePicker` with `groupByKind`, its
        // `noneLabel`, no selection label: the test pattern reads None).
        row: SourceRowView {
            picker: picker_view(&PickerInput {
                kind: SourceKind::Capture,
                devices: capture_devices.clone(),
                value: selected_capture.map(str::to_string),
                selected_name: source_text(&sources, "screenName")
                    .or_else(|| source_text(&sources, "windowName"))
                    .or_else(|| source_text(&sources, "wantedWindowName"))
                    .or_else(|| source_text(&sources, "wantedScreenName"))
                    .map(str::to_string),
                selected_device: find(selected_capture),
                discovery_pending,
                none_label: allow_capture_none.then_some(copy::NONE),
                selection_label: None,
                group_by_kind: true,
            }),
            status: switch_status_line(
                SourceKind::Capture,
                &snapshot.live_sources,
                devices,
                capture_reason.as_deref(),
            ),
            stand_in: None,
            disabled_reason: capture_reason,
        },
        status: screen_status,
        shortfall: None,
        scene: screen_scene(snapshot),
        low_light: None,
    };

    // The camera.
    let camera_id = source_text(&sources, "cameraId");
    let selected_camera = camera_id.or_else(|| source_text(&sources, "wantedCameraId"));
    let camera_switching = pending == Some(SourceKind::Camera);
    // Issue #1066: only the answer for the camera in use counts.
    let low_light = snapshot.camera_low_light.for_camera(camera_id);
    let camera_status = video_source_status(&VideoStatusInput {
        kind: Some(VideoKind::Camera),
        selected: selected_camera.is_some(),
        switching: camera_switching,
        device: if camera_permission_required {
            Some(SelectedDevice::Listed(DeviceStatus::PermissionRequired))
        } else {
            selected_device_status(devices, selected_camera)
        },
        preview: PreviewSource::of(input.telemetry.preview_camera.as_ref()),
        name: source_text(&sources, "cameraName"),
        stand_in: source_stand_in(&sources, SourceKind::Camera, devices),
        low_frame_rate: input.telemetry.camera_low_frame_rate(),
        low_light_compensation: low_light.is_some_and(|state| state.compensation),
    });
    let shortfall = camera_id
        .and_then(|_| camera_format_shortfall(input.telemetry.diagnostics.as_ref()))
        .map(|shortfall| camera_format_shortfall_message(&shortfall));
    let camera = VideoSourceView {
        disabled: camera_reason.is_some() || layout_switch_pending,
        facts: if shortfall.is_some() {
            None
        } else {
            camera_id.and_then(|_| camera_facts(input.telemetry.preview_camera.as_ref()))
        },
        row: SourceRowView {
            picker: picker_view(&PickerInput {
                kind: SourceKind::Camera,
                devices: camera_picker_devices(devices),
                value: selected_camera.map(str::to_string),
                selected_name: source_text(&sources, "cameraName")
                    .or_else(|| source_text(&sources, "wantedCameraName"))
                    .map(str::to_string),
                // The camera's picker takes no `selectedDevice`.
                selected_device: None,
                discovery_pending,
                none_label: Some(copy::OFF),
                selection_label: None,
                group_by_kind: false,
            }),
            status: switch_status_line(
                SourceKind::Camera,
                &snapshot.live_sources,
                devices,
                camera_reason.as_deref(),
            ),
            stand_in: None,
            disabled_reason: camera_reason,
        },
        status: camera_status,
        shortfall,
        scene: None,
        low_light: low_light.map(|state| LowLightSwitchView {
            label: camera_low_light::copy::LABEL,
            description: camera_low_light::copy::DESCRIPTION,
            checked: state.compensation,
            disabled: !connected || snapshot.camera_low_light.pending,
        }),
    };

    SourcesPageView {
        description: sources_page_description(input.permissions.platform),
        refreshing: input.refreshing,
        alerts: source_permission_alerts(
            &input.permissions,
            camera_id.is_some(),
            source_text(&sources, "microphoneId").is_some(),
        ),
        device_problem: !unknown_device_warnings(&snapshot.sources.devices.warnings).is_empty(),
        video_description: if session_active {
            copy::VIDEO_DESCRIPTION_LIVE
        } else {
            copy::VIDEO_DESCRIPTION
        },
        screen,
        camera,
        synthetic: input.development.then_some(SyntheticView {
            checked: snapshot.settings.capture.sources.test_pattern,
            disabled: session_active,
        }),
    }
}

#[cfg(test)]
#[path = "sources_page_tests.rs"]
mod tests;
