//! The activity pane (P983–P989): kind chips wait on later slices; the
//! empty words are here.

use gpui::{AnyElement, IntoElement, div, prelude::*, px};
use videorc_kit::empty::Empty;

/// Electron's empty copy (`activity-pane.tsx`).
const ACTIVITY_EMPTY: &str = "Follows, subs, gifts, tips and raids appear here as they happen.";
const ACTIVITY_PANE: &str = "Activity";

/// The activity pane body while nothing has happened.
pub fn activity_pane() -> AnyElement {
    div()
        .id("activity-pane")
        .size_full()
        .flex()
        .flex_col()
        .aria_label(ACTIVITY_PANE)
        .child(
            div()
                .flex_1()
                .min_h(px(0.))
                .flex()
                .items_center()
                .justify_center()
                .px(px(16.))
                .child(Empty::new().description(ACTIVITY_EMPTY)),
        )
        .into_any_element()
}
