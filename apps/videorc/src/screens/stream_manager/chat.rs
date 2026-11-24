//! The chat pane (P957–P982): filters and the composer wait on later
//! slices; the empty off-air words are here.

use gpui::{AnyElement, IntoElement, div, prelude::*, px};
use videorc_app_core::stream_manager::copy::{CHAT_PANE, START_A_LIVESTREAM};
use videorc_kit::empty::Empty;

/// The chat pane body while nothing is on air.
pub fn chat_pane() -> AnyElement {
    div()
        .id("chat-pane")
        .size_full()
        .flex()
        .flex_col()
        .aria_label(CHAT_PANE)
        .child(
            div()
                .flex_1()
                .min_h(px(0.))
                .flex()
                .items_center()
                .justify_center()
                .px(px(16.))
                .child(Empty::new().description(START_A_LIVESTREAM)),
        )
        .into_any_element()
}
