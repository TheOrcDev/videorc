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
    /// Plan 257 S3: when the capture produced the frame, so the response can
    /// say how old it is (`x-videorc-frame-age-ms`) and the Preview can
    /// measure capture-to-screen latency. Set by the source's route.
    pub captured_at: Option<std::time::Instant>,
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

impl LatestPreviewBmpPoll {
    /// The poll with its frame's capture time attached (a 204 has no frame).
    pub fn captured_at(self, captured_at: std::time::Instant) -> Self {
        match self {
            Self::Frame(frame) => Self::Frame(LatestPreviewBmp {
                captured_at: Some(captured_at),
                ..frame
            }),
            unchanged @ Self::Unchanged { .. } => unchanged,
        }
    }
}

/// Plan 257 S3: the longest one latest-frame request may wait for a frame
/// newer than its cursor before it answers 204. A request that names no wait
/// answers at once, as before.
pub const PREVIEW_BMP_MAX_WAIT_MS: u32 = 250;

/// Plan 257 S3: how often a waiting request looks for a newer frame. The
/// look is a sequence compare under the store's lock, so it is cheap; the
/// step bounds the delay a frame can sit in the store unsent.
pub const PREVIEW_BMP_WAIT_STEP: std::time::Duration = std::time::Duration::from_millis(4);

/// Whether the cursor already names this frame (same source run, same or
/// newer sequence): the client has it and there is nothing to send.
pub fn cursor_names_frame(
    cursor: Option<&PreviewBmpCursor>,
    generation: &str,
    sequence: u64,
) -> bool {
    cursor.is_some_and(|cursor| cursor.generation == generation && sequence <= cursor.sequence)
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
    if cursor_names_frame(cursor, &generation, sequence) {
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
        captured_at: None,
    }))
}

/// Plan 257 S3: the pixel format a latest-frame request asks for. `Bmp` is the
/// Windows proof surface's top-down BGRA BMP (the default); `I420` is the
/// Linux Preview's planar BT.709 video-range 4:2:0 (Y, then U, then V), 1.5
/// bytes a pixel against BGRA's 4, which the page hands to a `VideoFrame`
/// for the GPU to convert and scale.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PreviewFrameFormat {
    #[default]
    Bmp,
    I420,
}

impl PreviewFrameFormat {
    pub fn from_query(value: Option<&str>) -> Self {
        match value {
            Some("i420") => Self::I420,
            _ => Self::Bmp,
        }
    }
}

/// Plan 257 S3: the integer factor an I420 frame shrinks by. The page scales
/// on the GPU as it draws, so the backend only takes out whole factors (a box
/// average, cheap) while the frame stays wider than 1.5 times what the page
/// shows: 1280 for a 942-wide Preview is sent as it is, 1920 halves to 960, a
/// 2880 screen thirds to 960. The triangle resize this replaces cost ogre 28 ms
/// a 720p frame, so the source rate could never reach the screen.
pub fn i420_box_factor(width: u32, max_width: u32) -> u32 {
    let max_width = u64::from(max_width.max(1));
    let factor = (2 * u64::from(width)).div_ceil(3 * max_width);
    factor.clamp(1, 64) as u32
}

/// Plan 257 S3: the I420 counterpart of `encode_latest_bgra_bmp`: the same
/// cursor rule, then a box shrink by `i420_box_factor` and a BT.709
/// video-range conversion (the recording colorimetry, `color.rs`). Output
/// dimensions are even (4:2:0 chroma), at least 2x2.
pub fn encode_latest_i420(
    cursor: Option<&PreviewBmpCursor>,
    generation: String,
    sequence: u64,
    width: u32,
    height: u32,
    bytes: &[u8],
    max_width: u32,
) -> Option<LatestPreviewBmpPoll> {
    if cursor_names_frame(cursor, &generation, sequence) {
        return Some(LatestPreviewBmpPoll::Unchanged {
            generation,
            sequence,
        });
    }
    let (width, height) = (width.max(1), height.max(1));
    let row_len = usize::try_from(width).ok()?.checked_mul(4)?;
    let expected_len = row_len.checked_mul(usize::try_from(height).ok()?)?;
    let source = bytes.get(..expected_len)?;
    // Never shrink below 4:2:0's 2x2.
    let factor = i420_box_factor(width, max_width)
        .min((width / 2).max(1))
        .min((height / 2).max(1));
    let out_width = (width / factor) & !1;
    let out_height = (height / factor) & !1;
    if out_width < 2 || out_height < 2 {
        return None;
    }
    let out = bgra_box_to_i420(
        source,
        row_len,
        factor as usize,
        out_width as usize,
        out_height as usize,
    );
    Some(LatestPreviewBmpPoll::Frame(LatestPreviewBmp {
        generation,
        sequence,
        width: out_width,
        height: out_height,
        stride: out_width,
        pixel_format: "i420",
        bytes: out,
        captured_at: None,
    }))
}

/// Box-average `factor` x `factor` source blocks into an `out_width` x
/// `out_height` I420 frame: every luma sample averages its block, every chroma
/// sample averages the 2x2 averaged pixels under it. Factor 1 converts the
/// frame as it is; a larger factor shrinks it first (`box_shrink_bgra`).
fn bgra_box_to_i420(
    source: &[u8],
    row_len: usize,
    factor: usize,
    out_width: usize,
    out_height: usize,
) -> Vec<u8> {
    if factor <= 1 {
        return bgra_to_i420(source, row_len, out_width, out_height);
    }
    if factor == 2 {
        // The common case (a 1080p source in a Studio-sized Preview), fused:
        // 1.6 ms against 7 ms for the two passes below on ogre, same bytes.
        return box2_to_i420(source, row_len, out_width, out_height);
    }
    let shrunk = box_shrink_bgra(source, row_len, factor, out_width, out_height);
    bgra_to_i420(&shrunk, out_width * 4, out_width, out_height)
}

/// Plan 257 S3: whole-factor box shrink of BGRA. Each output row sums its
/// `factor` source rows into a `u32` row (a straight add the compiler
/// vectorises), then each pixel sums `factor` of those, rounded once.
fn box_shrink_bgra(
    source: &[u8],
    row_len: usize,
    factor: usize,
    out_width: usize,
    out_height: usize,
) -> Vec<u8> {
    let used = out_width * factor * 4;
    let area = (factor * factor) as u32;
    let half = area / 2;
    let mut out = vec![0_u8; out_width * out_height * 4];
    let mut sums = vec![0_u32; used];
    for (out_y, out_row) in out.chunks_exact_mut(out_width * 4).enumerate() {
        sums.fill(0);
        for dy in 0..factor {
            let row = &source[(out_y * factor + dy) * row_len..][..used];
            for (sum, &value) in sums.iter_mut().zip(row) {
                *sum += u32::from(value);
            }
        }
        for (pixel, block) in out_row
            .chunks_exact_mut(4)
            .zip(sums.chunks_exact(factor * 4))
        {
            let mut total = [0_u32; 4];
            for source_pixel in block.chunks_exact(4) {
                for (channel, &value) in total.iter_mut().zip(source_pixel) {
                    *channel += value;
                }
            }
            for (out_channel, channel) in pixel.iter_mut().zip(total) {
                *out_channel = ((channel + half) / area) as u8;
            }
        }
    }
    out
}

/// BT.709 video-range luma of one BGRA row (`rgb_to_y_video_range_bt709`
/// without its clamp, which no 8-bit input reaches), in blocks of 16 pixels so
/// the multiply-adds stay in registers: 2.0 against 2.7 ms a 1080p frame on
/// ogre's baseline x86-64 build.
fn bgra_row_to_luma(row: &[u8], luma: &mut [u8]) {
    const BLOCK: usize = 16;
    let luma_of = |pixel: &[u8]| {
        ((11968 * u32::from(pixel[2])
            + 40258 * u32::from(pixel[1])
            + 4064 * u32::from(pixel[0])
            + 32768
            + (16 << 16))
            >> 16) as u8
    };
    let mut luma_blocks = luma.chunks_exact_mut(BLOCK);
    let mut row_blocks = row.chunks_exact(BLOCK * 4);
    for (out, pixels) in (&mut luma_blocks).zip(&mut row_blocks) {
        let mut sums = [0_u32; BLOCK];
        for (sum, pixel) in sums.iter_mut().zip(pixels.chunks_exact(4)) {
            *sum = 11968 * u32::from(pixel[2])
                + 40258 * u32::from(pixel[1])
                + 4064 * u32::from(pixel[0]);
        }
        for (value, sum) in out.iter_mut().zip(sums) {
            *value = ((sum + 32768 + (16 << 16)) >> 16) as u8;
        }
    }
    for (value, pixel) in luma_blocks
        .into_remainder()
        .iter_mut()
        .zip(row_blocks.remainder().chunks_exact(4))
    {
        *value = luma_of(pixel);
    }
}

/// Plan 257 S3: the factor-2 box shrink fused with the conversion. Each output
/// pixel is its 2x2 block's rounded mean (as `box_shrink_bgra` makes it); two
/// such rows at a time give two luma rows and their chroma row.
fn box2_to_i420(source: &[u8], row_len: usize, out_width: usize, out_height: usize) -> Vec<u8> {
    let luma_len = out_width * out_height;
    let chroma_width = out_width / 2;
    let chroma_len = chroma_width * (out_height / 2);
    let mut out = vec![0_u8; luma_len + 2 * chroma_len];
    let (luma, chroma) = out.split_at_mut(luma_len);
    let (u_plane, v_plane) = chroma.split_at_mut(chroma_len);
    let mut rows = [vec![0_u8; out_width * 4], vec![0_u8; out_width * 4]];
    for out_y in 0..out_height {
        let upper = &source[out_y * 2 * row_len..][..out_width * 8];
        let lower = &source[(out_y * 2 + 1) * row_len..][..out_width * 8];
        let row = &mut rows[out_y & 1];
        for ((pixel, top), bottom) in row
            .chunks_exact_mut(4)
            .zip(upper.chunks_exact(8))
            .zip(lower.chunks_exact(8))
        {
            for channel in 0..4 {
                pixel[channel] = ((u16::from(top[channel])
                    + u16::from(top[4 + channel])
                    + u16::from(bottom[channel])
                    + u16::from(bottom[4 + channel])
                    + 2)
                    >> 2) as u8;
            }
        }
        bgra_row_to_luma(row, &mut luma[out_y * out_width..][..out_width]);
        if out_y & 1 == 1 {
            let chroma_y = out_y / 2;
            let u_row = &mut u_plane[chroma_y * chroma_width..][..chroma_width];
            let v_row = &mut v_plane[chroma_y * chroma_width..][..chroma_width];
            for (((top, bottom), u), v) in rows[0]
                .chunks_exact(8)
                .zip(rows[1].chunks_exact(8))
                .zip(u_row.iter_mut())
                .zip(v_row.iter_mut())
            {
                (*u, *v) = chroma_of_block(top, bottom);
            }
        }
    }
    out
}

/// The BT.709 video-range chroma of a 2x2 block (two BGRA pixels from each of
/// two rows): its rounded mean colour through `rgb_to_uv_video_range_bt709`'s
/// formula, which no 8-bit input takes out of 16..=240.
fn chroma_of_block(top: &[u8], bottom: &[u8]) -> (u8, u8) {
    let mean = |channel: usize| {
        (i32::from(top[channel])
            + i32::from(top[4 + channel])
            + i32::from(bottom[channel])
            + i32::from(bottom[4 + channel])
            + 2)
            >> 2
    };
    let (b, g, r) = (mean(0), mean(1), mean(2));
    (
        (128 + ((-6596 * r - 22189 * g + 28785 * b + 32768) >> 16)) as u8,
        (128 + ((28785 * r - 26147 * g - 2638 * b + 32768) >> 16)) as u8,
    )
}

/// Plan 257 S3: BGRA to I420 (BT.709 video range), the integer formulas of
/// `color.rs` (`rgb_to_y_video_range_bt709` / `rgb_to_uv_video_range_bt709`)
/// written as plain row loops the compiler vectorises. They need no clamp: for
/// any 8-bit RGB the luma stays in 16..=235 and the chroma in 16..=240, so the
/// results are exactly `color.rs`'s (`i420_rows_match_color_rs` proves it).
fn bgra_to_i420(source: &[u8], row_len: usize, width: usize, height: usize) -> Vec<u8> {
    let luma_len = width * height;
    let chroma_width = width / 2;
    let chroma_len = chroma_width * (height / 2);
    let mut out = vec![0_u8; luma_len + 2 * chroma_len];
    let (luma, chroma) = out.split_at_mut(luma_len);
    let (u_plane, v_plane) = chroma.split_at_mut(chroma_len);
    for (y, luma_row) in luma.chunks_exact_mut(width).enumerate() {
        bgra_row_to_luma(&source[y * row_len..][..width * 4], luma_row);
    }
    for chroma_y in 0..height / 2 {
        let top = &source[chroma_y * 2 * row_len..][..chroma_width * 8];
        let bottom = &source[(chroma_y * 2 + 1) * row_len..][..chroma_width * 8];
        let u_row = &mut u_plane[chroma_y * chroma_width..][..chroma_width];
        let v_row = &mut v_plane[chroma_y * chroma_width..][..chroma_width];
        for (((top_pair, bottom_pair), u), v) in top
            .chunks_exact(8)
            .zip(bottom.chunks_exact(8))
            .zip(u_row.iter_mut())
            .zip(v_row.iter_mut())
        {
            (*u, *v) = chroma_of_block(top_pair, bottom_pair);
        }
    }
    out
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

    // Plan 257 S3: the Linux Preview's I420 frames.
    #[test]
    fn the_i420_box_factor_only_takes_out_whole_factors_past_one_and_a_half() {
        assert_eq!(i420_box_factor(1280, 942), 1);
        assert_eq!(i420_box_factor(1920, 942), 2);
        assert_eq!(i420_box_factor(2880, 942), 3);
        assert_eq!(i420_box_factor(1920, 1300), 1);
        assert_eq!(i420_box_factor(3840, 640), 4);
        // A zero width asks for the largest factor, which is capped.
        assert_eq!(i420_box_factor(640, 0), 64);
    }

    #[test]
    fn an_i420_frame_is_planar_bt709_video_range_with_even_dimensions() {
        let (width, height) = (1921_u32, 1081_u32);
        let white = vec![255_u8; (width * height * 4) as usize];
        let Some(LatestPreviewBmpPoll::Frame(frame)) =
            encode_latest_i420(None, "run".to_string(), 1, width, height, &white, 942)
        else {
            panic!("frame expected");
        };
        // 1921 / 2 = 960, 1081 / 2 = 540, both already even.
        assert_eq!((frame.width, frame.height, frame.stride), (960, 540, 960));
        assert_eq!(frame.pixel_format, "i420");
        let luma = (960 * 540) as usize;
        assert_eq!(frame.bytes.len(), luma + 2 * luma / 4);
        assert!(frame.bytes[..luma].iter().all(|&y| y == 235));
        assert!(frame.bytes[luma..].iter().all(|&c| c == 128));

        let black = vec![0_u8; 64 * 36 * 4];
        let Some(LatestPreviewBmpPoll::Frame(frame)) =
            encode_latest_i420(None, "run".to_string(), 1, 64, 36, &black, 64)
        else {
            panic!("frame expected");
        };
        assert_eq!((frame.width, frame.height), (64, 36));
        assert!(frame.bytes[..64 * 36].iter().all(|&y| y == 16));
    }

    #[test]
    fn an_i420_frame_averages_its_box_and_keeps_the_cursor_rule() {
        // 8x4, columns alternating black and white, asked for 2 wide: the
        // factor caps at 2 (height 4 / 2), so every 2x2 box is half white.
        let mut source = vec![0_u8; 8 * 4 * 4];
        for (index, pixel) in source.chunks_exact_mut(4).enumerate() {
            let level = if index % 2 == 0 { 0 } else { 255 };
            pixel.copy_from_slice(&[level, level, level, 255]);
        }
        let Some(LatestPreviewBmpPoll::Frame(frame)) =
            encode_latest_i420(None, "run".to_string(), 3, 8, 4, &source, 2)
        else {
            panic!("frame expected");
        };
        assert_eq!((frame.width, frame.height), (4, 2));
        let grey = crate::color::rgb_to_y_video_range_bt709(128, 128, 128);
        assert!(
            frame.bytes[..8].iter().all(|&y| y == grey),
            "{:?}",
            &frame.bytes[..8]
        );
        assert!(frame.bytes[8..].iter().all(|&c| c == 128));

        let cursor = PreviewBmpCursor {
            generation: "run".to_string(),
            sequence: 3,
        };
        assert_eq!(
            encode_latest_i420(Some(&cursor), "run".to_string(), 3, 8, 4, &source, 2),
            Some(LatestPreviewBmpPoll::Unchanged {
                generation: "run".to_string(),
                sequence: 3
            })
        );
        assert_eq!(
            encode_latest_i420(None, "run".to_string(), 3, 8, 4, &source[..8], 2),
            None
        );
        assert_eq!(
            encode_latest_i420(None, "run".to_string(), 3, 1, 1, &source[..4], 2),
            None
        );
    }

    #[test]
    fn the_fused_factor_two_path_matches_the_two_passes() {
        let (width, height) = (36_usize, 20_usize);
        let source: Vec<u8> = (0..width * height * 4)
            .map(|index| (index.wrapping_mul(2_654_435_761) >> 7) as u8)
            .collect();
        let shrunk = box_shrink_bgra(&source, width * 4, 2, width / 2, height / 2);
        assert_eq!(
            box2_to_i420(&source, width * 4, width / 2, height / 2),
            bgra_to_i420(&shrunk, width * 2, width / 2, height / 2)
        );
    }

    #[test]
    fn i420_rows_match_color_rs() {
        // Every 8-bit level on each channel, in 2x2 blocks with mixed partners.
        let (width, height) = (256_usize, 4_usize);
        let mut source = vec![0_u8; width * height * 4];
        for (index, pixel) in source.chunks_exact_mut(4).enumerate() {
            let x = (index % width) as u8;
            let y = (index / width) as u8;
            pixel.copy_from_slice(&[x, x.wrapping_mul(7).wrapping_add(y), 255 - x, 255]);
        }
        let out = bgra_to_i420(&source, width * 4, width, height);
        for (index, pixel) in source.chunks_exact(4).enumerate() {
            assert_eq!(
                out[index],
                crate::color::rgb_to_y_video_range_bt709(pixel[2], pixel[1], pixel[0]),
                "luma {index}"
            );
        }
        let chroma_width = width / 2;
        let chroma_len = chroma_width * height / 2;
        for chroma_y in 0..height / 2 {
            for chroma_x in 0..chroma_width {
                let at = |dx: usize, dy: usize, channel: usize| {
                    u32::from(
                        source[((chroma_y * 2 + dy) * width + chroma_x * 2 + dx) * 4 + channel],
                    )
                };
                let mean = |channel: usize| {
                    ((at(0, 0, channel)
                        + at(1, 0, channel)
                        + at(0, 1, channel)
                        + at(1, 1, channel)
                        + 2)
                        / 4) as u8
                };
                let (u, v) = crate::color::rgb_to_uv_video_range_bt709(mean(2), mean(1), mean(0));
                let index = chroma_y * chroma_width + chroma_x;
                assert_eq!(out[width * height + index], u, "u {index}");
                assert_eq!(out[width * height + chroma_len + index], v, "v {index}");
            }
        }
    }

    // Plan 257 S3: the cursor check a waiting request repeats every few ms.
    #[test]
    fn the_cursor_names_a_frame_only_in_its_own_run() {
        let cursor = PreviewBmpCursor {
            generation: "run-a".to_string(),
            sequence: 5,
        };
        assert!(cursor_names_frame(Some(&cursor), "run-a", 5));
        assert!(cursor_names_frame(Some(&cursor), "run-a", 4));
        assert!(!cursor_names_frame(Some(&cursor), "run-a", 6));
        assert!(!cursor_names_frame(Some(&cursor), "run-b", 1));
        assert!(!cursor_names_frame(None, "run-a", 1));
    }

    #[test]
    fn a_frame_carries_its_capture_time_and_a_204_does_not() {
        let captured_at = std::time::Instant::now();
        let Some(poll) = encode_latest_bgra_bmp(None, "run".to_string(), 1, 1, 1, &[1; 4], 1)
        else {
            panic!("frame expected");
        };
        match poll.captured_at(captured_at) {
            LatestPreviewBmpPoll::Frame(frame) => assert_eq!(frame.captured_at, Some(captured_at)),
            LatestPreviewBmpPoll::Unchanged { .. } => panic!("frame expected"),
        }
        let unchanged = LatestPreviewBmpPoll::Unchanged {
            generation: "run".to_string(),
            sequence: 1,
        };
        assert_eq!(unchanged.clone().captured_at(captured_at), unchanged);
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
