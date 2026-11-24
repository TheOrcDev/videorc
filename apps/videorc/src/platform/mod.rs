//! The OS interface (plan 260 S2.6a): the calls GPUI does not make for us,
//! behind one trait every platform implements. The policy is the core's
//! (`videorc_app_core::desktop`: which window hides from capture, when the
//! display is kept awake, which keys register); this layer only performs
//! the call and says honestly when it can't.
//!
//! - macOS (`macos/`, lane L4): AppKit and IOKit through `objc2`.
//! - Linux (`linux/`, lane L5): the portals and the session bus (#1809,
//!   #1815 put the policy in `desktop::linux`).
//! - Windows (`windows/`, S2.6b): Win32 through `windows-sys`, toasts
//!   through WinRT; written without a build, verified by the contributors.
//!
//! Until a platform's module lands, [`Unsupported`] answers each call with a
//! reason, never a pretend success.
//!
//! What GPUI does on every platform stays out of this trait: menus
//! (`cx.set_menus`), `videorc://` links (`on_open_urls`), opening a URL,
//! window activation.

use gpui::Window;

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

/// What a call did, or why it couldn't.
pub type OsResult<T> = Result<T, String>;

/// Where `videorc://` links open.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub enum LinkHandler {
    /// The bundle or desktop entry declares it; nothing to write.
    Declared,
    /// This executable took the handler.
    Registered,
    /// This executable held it already.
    AlreadyRegistered,
    /// Another program holds it and this build leaves it there: the
    /// command found.
    LeftFor(String),
}

/// A system notification (Electron's `Notification`). The stream
/// watchdog's alert sends one when the Stream Manager lands (Phase 3).
#[allow(dead_code)]
pub struct Notice {
    pub title: String,
    pub body: String,
    pub silent: bool,
    /// Runs on an OS thread when the notification is clicked while the app
    /// runs.
    pub on_click: Option<Box<dyn Fn() + Send + Sync>>,
}

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

    /// Gives the process the app's id before any window opens. Windows
    /// groups the taskbar and shows toasts by it (Electron's
    /// `setAppUserModelId`); macOS and Linux read it from the bundle or the
    /// desktop entry.
    fn set_app_id(&self, _app_id: &str) -> OsResult<()> {
        Ok(())
    }

    /// Makes this executable where `scheme://` links open (Electron's
    /// `setAsDefaultProtocolClient`).
    fn register_link_handler(&self, _scheme: &str) -> OsResult<LinkHandler> {
        Ok(LinkHandler::Declared)
    }

    /// A second launch, before it hands its links over: lets the running
    /// app bring its window to the front (Windows refuses the foreground to
    /// a background process otherwise).
    fn allow_handoff_focus(&self) -> OsResult<()> {
        Ok(())
    }

    /// Shows a system notification.
    fn notify(&self, _notice: Notice) -> OsResult<()> {
        Err(format!(
            "System notifications aren't written for {} yet (plan 260 S2.6)",
            std::env::consts::OS
        ))
    }
}

/// A platform whose module has not landed: every call says so.
#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
pub struct Unsupported;

#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
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

    fn register_link_handler(&self, _: &str) -> OsResult<LinkHandler> {
        Self::gap("The videorc:// handler")
    }
}

/// This computer's platform.
pub fn current() -> &'static dyn Platform {
    #[cfg(target_os = "macos")]
    {
        &macos::MacOs
    }
    #[cfg(target_os = "windows")]
    {
        &windows::Windows
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        &Unsupported
    }
}
