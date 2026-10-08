//! S-F1: adaptive alpha-gutter cuts, a port of page-pet's
//! `scripts/prepare_layout.py` (`cuts` and the box loop of `inspect`).
//!
//! A sheet is never divided into assumed equal cells. For every ideal grid
//! boundary the column (or row) profile of visible alpha (alpha above 16)
//! must contain a run of fully empty lines within 35 % of one cell of that
//! boundary; the run whose middle lies nearest the ideal boundary is the
//! cut. No run means no cut: the caller separates the characters with
//! [`super::isolate`] or the user generates the sheet again. There is no
//! equal-width fallback.

use image::RgbaImage;
use serde::Serialize;

use super::VISIBLE_ALPHA;

/// How far from the ideal boundary a gutter may sit, as a fraction of one
/// cell (page-pet: `length / count * .35`).
pub(super) const GUTTER_SEARCH_FRACTION: f64 = 0.35;

/// A half-open pixel box inside a sheet: `left..right` by `top..bottom`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SourceBox {
    pub left: u32,
    pub top: u32,
    pub right: u32,
    pub bottom: u32,
}

impl SourceBox {
    pub fn width(&self) -> u32 {
        self.right - self.left
    }

    pub fn height(&self) -> u32 {
        self.bottom - self.top
    }

    pub fn as_array(&self) -> [u32; 4] {
        [self.left, self.top, self.right, self.bottom]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Axis {
    Columns,
    Rows,
}

impl Axis {
    pub(super) fn noun(self) -> &'static str {
        match self {
            Axis::Columns => "columns",
            Axis::Rows => "rows",
        }
    }
}

/// No empty run near the boundary between `slot` and `slot + 1` on `axis`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct CutFailure {
    pub axis: Axis,
    pub slot: usize,
}

/// page-pet refuses a source whose alpha never reaches zero ("Source has no
/// transparent alpha"): a PNG extension alone is not transparency.
pub(super) fn has_transparent_pixel(image: &RgbaImage) -> bool {
    image.pixels().any(|pixel| pixel.0[3] == 0)
}

/// Sum of visible alpha per column (or row) of `region`. Only zero versus
/// non-zero matters to the cut; the sum is kept as page-pet keeps it.
fn profile(image: &RgbaImage, region: SourceBox, axis: Axis) -> Vec<u64> {
    let length = match axis {
        Axis::Columns => region.width(),
        Axis::Rows => region.height(),
    } as usize;
    let mut out = vec![0u64; length];
    for y in region.top..region.bottom {
        for x in region.left..region.right {
            let alpha = image.get_pixel(x, y).0[3];
            if alpha > VISIBLE_ALPHA {
                let index = match axis {
                    Axis::Columns => x - region.left,
                    Axis::Rows => y - region.top,
                } as usize;
                out[index] += u64::from(alpha);
            }
        }
    }
    out
}

/// Boundaries `[0, b1, .., b(count-1), length]` for `count` cells along a
/// profile. `Err(slot)` names the first boundary without an empty run.
pub(super) fn cut_positions(profile: &[u64], count: usize) -> Result<Vec<usize>, usize> {
    let length = profile.len();
    let mut boundaries = vec![0usize];
    for index in 1..count {
        let ideal = index as f64 * length as f64 / count as f64;
        let radius = length as f64 / count as f64 * GUTTER_SEARCH_FRACTION;
        let previous = boundaries[boundaries.len() - 1];
        let low = (previous + 1).max((ideal - radius) as usize);
        let high = length.min((ideal + radius) as usize);
        let mut runs: Vec<(usize, usize)> = Vec::new();
        for (position, value) in profile.iter().enumerate().take(high).skip(low) {
            if *value != 0 {
                continue;
            }
            match runs.last_mut() {
                Some(run) if position == run.1 + 1 => run.1 = position,
                _ => runs.push((position, position)),
            }
        }
        let distance = |run: &(usize, usize)| ((run.0 + run.1) as f64 / 2.0 - ideal).abs();
        let Some(run) = runs
            .iter()
            .min_by(|a, b| distance(a).total_cmp(&distance(b)))
        else {
            return Err(index);
        };
        boundaries.push((run.0 + run.1) / 2);
    }
    boundaries.push(length);
    Ok(boundaries)
}

/// Row-major boxes for a `cols` by `rows` grid: columns are cut on the whole
/// sheet, then every column is cut into rows on its own, as page-pet does.
pub(super) fn cut_grid(
    image: &RgbaImage,
    cols: usize,
    rows: usize,
) -> Result<Vec<SourceBox>, CutFailure> {
    let (width, height) = image.dimensions();
    let whole = SourceBox {
        left: 0,
        top: 0,
        right: width,
        bottom: height,
    };
    let xs =
        cut_positions(&profile(image, whole, Axis::Columns), cols).map_err(|slot| CutFailure {
            axis: Axis::Columns,
            slot,
        })?;
    let mut boxes = vec![whole; cols * rows];
    for col in 0..cols {
        let column = SourceBox {
            left: xs[col] as u32,
            top: 0,
            right: xs[col + 1] as u32,
            bottom: height,
        };
        let ys = cut_positions(&profile(image, column, Axis::Rows), rows).map_err(|slot| {
            CutFailure {
                axis: Axis::Rows,
                slot,
            }
        })?;
        for row in 0..rows {
            boxes[row * cols + col] = SourceBox {
                left: column.left,
                top: ys[row] as u32,
                right: column.right,
                bottom: ys[row + 1] as u32,
            };
        }
    }
    Ok(boxes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn profile_with_gaps(length: usize, gaps: &[(usize, usize)]) -> Vec<u64> {
        let mut profile = vec![255u64; length];
        for &(start, end) in gaps {
            for value in profile.iter_mut().take(end).skip(start) {
                *value = 0;
            }
        }
        profile
    }

    #[test]
    fn cut_positions_take_the_middle_of_the_nearest_empty_run() {
        // Gutters of unequal width sitting off the ideal boundaries.
        let profile = profile_with_gaps(500, &[(90, 110), (215, 225), (280, 320), (396, 404)]);
        let cuts = cut_positions(&profile, 5).unwrap();
        // (first + last) // 2 of each run, as page-pet computes it.
        assert_eq!(cuts, vec![0, 99, 219, 299, 399, 500]);
    }

    #[test]
    fn cut_positions_prefer_the_run_nearest_the_ideal_boundary() {
        // Two runs inside the search window; the one centred nearer 250 wins.
        let profile = profile_with_gaps(500, &[(180, 190), (262, 270)]);
        let cuts = cut_positions(&profile, 2).unwrap();
        assert_eq!(cuts, vec![0, 265, 500]);
    }

    #[test]
    fn cut_positions_ignore_runs_outside_the_window() {
        // The gap at 60..70 is more than 35 % of a cell away from 250.
        let profile = profile_with_gaps(500, &[(60, 70)]);
        assert_eq!(cut_positions(&profile, 2), Err(1));
    }

    #[test]
    fn cut_positions_fail_on_the_first_missing_gutter_without_a_fallback() {
        let profile = profile_with_gaps(300, &[(95, 105)]);
        assert_eq!(cut_positions(&profile, 3), Err(2));
    }

    #[test]
    fn single_cell_needs_no_cut() {
        assert_eq!(cut_positions(&[255; 40], 1).unwrap(), vec![0, 40]);
    }

    #[test]
    fn cut_grid_returns_row_major_boxes_from_uneven_gutters() {
        let mut image = RgbaImage::new(200, 120);
        let blocks = [
            (10, 10, 80, 50),
            (120, 5, 190, 55),
            (20, 70, 90, 110),
            (110, 65, 185, 115),
        ];
        for (left, top, right, bottom) in blocks {
            for y in top..bottom {
                for x in left..right {
                    image.put_pixel(x, y, Rgba([200, 20, 20, 255]));
                }
            }
        }
        let boxes = cut_grid(&image, 2, 2).unwrap();
        // Column gutter 90..110 (ideal 100) then per-column row gutters.
        assert_eq!(
            boxes[0],
            SourceBox {
                left: 0,
                top: 0,
                right: 99,
                bottom: 59
            }
        );
        assert_eq!(
            boxes[1],
            SourceBox {
                left: 99,
                top: 0,
                right: 200,
                bottom: 59
            }
        );
        assert_eq!(
            boxes[2],
            SourceBox {
                left: 0,
                top: 59,
                right: 99,
                bottom: 120
            }
        );
        assert_eq!(
            boxes[3],
            SourceBox {
                left: 99,
                top: 59,
                right: 200,
                bottom: 120
            }
        );
    }

    #[test]
    fn cut_grid_names_the_axis_and_slot_without_a_gutter() {
        let mut image = RgbaImage::new(200, 60);
        for y in 10..50 {
            for x in 10..190 {
                image.put_pixel(x, y, Rgba([0, 0, 0, 255]));
            }
        }
        assert_eq!(
            cut_grid(&image, 2, 1),
            Err(CutFailure {
                axis: Axis::Columns,
                slot: 1
            })
        );
    }

    #[test]
    fn faint_alpha_counts_as_empty() {
        let mut image = RgbaImage::new(100, 20);
        for x in 0..100 {
            let alpha = if (45..55).contains(&x) { 16 } else { 255 };
            image.put_pixel(x, 10, Rgba([0, 0, 0, alpha]));
        }
        assert_eq!(cut_grid(&image, 2, 1).unwrap()[0].right, 49);
    }
}
