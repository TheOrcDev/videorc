//! Plan 069 S4: one session's System audio switch.
//!
//! [`SessionSystemAudio`] is the only path that opens, attaches, detaches and
//! closes a session's system-audio capture. Requests are latest-wins and
//! idempotent: one reconciler task per session handles them one at a time,
//! so concurrent toggles can never open two captures or leak one.
//!
//! It never blocks the session (decision 12): a request returns at once, the
//! capture opens on its own owner thread (`SystemAudioHandle::prepare`), and
//! the outcome comes back as a [`SystemAudioSessionEvent`]. Re-emitting
//! `recording.status` and the `health.event`s belong to the session in
//! `recording.rs`; a lost stream is reported there too, from the bus's
//! `claim_loss`, because the bus (not this task) observes it.
//!
//! Off means not captured at all (decision 1): turning it off detaches the
//! slot and the capture closes; a start that is still opening is cancelled.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, watch};

use crate::protocol::AudioTrackSource;
use crate::session_audio::{
    ProducerPoolBusy, ProducerSource, SystemAudioEchoPause, SystemAudioHandle, SystemAudioLoss,
    SystemAudioObservation, SystemAudioProducer, SystemAudioRecovery,
};

/// Plan 069 decision 8: system audio's sync offset `o_sys` in ms (positive
/// delays it). S0 measured system audio +5.6 ms behind the screen at capture
/// level (spread 5.7 ms over three runs) and estimated 0 to +11 ms in the
/// recording; 0 sits within ±15 ms of both. Any `o_sys >= 0` keeps the FFmpeg
/// track shift `min(o_mic, o_sys)` at today's value for every non-positive
/// microphone offset, including the default 0. S7 re-measures it end to end
/// (`measure:av-sync --system-audio`).
pub(crate) const SYSTEM_AUDIO_SYNC_OFFSET_MS: i32 = 0;

/// `health.event` codes (the renderer's `SYSTEM_AUDIO_*_CODE`).
pub(crate) const SYSTEM_AUDIO_UNAVAILABLE_CODE: &str = "system-audio-unavailable";
pub(crate) const SYSTEM_AUDIO_LOST_CODE: &str = "system-audio-lost";
/// Plan 076: the bus paused system audio because it carried the stream back
/// into itself.
pub(crate) const SYSTEM_AUDIO_ECHO_PAUSED_CODE: &str = "system-audio-echo-paused";
/// Plan 076: a timeline loss ended; the slot never left the mix.
pub(crate) const SYSTEM_AUDIO_RECOVERED_CODE: &str = "system-audio-recovered";
/// The session's microphone is a direct FFmpeg input (on Windows, the
/// DirectShow fallback when the capture worker cannot open it, or a bundle
/// without the worker), so the session audio bus that mixes system audio is
/// bypassed and the session stays microphone-only (plan 069 S8).
pub(crate) const SYSTEM_AUDIO_MIC_FALLBACK_BYPASS_CODE: &str = "system-audio-mic-fallback-bypass";
/// Free of "screen" words, so the health row never points at the Screen
/// Recording pane; like the worker-fallback event it follows, it links the
/// Microphone pane.
pub(crate) const SYSTEM_AUDIO_MIC_FALLBACK_BYPASS_MESSAGE: &str =
    "System audio is off for this session because the microphone is on a fallback input.";

/// The one system-audio device (`devices.rs`).
#[cfg(any(target_os = "macos", windows))]
const SYSTEM_AUDIO_DEVICE_NAME: &str = "System audio";

/// How long a start waits for this session's previous capture (just turned
/// off, or lost) to finish closing before it gives up. The capture's own stop
/// is bounded by 3 s (`SYSTEM_AUDIO_STOP_BUDGET`); the rest is margin.
const PREVIOUS_CAPTURE_CLEANUP_WAIT: Duration = Duration::from_secs(5);
const CLEANUP_POLL: Duration = Duration::from_millis(50);

/// Whether sessions on this platform can mix system audio. It is a platform
/// fact, not a permission: on macOS the Screen Recording grant is checked when
/// a capture starts, and a missing grant is a `system-audio-unavailable`
/// event. On Windows it is WASAPI process loopback (build 20348 and later,
/// every Windows 11), the same probe that makes the device row Available;
/// loopback needs no grant. Every session on a capable platform runs the bus
/// with the system-audio playout delay and the decision 8 offset split,
/// whether or not the switch is on, so a live toggle never changes FFmpeg. A
/// session whose microphone bypasses the bus cannot mix it
/// ([`SYSTEM_AUDIO_MIC_FALLBACK_BYPASS_CODE`]). Linux is out of scope.
pub(crate) fn system_audio_capable() -> bool {
    #[cfg(target_os = "macos")]
    {
        true
    }
    #[cfg(windows)]
    {
        crate::devices::windows_system_audio_supported()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        false
    }
}

/// The sources one bus track currently mixes (`AudioTrack::mix_sources`). The
/// microphone slot is always part of the bus (paced silence when no microphone
/// is selected); system audio is listed only while its slot is attached.
pub(crate) fn bus_mix_sources(system_attached: bool) -> Vec<AudioTrackSource> {
    let mut sources = vec![AudioTrackSource::Microphone];
    if system_attached {
        sources.push(AudioTrackSource::SystemAudio);
    }
    sources
}

/// Why a requested start failed. Typed so the health copy can point at the
/// Screen Recording permission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SystemAudioStartError {
    pub(crate) permission_required: bool,
    pub(crate) detail: String,
}
impl std::fmt::Display for SystemAudioStartError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.detail)
    }
}
impl std::error::Error for SystemAudioStartError {}

impl SystemAudioStartError {
    fn from_error(error: &anyhow::Error) -> Self {
        error
            .downcast_ref::<SystemAudioStartError>()
            .cloned()
            .unwrap_or_else(|| Self {
                permission_required: false,
                detail: format!("{error:#}"),
            })
    }
}

/// Opens one platform capture as a bus producer. Blocking; it runs on the
/// system pool's owner thread. The test seam: unit tests pass a fake that
/// needs no ScreenCaptureKit.
pub(crate) type SystemAudioOpen = Arc<dyn Fn() -> anyhow::Result<ProducerSource> + Send + Sync>;

/// The platform's system-audio capture, or `None` where sessions cannot mix
/// system audio.
pub(crate) fn platform_opener() -> Option<SystemAudioOpen> {
    #[cfg(any(target_os = "macos", windows))]
    {
        system_audio_capable().then(|| Arc::new(open_platform_capture) as SystemAudioOpen)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        None
    }
}

/// The platform capture as a bus producer: S3's audio-only SCStream on macOS,
/// S8a's WASAPI process-loopback client on Windows (the same
/// `SystemAudioCapture` API). Its failure slot is mirrored into the bus's
/// `ProducerFailure`, so a stream that stops with an error (on Windows,
/// `AUDCLNT_E_DEVICE_INVALIDATED` included) is retired as lost; a deliberate
/// stop (detach, session end) closes the channel with no failure. Dropping the
/// producer's owner stops the stream within the bounded stop budget, and logs
/// (then leaves to finish) a stream that does not answer in time.
#[cfg(any(target_os = "macos", windows))]
fn open_platform_capture() -> anyhow::Result<ProducerSource> {
    use crate::protocol::DeviceStatus;
    use crate::system_audio_capture::{SystemAudioCapture, SystemAudioCaptureOptions};

    let mut capture =
        SystemAudioCapture::start(SystemAudioCaptureOptions::default()).map_err(|failure| {
            anyhow::Error::new(SystemAudioStartError {
                permission_required: failure.device_status()
                    == Some(DeviceStatus::PermissionRequired),
                detail: failure.message().to_string(),
            })
        })?;
    if !capture.info().pid_excluded {
        tracing::warn!(
            "System audio started without excluding the Electron main process; Videorc's own sounds may be recorded."
        );
    }
    let receiver = capture
        .take_receiver()
        .ok_or_else(|| anyhow::anyhow!("The system audio capture has no frame channel."))?;
    let stats = capture.stats_handle();
    let failure = capture.failure_slot().producer_failure();
    Ok(ProducerSource::system(
        crate::devices::SYSTEM_AUDIO_DEVICE_ID.to_string(),
        SYSTEM_AUDIO_DEVICE_NAME.to_string(),
        receiver,
        stats,
        failure,
        Box::new(PlatformCaptureOwner(Some(capture))),
    ))
}

/// Owns the platform capture for the bus. Dropped on the system pool's owner
/// thread when the slot detaches, is lost, or the session ends: it stops the
/// stream within the bounded budget and says how it ended. A stream that does
/// not answer in time is left to finish on its own thread (never a hang).
#[cfg(any(target_os = "macos", windows))]
struct PlatformCaptureOwner(Option<crate::system_audio_capture::SystemAudioCapture>);

#[cfg(any(target_os = "macos", windows))]
impl Drop for PlatformCaptureOwner {
    fn drop(&mut self) {
        let Some(capture) = self.0.take() else {
            return;
        };
        let stats = capture.stats();
        let failure = capture.failure();
        if capture.stop() {
            tracing::info!(
                captured_frames = stats.captured_frames,
                dropped_frames = stats.dropped_frames,
                rejected_buffers = stats.rejected_buffers,
                failure = failure.as_ref().map(|failure| failure.message()),
                "System audio capture closed"
            );
        } else {
            tracing::warn!(
                "System audio capture did not stop within its budget; it finishes on its own thread."
            );
        }
    }
}

/// What the reconciler reports to the session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SystemAudioSessionEvent {
    /// The session's mix changed (a system slot attached or detached):
    /// re-emit `recording.status`.
    MixChanged,
    /// A requested start failed. The session continues without system audio.
    Unavailable(SystemAudioStartError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Request {
    sequence: u64,
    enabled: bool,
}

/// One session's System audio switch. Dropping it (or [`Self::shutdown`])
/// cancels a start still in flight; an attached slot is retired by the bus
/// when the session audio stops.
pub(crate) struct SessionSystemAudio {
    handle: SystemAudioHandle,
    requests: watch::Sender<Request>,
    shutdown: Arc<AtomicBool>,
}

impl std::fmt::Debug for SessionSystemAudio {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SessionSystemAudio")
            .field("requested", &self.requests.borrow().enabled)
            .field("shutdown", &self.shutdown.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}

impl SessionSystemAudio {
    /// Starts the session's reconciler. Nothing opens until
    /// [`Self::request`]`(true)`. Needs a Tokio runtime.
    pub(crate) fn spawn(
        handle: SystemAudioHandle,
        open: SystemAudioOpen,
        events: mpsc::UnboundedSender<SystemAudioSessionEvent>,
    ) -> Self {
        let (requests, receiver) = watch::channel(Request {
            sequence: 0,
            enabled: false,
        });
        let shutdown = Arc::new(AtomicBool::new(false));
        let reconciler = Reconciler {
            handle: handle.clone(),
            open,
            events,
            requests: receiver,
            shutdown: shutdown.clone(),
        };
        tokio::spawn(reconciler.run());
        Self {
            handle,
            requests,
            shutdown,
        }
    }

    /// Turns system audio on or off. Latest wins; repeating the current state
    /// is harmless.
    pub(crate) fn request(&self, enabled: bool) {
        if self.shutdown.load(Ordering::Acquire) {
            return;
        }
        self.requests.send_modify(|request| {
            request.sequence += 1;
            request.enabled = enabled;
        });
    }

    /// Live level change on the slot (clamped by the bus).
    pub(crate) fn set_gain_db(&self, gain_db: f32) {
        self.handle.set_gain_db(gain_db);
    }

    pub(crate) fn mixing(&self) -> bool {
        self.handle.observation().attached
    }

    pub(crate) fn observation(&self) -> SystemAudioObservation {
        self.handle.observation()
    }

    /// One loss per stream that stopped with an error (the bus ramped it out).
    pub(crate) fn claim_loss(&self) -> Option<SystemAudioLoss> {
        self.handle.claim_loss()
    }

    /// One recovery per timeline loss that ended (plan 076).
    pub(crate) fn claim_recovery(&self) -> Option<SystemAudioRecovery> {
        self.handle.claim_recovery()
    }

    /// One pause per loop the echo guard caught (plan 076).
    pub(crate) fn claim_echo_pause(&self) -> Option<SystemAudioEchoPause> {
        self.handle.claim_echo_pause()
    }

    /// Live echo guard On/Off (plan 076).
    pub(crate) fn set_echo_guard(&self, enabled: bool) {
        self.handle.set_echo_guard(enabled);
    }

    /// Session stop: no more starts, and a start still opening is cancelled.
    /// The bus retires an attached slot itself when it stops. Idempotent.
    pub(crate) fn shutdown(&self) {
        if self.shutdown.swap(true, Ordering::AcqRel) {
            return;
        }
        // Wake the reconciler so it cancels an open in flight.
        self.requests.send_modify(|request| {
            request.sequence += 1;
            request.enabled = false;
        });
    }
}

impl Drop for SessionSystemAudio {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct Reconciler {
    handle: SystemAudioHandle,
    open: SystemAudioOpen,
    events: mpsc::UnboundedSender<SystemAudioSessionEvent>,
    requests: watch::Receiver<Request>,
    shutdown: Arc<AtomicBool>,
}

impl Reconciler {
    async fn run(mut self) {
        let mut handled = 0;
        while let Some(request) = self.next_request(handled).await {
            handled = request.sequence;
            if request.enabled {
                self.turn_on().await;
            } else {
                self.turn_off().await;
            }
        }
    }

    async fn next_request(&mut self, handled: u64) -> Option<Request> {
        loop {
            if self.shutdown.load(Ordering::Acquire) {
                return None;
            }
            let current = *self.requests.borrow_and_update();
            if current.sequence != handled {
                return Some(current);
            }
            if self.requests.changed().await.is_err() {
                return None;
            }
        }
    }

    /// The newest request still wants system audio.
    fn wanted(&self) -> bool {
        !self.shutdown.load(Ordering::Acquire) && self.requests.borrow().enabled
    }

    async fn turn_on(&mut self) {
        if self.handle.observation().attached {
            return;
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let prepared = {
            let prepare = prepare_when_free(self.handle.clone(), self.open.clone(), &cancelled);
            tokio::pin!(prepare);
            let mut watching = true;
            loop {
                if !watching {
                    break (&mut prepare).await;
                }
                tokio::select! {
                    result = &mut prepare => break result,
                    changed = self.requests.changed() => {
                        // Superseded by Off (or the session ended): cancel the
                        // open. Its owner thread closes whatever it opened.
                        if changed.is_err() || !self.wanted() {
                            cancelled.store(true, Ordering::Release);
                            watching = false;
                        }
                    }
                }
            }
        };
        match prepared {
            Ok(producer) => {
                if !self.wanted() {
                    // Closes on its own owner thread.
                    drop(producer);
                    return;
                }
                match self.handle.attach(producer).await {
                    Ok(cutover_sample) => {
                        tracing::info!(
                            "System audio joined the session mix at sample {cutover_sample}."
                        );
                        let _ = self.events.send(SystemAudioSessionEvent::MixChanged);
                    }
                    Err(error) => {
                        if self.shutdown.load(Ordering::Acquire) {
                            return;
                        }
                        tracing::warn!("System audio was not attached: {error:#}");
                        let _ = self.events.send(SystemAudioSessionEvent::Unavailable(
                            SystemAudioStartError::from_error(&error),
                        ));
                    }
                }
            }
            Err(error) => {
                if cancelled.load(Ordering::Acquire) || self.shutdown.load(Ordering::Acquire) {
                    return;
                }
                tracing::warn!("System audio could not start: {error:#}");
                let _ = self.events.send(SystemAudioSessionEvent::Unavailable(
                    SystemAudioStartError::from_error(&error),
                ));
            }
        }
    }

    async fn turn_off(&mut self) {
        match self.handle.detach().await {
            Ok(Some(cutover_sample)) => {
                tracing::info!("System audio left the session mix at sample {cutover_sample}.");
                let _ = self.events.send(SystemAudioSessionEvent::MixChanged);
            }
            Ok(None) => {}
            Err(error) => tracing::warn!("System audio detach was not confirmed: {error:#}"),
        }
    }
}

/// Opens a capture in the system pool, first letting a capture this session
/// just turned off (or lost) finish closing: the pool holds one at a time.
async fn prepare_when_free(
    handle: SystemAudioHandle,
    open: SystemAudioOpen,
    cancelled: &Arc<AtomicBool>,
) -> anyhow::Result<SystemAudioProducer> {
    let deadline = Instant::now() + PREVIOUS_CAPTURE_CLEANUP_WAIT;
    loop {
        if cancelled.load(Ordering::Acquire) {
            anyhow::bail!("System audio start was cancelled.");
        }
        let open = open.clone();
        match handle.prepare(move || open(), cancelled.clone()).await {
            Err(error) if error.is::<ProducerPoolBusy>() && Instant::now() < deadline => {
                tokio::time::sleep(CLEANUP_POLL).await;
            }
            result => return result,
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    //! A fake platform capture for session tests: no ScreenCaptureKit.

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Duration;

    use super::{SystemAudioOpen, SystemAudioStartError};
    use crate::audio::{AudioCaptureStats, AudioFrame};
    use crate::session_audio::{ProducerFailure, ProducerSource};

    /// One opened fake capture: the test holds its frame sender and failure
    /// slot.
    pub(crate) struct FakeCapture {
        /// Held so the frame channel stays open: a disconnect reads as loss.
        _frames: mpsc::SyncSender<AudioFrame>,
        pub(crate) failure: ProducerFailure,
    }

    /// Counts opens and live captures, so tests prove nothing leaks.
    #[derive(Clone, Default)]
    pub(crate) struct FakeSystemAudio {
        pub(crate) opens: Arc<AtomicUsize>,
        pub(crate) live: Arc<AtomicUsize>,
        pub(crate) captures: Arc<Mutex<Vec<FakeCapture>>>,
        /// When set, opening fails like a missing Screen Recording grant.
        pub(crate) deny_permission: Arc<std::sync::atomic::AtomicBool>,
        /// Opening blocks this long (a slow `startCapture`).
        pub(crate) open_delay: Arc<Mutex<Duration>>,
    }

    struct LiveGuard(Arc<AtomicUsize>);
    impl Drop for LiveGuard {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::AcqRel);
        }
    }

    impl FakeSystemAudio {
        pub(crate) fn opener(&self) -> SystemAudioOpen {
            let fake = self.clone();
            Arc::new(move || {
                let delay = *fake.open_delay.lock().unwrap();
                if !delay.is_zero() {
                    std::thread::sleep(delay);
                }
                if fake.deny_permission.load(Ordering::Acquire) {
                    return Err(anyhow::Error::new(SystemAudioStartError {
                        permission_required: true,
                        detail: "Screen Recording (Screen & System Audio Recording) is not granted"
                            .into(),
                    }));
                }
                fake.opens.fetch_add(1, Ordering::AcqRel);
                fake.live.fetch_add(1, Ordering::AcqRel);
                let (frames, receiver) = mpsc::sync_channel(64);
                let failure: ProducerFailure = Arc::default();
                fake.captures.lock().unwrap().push(FakeCapture {
                    _frames: frames,
                    failure: failure.clone(),
                });
                Ok(ProducerSource::system(
                    "system-audio:default".into(),
                    "System audio".into(),
                    receiver,
                    Arc::new(AudioCaptureStats::default()),
                    failure,
                    Box::new(LiveGuard(fake.live.clone())),
                ))
            })
        }

        pub(crate) fn live(&self) -> usize {
            self.live.load(Ordering::Acquire)
        }

        pub(crate) fn opens(&self) -> usize {
            self.opens.load(Ordering::Acquire)
        }

        /// Fills the newest capture's failure slot, as `didStopWithError` does.
        pub(crate) fn fail_latest(&self, reason: &str) {
            let captures = self.captures.lock().unwrap();
            let capture = captures.last().expect("an opened capture");
            *capture.failure.lock().unwrap() = Some(reason.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};

    use super::test_support::FakeSystemAudio;
    use super::*;
    use crate::audio::AudioProcessingSettings;
    use crate::session_audio::{SessionAudio, SessionAudioOptions};

    struct Bus {
        session: SessionAudio,
        reader: Option<std::thread::JoinHandle<()>>,
        _path: PathBuf,
    }
    impl Drop for Bus {
        fn drop(&mut self) {
            self.session.request_stop();
            if let Some(reader) = self.reader.take() {
                // The writer closes the FIFO on stop; the reader then sees EOF.
                let _ = reader.join();
            }
        }
    }

    /// A running mic-less bus (the paced-silence path) with a FIFO reader.
    fn running_bus() -> Bus {
        let path = crate::audio::native_audio_fifo_path(&format!(
            "system-audio-session-{}",
            uuid::Uuid::new_v4()
        ));
        crate::audio::create_native_audio_fifo(&path).unwrap();
        let reader_path = path.clone();
        let reader = std::thread::spawn(move || {
            use std::io::Read;
            let Ok(mut file) = std::fs::File::open(&reader_path) else {
                return;
            };
            let mut buffer = [0_u8; 16_384];
            while matches!(file.read(&mut buffer), Ok(read) if read > 0) {}
        });
        let session = crate::session_audio::attach_prepared_with(
            None,
            path.clone(),
            None,
            AudioProcessingSettings::default(),
            Duration::from_secs(2),
            SessionAudioOptions {
                playout_delay: crate::session_audio::SYSTEM_AUDIO_PLAYOUT_DELAY,
                ..SessionAudioOptions::default()
            },
        );
        Bus {
            session,
            reader: Some(reader),
            _path: path,
        }
    }

    async fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !condition() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn next_event(
        events: &mut mpsc::UnboundedReceiver<SystemAudioSessionEvent>,
    ) -> SystemAudioSessionEvent {
        tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("a system audio event")
            .expect("the reconciler is running")
    }

    fn controller(
        bus: &Bus,
        fake: &FakeSystemAudio,
    ) -> (
        SessionSystemAudio,
        mpsc::UnboundedReceiver<SystemAudioSessionEvent>,
    ) {
        let (events, receiver) = mpsc::unbounded_channel();
        (
            SessionSystemAudio::spawn(bus.session.system_audio(), fake.opener(), events),
            receiver,
        )
    }

    #[test]
    fn the_sync_offset_keeps_every_non_positive_microphone_offset_unchanged() {
        assert_eq!(SYSTEM_AUDIO_SYNC_OFFSET_MS, 0);
        for microphone in [-1_000, -250, -1, 0] {
            let split =
                crate::session_audio::split_sync_offsets(microphone, SYSTEM_AUDIO_SYNC_OFFSET_MS);
            assert_eq!(split.track_shift_ms, microphone);
            assert_eq!(split.microphone_delay_frames, 0);
        }
    }

    #[test]
    fn health_codes_match_the_capture_and_the_renderer() {
        assert_eq!(SYSTEM_AUDIO_UNAVAILABLE_CODE, "system-audio-unavailable");
        assert_eq!(SYSTEM_AUDIO_LOST_CODE, "system-audio-lost");
        // Plan 076; the renderer's lib/system-audio-session.ts mirrors both.
        assert_eq!(SYSTEM_AUDIO_ECHO_PAUSED_CODE, "system-audio-echo-paused");
        assert_eq!(SYSTEM_AUDIO_RECOVERED_CODE, "system-audio-recovered");
        #[cfg(target_os = "macos")]
        {
            assert_eq!(
                SYSTEM_AUDIO_UNAVAILABLE_CODE,
                crate::system_audio_capture::SYSTEM_AUDIO_UNAVAILABLE_HEALTH_KIND
            );
            assert_eq!(
                SYSTEM_AUDIO_LOST_CODE,
                crate::system_audio_capture::SYSTEM_AUDIO_LOST_HEALTH_KIND
            );
        }
    }

    #[test]
    fn capability_is_the_platform_and_the_mix_always_names_the_microphone_slot() {
        // macOS always; Windows where process loopback exists (the device
        // row's own probe, so the row shows exactly where sessions mix it);
        // Linux is out of scope.
        #[cfg(target_os = "macos")]
        assert!(system_audio_capable());
        #[cfg(windows)]
        assert_eq!(
            system_audio_capable(),
            crate::devices::windows_system_audio_supported()
        );
        #[cfg(not(any(target_os = "macos", windows)))]
        assert!(!system_audio_capable());
        assert_eq!(platform_opener().is_some(), system_audio_capable());
        assert_eq!(bus_mix_sources(false), vec![AudioTrackSource::Microphone]);
        assert_eq!(
            bus_mix_sources(true),
            vec![AudioTrackSource::Microphone, AudioTrackSource::SystemAudio]
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn on_attaches_and_off_detaches_and_closes_the_capture() {
        let bus = running_bus();
        let fake = FakeSystemAudio::default();
        let (system, mut events) = controller(&bus, &fake);

        system.request(true);
        assert_eq!(
            next_event(&mut events).await,
            SystemAudioSessionEvent::MixChanged
        );
        assert!(system.mixing());
        assert_eq!(fake.live(), 1);

        // Idempotent: On again opens nothing new.
        system.request(true);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(fake.opens(), 1);

        system.request(false);
        assert_eq!(
            next_event(&mut events).await,
            SystemAudioSessionEvent::MixChanged
        );
        assert!(!system.mixing());
        wait_until("the capture to close", || fake.live() == 0).await;

        // Off again is a no-op.
        system.request(false);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(events.try_recv().is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn off_then_on_again_reopens_after_the_old_capture_closes() {
        let bus = running_bus();
        let fake = FakeSystemAudio::default();
        let (system, mut events) = controller(&bus, &fake);
        for _ in 0..3 {
            system.request(true);
            assert_eq!(
                next_event(&mut events).await,
                SystemAudioSessionEvent::MixChanged
            );
            assert!(system.mixing());
            system.request(false);
            assert_eq!(
                next_event(&mut events).await,
                SystemAudioSessionEvent::MixChanged
            );
        }
        wait_until("every capture to close", || fake.live() == 0).await;
        assert_eq!(fake.opens(), 3);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_missing_permission_reports_unavailable_and_the_bus_keeps_running() {
        let bus = running_bus();
        let fake = FakeSystemAudio::default();
        fake.deny_permission.store(true, Ordering::Release);
        let (system, mut events) = controller(&bus, &fake);
        system.request(true);
        match next_event(&mut events).await {
            SystemAudioSessionEvent::Unavailable(error) => {
                assert!(error.permission_required, "{error:?}");
                assert!(error.detail.contains("Screen Recording"), "{error:?}");
            }
            other => panic!("expected Unavailable, got {other:?}"),
        }
        assert!(!system.mixing());
        assert_eq!(fake.live(), 0);
        let before = bus.session.status().sample_cursor;
        wait_until("the bus to keep writing", || {
            bus.session.status().sample_cursor > before
        })
        .await;

        // Granting it later and toggling again works.
        fake.deny_permission.store(false, Ordering::Release);
        system.request(true);
        assert_eq!(
            next_event(&mut events).await,
            SystemAudioSessionEvent::MixChanged
        );
        assert!(system.mixing());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_platform_failure_is_a_claimable_loss_and_on_again_restarts() {
        let bus = running_bus();
        let fake = FakeSystemAudio::default();
        let (system, mut events) = controller(&bus, &fake);
        system.request(true);
        assert_eq!(
            next_event(&mut events).await,
            SystemAudioSessionEvent::MixChanged
        );
        fake.fail_latest("The stream stopped with an error.");
        wait_until("the loss", || !system.mixing()).await;
        let loss = system.claim_loss().expect("one loss");
        assert_eq!(loss.reason, "The stream stopped with an error.");
        assert_eq!(system.claim_loss(), None);
        wait_until("the lost capture to close", || fake.live() == 0).await;
        // The switch is still On for the user; the loss does not restart it
        // on its own. Turning it on again does.
        system.request(true);
        assert_eq!(
            next_event(&mut events).await,
            SystemAudioSessionEvent::MixChanged
        );
        assert!(system.mixing());
        assert_eq!(fake.opens(), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn racing_toggles_never_leak_a_capture_and_the_last_request_wins() {
        let bus = running_bus();
        let fake = FakeSystemAudio::default();
        *fake.open_delay.lock().unwrap() = Duration::from_millis(30);
        let (system, _events) = controller(&bus, &fake);
        for index in 0..40 {
            system.request(index % 2 == 0);
            if index % 7 == 0 {
                tokio::time::sleep(Duration::from_millis(15)).await;
            }
        }
        // The last request (index 39) was Off.
        tokio::time::sleep(Duration::from_millis(300)).await;
        wait_until("every capture to close", || {
            !system.mixing() && fake.live() == 0
        })
        .await;
        assert!(system.observation().attached == system.mixing());

        system.request(true);
        wait_until("On to win", || system.mixing()).await;
        assert_eq!(fake.live(), 1, "exactly one capture is open");
        system.request(false);
        wait_until("Off to win", || !system.mixing() && fake.live() == 0).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn off_while_opening_cancels_the_start() {
        let bus = running_bus();
        let fake = FakeSystemAudio::default();
        *fake.open_delay.lock().unwrap() = Duration::from_millis(300);
        let (system, mut events) = controller(&bus, &fake);
        system.request(true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        system.request(false);
        wait_until("the cancelled capture to close", || {
            fake.live() == 0 && bus.session.system_audio().owned_producer_count() == 0
        })
        .await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!system.mixing());
        assert!(
            events.try_recv().is_err(),
            "a cancelled start is not a failure"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_cancels_a_start_and_refuses_later_requests() {
        let bus = running_bus();
        let fake = FakeSystemAudio::default();
        *fake.open_delay.lock().unwrap() = Duration::from_millis(200);
        let (system, mut events) = controller(&bus, &fake);
        system.request(true);
        tokio::time::sleep(Duration::from_millis(20)).await;
        system.shutdown();
        system.request(true);
        wait_until("the start to be cancelled", || {
            bus.session.system_audio().owned_producer_count() == 0
        })
        .await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!system.mixing());
        assert_eq!(fake.live(), 0);
        assert!(events.try_recv().is_err());
    }
}
