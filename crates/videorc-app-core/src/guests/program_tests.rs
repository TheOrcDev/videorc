//! Ported from `lib/talk-show-managed.test.ts`, `lib/room-program-opt-ins.test.ts`
//! and `lib/room-audio-routing.test.ts`'s controller cases.

use super::*;
use crate::guests::session::ShowFacts;
use crate::guests::wire::{RecordingStatus, RoomParticipant, RoomPhase, RoomShown, Stage};

fn room(shown: Option<RoomShown>) -> RoomStatus {
    RoomStatus {
        phase: RoomPhase::Open,
        participants: ["host:sh", "g_ada", "g_bo"]
            .iter()
            .map(|identity| RoomParticipant {
                identity: identity.to_string(),
                ..RoomParticipant::default()
            })
            .collect(),
        stage: Stage {
            layout: StageLayout::SideBySide,
            on_stage: vec!["host:sh".into(), "g_ada".into()],
            spotlight: Some("g_ada".into()),
            ..Stage::default()
        },
        shown,
        ..RoomStatus::default()
    }
}

fn facts(room: RoomStatus, recording: bool) -> TalkShowFacts {
    TalkShowFacts {
        show: Some(ShowFacts {
            id: "sh_talk".into(),
            ..ShowFacts::default()
        }),
        room: Some(room),
        recording: Some(RecordingStatus {
            active: recording,
            ..RecordingStatus::default()
        }),
        ..TalkShowFacts::default()
    }
}

#[test]
fn a_node_show_watches_its_return_and_a_managed_one_the_reported_stage() {
    let idle = facts(room(None), false);
    assert_eq!(
        program_monitor_view(Some(&idle), Some("node-1")),
        ProgramMonitorView::Return
    );
    assert_eq!(
        program_monitor_view(Some(&idle), Some(MANAGED_NODE_ID)),
        ProgramMonitorView::Stage(StageMonitorState::Empty)
    );
    let running = facts(room(None), true);
    assert_eq!(
        program_monitor_view(Some(&running), Some(MANAGED_NODE_ID)),
        ProgramMonitorView::Stage(StageMonitorState::Waiting)
    );
    let shown = facts(room(Some(RoomShown::default())), true);
    assert_eq!(
        program_monitor_view(Some(&shown), Some(MANAGED_NODE_ID)),
        ProgramMonitorView::Stage(StageMonitorState::Shown)
    );
}

#[test]
fn the_managed_program_is_the_pages_confirmed_projection() {
    let shown = RoomShown {
        on_stage: vec!["g_ada".into(), "g_gone".into()],
        screens: vec!["g_ada".into(), "g_gone".into()],
        layout: Some("two-screens".into()),
        ..RoomShown::default()
    };
    let input = managed_program_stage_input(Some(&room(Some(shown))));
    assert_eq!(input.layout, StageLayout::ScreenPeople);
    assert_eq!(input.people, vec!["g_ada".to_string()]);
    assert_eq!(input.screen.as_deref(), Some("g_ada"));
    assert!(input.screens.is_empty());
    assert_eq!(input.spotlight.as_deref(), Some("g_ada"));
    // An older page names no layout: the sent one stands in.
    let older = managed_program_stage_input(Some(&room(Some(RoomShown {
        on_stage: vec!["host:sh".into()],
        ..RoomShown::default()
    }))));
    assert_eq!(older.layout, StageLayout::SideBySide);
    assert_eq!(older.spotlight, None);
    assert_eq!(managed_program_stage_input(None), StageInput::default());
}

#[test]
fn the_preview_and_guest_lines_never_claim_encoded_output() {
    assert_eq!(
        program_preview_copy(ProgramPreviewState::Applied).0,
        Some("Confirmed")
    );
    assert_eq!(program_preview_copy(ProgramPreviewState::Empty).0, None);
    let guests = |capable, applied| {
        Some(GuestGraphics {
            enabled: true,
            capable,
            applied,
        })
    };
    assert_eq!(
        guest_graphics_line(None, None),
        "Guests don't see the avatar"
    );
    assert_eq!(
        guest_graphics_line(guests(2, 0), Some(ProgramOutput::Recording)),
        "Recording only · Guests see nothing"
    );
    assert_eq!(
        guest_graphics_line(guests(0, 0), None),
        "Shown to guests · No guest page confirmed"
    );
    assert_eq!(
        guest_graphics_line(guests(2, 2), None),
        "Guests see the avatar"
    );
    assert_eq!(
        guest_graphics_line(guests(3, 1), None),
        "Shown to guests · 1 of 3 confirmed"
    );
}

fn opt_in(enabled: bool, state: Option<&str>, reason: Option<&str>) -> RoomProgramOptIn {
    RoomProgramOptIn {
        enabled,
        state: state.map(str::to_string),
        reason: reason.map(str::to_string),
        observed: BTreeMap::new(),
    }
}

#[test]
fn the_room_switches_say_what_the_stream_gets() {
    let mut applied = opt_in(true, Some("applied"), None);
    applied.observed.insert(
        "page-1".into(),
        ObservedOutput {
            output: ProgramOutput::Stream,
        },
    );
    applied.observed.insert(
        "page-2".into(),
        ObservedOutput {
            output: ProgramOutput::Recording,
        },
    );
    assert_eq!(
        room_avatar_description(Some(&applied)),
        "On the stream and the recording."
    );
    let own_switch = opt_in(true, Some("off"), None);
    assert_eq!(
        room_avatar_description(Some(&own_switch)),
        "Your avatar is off. Turn on its “on stream” switch in Stream Manager."
    );
    assert_eq!(
        room_avatar_description(Some(&opt_in(true, None, None))),
        "On. Waiting for the stream to confirm."
    );
    assert_eq!(
        room_avatar_description(Some(&opt_in(true, None, Some("Wear an avatar first.")))),
        "Wear an avatar first."
    );
    assert_eq!(
        room_graphics_description(None),
        "Banners, timers and the chat box. Not on the stream."
    );
    assert_eq!(
        room_program_summary(Some(&own_switch), Some(&applied)),
        "Avatar off · Graphics on"
    );
    let chips = room_program_chips(Some(&applied), None);
    assert_eq!(chips[0], (OptInChip::Avatar, "Avatar on".to_string(), true));
    assert_eq!(
        chips[1],
        (OptInChip::Graphics, "Graphics off".to_string(), false)
    );
    assert_eq!(room_opt_in_tone(None), Tone::Neutral);
    assert_eq!(
        room_opt_in_tone(Some(&opt_in(true, None, Some("refused")))),
        Tone::Error
    );
    assert_eq!(room_opt_in_tone(Some(&own_switch)), Tone::Neutral);
    assert_eq!(room_opt_in_tone(Some(&applied)), Tone::Good);
    assert_eq!(
        room_opt_in_tone(Some(&opt_in(true, None, None))),
        Tone::Warn
    );
}

#[test]
fn system_audio_starts_off_on_a_new_controller_and_on_a_lost_show() {
    let controller = |epoch, takeover: Option<&str>, lost| ControllerFacts {
        controller_epoch: epoch,
        taken_over_from: takeover.map(str::to_string),
        lost,
    };
    // The first epoch seen arms nothing; the same epoch neither.
    assert_eq!(
        system_controller_step(0, Some(&controller(1, None, false)), None),
        (false, 1)
    );
    assert_eq!(
        system_controller_step(1, Some(&controller(1, None, false)), None),
        (false, 1)
    );
    // A new epoch after the first, or a first that is a takeover, disarms.
    assert_eq!(
        system_controller_step(1, Some(&controller(2, None, false)), None),
        (true, 2)
    );
    assert_eq!(
        system_controller_step(0, Some(&controller(1, Some("this-device"), false)), None),
        (true, 1)
    );
    // Lost, or stopped by a hand-off: disarm, the epoch kept.
    assert_eq!(
        system_controller_step(3, Some(&controller(4, None, true)), None),
        (true, 3)
    );
    assert_eq!(system_controller_step(3, None, Some("hand-off")), (true, 3));
    assert_eq!(system_controller_step(3, None, None), (false, 3));
}
