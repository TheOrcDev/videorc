//! `videorc-camera-setup.exe` (plan 214 C2, D8): the one elevated step.
//!
//! Videorc starts it unelevated with `/install` or `/remove` (an argv, never
//! a shell string). Unelevated, it starts itself again through one UAC
//! prompt with fixed arguments, waits, and prints the line for the elevated
//! copy's exit code ([`SetupExit`]). Elevated (that copy, or an
//! administrator terminal) it does the work and prints the detail: it
//! copies the media source DLL beside it to
//! `%ProgramData%\Videorc\camera\<version>\` and registers it in HKLM, or
//! removes both.
//!
//! On any other OS it only prints the usage: the crate builds everywhere so
//! the ring tests run on the Mac.

use std::process::ExitCode;

use videorc_virtual_camera_windows::setup::{SetupExit, USAGE, parse_setup_args};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(request) = parse_setup_args(&args) else {
        eprintln!("{USAGE}");
        return exit(SetupExit::Usage);
    };
    run(request)
}

fn exit(code: SetupExit) -> ExitCode {
    ExitCode::from(code.code())
}

#[cfg(windows)]
fn run(request: videorc_virtual_camera_windows::setup::SetupRequest) -> ExitCode {
    use videorc_virtual_camera_windows::setup::SetupVerb;
    use videorc_virtual_camera_windows::windows::setup_exe::{self, RelaunchError};

    let verb = request.verb;
    if !setup_exe::is_elevated() {
        if request.relaunched {
            eprintln!("{}", SetupExit::NotElevated.line(verb));
            return exit(SetupExit::NotElevated);
        }
        let outcome = match setup_exe::relaunch_elevated(verb) {
            Ok(code) => SetupExit::from_code(code),
            Err(RelaunchError::Declined) => SetupExit::Declined,
            Err(RelaunchError::Failed(detail)) => {
                eprintln!("{}", SetupExit::Failed.line(verb));
                eprintln!("{detail}");
                return exit(SetupExit::Failed);
            }
        };
        if outcome == SetupExit::Done {
            println!("{}", outcome.line(verb));
        } else {
            eprintln!("{}", outcome.line(verb));
        }
        return exit(outcome);
    }

    match verb {
        SetupVerb::Install => match setup_exe::install() {
            Ok(installed) => {
                println!(
                    "{} {} is registered as version {}{}.",
                    SetupExit::Done.line(verb),
                    installed.dll_path.display(),
                    installed.version,
                    if installed.unchanged {
                        " (already set up)"
                    } else {
                        ""
                    }
                );
                exit(SetupExit::Done)
            }
            Err(failure) => {
                eprintln!("{}", failure.exit.line(verb));
                eprintln!("{failure}");
                exit(failure.exit)
            }
        },
        SetupVerb::Remove => match setup_exe::remove() {
            Ok(note) => {
                println!("{}", SetupExit::Done.line(verb));
                if let Some(note) = note {
                    println!("{note}");
                }
                exit(SetupExit::Done)
            }
            Err(failure) => {
                eprintln!("{}", failure.exit.line(verb));
                eprintln!("{failure}");
                exit(failure.exit)
            }
        },
    }
}

#[cfg(not(windows))]
fn run(_request: videorc_virtual_camera_windows::setup::SetupRequest) -> ExitCode {
    eprintln!("videorc-camera-setup only does anything on Windows.\n{USAGE}");
    exit(SetupExit::Usage)
}
