//! The session bus for the Linux platform (plan 260 S2.6c): one small Tokio
//! runtime of its own with one zbus connection, shared by the Inhibit
//! blocker, the Secret Service store and the GlobalShortcuts portal.
//!
//! The core's traits (`desktop::linux`) are synchronous, and their callers
//! run anywhere: the sleep guard's start inside a task of the core's runtime,
//! the keyring on the main thread. So every call is spawned onto this runtime
//! and waited for on a plain channel, with a deadline: a bus that doesn't
//! answer costs the caller [`CALL_DEADLINE`], never a hang, and never a
//! `block_on` inside another runtime.

use std::future::Future;
use std::sync::mpsc;
use std::time::Duration;

use ashpd::zbus;

/// How long a caller waits for the bus.
pub const CALL_DEADLINE: Duration = Duration::from_secs(5);

pub struct Bus {
    runtime: tokio::runtime::Runtime,
    connection: std::sync::Arc<tokio::sync::OnceCell<zbus::Connection>>,
}

impl Bus {
    pub fn new() -> Result<Self, String> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .thread_name("videorc-dbus")
            .enable_all()
            .build()
            .map_err(|error| format!("the D-Bus runtime didn't start: {error}"))?;
        Ok(Self {
            runtime,
            connection: Default::default(),
        })
    }

    /// The session bus connection, opened on first use.
    pub fn connection(
        &self,
    ) -> impl Future<Output = Result<zbus::Connection, String>> + Send + 'static {
        let cell = self.connection.clone();
        async move {
            cell.get_or_try_init(zbus::Connection::session)
                .await
                .cloned()
                .map_err(|error| format!("no session bus: {error}"))
        }
    }

    /// Runs `work` on the bus's runtime and waits for it, up to `deadline`.
    pub fn call<T, F>(&self, deadline: Duration, work: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: Future<Output = Result<T, String>> + Send + 'static,
    {
        let (sender, receiver) = mpsc::sync_channel(1);
        self.runtime.spawn(async move {
            let _ = sender.send(work.await);
        });
        receiver
            .recv_timeout(deadline)
            .map_err(|_| "the session bus didn't answer in time".to_string())?
    }

    /// Starts `work` on the bus's runtime without waiting (signal streams).
    pub fn spawn<F>(&self, work: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.runtime.spawn(work);
    }
}
