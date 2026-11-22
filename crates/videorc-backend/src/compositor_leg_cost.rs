//! What each output leg costs per tick (performance hunt 2026-11-20, PH-04
//! step 1). A tick composes its legs in turn on the frame thread: the
//! primary, the split stream leg, the two separate-source legs and the
//! Preview's program leg. Before this only the primary's GPU wait and the
//! program leg's wall time were kept, so a 20 ms tick could not be split.
//!
//! Measurement only: nothing here changes what a leg draws or when. The loop
//! records one [`TickLegCosts`] per tick and logs one `Compositor leg cost`
//! line per [`LEG_COST_REPORT_INTERVAL`], and only for a run that composes
//! more than one leg (or whose program leg is parked), so the idle Preview
//! writes nothing. `VIDEORC_COMPOSITOR_LEG_COST=1` logs single-leg runs too.

use std::fmt::Write as _;
use std::time::{Duration, Instant};

/// How often the loop writes the line. Long enough that an hour on air is a
/// few hundred lines, short enough to see a session change shape.
pub(super) const LEG_COST_REPORT_INTERVAL: Duration = Duration::from_secs(10);

/// The legs of one tick, in the order the loop composes them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CompositorLeg {
    Primary,
    Stream,
    IsoScreen,
    IsoCamera,
    Program,
}

const LEG_COUNT: usize = 5;

impl CompositorLeg {
    const ALL: [Self; LEG_COUNT] = [
        Self::Primary,
        Self::Stream,
        Self::IsoScreen,
        Self::IsoCamera,
        Self::Program,
    ];

    fn index(self) -> usize {
        self as usize
    }

    fn label(self) -> &'static str {
        match self {
            Self::Primary => "primary",
            Self::Stream => "stream",
            Self::IsoScreen => "iso-screen",
            Self::IsoCamera => "iso-camera",
            Self::Program => "program",
        }
    }
}

/// One leg's cost in one tick, in milliseconds.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(super) struct LegCost {
    /// The leg's whole section on the frame thread: building its draw list,
    /// importing frames, encoding, the wait and the store publish.
    pub wall_ms: f64,
    /// From the commit of the leg's command buffer until
    /// `waitUntilCompleted` returned: the time the frame thread sat blocked.
    pub gpu_wait_ms: f64,
    /// The GPU's own time on that command buffer (start to end timestamps).
    /// `gpu_wait_ms - gpu_ms` is scheduling and queueing behind other work.
    pub gpu_ms: f64,
    /// Building the draw list (placements, overlay quads).
    pub prepare_ms: f64,
    /// Importing or uploading this leg's source textures.
    pub source_texture_ms: f64,
    /// Encoding the scene pass.
    pub encode_ms: f64,
    /// Encoding the green-screen key passes.
    pub key_pass_ms: f64,
    /// How many keyed cameras were keyed again this tick on this leg.
    pub keyed_camera_passes: u64,
}

/// Every leg's cost in one tick, and what the program leg did instead of a
/// pass of its own (PH-01).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(super) struct TickLegCosts {
    legs: [Option<LegCost>; LEG_COUNT],
    /// The plan wants a program leg, and this tick the primary's frame
    /// already was the program's picture: no pass.
    pub program_parked: bool,
    /// The split stream leg's frame was the program's picture: no pass.
    pub program_shared: bool,
}

impl TickLegCosts {
    pub(super) fn set(&mut self, leg: CompositorLeg, cost: LegCost) {
        self.legs[leg.index()] = Some(cost);
    }

    #[cfg(test)]
    pub(super) fn get(&self, leg: CompositorLeg) -> Option<LegCost> {
        self.legs[leg.index()]
    }

    fn composed_legs(&self) -> usize {
        self.legs.iter().flatten().count()
    }

    fn legs_wall_ms(&self) -> f64 {
        self.legs.iter().flatten().map(|cost| cost.wall_ms).sum()
    }
}

#[derive(Default)]
struct LegSamples {
    wall_ms: Vec<f64>,
    gpu_wait_ms: Vec<f64>,
    gpu_ms: Vec<f64>,
    prepare_ms: Vec<f64>,
    source_texture_ms: Vec<f64>,
    encode_ms: Vec<f64>,
    key_pass_ms: Vec<f64>,
    keyed_camera_passes: u64,
}

impl LegSamples {
    fn push(&mut self, cost: LegCost) {
        self.wall_ms.push(cost.wall_ms);
        self.gpu_wait_ms.push(cost.gpu_wait_ms);
        self.gpu_ms.push(cost.gpu_ms);
        self.prepare_ms.push(cost.prepare_ms);
        self.source_texture_ms.push(cost.source_texture_ms);
        self.encode_ms.push(cost.encode_ms);
        self.key_pass_ms.push(cost.key_pass_ms);
        self.keyed_camera_passes = self
            .keyed_camera_passes
            .saturating_add(cost.keyed_camera_passes);
    }

    fn clear(&mut self) {
        self.wall_ms.clear();
        self.gpu_wait_ms.clear();
        self.gpu_ms.clear();
        self.prepare_ms.clear();
        self.source_texture_ms.clear();
        self.encode_ms.clear();
        self.key_pass_ms.clear();
        self.keyed_camera_passes = 0;
    }
}

/// One report: the window's ticks and each composed leg's medians and p95s.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct LegCostReport {
    pub ticks: usize,
    pub tick_p50_ms: f64,
    pub tick_p95_ms: f64,
    /// The tick's time outside every leg: the scene snapshot, the source
    /// fetches, the evidence and the status updates.
    pub outside_legs_p50_ms: f64,
    pub outside_legs_p95_ms: f64,
    pub program_parked_ticks: usize,
    pub program_shared_ticks: usize,
    /// One clause per composed leg, each value `p50/p95` in milliseconds:
    /// `primary n=300 wall=7.9/9.4 wait=6.0/7.3 gpu=4.1/5.2 ...; stream ...`.
    pub legs: String,
}

/// The loop's window of per-leg samples between two reports.
pub(super) struct LegCostWindow {
    started_at: Instant,
    tick_ms: Vec<f64>,
    outside_legs_ms: Vec<f64>,
    legs: [LegSamples; LEG_COUNT],
    multi_leg_ticks: usize,
    program_parked_ticks: usize,
    program_shared_ticks: usize,
}

impl LegCostWindow {
    pub(super) fn new(now: Instant) -> Self {
        Self {
            started_at: now,
            tick_ms: Vec::with_capacity(512),
            outside_legs_ms: Vec::with_capacity(512),
            legs: Default::default(),
            multi_leg_ticks: 0,
            program_parked_ticks: 0,
            program_shared_ticks: 0,
        }
    }

    /// One tick: its legs and its whole render time.
    pub(super) fn record(&mut self, tick: &TickLegCosts, tick_ms: f64) {
        self.tick_ms.push(tick_ms);
        self.outside_legs_ms
            .push((tick_ms - tick.legs_wall_ms()).max(0.0));
        for leg in CompositorLeg::ALL {
            if let Some(cost) = tick.legs[leg.index()] {
                self.legs[leg.index()].push(cost);
            }
        }
        if tick.composed_legs() > 1 {
            self.multi_leg_ticks += 1;
        }
        self.program_parked_ticks += usize::from(tick.program_parked);
        self.program_shared_ticks += usize::from(tick.program_shared);
    }

    /// The window's report once [`LEG_COST_REPORT_INTERVAL`] has passed, and
    /// a fresh window either way. `None` before the interval, and for a
    /// window that composed one leg a tick and parked nothing, unless
    /// `single_leg_too` asks for those as well.
    pub(super) fn take_report_if_due(
        &mut self,
        now: Instant,
        single_leg_too: bool,
    ) -> Option<LegCostReport> {
        if now.saturating_duration_since(self.started_at) < LEG_COST_REPORT_INTERVAL {
            return None;
        }
        let worth_a_line = !self.tick_ms.is_empty()
            && (single_leg_too
                || self.multi_leg_ticks > 0
                || self.program_parked_ticks > 0
                || self.program_shared_ticks > 0);
        let report = worth_a_line.then(|| self.report());
        self.reset(now);
        report
    }

    fn report(&self) -> LegCostReport {
        let (tick_p50_ms, tick_p95_ms) = p50_p95(&self.tick_ms);
        let (outside_legs_p50_ms, outside_legs_p95_ms) = p50_p95(&self.outside_legs_ms);
        let mut legs = String::new();
        for leg in CompositorLeg::ALL {
            let samples = &self.legs[leg.index()];
            if samples.wall_ms.is_empty() {
                continue;
            }
            if !legs.is_empty() {
                legs.push_str("; ");
            }
            let _ = write!(legs, "{} n={}", leg.label(), samples.wall_ms.len());
            for (name, values) in [
                ("wall", &samples.wall_ms),
                ("wait", &samples.gpu_wait_ms),
                ("gpu", &samples.gpu_ms),
                ("prepare", &samples.prepare_ms),
                ("textures", &samples.source_texture_ms),
                ("encode", &samples.encode_ms),
                ("key", &samples.key_pass_ms),
            ] {
                let (p50, p95) = p50_p95(values);
                let _ = write!(legs, " {name}={p50:.2}/{p95:.2}");
            }
            let _ = write!(legs, " keyed={}", samples.keyed_camera_passes);
        }
        LegCostReport {
            ticks: self.tick_ms.len(),
            tick_p50_ms,
            tick_p95_ms,
            outside_legs_p50_ms,
            outside_legs_p95_ms,
            program_parked_ticks: self.program_parked_ticks,
            program_shared_ticks: self.program_shared_ticks,
            legs,
        }
    }

    fn reset(&mut self, now: Instant) {
        self.started_at = now;
        self.tick_ms.clear();
        self.outside_legs_ms.clear();
        for samples in &mut self.legs {
            samples.clear();
        }
        self.multi_leg_ticks = 0;
        self.program_parked_ticks = 0;
        self.program_shared_ticks = 0;
    }
}

fn p50_p95(values: &[f64]) -> (f64, f64) {
    let (p50, p95, _) = super::frame_time_percentiles(values);
    (p50, p95)
}

/// `VIDEORC_COMPOSITOR_LEG_COST=1` writes the line for single-leg runs too
/// (the idle Preview, record only, stream only): a measurement switch.
pub(super) fn single_leg_runs_report_too() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| {
        matches!(
            std::env::var("VIDEORC_COMPOSITOR_LEG_COST")
                .ok()
                .map(|value| value.trim().to_ascii_lowercase())
                .as_deref(),
            Some("1" | "true" | "on" | "yes")
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cost(wall_ms: f64, gpu_wait_ms: f64, gpu_ms: f64) -> LegCost {
        LegCost {
            wall_ms,
            gpu_wait_ms,
            gpu_ms,
            ..LegCost::default()
        }
    }

    fn tick(legs: &[(CompositorLeg, LegCost)]) -> TickLegCosts {
        let mut tick = TickLegCosts::default();
        for (leg, cost) in legs {
            tick.set(*leg, *cost);
        }
        tick
    }

    #[test]
    fn a_tick_keeps_each_leg_under_its_own_name() {
        let tick = tick(&[(CompositorLeg::Stream, cost(5.0, 4.0, 2.0))]);
        assert_eq!(tick.get(CompositorLeg::Stream), Some(cost(5.0, 4.0, 2.0)));
        assert_eq!(tick.get(CompositorLeg::Primary), None);
        assert_eq!(tick.composed_legs(), 1);
        assert_eq!(tick.legs_wall_ms(), 5.0);
    }

    #[test]
    fn nothing_is_reported_before_the_interval() {
        let start = Instant::now();
        let mut window = LegCostWindow::new(start);
        window.record(
            &tick(&[
                (CompositorLeg::Primary, cost(8.0, 6.0, 4.0)),
                (CompositorLeg::Stream, cost(5.0, 4.0, 2.0)),
            ]),
            14.0,
        );
        assert_eq!(
            window.take_report_if_due(start + LEG_COST_REPORT_INTERVAL / 2, false),
            None
        );
        // The samples are still there for the report that is due later.
        let report = window
            .take_report_if_due(start + LEG_COST_REPORT_INTERVAL, false)
            .expect("due");
        assert_eq!(report.ticks, 1);
    }

    #[test]
    fn a_single_leg_run_writes_nothing_unless_asked() {
        let start = Instant::now();
        let due = start + LEG_COST_REPORT_INTERVAL;
        let primary_only = tick(&[(CompositorLeg::Primary, cost(3.0, 2.0, 1.0))]);

        let mut window = LegCostWindow::new(start);
        window.record(&primary_only, 3.5);
        assert_eq!(window.take_report_if_due(due, false), None);

        let mut window = LegCostWindow::new(start);
        window.record(&primary_only, 3.5);
        let report = window.take_report_if_due(due, true).expect("asked for");
        assert_eq!(report.ticks, 1);
        assert!(report.legs.starts_with("primary n=1 wall=3.00/3.00"));
    }

    #[test]
    fn the_report_splits_the_tick_by_leg_and_starts_a_fresh_window() {
        let start = Instant::now();
        let due = start + LEG_COST_REPORT_INTERVAL;
        let mut window = LegCostWindow::new(start);
        for _ in 0..3 {
            window.record(
                &tick(&[
                    (CompositorLeg::Primary, cost(8.0, 6.0, 4.0)),
                    (CompositorLeg::Stream, cost(5.0, 4.0, 2.0)),
                    (
                        CompositorLeg::Program,
                        LegCost {
                            keyed_camera_passes: 1,
                            key_pass_ms: 0.25,
                            ..cost(7.0, 6.5, 3.0)
                        },
                    ),
                ]),
                21.0,
            );
        }
        let report = window.take_report_if_due(due, false).expect("three legs");
        assert_eq!(report.ticks, 3);
        assert_eq!((report.tick_p50_ms, report.tick_p95_ms), (21.0, 21.0));
        // 21 ms of tick, 20 ms inside the three legs.
        assert_eq!(report.outside_legs_p50_ms, 1.0);
        assert_eq!(
            report.legs,
            "primary n=3 wall=8.00/8.00 wait=6.00/6.00 gpu=4.00/4.00 prepare=0.00/0.00 \
             textures=0.00/0.00 encode=0.00/0.00 key=0.00/0.00 keyed=0; \
             stream n=3 wall=5.00/5.00 wait=4.00/4.00 gpu=2.00/2.00 prepare=0.00/0.00 \
             textures=0.00/0.00 encode=0.00/0.00 key=0.00/0.00 keyed=0; \
             program n=3 wall=7.00/7.00 wait=6.50/6.50 gpu=3.00/3.00 prepare=0.00/0.00 \
             textures=0.00/0.00 encode=0.00/0.00 key=0.25/0.25 keyed=3"
        );
        // The next window starts empty at `due`.
        assert_eq!(
            window.take_report_if_due(due + LEG_COST_REPORT_INTERVAL, true),
            None
        );
    }

    #[test]
    fn a_parked_or_shared_program_leg_is_counted_and_reported() {
        let start = Instant::now();
        let due = start + LEG_COST_REPORT_INTERVAL;
        let mut window = LegCostWindow::new(start);
        let mut parked = tick(&[(CompositorLeg::Primary, cost(3.0, 2.0, 1.0))]);
        parked.program_parked = true;
        let mut shared = tick(&[
            (CompositorLeg::Primary, cost(3.0, 2.0, 1.0)),
            (CompositorLeg::Stream, cost(3.0, 2.0, 1.0)),
        ]);
        shared.program_shared = true;
        window.record(&parked, 3.0);
        window.record(&parked, 3.0);
        window.record(&shared, 6.0);
        let report = window.take_report_if_due(due, false).expect("parked ticks");
        assert_eq!(report.program_parked_ticks, 2);
        assert_eq!(report.program_shared_ticks, 1);
        assert!(!report.legs.contains("program"), "no program pass ran");

        // A window of parked ticks alone still writes its line: that is the
        // evidence that the pass was skipped.
        let mut window = LegCostWindow::new(start);
        window.record(&parked, 3.0);
        assert!(window.take_report_if_due(due, false).is_some());
    }
}
