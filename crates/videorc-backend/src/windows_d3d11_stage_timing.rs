//! Per-stage timing of the single D3D11 media thread (#1042).
//!
//! The media thread polls capture, composes, uploads the camera frame, runs
//! the Media Foundation encoder and presents the preview. When one of them
//! blocks, all of them wait, so the per-command lag alone cannot name the
//! stage that blocked. These timers split the thread's wall time by stage and
//! keep the breakdown of the single slowest loop iteration and the single
//! slowest compose, so one stalled moment can be read whole.
//!
//! Pure bookkeeping: no D3D11 type crosses this module, so it is tested on
//! every platform.

pub(crate) const WINDOWS_D3D11_STAGE_SAMPLE_CAPACITY: usize = 256;

/// One stage's wall time over the generation: how many times it ran, the p95
/// of the most recent `WINDOWS_D3D11_STAGE_SAMPLE_CAPACITY` runs and the
/// worst run ever.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct WindowsD3d11StageTiming {
    pub(crate) samples: u64,
    pub(crate) p95_micros: u64,
    pub(crate) max_micros: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct WindowsD3d11StageSamples {
    values: [u64; WINDOWS_D3D11_STAGE_SAMPLE_CAPACITY],
    len: usize,
    next: usize,
    count: u64,
    max: u64,
}

impl Default for WindowsD3d11StageSamples {
    fn default() -> Self {
        Self {
            values: [0; WINDOWS_D3D11_STAGE_SAMPLE_CAPACITY],
            len: 0,
            next: 0,
            count: 0,
            max: 0,
        }
    }
}

impl WindowsD3d11StageSamples {
    pub(crate) fn observe(&mut self, micros: u64) {
        self.values[self.next] = micros;
        self.next = (self.next + 1) % WINDOWS_D3D11_STAGE_SAMPLE_CAPACITY;
        self.len = (self.len + 1).min(WINDOWS_D3D11_STAGE_SAMPLE_CAPACITY);
        self.count = self.count.saturating_add(1);
        self.max = self.max.max(micros);
    }

    pub(crate) fn summary(&self) -> WindowsD3d11StageTiming {
        if self.len == 0 {
            return WindowsD3d11StageTiming::default();
        }
        let mut ordered = self.values;
        ordered[..self.len].sort_unstable();
        let rank = self.len.saturating_mul(95).div_ceil(100).saturating_sub(1);
        WindowsD3d11StageTiming {
            samples: self.count,
            p95_micros: ordered[rank],
            max_micros: self.max,
        }
    }
}

/// Where one media-thread loop iteration spent its time, after the wait for
/// work returned. `total_micros` is the whole iteration; the rest is the part
/// each stage took, so `total - sum(parts)` is bookkeeping and message
/// dispatch.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct WindowsD3d11MediaLoopBreakdown {
    pub(crate) total_micros: u64,
    pub(crate) capture_poll_micros: u64,
    pub(crate) compose_micros: u64,
    pub(crate) encoder_submit_micros: u64,
    pub(crate) encoder_poll_micros: u64,
    pub(crate) preview_present_micros: u64,
    pub(crate) other_command_micros: u64,
    pub(crate) commands: u32,
    /// The iteration opened or closed a capture, encoder or preview. Those
    /// take seconds by design, so such iterations are counted apart and
    /// never become the slowest loop.
    pub(crate) ran_setup: bool,
}

/// Where one compose command spent its time on the media thread.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct WindowsD3d11ComposeBreakdown {
    pub(crate) total_micros: u64,
    /// Time to take the device's multithread lock before composing: how long
    /// the capture worker or the encoder held the shared immediate context.
    pub(crate) device_lock_wait_micros: u64,
    pub(crate) fence_refresh_micros: u64,
    pub(crate) camera_upload_micros: u64,
    pub(crate) image_upload_micros: u64,
    pub(crate) preview_pass_micros: u64,
    pub(crate) encoded_pass_micros: u64,
    pub(crate) nv12_pass_micros: u64,
    pub(crate) fence_signal_micros: u64,
}

/// What the compositor measured inside one `compose` call, on the CPU.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct WindowsD3d11ComposeCpuTimings {
    pub(crate) camera_upload_micros: Option<u64>,
    pub(crate) image_upload_micros: u64,
    pub(crate) preview_pass_micros: Option<u64>,
    pub(crate) encoded_pass_micros: u64,
    pub(crate) nv12_pass_micros: u64,
}

/// GPU-side durations of the compose passes from timestamp queries, read
/// back without stalling a few frames after they ran.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct WindowsD3d11ComposeGpuTimings {
    /// Upload copies (camera and image `UpdateSubresource`) on the GPU.
    pub(crate) upload: WindowsD3d11StageTiming,
    pub(crate) preview_pass: WindowsD3d11StageTiming,
    pub(crate) encoded_pass: WindowsD3d11StageTiming,
    pub(crate) nv12_pass: WindowsD3d11StageTiming,
    /// First timestamp to last: the whole compose on the GPU.
    pub(crate) total: WindowsD3d11StageTiming,
    /// CPU time from issuing the compose to seeing its timestamps resolved.
    /// Long values mean the GPU queue ran far behind the CPU (saturation or
    /// another process's work ahead of ours); it is polled once per compose,
    /// so it reads up to one frame high.
    pub(crate) completion_latency: WindowsD3d11StageTiming,
    /// Query sets the driver flagged disjoint (clock changed): discarded.
    pub(crate) disjoint: u64,
    /// Composes not timed because every query set was still in flight.
    pub(crate) skipped: u64,
}

/// One resolved GPU query set, in microseconds.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct WindowsD3d11ComposeGpuSample {
    pub(crate) upload_micros: u64,
    pub(crate) preview_pass_micros: u64,
    pub(crate) encoded_pass_micros: u64,
    pub(crate) nv12_pass_micros: u64,
    pub(crate) total_micros: u64,
    pub(crate) completion_latency_micros: u64,
}

/// Converts the timestamps of one query set into durations. `stamps` is the
/// raw ticks in issue order: start, after uploads, after the preview pass,
/// then one (scene end, NV12 end) pair per encoded output. Returns `None` for
/// a malformed set (wrong length, zero frequency, or ticks going backwards).
pub(crate) fn windows_d3d11_gpu_sample_from_ticks(
    stamps: &[u64],
    frequency: u64,
    completion_latency_micros: u64,
) -> Option<WindowsD3d11ComposeGpuSample> {
    if frequency == 0 || stamps.len() < 3 || !(stamps.len() - 3).is_multiple_of(2) {
        return None;
    }
    if stamps.windows(2).any(|pair| pair[1] < pair[0]) {
        return None;
    }
    let micros = |ticks: u64| -> u64 {
        u64::try_from(u128::from(ticks) * 1_000_000 / u128::from(frequency)).unwrap_or(u64::MAX)
    };
    let mut encoded = 0;
    let mut nv12 = 0;
    let mut previous = stamps[2];
    for pair in stamps[3..].chunks_exact(2) {
        encoded += pair[0] - previous;
        nv12 += pair[1] - pair[0];
        previous = pair[1];
    }
    Some(WindowsD3d11ComposeGpuSample {
        upload_micros: micros(stamps[1] - stamps[0]),
        preview_pass_micros: micros(stamps[2] - stamps[1]),
        encoded_pass_micros: micros(encoded),
        nv12_pass_micros: micros(nv12),
        total_micros: micros(stamps[stamps.len() - 1] - stamps[0]),
        completion_latency_micros,
    })
}

#[derive(Debug, Clone, Default)]
pub(crate) struct WindowsD3d11ComposeGpuTimers {
    upload: WindowsD3d11StageSamples,
    preview_pass: WindowsD3d11StageSamples,
    encoded_pass: WindowsD3d11StageSamples,
    nv12_pass: WindowsD3d11StageSamples,
    total: WindowsD3d11StageSamples,
    completion_latency: WindowsD3d11StageSamples,
    disjoint: u64,
    skipped: u64,
}

impl WindowsD3d11ComposeGpuTimers {
    pub(crate) fn observe(&mut self, sample: WindowsD3d11ComposeGpuSample) {
        self.upload.observe(sample.upload_micros);
        self.preview_pass.observe(sample.preview_pass_micros);
        self.encoded_pass.observe(sample.encoded_pass_micros);
        self.nv12_pass.observe(sample.nv12_pass_micros);
        self.total.observe(sample.total_micros);
        self.completion_latency
            .observe(sample.completion_latency_micros);
    }

    pub(crate) fn note_disjoint(&mut self) {
        self.disjoint = self.disjoint.saturating_add(1);
    }

    pub(crate) fn note_skipped(&mut self) {
        self.skipped = self.skipped.saturating_add(1);
    }

    pub(crate) fn summary(&self) -> WindowsD3d11ComposeGpuTimings {
        WindowsD3d11ComposeGpuTimings {
            upload: self.upload.summary(),
            preview_pass: self.preview_pass.summary(),
            encoded_pass: self.encoded_pass.summary(),
            nv12_pass: self.nv12_pass.summary(),
            total: self.total.summary(),
            completion_latency: self.completion_latency.summary(),
            disjoint: self.disjoint,
            skipped: self.skipped,
        }
    }
}

/// The media thread's stage timers for one generation.
#[derive(Debug, Clone, Default)]
pub(crate) struct WindowsD3d11MediaStageTimers {
    loop_busy: WindowsD3d11StageSamples,
    setup_loops: u64,
    capture_poll: WindowsD3d11StageSamples,
    compose: WindowsD3d11StageSamples,
    device_lock_wait: WindowsD3d11StageSamples,
    camera_upload: WindowsD3d11StageSamples,
    image_upload: WindowsD3d11StageSamples,
    preview_pass: WindowsD3d11StageSamples,
    encoded_pass: WindowsD3d11StageSamples,
    nv12_pass: WindowsD3d11StageSamples,
    fence_signal: WindowsD3d11StageSamples,
    encoder_submit: WindowsD3d11StageSamples,
    encoder_process_input: WindowsD3d11StageSamples,
    encoder_poll: WindowsD3d11StageSamples,
    encoder_process_output: WindowsD3d11StageSamples,
    encoder_input_hold: WindowsD3d11StageSamples,
    preview_present: WindowsD3d11StageSamples,
    slowest_loop: WindowsD3d11MediaLoopBreakdown,
    slowest_compose: WindowsD3d11ComposeBreakdown,
}

impl WindowsD3d11MediaStageTimers {
    /// Records one loop iteration that did work; an idle wake-up that ran
    /// nothing is not a sample.
    pub(crate) fn observe_loop(&mut self, breakdown: WindowsD3d11MediaLoopBreakdown) {
        if breakdown.ran_setup {
            self.setup_loops = self.setup_loops.saturating_add(1);
            return;
        }
        self.loop_busy.observe(breakdown.total_micros);
        if breakdown.capture_poll_micros > 0 {
            self.capture_poll.observe(breakdown.capture_poll_micros);
        }
        if breakdown.total_micros > self.slowest_loop.total_micros {
            self.slowest_loop = breakdown;
        }
    }

    pub(crate) fn observe_compose(
        &mut self,
        breakdown: WindowsD3d11ComposeBreakdown,
        cpu: WindowsD3d11ComposeCpuTimings,
    ) {
        self.compose.observe(breakdown.total_micros);
        self.device_lock_wait
            .observe(breakdown.device_lock_wait_micros);
        self.fence_signal.observe(breakdown.fence_signal_micros);
        if let Some(micros) = cpu.camera_upload_micros {
            self.camera_upload.observe(micros);
        }
        if cpu.image_upload_micros > 0 {
            self.image_upload.observe(cpu.image_upload_micros);
        }
        if let Some(micros) = cpu.preview_pass_micros {
            self.preview_pass.observe(micros);
        }
        self.encoded_pass.observe(cpu.encoded_pass_micros);
        self.nv12_pass.observe(cpu.nv12_pass_micros);
        if breakdown.total_micros > self.slowest_compose.total_micros {
            self.slowest_compose = breakdown;
        }
    }

    pub(crate) fn observe_encoder_submit(&mut self, micros: u64, process_input: Option<u64>) {
        self.encoder_submit.observe(micros);
        if let Some(process_input) = process_input {
            self.encoder_process_input.observe(process_input);
        }
    }

    pub(crate) fn observe_encoder_poll(&mut self, micros: u64, process_output_max: Option<u64>) {
        self.encoder_poll.observe(micros);
        if let Some(process_output) = process_output_max {
            self.encoder_process_output.observe(process_output);
        }
    }

    /// `ProcessOutput` calls made while submitting (the submit collects the
    /// events already queued) count with the poll's.
    pub(crate) fn observe_process_output(&mut self, micros: u64) {
        self.encoder_process_output.observe(micros);
    }

    /// The longest the encoder held one input among those it released
    /// during one submit or poll.
    pub(crate) fn observe_encoder_input_hold(&mut self, micros: u64) {
        self.encoder_input_hold.observe(micros);
    }

    pub(crate) fn observe_preview_present(&mut self, micros: u64) {
        self.preview_present.observe(micros);
    }

    pub(crate) fn summary(
        &self,
        gpu: Option<WindowsD3d11ComposeGpuTimings>,
    ) -> WindowsD3d11MediaStageTimings {
        WindowsD3d11MediaStageTimings {
            loop_busy: self.loop_busy.summary(),
            capture_poll: self.capture_poll.summary(),
            compose: self.compose.summary(),
            device_lock_wait: self.device_lock_wait.summary(),
            camera_upload: self.camera_upload.summary(),
            image_upload: self.image_upload.summary(),
            preview_pass: self.preview_pass.summary(),
            encoded_pass: self.encoded_pass.summary(),
            nv12_pass: self.nv12_pass.summary(),
            fence_signal: self.fence_signal.summary(),
            encoder_submit: self.encoder_submit.summary(),
            encoder_process_input: self.encoder_process_input.summary(),
            encoder_poll: self.encoder_poll.summary(),
            encoder_process_output: self.encoder_process_output.summary(),
            encoder_input_hold: self.encoder_input_hold.summary(),
            encoder_credit_refusals: 0,
            encoder_capacity_refusals: 0,
            encoder_max_in_flight: 0,
            preview_present: self.preview_present.summary(),
            setup_loops: self.setup_loops,
            slowest_loop: self.slowest_loop,
            slowest_compose: self.slowest_compose,
            gpu,
        }
    }
}

/// The wire-ready summary of [`WindowsD3d11MediaStageTimers`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct WindowsD3d11MediaStageTimings {
    pub(crate) loop_busy: WindowsD3d11StageTiming,
    pub(crate) capture_poll: WindowsD3d11StageTiming,
    pub(crate) compose: WindowsD3d11StageTiming,
    pub(crate) device_lock_wait: WindowsD3d11StageTiming,
    pub(crate) camera_upload: WindowsD3d11StageTiming,
    pub(crate) image_upload: WindowsD3d11StageTiming,
    pub(crate) preview_pass: WindowsD3d11StageTiming,
    pub(crate) encoded_pass: WindowsD3d11StageTiming,
    pub(crate) nv12_pass: WindowsD3d11StageTiming,
    pub(crate) fence_signal: WindowsD3d11StageTiming,
    pub(crate) encoder_submit: WindowsD3d11StageTiming,
    pub(crate) encoder_process_input: WindowsD3d11StageTiming,
    pub(crate) encoder_poll: WindowsD3d11StageTiming,
    pub(crate) encoder_process_output: WindowsD3d11StageTiming,
    /// Successful `ProcessInput` to the transform's release of that input.
    pub(crate) encoder_input_hold: WindowsD3d11StageTiming,
    /// Refusals because the transform had issued no input credit, summed
    /// over the live encoders (filled by the media runtime).
    pub(crate) encoder_credit_refusals: u64,
    /// Refusals because Videorc's own in-flight cap was full.
    pub(crate) encoder_capacity_refusals: u64,
    pub(crate) encoder_max_in_flight: u32,
    pub(crate) preview_present: WindowsD3d11StageTiming,
    /// Iterations that opened or closed a capture, encoder or preview.
    pub(crate) setup_loops: u64,
    pub(crate) slowest_loop: WindowsD3d11MediaLoopBreakdown,
    pub(crate) slowest_compose: WindowsD3d11ComposeBreakdown,
    pub(crate) gpu: Option<WindowsD3d11ComposeGpuTimings>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_samples_report_count_p95_and_all_time_max() {
        let mut samples = WindowsD3d11StageSamples::default();
        assert_eq!(samples.summary(), WindowsD3d11StageTiming::default());
        samples.observe(90_000);
        for micros in 1..=(WINDOWS_D3D11_STAGE_SAMPLE_CAPACITY as u64 + 44) {
            samples.observe(micros);
        }
        let summary = samples.summary();
        assert_eq!(
            summary.samples,
            WINDOWS_D3D11_STAGE_SAMPLE_CAPACITY as u64 + 45
        );
        // The stall rolled out of the p95 window but stays the max.
        assert_eq!(summary.max_micros, 90_000);
        assert_eq!(summary.p95_micros, 288);
    }

    #[test]
    fn slowest_loop_and_compose_keep_the_whole_breakdown_of_one_moment() {
        let mut timers = WindowsD3d11MediaStageTimers::default();
        timers.observe_loop(WindowsD3d11MediaLoopBreakdown {
            total_micros: 4_000,
            compose_micros: 3_000,
            commands: 2,
            ..Default::default()
        });
        let stall = WindowsD3d11MediaLoopBreakdown {
            total_micros: 101_000,
            capture_poll_micros: 200,
            compose_micros: 2_000,
            encoder_submit_micros: 98_000,
            commands: 3,
            ..Default::default()
        };
        timers.observe_loop(stall);
        timers.observe_loop(WindowsD3d11MediaLoopBreakdown {
            total_micros: 5_000,
            encoder_poll_micros: 4_900,
            commands: 1,
            ..Default::default()
        });
        let slow_compose = WindowsD3d11ComposeBreakdown {
            total_micros: 40_000,
            device_lock_wait_micros: 38_000,
            camera_upload_micros: 1_000,
            ..Default::default()
        };
        timers.observe_compose(
            WindowsD3d11ComposeBreakdown {
                total_micros: 3_000,
                ..Default::default()
            },
            WindowsD3d11ComposeCpuTimings::default(),
        );
        timers.observe_compose(
            slow_compose,
            WindowsD3d11ComposeCpuTimings {
                camera_upload_micros: Some(1_000),
                encoded_pass_micros: 300,
                nv12_pass_micros: 200,
                ..Default::default()
            },
        );
        let summary = timers.summary(None);
        assert_eq!(summary.slowest_loop, stall);
        assert_eq!(summary.slowest_compose, slow_compose);
        assert_eq!(summary.loop_busy.samples, 3);
        assert_eq!(summary.loop_busy.max_micros, 101_000);
        assert_eq!(summary.capture_poll.samples, 1);
        assert_eq!(summary.compose.samples, 2);
        assert_eq!(summary.device_lock_wait.max_micros, 38_000);
        // A compose without a camera frame is not a camera-upload sample.
        assert_eq!(summary.camera_upload.samples, 1);
        assert_eq!(summary.preview_pass.samples, 0);
        assert!(summary.gpu.is_none());
    }

    #[test]
    fn setup_iterations_never_become_the_slowest_loop() {
        let mut timers = WindowsD3d11MediaStageTimers::default();
        timers.observe_loop(WindowsD3d11MediaLoopBreakdown {
            total_micros: 1_600_000,
            other_command_micros: 1_600_000,
            commands: 1,
            ran_setup: true,
            ..Default::default()
        });
        let steady = WindowsD3d11MediaLoopBreakdown {
            total_micros: 6_000,
            compose_micros: 5_500,
            commands: 1,
            ..Default::default()
        };
        timers.observe_loop(steady);
        let summary = timers.summary(None);
        assert_eq!(summary.setup_loops, 1);
        assert_eq!(summary.loop_busy.samples, 1);
        assert_eq!(summary.loop_busy.max_micros, 6_000);
        assert_eq!(summary.slowest_loop, steady);
    }

    #[test]
    fn encoder_timers_split_submit_from_the_transform_calls() {
        let mut timers = WindowsD3d11MediaStageTimers::default();
        timers.observe_encoder_submit(1_200, Some(900));
        timers.observe_encoder_submit(50, None);
        timers.observe_encoder_poll(70_000, Some(69_000));
        timers.observe_encoder_poll(40, None);
        timers.observe_process_output(2_000);
        timers.observe_encoder_input_hold(33_000);
        let summary = timers.summary(None);
        assert_eq!(summary.encoder_input_hold.max_micros, 33_000);
        assert_eq!(summary.encoder_submit.samples, 2);
        assert_eq!(summary.encoder_process_input.samples, 1);
        assert_eq!(summary.encoder_process_input.max_micros, 900);
        assert_eq!(summary.encoder_poll.max_micros, 70_000);
        assert_eq!(summary.encoder_process_output.samples, 2);
        assert_eq!(summary.encoder_process_output.max_micros, 69_000);
    }

    #[test]
    fn gpu_ticks_convert_per_pass_and_reject_malformed_sets() {
        // 10 MHz clock: one tick is 0.1 us.
        let stamps = [
            1_000_000, // start
            1_010_000, // uploads: 1 ms
            1_030_000, // preview: 2 ms
            1_060_000, // encoded scene: 3 ms
            1_065_000, // NV12: 0.5 ms
        ];
        let sample = windows_d3d11_gpu_sample_from_ticks(&stamps, 10_000_000, 16_000)
            .expect("well-formed set");
        assert_eq!(sample.upload_micros, 1_000);
        assert_eq!(sample.preview_pass_micros, 2_000);
        assert_eq!(sample.encoded_pass_micros, 3_000);
        assert_eq!(sample.nv12_pass_micros, 500);
        assert_eq!(sample.total_micros, 6_500);
        assert_eq!(sample.completion_latency_micros, 16_000);

        // Two encoded outputs sum their scene and NV12 passes.
        let two = [0, 10, 20, 30, 35, 45, 50];
        let sample = windows_d3d11_gpu_sample_from_ticks(&two, 1_000_000, 0).expect("two outputs");
        assert_eq!(sample.encoded_pass_micros, 10 + 10);
        assert_eq!(sample.nv12_pass_micros, 5 + 5);
        assert_eq!(sample.total_micros, 50);

        assert!(windows_d3d11_gpu_sample_from_ticks(&stamps, 0, 0).is_none());
        assert!(windows_d3d11_gpu_sample_from_ticks(&stamps[..4], 10_000_000, 0).is_none());
        assert!(windows_d3d11_gpu_sample_from_ticks(&[5, 4, 6], 10_000_000, 0).is_none());
    }

    #[test]
    fn gpu_timers_count_disjoint_and_skipped_sets_apart_from_samples() {
        let mut timers = WindowsD3d11ComposeGpuTimers::default();
        timers.note_disjoint();
        timers.note_skipped();
        timers.note_skipped();
        timers.observe(WindowsD3d11ComposeGpuSample {
            total_micros: 6_000,
            completion_latency_micros: 120_000,
            ..Default::default()
        });
        let summary = timers.summary();
        assert_eq!(summary.disjoint, 1);
        assert_eq!(summary.skipped, 2);
        assert_eq!(summary.total.samples, 1);
        assert_eq!(summary.completion_latency.max_micros, 120_000);
    }
}
