//! Process-lifetime COM/WinRT anchors for the Windows backend.
//!
//! Root cause this guards against (Windows Alpha `0xC0000005` crash loop):
//! every capture/encoder/audio worker thread joins the MTA for its own
//! lifetime (`RoInitialize`/`CoInitializeEx`) and leaves it on exit. When the
//! LAST such thread leaves, COM tears the MTA down and unloads every in-proc
//! COM/WinRT server it loaded — `GraphicsCapture.dll`, `Windows.Media.dll`,
//! `wintypes.dll`, … — immediately. A screen-preview restart is exactly that
//! moment: the old Windows Graphics Capture thread `Close()`s its session,
//! calls `RoUninitialize()`, and GraphicsCapture's own internal worker thread
//! (still draining the closed frame pool) resumes into an unmapped image:
//! `EXCEPTION_ACCESS_VIOLATION_EXEC` at `unloaded GraphicsCapture.dll+0x…`.
//! Both captured minidumps (2026-10-10 and 2026-10-20) show that exact frame,
//! with no `videorc-preview-screen` thread left alive and the whole WinRT
//! stack in the unloaded-module list.
//!
//! Two independent anchors, installed once before any thread touches COM:
//!
//! 1. `CoIncrementMTAUsage` keeps the MTA alive for the whole process, so no
//!    worker's `RoUninitialize`/`CoUninitialize` can ever be the last one and
//!    trigger apartment teardown (this also protects the Media Foundation,
//!    DirectShow, and WASAPI servers the encoder/audio workers load).
//! 2. `GraphicsCapture.dll` is loaded from System32 and pinned
//!    (`GET_MODULE_HANDLE_EX_FLAG_PIN`), so even an explicit
//!    `CoFreeUnusedLibraries` sweep can never unmap it under a live
//!    capture-internal thread.
//!
//! Both are deliberately leaked: they must outlive every capture thread, and
//! the process exiting is the only correct release.

use std::sync::OnceLock;

use windows::Win32::Foundation::HMODULE;
use windows::Win32::System::Com::CoIncrementMTAUsage;
use windows::Win32::System::LibraryLoader::{
    GET_MODULE_HANDLE_EX_FLAG_PIN, GetModuleHandleExW, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW,
};
use windows::core::w;

/// Outcome of [`install`], kept for diagnostics and tests.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComLifetimeStatus {
    pub mta_held: Result<(), String>,
    pub graphics_capture_pinned: Result<(), String>,
}

static STATUS: OnceLock<ComLifetimeStatus> = OnceLock::new();

/// Install the process-lifetime anchors. Idempotent; call once at startup
/// before any capture, encoder, or audio thread is spawned. Failures are
/// logged, never fatal: the backend still runs (with the pre-fix risk).
pub fn install() -> &'static ComLifetimeStatus {
    STATUS.get_or_init(|| {
        let status = ComLifetimeStatus {
            mta_held: hold_mta_for_process_lifetime(),
            graphics_capture_pinned: pin_graphics_capture_module(),
        };
        match (&status.mta_held, &status.graphics_capture_pinned) {
            (Ok(()), Ok(())) => tracing::info!(
                "[com-lifetime] process MTA held and GraphicsCapture.dll pinned for process lifetime"
            ),
            (mta, pin) => tracing::warn!(
                mta = ?mta,
                graphics_capture_pin = ?pin,
                "[com-lifetime] could not fully anchor COM/WinRT lifetime; capture restarts may unload in-use system DLLs"
            ),
        }
        status
    })
}

fn hold_mta_for_process_lifetime() -> Result<(), String> {
    // SAFETY: no preconditions. The cookie is a plain handle with no Drop;
    // it is intentionally never passed to CoDecrementMTAUsage, so the MTA
    // lives until process exit.
    unsafe { CoIncrementMTAUsage() }
        .map(|_cookie| ())
        .map_err(|error| format!("CoIncrementMTAUsage failed: {error}"))
}

fn pin_graphics_capture_module() -> Result<(), String> {
    // SAFETY: loading a signed System32 DLL by name with the System32-only
    // search path; the handle is pinned below and never freed.
    let loaded = unsafe {
        LoadLibraryExW(
            w!("GraphicsCapture.dll"),
            None,
            LOAD_LIBRARY_SEARCH_SYSTEM32,
        )
    }
    .map_err(|error| format!("GraphicsCapture.dll could not be loaded: {error}"))?;
    let mut pinned = HMODULE::default();
    // SAFETY: the module is loaded (we hold a reference from LoadLibraryExW);
    // PIN makes the loader ignore every later FreeLibrary for this module.
    unsafe {
        GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_PIN,
            w!("GraphicsCapture.dll"),
            &mut pinned,
        )
    }
    .map_err(|error| format!("GraphicsCapture.dll could not be pinned: {error}"))?;
    debug_assert_eq!(loaded, pinned);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::FreeLibrary;
    use windows::Win32::System::Com::{
        APTTYPE, APTTYPE_MTA, APTTYPEQUALIFIER, APTTYPEQUALIFIER_IMPLICIT_MTA,
        COINIT_MULTITHREADED, CoGetApartmentType, CoInitializeEx, CoUninitialize,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;

    #[test]
    fn com_lifetime_install_is_idempotent_and_succeeds() {
        let first = install();
        let second = install();
        assert!(std::ptr::eq(first, second));
        assert_eq!(first.mta_held, Ok(()), "{first:?}");
        assert_eq!(first.graphics_capture_pinned, Ok(()), "{first:?}");
    }

    #[test]
    fn com_lifetime_mta_survives_the_last_worker_leaving_it() {
        install();
        // A worker joins and leaves the MTA exactly like a capture thread.
        std::thread::spawn(|| unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .expect("join MTA");
            CoUninitialize();
        })
        .join()
        .unwrap();
        // A thread that never initialized COM only sees an (implicit) MTA if
        // the process-wide MTA is still alive.
        let (apt, qualifier) = std::thread::spawn(|| {
            let mut apt = APTTYPE::default();
            let mut qualifier = APTTYPEQUALIFIER::default();
            unsafe { CoGetApartmentType(&mut apt, &mut qualifier) }.expect("apartment type");
            (apt, qualifier)
        })
        .join()
        .unwrap();
        assert_eq!(apt, APTTYPE_MTA);
        assert_eq!(qualifier, APTTYPEQUALIFIER_IMPLICIT_MTA);
    }

    #[test]
    fn com_lifetime_graphics_capture_cannot_be_unloaded() {
        install();
        let module =
            unsafe { GetModuleHandleW(w!("GraphicsCapture.dll")) }.expect("module is loaded");
        // Drop more references than we ever took; a pinned module stays mapped.
        for _ in 0..4 {
            let _ = unsafe { FreeLibrary(module) };
        }
        let still_loaded = unsafe { GetModuleHandleW(w!("GraphicsCapture.dll")) };
        assert_eq!(still_loaded.ok(), Some(module));
    }
}
