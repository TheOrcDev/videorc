//! S1.6b part 5d: the live audio sync (`live-audio-processing.test.ts`'s
//! cases, with the drain run by hand where Electron awaits promises).

use super::*;

const S1: &str = "session-1";

fn mic(gain_db: f32, muted: bool) -> MicValues {
    MicValues {
        noise_suppression: MicrophoneNoiseSuppression::Off,
        gain_db,
        muted,
    }
}

fn params(gain_db: f32, muted: bool) -> AudioProcessingUpdateParams {
    AudioProcessingUpdateParams {
        microphone_noise_suppression: None,
        session_id: S1.to_string(),
        microphone_gain_db: gain_db,
        microphone_muted: muted,
        system_audio_enabled: None,
        system_audio_gain_db: None,
        system_audio_echo_guard: None,
    }
}

fn answer(
    requested: &AudioProcessingUpdateParams,
    applied: bool,
    reason: Option<&str>,
) -> AudioProcessingUpdateResult {
    AudioProcessingUpdateResult {
        microphone_noise_suppression: requested.microphone_noise_suppression.unwrap_or_default(),
        confirmed_microphone_noise_suppression: None,
        applied,
        session_id: requested.session_id.clone(),
        microphone_gain_db: requested.microphone_gain_db,
        microphone_muted: requested.microphone_muted,
        reason_code: reason.map(str::to_string),
        confirmed_microphone_gain_db: None,
        confirmed_microphone_muted: None,
    }
}

fn rejected(
    state: RecordingState,
    session_id: &str,
    current: &MicValues,
    requested: &AudioProcessingUpdateParams,
    result: Option<&AudioProcessingUpdateResult>,
    last_applied: &MicValues,
) -> Option<Rejection> {
    rejected_update(RejectionInput {
        state: &state,
        session_id: Some(session_id),
        current,
        requested,
        result,
        last_applied,
    })
}

/// The queue's first request, claimed and in flight.
fn first_in_flight(queue: &mut LatestWins, request: AudioProcessingUpdateParams) {
    queue.enqueue(request);
    assert!(queue.claim_drain(), "nothing drains yet");
    assert!(queue.take_next().is_some());
}

// --- activeAudioProcessingUpdateParams ---

#[test]
fn maps_shared_mic_controls_to_the_active_session() {
    for state in [RecordingState::Recording, RecordingState::Streaming] {
        assert_eq!(
            active_update_params(&state, Some(S1), &mic(6.0, true)),
            Some(AudioProcessingUpdateParams {
                microphone_noise_suppression: Some(MicrophoneNoiseSuppression::Off),
                ..params(6.0, true)
            })
        );
    }
}

#[test]
fn does_not_target_a_session_that_is_not_running() {
    for state in [
        RecordingState::Idle,
        RecordingState::Starting,
        RecordingState::Stopping,
        RecordingState::Failed,
    ] {
        assert_eq!(
            active_update_params(&state, Some(S1), &mic(6.0, false)),
            None
        );
    }
}

#[test]
fn requires_a_session_id_so_delayed_updates_cannot_cross_captures() {
    assert_eq!(
        active_update_params(&RecordingState::Streaming, None, &mic(-3.0, true)),
        None
    );
}

// --- rejectedLiveAudioProcessingUpdate ---

#[test]
fn restores_and_disables_when_native_audio_or_the_control_is_unavailable() {
    for reason in ["native-audio-unavailable", "live-audio-control-unavailable"] {
        let requested = params(8.0, true);
        let result = answer(&requested, false, Some(reason));
        assert_eq!(
            rejected(
                RecordingState::Recording,
                S1,
                &mic(8.0, true),
                &requested,
                Some(&result),
                &mic(-2.0, false),
            ),
            Some(Rejection {
                rollback: mic(-2.0, false),
                disable_for_session: true,
                message: copy::CONTROLS_UNAVAILABLE,
            }),
            "{reason}"
        );
    }
}

#[test]
fn does_not_claim_restoration_when_the_captured_state_is_unknown() {
    let requested = params(8.0, true);
    let result = answer(&requested, false, Some("live-audio-control-state-unknown"));
    let rejection = rejected(
        RecordingState::Recording,
        S1,
        &mic(8.0, true),
        &requested,
        Some(&result),
        &mic(-2.0, false),
    )
    .unwrap();
    assert_eq!(rejection.rollback, mic(-2.0, false));
    assert!(rejection.disable_for_session);
    assert_eq!(rejection.message, copy::STATE_UNKNOWN);
}

#[test]
fn leaves_an_ended_session_to_the_failure_report() {
    let requested = params(8.0, true);
    let result = answer(&requested, false, Some("session-ended"));
    assert_eq!(
        rejected(
            RecordingState::Recording,
            S1,
            &mic(8.0, true),
            &requested,
            Some(&result),
            &mic(-2.0, false),
        ),
        None
    );
}

#[test]
fn ignores_a_stale_rejection_after_a_newer_edit() {
    let requested = params(8.0, true);
    let result = answer(&requested, false, Some("stale-session"));
    assert_eq!(
        rejected(
            RecordingState::Recording,
            S1,
            &mic(3.0, false),
            &requested,
            Some(&result),
            &mic(-2.0, false),
        ),
        None
    );
    // While the controls still show it, it rolls back in its own words.
    let still = rejected(
        RecordingState::Recording,
        S1,
        &mic(8.0, true),
        &requested,
        Some(&result),
        &mic(-2.0, false),
    )
    .unwrap();
    assert_eq!(still.message, copy::NOT_APPLIED);
    assert!(!still.disable_for_session);
}

#[test]
fn prefers_the_backend_confirmed_rollback_over_a_newer_visible_edit() {
    let requested = params(8.0, false);
    let mut result = answer(&requested, false, Some("live-audio-control-unavailable"));
    result.confirmed_microphone_gain_db = Some(3.0);
    result.confirmed_microphone_muted = Some(false);
    assert_eq!(
        rejected(
            RecordingState::Recording,
            S1,
            &mic(12.0, true),
            &requested,
            Some(&result),
            &mic(-2.0, true),
        ),
        Some(Rejection {
            rollback: mic(3.0, false),
            disable_for_session: true,
            message: copy::CONTROLS_UNAVAILABLE,
        })
    );
}

#[test]
fn an_applied_change_is_no_rejection() {
    let requested = params(8.0, true);
    let result = answer(&requested, true, None);
    assert_eq!(
        rejected(
            RecordingState::Recording,
            S1,
            &mic(8.0, true),
            &requested,
            Some(&result),
            &mic(-2.0, false),
        ),
        None
    );
}

#[test]
fn a_lost_reply_is_unknown_state_for_the_current_session_only() {
    let requested = params(8.0, true);
    for state in [RecordingState::Recording, RecordingState::Streaming] {
        assert_eq!(
            rejected(
                state,
                S1,
                &mic(8.0, true),
                &requested,
                None,
                &mic(-2.0, false)
            ),
            Some(Rejection {
                rollback: mic(-2.0, false),
                disable_for_session: true,
                message: copy::STATE_UNKNOWN,
            })
        );
    }
    // The active session changed: nothing to roll back.
    assert_eq!(
        rejected(
            RecordingState::Streaming,
            "session-2",
            &mic(8.0, true),
            &requested,
            None,
            &mic(-2.0, false)
        ),
        None
    );
}

// --- liveAudioProcessingSessionSyncDecision ---

#[test]
fn queues_an_edit_made_while_the_start_was_in_flight() {
    let start = StartSnapshot {
        session_id: S1.to_string(),
        mic: mic(0.0, false),
        system: None,
    };
    assert_eq!(
        session_sync_decision(&params(6.0, true), Some(&start)),
        SessionSyncDecision {
            last_applied: mic(0.0, false),
            enqueue_desired: true,
        }
    );
    // An untouched start sends nothing.
    assert!(!session_sync_decision(&params(0.0, false), Some(&start)).enqueue_desired);
}

#[test]
fn does_not_seed_a_new_session_from_a_prior_snapshot() {
    let prior = StartSnapshot {
        session_id: S1.to_string(),
        mic: mic(-12.0, true),
        system: None,
    };
    let desired = AudioProcessingUpdateParams {
        session_id: "session-2".to_string(),
        ..params(4.0, false)
    };
    assert_eq!(
        session_sync_decision(&desired, Some(&prior)),
        SessionSyncDecision {
            last_applied: mic(4.0, false),
            enqueue_desired: true,
        }
    );
}

#[test]
fn confirms_noise_reduction_once_after_a_start_that_asked_for_it() {
    let rnnoise = MicValues {
        noise_suppression: MicrophoneNoiseSuppression::Rnnoise,
        ..mic(0.0, false)
    };
    let desired =
        active_update_params(&RecordingState::Recording, Some(S1), &rnnoise).expect("running");
    assert_eq!(
        desired.microphone_noise_suppression,
        Some(MicrophoneNoiseSuppression::Rnnoise)
    );
    // Asked while the start was in flight.
    let off_start = StartSnapshot {
        session_id: S1.to_string(),
        mic: mic(0.0, false),
        system: None,
    };
    let decision = session_sync_decision(&desired, Some(&off_start));
    assert_eq!(decision.last_applied, mic(0.0, false));
    assert!(decision.enqueue_desired);
    // Asked by the start itself: confirmed once.
    let rnnoise_start = StartSnapshot {
        mic: rnnoise.clone(),
        ..off_start.clone()
    };
    assert_eq!(
        session_sync_decision(&desired, Some(&rnnoise_start)),
        SessionSyncDecision {
            last_applied: rnnoise,
            enqueue_desired: true,
        }
    );
    // An untouched Off start still sends nothing.
    let off = active_update_params(&RecordingState::Recording, Some(S1), &mic(0.0, false))
        .expect("running");
    assert!(!session_sync_decision(&off, Some(&off_start)).enqueue_desired);
}

// --- LatestWinsLiveAudioProcessingQueue ---

#[test]
fn a_drag_flood_keeps_one_in_flight_and_the_newest_complete_state() {
    let mut queue = LatestWins::new(S1);
    first_in_flight(&mut queue, params(1.0, false));
    for gain in 2..=40 {
        queue.enqueue(params(gain as f32, gain == 40));
        assert!(!queue.claim_drain(), "the drainer runs");
    }
    assert!(queue.take_next().is_none(), "one in flight");
    assert!(queue.settle());
    assert_eq!(queue.take_next(), Some(params(40.0, true)));
    assert!(queue.settle());
    assert_eq!(queue.take_next(), None);
    assert!(!queue.has_outstanding_work());
    // The drain ended: the next request claims it again.
    queue.enqueue(params(41.0, true));
    assert!(queue.claim_drain());
}

#[test]
fn the_stop_drops_the_flooded_tail_and_the_reply_in_flight() {
    let mut queue = LatestWins::new(S1);
    first_in_flight(&mut queue, params(1.0, false));
    for gain in 2..=40 {
        queue.enqueue(params(gain as f32, false));
    }
    queue.stop();
    assert!(!queue.settle(), "the reply is inert");
    assert_eq!(queue.take_next(), None);
    assert!(!queue.has_outstanding_work());
    queue.enqueue(params(5.0, false));
    assert!(!queue.wants_drain(), "nothing after the stop");
}

#[test]
fn an_unhealthy_settlement_stops_before_the_waiting_request() {
    let mut queue = LatestWins::new(S1);
    first_in_flight(&mut queue, params(1.0, false));
    queue.enqueue(params(24.0, true));
    assert!(queue.settle());
    // `onSettled` answered false.
    queue.stop();
    assert_eq!(queue.take_next(), None);
}

#[test]
fn another_sessions_request_is_dropped() {
    let mut queue = LatestWins::new(S1);
    queue.enqueue(AudioProcessingUpdateParams {
        session_id: "session-2".to_string(),
        ..params(1.0, false)
    });
    assert!(!queue.has_outstanding_work());
}

#[test]
fn a_dropped_drain_lets_the_next_request_claim_the_queue() {
    let mut queue = LatestWins::new(S1);
    first_in_flight(&mut queue, params(1.0, false));
    queue.enqueue(params(2.0, false));
    queue.abandon_drain();
    assert!(queue.claim_drain());
    assert_eq!(queue.take_next(), Some(params(2.0, false)));
}

#[test]
fn a_sender_failure_after_a_possible_apply_is_unknown_state() {
    let mut queue = LatestWins::new(S1);
    first_in_flight(&mut queue, params(6.0, false));
    assert!(queue.settle());
    let rejection = rejected(
        RecordingState::Recording,
        S1,
        &mic(6.0, false),
        &params(6.0, false),
        None,
        &mic(0.0, false),
    )
    .unwrap();
    assert_eq!(rejection.rollback, mic(0.0, false));
    assert!(rejection.disable_for_session);
    assert_eq!(rejection.message, copy::STATE_UNKNOWN);
}

// --- System audio on the latest-wins queue (plan 069) ---

#[test]
fn merges_per_field_newest_wins_and_untouched_fields_stay_omitted() {
    let mic_only = params(2.0, false);
    assert_eq!(
        merge_params(&mic_only, &params(4.0, false)),
        params(4.0, false)
    );
    let older = AudioProcessingUpdateParams {
        system_audio_enabled: Some(true),
        system_audio_gain_db: Some(-6.0),
        ..params(2.0, false)
    };
    let newer = AudioProcessingUpdateParams {
        system_audio_gain_db: Some(-12.0),
        ..params(2.0, true)
    };
    assert_eq!(
        merge_params(&older, &newer),
        AudioProcessingUpdateParams {
            system_audio_enabled: Some(true),
            system_audio_gain_db: Some(-12.0),
            ..params(2.0, true)
        }
    );
    let on = AudioProcessingUpdateParams {
        system_audio_enabled: Some(true),
        ..params(2.0, false)
    };
    let off = AudioProcessingUpdateParams {
        system_audio_enabled: Some(false),
        ..params(2.0, false)
    };
    assert_eq!(merge_params(&on, &off), off);
}

#[test]
fn a_later_mic_only_edit_keeps_the_waiting_system_audio_toggle() {
    let mut queue = LatestWins::new(S1);
    first_in_flight(&mut queue, params(1.0, false));
    queue.enqueue(AudioProcessingUpdateParams {
        system_audio_enabled: Some(true),
        ..params(1.0, false)
    });
    queue.enqueue(AudioProcessingUpdateParams {
        system_audio_gain_db: Some(-9.0),
        ..params(3.0, false)
    });
    queue.enqueue(params(5.0, false));
    assert!(queue.settle());
    assert_eq!(
        queue.take_next(),
        Some(AudioProcessingUpdateParams {
            system_audio_enabled: Some(true),
            system_audio_gain_db: Some(-9.0),
            ..params(5.0, false)
        })
    );
}

#[test]
fn a_system_audio_only_change_is_sent_with_the_mic_unchanged() {
    let mut queue = LatestWins::new(S1);
    let mic_state = params(0.0, false);
    let with_system = AudioProcessingUpdateParams {
        system_audio_enabled: Some(true),
        ..mic_state.clone()
    };
    first_in_flight(&mut queue, mic_state.clone());
    // A mic-only repeat of the request in flight adds nothing.
    queue.enqueue(mic_state.clone());
    assert!(queue.pending().is_none());
    // The same mic state with a System audio toggle is a change; again,
    // while it waits, adds nothing.
    queue.enqueue(with_system.clone());
    queue.enqueue(with_system.clone());
    assert!(queue.settle());
    assert_eq!(queue.take_next(), Some(with_system));
    assert!(queue.settle());
    assert_eq!(queue.take_next(), None);
}

#[test]
fn a_waiting_request_a_newer_one_leaves_unchanged_is_sent_once() {
    let mut queue = LatestWins::new(S1);
    let waiting = AudioProcessingUpdateParams {
        system_audio_enabled: Some(true),
        system_audio_gain_db: Some(-3.0),
        ..params(2.0, false)
    };
    first_in_flight(&mut queue, params(1.0, false));
    queue.enqueue(waiting.clone());
    queue.enqueue(params(2.0, false));
    queue.enqueue(AudioProcessingUpdateParams {
        system_audio_gain_db: Some(-3.0),
        ..params(2.0, false)
    });
    assert!(queue.settle());
    assert_eq!(queue.take_next(), Some(waiting));
    assert!(queue.settle());
    assert_eq!(queue.take_next(), None);
}

// --- systemAudioProcessingDelta (plan 069) ---

#[test]
fn the_system_audio_delta_carries_only_what_the_session_lacks() {
    let off = SystemValues {
        enabled: false,
        gain_db: -6.0,
        echo_guard: true,
    };
    assert!(system_audio_delta(&off, Some(&off)).is_empty());
    let on = SystemValues {
        enabled: true,
        ..off.clone()
    };
    assert_eq!(
        system_audio_delta(&on, Some(&off)),
        SystemDelta {
            enabled: Some(true),
            ..SystemDelta::default()
        }
    );
    let quieter = SystemValues {
        gain_db: -12.0,
        ..off.clone()
    };
    assert_eq!(
        system_audio_delta(&quieter, Some(&off)),
        SystemDelta {
            gain_db: Some(-12.0),
            ..SystemDelta::default()
        }
    );
    // Unknown: every field, the echo guard On.
    assert_eq!(
        system_audio_delta(&off, None),
        SystemDelta {
            enabled: Some(false),
            gain_db: Some(-6.0),
            echo_guard: Some(true),
        }
    );
    // The echo guard only when it changes (plan 076).
    let unguarded = SystemValues {
        echo_guard: false,
        ..off.clone()
    };
    assert_eq!(
        system_audio_delta(&unguarded, Some(&off)),
        SystemDelta {
            echo_guard: Some(false),
            ..SystemDelta::default()
        }
    );
    assert_eq!(
        system_audio_delta(&off, Some(&unguarded)),
        SystemDelta {
            echo_guard: Some(true),
            ..SystemDelta::default()
        }
    );
    let mut request = params(0.0, false);
    system_audio_delta(&on, Some(&off)).apply_to(&mut request);
    assert_eq!(request.system_audio_enabled, Some(true));
    assert_eq!(request.system_audio_gain_db, None);
}

// --- live RNNoise controls ---

#[test]
fn suppression_and_system_edits_survive_a_newer_gain_or_mute_request() {
    let older = AudioProcessingUpdateParams {
        microphone_noise_suppression: Some(MicrophoneNoiseSuppression::Rnnoise),
        system_audio_enabled: Some(true),
        ..params(0.0, false)
    };
    assert_eq!(
        merge_params(&older, &params(6.0, true)),
        AudioProcessingUpdateParams {
            microphone_noise_suppression: Some(MicrophoneNoiseSuppression::Rnnoise),
            system_audio_enabled: Some(true),
            ..params(6.0, true)
        }
    );
}

#[test]
fn rapid_suppression_toggles_coalesce_with_gain_mute_and_system_changes() {
    let rnnoise = Some(MicrophoneNoiseSuppression::Rnnoise);
    let mut queue = LatestWins::new(S1);
    first_in_flight(
        &mut queue,
        AudioProcessingUpdateParams {
            microphone_noise_suppression: rnnoise,
            ..params(0.0, false)
        },
    );
    queue.enqueue(AudioProcessingUpdateParams {
        microphone_noise_suppression: Some(MicrophoneNoiseSuppression::Off),
        system_audio_enabled: Some(true),
        ..params(0.0, false)
    });
    queue.enqueue(AudioProcessingUpdateParams {
        microphone_noise_suppression: rnnoise,
        ..params(6.0, true)
    });
    assert!(queue.settle());
    assert_eq!(
        queue.take_next(),
        Some(AudioProcessingUpdateParams {
            microphone_noise_suppression: rnnoise,
            system_audio_enabled: Some(true),
            ..params(6.0, true)
        })
    );
}

#[test]
fn an_unavailable_suppression_change_rolls_back_without_disabling_gain_and_mute() {
    let rnnoise = MicValues {
        noise_suppression: MicrophoneNoiseSuppression::Rnnoise,
        ..mic(0.0, false)
    };
    let requested = AudioProcessingUpdateParams {
        microphone_noise_suppression: Some(MicrophoneNoiseSuppression::Rnnoise),
        ..params(0.0, false)
    };
    let mut result = answer(
        &requested,
        false,
        Some("microphone-noise-suppression-unavailable"),
    );
    result.confirmed_microphone_gain_db = Some(0.0);
    result.confirmed_microphone_muted = Some(false);
    result.confirmed_microphone_noise_suppression = Some(MicrophoneNoiseSuppression::Off);
    let rejection = rejected(
        RecordingState::Recording,
        S1,
        &rnnoise,
        &requested,
        Some(&result),
        &mic(0.0, false),
    )
    .unwrap();
    assert_eq!(rejection.rollback, mic(0.0, false));
    assert!(!rejection.disable_for_session);
    assert_eq!(rejection.message, copy::NOISE_UNAVAILABLE);
    // The controls moved on: nothing to roll back.
    assert_eq!(
        rejected(
            RecordingState::Recording,
            S1,
            &mic(0.0, false),
            &requested,
            Some(&result),
            &mic(0.0, false),
        ),
        None
    );
}

#[test]
fn a_confirmed_off_is_restored_even_without_a_confirmed_gain_and_mute() {
    let requested = AudioProcessingUpdateParams {
        microphone_noise_suppression: Some(MicrophoneNoiseSuppression::Rnnoise),
        ..params(6.0, true)
    };
    let decision = session_sync_decision(&requested, None);
    assert_eq!(
        decision.last_applied.noise_suppression,
        MicrophoneNoiseSuppression::Rnnoise
    );
    let mut result = answer(
        &requested,
        false,
        Some("microphone-noise-suppression-unavailable"),
    );
    result.confirmed_microphone_noise_suppression = Some(MicrophoneNoiseSuppression::Off);
    let rejection = rejected(
        RecordingState::Recording,
        S1,
        &MicValues::requested(&requested),
        &requested,
        Some(&result),
        &decision.last_applied,
    )
    .unwrap();
    assert_eq!(rejection.rollback, mic(6.0, true));
    assert!(!rejection.disable_for_session);
}

#[test]
fn a_dead_bus_pins_live_edits_to_the_confirmed_settings() {
    let requested = AudioProcessingUpdateParams {
        microphone_noise_suppression: Some(MicrophoneNoiseSuppression::Rnnoise),
        ..params(6.0, false)
    };
    let mut result = answer(&requested, false, Some("live-audio-control-unavailable"));
    result.confirmed_microphone_gain_db = Some(3.0);
    result.confirmed_microphone_muted = Some(false);
    result.confirmed_microphone_noise_suppression = Some(MicrophoneNoiseSuppression::Rnnoise);
    // A newer edit already queued rolls back too: the whole controller is
    // unavailable.
    let rejection = rejected(
        RecordingState::Recording,
        S1,
        &mic(9.0, true),
        &requested,
        Some(&result),
        &mic(0.0, false),
    )
    .unwrap();
    assert_eq!(
        rejection,
        Rejection {
            rollback: MicValues {
                noise_suppression: MicrophoneNoiseSuppression::Rnnoise,
                ..mic(3.0, false)
            },
            disable_for_session: true,
            message: copy::CONTROLS_UNAVAILABLE,
        }
    );
}

// --- the microphone waiters ---

#[test]
fn a_waiter_hears_its_mute_land_or_the_end() {
    let mut waiters = MicrophoneWaiters::default();
    let mut muted = waiters.wait(S1, true);
    let mut other = waiters.wait("session-2", true);
    // Not yet, and more is coming.
    waiters.settle(S1, false, false);
    assert!(muted.try_recv().is_err());
    waiters.settle(S1, true, false);
    assert_eq!(muted.try_recv(), Ok(true));
    // A terminal settlement that disagrees is a no.
    let mut unmuted = waiters.wait(S1, false);
    waiters.settle(S1, true, true);
    assert_eq!(unmuted.try_recv(), Ok(false));
    // Failing one session leaves the other.
    waiters.fail(Some(S1));
    assert_eq!(waiters.len(), 1);
    waiters.fail(None);
    assert_eq!(other.try_recv(), Ok(false));
    assert!(waiters.is_empty());
}
