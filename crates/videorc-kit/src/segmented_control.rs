//! SegmentedControl (`components/ui/segmented-control.tsx`): pick one of
//! 2–4 exclusive options on the glass Tabs track. gpui-base's RadioGroup
//! and Radio for the radiogroup / radio roles, AccessKit and focus; the
//! kit paints the recessed track and the chrome-plate segment. A Field's
//! label names the group (`accessibility_label`) unless the caller sets
//! one. Tabs switch a view; ToggleGroup is for filter chips; Switch is a
//! boolean.
//!
//! Keyboard (roving focus, one tab stop): arrows and Home / End move
//! between enabled options; with automatic activation (the default) a
//! move also checks the option, as radios do. Manual mode only focuses,
//! and Enter / Space check (Radio's own activation).
//!
//! Size matches the React twin (`default` / `sm`) without a
//! `SegmentedControlSize` enum: the twin has no cva. The Electron-only
//! `lcd` look is not shipped here.

use std::rc::Rc;

use gpui::{
    AnyElement, App, Axis, ColorSpace, ElementId, FocusHandle, FontWeight, IntoElement, KeyBinding,
    SharedString, Window, div, linear_color_stop, linear_gradient, prelude::*, px,
};
use gpui_base::actions::{SelectDown, SelectFirst, SelectLast, SelectLeft, SelectRight, SelectUp};
use smallvec::SmallVec;

use crate::{
    badge::plate_shadows,
    chrome::box_shadow,
    theme::{Appearance, TypeScale, faded_over, hsla, resolve, with_alpha},
    tokens::{Color, Shadow, radius, size, text},
    tooltip::tooltip,
};

const CONTEXT: &str = "SegmentedControl";

type ChangeHandler = Rc<dyn Fn(SharedString, &mut Window, &mut App)>;

/// Bind the arrow and Home / End keys for every segmented control. Call
/// once from [`crate::init`].
pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("left", SelectLeft, Some(CONTEXT)),
        KeyBinding::new("right", SelectRight, Some(CONTEXT)),
        KeyBinding::new("up", SelectUp, Some(CONTEXT)),
        KeyBinding::new("down", SelectDown, Some(CONTEXT)),
        KeyBinding::new("home", SelectFirst, Some(CONTEXT)),
        KeyBinding::new("end", SelectLast, Some(CONTEXT)),
    ]);
}

/// One option on the track.
pub struct Segment {
    value: SharedString,
    label: SharedString,
    disabled: bool,
    tooltip: Option<SharedString>,
}

impl Segment {
    pub fn new(value: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Segment {
            value: value.into(),
            label: label.into(),
            disabled: false,
            tooltip: None,
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// The option's name on hover and on focus, for an icon-only segment.
    pub fn tooltip(mut self, tooltip: impl Into<SharedString>) -> Self {
        self.tooltip = Some(tooltip.into());
        self
    }
}

#[derive(IntoElement)]
pub struct SegmentedControl {
    id: ElementId,
    options: Vec<Segment>,
    value: Option<SharedString>,
    disabled: bool,
    disabled_reason: Option<SharedString>,
    /// Focus moves without checking; Enter / Space check. Default automatic.
    manual: bool,
    /// 24 px segments; the default is the 28 px control height.
    small: bool,
    ground: Option<Color>,
    accessibility_label: Option<SharedString>,
    on_change: Option<ChangeHandler>,
    appearance: Option<Appearance>,
}

impl SegmentedControl {
    pub fn new(id: impl Into<ElementId>) -> Self {
        SegmentedControl {
            id: id.into(),
            options: Vec::new(),
            value: None,
            disabled: false,
            disabled_reason: None,
            manual: false,
            small: false,
            ground: None,
            accessibility_label: None,
            on_change: None,
            appearance: None,
        }
    }

    pub fn option(mut self, option: Segment) -> Self {
        self.options.push(option);
        self
    }

    /// The checked value; `None` or a value not offered checks none.
    pub fn value(mut self, value: Option<impl Into<SharedString>>) -> Self {
        self.value = value.map(Into::into);
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Why the whole control is disabled: shown under it while `disabled`.
    pub fn disabled_reason(mut self, reason: impl Into<SharedString>) -> Self {
        self.disabled_reason = Some(reason.into());
        self
    }

    /// Arrows only move focus; Enter / Space check.
    pub fn manual(mut self, manual: bool) -> Self {
        self.manual = manual;
        self
    }

    /// 24 px segments for dense rows.
    pub fn small(mut self, small: bool) -> Self {
        self.small = small;
        self
    }

    /// The colour the control sits on, for the disabled pre-blend.
    pub fn ground(mut self, ground: Color) -> Self {
        self.ground = Some(ground);
        self
    }

    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.accessibility_label = Some(label.into());
        self
    }

    /// Called with a newly checked value, never with the value already checked.
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

/// The option a move lands on, skipping disabled ones. `delta` of −1 / +1
/// wraps; `None` means first or last.
pub fn target_index(enabled: &[bool], current: usize, delta: Option<isize>) -> Option<usize> {
    let indexes: Vec<usize> = enabled
        .iter()
        .enumerate()
        .filter_map(|(index, on)| on.then_some(index))
        .collect();
    if indexes.is_empty() {
        return None;
    }
    match delta {
        None => indexes.first().copied(),
        Some(0) => indexes.last().copied(),
        Some(step) if step > 0 => indexes
            .iter()
            .copied()
            .find(|&index| index > current)
            .or_else(|| indexes.first().copied()),
        Some(_) => indexes
            .iter()
            .rev()
            .copied()
            .find(|&index| index < current)
            .or_else(|| indexes.last().copied()),
    }
}

/// The one option Tab reaches: the checked one when enabled, else the
/// first enabled one.
pub fn tab_stop(enabled: &[bool], checked_index: Option<usize>) -> Option<usize> {
    if let Some(index) = checked_index {
        if enabled.get(index).copied().unwrap_or(false) {
            return Some(index);
        }
    }
    enabled.iter().position(|on| *on)
}

impl RenderOnce for SegmentedControl {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let ground = self.ground.unwrap_or(t.glass_solid);
        let height = if self.small { 24.0 } else { size::CONTROL };
        let text_size = if self.small { 12.0 } else { 13.0 };
        let group_disabled = self.disabled;
        let manual = self.manual;
        let count = self.options.len();
        let key = SharedString::from(format!("{}", self.id));

        let enabled: Vec<bool> = self
            .options
            .iter()
            .map(|option| !(group_disabled || option.disabled))
            .collect();
        let checked_index = self.value.as_ref().and_then(|value| {
            self.options
                .iter()
                .position(|option| &option.value == value)
        });
        let stop = tab_stop(&enabled, checked_index).unwrap_or(0);

        let handles: Vec<FocusHandle> = (0..count)
            .map(|index| {
                let handle_key = SharedString::from(format!("{key}/focus/{index}"));
                window
                    .use_keyed_state(handle_key, cx, |_, cx| cx.focus_handle())
                    .read(cx)
                    .clone()
            })
            .collect();

        let current_focus = handles
            .iter()
            .position(|handle| handle.is_focused(window))
            .unwrap_or(stop);

        let move_to: Rc<dyn Fn(Option<isize>, &mut Window, &mut App)> = {
            let handles = handles.clone();
            let enabled = enabled.clone();
            let options: Vec<SharedString> = self
                .options
                .iter()
                .map(|option| option.value.clone())
                .collect();
            let on_change = self.on_change.clone();
            let value = self.value.clone();
            Rc::new(
                move |delta: Option<isize>, window: &mut Window, cx: &mut App| {
                    let from = handles
                        .iter()
                        .position(|handle| handle.is_focused(window))
                        .unwrap_or(current_focus);
                    let Some(target) = target_index(&enabled, from, delta) else {
                        return;
                    };
                    handles[target].focus(window, cx);
                    if !manual {
                        let next = &options[target];
                        if value.as_ref() != Some(next) {
                            if let Some(on_change) = &on_change {
                                on_change(next.clone(), window, cx);
                            }
                        }
                    }
                },
            )
        };

        let segments: SmallVec<[AnyElement; 4]> = self
            .options
            .into_iter()
            .enumerate()
            .map(|(index, option)| {
                let checked = Some(index) == checked_index;
                let on = enabled[index];
                let on_change = self.on_change.clone();
                let value = option.value.clone();
                let already = self.value.clone();
                let radio_id = SharedString::from(format!("{key}/{index}"));
                let tip = option.tooltip.clone();

                let mut radio = gpui_base::Radio::new(radio_id)
                    .checked(checked)
                    .disabled(!on)
                    .accessibility_label(option.label.clone())
                    .set_position(index + 1, count)
                    .tab_stop(index == stop)
                    .track_focus(&handles[index])
                    .relative()
                    .h(px(height - 4.0))
                    .flex_1()
                    .flex()
                    .items_center()
                    .justify_center()
                    .px(px(if self.small { 8.0 } else { 12.0 }))
                    .rounded(px(radius::CHIP))
                    .border_1()
                    .border_color(gpui::transparent_black())
                    .whitespace_nowrap()
                    .text_size(px(text_size))
                    .font_weight(FontWeight::MEDIUM)
                    .child(option.label);

                if let Some(on_change) = on_change {
                    radio = radio.on_change(move |_, _, window, cx| {
                        if already.as_ref() != Some(&value) {
                            on_change(value.clone(), window, cx);
                        }
                    });
                }

                if !on {
                    radio = radio.text_color(hsla(faded_over(t.muted_foreground, ground, 0.5)));
                } else if checked {
                    radio = radio
                        .text_color(hsla(t.foreground))
                        .bg(linear_gradient(
                            180.0,
                            linear_color_stop(hsla(t.chrome_plate_top), 0.0),
                            linear_color_stop(hsla(t.chrome_plate_bottom), 1.0),
                        )
                        .color_space(ColorSpace::Oklab))
                        .shadow(plate_shadows(t));
                } else {
                    radio = radio
                        .text_color(hsla(t.muted_foreground))
                        .hover(|style| style.text_color(hsla(t.foreground)));
                }

                if let Some(words) = tip {
                    radio = radio.tooltip(tooltip(words));
                }

                radio.into_any_element()
            })
            .collect();

        let right = move_to.clone();
        let left = move_to.clone();
        let down = move_to.clone();
        let up = move_to.clone();
        let first = move_to.clone();
        let last = move_to;

        let mut track = gpui_base::RadioGroup::new(self.id)
            .axis(Axis::Horizontal)
            .key_context(CONTEXT)
            .flex()
            .flex_wrap()
            .items_center()
            .justify_center()
            .min_h(px(height))
            .p(px(2.0))
            .rounded(px(radius::ROW))
            .bg(hsla(with_alpha(
                t.foreground,
                if group_disabled { 0.025 } else { 0.05 },
            )))
            .shadow(vec![box_shadow(&Shadow {
                inset: true,
                x: 0.0,
                y: 0.0,
                blur: 0.0,
                spread: 1.0,
                color: if group_disabled {
                    faded_over(t.border, ground, 0.5)
                } else {
                    t.border
                },
            })])
            .on_action(move |_: &SelectRight, window, cx| right(Some(1), window, cx))
            .on_action(move |_: &SelectDown, window, cx| down(Some(1), window, cx))
            .on_action(move |_: &SelectLeft, window, cx| left(Some(-1), window, cx))
            .on_action(move |_: &SelectUp, window, cx| up(Some(-1), window, cx))
            .on_action(move |_: &SelectFirst, window, cx| first(None, window, cx))
            .on_action(move |_: &SelectLast, window, cx| last(Some(0), window, cx))
            .children(segments);

        if let Some(label) = self.accessibility_label {
            track = track.aria_label(label);
        }

        let show_reason = group_disabled && self.disabled_reason.is_some();
        if !show_reason {
            return track.into_any_element();
        }
        div()
            .flex()
            .flex_col()
            .gap(px(6.0))
            .child(track)
            .child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(self.disabled_reason.unwrap_or_default()),
            )
            .into_any_element()
    }
}
