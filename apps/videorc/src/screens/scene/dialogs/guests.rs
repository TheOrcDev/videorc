//! Guests in the room… (`scene-dialogs.tsx`, `lib/scene-guest-roles.ts`,
//! `shared/cloud-scene.ts`'s `defaultSceneGuests`; P473, P480): where a
//! talk show's guests go while this scene is on the room program, saved as
//! the scene's versioned `cloud` extension. The core has no twin yet, so
//! the roles are ported here, number for number.

use gpui::{AnyElement, Context, Window, div, prelude::*, px};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use videorc_app_core::scenes::model::SavedScene;
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogSize};
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::super::now_iso;
use super::SceneDialogs;

/// `SCENE_EXTENSION_VERSION`.
const SCENE_EXTENSION_VERSION: u64 = 1;
/// `SCENE_MAX_GUEST_SLOTS`.
const SCENE_MAX_GUEST_SLOTS: usize = 6;

pub(super) mod copy {
    pub const TITLE: &str = "Guests in the room";
    pub const MENU_ITEM: &str = "Guests in the room…";
    pub const LABEL: &str = "Guests";
    pub const OVER: &str =
        "The scene fills the frame; guests sit in small boxes along its bottom edge.";
    pub const BELOW: &str = "The scene sits above; guests share a band along the bottom.";
    pub const BESIDE: &str = "The scene sits to one side; guests share the rest of the frame.";
    pub const SAVE_FAILED: &str = "Couldn't save. Check your free space, then try again.";
    pub const CANCEL: &str = "Cancel";
    pub const SAVE: &str = "Save";

    pub fn description(name: &str) -> String {
        format!(
            "Where guests go while “{name}” is on a talk show’s program. The scene keeps its own layout."
        )
    }
}

/// `SceneGuestPlacement`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Placement {
    Beside,
    Below,
    Over,
}

impl Placement {
    const ALL: [Placement; 3] = [Placement::Beside, Placement::Below, Placement::Over];

    fn value(self) -> &'static str {
        match self {
            Placement::Beside => "beside",
            Placement::Below => "below",
            Placement::Over => "over",
        }
    }

    /// `SCENE_GUEST_PLACEMENT_LABELS`.
    fn label(self) -> &'static str {
        match self {
            Placement::Beside => "Beside",
            Placement::Below => "Below",
            Placement::Over => "Over the scene",
        }
    }

    fn line(self) -> &'static str {
        match self {
            Placement::Beside => copy::BESIDE,
            Placement::Below => copy::BELOW,
            Placement::Over => copy::OVER,
        }
    }

    fn of(value: &str) -> Option<Placement> {
        Placement::ALL
            .into_iter()
            .find(|placement| placement.value() == value)
    }
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> Value {
    json!({"x": x, "y": y, "w": w, "h": h})
}

/// `defaultSceneGuests`.
fn default_guests(vertical: bool) -> Value {
    if vertical {
        json!({"host": rect(0.15, 0.0, 0.7, 0.7), "region": rect(0.0, 0.7, 1.0, 0.3), "slots": []})
    } else {
        json!({"host": rect(0.0, 0.125, 0.75, 0.75), "region": rect(0.75, 0.0, 0.25, 1.0), "slots": []})
    }
}

/// `overSlots`: small 16:9 boxes over the bottom edge.
fn over_slots(vertical: bool) -> Vec<Value> {
    (0..SCENE_MAX_GUEST_SLOTS)
        .map(|i| {
            if vertical {
                rect(
                    0.035 + (i % 3) as f64 * 0.32,
                    0.78 + (i / 3) as f64 * 0.105,
                    0.3,
                    0.095,
                )
            } else {
                rect(0.02 + i as f64 * 0.16, 0.81, 0.15, 0.15)
            }
        })
        .collect()
}

/// `sceneGuestRoles`.
fn guest_roles(placement: Placement, vertical: bool) -> Value {
    match placement {
        Placement::Below => json!({
            "host": rect(0.125, 0.0, 0.75, 0.75),
            "region": rect(0.0, 0.75, 1.0, 0.25),
            "slots": [],
        }),
        Placement::Over => json!({
            "host": rect(0.0, 0.0, 1.0, 1.0),
            "region": rect(0.0, 0.78, 1.0, 0.22),
            "slots": over_slots(vertical),
        }),
        Placement::Beside => default_guests(vertical),
    }
}

/// `sceneGuestPlacement`: `beside` unless the scene keeps a known one.
fn scene_placement(scene: &SavedScene) -> Placement {
    scene
        .cloud
        .as_ref()
        .filter(|cloud| {
            cloud.get("version").and_then(Value::as_u64) == Some(SCENE_EXTENSION_VERSION)
        })
        .and_then(|cloud| cloud.get("placement").and_then(Value::as_str))
        .and_then(Placement::of)
        .unwrap_or(Placement::Beside)
}

/// `sceneWithGuestRoles`: the scene's orientation is its preset's.
fn scene_with_guest_roles(scene: &SavedScene, placement: Placement, now: &str) -> SavedScene {
    let vertical = scene.layout_preset().starts_with("vertical-");
    SavedScene {
        updated_at: now.to_string(),
        cloud: Some(json!({
            "version": SCENE_EXTENSION_VERSION,
            "placement": placement.value(),
            "guests": guest_roles(placement, vertical),
        })),
        ..scene.clone()
    }
}

/// The dialog while it is open.
pub(super) struct Guesting {
    scene: SavedScene,
    placement: Placement,
    failed: bool,
    busy: bool,
}

impl SceneDialogs {
    pub(super) fn show_guests(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(scene) = self
            .studio
            .watch()
            .borrow()
            .scenes
            .scenes
            .iter()
            .find(|scene| scene.id == id)
            .cloned()
        else {
            return;
        };
        self.guesting = Some(Guesting {
            placement: scene_placement(&scene),
            scene,
            failed: false,
            busy: false,
        });
        self.guests.open(window, cx);
        cx.notify();
    }

    fn save_guests(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(guesting) = &mut self.guesting else {
            return;
        };
        if guesting.busy {
            return;
        }
        guesting.busy = true;
        let next = scene_with_guest_roles(&guesting.scene, guesting.placement, &now_iso());
        let studio = self.studio.clone();
        let (done, answer) = oneshot::channel();
        self.run(async move {
            let _ = done.send(studio.replace_listed_scene(&next).await);
        });
        cx.spawn_in(window, async move |this, cx| {
            let saved = answer.await.unwrap_or(false);
            let _ = this.update_in(cx, |page, window, cx| {
                if saved {
                    page.succeeded = true;
                    page.guesting = None;
                    page.guests.close(window, cx);
                } else if let Some(guesting) = &mut page.guesting {
                    guesting.busy = false;
                    guesting.failed = true;
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn guests_dialog(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(guesting) = &self.guesting else {
            return div().into_any_element();
        };
        let t = theme::resolve(None, window, cx);
        let (line, ink) = if guesting.failed {
            (copy::SAVE_FAILED, hsla(t.destructive))
        } else {
            (guesting.placement.line(), hsla(t.muted_foreground))
        };
        let placement_page = cx.entity().downgrade();
        let mut control = SegmentedControl::new("scene-guests-placement")
            .accessibility_label(copy::LABEL)
            .small(true)
            .value(Some(guesting.placement.value()))
            .on_change(move |value, _, cx| {
                let _ = placement_page.update(cx, |page, cx| {
                    if let (Some(guesting), Some(placement)) =
                        (&mut page.guesting, Placement::of(value.as_ref()))
                    {
                        guesting.placement = placement;
                        guesting.failed = false;
                        cx.notify();
                    }
                });
            });
        for placement in Placement::ALL {
            control = control.option(Segment::new(placement.value(), placement.label()));
        }
        let page = cx.entity().downgrade();
        Dialog::new("scene-guests-dialog", &self.guests, copy::TITLE)
            .size(DialogSize::Sm)
            .description(copy::description(&guesting.scene.name))
            .on_open_change(move |open, _, _, cx| {
                if !open {
                    let _ = page.update(cx, |page, cx| {
                        page.guesting = None;
                        cx.notify();
                    });
                }
            })
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(div().type_scale(text::LABEL).child(copy::LABEL))
                    .child(control)
                    .child(div().type_scale(text::META).text_color(ink).child(line)),
            )
            .footer(
                Button::new("scene-guests-cancel")
                    .label(copy::CANCEL)
                    .variant(ButtonVariant::Ghost)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.guesting = None;
                        this.guests.close(window, cx);
                    })),
            )
            .footer(
                Button::new("scene-guests-save")
                    .label(copy::SAVE)
                    .disabled(guesting.busy)
                    .on_click(cx.listener(|this, _, window, cx| this.save_guests(window, cx))),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn over_slots_match_electrons_boxes() {
        let slots = over_slots(false);
        assert_eq!(slots.len(), 6);
        assert_eq!(slots[0], rect(0.02, 0.81, 0.15, 0.15));
        assert_eq!(slots[5], rect(0.02 + 5.0 * 0.16, 0.81, 0.15, 0.15));
        let portrait = over_slots(true);
        assert_eq!(portrait[4], rect(0.035 + 0.32, 0.78 + 0.105, 0.3, 0.095));
    }

    #[test]
    fn placement_reads_only_a_known_version() {
        assert_eq!(Placement::of("over"), Some(Placement::Over));
        assert_eq!(Placement::of("sideways"), None);
    }
}
