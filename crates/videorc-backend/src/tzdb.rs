//! Time zone rules for wall times people type and read (scheduled streams,
//! YouTube's Pacific quota day). They come from the IANA data bundled into the
//! binary, never the OS copy: every platform must turn the same wall time into
//! the same instant, and an OS (or Electron's ICU) can lag the law by years.
use std::sync::LazyLock;

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Duration, Utc};
use jiff::Timestamp;
use jiff::tz::{TimeZone, TimeZoneDatabase};
use serde::Serialize;
use serde_json::Value;

static BUNDLED: LazyLock<TimeZoneDatabase> = LazyLock::new(TimeZoneDatabase::bundled);

/// An IANA zone from the bundled data.
pub fn zone(name: &str) -> Result<TimeZone> {
    BUNDLED
        .get(name)
        .map_err(|_| anyhow::anyhow!("Choose a valid IANA time zone."))
}

pub fn timestamp(utc: DateTime<Utc>) -> Result<Timestamp> {
    Timestamp::new(utc.timestamp(), utc.timestamp_subsec_nanos() as i32)
        .context("The time is out of range.")
}

pub fn utc(timestamp: Timestamp) -> Result<DateTime<Utc>> {
    let nanos = i64::try_from(timestamp.as_nanosecond()).context("The time is out of range.")?;
    Ok(DateTime::from_timestamp_nanos(nanos))
}

/// The zone's UTC offset at an instant, in minutes (Vancouver from 2026-11: -420).
pub fn offset_minutes_at(utc: DateTime<Utc>, zone: &TimeZone) -> Result<i32> {
    Ok(zone.to_offset(timestamp(utc)?).seconds() / 60)
}

/// How far around now `time.localOffsets` reaches by default: far enough for
/// "Kept until" dates and a row from last year, short enough to stay tiny.
const LOCAL_OFFSETS_REACH_DAYS: i64 = 3 * 366;
/// No zone changes its offset this often; a bound on a hostile window.
const LOCAL_OFFSETS_MAX_SPANS: usize = 256;

/// One stretch of a zone's UTC offset, from `from_ms` until the next span.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OffsetSpan {
    pub from_ms: i64,
    pub offset_minutes: i32,
}

/// The zone's offsets from `from` to `until`: the first span starts at
/// `from`, then one per change of offset (an abbreviation-only change is not
/// a span).
pub fn offset_spans(
    zone_name: &str,
    from: DateTime<Utc>,
    until: DateTime<Utc>,
) -> Result<Vec<OffsetSpan>> {
    if until <= from {
        bail!("The window must end after it starts.");
    }
    let zone = zone(zone_name)?;
    let start = timestamp(from)?;
    let end = timestamp(until)?;
    let mut spans = vec![OffsetSpan {
        from_ms: start.as_millisecond(),
        offset_minutes: zone.to_offset(start).seconds() / 60,
    }];
    for transition in zone.following(start) {
        if transition.timestamp() >= end || spans.len() >= LOCAL_OFFSETS_MAX_SPANS {
            break;
        }
        let offset_minutes = transition.offset().seconds() / 60;
        if spans
            .last()
            .is_some_and(|span| span.offset_minutes == offset_minutes)
        {
            continue;
        }
        spans.push(OffsetSpan {
            from_ms: transition.timestamp().as_millisecond(),
            offset_minutes,
        });
    }
    Ok(spans)
}

/// `time.localOffsets`: the renderer's zone from the bundled data, so local
/// times read right while Electron's ICU data lags IANA.
pub fn local_offsets(params: &Value, now: DateTime<Utc>) -> Result<Value> {
    let time_zone = params["timeZone"]
        .as_str()
        .context("timeZone is required.")?;
    let reach = Duration::days(LOCAL_OFFSETS_REACH_DAYS);
    let at = |key: &str, default: DateTime<Utc>| -> Result<DateTime<Utc>> {
        match params[key].as_str() {
            Some(value) => Ok(DateTime::parse_from_rfc3339(value)
                .with_context(|| format!("{key} must be an RFC 3339 time."))?
                .with_timezone(&Utc)),
            None => Ok(default),
        }
    };
    let spans = offset_spans(
        time_zone,
        at("fromUtc", now - reach)?,
        at("untilUtc", now + reach)?,
    )?;
    Ok(serde_json::json!({ "timeZone": time_zone, "spans": spans }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn vancouver_stops_changing_its_clocks_after_november_2026() {
        let spans = offset_spans(
            "America/Vancouver",
            utc("2026-01-01T00:00:00Z"),
            utc("2028-01-01T00:00:00Z"),
        )
        .unwrap();
        assert_eq!(
            spans,
            vec![
                OffsetSpan {
                    from_ms: utc("2026-01-01T00:00:00Z").timestamp_millis(),
                    offset_minutes: -480,
                },
                OffsetSpan {
                    from_ms: utc("2026-03-08T10:00:00Z").timestamp_millis(),
                    offset_minutes: -420,
                },
            ]
        );
    }

    #[test]
    fn madrid_keeps_its_summer_time_spans() {
        let spans = offset_spans(
            "Europe/Madrid",
            utc("2026-01-01T00:00:00Z"),
            utc("2027-01-01T00:00:00Z"),
        )
        .unwrap();
        let offsets: Vec<i32> = spans.iter().map(|span| span.offset_minutes).collect();
        assert_eq!(offsets, vec![60, 120, 60]);
        assert_eq!(
            spans[1].from_ms,
            utc("2026-03-29T01:00:00Z").timestamp_millis()
        );
        assert_eq!(
            spans[2].from_ms,
            utc("2026-10-25T01:00:00Z").timestamp_millis()
        );
    }

    #[test]
    fn local_offsets_reads_its_params_and_refuses_bad_ones() {
        let now = utc("2026-12-15T12:00:00Z");
        let value = local_offsets(&serde_json::json!({"timeZone": "UTC"}), now).unwrap();
        assert_eq!(value["timeZone"], "UTC");
        assert_eq!(value["spans"].as_array().unwrap().len(), 1);
        assert_eq!(value["spans"][0]["offsetMinutes"], 0);
        assert!(local_offsets(&serde_json::json!({"timeZone": "Mars/Base"}), now).is_err());
        assert!(local_offsets(&serde_json::json!({}), now).is_err());
        assert!(
            local_offsets(
                &serde_json::json!({
                    "timeZone": "UTC",
                    "fromUtc": "2027-01-01T00:00:00Z",
                    "untilUtc": "2026-01-01T00:00:00Z"
                }),
                now
            )
            .is_err()
        );
    }
}
