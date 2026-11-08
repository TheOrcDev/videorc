#[cfg(test)]
use std::borrow::Cow;

/// One immutable latest-frame response for the Windows proof surface.
///
/// The capture stores already retain only the newest frame. This payload keeps
/// that latest-wins contract while avoiding PNG compression on every poll. A
/// top-down 32-bit BMP can carry the capture store's BGRA bytes directly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LatestPreviewBmp {
    pub generation: String,
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub pixel_format: &'static str,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewBmpCursor {
    pub generation: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LatestPreviewBmpPoll {
    Frame(LatestPreviewBmp),
    Unchanged { generation: String, sequence: u64 },
}

pub fn encode_latest_bgra_bmp(
    cursor: Option<&PreviewBmpCursor>,
    generation: String,
    sequence: u64,
    width: u32,
    height: u32,
    bytes: &[u8],
    max_width: u32,
) -> Option<LatestPreviewBmpPoll> {
    // Capture-local frame sequences restart at one whenever a source runtime is
    // replaced. Suppress only within the same runtime generation, and do it
    // before copying, resizing, or wrapping the frame as BMP.
    if cursor.is_some_and(|cursor| cursor.generation == generation && sequence <= cursor.sequence) {
        return Some(LatestPreviewBmpPoll::Unchanged {
            generation,
            sequence,
        });
    }

    let width = width.max(1);
    let height = height.max(1);
    let expected_len = usize::try_from(width)
        .ok()?
        .checked_mul(usize::try_from(height).ok()?)?
        .checked_mul(4)?;
    if bytes.len() < expected_len {
        return None;
    }

    let max_width = max_width.max(1);
    let source = &bytes[..expected_len];
    let (source_width, source_height) = (width, height);
    let (width, height) = bounded_dimensions(source_width, source_height, max_width);

    let stride = width.checked_mul(4)?;
    let pixel_bytes = stride.checked_mul(height)?;
    let file_size = 54_u32.checked_add(pixel_bytes)?;
    let width_i32 = i32::try_from(width).ok()?;
    let height_i32 = i32::try_from(height).ok()?.checked_neg()?;
    let mut bmp = Vec::with_capacity(file_size as usize);

    // BITMAPFILEHEADER (14 bytes).
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&file_size.to_le_bytes());
    bmp.extend_from_slice(&[0; 4]);
    bmp.extend_from_slice(&54_u32.to_le_bytes());
    // BITMAPINFOHEADER (40 bytes). A negative height makes rows top-down, so
    // the capture store's row order does not need a second full-frame copy.
    bmp.extend_from_slice(&40_u32.to_le_bytes());
    bmp.extend_from_slice(&width_i32.to_le_bytes());
    bmp.extend_from_slice(&height_i32.to_le_bytes());
    bmp.extend_from_slice(&1_u16.to_le_bytes());
    bmp.extend_from_slice(&32_u16.to_le_bytes());
    bmp.extend_from_slice(&0_u32.to_le_bytes());
    bmp.extend_from_slice(&pixel_bytes.to_le_bytes());
    bmp.extend_from_slice(&0_i32.to_le_bytes());
    bmp.extend_from_slice(&0_i32.to_le_bytes());
    bmp.extend_from_slice(&0_u32.to_le_bytes());
    bmp.extend_from_slice(&0_u32.to_le_bytes());
    if source_width <= max_width {
        // FrameHandle already retains immutable Arc-backed bytes for this call;
        // append them directly into the BMP instead of cloning a second raw
        // full-frame allocation first.
        bmp.extend_from_slice(source);
    } else {
        // Plan 191: resample the borrowed capture bytes (never a clone of them,
        // issue #157) straight into the BMP after its header, so the resized
        // frame is written once instead of built on its own and then copied.
        downscale_bgra_triangle_into(source, source_width, source_height, width, height, &mut bmp)?;
    }

    Some(LatestPreviewBmpPoll::Frame(LatestPreviewBmp {
        generation,
        sequence,
        width,
        height,
        stride,
        pixel_format: "bgra8",
        bytes: bmp,
    }))
}

/// The bounded preview size: a frame wider than `max_width` shrinks to that
/// width at its aspect ratio, its height floored but at least one row.
fn bounded_dimensions(width: u32, height: u32, max_width: u32) -> (u32, u32) {
    if width <= max_width {
        return (width, height);
    }
    let target_height = ((u64::from(height) * u64::from(max_width)) / u64::from(width))
        .max(1)
        .min(u64::from(u32::MAX)) as u32;
    (max_width, target_height)
}

/// The bounded pixels on their own: the retained frame borrowed as it is when
/// it fits, otherwise resampled. The encoder writes the same bytes straight
/// after its BMP header instead (plan 191), so only tests need this view.
#[cfg(test)]
fn bounded_bgra_pixels(
    bytes: &[u8],
    width: u32,
    height: u32,
    max_width: u32,
) -> Option<(Cow<'_, [u8]>, u32, u32)> {
    if width <= max_width {
        return Some((Cow::Borrowed(bytes), width, height));
    }

    let (target_width, target_height) = bounded_dimensions(width, height, max_width);
    let mut resized = Vec::new();
    downscale_bgra_triangle_into(
        bytes,
        width,
        height,
        target_width,
        target_height,
        &mut resized,
    )?;
    Some((Cow::Owned(resized), target_width, target_height))
}

/// Fraction bits of the integer triangle weights. One output pixel's weights
/// sum to exactly `1 << WEIGHT_BITS`, so a flat colour stays exact, and a whole
/// weight (32768) still fits a `u16`.
const WEIGHT_BITS: u32 = 15;
/// Fraction bits the vertical pass keeps per channel in its `u16` row:
/// 255 << 8 = 65280 fits, 256 times finer than one output level.
const ROW_FRACTION_BITS: u32 = 8;
/// Vertical sums peak at 255 << 15 and horizontal ones at
/// (65280 << 15) + (1 << 22) < 2^31, so `u32` accumulators never overflow.
const ROW_SHIFT: u32 = WEIGHT_BITS - ROW_FRACTION_BITS;
const OUTPUT_SHIFT: u32 = WEIGHT_BITS + ROW_FRACTION_BITS;

/// Downscales a BGRA frame (four u8 channels in any order, all treated alike)
/// with the filter of image 0.25.10's `resize(.., FilterType::Triangle)` and
/// appends the `target_width` x `target_height` pixels to `out`. `None` when
/// `src` is shorter than `width * height * 4`, as `ImageBuffer::from_raw` was.
///
/// Plan 191: image's resize is a generic f32 resampler (a vertical pass into a
/// full-frame `Rgba32FImage`, then a horizontal pass). Offline, in release, it
/// cost 9.5 ms of CPU per 1920x1080 -> 800 frame, 17 ms -> 1280, 25 ms for
/// 2560x1440 -> 1120 and 56 ms for 3840x2160 -> 1920, polled up to 25 times a
/// second. This keeps its kernel, support, sample centres, edge clamping and
/// normalisation as precomputed integer weights, runs the vertical pass one
/// output row at a time into a `u16` row, and rounds to output levels once at
/// the end, within one level of image's pixels.
fn downscale_bgra_triangle_into(
    src: &[u8],
    width: u32,
    height: u32,
    target_width: u32,
    target_height: u32,
    out: &mut Vec<u8>,
) -> Option<()> {
    let row_len = usize::try_from(width).ok()?.checked_mul(4)?;
    let src = src.get(..row_len.checked_mul(usize::try_from(height).ok()?)?)?;
    let out_row_len = usize::try_from(target_width).ok()?.checked_mul(4)?;
    let out_len = out_row_len.checked_mul(usize::try_from(target_height).ok()?)?;
    out.reserve(out_len);
    if src.is_empty() {
        // image's resize answers an empty source with a zeroed frame.
        out.resize(out.len() + out_len, 0);
        return Some(());
    }
    if out_len == 0 {
        return Some(());
    }

    let rows = TriangleTaps::new(height, target_height);
    let columns = TriangleTaps::new(width, target_width);
    let mut row = vec![0_u16; row_len];
    for out_y in 0..target_height as usize {
        let (top, weights) = rows.get(out_y);
        let band = &src[top * row_len..(top + weights.len()) * row_len];
        vertical_pass(band, row_len, weights, &mut row);
        let start = out.len();
        out.resize(start + out_row_len, 0);
        horizontal_pass(&row, &columns, &mut out[start..]);
    }
    Some(())
}

/// One axis's integer triangle weights, built once per frame. Every output
/// index `i` has `count` weights, for the source indices from `first[i]` on:
/// `count` is the axis's widest kernel, and narrower kernels are zero-padded.
struct TriangleTaps {
    count: usize,
    first: Vec<usize>,
    weights: Vec<u16>,
}

impl TriangleTaps {
    /// Mirrors image 0.25.10's `vertical_sample` / `horizontal_sample` weights
    /// for `FilterType::Triangle` (support 1.0) in the same f32 steps: the
    /// support widens by the downscale ratio, output `i` centres on source
    /// position `(i + 0.5) * ratio`, taps past either edge are dropped and the
    /// rest renormalised.
    fn new(source_len: u32, target_len: u32) -> Self {
        let ratio = source_len as f32 / target_len as f32;
        let sratio = if ratio < 1.0 { 1.0 } else { ratio };
        // The triangle's support of 1.0, widened by the downscale ratio.
        let support = sratio;
        let source_end = i64::from(source_len);
        let windows: Vec<(i64, i64, f32)> = (0..target_len)
            .map(|index| {
                let centre = (index as f32 + 0.5) * ratio;
                let left = ((centre - support).floor() as i64).clamp(0, source_end - 1);
                let right = ((centre + support).ceil() as i64).clamp(left + 1, source_end);
                (left, right, centre - 0.5)
            })
            .collect();
        // Every window lies inside the source, so `count` taps always fit.
        let count = windows
            .iter()
            .map(|&(left, right, _)| right - left)
            .max()
            .unwrap_or(0);
        let mut taps = Self {
            count: count as usize,
            first: Vec::with_capacity(windows.len()),
            weights: Vec::with_capacity(windows.len() * count as usize),
        };
        let mut kernel = Vec::new();
        let mut remainders = Vec::new();
        for (left, right, centre) in windows {
            kernel.clear();
            kernel.extend((left..right).map(|tap| triangle_kernel((tap as f32 - centre) / sratio)));
            // A narrower kernel near the far edge starts earlier instead, after
            // leading zero weights, so its `count` taps stay inside the source.
            let first = left.min(source_end - count);
            let end = taps.weights.len() + taps.count;
            taps.weights
                .resize(taps.weights.len() + (left - first) as usize, 0);
            push_unit_weights(&kernel, &mut taps.weights, &mut remainders);
            debug_assert!(taps.weights.len() <= end);
            taps.weights.resize(end, 0);
            taps.first.push(first as usize);
        }
        taps
    }

    fn get(&self, index: usize) -> (usize, &[u16]) {
        let weights = &self.weights[index * self.count..(index + 1) * self.count];
        (self.first[index], weights)
    }
}

/// image 0.25.10's `triangle_kernel`.
fn triangle_kernel(x: f32) -> f32 {
    if x.abs() < 1.0 { 1.0 - x.abs() } else { 0.0 }
}

/// Quantises one output pixel's kernel to integer weights summing to exactly
/// `1 << WEIGHT_BITS` (largest-remainder rounding): each weight takes its floor
/// and the units left over go to the largest remainders, so no weight goes
/// negative or strays a whole unit, at any ratio.
fn push_unit_weights(kernel: &[f32], weights: &mut Vec<u16>, remainders: &mut Vec<(f64, usize)>) {
    let unit = f64::from(1_u32 << WEIGHT_BITS);
    let sum: f64 = kernel.iter().map(|&weight| f64::from(weight)).sum();
    let base = weights.len();
    let mut assigned = 0_u32;
    remainders.clear();
    for (tap, &weight) in kernel.iter().enumerate() {
        let exact = f64::from(weight) / sum * unit;
        let floor = exact.floor();
        weights.push(floor as u16);
        assigned += floor as u32;
        remainders.push((exact - floor, tap));
    }
    let left_over = (1_u32 << WEIGHT_BITS).saturating_sub(assigned) as usize;
    remainders.sort_unstable_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
    for &(_, tap) in remainders.iter().take(left_over) {
        weights[base + tap] += 1;
    }
    debug_assert_eq!(
        weights[base..]
            .iter()
            .map(|&weight| u32::from(weight))
            .sum::<u32>(),
        1 << WEIGHT_BITS
    );
}

/// The vertical pass for one output row: each channel of `row` becomes the
/// weighted sum of the `band` rows (one per weight), with `ROW_FRACTION_BITS`
/// fraction bits.
fn vertical_pass(band: &[u8], row_len: usize, weights: &[u16], row: &mut [u16]) {
    // Fixed-width blocks keep the sums in registers so the compiler vectorises
    // them; a BGRA row's tail past the last full block is whole pixels.
    let body = row.len() - row.len() % 32;
    let (head, tail) = row.split_at_mut(body);
    vertical_blocks::<32>(band, row_len, weights, head, 0);
    vertical_blocks::<4>(band, row_len, weights, tail, body);
}

fn vertical_blocks<const LANES: usize>(
    band: &[u8],
    row_len: usize,
    weights: &[u16],
    row: &mut [u16],
    offset: usize,
) {
    for (block, lanes) in row.chunks_exact_mut(LANES).enumerate() {
        let x = offset + block * LANES;
        let mut sums = [0_u32; LANES];
        for (tap, &weight) in weights.iter().enumerate() {
            if weight == 0 {
                // Padding (or a kernel's zero end): no row to read.
                continue;
            }
            let start = tap * row_len + x;
            let weight = u32::from(weight);
            for (sum, &value) in sums.iter_mut().zip(&band[start..start + LANES]) {
                *sum += u32::from(value) * weight;
            }
        }
        for (lane, sum) in lanes.iter_mut().zip(sums) {
            *lane = ((sum + (1 << (ROW_SHIFT - 1))) >> ROW_SHIFT) as u16;
        }
    }
}

/// The horizontal pass for one output row: weighs the vertical pass's row into
/// BGRA bytes, rounding to output levels once and clamping to 255.
fn horizontal_pass(row: &[u16], columns: &TriangleTaps, out_row: &mut [u8]) {
    // Each arm inlines `horizontal_taps` with a constant tap count, which the
    // compiler unrolls and vectorises per pixel, well ahead of a loop over the
    // taps in plan 191's benchmark. Preview downscales (3840 -> 640 at the
    // most) need 3 to 13 taps; any other count takes the general loop.
    match columns.count {
        3 => horizontal_taps(row, columns, out_row, 3),
        4 => horizontal_taps(row, columns, out_row, 4),
        5 => horizontal_taps(row, columns, out_row, 5),
        6 => horizontal_taps(row, columns, out_row, 6),
        7 => horizontal_taps(row, columns, out_row, 7),
        8 => horizontal_taps(row, columns, out_row, 8),
        9 => horizontal_taps(row, columns, out_row, 9),
        10 => horizontal_taps(row, columns, out_row, 10),
        11 => horizontal_taps(row, columns, out_row, 11),
        12 => horizontal_taps(row, columns, out_row, 12),
        13 => horizontal_taps(row, columns, out_row, 13),
        count => horizontal_taps(row, columns, out_row, count),
    }
}

#[inline(always)]
fn horizontal_taps(row: &[u16], columns: &TriangleTaps, out_row: &mut [u8], taps: usize) {
    for ((pixel, &first), weights) in out_row
        .chunks_exact_mut(4)
        .zip(&columns.first)
        .zip(columns.weights.chunks_exact(taps))
    {
        let window = &row[first * 4..(first + taps) * 4];
        let mut sums = [1_u32 << (OUTPUT_SHIFT - 1); 4];
        for (source, &weight) in window.chunks_exact(4).zip(weights) {
            let weight = u32::from(weight);
            for (sum, &value) in sums.iter_mut().zip(source) {
                *sum += u32::from(value) * weight;
            }
        }
        for (channel, sum) in pixel.iter_mut().zip(sums) {
            *channel = (sum >> OUTPUT_SHIFT).min(255) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_top_down_bgra_with_explicit_dimensions_and_stride() {
        let LatestPreviewBmpPoll::Frame(frame) = encode_latest_bgra_bmp(
            None,
            "camera-run-a".to_string(),
            42,
            2,
            1,
            &[1, 2, 3, 255, 4, 5, 6, 255],
            2,
        )
        .unwrap() else {
            panic!("expected a frame");
        };

        assert_eq!(frame.generation, "camera-run-a");
        assert_eq!(frame.sequence, 42);
        assert_eq!((frame.width, frame.height, frame.stride), (2, 1, 8));
        assert_eq!(frame.pixel_format, "bgra8");
        assert_eq!(&frame.bytes[..2], b"BM");
        assert_eq!(
            i32::from_le_bytes(frame.bytes[18..22].try_into().unwrap()),
            2
        );
        assert_eq!(
            i32::from_le_bytes(frame.bytes[22..26].try_into().unwrap()),
            -1
        );
        assert_eq!(&frame.bytes[54..], &[1, 2, 3, 255, 4, 5, 6, 255]);
    }

    #[test]
    fn downscales_to_the_bounded_preview_width() {
        let LatestPreviewBmpPoll::Frame(frame) =
            encode_latest_bgra_bmp(None, "screen-run-a".to_string(), 9, 4, 2, &[255; 32], 2)
                .unwrap()
        else {
            panic!("expected a frame");
        };
        assert_eq!((frame.width, frame.height, frame.stride), (2, 1, 8));
        assert_eq!(frame.bytes.len(), 54 + 8);
    }

    #[test]
    fn no_resize_path_borrows_the_retained_frame_bytes() {
        let pixels = [1, 2, 3, 255, 4, 5, 6, 255];
        let (bounded, width, height) = bounded_bgra_pixels(&pixels, 2, 1, 2).unwrap();

        let Cow::Borrowed(bounded) = bounded else {
            panic!("no-resize BMP transport must not clone the raw frame");
        };
        assert_eq!((width, height), (2, 1));
        assert!(std::ptr::eq(bounded.as_ptr(), pixels.as_ptr()));
    }

    #[test]
    fn rejects_truncated_capture_bytes() {
        assert!(
            encode_latest_bgra_bmp(None, "screen-run-a".to_string(), 1, 2, 2, &[0; 15], 2,)
                .is_none()
        );
    }

    #[test]
    fn matching_generation_suppresses_duplicates_before_validating_or_copying_pixels() {
        let cursor = PreviewBmpCursor {
            generation: "screen-run-a".to_string(),
            sequence: 12,
        };

        assert_eq!(
            encode_latest_bgra_bmp(
                Some(&cursor),
                "screen-run-a".to_string(),
                12,
                3840,
                2160,
                &[],
                1920,
            ),
            Some(LatestPreviewBmpPoll::Unchanged {
                generation: "screen-run-a".to_string(),
                sequence: 12,
            })
        );
    }

    #[test]
    fn a_new_generation_publishes_after_its_sequence_restarts() {
        let cursor = PreviewBmpCursor {
            generation: "screen-run-a".to_string(),
            sequence: 500,
        };
        let LatestPreviewBmpPoll::Frame(frame) = encode_latest_bgra_bmp(
            Some(&cursor),
            "screen-run-b".to_string(),
            1,
            1,
            1,
            &[1, 2, 3, 255],
            1,
        )
        .unwrap() else {
            panic!("new source generation must publish its first frame");
        };

        assert_eq!(frame.generation, "screen-run-b");
        assert_eq!(frame.sequence, 1);
    }

    /// A seeded splitmix64 byte stream, so the oracle tests need no RNG crate.
    fn noise_frame(width: u32, height: u32, seed: u64) -> Vec<u8> {
        let len = width as usize * height as usize * 4;
        let mut state = seed;
        let mut bytes = Vec::with_capacity(len + 8);
        while bytes.len() < len {
            state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut mixed = state;
            mixed = (mixed ^ (mixed >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            mixed = (mixed ^ (mixed >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            bytes.extend_from_slice(&(mixed ^ (mixed >> 31)).to_le_bytes());
        }
        bytes.truncate(len);
        bytes
    }

    fn frame_from(width: u32, height: u32, pixel: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(width as usize * height as usize * 4);
        for y in 0..height {
            for x in 0..width {
                bytes.extend_from_slice(&pixel(x, y));
            }
        }
        bytes
    }

    fn ramp(value: u32, len: u32) -> u8 {
        (value * 255 / len.saturating_sub(1).max(1)) as u8
    }

    fn oracle_patterns(width: u32, height: u32) -> Vec<(&'static str, Vec<u8>)> {
        vec![
            ("noise", noise_frame(width, height, 0x191)),
            (
                "gradient",
                frame_from(width, height, |x, y| {
                    [
                        ramp(x, width),
                        ramp(y, height),
                        ramp(x + y, width + height - 1),
                        255 - ramp(x, width),
                    ]
                }),
            ),
            (
                "checkerboard",
                frame_from(width, height, |x, y| {
                    if (x + y) % 2 == 0 {
                        [255; 4]
                    } else {
                        [0, 0, 0, 255]
                    }
                }),
            ),
            (
                "bright pixel",
                frame_from(width, height, |x, y| {
                    if (x, y) == (width / 3, height / 2) {
                        [255; 4]
                    } else {
                        [0; 4]
                    }
                }),
            ),
        ]
    }

    fn legacy_target_height(width: u32, height: u32, max_width: u32) -> u32 {
        ((u64::from(height) * u64::from(max_width)) / u64::from(width)).max(1) as u32
    }

    /// image 0.25.10's own Triangle resize: the pre-plan-191 path and the oracle.
    fn image_triangle(bytes: &[u8], width: u32, height: u32, max_width: u32) -> Vec<u8> {
        let source =
            image::ImageBuffer::<image::Rgba<u8>, &[u8]>::from_raw(width, height, bytes).unwrap();
        let target_height = legacy_target_height(width, height, max_width);
        let resized = image::imageops::resize(
            &source,
            max_width,
            target_height,
            image::imageops::FilterType::Triangle,
        );
        assert_eq!(resized.dimensions(), (max_width, target_height));
        resized.into_raw()
    }

    /// The largest and the mean absolute per-channel difference.
    fn channel_difference(ours: &[u8], oracle: &[u8]) -> (u8, f64) {
        assert_eq!(ours.len(), oracle.len());
        let (max, total) = ours
            .iter()
            .zip(oracle)
            .fold((0_u8, 0_u64), |(max, total), (&a, &b)| {
                (max.max(a.abs_diff(b)), total + u64::from(a.abs_diff(b)))
            });
        (max, total as f64 / ours.len() as f64)
    }

    #[test]
    fn fixed_point_downscale_matches_image_triangle_within_one_level() {
        for (width, height, max_width) in [
            (1920, 1080, 800),
            (1280, 720, 640),
            (1001, 777, 333),
            (1000, 10, 999),
            (640, 480, 1),
            (3840, 2160, 1920),
        ] {
            for (pattern, bytes) in oracle_patterns(width, height) {
                let label = format!("{pattern} {width}x{height} -> {max_width}");
                let (ours, ours_width, ours_height) =
                    bounded_bgra_pixels(&bytes, width, height, max_width).unwrap();
                assert!(matches!(ours, Cow::Owned(_)), "{label}");
                assert_eq!(
                    (ours_width, ours_height),
                    (max_width, legacy_target_height(width, height, max_width)),
                    "{label}"
                );
                let oracle = image_triangle(&bytes, width, height, max_width);
                let (max, mean) = channel_difference(&ours, &oracle);
                eprintln!("{label}: max channel difference {max}, mean {mean:.5}");
                assert!(max <= 1, "{label}: max channel difference {max}");
                assert!(mean < 0.5, "{label}: mean channel difference {mean}");
            }
        }
    }

    /// The pre-plan-191 BMP for one frame: image's resize, then its pixels
    /// copied after the same 54-byte header.
    fn legacy_bmp(bytes: &[u8], width: u32, height: u32, max_width: u32) -> Vec<u8> {
        let pixels = image_triangle(bytes, width, height, max_width);
        let target_height = legacy_target_height(width, height, max_width);
        let pixel_bytes = max_width * 4 * target_height;
        let mut bmp = Vec::new();
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&(54 + pixel_bytes).to_le_bytes());
        bmp.extend_from_slice(&[0; 4]);
        bmp.extend_from_slice(&54_u32.to_le_bytes());
        bmp.extend_from_slice(&40_u32.to_le_bytes());
        bmp.extend_from_slice(&(max_width as i32).to_le_bytes());
        bmp.extend_from_slice(&(-(target_height as i32)).to_le_bytes());
        bmp.extend_from_slice(&1_u16.to_le_bytes());
        bmp.extend_from_slice(&32_u16.to_le_bytes());
        bmp.extend_from_slice(&0_u32.to_le_bytes());
        bmp.extend_from_slice(&pixel_bytes.to_le_bytes());
        bmp.extend_from_slice(&[0; 16]);
        bmp.extend_from_slice(&pixels);
        bmp
    }

    #[test]
    fn resized_bmp_parses_like_the_legacy_encoder() {
        for (width, height, max_width) in [(1920, 1080, 800), (1001, 777, 333), (640, 480, 1)] {
            let bytes = noise_frame(width, height, 7);
            let LatestPreviewBmpPoll::Frame(frame) = encode_latest_bgra_bmp(
                None,
                "screen-run-a".to_string(),
                3,
                width,
                height,
                &bytes,
                max_width,
            )
            .unwrap() else {
                panic!("expected a frame");
            };
            let legacy = legacy_bmp(&bytes, width, height, max_width);
            let u32_at =
                |at: usize| u32::from_le_bytes(frame.bytes[at..at + 4].try_into().unwrap());
            let i32_at =
                |at: usize| i32::from_le_bytes(frame.bytes[at..at + 4].try_into().unwrap());

            assert_eq!(frame.bytes.len(), legacy.len());
            assert_eq!(&frame.bytes[..54], &legacy[..54]);
            assert_eq!(&frame.bytes[..2], b"BM");
            assert_eq!(u32_at(2) as usize, frame.bytes.len());
            assert_eq!(u32_at(10), 54);
            assert_eq!(u32_at(14), 40);
            assert_eq!(i32_at(18), max_width as i32);
            assert_eq!(
                i32_at(22),
                -(legacy_target_height(width, height, max_width) as i32)
            );
            assert_eq!(u32_at(34), frame.stride * frame.height);
            assert_eq!(
                (frame.width, frame.height, frame.stride),
                (
                    max_width,
                    legacy_target_height(width, height, max_width),
                    max_width * 4
                )
            );
            let (max, _) = channel_difference(&frame.bytes[54..], &legacy[54..]);
            assert!(max <= 1, "{width}x{height} -> {max_width}: max {max}");
        }
    }

    #[test]
    fn a_flat_frame_downscales_to_exactly_its_colour() {
        let bytes = frame_from(1001, 777, |_, _| [10, 200, 37, 255]);
        let (pixels, width, height) = bounded_bgra_pixels(&bytes, 1001, 777, 333).unwrap();
        assert_eq!((width, height), (333, 258));
        assert!(
            pixels
                .chunks_exact(4)
                .all(|pixel| pixel == [10, 200, 37, 255])
        );
    }

    #[test]
    fn the_resize_path_refuses_and_fills_the_frames_image_did() {
        // ImageBuffer::from_raw refused source bytes shorter than the frame.
        assert!(bounded_bgra_pixels(&[0; 15], 4, 1, 2).is_none());
        // image's resize answered an empty source with a zeroed frame.
        let (pixels, width, height) = bounded_bgra_pixels(&[], 4, 0, 2).unwrap();
        assert_eq!((width, height), (2, 1));
        assert_eq!(&pixels[..], image_triangle(&[], 4, 0, 2).as_slice());
    }
}
