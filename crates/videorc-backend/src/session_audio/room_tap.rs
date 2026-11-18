//! Capture-only consumer of the existing device owner, clock, fold, RNNoise and
//! limiter. No encoder, FIFO, recording/camera session or system/monitor input.
//!
//! Clock (Plan 249 S13a): `epoch` is the generation epoch. Chunk positions and
//! `observed_at_us` are relative to it. `origin_us` is that SAME epoch measured
//! from the process anchor in `crate::room_clock` (absent, never zero, when
//! unavailable), captured once at construction. `origin + position` is the
//! PROCESSED timeline position (SourceClock resampling, the optional
//! intentional offset, RNNoise lookahead), not raw device capture time; the
//! offset stays separate in `delay_frames` and is never folded into the origin.
use super::*;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(crate) struct RoomMicrophoneTap {
    producer: Option<ManagedProducer>,
    receiver: mpsc::Receiver<AudioFrame>,
    timeline: AudioTimeline,
    clock: Option<SourceClock>,
    denoise: MicrophoneDenoiseTimeline,
    fold: VoiceFold,
    limiter: PeakLimiter,
    epoch: Instant,
    origin_us: Option<u64>,
    incarnation: Option<u64>,
    last_capture: Instant,
    settings: AudioProcessingSettings,
    delay_frames: u64,
    dropped: u64,
    #[cfg(debug_assertions)]
    fixture_starve_until: Option<Instant>,
}

pub(crate) struct RoomMicrophoneChunk {
    pub sequence: u64,
    pub observed_at_us: u64,
    pub dropped_frames: u64,
    pub samples: Vec<f32>,
}

impl RoomMicrophoneTap {
    pub(crate) fn new(
        source: InitialAudioSource,
        settings: AudioProcessingSettings,
        offset_ms: u32,
    ) -> anyhow::Result<Self> {
        let count = source.count();
        let mut producer = source.into_owned(count)?;
        let receiver = producer
            .receiver
            .take()
            .ok_or_else(|| anyhow::anyhow!("Microphone receiver unavailable"))?;
        let mut timeline = AudioTimeline::new();
        // Offset is an explicit bounded intentional delay, separate from the
        // four-block transport queue. RNNoise has two hops of lookahead.
        timeline.ahead_limit = 1920 + 960 + u64::from(offset_ms) * 48;
        let epoch = Instant::now();
        Ok(Self {
            producer: Some(producer),
            receiver,
            timeline,
            clock: None,
            denoise: MicrophoneDenoiseTimeline::new(),
            fold: VoiceFold::default(),
            limiter: PeakLimiter::default(),
            epoch,
            origin_us: crate::room_clock::origin_us(epoch),
            incarnation: crate::room_clock::incarnation(),
            last_capture: epoch,
            settings,
            delay_frames: u64::from(offset_ms) * 48,
            dropped: 0,
            #[cfg(debug_assertions)]
            fixture_starve_until: None,
        })
    }

    pub(crate) fn update(&mut self, settings: AudioProcessingSettings) {
        self.settings = settings;
    }

    /// `(originUs, incarnation)` of this generation's epoch; fixed for its life.
    pub(crate) fn clock_origin(&self) -> (Option<u64>, Option<u64>) {
        (self.origin_us, self.incarnation)
    }

    pub(crate) fn pull(&mut self, now: Instant) -> anyhow::Result<Option<RoomMicrophoneChunk>> {
        let elapsed_us = now.saturating_duration_since(self.epoch).as_micros() as u64;
        // JS readers add origin + observed; refuse before draining or allocating.
        anyhow::ensure!(
            self.origin_us.is_none_or(|origin| origin
                .checked_add(elapsed_us)
                .is_some_and(|sum| sum <= MAX_SAFE_INTEGER)),
            "Microphone clock exceeds its bound"
        );
        // Reserve 30 ms for capture arrival and the existing two-hop denoiser.
        let due = elapsed_us.saturating_sub(30_000) / 10_000;
        let next = self.timeline.cursor / 480;
        if due > next + 4 {
            let floor = (due - 4) * 480;
            self.dropped += floor - self.timeline.cursor;
            self.timeline.discard_before(floor);
            self.timeline.cursor = floor;
        }
        // The capture producer queue is bounded too; never spend unbounded
        // time draining a device that is concurrently sending.
        for _ in 0..256 {
            match self.receiver.try_recv() {
                Ok(frame) => {
                    let count = frame.frame_count() as u64;
                    if !valid_fresh_frame(&frame, now) {
                        self.dropped += count;
                        continue;
                    }
                    #[cfg(debug_assertions)]
                    if self.fixture_starve_until.is_some_and(|until| now < until) {
                        // Real producer is alive, but this test discards its input
                        // before the processing timeline to exercise underrun.
                        self.last_capture = now;
                        self.dropped += count;
                        continue;
                    }
                    let trimmed = crate::audio::trim_audio_frame_before_epoch(frame, self.epoch);
                    self.dropped += trimmed.discarded_frames;
                    let Some(frame) = trimmed.frame else { continue };
                    let clock = self.clock.get_or_insert_with(|| {
                        SourceClock::new(&frame, self.epoch).with_delay(self.delay_frames)
                    });
                    let Some((start, frames)) = clock.interval(&frame) else {
                        self.dropped += count;
                        continue;
                    };
                    if self.timeline.push(0, start, resample_frame(frame, frames)) {
                        self.last_capture = now;
                    }
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    anyhow::bail!("Selected microphone was lost; select or reconnect it explicitly")
                }
            }
        }
        if now.saturating_duration_since(self.last_capture) > Duration::from_secs(2) {
            anyhow::bail!("Selected microphone stopped delivering current PCM");
        }
        if due <= self.timeline.cursor / 480 {
            return Ok(None);
        }
        let sequence = self.timeline.cursor / 480;
        let prepared = self
            .denoise
            .prepare_or_silence(&self.timeline, self.settings, None, true);
        anyhow::ensure!(
            prepared.report.is_none(),
            "Microphone noise processing failed; capture stopped"
        );
        let raw = self.timeline.render_with_provenance();
        let fold = self.fold.plan(&raw.samples, 2);
        let wet = self
            .denoise
            .select(&raw, &prepared.wet, &prepared.captured, self.settings, fold);
        let mut controls = self.settings;
        if wet.is_some() {
            controls.gain_db = 0.0;
        }
        let mut samples = fold_interleaved_f32(
            &wet.as_ref().unwrap_or(&raw).samples,
            2,
            controls,
            fold,
            false,
        );
        self.limiter.process(&mut samples, &mut vec![false; 960]);
        // A denoiser may retain a tail across gaps. Missing capture provenance
        // is exact silence on this transport, never synthesized/stale speech.
        let selected = wet.as_ref().unwrap_or(&raw);
        for (frame, captured) in samples.chunks_exact_mut(2).zip(&selected.captured) {
            if !captured {
                frame.fill(0.0);
            }
        }
        let producer_drops = self
            .producer
            .as_ref()
            .map_or(0, |p| p.stats.dropped_frames());
        Ok(Some(RoomMicrophoneChunk {
            sequence,
            observed_at_us: elapsed_us,
            dropped_frames: self.dropped
                + producer_drops
                + self.timeline.counters.dropped_frames
                + self.timeline.counters.discarded_frames,
            samples: samples.chunks_exact(2).map(|s| s[0]).collect(),
        }))
    }

    #[cfg(debug_assertions)]
    pub(crate) fn starve_fixture(&mut self, enabled: bool) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.producer
                .as_ref()
                .is_some_and(|p| p.caption_injector.is_some()),
            "Starvation fixture requires explicit synthetic capture"
        );
        self.fixture_starve_until = enabled.then(|| Instant::now() + Duration::from_secs(12));
        if enabled {
            let queued: u64 = self
                .timeline
                .packets
                .iter()
                .map(|p| p.end() - p.start)
                .sum();
            self.dropped += queued;
            self.timeline.packets.clear();
            self.denoise = MicrophoneDenoiseTimeline::new();
        }
        Ok(())
    }

    #[cfg(debug_assertions)]
    pub(crate) fn disconnect_fixture(&self) -> anyhow::Result<()> {
        let injector = self
            .producer
            .as_ref()
            .and_then(|p| p.caption_injector.as_ref())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "Only the explicit synthetic capture can be disconnected by this fixture"
                )
            })?;
        injector.disconnect_source();
        Ok(())
    }

    pub(crate) async fn close(&mut self) -> anyhow::Result<()> {
        let Some(producer) = self.producer.take() else {
            return Ok(());
        };
        let mut receipt = producer.retire();
        tokio::time::timeout(Duration::from_secs(5), async {
            while receipt.running() {
                receipt
                    .state
                    .changed()
                    .await
                    .map_err(|_| anyhow::anyhow!("Capture close receipt disappeared"))?;
            }
            anyhow::Ok(())
        })
        .await
        .map_err(|_| {
            anyhow::anyhow!("Capture close deadline exceeded; ownership remains fenced")
        })??;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(offset_ms: u32) -> (RoomMicrophoneTap, mpsc::Sender<AudioFrame>) {
        let (sender, receiver) = mpsc::channel();
        let epoch = Instant::now();
        let mut timeline = AudioTimeline::new();
        timeline.ahead_limit = 1920 + 960 + u64::from(offset_ms) * 48;
        (
            RoomMicrophoneTap {
                producer: None,
                receiver,
                timeline,
                clock: None,
                denoise: MicrophoneDenoiseTimeline::new(),
                fold: VoiceFold::default(),
                limiter: PeakLimiter::default(),
                epoch,
                origin_us: crate::room_clock::origin_us(epoch),
                incarnation: crate::room_clock::incarnation(),
                last_capture: epoch,
                settings: AudioProcessingSettings::default(),
                delay_frames: u64::from(offset_ms) * 48,
                dropped: 0,
                #[cfg(debug_assertions)]
                fixture_starve_until: None,
            },
            sender,
        )
    }
    fn frame(epoch: Instant, index: u64, value: f32) -> AudioFrame {
        AudioFrame {
            timestamp_micros: index * 10000,
            captured_at: epoch + Duration::from_millis((index + 1) * 10),
            sample_rate: 48000,
            channels: 2,
            samples: vec![value; 960],
        }
    }
    #[test]
    fn gain_mute_once_and_no_repeated_chunk_after_underrun() {
        let (mut tap, tx) = fixture(0);
        tx.send(frame(tap.epoch, 0, 0.1)).unwrap();
        tap.settings.gain_db = 6.0;
        let output = tap
            .pull(tap.epoch + Duration::from_millis(40))
            .unwrap()
            .unwrap();
        assert!((output.samples[100] - 0.1 * 10_f32.powf(0.3)).abs() < 1e-5);
        assert!(
            tap.pull(tap.epoch + Duration::from_millis(40))
                .unwrap()
                .is_none()
        );
        let silence = tap
            .pull(tap.epoch + Duration::from_millis(50))
            .unwrap()
            .unwrap();
        assert!(silence.samples.iter().all(|v| *v == 0.0));
        tx.send(frame(tap.epoch, 2, 0.2)).unwrap();
        tap.settings.muted = true;
        let muted = tap
            .pull(tap.epoch + Duration::from_millis(60))
            .unwrap()
            .unwrap();
        assert!(muted.samples.iter().all(|v| *v == 0.0));
    }
    #[test]
    fn origin_is_fixed_per_epoch_and_bounds_the_observed_sum() {
        crate::room_clock::init();
        let (mut tap, tx) = fixture(0);
        assert_eq!(tap.origin_us, crate::room_clock::origin_us(tap.epoch));
        assert!(tap.origin_us.is_some() && tap.incarnation.is_some());
        tx.send(frame(tap.epoch, 0, 0.1)).unwrap();
        let before = tap.clock_origin();
        tap.pull(tap.epoch + Duration::from_millis(40))
            .unwrap()
            .unwrap();
        assert_eq!(tap.clock_origin(), before, "one origin per generation");
        tap.origin_us = Some(MAX_SAFE_INTEGER - 45_000);
        assert!(tap.pull(tap.epoch + Duration::from_millis(50)).is_err());
        tap.origin_us = None;
        assert!(tap.pull(tap.epoch + Duration::from_millis(50)).is_ok());
    }
    #[test]
    fn bounded_offset_overrun_and_disconnected_source() {
        let (mut tap, tx) = fixture(100);
        tx.send(frame(tap.epoch, 0, 0.2)).unwrap();
        let delayed = tap
            .pull(tap.epoch + Duration::from_millis(40))
            .unwrap()
            .unwrap();
        assert!(delayed.samples.iter().all(|v| *v == 0.0));
        let late = tap
            .pull(tap.epoch + Duration::from_millis(500))
            .unwrap()
            .unwrap();
        assert!(late.dropped_frames > 0);
        assert_eq!(late.samples.len(), 480);
        drop(tx);
        assert!(tap.pull(tap.epoch + Duration::from_millis(510)).is_err());
    }
    #[test]
    fn native_rnnoise_executes_the_existing_model_and_mute_is_exact() {
        crate::microphone_denoise::prewarm();
        let (mut dry, tx) = fixture(0);
        let (mut wet, wx) = fixture(0);
        wet.settings.noise_suppression = crate::protocol::MicrophoneNoiseSuppression::Rnnoise;
        let mut difference = 0.0_f64;
        for i in 0..80 {
            for n in i..i + 3 {
                let value = ((n * 17 % 37) as f32 - 18.0) * 0.003;
                tx.send(frame(dry.epoch, n, value)).unwrap();
                wx.send(frame(wet.epoch, n, value)).unwrap();
            }
            let a = dry
                .pull(dry.epoch + Duration::from_millis((i + 4) * 10))
                .unwrap()
                .unwrap();
            let b = wet
                .pull(wet.epoch + Duration::from_millis((i + 4) * 10))
                .unwrap()
                .unwrap();
            difference += a
                .samples
                .iter()
                .zip(b.samples)
                .map(|(a, b)| f64::from((*a - b).abs()))
                .sum::<f64>();
        }
        for millis in [840, 850] {
            wet.pull(wet.epoch + Duration::from_millis(millis)).unwrap();
        }
        let underrun = wet
            .pull(wet.epoch + Duration::from_millis(860))
            .unwrap()
            .unwrap();
        assert!(
            underrun.samples.iter().all(|sample| *sample == 0.0),
            "RNNoise tail cannot turn an underrun into stale audio"
        );
        assert!(
            difference > 0.01,
            "The actual native denoiser changes the input"
        );
    }
}
