//! Free-space checks where recordings run out of disk (plan 200 C5).
//!
//! An MKV → MP4 export and a repair backup each write a second copy of the
//! recording beside the first. Both refuse to start without room for it, so
//! a full disk leaves the user's MKV intact instead of a half-written file.
//! The Record-time notice estimates the minutes left from the take's bitrate.

use std::path::Path;

const MIB: u64 = 1024 * 1024;
/// Headroom on top of the copy itself: the container, the moov rewrite of
/// `+faststart`, and whatever else writes to the volume meanwhile.
const EXPORT_HEADROOM_BYTES: u64 = 512 * MIB;
/// Today's floor, kept: under 1 GB always warns.
pub const RECORD_NOTICE_FLOOR_BYTES: u64 = 1024 * MIB;
/// The notice shows when the volume holds less than this many minutes.
pub const RECORD_NOTICE_MINUTES: u64 = 20;
/// The MKV's audio is 48 kHz stereo `pcm_s16le` on a record-only take that
/// keeps the original MKV or records separate sources (AAC 256k on other
/// record-only takes, 160k when streaming): estimate with the largest.
const RECORDING_AUDIO_KBPS: u64 = 1_536;

/// Free bytes on the volume holding `path`, or `None` where it can't be read.
pub fn available_bytes(path: &Path) -> Option<u64> {
    crate::noise_cleanup::available_space(path)
}

/// Room an export (or a repair backup) of `input_bytes` needs:
/// input × 1.05 + 512 MiB.
pub fn required_copy_bytes(input_bytes: u64) -> u64 {
    input_bytes
        .saturating_add(input_bytes / 20)
        .saturating_add(EXPORT_HEADROOM_BYTES)
}

/// Decimal units, like Finder and Explorer: "19.0 GB", "640 MB".
pub fn format_bytes(bytes: u64) -> String {
    const GB: f64 = 1_000_000_000.0;
    const MB: f64 = 1_000_000.0;
    let value = bytes as f64;
    if value >= GB {
        format!("{:.1} GB", value / GB)
    } else {
        format!("{:.0} MB", (value / MB).max(1.0))
    }
}

/// The user-facing refusal when an MP4 export has no room.
pub fn export_space_message(required: u64, available: u64) -> String {
    format!(
        "Not enough disk space to finish the MP4 (needs {}, {} free). Your recording is safe as MKV; free some space and use Export MP4.",
        format_bytes(required),
        format_bytes(available)
    )
}

/// `Err(message)` when `available` cannot hold an export of `input_bytes`.
pub fn check_export_space(input_bytes: u64, available: u64) -> Result<(), String> {
    let required = required_copy_bytes(input_bytes);
    if available < required {
        return Err(export_space_message(required, available));
    }
    Ok(())
}

/// Checks the volume of `output_dir` before an MKV → MP4 export of `input`.
/// A size or free-space reading that fails never blocks the export.
pub fn ensure_export_space(input: &Path, output_dir: &Path) -> anyhow::Result<()> {
    let Some(input_bytes) = std::fs::metadata(input).ok().map(|meta| meta.len()) else {
        return Ok(());
    };
    let Some(available) = available_bytes(output_dir) else {
        return Ok(());
    };
    check_export_space(input_bytes, available).map_err(anyhow::Error::msg)
}

/// Checks room for a repair's backup copy of `original` in `backup_dir`'s
/// volume (the backup sits beside the recording).
pub fn check_backup_space(original_bytes: u64, available: u64) -> Result<(), String> {
    let required = required_copy_bytes(original_bytes);
    if available < required {
        return Err(format!(
            "Not enough disk space to back up the original before the repair (needs {}, {} free). The recording was left unchanged.",
            format_bytes(required),
            format_bytes(available)
        ));
    }
    Ok(())
}

/// Bytes one minute of recording writes: the video bitrate for Combined and
/// each separate file, plus their audio, doubled for the export peak (the
/// MP4 is written beside the MKV before the MKV goes).
pub fn recording_bytes_per_minute(video_kbps: u32, separate_files: usize) -> u64 {
    let files = 1 + separate_files as u64;
    let kbps = (u64::from(video_kbps) + RECORDING_AUDIO_KBPS).saturating_mul(files);
    let bytes_per_minute = kbps.saturating_mul(1000 / 8).saturating_mul(60);
    bytes_per_minute.saturating_mul(2)
}

/// Whole minutes of recording `available` bytes hold.
pub fn recording_minutes_left(available: u64, video_kbps: u32, separate_files: usize) -> u64 {
    let per_minute = recording_bytes_per_minute(video_kbps, separate_files).max(1);
    available / per_minute
}

/// The Record-time notice, or `None` when there is room for 20 minutes or
/// more and at least 1 GB.
pub fn record_space_notice(
    available: u64,
    video_kbps: u32,
    separate_files: usize,
) -> Option<String> {
    let minutes = recording_minutes_left(available, video_kbps, separate_files);
    if available >= RECORD_NOTICE_FLOOR_BYTES && minutes >= RECORD_NOTICE_MINUTES {
        return None;
    }
    let files = if separate_files > 0 {
        " with separate files"
    } else {
        ""
    };
    Some(match minutes {
        0 => format!(
            "Less than a minute of recording{files} fits in the selected recording location ({} free).",
            format_bytes(available)
        ),
        1 => format!(
            "About 1 minute of recording{files} fits in the selected recording location ({} free).",
            format_bytes(available)
        ),
        minutes => format!(
            "About {minutes} minutes of recording{files} fit in the selected recording location ({} free).",
            format_bytes(available)
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * MIB;

    #[test]
    fn required_space_is_five_percent_over_the_input_plus_512_mib() {
        assert_eq!(required_copy_bytes(0), 512 * MIB);
        assert_eq!(required_copy_bytes(20 * GIB), 21 * GIB + 512 * MIB);
        assert_eq!(required_copy_bytes(u64::MAX), u64::MAX);
    }

    #[test]
    fn an_export_without_room_is_refused_with_the_safe_mkv_copy() {
        let input = 18_960_000_000; // the 84-minute record+stream take
        let required = required_copy_bytes(input);
        assert!(check_export_space(input, required).is_ok());
        let message = check_export_space(input, required - 1).unwrap_err();
        assert_eq!(
            message,
            "Not enough disk space to finish the MP4 (needs 20.4 GB, 20.4 GB free). Your recording is safe as MKV; free some space and use Export MP4."
        );
        let message = check_export_space(input, 6_000_000_000).unwrap_err();
        assert!(
            message.contains("(needs 20.4 GB, 6.0 GB free)"),
            "{message}"
        );
        assert!(check_backup_space(GIB, GIB).is_err());
        assert!(check_backup_space(GIB, 2 * GIB).is_ok());
    }

    #[test]
    fn bytes_format_in_decimal_units() {
        assert_eq!(format_bytes(19_000_000_000), "19.0 GB");
        assert_eq!(format_bytes(640_000_000), "640 MB");
        assert_eq!(format_bytes(0), "1 MB");
    }

    #[test]
    fn minutes_left_counts_separate_files_and_the_export_peak() {
        // 1080p30 at 12 Mbps: (12000 + 1536) kbps → 101.52 MB/min, ×2 export.
        assert_eq!(recording_bytes_per_minute(12_000, 0), 203_040_000);
        // Two separate files triple the writers.
        assert_eq!(recording_bytes_per_minute(12_000, 2), 3 * 203_040_000);
        let available = 19 * 1_000_000_000;
        assert_eq!(recording_minutes_left(available, 12_000, 0), 93);
        assert_eq!(recording_minutes_left(available, 12_000, 2), 31);
        // 4K30 at 30 Mbps with separate files on a nearly full disk.
        assert_eq!(recording_minutes_left(6 * 1_000_000_000, 30_000, 2), 4);
        assert_eq!(recording_minutes_left(0, 30_000, 2), 0);
    }

    #[test]
    fn the_record_notice_shows_under_twenty_minutes_and_keeps_the_1_gb_floor() {
        assert_eq!(record_space_notice(19 * 1_000_000_000, 12_000, 0), None);
        assert_eq!(
            record_space_notice(6 * 1_000_000_000, 30_000, 2).as_deref(),
            Some(
                "About 4 minutes of recording with separate files fit in the selected recording location (6.0 GB free)."
            )
        );
        // A low bitrate fits 20 minutes in under 1 GB: the floor still warns.
        let under_floor = 900 * MIB;
        assert!(recording_minutes_left(under_floor, 500, 0) >= RECORD_NOTICE_MINUTES);
        assert!(record_space_notice(under_floor, 500, 0).is_some());
        assert_eq!(
            record_space_notice(100 * MIB, 12_000, 0).as_deref(),
            Some(
                "Less than a minute of recording fits in the selected recording location (105 MB free)."
            )
        );
    }

    #[test]
    fn a_failed_reading_never_blocks_an_export() {
        let missing = Path::new("/nonexistent/videorc-plan-200/take.mkv");
        assert!(ensure_export_space(missing, Path::new("/")).is_ok());
    }
}
