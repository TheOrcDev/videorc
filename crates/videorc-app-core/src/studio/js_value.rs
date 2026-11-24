//! JavaScript's value rules over `serde_json::Value` (plan 220 S3.0d).
//!
//! The renderer's normalizers (`lib/capture.ts` and the key families) are
//! written against what `JSON.parse` returns and lean on JavaScript's own
//! conversions: `Number(value)`, `Math.round`, truthiness, `typeof … ===
//! 'object'`, object spread, `String.prototype.trim` and `Date.parse`. The
//! Rust model repairs a stored value exactly as the renderer does only if it
//! converts exactly as JavaScript does, so those conversions live here, each
//! named after the JavaScript it mirrors.
//!
//! `undefined` has no JSON form: a key the renderer sets to `undefined` is
//! a key `JSON.stringify` leaves out, so here it is a key that is absent
//! (`None` where a lookup can miss).

use serde_json::{Map, Value};

/// `value[key]` on a parsed JSON value: a named property of an object, else
/// `undefined`. (Arrays and strings have no named properties a normalizer
/// reads.)
pub fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value? {
        Value::Object(object) => object.get(key),
        _ => None,
    }
}

/// `value && typeof value === 'object'`: an object or an array.
pub fn is_object_like(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_) | Value::Array(_)))
}

/// `Boolean(value)`.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `value == null`: `undefined` or `null`.
pub fn is_nullish(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

/// `value ?? fallback`.
pub fn or_nullish<'a>(value: Option<&'a Value>, fallback: &'a Value) -> &'a Value {
    match value {
        None | Some(Value::Null) => fallback,
        Some(value) => value,
    }
}

/// `typeof value === 'boolean' ? value : fallback`.
pub fn bool_or(value: Option<&Value>, fallback: bool) -> bool {
    value.and_then(Value::as_bool).unwrap_or(fallback)
}

/// `typeof value === 'string' ? value : undefined`.
pub fn string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

/// `typeof value === 'number' && Number.isFinite(value) ? value : undefined`.
pub fn finite_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

/// A JavaScript number as `JSON.stringify` writes it: an integral value as
/// an integer (`100`, never `100.0`; `-0` as `0`), any other finite value
/// as itself, and `NaN` or an infinity as `null`.
pub fn number_value(number: f64) -> Value {
    if !number.is_finite() {
        return Value::Null;
    }
    if number.fract() == 0.0 && number.abs() < 9.007_199_254_740_992e15 {
        return Value::from(number as i64);
    }
    serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number)
}

/// `Math.round`: halves round toward +∞ (`Math.round(-2.5) === -2`).
pub fn round(number: f64) -> f64 {
    if !number.is_finite() {
        return number;
    }
    let floor = number.floor();
    if number - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// `Number(value)`, for a parsed JSON value (`None` is `undefined`).
pub fn to_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => string_to_number(text),
        Some(Value::Array(items)) => match items.as_slice() {
            // `Number([])` is `Number('')`; one element is that element as a
            // string; two or more join with a comma, which no number has.
            [] => 0.0,
            [only] => match only {
                Value::Null => 0.0,
                Value::String(text) => string_to_number(text),
                Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
                Value::Array(_) => to_number(Some(only)),
                Value::Bool(_) | Value::Object(_) => f64::NAN,
            },
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `clampNumber` (`lib/capture.ts`): `Number(value)`, the fallback when it
/// is not finite, else rounded and clamped.
pub fn clamp_number(value: Option<&Value>, fallback: f64, min: f64, max: f64) -> f64 {
    let parsed = to_number(value);
    if !parsed.is_finite() {
        return fallback;
    }
    max.min(min.max(round(parsed)))
}

/// JavaScript's `StringToNumber`: whitespace trimmed, empty is 0, the
/// decimal literal grammar, `Infinity`, and the 0x / 0o / 0b integers.
pub fn string_to_number(text: &str) -> f64 {
    let trimmed = trim(text);
    if trimmed.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = trimmed.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |total, c| {
                total * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
            });
        }
    }
    let (sign, unsigned) = match trimmed.as_bytes()[0] {
        b'+' => (1.0, &trimmed[1..]),
        b'-' => (-1.0, &trimmed[1..]),
        _ => (1.0, trimmed),
    };
    if unsigned == "Infinity" {
        return sign * f64::INFINITY;
    }
    if !is_decimal_literal(unsigned) {
        return f64::NAN;
    }
    unsigned
        .parse::<f64>()
        .map_or(f64::NAN, |number| sign * number)
}

/// `StrUnsignedDecimalLiteral`: `1`, `1.`, `.5`, `1.5e-3`; nothing else.
fn is_decimal_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut index = 0;
    let digits = |index: &mut usize| {
        let start = *index;
        while *index < bytes.len() && bytes[*index].is_ascii_digit() {
            *index += 1;
        }
        *index - start
    };
    let whole = digits(&mut index);
    let mut fraction = 0;
    if index < bytes.len() && bytes[index] == b'.' {
        index += 1;
        fraction = digits(&mut index);
    }
    if whole == 0 && fraction == 0 {
        return false;
    }
    if index < bytes.len() && (bytes[index] == b'e' || bytes[index] == b'E') {
        index += 1;
        if index < bytes.len() && (bytes[index] == b'+' || bytes[index] == b'-') {
            index += 1;
        }
        if digits(&mut index) == 0 {
            return false;
        }
    }
    index == bytes.len()
}

/// JavaScript's `WhiteSpace` and `LineTerminator` (what `trim` removes).
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// The own enumerable properties object spread copies out of `value`
/// (`{...value}`): an object's entries, an array's or a string's by index,
/// nothing for `null`, a boolean or a number.
pub fn spread_entries(value: &Value) -> Vec<(String, Value)> {
    match value {
        Value::Object(object) => object
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value.clone()))
            .collect(),
        Value::String(text) => text
            .chars()
            .enumerate()
            .map(|(index, c)| (index.to_string(), Value::String(c.to_string())))
            .collect(),
        Value::Null | Value::Bool(_) | Value::Number(_) => Vec::new(),
    }
}

/// `{...target, ...value}` into `target`.
pub fn spread_into(target: &mut Map<String, Value>, value: &Value) {
    for (key, value) in spread_entries(value) {
        target.insert(key, value);
    }
}

/// `Date.parse(text)` is a finite number, for the ECMAScript date-time
/// string format (`toISOString`'s, and its shorter forms): `YYYY`,
/// `YYYY-MM`, `YYYY-MM-DD`, an expanded `±YYYYYY` year, then optionally
/// `THH:mm`, `:ss`, `.sss`, and `Z` or `±HH:mm`. V8's fallback parser also
/// takes legacy forms (`Oct 27 2026`); the Rust model reads those as
/// invalid, and no Videorc writer produces them.
pub fn date_parses(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut index = 0;
    let fixed = |index: &mut usize, count: usize| -> Option<u32> {
        let slice = bytes.get(*index..*index + count)?;
        if !slice.iter().all(u8::is_ascii_digit) {
            return None;
        }
        *index += count;
        std::str::from_utf8(slice).ok()?.parse().ok()
    };
    let year_ok = match bytes.first() {
        Some(b'+') | Some(b'-') => {
            let negative = bytes[0] == b'-';
            index = 1;
            match fixed(&mut index, 6) {
                // `-000000` is not a year.
                Some(year) => !(negative && year == 0),
                None => false,
            }
        }
        _ => fixed(&mut index, 4).is_some(),
    };
    if !year_ok {
        return false;
    }
    let mut month = 1;
    let mut day = 1;
    if bytes.get(index) == Some(&b'-') {
        index += 1;
        let Some(parsed) = fixed(&mut index, 2) else {
            return false;
        };
        month = parsed;
        if bytes.get(index) == Some(&b'-') {
            index += 1;
            let Some(parsed) = fixed(&mut index, 2) else {
                return false;
            };
            day = parsed;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return false;
    }
    if index == bytes.len() {
        return true;
    }
    if bytes[index] != b'T' && bytes[index] != b't' {
        return false;
    }
    index += 1;
    let Some((hour, minute)) = hours_minutes(bytes, &mut index) else {
        return false;
    };
    let mut second = 0;
    if bytes.get(index) == Some(&b':') {
        index += 1;
        let Some(parsed) = fixed(&mut index, 2) else {
            return false;
        };
        second = parsed;
        if bytes.get(index) == Some(&b'.') {
            index += 1;
            let start = index;
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
            if index == start {
                return false;
            }
        }
    }
    let time_ok =
        (hour < 24 && minute < 60 && second < 60) || (hour == 24 && minute == 0 && second == 0);
    if !time_ok {
        return false;
    }
    match bytes.get(index) {
        None => true,
        Some(b'Z') | Some(b'z') => index + 1 == bytes.len(),
        Some(b'+') | Some(b'-') => {
            index += 1;
            match hours_minutes(bytes, &mut index) {
                Some((offset_hour, offset_minute)) => {
                    index == bytes.len() && offset_hour < 24 && offset_minute < 60
                }
                None => false,
            }
        }
        Some(_) => false,
    }
}

/// `HH:mm` at `index`, moving past it.
fn hours_minutes(bytes: &[u8], index: &mut usize) -> Option<(u32, u32)> {
    let two = |at: usize| -> Option<u32> {
        let slice = bytes.get(at..at + 2)?;
        if !slice.iter().all(u8::is_ascii_digit) {
            return None;
        }
        Some(u32::from(slice[0] - b'0') * 10 + u32::from(slice[1] - b'0'))
    };
    let hour = two(*index)?;
    if bytes.get(*index + 2) != Some(&b':') {
        return None;
    }
    let minute = two(*index + 3)?;
    *index += 5;
    Some((hour, minute))
}

/// `JSON.parse(text)`, or `None` where it throws.
pub fn json_parse(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}

/// What a key family's `getItem` returns for a stored value
/// (`uiSettingsValueAsString`): a string as itself, anything else (written
/// by a newer UI) as its JSON.
pub fn stored_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        other => Some(serde_json::to_string(other).unwrap_or_default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn number_follows_javascript() {
        assert!(to_number(None).is_nan());
        assert_eq!(to_number(Some(&json!(null))), 0.0);
        assert_eq!(to_number(Some(&json!(true))), 1.0);
        assert_eq!(to_number(Some(&json!(" 12 "))), 12.0);
        assert_eq!(to_number(Some(&json!(""))), 0.0);
        assert_eq!(to_number(Some(&json!("0x10"))), 16.0);
        assert_eq!(to_number(Some(&json!("1e3"))), 1000.0);
        assert_eq!(to_number(Some(&json!(".5"))), 0.5);
        assert_eq!(to_number(Some(&json!("-Infinity"))), f64::NEG_INFINITY);
        assert!(to_number(Some(&json!("inf"))).is_nan());
        assert!(to_number(Some(&json!("12px"))).is_nan());
        assert!(to_number(Some(&json!("-0x10"))).is_nan());
        assert_eq!(to_number(Some(&json!([]))), 0.0);
        assert_eq!(to_number(Some(&json!([5]))), 5.0);
        assert_eq!(to_number(Some(&json!(["7"]))), 7.0);
        assert!(to_number(Some(&json!([1, 2]))).is_nan());
        assert!(to_number(Some(&json!({}))).is_nan());
    }

    #[test]
    fn round_and_number_values_follow_javascript() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.499_999_999_999_999_94), 0.0);
        assert_eq!(number_value(100.0), json!(100));
        assert_eq!(number_value(-0.0), json!(0));
        assert_eq!(number_value(0.25), json!(0.25));
        assert_eq!(number_value(f64::NAN), Value::Null);
        assert_eq!(
            clamp_number(Some(&json!("150.6")), 100.0, 100.0, 200.0),
            151.0
        );
        assert_eq!(clamp_number(Some(&json!("x")), 100.0, 100.0, 200.0), 100.0);
        assert_eq!(clamp_number(None, 32.0, 0.0, 96.0), 32.0);
        assert_eq!(clamp_number(Some(&json!(null)), 32.0, 0.0, 96.0), 0.0);
    }

    #[test]
    fn spread_trim_and_dates_follow_javascript() {
        let mut target = Map::new();
        spread_into(&mut target, &json!("ab"));
        assert_eq!(Value::Object(target), json!({"0": "a", "1": "b"}));
        assert_eq!(trim("\u{FEFF} es \u{3000}"), "es");
        assert_eq!(trim("\u{0085}x"), "\u{0085}x");
        for valid in [
            "2026-10-27T12:00:00.000Z",
            "2026-10-27",
            "2026-10",
            "2026",
            "2026-10-27T12:00",
            "2026-10-27T12:00:00+02:00",
            "+002026-10-27T12:00:00Z",
        ] {
            assert!(date_parses(valid), "{valid}");
        }
        for invalid in [
            "",
            "yesterday",
            "2026-13-01",
            "2026-10-27T25:00",
            "2026-10-27 12:00",
            "-000000-01-01",
            "2026-10-27T12:00:00.Z",
        ] {
            assert!(!date_parses(invalid), "{invalid}");
        }
        assert_eq!(
            stored_text(Some(&json!({"a": 1}))).as_deref(),
            Some(r#"{"a":1}"#)
        );
        assert_eq!(stored_text(Some(&json!("dark"))).as_deref(), Some("dark"));
    }
}
