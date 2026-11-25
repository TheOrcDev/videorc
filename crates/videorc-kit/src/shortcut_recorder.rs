//! ShortcutRecorder: Electron's 176 px (`w-44`) recorder control — an
//! input-group shell with key chips (or a placeholder). Screens own arming
//! and key capture; this is the shared look Output and Settings share.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, IntoElement, SharedString, Window, div, prelude::*, px,
};

use crate::{
    icon::{IconName, icon},
    theme::{Appearance, hsla, resolve, with_alpha},
    tokens::{radius, size},
};

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct ShortcutRecorder {
    id: ElementId,
    /// Accelerator label chips (already built by the screen / ShortcutKeys).
    keys: Option<AnyElement>,
    /// Shown while unarmed and unbound ("Unassigned").
    placeholder: SharedString,
    /// The setting's name ("Start or stop recording"), for the spoken name.
    label: Option<SharedString>,
    /// The binding in words ("⇧⌘R"), for the spoken name.
    value_label: Option<SharedString>,
    tooltip: Option<SharedString>,
    armed: bool,
    invalid: bool,
    disabled: bool,
    on_click: Option<ClickHandler>,
    on_clear: Option<ClickHandler>,
    appearance: Option<Appearance>,
}

impl ShortcutRecorder {
    pub fn new(id: impl Into<ElementId>) -> Self {
        ShortcutRecorder {
            id: id.into(),
            keys: None,
            placeholder: SharedString::from("Unassigned"),
            label: None,
            value_label: None,
            tooltip: None,
            armed: false,
            invalid: false,
            disabled: false,
            on_click: None,
            on_clear: None,
            appearance: None,
        }
    }

    /// Key chips in the field (ShortcutKeys / Kbd group).
    pub fn keys(mut self, keys: impl IntoElement) -> Self {
        self.keys = Some(keys.into_any_element());
        self
    }

    pub fn placeholder(mut self, placeholder: impl Into<SharedString>) -> Self {
        self.placeholder = placeholder.into();
        self
    }

    /// The setting's name. The field is spoken as Electron's
    /// `shortcutRecorderName`: "<label>: <binding>", "<label>: Unassigned",
    /// or "<label>: press the new shortcut" while armed; Clear is "Clear the
    /// <label> shortcut".
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// The binding as inline words (`acceleratorInlineLabel`: "⇧⌘R"), for
    /// the spoken name; the chips themselves come from [`Self::keys`].
    pub fn value_label(mut self, words: impl Into<SharedString>) -> Self {
        self.value_label = Some(words.into());
        self
    }

    /// A tooltip on the field (what the shortcut does, or why it is off).
    pub fn tooltip(mut self, text: impl Into<SharedString>) -> Self {
        self.tooltip = Some(text.into());
        self
    }

    pub fn armed(mut self, armed: bool) -> Self {
        self.armed = armed;
        self
    }

    pub fn invalid(mut self, invalid: bool) -> Self {
        self.invalid = invalid;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }

    /// Clear (X) on the trailing addon when a binding is set.
    pub fn on_clear(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_clear = Some(Rc::new(handler));
        self
    }

    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl RenderOnce for ShortcutRecorder {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let (rim, ring) = if self.invalid && !self.armed {
            (t.destructive, with_alpha(t.destructive, 0.2))
        } else if self.armed {
            (t.ring, with_alpha(t.ring, 0.3))
        } else {
            (with_alpha(t.border, 0.0), with_alpha(t.ring, 0.0))
        };

        let body = if let Some(keys) = self.keys {
            keys
        } else {
            div()
                .text_size(px(12.0))
                .line_height(px(16.0))
                .text_color(hsla(t.muted_foreground))
                .truncate()
                .child(if self.armed {
                    SharedString::from("Press shortcut…")
                } else {
                    self.placeholder.clone()
                })
                .into_any_element()
        };

        let name = self.label.as_ref().map(|label| {
            let state = if self.armed {
                SharedString::from("press the new shortcut")
            } else {
                self.value_label
                    .clone()
                    .unwrap_or_else(|| self.placeholder.clone())
            };
            SharedString::from(format!("{label}: {state}"))
        });
        let clear_name = self
            .label
            .as_ref()
            .map(|label| SharedString::from(format!("Clear the {label} shortcut")))
            .unwrap_or_else(|| SharedString::from("Clear the shortcut"));
        let clear_id = SharedString::from(format!("{}/clear", self.id));
        let mut field = gpui_base::Button::new(self.id)
            .disabled(self.disabled)
            .when_some(name, |field, name| field.accessibility_label(name))
            .when_some(self.tooltip, |field, text| {
                field.tooltip(crate::tooltip::tooltip(text))
            })
            .justify_start()
            .relative()
            .flex()
            .flex_1()
            .min_w(px(0.0))
            .h(px(size::CONTROL))
            .items_center()
            .px(px(10.0))
            .gap(px(6.0))
            .text_size(px(12.0))
            .child(body);
        if let Some(on_click) = self.on_click {
            field = field.on_click(move |e, w, cx| on_click(e, w, cx));
        }

        // Clear shows only while a binding is set and the field is not armed.
        let clear = self.on_clear.filter(|_| !self.armed).map(|on_clear| {
            gpui_base::Button::new(clear_id)
                .disabled(self.disabled)
                .accessibility_label(clear_name)
                .flex_none()
                .size(px(size::CONTROL))
                .items_center()
                .justify_center()
                .child(icon(IconName::X, 14.0, hsla(t.muted_foreground)))
                .on_click(move |e, w, cx| on_clear(e, w, cx))
        });

        div()
            .flex()
            .flex_none()
            .w(px(176.0))
            .h(px(size::CONTROL))
            .items_center()
            .overflow_hidden()
            .rounded(px(radius::CHIP))
            .border_1()
            .border_color(hsla(rim))
            .bg(hsla(with_alpha(t.input, 0.5)))
            .when(self.armed || (self.invalid && !self.armed), |shell| {
                shell.shadow(vec![crate::chrome::box_shadow(&crate::tokens::Shadow {
                    inset: false,
                    x: 0.0,
                    y: 0.0,
                    blur: 0.0,
                    spread: 3.0,
                    color: ring,
                })])
            })
            .child(field)
            .children(clear)
    }
}
