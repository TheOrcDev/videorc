//! The `.desktop` entry and `videorc://` (plan 260 S2.6c): the core's
//! registration (`desktop::linux::desktop_entry`, Electron's
//! `registerLinuxAppImageUrlHandler`) with the real desktop tools, once per
//! launch of a packaged AppImage, off the main thread.

use std::path::PathBuf;
use std::process::{Command, Stdio};

use videorc_app_core::Logger;
use videorc_app_core::desktop::linux::desktop_entry::{
    DesktopTool, RegistrationOutcome, appimage_to_register, apply_registration,
};

/// Runs one desktop tool (`xdg-mime`, `update-desktop-database`); a missing
/// or failing tool is logged, never a failed launch.
fn run_tool(logger: &Logger, (tool, args): DesktopTool) {
    let status = Command::new(tool)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match status {
        Ok(status) if status.success() => {}
        Ok(status) => logger.warn(format!("[desktop] {tool} exited with {status}")),
        Err(error) => logger.warn(format!("[desktop] {tool} could not run: {error}")),
    }
}

/// Registers the AppImage this run came from, when it is one and the build
/// is packaged (a release build: a development run never touches the
/// desktop). Returns at once; the work runs on its own thread.
pub fn register_in_background(logger: Logger) {
    let appimage = std::env::var("APPIMAGE").ok();
    let packaged = !cfg!(debug_assertions);
    let Some(appimage) = appimage_to_register(packaged, appimage.as_deref()).map(str::to_string)
    else {
        return;
    };
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        logger.warn("[desktop] no HOME: videorc:// links stay off");
        return;
    };
    let xdg_data_home = std::env::var("XDG_DATA_HOME").ok();
    let spawned = std::thread::Builder::new()
        .name("videorc-desktop-entry".into())
        .spawn(move || {
            // The AppImage carries no icon the GPUI app can name yet; the
            // entry names the `videorc` icon theme name either way.
            let outcome = apply_registration(
                &appimage,
                &home,
                xdg_data_home.as_deref(),
                None,
                |tool| run_tool(&logger, tool),
            );
            match outcome {
                Ok(RegistrationOutcome::Registered { decision, .. }) => {
                    logger.info(format!("[desktop] videorc:// registered ({decision:?})"))
                }
                Ok(RegistrationOutcome::LeftAlone(path)) => logger.info(format!(
                    "[desktop] {} isn't Videorc's: left alone",
                    path.display()
                )),
                Ok(RegistrationOutcome::Unrepresentable) => logger.warn(
                    "[desktop] the AppImage's path can't go in a desktop entry: videorc:// links stay off",
                ),
                Err(error) => logger.warn(format!("[desktop] registration failed: {error}")),
            }
        });
    if let Err(error) = spawned {
        eprintln!("[videorc-app] desktop entry thread didn't start: {error}");
    }
}
