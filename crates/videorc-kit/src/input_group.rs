//! InputGroup (`components/ui/input-group.tsx`): one recessed field with
//! addons inside — the 28 px control height and chip radius on the group,
//! focus and invalid rings around all of it. Put text, a Kbd, or a compact
//! button in [`InputGroupAddon`]; the control is a plain [`Input`].

use gpui::{
    AnyElement, App, ElementId, Entity, IntoElement, SharedString, Window, div, prelude::*, px,
};
use smallvec::SmallVec;

use crate::{
    chrome::box_shadow,
    input::{Input, InputState},
    theme::{Appearance, hsla, resolve, with_alpha},
    tokens::{Color, Shadow, radius, size},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum InputGroupAddonAlign {
    #[default]
    InlineStart,
    InlineEnd,
}

#[derive(IntoElement)]
pub struct InputGroup {
    id: ElementId,
    state: Entity<InputState>,
    disabled: bool,
    readonly: bool,
    invalid: bool,
    start: SmallVec<[AnyElement; 2]>,
    end: SmallVec<[AnyElement; 2]>,
    ground: Option<Color>,
    accessibility_label: Option<SharedString>,
    appearance: Option<Appearance>,
}

impl InputGroup {
    pub fn new(id: impl Into<ElementId>, state: &Entity<InputState>) -> Self {
        InputGroup {
            id: id.into(),
            state: state.clone(),
            disabled: false,
            readonly: false,
            invalid: false,
            start: SmallVec::new(),
            end: SmallVec::new(),
            ground: None,
            accessibility_label: None,
            appearance: None,
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// `readOnly` control (Guests' invite link beside its Link addon): it
    /// selects and copies but never edits, in full colour.
    pub fn readonly(mut self, readonly: bool) -> Self {
        self.readonly = readonly;
        self
    }

    pub fn invalid(mut self, invalid: bool) -> Self {
        self.invalid = invalid;
        self
    }

    /// Addon before the input (prefix text, icon, Kbd).
    pub fn start(mut self, addon: impl IntoElement) -> Self {
        self.start.push(addon.into_any_element());
        self
    }

    /// Addon after the input.
    pub fn end(mut self, addon: impl IntoElement) -> Self {
        self.end.push(addon.into_any_element());
        self
    }

    pub fn ground(mut self, ground: Color) -> Self {
        self.ground = Some(ground);
        self
    }

    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.accessibility_label = Some(label.into());
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

#[derive(IntoElement)]
pub struct InputGroupAddon {
    align: InputGroupAddonAlign,
    children: SmallVec<[AnyElement; 2]>,
    appearance: Option<Appearance>,
}

impl InputGroupAddon {
    pub fn start() -> Self {
        InputGroupAddon {
            align: InputGroupAddonAlign::InlineStart,
            children: SmallVec::new(),
            appearance: None,
        }
    }

    pub fn end() -> Self {
        InputGroupAddon {
            align: InputGroupAddonAlign::InlineEnd,
            children: SmallVec::new(),
            appearance: None,
        }
    }

    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl ParentElement for InputGroupAddon {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for InputGroupAddon {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let pad = match self.align {
            InputGroupAddonAlign::InlineStart => div().pl(px(8.0)).pr(px(2.0)),
            InputGroupAddonAlign::InlineEnd => div().pr(px(8.0)).pl(px(2.0)),
        };
        pad.flex()
            .flex_none()
            .items_center()
            .gap(px(8.0))
            .text_size(px(14.0))
            .line_height(px(20.0))
            .font_weight(gpui::FontWeight::MEDIUM)
            .text_color(hsla(t.muted_foreground))
            .children(self.children)
    }
}

#[derive(IntoElement)]
pub struct InputGroupText {
    words: SharedString,
    appearance: Option<Appearance>,
}

impl InputGroupText {
    pub fn new(words: impl Into<SharedString>) -> Self {
        InputGroupText {
            words: words.into(),
            appearance: None,
        }
    }

    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl RenderOnce for InputGroupText {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        div()
            .flex()
            .items_center()
            .gap(px(8.0))
            .text_size(px(14.0))
            .text_color(hsla(t.muted_foreground))
            .child(self.words)
    }
}

fn ring(color: Color) -> gpui::BoxShadow {
    box_shadow(&Shadow {
        inset: false,
        x: 0.0,
        y: 0.0,
        blur: 0.0,
        spread: 3.0,
        color,
    })
}

impl RenderOnce for InputGroup {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let ground = self.ground.unwrap_or(t.glass_solid);
        let disabled = self.disabled;
        let focused = {
            let state = self.state.read(cx);
            use gpui::Focusable;
            state.focus_handle(cx).is_focused(window) || state.has_selection_focus(window, cx)
        };
        let (rim, focus_rim, focus_ring) = if self.invalid {
            (t.destructive, t.destructive, with_alpha(t.destructive, 0.2))
        } else {
            (with_alpha(t.border, 0.0), t.ring, with_alpha(t.ring, 0.3))
        };

        let mut control = Input::new((self.id.clone(), "control"), &self.state)
            .plain(true)
            .disabled(disabled)
            .readonly(self.readonly)
            .invalid(self.invalid)
            .ground(ground);
        if let Some(appearance) = self.appearance {
            control = control.appearance(appearance);
        }
        if let Some(label) = self.accessibility_label {
            control = control.accessibility_label(label);
        }

        div()
            .id(self.id)
            .role(gpui::Role::Group)
            .flex()
            .w_full()
            .min_w(px(0.0))
            .h(px(size::CONTROL))
            .items_center()
            .rounded(px(radius::CHIP))
            .border_1()
            .border_color(hsla(if focused { focus_rim } else { rim }))
            .bg(hsla(with_alpha(t.input, 0.5)))
            .when(focused, |group| group.shadow(vec![ring(focus_ring)]))
            // `has-disabled:opacity-50`: the group, addons and text fade as
            // one, once (the plain control inside skips its own fade).
            .when(disabled, |group| group.opacity(0.5))
            .children(self.start)
            .child(div().flex_1().min_w(px(0.0)).h_full().child(control))
            .children(self.end)
    }
}
