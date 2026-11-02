//! The last screen and camera capture log lines (plan 213 F3), for the
//! support bundle's Displays section. Only the capture modules' lines are
//! kept, never the whole log: other modules may log chat or window titles.

use std::collections::VecDeque;
use std::fmt::Write as _;
use std::sync::{Arc, Mutex, OnceLock};

use chrono::{SecondsFormat, Utc};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer};

/// How many capture lines the support bundle carries.
pub const CAPTURE_LOG_LINES: usize = 200;

const CAPTURE_TARGETS: [&str; 4] = [
    "videorc_backend::screen_capture",
    "videorc_backend::preview_screen",
    "videorc_backend::camera_capture",
    "videorc_backend::preview_camera",
];

#[derive(Debug, Clone, Default)]
pub struct CaptureLog {
    lines: Arc<Mutex<VecDeque<String>>>,
}

impl CaptureLog {
    /// The kept lines, oldest first.
    pub fn lines(&self) -> Vec<String> {
        self.lines
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .cloned()
            .collect()
    }

    fn push(&self, line: String) {
        let mut lines = self.lines.lock().unwrap_or_else(|p| p.into_inner());
        if lines.len() == CAPTURE_LOG_LINES {
            lines.pop_front();
        }
        lines.push_back(line);
    }
}

/// The backend's capture log, which `layer()` feeds.
pub fn global() -> &'static CaptureLog {
    static LOG: OnceLock<CaptureLog> = OnceLock::new();
    LOG.get_or_init(CaptureLog::default)
}

/// The layer that feeds the backend's capture log.
pub fn layer() -> CaptureLogLayer {
    CaptureLogLayer {
        log: global().clone(),
    }
}

/// Whether a tracing target is one of the capture modules or inside one.
pub fn is_capture_target(target: &str) -> bool {
    CAPTURE_TARGETS.iter().any(|capture| {
        target
            .strip_prefix(capture)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with("::"))
    })
}

pub struct CaptureLogLayer {
    log: CaptureLog,
}

impl<S: Subscriber> Layer<S> for CaptureLogLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let metadata = event.metadata();
        if !is_capture_target(metadata.target()) {
            return;
        }
        let mut line = LineVisitor::default();
        event.record(&mut line);
        self.log.push(format!(
            "{} {} {}: {}{}",
            Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            metadata.level(),
            metadata.target(),
            line.message,
            line.fields
        ));
    }
}

#[derive(Default)]
struct LineVisitor {
    message: String,
    fields: String,
}

impl Visit for LineVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message.push_str(value);
        } else {
            let _ = write!(self.fields, " {}={value:?}", field.name());
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.message, "{value:?}");
        } else {
            let _ = write!(self.fields, " {}={value:?}", field.name());
        }
    }
}

#[cfg(test)]
mod tests {
    use tracing_subscriber::layer::SubscriberExt;

    use super::*;

    fn capture(log: &CaptureLog, emit: impl FnOnce()) {
        let subscriber = tracing_subscriber::registry().with(CaptureLogLayer { log: log.clone() });
        tracing::subscriber::with_default(subscriber, emit);
    }

    #[test]
    fn only_the_screen_and_camera_capture_modules_are_kept() {
        let log = CaptureLog::default();
        capture(&log, || {
            tracing::info!(target: "videorc_backend::preview_screen", "display resized to {}x{}", 2560, 1440);
            tracing::warn!(target: "videorc_backend::screen_capture::macos", source_id = "screen:screencapturekit:2", "listing slow");
            tracing::info!(target: "videorc_backend::preview_camera", "camera live");
            tracing::info!(target: "videorc_backend::camera_capture", "camera opened");
            tracing::info!(target: "videorc_backend::live_chat", "chat from viewer");
            tracing::info!(target: "videorc_backend::app_windows", "window Secret Plans.key");
            tracing::info!(target: "videorc_backend::preview_screenshot", "not a capture module");
        });

        let lines = log.lines();
        assert_eq!(lines.len(), 4, "{lines:?}");
        assert!(
            lines[0]
                .ends_with("INFO videorc_backend::preview_screen: display resized to 2560x1440")
        );
        assert!(lines[1].ends_with(
            "WARN videorc_backend::screen_capture::macos: listing slow source_id=\"screen:screencapturekit:2\""
        ));
        assert!(lines.iter().all(|line| !line.contains("chat from viewer")));
        assert!(lines.iter().all(|line| !line.contains("Secret Plans")));
    }

    #[test]
    fn the_capture_log_keeps_its_last_lines_only() {
        let log = CaptureLog::default();
        capture(&log, || {
            for index in 0..CAPTURE_LOG_LINES + 25 {
                tracing::info!(target: "videorc_backend::preview_screen", "line {index}");
            }
        });

        let lines = log.lines();
        assert_eq!(lines.len(), CAPTURE_LOG_LINES);
        assert!(lines[0].ends_with(": line 25"));
        assert!(
            lines[CAPTURE_LOG_LINES - 1].ends_with(&format!(": line {}", CAPTURE_LOG_LINES + 24))
        );
    }
}
