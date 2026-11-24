//! S3.1c: the live source switch's fence, its answers and its words
//! (`live-source-selection.test.ts`'s cases that the Rust port keeps).

use serde_json::json;
use videorc_protocol::{Device, DeviceKind, DeviceStatus, RecordingState};

use super::*;

fn sources(
    revision: u64,
    pending: Option<SwitchOperation>,
    last: Option<SwitchOperation>,
) -> SessionSources {
    SessionSources {
        session_id: "s1".into(),
        source_revision: revision,
        output_process_id: Some(42),
        confirmed: json!({ "testPattern": true, "microphoneId": null }),
        health: Vec::new(),
        pending,
        last_operation: last,
        capabilities: vec![
            SwitchCapability {
                kind: "capture".into(),
                supported: true,
                allows_none: true,
                reason: None,
            },
            SwitchCapability {
                kind: "camera".into(),
                supported: false,
                allows_none: true,
                reason: Some("Cameras can't change on this build.".into()),
            },
            SwitchCapability {
                kind: "microphone".into(),
                supported: true,
                allows_none: true,
                reason: None,
            },
        ],
    }
}

fn op(request: &str, stage: &str, device: Option<&str>) -> SwitchOperation {
    SwitchOperation {
        request_id: request.into(),
        kind: "microphone".into(),
        device_id: device.map(str::to_string),
        stage: stage.into(),
        reason: (stage == "failed").then(|| "The microphone is busy".to_string()),
        output_observed: true,
        output_superseded: false,
    }
}

fn running() -> LiveSources {
    let mut live = LiveSources::default();
    assert!(live.set_session(Some("s1"), &RecordingState::Recording, false));
    let epoch = live.epoch;
    assert!(live.accept(sources(1, None, None), epoch).accepted);
    live
}

#[test]
fn the_session_edges_say_why_and_idle_says_nothing() {
    let mut live = LiveSources::default();
    assert_eq!(live.reason(SourceKind::Camera), None);
    live.set_session(Some("s1"), &RecordingState::Starting, false);
    assert_eq!(
        live.reason(SourceKind::Capture).as_deref(),
        Some(copy::STARTING)
    );
    live.set_session(Some("s1"), &RecordingState::Recording, false);
    assert_eq!(
        live.reason(SourceKind::Capture).as_deref(),
        Some(copy::CHECKING_CONTROLS)
    );
    let epoch = live.epoch;
    live.accept(sources(1, None, None), epoch);
    assert_eq!(live.reason(SourceKind::Capture), None);
    assert_eq!(
        live.reason(SourceKind::Camera).as_deref(),
        Some("Cameras can't change on this build.")
    );
    assert!(live.capture_allows_none());
    live.set_session(Some("s1"), &RecordingState::Stopping, false);
    assert_eq!(
        live.reason(SourceKind::Capture).as_deref(),
        Some(copy::STOPPING)
    );
    // A Clips ring alone is idle.
    live.set_session(Some("s2"), &RecordingState::Recording, true);
    assert_eq!(live.reason(SourceKind::Capture), None);
    assert!(!live.readable());
}

#[test]
fn a_switch_closes_the_fence_until_its_answer_and_an_older_answer_never_wins() {
    let mut live = running();
    let request = live
        .begin_select(
            SourceKind::Microphone,
            Some("mic:b".into()),
            Some("Mic B".into()),
            "r1".into(),
            vec![7],
        )
        .unwrap();
    assert_eq!(request.expected_source_revision, 1);
    assert_eq!(request.protected_overlay_window_ids, vec![7]);
    assert_eq!(
        live.reason(SourceKind::Capture).as_deref(),
        Some(copy::CHANGING)
    );
    assert!(
        live.begin_select(SourceKind::Capture, None, None, "r2".into(), Vec::new())
            .is_err()
    );
    let line = switch_status_line(SourceKind::Microphone, &live.view, &[], None).unwrap();
    assert_eq!(line.message, "Preparing Mic B…");
    let epoch = live.epoch;
    let pending = live.accept(
        sources(2, Some(op("r1", "preparing", Some("mic:b"))), None),
        epoch,
    );
    assert!(pending.proof_due);
    assert_eq!(live.view.pending, Some(SourceKind::Microphone));
    let done = live.accept(
        sources(3, None, Some(op("r1", "applied", Some("mic:b")))),
        epoch,
    );
    assert!(done.accepted && !done.proof_due);
    assert_eq!(live.view.pending, None);
    assert_eq!(live.reason(SourceKind::Capture), None);
    // Revision 2 after 3 is stale.
    assert!(!live.accept(sources(2, None, None), epoch).accepted);
    // Another session's answer is not this one's.
    let mut other = sources(4, None, None);
    other.session_id = "s9".into();
    assert!(!live.accept(other, epoch).accepted);
}

#[test]
fn a_failed_switch_toasts_once_and_says_why_on_its_row() {
    let mut live = running();
    live.begin_select(
        SourceKind::Microphone,
        Some("mic:b".into()),
        None,
        "r1".into(),
        Vec::new(),
    )
    .unwrap();
    let epoch = live.epoch;
    let failed = live.accept(
        sources(2, None, Some(op("r1", "failed", Some("mic:b")))),
        epoch,
    );
    let failure = failed.failure.expect("one toast");
    assert_eq!(failure.message, "The microphone is busy");
    let devices = vec![Device {
        app: None,
        window_title: None,
        display_uuid: None,
        id: "mic:b".into(),
        name: "Mic B".into(),
        kind: DeviceKind::Microphone,
        status: DeviceStatus::Available,
        detail: None,
        width: None,
        height: None,
    }];
    assert_eq!(
        switch_failed_title(&failure, &devices),
        "Couldn't switch to Mic B"
    );
    assert_eq!(
        switch_failed_description(&failure.message),
        "The microphone is busy. Choose it again in Sources."
    );
    let line = switch_status_line(SourceKind::Microphone, &live.view, &devices, None).unwrap();
    assert_eq!(line.message, "The microphone is busy");
    // The capture row keeps quiet about the microphone's failure.
    assert_eq!(
        switch_status_line(SourceKind::Capture, &live.view, &devices, None),
        None
    );
}

#[test]
fn a_refusal_ends_the_switch_and_a_lost_answer_checks_then_gives_up() {
    let mut live = running();
    let request = live
        .begin_select(SourceKind::Capture, None, None, "r1".into(), Vec::new())
        .unwrap();
    assert_eq!(live.view.target_name.as_deref(), Some("None"));
    let failure = live.send_rejected(&request, "source-switch-stale-revision", "Stale revision");
    assert!(failure.is_some());
    assert_eq!(live.view.pending, None);
    assert_eq!(live.view.error.as_deref(), Some("Stale revision"));
    // A session that is stopping never toasts its refusal.
    let request = live
        .begin_select(SourceKind::Capture, None, None, "r2".into(), Vec::new())
        .unwrap();
    assert!(
        live.send_rejected(&request, "source-switch-stopping", "Stopping")
            .is_none()
    );

    let request = live
        .begin_select(
            SourceKind::Capture,
            Some("screen:1".into()),
            None,
            "r3".into(),
            Vec::new(),
        )
        .unwrap();
    for _ in 0..MAX_ATTEMPTS {
        live.begin_send();
        live.send_lost();
    }
    assert!(live.view.checking);
    assert_eq!(live.view.error.as_deref(), Some(copy::CANT_CONFIRM));
    let line = switch_status_line(SourceKind::Capture, &live.view, &[], None).unwrap();
    assert!(line.check_again);
    assert_eq!(live.request_id(), Some(request.request_id.as_str()));
}

#[test]
fn the_backend_confirmation_merges_ids_and_keeps_names() {
    let current = json!({
        "screenId": "screen:1", "screenName": "Built-in",
        "cameraOff": true, "wantedCameraId": "cam:2", "wantedCameraName": "Desk",
        "microphoneId": "mic:a", "microphoneName": "Mic A"
    });
    let mut snapshot = sources(1, None, None);
    snapshot.confirmed = json!({
        "screenId": "screen:1", "windowId": null, "cameraId": "cam:2",
        "microphoneId": "mic:a", "testPattern": false
    });
    let merged = confirmed_source_selection(&current, &snapshot, &[]);
    assert_eq!(
        merged,
        json!({
            "screenId": "screen:1", "screenName": "Built-in",
            "cameraId": "cam:2",
            "microphoneId": "mic:a", "microphoneName": "Mic A",
            "testPattern": false
        })
    );
}

#[test]
fn the_status_line_says_a_lost_source_and_the_outputs_proof() {
    let mut live = running();
    let epoch = live.epoch;
    let mut lost = sources(2, None, Some(op("x", "applied", Some("mic:b"))));
    lost.health = vec![SourceHealth {
        kind: "camera".into(),
        device_id: Some("cam:1".into()),
        health: "unavailable".into(),
    }];
    lost.last_operation.as_mut().unwrap().output_observed = false;
    let accepted = live.accept(lost, epoch);
    assert!(accepted.proof_due);
    assert_eq!(
        switch_status_line(SourceKind::Camera, &live.view, &[], None)
            .unwrap()
            .message,
        copy::UNAVAILABLE_STOP
    );
    assert_eq!(
        switch_status_line(SourceKind::Microphone, &live.view, &[], None)
            .unwrap()
            .message,
        copy::CHECKING_OUTPUT
    );
    // Twenty reads without the proof say so.
    live.proof_reads = PROOF_READS;
    let mut again = sources(3, None, Some(op("x", "applied", Some("mic:b"))));
    again.last_operation.as_mut().unwrap().output_observed = false;
    let accepted = live.accept(again, epoch);
    assert!(!accepted.proof_due);
    assert_eq!(live.view.error.as_deref(), Some(copy::UNCONFIRMED_OUTPUT));
}

#[test]
fn a_confirmation_during_a_scene_commit_takes_the_microphone_only() {
    // #1543: the session confirms the next scene's screen before that scene
    // is on stream; saving it now would put it in the scene being left.
    let current = json!({
        "screenId": "screen:1", "screenName": "Built-in",
        "cameraId": "cam:1", "cameraName": "FaceTime",
        "microphoneId": "mic:a", "microphoneName": "Mic A"
    });
    let selected = json!({
        "screenId": "screen:2", "screenName": "Studio Display",
        "cameraId": "cam:1", "cameraName": "FaceTime",
        "microphoneId": "mic:b", "microphoneName": "Mic B"
    });
    assert_eq!(
        confirmed_sources_for_commit(&current, &selected, true),
        json!({
            "screenId": "screen:1", "screenName": "Built-in",
            "cameraId": "cam:1", "cameraName": "FaceTime",
            "microphoneId": "mic:b", "microphoneName": "Mic B"
        })
    );
    // Settled: the whole confirmation is the selection.
    assert_eq!(
        confirmed_sources_for_commit(&current, &selected, false),
        selected
    );
}
