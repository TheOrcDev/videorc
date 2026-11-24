//! `lib/camera-background-view.test.ts`, case for case.

use serde_json::json;
use videorc_protocol::{CameraBackgroundMode, CameraBackgroundStageState, CameraBackgroundStatus};

use super::*;

fn off() -> Value {
    default_camera_background()
}

fn with(fields: Value) -> Value {
    let mut out = off();
    for (key, value) in fields.as_object().unwrap() {
        out[key] = value.clone();
    }
    out
}

fn images() -> Vec<Image> {
    vec![
        Image {
            asset_id: "builtin-bg-01".into(),
            name: "Dusk".into(),
            picture: Some("/assets/dusk.webp".into()),
        },
        Image {
            asset_id: "builtin-bg-06".into(),
            name: "Loft".into(),
            picture: None,
        },
        Image {
            asset_id: "imported-1".into(),
            name: "My office".into(),
            picture: None,
        },
    ]
}

#[test]
fn each_tile_makes_one_background_keeping_the_rest_of_the_pick() {
    let tuned = with(
        json!({"blurPct": 55, "key": {"similarityPct": 44, "smoothnessPct": 5, "spillPct": 21}}),
    );
    let mut slight = tuned.clone();
    slight["mode"] = json!("blur");
    slight["blurPct"] = json!(30);
    assert_eq!(background_for_choice(&tuned, &ChoiceId::SlightBlur), slight);
    let strong = background_for_choice(&tuned, &ChoiceId::StrongBlur);
    assert_eq!(
        (strong["mode"].clone(), strong["blurPct"].clone()),
        (json!("blur"), json!(70))
    );
    let mut blue = tuned.clone();
    blue["mode"] = json!("blue");
    assert_eq!(background_for_choice(&tuned, &ChoiceId::Blue), blue);
    let mut back_off = tuned.clone();
    back_off["mode"] = json!("off");
    assert_eq!(background_for_choice(&blue, &ChoiceId::Off), back_off);
    let mut image = tuned.clone();
    image["mode"] = json!("image");
    image["assetId"] = json!("builtin-bg-06");
    assert_eq!(
        background_for_choice(&tuned, &ChoiceId::Image("builtin-bg-06".into())),
        image
    );
}

#[test]
fn the_pick_lights_its_tile_and_the_nearer_blur_mark() {
    assert_eq!(choice_id(&off()), Some(ChoiceId::Off));
    assert_eq!(
        choice_id(&with(json!({"mode": "blur", "blurPct": 30}))),
        Some(ChoiceId::SlightBlur)
    );
    assert_eq!(
        choice_id(&with(json!({"mode": "blur", "blurPct": 50}))),
        Some(ChoiceId::SlightBlur)
    );
    assert_eq!(
        choice_id(&with(json!({"mode": "blur", "blurPct": 51}))),
        Some(ChoiceId::StrongBlur)
    );
    assert_eq!(
        choice_id(&with(json!({"mode": "image", "assetId": "loft"}))),
        Some(ChoiceId::Image("loft".into()))
    );
    assert_eq!(choice_id(&with(json!({"mode": "image"}))), None);
    assert_eq!(
        choice_id(&with(json!({"mode": "green"}))),
        Some(ChoiceId::Green)
    );
    assert_eq!(choice_id(&with(json!({"mode": "video"}))), None);
    assert_eq!(choice_id(&with(json!({"mode": "cutout"}))), None);
    assert_eq!(ChoiceId::Image("loft".into()).as_string(), "image:loft");
}

#[test]
fn the_pick_in_words() {
    let label = |fields: Value| value_label(&with(fields), &images());
    assert_eq!(label(json!({})), "Off");
    assert_eq!(label(json!({"mode": "blur", "blurPct": 30})), "Slight blur");
    assert_eq!(label(json!({"mode": "blur", "blurPct": 70})), "Strong blur");
    assert_eq!(label(json!({"mode": "blur", "blurPct": 64})), "Blur 64%");
    assert_eq!(
        label(json!({"mode": "image", "assetId": "imported-1"})),
        "My office"
    );
    assert_eq!(
        label(json!({"mode": "image", "assetId": "gone"})),
        "Picture"
    );
    assert_eq!(label(json!({"mode": "green"})), "Green screen");
    assert_eq!(label(json!({"mode": "blue"})), "Blue screen");
}

fn input<'a>(images: &'a [Image], camera: bool, room: bool, platform: &'a str) -> ChoicesInput<'a> {
    ChoicesInput {
        images,
        camera_selected: camera,
        room_open: room,
        platform: Some(platform),
        image_limit: None,
    }
}

#[test]
fn off_the_blurs_the_pictures_and_the_screens_in_groups() {
    let images = images();
    let choices = choices(&ChoicesInput {
        image_limit: Some(2),
        ..input(&images, true, false, "darwin")
    });
    let rows: Vec<(&str, &str)> = choices
        .iter()
        .map(|choice| (choice.group.label(), choice.label.as_str()))
        .collect();
    assert_eq!(
        rows,
        [
            ("Blur", "Off"),
            ("Blur", "Slight blur"),
            ("Blur", "Strong blur"),
            ("Images", "Dusk"),
            ("Images", "Loft"),
            ("Screen behind you", "Green screen"),
            ("Screen behind you", "Blue screen"),
        ]
    );
    assert!(
        choices
            .iter()
            .all(|choice| choice.disabled_reason.is_none())
    );
    assert_eq!(choices[3].picture.as_deref(), Some("/assets/dusk.webp"));
}

#[test]
fn an_open_room_disables_the_effects_only() {
    let images = images();
    let reasons: Vec<(String, Option<&str>)> = choices(&input(&images, true, true, "darwin"))
        .into_iter()
        .map(|choice| (choice.id.as_string(), choice.disabled_reason))
        .collect();
    let room = Some(ROOM_BACKGROUND_UNAVAILABLE);
    assert_eq!(
        reasons,
        [
            ("off".to_string(), None),
            ("slight-blur".to_string(), room),
            ("strong-blur".to_string(), room),
            ("image:builtin-bg-01".to_string(), room),
            ("image:builtin-bg-06".to_string(), room),
            ("image:imported-1".to_string(), room),
            ("green".to_string(), None),
            ("blue".to_string(), None),
        ]
    );
}

#[test]
fn waits_for_the_platforms_stage_and_for_a_camera() {
    assert_eq!(platform_reason(Some("darwin")), None);
    assert_eq!(
        platform_reason(Some("win32")),
        Some("Background effects come to Windows in a later update.")
    );
    assert_eq!(
        platform_reason(Some("linux")),
        Some("Background effects come to Linux in a later update.")
    );
    let images = images();
    let open: Vec<String> = choices(&input(&images, true, false, "win32"))
        .into_iter()
        .filter(|choice| choice.disabled_reason.is_none())
        .map(|choice| choice.id.as_string())
        .collect();
    assert_eq!(open, ["off", "green", "blue"]);
    assert!(
        choices(&input(&images, false, false, "darwin"))
            .iter()
            .all(|choice| choice.disabled_reason == Some("Choose a camera first."))
    );
}

#[test]
fn the_picked_picture_comes_first() {
    let names = |picked: Option<&str>| -> Vec<String> {
        images_picked_first(&images(), picked)
            .into_iter()
            .map(|image| image.name)
            .collect()
    };
    assert_eq!(names(Some("imported-1")), ["My office", "Dusk", "Loft"]);
    assert_eq!(names(None), ["Dusk", "Loft", "My office"]);
    assert_eq!(names(Some("gone")), ["Dusk", "Loft", "My office"]);
}

#[test]
fn the_words_say_where_it_runs_and_what_a_blur_can_still_show() {
    assert_eq!(
        DESCRIPTION,
        "Blurs or replaces what's behind you in the recording, the livestream, Clips, Videorc Camera and the room. This camera keeps it in every scene."
    );
    assert_eq!(
        HINT,
        "Works best with light on your face. Done on this Mac, before anything is recorded or sent."
    );
    assert_eq!(
        LOCK_LINE,
        "Done on this Mac, before anything is recorded or sent."
    );
    assert_eq!(
        BLUR_CAVEAT,
        "A blur can still show large shapes and colors behind you. For full privacy, pick a picture."
    );
}

#[test]
fn command_k_offers_blur_or_turn_off_by_state() {
    assert_eq!(command(&off()), ("Blur background", ChoiceId::StrongBlur));
    assert_eq!(
        command(&with(json!({"mode": "green"}))),
        ("Blur background", ChoiceId::StrongBlur)
    );
    for mode in ["blur", "image", "video", "cutout"] {
        assert_eq!(
            command(&with(json!({"mode": mode}))),
            ("Turn off background effect", ChoiceId::Off)
        );
    }
    for word in [
        "blur",
        "virtual background",
        "background blur",
        "replace background",
    ] {
        assert!(KEYWORDS.contains(&word));
    }
}

fn status(
    mode: CameraBackgroundMode,
    state: CameraBackgroundStageState,
    cover_for_ms: Option<u64>,
) -> CameraBackgroundStatus {
    serde_json::from_value(json!({
        "mode": mode, "state": state, "processedFrames": 10, "coverFrames": 0,
        "coverForMs": cover_for_ms
    }))
    .unwrap()
}

#[test]
fn the_stage_line_says_nothing_while_it_runs() {
    use CameraBackgroundMode::*;
    use CameraBackgroundStageState::*;
    assert_eq!(stage_line(None), None);
    assert_eq!(stage_line(Some(&status(Blur, Running, None))), None);
    assert_eq!(stage_line(Some(&status(Blur, Cover, Some(1999)))), None);
    assert_eq!(stage_line(Some(&status(Blur, Cover, None))), None);
    assert_eq!(stage_line(Some(&status(Green, Cover, Some(9000)))), None);
}

#[test]
fn the_stage_line_says_what_viewers_see_while_the_cover_stands_in() {
    use CameraBackgroundMode::*;
    use CameraBackgroundStageState::*;
    assert_eq!(
        stage_line(Some(&status(Blur, Cover, Some(2000)))).as_deref(),
        Some("Background is catching up. Viewers see your whole camera blurred until it's back.")
    );
    assert_eq!(
        stage_line(Some(&status(Image, Cover, Some(5000)))).as_deref(),
        Some("Background is catching up. Viewers see only your picture until it's back.")
    );
    assert_eq!(
        stage_line(Some(&status(Blur, Unavailable, None))).as_deref(),
        Some(
            "Background effects can't run on this Mac right now. Viewers see your whole camera blurred until you turn the effect off."
        )
    );
}

#[test]
fn the_selected_cameras_background_or_off_with_strong_blur_ready() {
    let backgrounds = json!({"camera-a": {"mode": "blue"}});
    assert_eq!(
        background_for(Some(&backgrounds), Some("camera-a"))["mode"],
        "blue"
    );
    assert_eq!(background_for(Some(&backgrounds), Some("camera-b")), off());
    assert_eq!(background_for(None, None), off());
    assert_eq!(
        key_of(&off()),
        json!({"similarityPct": 40, "smoothnessPct": 8, "spillPct": 10})
    );
}

#[test]
fn a_typed_edge_is_a_whole_percent_from_0_to_25() {
    assert_eq!(parse_key_edge_pct("2"), Some(2.0));
    assert_eq!(parse_key_edge_pct(" 3 % "), Some(3.0));
    assert_eq!(parse_key_edge_pct("1,6"), Some(2.0));
    assert_eq!(parse_key_edge_pct("90"), Some(25.0));
    assert_eq!(parse_key_edge_pct("-4"), Some(0.0));
    assert_eq!(parse_key_edge_pct(""), None);
    assert_eq!(parse_key_edge_pct("left"), None);
}

#[test]
fn one_side_is_patched_and_a_no_op_ignored() {
    let none = json!({"leftPct": 0, "topPct": 0, "rightPct": 0, "bottomPct": 0});
    assert_eq!(
        key_edges_patch(&none, "leftPct", "2"),
        Some(json!({"leftPct": 2, "topPct": 0, "rightPct": 0, "bottomPct": 0}))
    );
    let left = json!({"leftPct": 2, "topPct": 0, "rightPct": 0, "bottomPct": 0});
    assert_eq!(key_edges_patch(&left, "leftPct", "2"), None);
    assert_eq!(key_edges_patch(&none, "bottomPct", "x"), None);
    assert_eq!(key_edges_of(None), none);
    assert!(!key_edges_set(&none));
    assert!(key_edges_set(&json!({"topPct": 1})));
}

#[test]
fn the_key_colour_in_either_case_and_its_words() {
    assert!(green_screen_is_blue(
        &json!({"cameraChromaKeyColor": "#0000FF"})
    ));
    assert!(green_screen_is_blue(
        &json!({"cameraChromaKeyColor": "#0000ff"})
    ));
    assert!(!green_screen_is_blue(
        &json!({"cameraChromaKeyColor": "#00ff00"})
    ));
    let blue_on = json!({"cameraChromaKeyColor": "#0000FF", "cameraChromaKeyEnabled": true});
    let blue_off = json!({"cameraChromaKeyColor": "#0000FF", "cameraChromaKeyEnabled": false});
    assert_eq!(green_screen_label(&blue_on), "Blue screen");
    assert_eq!(green_screen_label(&blue_off), "Green screen");
    assert_eq!(green_screen_command_label(&blue_on), "Turn off blue screen");
    assert_eq!(
        green_screen_command_label(&blue_off),
        "Turn on green screen"
    );
}

#[test]
fn a_draft_shows_for_its_camera_and_a_stale_drop_commits_nothing() {
    let backgrounds = json!({"camera-a": {"mode": "blur", "blurPct": 70}});
    let mut draft = BackgroundDraft::default();
    let dragged = with(json!({"mode": "blur", "blurPct": 40}));
    draft.hold(Some("camera-a"), dragged.clone());
    assert_eq!(draft.shown(Some(&backgrounds), Some("camera-a")), dragged);
    assert_eq!(draft.shown(Some(&backgrounds), Some("camera-b")), off());
    assert_eq!(draft.commit(Some("camera-b"), dragged.clone()), None);
    draft.hold(Some("camera-a"), dragged.clone());
    assert_eq!(
        draft.commit(Some("camera-a"), dragged.clone()),
        Some(dragged)
    );
    assert_eq!(draft, BackgroundDraft::default());
}
