//! Ports of `live-dashboard-relay.test.ts`: session confirmation, early
//! chat totals, the talk-show room as the session, and the 1-second push.

use serde_json::json;
use videorc_protocol::{RecordingState, RecordingStatus};

use super::{DashboardPushCoalescer, DashboardRelay, PUSH_INTERVAL_MS, talk_show_dashboard_status};
use crate::livestream::cloud_status::{CloudLeg, CloudShow, CloudStatus};
use crate::stream_manager::dashboard::{
    AudienceSnapshot, LiveDashboard, SessionChatTotals, SessionState, ViewerSample,
};

const AT: &str = "2026-11-19T12:00:00.000Z";

fn available(session_id: &str, revision: u64) -> SessionChatTotals {
    SessionChatTotals::Available {
        session_id: session_id.into(),
        revision,
        message_count: revision,
        chatters: 0,
        follows: 0,
        supporters: 0,
        bits: 0,
        raids: 0,
        platforms: Vec::new(),
        tips: Vec::new(),
    }
}

fn recording(session_id: &str) -> RecordingStatus {
    RecordingStatus {
        state: RecordingState::Recording,
        session_id: Some(session_id.into()),
        output_path: None,
        stream_url: None,
        started_at: Some(AT.into()),
        audio_tracks: Vec::new(),
        pipeline: None,
        duration_ms: None,
        message: None,
        replay_only: false,
        accepts_live_scene_edits: None,
    }
}

fn idle(session_id: &str) -> RecordingStatus {
    RecordingStatus {
        state: RecordingState::Idle,
        session_id: Some(session_id.into()),
        output_path: None,
        stream_url: None,
        started_at: None,
        audio_tracks: Vec::new(),
        pipeline: None,
        duration_ms: None,
        message: None,
        replay_only: false,
        accepts_live_scene_edits: None,
    }
}

#[test]
fn confirmed_session_keeps_newest_pending_totals() {
    let mut relay = DashboardRelay::new(AT);
    assert!(!relay.chat_totals(available("b", 8), AT));
    assert!(!relay.chat_totals(available("b", 2), AT));
    assert!(relay.current().session_id.is_none());
    assert!(relay.recording(&recording("b"), AT));
    assert_eq!(relay.current().chat_totals, Some(available("b", 8)));
    assert!(!relay.audience(
        AudienceSnapshot {
            session_id: "a".into(),
            platforms: Vec::new(),
            updated_at: AT.into(),
        },
        AT
    ));
    assert!(!relay.viewers(
        Some(ViewerSample {
            session_id: "a".into(),
            platforms: Vec::new(),
            total: 99,
            at: AT.into(),
        }),
        AT
    ));
    assert!(!relay.health(
        json!({ "sessionId": "a", "createdAt": AT, "bitrateKbps": 10 }),
        AT
    ));
    assert!(!relay.chat_totals(available("a", 99), AT));
    assert_eq!(relay.current().session_id.as_deref(), Some("b"));
    assert_eq!(relay.current().chat_totals, Some(available("b", 8)));
    assert!(!relay.recording(&idle("a"), AT));
    assert_eq!(relay.current().session, SessionState::Recording);
    assert!(relay.recording(&idle("b"), AT));
    assert_eq!(relay.current().chat_totals, Some(available("b", 8)));
    assert!(relay.recording(&recording("c"), AT));
    assert!(relay.current().chat_totals.is_none());
}

#[test]
fn seed_keeps_cache_until_recording_confirms_pending() {
    let mut relay = DashboardRelay::new(AT);
    assert!(relay.seed(LiveDashboard {
        session_id: Some("a".into()),
        chat_totals: Some(available("a", 6)),
        updated_at: AT.into(),
        ..LiveDashboard::default()
    }));
    assert!(!relay.chat_totals(available("a", 8), AT));
    assert!(!relay.recording(
        &RecordingStatus {
            state: RecordingState::Idle,
            session_id: None,
            ..idle("x")
        },
        AT
    ));
    assert_eq!(relay.current().chat_totals, Some(available("a", 6)));
    assert!(!relay.chat_totals(available("a", 8), AT));
    assert!(relay.recording(&recording("a"), AT));
    assert_eq!(relay.current().chat_totals, Some(available("a", 8)));
}

#[test]
fn talk_show_room_reads_as_on_air_under_the_show_id() {
    let status = CloudStatus {
        phase: "live".into(),
        show: Some(CloudShow {
            id: "sh_talk".into(),
            ..CloudShow::default()
        }),
        room: Some(json!({
            "phase": "open",
            "live": true,
            "liveSince": AT,
        })),
        legs: vec![CloudLeg {
            target_id: "twitch-1".into(),
            platform: "twitch".into(),
            label: "Twitch".into(),
            state: "live".into(),
            message: None,
        }],
        live_seconds: Some(30),
        ..CloudStatus::default()
    };
    let current = LiveDashboard::default();
    let room = talk_show_dashboard_status(&status, &current, 1_000_000).expect("room");
    assert_eq!(room.state, RecordingState::Streaming);
    assert_eq!(room.session_id.as_deref(), Some("sh_talk"));
    assert_eq!(room.stream_url.as_deref(), Some("videorc-cloud"));
    assert_eq!(room.started_at.as_deref(), Some(AT));

    let mut relay = DashboardRelay::new(AT);
    assert!(relay.cloud(&status, AT, 1_000_000));
    assert_eq!(relay.current().session_id.as_deref(), Some("sh_talk"));
    assert_eq!(relay.current().session, SessionState::Live);
    assert_eq!(relay.current().targets.len(), 1);
    assert_eq!(relay.current().targets[0].target_id, "twitch-1");
}

#[test]
fn talk_show_keeps_the_runner_clock_once() {
    let status = CloudStatus {
        phase: "live".into(),
        show: Some(CloudShow {
            id: "sh_talk".into(),
            ..CloudShow::default()
        }),
        room: Some(json!({ "phase": "open", "live": true })),
        live_seconds: Some(10),
        ..CloudStatus::default()
    };
    let mut relay = DashboardRelay::new(AT);
    assert!(relay.cloud(&status, AT, 1_000_000));
    let first = relay.current().started_at.clone();
    assert!(relay.cloud(&status, AT, 1_500_000));
    assert_eq!(relay.current().started_at, first);
}

#[test]
fn coalescer_pushes_at_most_once_a_second() {
    let mut coalescer = DashboardPushCoalescer::default();
    let first = LiveDashboard {
        session_id: Some("a".into()),
        updated_at: "t1".into(),
        ..LiveDashboard::default()
    };
    let second = LiveDashboard {
        session_id: Some("a".into()),
        updated_at: "t2".into(),
        ..LiveDashboard::default()
    };
    let pushed = coalescer.schedule(first.clone(), 0).expect("first push");
    assert_eq!(pushed.updated_at, "t1");
    assert!(coalescer.schedule(second.clone(), 100).is_none());
    assert!(coalescer.tick(100).is_none());
    let trailing = coalescer
        .tick(PUSH_INTERVAL_MS as i64)
        .expect("trailing push");
    assert_eq!(trailing.updated_at, "t2");
}

#[test]
fn only_the_newest_timer_fires_the_trailing_push() {
    let mut coalescer = DashboardPushCoalescer::default();
    let state = |at: &str| LiveDashboard {
        updated_at: at.into(),
        ..LiveDashboard::default()
    };
    assert!(coalescer.schedule(state("t1"), 0).is_some());
    assert!(
        coalescer.due().is_none(),
        "the first push leaves nothing due"
    );
    assert!(coalescer.schedule(state("t2"), 100).is_none());
    let (due, first_timer) = coalescer.due().expect("a trailing push is due");
    assert_eq!(due, PUSH_INTERVAL_MS as i64);
    // A sleep that ends a moment early still pushes.
    let pushed = coalescer
        .fire(first_timer, due - 5)
        .expect("the timer pushes");
    assert_eq!(pushed.updated_at, "t2");
    assert!(coalescer.fire(first_timer, due).is_none(), "nothing twice");

    assert!(coalescer.schedule(state("t3"), due + 10).is_none());
    let (_, second_timer) = coalescer.due().unwrap();
    assert_ne!(second_timer, first_timer);
    assert!(
        coalescer.fire(first_timer, due + 2_000).is_none(),
        "a stale timer"
    );
    coalescer.dispose();
    assert!(
        coalescer.fire(second_timer, due + 2_000).is_none(),
        "disposed"
    );
}

#[test]
fn merge_viewer_history_keeps_known_points() {
    let mut board = LiveDashboard {
        session_id: Some("s1".into()),
        viewer_history: vec![("2026-11-19T12:00:00.000Z".into(), 3)],
        peak_viewers: Some(3),
        updated_at: AT.into(),
        ..LiveDashboard::default()
    };
    board.merge_viewer_history(
        "s1",
        &[
            ViewerSample {
                session_id: "s1".into(),
                platforms: Vec::new(),
                total: 3,
                at: "2026-11-19T12:00:00.000Z".into(),
            },
            ViewerSample {
                session_id: "s1".into(),
                platforms: Vec::new(),
                total: 7,
                at: "2026-11-19T12:00:30.000Z".into(),
            },
        ],
        AT,
    );
    assert_eq!(board.viewer_history.len(), 2);
    assert_eq!(board.peak_viewers, Some(7));
}
