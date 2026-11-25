//! Reactions and Motion (`buddy-reactions-section.tsx`,
//! `buddy-motion-section.tsx`, plan 168 S-D2): what the avatar does on
//! stream when something happens, and how much it moves, when it sleeps and
//! whether it breathes. Both save `persona` through `cohost.settings.set`
//! with no success toast.
//!
//! The trigger model lives in `videorc_app_core::buddy::reactions`.

use std::collections::BTreeMap;

use gpui::{AnyElement, Context, Entity, SharedString, Window, div, prelude::*, px};
use serde_json::json;
pub use videorc_app_core::buddy::reactions::*;
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::select::Select;
use videorc_kit::slider::{Slider, SliderEvent, SliderState};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{Theme, text};
use videorc_protocol::buddy_pet::{BuddyMotionSettings, BuddyTrigger};
use videorc_protocol::cohost::CohostPersona;

use super::AvatarScreen;

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
    Greetings,
}

impl SaveSection {
    /// `inlineUserError`'s object for this section.
    pub(super) fn object(self) -> &'static str {
        match self {
            Self::Persona => "the changes",
            Self::Reactions => "the reactions",
            Self::Motion => "the motion",
            Self::Greetings => "the greetings",
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
