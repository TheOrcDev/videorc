use std::io;
use std::process::{Child as StdChild, Command as StdCommand, ExitStatus, Output as ProcessOutput};

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
}
