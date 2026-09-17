//! Remote control surface (issue #143 — Stream Deck et al).
//!
//! Security model: the surface is OFF by default. When enabled, a dedicated
//! token authenticates a third transport role (`BackendRole::Remote`) whose
//! method admission is a hard allowlist (`remote.describe`, `remote.intent`)
//! and whose event stream is locked to `remote.state`/`remote.ack`. The
//! backend validates and RELAYS intents; the renderer executes them through
//! the exact same code paths as the on-screen buttons — there is no second
//! way to start a session, and no validation bypass.
//!
//! Same-machine pairing uses a discovery file next to the app database
//! (mode 0600, deleted when disabled or at shutdown) — the Discord-IPC local
//! trust model. The token additionally lives in the secret store so it
//! survives restarts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::secrets;

pub const REMOTE_TOKEN_SECRET: &str = "remote-control.token";
pub const REMOTE_ENABLED_SECRET: &str = "remote-control.enabled";

/// Minimum spacing between accepted intents of the SAME kind. A deck key
/// bounce must not double-toggle recording.
pub const REMOTE_INTENT_DEBOUNCE: Duration = Duration::from_millis(150);

#[derive(Debug, Default)]
pub struct RemoteControlRuntime {
    pub enabled: bool,
    pub token: Option<String>,
    /// Renderer-published catalog (scenes, takeover assets, windows, mics)
    /// served to remote clients via `remote.describe`.
    pub describe: Option<serde_json::Value>,
    /// Renderer-published state projection (recording/live/mic/scene/
    /// takeover) — the ONLY state remote clients ever see.
    pub state: Option<serde_json::Value>,
    pub connected_clients: usize,
    last_intent_at: HashMap<String, Instant>,
    next_intent_sequence: u64,
}

pub type RemoteControlSlot = std::sync::Arc<StdMutex<RemoteControlRuntime>>;

/// Remote intents, exactly the issue-#143 surface. `kind` is the wire tag;
/// unknown kinds are rejected before any relay.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RemoteIntent {
    RecordStart,
    RecordStop,
    RecordToggle,
    StreamStart,
    StreamStop,
    MicMute,
    MicUnmute,
    MicToggle,
    #[serde(rename_all = "camelCase")]
    SceneApply {
        #[serde(skip_serializing_if = "Option::is_none")]
        screen_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        layout_preset: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    TakeoverShow {
        asset_id: String,
    },
    TakeoverHide,
    #[serde(rename_all = "camelCase")]
    WindowFront {
        window: RemoteWindow,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteWindow {
    Notes,
    Comments,
    Preview,
}

impl RemoteIntent {
    /// Debounce bucket: toggles and their explicit forms share one bucket so
    /// a bouncing key cannot interleave `micMute` + `micToggle`.
    pub fn debounce_kind(&self) -> &'static str {
        match self {
            Self::RecordStart | Self::RecordStop | Self::RecordToggle => "record",
            Self::StreamStart | Self::StreamStop => "stream",
            Self::MicMute | Self::MicUnmute | Self::MicToggle => "mic",
            Self::SceneApply { .. } => "scene",
            Self::TakeoverShow { .. } | Self::TakeoverHide => "takeover",
            Self::WindowFront { .. } => "window",
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::SceneApply {
                screen_id,
                layout_preset,
            } => {
                if screen_id.is_none() && layout_preset.is_none() {
                    return Err("sceneApply needs a screenId or a layoutPreset.".to_string());
                }
                Ok(())
            }
            Self::TakeoverShow { asset_id } if asset_id.trim().is_empty() => {
                Err("takeoverShow needs a non-empty assetId.".to_string())
            }
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteIntentTicket {
    pub intent_id: String,
    pub accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl RemoteControlRuntime {
    pub fn load_from_secrets() -> Self {
        let enabled = secrets::try_get_secret(REMOTE_ENABLED_SECRET)
            .ok()
            .flatten()
            .as_deref()
            == Some("1");
        let token = secrets::try_get_secret(REMOTE_TOKEN_SECRET).ok().flatten();
        Self {
            // Enabled requires a token to exist — fail closed on partial state.
            enabled: enabled && token.is_some(),
            token,
            ..Self::default()
        }
    }

    /// Accept or debounce an intent. Returns a ticket; only accepted tickets
    /// are relayed to the renderer.
    pub fn admit_intent(&mut self, intent: &RemoteIntent, now: Instant) -> RemoteIntentTicket {
        let kind = intent.debounce_kind();
        if let Some(last) = self.last_intent_at.get(kind)
            && now.duration_since(*last) < REMOTE_INTENT_DEBOUNCE
        {
            return RemoteIntentTicket {
                intent_id: String::new(),
                accepted: false,
                message: Some(format!(
                    "Debounced: another {kind} intent arrived less than {}ms ago.",
                    REMOTE_INTENT_DEBOUNCE.as_millis()
                )),
            };
        }
        self.last_intent_at.insert(kind.to_string(), now);
        self.next_intent_sequence += 1;
        RemoteIntentTicket {
            intent_id: format!("ri-{}", self.next_intent_sequence),
            accepted: true,
            message: None,
        }
    }
}

pub fn persist_enabled(enabled: bool, token: Option<&str>) -> Result<()> {
    if enabled {
        let token = token.context("Remote control cannot enable without a token")?;
        secrets::put_secrets(&[(REMOTE_ENABLED_SECRET, "1"), (REMOTE_TOKEN_SECRET, token)])
    } else {
        secrets::put_secret(REMOTE_ENABLED_SECRET, "0")
    }
}

pub fn generate_token() -> String {
    // Two UUIDs → 64 hex chars of entropy without a new dependency.
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryFile<'a> {
    host: &'a str,
    port: u16,
    token: &'a str,
    protocol: u32,
}

pub fn discovery_path(database_path: &Path) -> Option<PathBuf> {
    if database_path.to_string_lossy() == ":memory:" {
        return None;
    }
    Some(database_path.with_file_name("remote-control.json"))
}

/// Write the same-machine pairing file. Mode 0600: readable only by the
/// user's own processes — local software running as the user is trusted the
/// same way the Stream Deck app itself is.
pub fn write_discovery(path: &Path, host: &str, port: u16, token: &str) -> Result<()> {
    let body = serde_json::to_vec_pretty(&DiscoveryFile {
        host,
        port,
        token,
        protocol: 1,
    })?;
    // The file must be born 0600 — a create-then-chmod sequence leaves a
    // umask-dependent window where another local user could read the token.
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("Could not write {}", path.display()))?;
        file.write_all(&body)
            .with_context(|| format!("Could not write {}", path.display()))?;
        // mode() only applies at creation; tighten a pre-existing file too.
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("Could not restrict permissions on {}", path.display()))?;
    }
    // Windows: %APPDATA% files inherit the user profile's private ACL.
    #[cfg(not(unix))]
    std::fs::write(path, body).with_context(|| format!("Could not write {}", path.display()))?;
    Ok(())
}

pub fn remove_discovery(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intents_round_trip_the_wire_tags() {
        let intent: RemoteIntent = serde_json::from_str(r#"{"kind":"recordToggle"}"#).unwrap();
        assert_eq!(intent, RemoteIntent::RecordToggle);
        let intent: RemoteIntent =
            serde_json::from_str(r#"{"kind":"sceneApply","screenId":"screen-1"}"#).unwrap();
        assert_eq!(
            intent,
            RemoteIntent::SceneApply {
                screen_id: Some("screen-1".to_string()),
                layout_preset: None
            }
        );
        let intent: RemoteIntent =
            serde_json::from_str(r#"{"kind":"windowFront","window":"notes"}"#).unwrap();
        assert_eq!(
            intent,
            RemoteIntent::WindowFront {
                window: RemoteWindow::Notes
            }
        );
        assert!(serde_json::from_str::<RemoteIntent>(r#"{"kind":"fsRead"}"#).is_err());
    }

    #[test]
    fn scene_apply_requires_a_target_and_takeover_an_asset() {
        assert!(
            RemoteIntent::SceneApply {
                screen_id: None,
                layout_preset: None
            }
            .validate()
            .is_err()
        );
        assert!(
            RemoteIntent::TakeoverShow {
                asset_id: "  ".to_string()
            }
            .validate()
            .is_err()
        );
        assert!(
            RemoteIntent::SceneApply {
                screen_id: None,
                layout_preset: Some("screen-camera".to_string())
            }
            .validate()
            .is_ok()
        );
    }

    #[test]
    fn same_kind_intents_debounce_and_different_kinds_pass() {
        let mut runtime = RemoteControlRuntime::default();
        let start = Instant::now();
        let first = runtime.admit_intent(&RemoteIntent::RecordToggle, start);
        assert!(first.accepted);
        // A bouncing key 50ms later: rejected — record/stop share the bucket.
        let bounce =
            runtime.admit_intent(&RemoteIntent::RecordStop, start + Duration::from_millis(50));
        assert!(!bounce.accepted);
        // A different kind passes immediately.
        let mic = runtime.admit_intent(&RemoteIntent::MicToggle, start + Duration::from_millis(50));
        assert!(mic.accepted);
        // Past the window the same kind passes again, with a fresh id.
        let later = runtime.admit_intent(
            &RemoteIntent::RecordToggle,
            start + REMOTE_INTENT_DEBOUNCE + Duration::from_millis(1),
        );
        assert!(later.accepted);
        assert_ne!(later.intent_id, first.intent_id);
    }

    #[test]
    fn discovery_file_is_owner_only_and_removable() {
        let dir = std::env::temp_dir().join(format!("videorc-rc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("videorc.sqlite3");
        let path = discovery_path(&db).unwrap();
        write_discovery(&path, "127.0.0.1", 4242, "secret-token").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "discovery file must be owner-only");
        }
        let body: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(body["port"], 4242);
        assert_eq!(body["protocol"], 1);
        remove_discovery(&path);
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
        assert!(discovery_path(Path::new(":memory:")).is_none());
    }
}
