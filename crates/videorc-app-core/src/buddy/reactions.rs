//! The Avatar page's Reactions model (Electron's `lib/buddy-pet-view.ts`,
//! plan 168 S-D2): which reaction each trigger plays, the choosable
//! reactions of the worn pack, and the Motion section's sleep choices. D14's
//! default chains come from the protocol (`BuddyTrigger::default_reactions`).
//! Ported by L3 in the app's Avatar screen; moved here so the core carries it
//! with the rest of `buddy` (the pet store follows, S1.6e).

use std::collections::BTreeMap;

use serde::Deserialize;
use videorc_protocol::buddy_pet::{BuddyAvatar, BuddyTrigger};
use videorc_protocol::cohost::CohostPersona;

// --- The trigger model (`lib/buddy-pet-view.ts`) --------------------------

/// The Still avatar's reactions: the persona's state images (D2).
pub const STILL_REACTIONS: [&str; 3] = ["talk", "laugh", "think"];
/// Idle frames, not reactions to people: a trigger never picks them.
const IDLE_REACTIONS: [&str; 2] = ["blink", "sleep"];
/// An override that turns a trigger's reaction off.
pub const REACTION_NONE: &str = "none";
/// The Select value for "use D14's default"; never a reaction id.
pub const REACTION_DEFAULT: &str = "__default";
/// Sleep after (D13): Never and a few minutes; 0 means never.
const SLEEP_CHOICES: [u32; 5] = [0, 60, 180, 300, 600];
const SLEEP_AFTER_MAX_SECONDS: u32 = 1800;
/// The Motion slider's ticks; Calm is page-pet's default.
const MOTION_TICKS: [(&str, f32); 3] = [("Off", 0.0), ("Calm", 0.45), ("Lively", 1.0)];

/// The Reactions list, sectioned: what viewers do, then what the stream
/// does.
pub const TRIGGER_SECTIONS: [(&str, &[BuddyTrigger]); 3] = [
    (
        "Viewers",
        &[
            BuddyTrigger::Follow,
            BuddyTrigger::Subscription,
            BuddyTrigger::Gift,
            BuddyTrigger::Tip,
            BuddyTrigger::Raid,
            BuddyTrigger::WatchStreak,
            BuddyTrigger::Redemption,
        ],
    ),
    (
        "Regulars",
        &[
            BuddyTrigger::Regular,
            BuddyTrigger::Comeback,
            BuddyTrigger::Milestone,
        ],
    ),
    ("Your stream", &[BuddyTrigger::DestinationFailed]),
];

/// One trigger's row: what happens, and the events it covers.
pub fn trigger_copy(trigger: BuddyTrigger) -> (&'static str, &'static str) {
    match trigger {
        BuddyTrigger::Follow => ("Follow", "A new follower"),
        BuddyTrigger::Subscription => ("Sub", "Subs, resubs and memberships"),
        BuddyTrigger::Gift => ("Gifted subs", "One gift or a community gift"),
        BuddyTrigger::Tip => (
            "Cheer or tip",
            "Bits, Kicks, Super Chats, stickers and Power-ups",
        ),
        BuddyTrigger::Raid => ("Raid", "Another channel raids you"),
        BuddyTrigger::WatchStreak => ("Watch streak", "A viewer shares their streak"),
        BuddyTrigger::Redemption => ("Reward redeemed", "Channel points and rewards"),
        BuddyTrigger::DestinationFailed => ("A destination fails", "Off by default"),
        BuddyTrigger::Regular => ("A regular arrives", "Their first chat of the stream"),
        BuddyTrigger::Comeback => ("Back after a while", "Their first chat in 30 days or more"),
        BuddyTrigger::Milestone => ("Milestone", "Their 10th stream, 5 in a row, one year"),
    }
}

/// "laugh" → "Laugh", "talk-a" → "Talk a".
pub fn reaction_label(id: &str) -> String {
    let words = id.replace('-', " ");
    let words = words.trim();
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => id.to_string(),
    }
}

/// Every reaction but blink and sleep.
pub fn choosable_reactions(reactions: &[String]) -> Vec<String> {
    reactions
        .iter()
        .filter(|id| !IDLE_REACTIONS.contains(&id.as_str()))
        .cloned()
        .collect()
}

/// What a trigger does with the active pack (D14).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Reaction(String),
    /// The pack has no frame for it: a motion-only hop with that id's pose.
    Hop(String),
    None,
}

/// D14 for one trigger: the override when set (`none` turns it off), else
/// the default chain's first id the pack has, else a hop; a trigger without
/// defaults does nothing.
pub fn trigger_outcome(
    trigger: BuddyTrigger,
    table: &BTreeMap<BuddyTrigger, String>,
    pack: &[String],
) -> Outcome {
    let has = |id: &str| pack.iter().any(|known| known == id);
    if let Some(choice) = table.get(&trigger) {
        if choice == REACTION_NONE {
            return Outcome::None;
        }
        return if has(choice) {
            Outcome::Reaction(choice.clone())
        } else {
            Outcome::Hop(choice.clone())
        };
    }
    let chain = trigger.default_reactions();
    match (chain.iter().find(|id| has(id)), chain.first()) {
        (Some(found), _) => Outcome::Reaction((*found).to_string()),
        (None, Some(first)) => Outcome::Hop((*first).to_string()),
        (None, None) => Outcome::None,
    }
}

pub fn outcome_label(outcome: &Outcome) -> String {
    match outcome {
        Outcome::None => "None".into(),
        Outcome::Hop(_) => "Hop".into(),
        Outcome::Reaction(id) => reaction_label(id),
    }
}

/// The table with one trigger set to an id, `none`, or back to its default.
pub fn with_trigger_reaction(
    table: &BTreeMap<BuddyTrigger, String>,
    trigger: BuddyTrigger,
    value: &str,
) -> BTreeMap<BuddyTrigger, String> {
    let mut next = table.clone();
    if value == REACTION_DEFAULT {
        next.remove(&trigger);
    } else {
        next.insert(trigger, value.to_string());
    }
    next
}

pub fn sleep_label(seconds: u32) -> String {
    if seconds == 0 {
        return "Never".into();
    }
    if seconds < 60 {
        return format!("{seconds} s");
    }
    let (minutes, rest) = (seconds / 60, seconds % 60);
    if rest == 0 {
        format!("{minutes} min")
    } else {
        format!("{minutes} min {rest} s")
    }
}

/// The standard choices plus a stored value outside them.
pub fn sleep_choices(current: u32) -> Vec<u32> {
    let mut choices = SLEEP_CHOICES.to_vec();
    if !SLEEP_CHOICES.contains(&current) && current <= SLEEP_AFTER_MAX_SECONDS {
        choices.push(current);
        choices.sort_unstable();
    }
    choices
}

/// One pack as `cohost.pet.list` lists it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackSummary {
    pub pack_id: String,
    #[serde(default)]
    pub reactions: Vec<String>,
}

/// The active pack's reactions: Still's poses, or the worn pack's.
pub fn active_reactions(persona: &CohostPersona, packs: &[PackSummary]) -> Vec<String> {
    match &persona.avatar {
        BuddyAvatar::Still => STILL_REACTIONS.iter().map(|id| id.to_string()).collect(),
        BuddyAvatar::Alive { pack_id } => packs
            .iter()
            .find(|pack| &pack.pack_id == pack_id)
            .map(|pack| pack.reactions.clone())
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn labels_read_as_words() {
        assert_eq!(reaction_label("laugh"), "Laugh");
        assert_eq!(reaction_label("talk-a"), "Talk a");
        assert_eq!(reaction_label(""), "");
    }

    #[test]
    fn idle_frames_are_never_picked() {
        assert_eq!(
            choosable_reactions(&ids(&["blink", "wave", "sleep", "proud"])),
            ids(&["wave", "proud"])
        );
    }

    #[test]
    fn d14_picks_the_override_then_the_chain_then_a_hop() {
        let pack = ids(&["proud", "laugh"]);
        let mut table = BTreeMap::new();
        // Follow's chain is wave, proud: the pack has proud.
        assert_eq!(
            trigger_outcome(BuddyTrigger::Follow, &table, &pack),
            Outcome::Reaction("proud".into())
        );
        // Sub's chain is excited, which the pack lacks: a hop.
        assert_eq!(
            trigger_outcome(BuddyTrigger::Subscription, &table, &pack),
            Outcome::Hop("excited".into())
        );
        // A failed destination has no chain.
        assert_eq!(
            trigger_outcome(BuddyTrigger::DestinationFailed, &table, &pack),
            Outcome::None
        );
        table.insert(BuddyTrigger::Follow, "laugh".to_string());
        table.insert(BuddyTrigger::Raid, REACTION_NONE.to_string());
        table.insert(BuddyTrigger::Tip, "spin".to_string());
        assert_eq!(
            trigger_outcome(BuddyTrigger::Follow, &table, &pack),
            Outcome::Reaction("laugh".into())
        );
        assert_eq!(
            trigger_outcome(BuddyTrigger::Raid, &table, &pack),
            Outcome::None
        );
        assert_eq!(
            trigger_outcome(BuddyTrigger::Tip, &table, &pack),
            Outcome::Hop("spin".into())
        );
        assert_eq!(outcome_label(&Outcome::Hop("spin".into())), "Hop");
    }

    #[test]
    fn default_clears_the_override() {
        let table = with_trigger_reaction(&BTreeMap::new(), BuddyTrigger::Gift, "wave");
        assert_eq!(
            table.get(&BuddyTrigger::Gift).map(String::as_str),
            Some("wave")
        );
        let table = with_trigger_reaction(&table, BuddyTrigger::Gift, REACTION_DEFAULT);
        assert!(table.is_empty());
    }

    #[test]
    fn sleep_lists_never_and_minutes_and_a_stored_value() {
        assert_eq!(sleep_label(0), "Never");
        assert_eq!(sleep_label(45), "45 s");
        assert_eq!(sleep_label(180), "3 min");
        assert_eq!(sleep_label(90), "1 min 30 s");
        assert_eq!(sleep_choices(180), vec![0, 60, 180, 300, 600]);
        assert_eq!(sleep_choices(90), vec![0, 60, 90, 180, 300, 600]);
        assert_eq!(sleep_choices(5000), vec![0, 60, 180, 300, 600]);
    }

    #[test]
    fn every_trigger_has_a_row() {
        let listed: Vec<BuddyTrigger> = TRIGGER_SECTIONS
            .iter()
            .flat_map(|(_, triggers)| triggers.iter().copied())
            .collect();
        for trigger in BuddyTrigger::ALL {
            assert!(listed.contains(&trigger), "{trigger:?}");
        }
        assert_eq!(listed.len(), BuddyTrigger::ALL.len());
    }
}
