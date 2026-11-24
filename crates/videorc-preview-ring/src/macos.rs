//! macOS (plan 260 S1.7): the ring is a POSIX shared memory object
//! (`shm_open`), handed over by name (`posix-shm`; owner-only, mode 0600,
//! so only the same user opens it). The writer unlinks the name when its
//! mapping drops; a reader that mapped it before keeps the memory.
//!
//! The wake: macOS has no futex a stable API offers across processes, so
//! the reader looks at the header's `wake` word every [`POLL`] until it
//! moves or the timeout passes. That is a few microseconds of work per
//! look and at most [`POLL`] of added latency; the writer has nothing to
//! signal. (The macOS Preview itself is the native surface on the
//! backend's IOSurface; this ring is route (d) and the readers' producer.)

use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use crate::{Region, RingError, RingHandle, RingInfo};

/// How often a waiting reader looks at the wake word.
const POLL: Duration = Duration::from_millis(2);

pub(crate) struct Mapping {
    ptr: *mut u8,
    len: usize,
    _fd: OwnedFd,
    /// The writer's own object: its name is unlinked when the mapping drops.
    unlink: Option<CString>,
}

// SAFETY: the mapping is plain shared memory; every access goes through the
// atomics and slices `lib.rs` hands out, which carry their own rules.
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
        // SAFETY: `ptr`/`len` came from a successful `mmap` below; the name
        // is the one `create` opened.
        unsafe {
            libc::munmap(self.ptr.cast(), self.len);
            if let Some(name) = self.unlink.as_ref() {
                libc::shm_unlink(name.as_ptr());
            }
        }
    }
}

/// The poll: nothing to own, the word lives in the header.
pub(crate) struct Wake;

impl Wake {
    pub(crate) fn wake(&self, _word: &AtomicU32) {}

    /// Returns once `word` no longer reads `expected`, or after `timeout`.
    pub(crate) fn wait(&self, word: &AtomicU32, expected: u32, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        loop {
            if word.load(Ordering::SeqCst) != expected {
                return;
            }
            let now = Instant::now();
            if now >= deadline {
                return;
            }
            std::thread::sleep((deadline - now).min(POLL));
        }
    }
}

fn map(fd: &OwnedFd, len: usize) -> Result<*mut u8, RingError> {
    // SAFETY: a fresh shared mapping of `len` bytes of the object `fd`.
    let ptr = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            len,
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_SHARED,
            fd.as_raw_fd(),
            0,
        )
    };
    if ptr == libc::MAP_FAILED {
        return Err(RingError::Io(std::io::Error::last_os_error()));
    }
    Ok(ptr.cast())
}

/// `shm_open` with a mode (the C function is variadic; the mode goes as an
/// unsigned int, as C's default promotion passes it).
fn shm_open(name: &CString, flags: libc::c_int) -> std::io::Result<OwnedFd> {
    // SAFETY: a valid C string, known flags, and the mode as the variadic
    // argument.
    let raw = unsafe { libc::shm_open(name.as_ptr(), flags, 0o600 as libc::c_uint) };
    if raw < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: the fd `shm_open` just returned, owned by nobody else.
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}

pub(crate) fn create(info: &RingInfo) -> Result<(Mapping, RingHandle, Wake), RingError> {
    // macOS names are at most 31 bytes (PSHMNAMLEN): "/vrcring.<pid>.<gen>".
    let name = CString::new(format!(
        "/vrcring.{}.{}",
        std::process::id(),
        info.generation
    ))
    .map_err(|error| RingError::Layout(error.to_string()))?;
    let flags = libc::O_RDWR | libc::O_CREAT | libc::O_EXCL;
    let fd = match shm_open(&name, flags) {
        Ok(fd) => fd,
        // A name left by a backend that crashed with the same process id.
        Err(error) if error.raw_os_error() == Some(libc::EEXIST) => {
            // SAFETY: unlinking a name this process is about to own.
            unsafe {
                libc::shm_unlink(name.as_ptr());
            }
            shm_open(&name, flags)?
        }
        Err(error) => return Err(RingError::Io(error)),
    };
    let len = usize::try_from(info.total_bytes)
        .map_err(|_| RingError::Dimensions(format!("{} bytes", info.total_bytes)))?;
    // SAFETY: a plain fd call on the new object (macOS sizes it once).
    if unsafe { libc::ftruncate(fd.as_raw_fd(), len as libc::off_t) } != 0 {
        let error = std::io::Error::last_os_error();
        // SAFETY: the name this call created.
        unsafe {
            libc::shm_unlink(name.as_ptr());
        }
        return Err(RingError::Io(error));
    }
    let ptr = match map(&fd, len) {
        Ok(ptr) => ptr,
        Err(error) => {
            // SAFETY: the name this call created.
            unsafe {
                libc::shm_unlink(name.as_ptr());
            }
            return Err(error);
        }
    };
    let handle = RingHandle {
        kind: "posix-shm",
        name: name.to_string_lossy().into_owned(),
        bytes: info.total_bytes,
    };
    Ok((
        Mapping {
            ptr,
            len,
            _fd: fd,
            unlink: Some(name),
        },
        handle,
        Wake,
    ))
}

pub(crate) fn open(handle: &RingHandle) -> Result<(Mapping, Wake), RingError> {
    if handle.kind != "posix-shm" {
        return Err(RingError::Unsupported(
            "a macOS reader opens posix-shm names only",
        ));
    }
    let name =
        CString::new(handle.name.as_str()).map_err(|error| RingError::Layout(error.to_string()))?;
    let fd = shm_open(&name, libc::O_RDWR)?;
    // SAFETY: `fstat` into a zeroed struct.
    let size = unsafe {
        let mut stat: libc::stat = std::mem::zeroed();
        if libc::fstat(fd.as_raw_fd(), &mut stat) != 0 {
            return Err(RingError::Io(std::io::Error::last_os_error()));
        }
        stat.st_size
    };
    // macOS rounds the object up to a page; it is never smaller.
    let size = u64::try_from(size).unwrap_or(0);
    if size < handle.bytes {
        return Err(RingError::Layout(format!(
            "the shared memory object is {size} bytes, the handle says {}",
            handle.bytes
        )));
    }
    let len = usize::try_from(handle.bytes)
        .map_err(|_| RingError::Dimensions(format!("{} bytes", handle.bytes)))?;
    let ptr = map(&fd, len)?;
    Ok((
        Mapping {
            ptr,
            len,
            _fd: fd,
            unlink: None,
        },
        Wake,
    ))
}

pub(crate) fn now_micros() -> u64 {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: `clock_gettime` into a local.
    unsafe {
        libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts);
    }
    (ts.tv_sec as u64) * 1_000_000 + (ts.tv_nsec as u64) / 1000
}
