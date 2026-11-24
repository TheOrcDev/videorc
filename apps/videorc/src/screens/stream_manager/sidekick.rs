//! The Sidekick pane (P990–P1006): cards and controls wait on later
//! slices; the empty words are here.

use gpui::{AnyElement, IntoElement, div, prelude::*, px};
use videorc_kit::empty::Empty;

/// Electron's empty copy (`stream-manager.tsx`).
const SIDEKICK_EMPTY: &str =
    "Sidekick reads chat during a live stream: questions, flags and the room's mood.";
const SIDEKICK_PANE: &str = "Sidekick";

/// The Sidekick pane body while nothing is waiting.
pub fn sidekick_pane() -> AnyElement {
    div()
        .id("sidekick-pane")
        .size_full()
        .flex()
        .flex_col()
        .aria_label(SIDEKICK_PANE)
        .child(
            div()
                .flex_1()
                .min_h(px(0.))
                .flex()
                .items_center()
                .justify_center()
                .px(px(16.))
                .child(Empty::new().description(SIDEKICK_EMPTY)),
        )
        .into_any_element()
}
