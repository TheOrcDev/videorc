//! Plan 260 S1.6b part 5b: the Studio's Sources mirror as data
//! (`components/studio/quick-settings.tsx`), from `videorc-rust`'s S3.1c
//! port, caught up with Electron.
//!
//! - No "Sources" heading and no header button (plan 235 D3): the group
//!   keeps its name for screen readers ([`copy::SOURCES`]) and the way home
//!   is the "Open Sources" cog at the end of the Camera row (D4).
//! - The Screen row and Hide screen left the mirror (plan 231 D8): the scene
//!   on stream's Screen field, in Studio's Scenes section, is their home now.
//!   The mirror is the Camera row, then Captions and Chat.
//! - The Camera row: the picker with the live switch's line, then its
//!   footer: a stand-in's line, the Background control (plan 258 S5), the
//!   background stage's line (S5) and the system effect's line (S4).
//! - The Captions row's word (`captionsStatusLabel`), "Paused" when the
//!   caption service is unavailable (#1593).
//!
//! The choice itself is [`super::source_actions`]; the Background's pick is
//! [`super::Studio::apply_camera_background`].

use serde_json::Value;
use videorc_protocol::{CameraBackgroundStatus, CameraSystemEffect, CameraSystemEffectProvider};

use super::camera_background_view::{
    ChoiceId, Image, background_for, choice_id, is_effect, platform_reason, stage_line, value_label,
};
use super::health::HealthTelemetry;
use super::live_sources::{SwitchStatusLine, switch_status_line};
use super::source_selection::{
    PickerInput, PickerView, SourceKind, camera_picker_devices, picker_view, source_stand_in,
    stand_in_line,
};
use super::{Connection, Studio, StudioBackend, StudioSnapshot};
use crate::nav::PageId;

/// `captions.status`: the caption service's state.
pub const CAPTIONS_STATUS_EVENT: &str = "captions.status";
/// `captions.status.get`, on every connection.
pub const CAPTIONS_STATUS_GET_METHOD: &str = "captions.status.get";

/// The mirror's words (P3-D2: Electron's exactly).
pub mod copy {
    /// The group's name for screen readers (`aria-label="Sources"`); never
    /// shown as a heading (plan 235 D3).
    pub const SOURCES: &str = "Sources";
    /// The cog at the end of the Camera row (D4).
    pub const OPEN_SOURCES: &str = "Open Sources";
    pub const CAMERA: &str = "Camera";
    pub const CAPTIONS: &str = "Captions";
    pub const CHAT: &str = "Chat";
    pub const OFF: &str = "Off";
    /// `WINDOW_NAMES.streamManager`.
    pub const STREAM_MANAGER: &str = "Stream Manager";
    pub const OPEN_STREAM_MANAGER: &str = "Open Stream Manager";
    /// `shortcutAccelerator('comments-window')`.
    pub const STREAM_MANAGER_ACCELERATOR: &str = "CommandOrControl+Shift+J";
}

/// One picker row (the mirror's Camera, the Sources page's Screen and
/// Camera).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SourceRowView {
    pub picker: PickerView,
    /// `sourceSwitchReason(kind)`: the picker is off while it says why.
    pub disabled_reason: Option<String>,
    /// `SourceSwitchStatus`: the live switch's line under the row.
    pub status: Option<SwitchStatusLine>,
    /// Plan 213 E1: the stand-in's calm line.
    pub stand_in: Option<String>,
}

/// Plan 258 S5: the Camera row's Background control (`CameraBackgroundLine`
/// over `useCameraBackground`). Its popover's tiles are
/// [`super::camera_background_view::choices`]; a pick goes through
/// [`super::Studio::apply_camera_background`] with
/// [`super::camera_background_view::background_for_choice`].
#[derive(Debug, Clone, PartialEq)]
pub struct CameraBackgroundLineView {
    /// The camera's background (Off with Strong blur ready when it has none).
    pub background: Value,
    /// The tile it lights, or none for a pick no tile shows.
    pub choice: Option<ChoiceId>,
    /// The trigger's value ("Strong blur", the picture's name, "Off").
    pub value_label: String,
    /// Why an effect can't be picked now (the platform). Rooms don't exist
    /// in app-core, so never "a room is open".
    pub effect_reason: Option<&'static str>,
    pub is_effect: bool,
}

/// The Camera row: its picker row, the cog home, and its footer lines.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CameraRowView {
    pub row: SourceRowView,
    /// The cog at the row's end ("Open Sources", D4) and the page it opens.
    pub open_label: &'static str,
    pub open_page: Option<PageId>,
    /// The Background control; none without a camera (`available` false).
    pub background: Option<CameraBackgroundLineView>,
    /// `cameraBackgroundStageLine`: the cover after 2 s, or a stage that
    /// can't run here (a warning line, never a toast).
    pub background_stage: Option<String>,
    /// `cameraSystemEffectLine`: macOS Video Effects or Windows Studio
    /// Effects changing the background (an info line, never a toast).
    pub system_effect: Option<&'static str>,
}

/// The Chat row: a door to the Stream Manager (plan 213 B1).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ChatDoorView {
    /// "3 new" while a livestream with chat is on air, else `None` (the
    /// door and its key).
    pub new_label: Option<String>,
    pub accelerator: &'static str,
}

/// The Sources mirror, as one value.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SourcesSectionView {
    /// The group's accessible name ([`copy::SOURCES`]), never a heading.
    pub group_label: &'static str,
    pub camera: CameraRowView,
    /// `captionsStatusLabel`.
    pub captions: String,
    pub chat: ChatDoorView,
}

/// What the app adds that the snapshot doesn't hold.
#[derive(Debug, Clone, Default)]
pub struct SourcesExtras<'a> {
    /// A livestream with chat is on air (`sessionIsLive` and the chat's
    /// providers), and what arrived since the Stream Manager last showed.
    pub chat_on_air: bool,
    pub chat_new_count: usize,
    /// The Images library's pictures, in slot order (the Background's
    /// value names a picture by them).
    pub images: &'a [Image],
    /// `runtimeInfo.platform`: `darwin`, `win32` or `linux`.
    pub platform: Option<&'a str>,
}

fn text(sources: &Value, key: &str) -> Option<String> {
    sources
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// `captionsStatusLabel(status, {enabled, sessionActive})`: the caption
/// service's state in a word. A `degraded` service that is unavailable
/// (`reasonCode: service-unavailable`) is "Paused" (#1593).
pub fn captions_status_label(
    status: Option<&Value>,
    enabled: bool,
    session_active: bool,
) -> &'static str {
    if !enabled {
        return "Off";
    }
    let field = |key: &str| {
        status
            .and_then(|status| status.get(key))
            .and_then(Value::as_str)
    };
    match field("state") {
        Some("starting") => "Starting…",
        Some("listening" | "live") => "Listening",
        Some("reconnecting") => "Reconnecting…",
        Some("degraded") if field("reasonCode") == Some("service-unavailable") => "Paused",
        Some("degraded") => "Higher delay",
        Some("blocked") => "Blocked",
        Some("error") => "Failed",
        Some("ready") => "Ready",
        _ if session_active => "Waiting…",
        _ => "Ready",
    }
}

/// `cameraSystemEffectLine` (`lib/camera-system-effect.ts`, plan 258 S4,
/// D12): the line under the Camera row when the operating system changes
/// the camera's background itself. Studio Light gets no line.
pub fn camera_system_effect_line(effect: Option<&CameraSystemEffect>) -> Option<&'static str> {
    let effect = effect?;
    if effect.provider == CameraSystemEffectProvider::MacosVideoEffects {
        if effect.background_replacement {
            return Some(
                "macOS is replacing this camera's background (Video menu, Background). Turn it off there to use Videorc's background.",
            );
        }
        if effect.background_blur {
            return Some(
                "macOS is blurring this camera (Video menu, Portrait). Turn it off there to use Videorc's background.",
            );
        }
        return None;
    }
    if effect.turned_off_by_videorc {
        return Some("Windows Studio Effects blur is off while Videorc's background is on.");
    }
    if effect.background_blur {
        return Some(
            "Windows Studio Effects is blurring this camera (Quick Settings, Studio effects). Turn it off there to use Videorc's background.",
        );
    }
    None
}

/// `chatDoorNewLabel`: "{n} new" while a livestream with chat is on air.
pub fn chat_door_new_label(on_air: bool, chat_on: bool, new_count: usize) -> Option<String> {
    (on_air && chat_on).then(|| format!("{new_count} new"))
}

/// What `preview.camera.status` says about the camera's effects (its
/// `systemEffect` and `cameraBackground`), as the telemetry keeps it.
pub fn preview_camera_effects(
    telemetry: &HealthTelemetry,
) -> (Option<CameraSystemEffect>, Option<CameraBackgroundStatus>) {
    let Some(status) = telemetry.preview_camera.as_ref() else {
        return (None, None);
    };
    let read = |key: &str| status.get(key).filter(|value| !value.is_null()).cloned();
    (
        read("systemEffect").and_then(|value| serde_json::from_value(value).ok()),
        read("cameraBackground").and_then(|value| serde_json::from_value(value).ok()),
    )
}

/// The Background control for the selected camera, `None` without one.
pub fn camera_background_line(
    snapshot: &StudioSnapshot,
    images: &[Image],
    platform: Option<&str>,
) -> Option<CameraBackgroundLineView> {
    let camera_id = snapshot.settings.capture.sources.camera_id.as_deref()?;
    let background = background_for(
        snapshot.settings.studio.get("cameraBackgrounds"),
        Some(camera_id),
    );
    Some(CameraBackgroundLineView {
        choice: choice_id(&background),
        value_label: value_label(&background, images),
        effect_reason: platform_reason(platform),
        is_effect: is_effect(Some(&background)),
        background,
    })
}

impl SourcesSectionView {
    /// `useStudioSources` and `QuickSettings`, over the Studio's snapshot
    /// and the camera's preview status.
    pub fn from_snapshot(
        snapshot: &StudioSnapshot,
        telemetry: &HealthTelemetry,
        extras: &SourcesExtras<'_>,
    ) -> Self {
        let devices = &snapshot.sources.devices.devices;
        let sources = snapshot
            .settings
            .capture_doc
            .get("sources")
            .cloned()
            .unwrap_or(Value::Null);
        let discovery_pending = !matches!(snapshot.connection, Connection::Connected { .. })
            || !snapshot.sources.devices_known;
        let session = &snapshot.session;
        let owns = session.phase.is_active() && !session.status.replay_only;
        let session_active = owns || session.start_pending || session.stop_pending;
        let camera_reason = snapshot.source_reasons[1].clone();
        let camera_id = text(&sources, "cameraId");
        let picker = picker_view(&PickerInput {
            kind: SourceKind::Camera,
            devices: camera_picker_devices(devices),
            value: camera_id
                .clone()
                .or_else(|| text(&sources, "wantedCameraId")),
            selected_name: text(&sources, "cameraName")
                .or_else(|| text(&sources, "wantedCameraName")),
            selected_device: camera_id
                .as_ref()
                .and_then(|id| devices.iter().find(|device| &device.id == id)),
            discovery_pending,
            none_label: Some(copy::OFF),
            selection_label: None,
            group_by_kind: false,
        });
        let row = SourceRowView {
            status: switch_status_line(
                SourceKind::Camera,
                &snapshot.live_sources,
                devices,
                camera_reason.as_deref(),
            ),
            stand_in: source_stand_in(&sources, SourceKind::Camera, devices)
                .map(|stand_in| stand_in_line(&stand_in)),
            disabled_reason: camera_reason,
            picker,
        };
        let (system_effect, stage) = preview_camera_effects(telemetry);
        let camera = CameraRowView {
            row,
            open_label: copy::OPEN_SOURCES,
            open_page: Some(PageId::Sources),
            background: camera_background_line(snapshot, extras.images, extras.platform),
            background_stage: stage_line(stage.as_ref()),
            system_effect: camera_system_effect_line(system_effect.as_ref()),
        };
        Self {
            group_label: copy::SOURCES,
            camera,
            captions: captions_status_label(
                snapshot.captions_status.as_ref(),
                snapshot.settings.capture.captions.enabled,
                session_active,
            )
            .to_string(),
            chat: ChatDoorView {
                new_label: chat_door_new_label(extras.chat_on_air, true, extras.chat_new_count),
                accelerator: copy::STREAM_MANAGER_ACCELERATOR,
            },
        }
    }
}

impl<B: StudioBackend> Studio<B> {
    /// `captions.status.get`, on every connection.
    pub(super) async fn read_captions_status(&self, generation: u64) {
        let Ok(answer) = self
            .backend
            .captions_request(CAPTIONS_STATUS_GET_METHOD, Value::Null)
            .await
        else {
            return;
        };
        if self.lock().bootstrap_generation != generation {
            return;
        }
        self.apply_captions_status(answer);
    }

    /// `captions.status`: the Captions row reads its state and reason.
    pub(super) fn apply_captions_status(&self, payload: Value) {
        {
            let mut inner = self.lock();
            if inner.captions_status.as_ref() == Some(&payload) {
                return;
            }
            inner.captions_status = Some(payload);
        }
        self.publish();
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_captions_word_says_paused_when_the_service_is_unavailable() {
        let degraded = json!({"state": "degraded", "reasonCode": "service-unavailable"});
        assert_eq!(captions_status_label(Some(&degraded), true, true), "Paused");
        let slow = json!({"state": "degraded", "reasonCode": "high-latency"});
        assert_eq!(
            captions_status_label(Some(&slow), true, true),
            "Higher delay"
        );
        assert_eq!(captions_status_label(Some(&degraded), false, true), "Off");
        assert_eq!(captions_status_label(None, true, true), "Waiting…");
        assert_eq!(captions_status_label(None, true, false), "Ready");
        assert_eq!(
            captions_status_label(Some(&json!({"state": "live"})), true, true),
            "Listening"
        );
    }

    fn effect(provider: CameraSystemEffectProvider) -> CameraSystemEffect {
        CameraSystemEffect {
            provider,
            background_blur: false,
            background_replacement: false,
            studio_light: false,
            turned_off_by_videorc: false,
        }
    }

    #[test]
    fn the_system_effect_line_names_the_menu_that_turns_it_off() {
        assert_eq!(camera_system_effect_line(None), None);
        let mac = effect(CameraSystemEffectProvider::MacosVideoEffects);
        assert_eq!(camera_system_effect_line(Some(&mac)), None);
        assert_eq!(
            camera_system_effect_line(Some(&CameraSystemEffect {
                studio_light: true,
                ..mac
            })),
            None,
            "Studio Light changes the face, not the room"
        );
        assert_eq!(
            camera_system_effect_line(Some(&CameraSystemEffect {
                background_blur: true,
                background_replacement: true,
                ..mac
            })),
            Some(
                "macOS is replacing this camera's background (Video menu, Background). Turn it off there to use Videorc's background."
            )
        );
        assert_eq!(
            camera_system_effect_line(Some(&CameraSystemEffect {
                background_blur: true,
                ..mac
            })),
            Some(
                "macOS is blurring this camera (Video menu, Portrait). Turn it off there to use Videorc's background."
            )
        );
        let windows = effect(CameraSystemEffectProvider::WindowsStudioEffects);
        assert_eq!(
            camera_system_effect_line(Some(&CameraSystemEffect {
                background_blur: true,
                ..windows
            })),
            Some(
                "Windows Studio Effects is blurring this camera (Quick Settings, Studio effects). Turn it off there to use Videorc's background."
            )
        );
        assert_eq!(
            camera_system_effect_line(Some(&CameraSystemEffect {
                turned_off_by_videorc: true,
                ..windows
            })),
            Some("Windows Studio Effects blur is off while Videorc's background is on.")
        );
    }

    #[test]
    fn the_preview_status_carries_the_cameras_effects() {
        let mut telemetry = HealthTelemetry::default();
        assert_eq!(preview_camera_effects(&telemetry), (None, None));
        telemetry.preview_camera = Some(json!({
            "state": "live",
            "systemEffect": {
                "provider": "macos-video-effects", "backgroundBlur": true,
                "backgroundReplacement": false, "studioLight": false,
                "turnedOffByVideorc": false
            },
            "cameraBackground": {
                "mode": "blur", "state": "cover", "processedFrames": 10,
                "coverFrames": 90, "coverForMs": 2500
            }
        }));
        let (effect, stage) = preview_camera_effects(&telemetry);
        assert!(effect.is_some_and(|effect| effect.background_blur));
        assert_eq!(
            stage_line(stage.as_ref()).as_deref(),
            Some(
                "Background is catching up. Viewers see your whole camera blurred until it's back."
            )
        );
    }

    #[test]
    fn the_chat_door_counts_only_while_chat_is_on_air() {
        assert_eq!(chat_door_new_label(false, true, 3), None);
        assert_eq!(chat_door_new_label(true, true, 3).as_deref(), Some("3 new"));
    }
}
