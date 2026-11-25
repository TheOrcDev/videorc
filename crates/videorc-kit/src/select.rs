//! Select (`components/ui/select.tsx`): gpui-base's Select for the
//! behaviour (the combobox role, the arrows open it and move the highlight,
//! Enter and Space choose, Escape closes and focus returns), the trigger and
//! the popup of the float glass from the tokens: a 28 px `input/50` trigger
//! with its chevron, and a list at least as wide as the trigger, whose
//! highlighted row is the accent block and whose chosen row has a check.
//!
//! Options may carry a rich body ([`SelectOption::child`], L7) or a group
//! label ([`SelectOption::group`], L1 P482). [`Select::searchable`] adds a
//! search field that filters by label and group.

use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, ElementId, Entity, FocusHandle, FontWeight, IntoElement, Pixels,
    SharedString, Subscription, Window, deferred, div, prelude::*, px,
};
use gpui_base::{
    Align, DeferredPopover, ElementExt, GlobalState, POPUP_PRIORITY, Placement, Positioner,
    actions::{SelectDown, SelectUp},
    input::{InputEvent, InputState},
};

use crate::{
    icon::{IconName, icon},
    input::Input,
    motion::{floating, presence},
    popover::popup_glass,
    theme::{Appearance, FONT, faded_over, hsla, resolve, with_alpha},
    tokens::{Color, Theme, radius, size},
};

type ChangeHandler = Rc<dyn Fn(SharedString, &mut Window, &mut App)>;

/// One choice in a [`Select`].
pub struct SelectOption {
    value: SharedString,
    label: SharedString,
    /// Rich row body (icon + title + description). The label stays the
    /// trigger text and AccessKit name when no body is set.
    child: Option<AnyElement>,
    /// Group heading; the first option of each group paints the label (P482).
    group: Option<SharedString>,
    /// Hairline row (Electron `SelectSeparator`); not selectable.
    separator: bool,
    disabled: bool,
}

impl SelectOption {
    pub fn new(value: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        SelectOption {
            value: value.into(),
            label: label.into(),
            child: None,
            group: None,
            separator: false,
            disabled: false,
        }
    }

    /// A non-selectable hairline between options (Output presets).
    pub fn separator() -> Self {
        SelectOption {
            value: SharedString::from("__separator__"),
            label: SharedString::default(),
            child: None,
            group: None,
            separator: true,
            disabled: true,
        }
    }

    /// Custom row body instead of the plain label text.
    pub fn child(mut self, child: impl IntoElement) -> Self {
        self.child = Some(child.into_any_element());
        self
    }

    /// Group heading shown above this option's block (first of each group).
    pub fn group(mut self, group: impl Into<SharedString>) -> Self {
        self.group = Some(group.into());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

/// Trigger height: default 28 px, xs 24 px (Electron `size="xs"`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SelectSize {
    #[default]
    Default,
    /// 24 px trigger (`h-6`).
    Xs,
}

#[derive(IntoElement)]
pub struct Select {
    id: ElementId,
    options: Vec<SelectOption>,
    value: Option<SharedString>,
    placeholder: SharedString,
    disabled: bool,
    /// A search field filters options by label and group (P482).
    searchable: bool,
    size: SelectSize,
    width: Option<f32>,
    max_width: Option<f32>,
    ground: Option<Color>,
    accessibility_label: Option<SharedString>,
    /// A caller-owned handle for the trigger (first run's autofocus).
    track_focus: Option<FocusHandle>,
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
            searchable: false,
            size: SelectSize::Default,
            width: None,
            max_width: None,
            ground: None,
            accessibility_label: None,
            track_focus: None,
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

    /// One option that may be disabled, grouped, or carry a rich body.
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

    /// Show a search field; options are filtered by their label and group.
    pub fn searchable(mut self, searchable: bool) -> Self {
        self.searchable = searchable;
        self
    }

    pub fn size(mut self, size: SelectSize) -> Self {
        self.size = size;
        self
    }

    /// The trigger's width; it fits its words otherwise (`w-fit`).
    pub fn width(mut self, width: f32) -> Self {
        self.width = Some(width);
        self
    }

    /// Cap the trigger width (Electron `max-w-56` = 224).
    pub fn max_width(mut self, max_width: f32) -> Self {
        self.max_width = Some(max_width);
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

    /// The trigger takes this focus handle instead of its own, so a page can
    /// focus it (`autoFocus`) or ask whether it holds focus.
    pub fn track_focus(mut self, handle: &FocusHandle) -> Self {
        self.track_focus = Some(handle.clone());
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

/// What a select keeps between frames.
struct SelectOpen {
    open: bool,
    /// Highlight index into the *visible* (filtered) list.
    highlighted: usize,
    bounds: Bounds<Pixels>,
    trigger_focus: FocusHandle,
    content_focus: FocusHandle,
    popup: Option<DeferredPopover>,
    search: Entity<InputState>,
    query: SharedString,
    _search_sub: Option<Subscription>,
}

impl SelectOpen {
    fn set_open(&mut self, open: bool, highlighted: usize, cx: &mut App) {
        self.open = open;
        self.highlighted = highlighted;
        self.popup = open.then(|| GlobalState::register_deferred_popover(cx));
    }
}

fn matches_query(option: &SelectOption, query: &str) -> bool {
    if option.separator {
        return query.is_empty();
    }
    if query.is_empty() {
        return true;
    }
    let q = query.to_ascii_lowercase();
    option.label.to_ascii_lowercase().contains(&q)
        || option
            .group
            .as_ref()
            .is_some_and(|g| g.to_ascii_lowercase().contains(&q))
}

impl RenderOnce for Select {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let ground = self.ground.unwrap_or(t.glass_solid);
        let disabled = self.disabled;
        let searchable = self.searchable;
        let appearance = self.appearance;
        let state = window.use_keyed_state(self.id.clone(), cx, |window, cx| {
            let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search…"));
            SelectOpen {
                open: false,
                highlighted: 0,
                bounds: Bounds::default(),
                trigger_focus: cx.focus_handle(),
                content_focus: cx.focus_handle(),
                popup: None,
                search,
                query: SharedString::default(),
                _search_sub: None,
            }
        });
        // Live filter: InputState Change notifies this keyed state so the
        // parent view redraws with a fresh option list.
        if state.read(cx)._search_sub.is_none() {
            let listen = state.clone();
            let search = state.read(cx).search.clone();
            let sub = window.subscribe(&search, cx, move |_, event: &InputEvent, _, cx| {
                if matches!(event, InputEvent::Change) {
                    listen.update(cx, |s, cx| {
                        s.query = s.search.read(cx).value();
                        s.highlighted = 0;
                        cx.notify();
                    });
                }
            });
            state.update(cx, |s, _| s._search_sub = Some(sub));
        }
        if let Some(handle) = self.track_focus.as_ref()
            && state.read(cx).trigger_focus != *handle
        {
            // Closing the popup hands focus back through the state's handle.
            state.update(cx, |s, _| s.trigger_focus = handle.clone());
        }
        let (open, highlighted, bounds, trigger_focus, content_focus, search, query) = {
            let s = state.read(cx);
            (
                s.open,
                s.highlighted,
                s.bounds,
                s.trigger_focus.clone(),
                s.content_focus.clone(),
                s.search.clone(),
                s.query.clone(),
            )
        };
        let sample = presence(
            SharedString::from(format!("{}/motion", self.id)),
            open,
            window,
            cx,
        );
        let progress = sample.progress;

        let mut options = self.options;
        let chosen = self
            .value
            .as_ref()
            .and_then(|value| options.iter().position(|option| &option.value == value));
        let shown = chosen.map(|index| options[index].label.clone());
        let on_change = self.on_change;

        let query_str = if searchable {
            query.to_string()
        } else {
            String::new()
        };
        let visible: Vec<usize> = options
            .iter()
            .enumerate()
            .filter(|(_, option)| matches_query(option, &query_str))
            .map(|(index, _)| index)
            .collect();
        let visible_enabled: Vec<bool> = visible
            .iter()
            .map(|&index| !options[index].disabled)
            .collect();
        let visible_count = visible.len();

        let open_at_abs = chosen
            .filter(|&index| !options[index].disabled)
            .or_else(|| options.iter().position(|o| !o.disabled))
            .unwrap_or(0);
        let open_at = visible
            .iter()
            .position(|&index| index == open_at_abs)
            .or_else(|| visible_enabled.iter().position(|on| *on))
            .unwrap_or(0);

        let toggle = {
            let state = state.clone();
            let searchable = searchable;
            move |window: &mut Window, cx: &mut App| {
                let content_focus = state.read(cx).content_focus.clone();
                let search = state.read(cx).search.clone();
                let now_open = !state.read(cx).open;
                state.update(cx, |s, cx| {
                    if now_open {
                        let search = s.search.clone();
                        search.update(cx, |search, cx| {
                            search.set_value("", window, cx);
                        });
                        s.query = SharedString::default();
                    }
                    s.set_open(now_open, open_at, cx);
                });
                if now_open {
                    if searchable {
                        search.update(cx, |search, cx| search.focus(window, cx));
                    } else {
                        content_focus.focus(window, cx);
                    }
                }
            }
        };
        let choose = {
            let state = state.clone();
            let values: Vec<(SharedString, bool)> = options
                .iter()
                .map(|o| (o.value.clone(), o.disabled))
                .collect();
            let on_change = on_change.clone();
            Rc::new(move |index: usize, window: &mut Window, cx: &mut App| {
                let Some((value, disabled)) = values.get(index).cloned() else {
                    return;
                };
                if disabled {
                    return;
                }
                let trigger_focus = state.read(cx).trigger_focus.clone();
                state.update(cx, |s, cx| s.set_open(false, index, cx));
                trigger_focus.focus(window, cx);
                if let Some(on_change) = on_change.as_ref() {
                    on_change(value, window, cx);
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

        let trigger_h = match self.size {
            SelectSize::Default => size::CONTROL,
            SelectSize::Xs => 24.0,
        };
        let trigger = div()
            .id("select-trigger")
            .flex()
            .items_center()
            .justify_between()
            .gap(px(6.0))
            .h(px(trigger_h))
            .px(px(10.0))
            .when_some(self.width, |trigger, width| trigger.w(px(width)))
            .when_some(self.max_width, |trigger, max_width| {
                trigger.max_w(px(max_width))
            })
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

        let popup = sample.should_render().then(|| {
            popup_list(PopupList {
                open,
                searchable,
                progress,
                bounds,
                content_focus: content_focus.clone(),
                state: state.clone(),
                options: &mut options,
                visible: &visible,
                visible_enabled: &visible_enabled,
                visible_count,
                chosen,
                highlighted,
                choose: choose.clone(),
                toggle: Rc::new(toggle.clone()),
                search: search.clone(),
                appearance,
                t,
            })
        });

        let mut select = gpui_base::Select::new(self.id)
            .open(open)
            .disabled(disabled)
            .focus_handle(&trigger_focus)
            .content_focus_handle(&content_focus)
            .on_open_change({
                let state = state.clone();
                let searchable = searchable;
                move |now_open, window, cx| {
                    let search = state.read(cx).search.clone();
                    let content_focus = state.read(cx).content_focus.clone();
                    state.update(cx, |s, cx| {
                        if now_open {
                            let search = s.search.clone();
                            search.update(cx, |search, cx| {
                                search.set_value("", window, cx);
                            });
                            s.query = SharedString::default();
                        }
                        s.set_open(now_open, open_at, cx);
                    });
                    if now_open {
                        if searchable {
                            search.update(cx, |search, cx| search.focus(window, cx));
                        } else {
                            content_focus.focus(window, cx);
                        }
                    }
                }
            })
            .on_confirm({
                let state = state.clone();
                let choose = choose.clone();
                let visible = visible.clone();
                move |window, cx| {
                    let hi = state.read(cx).highlighted;
                    let absolute = visible.get(hi).copied().unwrap_or(hi);
                    choose(absolute, window, cx);
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

struct PopupList<'a> {
    open: bool,
    searchable: bool,
    progress: f32,
    bounds: Bounds<Pixels>,
    content_focus: FocusHandle,
    state: Entity<SelectOpen>,
    options: &'a mut Vec<SelectOption>,
    visible: &'a [usize],
    visible_enabled: &'a [bool],
    visible_count: usize,
    chosen: Option<usize>,
    highlighted: usize,
    choose: Rc<dyn Fn(usize, &mut Window, &mut App)>,
    toggle: Rc<dyn Fn(&mut Window, &mut App)>,
    search: Entity<InputState>,
    appearance: Option<Appearance>,
    t: &'static Theme,
}

fn popup_list(p: PopupList<'_>) -> AnyElement {
    let highlight = p.highlighted.min(p.visible_count.saturating_sub(1));
    let mut last_group: Option<SharedString> = None;
    let mut rows: Vec<AnyElement> = Vec::new();

    if p.searchable {
        let mut search_field = Input::new("select-search", &p.search).plain(true);
        if let Some(appearance) = p.appearance {
            search_field = search_field.appearance(appearance);
        }
        rows.push(
            div()
                .flex_none()
                .mb(px(4.0))
                .px(px(4.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .h(px(size::CONTROL))
                        .px(px(6.0))
                        .rounded(px(radius::CHIP))
                        .bg(hsla(with_alpha(p.t.input, 0.5)))
                        .child(search_field),
                )
                .into_any_element(),
        );
    }

    for (filter_i, &index) in p.visible.iter().enumerate() {
        let group = p.options[index].group.clone();
        if let Some(group) = group.as_ref() {
            if last_group.as_ref() != Some(group) {
                last_group = Some(group.clone());
                rows.push(
                    div()
                        .flex_none()
                        .px(px(8.0))
                        .pt(px(6.0))
                        .pb(px(2.0))
                        .text_size(px(12.0))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(hsla(p.t.muted_foreground))
                        .child(group.clone())
                        .into_any_element(),
                );
            }
        }
        if p.options[index].separator {
            rows.push(
                div()
                    .flex_none()
                    .my(px(4.0))
                    .mx(px(8.0))
                    .h(px(1.0))
                    .bg(hsla(p.t.border))
                    .into_any_element(),
            );
            continue;
        }
        let option_disabled = p.options[index].disabled;
        let label = p.options[index].label.clone();
        let body = p.options[index]
            .child
            .take()
            .unwrap_or_else(|| label.into_any_element());
        let choose = p.choose.clone();
        let hover_state = p.state.clone();
        let open = p.open;
        rows.push(
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
                    row.opacity(0.5).text_color(hsla(p.t.muted_foreground))
                })
                .when(filter_i == highlight && !option_disabled, |row| {
                    row.bg(hsla(p.t.accent))
                        .text_color(hsla(p.t.accent_foreground))
                })
                .on_hover(move |hovered, _, cx| {
                    if *hovered && !option_disabled {
                        hover_state.update(cx, |s, cx| {
                            s.highlighted = filter_i;
                            cx.notify();
                        });
                    }
                })
                .on_click(move |_, window, cx| {
                    if open {
                        choose(index, window, cx);
                    }
                })
                .child(body)
                .when(Some(index) == p.chosen, |row| {
                    row.child(div().absolute().right(px(8.0)).child(icon(
                        IconName::Check,
                        16.0,
                        hsla(p.t.foreground),
                    )))
                })
                .into_any_element(),
        );
    }

    if p.visible_count == 0 {
        rows.push(
            div()
                .px(px(8.0))
                .py(px(6.0))
                .text_color(hsla(p.t.muted_foreground))
                .child("No matches")
                .into_any_element(),
        );
    }

    let enabled = p.visible_enabled.to_vec();
    let count = p.visible_count;
    let step = {
        let state = p.state.clone();
        move |delta: isize| {
            let state = state.clone();
            let enabled = enabled.clone();
            move |_: &mut Window, cx: &mut App| {
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
        }
    };
    let down = step(1);
    let up = step(-1);
    let close = p.toggle.clone();
    let open = p.open;

    deferred(
        Positioner::side(p.bounds)
            .placement(Placement::Bottom)
            .align(Align::Start)
            .offset(px(6.0))
            .margin(px(8.0))
            .child(
                floating(
                    popup_glass(p.t),
                    p.progress,
                    div().flex().flex_col().children(rows),
                )
                .id("select-content")
                .occlude()
                .track_focus(&p.content_focus)
                .min_w(px(f32::from(p.bounds.size.width).max(144.0)))
                .max_h(px(320.0))
                .overflow_y_scroll()
                .p(px(4.0))
                .font_family(FONT)
                .text_size(px(14.0))
                .text_color(hsla(p.t.popover_foreground))
                .on_action(move |_: &SelectDown, window, cx| down(window, cx))
                .on_action(move |_: &SelectUp, window, cx| up(window, cx))
                .on_mouse_down_out(move |_, window, cx| {
                    if open {
                        close(window, cx);
                    }
                }),
            ),
    )
    .with_priority(POPUP_PRIORITY)
    .into_any_element()
}
