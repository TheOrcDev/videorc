/// H.264 High-profile level selection from output dimensions and frame rate.
///
/// Every recording leg (VideoToolbox session, ffmpeg `h264_videotoolbox`,
/// libx264) must write a SPEC-VALID level: the encoders' auto-selection picked
/// levels below the stream's real macroblock rate at 60fps (1080p60 tagged
/// 4.0, 4K60 tagged 5.1), which strict decoders and upload validators may
/// reject. Table rows are (level label, MaxFS in macroblocks, MaxMBPS in
/// macroblocks/second) from ITU-T H.264 Table A-1, restricted to the levels
/// VideoToolbox exposes for the High profile.
const H264_HIGH_LEVELS: [(&str, u32, u32); 9] = [
    ("3.0", 1_620, 40_500),
    ("3.1", 3_600, 108_000),
    ("3.2", 5_120, 216_000),
    ("4.0", 8_192, 245_760),
    ("4.1", 8_192, 245_760),
    ("4.2", 8_704, 522_240),
    ("5.0", 22_080, 589_824),
    ("5.1", 36_864, 983_040),
    ("5.2", 36_864, 2_073_600),
];

/// Canvas envelope where record-only QUALITY encoding posture is allowed
/// (speed priority off): proven to sustain realtime up to 1440p. 4K keeps the
/// speed posture — the 0.9.44 owner incident showed quality-mode 4K warmup
/// falls behind realtime and trips the recording output's latency contract.
/// Shared by the VideoToolbox session and the ffmpeg `h264_videotoolbox` leg
/// so the two encode paths never disagree on posture.
pub fn quality_posture_canvas_envelope(width: u32, height: u32) -> bool {
    let long_side = width.max(height);
    let short_side = width.min(height);
    long_side <= 2560 && short_side <= 1440
}

/// Smallest spec-valid High-profile level label for `width`×`height` at `fps`,
/// or `None` when the stream exceeds level 5.2 (callers fall back to the
/// encoder's auto level rather than lying).
pub fn h264_high_level_label(width: u32, height: u32, fps: u32) -> Option<&'static str> {
    let mb_width = width.div_ceil(16).max(1);
    let mb_height = height.div_ceil(16).max(1);
    let frame_macroblocks = mb_width.checked_mul(mb_height)?;
    let macroblocks_per_second = frame_macroblocks.checked_mul(fps.max(1))?;
    H264_HIGH_LEVELS
        .iter()
        .find(|(_, max_fs, max_mbps)| {
            frame_macroblocks <= *max_fs && macroblocks_per_second <= *max_mbps
        })
        .map(|(label, _, _)| *label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_match_the_shipping_recording_matrix() {
        // The audit's failing combos and their spec-correct levels.
        assert_eq!(h264_high_level_label(1920, 1080, 30), Some("4.0"));
        assert_eq!(h264_high_level_label(1920, 1080, 60), Some("4.2"));
        assert_eq!(h264_high_level_label(2560, 1440, 30), Some("5.0"));
        assert_eq!(h264_high_level_label(2560, 1440, 60), Some("5.1"));
        assert_eq!(h264_high_level_label(3840, 2160, 30), Some("5.1"));
        assert_eq!(h264_high_level_label(3840, 2160, 60), Some("5.2"));
        assert_eq!(h264_high_level_label(640, 360, 24), Some("3.0"));
        assert_eq!(h264_high_level_label(1280, 720, 60), Some("3.2"));
    }

    #[test]
    fn vertical_twins_match_their_landscape_counterparts() {
        assert_eq!(
            h264_high_level_label(1080, 1920, 30),
            h264_high_level_label(1920, 1080, 30)
        );
        assert_eq!(
            h264_high_level_label(2160, 3840, 30),
            h264_high_level_label(3840, 2160, 30)
        );
    }

    #[test]
    fn quality_posture_envelope_covers_1440p_and_excludes_4k() {
        assert!(quality_posture_canvas_envelope(1920, 1080));
        assert!(quality_posture_canvas_envelope(2560, 1440));
        assert!(quality_posture_canvas_envelope(1440, 2560)); // vertical twin
        assert!(!quality_posture_canvas_envelope(3840, 2160));
        assert!(!quality_posture_canvas_envelope(2160, 3840));
    }

    #[test]
    fn beyond_level_5_2_returns_none() {
        assert_eq!(h264_high_level_label(3840, 2160, 120), None);
        assert_eq!(h264_high_level_label(7680, 4320, 30), None);
    }
}
