//! The Videorc app without a UI: the typed backend client, the supervisor, the Studio state machine and every page's view-model, the smoke command server, settings. It never depends on GPUI (a test enforces it).
//!
//! Plan 260: the shell modules (the app log, the crash log, the restart
//! policy, and then the process launch, paths, the supervisor, the typed
//! client and `desktop/`) are L4's, lifted from `videorc-rust`'s app-core;
//! the product areas arrive in S1.6a to S1.6f. Module paths match
//! `videorc-rust`, so the crates that move from there (L1's
//! `videorc-preview`) compile unchanged.

pub mod client;
pub mod crash_log;
pub mod desktop;
mod http;
pub mod interruption;
pub mod ledger;
pub mod log;
pub mod nav;
pub mod notices;
pub mod paths;
pub mod process;
pub mod restart;
pub mod studio;
pub mod supervisor;

pub use client::{BackendClient, BackendEvent, ClientConfig, ConnectionState, EventFilter};
pub use log::{Level, LogFileLimits, Logger, RotatingLogFile};
pub use paths::AppPaths;
pub use process::{
    BackendBootstrap, BackendLaunch, BackendOwnership, BackendProcess, BackendStopReport,
    Credential, Isolation, process_is_alive,
};
pub use supervisor::{BackendState, StopOutcome, Supervisor, SupervisorConfig, Tone};
pub use videorc_protocol as protocol;
