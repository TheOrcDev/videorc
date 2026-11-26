//! The renderer's shared spellings (plan 260 S1.6f): `lib/format.ts`,
//! `lib/format-time.ts` and `lib/platform-copy.ts`'s device noun, in one
//! place. `videorc-rust` kept copies of these in Studio, Health, Library and
//! the Stream Manager; every page here reads this module instead.
//!
//! Dates and clock times follow the computer's time zone, as `Intl` does in
//! the renderer. [`day_label`] also follows the computer's region and its
//! 12/24-hour setting, as `Intl.DateTimeFormat` with the system locale does:
//! the app hands it a [`DateStyle`] read from the system at launch
//! ([`set_date_style`]); without one it reads the locale from the
//! environment. [`compact_time`] keeps `videorc-rust`'s 24-hour clock.

use std::sync::OnceLock;

use chrono::{DateTime, Datelike, Local, NaiveDateTime, Timelike, Utc};

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

/// `dayLabel`: when something ran, in this computer's time zone and the way
/// its region writes a day and a time: "Nov 9, 10:46 AM" in the US, "9 Nov,
/// 10:46" in the UK or Serbia. The stamp itself when it does not read.
pub fn day_label(timestamp: &str) -> String {
    DateTime::parse_from_rfc3339(timestamp)
        .map(|at| day_label_at(at.with_timezone(&Local).naive_local(), date_style()))
        .unwrap_or_else(|_| timestamp.to_string())
}

/// [`day_label`] for a wall-clock time, in `style`.
pub fn day_label_at(at: NaiveDateTime, style: &DateStyle) -> String {
    let mut out = String::new();
    let mut chars = style.pattern.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\'' {
            // ICU quoting: `''` is a quote; `'at'` is the word "at".
            if chars.peek() == Some(&'\'') {
                chars.next();
                out.push('\'');
                continue;
            }
            while let Some(quoted) = chars.next() {
                if quoted != '\'' {
                    out.push(quoted);
                } else if chars.peek() == Some(&'\'') {
                    chars.next();
                    out.push('\'');
                } else {
                    break;
                }
            }
        } else if c.is_ascii_alphabetic() {
            let mut width = 1;
            while chars.peek() == Some(&c) {
                chars.next();
                width += 1;
            }
            push_date_field(&mut out, c, width, at, style);
        } else {
            out.push(match c {
                // ICU's narrow no-break space (before AM/PM) is not in every
                // font; a no-break space is, and still keeps "10:46 AM" whole.
                '\u{202F}' => '\u{00A0}',
                other => other,
            });
        }
    }
    out
}

/// One pattern field ("MMM", "d", "hh", "a"). A field the label never asks
/// for (a weekday, an era) is left out.
fn push_date_field(
    out: &mut String,
    letter: char,
    width: usize,
    at: NaiveDateTime,
    style: &DateStyle,
) {
    let number = |value: u32| {
        if width >= 2 {
            format!("{value:02}")
        } else {
            value.to_string()
        }
    };
    let field = match letter {
        'd' => number(at.day()),
        'M' | 'L' if width <= 2 => number(at.month()),
        'M' | 'L' => style
            .short_months
            .get(at.month0() as usize)
            .cloned()
            .unwrap_or_else(|| ENGLISH_SHORT_MONTHS[at.month0() as usize].to_string()),
        'y' if width == 2 => format!("{:02}", at.year().rem_euclid(100)),
        'y' => at.year().to_string(),
        'H' => number(at.hour()),
        'k' => number(if at.hour() == 0 { 24 } else { at.hour() }),
        'h' => number(match at.hour() % 12 {
            0 => 12,
            hour => hour,
        }),
        'K' => number(at.hour() % 12),
        'm' => number(at.minute()),
        'a' | 'b' | 'B' => {
            if at.hour() < 12 {
                style.am.clone()
            } else {
                style.pm.clone()
            }
        }
        _ => String::new(),
    };
    out.push_str(&field);
}

const ENGLISH_SHORT_MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Regions that write the month before the day ("Nov 9").
const MONTH_FIRST_REGIONS: &[&str] = &["US", "CA", "PH"];

/// Regions whose clock is 12-hour by default (CLDR's preferred hour cycle).
const TWELVE_HOUR_REGIONS: &[&str] = &[
    "US", "CA", "AU", "NZ", "IN", "PH", "PK", "BD", "EG", "SA", "AE", "JO", "MY", "SG", "TW", "KR",
    "CO",
];

/// How this computer writes a day and a time for [`day_label`]: the pattern
/// `Intl.DateTimeFormat` resolves for `{ month: 'short', day: 'numeric',
/// hour: '2-digit', minute: '2-digit' }` (ICU's skeleton `MMMdjjmm`) in the
/// system locale, with that locale's month and AM/PM words.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DateStyle {
    /// An ICU date pattern: "MMM d, hh:mm a", "d MMM, HH:mm".
    pub pattern: String,
    /// The twelve short month names, January first.
    pub short_months: Vec<String>,
    pub am: String,
    pub pm: String,
}

impl DateStyle {
    /// From a locale name as the environment or Windows spells it
    /// ("en_GB.UTF-8", "en-US", "sr-Latn-RS"), with English words: the region
    /// decides whether the month or the day leads and the default hour
    /// cycle; `twenty_four_hour` is the computer's own 12/24-hour setting
    /// when it has one. No region ("C", "en") reads as the US.
    pub fn for_locale(locale: &str, twenty_four_hour: Option<bool>) -> Self {
        let region = locale_region(locale).unwrap_or_else(|| "US".to_string());
        let region = region.as_str();
        let month_first = MONTH_FIRST_REGIONS.contains(&region);
        let twenty_four_hour =
            twenty_four_hour.unwrap_or_else(|| !TWELVE_HOUR_REGIONS.contains(&region));
        let time = if twenty_four_hour { "HH:mm" } else { "hh:mm a" };
        let day = if month_first { "MMM d" } else { "d MMM" };
        let (am, pm) = if month_first {
            ("AM", "PM")
        } else {
            ("am", "pm")
        };
        Self {
            pattern: format!("{day}, {time}"),
            short_months: ENGLISH_SHORT_MONTHS
                .iter()
                .map(|month| month.to_string())
                .collect(),
            am: am.to_string(),
            pm: pm.to_string(),
        }
    }

    /// From the locale the environment names (`LC_ALL`, then `LC_TIME`, then
    /// `LANG`), as Linux apps read it.
    pub fn from_env() -> Self {
        let locale = ["LC_ALL", "LC_TIME", "LANG"]
            .into_iter()
            .filter_map(|name| std::env::var(name).ok())
            .find(|value| !value.trim().is_empty())
            .unwrap_or_default();
        Self::for_locale(&locale, None)
    }
}

/// The region of a locale name: "en_GB.UTF-8" → "GB", "sr-Latn-RS" → "RS",
/// "es-419" → "419"; none for "C", "POSIX" or a bare language.
fn locale_region(locale: &str) -> Option<String> {
    let name = locale.split(['.', '@']).next().unwrap_or_default();
    name.split(['-', '_'])
        .skip(1)
        .find(|part| {
            (part.len() == 2 && part.chars().all(|c| c.is_ascii_alphabetic()))
                || (part.len() == 3 && part.chars().all(|c| c.is_ascii_digit()))
        })
        .map(|part| part.to_ascii_uppercase())
}

static DATE_STYLE: OnceLock<DateStyle> = OnceLock::new();

/// The system's [`DateStyle`], read by the app at launch before any page
/// draws. A second call keeps the first style.
pub fn set_date_style(style: DateStyle) {
    let _ = DATE_STYLE.set(style);
}

fn date_style() -> &'static DateStyle {
    DATE_STYLE.get_or_init(DateStyle::from_env)
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
        assert!(day_label("2026-11-09T10:46:00Z").contains("Nov"));
    }

    fn wall(text: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M").unwrap()
    }

    #[test]
    fn the_day_label_follows_the_region_as_intl_does() {
        let morning = wall("2026-11-09 04:56");
        let evening = wall("2026-11-26 16:05");
        let us = DateStyle::for_locale("en_US.UTF-8", None);
        assert_eq!(day_label_at(morning, &us), "Nov 9, 04:56 AM");
        assert_eq!(day_label_at(evening, &us), "Nov 26, 04:05 PM");
        // en-GB, and Serbia's English (this Mac's en_RS), as Electron shows them.
        for locale in [
            "en_GB.UTF-8",
            "en-GB",
            "en_RS",
            "sr-Latn-RS",
            "de_DE.UTF-8@euro",
        ] {
            let style = DateStyle::for_locale(locale, None);
            assert_eq!(day_label_at(morning, &style), "9 Nov, 04:56", "{locale}");
            assert_eq!(day_label_at(evening, &style), "26 Nov, 16:05", "{locale}");
        }
        let australia = DateStyle::for_locale("en-AU", None);
        assert_eq!(day_label_at(evening, &australia), "26 Nov, 04:05 pm");
        // No region reads as the US.
        for locale in ["", "C", "POSIX", "en", "C.UTF-8"] {
            let style = DateStyle::for_locale(locale, None);
            assert_eq!(
                day_label_at(morning, &style),
                "Nov 9, 04:56 AM",
                "{locale:?}"
            );
        }
    }

    #[test]
    fn the_computers_12_24_hour_setting_wins_over_the_region() {
        let midnight = wall("2026-11-09 00:07");
        let evening = wall("2026-11-26 16:05");
        let us_24 = DateStyle::for_locale("en_US", Some(true));
        assert_eq!(day_label_at(evening, &us_24), "Nov 26, 16:05");
        assert_eq!(day_label_at(midnight, &us_24), "Nov 9, 00:07");
        let gb_12 = DateStyle::for_locale("en_GB", Some(false));
        assert_eq!(day_label_at(evening, &gb_12), "26 Nov, 04:05 pm");
        assert_eq!(day_label_at(midnight, &gb_12), "9 Nov, 12:07 am");
    }

    #[test]
    fn a_system_pattern_is_followed_field_by_field() {
        let at = wall("2026-03-05 09:07");
        let style = |pattern: &str| DateStyle {
            pattern: pattern.to_string(),
            short_months: ENGLISH_SHORT_MONTHS.iter().map(|m| m.to_string()).collect(),
            am: "AM".into(),
            pm: "PM".into(),
        };
        // macOS en_US: a narrow no-break space before AM becomes a no-break space.
        assert_eq!(
            day_label_at(at, &style("MMM d, hh:mm\u{202F}a")),
            "Mar 5, 09:07\u{00A0}AM"
        );
        assert_eq!(day_label_at(at, &style("d. MMM, HH:mm")), "5. Mar, 09:07");
        assert_eq!(
            day_label_at(at, &style("MMM d 'at' h:mm a")),
            "Mar 5 at 9:07 AM"
        );
        assert_eq!(
            day_label_at(at, &style("dd/MM, H:mm 'o''clock'")),
            "05/03, 9:07 o'clock"
        );
        assert_eq!(
            day_label_at(wall("2026-03-05 00:07"), &style("K:mm a · kk:mm")),
            "0:07 AM · 24:07"
        );
        // The system's own month words (here German), never guessed.
        let mut german = style("d. MMM, HH:mm");
        german.short_months[2] = "März".into();
        assert_eq!(day_label_at(at, &german), "5. März, 09:07");
        // A field the label never asks for is left out; ICU's j never
        // reaches a resolved pattern.
        assert_eq!(day_label_at(at, &style("EEE d MMM")), " 5 Mar");
    }

    #[test]
    fn the_region_is_read_from_any_locale_spelling() {
        assert_eq!(locale_region("en_GB.UTF-8").as_deref(), Some("GB"));
        assert_eq!(locale_region("sr-Latn-RS").as_deref(), Some("RS"));
        assert_eq!(locale_region("es-419").as_deref(), Some("419"));
        assert_eq!(locale_region("de_DE@euro").as_deref(), Some("DE"));
        assert_eq!(locale_region("en_us").as_deref(), Some("US"));
        assert_eq!(locale_region("C.UTF-8"), None);
        assert_eq!(locale_region("en"), None);
    }

    #[test]
    fn the_device_noun_follows_the_platform() {
        assert_eq!(device_noun("darwin"), "Mac");
        assert_eq!(device_noun("win32"), "PC");
        assert_eq!(device_noun("linux"), "computer");
    }
}
