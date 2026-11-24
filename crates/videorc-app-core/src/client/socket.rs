//! One WebSocket connection to the backend, like one `BackendClient` socket
//! in the renderer (`apps/desktop/src/renderer/src/backendClient.ts`) and the
//! event socket in Electron main. Moved here from `videorc-dev-client` in
//! plan 220 S2.1b; the dev client and the spikes use it from here.
//!
//! Wire shapes (`videorc_protocol::{ServerResponse, ServerEvent}`):
//!
//! - command: `{"id": "<uuid>", "method": "...", "params": {...}}` (no
//!   `params` when there are none, as the renderer sends `request(method)`)
//! - response: `{"id": "...", "ok": true, "payload": ...}` or
//!   `{"id": "...", "ok": false, "error": {"code": "...", "message": "..."}}`
//! - event: `{"event": "...", "payload": ...}`
//!
//! The backend sends `backend.ready` (the renderer credential) first on every
//! loopback socket; [`BackendSocket::connect`] waits for it.
//! `events.setIncluded` / `events.setExcluded` are connection-scoped filters.
//!
//! Deadlines are per method ([`super::timeouts::backend_request_timeout`])
//! unless the socket was opened with a uniform one (the spikes' lease socket).
//! A request that timed out or lost its socket after it was sent fails with
//! `request-outcome-unknown`, as in `backendClient.ts`: the backend may still
//! have done it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use videorc_protocol::{BackendConnection, ServerEvent, ServerResponse};

use super::events::EventFilter;
use super::methods::{EventListParams, EventsSetExcluded, EventsSetIncluded, Method};
use super::timeouts::backend_request_timeout;
use crate::log::Logger;
use crate::process::Credential;

const EVENT_CHANNEL_CAPACITY: usize = 1024;
const OUTGOING_CHANNEL_CAPACITY: usize = 256;
/// `MAX_BACKEND_WIRE_MESSAGE_CHARS` in `backend-rpc-contract.ts`.
const MAX_WIRE_MESSAGE_BYTES: usize = 16_000_000;

/// Error codes this client produces itself (the backend's own codes pass
/// through unchanged).
pub mod codes {
    /// The request was sent and then timed out or lost its socket: the
    /// backend may or may not have done it. Reconcile from a status read,
    /// never assume a rollback.
    pub const REQUEST_OUTCOME_UNKNOWN: &str = "request-outcome-unknown";
    /// No connection is open (`ENGINE_NOT_CONNECTED`).
    pub const NOT_CONNECTED: &str = "not-connected";
    /// The socket closed before the request was sent.
    pub const CONNECTION_CLOSED: &str = "connection-closed";
    /// The request timed out before it was sent.
    pub const NOT_SENT: &str = "request-not-sent";
    /// The params could not be encoded.
    pub const INVALID_PARAMS: &str = "invalid-params";
    /// The answer did not match the method's result type.
    pub const INVALID_RESPONSE: &str = "invalid-response";
    /// The backend refused without a code (`backendClient.ts`' default).
    pub const BACKEND_REQUEST_FAILED: &str = "backend-request-failed";
}

/// `ENGINE_NOT_CONNECTED`.
pub const ENGINE_NOT_CONNECTED: &str = "Videorc's engine isn't connected.";
/// `ENGINE_CONNECTION_CLOSED`.
pub const ENGINE_CONNECTION_CLOSED: &str = "Videorc's engine connection closed.";

/// A failed request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcError {
    pub method: String,
    pub code: String,
    pub message: String,
}

impl RpcError {
    pub fn new(method: &str, code: &str, message: impl Into<String>) -> Self {
        Self {
            method: method.to_string(),
            code: code.to_string(),
            message: message.into(),
        }
    }

    pub fn not_connected(method: &str) -> Self {
        Self::new(method, codes::NOT_CONNECTED, ENGINE_NOT_CONNECTED)
    }

    /// The backend may have done it; read the state before acting again.
    pub fn is_outcome_unknown(&self) -> bool {
        self.code == codes::REQUEST_OUTCOME_UNKNOWN
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} failed: {} ({})",
            self.method, self.message, self.code
        )
    }
}

impl std::error::Error for RpcError {}

/// How long requests may take.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RequestTimeouts {
    /// `backendRequestTimeoutMs`: each method its own deadline.
    #[default]
    PerMethod,
    /// One deadline for every request (the spikes' 2 s lease socket).
    Uniform(Duration),
}

impl RequestTimeouts {
    pub fn for_method(self, method: &str) -> Duration {
        match self {
            RequestTimeouts::PerMethod => backend_request_timeout(method),
            RequestTimeouts::Uniform(timeout) => timeout,
        }
    }
}

/// How to open a socket.
#[derive(Clone)]
pub struct SocketOptions {
    /// For the WebSocket handshake and for `backend.ready`, each.
    pub ready_timeout: Duration,
    pub timeouts: RequestTimeouts,
    /// Unreadable messages are logged here (`Logger::silent()` drops them).
    pub logger: Logger,
}

impl Default for SocketOptions {
    fn default() -> Self {
        Self {
            ready_timeout: Duration::from_secs(30),
            timeouts: RequestTimeouts::PerMethod,
            logger: Logger::silent(),
        }
    }
}

struct Pending {
    method: String,
    /// The command reached the writer (`PendingRequest.sent`).
    sent: bool,
    tx: oneshot::Sender<Result<Value, RpcError>>,
}

type PendingMap = Arc<Mutex<HashMap<String, Pending>>>;

/// The outgoing command envelope.
#[derive(Serialize)]
struct Command<'a> {
    id: &'a str,
    method: &'a str,
    #[serde(skip_serializing_if = "Value::is_null")]
    params: Value,
}

pub struct BackendSocket {
    credential: Credential,
    /// `None` once `close` took it: the writer ends when every sender is gone.
    outgoing: Mutex<Option<mpsc::Sender<Message>>>,
    pending: PendingMap,
    events: broadcast::Sender<ServerEvent>,
    /// Holds every event since `backend.ready` until someone takes it
    /// ([`Self::take_initial_events`]), so none is lost between the
    /// handshake and the first subscriber.
    initial_events: Mutex<Option<broadcast::Receiver<ServerEvent>>>,
    closed: watch::Receiver<Option<String>>,
    reader: JoinHandle<()>,
    writer: Mutex<Option<JoinHandle<()>>>,
    timeouts: RequestTimeouts,
    /// The `backend.ready` payload: `{host, port, token, pid, ...}`.
    pub ready: Value,
}

impl BackendSocket {
    /// Connects and waits for `backend.ready`; every request gets
    /// `request_timeout` (the spikes' original contract).
    pub async fn connect(
        credential: &Credential,
        ready_timeout: Duration,
        request_timeout: Duration,
    ) -> Result<Self> {
        Self::connect_with(
            credential,
            SocketOptions {
                ready_timeout,
                timeouts: RequestTimeouts::Uniform(request_timeout),
                logger: Logger::silent(),
            },
        )
        .await
    }

    /// Connects and waits for `backend.ready`.
    pub async fn connect_with(credential: &Credential, options: SocketOptions) -> Result<Self> {
        let SocketOptions {
            ready_timeout,
            timeouts,
            logger,
        } = options;
        let url = credential.websocket_url();
        let (stream, _response) = tokio::time::timeout(
            ready_timeout,
            tokio_tungstenite::connect_async(url.as_str()),
        )
        .await
        .map_err(|_| {
            anyhow!(
                "websocket connect to {}:{} timed out",
                credential.host,
                credential.port
            )
        })?
        .with_context(|| {
            format!(
                "websocket connect to {}:{} failed",
                credential.host, credential.port
            )
        })?;
        let (mut sink, mut source) = stream.split();

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (events, mut ready_rx) = broadcast::channel::<ServerEvent>(EVENT_CHANNEL_CAPACITY);
        let initial_rx = events.subscribe();
        let (closed_tx, closed) = watch::channel(None::<String>);
        let (outgoing, mut outgoing_rx) = mpsc::channel::<Message>(OUTGOING_CHANNEL_CAPACITY);

        let writer = tokio::spawn(async move {
            while let Some(message) = outgoing_rx.recv().await {
                if sink.send(message).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });

        let reader = {
            let pending = pending.clone();
            let events = events.clone();
            tokio::spawn(async move {
                let reason = loop {
                    match source.next().await {
                        Some(Ok(Message::Text(text))) => {
                            if let Err(problem) = route_text(text.as_str(), &pending, &events) {
                                logger.warn(format!(
                                    "Videorc's engine sent an unreadable message ({problem})."
                                ));
                            }
                        }
                        Some(Ok(Message::Binary(_)))
                        | Some(Ok(Message::Ping(_)))
                        | Some(Ok(Message::Pong(_)))
                        | Some(Ok(Message::Frame(_))) => {}
                        Some(Ok(Message::Close(frame))) => {
                            break format!(
                                "the engine closed the connection{}",
                                frame
                                    .map(|frame| format!(": {} {}", frame.code, frame.reason))
                                    .unwrap_or_default()
                            );
                        }
                        Some(Err(error)) => {
                            break format!("reading the connection failed: {error}");
                        }
                        None => break "the connection ended".to_string(),
                    }
                };
                let waiters: Vec<_> = pending
                    .lock()
                    .map(|mut pending| pending.drain().collect())
                    .unwrap_or_default();
                for (_, waiter) in waiters {
                    let error = if waiter.sent {
                        outcome_unknown(&waiter.method, "lost its connection")
                    } else {
                        RpcError::new(
                            &waiter.method,
                            codes::CONNECTION_CLOSED,
                            ENGINE_CONNECTION_CLOSED,
                        )
                    };
                    let _ = waiter.tx.send(Err(error));
                }
                let _ = closed_tx.send(Some(reason));
            })
        };

        let mut socket = Self {
            credential: credential.clone(),
            outgoing: Mutex::new(Some(outgoing)),
            pending,
            events,
            initial_events: Mutex::new(Some(initial_rx)),
            closed,
            reader,
            writer: Mutex::new(Some(writer)),
            timeouts,
            ready: Value::Null,
        };

        socket.ready = loop {
            match tokio::time::timeout(ready_timeout, ready_rx.recv()).await {
                Ok(Ok(event)) if event.event == "backend.ready" => break event.payload,
                Ok(Ok(_)) => continue,
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(broadcast::error::RecvError::Closed)) => {
                    bail!(
                        "the socket closed before backend.ready: {}",
                        socket.closed_reason().unwrap_or_default()
                    )
                }
                Err(_) => {
                    // The reader may have ended (the backend refused us).
                    bail!(
                        "backend.ready did not arrive within {ready_timeout:?}{}",
                        socket
                            .closed_reason()
                            .map(|reason| format!(": {reason}"))
                            .unwrap_or_default()
                    )
                }
            }
        };
        // The initial receiver starts after `backend.ready`: drop what led
        // up to it (the ready event itself).
        if let Ok(mut initial) = socket.initial_events.lock()
            && let Some(rx) = initial.as_mut()
        {
            while let Ok(event) = rx.try_recv() {
                if event.event == "backend.ready" {
                    break;
                }
            }
        }
        Ok(socket)
    }

    pub fn credential(&self) -> &Credential {
        &self.credential
    }

    /// The typed `backend.ready` payload.
    pub fn ready_connection(&self) -> Result<BackendConnection> {
        serde_json::from_value(self.ready.clone()).context("backend.ready has an unexpected shape")
    }

    /// Why the socket closed, once it has.
    pub fn closed_reason(&self) -> Option<String> {
        self.closed.borrow().clone()
    }

    pub fn is_open(&self) -> bool {
        self.closed_reason().is_none()
    }

    /// Waits until the socket closes; returns why.
    pub async fn wait_closed(&self) -> String {
        let mut closed = self.closed.clone();
        loop {
            if let Some(reason) = closed.borrow_and_update().clone() {
                return reason;
            }
            if closed.changed().await.is_err() {
                return self
                    .closed_reason()
                    .unwrap_or_else(|| "the connection's reader ended".to_string());
            }
        }
    }

    /// Every event this socket's filter lets through, from now on. A slow
    /// subscriber lags (`RecvError::Lagged`) instead of stalling the reader.
    pub fn subscribe(&self) -> broadcast::Receiver<ServerEvent> {
        self.events.subscribe()
    }

    /// Every event since `backend.ready`, for the first taker; `None` after.
    pub fn take_initial_events(&self) -> Option<broadcast::Receiver<ServerEvent>> {
        self.initial_events.lock().ok().and_then(|mut rx| rx.take())
    }

    /// The deadline `method` gets on this socket.
    pub fn timeout_for(&self, method: &str) -> Duration {
        self.timeouts.for_method(method)
    }

    /// Sends one command and waits for its response, within the method's
    /// deadline.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.request_with_timeout(method, params, self.timeout_for(method))
            .await
    }

    /// Sends one command and waits for its response, within `timeout`.
    pub async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        if self.closed_reason().is_some() {
            return Err(RpcError::not_connected(method));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let text = serde_json::to_string(&Command {
            id: &id,
            method,
            params,
        })
        .map_err(|error| RpcError::new(method, codes::INVALID_PARAMS, error.to_string()))?;
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| RpcError::new(method, codes::NOT_SENT, "the pending map is poisoned"))?
            .insert(
                id.clone(),
                Pending {
                    method: method.to_string(),
                    sent: false,
                    tx,
                },
            );
        // One deadline for the whole request, sending included.
        let deadline = tokio::time::Instant::now() + timeout;
        let outgoing = self
            .outgoing
            .lock()
            .ok()
            .and_then(|outgoing| outgoing.clone());
        let Some(outgoing) = outgoing else {
            self.forget(&id);
            return Err(RpcError::new(
                method,
                codes::CONNECTION_CLOSED,
                ENGINE_CONNECTION_CLOSED,
            ));
        };
        match tokio::time::timeout_at(deadline, outgoing.send(Message::text(text))).await {
            Ok(Ok(())) => {
                if let Ok(mut pending) = self.pending.lock()
                    && let Some(entry) = pending.get_mut(&id)
                {
                    entry.sent = true;
                }
            }
            Ok(Err(_)) => {
                self.forget(&id);
                return Err(RpcError::new(
                    method,
                    codes::CONNECTION_CLOSED,
                    ENGINE_CONNECTION_CLOSED,
                ));
            }
            Err(_) => {
                self.forget(&id);
                return Err(RpcError::new(
                    method,
                    codes::NOT_SENT,
                    format!("The \"{method}\" request timed out before it was sent."),
                ));
            }
        }
        match tokio::time::timeout_at(deadline, rx).await {
            Ok(Ok(result)) => result.map_err(|mut error| {
                error.method = method.to_string();
                error
            }),
            Ok(Err(_)) => Err(outcome_unknown(method, "lost its connection")),
            Err(_) => {
                self.forget(&id);
                Err(outcome_unknown(
                    method,
                    &format!(
                        "timed out after {} ms after it was sent",
                        timeout.as_millis()
                    ),
                ))
            }
        }
    }

    /// One typed request: `M`'s params out, `M`'s result back.
    pub async fn call<M: Method>(&self, params: &M::Params) -> Result<M::Result, RpcError> {
        let params = serde_json::to_value(params)
            .map_err(|error| RpcError::new(M::NAME, codes::INVALID_PARAMS, error.to_string()))?;
        let payload = self.request(M::NAME, params).await?;
        decode_result::<M>(payload)
    }

    /// Restricts this socket's events to `events` (an empty list mutes it).
    pub async fn set_included_events(&self, events: &[&str]) -> Result<(), RpcError> {
        self.call::<EventsSetIncluded>(&EventListParams {
            events: events.iter().map(|event| event.to_string()).collect(),
        })
        .await
        .map(|_| ())
    }

    /// Applies `filter` to this socket. [`EventFilter::All`] clears both
    /// lists, so a reused socket hears everything again.
    pub async fn apply_filter(&self, filter: &EventFilter) -> Result<(), RpcError> {
        match filter {
            EventFilter::All => {
                self.call::<EventsSetExcluded>(&EventListParams::default())
                    .await?;
            }
            EventFilter::Include(events) => {
                self.call::<EventsSetIncluded>(&EventListParams {
                    events: events.clone(),
                })
                .await?;
            }
            EventFilter::Exclude(events) => {
                self.call::<EventsSetExcluded>(&EventListParams {
                    events: events.clone(),
                })
                .await?;
            }
        }
        Ok(())
    }

    /// Sends a Close frame and lets the writer finish before the reader goes.
    pub async fn close(&self) {
        let outgoing = self.outgoing.lock().ok().and_then(|mut slot| slot.take());
        if let Some(outgoing) = outgoing {
            let _ = outgoing.send(Message::Close(None)).await;
        }
        let writer = self.writer.lock().ok().and_then(|mut slot| slot.take());
        if let Some(writer) = writer {
            let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
        }
        self.reader.abort();
    }

    fn forget(&self, id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(id);
        }
    }
}

impl Drop for BackendSocket {
    fn drop(&mut self) {
        self.reader.abort();
        if let Some(writer) = self.writer.get_mut().ok().and_then(|slot| slot.take()) {
            writer.abort();
        }
    }
}

fn outcome_unknown(method: &str, detail: &str) -> RpcError {
    RpcError::new(
        method,
        codes::REQUEST_OUTCOME_UNKNOWN,
        format!("The \"{method}\" request {detail}; its outcome is unknown."),
    )
}

/// `M`'s result from a response payload (`validateBackendRpcResult`).
pub fn decode_result<M: Method>(payload: Value) -> Result<M::Result, RpcError> {
    serde_json::from_value::<M::Result>(payload).map_err(|error| {
        RpcError::new(
            M::NAME,
            codes::INVALID_RESPONSE,
            format!(
                "Videorc's engine answered \"{}\" with an unexpected shape: {error}",
                M::NAME
            ),
        )
    })
}

/// Routes one text frame: a response to its waiter, an event to the
/// subscribers. `Err` names what was unreadable; the socket carries on.
fn route_text(
    text: &str,
    pending: &PendingMap,
    events: &broadcast::Sender<ServerEvent>,
) -> Result<(), String> {
    if text.len() > MAX_WIRE_MESSAGE_BYTES {
        return Err(format!("{} bytes is over the limit", text.len()));
    }
    let value: Value = serde_json::from_str(text).map_err(|error| format!("not JSON: {error}"))?;
    if value.get("event").is_some() {
        let event: ServerEvent = serde_json::from_value(value)
            .map_err(|error| format!("bad event envelope: {error}"))?;
        // No subscriber is not an error: the lease socket mutes itself.
        let _ = events.send(event);
        return Ok(());
    }
    let response: ServerResponse =
        serde_json::from_value(value).map_err(|error| format!("bad response envelope: {error}"))?;
    let Some(waiter) = pending
        .lock()
        .ok()
        .and_then(|mut pending| pending.remove(&response.id))
    else {
        // Answered after its deadline, or not ours.
        return Ok(());
    };
    let result = if response.ok {
        Ok(response.payload.unwrap_or(Value::Null))
    } else {
        let (code, message) = match response.error {
            Some(error) => (error.code, error.message),
            None => (
                codes::BACKEND_REQUEST_FAILED.to_string(),
                "Videorc's engine couldn't do that.".to_string(),
            ),
        };
        Err(RpcError {
            method: waiter.method.clone(),
            code,
            message,
        })
    };
    let _ = waiter.tx.send(result);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending_entry(pending: &PendingMap, id: &str) -> oneshot::Receiver<Result<Value, RpcError>> {
        let (tx, rx) = oneshot::channel();
        pending.lock().unwrap().insert(
            id.to_string(),
            Pending {
                method: "m".to_string(),
                sent: true,
                tx,
            },
        );
        rx
    }

    #[test]
    fn responses_and_events_route_by_shape() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (events, mut event_rx) = broadcast::channel(4);
        let rx = pending_entry(&pending, "a");

        route_text(
            r#"{"event":"backend.ready","payload":{"port":1}}"#,
            &pending,
            &events,
        )
        .unwrap();
        assert_eq!(event_rx.try_recv().unwrap().event, "backend.ready");

        route_text(
            r#"{"id":"a","ok":true,"payload":{"x":1}}"#,
            &pending,
            &events,
        )
        .unwrap();
        assert_eq!(rx.blocking_recv().unwrap().unwrap()["x"], 1);
        assert!(pending.lock().unwrap().is_empty());

        let rx = pending_entry(&pending, "b");
        route_text(
            r#"{"id":"b","ok":false,"error":{"code":"forbidden","message":"no"}}"#,
            &pending,
            &events,
        )
        .unwrap();
        let error = rx.blocking_recv().unwrap().unwrap_err();
        assert_eq!(error.code, "forbidden");
        assert_eq!(error.message, "no");
        assert_eq!(error.method, "m");

        // A null payload is a null result, not a missing one.
        let rx = pending_entry(&pending, "c");
        route_text(r#"{"id":"c","ok":true,"payload":null}"#, &pending, &events).unwrap();
        assert!(rx.blocking_recv().unwrap().unwrap().is_null());

        // Unknown ids are ignored; garbage is reported, never a panic.
        route_text(r#"{"id":"zzz","ok":true}"#, &pending, &events).unwrap();
        assert!(route_text("not json", &pending, &events).is_err());
        assert!(route_text(r#"{"event":"x"}"#, &pending, &events).is_err());
        assert!(route_text(r#"{"ok":true}"#, &pending, &events).is_err());
    }

    #[test]
    fn commands_omit_absent_params() {
        let bare = serde_json::to_string(&Command {
            id: "1",
            method: "recording.status",
            params: Value::Null,
        })
        .unwrap();
        assert_eq!(bare, r#"{"id":"1","method":"recording.status"}"#);
        let with = serde_json::to_string(&Command {
            id: "2",
            method: "ui.settings.get",
            params: serde_json::json!({}),
        })
        .unwrap();
        assert_eq!(with, r#"{"id":"2","method":"ui.settings.get","params":{}}"#);
    }

    #[test]
    fn uniform_timeouts_override_the_table() {
        assert_eq!(
            RequestTimeouts::Uniform(Duration::from_secs(2)).for_method("session.start"),
            Duration::from_secs(2)
        );
        assert_eq!(
            RequestTimeouts::PerMethod.for_method("session.start"),
            Duration::from_secs(120)
        );
    }

    #[test]
    fn a_result_that_does_not_fit_is_an_invalid_response() {
        use super::super::methods::HealthPing;
        let error = decode_result::<HealthPing>(serde_json::json!({"entries": 3})).unwrap_err();
        assert_eq!(error.code, codes::INVALID_RESPONSE);
        assert_eq!(error.method, "health.ping");
    }
}
