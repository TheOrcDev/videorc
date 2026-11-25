//! The inspector's derivations, case for case with the renderer's tests
//! (`studio-session-view.test.ts`, `live-session-view.test.ts`,
//! `stream-health-attribution.test.ts`, `agents-view.test.ts`,
//! `session-output-video.test.ts`, `format-video.test.ts`,
//! `session-runtime-alert.test.ts`) where they cover what part 6a ports.

use std::time::{Duration, Instant};

use chrono::TimeZone;
use serde_json::json;
use videorc_protocol::{RecordingStatus, VideoPreset};

use super::*;
use crate::notices::{AudioIssue, MICROPHONE_SILENT_CODE, RuntimeActivity};
use crate::studio::health::DIAGNOSTICS_STATS_EVENT;
use crate::studio::session::{
    RecordingFailedNotice, SessionActivity, SessionStartFailure, SessionStartFailureKind,
    initial_status,
};
use crate::studio::source_selection::source_off_copy;
use crate::studio::test_support::{
    destination, health, ready_snapshot, set_destinations, set_status,
};
use crate::studio::{Connection, HealthSummary};

fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 10, 12, 0, 0).unwrap()
}

fn status(state: RecordingState, stream: bool) -> RecordingStatus {
    RecordingStatus {
        state,
        session_id: Some("s1".to_string()),
        stream_url: stream.then(|| "rtmp://127.0.0.1/live".to_string()),
        ..initial_status()
    }
}

fn idle() -> StudioSnapshot {
    ready_snapshot()
}

fn with_status(status: RecordingStatus) -> StudioSnapshot {
    let mut snapshot = ready_snapshot();
    set_status(&mut snapshot, status);
    snapshot
}

fn none() -> StartGates {
    StartGates::default()
}

fn video(width: u32, height: u32, fps: u32) -> VideoSettings {
    VideoSettings {
        preset: VideoPreset::Custom,
        width,
        height,
        fps,
        bitrate_kbps: 6_000,
    }
}

#[test]
fn going_live_needs_an_enabled_destination_that_is_ready() {
    let mut nothing_on = idle();
    set_destinations(&mut nothing_on, vec![destination("a", "Twitch", false)]);
    assert_eq!(
        live_stream_blocked_reason(&nothing_on, &none()).as_deref(),
        Some("Turn on a destination in Destinations before you go live.")
    );
    assert_eq!(
        record_blocked_reason(&nothing_on, &none()),
        None,
        "recording never needs one"
    );
    let mut no_streaming = idle();
    no_streaming.settings.capture.streaming = None;
    assert_eq!(
        live_stream_blocked_reason(&no_streaming, &none()).as_deref(),
        Some("Turn on a destination in Destinations before you go live.")
    );

    let not_ready = StartGates {
        destination_not_ready: true,
        ..none()
    };
    assert_eq!(
        live_stream_blocked_reason(&idle(), &not_ready).as_deref(),
        Some("Finish setting up your destination in Destinations before you go live.")
    );
    assert_eq!(live_stream_blocked_reason(&idle(), &none()), None);
}

#[test]
fn a_start_waits_for_the_engine_a_running_session_and_the_recorder() {
    let ready = idle();
    assert_eq!(record_blocked_reason(&ready, &none()), None);
    assert_eq!(live_stream_blocked_reason(&ready, &none()), None);
    assert_eq!(visible_start_blocked_reason(&ready, &none()), None);
    assert_eq!(blocked_jump(&ready, &none()), None);

    let mut waiting = idle();
    waiting.connection = Connection::Waiting;
    assert_eq!(
        record_blocked_reason(&waiting, &none()).as_deref(),
        Some("Starting Videorc's capture engine…")
    );
    assert_eq!(
        blocked_jump(&waiting, &none()),
        None,
        "no jump while connecting"
    );
    let mut away = idle();
    away.connection = Connection::Disconnected {
        reason: "x".to_string(),
    };
    assert_eq!(
        record_blocked_reason(&away, &none()).as_deref(),
        Some("Videorc is reconnecting. Try again in a moment.")
    );

    let mut checking = idle();
    checking.health = HealthSummary::default();
    assert_eq!(
        record_blocked_reason(&checking, &none()).as_deref(),
        Some("Checking the recorder…")
    );
    assert_eq!(
        visible_start_blocked_reason(&checking, &none()).as_deref(),
        Some("Checking the recorder…")
    );
    assert_eq!(blocked_jump(&checking, &none()), None);

    let mut missing = idle();
    missing.health = health(false);
    assert_eq!(
        record_blocked_reason(&missing, &none()).as_deref(),
        Some("Videorc's recorder isn't available. Export a support bundle from Health.")
    );
    assert_eq!(
        blocked_jump(&missing, &none()),
        Some(BlockedJump {
            label: "Open Health",
            page: PageId::Diagnostics
        }),
        "the recorder is fixed in Health"
    );

    let running = with_status(status(RecordingState::Recording, false));
    assert_eq!(
        record_blocked_reason(&running, &none()).as_deref(),
        Some("A recording or livestream is already running.")
    );
    assert_eq!(
        visible_start_blocked_reason(&running, &none()),
        None,
        "no line while a session runs"
    );
    let mut ring = status(RecordingState::Recording, false);
    ring.replay_only = true;
    assert_eq!(
        record_blocked_reason(&with_status(ring), &none()),
        None,
        "the Clips ring alone leaves Record free"
    );
    let mut pending = idle();
    pending.session.start_pending = true;
    assert_eq!(
        record_blocked_reason(&pending, &none()).as_deref(),
        Some("A recording or livestream is already running.")
    );
    assert_eq!(visible_start_blocked_reason(&pending, &none()), None);
    let mut stopping = idle();
    stopping.session.stop_pending = true;
    assert_eq!(
        record_blocked_reason(&stopping, &none()).as_deref(),
        Some("A recording or livestream is already running.")
    );

    assert_eq!(
        start_blocked_reason_for(
            &ready,
            &none(),
            SessionStartIntent {
                record: false,
                stream: false
            }
        )
        .as_deref(),
        Some("Turn on Save local recording in Output, or go live.")
    );
}

#[test]
fn a_scene_source_turned_off_blocks_both_starts() {
    let mut off = idle();
    off.settings.capture_doc["layout"] = json!({ "layoutPreset": "screen-camera" });
    off.settings.capture_doc["sources"] = json!({ "captureOff": true, "cameraOff": true });
    assert_eq!(
        record_blocked_reason(&off, &none()).as_deref(),
        Some(source_off_copy::BOTH)
    );
    assert_eq!(
        live_stream_blocked_reason(&off, &none()).as_deref(),
        Some(source_off_copy::BOTH)
    );
    assert_eq!(blocked_jump(&off, &none()), None);
    // A chosen screen wins over a stale Off (`usingVisualSources`).
    off.settings.capture_doc["sources"] = json!({
        "captureOff": true, "screenId": "screen:screencapturekit:1", "cameraOff": true
    });
    assert_eq!(
        record_blocked_reason(&off, &none()).as_deref(),
        Some(source_off_copy::CAMERA)
    );
}

#[test]
fn the_gates_block_in_the_renderers_order() {
    let ready = idle();
    let reason = |text: &str| Some(text.to_string());
    // Record: the recording profile, then its compatibility.
    let gates = StartGates {
        recording_profile: reason("7680 × 4320 · 30 fps exceeds the recording limit."),
        record_compatibility: reason("Windows can't encode this."),
        ..none()
    };
    assert_eq!(
        record_blocked_reason(&ready, &gates).as_deref(),
        Some("7680 × 4320 · 30 fps exceeds the recording limit.")
    );
    assert_eq!(
        visible_start_blocked_reason(&ready, &gates).as_deref(),
        Some("7680 × 4320 · 30 fps exceeds the recording limit."),
        "Record's reason first"
    );
    assert_eq!(
        blocked_jump(&ready, &gates),
        None,
        "studioBlocker has no jump for a quality over the plan"
    );
    let gates = StartGates {
        record_compatibility: reason("Windows can't encode this."),
        ..none()
    };
    assert_eq!(
        record_blocked_reason(&ready, &gates).as_deref(),
        Some("Windows can't encode this.")
    );
    assert_eq!(
        live_stream_blocked_reason(&ready, &gates),
        None,
        "each start reads its own compatibility"
    );

    // Go Live (recording too, as the Output page says): the recording
    // profile, the streaming profile, the compatibility, livestreaming,
    // the destination cap, then the destinations.
    let mut records = ready.clone();
    records.settings.capture.record_enabled = true;
    let all = StartGates {
        recording_profile: reason("recording profile"),
        streaming_profile: reason("streaming profile"),
        live_compatibility: reason("live compatibility"),
        livestreaming: reason("Livestreaming requires Videorc Premium."),
        go_live: reason("You can stream to up to 5 destinations at once."),
        destination_not_ready: true,
        stream_split: reason("split"),
        ..none()
    };
    let mut order = Vec::new();
    let mut gates = all.clone();
    while let Some(next) = live_stream_blocked_reason(&records, &gates) {
        order.push(next.clone());
        match next.as_str() {
            "recording profile" => gates.recording_profile = None,
            "streaming profile" => gates.streaming_profile = None,
            "live compatibility" => gates.live_compatibility = None,
            "Livestreaming requires Videorc Premium." => gates.livestreaming = None,
            "You can stream to up to 5 destinations at once." => gates.go_live = None,
            "Finish setting up your destination in Destinations before you go live." => {
                gates.destination_not_ready = false
            }
            "split" => gates.stream_split = None,
            other => panic!("unexpected reason {other}"),
        }
    }
    assert_eq!(
        order,
        [
            "recording profile",
            "streaming profile",
            "live compatibility",
            "Livestreaming requires Videorc Premium.",
            "You can stream to up to 5 destinations at once.",
            "Finish setting up your destination in Destinations before you go live.",
            "split",
        ]
    );
    // Record never reads the livestream's gates.
    let live_only = StartGates {
        recording_profile: None,
        ..all.clone()
    };
    assert_eq!(record_blocked_reason(&ready, &live_only), None);
    // The recorder comes before the topology verdict.
    let mut checking = records.clone();
    checking.health = HealthSummary::default();
    let split = StartGates {
        stream_split: reason("split"),
        ..none()
    };
    assert_eq!(
        live_stream_blocked_reason(&checking, &split).as_deref(),
        Some("Checking the recorder…")
    );
    // The connection and a running session still come first.
    let mut waiting = records;
    waiting.connection = Connection::Waiting;
    assert_eq!(
        live_stream_blocked_reason(&waiting, &all).as_deref(),
        Some("Starting Videorc's capture engine…")
    );
}

#[test]
fn a_blocked_go_live_jumps_to_destinations() {
    let cap = StartGates {
        go_live: Some("You can stream to up to 5 destinations at once.".to_string()),
        ..none()
    };
    let destinations = Some(BlockedJump {
        label: "Open Destinations",
        page: PageId::Live,
    });
    assert_eq!(blocked_jump(&idle(), &cap), destinations);
    let not_ready = StartGates {
        destination_not_ready: true,
        ..none()
    };
    assert_eq!(blocked_jump(&idle(), &not_ready), destinations);
    let mut nothing_on = idle();
    set_destinations(&mut nothing_on, Vec::new());
    assert_eq!(blocked_jump(&nothing_on, &none()), destinations);
    // Record blocked by anything but the recorder: no jump at all.
    let mut pending = idle();
    pending.session.start_pending = true;
    assert_eq!(blocked_jump(&pending, &cap), None);
}

#[test]
fn video_quality_reads_one_way() {
    assert_eq!(format_video_quality(1920, 1080, 30), "1080p · 30 fps");
    assert_eq!(format_video_quality(1280, 720, 60), "720p · 60 fps");
    assert_eq!(format_video_quality(3840, 2160, 30), "4K · 30 fps");
    assert_eq!(format_video_quality(2560, 1440, 30), "1440p · 30 fps");
    assert_eq!(
        format_video_quality(1080, 1920, 30),
        "1080 × 1920 · 30 fps",
        "portrait keeps both sides"
    );
}

#[test]
fn the_output_row_says_what_the_session_encodes_on_air() {
    let mut snapshot = idle();
    snapshot.settings.capture.video = video(3840, 2160, 30);
    let off_air = LiveOutput {
        shared_fallback: Some(video(1920, 1080, 30)),
        stream_video: Some(video(1280, 720, 30)),
    };
    assert_eq!(
        session_output_summary(&snapshot, false, &off_air),
        "4K · 30 fps",
        "off air: the saved recording quality"
    );
    snapshot.settings.capture.record_enabled = true;
    assert_eq!(
        session_output_summary(&snapshot, true, &off_air),
        "1080p · 30 fps · matches the stream"
    );
    assert_eq!(
        session_output_summary(&snapshot, true, &LiveOutput::default()),
        "4K · 30 fps",
        "a separate recording encode keeps the saved quality"
    );
    snapshot.settings.capture.record_enabled = false;
    assert_eq!(
        session_output_summary(&snapshot, true, &off_air),
        "1080p · 30 fps",
        "stream only: the shared fallback first"
    );
    let stream_only = LiveOutput {
        shared_fallback: None,
        stream_video: Some(video(1280, 720, 60)),
    };
    assert_eq!(
        session_output_summary(&snapshot, true, &stream_only),
        "720p · 60 fps"
    );
    assert_eq!(
        session_output_summary(&snapshot, true, &LiveOutput::default()),
        "4K · 30 fps"
    );
}

#[test]
fn the_livestream_row_names_the_destination_or_counts_them() {
    assert_eq!(streaming_summary(&[]), "No destinations");
    assert_eq!(
        streaming_summary(&[
            json!({"enabled": true, "label": "Custom RTMP", "platform": "custom"})
        ]),
        "Custom RTMP"
    );
    assert_eq!(
        streaming_summary(&[json!({"enabled": true, "label": "", "platform": "custom"})]),
        "custom"
    );
    assert_eq!(
        streaming_summary(&[
            json!({"enabled": true, "label": "Twitch"}),
            json!({"enabled": true, "label": "YouTube"}),
            json!({"enabled": false, "label": "Kick"}),
        ]),
        "2 destinations"
    );
    // A card the wire type wouldn't take still counts, as the renderer's.
    assert_eq!(
        streaming_summary(&[
            json!({"enabled": true, "label": "YouTube", "platform": "youtube", "odd": 1}),
            json!({"enabled": true, "label": "", "platform": "twitch"}),
            json!({"enabled": true, "platform": "kick"}),
        ]),
        "3 destinations"
    );
}

#[test]
fn the_destinations_are_quiet_when_fine_and_specific_when_not() {
    assert_eq!(live_destinations_view(&[], None), None);
    assert_eq!(
        live_destinations_view(
            &[json!({"targetId": "a", "label": "X", "state": "not-configured"})],
            None
        ),
        None,
        "a skipped destination isn't counted"
    );
    let quiet = live_destinations_view(
        &[
            json!({"targetId": "a", "label": "Twitch", "state": "live"}),
            json!({"targetId": "b", "label": "YouTube", "state": "live"}),
        ],
        None,
    )
    .unwrap();
    assert_eq!(quiet.summary, "2 of 2 on air");
    assert!(quiet.quiet && quiet.problems.is_empty());
    let trouble = live_destinations_view(
        &[
            json!({"targetId": "a", "label": "Twitch", "state": "live"}),
            json!({"targetId": "b", "label": "YouTube", "state": "stopped"}),
            json!({"targetId": "c", "label": "Kick", "state": "reconnecting"}),
            json!({"targetId": "d", "label": "X", "state": "warning"}),
        ],
        None,
    )
    .unwrap();
    assert_eq!(trouble.summary, "1 of 4 on air");
    assert!(!trouble.quiet);
    let words: Vec<(&str, &str, &str)> = trouble
        .problems
        .iter()
        .map(|p| (p.label.as_str(), p.word.as_str(), p.tone))
        .collect();
    assert_eq!(
        words,
        [
            ("YouTube", "Ended", "error"),
            ("Kick", "Reconnecting…", "warn"),
            ("X", "Not receiving", "warn"),
        ]
    );
    assert_eq!(destination_state_label("failed"), "Failed");
    assert_eq!(destination_state_label("odd-state"), "Odd state");
}

fn cloud(phase: &str) -> CloudShow {
    CloudShow {
        phase: phase.to_string(),
        phase_label: format!("Cloud {phase}"),
        hold_countdown: None,
    }
}

#[test]
fn through_the_cloud_the_feed_legs_fold_into_one_row() {
    let targets = [
        json!({"targetId": "videorc-cloud-1", "label": "Feed", "state": "reconnecting"}),
        json!({"targetId": "twitch", "label": "Twitch", "state": "live"}),
    ];
    // Without the cloud the feed leg is a destination like any other.
    let plain = live_destinations_view(&targets, None).unwrap();
    assert_eq!(plain.summary, "1 of 2 on air");
    // Through the cloud: the runner's legs count, the show is on air.
    let live = live_destinations_view(&targets, Some(&cloud("live"))).unwrap();
    assert_eq!(live.summary, "1 of 1 on air");
    assert!(live.quiet);
    // A hold: one Videorc Cloud row first, named by the feed leg.
    let hold = live_destinations_view(&targets, Some(&cloud("hold"))).unwrap();
    assert_eq!(
        hold.problems,
        [DestinationProblem {
            target_id: "videorc-cloud-1".to_string(),
            label: "Videorc Cloud".to_string(),
            word: "Be right back".to_string(),
            tone: "warn",
        }]
    );
    let failed = live_destinations_view(&targets[1..], Some(&cloud("failed"))).unwrap();
    assert_eq!(
        (
            failed.problems[0].target_id.as_str(),
            failed.problems[0].word.as_str(),
            failed.problems[0].tone
        ),
        ("videorc-cloud", "Cloud failed", "error")
    );
    let resuming = live_destinations_view(&targets, Some(&cloud("resuming"))).unwrap();
    assert_eq!(resuming.problems[0].tone, "warn");
}

#[test]
fn the_stream_fact_says_a_watchdog_alert_then_the_cloud_then_the_stage() {
    let healthy = StreamHealthAttribution::Healthy;
    assert_eq!(
        stream_health_fact(healthy, None, None),
        ("Healthy".to_string(), "good")
    );
    assert_eq!(
        stream_health_fact(StreamHealthAttribution::Unknown, None, None),
        ("Checking…".to_string(), "neutral")
    );
    let mut hold = cloud("hold");
    assert_eq!(
        stream_health_fact(healthy, Some(&hold), None),
        ("Be right back".to_string(), "warn")
    );
    hold.hold_countdown = Some("28 min".to_string());
    assert_eq!(
        stream_health_fact(healthy, Some(&hold), None),
        ("Be right back · 28 min left".to_string(), "warn")
    );
    assert_eq!(
        stream_health_fact(healthy, Some(&cloud("resuming")), None),
        ("Cloud resuming".to_string(), "warn")
    );
    assert_eq!(
        stream_health_fact(healthy, Some(&cloud("live")), None),
        ("Healthy".to_string(), "good"),
        "a show simply on air lets the stages speak"
    );
    assert_eq!(
        stream_health_fact(healthy, Some(&hold), Some("Microphone silent")),
        ("Microphone silent".to_string(), "warn"),
        "plan 223 A5: the top alert outranks every stage"
    );
}

#[test]
fn the_stream_fact_names_the_earliest_failing_stage() {
    let none = RecentDrops::default();
    let healthy = json!({"bottleneck": "none", "captureFps": 30.0, "targetFps": 30.0});
    let classify = |stats: &Value, targets: &[Value], drops: RecentDrops| {
        classify_stream_health(stats, None, targets, drops, now())
    };
    assert_eq!(
        classify(&healthy, &[], none),
        StreamHealthAttribution::Healthy
    );
    assert_eq!(
        classify(&json!({}), &[], none),
        StreamHealthAttribution::Unknown,
        "nothing measured is no verdict"
    );
    assert_eq!(
        classify(
            &json!({"bottleneck": "none", "deviceDisconnected": true}),
            &[],
            none
        ),
        StreamHealthAttribution::Device
    );
    assert_eq!(
        classify(
            &json!({"bottleneck": "none", "micCaptureCoverage": 0.5}),
            &[],
            none
        ),
        StreamHealthAttribution::Audio
    );
    assert_eq!(
        classify(
            &json!({"bottleneck": "capture", "streamDelivery": {"degraded": true}}),
            &[],
            none
        ),
        StreamHealthAttribution::Choppy,
        "the backend's verdict on what the stream sends ranks above capture"
    );
    assert_eq!(
        classify(
            &json!({"bottleneck": "none", "streamDelivery": {"bitrateKbps": 3000, "chosenBitrateKbps": 6000}}),
            &[],
            none
        ),
        StreamHealthAttribution::Uplink
    );
    let recent_overflow =
        json!({"state": "live", "uplinkOverflows": 2, "uplinkOverflowAt": "2026-11-10T11:59:30Z"});
    let old_overflow =
        json!({"state": "live", "uplinkOverflows": 2, "uplinkOverflowAt": "2026-11-10T11:58:00Z"});
    assert_eq!(
        classify(&healthy, &[recent_overflow], none),
        StreamHealthAttribution::Uplink
    );
    assert_eq!(
        classify(&healthy, &[old_overflow], none),
        StreamHealthAttribution::Healthy,
        "an overflow older than a minute is over"
    );
    assert_eq!(
        classify(
            &json!({"bottleneck": "none", "captureFps": 20.0, "targetFps": 30.0}),
            &[],
            none
        ),
        StreamHealthAttribution::Capture
    );
    assert_eq!(
        classify(
            &json!({"bottleneck": "none", "captureFps": 30.0, "renderFps": 20.0, "targetFps": 30.0}),
            &[],
            none
        ),
        StreamHealthAttribution::Render
    );
    assert_eq!(
        classify(
            &healthy,
            &[],
            RecentDrops {
                encoder: true,
                ..none
            }
        ),
        StreamHealthAttribution::Encoder
    );
    assert_eq!(
        classify(
            &json!({"bottleneck": "none", "captureFps": 30.0, "encoderBridgeRequestedVideoOutput": "hevc", "encoderBridgeEffectiveVideoOutput": "h264", "encoderBridgeEncodedOutputFallbackReason": "no hevc"}),
            &[],
            none
        ),
        StreamHealthAttribution::Fallback
    );
    assert_eq!(
        classify(
            &healthy,
            &[json!({"state": "live", "message": "Reconnected after a drop"})],
            none
        ),
        StreamHealthAttribution::Network
    );
    assert_eq!(
        classify(
            &healthy,
            &[json!({"state": "live", "message": "Disconnected"})],
            none
        ),
        StreamHealthAttribution::Healthy,
        "a word that only contains reconnect's letters is no reconnect"
    );
    assert_eq!(
        classify(
            &healthy,
            &[],
            RecentDrops {
                preview: true,
                ..none
            }
        ),
        StreamHealthAttribution::Preview
    );
    assert_eq!(
        stream_health_fact(StreamHealthAttribution::Uplink, None, None),
        ("Connection too slow".to_string(), "warn")
    );
    // Another session's stream health is no evidence.
    assert_eq!(
        classify_stream_health(
            &json!({"bottleneck": "none", "sessionId": "s2"}),
            Some(&json!({"sessionId": "s1", "fps": 30.0})),
            &[],
            none,
            now()
        ),
        StreamHealthAttribution::Unknown
    );
    assert!(mentions_reconnect("RECONNECTING to the server"));
    assert!(!mentions_reconnect("reconnection"));
}

#[test]
fn the_drop_window_names_each_stage_for_ten_seconds() {
    let mut telemetry = HealthTelemetry::default();
    let start = Instant::now();
    let stats = |mic: f64, encoder: f64| json!({"sessionId": "s1", "micDroppedFrames": mic, "droppedFrames": encoder, "previewDroppedFrames": 0});
    telemetry.apply(DIAGNOSTICS_STATS_EVENT, stats(0.0, 5.0), start);
    assert_eq!(
        telemetry.recent_drops(start),
        RecentDrops::default(),
        "a first sample is the baseline"
    );
    let later = start + Duration::from_secs(1);
    telemetry.apply(DIAGNOSTICS_STATS_EVENT, stats(2.0, 5.0), later);
    let drops = telemetry.recent_drops(later);
    assert!(drops.audio && !drops.encoder && !drops.capture && !drops.preview);
    assert!(
        !telemetry
            .recent_drops(later + Duration::from_secs(11))
            .audio
    );
}

#[test]
fn the_camera_notice_is_the_running_session_s_own() {
    let mut running = with_status(status(RecordingState::Recording, false));
    running.session.status.message = Some("Camera shared".to_string());
    let shared = json!({"sessionId": "s1", "duplicateCaptureSources": ["camera:abc"]});
    assert_eq!(
        camera_capture_notice(&running, Some(&shared)).as_deref(),
        Some("Camera shared")
    );
    assert_eq!(
        camera_capture_notice(
            &running,
            Some(&json!({"sessionId": "s2", "duplicateCaptureSources": ["camera:abc"]}))
        ),
        None,
        "another session's stats"
    );
    assert_eq!(
        camera_capture_notice(
            &running,
            Some(&json!({"sessionId": "s1", "duplicateCaptureSources": ["screen:1"]}))
        ),
        None
    );
    running.session.status.state = RecordingState::Streaming;
    assert_eq!(
        camera_capture_notice(&running, Some(&shared)).as_deref(),
        Some(copy::CAMERA_SHARED_LIVE)
    );
    running.session.status.replay_only = true;
    assert_eq!(
        camera_capture_notice(&running, Some(&shared)).as_deref(),
        Some(copy::CAMERA_SHARED_CLIPS)
    );
    assert_eq!(camera_capture_notice(&idle(), Some(&shared)), None);
}

#[test]
fn the_agents_line_counts_the_connected_ones_while_agents_are_on() {
    let status = |enabled: bool, connected: &[bool]| {
        json!({
            "enabled": enabled,
            "agents": connected.iter().enumerate().map(|(i, c)| json!({"name": format!("Agent {i}"), "connected": c})).collect::<Vec<_>>()
        })
    };
    assert_eq!(AgentsState::read(&status(true, &[])).session_line(), None);
    assert_eq!(
        AgentsState::read(&status(true, &[false, true])).session_line(),
        Some("Agent 1 connected".to_string())
    );
    assert_eq!(
        AgentsState::read(&status(true, &[true, true, false])).session_line(),
        Some("2 agents connected".to_string())
    );
    assert_eq!(
        AgentsState::read(&status(false, &[true])).session_line(),
        None,
        "Agents off: nobody is connected"
    );
}

#[test]
fn the_runtime_alert_puts_the_failure_before_the_microphone() {
    let mut failed = idle();
    failed.session.notice = Some(RecordingFailedNotice {
        activity: SessionActivity::Recording,
        message: "The encoder stopped.".to_string(),
        session_id: Some("s1".to_string()),
        output_path: Some("/tmp/a.mkv".to_string()),
        at: Instant::now(),
    });
    failed.session.microphone_notice = Some(microphone_notice(MicrophonePhase::Active, &[]));
    let alert = runtime_alert(&failed).unwrap();
    assert_eq!(alert.title, "Recording stopped unexpectedly");
    assert!(alert.failed && alert.open_library && !alert.open_audio);
    assert_eq!(alert.reveal_session_id.as_deref(), Some("s1"));
    assert_eq!(alert.reveal_path.as_deref(), Some("/tmp/a.mkv"));
    // Show in Finder needs the file, not the session id
    // (`session-runtime-alert.tsx:64`: `savedFile && notice.outputPath`).
    failed.session.notice.as_mut().unwrap().session_id = None;
    assert_eq!(
        runtime_alert(&failed).unwrap().reveal_path.as_deref(),
        Some("/tmp/a.mkv")
    );
    failed.session.notice.as_mut().unwrap().output_path = None;
    let no_file = runtime_alert(&failed).unwrap();
    assert_eq!(
        no_file.reveal_session_id, None,
        "no file path, nothing to show in Finder"
    );
    assert_eq!(no_file.reveal_path, None);
    failed.session.notice.as_mut().unwrap().output_path = Some("/tmp/a.mkv".to_string());
    failed.session.notice.as_mut().unwrap().activity = SessionActivity::LiveStream;
    let live = runtime_alert(&failed).unwrap();
    assert_eq!(live.title, "Livestream stopped unexpectedly");
    assert_eq!(live.reveal_session_id, None, "a stream alone saved no file");
    assert_eq!(live.reveal_path, None, "a stream alone saved no file");
    assert!(!live.open_library);
    assert_eq!(runtime_alert(&idle()), None);
}

fn microphone_notice(phase: MicrophonePhase, codes: &[&str]) -> MicrophoneNotice {
    MicrophoneNotice {
        audio_issues: codes
            .iter()
            .map(|code| AudioIssue {
                code: code.to_string(),
                message: "The microphone stopped.".to_string(),
            })
            .collect(),
        activity: RuntimeActivity::Recording,
        phase,
        message: "Check the microphone.".to_string(),
        session_id: Some("s1".to_string()),
    }
}

#[test]
fn a_microphone_notice_opens_audio_until_it_ends() {
    let mut snapshot = idle();
    snapshot.session.microphone_notice = Some(microphone_notice(
        MicrophonePhase::Active,
        &[MICROPHONE_SILENT_CODE],
    ));
    let alert = runtime_alert(&snapshot).unwrap();
    assert!(!alert.failed && alert.open_audio && !alert.open_library);
    assert_eq!(alert.reveal_session_id, None);
    assert_eq!(alert.reveal_path, None);
    let opens = |phase: MicrophonePhase, codes: &[&str]| {
        microphone_notice_opens_audio(&microphone_notice(phase, codes))
    };
    assert!(opens(MicrophonePhase::Active, &[]), "nothing named");
    assert!(opens(MicrophonePhase::Ending, &["microphone-input-lost"]));
    assert!(
        !opens(MicrophonePhase::Active, &["system-audio-input-lost"]),
        "System audio isn't the microphone's door"
    );
    assert!(
        !opens(MicrophonePhase::Ended, &["microphone-input-lost"]),
        "an ended notice opens nothing"
    );
}

#[test]
fn the_session_section_lists_the_facts_and_their_pages() {
    let telemetry = HealthTelemetry::default();
    let at = Instant::now();
    let inputs = SessionInputs::default();
    let view = SessionSectionView::from_snapshot(&idle(), &telemetry, &inputs, now(), at);
    let rows: Vec<(&str, &str, Option<PageId>)> = view
        .rows
        .iter()
        .map(|row| (row.label.as_str(), row.value.as_str(), row.opens))
        .collect();
    assert_eq!(
        rows,
        [
            ("Livestream", "Custom RTMP", Some(PageId::Live)),
            ("Output", "1080p · 30 fps", Some(PageId::Recording)),
        ]
    );
    assert_eq!(view.agents_line, None);
    assert_eq!(view.start_failure, None);

    // On air: the destinations (they open Destinations), the Stream fact
    // (it opens Health) and Sidekick's row (the Stream Manager's window).
    let mut live = with_status(status(RecordingState::Recording, true));
    // The Livestream row reads the saved destinations, never the session's.
    live.session.live_streaming = None;
    let mut telemetry = HealthTelemetry::default();
    telemetry.apply(
        crate::client::names::STREAM_TARGETS,
        json!({"targets": [{"targetId": "custom", "label": "Custom RTMP", "state": "live"}]}),
        at,
    );
    telemetry.apply(
        DIAGNOSTICS_STATS_EVENT,
        json!({"sessionId": "s1", "bottleneck": "none", "captureFps": 30.0}),
        at,
    );
    let inputs = SessionInputs {
        sidekick: Some(SidekickFact {
            value: "Reading chat".to_string(),
            tone: "good",
        }),
        ..SessionInputs::default()
    };
    let view = SessionSectionView::from_snapshot(&live, &telemetry, &inputs, now(), at);
    let rows: Vec<(&str, &str, &str, Option<PageId>)> = view
        .rows
        .iter()
        .map(|row| (row.label.as_str(), row.value.as_str(), row.tone, row.opens))
        .collect();
    assert_eq!(
        rows,
        [
            ("Livestream", "Custom RTMP", "", Some(PageId::Live)),
            ("Output", "1080p · 30 fps", "", Some(PageId::Recording)),
            ("Destinations", "1 of 1 on air", "live", Some(PageId::Live)),
            ("Stream", "Healthy", "good", Some(PageId::Diagnostics)),
            ("Sidekick", "Reading chat", "good", None),
        ]
    );

    // A watchdog alert is the Stream fact.
    let alerted = SessionInputs {
        watchdog_chip: Some("Black picture".to_string()),
        ..SessionInputs::default()
    };
    let view = SessionSectionView::from_snapshot(&live, &telemetry, &alerted, now(), at);
    let stream = view.rows.iter().find(|row| row.id == "stream").unwrap();
    assert_eq!(
        (stream.value.as_str(), stream.tone),
        ("Black picture", "warn")
    );
    assert!(
        view.rows.iter().all(|row| row.id != "sidekick"),
        "no Sidekick row without its fact"
    );

    // A refused start shows while idle, with Retry off during a start.
    let mut refused = idle();
    refused.session.start_failure = Some(SessionStartFailure {
        message: "The screen produced no frames.".to_string(),
        kind: SessionStartFailureKind::Record,
        intent: SessionStartIntent::RECORD,
        at,
    });
    let view = SessionSectionView::from_snapshot(
        &refused,
        &HealthTelemetry::default(),
        &SessionInputs::default(),
        now(),
        at,
    );
    assert_eq!(
        view.start_failure,
        Some(StartFailureAlert {
            title: "Couldn't start",
            message: "The screen produced no frames.".to_string(),
            retry_enabled: true
        })
    );
    refused.session.start_pending = true;
    let view = SessionSectionView::from_snapshot(
        &refused,
        &HealthTelemetry::default(),
        &SessionInputs::default(),
        now(),
        at,
    );
    assert!(!view.start_failure.unwrap().retry_enabled);

    // The agents line.
    let agents = SessionInputs {
        agents: AgentsState {
            enabled: true,
            connected: vec!["Claude Desktop".to_string()],
        },
        ..SessionInputs::default()
    };
    let view =
        SessionSectionView::from_snapshot(&idle(), &HealthTelemetry::default(), &agents, now(), at);
    assert_eq!(
        view.agents_line.as_deref(),
        Some("Claude Desktop connected")
    );
}
