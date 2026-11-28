//! Camera, microphone and screen recording permissions (plan 220 S2.6b), as
//! Electron main asks for them, without the OS calls.
//!
//! - [`request_media_access_with_restart`] (`main/media-access.ts`): the
//!   camera or microphone prompt fires in place only for a never-asked Mac
//!   (`not-determined`); a grant that already existed returns at once and
//!   never restarts capture (FX1); a denial is final (System Settings is the
//!   only door, macOS never re-prompts). A fresh grant stops the grant
//!   watcher and restarts the backend once, so capture starts with it.
//! - [`request_screen_access_with_watch`]: the same for Screen & System
//!   Audio Recording (plan 203 S2), with the watcher started before the
//!   request: macOS answers the first screen prompt in System Settings, not
//!   in place.
//! - [`DeferredPermissionRestart`] (`main/deferred-permission-restart.ts`): a
//!   restart a grant asked for waits while capture is active or unknown, and
//!   runs once when it is idle.
//! - [`relaunch_for_permission_with_interruption_lease`]
//!   (`main/permission-relaunch.ts`): Reopen Videorc, refused while capture
//!   is active, and run only while the backend's interruption lease is held.
//! - [`permission_url_for_pane`] (`main/runtime-info.ts`): System Settings'
//!   or Windows Settings' page for each pane.
//!
//! The statuses are Electron's `systemPreferences.getMediaAccessStatus`
//! words. On macOS the screen's is `CGPreflightScreenCaptureAccess`, so it is
//! `granted` or `denied`, never `not-determined` (measured on Electron 39 on
//! 2026-11-09: a never-asked bundle reads `denied`).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::interruption::{Lease, run_interrupting_action};
use crate::log::Level;

use super::capture_state::MainCaptureState;

pub type PermissionFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// `MediaAccessStatus`: Electron's words, plus `unknown` when it cannot be
/// read and `not-applicable` where the OS keeps no such grant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaAccessStatus {
    NotDetermined,
    Granted,
    Denied,
    Restricted,
    Unknown,
    NotApplicable,
}

impl MediaAccessStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaAccessStatus::NotDetermined => "not-determined",
            MediaAccessStatus::Granted => "granted",
            MediaAccessStatus::Denied => "denied",
            MediaAccessStatus::Restricted => "restricted",
            MediaAccessStatus::Unknown => "unknown",
            MediaAccessStatus::NotApplicable => "not-applicable",
        }
    }

    /// `screenStatus`: one of the words, anything else `unknown`.
    pub fn parse(raw: &str) -> Self {
        match raw {
            "not-determined" => MediaAccessStatus::NotDetermined,
            "granted" => MediaAccessStatus::Granted,
            "denied" => MediaAccessStatus::Denied,
            "restricted" => MediaAccessStatus::Restricted,
            "not-applicable" => MediaAccessStatus::NotApplicable,
            _ => MediaAccessStatus::Unknown,
        }
    }
}

/// `MediaAccessPermissionName`: what `getMediaAccessStatus` reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaAccessPermission {
    Camera,
    Microphone,
    Screen,
}

impl MediaAccessPermission {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaAccessPermission::Camera => "camera",
            MediaAccessPermission::Microphone => "microphone",
            MediaAccessPermission::Screen => "screen",
        }
    }
}

/// `MediaAccessPane`: the two that have an in-place prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaPane {
    Camera,
    Microphone,
}

impl MediaPane {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaPane::Camera => "camera",
            MediaPane::Microphone => "microphone",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "camera" => Some(MediaPane::Camera),
            "microphone" => Some(MediaPane::Microphone),
            _ => None,
        }
    }

    pub fn permission(self) -> MediaAccessPermission {
        match self {
            MediaPane::Camera => MediaAccessPermission::Camera,
            MediaPane::Microphone => MediaAccessPermission::Microphone,
        }
    }
}

/// `SystemPermissionPane`: the System Settings pages Videorc opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SystemPermissionPane {
    Privacy,
    ScreenRecording,
    Camera,
    Microphone,
}

impl SystemPermissionPane {
    pub fn as_str(self) -> &'static str {
        match self {
            SystemPermissionPane::Privacy => "privacy",
            SystemPermissionPane::ScreenRecording => "screen-recording",
            SystemPermissionPane::Camera => "camera",
            SystemPermissionPane::Microphone => "microphone",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "privacy" => Some(SystemPermissionPane::Privacy),
            "screen-recording" => Some(SystemPermissionPane::ScreenRecording),
            "camera" => Some(SystemPermissionPane::Camera),
            "microphone" => Some(SystemPermissionPane::Microphone),
            _ => None,
        }
    }

    /// `mediaAccessPermissionForPane`: Privacy has no grant of its own.
    pub fn permission(self) -> Option<MediaAccessPermission> {
        match self {
            SystemPermissionPane::Camera => Some(MediaAccessPermission::Camera),
            SystemPermissionPane::Microphone => Some(MediaAccessPermission::Microphone),
            SystemPermissionPane::ScreenRecording => Some(MediaAccessPermission::Screen),
            SystemPermissionPane::Privacy => None,
        }
    }
}

impl From<MediaPane> for SystemPermissionPane {
    fn from(pane: MediaPane) -> Self {
        match pane {
            MediaPane::Camera => SystemPermissionPane::Camera,
            MediaPane::Microphone => SystemPermissionPane::Microphone,
        }
    }
}

/// The OS the permission rules are for (`process.platform`'s three cases).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionPlatform {
    MacOs,
    Windows,
    Other,
}

impl PermissionPlatform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            PermissionPlatform::MacOs
        } else if cfg!(windows) {
            PermissionPlatform::Windows
        } else {
            PermissionPlatform::Other
        }
    }

    /// `process.platform`, for the copy that names it.
    pub fn as_str(self) -> &'static str {
        match self {
            PermissionPlatform::MacOs => "darwin",
            PermissionPlatform::Windows => "win32",
            PermissionPlatform::Other => "linux",
        }
    }
}

/// `MACOS_PERMISSION_URLS` and `WINDOWS_PERMISSION_URLS`
/// (`permissionUrlForPane`). Windows has no screen page and falls back to
/// the Privacy hub.
pub fn permission_url_for_pane(
    pane: SystemPermissionPane,
    platform: PermissionPlatform,
) -> &'static str {
    if platform == PermissionPlatform::Windows {
        return match pane {
            SystemPermissionPane::Camera => "ms-settings:privacy-webcam",
            SystemPermissionPane::Microphone => "ms-settings:privacy-microphone",
            SystemPermissionPane::Privacy | SystemPermissionPane::ScreenRecording => {
                "ms-settings:privacy"
            }
        };
    }
    match pane {
        SystemPermissionPane::Privacy => "x-apple.systempreferences:com.apple.preference.security",
        SystemPermissionPane::ScreenRecording => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
        SystemPermissionPane::Camera => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"
        }
        SystemPermissionPane::Microphone => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        }
    }
}

/// `assertPermissionShortcutSupported`.
pub fn permission_shortcut_supported(platform: PermissionPlatform) -> Result<(), String> {
    match platform {
        PermissionPlatform::MacOs | PermissionPlatform::Windows => Ok(()),
        PermissionPlatform::Other => {
            Err("Permission shortcuts are only available on macOS and Windows.".to_string())
        }
    }
}

/// `MediaAccessSnapshot`: the OS's exact grants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAccessSnapshot {
    pub camera: MediaAccessStatus,
    pub microphone: MediaAccessStatus,
    /// Screen & System Audio Recording: the exact TCC value on macOS,
    /// `not-applicable` on Windows (no per-app screen grant) and Linux
    /// (portal consent per capture).
    pub screen: MediaAccessStatus,
}

impl MediaAccessSnapshot {
    pub fn for_permission(&self, permission: MediaAccessPermission) -> MediaAccessStatus {
        match permission {
            MediaAccessPermission::Camera => self.camera,
            MediaAccessPermission::Microphone => self.microphone,
            MediaAccessPermission::Screen => self.screen,
        }
    }
}

/// `BackendRestartBoundary`: the backend whose capture state predates a
/// grant, without its token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendRestartBoundary {
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

/// `MediaAccessRestartResult`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MediaAccessRestartResult {
    /// True when the grant transitioned and the backend was restarted.
    pub restarted: bool,
    pub stale_backend: Option<BackendRestartBoundary>,
}

/// `MediaAccessResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAccessResult {
    pub granted: bool,
    pub restarted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale_backend: Option<BackendRestartBoundary>,
}

impl MediaAccessResult {
    fn refused() -> Self {
        Self {
            granted: false,
            restarted: false,
            stale_backend: None,
        }
    }
}

/// `ScreenAccessResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenAccessResult {
    pub status: MediaAccessStatus,
    pub granted: bool,
    /// True only when a fresh grant already restarted the backend.
    pub restarted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale_backend: Option<BackendRestartBoundary>,
}

impl ScreenAccessResult {
    fn not_granted(status: MediaAccessStatus) -> Self {
        Self {
            status,
            granted: false,
            restarted: false,
            stale_backend: None,
        }
    }
}

/// `PermissionRecheckResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRecheckResult {
    pub restarted: bool,
}

/// `RelaunchForPermissionRefusal`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RelaunchRefusal {
    CaptureActive,
    BackendBusy,
}

/// `RelaunchForPermissionResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelaunchForPermissionResult {
    pub relaunched: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<RelaunchRefusal>,
}

/// `MediaAccessDeps` and `ScreenAccessDeps` in one: what a request needs
/// from the OS and from main.
pub trait MediaAccessDeps: Send + Sync {
    /// `getStatus`: the exact grant now.
    fn get_status(&self, permission: MediaAccessPermission) -> Result<MediaAccessStatus, String>;
    /// `askForAccess`: the OS's in-place prompt; true when granted.
    fn ask_for_access(&self, pane: MediaPane) -> PermissionFuture<'_, Result<bool, String>>;
    /// `requestAccess` (screen): adds the app to Screen & System Audio
    /// Recording and shows macOS's prompt.
    fn request_screen_access(&self) -> PermissionFuture<'_, Result<(), String>>;
    /// `watchGrant`: the grant watcher on the screen pane, restarting once
    /// on a grant.
    fn watch_grant(&self, pane: SystemPermissionPane, reason: &str);
    fn restart_backend(
        &self,
        reason: String,
    ) -> PermissionFuture<'_, Result<MediaAccessRestartResult, String>>;
    fn stop_grant_watcher(&self);
    fn log(&self, level: Level, message: String);
}

/// The reason a grant restarts the backend with (logged), for any pane:
/// `Restarting capture backend after ${pane} permission became available.`
pub fn pane_restart_reason(pane: SystemPermissionPane) -> String {
    format!(
        "Restarting capture backend after {} permission became available.",
        pane.as_str()
    )
}

/// The reason a camera or microphone grant restarts the backend with.
pub fn media_restart_reason(pane: MediaPane) -> String {
    pane_restart_reason(pane.into())
}

/// `SCREEN_ACCESS_RESTART_REASON`.
pub const SCREEN_ACCESS_RESTART_REASON: &str =
    "Restarting capture backend after Screen Recording permission became available.";

/// `requestMediaAccessWithRestart`. An error only when the backend restart
/// itself failed (Electron's rejected promise).
pub async fn request_media_access_with_restart(
    deps: &dyn MediaAccessDeps,
    pane: MediaPane,
) -> Result<MediaAccessResult, String> {
    let status = match deps.get_status(pane.permission()) {
        Ok(status) => status,
        Err(error) => {
            deps.log(
                Level::Warn,
                format!(
                    "Could not read {} permission status: {error}",
                    pane.as_str()
                ),
            );
            return Ok(MediaAccessResult::refused());
        }
    };
    if status == MediaAccessStatus::Granted {
        return Ok(MediaAccessResult {
            granted: true,
            restarted: false,
            stale_backend: None,
        });
    }
    if status != MediaAccessStatus::NotDetermined {
        // macOS never re-prompts after a denial: System Settings is the only door.
        return Ok(MediaAccessResult::refused());
    }
    let granted = match deps.ask_for_access(pane).await {
        Ok(granted) => granted,
        Err(error) => {
            deps.log(
                Level::Warn,
                format!("Could not request {} permission: {error}", pane.as_str()),
            );
            return Ok(MediaAccessResult::refused());
        }
    };
    if !granted {
        return Ok(MediaAccessResult::refused());
    }
    deps.stop_grant_watcher();
    let restart = deps.restart_backend(media_restart_reason(pane)).await?;
    Ok(MediaAccessResult {
        granted: true,
        restarted: restart.restarted,
        stale_backend: restart.stale_backend,
    })
}

/// What `CGPreflightScreenCaptureAccess` means for the screen. It answers
/// granted or not and nothing else, so a Mac that was never asked reads the
/// same as one that said no. The app remembers that it has asked
/// (`asked_before`): until then "not granted" is `NotDetermined`, which is
/// the only state [`request_screen_access_with_watch`] asks from, so the
/// app asks (and macOS lists it under Screen & System Audio Recording)
/// instead of reporting "denied" without ever having asked.
pub fn screen_status_from_preflight(granted: bool, asked_before: bool) -> MediaAccessStatus {
    if granted {
        MediaAccessStatus::Granted
    } else if asked_before {
        MediaAccessStatus::Denied
    } else {
        MediaAccessStatus::NotDetermined
    }
}

/// `requestScreenAccessWithWatch`: only a never-asked Mac is asked. The
/// watcher starts before the request and outlives it.
pub async fn request_screen_access_with_watch(
    deps: &dyn MediaAccessDeps,
    platform: PermissionPlatform,
) -> Result<ScreenAccessResult, String> {
    if platform != PermissionPlatform::MacOs {
        return Ok(ScreenAccessResult::not_granted(
            MediaAccessStatus::NotApplicable,
        ));
    }
    let status = match deps.get_status(MediaAccessPermission::Screen) {
        Ok(status) => status,
        Err(error) => {
            deps.log(
                Level::Warn,
                format!("Could not read screen permission status: {error}"),
            );
            return Ok(ScreenAccessResult::not_granted(MediaAccessStatus::Unknown));
        }
    };
    if status == MediaAccessStatus::Granted {
        return Ok(ScreenAccessResult {
            status,
            granted: true,
            restarted: false,
            stale_backend: None,
        });
    }
    if status != MediaAccessStatus::NotDetermined {
        return Ok(ScreenAccessResult::not_granted(status));
    }

    deps.watch_grant(
        SystemPermissionPane::ScreenRecording,
        SCREEN_ACCESS_RESTART_REASON,
    );
    if let Err(error) = deps.request_screen_access().await {
        deps.log(
            Level::Warn,
            format!("Could not request screen permission: {error}"),
        );
    }
    let next = match deps.get_status(MediaAccessPermission::Screen) {
        Ok(status) => status,
        Err(error) => {
            deps.log(
                Level::Warn,
                format!("Could not re-read screen permission status: {error}"),
            );
            return Ok(ScreenAccessResult::not_granted(MediaAccessStatus::Unknown));
        }
    };
    if next != MediaAccessStatus::Granted {
        // The watcher keeps looking; the grant lands in System Settings.
        return Ok(ScreenAccessResult::not_granted(next));
    }
    // Granted in place: the single restart the camera path makes, never a
    // second one from the watcher.
    deps.stop_grant_watcher();
    let restart = deps
        .restart_backend(SCREEN_ACCESS_RESTART_REASON.to_string())
        .await?;
    Ok(ScreenAccessResult {
        status: next,
        granted: true,
        restarted: restart.restarted,
        stale_backend: restart.stale_backend,
    })
}

/// `DeferredPermissionRestartState`: the one restart a grant asked for while
/// capture was busy.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeferredPermissionRestart {
    pending_reason: Option<String>,
}

impl DeferredPermissionRestart {
    pub fn pending_reason(&self) -> Option<&str> {
        self.pending_reason.as_deref()
    }

    /// `requestPermissionRestart`: the reason to run now, or none while
    /// capture is active or unknown (the first reason waits; later ones
    /// coalesce into it).
    pub fn request(&mut self, capture: MainCaptureState, reason: &str) -> Option<String> {
        if capture.active_or_unknown() {
            if self.pending_reason.is_none() {
                self.pending_reason = Some(reason.to_string());
            }
            return None;
        }
        self.pending_reason = None;
        Some(reason.to_string())
    }

    /// `flushPermissionRestart`: the waiting reason, once, when capture is idle.
    pub fn flush(&mut self, capture: MainCaptureState) -> Option<String> {
        if self.pending_reason.is_none() || capture.active_or_unknown() {
            return None;
        }
        self.pending_reason.take()
    }
}

/// `relaunchForPermissionWithInterruptionLease`: the same admission as
/// installing an update. The sampled capture guard first, then the
/// backend's lease; the relaunch runs only while the lease is held. With no
/// backend connected there is nothing to interrupt, and the relaunch goes
/// straight through the normal quit path.
pub async fn relaunch_for_permission_with_interruption_lease<Acquire, Relaunch>(
    capture_blocked: bool,
    backend_connected: bool,
    acquire: Acquire,
    relaunch: Relaunch,
) -> Result<RelaunchForPermissionResult, String>
where
    Acquire: Future<Output = Result<Option<Arc<dyn Lease>>, String>>,
    Relaunch: FnOnce(),
{
    if capture_blocked {
        return Ok(RelaunchForPermissionResult {
            relaunched: false,
            reason: Some(RelaunchRefusal::CaptureActive),
        });
    }
    if !backend_connected {
        relaunch();
        return Ok(RelaunchForPermissionResult {
            relaunched: true,
            reason: None,
        });
    }
    let lease = acquire.await?;
    let admitted = run_interrupting_action(lease, async move {
        relaunch();
        Ok(())
    })
    .await?;
    Ok(if admitted {
        RelaunchForPermissionResult {
            relaunched: true,
            reason: None,
        }
    } else {
        RelaunchForPermissionResult {
            relaunched: false,
            reason: Some(RelaunchRefusal::BackendBusy),
        }
    })
}

/// The arguments a relaunch passes on: this launch's, without the one-shot
/// `videorc://` links (already handled; a replayed sign-in callback would be
/// refused) and the Finder's `-psn_` serial number.
pub fn relaunch_args<S: AsRef<std::ffi::OsStr>>(args: &[S]) -> Vec<std::ffi::OsString> {
    args.iter()
        .map(|arg| arg.as_ref().to_os_string())
        .filter(|arg| {
            let text = arg.to_string_lossy();
            !(text.starts_with("-psn_") || text.to_ascii_lowercase().starts_with("videorc://"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::interruption::LeaseFuture;
    use MediaAccessStatus::*;

    #[derive(Default)]
    struct Fake {
        statuses: Mutex<VecDeque<Result<MediaAccessStatus, String>>>,
        ask: Mutex<Option<Result<bool, String>>>,
        request_fails: bool,
        restart: Mutex<Option<MediaAccessRestartResult>>,
        calls: Mutex<Vec<String>>,
    }

    impl Fake {
        fn with(statuses: Vec<Result<MediaAccessStatus, String>>) -> Self {
            Self {
                statuses: Mutex::new(statuses.into()),
                ask: Mutex::new(Some(Ok(true))),
                restart: Mutex::new(Some(MediaAccessRestartResult {
                    restarted: true,
                    stale_backend: None,
                })),
                ..Self::default()
            }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }

        fn note(&self, call: String) {
            self.calls.lock().unwrap().push(call);
        }
    }

    impl MediaAccessDeps for Fake {
        fn get_status(
            &self,
            permission: MediaAccessPermission,
        ) -> Result<MediaAccessStatus, String> {
            self.note(format!("status:{}", permission.as_str()));
            self.statuses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Ok(NotDetermined))
        }
        fn ask_for_access(&self, pane: MediaPane) -> PermissionFuture<'_, Result<bool, String>> {
            self.note(format!("ask:{}", pane.as_str()));
            let answer = self.ask.lock().unwrap().clone().unwrap_or(Ok(false));
            Box::pin(async move { answer })
        }
        fn request_screen_access(&self) -> PermissionFuture<'_, Result<(), String>> {
            self.note("request-screen".to_string());
            let fails = self.request_fails;
            Box::pin(async move {
                if fails {
                    Err("no window server".to_string())
                } else {
                    Ok(())
                }
            })
        }
        fn watch_grant(&self, pane: SystemPermissionPane, reason: &str) {
            self.note(format!("watch:{}:{reason}", pane.as_str()));
        }
        fn restart_backend(
            &self,
            reason: String,
        ) -> PermissionFuture<'_, Result<MediaAccessRestartResult, String>> {
            self.note(format!("restart:{reason}"));
            let result = self.restart.lock().unwrap().clone().unwrap_or_default();
            Box::pin(async move { Ok(result) })
        }
        fn stop_grant_watcher(&self) {
            self.note("stop-watcher".to_string());
        }
        fn log(&self, level: Level, message: String) {
            self.note(format!("log:{level:?}:{message}"));
        }
    }

    fn granted(restarted: bool) -> MediaAccessResult {
        MediaAccessResult {
            granted: true,
            restarted,
            stale_backend: None,
        }
    }

    #[tokio::test]
    async fn already_granted_skips_the_prompt_and_the_restart() {
        let fake = Fake::with(vec![Ok(Granted)]);
        let result = request_media_access_with_restart(&fake, MediaPane::Microphone)
            .await
            .unwrap();
        assert_eq!(result, granted(false));
        assert_eq!(fake.calls(), ["status:microphone"]);
    }

    #[tokio::test]
    async fn a_fresh_grant_stops_the_watcher_and_restarts_once() {
        let fake = Fake::with(vec![Ok(NotDetermined)]);
        *fake.restart.lock().unwrap() = Some(MediaAccessRestartResult {
            restarted: true,
            stale_backend: Some(BackendRestartBoundary {
                port: 9988,
                pid: Some(42),
            }),
        });
        let result = request_media_access_with_restart(&fake, MediaPane::Camera)
            .await
            .unwrap();
        assert_eq!(
            result,
            MediaAccessResult {
                granted: true,
                restarted: true,
                stale_backend: Some(BackendRestartBoundary {
                    port: 9988,
                    pid: Some(42)
                }),
            }
        );
        assert_eq!(
            fake.calls(),
            [
                "status:camera",
                "ask:camera",
                "stop-watcher",
                "restart:Restarting capture backend after camera permission became available."
            ]
        );
    }

    #[tokio::test]
    async fn a_grant_reports_a_deferred_restart_honestly() {
        let fake = Fake::with(vec![Ok(NotDetermined)]);
        *fake.restart.lock().unwrap() = Some(MediaAccessRestartResult {
            restarted: false,
            stale_backend: Some(BackendRestartBoundary {
                port: 9989,
                pid: Some(43),
            }),
        });
        let result = request_media_access_with_restart(&fake, MediaPane::Camera)
            .await
            .unwrap();
        assert!(result.granted && !result.restarted);
        assert_eq!(result.stale_backend.unwrap().port, 9989);
    }

    #[tokio::test]
    async fn a_denial_in_the_prompt_restarts_nothing() {
        let fake = Fake::with(vec![Ok(NotDetermined)]);
        *fake.ask.lock().unwrap() = Some(Ok(false));
        let result = request_media_access_with_restart(&fake, MediaPane::Camera)
            .await
            .unwrap();
        assert_eq!(result, MediaAccessResult::refused());
        assert!(!fake.calls().iter().any(|call| call.starts_with("restart")));
    }

    #[tokio::test]
    async fn a_previous_denial_never_prompts_again() {
        for status in [Denied, Restricted, Unknown] {
            let fake = Fake::with(vec![Ok(status)]);
            let result = request_media_access_with_restart(&fake, MediaPane::Microphone)
                .await
                .unwrap();
            assert_eq!(result, MediaAccessResult::refused());
            assert_eq!(fake.calls(), ["status:microphone"]);
        }
    }

    #[tokio::test]
    async fn status_and_prompt_errors_log_and_report_not_granted() {
        let fake = Fake::with(vec![Err("boom".to_string())]);
        let result = request_media_access_with_restart(&fake, MediaPane::Camera)
            .await
            .unwrap();
        assert_eq!(result, MediaAccessResult::refused());
        assert!(
            fake.calls()
                .contains(&"log:Warn:Could not read camera permission status: boom".to_string())
        );

        let fake = Fake::with(vec![Ok(NotDetermined)]);
        *fake.ask.lock().unwrap() = Some(Err("tcc".to_string()));
        let result = request_media_access_with_restart(&fake, MediaPane::Camera)
            .await
            .unwrap();
        assert_eq!(result, MediaAccessResult::refused());
        assert!(
            fake.calls()
                .contains(&"log:Warn:Could not request camera permission: tcc".to_string())
        );
    }

    #[test]
    fn a_never_asked_screen_is_not_determined_until_the_app_has_asked() {
        assert_eq!(screen_status_from_preflight(true, false), Granted);
        assert_eq!(screen_status_from_preflight(true, true), Granted);
        assert_eq!(screen_status_from_preflight(false, false), NotDetermined);
        assert_eq!(screen_status_from_preflight(false, true), Denied);
    }

    #[tokio::test]
    async fn the_screen_is_not_applicable_off_macos() {
        for platform in [PermissionPlatform::Windows, PermissionPlatform::Other] {
            let fake = Fake::with(vec![]);
            let result = request_screen_access_with_watch(&fake, platform)
                .await
                .unwrap();
            assert_eq!(result.status, NotApplicable);
            assert!(!result.granted);
            assert!(fake.calls().is_empty());
        }
    }

    #[tokio::test]
    async fn an_already_granted_screen_skips_the_request_the_watcher_and_the_restart() {
        let fake = Fake::with(vec![Ok(Granted)]);
        let result = request_screen_access_with_watch(&fake, PermissionPlatform::MacOs)
            .await
            .unwrap();
        assert_eq!(result.status, Granted);
        assert!(result.granted && !result.restarted);
        assert_eq!(fake.calls(), ["status:screen"]);
    }

    #[tokio::test]
    async fn a_denied_or_restricted_screen_never_prompts_again() {
        for status in [Denied, Restricted] {
            let fake = Fake::with(vec![Ok(status)]);
            let result = request_screen_access_with_watch(&fake, PermissionPlatform::MacOs)
                .await
                .unwrap();
            assert_eq!(result.status, status);
            assert_eq!(fake.calls(), ["status:screen"]);
        }
    }

    #[tokio::test]
    async fn a_never_asked_screen_starts_the_watcher_then_asks() {
        let fake = Fake::with(vec![Ok(NotDetermined), Ok(NotDetermined)]);
        let result = request_screen_access_with_watch(&fake, PermissionPlatform::MacOs)
            .await
            .unwrap();
        assert_eq!(result, ScreenAccessResult::not_granted(NotDetermined));
        assert_eq!(
            fake.calls(),
            [
                "status:screen",
                format!("watch:screen-recording:{SCREEN_ACCESS_RESTART_REASON}").as_str(),
                "request-screen",
                "status:screen"
            ]
        );
    }

    #[tokio::test]
    async fn a_screen_grant_in_place_restarts_once_and_retires_the_watcher() {
        let fake = Fake::with(vec![Ok(NotDetermined), Ok(Granted)]);
        let result = request_screen_access_with_watch(&fake, PermissionPlatform::MacOs)
            .await
            .unwrap();
        assert!(result.granted && result.restarted);
        let calls = fake.calls();
        assert_eq!(
            calls[4..],
            [
                "stop-watcher".to_string(),
                format!("restart:{SCREEN_ACCESS_RESTART_REASON}")
            ]
        );
    }

    #[tokio::test]
    async fn a_failing_screen_request_leaves_the_watcher_running_and_logs() {
        let mut fake = Fake::with(vec![Ok(NotDetermined), Ok(NotDetermined)]);
        fake.request_fails = true;
        let result = request_screen_access_with_watch(&fake, PermissionPlatform::MacOs)
            .await
            .unwrap();
        assert_eq!(result.status, NotDetermined);
        let calls = fake.calls();
        assert!(calls.contains(
            &"log:Warn:Could not request screen permission: no window server".to_string()
        ));
        assert!(!calls.contains(&"stop-watcher".to_string()));
    }

    #[tokio::test]
    async fn a_screen_status_error_reports_unknown_without_asking() {
        let fake = Fake::with(vec![Err("nope".to_string())]);
        let result = request_screen_access_with_watch(&fake, PermissionPlatform::MacOs)
            .await
            .unwrap();
        assert_eq!(result.status, Unknown);
        assert!(!fake.calls().contains(&"request-screen".to_string()));
    }

    #[test]
    fn a_restart_waits_while_capture_is_active_or_unknown() {
        for capture in [
            MainCaptureState::Unknown,
            MainCaptureState::Starting,
            MainCaptureState::Recording,
            MainCaptureState::Streaming,
            MainCaptureState::Stopping,
        ] {
            let mut deferred = DeferredPermissionRestart::default();
            assert_eq!(deferred.request(capture, "permission granted"), None);
            assert_eq!(deferred.pending_reason(), Some("permission granted"));
        }
    }

    #[test]
    fn repeated_grants_coalesce_while_capture_stays_active() {
        let mut deferred = DeferredPermissionRestart::default();
        assert_eq!(
            deferred.request(MainCaptureState::Recording, "camera granted"),
            None
        );
        assert_eq!(
            deferred.request(MainCaptureState::Stopping, "microphone granted"),
            None
        );
        assert_eq!(deferred.pending_reason(), Some("camera granted"));
    }

    #[test]
    fn the_waiting_restart_runs_once_when_capture_is_idle_or_failed() {
        for idle in [MainCaptureState::Idle, MainCaptureState::Failed] {
            let mut deferred = DeferredPermissionRestart::default();
            deferred.request(MainCaptureState::Recording, "permission granted");
            assert_eq!(
                deferred.flush(MainCaptureState::Recording),
                None,
                "still recording"
            );
            assert_eq!(deferred.flush(idle).as_deref(), Some("permission granted"));
            assert_eq!(deferred.flush(idle), None);
        }
    }

    #[test]
    fn a_restart_runs_at_once_when_capture_is_already_idle() {
        let mut deferred = DeferredPermissionRestart::default();
        assert_eq!(
            deferred
                .request(MainCaptureState::Idle, "permission granted")
                .as_deref(),
            Some("permission granted")
        );
        assert_eq!(deferred, DeferredPermissionRestart::default());
    }

    struct CountingLease {
        consumed: AtomicUsize,
    }

    impl Lease for CountingLease {
        fn id(&self) -> &str {
            "lease-1"
        }
        fn expires_in_ms(&self) -> u64 {
            30_000
        }
        fn consume(&self) -> LeaseFuture<'_, Result<(), String>> {
            self.consumed.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }
        fn renew(&self) -> LeaseFuture<'_, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
        fn release(&self) -> LeaseFuture<'_, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
    }

    #[tokio::test]
    async fn the_relaunch_is_refused_while_capture_is_active_or_unknown() {
        let acquired = AtomicUsize::new(0);
        let relaunched = AtomicUsize::new(0);
        let result = relaunch_for_permission_with_interruption_lease(
            true,
            true,
            async {
                acquired.fetch_add(1, Ordering::SeqCst);
                Ok(None)
            },
            || {
                relaunched.fetch_add(1, Ordering::SeqCst);
            },
        )
        .await
        .unwrap();
        assert_eq!(
            result,
            RelaunchForPermissionResult {
                relaunched: false,
                reason: Some(RelaunchRefusal::CaptureActive)
            }
        );
        assert_eq!(acquired.load(Ordering::SeqCst), 0);
        assert_eq!(relaunched.load(Ordering::SeqCst), 0);
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({"relaunched": false, "reason": "capture-active"})
        );
    }

    #[tokio::test]
    async fn the_relaunch_is_refused_when_the_backend_will_not_admit_it() {
        let relaunched = AtomicUsize::new(0);
        let result = relaunch_for_permission_with_interruption_lease(
            false,
            true,
            async { Ok(None) },
            || {
                relaunched.fetch_add(1, Ordering::SeqCst);
            },
        )
        .await
        .unwrap();
        assert_eq!(result.reason, Some(RelaunchRefusal::BackendBusy));
        assert_eq!(relaunched.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn the_relaunch_runs_only_while_holding_the_lease() {
        let lease = Arc::new(CountingLease {
            consumed: AtomicUsize::new(0),
        });
        let relaunched = AtomicUsize::new(0);
        let held = lease.clone();
        let result = relaunch_for_permission_with_interruption_lease(
            false,
            true,
            async move { Ok(Some(held as Arc<dyn Lease>)) },
            || {
                relaunched.fetch_add(1, Ordering::SeqCst);
            },
        )
        .await
        .unwrap();
        assert_eq!(
            result,
            RelaunchForPermissionResult {
                relaunched: true,
                reason: None
            }
        );
        assert_eq!(lease.consumed.load(Ordering::SeqCst), 1);
        assert_eq!(relaunched.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn the_relaunch_needs_no_lease_with_no_backend_connected() {
        let acquired = AtomicUsize::new(0);
        let relaunched = AtomicUsize::new(0);
        let result = relaunch_for_permission_with_interruption_lease(
            false,
            false,
            async {
                acquired.fetch_add(1, Ordering::SeqCst);
                Ok(None)
            },
            || {
                relaunched.fetch_add(1, Ordering::SeqCst);
            },
        )
        .await
        .unwrap();
        assert!(result.relaunched);
        assert_eq!(acquired.load(Ordering::SeqCst), 0);
        assert_eq!(relaunched.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn the_relaunch_keeps_every_argument_but_the_links() {
        let args = [
            "--profile",
            "/tmp/p",
            "--backend",
            "/x/videorc-backend",
            "videorc://buddy",
            "-psn_0_12345",
            "--quiet",
        ];
        assert_eq!(
            relaunch_args(&args),
            [
                "--profile",
                "/tmp/p",
                "--backend",
                "/x/videorc-backend",
                "--quiet"
            ]
            .map(std::ffi::OsString::from)
        );
    }

    #[test]
    fn panes_urls_and_words_are_electrons() {
        assert_eq!(
            SystemPermissionPane::ScreenRecording.permission(),
            Some(MediaAccessPermission::Screen)
        );
        assert_eq!(SystemPermissionPane::Privacy.permission(), None);
        assert_eq!(
            permission_url_for_pane(SystemPermissionPane::Camera, PermissionPlatform::MacOs),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"
        );
        assert_eq!(
            permission_url_for_pane(
                SystemPermissionPane::ScreenRecording,
                PermissionPlatform::Windows
            ),
            "ms-settings:privacy"
        );
        assert_eq!(
            permission_url_for_pane(
                SystemPermissionPane::Microphone,
                PermissionPlatform::Windows
            ),
            "ms-settings:privacy-microphone"
        );
        assert_eq!(
            permission_shortcut_supported(PermissionPlatform::Other).unwrap_err(),
            "Permission shortcuts are only available on macOS and Windows."
        );
        for word in [
            "not-determined",
            "granted",
            "denied",
            "restricted",
            "unknown",
            "not-applicable",
        ] {
            assert_eq!(MediaAccessStatus::parse(word).as_str(), word);
        }
        assert_eq!(MediaAccessStatus::parse("weird"), Unknown);
        assert_eq!(
            serde_json::to_value(MediaAccessSnapshot {
                camera: Granted,
                microphone: Denied,
                screen: NotDetermined
            })
            .unwrap(),
            serde_json::json!({"camera": "granted", "microphone": "denied", "screen": "not-determined"})
        );
    }

    #[test]
    fn the_electron_sources_still_say_the_same() {
        let media = include_str!("../../../../apps/desktop/src/main/media-access.ts");
        assert!(media.contains(SCREEN_ACCESS_RESTART_REASON));
        assert!(
            media.contains("Restarting capture backend after ${pane} permission became available.")
        );
        let urls = include_str!("../../../../apps/desktop/src/main/runtime-info.ts");
        for pane in [
            SystemPermissionPane::Privacy,
            SystemPermissionPane::ScreenRecording,
            SystemPermissionPane::Camera,
            SystemPermissionPane::Microphone,
        ] {
            assert!(urls.contains(permission_url_for_pane(pane, PermissionPlatform::MacOs)));
            assert!(urls.contains(permission_url_for_pane(pane, PermissionPlatform::Windows)));
        }
    }
}
