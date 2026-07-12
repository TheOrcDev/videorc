use std::io;
use std::path::Path;

/// Atomically publish or replace a file after its staged bytes have been
/// flushed. Windows needs write-through namespace durability and verbatim
/// paths because internal recovery files can legitimately exceed MAX_PATH.
#[cfg(not(target_os = "windows"))]
pub(crate) fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(target_os = "windows")]
pub(crate) fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use windows::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    use windows::core::PCWSTR;

    let source = windows_verbatim_path(source)?;
    let destination = windows_verbatim_path(destination)?;
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(windows_error_to_io)
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_verbatim_path(path: &Path) -> io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;

    const BACKSLASH: u16 = b'\\' as u16;
    const FORWARD_SLASH: u16 = b'/' as u16;
    const VERBATIM_PREFIX: [u16; 4] = [BACKSLASH, BACKSLASH, b'?' as u16, BACKSLASH];
    const DEVICE_PREFIX: [u16; 4] = [BACKSLASH, BACKSLASH, b'.' as u16, BACKSLASH];
    const UNC_PREFIX: [u16; 2] = [BACKSLASH, BACKSLASH];
    const VERBATIM_UNC_PREFIX: [u16; 8] = [
        BACKSLASH,
        BACKSLASH,
        b'?' as u16,
        BACKSLASH,
        b'U' as u16,
        b'N' as u16,
        b'C' as u16,
        BACKSLASH,
    ];

    let resolved;
    let path = if path.is_absolute() {
        path
    } else {
        resolved = std::path::absolute(path)?;
        resolved.as_path()
    };
    let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows file paths cannot contain NUL characters",
        ));
    }
    if wide.starts_with(&DEVICE_PREFIX) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows device namespace paths cannot be used for atomic file replacement",
        ));
    }
    if wide.starts_with(&VERBATIM_PREFIX) {
        wide.push(0);
        return Ok(wide);
    }
    for unit in &mut wide {
        if *unit == FORWARD_SLASH {
            *unit = BACKSLASH;
        }
    }

    let mut verbatim = Vec::with_capacity(wide.len() + VERBATIM_UNC_PREFIX.len() + 1);
    if wide.starts_with(&UNC_PREFIX) {
        verbatim.extend_from_slice(&VERBATIM_UNC_PREFIX);
        verbatim.extend_from_slice(&wide[UNC_PREFIX.len()..]);
    } else {
        verbatim.extend_from_slice(&VERBATIM_PREFIX);
        verbatim.extend_from_slice(&wide);
    }
    verbatim.push(0);
    Ok(verbatim)
}

#[cfg(target_os = "windows")]
fn windows_error_to_io(error: windows::core::Error) -> io::Error {
    let hresult = error.code().0 as u32;
    if hresult & 0xffff_0000 == 0x8007_0000 {
        io::Error::from_raw_os_error((hresult & 0xffff) as i32)
    } else {
        io::Error::other(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_replace_overwrites_the_destination() {
        let directory =
            std::env::temp_dir().join(format!("videorc-atomic-replace-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let source = directory.join("replacement.tmp");
        let destination = directory.join("recovery.json");
        std::fs::write(&source, b"new recovery").unwrap();
        std::fs::write(&destination, b"old recovery").unwrap();

        replace_file(&source, &destination).unwrap();

        assert!(!source.exists());
        assert_eq!(std::fs::read(&destination).unwrap(), b"new recovery");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn atomic_replace_can_publish_a_new_destination() {
        let directory =
            std::env::temp_dir().join(format!("videorc-atomic-publish-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let source = directory.join("replacement.tmp");
        let destination = directory.join("recovery.json");
        std::fs::write(&source, b"first recovery").unwrap();

        replace_file(&source, &destination).unwrap();

        assert!(!source.exists());
        assert_eq!(std::fs::read(&destination).unwrap(), b"first recovery");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn atomic_replace_supports_paths_longer_than_max_path() {
        use std::os::windows::ffi::OsStrExt;

        let root =
            std::env::temp_dir().join(format!("videorc-atomic-long-path-{}", uuid::Uuid::new_v4()));
        let destination_name = "recovery.json";
        let root_units = root.as_os_str().encode_wide().count();
        let padding_units = 250usize
            .checked_sub(root_units + 1 + destination_name.len())
            .expect("temporary root must leave room below MAX_PATH");
        assert!(padding_units > 1, "padding must include its Unicode prefix");
        assert!(padding_units < 255, "padding must fit one path component");
        let directory = root.join(format!("é{}", "a".repeat(padding_units - 1)));
        std::fs::create_dir_all(&directory).unwrap();
        let destination = directory.join(destination_name);
        let source = directory.join(format!(".{destination_name}.{}.tmp", uuid::Uuid::new_v4()));
        assert!(
            destination.as_os_str().encode_wide().count() < 260,
            "destination must mirror the below-MAX_PATH recovery path"
        );
        assert!(
            source.as_os_str().encode_wide().count() > 260,
            "staged replacement must exceed the legacy Windows MAX_PATH boundary"
        );
        std::fs::write(&source, b"new long-path recovery").unwrap();
        std::fs::write(&destination, b"old long-path recovery").unwrap();

        replace_file(&source, &destination).unwrap();

        assert!(!source.exists());
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"new long-path recovery"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn verbatim_path_conversion_handles_drive_unc_and_rejects_unsafe_namespaces() {
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;

        assert_eq!(
            wide_string(windows_verbatim_path(Path::new(r"C:\folder\file.json")).unwrap()),
            r"\\?\C:\folder\file.json"
        );
        assert_eq!(
            wide_string(windows_verbatim_path(Path::new(r"\\server\share\file.json")).unwrap()),
            r"\\?\UNC\server\share\file.json"
        );
        assert_eq!(
            wide_string(windows_verbatim_path(Path::new(r"\\?\C:\folder/file.json")).unwrap()),
            r"\\?\C:\folder/file.json"
        );
        assert_eq!(
            windows_verbatim_path(Path::new(r"\\.\PhysicalDrive0"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        let with_nul = OsString::from_wide(&[
            b'C' as u16,
            b':' as u16,
            b'\\' as u16,
            b'a' as u16,
            0,
            b'b' as u16,
        ]);
        assert_eq!(
            windows_verbatim_path(Path::new(&with_nul))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[cfg(target_os = "windows")]
    fn wide_string(mut wide: Vec<u16>) -> String {
        assert_eq!(wide.pop(), Some(0));
        String::from_utf16(&wide).unwrap()
    }
}
