//! Spinner (`components/ui/spinner.tsx`): the registry's SpinnerIcon
//! (Phosphor's CircleNotch) turning once a second, linear, the way
//! Tailwind's `animate-spin` does. One spinner everywhere work is in flight.
//! It announces itself as a status ("Loading", or the label it is given);
//! one beside its own words (a busy button's label) is `hidden` and stays
//! silent. 16 px in the foreground unless told otherwise. Reduce Motion
//! stops the turn.

use std::time::Duration;

use gpui::{
    Animation, AnimationExt, App, ElementId, IntoElement, Role, SharedString, Transformation,
    Window, div, percentage, prelude::*,
};

use crate::{
    icon::{IconName, icon},
    theme::{Appearance, hsla, motion, resolve},
    tokens::Color,
};

/// One turn.
pub const TURN: Duration = Duration::from_secs(1);

#[derive(IntoElement)]
pub struct Spinner {
    id: ElementId,
    size: f32,
    color: Option<Color>,
    label: SharedString,
    hidden: bool,
    appearance: Option<Appearance>,
}

impl Spinner {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Spinner {
            id: id.into(),
            size: 16.0,
            color: None,
            label: "Loading".into(),
            hidden: false,
            appearance: None,
        }
    }

    pub fn size(mut self, size: f32) -> Self {
        self.size = size;
        self
    }

    /// The colour of the words it sits with; the foreground by default.
    pub fn color(mut self, color: Color) -> Self {
        self.color = Some(color);
        self
    }

    /// What it announces instead of "Loading".
    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = label.into();
        self
    }

    /// Silent: its own words, or a parent, already say what is loading.
    pub fn hidden(mut self, hidden: bool) -> Self {
        self.hidden = hidden;
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl RenderOnce for Spinner {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let glyph = icon(
            IconName::CircleNotch,
            self.size,
            hsla(self.color.unwrap_or(t.foreground)),
        );
        let glyph = if motion(cx) {
            glyph
                .with_animation(
                    SharedString::from(format!("{}/turn", self.id)),
                    Animation::new(TURN).repeat().with_max_fps(60.0),
                    |glyph, delta| {
                        glyph.with_transformation(Transformation::rotate(percentage(delta)))
                    },
                )
                .into_any_element()
        } else {
            glyph.into_any_element()
        };
        let spinner = div().id(self.id).flex_none().child(glyph);
        if self.hidden {
            spinner
        } else {
            spinner.role(Role::Status).aria_label(self.label)
        }
    }
}
