//! Ported from `shared/cloud-presentation-views.test.ts` (the shared
//! stage-key vectors in `protocol-fixtures/cloud-parity-views.json`) and
//! `lib/talk-show-managed.test.ts`'s preview cases.

use serde_json::Value;

use super::*;
use crate::guests::wire::{RoomParticipant, RoomPhase, RoomShown, RoomStatus};

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn keyed(value: &Value) -> KeyedStage {
    KeyedStage {
        host_shape: value["hostShape"].as_str().map(str::to_string),
        layout: value["layout"].as_str().unwrap_or_default().to_string(),
        on_stage: strings(&value["onStage"]),
        screen: value["screen"].as_str().map(str::to_string),
        screens: strings(&value["screens"]),
        spotlight: value["spotlight"].as_str().map(str::to_string),
    }
}

#[test]
fn the_stage_key_matches_the_shared_vectors() {
    let path = format!(
        "{}/../../protocol-fixtures/cloud-parity-views.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let stages = vectors["stages"].as_array().unwrap();
    assert!(!stages.is_empty());
    for one in stages {
        let name = one["name"].as_str().unwrap();
        let stage = keyed(&one["stage"]);
        assert_eq!(
            canonical_stage(&stage),
            one["canonical"].as_str().unwrap(),
            "{name}"
        );
        assert_eq!(stage_key(&stage), one["key"].as_str().unwrap(), "{name}");
        assert!(is_stage_key(&stage_key(&stage)));
    }
}

#[test]
fn rfc3339_times_read_as_date_parse_reads_them() {
    assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(
        parse_rfc3339_ms("2026-11-24T10:00:00.123Z"),
        Some(1_795_514_400_123)
    );
    assert_eq!(
        parse_rfc3339_ms("2026-11-24T11:00:00+01:00"),
        Some(1_795_514_400_000)
    );
    assert_eq!(
        parse_rfc3339_ms("2000-02-29T23:59:59.5Z"),
        Some(951_868_799_500)
    );
    assert_eq!(parse_rfc3339_ms("2026-13-01T00:00:00Z"), None);
    assert_eq!(parse_rfc3339_ms("yesterday"), None);
    assert_eq!(parse_rfc3339_ms("2026-11-24T10:00:00"), None);
}

#[test]
fn the_preview_says_how_sure_it_is() {
    let sent = KeyedStage {
        layout: "solo".into(),
        on_stage: vec!["host:show_1".into()],
        ..KeyedStage::default()
    };
    let key = stage_key(&sent);
    let at = "2026-11-24T10:00:00Z";
    let now = parse_rfc3339_ms(at).unwrap() + 2_000;
    let state = |running, sent: Option<&KeyedStage>, shown, now| {
        program_preview_stage(running, sent, shown, now).state
    };
    assert_eq!(
        state(false, Some(&sent), None, now),
        ProgramPreviewState::Empty
    );
    assert_eq!(
        state(true, Some(&sent), None, now),
        ProgramPreviewState::Waiting
    );
    let applied =
        program_preview_stage(true, Some(&sent), Some((Some(at), Some(key.as_str()))), now);
    assert_eq!(applied.state, ProgramPreviewState::Applied);
    assert_eq!(applied.age_ms, Some(2_000));
    assert_eq!(applied.applied_key.as_deref(), Some(key.as_str()));
    assert_eq!(
        state(true, Some(&sent), Some((Some(at), Some("0badc0de"))), now),
        ProgramPreviewState::Updating
    );
    assert_eq!(
        state(true, Some(&sent), Some((Some(at), Some("not-a-key"))), now),
        ProgramPreviewState::Unconfirmed
    );
    assert_eq!(
        state(true, Some(&sent), Some((None, Some(key.as_str()))), now),
        ProgramPreviewState::Unconfirmed
    );
    assert_eq!(
        state(
            true,
            Some(&sent),
            Some((Some(at), Some(key.as_str()))),
            now + 30_000
        ),
        ProgramPreviewState::Stale
    );
    assert_eq!(
        state(
            true,
            Some(&sent),
            Some((Some(at), Some(key.as_str()))),
            now - 10_000
        ),
        ProgramPreviewState::Unconfirmed
    );
    assert_eq!(
        state(true, None, Some((Some(at), Some(key.as_str()))), now),
        ProgramPreviewState::Unconfirmed
    );
}

fn managed_room(shown: Option<RoomShown>, live: bool) -> TalkShowFacts {
    TalkShowFacts {
        room: Some(RoomStatus {
            phase: RoomPhase::Open,
            live,
            participants: ["host:show_1", "g_ada"]
                .iter()
                .map(|identity| RoomParticipant {
                    identity: identity.to_string(),
                    ..RoomParticipant::default()
                })
                .collect(),
            stage: Stage {
                layout: StageLayout::SideBySide,
                on_stage: vec!["host:show_1".into(), "g_ada".into()],
                ..Stage::default()
            },
            shown,
            ..RoomStatus::default()
        }),
        ..TalkShowFacts::default()
    }
}

#[test]
fn the_managed_preview_and_the_agents_view_never_claim_more_than_the_page_said() {
    let at = "2026-11-24T10:00:00Z";
    let now = parse_rfc3339_ms(at).unwrap() + 1_000;
    let sent_key = stage_key(&KeyedStage::from(
        &managed_room(None, true).room.unwrap().stage,
    ));
    let shown = RoomShown {
        on_stage: vec!["host:show_1".into(), "g_ada".into()],
        layout: Some("side-by-side".into()),
        stage_key: Some(sent_key),
        at: Some(at.into()),
        ..RoomShown::default()
    };
    let status = managed_room(Some(shown), true);
    assert_eq!(
        managed_program_preview(Some(&status), now).state,
        ProgramPreviewState::Applied
    );
    let canvas = StageCanvas {
        width: 1920,
        height: 1080,
    };
    let program =
        agent_room_program(Some(&status), true, Some("host:show_1"), canvas, now).unwrap();
    assert_eq!(program.source, PROGRAM_PREVIEW_SOURCE);
    assert_eq!(program.stage, ProgramPreviewState::Applied);
    assert_eq!(program.age_seconds, Some(1));
    assert_eq!(program.layout, StageLayout::SideBySide);
    assert!(!program.screen_shared);
    assert_eq!(program.tiles.len(), 2);
    assert_eq!(program.tiles[0].role, AgentTileRole::Host);
    assert_eq!(program.tiles[1].role, AgentTileRole::Guest);
    assert!(
        program.tiles[0]
            .rect
            .iter()
            .all(|value| (0.0..=1.0).contains(value))
    );
    // Not managed, or nothing reported yet: no view, or no tiles.
    assert_eq!(
        agent_room_program(Some(&status), false, None, canvas, now),
        None
    );
    let waiting = managed_room(None, true);
    let program = agent_room_program(Some(&waiting), true, None, canvas, now).unwrap();
    assert_eq!(program.stage, ProgramPreviewState::Waiting);
    assert!(program.tiles.is_empty());
    let idle = managed_room(None, false);
    assert_eq!(
        managed_program_preview(Some(&idle), now).state,
        ProgramPreviewState::Empty
    );
}
