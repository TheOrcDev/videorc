//! How what floats comes and goes, as the React flavour's
//! `animate-in fade-in-0 zoom-in-[0.98]` and `animate-out` do it, in 100 ms
//! (`duration-100`) on CSS's `ease`.
//!
//! The window redraws every frame only while an overlay enters or leaves
//! (gpui-base's `Presence` asks for animation frames only then); Reduce
//! Motion skips straight to the end.
//!
//! GPUI has no element transform (only images and SVGs take one), so the
//! zoom grows the glass panel from 98 % to its size while the content fades
//! in where it will rest; the words are never scaled. GPUI also fades each
//! primitive on its own, so a drop shadow would show through a translucent
//! panel: its ink rises with the cube of the fade.

use std::time::Duration;

use gpui::{App, Div, IntoElement, Window, div, prelude::*, px, relative};
use gpui_base::{Easing, Presence, PresenceSample, Transition, TransitionId};

use crate::{
    chrome::box_shadow,
    theme::{hsla, with_alpha},
    tokens::{Color, Shadow},
};

/// `duration-100`.
pub const OVERLAY: Duration = Duration::from_millis(100);

/// Where an overlay is in its entrance or exit: `should_render()` says
/// whether to draw it, `progress` runs 0 to 1 as it enters and back as it
/// leaves.
pub fn presence(
    id: impl Into<TransitionId>,
    present: bool,
    window: &mut Window,
    cx: &mut App,
) -> PresenceSample {
    Presence::new(id, present)
        .transition(Transition::new(OVERLAY).easing(Easing::Ease))
        .sample(window, cx)
}

/// A floating surface's glass: its fill, rim, drop and radius.
#[derive(Clone, Copy)]
pub struct Glass {
    pub fill: Color,
    pub rim: Color,
    pub drop: &'static [Shadow],
    pub radius: f32,
}

/// A floating surface at `progress`: the glass grows from 98 % of the box
/// and fades in with its drop, and `content` fades in over it. Size and pad
/// the returned box; the glass covers it, padding included.
pub fn floating(glass: Glass, progress: f32, content: impl IntoElement) -> Div {
    let p = progress.clamp(0.0, 1.0);
    // zoom-in-[0.98]: one per cent in from each side at the start.
    let inset = relative(0.01 * (1.0 - p));
    let drop = glass
        .drop
        .iter()
        .filter(|shadow| shadow.color & 0xff != 0)
        .map(|shadow| {
            box_shadow(&Shadow {
                color: with_alpha(shadow.color, p * p * p),
                ..*shadow
            })
        })
        .collect::<Vec<_>>();
    div()
        .relative()
        .child(
            div()
                .absolute()
                .top(inset)
                .bottom(inset)
                .left(inset)
                .right(inset)
                .rounded(px(glass.radius))
                .border_1()
                .border_color(hsla(with_alpha(glass.rim, p)))
                .bg(hsla(with_alpha(glass.fill, p)))
                .shadow(drop),
        )
        // A column that takes what the box leaves, so a dialog's body can
        // still scroll inside it.
        .child(
            div()
                .relative()
                .flex_1()
                .min_h(px(0.0))
                .flex()
                .flex_col()
                .opacity(p)
                .child(content),
        )
}
