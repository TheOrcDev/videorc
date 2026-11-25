//! Reactions and Motion (`buddy-reactions-section.tsx`,
//! `buddy-motion-section.tsx`, plan 168 S-D2): what the avatar does on
//! stream when something happens, and how much it moves, when it sleeps and
//! whether it breathes. Both save `persona` through `cohost.settings.set`
//! with no success toast.
//!
//! The trigger model is Electron's `lib/buddy-pet-view.ts`, ported here
//! until app-core's `buddy` module carries it (S1.6e's pet store); D14's
//! default chains come from the protocol (`BuddyTrigger::default_reactions`).

use std::collections::BTreeMap;

use gpui::{AnyElement, Context, Entity, SharedString, Window, div, prelude::*, px};
use serde::Deserialize;
use serde_json::json;
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::select::Select;
use videorc_kit::slider::{Slider, SliderEvent, SliderState};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{Theme, text};
use videorc_protocol::buddy_pet::{BuddyAvatar, BuddyMotionSettings, BuddyTrigger};
use videorc_protocol::cohost::CohostPersona;

use super::AvatarScreen;

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

// --- The screen ------------------------------------------------------------

/// The Motion slider; it is dragged before anything saves.
pub(super) struct MotionWidgets {
    intensity: Entity<SliderState>,
    /// The slider moves under a drag: the saved value doesn't push it.
    dragging: bool,
}

impl AvatarScreen {
    pub(super) fn ensure_motion(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(persona) = self.persona.as_ref() else {
            return;
        };
        let saved = persona.motion.intensity as f32;
        if self.motion.is_none() {
            let intensity = cx.new(|_| {
                SliderState::new()
                    .min(0.0)
                    .max(1.0)
                    .step(0.05)
                    .default_value(saved)
            });
            cx.subscribe(&intensity, |screen, _, event: &SliderEvent, cx| {
                let value = match event {
                    SliderEvent::Change(value) | SliderEvent::Release(value) => value.end(),
                };
                if let Some(motion) = screen.motion.as_mut() {
                    motion.dragging = matches!(event, SliderEvent::Change(_));
                }
                if matches!(event, SliderEvent::Release(_)) {
                    screen.commit_intensity(value, cx);
                }
                cx.notify();
            })
            .detach();
            self.motion = Some(MotionWidgets {
                intensity,
                dragging: false,
            });
            return;
        }
        if let Some(motion) = self.motion.as_ref()
            && !motion.dragging
        {
            motion.intensity.update(cx, |state, cx| {
                if (state.value().end() - saved).abs() >= 0.01 {
                    state.set_value(saved, window, cx);
                }
            });
        }
    }

    /// `cohost.pet.list`: the packs, for the worn one's reactions.
    pub(super) fn refresh_packs(&self, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let read = self
            .runtime
            .spawn(async move { backend.request("cohost.pet.list", json!({})).await });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(value)) = read.await else {
                return;
            };
            let packs = serde_json::from_value::<Vec<PackSummary>>(value).unwrap_or_default();
            let _ = this.update(cx, |screen, cx| {
                screen.packs = packs;
                cx.notify();
            });
        })
        .detach();
    }

    fn commit_intensity(&mut self, value: f32, cx: &mut Context<Self>) {
        let Some(persona) = self.persona.as_ref() else {
            return;
        };
        let rounded = (f64::from(value) * 100.0).round() / 100.0;
        if (rounded - persona.motion.intensity).abs() < f64::EPSILON {
            return;
        }
        let motion = BuddyMotionSettings {
            intensity: rounded,
            ..persona.motion
        };
        self.save_motion(motion, cx);
    }

    fn pick_tick(&mut self, value: f32, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(motion) = self.motion.as_ref() {
            motion
                .intensity
                .update(cx, |state, cx| state.set_value(value, window, cx));
        }
        self.commit_intensity(value, cx);
    }

    fn set_sleep(&mut self, seconds: u32, cx: &mut Context<Self>) {
        let Some(persona) = self.persona.as_ref() else {
            return;
        };
        if seconds == persona.motion.sleep_after_seconds {
            return;
        }
        let motion = BuddyMotionSettings {
            sleep_after_seconds: seconds,
            ..persona.motion
        };
        self.save_motion(motion, cx);
    }

    fn set_breathing(&mut self, breathing: bool, cx: &mut Context<Self>) {
        let Some(persona) = self.persona.as_ref() else {
            return;
        };
        let motion = BuddyMotionSettings {
            breathing,
            ..persona.motion
        };
        self.save_motion(motion, cx);
    }

    fn save_motion(&mut self, motion: BuddyMotionSettings, cx: &mut Context<Self>) {
        let Some(persona) = self.persona.as_ref() else {
            return;
        };
        let next = CohostPersona {
            motion,
            ..persona.clone()
        };
        self.save_persona_with(next, SaveSection::Motion, cx);
    }

    fn set_reaction(&mut self, trigger: BuddyTrigger, value: &str, cx: &mut Context<Self>) {
        let Some(persona) = self.persona.as_ref() else {
            return;
        };
        let next = CohostPersona {
            reactions: with_trigger_reaction(&persona.reactions, trigger, value),
            ..persona.clone()
        };
        self.save_persona_with(next, SaveSection::Reactions, cx);
    }
}

/// Which section a failed save belongs to (each says its own).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SaveSection {
    Persona,
    Reactions,
    Motion,
}

impl SaveSection {
    /// `inlineUserError`'s object for this section.
    pub(super) fn object(self) -> &'static str {
        match self {
            Self::Persona => "the changes",
            Self::Reactions => "the reactions",
            Self::Motion => "the motion",
        }
    }
}

pub(super) fn render_reactions(
    screen: &AvatarScreen,
    window: &mut Window,
    cx: &mut Context<AvatarScreen>,
) -> Option<AnyElement> {
    let persona = screen.persona.as_ref()?;
    let t = theme::resolve(None, window, cx);
    let entity = cx.entity();
    let pack = active_reactions(persona, &screen.packs);
    let choosable = choosable_reactions(&pack);

    let mut section = PanelSection::new("avatar-reactions")
        .title("Reactions")
        .description(format!(
            "What {} does on stream when something happens. Try plays it here.",
            persona.name
        ));
    for (label, triggers) in TRIGGER_SECTIONS {
        let mut list = GroupedList::new().label(label);
        for &trigger in triggers {
            let (title, detail) = trigger_copy(trigger);
            let key = serde_json::to_value(trigger)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_default();
            let chosen = persona.reactions.get(&trigger).cloned();
            let fallback = trigger_outcome(trigger, &BTreeMap::new(), &pack);
            let mut select = Select::new(SharedString::from(format!("avatar-reaction-{key}")))
                .width(160.)
                .accessibility_label(format!("{title} reaction"))
                .value(Some(SharedString::from(
                    chosen.clone().unwrap_or_else(|| REACTION_DEFAULT.into()),
                )))
                .option(
                    REACTION_DEFAULT,
                    format!("Default: {}", outcome_label(&fallback)),
                );
            for id in &choosable {
                select = select.option(id.clone(), reaction_label(id));
            }
            if let Some(missing) = chosen
                .as_ref()
                .filter(|id| *id != REACTION_NONE && !choosable.contains(id))
            {
                select = select.option(
                    missing.clone(),
                    format!("{} (not in these moves)", reaction_label(missing)),
                );
            }
            let save = entity.clone();
            select = select
                .option(REACTION_NONE, "None")
                .on_change(move |value, _, cx| {
                    save.update(cx, |screen, cx| screen.set_reaction(trigger, &value, cx))
                });
            // The living preview lands with the look; Try waits for it.
            let try_it = Button::new(SharedString::from(format!("avatar-reaction-try-{key}")))
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::Xs)
                .label("Try")
                .accessibility_label(format!("Try the {} reaction", title.to_lowercase()))
                .disabled(true);
            list = list.row(
                ListRow::new(
                    SharedString::from(format!("avatar-reaction-row-{key}")),
                    title,
                )
                .context(detail)
                .child(select)
                .child(try_it),
            );
        }
        section = section.child(list);
    }
    if let Some(error) = screen.save_error(SaveSection::Reactions) {
        section = section.child(error_line(error, t));
    }
    Some(section.into_any_element())
}

pub(super) fn render_motion(
    screen: &AvatarScreen,
    window: &mut Window,
    cx: &mut Context<AvatarScreen>,
) -> Option<AnyElement> {
    let persona = screen.persona.as_ref()?;
    let widgets = screen.motion.as_ref()?;
    let t = theme::resolve(None, window, cx);
    let entity = cx.entity();
    let motion = &persona.motion;
    let shown = widgets.intensity.read(cx).value().end();

    let mut ticks = div().flex().justify_between().items_center();
    for (label, value) in MOTION_TICKS {
        let pick = entity.clone();
        ticks = ticks.child(
            Button::new(SharedString::from(format!("avatar-motion-tick-{label}")))
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::Xs)
                .label(label)
                .on_click(move |_, window, cx| {
                    pick.update(cx, |screen, cx| screen.pick_tick(value, window, cx))
                }),
        );
    }
    let intensity = div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(12.))
                .child(label_text("Motion", t))
                .child(meta(format!("{}%", (shown * 100.0).round() as i32), t)),
        )
        .child(Slider::new(&widgets.intensity).accessibility_label("Motion"))
        .child(ticks);

    let sleep_entity = entity.clone();
    let mut sleep = Select::new("avatar-sleep-after")
        .width(112.)
        .accessibility_label("Sleep after")
        .value(Some(SharedString::from(
            motion.sleep_after_seconds.to_string(),
        )))
        .on_change(move |value, _, cx| {
            if let Ok(seconds) = value.parse::<u32>() {
                sleep_entity.update(cx, |screen, cx| screen.set_sleep(seconds, cx));
            }
        });
    for seconds in sleep_choices(motion.sleep_after_seconds) {
        sleep = sleep.option(seconds.to_string(), sleep_label(seconds));
    }
    let breathe = entity.clone();
    let breathing = Switch::new("avatar-breathing")
        .accessibility_label("Breathing")
        .checked(motion.breathing)
        .on_change(move |on, _, cx| breathe.update(cx, |screen, cx| screen.set_breathing(on, cx)));

    let mut section = PanelSection::new("avatar-motion")
        .title("Motion")
        .description(format!(
            "How {} moves on stream and here. Off keeps its poses and drops the bounce.",
            persona.name
        ))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(20.))
                .child(intensity)
                .child(row(
                    "Sleep after",
                    "With no chat, activity or lines for this long. Anything wakes it.",
                    sleep.into_any_element(),
                    t,
                ))
                .child(row(
                    "Breathing",
                    "A slow breath between events, so it never looks frozen.",
                    breathing.into_any_element(),
                    t,
                )),
        );
    if let Some(error) = screen.save_error(SaveSection::Motion) {
        section = section.child(error_line(error, t));
    }
    Some(section.into_any_element())
}

/// A label and its description on the left, the control on the right.
fn row(
    label: &'static str,
    description: &'static str,
    control: AnyElement,
    t: &Theme,
) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(12.))
        .child(
            div()
                .flex()
                .flex_col()
                .min_w(px(0.))
                .gap(px(2.))
                .child(label_text(label, t))
                .child(meta(description, t)),
        )
        .child(control)
}

fn label_text(label: &'static str, t: &Theme) -> gpui::Div {
    div()
        .text_size(px(14.))
        .line_height(px(20.))
        .font_weight(gpui::FontWeight::MEDIUM)
        .text_color(hsla(t.foreground))
        .child(label)
}

fn meta(line: impl Into<SharedString>, t: &Theme) -> gpui::Div {
    div()
        .type_scale(text::META)
        .text_color(hsla(t.muted_foreground))
        .child(line.into())
}

fn error_line(line: String, t: &Theme) -> gpui::Div {
    div()
        .type_scale(text::META)
        .text_color(hsla(t.destructive))
        .child(line)
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
