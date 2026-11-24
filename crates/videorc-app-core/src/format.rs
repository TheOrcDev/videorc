//! The renderer's shared spellings (plan 260 S1.6f): `lib/format.ts`,
//! `lib/format-time.ts` and `lib/platform-copy.ts`'s device noun, in one
//! place. `videorc-rust` kept copies of these in Studio, Health, Library and
//! the Stream Manager; every page here reads this module instead.
//!
//! Dates and clock times follow the computer's time zone, as `Intl` does in
//! the renderer. Electron leaves the locale to the system; these use the
//! 24-hour clock and English month names, as `videorc-rust` did.

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

    #[test]
    fn the_device_noun_follows_the_platform() {
        assert_eq!(device_noun("darwin"), "Mac");
        assert_eq!(device_noun("win32"), "PC");
        assert_eq!(device_noun("linux"), "computer");
    }
}
