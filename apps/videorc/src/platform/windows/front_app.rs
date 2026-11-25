//! The app in front on Windows, for Follow the app in front and the
//! password-manager hide (`videorc_app_core::studio::follow_runner`). Uses
//! `GetForegroundWindow` (and optional `SetWinEventHook
//! EVENT_SYSTEM_FOREGROUND`) for the process and image path. No pixel
//! capture; local foreground metadata only.

use std::cell::RefCell;
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::Path;
use std::sync::Mutex;

use tokio::sync::mpsc::UnboundedSender;
use videorc_app_core::scenes::follow::FrontApp;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HWND};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows_sys::Win32::UI::Accessibility::{
    HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent, WINEVENTPROC,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EVENT_SYSTEM_FOREGROUND, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
};

thread_local! {
    static SENDER: RefCell<Option<UnboundedSender<FrontApp>>> = const { RefCell::new(None) };
    static LAST: RefCell<Option<FrontApp>> = const { RefCell::new(None) };
}

/// The hook as an integer: a raw pointer is not `Send`, so a `Mutex` of it
/// could not be a `static`.
static HOOK: Mutex<Option<usize>> = Mutex::new(None);

fn wide_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    OsString::from_wide(&buf[..end])
        .to_string_lossy()
        .into_owned()
}

fn process_image_path(pid: u32) -> Option<String> {
    // SAFETY: documented PROCESS_QUERY_LIMITED_INFORMATION open; handle closed below.
    let handle: HANDLE = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let mut size = 512u32;
    let mut buf = vec![0u16; size as usize];
    // SAFETY: buffer length matches size in/out; PROCESS_NAME_FORMAT 0 = Win32 path.
    let ok = unsafe {
        QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut size)
    };
    // SAFETY: handle from OpenProcess.
    unsafe { CloseHandle(handle) };
    if ok == 0 {
        return None;
    }
    Some(wide_to_string(&buf[..size as usize]))
}

fn window_title(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    // SAFETY: stack buffer; API writes a null-terminated string.
    let len = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    if len <= 0 {
        String::new()
    } else {
        wide_to_string(&buf[..len as usize])
    }
}

fn front_from_hwnd(hwnd: HWND) -> Option<FrontApp> {
    if hwnd.is_null() {
        return None;
    }
    let mut pid = 0u32;
    // SAFETY: live HWND; pid out-param.
    let _ = unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    if pid == 0 {
        return None;
    }
    let path = process_image_path(pid)?;
    // Follow matches scenes by this id. On Windows there is no bundle id;
    // the full image path (lowercased) is the stable key, same idea as a
    // macOS bundle id for one install of an app.
    let bundle_id = path.to_lowercase();
    let name = Path::new(&path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            let title = window_title(hwnd);
            if title.is_empty() {
                bundle_id.clone()
            } else {
                title
            }
        });
    Some(FrontApp {
        bundle_id,
        name,
        pid: pid as i32,
        front_window_id: Some(format!("window:hwnd:{}", hwnd as isize)),
    })
}

fn publish(app: FrontApp) {
    let fresh = LAST.with_borrow_mut(|last| {
        if last.as_ref() == Some(&app) {
            return false;
        }
        *last = Some(app.clone());
        true
    });
    if fresh {
        SENDER.with_borrow(|sender| {
            if let Some(sender) = sender {
                let _ = sender.send(app);
            }
        });
    }
}

unsafe extern "system" fn on_foreground(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    if let Some(app) = front_from_hwnd(hwnd) {
        publish(app);
    } else if let Some(app) = frontmost() {
        publish(app);
    }
}

/// The app in front now, with its foreground window id.
pub fn frontmost() -> Option<FrontApp> {
    // SAFETY: user32; returns the foreground top-level HWND or null.
    let hwnd = unsafe { GetForegroundWindow() };
    front_from_hwnd(hwnd)
}

/// This process's image path (lowercased), for the follower's self ids.
pub fn self_bundle_id() -> Option<String> {
    process_image_path(std::process::id()).map(|path| path.to_lowercase())
}

/// Starts watching foreground changes and sends the app in front now.
/// Installs `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)`; `poll` still
/// refreshes when Follow wants window swaps inside one app.
pub fn start(sender: UnboundedSender<FrontApp>) -> bool {
    SENDER.with_borrow_mut(|slot| *slot = Some(sender));
    let hook = unsafe {
        SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            std::ptr::null_mut(),
            Some(on_foreground),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        )
    };
    if !hook.is_null() {
        if let Ok(mut slot) = HOOK.lock() {
            *slot = Some(hook as usize);
        }
    }
    if let Some(app) = frontmost() {
        publish(app);
    }
    // A failed hook still leaves polling; Follow can run.
    true
}

/// The 500 ms window watch: the app in front again, sent only when it or
/// its front window changed.
pub fn poll() {
    if let Some(app) = frontmost() {
        publish(app);
    }
}

/// Drops the WinEvent hook (tests / shutdown). Safe if never started.
#[allow(dead_code)]
pub fn stop() {
    if let Ok(mut slot) = HOOK.lock() {
        if let Some(hook) = slot.take() {
            // SAFETY: hook from SetWinEventHook on this process.
            unsafe { UnhookWinEvent(hook as HWINEVENTHOOK) };
        }
    }
    SENDER.with_borrow_mut(|slot| *slot = None);
    LAST.with_borrow_mut(|last| *last = None);
}
