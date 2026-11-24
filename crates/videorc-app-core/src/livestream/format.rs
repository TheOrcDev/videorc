//! `lib/format-time.ts`' `formatRelativeTime`, which Discord's "Last post"
//! and Upcoming's "Last checked" read. `crate::format` (plan 260 S1.6f, #1757)
//! holds the app's shared copy; this one goes once that is in this stack.

use chrono::{DateTime, Datelike, Local, Utc};

/// "now", "5m", "3h", "2d", then "Oct 2" ("Oct 2, 2025" outside this year)
/// in local time; "" for a time that doesn't parse.
pub fn format_relative_time(iso: &str, now: DateTime<Utc>) -> String {
    let Ok(at) = DateTime::parse_from_rfc3339(iso) else {
        return String::new();
    };
    let at = at.with_timezone(&Utc);
    const MINUTE: i64 = 60_000;
    const HOUR: i64 = 60 * MINUTE;
    const DAY: i64 = 24 * HOUR;
    let elapsed = (now - at).num_milliseconds().max(0);
    if elapsed < 45_000 {
        return "now".into();
    }
    if elapsed < HOUR {
        return format!("{}m", (elapsed / MINUTE).max(1));
    }
    if elapsed < DAY {
        return format!("{}h", elapsed / HOUR);
    }
    if elapsed < 7 * DAY {
        return format!("{}d", elapsed / DAY);
    }
    let local = at.with_timezone(&Local);
    if local.year() == now.with_timezone(&Local).year() {
        local.format("%b %-d").to_string()
    } else {
        local.format("%b %-d, %Y").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_times_read_short() {
        let now = "2035-01-08T12:00:00Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(format_relative_time("2035-01-08T11:59:30Z", now), "now");
        assert_eq!(format_relative_time("2035-01-08T11:59:00Z", now), "1m");
        assert_eq!(format_relative_time("2035-01-08T09:00:00Z", now), "3h");
        assert_eq!(format_relative_time("2035-01-06T12:00:00Z", now), "2d");
        assert_eq!(format_relative_time("2035-01-09T12:00:00Z", now), "now");
        assert_eq!(format_relative_time("soon", now), "");
    }
}
