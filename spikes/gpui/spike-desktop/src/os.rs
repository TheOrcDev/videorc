//! The OS calls GPUI does not make for us, behind one small interface (the
//! shape `apps/videorc/src/platform/` takes in S2.6a). macOS is complete;
//! Windows (WC-0.9) and Linux (L5) report each call as a gap until they fill
//! it in.

/// What a call did, for the event log and the summary.
pub type OsResult<T> = Result<T, String>;

#[cfg(target_os = "macos")]
mod imp {
    use super::OsResult;
    use gpui::Window;
    use objc2::rc::Retained;
    use objc2_app_kit::{NSView, NSWindow, NSWindowSharingType};
    use objc2_foundation::{NSBundle, NSString};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use std::ffi::c_void;

    /// macOS's `NSFloatingWindowLevel`, what Electron's `setAlwaysOnTop(true)` uses.
    const FLOATING_LEVEL: isize = 3;
    const NORMAL_LEVEL: isize = 0;

    fn ns_window(window: &Window) -> OsResult<Retained<NSWindow>> {
        let handle =
            HasWindowHandle::window_handle(window).map_err(|e| format!("no window handle: {e}"))?;
        let RawWindowHandle::AppKit(h) = handle.as_raw() else {
            return Err("not an AppKit window".into());
        };
        // SAFETY: GPUI hands out its live content NSView; we are on the main thread.
        let view: &NSView = unsafe { h.ns_view.cast::<NSView>().as_ref() };
        view.window()
            .ok_or_else(|| "the view has no NSWindow".into())
    }

    /// Hide from stream: `NSWindow.sharingType = .none`, what Electron's
    /// `setContentProtection(true)` sets. Returns the CGWindowID, which the
    /// backend's ScreenCaptureKit filter also excludes by id.
    pub fn set_hidden_from_capture(window: &Window, hidden: bool) -> OsResult<u64> {
        let w = ns_window(window)?;
        w.setSharingType(if hidden {
            NSWindowSharingType::None
        } else {
            NSWindowSharingType::ReadOnly
        });
        if hidden && w.sharingType() != NSWindowSharingType::None {
            return Err("sharingType did not stick".into());
        }
        Ok(w.windowNumber() as u64)
    }

    /// Keep on top at run time, on a normal window (Notes and Preview toggle it).
    /// Panels (GPUI's `WindowKind::Floating`) hide when the app deactivates,
    /// so the app keeps normal windows and raises their level instead.
    pub fn set_keep_on_top(window: &Window, on_top: bool) -> OsResult<isize> {
        let w = ns_window(window)?;
        w.setLevel(if on_top { FLOATING_LEVEL } else { NORMAL_LEVEL });
        Ok(w.level())
    }

    /// The level and `hidesOnDeactivate` of a window, for the summary.
    pub fn window_facts(window: &Window) -> OsResult<(isize, bool, u64)> {
        let w = ns_window(window)?;
        Ok((w.level(), w.hidesOnDeactivate(), w.windowNumber() as u64))
    }

    /// Lets a GPUI floating panel stay up while another app is in front.
    pub fn set_hides_on_deactivate(window: &Window, hides: bool) -> OsResult<()> {
        ns_window(window)?.setHidesOnDeactivate(hides);
        Ok(())
    }

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: *const c_void,
            level: u32,
            name: *const c_void,
            id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }
    const IOPM_ASSERTION_LEVEL_ON: u32 = 255;

    /// The sleep guard: `PreventUserIdleDisplaySleep`, which `pmset -g
    /// assertions` lists under the process. Returns the assertion id.
    pub fn keep_awake_start(reason: &str) -> OsResult<u32> {
        let kind = NSString::from_str("PreventUserIdleDisplaySleep");
        let name = NSString::from_str(reason);
        let mut id = 0u32;
        // SAFETY: NSString is toll-free bridged to CFStringRef; both live for the call.
        let status = unsafe {
            IOPMAssertionCreateWithName(
                Retained::as_ptr(&kind).cast(),
                IOPM_ASSERTION_LEVEL_ON,
                Retained::as_ptr(&name).cast(),
                &mut id,
            )
        };
        if status == 0 {
            Ok(id)
        } else {
            Err(format!("IOPMAssertionCreateWithName returned {status:#x}"))
        }
    }

    pub fn keep_awake_stop(id: u32) -> OsResult<()> {
        // SAFETY: id came from IOPMAssertionCreateWithName.
        let status = unsafe { IOPMAssertionRelease(id) };
        if status == 0 {
            Ok(())
        } else {
            Err(format!("IOPMAssertionRelease returned {status:#x}"))
        }
    }

    /// The bundle id, or None for a bare binary. macOS notifications need a
    /// bundle (UNUserNotificationCenter aborts the process without one).
    pub fn bundle_id() -> Option<String> {
        NSBundle::mainBundle()
            .bundleIdentifier()
            .map(|s| s.to_string())
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    //! Windows (WC-0.9) and Linux (L5) fill these in; until then each call
    //! is reported as a gap rather than faked.
    use super::OsResult;
    use gpui::Window;

    fn gap<T>(what: &str) -> OsResult<T> {
        Err(format!(
            "{what}: not written for {} yet (WC-0.9 on Windows, L5 on Linux)",
            std::env::consts::OS
        ))
    }
    pub fn set_hidden_from_capture(_: &Window, _: bool) -> OsResult<u64> {
        gap("hide from capture")
    }
    pub fn set_keep_on_top(_: &Window, _: bool) -> OsResult<isize> {
        gap("keep on top")
    }
    pub fn window_facts(_: &Window) -> OsResult<(isize, bool, u64)> {
        gap("window facts")
    }
    pub fn set_hides_on_deactivate(_: &Window, _: bool) -> OsResult<()> {
        Ok(())
    }
    pub fn keep_awake_start(_: &str) -> OsResult<u32> {
        gap("sleep guard")
    }
    pub fn keep_awake_stop(_: u32) -> OsResult<()> {
        gap("sleep guard")
    }
    pub fn bundle_id() -> Option<String> {
        None
    }
}

pub use imp::*;

/// Whether this platform can post a system notification from this process.
pub fn can_notify() -> Result<(), String> {
    if cfg!(target_os = "macos") && bundle_id().is_none() {
        return Err(
            "macOS notifications need an app bundle: run ./bundle-macos.sh and start the .app"
                .into(),
        );
    }
    Ok(())
}
