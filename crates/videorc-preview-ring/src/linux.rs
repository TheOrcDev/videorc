//! Linux: the ring is a `memfd`, handed over as its `/proc/<pid>/fd/<n>`
//! path (the app runs as the same user and opens it read-write for the
//! lease word); the wake is a futex on the header's `wake` word, shared
//! between the two processes because the mapping is `MAP_SHARED`.

use std::ffi::CString;
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::sync::atomic::AtomicU32;
use std::time::Duration;

use crate::{Region, RingError, RingHandle, RingInfo};

pub(crate) struct Mapping {
    ptr: *mut u8,
    len: usize,
    _fd: OwnedFd,
}

// SAFETY: the mapping is plain shared memory; every access goes through the
// atomics and slices `lib.rs` hands out, which carry their own rules.
unsafe impl Send for Mapping {}
unsafe impl Sync for Mapping {}

impl Mapping {
    /// The memory file's descriptor: a consumer that maps the region itself
    /// (a `wl_shm` pool, an X11 shared segment) borrows it.
    pub(crate) fn fd(&self) -> std::os::fd::BorrowedFd<'_> {
        self._fd.as_fd()
    }
}

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
        // SAFETY: `ptr`/`len` came from a successful `mmap` below.
        unsafe {
            libc::munmap(self.ptr.cast(), self.len);
        }
    }
}

/// The futex: nothing to own, the word lives in the header.
pub(crate) struct Wake;

impl Wake {
    pub(crate) fn wake(&self, word: &AtomicU32) {
        // SAFETY: a futex call on a word inside a live mapping; it reads
        // nothing else and cannot fault.
        unsafe {
            libc::syscall(
                libc::SYS_futex,
                word.as_ptr(),
                libc::FUTEX_WAKE,
                i32::MAX,
                std::ptr::null::<libc::timespec>(),
            );
        }
    }

    /// Sleeps while `word` still reads `expected`, at most `timeout`.
    pub(crate) fn wait(&self, word: &AtomicU32, expected: u32, timeout: Duration) {
        let timeout = libc::timespec {
            tv_sec: timeout.as_secs().min(i64::MAX as u64) as libc::time_t,
            tv_nsec: libc::c_long::from(timeout.subsec_nanos()),
        };
        // SAFETY: as above; a changed word, a wake, a signal or the timeout
        // all return, and the caller re-reads the state.
        unsafe {
            libc::syscall(
                libc::SYS_futex,
                word.as_ptr(),
                libc::FUTEX_WAIT,
                expected,
                &timeout as *const libc::timespec,
            );
        }
    }
}

fn map(fd: &OwnedFd, len: usize) -> Result<*mut u8, RingError> {
    // SAFETY: a fresh shared mapping of `len` bytes of the file `fd`.
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

pub(crate) fn create(info: &RingInfo) -> Result<(Mapping, RingHandle, Wake), RingError> {
    let name = CString::new(format!("videorc-preview-ring-{}", info.generation))
        .map_err(|error| RingError::Layout(error.to_string()))?;
    // SAFETY: `memfd_create` with a valid C string and known flags.
    let raw =
        unsafe { libc::memfd_create(name.as_ptr(), libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING) };
    if raw < 0 {
        return Err(RingError::Io(std::io::Error::last_os_error()));
    }
    // SAFETY: `raw` is the fd `memfd_create` just returned, owned by nobody else.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    let len = usize::try_from(info.total_bytes)
        .map_err(|_| RingError::Dimensions(format!("{} bytes", info.total_bytes)))?;
    // SAFETY: plain fd calls on the memfd.
    unsafe {
        if libc::ftruncate(fd.as_raw_fd(), len as libc::off_t) != 0 {
            return Err(RingError::Io(std::io::Error::last_os_error()));
        }
        // The size is final: a reader that maps `total_bytes` can never fault.
        libc::fcntl(
            fd.as_raw_fd(),
            libc::F_ADD_SEALS,
            libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_SEAL,
        );
    }
    let ptr = map(&fd, len)?;
    let handle = RingHandle {
        kind: "memfd-path",
        name: format!("/proc/{}/fd/{}", std::process::id(), fd.as_raw_fd()),
        bytes: info.total_bytes,
    };
    Ok((Mapping { ptr, len, _fd: fd }, handle, Wake))
}

pub(crate) fn open(handle: &RingHandle) -> Result<(Mapping, Wake), RingError> {
    if handle.kind != "memfd-path" {
        return Err(RingError::Unsupported(
            "a Linux reader opens memfd paths only",
        ));
    }
    let path =
        CString::new(handle.name.as_str()).map_err(|error| RingError::Layout(error.to_string()))?;
    // SAFETY: `open` with a valid C string.
    let raw = unsafe { libc::open(path.as_ptr(), libc::O_RDWR | libc::O_CLOEXEC) };
    if raw < 0 {
        return Err(RingError::Io(std::io::Error::last_os_error()));
    }
    // SAFETY: the fd `open` just returned.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    // SAFETY: `fstat` into a zeroed struct.
    let size = unsafe {
        let mut stat: libc::stat = std::mem::zeroed();
        if libc::fstat(fd.as_raw_fd(), &mut stat) != 0 {
            return Err(RingError::Io(std::io::Error::last_os_error()));
        }
        stat.st_size
    };
    let size = u64::try_from(size).unwrap_or(0);
    if size < handle.bytes {
        return Err(RingError::Layout(format!(
            "the memory file is {size} bytes, the handle says {}",
            handle.bytes
        )));
    }
    let len = usize::try_from(handle.bytes)
        .map_err(|_| RingError::Dimensions(format!("{} bytes", handle.bytes)))?;
    let ptr = map(&fd, len)?;
    Ok((Mapping { ptr, len, _fd: fd }, Wake))
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
