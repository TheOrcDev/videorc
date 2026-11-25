//! Edit → Speech (P1498, macOS): what Start Speaking says. AppKit's role
//! speaks the focused text view's selection, or all its text when nothing
//! is selected; here the text view is the focused text field
//! (`gpui_base::input::InputState`), found among the fields the app has
//! made. With no field focused there is nothing to say, as in Electron.

use gpui::{App, Focusable, Global, WeakEntity, Window};
use gpui_base::input::InputState;

/// Every text field made so far, while it lives.
#[derive(Default)]
struct Fields(Vec<WeakEntity<InputState>>);

impl Global for Fields {}

/// Starts following the text fields the app makes.
pub fn install(cx: &mut App) {
    cx.set_global(Fields::default());
    cx.observe_new(|_: &mut InputState, _, cx| {
        let field = cx.entity().downgrade();
        let fields = &mut cx.global_mut::<Fields>().0;
        fields.retain(|field| field.upgrade().is_some());
        fields.push(field);
    })
    .detach();
}

/// The focused field's selection in `window`, or all its text when nothing
/// is selected; `None` with no field focused.
pub fn focused_text(window: &Window, cx: &App) -> Option<String> {
    let fields = cx.try_global::<Fields>()?;
    let field = fields
        .0
        .iter()
        .filter_map(WeakEntity::upgrade)
        .find(|field| field.read(cx).focus_handle(cx).is_focused(window))?;
    let state = field.read(cx);
    let selected = state.selected_value();
    Some(if selected.is_empty() {
        state.value().to_string()
    } else {
        selected.to_string()
    })
}
