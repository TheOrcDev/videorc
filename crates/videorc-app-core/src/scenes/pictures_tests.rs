//! The scene cards' stills: when they are asked for and what an answer does.

use videorc_protocol::scene_pictures::{ScenePicture, unavailable};

use super::*;

fn display(id: &str) -> ScenePictureTarget {
    ScenePictureTarget::Display {
        screen_id: id.into(),
    }
}

fn app(bundle: &str) -> ScenePictureTarget {
    ScenePictureTarget::App {
        bundle_id: bundle.into(),
    }
}

#[test]
fn each_thing_shown_has_one_key() {
    assert_eq!(picture_key(&display("screen:1")), "display:screen:1");
    assert_eq!(
        picture_key(&app("com.figma.Desktop")),
        "app:com.figma.Desktop"
    );
    assert_eq!(
        picture_key(&ScenePictureTarget::Window {
            window_id: "window:7".into()
        }),
        "window:window:7"
    );
}

#[test]
fn three_scenes_on_one_display_ask_one_still_in_key_order() {
    let inputs = PictureInputs::of(
        [
            display("screen:1"),
            app("com.figma.Desktop"),
            display("screen:1"),
            display("screen:1"),
        ],
        false,
        false,
    );
    assert_eq!(
        inputs.targets,
        [app("com.figma.Desktop"), display("screen:1")]
    );
    let params = inputs.params();
    assert_eq!(params.max_width, Some(240));
    assert_eq!(params.targets, inputs.targets);
    // A reorder of the cards asks the same.
    assert_eq!(
        PictureInputs::of(
            [display("screen:1"), app("com.figma.Desktop")],
            false,
            false
        ),
        inputs
    );
}

#[test]
fn only_macos_connected_and_idle_with_the_screen_shown_asks() {
    let inputs = PictureInputs::of([display("screen:1")], false, false);
    assert!(pictures_eligible(Some("darwin"), true, false, &inputs));
    assert!(!pictures_eligible(Some("win32"), true, false, &inputs));
    assert!(!pictures_eligible(Some("linux"), true, false, &inputs));
    assert!(!pictures_eligible(None, true, false, &inputs));
    assert!(!pictures_eligible(Some("darwin"), false, false, &inputs));
    assert!(!pictures_eligible(Some("darwin"), true, true, &inputs));
    let busy = PictureInputs::of([display("screen:1")], false, true);
    assert!(!pictures_eligible(Some("darwin"), true, false, &busy));
    let hidden = PictureInputs::of([display("screen:1")], true, false);
    assert!(!pictures_eligible(Some("darwin"), true, false, &hidden));
    let empty = PictureInputs::of(Vec::new(), false, false);
    assert!(!pictures_eligible(Some("darwin"), true, false, &empty));
}

#[test]
fn a_new_target_an_ended_session_or_a_shown_screen_asks_again() {
    let one = PictureInputs::of([display("screen:1")], false, false);
    let two = PictureInputs::of(
        [display("screen:1"), app("com.figma.Desktop")],
        false,
        false,
    );
    assert!(pictures_refresh_due(&one, &two));
    // A removed target or the same set asks nothing.
    assert!(!pictures_refresh_due(&two, &one));
    assert!(!pictures_refresh_due(&one, &one));

    let busy = PictureInputs::of([display("screen:1")], false, true);
    assert!(!pictures_refresh_due(&one, &busy), "a session starting");
    assert!(pictures_refresh_due(&busy, &one), "a session ending");

    let hidden = PictureInputs::of([display("screen:1")], true, false);
    assert!(!pictures_refresh_due(&one, &hidden), "the screen hiding");
    assert!(pictures_refresh_due(&hidden, &one), "the screen showing");
}

#[test]
fn coming_back_to_the_front_asks_at_most_every_30_seconds() {
    assert!(visibility_refresh_due(None, 0));
    assert!(!visibility_refresh_due(Some(10_000), 39_999));
    assert!(visibility_refresh_due(Some(10_000), 40_000));
}

#[test]
fn a_hidden_answer_keeps_an_unsupported_one_clears_and_pictures_decode() {
    let targets = vec![display("screen:1"), app("com.figma.Desktop")];
    assert_eq!(
        pictures_answer(&ScenePicturesResult::unavailable(
            targets.clone(),
            unavailable::HIDDEN
        )),
        PicturesAnswer::Keep
    );
    assert_eq!(
        pictures_answer(&ScenePicturesResult::unavailable(
            targets.clone(),
            unavailable::UNSUPPORTED
        )),
        PicturesAnswer::Unsupported
    );
    let result = ScenePicturesResult {
        pictures: vec![
            ScenePicture {
                target: display("screen:1"),
                outcome: ScenePictureOutcome::JpegBase64("aGVsbG8=".into()),
            },
            ScenePicture {
                target: app("com.figma.Desktop"),
                outcome: ScenePictureOutcome::Unavailable(unavailable::SOURCE_UNAVAILABLE.into()),
            },
        ],
        elapsed_ms: 12.0,
        hidden: None,
        unsupported: None,
    };
    let PicturesAnswer::Pictures(pictures) = pictures_answer(&result) else {
        panic!("expected pictures");
    };
    assert_eq!(pictures.len(), 1);
    assert_eq!(pictures["display:screen:1"], b"hello");
}
