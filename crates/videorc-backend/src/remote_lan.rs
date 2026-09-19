//! Phone remote — the LAN half of the remote-control surface (protocol 2).
//!
//! The loopback surface (`remote_control.rs`, protocol 1) trusts same-user
//! local software and carries its token in the URL. A phone on the Wi-Fi gets
//! none of that trust, so this module owns a separate credential scheme:
//!
//! - A single-use, short-lived **pairing ticket** travels to the phone in a QR
//!   code, inside the URL *fragment* — it never appears in an HTTP request.
//! - Both sides DERIVE the long-lived per-device key from the ticket; no
//!   secret ever crosses the (plaintext) wire.
//! - Every connection runs a mutual HMAC challenge-response, and every
//!   client→server frame afterwards is MAC'd with a strictly increasing
//!   sequence number, so a passive sniffer learns nothing reusable and an
//!   on-path attacker cannot inject or replay intents.
//!
//! Pure logic only — the listener lives in `remote_lan_server.rs`.

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::secrets;

pub const LAN_PROTOCOL: u32 = 2;
pub const LAN_PREFERRED_PORT: u16 = 7420;
/// Ports tried after the preferred one. A stable port keeps bookmarks and
/// home-screen icons alive; a silent random port would not.
pub const LAN_PORT_SCAN: u16 = 10;
pub const LAN_SECRET: &str = "remote-control.lan";

pub const PAIRING_TTL: Duration = Duration::from_secs(5 * 60);
pub const AUTH_DEADLINE: Duration = Duration::from_secs(5);
pub const MAX_PRE_AUTH_FRAME_BYTES: usize = 1024;
pub const MAX_FRAME_BYTES: usize = 16 * 1024;
pub const MAX_LAN_CLIENTS: usize = 8;
pub const MAX_LAN_DEVICES: usize = 16;
pub const MAX_DEVICE_NAME_CHARS: usize = 40;
pub const AUTH_FAILURE_LIMIT: usize = 5;
pub const AUTH_FAILURE_WINDOW: Duration = Duration::from_secs(60);
/// Messages returned by `remote.chat.snapshot` and the reset event.
pub const CHAT_SNAPSHOT_LIMIT: usize = 200;

type HmacSha256 = Hmac<Sha256>;

/// 32 bytes from the OS CSPRNG (two v4 UUIDs — 244 random bits) without a
/// new dependency, matching `remote_control::generate_token`.
pub fn random_32() -> [u8; 32] {
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes
}

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn b64_decode_32(text: &str) -> Option<[u8; 32]> {
    let bytes = URL_SAFE_NO_PAD.decode(text).ok()?;
    bytes.try_into().ok()
}

/// HMAC over `parts` joined by `\n`. Every part is either a fixed label, a
/// base64url string, a decimal number, or (last position only) a free body —
/// so the join is unambiguous.
pub fn mac(key: &[u8], parts: &[&str]) -> [u8; 32] {
    let mut hmac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            hmac.update(b"\n");
        }
        hmac.update(part.as_bytes());
    }
    hmac.finalize().into_bytes().into()
}

fn mac_matches(key: &[u8], parts: &[&str], supplied_b64: &str) -> bool {
    let Ok(supplied) = URL_SAFE_NO_PAD.decode(supplied_b64) else {
        return false;
    };
    let mut hmac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            hmac.update(b"\n");
        }
        hmac.update(part.as_bytes());
    }
    // `verify_slice` is constant-time.
    hmac.verify_slice(&supplied).is_ok()
}

pub fn derive_device_key(
    pairing_secret: &[u8; 32],
    server_nonce: &str,
    client_nonce: &str,
) -> [u8; 32] {
    mac(pairing_secret, &["device", server_nonce, client_nonce])
}

pub fn derive_session_key(
    device_key: &[u8; 32],
    server_nonce: &str,
    client_nonce: &str,
) -> [u8; 32] {
    mac(device_key, &["session", server_nonce, client_nonce])
}

pub fn ready_mac(device_key: &[u8; 32], server_nonce: &str, client_nonce: &str) -> String {
    b64(&mac(device_key, &["ready", client_nonce, server_nonce]))
}

#[derive(Debug, Clone)]
pub struct PairingTicket {
    pub id: String,
    pub secret: [u8; 32],
    pub expires_at: Instant,
    pub expires_at_wall: chrono::DateTime<chrono::Utc>,
}

impl PairingTicket {
    pub fn fragment(&self) -> String {
        format!("p={}.{}", self.id, b64(&self.secret))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LanDevice {
    pub id: String,
    pub name: String,
    /// base64url of the 32-byte device key. Lives in the secret store only.
    pub key: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LanPersisted {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default)]
    pub devices: Vec<LanDevice>,
}

impl LanPersisted {
    pub fn load_from_secrets() -> Self {
        secrets::try_get_secret(LAN_SECRET)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn persist(&self) -> Result<()> {
        let body = serde_json::to_string(self).context("Could not encode phone-remote state")?;
        secrets::put_secret(LAN_SECRET, &body)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandshakeError {
    Malformed,
    RateLimited,
    UnknownDevice,
    BadMac,
    PairingExpired,
    TooManyDevices,
}

impl HandshakeError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::RateLimited => "rate-limited",
            Self::UnknownDevice => "unknown-device",
            Self::BadMac => "bad-mac",
            Self::PairingExpired => "pairing-expired",
            Self::TooManyDevices => "too-many-devices",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::Malformed => "Malformed handshake.",
            Self::RateLimited => "Too many failed attempts. Wait a minute and try again.",
            Self::UnknownDevice => "This phone is no longer paired. Scan a new code in Videorc.",
            Self::BadMac => "Pairing check failed. Scan a new code in Videorc.",
            Self::PairingExpired => "This pairing code expired or was already used.",
            Self::TooManyDevices => "Too many paired phones. Remove one in Videorc Settings.",
        }
    }

    /// Only credential failures feed the limiter; a garbled frame from a
    /// flaky client must not lock a real phone out.
    fn counts_as_failure(self) -> bool {
        matches!(
            self,
            Self::UnknownDevice | Self::BadMac | Self::PairingExpired
        )
    }
}

/// The client's single pre-auth frame.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum ClientHello {
    #[serde(rename_all = "camelCase")]
    Pair {
        pairing_id: String,
        client_nonce: String,
        #[serde(default)]
        device_name: String,
        mac: String,
    },
    #[serde(rename_all = "camelCase")]
    Auth {
        device_id: String,
        client_nonce: String,
        mac: String,
    },
}

#[derive(Debug, Clone)]
pub struct HandshakeSuccess {
    pub device_id: String,
    pub device_name: String,
    pub newly_paired: bool,
    pub ready_mac: String,
    pub session_key: [u8; 32],
}

#[derive(Debug, Default)]
pub struct LanRuntime {
    pub persisted: LanPersisted,
    pub pairing: Option<PairingTicket>,
    /// Open sockets per device id.
    pub connected: HashMap<String, usize>,
    pub bound_port: Option<u16>,
    pub bind_error: Option<String>,
    failures: HashMap<IpAddr, VecDeque<Instant>>,
}

pub fn sanitize_device_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_DEVICE_NAME_CHARS)
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "Phone".to_string()
    } else {
        trimmed.to_string()
    }
}

fn valid_nonce(nonce: &str) -> bool {
    b64_decode_32(nonce).is_some()
}

impl LanRuntime {
    pub fn load_from_secrets() -> Self {
        Self {
            persisted: LanPersisted::load_from_secrets(),
            ..Self::default()
        }
    }

    pub fn begin_pairing(&mut self, now: Instant) -> PairingTicket {
        let ticket = PairingTicket {
            id: uuid::Uuid::new_v4().simple().to_string(),
            secret: random_32(),
            expires_at: now + PAIRING_TTL,
            expires_at_wall: chrono::Utc::now()
                + chrono::Duration::from_std(PAIRING_TTL).expect("pairing TTL fits chrono"),
        };
        // One live ticket: opening the dialog again kills the previous code.
        self.pairing = Some(ticket.clone());
        ticket
    }

    pub fn cancel_pairing(&mut self) {
        self.pairing = None;
    }

    pub fn live_pairing(&mut self, now: Instant) -> Option<&PairingTicket> {
        if self
            .pairing
            .as_ref()
            .is_some_and(|ticket| ticket.expires_at <= now)
        {
            self.pairing = None;
        }
        self.pairing.as_ref()
    }

    pub fn is_rate_limited(&mut self, ip: IpAddr, now: Instant) -> bool {
        let Some(failures) = self.failures.get_mut(&ip) else {
            return false;
        };
        while failures
            .front()
            .is_some_and(|at| now.duration_since(*at) >= AUTH_FAILURE_WINDOW)
        {
            failures.pop_front();
        }
        if failures.is_empty() {
            self.failures.remove(&ip);
            return false;
        }
        failures.len() >= AUTH_FAILURE_LIMIT
    }

    fn note_failure(&mut self, ip: IpAddr, now: Instant) {
        // Bound the map: a scanner cycling source addresses must not grow it
        // without limit. Dropping the oldest entries only ever un-limits.
        if self.failures.len() >= 256 && !self.failures.contains_key(&ip) {
            self.failures.clear();
        }
        let failures = self.failures.entry(ip).or_default();
        failures.push_back(now);
        while failures.len() > AUTH_FAILURE_LIMIT {
            failures.pop_front();
        }
    }

    /// Verify the client's pre-auth frame against `server_nonce`. On a
    /// successful `pair` the ticket is consumed and the new device is added
    /// to `persisted` — the caller persists.
    pub fn complete_handshake(
        &mut self,
        hello: &ClientHello,
        server_nonce: &str,
        ip: IpAddr,
        now: Instant,
    ) -> Result<HandshakeSuccess, HandshakeError> {
        if self.is_rate_limited(ip, now) {
            return Err(HandshakeError::RateLimited);
        }
        let outcome = self.verify_hello(hello, server_nonce, now);
        if let Err(error) = outcome
            && error.counts_as_failure()
        {
            self.note_failure(ip, now);
        }
        outcome
    }

    fn verify_hello(
        &mut self,
        hello: &ClientHello,
        server_nonce: &str,
        now: Instant,
    ) -> Result<HandshakeSuccess, HandshakeError> {
        match hello {
            ClientHello::Pair {
                pairing_id,
                client_nonce,
                device_name,
                mac: supplied,
            } => {
                if !valid_nonce(client_nonce) {
                    return Err(HandshakeError::Malformed);
                }
                let ticket = self
                    .live_pairing(now)
                    .filter(|ticket| ticket.id == *pairing_id)
                    .cloned()
                    .ok_or(HandshakeError::PairingExpired)?;
                if !mac_matches(
                    &ticket.secret,
                    &["pair", server_nonce, client_nonce],
                    supplied,
                ) {
                    return Err(HandshakeError::BadMac);
                }
                if self.persisted.devices.len() >= MAX_LAN_DEVICES {
                    return Err(HandshakeError::TooManyDevices);
                }
                // Single use: consumed only by a proven holder of the secret.
                self.pairing = None;
                let device_key = derive_device_key(&ticket.secret, server_nonce, client_nonce);
                let wall = chrono::Utc::now().to_rfc3339();
                let device = LanDevice {
                    id: uuid::Uuid::new_v4().simple().to_string(),
                    name: sanitize_device_name(device_name),
                    key: b64(&device_key),
                    created_at: wall.clone(),
                    last_seen_at: Some(wall),
                };
                let success = HandshakeSuccess {
                    device_id: device.id.clone(),
                    device_name: device.name.clone(),
                    newly_paired: true,
                    ready_mac: ready_mac(&device_key, server_nonce, client_nonce),
                    session_key: derive_session_key(&device_key, server_nonce, client_nonce),
                };
                self.persisted.devices.push(device);
                Ok(success)
            }
            ClientHello::Auth {
                device_id,
                client_nonce,
                mac: supplied,
            } => {
                if !valid_nonce(client_nonce) {
                    return Err(HandshakeError::Malformed);
                }
                let device = self
                    .persisted
                    .devices
                    .iter_mut()
                    .find(|device| device.id == *device_id)
                    .ok_or(HandshakeError::UnknownDevice)?;
                let device_key = b64_decode_32(&device.key).ok_or(HandshakeError::UnknownDevice)?;
                if !mac_matches(&device_key, &["auth", server_nonce, client_nonce], supplied) {
                    return Err(HandshakeError::BadMac);
                }
                device.last_seen_at = Some(chrono::Utc::now().to_rfc3339());
                Ok(HandshakeSuccess {
                    device_id: device.id.clone(),
                    device_name: device.name.clone(),
                    newly_paired: false,
                    ready_mac: ready_mac(&device_key, server_nonce, client_nonce),
                    session_key: derive_session_key(&device_key, server_nonce, client_nonce),
                })
            }
        }
    }

    pub fn revoke_device(&mut self, device_id: &str) -> bool {
        let before = self.persisted.devices.len();
        self.persisted
            .devices
            .retain(|device| device.id != device_id);
        self.persisted.devices.len() != before
    }

    pub fn rename_device(&mut self, device_id: &str, name: &str) -> bool {
        match self
            .persisted
            .devices
            .iter_mut()
            .find(|device| device.id == device_id)
        {
            Some(device) => {
                device.name = sanitize_device_name(name);
                true
            }
            None => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvelopeError {
    TooLarge,
    Malformed,
    Replayed,
    BadMac,
}

#[derive(Debug, Deserialize)]
struct SignedEnvelope {
    seq: u64,
    mac: String,
    body: String,
}

/// Per-connection verifier for signed client frames:
/// `{"seq":n,"mac":b64(HMAC(sessionKey,"frame"\n n \n body)),"body":"<json>"}`.
/// The MAC covers the raw body string, so no JSON canonicalisation exists to
/// get wrong. ANY failure is fatal to the socket — a legitimate client never
/// produces one.
#[derive(Debug)]
pub struct SessionVerifier {
    session_key: [u8; 32],
    last_seq: u64,
}

impl SessionVerifier {
    pub fn new(session_key: [u8; 32]) -> Self {
        Self {
            session_key,
            last_seq: 0,
        }
    }

    pub fn open(&mut self, frame: &str) -> Result<String, EnvelopeError> {
        if frame.len() > MAX_FRAME_BYTES {
            return Err(EnvelopeError::TooLarge);
        }
        let envelope: SignedEnvelope =
            serde_json::from_str(frame).map_err(|_| EnvelopeError::Malformed)?;
        if envelope.seq <= self.last_seq {
            return Err(EnvelopeError::Replayed);
        }
        let seq = envelope.seq.to_string();
        if !mac_matches(
            &self.session_key,
            &["frame", &seq, &envelope.body],
            &envelope.mac,
        ) {
            return Err(EnvelopeError::BadMac);
        }
        self.last_seq = envelope.seq;
        Ok(envelope.body)
    }
}

/// Which sockets a cut applies to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LanCut {
    All,
    Device(String),
}

pub struct RemoteLanShared {
    pub runtime: StdMutex<LanRuntime>,
    /// Open LAN sockets. Read lock-free on the event hot path: chat is only
    /// projected while a phone is actually listening.
    pub connected_clients: AtomicUsize,
    pub chat_seq: AtomicU64,
    pub cuts: tokio::sync::broadcast::Sender<LanCut>,
    /// Shutdown handle of the running listener, if any.
    pub server: StdMutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

pub type RemoteLanSlot = Arc<RemoteLanShared>;

pub fn new_remote_lan_slot(runtime: LanRuntime) -> RemoteLanSlot {
    Arc::new(RemoteLanShared {
        runtime: StdMutex::new(runtime),
        connected_clients: AtomicUsize::new(0),
        chat_seq: AtomicU64::new(0),
        cuts: tokio::sync::broadcast::channel(16).0,
        server: StdMutex::new(None),
    })
}

impl RemoteLanShared {
    pub fn has_clients(&self) -> bool {
        self.connected_clients.load(Ordering::Relaxed) > 0
    }

    pub fn next_chat_seq(&self) -> u64 {
        self.chat_seq.fetch_add(1, Ordering::Relaxed) + 1
    }
}

/// Everything the shared websocket session needs to know about a LAN socket.
pub struct LanSession {
    pub device_id: String,
    pub verifier: SessionVerifier,
}

// ---------------------------------------------------------------------------
// Chat + highlight projection
//
// Built by WHITELIST from the already-serialised app event: a field that is
// not named here cannot reach a phone, whatever gets added to LiveChatMessage
// later. No ids of people, no avatars, no URLs.
// ---------------------------------------------------------------------------

const CHAT_MESSAGE_FIELDS: &[&str] = &[
    "id",
    "platform",
    "authorName",
    "authorBadges",
    "authorRoles",
    "publishedAt",
    "messageText",
    "eventType",
    "amountText",
    "isDeleted",
];

pub fn project_chat_message(message: &serde_json::Value) -> Option<serde_json::Value> {
    let source = message.as_object()?;
    let mut projected = serde_json::Map::new();
    for field in CHAT_MESSAGE_FIELDS {
        if let Some(value) = source.get(*field) {
            projected.insert((*field).to_string(), value.clone());
        }
    }
    let fragments = source
        .get("fragments")
        .and_then(|fragments| fragments.as_array())
        .map(|fragments| {
            fragments
                .iter()
                .filter_map(|fragment| {
                    Some(serde_json::json!({
                        "type": fragment.get("type")?.as_str()?,
                        "text": fragment.get("text")?.as_str()?,
                    }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    projected.insert("fragments".to_string(), serde_json::Value::Array(fragments));
    Some(serde_json::Value::Object(projected))
}

pub fn project_chat_messages(snapshot: &serde_json::Value) -> Vec<serde_json::Value> {
    let messages = snapshot
        .get("messages")
        .and_then(|messages| messages.as_array())
        .map(Vec::as_slice)
        .unwrap_or_default();
    let skip = messages.len().saturating_sub(CHAT_SNAPSHOT_LIMIT);
    messages[skip..]
        .iter()
        .filter_map(project_chat_message)
        .collect()
}

pub fn project_highlight(status: &serde_json::Value) -> serde_json::Value {
    let mut projected = serde_json::Map::new();
    for field in ["messageId", "phase", "expiresAt", "reason"] {
        if let Some(value) = status.get(field) {
            projected.insert(field.to_string(), value.clone());
        }
    }
    serde_json::Value::Object(projected)
}

/// Map an app event to the phone-facing event it implies, if any.
/// `liveChat.snapshot`/`liveChat.cleared` both become a full reset so the
/// phone never has to reason about session swaps or local clears.
pub fn project_event(
    lan: &RemoteLanShared,
    event: &str,
    payload: &serde_json::Value,
) -> Option<(&'static str, serde_json::Value)> {
    if !lan.has_clients() {
        return None;
    }
    match event {
        "liveChat.message" => {
            let message = project_chat_message(payload)?;
            Some((
                "remote.chat.message",
                serde_json::json!({ "chatSeq": lan.next_chat_seq(), "message": message }),
            ))
        }
        "liveChat.snapshot" | "liveChat.cleared" => Some((
            "remote.chat.reset",
            serde_json::json!({
                "chatSeq": lan.next_chat_seq(),
                "messages": project_chat_messages(payload),
            }),
        )),
        "comments.highlight.status" => Some(("remote.highlight", project_highlight(payload))),
        _ => None,
    }
}

/// Events a LAN socket may receive. Loopback (protocol 1) sockets keep their
/// original two-event filter — old clients must not see new traffic.
pub const LAN_EVENTS: &[&str] = &[
    "remote.state",
    "remote.ack",
    "remote.chat.message",
    "remote.chat.reset",
    "remote.highlight",
];

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/// A phone can only reach a private, non-tunnel IPv4 address. VPN (`utun`),
/// bridge, and virtual adapters are dropped so the QR never encodes an
/// address that routes somewhere else.
pub fn is_candidate_lan_interface(name: &str, ip: std::net::Ipv4Addr) -> bool {
    if !ip.is_private() {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    const SKIPPED_PREFIXES: &[&str] = &[
        "utun", "tun", "tap", "ipsec", "ppp", "bridge", "docker", "veth", "vmnet", "vboxnet",
        "llw", "awdl", "anpi", "lo",
    ];
    const SKIPPED_FRAGMENTS: &[&str] = &["vethernet", "virtual", "vpn", "wsl", "loopback"];
    !(SKIPPED_PREFIXES
        .iter()
        .any(|prefix| lower.starts_with(prefix))
        || SKIPPED_FRAGMENTS
            .iter()
            .any(|fragment| lower.contains(fragment)))
}

pub fn lan_addresses() -> Vec<String> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    let mut addresses: Vec<String> = interfaces
        .into_iter()
        .filter_map(|interface| match interface.ip() {
            IpAddr::V4(ip) if is_candidate_lan_interface(&interface.name, ip) => {
                Some(ip.to_string())
            }
            _ => None,
        })
        .collect();
    addresses.sort();
    addresses.dedup();
    // 192.168/16 first: it is overwhelmingly the home Wi-Fi when both a
    // home network and a 10/8 or 172.16/12 virtual network are present.
    addresses.sort_by_key(|address| !address.starts_with("192.168."));
    addresses
}

#[cfg(test)]
mod tests {
    use super::*;

    const IP: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(192, 168, 1, 50));

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn hmac_matches_rfc_4231_case_2() {
        let mut hmac = HmacSha256::new_from_slice(b"Jefe").unwrap();
        hmac.update(b"what do ya want for nothing?");
        assert_eq!(
            hex(&hmac.finalize().into_bytes()),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // `mac` joins parts with a newline — the cross-language contract the
        // JS reference client is vector-tested against.
        assert_eq!(
            hex(&mac(b"Jefe", &["a", "b"])),
            hex(&{
                let mut hmac = HmacSha256::new_from_slice(b"Jefe").unwrap();
                hmac.update(b"a\nb");
                let out: [u8; 32] = hmac.finalize().into_bytes().into();
                out
            })
        );
    }

    fn client_pair(ticket: &PairingTicket, server_nonce: &str) -> (ClientHello, String) {
        let client_nonce = b64(&random_32());
        let hello = ClientHello::Pair {
            pairing_id: ticket.id.clone(),
            client_nonce: client_nonce.clone(),
            device_name: "iPhone · Safari".to_string(),
            mac: b64(&mac(&ticket.secret, &["pair", server_nonce, &client_nonce])),
        };
        (hello, client_nonce)
    }

    #[test]
    fn pairing_derives_a_shared_key_and_reauth_works_without_the_ticket() {
        let mut runtime = LanRuntime::default();
        let now = Instant::now();
        let ticket = runtime.begin_pairing(now);
        let server_nonce = b64(&random_32());
        let (hello, client_nonce) = client_pair(&ticket, &server_nonce);

        let paired = runtime
            .complete_handshake(&hello, &server_nonce, IP, now)
            .expect("pairing succeeds");
        assert!(paired.newly_paired);
        assert_eq!(paired.device_name, "iPhone · Safari");
        assert!(runtime.pairing.is_none(), "ticket is single-use");

        // The phone derives the same key locally — it never crossed the wire.
        let device_key = derive_device_key(&ticket.secret, &server_nonce, &client_nonce);
        assert_eq!(
            paired.ready_mac,
            ready_mac(&device_key, &server_nonce, &client_nonce)
        );
        assert_eq!(runtime.persisted.devices[0].key, b64(&device_key));

        // Reconnect with the derived key and fresh nonces.
        let server_nonce = b64(&random_32());
        let client_nonce = b64(&random_32());
        let auth = ClientHello::Auth {
            device_id: paired.device_id.clone(),
            client_nonce: client_nonce.clone(),
            mac: b64(&mac(&device_key, &["auth", &server_nonce, &client_nonce])),
        };
        let session = runtime
            .complete_handshake(&auth, &server_nonce, IP, now)
            .expect("re-auth succeeds");
        assert!(!session.newly_paired);
        assert_eq!(
            session.session_key,
            derive_session_key(&device_key, &server_nonce, &client_nonce)
        );
    }

    #[test]
    fn reused_expired_and_forged_tickets_are_rejected() {
        let mut runtime = LanRuntime::default();
        let now = Instant::now();
        let ticket = runtime.begin_pairing(now);
        let server_nonce = b64(&random_32());

        // Forged MAC (attacker saw the pairing id but not the secret).
        let forged = ClientHello::Pair {
            pairing_id: ticket.id.clone(),
            client_nonce: b64(&random_32()),
            device_name: String::new(),
            mac: b64(&random_32()),
        };
        assert_eq!(
            runtime
                .complete_handshake(&forged, &server_nonce, IP, now)
                .unwrap_err(),
            HandshakeError::BadMac
        );
        assert!(
            runtime.pairing.is_some(),
            "a forged attempt must not burn the owner's code"
        );

        let (hello, _) = client_pair(&ticket, &server_nonce);
        runtime
            .complete_handshake(&hello, &server_nonce, IP, now)
            .unwrap();
        // Replay of the exact same frame: the ticket is gone.
        assert_eq!(
            runtime
                .complete_handshake(&hello, &server_nonce, IP, now)
                .unwrap_err(),
            HandshakeError::PairingExpired
        );

        let ticket = runtime.begin_pairing(now);
        let (hello, _) = client_pair(&ticket, &server_nonce);
        let later = now + PAIRING_TTL + Duration::from_secs(1);
        assert_eq!(
            runtime
                .complete_handshake(&hello, &server_nonce, IP, later)
                .unwrap_err(),
            HandshakeError::PairingExpired
        );
    }

    #[test]
    fn a_mac_is_bound_to_the_server_nonce() {
        let mut runtime = LanRuntime::default();
        let now = Instant::now();
        let ticket = runtime.begin_pairing(now);
        let (hello, _) = client_pair(&ticket, &b64(&random_32()));
        // Captured frame replayed against a NEW connection's nonce.
        assert_eq!(
            runtime
                .complete_handshake(&hello, &b64(&random_32()), IP, now)
                .unwrap_err(),
            HandshakeError::BadMac
        );
    }

    #[test]
    fn unknown_and_revoked_devices_cannot_authenticate() {
        let mut runtime = LanRuntime::default();
        let now = Instant::now();
        let ticket = runtime.begin_pairing(now);
        let server_nonce = b64(&random_32());
        let (hello, client_nonce) = client_pair(&ticket, &server_nonce);
        let paired = runtime
            .complete_handshake(&hello, &server_nonce, IP, now)
            .unwrap();
        let device_key = derive_device_key(&ticket.secret, &server_nonce, &client_nonce);

        assert!(runtime.revoke_device(&paired.device_id));
        assert!(!runtime.revoke_device(&paired.device_id));
        let auth = ClientHello::Auth {
            device_id: paired.device_id,
            client_nonce: client_nonce.clone(),
            mac: b64(&mac(&device_key, &["auth", &server_nonce, &client_nonce])),
        };
        assert_eq!(
            runtime
                .complete_handshake(&auth, &server_nonce, IP, now)
                .unwrap_err(),
            HandshakeError::UnknownDevice
        );
    }

    #[test]
    fn credential_failures_trip_the_limiter_and_it_recovers() {
        let mut runtime = LanRuntime::default();
        let now = Instant::now();
        let server_nonce = b64(&random_32());
        let bad = ClientHello::Auth {
            device_id: "nope".to_string(),
            client_nonce: b64(&random_32()),
            mac: b64(&random_32()),
        };
        for _ in 0..AUTH_FAILURE_LIMIT {
            assert_eq!(
                runtime
                    .complete_handshake(&bad, &server_nonce, IP, now)
                    .unwrap_err(),
                HandshakeError::UnknownDevice
            );
        }
        assert_eq!(
            runtime
                .complete_handshake(&bad, &server_nonce, IP, now)
                .unwrap_err(),
            HandshakeError::RateLimited
        );
        // Another address is unaffected.
        let other = IpAddr::V4(std::net::Ipv4Addr::new(192, 168, 1, 51));
        assert_eq!(
            runtime
                .complete_handshake(&bad, &server_nonce, other, now)
                .unwrap_err(),
            HandshakeError::UnknownDevice
        );
        let later = now + AUTH_FAILURE_WINDOW + Duration::from_secs(1);
        assert_eq!(
            runtime
                .complete_handshake(&bad, &server_nonce, IP, later)
                .unwrap_err(),
            HandshakeError::UnknownDevice
        );

        // Malformed frames never count: a flaky client cannot lock itself out.
        let mut runtime = LanRuntime::default();
        let malformed = ClientHello::Auth {
            device_id: "nope".to_string(),
            client_nonce: "short".to_string(),
            mac: String::new(),
        };
        for _ in 0..(AUTH_FAILURE_LIMIT * 2) {
            assert_eq!(
                runtime
                    .complete_handshake(&malformed, &server_nonce, IP, now)
                    .unwrap_err(),
                HandshakeError::Malformed
            );
        }
    }

    fn sign(key: &[u8; 32], seq: u64, body: &str) -> String {
        serde_json::json!({
            "seq": seq,
            "mac": b64(&mac(key, &["frame", &seq.to_string(), body])),
            "body": body,
        })
        .to_string()
    }

    #[test]
    fn signed_frames_verify_and_reject_replay_tamper_and_foreign_keys() {
        let key = random_32();
        let mut verifier = SessionVerifier::new(key);
        let body = r#"{"id":"1","method":"remote.describe"}"#;
        assert_eq!(verifier.open(&sign(&key, 1, body)).unwrap(), body);
        // Replay of an accepted frame.
        assert_eq!(
            verifier.open(&sign(&key, 1, body)).unwrap_err(),
            EnvelopeError::Replayed
        );
        // Gaps are fine (a dropped frame must not wedge the socket).
        assert_eq!(verifier.open(&sign(&key, 5, body)).unwrap(), body);
        assert_eq!(
            verifier.open(&sign(&key, 4, body)).unwrap_err(),
            EnvelopeError::Replayed
        );
        // Tampered body under a valid-looking envelope.
        let tampered = sign(&key, 6, body).replace("remote.describe", "remote.intentXX");
        assert_eq!(verifier.open(&tampered).unwrap_err(), EnvelopeError::BadMac);
        // Seq swapped onto another frame's MAC.
        let reseq = sign(&key, 7, body).replace("\"seq\":7", "\"seq\":8");
        assert_eq!(verifier.open(&reseq).unwrap_err(), EnvelopeError::BadMac);
        assert_eq!(
            verifier.open(&sign(&random_32(), 9, body)).unwrap_err(),
            EnvelopeError::BadMac
        );
        // A bare (unsigned) protocol-1 command is not an envelope.
        assert_eq!(verifier.open(body).unwrap_err(), EnvelopeError::Malformed);
        let huge = "x".repeat(MAX_FRAME_BYTES + 1);
        assert_eq!(verifier.open(&huge).unwrap_err(), EnvelopeError::TooLarge);
    }

    #[test]
    fn device_names_are_sanitised() {
        assert_eq!(sanitize_device_name("  \u{7}  "), "Phone");
        assert_eq!(sanitize_device_name("Pixel\n8"), "Pixel8");
        assert_eq!(
            sanitize_device_name(&"a".repeat(100)).chars().count(),
            MAX_DEVICE_NAME_CHARS
        );
    }

    fn full_message() -> serde_json::Value {
        serde_json::json!({
            "id": "youtube:abc",
            "providerMessageId": "abc",
            "platform": "youtube",
            "targetId": "target-secret",
            "sessionId": "session-secret",
            "authorId": "UC-author-secret",
            "authorName": "Viewer",
            "authorAvatarUrl": "https://yt3.ggpht.com/avatar.png",
            "authorBadges": ["member"],
            "authorRoles": ["moderator"],
            "publishedAt": "2026-09-18T10:00:00Z",
            "receivedAt": "2026-09-18T10:00:01Z",
            "messageText": "hello",
            "fragments": [
                { "type": "text", "text": "hello " },
                { "type": "emote", "text": ":wave:", "imageUrl": "https://cdn.example/wave.png" }
            ],
            "eventType": "paid",
            "amountText": "$5.00",
            "isDeleted": false,
            "rawProviderType": "superChatEvent"
        })
    }

    #[test]
    fn chat_projection_leaks_no_identity_or_urls() {
        let projected = project_chat_message(&full_message()).unwrap();
        let text = projected.to_string();
        for forbidden in [
            "authorId",
            "authorAvatarUrl",
            "targetId",
            "sessionId",
            "providerMessageId",
            "rawProviderType",
            "receivedAt",
            "imageUrl",
            "http",
            "secret",
        ] {
            assert!(!text.contains(forbidden), "projection leaked {forbidden}");
        }
        assert_eq!(projected["id"], "youtube:abc");
        assert_eq!(projected["authorName"], "Viewer");
        assert_eq!(projected["amountText"], "$5.00");
        assert_eq!(projected["fragments"][1]["text"], ":wave:");
    }

    #[test]
    fn projection_is_skipped_without_clients_and_snapshots_are_bounded() {
        let lan = new_remote_lan_slot(LanRuntime::default());
        assert!(project_event(&lan, "liveChat.message", &full_message()).is_none());

        lan.connected_clients.store(1, Ordering::Relaxed);
        let (event, payload) = project_event(&lan, "liveChat.message", &full_message()).unwrap();
        assert_eq!(event, "remote.chat.message");
        assert_eq!(payload["chatSeq"], 1);

        let messages: Vec<_> = (0..(CHAT_SNAPSHOT_LIMIT + 50))
            .map(|index| {
                let mut message = full_message();
                message["id"] = serde_json::json!(format!("youtube:{index}"));
                message
            })
            .collect();
        let snapshot = serde_json::json!({ "sessionId": "session-secret", "messages": messages });
        let (event, payload) = project_event(&lan, "liveChat.cleared", &snapshot).unwrap();
        assert_eq!(event, "remote.chat.reset");
        assert_eq!(payload["chatSeq"], 2);
        let projected = payload["messages"].as_array().unwrap();
        assert_eq!(projected.len(), CHAT_SNAPSHOT_LIMIT);
        assert_eq!(projected[0]["id"], "youtube:50", "keeps the newest");
        assert!(!payload.to_string().contains("session-secret"));

        let (event, payload) = project_event(
            &lan,
            "comments.highlight.status",
            &serde_json::json!({
                "sessionId": "session-secret", "messageId": "youtube:abc",
                "generation": 4, "phase": "live", "expiresAt": "2026-09-18T10:00:10Z"
            }),
        )
        .unwrap();
        assert_eq!(event, "remote.highlight");
        assert_eq!(payload["phase"], "live");
        assert!(payload.get("sessionId").is_none());
        assert!(project_event(&lan, "session.state", &serde_json::json!({})).is_none());
    }

    #[test]
    fn tunnel_and_public_interfaces_are_never_offered() {
        use std::net::Ipv4Addr;
        assert!(is_candidate_lan_interface(
            "en0",
            Ipv4Addr::new(192, 168, 1, 5)
        ));
        assert!(is_candidate_lan_interface(
            "Wi-Fi",
            Ipv4Addr::new(10, 0, 0, 5)
        ));
        assert!(!is_candidate_lan_interface(
            "utun4",
            Ipv4Addr::new(10, 8, 0, 2)
        ));
        assert!(!is_candidate_lan_interface(
            "bridge100",
            Ipv4Addr::new(192, 168, 64, 1)
        ));
        assert!(!is_candidate_lan_interface(
            "vEthernet (WSL)",
            Ipv4Addr::new(172, 20, 0, 1)
        ));
        assert!(!is_candidate_lan_interface(
            "en0",
            Ipv4Addr::new(8, 8, 8, 8)
        ));
        assert!(!is_candidate_lan_interface(
            "en0",
            Ipv4Addr::new(169, 254, 1, 1)
        ));
        assert!(!is_candidate_lan_interface(
            "lo0",
            Ipv4Addr::new(127, 0, 0, 1)
        ));
    }
}
