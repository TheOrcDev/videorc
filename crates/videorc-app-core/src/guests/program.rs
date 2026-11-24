//! The room's program: what differs on a managed talk show (plan 234 T3;
//! `lib/talk-show-managed.ts`), the room's avatar and graphics switches
//! (plan 249 S4, S9; `lib/room-program-opt-ins.ts`), and when system audio
//! starts off again on a new controller (plan 249 S8 on S24;
//! `lib/room-audio-routing.ts`'s `systemControllerStep`).

use std::collections::BTreeMap;

use serde::Deserialize;

use super::layout::{StageInput, shown_screens};
use super::session::{ControllerFacts, TalkShowFacts};
use super::view::Tone;
use super::wire::{RoomStatus, StageLayout};

/// `show.nodeId` of a show on managed media: LiveKit Cloud, no node of
/// ours (pinned to `protocol-fixtures/cloud-managed-wire.json`).
pub const MANAGED_NODE_ID: &str = "livekit";

/// The show is on managed media: no runner, so no return picture.
pub fn is_managed_show(node_id: Option<&str>) -> bool {
    node_id == Some(MANAGED_NODE_ID)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageMonitorState {
    /// Nothing is on air or recording yet.
    Empty,
    /// The show runs and no program page has reported a stage yet.
    Waiting,
    /// The stage, as the page draws it.
    Shown,
}

/// What the Program monitor shows (plan 234 D6): a node show's return, or
/// on a managed show the stage as the program page reports drawing it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgramMonitorView {
    Return,
    Stage(StageMonitorState),
}

pub fn program_monitor_view(
    status: Option<&TalkShowFacts>,
    node_id: Option<&str>,
) -> ProgramMonitorView {
    if !is_managed_show(node_id) {
        return ProgramMonitorView::Return;
    }
    let room = status.and_then(|status| status.room.as_ref());
    let running = room.is_some_and(|room| room.live)
        || status
            .and_then(|status| status.recording.as_ref())
            .is_some_and(|recording| recording.active);
    if !running {
        return ProgramMonitorView::Stage(StageMonitorState::Empty);
    }
    ProgramMonitorView::Stage(if room.is_some_and(|room| room.shown.is_some()) {
        StageMonitorState::Shown
    } else {
        StageMonitorState::Waiting
    })
}

/// The layout the page reports drawing, when it is one this desktop knows.
/// The page's `two-screens` is Screen + people on the wire (plan 251).
pub fn page_shown_layout(room: Option<&RoomStatus>) -> Option<StageLayout> {
    match room?.shown.as_ref()?.layout.as_deref()? {
        "solo" => Some(StageLayout::Solo),
        "side-by-side" => Some(StageLayout::SideBySide),
        "screen-people" | "two-screens" => Some(StageLayout::ScreenPeople),
        "spotlight" => Some(StageLayout::Spotlight),
        _ => None,
    }
}

/// The managed Program is the page's confirmed projection: never an
/// optimistic identity after it leaves the room. The layout is the one the
/// page drew when it says so; an older page does not, and the sent one
/// stands in.
pub fn managed_program_stage_input(room: Option<&RoomStatus>) -> StageInput {
    let members: Vec<&str> = room
        .map(|room| {
            room.participants
                .iter()
                .map(|participant| participant.identity.as_str())
                .collect()
        })
        .unwrap_or_default();
    let shown = room.and_then(|room| room.shown.as_ref());
    let people: Vec<String> = shown
        .map(|shown| {
            shown
                .on_stage
                .iter()
                .filter(|identity| members.contains(&identity.as_str()))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let screens: Vec<String> = shown
        .map(shown_screens)
        .unwrap_or_default()
        .into_iter()
        .filter(|identity| members.contains(&identity.as_str()))
        .collect();
    let spotlight = room
        .and_then(|room| room.stage.spotlight.clone())
        .filter(|spotlight| people.contains(spotlight));
    StageInput {
        layout: page_shown_layout(room)
            .or_else(|| room.map(|room| room.stage.layout))
            .unwrap_or_default(),
        people,
        on_stage: None,
        spotlight,
        screen: screens.first().cloned(),
        screens: if screens.len() == 2 {
            screens
        } else {
            Vec::new()
        },
    }
}

/// The program preview's states (plan 249 S6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgramPreviewState {
    Empty,
    Waiting,
    Applied,
    Updating,
    Unconfirmed,
    Stale,
}

/// Words for the preview's state: a short badge, and never "on air".
pub fn program_preview_copy(state: ProgramPreviewState) -> (Option<&'static str>, &'static str) {
    match state {
        ProgramPreviewState::Empty => (None, "Nothing is live or recording yet."),
        ProgramPreviewState::Waiting => (None, "Waiting for the program page to report its stage."),
        ProgramPreviewState::Applied => (
            Some("Confirmed"),
            "The program page reports drawing this stage. This preview is redrawn here.",
        ),
        ProgramPreviewState::Updating => (
            Some("Updating"),
            "The program page still draws an earlier stage. Your change is on its way.",
        ),
        ProgramPreviewState::Unconfirmed => (
            Some("Unconfirmed"),
            "The program page didn't say which stage it drew. This preview may differ.",
        ),
        ProgramPreviewState::Stale => (
            Some("Out of date"),
            "The program page has not reported for a while. This preview may be old.",
        ),
    }
}

/// Which output a guest-facing state belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProgramOutput {
    Stream,
    Recording,
}

/// The guest pages' graphics counts (plan 249 S6, D4).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GuestGraphics {
    pub enabled: bool,
    pub capable: u32,
    pub applied: u32,
}

/// What the guest row under the Program preview says. Never a claim about
/// encoded output.
pub fn guest_graphics_line(guests: Option<GuestGraphics>, output: Option<ProgramOutput>) -> String {
    let Some(guests) = guests.filter(|guests| guests.enabled) else {
        return "Guests don't see the avatar".to_string();
    };
    if output == Some(ProgramOutput::Recording) {
        return "Recording only · Guests see nothing".to_string();
    }
    if guests.capable == 0 {
        return "Shown to guests · No guest page confirmed".to_string();
    }
    if guests.applied == guests.capable {
        return "Guests see the avatar".to_string();
    }
    format!(
        "Shown to guests · {} of {} confirmed",
        guests.applied, guests.capable
    )
}

// --- The room's avatar and graphics switches (plan 249 S4, S9) ---------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct ObservedOutput {
    pub output: ProgramOutput,
}

/// The parts of a room avatar or graphics status these lines read.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct RoomProgramOptIn {
    pub enabled: bool,
    pub state: Option<String>,
    pub reason: Option<String>,
    /// Each output page's acknowledgement: which output applied it.
    pub observed: BTreeMap<String, ObservedOutput>,
}

fn applied_line(opt_in: &RoomProgramOptIn) -> &'static str {
    let has = |output| opt_in.observed.values().any(|entry| entry.output == output);
    match (has(ProgramOutput::Stream), has(ProgramOutput::Recording)) {
        (true, true) => "On the stream and the recording.",
        (false, true) => "On the recording.",
        (true, false) => "On the stream.",
        (false, false) => "On the program.",
    }
}

fn opt_in_status(opt_in: Option<&RoomProgramOptIn>) -> String {
    let Some(opt_in) = opt_in else {
        return "Not on the stream.".to_string();
    };
    if let Some(reason) = opt_in.reason.as_deref().filter(|reason| !reason.is_empty()) {
        return reason.to_string();
    }
    if opt_in.state.as_deref() == Some("applied") {
        return applied_line(opt_in).to_string();
    }
    if opt_in.enabled {
        return "On. Waiting for the stream to confirm.".to_string();
    }
    "Not on the stream.".to_string()
}

fn no_reason(opt_in: &RoomProgramOptIn) -> bool {
    opt_in.reason.as_deref().is_none_or(str::is_empty)
}

/// The room lets the avatar through, but its own switches keep it off every
/// output, or no avatar is worn.
fn avatar_off_by_its_own_switch(avatar: Option<&RoomProgramOptIn>) -> bool {
    avatar.is_some_and(|avatar| {
        avatar.enabled && avatar.state.as_deref() == Some("off") && no_reason(avatar)
    })
}

fn avatar_on(avatar: Option<&RoomProgramOptIn>) -> bool {
    avatar.is_some_and(|avatar| avatar.enabled) && !avatar_off_by_its_own_switch(avatar)
}

/// The Avatar switch's description in Guests → Room.
pub fn room_avatar_description(avatar: Option<&RoomProgramOptIn>) -> String {
    if avatar_off_by_its_own_switch(avatar) {
        return "Your avatar is off. Turn on its “on stream” switch in Stream Manager.".to_string();
    }
    opt_in_status(avatar)
}

/// The Graphics switch's description in Guests → Room. Captions and comment
/// cards reach the stream with the switch off too.
pub fn room_graphics_description(graphics: Option<&RoomProgramOptIn>) -> String {
    let state = if graphics.is_some_and(|graphics| graphics.enabled) {
        opt_in_status(graphics)
    } else {
        "Not on the stream.".to_string()
    };
    format!("Banners, timers and the chat box. {state}")
}

fn on_off(on: bool) -> &'static str {
    if on { "on" } else { "off" }
}

/// The Program preview's one line: "Avatar off · Graphics off".
pub fn room_program_summary(
    avatar: Option<&RoomProgramOptIn>,
    graphics: Option<&RoomProgramOptIn>,
) -> String {
    format!(
        "Avatar {} · Graphics {}",
        on_off(avatar_on(avatar)),
        on_off(graphics.is_some_and(|graphics| graphics.enabled))
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OptInChip {
    Avatar,
    Graphics,
}

/// The same two facts as chips on the Program card.
pub fn room_program_chips(
    avatar: Option<&RoomProgramOptIn>,
    graphics: Option<&RoomProgramOptIn>,
) -> [(OptInChip, String, bool); 2] {
    let avatar = avatar_on(avatar);
    let graphics = graphics.is_some_and(|graphics| graphics.enabled);
    [
        (
            OptInChip::Avatar,
            format!("Avatar {}", on_off(avatar)),
            avatar,
        ),
        (
            OptInChip::Graphics,
            format!("Graphics {}", on_off(graphics)),
            graphics,
        ),
    ]
}

/// An opt-in's state as a status dot: applied, waiting, refused or off.
pub fn room_opt_in_tone(opt_in: Option<&RoomProgramOptIn>) -> Tone {
    let Some(opt_in) = opt_in.filter(|opt_in| opt_in.enabled) else {
        return Tone::Neutral;
    };
    if !no_reason(opt_in) {
        return Tone::Error;
    }
    match opt_in.state.as_deref() {
        // On here, off by its own switch (the avatar): nothing is waiting.
        Some("off") => Tone::Neutral,
        Some("applied") => Tone::Good,
        _ => Tone::Warn,
    }
}

// --- System audio on a new controller (plan 249 S8 on S24) -------------------

/// System capture starts off on any new epoch after the first one seen, on
/// a first epoch that is a takeover, and whenever this computer lost the
/// show. The streamer turns it on again explicitly. Returns (disarm, the
/// epoch now seen).
pub fn system_controller_step(
    seen_epoch: u64,
    facts: Option<&ControllerFacts>,
    stopped_by: Option<&str>,
) -> (bool, u64) {
    if facts.is_some_and(|facts| facts.lost) || stopped_by.is_some() {
        return (true, seen_epoch);
    }
    let epoch = facts.map_or(0, |facts| facts.controller_epoch);
    if epoch == 0 || epoch == seen_epoch {
        return (false, seen_epoch);
    }
    let takeover = facts.is_some_and(|facts| facts.taken_over_from.is_some());
    (seen_epoch != 0 || takeover, epoch)
}

#[cfg(test)]
#[path = "program_tests.rs"]
mod tests;
