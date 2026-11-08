//! The black-picture sample (plan 223 A7, D10): the mean luma of a 64×36
//! grid over a program frame, once a second. Pure arithmetic on a frame the
//! pipeline already holds in memory; no readback of its own, no second
//! decode.

/// The grid the plan names (D9, D10): 64 columns by 36 rows.
pub const GRID_COLUMNS: u32 = 64;
pub const GRID_ROWS: u32 = 36;

/// Mean luma (0..=255) of a BGRA or RGBA frame over the grid. `stride` is
/// the row pitch in bytes. Luma is BT.601's Y of the full-range RGB, which
/// is what "16/255 is video black" measures. Returns None for an empty or
/// too-short buffer.
pub fn mean_luma_rgba(
    pixels: &[u8],
    width: u32,
    height: u32,
    stride: usize,
    bgra: bool,
) -> Option<u8> {
    if width == 0 || height == 0 || stride < width as usize * 4 {
        return None;
    }
    let needed = stride * (height as usize - 1) + width as usize * 4;
    if pixels.len() < needed {
        return None;
    }
    let mut total: u64 = 0;
    let mut count: u64 = 0;
    for row in 0..GRID_ROWS {
        let y = (u64::from(row) * 2 + 1) * u64::from(height) / (u64::from(GRID_ROWS) * 2);
        let base = y as usize * stride;
        for column in 0..GRID_COLUMNS {
            let x = (u64::from(column) * 2 + 1) * u64::from(width) / (u64::from(GRID_COLUMNS) * 2);
            let at = base + x as usize * 4;
            let (r, g, b) = if bgra {
                (pixels[at + 2], pixels[at + 1], pixels[at])
            } else {
                (pixels[at], pixels[at + 1], pixels[at + 2])
            };
            // BT.601: Y = 0.299 R + 0.587 G + 0.114 B, in fixed point.
            total += (299 * u64::from(r) + 587 * u64::from(g) + 114 * u64::from(b)) / 1000;
            count += 1;
        }
    }
    (count > 0).then(|| (total / count).min(255) as u8)
}

/// Mean luma over the grid of a planar Y (NV12, I420) plane, which the
/// encoder path holds on every platform: 2,304 byte reads, no arithmetic.
pub fn mean_luma_y_plane(plane: &[u8], width: u32, height: u32, stride: usize) -> Option<u8> {
    if width == 0 || height == 0 || stride < width as usize {
        return None;
    }
    let needed = stride * (height as usize - 1) + width as usize;
    if plane.len() < needed {
        return None;
    }
    let mut total: u64 = 0;
    let mut count: u64 = 0;
    for row in 0..GRID_ROWS {
        let y = (u64::from(row) * 2 + 1) * u64::from(height) / (u64::from(GRID_ROWS) * 2);
        let base = y as usize * stride;
        for column in 0..GRID_COLUMNS {
            let x = (u64::from(column) * 2 + 1) * u64::from(width) / (u64::from(GRID_COLUMNS) * 2);
            total += u64::from(plane[base + x as usize]);
            count += 1;
        }
    }
    (count > 0).then(|| (total / count).min(255) as u8)
}

/// The mean luma of a takeover's PNG, read once at activation (the dark
/// takeover guard). A file that does not decode reads as None: the guard
/// then never suppresses.
pub fn mean_luma_png(path: &std::path::Path) -> Option<u8> {
    let image = image::open(path).ok()?.into_rgba8();
    let (width, height) = image.dimensions();
    mean_luma_rgba(image.as_raw(), width, height, width as usize * 4, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgba(width: u32, height: u32, fill: [u8; 4]) -> Vec<u8> {
        let mut out = Vec::with_capacity((width * height * 4) as usize);
        for _ in 0..width * height {
            out.extend_from_slice(&fill);
        }
        out
    }

    #[test]
    fn black_grey_and_white_frames_read_as_their_luma() {
        let black = rgba(1920, 1080, [0, 0, 0, 255]);
        assert_eq!(mean_luma_rgba(&black, 1920, 1080, 1920 * 4, true), Some(0));
        let grey = rgba(64, 36, [128, 128, 128, 255]);
        assert_eq!(mean_luma_rgba(&grey, 64, 36, 64 * 4, false), Some(128));
        let white = rgba(100, 50, [255, 255, 255, 255]);
        assert_eq!(mean_luma_rgba(&white, 100, 50, 100 * 4, true), Some(255));
        // The hold card's base (27) is not black (16).
        let hold = rgba(16, 9, [27, 27, 27, 255]);
        assert_eq!(mean_luma_rgba(&hold, 16, 9, 16 * 4, true), Some(27));
        // A frame that is black with one bright caption line still averages dark.
        let mut captioned = rgba(1920, 1080, [0, 0, 0, 255]);
        for y in 1000..1040 {
            for x in 0..1920 {
                let at = (y * 1920 + x) * 4;
                captioned[at..at + 3].copy_from_slice(&[255, 255, 255]);
            }
        }
        assert!(mean_luma_rgba(&captioned, 1920, 1080, 1920 * 4, true).unwrap() < BLACK_PLUS);
        const BLACK_PLUS: u8 = 16;
    }

    #[test]
    fn a_y_plane_reads_the_same_and_short_buffers_read_none() {
        let plane = vec![10u8; 1920 * 1080];
        assert_eq!(mean_luma_y_plane(&plane, 1920, 1080, 1920), Some(10));
        let strided = vec![200u8; 2048 * 1080];
        assert_eq!(mean_luma_y_plane(&strided, 1920, 1080, 2048), Some(200));
        assert_eq!(mean_luma_y_plane(&plane[..100], 1920, 1080, 1920), None);
        assert_eq!(mean_luma_rgba(&[], 0, 0, 0, true), None);
    }

    #[test]
    fn bgra_and_rgba_orders_both_read_red_as_dark_and_green_as_bright() {
        let red_bgra = rgba(8, 8, [0, 0, 255, 255]);
        let red_rgba = rgba(8, 8, [255, 0, 0, 255]);
        assert_eq!(
            mean_luma_rgba(&red_bgra, 8, 8, 32, true),
            mean_luma_rgba(&red_rgba, 8, 8, 32, false)
        );
        assert_eq!(mean_luma_rgba(&red_rgba, 8, 8, 32, false), Some(76));
        let green = rgba(8, 8, [0, 255, 0, 255]);
        assert_eq!(mean_luma_rgba(&green, 8, 8, 32, false), Some(149));
    }

    /// D10's measurement on this machine: the cost of one sample on a
    /// 1080p frame, printed by `cargo test --release ... -- --nocapture`.
    #[test]
    fn one_sample_on_a_1080p_frame_is_far_under_a_frame_budget() {
        let frame = rgba(1920, 1080, [40, 60, 80, 255]);
        let plane = vec![40u8; 1920 * 1080];
        let runs = 200;
        let mut rgba_times = Vec::with_capacity(runs);
        let mut plane_times = Vec::with_capacity(runs);
        for _ in 0..runs {
            let start = std::time::Instant::now();
            std::hint::black_box(mean_luma_rgba(&frame, 1920, 1080, 1920 * 4, true));
            rgba_times.push(start.elapsed());
            let start = std::time::Instant::now();
            std::hint::black_box(mean_luma_y_plane(&plane, 1920, 1080, 1920));
            plane_times.push(start.elapsed());
        }
        rgba_times.sort();
        plane_times.sort();
        let p95 = |times: &[std::time::Duration]| times[times.len() * 95 / 100];
        println!(
            "watchdog luma sample 1080p: rgba p50 {:?} p95 {:?}; y-plane p50 {:?} p95 {:?}",
            rgba_times[runs / 2],
            p95(&rgba_times),
            plane_times[runs / 2],
            p95(&plane_times)
        );
        // A debug build is many times slower than release; the shipping
        // bound (D10: 0.3 ms p95) is checked by the release run in the PR.
        assert!(p95(&rgba_times) < std::time::Duration::from_millis(30));
    }
}
