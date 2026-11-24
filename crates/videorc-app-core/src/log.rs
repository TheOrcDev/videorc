//! The app log: Electron main's `logBackend` and `RotatingLogFile`
//! (`backend-log-file.ts`). Every backend stderr line and every supervisor
//! lifecycle line goes to `userData/logs/backend.log` as
//! `<ISO timestamp> [<level>] <message>`, kept at 2 files of 2 MB
//! (`VIDEORC_BACKEND_LOG_MAX_BYTES` / `VIDEORC_BACKEND_LOG_MAX_FILES`, clamped
//! to 100 MB and 20), to this process's stderr as `[backend:<level>]
//! <message>`, and into a 200-line memory ring for the support bundle.
//!
//! Writes are synchronous appends: a sync write is the only kind guaranteed
//! to land before a crash takes the process down.

use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const LOG_FILE_MAX_BYTES: u64 = 2 * 1024 * 1024;
pub const LOG_FILE_MAX_FILES: usize = 2;
pub const LOG_FILE_MAX_BYTES_LIMIT: u64 = 100 * 1024 * 1024;
pub const LOG_FILE_MAX_FILES_LIMIT: usize = 20;
const MEMORY_LINES: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }

    /// Electron's `inferBackendLogLevel`: tracing's fmt layer puts ` ERROR `
    /// and ` WARN ` in the line.
    pub fn infer(line: &str) -> Self {
        if line.contains(" ERROR ") {
            Level::Error
        } else if line.contains(" WARN ") {
            Level::Warn
        } else {
            Level::Info
        }
    }
}

/// One line kept in memory (`BackendLogEvent` in the renderer contract).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogLine {
    pub level: Level,
    pub message: String,
    pub timestamp: String,
}

/// The file budget (`backendLogFileLimitsFromEnv`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LogFileLimits {
    pub max_bytes: u64,
    pub max_files: usize,
}

impl Default for LogFileLimits {
    fn default() -> Self {
        Self {
            max_bytes: LOG_FILE_MAX_BYTES,
            max_files: LOG_FILE_MAX_FILES,
        }
    }
}

impl LogFileLimits {
    /// Anything unset, non-numeric or below 1 keeps the default; values are
    /// clamped to 100 MB and 20 files.
    pub fn from_env(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let default = Self::default();
        Self {
            max_bytes: bounded(
                lookup("VIDEORC_BACKEND_LOG_MAX_BYTES"),
                default.max_bytes,
                LOG_FILE_MAX_BYTES_LIMIT,
            ),
            max_files: bounded(
                lookup("VIDEORC_BACKEND_LOG_MAX_FILES"),
                default.max_files as u64,
                LOG_FILE_MAX_FILES_LIMIT as u64,
            ) as usize,
        }
    }
}

fn bounded(raw: Option<String>, fallback: u64, ceiling: u64) -> u64 {
    let Some(text) = raw else {
        return fallback;
    };
    let text = text.trim();
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return fallback;
    }
    match text.parse::<u64>() {
        Ok(value) if value >= 1 => value.min(ceiling),
        _ => fallback,
    }
}

/// tracing colours stderr with ANSI SGR sequences; the file and the crash
/// record keep the words and drop the paint.
pub fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            // Parameters: digits and semicolons, then the final `m`.
            let mut rest = chars.clone();
            let mut consumed = 0;
            let mut matched = false;
            for next in rest.by_ref() {
                consumed += 1;
                if next.is_ascii_digit() || next == ';' {
                    continue;
                }
                matched = next == 'm';
                break;
            }
            if matched {
                for _ in 0..consumed {
                    chars.next();
                }
                continue;
            }
            out.push(ch);
            out.push('[');
            continue;
        }
        out.push(ch);
    }
    out
}

/// `formatBackendLogFileLine`: one line, newlines inside the message escaped.
pub fn format_file_line(level: Level, message: &str, timestamp: &str) -> String {
    let message = strip_ansi(message)
        .replace("\r\n", "\\n")
        .replace('\n', "\\n");
    format!("{timestamp} [{}] {message}\n", level.as_str())
}

/// Rotating on-disk sink: `path`, `path.1`, … `path.<max_files - 1>`.
pub struct RotatingLogFile {
    path: PathBuf,
    limits: LogFileLimits,
    current_bytes: Option<u64>,
    disabled: bool,
}

impl RotatingLogFile {
    pub fn new(path: PathBuf, limits: LogFileLimits) -> Self {
        Self {
            path,
            limits: LogFileLimits {
                max_bytes: limits.max_bytes.max(1),
                max_files: limits.max_files.max(1),
            },
            current_bytes: None,
            disabled: false,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The files this sink owns, newest first.
    pub fn rotated_paths(&self) -> Vec<PathBuf> {
        let mut paths = vec![self.path.clone()];
        for index in 1..self.limits.max_files {
            paths.push(PathBuf::from(format!("{}.{index}", self.path.display())));
        }
        paths
    }

    /// Appends one line; the first failure disables the sink and is returned,
    /// so a broken disk never turns every log line into a second error.
    pub fn write(&mut self, line: &str) -> std::io::Result<()> {
        if self.disabled || line.is_empty() {
            return Ok(());
        }
        match self.try_write(line) {
            Ok(()) => Ok(()),
            Err(error) => {
                self.disabled = true;
                Err(error)
            }
        }
    }

    fn try_write(&mut self, line: &str) -> std::io::Result<()> {
        if self.current_bytes.is_none() {
            if let Some(parent) = self.path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            self.current_bytes = Some(
                std::fs::metadata(&self.path)
                    .map(|meta| meta.len())
                    .unwrap_or(0),
            );
        }
        let bytes = line.len() as u64;
        let current = self.current_bytes.unwrap_or(0);
        if current > 0 && current + bytes > self.limits.max_bytes {
            self.rotate()?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        file.write_all(line.as_bytes())?;
        self.current_bytes = Some(self.current_bytes.unwrap_or(0) + bytes);
        Ok(())
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        let paths = self.rotated_paths();
        // Drop the oldest, shift the rest up by one, then free the live name.
        if let Some(oldest) = paths.last() {
            let _ = std::fs::remove_file(oldest);
        }
        for index in (2..paths.len()).rev() {
            // A missing intermediate file just means fewer rotations so far.
            let _ = std::fs::rename(&paths[index - 1], &paths[index]);
        }
        if paths.len() > 1 {
            // The live file must move: a failed rename here propagates so the
            // sink disables itself instead of growing one file forever.
            std::fs::rename(&paths[0], &paths[1])?;
        }
        self.current_bytes = Some(0);
        Ok(())
    }
}

struct LoggerInner {
    file: Option<RotatingLogFile>,
    recent: VecDeque<LogLine>,
    echo: bool,
    file_error: Option<String>,
}

/// The shared app logger (`logBackend`): file, memory ring and stderr.
#[derive(Clone)]
pub struct Logger {
    inner: Arc<Mutex<LoggerInner>>,
}

impl Logger {
    /// Writes to `file` (when given) and echoes to stderr when `echo`.
    pub fn new(file: Option<RotatingLogFile>, echo: bool) -> Self {
        Self {
            inner: Arc::new(Mutex::new(LoggerInner {
                file,
                recent: VecDeque::with_capacity(MEMORY_LINES),
                echo,
                file_error: None,
            })),
        }
    }

    /// Memory only, silent: for tests and tools.
    pub fn silent() -> Self {
        Self::new(None, false)
    }

    pub fn info(&self, message: impl AsRef<str>) {
        self.log(Level::Info, message.as_ref());
    }

    pub fn warn(&self, message: impl AsRef<str>) {
        self.log(Level::Warn, message.as_ref());
    }

    pub fn error(&self, message: impl AsRef<str>) {
        self.log(Level::Error, message.as_ref());
    }

    pub fn log(&self, level: Level, message: &str) {
        let timestamp = iso8601_utc_now();
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if inner.recent.len() == MEMORY_LINES {
            inner.recent.pop_front();
        }
        inner.recent.push_back(LogLine {
            level,
            message: message.to_string(),
            timestamp: timestamp.clone(),
        });
        if let Some(file) = inner.file.as_mut()
            && let Err(error) = file.write(&format_file_line(level, message, &timestamp))
        {
            let text = format!("app log file {} failed: {error}", file.path().display());
            eprintln!("[backend:error] {text}");
            inner.file_error = Some(text);
        }
        if inner.echo {
            eprintln!("[backend:{}] {}", level.as_str(), strip_ansi(message));
        }
    }

    /// The last 200 lines.
    pub fn recent(&self) -> Vec<LogLine> {
        self.inner
            .lock()
            .map(|inner| inner.recent.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Why the file sink disabled itself, once it has.
    pub fn file_error(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.file_error.clone())
    }

    pub fn file_path(&self) -> Option<PathBuf> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.file.as_ref().map(|file| file.path().to_path_buf()))
    }
}

/// `2026-11-08T12:34:56.789Z`, like JavaScript's `Date#toISOString`.
pub fn iso8601_utc_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    iso8601_utc(now.as_secs(), now.subsec_millis())
}

/// Civil date from days since the epoch (Howard Hinnant's algorithm).
pub fn iso8601_utc(unix_seconds: u64, millis: u32) -> String {
    let days = (unix_seconds / 86_400) as i64;
    let secs_of_day = unix_seconds % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        secs_of_day / 3_600,
        (secs_of_day % 3_600) / 60,
        secs_of_day % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_matches_javascript() {
        assert_eq!(iso8601_utc(0, 0), "1970-01-01T00:00:00.000Z");
        // 2026-11-08T12:34:56.789Z
        assert_eq!(iso8601_utc(1_794_141_296, 789), "2026-11-08T12:34:56.789Z");
        // A leap day.
        assert_eq!(iso8601_utc(1_709_164_800, 0), "2024-02-29T00:00:00.000Z");
    }

    #[test]
    fn ansi_paint_is_stripped_and_newlines_escaped() {
        assert_eq!(strip_ansi("\u{1b}[31mERROR\u{1b}[0m boom"), "ERROR boom");
        assert_eq!(strip_ansi("plain"), "plain");
        assert_eq!(
            format_file_line(Level::Warn, "a\nb", "T"),
            "T [warn] a\\nb\n"
        );
        assert_eq!(Level::infer("2026 WARN thing"), Level::Warn);
        assert_eq!(Level::infer("2026 ERROR thing"), Level::Error);
        assert_eq!(Level::infer("fine"), Level::Info);
    }

    #[test]
    fn limits_from_env_clamp_and_fall_back() {
        let limits = LogFileLimits::from_env(|name| match name {
            "VIDEORC_BACKEND_LOG_MAX_BYTES" => Some("999999999999".to_string()),
            "VIDEORC_BACKEND_LOG_MAX_FILES" => Some("abc".to_string()),
            _ => None,
        });
        assert_eq!(limits.max_bytes, LOG_FILE_MAX_BYTES_LIMIT);
        assert_eq!(limits.max_files, LOG_FILE_MAX_FILES);
        let zero = LogFileLimits::from_env(|_| Some("0".to_string()));
        assert_eq!(zero, LogFileLimits::default());
    }

    #[test]
    fn file_rotates_at_the_budget() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs").join("backend.log");
        let mut file = RotatingLogFile::new(
            path.clone(),
            LogFileLimits {
                max_bytes: 40,
                max_files: 2,
            },
        );
        for index in 0..6 {
            file.write(&format!("line number {index}\n")).unwrap();
        }
        let live = std::fs::read_to_string(&path).unwrap();
        let rotated = std::fs::read_to_string(format!("{}.1", path.display())).unwrap();
        assert!(live.len() <= 40, "live file over budget: {live:?}");
        assert!(rotated.contains("line number"));
        assert!(live.ends_with("line number 5\n"));
        assert_eq!(file.rotated_paths().len(), 2);
    }

    #[test]
    fn logger_keeps_recent_lines_and_writes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("backend.log");
        let logger = Logger::new(
            Some(RotatingLogFile::new(path.clone(), LogFileLimits::default())),
            false,
        );
        logger.info("hello");
        logger.warn("careful");
        let recent = logger.recent();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[1].level, Level::Warn);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("[info] hello\n"));
        assert!(text.contains("[warn] careful\n"));
        assert!(logger.file_error().is_none());
    }
}
