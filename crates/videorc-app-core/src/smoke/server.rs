//! The loopback HTTP server the smokes talk to (plan 220 S2.5a): the same
//! interface as Electron main's (`handleSmokeCommandRequest` in
//! `smoke-command-security.ts`, served by `startSmokePreviewMotionServer` in
//! `index.ts`), so `scripts/lib/smoke-command-client.mjs` drives either app.
//!
//! - It listens on `127.0.0.1` only; [`SmokeServer::bind`] refuses any other
//!   address, and a peer that is not loopback is dropped unanswered.
//! - Every request is authenticated before it is routed: a missing or wrong
//!   `Authorization: Bearer <capability>` is a 401, whatever the path.
//! - `GET /health` answers `{"ok":true}`; `POST /command` takes
//!   `{"command","params"}` and answers `{"ok":true,"result":…}` (200) or
//!   `{"ok":false,"error":"…"}`: 400 for bad JSON or an unknown or malformed
//!   command, 403 for a command outside a packaged harness's subset, 413 for
//!   a body over 1 MiB, 500 when the command itself fails. Anything else is
//!   a 404.
//! - One request per connection (`Connection: close`), which is what the
//!   client sends: it opens a fresh socket for every command so a mutation
//!   is never replayed.
//!
//! Small and dependency-free on purpose: the requests are a handful of JSON
//! bodies from one local script.

use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::{JoinHandle, JoinSet};

use super::security::{self, MAX_REQUEST_BODY_BYTES, messages};

/// What a command answers: the `result`, or the `error` sentence.
pub type CommandFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;

/// Runs one validated command (`runSmokePreviewMotionCommand`).
pub trait SmokeCommandRunner: Send + Sync + 'static {
    fn run<'a>(&'a self, command: &'a str, params: Map<String, Value>) -> CommandFuture<'a>;
}

/// The policy one server enforces.
#[derive(Debug, Clone)]
pub struct SmokeServerOptions {
    /// The bearer every request must carry.
    pub capability: String,
    /// A packaged harness's subset (`PACKAGED_SMOKE_COMMAND_NAMES`); `None`
    /// lets every known command through.
    pub allowed_commands: Option<&'static [&'static str]>,
}

/// Node's default header ceiling.
const MAX_HEAD_BYTES: usize = 16 * 1024;
const MAX_CHUNK_LINE_BYTES: usize = 1024;
/// For the head and the body, each.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// After the answer, unread request bytes are drained for this long so the
/// close is a FIN, not a reset that could swallow the answer.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
const DRAIN_LIMIT_BYTES: usize = 4 * MAX_REQUEST_BODY_BYTES;
/// How long a stopping server lets answers in flight finish.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

/// A running server.
pub struct SmokeServer {
    local_addr: SocketAddr,
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

impl SmokeServer {
    /// Listens on `address`, which must be a loopback address.
    pub async fn bind(
        address: SocketAddr,
        options: SmokeServerOptions,
        runner: Arc<dyn SmokeCommandRunner>,
    ) -> Result<Self> {
        if !address.ip().to_canonical().is_loopback() {
            bail!("the smoke command server listens on loopback only; refusing {address}");
        }
        if options.capability.is_empty() {
            bail!("the smoke command server needs a capability");
        }
        let listener = TcpListener::bind(address)
            .await
            .with_context(|| format!("the smoke command server could not listen on {address}"))?;
        let local_addr = listener.local_addr()?;
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(accept_loop(listener, Arc::new(options), runner, stopped));
        Ok(Self {
            local_addr,
            stop: Some(stop),
            task,
        })
    }

    /// Listens on `127.0.0.1` on a free port, as Electron does
    /// (`listen(0, '127.0.0.1')`).
    pub async fn bind_loopback(
        options: SmokeServerOptions,
        runner: Arc<dyn SmokeCommandRunner>,
    ) -> Result<Self> {
        Self::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)), options, runner).await
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Stops listening, lets answers in flight finish (briefly), and ends.
    pub async fn shutdown(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let _ = (&mut self.task).await;
    }
}

impl Drop for SmokeServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Only loopback peers are answered.
pub fn peer_allowed(peer: SocketAddr) -> bool {
    peer.ip().to_canonical().is_loopback()
}

async fn accept_loop(
    listener: TcpListener,
    options: Arc<SmokeServerOptions>,
    runner: Arc<dyn SmokeCommandRunner>,
    mut stopped: oneshot::Receiver<()>,
) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            _ = &mut stopped => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, peer)) => {
                    if !peer_allowed(peer) {
                        drop(stream);
                        continue;
                    }
                    connections.spawn(handle_connection(stream, options.clone(), runner.clone()));
                }
                // EMFILE and the like: back off instead of spinning.
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            },
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
    drop(listener);
    let _ = tokio::time::timeout(SHUTDOWN_GRACE, async {
        while connections.join_next().await.is_some() {}
    })
    .await;
    connections.abort_all();
}

/// The request line and headers, and whatever body bytes came with them.
struct Head {
    method: String,
    target: String,
    /// Names lowercased, in arrival order.
    headers: Vec<(String, String)>,
    rest: Vec<u8>,
}

impl Head {
    /// The first value of `name` (Node keeps the first `authorization`).
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header, _)| header == name)
            .map(|(_, value)| value.as_str())
    }
}

enum HeadError {
    /// The peer went away or never finished: nothing to answer.
    Gone,
    TooLarge,
    Malformed,
}

enum BodyError {
    Gone,
    TooLarge,
    Malformed(&'static str),
}

async fn handle_connection(
    mut stream: TcpStream,
    options: Arc<SmokeServerOptions>,
    runner: Arc<dyn SmokeCommandRunner>,
) {
    let head = match tokio::time::timeout(READ_TIMEOUT, read_head(&mut stream)).await {
        Ok(Ok(head)) => Ok(head),
        Ok(Err(HeadError::TooLarge)) => Err((431, "Smoke request headers are too large.")),
        Ok(Err(HeadError::Malformed)) => Err((400, "Malformed smoke request.")),
        Ok(Err(HeadError::Gone)) | Err(_) => return,
    };
    let (status, payload) = match head {
        Ok(head) => match respond(&mut stream, head, &options, runner.as_ref()).await {
            Some(answer) => answer,
            None => return,
        },
        Err((status, message)) => (status, failure(message)),
    };
    if write_json(&mut stream, status, &payload).await.is_err() {
        return;
    }
    let _ = stream.shutdown().await;
    drain(&mut stream).await;
}

fn failure(message: impl Into<String>) -> Value {
    json!({ "ok": false, "error": message.into() })
}

/// `handleSmokeCommandRequest`, in its order: authenticate, route, read,
/// validate, gate, run. `None` when the peer left mid-body.
async fn respond(
    stream: &mut TcpStream,
    head: Head,
    options: &SmokeServerOptions,
    runner: &dyn SmokeCommandRunner,
) -> Option<(u16, Value)> {
    if !security::smoke_request_authorized(head.header("authorization"), &options.capability) {
        return Some((401, failure(messages::INVALID_CAPABILITY)));
    }
    if head.method == "GET" && head.target == "/health" {
        return Some((200, json!({ "ok": true })));
    }
    if head.method != "POST" || head.target != "/command" {
        return Some((404, failure(messages::UNKNOWN_ENDPOINT)));
    }

    let body = match tokio::time::timeout(READ_TIMEOUT, read_body(stream, &head)).await {
        Ok(Ok(body)) => body,
        Ok(Err(BodyError::TooLarge)) => return Some((413, failure(messages::BODY_TOO_LARGE))),
        Ok(Err(BodyError::Malformed(message))) => return Some((400, failure(message))),
        Ok(Err(BodyError::Gone)) | Err(_) => return None,
    };
    let value: Value = if body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&body) {
            Ok(value) => value,
            Err(error) => return Some((400, failure(error.to_string()))),
        }
    };
    let Some(validated) = security::validate_smoke_command_payload(&value) else {
        return Some((400, failure(messages::INVALID_COMMAND)));
    };
    if let Some(allowed) = options.allowed_commands
        && !allowed.contains(&validated.command.as_str())
    {
        return Some((403, failure(messages::UNAVAILABLE_IN_MODE)));
    }
    Some(
        match runner.run(&validated.command, validated.params).await {
            Ok(result) => (200, json!({ "ok": true, "result": result })),
            Err(error) => (500, failure(error)),
        },
    )
}

async fn read_head(stream: &mut TcpStream) -> Result<Head, HeadError> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 4096];
    let end = loop {
        if let Some(index) = find(&buffer, b"\r\n\r\n") {
            break index;
        }
        if buffer.len() > MAX_HEAD_BYTES {
            return Err(HeadError::TooLarge);
        }
        let read = stream.read(&mut chunk).await.map_err(|_| HeadError::Gone)?;
        if read == 0 {
            return Err(HeadError::Gone);
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    if end > MAX_HEAD_BYTES {
        return Err(HeadError::TooLarge);
    }
    let rest = buffer.split_off(end + 4);
    let text = std::str::from_utf8(&buffer[..end]).map_err(|_| HeadError::Malformed)?;
    let mut lines = text.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split(' ');
    let (Some(method), Some(target), Some(version), None) = (
        request_line.next(),
        request_line.next(),
        request_line.next(),
        request_line.next(),
    ) else {
        return Err(HeadError::Malformed);
    };
    if method.is_empty() || target.is_empty() || !version.starts_with("HTTP/1.") {
        return Err(HeadError::Malformed);
    }
    let mut headers = Vec::new();
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(HeadError::Malformed)?;
        if name.is_empty() || name.bytes().any(|byte| byte.is_ascii_whitespace()) {
            return Err(HeadError::Malformed);
        }
        headers.push((name.to_ascii_lowercase(), value.trim().to_string()));
    }
    Ok(Head {
        method: method.to_string(),
        target: target.to_string(),
        headers,
        rest,
    })
}

/// The body by `Content-Length` or chunked, at most 1 MiB.
async fn read_body(stream: &mut TcpStream, head: &Head) -> Result<Vec<u8>, BodyError> {
    let chunked = head
        .header("transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"));
    let length = match head.header("content-length") {
        Some(_) if chunked => {
            return Err(BodyError::Malformed(
                "Content-Length and chunked encoding together.",
            ));
        }
        Some(value) => Some(
            value
                .parse::<usize>()
                .map_err(|_| BodyError::Malformed("Invalid Content-Length."))?,
        ),
        None => None,
    };
    if length.is_some_and(|length| length > MAX_REQUEST_BODY_BYTES) {
        return Err(BodyError::TooLarge);
    }
    if !chunked && length.unwrap_or(0) == 0 {
        return Ok(Vec::new());
    }
    if head
        .header("expect")
        .is_some_and(|value| value.eq_ignore_ascii_case("100-continue"))
    {
        stream
            .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
            .await
            .map_err(|_| BodyError::Gone)?;
    }
    let mut reader = BodyReader {
        stream,
        buffer: head.rest.clone(),
        position: 0,
    };
    match length {
        Some(length) => reader.take(length).await,
        None => {
            let mut body = Vec::new();
            loop {
                let line = reader.line().await?;
                let size_text = line.split(';').next().unwrap_or_default().trim();
                let size = usize::from_str_radix(size_text, 16)
                    .map_err(|_| BodyError::Malformed("Invalid chunk size."))?;
                if size == 0 {
                    // Trailers, up to the empty line.
                    while !reader.line().await?.is_empty() {}
                    return Ok(body);
                }
                if body.len() + size > MAX_REQUEST_BODY_BYTES {
                    return Err(BodyError::TooLarge);
                }
                body.extend_from_slice(&reader.take(size).await?);
                if !reader.line().await?.is_empty() {
                    return Err(BodyError::Malformed("Invalid chunk terminator."));
                }
            }
        }
    }
}

struct BodyReader<'a> {
    stream: &'a mut TcpStream,
    buffer: Vec<u8>,
    position: usize,
}

impl BodyReader<'_> {
    async fn fill(&mut self) -> Result<(), BodyError> {
        let mut chunk = [0_u8; 8192];
        let read = self
            .stream
            .read(&mut chunk)
            .await
            .map_err(|_| BodyError::Gone)?;
        if read == 0 {
            return Err(BodyError::Gone);
        }
        self.buffer.drain(..self.position);
        self.position = 0;
        self.buffer.extend_from_slice(&chunk[..read]);
        Ok(())
    }

    async fn take(&mut self, length: usize) -> Result<Vec<u8>, BodyError> {
        while self.buffer.len() - self.position < length {
            self.fill().await?;
        }
        let bytes = self.buffer[self.position..self.position + length].to_vec();
        self.position += length;
        Ok(bytes)
    }

    async fn line(&mut self) -> Result<String, BodyError> {
        loop {
            if let Some(index) = find(&self.buffer[self.position..], b"\r\n") {
                let line =
                    String::from_utf8_lossy(&self.buffer[self.position..self.position + index])
                        .into_owned();
                self.position += index + 2;
                return Ok(line);
            }
            if self.buffer.len() - self.position > MAX_CHUNK_LINE_BYTES {
                return Err(BodyError::Malformed("Invalid chunk line."));
            }
            self.fill().await?;
        }
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        _ => "Internal Server Error",
    }
}

/// `writeJson`: JSON, never cached.
async fn write_json(stream: &mut TcpStream, status: u16, payload: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(payload).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
    let head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        reason(status),
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(&body).await?;
    stream.flush().await
}

async fn drain(stream: &mut TcpStream) {
    let _ = tokio::time::timeout(DRAIN_TIMEOUT, async {
        let mut chunk = [0_u8; 8192];
        let mut drained = 0;
        while drained < DRAIN_LIMIT_BYTES {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(read) => drained += read,
            }
        }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv6Addr};

    use super::*;

    #[test]
    fn only_loopback_peers_are_answered() {
        assert!(peer_allowed(SocketAddr::from((Ipv4Addr::LOCALHOST, 5000))));
        assert!(peer_allowed(SocketAddr::from((Ipv6Addr::LOCALHOST, 5000))));
        assert!(peer_allowed(SocketAddr::new(
            IpAddr::V6(Ipv4Addr::LOCALHOST.to_ipv6_mapped()),
            5000
        )));
        assert!(!peer_allowed(SocketAddr::from((
            Ipv4Addr::new(192, 168, 1, 20),
            5000
        ))));
        assert!(!peer_allowed(SocketAddr::from((
            Ipv4Addr::UNSPECIFIED,
            5000
        ))));
        assert!(!peer_allowed(SocketAddr::new(
            IpAddr::V6(Ipv4Addr::new(10, 0, 0, 1).to_ipv6_mapped()),
            5000
        )));
    }

    #[test]
    fn finds_the_end_of_the_head() {
        assert_eq!(find(b"GET / HTTP/1.1\r\n\r\n", b"\r\n\r\n"), Some(14));
        assert_eq!(find(b"GET / HTTP/1.1\r\n", b"\r\n\r\n"), None);
    }
}
