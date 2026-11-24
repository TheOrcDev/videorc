//! What the Guests page and the Show stage say about the room (plan 224
//! C-G2, C-G3; `lib/guests-view.ts`), derived from the backend's
//! `CloudStatus.room`. Pure, so every line of copy is a test. Copy rules
//! (plan 224 "Words we use"): guest, never participant; Let in and Decline;
//! Bring on and Send backstage; the runner is never a person.

use serde::Deserialize;
use videorc_protocol::AiCapabilitiesCloud;

use super::layout::{effective_stage_layout, show_stage_input};
use super::stage_screens::{
    ONE_SCREEN_ON_THIS_SHOW, STAGE_MAX_SCREENS, TWO_SCREENS_AT_MOST, remove_screen, screens_of,
    toggle_stage_screen, with_stage_screens,
};
use super::wire::{
    DrawnStageLayout, GuestDevice, RecordingStatus, RoomParticipant, RoomPhase, RoomQuality,
    RoomRequest, RoomRole, RoomStatus, Stage, StageLayout,
};

/// What the Guests page reads from `CloudStatus`. S1.6c's
/// `livestream::cloud_status::CloudStatus` implements it once its stack is
/// on `main`; [`CloudRoomFacts`] is the plain form until then and in tests.
pub trait CloudFacts {
    /// The account's `cloud` block says on.
    fn entitled(&self) -> bool;
    /// `premium` or `max`, whether or not the account's cloud is on.
    fn plan(&self) -> Option<&str>;
    fn allowance(&self) -> Option<&AiCapabilitiesCloud>;
    fn room(&self) -> Option<&RoomStatus>;
    fn recording(&self) -> Option<&RecordingStatus>;
}

/// [`CloudFacts`] as plain values.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CloudRoomFacts {
    pub entitled: bool,
    pub plan: Option<String>,
    pub allowance: Option<AiCapabilitiesCloud>,
    pub room: Option<RoomStatus>,
    pub recording: Option<RecordingStatus>,
}

impl CloudFacts for CloudRoomFacts {
    fn entitled(&self) -> bool {
        self.entitled
    }
    fn plan(&self) -> Option<&str> {
        self.plan.as_deref()
    }
    fn allowance(&self) -> Option<&AiCapabilitiesCloud> {
        self.allowance.as_ref()
    }
    fn room(&self) -> Option<&RoomStatus> {
        self.room.as_ref()
    }
    fn recording(&self) -> Option<&RecordingStatus> {
        self.recording.as_ref()
    }
}

/// `plural` from `lib/format.ts`: "1 guest", "5 guests", "1,204 people".
/// A stand-in until L4's `crate::format::plural` (#1757) is on `main`.
pub(crate) fn plural(count: u32, one: &str, many: Option<&str>) -> String {
    let digits = count.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    let noun = if count == 1 {
        one.to_string()
    } else {
        many.map_or_else(|| format!("{one}s"), str::to_string)
    };
    format!("{grouped} {noun}")
}

// --- Locks (C-G2, D15) -------------------------------------------------------

/// D15 B (plan 221 U3): the one lock sentence for talk shows.
pub const GUESTS_PREMIUM_REASON: &str = "Talk shows with guests come with Videorc Premium.";
/// A paid plan whose cloud isn't on yet (the rollout switch, the cohort).
pub const GUESTS_CLOUD_NOT_YET_REASON: &str = "Videorc Cloud isn't on for your account yet.";
/// A paid plan whose allowance has no talk shows yet (D15 B: the rollout).
pub const GUESTS_NOT_YET_REASON: &str = "Talk shows aren't on for your account yet.";
/// The backend never answered with the cloud's state (an older backend).
pub const GUESTS_CLOUD_UNKNOWN_REASON: &str = "Videorc can't check Videorc Cloud right now.";
/// D15 B: Premium's extra lock, the stage's one seat.
pub const GUESTS_PREMIUM_SEAT_LINE: &str =
    "Up to 1 guest on stage with Premium. Videorc Max seats 5.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuestsAccess {
    Available,
    Locked { reason: &'static str, upsell: bool },
}

/// Whether this account can open a room, and the one reason when it can't.
pub fn guests_access(status: Option<&impl CloudFacts>) -> GuestsAccess {
    let Some(status) = status else {
        return GuestsAccess::Locked {
            reason: GUESTS_CLOUD_UNKNOWN_REASON,
            upsell: false,
        };
    };
    // A room this computer holds stays operable whatever the account says now.
    if status
        .room()
        .is_some_and(|room| room.phase != RoomPhase::Closed)
    {
        return GuestsAccess::Available;
    }
    if !status.entitled() {
        return if status.plan().is_some_and(|plan| !plan.is_empty()) {
            GuestsAccess::Locked {
                reason: GUESTS_CLOUD_NOT_YET_REASON,
                upsell: false,
            }
        } else {
            GuestsAccess::Locked {
                reason: GUESTS_PREMIUM_REASON,
                upsell: true,
            }
        };
    }
    // D15 B: every paid plan has talk shows, so an allowance without them is
    // the rollout, never an upsell.
    if status
        .allowance()
        .is_some_and(|allowance| !allowance.talk_shows)
    {
        return GuestsAccess::Locked {
            reason: GUESTS_NOT_YET_REASON,
            upsell: false,
        };
    }
    GuestsAccess::Available
}

// --- Limits (D15) ------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoomLimits {
    pub guests_on_stage: u32,
    pub room_size: u32,
}

/// The room's limits while it is open, else the account's allowance.
pub fn room_limits(status: Option<&impl CloudFacts>) -> Option<RoomLimits> {
    let status = status?;
    if let Some(limits) = status.room().and_then(|room| room.limits) {
        return Some(RoomLimits {
            guests_on_stage: limits.guests_on_stage,
            room_size: limits.room_size,
        });
    }
    let allowance = status.allowance()?;
    Some(RoomLimits {
        guests_on_stage: allowance.guests_on_stage?,
        room_size: allowance.room_size?,
    })
}

/// "Up to 5 guests on stage, 10 people in the room.", or Premium's one seat.
pub fn room_limits_line(limits: Option<RoomLimits>) -> Option<String> {
    let limits = limits.filter(|limits| limits.guests_on_stage > 0)?;
    if limits.guests_on_stage == 1 {
        return Some(GUESTS_PREMIUM_SEAT_LINE.to_string());
    }
    Some(format!(
        "Up to {} on stage, {} in the room.",
        plural(limits.guests_on_stage, "guest", None),
        plural(limits.room_size, "person", Some("people"))
    ))
}

// --- The room (C-G2, D17) ------------------------------------------------------

pub const OPEN_THE_ROOM_LABEL: &str = "Open the room";
pub const CLOSE_THE_ROOM_LABEL: &str = "Close the room";
pub const ROOM_BACKSTAGE_TIME_LINE: &str = "Backstage time counts after 30 min";
pub const DOOR_SWITCH_LABEL: &str = "Let anyone with the link in backstage";
pub const DOOR_SWITCH_DESCRIPTION: &str = "Nobody reaches the stage without Bring on.";
pub const OPEN_THE_ROOM_FIRST: &str = "Open the room first.";
/// The camera is the session's while it records or streams (D6).
pub const ROOM_WAITS_FOR_SESSION: &str = "The room opens once your recording or livestream ends.";
/// The Studio's Scenes while the room is open: the stage's layouts are the
/// show's picture.
pub const SCENES_OFF_WHILE_ROOM_OPEN: &str =
    "Scenes are off while the room is open. Pick a layout on the Show stage.";
pub const CLOSE_ROOM_CONFIRM_DESCRIPTION: &str = "Your guests leave and the recording finalizes.";
pub const NEW_LINK_CONFIRM_DESCRIPTION: &str =
    "Everyone keeps their place. The old link stops working.";
pub const NEW_LINK_AFTER_BAN: &str = "New link. Share it again with your guests.";
pub const NOBODY_YET: &str = "Nobody has joined yet. Share the link.";
pub const NOBODY_BACKSTAGE: &str = "Nobody is backstage. Guests join from the invite link.";
pub const ROOM_FULL_LINE: &str = "The room is full. New guests read “This show is full.”";

/// The room's state in a word, for the Room row and the Studio's Session row.
pub fn room_phase_label(room: Option<&RoomStatus>) -> &'static str {
    match room.map(|room| room.phase) {
        Some(RoomPhase::Open) => "Room open",
        Some(RoomPhase::Opening) => "Opening the room…",
        Some(RoomPhase::Closing) => "Closing the room…",
        _ => "Room closed",
    }
}

/// Close the room asks first while anyone is in it, or the show runs (D17).
pub fn close_room_asks_first(status: Option<&impl CloudFacts>) -> bool {
    let Some(status) = status else {
        return false;
    };
    let Some(room) = status.room().filter(|room| room.phase == RoomPhase::Open) else {
        return false;
    };
    room.live
        || status.recording().is_some_and(|recording| recording.active)
        || !room.guests.is_empty()
        || !room.requests.is_empty()
}

/// New link asks first while any guest is in the room (C-G2).
pub fn new_link_asks_first(room: Option<&RoomStatus>) -> bool {
    room.is_some_and(|room| !room.guests.is_empty())
}

/// The platform names in D13's line, as the guest page writes them; any
/// other value is left out.
fn consent_platform_name(platform: &str) -> Option<&'static str> {
    Some(match platform {
        "youtube" => "YouTube",
        "twitch" => "Twitch",
        "kick" => "Kick",
        "x" => "X",
        "facebook" => "Facebook",
        "tiktok" => "TikTok",
        "instagram" => "Instagram",
        "custom" => "your own server",
        _ => return None,
    })
}

/// "A", "A and B", "A, B, and C": the guest page's list, serial comma included.
fn consent_list_phrase(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => (*one).to_string(),
        [first, second] => format!("{first} and {second}"),
        [rest @ .., last] => format!("{}, and {last}", rest.join(", ")),
    }
}

/// D13: the line a guest reads before "Ask to join", from the show's saved
/// destinations; before any is known, the short form. Word for word the
/// guest page's `consentLine`, pinned by
/// `protocol-fixtures/guest-consent-lines.json`.
pub fn guest_consent_line(platforms: &[String]) -> String {
    let names: Vec<&str> = platforms
        .iter()
        .filter_map(|platform| consent_platform_name(platform))
        .collect();
    if names.is_empty() {
        "This show goes out live and may be recorded. Your camera and voice are part of it."
            .to_string()
    } else {
        format!(
            "This show goes out live on {} and may be recorded. Your camera and voice are part of it.",
            consent_list_phrase(&names)
        )
    }
}

// --- Requests (D4, D5) --------------------------------------------------------

/// "Ada wants to join".
pub fn request_title(request: &RoomRequest) -> String {
    format!("{} wants to join", request.name)
}

pub fn request_device(request: &RoomRequest) -> &'static str {
    match request.device {
        GuestDevice::Phone => "On a phone",
        GuestDevice::Computer => "On a computer",
    }
}

/// D5: declined requests from the same browser come back as a count.
pub fn declined_line(count: u32) -> Option<String> {
    (count > 0).then(|| format!("{count} more asked"))
}

// --- People (C-G2, C-G3) ------------------------------------------------------

/// A guest's mic as the host tells it apart (D14). `Held`: the host's hold.
/// `Off`: no hold, but muted or not published. `On`: published and on.
/// `Unknown`: the runner doesn't see them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuestMic {
    Held,
    Off,
    On,
    Unknown,
}

pub const GUEST_MIC_HELD: &str = "Muted by you";
pub const GUEST_MIC_OFF: &str = "Mic off";

pub fn guest_mic(held: bool, participant: Option<&RoomParticipant>) -> GuestMic {
    if held {
        return GuestMic::Held;
    }
    match participant {
        None => GuestMic::Unknown,
        Some(participant) if participant.audio && !participant.muted => GuestMic::On,
        Some(_) => GuestMic::Off,
    }
}

/// The host's own room hears a guest too: a publication it sees muted is off
/// before the runner says so. Never overrides the hold.
pub fn with_room_mic(mic: GuestMic, room_mic_muted: bool) -> GuestMic {
    if room_mic_muted && mic != GuestMic::Held {
        GuestMic::Off
    } else {
        mic
    }
}

/// The word on the guest's row and what it means; nothing while the mic is on.
pub fn guest_mic_status(mic: GuestMic, name: &str) -> Option<(&'static str, String)> {
    match mic {
        GuestMic::Held => Some((
            GUEST_MIC_HELD,
            format!("{name} can't unmute until you let them."),
        )),
        GuestMic::Off => Some((GUEST_MIC_OFF, format!("Only {name} can turn their mic on."))),
        _ => None,
    }
}

/// After the host's Unmute (D14): the guest still has to unmute themselves.
pub fn unmute_hint(name: &str) -> String {
    format!("{name} can talk again once they unmute.")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomPerson {
    /// The LiveKit identity: `host:<showId>` or the guest id.
    pub identity: String,
    /// The guest id for `cloud.guest.act`; None for the host.
    pub guest_id: Option<String>,
    /// As typed on the guest page (D5); "You" for the host.
    pub name: String,
    pub host: bool,
    pub on_stage: bool,
    /// None until the runner sees them in the room.
    pub quality: Option<RoomQuality>,
    /// The host's hold on a guest's mic (D14); the host's own mute for the host.
    pub muted: bool,
    pub mic: GuestMic,
    pub screen_share_allowed: bool,
    pub sharing_screen: bool,
    /// On stage with no camera frame for 5 s (D12).
    pub away: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicState {
    Talking,
    Quiet,
    Held,
    Off,
    Muted,
}

/// A person's mic on their row (plan 252): one icon and its words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MicView {
    pub state: MicState,
    pub label: &'static str,
    pub hint: Option<String>,
}

pub const MIC_TALKING: &str = "Talking";
pub const MIC_QUIET: &str = "Quiet";
pub const MIC_MUTED: &str = "Muted";

/// What the host hears of one person right now.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Heard {
    /// The host's own mute (the host's row only).
    pub local_mic_muted: bool,
    /// The host's room sees this guest's mic publication muted.
    pub room_mic_muted: bool,
    pub speaking: bool,
}

pub fn person_mic_view(person: &RoomPerson, heard: Heard) -> MicView {
    if person.host {
        return if heard.local_mic_muted {
            MicView {
                state: MicState::Muted,
                label: MIC_MUTED,
                hint: None,
            }
        } else {
            MicView {
                state: MicState::Quiet,
                label: MIC_QUIET,
                hint: None,
            }
        };
    }
    if let Some((label, hint)) = guest_mic_status(
        with_room_mic(person.mic, heard.room_mic_muted),
        &person.name,
    ) {
        return MicView {
            state: if label == GUEST_MIC_HELD {
                MicState::Held
            } else {
                MicState::Off
            },
            label,
            hint: Some(hint),
        };
    }
    if heard.speaking {
        MicView {
            state: MicState::Talking,
            label: MIC_TALKING,
            hint: None,
        }
    } else {
        MicView {
            state: MicState::Quiet,
            label: MIC_QUIET,
            hint: None,
        }
    }
}

/// What a press of the mic control does, as its name.
pub fn mic_toggle_label(person: &RoomPerson, local_mic_muted: bool) -> String {
    if person.host {
        return if local_mic_muted {
            "Unmute your microphone".to_string()
        } else {
            "Mute your microphone".to_string()
        };
    }
    if person.muted {
        format!("Let {} unmute", person.name)
    } else {
        format!("Mute {}", person.name)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenShareState {
    Off,
    Allowed,
    Sharing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenShareAction {
    Allow,
    Disallow,
}

/// A guest's screen share on their row (plan 252).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenShareView {
    pub state: ScreenShareState,
    /// The state in words, for a screen reader.
    pub label: &'static str,
    /// The sentence on hover: the state, and what a press does.
    pub hint: String,
    /// The control's name: what a press does.
    pub action_label: String,
    pub action: ScreenShareAction,
}

pub fn guest_screen_share(person: &RoomPerson) -> ScreenShareView {
    let name = &person.name;
    if person.sharing_screen {
        return ScreenShareView {
            state: ScreenShareState::Sharing,
            label: "Sharing their screen",
            hint: format!("{name} is sharing their screen. Press to stop it."),
            action_label: format!("Stop {name}'s screen share"),
            action: ScreenShareAction::Disallow,
        };
    }
    if person.screen_share_allowed {
        return ScreenShareView {
            state: ScreenShareState::Allowed,
            label: "Can share their screen",
            hint: format!(
                "{name} can share their screen from their page. Press to take that back."
            ),
            action_label: format!("Stop letting {name} share their screen"),
            action: ScreenShareAction::Disallow,
        };
    }
    ScreenShareView {
        state: ScreenShareState::Off,
        label: "Can't share their screen",
        hint: format!("Let {name} share their screen."),
        action_label: format!("Let {name} share their screen"),
        action: ScreenShareAction::Allow,
    }
}

const RUNNER_PREFIX: &str = "runner:";

/// Plan 253 S4 (D4): each person's connection as the host's own room client
/// reads it. On a managed show the web's `quality` is a constant, so the
/// row's dot reads this instead. None: no reading, and the state's value
/// stands.
pub trait LiveRoomQuality {
    fn quality(&self, identity: &str, host: bool) -> Option<RoomQuality>;
}

/// The host's own room client, as its snapshot tells it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RoomClientSnapshot {
    pub connected: bool,
    pub local_quality: Option<RoomQuality>,
    /// (identity, quality) for each person the client sees.
    pub people: Vec<(String, RoomQuality)>,
}

impl LiveRoomQuality for RoomClientSnapshot {
    fn quality(&self, identity: &str, host: bool) -> Option<RoomQuality> {
        if !self.connected {
            return None;
        }
        if host {
            return self.local_quality;
        }
        self.people
            .iter()
            .find(|(person, _)| person == identity)
            .map(|(_, quality)| *quality)
    }
}

/// Everyone in the room: the host first, then the stage in its order, then
/// backstage in the order they came in. The runner is never a person.
pub fn room_people(
    room: Option<&RoomStatus>,
    host_identity: Option<&str>,
    live: Option<&dyn LiveRoomQuality>,
) -> Vec<RoomPerson> {
    let Some(room) = room.filter(|room| room.phase != RoomPhase::Closed) else {
        return Vec::new();
    };
    let participants: Vec<&RoomParticipant> = room
        .participants
        .iter()
        .filter(|participant| !participant.identity.starts_with(RUNNER_PREFIX))
        .collect();
    let on_stage = &room.stage.on_stage;
    let live_quality =
        |identity: &str, host: bool| live.and_then(|live| live.quality(identity, host));
    let mut people: Vec<RoomPerson> = Vec::new();
    let host_participant = participants
        .iter()
        .find(|participant| Some(participant.identity.as_str()) == host_identity)
        .or_else(|| {
            participants
                .iter()
                .find(|participant| participant.role == RoomRole::Host)
        })
        .copied();
    let host = host_identity
        .map(str::to_string)
        .or_else(|| host_participant.map(|participant| participant.identity.clone()));
    if let Some(host) = &host {
        people.push(RoomPerson {
            identity: host.clone(),
            guest_id: None,
            name: "You".to_string(),
            host: true,
            on_stage: on_stage.contains(host),
            quality: live_quality(host, true)
                .or_else(|| host_participant.map(|participant| participant.quality)),
            muted: host_participant.is_some_and(|participant| participant.muted),
            mic: guest_mic(false, host_participant),
            screen_share_allowed: true,
            sharing_screen: host_participant.is_some_and(|participant| participant.screen),
            away: host_participant.map_or(room.host_away, |participant| participant.away),
        });
    }
    for guest in &room.guests {
        if people
            .iter()
            .any(|person| person.identity == guest.guest_id)
        {
            continue;
        }
        let participant = participants
            .iter()
            .find(|participant| participant.identity == guest.guest_id)
            .copied();
        people.push(RoomPerson {
            identity: guest.guest_id.clone(),
            guest_id: Some(guest.guest_id.clone()),
            name: participant
                .map(|participant| participant.name.clone())
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| guest.name.clone()),
            host: false,
            on_stage: on_stage.contains(&guest.guest_id),
            quality: live_quality(&guest.guest_id, false)
                .or_else(|| participant.map(|participant| participant.quality)),
            muted: guest.muted,
            mic: guest_mic(guest.muted, participant),
            screen_share_allowed: guest.screen_share_allowed,
            sharing_screen: participant.is_some_and(|participant| participant.screen),
            away: participant.is_some_and(|participant| participant.away),
        });
    }
    // A guest the runner sees before videorc.com lists them (a race).
    for participant in &participants {
        if participant.role != RoomRole::Guest
            || people
                .iter()
                .any(|person| person.identity == participant.identity)
        {
            continue;
        }
        people.push(RoomPerson {
            identity: participant.identity.clone(),
            guest_id: Some(participant.identity.clone()),
            name: participant.name.clone(),
            host: false,
            on_stage: on_stage.contains(&participant.identity),
            quality: live_quality(&participant.identity, false).or(Some(participant.quality)),
            muted: participant.muted,
            mic: guest_mic(false, Some(participant)),
            screen_share_allowed: false,
            sharing_screen: participant.screen,
            away: participant.away,
        });
    }
    let stage_index = |person: &RoomPerson| {
        on_stage
            .iter()
            .position(|identity| *identity == person.identity)
            .unwrap_or(usize::MAX)
    };
    let (host_row, guests): (Vec<RoomPerson>, Vec<RoomPerson>) = if host.is_some() {
        let mut rest = people;
        let first = rest.remove(0);
        (vec![first], rest)
    } else {
        (Vec::new(), people)
    };
    let mut staged: Vec<RoomPerson> = guests
        .iter()
        .filter(|person| person.on_stage)
        .cloned()
        .collect();
    staged.sort_by_key(stage_index);
    let backstage = guests.into_iter().filter(|person| !person.on_stage);
    host_row
        .into_iter()
        .chain(staged)
        .chain(backstage)
        .collect()
}

/// The status tone a word rides on (never the word's colour).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Good,
    Warn,
    Error,
    /// Recording or on air.
    Live,
    Neutral,
}

/// The connection as a dot and a word.
pub fn quality_status(quality: Option<RoomQuality>) -> (Tone, &'static str) {
    match quality {
        Some(RoomQuality::Excellent | RoomQuality::Good) => (Tone::Good, "Good connection"),
        Some(RoomQuality::Poor) => (Tone::Warn, "Weak connection"),
        Some(RoomQuality::Lost) => (Tone::Error, "Connection lost"),
        None => (Tone::Neutral, "Joining"),
    }
}

pub fn stage_chip_label(person: &RoomPerson) -> &'static str {
    if person.on_stage {
        "On stage"
    } else {
        "Backstage"
    }
}

/// The room counts against its size: the host and every guest let in.
pub fn room_is_full(people: &[RoomPerson], limits: Option<RoomLimits>) -> bool {
    limits.is_some_and(|limits| limits.room_size > 0 && people.len() as u32 >= limits.room_size)
}

/// Why Bring on is off for a guest: the stage's seats are taken (D15).
pub fn bring_on_blocked_reason(
    people: &[RoomPerson],
    limits: Option<RoomLimits>,
) -> Option<String> {
    let limits = limits?;
    let guests_on_stage = people
        .iter()
        .filter(|person| !person.host && person.on_stage)
        .count() as u32;
    if guests_on_stage < limits.guests_on_stage {
        return None;
    }
    Some(if limits.guests_on_stage == 1 {
        GUESTS_PREMIUM_SEAT_LINE.to_string()
    } else {
        format!(
            "The stage is full: up to {} on stage.",
            plural(limits.guests_on_stage, "guest", None)
        )
    })
}

/// The room in numbers, for the Room row and the lists' labels.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RoomCounts {
    pub on_stage: usize,
    pub backstage: usize,
    pub asking: usize,
}

pub fn room_counts(room: Option<&RoomStatus>, people: &[RoomPerson]) -> RoomCounts {
    let guests: Vec<&RoomPerson> = people.iter().filter(|person| !person.host).collect();
    let on_stage = guests.iter().filter(|person| person.on_stage).count();
    RoomCounts {
        on_stage,
        backstage: guests.len() - on_stage,
        asking: room.map_or(0, |room| room.requests.len()),
    }
}

/// The Studio's Session row (D16): "Room open · 2 backstage".
pub fn guests_session_value(room: Option<&RoomStatus>, people: &[RoomPerson]) -> String {
    let counts = room_counts(room, people);
    let mut parts = vec![room_phase_label(room).to_string()];
    if counts.on_stage > 0 {
        parts.push(format!("{} on stage", counts.on_stage));
    }
    if counts.backstage > 0 {
        parts.push(format!("{} backstage", counts.backstage));
    }
    if counts.asking > 0 {
        parts.push(if counts.asking == 1 {
            "1 wants to join".to_string()
        } else {
            format!("{} want to join", counts.asking)
        });
    }
    parts.join(" · ")
}

// --- What the room sends (plan 249 S17, plan 252) ------------------------------

/// `ManagedOutputProfile` (`shared/cloud-output-profile.ts`), as the Guests
/// page reads it: version 1, one effective output per orientation.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ManagedOutputProfile {
    pub version: u32,
    pub effective: Vec<ManagedEffectiveOutput>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ManagedEffectiveOutput {
    pub orientation: String,
    pub width: u32,
    pub height: u32,
    pub picture_fps: u32,
    pub video_kbps: u32,
    pub differences: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputProfileChips {
    pub orientation: String,
    pub facts: Vec<String>,
    /// The room sends something other than the settings asked.
    pub differs: bool,
}

/// The room's output profile as short facts: "1920×1080", "30 fps", "6 Mbps".
pub fn output_profile_chips(profile: Option<&ManagedOutputProfile>) -> Vec<OutputProfileChips> {
    let Some(profile) = profile.filter(|profile| profile.version == 1) else {
        return Vec::new();
    };
    profile
        .effective
        .iter()
        .map(|output| OutputProfileChips {
            orientation: output.orientation.clone(),
            facts: vec![
                format!("{}×{}", output.width, output.height),
                format!("{} fps", output.picture_fps),
                format!("{} Mbps", f64::from(output.video_kbps) / 1000.0),
            ],
            differs: !output.differences.is_empty(),
        })
        .collect()
}

// --- Screens (plan 252) --------------------------------------------------------

pub const NO_SCREENS_YET: &str = "Nobody is sharing a screen.";
pub const SCREENS_GUEST_HINT: &str = "A guest can share theirs once you allow it on their row.";

/// A screen someone shares in the room: a card under Screens on the Show stage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomScreen {
    /// Whose screen: the sharer's identity, as the stage names it.
    pub identity: String,
    /// "Your screen", "Ada's screen".
    pub name: String,
    pub host: bool,
    /// The program shows this screen.
    pub on_program: bool,
    /// Why it can't go on the program: its owner is backstage, or two
    /// screens are on stage already.
    pub blocked_reason: Option<String>,
}

/// Every screen shared in the room, the host's first.
pub fn room_screens(
    room: Option<&RoomStatus>,
    people: &[RoomPerson],
    host_sharing: bool,
    two_screens: bool,
) -> Vec<RoomScreen> {
    let shown = room.map(|room| screens_of(&room.stage)).unwrap_or_default();
    let full = two_screens && shown.len() >= STAGE_MAX_SCREENS;
    people
        .iter()
        .filter(|person| {
            if person.host {
                host_sharing || person.sharing_screen
            } else {
                person.sharing_screen
            }
        })
        .map(|person| {
            let on_program = shown.contains(&person.identity);
            RoomScreen {
                identity: person.identity.clone(),
                name: if person.host {
                    "Your screen".to_string()
                } else {
                    format!("{}'s screen", person.name)
                },
                host: person.host,
                on_program,
                blocked_reason: if !person.on_stage {
                    Some(format!("Bring {} on first.", person.name))
                } else if full && !on_program {
                    Some(TWO_SCREENS_AT_MOST.to_string())
                } else {
                    None
                },
            }
        })
        .collect()
}

/// The stage with this screen on the program, or with none. Putting a
/// screen on picks Screen + people; taking it off leaves that layout for
/// Side by side.
pub fn stage_with_screen(stage: &Stage, identity: Option<&str>) -> Stage {
    match identity {
        Some(identity) => Stage {
            layout: StageLayout::ScreenPeople,
            ..with_stage_screens(stage, &[identity.to_string()])
        },
        None => Stage {
            layout: if stage.layout == StageLayout::ScreenPeople {
                StageLayout::SideBySide
            } else {
                stage.layout
            },
            ..with_stage_screens(stage, &[])
        },
    }
}

/// A Screens card's click (plan 251): on the Two screens layout it adds or
/// takes off its screen; on any other it takes the one place, or comes off.
pub fn stage_with_screen_card(stage: &Stage, screen: &RoomScreen, two_screens: bool) -> Stage {
    if two_screens {
        return toggle_stage_screen(stage, &screen.identity);
    }
    if screen.on_program {
        remove_screen(stage, &screen.identity)
    } else {
        stage_with_screen(stage, Some(&screen.identity))
    }
}

// --- Stage controls (C-G3, D8) ------------------------------------------------

pub fn layout_label(layout: DrawnStageLayout) -> &'static str {
    match layout {
        DrawnStageLayout::Solo => "Solo",
        DrawnStageLayout::SideBySide => "Side by side",
        DrawnStageLayout::ScreenPeople => "Screen + people",
        DrawnStageLayout::Spotlight => "Spotlight",
        DrawnStageLayout::TwoScreens => TWO_SCREENS_LABEL,
    }
}

/// Plan 251: the fifth card. Screen + people with two screens on the wire.
pub const TWO_SCREENS_LABEL: &str = "Two screens";
pub const SHARE_A_SCREEN_FIRST: &str = "Share a screen first";
pub const SOLO_NEEDS_ONE: &str = "Solo shows one person. Send the others backstage first.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutOption {
    pub value: DrawnStageLayout,
    pub label: &'static str,
    pub disabled_reason: Option<&'static str>,
}

/// The layout cards, each with its reason when it can't apply: the four
/// room layouts, then Two screens, which needs a managed show and a screen
/// to start from.
pub fn layout_options(
    room: Option<&RoomStatus>,
    managed: bool,
    sharers: usize,
) -> Vec<LayoutOption> {
    let on_stage = room.map_or(0, |room| room.stage.on_stage.len());
    let screen = room
        .and_then(|room| room.stage.screen.as_deref())
        .filter(|screen| !screen.is_empty());
    let mut options: Vec<LayoutOption> = StageLayout::ALL
        .into_iter()
        .map(|layout| {
            let value = DrawnStageLayout::from(layout);
            LayoutOption {
                value,
                label: layout_label(value),
                disabled_reason: if layout == StageLayout::ScreenPeople && screen.is_none() {
                    Some(SHARE_A_SCREEN_FIRST)
                } else if layout == StageLayout::Solo && on_stage > 1 {
                    Some(SOLO_NEEDS_ONE)
                } else {
                    None
                },
            }
        })
        .collect();
    options.push(LayoutOption {
        value: DrawnStageLayout::TwoScreens,
        label: TWO_SCREENS_LABEL,
        disabled_reason: if !managed {
            Some(ONE_SCREEN_ON_THIS_SHOW)
        } else if screen.is_none() && sharers == 0 {
            Some(SHARE_A_SCREEN_FIRST)
        } else {
            None
        },
    });
    options
}

/// One line under the chips: why each blocked layout waits. "Share a screen
/// first" is said once, for every layout that waits on it.
pub fn layout_reasons_line(options: &[LayoutOption]) -> Option<String> {
    let waiting: Vec<&LayoutOption> = options
        .iter()
        .filter(|option| option.disabled_reason == Some(SHARE_A_SCREEN_FIRST))
        .collect();
    let mut reasons: Vec<String> = Vec::new();
    for option in options {
        match option.disabled_reason {
            None => {}
            Some(reason) if reason != SHARE_A_SCREEN_FIRST => reasons.push(reason.to_string()),
            Some(_)
                if waiting
                    .first()
                    .is_some_and(|first| std::ptr::eq(*first, option)) =>
            {
                let labels: Vec<&str> = waiting.iter().map(|entry| entry.label).collect();
                reasons.push(format!(
                    "{SHARE_A_SCREEN_FIRST} for {}.",
                    labels.join(" and ")
                ));
            }
            Some(_) => {}
        }
    }
    (!reasons.is_empty()).then(|| reasons.join(" "))
}

/// The layout the stage shows: the runner's fallbacks applied, on the stage
/// as the program draws it.
pub fn shown_layout(room: Option<&RoomStatus>) -> DrawnStageLayout {
    match room {
        None => DrawnStageLayout::Solo,
        Some(room) => effective_stage_layout(&show_stage_input(Some(room))),
    }
}

/// The layout card that is on: Two screens stays on while it is chosen and
/// one screen is up.
pub fn selected_layout(room: Option<&RoomStatus>, two_screens: bool) -> DrawnStageLayout {
    let shown = shown_layout(room);
    if two_screens && shown == DrawnStageLayout::ScreenPeople {
        DrawnStageLayout::TwoScreens
    } else {
        shown
    }
}

// --- Moderation (D5, D14) ------------------------------------------------------

pub const GUEST_NAME_MAX_CHARS: usize = 32;

/// A rename's new name: trimmed, 1 to 32 characters, and changed; else None.
/// Characters are UTF-16 units, as the page and the web count them.
pub fn renamed_guest_name(current: &str, next: &str) -> Option<String> {
    let trimmed = next.trim();
    let units = trimmed.encode_utf16().count();
    if units == 0 || units > GUEST_NAME_MAX_CHARS || trimmed == current {
        return None;
    }
    Some(trimmed.to_string())
}

/// A confirmation's words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmCopy {
    pub title: String,
    pub description: String,
    pub confirm: String,
}

pub fn remove_guest_copy(name: &str) -> ConfirmCopy {
    ConfirmCopy {
        title: format!("Remove {name}?"),
        description: format!("{name} leaves the show. The link still works for everyone else."),
        confirm: format!("Remove {name}"),
    }
}

pub fn ban_guest_copy(name: &str) -> ConfirmCopy {
    ConfirmCopy {
        title: format!("Ban {name}?"),
        description: format!(
            "{name} leaves the show and can't ask to join again. The link changes, so share the new one with your guests."
        ),
        confirm: format!("Ban {name}"),
    }
}

#[cfg(test)]
#[path = "view_tests.rs"]
mod tests;
