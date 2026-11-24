//! The OS interface (plan 260 S2.6a): the calls GPUI does not make for us,
//! behind one trait every platform implements. The policy is the core's
//! (`videorc_app_core::desktop`: which window hides from capture, when the
//! display is kept awake, which keys register); this layer only performs
//! the call and says honestly when it can't.
//!
//! - macOS (`macos/`, lane L4): AppKit and IOKit through `objc2`.
//! - Linux (`linux/`, lane L5): the portals and the session bus (#1809,
//!   #1815 put the policy in `desktop::linux`).
//! - Windows (`windows/`, the contributors).
//!
//! Until a platform's module lands, [`Unsupported`] answers each call with a
//! reason, never a pretend success.
//!
//! What GPUI does on every platform stays out of this trait: menus
//! (`cx.set_menus`), `videorc://` links (`on_open_urls`), opening a URL,
//! window activation.

use std::sync::Arc;

use gpui::Window;
use videorc_app_core::desktop::camera_extension::CameraExtensionBinding;
use videorc_app_core::desktop::permissions::{
    MediaAccessPermission, MediaAccessStatus, MediaPane, PermissionFuture,
};

#[cfg(target_os = "macos")]
pub mod macos;

/// What a call did, or why it couldn't.
pub type OsResult<T> = Result<T, String>;

/// The OS calls the app makes. Hide from stream and Keep on top are called
/// by the windows that need them (Notes, Preview, the Stream Manager), which
/// land with Phase 3.
#[allow(dead_code)]
pub trait Platform: Send + Sync {
    /// The platform's name, for logs.
    fn name(&self) -> &'static str;

    /// Hide from stream: keeps `window` out of every screen capture (content
    /// protection) or lets it back. Answers the OS's window number when the
    /// platform has one, which the backend's capture filter can also exclude.
    fn set_hidden_from_capture(&self, window: &Window, hidden: bool) -> OsResult<Option<u64>>;

    /// Keep on top: the window above other apps' windows, or back to normal.
    fn set_keep_on_top(&self, window: &Window, on_top: bool) -> OsResult<()>;

    /// The display sleep guard's start: keeps the display awake and answers
    /// the blocker the OS handed out (`desktop::sleep_guard`).
    fn keep_display_awake(&self, reason: &str) -> OsResult<u32>;

    /// The display sleep guard's stop.
    fn release_display(&self, blocker: u32) -> OsResult<()>;

    /// The app bundle's identifier, or `None` for a bare binary (macOS
    /// needs a bundle for notifications and TCC's per-app grants).
    fn bundle_id(&self) -> Option<String>;

    /// The grant now, in Electron's `getMediaAccessStatus` words: the exact
    /// TCC value on macOS; `not-applicable` where the OS keeps no per-app
    /// grant (the screen off macOS, everything on Linux).
    ///
    /// The default is a platform whose grants this app can't read yet:
    /// Windows keeps per-app camera and microphone toggles, answered
    /// `unknown` (the rows fall back to the backend's evidence); nothing else
    /// keeps a grant. Never a pretend `granted`.
    fn media_access(&self, permission: MediaAccessPermission) -> OsResult<MediaAccessStatus> {
        Ok(match (cfg!(windows), permission) {
            (true, MediaAccessPermission::Camera | MediaAccessPermission::Microphone) => {
                MediaAccessStatus::Unknown
            }
            _ => MediaAccessStatus::NotApplicable,
        })
    }

    /// The OS's own camera or microphone prompt; true when granted. The
    /// core asks only a never-asked computer (`not-determined`).
    ///
    /// The default is Electron's Windows path: no prompt, the status read
    /// again.
    fn ask_media_access(&self, pane: MediaPane) -> PermissionFuture<'static, OsResult<bool>> {
        let status = self.media_access(pane.permission());
        Box::pin(async move { Ok(status? == MediaAccessStatus::Granted) })
    }

    /// Lists the app under Screen & System Audio Recording and shows the
    /// OS's prompt (macOS answers it in System Settings).
    ///
    /// The default asks nothing: the core asks for the screen on macOS only.
    fn request_screen_access(&self) -> OsResult<()> {
        Ok(())
    }

    /// Videorc Camera's extension request (`desktop::camera_extension`), or
    /// `None` where the OS has no such extension: the core's controller then
    /// reports the camera unavailable, with its reason. `None` by default.
    fn camera_extension(&self) -> Option<Arc<dyn CameraExtensionBinding>> {
        None
    }
}

/// A platform whose module has not landed: every call says so.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub struct Unsupported;

#[cfg_attr(target_os = "macos", allow(dead_code))]
impl Unsupported {
    fn gap<T>(what: &str) -> OsResult<T> {
        Err(format!(
            "{what} isn't written for {} yet (plan 260 S2.6)",
            std::env::consts::OS
        ))
    }
}

impl Platform for Unsupported {
    fn name(&self) -> &'static str {
        std::env::consts::OS
    }

    fn set_hidden_from_capture(&self, _: &Window, _: bool) -> OsResult<Option<u64>> {
        Self::gap("Hide from stream")
    }

    fn set_keep_on_top(&self, _: &Window, _: bool) -> OsResult<()> {
        Self::gap("Keep on top")
    }

    fn keep_display_awake(&self, _: &str) -> OsResult<u32> {
        Self::gap("The display sleep guard")
    }

    fn release_display(&self, _: u32) -> OsResult<()> {
        Self::gap("The display sleep guard")
    }

    fn bundle_id(&self) -> Option<String> {
        None
    }
}

/// This computer's platform.
pub fn current() -> &'static dyn Platform {
    #[cfg(target_os = "macos")]
    {
        &macos::MacOs
    }
    #[cfg(not(target_os = "macos"))]
    {
        &Unsupported
    }
}
