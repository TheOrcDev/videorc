//! The four exports a COM in-process server offers (plan 214 C1):
//! `DllGetClassObject`, `DllCanUnloadNow`, `DllRegisterServer` and
//! `DllUnregisterServer`. The Frame Server (and `regsvr32`) call these; no
//! `DllMain` is needed, the module path comes from the export's own address.

use std::ffi::{OsString, c_void};
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;
use std::ptr::null_mut;
use std::sync::atomic::Ordering;

use windows::Win32::Foundation::{CLASS_E_CLASSNOTAVAILABLE, E_POINTER, HMODULE, S_FALSE, S_OK};
use windows::Win32::System::Com::IClassFactory;
use windows::Win32::System::LibraryLoader::{
    GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
    GetModuleFileNameW, GetModuleHandleExW,
};
use windows::Win32::System::Ole::SELFREG_E_CLASS;
use windows::core::{GUID, HRESULT, Interface, PCWSTR};

use crate::SOURCE_CLSID_U128;
use crate::setup::CAMERA_DLL_VERSION;

use super::media_source::{LIVE_OBJECTS, VideorcCameraClassFactory};
use super::registration;

/// The media source CLSID as a GUID.
pub const SOURCE_CLSID_GUID: GUID = GUID::from_u128(SOURCE_CLSID_U128);

/// COM asks for the class factory of our one CLSID.
///
/// # Safety
///
/// Called by COM with valid pointers; every pointer is checked for null
/// before it is used.
#[unsafe(no_mangle)]
pub unsafe extern "system" fn DllGetClassObject(
    rclsid: *const GUID,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    if rclsid.is_null() || riid.is_null() || ppv.is_null() {
        return E_POINTER;
    }
    // SAFETY: checked non-null; COM owns the pointees.
    unsafe {
        *ppv = null_mut();
        if *rclsid != SOURCE_CLSID_GUID {
            return CLASS_E_CLASSNOTAVAILABLE;
        }
        let factory: IClassFactory = VideorcCameraClassFactory::new().into();
        factory.query(riid, ppv)
    }
}

/// `S_OK` once no object of this module lives.
///
/// # Safety
///
/// No arguments; always safe to call.
#[unsafe(no_mangle)]
pub unsafe extern "system" fn DllCanUnloadNow() -> HRESULT {
    if LIVE_OBJECTS.load(Ordering::Acquire) == 0 {
        S_OK
    } else {
        S_FALSE
    }
}

/// `regsvr32`: register this very file under HKLM at this build's version.
/// The setup exe does the same for the copy it installs.
///
/// # Safety
///
/// No arguments; always safe to call.
#[unsafe(no_mangle)]
pub unsafe extern "system" fn DllRegisterServer() -> HRESULT {
    match module_path().and_then(|path| {
        registration::register(&path, CAMERA_DLL_VERSION).map_err(|error| error.to_string())
    }) {
        Ok(()) => S_OK,
        Err(_) => SELFREG_E_CLASS,
    }
}

/// `regsvr32 /u`: remove the HKLM keys.
///
/// # Safety
///
/// No arguments; always safe to call.
#[unsafe(no_mangle)]
pub unsafe extern "system" fn DllUnregisterServer() -> HRESULT {
    match registration::unregister() {
        Ok(()) => S_OK,
        Err(_) => SELFREG_E_CLASS,
    }
}

/// This DLL's path, found from one of its own exports.
pub fn module_path() -> Result<PathBuf, String> {
    let mut module = HMODULE::default();
    let anchor = DllGetClassObject as *const () as *const u16;
    // SAFETY: FROM_ADDRESS takes any address inside the module; the refcount
    // is left alone.
    unsafe {
        GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            PCWSTR(anchor),
            &mut module,
        )
    }
    .map_err(|error| format!("GetModuleHandleExW failed: {error}"))?;
    let mut buffer = vec![0u16; 32_768];
    // SAFETY: the buffer is as long as we say.
    let len = unsafe { GetModuleFileNameW(Some(module), &mut buffer) } as usize;
    if len == 0 || len >= buffer.len() {
        return Err("GetModuleFileNameW returned no path".to_string());
    }
    Ok(PathBuf::from(OsString::from_wide(&buffer[..len])))
}
