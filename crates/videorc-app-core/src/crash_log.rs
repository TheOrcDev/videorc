//! Backend crash evidence that survives supervisor restarts and app
//! relaunches (`backend-crash-log.ts`): `userData/backend-crashes.json`, the
//! last 5 records, most recent first, each with the dying generation's last
//! 50 stderr lines (400 chars each). Written atomically (temp file + rename).
//! The file is the same shape Electron writes, so a support bundle reads
//! either app's evidence.

use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::log::strip_ansi;

/// Records kept on disk. Five covers the whole restart ladder (5 attempts).
pub const CRASH_LOG_LIMIT: usize = 5;
/// Stderr lines kept per generation for the record.
pub const CRASH_STDERR_TAIL_LINES: usize = 50;
/// Per-line cap so a runaway log line cannot bloat the record.
pub const CRASH_STDERR_LINE_CHARS: usize = 400;

/// One record (`BackendCrashRecord` in `shared/backend.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashRecord {
    /// ISO 8601 UTC.
    pub at: String,
    pub generation: u32,
    /// Written as `null` when absent, as Electron writes it
    /// (`code: number | null`), so either app reads the other's file.
    #[serde(default)]
    pub code: Option<i32>,
    #[serde(default)]
    pub signal: Option<String>,
    /// The restart attempt this exit scheduled, or none (quitting, or the
    /// crash budget is spent).
    #[serde(default)]
    pub attempt: Option<u32>,
    pub uptime_ms: u64,
    pub intentional: bool,
    /// Only on a named Windows crash, so older readers see the same shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows_status: Option<String>,
    pub stderr_tail: Vec<String>,
}

/// Why a backend process ended, as the supervisor can tell it at the exit.
///
/// - `Stopped`: we ended it ourselves (quit, restart).
/// - `Recycled`: nobody asked, but it exited 0 without a signal. The backend
///   only returns 0 from its own ordered shutdown, which it latches to be
///   replaced (a live-control watchdog, device loss): Videorc's own
///   termination, not a crash.
/// - `Crashed`: Windows reported an NTSTATUS crash code.
/// - `Unexpected`: anything else we did not ask for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitCause {
    Stopped,
    Recycled,
    Crashed,
    Unexpected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitClassification {
    pub cause: ExitCause,
    pub intentional: bool,
    pub windows_status: Option<String>,
}

const WINDOWS_CRASH_STATUS_NAMES: &[(u32, &str)] = &[
    (0xc000_0005, "STATUS_ACCESS_VIOLATION"),
    (0xc000_0374, "STATUS_HEAP_CORRUPTION"),
    (0xc000_0409, "STATUS_STACK_BUFFER_OVERRUN"),
    (0xc000_00fd, "STATUS_STACK_OVERFLOW"),
    (0xc000_001d, "STATUS_ILLEGAL_INSTRUCTION"),
    (0xc000_0094, "STATUS_INTEGER_DIVIDE_BY_ZERO"),
    (0x8000_0003, "STATUS_BREAKPOINT"),
];

/// NTSTATUS name for a Windows crash exit code (signed or unsigned), or none.
pub fn windows_crash_status_name(code: Option<i32>, windows: bool) -> Option<String> {
    if !windows {
        return None;
    }
    let code = code? as u32;
    WINDOWS_CRASH_STATUS_NAMES
        .iter()
        .find(|(status, _)| *status == code)
        .map(|(_, name)| (*name).to_string())
}

/// `0xC0000005` for a Windows status code.
pub fn format_windows_status_code(code: i32) -> String {
    format!("0x{:08X}", code as u32)
}

/// `classifyBackendExit`.
pub fn classify_exit(
    marked_by_us: bool,
    code: Option<i32>,
    signal: Option<&str>,
    windows: bool,
) -> ExitClassification {
    let windows_status = windows_crash_status_name(code, windows);
    let cause = if windows_status.is_some() {
        ExitCause::Crashed
    } else if marked_by_us {
        ExitCause::Stopped
    } else if code == Some(0) && signal.is_none() {
        ExitCause::Recycled
    } else {
        ExitCause::Unexpected
    };
    ExitClassification {
        intentional: matches!(cause, ExitCause::Stopped | ExitCause::Recycled),
        cause,
        windows_status,
    }
}

/// Every exit we did not ask for is kept, a recycle included. A stop we asked
/// for that still reports a non-zero code is kept too; a clean or signal-only
/// stop is not.
pub fn should_record_exit(cause: ExitCause, code: Option<i32>) -> bool {
    if cause != ExitCause::Stopped {
        return true;
    }
    matches!(code, Some(code) if code != 0)
}

pub fn truncate_stderr_line(line: &str, max_chars: usize) -> String {
    let count = line.chars().count();
    if count <= max_chars {
        return line.to_string();
    }
    let keep = max_chars.saturating_sub(1);
    let mut out: String = line.chars().take(keep).collect();
    out.push('…');
    out
}

/// The record's stderr tail from the generation's ring: the last 50 lines,
/// paint stripped, 400 chars each.
pub fn stderr_tail_for_record(lines: &[String]) -> Vec<String> {
    let start = lines.len().saturating_sub(CRASH_STDERR_TAIL_LINES);
    lines[start..]
        .iter()
        .map(|line| truncate_stderr_line(&strip_ansi(line), CRASH_STDERR_LINE_CHARS))
        .collect()
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CrashLogFile {
    schema_version: u32,
    records: Vec<CrashRecord>,
}

/// Missing or corrupt evidence never blocks startup: an empty list.
pub fn read_crash_log(path: &Path) -> Vec<CrashRecord> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let records = match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(serde_json::Value::Array(items)) => items,
        Ok(serde_json::Value::Object(object)) => match object.get("records") {
            Some(serde_json::Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    };
    records
        .into_iter()
        .filter_map(|value| serde_json::from_value::<CrashRecord>(value).ok())
        .filter(|record| !record.at.is_empty())
        .take(CRASH_LOG_LIMIT)
        .collect()
}

/// Prepends `record`, keeps the newest 5 and writes atomically. Returns the
/// new list; the caller keeps the in-memory copy when the write fails.
pub fn append_crash_record(
    path: &Path,
    record: CrashRecord,
    existing: &[CrashRecord],
) -> Result<Vec<CrashRecord>> {
    let mut next = Vec::with_capacity(CRASH_LOG_LIMIT);
    next.push(record);
    next.extend(existing.iter().take(CRASH_LOG_LIMIT - 1).cloned());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("could not create {}", parent.display()))?;
    }
    let temp = path.with_extension(format!(
        "json.{}.{}.tmp",
        std::process::id(),
        crate::log::iso8601_utc_now().replace(':', "-")
    ));
    let text = serde_json::to_string_pretty(&CrashLogFile {
        schema_version: 1,
        records: next.clone(),
    })?;
    std::fs::write(&temp, format!("{text}\n"))
        .with_context(|| format!("could not write {}", temp.display()))?;
    std::fs::rename(&temp, path)
        .with_context(|| format!("could not move {} to {}", temp.display(), path.display()))?;
    Ok(next)
}

/// One-line human summary for the log.
pub fn describe_crash_record(record: &CrashRecord) -> String {
    let exit = match (&record.signal, record.code) {
        (Some(signal), _) => format!("signal {signal}"),
        (None, Some(code)) => match &record.windows_status {
            Some(status) => format!("code {} {status}", format_windows_status_code(code)),
            None => format!("code {code}"),
        },
        (None, None) => "unknown exit".to_string(),
    };
    let attempt = record
        .attempt
        .map(|attempt| format!(", restart attempt {attempt}"))
        .unwrap_or_default();
    let intentional = if record.intentional {
        ", intentional"
    } else {
        ""
    };
    format!(
        "generation {} exited ({exit}) after {}{attempt}{intentional}",
        record.generation,
        format_uptime(record.uptime_ms)
    )
}

fn format_uptime(uptime_ms: u64) -> String {
    if uptime_ms < 1_000 {
        format!("{uptime_ms}ms")
    } else if uptime_ms < 60_000 {
        format!("{:.1}s", uptime_ms as f64 / 1_000.0)
    } else {
        format!("{}min", (uptime_ms as f64 / 60_000.0).round() as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(at: &str) -> CrashRecord {
        CrashRecord {
            at: at.to_string(),
            generation: 1,
            code: None,
            signal: Some("SIGKILL".to_string()),
            attempt: Some(1),
            uptime_ms: 1500,
            intentional: false,
            windows_status: None,
            stderr_tail: vec!["boom".to_string()],
        }
    }

    #[test]
    fn classification_mirrors_electron() {
        assert_eq!(
            classify_exit(false, Some(0), None, false).cause,
            ExitCause::Recycled
        );
        assert_eq!(
            classify_exit(false, None, Some("SIGKILL"), false).cause,
            ExitCause::Unexpected
        );
        assert_eq!(
            classify_exit(true, None, Some("SIGTERM"), false).cause,
            ExitCause::Stopped
        );
        let crashed = classify_exit(true, Some(-1_073_741_819), None, true);
        assert_eq!(crashed.cause, ExitCause::Crashed);
        assert_eq!(
            crashed.windows_status.as_deref(),
            Some("STATUS_ACCESS_VIOLATION")
        );
        assert!(!crashed.intentional);
        assert!(!should_record_exit(ExitCause::Stopped, Some(0)));
        assert!(!should_record_exit(ExitCause::Stopped, None));
        assert!(should_record_exit(ExitCause::Stopped, Some(1)));
        assert!(should_record_exit(ExitCause::Recycled, Some(0)));
        assert_eq!(format_windows_status_code(-1_073_741_819), "0xC0000005");
    }

    #[test]
    fn append_keeps_five_newest_first_and_writes_absent_options_as_null() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deep").join("backend-crashes.json");
        let mut records = Vec::new();
        for index in 0..7 {
            records = append_crash_record(&path, record(&format!("t{index}")), &records).unwrap();
        }
        assert_eq!(records.len(), CRASH_LOG_LIMIT);
        assert_eq!(records[0].at, "t6");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"schemaVersion\": 1"));
        assert!(
            text.contains("\"code\": null"),
            "an absent code is written as null, as Electron does"
        );
        assert!(!text.contains("windowsStatus"));
        let read = read_crash_log(&path);
        assert_eq!(read, records);
        assert!(
            std::fs::read_dir(path.parent().unwrap())
                .unwrap()
                .all(|entry| !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".tmp"))
        );
    }

    #[test]
    fn read_accepts_electron_shape_and_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("backend-crashes.json");
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,"records":[{"at":"x","generation":2,"code":null,"signal":null,"attempt":null,"uptimeMs":5,"intentional":true,"stderrTail":["a"]}]}"#,
        )
        .unwrap();
        let read = read_crash_log(&path);
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].generation, 2);
        assert_eq!(read[0].code, None);
        std::fs::write(&path, "not json").unwrap();
        assert!(read_crash_log(&path).is_empty());
        assert!(read_crash_log(&dir.path().join("missing.json")).is_empty());
    }

    #[test]
    fn stderr_tail_is_bounded_and_described() {
        let lines: Vec<String> = (0..80).map(|index| format!("line {index}")).collect();
        let tail = stderr_tail_for_record(&lines);
        assert_eq!(tail.len(), CRASH_STDERR_TAIL_LINES);
        assert_eq!(tail[0], "line 30");
        let long = "x".repeat(500);
        assert_eq!(
            truncate_stderr_line(&long, CRASH_STDERR_LINE_CHARS)
                .chars()
                .count(),
            CRASH_STDERR_LINE_CHARS
        );
        assert_eq!(
            describe_crash_record(&record("t")),
            "generation 1 exited (signal SIGKILL) after 1.5s, restart attempt 1"
        );
        assert_eq!(format_uptime(500), "500ms");
        assert_eq!(format_uptime(120_000), "2min");
    }
}
