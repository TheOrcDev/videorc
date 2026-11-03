//! The one-time, elevated setup (plan 214 C2, D8) and what the backend reads
//! to tell whether it has been done.
//!
//! The media source DLL must be registered machine-wide (HKLM) and live
//! outside the user's profile, because the Frame Server loads it as Local
//! Service. The installer is per-user, so `videorc-camera-setup.exe` does
//! both once, elevated through one UAC prompt: it copies the DLL to
//! `%ProgramData%\Videorc\camera\<version>\` and writes the keys below.
//! `/remove` undoes both.
//!
//! Registry (all under `HKEY_LOCAL_MACHINE`, 64-bit view):
//!
//! - `SOFTWARE\Classes\CLSID\{B629EEBB-4B8E-4CAB-A549-EB17570B1382}`
//!   default: "Videorc Camera media source"
//! - `…\InProcServer32` default: the DLL path; `ThreadingModel`: `Both`
//! - `SOFTWARE\Videorc\Camera` `Version`: the DLL's [`CAMERA_DLL_VERSION`];
//!   `DllPath`: the same path
//!
//! The backend decides `ready` or `needs-setup` from this module's
//! [`setup_state`]: the version key must equal the bundled version and the
//! registered DLL must exist.

use std::path::{Path, PathBuf};

/// The DLL this build ships and the version it registers.
pub const CAMERA_DLL_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Cargo's name for the cdylib.
pub const DLL_FILE_NAME: &str = "videorc_virtual_camera_windows.dll";
pub const SETUP_EXE_FILE_NAME: &str = "videorc-camera-setup.exe";
/// What the CLSID key's default value says.
pub const CLSID_DESCRIPTION: &str = "Videorc Camera media source";
/// Under HKLM.
pub const CLSID_SUBKEY: &str = r"SOFTWARE\Classes\CLSID\{B629EEBB-4B8E-4CAB-A549-EB17570B1382}";
pub const INPROC_SERVER_SUBKEY: &str =
    r"SOFTWARE\Classes\CLSID\{B629EEBB-4B8E-4CAB-A549-EB17570B1382}\InProcServer32";
pub const THREADING_MODEL: &str = "Both";
pub const CAMERA_SUBKEY: &str = r"SOFTWARE\Videorc\Camera";
/// Deleted on `/remove` so an empty `SOFTWARE\Videorc` does not linger.
pub const VENDOR_SUBKEY: &str = r"SOFTWARE\Videorc";
pub const VERSION_VALUE: &str = "Version";
pub const DLL_PATH_VALUE: &str = "DllPath";
/// Under `%ProgramData%`: `Videorc\camera`.
pub const INSTALL_ROOT_COMPONENTS: [&str; 2] = ["Videorc", "camera"];

/// `%ProgramData%\Videorc\camera\<version>`.
pub fn install_dir(program_data: &Path, version: &str) -> PathBuf {
    let mut dir = program_data.to_path_buf();
    for component in INSTALL_ROOT_COMPONENTS {
        dir.push(component);
    }
    dir.push(version);
    dir
}

/// `%ProgramData%\Videorc\camera\<version>\videorc_virtual_camera_windows.dll`.
pub fn installed_dll_path(program_data: &Path, version: &str) -> PathBuf {
    install_dir(program_data, version).join(DLL_FILE_NAME)
}

/// What HKLM says about the camera, as the registry reader found it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RegisteredCamera {
    /// `SOFTWARE\Videorc\Camera\Version`.
    pub version: Option<String>,
    /// `…\InProcServer32`'s default value.
    pub inproc_server: Option<PathBuf>,
    /// Whether `inproc_server` names an existing file.
    pub dll_present: bool,
}

/// What the backend reports for the platform step (A4) on Windows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetupState {
    /// The registered DLL is this build's version and present.
    Ready { version: String },
    /// Setup has not run, ran for another version, or lost its file.
    NeedsSetup { reason: String },
}

impl SetupState {
    pub fn is_ready(&self) -> bool {
        matches!(self, Self::Ready { .. })
    }
}

/// Pure: the setup state for what the registry holds against the version
/// this build bundles.
pub fn setup_state(registered: &RegisteredCamera, bundled_version: &str) -> SetupState {
    match (&registered.version, &registered.inproc_server) {
        (None, _) | (_, None) => SetupState::NeedsSetup {
            reason: "Videorc Camera isn't set up on this PC yet.".to_string(),
        },
        (Some(version), Some(_)) if version != bundled_version => SetupState::NeedsSetup {
            reason: format!(
                "Videorc Camera was set up for version {version}; this Videorc brings {bundled_version}. Set it up again."
            ),
        },
        (Some(version), Some(path)) => {
            if registered.dll_present {
                SetupState::Ready {
                    version: version.clone(),
                }
            } else {
                SetupState::NeedsSetup {
                    reason: format!(
                        "Videorc Camera's file is missing from {}. Set it up again.",
                        path.display()
                    ),
                }
            }
        }
    }
}

/// `videorc-camera-setup.exe`'s command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetupCommand {
    /// Copy the DLL (the one next to the exe unless `/dll <path>` names
    /// another) and write HKLM. The default when no verb is given.
    Install {
        dll: Option<PathBuf>,
    },
    /// Remove the HKLM keys and the installed copies.
    Remove,
    Usage,
}

pub const USAGE: &str = "videorc-camera-setup.exe [/install] [/dll <path>] | /remove\n\
Copies Videorc Camera's media source to %ProgramData%\\Videorc\\camera\\<version>\\ and registers it in HKLM (needs elevation); /remove undoes both.";

/// Parse the arguments after the program name. Verbs take `/` or `--`.
pub fn parse_setup_args<S: AsRef<str>>(args: &[S]) -> SetupCommand {
    let mut dll = None;
    let mut verb: Option<&str> = None;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_ref();
        let flag = arg.trim_start_matches(['/', '-']).to_ascii_lowercase();
        match flag.as_str() {
            "install" | "remove" => {
                if verb.is_some() {
                    return SetupCommand::Usage;
                }
                verb = Some(if flag == "install" {
                    "install"
                } else {
                    "remove"
                });
            }
            "dll" => {
                let Some(path) = args.get(index + 1) else {
                    return SetupCommand::Usage;
                };
                dll = Some(PathBuf::from(path.as_ref()));
                index += 1;
            }
            _ => return SetupCommand::Usage,
        }
        index += 1;
    }
    match verb {
        Some("remove") => {
            if dll.is_some() {
                SetupCommand::Usage
            } else {
                SetupCommand::Remove
            }
        }
        _ => SetupCommand::Install { dll },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registered(version: &str, present: bool) -> RegisteredCamera {
        RegisteredCamera {
            version: Some(version.to_string()),
            inproc_server: Some(PathBuf::from(
                r"C:\ProgramData\Videorc\camera\0.1.0\videorc_virtual_camera_windows.dll",
            )),
            dll_present: present,
        }
    }

    #[test]
    fn the_install_dir_is_versioned_under_program_data() {
        let dll = installed_dll_path(Path::new(r"C:\ProgramData"), "0.1.0");
        assert_eq!(
            dll,
            PathBuf::from(r"C:\ProgramData")
                .join("Videorc")
                .join("camera")
                .join("0.1.0")
                .join(DLL_FILE_NAME)
        );
    }

    #[test]
    fn nothing_registered_needs_setup() {
        let state = setup_state(&RegisteredCamera::default(), CAMERA_DLL_VERSION);
        assert_eq!(
            state,
            SetupState::NeedsSetup {
                reason: "Videorc Camera isn't set up on this PC yet.".to_string()
            }
        );
        let half = RegisteredCamera {
            version: Some(CAMERA_DLL_VERSION.to_string()),
            ..RegisteredCamera::default()
        };
        assert!(!setup_state(&half, CAMERA_DLL_VERSION).is_ready());
    }

    #[test]
    fn another_version_or_a_missing_file_needs_setup_again() {
        let older = setup_state(&registered("0.0.9", true), "0.1.0");
        assert_eq!(
            older,
            SetupState::NeedsSetup {
                reason: "Videorc Camera was set up for version 0.0.9; this Videorc brings 0.1.0. Set it up again.".to_string()
            }
        );
        let missing = setup_state(&registered("0.1.0", false), "0.1.0");
        assert!(
            matches!(missing, SetupState::NeedsSetup { reason } if reason.contains("file is missing"))
        );
    }

    #[test]
    fn the_bundled_version_present_is_ready() {
        assert_eq!(
            setup_state(&registered("0.1.0", true), "0.1.0"),
            SetupState::Ready {
                version: "0.1.0".to_string()
            }
        );
    }

    #[test]
    fn the_setup_command_line_parses_install_remove_and_the_dll_override() {
        let none: [&str; 0] = [];
        assert_eq!(parse_setup_args(&none), SetupCommand::Install { dll: None });
        assert_eq!(
            parse_setup_args(&["/install"]),
            SetupCommand::Install { dll: None }
        );
        assert_eq!(
            parse_setup_args(&["--install", "--dll", r"C:\x\y.dll"]),
            SetupCommand::Install {
                dll: Some(PathBuf::from(r"C:\x\y.dll"))
            }
        );
        assert_eq!(
            parse_setup_args(&["/dll", r"C:\x\y.dll"]),
            SetupCommand::Install {
                dll: Some(PathBuf::from(r"C:\x\y.dll"))
            }
        );
        assert_eq!(parse_setup_args(&["/remove"]), SetupCommand::Remove);
        assert_eq!(parse_setup_args(&["/REMOVE"]), SetupCommand::Remove);
        assert_eq!(
            parse_setup_args(&["/remove", "/dll", "x"]),
            SetupCommand::Usage
        );
        assert_eq!(
            parse_setup_args(&["/install", "/remove"]),
            SetupCommand::Usage
        );
        assert_eq!(parse_setup_args(&["/dll"]), SetupCommand::Usage);
        assert_eq!(parse_setup_args(&["/frobnicate"]), SetupCommand::Usage);
    }
}
