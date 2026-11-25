//! Pinned by `protocol-fixtures/cloud-parity-outputs.json` (the vectors
//! Electron's `shared/cloud-output-profile.ts` and the web reproduce) and by
//! Electron's `lib/talk-show-outputs.test.ts`.

use serde_json::{Value, json};

use super::*;
use crate::studio::capture_config::default_capture_config;

const FIXTURE: &str = include_str!("../../../../protocol-fixtures/cloud-parity-outputs.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("the outputs fixture is JSON")
}

#[test]
fn admission_matches_every_fixture_case() {
    let fixture = fixture();
    let cases = fixture["admission"].as_array().expect("admission cases");
    assert!(!cases.is_empty());
    for case in cases {
        let name = case["name"].as_str().unwrap_or("?");
        let outputs: Vec<ManagedOutput> =
            serde_json::from_value(case["outputs"].clone()).expect(name);
        let problem = managed_output_problem(&outputs);
        assert_eq!(problem.as_deref(), case["problem"].as_str(), "{name}");
        if problem.is_none() {
            let profile = serde_json::to_value(managed_output_profile(&outputs)).unwrap();
            assert_eq!(profile, case["profile"], "{name}");
        }
    }
}

#[test]
fn destinations_match_every_fixture_case() {
    let fixture = fixture();
    let cases = fixture["destinations"]
        .as_array()
        .expect("destination cases");
    assert!(!cases.is_empty());
    for case in cases {
        let name = case["name"].as_str().unwrap_or("?");
        let destination = &case["destination"];
        let room: Vec<&str> = case["orientations"]
            .as_array()
            .expect(name)
            .iter()
            .filter_map(Value::as_str)
            .collect();
        let problem = managed_destination_problem(
            destination["label"].as_str().expect(name),
            destination["orientation"].as_str().expect(name),
            destination["url"].as_str(),
            &room,
        );
        assert_eq!(problem.as_deref(), case["problem"].as_str(), "{name}");
    }
}

#[test]
fn the_description_says_the_picture_in_its_stream() {
    let outputs = [ManagedOutput {
        orientation: "horizontal".into(),
        width: 1920,
        height: 1080,
        fps: 30,
        video_kbps: 6000,
        audio_kbps: None,
    }];
    // `cloud-output-profile.test.ts`: the words name the 30 fps picture in
    // the 60 fps stream.
    let words = managed_profile_description(Some(&managed_output_profile(&outputs)));
    assert_eq!(
        words,
        "Horizontal 1920×1080, 30 fps picture in a 60 fps stream, 6 Mbps H.264, AAC 160 kbps. \
         One cloud output; recording adds one per orientation. 1440p and 4K aren't available yet."
    );
    assert!(managed_profile_description(None).contains("didn't report its output profile"));
}

fn target(patch: Value) -> Value {
    let mut target = json!({
        "id": "twitch",
        "platform": "twitch",
        "label": "Twitch",
        "serverUrl": "rtmp://live.twitch.tv/app",
        "enabled": true,
    });
    if let (Some(target), Some(patch)) = (target.as_object_mut(), patch.as_object()) {
        for (key, value) in patch {
            target.insert(key.clone(), value.clone());
        }
    }
    target
}

/// `config(targets, patch)` in Electron's test: the defaults, not recording,
/// streaming on with these destinations all enabled.
fn config(targets: Vec<Value>, record: bool) -> Value {
    let mut capture = default_capture_config("2026-11-25T00:00:00.000Z");
    let ids: Vec<Value> = targets.iter().map(|t| t["id"].clone()).collect();
    capture["recordEnabled"] = json!(record);
    capture["streaming"]["enabled"] = json!(true);
    capture["streaming"]["targets"] = json!(targets);
    capture["streaming"]["enabledTargetIds"] = json!(ids);
    capture
}

fn orientations(plan: &TalkShowOutputPlan) -> Vec<&str> {
    plan.outputs
        .iter()
        .map(|o| o.orientation.as_str())
        .collect()
}

#[test]
fn a_horizontal_destination_asks_for_one_horizontal_output() {
    let plan = talk_show_output_plan(&config(vec![target(json!({}))], false));
    assert_eq!(plan.problem, None);
    assert_eq!(orientations(&plan), vec!["horizontal"]);
    assert!(
        plan.description.starts_with("Horizontal 1920×1080"),
        "{}",
        plan.description
    );
}

#[test]
fn a_vertical_destination_adds_a_vertical_output_horizontal_first() {
    let plan = talk_show_output_plan(&config(
        vec![
            target(json!({})),
            target(json!({
                "id": "tiktok",
                "platform": "tiktok",
                "label": "TikTok",
                "serverUrl": "",
                "outputOrientation": "vertical",
            })),
        ],
        false,
    ));
    assert_eq!(plan.problem, None);
    assert_eq!(orientations(&plan), vec!["horizontal", "vertical"]);
    assert!(plan.outputs[1].height > plan.outputs[1].width);
    assert!(
        plan.description
            .contains("Each orientation is its own cloud output")
    );
}

#[test]
fn a_4k_youtube_stream_setting_is_refused_before_the_room_exists() {
    let plan = talk_show_output_plan(&config(
        vec![target(json!({
            "id": "yt",
            "platform": "youtube",
            "label": "YouTube",
            "serverUrl": "rtmp://a.rtmp.youtube.com/live2",
            "outputPreset": "stream-youtube-4k30",
            "outputBitrateKbps": 20000,
        }))],
        false,
    ));
    assert_eq!(plan.outputs.first().map(|o| o.width), Some(3840));
    let problem = plan.problem.clone().expect("refused");
    assert!(problem.contains("4K hasn't been measured"), "{problem}");
    assert_eq!(plan.description, problem);
}

#[test]
fn a_1080p60_stream_at_8_mbps_opens_saying_what_it_sends() {
    let plan = talk_show_output_plan(&config(
        vec![target(json!({
            "outputPreset": "stream-1080p60",
            "outputBitrateKbps": 8000,
        }))],
        false,
    ));
    assert_eq!(plan.problem, None);
    assert!(
        plan.description
            .contains("differs from your settings: 30 fps picture, 6 Mbps"),
        "{}",
        plan.description
    );
}

#[test]
fn a_recording_with_no_destination_opens_the_canvas_orientation() {
    let plan = talk_show_output_plan(&config(Vec::new(), true));
    assert_eq!(plan.outputs.len(), 1);
    assert_eq!(plan.problem, None);
}

#[test]
fn a_destination_with_a_non_rtmp_address_is_refused_before_the_room() {
    let plan = talk_show_output_plan(&config(
        vec![target(json!({ "serverUrl": "srt://example.com:9000" }))],
        false,
    ));
    let problem = plan.problem.expect("refused");
    assert!(problem.contains("rtmp:// or rtmps://"), "{problem}");
}

fn room(orientations: &[&str]) -> ManagedOutputProfile {
    let outputs: Vec<ManagedOutput> = orientations
        .iter()
        .map(|orientation| {
            let (width, height) = if *orientation == "vertical" {
                (1080, 1920)
            } else {
                (1920, 1080)
            };
            ManagedOutput {
                orientation: (*orientation).to_string(),
                width,
                height,
                fps: 30,
                video_kbps: 6000,
                audio_kbps: None,
            }
        })
        .collect();
    managed_output_profile(&outputs)
}

fn youtube_vertical() -> Value {
    target(json!({
        "id": "yt-v",
        "platform": "youtube",
        "label": "YouTube Vertical",
        "serverUrl": "rtmp://a.rtmp.youtube.com/live2",
        "outputOrientation": "vertical",
    }))
}

#[test]
fn an_open_room_refuses_a_vertical_destination_it_did_not_open_with() {
    let capture = config(vec![target(json!({})), youtube_vertical()], false);
    let problem = talk_show_output_start_problem(&capture, Some(&room(&["horizontal"])), true)
        .expect("refused");
    assert!(
        problem.contains("YouTube Vertical is vertical, and this room opened without"),
        "{problem}"
    );
    assert_eq!(
        talk_show_output_start_problem(&capture, Some(&room(&["horizontal", "vertical"])), true),
        None
    );
}

#[test]
fn a_record_only_start_or_a_room_without_a_profile_is_never_blocked_here() {
    let capture = config(vec![youtube_vertical()], false);
    assert_eq!(
        talk_show_output_start_problem(&capture, Some(&room(&["horizontal"])), false),
        None
    );
    assert_eq!(talk_show_output_start_problem(&capture, None, true), None);
}
