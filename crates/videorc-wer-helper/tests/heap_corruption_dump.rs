//! End to end on a real Windows Error Reporting service: a child process
//! registers the built helper DLL, corrupts its heap (the field crash's
//! 0xC0000374), and the test waits for `videorc-backend-<pid>-wer.dmp`.
//!
//! Ignored by default: it needs WER enabled on the host, crashes a process
//! on purpose, and writes an HKCU value it removes again. Run it with
//! `cargo test -p videorc-wer-helper --test heap_corruption_dump -- --ignored`
//! after `cargo build -p videorc-wer-helper` built the DLL.
#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use videorc_wer_helper::{HELPER_DLL_NAME, forget_helper_module, helper_dump_file_name, register};
use windows::Win32::System::Memory::{GetProcessHeap, HEAP_FLAGS, HeapAlloc, HeapFree};

const CHILD_DIR_ENV: &str = "VIDEORC_WER_HELPER_TEST_DUMP_DIR";
const STATUS_HEAP_CORRUPTION: u32 = 0xC000_0374;

fn helper_dll() -> PathBuf {
    let deps = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let profile = deps.parent().unwrap().to_path_buf();
    [profile.join(HELPER_DLL_NAME), deps.join(HELPER_DLL_NAME)]
        .into_iter()
        .find(|path| path.is_file())
        .unwrap_or_else(|| {
            panic!(
                "{HELPER_DLL_NAME} is not built next to {}; run `cargo build -p videorc-wer-helper` first",
                deps.display()
            )
        })
}

/// The child half: register, then free one heap block twice.
fn corrupt_heap_after_registering(dump_dir: &Path) -> ! {
    // `cargo test` hands this child error mode 0x3; registering must clear
    // SEM_NOGPFAULTERRORBOX or WER never reports the crash.
    let inherited = register(&helper_dll(), dump_dir).expect("register the WER helper");
    eprintln!("child inherited error mode {inherited:#x}");
    // SAFETY: deliberately invalid; this process exists to die of it.
    unsafe {
        let heap = GetProcessHeap().unwrap();
        let block = HeapAlloc(heap, HEAP_FLAGS(0), 64);
        let _ = HeapFree(heap, HEAP_FLAGS(0), Some(block));
        let _ = HeapFree(heap, HEAP_FLAGS(0), Some(block));
    }
    // Only reached when the heap did not notice the double free.
    std::process::exit(3);
}

#[test]
#[ignore = "crashes a process and needs the WER service; run with --ignored"]
fn a_heap_corruption_crash_leaves_a_helper_dump() {
    if let Some(dir) = std::env::var_os(CHILD_DIR_ENV) {
        corrupt_heap_after_registering(Path::new(&dir));
    }
    let dump_dir = std::env::temp_dir().join(format!("videorc-wer-helper-{}", std::process::id()));
    std::fs::create_dir_all(&dump_dir).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "a_heap_corruption_crash_leaves_a_helper_dump",
            "--nocapture",
        ])
        .env(CHILD_DIR_ENV, &dump_dir)
        .spawn()
        .unwrap();
    let pid = child.id();
    let status = child.wait().unwrap();
    let dump = dump_dir.join(helper_dump_file_name(pid));
    let deadline = Instant::now() + Duration::from_secs(60);
    while !dump.metadata().is_ok_and(|metadata| metadata.len() > 0) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
    }
    let _ = forget_helper_module(&helper_dll());
    assert_eq!(
        status.code().map(|code| code as u32),
        Some(STATUS_HEAP_CORRUPTION),
        "the child must die of heap corruption"
    );
    let size = dump.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    assert!(size > 0, "no helper dump at {}", dump.display());
    let bytes = std::fs::read(&dump).unwrap();
    assert_eq!(
        minidump_exception_code(&bytes),
        Some(STATUS_HEAP_CORRUPTION),
        "the dump must carry the crash's exception record"
    );
    let _ = std::fs::remove_dir_all(&dump_dir);
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

/// `MINIDUMP_EXCEPTION_STREAM.ExceptionRecord.ExceptionCode`, read from the
/// header's stream directory (minidumpapiset.h layout).
fn minidump_exception_code(bytes: &[u8]) -> Option<u32> {
    const SIGNATURE: u32 = u32::from_le_bytes(*b"MDMP");
    const EXCEPTION_STREAM: u32 = 6;
    if read_u32(bytes, 0)? != SIGNATURE {
        return None;
    }
    let streams = read_u32(bytes, 8)? as usize;
    let directory = read_u32(bytes, 12)? as usize;
    (0..streams).find_map(|index| {
        let entry = directory + index * 12;
        (read_u32(bytes, entry)? == EXCEPTION_STREAM)
            // ThreadId, alignment, then the record's ExceptionCode.
            .then(|| read_u32(bytes, read_u32(bytes, entry + 8)? as usize + 8))
            .flatten()
    })
}
