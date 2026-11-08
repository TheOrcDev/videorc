//! Windows Error Reporting runtime-exception module for `videorc-backend`.
//!
//! The backend's in-process minidump (`windows_crash_dump.rs`) is an
//! unhandled-exception filter, and Windows never runs that filter for a
//! fail-fast termination. Heap corruption ends the process that way: the
//! 2026-11-01 field bundle (0.17.4, Intel Iris Xe) holds five backend exits
//! with 0xC0000374 and an empty dump folder, although the filter creates its
//! file before it writes a byte.
//!
//! WER does see those crashes. The backend registers this DLL with
//! `WerRegisterRuntimeExceptionModule`; on a crash WerFault.exe loads it and
//! calls [`OutOfProcessExceptionEventCallback`] with the crashed process's
//! handle, from outside the broken process. The callback reads the dump
//! directory from the backend's [`WerRegistration`], writes
//! `videorc-backend-<pid>-wer.dmp` beside the in-process dumps, and never
//! claims the crash, so WER's own reporting and the supervisor's crash
//! record are unchanged. A crash the in-process filter already dumped is
//! skipped.
//!
//! Windows calls these modules from 20H1 (build 19041) on, and only for DLLs
//! listed under `RuntimeExceptionHelperModules` (HKCU works, so a per-user
//! install needs no elevation).

/// The helper DLL's file name; it ships beside `videorc-backend.exe`.
pub const HELPER_DLL_NAME: &str = "videorc_wer_helper.dll";
/// "VWER", little endian.
pub const REGISTRATION_MAGIC: u32 = u32::from_le_bytes(*b"VWER");
pub const REGISTRATION_VERSION: u32 = 1;
/// UTF-16 units for the dump directory, its NUL included.
pub const DUMP_DIRECTORY_CAPACITY: usize = 520;

/// What the backend hands WER as the module context. WerFault reads it out of
/// the crashed process with `ReadProcessMemory`, so it is plain data with a
/// fixed layout and every bit pattern valid.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct WerRegistration {
    pub magic: u32,
    pub version: u32,
    pub dump_directory: [u16; DUMP_DIRECTORY_CAPACITY],
}

impl WerRegistration {
    /// `None` when the directory is empty, holds a NUL, or does not fit.
    pub fn new(dump_directory: &[u16]) -> Option<Self> {
        if dump_directory.is_empty()
            || dump_directory.len() >= DUMP_DIRECTORY_CAPACITY
            || dump_directory.contains(&0)
        {
            return None;
        }
        let mut registration = Self {
            magic: REGISTRATION_MAGIC,
            version: REGISTRATION_VERSION,
            dump_directory: [0; DUMP_DIRECTORY_CAPACITY],
        };
        registration.dump_directory[..dump_directory.len()].copy_from_slice(dump_directory);
        Some(registration)
    }

    /// The directory without its NUL, when this is a registration this
    /// helper version understands.
    pub fn dump_directory(&self) -> Option<&[u16]> {
        if self.magic != REGISTRATION_MAGIC || self.version != REGISTRATION_VERSION {
            return None;
        }
        let len = self.dump_directory.iter().position(|unit| *unit == 0)?;
        (len > 0).then(|| &self.dump_directory[..len])
    }
}

/// The in-process filter's dump for `pid` (`windows_crash_dump.rs`).
pub fn in_process_dump_file_name(pid: u32) -> String {
    format!("videorc-backend-{pid}.dmp")
}

/// This helper's dump for `pid`.
pub fn helper_dump_file_name(pid: u32) -> String {
    format!("videorc-backend-{pid}-wer.dmp")
}

#[cfg(windows)]
mod windows_module;

#[cfg(windows)]
pub use windows_module::{forget_helper_module, register};

#[cfg(test)]
mod tests {
    use super::*;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    #[test]
    fn a_registration_round_trips_its_dump_directory() {
        let directory = wide(r"C:\Users\Ana Lee\AppData\Roaming\Videorc\backend-dumps");
        let registration = WerRegistration::new(&directory).unwrap();
        assert_eq!(registration.dump_directory(), Some(directory.as_slice()));
    }

    #[test]
    fn a_registration_refuses_what_wer_could_not_read_back() {
        assert!(WerRegistration::new(&[]).is_none());
        assert!(WerRegistration::new(&wide("a\0b")).is_none());
        assert!(WerRegistration::new(&vec![u16::from(b'a'); DUMP_DIRECTORY_CAPACITY]).is_none());
        assert!(
            WerRegistration::new(&vec![u16::from(b'a'); DUMP_DIRECTORY_CAPACITY - 1]).is_some(),
            "the longest directory still leaves room for its NUL"
        );
    }

    #[test]
    fn foreign_or_unterminated_memory_is_not_a_registration() {
        let mut registration = WerRegistration::new(&wide(r"C:\dumps")).unwrap();
        registration.magic = 0;
        assert_eq!(registration.dump_directory(), None);
        let mut registration = WerRegistration::new(&wide(r"C:\dumps")).unwrap();
        registration.version += 1;
        assert_eq!(registration.dump_directory(), None);
        let mut registration = WerRegistration::new(&wide(r"C:\dumps")).unwrap();
        registration.dump_directory = [u16::from(b'a'); DUMP_DIRECTORY_CAPACITY];
        assert_eq!(registration.dump_directory(), None, "no NUL");
    }

    #[test]
    fn the_helper_dump_never_overwrites_the_in_process_dump() {
        assert_eq!(in_process_dump_file_name(42), "videorc-backend-42.dmp");
        assert_eq!(helper_dump_file_name(42), "videorc-backend-42-wer.dmp");
    }
}
