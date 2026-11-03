//! HKLM registration of the media source (plan 214 C1, C2): what
//! `DllRegisterServer`, `videorc-camera-setup.exe` and the backend's setup
//! detection share. The keys are listed in [`crate::setup`].

use std::ffi::OsString;
use std::fmt;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

use windows::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, WIN32_ERROR};
use windows::Win32::System::Registry::{
    HKEY, HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ,
    RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY, RegCloseKey, RegCreateKeyExW, RegDeleteTreeW,
    RegGetValueW, RegSetValueExW,
};
use windows::core::{HSTRING, PCWSTR};

use crate::setup::{
    CAMERA_SUBKEY, CLSID_DESCRIPTION, CLSID_SUBKEY, DLL_PATH_VALUE, INPROC_SERVER_SUBKEY,
    RegisteredCamera, THREADING_MODEL, VENDOR_SUBKEY, VERSION_VALUE,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistrationError {
    pub step: String,
    pub code: u32,
}

impl fmt::Display for RegistrationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.code == ERROR_ACCESS_DENIED.0 {
            write!(
                f,
                "{}: access denied. Registering Videorc Camera needs administrator rights; use the Set up button in Videorc, which asks once.",
                self.step
            )
        } else {
            write!(f, "{} failed with Win32 error {}", self.step, self.code)
        }
    }
}

impl std::error::Error for RegistrationError {}

fn check(step: &str, error: WIN32_ERROR) -> Result<(), RegistrationError> {
    if error.is_ok() {
        Ok(())
    } else {
        Err(RegistrationError {
            step: step.to_string(),
            code: error.0,
        })
    }
}

/// An open key, closed on drop.
struct Key(HKEY);

impl Key {
    fn create(subkey: &str) -> Result<Self, RegistrationError> {
        let mut key = HKEY::default();
        // SAFETY: the subkey is a NUL-terminated string; `key` receives a
        // handle we close in Drop.
        let error = unsafe {
            RegCreateKeyExW(
                HKEY_LOCAL_MACHINE,
                &HSTRING::from(subkey),
                None,
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE | KEY_WOW64_64KEY,
                None,
                &mut key,
                None,
            )
        };
        check(&format!("RegCreateKeyExW HKLM\\{subkey}"), error)?;
        Ok(Self(key))
    }

    fn set_string(&self, name: Option<&str>, value: &str) -> Result<(), RegistrationError> {
        let wide: Vec<u16> = OsString::from(value).encode_wide().chain(Some(0)).collect();
        // SAFETY: `wide` is a NUL-terminated UTF-16 buffer; the byte view
        // covers exactly its storage.
        let bytes =
            unsafe { std::slice::from_raw_parts(wide.as_ptr().cast::<u8>(), wide.len() * 2) };
        let name_wide = name.map(HSTRING::from);
        let error = match &name_wide {
            // SAFETY: the key is open for writing; the name is NUL-terminated.
            Some(name) => unsafe { RegSetValueExW(self.0, name, None, REG_SZ, Some(bytes)) },
            // SAFETY: as above; a null name sets the default value.
            None => unsafe { RegSetValueExW(self.0, PCWSTR::null(), None, REG_SZ, Some(bytes)) },
        };
        check(
            &format!("RegSetValueExW {}", name.unwrap_or("(default)")),
            error,
        )
    }
}

impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: the key was opened by `create` and is closed once.
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}

/// Write the CLSID and the camera keys for `dll_path` at `version`.
pub fn register(dll_path: &Path, version: &str) -> Result<(), RegistrationError> {
    let dll = dll_path.to_string_lossy();
    let clsid = Key::create(CLSID_SUBKEY)?;
    clsid.set_string(None, CLSID_DESCRIPTION)?;
    let inproc = Key::create(INPROC_SERVER_SUBKEY)?;
    inproc.set_string(None, &dll)?;
    inproc.set_string(Some("ThreadingModel"), THREADING_MODEL)?;
    let camera = Key::create(CAMERA_SUBKEY)?;
    camera.set_string(Some(VERSION_VALUE), version)?;
    camera.set_string(Some(DLL_PATH_VALUE), &dll)?;
    Ok(())
}

fn delete_tree(subkey: &str) -> Result<(), RegistrationError> {
    // SAFETY: the subkey is NUL-terminated; this x64 process sees the
    // 64-bit view the keys were written in.
    let error = unsafe { RegDeleteTreeW(HKEY_LOCAL_MACHINE, &HSTRING::from(subkey)) };
    if error == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    check(&format!("RegDeleteTreeW HKLM\\{subkey}"), error)
}

/// Remove every key `register` wrote. Missing keys are fine.
pub fn unregister() -> Result<(), RegistrationError> {
    delete_tree(CLSID_SUBKEY)?;
    delete_tree(CAMERA_SUBKEY)?;
    // `SOFTWARE\Videorc` goes only when nothing else lives under it: a tree
    // delete would take unrelated keys, so delete it as a plain key and
    // ignore a refusal.
    // SAFETY: as in `delete_tree`.
    let _ = unsafe { RegDeleteTreeW(HKEY_LOCAL_MACHINE, &HSTRING::from(VENDOR_SUBKEY)) };
    Ok(())
}

fn read_string(subkey: &str, value: Option<&str>) -> Option<String> {
    let subkey = HSTRING::from(subkey);
    let value_name = value.map(HSTRING::from);
    let value_ptr = value_name
        .as_ref()
        .map_or(PCWSTR::null(), |name| PCWSTR(name.as_ptr()));
    let mut len: u32 = 0;
    // SAFETY: strings are NUL-terminated; a null data pointer asks for the
    // length only.
    let sized = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            &subkey,
            value_ptr,
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
            None,
            None,
            Some(&mut len),
        )
    };
    if sized.is_err() || len < 2 {
        return None;
    }
    let mut buffer = vec![0u16; len as usize / 2 + 1];
    let mut byte_len = (buffer.len() * 2) as u32;
    // SAFETY: the buffer holds `byte_len` bytes.
    let read = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            &subkey,
            value_ptr,
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut byte_len),
        )
    };
    if read.is_err() {
        return None;
    }
    let units = (byte_len as usize / 2).min(buffer.len());
    let end = buffer[..units]
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(units);
    Some(
        OsString::from_wide(&buffer[..end])
            .to_string_lossy()
            .into_owned(),
    )
}

/// What HKLM holds right now.
pub fn registered() -> RegisteredCamera {
    let version = read_string(CAMERA_SUBKEY, Some(VERSION_VALUE));
    let inproc_server = read_string(INPROC_SERVER_SUBKEY, None).map(PathBuf::from);
    let dll_present = inproc_server.as_ref().is_some_and(|path| path.is_file());
    RegisteredCamera {
        version,
        inproc_server,
        dll_present,
    }
}
