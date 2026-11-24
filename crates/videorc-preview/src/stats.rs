//! The layer route's measurements, summarised one way for both spikes.
//!
//! Per presented frame: how long the presenter waited for each layer's
//! drawable, when it committed, how long the GPU took, and when the display
//! showed the drawable (`presentedTime`, Core Animation's clock, converted to
//! `Instant`). Per resize step: when the UI set the layer's frame and when
//! Core Animation's presentation tree first showed that frame.

use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::LayerRect;

/// How the presenter got the frame's texture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportKind {
    /// The IOSurface was in the presenter's cache.
    Cached,
    /// A fresh `newTextureWithDescriptor:iosurface:plane:`.
    Imported,
}

/// One layer's part of one presented frame.
#[derive(Debug, Clone)]
pub struct LayerPresentRecord {
    /// 0 = the main window's docked layer, 1 = the floating window's.
    pub layer: u8,
    /// `nextDrawable` blocked this long.
    pub drawable_wait: Duration,
    /// The command buffer was committed.
    pub committed_at: Instant,
    /// `GPUEndTime - GPUStartTime` of that command buffer.
    pub gpu_time: Duration,
    /// The drawable's `presentedTime`, when the handler ran.
    pub presented_at: Option<Instant>,
}

/// A drawable's `presentedTime`, delivered by its presented handler, in the
/// run's clock.
#[derive(Debug, Clone, Copy)]
pub struct PresentedStamp {
    pub frame_id: u64,
    pub layer: u8,
    pub presented_at: Instant,
}

/// Writes the display's stamps into their frames' layer records (the first
/// stamp per frame and layer counts). Returns how many found no record.
pub fn attach_stamps(records: &mut [LayerFrameRecord], stamps: &[PresentedStamp]) -> usize {
    let mut orphans = 0;
    for stamp in stamps {
        let slot = records
            .iter_mut()
            .rev()
            .find(|record| record.frame_id == stamp.frame_id)
            .and_then(|record| {
                record
                    .layers
                    .iter_mut()
                    .find(|layer| layer.layer == stamp.layer)
            });
        match slot {
            Some(layer) => {
                layer.presented_at.get_or_insert(stamp.presented_at);
            }
            None => orphans += 1,
        }
    }
    orphans
}

/// One frame the presenter drew.
#[derive(Debug, Clone)]
pub struct LayerFrameRecord {
    pub frame_id: u64,
    /// The presenter thread picked the frame up.
    pub started_at: Instant,
    pub import: ImportKind,
    pub import_time: Duration,
    pub layers: Vec<LayerPresentRecord>,
    /// Every layer's command buffer completed on the GPU.
    pub gpu_done_at: Instant,
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

pub(crate) fn percentile(values: &[f64], p: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let index = ((sorted.len() - 1) as f64 * p / 100.0).round() as usize;
    Some(sorted[index.min(sorted.len() - 1)])
}

/// p50/p95/p99/max/mean of a millisecond series.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Series {
    pub n: usize,
    pub p50: Option<f64>,
    pub p95: Option<f64>,
    pub p99: Option<f64>,
    pub max: Option<f64>,
    pub mean: Option<f64>,
}

impl Series {
    pub fn of(values: &[f64]) -> Self {
        Self {
            n: values.len(),
            p50: percentile(values, 50.0),
            p95: percentile(values, 95.0),
            p99: percentile(values, 99.0),
            max: values.iter().copied().reduce(f64::max),
            mean: if values.is_empty() {
                None
            } else {
                Some(values.iter().sum::<f64>() / values.len() as f64)
            },
        }
    }

    pub fn json(&self) -> Value {
        json!({
            "n": self.n, "p50": self.p50, "p95": self.p95, "p99": self.p99, "max": self.max, "mean": self.mean
        })
    }

    pub fn text(&self) -> String {
        let fmt =
            |value: Option<f64>| value.map_or_else(|| "n/a".to_string(), |v| format!("{v:.2}"));
        format!(
            "p50 {} ms, p95 {} ms, p99 {} ms, max {} ms (n={})",
            fmt(self.p50),
            fmt(self.p95),
            fmt(self.p99),
            fmt(self.max),
            self.n
        )
    }
}

/// The intervals between consecutive values of a sorted series, in ms.
fn intervals(mut times: Vec<Instant>) -> Vec<f64> {
    times.sort();
    times
        .windows(2)
        .map(|pair| ms(pair[1].duration_since(pair[0])))
        .collect()
}

/// One layer's summary over a run.
#[derive(Debug, Clone)]
pub struct LayerSummary {
    pub layer: u8,
    pub frames: usize,
    pub drawable_wait_ms: Series,
    pub gpu_time_ms: Series,
    /// Commit to commit on the presenter thread.
    pub commit_interval_ms: Series,
    /// `presentedTime` to `presentedTime`: the display's view of the cadence.
    pub presented_interval_ms: Series,
    /// Presented intervals longer than two frame periods.
    pub presented_hitches: u64,
    /// Presented frames with no presented-time stamp (the handler never ran
    /// before the run ended, or the drawable was dropped).
    pub unstamped: u64,
    /// Commit to on-screen.
    pub commit_to_presented_ms: Series,
}

impl LayerSummary {
    pub fn json(&self) -> Value {
        json!({
            "layer": self.layer,
            "frames": self.frames,
            "drawableWaitMs": self.drawable_wait_ms.json(),
            "gpuTimeMs": self.gpu_time_ms.json(),
            "commitIntervalMs": self.commit_interval_ms.json(),
            "presentedIntervalMs": self.presented_interval_ms.json(),
            "presentedHitches": self.presented_hitches,
            "unstamped": self.unstamped,
            "commitToPresentedMs": self.commit_to_presented_ms.json(),
        })
    }
}

/// The whole layer route's summary.
#[derive(Debug, Clone)]
pub struct LayerRunSummary {
    pub frames: usize,
    pub imports: u64,
    pub cache_hits: u64,
    pub import_ms: Series,
    /// Presenter pick-up to every layer's GPU done: the presenter's own
    /// per-frame wall time.
    pub present_wall_ms: Series,
    pub layers: Vec<LayerSummary>,
}

impl LayerRunSummary {
    pub fn of(records: &[LayerFrameRecord], fps: u32) -> Self {
        let frame_period_ms = 1000.0 / f64::from(fps.max(1));
        let imports = records
            .iter()
            .filter(|r| r.import == ImportKind::Imported)
            .count() as u64;
        let cache_hits = records
            .iter()
            .filter(|r| r.import == ImportKind::Cached)
            .count() as u64;
        let import_ms: Vec<f64> = records
            .iter()
            .filter(|r| r.import == ImportKind::Imported)
            .map(|r| ms(r.import_time))
            .collect();
        let present_wall: Vec<f64> = records
            .iter()
            .map(|r| ms(r.gpu_done_at.saturating_duration_since(r.started_at)))
            .collect();
        let mut layer_ids: Vec<u8> = records
            .iter()
            .flat_map(|r| r.layers.iter().map(|l| l.layer))
            .collect();
        layer_ids.sort_unstable();
        layer_ids.dedup();
        let layers = layer_ids
            .into_iter()
            .map(|id| {
                let per: Vec<&LayerPresentRecord> = records
                    .iter()
                    .flat_map(|r| r.layers.iter().filter(|l| l.layer == id))
                    .collect();
                let presented: Vec<Instant> = per.iter().filter_map(|l| l.presented_at).collect();
                let presented_interval = intervals(presented);
                let presented_hitches = presented_interval
                    .iter()
                    .filter(|interval| **interval > 2.0 * frame_period_ms)
                    .count() as u64;
                LayerSummary {
                    layer: id,
                    frames: per.len(),
                    drawable_wait_ms: Series::of(
                        &per.iter().map(|l| ms(l.drawable_wait)).collect::<Vec<_>>(),
                    ),
                    gpu_time_ms: Series::of(
                        &per.iter().map(|l| ms(l.gpu_time)).collect::<Vec<_>>(),
                    ),
                    commit_interval_ms: Series::of(&intervals(
                        per.iter().map(|l| l.committed_at).collect(),
                    )),
                    presented_interval_ms: Series::of(&presented_interval),
                    presented_hitches,
                    unstamped: per.iter().filter(|l| l.presented_at.is_none()).count() as u64,
                    commit_to_presented_ms: Series::of(
                        &per.iter()
                            .filter_map(|l| {
                                l.presented_at
                                    .map(|t| ms(t.saturating_duration_since(l.committed_at)))
                            })
                            .collect::<Vec<_>>(),
                    ),
                }
            })
            .collect();
        Self {
            frames: records.len(),
            imports,
            cache_hits,
            import_ms: Series::of(&import_ms),
            present_wall_ms: Series::of(&present_wall),
            layers,
        }
    }

    pub fn json(&self) -> Value {
        json!({
            "frames": self.frames,
            "imports": self.imports,
            "cacheHits": self.cache_hits,
            "importMs": self.import_ms.json(),
            "presentWallMs": self.present_wall_ms.json(),
            "layers": self.layers.iter().map(LayerSummary::json).collect::<Vec<_>>(),
        })
    }

    pub fn text(&self) -> Vec<String> {
        let mut lines = vec![format!(
            "layer route: {} frames presented by the presenter thread; imports {} (cache hits {}), import {}; presenter wall per frame (pick-up to GPU done) {}",
            self.frames,
            self.imports,
            self.cache_hits,
            self.import_ms.text(),
            self.present_wall_ms.text()
        )];
        for layer in &self.layers {
            let name = if layer.layer == 0 { "main" } else { "floating" };
            lines.push(format!(
                "layer {name}: {} frames; drawable wait {}; GPU time per frame {}",
                layer.frames,
                layer.drawable_wait_ms.text(),
                layer.gpu_time_ms.text()
            ));
            lines.push(format!(
                "layer {name}: commit interval {}; presented interval (display, presentedTime) {}; hitches over 2 frame periods {}; unstamped {}; commit to presented {}",
                layer.commit_interval_ms.text(),
                layer.presented_interval_ms.text(),
                layer.presented_hitches,
                layer.unstamped,
                layer.commit_to_presented_ms.text()
            ));
        }
        lines
    }
}

/// One programmatic resize step: the UI laid the placeholder out and set the
/// layer's frame; the sampler then watched Core Animation's presentation tree
/// until it showed that frame.
#[derive(Debug, Clone)]
pub struct ResizeStep {
    pub rect: LayerRect,
    pub set_at: Instant,
    /// The first sample whose displayed frame matched `rect`.
    pub displayed_at: Option<Instant>,
    /// Samples taken before the match (or until the next step replaced it).
    pub samples_before_match: u32,
    /// The displayed frame when the step was superseded without a match.
    pub superseded_showing: Option<LayerRect>,
}

/// Collects resize steps on the UI thread: `on_set` when the UI sets the
/// layer frame, `on_sample` on every tick of the sampler.
#[derive(Debug, Default)]
pub struct ResizeTracker {
    steps: Vec<ResizeStep>,
    tolerance: f64,
}

impl ResizeTracker {
    pub fn new(tolerance: f64) -> Self {
        Self {
            steps: Vec::new(),
            tolerance,
        }
    }

    /// The UI set the layer's frame to `rect` at `at` (in the same layout
    /// pass that laid the placeholder out).
    pub fn on_set(&mut self, rect: LayerRect, at: Instant) {
        if let Some(last) = self.steps.last()
            && last.rect.approx_eq(&rect, self.tolerance)
        {
            return;
        }
        self.steps.push(ResizeStep {
            rect,
            set_at: at,
            displayed_at: None,
            samples_before_match: 0,
            superseded_showing: None,
        });
    }

    /// A sample of the frame Core Animation is displaying.
    pub fn on_sample(&mut self, displayed: Option<LayerRect>, at: Instant) {
        let tolerance = self.tolerance;
        let Some(step) = self.steps.last_mut() else {
            return;
        };
        if step.displayed_at.is_some() {
            return;
        }
        match displayed {
            Some(shown) if shown.approx_eq(&step.rect, tolerance) => {
                step.displayed_at = Some(at);
            }
            other => {
                step.samples_before_match += 1;
                step.superseded_showing = other;
            }
        }
    }

    pub fn steps(&self) -> &[ResizeStep] {
        &self.steps
    }

    pub fn into_steps(self) -> Vec<ResizeStep> {
        self.steps
    }
}

/// The resize-lag numbers: set-to-displayed per step, in ms and in display
/// ticks.
#[derive(Debug, Clone)]
pub struct ResizeSummary {
    pub steps: usize,
    pub matched: usize,
    /// Steps superseded by the next one before their frame was ever displayed.
    pub never_displayed: usize,
    pub set_to_displayed_ms: Series,
    /// `set_to_displayed_ms` divided by the display tick, rounded up.
    pub set_to_displayed_ticks: Series,
    pub display_tick_ms: f64,
    /// Steps whose displayed frame arrived within one display tick of the set.
    pub within_one_tick: usize,
    pub within_two_ticks: usize,
}

impl ResizeSummary {
    pub fn of(steps: &[ResizeStep], display_tick_ms: f64) -> Self {
        let lags: Vec<f64> = steps
            .iter()
            .filter_map(|step| {
                step.displayed_at
                    .map(|t| ms(t.saturating_duration_since(step.set_at)))
            })
            .collect();
        let tick = if display_tick_ms > 0.0 {
            display_tick_ms
        } else {
            8.333
        };
        let ticks: Vec<f64> = lags.iter().map(|lag| (lag / tick).ceil()).collect();
        Self {
            steps: steps.len(),
            matched: lags.len(),
            never_displayed: steps.iter().filter(|s| s.displayed_at.is_none()).count(),
            within_one_tick: ticks.iter().filter(|t| **t <= 1.0).count(),
            within_two_ticks: ticks.iter().filter(|t| **t <= 2.0).count(),
            set_to_displayed_ms: Series::of(&lags),
            set_to_displayed_ticks: Series::of(&ticks),
            display_tick_ms: tick,
        }
    }

    pub fn json(&self) -> Value {
        json!({
            "steps": self.steps,
            "matched": self.matched,
            "neverDisplayed": self.never_displayed,
            "setToDisplayedMs": self.set_to_displayed_ms.json(),
            "setToDisplayedTicks": self.set_to_displayed_ticks.json(),
            "displayTickMs": self.display_tick_ms,
            "withinOneTick": self.within_one_tick,
            "withinTwoTicks": self.within_two_ticks,
        })
    }

    pub fn text(&self) -> String {
        format!(
            "resize lag: {} steps, {} displayed, {} never displayed before the next step; set to displayed {}; in {:.2} ms display ticks {}; within one tick {}, within two {}",
            self.steps,
            self.matched,
            self.never_displayed,
            self.set_to_displayed_ms.text(),
            self.display_tick_ms,
            self.set_to_displayed_ticks.text(),
            self.within_one_tick,
            self.within_two_ticks
        )
    }
}

/// The feed's run report (`--preview-stats`): the layer summary with the
/// lease loop's own figures. Platform-free so every platform's report has
/// one shape.
#[derive(Debug, Clone)]
pub struct FeedReport {
    pub seconds: f64,
    pub frame_events: u64,
    pub summary: LayerRunSummary,
    /// Acquire to release, per frame.
    pub lease_held_ms: Series,
    /// `preview.frameReady` received to the layer's commit.
    pub ready_to_commit_ms: Series,
    pub skipped: u64,
    pub refused: u64,
    pub dropped: u64,
    pub repeated: u64,
    pub target_fps: u32,
    pub frame_width: u32,
    pub frame_height: u32,
    /// Distinct IOSurface ids seen (the ring's slots).
    pub iosurfaces: usize,
    pub notes: Vec<String>,
}

impl FeedReport {
    pub fn text(&self) -> Vec<String> {
        let mut lines = vec![format!(
            "feed: {} frames presented in {:.1} s ({:.2}/s) of {} frameReady events; skipped {}, refused by the backend {}, dropped {}, repeated {}; {}x{} @ {} fps; {} IOSurfaces",
            self.summary.frames,
            self.seconds,
            self.summary.frames as f64 / self.seconds.max(1e-9),
            self.frame_events,
            self.skipped,
            self.refused,
            self.dropped,
            self.repeated,
            self.frame_width,
            self.frame_height,
            self.target_fps,
            self.iosurfaces
        )];
        lines.push(format!(
            "lease held {}; frameReady to commit {}",
            self.lease_held_ms.text(),
            self.ready_to_commit_ms.text()
        ));
        lines.extend(self.summary.text());
        lines.extend(self.notes.iter().cloned());
        lines
    }

    pub fn json(&self) -> Value {
        json!({
            "seconds": self.seconds,
            "frameEvents": self.frame_events,
            "skipped": self.skipped,
            "refused": self.refused,
            "dropped": self.dropped,
            "repeated": self.repeated,
            "targetFps": self.target_fps,
            "frameWidth": self.frame_width,
            "frameHeight": self.frame_height,
            "iosurfaces": self.iosurfaces,
            "leaseHeldMs": self.lease_held_ms.json(),
            "readyToCommitMs": self.ready_to_commit_ms.json(),
            "layer": self.summary.json(),
            "notes": self.notes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(
        t0: Instant,
        frame_id: u64,
        offset_ms: u64,
        presented_offset_ms: Option<u64>,
    ) -> LayerFrameRecord {
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        LayerFrameRecord {
            frame_id,
            started_at: at(offset_ms),
            import: if frame_id.is_multiple_of(3) {
                ImportKind::Imported
            } else {
                ImportKind::Cached
            },
            import_time: Duration::from_micros(300),
            layers: vec![LayerPresentRecord {
                layer: 0,
                drawable_wait: Duration::from_millis(1),
                committed_at: at(offset_ms + 1),
                gpu_time: Duration::from_micros(800),
                presented_at: presented_offset_ms.map(at),
            }],
            gpu_done_at: at(offset_ms + 3),
        }
    }

    #[test]
    fn run_summary_counts_imports_and_display_cadence() {
        let t0 = Instant::now();
        let records = vec![
            record(t0, 3, 0, Some(10)),
            record(t0, 4, 16, Some(26)),
            record(t0, 5, 33, Some(43)),
            record(t0, 6, 50, None),
            record(t0, 7, 100, Some(110)),
        ];
        let summary = LayerRunSummary::of(&records, 60);
        assert_eq!(summary.frames, 5);
        assert_eq!(summary.imports, 2);
        assert_eq!(summary.cache_hits, 3);
        assert_eq!(summary.layers.len(), 1);
        let main = &summary.layers[0];
        assert_eq!(main.frames, 5);
        assert_eq!(main.unstamped, 1);
        // Presented intervals: 16, 17, 67 ms; one over two frame periods.
        assert_eq!(main.presented_interval_ms.n, 3);
        assert_eq!(main.presented_hitches, 1);
        assert_eq!(main.commit_to_presented_ms.p50, Some(9.0));
        assert_eq!(summary.present_wall_ms.max, Some(3.0));
        assert_eq!(main.gpu_time_ms.p50, Some(0.8));
    }

    #[test]
    fn stamps_attach_to_their_frame_and_layer_once() {
        let t0 = Instant::now();
        let mut records = vec![record(t0, 3, 0, None), record(t0, 4, 16, None)];
        let orphans = attach_stamps(
            &mut records,
            &[
                PresentedStamp {
                    frame_id: 4,
                    layer: 0,
                    presented_at: t0 + Duration::from_millis(30),
                },
                PresentedStamp {
                    frame_id: 4,
                    layer: 0,
                    presented_at: t0 + Duration::from_millis(31),
                },
                PresentedStamp {
                    frame_id: 4,
                    layer: 1,
                    presented_at: t0 + Duration::from_millis(30),
                },
                PresentedStamp {
                    frame_id: 9,
                    layer: 0,
                    presented_at: t0,
                },
            ],
        );
        assert_eq!(orphans, 2);
        assert_eq!(records[0].layers[0].presented_at, None);
        assert_eq!(
            records[1].layers[0].presented_at,
            Some(t0 + Duration::from_millis(30))
        );
    }

    #[test]
    fn resize_tracker_times_the_first_matching_sample() {
        let t0 = Instant::now();
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        let mut tracker = ResizeTracker::new(0.5);
        let a = LayerRect::new(240.0, 0.0, 1000.0, 562.5);
        let b = LayerRect::new(240.0, 0.0, 990.0, 556.875);
        tracker.on_set(a, at(0));
        tracker.on_set(a, at(1)); // the same rect again is not a new step
        tracker.on_sample(Some(LayerRect::new(240.0, 0.0, 1040.0, 585.0)), at(2));
        tracker.on_sample(Some(a), at(9));
        tracker.on_sample(Some(a), at(11)); // after the match: ignored
        tracker.on_set(b, at(50));
        tracker.on_sample(Some(a), at(52));
        tracker.on_set(LayerRect::new(240.0, 0.0, 980.0, 551.25), at(100));
        let steps = tracker.steps();
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[0].displayed_at, Some(at(9)));
        assert_eq!(steps[0].samples_before_match, 1);
        assert_eq!(steps[1].displayed_at, None);
        assert_eq!(steps[1].superseded_showing, Some(a));
        let summary = ResizeSummary::of(steps, 8.333);
        assert_eq!(summary.steps, 3);
        assert_eq!(summary.matched, 1);
        assert_eq!(summary.never_displayed, 2);
        assert_eq!(summary.set_to_displayed_ms.p50, Some(9.0));
        assert_eq!(summary.set_to_displayed_ticks.p50, Some(2.0));
        assert_eq!(summary.within_one_tick, 0);
        assert_eq!(summary.within_two_ticks, 1);
    }
}
