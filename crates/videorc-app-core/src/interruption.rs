//! The backend's interruption lease (plan 220 S2.6b), as Electron main takes
//! it (`main/backend-interruption.ts`, `main/interruption-actions.ts`).
//!
//! Before an action that stops capture (a permission's backend restart,
//! Reopen Videorc), main asks the backend for a lease on its admin
//! credential: the backend refuses (409) while a recording, a livestream or
//! a start runs, and while the lease is held it refuses new starts. The
//! lease is consumed before the action and renewed while it runs; on
//! success it is kept for its bounded TTL (the action stops the backend),
//! on failure it is released. A lost response is retried once with the same
//! owner id, so the backend hands back the lease it already committed.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, anyhow};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::process::BackendBootstrap;

/// Electron's per-request timeout for consume, renew and release.
pub const REQUEST_TIMEOUT: Duration = Duration::from_millis(1_000);
/// `ACQUIRE_REQUEST_TIMEOUT_MS`: admission first hands over from a running
/// Clips buffer (plan 181), which the backend bounds.
pub const ACQUIRE_REQUEST_TIMEOUT: Duration = Duration::from_millis(20_000);
const MAX_RESPONSE_BYTES: usize = 4_096;
const MAX_LEASE_ID_LENGTH: usize = 128;
const REQUEST_ATTEMPTS: usize = 2;

pub type LeaseFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What the lease is for (the backend logs it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InterruptionAction {
    PermissionRestart,
    UpdateInstall,
}

impl InterruptionAction {
    pub fn as_str(self) -> &'static str {
        match self {
            InterruptionAction::PermissionRestart => "permission-restart",
            InterruptionAction::UpdateInstall => "update-install",
        }
    }
}

/// Where the lease lives: the ready backend's loopback port and its admin
/// token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseEndpoint {
    pub host: String,
    pub port: u16,
    pub token: String,
}

impl LeaseEndpoint {
    /// The admin credential of a ready backend.
    pub fn admin(bootstrap: &BackendBootstrap) -> Self {
        Self {
            host: bootstrap.host.clone(),
            port: bootstrap.port,
            token: bootstrap.admin_token.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    Post,
    Put,
    Delete,
}

impl HttpMethod {
    fn as_str(self) -> &'static str {
        match self {
            HttpMethod::Post => "POST",
            HttpMethod::Put => "PUT",
            HttpMethod::Delete => "DELETE",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// `BackendInterruptionTransport`: one HTTP request to the backend.
pub trait InterruptionTransport: Send + Sync {
    fn send<'a>(
        &'a self,
        endpoint: &'a LeaseEndpoint,
        method: HttpMethod,
        path: String,
        timeout: Duration,
    ) -> LeaseFuture<'a, Result<HttpResponse, String>>;
}

/// The real transport: one loopback HTTP/1.1 request per call, the body
/// capped at 4096 bytes.
pub struct LoopbackHttp;

impl InterruptionTransport for LoopbackHttp {
    fn send<'a>(
        &'a self,
        endpoint: &'a LeaseEndpoint,
        method: HttpMethod,
        path: String,
        timeout: Duration,
    ) -> LeaseFuture<'a, Result<HttpResponse, String>> {
        Box::pin(async move {
            tokio::time::timeout(timeout, http_request(endpoint, method, &path))
                .await
                .map_err(|_| "Backend interruption request timed out.".to_string())?
                .map_err(|error| format!("{error:#}"))
        })
    }
}

async fn http_request(
    endpoint: &LeaseEndpoint,
    method: HttpMethod,
    path: &str,
) -> anyhow::Result<HttpResponse> {
    let mut stream = TcpStream::connect((endpoint.host.as_str(), endpoint.port))
        .await
        .with_context(|| format!("could not connect to {}:{}", endpoint.host, endpoint.port))?;
    let request = format!(
        "{} {path} HTTP/1.1\r\nHost: {}:{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        method.as_str(),
        endpoint.host,
        endpoint.port
    );
    stream.write_all(request.as_bytes()).await?;
    let mut raw = Vec::new();
    // Head and body together: a few hundred bytes over the body's cap is
    // plenty for the head, and anything larger is refused below.
    (&mut stream)
        .take((MAX_RESPONSE_BYTES * 2) as u64)
        .read_to_end(&mut raw)
        .await?;
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| anyhow!("malformed HTTP response"))?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| anyhow!("malformed HTTP status line"))?;
    let chunked = head
        .lines()
        .any(|line| line.to_ascii_lowercase().trim() == "transfer-encoding: chunked");
    let body = if chunked {
        decode_chunked(body)
    } else {
        body.to_string()
    };
    if body.len() > MAX_RESPONSE_BYTES {
        return Err(anyhow!(
            "Backend interruption response exceeded 4096 bytes."
        ));
    }
    Ok(HttpResponse { status, body })
}

fn decode_chunked(body: &str) -> String {
    let mut decoded = String::new();
    let mut rest = body;
    while let Some((size_line, after)) = rest.split_once("\r\n") {
        let size = usize::from_str_radix(size_line.trim().split(';').next().unwrap_or("0"), 16)
            .unwrap_or(0);
        if size == 0 || after.len() < size {
            break;
        }
        decoded.push_str(&after[..size]);
        rest = after[size..].strip_prefix("\r\n").unwrap_or("");
    }
    decoded
}

/// `interruptionPath`: the reason is cut at 256 characters, the query
/// encoded as `URLSearchParams` does (a space is `+`).
pub fn acquire_path(
    endpoint: &LeaseEndpoint,
    owner_id: &str,
    action: InterruptionAction,
    reason: &str,
) -> String {
    let reason: String = reason.chars().take(256).collect();
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("token", &endpoint.token)
        .append_pair("ownerId", owner_id)
        .append_pair("action", action.as_str())
        .append_pair("reason", &reason)
        .finish();
    format!("/interruption/lease?{query}")
}

fn lease_path(endpoint: &LeaseEndpoint, lease_id: &str, suffix: &str) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("token", &endpoint.token)
        .finish();
    let id: String = url::form_urlencoded::byte_serialize(lease_id.as_bytes()).collect();
    format!("/interruption/lease/{id}{suffix}?{query}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedGrant {
    id: String,
    expires_in_ms: u64,
    consumed: bool,
}

fn parse_lease_grant(body: &str) -> Result<ParsedGrant, String> {
    let parsed: Value = serde_json::from_str(body)
        .map_err(|_| "Backend returned malformed interruption lease JSON.".to_string())?;
    let id = parsed.get("leaseId").and_then(Value::as_str);
    let Some(id) = id.filter(|id| {
        !id.is_empty()
            && id.len() <= MAX_LEASE_ID_LENGTH
            && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    }) else {
        return Err("Backend returned an invalid interruption lease id.".to_string());
    };
    let expires_in_ms = parsed
        .get("expiresInMs")
        .and_then(Value::as_u64)
        .filter(|ms| (100..=120_000).contains(ms));
    let consumed = parsed.get("consumed").and_then(Value::as_bool);
    let (Some(expires_in_ms), Some(consumed)) = (expires_in_ms, consumed) else {
        return Err("Backend returned invalid interruption lease timing metadata.".to_string());
    };
    Ok(ParsedGrant {
        id: id.to_string(),
        expires_in_ms,
        consumed,
    })
}

async fn retry<T, F, Fut>(mut request: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    let mut last = String::new();
    for _ in 0..REQUEST_ATTEMPTS {
        match request().await {
            Ok(value) => return Ok(value),
            Err(error) => last = error,
        }
    }
    Err(last)
}

/// A lease the backend granted (`BackendInterruptionLease`).
pub trait Lease: Send + Sync {
    fn id(&self) -> &str;
    fn expires_in_ms(&self) -> u64;
    fn consume(&self) -> LeaseFuture<'_, Result<(), String>>;
    fn renew(&self) -> LeaseFuture<'_, Result<(), String>>;
    fn release(&self) -> LeaseFuture<'_, Result<(), String>>;
}

/// The backend's lease over HTTP.
pub struct BackendLease {
    endpoint: LeaseEndpoint,
    transport: Arc<dyn InterruptionTransport>,
    id: String,
    timing: Mutex<(u64, bool)>,
}

impl BackendLease {
    pub fn consumed(&self) -> bool {
        self.timing.lock().map(|timing| timing.1).unwrap_or(false)
    }

    async fn mutate(&self, method: HttpMethod, suffix: &str) -> Result<(), String> {
        let next = retry(|| async {
            let response = self
                .transport
                .send(
                    &self.endpoint,
                    method,
                    lease_path(&self.endpoint, &self.id, suffix),
                    REQUEST_TIMEOUT,
                )
                .await?;
            if response.status != 200 {
                return Err(format!(
                    "Backend interruption lease mutation failed with HTTP {}.",
                    response.status
                ));
            }
            parse_lease_grant(&response.body)
        })
        .await?;
        if next.id != self.id {
            return Err(
                "Backend changed interruption lease identity during the operation.".to_string(),
            );
        }
        if let Ok(mut timing) = self.timing.lock() {
            *timing = (next.expires_in_ms, next.consumed);
        }
        Ok(())
    }
}

impl Lease for BackendLease {
    fn id(&self) -> &str {
        &self.id
    }

    fn expires_in_ms(&self) -> u64 {
        self.timing.lock().map(|timing| timing.0).unwrap_or(0)
    }

    fn consume(&self) -> LeaseFuture<'_, Result<(), String>> {
        Box::pin(self.mutate(HttpMethod::Post, "/consume"))
    }

    fn renew(&self) -> LeaseFuture<'_, Result<(), String>> {
        Box::pin(self.mutate(HttpMethod::Put, ""))
    }

    fn release(&self) -> LeaseFuture<'_, Result<(), String>> {
        Box::pin(async move {
            retry(|| async {
                let response = self
                    .transport
                    .send(
                        &self.endpoint,
                        HttpMethod::Delete,
                        lease_path(&self.endpoint, &self.id, ""),
                        REQUEST_TIMEOUT,
                    )
                    .await?;
                // 404 also proves the lease is no longer active.
                if response.status != 204 && response.status != 404 {
                    return Err(format!(
                        "Backend interruption release failed with HTTP {}.",
                        response.status
                    ));
                }
                Ok(())
            })
            .await
        })
    }
}

/// `acquireBackendInterruptionLease`: `None` when the backend refuses (a
/// session or a start won); an error when it could not be asked.
pub async fn acquire_interruption_lease(
    endpoint: LeaseEndpoint,
    action: InterruptionAction,
    reason: &str,
    owner_id: Option<String>,
    transport: Arc<dyn InterruptionTransport>,
) -> Result<Option<BackendLease>, String> {
    let owner_id = owner_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let path = acquire_path(&endpoint, &owner_id, action, reason);
    let grant = retry(|| async {
        let response = transport
            .send(
                &endpoint,
                HttpMethod::Post,
                path.clone(),
                ACQUIRE_REQUEST_TIMEOUT,
            )
            .await?;
        if response.status == 409 {
            return Ok(None);
        }
        if response.status != 201 {
            return Err(format!(
                "Backend interruption admission failed with HTTP {}.",
                response.status
            ));
        }
        parse_lease_grant(&response.body).map(Some)
    })
    .await?;
    Ok(grant.map(|grant| BackendLease {
        endpoint,
        transport,
        id: grant.id,
        timing: Mutex::new((grant.expires_in_ms, grant.consumed)),
    }))
}

/// `renewalIntervalMs`: a third of the TTL, between 250 ms and 2 s.
pub fn renewal_interval(expires_in_ms: u64) -> Duration {
    Duration::from_millis((expires_in_ms / 3).clamp(250, 2_000))
}

/// `runBackendInterruptingAction`: the action runs only after the backend
/// admitted it and the lease was consumed, renewed while it runs. False when
/// the backend refused; on an error the exact lease is released.
pub async fn run_interrupting_action<A>(
    lease: Option<Arc<dyn Lease>>,
    action: A,
) -> Result<bool, String>
where
    A: Future<Output = Result<(), String>>,
{
    let Some(lease) = lease else {
        return Ok(false);
    };
    let mut renewal: Option<tokio::task::JoinHandle<()>> = None;
    let outcome = async {
        lease.consume().await?;
        let renewing = lease.clone();
        let every = renewal_interval(lease.expires_in_ms());
        renewal = Some(tokio::spawn(async move {
            loop {
                tokio::time::sleep(every).await;
                // A lost renew is never permanent: the consumed lease keeps
                // its longer TTL and expires on its own.
                let _ = renewing.renew().await;
            }
        }));
        action.await
    }
    .await;
    if let Some(renewal) = renewal {
        renewal.abort();
    }
    match outcome {
        Ok(()) => Ok(true),
        Err(error) => {
            let _ = lease.release().await;
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};

    type Call = (HttpMethod, String, Duration);

    struct Scripted {
        answers: Mutex<VecDeque<Result<HttpResponse, String>>>,
        calls: Mutex<Vec<Call>>,
    }

    impl Scripted {
        fn new(answers: Vec<Result<HttpResponse, String>>) -> Arc<Self> {
            Arc::new(Self {
                answers: Mutex::new(answers.into()),
                calls: Mutex::new(Vec::new()),
            })
        }

        fn calls(&self) -> Vec<Call> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl InterruptionTransport for Scripted {
        fn send<'a>(
            &'a self,
            _endpoint: &'a LeaseEndpoint,
            method: HttpMethod,
            path: String,
            timeout: Duration,
        ) -> LeaseFuture<'a, Result<HttpResponse, String>> {
            self.calls.lock().unwrap().push((method, path, timeout));
            let answer = self
                .answers
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err("no scripted answer".to_string()));
            Box::pin(async move { answer })
        }
    }

    fn endpoint() -> LeaseEndpoint {
        LeaseEndpoint {
            host: "127.0.0.1".to_string(),
            port: 43123,
            token: "secret-token".to_string(),
        }
    }

    fn grant(consumed: bool, status: u16) -> Result<HttpResponse, String> {
        Ok(HttpResponse {
            status,
            body: serde_json::json!({
                "leaseId": "lease-123",
                "expiresInMs": if consumed { 30_000 } else { 5_000 },
                "consumed": consumed,
            })
            .to_string(),
        })
    }

    async fn acquire(transport: Arc<Scripted>) -> Result<Option<BackendLease>, String> {
        acquire_interruption_lease(
            endpoint(),
            InterruptionAction::PermissionRestart,
            "permission granted",
            Some("owner-123".to_string()),
            transport,
        )
        .await
    }

    #[tokio::test]
    async fn recovers_the_same_idempotent_acquire_after_the_committed_response_is_lost() {
        let transport = Scripted::new(vec![Err("response lost".to_string()), grant(false, 201)]);
        let lease = acquire(transport.clone()).await.unwrap().unwrap();
        assert_eq!(lease.id(), "lease-123");
        let calls = transport.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0], calls[1]);
        assert_eq!(
            calls[0],
            (
                HttpMethod::Post,
                "/interruption/lease?token=secret-token&ownerId=owner-123&action=permission-restart&reason=permission+granted".to_string(),
                ACQUIRE_REQUEST_TIMEOUT
            )
        );
    }

    #[tokio::test]
    async fn consumes_renews_and_releases_the_exact_lease() {
        let transport = Scripted::new(vec![
            grant(false, 201),
            grant(true, 200),
            grant(true, 200),
            Ok(HttpResponse {
                status: 204,
                body: String::new(),
            }),
        ]);
        let lease = acquire(transport.clone()).await.unwrap().unwrap();
        lease.consume().await.unwrap();
        assert!(lease.consumed());
        assert_eq!(lease.expires_in_ms(), 30_000);
        lease.renew().await.unwrap();
        lease.release().await.unwrap();
        let calls: Vec<(HttpMethod, String)> = transport
            .calls()
            .into_iter()
            .map(|(method, path, _)| (method, path))
            .collect();
        assert_eq!(
            calls[1..],
            [
                (
                    HttpMethod::Post,
                    "/interruption/lease/lease-123/consume?token=secret-token".to_string()
                ),
                (
                    HttpMethod::Put,
                    "/interruption/lease/lease-123?token=secret-token".to_string()
                ),
                (
                    HttpMethod::Delete,
                    "/interruption/lease/lease-123?token=secret-token".to_string()
                ),
            ]
        );
    }

    #[tokio::test]
    async fn retries_an_idempotent_release_when_the_first_response_is_lost() {
        let transport = Scripted::new(vec![
            grant(false, 201),
            Err("response lost".to_string()),
            Ok(HttpResponse {
                status: 404,
                body: String::new(),
            }),
        ]);
        let lease = acquire(transport.clone()).await.unwrap().unwrap();
        lease.release().await.unwrap();
        assert_eq!(transport.calls().len(), 3);
    }

    #[tokio::test]
    async fn returns_none_when_a_session_or_its_start_wins() {
        let transport = Scripted::new(vec![Ok(HttpResponse {
            status: 409,
            body: "{}".to_string(),
        })]);
        assert!(acquire(transport).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn refuses_a_malformed_grant() {
        for body in [
            "nope",
            r#"{"leaseId":"a b","expiresInMs":5000,"consumed":false}"#,
            r#"{"leaseId":"ok","expiresInMs":50,"consumed":false}"#,
            r#"{"leaseId":"ok","expiresInMs":5000}"#,
        ] {
            let transport = Scripted::new(vec![
                Ok(HttpResponse {
                    status: 201,
                    body: body.to_string(),
                }),
                Ok(HttpResponse {
                    status: 201,
                    body: body.to_string(),
                }),
            ]);
            assert!(acquire(transport).await.is_err(), "{body}");
        }
    }

    #[test]
    fn the_reason_is_cut_at_256_characters() {
        let path = acquire_path(
            &endpoint(),
            "o",
            InterruptionAction::UpdateInstall,
            &"x".repeat(300),
        );
        assert!(path.contains(&format!("reason={}", "x".repeat(256))));
        assert!(!path.contains(&"x".repeat(257)));
        assert!(path.contains("action=update-install"));
    }

    struct FakeLease {
        consumed: AtomicUsize,
        renewed: AtomicUsize,
        released: AtomicUsize,
        fail_consume: bool,
        expires_in_ms: u64,
    }

    impl FakeLease {
        fn new(fail_consume: bool, expires_in_ms: u64) -> Arc<Self> {
            Arc::new(Self {
                consumed: AtomicUsize::new(0),
                renewed: AtomicUsize::new(0),
                released: AtomicUsize::new(0),
                fail_consume,
                expires_in_ms,
            })
        }
    }

    impl Lease for FakeLease {
        fn id(&self) -> &str {
            "lease-1"
        }
        fn expires_in_ms(&self) -> u64 {
            self.expires_in_ms
        }
        fn consume(&self) -> LeaseFuture<'_, Result<(), String>> {
            self.consumed.fetch_add(1, Ordering::SeqCst);
            let fail = self.fail_consume;
            Box::pin(async move {
                if fail {
                    Err("consume failed".to_string())
                } else {
                    Ok(())
                }
            })
        }
        fn renew(&self) -> LeaseFuture<'_, Result<(), String>> {
            self.renewed.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }
        fn release(&self) -> LeaseFuture<'_, Result<(), String>> {
            self.released.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }
    }

    #[tokio::test]
    async fn does_not_run_when_admission_is_denied() {
        let ran = AtomicUsize::new(0);
        let admitted = run_interrupting_action(None, async {
            ran.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .await
        .unwrap();
        assert!(!admitted);
        assert_eq!(ran.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn consumes_before_the_action_and_keeps_the_lease_on_success() {
        let lease = FakeLease::new(false, 30_000);
        let seen = Arc::new(AtomicUsize::new(usize::MAX));
        let observed = lease.clone();
        let record = seen.clone();
        let admitted = run_interrupting_action(Some(lease.clone() as Arc<dyn Lease>), async move {
            record.store(observed.consumed.load(Ordering::SeqCst), Ordering::SeqCst);
            Ok(())
        })
        .await
        .unwrap();
        assert!(admitted);
        assert_eq!(seen.load(Ordering::SeqCst), 1, "consumed before the action");
        assert_eq!(lease.released.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn renews_while_the_action_runs() {
        let lease = FakeLease::new(false, 300);
        let admitted = run_interrupting_action(Some(lease.clone() as Arc<dyn Lease>), async {
            tokio::time::sleep(Duration::from_millis(700)).await;
            Ok(())
        })
        .await
        .unwrap();
        assert!(admitted);
        assert!(lease.renewed.load(Ordering::SeqCst) >= 1);
        assert_eq!(renewal_interval(300), Duration::from_millis(250));
        assert_eq!(renewal_interval(30_000), Duration::from_millis(2_000));
        assert_eq!(renewal_interval(3_000), Duration::from_millis(1_000));
    }

    #[tokio::test]
    async fn releases_the_exact_lease_when_consume_or_the_action_fails() {
        let lease = FakeLease::new(true, 30_000);
        let error =
            run_interrupting_action(Some(lease.clone() as Arc<dyn Lease>), async { Ok(()) })
                .await
                .unwrap_err();
        assert_eq!(error, "consume failed");
        assert_eq!(lease.released.load(Ordering::SeqCst), 1);

        let lease = FakeLease::new(false, 30_000);
        let error = run_interrupting_action(Some(lease.clone() as Arc<dyn Lease>), async {
            Err("action failed".to_string())
        })
        .await
        .unwrap_err();
        assert_eq!(error, "action failed");
        assert_eq!(lease.released.load(Ordering::SeqCst), 1);
    }
}
