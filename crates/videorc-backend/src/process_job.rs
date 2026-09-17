use std::io::{self, Read};
use std::process::{
    Child as StdChild, Command as StdCommand, ExitStatus, Output as ProcessOutput, Stdio,
};
use std::time::{Duration, Instant};

use tokio::process::{Child as TokioChild, Command as TokioCommand};

pub fn spawn_owned_tokio(command: &mut TokioCommand) -> io::Result<TokioChild> {
    let mut child = command.spawn()?;
    if let Err(error) = assign_tokio_child(&child) {
        let _ = child.start_kill();
        return Err(error);
    }
    Ok(child)
}

pub fn spawn_owned_std(command: &mut StdCommand) -> io::Result<StdChild> {
    let mut child = command.spawn()?;
    if let Err(error) = assign_std_child(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok(child)
}

pub async fn output_owned_tokio(command: &mut TokioCommand) -> io::Result<ProcessOutput> {
    spawn_owned_tokio(command)?.wait_with_output().await
}

pub async fn status_owned_tokio(command: &mut TokioCommand) -> io::Result<ExitStatus> {
    let mut child = spawn_owned_tokio(command)?;
    child.wait().await
}

pub fn output_owned_std(command: &mut StdCommand) -> io::Result<ProcessOutput> {
    spawn_owned_std(command)?.wait_with_output()
}

/// Capture an owned child process's output without allowing a hung tool to
/// retain its caller forever. On timeout the exact child is killed and reaped
/// before this function returns.
pub fn output_owned_std_with_timeout(
    command: &mut StdCommand,
    timeout: Duration,
) -> io::Result<ProcessOutput> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    configure_bounded_process_tree(command);
    let mut child = spawn_owned_std(command)?;
    let child_pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = spawn_child_pipe_reader(stdout);
    let stderr_reader = spawn_child_pipe_reader(stderr);
    let deadline = Instant::now()
        .checked_add(timeout)
        .unwrap_or_else(Instant::now);

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(
                    deadline
                        .saturating_duration_since(Instant::now())
                        .min(Duration::from_millis(10)),
                );
            }
            Ok(None) => {
                let _ = terminate_bounded_process_tree(child_pid);
                let kill_error = child.kill().err();
                let wait_error = child.wait().err();
                let detail = kill_error
                    .or(wait_error)
                    .map(|error| format!(" Child cleanup also failed: {error}."))
                    .unwrap_or_default();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!(
                        "Owned child exceeded its {}ms deadline.{detail}",
                        timeout.as_millis()
                    ),
                ));
            }
            Err(error) => {
                let _ = terminate_bounded_process_tree(child_pid);
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }
    };

    let stdout = receive_child_pipe(stdout_reader, deadline).inspect_err(|_| {
        let _ = terminate_bounded_process_tree(child_pid);
    })?;
    let stderr = receive_child_pipe(stderr_reader, deadline).inspect_err(|_| {
        let _ = terminate_bounded_process_tree(child_pid);
    })?;
    Ok(ProcessOutput {
        status,
        stdout,
        stderr,
    })
}

fn read_child_pipe<R: Read>(pipe: Option<R>) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    if let Some(mut pipe) = pipe {
        pipe.read_to_end(&mut output)?;
    }
    Ok(output)
}

fn spawn_child_pipe_reader<R: Read + Send + 'static>(
    pipe: Option<R>,
) -> std::sync::mpsc::Receiver<io::Result<Vec<u8>>> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = sender.send(read_child_pipe(pipe));
    });
    receiver
}

fn receive_child_pipe(
    reader: std::sync::mpsc::Receiver<io::Result<Vec<u8>>>,
    deadline: Instant,
) -> io::Result<Vec<u8>> {
    reader
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|error| match error {
            std::sync::mpsc::RecvTimeoutError::Timeout => io::Error::new(
                io::ErrorKind::TimedOut,
                "Owned child exited but inherited output pipes exceeded the same deadline.",
            ),
            std::sync::mpsc::RecvTimeoutError::Disconnected => {
                io::Error::other("owned child output reader disconnected")
            }
        })?
}

#[cfg(unix)]
fn configure_bounded_process_tree(command: &mut StdCommand) {
    use std::os::unix::process::CommandExt as _;
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_bounded_process_tree(_command: &mut StdCommand) {}

#[cfg(unix)]
fn terminate_bounded_process_tree(process_group_id: u32) -> io::Result<()> {
    let result = unsafe { libc::kill(-(process_group_id as libc::pid_t), libc::SIGKILL) };
    if result == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(not(unix))]
fn terminate_bounded_process_tree(_process_group_id: u32) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
pub fn process_is_running(pid: u32) -> io::Result<bool> {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if result == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(false),
        Some(libc::EPERM) => Ok(true),
        _ => Err(error),
    }
}

#[cfg(unix)]
pub fn terminate_process(pid: u32, force: bool) -> io::Result<()> {
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    if unsafe { libc::kill(pid as libc::pid_t, signal) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
pub fn process_is_running(_pid: u32) -> io::Result<bool> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "PID liveness probing is unsupported on this platform",
    ))
}

#[cfg(not(any(unix, target_os = "windows")))]
pub fn terminate_process(_pid: u32, _force: bool) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "PID termination is unsupported on this platform",
    ))
}

#[cfg(not(target_os = "windows"))]
fn assign_tokio_child(_child: &TokioChild) -> io::Result<()> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn assign_std_child(_child: &StdChild) -> io::Result<()> {
    Ok(())
}

#[cfg(target_os = "windows")]
mod windows_job {
    use std::io;
    use std::os::windows::io::{AsRawHandle, RawHandle};
    use std::sync::OnceLock;

    use tokio::process::Child as TokioChild;
    use windows::Win32::Foundation::{
        CloseHandle, ERROR_INVALID_PARAMETER, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
    };
    use windows::core::PCWSTR;

    use super::StdChild;

    static BACKEND_JOB_HANDLE: OnceLock<Result<usize, String>> = OnceLock::new();

    pub(super) fn assign_tokio_child(child: &TokioChild) -> io::Result<()> {
        let raw_handle = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("spawned child exited before Job Object assignment"))?;
        assign_raw_process_handle(raw_handle)
    }

    pub(super) fn assign_std_child(child: &StdChild) -> io::Result<()> {
        assign_raw_process_handle(child.as_raw_handle())
    }

    pub(super) fn process_is_running(pid: u32) -> io::Result<bool> {
        let handle = match unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) } {
            Ok(handle) => handle,
            Err(error) if error.code() == ERROR_INVALID_PARAMETER.to_hresult() => return Ok(false),
            Err(error) => return Err(io::Error::other(error)),
        };
        let wait = unsafe { WaitForSingleObject(handle, 0) };
        let _ = unsafe { CloseHandle(handle) };
        if wait == WAIT_TIMEOUT {
            Ok(true)
        } else if wait == WAIT_OBJECT_0 {
            Ok(false)
        } else {
            Err(io::Error::last_os_error())
        }
    }

    pub(super) fn terminate_process(pid: u32) -> io::Result<()> {
        let handle =
            match unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, false, pid) } {
                Ok(handle) => handle,
                Err(error) if error.code() == ERROR_INVALID_PARAMETER.to_hresult() => return Ok(()),
                Err(error) => return Err(io::Error::other(error)),
            };
        let result = unsafe { TerminateProcess(handle, 1) }.map_err(io::Error::other);
        let _ = unsafe { CloseHandle(handle) };
        result
    }

    fn assign_raw_process_handle(raw_handle: RawHandle) -> io::Result<()> {
        let job = backend_job_handle()?;
        let process = HANDLE(raw_handle);
        unsafe { AssignProcessToJobObject(job, process) }.map_err(|error| {
            io::Error::other(format!("Could not assign child to Job Object: {error}"))
        })
    }

    fn backend_job_handle() -> io::Result<HANDLE> {
        match BACKEND_JOB_HANDLE.get_or_init(create_backend_job_handle) {
            Ok(raw) => Ok(HANDLE(*raw as *mut core::ffi::c_void)),
            Err(message) => Err(io::Error::other(message.clone())),
        }
    }

    fn create_backend_job_handle() -> Result<usize, String> {
        let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
            .map_err(|error| format!("Could not create backend Job Object: {error}"))?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .map_err(|error| format!("Could not configure backend Job Object: {error}"))?;
        Ok(job.0 as usize)
    }
}

#[cfg(target_os = "windows")]
fn assign_tokio_child(child: &TokioChild) -> io::Result<()> {
    windows_job::assign_tokio_child(child)
}

#[cfg(target_os = "windows")]
fn assign_std_child(child: &StdChild) -> io::Result<()> {
    windows_job::assign_std_child(child)
}

#[cfg(target_os = "windows")]
pub fn process_is_running(pid: u32) -> io::Result<bool> {
    windows_job::process_is_running(pid)
}

#[cfg(target_os = "windows")]
pub fn terminate_process(pid: u32, _force: bool) -> io::Result<()> {
    // Win32 has no POSIX-style graceful signal for an arbitrary console child.
    // The recording finalizer has already closed every owned FIFO before this
    // fallback, so forced termination is the only truthful bounded action.
    windows_job::terminate_process(pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quick_exit_command() -> StdCommand {
        #[cfg(target_os = "windows")]
        {
            let mut command = StdCommand::new("cmd");
            command.args(["/C", "exit", "0"]);
            command
        }

        #[cfg(not(target_os = "windows"))]
        {
            StdCommand::new("true")
        }
    }

    #[test]
    fn owned_std_child_can_exit_cleanly() {
        let mut command = quick_exit_command();
        let status = spawn_owned_std(&mut command)
            .expect("child should spawn")
            .wait()
            .expect("child should wait");
        assert!(status.success());
    }

    fn long_running_command() -> StdCommand {
        #[cfg(target_os = "windows")]
        {
            let mut command = StdCommand::new("cmd");
            command.args(["/C", "ping", "-n", "30", "127.0.0.1"]);
            command
        }

        #[cfg(not(target_os = "windows"))]
        {
            let mut command = StdCommand::new("sleep");
            command.arg("30");
            command
        }
    }

    #[test]
    fn owned_process_can_be_probed_and_terminated_by_pid() {
        let mut child = spawn_owned_std(&mut long_running_command()).expect("child should spawn");
        let pid = child.id();

        assert!(process_is_running(pid).expect("probe child"));
        terminate_process(pid, true).expect("terminate child");
        child.wait().expect("reap terminated child");
        assert!(!process_is_running(pid).expect("probe reaped child"));
    }

    #[cfg(unix)]
    #[test]
    fn bounded_output_kills_and_reaps_a_hung_owned_child() {
        let mut command = long_running_command();
        let started = Instant::now();
        let error = output_owned_std_with_timeout(&mut command, Duration::from_millis(25))
            .expect_err("long-running child must exceed the bounded wait");

        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "timeout cleanup must stay bounded"
        );
    }

    #[cfg(unix)]
    #[test]
    fn bounded_output_does_not_join_inherited_pipes_forever() {
        let mut command = StdCommand::new("sh");
        command.args(["-c", "sleep 30 & exit 0"]);
        let started = Instant::now();
        let error = output_owned_std_with_timeout(&mut command, Duration::from_millis(50))
            .expect_err("a descendant retaining both pipes must exhaust the shared deadline");

        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "inherited pipe drain must remain bounded with the child process tree"
        );
    }
}
