//! Turning GPUI's accessibility on for a smoke run (plan 260 S2.5).
//!
//! GPUI builds a window's AccessKit tree only once the platform's adapter
//! says assistive technology is there: the first time VoiceOver asks the
//! window's view for its children (macOS), or Narrator sends the window
//! `WM_GETOBJECT` (Windows). A smoke runs without a screen reader, so the
//! driver asks the same question of its own window, in its own process: no
//! Accessibility grant is involved, nothing reaches the OS's assistive
//! technology, and from then on GPUI keeps the tree each frame.
//!
//! Linux's adapter listens for the AT-SPI bus's screen-reader switch
//! instead; turning it on is S2.6c's (L5), so the driver says so by name.

use gpui::Window;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

/// The window's native handle, taken while the window is borrowed, so the
/// question is asked after GPUI has let go of it (the adapter's answer
/// re-enters the window's own code).
#[derive(Debug, Clone, Copy)]
pub enum NativeWindow {
    /// The window's `NSView`.
    #[cfg(target_os = "macos")]
    AppKit(*mut std::ffi::c_void),
    /// The window's `HWND`.
    #[cfg(target_os = "windows")]
    Win32(isize),
    Other,
}

// The pointer is only used on the foreground thread that took it.
unsafe impl Send for NativeWindow {}

/// The handle of `window`.
pub fn native_window(window: &Window) -> NativeWindow {
    match HasWindowHandle::window_handle(window).map(|handle| handle.as_raw()) {
        #[cfg(target_os = "macos")]
        Ok(RawWindowHandle::AppKit(handle)) => NativeWindow::AppKit(handle.ns_view.as_ptr()),
        #[cfg(target_os = "windows")]
        Ok(RawWindowHandle::Win32(handle)) => NativeWindow::Win32(handle.hwnd.get()),
        _ => NativeWindow::Other,
    }
}

/// Asks the window's accessibility adapter for its tree, as a screen reader
/// does first (macOS: the window's content view, where AccessKit's adapter
/// lives). GPUI then activates and draws a frame with the tree.
pub fn activate(native: NativeWindow) -> Result<(), String> {
    match native {
        #[cfg(target_os = "macos")]
        NativeWindow::AppKit(view) => {
            use objc2::msg_send;
            use objc2::runtime::AnyObject;
            if view.is_null() {
                return Err("The window has no view yet.".into());
            }
            // GPUI's window handle names its own `GPUIView`, a subview of the
            // window's content view; `SubclassingAdapter::for_window` (in
            // gpui-pre-macos's `a11y_init`) subclasses the CONTENT view, so
            // that is the view whose `accessibilityChildren` reaches AccessKit
            // and calls GPUI's activation handler. Asking the GPUIView (a
            // plain NSView here) never activated anything: the tree never
            // arrived in a smoke run (L6, first runs on 010616c0d).
            let content: *mut AnyObject = unsafe {
                let window: *mut AnyObject = msg_send![view.cast::<AnyObject>(), window];
                if window.is_null() {
                    return Err("The window's view is not in a window yet.".into());
                }
                msg_send![window, contentView]
            };
            if content.is_null() {
                return Err("The window has no content view yet.".into());
            }
            let _children: *mut AnyObject = unsafe { msg_send![content, accessibilityChildren] };
            Ok(())
        }
        #[cfg(target_os = "windows")]
        NativeWindow::Win32(hwnd) => {
            use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageW, WM_GETOBJECT};
            /// `UiaRootObjectId`: what UI Automation asks a window for.
            const UIA_ROOT_OBJECT_ID: isize = -25;
            // `accesskit_windows::Adapter` answers it in GPUI's window
            // procedure and activates on the way.
            unsafe { SendMessageW(hwnd as _, WM_GETOBJECT, 0, UIA_ROOT_OBJECT_ID) };
            Ok(())
        }
        NativeWindow::Other => Err(
            "The UI driver cannot turn accessibility on for this window here: on Linux the \
             AT-SPI screen-reader switch is plan 260 S2.6c's."
                .into(),
        ),
    }
}
