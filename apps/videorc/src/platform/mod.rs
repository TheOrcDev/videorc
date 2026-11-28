//! The OS interface (plan 260 S2.6a): the calls GPUI does not make for us,
//! behind one trait every platform implements. The policy is the core's
//! (`videorc_app_core::desktop`: which window hides from capture, when the
//! display is kept awake, which keys register); this layer only performs
//! the call and says honestly when it can't.
//!
//! - macOS (`macos/`, lane L4): AppKit and IOKit through `objc2`.
//! - Linux (`linux/`, lane L5): the portals and the session bus (#1809,
//!   #1815 put the policy in `desktop::linux`).
//! - Windows (`windows/`, C4 platform fill-ins): Win32 through `windows-sys`.
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

pub mod idle;
#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

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

    /// The window's number in the OS's capture APIs (macOS's
    /// `windowNumber`, which ScreenCaptureKit's filter excludes by), or
    /// `None` where captures don't name windows by it (the default).
    fn capture_window_id(&self, _window: &Window) -> Option<u32> {
        None
    }

    /// The smokes' window placement (`*-window-set-bounds`): the window's
    /// frame in screen points, top-left origin on the primary display as
    /// Electron's `setBounds` takes it, brought to the front without focus.
    fn set_window_frame(&self, _window: &Window, _frame: ScreenFrame) -> OsResult<()> {
        Err(format!(
            "Placing a window isn't written for {} yet (plan 260 S2.6)",
            std::env::consts::OS
        ))
    }

    /// Screen-key placement in the coordinates returned by `window_frame`.
    fn set_remote_window_frame(&self, window: &Window, frame: ScreenFrame) -> OsResult<()> {
        self.set_window_frame(window, frame)
    }

    /// Global screen coordinates, matching the Screen key's placement API.
    fn window_frame(
        &self,
        window: &Window,
    ) -> OsResult<videorc_app_core::desktop::window_frames::Rect> {
        Ok(crate::app::frames::rect_of(window.bounds()))
    }

    /// Shown and not minimized, independent of occlusion by other windows.
    fn window_shown(&self, window: &Window) -> bool {
        window.visibility() != gpui::WindowVisibility::Hidden
    }

    /// Restore/show after placement; Monitor never requests activation.
    fn show_window(&self, _window: &Window, _focus: bool) -> OsResult<()> {
        Ok(())
    }

    /// Monitor arrival hands focus back only when the Stream Manager had it.
    fn return_screen_key_focus(&self, _window: &Window) {}

    /// Electron's `setAspectRatio` and `setMinimumSize` for the floating
    /// Preview: the user's drag-resizes keep the content at `aspect`
    /// (width, height), never smaller than `min` (points).
    fn lock_content_aspect(
        &self,
        _window: &Window,
        _aspect: (f64, f64),
        _min: (f64, f64),
    ) -> OsResult<()> {
        Err(format!(
            "Locking a window's aspect isn't written for {} yet",
            std::env::consts::OS
        ))
    }

    /// The most content height the window can have on its display: the
    /// display's work area less the window's own title bar.
    fn content_room(&self, _window: &Window) -> OsResult<f64> {
        Err(format!(
            "Measuring a window's display isn't written for {} yet",
            std::env::consts::OS
        ))
    }

    /// A resize of the window's content to `size` (points), its top-left
    /// corner kept and the window kept inside its display's work area, as
    /// Electron's `setContentSize`. The caller runs it from a task, never
    /// inside a GPUI update: the OS tells GPUI about the new size at once,
    /// and GPUI can't take it while it is borrowed (the window would keep
    /// its old viewport).
    fn content_resize(&self, _window: &Window, _size: (f64, f64)) -> OsResult<Box<dyn FnOnce()>> {
        Err(format!(
            "Resizing a window's content isn't written for {} yet",
            std::env::consts::OS
        ))
    }

    /// The smokes' `preview-window-os-close`: the window closes as a click
    /// on its close button closes it, so the app's own should-close path
    /// runs (never `remove_window`, which skips it).
    fn perform_close(&self, _window: &Window) -> OsResult<()> {
        Err(format!(
            "Closing a window as its close button does isn't written for {} yet (plan 260 S2.6)",
            std::env::consts::OS
        ))
    }

    /// The smokes' `raise-window`: the window at `level`, in front, without
    /// taking focus.
    fn raise_window(&self, _window: &Window, _level: SmokeWindowLevel) -> OsResult<()> {
        Err(format!(
            "Raising a window isn't written for {} yet (plan 260 S2.6)",
            std::env::consts::OS
        ))
    }

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

/// A window frame in screen points, top-left origin on the primary display.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// `raise-window`'s levels (Electron's `setAlwaysOnTop` levels).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmokeWindowLevel {
    /// `floating`: what Keep on top uses.
    Floating,
    /// `screen-saver`: above the invisibility smokes' motion stimulus.
    ScreenSaver,
}

impl SmokeWindowLevel {
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value {
            None | Some("floating") => Ok(Self::Floating),
            Some("screen-saver") => Ok(Self::ScreenSaver),
            Some(other) => Err(format!("raise-window: no level is called {other:?}.")),
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Floating => "floating",
            Self::ScreenSaver => "screen-saver",
        }
    }
}

/// A platform whose module has not landed: every call says so.
#[cfg_attr(
    any(target_os = "macos", target_os = "linux", target_os = "windows"),
    allow(dead_code)
)]
pub struct Unsupported;

#[cfg_attr(
    any(target_os = "macos", target_os = "linux", target_os = "windows"),
    allow(dead_code)
)]
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
    #[cfg(target_os = "linux")]
    {
        linux::platform()
    }
    #[cfg(target_os = "windows")]
    {
        &windows::WindowsOs
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        &Unsupported
    }
}

/// Whether a window's native title bar should use dark chrome for the app's
/// theme override (`None` = System) and the OS window's current appearance.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn effective_title_bar_dark(
    override_appearance: Option<gpui::WindowAppearance>,
    window_appearance: gpui::WindowAppearance,
) -> bool {
    matches!(
        override_appearance.unwrap_or(window_appearance),
        gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark
    )
}

/// Sync a window's Windows DWM title bar dark/light mode to the app's
/// effective appearance. macOS and Linux are untouched.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn sync_window_title_bar_appearance(window: &Window, cx: &gpui::App) {
    #[cfg(target_os = "windows")]
    {
        let override_appearance = cx
            .try_global::<videorc_kit::theme::AppearanceOverride>()
            .and_then(|override_value| override_value.0);
        let dark = effective_title_bar_dark(override_appearance, window.appearance());
        let _ = windows::set_title_bar_dark_mode(window, dark);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (window, cx);
}

/// Apply the current appearance to a newly opened window's title bar and keep
/// it updated when Windows' own OS theme flips while Videorc is on System.
pub fn install_title_bar_appearance_sync(window: &mut Window, cx: &gpui::App) {
    #[cfg(target_os = "windows")]
    {
        sync_window_title_bar_appearance(window, cx);
        window
            .observe_window_appearance(|window, cx| {
                sync_window_title_bar_appearance(window, cx);
            })
            .detach();
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (window, cx);
}

/// Apply the app's appearance override (`None` = System), update every open
/// window's native title bar on Windows, and refresh all windows.
pub fn apply_window_appearance(appearance: Option<gpui::WindowAppearance>, cx: &mut gpui::App) {
    cx.set_window_appearance(appearance);
    cx.set_global(videorc_kit::theme::AppearanceOverride(appearance));
    #[cfg(target_os = "windows")]
    for handle in cx.windows() {
        let _ = handle.update(cx, |_, window, cx| {
            sync_window_title_bar_appearance(window, cx);
        });
    }
    cx.refresh_windows();
}

/// How this computer writes a day and a time (`format::day_label`), as
/// `Intl.DateTimeFormat` with the system locale writes it in Electron: on
/// macOS the system's own pattern for the user's region and 12/24-hour
/// setting, on Windows the user locale and its time format. None elsewhere:
/// on Linux the core reads `LC_ALL`/`LC_TIME`/`LANG` itself.
pub fn system_date_style() -> Option<videorc_app_core::format::DateStyle> {
    #[cfg(target_os = "macos")]
    {
        macos::date_style()
    }
    #[cfg(target_os = "windows")]
    {
        windows::date_style()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use gpui::WindowAppearance;

    use super::effective_title_bar_dark;

    #[test]
    fn title_bar_dark_mode_matches_light_dark_and_system_against_both_windows_modes() {
        // Explicit Light override turns off immersive dark mode even when Windows is dark.
        assert!(!effective_title_bar_dark(
            Some(WindowAppearance::Light),
            WindowAppearance::Dark
        ));
        assert!(!effective_title_bar_dark(
            Some(WindowAppearance::Light),
            WindowAppearance::Light
        ));

        // Explicit Dark override turns on immersive dark mode even when Windows is light.
        assert!(effective_title_bar_dark(
            Some(WindowAppearance::Dark),
            WindowAppearance::Light
        ));
        assert!(effective_title_bar_dark(
            Some(WindowAppearance::Dark),
            WindowAppearance::Dark
        ));

        // System (None) follows Windows' own appearance.
        assert!(!effective_title_bar_dark(None, WindowAppearance::Light));
        assert!(effective_title_bar_dark(None, WindowAppearance::Dark));
        assert!(!effective_title_bar_dark(
            None,
            WindowAppearance::VibrantLight
        ));
        assert!(effective_title_bar_dark(
            None,
            WindowAppearance::VibrantDark
        ));
    }
}
