//! What `videorc-camera-setup.exe` does once it runs elevated (plan 214 C2):
//! copy the DLL under `%ProgramData%` and register it, or undo both.

use std::fs;
use std::path::{Path, PathBuf};

use crate::setup::{CAMERA_DLL_VERSION, DLL_FILE_NAME, INSTALL_ROOT_COMPONENTS, install_dir};

use super::registration;

pub struct Installed {
    pub dll_path: PathBuf,
    pub version: String,
}

fn program_data() -> Result<PathBuf, String> {
    std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| "%ProgramData% is not set".to_string())
}

fn camera_root(program_data: &Path) -> PathBuf {
    let mut root = program_data.to_path_buf();
    for component in INSTALL_ROOT_COMPONENTS {
        root.push(component);
    }
    root
}

/// Copy the DLL (`dll_override`, else the one beside this exe) to the
/// versioned install dir and write HKLM. Older versions' folders are removed
/// when nothing holds them.
pub fn install(dll_override: Option<&Path>) -> Result<Installed, String> {
    let source = match dll_override {
        Some(path) => path.to_path_buf(),
        None => {
            let exe = std::env::current_exe().map_err(|error| format!("current_exe: {error}"))?;
            exe.parent()
                .ok_or_else(|| "the setup exe has no parent directory".to_string())?
                .join(DLL_FILE_NAME)
        }
    };
    if !source.is_file() {
        return Err(format!(
            "the media source DLL is missing: {}",
            source.display()
        ));
    }
    let program_data = program_data()?;
    let dir = install_dir(&program_data, CAMERA_DLL_VERSION);
    fs::create_dir_all(&dir).map_err(|error| format!("create {}: {error}", dir.display()))?;
    let target = dir.join(DLL_FILE_NAME);
    // Write beside, then rename over: a reader never sees a half-copied DLL.
    // The rename fails while the Frame Server holds this exact version
    // loaded; that only happens on a repeated setup of the same version,
    // and the message says what to do.
    let staging = dir.join(format!("{DLL_FILE_NAME}.new"));
    fs::copy(&source, &staging).map_err(|error| {
        format!(
            "copy {} to {}: {error}",
            source.display(),
            staging.display()
        )
    })?;
    if let Err(error) = fs::rename(&staging, &target) {
        let _ = fs::remove_file(&staging);
        return Err(format!(
            "replace {}: {error}. Close every app that uses Videorc Camera and run the setup again.",
            target.display()
        ));
    }
    registration::register(&target, CAMERA_DLL_VERSION).map_err(|error| error.to_string())?;
    prune_other_versions(&camera_root(&program_data), CAMERA_DLL_VERSION);
    Ok(Installed {
        dll_path: target,
        version: CAMERA_DLL_VERSION.to_string(),
    })
}

/// Best effort: a folder the Frame Server still has loaded stays until the
/// next setup.
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

/// Remove the HKLM keys, then the installed folders (best effort: a loaded
/// DLL cannot be deleted until the camera is released everywhere).
pub fn remove() -> Result<(), String> {
    registration::unregister().map_err(|error| error.to_string())?;
    if let Ok(program_data) = program_data() {
        let root = camera_root(&program_data);
        if root.exists()
            && let Err(error) = fs::remove_dir_all(&root)
        {
            eprintln!(
                "Videorc Camera is unregistered; {} stays until every app releases the camera ({error}).",
                root.display()
            );
        }
    }
    Ok(())
}
