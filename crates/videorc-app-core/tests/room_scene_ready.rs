//! C3 room-scene readiness helpers (screen source + readiness poll ticks).

use serde_json::json;
use videorc_app_core::cloud_scene::types::{BackgroundMime, SceneBackground, SceneFit};
use videorc_app_core::cloud_scene::{
    ROOM_SOURCES_READY_POLL_MS, ROOM_SOURCES_READY_WAIT_MS, room_sources_ready,
    room_sources_ready_poll_ticks,
};
use videorc_app_core::studio::room_background::{
    PICTURE_ENCODE_GAP, background_fit, background_zoom_crop, hex_of, live_background_dim,
    prepare_room_background,
};
use videorc_app_core::studio::room_screen_source::{
    RoomScreenKind, RoomScreenSources, RoomScreenWant, capturer_id_for_native,
    native_id_for_capturer, room_screen_needs_switch, room_screen_needs_switch_native,
    room_screen_want,
};

#[test]
fn screen_source_maps_and_switches() {
    assert_eq!(
        capturer_id_for_native(Some("screen:screencapturekit:5")).as_deref(),
        Some("screen:5:0")
    );
    assert_eq!(
        native_id_for_capturer(Some("window:42:0")).as_deref(),
        Some("window:screencapturekit:42")
    );
    let want = room_screen_want(RoomScreenSources {
        window_id: Some("window:screencapturekit:42"),
        ..Default::default()
    });
    assert_eq!(
        want,
        RoomScreenWant::Source {
            capturer_id: "window:42:0".into(),
            source_kind: RoomScreenKind::Window,
            native_id: Some("window:screencapturekit:42".into()),
        }
    );
    assert!(!room_screen_needs_switch(&want, Some("window:42:0")));
    assert!(room_screen_needs_switch_native(
        &want,
        Some("window:screencapturekit:7")
    ));
}

#[test]
fn room_sources_ready_poll_contract() {
    assert!(room_sources_ready(false, true, false, false, true, false).is_ok());
    assert_eq!(
        room_sources_ready(false, true, false, false, false, false),
        Err("This scene shows a screen. Share your screen in the room first.")
    );
    assert_eq!(
        room_sources_ready_poll_ticks(ROOM_SOURCES_READY_WAIT_MS, ROOM_SOURCES_READY_POLL_MS),
        21
    );
}

#[test]
fn background_prepare_live_and_picture_gap() {
    let crop = background_zoom_crop(200.0, 0.0, 0.0);
    assert!((crop.l - 0.25).abs() < 1e-9);
    assert_eq!(background_fit("fit"), SceneFit::Contain);
    assert!((live_background_dim(40.0) - 0.4).abs() < 1e-9);

    let (prepared, _) = prepare_room_background(
        &json!({
            "dimPercent": 10,
            "live": { "id": "silk", "look": "satin", "motion": "normal" }
        }),
        100,
        None,
        None,
    )
    .expect("live");
    assert!(matches!(prepared.background, SceneBackground::Live { .. }));

    let err = prepare_room_background(
        &json!({ "assetId": "builtin-bg-01", "fit": "fill", "scale": 100 }),
        0,
        None,
        None,
    )
    .expect_err("gap");
    assert_eq!(err, PICTURE_ENCODE_GAP);

    let bytes = b"webp";
    let (picture, _) = prepare_room_background(
        &json!({
            "fit": "fit",
            "scale": 100,
            "width": 10,
            "height": 10,
            "mime": "image/webp"
        }),
        0,
        None,
        Some(bytes.as_slice()),
    )
    .expect("bytes");
    let asset = picture.asset.expect("asset");
    assert_eq!(asset.hash, hex_of(bytes));
    assert_eq!(asset.mime, BackgroundMime::Webp);
}
