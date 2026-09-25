//! Linux screen capture through `org.freedesktop.portal.ScreenCast` (L4 of
//! `docs/linux-port-plan.md`, Plan 0006).
//!
//! The portal owns the picker UI: the app never enumerates monitors or
//! windows before consent. A source id therefore names a KIND of portal
//! source (`screen:portal:monitor`, `window:portal:window`), and the portal's
//! `restore_token` (persisted per source id beside the database) makes the
//! second and later starts silent. Everything that does not need D-Bus or
//! PipeWire lives here cfg-free so the state model is unit-tested on every
//! platform; the D-Bus session runner and the PipeWire reader live in
//! `linux_portal_session` / `linux_pipewire_stream` behind
//! `cfg(target_os = "linux")`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::protocol::{Device, DeviceKind, DeviceStatus};
use crate::source_status::SourceLifecycleStatus;

pub const PORTAL_MONITOR_SOURCE_ID: &str = "screen:portal:monitor";
pub const PORTAL_WINDOW_SOURCE_ID: &str = "window:portal:window";
const RESTORE_TOKENS_DIRECTORY_NAME: &str = "linux-portal";
const RESTORE_TOKENS_FILE: &str = "restore-tokens.json";

/// Which portal source type the id asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortalSourceType {
    Monitor,
    Window,
}

pub fn parse_portal_source_id(id: &str) -> Option<PortalSourceType> {
    match id {
        PORTAL_MONITOR_SOURCE_ID => Some(PortalSourceType::Monitor),
        PORTAL_WINDOW_SOURCE_ID => Some(PortalSourceType::Window),
        _ => None,
    }
}

/// The states the port plan names for a portal-backed source. Every one
/// maps to a `SourceLifecycleStatus` the renderer already renders, so a
/// black frame always comes with its reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum PortalCaptureState {
    /// The portal dialog is up (or the restore token is being redeemed).
    ConsentPending,
    /// The user granted a stream; `node_id` is the PipeWire node to read.
    Granted {
        node_id: u32,
        restore_token: Option<String>,
        width: Option<u32>,
        height: Option<u32>,
    },
    /// The user closed the picker without choosing.
    Cancelled,
    /// The compositor closed the session (screencast indicator, sleep, unplug).
    Revoked,
    /// The portal (or the compositor's backend) is not available at all.
    MissingSource { reason: String },
    /// A revoked session is being restarted with its restore token.
    Reconnecting,
}

impl PortalCaptureState {
    pub fn lifecycle_status(&self) -> SourceLifecycleStatus {
        match self {
            PortalCaptureState::ConsentPending | PortalCaptureState::Reconnecting => {
                SourceLifecycleStatus::Starting
            }
            PortalCaptureState::Granted { .. } => SourceLifecycleStatus::Live,
            PortalCaptureState::Cancelled => SourceLifecycleStatus::PermissionNeeded,
            PortalCaptureState::Revoked | PortalCaptureState::MissingSource { .. } => {
                SourceLifecycleStatus::SourceMissing
            }
        }
    }

    /// Renderer-facing copy naming the real reason, never a silent black frame.
    pub fn message(&self) -> String {
        match self {
            PortalCaptureState::ConsentPending => {
                "Choose what to share in the desktop portal dialog.".to_string()
            }
            PortalCaptureState::Granted { .. } => {
                "Portal screen capture is live over PipeWire.".to_string()
            }
            PortalCaptureState::Cancelled => {
                "Screen sharing was cancelled in the desktop portal dialog; pick a source to try again.".to_string()
            }
            PortalCaptureState::Revoked => {
                "The compositor ended the screen share; pick the source again to restart it.".to_string()
            }
            PortalCaptureState::MissingSource { reason } => format!(
                "Portal screen capture is unavailable: {reason} (needs xdg-desktop-portal with a compositor backend such as xdg-desktop-portal-hyprland, -wlr, -gnome or -kde, and PipeWire)."
            ),
            PortalCaptureState::Reconnecting => {
                "Reconnecting the portal screen share with its saved token.".to_string()
            }
        }
    }
}

/// Persisted portal restore tokens, one per source id, so the picker only
/// shows on the first start of each source.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestoreTokens {
    #[serde(default)]
    pub tokens: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct RestoreTokenStore {
    directory: PathBuf,
}

impl RestoreTokenStore {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    /// Beside the database, like the VAAPI quarantine, so an isolated smoke
    /// never redeems or overwrites the owner's tokens.
    pub fn default_directory() -> PathBuf {
        let database = crate::storage::default_database_path();
        database
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(RESTORE_TOKENS_DIRECTORY_NAME)
    }

    fn path(&self) -> PathBuf {
        self.directory.join(RESTORE_TOKENS_FILE)
    }

    pub fn load(&self) -> RestoreTokens {
        std::fs::read(self.path())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn token_for(&self, source_id: &str) -> Option<String> {
        self.load().tokens.get(source_id).cloned()
    }

    pub fn remember(&self, source_id: &str, token: Option<&str>) -> std::io::Result<()> {
        let mut tokens = self.load();
        match token {
            Some(token) if !token.is_empty() => {
                tokens
                    .tokens
                    .insert(source_id.to_string(), token.to_string());
            }
            _ => {
                tokens.tokens.remove(source_id);
            }
        }
        std::fs::create_dir_all(&self.directory)?;
        let json = serde_json::to_vec_pretty(&tokens).map_err(std::io::Error::other)?;
        let path = self.path();
        let temp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
        std::fs::write(&temp, &json)?;
        let result = crate::atomic_file::replace_file(&temp, &path);
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result
    }

    /// A token the portal refused (revoked, or from another session) must be
    /// dropped so the next start shows the picker instead of failing forever.
    pub fn forget(&self, source_id: &str) -> std::io::Result<()> {
        self.remember(source_id, None)
    }
}

/// Whether this process can reach a desktop portal at all: a session bus
/// address and a Wayland or X11 display. The portal itself decides the rest
/// at start time (and reports it as `MissingSource`).
pub fn portal_environment_available(env: &dyn Fn(&str) -> Option<String>) -> Result<(), String> {
    let has_bus = env("DBUS_SESSION_BUS_ADDRESS").is_some_and(|value| !value.is_empty())
        || env("XDG_RUNTIME_DIR").is_some_and(|value| !value.is_empty());
    if !has_bus {
        return Err(
            "no D-Bus session bus (DBUS_SESSION_BUS_ADDRESS / XDG_RUNTIME_DIR unset)".to_string(),
        );
    }
    let has_display = env("WAYLAND_DISPLAY").is_some_and(|value| !value.is_empty())
        || env("DISPLAY").is_some_and(|value| !value.is_empty());
    if !has_display {
        return Err("no graphical session (WAYLAND_DISPLAY / DISPLAY unset)".to_string());
    }
    Ok(())
}

/// The two portal entries the Linux device list carries. The portal owns the
/// picker, so there is exactly one monitor entry and one window entry; their
/// availability reflects the session environment, not a monitor enumeration.
pub fn portal_capture_devices(environment: Result<(), String>) -> Vec<Device> {
    let (status, detail) = match &environment {
        Ok(()) => (
            DeviceStatus::Available,
            "Desktop portal (xdg-desktop-portal + PipeWire): the compositor's picker chooses the exact source on first start.".to_string(),
        ),
        Err(reason) => (
            DeviceStatus::Unavailable,
            PortalCaptureState::MissingSource {
                reason: reason.clone(),
            }
            .message(),
        ),
    };
    vec![
        Device {
            id: PORTAL_MONITOR_SOURCE_ID.to_string(),
            name: "Screen (portal)".to_string(),
            kind: DeviceKind::Screen,
            status: status.clone(),
            detail: Some(detail.clone()),
            width: None,
            height: None,
        },
        Device {
            id: PORTAL_WINDOW_SOURCE_ID.to_string(),
            name: "Window (portal)".to_string(),
            kind: DeviceKind::Window,
            status,
            detail: Some(detail),
            width: None,
            height: None,
        },
    ]
}

/// PipeWire hands the app whichever of these it negotiated; the frame store
/// only speaks tightly packed BGRA, so every variant is converted on copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortalPixelLayout {
    Bgrx,
    Bgra,
    Rgbx,
    Rgba,
}

/// Copies one PipeWire video buffer (`stride` bytes per row, possibly padded)
/// into a tightly packed BGRA frame of `width`×`height`. Returns `false`
/// when the buffer is too short for the claimed geometry (the frame is
/// skipped, never published half-filled).
pub fn copy_to_bgra(
    layout: PortalPixelLayout,
    src: &[u8],
    stride: usize,
    width: usize,
    height: usize,
    dst: &mut Vec<u8>,
) -> bool {
    let row_bytes = width * 4;
    if stride < row_bytes || src.len() < stride * height.saturating_sub(1) + row_bytes {
        return false;
    }
    dst.resize(row_bytes * height, 0);
    for row in 0..height {
        let src_row = &src[row * stride..row * stride + row_bytes];
        let dst_row = &mut dst[row * row_bytes..(row + 1) * row_bytes];
        match layout {
            PortalPixelLayout::Bgra => dst_row.copy_from_slice(src_row),
            PortalPixelLayout::Bgrx => {
                dst_row.copy_from_slice(src_row);
                for px in dst_row.chunks_exact_mut(4) {
                    px[3] = 0xff;
                }
            }
            PortalPixelLayout::Rgbx | PortalPixelLayout::Rgba => {
                for (d, s) in dst_row.chunks_exact_mut(4).zip(src_row.chunks_exact(4)) {
                    d[0] = s[2];
                    d[1] = s[1];
                    d[2] = s[0];
                    d[3] = if layout == PortalPixelLayout::Rgba {
                        s[3]
                    } else {
                        0xff
                    };
                }
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portal_ids_name_a_source_kind_not_a_monitor() {
        assert_eq!(
            parse_portal_source_id("screen:portal:monitor"),
            Some(PortalSourceType::Monitor)
        );
        assert_eq!(
            parse_portal_source_id("window:portal:window"),
            Some(PortalSourceType::Window)
        );
        assert_eq!(parse_portal_source_id("screen:portal:0"), None);
        assert_eq!(parse_portal_source_id("screen:screencapturekit:1"), None);
    }

    #[test]
    fn every_portal_state_maps_to_a_named_lifecycle_status() {
        assert_eq!(
            PortalCaptureState::ConsentPending.lifecycle_status(),
            SourceLifecycleStatus::Starting
        );
        assert_eq!(
            PortalCaptureState::Reconnecting.lifecycle_status(),
            SourceLifecycleStatus::Starting
        );
        assert_eq!(
            PortalCaptureState::Granted {
                node_id: 7,
                restore_token: None,
                width: None,
                height: None
            }
            .lifecycle_status(),
            SourceLifecycleStatus::Live
        );
        assert_eq!(
            PortalCaptureState::Cancelled.lifecycle_status(),
            SourceLifecycleStatus::PermissionNeeded
        );
        assert_eq!(
            PortalCaptureState::Revoked.lifecycle_status(),
            SourceLifecycleStatus::SourceMissing
        );
        let missing = PortalCaptureState::MissingSource {
            reason: "no portal".to_string(),
        };
        assert_eq!(
            missing.lifecycle_status(),
            SourceLifecycleStatus::SourceMissing
        );
        assert!(missing.message().contains("xdg-desktop-portal"));
        assert!(missing.message().contains("no portal"));
        assert!(
            PortalCaptureState::Cancelled
                .message()
                .contains("cancelled")
        );
    }

    #[test]
    fn restore_tokens_persist_per_source_and_forget_on_refusal() {
        let directory =
            std::env::temp_dir().join(format!("videorc-portal-tokens-{}", uuid::Uuid::new_v4()));
        let store = RestoreTokenStore::new(directory.clone());
        assert_eq!(store.token_for(PORTAL_MONITOR_SOURCE_ID), None);
        store
            .remember(PORTAL_MONITOR_SOURCE_ID, Some("tok-1"))
            .expect("remember");
        store
            .remember(PORTAL_WINDOW_SOURCE_ID, Some("tok-2"))
            .expect("remember");
        assert_eq!(
            store.token_for(PORTAL_MONITOR_SOURCE_ID).as_deref(),
            Some("tok-1")
        );
        assert_eq!(
            store.token_for(PORTAL_WINDOW_SOURCE_ID).as_deref(),
            Some("tok-2")
        );
        store.forget(PORTAL_MONITOR_SOURCE_ID).expect("forget");
        assert_eq!(store.token_for(PORTAL_MONITOR_SOURCE_ID), None);
        assert_eq!(
            store.token_for(PORTAL_WINDOW_SOURCE_ID).as_deref(),
            Some("tok-2")
        );
        // An empty token is a removal, not a stored empty string.
        store
            .remember(PORTAL_WINDOW_SOURCE_ID, Some(""))
            .expect("remember");
        assert_eq!(store.token_for(PORTAL_WINDOW_SOURCE_ID), None);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn portal_devices_report_the_environment_gap_instead_of_a_silent_black_frame() {
        let available = portal_capture_devices(Ok(()));
        assert_eq!(available.len(), 2);
        assert!(
            available
                .iter()
                .all(|device| device.status == DeviceStatus::Available)
        );
        assert_eq!(available[0].id, PORTAL_MONITOR_SOURCE_ID);
        assert_eq!(available[0].kind, DeviceKind::Screen);
        assert_eq!(available[1].id, PORTAL_WINDOW_SOURCE_ID);
        assert_eq!(available[1].kind, DeviceKind::Window);

        let missing = portal_capture_devices(Err("no graphical session".to_string()));
        assert!(
            missing
                .iter()
                .all(|device| device.status == DeviceStatus::Unavailable)
        );
        assert!(
            missing[0]
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("no graphical session"))
        );
    }

    #[test]
    fn portal_environment_needs_a_bus_and_a_display() {
        let env = |vars: &'static [(&'static str, &'static str)]| {
            move |key: &str| -> Option<String> {
                vars.iter()
                    .find(|(k, _)| *k == key)
                    .map(|(_, v)| v.to_string())
            }
        };
        assert!(portal_environment_available(&env(&[])).is_err());
        assert!(
            portal_environment_available(&env(&[("DBUS_SESSION_BUS_ADDRESS", "unix:path=/x")]))
                .is_err()
        );
        assert!(
            portal_environment_available(&env(&[
                ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/x"),
                ("WAYLAND_DISPLAY", "wayland-1")
            ]))
            .is_ok()
        );
        assert!(
            portal_environment_available(&env(&[
                ("XDG_RUNTIME_DIR", "/run/user/1000"),
                ("DISPLAY", ":0")
            ]))
            .is_ok()
        );
    }

    #[test]
    fn copy_to_bgra_handles_padding_and_channel_order() {
        // 2x2, stride 12 (4 bytes of padding per row).
        let mut src = vec![0u8; 12 * 2];
        let px = |r: u8, g: u8, b: u8, a: u8| [r, g, b, a];
        src[0..4].copy_from_slice(&px(1, 2, 3, 9));
        src[4..8].copy_from_slice(&px(4, 5, 6, 9));
        src[12..16].copy_from_slice(&px(7, 8, 9, 9));
        src[16..20].copy_from_slice(&px(10, 11, 12, 9));
        let mut dst = Vec::new();
        assert!(copy_to_bgra(
            PortalPixelLayout::Rgbx,
            &src,
            12,
            2,
            2,
            &mut dst
        ));
        assert_eq!(
            dst,
            vec![3, 2, 1, 255, 6, 5, 4, 255, 9, 8, 7, 255, 12, 11, 10, 255]
        );
        assert!(copy_to_bgra(
            PortalPixelLayout::Rgba,
            &src,
            12,
            2,
            2,
            &mut dst
        ));
        assert_eq!(&dst[0..4], &[3, 2, 1, 9]);
        assert!(copy_to_bgra(
            PortalPixelLayout::Bgrx,
            &src,
            12,
            2,
            2,
            &mut dst
        ));
        assert_eq!(&dst[0..8], &[1, 2, 3, 255, 4, 5, 6, 255]);
        assert!(copy_to_bgra(
            PortalPixelLayout::Bgra,
            &src,
            12,
            2,
            2,
            &mut dst
        ));
        assert_eq!(&dst[12..16], &[10, 11, 12, 9]);
        // Too short for the claimed geometry: skipped, never half-filled.
        assert!(!copy_to_bgra(
            PortalPixelLayout::Bgra,
            &src[..20],
            12,
            2,
            3,
            &mut dst
        ));
        assert!(!copy_to_bgra(
            PortalPixelLayout::Bgra,
            &src,
            4,
            2,
            2,
            &mut dst
        ));
    }
}
