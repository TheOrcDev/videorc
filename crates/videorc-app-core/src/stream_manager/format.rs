//! The Stream Manager's small formatters, shared by the rows, Sidekick's
//! cards and (when it lands) the stats bar: `plural` and `timeOfDay` from
//! `lib/stream-manager-stats.ts`, and the en-US number grouping of
//! `lib/format.ts`. The Studio's health page (S1.6a) groups numbers the same
//! way and can share `group_thousands`.

use chrono::{DateTime, Local, Utc};

/// `toLocaleString()` of a whole number, as en-US groups it ("1,204").
pub fn group_thousands(value: i64) -> String {
    let digits = value.unsigned_abs().to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3 + 1);
    if value < 0 {
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

/// `plural`: "1 viewer", "1,204 viewers".
pub fn plural(count: i64, one: &str, many: &str) -> String {
    format!(
        "{} {}",
        group_thousands(count),
        if count == 1 { one } else { many }
    )
}

/// An ISO time, or none.
pub fn parse_time(at: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(at)
        .ok()
        .map(|at| at.with_timezone(&Utc))
}

/// `timeOfDay`: "11:28 AM" in this computer's time zone; empty for a time
/// it can't read.
pub fn time_of_day(iso: &str) -> String {
    parse_time(iso)
        .map(|at| at.with_timezone(&Local).format("%I:%M %p").to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_group_as_en_us_and_plural_picks_the_word() {
        assert_eq!(group_thousands(0), "0");
        assert_eq!(group_thousands(1_204), "1,204");
        assert_eq!(group_thousands(-1_234_567), "-1,234,567");
        assert_eq!(plural(1, "viewer", "viewers"), "1 viewer");
        assert_eq!(plural(1_204, "viewer", "viewers"), "1,204 viewers");
        assert_eq!(time_of_day("not a time"), "");
        assert!(!time_of_day("2026-11-24T10:28:00Z").is_empty());
    }
}
