//! StatusDot (`components/status-dot.tsx`): ambient status, the glass
//! status dot (6 px, its tone, a 2 px halo and a glow), optionally pulsing,
//! and a monochrome 12 px label. It replaces a loud header badge.
//!
//! One tone vocabulary with StatusBadge (`lib/status-word.ts`): `Good`
//! works, `Warn` is degraded, `Error` failed, `Live` is recording or on air,
//! `Neutral` is idle. The label is a word in sentence case, already mapped
//! from its state ("Needs permission"), never a machine value.
//!
//! The pulse is Tailwind's `animate-ping`: a ring of the tone grows to
//! twice the dot and fades out, once a second, on GPUI's animation clock at
//! 60 fps at most. Reduce Motion stills it.

use std::time::Duration;

use gpui::{
    Animation, AnimationExt, App, ElementId, IntoElement, SharedString, Window, div, prelude::*, px,
};

use crate::{
    badge::dot,
    theme::{Appearance, hsla, motion, resolve},
    tokens::{Color, Theme},
};

/// One ping.
pub const PING: Duration = Duration::from_secs(1);
const DOT: f32 = 6.0;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StatusTone {
    Good,
    Warn,
    Error,
    Live,
    #[default]
    Neutral,
}

impl StatusTone {
    /// The tone's colour and its glow (`tone-*`): neutral has no glow.
    pub fn colors(self, t: &Theme) -> (Color, f32) {
        match self {
            StatusTone::Good => (t.success, t.chip_dot_glow),
            StatusTone::Warn => (t.warning, t.chip_dot_glow),
            StatusTone::Error => (t.destructive, t.chip_dot_glow),
            StatusTone::Live => (t.live, t.chip_dot_glow),
            StatusTone::Neutral => (t.muted_foreground, 0.0),
        }
    }
}

/// The ping's size and opacity at `delta` (0 to 1) through it: from the
/// dot at 60% to twice the dot, gone (`ping`, eased out).
pub fn ping(delta: f32) -> (f32, f32) {
    let eased = 1.0 - (1.0 - delta.clamp(0.0, 1.0)).powi(3);
    (DOT * (1.0 + eased), 0.6 * (1.0 - eased))
}

#[derive(IntoElement)]
pub struct StatusDot {
    id: ElementId,
    tone: StatusTone,
    label: Option<SharedString>,
    pulse: bool,
    appearance: Option<Appearance>,
}

impl StatusDot {
    pub fn new(id: impl Into<ElementId>) -> Self {
        StatusDot {
            id: id.into(),
            tone: StatusTone::Neutral,
            label: None,
            pulse: false,
            appearance: None,
        }
    }

    pub fn tone(mut self, tone: StatusTone) -> Self {
        self.tone = tone;
        self
    }

    /// A word in sentence case, already mapped from its state.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// Rings out from the dot while something runs.
    pub fn pulse(mut self, pulse: bool) -> Self {
        self.pulse = pulse;
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl RenderOnce for StatusDot {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let (tone, glow) = self.tone.colors(t);
        let mut mark = div()
            .relative()
            .flex_none()
            .size(px(DOT))
            .flex()
            .items_center()
            .justify_center();
        if self.pulse && motion(cx) {
            mark = mark.child(
                div()
                    .absolute()
                    .rounded_full()
                    .bg(hsla(tone))
                    .with_animation(
                        self.id,
                        Animation::new(PING).repeat().with_max_fps(60.0),
                        |element, delta| {
                            let (size, opacity) = ping(delta);
                            let inset = (DOT - size) / 2.0;
                            element
                                .size(px(size))
                                .left(px(inset))
                                .top(px(inset))
                                .opacity(opacity)
                        },
                    ),
            );
        }
        mark = mark.child(dot(tone, glow));
        div()
            .flex()
            .items_center()
            .gap(px(6.0))
            .text_size(px(12.0))
            .line_height(px(16.0))
            .text_color(hsla(t.muted_foreground))
            .child(mark)
            .children(
                self.label
                    .map(|label| div().min_w(px(0.0)).truncate().child(label)),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tokens::DARK;

    #[test]
    fn the_ping_grows_to_twice_the_dot_and_fades_out() {
        assert_eq!(ping(0.0), (6.0, 0.6));
        let (size, opacity) = ping(1.0);
        assert!((size - 12.0).abs() < 1e-6 && opacity.abs() < 1e-6);
        let (mid, faded) = ping(0.5);
        assert!(mid > 6.0 && mid < 12.0 && faded > 0.0 && faded < 0.6);
    }

    #[test]
    fn neutral_has_no_glow_and_every_tone_its_colour() {
        assert_eq!(
            StatusTone::Neutral.colors(&DARK),
            (DARK.muted_foreground, 0.0)
        );
        assert_eq!(StatusTone::Live.colors(&DARK).0, DARK.live);
        assert_eq!(StatusTone::Error.colors(&DARK).0, DARK.destructive);
        assert_eq!(StatusTone::Good.colors(&DARK).0, DARK.success);
        assert_eq!(StatusTone::Warn.colors(&DARK).0, DARK.warning);
    }
}
