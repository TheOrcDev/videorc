//! The exports WerFault.exe calls, and the backend-side registration.

use std::ffi::{OsString, c_void};
use std::mem::{MaybeUninit, offset_of, size_of};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use windows::Win32::Foundation::{CloseHandle, E_NOTIMPL, ERROR_SUCCESS, GENERIC_WRITE, S_OK};
use windows::Win32::Storage::FileSystem::{
    CREATE_ALWAYS, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_MODE,
};
use windows::Win32::System::Diagnostics::Debug::{
    EXCEPTION_POINTERS, GetErrorMode, MINIDUMP_EXCEPTION_INFORMATION,
    MiniDumpWithIndirectlyReferencedMemory, MiniDumpWithThreadInfo, MiniDumpWithUnloadedModules,
    MiniDumpWriteDump, ReadProcessMemory, SEM_NOGPFAULTERRORBOX, SetErrorMode, THREAD_ERROR_MODE,
};
use windows::Win32::System::ErrorReporting::{
    WER_FAULT_REPORTING, WER_FAULT_REPORTING_NO_UI, WER_RUNTIME_EXCEPTION_INFORMATION,
    WerRegisterRuntimeExceptionModule, WerSetFlags,
};
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_DWORD, REG_OPTION_NON_VOLATILE, RegCloseKey,
    RegCreateKeyExW, RegDeleteKeyValueW, RegSetValueExW,
};
use windows::Win32::System::Threading::{GetProcessId, GetThreadId};
use windows::core::{BOOL, HRESULT, PCWSTR, PWSTR, w};

use crate::{WerRegistration, helper_dump_file_name, in_process_dump_file_name};

const HELPER_MODULES_KEY: PCWSTR =
    w!("Software\\Microsoft\\Windows\\Windows Error Reporting\\RuntimeExceptionHelperModules");

/// Kept for the process lifetime: WER reads the context out of this process
/// at crash time, so its address must never change.
static REGISTRATION: OnceLock<WerRegistration> = OnceLock::new();
static REGISTERED_DLL: OnceLock<Vec<u16>> = OnceLock::new();

/// Lists `helper_dll` for WER under HKCU, registers it for this process with
/// `dump_directory` as where its dumps go, and lets WER report this process
/// (see [`let_wer_report_this_process`]). Returns the error mode the process
/// inherited. Once per process; a later call changes nothing.
pub fn register(helper_dll: &Path, dump_directory: &Path) -> Result<u32, String> {
    if !helper_dll.is_file() {
        return Err(format!("{} is missing", helper_dll.display()));
    }
    let directory: Vec<u16> = dump_directory.as_os_str().encode_wide().collect();
    let registration = WerRegistration::new(&directory).ok_or_else(|| {
        format!(
            "the dump directory {} cannot be handed to WER",
            dump_directory.display()
        )
    })?;
    if REGISTRATION.set(registration).is_err() {
        // SAFETY: plain process-wide flag read.
        return Ok(unsafe { GetErrorMode() });
    }
    let dll: Vec<u16> = helper_dll
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let dll = REGISTERED_DLL.get_or_init(|| dll);
    allow_list(dll)?;
    let context = REGISTRATION.get().map_or(std::ptr::null(), |registration| {
        std::ptr::from_ref(registration).cast::<c_void>()
    });
    // SAFETY: `dll` is NUL-terminated and `context` points at a static that
    // lives as long as the process.
    unsafe { WerRegisterRuntimeExceptionModule(PCWSTR(dll.as_ptr()), context) }
        .map_err(|error| format!("WerRegisterRuntimeExceptionModule failed: {error}"))?;
    let inherited_mode = let_wer_report_this_process();
    Ok(inherited_mode)
}

/// A registered module is only called when WER reports the crash at all,
/// and WER skips a process whose error mode carries SEM_NOGPFAULTERRORBOX.
/// That mode is inherited: a child of `cargo test` starts with 0x3 and its
/// heap-corruption crash left no report and no dump until the bit was
/// cleared (the packaged Electron app hands its backend 0x8001, which lacks
/// it, so this matters for dev and smoke launches). Only that bit is cleared (critical-error boxes
/// stay suppressed), and WER is told never to show UI for this process, so a
/// crash can not sit on a "stopped working" dialog while the supervisor waits
/// to restart it. Returns the inherited mode.
fn let_wer_report_this_process() -> u32 {
    // SAFETY: plain process-wide flag reads and writes.
    unsafe {
        let inherited = GetErrorMode();
        SetErrorMode(THREAD_ERROR_MODE(inherited & !SEM_NOGPFAULTERRORBOX.0));
        let _ = WerSetFlags(WER_FAULT_REPORTING(WER_FAULT_REPORTING_NO_UI));
        inherited
    }
}

/// Removes `helper_dll` from the HKCU list (tests clean up their own entry).
pub fn forget_helper_module(helper_dll: &Path) -> Result<(), String> {
    let dll: Vec<u16> = helper_dll
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: both strings are NUL-terminated.
    let status =
        unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, HELPER_MODULES_KEY, PCWSTR(dll.as_ptr())) };
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!("RegDeleteKeyValueW failed: {status:?}"))
    }
}

/// WER loads only modules named under `RuntimeExceptionHelperModules`; the
/// value name is the DLL's full path and its DWORD data is ignored.
fn allow_list(dll: &[u16]) -> Result<(), String> {
    let mut key = HKEY::default();
    // SAFETY: valid key, NUL-terminated subkey, out pointer to a local.
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            HELPER_MODULES_KEY,
            None,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut key,
            None,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "RegCreateKeyExW RuntimeExceptionHelperModules failed: {status:?}"
        ));
    }
    let value = 0_u32.to_le_bytes();
    // SAFETY: `key` is open for KEY_SET_VALUE; `dll` is NUL-terminated.
    let status =
        unsafe { RegSetValueExW(key, PCWSTR(dll.as_ptr()), None, REG_DWORD, Some(&value)) };
    // SAFETY: closes the key opened above.
    let _ = unsafe { RegCloseKey(key) };
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!(
            "RegSetValueExW RuntimeExceptionHelperModules failed: {status:?}"
        ))
    }
}

/// WER's first call for a crash. Writes the dump and never claims the crash,
/// so WER carries on with its own reporting. Always `S_OK`: a failed dump is
/// no reason to disturb that.
///
/// # Safety
/// Called by WerFault.exe with the pointers its contract describes.
#[unsafe(no_mangle)]
pub unsafe extern "system" fn OutOfProcessExceptionEventCallback(
    context: *const c_void,
    information: *const WER_RUNTIME_EXCEPTION_INFORMATION,
    ownership_claimed: *mut BOOL,
    _event_name: PWSTR,
    _event_name_size: *mut u32,
    _signature_count: *mut u32,
) -> HRESULT {
    if !ownership_claimed.is_null() {
        // SAFETY: WER passes a writable BOOL.
        unsafe { ownership_claimed.write(BOOL::from(false)) };
    }
    // A panic must not unwind into WerFault.
    let _ = std::panic::catch_unwind(|| {
        // SAFETY: WER's pointers, checked for null inside.
        let _ = unsafe { write_crash_dump(context, information) };
    });
    S_OK
}

/// Called only for a claimed crash, which this module never makes.
///
/// # Safety
/// Never dereferences its arguments.
#[unsafe(no_mangle)]
pub unsafe extern "system" fn OutOfProcessExceptionEventSignatureCallback(
    _context: *const c_void,
    _information: *const WER_RUNTIME_EXCEPTION_INFORMATION,
    _index: u32,
    _name: PWSTR,
    _name_size: *mut u32,
    _value: PWSTR,
    _value_size: *mut u32,
) -> HRESULT {
    E_NOTIMPL
}

/// Called only for a claimed crash, which this module never makes.
///
/// # Safety
/// Never dereferences its arguments.
#[unsafe(no_mangle)]
pub unsafe extern "system" fn OutOfProcessExceptionEventDebuggerLaunchCallback(
    _context: *const c_void,
    _information: *const WER_RUNTIME_EXCEPTION_INFORMATION,
    _is_custom_debugger: *mut BOOL,
    _debugger_launch: PWSTR,
    _debugger_launch_size: *mut u32,
    _is_debugger_autolaunch: *mut BOOL,
) -> HRESULT {
    E_NOTIMPL
}

/// # Safety
/// `information`, when non-null, is WER's record of a crash in the process
/// its `hProcess` names; `context` is an address in that process.
unsafe fn write_crash_dump(
    context: *const c_void,
    information: *const WER_RUNTIME_EXCEPTION_INFORMATION,
) -> Option<()> {
    // SAFETY: WER's pointer, null-checked by `as_ref`.
    let information = unsafe { information.as_ref()? };
    // `bIsFatal` is absent from the structure before build 19041.
    let fatal_end = offset_of!(WER_RUNTIME_EXCEPTION_INFORMATION, bIsFatal) + size_of::<BOOL>();
    if information.dwSize as usize >= fatal_end && !information.bIsFatal.as_bool() {
        return None;
    }
    if context.is_null() {
        return None;
    }
    let mut registration = MaybeUninit::<WerRegistration>::zeroed();
    // SAFETY: reads at most one registration into a local of that size.
    unsafe {
        ReadProcessMemory(
            information.hProcess,
            context,
            registration.as_mut_ptr().cast(),
            size_of::<WerRegistration>(),
            None,
        )
    }
    .ok()?;
    // SAFETY: zero-initialized plain data; every bit pattern is valid.
    let registration = unsafe { registration.assume_init() };
    let directory = PathBuf::from(OsString::from_wide(registration.dump_directory()?));
    // SAFETY: WER's process handle.
    let pid = unsafe { GetProcessId(information.hProcess) };
    if pid == 0 {
        return None;
    }
    if std::fs::metadata(directory.join(in_process_dump_file_name(pid)))
        .is_ok_and(|metadata| metadata.len() > 0)
    {
        return None;
    }
    let path: Vec<u16> = directory
        .join(helper_dump_file_name(pid))
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: NUL-terminated path.
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
    }
    .ok()?;
    // dbghelp only reads the record and context, here in WerFault's memory.
    let pointers = EXCEPTION_POINTERS {
        ExceptionRecord: std::ptr::from_ref(&information.exceptionRecord).cast_mut(),
        ContextRecord: std::ptr::from_ref(&information.context).cast_mut(),
    };
    let exception = MINIDUMP_EXCEPTION_INFORMATION {
        // SAFETY: WER's thread handle.
        ThreadId: unsafe { GetThreadId(information.hThread) },
        ExceptionPointers: std::ptr::from_ref(&pointers).cast_mut(),
        ClientPointers: BOOL::from(false),
    };
    // Same contents as the in-process dump, so both read alike in WinDbg.
    let dump_type = MiniDumpWithUnloadedModules
        | MiniDumpWithThreadInfo
        | MiniDumpWithIndirectlyReferencedMemory;
    // SAFETY: WER's process handle, our file handle, locals for the rest.
    let written = unsafe {
        MiniDumpWriteDump(
            information.hProcess,
            pid,
            file,
            dump_type,
            Some(&exception),
            None,
            None,
        )
    };
    // SAFETY: closes the file opened above.
    let _ = unsafe { CloseHandle(file) };
    written.ok()
}
