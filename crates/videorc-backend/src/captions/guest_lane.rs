//! Guest captions (talk show): one captions-only provider stream for the
//! guests on stage, mixed into one mono source by the room renderer.
//!
//! The lane is a second, separate stream next to the host's (S15 addendum in
//! `docs/cloud/249-s15-contract.md`):
//!
//! - It runs only while Live captions is on, the show is live on this
//!   computer and the renderer reports at least one guest's audio on stage.
//!   The renderer renews a two-second source lease; without it, or once
//!   captions go off or are blocked, the lane stops within one tick.
//! - Guest audio has its own private channel. It never enters the host
//!   caption tap, so it can never reach Sidekick's listening, voice commands
//!   or voice markers, which all read that tap's provider task.
//! - Guest words only ever become `captions.update` lines. Nothing here
//!   reaches Sidekick, markers, clip words, the host transcript or a
//!   recording's caption records. `the_guest_lane_never_reaches_sidekick`
//!   pins this from this file's own source.
//! - Each socket rides its own metered lease from the same monthly caption
//!   allowance as the host's stream; a used-up allowance blocks captions
//!   exactly like a host block does, which stops both streams.
use super::*;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

/// Serializes source syncs, like the host's speech control.
static CONTROL: Mutex<()> = Mutex::const_new(());
/// The renderer renews the guest source every 250 ms.
const SOURCE_LEASE: Duration = Duration::from_secs(2);
/// About six seconds of 100 ms frames waits while a socket connects.
const LANE_CHANNEL_CAPACITY: usize = 64;
/// A talk show has at most this many people on stage.
const MAX_GUESTS: u32 = 16;
/// After a lane gives up (the streaming transport is unavailable), syncs
/// wait this long before starting it again, so a broken provider is never
/// retried several times a second.
const FAILED_LANE_COOLDOWN: Duration = Duration::from_secs(60);
/// The lane checks that it is still wanted this often.
const LANE_TICK: Duration = Duration::from_millis(100);
/// Utterance identities kept for late partial/final corrections.
const MAX_LANE_ITEMS: usize = 128;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuestSync {
    show_id: String,
    source_id: String,
    generation: u64,
    /// Guests on stage whose microphone audio is in the mix right now.
    guests: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuestPcm {
    source_id: String,
    sequence: u64,
    sample_rate: u32,
    samples: Vec<f32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestStatus {
    upload_allowed: bool,
    /// The lane's provider stream is up: what the guests say is captioned.
    captioning: bool,
    reason: &'static str,
}

/// The lane's place in the caption coordinator.
#[derive(Debug, Default)]
pub(super) struct GuestLane {
    source: Option<Arc<GuestSource>>,
    runtime: Option<LaneRuntime>,
    retry_after: Option<Instant>,
}

#[derive(Debug)]
pub(super) struct LaneRuntime {
    task: tokio::task::JoinHandle<()>,
    stop: Arc<AtomicBool>,
    sender: mpsc::Sender<AudioFrame>,
    session_client_id: String,
    source: Arc<GuestSource>,
    connected: Arc<AtomicBool>,
}

impl LaneRuntime {
    fn alive(&self) -> bool {
        !self.task.is_finished() && !self.stop.load(Ordering::Acquire)
    }
}

#[derive(Debug)]
struct GuestSource {
    show_id: String,
    source_id: String,
    generation: u64,
    origin: Instant,
    inner: std::sync::Mutex<Admission>,
}

#[derive(Debug)]
struct Admission {
    until: Instant,
    enabled: bool,
    sequence: u64,
    sample_budget: f64,
    budget_at: Instant,
    sample_rate: Option<u32>,
}

impl GuestSource {
    fn new(show_id: &str, source_id: &str, generation: u64) -> Self {
        let now = Instant::now();
        Self {
            show_id: show_id.to_string(),
            source_id: source_id.to_string(),
            generation,
            origin: now,
            inner: std::sync::Mutex::new(Admission {
                until: now,
                enabled: false,
                sequence: 0,
                sample_budget: 0.0,
                budget_at: now,
                sample_rate: None,
            }),
        }
    }

    fn leased(&self) -> bool {
        self.inner
            .lock()
            .is_ok_and(|a| a.enabled && a.until > Instant::now())
    }

    fn valid(&self, state: &AppState) -> bool {
        self.leased() && show_live(state, &self.show_id)
    }

    fn renew(&self) {
        if let Ok(mut a) = self.inner.lock() {
            a.enabled = true;
            a.until = Instant::now() + SOURCE_LEASE;
        }
    }

    fn revoke(&self) {
        if let Ok(mut a) = self.inner.lock() {
            a.enabled = false;
        }
    }
}

/// The facts that decide whether the guest stream runs. Pure, so every
/// "never pay for silence" rule is a unit test.
#[derive(Debug, Clone, Copy)]
struct LaneFacts {
    captions_on: bool,
    blocked: bool,
    privacy_fenced: bool,
    show_live: bool,
    guests: u32,
}

fn lane_reason(facts: LaneFacts) -> Option<&'static str> {
    if !facts.captions_on {
        Some("captions-off")
    } else if facts.blocked {
        Some("captions-blocked")
    } else if facts.privacy_fenced {
        Some("signing-out")
    } else if !facts.show_live {
        Some("show-not-live")
    } else if facts.guests == 0 {
        Some("no-guest-audio")
    } else {
        None
    }
}

fn lane_wanted(facts: LaneFacts) -> bool {
    lane_reason(facts).is_none()
}

/// Live captions are on and presentable: not blocked (a used-up allowance,
/// a lost microphone path) and not behind the sign-out privacy fence.
fn captions_presentable(c: &CaptionsCoordinator) -> bool {
    c.desired_enabled
        && !captions_blocked(c)
        && !c.privacy_teardown_in_progress
        && !c.privacy_teardown_failed
}

fn captions_blocked(c: &CaptionsCoordinator) -> bool {
    c.status
        .as_ref()
        .is_some_and(|status| status.state == CaptionsState::Blocked)
}

/// The show is on air from this computer: the room is ours (S15/S24) and the
/// managed show is live. A room open before or after air costs nothing.
fn show_live(state: &AppState, show_id: &str) -> bool {
    cloud_host::show_owned(state, show_id)
        && crate::cloud_show::lock(&state.cloud_show).status().phase
            == crate::cloud_show::CloudPhase::Live
}

/// Whether a room caption picture with this session id is a guest line the
/// lane may still present (`cloud.speech.overlay` and the S9 snapshot).
pub(super) fn presents(c: &CaptionsCoordinator, state: &AppState, session: &str) -> bool {
    captions_presentable(c)
        && c.guests.runtime.as_ref().is_some_and(|runtime| {
            runtime.alive() && runtime.session_client_id == session && runtime.source.valid(state)
        })
}

/// Source synchronization is not consent: only the existing Live captions
/// switch can start the guest stream. Zero guests, captions off or blocked,
/// or a show that is not live stops it and settles its lease at once.
pub async fn sync(state: &AppState, input: GuestSync) -> Result<GuestStatus> {
    anyhow::ensure!(
        cloud_host::valid_id(&input.show_id)
            && cloud_host::valid_id(&input.source_id)
            && input.generation > 0
            && input.generation <= 9_007_199_254_740_991
            && input.guests <= MAX_GUESTS,
        "Invalid guest speech source."
    );
    let _serial = CONTROL.lock().await;
    let live = show_live(state, &input.show_id);
    let (wanted, reason, source, replaced) = {
        let mut c = state.captions.lock().await;
        if let Some(source) = c.guests.source.as_ref() {
            anyhow::ensure!(
                input.generation >= source.generation
                    && (input.generation != source.generation
                        || input.source_id == source.source_id),
                "Stale guest speech generation."
            );
        }
        let facts = LaneFacts {
            captions_on: c.desired_enabled,
            blocked: captions_blocked(&c),
            privacy_fenced: c.privacy_teardown_in_progress || c.privacy_teardown_failed,
            show_live: live,
            guests: input.guests,
        };
        let changed = c.guests.source.as_ref().is_none_or(|source| {
            source.source_id != input.source_id || source.show_id != input.show_id
        });
        let mut replaced = None;
        if changed {
            if let Some(old) = c.guests.source.as_ref() {
                old.revoke();
            }
            replaced = c.guests.runtime.take();
            c.guests.source = Some(Arc::new(GuestSource::new(
                &input.show_id,
                &input.source_id,
                input.generation,
            )));
        }
        let source = c.guests.source.clone().expect("guest source installed");
        (lane_wanted(facts), lane_reason(facts), source, replaced)
    };
    finish_runtime(replaced).await;
    if !wanted {
        source.revoke();
        stop_runtime(state).await;
        return Ok(GuestStatus {
            upload_allowed: false,
            captioning: false,
            reason: reason.unwrap_or("captions-off"),
        });
    }
    source.renew();
    let mut c = state.captions.lock().await;
    let running = c
        .guests
        .runtime
        .as_ref()
        .is_some_and(|runtime| runtime.alive() && Arc::ptr_eq(&runtime.source, &source));
    if !running {
        if let Some(stale) = c.guests.runtime.take() {
            stale.stop.store(true, Ordering::Release);
            stale.task.abort();
        }
        if c.guests.retry_after.is_some_and(|at| at > Instant::now()) {
            return Ok(GuestStatus {
                upload_allowed: false,
                captioning: false,
                reason: "speech-service-unavailable",
            });
        }
        let Some(bearer) = crate::account::stored_session_token() else {
            return Ok(GuestStatus {
                upload_allowed: false,
                captioning: false,
                reason: "signed-out",
            });
        };
        let client = VideorcApiClient::new()?;
        let language = c.language.clone();
        c.guests.retry_after = None;
        c.guests.runtime = Some(spawn_lane(state, source.clone(), bearer, client, language));
    }
    let captioning = c
        .guests
        .runtime
        .as_ref()
        .is_some_and(|runtime| runtime.connected.load(Ordering::Acquire));
    Ok(GuestStatus {
        upload_allowed: true,
        captioning,
        reason: "guests-captions-only",
    })
}

fn spawn_lane(
    state: &AppState,
    source: Arc<GuestSource>,
    bearer: String,
    client: VideorcApiClient,
    language: Option<String>,
) -> LaneRuntime {
    let (sender, receiver) = mpsc::channel(LANE_CHANNEL_CAPACITY);
    let stop = Arc::new(AtomicBool::new(false));
    let connected = Arc::new(AtomicBool::new(false));
    let session_client_id = format!("guests-{}", uuid::Uuid::new_v4().simple());
    let task = tokio::spawn(run_lane(LaneSession {
        state: state.clone(),
        client,
        bearer,
        language,
        session_client_id: session_client_id.clone(),
        receiver,
        stop: stop.clone(),
        source: source.clone(),
        connected: connected.clone(),
    }));
    LaneRuntime {
        task,
        stop,
        sender,
        session_client_id,
        source,
        connected,
    }
}

/// One bounded frame of the guests' mix. It goes only to the lane's private
/// channel, never to the host caption tap.
pub async fn audio(state: &AppState, input: GuestPcm) -> Result<GuestStatus> {
    anyhow::ensure!(
        (16_000..=48_000).contains(&input.sample_rate)
            && !input.samples.is_empty()
            && input.samples.len() <= input.sample_rate as usize / 10
            && input
                .samples
                .iter()
                .all(|s| s.is_finite() && s.abs() <= 1.0),
        "Invalid bounded guest PCM."
    );
    let c = state.captions.lock().await;
    anyhow::ensure!(captions_presentable(&c), "Live captions are off.");
    let runtime = c
        .guests
        .runtime
        .as_ref()
        .filter(|runtime| {
            runtime.alive()
                && runtime.source.source_id == input.source_id
                && runtime.source.valid(state)
        })
        .ok_or_else(|| anyhow::anyhow!("Guest speech source expired."))?;
    {
        let mut a = runtime
            .source
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("Guest speech source unavailable."))?;
        anyhow::ensure!(
            input.sequence > a.sequence && a.sample_rate.is_none_or(|r| r == input.sample_rate),
            "Stale guest speech frame."
        );
        let now = Instant::now();
        let budget = (a.sample_budget
            + now.duration_since(a.budget_at).as_secs_f64() * f64::from(input.sample_rate))
        .min(f64::from(input.sample_rate) * 0.2);
        anyhow::ensure!(
            input.samples.len() as f64 <= budget,
            "Guest speech exceeded realtime budget."
        );
        a.sample_budget = budget - input.samples.len() as f64;
        a.budget_at = now;
        a.sequence = input.sequence;
        a.sample_rate = Some(input.sample_rate);
    }
    let frame = AudioFrame {
        timestamp_micros: runtime.source.origin.elapsed().as_micros() as u64,
        captured_at: Instant::now(),
        sample_rate: input.sample_rate,
        channels: 1,
        samples: input.samples,
    };
    // A full channel means the socket is behind: a late caption is worth
    // nothing, so the frame is dropped rather than queued.
    let _ = runtime.sender.try_send(frame);
    Ok(GuestStatus {
        upload_allowed: true,
        captioning: runtime.connected.load(Ordering::Acquire),
        reason: "guests-captions-only",
    })
}

/// Stop the guest stream and join it: its leases settle with the audio they
/// carried. Used by captions off, a caption block, a room loss and shutdown.
pub(super) async fn stop(state: &AppState) -> bool {
    let runtime = {
        let mut c = state.captions.lock().await;
        if let Some(source) = c.guests.source.as_ref() {
            source.revoke();
        }
        c.guests.runtime.take()
    };
    finish_runtime(runtime).await
}

/// A room loss (S24) stops the guests' stream of that show only.
pub(super) async fn stop_for_show(state: &AppState, show_id: &str) {
    let owned = state
        .captions
        .lock()
        .await
        .guests
        .source
        .as_ref()
        .is_some_and(|source| source.show_id == show_id);
    if owned {
        stop(state).await;
    }
}

async fn stop_runtime(state: &AppState) {
    let runtime = state.captions.lock().await.guests.runtime.take();
    finish_runtime(runtime).await;
}

/// Sign-out takes the lane under its privacy fence; the caller joins it with
/// `finish_runtime` before credentials are removed.
pub(super) fn take_for_sign_out(lane: &mut GuestLane) -> Option<LaneRuntime> {
    if let Some(source) = lane.source.take() {
        source.revoke();
    }
    lane.retry_after = None;
    lane.runtime.take()
}

/// Cancellation drops the private receiver and any in-flight socket at once;
/// dropping the task's leases settles them.
pub(super) async fn finish_runtime(runtime: Option<LaneRuntime>) -> bool {
    let Some(runtime) = runtime else {
        return true;
    };
    runtime.stop.store(true, Ordering::Release);
    runtime.connected.store(false, Ordering::Release);
    drop(runtime.sender);
    let mut task = runtime.task;
    task.abort();
    tokio::time::timeout(CAPTION_ABORT_JOIN_TIMEOUT, &mut task)
        .await
        .is_ok()
}

struct LaneSession {
    state: AppState,
    client: VideorcApiClient,
    bearer: String,
    language: Option<String>,
    session_client_id: String,
    receiver: mpsc::Receiver<AudioFrame>,
    stop: Arc<AtomicBool>,
    source: Arc<GuestSource>,
    connected: Arc<AtomicBool>,
}

#[derive(Debug)]
enum LaneEnd {
    /// Stopped: captions off, no guests, the room or the show changed.
    Ended,
    /// The caption route refused (allowance used up, Premium, sign-in):
    /// captions are blocked for both streams, as a host refusal blocks them.
    Terminal { code: String, message: String },
    /// The streaming transport is unavailable for now.
    Failed(String),
}

async fn lane_still_wanted(state: &AppState, source: &Arc<GuestSource>) -> bool {
    let c = state.captions.lock().await;
    captions_presentable(&c)
        && source.valid(state)
        && c.guests
            .source
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, source))
}

async fn run_lane(mut session: LaneSession) {
    let state = session.state.clone();
    let stop = session.stop.clone();
    let source = session.source.clone();
    let connected = session.connected.clone();
    let end = {
        let streaming = stream_guests(&mut session);
        tokio::pin!(streaming);
        let mut tick = tokio::time::interval(LANE_TICK);
        loop {
            tokio::select! {
                end = &mut streaming => break end,
                _ = tick.tick() => if !lane_still_wanted(&state, &source).await {
                    stop.store(true, Ordering::Release);
                    // Dropping the stream future settles its leases.
                    break LaneEnd::Ended;
                }
            }
        }
    };
    connected.store(false, Ordering::Release);
    match end {
        LaneEnd::Ended => {}
        LaneEnd::Terminal { code, message } => {
            tracing::warn!("Guest captions stopped ({code}): {message}");
            // Detached: `block_captions` stops (and joins) this lane.
            let state = state.clone();
            tokio::spawn(async move {
                block_captions(&state, &code, message).await;
            });
        }
        LaneEnd::Failed(reason) => {
            tracing::warn!("Guest captions paused: {reason}");
            state.emit_log(
                "warn",
                "Guest captions paused: the live caption service is not available right now."
                    .to_string(),
            );
            let mut c = state.captions.lock().await;
            if c.guests
                .runtime
                .as_ref()
                .is_some_and(|runtime| Arc::ptr_eq(&runtime.stop, &stop))
            {
                c.guests.retry_after = Some(Instant::now() + FAILED_LANE_COOLDOWN);
            }
        }
    }
}

/// The lane's own utterance numbering: one seq per provider item, monotonic
/// for the lane's whole life so the renderer orders its lines.
#[derive(Debug, Default)]
struct LaneItems {
    seqs: std::collections::HashMap<String, u64>,
    order: std::collections::VecDeque<String>,
    next: u64,
}

impl LaneItems {
    fn seq(&mut self, item_id: &str) -> u64 {
        if let Some(seq) = self.seqs.get(item_id) {
            return *seq;
        }
        self.next += 1;
        self.seqs.insert(item_id.to_string(), self.next);
        self.order.push_back(item_id.to_string());
        while self.order.len() > MAX_LANE_ITEMS {
            if let Some(old) = self.order.pop_front() {
                self.seqs.remove(&old);
            }
        }
        self.next
    }
}

/// The one thing a guest transcript may become: a caption line. Returns the
/// line it emitted, if captions still present.
async fn present_guest_event(
    state: &AppState,
    session_client_id: &str,
    stop: &AtomicBool,
    items: &mut LaneItems,
    event: RealtimeCaptionEvent,
) -> Option<CaptionsUpdate> {
    let (item_id, kind, text) = match event {
        RealtimeCaptionEvent::SpeechStarted { item_id, .. } => {
            items.seq(&item_id);
            return None;
        }
        RealtimeCaptionEvent::Partial {
            item_id,
            transcript,
        } => (item_id, CaptionUpdateKind::Partial, transcript),
        RealtimeCaptionEvent::Completed {
            item_id,
            transcript,
        } => (item_id, CaptionUpdateKind::Final, transcript),
        _ => return None,
    };
    if text.trim().is_empty() {
        return None;
    }
    let seq = items.seq(&item_id);
    let c = state.captions.lock().await;
    // Read under the coordinator lock `captions.stop` clears the bar under:
    // a guest line never lands after the boundary that took captions down.
    if stop.load(Ordering::Acquire) || !captions_presentable(&c) {
        return None;
    }
    let update = CaptionsUpdate {
        session_client_id: session_client_id.to_string(),
        seq,
        kind,
        text,
        chunk_seconds: 0,
        remaining_seconds: None,
    };
    state.emit_event("captions.update", update.clone());
    Some(update)
}

/// Streaming transcription of the guests' mix: the same gateway socket and
/// lease handover as the host's stream, with none of its listeners. There is
/// no chunked fallback: when streaming is unavailable the lane pauses.
async fn stream_guests(session: &mut LaneSession) -> LaneEnd {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::protocol::Message;

    // Dropped (and so settled) on return or when the lane is aborted.
    let mut leases = StreamingLeases {
        client: session.client.clone(),
        bearer: session.bearer.clone(),
        session_client_id: session.session_client_id.clone(),
        active: None,
        spare: None,
        pending: None,
    };
    let mut retry_budget = RealtimeRetryBudget::default();
    let mut items = LaneItems::default();
    let mut socket_index: u64 = 0;
    let mut ms_sent: f64 = 0.0;
    let mut backlog: std::collections::VecDeque<AudioFrame> = std::collections::VecDeque::new();

    // The loop label comes from the call site (macro hygiene).
    macro_rules! retry_or_fail {
        ($label:lifetime, $message:expr) => {{
            leases.settle_active();
            session.connected.store(false, Ordering::Release);
            let Some(wait) = retry_budget.retry_delay() else {
                return LaneEnd::Failed($message.to_string());
            };
            tokio::time::sleep(wait).await;
            continue $label;
        }};
    }

    'reconnect: loop {
        if session.stop.load(Ordering::Acquire) {
            return LaneEnd::Ended;
        }
        let minted = match leases.spare.take() {
            Some(token) => Ok(token),
            None => {
                session
                    .client
                    .mint_caption_realtime_token(
                        &session.bearer,
                        &session.session_client_id,
                        session.language.as_deref(),
                    )
                    .await
            }
        };
        let token = match minted {
            Ok(token) => token,
            Err(CaptionChunkFailure::Terminal { code, message }) => {
                return LaneEnd::Terminal { code, message };
            }
            Err(CaptionChunkFailure::Transient { message, .. }) => {
                retry_or_fail!('reconnect, message)
            }
        };
        if !token.speaks_streaming_transcription() {
            return LaneEnd::Failed(
                "the caption service offered no streaming transcription".into(),
            );
        }
        leases.settle_active();
        leases.active = ActiveStreamingLease::from_token(&token);
        let input_rate = token.input_rate();
        if !token.input_is_pcm() || !matches!(input_rate, 16_000 | 24_000) {
            return LaneEnd::Failed(format!(
                "streaming captions asked for audio other than 16 or 24 kHz PCM ({input_rate} Hz)"
            ));
        }
        let mut request = match token.url.as_str().into_client_request() {
            Ok(request) => request,
            Err(error) => return LaneEnd::Failed(format!("bad streaming caption url: {error}")),
        };
        match GatewayStreamingCaptionTransport::subprotocols(&token).parse() {
            Ok(value) => {
                request
                    .headers_mut()
                    .insert("Sec-WebSocket-Protocol", value);
            }
            Err(_) => return LaneEnd::Failed("bad streaming caption token".into()),
        }
        let (mut ws, _) = match tokio_tungstenite::connect_async(request).await {
            Ok(connected) => connected,
            Err(error) => {
                retry_or_fail!('reconnect, format!("streaming caption connect failed: {error}"))
            }
        };
        socket_index += 1;
        let start = GatewayStreamingCaptionTransport::start_frame(
            input_rate,
            token.provider_options.as_ref(),
        );
        if ws
            .send(Message::Text(start.to_string().into()))
            .await
            .is_err()
        {
            retry_or_fail!('reconnect, "streaming caption socket closed while starting");
        }
        let connected_at = tokio::time::Instant::now();
        let socket_audio_base_ms = ms_sent;
        let mut decoder = StreamingCaptionDecoder::new(socket_index);
        let mut provider_ready = false;
        let mut handover_at = connected_at + streaming_handover_after(token.lease_seconds);
        let handover_wait_until = handover_at + Duration::from_secs(20);
        let premint_at = handover_at
            .checked_sub(STREAMING_HANDOVER_PREMINT)
            .unwrap_or(connected_at)
            .max(connected_at);
        let mut premint_started = false;
        let mut watchdog = tokio::time::interval(Duration::from_millis(250));
        watchdog.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        watchdog.reset();

        loop {
            if session.stop.load(Ordering::Acquire) {
                let done = GatewayStreamingCaptionTransport::audio_done_frame();
                let _ = ws.send(Message::Text(done.to_string().into())).await;
                let _ = ws.send(Message::Close(None)).await;
                return LaneEnd::Ended;
            }
            tokio::select! {
                frame = next_streaming_caption_frame(&mut backlog, &mut session.receiver) => {
                    let Some(frame) = frame else {
                        // The lane's channel closed: it was stopped.
                        let _ = ws.send(Message::Close(None)).await;
                        return LaneEnd::Ended;
                    };
                    let mono = downmix_resample_to_16k_mono(&frame.samples, frame.channels, frame.sample_rate);
                    if mono.is_empty() {
                        continue;
                    }
                    let frame_ms = mono.len() as f64 * 1000.0 / f64::from(CAPTION_SAMPLE_RATE);
                    ms_sent += frame_ms;
                    if let Some(lease) = leases.active.as_mut() {
                        lease.audio_ms += frame_ms;
                    }
                    let wire = if input_rate == 24_000 {
                        pcm_s16le_bytes(&downmix_resample_to_24k_mono(&frame.samples, frame.channels, frame.sample_rate))
                    } else {
                        pcm_s16le_bytes(&mono)
                    };
                    let mut send_failed = false;
                    for audio in wire.chunks(STREAMING_AUDIO_FRAME_MAX_BYTES) {
                        if session.stop.load(Ordering::Acquire) {
                            return LaneEnd::Ended;
                        }
                        if ws.send(Message::Binary(audio.to_vec().into())).await.is_err() {
                            send_failed = true;
                            break;
                        }
                    }
                    if send_failed {
                        retry_or_fail!('reconnect, "streaming caption socket dropped");
                    }
                }
                message = ws.next() => {
                    let message = match message {
                        Some(Ok(message)) => message,
                        Some(Err(error)) => retry_or_fail!('reconnect, format!("streaming caption socket error: {error}")),
                        None => retry_or_fail!('reconnect, "streaming caption socket closed"),
                    };
                    if let Message::Close(frame) = message {
                        let failure = frame
                            .map(|frame| classify_realtime_close(u16::from(frame.code), &frame.reason))
                            .unwrap_or_else(|| classify_realtime_close(1006, "socket ended without a close frame"));
                        if failure.kind == RealtimeFailureKind::Fallback {
                            leases.settle_active();
                            return LaneEnd::Failed(failure.message);
                        }
                        retry_or_fail!('reconnect, failure.message);
                    }
                    let Message::Text(text) = message else { continue };
                    let Ok(part) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                    for event in decoder.decode(&part, ms_sent - socket_audio_base_ms) {
                        match &event {
                            RealtimeCaptionEvent::ConfigurationAcknowledged => {
                                provider_ready = true;
                                session.connected.store(true, Ordering::Release);
                                retry_budget.observe(RealtimeHealthEvidence::ConfigurationAcknowledged);
                            }
                            RealtimeCaptionEvent::SpeechStarted { .. } => {
                                provider_ready = true;
                                session.connected.store(true, Ordering::Release);
                                retry_budget.observe(RealtimeHealthEvidence::SpeechStarted);
                            }
                            RealtimeCaptionEvent::Partial { .. } | RealtimeCaptionEvent::Completed { .. } => {
                                provider_ready = true;
                                session.connected.store(true, Ordering::Release);
                                retry_budget.observe(RealtimeHealthEvidence::Transcript);
                            }
                            RealtimeCaptionEvent::Finished { duration_seconds } => {
                                if let Some(lease) = leases.active.as_mut() {
                                    lease.provider_seconds = *duration_seconds;
                                }
                            }
                            RealtimeCaptionEvent::Error(failure) => {
                                let _ = ws.send(Message::Close(None)).await;
                                if failure.kind == RealtimeFailureKind::Retryable {
                                    retry_or_fail!('reconnect, failure.message.clone());
                                }
                                leases.settle_active();
                                return LaneEnd::Failed(failure.message.clone());
                            }
                            RealtimeCaptionEvent::AssistantResponse => {
                                let _ = ws.send(Message::Close(None)).await;
                                leases.settle_active();
                                return LaneEnd::Failed("the caption provider answered instead of transcribing".into());
                            }
                            RealtimeCaptionEvent::Ignored => {}
                        }
                        present_guest_event(&session.state, &session.session_client_id, &session.stop, &mut items, event).await;
                    }
                }
                _ = tokio::time::sleep_until(premint_at), if !premint_started => {
                    premint_started = true;
                    leases.retire_pending();
                    let client = session.client.clone();
                    let bearer = session.bearer.clone();
                    let session_client_id = session.session_client_id.clone();
                    let language = session.language.clone();
                    leases.pending = Some(tokio::spawn(async move {
                        client
                            .mint_caption_realtime_token(&bearer, &session_client_id, language.as_deref())
                            .await
                    }));
                }
                _ = tokio::time::sleep_until(handover_at) => {
                    if leases.pending.as_ref().is_some_and(|pending| !pending.is_finished())
                        && tokio::time::Instant::now() < handover_wait_until
                    {
                        handover_at = tokio::time::Instant::now() + Duration::from_millis(250);
                        continue;
                    }
                    if leases.pending.as_ref().is_some_and(|pending| pending.is_finished()) {
                        if let Some(pending) = leases.pending.take()
                            && let Ok(Ok(next)) = pending.await
                        {
                            leases.spare = Some(next);
                        }
                    } else {
                        leases.retire_pending();
                    }
                    let grace_until = tokio::time::Instant::now() + CAPTION_FINAL_TRANSCRIPT_GRACE;
                    let drained = finish_streaming_socket(&mut ws, grace_until, &mut session.receiver, &mut backlog).await;
                    for part in drained {
                        for event in decoder.decode(&part, ms_sent - socket_audio_base_ms) {
                            if let RealtimeCaptionEvent::Finished { duration_seconds } = &event {
                                if let Some(lease) = leases.active.as_mut() {
                                    lease.provider_seconds = *duration_seconds;
                                }
                                continue;
                            }
                            present_guest_event(&session.state, &session.session_client_id, &session.stop, &mut items, event).await;
                        }
                    }
                    leases.settle_active();
                    continue 'reconnect;
                }
                _ = watchdog.tick() => {
                    if !provider_ready && connected_at.elapsed() >= REALTIME_CONFIG_ACK_TIMEOUT {
                        let _ = ws.send(Message::Close(None)).await;
                        leases.settle_active();
                        return LaneEnd::Failed("the streaming caption provider did not start".into());
                    }
                    if provider_ready && connected_at.elapsed() >= REALTIME_RECONNECT_HEALTHY_INTERVAL {
                        retry_budget.observe(RealtimeHealthEvidence::StableInterval);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> LaneFacts {
        LaneFacts {
            captions_on: true,
            blocked: false,
            privacy_fenced: false,
            show_live: true,
            guests: 1,
        }
    }

    #[test]
    fn the_guest_stream_runs_only_while_it_has_something_to_caption() {
        assert!(lane_wanted(facts()));
        // One extra stream for any number of guests: the count only gates.
        assert!(lane_wanted(LaneFacts {
            guests: 5,
            ..facts()
        }));
        for (off, reason) in [
            (
                LaneFacts {
                    captions_on: false,
                    ..facts()
                },
                "captions-off",
            ),
            (
                LaneFacts {
                    blocked: true,
                    ..facts()
                },
                "captions-blocked",
            ),
            (
                LaneFacts {
                    privacy_fenced: true,
                    ..facts()
                },
                "signing-out",
            ),
            (
                LaneFacts {
                    show_live: false,
                    ..facts()
                },
                "show-not-live",
            ),
            (
                LaneFacts {
                    guests: 0,
                    ..facts()
                },
                "no-guest-audio",
            ),
        ] {
            assert!(!lane_wanted(off), "{reason}");
            assert_eq!(lane_reason(off), Some(reason));
        }
    }

    #[test]
    fn guest_sources_refuse_unknown_fields() {
        // No speaker identity, no command, no host flag rides the guest wire.
        for extra in ["guestId", "command", "host", "listen"] {
            let mut value =
                serde_json::json!({"showId":"s","sourceId":"g","generation":1,"guests":1});
            value[extra] = serde_json::json!("x");
            assert!(
                serde_json::from_value::<GuestSync>(value).is_err(),
                "{extra}"
            );
        }
        assert!(
            serde_json::from_value::<GuestSync>(
                serde_json::json!({"showId":"s","sourceId":"g","generation":1,"guests":1})
            )
            .is_ok()
        );
    }

    fn test_state() -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(64);
        AppState::new(
            "test-token".to_string(),
            0,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        )
    }

    #[test]
    fn lane_items_keep_one_seq_per_utterance_in_spoken_order() {
        let mut items = LaneItems::default();
        assert_eq!(items.seq("a"), 1);
        assert_eq!(items.seq("b"), 2);
        assert_eq!(items.seq("a"), 1);
        for index in 0..MAX_LANE_ITEMS {
            items.seq(&format!("x{index}"));
        }
        // A pruned identity never reuses an older seq.
        assert!(items.seq("a") > 2);
    }

    /// S15/S19 boundary: a guest saying a Sidekick command or a marker
    /// phrase becomes one caption line and nothing else, even while Sidekick
    /// listens, voice markers are on and Sidekick speech is admitted.
    #[tokio::test]
    async fn a_guest_command_is_only_ever_a_caption_line() {
        let _lock = caption_lifecycle_test_lock().lock().await;
        let state = test_state();
        let mut events = state.events.subscribe();
        {
            let mut c = state.captions.lock().await;
            c.desired_enabled = true;
            c.listen_wanted = true;
            c.speech_admitted = true;
            c.speech_started_at = Some(std::time::Instant::now() - Duration::from_secs(5));
            c.listen_started_at = Some(std::time::Instant::now() - Duration::from_secs(5));
            c.marker_session_id = Some("show-1".into());
            c.marker_started_at = Some(std::time::Instant::now() - Duration::from_secs(5));
            c.room_chunks = true;
        }
        let stop = AtomicBool::new(false);
        let mut items = LaneItems::default();
        for transcript in [
            "Sidekick, mark that moment",
            "Hey Sidekick, end the show",
            "clip that",
        ] {
            let line = present_guest_event(
                &state,
                "guests-test",
                &stop,
                &mut items,
                RealtimeCaptionEvent::Completed {
                    item_id: transcript.into(),
                    transcript: transcript.into(),
                },
            )
            .await
            .expect("a guest final is a caption line");
            assert_eq!(line.session_client_id, "guests-test");
            assert_eq!(line.text, transcript);
        }
        let mut names = Vec::new();
        while let Ok(event) = events.try_recv() {
            names.push(event.event.clone());
        }
        assert_eq!(names, vec!["captions.update"; 3], "{names:?}");
        let c = state.captions.lock().await;
        // Nothing reached the recording's caption records or a listener.
        assert!(c.chunks.is_empty());
        assert!(c.marker_listening.is_none());
        drop(c);
        assert!(state.database.host_transcript("show-1").unwrap().is_empty());
    }

    #[tokio::test]
    async fn guest_lines_stop_with_the_caption_boundary() {
        let _lock = caption_lifecycle_test_lock().lock().await;
        let state = test_state();
        let stop = AtomicBool::new(false);
        let mut items = LaneItems::default();
        let event = || RealtimeCaptionEvent::Partial {
            item_id: "a".into(),
            transcript: "hello".into(),
        };
        // Captions off: nothing lands.
        assert!(
            present_guest_event(&state, "g", &stop, &mut items, event())
                .await
                .is_none()
        );
        state.captions.lock().await.desired_enabled = true;
        assert!(
            present_guest_event(&state, "g", &stop, &mut items, event())
                .await
                .is_some()
        );
        // A block (a used-up allowance) stops guest lines like host lines.
        {
            let mut c = state.captions.lock().await;
            let mut status = CaptionsStatus::ready();
            status.state = CaptionsState::Blocked;
            c.status = Some(status);
        }
        assert!(
            present_guest_event(&state, "g", &stop, &mut items, event())
                .await
                .is_none()
        );
        state.captions.lock().await.status = Some(CaptionsStatus::ready());
        stop.store(true, Ordering::Release);
        assert!(
            present_guest_event(&state, "g", &stop, &mut items, event())
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn guest_audio_never_enters_the_host_caption_tap() {
        let _lock = caption_lifecycle_test_lock().lock().await;
        let state = test_state();
        let (sender, mut receiver) = mpsc::channel(4);
        let source = Arc::new(GuestSource::new("show-1", "mix", 1));
        source.renew();
        {
            let mut c = state.captions.lock().await;
            c.desired_enabled = true;
            c.guests.runtime = Some(LaneRuntime {
                task: tokio::spawn(std::future::pending::<()>()),
                stop: Arc::new(AtomicBool::new(false)),
                sender,
                session_client_id: "guests-test".into(),
                source: source.clone(),
                connected: Arc::new(AtomicBool::new(true)),
            });
        }
        let host_frames = TAP_FRAMES_SEEN.load(Ordering::Acquire);
        let pcm = |sequence| GuestPcm {
            source_id: "mix".into(),
            sequence,
            sample_rate: 48_000,
            samples: vec![0.1; 4_800],
        };
        // No live show owned here: the source is not valid, so the frame is
        // refused before it reaches any channel.
        assert!(audio(&state, pcm(1)).await.is_err());
        assert!(receiver.try_recv().is_err());
        assert_eq!(TAP_FRAMES_SEEN.load(Ordering::Acquire), host_frames);
        // And a stopped lane refuses every frame too.
        let runtime = state.captions.lock().await.guests.runtime.take();
        assert!(finish_runtime(runtime).await);
        assert!(audio(&state, pcm(2)).await.is_err());
        assert_eq!(TAP_FRAMES_SEEN.load(Ordering::Acquire), host_frames);
    }

    /// The boundary in source form: this lane's code never names a Sidekick,
    /// marker, clip, host-transcript or host-tap entry point. A later change
    /// that wires guest words into one of them fails here first.
    #[test]
    fn the_guest_lane_never_reaches_sidekick() {
        let source = include_str!("guest_lane.rs");
        let code = &source[..source.find("#[cfg(test)]").expect("test module")];
        for forbidden in [
            "cohost",
            "marker_voice",
            "clip_marks",
            "note_room_clip",
            "note_chunk_marker",
            "note_transcript_final",
            "publish_marker_outcome",
            "save_host_transcript",
            "listen_wanted",
            "listen_epoch",
            "speech_admitted",
            "marker_started_at",
            "admitted_buddy_audio",
            "offer_caption_frame",
            "install_tap",
            "TAP.",
            "CaptionSession",
            "handle_realtime_event",
            ".chunks",
            "CaptionChunkPurpose::Listen",
        ] {
            assert!(
                !code.contains(forbidden),
                "the guest lane must stay captions-only; it names `{forbidden}`"
            );
        }
    }
}
