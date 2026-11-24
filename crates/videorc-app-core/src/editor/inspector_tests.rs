//! Plan 220 S3.3c: the inspector's maths and views, ported with the
//! renderer's tests (`transform-fields-math.test.ts`, `screen-zoom.test.ts`,
//! `screen-size-field.test.ts`, `banner-inspector.test.ts`,
//! `hide-screen-section.test.ts`, `layout-tab.test.ts`).

use serde_json::{Value, json};
use videorc_protocol::overlay_layout::OverlayRect;
use videorc_protocol::{Banner, SceneSource};

use super::*;
use crate::studio::families::{AddedPasswordManager, PrivacySettings};

fn patch(
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> TransformPatch {
    TransformPatch {
        x,
        y,
        width,
        height,
    }
}

#[test]
fn percents_format_with_at_most_one_decimal_and_parse_back() {
    assert_eq!(format_percent_value(0.5), "50");
    assert_eq!(format_percent_value(1.0), "100");
    assert_eq!(format_percent_value(0.0), "0");
    assert_eq!(format_percent_value(0.1234), "12.3");
    assert_eq!(format_percent_value(0.0505), "5.1");
    assert!((parse_percent_value("50").unwrap() - 0.5).abs() < 1e-9);
    assert!((parse_percent_value(" 12.3 ").unwrap() - 0.123).abs() < 1e-9);
    assert!((parse_percent_value("75%").unwrap() - 0.75).abs() < 1e-9);
    assert!((parse_percent_value("12,5").unwrap() - 0.125).abs() < 1e-9);
    assert_eq!(parse_percent_value(""), None);
    assert_eq!(parse_percent_value("abc"), None);
    assert_eq!(parse_percent_value("1/2"), None);
}

#[test]
fn a_field_edit_patches_its_axis_and_keeps_five_percent_on_the_canvas() {
    let committed = StageRect::new(0.6, 0.6, 0.3, 0.2);
    assert_eq!(
        transform_field_patch("x", 0.25, committed, true),
        patch(Some(0.25), None, None, None)
    );
    assert_eq!(
        transform_field_patch("x", -0.9, committed, false),
        patch(Some(-0.25), None, None, None)
    );
    assert_eq!(
        transform_field_patch("y", 3.0, committed, false),
        patch(None, Some(0.95), None, None)
    );
    let huge = StageRect::new(-1.5, -1.5, 4.0, 4.0);
    assert_eq!(
        transform_field_patch("x", -3.5, huge, false),
        patch(Some(-3.0), None, None, None)
    );
    assert_eq!(
        transform_field_patch("width", 9.0, committed, false),
        patch(None, None, Some(4.0), None)
    );
    assert_eq!(
        transform_field_patch("width", 0.1, StageRect::new(0.97, 0.6, 0.3, 0.2), false),
        patch(Some(0.95), None, Some(0.1), None)
    );
}

#[test]
fn a_locked_size_edit_scales_both_axes_and_the_limiting_axis_wins() {
    let committed = StageRect::new(0.6, 0.6, 0.3, 0.2);
    let wide = transform_field_patch("width", 0.6, committed, true);
    assert_eq!((wide.width, wide.height), (Some(0.6), Some(0.4)));
    let short = transform_field_patch("height", 0.1, committed, true);
    assert_eq!((short.width, short.height), (Some(0.15), Some(0.1)));
    let ceiling = transform_field_patch("width", 9.0, committed, true);
    assert_eq!((ceiling.width, ceiling.height), (Some(4.0), Some(2.6667)));
    let floor = transform_field_patch("width", 0.01, committed, true);
    assert_eq!((floor.width, floor.height), (Some(0.075), Some(0.05)));
}

#[test]
fn the_pixel_line_and_the_crop_sides_read_as_the_renderers() {
    assert_eq!(
        pixel_readout(StageRect::new(0.0, 0.0, 0.2, 0.3), 1920.0, 1080.0),
        "384 × 324 px on 1920 × 1080"
    );
    let none = StageCrop::default();
    assert_eq!(
        crop_field_patch("cropBottom", 0.33333, none),
        ("cropBottom".into(), 0.3333)
    );
    assert_eq!(
        crop_field_patch("cropTop", -0.2, none),
        ("cropTop".into(), 0.0)
    );
    assert_eq!(
        crop_field_patch("cropRight", 1.2, none),
        ("cropRight".into(), 0.95)
    );
    let left = StageCrop {
        left: 0.6,
        ..StageCrop::default()
    };
    assert_eq!(
        crop_field_patch("cropRight", 0.9, left),
        ("cropRight".into(), 0.35)
    );
}

#[test]
fn a_picture_edit_goes_back_through_the_stage_margin() {
    let screen = SceneSourceKind::Screen;
    assert_eq!(
        picture_edit_to_frame(patch(Some(0.18), None, None, None), &screen, 0.1, false),
        patch(Some(0.1), None, None, None)
    );
    assert_eq!(
        picture_edit_to_frame(
            patch(Some(0.18), None, None, None),
            &SceneSourceKind::Camera,
            0.1,
            false
        ),
        patch(Some(0.18), None, None, None)
    );
    // A camera the scene stages goes back through the margin too (#1353).
    assert_eq!(
        picture_edit_to_frame(
            patch(Some(0.18), None, None, None),
            &SceneSourceKind::Camera,
            0.1,
            true
        ),
        patch(Some(0.1), None, None, None)
    );
    let canvas = PixelSize {
        width: 2560.0,
        height: 1440.0,
    };
    let frame = StageRect::new(0.0932, 0.0932, 0.9068, 0.9068);
    let picture = StageRect::new(
        389.0 / 2560.0,
        134.0 / 1440.0,
        2021.0 / 2560.0,
        1306.0 / 1440.0,
    );
    assert_eq!(
        picture_edit_frame_patch(
            patch(Some(0.2), None, None, None),
            picture,
            frame,
            &screen,
            0.0,
            canvas,
            false
        ),
        patch(Some(0.2), Some(0.0931), Some(0.7895), Some(0.9069))
    );
    let rounded = StageRect::new(
        239.0 / 2560.0,
        134.0 / 1440.0,
        2321.0 / 2560.0,
        1306.0 / 1440.0,
    );
    assert_eq!(
        picture_edit_frame_patch(
            patch(Some(0.2), None, None, None),
            rounded,
            frame,
            &screen,
            0.0,
            canvas,
            false
        ),
        patch(Some(0.2), None, None, None)
    );
}

#[test]
fn a_typed_crop_keeps_the_uncropped_picture_in_place() {
    let picture = StageRect::new(0.15, 0.1, 0.8, 0.9);
    let crop = with_crop_field(StageCrop::default(), "cropLeft", 0.25);
    assert_eq!(crop.left, 0.25);
    let rect = crop_edit_on_picture(crop, picture, StageCrop::default());
    assert!((rect.x - (0.15 + 0.25 * 0.8)).abs() < 1e-4);
    assert!((rect.width - 0.6).abs() < 1e-4);
    assert!((rect.height - 0.9).abs() < 1e-4);
}

#[test]
fn zoom_scales_around_the_centre_from_100_to_400() {
    assert_eq!(screen_zoom_of(StageRect::new(0.0, 0.0, 1.0, 1.0)), 100.0);
    assert_eq!(
        screen_zoom_of(StageRect::new(-0.25, -0.25, 1.5, 1.5)),
        150.0
    );
    assert_eq!(screen_zoom_of(StageRect::new(0.25, 0.25, 0.5, 0.5)), 100.0);
    let full = StageRect::new(0.0, 0.0, 1.0, 1.0);
    assert_eq!(
        screen_zoom_patch(full, 200.0),
        StageRect::new(-0.5, -0.5, 2.0, 2.0)
    );
    assert_eq!(
        screen_zoom_patch(full, 900.0),
        StageRect::new(-1.5, -1.5, 4.0, 4.0)
    );
    assert_eq!(screen_zoom_patch(full, 50.0), full);
}

#[test]
fn screen_size_is_the_backgrounds_visibility_turned_around() {
    assert_eq!(screen_size_of(20.0), 80.0);
    assert_eq!(screen_size_of(55.0), 60.0);
    assert_eq!(visibility_for_screen_size(80.0), 20.0);
    assert_eq!(visibility_for_screen_size(10.0), 40.0);
}

#[test]
fn the_camera_look_rides_the_sliders_both_ways() {
    let look = json!({"brightness": 0.1, "contrast": 1.2, "saturation": 0.5});
    let sliders = look_sliders(Some(&look));
    assert_eq!(
        sliders,
        LookSliders {
            brightness: 40,
            contrast: 40,
            saturation: -50
        }
    );
    assert_eq!(look_of_sliders(sliders), look);
    assert_eq!(look_sliders(None), LookSliders::default());
    assert_eq!(
        normalize_camera_look(&json!({"brightness": 0, "contrast": 1, "saturation": 1})),
        None
    );
    assert_eq!(
        normalize_camera_look(&json!({"brightness": 2, "contrast": 1, "saturation": 1})),
        Some(json!({"brightness": 0.25, "contrast": 1.0, "saturation": 1.0}))
    );
}

#[test]
fn rounded_snaps_the_aspect_to_square_and_the_defaults_leave_the_layout_alone() {
    assert_eq!(
        Value::Object(camera_shape_patch("rounded")),
        json!({"cameraShape": "rounded", "cameraAspect": "square"})
    );
    assert_eq!(
        Value::Object(camera_shape_patch("circle")),
        json!({"cameraShape": "circle"})
    );
    let defaults = camera_settings_defaults();
    // Placement, frame and lens: never the layout, and never the key, which
    // belongs to the camera's background now (#1673).
    assert_eq!(defaults.len(), 13);
    assert!(!defaults.contains_key("layoutPreset"));
    assert!(
        defaults
            .keys()
            .all(|key| !key.starts_with("cameraChromaKey"))
    );
    assert_eq!(
        copy::CAMERA_RESET_DESCRIPTION,
        "Placement, frame and lens go back to their defaults, on a running stream or recording too. The layout, your sources and the background stay."
    );
}

#[test]
fn the_position_lock_and_the_placement_line_follow_the_session() {
    assert_eq!(scene_position_lock_reason(false, None), None);
    assert_eq!(scene_position_lock_reason(true, Some(true)), None);
    assert_eq!(
        scene_position_lock_reason(true, Some(false)),
        Some(copy::POSITION_UNAVAILABLE_REASON)
    );
    assert_eq!(
        scene_position_lock_reason(true, None),
        Some(copy::POSITION_LOCK_REASON)
    );
    let idle = placement_controls(true, false, None, false);
    assert_eq!(idle.description, copy::PLACEMENT_HINT);
    assert!(!idle.nudge_disabled);
    let live = placement_controls(true, true, Some(true), false);
    assert_eq!(live.description, copy::LIVE_PLACEMENT_HINT);
    assert!(placement_controls(false, false, None, false).nudge_disabled);
}

#[test]
fn overlay_snaps_put_the_default_size_inside_the_margins() {
    let rect = overlay_snap_rect("highlight", false, "bottom-right");
    assert_eq!(rect.w, 0.6);
    assert_eq!(rect.h, 0.26);
    assert!((rect.x - (1.0 - 0.0225 - 0.6)).abs() < 1e-6);
    assert!((rect.y - (1.0 - 0.04 - 0.26)).abs() < 1e-6);
    let portrait = overlay_snap_rect("buddy", true, "top-left");
    assert!((portrait.y - 0.08).abs() < 1e-6);
}

fn banner(id: &str, shown: bool) -> Banner {
    Banner {
        id: id.into(),
        name: format!("Banner {id}"),
        kind: videorc_protocol::BannerKind::Image,
        image_file: String::new(),
        thumbnail_file: String::new(),
        width: 1200,
        height: 200,
        has_alpha: false,
        sort_order: 0,
        shown,
        horizontal: OverlayRect::new(0.6, 0.85, 0.38, 0.1),
        vertical: OverlayRect::new(0.1, 0.7, 0.8, 0.1),
        show_on_stream: true,
        show_in_recording: true,
        opacity: 1.0,
        hide_after_sec: None,
        repeat_every_min: None,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

#[test]
fn a_banners_words_follow_its_state_timer_and_size() {
    let mut shown = banner("a", true);
    assert_eq!(
        banner_state_line(&shown),
        ("shown", copy::BANNER_SHOWING_LINE)
    );
    shown.show_on_stream = false;
    shown.show_in_recording = false;
    assert_eq!(banner_state_line(&shown), ("off", copy::BANNER_OFF_LINE));
    assert_eq!(
        banner_state_line(&banner("b", false)),
        ("hidden", copy::BANNER_HIDDEN_LINE)
    );
    assert_eq!(banner_seconds_label(30), "30 s");
    assert_eq!(banner_seconds_label(90), "1 min 30 s");
    assert_eq!(
        banner_timing_summary(30, 15).as_deref(),
        Some("Shows for 30 s every 15 min")
    );
    assert_eq!(
        banner_timing_summary(0, 15).as_deref(),
        Some("Every 15 min")
    );
    assert_eq!(
        banner_timing_summary(10, 0).as_deref(),
        Some("Hides after 10 s")
    );
    assert_eq!(banner_timing_summary(0, 0), None);
    assert_eq!(
        banner_timing_choices(&BANNER_REPEAT_CHOICES, 7),
        vec![0, 5, 7, 10, 15, 30]
    );
    let advice = banner_size_advice(&banner("a", true), (1920.0, 1080.0), None);
    assert!(
        advice
            .size_line
            .starts_with("Size on your 1920 × 1080 recording: ")
    );
    assert!(advice.sharp, "{advice:?}");
    assert_eq!(
        banner_snap_rect(&banner("a", true), false, 16.0 / 9.0, "full-frame"),
        OverlayRect::new(0.0, 0.0, 1.0, 1.0)
    );
}

#[test]
fn banners_move_in_the_order_and_four_showing_is_the_limit() {
    let banners: Vec<Banner> = ["a", "b", "c"].iter().map(|id| banner(id, false)).collect();
    assert_eq!(
        banner_order_after_move(&banners, "a", 2),
        Some(vec!["b".into(), "c".into(), "a".into()])
    );
    assert_eq!(banner_order_after_move(&banners, "c", 9), None);
    let mut five: Vec<Banner> = ["a", "b", "c", "d"]
        .iter()
        .map(|id| banner(id, true))
        .collect();
    five.push(banner("e", false));
    let section = banners_section_view(&five, true, true, Some("e"), false);
    assert_eq!(
        section.rows[4].show_reason,
        Some(copy::BANNER_SHOWN_LIMIT_REASON)
    );
    assert!(section.rows[4].selected);
    assert_eq!(section.rows[0].show_reason, None);
}

#[test]
fn the_password_manager_list_keeps_one_row_and_restores_the_built_ins() {
    let defaults = PrivacySettings::default();
    let entries = password_manager_entries(&defaults);
    assert_eq!(entries.len(), BUILT_IN_PASSWORD_MANAGERS.len());
    assert_eq!(entries[0].name, "1Password");
    assert!(!built_in_password_managers_removed(&defaults));
    let without = remove_password_manager(&defaults, "com.1password.1password");
    assert_eq!(without.removed_password_manager_bundle_ids.len(), 4);
    assert!(built_in_password_managers_removed(&without));
    assert_eq!(restore_built_in_password_managers(&without), defaults);
    let mut one = PrivacySettings {
        added_password_managers: vec![AddedPasswordManager {
            bundle_id: "com.example.vault".into(),
            name: "Vault".into(),
        }],
        ..PrivacySettings::default()
    };
    for (_, ids) in BUILT_IN_PASSWORD_MANAGERS {
        one = remove_password_manager(&one, ids[0]);
    }
    assert_eq!(password_manager_entries(&one).len(), 1);
    assert!(!can_remove_password_manager(&one));
    assert_eq!(remove_password_manager(&one, "com.example.vault"), one);
}

fn source(id: &str, kind: &str, width: f64) -> SceneSource {
    let transform = json!({"x": 0.0, "y": 0.0, "width": width, "height": width});
    serde_json::from_value(json!({
        "id": id, "name": id, "kind": kind, "transform": transform, "defaultTransform": transform,
    }))
    .unwrap()
}

fn input<'a>(
    layout: &'a Value,
    sources: &'a Value,
    scene: &'a [SceneSource],
    selection: InspectorSelection,
) -> InspectorInput<'a> {
    InspectorInput {
        layout,
        sources,
        video: (1920.0, 1080.0),
        vertical_stream: None,
        vertical_view: false,
        scene_sources: scene,
        has_background: false,
        selection,
        picture: None,
        box_is_picture: false,
        aspect_locked: true,
        scene_edit_mode: true,
        session_active: false,
        accepts_live_scene_edits: None,
        stage_dragging: false,
        connected: true,
        visibility_percent: None,
        overlay_layout: None,
        captions: None,
        banners: &[],
    }
}

#[test]
fn the_inspector_shows_the_selections_own_sections() {
    let layout = json!({"layoutPreset": "screen-camera", "arrangementMode": "preset", "cameraShape": "circle"});
    let sources = json!({"cameraId": "cam", "testPattern": true});
    let scene = vec![
        source("source:screen", "test-pattern", 1.0),
        source("source:camera", "camera", 0.2),
    ];
    let camera = inspector_view(&input(
        &layout,
        &sources,
        &scene,
        InspectorSelection::Source("source:camera".into()),
    ));
    assert_eq!(camera.kind, InspectorKind::Camera);
    let rows = camera.placement.as_ref().unwrap().camera.as_ref().unwrap();
    assert_eq!(rows.shape, Some(2));
    assert_eq!(rows.aspect, None, "a circle has no aspect");
    assert_eq!(rows.corner, Some(None));
    let fields = camera.placement.as_ref().unwrap().fields.as_ref().unwrap();
    assert_eq!(fields.forced_line, Some(copy::CAMERA_SHAPE_SETS_ASPECT));
    assert!(fields.aspect_locked);
    let screen = inspector_view(&input(
        &layout,
        &sources,
        &scene,
        InspectorSelection::Source("source:screen".into()),
    ));
    assert_eq!(screen.kind, InspectorKind::FullCanvas);
    assert_eq!(screen.description.as_deref(), Some(copy::FULL_CANVAS));
    let empty = inspector_view(&input(&layout, &sources, &scene, InspectorSelection::None));
    assert_eq!(empty.title, copy::INSPECTOR_TITLE);
    let overlay_layout = json!({"buddy": {"showOnStream": false, "showInRecording": false}});
    let mut buddy = input(
        &layout,
        &sources,
        &scene,
        InspectorSelection::Overlay("buddy"),
    );
    buddy.overlay_layout = Some(&overlay_layout);
    let buddy = inspector_view(&buddy);
    assert_eq!(buddy.overlay.unwrap().off_line, Some(copy::BUDDY_OFF_LINE));
}

/// S3.3x.2: with the Canvas on the vertical stream's overlays ("Overlays on"
/// Vertical), an overlay item snaps and a banner places on that stream;
/// the arrows wait for the editor (a click on the stage or Edit scene).
#[test]
fn the_vertical_view_names_the_vertical_streams_snaps_and_places() {
    let layout = json!({"layoutPreset": "screen-camera", "arrangementMode": "preset"});
    let sources = json!({"cameraId": "cam", "testPattern": true});
    let scene = vec![
        source("source:screen", "test-pattern", 1.0),
        source("source:camera", "camera", 0.2),
    ];
    let overlay_layout = json!({"chat": {"showOnStream": true, "showInRecording": true}});
    let mut chat = input(
        &layout,
        &sources,
        &scene,
        InspectorSelection::Overlay("chat"),
    );
    chat.overlay_layout = Some(&overlay_layout);
    assert_eq!(
        inspector_view(&chat).overlay.unwrap().snap_label,
        copy::SNAP_TO
    );
    chat.vertical_view = true;
    assert_eq!(
        inspector_view(&chat).overlay.unwrap().snap_label,
        copy::SNAP_VERTICAL
    );
    let banners = [banner("b1", true)];
    let mut one = input(
        &layout,
        &sources,
        &scene,
        InspectorSelection::Banner("b1".into()),
    );
    one.banners = &banners;
    assert_eq!(
        inspector_view(&one).banner.unwrap().place_label,
        copy::PLACE
    );
    one.vertical_view = true;
    one.vertical_stream = Some((1080.0, 1920.0));
    assert_eq!(
        inspector_view(&one).banner.unwrap().place_label,
        copy::PLACE_VERTICAL
    );
    let freeform = json!({"layoutPreset": "screen-camera", "arrangementMode": "freeform"});
    let boxed = vec![source("source:screen", "screen", 0.5)];
    let mut screen = input(
        &freeform,
        &sources,
        &boxed,
        InspectorSelection::Source("source:screen".into()),
    );
    screen.scene_edit_mode = false;
    assert_eq!(
        inspector_view(&screen).placement.unwrap().nudge,
        Some(false)
    );
    screen.scene_edit_mode = true;
    assert_eq!(inspector_view(&screen).placement.unwrap().nudge, Some(true));
}

#[test]
fn the_layout_section_names_the_presets_and_why_some_are_off() {
    let layout = json!({"layoutPreset": "screen-only", "arrangementMode": "preset", "horizontalScreenFraming": "fit"});
    let sources = json!({"testPattern": true});
    let view = layout_section_view(&LayoutInput {
        layout: &layout,
        sources: &sources,
        session_active: false,
        stage_busy: false,
        has_scene: true,
        pending: Some(("side-by-side", false)),
        animate: true,
        on_stream_shows_no_screen: false,
    });
    assert_eq!(view.preset_index, Some(1));
    // A pending switch keeps the layout's name, with its mark (#1312).
    assert_eq!(view.presets[3].label, "Side by side");
    assert!(view.presets[3].pending);
    assert!(!view.freeform_pending);
    assert!(view.presets[2].disabled, "Camera only needs a camera");
    assert_eq!(view.hint, Some((copy::NO_CAMERA_HINT, true)));
    assert_eq!(
        view.framing,
        Some((true, copy::FRAMING_FIT_HORIZONTAL, false))
    );
    let live = layout_section_view(&LayoutInput {
        layout: &layout,
        sources: &sources,
        session_active: true,
        stage_busy: false,
        has_scene: true,
        pending: None,
        animate: false,
        on_stream_shows_no_screen: false,
    });
    assert_eq!(live.orientation_lock, Some(copy::ORIENTATION_LOCK_REASON));
    assert_eq!(live.hint, Some((copy::LIVE_SWITCH_HINT, false)));
    // D19: with no screen chosen, a screen layout stays enabled for a scene
    // that shows none, and asks for its screen (Change screen…).
    let camera_only = json!({"cameraId": "camera:1"});
    let none = layout_section_view(&LayoutInput {
        layout: &json!({"layoutPreset": "camera-only"}),
        sources: &camera_only,
        session_active: false,
        stage_busy: false,
        has_scene: true,
        pending: None,
        animate: false,
        on_stream_shows_no_screen: true,
    });
    let screen_only = &none.presets[1];
    assert_eq!(screen_only.label, "Screen only");
    assert!(!screen_only.disabled);
    assert!(screen_only.asks_for_screen);
    assert!(
        !none.presets[2].asks_for_screen,
        "Camera only draws no screen"
    );
}

#[test]
fn captions_show_where_live_captions_says_never_where_the_item_did() {
    assert_eq!(captions_output_switches(None), (false, false));
    assert_eq!(
        captions_output_switches(Some(&json!({"enabled": true, "burnTarget": "both"}))),
        (true, true)
    );
    assert_eq!(
        captions_output_switches(Some(&json!({"enabled": true, "burnTarget": "stream"}))),
        (true, false)
    );
    assert_eq!(
        captions_output_switches(Some(&json!({"enabled": false, "burnTarget": "both"}))),
        (false, false)
    );
    let saved = json!({
        "captions": {"showOnStream": false, "showInRecording": true, "x": 0.1},
        "chat": {"showOnStream": true, "showInRecording": false}
    });
    let shown = overlay_layout_for_display(
        &saved,
        Some(&json!({"enabled": true, "burnTarget": "stream"})),
    );
    assert_eq!(
        shown["captions"],
        json!({"showOnStream": true, "showInRecording": false, "x": 0.1})
    );
    assert_eq!(shown["chat"], saved["chat"]);
    assert_eq!(captions_outputs_summary(false, true), "Off");
    assert_eq!(
        captions_outputs_summary(true, true),
        "On, live stream and recording"
    );
    assert_eq!(
        captions_outputs_summary(true, false),
        "On, live stream only"
    );
}

#[test]
fn an_html_banner_says_where_its_page_stands_and_is_sharp_up_to_1080p() {
    use videorc_protocol::{BannerKind, HtmlOverlayState, HtmlOverlayStatus};
    let status =
        |state: HtmlOverlayState, detail: Option<&str>, blocked: Option<u32>| HtmlOverlayStatus {
            id: "a".into(),
            state,
            detail: detail.map(str::to_string),
            frame_width: None,
            frame_height: None,
            blocked_requests: blocked,
        };
    let mut page = banner("a", true);
    page.kind = BannerKind::Html;
    // An image banner, a hidden page or no status: nothing to say.
    assert_eq!(
        html_overlay_status_line(
            &banner("a", true),
            Some(&status(HtmlOverlayState::Loading, None, None))
        ),
        None
    );
    assert_eq!(html_overlay_status_line(&page, None), None);
    let loading =
        html_overlay_status_line(&page, Some(&status(HtmlOverlayState::Loading, None, None)))
            .unwrap();
    assert_eq!(
        (loading.line.as_str(), loading.warn),
        ("Loading the page…", false)
    );
    let failed =
        html_overlay_status_line(&page, Some(&status(HtmlOverlayState::Failed, None, None)))
            .unwrap();
    assert_eq!(
        (failed.line.as_str(), failed.warn),
        ("This banner stopped.", true)
    );
    let detail = html_overlay_status_line(
        &page,
        Some(&status(
            HtmlOverlayState::Unavailable,
            Some("Not while recording."),
            None,
        )),
    )
    .unwrap();
    assert_eq!(detail.line, "Not while recording.");
    assert_eq!(
        html_overlay_status_line(&page, Some(&status(HtmlOverlayState::Live, None, Some(0)))),
        None
    );
    assert_eq!(
        html_overlay_status_line(&page, Some(&status(HtmlOverlayState::Live, None, Some(1))))
            .unwrap()
            .line,
        "The network is off for HTML banners: 1 request was blocked. Put fonts, images and scripts in the banner's folder."
    );
    assert_eq!(
        html_overlay_status_line(&page, Some(&status(HtmlOverlayState::Live, None, Some(3))))
            .unwrap()
            .line,
        "The network is off for HTML banners: 3 requests were blocked. Put fonts, images and scripts in the banner's folder."
    );
    let mut hidden = page.clone();
    hidden.shown = false;
    assert_eq!(
        html_overlay_status_line(&hidden, Some(&status(HtmlOverlayState::Failed, None, None))),
        None
    );
    // The size advice: drawn at the pixels it lands on, up to 1080p.
    let small = banner_size_advice(&page, (1920.0, 1080.0), None);
    assert!(small.sharp);
    assert_eq!(small.verdict_line, copy::HTML_BANNER_SHARP);
    let mut full = page.clone();
    full.horizontal = OverlayRect::new(0.0, 0.0, 1.0, 1.0);
    full.width = 3840;
    full.height = 2160;
    let big = banner_size_advice(&full, (3840.0, 2160.0), None);
    assert!(!big.sharp);
    assert_eq!(big.verdict_line, copy::HTML_BANNER_SOFT);
}

#[test]
fn the_hide_screen_key_says_when_wayland_cant_hear_it() {
    assert_eq!(
        hide_screen_shortcut_hint(false),
        "Change it in Settings → Shortcuts. It works from any app."
    );
    assert_eq!(
        hide_screen_shortcut_hint(true),
        "Change it in Settings → Shortcuts. This Wayland session can't hear keys while Videorc is in the background, so it won't work here."
    );
    assert_eq!(layout_preset_label("vertical-camera-top"), "Camera top");
    assert_eq!(layout_preset_label("side-by-side"), "Side by side");
}
