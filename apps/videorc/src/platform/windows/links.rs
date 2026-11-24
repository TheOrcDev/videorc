//! `videorc://` from the per-user registry, what Electron's
//! `app.setAsDefaultProtocolClient('videorc')` writes on Windows:
//! `HKCU\Software\Classes\videorc` named `URL:videorc` with an empty
//! `URL Protocol`, and `shell\open\command` = `"<exe>" "%1"`. A link then
//! starts the app with the link as its argument (`args::parse` keeps it), and
//! the core's single instance hands it to the running app.
//!
//! Electron takes the handler on every launch. Here a development build
//! leaves a handler that names another program alone (the installed Electron
//! app's sign-ins would land in a `cargo run` binary otherwise), unless
//! `VIDEORC_REGISTER_LINKS=1` says to take it. A release build takes it, as
//! Electron does.

use std::ffi::c_void;
use std::path::Path;

use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::System::Registry::{
    HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ, RegGetValueW, RegSetKeyValueW,
};

use super::wide;
use crate::platform::{LinkHandler, OsResult};

/// The app's name where Windows shows its id (a toast's header).
const DISPLAY_NAME: &str = "Videorc";

/// Lets a development build take a handler another program holds.
const TAKE_ENV: &str = "VIDEORC_REGISTER_LINKS";

/// The command a link runs, Electron's `GetAppCommand` for a packaged app.
pub(super) fn open_command(exe: &Path) -> String {
    format!("\"{}\" \"%1\"", exe.display())
}

/// What to do with the handler the registry holds.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Decision {
    Write,
    Keep,
    Leave,
}

pub(super) fn decide(current: Option<&str>, ours: &str, debug_build: bool, take: bool) -> Decision {
    match current {
        Some(current) if current.eq_ignore_ascii_case(ours) => Decision::Keep,
        Some(_) if debug_build && !take => Decision::Leave,
        _ => Decision::Write,
    }
}

/// A string value under `HKCU\<subkey>`; `None` reads the key's default.
fn read(subkey: &str, value: Option<&str>) -> Option<String> {
    let subkey = wide(subkey);
    let value = value.map(wide);
    let value_ptr = value
        .as_ref()
        .map_or(std::ptr::null(), |value| value.as_ptr());
    let mut bytes = 0u32;
    // SAFETY: NUL-terminated strings that live for the call; a null buffer
    // asks for the size.
    let sized = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value_ptr,
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut bytes,
        )
    };
    if sized != ERROR_SUCCESS || bytes < 2 {
        return None;
    }
    let mut buffer = vec![0u16; (bytes as usize).div_ceil(2)];
    // SAFETY: as above, into a buffer of `bytes` bytes.
    let read = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value_ptr,
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast::<c_void>(),
            &mut bytes,
        )
    };
    if read != ERROR_SUCCESS {
        return None;
    }
    let end = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..end]))
}

/// Writes a string value under `HKCU\<subkey>`, creating the key.
fn write(subkey: &str, value: Option<&str>, data: &str) -> OsResult<()> {
    let subkey_wide = wide(subkey);
    let value_wide = value.map(wide);
    let value_ptr = value_wide
        .as_ref()
        .map_or(std::ptr::null(), |value| value.as_ptr());
    let data_wide = wide(data);
    // SAFETY: NUL-terminated strings that live for the call; the length
    // counts the terminator, as REG_SZ wants.
    let written = unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            subkey_wide.as_ptr(),
            value_ptr,
            REG_SZ,
            data_wide.as_ptr().cast::<c_void>(),
            (data_wide.len() * 2) as u32,
        )
    };
    if written != ERROR_SUCCESS {
        return Err(format!(
            "writing HKCU\\{subkey} {} failed (error {written})",
            value.unwrap_or("(default)")
        ));
    }
    Ok(())
}

pub(super) fn register(scheme: &str) -> OsResult<LinkHandler> {
    let exe = std::env::current_exe().map_err(|error| format!("no executable path: {error}"))?;
    let class = format!("Software\\Classes\\{scheme}");
    let command_key = format!("{class}\\shell\\open\\command");
    let ours = open_command(&exe);
    let current = read(&command_key, None);
    let take = std::env::var(TAKE_ENV).is_ok_and(|value| value == "1");
    match decide(current.as_deref(), &ours, cfg!(debug_assertions), take) {
        Decision::Keep => Ok(LinkHandler::AlreadyRegistered),
        Decision::Leave => Ok(LinkHandler::LeftFor(current.unwrap_or_default())),
        Decision::Write => {
            write(&class, None, &format!("URL:{scheme}"))?;
            write(&class, Some("URL Protocol"), "")?;
            write(&command_key, None, &ours)?;
            Ok(LinkHandler::Registered)
        }
    }
}

/// Names the app id for toasts when no Start menu shortcut carries it (a
/// run before the installer): `HKCU\Software\Classes\AppUserModelId\<id>`
/// with a `DisplayName`. A name already there is kept.
pub(super) fn name_app_id(app_id: &str) -> OsResult<()> {
    let key = format!("Software\\Classes\\AppUserModelId\\{app_id}");
    if read(&key, Some("DisplayName")).is_some() {
        return Ok(());
    }
    write(&key, Some("DisplayName"), DISPLAY_NAME)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{Decision, decide, open_command};

    const OURS: &str = r#""C:\Program Files\Videorc\Videorc.exe" "%1""#;

    #[test]
    fn a_link_runs_the_exe_with_the_link_as_its_one_argument() {
        assert_eq!(
            open_command(Path::new(r"C:\Program Files\Videorc\Videorc.exe")),
            OURS
        );
    }

    #[test]
    fn a_missing_handler_is_written_by_every_build() {
        for debug in [true, false] {
            assert_eq!(decide(None, OURS, debug, false), Decision::Write);
        }
    }

    #[test]
    fn our_own_handler_is_kept_whatever_the_case() {
        let shouted = OURS.to_ascii_uppercase();
        assert_eq!(decide(Some(&shouted), OURS, true, false), Decision::Keep);
        assert_eq!(decide(Some(OURS), OURS, false, false), Decision::Keep);
    }

    #[test]
    fn a_dev_build_leaves_another_programs_handler_unless_told() {
        let electron = r#""C:\Users\me\AppData\Local\Programs\Videorc\Videorc.exe" "%1""#;
        assert_eq!(decide(Some(electron), OURS, true, false), Decision::Leave);
        assert_eq!(decide(Some(electron), OURS, true, true), Decision::Write);
        assert_eq!(decide(Some(electron), OURS, false, false), Decision::Write);
    }
}
