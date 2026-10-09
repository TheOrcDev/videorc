//! S-F3, first half: measure every cell and register it onto a common
//! square canvas, a port of page-pet's `scripts/build_pack.py`
//! (`body_metrics`, the per-box checks of `extract`, and the per-frame
//! loop of `compile_pack`).
//!
//! The foot anchor is the alpha-weighted centre of the lower-body band
//! (82 to 96 % of the silhouette height) and the silhouette bottom. One
//! scale per cell is decided by the caller ([`super`]: `neutral-height` for
//! gaze strips, `full-height` for reactions and extras) and the cell is
//! resampled onto `size` by `size` so that its anchor lands on the target
//! pivot. A pose that would need less than 8 px of margin is rejected,
//! never shrunk. The registered cell is measured again and must not have
//! drifted from the pivot (1.5 px in x, 1 px at the bottom).

use image::RgbaImage;
use sha2::{Digest, Sha256};

use super::VISIBLE_ALPHA;
use super::cut::SourceBox;

/// Lower-body band of the silhouette height used for the foot anchor.
const FOOT_BAND_START: f64 = 0.82;
const FOOT_BAND_END: f64 = 0.96;
/// A cell must keep at least this share of fully transparent pixels.
pub(super) const MIN_TRANSPARENT_FRACTION: f64 = 0.08;
/// Minimum measured margin between the registered silhouette and the cell.
pub const MIN_MARGIN_PX: f64 = 8.0;
/// Minimum transparent padding measured on the registered cell.
pub(super) const MIN_OUTPUT_PADDING_PX: i64 = 3;
/// Maximum root drift between the registered cell and the pivot.
pub const MAX_ROOT_DRIFT_X_PX: f64 = 1.5;
pub const MAX_ROOT_DRIFT_BOTTOM_PX: f64 = 1.0;

/// Half-open bounds of the visible silhouette (alpha above 16).
pub type Bounds = SourceBox;

#[derive(Debug, Clone, PartialEq)]
pub(super) struct BodyMetrics {
    pub bounds: Bounds,
    /// `[x, y]`: the alpha-weighted centre of the lower-body band, and the
    /// silhouette bottom.
    pub anchor: [f64; 2],
    /// Width of the central 90 % of the lower-body mass.
    pub body_width: u32,
}

impl BodyMetrics {
    /// Silhouette height from its top to the foot anchor.
    pub fn height(&self) -> f64 {
        self.anchor[1] - f64::from(self.bounds.top)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum MetricsFailure {
    Empty,
    NoLowerBand,
}

fn round_half_even(value: f64) -> u32 {
    value.round_ties_even() as u32
}

pub(super) fn visible_bounds(cell: &RgbaImage) -> Option<Bounds> {
    let mut bounds: Option<Bounds> = None;
    for (x, y, pixel) in cell.enumerate_pixels() {
        if pixel.0[3] <= VISIBLE_ALPHA {
            continue;
        }
        bounds = Some(match bounds {
            None => SourceBox {
                left: x,
                top: y,
                right: x + 1,
                bottom: y + 1,
            },
            Some(b) => SourceBox {
                left: b.left.min(x),
                top: b.top.min(y),
                right: b.right.max(x + 1),
                bottom: b.bottom.max(y + 1),
            },
        });
    }
    bounds
}

/// page-pet `body_metrics`: bounds of alpha above 16, the foot anchor from
/// the 82 to 96 % band, and the body width.
pub(super) fn body_metrics(cell: &RgbaImage) -> Result<BodyMetrics, MetricsFailure> {
    let bounds = visible_bounds(cell).ok_or(MetricsFailure::Empty)?;
    let height = f64::from(bounds.height());
    let y0 = bounds.top + round_half_even(height * FOOT_BAND_START);
    let y1 = bounds.top + round_half_even(height * FOOT_BAND_END);
    let width = cell.width() as usize;
    let mut mass = vec![0u64; width];
    for y in y0..y1 {
        for (x, value) in mass.iter_mut().enumerate() {
            let alpha = cell.get_pixel(x as u32, y).0[3];
            if alpha > VISIBLE_ALPHA {
                *value += u64::from(alpha);
            }
        }
    }
    let total: u64 = mass.iter().sum();
    if total == 0 {
        return Err(MetricsFailure::NoLowerBand);
    }
    let total_f = total as f64;
    let center = mass
        .iter()
        .enumerate()
        .map(|(x, value)| (x as f64 + 0.5) * *value as f64)
        .sum::<f64>()
        / total_f;
    let mut cumulative = 0u64;
    let mut low = None;
    let mut high = None;
    for (x, value) in mass.iter().enumerate() {
        cumulative += value;
        if low.is_none() && cumulative as f64 >= total_f * 0.05 {
            low = Some(x);
        }
        if cumulative as f64 >= total_f * 0.95 {
            high = Some(x + 1);
            break;
        }
    }
    let (Some(low), Some(high)) = (low, high) else {
        return Err(MetricsFailure::NoLowerBand);
    };
    Ok(BodyMetrics {
        bounds,
        anchor: [center, f64::from(bounds.bottom)],
        body_width: (high - low) as u32,
    })
}

/// One cell cut from a sheet, with its measurements.
pub(super) struct ExtractedCell {
    pub image: RgbaImage,
    pub source_box: SourceBox,
    pub metrics: BodyMetrics,
    /// SHA-256 of the visible crop's RGBA bytes: exact duplicate art shares
    /// a hash wherever it sits on a sheet.
    pub pixel_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ExtractFailure {
    /// Fewer than 8 % fully transparent pixels in the box.
    Opaque,
    /// No visible pixel at all.
    Empty,
    /// No visible mass in the lower-body band.
    NoLowerBand,
    /// The silhouette touches the box edge: the cut clipped it.
    TouchesEdge,
}

pub(super) fn extract_cell(
    sheet: &RgbaImage,
    source_box: SourceBox,
) -> Result<ExtractedCell, ExtractFailure> {
    let image = image::imageops::crop_imm(
        sheet,
        source_box.left,
        source_box.top,
        source_box.width(),
        source_box.height(),
    )
    .to_image();
    let (width, height) = image.dimensions();
    let transparent = image.pixels().filter(|pixel| pixel.0[3] == 0).count();
    if (transparent as f64) / f64::from(width * height) < MIN_TRANSPARENT_FRACTION {
        return Err(ExtractFailure::Opaque);
    }
    let metrics = body_metrics(&image).map_err(|failure| match failure {
        MetricsFailure::Empty => ExtractFailure::Empty,
        MetricsFailure::NoLowerBand => ExtractFailure::NoLowerBand,
    })?;
    let bounds = metrics.bounds;
    if bounds.left == 0 || bounds.top == 0 || bounds.right == width || bounds.bottom == height {
        return Err(ExtractFailure::TouchesEdge);
    }
    let mut hasher = Sha256::new();
    for y in bounds.top..bounds.bottom {
        for x in bounds.left..bounds.right {
            hasher.update(image.get_pixel(x, y).0);
        }
    }
    Ok(ExtractedCell {
        image,
        source_box,
        metrics,
        pixel_sha256: format!("{:x}", hasher.finalize()),
    })
}

/// A cell registered onto the common canvas.
pub(super) struct Registration {
    pub image: RgbaImage,
    pub scale: f64,
    pub minimum_margin: f64,
    pub output_bounds: Bounds,
    pub anchor_drift: [f64; 2],
    pub body_width: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum RegisterFailure {
    /// The pose would need less than 8 px of margin at this scale.
    Margin { margin: f64 },
    /// The registered cell lost its silhouette or its lower band.
    Unmeasurable,
    /// Less than 3 px of transparent padding after registration.
    OutputPadding { padding: i64 },
    /// The registered root does not sit on the pivot.
    Drift { drift: [f64; 2] },
}

fn round_to(value: f64, decimals: i32) -> f64 {
    let factor = 10f64.powi(decimals);
    (value * factor).round() / factor
}

/// page-pet `compile_pack`, one frame: margins, the affine resample onto
/// `size` by `size` with the anchor on `target`, then the drift checks.
pub(super) fn register_cell(
    cell: &ExtractedCell,
    scale: f64,
    size: u32,
    target: [f64; 2],
) -> Result<Registration, RegisterFailure> {
    let size_f = f64::from(size);
    let [ax, ay] = cell.metrics.anchor;
    let bounds = cell.metrics.bounds;
    let (l, t, r, b) = (
        f64::from(bounds.left),
        f64::from(bounds.top),
        f64::from(bounds.right),
        f64::from(bounds.bottom),
    );
    let margins = [
        target[0] - (ax - l) * scale,
        target[1] - (ay - t) * scale,
        size_f - target[0] - (r - ax) * scale,
        size_f - target[1] - (b - ay) * scale,
    ];
    let minimum_margin = margins.iter().copied().fold(f64::INFINITY, f64::min);
    if minimum_margin < MIN_MARGIN_PX {
        return Err(RegisterFailure::Margin {
            margin: round_to(minimum_margin, 2),
        });
    }
    let left = target[0] - ax * scale;
    let top = target[1] - ay * scale;
    let image = resample(&cell.image, size, scale, left, top);
    let measured = body_metrics(&image).map_err(|_| RegisterFailure::Unmeasurable)?;
    let output_bounds = measured.bounds;
    let padding = [
        i64::from(output_bounds.left),
        i64::from(output_bounds.top),
        i64::from(size) - i64::from(output_bounds.right),
        i64::from(size) - i64::from(output_bounds.bottom),
    ]
    .into_iter()
    .min()
    .unwrap_or(0);
    if padding < MIN_OUTPUT_PADDING_PX {
        return Err(RegisterFailure::OutputPadding { padding });
    }
    let anchor_drift = [
        round_to(measured.anchor[0] - target[0], 3),
        round_to(measured.anchor[1] - target[1], 3),
    ];
    if anchor_drift[0].abs() > MAX_ROOT_DRIFT_X_PX
        || anchor_drift[1].abs() > MAX_ROOT_DRIFT_BOTTOM_PX
    {
        return Err(RegisterFailure::Drift {
            drift: anchor_drift,
        });
    }
    Ok(Registration {
        image,
        scale,
        minimum_margin,
        output_bounds,
        anchor_drift,
        body_width: measured.body_width,
    })
}

/// Catmull-Rom cubic (the standard bicubic kernel, a = -0.5).
fn catmull_rom(x: f64) -> f64 {
    let x = x.abs();
    if x < 1.0 {
        (1.5 * x - 2.5) * x * x + 1.0
    } else if x < 2.0 {
        ((-0.5 * x + 2.5) * x - 4.0) * x + 2.0
    } else {
        0.0
    }
}

/// Normalised kernel weights around `center` (source pixel coordinates,
/// pixel centres at `i + 0.5`), widened by `filter_scale` when downscaling
/// so that every source pixel contributes once. `None` when the window
/// misses the source entirely.
fn kernel_weights(center: f64, filter_scale: f64, length: usize) -> Option<(usize, Vec<f64>)> {
    let radius = 2.0 * filter_scale;
    let start = (center - radius).floor().max(0.0) as usize;
    let end = ((center + radius).ceil().max(0.0) as usize).min(length);
    if start >= end {
        return None;
    }
    let mut weights: Vec<f64> = (start..end)
        .map(|index| catmull_rom((index as f64 + 0.5 - center) / filter_scale))
        .collect();
    let sum: f64 = weights.iter().sum();
    if sum.abs() < 1e-9 {
        return None;
    }
    for weight in &mut weights {
        *weight /= sum;
    }
    Some((start, weights))
}

/// Resample `src` scaled by `scale` and translated by (`left`, `top`) onto
/// a `size` by `size` transparent canvas: output pixel centre `o + 0.5`
/// samples source coordinate `(o + 0.5 - offset) / scale`. Separable
/// Catmull-Rom on premultiplied alpha, so transparent neighbours never
/// darken an edge.
pub(super) fn resample(src: &RgbaImage, size: u32, scale: f64, left: f64, top: f64) -> RgbaImage {
    let (src_w, src_h) = src.dimensions();
    let (src_w_us, src_h_us, size_us) = (src_w as usize, src_h as usize, size as usize);
    let filter_scale = (1.0 / scale).max(1.0);

    let mut premultiplied = vec![0f32; src_w_us * src_h_us * 4];
    for (index, pixel) in src.pixels().enumerate() {
        let alpha = f32::from(pixel.0[3]) / 255.0;
        let out = &mut premultiplied[index * 4..index * 4 + 4];
        out[0] = f32::from(pixel.0[0]) / 255.0 * alpha;
        out[1] = f32::from(pixel.0[1]) / 255.0 * alpha;
        out[2] = f32::from(pixel.0[2]) / 255.0 * alpha;
        out[3] = alpha;
    }

    // Vertical pass: output rows by source columns.
    let stride = src_w_us * 4;
    let mut mid = vec![0f32; size_us * stride];
    for (oy, row) in mid.chunks_mut(stride).enumerate() {
        let sy = (oy as f64 + 0.5 - top) / scale;
        let Some((start, weights)) = kernel_weights(sy, filter_scale, src_h_us) else {
            continue;
        };
        for (k, weight) in weights.iter().enumerate() {
            let weight = *weight as f32;
            let source_row = &premultiplied[(start + k) * stride..(start + k + 1) * stride];
            for (acc, value) in row.iter_mut().zip(source_row) {
                *acc += weight * value;
            }
        }
    }

    // Horizontal pass.
    let column_weights: Vec<Option<(usize, Vec<f64>)>> = (0..size_us)
        .map(|ox| kernel_weights((ox as f64 + 0.5 - left) / scale, filter_scale, src_w_us))
        .collect();
    let mut out = RgbaImage::new(size, size);
    for oy in 0..size_us {
        let row = &mid[oy * stride..(oy + 1) * stride];
        for (ox, weights) in column_weights.iter().enumerate() {
            let Some((start, weights)) = weights else {
                continue;
            };
            let mut acc = [0f32; 4];
            for (k, weight) in weights.iter().enumerate() {
                let weight = *weight as f32;
                let source = &row[(start + k) * 4..(start + k) * 4 + 4];
                for (total, value) in acc.iter_mut().zip(source) {
                    *total += weight * value;
                }
            }
            // Colour comes from the raw alpha sum: the kernel's negative
            // lobes make the sum overshoot 1 beside a transparent run, and
            // dividing by a clamped alpha would brighten a flat colour by a
            // level. Only the stored alpha is clamped.
            let raw_alpha = acc[3];
            let alpha = (raw_alpha.clamp(0.0, 1.0) * 255.0).round() as u8;
            if raw_alpha <= 0.0 || alpha == 0 {
                continue;
            }
            let straight = |value: f32| ((value / raw_alpha).clamp(0.0, 1.0) * 255.0).round() as u8;
            out.put_pixel(
                ox as u32,
                oy as u32,
                image::Rgba([straight(acc[0]), straight(acc[1]), straight(acc[2]), alpha]),
            );
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn fill(image: &mut RgbaImage, left: u32, top: u32, right: u32, bottom: u32, color: Rgba<u8>) {
        for y in top..bottom {
            for x in left..right {
                image.put_pixel(x, y, color);
            }
        }
    }

    const INK: Rgba<u8> = Rgba([30, 60, 90, 255]);

    #[test]
    fn body_metrics_find_the_foot_centre_and_the_bottom() {
        let mut cell = RgbaImage::new(100, 100);
        // Body 20..60 wide, feet band 20..30 and 50..60 at the bottom rows.
        fill(&mut cell, 20, 10, 60, 70, INK);
        fill(&mut cell, 20, 70, 30, 90, INK);
        fill(&mut cell, 50, 70, 60, 90, INK);
        let metrics = body_metrics(&cell).unwrap();
        assert_eq!(
            metrics.bounds,
            SourceBox {
                left: 20,
                top: 10,
                right: 60,
                bottom: 90
            }
        );
        assert!((metrics.anchor[0] - 40.0).abs() < 1e-9);
        assert_eq!(metrics.anchor[1], 90.0);
        // Band 82..96 % of 80 rows: rows 76..87, only the feet. Twenty equal
        // columns: the 5 % mark is the first, the 95 % mark the nineteenth.
        assert_eq!(metrics.body_width, 39);
    }

    #[test]
    fn body_metrics_fail_without_lower_band_mass() {
        let mut cell = RgbaImage::new(100, 100);
        fill(&mut cell, 20, 10, 60, 40, INK);
        // A detached dot far below leaves the 82..96 % band empty.
        cell.put_pixel(40, 95, INK);
        assert_eq!(body_metrics(&cell), Err(MetricsFailure::NoLowerBand));
        assert_eq!(
            body_metrics(&RgbaImage::new(10, 10)),
            Err(MetricsFailure::Empty)
        );
    }

    #[test]
    fn extract_cell_rejects_opaque_clipped_and_empty_boxes() {
        let mut sheet = RgbaImage::new(100, 100);
        fill(&mut sheet, 0, 0, 100, 100, INK);
        let whole = SourceBox {
            left: 0,
            top: 0,
            right: 100,
            bottom: 100,
        };
        assert!(matches!(
            extract_cell(&sheet, whole),
            Err(ExtractFailure::Opaque)
        ));

        let mut sheet = RgbaImage::new(100, 100);
        fill(&mut sheet, 0, 10, 40, 90, INK);
        assert!(matches!(
            extract_cell(&sheet, whole),
            Err(ExtractFailure::TouchesEdge)
        ));

        let sheet = RgbaImage::new(100, 100);
        assert!(matches!(
            extract_cell(&sheet, whole),
            Err(ExtractFailure::Empty)
        ));
    }

    #[test]
    fn extract_cell_hashes_the_visible_crop_regardless_of_position() {
        let mut sheet = RgbaImage::new(200, 100);
        fill(&mut sheet, 10, 10, 40, 90, INK);
        fill(&mut sheet, 130, 10, 160, 90, INK);
        let a = extract_cell(
            &sheet,
            SourceBox {
                left: 0,
                top: 0,
                right: 100,
                bottom: 100,
            },
        )
        .unwrap();
        let b = extract_cell(
            &sheet,
            SourceBox {
                left: 100,
                top: 0,
                right: 200,
                bottom: 100,
            },
        )
        .unwrap();
        assert_eq!(a.pixel_sha256, b.pixel_sha256);
    }

    #[test]
    fn resample_at_unit_scale_and_integer_offset_copies_pixels() {
        let mut src = RgbaImage::new(20, 20);
        fill(&mut src, 4, 4, 12, 16, Rgba([200, 100, 50, 255]));
        src.put_pixel(6, 6, Rgba([10, 20, 30, 128]));
        let out = resample(&src, 32, 1.0, 5.0, 3.0);
        assert_eq!(*out.get_pixel(9, 7), Rgba([200, 100, 50, 255]));
        assert_eq!(*out.get_pixel(11, 9), Rgba([10, 20, 30, 128]));
        assert_eq!(*out.get_pixel(8, 7), Rgba([0, 0, 0, 0]));
        assert_eq!(*out.get_pixel(16, 7), Rgba([200, 100, 50, 255]));
        assert_eq!(*out.get_pixel(17, 7), Rgba([0, 0, 0, 0]));
    }

    #[test]
    fn resample_downscale_keeps_edges_crisp_and_colours_clean() {
        let mut src = RgbaImage::new(200, 200);
        fill(&mut src, 50, 50, 150, 150, Rgba([255, 0, 0, 255]));
        let out = resample(&src, 100, 0.5, 0.0, 0.0);
        // The block maps to 25..75; the centre is solid red, outside is clear.
        assert_eq!(*out.get_pixel(50, 50), Rgba([255, 0, 0, 255]));
        assert_eq!(*out.get_pixel(10, 10), Rgba([0, 0, 0, 0]));
        // Edge pixels keep the source colour: no dark fringe from premultiply.
        for x in 20..80 {
            let pixel = out.get_pixel(x, 50);
            if pixel.0[3] > 0 {
                assert_eq!(&pixel.0[..3], &[255, 0, 0], "fringe at x={x}: {pixel:?}");
            }
        }
    }

    #[test]
    fn register_cell_lands_the_anchor_on_the_pivot() {
        let mut sheet = RgbaImage::new(160, 300);
        fill(&mut sheet, 55, 30, 105, 200, INK);
        fill(&mut sheet, 62, 200, 72, 240, INK);
        fill(&mut sheet, 88, 200, 98, 240, INK);
        let cell = extract_cell(
            &sheet,
            SourceBox {
                left: 0,
                top: 0,
                right: 160,
                bottom: 300,
            },
        )
        .unwrap();
        let size = 128;
        let target = [64.0, 115.0];
        let scale = 128.0 * 0.65 / cell.metrics.height();
        let registered = register_cell(&cell, scale, size, target).unwrap();
        // The feet are symmetric, so the root stays on the pivot across; the
        // antialiased bottom edge may light one row below the pivot (alpha
        // just above 16), which is the 1 px page-pet allows.
        assert_eq!(registered.anchor_drift[0], 0.0);
        assert!(
            registered.anchor_drift[1].abs() <= 1.0,
            "{:?}",
            registered.anchor_drift
        );
        assert!((115..=116).contains(&registered.output_bounds.bottom));
        assert!(registered.minimum_margin >= MIN_MARGIN_PX);
        assert!((registered.scale - scale).abs() < 1e-12);
        // Inside the left leg (about 5 px left of the root) the cell is solid
        // ink; one and a half pixels below the pivot it is clear.
        assert_eq!(*registered.image.get_pixel(59, 110), INK);
        assert!(registered.image.get_pixel(59, 116).0[3] < 16);
    }

    #[test]
    fn register_cell_refuses_a_pose_that_needs_more_room() {
        let mut sheet = RgbaImage::new(160, 300);
        fill(&mut sheet, 55, 30, 105, 240, INK);
        let cell = extract_cell(
            &sheet,
            SourceBox {
                left: 0,
                top: 0,
                right: 160,
                bottom: 300,
            },
        )
        .unwrap();
        // A scale that puts the top 130 px above the pivot at 115.
        let scale = 130.0 / cell.metrics.height();
        assert!(matches!(
            register_cell(&cell, scale, 128, [64.0, 115.0]),
            Err(RegisterFailure::Margin { .. })
        ));
    }
}
