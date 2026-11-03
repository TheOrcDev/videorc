//! The named `Global\` section the ring lives in (plan 214 C1).
//!
//! The media source creates it from inside the Frame Server (session 0,
//! where a `Global\` section needs no privilege) with the DACL in
//! [`SECTION_SDDL`]; Videorc opens it from the user's session with read and
//! write access. Creating a name that already exists hands back the existing
//! object with its memory intact (`ERROR_ALREADY_EXISTS`), which is how a
//! restarted media source meets the frames a still-running Videorc keeps
//! writing.

use std::fmt;
use std::mem::size_of;

use windows::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, GetLastError, HANDLE, HLOCAL,
    INVALID_HANDLE_VALUE, LocalFree, SetLastError, WIN32_ERROR,
};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{
    ACL, GetSecurityDescriptorDacl, GetSecurityDescriptorOwner, PSECURITY_DESCRIPTOR, PSID,
    SECURITY_ATTRIBUTES,
};
use windows::Win32::System::Memory::{
    CreateFileMappingW, FILE_MAP_READ, FILE_MAP_WRITE, MEMORY_MAPPED_VIEW_ADDRESS, MapViewOfFile,
    OpenFileMappingW, PAGE_READWRITE, UnmapViewOfFile,
};
use windows::core::{BOOL, HSTRING};

use crate::SECTION_SDDL;
use crate::ring::RingRegion;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SectionError {
    /// `open` found no section of that name: no media source has created it.
    Absent,
    /// A Win32 call failed; `step` says which.
    Win32 { step: &'static str, code: i32 },
}

impl fmt::Display for SectionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Absent => write!(f, "the camera section does not exist yet"),
            Self::Win32 { step, code } => write!(f, "{step} failed with 0x{code:08X}"),
        }
    }
}

impl std::error::Error for SectionError {}

fn win32(step: &'static str, error: windows::core::Error) -> SectionError {
    SectionError::Win32 {
        step,
        code: error.code().0,
    }
}

/// A self-relative security descriptor built from SDDL, freed on drop.
pub(crate) struct SecurityDescriptor(PSECURITY_DESCRIPTOR);

impl SecurityDescriptor {
    pub(crate) fn from_sddl(sddl: &str) -> Result<Self, SectionError> {
        let sddl = HSTRING::from(sddl);
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        // SAFETY: `sddl` is a valid NUL-terminated string and `descriptor`
        // receives a LocalAlloc'ed block we free in Drop.
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                &sddl,
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
        }
        .map_err(|error| {
            win32(
                "ConvertStringSecurityDescriptorToSecurityDescriptorW",
                error,
            )
        })?;
        Ok(Self(descriptor))
    }

    /// The owner SID the SDDL named (`O:`), borrowed from the descriptor.
    pub(crate) fn owner(&self) -> Result<PSID, SectionError> {
        let mut owner = PSID::default();
        let mut defaulted = BOOL(0);
        // SAFETY: the descriptor is alive; both out pointers are ours.
        unsafe { GetSecurityDescriptorOwner(self.0, &mut owner, &mut defaulted) }
            .map_err(|error| win32("GetSecurityDescriptorOwner", error))?;
        if owner.is_invalid() {
            return Err(SectionError::Win32 {
                step: "GetSecurityDescriptorOwner (no owner in the SDDL)",
                code: 0,
            });
        }
        Ok(owner)
    }

    /// The DACL the SDDL named (`D:`), borrowed from the descriptor. A
    /// missing or NULL DACL is an error, never something to apply.
    pub(crate) fn dacl(&self) -> Result<*mut ACL, SectionError> {
        let mut present = BOOL(0);
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut defaulted = BOOL(0);
        // SAFETY: the descriptor is alive; the out pointers are ours.
        unsafe { GetSecurityDescriptorDacl(self.0, &mut present, &mut dacl, &mut defaulted) }
            .map_err(|error| win32("GetSecurityDescriptorDacl", error))?;
        if !present.as_bool() || dacl.is_null() {
            return Err(SectionError::Win32 {
                step: "GetSecurityDescriptorDacl (no DACL in the SDDL)",
                code: 0,
            });
        }
        Ok(dacl)
    }
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        // SAFETY: the block came from the conversion above and is freed once.
        unsafe { LocalFree(Some(HLOCAL(self.0.0))) };
    }
}

/// One mapped section: the handle and its full view.
pub struct SharedSection {
    handle: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    len: usize,
    already_existed: bool,
}

// SAFETY: a section handle and its view are process-wide kernel resources;
// the ring protocol governs the memory, the owner uses it from one thread.
unsafe impl Send for SharedSection {}

impl SharedSection {
    /// The media source's side: create (or reopen) `name` with the camera
    /// DACL and map all `len` bytes read-write.
    pub fn create(name: &str, len: usize) -> Result<Self, SectionError> {
        let descriptor = SecurityDescriptor::from_sddl(SECTION_SDDL)?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0.0,
            bInheritHandle: false.into(),
        };
        let name = HSTRING::from(name);
        // SAFETY: the attributes point at a descriptor that outlives the
        // call; the name is NUL-terminated.
        let handle = unsafe {
            SetLastError(WIN32_ERROR(0));
            CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                Some(&attributes),
                PAGE_READWRITE,
                (len >> 32) as u32,
                len as u32,
                &name,
            )
        }
        .map_err(|error| win32("CreateFileMappingW", error))?;
        // SAFETY: plain thread-local read right after the creating call.
        let already_existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        Self::map(handle, len, already_existed)
    }

    /// Videorc's side: open an existing section read-write.
    pub fn open(name: &str, len: usize) -> Result<Self, SectionError> {
        let name = HSTRING::from(name);
        // SAFETY: the name is NUL-terminated.
        let handle = unsafe { OpenFileMappingW((FILE_MAP_READ | FILE_MAP_WRITE).0, false, &name) }
            .map_err(|error| {
                if error.code() == ERROR_FILE_NOT_FOUND.to_hresult() {
                    SectionError::Absent
                } else {
                    win32("OpenFileMappingW", error)
                }
            })?;
        Self::map(handle, len, true)
    }

    fn map(handle: HANDLE, len: usize, already_existed: bool) -> Result<Self, SectionError> {
        // SAFETY: `handle` is a section handle we own; a null view is checked.
        let view = unsafe { MapViewOfFile(handle, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, len) };
        if view.Value.is_null() {
            let error = windows::core::Error::from_thread();
            // SAFETY: the handle is ours and not mapped.
            unsafe {
                let _ = CloseHandle(handle);
            }
            return Err(win32("MapViewOfFile", error));
        }
        Ok(Self {
            handle,
            view,
            len,
            already_existed,
        })
    }

    /// `true` when `create` reopened a section another instance had made
    /// (or `open` succeeded, which always means it existed).
    pub fn already_existed(&self) -> bool {
        self.already_existed
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The view as a ring region. Views are page aligned.
    pub fn region(&self) -> RingRegion {
        // SAFETY: the view stays mapped until this section drops, which the
        // owners of the returned region (the reader or writer that holds
        // the section beside it) never outlive.
        unsafe { RingRegion::from_raw(self.view.Value.cast(), self.len) }
    }
}

impl Drop for SharedSection {
    fn drop(&mut self) {
        // SAFETY: the view and the handle are ours and released once.
        unsafe {
            let _ = UnmapViewOfFile(self.view);
            let _ = CloseHandle(self.handle);
        }
    }
}
