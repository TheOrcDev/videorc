//! The Library's player on the element (plan 220 S3.7b, P3-D3): the backend
//! decodes a recording into its own ring and plays its sound; this module is
//! the app's half. [`PlaybackFeed`] runs on the runtime: a control socket on
//! the renderer credential for `playback.open/play/pause/seek/mute/close`
//! and the `playback.status` and `playback.frameReady` events, a lease
//! socket on the admin credential for `playback.frame.acquire/release`, and
//! the latest-wins lease loop of [`crate::feed`] without its scene and
//! contracts (a playback is not a live capture: its status is the
//! backend's). [`PlaybackElement`] is the UI thread's: its own
//! [`Presenter`] and a [`VideoLayer`] the Library page places on the
//! player's slot, so the picture reaches the screen the way the live
//! preview does and the UI draws nothing per frame.
//!
//! The feed follows the supervisor: a new backend generation has no
//! playback, so the view says `closed` and the page opens again if it wants
//! to. Nothing here touches the live preview's surface, feed or compositor.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use raw_window_handle::HasWindowHandle;
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use videorc_app_core::client::BackendSocket;
use videorc_app_core::client::methods::{
    PlaybackClose, PlaybackMute, PlaybackOpen, PlaybackPause, PlaybackPlay, PlaybackSeek,
};
use videorc_app_core::client::socket::ENGINE_NOT_CONNECTED;
use videorc_app_core::process::BackendBootstrap;
use videorc_app_core::supervisor::BackendState;
use videorc_app_core::{Level, Logger};
use videorc_protocol::playback::{
    PLAYBACK_FRAME_READY_EVENT, PLAYBACK_STATUS_EVENT, PlaybackFrameReady, PlaybackMuteParams,
    PlaybackOpenParams, PlaybackSeekParams, PlaybackState, PlaybackStatus,
};

use crate::LayerRect;
use crate::macos::{ImportOutcome, Presenter, PresenterClient, VideoLayer};

/// The presenter must answer within this after a frame is handed over; a
/// frame that misses it is released anyway so the next one can be leased.
const PRESENT_DEADLINE: Duration = Duration::from_millis(250);
/// After a dropped socket, before the next try.
const RETRY_DELAY: Duration = Duration::from_secs(2);
/// The presenter's layer id for the player (the live preview uses 0 and 1
/// on its own presenter; this is a separate presenter, the id is its own).
const PLAYER_LAYER: u8 = 0;

/// What the UI reads: the backend's status, what was presented, and the
/// connection.
#[derive(Debug, Clone, PartialEq)]
pub struct PlaybackView {
    pub status: PlaybackStatus,
    /// The last frame the presenter committed to the layer.
    pub presented_frame_id: u64,
    pub presented_frames: u64,
    pub connected: bool,
    /// The last failure of the feed's own (a lease, a present), for the log
    /// and the status; the backend's refusals are in `status`.
    pub last_error: Option<String>,
}

impl Default for PlaybackView {
    fn default() -> Self {
        Self {
            status: PlaybackStatus::closed(String::new()),
            presented_frame_id: 0,
            presented_frames: 0,
            connected: false,
            last_error: None,
        }
    }
}

impl PlaybackView {
    /// One line for the log and the smoke commands.
    pub fn describe(&self) -> String {
        let status = &self.status;
        let mut line = format!(
            "{:?} {} ms of {} ms, {}×{}, frame {} presented ({} frames)",
            status.state,
            status.position_ms,
            status.duration_ms,
            status.width,
            status.height,
            self.presented_frame_id,
            self.presented_frames
        );
        if let Some(refusal) = status.refusal {
            line.push_str(&format!(", refused: {refusal:?}"));
        }
        if let Some(message) = &status.message {
            line.push_str(&format!(", {message}"));
        }
        if !self.connected {
            line.push_str(", not connected");
        }
        line
    }

    pub fn is_open(&self) -> bool {
        matches!(
            self.status.state,
            PlaybackState::Opening
                | PlaybackState::Paused
                | PlaybackState::Playing
                | PlaybackState::Ended
        )
    }
}

/// The orders the UI gives the feed.
pub enum PlaybackCommand {
    Open {
        session_id: String,
        max_width: Option<u32>,
        max_height: Option<u32>,
    },
    Play,
    Pause,
    Seek(u64),
    Mute(bool),
    Close,
    /// The presenter to draw into (none while the layer is away).
    Presenter(Option<PresenterClient>),
    Stop,
}

/// The feed: one task on the runtime.
pub struct PlaybackFeed {
    commands: mpsc::UnboundedSender<PlaybackCommand>,
    view: watch::Receiver<PlaybackView>,
    task: Option<JoinHandle<()>>,
}

impl PlaybackFeed {
    pub fn start(
        handle: &tokio::runtime::Handle,
        state: watch::Receiver<BackendState>,
        logger: Logger,
        presenter: Option<PresenterClient>,
    ) -> Self {
        let (commands, inbox) = mpsc::unbounded_channel();
        let (view_tx, view) = watch::channel(PlaybackView::default());
        let task = handle.spawn(run(state, logger, inbox, view_tx, presenter));
        Self {
            commands,
            view,
            task: Some(task),
        }
    }

    pub fn send(&self, command: PlaybackCommand) {
        let _ = self.commands.send(command);
    }

    pub fn view(&self) -> PlaybackView {
        self.view.borrow().clone()
    }

    pub fn view_watch(&self) -> watch::Receiver<PlaybackView> {
        self.view.clone()
    }

    /// Stops the feed: the playback is closed, the lease released, the
    /// sockets closed. Waits for it.
    pub async fn stop(mut self) {
        self.send(PlaybackCommand::Stop);
        if let Some(task) = self.task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(10), task).await;
        }
    }
}

impl Drop for PlaybackFeed {
    fn drop(&mut self) {
        let _ = self.commands.send(PlaybackCommand::Stop);
    }
}

/// What carries from one backend generation to the next.
struct Carried {
    presenter: Option<PresenterClient>,
}

async fn run(
    mut state: watch::Receiver<BackendState>,
    logger: Logger,
    mut commands: mpsc::UnboundedReceiver<PlaybackCommand>,
    view: watch::Sender<PlaybackView>,
    presenter: Option<PresenterClient>,
) {
    let mut carried = Carried { presenter };
    loop {
        let bootstrap = loop {
            if let Some(bootstrap) = state.borrow_and_update().bootstrap().cloned() {
                break bootstrap;
            }
            tokio::select! {
                changed = state.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
                command = commands.recv() => match command {
                    Some(PlaybackCommand::Stop) | None => return,
                    Some(PlaybackCommand::Presenter(presenter)) => carried.presenter = presenter,
                    Some(_) => {
                        view.send_modify(|v| {
                            v.last_error = Some(ENGINE_NOT_CONNECTED.to_string());
                        });
                    }
                }
            }
        };
        let exit = session(
            &bootstrap,
            &logger,
            &mut commands,
            &view,
            &mut carried,
            state.clone(),
        )
        .await;
        view.send_modify(|v| {
            v.connected = false;
            v.status = PlaybackStatus::closed(String::new());
        });
        match exit {
            Ok(Exit::Stop) => return,
            Ok(Exit::Disconnected(reason)) => {
                logger.log(
                    Level::Warn,
                    &format!("[player] feed disconnected: {reason}"),
                );
            }
            Err(error) => {
                logger.log(Level::Error, &format!("[player] feed failed: {error:#}"));
                view.send_modify(|v| v.last_error = Some(format!("{error:#}")));
            }
        }
        let retry = tokio::time::sleep(RETRY_DELAY);
        tokio::pin!(retry);
        loop {
            tokio::select! {
                _ = &mut retry => break,
                changed = state.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    break;
                }
                command = commands.recv() => match command {
                    Some(PlaybackCommand::Stop) | None => return,
                    Some(PlaybackCommand::Presenter(presenter)) => carried.presenter = presenter,
                    Some(_) => {}
                }
            }
        }
    }
}

enum Exit {
    Stop,
    Disconnected(String),
}

/// The lease socket and its one outstanding lease.
struct Lease {
    socket: BackendSocket,
    outstanding: Option<String>,
}

struct Leased {
    frame_id: u64,
    iosurface_id: u32,
    width: u32,
    height: u32,
}

impl Lease {
    /// Retains the latest frame of `playback_id`. `Ok(None)`: the backend
    /// has none (the playback closed, or moved on).
    async fn acquire(&mut self, playback_id: &str) -> Result<Option<Leased>> {
        if let Some(id) = &self.outstanding {
            bail!("lease {id} is still outstanding");
        }
        let lease_id = uuid::Uuid::new_v4().to_string();
        let payload = self
            .socket
            .request(
                "playback.frame.acquire",
                acquire_params(&lease_id, playback_id),
            )
            .await?;
        if payload.is_null() {
            return Ok(None);
        }
        self.outstanding = Some(lease_id);
        let frame: PlaybackFrameReady = match serde_json::from_value(payload) {
            Ok(frame) => frame,
            Err(error) => {
                let _ = self.release().await;
                return Err(anyhow!("the leased frame did not parse: {error}"));
            }
        };
        let Some(iosurface_id) = frame.iosurface_id else {
            let _ = self.release().await;
            bail!("the leased frame has no IOSurface");
        };
        Ok(Some(Leased {
            frame_id: frame.frame_id,
            iosurface_id,
            width: frame.width,
            height: frame.height,
        }))
    }

    async fn release(&mut self) -> Result<()> {
        let Some(lease_id) = self.outstanding.take() else {
            return Ok(());
        };
        let acknowledged = self
            .socket
            .request("playback.frame.release", json!({ "leaseId": lease_id }))
            .await?;
        if acknowledged.as_bool() != Some(true) {
            bail!("the frame release was not acknowledged: {acknowledged}");
        }
        Ok(())
    }
}

/// `playback.frame.acquire`'s params.
pub fn acquire_params(lease_id: &str, playback_id: &str) -> Value {
    json!({ "leaseId": lease_id, "playbackId": playback_id })
}

async fn session(
    bootstrap: &BackendBootstrap,
    logger: &Logger,
    commands: &mut mpsc::UnboundedReceiver<PlaybackCommand>,
    view: &watch::Sender<PlaybackView>,
    carried: &mut Carried,
    mut state: watch::Receiver<BackendState>,
) -> Result<Exit> {
    let control = Arc::new(
        BackendSocket::connect(
            &bootstrap.renderer(),
            Duration::from_secs(30),
            Duration::from_secs(30),
        )
        .await
        .context("the player's control socket")?,
    );
    let lease_socket = BackendSocket::connect(
        &bootstrap.admin(),
        Duration::from_secs(30),
        Duration::from_secs(2),
    )
    .await
    .context("the player's lease socket")?;
    lease_socket.set_included_events(&[]).await?;
    control
        .set_included_events(&[PLAYBACK_STATUS_EVENT, PLAYBACK_FRAME_READY_EVENT])
        .await?;
    view.send_modify(|v| {
        v.connected = true;
        v.last_error = None;
    });
    let mut lease = Lease {
        socket: lease_socket,
        outstanding: None,
    };
    // Subscribe before anything is open so the first frame is not lost.
    let mut events = control.subscribe();
    let (frames_tx, mut frames) = watch::channel::<Option<PlaybackFrameReady>>(None);
    let feeder_view = view.clone();
    let feeder = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) if event.event == PLAYBACK_FRAME_READY_EVENT => {
                    if let Ok(frame) = serde_json::from_value::<PlaybackFrameReady>(event.payload) {
                        // Latest wins.
                        let _ = frames_tx.send(Some(frame));
                    }
                }
                Ok(event) if event.event == PLAYBACK_STATUS_EVENT => {
                    if let Ok(status) = serde_json::from_value::<PlaybackStatus>(event.payload) {
                        feeder_view.send_modify(|v| v.status = status);
                    }
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    let outcome = session_body(
        &control,
        logger,
        commands,
        view,
        carried,
        &mut lease,
        &mut frames,
        &mut state,
    )
    .await;
    feeder.abort();
    let _ = lease.release().await;
    if control.is_open() && view.borrow().is_open() {
        match control.call::<PlaybackClose>(&()).await {
            Ok(status) => view.send_modify(|v| v.status = status),
            Err(error) => logger.log(Level::Warn, &format!("[player] close: {error}")),
        }
    }
    lease.socket.close().await;
    control.close().await;
    outcome
}

#[allow(clippy::too_many_arguments)]
async fn session_body(
    control: &Arc<BackendSocket>,
    logger: &Logger,
    commands: &mut mpsc::UnboundedReceiver<PlaybackCommand>,
    view: &watch::Sender<PlaybackView>,
    carried: &mut Carried,
    lease: &mut Lease,
    frames: &mut watch::Receiver<Option<PlaybackFrameReady>>,
    state: &mut watch::Receiver<BackendState>,
) -> Result<Exit> {
    let mut last_presented: Option<u64> = None;
    loop {
        tokio::select! {
            biased;
            command = commands.recv() => {
                let Some(command) = command else { return Ok(Exit::Stop) };
                match command {
                    PlaybackCommand::Stop => return Ok(Exit::Stop),
                    PlaybackCommand::Presenter(presenter) => carried.presenter = presenter,
                    PlaybackCommand::Open { session_id, max_width, max_height } => {
                        last_presented = None;
                        let answer = control
                            .call::<PlaybackOpen>(&PlaybackOpenParams { session_id, max_width, max_height })
                            .await;
                        apply_answer(view, logger, "open", answer);
                    }
                    PlaybackCommand::Play => {
                        apply_answer(view, logger, "play", control.call::<PlaybackPlay>(&()).await);
                    }
                    PlaybackCommand::Pause => {
                        apply_answer(view, logger, "pause", control.call::<PlaybackPause>(&()).await);
                    }
                    PlaybackCommand::Seek(position_ms) => {
                        apply_answer(
                            view,
                            logger,
                            "seek",
                            control.call::<PlaybackSeek>(&PlaybackSeekParams { position_ms }).await,
                        );
                    }
                    PlaybackCommand::Mute(muted) => {
                        apply_answer(
                            view,
                            logger,
                            "mute",
                            control.call::<PlaybackMute>(&PlaybackMuteParams { muted }).await,
                        );
                    }
                    PlaybackCommand::Close => {
                        last_presented = None;
                        apply_answer(view, logger, "close", control.call::<PlaybackClose>(&()).await);
                    }
                }
            }
            changed = frames.changed() => {
                if changed.is_err() {
                    return Ok(Exit::Disconnected("the frame lane closed".into()));
                }
                let ready = frames.borrow_and_update().clone();
                if let Some(ready) = ready
                    && let Err(error) = present_one(&ready, logger, view, carried, lease, &mut last_presented).await
                {
                    return Err(error);
                }
            }
            reason = control.wait_closed() => {
                return Ok(Exit::Disconnected(reason));
            }
            changed = state.changed() => {
                if changed.is_err() {
                    return Ok(Exit::Stop);
                }
                if !state.borrow().is_ready() {
                    return Ok(Exit::Disconnected("the engine generation ended".into()));
                }
            }
        }
    }
}

fn apply_answer(
    view: &watch::Sender<PlaybackView>,
    logger: &Logger,
    what: &str,
    answer: std::result::Result<PlaybackStatus, videorc_app_core::client::RpcError>,
) {
    match answer {
        Ok(status) => {
            if status.state == PlaybackState::Failed {
                logger.log(
                    Level::Warn,
                    &format!(
                        "[player] {what}: {}",
                        status
                            .message
                            .clone()
                            .or_else(|| status.refusal.map(|refusal| format!("{refusal:?}")))
                            .unwrap_or_else(|| "failed".into())
                    ),
                );
            }
            view.send_modify(|v| {
                v.status = status;
                v.last_error = None;
            });
        }
        Err(error) => {
            logger.log(Level::Warn, &format!("[player] {what}: {error}"));
            view.send_modify(|v| v.last_error = Some(format!("{what}: {error}")));
        }
    }
}

/// Leases `ready`'s playback's latest frame, hands it to the presenter,
/// waits until the GPU is done and releases it.
async fn present_one(
    ready: &PlaybackFrameReady,
    logger: &Logger,
    view: &watch::Sender<PlaybackView>,
    carried: &Carried,
    lease: &mut Lease,
    last_presented: &mut Option<u64>,
) -> Result<()> {
    if ready.iosurface_id.is_none() {
        return Ok(());
    }
    if *last_presented == Some(ready.frame_id) {
        return Ok(());
    }
    let Some(presenter) = carried.presenter.as_ref() else {
        return Ok(());
    };
    let leased = match lease.acquire(&ready.playback_id).await {
        Ok(Some(leased)) => leased,
        Ok(None) => return Ok(()),
        Err(error) => {
            view.send_modify(|v| v.last_error = Some(format!("{error:#}")));
            if !lease.socket.is_open() {
                return Err(error);
            }
            logger.log(Level::Warn, &format!("[player] lease: {error:#}"));
            return Ok(());
        }
    };
    let reply = presenter.present(
        leased.frame_id,
        leased.iosurface_id,
        leased.width,
        leased.height,
    );
    let report = tokio::task::block_in_place(|| reply.recv_timeout(PRESENT_DEADLINE));
    lease.release().await?;
    match report {
        Err(_) => {
            view.send_modify(|v| {
                v.last_error = Some(format!(
                    "the presenter did not answer for frame {} within {PRESENT_DEADLINE:?}",
                    leased.frame_id
                ));
            });
        }
        Ok(report) => {
            if let ImportOutcome::Failed(reason) = &report.import {
                logger.log(
                    Level::Warn,
                    &format!("[player] import of frame {}: {reason}", leased.frame_id),
                );
                view.send_modify(|v| v.last_error = Some(reason.clone()));
            } else {
                *last_presented = Some(leased.frame_id);
                view.send_modify(|v| {
                    v.presented_frame_id = leased.frame_id;
                    v.presented_frames += 1;
                });
            }
        }
    }
    Ok(())
}

/// The player's element, owned by the UI thread: its own presenter and one
/// layer the Library page places on the player's slot.
pub struct PlaybackElement {
    feed: Option<PlaybackFeed>,
    presenter: Option<Presenter>,
    layer: Option<VideoLayer>,
    rect: Option<LayerRect>,
    visible: bool,
    logger: Logger,
}

impl PlaybackElement {
    /// Starts the presenter and the feed. Fails when Metal is unavailable:
    /// the caller shows that reason.
    pub fn start(
        handle: &tokio::runtime::Handle,
        state: watch::Receiver<BackendState>,
        logger: Logger,
    ) -> Result<Self, String> {
        let presenter = Presenter::start().map_err(|error| format!("Metal presenter: {error}"))?;
        let feed = PlaybackFeed::start(handle, state, logger.clone(), Some(presenter.client()));
        Ok(Self {
            feed: Some(feed),
            presenter: Some(presenter),
            layer: None,
            rect: None,
            visible: true,
            logger,
        })
    }

    /// Adds the layer to the window (main thread, after the native window
    /// exists) and places it on the rect given so far.
    pub fn attach(&mut self, window: &dyn HasWindowHandle) -> Result<(), String> {
        let presenter = self
            .presenter
            .as_ref()
            .ok_or_else(|| "the presenter is down".to_string())?;
        self.layer = None;
        let mut layer = VideoLayer::attach(window, presenter.device())?;
        layer.set_hidden(!self.visible);
        presenter.add_layer(PLAYER_LAYER, &layer);
        self.layer = Some(layer);
        if let Some(rect) = self.rect {
            self.place(rect);
        }
        Ok(())
    }

    /// Takes the layer out of its window; the presenter stops drawing until
    /// the next [`attach`](Self::attach). The playback stays.
    pub fn detach(&mut self) {
        self.layer = None;
        self.rect = None;
        if let Some(presenter) = &self.presenter {
            presenter.remove_layer(PLAYER_LAYER);
        }
    }

    pub fn attached(&self) -> bool {
        self.layer.is_some()
    }

    /// The UI laid the slot out: the layer follows in the same pass.
    /// Returns true when the layer's frame changed.
    pub fn place(&mut self, rect: LayerRect) -> bool {
        self.rect = Some(rect);
        match self.layer.as_mut() {
            Some(layer) => layer.set_frame(rect),
            None => false,
        }
    }

    /// The host's visibility decision (the page away, a dialog over it).
    pub fn set_visible(&mut self, visible: bool) {
        self.visible = visible;
        if let Some(layer) = self.layer.as_mut() {
            layer.set_hidden(!visible);
        }
    }

    pub fn send(&self, command: PlaybackCommand) {
        if let Some(feed) = &self.feed {
            feed.send(command);
        }
    }

    pub fn open(&self, session_id: &str, max_width: Option<u32>, max_height: Option<u32>) {
        self.send(PlaybackCommand::Open {
            session_id: session_id.to_string(),
            max_width,
            max_height,
        });
    }

    pub fn play(&self) {
        self.send(PlaybackCommand::Play);
    }

    pub fn pause(&self) {
        self.send(PlaybackCommand::Pause);
    }

    pub fn seek(&self, position_ms: u64) {
        self.send(PlaybackCommand::Seek(position_ms));
    }

    pub fn set_muted(&self, muted: bool) {
        self.send(PlaybackCommand::Mute(muted));
    }

    pub fn close(&self) {
        self.send(PlaybackCommand::Close);
    }

    pub fn view(&self) -> PlaybackView {
        self.feed
            .as_ref()
            .map(PlaybackFeed::view)
            .unwrap_or_default()
    }

    pub fn view_watch(&self) -> Option<watch::Receiver<PlaybackView>> {
        self.feed.as_ref().map(PlaybackFeed::view_watch)
    }

    /// Stops everything: the playback is closed, the layer removed.
    pub fn stop(mut self) {
        self.detach();
        if let Some(feed) = self.feed.take() {
            feed.send(PlaybackCommand::Stop);
        }
        self.presenter = None;
        self.logger.log(Level::Info, "[player] element stopped");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_view_describes_itself_and_knows_when_it_is_open() {
        let mut view = PlaybackView::default();
        assert!(!view.is_open());
        assert!(view.describe().contains("Closed"));
        assert!(view.describe().contains("not connected"));
        view.connected = true;
        view.status.state = PlaybackState::Playing;
        view.status.position_ms = 1_500;
        view.status.duration_ms = 60_000;
        view.status.width = 1280;
        view.status.height = 720;
        view.presented_frame_id = 42;
        view.presented_frames = 40;
        assert!(view.is_open());
        let line = view.describe();
        assert!(
            line.contains("Playing 1500 ms of 60000 ms, 1280×720, frame 42 presented (40 frames)"),
            "{line}"
        );
        assert!(!line.contains("not connected"));
        view.status.state = PlaybackState::Failed;
        view.status.refusal = Some(videorc_protocol::playback::PlaybackRefusal::NotReady);
        assert!(!view.is_open());
        assert!(view.describe().contains("refused: NotReady"));
    }

    #[test]
    fn the_lease_params_name_the_playback() {
        let params = acquire_params("lease-1", "pb-9");
        assert_eq!(params["leaseId"], "lease-1");
        assert_eq!(params["playbackId"], "pb-9");
    }
}
