//! Plan 220 S3.2x.3: the Stream Manager's chat list draws only the rows in
//! view, as Electron's does (`use-chat-list.ts` on `@tanstack/react-virtual`:
//! the rows measured as they draw, an estimate for the rest, ten more on
//! each side). The window keeps every row the core holds (2,000); the list
//! builds the rows of [`ListWindow`] and stands the others in with two
//! spacers of their heights.
//!
//! A row's height is its measure once it was drawn, else [`ESTIMATE`] (a
//! one-line row, the list's 4 pt gap with it), so a spacer never moves
//! because another row was measured.

use std::collections::HashMap;

/// A row not drawn yet: a one-line row and its 4 pt gap (`estimateSize`).
pub const ESTIMATE: f64 = 60.625;
/// The rows drawn beyond each edge of the view (`overscan`).
pub const OVERSCAN: usize = 10;
/// The list's own padding above its first row.
pub const PADDING_TOP: f64 = 4.0;

/// The rows drawn, and the room the others take.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ListWindow {
    /// The first row drawn and one past the last.
    pub start: usize,
    pub end: usize,
    /// The heights of the rows above and below it (points).
    pub top: f64,
    pub bottom: f64,
}

impl ListWindow {
    pub fn len(&self) -> usize {
        self.end - self.start
    }

    pub fn is_empty(&self) -> bool {
        self.end <= self.start
    }

    pub fn contains(&self, index: usize) -> bool {
        index >= self.start && index < self.end
    }
}

/// Each row's height, in order: its measure, else the estimate.
pub fn row_heights(ids: &[String], measured: &HashMap<String, f64>) -> Vec<f64> {
    ids.iter()
        .map(|id| measured.get(id).copied().unwrap_or(ESTIMATE))
        .collect()
}

/// The top of each row from the first's (points), and the total after the
/// last: `heights.len() + 1` numbers.
fn tops(heights: &[f64]) -> Vec<f64> {
    let mut tops = Vec::with_capacity(heights.len() + 1);
    let mut at = 0.0;
    tops.push(at);
    for height in heights {
        at += height.max(0.0);
        tops.push(at);
    }
    tops
}

/// The rows to draw for a scroll offset (points from the list's top, its
/// padding included) and the list's visible height: every row any part of
/// which is in view and `overscan` more on each side. Following the newest,
/// the view is the list's foot whatever the offset says.
pub fn list_window(
    heights: &[f64],
    offset: f64,
    visible: f64,
    following: bool,
    overscan: usize,
) -> ListWindow {
    let count = heights.len();
    if count == 0 {
        return ListWindow::default();
    }
    let tops = tops(heights);
    let total = tops[count];
    let visible = visible.max(0.0);
    let from = if following {
        (total - visible).max(0.0)
    } else {
        (offset - PADDING_TOP).clamp(0.0, total)
    };
    let to = from + visible;
    // The first row whose foot is below the view's top, and one past the
    // last whose top is above the view's foot.
    let first = tops[1..]
        .partition_point(|foot| *foot <= from)
        .min(count - 1);
    let last = tops[..count]
        .partition_point(|top| *top < to)
        .max(first + 1);
    let start = first.saturating_sub(overscan);
    let end = (last + overscan).min(count);
    ListWindow {
        start,
        end,
        top: tops[start],
        bottom: total - tops[end],
    }
}

/// Where a row sits in the list's content (points, the padding included):
/// its top and its foot.
pub fn row_span(heights: &[f64], index: usize) -> Option<(f64, f64)> {
    let height = *heights.get(index)?;
    let top: f64 = heights[..index].iter().map(|height| height.max(0.0)).sum();
    Some((PADDING_TOP + top, PADDING_TOP + top + height.max(0.0)))
}

/// The scroll offset that brings a row into view with the least movement:
/// its top at the view's top when it is above, its foot at the view's foot
/// when it is below, the offset unchanged when it is in view.
pub fn offset_to_reveal(heights: &[f64], index: usize, offset: f64, visible: f64) -> Option<f64> {
    let (top, foot) = row_span(heights, index)?;
    Some(if top < offset {
        top
    } else if foot > offset + visible {
        (foot - visible).max(0.0)
    } else {
        offset
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn even(count: usize) -> Vec<f64> {
        vec![ESTIMATE; count]
    }

    #[test]
    fn a_following_list_draws_its_foot_and_ten_more() {
        let heights = even(2_000);
        let window = list_window(&heights, 0.0, 606.25, true, OVERSCAN);
        assert_eq!(window.end, 2_000);
        assert_eq!(window.start, 2_000 - 10 - OVERSCAN);
        assert!((window.top - window.start as f64 * ESTIMATE).abs() < 1e-6);
        assert_eq!(window.bottom, 0.0);
    }

    #[test]
    fn a_list_read_back_draws_the_rows_in_view() {
        let heights = even(2_000);
        let window = list_window(&heights, 0.0, 300.0, false, OVERSCAN);
        assert_eq!(window.start, 0);
        assert_eq!(window.top, 0.0);
        assert_eq!(window.end, 5 + OVERSCAN);
        // Half-way: the row under the view's top, and the overscan above.
        let offset = PADDING_TOP + 1_000.0 * ESTIMATE + 10.0;
        let middle = list_window(&heights, offset, 300.0, false, OVERSCAN);
        assert_eq!(middle.start, 1_000 - OVERSCAN);
        assert_eq!(middle.end, 1_005 + 1 + OVERSCAN);
        let total = 2_000.0 * ESTIMATE;
        assert!((middle.top + middle.bottom + middle.len() as f64 * ESTIMATE - total).abs() < 1e-6);
    }

    #[test]
    fn measured_rows_keep_their_heights_and_a_short_list_draws_whole() {
        let ids: Vec<String> = (0..3).map(|i| format!("m{i}")).collect();
        let measured = HashMap::from([("m1".to_string(), 120.0)]);
        let heights = row_heights(&ids, &measured);
        assert_eq!(heights, [ESTIMATE, 120.0, ESTIMATE]);
        let window = list_window(&heights, 0.0, 600.0, true, OVERSCAN);
        assert_eq!((window.start, window.end), (0, 3));
        assert_eq!((window.top, window.bottom), (0.0, 0.0));
        assert_eq!(
            list_window(&[], 0.0, 600.0, true, OVERSCAN),
            ListWindow::default()
        );
    }

    #[test]
    fn a_row_out_of_view_is_revealed_with_the_least_movement() {
        let heights = even(100);
        let offset = PADDING_TOP + 50.0 * ESTIMATE;
        // Above: its top to the view's top.
        let above = offset_to_reveal(&heights, 10, offset, 300.0).unwrap();
        assert!((above - (PADDING_TOP + 10.0 * ESTIMATE)).abs() < 1e-6);
        // Below: its foot to the view's foot.
        let below = offset_to_reveal(&heights, 80, offset, 300.0).unwrap();
        assert!((below - (PADDING_TOP + 81.0 * ESTIMATE - 300.0)).abs() < 1e-6);
        // In view: no movement.
        assert_eq!(offset_to_reveal(&heights, 51, offset, 300.0), Some(offset));
        assert_eq!(offset_to_reveal(&heights, 100, offset, 300.0), None);
    }
}
