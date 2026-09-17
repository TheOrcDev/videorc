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

use std::time::Instant;

use chrono::Utc;

use crate::protocol::{RecordingTimelineMark, RecordingTimelineSnapshot};

/// Renderer-supplied click timestamps older than this are treated as clock
/// skew and dropped rather than reported as latency.
pub const MAX_CLICK_TO_ORIGIN_MS: u64 = 60_000;

/// Phase boundaries of `start_session`, in the order they normally complete.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordingStartPhase {
    Admission,
    DeviceResolve,
    AudioOpen,
    MicWarm,
    CompositorArm,
    CameraCadence,
    SceneCommit,
    StartupBarrier,
    StartingPublished,
    FfmpegSpawn,
    BridgeReady,
    MuxerProgress,
    Running,
}

impl RecordingStartPhase {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Admission => "admission",
            Self::DeviceResolve => "device-resolve",
            Self::AudioOpen => "audio-open",
            Self::MicWarm => "mic-warm",
            Self::CompositorArm => "compositor-arm",
            Self::CameraCadence => "camera-cadence",
            Self::SceneCommit => "scene-commit",
            Self::StartupBarrier => "startup-barrier",
            Self::StartingPublished => "starting-published",
            Self::FfmpegSpawn => "ffmpeg-spawn",
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
        if self.marks.iter().any(|(existing, _)| *existing == phase) {
            return;
        }
        let elapsed = self.origin.elapsed().as_millis();
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
    fn session_id_is_set_once() {
        let mut timeline = RecordingStartTimeline::start(None, true);
        timeline.set_session_id("first");
        timeline.set_session_id("second");
        assert_eq!(timeline.session_id(), Some("first"));
    }
}
