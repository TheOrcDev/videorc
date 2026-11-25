use serde_json::json;

use super::*;
use crate::livestream::cloud_show::{
    CONTINUE_HERE_LABEL, RECONNECTING_LABEL, RESUME_LABEL, RESUMING_LABEL,
};

fn alert(value: serde_json::Value) -> WatchdogAlert {
    serde_json::from_value(value).unwrap()
}

fn fix(kind: &str, label: &str) -> serde_json::Value {
    json!({ "kind": kind, "label": label })
}

#[test]
fn a_card_says_the_backends_words_with_its_fixes_and_quiet_button() {
    let down = alert(json!({
        "id": "a1", "check": "destination-down", "severity": "critical", "state": "open",
        "since": "2026-11-24T10:00:00Z", "title": "YouTube has been down for 0:20",
        "detail": "Viewers on YouTube see nothing.", "source": "cloud", "targetId": "yt",
        "fixes": [fix("reconnect-destination", "Reconnect"), fix("open-livestream", "Open Livestream")]
    }));
    let card = watchdog_card(&down, false);
    assert_eq!(card.tone, CardTone::Destructive);
    assert_eq!(card.title, "YouTube has been down for 0:20");
    assert_eq!(card.detail, "Viewers on YouTube see nothing.");
    assert_eq!(card.source_line, Some("Source: Videorc Cloud"));
    assert_eq!(
        card.primary_fix.as_ref().map(|f| f.label.as_str()),
        Some("Reconnect")
    );
    assert_eq!(card.more_fixes.len(), 1);
    assert_eq!(
        card.quiet,
        Some(QuietButton {
            label: "Got it",
            action: QuietAction::Acknowledge,
            enabled: true
        })
    );
    let snooze = card.snooze.unwrap();
    assert_eq!(snooze.label, "Snooze 10 min");
    assert_eq!(snooze.scope, SnoozeScope::TenMinutes);
    assert_eq!(snooze.menu_label, "More for YouTube has been down for 0:20");
}

#[test]
fn got_it_reads_seen_once_acknowledged_and_the_mute_says_i_meant_to() {
    let mut seen = alert(json!({
        "id": "a", "check": "program-silent", "severity": "warning", "state": "acknowledged",
        "title": "Viewers hear nothing", "source": "desktop"
    }));
    let card = watchdog_card(&seen, false);
    assert_eq!(card.tone, CardTone::Warning);
    assert_eq!(card.source_line, None);
    assert_eq!(
        card.quiet,
        Some(QuietButton {
            label: "Seen",
            action: QuietAction::Acknowledge,
            enabled: false
        })
    );
    seen.check = "mic-muted".into();
    seen.severity = "notice".into();
    let card = watchdog_card(&seen, false);
    assert_eq!(card.tone, CardTone::Default);
    assert_eq!(
        card.quiet,
        Some(QuietButton {
            label: "I meant to",
            action: QuietAction::Snooze(SnoozeScope::Stream),
            enabled: true
        })
    );
}

#[test]
fn the_compact_card_has_the_fixes_only() {
    let muted = alert(json!({
        "id": "a", "check": "mic-muted", "severity": "critical", "state": "open",
        "title": "Your microphone is muted", "fixes": [fix("unmute", "Unmute")]
    }));
    let card = watchdog_card(&muted, true);
    assert_eq!(card.primary_fix.map(|f| f.kind), Some("unmute".to_string()));
    assert_eq!(card.quiet, None);
    assert_eq!(card.snooze, None);
}

#[test]
fn the_cards_are_the_visible_alerts_and_the_silence_notice_holds_mic_silent() {
    let alerts = [
        alert(
            json!({ "id": "s", "check": "mic-silent", "severity": "warning", "state": "open",
            "since": "2026-11-24T10:00:00Z" }),
        ),
        alert(
            json!({ "id": "b", "check": "picture-black", "severity": "critical", "state": "open",
            "since": "2026-11-24T10:05:00Z" }),
        ),
        alert(
            json!({ "id": "z", "check": "no-voice", "severity": "critical", "state": "snoozed",
            "since": "2026-11-24T09:00:00Z" }),
        ),
    ];
    let ids = |cards: Vec<WatchdogCardView>| cards.into_iter().map(|c| c.id).collect::<Vec<_>>();
    assert_eq!(ids(watchdog_cards(&alerts, false)), ["b", "s"]);
    assert_eq!(ids(watchdog_cards(&alerts, true)), ["b"]);
}

#[test]
fn each_fix_names_the_studios_own_action() {
    let down = alert(json!({ "id": "a", "check": "destination-down", "targetId": "yt" }));
    let action =
        |kind: &str| watchdog_fix_action(&down, &serde_json::from_value(fix(kind, "x")).unwrap());
    assert_eq!(action("unmute"), Some(WatchdogFixAction::Unmute));
    assert_eq!(action("end-takeover"), Some(WatchdogFixAction::EndTakeover));
    assert_eq!(action("show-brb"), Some(WatchdogFixAction::OpenTakeovers));
    assert_eq!(action("switch-scene"), Some(WatchdogFixAction::OpenScenes));
    assert_eq!(action("open-audio"), Some(WatchdogFixAction::OpenAudio));
    assert_eq!(action("open-health"), Some(WatchdogFixAction::OpenHealth));
    assert_eq!(
        action("open-livestream"),
        Some(WatchdogFixAction::OpenLivestream)
    );
    assert_eq!(
        action("reconnect-destination"),
        Some(WatchdogFixAction::ReconnectDestination("yt".into()))
    );
    assert_eq!(action("open-platform-dashboard"), None, "no page, no door");
    assert_eq!(action("something-new"), None);
    let dashboard: WatchdogAlertFix = serde_json::from_value(json!({
        "kind": "open-platform-dashboard", "label": "Open YouTube Studio",
        "url": "https://studio.youtube.com"
    }))
    .unwrap();
    assert_eq!(
        watchdog_fix_action(&down, &dashboard),
        Some(WatchdogFixAction::OpenUrl(
            "https://studio.youtube.com".into()
        ))
    );
    let untargeted = alert(json!({ "id": "b", "check": "destination-down" }));
    assert_eq!(
        watchdog_fix_action(
            &untargeted,
            &serde_json::from_value(fix("reconnect-destination", "Reconnect")).unwrap()
        ),
        None
    );
}

fn cloud(value: serde_json::Value) -> CloudStatus {
    serde_json::from_value(value).unwrap()
}

fn resumable(kind: &str) -> CloudStatus {
    cloud(json!({
        "phase": "hold",
        "show": { "id": "show-1", "resumable": true, "kind": kind },
        "hold": { "active": true }
    }))
}

#[test]
fn a_solo_shows_resume_waits_for_go_lives_blocker() {
    let status = resumable("solo");
    let inputs = CloudResumeInputs {
        status: Some(&status),
        blocked_reason: Some("Pick a screen first."),
        ..CloudResumeInputs::default()
    };
    let card = cloud_resume_card(inputs).unwrap();
    assert_eq!(
        card.notice.title,
        "You're still live through Videorc Cloud."
    );
    assert_eq!(card.resume_label, RESUME_LABEL);
    assert!(!card.resume_enabled);
    assert_eq!(card.resume_hover.as_deref(), Some("Pick a screen first."));
    assert_eq!(card.resume_target, ResumeTarget::CloudShow);
    assert_eq!(card.end_label, "End livestream");
    assert!(card.end_enabled);

    let pending = cloud_resume_card(CloudResumeInputs {
        pending: true,
        ..inputs
    })
    .unwrap();
    assert_eq!(pending.resume_label, RESUMING_LABEL);
    assert_eq!(pending.resume_hover, None, "no hover while it starts");
    assert!(!pending.end_enabled);

    let free = cloud_resume_card(CloudResumeInputs {
        blocked_reason: None,
        ..inputs
    })
    .unwrap();
    assert!(free.resume_enabled);
}

#[test]
fn a_talk_show_rejoins_its_room_and_says_so_while_it_reconnects() {
    let status = resumable("talk");
    let inputs = CloudResumeInputs {
        status: Some(&status),
        blocked_reason: Some("Pick a screen first."),
        ..CloudResumeInputs::default()
    };
    let card = cloud_resume_card(inputs).unwrap();
    assert_eq!(card.resume_target, ResumeTarget::Room);
    assert!(card.resume_enabled, "no local source blocks a room");
    assert_eq!(card.resume_hover, None);

    let rejoining = cloud_resume_card(CloudResumeInputs {
        talk_rejoining: true,
        ..inputs
    })
    .unwrap();
    assert_eq!(rejoining.notice.title, "Reconnecting to your show…");
    assert_eq!(rejoining.resume_label, RECONNECTING_LABEL);
    assert!(!rejoining.resume_enabled);
    assert!(
        rejoining.end_enabled,
        "End livestream never waits for a rejoin"
    );
}

#[test]
fn a_show_on_another_device_continues_here_and_a_session_hides_the_notice() {
    let status = cloud(json!({
        "phase": "live",
        "show": { "id": "show-1", "resumable": false, "kind": "solo" },
        "onAir": { "name": "iPhone", "kind": "phone", "source": "camera", "thisDevice": false }
    }));
    let inputs = CloudResumeInputs {
        status: Some(&status),
        talk_rejoining: true,
        ..CloudResumeInputs::default()
    };
    let card = cloud_resume_card(inputs).unwrap();
    assert_eq!(card.notice.title, "Your show is live from iPhone.");
    assert_eq!(card.resume_label, CONTINUE_HERE_LABEL);
    assert!(
        cloud_resume_card(CloudResumeInputs {
            session_active: true,
            ..inputs
        })
        .is_none()
    );
    assert!(cloud_resume_card(CloudResumeInputs::default()).is_none());
}

#[test]
fn the_end_question_says_ending_and_waits() {
    let ask = end_cloud_show_question(false);
    assert_eq!(ask.title, "End livestream?");
    assert_eq!(
        ask.description,
        "The stream ends on every platform it's live on."
    );
    assert_eq!(ask.confirm_label, "End livestream");
    assert_eq!(ask.cancel_label, "Keep streaming");
    assert!(ask.enabled);
    let ending = end_cloud_show_question(true);
    assert_eq!(ending.confirm_label, "Ending…");
    assert!(!ending.enabled);
}

#[test]
fn an_open_room_replaces_the_preview_and_brings_its_outputs() {
    let status = cloud(json!({
        "phase": "live",
        "show": { "id": "show-7", "kind": "talk" },
        "room": { "phase": "open", "live": true, "connected": true, "doorOpen": true,
                  "hostAway": false, "declinedCount": 0, "stage": {} },
        "recording": { "active": true, "seconds": 42, "bytes": 1000, "since": "2026-11-24T10:00:00Z" }
    }));
    let room = talk_show_room(Some(&status));
    assert!(room.open && room.live && room.connected && room.door_open);
    assert!(room.preview_replaced && room.guests_row);
    assert_eq!(room.host_identity.as_deref(), Some("host:show-7"));
    assert_eq!(room.recording_seconds, 42);
    assert_eq!(
        room.transport_outputs(),
        Some(TalkShowOutputs {
            recording: true,
            live: true,
            stopping: false
        })
    );
    assert!(cloud_recording_active(Some(&status)));
}

#[test]
fn the_cloud_state_adds_stop_recordings_request_to_the_room() {
    let mut state = CloudState::default();
    state.status = Some(cloud(json!({
        "show": { "id": "show-7", "kind": "talk" },
        "room": { "phase": "open", "live": false },
        "recording": { "active": true }
    })));
    assert_eq!(
        talk_show_room_in(&state).transport_outputs(),
        Some(TalkShowOutputs {
            recording: true,
            live: false,
            stopping: false
        })
    );
    state.recording_stop_pending = true;
    let room = talk_show_room_in(&state);
    assert!(room.recording_stopping);
    assert_eq!(
        room,
        TalkShowRoomView {
            recording_stopping: true,
            ..talk_show_room(state.status.as_ref())
        }
    );
    assert!(room.transport_outputs().unwrap().stopping);
    assert!(!cloud_recording_active(None));
}

#[test]
fn a_room_that_is_not_open_leaves_the_preview_and_the_transport_alone() {
    let opening = cloud(json!({
        "show": { "id": "show-7", "kind": "talk" },
        "room": { "phase": "opening", "live": false },
        "recording": { "active": true }
    }));
    let room = talk_show_room(Some(&opening));
    assert_eq!(room.phase, "opening");
    assert!(!room.open && !room.preview_replaced && !room.guests_row);
    assert_eq!(room.host_identity, None);
    assert_eq!(room.transport_outputs(), None);
    let none = talk_show_room(None);
    assert_eq!(none.phase, "closed");
    assert_eq!(none.transport_outputs(), None);
    let unreadable = talk_show_room(Some(&cloud(json!({ "room": "nonsense" }))));
    assert_eq!(unreadable.phase, "closed");
}

#[test]
fn a_docked_preview_is_the_pane_with_no_header_or_card() {
    let docked = preview_stage(
        PreviewWindowState {
            open: true,
            mode: PreviewMode::Docked,
            always_on_top: false,
        },
        true,
        false,
    );
    assert!(docked.docked);
    assert_eq!(docked.section_title, None);
    assert!(docked.buttons.is_empty());
}

#[test]
fn a_floating_preview_offers_show_here_bring_to_front_close_and_keep_on_top() {
    let floating = preview_stage(
        PreviewWindowState {
            open: true,
            mode: PreviewMode::Floating,
            always_on_top: true,
        },
        true,
        false,
    );
    assert!(!floating.docked);
    assert_eq!(floating.section_title, Some("Preview"));
    let labels: Vec<_> = floating
        .buttons
        .iter()
        .map(|b| (b.label, b.action))
        .collect();
    assert_eq!(
        labels,
        [
            ("Show here", PreviewAction::Stick),
            ("Bring to front", PreviewAction::BringToFront),
            ("Close Preview", PreviewAction::Close),
        ]
    );
    assert_eq!(floating.keep_on_top, Some(true));
}

#[test]
fn a_closed_preview_opens_either_way_with_the_shortcut_on_the_remembered_one() {
    let closed = |mode| {
        preview_stage(
            PreviewWindowState {
                open: false,
                mode,
                always_on_top: false,
            },
            true,
            false,
        )
    };
    let docked = closed(PreviewMode::Docked);
    let shortcuts: Vec<_> = docked
        .buttons
        .iter()
        .map(|b| (b.label, b.action, b.shortcut))
        .collect();
    assert_eq!(
        shortcuts,
        [
            ("Show here", PreviewAction::OpenDocked, true),
            ("Open in its own window", PreviewAction::OpenFloating, false),
        ]
    );
    assert_eq!(docked.keep_on_top, None);
    let floating = closed(PreviewMode::Floating);
    assert!(!floating.buttons[0].shortcut && floating.buttons[1].shortcut);
}

#[test]
fn with_no_native_surface_the_card_opens_and_retries() {
    let stage = preview_stage(PreviewWindowState::default(), false, true);
    assert!(!stage.docked, "never docked without the surface");
    let actions: Vec<_> = stage.buttons.iter().map(|b| b.action).collect();
    assert_eq!(actions, [PreviewAction::Open, PreviewAction::Retry]);
    let open = preview_stage(
        PreviewWindowState {
            open: true,
            ..PreviewWindowState::default()
        },
        false,
        false,
    );
    assert!(open.buttons.is_empty());
}
