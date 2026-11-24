//! The typed client over `videorc-protocol` (plan 220 S2.1b): how the core
//! talks to the backend.
//!
//! - [`BackendClient`] follows the supervisor's [`BackendState`]: whenever a
//!   generation is ready it opens one socket on the **renderer** credential,
//!   applies the [`EventFilter`] (the backend keeps it per socket, so every
//!   connection gets it again), and publishes typed [`BackendEvent`]s. When
//!   the socket drops while the same backend runs, it reconnects after
//!   [`ENGINE_RECONNECT_DELAY`]; when the supervisor brings up a new
//!   generation, it moves to that one at once. That is what the Studio does
//!   in `use-studio.tsx` (`reconnectAfterEngineDrop`, and a new connection
//!   from main re-running the bootstrap effect).
//! - Requests go out typed ([`BackendClient::call`] with a [`methods`] pair)
//!   or untyped ([`BackendClient::request`] with a `serde_json::Value`), each
//!   within its method's deadline ([`timeouts`]). A request while no socket is
//!   open fails at once with `not-connected`, as `backendClient.ts` does.
//! - [`BackendSocket`] is one connection, usable alone (the spikes' preview
//!   session opens a control and a lease socket with it).
//!
//! The admin credential never reaches this client: frame leases and the
//! shutdown handshake are the supervisor's and the preview's business.

pub mod events;
pub mod methods;
pub mod socket;
pub mod timeouts;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Result, anyhow};
use serde_json::Value;
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;

pub use events::{
    BackendEvent, EventFilter, EventsLagged, RemoteIntentEnvelope, names, route_event,
};
pub use methods::Method;
pub use socket::{BackendSocket, RequestTimeouts, RpcError, SocketOptions, codes};
pub use videorc_protocol::{BackendConnection, ServerEvent};

use crate::log::Logger;
use crate::process::BackendBootstrap;
use crate::supervisor::BackendState;

/// `ENGINE_RECONNECT_DELAY_MS` in `use-studio.tsx`: how long after a dropped
/// socket the client tries the same backend again.
pub const ENGINE_RECONNECT_DELAY: Duration = Duration::from_millis(2_000);

const EVENT_CHANNEL_CAPACITY: usize = 1024;

/// How the client connects.
#[derive(Clone)]
pub struct ClientConfig {
    pub filter: EventFilter,
    /// For the WebSocket handshake and for `backend.ready`, each.
    pub ready_timeout: Duration,
    /// After a dropped socket or a failed connect, before the next try.
    pub reconnect_delay: Duration,
    pub logger: Logger,
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            filter: EventFilter::All,
            ready_timeout: Duration::from_secs(30),
            reconnect_delay: ENGINE_RECONNECT_DELAY,
            logger: Logger::silent(),
        }
    }
}

/// Where the client is. `generation` is the supervisor's backend generation.
#[derive(Debug, Clone)]
pub enum ConnectionState {
    /// No ready backend to connect to (starting, restarting, failed or
    /// stopped).
    WaitingForBackend,
    Connecting {
        generation: u32,
    },
    /// The socket is open and its event filter is in place.
    Connected {
        generation: u32,
        ready: BackendConnection,
    },
    /// The socket dropped or did not open; the client tries again.
    Disconnected {
        generation: u32,
        reason: String,
    },
    /// [`BackendClient::close`] ran, or the supervisor is gone.
    Closed,
}

impl ConnectionState {
    pub fn is_connected(&self) -> bool {
        matches!(self, ConnectionState::Connected { .. })
    }
}

struct Shared {
    socket: Mutex<Option<Arc<BackendSocket>>>,
    events: broadcast::Sender<BackendEvent>,
    state: watch::Sender<ConnectionState>,
    config: ClientConfig,
}

impl Shared {
    fn set_state(&self, state: ConnectionState) {
        // `send` would drop the value while nobody watches; the state must
        // hold anyway.
        self.state.send_replace(state);
    }

    fn current_socket(&self) -> Option<Arc<BackendSocket>> {
        self.socket.lock().ok().and_then(|socket| socket.clone())
    }

    fn replace_socket(&self, next: Option<Arc<BackendSocket>>) -> Option<Arc<BackendSocket>> {
        self.socket
            .lock()
            .map(|mut socket| std::mem::replace(&mut *socket, next))
            .unwrap_or(None)
    }

    fn emit(&self, event: BackendEvent) {
        // No subscriber is not an error.
        let _ = self.events.send(event);
    }
}

/// The core's connection to the backend. See the module docs.
pub struct BackendClient {
    shared: Arc<Shared>,
    stop: watch::Sender<bool>,
    task: Option<JoinHandle<()>>,
}

impl BackendClient {
    /// Starts following `backend` (the supervisor's state) on the current
    /// tokio runtime. The receiver it returns sees every event from the
    /// first connection on, `Ready` included; [`Self::subscribe`] adds more.
    pub fn start(
        backend: watch::Receiver<BackendState>,
        config: ClientConfig,
    ) -> (Self, broadcast::Receiver<BackendEvent>) {
        let (events, first) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let (state, _) = watch::channel(ConnectionState::WaitingForBackend);
        let shared = Arc::new(Shared {
            socket: Mutex::new(None),
            events,
            state,
            config,
        });
        let (stop, stop_rx) = watch::channel(false);
        let task = tokio::spawn(run(shared.clone(), backend, stop_rx));
        (
            Self {
                shared,
                stop,
                task: Some(task),
            },
            first,
        )
    }

    /// Every event from now on.
    pub fn subscribe(&self) -> broadcast::Receiver<BackendEvent> {
        self.shared.events.subscribe()
    }

    /// The connection state, as it changes.
    pub fn state(&self) -> watch::Receiver<ConnectionState> {
        self.shared.state.subscribe()
    }

    pub fn current_state(&self) -> ConnectionState {
        self.shared.state.borrow().clone()
    }

    /// Waits until a socket is open with its filter in place, or fails when
    /// the client closes or `timeout` passes.
    pub async fn wait_connected(&self, timeout: Duration) -> Result<BackendConnection> {
        let mut state = self.state();
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);
        loop {
            match &*state.borrow_and_update() {
                ConnectionState::Connected { ready, .. } => return Ok(ready.clone()),
                ConnectionState::Closed => return Err(anyhow!("the backend client is closed")),
                _ => {}
            }
            tokio::select! {
                changed = state.changed() => {
                    if changed.is_err() {
                        return Err(anyhow!("the backend client ended"));
                    }
                }
                _ = &mut deadline => {
                    return Err(anyhow!(
                        "not connected to the backend within {timeout:?} ({:?})",
                        self.current_state()
                    ));
                }
            }
        }
    }

    /// One typed request on the open socket.
    pub async fn call<M: Method>(&self, params: &M::Params) -> Result<M::Result, RpcError> {
        let socket = self
            .shared
            .current_socket()
            .ok_or_else(|| RpcError::not_connected(M::NAME))?;
        socket.call::<M>(params).await
    }

    /// One untyped request on the open socket, for the methods the
    /// [`methods`] module does not type.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let socket = self
            .shared
            .current_socket()
            .ok_or_else(|| RpcError::not_connected(method))?;
        socket.request(method, params).await
    }

    /// Closes the socket and stops reconnecting.
    pub async fn close(mut self) {
        let _ = self.stop.send(true);
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for BackendClient {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// Resolves when `stop` turns true or its sender is gone.
async fn stopped(stop: &mut watch::Receiver<bool>) {
    while !*stop.borrow_and_update() {
        if stop.changed().await.is_err() {
            return;
        }
    }
}

/// The ready generation to connect to, or `None` once the client stops or
/// the supervisor is gone.
async fn next_ready(
    shared: &Shared,
    backend: &mut watch::Receiver<BackendState>,
    stop: &mut watch::Receiver<bool>,
) -> Option<(u32, BackendBootstrap)> {
    loop {
        if *stop.borrow() {
            return None;
        }
        if let BackendState::Ready {
            generation,
            bootstrap,
        } = &*backend.borrow_and_update()
        {
            return Some((*generation, bootstrap.clone()));
        }
        if !matches!(*shared.state.borrow(), ConnectionState::WaitingForBackend) {
            shared.set_state(ConnectionState::WaitingForBackend);
        }
        tokio::select! {
            changed = backend.changed() => {
                if changed.is_err() {
                    return None;
                }
            }
            _ = stopped(stop) => return None,
        }
    }
}

/// Whether the supervisor still reports this exact backend as ready.
fn still_ready(
    backend: &watch::Receiver<BackendState>,
    generation: u32,
    bootstrap: &BackendBootstrap,
) -> bool {
    matches!(
        &*backend.borrow(),
        BackendState::Ready { generation: current, bootstrap: current_bootstrap }
            if *current == generation && current_bootstrap == bootstrap
    )
}

/// Waits `delay` unless the backend changes or the client stops first.
/// `false` means stop.
async fn pause(
    delay: Duration,
    backend: &mut watch::Receiver<BackendState>,
    stop: &mut watch::Receiver<bool>,
) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(delay) => true,
        changed = backend.changed() => changed.is_ok(),
        _ = stopped(stop) => false,
    }
}

async fn connect(
    shared: &Shared,
    bootstrap: &BackendBootstrap,
) -> Result<(BackendSocket, BackendConnection)> {
    let config = &shared.config;
    let socket = BackendSocket::connect_with(
        &bootstrap.renderer(),
        SocketOptions {
            ready_timeout: config.ready_timeout,
            timeouts: RequestTimeouts::PerMethod,
            logger: config.logger.clone(),
        },
    )
    .await?;
    let ready = socket.ready_connection()?;
    if let Err(error) = socket.apply_filter(&config.filter).await {
        socket.close().await;
        return Err(anyhow!("could not set the event filter: {error}"));
    }
    Ok((socket, ready))
}

enum Ended {
    /// The socket dropped on its own: try the same backend again later.
    Dropped(String),
    /// The supervisor moved on (a new generation, or none): follow it now.
    BackendChanged,
    Stop,
}

async fn run(
    shared: Arc<Shared>,
    mut backend: watch::Receiver<BackendState>,
    mut stop: watch::Receiver<bool>,
) {
    let logger = shared.config.logger.clone();
    let reconnect_delay = shared.config.reconnect_delay;
    loop {
        let Some((generation, bootstrap)) = next_ready(&shared, &mut backend, &mut stop).await
        else {
            break;
        };
        shared.set_state(ConnectionState::Connecting { generation });
        let connected = tokio::select! {
            connected = connect(&shared, &bootstrap) => connected,
            _ = stopped(&mut stop) => break,
        };
        let (socket, ready) = match connected {
            Ok(connected) => connected,
            Err(error) => {
                let reason = format!("{error:#}");
                logger.warn(format!(
                    "Could not connect to backend generation {generation}: {reason}"
                ));
                shared.set_state(ConnectionState::Disconnected { generation, reason });
                if !pause(reconnect_delay, &mut backend, &mut stop).await {
                    break;
                }
                continue;
            }
        };
        let socket = Arc::new(socket);
        // Everything since `backend.ready`, including what arrived before the
        // filter landed.
        let mut wire = socket
            .take_initial_events()
            .unwrap_or_else(|| socket.subscribe());
        shared.replace_socket(Some(socket.clone()));
        logger.info(format!(
            "Connected to backend generation {generation} (pid {}) on {}:{}.",
            ready.pid, ready.host, ready.port
        ));
        shared.set_state(ConnectionState::Connected {
            generation,
            ready: ready.clone(),
        });
        shared.emit(BackendEvent::Ready(ready));

        let mut untyped_seen = HashSet::new();
        let ended = loop {
            tokio::select! {
                biased;
                _ = stopped(&mut stop) => break Ended::Stop,
                received = wire.recv() => match received {
                    Ok(event) => shared.emit(route_event(event, &logger, &mut untyped_seen)),
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        logger.warn(format!(
                            "The backend client fell {skipped} event(s) behind; state built from events must be read again."
                        ));
                        shared.emit(BackendEvent::ClientLagged { skipped });
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        break Ended::Dropped(socket.wait_closed().await);
                    }
                },
                reason = socket.wait_closed() => {
                    // Deliver what arrived before the close.
                    while let Ok(event) = wire.try_recv() {
                        shared.emit(route_event(event, &logger, &mut untyped_seen));
                    }
                    break Ended::Dropped(reason);
                }
                changed = backend.changed() => {
                    if changed.is_err() {
                        break Ended::Stop;
                    }
                    if !still_ready(&backend, generation, &bootstrap) {
                        break Ended::BackendChanged;
                    }
                }
            }
        };

        shared.replace_socket(None);
        let reason = match &ended {
            Ended::Dropped(reason) => reason.clone(),
            Ended::BackendChanged => format!("engine generation {generation} is no longer ready"),
            Ended::Stop => "the client closed".to_string(),
        };
        socket.close().await;
        shared.emit(BackendEvent::ConnectionClosed {
            reason: reason.clone(),
        });
        match ended {
            Ended::Stop => break,
            Ended::BackendChanged => {
                logger.info(format!("Left backend generation {generation}: {reason}."));
                shared.set_state(ConnectionState::Disconnected { generation, reason });
            }
            Ended::Dropped(_) => {
                logger.warn(format!(
                    "The connection to backend generation {generation} dropped ({reason}); reconnecting in {} ms.",
                    reconnect_delay.as_millis()
                ));
                shared.set_state(ConnectionState::Disconnected { generation, reason });
                if !pause(reconnect_delay, &mut backend, &mut stop).await {
                    break;
                }
            }
        }
    }
    if let Some(socket) = shared.replace_socket(None) {
        socket.close().await;
    }
    shared.set_state(ConnectionState::Closed);
}

#[cfg(test)]
mod tests;
