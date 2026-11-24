//! One clock format for every clock, timestamp and table cell (plan 174
//! S1.4), as `shared/timecode.ts` writes it: "2:05", "1:02:05".

/// `formatTimecode(ms)`: `m:ss`, or `h:mm:ss` from one hour. Negative times
/// read as zero; partial seconds are dropped, never rounded up.
pub fn format_timecode(ms: i64) -> String {
    write(ms, false)
}

/// `formatTimecode(ms, { withHours: true })`: hours even under an hour
/// ("0:02:05"), so a position lines up with a duration of an hour or more.
pub fn format_timecode_with_hours(ms: i64) -> String {
    write(ms, true)
}

fn write(ms: i64, with_hours: bool) -> String {
    let total = if ms > 0 { ms / 1000 } else { 0 };
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let seconds = total % 60;
    if hours > 0 || with_hours {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_minutes_then_hours_and_never_rounds_up() {
        assert_eq!(format_timecode(-5), "0:00");
        assert_eq!(format_timecode(1_999), "0:01");
        assert_eq!(format_timecode(125_000), "2:05");
        assert_eq!(format_timecode(3_725_000), "1:02:05");
        assert_eq!(format_timecode_with_hours(125_000), "0:02:05");
    }
}
