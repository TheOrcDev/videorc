//! Ported from `lib/talk-show-session.test.ts` and
//! `lib/talk-show-auto-rejoin.test.ts`.

use std::collections::VecDeque;

use super::*;
use crate::guests::wire::RoomStatus;

fn open_room(live: bool) -> RoomStatus {
    RoomStatus {
        phase: RoomPhase::Open,
        live,
        ..RoomStatus::default()
    }
}

fn talk(room: Option<RoomStatus>) -> TalkShowFacts {
    TalkShowFacts {
        phase: "live".into(),
        show: Some(ShowFacts {
            id: "sh_talk1234".into(),
            kind: Some("talk".into()),
            resumable: true,
        }),
        room,
        controller: Some(ControllerFacts {
            controller_epoch: 3,
            ..ControllerFacts::default()
        }),
        ..TalkShowFacts::default()
    }
}

fn recording(active: bool, problem: Option<&str>) -> Option<RecordingStatus> {
    Some(RecordingStatus {
        active,
        since: active.then(|| "2026-11-24T10:00:00Z".to_string()),
        problem: problem.map(str::to_string),
        ..RecordingStatus::default()
    })
}

#[test]
fn on_air_wins_over_the_recording_and_a_closed_room_is_nothing() {
    let mut status = talk(Some(open_room(true)));
    status.recording = recording(true, None);
    let view = talk_show_session_view(Some(&status), Some(LiveStartedAt::EpochMs(5))).unwrap();
    assert_eq!(view.state, TalkShowSessionState::Streaming);
    assert_eq!(view.session_id, "sh_talk1234");
    assert_eq!(view.stream_url, Some(TALK_SHOW_STREAM_URL));
    assert_eq!(view.started_at, Some(LiveStartedAt::EpochMs(5)));

    status.room = Some(open_room(false));
    let view = talk_show_session_view(Some(&status), None).unwrap();
    assert_eq!(view.state, TalkShowSessionState::Recording);
    assert_eq!(
        view.started_at,
        Some(LiveStartedAt::Stamp("2026-11-24T10:00:00Z".into()))
    );
    assert_eq!(view.stream_url, None);

    status.recording = recording(false, None);
    assert_eq!(talk_show_session_view(Some(&status), None), None);
    let closed = talk(Some(RoomStatus::default()));
    assert_eq!(talk_show_session_view(Some(&closed), None), None);
    assert_eq!(talk_show_session_view(None, None), None);
}

#[test]
fn the_live_clock_reads_the_hand_over_stamp_else_the_runners_seconds() {
    let mut status = talk(Some(RoomStatus {
        live_since: Some("2026-11-24T10:00:00.000Z".into()),
        ..open_room(true)
    }));
    assert_eq!(
        talk_show_live_started_at(Some(&status), 1_000_000),
        LiveStartedAt::Stamp("2026-11-24T10:00:00.000Z".into())
    );
    status.room = Some(RoomStatus {
        live_since: Some("not a time".into()),
        ..open_room(true)
    });
    status.live_seconds = Some(90);
    assert_eq!(
        talk_show_live_started_at(Some(&status), 1_000_000),
        LiveStartedAt::EpochMs(910_000)
    );
    assert_eq!(
        talk_show_live_started_at(None, 7),
        LiveStartedAt::EpochMs(7)
    );
}

#[test]
fn record_says_why_the_cloud_recording_cant_start() {
    let mut status = talk(Some(open_room(false)));
    let reason = |status: &TalkShowFacts| talk_show_recording_blocked_reason(Some(status));
    status.recording = recording(false, Some("no-target"));
    assert_eq!(
        reason(&status).as_deref(),
        Some("Cloud recordings aren't set up for this show.")
    );
    status.recording = recording(false, Some("bad-target: bucket"));
    assert_eq!(
        reason(&status).as_deref(),
        Some("Cloud recordings aren't set up for this show.")
    );
    status.recording = recording(false, Some("credentials-expired"));
    assert_eq!(
        reason(&status).as_deref(),
        Some("The cloud recording stopped: its storage access expired.")
    );
    status.recording = recording(false, Some("upload-failed"));
    assert_eq!(
        reason(&status).as_deref(),
        Some("The cloud recording stopped: the upload didn't go through.")
    );
    status.recording = recording(false, Some("disk"));
    assert_eq!(
        reason(&status).as_deref(),
        Some("The cloud recording isn't available (disk).")
    );
    status.room = None;
    assert_eq!(reason(&status), None);
}

#[test]
fn a_start_says_what_already_runs() {
    let mut status = talk(Some(open_room(true)));
    assert_eq!(
        talk_show_start_blocked_reason(Some(&status), false, true).as_deref(),
        Some("This show is already live.")
    );
    status.room = Some(open_room(false));
    status.recording = recording(true, None);
    assert_eq!(
        talk_show_start_blocked_reason(Some(&status), true, false).as_deref(),
        Some("The cloud recording is already running.")
    );
    assert_eq!(
        talk_show_start_blocked_reason(Some(&status), true, true),
        None
    );
    status.recording = recording(false, Some("no-target"));
    assert_eq!(
        talk_show_start_blocked_reason(Some(&status), true, true).as_deref(),
        Some("Cloud recordings aren't set up for this show.")
    );
    assert!(talk_show_starts_recording_first(true, false));
    assert!(!talk_show_starts_recording_first(true, true));
    assert!(!talk_show_starts_recording_first(false, false));
}

fn held() -> AutoRejoinHeld {
    AutoRejoinHeld {
        show_id: "sh_talk1234".into(),
    }
}

#[test]
fn the_rejoin_resumes_only_a_show_confirmed_as_this_computers() {
    use AutoRejoinDecision::{Resume, Stop, Wait};
    let held = held();
    let ready = talk(None);
    assert_eq!(auto_rejoin_decision(Some(&held), 0, Some(&ready)), Resume);
    assert_eq!(
        auto_rejoin_decision(None, 0, Some(&ready)),
        Stop(AutoRejoinStop::NothingHeld)
    );
    assert_eq!(
        auto_rejoin_decision(Some(&held), 0, Some(&talk(Some(open_room(false))))),
        Stop(AutoRejoinStop::RoomOpen)
    );
    assert_eq!(
        auto_rejoin_decision(Some(&held), 3, Some(&ready)),
        Stop(AutoRejoinStop::GaveUp)
    );
    assert_eq!(
        auto_rejoin_decision(Some(&held), 0, None),
        Wait(AutoRejoinWaitOn::Backend)
    );
    let no_show = TalkShowFacts {
        show: None,
        ..ready.clone()
    };
    assert_eq!(
        auto_rejoin_decision(Some(&held), 0, Some(&no_show)),
        Wait(AutoRejoinWaitOn::Show)
    );
    let other = TalkShowFacts {
        show: Some(ShowFacts {
            id: "sh_other12345".into(),
            ..ready.show.clone().unwrap()
        }),
        ..ready.clone()
    };
    assert_eq!(
        auto_rejoin_decision(Some(&held), 0, Some(&other)),
        Stop(AutoRejoinStop::OtherShow)
    );
    let ending = TalkShowFacts {
        phase: "ending".into(),
        ..ready.clone()
    };
    assert_eq!(
        auto_rejoin_decision(Some(&held), 0, Some(&ending)),
        Stop(AutoRejoinStop::ShowOver)
    );
    let handed = TalkShowFacts {
        on_air: Some(OnAirFacts {
            this_device: false,
            waiting: true,
        }),
        ..ready.clone()
    };
    assert_eq!(
        auto_rejoin_decision(Some(&held), 0, Some(&handed)),
        Stop(AutoRejoinStop::HandedOff)
    );
    let elsewhere = TalkShowFacts {
        on_air: Some(OnAirFacts {
            this_device: false,
            waiting: false,
        }),
        ..ready.clone()
    };
    assert_eq!(
        auto_rejoin_decision(Some(&held), 0, Some(&elsewhere)),
        Stop(AutoRejoinStop::Elsewhere)
    );
    let lost = TalkShowFacts {
        controller: Some(ControllerFacts {
            controller_epoch: 4,
            lost: true,
            ..ControllerFacts::default()
        }),
        ..ready.clone()
    };
    assert_eq!(
        auto_rejoin_decision(Some(&held), 0, Some(&lost)),
        Stop(AutoRejoinStop::Elsewhere)
    );
    let unrenewed = TalkShowFacts {
        controller: Some(ControllerFacts::default()),
        ..ready
    };
    assert_eq!(
        auto_rejoin_decision(Some(&held), 0, Some(&unrenewed)),
        Wait(AutoRejoinWaitOn::Controller)
    );
}

/// A backend that answers from a script.
struct Scripted {
    statuses: VecDeque<anyhow::Result<TalkShowFacts>>,
    resumes: VecDeque<anyhow::Result<TalkShowFacts>>,
    slept: Vec<u64>,
    told: usize,
    cancel_after_reads: Option<usize>,
    reads: usize,
}

impl Scripted {
    fn new(
        statuses: Vec<anyhow::Result<TalkShowFacts>>,
        resumes: Vec<anyhow::Result<TalkShowFacts>>,
    ) -> Self {
        Self {
            statuses: statuses.into(),
            resumes: resumes.into(),
            slept: Vec::new(),
            told: 0,
            cancel_after_reads: None,
            reads: 0,
        }
    }
}

impl AutoRejoinIo for Scripted {
    async fn read_status(&mut self) -> anyhow::Result<TalkShowFacts> {
        self.reads += 1;
        self.statuses.pop_front().unwrap_or_else(|| Ok(talk(None)))
    }
    async fn resume(&mut self) -> anyhow::Result<TalkShowFacts> {
        self.resumes
            .pop_front()
            .unwrap_or_else(|| Err(anyhow::anyhow!("no answer")))
    }
    async fn sleep(&mut self, ms: u64) {
        self.slept.push(ms);
    }
    fn cancelled(&self) -> bool {
        self.cancel_after_reads
            .is_some_and(|after| self.reads >= after)
    }
    fn on_reconnecting(&mut self) {
        self.told += 1;
    }
}

#[tokio::test]
async fn the_rejoin_waits_for_the_controller_then_resumes() {
    let unrenewed = TalkShowFacts {
        controller: Some(ControllerFacts::default()),
        ..talk(None)
    };
    let mut io = Scripted::new(
        vec![
            Err(anyhow::anyhow!("not up")),
            Ok(unrenewed),
            Ok(talk(None)),
        ],
        vec![Ok(talk(Some(open_room(false))))],
    );
    let outcome = run_auto_rejoin(&held(), &mut io).await;
    assert!(matches!(outcome, AutoRejoinOutcome::Resumed(_)));
    assert_eq!(io.slept, vec![AUTO_REJOIN_WAIT_MS, AUTO_REJOIN_WAIT_MS]);
    assert_eq!(io.told, 1, "the host is told once");
}

#[tokio::test]
async fn the_rejoin_backs_off_twice_then_leaves_resume_to_the_host() {
    let mut io = Scripted::new(
        Vec::new(),
        vec![
            Err(anyhow::anyhow!("refused")),
            Ok(talk(None)),
            Err(anyhow::anyhow!("refused again")),
        ],
    );
    let outcome = run_auto_rejoin(&held(), &mut io).await;
    assert_eq!(
        outcome,
        AutoRejoinOutcome::Failed(AutoRejoinFailure::ResumeFailed(Some(
            "refused again".into()
        )))
    );
    assert_eq!(io.slept, AUTO_REJOIN_RETRY_MS.to_vec());
}

#[tokio::test]
async fn the_rejoin_ends_quietly_when_the_show_is_not_ours_or_is_gone() {
    let elsewhere = TalkShowFacts {
        stopped_by: Some("taken-over".into()),
        ..talk(None)
    };
    let mut io = Scripted::new(vec![Ok(elsewhere)], Vec::new());
    assert_eq!(
        run_auto_rejoin(&held(), &mut io).await,
        AutoRejoinOutcome::Stopped(AutoRejoinStop::Elsewhere)
    );
    // No show ever comes back: the waits run out and it ended meanwhile.
    let gone: Vec<anyhow::Result<TalkShowFacts>> = (0..=AUTO_REJOIN_WAITS)
        .map(|_| {
            Ok(TalkShowFacts {
                show: None,
                ..talk(None)
            })
        })
        .collect();
    let mut io = Scripted::new(gone, Vec::new());
    assert_eq!(
        run_auto_rejoin(&held(), &mut io).await,
        AutoRejoinOutcome::Stopped(AutoRejoinStop::ShowOver)
    );
    let mut io = Scripted::new(Vec::new(), Vec::new());
    io.cancel_after_reads = Some(1);
    assert_eq!(
        run_auto_rejoin(&held(), &mut io).await,
        AutoRejoinOutcome::Cancelled
    );
}
