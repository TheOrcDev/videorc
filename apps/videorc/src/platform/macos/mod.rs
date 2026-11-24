//! macOS (plan 260 S2.6a, lane L4): the AppKit and IOKit calls behind
//! [`Platform`], as spike S0.7 (`spikes/gpui/spike-desktop/src/os.rs`)
//! proved them under GPUI 0.3.14.

use std::ffi::c_void;

use gpui::Window;
use objc2::ClassType;
use objc2::rc::Retained;
use objc2_app_kit::{NSView, NSWindow, NSWindowSharingType};
use objc2_av_foundation::{
    AVAuthorizationStatus, AVCaptureDevice, AVMediaType, AVMediaTypeAudio, AVMediaTypeVideo,
};
use objc2_foundation::{NSBundle, NSString};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use videorc_app_core::desktop::permissions::{
    MediaAccessPermission, MediaAccessStatus, MediaPane, PermissionFuture,
};

use super::{OsResult, Platform};

/// `NSFloatingWindowLevel`, what Electron's `setAlwaysOnTop(true)` uses.
const FLOATING_LEVEL: isize = 3;
const NORMAL_LEVEL: isize = 0;

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

/// `kIOPMAssertionLevelOn`.
const ASSERTION_LEVEL_ON: u32 = 255;

/// Electron's `powerSaveBlocker.start('prevent-display-sleep')` on macOS:
/// Chromium's `kIOPMAssertionTypeNoDisplaySleep`, as the Rust app holds it
/// (`SLEEP_ASSERTION_TYPE` in videorc-rust's `desktop/permissions.rs`).
const SLEEP_ASSERTION_TYPE: &str = "NoDisplaySleepAssertion";

/// AVFoundation's media type for a camera or microphone grant.
fn media_type(permission: MediaAccessPermission) -> Option<&'static AVMediaType> {
    // SAFETY: AVFoundation's constant strings, alive for the process.
    unsafe {
        match permission {
            MediaAccessPermission::Camera => AVMediaTypeVideo,
            MediaAccessPermission::Microphone => AVMediaTypeAudio,
            MediaAccessPermission::Screen => None,
        }
    }
}

/// The window's `NSWindow`, from the content view GPUI hands out.
fn ns_window(window: &Window) -> OsResult<Retained<NSWindow>> {
    let handle = HasWindowHandle::window_handle(window)
        .map_err(|error| format!("no window handle: {error}"))?;
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return Err("not an AppKit window".into());
    };
    // SAFETY: GPUI hands out its live content NSView, and this runs on the
    // main thread (every GPUI window call does).
    let view: &NSView = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
    view.window()
        .ok_or_else(|| "the view has no NSWindow".into())
}

pub struct MacOs;

impl Platform for MacOs {
    fn name(&self) -> &'static str {
        "macos"
    }

    /// `NSWindow.sharingType = .none`, what Electron's
    /// `setContentProtection(true)` sets. The window number is what the
    /// backend's ScreenCaptureKit filter excludes by id.
    fn set_hidden_from_capture(&self, window: &Window, hidden: bool) -> OsResult<Option<u64>> {
        let window = ns_window(window)?;
        window.setSharingType(if hidden {
            NSWindowSharingType::None
        } else {
            NSWindowSharingType::ReadOnly
        });
        if hidden && window.sharingType() != NSWindowSharingType::None {
            return Err("the window's sharing type did not stick".into());
        }
        Ok(Some(window.windowNumber() as u64))
    }

    /// A normal window's level raised (panels hide when the app
    /// deactivates, so the app keeps normal windows).
    fn set_keep_on_top(&self, window: &Window, on_top: bool) -> OsResult<()> {
        ns_window(window)?.setLevel(if on_top { FLOATING_LEVEL } else { NORMAL_LEVEL });
        Ok(())
    }

    /// Electron's assertion type, which `pmset -g assertions` lists under
    /// the process with `reason` as its name.
    fn keep_display_awake(&self, reason: &str) -> OsResult<u32> {
        let kind = NSString::from_str(SLEEP_ASSERTION_TYPE);
        let name = NSString::from_str(reason);
        let mut id = 0u32;
        // SAFETY: NSString is toll-free bridged to CFStringRef; both live for
        // the call.
        let status = unsafe {
            IOPMAssertionCreateWithName(
                Retained::as_ptr(&kind).cast(),
                ASSERTION_LEVEL_ON,
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

    fn release_display(&self, blocker: u32) -> OsResult<()> {
        // SAFETY: the id came from IOPMAssertionCreateWithName.
        let status = unsafe { IOPMAssertionRelease(blocker) };
        if status == 0 {
            Ok(())
        } else {
            Err(format!("IOPMAssertionRelease returned {status:#x}"))
        }
    }

    fn bundle_id(&self) -> Option<String> {
        NSBundle::mainBundle()
            .bundleIdentifier()
            .map(|id| id.to_string())
    }

    /// `AVCaptureDevice.authorizationStatus` for the camera and the
    /// microphone; `CGPreflightScreenCaptureAccess` for the screen, which
    /// answers granted or denied only (a never-asked bundle reads denied, as
    /// Electron's does).
    fn media_access(&self, permission: MediaAccessPermission) -> OsResult<MediaAccessStatus> {
        if permission == MediaAccessPermission::Screen {
            return Ok(if objc2_core_graphics::CGPreflightScreenCaptureAccess() {
                MediaAccessStatus::Granted
            } else {
                MediaAccessStatus::Denied
            });
        }
        let media_type = media_type(permission)
            .ok_or_else(|| format!("AVFoundation has no media type for {}", permission.as_str()))?;
        // SAFETY: a class method with a valid media type.
        let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
        // Guards, not patterns: the status is an `NSInteger` newtype.
        Ok(match status {
            status if status == AVAuthorizationStatus::NotDetermined => {
                MediaAccessStatus::NotDetermined
            }
            status if status == AVAuthorizationStatus::Restricted => MediaAccessStatus::Restricted,
            status if status == AVAuthorizationStatus::Denied => MediaAccessStatus::Denied,
            status if status == AVAuthorizationStatus::Authorized => MediaAccessStatus::Granted,
            _ => MediaAccessStatus::Unknown,
        })
    }

    /// `+requestAccessForMediaType:completionHandler:`: macOS's prompt. The
    /// request is sent now; the future waits for the answer, which arrives
    /// on an AVFoundation queue.
    fn ask_media_access(&self, pane: MediaPane) -> PermissionFuture<'static, OsResult<bool>> {
        let Some(media_type) = media_type(pane.permission()) else {
            let error = format!("AVFoundation has no media type for {}", pane.as_str());
            return Box::pin(async move { Err(error) });
        };
        let (reply, answer) = tokio::sync::oneshot::channel();
        let reply = std::sync::Mutex::new(Some(reply));
        let handler = block2::RcBlock::new(move |granted: objc2::runtime::Bool| {
            if let Some(reply) = reply.lock().ok().and_then(|mut reply| reply.take()) {
                let _ = reply.send(granted.as_bool());
            }
        });
        // Sent by hand, as the Rust app does: the typed binding needs the
        // crate's `block2` feature, which the backend's build of it lacks.
        // AVFoundation copies the block, so ours can go when this returns.
        let handler: &block2::Block<dyn Fn(objc2::runtime::Bool)> = &handler;
        // SAFETY: the selector's documented signature, a valid media type
        // and a block taking one BOOL.
        let _: () = unsafe {
            objc2::msg_send![
                AVCaptureDevice::class(),
                requestAccessForMediaType: media_type,
                completionHandler: handler
            ]
        };
        Box::pin(async move {
            answer
                .await
                .map_err(|_| "macOS never answered the access request.".to_string())
        })
    }

    /// `CGRequestScreenCaptureAccess`: adds the app to Screen & System
    /// Audio Recording and shows macOS's prompt. Its answer is not the
    /// grant (that lands in System Settings); the core re-reads the status.
    fn request_screen_access(&self) -> OsResult<()> {
        let _ = objc2_core_graphics::CGRequestScreenCaptureAccess();
        Ok(())
    }
}
