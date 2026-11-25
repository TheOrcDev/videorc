//! The updater's own log.
//!
//! A packaged build has no console, so before the shipping repo had this
//! log every updater line went nowhere, and a support bundle could not say
//! why an update kept failing (Windows field report, 2026-11-10: every
//! 0.21.0 download was thrown away by a timed-out signature check, and the
//! bundle had no trace). The last lines ride into the support bundle; each
//! line also goes to a sink, which the app points at its rotating log.
//!
//! A port of `updater-log.ts` with its tests. Two things differ. A line
//! here is text already, so the original's rendering of errors and objects
//! is not needed, and `electron-updater`'s debug lines, which the original
//! drops, have no method at all. The cap counts characters, where the
//! original counts UTF-16 units.

use std::collections::VecDeque;
use std::io;
use std::time::{SystemTime, UNIX_EPOCH};

/// How many lines are kept.
pub const UPDATER_LOG_CAPACITY: usize = 40;
/// A line longer than this is cut, and ends in an ellipsis.
pub const UPDATER_LOG_MESSAGE_MAX_CHARS: usize = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdaterLogLevel {
    Info,
    Warn,
    Error,
}

impl UpdaterLogLevel {
    /// The level as the support bundle spells it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

/// One kept line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdaterLogEntry {
    /// An ISO timestamp in UTC, to the millisecond.
    pub at: String,
    pub level: UpdaterLogLevel,
    pub message: String,
}

/// A line as it is kept: on one line, trimmed, and capped.
pub fn updater_log_message(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= UPDATER_LOG_MESSAGE_MAX_CHARS {
        return flat;
    }
    let mut cut: String = flat
        .chars()
        .take(UPDATER_LOG_MESSAGE_MAX_CHARS - 1)
        .collect();
    cut.push('…');
    cut
}

/// Milliseconds since 1970 as `2026-11-11T04:00:01.000Z`.
pub fn iso_timestamp(unix_ms: u64) -> String {
    let millis = unix_ms % 1000;
    let seconds = unix_ms / 1000;
    let (hour, minute, second) = ((seconds / 3600) % 24, (seconds / 60) % 60, seconds % 60);
    // Days to a civil date, in the proleptic Gregorian calendar (Howard
    // Hinnant's `civil_from_days`), for days on or after 1970-01-01.
    let days = seconds / 86_400 + 719_468;
    let era = days / 146_097;
    let day_of_era = days % 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn system_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// The log's clock: milliseconds since 1970.
pub type UpdaterLogClock = Box<dyn FnMut() -> u64 + Send>;
/// Where each line also goes. A sink that fails is ignored.
pub type UpdaterLogSink = Box<dyn FnMut(UpdaterLogLevel, &str) -> io::Result<()> + Send>;

/// The last lines the updater said, oldest first.
pub struct UpdaterLog {
    capacity: usize,
    entries: VecDeque<UpdaterLogEntry>,
    now_ms: UpdaterLogClock,
    sink: UpdaterLogSink,
}

impl Default for UpdaterLog {
    fn default() -> Self {
        Self::new()
    }
}

impl UpdaterLog {
    /// A log of [`UPDATER_LOG_CAPACITY`] lines on the system clock, with no
    /// sink yet.
    pub fn new() -> Self {
        Self::with(
            UPDATER_LOG_CAPACITY,
            Box::new(system_now_ms),
            Box::new(|_, _| Ok(())),
        )
    }

    /// A log with its own size, clock (milliseconds since 1970) and sink.
    pub fn with(capacity: usize, now_ms: UpdaterLogClock, sink: UpdaterLogSink) -> Self {
        Self {
            capacity: capacity.max(1),
            entries: VecDeque::new(),
            now_ms,
            sink,
        }
    }

    pub fn info(&mut self, message: &str) {
        self.record(UpdaterLogLevel::Info, message);
    }

    pub fn warn(&mut self, message: &str) {
        self.record(UpdaterLogLevel::Warn, message);
    }

    pub fn error(&mut self, message: &str) {
        self.record(UpdaterLogLevel::Error, message);
    }

    /// Where each line also goes from now on.
    pub fn set_sink(&mut self, sink: UpdaterLogSink) {
        self.sink = sink;
    }

    /// The kept lines, oldest first, as copies.
    pub fn snapshot(&self) -> Vec<UpdaterLogEntry> {
        self.entries.iter().cloned().collect()
    }

    fn record(&mut self, level: UpdaterLogLevel, raw: &str) {
        let message = updater_log_message(raw);
        if message.is_empty() {
            return;
        }
        let at = iso_timestamp((self.now_ms)());
        self.entries.push_back(UpdaterLogEntry {
            at,
            level,
            message: message.clone(),
        });
        while self.entries.len() > self.capacity {
            self.entries.pop_front();
        }
        // A broken sink must never break an update.
        let _ = (self.sink)(level, &message);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    type Seen = Arc<Mutex<Vec<(UpdaterLogLevel, String)>>>;

    fn recording_sink() -> (Seen, UpdaterLogSink) {
        let seen: Seen = Arc::default();
        let writer = Arc::clone(&seen);
        let sink: UpdaterLogSink = Box::new(move |level, message| {
            writer.lock().unwrap().push((level, message.to_string()));
            Ok(())
        });
        (seen, sink)
    }

    #[test]
    fn keeps_the_last_lines_oldest_first_and_hands_each_to_the_sink() {
        let (seen, sink) = recording_sink();
        // 2026-11-11T04:00:00Z, then one second later for each line.
        let mut tick = 0;
        let clock: UpdaterLogClock = Box::new(move || {
            tick += 1;
            1_794_369_600_000 + (tick - 1) * 1000
        });
        let mut log = UpdaterLog::with(2, clock, sink);
        log.info("Checking for update");
        log.warn("background download failed: boom");
        log.error("Command failed");

        assert_eq!(
            log.snapshot(),
            vec![
                UpdaterLogEntry {
                    at: "2026-11-11T04:00:01.000Z".to_string(),
                    level: UpdaterLogLevel::Warn,
                    message: "background download failed: boom".to_string(),
                },
                UpdaterLogEntry {
                    at: "2026-11-11T04:00:02.000Z".to_string(),
                    level: UpdaterLogLevel::Error,
                    message: "Command failed".to_string(),
                },
            ]
        );
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 3);
        assert_eq!(
            seen.last(),
            Some(&(UpdaterLogLevel::Error, "Command failed".to_string()))
        );
    }

    #[test]
    fn drops_empty_lines() {
        let (seen, sink) = recording_sink();
        let mut log = UpdaterLog::with(UPDATER_LOG_CAPACITY, Box::new(|| 0), sink);
        log.info("");
        log.info("  \n\t ");
        assert_eq!(log.snapshot(), vec![]);
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn switches_sinks_and_survives_a_sink_that_fails() {
        let mut log = UpdaterLog::new();
        log.set_sink(Box::new(|_, _| Err(io::Error::other("disk full"))));
        log.warn("still kept");
        let (seen, sink) = recording_sink();
        log.set_sink(sink);
        log.info("and the next sink hears the next line");
        let messages: Vec<String> = log
            .snapshot()
            .into_iter()
            .map(|entry| entry.message)
            .collect();
        assert_eq!(
            messages,
            ["still kept", "and the next sink hears the next line"]
        );
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn flattens_multi_line_messages_and_caps_their_length() {
        assert_eq!(updater_log_message("a\n  b\r\nc"), "a b c");
        assert_eq!(updater_log_message("  one line  "), "one line");
        let long = updater_log_message(&"x".repeat(5000));
        assert_eq!(long.chars().count(), UPDATER_LOG_MESSAGE_MAX_CHARS);
        assert!(long.ends_with('…'));
        // Exactly at the cap, nothing is cut.
        let exact = "y".repeat(UPDATER_LOG_MESSAGE_MAX_CHARS);
        assert_eq!(updater_log_message(&exact), exact);
        // A wide character is one character, never half of one.
        let wide = updater_log_message(&"é".repeat(700));
        assert_eq!(wide.chars().count(), UPDATER_LOG_MESSAGE_MAX_CHARS);
    }

    #[test]
    fn returns_copies_from_snapshot() {
        let mut log = UpdaterLog::new();
        log.info("one");
        let mut first = log.snapshot();
        first[0].message = "changed".to_string();
        assert_eq!(log.snapshot()[0].message, "one");
    }

    #[test]
    fn keeps_forty_lines_by_default() {
        let mut log = UpdaterLog::new();
        for line in 0..45 {
            log.info(&format!("line {line}"));
        }
        let kept = log.snapshot();
        assert_eq!(kept.len(), UPDATER_LOG_CAPACITY);
        assert_eq!(kept[0].message, "line 5");
        assert_eq!(kept[39].message, "line 44");
    }

    #[test]
    fn spells_the_levels_as_the_support_bundle_does() {
        assert_eq!(UpdaterLogLevel::Info.as_str(), "info");
        assert_eq!(UpdaterLogLevel::Warn.as_str(), "warn");
        assert_eq!(UpdaterLogLevel::Error.as_str(), "error");
    }

    #[test]
    fn writes_utc_timestamps_to_the_millisecond() {
        assert_eq!(iso_timestamp(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_timestamp(1_794_369_600_000), "2026-11-11T04:00:00.000Z");
        assert_eq!(iso_timestamp(1_794_369_601_042), "2026-11-11T04:00:01.042Z");
        // A leap day, the last second of a year and the first of the next.
        assert_eq!(iso_timestamp(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
        assert_eq!(iso_timestamp(1_798_761_599_999), "2026-12-31T23:59:59.999Z");
        assert_eq!(iso_timestamp(1_798_761_600_000), "2027-01-01T00:00:00.000Z");
        assert_eq!(iso_timestamp(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }
}
