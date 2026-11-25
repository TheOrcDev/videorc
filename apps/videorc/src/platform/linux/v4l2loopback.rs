//! Videorc Camera's Load module (P674): `pkexec modprobe v4l2loopback …`
//! with an argv array, never a shell, stdin closed at once, every outcome
//! as data (`nodeLoadModuleExec`). The words are the core's
//! (`videorc_app_core::desktop::linux::v4l2loopback`).

use std::io::Read;
use std::os::unix::process::ExitStatusExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use videorc_app_core::desktop::linux::v4l2loopback::{
    self as v4l2, LoadResult, PKEXEC, Run, SpawnError, TIMEOUT,
};

const POLL: Duration = Duration::from_millis(100);

/// Runs the load and reads the outcome. Blocks until polkit's dialog is
/// answered (at most [`TIMEOUT`]): call it off the main thread.
pub fn load_module() -> LoadResult {
    v4l2::classify(&run())
}

fn signal_name(signal: i32) -> String {
    match signal {
        1 => "SIGHUP".into(),
        2 => "SIGINT".into(),
        9 => "SIGKILL".into(),
        15 => "SIGTERM".into(),
        other => format!("signal {other}"),
    }
}

fn run() -> Run {
    let mut child = match Command::new(PKEXEC)
        .args(v4l2::load_args())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return Run {
                spawn_error: Some(if error.kind() == std::io::ErrorKind::NotFound {
                    SpawnError::NotFound
                } else {
                    SpawnError::Other(format!("{:?}", error.kind()))
                }),
                ..Run::default()
            };
        }
    };
    let reader = child.stderr.take().map(|mut stderr| {
        std::thread::spawn(move || {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text);
            text
        })
    });
    let started = Instant::now();
    let (status, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (Some(status), false),
            Ok(None) if started.elapsed() >= TIMEOUT => {
                // Only this child, by its handle.
                let _ = child.kill();
                break (child.wait().ok(), true);
            }
            Ok(None) => std::thread::sleep(POLL),
            Err(_) => break (None, false),
        }
    };
    let stderr = reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    Run {
        spawn_error: None,
        exit_code: status.and_then(|status| status.code()),
        signal: status.and_then(|status| status.signal()).map(signal_name),
        timed_out,
        stderr,
    }
}
