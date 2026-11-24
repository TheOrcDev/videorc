//! Skeleton: a muted placeholder that pulses where content is loading, on
//! the 8 px row radius (`components/ui/skeleton.tsx`). The caller sizes it
//! like any element (`Skeleton::new("chat").w_full().h(px(32.))`).
//!
//! The pulse is Tailwind's: full opacity, down to half and back every 2 s.
//! It runs on GPUI's animation clock at 60 fps at most, only while the
//! skeleton is on screen, and holds still under Reduce Motion.

use std::time::Duration;

use gpui::{
    Animation, AnimationExt, App, Div, ElementId, IntoElement, StyleRefinement, Window, bounce,
    div, ease_in_out, prelude::*, px,
};

use crate::{
    theme::{Appearance, hsla, motion, resolve},
    tokens::radius,
};

/// One pulse, down and back up.
pub const PULSE: Duration = Duration::from_secs(2);

/// The opacity at `delta` (0 to 1) through a pulse: 1, then 0.5 halfway.
pub fn pulse_opacity(delta: f32) -> f32 {
    1.0 - 0.5 * bounce(ease_in_out)(delta.clamp(0.0, 1.0))
}

#[derive(IntoElement)]
pub struct Skeleton {
    id: ElementId,
    base: Div,
    appearance: Option<Appearance>,
}

impl Skeleton {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Skeleton {
            id: id.into(),
            base: div(),
            appearance: None,
        }
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl Styled for Skeleton {
    fn style(&mut self) -> &mut StyleRefinement {
        self.base.style()
    }
}

impl RenderOnce for Skeleton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let block = self.base.rounded(px(radius::ROW)).bg(hsla(t.muted));
        if !motion(cx) {
            return block.into_any_element();
        }
        block
            .with_animation(
                self.id,
                Animation::new(PULSE).repeat().with_max_fps(60.0),
                |block, delta| block.opacity(pulse_opacity(delta)),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pulses_from_full_to_half_and_back() {
        assert!((pulse_opacity(0.0) - 1.0).abs() < 1e-6);
        assert!((pulse_opacity(0.5) - 0.5).abs() < 1e-6);
        assert!((pulse_opacity(1.0) - 1.0).abs() < 1e-6);
        assert!(pulse_opacity(0.25) > 0.5 && pulse_opacity(0.25) < 1.0);
    }
}
