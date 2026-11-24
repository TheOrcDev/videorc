//! The renderer's shared spellings (plan 260 S1.6f): `lib/format.ts`,
//! `lib/format-time.ts` and `lib/platform-copy.ts`'s device noun, in one
//! place. `videorc-rust` kept copies of these in Studio, Health, Library and
//! the Stream Manager; every page here reads this module instead.
//!
//! Dates and clock times follow the computer's time zone, as `Intl` does in
//! the renderer. Electron leaves the locale to the system; these keep
//! `videorc-rust`'s fixed English spellings (a 24-hour [`compact_time`], a
//! 12-hour [`day_label`]) until the GPUI app reads the system locale.

use chrono::{DateTime, Datelike, Local, Utc};

/// `compactTime`: the clock time of an ISO timestamp ("14:03:22"); the
/// timestamp itself when it does not read.
pub fn compact_time(timestamp: &str) -> String {
    match DateTime::parse_from_rfc3339(timestamp) {
        Ok(at) => at.with_timezone(&Local).format("%H:%M:%S").to_string(),
        Err(_) => timestamp.to_string(),
    }
}

const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const DAY_MS: i64 = 24 * HOUR_MS;
/// Past this, a row shows the date it happened instead of an age.
const RELATIVE_DAYS_MAX: i64 = 7;

/// `formatRelativeTime`: "now" under 45 s, then "4m", "2h", "3d", then the
/// date ("Oct 2", with the year when it is not this year). An unreadable
/// time is the empty string; a time in the future reads "now".
pub fn format_relative_time(iso: &str, now: DateTime<Utc>) -> String {
    let Ok(at) = DateTime::parse_from_rfc3339(iso) else {
        return String::new();
    };
    let at = at.with_timezone(&Utc);
    let elapsed = (now - at).num_milliseconds().max(0);
    if elapsed < 45_000 {
        return "now".into();
    }
    if elapsed < HOUR_MS {
        return format!("{}m", (elapsed / MINUTE_MS).max(1));
    }
    if elapsed < DAY_MS {
        return format!("{}h", elapsed / HOUR_MS);
    }
    if elapsed < RELATIVE_DAYS_MAX * DAY_MS {
        return format!("{}d", elapsed / DAY_MS);
    }
    format_short_date(at, now)
}

/// `formatShortDate`: "Oct 2", or "Oct 2, 2025" outside the current year.
pub fn format_short_date(at: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let local = at.with_timezone(&Local);
    if local.year() == now.with_timezone(&Local).year() {
        local.format("%b %-d").to_string()
    } else {
        local.format("%b %-d, %Y").to_string()
    }
}

/// `plural`: a count and its noun, agreeing ("1 drop", "12 drops", "1,204
/// viewers"). `many` defaults to the noun plus "s".
pub fn plural(count: i64, one: &str, many: Option<&str>) -> String {
    let noun = if count == 1 {
        one.to_string()
    } else {
        many.map_or_else(|| format!("{one}s"), str::to_string)
    };
    format!("{} {noun}", grouped(count))
}

/// `toLocaleString()` for a count: thousands with commas.
pub fn grouped(count: i64) -> String {
    let digits = count.unsigned_abs().to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3 + 1);
    if count < 0 {
        out.push('-');
    }
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// `NO_VALUE`: the one placeholder for a value that cannot be shown, an en
/// dash, shown with its reason.
pub const NO_VALUE: &str = "–";

/// `formatTimecode` (`shared/timecode.ts`): milliseconds as m:ss, or h:mm:ss
/// from one hour (or always, `with_hours`). Negative times read as zero;
/// partial seconds are dropped, never rounded up.
pub fn format_timecode(ms: i64, with_hours: bool) -> String {
    let total = ms.max(0) / 1000;
    let (hours, minutes, seconds) = (total / 3600, (total % 3600) / 60, total % 60);
    if hours > 0 || with_hours {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

/// `durationMsLabel`: a recording's length as the one timecode, unknown as
/// [`NO_VALUE`].
pub fn duration_ms_label(duration_ms: Option<i64>) -> String {
    duration_ms.map_or_else(|| NO_VALUE.to_string(), |ms| format_timecode(ms, false))
}

/// `formatBytes`: "263 KB", "1.2 GB", or "-" for none. The unit is picked by
/// the value as shown, so 1023.95 KB reads "1 MB", never "1024 KB".
pub fn format_bytes(bytes: Option<f64>) -> String {
    let Some(bytes) = bytes.filter(|bytes| bytes.is_finite() && *bytes >= 0.0) else {
        return "-".to_string();
    };
    if bytes < 1024.0 {
        return format!("{} B", js_round(bytes));
    }
    let shown = |value: f64| {
        if value >= 100.0 {
            js_round(value)
        } else {
            js_round(value * 10.0) / 10.0
        }
    };
    let mut value = bytes;
    let mut unit = "B";
    for candidate in ["KB", "MB", "GB", "TB"] {
        value /= 1024.0;
        unit = candidate;
        if shown(value) < 1024.0 {
            break;
        }
    }
    format!("{} {unit}", shown(value))
}

/// `Math.round`: halves round up, toward positive infinity.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `dayLabel`: "Nov 9, 10:46 AM" in this computer's time zone; the stamp
/// itself when it does not read.
pub fn day_label(timestamp: &str) -> String {
    DateTime::parse_from_rfc3339(timestamp)
        .map(|at| {
            at.with_timezone(&Local)
                .format("%b %-d, %I:%M %p")
                .to_string()
        })
        .unwrap_or_else(|_| timestamp.to_string())
}

/// `isAutoSessionTitle`: the backend's name for an unnamed session,
/// "Session 2026-10-02 14:55", which a list that shows when it ran should
/// not repeat.
pub fn is_auto_session_title(title: &str) -> bool {
    let Some(rest) = title.trim().strip_prefix("Session ") else {
        return false;
    };
    let shape = b"dddd-dd-dd dd:dd";
    rest.len() == shape.len()
        && rest
            .bytes()
            .zip(shape.iter())
            .all(|(byte, want)| match want {
                b'd' => byte.is_ascii_digit(),
                other => byte == *other,
            })
}

/// `platformCopy(platform).deviceNoun`: "Mac", "PC" or "computer".
pub fn device_noun(platform: &str) -> &'static str {
    match platform {
        "darwin" => "Mac",
        "win32" => "PC",
        _ => "computer",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 24, 12, 0, 0).unwrap()
    }

    /// `format-time.test.ts`'s cases.
    #[test]
    fn relative_time_rolls_over_to_days_then_a_date() {
        let at = |seconds_ago: i64| (now() - chrono::Duration::seconds(seconds_ago)).to_rfc3339();
        assert_eq!(format_relative_time(&at(10), now()), "now");
        assert_eq!(format_relative_time(&at(-60), now()), "now");
        assert_eq!(format_relative_time(&at(50), now()), "1m");
        assert_eq!(format_relative_time(&at(4 * 60), now()), "4m");
        assert_eq!(format_relative_time(&at(2 * 3600), now()), "2h");
        assert_eq!(format_relative_time(&at(3 * 86_400), now()), "3d");
        assert_eq!(format_relative_time("2026-10-02T12:00:00Z", now()), "Oct 2");
        assert_eq!(
            format_relative_time("2025-10-02T12:00:00Z", now()),
            "Oct 2, 2025"
        );
        assert_eq!(format_relative_time("not a time", now()), "");
    }

    #[test]
    fn compact_time_is_the_clock_or_the_text_back() {
        let clock = compact_time("2026-11-24T12:03:22Z");
        assert_eq!(clock.len(), 8, "{clock}");
        assert!(clock.ends_with(":22"), "{clock}");
        assert_eq!(compact_time("garbage"), "garbage");
    }

    #[test]
    fn plural_agrees_and_groups_thousands() {
        assert_eq!(plural(1, "drop", None), "1 drop");
        assert_eq!(plural(12, "drop", None), "12 drops");
        assert_eq!(plural(0, "emote", None), "0 emotes");
        assert_eq!(plural(1204, "viewer", None), "1,204 viewers");
        assert_eq!(plural(2, "match", Some("matches")), "2 matches");
        assert_eq!(grouped(1_234_567), "1,234,567");
        assert_eq!(grouped(-1000), "-1,000");
        assert_eq!(grouped(999), "999");
    }

    /// `timecode.test.ts` and `format.test.ts`'s cases.
    #[test]
    fn timecodes_bytes_and_session_titles() {
        assert_eq!(format_timecode(125_000, false), "2:05");
        assert_eq!(format_timecode(3_725_999, false), "1:02:05");
        assert_eq!(format_timecode(125_000, true), "0:02:05");
        assert_eq!(format_timecode(-5, false), "0:00");
        assert_eq!(duration_ms_label(None), "–");
        assert_eq!(duration_ms_label(Some(754_000)), "12:34");
        assert_eq!(format_bytes(None), "-");
        assert_eq!(format_bytes(Some(-1.0)), "-");
        assert_eq!(format_bytes(Some(512.0)), "512 B");
        assert_eq!(format_bytes(Some(269_312.0)), "263 KB");
        assert_eq!(format_bytes(Some(1_048_524.0)), "1 MB");
        assert_eq!(format_bytes(Some(1.2 * 1024.0 * 1024.0 * 1024.0)), "1.2 GB");
        assert!(is_auto_session_title("Session 2026-10-02 14:55"));
        assert!(is_auto_session_title("  Session 2026-10-02 14:55 "));
        assert!(!is_auto_session_title("Session 2026-10-02 14:55 take 2"));
        assert!(!is_auto_session_title("My show"));
        assert_eq!(day_label("nope"), "nope");
        assert!(day_label("2026-11-09T10:46:00Z").starts_with("Nov "));
    }

    #[test]
    fn the_device_noun_follows_the_platform() {
        assert_eq!(device_noun("darwin"), "Mac");
        assert_eq!(device_noun("win32"), "PC");
        assert_eq!(device_noun("linux"), "computer");
    }
}
