//! Ported from `lib/guests-view.test.ts` and its fixtures
//! (`lib/guests-room-fixtures.ts`), case by case where the page has one.

use super::*;
use crate::guests::wire::{RoomGuest, RoomShown, TalkLimits};
use serde_json::Value;

const HOST: &str = "host:sh_talk";

fn allowance() -> AiCapabilitiesCloud {
    AiCapabilitiesCloud {
        enabled: true,
        seconds_per_month: 36_000,
        talk_shows: true,
        guests_on_stage: Some(5),
        room_size: Some(10),
        recording_retention_days: Some(30),
        ..AiCapabilitiesCloud::default()
    }
}

fn talk_status() -> CloudRoomFacts {
    CloudRoomFacts {
        entitled: true,
        plan: Some("max".into()),
        allowance: Some(allowance()),
        room: None,
        recording: None,
    }
}

fn participant(identity: &str, name: &str, role: RoomRole) -> RoomParticipant {
    RoomParticipant {
        identity: identity.into(),
        name: name.into(),
        role,
        on_stage: false,
        video: true,
        audio: true,
        muted: false,
        screen: false,
        quality: RoomQuality::Good,
        since_ms: 1000,
        away: false,
    }
}

fn open_room() -> RoomStatus {
    RoomStatus {
        phase: RoomPhase::Open,
        invite_url: Some("https://videorc.com/guest/k7m2Ab9xQp3rT5vW".into()),
        platforms: vec!["youtube".into(), "twitch".into()],
        participants: vec![RoomParticipant {
            on_stage: true,
            quality: RoomQuality::Excellent,
            ..participant(HOST, "OrcDev", RoomRole::Host)
        }],
        stage: Stage {
            layout: StageLayout::Solo,
            on_stage: vec![HOST.into()],
            ..Stage::default()
        },
        connected: true,
        limits: Some(TalkLimits {
            guests_on_stage: 5,
            room_size: 10,
            recording_retention_days: 30,
        }),
        stage_set: true,
        ..RoomStatus::default()
    }
}

fn ada() -> RoomGuest {
    RoomGuest {
        guest_id: "g_ada".into(),
        name: "Ada".into(),
        joined_at: "2026-11-09T10:00:00Z".into(),
        muted: false,
        screen_share_allowed: false,
    }
}

fn grace() -> RoomGuest {
    RoomGuest {
        guest_id: "g_grace".into(),
        name: "Grace".into(),
        joined_at: "2026-11-09T10:01:00Z".into(),
        muted: true,
        screen_share_allowed: true,
    }
}

#[test]
fn access_sells_premium_to_basic_and_says_not_yet_to_the_rollout() {
    let basic = CloudRoomFacts {
        entitled: false,
        plan: None,
        ..talk_status()
    };
    assert_eq!(
        guests_access(Some(&basic)),
        GuestsAccess::Locked {
            reason: GUESTS_PREMIUM_REASON,
            upsell: true
        }
    );
    let outside = CloudRoomFacts {
        entitled: false,
        ..talk_status()
    };
    assert_eq!(
        guests_access(Some(&outside)),
        GuestsAccess::Locked {
            reason: GUESTS_CLOUD_NOT_YET_REASON,
            upsell: false
        }
    );
    let no_talk = CloudRoomFacts {
        allowance: Some(AiCapabilitiesCloud {
            talk_shows: false,
            ..allowance()
        }),
        ..talk_status()
    };
    assert_eq!(
        guests_access(Some(&no_talk)),
        GuestsAccess::Locked {
            reason: GUESTS_NOT_YET_REASON,
            upsell: false
        }
    );
    assert_eq!(guests_access(Some(&talk_status())), GuestsAccess::Available);
    assert_eq!(
        guests_access(None::<&CloudRoomFacts>),
        GuestsAccess::Locked {
            reason: GUESTS_CLOUD_UNKNOWN_REASON,
            upsell: false
        }
    );
    // A room this computer holds stays operable.
    let holding = CloudRoomFacts {
        room: Some(open_room()),
        ..basic
    };
    assert_eq!(guests_access(Some(&holding)), GuestsAccess::Available);
}

#[test]
fn limits_read_the_open_room_first_then_the_allowance() {
    let room = CloudRoomFacts {
        room: Some(RoomStatus {
            limits: Some(TalkLimits {
                guests_on_stage: 1,
                room_size: 4,
                recording_retention_days: 7,
            }),
            ..open_room()
        }),
        ..talk_status()
    };
    assert_eq!(
        room_limits(Some(&room)),
        Some(RoomLimits {
            guests_on_stage: 1,
            room_size: 4
        })
    );
    let limits = room_limits(Some(&talk_status()));
    assert_eq!(
        limits,
        Some(RoomLimits {
            guests_on_stage: 5,
            room_size: 10
        })
    );
    assert_eq!(
        room_limits_line(limits).as_deref(),
        Some("Up to 5 guests on stage, 10 people in the room.")
    );
    assert_eq!(
        room_limits_line(room_limits(Some(&room))).as_deref(),
        Some(GUESTS_PREMIUM_SEAT_LINE)
    );
    assert_eq!(room_limits_line(None), None);
}

#[test]
fn the_consent_line_says_every_shared_fixture_line_word_for_word() {
    let path = format!(
        "{}/../../protocol-fixtures/guest-consent-lines.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let platforms: Vec<String> = case["platforms"]
            .as_array()
            .unwrap()
            .iter()
            .map(|platform| platform.as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            guest_consent_line(&platforms),
            case["line"].as_str().unwrap(),
            "{platforms:?}"
        );
    }
}

#[test]
fn a_guests_mic_reads_the_hold_first_then_what_the_runner_hears() {
    let on = participant("g", "G", RoomRole::Guest);
    let muted = RoomParticipant {
        muted: true,
        ..on.clone()
    };
    assert_eq!(guest_mic(true, Some(&on)), GuestMic::Held);
    assert_eq!(guest_mic(false, Some(&on)), GuestMic::On);
    assert_eq!(guest_mic(false, Some(&muted)), GuestMic::Off);
    assert_eq!(guest_mic(false, None), GuestMic::Unknown);
    assert_eq!(with_room_mic(GuestMic::On, true), GuestMic::Off);
    assert_eq!(with_room_mic(GuestMic::Held, true), GuestMic::Held);
    assert_eq!(
        guest_mic_status(GuestMic::Held, "Ada"),
        Some((
            GUEST_MIC_HELD,
            "Ada can't unmute until you let them.".to_string()
        ))
    );
    assert_eq!(
        guest_mic_status(GuestMic::Off, "Ada"),
        Some((GUEST_MIC_OFF, "Only Ada can turn their mic on.".to_string()))
    );
    assert_eq!(guest_mic_status(GuestMic::On, "Ada"), None);
    assert_eq!(unmute_hint("Ada"), "Ada can talk again once they unmute.");
}

#[test]
fn people_list_the_host_then_the_stage_then_backstage_never_the_runner() {
    let mut room = open_room();
    room.guests = vec![ada(), grace()];
    room.participants.push(RoomParticipant {
        quality: RoomQuality::Excellent,
        ..participant("runner:sh_talk", "runner", RoomRole::Guest)
    });
    room.participants.push(RoomParticipant {
        on_stage: true,
        muted: true,
        quality: RoomQuality::Poor,
        since_ms: 2000,
        ..participant("g_grace", "Grace", RoomRole::Guest)
    });
    room.stage = Stage {
        layout: StageLayout::SideBySide,
        on_stage: vec![HOST.into(), "g_grace".into()],
        ..Stage::default()
    };
    let people = room_people(Some(&room), Some(HOST), None);
    let names: Vec<&str> = people.iter().map(|person| person.name.as_str()).collect();
    assert_eq!(names, vec!["You", "Grace", "Ada"]);
    let staged: Vec<bool> = people.iter().map(|person| person.on_stage).collect();
    assert_eq!(staged, vec![true, true, false]);
    assert_eq!(people[1].guest_id.as_deref(), Some("g_grace"));
    assert_eq!(people[1].quality, Some(RoomQuality::Poor));
    assert!(people[1].muted);
    assert_eq!(people[2].quality, None);
    assert!(
        !people
            .iter()
            .any(|person| person.identity.starts_with("runner:"))
    );
    let closed = RoomStatus {
        phase: RoomPhase::Closed,
        ..room
    };
    assert!(room_people(Some(&closed), Some(HOST), None).is_empty());
}

#[test]
fn the_host_s_own_room_client_reading_replaces_the_web_s_constant() {
    let mut room = open_room();
    room.guests = vec![ada(), grace()];
    room.participants
        .push(participant("g_ada", "Ada", RoomRole::Guest));
    room.participants
        .push(participant("g_grace", "Grace", RoomRole::Guest));
    let live = RoomClientSnapshot {
        connected: true,
        local_quality: Some(RoomQuality::Excellent),
        people: vec![
            ("g_ada".into(), RoomQuality::Poor),
            ("g_grace".into(), RoomQuality::Lost),
        ],
    };
    let people = room_people(Some(&room), Some(HOST), Some(&live));
    let qualities: Vec<Option<RoomQuality>> = people.iter().map(|person| person.quality).collect();
    assert_eq!(
        qualities,
        vec![
            Some(RoomQuality::Excellent),
            Some(RoomQuality::Poor),
            Some(RoomQuality::Lost)
        ]
    );
    assert_eq!(
        quality_status(qualities[1]),
        (Tone::Warn, "Weak connection")
    );
    assert_eq!(
        quality_status(qualities[2]),
        (Tone::Error, "Connection lost")
    );
    // Not connected: no reading of anybody, the state stands.
    let away = RoomClientSnapshot::default();
    let people = room_people(Some(&room), Some(HOST), Some(&away));
    assert_eq!(people[1].quality, Some(RoomQuality::Good));
}

#[test]
fn the_mic_on_a_row_tells_the_hold_a_mic_still_off_and_talking_apart() {
    let mut room = open_room();
    room.guests = vec![ada(), grace()];
    room.participants
        .push(participant("g_ada", "Ada", RoomRole::Guest));
    room.participants
        .push(participant("g_grace", "Grace", RoomRole::Guest));
    let people = room_people(Some(&room), Some(HOST), None);
    let heard = Heard::default();
    assert_eq!(person_mic_view(&people[0], heard).label, MIC_QUIET);
    assert_eq!(
        person_mic_view(
            &people[0],
            Heard {
                local_mic_muted: true,
                ..heard
            }
        )
        .state,
        MicState::Muted
    );
    assert_eq!(
        person_mic_view(
            &people[1],
            Heard {
                speaking: true,
                ..heard
            }
        )
        .state,
        MicState::Talking
    );
    assert_eq!(
        person_mic_view(
            &people[1],
            Heard {
                room_mic_muted: true,
                ..heard
            }
        )
        .label,
        GUEST_MIC_OFF
    );
    assert_eq!(person_mic_view(&people[2], heard).state, MicState::Held);
    assert_eq!(mic_toggle_label(&people[2], false), "Let Grace unmute");
    assert_eq!(mic_toggle_label(&people[1], false), "Mute Ada");
    assert_eq!(mic_toggle_label(&people[0], true), "Unmute your microphone");
    let share = guest_screen_share(&people[2]);
    assert_eq!(share.state, ScreenShareState::Allowed);
    assert_eq!(share.action, ScreenShareAction::Disallow);
    assert_eq!(
        guest_screen_share(&people[1]).action_label,
        "Let Ada share their screen"
    );
}

#[test]
fn the_room_counts_against_its_size_and_the_stage_against_its_seats() {
    let mut room = open_room();
    room.guests = vec![ada(), grace()];
    room.stage.on_stage = vec![HOST.into(), "g_ada".into()];
    let people = room_people(Some(&room), Some(HOST), None);
    let one_seat = Some(RoomLimits {
        guests_on_stage: 1,
        room_size: 3,
    });
    assert!(room_is_full(&people, one_seat));
    assert_eq!(
        bring_on_blocked_reason(&people, one_seat).as_deref(),
        Some(GUESTS_PREMIUM_SEAT_LINE)
    );
    let roomy = Some(RoomLimits {
        guests_on_stage: 5,
        room_size: 10,
    });
    assert!(!room_is_full(&people, roomy));
    assert_eq!(bring_on_blocked_reason(&people, roomy), None);
    let full_stage = Some(RoomLimits {
        guests_on_stage: 1,
        room_size: 10,
    });
    assert!(!room_is_full(&people, full_stage));
    assert_eq!(
        bring_on_blocked_reason(
            &people,
            Some(RoomLimits {
                guests_on_stage: 2,
                room_size: 10
            })
        ),
        None
    );
}

#[test]
fn words_for_the_session_row_requests_and_confirms() {
    let mut room = open_room();
    room.guests = vec![ada(), grace()];
    room.stage.on_stage = vec![HOST.into(), "g_ada".into()];
    room.requests = vec![
        RoomRequest {
            request_id: "r1".into(),
            name: "Lin".into(),
            ..RoomRequest::default()
        },
        RoomRequest {
            request_id: "r2".into(),
            name: "Mo".into(),
            device: GuestDevice::Phone,
            ..RoomRequest::default()
        },
    ];
    let people = room_people(Some(&room), Some(HOST), None);
    assert_eq!(
        guests_session_value(Some(&room), &people),
        "Room open · 1 on stage · 1 backstage · 2 want to join"
    );
    assert_eq!(request_title(&room.requests[0]), "Lin wants to join");
    assert_eq!(request_device(&room.requests[1]), "On a phone");
    assert_eq!(declined_line(0), None);
    assert_eq!(declined_line(3).as_deref(), Some("3 more asked"));
    assert!(new_link_asks_first(Some(&room)));
    let facts = CloudRoomFacts {
        room: Some(room),
        ..talk_status()
    };
    assert!(close_room_asks_first(Some(&facts)));
    let empty = CloudRoomFacts {
        room: Some(open_room()),
        ..talk_status()
    };
    assert!(!close_room_asks_first(Some(&empty)));
    let recording = CloudRoomFacts {
        recording: Some(RecordingStatus {
            active: true,
            ..RecordingStatus::default()
        }),
        ..empty
    };
    assert!(close_room_asks_first(Some(&recording)));
    assert_eq!(room_phase_label(None), "Room closed");
    assert_eq!(remove_guest_copy("Ada").confirm, "Remove Ada");
    assert!(
        ban_guest_copy("Ada")
            .description
            .starts_with("Ada leaves the show")
    );
}

#[test]
fn renames_to_a_trimmed_1_to_32_characters_never_the_same_name() {
    assert_eq!(
        renamed_guest_name("Ada", "  Ada L ").as_deref(),
        Some("Ada L")
    );
    assert_eq!(renamed_guest_name("Ada", "Ada"), None);
    assert_eq!(renamed_guest_name("Ada", "   "), None);
    assert_eq!(renamed_guest_name("Ada", &"x".repeat(33)), None);
    assert_eq!(
        renamed_guest_name("Ada", &"x".repeat(32)).map(|name| name.len()),
        Some(32)
    );
}

#[test]
fn layout_chips_wait_on_a_screen_and_on_one_person() {
    let mut room = open_room();
    room.stage.on_stage = vec![HOST.into(), "g_ada".into()];
    let options = layout_options(Some(&room), false, 0);
    let reasons: Vec<(DrawnStageLayout, Option<&str>)> = options
        .iter()
        .map(|option| (option.value, option.disabled_reason))
        .collect();
    assert_eq!(
        reasons,
        vec![
            (DrawnStageLayout::Solo, Some(SOLO_NEEDS_ONE)),
            (DrawnStageLayout::SideBySide, None),
            (DrawnStageLayout::ScreenPeople, Some(SHARE_A_SCREEN_FIRST)),
            (DrawnStageLayout::Spotlight, None),
            (DrawnStageLayout::TwoScreens, Some(ONE_SCREEN_ON_THIS_SHOW)),
        ]
    );
    assert_eq!(
        layout_reasons_line(&options).as_deref(),
        Some(
            "Solo shows one person. Send the others backstage first. Share a screen first for Screen + people. This show puts one screen on the program."
        )
    );
    let managed = layout_options(Some(&room), true, 0);
    assert_eq!(
        layout_reasons_line(&managed).as_deref(),
        Some(
            "Solo shows one person. Send the others backstage first. Share a screen first for Screen + people and Two screens."
        )
    );
    assert_eq!(
        layout_options(Some(&room), true, 1)[4].disabled_reason,
        None
    );
}

#[test]
fn the_selected_layout_is_what_the_runner_draws() {
    let mut room = open_room();
    room.stage = Stage {
        layout: StageLayout::ScreenPeople,
        on_stage: vec![HOST.into(), "g_ada".into()],
        screen: Some("g_ada".into()),
        ..Stage::default()
    };
    assert_eq!(shown_layout(Some(&room)), DrawnStageLayout::ScreenPeople);
    assert_eq!(
        selected_layout(Some(&room), true),
        DrawnStageLayout::TwoScreens
    );
    room.stage.screens = vec!["g_ada".into(), HOST.into()];
    assert_eq!(shown_layout(Some(&room)), DrawnStageLayout::TwoScreens);
    // The runner shows no screen any more: Side by side, never a layout it won't draw.
    room.shown = Some(RoomShown {
        on_stage: vec![HOST.into(), "g_ada".into()],
        ..RoomShown::default()
    });
    assert_eq!(shown_layout(Some(&room)), DrawnStageLayout::SideBySide);
    assert_eq!(shown_layout(None), DrawnStageLayout::Solo);
}

#[test]
fn screens_cards_put_a_screen_on_and_take_it_off() {
    let mut room = open_room();
    room.guests = vec![ada()];
    room.participants.push(RoomParticipant {
        screen: true,
        on_stage: true,
        ..participant("g_ada", "Ada", RoomRole::Guest)
    });
    room.stage.on_stage = vec![HOST.into(), "g_ada".into()];
    let people = room_people(Some(&room), Some(HOST), None);
    let screens = room_screens(Some(&room), &people, true, false);
    let names: Vec<&str> = screens.iter().map(|screen| screen.name.as_str()).collect();
    assert_eq!(names, vec!["Your screen", "Ada's screen"]);
    let on = stage_with_screen_card(&room.stage, &screens[1], false);
    assert_eq!(on.layout, StageLayout::ScreenPeople);
    assert_eq!(on.screen.as_deref(), Some("g_ada"));
    let on_program = RoomScreen {
        on_program: true,
        ..screens[1].clone()
    };
    let off = stage_with_screen_card(&on, &on_program, false);
    assert_eq!(off.layout, StageLayout::SideBySide);
    assert_eq!(off.screen, None);
    let both = stage_with_screen_card(&on, &screens[0], true);
    assert_eq!(both.screens, vec!["g_ada".to_string(), HOST.to_string()]);
    // A backstage sharer is blocked.
    room.stage.on_stage = vec![HOST.into()];
    let people = room_people(Some(&room), Some(HOST), None);
    let blocked = room_screens(Some(&room), &people, false, false);
    assert_eq!(
        blocked[0].blocked_reason.as_deref(),
        Some("Bring Ada on first.")
    );
}

#[test]
fn the_output_profile_as_short_facts() {
    let profile: ManagedOutputProfile = serde_json::from_value(serde_json::json!({
        "version": 1,
        "effective": [
            { "orientation": "horizontal", "width": 1920, "height": 1080, "pictureFps": 30, "videoKbps": 6000, "differences": [] },
            { "orientation": "vertical", "width": 1080, "height": 1920, "pictureFps": 30, "videoKbps": 4500, "differences": ["bitrate"] }
        ]
    }))
    .unwrap();
    let chips = output_profile_chips(Some(&profile));
    assert_eq!(chips[0].facts, vec!["1920×1080", "30 fps", "6 Mbps"]);
    assert_eq!(chips[1].facts[2], "4.5 Mbps");
    assert!(chips[1].differs);
    assert!(output_profile_chips(None).is_empty());
}

#[test]
fn plural_agrees_and_groups_thousands() {
    assert_eq!(plural(1, "guest", None), "1 guest");
    assert_eq!(plural(5, "guest", None), "5 guests");
    assert_eq!(plural(1204, "person", Some("people")), "1,204 people");
}
