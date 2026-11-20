//! The SRT Camera's two loops (plan 255). The receiver listens, demuxes and
//! decodes. The pacer publishes each new frame into the camera frame store
//! as soon as it is decoded, and the held frame or the still once per canvas
//! interval, so a camera that is silent by design still looks healthy to
//! every cadence check (D7).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

use super::ListenConfig;
use super::annexb::{ParameterSets, ParsedAccessUnit, parse_access_unit};
use super::listener::{self, ListenError, ListenerEvent};
use super::signal::{
    HOLD, ListenerTrouble, Picture, SignalTracker, unsupported_codec_line, waiting_line,
};
use super::ts_demux::{DemuxEvent, TsDemuxer, VideoCodec};

/// D9's boundary: one platform turns access units into frames.
pub trait FrameDecoder {
    type Frame: Clone + Send + 'static;
    /// Frames this unit produced (a decoder may hold one back to reorder).
    fn decode(
        &mut self,
        codec: VideoCodec,
        parameter_sets: &ParameterSets,
        unit: &ParsedAccessUnit,
        pts: Option<u64>,
    ) -> Result<Vec<Self::Frame>, String>;
    fn frame_size(frame: &Self::Frame) -> (u32, u32);
    /// A new sender: forget the last stream's state.
    fn reset(&mut self);
}

pub struct CameraState<F> {
    pub tracker: SignalTracker,
    /// The newest decoded frame and a running count of decoded frames:
    /// they change together (`put_frames`), so the pacer always knows a new
    /// frame from the held one.
    latest: Option<F>,
    latest_sequence: u64,
    /// Wakes the pacer when `put_frames` stores a frame.
    new_frame: Arc<Condvar>,
    pub listening: bool,
}

impl<F> CameraState<F> {
    /// `frame` is the newest of `count` frames just decoded.
    fn put_frames(&mut self, frame: F, count: usize) {
        self.latest = Some(frame);
        self.latest_sequence += count as u64;
        self.new_frame.notify_all();
    }
}

impl<F> Default for CameraState<F> {
    fn default() -> Self {
        Self {
            tracker: SignalTracker::new(),
            latest: None,
            latest_sequence: 0,
            new_frame: Arc::new(Condvar::new()),
            listening: false,
        }
    }
}

pub type Shared<F> = Arc<Mutex<CameraState<F>>>;

/// What the pacer draws this tick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Show {
    Frame,
    Still(String),
}

pub fn choose(picture: &Picture, has_frame: bool, port: u16) -> Show {
    match picture {
        Picture::Frame if has_frame => Show::Frame,
        Picture::Frame | Picture::Waiting => Show::Still(waiting_line(port)),
        Picture::UnsupportedCodec(codec) => Show::Still(unsupported_codec_line(codec)),
    }
}

/// Turns listener events into frames and state; the receiver's logic,
/// without the socket.
pub struct Receiver<D: FrameDecoder> {
    decoder: D,
    demuxer: TsDemuxer,
    parameter_sets: ParameterSets,
    need_keyframe: bool,
    events: Vec<DemuxEvent>,
    /// The last decoded frame, or the first submission since the decoder
    /// (re)started: the no-output deadline runs from it.
    last_output: Option<Instant>,
    /// The last rebuild for lack of output, so rebuilds stay apart.
    last_rebuild: Option<Instant>,
    /// The sender accepted last and when, until its first frame.
    awaiting_first_frame: Option<(i32, Instant)>,
    /// When a frame is handed over. The events' `now` is taken before
    /// demuxing and decoding, so the first-frame line reads this instead.
    clock: Box<dyn Fn() -> Instant + Send>,
    /// The development frame tap, when one is on (`frame_tap.rs`).
    #[cfg(debug_assertions)]
    frame_hook: Option<FrameHook<D::Frame>>,
    #[cfg(test)]
    first_frame_lines: Vec<String>,
}

/// What a frame hook hears about each decoded frame.
#[cfg(debug_assertions)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedMeta {
    /// When the decode that returned the frame finished.
    pub decoded_at: Instant,
    /// When the access unit whose decode returned it finished arriving.
    pub arrived_at: Instant,
    pub sender_session: u32,
}

#[cfg(debug_assertions)]
pub type FrameHook<F> = Box<dyn FnMut(&F, DecodedMeta) + Send>;

/// The one line per sender a soak reads from the backend log (documented
/// in docs/srt-camera.md, keep it stable): from libsrt's accept to the
/// sender's first decoded frame handed to the camera's output.
pub fn first_frame_line(sender: i32, after: Duration) -> String {
    format!(
        "[srt-camera] sender {sender} first frame after {} ms",
        after.as_millis()
    )
}

impl<D: FrameDecoder> Receiver<D> {
    pub fn new(decoder: D) -> Self {
        Self::with_clock(decoder, Box::new(Instant::now))
    }

    fn with_clock(decoder: D, clock: Box<dyn Fn() -> Instant + Send>) -> Self {
        Self {
            decoder,
            demuxer: TsDemuxer::new(),
            parameter_sets: ParameterSets::default(),
            need_keyframe: true,
            events: Vec::new(),
            last_output: None,
            last_rebuild: None,
            awaiting_first_frame: None,
            clock,
            #[cfg(debug_assertions)]
            frame_hook: None,
            #[cfg(test)]
            first_frame_lines: Vec::new(),
        }
    }

    /// Every decoded frame also goes to `hook` (the development frame tap).
    #[cfg(debug_assertions)]
    pub fn with_frame_hook(mut self, hook: FrameHook<D::Frame>) -> Self {
        self.frame_hook = Some(hook);
        self
    }

    fn restart_stream(&mut self) {
        self.demuxer = TsDemuxer::new();
        self.parameter_sets = ParameterSets::default();
        self.need_keyframe = true;
        self.last_output = None;
        self.decoder.reset();
    }

    /// A new decoder session from the next key frame (D18). The no-output
    /// deadline starts again only when decoding resumes, however far away
    /// that key frame is.
    fn rebuild_decoder(&mut self, now: Instant) {
        self.decoder.reset();
        self.need_keyframe = true;
        self.last_output = None;
        self.last_rebuild = Some(now);
    }

    pub fn handle(&mut self, event: ListenerEvent, shared: &Shared<D::Frame>, now: Instant) {
        match event {
            ListenerEvent::Listening => {
                let mut state = lock(shared);
                state.listening = true;
                state.tracker.on_listening();
            }
            ListenerEvent::SenderAccepted(sender) => {
                self.restart_stream();
                self.awaiting_first_frame = Some((sender, now));
                lock(shared).tracker.on_sender_accepted();
            }
            ListenerEvent::SenderLeft => {
                self.restart_stream();
                self.awaiting_first_frame = None;
                lock(shared).tracker.on_sender_left();
            }
            ListenerEvent::Refused(refusal) => lock(shared).tracker.on_refusal(refusal, now),
            ListenerEvent::Data(bytes) => {
                let mut events = std::mem::take(&mut self.events);
                self.demuxer.push(&bytes, &mut events);
                for event in events.drain(..) {
                    self.demuxed(event, shared, now);
                }
                self.events = events;
            }
        }
    }

    fn demuxed(&mut self, event: DemuxEvent, shared: &Shared<D::Frame>, now: Instant) {
        match event {
            DemuxEvent::Video(codec) => {
                self.parameter_sets = ParameterSets::default();
                self.need_keyframe = true;
                lock(shared).tracker.on_video(codec);
            }
            DemuxEvent::Discontinuity => self.need_keyframe = true,
            DemuxEvent::AccessUnit { codec, pts, data } => {
                if matches!(codec, VideoCodec::Unsupported(_)) {
                    return;
                }
                lock(shared).tracker.on_unit(now);
                let unit = parse_access_unit(codec, &data);
                let previous = self.parameter_sets.clone();
                self.parameter_sets.update(&unit.parameter_sets);
                if previous.complete(codec) && previous != self.parameter_sets {
                    // The sender changed its format mid-stream (D18): a new
                    // session, from the next key frame.
                    self.rebuild_decoder(now);
                }
                if self.need_keyframe && !unit.keyframe {
                    return;
                }
                if !self.parameter_sets.complete(codec) || unit.length_prefixed.is_empty() {
                    return;
                }
                self.need_keyframe = false;
                let started = *self.last_output.get_or_insert(now);
                match self.decoder.decode(codec, &self.parameter_sets, &unit, pts) {
                    Ok(frames) => match frames.len() {
                        decoded @ 1.. => {
                            #[cfg(debug_assertions)]
                            if let Some(hook) = self.frame_hook.as_mut() {
                                let meta = DecodedMeta {
                                    decoded_at: (self.clock)(),
                                    arrived_at: now,
                                    sender_session: lock(shared).tracker.sender_session(),
                                };
                                for frame in &frames {
                                    hook(frame, meta);
                                }
                            }
                            // Every frame counts; only the newest is shown.
                            self.last_output = Some(now);
                            let frame = frames.into_iter().last().expect("at least one frame");
                            let (width, height) = D::frame_size(&frame);
                            let mut state = lock(shared);
                            for _ in 0..decoded {
                                state.tracker.on_frame(now, width, height);
                            }
                            // Counts frames, as the rate does, not decode calls.
                            state.put_frames(frame, decoded);
                            drop(state);
                            self.note_first_frame();
                        }
                        // Accepted, but nothing came back. A dropped frame
                        // now and then is fine; none for the hold is a
                        // decoder that reports its failures only as silence
                        // (D18).
                        _ if now.saturating_duration_since(started) >= HOLD
                            && self
                                .last_rebuild
                                .is_none_or(|at| now.saturating_duration_since(at) >= HOLD) =>
                        {
                            tracing::warn!(
                                "[srt-camera] no frame decoded for {} ms; rebuilding the decoder",
                                now.saturating_duration_since(started).as_millis()
                            );
                            lock(shared).tracker.on_decode_failed();
                            self.rebuild_decoder(now);
                        }
                        _ => {}
                    },
                    Err(error) => {
                        // A failed or invalid session (after a sleep, say) is
                        // rebuilt at the next key frame (D18).
                        tracing::warn!("[srt-camera] decode failed: {error}");
                        lock(shared).tracker.on_decode_failed();
                        self.rebuild_decoder(now);
                    }
                }
            }
        }
    }
}

impl<D: FrameDecoder> Receiver<D> {
    /// Right after the frame is handed to the camera's output, so the time
    /// includes demuxing and decoding. The clock is read only for a first
    /// frame.
    fn note_first_frame(&mut self) {
        let Some((sender, accepted_at)) = self.awaiting_first_frame.take() else {
            return;
        };
        let handed_over = (self.clock)();
        let line = first_frame_line(sender, handed_over.saturating_duration_since(accepted_at));
        tracing::info!("{line}");
        #[cfg(test)]
        self.first_frame_lines.push(line);
    }
}

fn lock<F>(shared: &Shared<F>) -> std::sync::MutexGuard<'_, CameraState<F>> {
    shared.lock().unwrap_or_else(PoisonError::into_inner)
}

/// How long the receiver waits before opening the port again after a
/// failure: short, doubling, never more than 2 s (D18).
pub fn listener_retry_delay(failures_in_a_row: u32) -> Duration {
    Duration::from_millis(250u64.saturating_mul(1 << failures_in_a_row.min(8)))
        .min(Duration::from_secs(2))
}

/// Listens while the camera runs and the setting is on; rebinds when the
/// setting changes, and opens the port again after any failure for as long
/// as the camera runs (D18). Returns when `stop` is set.
pub fn receive_loop<D: FrameDecoder>(
    receiver: Receiver<D>,
    shared: Shared<D::Frame>,
    stop: Arc<AtomicBool>,
) {
    receive_loop_with(
        receiver,
        &shared,
        &stop,
        &super::listen_config,
        &mut listener::run,
        &mut std::thread::sleep,
    );
}

type Listen<'a> = dyn FnMut(
        &ListenConfig,
        &dyn Fn() -> bool,
        &mut dyn FnMut(ListenerEvent),
    ) -> Result<(), ListenError>
    + 'a;

pub fn receive_loop_with<D: FrameDecoder>(
    mut receiver: Receiver<D>,
    shared: &Shared<D::Frame>,
    stop: &AtomicBool,
    config: &dyn Fn() -> (u64, ListenConfig),
    listen: &mut Listen<'_>,
    sleep: &mut dyn FnMut(Duration),
) {
    let mut failures_in_a_row = 0;
    let mut last_error: Option<String> = None;
    while !stop.load(Ordering::Acquire) {
        let (generation, settings) = config();
        if !settings.enabled || settings.passphrase.is_empty() {
            let mut state = lock(shared);
            state.listening = false;
            if settings.enabled {
                state
                    .tracker
                    .on_listener_failed(ListenerTrouble::NoPassphrase);
            }
            drop(state);
            sleep(Duration::from_millis(250));
            continue;
        }
        let keep_running = || !stop.load(Ordering::Acquire) && config().0 == generation;
        let mut heard_listening = false;
        let result = listen(&settings, &keep_running, &mut |event| {
            heard_listening |= event == ListenerEvent::Listening;
            receiver.handle(event, shared, Instant::now());
        });
        lock(shared).listening = false;
        receiver.handle(ListenerEvent::SenderLeft, shared, Instant::now());
        if heard_listening {
            failures_in_a_row = 0;
        }
        match result {
            Ok(()) => last_error = None,
            Err(error) => {
                lock(shared).tracker.on_listener_failed(error.trouble);
                if last_error.as_ref() != Some(&error.message) {
                    tracing::warn!(
                        "[srt-camera] listener on port {}: {}",
                        settings.port,
                        error.message
                    );
                    last_error = Some(error.message);
                }
                if !stop.load(Ordering::Acquire) {
                    sleep(listener_retry_delay(failures_in_a_row));
                }
                failures_in_a_row = failures_in_a_row.saturating_add(1);
            }
        }
    }
}

/// How often the camera's status is offered to the Studio.
const STATUS_INTERVAL: Duration = Duration::from_millis(250);

/// Publishes the newest frame as soon as it is decoded, and the held frame or
/// the still once per canvas frame, until `stop` is set.
pub fn pace_loop<F: Clone>(
    shared: Shared<F>,
    stop: Arc<AtomicBool>,
    fps: u32,
    // True when the frame reached the camera's output.
    mut publish_frame: impl FnMut(&F) -> bool,
    mut publish_still: impl FnMut(&str),
) {
    let interval = Duration::from_secs_f64(1.0 / f64::from(fps.clamp(1, 120)));
    let mut next_tick = Instant::now();
    let mut last_status = Instant::now() - STATUS_INTERVAL;
    let mut published: Option<u64> = None;
    while !stop.load(Ordering::Acquire) {
        let now = Instant::now();
        // Decide first: most wakes publish nothing, so they build nothing.
        let (out, status, seen) = {
            let state = lock(&shared);
            let picture = state.tracker.picture(now);
            let has_frame = matches!(picture, Picture::Frame) && state.latest.is_some();
            let fresh = has_frame && published != Some(state.latest_sequence);
            let out = publish_due(now, next_tick, interval, fresh).map(|next| {
                next_tick = next;
                if has_frame {
                    published = Some(state.latest_sequence);
                    // The canvas may follow a new frame; the receiver's rate
                    // counts every decoded frame, kept or not.
                    let news = fresh.then(|| {
                        let gap = state
                            .tracker
                            .fps(now)
                            .map(|fps| Duration::from_secs_f64(1.0 / fps));
                        (state.latest_sequence, gap)
                    });
                    (state.latest.clone(), news, None)
                } else {
                    (None, None, Some(picture))
                }
            });
            let status = (now.duration_since(last_status) >= STATUS_INTERVAL)
                .then(|| state.tracker.status(now, state.listening));
            (out, status, state.latest_sequence)
        };
        match out {
            Some((Some(frame), news, _)) => {
                // Stamped once the frame is in the store, so a tick never
                // seems to have drawn a frame it could not see.
                if publish_frame(&frame)
                    && let Some((sequence, gap)) = news
                {
                    let at = tokio::time::Instant::now();
                    let news = crate::canvas_pace::FrameNews { at, sequence, gap };
                    super::NEW_FRAME.send_replace(Some(news));
                }
            }
            Some((None, _, Some(picture))) => {
                let port = super::listen_config().1.port;
                if let Show::Still(text) = choose(&picture, false, port) {
                    publish_still(&text);
                }
            }
            _ => {}
        }
        if let Some(status) = status {
            last_status = now;
            super::publish_status(status);
        }
        wait_for_frame(&shared, seen, next_tick.min(last_status + STATUS_INTERVAL));
    }
}

/// Waits until a frame is stored after the `seen`th, or until `deadline`.
fn wait_for_frame<F>(shared: &Shared<F>, seen: u64, deadline: Instant) {
    let state = lock(shared);
    let signal = Arc::clone(&state.new_frame);
    let timeout = deadline.saturating_duration_since(Instant::now());
    let _ = signal
        .wait_timeout_while(state, timeout, |state| state.latest_sequence == seen)
        .unwrap_or_else(PoisonError::into_inner);
}

/// The pacer's choice at `now`: Some(next tick) when it publishes.
/// On the canvas tick it publishes (the newest frame, the held one or the
/// still); between ticks, only a frame not yet published, and the cadence
/// counts from it. Far behind, it starts the cadence again from now, so it
/// never publishes twice in a row to catch up.
fn publish_due(
    now: Instant,
    next_tick: Instant,
    interval: Duration,
    fresh: bool,
) -> Option<Instant> {
    if fresh {
        // A held frame waits 1.5 intervals after a new one, so a sender a
        // little slower than the canvas (25 fps on 30) never gets one between
        // its own frames: each picture goes out once.
        Some(now + interval.mul_f64(1.5))
    } else if now >= next_tick {
        let on_time = next_tick + interval;
        Some(if on_time > now {
            on_time
        } else {
            now + interval
        })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{SrtCameraSignal, SrtSenderRefusal};
    use crate::srt_camera::ts_demux::tests::stream;

    #[derive(Default)]
    struct FakeDecoder {
        decoded: Vec<bool>,
        resets: usize,
        /// This decode call (counted from 0) fails, as VideoToolbox does
        /// after a sleep.
        fail_call: Option<usize>,
        calls: usize,
        /// Every unit is accepted and no frame ever comes back: a callback
        /// error or a dropped frame VideoToolbox reports only as no output.
        silent: bool,
        /// The first this many decode calls give nothing back.
        silent_calls: usize,
        /// After each reset, the first submission gives nothing back (a
        /// session holding back its first frame).
        hold_first_after_reset: bool,
        held_since_reset: bool,
        /// Frames each decode call hands back.
        frames_per_call: usize,
        /// Each decode call takes this long on the receiver's clock.
        decode_takes: Option<(TestClock, Duration)>,
    }

    /// A clock a test moves by hand, as the receiver reads it.
    type TestClock = Arc<Mutex<Instant>>;

    fn clocked_receiver(
        decode_takes: Duration,
    ) -> (
        Receiver<FakeDecoder>,
        Shared<(u32, u32)>,
        TestClock,
        Instant,
    ) {
        let start = Instant::now();
        let clock: TestClock = Arc::new(Mutex::new(start));
        let decoder = FakeDecoder {
            decode_takes: Some((clock.clone(), decode_takes)),
            ..FakeDecoder::default()
        };
        let read = clock.clone();
        let receiver = Receiver::with_clock(decoder, Box::new(move || *read.lock().unwrap()));
        (receiver, Arc::default(), clock, start)
    }

    impl FrameDecoder for FakeDecoder {
        type Frame = (u32, u32);

        fn decode(
            &mut self,
            _codec: VideoCodec,
            _parameter_sets: &ParameterSets,
            unit: &ParsedAccessUnit,
            _pts: Option<u64>,
        ) -> Result<Vec<Self::Frame>, String> {
            let call = self.calls;
            self.calls += 1;
            if let Some((clock, takes)) = &self.decode_takes {
                *clock.lock().unwrap() += *takes;
            }
            if self.fail_call == Some(call) {
                return Err("the session is gone".to_string());
            }
            if self.silent || call < self.silent_calls {
                return Ok(Vec::new());
            }
            if self.hold_first_after_reset && !self.held_since_reset {
                self.held_since_reset = true;
                return Ok(Vec::new());
            }
            self.decoded.push(unit.keyframe);
            Ok(vec![(1920, 1080); self.frames_per_call.max(1)])
        }

        fn frame_size(frame: &Self::Frame) -> (u32, u32) {
            *frame
        }

        fn reset(&mut self) {
            self.resets += 1;
            self.held_since_reset = false;
        }
    }

    fn h264_key() -> Vec<u8> {
        [
            &[0, 0, 0, 1, 0x67, 1][..],
            &[0, 0, 0, 1, 0x68, 2],
            &[0, 0, 0, 1, 0x65, 3],
        ]
        .concat()
    }

    fn h264_delta() -> Vec<u8> {
        vec![0, 0, 0, 1, 0x41, 9]
    }

    fn h264_key_with_sps(sps: u8) -> Vec<u8> {
        [
            &[0, 0, 0, 1, 0x67, sps][..],
            &[0, 0, 0, 1, 0x68, 2],
            &[0, 0, 0, 1, 0x65, 3],
        ]
        .concat()
    }

    fn accepted_receiver() -> (Receiver<FakeDecoder>, Shared<(u32, u32)>, Instant) {
        let shared: Shared<(u32, u32)> = Arc::default();
        let mut receiver = Receiver::new(FakeDecoder::default());
        let now = Instant::now();
        receiver.handle(ListenerEvent::SenderAccepted(7), &shared, now);
        (receiver, shared, now)
    }

    /// The soak reads one line per sender, from its accept to its first
    /// frame handed to the camera's output; never one per frame, and none
    /// for a sender that leaves without a frame (a pairing check).
    #[test]
    fn srt_receiver_logs_each_senders_first_frame_once() {
        let (mut receiver, shared, clock, start) = clocked_receiver(Duration::ZERO);
        receiver.handle(ListenerEvent::SenderAccepted(7), &shared, start);
        let frames = stream(
            0x1b,
            &[
                (0, h264_key()),
                (1, h264_delta()),
                (2, h264_delta()),
                (3, vec![]),
            ],
        );
        let first_at = start + Duration::from_millis(412);
        *clock.lock().unwrap() = first_at;
        receiver.handle(ListenerEvent::Data(frames.clone()), &shared, first_at);
        let later = first_at + Duration::from_millis(500);
        *clock.lock().unwrap() = later;
        receiver.handle(ListenerEvent::Data(frames.clone()), &shared, later);
        assert_eq!(
            receiver.first_frame_lines,
            vec!["[srt-camera] sender 7 first frame after 412 ms".to_string()]
        );

        // A pairing check: accepted, gone, no frame, no line.
        receiver.handle(ListenerEvent::SenderLeft, &shared, later);
        receiver.handle(ListenerEvent::SenderAccepted(8), &shared, later);
        receiver.handle(ListenerEvent::SenderLeft, &shared, later);
        // The next sender gets its own line.
        let next_at = later + Duration::from_secs(1);
        receiver.handle(ListenerEvent::SenderAccepted(9), &shared, next_at);
        let next_first = next_at + Duration::from_millis(1250);
        *clock.lock().unwrap() = next_first;
        receiver.handle(ListenerEvent::Data(frames), &shared, next_first);
        assert_eq!(
            receiver.first_frame_lines,
            vec![
                "[srt-camera] sender 7 first frame after 412 ms".to_string(),
                "[srt-camera] sender 9 first frame after 1250 ms".to_string()
            ]
        );
    }

    /// The pacer (latency work): a new frame goes out as soon as it
    /// is seen and the canvas cadence counts from there; without one, the
    /// held frame or the still goes out at the canvas rate.
    #[test]
    fn srt_pacer_publishes_a_new_frame_at_once() {
        let interval = Duration::from_millis(33);
        let tick = Instant::now() + interval;
        let early = tick - Duration::from_millis(20);
        assert_eq!(
            publish_due(early, tick, interval, true),
            Some(early + interval.mul_f64(1.5)),
            "a new frame before the tick goes out now"
        );
        assert_eq!(publish_due(early, tick, interval, false), None);
        assert_eq!(
            publish_due(tick, tick, interval, false),
            Some(tick + interval),
            "the cadence repeats the last picture on time"
        );
        assert_eq!(
            publish_due(tick, tick, interval, true),
            Some(tick + interval.mul_f64(1.5)),
            "a new frame on the tick also holds the next repeat back"
        );
        let late = tick + interval * 3;
        assert_eq!(
            publish_due(late, tick, interval, false),
            Some(late + interval),
            "far behind: no burst to catch up"
        );
    }

    /// The pacer waits for a stored frame, not in short polls: a frame
    /// from the receiver wakes it at once, and with none it waits until
    /// its next deadline.
    #[test]
    fn srt_pacer_wakes_when_a_frame_is_stored() {
        let shared: Shared<(u32, u32)> = Arc::default();
        let far = Instant::now() + Duration::from_secs(10);
        let storer = {
            let shared = Arc::clone(&shared);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(50));
                lock(&shared).put_frames((1, 1), 1);
            })
        };
        let started = Instant::now();
        wait_for_frame(&shared, 0, far);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the stored frame woke the pacer"
        );
        storer.join().unwrap();

        let started = Instant::now();
        wait_for_frame(&shared, 0, far);
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "a frame stored before the wait: no wait"
        );

        let deadline = Instant::now() + Duration::from_millis(30);
        wait_for_frame(&shared, 1, deadline);
        assert!(
            Instant::now() >= deadline,
            "no new frame: it waits out the deadline"
        );
    }

    /// The frame tap hears about every decoded frame: when its unit
    /// arrived, when the decode returned it (on the receiver's clock, so
    /// decoding counts), and the sender.
    #[test]
    fn srt_receiver_tells_a_frame_hook_about_every_decoded_frame() {
        let (receiver, shared, clock, start) = clocked_receiver(Duration::from_millis(7));
        let heard = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&heard);
        let mut receiver = receiver.with_frame_hook(Box::new(move |frame: &(u32, u32), meta| {
            log.lock().unwrap().push((*frame, meta));
        }));
        receiver.decoder.frames_per_call = 2;
        receiver.handle(ListenerEvent::SenderAccepted(7), &shared, start);
        let arrived = start + Duration::from_millis(40);
        *clock.lock().unwrap() = arrived;
        let bytes = stream(0x1b, &[(0, h264_key()), (1, vec![])]);
        receiver.handle(ListenerEvent::Data(bytes), &shared, arrived);
        let heard = heard.lock().unwrap();
        assert_eq!(heard.len(), 2, "both frames of the decode");
        for (frame, meta) in heard.iter() {
            assert_eq!(*frame, (1920, 1080));
            assert_eq!(meta.arrived_at, arrived);
            assert_eq!(meta.decoded_at, arrived + Duration::from_millis(7));
            assert_eq!(meta.sender_session, 1);
        }
    }

    /// The line ends when the frame is handed over, after
    /// the decoder's work, not when its bytes arrived.
    #[test]
    fn srt_receiver_first_frame_time_includes_the_decode() {
        let (mut receiver, shared, clock, start) = clocked_receiver(Duration::from_millis(300));
        receiver.handle(ListenerEvent::SenderAccepted(7), &shared, start);
        let arrived = start + Duration::from_millis(100);
        *clock.lock().unwrap() = arrived;
        let frames = stream(0x1b, &[(0, h264_key()), (1, vec![])]);
        receiver.handle(ListenerEvent::Data(frames), &shared, arrived);
        assert_eq!(
            receiver.first_frame_lines,
            vec!["[srt-camera] sender 7 first frame after 400 ms".to_string()]
        );
    }

    #[test]
    fn srt_receiver_new_parameter_sets_rebuild_the_decoder_at_a_key_frame() {
        // The sender changes resolution mid-stream: new parameter sets.
        let (mut receiver, shared, now) = accepted_receiver();
        let resets_before = receiver.decoder.resets;
        let new_sps_on_a_delta = [&[0, 0, 0, 1, 0x67, 9][..], &h264_delta()].concat();
        let bytes = stream(
            0x1b,
            &[
                (0, h264_key_with_sps(1)),
                (1, h264_delta()),
                (2, new_sps_on_a_delta),
                (3, h264_delta()),
                (4, h264_key_with_sps(9)),
                (5, h264_delta()),
                (6, vec![]),
            ],
        );
        receiver.handle(ListenerEvent::Data(bytes), &shared, now);
        assert_eq!(receiver.decoder.decoded, vec![true, false, true, false]);
        assert_eq!(receiver.decoder.resets, resets_before + 1, "rebuilt once");
    }

    #[test]
    fn srt_receiver_a_decode_error_rebuilds_and_waits_for_a_key_frame() {
        let (mut receiver, shared, now) = accepted_receiver();
        let resets_before = receiver.decoder.resets;
        receiver.decoder.fail_call = Some(1);
        receiver.handle(
            ListenerEvent::Data(stream(
                0x1b,
                &[
                    (0, h264_key()),
                    (1, h264_delta()),
                    (2, h264_delta()),
                    (3, h264_key()),
                    (4, h264_delta()),
                    (5, vec![1]),
                ],
            )),
            &shared,
            now,
        );
        assert_eq!(receiver.decoder.resets, resets_before + 1);
        // The delta after the failure waits; the next key frame decodes.
        assert_eq!(receiver.decoder.decoded, vec![true, true, false]);
        // The key frame decoded after it clears the count again.
        assert_eq!(shared.lock().unwrap().tracker.decode_failures(), 0);
    }

    #[test]
    fn srt_receiver_counts_a_decode_error() {
        let (mut receiver, shared, now) = accepted_receiver();
        receiver.decoder.fail_call = Some(1);
        receiver.handle(
            ListenerEvent::Data(stream(
                0x1b,
                &[(0, h264_key()), (1, h264_delta()), (2, vec![1])],
            )),
            &shared,
            now,
        );
        assert_eq!(receiver.decoder.decoded, vec![true]);
        assert_eq!(shared.lock().unwrap().tracker.decode_failures(), 1);
    }

    #[test]
    fn srt_receiver_rebuilds_a_decoder_that_accepts_units_but_never_gives_a_frame() {
        let (mut receiver, shared, start) = accepted_receiver();
        receiver.decoder.silent = true;
        // One continuous stream: a key frame, then three seconds of deltas,
        // fed a TS packet at a time, 100 ms apart. Every unit is accepted
        // and none decodes.
        let mut units = vec![(0, h264_key())];
        units.extend((1..=30).map(|n| (n, h264_delta())));
        units.push((31, vec![1]));
        let bytes = stream(0x1b, &units);
        for (index, packet) in bytes.chunks(188).enumerate() {
            let now = start + Duration::from_millis(index as u64 * 100);
            receiver.handle(ListenerEvent::Data(packet.to_vec()), &shared, now);
        }
        assert!(
            receiver.decoder.resets >= 2,
            "no frame for 2 s rebuilds the decoder (resets: {})",
            receiver.decoder.resets
        );
        assert!(
            receiver.decoder.calls < 31,
            "after the rebuild it waits for a key frame instead of feeding deltas"
        );
        assert_eq!(
            shared.lock().unwrap().tracker.decode_failures() as usize,
            receiver.decoder.resets - 1,
            "a decoder that stays silent counts as failing (the first reset is the sender's)"
        );
    }

    /// Finding: a rebuild followed by a key frame more than 2 s later must
    /// not rebuild again before the new session had its chance.
    #[test]
    fn srt_receiver_a_rebuilt_decoder_gets_its_chance_whatever_the_key_frame_interval() {
        for key_interval_units in [30_u64, 50] {
            let (mut receiver, shared, start) = accepted_receiver();
            // A failure that reads as silence for 2.5 s triggers a rebuild;
            // every new session then holds back its first frame.
            receiver.decoder.silent_calls = 25;
            receiver.decoder.hold_first_after_reset = true;
            let units: Vec<(u64, Vec<u8>)> = (0..3 * key_interval_units + 10)
                .map(|n| {
                    let unit = if n % key_interval_units == 0 {
                        h264_key()
                    } else {
                        h264_delta()
                    };
                    (n, unit)
                })
                .collect();
            for (index, packet) in stream(0x1b, &units).chunks(188).enumerate() {
                let now = start + Duration::from_millis(index as u64 * 100);
                receiver.handle(ListenerEvent::Data(packet.to_vec()), &shared, now);
            }
            assert!(
                !receiver.decoder.decoded.is_empty(),
                "key frames {} ms apart: the rebuilt decoder decodes (resets: {})",
                key_interval_units * 100,
                receiver.decoder.resets
            );
        }
    }

    #[test]
    fn srt_receiver_counts_every_frame_a_decode_hands_back() {
        let (mut receiver, shared, now) = accepted_receiver();
        receiver.decoder.frames_per_call = 2;
        receiver.handle(
            ListenerEvent::Data(stream(
                0x1b,
                &[
                    (0, h264_key()),
                    (1, h264_delta()),
                    (2, h264_delta()),
                    (3, vec![1]),
                ],
            )),
            &shared,
            now,
        );
        assert_eq!(receiver.decoder.decoded.len(), 3);
        assert_eq!(
            shared
                .lock()
                .unwrap()
                .tracker
                .status(now, true)
                .frames_decoded,
            6,
            "every frame counts; only the newest is shown"
        );
    }

    #[test]
    fn srt_receiver_counts_data_that_brings_no_picture() {
        let (mut receiver, shared, now) = accepted_receiver();
        // Deltas before any key frame: data, but nothing decodes.
        receiver.handle(
            ListenerEvent::Data(stream(0x1b, &[(0, h264_delta()), (1, h264_delta())])),
            &shared,
            now,
        );
        assert_eq!(
            shared.lock().unwrap().tracker.status(now, true).detail,
            "Receiving, but no picture yet"
        );
    }

    #[test]
    fn srt_listener_retry_waits_short_and_never_more_than_2_s() {
        assert_eq!(listener_retry_delay(0), Duration::from_millis(250));
        assert_eq!(listener_retry_delay(1), Duration::from_millis(500));
        assert_eq!(listener_retry_delay(3), Duration::from_secs(2));
        assert_eq!(listener_retry_delay(40), Duration::from_secs(2));
    }

    #[test]
    fn srt_receiver_restarts_a_failed_listener_while_the_camera_runs() {
        let shared: Shared<(u32, u32)> = Arc::default();
        let stop = Arc::new(AtomicBool::new(false));
        let config = || {
            (
                1,
                ListenConfig {
                    enabled: true,
                    port: 9123,
                    latency_ms: 40,
                    passphrase: "p".repeat(32),
                },
            )
        };
        let mut calls = 0;
        let mut details = Vec::new();
        let mut listen = |_: &ListenConfig,
                          _: &dyn Fn() -> bool,
                          on_event: &mut dyn FnMut(ListenerEvent)|
         -> Result<(), ListenError> {
            calls += 1;
            details.push(
                shared
                    .lock()
                    .unwrap()
                    .tracker
                    .status(Instant::now(), false)
                    .detail,
            );
            if calls == 1 {
                return Err(ListenError {
                    trouble: ListenerTrouble::Library,
                    message: "The SRT library didn't load: tried x".to_string(),
                });
            }
            if calls == 2 {
                return Err(ListenError::port("port busy for a moment".to_string()));
            }
            on_event(ListenerEvent::Listening);
            stop.store(true, Ordering::Release);
            Ok(())
        };
        let mut delays = Vec::new();
        let mut sleep = |delay: Duration| delays.push(delay);
        receive_loop_with(
            Receiver::new(FakeDecoder::default()),
            &shared,
            &stop,
            &config,
            &mut listen,
            &mut sleep,
        );
        assert_eq!(calls, 3, "the listener came back after two failures");
        assert_eq!(
            delays,
            vec![Duration::from_millis(250), Duration::from_millis(500)]
        );
        assert_eq!(details[1], "The SRT library didn't load. Trying again.");
        assert_eq!(details[2], "Can't open the port. Trying again.");
        assert_eq!(
            shared
                .lock()
                .unwrap()
                .tracker
                .status(Instant::now(), true)
                .detail,
            "Waiting",
            "listening again clears the line"
        );
    }

    #[test]
    fn srt_receiver_says_when_the_passphrase_did_not_load() {
        let shared: Shared<(u32, u32)> = Arc::default();
        let stop = AtomicBool::new(false);
        let config = || {
            (
                1,
                ListenConfig {
                    enabled: true,
                    port: 9123,
                    latency_ms: 40,
                    passphrase: String::new(),
                },
            )
        };
        let mut listen = |_: &ListenConfig,
                          _: &dyn Fn() -> bool,
                          _: &mut dyn FnMut(ListenerEvent)|
         -> Result<(), ListenError> {
            panic!("never listens without a passphrase")
        };
        let mut sleep = |_: Duration| stop.store(true, Ordering::Release);
        receive_loop_with(
            Receiver::new(FakeDecoder::default()),
            &shared,
            &stop,
            &config,
            &mut listen,
            &mut sleep,
        );
        assert_eq!(
            shared
                .lock()
                .unwrap()
                .tracker
                .status(Instant::now(), false)
                .detail,
            "The passphrase didn't load. Turn SRT input off and on in Settings → General to try again."
        );
    }

    #[test]
    fn srt_pacer_shows_the_frame_or_the_still() {
        assert_eq!(choose(&Picture::Frame, true, 9000), Show::Frame);
        assert_eq!(
            choose(&Picture::Frame, false, 9000),
            Show::Still("Waiting for SRT stream on port 9000".to_string())
        );
        assert_eq!(
            choose(&Picture::Waiting, true, 9100),
            Show::Still("Waiting for SRT stream on port 9100".to_string())
        );
        assert_eq!(
            choose(
                &Picture::UnsupportedCodec("MPEG-2".to_string()),
                false,
                9000
            ),
            Show::Still("This SRT stream uses a codec Videorc can't show (MPEG-2).".to_string())
        );
    }

    #[test]
    fn srt_receiver_decodes_from_the_first_keyframe() {
        let shared: Shared<(u32, u32)> = Arc::default();
        let mut receiver = Receiver::new(FakeDecoder::default());
        let now = Instant::now();
        receiver.handle(ListenerEvent::Listening, &shared, now);
        receiver.handle(ListenerEvent::SenderAccepted(7), &shared, now);
        let bytes = stream(
            0x1b,
            &[
                (0, h264_delta()),
                (3000, h264_key()),
                (6000, h264_delta()),
                (9000, h264_delta()),
            ],
        );
        receiver.handle(ListenerEvent::Data(bytes), &shared, now);
        assert_eq!(receiver.decoder.decoded, vec![true, false]);
        let state = shared.lock().unwrap();
        assert!(state.listening);
        assert_eq!(state.latest, Some((1920, 1080)));
        assert_eq!(state.tracker.signal(now), SrtCameraSignal::Receiving);
    }

    #[test]
    fn srt_receiver_a_pairing_check_leaves_the_camera_waiting() {
        let shared: Shared<(u32, u32)> = Arc::default();
        let mut receiver = Receiver::new(FakeDecoder::default());
        let now = Instant::now();
        receiver.handle(ListenerEvent::SenderAccepted(7), &shared, now);
        assert!(
            shared
                .lock()
                .unwrap()
                .tracker
                .status(now, true)
                .sender_connected
        );
        receiver.handle(ListenerEvent::SenderLeft, &shared, now);
        let status = shared.lock().unwrap().tracker.status(now, true);
        assert!(!status.sender_connected, "the sender is gone");
        assert_eq!(
            shared.lock().unwrap().tracker.picture(now),
            Picture::Waiting
        );
        // The next sender is decoded from its own key frame.
        receiver.handle(ListenerEvent::SenderAccepted(7), &shared, now);
        receiver.handle(
            ListenerEvent::Data(stream(0x1b, &[(0, h264_key()), (1, h264_delta())])),
            &shared,
            now,
        );
        assert_eq!(receiver.decoder.decoded, vec![true]);
        assert!(receiver.decoder.resets >= 3);
    }

    #[test]
    fn srt_receiver_reports_refusals() {
        let shared: Shared<(u32, u32)> = Arc::default();
        let mut receiver = Receiver::new(FakeDecoder::default());
        let now = Instant::now();
        receiver.handle(
            ListenerEvent::Refused(SrtSenderRefusal::SecondSender),
            &shared,
            now,
        );
        assert_eq!(
            shared.lock().unwrap().tracker.status(now, true).detail,
            "Second sender refused"
        );
    }

    #[test]
    fn srt_receiver_unknown_codec_never_reaches_the_decoder() {
        let shared: Shared<(u32, u32)> = Arc::default();
        let mut receiver = Receiver::new(FakeDecoder::default());
        let now = Instant::now();
        receiver.handle(
            ListenerEvent::Data(stream(0x02, &[(0, vec![0, 0, 1, 0xb3]), (1, vec![1])])),
            &shared,
            now,
        );
        assert!(receiver.decoder.decoded.is_empty());
        assert_eq!(
            shared.lock().unwrap().tracker.picture(now),
            Picture::UnsupportedCodec("MPEG-2".to_string())
        );
    }
}
