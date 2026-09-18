//! Phone remote listener: the ONLY socket Videorc binds off-loopback.
//!
//! This is deliberately its own `Router`. The main backend router also serves
//! preview frames, session posters, compositor status, and OAuth callbacks;
//! none of that may ever be reachable from the network, and a separate router
//! makes that structural instead of a per-route promise. The listener exists
//! only while Phone remote is enabled — disabled means the port is closed.
//!
//! Auth and framing live in `remote_lan.rs`; after the handshake the socket
//! joins the normal websocket session as `BackendRole::Remote` (hard method
//! allowlist, locked event filter). Renderer and admin tokens mean nothing
//! here: this handler never consults them.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::Ordering;
use std::time::Instant;

use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::{Deserialize, Serialize};

use crate::backend_authority::BackendRole;
use crate::remote_lan::{
    self, ClientHello, HandshakeError, LAN_PORT_SCAN, LAN_PREFERRED_PORT, LAN_PROTOCOL, LanCut,
    LanSession, MAX_FRAME_BYTES, MAX_LAN_CLIENTS, MAX_PRE_AUTH_FRAME_BYTES, SessionVerifier,
};
use crate::state::AppState;

const INDEX_HTML: &str = include_str!("../remote_web/index.html");
const APP_JS: &str = include_str!("../remote_web/app.js");
const APP_CSS: &str = include_str!("../remote_web/app.css");
const REMOTE_CLIENT_JS: &str = include_str!("../remote_web/remote-client.js");
const HMAC_JS: &str = include_str!("../remote_web/hmac.js");
const MANIFEST: &str = include_str!("../remote_web/manifest.webmanifest");
const ICON_SVG: &str = include_str!("../remote_web/icon.svg");

/// Same-origin only, no third-party requests, no framing. `ws:` is spelled
/// out because older WebKit does not fold websockets into `'self'`.
const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; connect-src 'self' ws:; \
     img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; \
     form-action 'none'; frame-ancestors 'none'";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLanDeviceStatus {
    pub id: String,
    pub name: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
    pub connected: bool,
}

/// Renderer/admin-only. Carries no key material: device keys never leave the
/// backend, and the pairing URL is returned only by `remote.lan.pairing.begin`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLanStatus {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    pub addresses: Vec<String>,
    pub devices: Vec<RemoteLanDeviceStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bind_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pairing_expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLanPairing {
    pub url: String,
    pub address: String,
    pub addresses: Vec<String>,
    pub expires_at: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginPairingParams {
    #[serde(default)]
    pub address: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceParams {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
}

pub fn status(state: &AppState) -> RemoteLanStatus {
    let mut runtime = state
        .remote_lan
        .runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let pairing_expires_at = runtime
        .live_pairing(Instant::now())
        .map(|ticket| ticket.expires_at_wall.to_rfc3339());
    RemoteLanStatus {
        enabled: runtime.persisted.enabled,
        port: runtime.bound_port,
        addresses: if runtime.persisted.enabled {
            remote_lan::lan_addresses()
        } else {
            Vec::new()
        },
        devices: runtime
            .persisted
            .devices
            .iter()
            .map(|device| RemoteLanDeviceStatus {
                id: device.id.clone(),
                name: device.name.clone(),
                created_at: device.created_at.clone(),
                last_seen_at: device.last_seen_at.clone(),
                connected: runtime.connected.get(&device.id).copied().unwrap_or(0) > 0,
            })
            .collect(),
        bind_error: runtime.bind_error.clone(),
        pairing_expires_at,
    }
}

fn publish_status(state: &AppState) -> RemoteLanStatus {
    let status = status(state);
    state.emit_event("remote.lan.status", status.clone());
    status
}

fn persist(state: &AppState) -> anyhow::Result<()> {
    let persisted = state
        .remote_lan
        .runtime
        .lock()
        .map_err(|_| anyhow::anyhow!("Phone remote state unavailable."))?
        .persisted
        .clone();
    persisted.persist()
}

async fn bind_lan_listener(preferred: u16) -> Result<tokio::net::TcpListener, String> {
    let mut candidates = vec![preferred];
    candidates.extend(
        (LAN_PREFERRED_PORT..LAN_PREFERRED_PORT + LAN_PORT_SCAN).filter(|port| *port != preferred),
    );
    let mut last_error = String::new();
    for port in &candidates {
        match tokio::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, *port)).await {
            Ok(listener) => return Ok(listener),
            Err(error) => last_error = error.to_string(),
        }
    }
    // Explicit failure, never a silent random port: a bookmark or home-screen
    // icon can only ever find a stable one.
    Err(format!(
        "Ports {}–{} are all in use ({last_error}). Quit the app using them and turn Phone remote on again.",
        LAN_PREFERRED_PORT,
        LAN_PREFERRED_PORT + LAN_PORT_SCAN - 1
    ))
}

/// Bind and serve if Phone remote is enabled. Idempotent.
pub async fn start_if_enabled(state: &AppState) {
    let (enabled, preferred) = {
        let runtime = state
            .remote_lan
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (
            runtime.persisted.enabled && runtime.bound_port.is_none(),
            runtime.persisted.port.unwrap_or(LAN_PREFERRED_PORT),
        )
    };
    let remote_control_enabled = state
        .remote_control
        .lock()
        .map(|runtime| runtime.enabled)
        .unwrap_or(false);
    if !enabled || !remote_control_enabled {
        return;
    }
    match bind_lan_listener(preferred).await {
        Ok(listener) => {
            let port = listener
                .local_addr()
                .map(|addr| addr.port())
                .unwrap_or(preferred);
            let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
            let port_changed = {
                let mut runtime = state
                    .remote_lan
                    .runtime
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                runtime.bound_port = Some(port);
                runtime.bind_error = None;
                let changed = runtime.persisted.port != Some(port);
                runtime.persisted.port = Some(port);
                changed
            };
            if let Ok(mut server) = state.remote_lan.server.lock() {
                *server = Some(shutdown_tx);
            }
            if port_changed && let Err(error) = persist(state) {
                tracing::warn!("Could not persist the phone-remote port: {error:#}");
            }
            let app = lan_router(state.clone());
            let serve_state = state.clone();
            tokio::spawn(async move {
                let served = axum::serve(
                    listener,
                    app.into_make_service_with_connect_info::<SocketAddr>(),
                )
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
                if let Err(error) = &served {
                    tracing::warn!("Phone remote listener failed: {error}");
                }
                // A clean shutdown was already accounted for by `stop` — and a
                // fast off/on may have re-bound the port by now. Only a serve
                // FAILURE clears the live port here.
                if served.is_err()
                    && let Ok(mut runtime) = serve_state.remote_lan.runtime.lock()
                    && runtime.bound_port == Some(port)
                {
                    runtime.bound_port = None;
                }
            });
            state.emit_log("info", format!("Phone remote listening on port {port}."));
        }
        Err(message) => {
            state.emit_log("warn", format!("Phone remote could not start: {message}"));
            if let Ok(mut runtime) = state.remote_lan.runtime.lock() {
                runtime.bind_error = Some(message);
            }
        }
    }
}

/// Close the port and cut every phone. Does not change the persisted toggle.
pub fn stop(state: &AppState) {
    if let Ok(mut server) = state.remote_lan.server.lock()
        && let Some(shutdown) = server.take()
    {
        let _ = shutdown.send(());
    }
    if let Ok(mut runtime) = state.remote_lan.runtime.lock() {
        runtime.bound_port = None;
        runtime.bind_error = None;
        runtime.pairing = None;
    }
    let _ = state.remote_lan.cuts.send(LanCut::All);
}

pub async fn enable(state: &AppState) -> anyhow::Result<RemoteLanStatus> {
    {
        let mut runtime = state
            .remote_lan
            .runtime
            .lock()
            .map_err(|_| anyhow::anyhow!("Phone remote state unavailable."))?;
        runtime.persisted.enabled = true;
    }
    persist(state)?;
    start_if_enabled(state).await;
    Ok(publish_status(state))
}

pub fn disable(state: &AppState) -> anyhow::Result<RemoteLanStatus> {
    {
        let mut runtime = state
            .remote_lan
            .runtime
            .lock()
            .map_err(|_| anyhow::anyhow!("Phone remote state unavailable."))?;
        runtime.persisted.enabled = false;
    }
    persist(state)?;
    stop(state);
    Ok(publish_status(state))
}

pub fn begin_pairing(
    state: &AppState,
    params: BeginPairingParams,
) -> Result<RemoteLanPairing, String> {
    let addresses = remote_lan::lan_addresses();
    let mut runtime = state
        .remote_lan
        .runtime
        .lock()
        .map_err(|_| "Phone remote state unavailable.".to_string())?;
    let Some(port) = runtime.bound_port else {
        return Err(runtime
            .bind_error
            .clone()
            .unwrap_or_else(|| "Turn Phone remote on first.".to_string()));
    };
    let address = match params.address {
        // Only ever encode an address this machine actually holds.
        Some(address) if addresses.contains(&address) => address,
        Some(_) => return Err("That network address is no longer available.".to_string()),
        None => addresses.first().cloned().ok_or_else(|| {
            "No Wi-Fi or Ethernet network found. Connect this computer to the same network as your phone."
                .to_string()
        })?,
    };
    let ticket = runtime.begin_pairing(Instant::now());
    let pairing = RemoteLanPairing {
        url: format!("http://{address}:{port}/#{}", ticket.fragment()),
        address,
        addresses,
        expires_at: ticket.expires_at_wall.to_rfc3339(),
    };
    drop(runtime);
    publish_status(state);
    Ok(pairing)
}

pub fn cancel_pairing(state: &AppState) -> RemoteLanStatus {
    if let Ok(mut runtime) = state.remote_lan.runtime.lock() {
        runtime.cancel_pairing();
    }
    publish_status(state)
}

pub fn revoke_device(state: &AppState, params: DeviceParams) -> anyhow::Result<RemoteLanStatus> {
    let removed = state
        .remote_lan
        .runtime
        .lock()
        .map_err(|_| anyhow::anyhow!("Phone remote state unavailable."))?
        .revoke_device(&params.id);
    if removed {
        persist(state)?;
        // Cut only this phone; the Stream Deck and other phones stay up.
        let _ = state.remote_lan.cuts.send(LanCut::Device(params.id));
    }
    Ok(publish_status(state))
}

pub fn rename_device(state: &AppState, params: DeviceParams) -> anyhow::Result<RemoteLanStatus> {
    let renamed = state
        .remote_lan
        .runtime
        .lock()
        .map_err(|_| anyhow::anyhow!("Phone remote state unavailable."))?
        .rename_device(&params.id, params.name.as_deref().unwrap_or_default());
    if renamed {
        persist(state)?;
    }
    Ok(publish_status(state))
}

pub fn lan_router(state: AppState) -> Router {
    Router::new()
        .route(
            "/",
            get(|| async { asset("text/html; charset=utf-8", INDEX_HTML) }),
        )
        .route(
            "/app.js",
            get(|| async { asset("text/javascript; charset=utf-8", APP_JS) }),
        )
        .route(
            "/remote-client.js",
            get(|| async { asset("text/javascript; charset=utf-8", REMOTE_CLIENT_JS) }),
        )
        .route(
            "/hmac.js",
            get(|| async { asset("text/javascript; charset=utf-8", HMAC_JS) }),
        )
        .route(
            "/app.css",
            get(|| async { asset("text/css; charset=utf-8", APP_CSS) }),
        )
        .route(
            "/manifest.webmanifest",
            get(|| async { asset("application/manifest+json", MANIFEST) }),
        )
        .route(
            "/icon.svg",
            get(|| async { asset("image/svg+xml", ICON_SVG) }),
        )
        .route("/ws", get(lan_ws_handler))
        .layer(axum::middleware::from_fn(guard_and_harden))
        .with_state(state)
}

fn asset(content_type: &'static str, body: &'static str) -> Response {
    ([(header::CONTENT_TYPE, content_type)], body).into_response()
}

/// `Host` must be an address literal (or localhost). A DNS-rebinding page
/// reaches us under its own hostname and is refused before any route runs.
fn host_is_address_literal(headers: &HeaderMap) -> bool {
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let name = host.rsplit_once(':').map_or(host, |(name, port)| {
        if port.chars().all(|character| character.is_ascii_digit()) {
            name
        } else {
            host
        }
    });
    name == "localhost" || name.parse::<Ipv4Addr>().is_ok()
}

/// A browser always sends `Origin` on a websocket upgrade; it must be this
/// listener's own origin. Native clients send none.
fn origin_is_same_site(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let (Ok(origin), Some(Ok(host))) = (
        origin.to_str(),
        headers.get(header::HOST).map(|value| value.to_str()),
    ) else {
        return false;
    };
    origin == format!("http://{host}")
}

async fn guard_and_harden(request: Request, next: Next) -> Response {
    if !host_is_address_literal(request.headers()) {
        return StatusCode::MISDIRECTED_REQUEST.into_response();
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    for (name, value) in [
        (header::CONTENT_SECURITY_POLICY, CONTENT_SECURITY_POLICY),
        (header::CACHE_CONTROL, "no-store"),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::REFERRER_POLICY, "no-referrer"),
        (header::X_FRAME_OPTIONS, "DENY"),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
    response
}

async fn lan_ws_handler(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !origin_is_same_site(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let limited = state
        .remote_lan
        .runtime
        .lock()
        .map(|mut runtime| runtime.is_rate_limited(peer.ip(), Instant::now()))
        .unwrap_or(true);
    if limited {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    if state.remote_lan.connected_clients.load(Ordering::Relaxed) >= MAX_LAN_CLIENTS {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    ws.max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| lan_session(socket, state, peer.ip()))
}

async fn send_json(socket: &mut WebSocket, value: serde_json::Value) -> bool {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .is_ok()
}

async fn reject(socket: &mut WebSocket, error: HandshakeError) {
    let _ = send_json(
        socket,
        serde_json::json!({ "t": "error", "code": error.code(), "message": error.message() }),
    )
    .await;
    let _ = socket.send(Message::Close(None)).await;
}

/// Counts an authenticated phone for its whole lifetime; every exit path
/// (close, cut, panic) decrements through Drop.
struct LanClientGuard {
    state: AppState,
    device_id: String,
}

impl LanClientGuard {
    fn new(state: &AppState, device_id: &str) -> Self {
        state
            .remote_lan
            .connected_clients
            .fetch_add(1, Ordering::Relaxed);
        if let Ok(mut runtime) = state.remote_lan.runtime.lock() {
            *runtime.connected.entry(device_id.to_string()).or_default() += 1;
        }
        publish_status(state);
        Self {
            state: state.clone(),
            device_id: device_id.to_string(),
        }
    }
}

impl Drop for LanClientGuard {
    fn drop(&mut self) {
        self.state
            .remote_lan
            .connected_clients
            .fetch_sub(1, Ordering::Relaxed);
        if let Ok(mut runtime) = self.state.remote_lan.runtime.lock() {
            if let Some(count) = runtime.connected.get_mut(&self.device_id) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    runtime.connected.remove(&self.device_id);
                }
            }
            if let Some(device) = runtime
                .persisted
                .devices
                .iter_mut()
                .find(|device| device.id == self.device_id)
            {
                device.last_seen_at = Some(chrono::Utc::now().to_rfc3339());
            }
        }
        publish_status(&self.state);
    }
}

async fn lan_session(mut socket: WebSocket, state: AppState, peer: IpAddr) {
    // Subscribe BEFORE the handshake so a revoke racing the pairing cannot
    // slip between "authenticated" and "watching for cuts".
    let cuts = state.remote_lan.cuts.subscribe();
    let server_nonce = remote_lan::b64(&remote_lan::random_32());
    if !send_json(
        &mut socket,
        serde_json::json!({ "t": "hello", "protocol": LAN_PROTOCOL, "serverNonce": server_nonce }),
    )
    .await
    {
        return;
    }

    let frame = match tokio::time::timeout(remote_lan::AUTH_DEADLINE, socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) if text.len() <= MAX_PRE_AUTH_FRAME_BYTES => text,
        Ok(Some(Ok(_))) => {
            reject(&mut socket, HandshakeError::Malformed).await;
            return;
        }
        // Deadline, close, or transport error: nothing worth answering.
        _ => return,
    };
    let Ok(hello) = serde_json::from_str::<ClientHello>(frame.as_str()) else {
        reject(&mut socket, HandshakeError::Malformed).await;
        return;
    };

    let outcome = {
        let mut runtime = state
            .remote_lan
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        runtime.complete_handshake(&hello, &server_nonce, peer, Instant::now())
    };
    let session = match outcome {
        Ok(session) => session,
        Err(error) => {
            tracing::info!("Phone remote handshake refused ({}).", error.code());
            reject(&mut socket, error).await;
            return;
        }
    };
    if session.newly_paired
        && let Err(error) = persist(&state)
    {
        // A device that would vanish on restart is worse than a failed pairing.
        tracing::warn!("Could not persist the newly paired phone: {error:#}");
        if let Ok(mut runtime) = state.remote_lan.runtime.lock() {
            runtime.revoke_device(&session.device_id);
        }
        reject(&mut socket, HandshakeError::Malformed).await;
        return;
    }

    if !send_json(
        &mut socket,
        serde_json::json!({
            "t": "ready",
            "protocol": LAN_PROTOCOL,
            "deviceId": session.device_id,
            "deviceName": session.device_name,
            "mac": session.ready_mac,
        }),
    )
    .await
    {
        return;
    }

    let _guard = LanClientGuard::new(&state, &session.device_id);
    if session.newly_paired {
        state.emit_event(
            "remote.lan.paired",
            serde_json::json!({ "deviceId": session.device_id, "deviceName": session.device_name }),
        );
    }
    crate::websocket_session_with_handler_role_and_redaction(
        socket,
        state.clone(),
        crate::production_websocket_command_handler(BackendRole::Remote),
        BackendRole::Remote,
        false,
        Some((
            LanSession {
                device_id: session.device_id.clone(),
                verifier: SessionVerifier::new(session.session_key),
            },
            cuts,
        )),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_lan::{b64, derive_device_key, derive_session_key, mac, random_32};
    use crate::storage::Database;
    use futures_util::{SinkExt, StreamExt};
    use std::time::Duration;
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    type Socket = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    fn test_state() -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(64);
        let state = AppState::new(
            "renderer-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        );
        // The test secret store is one process-global cache: a device paired
        // (and persisted) by a parallel test would otherwise be loaded here.
        *state.remote_lan.runtime.lock().unwrap() = crate::remote_lan::LanRuntime::default();
        state
    }

    async fn serve(state: &AppState) -> SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        if let Ok(mut runtime) = state.remote_lan.runtime.lock() {
            runtime.bound_port = Some(address.port());
        }
        let app = lan_router(state.clone());
        tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        address
    }

    async fn next_json(socket: &mut Socket) -> Option<serde_json::Value> {
        loop {
            let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
                .await
                .expect("socket answered in time")?;
            match message {
                Ok(WsMessage::Text(text)) => return serde_json::from_str(&text).ok(),
                Ok(WsMessage::Close(_)) | Err(_) => return None,
                Ok(_) => {}
            }
        }
    }

    struct Phone {
        socket: Socket,
        session_key: [u8; 32],
        seq: u64,
        device_id: String,
    }

    impl Phone {
        async fn send_signed(&mut self, body: serde_json::Value) {
            self.seq += 1;
            let body = body.to_string();
            let frame = serde_json::json!({
                "seq": self.seq,
                "mac": b64(&mac(&self.session_key, &["frame", &self.seq.to_string(), &body])),
                "body": body,
            });
            self.socket
                .send(WsMessage::Text(frame.to_string().into()))
                .await
                .unwrap();
        }

        async fn response(&mut self, id: &str) -> serde_json::Value {
            loop {
                let message = next_json(&mut self.socket)
                    .await
                    .expect("socket stayed open");
                if message["id"] == id {
                    return message;
                }
            }
        }
    }

    async fn pair(state: &AppState, address: SocketAddr, name: &str) -> Phone {
        let ticket = state
            .remote_lan
            .runtime
            .lock()
            .unwrap()
            .begin_pairing(Instant::now());
        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/ws"))
            .await
            .unwrap();
        let hello = next_json(&mut socket).await.unwrap();
        assert_eq!(hello["t"], "hello");
        assert_eq!(hello["protocol"], 2);
        let server_nonce = hello["serverNonce"].as_str().unwrap().to_string();
        let client_nonce = b64(&random_32());
        socket
            .send(WsMessage::Text(
                serde_json::json!({
                    "t": "pair",
                    "pairingId": ticket.id,
                    "clientNonce": client_nonce,
                    "deviceName": name,
                    "mac": b64(&mac(&ticket.secret, &["pair", &server_nonce, &client_nonce])),
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        let ready = next_json(&mut socket).await.unwrap();
        assert_eq!(ready["t"], "ready", "{ready}");
        let device_key = derive_device_key(&ticket.secret, &server_nonce, &client_nonce);
        assert_eq!(
            ready["mac"],
            crate::remote_lan::ready_mac(&device_key, &server_nonce, &client_nonce),
            "the desktop proves it holds the key too"
        );
        Phone {
            socket,
            session_key: derive_session_key(&device_key, &server_nonce, &client_nonce),
            seq: 0,
            device_id: ready["deviceId"].as_str().unwrap().to_string(),
        }
    }

    #[tokio::test]
    async fn lan_router_serves_the_page_and_nothing_from_the_main_router() {
        let state = test_state();
        let address = serve(&state).await;
        let client = reqwest::Client::new();

        let page = client
            .get(format!("http://{address}/"))
            .send()
            .await
            .unwrap();
        assert_eq!(page.status(), 200);
        let csp = page.headers()["content-security-policy"].to_str().unwrap();
        assert!(csp.contains("default-src 'self'"));
        assert!(csp.contains("frame-ancestors 'none'"));
        assert_eq!(page.headers()["cache-control"], "no-store");
        assert_eq!(page.headers()["x-content-type-options"], "nosniff");

        // Everything the loopback router serves must be structurally absent.
        for path in [
            "/health",
            "/preview/live.mjpeg",
            "/preview/live.jpg",
            "/preview/camera/live.png",
            "/preview/anything",
            "/sessions/abc/poster",
            "/compositor/status",
            "/oauth/callback",
        ] {
            let response = client
                .get(format!("http://{address}{path}"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 404, "{path} must not exist on the LAN");
        }

        let rebound = client
            .get(format!("http://{address}/"))
            .header("host", "evil.example")
            .send()
            .await
            .unwrap();
        assert_eq!(rebound.status(), 421);
    }

    #[tokio::test]
    async fn backend_tokens_mean_nothing_on_the_lan_socket() {
        let state = test_state();
        let address = serve(&state).await;
        for token in [state.token.clone(), state.admin_token.clone()] {
            let (mut socket, _) =
                tokio_tungstenite::connect_async(format!("ws://{address}/ws?token={token}"))
                    .await
                    .unwrap();
            assert_eq!(next_json(&mut socket).await.unwrap()["t"], "hello");
            // A protocol-1 style command instead of a handshake.
            socket
                .send(WsMessage::Text(
                    r#"{"id":"1","method":"remote.describe"}"#.into(),
                ))
                .await
                .unwrap();
            let answer = next_json(&mut socket).await.unwrap();
            assert_eq!(answer["t"], "error");
            assert!(next_json(&mut socket).await.is_none(), "socket must close");
        }

        let mut request =
            tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
                format!("ws://{address}/ws"),
            )
            .unwrap();
        request
            .headers_mut()
            .insert("origin", "https://evil.example".parse().unwrap());
        assert!(
            tokio_tungstenite::connect_async(request).await.is_err(),
            "a cross-site page must not open the socket"
        );
    }

    #[tokio::test]
    async fn paired_phone_gets_the_remote_allowlist_projected_chat_and_no_renderer_token() {
        let state = test_state();
        let address = serve(&state).await;
        let mut phone = pair(&state, address, "iPhone · Safari").await;
        assert_eq!(
            state.remote_lan.connected_clients.load(Ordering::Relaxed),
            1
        );

        phone
            .send_signed(serde_json::json!({ "id": "d", "method": "remote.describe" }))
            .await;
        let mut seen = Vec::new();
        let describe = loop {
            let message = next_json(&mut phone.socket).await.unwrap();
            if message["id"] == "d" {
                break message;
            }
            seen.push(message);
        };
        assert_eq!(describe["ok"], true);
        assert!(
            seen.iter()
                .all(|message| message["event"] != "backend.ready"),
            "backend.ready carries the renderer token"
        );

        phone
            .send_signed(serde_json::json!({ "id": "s", "method": "session.start" }))
            .await;
        assert_eq!(
            phone.response("s").await["error"]["code"],
            "forbidden-method"
        );
        phone
            .send_signed(serde_json::json!({
                "id": "f", "method": "events.setIncluded", "params": { "events": ["liveChat.message"] }
            }))
            .await;
        assert_eq!(phone.response("f").await["ok"], false);

        phone
            .send_signed(serde_json::json!({ "id": "c", "method": "remote.chat.snapshot" }))
            .await;
        let snapshot = phone.response("c").await;
        assert_eq!(snapshot["ok"], true);
        assert!(snapshot["payload"]["messages"].is_array());
        assert_eq!(snapshot["payload"]["highlight"]["phase"], "idle");

        state.emit_event(
            "liveChat.message",
            serde_json::json!({
                "id": "twitch:1", "platform": "twitch", "authorId": "author-secret",
                "authorName": "Viewer", "authorAvatarUrl": "https://cdn.example/a.png",
                "sessionId": "session-secret", "messageText": "hi", "eventType": "message",
                "fragments": [], "isDeleted": false
            }),
        );
        let event = loop {
            let message = next_json(&mut phone.socket).await.unwrap();
            assert_ne!(message["event"], "liveChat.message", "raw chat leaked");
            if message["event"] == "remote.chat.message" {
                break message;
            }
        };
        assert_eq!(event["payload"]["message"]["authorName"], "Viewer");
        let raw = event.to_string();
        assert!(!raw.contains("secret") && !raw.contains("http"), "{raw}");
    }

    #[tokio::test]
    async fn unsigned_and_replayed_frames_end_the_socket() {
        let state = test_state();
        let address = serve(&state).await;

        let mut phone = pair(&state, address, "A").await;
        phone
            .socket
            .send(WsMessage::Text(
                r#"{"id":"1","method":"remote.describe"}"#.into(),
            ))
            .await
            .unwrap();
        assert!(next_json(&mut phone.socket).await.is_none());

        let mut phone = pair(&state, address, "B").await;
        phone
            .send_signed(serde_json::json!({ "id": "1", "method": "remote.describe" }))
            .await;
        assert_eq!(phone.response("1").await["ok"], true);
        phone.seq -= 1; // replay the accepted sequence number
        phone
            .send_signed(serde_json::json!({ "id": "2", "method": "remote.describe" }))
            .await;
        assert!(next_json(&mut phone.socket).await.is_none());
    }

    #[tokio::test]
    async fn revoke_cuts_one_phone_and_stop_cuts_the_rest() {
        let state = test_state();
        let address = serve(&state).await;
        let mut first = pair(&state, address, "First").await;
        let mut second = pair(&state, address, "Second").await;
        assert_eq!(status(&state).devices.len(), 2);
        assert!(status(&state).devices.iter().all(|device| device.connected));

        revoke_device(
            &state,
            DeviceParams {
                id: first.device_id.clone(),
                name: None,
            },
        )
        .unwrap();
        assert!(
            next_json(&mut first.socket).await.is_none(),
            "revoked phone drops"
        );

        second
            .send_signed(serde_json::json!({ "id": "alive", "method": "remote.describe" }))
            .await;
        assert_eq!(second.response("alive").await["ok"], true);
        assert_eq!(status(&state).devices.len(), 1);

        stop(&state);
        assert!(
            next_json(&mut second.socket).await.is_none(),
            "stop cuts everyone"
        );
        tokio::time::timeout(Duration::from_secs(5), async {
            while state.remote_lan.connected_clients.load(Ordering::Relaxed) != 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("client count returns to zero");
    }

    #[test]
    fn status_never_serialises_key_material() {
        let state = test_state();
        {
            let mut runtime = state.remote_lan.runtime.lock().unwrap();
            runtime.persisted.enabled = true;
            runtime
                .persisted
                .devices
                .push(crate::remote_lan::LanDevice {
                    id: "device-1".to_string(),
                    name: "Pixel".to_string(),
                    key: "KEY-MATERIAL".to_string(),
                    created_at: "2026-09-18T10:00:00Z".to_string(),
                    last_seen_at: None,
                });
            runtime.begin_pairing(Instant::now());
        }
        let serialized = serde_json::to_string(&status(&state)).unwrap();
        assert!(!serialized.contains("KEY-MATERIAL"));
        assert!(!serialized.contains("\"key\""));
        assert!(!serialized.contains("null"), "{serialized}");
        assert!(serialized.contains("pairingExpiresAt"));
    }

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(*name, HeaderValue::from_static(value));
        }
        headers
    }

    #[test]
    fn only_address_literal_hosts_are_served() {
        assert!(host_is_address_literal(&headers(&[(
            "host",
            "192.168.1.20:7420"
        )])));
        assert!(host_is_address_literal(&headers(&[("host", "10.0.0.2")])));
        assert!(host_is_address_literal(&headers(&[(
            "host",
            "localhost:7420"
        )])));
        // DNS rebinding arrives under the attacker's name.
        assert!(!host_is_address_literal(&headers(&[(
            "host",
            "evil.example:7420"
        )])));
        assert!(!host_is_address_literal(&headers(&[])));
    }

    #[test]
    fn websocket_origin_must_be_this_listener_or_absent() {
        assert!(origin_is_same_site(&headers(&[(
            "host",
            "192.168.1.20:7420"
        )])));
        assert!(origin_is_same_site(&headers(&[
            ("host", "192.168.1.20:7420"),
            ("origin", "http://192.168.1.20:7420"),
        ])));
        for origin in [
            "https://evil.example",
            "http://192.168.1.20:9999",
            "https://192.168.1.20:7420",
            "null",
        ] {
            let mut map = headers(&[("host", "192.168.1.20:7420")]);
            map.insert("origin", HeaderValue::from_str(origin).unwrap());
            assert!(!origin_is_same_site(&map), "{origin} must be refused");
        }
    }
}
