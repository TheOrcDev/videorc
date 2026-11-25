//! The scene on stream's fields as data (`scene-on-stream.test.tsx`,
//! `screen-privacy-view.test.ts`, `studio-actions/privacy.test.ts`).

use serde_json::{Value, json};
use videorc_protocol::{Device, DeviceKind, DeviceStatus, ScreenPrivacy};

use super::*;
use crate::client::RpcError;
use crate::notices::NoticeKind;
use crate::scenes::v2::{Scene, SceneShows};
use crate::studio::live_sources::LiveSourcesView;

fn display() -> SceneShows {
    SceneShows::Display {
        screen_id: "screen:1".into(),
        screen_name: Some("Display 1".into()),
        screen_uuid: None,
    }
}

fn scene(shows: SceneShows) -> Scene {
    Scene {
        id: "talk".into(),
        name: "Talk".into(),
        created_at: String::new(),
        updated_at: String::new(),
        shows,
        horizontal: json!({"layoutPreset": "screen-camera"}),
        vertical: json!({"layoutPreset": "vertical-split", "verticalScreenFraming": "fill"}),
        background: Value::Null,
        audio: None,
        cloud: None,
    }
}

fn capture(preset: &str) -> Value {
    json!({
        "layout": {"layoutPreset": preset, "arrangementMode": "preset"},
        "sources": {"cameraId": "camera:1", "screenId": "screen:1"},
    })
}

fn armed(mut capture: Value) -> Value {
    capture["streamEnabled"] = json!(true);
    capture["streaming"] = json!({
        "enabled": true,
        "enabledTargetIds": ["tiktok"],
        "targets": [{"id": "tiktok", "enabled": true, "outputOrientation": "vertical"}],
    });
    capture
}

struct Fixture {
    scene: Option<Scene>,
    capture: Value,
    devices: Vec<Device>,
    live: LiveSourcesView,
    privacy: ScreenPrivacy,
    room: Option<RoomScreenPrivacy>,
    shortcuts: Value,
    connected: bool,
    read_only: bool,
}

impl Fixture {
    fn new() -> Self {
        Self {
            scene: Some(scene(display())),
            capture: capture("screen-camera"),
            devices: Vec::new(),
            live: LiveSourcesView::default(),
            privacy: ScreenPrivacy::default(),
            room: None,
            shortcuts: json!({}),
            connected: true,
            read_only: false,
        }
    }

    fn view(&self) -> Option<SceneOnStreamView> {
        SceneOnStreamView::of(SceneOnStreamInput {
            scene: self.scene.as_ref(),
            capture: &self.capture,
            devices: &self.devices,
            live_sources: &self.live,
            capture_reason: None,
            privacy: &self.privacy,
            room: self.room.as_ref(),
            shortcuts: &self.shortcuts,
            connected: self.connected,
            read_only: self.read_only,
        })
    }

    fn fields(&self) -> SceneOnStreamView {
        self.view().expect("a scene is on stream")
    }
}

#[test]
fn no_scene_on_stream_draws_no_fields() {
    let mut fixture = Fixture::new();
    fixture.scene = None;
    assert_eq!(fixture.view(), None);
}

#[test]
fn the_fields_name_the_scene_and_what_its_screen_shows() {
    let fields = Fixture::new().fields();
    assert_eq!(fields.id, "talk");
    assert_eq!(fields.name, "Talk");
    assert_eq!(copy::ON_STREAM, "On stream:");
    assert_eq!(copy::SAVES_HERE, "Changes here save into this scene.");
    assert_eq!(fields.screen_words, "Display 1");
    assert_eq!(fields.screen_note, None);
    assert_eq!(fields.switch_status, None);
    assert_eq!(fields.stand_in, None);
}

#[test]
fn a_layout_that_draws_no_screen_says_so_under_the_screen() {
    let mut fixture = Fixture::new();
    fixture.capture = capture("camera-only");
    let fields = fixture.fields();
    assert_eq!(fields.screen_words, "Display 1");
    assert_eq!(
        fields.screen_note.as_deref(),
        Some("Not shown in Camera only")
    );
    // Camera only frames no screen.
    assert_eq!(fields.framing, None);
}

#[test]
fn the_layout_field_lists_the_studios_orientation_with_the_one_on_now() {
    let fields = Fixture::new().fields();
    let layout = &fields.layout;
    assert_eq!(layout.description, "Each scene keeps its own 16:9 layout.");
    assert_eq!(layout.trigger, "Screen + camera");
    assert_eq!(layout.preset, "screen-camera");
    assert!(!layout.freeform);
    let values: Vec<_> = layout.choices.iter().map(|choice| choice.value).collect();
    assert_eq!(
        values,
        [
            "screen-camera",
            "screen-only",
            "camera-only",
            "side-by-side"
        ]
    );
    assert!(layout.choices.iter().all(|choice| !choice.disabled));
    assert_eq!(layout.camera_line, None);
    assert_eq!(layout.pick("side-by-side"), Some("side-by-side"));
    // The layout on now applies nothing again.
    assert_eq!(layout.pick("screen-camera"), None);
    assert_eq!(layout.pick("vertical-split"), None);
    // Screen + camera fits or fills by choice, Fit by default.
    assert_eq!(
        fields.framing,
        Some(FramingView {
            fit: true,
            line: "Shows your whole screen. A screen of another shape gets bars.",
            vertical: false,
        })
    );
}

#[test]
fn freeform_reads_freeform_and_any_layout_applies() {
    let mut fixture = Fixture::new();
    fixture.capture["layout"]["arrangementMode"] = json!("freeform");
    let layout = fixture.fields().layout;
    assert!(layout.freeform);
    assert_eq!(layout.trigger, "Freeform");
    assert_eq!(layout.pick("screen-camera"), Some("screen-camera"));
}

#[test]
fn without_a_camera_its_layouts_are_off_and_said_once() {
    let mut fixture = Fixture::new();
    fixture.capture["sources"]["cameraId"] = Value::Null;
    fixture.capture["layout"]["layoutPreset"] = json!("screen-only");
    let layout = fixture.fields().layout;
    let off: Vec<_> = layout
        .choices
        .iter()
        .filter(|choice| choice.disabled)
        .map(|choice| choice.value)
        .collect();
    assert_eq!(off, ["screen-camera", "camera-only", "side-by-side"]);
    assert_eq!(
        layout.camera_line.as_deref(),
        Some("Choose a camera in Sources to use Screen + camera, Camera only, and Side by side.")
    );
    assert_eq!(layout.pick("camera-only"), None);

    // The layout on now is never off, though the line still names it.
    fixture.capture["layout"]["layoutPreset"] = json!("camera-only");
    let layout = fixture.fields().layout;
    let current = layout
        .choices
        .iter()
        .find(|choice| choice.value == "camera-only")
        .unwrap();
    assert!(!current.disabled);
}

#[test]
fn a_scene_that_shows_no_screen_asks_for_one_before_a_screen_layout() {
    let mut fixture = Fixture::new();
    fixture.scene = Some(scene(SceneShows::None));
    fixture.capture = capture("camera-only");
    let fields = fixture.fields();
    assert_eq!(fields.screen_words, "No screen");
    assert_eq!(fields.screen_note, None);
    let asking: Vec<_> = fields
        .layout
        .choices
        .iter()
        .filter(|choice| choice.asks_for_screen)
        .map(|choice| choice.value)
        .collect();
    assert_eq!(asking, ["screen-camera", "screen-only", "side-by-side"]);
    // D19 waits for Change screen…'s picker.
    assert_eq!(fields.layout.pick("screen-only"), None);
}

#[test]
fn a_9_16_studio_frames_vertically_and_has_no_vertical_stream_fields() {
    let mut fixture = Fixture::new();
    fixture.capture = armed(capture("vertical-camera-top"));
    fixture.capture["layout"]["verticalScreenFraming"] = json!("fit");
    let fields = fixture.fields();
    assert_eq!(
        fields.layout.description,
        "Each scene keeps its own 9:16 layout."
    );
    assert_eq!(fields.layout.trigger, "Camera top");
    assert!(fields.layout.fit);
    assert_eq!(fields.layout.choices.len(), 6);
    assert_eq!(
        fields.framing,
        Some(FramingView {
            fit: true,
            line: "Shows your whole screen. The camera takes the rest.",
            vertical: true,
        })
    );
    assert_eq!(fields.vertical_stream, None);
}

#[test]
fn an_armed_vertical_stream_beside_a_16_9_studio_shows_the_scenes_9_16_layout() {
    let mut fixture = Fixture::new();
    assert_eq!(fixture.fields().vertical_stream, None, "not armed");
    fixture.capture = armed(capture("screen-camera"));
    let vertical = fixture.fields().vertical_stream.expect("armed");
    assert_eq!(
        vertical.description,
        "The 9:16 layout of Talk, the scene on stream. Each scene keeps its own."
    );
    assert_eq!(vertical.preset, "vertical-split");
    assert!(!vertical.fit);
    assert_eq!(copy::VERTICAL_STREAM, "Vertical stream");
    assert_eq!(
        vertical_stream_pick(&vertical, "vertical-camera-top"),
        Some("vertical-camera-top")
    );
    assert_eq!(vertical_stream_pick(&vertical, "vertical-split"), None);
    assert_eq!(
        vertical_framing_line(false),
        "Fills the area and crops the sides of your screen."
    );

    // A library this build can't change keeps it as it is.
    fixture.read_only = true;
    let vertical = fixture.fields().vertical_stream.expect("armed");
    assert_eq!(
        vertical.read_only_reason,
        Some("Update Videorc to change your scenes.")
    );
    assert_eq!(vertical_stream_pick(&vertical, "vertical-camera-top"), None);
}

#[test]
fn hide_screen_says_its_action_its_key_and_holds_its_chip() {
    let fields = Fixture::new().fields();
    let privacy = &fields.privacy;
    assert!(!privacy.hidden);
    assert_eq!(privacy.action_label, "Hide screen");
    assert_eq!(privacy.chip, None);
    assert_eq!(privacy.accelerator.as_deref(), Some("Control+Alt+H"));
    assert_eq!(privacy.disabled_reason, None);

    let mut fixture = Fixture::new();
    fixture.privacy.hidden = true;
    let privacy = fixture.fields().privacy;
    assert_eq!(privacy.action_label, "Show screen");
    assert_eq!(privacy.chip.as_deref(), Some("Screen hidden"));
    assert_eq!(privacy.chip_detail, None);
}

#[test]
fn the_key_is_the_saved_one_or_none_once_cleared() {
    assert_eq!(
        screen_hide_accelerator(None).as_deref(),
        Some("Control+Alt+H")
    );
    assert_eq!(
        screen_hide_accelerator(Some("Control+Alt+P")).as_deref(),
        Some("Control+Alt+P")
    );
    assert_eq!(screen_hide_accelerator(Some("")), None);
    let mut fixture = Fixture::new();
    fixture.shortcuts = json!({"screenHideToggle": ""});
    assert_eq!(fixture.fields().privacy.accelerator, None);
}

#[test]
fn only_a_hide_is_refused_and_nothing_runs_offline() {
    let refused = ScreenPrivacy {
        unavailable: Some("Hide screen isn't available on this recording.".into()),
        ..ScreenPrivacy::default()
    };
    assert_eq!(
        screen_privacy_disabled_reason(&refused, true).as_deref(),
        Some("Hide screen isn't available on this recording.")
    );
    let hidden = ScreenPrivacy {
        hidden: true,
        ..refused.clone()
    };
    assert_eq!(screen_privacy_disabled_reason(&hidden, true), None);
    assert_eq!(
        screen_privacy_disabled_reason(&hidden, false).as_deref(),
        Some("Videorc is reconnecting. Try again in a moment.")
    );
}

#[test]
fn a_room_says_more_than_hidden_and_what_it_confirmed() {
    assert_eq!(
        room_privacy_label(Some("hiding")),
        Some("Hiding · receivers pending")
    );
    assert_eq!(
        room_privacy_label(Some("observed")),
        Some("Frost observed · others unconfirmed")
    );
    assert_eq!(
        room_privacy_label(Some("unconfirmed")),
        Some("Screen blocked · receivers unconfirmed")
    );
    assert_eq!(
        room_privacy_label(Some("paused")),
        Some("Screen share paused · privacy unavailable")
    );
    assert_eq!(room_privacy_label(Some("visible")), None);
    assert_eq!(room_privacy_label(None), None);

    let mut fixture = Fixture::new();
    fixture.room = Some(RoomScreenPrivacy {
        hidden: true,
        status: Some("observed".into()),
        source_blocked_at: None,
        observations: vec!["guest-1".into(), "program".into()],
    });
    let privacy = fixture.fields().privacy;
    assert!(privacy.hidden, "the room's hide holds too");
    assert_eq!(privacy.action_label, "Show screen");
    assert_eq!(
        privacy.chip.as_deref(),
        Some("Frost observed · others unconfirmed")
    );
    assert_eq!(
        privacy.chip_detail.as_deref(),
        Some(
            "Source blocked: unavailable. Applied frost observations: guest-1, program. Other receivers remain unconfirmed."
        )
    );
    let empty = RoomScreenPrivacy {
        hidden: true,
        source_blocked_at: Some("2026-11-25T10:00:00Z".into()),
        ..RoomScreenPrivacy::default()
    };
    assert_eq!(
        room_privacy_detail(&empty).as_deref(),
        Some(
            "Source blocked: 2026-11-25T10:00:00Z. Applied frost observations: none. Other receivers remain unconfirmed."
        )
    );
}

#[test]
fn a_press_hides_for_you_or_shows() {
    assert_eq!(
        screen_privacy_request(false),
        ("screen.hide", json!({"reason": "you"}))
    );
    assert_eq!(screen_privacy_request(true), ("screen.show", Value::Null));
}

#[test]
fn success_is_silent_a_refused_hide_warns_and_a_failure_says_what_failed() {
    let done = screen_privacy_outcome(true, Ok(json!({"hidden": true, "generation": 3})));
    assert_eq!(done.notice, None);
    assert!(done.privacy.expect("the new state").hidden);

    let refused = screen_privacy_outcome(
        true,
        Err(RpcError::new(
            "screen.hide",
            SCREEN_HIDE_UNAVAILABLE_CODE,
            "legacy",
        )),
    );
    assert_eq!(refused.privacy, None);
    let notice = refused.notice.expect("a warning");
    let notice = notice.notice().expect("a toast");
    assert_eq!(notice.kind, NoticeKind::Warning);
    assert_eq!(
        notice.title,
        "Hide screen isn't available on this recording. Stop and record again."
    );
    assert_eq!(notice.id.as_deref(), Some("screen-hide-unavailable"));

    let failed =
        screen_privacy_outcome(false, Err(RpcError::new("screen.show", "internal", "boom")));
    let notice = failed.notice.expect("a toast");
    let notice = notice.notice().expect("a toast");
    assert_eq!(notice.id.as_deref(), Some("screen-privacy"));
    assert_eq!(notice.title, "Couldn't show your screen");
}

fn screen_device(status: DeviceStatus) -> Device {
    serde_json::from_value(json!({
        "id": "screen:1",
        "name": "Display 1",
        "kind": DeviceKind::Screen,
        "status": status,
    }))
    .unwrap()
}

#[test]
fn the_screen_recording_alert_shows_while_the_grant_is_missing() {
    let missing = [screen_device(DeviceStatus::PermissionRequired)];
    let alert = screen_recording_alert(&missing, PermissionPlatform::MacOs, None)
        .expect("the grant is missing");
    assert_eq!(alert.alert.pane, SystemPermissionPane::ScreenRecording);
    assert_eq!(
        alert.alert.title,
        "Screen Recording permission is required for Videorc."
    );
    // Windows needs no grant, and Linux lists none.
    assert_eq!(
        screen_recording_alert(&missing, PermissionPlatform::Windows, None),
        None
    );
    assert_eq!(
        screen_recording_alert(&missing, PermissionPlatform::Other, None),
        None
    );
}
