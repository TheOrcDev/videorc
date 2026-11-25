//! ListRow and GroupedList (`components/list-row.tsx`): the one row for
//! every icon, title and meta list, and the inset grouped list it sits in.
//!
//! A row is 32 px (28 px compact): an optional leading control, a 20 px
//! icon tile on the chip radius, the title, inline secondary context, then
//! right-aligned status icons and a secondary meta label. A row is a fact
//! unless it says otherwise: [`ListRow::interactive`] adds the hover, and
//! [`ListRow::on_click`] makes the whole row one button (pointer, Enter and
//! Space, focus) with the inset focus ring. Selection is the accent block.
//!
//! A grouped list (macOS Settings style) puts like things in one inset
//! group split by hairlines, under an optional [`SectionLabel`]. Its rows
//! lose their own rounding, as the React rows do inside `grouped-list`.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, FontWeight, IntoElement, SharedString, Window, div,
    prelude::*, px,
};
use smallvec::SmallVec;

use crate::{
    chrome::focus_ring,
    section_label::SectionLabel,
    theme::{Appearance, TypeScale, hsla, resolve},
    tokens::{radius, size, text},
};

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// A row a [`GroupedList`] can hold flush: it drops its own rounding.
pub trait GroupedRow: IntoElement {
    fn grouped(self) -> Self;
}

#[derive(IntoElement)]
pub struct ListRow {
    id: ElementId,
    title: SharedString,
    /// Normal-weight count after the semibold title ("Moments · 1").
    title_count: Option<SharedString>,
    leading: Option<AnyElement>,
    icon: Option<AnyElement>,
    context: Option<SharedString>,
    alias: Option<AnyElement>,
    status_icons: SmallVec<[AnyElement; 2]>,
    meta: Option<SharedString>,
    children: SmallVec<[AnyElement; 2]>,
    selected: bool,
    interactive: Option<bool>,
    compact: bool,
    /// No horizontal padding (Electron `px-0` flush rows).
    flush: bool,
    disabled: bool,
    grouped: bool,
    on_click: Option<ClickHandler>,
    appearance: Option<Appearance>,
}

impl ListRow {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        ListRow {
            id: id.into(),
            title: title.into(),
            title_count: None,
            leading: None,
            icon: None,
            context: None,
            alias: None,
            status_icons: SmallVec::new(),
            meta: None,
            children: SmallVec::new(),
            selected: false,
            interactive: None,
            compact: false,
            flush: false,
            disabled: false,
            grouped: false,
            on_click: None,
            appearance: None,
        }
    }

    /// Count in normal weight beside the semibold title (" · 1").
    pub fn title_count(mut self, count: impl Into<SharedString>) -> Self {
        self.title_count = Some(count.into());
        self
    }

    /// Drop horizontal padding (`px-0`).
    pub fn flush(mut self, flush: bool) -> Self {
        self.flush = flush;
        self
    }

    /// A control before the title (a sound's play button), never clipped
    /// like the icon tile.
    pub fn leading(mut self, leading: impl IntoElement) -> Self {
        self.leading = Some(leading.into_any_element());
        self
    }

    /// The icon tile's content: an app or source icon, the colourful slot.
    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// Inline secondary context after the title (platform, owner, kind).
    pub fn context(mut self, context: impl Into<SharedString>) -> Self {
        self.context = Some(context.into());
        self
    }

    /// Key chips right after the context (an alias).
    pub fn alias(mut self, alias: impl IntoElement) -> Self {
        self.alias = Some(alias.into_any_element());
        self
    }

    /// A small status icon just before the meta label.
    pub fn status_icon(mut self, icon: impl IntoElement) -> Self {
        self.status_icons.push(icon.into_any_element());
        self
    }

    /// Right-aligned secondary metadata ("Command", "Connected").
    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
    }

    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    /// The hover affordance. Off for a fact row; on by default for a row
    /// that is one button.
    pub fn interactive(mut self, interactive: bool) -> Self {
        self.interactive = Some(interactive);
        self
    }

    /// 28 px instead of 32 px.
    pub fn compact(mut self, compact: bool) -> Self {
        self.compact = compact;
        self
    }

    /// A row that is a button, disabled.
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Makes the whole row one button.
    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl ParentElement for ListRow {
    /// Controls in the row's right cluster, before the status icons.
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl GroupedRow for ListRow {
    fn grouped(mut self) -> Self {
        self.grouped = true;
        self
    }
}

impl RenderOnce for ListRow {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let is_button = self.on_click.is_some();
        let interactive = self.interactive.unwrap_or(is_button) && !self.disabled;
        let height = if self.compact {
            size::ROW_COMPACT
        } else {
            size::ROW
        };
        let corner = if self.grouped { 0.0 } else { radius::ROW };
        let tile = self.icon.map(|icon| {
            div()
                .flex_none()
                .min_w(px(20.0))
                .min_h(px(20.0))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(radius::CHIP))
                .overflow_hidden()
                .child(icon)
        });
        let words = div()
            .min_w(px(0.0))
            .flex()
            .items_baseline()
            .gap(px(8.0))
            .child(
                div()
                    .min_w(px(0.0))
                    .truncate()
                    .text_color(hsla(t.foreground))
                    .font_weight(FontWeight::MEDIUM)
                    .child(self.title)
                    .children(self.title_count.map(|count| {
                        div()
                            .font_weight(FontWeight::NORMAL)
                            .child(format!(" · {count}"))
                    })),
            )
            .children(self.context.map(|context| {
                div()
                    .min_w(px(0.0))
                    .truncate()
                    .text_color(hsla(t.muted_foreground))
                    .child(context)
            }))
            .children(self.alias);
        let has_status = !self.status_icons.is_empty();
        let end = div()
            .flex_none()
            .flex()
            .items_center()
            .gap(px(8.0))
            .children(self.children)
            .when(has_status, |end| {
                end.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .text_color(hsla(t.muted_foreground))
                        .children(self.status_icons),
                )
            })
            .children(self.meta.map(|meta| {
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(meta)
            }));
        let pad_x = if self.flush { 0.0 } else { 12.0 };
        let content = |row: gpui::Div| {
            row.w_full()
                .h(px(height))
                .flex()
                .items_center()
                .gap(px(10.0))
                .px(px(pad_x))
                .rounded(px(corner))
                .text_size(px(14.0))
                .line_height(px(20.0))
                .when(self.selected, |row| row.bg(hsla(t.accent)))
                .children(self.leading)
                .children(tile)
                .child(words)
                .child(div().flex_1())
                .child(end)
        };
        match self.on_click {
            Some(on_click) => {
                let ring = focus_ring(t);
                gpui_base::Button::new(self.id)
                    .disabled(self.disabled)
                    .w_full()
                    .rounded(px(corner))
                    .when(self.selected, |row| row.bg(hsla(t.accent)))
                    .when(interactive, |row| {
                        row.hover(|style| style.bg(hsla(t.accent)))
                    })
                    .when(self.disabled, |row| row.opacity(0.5))
                    .focus_visible(move |style| style.shadow(vec![ring]))
                    .on_click(move |event, window, cx| on_click(event, window, cx))
                    .child(content(div()))
                    .into_any_element()
            }
            None => content(div())
                .id(self.id)
                .when(interactive, |row| {
                    row.hover(|style| style.bg(hsla(t.accent)))
                })
                .into_any_element(),
        }
    }
}

#[derive(IntoElement)]
pub struct GroupedList {
    id: Option<ElementId>,
    label: Option<SharedString>,
    /// Screen-reader name when there is no visible section label.
    accessibility_label: Option<SharedString>,
    rows: SmallVec<[AnyElement; 4]>,
    appearance: Option<Appearance>,
}

impl GroupedList {
    pub fn new() -> Self {
        GroupedList {
            id: None,
            label: None,
            accessibility_label: None,
            rows: SmallVec::new(),
            appearance: None,
        }
    }

    /// Stable ID for an unnamed group, or repeated groups with the same label.
    pub fn id(mut self, id: impl Into<ElementId>) -> Self {
        self.id = Some(id.into());
        self
    }

    /// The group's name, as a section label over it.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// Accessible name only (Electron `aria-label` with no visible label).
    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.accessibility_label = Some(label.into());
        self
    }

    /// A row, flush in the group.
    pub fn row(mut self, row: impl GroupedRow) -> Self {
        self.rows.push(row.grouped().into_any_element());
        self
    }

    /// Anything else between the hairlines (a setting's own block).
    pub fn item(mut self, item: impl IntoElement) -> Self {
        self.rows.push(item.into_any_element());
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl Default for GroupedList {
    fn default() -> Self {
        GroupedList::new()
    }
}

impl RenderOnce for GroupedList {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let appearance = self.appearance;
        let a11y = self.accessibility_label.clone().or(self.label.clone());
        let id = self.id.or_else(|| a11y.clone().map(ElementId::from));
        // Divider is painted inside each following row so the row stays 32 px
        // (Electron), not 33 with an external border.
        let rows = self.rows.into_iter().enumerate().map(|(index, row)| {
            div().relative().child(row).when(index > 0, |wrap| {
                wrap.child(
                    div()
                        .absolute()
                        .top(px(0.0))
                        .left(px(0.0))
                        .right(px(0.0))
                        .h(px(1.0))
                        .bg(hsla(t.border)),
                )
            })
        });
        let root = div().flex().flex_col().gap(px(6.0));
        let root = root
            .children(self.label.map(|label| {
                let label = SectionLabel::new(label);
                div().px(px(4.0)).child(match appearance {
                    Some(appearance) => label.appearance(appearance),
                    None => label,
                })
            }))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .overflow_hidden()
                    .rounded(px(radius::ROW))
                    .border_1()
                    .border_color(hsla(t.border))
                    .bg(hsla(t.inset))
                    .children(rows),
            );
        // GPUI accessibility needs a stable element ID. Do not give every
        // anonymous group one shared ID: sibling groups would collide.
        match id {
            Some(id) => root
                .id(id)
                .role(gpui::Role::List)
                .when_some(a11y, |root, name| root.aria_label(name))
                .into_any_element(),
            None => root.into_any_element(),
        }
    }
}
