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
//!
//! The filter never runs for fail-fast terminations (heap corruption,
//! 0xC0000374), so `install` also registers `videorc_wer_helper.dll` with
//! WER, which dumps those from WerFault.exe. That registration clears an
//! inherited SEM_NOGPFAULTERRORBOX error-mode bit, with which WER skips the
//! process entirely: a backend started by cargo or Node inherits it (0x3,
//! 0x8003); the packaged Electron app hands over 0x8001, which lacks it.

use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicPtr, AtomicU32, Ordering};

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
    CreateThread, GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId,
    THREAD_CREATION_FLAGS, WaitForSingleObject,
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
    register_wer_helper(&directory);
}

/// Fail-fast terminations (heap corruption, 0xC0000374) never run the filter
/// above: the 2026-11-01 field bundle had five such exits and no dump file.
/// WER still sees them, so the helper DLL beside this exe is registered to
/// write `videorc-backend-<pid>-wer.dmp` into the same directory from
/// WerFault.exe. A dev run without the DLL built only loses that coverage.
fn register_wer_helper(directory: &std::path::Path) {
    let helper = match std::env::current_exe() {
        Ok(exe) => exe.with_file_name(videorc_wer_helper::HELPER_DLL_NAME),
        Err(error) => {
            tracing::warn!(error = %error, "[crash-dump] cannot locate the WER helper");
            return;
        }
    };
    match videorc_wer_helper::register(&helper, directory) {
        Ok(inherited_error_mode) => tracing::info!(
            helper = %helper.display(),
            inherited_error_mode = format_args!("{inherited_error_mode:#x}"),
            "[crash-dump] WER helper registered for fail-fast crashes"
        ),
        Err(reason) => tracing::warn!(
            "[crash-dump] fail-fast crashes (heap corruption) will leave no dump: {reason}"
        ),
    }
}

/// Longest the crashing thread waits for the dump. A crash can happen while
/// the loader or heap lock is held, and `MiniDumpWriteDump` (or even starting
/// the writer thread) then deadlocks: an earlier in-filter version turned a
/// crash into a permanent hang with a 0-byte dump (2026-10-23 18:52), so the
/// supervisor never restarted the backend. The dump is now written on its own
/// thread and abandoned after this bound, so the process always terminates.
const DUMP_WRITE_TIMEOUT_MS: u32 = 20_000;

static CRASH_EXCEPTION: AtomicPtr<EXCEPTION_POINTERS> = AtomicPtr::new(std::ptr::null_mut());
static CRASH_THREAD_ID: AtomicU32 = AtomicU32::new(0);

unsafe extern "system" fn write_dump_filter(info: *const EXCEPTION_POINTERS) -> i32 {
    CRASH_EXCEPTION.store(info as *mut EXCEPTION_POINTERS, Ordering::SeqCst);
    CRASH_THREAD_ID.store(unsafe { GetCurrentThreadId() }, Ordering::SeqCst);
    // SAFETY: the writer only reads the statics above and the dump path; the
    // crashing thread (and its exception record) stays parked in this filter
    // until the wait below returns.
    if let Ok(writer) = unsafe {
        CreateThread(
            None,
            0,
            Some(dump_writer_thread),
            None,
            THREAD_CREATION_FLAGS(0),
            None,
        )
    } {
        let _ = unsafe { WaitForSingleObject(writer, DUMP_WRITE_TIMEOUT_MS) };
        let _ = unsafe { CloseHandle(writer) };
    }
    match PREVIOUS_FILTER.get().copied().flatten() {
        // SAFETY: chaining to whatever filter was installed before ours.
        Some(previous) => unsafe { previous(info) },
        None => EXCEPTION_CONTINUE_SEARCH,
    }
}

unsafe extern "system" fn dump_writer_thread(_: *mut core::ffi::c_void) -> u32 {
    let Some(path) = DUMP_PATH.get() else {
        return 1;
    };
    // SAFETY: path is a NUL-terminated wide string owned by a static.
    let Ok(file) = (unsafe {
        CreateFileW(
            PCWSTR(path.as_ptr()),
            GENERIC_WRITE.0,
            FILE_SHARE_MODE(0),
            None,
            CREATE_ALWAYS,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    }) else {
        return 1;
    };
    let exception = MINIDUMP_EXCEPTION_INFORMATION {
        ThreadId: CRASH_THREAD_ID.load(Ordering::SeqCst),
        ExceptionPointers: CRASH_EXCEPTION.load(Ordering::SeqCst),
        ClientPointers: false.into(),
    };
    let dump_type = MiniDumpWithUnloadedModules
        | MiniDumpWithThreadInfo
        | MiniDumpWithIndirectlyReferencedMemory;
    // SAFETY: valid process/file handles; the exception pointers belong to
    // the crashing thread, which is blocked waiting for this thread.
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
    0
}
