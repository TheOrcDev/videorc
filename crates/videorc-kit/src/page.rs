//! The page vocabulary (`components/page.tsx`). There is no page column:
//! every page fills its pane edge to edge, and pages compose these pieces
//! instead of hand-rolling grids.
//!
//! - [`ConfigGrid`]: flush sections in one column, two from 940 px of page
//!   (`@min-[940px]/page`), with a hairline between the columns.
//! - [`Gallery`]: picture cards that fill by width
//!   (`repeat(auto-fill, minmax(180px, 1fr))`, gap 12).
//! - [`PageStack`]: one column of flush sections.
//!
//! CSS answers `auto-fill` and the container query in layout; GPUI's grid
//! takes a fixed track count, so the grid and the gallery measure their own
//! width (the page's, as they are flush) and redraw once when it changes.

use gpui::{
    AnyElement, App, Bounds, ElementId, Entity, IntoElement, Pixels, SharedString, Window, div,
    prelude::*, px,
};
use gpui_base::ElementExt as _;
use smallvec::SmallVec;

use crate::{
    scroll_area::ScrollArea,
    theme::{Appearance, hsla, resolve},
};

/// The one page breakpoint: two config columns from here.
pub const CONFIG_GRID_TWO_COLUMNS: f32 = 940.0;
/// The gallery's gap (`gap-3`).
pub const GALLERY_GAP: f32 = 12.0;

/// The width an element had in its last frame, kept between frames.
fn measured_width(id: &ElementId, window: &mut Window, cx: &mut App) -> Entity<f32> {
    window.use_keyed_state(
        gpui::SharedString::from(format!("{id}/measured-width")),
        cx,
        |_, _| 0.0_f32,
    )
}

/// Records `bounds`' width; when it changed, the window draws again so the
/// layout that depends on it follows on the next frame.
fn record_width(state: &Entity<f32>, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut App) {
    let width = f32::from(bounds.size.width);
    if (state.read(cx) - width).abs() > 0.5 {
        state.update(cx, |w, _| *w = width);
        // `refresh` is a no-op while the window draws, and prepaint
        // is drawing: ask for it from the next frame, where it
        // re-renders every view with the new width.
        window.on_next_frame(|window, _| window.refresh());
    }
}

type SectionsFor = Box<dyn FnOnce(bool) -> Vec<AnyElement>>;

/// One column of a two-column grid: CSS `minmax(min, <fr>fr)`. The columns
/// share the row by their `fr`, and one never narrows under its `min`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Track {
    pub fr: f32,
    pub min: f32,
}

impl Track {
    /// `minmax(0, <fr>fr)`.
    pub const fn fr(fr: f32) -> Self {
        Track { fr, min: 0.0 }
    }

    /// `minmax(<min>px, <fr>fr)`.
    pub const fn min(self, min: f32) -> Self {
        Track { fr: self.fr, min }
    }
}

/// `grid-cols-2`: equal halves (`ConfigGrid`'s default).
pub const CONFIG_GRID_TRACKS: [Track; 2] = [Track::fr(1.0), Track::fr(1.0)];
/// `SCENE_GRID`: the canvas and its sources | the overlays.
pub const SCENE_GRID: [Track; 2] = [Track::fr(1.3), Track::fr(1.0)];
/// `CAPTIONS_GRID`: the preview | the controls, never under 380 px.
pub const CAPTIONS_GRID: [Track; 2] = [Track::fr(1.2), Track::fr(0.8).min(380.0)];
/// `LIVESTREAM_SETUP_GRID`: destinations and details | output and health.
pub const LIVESTREAM_SETUP_GRID: [Track; 2] = [Track::fr(1.5), Track::fr(1.0)];
/// `CLEAN_CUT_REVIEW_GRID`: the player | the transcript.
pub const CLEAN_CUT_REVIEW_GRID: [Track; 2] = [Track::fr(1.0), Track::fr(1.15)];

/// A column of a two-column grid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigColumn {
    Lead,
    Trail,
}

/// Flush sections in one column, two from 940 px of page with a hairline
/// between the columns. Rows stretch: a short section leaves the pane's
/// background below it. [`ConfigGrid::pair`] is `CONFIG_GRID_PAIR`: two
/// sections that fill the visible height side by side, so the column
/// hairline runs to the foot however short the page is.
#[derive(IntoElement)]
pub struct ConfigGrid {
    id: ElementId,
    two_columns: Option<bool>,
    pair: bool,
    children: SmallVec<[AnyElement; 4]>,
    /// Sections built once the grid knows its column count.
    sections_for: Option<SectionsFor>,
    tracks: [Track; 2],
    scroll: Option<ConfigColumn>,
    appearance: Option<Appearance>,
}

impl ConfigGrid {
    pub fn new(id: impl Into<ElementId>) -> Self {
        ConfigGrid {
            id: id.into(),
            two_columns: None,
            pair: false,
            children: SmallVec::new(),
            sections_for: None,
            tracks: CONFIG_GRID_TRACKS,
            scroll: None,
            appearance: None,
        }
    }

    /// The two columns' widths, as Electron's page grids set them
    /// (`grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]`): [`SCENE_GRID`],
    /// [`CAPTIONS_GRID`], [`LIVESTREAM_SETUP_GRID`], [`CLEAN_CUT_REVIEW_GRID`].
    pub fn tracks(mut self, tracks: [Track; 2]) -> Self {
        self.tracks = tracks;
        self
    }

    /// In two columns, this column scrolls on its own while the other stays
    /// in view (Captions: the controls scroll beside the pinned preview,
    /// Electron's `CAPTIONS_PREVIEW_PIN`). The grid then takes the rest of
    /// the page's height, as [`Self::pair`] does, so put it in a pane that
    /// does not scroll itself; stacked, nothing scrolls inside the grid.
    /// For a grid of two sections.
    pub fn scroll_column(mut self, column: ConfigColumn) -> Self {
        self.scroll = Some(column);
        self
    }

    /// Forces the column count when the screen already knows the page's
    /// width; otherwise the grid measures its own (flush, so the page's).
    pub fn two_columns(mut self, two: bool) -> Self {
        self.two_columns = Some(two);
        self
    }

    /// `CONFIG_GRID_PAIR`: the grid takes the rest of the page's height
    /// (`flex-1`), and in two columns its row stretches to fill it.
    pub fn pair(mut self, pair: bool) -> Self {
        self.pair = pair;
        self
    }

    /// Builds the sections once the grid has chosen its columns: `build`
    /// gets `true` for two. CONFIG_GRID_PAIR's sections drop their bottom
    /// hairline in two columns (`[&>*]:border-b-0`, the column rule divides
    /// them) and keep it stacked, where it separates the halves; a screen
    /// draws that from the flag instead of measuring the page itself. Runs
    /// after any `child`ren.
    pub fn children_for(mut self, build: impl FnOnce(bool) -> Vec<AnyElement> + 'static) -> Self {
        self.sections_for = Some(Box::new(build));
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl ParentElement for ConfigGrid {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for ConfigGrid {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let width = measured_width(&self.id, window, cx);
        let two = self
            .two_columns
            .unwrap_or_else(|| *width.read(cx) >= CONFIG_GRID_TWO_COLUMNS);
        let scroll = self.scroll.filter(|_| two);
        // A column that scrolls on its own needs the grid to have a height.
        let fill = self.pair || scroll.is_some();
        let tracks = self.tracks;
        let scroll_id = SharedString::from(format!("{}/scroll", self.id));
        let mut children = self.children;
        if let Some(build) = self.sections_for {
            children.extend(build(two));
        }
        let grid = div()
            .id(self.id)
            .w_full()
            .flex()
            .flex_col()
            .when(fill, |grid| grid.flex_1().min_h(px(0.0)))
            .on_prepaint(move |bounds, window, cx| record_width(&width, bounds, window, cx));
        if !two {
            return grid.children(children);
        }
        // One column: `minmax(min, fr)` as a flex item (basis 0, grows by
        // its fr, never under its min); the one that scrolls wraps its
        // section in a ScrollArea of the row's height.
        let cell = |track: Track, column: ConfigColumn, content: Option<AnyElement>| {
            let mut cell = div()
                .flex()
                .flex_col()
                .flex_basis(px(0.0))
                .min_w(px(track.min))
                .min_h(px(0.0));
            cell.style().flex_grow = Some(track.fr);
            cell.style().flex_shrink = Some(1.0);
            let cell = cell.when(column == ConfigColumn::Lead, |cell| {
                // `[&>*:nth-child(odd)]:border-r`: the column hairline.
                cell.border_r_1().border_color(hsla(t.border))
            });
            if scroll == Some(column) {
                cell.child(
                    ScrollArea::new(scroll_id.clone())
                        .children(content)
                        .into_any_element(),
                )
            } else {
                cell.children(content)
            }
        };
        let mut rows: Vec<AnyElement> = Vec::new();
        let mut cells = children.into_iter().peekable();
        while let Some(left) = cells.next() {
            let right = cells.next();
            let first = rows.is_empty();
            rows.push(
                div()
                    .flex()
                    .flex_row()
                    .w_full()
                    .when(fill && first, |row| row.flex_1().min_h(px(0.0)))
                    .child(cell(tracks[0], ConfigColumn::Lead, Some(left)))
                    .child(cell(tracks[1], ConfigColumn::Trail, right))
                    .into_any_element(),
            );
        }
        grid.children(rows)
    }
}

/// Picture cards that fill by width: 180 px tracks, 160 when `dense`, at
/// most five a row with `rows_of_five`; the cards share the row's spare
/// width (`1fr`), 12 px apart.
#[derive(IntoElement)]
pub struct Gallery {
    id: ElementId,
    dense: bool,
    rows_of_five: bool,
    children: SmallVec<[AnyElement; 8]>,
}

impl Gallery {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Gallery {
            id: id.into(),
            dense: false,
            rows_of_five: false,
            children: SmallVec::new(),
        }
    }

    /// Smaller cards (10 rem), for a picker inside a dialog.
    pub fn dense(mut self, dense: bool) -> Self {
        self.dense = dense;
        self
    }

    /// At most five cards a row, shrinking to 11 rem so five fit the default
    /// window: ten cards read as two rows of five.
    pub fn rows_of_five(mut self, rows_of_five: bool) -> Self {
        self.rows_of_five = rows_of_five;
        self
    }
}

impl ParentElement for Gallery {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// How many `auto-fill` tracks of at least `min` fit `width` with `gap`.
pub fn gallery_columns(width: f32, dense: bool, rows_of_five: bool) -> u16 {
    let min = if dense {
        160.0
    } else if rows_of_five {
        // `minmax(max(11rem, (100% - 3rem) / 5 - 1px), 1fr)`.
        (176.0_f32).max((width - 4.0 * GALLERY_GAP) / 5.0 - 1.0)
    } else {
        180.0
    };
    let fit = ((width + GALLERY_GAP) / (min + GALLERY_GAP)).floor();
    fit.clamp(1.0, u16::MAX as f32) as u16
}

impl RenderOnce for Gallery {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let width = measured_width(&self.id, window, cx);
        let columns = gallery_columns(*width.read(cx), self.dense, self.rows_of_five);
        div()
            .id(self.id)
            .w_full()
            .grid()
            .grid_cols(columns)
            .gap(px(GALLERY_GAP))
            .on_prepaint(move |bounds, window, cx| record_width(&width, bounds, window, cx))
            .children(self.children)
    }
}

/// A single column of flush sections (`flex flex-col`).
#[derive(IntoElement, Default)]
pub struct PageStack {
    children: SmallVec<[AnyElement; 4]>,
}

impl PageStack {
    pub fn new() -> Self {
        PageStack::default()
    }
}

impl ParentElement for PageStack {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for PageStack {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        div().w_full().flex().flex_col().children(self.children)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gallery_fills_by_width() {
        assert_eq!(gallery_columns(0.0, false, false), 1);
        assert_eq!(gallery_columns(179.0, false, false), 1);
        // 4 × 180 + 3 × 12 = 756.
        assert_eq!(gallery_columns(756.0, false, false), 4);
        assert_eq!(gallery_columns(755.0, false, false), 3);
        assert_eq!(gallery_columns(756.0, true, false), 4);
        // Five a row at most, however wide.
        assert_eq!(gallery_columns(2400.0, false, true), 5);
        assert_eq!(gallery_columns(940.0, false, true), 5);
    }
}
