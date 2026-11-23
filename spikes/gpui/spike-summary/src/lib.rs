//! The parts every plan 260 spike shares: its arguments, its `summary.json`
//! and its error lines. The format is described in `../SUMMARY.md` and the
//! Windows testing plan (`plans/260-gpui-rewrite-windows-testing.md`).
//!
//! A spike:
//!
//! ```no_run
//! let mut run = spike_summary::Run::start("spike-hello");
//! // ... open the window, count renders ...
//! run.set("renders", 42);
//! run.finish(); // prints `[spike] summary {...}`, writes summary.json, exits
//! ```

use serde_json::{Map, Value, json};
use std::{
    path::PathBuf,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

/// The version of the summary format. Bump it when a common field changes
/// meaning; adding a spike-specific field does not need a bump.
pub const SCHEMA_VERSION: u64 = 1;

/// The GPUI snapshot every spike in this workspace pins (plan 260 D1).
pub const GPUI_PRE_VERSION: &str = "0.3.14";

static ERRORS: AtomicU64 = AtomicU64::new(0);
static ERROR_MESSAGES: Mutex<Vec<String>> = Mutex::new(Vec::new());
static STARTED: OnceLock<Instant> = OnceLock::new();

/// Report a failure: prints `[spike] error <message>` at once and counts it in
/// the summary's `errors`. The spike keeps running; `Run::finish` exits
/// non-zero when any error was reported.
pub fn error(message: impl Into<String>) {
    let message = message.into();
    eprintln!("[spike] error {message}");
    ERRORS.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut messages) = ERROR_MESSAGES.lock() {
        messages.push(message);
    }
}

/// Milliseconds since `Run::start`.
pub fn elapsed_ms() -> f64 {
    STARTED
        .get()
        .map(|t| t.elapsed().as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// The command line every spike accepts.
#[derive(Debug, Clone)]
pub struct Args {
    /// `--seconds <n>`: how long the timed run lasts before the spike closes
    /// itself (default 30).
    pub seconds: u64,
    /// `--out <path>`: where summary.json is written (default
    /// `summary.json` in the current folder).
    pub out: PathBuf,
    /// Every other argument, in order, for the spike's own flags
    /// (`--route a`, `--floating`…). Read them with `flag` and `value`.
    pub rest: Vec<String>,
}

impl Args {
    pub fn parse() -> Self {
        let mut seconds = 30;
        let mut out = PathBuf::from("summary.json");
        let mut rest = Vec::new();
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--seconds" => match args.next().and_then(|v| v.parse().ok()) {
                    Some(v) => seconds = v,
                    None => error("--seconds needs a whole number"),
                },
                "--out" => match args.next() {
                    Some(v) => out = PathBuf::from(v),
                    None => error("--out needs a path"),
                },
                _ => rest.push(arg),
            }
        }
        Self { seconds, out, rest }
    }

    /// True when `--name` was passed.
    pub fn flag(&self, name: &str) -> bool {
        self.rest.iter().any(|a| a == name)
    }

    /// The value after `--name`, if any.
    pub fn value(&self, name: &str) -> Option<&str> {
        let i = self.rest.iter().position(|a| a == name)?;
        self.rest.get(i + 1).map(String::as_str)
    }
}

/// One timed run of a spike and its summary.
pub struct Run {
    spike: &'static str,
    pub args: Args,
    started_unix_ms: u128,
    fields: Map<String, Value>,
}

impl Run {
    /// Starts the clock, parses the arguments and installs a panic hook that
    /// reports a panic as a `[spike] error` line.
    pub fn start(spike: &'static str) -> Self {
        let _ = STARTED.set(Instant::now());
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            error(format!("panic: {info}"));
            previous(info);
        }));
        let args = Args::parse();
        let started_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        println!("[spike] start {spike} seconds={}", args.seconds);
        Self {
            spike,
            args,
            started_unix_ms,
            fields: Map::new(),
        }
    }

    /// Sets a spike-specific field. Use the names in SUMMARY.md where one
    /// fits, so the same number has the same name on every platform.
    pub fn set(&mut self, key: &str, value: impl Into<Value>) {
        self.fields.insert(key.to_owned(), value.into());
    }

    /// The summary as it stands: common fields first, then the spike's.
    pub fn summary(&self) -> Value {
        let elapsed_s = STARTED
            .get()
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        let usage = process_usage();
        let errors = ERRORS.load(Ordering::Relaxed);
        let messages = ERROR_MESSAGES.lock().map(|m| m.clone()).unwrap_or_default();
        let mut out = Map::new();
        out.insert("schema_version".into(), json!(SCHEMA_VERSION));
        out.insert("spike".into(), json!(self.spike));
        out.insert("os".into(), json!(std::env::consts::OS));
        out.insert("arch".into(), json!(std::env::consts::ARCH));
        out.insert("gpui_pre".into(), json!(GPUI_PRE_VERSION));
        out.insert(
            "build".into(),
            json!(if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            }),
        );
        out.insert(
            "args".into(),
            json!(std::env::args().skip(1).collect::<Vec<_>>()),
        );
        out.insert("started_unix_ms".into(), json!(self.started_unix_ms as u64));
        out.insert("seconds".into(), json!(self.args.seconds));
        out.insert("elapsed_s".into(), json!(round(elapsed_s, 2)));
        out.insert(
            "logical_cpus".into(),
            json!(
                std::thread::available_parallelism()
                    .map(|n| n.get())
                    .unwrap_or(0)
            ),
        );
        if let Some(cpu_s) = usage.cpu_seconds {
            out.insert("process_cpu_seconds".into(), json!(round(cpu_s, 2)));
            if elapsed_s > 0.0 {
                out.insert(
                    "process_cpu_percent_avg".into(),
                    json!(round(cpu_s / elapsed_s * 100.0, 1)),
                );
            }
        }
        if let Some(mb) = usage.peak_rss_mb {
            out.insert("peak_rss_mb".into(), json!(round(mb, 1)));
        }
        for (k, v) in &self.fields {
            out.insert(k.clone(), v.clone());
        }
        out.insert("errors".into(), json!(errors));
        out.insert("error_messages".into(), json!(messages));
        Value::Object(out)
    }

    /// Prints `[spike] summary <json>`, writes summary.json and returns the
    /// exit code (0, or 1 when any error was reported). Call it once, at the
    /// end of the timed run.
    pub fn write(&self) -> i32 {
        let summary = self.summary();
        println!("[spike] summary {summary}");
        let pretty = serde_json::to_string_pretty(&summary).unwrap_or_default();
        if let Err(e) = std::fs::write(&self.args.out, pretty + "\n") {
            error(format!("cannot write {}: {e}", self.args.out.display()));
        } else {
            println!("[spike] wrote {}", self.args.out.display());
        }
        if ERRORS.load(Ordering::Relaxed) > 0 {
            1
        } else {
            0
        }
    }

    /// `write`, then exits the process with its code. GPUI's run loop does
    /// not always return on macOS, so spikes call this instead of returning
    /// from `main`.
    pub fn finish(&self) -> ! {
        let code = self.write();
        std::process::exit(code)
    }
}

/// The p-th percentile (0..=100) of `samples`, nearest-rank. `None` when empty.
pub fn percentile(samples: &[f64], p: f64) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    Some(sorted[rank.clamp(1, sorted.len()) - 1])
}

/// Rounds to `places` decimals for readable summaries.
pub fn round(v: f64, places: i32) -> f64 {
    let f = 10f64.powi(places);
    (v * f).round() / f
}

struct Usage {
    cpu_seconds: Option<f64>,
    peak_rss_mb: Option<f64>,
}

#[cfg(unix)]
fn process_usage() -> Usage {
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) } != 0 {
        return Usage {
            cpu_seconds: None,
            peak_rss_mb: None,
        };
    }
    let tv = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1e6;
    // ru_maxrss is bytes on macOS and kilobytes on Linux.
    let rss_bytes = if cfg!(target_os = "macos") {
        ru.ru_maxrss as f64
    } else {
        ru.ru_maxrss as f64 * 1024.0
    };
    Usage {
        cpu_seconds: Some(tv(ru.ru_utime) + tv(ru.ru_stime)),
        peak_rss_mb: Some(rss_bytes / (1024.0 * 1024.0)),
    }
}

#[cfg(windows)]
fn process_usage() -> Usage {
    use windows_sys::Win32::{
        Foundation::FILETIME,
        System::{
            ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
            Threading::{GetCurrentProcess, GetProcessTimes},
        },
    };
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut creation, mut exit, mut kernel, mut user) = (zero, zero, zero, zero);
    let to_s =
        |t: FILETIME| ((t.dwHighDateTime as u64) << 32 | t.dwLowDateTime as u64) as f64 / 1e7;
    let process = unsafe { GetCurrentProcess() };
    let cpu_seconds =
        (unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) }
            != 0)
            .then(|| to_s(kernel) + to_s(user));
    let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    let peak_rss_mb = (unsafe { K32GetProcessMemoryInfo(process, &mut counters, counters.cb) }
        != 0)
        .then(|| counters.PeakWorkingSetSize as f64 / (1024.0 * 1024.0));
    Usage {
        cpu_seconds,
        peak_rss_mb,
    }
}

#[cfg(not(any(unix, windows)))]
fn process_usage() -> Usage {
    Usage {
        cpu_seconds: None,
        peak_rss_mb: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentile_is_nearest_rank() {
        let s: Vec<f64> = (1..=100).map(f64::from).collect();
        assert_eq!(percentile(&s, 95.0), Some(95.0));
        assert_eq!(percentile(&s, 50.0), Some(50.0));
        assert_eq!(percentile(&s, 100.0), Some(100.0));
        assert_eq!(percentile(&[], 95.0), None);
        assert_eq!(percentile(&[7.0], 0.0), Some(7.0));
    }

    #[test]
    fn summary_has_common_fields_then_errors() {
        let mut run = Run {
            spike: "spike-test",
            args: Args {
                seconds: 1,
                out: "x.json".into(),
                rest: vec![],
            },
            started_unix_ms: 0,
            fields: Map::new(),
        };
        run.set("renders", 3);
        let s = run.summary();
        for key in [
            "schema_version",
            "spike",
            "os",
            "arch",
            "gpui_pre",
            "seconds",
            "elapsed_s",
            "renders",
            "errors",
        ] {
            assert!(s.get(key).is_some(), "missing {key}");
        }
        assert_eq!(s["renders"], 3);
    }
}
