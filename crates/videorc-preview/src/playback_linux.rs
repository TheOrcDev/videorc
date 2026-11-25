//! The Library's player on Linux (plan 260, L5): the same feed and element
//! as `playback.rs` on macOS, with the frames carried the Linux way. There
//! is no IOSurface, so the backend writes the decoded frames into the
//! playback's CPU ring (`playback.cpu.open`, #2031, on the live preview's
//! route (d) writer) and the app maps it with the reader the live preview
//! uses ([`CpuFrameSource`]), whose sink is a Linux presenter of the
//! player's own: a `wl_subsurface` or an X11 child window on the player's
//! slot. The UI draws nothing per frame.
//!
//! [`PlaybackFeed`] runs on the runtime: a control socket on the renderer
//! credential for `playback.open/play/pause/seek/mute/close` and the
//! `playback.status` event, and a ring socket on the admin credential that
//! holds `playback.cpu.open` (the ring closes with it). Each
//! `playback.frameReady` that finds no ring yet asks `playback.cpu.status`
//! again; a retired ring (a new frame size) is opened again the same way.
//! [`PlaybackElement`] is the UI thread's: the presenter, attached to the
//! window that holds the slot and placed on it.
//!
//! The public names are `playback.rs`'s, so the Library's player reads them
//! the same on both platforms.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
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
use videorc_protocol::PreviewCpuRingStatus;
use videorc_protocol::playback::{
    PLAYBACK_CPU_OPEN_METHOD, PLAYBACK_CPU_STATUS_METHOD, PLAYBACK_FRAME_READY_EVENT,
    PLAYBACK_STATUS_EVENT, PlaybackMuteParams, PlaybackOpenParams, PlaybackSeekParams,
    PlaybackState, PlaybackStatus,
};

use crate::LayerRect;
use crate::cpu_frames::{CpuFrameSource, CpuRequest, CpuSinks};
use crate::feed::Telemetry;
use crate::linux::{NativeHost, Placement, Presenter, PresenterClient};

/// After a dropped socket, before the next try.
const RETRY_DELAY: Duration = Duration::from_secs(2);
/// How often the view reads what the reader presented.
const VIEW_TICK: Duration = Duration::from_millis(250);

/// What the UI reads: the backend's status, what was presented, and the
/// connection (`playback.rs`'s, field for field).
#[derive(Debug, Clone, PartialEq)]
pub struct PlaybackView {
    pub status: PlaybackStatus,
    /// The last frame the presenter showed.
    pub presented_frame_id: u64,
    pub presented_frames: u64,
    pub connected: bool,
    /// The last failure of the feed's own (the ring, a socket), for the log
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
    /// The presenter to draw into (none while the child is away).
    Presenter(Option<PresenterClient>),
    Stop,
}

/// The feed: one task on the runtime, and the ring's reader thread.
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
        let task = handle.spawn(run(
            handle.clone(),
            state,
            logger,
            inbox,
            view_tx,
            presenter,
        ));
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

    /// Stops the feed: the playback is closed, the ring and the sockets
    /// closed. Waits for it.
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

impl Carried {
    fn sinks(&self) -> CpuSinks {
        CpuSinks {
            texture: None,
            presenter: self.presenter.clone(),
        }
    }
}

enum Exit {
    Stop,
    Disconnected(String),
}

async fn run(
    runtime: tokio::runtime::Handle,
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
            &runtime,
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

/// The ring a `playback.cpu.*` answer names, if any.
fn ring_of(answer: Value) -> Option<videorc_protocol::PreviewCpuRing> {
    serde_json::from_value::<PreviewCpuRingStatus>(answer)
        .ok()
        .and_then(|status| status.ring)
}

/// The ring socket: holds `playback.cpu.open` and asks after the ring.
struct Ring {
    socket: BackendSocket,
    source: CpuFrameSource,
    /// The ring generation handed to the reader.
    generation: Option<u64>,
}

impl Ring {
    /// Asks for the current ring (`method`: open first, then status) and
    /// hands a new one to the reader.
    async fn refresh(&mut self, method: &str) -> Result<()> {
        let answer = self
            .socket
            .request(method, json!({}))
            .await
            .map_err(|error| anyhow::anyhow!("{method}: {error}"))?;
        if let Some(ring) = ring_of(answer)
            && self.generation != Some(ring.generation)
        {
            self.generation = Some(ring.generation);
            self.source.set_ring(Some(ring));
        }
        Ok(())
    }
}

async fn session(
    runtime: &tokio::runtime::Handle,
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
    let ring_socket = BackendSocket::connect(
        &bootstrap.admin(),
        Duration::from_secs(30),
        Duration::from_secs(2),
    )
    .await
    .context("the player's ring socket")?;
    ring_socket.set_included_events(&[]).await?;
    control
        .set_included_events(&[PLAYBACK_STATUS_EVENT, PLAYBACK_FRAME_READY_EVENT])
        .await?;
    let telemetry = Arc::new(Mutex::new(Telemetry::default()));
    let (requests_tx, mut requests) = mpsc::unbounded_channel::<CpuRequest>();
    let source = CpuFrameSource::start(
        carried.sinks(),
        telemetry.clone(),
        logger.clone(),
        requests_tx,
        runtime.clone(),
    )
    .context("the player's ring reader")?;
    let mut ring = Ring {
        socket: ring_socket,
        source,
        generation: None,
    };
    ring.refresh(PLAYBACK_CPU_OPEN_METHOD).await?;
    view.send_modify(|v| {
        v.connected = true;
        v.last_error = None;
    });
    let mut events = control.subscribe();
    let outcome = session_body(
        &control,
        logger,
        commands,
        view,
        carried,
        &mut ring,
        &mut events,
        &mut requests,
        &telemetry,
        &mut state,
    )
    .await;
    if control.is_open() && view.borrow().is_open() {
        match control.call::<PlaybackClose>(&()).await {
            Ok(status) => view.send_modify(|v| v.status = status),
            Err(error) => logger.log(Level::Warn, &format!("[player] close: {error}")),
        }
    }
    let Ring { socket, source, .. } = ring;
    source.stop();
    socket.close().await;
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
    ring: &mut Ring,
    events: &mut tokio::sync::broadcast::Receiver<videorc_app_core::client::ServerEvent>,
    requests: &mut mpsc::UnboundedReceiver<CpuRequest>,
    telemetry: &Arc<Mutex<Telemetry>>,
    state: &mut watch::Receiver<BackendState>,
) -> Result<Exit> {
    let mut tick = tokio::time::interval(VIEW_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            command = commands.recv() => {
                let Some(command) = command else { return Ok(Exit::Stop) };
                match command {
                    PlaybackCommand::Stop => return Ok(Exit::Stop),
                    PlaybackCommand::Presenter(presenter) => {
                        carried.presenter = presenter;
                        ring.source.set_sinks(carried.sinks());
                    }
                    PlaybackCommand::Open { session_id, max_width, max_height } => {
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
                        apply_answer(view, logger, "close", control.call::<PlaybackClose>(&()).await);
                    }
                }
            }
            event = events.recv() => match event {
                Ok(event) if event.event == PLAYBACK_STATUS_EVENT => {
                    if let Ok(status) = serde_json::from_value::<PlaybackStatus>(event.payload) {
                        view.send_modify(|v| v.status = status);
                    }
                }
                // A frame with no ring mapped yet: the ring appears with the
                // first frame of a size, so ask for it now.
                Ok(event) if event.event == PLAYBACK_FRAME_READY_EVENT && ring.generation.is_none() => {
                    if let Err(error) = ring.refresh(PLAYBACK_CPU_STATUS_METHOD).await {
                        if !ring.socket.is_open() {
                            return Err(error);
                        }
                        logger.log(Level::Warn, &format!("[player] ring: {error:#}"));
                    }
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    return Ok(Exit::Disconnected("the control socket's events ended".into()));
                }
            },
            request = requests.recv() => {
                if let Some(CpuRequest::Reopen) = request {
                    // A retired ring: a new frame size made a new one.
                    ring.generation = None;
                    if let Err(error) = ring.refresh(PLAYBACK_CPU_STATUS_METHOD).await {
                        if !ring.socket.is_open() {
                            return Err(error);
                        }
                        logger.log(Level::Warn, &format!("[player] ring: {error:#}"));
                    }
                }
            }
            _ = tick.tick() => {
                let (presented, frame_id) = telemetry
                    .lock()
                    .map(|t| (t.presented, t.presented_frame_id))
                    .unwrap_or_default();
                if view.borrow().presented_frames != presented {
                    view.send_modify(|v| {
                        v.presented_frames = presented;
                        v.presented_frame_id = frame_id;
                    });
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

/// The player's element, owned by the UI thread: the Linux presenter of its
/// own, attached to the window that holds the slot and placed on it.
pub struct PlaybackElement {
    feed: Option<PlaybackFeed>,
    presenter: Option<Presenter>,
    rect: Option<LayerRect>,
    scale: f64,
    visible: bool,
    logger: Logger,
}

impl PlaybackElement {
    /// Starts the feed; the presenter comes with [`attach`](Self::attach)
    /// (a child exists only in a window).
    pub fn start(
        handle: &tokio::runtime::Handle,
        state: watch::Receiver<BackendState>,
        logger: Logger,
    ) -> Result<Self, String> {
        let feed = PlaybackFeed::start(handle, state, logger.clone(), None);
        Ok(Self {
            feed: Some(feed),
            presenter: None,
            rect: None,
            scale: 1.0,
            visible: true,
            logger,
        })
    }

    /// Builds the presenter's child in `window` (a subsurface on Wayland, a
    /// child window on X11), hands it to the feed and places it on the rect
    /// given so far. A child in another window goes first.
    pub fn attach(&mut self, window: &dyn NativeHost) -> Result<(), String> {
        self.detach();
        let mut presenter = Presenter::attach(window)?;
        presenter.set_hidden(!self.visible);
        self.send(PlaybackCommand::Presenter(Some(presenter.client())));
        self.presenter = Some(presenter);
        if let Some(rect) = self.rect {
            self.place_scaled(rect, self.scale);
        }
        Ok(())
    }

    /// Takes the child down; nothing shows until the next
    /// [`attach`](Self::attach). The playback stays.
    pub fn detach(&mut self) {
        if self.presenter.take().is_some() {
            self.send(PlaybackCommand::Presenter(None));
        }
    }

    pub fn attached(&self) -> bool {
        self.presenter.is_some()
    }

    /// The UI laid the slot out (window points): the child follows in the
    /// same pass, at the last scale given. True when its placement changed.
    pub fn place(&mut self, rect: LayerRect) -> bool {
        self.place_scaled(rect, self.scale)
    }

    /// [`place`](Self::place) with the window's scale factor.
    pub fn place_scaled(&mut self, rect: LayerRect, scale: f64) -> bool {
        self.rect = Some(rect);
        self.scale = scale;
        match self.presenter.as_mut() {
            Some(presenter) => presenter.set_placement(Placement { rect, scale }),
            None => false,
        }
    }

    /// The host's visibility decision (the page away, a dialog over it).
    pub fn set_visible(&mut self, visible: bool) {
        self.visible = visible;
        if let Some(presenter) = self.presenter.as_mut() {
            presenter.set_hidden(!visible);
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

    /// Stops everything: the playback is closed, the child taken down.
    pub fn stop(mut self) {
        self.detach();
        if let Some(feed) = self.feed.take() {
            feed.send(PlaybackCommand::Stop);
        }
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
        assert!(view.describe().contains("not connected"));
        view.connected = true;
        view.status.state = PlaybackState::Playing;
        view.presented_frame_id = 42;
        view.presented_frames = 40;
        assert!(view.is_open());
        assert!(view.describe().contains("frame 42 presented (40 frames)"));
    }

    #[test]
    fn a_ring_answer_without_a_ring_names_none() {
        let closed = serde_json::to_value(PreviewCpuRingStatus::default()).unwrap();
        assert!(ring_of(closed).is_none());
        assert!(ring_of(json!({"open": true})).is_none());
        assert!(ring_of(json!("not a status")).is_none());
    }
}
