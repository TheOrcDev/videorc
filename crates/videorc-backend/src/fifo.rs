//! FIFO transport between native capture threads and the ffmpeg readers.
//!
//! Unix uses filesystem FIFOs (`mkfifo`); Windows uses named pipes in the
//! `\\.\pipe\` namespace. Both arms share one contract, pinned by the tests
//! at the bottom of this file: `transport_path` → `create` →
//! `open_writer(retry/stop)` → blocking writes once a reader attaches →
//! `cleanup`. Platforms without either primitive get `Unsupported` stubs so
//! callers fail with a clear runtime message instead of the crate failing to
//! compile.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

/// Where a FIFO transport endpoint lives for `file_name` on this platform:
/// a temp-dir path on Unix (`mkfifo` target), a named-pipe name on Windows.
/// Callers pass the returned path verbatim to ffmpeg (`-i <path>` / output
/// path) and to `create`/`open_writer`/`cleanup`.
pub fn transport_path(file_name: &str) -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(format!(r"\\.\pipe\{file_name}"))
    }
    #[cfg(not(windows))]
    {
        std::env::temp_dir().join(file_name)
    }
}

/// Removes a stale transport endpoint (or the live one during session
/// teardown). Missing endpoints are not an error: teardown paths call this
/// unconditionally.
#[cfg(unix)]
pub fn cleanup(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
pub fn create(path: &Path) -> io::Result<()> {
    use std::ffi::CString;

    let c_path = CString::new(path.display().to_string()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "FIFO path contained an interior NUL byte",
        )
    })?;
    let status = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Opens the FIFO for writing without blocking on a reader, retrying every
/// `retry` until one attaches or `stop` flips. `clear_nonblock` restores
/// blocking writes once the reader is attached.
#[cfg(unix)]
pub fn open_writer(
    path: &Path,
    stop: &AtomicBool,
    retry: Duration,
    clear_nonblock: bool,
    stopped_message: &str,
) -> io::Result<File> {
    use std::ffi::CString;
    use std::os::fd::FromRawFd;
    use std::sync::atomic::Ordering;

    let c_path = CString::new(path.display().to_string())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid FIFO path"))?;

    while !stop.load(Ordering::Relaxed) {
        let fd = unsafe { libc::open(c_path.as_ptr(), libc::O_WRONLY | libc::O_NONBLOCK) };
        if fd >= 0 {
            if clear_nonblock {
                let _ = unsafe { libc::fcntl(fd, libc::F_SETFL, 0) };
            }
            return Ok(unsafe { File::from_raw_fd(fd) });
        }

        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ENXIO) {
            return Err(error);
        }
        std::thread::sleep(retry);
    }

    Err(io::Error::new(io::ErrorKind::Interrupted, stopped_message))
}

/// Named-pipe server instances created by `create`, waiting for `open_writer`
/// to claim them. A named pipe's server end IS the handle returned at
/// creation — unlike a filesystem FIFO it cannot be reopened by path later —
/// so the handle parks here between the two calls. Entries are removed by
/// `open_writer` (claimed) or `cleanup` (session teardown / stale path);
/// dropping the handle closes the pipe.
#[cfg(windows)]
fn pipe_registry()
-> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, std::os::windows::io::OwnedHandle>>
{
    use std::collections::HashMap;
    use std::os::windows::io::OwnedHandle;
    use std::sync::{Mutex, OnceLock};

    static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, OwnedHandle>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Byte-type pipe buffer sized to hold one 1080p BGRA overlay frame (~8.3 MiB)
/// with headroom. A 4K RGBA frame is ~33 MiB and intentionally exceeds this
/// advisory quota, so bounded media writers must finish frames across partial
/// and transient zero-byte writes instead of assuming one write is atomic.
#[cfg(any(test, windows))]
pub(crate) const PIPE_OUT_BUFFER_BYTES: u32 = 16 * 1024 * 1024;

#[cfg(windows)]
pub fn create(path: &Path) -> io::Result<()> {
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use windows::Win32::Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_OUTBOUND,
    };
    use windows::Win32::System::Pipes::{
        CreateNamedPipeW, PIPE_NOWAIT, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE,
    };
    use windows::core::HSTRING;

    let name = path.display().to_string();
    if !name.starts_with(r"\\.\pipe\") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "Windows FIFO paths must live in the named-pipe namespace (\\\\.\\pipe\\...); got {name}"
            ),
        ));
    }

    {
        let mut registry = pipe_registry()
            .lock()
            .map_err(|_| io::Error::other("named-pipe registry lock poisoned"))?;
        // The stale server handle must be closed before CreateNamedPipeW runs:
        // FILE_FLAG_FIRST_PIPE_INSTANCE checks existing OS pipe instances, so
        // replacing the map entry after creation still leaves the old handle
        // busy long enough for Windows to reject the replacement.
        drop(registry.remove(path));
    }

    // PIPE_NOWAIT so `open_writer` can poll ConnectNamedPipe against the
    // stop flag; it flips the handle back to blocking once a reader attaches.
    let handle = unsafe {
        CreateNamedPipeW(
            &HSTRING::from(name.as_str()),
            PIPE_ACCESS_OUTBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT,
            1,
            PIPE_OUT_BUFFER_BYTES,
            0,
            0,
            None,
        )
    };
    if handle.is_invalid() {
        return Err(io::Error::last_os_error());
    }
    let owned = unsafe { OwnedHandle::from_raw_handle(handle.0 as _) };

    let mut registry = pipe_registry()
        .lock()
        .map_err(|_| io::Error::other("named-pipe registry lock poisoned"))?;
    registry.insert(path.to_path_buf(), owned);
    Ok(())
}

#[cfg(windows)]
pub fn open_writer(
    path: &Path,
    stop: &AtomicBool,
    retry: Duration,
    clear_nonblock: bool,
    stopped_message: &str,
) -> io::Result<File> {
    use std::os::windows::io::AsRawHandle;
    use std::sync::atomic::Ordering;
    use windows::Win32::Foundation::{ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING, HANDLE};
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, PIPE_NOWAIT, PIPE_READMODE_BYTE, PIPE_WAIT,
    };

    let owned = {
        let mut registry = pipe_registry()
            .lock()
            .map_err(|_| io::Error::other("named-pipe registry lock poisoned"))?;
        registry.remove(path)
    }
    .ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "named pipe {} was not created before opening its writer",
                path.display()
            ),
        )
    })?;
    let handle = HANDLE(owned.as_raw_handle());

    loop {
        if stop.load(Ordering::Relaxed) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, stopped_message));
        }
        match unsafe { ConnectNamedPipe(handle, None) } {
            Ok(()) => break,
            Err(error) if error.code() == ERROR_PIPE_CONNECTED.to_hresult() => break,
            Err(error) if error.code() == ERROR_PIPE_LISTENING.to_hresult() => {
                std::thread::sleep(retry);
            }
            Err(error) => return Err(io::Error::other(error)),
        }
    }

    // Bounded media writers keep PIPE_NOWAIT so cancellation/deadline checks
    // remain observable when FFmpeg stops draining. Windows reports a full
    // byte pipe as a zero-byte write; their write loop treats that as transient
    // pressure until its explicit deadline. Other FIFO users retain blocking
    // behavior through `clear_nonblock = true`.
    let wait_mode = if clear_nonblock {
        PIPE_WAIT
    } else {
        PIPE_NOWAIT
    };
    let mode = PIPE_READMODE_BYTE | wait_mode;
    unsafe { SetNamedPipeHandleStateChecked(handle, mode) }?;

    Ok(File::from(owned))
}

/// Thin wrapper so the mode switch reads as one fallible step above.
///
/// # Safety
/// `handle` must be a valid named-pipe handle owned by the caller.
#[cfg(windows)]
#[allow(non_snake_case)]
unsafe fn SetNamedPipeHandleStateChecked(
    handle: windows::Win32::Foundation::HANDLE,
    mode: windows::Win32::System::Pipes::NAMED_PIPE_MODE,
) -> io::Result<()> {
    use windows::Win32::System::Pipes::SetNamedPipeHandleState;

    unsafe { SetNamedPipeHandleState(handle, Some(&mode), None, None) }.map_err(io::Error::other)
}

#[cfg(windows)]
pub fn cleanup(path: &Path) -> io::Result<()> {
    let mut registry = pipe_registry()
        .lock()
        .map_err(|_| io::Error::other("named-pipe registry lock poisoned"))?;
    registry.remove(path);
    Ok(())
}

#[cfg(not(any(unix, windows)))]
pub fn create(path: &Path) -> io::Result<()> {
    let _ = path;
    Err(unsupported())
}

#[cfg(not(any(unix, windows)))]
pub fn open_writer(
    path: &Path,
    stop: &AtomicBool,
    retry: Duration,
    clear_nonblock: bool,
    stopped_message: &str,
) -> io::Result<File> {
    let _ = (path, stop, retry, clear_nonblock, stopped_message);
    Err(unsupported())
}

#[cfg(not(any(unix, windows)))]
pub fn cleanup(path: &Path) -> io::Result<()> {
    let _ = path;
    Err(unsupported())
}

#[cfg(not(any(unix, windows)))]
fn unsupported() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "FIFO transport is not implemented on this platform",
    )
}

#[cfg(test)]
mod transport_path_tests {
    use super::*;

    #[test]
    fn transport_path_keeps_the_file_name() {
        let path = transport_path("videorc-fifo-naming-probe.yuv");
        assert!(
            path.display()
                .to_string()
                .ends_with("videorc-fifo-naming-probe.yuv"),
            "endpoint must be addressable by its file name: {}",
            path.display()
        );
    }

    #[cfg(windows)]
    #[test]
    fn transport_path_lives_in_the_pipe_namespace_on_windows() {
        let path = transport_path("videorc-fifo-naming-probe.yuv");
        assert_eq!(
            path.display().to_string(),
            r"\\.\pipe\videorc-fifo-naming-probe.yuv"
        );
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_tolerates_missing_paths() {
        let path = transport_path("videorc-fifo-cleanup-missing-probe");
        let _ = std::fs::remove_file(&path);
        cleanup(&path).expect("cleanup of a missing endpoint must be a no-op");
    }
}

// These cases define the behavioral contract both platform arms must match:
// create → open_writer(retry/stop) → blocking writes once a reader attaches.
#[cfg(all(test, unix))]
mod tests {
    use std::io::Read;
    use std::io::Write;
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;

    use super::*;

    fn temp_fifo_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("videorc-fifo-test-{name}-{}", std::process::id()))
    }

    #[test]
    fn create_makes_a_fifo_with_owner_only_mode() {
        let path = temp_fifo_path("create");
        let _ = std::fs::remove_file(&path);

        create(&path).expect("create should succeed on a fresh path");

        let metadata = std::fs::metadata(&path).expect("fifo metadata");
        assert!(metadata.file_type().is_fifo(), "path must be a FIFO");
        assert_eq!(
            metadata.permissions().mode() & 0o777,
            0o600,
            "FIFO must be owner-only"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn create_fails_on_existing_path() {
        let path = temp_fifo_path("create-existing");
        let _ = std::fs::remove_file(&path);

        create(&path).expect("first create succeeds");
        assert!(
            create(&path).is_err(),
            "second create on the same path must fail (callers remove stale FIFOs themselves)"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn open_writer_returns_interrupted_when_stopped() {
        let path = temp_fifo_path("stopped");
        let stop = AtomicBool::new(true);

        let error = open_writer(
            &path,
            &stop,
            Duration::from_millis(1),
            true,
            "writer stopped before FIFO opened",
        )
        .expect_err("a pre-stopped writer must not open");

        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
        assert_eq!(error.to_string(), "writer stopped before FIFO opened");
    }

    #[test]
    fn open_writer_connects_once_a_reader_attaches() {
        let path = temp_fifo_path("connect");
        let _ = std::fs::remove_file(&path);
        create(&path).expect("create fifo");

        let reader_path = path.clone();
        let reader = std::thread::spawn(move || {
            let mut file = std::fs::File::open(reader_path).expect("reader open");
            let mut buffer = [0u8; 4];
            file.read_exact(&mut buffer).expect("reader read");
            buffer
        });

        let stop = AtomicBool::new(false);
        let mut writer = open_writer(
            &path,
            &stop,
            Duration::from_millis(5),
            true,
            "writer stopped before FIFO opened",
        )
        .expect("writer opens once the reader is attached");
        writer.write_all(b"ping").expect("write to fifo");
        drop(writer);

        assert_eq!(&reader.join().expect("reader thread"), b"ping");
        stop.store(true, Ordering::Relaxed);

        let _ = std::fs::remove_file(&path);
    }
}

// The Windows twin of the contract above. These run on a Windows host (or
// under `cargo xwin test`); on macOS/Linux they are compiled out. The reader
// side opens the pipe by name exactly the way ffmpeg's file protocol does
// (CreateFile on `\\.\pipe\...`).
#[cfg(all(test, windows))]
mod windows_tests {
    use std::io::Read;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;

    use super::*;

    fn test_pipe_path(name: &str) -> PathBuf {
        transport_path(&format!("videorc-fifo-test-{name}-{}", std::process::id()))
    }

    #[test]
    fn open_writer_returns_interrupted_when_stopped() {
        let path = test_pipe_path("stopped");
        create(&path).expect("create pipe");
        let stop = AtomicBool::new(true);

        let error = open_writer(
            &path,
            &stop,
            Duration::from_millis(1),
            true,
            "writer stopped before FIFO opened",
        )
        .expect_err("a pre-stopped writer must not open");

        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
        assert_eq!(error.to_string(), "writer stopped before FIFO opened");
        cleanup(&path).expect("cleanup");
    }

    #[test]
    fn open_writer_requires_create_first() {
        let path = test_pipe_path("uncreated");
        let stop = AtomicBool::new(false);

        let error = open_writer(
            &path,
            &stop,
            Duration::from_millis(1),
            true,
            "writer stopped before FIFO opened",
        )
        .expect_err("a writer without a created pipe must not open");
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn open_writer_connects_once_a_reader_attaches() {
        let path = test_pipe_path("connect");
        create(&path).expect("create pipe");

        let reader_path = path.clone();
        let reader = std::thread::spawn(move || {
            // Retry: the reader may race ahead of ConnectNamedPipe polling.
            let mut file = loop {
                match std::fs::File::open(&reader_path) {
                    Ok(file) => break file,
                    Err(_) => std::thread::sleep(Duration::from_millis(5)),
                }
            };
            let mut buffer = [0u8; 4];
            file.read_exact(&mut buffer).expect("reader read");
            buffer
        });

        let stop = AtomicBool::new(false);
        let mut writer = open_writer(
            &path,
            &stop,
            Duration::from_millis(5),
            false,
            "writer stopped before FIFO opened",
        )
        .expect("writer opens once the reader is attached");
        writer.write_all(b"ping").expect("write to pipe");
        drop(writer);

        assert_eq!(&reader.join().expect("reader thread"), b"ping");
        stop.store(true, Ordering::Relaxed);
        cleanup(&path).expect("cleanup");
    }

    #[test]
    fn create_replaces_a_stale_pipe_for_the_same_path() {
        let path = test_pipe_path("stale");
        create(&path).expect("first create");
        create(&path).expect("re-create must replace the stale server instance");
        cleanup(&path).expect("cleanup");
    }
}
