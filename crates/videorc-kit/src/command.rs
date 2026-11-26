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
    AnyElement, App, ElementId, Entity, FontWeight, IntoElement, ParentElement, ScrollHandle,
    SharedString, Window, div, prelude::*, px,
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
        self.state.update(cx, |state, _cx| {
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

/// A command row's click handler.
type ClickHandler = std::rc::Rc<dyn Fn(&gpui::ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct CommandItem {
    id: ElementId,
    title: SharedString,
    selected: bool,
    disabled: bool,
    leading_icon: Option<IconName>,
    children: Vec<AnyElement>,
    on_click: Option<ClickHandler>,
}
impl CommandItem {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            selected: false,
            disabled: false,
            leading_icon: None,
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
    /// Leading 16 px glyph before the title (muted; foreground when selected).
    pub fn icon(mut self, name: IconName) -> Self {
        self.leading_icon = Some(name);
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
        // Selected / default ink: icons and shortcut chips ride this colour.
        let ink = if self.selected {
            t.foreground
        } else {
            t.muted_foreground
        };
        let title_ink = if self.disabled {
            t.muted_foreground
        } else {
            t.foreground
        };
        gpui_base::Button::new(self.id)
            .disabled(self.disabled)
            .accessibility_label(self.title.clone())
            .w_full()
            // `CommandItem` never shrinks: `CommandList` is a capped scroll
            // column, and a shrinkable row there was squeezed to its text
            // height once the list ran past 384 px. `min-h-10 py-1.5`.
            .flex_none()
            .min_h(px(40.))
            .px(px(10.))
            .py(px(6.))
            .flex()
            .items_center()
            // Rows read from the leading edge, as cmdk's do; gpui-base's
            // Button centres its content unless told otherwise.
            .justify_start()
            .gap(px(12.))
            .rounded(px(radius::ROW))
            .text_size(px(14.))
            .text_color(hsla(title_ink))
            .when(self.disabled, |row| row.opacity(0.5))
            .when(self.selected, |row| {
                row.bg(hsla(t.accent)).text_color(hsla(t.foreground))
            })
            .when(!self.disabled, |row| {
                row.hover(|row| row.bg(hsla(t.accent)))
            })
            .children(self.leading_icon.map(|name| icon(name, 16., hsla(ink))))
            .child(self.title)
            .children(self.children)
            .when_some(self.on_click, |row, f| {
                row.on_click(move |e, w, cx| f(e, w, cx))
            })
    }
}

/// Group heading above a block of rows (`px-2.5 pt-3 pb-2`, 12/600, subtle).
#[derive(IntoElement)]
pub struct CommandGroup {
    heading: SharedString,
}
impl CommandGroup {
    pub fn new(heading: impl Into<SharedString>) -> Self {
        Self {
            heading: heading.into(),
        }
    }
}
impl RenderOnce for CommandGroup {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = current(window, cx).theme();
        div()
            .flex_none()
            .px(px(10.))
            .pt(px(12.))
            .pb(px(8.))
            .text_size(px(12.))
            .line_height(px(12.))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(hsla(t.subtle))
            .child(self.heading)
    }
}

/// Hairline between groups (`my-1 h-px bg-border`).
#[derive(IntoElement)]
pub struct CommandSeparator;
impl CommandSeparator {
    pub fn new() -> Self {
        Self
    }
}
impl Default for CommandSeparator {
    fn default() -> Self {
        Self::new()
    }
}
impl RenderOnce for CommandSeparator {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = current(window, cx).theme();
        div()
            .flex_none()
            .my(px(4.))
            .h(px(1.))
            .w_full()
            .bg(hsla(t.border))
    }
}

/// End-slot shortcut chip (12 px muted → foreground when the row is selected).
#[derive(IntoElement)]
pub struct CommandShortcut {
    text: SharedString,
    selected: bool,
}
impl CommandShortcut {
    pub fn new(text: impl Into<SharedString>) -> Self {
        Self {
            text: text.into(),
            selected: false,
        }
    }
    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }
}
impl RenderOnce for CommandShortcut {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = current(window, cx).theme();
        div()
            .ml_auto()
            .flex_none()
            .text_size(px(12.))
            .text_color(hsla(if self.selected {
                t.foreground
            } else {
                t.muted_foreground
            }))
            .child(self.text)
    }
}

/// Palette footer: 40 px, `px-4`, 12 px muted, value left / chip right.
#[derive(IntoElement)]
pub struct CommandFooter {
    children: Vec<AnyElement>,
}
impl CommandFooter {
    pub fn new() -> Self {
        Self {
            children: Vec::new(),
        }
    }
}
impl Default for CommandFooter {
    fn default() -> Self {
        Self::new()
    }
}
impl ParentElement for CommandFooter {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}
impl RenderOnce for CommandFooter {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = current(window, cx).theme();
        div()
            .flex_none()
            .h(px(40.))
            .px(px(16.))
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .border_t_1()
            .border_color(hsla(t.border))
            .text_size(px(12.))
            .text_color(hsla(t.muted_foreground))
            .children(self.children)
    }
}

/// Empty-results line (`py-6`, centred, 14 px muted).
#[derive(IntoElement)]
pub struct CommandEmpty {
    text: SharedString,
}
impl CommandEmpty {
    pub fn new(text: impl Into<SharedString>) -> Self {
        Self { text: text.into() }
    }
}
impl RenderOnce for CommandEmpty {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = current(window, cx).theme();
        div()
            .flex_none()
            .w_full()
            .py(px(24.))
            .flex()
            .justify_center()
            .text_size(px(14.))
            .text_color(hsla(t.muted_foreground))
            .child(self.text)
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
