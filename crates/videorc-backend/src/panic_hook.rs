//! Structured panic reporting for the supervisor.
//!
//! Electron owns this process's stderr and keeps the last lines of a dying
//! generation in `backend-crashes.json` (desktop `backend-crash-log.ts`). The
//! default Rust hook prints a multi-line, human-shaped message; this hook
//! prints ONE machine-readable JSON line first so the crash record carries
//! the panic message, location, and thread even when everything after it is
//! cut off, then defers to the default hook so unwind/abort semantics,
//! `RUST_BACKTRACE`, and test harness output stay exactly as before.

use std::io::Write;
use std::panic::PanicHookInfo;

/// Install the structured hook. Call once, before tracing is initialised, so
/// a panic inside subscriber setup is still reported.
pub fn install() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let line = format_panic_line(
            &panic_message(info),
            panic_location(info).as_deref(),
            std::thread::current().name(),
        );
        {
            // Bypass tracing/buffering: the line must be on the wire before
            // anything else runs, and it must never itself panic.
            let stderr = std::io::stderr();
            let mut handle = stderr.lock();
            let _ = writeln!(handle, "{line}");
            let _ = handle.flush();
        }
        tracing::error!(target: "videorc_backend::panic", "{line}");
        default_hook(info);
    }));

    #[cfg(debug_assertions)]
    if std::env::var("VIDEORC_DEV_PANIC_ON_START").as_deref() == Ok("1") {
        panic!("VIDEORC_DEV_PANIC_ON_START=1 requested a test panic");
    }
}

/// One JSON object, no embedded newlines: `{"panic":…,"location":…,"thread":…}`.
pub fn format_panic_line(message: &str, location: Option<&str>, thread: Option<&str>) -> String {
    // Field order is part of the contract: the desktop Diagnostics view
    // recognises a panic line by its `{"panic":` prefix, and serde_json's
    // default map ordering is alphabetical, so the object is assembled by hand
    // with serde_json doing only the string escaping.
    let location = match location {
        Some(location) => json_string(location),
        None => "null".to_string(),
    };
    let line = format!(
        "{{\"panic\":{},\"location\":{},\"thread\":{}}}",
        json_string(message),
        location,
        json_string(thread.unwrap_or("unnamed"))
    );
    // serde_json never emits raw newlines inside strings, but the contract
    // ("one line on stderr") is load-bearing for the supervisor's tail ring,
    // so enforce it rather than trust it.
    line.replace(['\n', '\r'], " ")
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"<unencodable>\"".to_string())
}

pub fn panic_message(info: &PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "Box<dyn Any>".to_string()
    }
}

pub fn panic_location(info: &PanicHookInfo<'_>) -> Option<String> {
    info.location()
        .map(|location| format!("{}:{}", location.file(), location.line()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_hook_line_is_one_json_object_with_the_contract_fields() {
        let line = format_panic_line(
            "ring starvation",
            Some("crates/videorc-backend/src/compositor.rs:42"),
            Some("compositor"),
        );
        assert!(!line.contains('\n'));
        let parsed: serde_json::Value = serde_json::from_str(&line).expect("valid JSON");
        assert_eq!(parsed["panic"], "ring starvation");
        assert_eq!(
            parsed["location"],
            "crates/videorc-backend/src/compositor.rs:42"
        );
        assert_eq!(parsed["thread"], "compositor");
        assert!(line.starts_with("{\"panic\":"), "{line}");
    }

    #[test]
    fn panic_hook_line_escapes_newlines_and_quotes_in_the_message() {
        let line = format_panic_line("first line\nsecond \"quoted\" line", None, None);
        assert_eq!(line.lines().count(), 1);
        let parsed: serde_json::Value = serde_json::from_str(&line).expect("valid JSON");
        assert_eq!(parsed["panic"], "first line\nsecond \"quoted\" line");
        assert!(parsed["location"].is_null());
        assert_eq!(parsed["thread"], "unnamed");
    }

    #[test]
    fn panic_hook_message_reads_str_and_string_payloads() {
        let captured = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let previous = std::panic::take_hook();
        {
            let captured = captured.clone();
            std::panic::set_hook(Box::new(move |info| {
                captured.lock().unwrap().push(format_panic_line(
                    &panic_message(info),
                    panic_location(info).as_deref(),
                    std::thread::current().name(),
                ));
            }));
        }
        let _ = std::panic::catch_unwind(|| panic!("static str payload"));
        let _ = std::panic::catch_unwind(|| panic!("formatted {} payload", 7));
        std::panic::set_hook(previous);

        // The hook is process-global: ignore anything another test thread
        // happened to panic with while ours was installed.
        let lines: Vec<String> = captured
            .lock()
            .unwrap()
            .iter()
            .filter(|line| line.contains("payload"))
            .cloned()
            .collect();
        assert_eq!(lines.len(), 2, "{lines:?}");
        let first: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
        let second: serde_json::Value = serde_json::from_str(&lines[1]).unwrap();
        assert_eq!(first["panic"], "static str payload");
        assert_eq!(second["panic"], "formatted 7 payload");
        assert!(
            first["location"]
                .as_str()
                .is_some_and(|location| location.contains("panic_hook.rs:")),
            "{first}"
        );
    }
}
