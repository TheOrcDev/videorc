// Case-by-case parity with `protocol-fixtures/cloud-parity-scenes.json`
// (Electron `shared/cloud-scene.test.ts`).
// Included from `tests/cloud_scene.rs` so these run without compiling the
// crate's other broken `#[cfg(test)]` modules on this branch of main.

use std::cell::{Cell, RefCell};

use serde::Deserialize;
use serde_json::Value;
use videorc_app_core::cloud_scene::{
    CloudScene, CloudSceneSkipReason, RoomSceneCommitState, SceneCanvas, SceneCrop, SceneFit,
    SceneGuests, SceneItem, SceneMask, SceneMotionBox, SceneOrientation, ScenePage,
    ScenePicturePlacement, ScenePixelRect, SceneRole, SceneRoster, SceneSnapshot, SceneSourceSize,
    SceneTile, SceneTransition, SceneTransitionKind, SceneReceiver, cloud_scene_from_native,
    default_scene_guests, parse_cloud_scene_extension, parse_scene_capability, parse_scene_snapshot,
    plan_scene_tiles_parts, room_scene_canvas, room_scene_message, scene_content_key, scene_ease,
    scene_motion, scene_picture, scene_progress, stage_layout_clears_scene,
};
use videorc_protocol::{Scene, SceneSource, SceneSourceKind, SceneTransform};

const FIXTURE: &str = include_str!("../../../../protocol-fixtures/cloud-parity-scenes.json");

#[derive(Debug, Deserialize)]
struct Fixture {
    page: ScenePage,
    plan: Vec<PlanCase>,
    picture: Vec<PictureCase>,
    ease: Vec<(f64, f64)>,
    motion: Vec<MotionCase>,
    snapshots: Vec<SnapshotCase>,
}

#[derive(Debug, Deserialize)]
struct PlanScene {
    items: Vec<SceneItem>,
    guests: SceneGuests,
}

#[derive(Debug, Deserialize)]
struct PlanCase {
    name: String,
    scene: PlanScene,
    canvas: SceneCanvas,
    roster: SceneRoster,
    expected: Vec<SceneTile>,
}

#[derive(Debug, Deserialize)]
struct PictureCase {
    name: String,
    frame: ScenePixelRect,
    source: SceneSourceSize,
    crop: SceneCrop,
    fit: SceneFit,
    expected: ScenePicturePlacement,
}

#[derive(Debug, Deserialize)]
struct MotionCase {
    name: String,
    from: Option<SceneMotionBox>,
    to: SceneMotionBox,
    progress: f64,
    expected: SceneMotionBox,
}

#[derive(Debug, Deserialize)]
struct SnapshotCase {
    name: String,
    snapshot: Value,
    valid: bool,
}

fn fixture() -> Fixture {
    serde_json::from_str(FIXTURE).expect("cloud-parity-scenes.json")
}

#[test]
fn plans_match_parity_fixture() {
    let fixture = fixture();
    for one in &fixture.plan {
        let got = plan_scene_tiles_parts(
            &one.scene.items,
            &one.scene.guests,
            one.canvas,
            &one.roster,
        );
        assert_eq!(got, one.expected, "plans {}", one.name);
    }
}

#[test]
fn pictures_match_parity_fixture() {
    let fixture = fixture();
    for one in &fixture.picture {
        let got = scene_picture(one.frame, one.source, one.crop, one.fit);
        assert_eq!(got, one.expected, "places {}", one.name);
    }
}

#[test]
fn eases_like_rust_ease_in_out_cubic() {
    let fixture = fixture();
    for (t, value) in fixture.ease {
        let got = scene_ease(t);
        assert!(
            (got - value).abs() < 1e-12,
            "ease({t}) = {got}, expected {value}"
        );
    }
}

#[test]
fn motion_matches_parity_fixture() {
    let fixture = fixture();
    for one in &fixture.motion {
        let got = scene_motion(one.from, one.to, one.progress);
        assert_eq!(got, one.expected, "moves: {}", one.name);
    }
}

#[test]
fn snapshots_parse_match_parity_fixture() {
    let fixture = fixture();
    for one in &fixture.snapshots {
        let parsed = parse_scene_snapshot(&one.snapshot, &fixture.page);
        assert_eq!(
            parsed.is_some(),
            one.valid,
            "parses: {} (got {:?})",
            one.name,
            parsed.as_ref().map(|s| s.revision)
        );
    }
}

#[test]
fn never_drops_a_guest_and_keeps_host_exact_alone() {
    let fixture = fixture();
    let scene = &fixture.plan[0].scene;
    for n in 0..=6 {
        let guests: Vec<String> = (0..n).map(|i| format!("g_{i}")).collect();
        let tiles = plan_scene_tiles_parts(
            &scene.items,
            &scene.guests,
            SceneCanvas {
                width: 1920.0,
                height: 1080.0,
            },
            &SceneRoster {
                host: "host:sh_x".into(),
                guests: guests.clone(),
                screen: Some("host:sh_x".into()),
                host_on_stage: true,
            },
        );
        let guest_tiles: Vec<_> = tiles
            .iter()
            .filter(|t| t.role.starts_with("guest:"))
            .collect();
        assert_eq!(guest_tiles.len(), n);
        if n == 0 {
            let screen = tiles.iter().find(|t| t.role == "screen").expect("screen");
            assert_eq!(
                screen.rect,
                ScenePixelRect {
                    x: 0.0,
                    y: 0.0,
                    w: 1920.0,
                    h: 1080.0
                }
            );
        }
        for (i, tile) in guest_tiles.iter().enumerate() {
            for (j, other) in guest_tiles.iter().enumerate() {
                if i == j {
                    continue;
                }
                let separate = tile.rect.x + tile.rect.w <= other.rect.x
                    || other.rect.x + other.rect.w <= tile.rect.x
                    || tile.rect.y + tile.rect.h <= other.rect.y
                    || other.rect.y + other.rect.h <= tile.rect.y;
                assert!(separate, "guest tiles overlap at n={n}");
            }
        }
    }
}

#[test]
fn default_guest_regions_round_trip_extension() {
    for orientation in [SceneOrientation::H, SceneOrientation::V] {
        let guests = default_scene_guests(orientation);
        let value = serde_json::json!({ "version": 1, "guests": guests });
        let parsed = parse_cloud_scene_extension(&value).expect("extension");
        assert_eq!(parsed.guests, guests);
    }
    let bad = serde_json::json!({
        "version": 2,
        "guests": default_scene_guests(SceneOrientation::H)
    });
    assert!(parse_cloud_scene_extension(&bad).is_none());
}

#[test]
fn scene_capability_rejects_bad_applied_sid() {
    let scene = serde_json::json!({
        "version": 1,
        "output": "recording",
        "orientation": "v"
    });
    let parsed = parse_scene_capability(&scene).expect("capability");
    assert_eq!(parsed.version, 1);
    assert!(parsed.applied.is_none());
    let with_private = serde_json::json!({
        "version": 1,
        "output": "recording",
        "orientation": "v",
        "private": "x"
    });
    assert_eq!(
        parse_scene_capability(&with_private).expect("ignores unknown"),
        parsed
    );
    assert!(
        parse_scene_capability(&serde_json::json!({
            "version": 1,
            "output": "recording",
            "orientation": "v",
            "applied": { "publisherSid": "nope", "revision": 1 }
        }))
        .is_none()
    );
}

#[test]
fn late_join_continues_transition_phase() {
    let t = SceneTransition {
        kind: SceneTransitionKind::Motion,
        duration_ms: 320,
        apply_at: 1000,
    };
    assert_eq!(scene_progress(&t, 1000), 0.0);
    assert_eq!(scene_progress(&t, 1160), 0.5);
    assert_eq!(scene_progress(&t, 5000), 1.0);
    assert_eq!(
        scene_progress(
            &SceneTransition {
                kind: SceneTransitionKind::Cut,
                duration_ms: 0,
                apply_at: 9_000_000_000_000,
            },
            0
        ),
        1.0
    );
}

#[test]
fn content_keys_ignore_scene_id() {
    let fixture = fixture();
    let scene_value = fixture.snapshots[0]
        .snapshot
        .get("scene")
        .cloned()
        .expect("scene");
    let scene: CloudScene = serde_json::from_value(scene_value).expect("cloud scene");
    let mut other = scene.clone();
    other.id = "ffffffff".into();
    assert_eq!(
        scene_content_key(Some(&scene)),
        scene_content_key(Some(&other))
    );
    assert_eq!(scene_content_key(None), "none");
}

#[test]
fn receiver_confirms_only_drawn_latest_revision() {
    let fixture = fixture();
    let page = fixture.page.clone();
    let base = parse_scene_snapshot(&fixture.snapshots[0].snapshot, &page).expect("base snap");
    let now = page.now;
    let shown = RefCell::new(Vec::<Option<i64>>::new());
    let mut receiver = SceneReceiver::new(
        |snap: Option<&SceneSnapshot>| shown.borrow_mut().push(snap.map(|s| s.revision)),
        || now,
    );
    let snap = |revision: i64| {
        let mut s = base.clone();
        s.revision = revision;
        s
    };
    receiver.owner(Some("PA_host1"));
    assert!(receiver.accept(snap(2)));
    assert!(receiver.applied().is_none());
    assert!(!receiver.accept(snap(1)));
    receiver.rendered(1);
    assert!(receiver.applied().is_none());
    receiver.rendered(2);
    assert_eq!(
        receiver.applied().map(|a| (a.publisher_sid.as_str(), a.revision)),
        Some(("PA_host1", 2))
    );
    assert!(receiver.accept(snap(3)));
    assert!(receiver.applied().is_none());
}

#[test]
fn receiver_drops_on_lease_or_owner_change() {
    let fixture = fixture();
    let page = fixture.page.clone();
    let base = parse_scene_snapshot(&fixture.snapshots[0].snapshot, &page).expect("base snap");
    let now = Cell::new(page.now);
    let shown = RefCell::new(Vec::<Option<i64>>::new());
    let mut receiver = SceneReceiver::new(
        |snap: Option<&SceneSnapshot>| shown.borrow_mut().push(snap.map(|s| s.revision)),
        || now.get(),
    );
    let snap = |revision: i64| {
        let mut s = base.clone();
        s.revision = revision;
        s
    };
    receiver.owner(Some("PA_host1"));
    receiver.accept(snap(5));
    receiver.rendered(5);
    now.set(now.get() + 30_000);
    receiver.step();
    assert_eq!(shown.borrow().last().copied(), Some(None));
    assert!(receiver.applied().is_none());
    now.set(now.get() - 30_000);
    receiver.accept(snap(6));
    receiver.owner(Some("PA_host2"));
    assert_eq!(shown.borrow().last().copied(), Some(None));
    assert!(!receiver.accept(snap(7)));
}

#[test]
fn adapter_canvas_and_clear_helpers() {
    assert_eq!(room_scene_canvas(SceneOrientation::H).width, 1920.0);
    assert_eq!(room_scene_canvas(SceneOrientation::V).height, 1920.0);
    assert!(!stage_layout_clears_scene(None, "grid"));
    assert!(!stage_layout_clears_scene(Some("grid"), "grid"));
    assert!(stage_layout_clears_scene(Some("grid"), "spotlight"));
    assert!(room_scene_message(RoomSceneCommitState::Applied, None).is_none());
    assert!(
        room_scene_message(RoomSceneCommitState::Preview, None)
            .unwrap()
            .contains("stream or recording")
    );
}

fn transform(x: f64, y: f64, width: f64, height: f64) -> SceneTransform {
    SceneTransform {
        x,
        y,
        width,
        height,
        crop_left: 0.0,
        crop_top: 0.0,
        crop_right: 0.0,
        crop_bottom: 0.0,
    }
}

#[test]
fn native_translation_copies_frames_and_skips_diagnostics() {
    let full = transform(0.0, 0.0, 1.0, 1.0);
    let camera = SceneTransform {
        x: 0.74,
        y: 0.7,
        width: 0.22,
        height: 0.2475,
        crop_left: 0.125,
        crop_top: 0.125,
        crop_right: 0.125,
        crop_bottom: 0.125,
    };
    let scene = Scene {
        id: "scene:default".into(),
        name: "Default Scene".into(),
        sources: vec![
            SceneSource {
                id: "source:base".into(),
                name: "base".into(),
                kind: SceneSourceKind::Screen,
                device_id: None,
                transform: full.clone(),
                default_transform: full.clone(),
                visible: true,
                locked: false,
            },
            SceneSource {
                id: "source:camera".into(),
                name: "camera".into(),
                kind: SceneSourceKind::Camera,
                device_id: None,
                transform: camera.clone(),
                default_transform: camera,
                visible: true,
                locked: false,
            },
        ],
        outputs: vec![],
        background: None,
    };
    let layout = serde_json::json!({
        "layoutPreset": "screen-camera",
        "cameraShape": "rounded",
        "cameraCornerRadiusPct": 18,
        "cameraMirror": true,
        "cameraFit": "fill"
    });
    let out = cloud_scene_from_native(&scene, &layout, None, SceneOrientation::H, None);
    assert!(out.skipped.is_empty());
    assert!(out.needs.camera && out.needs.screen);
    assert_eq!(out.scene.items[0].role, SceneRole::Screen);
    assert_eq!(out.scene.items[0].fit, SceneFit::Contain);
    assert_eq!(out.scene.items[1].role, SceneRole::HostCamera);
    assert_eq!(out.scene.items[1].fit, SceneFit::Cover);
    assert_eq!(out.scene.items[1].mirror, true);
    assert_eq!(
        out.scene.items[1].mask,
        SceneMask::Rounded { radius: 0.18 }
    );
    assert_eq!(out.scene.guests, default_scene_guests(SceneOrientation::H));

    let mut diagnostic = scene;
    diagnostic.sources[0].kind = SceneSourceKind::TestPattern;
    diagnostic.sources[0].id = "source:test-pattern".into();
    diagnostic.sources[1].visible = false;
    let skipped = cloud_scene_from_native(&diagnostic, &layout, None, SceneOrientation::H, None);
    assert!(skipped.scene.items.is_empty());
    assert_eq!(
        skipped
            .skipped
            .iter()
            .map(|s| s.reason.clone())
            .collect::<Vec<_>>(),
        vec![CloudSceneSkipReason::TestPattern, CloudSceneSkipReason::Hidden]
    );
}
