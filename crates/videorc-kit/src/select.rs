//! Select (`components/ui/select.tsx`): gpui-base's Select for the
//! behaviour (the combobox role, the arrows open it and move the highlight,
//! Enter and Space choose, Escape closes and focus returns), the trigger and
//! the popup of the float glass from the tokens: a 28 px `input/50` trigger
//! with its chevron, and a list at least as wide as the trigger, whose
//! highlighted row is the accent block and whose chosen row has a check.

use std::rc::Rc;

use gpui::{
    App, Bounds, ElementId, FocusHandle, IntoElement, Pixels, SharedString, Window, deferred, div,
    prelude::*, px,
};
use gpui_base::{
    Align, DeferredPopover, ElementExt, GlobalState, POPUP_PRIORITY, Placement, Positioner,
    actions::{SelectDown, SelectUp},
};

use crate::{
    icon::{IconName, icon},
    motion::{floating, presence},
    popover::popup_glass,
    theme::{Appearance, FONT, faded_over, hsla, resolve, with_alpha},
    tokens::{Color, radius, size},
};

type ChangeHandler = Rc<dyn Fn(SharedString, &mut Window, &mut App)>;

/// One choice in a [`Select`].
#[derive(Clone)]
pub struct SelectOption {
    value: SharedString,
    label: SharedString,
    disabled: bool,
}

impl SelectOption {
    pub fn new(value: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        SelectOption {
            value: value.into(),
            label: label.into(),
            disabled: false,
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

#[derive(IntoElement)]
pub struct Select {
    id: ElementId,
    options: Vec<SelectOption>,
    value: Option<SharedString>,
    placeholder: SharedString,
    disabled: bool,
    width: Option<f32>,
    ground: Option<Color>,
    accessibility_label: Option<SharedString>,
    on_change: Option<ChangeHandler>,
    appearance: Option<Appearance>,
}

impl Select {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Select {
            id: id.into(),
            options: Vec::new(),
            value: None,
            placeholder: SharedString::default(),
            disabled: false,
            width: None,
            ground: None,
            accessibility_label: None,
            on_change: None,
            appearance: None,
        }
    }

    /// One option: the value reported and the words shown.
    pub fn option(
        mut self,
        value: impl Into<SharedString>,
        label: impl Into<SharedString>,
    ) -> Self {
        self.options.push(SelectOption::new(value, label));
        self
    }

    /// One option that may be disabled (greyed, skipped by keys, not choosable).
    pub fn option_item(mut self, option: SelectOption) -> Self {
        self.options.push(option);
        self
    }

    pub fn value(mut self, value: Option<SharedString>) -> Self {
        self.value = value;
        self
    }

    pub fn placeholder(mut self, placeholder: impl Into<SharedString>) -> Self {
        self.placeholder = placeholder.into();
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// The trigger's width; it fits its words otherwise (`w-fit`).
    pub fn width(mut self, width: f32) -> Self {
        self.width = Some(width);
        self
    }

    /// The colour the trigger sits on, for the disabled pre-blend.
    pub fn ground(mut self, ground: Color) -> Self {
        self.ground = Some(ground);
        self
    }

    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.accessibility_label = Some(label.into());
        self
    }

    /// Called with the chosen option's value.
    pub fn on_change(
        mut self,
        handler: impl Fn(SharedString, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

/// What a select keeps between frames: open or not, the highlighted row,
/// where its trigger is, and its claim on the window's popups.
struct SelectOpen {
    open: bool,
    highlighted: usize,
    bounds: Bounds<Pixels>,
    trigger_focus: FocusHandle,
    content_focus: FocusHandle,
    popup: Option<DeferredPopover>,
}

impl SelectOpen {
    fn set_open(&mut self, open: bool, highlighted: usize, cx: &mut App) {
        self.open = open;
        self.highlighted = highlighted;
        self.popup = open.then(|| GlobalState::register_deferred_popover(cx));
    }
}

impl RenderOnce for Select {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let ground = self.ground.unwrap_or(t.glass_solid);
        let disabled = self.disabled;
        let state = window.use_keyed_state(self.id.clone(), cx, |_, cx| SelectOpen {
            open: false,
            highlighted: 0,
            bounds: Bounds::default(),
            trigger_focus: cx.focus_handle(),
            content_focus: cx.focus_handle(),
            popup: None,
        });
        let (open, highlighted, bounds, trigger_focus, content_focus) = {
            let s = state.read(cx);
            (
                s.open,
                s.highlighted,
                s.bounds,
                s.trigger_focus.clone(),
                s.content_focus.clone(),
            )
        };
        let sample = presence(
            SharedString::from(format!("{}/motion", self.id)),
            open,
            window,
            cx,
        );
        let progress = sample.progress;
        let options = Rc::new(self.options);
        let chosen = self
            .value
            .as_ref()
            .and_then(|value| options.iter().position(|option| &option.value == value));
        let shown = chosen.map(|index| options[index].label.clone());
        let on_change = self.on_change;
        let count = options.len();
        let enabled: Vec<bool> = options.iter().map(|option| !option.disabled).collect();

        // Opening highlights the chosen row, or the first enabled.
        let open_at = chosen
            .filter(|&index| enabled.get(index).copied().unwrap_or(false))
            .or_else(|| enabled.iter().position(|on| *on))
            .unwrap_or(0);
        let toggle = {
            let state = state.clone();
            move |window: &mut Window, cx: &mut App| {
                let content_focus = state.read(cx).content_focus.clone();
                let now_open = !state.read(cx).open;
                state.update(cx, |s, cx| s.set_open(now_open, open_at, cx));
                if now_open {
                    content_focus.focus(window, cx);
                }
            }
        };
        let choose = {
            let state = state.clone();
            let options = options.clone();
            let on_change = on_change.clone();
            Rc::new(move |index: usize, window: &mut Window, cx: &mut App| {
                let Some(option) = options.get(index) else {
                    return;
                };
                if option.disabled {
                    return;
                }
                let trigger_focus = state.read(cx).trigger_focus.clone();
                state.update(cx, |s, cx| s.set_open(false, index, cx));
                trigger_focus.focus(window, cx);
                if let Some(on_change) = on_change.as_ref() {
                    on_change(option.value.clone(), window, cx);
                }
            })
        };
        let fade = |color: Color| {
            if disabled {
                faded_over(color, ground, 0.5)
            } else {
                color
            }
        };

        let trigger = div()
            .id("select-trigger")
            .flex()
            .items_center()
            .justify_between()
            .gap(px(6.0))
            .h(px(size::CONTROL))
            .px(px(10.0))
            .when_some(self.width, |trigger, width| trigger.w(px(width)))
            .rounded(px(radius::CHIP))
            .border_1()
            .border_color(hsla(if open {
                t.ring
            } else {
                with_alpha(t.border, 0.0)
            }))
            .bg(hsla(fade(with_alpha(t.input, 0.5))))
            .whitespace_nowrap()
            .child(
                div()
                    .text_color(hsla(fade(if shown.is_some() {
                        t.foreground
                    } else {
                        t.muted_foreground
                    })))
                    .child(shown.clone().unwrap_or(self.placeholder.clone())),
            )
            .child(icon(
                IconName::CaretDown,
                16.0,
                hsla(fade(t.muted_foreground)),
            ))
            .when(!disabled, |trigger| {
                let toggle = toggle.clone();
                trigger.on_click(move |_, window, cx| toggle(window, cx))
            })
            .on_prepaint({
                let state = state.clone();
                move |bounds, _, cx| state.update(cx, |s, _| s.bounds = bounds)
            });

        // Drawn while open and for the 100 ms fade out after.
        let popup = sample.should_render().then(|| {
            let rows = options.iter().enumerate().map(|(index, option)| {
                let choose = choose.clone();
                let hover_state = state.clone();
                let option_disabled = option.disabled;
                div()
                    .id(index)
                    .relative()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .min_h(px(28.0))
                    .py(px(4.0))
                    .pl(px(8.0))
                    .pr(px(32.0))
                    .rounded(px(radius::CHIP))
                    .when(option_disabled, |row| {
                        row.opacity(0.5).text_color(hsla(t.muted_foreground))
                    })
                    .when(index == highlighted && !option_disabled, |row| {
                        row.bg(hsla(t.accent)).text_color(hsla(t.accent_foreground))
                    })
                    .on_hover(move |hovered, _, cx| {
                        if *hovered && !option_disabled {
                            hover_state.update(cx, |s, cx| {
                                s.highlighted = index;
                                cx.notify();
                            });
                        }
                    })
                    .on_click(move |_, window, cx| {
                        // A fading copy takes no input.
                        if open {
                            choose(index, window, cx);
                        }
                    })
                    .child(option.label.clone())
                    .when(Some(index) == chosen, |row| {
                        row.child(div().absolute().right(px(8.0)).child(icon(
                            IconName::Check,
                            16.0,
                            hsla(t.foreground),
                        )))
                    })
            });
            let step = |delta: isize| {
                let state = state.clone();
                let enabled = enabled.clone();
                move |window: &mut Window, cx: &mut App| {
                    let _ = window;
                    state.update(cx, |s, cx| {
                        if !enabled.iter().any(|on| *on) {
                            return;
                        }
                        let last = count.saturating_sub(1) as isize;
                        let mut next = s.highlighted as isize;
                        for _ in 0..count.max(1) {
                            next = (next + delta).rem_euclid(last + 1);
                            if enabled.get(next as usize).copied().unwrap_or(false) {
                                s.highlighted = next as usize;
                                break;
                            }
                        }
                        cx.notify();
                    });
                }
            };
            let down = step(1);
            let up = step(-1);
            let close = toggle.clone();
            deferred(
                Positioner::side(bounds)
                    .placement(Placement::Bottom)
                    .align(Align::Start)
                    .offset(px(6.0))
                    .margin(px(8.0))
                    .child(
                        floating(
                            popup_glass(t),
                            progress,
                            div().flex().flex_col().children(rows),
                        )
                        .id("select-content")
                        .occlude()
                        .track_focus(&content_focus)
                        .min_w(px(f32::from(bounds.size.width).max(144.0)))
                        .p(px(4.0))
                        .font_family(FONT)
                        .text_size(px(14.0))
                        .text_color(hsla(t.popover_foreground))
                        .on_action(move |_: &SelectDown, window, cx| down(window, cx))
                        .on_action(move |_: &SelectUp, window, cx| up(window, cx))
                        .on_mouse_down_out(move |_, window, cx| {
                            // Only while open: a fading copy takes no input.
                            if open {
                                close(window, cx);
                            }
                        }),
                    ),
            )
            .with_priority(POPUP_PRIORITY)
        });

        let mut select = gpui_base::Select::new(self.id)
            .open(open)
            .disabled(disabled)
            .focus_handle(&trigger_focus)
            .content_focus_handle(&content_focus)
            .on_open_change({
                let state = state.clone();
                move |now_open, _, cx| state.update(cx, |s, cx| s.set_open(now_open, open_at, cx))
            })
            .on_confirm({
                let state = state.clone();
                let choose = choose.clone();
                move |window, cx| {
                    let index = state.read(cx).highlighted;
                    choose(index, window, cx);
                }
            });
        if let Some(value) = shown {
            select = select.accessibility_value(value);
        }
        if let Some(label) = self.accessibility_label {
            select = select.accessibility_label(label);
        }
        select
            .font_family(FONT)
            .text_size(px(14.0))
            .child(trigger)
            .children(popup)
    }
}
