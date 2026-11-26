//! SegmentedControl (`components/ui/segmented-control.tsx`): pick one of
//! 2–4 exclusive options on the glass Tabs track. gpui-base's RadioGroup
//! and Radio for the radiogroup / radio roles, AccessKit and focus; the
//! kit paints the recessed track and the chrome-plate segment. A Field's
//! label names the group (`accessibility_label`) unless the caller sets
//! one. An option's label is the default segment text and its accessible
//! name. React's icon options (`label: <Icon />`, `tooltip`) are
//! [`Segment::child`] plus [`Segment::tooltip`]: the child replaces the
//! label text while the label stays the AccessKit name. Tabs switch a
//! view; ToggleGroup is for filter chips; Switch is a boolean.
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
    theme::{Appearance, FONT, TypeScale, faded_over, hsla, resolve, with_alpha},
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
    /// React option `label` when it is an icon (or other custom body).
    child: Option<AnyElement>,
    disabled: bool,
    tooltip: Option<SharedString>,
}

impl Segment {
    pub fn new(value: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Segment {
            value: value.into(),
            label: label.into(),
            child: None,
            disabled: false,
            tooltip: None,
        }
    }

    /// Custom segment body (an icon for Orientation). The option's label
    /// remains the accessible name; pair with [`Self::tooltip`] for hover.
    pub fn child(mut self, child: impl IntoElement) -> Self {
        self.child = Some(child.into_any_element());
        self
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
    /// `w-fit`: the track hugs its segments, each as wide as its words.
    fit: bool,
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
            // Electron's SegmentedControl is `w-fit` unless told otherwise.
            fit: true,
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

    /// `w-fit` (CSS `fit-content`), Electron's default and the kit's: the
    /// track hugs its segments, each as wide as its words, but never wider
    /// than its column; in a column narrower than its words the segments
    /// share it and wrap. `fit(false)` is [`Self::full`]`(true)`.
    pub fn fit(mut self, fit: bool) -> Self {
        self.fit = fit;
        self
    }

    /// `w-full`: the track fills its column and the segments share it as
    /// Chrome does (equal shares, none narrower than its words, wrapping a
    /// line that can't hold them). Electron fills with `className="w-full"`
    /// and inside a vertical Field (`*:w-full`, which wins over a `w-fit`),
    /// so a control there needs it.
    pub fn full(mut self, full: bool) -> Self {
        self.fit = !full;
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

/// Chrome's widths for `flex: 1 1 0%` segments in a `w-full` track whose
/// content box is `inner` wide, each never narrower than its `mins` (its
/// words, `min-width: auto`): lines break where the minimums no longer fit,
/// and on each line the segments share the width equally, except that one
/// whose words need more keeps them and the rest share what is left.
/// Returns (line, width) per segment. Measured against Chrome: see the kit
/// owner's segment-measure notes (plan 260, batch 3).
pub fn segment_widths(mins: &[f32], inner: f32) -> Vec<(usize, f32)> {
    let mut lines: Vec<Vec<usize>> = Vec::new();
    let mut used = 0.0_f32;
    for (index, min) in mins.iter().enumerate() {
        match lines.last_mut() {
            Some(line) if used + min <= inner + 0.01 => {
                line.push(index);
                used += min;
            }
            _ => {
                lines.push(vec![index]);
                used = *min;
            }
        }
    }
    let mut out = vec![(0, 0.0); mins.len()];
    for (line_index, line) in lines.iter().enumerate() {
        let mut frozen: Vec<usize> = Vec::new();
        loop {
            let left = inner - frozen.iter().map(|&i| mins[i]).sum::<f32>();
            let open: Vec<usize> = line
                .iter()
                .copied()
                .filter(|i| !frozen.contains(i))
                .collect();
            if open.is_empty() {
                for &i in &frozen {
                    out[i] = (line_index, mins[i]);
                }
                break;
            }
            let share = (left / open.len() as f32).max(0.0);
            let short: Vec<usize> = open.iter().copied().filter(|&i| mins[i] > share).collect();
            if short.is_empty() {
                for &i in &open {
                    out[i] = (line_index, share);
                }
                for &i in &frozen {
                    out[i] = (line_index, mins[i]);
                }
                break;
            }
            frozen.extend(short);
        }
    }
    out
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
    if let Some(index) = checked_index
        && enabled.get(index).copied().unwrap_or(false)
    {
        return Some(index);
    }
    enabled.iter().position(|on| *on)
}

/// Moves focus (and, unless manual, the value) by a step, or to the end.
type MoveHandler = Rc<dyn Fn(Option<isize>, &mut Window, &mut App)>;

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

        let move_to: MoveHandler = {
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
                        if value.as_ref() != Some(next)
                            && let Some(on_change) = &on_change
                        {
                            on_change(next.clone(), window, cx);
                        }
                    }
                },
            )
        };

        // Chrome's flex sizing for `flex-1` segments, from their words
        // (`px-3` and a 1 px rim around 13 px medium text). A segment with a
        // custom body can't be measured, so that track keeps plain `flex-1`.
        let pad_x = if self.small { 8.0 } else { 12.0 };
        let mins: Option<Vec<f32>> = self
            .options
            .iter()
            .map(|option| {
                option.child.is_none().then(|| {
                    let mut font = gpui::font(FONT);
                    font.weight = FontWeight::MEDIUM;
                    let run = gpui::TextRun {
                        len: option.label.len(),
                        font,
                        color: hsla(t.foreground),
                        background_color: None,
                        underline: None,
                        strikethrough: None,
                    };
                    let words = window
                        .text_system()
                        .shape_line(option.label.clone(), px(text_size), &[run], None)
                        .width();
                    f32::from(words) + pad_x * 2.0 + 2.0
                })
            })
            .collect();
        let fit = self.fit;
        // Chrome's flex sizing, laid out by layout itself, with no measured
        // width to go stale: each segment is `flex-1` (equal shares from a
        // zero basis) and never narrower than its words (`min-width: auto`).
        // Lines break where the words stop fitting and each line shares
        // its own width, which is what `segment_widths` writes down.
        // `w-fit` is CSS `fit-content`: the track asks for its words (plus a
        // pixel, so the exact sum never wraps on rounding) and is capped at
        // its column, where the segments share and wrap as a full one's do.
        let track_width = match (&mins, fit) {
            (Some(mins), true) => Some(mins.iter().sum::<f32>() + 5.0),
            _ => None,
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
                let body = option
                    .child
                    .unwrap_or_else(|| option.label.clone().into_any_element());

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
                    .when_some(
                        mins.as_ref().and_then(|mins| mins.get(index).copied()),
                        |radio, min| radio.min_w(px(min)),
                    )
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
                    .child(body);

                if let Some(on_change) = on_change {
                    radio = radio.on_change(move |_, _, window, cx| {
                        if already.as_ref() != Some(&value) {
                            on_change(value.clone(), window, cx);
                        }
                    });
                }

                if checked {
                    // A disabled control keeps its choice on show: the plate
                    // and its words stay, faded (`disabled:opacity-50` over
                    // `aria-checked:chrome-plate`), pre-blended per the kit.
                    let fade = |color| {
                        if on {
                            color
                        } else {
                            faded_over(color, ground, 0.5)
                        }
                    };
                    let mut plate = plate_shadows(t);
                    if !on {
                        for shadow in &mut plate {
                            shadow.color.a *= 0.5;
                        }
                    }
                    radio = radio
                        .text_color(hsla(fade(t.foreground)))
                        .bg(linear_gradient(
                            180.0,
                            linear_color_stop(hsla(fade(t.chrome_plate_top)), 0.0),
                            linear_color_stop(hsla(fade(t.chrome_plate_bottom)), 1.0),
                        )
                        .color_space(ColorSpace::Oklab))
                        .shadow(plate);
                } else if !on {
                    radio = radio.text_color(hsla(faded_over(t.muted_foreground, ground, 0.5)));
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
            .gap_y(px(2.0))
            .min_h(px(height))
            .p(px(2.0))
            // The default track fills its column (`w-full`): sized from its
            // content, it measured the shares it had laid out and kept them
            // (Destinations' Stream quality stayed word-wide).
            .when(!fit, |track| track.w_full())
            .when_some(track_width, |track, width| {
                track.flex_none().w(px(width)).max_w(gpui::relative(1.0))
            })
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

#[cfg(test)]
mod tests {
    use super::segment_widths;

    /// Chrome 2026-11 on `flex-1` segments, `px-3`, 13 px medium (the
    /// kit owner's segment-measure page).
    #[test]
    fn segment_widths_follow_chrome() {
        let near = |a: f32, b: f32| (a - b).abs() < 0.2;
        let w = segment_widths(&[75.8, 83.1, 45.7], 396.0);
        assert!(
            w.iter()
                .all(|&(line, width)| line == 0 && near(width, 132.0))
        );
        let w = segment_widths(&[116.1, 116.3, 157.7], 416.0);
        assert!(near(w[0].1, 129.15) && near(w[1].1, 129.15) && near(w[2].1, 157.7));
        let w = segment_widths(&[116.1, 116.3, 157.7], 326.0);
        assert_eq!((w[0].0, w[1].0, w[2].0), (0, 0, 1));
        assert!(near(w[0].1, 163.0) && near(w[1].1, 163.0) && near(w[2].1, 326.0));
    }
}
