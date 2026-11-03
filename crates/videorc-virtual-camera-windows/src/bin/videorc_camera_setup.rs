//! `videorc-camera-setup.exe` (plan 214 C2, D8): the one elevated step.
//!
//! Videorc runs it through one UAC prompt (`runas`) from the "Set up Videorc
//! Camera" button. It copies the media source DLL next to this exe to
//! `%ProgramData%\Videorc\camera\<version>\` and registers it in HKLM;
//! `/remove` deletes the keys and the installed copies. It prints one line
//! and exits 0 on success, 1 on failure, 2 on a bad command line.
//!
//! On any other OS it only prints the usage: the crate builds everywhere so
//! the ring tests run on the Mac.

use std::process::ExitCode;

use videorc_virtual_camera_windows::setup::{SetupCommand, USAGE, parse_setup_args};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse_setup_args(&args) {
        SetupCommand::Usage => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
        command => run(command),
    }
}

#[cfg(windows)]
fn run(command: SetupCommand) -> ExitCode {
    use videorc_virtual_camera_windows::windows::setup_exe;
    match command {
        SetupCommand::Install { dll } => match setup_exe::install(dll.as_deref()) {
            Ok(installed) => {
                println!(
                    "Videorc Camera is set up: {} registered as version {}.",
                    installed.dll_path.display(),
                    installed.version
                );
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("Videorc Camera setup failed: {error}");
                ExitCode::from(1)
            }
        },
        SetupCommand::Remove => match setup_exe::remove() {
            Ok(()) => {
                println!("Videorc Camera was removed from this PC.");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("Videorc Camera removal failed: {error}");
                ExitCode::from(1)
            }
        },
        SetupCommand::Usage => ExitCode::from(2),
    }
}

#[cfg(not(windows))]
fn run(_command: SetupCommand) -> ExitCode {
    eprintln!("videorc-camera-setup only does anything on Windows.\n{USAGE}");
    ExitCode::from(2)
}
