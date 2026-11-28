//! Plan 260 S1.8a: the backend joins the talk show's room as the host
//! (`host:<showId>`, D9), with no media yet. Behind a dev switch
//! (`VIDEORC_BACKEND_ROOM=1`, debug builds only); without it the renderer
//! holds the host connection as before and nothing here runs.
//!
//! With the switch on, the backend follows `cloud.state`: while the room is
//! open it holds the seat with its own token (`room_token`, which then never
//! reaches the renderer: `cloud.room.token.refresh` refuses with
//! `cloud-room-held-by-backend`), and reports its own client state through
//! `report_client`, the renderer's reports being ignored. The rules are the
//! renderer's (`lib/talk-show-room.ts`): LiveKit's own reconnect, then a
//! fresh token and a rejoin after 1, 2, 4, 8 and 15 s; a deleted room or a
//! removal ends it; a duplicate identity is another device taking the seat
//! (`TAKEN_OVER_DETAIL` after 3 s). S1.8b moves the data topics (the stage
//! first, `stage_message`: on every join and every change, as the renderer
//! sent it; then the managed show's overlays, `room_overlays`, straight from
//! the `cloud.room.overlay` hand-off), S1.8c the host's media, S1.8d the subscriptions (the plan's S1.8
//! cut).
//!
//! On the platforms `build.rs` marks `backend_room`: macOS, Linux, and Windows
//! builds with the `windows-room` feature (the SDK is a dependency of the same
//! list; Windows compiles and links, runtime proof is owed, issue #2464). Off macOS the room's media
//! comes from the paths the backend already has: the compositor's camera role
//! and the preview's screen frames (CPU bytes), the room microphone tap, and
//! `sound_monitor::DeviceOutput` for the guests (PipeWire on Linux). Two
//! parts stay macOS only: the room's own second screen capture (c4b,
//! `preview_screen::RoomScreenCapture`) and the aux track's own-app-excluded
//! system audio (`room_system_audio::open`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

// The room's reason (LiveKit's protocol enum), not the participant's.
use livekit::DisconnectReason;
use livekit::prelude::{DataPacket, Room, RoomEvent, RoomOptions};
use serde_json::Value;
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use crate::cloud_talk::{CloudRoomClientState, RoomClientReportParams, TAKEN_OVER_DETAIL};
use crate::state::AppState;

/// The dev switch.
pub(crate) const SWITCH_ENV: &str = "VIDEORC_BACKEND_ROOM";
/// Plan 260 (L1): who hosts the room, as the client that launched this
/// backend says. The GPUI app has no renderer room, so it launches the
/// backend with `backend` and the backend holds the seat in any build.
/// Electron never sets it: its renderer keeps the room until S1.8e.
pub(crate) const CLIENT_ROOM_ENV: &str = "VIDEORC_ROOM_HOST";
/// [`CLIENT_ROOM_ENV`]'s value for a client with no room of its own.
pub(crate) const CLIENT_ROOM_BACKEND: &str = "backend";

/// The data topic the guest page listens on for the stage (`guest-wire.ts`,
/// the renderer's `STAGE_TOPIC`).
pub(crate) const STAGE_TOPIC: &str = "videorc.stage";
/// At most two screens on the stage (plan 251, `STAGE_MAX_SCREENS`).
const STAGE_MAX_SCREENS: usize = 2;

/// The runner's return and LiveKit's recorder (the program page): neither
/// is a guest, and neither needs the stage (`talk-show-room-audio.ts`).
const RUNNER_IDENTITY_PREFIX: &str = "runner:";
const RECORDER_IDENTITY_PREFIX: &str = "EG_";

/// Whether a participant who joined is a guest page that needs the stage.
fn needs_stage(identity: &str) -> bool {
    !identity.starts_with(RUNNER_IDENTITY_PREFIX) && !identity.starts_with(RECORDER_IDENTITY_PREFIX)
}

/// The rejoin backoff, as the renderer's (seconds).
const REJOIN_BACKOFF_S: [u64; 5] = [1, 2, 4, 8, 15];
/// How long a duplicate identity waits for `onAir` to name another device
/// before it stops waiting (`TAKEN_OVER_GRACE_MS` in `talk-show-room.ts`).
const TAKE_OVER_WAIT: Duration = Duration::from_secs(3);
/// How often a duplicate identity checks whether `onAir` already moved to
/// another device (`TAKEN_OVER_POLL_MS` in `talk-show-room.ts`).
const TAKE_OVER_POLL: Duration = Duration::from_millis(100);

/// Whether the backend holds (or is getting) the host seat.
static HOLDS_SEAT: AtomicBool = AtomicBool::new(false);

/// The switch: debug builds with `VIDEORC_BACKEND_ROOM=1`, or a client
/// that holds no room itself (`VIDEORC_ROOM_HOST=backend`, the GPUI app), in
/// any build.
pub(crate) fn enabled() -> bool {
    switched_on(
        cfg!(debug_assertions),
        std::env::var(SWITCH_ENV).ok().as_deref(),
        std::env::var(CLIENT_ROOM_ENV).ok().as_deref(),
    )
}

/// [`enabled`]'s rule, from its inputs.
fn switched_on(debug: bool, dev_switch: Option<&str>, client_room: Option<&str>) -> bool {
    (debug && dev_switch == Some("1")) || client_room == Some(CLIENT_ROOM_BACKEND)
}

/// Whether the backend holds the host seat, so the renderer must stay out.
pub(crate) fn holds_seat() -> bool {
    HOLDS_SEAT.load(Ordering::Acquire)
}

/// Starts following `cloud.state` when the switch is on.
pub(crate) fn start(state: AppState) {
    if !enabled() {
        return;
    }
    tracing::info!(
        "the backend holds the talk show's host seat ({SWITCH_ENV}=1 in a debug build, or \
         {CLIENT_ROOM_ENV}={CLIENT_ROOM_BACKEND} from a client with no room of its own)"
    );
    // Plan 260 S1.8 (L1): the avatar content a client asks the backend to
    // build (`cloud.room.avatar.set { build: true }`).
    tokio::spawn(crate::room_avatar_build::run(state.clone()));
    tokio::spawn(follow(state));
}

/// The stage message for the guest page (`stageMessage` in
/// `talk-show-room.ts`), from a `cloud.state` payload's `room.stage`: who is
/// on stage, the screen (and with two screens up, `screens` names both), and
/// `captions` while the on-stage guests are captioned. None without a stage.
pub(crate) fn stage_message(payload: &Value, captions: bool) -> Option<Vec<u8>> {
    let stage = payload.get("room")?.get("stage")?;
    let on_stage: Vec<String> = stage
        .get("onStage")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    // `stageScreens`: two named screens win, else the one `screen`.
    let mut screens: Vec<String> = Vec::new();
    for identity in stage
        .get("screens")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if !identity.is_empty() && !screens.iter().any(|named| named == identity) {
            screens.push(identity.to_string());
        }
    }
    if screens.len() < STAGE_MAX_SCREENS
        && let Some(screen) = stage.get("screen").and_then(Value::as_str)
    {
        screens = vec![screen.to_string()];
    }
    let named: Vec<String> = screens
        .into_iter()
        .filter(|identity| on_stage.contains(identity))
        .take(STAGE_MAX_SCREENS)
        .collect();
    let mut message = serde_json::json!({
        "v": 1,
        "onStage": on_stage,
        "screen": named.first(),
    });
    if named.len() == STAGE_MAX_SCREENS {
        message["screens"] = serde_json::json!(named);
    }
    if captions {
        message["captions"] = Value::Bool(true);
    }
    serde_json::to_vec(&message).ok()
}

/// Whether a `cloud.state` payload has the room open.
fn room_open(payload: &serde_json::Value) -> bool {
    payload
        .get("room")
        .and_then(|room| room.get("phase"))
        .and_then(serde_json::Value::as_str)
        == Some("open")
}

async fn follow(state: AppState) {
    let mut events = state.events.subscribe();
    let mut holding: Option<oneshot::Sender<()>> = None;
    // The overlay hand-offs, for the hold that has the seat.
    let mut overlays: Option<mpsc::UnboundedSender<Value>> = None;
    // The latest stage message, for the hold to publish on join and change.
    let (stage, _) = watch::channel::<Option<Vec<u8>>>(None);
    // A hold that ended by itself (a take-over, a deleted room) is not
    // retried until the room closes once: the seat is someone else's.
    let mut ended_while_open = false;
    // The last `cloud.state`, so a change in the guest captions re-sends the
    // stage with it (S1.8d d4).
    let mut last_state: Option<Value> = None;
    loop {
        let event = tokio::select! {
            received = events.recv() => match received {
                Ok(event) => event,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = crate::room_guest_speech::CAPTIONING_CHANGED.notified() => {
                if let Some(payload) = last_state.as_ref() {
                    let message =
                        stage_message(payload, crate::room_guest_speech::captioning());
                    stage.send_if_modified(|current| {
                        let changed = *current != message;
                        *current = message;
                        changed
                    });
                }
                continue;
            }
        };
        if event.event == crate::cloud_talk::CLOUD_ROOM_OVERLAY_EVENT {
            if let Some(overlays) = overlays.as_ref() {
                let _ = overlays.send(event.payload);
            }
            continue;
        }
        if event.event != "cloud.state" {
            continue;
        }
        let open = room_open(&event.payload);
        // The guest page's "Live captions are on" line: the backend's own
        // guest captions mix (S1.8d d4).
        last_state = Some(event.payload.clone());
        let message = stage_message(&event.payload, crate::room_guest_speech::captioning());
        stage.send_if_modified(|current| {
            let changed = *current != message;
            *current = message;
            changed
        });
        if holding.as_ref().is_some_and(oneshot::Sender::is_closed) {
            holding = None;
            ended_while_open = open;
        }
        if !open {
            ended_while_open = false;
        }
        match (open, holding.is_some()) {
            (true, false) if !ended_while_open => {
                let (stop, stopped) = oneshot::channel();
                let (overlay_sender, overlay_receiver) = mpsc::unbounded_channel();
                HOLDS_SEAT.store(true, Ordering::Release);
                tokio::spawn(hold(
                    state.clone(),
                    stopped,
                    stage.subscribe(),
                    overlay_receiver,
                ));
                holding = Some(stop);
                overlays = Some(overlay_sender);
            }
            (false, true) => {
                if let Some(stop) = holding.take() {
                    let _ = stop.send(());
                }
                overlays = None;
            }
            _ => {}
        }
    }
}

fn live_elsewhere(state: &AppState) -> bool {
    crate::cloud_show::lock(&state.cloud_show).live_elsewhere()
}

/// Plan 243 C5 (`#duplicateHost` in `talk-show-room.ts`): after
/// `DuplicateIdentity`, return immediately once `onAir` already names another
/// device (so `reclaim_host`'s 5 s timer cannot beat the disconnect report), or
/// poll up to `max_wait` if the state poll has not landed yet. Returns `None`
/// if `stop` fired while waiting.
async fn wait_for_takeover_detail<F>(
    stop: &mut oneshot::Receiver<()>,
    max_wait: Duration,
    poll: Duration,
    mut is_elsewhere: F,
) -> Option<Option<&'static str>>
where
    F: FnMut() -> bool,
{
    let mut waited = Duration::ZERO;
    while !is_elsewhere() && waited < max_wait {
        let step = poll.min(max_wait.saturating_sub(waited));
        if step.is_zero() {
            break;
        }
        tokio::select! {
            _ = &mut *stop => return None,
            _ = tokio::time::sleep(step) => {}
        }
        waited += step;
    }
    Some(is_elsewhere().then_some(TAKEN_OVER_DETAIL))
}

fn report(state: &AppState, client: CloudRoomClientState, detail: Option<&str>) {
    if let Some(context) = crate::cloud_context(state) {
        context.report_client(RoomClientReportParams {
            state: client,
            detail: detail.map(str::to_string),
        });
    }
}

fn room_options() -> RoomOptions {
    let mut options = RoomOptions::default();
    // Guest by guest, never the program page (S0.8); dynacast as the
    // renderer's room.
    options.auto_subscribe = false;
    options.adaptive_stream = false;
    options.dynacast = true;
    options
}

/// Holds the seat until `stop` fires or the room ends it.
async fn hold(
    state: AppState,
    mut stop: oneshot::Receiver<()>,
    mut stage: watch::Receiver<Option<Vec<u8>>>,
    mut overlays: mpsc::UnboundedReceiver<Value>,
) {
    let mut attempt = 0usize;
    loop {
        report(&state, CloudRoomClientState::Connecting, None);
        let token = match crate::cloud_context(&state) {
            Some(context) => context
                .room_token(crate::account::stored_session_token())
                .await
                .map_err(|error| format!("{error:#}")),
            None => Err("Videorc Cloud is unavailable".to_string()),
        };
        let show_id = token.as_ref().map(|token| token.show_id.clone()).ok();
        let connected = match token {
            Ok(token) => {
                tokio::select! {
                    _ = &mut stop => return leave(&state, None).await,
                    connected = Room::connect(&token.url, &token.host_token, room_options()) => {
                        connected.map_err(|error| error.to_string())
                    }
                }
            }
            Err(error) => Err(error),
        };
        match connected {
            Err(error) => {
                tracing::warn!("The backend could not join the talk show's room: {error}");
                report(&state, CloudRoomClientState::Disconnected, None);
            }
            Ok((room, mut events)) => {
                let room = Arc::new(room);
                // Subscriptions start closed, before any publisher starts:
                // LiveKit allows everyone until told otherwise, and the
                // routing task grants only what the receipts allow (c4c).
                if let Err(error) = room
                    .local_participant()
                    .set_track_subscription_permissions(false, Vec::new())
                    .await
                {
                    tracing::warn!("The room's subscriptions could not be closed: {error}");
                }
                attempt = 0;
                report(&state, CloudRoomClientState::Connected, None);
                // Data messages are not replayed: the stage goes out on every
                // join, then on every change.
                let message = stage.borrow_and_update().clone();
                publish_stage(&room, message).await;
                // One sender per connection, so overlays go out in order (a
                // set never overtakes the clear after it); it ends with the
                // connection, and the backend hands the untimed ones over again
                // on the next.
                // Plan 249 S3: what each program page and guest draws, from
                // their server-relayed receipts; the presentation publishers
                // read it (S1.8b, next parts).
                let receipts = Arc::new(StdMutex::new(
                    crate::room_capability::CapabilityReceipts::default(),
                ));
                // The static graphics (S1.8b): one publisher per connection.
                let (graphics_signals, graphics_heard) = mpsc::unbounded_channel();
                let graphics_task = tokio::spawn(crate::room_graphics::run(
                    state.clone(),
                    room.clone(),
                    show_id.clone().unwrap_or_default(),
                    receipts.clone(),
                    graphics_heard,
                ));
                // The committed scene (S1.8b): the same receipts.
                let (scene_signals, scene_heard) = mpsc::unbounded_channel();
                let scene_task = tokio::spawn(crate::room_scene::run(
                    state.clone(),
                    room.clone(),
                    show_id.clone().unwrap_or_default(),
                    receipts.clone(),
                    scene_heard,
                ));
                // The avatar and its bubble (S1.8b): the same receipts.
                let (avatar_signals, avatar_heard) = mpsc::unbounded_channel();
                let avatar_task = tokio::spawn(crate::room_avatar::run(
                    state.clone(),
                    room.clone(),
                    show_id.clone().unwrap_or_default(),
                    receipts.clone(),
                    avatar_heard,
                ));
                // The host's microphone (S1.8c): it closes its device itself
                // when `microphone_done` drops with this connection.
                let (microphone_done, microphone_heard) = oneshot::channel::<()>();
                tokio::spawn(crate::room_media::run_microphone(
                    state.clone(),
                    room.clone(),
                    show_id.clone().unwrap_or_default(),
                    microphone_heard,
                ));
                // The host's camera (S1.8c): taken off when `camera_done`
                // drops with this connection.
                let (camera_done, camera_heard) = oneshot::channel::<()>();
                tokio::spawn(crate::room_media::run_camera(
                    state.clone(),
                    room.clone(),
                    show_id.clone().unwrap_or_default(),
                    camera_heard,
                ));
                // Who may take the host's tracks, and the audio routing
                // (S1.8c c4c): told when a receipt, a participant or a
                // local track changes.
                let (subscriptions_changed, subscriptions_heard) = mpsc::unbounded_channel();
                let (subscriptions_done, subscriptions_stopped) = oneshot::channel::<()>();
                tokio::spawn(crate::room_routing::run(
                    state.clone(),
                    room.clone(),
                    receipts.clone(),
                    subscriptions_heard,
                    subscriptions_stopped,
                ));
                // The guests heard here, with echo cancellation (S1.8d d3).
                let (playout_done, playout_stopped) = oneshot::channel::<()>();
                tokio::spawn(crate::room_playout::run(
                    state.clone(),
                    room.clone(),
                    playout_stopped,
                ));
                // The guest captions mix, in-process (S1.8d d4).
                let (guest_speech_done, guest_speech_stopped) = oneshot::channel::<()>();
                tokio::spawn(crate::room_guest_speech::run(
                    state.clone(),
                    room.clone(),
                    show_id.clone().unwrap_or_default(),
                    guest_speech_stopped,
                ));
                // The room's other people as preview feeds (S1.8d d1).
                let (remote_done, remote_stopped) = oneshot::channel::<()>();
                tokio::spawn(crate::room_remote::run(
                    state.clone(),
                    room.clone(),
                    show_id.clone().unwrap_or_default(),
                    remote_stopped,
                ));
                // The HTML layers' sheets (S1.8c c5), for egress pages that
                // ask for them.
                let (html_done, html_stopped) = oneshot::channel::<()>();
                tokio::spawn(crate::room_html::run(
                    state.clone(),
                    room.clone(),
                    show_id.clone().unwrap_or_default(),
                    receipts.clone(),
                    html_stopped,
                ));
                // The auxiliary track (S1.8c c4d): room sounds and system
                // audio, for current media v2 consumers.
                // The room's latency on a managed show (c6), as the
                // renderer's RoomLatencyHost measured it.
                let (latency_done, latency_stopped) = oneshot::channel::<()>();
                tokio::spawn(crate::room_latency::run(
                    state.clone(),
                    room.clone(),
                    show_id.clone().unwrap_or_default(),
                    latency_stopped,
                ));
                let (aux_done, aux_stopped) = oneshot::channel::<()>();
                tokio::spawn(crate::room_aux::run(
                    state.clone(),
                    room.clone(),
                    show_id.clone().unwrap_or_default(),
                    receipts.clone(),
                    aux_stopped,
                ));
                // The host's screen behind Hide screen (S1.8c): its
                // acknowledgements and leaves come from here.
                let (screen_signals, screen_heard) = mpsc::unbounded_channel();
                let (screen_done, screen_stopped) = oneshot::channel::<()>();
                tokio::spawn(crate::room_screen::run_screen(
                    state.clone(),
                    room.clone(),
                    show_id.clone().unwrap_or_default(),
                    screen_heard,
                    screen_stopped,
                ));
                let (overlay_queue, overlay_worker) = overlay_sender(
                    state.clone(),
                    room.local_participant(),
                    show_id.clone().unwrap_or_default(),
                );
                let reason = loop {
                    tokio::select! {
                        _ = &mut stop => return leave(&state, Some(room)).await,
                        Some(overlay) = overlays.recv() => {
                        let _ = overlay_queue.send(overlay);
                    }
                    changed = stage.changed() => {
                            if changed.is_ok() {
                                let message = stage.borrow_and_update().clone();
                                publish_stage(&room, message).await;
                            }
                        }
                        event = events.recv() => match event {
                            Some(RoomEvent::Reconnecting) => {
                                report(&state, CloudRoomClientState::Reconnecting, None);
                                // System audio needs a fresh enable after any
                                // loss, as the renderer's room did (c4d).
                                crate::room_aux::disarm_system();
                                let _ = screen_signals
                                    .send(crate::room_screen::ScreenSignal::Reconnecting);
                            }
                            Some(RoomEvent::Reconnected) => {
                                report(&state, CloudRoomClientState::Connected, None);
                            }
                            // A guest who just joined needs the stage (data
                            // messages are not replayed).
                            Some(RoomEvent::ParticipantConnected(participant))
                                if needs_stage(participant.identity().as_str()) =>
                            {
                                let _ = subscriptions_changed.send(());
                                let message = stage.borrow().clone();
                                publish_stage(&room, message).await;
                            }
                            Some(RoomEvent::ParticipantConnected(_)) => {
                                let _ = subscriptions_changed.send(());
                            }
                            Some(RoomEvent::DataReceived { payload, topic, participant, .. })
                                if topic.as_deref() == Some(crate::room_capability::CAPABILITY_TOPIC) =>
                            {
                                let now = chrono::Utc::now().timestamp_millis();
                                let taken = receipts
                                    .lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                                    .received(&payload, participant.is_some(), now);
                                if taken.is_some() {
                                    let _ = subscriptions_changed.send(());
                                }
                                if let Some(capability) = taken {
                                    let _ = graphics_signals.send(
                                        crate::room_graphics::GraphicsSignal::Heard(
                                            capability.identity.clone(),
                                        ),
                                    );
                                    let _ = avatar_signals.send(
                                        crate::room_graphics::GraphicsSignal::Heard(
                                            capability.identity.clone(),
                                        ),
                                    );
                                    tracing::debug!(
                                        identity = %capability.identity,
                                        "A capability receipt reached the backend's room host"
                                    );
                                }
                            }
                            // Only server-relayed acknowledgements, bounded as
                            // the renderer's: a participant cannot send one.
                            Some(RoomEvent::DataReceived { payload, topic, participant, .. })
                                if topic.as_deref() == Some(crate::room_screen::PRIVACY_ACK_TOPIC) =>
                            {
                                if participant.is_some()
                                    || payload.len() > crate::room_screen::PRIVACY_ACK_MAX_BYTES
                                {
                                    continue;
                                }
                                let _ = screen_signals
                                    .send(crate::room_screen::ScreenSignal::Ack(payload.to_vec()));
                            }
                            Some(
                                RoomEvent::LocalTrackPublished { .. }
                                | RoomEvent::LocalTrackUnpublished { .. },
                            ) => {
                                let _ = subscriptions_changed.send(());
                            }
                            Some(RoomEvent::ParticipantDisconnected(participant)) => {
                                let _ = subscriptions_changed.send(());
                                let left = participant.identity().as_str().to_string();
                                let _ = screen_signals
                                    .send(crate::room_screen::ScreenSignal::Left(left.clone()));
                                let _ = graphics_signals
                                    .send(crate::room_graphics::GraphicsSignal::Left(left.clone()));
                                let _ = scene_signals
                                    .send(crate::room_graphics::GraphicsSignal::Left(left.clone()));
                                let _ = avatar_signals
                                    .send(crate::room_graphics::GraphicsSignal::Left(left));
                            }
                            Some(RoomEvent::Disconnected { reason }) => break reason,
                            None => break DisconnectReason::UnknownReason,
                            Some(_) => {}
                        },
                    }
                };
                overlay_worker.abort();
                graphics_task.abort();
                avatar_task.abort();
                scene_task.abort();
                drop(microphone_done);
                drop(camera_done);
                drop(screen_done);
                drop(subscriptions_done);
                drop(aux_done);
                drop(html_done);
                drop(remote_done);
                drop(guest_speech_done);
                drop(playout_done);
                drop(latency_done);
                crate::room_aux::disarm_system();
                tracing::info!("The talk show's room disconnected the backend: {reason:?}");
                match reason {
                    DisconnectReason::DuplicateIdentity => {
                        let Some(detail) = wait_for_takeover_detail(
                            &mut stop,
                            TAKE_OVER_WAIT,
                            TAKE_OVER_POLL,
                            || live_elsewhere(&state),
                        )
                        .await
                        else {
                            return leave(&state, None).await;
                        };
                        report(&state, CloudRoomClientState::Disconnected, detail);
                        HOLDS_SEAT.store(false, Ordering::Release);
                        return;
                    }
                    DisconnectReason::RoomDeleted | DisconnectReason::ParticipantRemoved => {
                        report(&state, CloudRoomClientState::Disconnected, None);
                        HOLDS_SEAT.store(false, Ordering::Release);
                        return;
                    }
                    _ => report(&state, CloudRoomClientState::Disconnected, None),
                }
            }
        }
        let delay = REJOIN_BACKOFF_S[attempt.min(REJOIN_BACKOFF_S.len() - 1)];
        attempt += 1;
        tokio::select! {
            _ = &mut stop => return leave(&state, None).await,
            _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
        }
    }
}

/// The connection's overlay sender: hand-offs for this show, one at a time.
fn overlay_sender(
    state: AppState,
    local: livekit::prelude::LocalParticipant,
    show_id: String,
) -> (mpsc::UnboundedSender<Value>, tokio::task::JoinHandle<()>) {
    let (queue, mut pending) = mpsc::unbounded_channel::<Value>();
    let worker = tokio::spawn(async move {
        // One send in flight per slot and orientation, as the renderer's
        // `sendOverlay`: a newer set or a clear aborts the older upload first
        // (an unfinished byte stream is never drawn), so a clear never waits
        // behind the set it cancels and other slots never wait at all.
        let mut sending = OverlaySends::default();
        while let Some(event) = pending.recv().await {
            if !crate::room_overlays::overlay_is_for_show(&event, &show_id) {
                continue;
            }
            sending.0.retain(|_, task| !task.is_finished());
            let key = overlay_key(&event);
            if let Some(older) = sending.0.remove(&key) {
                older.abort();
                // Fenced: the older send has stopped before this one starts.
                let _ = older.await;
            }
            let (state, local) = (state.clone(), local.clone());
            sending.0.insert(
                key,
                tokio::spawn(async move {
                    match crate::room_overlays::send_overlay(&state, &local, &event).await {
                        Ok(crate::room_overlays::OverlaySent::Sent) => {}
                        Ok(outcome) => {
                            tracing::info!("An overlay was not sent to the room: {outcome:?}")
                        }
                        Err(error) => {
                            tracing::warn!("An overlay did not reach the room: {error:#}")
                        }
                    }
                }),
            );
        }
    });
    (queue, worker)
}

/// The overlay sends in flight by slot; aborted with the worker (the
/// connection ended), so none outlives it.
#[derive(Default)]
struct OverlaySends(std::collections::HashMap<String, tokio::task::JoinHandle<()>>);

impl Drop for OverlaySends {
    fn drop(&mut self) {
        for task in self.0.values() {
            task.abort();
        }
    }
}

/// An overlay's slot and orientation: one send at a time each.
fn overlay_key(event: &Value) -> String {
    let text = |key: &str| event.get(key).and_then(Value::as_str).unwrap_or_default();
    format!("{}:{}", text("slot"), text("orientation"))
}

async fn publish_stage(room: &Room, message: Option<Vec<u8>>) {
    let Some(payload) = message else {
        return;
    };
    let packet = DataPacket {
        payload,
        topic: Some(STAGE_TOPIC.to_string()),
        reliable: true,
        ..DataPacket::default()
    };
    if let Err(error) = room.local_participant().publish_data(packet).await {
        tracing::warn!("The stage did not reach the talk show's room: {error}");
    }
}

/// The room closed (or never opened) here: leave it and give the seat back.
async fn leave(state: &AppState, room: Option<Arc<Room>>) {
    if let Some(room) = room
        && let Err(error) = room.close().await
    {
        tracing::warn!("The backend could not leave the talk show's room cleanly: {error}");
    }
    report(state, CloudRoomClientState::Idle, None);
    crate::room_graphics::reset_enabled();
    crate::room_avatar::reset_enabled();
    crate::room_content::clear();
    crate::room_media::clear();
    crate::room_screen::clear();
    crate::room_routing::clear();
    crate::room_aux::clear();
    crate::room_html::clear();
    crate::room_remote::clear();
    crate::room_guest_speech::clear();
    crate::room_playout::clear();
    HOLDS_SEAT.store(false, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_room_is_the_backends_in_a_dev_build_or_for_a_client_without_one() {
        // Electron's release: neither set, the renderer hosts.
        assert!(!switched_on(false, None, None));
        // The dev switch counts in debug builds only.
        assert!(switched_on(true, Some("1"), None));
        assert!(!switched_on(false, Some("1"), None));
        assert!(!switched_on(true, Some("0"), None));
        // The GPUI app: any build.
        assert!(switched_on(false, None, Some("backend")));
        assert!(switched_on(true, None, Some("backend")));
        assert!(!switched_on(false, None, Some("renderer")));
        assert!(!switched_on(false, None, Some("")));
    }

    #[test]
    fn overlays_queue_by_slot_and_orientation() {
        let card_h = serde_json::json!({ "op": "set", "slot": "card", "orientation": "h" });
        let card_h_clear = serde_json::json!({ "op": "clear", "slot": "card", "orientation": "h" });
        let card_v = serde_json::json!({ "op": "set", "slot": "card", "orientation": "v" });
        assert_eq!(overlay_key(&card_h), overlay_key(&card_h_clear));
        assert_ne!(overlay_key(&card_h), overlay_key(&card_v));
    }

    #[test]
    fn the_room_is_open_only_in_the_open_phase() {
        assert!(room_open(
            &serde_json::json!({ "room": { "phase": "open" } })
        ));
        for payload in [
            serde_json::json!({ "room": { "phase": "opening" } }),
            serde_json::json!({ "room": { "phase": "closing" } }),
            serde_json::json!({ "room": null }),
            serde_json::json!({}),
        ] {
            assert!(!room_open(&payload), "{payload}");
        }
    }

    fn stage(value: serde_json::Value) -> serde_json::Value {
        serde_json::from_slice(
            &stage_message(&serde_json::json!({ "room": { "stage": value } }), false).unwrap(),
        )
        .unwrap()
    }

    // The cases of `stageMessage` in talk-show-room.ts.
    #[test]
    fn the_stage_message_is_the_renderers() {
        assert_eq!(
            stage(serde_json::json!({ "onStage": ["host:s", "guest-a"], "screen": "guest-a" })),
            serde_json::json!({ "v": 1, "onStage": ["host:s", "guest-a"], "screen": "guest-a" })
        );
        // A screen of someone off stage is not named.
        assert_eq!(
            stage(serde_json::json!({ "onStage": ["host:s"], "screen": "guest-b" })),
            serde_json::json!({ "v": 1, "onStage": ["host:s"], "screen": null })
        );
        // Two screens: `screens` names both, `screen` stays the first.
        assert_eq!(
            stage(serde_json::json!({
                "onStage": ["host:s", "a", "b"],
                "screen": "a",
                "screens": ["a", "b"]
            })),
            serde_json::json!({
                "v": 1,
                "onStage": ["host:s", "a", "b"],
                "screen": "a",
                "screens": ["a", "b"]
            })
        );
        let captioned = stage_message(
            &serde_json::json!({ "room": { "stage": { "onStage": [] } } }),
            true,
        )
        .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&captioned).unwrap(),
            serde_json::json!({ "v": 1, "onStage": [], "screen": null, "captions": true })
        );
        assert!(stage_message(&serde_json::json!({ "room": null }), false).is_none());
    }

    #[test]
    fn a_joining_guest_gets_the_stage_but_not_the_runner_or_the_recorder() {
        assert!(needs_stage("guest-7f3a"));
        assert!(!needs_stage("runner:show-1"));
        assert!(!needs_stage("EG_abc123"));
    }

    #[test]
    fn the_rejoin_backoff_is_the_renderers() {
        assert_eq!(REJOIN_BACKOFF_S, [1, 2, 4, 8, 15]);
        let options = room_options();
        assert!(!options.auto_subscribe && !options.adaptive_stream && options.dynacast);
    }

    #[tokio::test]
    async fn duplicate_identity_reports_immediately_when_already_elsewhere() {
        let (_tx, mut stop) = oneshot::channel();
        let started = tokio::time::Instant::now();
        let detail = wait_for_takeover_detail(
            &mut stop,
            Duration::from_secs(3),
            Duration::from_millis(100),
            || true,
        )
        .await;
        assert_eq!(detail, Some(Some(TAKEN_OVER_DETAIL)));
        assert!(
            started.elapsed() < Duration::from_millis(200),
            "already-elsewhere duplicate host must not sleep for the full grace window"
        );
    }

    #[tokio::test]
    async fn duplicate_identity_waits_for_elsewhere_or_falls_back_to_room_lost() {
        let (_tx1, mut stop1) = oneshot::channel();
        let mut polls = 0usize;
        let detail = wait_for_takeover_detail(
            &mut stop1,
            Duration::from_millis(200),
            Duration::from_millis(10),
            || {
                polls += 1;
                polls >= 3
            },
        )
        .await;
        assert_eq!(detail, Some(Some(TAKEN_OVER_DETAIL)));

        let (_tx2, mut stop2) = oneshot::channel();
        let lost = wait_for_takeover_detail(
            &mut stop2,
            Duration::from_millis(30),
            Duration::from_millis(10),
            || false,
        )
        .await;
        assert_eq!(lost, Some(None));
    }
}
