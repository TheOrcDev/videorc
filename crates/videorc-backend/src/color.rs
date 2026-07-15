/// Full-range BT.601 RGB to YUV conversion. This is the chroma-key FEATURE
/// space only (`scene_geometry` derives key directions from it, and the
/// CPU/Metal/ffmpeg keyers share those constants) — recorded output no longer
/// uses it. Changing it desynchronizes the three keyer paths.
#[allow(dead_code)] // used by scene_geometry in the main bin, not the helper bin
pub fn rgb_to_yuv_full_range_bt601(r: u8, g: u8, b: u8) -> (u8, u8, u8) {
    let r = i32::from(r);
    let g = i32::from(g);
    let b = i32::from(b);
    let y = ((77 * r + 150 * g + 29 * b) >> 8).clamp(0, 255) as u8;
    let u = (128 + ((-43 * r - 85 * g + 128 * b) >> 8)).clamp(0, 255) as u8;
    let v = (128 + ((128 * r - 107 * g - 21 * b) >> 8)).clamp(0, 255) as u8;
    (y, u, v)
}

/// Video-("limited"-)range BT.709 RGB to Y'CbCr — the recording colorimetry law:
/// every produced artifact is BT.709 video-range and is tagged as such (VT
/// session color properties on the hardware path, `-colorspace/-color_range`
/// flags on the ffmpeg legs). Used by the CPU compositor blit and the Metal
/// readback bridge; keep both paths on this one function. Coefficients are the
/// standard BT.709 studio-swing matrix scaled by 65536, tuned so neutral grey
/// maps to exactly (128, 128) chroma.
pub fn rgb_to_yuv_video_range_bt709(r: u8, g: u8, b: u8) -> (u8, u8, u8) {
    let r = i32::from(r);
    let g = i32::from(g);
    let b = i32::from(b);
    let y = (16 + ((11968 * r + 40258 * g + 4064 * b + 32768) >> 16)).clamp(0, 255) as u8;
    let u = (128 + ((-6596 * r - 22189 * g + 28785 * b + 32768) >> 16)).clamp(0, 255) as u8;
    let v = (128 + ((28785 * r - 26147 * g - 2638 * b + 32768) >> 16)).clamp(0, 255) as u8;
    (y, u, v)
}

/// BT.709 limited-("video"-)range Y'CbCr to BGR. Capture devices (e.g. an Elgato
/// Cam Link 4K) deliver HD/4K frames as BT.709 video-range Y'CbCr (NV12 `420v`,
/// UYVY `2vuy`); this maps a sample back to 8-bit BGR for the BGRA compositor
/// pipeline. Coefficients are the standard BT.709 limited-range matrix scaled by 256.
#[allow(dead_code)] // used by the macOS camera path in the main bin, not the helper bin
#[inline]
pub fn ycbcr_bt709_video_to_bgr(y: u8, cb: u8, cr: u8) -> (u8, u8, u8) {
    let c = i32::from(y) - 16;
    let d = i32::from(cb) - 128;
    let e = i32::from(cr) - 128;
    let r = ((298 * c + 459 * e + 128) >> 8).clamp(0, 255) as u8;
    let g = ((298 * c - 55 * d - 136 * e + 128) >> 8).clamp(0, 255) as u8;
    let b = ((298 * c + 541 * d + 128) >> 8).clamp(0, 255) as u8;
    (b, g, r)
}

/// BT.709 full-range Y'CbCr to BGR, for full-range NV12 (`420f`).
#[allow(dead_code)] // used by the macOS camera path in the main bin, not the helper bin
#[inline]
pub fn ycbcr_bt709_full_to_bgr(y: u8, cb: u8, cr: u8) -> (u8, u8, u8) {
    let c = i32::from(y);
    let d = i32::from(cb) - 128;
    let e = i32::from(cr) - 128;
    let r = ((256 * c + 403 * e + 128) >> 8).clamp(0, 255) as u8;
    let g = ((256 * c - 48 * d - 120 * e + 128) >> 8).clamp(0, 255) as u8;
    let b = ((256 * c + 475 * d + 128) >> 8).clamp(0, 255) as u8;
    (b, g, r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ycbcr_bt709_video_maps_black_and_white() {
        // Video-range luma endpoints with neutral chroma -> pure black / white.
        assert_eq!(ycbcr_bt709_video_to_bgr(16, 128, 128), (0, 0, 0));
        assert_eq!(ycbcr_bt709_video_to_bgr(235, 128, 128), (255, 255, 255));
    }

    #[test]
    fn ycbcr_bt709_video_maps_primaries() {
        // BT.709 video-range encodings of pure R/G/B decode back to those primaries
        // (within rounding). Order is (B, G, R).
        let (b, g, r) = ycbcr_bt709_video_to_bgr(63, 102, 240); // red
        assert!(r >= 250 && g <= 4 && b <= 4, "red -> {b},{g},{r}");
        let (b, _g, r) = ycbcr_bt709_video_to_bgr(173, 42, 26); // green
        assert!(r <= 6 && b <= 6, "green -> {b},{r}");
        let (b, g, r) = ycbcr_bt709_video_to_bgr(32, 240, 118); // blue
        assert!(b >= 250 && g <= 6 && r <= 6, "blue -> {b},{g},{r}");
    }

    #[test]
    fn ycbcr_bt709_full_maps_black_and_white() {
        assert_eq!(ycbcr_bt709_full_to_bgr(0, 128, 128), (0, 0, 0));
        assert_eq!(ycbcr_bt709_full_to_bgr(255, 128, 128), (255, 255, 255));
    }

    #[test]
    fn rgb_to_yuv_full_range_bt601_matches_existing_primary_references() {
        assert_eq!(rgb_to_yuv_full_range_bt601(255, 0, 0), (76, 85, 255));
        assert_eq!(rgb_to_yuv_full_range_bt601(0, 255, 0), (149, 43, 21));
        assert_eq!(rgb_to_yuv_full_range_bt601(0, 0, 255), (28, 255, 107));
    }

    #[test]
    fn rgb_to_yuv_full_range_bt601_maps_black_and_white_to_full_range_luma() {
        assert_eq!(rgb_to_yuv_full_range_bt601(0, 0, 0), (0, 128, 128));
        assert_eq!(rgb_to_yuv_full_range_bt601(255, 255, 255), (255, 128, 128));
    }

    #[test]
    fn rgb_to_yuv_video_range_bt709_maps_black_white_and_grey_to_studio_swing() {
        assert_eq!(rgb_to_yuv_video_range_bt709(0, 0, 0), (16, 128, 128));
        assert_eq!(rgb_to_yuv_video_range_bt709(255, 255, 255), (235, 128, 128));
        // Neutral grey must land on EXACTLY neutral chroma — a bias here tints
        // every recording.
        assert_eq!(rgb_to_yuv_video_range_bt709(128, 128, 128).1, 128);
        assert_eq!(rgb_to_yuv_video_range_bt709(128, 128, 128).2, 128);
    }

    #[test]
    fn rgb_to_yuv_video_range_bt709_round_trips_the_decode_primaries() {
        // Exact inverse companions of the ycbcr_bt709_video_to_bgr fixtures
        // above: encode(primary) == the decode test's input sample.
        assert_eq!(rgb_to_yuv_video_range_bt709(255, 0, 0), (63, 102, 240));
        assert_eq!(rgb_to_yuv_video_range_bt709(0, 255, 0), (173, 42, 26));
        assert_eq!(rgb_to_yuv_video_range_bt709(0, 0, 255), (32, 240, 118));
    }
}
