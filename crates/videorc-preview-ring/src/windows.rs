//! Windows: the ring is a named file mapping backed by the page file
//! (`Local\videorc-preview-ring-<pid>-<generation>`), and the wake is a
//! named auto-reset event (`<name>-wake`) the writer sets after each publish.
//! Written for the Mac's `pnpm check:windows` (plan 220 S4.1d built on the
//! Linux box); the Windows PC runs it in its own slice.

use std::sync::atomic::AtomicU32;
use std::time::Duration;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Memory::{
    CreateFileMappingW, FILE_MAP_ALL_ACCESS, MEMORY_MAPPED_VIEW_ADDRESS, MapViewOfFile,
    OpenFileMappingW, PAGE_READWRITE, UnmapViewOfFile,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, EVENT_MODIFY_STATE, OpenEventW, SYNCHRONIZATION_SYNCHRONIZE, SetEvent,
    WaitForSingleObject,
};

use crate::{Region, RingError, RingHandle, RingInfo};

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

pub(crate) struct Mapping {
    ptr: *mut u8,
    len: usize,
    mapping: HANDLE,
}

// SAFETY: as on Linux, plain shared memory behind atomics and slices.
unsafe impl Send for Mapping {}
unsafe impl Sync for Mapping {}

impl Region for Mapping {
    fn ptr(&self) -> *mut u8 {
        self.ptr
    }

    fn len(&self) -> usize {
        self.len
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        // SAFETY: handles and views this module created.
        unsafe {
            UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS {
                Value: self.ptr.cast(),
            });
            CloseHandle(self.mapping);
        }
    }
}

pub(crate) struct Wake {
    event: HANDLE,
}

// SAFETY: an event handle is usable from any thread.
unsafe impl Send for Wake {}
unsafe impl Sync for Wake {}

impl Drop for Wake {
    fn drop(&mut self) {
        // SAFETY: the handle this module created or opened.
        unsafe {
            CloseHandle(self.event);
        }
    }
}

impl Wake {
    pub(crate) fn wake(&self, _word: &AtomicU32) {
        // SAFETY: a valid event handle.
        unsafe {
            SetEvent(self.event);
        }
    }

    pub(crate) fn wait(&self, word: &AtomicU32, expected: u32, timeout: Duration) {
        if word.load(std::sync::atomic::Ordering::SeqCst) != expected {
            return;
        }
        let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
        // SAFETY: a valid event handle; any return value sends the caller
        // back to re-read the ring.
        unsafe {
            WaitForSingleObject(self.event, millis);
        }
    }
}

fn mapping_name(generation: u64) -> String {
    format!(
        "Local\\videorc-preview-ring-{}-{generation}",
        std::process::id()
    )
}

pub(crate) fn create(info: &RingInfo) -> Result<(Mapping, RingHandle, Wake), RingError> {
    let name = mapping_name(info.generation);
    let len = usize::try_from(info.total_bytes)
        .map_err(|_| RingError::Dimensions(format!("{} bytes", info.total_bytes)))?;
    let name_wide = wide(&name);
    // SAFETY: a page-file-backed mapping of the planned size.
    let mapping = unsafe {
        CreateFileMappingW(
            INVALID_HANDLE_VALUE,
            std::ptr::null(),
            PAGE_READWRITE,
            (info.total_bytes >> 32) as u32,
            (info.total_bytes & 0xffff_ffff) as u32,
            name_wide.as_ptr(),
        )
    };
    if mapping.is_null() {
        return Err(RingError::Io(std::io::Error::last_os_error()));
    }
    // SAFETY: a view of the whole mapping.
    let ptr = unsafe { MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, len) }.Value;
    if ptr.is_null() {
        let error = std::io::Error::last_os_error();
        // SAFETY: the handle created above.
        unsafe {
            CloseHandle(mapping);
        }
        return Err(RingError::Io(error));
    }
    let wake_name = wide(&format!("{name}-wake"));
    // SAFETY: a named auto-reset event, initially unset.
    let event = unsafe { CreateEventW(std::ptr::null(), 0, 0, wake_name.as_ptr()) };
    if event.is_null() {
        let error = std::io::Error::last_os_error();
        // SAFETY: the view and handle created above.
        unsafe {
            UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: ptr });
            CloseHandle(mapping);
        }
        return Err(RingError::Io(error));
    }
    let handle = RingHandle {
        kind: "file-mapping",
        name,
        bytes: info.total_bytes,
    };
    Ok((
        Mapping {
            ptr: ptr.cast(),
            len,
            mapping,
        },
        handle,
        Wake { event },
    ))
}

pub(crate) fn open(handle: &RingHandle) -> Result<(Mapping, Wake), RingError> {
    if handle.kind != "file-mapping" {
        return Err(RingError::Unsupported(
            "a Windows reader opens file mappings only",
        ));
    }
    let len = usize::try_from(handle.bytes)
        .map_err(|_| RingError::Dimensions(format!("{} bytes", handle.bytes)))?;
    let name_wide = wide(&handle.name);
    // SAFETY: opening the named mapping the writer created.
    let mapping = unsafe { OpenFileMappingW(FILE_MAP_ALL_ACCESS, 0, name_wide.as_ptr()) };
    if mapping.is_null() {
        return Err(RingError::Io(std::io::Error::last_os_error()));
    }
    // SAFETY: a view of `len` bytes, the size the handle carries.
    let ptr = unsafe { MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, len) }.Value;
    if ptr.is_null() {
        let error = std::io::Error::last_os_error();
        // SAFETY: the handle opened above.
        unsafe {
            CloseHandle(mapping);
        }
        return Err(RingError::Io(error));
    }
    let wake_name = wide(&format!("{}-wake", handle.name));
    // SAFETY: opening the writer's event for waiting.
    let event = unsafe {
        OpenEventW(
            SYNCHRONIZATION_SYNCHRONIZE | EVENT_MODIFY_STATE,
            0,
            wake_name.as_ptr(),
        )
    };
    if event.is_null() {
        let error = std::io::Error::last_os_error();
        // SAFETY: the view and handle opened above.
        unsafe {
            UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: ptr });
            CloseHandle(mapping);
        }
        return Err(RingError::Io(error));
    }
    Ok((
        Mapping {
            ptr: ptr.cast(),
            len,
            mapping,
        },
        Wake { event },
    ))
}

pub(crate) fn now_micros() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_micros() as u64
}
