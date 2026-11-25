//! Plan 260 Phase 3: the scene on stream's own fields under Studio's scene
//! cards, as data (`components/studio/scene-on-stream.tsx`,
//! `screen-privacy-control.tsx`, `lib/screen-privacy-view.ts`,
//! `lib/studio-actions/privacy.ts`, `vertical-stream-layout-control.tsx`;
//! plan 231 D8, plan 210 S8b).
//!
//! Every word and every state is decided here; the GPUI section draws it
//! and calls the Studio:
//!
//! - the header, "On stream: {name}" and "Changes here save into this
//!   scene." (P318);
//! - the Screen field: what the scene shows and its note (P319), Hide screen
//!   or Show screen with its key (P320, P330, P331) and its one reason
//!   (P332), the "Screen hidden" chip and a room's own words for it (P321,
//!   P333), the capture switch's line and a stand-in's (P323), and the
//!   Screen Recording alert (P324);
//! - the Layout field: the studio's orientation's layouts, the one on now
//!   (or Freeform) and the camera's line (P325, P326);
//! - Framing, Fill or Fit (P327);
//! - with a vertical stream armed beside a 16:9 studio, the scene's 9:16
//!   layout and its Fill or Fit (P328).
//!
//! The Hide screen state itself is the backend's (`screen.privacy.get`,
//! `screen.privacy.changed`); the section keeps the last one it heard and
//! asks [`screen_privacy_request`] and [`screen_privacy_outcome`] what a
//! press sends and what its answer does.

use serde_json::{Value, json};
use videorc_protocol::{Device, ScreenPrivacy};

use super::capture_config::simulcast_armed;
use super::live_sources::{LiveSourcesView, SwitchStatusLine, switch_status_line};
use super::source_selection::{SourceKind, source_stand_in, stand_in_line};
use super::sources::copy as sources_copy;
use super::sources_page::{
    GrantAction, GrantRow, GrantState, MediaPermissionInput, SourcePermissionAlert,
    permission_alerts,
};
use super::vertical_stream::{VerticalStreamLayoutView, vertical_stream_layout_view};
use super::{Connection, StudioSnapshot};
use crate::client::RpcError;
use crate::desktop::global_shortcuts::DEFAULT_SCREEN_HIDE_SHORTCUT;
use crate::desktop::permissions::{MediaAccessSnapshot, PermissionPlatform, SystemPermissionPane};
use crate::desktop::system_access::{
    SystemAccessAction, SystemAccessContext, SystemAccessInput, SystemAccessRow, SystemAccessRowId,
    SystemAccessState, row_action, system_access_rows, system_access_visible_detail,
};
use crate::editor::inspector::{
    LayoutInput, copy as inspector_copy, has_camera, layout_section_view,
};
use crate::notices::{NoticeCommand, ToastRequest};
use crate::scenes::section::{
    layout_asks_for_screen, scene_layout_camera_line, scene_layout_choices, screen_field_words,
};
use crate::scenes::v2::{Orientation, Scene, layout_preset, layout_preset_label};
use crate::user_error::{Failure, UserErrorContext, toast_user_error};

/// The fields' words, as Electron says them.
pub mod copy {
    /// The header's lead, before the scene's name.
    pub const ON_STREAM: &str = "On stream:";
    pub const SAVES_HERE: &str = "Changes here save into this scene.";
    pub const SCREEN: &str = "Screen";
    pub const LAYOUT: &str = "Layout";
    /// Fill or Fit's visible name beside the Screen field (plan 231 S6).
    pub const FRAMING: &str = "Framing";
    /// The Fill / Fit control's name (`aria-label`).
    pub const SCREEN_FRAMING: &str = "Screen framing";
    pub const FILL: &str = "Fill";
    pub const FIT: &str = "Fit";
    pub const VERTICAL_STREAM: &str = "Vertical stream";
    /// The Vertical stream's Layout select's name (`aria-label`).
    pub const VERTICAL_STREAM_LAYOUT: &str = "Vertical stream layout";
    /// `SCREEN_HIDDEN_LABEL`.
    pub const SCREEN_HIDDEN: &str = super::sources_copy::SCREEN_HIDDEN;
    pub const HIDE_SCREEN: &str = super::sources_copy::HIDE_SCREEN;
    pub const SHOW_SCREEN: &str = super::sources_copy::SHOW_SCREEN;
    /// `screenPrivacyDisabledReason` while Videorc is away.
    pub const RECONNECTING: &str = super::sources_copy::RECONNECTING;
    /// `SCREEN_HIDE_UNAVAILABLE`: a legacy recording refuses the hide.
    pub const SCREEN_HIDE_UNAVAILABLE: &str =
        "Hide screen isn't available on this recording. Stop and record again.";
    pub const SCREEN_HIDE_UNAVAILABLE_ID: &str = "screen-hide-unavailable";
    /// The toggle's failure toast id (`{ id: 'screen-privacy' }`).
    pub const SCREEN_PRIVACY_ID: &str = "screen-privacy";
    /// `toastUserError`'s object.
    pub const YOUR_SCREEN: &str = "your screen";
}

/// `screen.privacy.changed`: the backend's Hide screen state, on every hide
/// and show (`useScreenPrivacy`).
pub const SCREEN_PRIVACY_CHANGED_EVENT: &str = "screen.privacy.changed";
/// `screen.privacy.get`, on every connection and after each change.
pub const SCREEN_PRIVACY_GET_METHOD: &str = "screen.privacy.get";
pub const SCREEN_HIDE_METHOD: &str = "screen.hide";
pub const SCREEN_SHOW_METHOD: &str = "screen.show";
/// The backend's refusal of a hide on a legacy recording.
pub const SCREEN_HIDE_UNAVAILABLE_CODE: &str = "screen-hide-unavailable";

// ── Hide screen ──────────────────────────────────────────────────────────

/// `screenPrivacyActionLabel`: the action's name in its current state.
pub fn screen_privacy_action_label(hidden: bool) -> &'static str {
    if hidden {
        copy::SHOW_SCREEN
    } else {
        copy::HIDE_SCREEN
    }
}

/// `screenHideAccelerator`: the saved key, D9's default (⌃⌥H) when none was
/// ever saved, and none once the streamer cleared it.
pub fn screen_hide_accelerator(saved: Option<&str>) -> Option<String> {
    let accelerator = saved.unwrap_or(DEFAULT_SCREEN_HIDE_SHORTCUT);
    (!accelerator.is_empty()).then(|| accelerator.to_string())
}

/// `screenPrivacyDisabledReason`: only a hide is ever refused (a legacy
/// recording), so a hidden screen is never stuck behind a disabled button;
/// nothing runs while Videorc is away.
pub fn screen_privacy_disabled_reason(privacy: &ScreenPrivacy, connected: bool) -> Option<String> {
    if !connected {
        return Some(copy::RECONNECTING.to_string());
    }
    if privacy.hidden {
        return None;
    }
    privacy.unavailable.clone()
}

/// `roomPrivacyLabel` (plan 249): a room's screen share says more than
/// Hidden while its receivers aren't all confirmed.
pub fn room_privacy_label(status: Option<&str>) -> Option<&'static str> {
    match status? {
        "hiding" => Some("Hiding · receivers pending"),
        "observed" => Some("Frost observed · others unconfirmed"),
        "unconfirmed" => Some("Screen blocked · receivers unconfirmed"),
        "paused" => Some("Screen share paused · privacy unavailable"),
        _ => None,
    }
}

/// A room's own screen privacy (plan 249, `TalkShowRoomSnapshot`'s
/// `screenPrivacy`). The GPUI app has no room media yet, so it passes none.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RoomScreenPrivacy {
    pub hidden: bool,
    /// `visible`, `hiding`, `observed`, `unconfirmed` or `paused`.
    pub status: Option<String>,
    pub source_blocked_at: Option<String>,
    /// The receivers that reported applied frost, in order.
    pub observations: Vec<String>,
}

/// What the room confirmed, as the chip's tooltip, while it hides.
pub fn room_privacy_detail(room: &RoomScreenPrivacy) -> Option<String> {
    room.hidden.then(|| {
        let observed = if room.observations.is_empty() {
            "none".to_string()
        } else {
            room.observations.join(", ")
        };
        format!(
            "Source blocked: {}. Applied frost observations: {observed}. Other receivers remain unconfirmed.",
            room.source_blocked_at.as_deref().unwrap_or("unavailable")
        )
    })
}

/// `ScreenPrivacyControl`: what every Studio Hide screen control shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenPrivacyView {
    /// The screen is hidden, by Videorc or by the room.
    pub hidden: bool,
    /// "Hide screen" or "Show screen".
    pub action_label: &'static str,
    /// The chip beside the field's name while it holds ("Screen hidden", or
    /// the room's own words).
    pub chip: Option<String>,
    /// The chip's tooltip: what the room confirmed.
    pub chip_detail: Option<String>,
    /// The bound key (an accelerator), none when the streamer cleared it.
    pub accelerator: Option<String>,
    /// Why the action is off, or none.
    pub disabled_reason: Option<String>,
}

/// `useScreenPrivacyControl`: the backend's state, a room's, the saved key
/// and the connection.
pub fn screen_privacy_view(
    privacy: &ScreenPrivacy,
    room: Option<&RoomScreenPrivacy>,
    shortcuts: &Value,
    connected: bool,
) -> ScreenPrivacyView {
    let hidden = privacy.hidden || room.is_some_and(|room| room.hidden);
    let status_label = room.and_then(|room| room_privacy_label(room.status.as_deref()));
    let chip = (hidden || status_label.is_some())
        .then(|| status_label.unwrap_or(copy::SCREEN_HIDDEN).to_string());
    let held = ScreenPrivacy {
        hidden,
        ..privacy.clone()
    };
    ScreenPrivacyView {
        hidden,
        action_label: screen_privacy_action_label(hidden),
        chip,
        chip_detail: room.and_then(room_privacy_detail),
        accelerator: screen_hide_accelerator(
            shortcuts.get("screenHideToggle").and_then(Value::as_str),
        ),
        disabled_reason: screen_privacy_disabled_reason(&held, connected),
    }
}

/// What a press sends: `screen.hide` with the streamer as its reason while
/// the screen shows, `screen.show` while it is hidden.
pub fn screen_privacy_request(hidden: bool) -> (&'static str, Value) {
    if hidden {
        (SCREEN_SHOW_METHOD, Value::Null)
    } else {
        (SCREEN_HIDE_METHOD, json!({ "reason": "you" }))
    }
}

/// What an answer does.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PrivacyOutcome {
    /// The state the backend answered with; none on a failure.
    pub privacy: Option<ScreenPrivacy>,
    /// A refused hide's warning, or the failure's toast; success is silent
    /// (the chip and the Preview say it).
    pub notice: Option<NoticeCommand>,
}

/// The answer to [`screen_privacy_request`]: `hiding` is what the press
/// asked for.
pub fn screen_privacy_outcome(hiding: bool, answer: Result<Value, RpcError>) -> PrivacyOutcome {
    match answer {
        Ok(value) => PrivacyOutcome {
            privacy: serde_json::from_value(value).ok(),
            notice: None,
        },
        Err(error) if error.code == SCREEN_HIDE_UNAVAILABLE_CODE => PrivacyOutcome {
            privacy: None,
            notice: Some(NoticeCommand::Show(
                ToastRequest::warning(copy::SCREEN_HIDE_UNAVAILABLE)
                    .id(copy::SCREEN_HIDE_UNAVAILABLE_ID)
                    .finish(),
            )),
        },
        Err(error) => PrivacyOutcome {
            privacy: None,
            notice: toast_user_error(
                Failure::Rpc(&error),
                UserErrorContext {
                    action: if hiding { "hide" } else { "show" },
                    object: copy::YOUR_SCREEN,
                },
                copy::SCREEN_PRIVACY_ID,
            ),
        },
    }
}

// ── The Screen Recording alert ───────────────────────────────────────────

/// `process.platform`'s name for a permission platform.
fn node_platform(platform: PermissionPlatform) -> &'static str {
    match platform {
        PermissionPlatform::MacOs => "darwin",
        PermissionPlatform::Windows => "win32",
        PermissionPlatform::Other => "linux",
    }
}

/// A system access row as the alerts read it (its state, its visible
/// detail and its one action).
pub fn grant_row(row: &SystemAccessRow, action: Option<SystemAccessAction>) -> GrantRow {
    GrantRow {
        state: match row.state {
            SystemAccessState::Granted => GrantState::Granted,
            SystemAccessState::NotGranted => GrantState::NotGranted,
            SystemAccessState::FirstUse => GrantState::FirstUse,
            SystemAccessState::DeviceIssue => GrantState::DeviceIssue,
            SystemAccessState::Waiting => GrantState::Waiting,
            SystemAccessState::NeedsRelaunch => GrantState::NeedsRelaunch,
            SystemAccessState::NotRequired => GrantState::NotRequired,
            SystemAccessState::Unavailable => GrantState::Unavailable,
        },
        checking: row.checking,
        detail: system_access_visible_detail(row).unwrap_or("").to_string(),
        action: action.map(|action| match action {
            SystemAccessAction::RequestMediaAccess => GrantAction::RequestMediaAccess,
            SystemAccessAction::OpenSettings => GrantAction::OpenSettings,
            SystemAccessAction::Relaunch => GrantAction::Relaunch,
        }),
    }
}

/// The Screen field's alert and the action its button runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenRecordingAlert {
    pub alert: SourcePermissionAlert,
    pub action: GrantAction,
}

/// `SourcePermissionAlerts only="screen-recording"`: Screen Recording's
/// alert, in the Sources page's words, while the grant is missing.
pub fn screen_recording_alert(
    devices: &[Device],
    platform: PermissionPlatform,
    media: Option<&MediaAccessSnapshot>,
) -> Option<ScreenRecordingAlert> {
    let rows = system_access_rows(&SystemAccessInput {
        devices,
        audio_meter: None,
        platform,
        os_release: None,
        permission_target_name: "Videorc",
        media_access: media,
        context: SystemAccessContext::default(),
    });
    let row = rows
        .iter()
        .find(|row| row.id == SystemAccessRowId::ScreenRecording)?;
    let grant = grant_row(row, row_action(row, platform, media));
    let action = grant.action?;
    let none = MediaPermissionInput::default();
    permission_alerts(
        node_platform(platform),
        "Videorc",
        Some(&grant),
        &none,
        &none,
    )
    .into_iter()
    .find(|alert| alert.pane == SystemPermissionPane::ScreenRecording)
    .map(|alert| ScreenRecordingAlert { alert, action })
}

// ── Layout, Framing, Vertical stream ─────────────────────────────────────

/// One layout in the Layout field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutFieldChoice {
    pub value: &'static str,
    pub label: String,
    /// A camera layout without a camera (never the layout on now).
    pub disabled: bool,
    /// D19: a layout that draws a screen, on a scene that shows none, asks
    /// for the screen first (Change screen…).
    pub asks_for_screen: bool,
}

/// The Layout field (P325, P326).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutFieldView {
    /// "Each scene keeps its own 16:9 layout."
    pub description: String,
    /// The working layout is Freeform: no choice is the current one.
    pub freeform: bool,
    /// The layout on now, for the trigger's diagram.
    pub preset: String,
    /// The 9:16 diagram draws Fit.
    pub fit: bool,
    /// The trigger's words: the layout's name, or "Freeform".
    pub trigger: String,
    pub choices: Vec<LayoutFieldChoice>,
    /// Why some layouts are off, said once under the field.
    pub camera_line: Option<String>,
}

impl LayoutFieldView {
    /// What choosing `preset` applies (`chooseLayout`): another layout, or
    /// any while Freeform; none for a disabled one, and none for D19's
    /// ask, which waits for Change screen…'s picker.
    pub fn pick(&self, preset: &str) -> Option<&'static str> {
        let choice = self.choices.iter().find(|choice| choice.value == preset)?;
        let changes = self.freeform || choice.value != self.preset;
        (changes && !choice.disabled && !choice.asks_for_screen).then_some(choice.value)
    }
}

/// `ScreenFramingControl`: Fill or Fit and its line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FramingView {
    pub fit: bool,
    pub line: &'static str,
    /// The 9:16 framing (`verticalScreenFraming`), else the landscape one.
    pub vertical: bool,
}

/// The 9:16 Fill / Fit line, for the Vertical stream's framing.
pub fn vertical_framing_line(fit: bool) -> &'static str {
    if fit {
        inspector_copy::FRAMING_FIT_VERTICAL
    } else {
        inspector_copy::FRAMING_FILL_VERTICAL
    }
}

/// The Vertical stream's pick: another layout that isn't off, in a library
/// this build can change.
pub fn vertical_stream_pick(view: &VerticalStreamLayoutView, preset: &str) -> Option<&'static str> {
    if view.read_only_reason.is_some() || view.preset == preset {
        return None;
    }
    view.choices
        .iter()
        .find(|choice| choice.preset == preset && !choice.disabled)
        .map(|choice| choice.preset)
}

/// "Each scene keeps its own 16:9 layout." (or 9:16).
pub fn layout_description(vertical: bool) -> String {
    format!(
        "Each scene keeps its own {} layout.",
        if vertical { "9:16" } else { "16:9" }
    )
}

// ── The fields ───────────────────────────────────────────────────────────

/// The scene on stream's fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneOnStreamView {
    pub id: String,
    pub name: String,
    /// What the scene keeps on its screen, in a few words.
    pub screen_words: String,
    /// "Not shown in Camera only" while its layout draws no screen.
    pub screen_note: Option<String>,
    pub privacy: ScreenPrivacyView,
    /// The capture switch's line (`SourceSwitchStatus kind="capture"`).
    pub switch_status: Option<SwitchStatusLine>,
    /// A stand-in screen's line.
    pub stand_in: Option<String>,
    pub layout: LayoutFieldView,
    pub framing: Option<FramingView>,
    /// The scene's 9:16 layout, while a vertical stream is armed beside a
    /// 16:9 studio.
    pub vertical_stream: Option<VerticalStreamLayoutView>,
}

/// What the fields read.
#[derive(Debug, Clone, Copy)]
pub struct SceneOnStreamInput<'a> {
    /// The stored scene on stream (`sceneOnStream`).
    pub scene: Option<&'a Scene>,
    /// The working capture config (`captureConfig`).
    pub capture: &'a Value,
    pub devices: &'a [Device],
    pub live_sources: &'a LiveSourcesView,
    /// `sourceSwitchReason('capture')`.
    pub capture_reason: Option<&'a str>,
    /// The last Hide screen state the backend gave.
    pub privacy: &'a ScreenPrivacy,
    pub room: Option<&'a RoomScreenPrivacy>,
    /// `settings.globalShortcuts`.
    pub shortcuts: &'a Value,
    pub connected: bool,
    /// A library from a newer Videorc.
    pub read_only: bool,
}

impl SceneOnStreamView {
    /// The fields over the Studio's snapshot.
    pub fn from_snapshot(
        snapshot: &StudioSnapshot,
        privacy: &ScreenPrivacy,
        room: Option<&RoomScreenPrivacy>,
    ) -> Option<Self> {
        let shortcuts = snapshot.settings.studio.global_shortcuts();
        Self::of(SceneOnStreamInput {
            scene: snapshot.scenes.on_stream(),
            capture: &snapshot.settings.capture_doc,
            devices: &snapshot.sources.devices.devices,
            live_sources: &snapshot.live_sources,
            capture_reason: snapshot.source_reasons[0].as_deref(),
            privacy,
            room,
            shortcuts: &shortcuts,
            connected: matches!(snapshot.connection, Connection::Connected { .. }),
            read_only: snapshot.scenes.read_only,
        })
    }

    /// The fields, or none while no scene is on stream.
    pub fn of(input: SceneOnStreamInput<'_>) -> Option<Self> {
        let scene = input.scene?;
        let layout = input.capture.get("layout").unwrap_or(&Value::Null);
        let sources = input.capture.get("sources").unwrap_or(&Value::Null);
        let orientation = Orientation::of_layout(layout);
        let vertical = orientation == Orientation::Vertical;
        let freeform = layout.get("arrangementMode").and_then(Value::as_str) == Some("freeform");
        let preset = layout_preset(layout).to_string();
        let (screen_words, screen_note) = screen_field_words(&scene.shows, layout);
        let core_choices = scene_layout_choices(orientation, has_camera(sources));
        let camera_line = scene_layout_camera_line(&core_choices);
        let choices = core_choices
            .into_iter()
            .map(|choice| LayoutFieldChoice {
                disabled: choice.disabled && choice.value != preset,
                asks_for_screen: layout_asks_for_screen(&scene.shows, choice.value),
                value: choice.value,
                label: choice.label,
            })
            .collect();
        let framing = layout_section_view(&LayoutInput {
            layout,
            sources,
            session_active: false,
            stage_busy: false,
            has_scene: true,
            pending: None,
            animate: false,
            on_stream_shows_no_screen: false,
        })
        .framing
        .map(|(fit, line, vertical)| FramingView {
            fit,
            line,
            vertical,
        });
        let vertical_stream = (!vertical && simulcast_armed(input.capture))
            .then(|| vertical_stream_layout_view(Some(scene), input.capture, input.read_only))
            .flatten();
        Some(Self {
            id: scene.id.clone(),
            name: scene.name.clone(),
            screen_words,
            screen_note,
            privacy: screen_privacy_view(
                input.privacy,
                input.room,
                input.shortcuts,
                input.connected,
            ),
            switch_status: switch_status_line(
                SourceKind::Capture,
                input.live_sources,
                input.devices,
                input.capture_reason,
            ),
            stand_in: source_stand_in(sources, SourceKind::Capture, input.devices)
                .map(|stand_in| stand_in_line(&stand_in)),
            layout: LayoutFieldView {
                description: layout_description(vertical),
                freeform,
                trigger: if freeform {
                    inspector_copy::FREEFORM.to_string()
                } else {
                    layout_preset_label(&preset, false)
                },
                fit: layout.get("verticalScreenFraming").and_then(Value::as_str) == Some("fit"),
                preset,
                choices,
                camera_line,
            },
            framing,
            vertical_stream,
        })
    }
}

#[cfg(test)]
#[path = "scene_on_stream_tests.rs"]
mod tests;
