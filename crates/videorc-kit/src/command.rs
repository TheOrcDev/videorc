//! Command palette parts, beside components/ui/command.tsx. The app owns
//! filtering, the selected command and its dispatch; these parts own the
//! palette's one surface and scale. The input keeps gpui-base's editing,
//! IME and accessibility. Rows remain keyboard-accessible buttons.
use crate::{
    dialog::{Dialog, DialogHandle},
    icon::{IconName, icon},
    theme::{current, hsla, with_alpha},
    tokens::radius,
};
use gpui::{
    AnyElement, App, ElementId, Entity, IntoElement, ParentElement, ScrollHandle, SharedString,
    Window, div, prelude::*, px,
};
use gpui_base::input::InputEditorStyle;
pub use gpui_base::input::{InputEvent, InputState};

pub fn command_dialog(id: impl Into<ElementId>, handle: &DialogHandle) -> Dialog {
    Dialog::new(id, handle, "Search").palette()
}

#[derive(IntoElement)]
pub struct CommandInput {
    state: Entity<InputState>,
}
impl CommandInput {
    pub fn new(state: &Entity<InputState>) -> Self {
        Self {
            state: state.clone(),
        }
    }
}
impl RenderOnce for CommandInput {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = current(window, cx).theme();
        self.state.update(cx, |state, cx| {
            state.set_editor_style(InputEditorStyle {
                foreground: hsla(t.foreground),
                muted_foreground: hsla(t.muted_foreground),
                background: gpui::transparent_black(),
                border: gpui::transparent_black(),
                selection: hsla(with_alpha(t.foreground, 0.2)),
                caret: hsla(t.foreground),
                ..Default::default()
            })
        });
        div()
            .h(px(56.))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(12.))
            .px(px(16.))
            .border_b_1()
            .border_color(hsla(t.border))
            .child(icon(
                IconName::MagnifyingGlass,
                24.,
                hsla(t.muted_foreground),
            ))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_size(px(18.))
                    .child(self.state),
            )
    }
}

#[derive(IntoElement)]
pub struct CommandItem {
    id: ElementId,
    title: SharedString,
    selected: bool,
    disabled: bool,
    children: Vec<AnyElement>,
    on_click: Option<std::rc::Rc<dyn Fn(&gpui::ClickEvent, &mut Window, &mut App)>>,
}
impl CommandItem {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            selected: false,
            disabled: false,
            children: Vec::new(),
            on_click: None,
        }
    }
    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
    pub fn on_click(
        mut self,
        handler: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(std::rc::Rc::new(handler));
        self
    }
}
impl ParentElement for CommandItem {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}
impl RenderOnce for CommandItem {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = current(window, cx).theme();
        gpui_base::Button::new(self.id)
            .disabled(self.disabled)
            .accessibility_label(self.title.clone())
            .w_full()
            // `CommandItem` is 40 px and never shrinks: `CommandList` is a
            // capped scroll column, and a shrinkable row there was squeezed to
            // its text height once the list ran past 384 px.
            .flex_none()
            .h(px(40.))
            .px(px(10.))
            .flex()
            .items_center()
            // Rows read from the leading edge, as cmdk's do; `Button`
            // centres its content unless told otherwise, so a row with no
            // shortcut or context drew its title in the middle.
            .justify_start()
            .gap(px(8.))
            .rounded(px(radius::CHIP))
            .text_size(px(14.))
            .text_color(hsla(if self.disabled {
                t.muted_foreground
            } else {
                t.foreground
            }))
            .when(self.selected, |row| row.bg(hsla(t.accent)))
            .hover(|row| row.bg(hsla(t.accent)))
            .child(self.title)
            .children(self.children)
            .when_some(self.on_click, |row, f| {
                row.on_click(move |e, w, cx| f(e, w, cx))
            })
    }
}

#[derive(IntoElement)]
pub struct CommandList {
    id: ElementId,
    scroll: ScrollHandle,
    children: Vec<AnyElement>,
}
impl CommandList {
    pub fn new(id: impl Into<ElementId>, scroll: &ScrollHandle) -> Self {
        Self {
            id: id.into(),
            scroll: scroll.clone(),
            children: Vec::new(),
        }
    }
}
impl ParentElement for CommandList {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}
impl RenderOnce for CommandList {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        div()
            .id(self.id)
            .max_h(px(384.))
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .p(px(6.))
            .flex()
            .flex_col()
            .children(self.children)
    }
}
