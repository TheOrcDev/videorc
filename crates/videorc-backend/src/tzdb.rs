//! Time zone rules for wall times people type and read (scheduled streams,
//! YouTube's Pacific quota day). They come from the IANA data bundled into the
//! binary, never the OS copy: every platform must turn the same wall time into
//! the same instant, and an OS (or Electron's ICU) can lag the law by years.
use std::sync::LazyLock;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use jiff::Timestamp;
use jiff::tz::{TimeZone, TimeZoneDatabase};

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
