//! `requestBackendAdmin` for the smoke commands: one request on an admin
//! socket of its own, with the ready backend's admin credential, within one
//! deadline in all. Only the commands Electron main runs on that credential
//! use it (`backend-debug-rpc`, `authorize-smoke-resource`,
//! `inspect-backend-state-isolation`); the Studio's client never holds it.
//!
//! The resources port (the pickers' capabilities) brings the app's own
//! admin channel; this one stays the smoke server's, behind [`AdminRpc`], so
//! a test can stand in for the backend.

use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::watch;

use crate::client::{BackendSocket, RpcError, codes};
use crate::process::Credential;
use crate::supervisor::BackendState;

/// `requestBackendAdmin`'s default deadline.
pub const ADMIN_TIMEOUT: Duration = Duration::from_millis(15_000);

pub type AdminFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;

/// One admin request; the error is main's sentence.
pub trait AdminRpc: Send + Sync + 'static {
    fn request<'a>(&'a self, method: &'a str, params: Value, timeout: Duration) -> AdminFuture<'a>;
}

/// The real channel: the supervisor's ready backend.
#[derive(Clone)]
pub struct SupervisorAdmin {
    backend: watch::Receiver<BackendState>,
}

impl SupervisorAdmin {
    pub fn new(backend: watch::Receiver<BackendState>) -> Self {
        Self { backend }
    }

    /// `waitForBackendAdminConnection`: the ready backend's admin credential.
    async fn credential(&self, timeout: Duration) -> Result<Credential, String> {
        let mut state = self.backend.clone();
        tokio::time::timeout(timeout.max(Duration::from_millis(1)), async {
            loop {
                if let Some(bootstrap) = state.borrow_and_update().bootstrap() {
                    return Ok(bootstrap.admin());
                }
                if state.changed().await.is_err() {
                    return Err(());
                }
            }
        })
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or_else(|| "Backend admin connection is unavailable.".to_string())
    }

    /// `requestBackendAdmin`.
    pub async fn send(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let started = Instant::now();
        let credential = self.credential(timeout).await?;
        let remaining = || {
            timeout
                .saturating_sub(started.elapsed())
                .max(Duration::from_millis(1))
        };
        let socket = BackendSocket::connect(&credential, remaining(), remaining())
            .await
            .map_err(|_| format!("Backend admin request {method} could not connect."))?;
        let result = socket
            .request_with_timeout(method, params, remaining())
            .await;
        socket.close().await;
        result.map_err(|error| admin_error_message(method, &error))
    }
}

impl AdminRpc for SupervisorAdmin {
    fn request<'a>(&'a self, method: &'a str, params: Value, timeout: Duration) -> AdminFuture<'a> {
        Box::pin(self.send(method, params, timeout))
    }
}

/// `requestBackendAdmin`'s failures, in main's words: the backend's own
/// message when it answered, otherwise how the request ended.
pub fn admin_error_message(method: &str, error: &RpcError) -> String {
    match error.code.as_str() {
        codes::REQUEST_OUTCOME_UNKNOWN | codes::NOT_SENT => {
            format!("Backend admin request {method} timed out.")
        }
        codes::NOT_CONNECTED | codes::CONNECTION_CLOSED => {
            format!("Backend admin request {method} closed early.")
        }
        _ if error.message.is_empty() => format!("Backend admin request {method} failed."),
        _ => error.message.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_failures_read_like_main_s() {
        let error = |code: &str, message: &str| RpcError::new("health.ping", code, message);
        assert_eq!(
            admin_error_message("health.ping", &error(codes::REQUEST_OUTCOME_UNKNOWN, "x")),
            "Backend admin request health.ping timed out."
        );
        assert_eq!(
            admin_error_message("health.ping", &error(codes::CONNECTION_CLOSED, "x")),
            "Backend admin request health.ping closed early."
        );
        assert_eq!(
            admin_error_message("health.ping", &error("forbidden", "")),
            "Backend admin request health.ping failed."
        );
        assert_eq!(
            admin_error_message("health.ping", &error("forbidden", "Admin only.")),
            "Admin only."
        );
    }
}
