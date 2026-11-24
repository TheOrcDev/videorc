//! The Clips ring's controller, one ordering at a time.

use serde_json::json;

use super::*;

fn facts() -> StudioFacts {
    StudioFacts {
        recording_state: RecordingState::Idle,
        recording_replay_only: false,
        start_pending: false,
        stop_pending: false,
        layout_awaiting_proof: false,
        performance_check_hold: false,
        room_holds_camera: false,
        record_blocked: false,
        wait: None,
    }
}

fn ring_only() -> StudioFacts {
    StudioFacts {
        recording_state: RecordingState::Recording,
        recording_replay_only: true,
        ..facts()
    }
}

fn state(state: ReplayBufferState, replay_only: bool) -> ReplayStateEvent {
    ReplayStateEvent {
        state,
        replay_only,
        seconds: 60,
        ..ring_off()
    }
}

/// A ring armed at launch with the switch on.
fn armed() -> ClipsRing {
    let mut ring = ClipsRing::new();
    ring.on_replay_status(ring_off(), true);
    ring
}

fn no_camera() -> CameraReport {
    CameraReport::default()
}

fn refused(code: &str, message: &str) -> StartOutcome {
    StartOutcome::Refused {
        code: Some(code.to_string()),
        message: message.to_string(),
    }
}

fn failed(message: &str) -> StartOutcome {
    StartOutcome::Refused {
        code: None,
        message: message.to_string(),
    }
}

#[test]
fn arms_once_at_launch_from_the_saved_switch() {
    let mut ring = ClipsRing::new();
    assert!(!ring.armed());
    assert_eq!(
        ring.on_replay_status(ring_off(), true),
        [ClipsCommand::Schedule(PASS_DELAY)]
    );
    assert!(ring.armed());
    // A later status (a reconnect) does not arm again.
    ring.set_enabled(false);
    assert!(ring.on_replay_status(ring_off(), true).is_empty());
    assert!(!ring.armed());
    let mut off = ClipsRing::new();
    off.on_replay_status(ring_off(), false);
    assert!(!off.armed());
    assert_eq!(off.pass(&facts()), None);
}

#[test]
fn starts_when_idle_and_not_twice() {
    let mut ring = armed();
    assert_eq!(ring.pass(&facts()), Some(ClipsCommand::Start));
    assert!(ring.start_in_flight());
    assert_eq!(ring.pass(&facts()), None);
    assert!(
        ring.start_answered(StartOutcome::Started, &no_camera(), None)
            .is_empty()
    );
    assert!(!ring.start_in_flight());
}

#[test]
fn waits_without_trying_while_record_is_blocked_or_a_source_isnt_ready() {
    let mut ring = armed();
    let blocked = StudioFacts {
        record_blocked: true,
        ..facts()
    };
    assert_eq!(ring.pass(&blocked), None);
    let waiting = StudioFacts {
        wait: Some(ClipsWait::Reason(clips::copy::WAITS_FOR_SCREEN)),
        ..facts()
    };
    assert_eq!(ring.pass(&waiting), None);
    assert!(!ring.start_in_flight());
    // The wait's end passes again from a clean count.
    assert_eq!(
        ring.note_gate(false, None, true),
        [ClipsCommand::Schedule(PASS_DELAY)]
    );
    assert!(ring.note_gate(false, None, true).is_empty(), "no change");
    assert_eq!(ring.pass(&facts()), Some(ClipsCommand::Start));
}

#[test]
fn never_starts_while_a_layout_transaction_awaits_its_proof() {
    // #1640, the first order: a scene change goes out, then the ring would
    // start with the scene it leaves.
    let mut ring = armed();
    let proving = StudioFacts {
        layout_awaiting_proof: true,
        ..facts()
    };
    assert_eq!(ring.pass(&proving), None);
    assert!(!ring.start_in_flight());
    assert_eq!(
        ring.layout_transaction_ended(),
        [ClipsCommand::Schedule(PASS_DELAY)]
    );
    assert_eq!(ring.pass(&facts()), Some(ClipsCommand::Start));
}

#[test]
fn a_layout_transaction_waits_for_the_rings_start() {
    // #1640, the other order: the ring's start is in flight, so a scene
    // change waits for it and runs as a change to the session it started.
    let mut ring = armed();
    assert!(!ring.start_in_flight());
    ring.pass(&facts());
    assert!(ring.start_in_flight());
    ring.start_answered(StartOutcome::Started, &no_camera(), None);
    assert!(!ring.start_in_flight());
    // A disarmed ring's transaction end has nothing to pass.
    ring.set_enabled(false);
    assert!(ring.layout_transaction_ended().is_empty());
}

#[test]
fn stops_its_own_buffer_only_session_when_the_switch_goes_off() {
    let mut ring = armed();
    ring.on_replay_state(state(ReplayBufferState::On, true));
    assert_eq!(
        ring.set_enabled(false),
        [ClipsCommand::Schedule(Duration::ZERO)]
    );
    assert_eq!(ring.pass(&ring_only()), Some(ClipsCommand::Stop));
    assert_eq!(ring.pass(&ring_only()), None, "the stop is in flight");
    ring.stop_answered();
    // A ring riding a recording ends with it.
    let recording = StudioFacts {
        recording_replay_only: false,
        ..ring_only()
    };
    assert_eq!(ring.pass(&recording), None);
}

#[test]
fn the_software_encoder_refusal_turns_the_switch_off_with_its_reason() {
    let mut ring = armed();
    ring.pass(&facts());
    let commands = ring.start_answered(
        refused(clips::SOFTWARE_ENCODER_REFUSAL, "Software encoding only."),
        &no_camera(),
        None,
    );
    assert!(commands.is_empty(), "no retry, no notice");
    assert!(!ring.armed());
    let view = ring.view(true, None, None);
    assert!(!view.on);
    assert_eq!(
        view.switch_description,
        "Off on this computer. Software encoding only."
    );
    // Turning it on is the streamer's override.
    ring.set_enabled(true);
    assert!(ring.armed());
    assert_eq!(ring.blocked_reason(), None);
    assert!(ring.view(true, None, None).on);
}

#[test]
fn a_failing_start_backs_off_then_gives_up_once_a_launch() {
    let mut ring = armed();
    let mut commands = Vec::new();
    for _ in 0..3 {
        assert_eq!(ring.pass(&facts()), Some(ClipsCommand::Start));
        commands.push(ring.start_answered(failed("no frames"), &no_camera(), None));
    }
    assert_eq!(
        commands,
        [
            vec![ClipsCommand::Schedule(Duration::from_millis(500))],
            vec![ClipsCommand::Schedule(Duration::from_millis(1000))],
            vec![ClipsCommand::NotifyCouldNotStart("no frames".into())],
        ]
    );
    assert_eq!(ring.pass(&facts()), None, "given up");
    // A session that ran and ended resets the count; the notice stays once.
    ring.on_recording_status(&RecordingState::Recording, false, false, true);
    ring.on_recording_status(&RecordingState::Idle, false, true, true);
    for _ in 0..3 {
        ring.pass(&facts());
        let answer = ring.start_answered(failed("no frames"), &no_camera(), None);
        assert!(
            !answer
                .iter()
                .any(|command| matches!(command, ClipsCommand::NotifyCouldNotStart(_)))
        );
    }
}

#[test]
fn a_camera_without_a_frame_waits_for_its_live_edge() {
    let mut ring = armed();
    ring.pass(&facts());
    let starting = CameraReport {
        state: "starting".into(),
        camera_id: Some("camera:1".into()),
        ..no_camera()
    };
    ring.on_camera_status(&starting);
    let commands = ring.start_answered(
        refused(clips::SOURCES_NOT_READY, "not ready"),
        &starting,
        Some("camera:1"),
    );
    assert!(commands.is_empty(), "no strike, no notice");
    assert_eq!(ring.pass(&facts()), None, "waiting for the camera");
    let live = CameraReport {
        state: "live".into(),
        frames_captured: 1,
        ..starting
    };
    assert_eq!(
        ring.on_camera_status(&live),
        [ClipsCommand::Schedule(PASS_DELAY)]
    );
    assert_eq!(ring.pass(&facts()), Some(ClipsCommand::Start));
}

#[test]
fn a_silent_camera_is_asked_on_a_backoff_then_waited_for_once() {
    let mut ring = armed();
    let silent = CameraReport {
        state: "live".into(),
        camera_id: Some("camera:1".into()),
        ..no_camera()
    };
    ring.on_camera_status(&silent);
    let mut delays = Vec::new();
    for _ in 0..4 {
        assert_eq!(ring.pass(&facts()), Some(ClipsCommand::Start));
        let answer = ring.start_answered(
            refused(clips::SOURCES_NOT_READY, "not ready"),
            &silent,
            Some("camera:1"),
        );
        delays.extend(answer);
    }
    assert_eq!(
        delays,
        [1, 2, 4, 8].map(|s| ClipsCommand::Schedule(Duration::from_secs(s)))
    );
    ring.pass(&facts());
    let fifth = ring.start_answered(
        refused(clips::SOURCES_NOT_READY, "not ready"),
        &silent,
        Some("camera:1"),
    );
    assert_eq!(
        fifth,
        [ClipsCommand::NotifyCouldNotStart(
            clips::copy::CAMERA_SENDS_NO_PICTURE.into()
        )]
    );
    assert_eq!(ring.pass(&facts()), None, "stopped asking");
    // Still live, so no live edge: its first frame starts the ring.
    let frame = CameraReport {
        frames_captured: 1,
        ..silent
    };
    assert_eq!(
        ring.on_camera_status(&frame),
        [ClipsCommand::Schedule(Duration::ZERO)]
    );
    assert_eq!(ring.pass(&facts()), Some(ClipsCommand::Start));
}

#[test]
fn a_camera_that_failed_counts_as_a_failed_start() {
    let mut ring = armed();
    ring.pass(&facts());
    let dead = CameraReport {
        state: "failed".into(),
        camera_id: Some("camera:1".into()),
        ..no_camera()
    };
    assert_eq!(
        ring.start_answered(
            refused(clips::SOURCES_NOT_READY, "not ready"),
            &dead,
            Some("camera:1")
        ),
        [ClipsCommand::Schedule(Duration::from_millis(500))]
    );
}

#[test]
fn a_ring_that_died_disarms_until_a_session_ends() {
    let mut ring = armed();
    ring.on_recording_status(&RecordingState::Recording, true, false, true);
    ring.on_replay_state(state(ReplayBufferState::Error, true));
    assert!(!ring.armed());
    // Its own session's end does not re-arm it (it would retry in a loop).
    ring.on_recording_status(&RecordingState::Failed, true, false, true);
    assert!(!ring.armed());
    // A recording that ends does.
    ring.on_recording_status(&RecordingState::Recording, false, false, true);
    let commands = ring.on_recording_status(&RecordingState::Idle, false, true, true);
    assert!(ring.armed());
    assert_eq!(
        commands,
        [
            ClipsCommand::Schedule(PASS_DELAY),
            ClipsCommand::Schedule(PASS_DELAY)
        ]
    );
    assert_eq!(ring.pass(&facts()), Some(ClipsCommand::Start));
}

#[test]
fn a_source_change_restarts_a_buffer_only_ring_and_reloads_the_scene() {
    let mut ring = armed();
    assert!(
        ring.note_sources("s1|c1|m1", "s1|c1", &facts(), true)
            .is_empty()
    );
    ring.on_replay_state(state(ReplayBufferState::On, true));
    let commands = ring.note_sources("s2|c1|m1", "s2|c1", &ring_only(), true);
    assert_eq!(
        commands,
        [ClipsCommand::RestartForSources {
            stop_ring: true,
            reload_scene: true
        }]
    );
    // The reload holds the ring until it is done.
    ring.on_replay_state(state(ReplayBufferState::Off, false));
    assert_eq!(ring.pass(&facts()), None);
    assert_eq!(
        ring.restart_done(true),
        [ClipsCommand::Schedule(PASS_DELAY)]
    );
    assert_eq!(ring.pass(&facts()), Some(ClipsCommand::Start));
    // A microphone change only stops the ring.
    ring.start_answered(StartOutcome::Started, &no_camera(), None);
    assert_eq!(
        ring.note_sources("s2|c1|m2", "s2|c1", &ring_only(), true),
        [ClipsCommand::RestartForSources {
            stop_ring: true,
            reload_scene: false
        }]
    );
}

#[test]
fn a_source_change_during_the_rings_start_restarts_it_once_it_answers() {
    let mut ring = armed();
    ring.note_sources("s1|c1|m1", "s1|c1", &facts(), true);
    ring.pass(&facts());
    let starting = StudioFacts {
        recording_state: RecordingState::Starting,
        recording_replay_only: false,
        ..facts()
    };
    assert_eq!(
        ring.note_sources("s1|c1|m2", "s1|c1", &starting, true),
        [ClipsCommand::Schedule(PASS_DELAY)]
    );
    ring.note_sources("s1|c2|m2", "s1|c2", &starting, true);
    assert_eq!(
        ring.start_answered(StartOutcome::Started, &no_camera(), None),
        [ClipsCommand::RestartForSources {
            stop_ring: true,
            reload_scene: true
        }]
    );
    // A refused start has nothing to restart.
    ring.restart_done(true);
    ring.on_recording_status(&RecordingState::Idle, false, false, true);
    ring.pass(&facts());
    ring.note_sources("s1|c3|m2", "s1|c3", &starting, true);
    assert!(
        !ring
            .start_answered(failed("x"), &no_camera(), None)
            .iter()
            .any(|command| matches!(command, ClipsCommand::RestartForSources { .. }))
    );
}

#[test]
fn a_visual_change_between_sessions_reloads_before_the_ring_comes_back() {
    let mut ring = armed();
    ring.note_sources("s1|c1|m1", "s1|c1", &facts(), true);
    assert_eq!(
        ring.note_sources("s2|c1|m1", "s2|c1", &facts(), true),
        [ClipsCommand::RestartForSources {
            stop_ring: false,
            reload_scene: true
        }]
    );
    assert_eq!(ring.pass(&facts()), None, "held for the reload");
}

#[test]
fn a_shape_change_stops_only_a_buffer_only_ring() {
    let mut ring = armed();
    assert!(
        ring.note_shape("1920|1080|30|6000|false|", &facts())
            .is_empty()
    );
    assert!(
        ring.note_shape("1920|1080|60|6000|false|", &facts())
            .is_empty(),
        "nothing runs"
    );
    assert_eq!(
        ring.note_shape("1080|1920|60|6000|true|", &ring_only()),
        [ClipsCommand::Stop]
    );
}

#[test]
fn an_orientation_change_holds_the_ring_until_released() {
    let mut ring = armed();
    ring.on_replay_state(state(ReplayBufferState::On, true));
    assert_eq!(
        ring.hold_for_orientation(&ring_only()),
        [ClipsCommand::Stop]
    );
    ring.stop_answered();
    ring.on_replay_state(state(ReplayBufferState::Off, false));
    assert_eq!(ring.pass(&facts()), None, "held");
    assert_eq!(ring.release_hold(), [ClipsCommand::Schedule(PASS_DELAY)]);
    assert!(ring.release_hold().is_empty());
    assert_eq!(ring.pass(&facts()), Some(ClipsCommand::Start));
}

#[test]
fn a_layout_without_the_camera_it_waited_for_can_start() {
    let mut ring = armed();
    ring.pass(&facts());
    let starting = CameraReport {
        state: "starting".into(),
        camera_id: Some("camera:1".into()),
        ..no_camera()
    };
    ring.start_answered(
        refused(clips::SOURCES_NOT_READY, "x"),
        &starting,
        Some("camera:1"),
    );
    assert_eq!(
        ring.note_layout_preset(),
        [ClipsCommand::Schedule(PASS_DELAY)]
    );
    assert!(ring.note_layout_preset().is_empty());
    assert_eq!(ring.pass(&facts()), Some(ClipsCommand::Start));
}

#[test]
fn the_room_and_a_performance_check_hold_the_ring() {
    let mut ring = armed();
    let room = StudioFacts {
        room_holds_camera: true,
        ..facts()
    };
    assert_eq!(ring.pass(&room), None);
    let check = StudioFacts {
        performance_check_hold: true,
        ..facts()
    };
    assert_eq!(ring.pass(&check), None);
    ring.on_replay_state(state(ReplayBufferState::On, true));
    let open_room = StudioFacts {
        room_holds_camera: true,
        ..ring_only()
    };
    assert_eq!(ring.pass(&open_room), Some(ClipsCommand::Stop));
}

#[test]
fn latches_the_portal_share_for_the_wait() {
    let mut ring = ClipsRing::new();
    assert_eq!(ring.portal_share_granted(), None);
    ring.on_screen_status(&json!({
        "state": "live", "sourceId": clips::PORTAL_MONITOR_SOURCE_ID, "framesCaptured": 1
    }));
    assert_eq!(
        ring.portal_share_granted(),
        Some(clips::PORTAL_MONITOR_SOURCE_ID)
    );
    ring.on_screen_status(&json!({
        "state": "permission-needed", "sourceId": clips::PORTAL_MONITOR_SOURCE_ID
    }));
    assert_eq!(ring.portal_share_granted(), None);
}

#[test]
fn the_output_page_reads_the_switch_the_wait_and_the_ring() {
    let mut ring = armed();
    let wait = Some(ClipsWait::Reason(clips::copy::WAITS_FOR_SCREEN));
    let view = ring.view(true, None, wait);
    assert!(view.on && view.armed && !view.running);
    assert_eq!(view.wait_reason, Some(clips::copy::WAITS_FOR_SCREEN));
    assert_eq!(
        view.switch_description,
        format!(
            "Starts once a source is ready. {}",
            clips::copy::WAITS_FOR_SCREEN
        )
    );
    // The record block is named before the wait.
    assert_eq!(
        ring.view(true, Some("Choose a microphone."), wait)
            .switch_description,
        "Starts once a source is ready. Choose a microphone."
    );
    // First-run setup waits without words.
    assert_eq!(
        ring.view(true, None, Some(ClipsWait::FirstRunSetup))
            .switch_description,
        clips::copy::NOT_RUNNING
    );
    ring.on_replay_state(state(ReplayBufferState::Starting, true));
    let running = ring.view(true, None, None);
    assert!(running.running);
    assert_eq!(running.switch_description, clips::copy::RUNNING);
    assert_eq!(
        ring.view(false, None, None).switch_description,
        clips::copy::OFF
    );
}
