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
//! Videorc starts the exe unelevated with one fixed verb; the exe asks for
//! elevation itself (`ShellExecuteExW` with `runas` on its own path and
//! fixed arguments) and waits for its elevated copy. An elevated process
//! inherits no handles from an unelevated parent, so the outcome travels
//! back as the exit code ([`SetupExit`]) and the unelevated copy prints the
//! line Videorc shows.
//!
//! `%ProgramData%` lets any user create folders, and the Frame Server runs
//! what this folder holds as Local Service, so the elevated step refuses a
//! link or a folder someone else owns on the way down, gives each folder
//! [`INSTALL_DIR_SDDL`] (protected, Administrators own it, everyone only
//! reads), copies into it, and checks the copy's publisher there before it
//! takes the place of the registered DLL.
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

/// `%ProgramData%\Videorc`, `…\camera` and `…\<version>`: Administrators
/// own them; SYSTEM and Administrators have full control; everyone reads and
/// executes (the Frame Server loads the DLL as Local Service). Protected, so
/// nothing is inherited from `%ProgramData%`, whose ACL lets any user create
/// folders. Never a NULL DACL.
pub const INSTALL_DIR_SDDL: &str = "O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;WD)";
/// The installed DLL itself: the same principals, no inheritance flags.
pub const INSTALL_FILE_SDDL: &str = "O:BAD:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;WD)";

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

/// Whether `dll` is this version's installed copy (Windows compares paths
/// without case). `DllRegisterServer` registers nothing else: a DLL the
/// Frame Server loads as Local Service must not sit in a folder the user
/// can write, such as the per-user install's `resources`.
pub fn is_installed_dll_path(dll: &Path, program_data: &Path, version: &str) -> bool {
    fn normalized(path: &Path) -> String {
        path.to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    }
    normalized(dll) == normalized(&installed_dll_path(program_data, version))
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

/// What `videorc-camera-setup.exe` was asked to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupVerb {
    /// Copy the DLL beside the exe and write HKLM. The default.
    Install,
    /// Remove the HKLM keys and the installed copies.
    Remove,
}

/// A parsed command line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SetupRequest {
    pub verb: SetupVerb,
    /// Set by the exe on the copy it starts elevated, so a copy that still
    /// is not elevated fails instead of asking again.
    pub relaunched: bool,
}

/// The marker the unelevated copy passes to its elevated copy.
pub const RELAUNCHED_FLAG: &str = "/elevated";

pub const USAGE: &str = "videorc-camera-setup.exe [/install] | /remove\n\
Copies the Videorc Camera media source beside this exe to %ProgramData%\\Videorc\\camera\\<version>\\ and registers it in HKLM, asking Windows for elevation once; /remove undoes both.";

/// Parse the arguments after the program name. Verbs take `/` or `--`; no
/// verb means install. Nothing else is accepted: the elevated copy only
/// ever installs the DLL that sits beside it.
pub fn parse_setup_args<S: AsRef<str>>(args: &[S]) -> Option<SetupRequest> {
    let mut verb = None;
    let mut relaunched = false;
    for arg in args {
        let flag = arg.as_ref().trim_start_matches(['/', '-']).to_ascii_lowercase();
        let next = match flag.as_str() {
            "install" => SetupVerb::Install,
            "remove" => SetupVerb::Remove,
            "elevated" if !relaunched => {
                relaunched = true;
                continue;
            }
            _ => return None,
        };
        if verb.replace(next).is_some() {
            return None;
        }
    }
    Some(SetupRequest {
        verb: verb.unwrap_or(SetupVerb::Install),
        relaunched,
    })
}

/// The elevated copy's arguments: fixed words, nothing from the caller.
pub fn relaunch_parameters(verb: SetupVerb) -> &'static str {
    match verb {
        SetupVerb::Install => "/install /elevated",
        SetupVerb::Remove => "/remove /elevated",
    }
}

/// `videorc-camera-setup.exe`'s exit codes, the only channel back from its
/// elevated copy. `Declined` (3) is mirrored as
/// `WINDOWS_CAMERA_SETUP_DECLINED_EXIT_CODE` in
/// `apps/desktop/src/main/virtual-camera-windows-setup.ts`; Videorc shows
/// the exe's first line for the rest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupExit {
    Done,
    Failed,
    Usage,
    /// The UAC prompt was declined.
    Declined,
    /// The DLL beside the exe is missing.
    DllMissing,
    /// The installed DLL of this version is loaded and differs.
    InUse,
    /// A folder on the way down is a link or owned by someone else.
    UnsafeFolder,
    /// The DLL's signature does not match the setup exe's publisher.
    Untrusted,
    /// Still not elevated after the prompt (a standard user with UAC off).
    NotElevated,
}

impl SetupExit {
    const ALL: [Self; 9] = [
        Self::Done,
        Self::Failed,
        Self::Usage,
        Self::Declined,
        Self::DllMissing,
        Self::InUse,
        Self::UnsafeFolder,
        Self::Untrusted,
        Self::NotElevated,
    ];

    pub const fn code(self) -> u8 {
        match self {
            Self::Done => 0,
            Self::Failed => 1,
            Self::Usage => 2,
            Self::Declined => 3,
            Self::DllMissing => 4,
            Self::InUse => 5,
            Self::UnsafeFolder => 6,
            Self::Untrusted => 7,
            Self::NotElevated => 8,
        }
    }

    /// The code an elevated copy exited with; an unknown one is a failure.
    pub fn from_code(code: u32) -> Self {
        Self::ALL
            .into_iter()
            .find(|exit| u32::from(exit.code()) == code)
            .unwrap_or(Self::Failed)
    }

    /// The line the unelevated copy prints for its elevated copy's code.
    pub fn line(self, verb: SetupVerb) -> &'static str {
        match (self, verb) {
            (Self::Done, SetupVerb::Install) => "Videorc Camera is set up.",
            (Self::Done, SetupVerb::Remove) => "Videorc Camera was removed from this PC.",
            (Self::Failed, SetupVerb::Install) => {
                "Videorc Camera setup failed. Run videorc-camera-setup.exe from an administrator terminal to see why."
            }
            (Self::Failed, SetupVerb::Remove) => {
                "Videorc Camera removal failed. Run videorc-camera-setup.exe /remove from an administrator terminal to see why."
            }
            (Self::Usage, _) => USAGE,
            (Self::Declined, _) => "Windows did not get permission to change Videorc Camera.",
            (Self::DllMissing, _) => {
                "This Videorc build is missing the Videorc Camera files. Reinstall Videorc."
            }
            (Self::InUse, _) => {
                "Videorc Camera is in use. Close every app that uses it and set it up again."
            }
            (Self::UnsafeFolder, _) => {
                "A folder under C:\\ProgramData\\Videorc is a link or belongs to someone else. Delete C:\\ProgramData\\Videorc and set up again."
            }
            (Self::Untrusted, _) => {
                "The Videorc Camera file is not signed by Videorc's publisher. Reinstall Videorc."
            }
            (Self::NotElevated, _) => {
                "Videorc Camera setup needs an administrator. Ask one to approve the Windows prompt."
            }
        }
    }
}

/// Whether the DLL may be installed, from the two Authenticode publishers
/// (`None`: unsigned). A signed setup exe accepts only a DLL its own
/// publisher signed; an unsigned build (dev, unsigned Alpha) has nothing to
/// compare and accepts any.
pub fn publisher_allows(exe: Option<&[u8]>, dll: Option<&[u8]>) -> bool {
    match (exe, dll) {
        (None, _) => true,
        (Some(exe), Some(dll)) => exe == dll,
        (Some(_), None) => false,
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

    fn request(verb: SetupVerb, relaunched: bool) -> Option<SetupRequest> {
        Some(SetupRequest { verb, relaunched })
    }

    #[test]
    fn the_command_line_takes_one_verb_and_nothing_from_outside() {
        let none: [&str; 0] = [];
        assert_eq!(parse_setup_args(&none), request(SetupVerb::Install, false));
        assert_eq!(
            parse_setup_args(&["/install"]),
            request(SetupVerb::Install, false)
        );
        assert_eq!(
            parse_setup_args(&["--REMOVE"]),
            request(SetupVerb::Remove, false)
        );
        assert_eq!(
            parse_setup_args(&["/remove", "/elevated"]),
            request(SetupVerb::Remove, true)
        );
        for bad in [
            &["/install", "/remove"][..],
            &["/dll", r"C:\x\y.dll"],
            &["/install", r"C:\x\y.dll"],
            &["/elevated", "/elevated"],
            &["/frobnicate"],
        ] {
            assert_eq!(parse_setup_args(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_elevated_copy_gets_fixed_words_that_parse_back_as_relaunched() {
        for verb in [SetupVerb::Install, SetupVerb::Remove] {
            let words: Vec<&str> = relaunch_parameters(verb).split(' ').collect();
            assert_eq!(parse_setup_args(&words), request(verb, true));
            assert!(words.contains(&RELAUNCHED_FLAG));
        }
    }

    #[test]
    fn every_exit_code_round_trips_and_an_unknown_one_is_a_failure() {
        for exit in SetupExit::ALL {
            assert_eq!(SetupExit::from_code(u32::from(exit.code())), exit);
        }
        assert_eq!(SetupExit::Done.code(), 0);
        assert_eq!(SetupExit::Declined.code(), 3);
        assert_eq!(SetupExit::from_code(1223), SetupExit::Failed);
        assert_eq!(SetupExit::from_code(u32::MAX), SetupExit::Failed);
    }

    #[test]
    fn a_signed_setup_installs_only_its_own_publishers_dll() {
        let videorc = b"CN=Videorc".as_slice();
        let other = b"CN=Someone".as_slice();
        assert!(publisher_allows(Some(videorc), Some(videorc)));
        assert!(!publisher_allows(Some(videorc), Some(other)));
        assert!(!publisher_allows(Some(videorc), None));
        assert!(publisher_allows(None, None), "an unsigned dev build");
        assert!(publisher_allows(None, Some(other)));
    }

    #[test]
    fn only_the_installed_copy_may_be_registered() {
        let program_data = Path::new(r"C:\ProgramData");
        let installed = installed_dll_path(program_data, "0.1.0");
        assert!(is_installed_dll_path(&installed, program_data, "0.1.0"));
        assert!(is_installed_dll_path(
            Path::new(r"c:\programdata\VIDEORC\camera\0.1.0\videorc_virtual_camera_windows.dll"),
            program_data,
            "0.1.0"
        ));
        assert!(!is_installed_dll_path(&installed, program_data, "0.2.0"));
        assert!(!is_installed_dll_path(
            Path::new(
                r"C:\Users\ana\AppData\Local\Programs\Videorc\resources\videorc_virtual_camera_windows.dll"
            ),
            program_data,
            "0.1.0"
        ));
    }

    #[test]
    fn the_install_folders_are_protected_and_never_null() {
        for sddl in [INSTALL_DIR_SDDL, INSTALL_FILE_SDDL] {
            assert!(sddl.starts_with("O:BAD:PAI("), "{sddl}");
            assert!(sddl.contains(";FA;;;SY)") && sddl.contains(";FA;;;BA)"));
            assert!(sddl.contains(";FRFX;;;WD)"), "everyone only reads");
            for writer in ["BU", "AU", "IU", "CO"] {
                assert!(!sddl.contains(&format!(";;;{writer})")), "{writer}");
            }
        }
    }
}
