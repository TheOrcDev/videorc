//! The smoke command server (plan 260 S2.5, from plan 220 S2.5a): the
//! smokes drive the GPUI app the way they drive Electron, through
//! `scripts/lib/smoke-command-client.mjs`, with `VIDEORC_APP=gpui`
//! (`scripts/lib/app-launcher.mjs`).
//!
//! - [`security`]: Electron's policy (`smoke-command-security.ts`): the
//!   command names, the per-run capability, the parameter bounds, the smoke
//!   resource grants, the debug RPC allowlist and the `ui-*` requests.
//! - [`server`]: the loopback HTTP server with Electron's request and answer
//!   shapes and status codes.
//! - [`commands`]: the core's commands (the quit, the admin credential's)
//!   and the [`SmokeCommandHandler`]s the app hands in for the rest: the
//!   Studio's and each window's. A known command nobody runs yet says so by
//!   name.
//! - [`admin`]: `requestBackendAdmin`, behind a trait.
//! - [`ui_tree`] and [`gpui_tree`]: the UI driver's window model, a GPUI
//!   window's AccessKit tree as plain data and the selectors the `ui-*`
//!   commands find elements with; `apps/videorc/src/smoke` runs them on the
//!   live windows.
//!
//! The switch is Electron's: `VIDEORC_SMOKE_COMMAND_SERVER=1` or
//! `VIDEORC_SMOKE_PREVIEW_MOTION=1` (or a Windows harness mode) turns the
//! server on; a packaged app also needs `VIDEORC_PACKAGED_SMOKE_TEST=1` and
//! the harness's own `VIDEORC_SMOKE_COMMAND_CAPABILITY`, then serves only
//! the packaged subset and never prints the capability. The app announces
//! the server on stdout with the marker the launcher waits for:
//!
//! ```text
//! [smoke] preview-motion-ready {"host":"127.0.0.1","port":…,"appPid":…,"capability":"…"}
//! [smoke] backend-ready {"host":"127.0.0.1","port":…,"token":"…","pid":…}
//! ```
//!
//! `backend-ready` (with `VIDEORC_SMOKE_PRINT_BACKEND_READY=1`) carries the
//! renderer-scoped credential only, on every backend generation; the admin
//! credential is never printed.

pub mod admin;
pub mod commands;
pub mod gpui_tree;
pub mod security;
pub mod server;
pub mod ui_tree;

use std::net::SocketAddr;

use serde_json::{Value, json};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::process::BackendBootstrap;
use crate::supervisor::BackendState;

pub use admin::{AdminRpc, SupervisorAdmin};
pub use commands::{
    APP_WINDOW_COMMANDS, AppSmokeCommands, AppSmokeConfig, QuitGuard, QuitHook, STUDIO_COMMANDS,
    SmokeCommandHandler,
};
pub use security::{
    ELECTRON_SMOKE_COMMAND_NAMES, PACKAGED_SMOKE_COMMAND_NAMES, RUST_SMOKE_COMMAND_NAMES,
    SMOKE_BACKEND_RPC_METHOD_NAMES,
};
pub use server::{CommandFuture, SmokeCommandRunner, SmokeServer, SmokeServerOptions};

/// What every marker line starts with (`MARKER_PREFIX` in `app-launcher.mjs`).
pub const MARKER_PREFIX: &str = "[smoke] ";

/// The environment switches, by name.
pub mod vars {
    pub const COMMAND_SERVER: &str = "VIDEORC_SMOKE_COMMAND_SERVER";
    pub const PREVIEW_MOTION: &str = "VIDEORC_SMOKE_PREVIEW_MOTION";
    pub const WINDOWS_LIVE_AUDIO: &str = "VIDEORC_WINDOWS_LIVE_AUDIO_SMOKE";
    pub const WINDOWS_D3D11_PREVIEW: &str = "VIDEORC_WINDOWS_D3D11_PREVIEW_SMOKE";
    pub const PACKAGED_SMOKE_TEST: &str = "VIDEORC_PACKAGED_SMOKE_TEST";
    pub const COMMAND_CAPABILITY: &str = "VIDEORC_SMOKE_COMMAND_CAPABILITY";
    pub const PRINT_BACKEND_READY: &str = "VIDEORC_SMOKE_PRINT_BACKEND_READY";
    pub const STATE_DIR: &str = "VIDEORC_SMOKE_STATE_DIR";
    pub const OUTPUT_DIR: &str = "VIDEORC_SMOKE_OUTPUT_DIR";
    /// Set on the backend: its smoke-only RPCs answer (debug builds only).
    pub const BACKEND_SMOKE_RPC: &str = "VIDEORC_ENABLE_SMOKE_RPC";
    /// The preview lifecycle probe is driving the app: its quit guard arms.
    pub const PREVIEW_LIFECYCLE_PROBE: &str = "VIDEORC_PREVIEW_LIFECYCLE_PROBE";
}

/// The server is on, with this capability.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmokeSwitch {
    pub capability: String,
    pub packaged: bool,
}

impl SmokeSwitch {
    /// Electron's switch (`smokeCommandServerEnabled`), read through `env`.
    /// `None` keeps the server off: no switch, or a packaged app without a
    /// valid harness capability.
    pub fn resolve(env: impl Fn(&str) -> Option<String>, packaged: bool) -> Option<Self> {
        let on = |name: &str| env(name).as_deref() == Some("1");
        let enabled = on(vars::PREVIEW_MOTION)
            || on(vars::COMMAND_SERVER)
            || on(vars::WINDOWS_LIVE_AUDIO)
            || on(vars::WINDOWS_D3D11_PREVIEW);
        let harness = if packaged && on(vars::PACKAGED_SMOKE_TEST) {
            env(vars::COMMAND_CAPABILITY)
        } else {
            None
        };
        if !security::smoke_command_server_allowed(enabled, packaged, harness.as_deref()) {
            return None;
        }
        Some(Self {
            capability: harness.unwrap_or_else(security::create_smoke_command_capability),
            packaged,
        })
    }

    /// The server's policy: a packaged app serves its harness's subset.
    pub fn options(&self) -> SmokeServerOptions {
        SmokeServerOptions {
            capability: self.capability.clone(),
            allowed_commands: self.packaged.then_some(PACKAGED_SMOKE_COMMAND_NAMES),
        }
    }

    /// `VIDEORC_ENABLE_SMOKE_RPC` for the backend: on for a dev app's smokes,
    /// never for a packaged one.
    pub fn backend_smoke_rpc(&self) -> bool {
        !self.packaged
    }

    /// The `preview-motion-ready` line; a packaged app's harness already
    /// holds the capability, so it is not printed.
    pub fn ready_marker(&self, address: SocketAddr, app_pid: u32) -> String {
        preview_motion_ready_marker(
            address,
            app_pid,
            (!self.packaged).then_some(&self.capability),
        )
    }
}

/// `[smoke] preview-motion-ready {host, port, appPid, capability?}`.
pub fn preview_motion_ready_marker(
    address: SocketAddr,
    app_pid: u32,
    capability: Option<&str>,
) -> String {
    let mut fields = json!({
        "host": address.ip().to_string(),
        "port": address.port(),
        "appPid": app_pid,
    });
    if let Some(capability) = capability {
        fields["capability"] = Value::String(capability.to_string());
    }
    format!("{MARKER_PREFIX}preview-motion-ready {fields}")
}

/// `[smoke] backend-ready …` with `publicBackendConnectionJson`: the
/// renderer-scoped credential and the backend's identity, never the admin
/// token.
pub fn backend_ready_marker(bootstrap: &BackendBootstrap) -> String {
    let mut fields = json!({
        "host": bootstrap.host,
        "port": bootstrap.port,
        "token": bootstrap.token,
        "pid": bootstrap.pid,
    });
    if let Some(parent_pid) = bootstrap.parent_pid {
        fields["parentPid"] = json!(parent_pid);
    }
    format!("{MARKER_PREFIX}backend-ready {fields}")
}

/// Whether `VIDEORC_SMOKE_PRINT_BACKEND_READY=1`.
pub fn print_backend_ready_requested(env: impl Fn(&str) -> Option<String>) -> bool {
    env(vars::PRINT_BACKEND_READY).as_deref() == Some("1")
}

/// Prints [`backend_ready_marker`] through `print` each time a backend
/// generation becomes ready, as Electron main does on every READY.
pub fn spawn_backend_ready_markers(
    mut state: watch::Receiver<BackendState>,
    print: impl Fn(&str) + Send + 'static,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut printed: Option<(u32, String)> = None;
        loop {
            let ready = state.borrow_and_update().bootstrap().cloned();
            if let Some(bootstrap) = ready {
                let identity = (bootstrap.pid, bootstrap.token.clone());
                if printed.as_ref() != Some(&identity) {
                    print(&backend_ready_marker(&bootstrap));
                    printed = Some(identity);
                }
            }
            if state.changed().await.is_err() {
                break;
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::net::Ipv4Addr;

    use super::*;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn the_server_stays_off_without_the_switch() {
        assert_eq!(SmokeSwitch::resolve(env_of(&[]), false), None);
        assert_eq!(
            SmokeSwitch::resolve(env_of(&[(vars::COMMAND_SERVER, "0")]), false),
            None
        );
        assert_eq!(
            SmokeSwitch::resolve(env_of(&[(vars::COMMAND_SERVER, "true")]), false),
            None
        );
        // The capability variable alone never turns it on.
        assert_eq!(
            SmokeSwitch::resolve(
                env_of(&[(vars::COMMAND_CAPABILITY, &"x".repeat(43))]),
                false
            ),
            None
        );
    }

    #[test]
    fn a_dev_app_serves_with_a_fresh_capability_and_prints_it() {
        for name in [
            vars::COMMAND_SERVER,
            vars::PREVIEW_MOTION,
            vars::WINDOWS_LIVE_AUDIO,
            vars::WINDOWS_D3D11_PREVIEW,
        ] {
            let switch = SmokeSwitch::resolve(env_of(&[(name, "1")]), false).expect(name);
            assert!(security::smoke_command_capability_valid(&switch.capability));
            assert!(switch.backend_smoke_rpc());
            assert_eq!(switch.options().allowed_commands, None);
            let marker = switch.ready_marker(SocketAddr::from((Ipv4Addr::LOCALHOST, 4321)), 77);
            let json: Value = serde_json::from_str(
                marker
                    .strip_prefix("[smoke] preview-motion-ready ")
                    .expect("the marker prefix"),
            )
            .unwrap();
            assert_eq!(
                json,
                json!({"host": "127.0.0.1", "port": 4321, "appPid": 77, "capability": switch.capability})
            );
        }
        // A harness capability does not reach a dev app.
        let switch = SmokeSwitch::resolve(
            env_of(&[
                (vars::COMMAND_SERVER, "1"),
                (vars::COMMAND_CAPABILITY, &"y".repeat(43)),
            ]),
            false,
        )
        .unwrap();
        assert_ne!(switch.capability, "y".repeat(43));
    }

    #[test]
    fn a_packaged_app_needs_its_harness_capability_and_never_prints_it() {
        assert_eq!(
            SmokeSwitch::resolve(env_of(&[(vars::COMMAND_SERVER, "1")]), true),
            None
        );
        assert_eq!(
            SmokeSwitch::resolve(
                env_of(&[
                    (vars::COMMAND_SERVER, "1"),
                    (vars::PACKAGED_SMOKE_TEST, "1"),
                    (vars::COMMAND_CAPABILITY, "short"),
                ]),
                true
            ),
            None
        );
        assert_eq!(
            SmokeSwitch::resolve(
                env_of(&[
                    (vars::COMMAND_SERVER, "1"),
                    (vars::COMMAND_CAPABILITY, &"x".repeat(43)),
                ]),
                true
            ),
            None,
            "without VIDEORC_PACKAGED_SMOKE_TEST=1"
        );
        let capability = "x".repeat(43);
        let switch = SmokeSwitch::resolve(
            env_of(&[
                (vars::COMMAND_SERVER, "1"),
                (vars::PACKAGED_SMOKE_TEST, "1"),
                (vars::COMMAND_CAPABILITY, &capability),
            ]),
            true,
        )
        .unwrap();
        assert_eq!(switch.capability, capability);
        assert!(!switch.backend_smoke_rpc());
        assert_eq!(
            switch.options().allowed_commands,
            Some(PACKAGED_SMOKE_COMMAND_NAMES)
        );
        let marker = switch.ready_marker(SocketAddr::from((Ipv4Addr::LOCALHOST, 4321)), 77);
        assert!(!marker.contains("capability"), "{marker}");
    }

    #[test]
    fn the_backend_ready_marker_never_carries_the_admin_token() {
        let bootstrap = BackendBootstrap {
            host: "127.0.0.1".to_string(),
            port: 5555,
            token: "11111111-1111-4111-8111-111111111111".to_string(),
            admin_token: "22222222-2222-4222-8222-222222222222".to_string(),
            pid: 10,
            parent_pid: Some(9),
            managed_asset_roots: None,
        };
        let marker = backend_ready_marker(&bootstrap);
        assert!(!marker.contains(&bootstrap.admin_token), "{marker}");
        let json: Value =
            serde_json::from_str(marker.strip_prefix("[smoke] backend-ready ").unwrap()).unwrap();
        assert_eq!(
            json,
            json!({"host": "127.0.0.1", "port": 5555, "token": bootstrap.token, "pid": 10, "parentPid": 9})
        );
        assert!(print_backend_ready_requested(env_of(&[(
            vars::PRINT_BACKEND_READY,
            "1"
        )])));
        assert!(!print_backend_ready_requested(env_of(&[])));
    }
}
