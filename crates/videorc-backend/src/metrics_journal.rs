//! Metrics journal (plan 166 S1, plan 178 U1): the app writes its own time
//! series so an unattended run can be judged from evidence on disk.
//!
//! Off by default. On when the `diagnostics.metricsJournal` setting is true or
//! `VIDEORC_METRICS_JOURNAL=1` is in the backend environment. While on, one
//! NDJSON line lands in `<logs>/metrics/<yyyy-mm-dd>.ndjson` every 5 s
//! (`kind: "sample"`), plus one line the moment a health event is emitted
//! (`kind: "health"`). `<logs>` is `VIDEORC_LOGS_DIR` (Electron main passes
//! `<userData>/logs`), else `logs/` beside the database. The day in the file
//! name is the UTC day of `ts`.
//!
//! The journal is a pure consumer of the backend event bus: it subscribes to
//! the existing `broadcast` channel and never takes a lock on the encoder or
//! compositor path. A lagging journal loses events (broadcast semantics), and
//! the file writer is a separate thread fed through a bounded channel that
//! drops lines when full, so a slow disk can never back up a live session.
//!
//! Schema v1 is locked by `protocol-fixtures/metrics-journal-v1.ndjson`. It
//! never carries a stream URL, a stream key, a target label, a health message
//! or chat content. Nullable fields are written as explicit `null`: this file
//! is read by scripts, never deserialized by the renderer contract.
//!
//! When the journal is on, raw FFmpeg stderr is also teed per session to
//! `<logs>/ffmpeg/<sessionId>.log` (plan 166 S3 step 2), with RTMP paths and
//! the home directory redacted before the bytes reach the disk.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{broadcast, watch};

use crate::protocol::{
    HealthEvent, HealthLevel, RecordingState, RecordingStatus, ServerEvent, StreamHealth,
};
use crate::streaming::{StreamTargetRuntime, StreamTargetState, StreamTargetsSnapshot};

pub const SCHEMA_VERSION: u32 = 1;
/// `1` / `true` / `yes` / `on` turns the journal on regardless of the setting.
pub const ENV_VAR: &str = "VIDEORC_METRICS_JOURNAL";
/// `app_settings` key holding a JSON boolean.
pub const SETTING_KEY: &str = "diagnostics.metricsJournal";
/// Root for journal and FFmpeg logs; Electron main sets `<userData>/logs`.
pub const LOGS_DIR_ENV: &str = "VIDEORC_LOGS_DIR";

const SAMPLE_INTERVAL: Duration = Duration::from_secs(5);
/// Total size of `<logs>/metrics`; oldest days go first.
const METRICS_DIR_CAP_BYTES: u64 = 200 * 1024 * 1024;
/// Total size of `<logs>/ffmpeg`; oldest sessions go first.
const FFMPEG_DIR_CAP_BYTES: u64 = 200 * 1024 * 1024;
/// One session's FFmpeg log stops growing here (a truncation marker is written).
const FFMPEG_FILE_CAP_BYTES: u64 = 64 * 1024 * 1024;
/// Lines waiting for the writer thread. A full queue drops the new line.
const WRITER_QUEUE_LINES: usize = 64;
const FFMPEG_TEE_QUEUE_LINES: usize = 1024;
/// Re-check the directory cap about once an hour of samples.
const PRUNE_EVERY_WRITES: u32 = 720;
/// How much journal history a support bundle carries.
pub const SUPPORT_BUNDLE_WINDOW: Duration = Duration::from_secs(2 * 60 * 60);
/// 2 h of 5 s samples is 1440 lines; the rest of the budget is health lines.
const SUPPORT_BUNDLE_MAX_LINES: usize = 4000;

// ---------------------------------------------------------------------------
// Schema v1
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum JournalLineKind {
    /// The 5 s cadence line.
    Sample,
    /// Written the moment a health event is emitted.
    Health,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum JournalSessionState {
    Idle,
    Live,
    Recording,
    Both,
}

/// One destination of the live session. `bitrateKbps`, `fps`,
/// `droppedFrames`, `duplicatedFrames` and `speed` are the session FFmpeg
/// process's progress values (every leg of a session shares that process);
/// they are `null` unless the leg is delivering (`live` or `warning`), so a
/// `connecting`, `reconnecting`, `failed` or `stopped` leg never looks
/// healthy because its siblings are.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JournalLeg {
    pub target_id: String,
    pub platform: String,
    pub bitrate_kbps: Option<f64>,
    pub fps: Option<f64>,
    pub dropped_frames: Option<u64>,
    pub duplicated_frames: Option<u64>,
    pub speed: Option<f64>,
    /// `StreamTargetState` in kebab case: `connecting`, `live`, `warning`,
    /// `reconnecting`, `failed`, `stopped`, `ready`, `not-configured`.
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalLine {
    pub schema_version: u32,
    pub kind: JournalLineKind,
    /// UTC, RFC 3339 with milliseconds.
    pub ts: String,
    pub app_version: String,
    pub session_id: Option<String>,
    pub state: JournalSessionState,
    pub legs: Vec<JournalLeg>,
    /// Oldest frame waiting in the encoder bridge output queue.
    pub encoder_queue_age_ms: Option<u64>,
    pub preview_present_fps: Option<f64>,
    /// `PreviewTransport` in kebab case, e.g. `native-surface`.
    pub preview_transport: Option<String>,
    /// The compositor fallback reason, else `transport:<name>` when the
    /// preview runs on a polling transport, else `null`.
    pub preview_fallback_reason: Option<String>,
    pub backend_rss_bytes: Option<u64>,
    /// FFmpeg processes owned by the backend.
    pub ffmpeg_count: u64,
    /// 1-minute load average divided by logical cores (`null` on Windows).
    pub host_load1_per_core: Option<f64>,
    /// Sample lines: distinct health codes emitted since the previous sample.
    /// Health lines: exactly the event's code.
    pub health_event_codes: Vec<String>,
    /// Health lines only (`info` / `warn` / `error`); `null` on samples.
    pub health_level: Option<HealthLevel>,
    /// Journal lines dropped since the journal started (full writer queue,
    /// full disk budget or write errors).
    pub dropped_lines: u64,
}

/// Process and host numbers sampled when a line is built.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LineContext {
    pub ts: String,
    pub app_version: String,
    pub backend_rss_bytes: Option<u64>,
    pub ffmpeg_count: u64,
    pub host_load1_per_core: Option<f64>,
    pub dropped_lines: u64,
}

// ---------------------------------------------------------------------------
// Collector: folds bus events into the latest values
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
pub(crate) struct JournalCollector {
    session_id: Option<String>,
    recording: bool,
    live: bool,
    targets: Vec<StreamTargetRuntime>,
    stream_health: Option<StreamHealth>,
    encoder_queue_age_ms: Option<u64>,
    preview_present_fps: Option<f64>,
    preview_transport: Option<String>,
    preview_fallback_reason: Option<String>,
    window_codes: Vec<String>,
}

impl JournalCollector {
    /// Folds one bus event. Returns `(code, level)` when the event is a
    /// health event, which the caller turns into a `health` line.
    pub(crate) fn observe(&mut self, event: &ServerEvent) -> Option<(String, HealthLevel)> {
        match event.event.as_str() {
            "recording.status" => {
                if let Ok(status) = RecordingStatus::deserialize(&event.payload) {
                    self.observe_status(&status);
                }
                None
            }
            "stream.targets" => {
                if let Ok(snapshot) = StreamTargetsSnapshot::deserialize(&event.payload)
                    && self.accepts_session(&snapshot.session_id)
                {
                    self.targets = snapshot.targets;
                }
                None
            }
            "stream.health" => {
                if let Ok(health) = StreamHealth::deserialize(&event.payload)
                    && self.accepts_session(&health.session_id)
                {
                    self.stream_health = Some(health);
                }
                None
            }
            "diagnostics.stats" => {
                self.observe_diagnostics(&event.payload);
                None
            }
            "health.event" => {
                let event = HealthEvent::deserialize(&event.payload).ok()?;
                if !self.window_codes.contains(&event.code) {
                    self.window_codes.push(event.code.clone());
                }
                Some((event.code, event.level))
            }
            _ => None,
        }
    }

    fn accepts_session(&self, session_id: &str) -> bool {
        self.session_id
            .as_deref()
            .is_none_or(|current| current == session_id)
    }

    fn observe_status(&mut self, status: &RecordingStatus) {
        // Plan 181: a buffer-only session is not a recording or a stream.
        let active = !status.replay_only
            && matches!(
                status.state,
                RecordingState::Starting
                    | RecordingState::Recording
                    | RecordingState::Streaming
                    | RecordingState::Stopping
            );
        let Some(session_id) = status.session_id.as_ref().filter(|_| active) else {
            self.session_id = None;
            self.recording = false;
            self.live = false;
            self.targets.clear();
            self.stream_health = None;
            self.encoder_queue_age_ms = None;
            return;
        };
        if self.session_id.as_deref() != Some(session_id.as_str()) {
            // Keep targets/health that arrived for this session before its
            // status; drop anything from another session.
            self.targets.clear();
            self.stream_health = self
                .stream_health
                .take()
                .filter(|health| &health.session_id == session_id);
            self.session_id = Some(session_id.clone());
        }
        // Only presence is read: the stream URL itself never leaves here.
        self.recording = status.output_path.is_some();
        self.live =
            status.stream_url.is_some() || matches!(status.state, RecordingState::Streaming);
    }

    fn observe_diagnostics(&mut self, payload: &Value) {
        let transport = payload
            .get("previewTransport")
            .and_then(Value::as_str)
            .map(str::to_string);
        let compositor_fallback = payload
            .get("compositorFallbackReason")
            .and_then(Value::as_str)
            .filter(|reason| !reason.trim().is_empty())
            .map(str::to_string);
        self.preview_fallback_reason = compositor_fallback.or_else(|| {
            transport
                .as_deref()
                .filter(|transport| matches!(*transport, "latest-jpeg-polling" | "mjpeg-stream"))
                .map(|transport| format!("transport:{transport}"))
        });
        self.preview_transport = transport;
        self.preview_present_fps = payload.get("previewPresentFps").and_then(Value::as_f64);
        self.encoder_queue_age_ms = if self.session_id.is_some() {
            payload
                .get("encoderBridgeOutputQueueOldestFrameAgeMs")
                .and_then(Value::as_u64)
        } else {
            None
        };
    }

    fn session_state(&self) -> JournalSessionState {
        match (self.session_id.is_some(), self.recording, self.live) {
            (false, _, _) => JournalSessionState::Idle,
            (true, true, true) => JournalSessionState::Both,
            (true, false, true) => JournalSessionState::Live,
            (true, true, false) => JournalSessionState::Recording,
            // An active session that neither records nor streams yet.
            (true, false, false) => JournalSessionState::Idle,
        }
    }

    fn legs(&self) -> Vec<JournalLeg> {
        self.targets
            .iter()
            .map(|target| {
                let carrying = self.live
                    && matches!(
                        target.state,
                        StreamTargetState::Live | StreamTargetState::Warning
                    );
                let health = self.stream_health.as_ref().filter(|_| carrying);
                JournalLeg {
                    target_id: target.target_id.clone(),
                    platform: crate::streaming::stream_platform_id(target.platform).to_string(),
                    bitrate_kbps: health.and_then(|health| health.bitrate_kbps),
                    fps: health.and_then(|health| health.fps),
                    dropped_frames: health.and_then(|health| health.dropped_frames),
                    duplicated_frames: health.and_then(|health| health.duplicated_frames),
                    speed: health.and_then(|health| health.speed),
                    state: kebab_name(&target.state),
                }
            })
            .collect()
    }

    fn line(
        &self,
        kind: JournalLineKind,
        context: &LineContext,
        health_event_codes: Vec<String>,
        health_level: Option<HealthLevel>,
    ) -> JournalLine {
        JournalLine {
            schema_version: SCHEMA_VERSION,
            kind,
            ts: context.ts.clone(),
            app_version: context.app_version.clone(),
            session_id: self.session_id.clone(),
            state: self.session_state(),
            legs: self.legs(),
            encoder_queue_age_ms: self.encoder_queue_age_ms,
            preview_present_fps: self.preview_present_fps,
            preview_transport: self.preview_transport.clone(),
            preview_fallback_reason: self.preview_fallback_reason.clone(),
            backend_rss_bytes: context.backend_rss_bytes,
            ffmpeg_count: context.ffmpeg_count,
            host_load1_per_core: context.host_load1_per_core,
            health_event_codes,
            health_level,
            dropped_lines: context.dropped_lines,
        }
    }

    /// The 5 s line. Drains the health codes seen since the previous sample.
    pub(crate) fn sample_line(&mut self, context: &LineContext) -> JournalLine {
        let codes = std::mem::take(&mut self.window_codes);
        self.line(JournalLineKind::Sample, context, codes, None)
    }

    pub(crate) fn health_line(
        &self,
        context: &LineContext,
        code: String,
        level: HealthLevel,
    ) -> JournalLine {
        self.line(JournalLineKind::Health, context, vec![code], Some(level))
    }
}

fn kebab_name<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Files: day rotation and the directory cap
// ---------------------------------------------------------------------------

/// Deletes the oldest files with `extension` in `dir` until the total is at
/// most `cap_bytes`. `keep` (the file being written) is never deleted.
pub(crate) fn prune_dir(dir: &Path, cap_bytes: u64, keep: Option<&Path>, extension: &str) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some(extension) {
                return None;
            }
            // Not `entry.metadata()`: on Windows the directory listing can
            // report a stale size (often 0) for a file still open for writing,
            // so the cap would undercount the day being written.
            let metadata = fs::metadata(&path).ok()?;
            metadata.is_file().then(|| {
                (
                    metadata.modified().ok(),
                    path.file_name()
                        .map(|name| name.to_string_lossy().into_owned()),
                    metadata.len(),
                    path,
                )
            })
        })
        .collect::<Vec<_>>();
    // Oldest first; journal day names sort chronologically as a tie-break.
    files.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
    let mut total = files.iter().map(|file| file.2).sum::<u64>();
    for (_, _, size, path) in files {
        if total <= cap_bytes {
            break;
        }
        if keep.is_some_and(|keep| keep == path) {
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

/// Appends lines to `<dir>/<day>.ndjson`, opening a new file when the day
/// changes and keeping the directory under its cap.
pub(crate) struct JournalFileWriter {
    dir: PathBuf,
    cap_bytes: u64,
    day: Option<String>,
    file: Option<File>,
    file_bytes: u64,
    writes_since_prune: u32,
}

impl JournalFileWriter {
    pub(crate) fn new(dir: PathBuf, cap_bytes: u64) -> Self {
        Self {
            dir,
            cap_bytes,
            day: None,
            file: None,
            file_bytes: 0,
            writes_since_prune: 0,
        }
    }

    /// `Ok(false)` when the line was refused because the current day alone
    /// already fills the budget.
    pub(crate) fn append(&mut self, day: &str, line: &str) -> io::Result<bool> {
        if self.file.is_none() || self.day.as_deref() != Some(day) {
            fs::create_dir_all(&self.dir)?;
            let path = self.dir.join(format!("{day}.ndjson"));
            let file = OpenOptions::new().create(true).append(true).open(&path)?;
            self.file_bytes = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
            self.file = Some(file);
            self.day = Some(day.to_string());
            // Prune right after the first write to a new file.
            self.writes_since_prune = PRUNE_EVERY_WRITES.saturating_sub(1);
        }
        let bytes = line.len() as u64 + 1;
        if self.file_bytes.saturating_add(bytes) > self.cap_bytes {
            return Ok(false);
        }
        let file = self.file.as_mut().expect("journal file opened above");
        let mut buffer = Vec::with_capacity(line.len() + 1);
        buffer.extend_from_slice(line.as_bytes());
        buffer.push(b'\n');
        file.write_all(&buffer)?;
        self.file_bytes += bytes;
        self.writes_since_prune += 1;
        if self.writes_since_prune >= PRUNE_EVERY_WRITES {
            let path = self.dir.join(format!("{day}.ndjson"));
            prune_dir(&self.dir, self.cap_bytes, Some(&path), "ndjson");
            self.writes_since_prune = 0;
        }
        Ok(true)
    }
}

fn utc_day(ts: &str) -> String {
    DateTime::parse_from_rfc3339(ts)
        .map(|ts| ts.with_timezone(&Utc).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|_| Utc::now().format("%Y-%m-%d").to_string())
}

/// The non-blocking handle the sampler writes through.
#[derive(Clone)]
pub(crate) struct JournalSink {
    sender: SyncSender<(String, String)>,
    dropped: Arc<AtomicU64>,
}

impl JournalSink {
    /// Starts the writer thread for `dir`.
    pub(crate) fn spawn(dir: PathBuf, cap_bytes: u64) -> io::Result<Self> {
        let (sender, receiver) = sync_channel::<(String, String)>(WRITER_QUEUE_LINES);
        let dropped = Arc::new(AtomicU64::new(0));
        let thread_dropped = Arc::clone(&dropped);
        std::thread::Builder::new()
            .name("videorc-metrics-journal".to_string())
            .spawn(move || {
                let mut writer = JournalFileWriter::new(dir, cap_bytes);
                let mut warned = false;
                for (day, line) in receiver {
                    match writer.append(&day, &line) {
                        Ok(true) => {}
                        Ok(false) => {
                            thread_dropped.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(error) => {
                            thread_dropped.fetch_add(1, Ordering::Relaxed);
                            if !warned {
                                warned = true;
                                tracing::warn!("Metrics journal write failed: {error}");
                            }
                        }
                    }
                }
            })?;
        Ok(Self { sender, dropped })
    }

    pub(crate) fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Never blocks: a full queue drops the line and counts it.
    pub(crate) fn offer(&self, line: &JournalLine) {
        let Ok(text) = serde_json::to_string(line) else {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        };
        match self.sender.try_send((utc_day(&line.ts), text)) {
            Ok(()) => {}
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Sampler task
// ---------------------------------------------------------------------------

/// Process/host numbers, sampled from caches (never spawns `ps` itself).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct ProcessSample {
    pub backend_rss_bytes: Option<u64>,
    pub ffmpeg_count: u64,
    pub host_load1_per_core: Option<f64>,
}

pub(crate) type ProcessProbe = Arc<dyn Fn() -> ProcessSample + Send + Sync>;

fn production_process_probe() -> ProcessProbe {
    Arc::new(|| {
        let (backend_rss_bytes, ffmpeg_count) = crate::diagnostics::runtime_resource_counts();
        let host_load1_per_core = crate::host_pressure::sample_host_pressure().map(|sample| {
            let per_core = sample.load_average / f64::from(sample.logical_cores.max(1));
            (per_core * 1000.0).round() / 1000.0
        });
        ProcessSample {
            backend_rss_bytes,
            ffmpeg_count,
            host_load1_per_core,
        }
    })
}

fn app_version() -> String {
    std::env::var("VIDEORC_APP_VERSION")
        .ok()
        .map(|version| version.trim().to_string())
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

fn now_ts() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(crate) async fn run_sampler(
    mut events: broadcast::Receiver<ServerEvent>,
    seed: Vec<ServerEvent>,
    sink: JournalSink,
    interval: Duration,
    probe: ProcessProbe,
    mut stop: watch::Receiver<bool>,
) {
    let app_version = app_version();
    let context = |sink: &JournalSink| {
        let sample = probe();
        LineContext {
            ts: now_ts(),
            app_version: app_version.clone(),
            backend_rss_bytes: sample.backend_rss_bytes,
            ffmpeg_count: sample.ffmpeg_count,
            host_load1_per_core: sample.host_load1_per_core,
            dropped_lines: sink.dropped(),
        }
    };
    let mut collector = JournalCollector::default();
    for event in &seed {
        // Seeds are current state, not new health events.
        if event.event != "health.event" {
            collector.observe(event);
        }
    }
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    break;
                }
            }
            _ = ticker.tick() => {
                let line = collector.sample_line(&context(&sink));
                sink.offer(&line);
            }
            received = events.recv() => match received {
                Ok(event) => {
                    if let Some((code, level)) = collector.observe(&event) {
                        let line = collector.health_line(&context(&sink), code, level);
                        sink.offer(&line);
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Process-wide switch
// ---------------------------------------------------------------------------

/// Wire state for `diagnostics.metricsJournal.get` / `.set`. Booleans only.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MetricsJournalState {
    /// The journal is writing right now.
    pub enabled: bool,
    /// The saved `diagnostics.metricsJournal` setting.
    pub setting: bool,
    /// `VIDEORC_METRICS_JOURNAL` forced it on; the setting is ignored.
    pub env_override: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetricsJournalSetParams {
    pub enabled: bool,
}

struct RunningJournal {
    stop: watch::Sender<bool>,
}

static RUNNING: StdMutex<Option<RunningJournal>> = StdMutex::new(None);
static ENABLED: AtomicBool = AtomicBool::new(false);
static SETTING: AtomicBool = AtomicBool::new(false);

fn env_flag_on(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

pub fn env_forced() -> bool {
    env_flag_on(std::env::var(ENV_VAR).ok().as_deref())
}

pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

pub fn current_state() -> MetricsJournalState {
    MetricsJournalState {
        enabled: is_enabled(),
        setting: SETTING.load(Ordering::Relaxed),
        env_override: env_forced(),
    }
}

pub fn logs_dir() -> PathBuf {
    std::env::var_os(LOGS_DIR_ENV)
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            crate::storage::default_database_path()
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(std::env::temp_dir)
                .join("logs")
        })
}

pub fn metrics_dir() -> PathBuf {
    logs_dir().join("metrics")
}

pub fn ffmpeg_dir() -> PathBuf {
    logs_dir().join("ffmpeg")
}

/// Applies the saved setting (plus the env override): starts or stops the
/// sampler. `events` must be subscribed BEFORE `seed` was collected so no
/// event between the two is lost. Must run inside the Tokio runtime.
pub fn configure(
    setting: bool,
    events: broadcast::Receiver<ServerEvent>,
    seed: Vec<ServerEvent>,
) -> MetricsJournalState {
    SETTING.store(setting, Ordering::Relaxed);
    let want = setting || env_forced();
    let mut running = RUNNING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match (want, running.is_some()) {
        (true, false) => match JournalSink::spawn(metrics_dir(), METRICS_DIR_CAP_BYTES) {
            Ok(sink) => {
                let (stop, stop_rx) = watch::channel(false);
                tokio::spawn(run_sampler(
                    events,
                    seed,
                    sink,
                    SAMPLE_INTERVAL,
                    production_process_probe(),
                    stop_rx,
                ));
                *running = Some(RunningJournal { stop });
                ENABLED.store(true, Ordering::Relaxed);
                tracing::info!("Metrics journal on.");
            }
            Err(error) => tracing::warn!("Metrics journal could not start: {error}"),
        },
        (false, true) => {
            if let Some(journal) = running.take() {
                let _ = journal.stop.send(true);
            }
            ENABLED.store(false, Ordering::Relaxed);
            tracing::info!("Metrics journal off.");
        }
        _ => {}
    }
    drop(running);
    current_state()
}

// ---------------------------------------------------------------------------
// Support bundle
// ---------------------------------------------------------------------------

/// Journal lines from the last `window`, oldest first, at most
/// `SUPPORT_BUNDLE_MAX_LINES` (the newest kept).
pub(crate) fn read_recent_lines_in(dir: &Path, window: Duration, now: DateTime<Utc>) -> Vec<Value> {
    let cutoff = now - chrono::Duration::from_std(window).unwrap_or(chrono::Duration::hours(2));
    let mut days = vec![cutoff.format("%Y-%m-%d").to_string()];
    let today = now.format("%Y-%m-%d").to_string();
    if days[0] != today {
        days.push(today);
    }
    let mut lines = Vec::new();
    for day in days {
        let Ok(file) = File::open(dir.join(format!("{day}.ndjson"))) else {
            continue;
        };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let recent = value
                .get("ts")
                .and_then(Value::as_str)
                .and_then(|ts| DateTime::parse_from_rfc3339(ts).ok())
                .is_some_and(|ts| ts.with_timezone(&Utc) >= cutoff);
            if recent {
                lines.push(value);
            }
        }
    }
    if lines.len() > SUPPORT_BUNDLE_MAX_LINES {
        lines.drain(..lines.len() - SUPPORT_BUNDLE_MAX_LINES);
    }
    lines
}

/// The support bundle's `metricsJournal` section: `None` while the journal
/// is off, so bundles from ordinary users do not change.
pub fn support_bundle_lines() -> Option<Vec<Value>> {
    is_enabled().then(|| read_recent_lines_in(&metrics_dir(), SUPPORT_BUNDLE_WINDOW, Utc::now()))
}

// ---------------------------------------------------------------------------
// FFmpeg stderr tee (plan 166 S3 step 2)
// ---------------------------------------------------------------------------

/// Hands raw FFmpeg stderr lines to a per-session writer thread. Never
/// blocks the stderr relay: a full queue drops the line and counts it.
pub(crate) struct FfmpegStderrTee {
    sender: SyncSender<String>,
    dropped: Arc<AtomicU64>,
}

impl FfmpegStderrTee {
    pub(crate) fn offer(&self, raw_line: &str) {
        match self.sender.try_send(raw_line.to_string()) {
            Ok(()) => {}
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

/// File-name-safe session id: anything outside `[A-Za-z0-9_-]` becomes `_`.
fn safe_file_stem(session_id: &str) -> String {
    let stem = session_id
        .chars()
        .take(128)
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if stem.is_empty() {
        "session".to_string()
    } else {
        stem
    }
}

fn home_dir_prefix() -> Option<String> {
    let var = if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    };
    std::env::var(var)
        .ok()
        .map(|home| home.trim_end_matches(['/', '\\']).to_string())
        .filter(|home| home.len() > 1)
}

/// What reaches the disk for one stderr line: RTMP paths (the stream key)
/// masked by the backend's shared redaction, the home directory as `~`.
pub(crate) fn redact_ffmpeg_log_line(line: &str, home: Option<&str>) -> String {
    let redacted = crate::state::redact_stream_urls(line.trim_end_matches(['\r', '\n']));
    match home {
        Some(home) => redacted.replace(home, "~"),
        None => redacted,
    }
}

pub(crate) fn open_ffmpeg_stderr_tee_in(
    dir: &Path,
    session_id: &str,
) -> io::Result<FfmpegStderrTee> {
    fs::create_dir_all(dir)?;
    let path = dir.join(format!("{}.log", safe_file_stem(session_id)));
    prune_dir(dir, FFMPEG_DIR_CAP_BYTES, Some(&path), "log");
    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    let mut written = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    let header = format!(
        "[videorc] ffmpeg stderr for session {} from {}\n",
        safe_file_stem(session_id),
        now_ts()
    );
    file.write_all(header.as_bytes())?;
    written += header.len() as u64;
    let (sender, receiver) = sync_channel::<String>(FFMPEG_TEE_QUEUE_LINES);
    let dropped = Arc::new(AtomicU64::new(0));
    let thread_dropped = Arc::clone(&dropped);
    let home = home_dir_prefix();
    std::thread::Builder::new()
        .name("videorc-ffmpeg-log".to_string())
        .spawn(move || {
            let mut truncated = false;
            let mut failed = false;
            for line in receiver {
                if truncated || failed {
                    continue;
                }
                let mut text = redact_ffmpeg_log_line(&line, home.as_deref());
                text.push('\n');
                if written.saturating_add(text.len() as u64) > FFMPEG_FILE_CAP_BYTES {
                    truncated = true;
                    let _ = file.write_all(
                        b"[videorc] log truncated: this session reached the 64 MB ffmpeg log cap\n",
                    );
                    continue;
                }
                if file.write_all(text.as_bytes()).is_err() {
                    failed = true;
                    continue;
                }
                written += text.len() as u64;
            }
            let dropped = thread_dropped.load(Ordering::Relaxed);
            if dropped > 0 && !failed {
                let _ = file.write_all(
                    format!(
                        "[videorc] {dropped} stderr lines were dropped because the log writer fell behind\n"
                    )
                    .as_bytes(),
                );
            }
        })?;
    Ok(FfmpegStderrTee { sender, dropped })
}

/// The tee for a new FFmpeg process, or `None` while the journal is off.
pub(crate) fn ffmpeg_stderr_tee(session_id: &str) -> Option<FfmpegStderrTee> {
    if !is_enabled() {
        return None;
    }
    match open_ffmpeg_stderr_tee_in(&ffmpeg_dir(), session_id) {
        Ok(tee) => Some(tee),
        Err(error) => {
            tracing::warn!("FFmpeg stderr log could not open: {error}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::streaming::StreamPlatform;
    use serde_json::json;

    const FIXTURE: &str = include_str!("../../../protocol-fixtures/metrics-journal-v1.ndjson");
    const YOUTUBE_KEY: &str = "abcd-efgh-ijkl-mnop-qrst";
    const TWITCH_KEY: &str = "live_123456789_AbCdEfGhIjKlMnOpQrStUvWxYz";
    const KICK_KEY: &str = "sk_us-west-2_AbCdEfGhIjKl";

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "videorc-metrics-journal-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn event(name: &str, payload: Value) -> ServerEvent {
        ServerEvent {
            event: name.to_string(),
            payload,
        }
    }

    fn context(ts: &str) -> LineContext {
        LineContext {
            ts: ts.to_string(),
            app_version: "0.9.142".to_string(),
            backend_rss_bytes: Some(314_572_800),
            ffmpeg_count: 1,
            host_load1_per_core: Some(0.412),
            dropped_lines: 0,
        }
    }

    fn running_status(session_id: &str) -> Value {
        json!({
            "state": "streaming",
            "sessionId": session_id,
            "outputPath": "/Users/someone/Movies/Videorc/take.mkv",
            "streamUrl": format!("rtmp://a.rtmp.youtube.com/live2/{YOUTUBE_KEY}"),
            "startedAt": "2026-10-12T10:00:00Z"
        })
    }

    fn targets(session_id: &str) -> Value {
        serde_json::to_value(StreamTargetsSnapshot {
            session_id: session_id.to_string(),
            targets: vec![
                StreamTargetRuntime {
                    target_id: "youtube-main".to_string(),
                    platform: StreamPlatform::Youtube,
                    label: "My Channel".to_string(),
                    state: StreamTargetState::Live,
                    message: Some(format!(
                        "Live at rtmps://a.rtmp.youtube.com/live2/{YOUTUBE_KEY}"
                    )),
                    redacted_url: Some("rtmps://a.rtmp.youtube.com/live2/••••".to_string()),
                },
                StreamTargetRuntime {
                    target_id: "twitch-main".to_string(),
                    platform: StreamPlatform::Twitch,
                    label: "streamer_name".to_string(),
                    state: StreamTargetState::Reconnecting,
                    message: Some(format!("rtmp://live.twitch.tv/app/{TWITCH_KEY} retrying")),
                    redacted_url: None,
                },
                StreamTargetRuntime {
                    target_id: "kick-main".to_string(),
                    platform: StreamPlatform::Kick,
                    label: "kick".to_string(),
                    state: StreamTargetState::Failed,
                    message: Some(format!(
                        "rtmps://fa723fc1b171.global-contribute.live-video.net/app/{KICK_KEY}"
                    )),
                    redacted_url: None,
                },
            ],
        })
        .expect("targets")
    }

    fn diagnostics(session_id: Option<&str>) -> Value {
        let mut stats = crate::diagnostics::idle_diagnostics();
        stats.session_id = session_id.map(str::to_string);
        stats.preview_present_fps = Some(59.8);
        stats.preview_transport = crate::protocol::PreviewTransport::NativeSurface;
        stats.encoder_bridge_output_queue_oldest_frame_age_ms = Some(18);
        serde_json::to_value(stats).expect("diagnostics")
    }

    fn health_event(code: &str, level: &str, message: &str) -> Value {
        json!({
            "id": "evt-1",
            "sessionId": "session-fixture",
            "level": level,
            "code": code,
            "message": message,
            "permissionPane": null,
            "createdAt": "2026-10-12T10:00:07Z"
        })
    }

    /// The scripted run behind the fixture: idle sample, live sample with
    /// three legs, then a health line. Every input that could carry a key
    /// does carry one.
    fn scripted_lines() -> Vec<JournalLine> {
        let mut collector = JournalCollector::default();
        let mut lines = Vec::new();
        collector.observe(&event("diagnostics.stats", diagnostics(None)));
        lines.push(collector.sample_line(&LineContext {
            ffmpeg_count: 0,
            ..context("2026-10-12T09:59:55.000Z")
        }));
        collector.observe(&event(
            "recording.status",
            running_status("session-fixture"),
        ));
        collector.observe(&event("stream.targets", targets("session-fixture")));
        collector.observe(&event(
            "stream.health",
            serde_json::to_value(StreamHealth {
                session_id: "session-fixture".to_string(),
                fps: Some(30.0),
                dropped_frames: Some(2),
                speed: Some(1.0),
                bitrate_kbps: Some(6012.4),
                total_bytes: Some(4_500_000),
                duplicated_frames: Some(1),
                created_at: "2026-10-12T10:00:04Z".to_string(),
            })
            .expect("health"),
        ));
        collector.observe(&event(
            "diagnostics.stats",
            diagnostics(Some("session-fixture")),
        ));
        let health = collector.observe(&event(
            "health.event",
            health_event(
                "stream-leg-reconnecting",
                "warn",
                &format!("Twitch dropped: rtmp://live.twitch.tv/app/{TWITCH_KEY}"),
            ),
        ));
        let (code, level) = health.expect("health event folds");
        lines.push(collector.health_line(&context("2026-10-12T10:00:07.250Z"), code, level));
        lines.push(collector.sample_line(&context("2026-10-12T10:00:10.000Z")));
        lines
    }

    fn assert_no_stream_secret(text: &str) {
        assert!(!text.contains("rtmp://"), "rtmp URL in {text}");
        assert!(!text.contains("rtmps://"), "rtmps URL in {text}");
        for key in [YOUTUBE_KEY, TWITCH_KEY, KICK_KEY] {
            assert!(!text.contains(key), "stream key in {text}");
        }
        assert!(!text.contains("live_"), "Twitch-key-shaped value in {text}");
        assert!(!text.contains("sk_"), "Kick-key-shaped value in {text}");
        // YouTube keys are four or five groups of four [a-z0-9] joined by '-'.
        for token in text.split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '-')) {
            let groups = token.split('-').collect::<Vec<_>>();
            let youtube_shaped = groups.len() >= 4
                && groups.iter().all(|group| {
                    group.len() == 4 && group.chars().all(|c| c.is_ascii_alphanumeric())
                });
            assert!(
                !youtube_shaped,
                "YouTube-key-shaped value {token} in {text}"
            );
        }
    }

    #[test]
    fn metrics_journal_schema_v1_matches_the_shared_fixture() {
        let fixture = FIXTURE
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str::<Value>(line).expect("fixture line is JSON"))
            .collect::<Vec<_>>();
        let built = scripted_lines()
            .iter()
            .map(|line| serde_json::to_value(line).expect("line"))
            .collect::<Vec<_>>();
        assert_eq!(built, fixture, "schema v1 drifted from the fixture");
        for line in &fixture {
            assert_eq!(line["schemaVersion"], json!(1));
            let keys = line
                .as_object()
                .expect("object")
                .keys()
                .cloned()
                .collect::<Vec<_>>();
            let mut expected = vec![
                "appVersion",
                "backendRssBytes",
                "droppedLines",
                "encoderQueueAgeMs",
                "ffmpegCount",
                "healthEventCodes",
                "healthLevel",
                "hostLoad1PerCore",
                "kind",
                "legs",
                "previewFallbackReason",
                "previewPresentFps",
                "previewTransport",
                "schemaVersion",
                "sessionId",
                "state",
                "ts",
            ];
            expected.sort_unstable();
            assert_eq!(keys, expected, "every v1 line carries every field");
            // Round-trips through the typed schema.
            serde_json::from_value::<JournalLine>(line.clone()).expect("typed line");
        }
    }

    /// Regenerate after a deliberate schema change (bump `SCHEMA_VERSION`):
    /// `cargo test -p videorc-backend metrics_journal::tests::write_shared_fixture -- --ignored`
    #[test]
    #[ignore]
    fn write_shared_fixture() {
        let text = scripted_lines()
            .iter()
            .map(|line| serde_json::to_string(line).expect("line") + "\n")
            .collect::<String>();
        fs::write(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../protocol-fixtures/metrics-journal-v1.ndjson"
            ),
            text,
        )
        .expect("fixture written");
    }

    #[test]
    fn metrics_journal_never_writes_a_stream_url_or_key() {
        assert_no_stream_secret(FIXTURE);
        for line in scripted_lines() {
            assert_no_stream_secret(&serde_json::to_string(&line).expect("line"));
        }
    }

    #[test]
    fn metrics_journal_states_and_leg_stats() {
        let lines = scripted_lines();
        assert_eq!(lines[0].state, JournalSessionState::Idle);
        assert!(lines[0].legs.is_empty());
        assert_eq!(lines[0].encoder_queue_age_ms, None);
        assert_eq!(lines[1].kind, JournalLineKind::Health);
        assert_eq!(lines[1].health_event_codes, vec!["stream-leg-reconnecting"]);
        let live = &lines[2];
        assert_eq!(live.state, JournalSessionState::Both);
        assert_eq!(live.health_event_codes, vec!["stream-leg-reconnecting"]);
        assert_eq!(live.legs[0].bitrate_kbps, Some(6012.4));
        assert_eq!(live.legs[1].state, "reconnecting");
        assert_eq!(
            live.legs[1].fps, None,
            "a reconnecting leg delivers nothing"
        );
        assert_eq!(live.legs[2].state, "failed");
        assert_eq!(
            live.legs[2].bitrate_kbps, None,
            "a failed leg carries no stats"
        );
        assert_eq!(live.encoder_queue_age_ms, Some(18));

        // Stream only, then idle again resets the session view.
        let mut collector = JournalCollector::default();
        let mut status = running_status("s2");
        status["outputPath"] = Value::Null;
        collector.observe(&event("recording.status", status));
        assert_eq!(collector.session_state(), JournalSessionState::Live);
        collector.observe(&event(
            "recording.status",
            json!({ "state": "recording", "sessionId": "s3", "outputPath": "/tmp/x.mkv" }),
        ));
        assert_eq!(collector.session_state(), JournalSessionState::Recording);
        collector.observe(&event("recording.status", json!({ "state": "idle" })));
        assert_eq!(collector.session_state(), JournalSessionState::Idle);
        assert!(collector.legs().is_empty());
        // Codes drain per sample.
        assert!(
            collector
                .sample_line(&context("2026-10-12T10:00:00.000Z"))
                .health_event_codes
                .is_empty()
        );
    }

    #[test]
    fn metrics_journal_ignores_targets_and_health_from_another_session() {
        let mut collector = JournalCollector::default();
        collector.observe(&event("recording.status", running_status("current")));
        collector.observe(&event("stream.targets", targets("stale")));
        assert!(collector.legs().is_empty());
        collector.observe(&event("stream.targets", targets("current")));
        assert_eq!(collector.legs().len(), 3);
    }

    #[test]
    fn metrics_journal_preview_fallback_reason() {
        let mut collector = JournalCollector::default();
        collector.observe(&event(
            "diagnostics.stats",
            json!({ "previewTransport": "latest-jpeg-polling", "previewPresentFps": null }),
        ));
        assert_eq!(
            collector.preview_fallback_reason.as_deref(),
            Some("transport:latest-jpeg-polling")
        );
        collector.observe(&event(
            "diagnostics.stats",
            json!({ "previewTransport": "native-surface", "compositorFallbackReason": "metal device lost" }),
        ));
        assert_eq!(
            collector.preview_fallback_reason.as_deref(),
            Some("metal device lost")
        );
        collector.observe(&event(
            "diagnostics.stats",
            json!({ "previewTransport": "native-surface" }),
        ));
        assert_eq!(collector.preview_fallback_reason, None);
    }

    #[test]
    fn metrics_journal_rotates_by_day_and_caps_the_directory() {
        let dir = temp_dir("rotate");
        let mut writer = JournalFileWriter::new(dir.clone(), 100);
        assert!(writer.append("2026-10-10", &"a".repeat(39)).expect("write"));
        assert!(writer.append("2026-10-11", &"b".repeat(39)).expect("write"));
        assert!(writer.append("2026-10-12", &"c".repeat(39)).expect("write"));
        // Day three pushed the total to 120 bytes: the oldest day went.
        assert!(!dir.join("2026-10-10.ndjson").exists());
        assert!(dir.join("2026-10-11.ndjson").exists());
        assert!(dir.join("2026-10-12.ndjson").exists());
        // The current day alone may not exceed the budget.
        assert!(writer.append("2026-10-12", &"c".repeat(39)).expect("write"));
        assert!(
            !writer
                .append("2026-10-12", &"c".repeat(39))
                .expect("refused")
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn metrics_journal_support_bundle_reads_the_last_two_hours() {
        let dir = temp_dir("bundle");
        let line = |ts: &str| format!("{{\"schemaVersion\":1,\"ts\":\"{ts}\"}}\n");
        fs::write(
            dir.join("2026-10-11.ndjson"),
            format!(
                "{}{}",
                line("2026-10-11T21:00:00.000Z"),
                line("2026-10-11T23:30:00.000Z")
            ),
        )
        .expect("yesterday");
        fs::write(
            dir.join("2026-10-12.ndjson"),
            format!(
                "{}not json\n{}",
                line("2026-10-12T00:30:00.000Z"),
                line("2026-10-12T01:00:00.000Z")
            ),
        )
        .expect("today");
        let now = DateTime::parse_from_rfc3339("2026-10-12T01:00:00Z")
            .expect("now")
            .with_timezone(&Utc);
        let lines = read_recent_lines_in(&dir, SUPPORT_BUNDLE_WINDOW, now);
        let stamps = lines
            .iter()
            .map(|line| line["ts"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            stamps,
            vec![
                "2026-10-11T23:30:00.000Z",
                "2026-10-12T00:30:00.000Z",
                "2026-10-12T01:00:00.000Z"
            ]
        );
        fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn metrics_journal_sampler_writes_samples_and_health_lines_without_blocking() {
        let dir = temp_dir("sampler");
        let (events, receiver) = broadcast::channel(16);
        let sink = JournalSink::spawn(dir.clone(), METRICS_DIR_CAP_BYTES).expect("sink");
        let (stop, stop_rx) = watch::channel(false);
        let probe: ProcessProbe = Arc::new(|| ProcessSample {
            backend_rss_bytes: Some(1),
            ffmpeg_count: 2,
            host_load1_per_core: Some(0.5),
        });
        let task = tokio::spawn(run_sampler(
            receiver,
            vec![event("recording.status", running_status("seeded"))],
            sink.clone(),
            Duration::from_millis(40),
            probe,
            stop_rx,
        ));
        tokio::time::sleep(Duration::from_millis(30)).await;
        let _ = events.send(event(
            "health.event",
            health_event(
                "stream-dropped-frames",
                "warn",
                "FFmpeg reports 3 dropped frames.",
            ),
        ));
        tokio::time::sleep(Duration::from_millis(150)).await;
        let _ = stop.send(true);
        task.await.expect("sampler stops");
        drop(sink);
        // The writer thread drains once every sender is gone.
        let mut text = String::new();
        for _ in 0..50 {
            text = fs::read_dir(&dir)
                .expect("dir")
                .filter_map(Result::ok)
                .map(|entry| fs::read_to_string(entry.path()).unwrap_or_default())
                .collect();
            if text.contains("\"kind\":\"health\"") && text.lines().count() >= 4 {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let lines = text
            .lines()
            .map(|line| serde_json::from_str::<JournalLine>(line).expect("v1 line"))
            .collect::<Vec<_>>();
        assert!(
            lines
                .iter()
                .filter(|line| line.kind == JournalLineKind::Sample)
                .count()
                >= 3
        );
        let health = lines
            .iter()
            .find(|line| line.kind == JournalLineKind::Health)
            .expect("health line");
        assert_eq!(health.health_event_codes, vec!["stream-dropped-frames"]);
        assert_eq!(health.session_id.as_deref(), Some("seeded"));
        assert_eq!(health.ffmpeg_count, 2);
        assert_no_stream_secret(&text);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn metrics_journal_sink_drops_instead_of_blocking_when_the_queue_is_full() {
        let (sender, _receiver) = sync_channel::<(String, String)>(1);
        let sink = JournalSink {
            sender,
            dropped: Arc::new(AtomicU64::new(0)),
        };
        let line = scripted_lines().remove(0);
        for _ in 0..5 {
            sink.offer(&line);
        }
        assert_eq!(sink.dropped(), 4);
    }

    #[test]
    fn metrics_journal_env_flag_parsing() {
        assert!(env_flag_on(Some("1")));
        assert!(env_flag_on(Some(" TRUE ")));
        assert!(!env_flag_on(Some("0")));
        assert!(!env_flag_on(Some("")));
        assert!(!env_flag_on(None));
    }

    #[test]
    fn metrics_journal_ffmpeg_tee_redacts_keys_and_home_at_write_time() {
        let dir = temp_dir("ffmpeg");
        let tee = open_ffmpeg_stderr_tee_in(&dir, "../session/1").expect("tee");
        tee.offer(&format!(
            "[info] Output #0, tee, to '[f=flv:onfail=ignore]rtmp://a.rtmp.youtube.com/live2/{YOUTUBE_KEY}|[f=flv]rtmps://live.twitch.tv/app/{TWITCH_KEY}':"
        ));
        tee.offer("frame=  300 fps= 30 q=-1.0 size=    1024kB time=00:00:10.00 bitrate= 838.9kbits/s speed=   1x");
        drop(tee);
        let path = dir.join("___session_1.log");
        let mut text = String::new();
        for _ in 0..50 {
            text = fs::read_to_string(&path).unwrap_or_default();
            if text.contains("speed=") {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(text.starts_with("[videorc] ffmpeg stderr for session ___session_1"));
        assert!(text.contains("rtmp://a.rtmp.youtube.com/live2/••••"));
        assert!(text.contains("rtmps://live.twitch.tv/app/••••"));
        assert!(!text.contains(YOUTUBE_KEY));
        assert!(!text.contains(TWITCH_KEY));
        assert!(text.contains("speed=   1x"));
        assert_eq!(
            redact_ffmpeg_log_line(
                "Opening '/Users/someone/Movies/a.mkv'",
                Some("/Users/someone")
            ),
            "Opening '~/Movies/a.mkv'"
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn metrics_journal_prune_keeps_the_file_in_use() {
        let dir = temp_dir("prune");
        fs::write(dir.join("old.log"), vec![b'x'; 80]).expect("old");
        fs::write(dir.join("current.log"), vec![b'x'; 80]).expect("current");
        fs::write(dir.join("other.txt"), vec![b'x'; 500]).expect("ignored");
        prune_dir(&dir, 100, Some(&dir.join("old.log")), "log");
        assert!(dir.join("old.log").exists(), "the file in use survives");
        assert!(!dir.join("current.log").exists());
        assert!(
            dir.join("other.txt").exists(),
            "other extensions are not ours"
        );
        fs::remove_dir_all(dir).ok();
    }
}
