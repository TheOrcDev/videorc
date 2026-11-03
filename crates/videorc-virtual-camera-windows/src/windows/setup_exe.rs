//! What `videorc-camera-setup.exe` does on Windows (plan 214 C2): ask for
//! elevation once, then copy the DLL under `%ProgramData%` and register it,
//! or undo both. The layout and the rules are in [`crate::setup`].

use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::mem::size_of;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};

use windows::Win32::Foundation::{
    CloseHandle, ERROR_CANCELLED, HANDLE, HLOCAL, HWND, LocalFree, WAIT_OBJECT_0,
};
use windows::Win32::Security::Authorization::{
    GetNamedSecurityInfoW, SE_FILE_OBJECT, SetNamedSecurityInfoW,
};
use windows::Win32::Security::Cryptography::{CERT_CONTEXT, CERT_INFO};
use windows::Win32::Security::WinTrust::{
    WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO,
    WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE,
    WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData, WinVerifyTrust,
};
use windows::Win32::Security::{
    DACL_SECURITY_INFORMATION, EqualSid, GetTokenInformation, IsWellKnownSid,
    OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
    TOKEN_ELEVATION, TOKEN_QUERY, TOKEN_USER, TokenElevation, TokenUser,
    WinBuiltinAdministratorsSid, WinLocalSystemSid,
};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetExitCodeProcess, INFINITE, OpenProcessToken, WaitForSingleObject,
};
use windows::Win32::UI::Shell::{
    FOLDERID_ProgramData, KF_FLAG_DEFAULT, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
    SHELLEXECUTEINFOW, SHGetKnownFolderPath, ShellExecuteExW,
};
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
use windows::core::{HRESULT, HSTRING, PCWSTR, w};

use crate::setup::{
    CAMERA_DLL_VERSION, DLL_FILE_NAME, INSTALL_DIR_SDDL, INSTALL_FILE_SDDL,
    INSTALL_ROOT_COMPONENTS, SetupExit, SetupVerb, publisher_allows, relaunch_parameters,
};

use super::registration;
use super::section::SecurityDescriptor;

/// Authenticode: the file carries no signature at all.
const TRUST_E_NOSIGNATURE: i32 = 0x800B_0100_u32 as i32;
/// `FILE_ATTRIBUTE_REPARSE_POINT`: a symlink, a junction or a mount point.
const REPARSE_POINT: u32 = 0x400;

/// Why a setup step failed: the exit code it maps to and the detail an
/// administrator terminal shows.
#[derive(Debug)]
pub struct SetupFailure {
    pub exit: SetupExit,
    pub detail: String,
}

impl SetupFailure {
    fn new(exit: SetupExit, detail: impl Into<String>) -> Self {
        Self {
            exit,
            detail: detail.into(),
        }
    }

    fn failed(detail: impl Into<String>) -> Self {
        Self::new(SetupExit::Failed, detail)
    }
}

impl fmt::Display for SetupFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.detail)
    }
}

pub struct Installed {
    pub dll_path: PathBuf,
    pub version: String,
    /// The same version was installed already, byte for byte.
    pub unchanged: bool,
}

// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------

/// Whether this process runs with an elevated token.
pub fn is_elevated() -> bool {
    let Ok(token) = ProcessToken::open() else {
        return false;
    };
    let mut elevation = TOKEN_ELEVATION::default();
    let mut returned = 0u32;
    // SAFETY: the buffer is a TOKEN_ELEVATION of the stated size.
    unsafe {
        GetTokenInformation(
            token.0,
            TokenElevation,
            Some((&raw mut elevation).cast()),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
    }
    .is_ok()
        && elevation.TokenIsElevated != 0
}

/// Why the elevated copy did not run.
pub enum RelaunchError {
    /// The person declined the UAC prompt.
    Declined,
    Failed(String),
}

/// Start this exe again through UAC (`runas`) with fixed arguments and wait
/// for it. Returns the elevated copy's exit code.
pub fn relaunch_elevated(verb: SetupVerb) -> Result<u32, RelaunchError> {
    let exe = std::env::current_exe()
        .map_err(|error| RelaunchError::Failed(format!("current_exe: {error}")))?;
    let file = HSTRING::from(exe.as_os_str());
    let parameters = HSTRING::from(relaunch_parameters(verb));
    let mut info = SHELLEXECUTEINFOW {
        cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        hwnd: HWND::default(),
        lpVerb: w!("runas"),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(parameters.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    // SAFETY: every string outlives the call; the struct is sized.
    if let Err(error) = unsafe { ShellExecuteExW(&mut info) } {
        if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
            return Err(RelaunchError::Declined);
        }
        return Err(RelaunchError::Failed(format!("ShellExecuteExW: {error}")));
    }
    if info.hProcess.is_invalid() {
        return Err(RelaunchError::Failed(
            "Windows started no elevated setup process".to_string(),
        ));
    }
    let process = OwnedHandle(info.hProcess);
    // SAFETY: a process handle we own; waiting has no other precondition.
    if unsafe { WaitForSingleObject(process.0, INFINITE) } != WAIT_OBJECT_0 {
        return Err(RelaunchError::Failed(
            "waiting for the elevated setup failed".to_string(),
        ));
    }
    let mut code = 0u32;
    // SAFETY: the process has exited; `code` receives its exit code.
    unsafe { GetExitCodeProcess(process.0, &mut code) }
        .map_err(|error| RelaunchError::Failed(format!("GetExitCodeProcess: {error}")))?;
    Ok(code)
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: ours, closed once.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

struct ProcessToken(HANDLE);

impl ProcessToken {
    fn open() -> windows::core::Result<Self> {
        let mut token = HANDLE::default();
        // SAFETY: the pseudo handle needs no closing; `token` is closed in Drop.
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)? };
        Ok(Self(token))
    }

    /// The token's user SID, copied into `buffer` (which must outlive it).
    fn user(&self, buffer: &mut Vec<u8>) -> Option<PSID> {
        let mut needed = 0u32;
        // SAFETY: a size query with no buffer.
        let _ = unsafe { GetTokenInformation(self.0, TokenUser, None, 0, &mut needed) };
        if needed == 0 {
            return None;
        }
        buffer.resize(needed as usize, 0);
        // SAFETY: the buffer holds `needed` bytes.
        unsafe {
            GetTokenInformation(
                self.0,
                TokenUser,
                Some(buffer.as_mut_ptr().cast()),
                needed,
                &mut needed,
            )
        }
        .ok()?;
        // SAFETY: the call above wrote a TOKEN_USER at the buffer's start;
        // the read is unaligned-safe.
        let user = unsafe { buffer.as_ptr().cast::<TOKEN_USER>().read_unaligned() };
        Some(user.User.Sid)
    }
}

impl Drop for ProcessToken {
    fn drop(&mut self) {
        // SAFETY: ours, closed once.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

/// `%ProgramData%` from the known-folder registry (machine-wide), never from
/// the environment, which the user controls even in an elevated process.
pub fn program_data() -> Result<PathBuf, String> {
    // SAFETY: the returned buffer is freed with CoTaskMemFree below.
    let path = unsafe { SHGetKnownFolderPath(&FOLDERID_ProgramData, KF_FLAG_DEFAULT, None) }
        .map_err(|error| format!("SHGetKnownFolderPath(ProgramData): {error}"))?;
    // SAFETY: a NUL-terminated string from the shell.
    let wide = unsafe { path.as_wide() }.to_vec();
    // SAFETY: allocated by the shell with CoTaskMemAlloc; freed once.
    unsafe { CoTaskMemFree(Some(path.0.cast())) };
    if wide.is_empty() {
        return Err("SHGetKnownFolderPath(ProgramData) returned an empty path".to_string());
    }
    Ok(PathBuf::from(OsString::from_wide(&wide)))
}

fn camera_root(program_data: &Path) -> PathBuf {
    let mut root = program_data.to_path_buf();
    for component in INSTALL_ROOT_COMPONENTS {
        root.push(component);
    }
    root
}

/// Refuse a path that is any kind of reparse point: a link planted where a
/// folder of ours should be would send the elevated copy elsewhere.
fn refuse_link(path: &Path) -> Result<(), SetupFailure> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_attributes() & REPARSE_POINT != 0 => {
            Err(SetupFailure::new(
                SetupExit::UnsafeFolder,
                format!("{} is a link", path.display()),
            ))
        }
        _ => Ok(()),
    }
}

/// Whether `path`'s owner is Administrators, SYSTEM, or this elevated
/// process's own user: anyone else could still hold rights on it.
fn owned_by_trusted(path: &Path, token: &ProcessToken) -> Result<bool, SetupFailure> {
    let name = HSTRING::from(path.as_os_str());
    let mut owner = PSID::default();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    // SAFETY: `descriptor` receives a LocalAlloc'ed block freed below;
    // `owner` points into it.
    let error = unsafe {
        GetNamedSecurityInfoW(
            &name,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            Some(&mut owner),
            None,
            None,
            None,
            &mut descriptor,
        )
    };
    if error.is_err() {
        return Err(SetupFailure::failed(format!(
            "GetNamedSecurityInfoW({}) failed with Win32 error {}",
            path.display(),
            error.0
        )));
    }
    let mut user_buffer = Vec::new();
    // SAFETY: `owner` points into `descriptor`, alive until LocalFree.
    let trusted = unsafe {
        IsWellKnownSid(owner, WinBuiltinAdministratorsSid).as_bool()
            || IsWellKnownSid(owner, WinLocalSystemSid).as_bool()
            || token
                .user(&mut user_buffer)
                .is_some_and(|user| EqualSid(owner, user).is_ok())
    };
    // SAFETY: allocated by GetNamedSecurityInfoW, freed once.
    unsafe { LocalFree(Some(HLOCAL(descriptor.0))) };
    Ok(trusted)
}

/// Give `path` the owner and the protected DACL of `sddl`.
fn apply_sddl(path: &Path, sddl: &str) -> Result<(), SetupFailure> {
    let descriptor = SecurityDescriptor::from_sddl(sddl)
        .map_err(|error| SetupFailure::failed(error.to_string()))?;
    let owner = descriptor
        .owner()
        .map_err(|error| SetupFailure::failed(error.to_string()))?;
    let dacl = descriptor
        .dacl()
        .map_err(|error| SetupFailure::failed(error.to_string()))?;
    let name = HSTRING::from(path.as_os_str());
    // SAFETY: the owner and the DACL point into `descriptor`, alive for the
    // call; the name is NUL-terminated.
    let error = unsafe {
        SetNamedSecurityInfoW(
            &name,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION
                | DACL_SECURITY_INFORMATION
                | PROTECTED_DACL_SECURITY_INFORMATION,
            Some(owner),
            None,
            Some(dacl.cast_const()),
            None,
        )
    };
    if error.is_err() {
        return Err(SetupFailure::failed(format!(
            "SetNamedSecurityInfoW({}) failed with Win32 error {}",
            path.display(),
            error.0
        )));
    }
    Ok(())
}

/// Make `path` one of ours: refuse a link or a stranger's folder, create it
/// when missing, then own and protect it.
fn ensure_protected_dir(path: &Path, token: &ProcessToken) -> Result<(), SetupFailure> {
    refuse_link(path)?;
    if path.exists() {
        if !path.is_dir() || !owned_by_trusted(path, token)? {
            return Err(SetupFailure::new(
                SetupExit::UnsafeFolder,
                format!("{} belongs to someone else", path.display()),
            ));
        }
    } else {
        fs::create_dir(path).map_err(|error| {
            SetupFailure::failed(format!("create {}: {error}", path.display()))
        })?;
    }
    apply_sddl(path, INSTALL_DIR_SDDL)
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/// The Authenticode signer's subject (DER), `None` when the file carries no
/// signature. A signature that is present but does not verify is an error.
fn publisher(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let name = HSTRING::from(path.as_os_str());
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: PCWSTR(name.as_ptr()),
        ..Default::default()
    };
    let mut data = WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 {
            pFile: &mut file,
        },
        dwStateAction: WTD_STATEACTION_VERIFY,
        ..Default::default()
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    // SAFETY: `data` and `file` outlive both calls; the state opened by
    // VERIFY is closed by CLOSE below whatever the verdict.
    let verdict =
        unsafe { WinVerifyTrust(HWND::default(), &mut action, (&raw mut data).cast()) };
    let subject = if verdict == 0 {
        // SAFETY: the state data is valid until CLOSE; every pointer read is
        // checked for null.
        unsafe { signer_subject(data.hWVTStateData) }
    } else {
        None
    };
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    // SAFETY: closes the state the first call opened.
    unsafe { WinVerifyTrust(HWND::default(), &mut action, (&raw mut data).cast()) };
    match verdict {
        0 => subject
            .map(Some)
            .ok_or_else(|| format!("{} is signed but has no signer certificate", path.display())),
        TRUST_E_NOSIGNATURE => Ok(None),
        other => Err(format!(
            "{} has a signature Windows does not trust (0x{:08X})",
            path.display(),
            other as u32
        )),
    }
}

/// # Safety
///
/// `state` is the live `hWVTStateData` of a successful verification.
unsafe fn signer_subject(state: HANDLE) -> Option<Vec<u8>> {
    // SAFETY: the caller's contract; every pointer is checked before use.
    unsafe {
        let provider = WTHelperProvDataFromStateData(state);
        if provider.is_null() {
            return None;
        }
        let signer = WTHelperGetProvSignerFromChain(provider, 0, false, 0);
        if signer.is_null() || (*signer).csCertChain == 0 || (*signer).pasCertChain.is_null() {
            return None;
        }
        let leaf: *const CERT_CONTEXT = (*(*signer).pasCertChain).pCert;
        if leaf.is_null() || (*leaf).pCertInfo.is_null() {
            return None;
        }
        let info: *const CERT_INFO = (*leaf).pCertInfo;
        let subject = (*info).Subject;
        if subject.pbData.is_null() || subject.cbData == 0 {
            return None;
        }
        Some(std::slice::from_raw_parts(subject.pbData, subject.cbData as usize).to_vec())
    }
}

// ---------------------------------------------------------------------------
// Install and remove (elevated)
// ---------------------------------------------------------------------------

/// Copy the DLL beside this exe into the versioned install folder, check
/// the copy's publisher there, put it in place and register it. Folders of
/// older versions go when nothing holds them.
pub fn install() -> Result<Installed, SetupFailure> {
    let exe = std::env::current_exe()
        .map_err(|error| SetupFailure::failed(format!("current_exe: {error}")))?;
    let source = exe
        .parent()
        .ok_or_else(|| SetupFailure::failed("the setup exe has no parent folder"))?
        .join(DLL_FILE_NAME);
    if !source.is_file() {
        return Err(SetupFailure::new(
            SetupExit::DllMissing,
            format!("the media source DLL is missing: {}", source.display()),
        ));
    }
    let token = ProcessToken::open()
        .map_err(|error| SetupFailure::failed(format!("OpenProcessToken: {error}")))?;
    let program_data = program_data().map_err(SetupFailure::failed)?;
    let vendor = program_data.join(INSTALL_ROOT_COMPONENTS[0]);
    let root = camera_root(&program_data);
    let dir = root.join(CAMERA_DLL_VERSION);
    for folder in [&vendor, &root, &dir] {
        ensure_protected_dir(folder, &token)?;
    }

    // Copy into the protected folder first and judge the copy, not the
    // source a user process could still swap.
    let target = dir.join(DLL_FILE_NAME);
    let staging = dir.join(format!("{DLL_FILE_NAME}.new"));
    refuse_link(&staging)?;
    let _ = fs::remove_file(&staging);
    fs::copy(&source, &staging).map_err(|error| {
        SetupFailure::failed(format!(
            "copy {} to {}: {error}",
            source.display(),
            staging.display()
        ))
    })?;
    let exe_publisher = publisher(&exe).map_err(SetupFailure::failed)?;
    let dll_publisher = match publisher(&staging) {
        Ok(publisher) => publisher,
        Err(error) => {
            let _ = fs::remove_file(&staging);
            return Err(SetupFailure::new(SetupExit::Untrusted, error));
        }
    };
    if !publisher_allows(exe_publisher.as_deref(), dll_publisher.as_deref()) {
        let _ = fs::remove_file(&staging);
        return Err(SetupFailure::new(
            SetupExit::Untrusted,
            format!(
                "{} is not signed by the setup exe's publisher",
                source.display()
            ),
        ));
    }

    refuse_link(&target)?;
    let unchanged = target.is_file()
        && owned_by_trusted(&target, &token)?
        && fs::read(&target).ok() == fs::read(&staging).ok();
    if unchanged {
        let _ = fs::remove_file(&staging);
    } else if let Err(error) = fs::rename(&staging, &target) {
        // The Frame Server holds this version's DLL loaded and it differs.
        let _ = fs::remove_file(&staging);
        return Err(SetupFailure::new(
            SetupExit::InUse,
            format!("replace {}: {error}", target.display()),
        ));
    }
    apply_sddl(&target, INSTALL_FILE_SDDL)?;
    registration::register(&target, CAMERA_DLL_VERSION)
        .map_err(|error| SetupFailure::failed(error.to_string()))?;
    prune_other_versions(&root, CAMERA_DLL_VERSION);
    Ok(Installed {
        dll_path: target,
        version: CAMERA_DLL_VERSION.to_string(),
        unchanged,
    })
}

/// Best effort: a folder the Frame Server still has loaded stays until the
/// next setup. Only Administrators can create anything under the protected
/// root, and `remove_dir_all` does not follow links.
fn prune_other_versions(root: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && entry.file_name() != keep {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

/// Remove the HKLM keys, then the installed folders. A DLL some app still
/// has loaded stays until it is released; that is reported, not a failure.
pub fn remove() -> Result<Option<String>, SetupFailure> {
    registration::unregister().map_err(|error| SetupFailure::failed(error.to_string()))?;
    let program_data = program_data().map_err(SetupFailure::failed)?;
    let vendor = program_data.join(INSTALL_ROOT_COMPONENTS[0]);
    let root = camera_root(&program_data);
    for folder in [&vendor, &root] {
        if refuse_link(folder).is_err() {
            return Ok(Some(format!(
                "{} is a link; it was left alone",
                folder.display()
            )));
        }
    }
    let mut note = None;
    if root.exists()
        && let Err(error) = fs::remove_dir_all(&root)
    {
        note = Some(format!(
            "{} stays until every app releases the camera ({error})",
            root.display()
        ));
    }
    // Only when empty: anything else under it is not the camera's.
    let _ = fs::remove_dir(&vendor);
    Ok(note)
}
