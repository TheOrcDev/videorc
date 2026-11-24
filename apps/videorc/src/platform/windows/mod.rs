//! Windows (plan 260 S2.6b): the Win32 calls behind [`Platform`], ported
//! from the Electron app's Windows paths (`apps/desktop/src/main`). Written
//! on macOS without a build; the contributors verify it on their PCs.
//!
//! - Hide from stream: `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`,
//!   what Electron's `setContentProtection(true)` sets on Windows. Windows'
//!   monitor capture has no exclusion list, so this is the only route, and it
//!   hides the window from every capture app and screenshot too
//!   (`streamManagerHideMethod`, plan 215 D6).
//! - Keep on top: `SetWindowPos(HWND_TOPMOST)`, Electron's
//!   `setAlwaysOnTop(true, 'floating')`.
//! - The display sleep guard: a power request (`PowerCreateRequest`,
//!   display and system required), what Electron's
//!   `powerSaveBlocker.start('prevent-display-sleep')` makes on Windows. Not
//!   `SetThreadExecutionState`: its state belongs to the calling thread, and
//!   the guard starts and stops on whichever core worker runs the session
//!   event, so a stop on another thread would never clear it. A request is a
//!   handle any thread can clear, and `powercfg /requests` lists it under the
//!   reason.
//! - The app id: `SetCurrentProcessExplicitAppUserModelID`, Electron's
//!   `setAppUserModelId('dev.theorcdev.videorc')`; Windows shows a toast only
//!   for an app with one (plan 223 A7).
//! - `videorc://`: the per-user registry class ([`links`]), Electron's
//!   `setAsDefaultProtocolClient`. A link starts `Videorc.exe <link>`; the
//!   core's single instance hands it to the running app.
//! - Notifications: WinRT toasts under the app id ([`toast`]).
//!
//! Global shortcuts need nothing here: `global-hotkey` registers them with
//! `RegisterHotKey` on a message-only window GPUI's message loop serves. The
//! menus need nothing either: Windows gets no menu bar, as the packaged
//! Electron app has none (`desktop::menu`).

mod links;
mod toast;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};

use gpui::Window;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, HANDLE, HWND, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::System::Power::{
    PowerClearRequest, PowerCreateRequest, PowerRequestDisplayRequired, PowerRequestSystemRequired,
    PowerSetRequest,
};
use windows_sys::Win32::System::Threading::{
    POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
};
use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    ASFW_ANY, AllowSetForegroundWindow, GetWindowDisplayAffinity, HWND_NOTOPMOST, HWND_TOPMOST,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowDisplayAffinity, SetWindowPos,
    WDA_EXCLUDEFROMCAPTURE, WDA_MONITOR, WDA_NONE,
};

use super::{LinkHandler, Notice, OsResult, Platform};

/// `POWER_REQUEST_CONTEXT_VERSION` (minwinbase.h).
const POWER_REQUEST_CONTEXT_VERSION: u32 = 0;

/// The app id this process runs under, once [`Platform::set_app_id`] took.
static APP_ID: OnceLock<String> = OnceLock::new();

/// The power requests held, by the blocker the guard was handed. A handle
/// is kept as an address so the map is `Send`.
static REQUESTS: Mutex<Option<HashMap<u32, usize>>> = Mutex::new(None);
static NEXT_BLOCKER: AtomicU32 = AtomicU32::new(1);

/// `text` as a NUL-terminated UTF-16 string.
pub(super) fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The last Win32 error, for a message.
pub(super) fn last_error(call: &str) -> String {
    // SAFETY: reads the calling thread's last-error value.
    let code = unsafe { GetLastError() };
    format!("{call} failed (error {code})")
}

/// The window's `HWND`, from the handle GPUI hands out.
fn hwnd(window: &Window) -> OsResult<HWND> {
    let handle = HasWindowHandle::window_handle(window)
        .map_err(|error| format!("no window handle: {error}"))?;
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return Err("not a Win32 window".into());
    };
    Ok(handle.hwnd.get() as HWND)
}

fn requests() -> std::sync::MutexGuard<'static, Option<HashMap<u32, usize>>> {
    REQUESTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub struct Windows;

impl Platform for Windows {
    fn name(&self) -> &'static str {
        "windows"
    }

    /// `WDA_EXCLUDEFROMCAPTURE` on, `WDA_NONE` off, read back so a refusal
    /// is never reported as hidden. Windows before 10 2004 keeps
    /// `WDA_MONITOR` instead (a black box in captures), which still hides
    /// the content. No window number: the backend's monitor capture can't
    /// exclude one.
    fn set_hidden_from_capture(&self, window: &Window, hidden: bool) -> OsResult<Option<u64>> {
        let hwnd = hwnd(window)?;
        let wanted = if hidden {
            WDA_EXCLUDEFROMCAPTURE
        } else {
            WDA_NONE
        };
        // SAFETY: a live top-level window of this process, on the main
        // thread (every GPUI window call is).
        if unsafe { SetWindowDisplayAffinity(hwnd, wanted) } == 0 {
            return Err(last_error("SetWindowDisplayAffinity"));
        }
        let mut affinity = 0u32;
        // SAFETY: as above; `affinity` outlives the call.
        if unsafe { GetWindowDisplayAffinity(hwnd, &mut affinity) } == 0 {
            return Err(last_error("GetWindowDisplayAffinity"));
        }
        let held = if hidden {
            affinity == WDA_EXCLUDEFROMCAPTURE || affinity == WDA_MONITOR
        } else {
            affinity == WDA_NONE
        };
        if !held {
            return Err(format!(
                "the window's display affinity is {affinity:#x}, not {wanted:#x}"
            ));
        }
        Ok(None)
    }

    /// Topmost or back, without moving, sizing or activating the window.
    fn set_keep_on_top(&self, window: &Window, on_top: bool) -> OsResult<()> {
        let hwnd = hwnd(window)?;
        let after = if on_top { HWND_TOPMOST } else { HWND_NOTOPMOST };
        // SAFETY: a live window of this process, on the main thread.
        let set = unsafe {
            SetWindowPos(
                hwnd,
                after,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
        };
        if set == 0 {
            return Err(last_error("SetWindowPos"));
        }
        Ok(())
    }

    fn keep_display_awake(&self, reason: &str) -> OsResult<u32> {
        let mut reason = wide(reason);
        let context = REASON_CONTEXT {
            Version: POWER_REQUEST_CONTEXT_VERSION,
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            Reason: REASON_CONTEXT_0 {
                SimpleReasonString: reason.as_mut_ptr(),
            },
        };
        // SAFETY: the context and its string live for the call; Windows
        // copies the reason.
        let request: HANDLE = unsafe { PowerCreateRequest(&context) };
        if request.is_null() || request == INVALID_HANDLE_VALUE {
            return Err(last_error("PowerCreateRequest"));
        }
        for kind in [PowerRequestDisplayRequired, PowerRequestSystemRequired] {
            // SAFETY: the request was just created and is still open.
            if unsafe { PowerSetRequest(request, kind) } == 0 {
                let error = last_error("PowerSetRequest");
                // SAFETY: closing the request clears whatever it set.
                unsafe { CloseHandle(request) };
                return Err(error);
            }
        }
        let blocker = NEXT_BLOCKER.fetch_add(1, Ordering::Relaxed);
        requests()
            .get_or_insert_with(HashMap::new)
            .insert(blocker, request as usize);
        Ok(blocker)
    }

    fn release_display(&self, blocker: u32) -> OsResult<()> {
        let Some(request) = requests().as_mut().and_then(|held| held.remove(&blocker)) else {
            return Err(format!("no power request {blocker} is held"));
        };
        let request = request as HANDLE;
        let mut errors = Vec::new();
        for kind in [PowerRequestDisplayRequired, PowerRequestSystemRequired] {
            // SAFETY: the request is open until the CloseHandle below.
            if unsafe { PowerClearRequest(request, kind) } == 0 {
                errors.push(last_error("PowerClearRequest"));
            }
        }
        // SAFETY: taken out of the map, so nothing else closes it.
        if unsafe { CloseHandle(request) } == 0 {
            errors.push(last_error("CloseHandle"));
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    /// The AppUserModelID [`Platform::set_app_id`] gave the process.
    fn bundle_id(&self) -> Option<String> {
        APP_ID.get().cloned()
    }

    /// Before any window, so the taskbar groups the windows under it and
    /// toasts show. The installer's Start menu shortcut carries the same
    /// id; a run without one is named for toasts in the registry
    /// ([`links::name_app_id`]).
    fn set_app_id(&self, app_id: &str) -> OsResult<()> {
        let id = wide(app_id);
        // SAFETY: a NUL-terminated string that lives for the call.
        let result = unsafe { SetCurrentProcessExplicitAppUserModelID(id.as_ptr()) };
        if result < 0 {
            return Err(format!(
                "SetCurrentProcessExplicitAppUserModelID returned {result:#x}"
            ));
        }
        let _ = APP_ID.set(app_id.to_string());
        links::name_app_id(app_id)
    }

    fn register_link_handler(&self, scheme: &str) -> OsResult<LinkHandler> {
        links::register(scheme)
    }

    /// Windows lets a background process take the foreground only when the
    /// foreground one allows it; the second launch is the one the user just
    /// started, so it allows the running app before handing over.
    fn allow_handoff_focus(&self) -> OsResult<()> {
        // SAFETY: no pointers; ASFW_ANY names no particular process.
        if unsafe { AllowSetForegroundWindow(ASFW_ANY) } == 0 {
            return Err(last_error("AllowSetForegroundWindow"));
        }
        Ok(())
    }

    fn notify(&self, notice: Notice) -> OsResult<()> {
        let Some(app_id) = APP_ID.get() else {
            return Err("toasts need the app id, which isn't set".into());
        };
        toast::show(app_id, notice)
    }
}
