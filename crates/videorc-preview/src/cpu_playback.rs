//! The Library's player on Windows and Linux (plan 260, L2): the CPU-ring
//! twin of [`crate::playback`] (macOS), with the same element API so the
//! Library page drives both alike.
//!
//! The backend decodes the recording and plays its sound (`playback.rs`,
//! #2052); its frames reach this process through the playback's own CPU
//! ring (`playback.cpu.*`, #2031, on #1930's writer). [`PlaybackFeed`] runs
//! on the runtime:
//!
//! - a **control socket** on the renderer credential for
//!   `playback.open/play/pause/seek/mute/close` and the `playback.status`
//!   events;
//! - a **ring socket** on the admin credential that holds `playback.cpu.open`
//!   for as long as it lives (the backend closes the ring with the socket),
//!   and asks `playback.cpu.status` again when the ring retires (a new frame
//!   size is a new ring) or before the first frame told its size;
//! - the live preview's [`CpuFrameSource`], which maps the ring, leases the
//!   newest frame and hands it to the sinks.
//!
//! On Linux the sink is the live preview's presenter ([`crate::linux`]): a
//! `wl_subsurface` or an X11 child window above GPUI's drawing, so the
//! display server draws the video and GPUI never redraws per frame. Windows
//! has no presenter yet (plan 260 S2.3b brings the live preview's): the
//! sound and the controls work and the slot says the picture is missing.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::Value;
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
    PLAYBACK_CPU_OPEN_METHOD, PLAYBACK_CPU_STATUS_METHOD, PLAYBACK_STATUS_EVENT,
    PlaybackMuteParams, PlaybackOpenParams, PlaybackSeekParams, PlaybackState, PlaybackStatus,
};

use crate::LayerRect;
use crate::cpu_frames::{CpuFrameSource, CpuRequest, CpuSinks};
use crate::feed::Telemetry;

/// After a dropped socket, before the next try.
const RETRY_DELAY: Duration = Duration::from_secs(2);
/// How often the feed reads the presenter's count and, until the ring is
/// known, asks for it.
const TICK: Duration = Duration::from_millis(100);

/// Whether this platform draws the player's picture (Linux's presenter).
pub const DRAWS_PICTURE: bool = cfg!(target_os = "linux");

/// What the UI reads: the backend's status, what was presented, and the
/// connection (the macOS element's view, field for field).
#[derive(Debug, Clone, PartialEq)]
pub struct PlaybackView {
    pub status: PlaybackStatus,
    /// The last frame the presenter committed (its count, the ring has no
    /// per-frame id on this side).
    pub presented_frame_id: u64,
    pub presented_frames: u64,
    pub connected: bool,
    /// The last failure of the feed's own (a socket, the ring), for the log;
    /// the backend's refusals are in `status`.
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
    /// Where the leased frames go (the presenter, or none while it is away).
    Sinks(CpuSinks),
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
        sinks: CpuSinks,
    ) -> Self {
        let (commands, inbox) = mpsc::unbounded_channel();
        let (view_tx, view) = watch::channel(PlaybackView::default());
        let task = handle.spawn(run(state, logger, inbox, view_tx, sinks, handle.clone()));
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
}

impl Drop for PlaybackFeed {
    fn drop(&mut self) {
        let _ = self.commands.send(PlaybackCommand::Stop);
        // The task ends on its own once it reads the stop.
        let _ = self.task.take();
    }
}

async fn run(
    mut state: watch::Receiver<BackendState>,
    logger: Logger,
    mut commands: mpsc::UnboundedReceiver<PlaybackCommand>,
    view: watch::Sender<PlaybackView>,
    mut sinks: CpuSinks,
    runtime: tokio::runtime::Handle,
) {
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
                    Some(PlaybackCommand::Sinks(next)) => sinks = next,
                    Some(_) => view.send_modify(|v| {
                        v.last_error = Some(ENGINE_NOT_CONNECTED.to_string());
                    }),
                }
            }
        };
        let exit = session(
            &bootstrap,
            &logger,
            &mut commands,
            &view,
            &mut sinks,
            state.clone(),
            &runtime,
        )
        .await;
        view.send_modify(|v| {
            v.connected = false;
            v.status = PlaybackStatus::closed(String::new());
        });
        match exit {
            Ok(Exit::Stop) => return,
            Ok(Exit::Disconnected(reason)) => logger.log(
                Level::Warn,
                &format!("[player] feed disconnected: {reason}"),
            ),
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
                    Some(PlaybackCommand::Sinks(next)) => sinks = next,
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

/// The ring the backend answered, if it has one yet.
fn ring_of(answer: Value) -> Option<videorc_protocol::PreviewCpuRing> {
    serde_json::from_value::<PreviewCpuRingStatus>(answer)
        .ok()
        .and_then(|status| status.ring)
}

async fn session(
    bootstrap: &BackendBootstrap,
    logger: &Logger,
    commands: &mut mpsc::UnboundedReceiver<PlaybackCommand>,
    view: &watch::Sender<PlaybackView>,
    sinks: &mut CpuSinks,
    mut state: watch::Receiver<BackendState>,
    runtime: &tokio::runtime::Handle,
) -> Result<Exit> {
    let control = BackendSocket::connect(
        &bootstrap.renderer(),
        Duration::from_secs(30),
        Duration::from_secs(30),
    )
    .await
    .context("the player's control socket")?;
    let ring_socket = BackendSocket::connect(
        &bootstrap.admin(),
        Duration::from_secs(30),
        Duration::from_secs(5),
    )
    .await
    .context("the player's ring socket")?;
    ring_socket.set_included_events(&[]).await?;
    control
        .set_included_events(&[PLAYBACK_STATUS_EVENT])
        .await?;
    // The ring is this socket's until it closes; it has no size (and no
    // `ring`) until the first frame of a playback is published.
    let opened = ring_socket
        .request(PLAYBACK_CPU_OPEN_METHOD, Value::Null)
        .await
        .context("playback.cpu.open")?;
    let telemetry = Arc::new(Mutex::new(Telemetry::default()));
    let (requests_tx, mut requests) = mpsc::unbounded_channel::<CpuRequest>();
    let source = CpuFrameSource::start(
        sinks.clone(),
        telemetry.clone(),
        logger.clone(),
        requests_tx,
        runtime.clone(),
    )
    .context("the player's frame reader")?;
    let mut ring_known = match ring_of(opened) {
        Some(ring) => {
            source.set_ring(Some(ring));
            true
        }
        None => false,
    };
    view.send_modify(|v| {
        v.connected = true;
        v.last_error = None;
    });
    let mut events = control.subscribe();
    let mut tick = tokio::time::interval(TICK);
    let outcome: Result<Exit> = loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else { break Ok(Exit::Stop) };
                let answer = match command {
                    PlaybackCommand::Stop => break Ok(Exit::Stop),
                    PlaybackCommand::Sinks(next) => {
                        *sinks = next;
                        source.set_sinks(sinks.clone());
                        continue;
                    }
                    PlaybackCommand::Open { session_id, max_width, max_height } => {
                        control
                            .call::<PlaybackOpen>(&PlaybackOpenParams {
                                session_id,
                                max_width,
                                max_height,
                            })
                            .await
                    }
                    PlaybackCommand::Play => control.call::<PlaybackPlay>(&()).await,
                    PlaybackCommand::Pause => control.call::<PlaybackPause>(&()).await,
                    PlaybackCommand::Seek(position_ms) => {
                        control.call::<PlaybackSeek>(&PlaybackSeekParams { position_ms }).await
                    }
                    PlaybackCommand::Mute(muted) => {
                        control.call::<PlaybackMute>(&PlaybackMuteParams { muted }).await
                    }
                    PlaybackCommand::Close => control.call::<PlaybackClose>(&()).await,
                };
                match answer {
                    Ok(status) => view.send_modify(|v| v.status = status),
                    Err(error) => {
                        logger.log(Level::Warn, &format!("[player] {error}"));
                        view.send_modify(|v| v.last_error = Some(error.to_string()));
                        if !control.is_open() {
                            break Ok(Exit::Disconnected(error.to_string()));
                        }
                    }
                }
            }
            event = events.recv() => match event {
                Ok(event) if event.event == PLAYBACK_STATUS_EVENT => {
                    if let Ok(status) = serde_json::from_value::<PlaybackStatus>(event.payload) {
                        view.send_modify(|v| v.status = status);
                    }
                }
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    break Ok(Exit::Disconnected("the control socket closed".into()));
                }
            },
            request = requests.recv() => {
                if matches!(request, Some(CpuRequest::Reopen)) {
                    // A new frame size is a new ring: map the current one.
                    match ring_socket.request(PLAYBACK_CPU_STATUS_METHOD, Value::Null).await {
                        Ok(answer) => {
                            let ring = ring_of(answer);
                            ring_known = ring.is_some();
                            source.set_ring(ring);
                        }
                        Err(error) => {
                            if !ring_socket.is_open() {
                                break Ok(Exit::Disconnected(error.to_string()));
                            }
                        }
                    }
                }
            }
            _ = tick.tick() => {
                let presented = telemetry
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .layer_presented;
                if presented != view.borrow().presented_frames {
                    view.send_modify(|v| {
                        v.presented_frames = presented;
                        v.presented_frame_id = presented;
                    });
                }
                // Before the first frame the ring has no size: ask again
                // once the backend has published one.
                if !ring_known && view.borrow().status.frames_published > 0 {
                    if let Ok(answer) =
                        ring_socket.request(PLAYBACK_CPU_STATUS_METHOD, Value::Null).await
                        && let Some(ring) = ring_of(answer)
                    {
                        source.set_ring(Some(ring));
                        ring_known = true;
                    }
                }
                if !control.is_open() || !ring_socket.is_open() {
                    break Ok(Exit::Disconnected("a player socket closed".into()));
                }
            }
            changed = state.changed() => {
                if changed.is_err() {
                    break Ok(Exit::Stop);
                }
                let same = state.borrow().bootstrap().is_some_and(|next| {
                    (next.pid, next.port, &next.token)
                        == (bootstrap.pid, bootstrap.port, &bootstrap.token)
                });
                if !same {
                    break Ok(Exit::Disconnected("a new backend".into()));
                }
            }
        }
    };
    if control.is_open() && view.borrow().is_open() {
        match control.call::<PlaybackClose>(&()).await {
            Ok(status) => view.send_modify(|v| v.status = status),
            Err(error) => logger.log(Level::Warn, &format!("[player] close: {error}")),
        }
    }
    // Joining the reader can wait for its frame wait: off the runtime.
    let _ = tokio::task::spawn_blocking(move || source.stop()).await;
    ring_socket.close().await;
    control.close().await;
    outcome
}

/// The player's element, owned by the UI thread: on Linux its own
/// presenter, which the Library page places on the player's slot.
// Windows keeps the placement for the presenter S2.3b brings.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub struct PlaybackElement {
    feed: Option<PlaybackFeed>,
    #[cfg(target_os = "linux")]
    presenter: Option<crate::linux::Presenter>,
    rect: Option<LayerRect>,
    scale: f64,
    visible: bool,
    logger: Logger,
}

impl PlaybackElement {
    pub fn start(
        handle: &tokio::runtime::Handle,
        state: watch::Receiver<BackendState>,
        logger: Logger,
    ) -> Result<Self, String> {
        let feed = PlaybackFeed::start(handle, state, logger.clone(), CpuSinks::default());
        Ok(Self {
            feed: Some(feed),
            #[cfg(target_os = "linux")]
            presenter: None,
            rect: None,
            scale: 1.0,
            visible: true,
            logger,
        })
    }

    /// Linux: builds the presenter's child in `window` (a subsurface under
    /// Wayland, a child window under X11), above GPUI's drawing, and hands
    /// it to the frame reader. Windows has no presenter yet: nothing to
    /// attach, the sound and the controls work without the picture.
    #[cfg(target_os = "linux")]
    pub fn attach(&mut self, window: &dyn crate::linux::NativeHost) -> Result<(), String> {
        self.presenter = None;
        let mut presenter =
            crate::linux::Presenter::attach_with(window, crate::linux::Stacking::AboveHost)?;
        presenter.set_hidden(!self.visible);
        if let Some(rect) = self.rect {
            presenter.set_placement(crate::linux::Placement {
                rect,
                scale: self.scale,
            });
        }
        let sinks = CpuSinks {
            presenter: Some(presenter.client()),
            ..CpuSinks::default()
        };
        self.presenter = Some(presenter);
        self.send(PlaybackCommand::Sinks(sinks));
        Ok(())
    }

    #[cfg(not(target_os = "linux"))]
    pub fn attach<W: ?Sized>(&mut self, _window: &W) -> Result<(), String> {
        Ok(())
    }

    /// Takes the child out of its window; the playback stays.
    pub fn detach(&mut self) {
        self.send(PlaybackCommand::Sinks(CpuSinks::default()));
        #[cfg(target_os = "linux")]
        {
            self.presenter = None;
        }
        self.rect = None;
    }

    pub fn attached(&self) -> bool {
        #[cfg(target_os = "linux")]
        {
            self.presenter.is_some()
        }
        #[cfg(not(target_os = "linux"))]
        {
            false
        }
    }

    /// The UI laid the slot out (window logical points, and the window's
    /// scale for X11): the child follows in the same pass. True when it
    /// moved.
    pub fn place(&mut self, rect: LayerRect, scale: f64) -> bool {
        self.rect = Some(rect);
        self.scale = scale;
        #[cfg(target_os = "linux")]
        if let Some(presenter) = self.presenter.as_mut() {
            return presenter.set_placement(crate::linux::Placement { rect, scale });
        }
        false
    }

    /// The host's visibility decision (no frame yet, the player closed).
    pub fn set_visible(&mut self, visible: bool) {
        self.visible = visible;
        #[cfg(target_os = "linux")]
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

    /// Stops everything: the playback is closed, the child removed.
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
    use serde_json::json;

    #[test]
    fn a_ring_is_read_only_once_the_backend_has_one() {
        assert!(ring_of(json!({ "open": true, "ringsCreated": 0, "framesWritten": 0 })).is_none());
        assert!(ring_of(json!(null)).is_none());
    }

    #[test]
    fn an_open_view_is_any_live_state() {
        let mut view = PlaybackView::default();
        assert!(!view.is_open());
        view.status.state = PlaybackState::Ended;
        assert!(view.is_open());
        view.status.state = PlaybackState::Failed;
        assert!(!view.is_open());
    }
}
