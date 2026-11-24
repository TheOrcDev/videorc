//! Plan 249 S6: the program preview's stage key and state
//! (`shared/cloud-presentation-views.ts`), and the managed show's preview
//! and agents' view of the program (`lib/talk-show-managed.ts`'s
//! `managedProgramPreview` and `agentRoomProgram`). A page's report is never
//! proof of encoded output.

use super::layout::{StageCanvas, StageTileKind, plan_stage};
use super::program::{ProgramPreviewState, managed_program_stage_input};
use super::session::TalkShowFacts;
use super::wire::{HostShape, Stage, StageLayout};

/// The stage as the program page reads it from room metadata.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeyedStage {
    pub host_shape: Option<String>,
    pub layout: String,
    pub on_stage: Vec<String>,
    pub screen: Option<String>,
    pub screens: Vec<String>,
    pub spotlight: Option<String>,
}

impl From<&Stage> for KeyedStage {
    fn from(stage: &Stage) -> Self {
        Self {
            host_shape: stage.host_shape.map(|shape| {
                match shape {
                    HostShape::Circle => "circle",
                    HostShape::Rounded => "rounded",
                }
                .to_string()
            }),
            layout: stage.layout.as_str().to_string(),
            on_stage: stage.on_stage.clone(),
            screen: stage.screen.clone(),
            screens: stage.screens.clone(),
            spotlight: stage.spotlight.clone(),
        }
    }
}

/// Plan 251: a stage's two screens as the page normalizes them, or none.
pub fn stage_screen_pair(stage: &KeyedStage, on_stage: &[String]) -> Vec<String> {
    let [first, second] = stage.screens.as_slice() else {
        return Vec::new();
    };
    if first == second || Some(first) != stage.screen.as_ref() {
        return Vec::new();
    }
    if on_stage.contains(first) && on_stage.contains(second) {
        vec![first.clone(), second.clone()]
    } else {
        Vec::new()
    }
}

/// The canonical form both sides hash: the page's own normalization.
pub fn canonical_stage(stage: &KeyedStage) -> String {
    let mut on_stage: Vec<String> = Vec::new();
    for identity in &stage.on_stage {
        if !on_stage.contains(identity) {
            on_stage.push(identity.clone());
        }
    }
    let named = |identity: &Option<String>| -> String {
        identity
            .as_ref()
            .filter(|identity| !identity.is_empty() && on_stage.contains(identity))
            .cloned()
            .unwrap_or_default()
    };
    let shape = if stage.host_shape.as_deref() == Some("circle") {
        "circle"
    } else {
        "rounded"
    };
    let pair = stage_screen_pair(stage, &on_stage);
    let mut parts = vec![
        "v1".to_string(),
        stage.layout.clone(),
        shape.to_string(),
        on_stage.join(","),
        named(&stage.spotlight),
        named(&stage.screen),
    ];
    // Plan 251: only a stage with two screens has this part.
    if pair.len() == 2 {
        parts.push(pair.join(","));
    }
    parts.join("|")
}

/// FNV-1a 32 over UTF-16 code units, as 8 lowercase hex digits.
pub fn stage_key(stage: &KeyedStage) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in canonical_stage(stage).encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

fn is_stage_key(key: &str) -> bool {
    key.len() == 8
        && key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The web drops a page's report after this long.
pub const PROGRAM_PREVIEW_STALE_MS: i64 = 25_000;
/// A report time this far ahead of the desktop clock is not trusted.
const CLOCK_AHEAD_LIMIT_MS: i64 = 5_000;

/// `Date.parse` for the RFC 3339 times the web writes
/// ("2026-11-24T10:00:00.123Z", or with an offset): epoch milliseconds.
pub fn parse_rfc3339_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = text.get(range)?;
        (!part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| part.parse().ok())
            .flatten()
    };
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b't')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut index = 19;
    let mut millis = 0;
    if bytes.get(index) == Some(&b'.') {
        let start = index + 1;
        let mut end = start;
        while bytes.get(end).is_some_and(u8::is_ascii_digit) {
            end += 1;
        }
        if end == start {
            return None;
        }
        let digits = &text[start..end.min(start + 3)];
        millis = digits.parse::<i64>().ok()? * 10_i64.pow(3 - digits.len() as u32);
        index = end;
    }
    let offset_minutes = match bytes.get(index)? {
        b'Z' | b'z' if index + 1 == bytes.len() => 0,
        sign @ (b'+' | b'-') if index + 6 == bytes.len() && bytes[index + 3] == b':' => {
            let hours = number(index + 1..index + 3)?;
            let minutes = number(index + 4..index + 6)?;
            let total = hours * 60 + minutes;
            if *sign == b'-' { -total } else { total }
        }
        _ => return None,
    };
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1_000 + millis)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgramPreviewStage {
    pub state: ProgramPreviewState,
    /// How old the report is, when the page dated it.
    pub age_ms: Option<i64>,
    /// The key the page applied, when it gave one.
    pub applied_key: Option<String>,
}

/// What the Program preview may say about the stage it draws.
pub fn program_preview_stage(
    running: bool,
    sent: Option<&KeyedStage>,
    shown: Option<(Option<&str>, Option<&str>)>,
    now_ms: i64,
) -> ProgramPreviewStage {
    let result = |state, age_ms, applied_key: Option<&str>| ProgramPreviewStage {
        state,
        age_ms,
        applied_key: applied_key.map(str::to_string),
    };
    if !running {
        return result(ProgramPreviewState::Empty, None, None);
    }
    let Some((at, key)) = shown else {
        return result(ProgramPreviewState::Waiting, None, None);
    };
    let at = at.and_then(parse_rfc3339_ms);
    let (Some(key), Some(at)) = (key.filter(|key| is_stage_key(key)), at) else {
        return result(ProgramPreviewState::Unconfirmed, None, None);
    };
    let age = now_ms - at;
    if age < -CLOCK_AHEAD_LIMIT_MS {
        return result(ProgramPreviewState::Unconfirmed, None, Some(key));
    }
    let age_ms = age.max(0);
    if age_ms > PROGRAM_PREVIEW_STALE_MS {
        return result(ProgramPreviewState::Stale, Some(age_ms), Some(key));
    }
    let Some(sent) = sent else {
        return result(ProgramPreviewState::Unconfirmed, Some(age_ms), Some(key));
    };
    let state = if stage_key(sent) == key {
        ProgramPreviewState::Applied
    } else {
        ProgramPreviewState::Updating
    };
    result(state, Some(age_ms), Some(key))
}

fn running(status: &TalkShowFacts) -> bool {
    status.room.as_ref().is_some_and(|room| room.live)
        || status
            .recording
            .as_ref()
            .is_some_and(|recording| recording.active)
}

/// Whether the managed Program preview draws the stage this desktop sent,
/// as the program page itself reports it.
pub fn managed_program_preview(status: Option<&TalkShowFacts>, now_ms: i64) -> ProgramPreviewStage {
    let room = status.and_then(|status| status.room.as_ref());
    let sent = room.map(|room| KeyedStage::from(&room.stage));
    let shown = room
        .and_then(|room| room.shown.as_ref())
        .map(|shown| (shown.at.as_deref(), shown.stage_key.as_deref()));
    program_preview_stage(status.is_some_and(running), sent.as_ref(), shown, now_ms)
}

/// `VIEW_SOURCE['program-preview']`: a page's report, never the encoded program.
pub const PROGRAM_PREVIEW_SOURCE: &str = "program-page-report";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentTileRole {
    Host,
    Guest,
}

/// A tile in canvas fractions, rounded to four decimals.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentTile {
    pub kind: StageTileKind,
    pub role: AgentTileRole,
    pub rect: [f64; 4],
}

/// The agents' view of the program, by allowlist: roles and geometry, no
/// identities or names. Never encoded output.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentRoomProgram {
    pub source: &'static str,
    pub stage: ProgramPreviewState,
    pub age_seconds: Option<i64>,
    pub layout: StageLayout,
    pub screen_shared: bool,
    pub tiles: Vec<AgentTile>,
}

/// Only for a managed show with a room.
pub fn agent_room_program(
    status: Option<&TalkShowFacts>,
    managed: bool,
    host_identity: Option<&str>,
    canvas: StageCanvas,
    now_ms: i64,
) -> Option<AgentRoomProgram> {
    let room = status.and_then(|status| status.room.as_ref())?;
    if !managed {
        return None;
    }
    let preview = managed_program_preview(status, now_ms);
    let input = managed_program_stage_input(Some(room));
    let plan = plan_stage(canvas, &input);
    let round = |value: f64| (value * 10_000.0).round() / 10_000.0;
    let fraction = |value: i64, total: i64| round(value as f64 / total as f64);
    let hidden = matches!(
        preview.state,
        ProgramPreviewState::Empty | ProgramPreviewState::Waiting
    );
    Some(AgentRoomProgram {
        source: PROGRAM_PREVIEW_SOURCE,
        stage: preview.state,
        age_seconds: preview
            .age_ms
            .map(|age| (age as f64 / 1_000.0).round() as i64),
        layout: input.layout,
        screen_shared: plan.iter().any(|tile| tile.kind == StageTileKind::Screen),
        tiles: if hidden {
            Vec::new()
        } else {
            plan.iter()
                .map(|tile| AgentTile {
                    kind: tile.kind,
                    role: if host_identity == Some(tile.identity.as_str()) {
                        AgentTileRole::Host
                    } else {
                        AgentTileRole::Guest
                    },
                    rect: [
                        fraction(tile.rect.x, canvas.width),
                        fraction(tile.rect.y, canvas.height),
                        fraction(tile.rect.w, canvas.width),
                        fraction(tile.rect.h, canvas.height),
                    ],
                })
                .collect()
        },
    })
}

#[cfg(test)]
#[path = "presentation_tests.rs"]
mod tests;
