//! In-process minidump on native crashes (Windows).
//!
//! The backend runs as an Electron child, and Windows Error Reporting does not
//! reliably write LocalDumps for it (observed: access violations with no dump
//! even with a per-exe LocalDumps key). Native faults (`0xC0000005` in FFI or
//! system DLL threads) never reach the Rust panic hook, so without a dump the
//! supervisor's crash record only has an exit code.
//!
//! This installs a top-level unhandled-exception filter that writes one
//! minidump (stacks, thread info, loaded AND unloaded modules) to
//! `%APPDATA%\Videorc\backend-dumps\videorc-backend-<pid>.dmp`, then returns
//! `EXCEPTION_CONTINUE_SEARCH` so the process still terminates with the
//! original exception code and the supervisor's restart/crash-record path is
//! unchanged.

use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::OnceLock;

use windows::Win32::Foundation::{CloseHandle, GENERIC_WRITE};
use windows::Win32::Storage::FileSystem::{
    CREATE_ALWAYS, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_MODE,
};
use windows::Win32::System::Diagnostics::Debug::{
    EXCEPTION_POINTERS, LPTOP_LEVEL_EXCEPTION_FILTER, MINIDUMP_EXCEPTION_INFORMATION,
    MiniDumpWithIndirectlyReferencedMemory, MiniDumpWithThreadInfo, MiniDumpWithUnloadedModules,
    MiniDumpWriteDump, SetUnhandledExceptionFilter,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId,
};
use windows::core::PCWSTR;

const EXCEPTION_CONTINUE_SEARCH: i32 = 0;

/// NUL-terminated wide path, computed once at install so the filter itself
/// does no allocation or path work inside a crashed process.
static DUMP_PATH: OnceLock<Vec<u16>> = OnceLock::new();
static PREVIOUS_FILTER: OnceLock<LPTOP_LEVEL_EXCEPTION_FILTER> = OnceLock::new();

pub fn dump_directory() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .map(|appdata| PathBuf::from(appdata).join("Videorc").join("backend-dumps"))
}

/// Install once at startup. Best-effort: failures are logged and ignored.
pub fn install() {
    let Some(directory) = dump_directory() else {
        tracing::warn!("[crash-dump] APPDATA is unset; native crash dumps disabled");
        return;
    };
    if let Err(error) = std::fs::create_dir_all(&directory) {
        tracing::warn!(error = %error, "[crash-dump] could not create dump directory");
        return;
    }
    let path = directory.join(format!("videorc-backend-{}.dmp", std::process::id()));
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    if DUMP_PATH.set(wide).is_err() {
        return; // already installed
    }
    // SAFETY: installs a process-wide filter; the callback only reads statics
    // initialised above and calls async-signal-tolerant Win32 APIs.
    let previous = unsafe { SetUnhandledExceptionFilter(Some(write_dump_filter)) };
    let _ = PREVIOUS_FILTER.set(previous);
    tracing::info!(path = %path.display(), "[crash-dump] native crash dumps enabled");
}

unsafe extern "system" fn write_dump_filter(info: *const EXCEPTION_POINTERS) -> i32 {
    if let Some(path) = DUMP_PATH.get() {
        // SAFETY: path is a NUL-terminated wide string owned by a static.
        let file = unsafe {
            CreateFileW(
                PCWSTR(path.as_ptr()),
                GENERIC_WRITE.0,
                FILE_SHARE_MODE(0),
                None,
                CREATE_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        };
        if let Ok(file) = file {
            let exception = MINIDUMP_EXCEPTION_INFORMATION {
                ThreadId: unsafe { GetCurrentThreadId() },
                ExceptionPointers: info as *mut EXCEPTION_POINTERS,
                ClientPointers: false.into(),
            };
            let dump_type = MiniDumpWithUnloadedModules
                | MiniDumpWithThreadInfo
                | MiniDumpWithIndirectlyReferencedMemory;
            // SAFETY: valid process/file handles; exception info points at
            // the live exception record for this thread.
            let _ = unsafe {
                MiniDumpWriteDump(
                    GetCurrentProcess(),
                    GetCurrentProcessId(),
                    file,
                    dump_type,
                    Some(&exception),
                    None,
                    None,
                )
            };
            let _ = unsafe { CloseHandle(file) };
        }
    }
    match PREVIOUS_FILTER.get().copied().flatten() {
        // SAFETY: chaining to whatever filter was installed before ours.
        Some(previous) => unsafe { previous(info) },
        None => EXCEPTION_CONTINUE_SEARCH,
    }
}
