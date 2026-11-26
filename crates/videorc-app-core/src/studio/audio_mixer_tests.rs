//! S3.1d: the Audio section's decisions (`system-audio.test.ts`,
//! `mic-meter-input.test.ts`, `level-meter` and `gain-faders`' cases kept).

use std::time::{Duration, Instant};

use super::*;

fn input(status: Option<DeviceStatus>) -> SwitchInput {
    SwitchInput {
        status,
        requested: true,
        session_active: false,
        audio_bus_active: false,
        confirmed: None,
        issue: None,
        joining: false,
    }
}

#[test]
fn the_switch_shows_what_the_session_confirms() {
    assert!(!system_audio_switch_view(&input(None)).visible);
    let permission = system_audio_switch_view(&input(Some(DeviceStatus::PermissionRequired)));
    assert!(permission.visible && permission.permission_required && !permission.checked);
    let idle = system_audio_switch_view(&input(Some(DeviceStatus::Available)));
    assert!(idle.checked && !idle.meter && idle.state_label == "On");
    let pending = system_audio_switch_view(&SwitchInput {
        audio_bus_active: true,
        confirmed: Some(false),
        ..input(Some(DeviceStatus::Available))
    });
    assert_eq!(pending.pending, Some(Pending::On));
    assert_eq!(pending.state_label, "Turning on…");
    assert!(!pending.checked);
    let joining = system_audio_switch_view(&SwitchInput {
        audio_bus_active: true,
        confirmed: Some(false),
        joining: true,
        ..input(Some(DeviceStatus::Available))
    });
    assert!(joining.checked && joining.pending.is_none());
    let mixed = system_audio_switch_view(&SwitchInput {
        audio_bus_active: true,
        confirmed: Some(true),
        ..input(Some(DeviceStatus::Available))
    });
    assert!(mixed.meter);
    assert_eq!(
        system_audio_status(&mixed, true),
        Some(Chip {
            label: "Receiving",
            tone: "good"
        })
    );
    let echo = system_audio_switch_view(&SwitchInput {
        audio_bus_active: true,
        confirmed: Some(false),
        issue: Some(SystemAudioIssue::Echo),
        ..input(Some(DeviceStatus::Available))
    });
    assert_eq!(echo.state_label, "Paused");
    assert_eq!(system_audio_status(&echo, true).unwrap().label, "Paused");
    assert!(system_audio_issue_copy(SystemAudioIssue::Echo, "Mac").contains("this Mac"));
    // `platformCopy`: Linux says "computer" (review of #1862).
    assert!(system_audio_issue_copy(SystemAudioIssue::Echo, "computer").contains("this computer"));
    assert!(["Mac", "PC", "computer"].contains(&this_computer_word()));
}

#[test]
fn the_join_latch_and_the_issue_codes() {
    let join = next_system_audio_join(None, Some("s1"), true, Some(false), false).unwrap();
    assert!(!join.settled);
    assert!(system_audio_joining(Some(&join), true, Some(false)));
    let settled = next_system_audio_join(Some(&join), Some("s1"), true, Some(true), false).unwrap();
    assert!(settled.settled);
    assert_eq!(
        next_system_audio_join(Some(&settled), None, true, None, false),
        None
    );
    assert_eq!(
        system_audio_issue_from_code("system-audio-echo-paused"),
        Some(SystemAudioIssue::Echo)
    );
    assert_eq!(system_audio_issue_from_code("camera-lost"), None);
    assert_eq!(
        system_audio_target("toggle", Some(&DeviceStatus::Available), true),
        Some(false)
    );
    assert_eq!(
        system_audio_target("on", Some(&DeviceStatus::PermissionRequired), false),
        None
    );
}

#[test]
fn the_meter_lights_its_segments_in_their_zones_and_falls_when_the_levels_stop() {
    assert_eq!(lit_segments(-60.0), 0);
    assert_eq!(lit_segments(0.0), 24);
    assert_eq!(lit_segments(-30.0), 12);
    assert_eq!(segment_zone(0), "ok");
    assert_eq!(segment_zone(16), "warn");
    assert_eq!(segment_zone(21), "clip");
    let start = Instant::now();
    let mut meter = MeterBallistics::default();
    let loud = meter.step(Some(-12.0), start);
    assert_eq!(loud.lit, lit_segments(-12.0));
    // The levels stop: the bar falls, the held peak waits, then falls too.
    let mut at = start;
    for _ in 0..20 {
        at += Duration::from_millis(50);
        meter.step(None, at);
    }
    let fallen = meter.view();
    assert!(
        fallen.lit < loud.lit && fallen.hold > fallen.lit,
        "{fallen:?}"
    );
    for _ in 0..80 {
        at += Duration::from_millis(50);
        meter.step(None, at);
    }
    assert!(meter.settled(), "{:?}", meter.view());
}

#[test]
fn gain_reads_and_resets_as_the_faders_do() {
    assert_eq!(format_db(0.0), "0.0 dB");
    assert_eq!(format_db(-6.0), "\u{2212}6.0 dB");
    assert_eq!(format_db(6.0), "+6.0 dB");
    assert_eq!(gain_reset_label(0.0, MICROPHONE_GAIN_DEFAULT), None);
    assert_eq!(
        gain_reset_label(-12.0, SYSTEM_AUDIO_GAIN_DEFAULT).as_deref(),
        Some("Reset to \u{2212}6.0 dB")
    );
    assert_eq!(
        mic_signal_label(mic_monitor_state(false, true, false, false)),
        "Receiving"
    );
    assert_eq!(
        mic_signal_label(mic_monitor_state(true, false, false, false)),
        "No signal"
    );
    assert_eq!(
        mic_signal_label(mic_monitor_state(true, true, true, false)),
        "Muted"
    );
}
