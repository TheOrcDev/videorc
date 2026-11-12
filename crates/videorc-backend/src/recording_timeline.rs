//! Start/stop latency timelines for a recording session.
//!
//! One timeline is created when `session.start` (or `session.stop`) is
//! admitted and a monotonic mark is recorded at every phase boundary. The
//! result is published once, AFTER the user-visible status edge, as a typed
//! snapshot in `diagnostics.stats` plus one `key=value` health event, so the
//! latency smoke and the Diagnostics tab can attribute time to phases.
//!
//! Telemetry can never be load-bearing: every operation here is infallible,
//! marks are first-wins, and callers emit with `let _ =`.

use std::sync::Mutex;
use std::time::Instant;

use chrono::Utc;

use crate::protocol::{RecordingTimelineMark, RecordingTimelineSnapshot};

/// Renderer-supplied click timestamps older than this are treated as clock
/// skew and dropped rather than reported as latency.
pub const MAX_CLICK_TO_ORIGIN_MS: u64 = 60_000;

/// Phase boundaries of `start_session`, in the order they normally complete.
///
/// The four marks between `admission` and `device-resolve` (plan 195 S1)
/// split the phase a support bundle showed as one 3–31 s gap on a weak
/// Windows PC: the encoder-bridge admission, the FFmpeg work permit (a
/// running quality check must exit first), the Windows recordable-video
/// probe (Media Foundation, per canvas rung) and the idle preview stop.
/// `device-resolve` keeps its name and place; scripts parse it.
///
/// The `bridge-*` marks between `ffmpeg-spawn` and `bridge-ready` (#1267)
/// split the encoder bridge's start: the writer thread stamps each step in a
/// [`BridgeStartupTrace`] and the session folds the stamps in, in time order,
/// once the bridge is ready. A step a path never takes (most encoders never
/// renegotiate their output type) is absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordingStartPhase {
    Admission,
    BridgeAdmission,
    FfmpegWorkPermit,
    RecordableVideoProbe,
    PreviewStop,
    DeviceResolve,
    AudioOpen,
    MicWarm,
    CompositorArm,
    CameraCadence,
    SceneCommit,
    StartupBarrier,
    StartingPublished,
    FfmpegSpawn,
    BridgeFifoOpen,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    BridgeMfStartup,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    BridgeMftEnumerate,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    BridgeMftActivate,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    BridgeInputSetup,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    BridgeMftConfigure,
    /// The writer adopted the standby encoder built while idle, in place of
    /// `bridge-mf-startup` … `bridge-mft-configure` (`windows_mf_standby`).
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    BridgeMftStandby,
    BridgeFirstFrame,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    BridgeFirstInput,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    BridgeOutputRenegotiated,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    BridgeFirstOutput,
    BridgeReady,
    MuxerProgress,
    Running,
}

impl RecordingStartPhase {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Admission => "admission",
            Self::BridgeAdmission => "bridge-admission",
            Self::FfmpegWorkPermit => "ffmpeg-work-permit",
            Self::RecordableVideoProbe => "recordable-video-probe",
            Self::PreviewStop => "preview-stop",
            Self::DeviceResolve => "device-resolve",
            Self::AudioOpen => "audio-open",
            Self::MicWarm => "mic-warm",
            Self::CompositorArm => "compositor-arm",
            Self::CameraCadence => "camera-cadence",
            Self::SceneCommit => "scene-commit",
            Self::StartupBarrier => "startup-barrier",
            Self::StartingPublished => "starting-published",
            Self::FfmpegSpawn => "ffmpeg-spawn",
            Self::BridgeFifoOpen => "bridge-fifo-open",
            Self::BridgeMfStartup => "bridge-mf-startup",
            Self::BridgeMftEnumerate => "bridge-mft-enumerate",
            Self::BridgeMftActivate => "bridge-mft-activate",
            Self::BridgeInputSetup => "bridge-input-setup",
            Self::BridgeMftConfigure => "bridge-mft-configure",
            Self::BridgeMftStandby => "bridge-mft-standby",
            Self::BridgeFirstFrame => "bridge-first-frame",
            Self::BridgeFirstInput => "bridge-first-input",
            Self::BridgeOutputRenegotiated => "bridge-output-renegotiated",
            Self::BridgeFirstOutput => "bridge-first-output",
            Self::BridgeReady => "bridge-ready",
            Self::MuxerProgress => "muxer-progress",
            Self::Running => "running",
        }
    }
}

/// Phase boundaries of a stop, including the background finalization tail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordingStopPhase {
    Intent,
    StoppingPublished,
    FfmpegExit,
    BridgeStopped,
    CaptionsDrained,
    MkvBound,
    Mp4Export,
    Captions,
    Probe,
    DbCommit,
    Terminal,
    Finalized,
}

impl RecordingStopPhase {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Intent => "intent",
            Self::StoppingPublished => "stopping-published",
            Self::FfmpegExit => "ffmpeg-exit",
            Self::BridgeStopped => "bridge-stopped",
            Self::CaptionsDrained => "captions-drained",
            Self::MkvBound => "mkv-bound",
            Self::Mp4Export => "mp4-export",
            Self::Captions => "captions",
            Self::Probe => "probe",
            Self::DbCommit => "db-commit",
            Self::Terminal => "terminal",
            Self::Finalized => "finalized",
        }
    }
}

pub trait TimelinePhase: Copy + PartialEq {
    fn label(self) -> &'static str;
}

impl TimelinePhase for RecordingStartPhase {
    fn label(self) -> &'static str {
        RecordingStartPhase::label(self)
    }
}

impl TimelinePhase for RecordingStopPhase {
    fn label(self) -> &'static str {
        RecordingStopPhase::label(self)
    }
}

#[derive(Debug, Clone)]
pub struct RecordingTimeline<P: TimelinePhase> {
    kind: &'static str,
    origin: Instant,
    session_id: Option<String>,
    cold: Option<bool>,
    requested_at_epoch_ms: Option<u64>,
    click_to_origin_ms: Option<u64>,
    marks: Vec<(P, u64)>,
}

pub type RecordingStartTimeline = RecordingTimeline<RecordingStartPhase>;
pub type RecordingStopTimeline = RecordingTimeline<RecordingStopPhase>;

impl RecordingStartTimeline {
    /// `cold` is true for the first start in this backend process.
    pub fn start(requested_at_epoch_ms: Option<u64>, cold: bool) -> Self {
        Self::new("start", requested_at_epoch_ms, Some(cold))
    }
}

impl RecordingStopTimeline {
    pub fn stop(requested_at_epoch_ms: Option<u64>) -> Self {
        Self::new("stop", requested_at_epoch_ms, None)
    }
}

impl<P: TimelinePhase> RecordingTimeline<P> {
    fn new(kind: &'static str, requested_at_epoch_ms: Option<u64>, cold: Option<bool>) -> Self {
        let now_epoch_ms = u64::try_from(Utc::now().timestamp_millis()).unwrap_or(0);
        Self {
            kind,
            origin: Instant::now(),
            session_id: None,
            cold,
            requested_at_epoch_ms,
            click_to_origin_ms: click_to_origin_ms(now_epoch_ms, requested_at_epoch_ms),
            marks: Vec::with_capacity(16),
        }
    }

    pub fn set_session_id(&mut self, session_id: &str) {
        if self.session_id.is_none() {
            self.session_id = Some(session_id.to_string());
        }
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    /// Records the phase boundary. First-wins and monotonic: a phase marked
    /// twice keeps its first time, and a mark never reads earlier than the
    /// previous one.
    pub fn mark(&mut self, phase: P) {
        self.mark_at(phase, Instant::now());
    }

    /// [`Self::mark`] for a boundary another thread stamped at `at`. The same
    /// first-wins and monotonic rules apply, so fold stamps in time order.
    pub fn mark_at(&mut self, phase: P, at: Instant) {
        if self.marks.iter().any(|(existing, _)| *existing == phase) {
            return;
        }
        let elapsed = at.saturating_duration_since(self.origin).as_millis();
        let at_ms = u64::try_from(elapsed).unwrap_or(u64::MAX);
        let floor = self.marks.last().map(|(_, at)| *at).unwrap_or(0);
        let at_ms = at_ms.max(floor);
        // One INFO line per phase so a start or stop that hangs shows exactly
        // where it stopped in the app log / support bundle.
        tracing::info!(
            kind = self.kind,
            session = self.session_id.as_deref().unwrap_or("-"),
            phase = phase.label(),
            at_ms,
            delta_ms = at_ms.saturating_sub(floor),
            "recording timeline mark"
        );
        self.marks.push((phase, at_ms));
    }

    pub fn elapsed_ms(&self) -> u64 {
        u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    pub fn snapshot(&self, outcome: &str) -> RecordingTimelineSnapshot {
        let total_ms = self
            .marks
            .last()
            .map(|(_, at)| *at)
            .unwrap_or_else(|| self.elapsed_ms());
        RecordingTimelineSnapshot {
            kind: self.kind.to_string(),
            session_id: self.session_id.clone(),
            cold: self.cold,
            requested_at_epoch_ms: self.requested_at_epoch_ms,
            click_to_origin_ms: self.click_to_origin_ms,
            total_ms,
            outcome: outcome.to_string(),
            marks: self
                .marks
                .iter()
                .map(|(phase, at_ms)| RecordingTimelineMark {
                    phase: phase.label().to_string(),
                    at_ms: *at_ms,
                })
                .collect(),
        }
    }

    /// One-line `key=value` summary persisted as a health event / session log:
    /// `total=412ms outcome=running cold=true clickToOrigin=18ms admission=+3 ...`
    /// where each phase value is the delta since the previous mark.
    pub fn summary_line(&self, outcome: &str) -> String {
        let snapshot = self.snapshot(outcome);
        let mut parts = vec![
            format!("total={}ms", snapshot.total_ms),
            format!("outcome={outcome}"),
        ];
        if let Some(cold) = snapshot.cold {
            parts.push(format!("cold={cold}"));
        }
        if let Some(click_to_origin_ms) = snapshot.click_to_origin_ms {
            parts.push(format!("clickToOrigin={click_to_origin_ms}ms"));
        }
        let mut previous = 0;
        for mark in &snapshot.marks {
            parts.push(format!(
                "{}=+{}",
                mark.phase,
                mark.at_ms.saturating_sub(previous)
            ));
            previous = mark.at_ms;
        }
        parts.join(" ")
    }
}

/// Start-step stamps taken on an encoder bridge's writer thread (#1267).
///
/// First-wins per phase, infallible, and never load-bearing: the session
/// reads [`Self::ordered`] once the bridge is ready and folds each stamp into
/// its start timeline with [`RecordingTimeline::mark_at`].
#[derive(Debug, Default)]
pub struct BridgeStartupTrace {
    stamps: Mutex<Vec<(RecordingStartPhase, Instant)>>,
}

impl BridgeStartupTrace {
    pub fn stamp(&self, phase: RecordingStartPhase) {
        self.stamp_at(phase, Instant::now());
    }

    pub fn stamp_at(&self, phase: RecordingStartPhase, at: Instant) {
        let mut stamps = self.stamps.lock().unwrap_or_else(|p| p.into_inner());
        if !stamps.iter().any(|(existing, _)| *existing == phase) {
            stamps.push((phase, at));
        }
    }

    /// The stamps in time order (a stable sort keeps stamping order on ties).
    pub fn ordered(&self) -> Vec<(RecordingStartPhase, Instant)> {
        let mut stamps = self
            .stamps
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        stamps.sort_by_key(|(_, at)| *at);
        stamps
    }
}

/// Renderer click → backend admission, computed only when the renderer sent a
/// plausible epoch timestamp (same machine, bounded skew).
pub fn click_to_origin_ms(now_epoch_ms: u64, requested_at_epoch_ms: Option<u64>) -> Option<u64> {
    let requested = requested_at_epoch_ms?;
    let delta = now_epoch_ms.checked_sub(requested)?;
    (delta <= MAX_CLICK_TO_ORIGIN_MS).then_some(delta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_are_first_wins_and_monotonic() {
        let mut timeline = RecordingStartTimeline::start(None, true);
        timeline.mark(RecordingStartPhase::Admission);
        timeline.mark(RecordingStartPhase::DeviceResolve);
        timeline.mark(RecordingStartPhase::Admission);
        let snapshot = timeline.snapshot("running");
        assert_eq!(snapshot.marks.len(), 2);
        assert_eq!(snapshot.marks[0].phase, "admission");
        assert_eq!(snapshot.marks[1].phase, "device-resolve");
        assert!(snapshot.marks[1].at_ms >= snapshot.marks[0].at_ms);
        assert_eq!(snapshot.cold, Some(true));
        assert_eq!(snapshot.kind, "start");
        assert_eq!(snapshot.outcome, "running");
    }

    #[test]
    fn start_sub_marks_sit_between_admission_and_device_resolve() {
        // Plan 195 S1: the new marks keep `device-resolve` where scripts
        // expect it and report in start order.
        let mut timeline = RecordingStartTimeline::start(None, false);
        for phase in [
            RecordingStartPhase::Admission,
            RecordingStartPhase::BridgeAdmission,
            RecordingStartPhase::FfmpegWorkPermit,
            RecordingStartPhase::RecordableVideoProbe,
            RecordingStartPhase::PreviewStop,
            RecordingStartPhase::DeviceResolve,
        ] {
            timeline.mark(phase);
        }
        let phases: Vec<_> = timeline
            .snapshot("running")
            .marks
            .iter()
            .map(|mark| mark.phase.clone())
            .collect();
        assert_eq!(
            phases,
            [
                "admission",
                "bridge-admission",
                "ffmpeg-work-permit",
                "recordable-video-probe",
                "preview-stop",
                "device-resolve",
            ]
        );
        let line = timeline.summary_line("running");
        assert!(line.contains(" recordable-video-probe=+"), "{line}");
        assert!(line.contains(" device-resolve=+"), "{line}");
    }

    #[test]
    fn click_to_origin_rejects_missing_future_and_skewed_input() {
        assert_eq!(click_to_origin_ms(1_000, None), None);
        assert_eq!(click_to_origin_ms(1_000, Some(2_000)), None);
        assert_eq!(click_to_origin_ms(100_000, Some(1_000)), None);
        assert_eq!(click_to_origin_ms(1_500, Some(1_000)), Some(500));
        assert_eq!(
            click_to_origin_ms(MAX_CLICK_TO_ORIGIN_MS, Some(0)),
            Some(MAX_CLICK_TO_ORIGIN_MS)
        );
    }

    #[test]
    fn snapshot_serializes_camel_case_and_omits_none() {
        let mut timeline = RecordingStopTimeline::stop(None);
        timeline.set_session_id("s-1");
        timeline.mark(RecordingStopPhase::Intent);
        let json = serde_json::to_value(timeline.snapshot("idle")).unwrap();
        assert_eq!(json["kind"], "stop");
        assert_eq!(json["sessionId"], "s-1");
        assert_eq!(json["outcome"], "idle");
        assert!(json.get("cold").is_none(), "{json}");
        assert!(json.get("clickToOriginMs").is_none(), "{json}");
        assert!(json.get("requestedAtEpochMs").is_none(), "{json}");
        assert_eq!(json["marks"][0]["phase"], "intent");
        assert!(json["marks"][0]["atMs"].is_u64());
        assert!(json["totalMs"].is_u64());
    }

    #[test]
    fn summary_line_carries_total_outcome_and_phase_deltas() {
        let mut timeline = RecordingStartTimeline::start(None, false);
        timeline.mark(RecordingStartPhase::Admission);
        timeline.mark(RecordingStartPhase::Running);
        let line = timeline.summary_line("running");
        assert!(line.starts_with("total="), "{line}");
        assert!(line.contains(" outcome=running"), "{line}");
        assert!(line.contains(" cold=false"), "{line}");
        assert!(line.contains(" admission=+"), "{line}");
        assert!(line.contains(" running=+"), "{line}");
        assert!(!line.contains("clickToOrigin"), "{line}");
    }

    #[test]
    fn bridge_trace_folds_into_the_timeline_in_time_order() {
        // #1267: the writer thread stamps steps out of the session's sight;
        // the session folds them in before `bridge-ready`.
        use std::time::Duration;
        let mut timeline = RecordingStartTimeline::start(None, false);
        timeline.mark(RecordingStartPhase::FfmpegSpawn);
        let base = Instant::now();
        let trace = BridgeStartupTrace::default();
        trace.stamp_at(
            RecordingStartPhase::BridgeFirstOutput,
            base + Duration::from_millis(30),
        );
        trace.stamp_at(RecordingStartPhase::BridgeFifoOpen, base);
        trace.stamp_at(
            RecordingStartPhase::BridgeFirstInput,
            base + Duration::from_millis(10),
        );
        // First-wins: a later stamp of the same step is ignored.
        trace.stamp_at(
            RecordingStartPhase::BridgeFifoOpen,
            base + Duration::from_millis(50),
        );
        for (phase, at) in trace.ordered() {
            timeline.mark_at(phase, at);
        }
        timeline.mark(RecordingStartPhase::BridgeReady);
        let snapshot = timeline.snapshot("running");
        let phases: Vec<_> = snapshot
            .marks
            .iter()
            .map(|mark| mark.phase.as_str())
            .collect();
        assert_eq!(
            phases,
            [
                "ffmpeg-spawn",
                "bridge-fifo-open",
                "bridge-first-input",
                "bridge-first-output",
                "bridge-ready",
            ]
        );
        let at = |phase: &str| {
            snapshot
                .marks
                .iter()
                .find(|mark| mark.phase == phase)
                .unwrap()
                .at_ms
        };
        assert!(at("bridge-first-output") >= at("bridge-first-input") + 20);
        assert!(at("bridge-ready") >= at("bridge-first-output"));
    }

    #[test]
    fn mark_at_before_the_origin_reads_as_zero() {
        let early = Instant::now();
        let mut timeline = RecordingStartTimeline::start(None, false);
        timeline.mark_at(RecordingStartPhase::Admission, early);
        assert_eq!(timeline.snapshot("running").marks[0].at_ms, 0);
    }

    #[test]
    fn session_id_is_set_once() {
        let mut timeline = RecordingStartTimeline::start(None, true);
        timeline.set_session_id("first");
        timeline.set_session_id("second");
        assert_eq!(timeline.session_id(), Some("first"));
    }
}
