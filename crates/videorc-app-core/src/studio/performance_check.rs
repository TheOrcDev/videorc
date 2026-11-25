//! Plan 212's performance check on the Output page (P655), from
//! `lib/performance-check.ts`, `lib/performance-check-line.ts` and
//! use-studio's `requestPerformanceCheck`.
//!
//! - **The state:** `performance.check.get` on every connection, then
//!   `performance.check.progress` (which rung) and `.completed` (the new
//!   state). The snapshot's [`PerformanceView`] carries both.
//! - **The run** ("Check this computer"): the check holds the session slot.
//!   The Clips ring steps aside first (a buffer-only session stops and the
//!   ring waits while [`PerformanceView::hold`] is set), the preview keeps
//!   its scene, then `performance.check.run` goes out with the ceiling. The
//!   hold ends when the check completes or the request fails.
//! - **The line** under the preset select: [`performance_line`].

use std::time::{Duration, Instant};

use serde_json::Value;
use videorc_protocol::{
    PerformanceCheckNotRecorded, PerformanceCheckProgress, PerformanceCheckResult,
    PerformanceCheckRunParams, PerformanceCheckRungVerdict, PerformanceCheckState, RecordingState,
    VideoPreset, VideoSettings,
};

use super::inspector::format_video_quality;
use super::session::session_is_replay_only;
use super::{Studio, StudioBackend};

pub const GET_METHOD: &str = "performance.check.get";
pub const RUN_METHOD: &str = "performance.check.run";
pub const PROGRESS_EVENT: &str = "performance.check.progress";
pub const COMPLETED_EVENT: &str = "performance.check.completed";

/// How long the ring's stop may take before the check runs anyway.
const RING_STOP_WAIT: Duration = Duration::from_secs(5);
const MAX_CEILING_PIXELS: u64 = 3840 * 2160;

/// What the Output page reads.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PerformanceView {
    /// `None` until the backend answered (an older one never does, and the
    /// page stays quiet).
    pub state: Option<PerformanceCheckState>,
    pub progress: Option<PerformanceCheckProgress>,
    /// A check this app started is running: the ring and the preview wait.
    pub hold: bool,
}

/// How a given output stands against what this computer measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputVerdict {
    Verified,
    TooHeavy,
    Unknown,
}

fn pixels(width: u32, height: u32) -> u64 {
    u64::from(width) * u64::from(height)
}

/// `a` is at least as demanding as `b` in both resolution and frame rate.
fn dominates(a: &VideoSettings, b: &VideoSettings) -> bool {
    pixels(a.width, a.height) >= pixels(b.width, b.height) && a.fps >= b.fps
}

fn label(video: &VideoSettings) -> String {
    format_video_quality(video.width, video.height, video.fps)
}

/// `isUntrustedPerformanceCheckResult`: Linux v1's `belowFloor` with every
/// measured rung `did-not-start` is a failed ladder, not a machine class.
pub fn is_untrusted(result: &PerformanceCheckResult) -> bool {
    if !result.below_floor || !result.capability_key.starts_with("performance-check-v1:") {
        return false;
    }
    let measured: Vec<_> = result
        .rungs
        .iter()
        .filter(|rung| rung.verdict != PerformanceCheckRungVerdict::Skipped)
        .collect();
    !measured.is_empty()
        && measured.iter().all(|rung| {
            rung.verdict == PerformanceCheckRungVerdict::Failed
                && rung.reasons.iter().any(|reason| reason == "did-not-start")
        })
}

/// `outputVerdict`.
pub fn output_verdict(
    video: &VideoSettings,
    result: Option<&PerformanceCheckResult>,
) -> OutputVerdict {
    let Some(result) = result.filter(|result| !is_untrusted(result)) else {
        return OutputVerdict::Unknown;
    };
    if result.rungs.iter().any(|rung| {
        rung.verdict == PerformanceCheckRungVerdict::Passed && dominates(&rung.video, video)
    }) {
        return OutputVerdict::Verified;
    }
    if result.rungs.iter().any(|rung| {
        rung.verdict == PerformanceCheckRungVerdict::Failed && dominates(video, &rung.video)
    }) {
        return OutputVerdict::TooHeavy;
    }
    OutputVerdict::Unknown
}

/// `performanceCheckCeiling`: the largest output worth testing, the
/// selected one or the display's native size when larger (capped at 4K).
/// `display` is in device pixels.
pub fn ceiling(
    selected: &VideoSettings,
    display: Option<(u32, u32)>,
    separate_source_recordings: bool,
) -> PerformanceCheckRunParams {
    let ceiling_fps = selected.fps.max(30);
    let (ceiling_width, ceiling_height) = match display {
        Some((width, height))
            if pixels(width, height) > pixels(selected.width, selected.height) =>
        {
            if pixels(width, height) > MAX_CEILING_PIXELS {
                (3840, 2160)
            } else {
                (width, height)
            }
        }
        _ => (selected.width, selected.height),
    };
    PerformanceCheckRunParams {
        ceiling_width,
        ceiling_height,
        ceiling_fps,
        separate_source_recordings,
    }
}

/// The line's tone: the warning rides on the icon, the words stay plain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineTone {
    Muted,
    Warning,
}

/// `PerformanceCheckLine`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PerformanceLine {
    pub tone: LineTone,
    pub busy: bool,
    pub text: String,
    /// "Use {recommended}" next to the text.
    pub apply: Option<(VideoPreset, String)>,
    /// "Check this computer" or "Check again".
    pub check_label: Option<&'static str>,
    /// What pressing the check costs, for its tooltip.
    pub check_hint: Option<&'static str>,
}

pub const CHECK_THIS_COMPUTER: &str = "Check this computer";
pub const CHECK_AGAIN: &str = "Check again";
pub const HINT: &str = "Takes about 20 seconds.";
pub const HINT_CLIPS: &str = "Takes about 20 seconds. Clips pauses while it runs.";

/// `performanceCheckLine`: the one line under the preset select. `None`
/// until the backend answered. `device_noun` is "Mac", "PC" or "computer".
pub fn performance_line(
    view: &PerformanceView,
    video: &VideoSettings,
    device_noun: &str,
    clips_on: bool,
) -> Option<PerformanceLine> {
    let mut line = line_words(view, video, device_noun)?;
    if line.check_label.is_some() {
        line.check_hint = Some(if clips_on { HINT_CLIPS } else { HINT });
    }
    Some(line)
}

fn line_words(
    view: &PerformanceView,
    video: &VideoSettings,
    device_noun: &str,
) -> Option<PerformanceLine> {
    let state = view.state.as_ref()?;
    let line = |tone: LineTone, text: String, check: Option<&'static str>| PerformanceLine {
        tone,
        busy: false,
        text,
        apply: None,
        check_label: check,
        check_hint: None,
    };
    if state.running || view.hold {
        let text = match &view.progress {
            Some(progress) => format!(
                "Checking what this computer can record… {}",
                label(&progress.video)
            ),
            None => "Checking what this computer can record…".into(),
        };
        return Some(PerformanceLine {
            busy: true,
            ..line(LineTone::Muted, text, None)
        });
    }
    // Plan 212 D3: a busy computer records nothing and keeps the verdict.
    if state.last_run_not_recorded == Some(PerformanceCheckNotRecorded::HostBusy) {
        return Some(line(
            LineTone::Warning,
            format!(
                "Your {device_noun} was busy, so the check stopped. Try again when it's quieter."
            ),
            Some(CHECK_AGAIN),
        ));
    }
    let Some(result) = state.result.as_ref().filter(|result| !is_untrusted(result)) else {
        return Some(line(
            LineTone::Muted,
            format!("Not checked on this {device_noun} yet."),
            Some(CHECK_THIS_COMPUTER),
        ));
    };
    // Plan 212 D1: the check never reruns on its own.
    if state.stale {
        return Some(line(
            LineTone::Muted,
            format!("Your {device_noun} changed since the last check."),
            Some(CHECK_AGAIN),
        ));
    }
    if result.below_floor {
        return Some(line(
            LineTone::Warning,
            format!(
                "Nothing held steady on this computer, not even {}. Close other apps and check again.",
                label(&result.recommended)
            ),
            Some(CHECK_AGAIN),
        ));
    }
    let recommended = label(&result.recommended);
    let same = pixels(video.width, video.height)
        == pixels(result.recommended.width, result.recommended.height)
        && video.fps == result.recommended.fps;
    let offer = (!same).then(|| {
        (
            result.recommended.preset.clone(),
            format!("Use {recommended}"),
        )
    });
    Some(match output_verdict(video, Some(result)) {
        OutputVerdict::Verified => line(
            LineTone::Muted,
            format!("{} is verified for this computer.", label(video)),
            Some(CHECK_AGAIN),
        ),
        OutputVerdict::TooHeavy => PerformanceLine {
            apply: offer,
            ..line(
                LineTone::Warning,
                format!(
                    "{} is too heavy for this computer. Recordings will stutter. {recommended} held steady.",
                    label(video)
                ),
                Some(CHECK_AGAIN),
            )
        },
        OutputVerdict::Unknown => PerformanceLine {
            apply: offer,
            ..line(
                LineTone::Muted,
                format!(
                    "{} hasn't been measured. {recommended} held steady.",
                    label(video)
                ),
                Some(CHECK_AGAIN),
            )
        },
    })
}

impl<B: StudioBackend> Studio<B> {
    /// `performance.check.get`, on every connection. An older backend has
    /// no such method: the line stays away.
    pub(super) async fn read_performance_check(&self, generation: u64) {
        let Ok(answer) = self
            .backend
            .performance_request(GET_METHOD, Value::Null)
            .await
        else {
            return;
        };
        let Ok(state) = serde_json::from_value::<PerformanceCheckState>(answer) else {
            return;
        };
        {
            let mut inner = self.lock();
            if inner.bootstrap_generation != generation {
                return;
            }
            inner.performance.state = Some(state);
        }
        self.publish();
    }

    /// The check's two events. True when the event was one of them.
    pub(super) fn handle_performance_event(&self, event: &str, payload: &Value) -> bool {
        match event {
            PROGRESS_EVENT => {
                let Ok(progress) = serde_json::from_value(payload.clone()) else {
                    return true;
                };
                self.lock().performance.progress = Some(progress);
            }
            COMPLETED_EVENT => {
                let Ok(state) = serde_json::from_value(payload.clone()) else {
                    return true;
                };
                let mut inner = self.lock();
                inner.performance.state = Some(state);
                inner.performance.progress = None;
                inner.performance.hold = false;
            }
            _ => return false,
        }
        self.publish();
        true
    }

    /// "Check this computer" (`requestPerformanceCheck`): the ring steps
    /// aside, then the run. `Err` carries the refusal's words.
    pub async fn run_performance_check(
        &self,
        params: PerformanceCheckRunParams,
    ) -> Result<(), String> {
        {
            let mut inner = self.lock();
            if inner.performance.hold {
                return Ok(());
            }
            inner.performance.hold = true;
            inner.performance.progress = None;
        }
        self.publish();
        let replay_only = session_is_replay_only(self.lock().session.status());
        if replay_only {
            self.stop_buffer_only_session().await;
            let deadline = Instant::now() + RING_STOP_WAIT;
            while Instant::now() < deadline
                && self.lock().session.status().state != RecordingState::Idle
            {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        let params = serde_json::to_value(&params).map_err(|error| error.to_string())?;
        match self.backend.performance_request(RUN_METHOD, params).await {
            Ok(answer) => {
                if let Ok(state) = serde_json::from_value::<PerformanceCheckState>(answer) {
                    let mut inner = self.lock();
                    // A check that answered already finished releases now.
                    if !state.running {
                        inner.performance.hold = false;
                    }
                    inner.performance.state = Some(state);
                }
                self.publish();
                Ok(())
            }
            Err(error) => {
                self.lock().performance.hold = false;
                self.publish();
                Err(error.message)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn video(width: u32, height: u32, fps: u32) -> VideoSettings {
        serde_json::from_value(json!({
            "preset": "custom",
            "width": width,
            "height": height,
            "fps": fps,
            "bitrateKbps": 8000,
        }))
        .expect("video")
    }

    fn result(rungs: serde_json::Value, below_floor: bool, key: &str) -> PerformanceCheckResult {
        serde_json::from_value(json!({
            "capabilityKey": key,
            "checkedAt": "2026-11-25T00:00:00Z",
            "appVersion": "0.0.0",
            "durationMs": 1,
            "recommended": {
                "preset": "tutorial-1080p30",
                "width": 1920,
                "height": 1080,
                "fps": 30,
                "bitrateKbps": 8000
            },
            "belowFloor": below_floor,
            "rungs": rungs,
        }))
        .expect("result")
    }

    fn rung(width: u32, height: u32, fps: u32, verdict: &str) -> serde_json::Value {
        json!({
            "video": { "preset": "custom", "width": width, "height": height, "fps": fps, "bitrateKbps": 8000 },
            "verdict": verdict,
            "reasons": if verdict == "failed" { vec!["did-not-start"] } else { Vec::new() },
        })
    }

    fn view(state: serde_json::Value) -> PerformanceView {
        PerformanceView {
            state: Some(serde_json::from_value(state).expect("state")),
            ..PerformanceView::default()
        }
    }

    #[test]
    fn the_verdict_reads_the_rungs() {
        let measured = result(
            json!([
                rung(2560, 1440, 30, "failed"),
                rung(1920, 1080, 30, "passed")
            ]),
            false,
            "performance-check-v2:x",
        );
        assert_eq!(
            output_verdict(&video(1280, 720, 30), Some(&measured)),
            OutputVerdict::Verified
        );
        assert_eq!(
            output_verdict(&video(3840, 2160, 30), Some(&measured)),
            OutputVerdict::TooHeavy
        );
        assert_eq!(
            output_verdict(&video(1920, 1080, 60), Some(&measured)),
            OutputVerdict::Unknown
        );
        let untrusted = result(
            json!([rung(1280, 720, 30, "failed")]),
            true,
            "performance-check-v1:linux",
        );
        assert!(is_untrusted(&untrusted));
        assert_eq!(
            output_verdict(&video(640, 360, 30), Some(&untrusted)),
            OutputVerdict::Unknown
        );
    }

    #[test]
    fn the_line_says_each_state() {
        let v = video(2560, 1440, 30);
        assert_eq!(
            performance_line(&PerformanceView::default(), &v, "Mac", false),
            None
        );
        let unchecked = performance_line(
            &view(json!({"running": false, "stale": false})),
            &v,
            "Mac",
            true,
        )
        .unwrap();
        assert_eq!(unchecked.text, "Not checked on this Mac yet.");
        assert_eq!(unchecked.check_label, Some(CHECK_THIS_COMPUTER));
        assert_eq!(unchecked.check_hint, Some(HINT_CLIPS));
        let running = performance_line(
            &view(json!({"running": true, "stale": false})),
            &v,
            "Mac",
            false,
        )
        .unwrap();
        assert!(running.busy);
        assert_eq!(running.check_label, None);
        let busy = performance_line(
            &view(json!({"running": false, "stale": false, "lastRunNotRecorded": "host-busy"})),
            &v,
            "PC",
            false,
        )
        .unwrap();
        assert_eq!(busy.tone, LineTone::Warning);
        assert!(busy.text.starts_with("Your PC was busy"));
        let heavy_state = json!({
            "running": false,
            "stale": false,
            "result": serde_json::to_value(result(
                json!([rung(2560, 1440, 30, "failed"), rung(1920, 1080, 30, "passed")]),
                false,
                "performance-check-v2:x",
            )).unwrap(),
        });
        let heavy = performance_line(&view(heavy_state), &v, "Mac", false).unwrap();
        assert_eq!(heavy.tone, LineTone::Warning);
        assert_eq!(
            heavy.apply,
            Some((VideoPreset::Tutorial1080p30, "Use 1080p · 30 fps".into()))
        );
    }

    #[test]
    fn the_ceiling_is_the_larger_of_the_output_and_the_display() {
        let selected = video(1920, 1080, 30);
        let same = ceiling(&selected, Some((1440, 900)), false);
        assert_eq!(
            (same.ceiling_width, same.ceiling_height, same.ceiling_fps),
            (1920, 1080, 30)
        );
        let retina = ceiling(&selected, Some((2880, 1800)), true);
        assert_eq!((retina.ceiling_width, retina.ceiling_height), (2880, 1800));
        assert!(retina.separate_source_recordings);
        let huge = ceiling(&video(1280, 720, 60), Some((5120, 2880)), false);
        assert_eq!(
            (huge.ceiling_width, huge.ceiling_height, huge.ceiling_fps),
            (3840, 2160, 60)
        );
    }
}
