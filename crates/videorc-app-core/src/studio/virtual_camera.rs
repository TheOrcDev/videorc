//! Videorc Camera's words and its two plain facts (plan 260 S1.6a), from
//! `lib/virtual-camera-view.ts`: what Health's Videorc Camera group reads.
//! The Output page's camera row (`virtualCameraView`, the approval path, the
//! warning toast) lands with the Output page.

use videorc_protocol::{VirtualCameraPlatformStep, VirtualCameraState, VirtualCameraStatus};

/// The product's name, as every surface writes it.
pub const VIDEORC_CAMERA: &str = "Videorc Camera";

/// Videorc Camera's words (`VIDEORC_CAMERA_COPY`, macOS and the lines every
/// platform shares; Windows' set-up and Linux's module are Phase 4's).
pub mod camera_copy {
    pub const INSTALLING: &str = "Installing Videorc Camera…";
    pub const STARTING: &str = "Starting Videorc Camera…";
    pub const READY: &str = "Ready · choose Videorc Camera in the other app";
    pub const WAITING_FOR_PASSWORD: &str = "Waiting for your password…";
    pub const SETTING_UP: &str = "Setting up Videorc Camera…";
    pub const NEEDS_SETUP: &str = "Needs a one-time setup.";
    /// Plan 249 S23: a room's Program preview owns the camera.
    pub const ROOM_PROGRAM: &str = "Showing the room's Program preview";
    pub const ROOM_PROGRAM_PAUSED: &str = "Room program paused";
    pub const WINDOWS_SETUP: &str =
        "Needs a one-time setup. Windows asks for your permission once.";
    pub const LINUX_SETUP: &str = "Install v4l2loopback, then load it.";
    pub const LINUX_SETUP_NO_COMMAND: &str =
        "Install v4l2loopback with your package manager, then load it.";
    pub const UNSUPPORTED: &str = "Videorc Camera isn't available on this computer.";
    pub const NOT_IN_THIS_STUDIO: &str = "Videorc Camera isn't available in this Studio.";
    /// ⌘K's two items (E2).
    pub const TURN_ON: &str = "Turn Videorc Camera on";
    pub const TURN_OFF: &str = "Turn Videorc Camera off";
    pub const SET_UP: &str = "Set up Videorc Camera";
    pub const LOAD_MODULE: &str = "Load module";
    pub const STOPPED: &str = "Stopped.";
    pub const RETRYING: &str = "Videorc tries again on its own.";
    pub const STOPPED_TOAST_TITLE: &str = "Videorc Camera stopped";
    /// `PENDING_LABEL['open-approval-settings']`.
    pub const OPENING: &str = "Opening…";
    /// `VIDEORC_CAMERA_APPROVAL_PATH_MACOS_13` and `_15`.
    pub const APPROVAL_PATH_MACOS_13: &str = "Privacy & Security";
    pub const APPROVAL_PATH_MACOS_15: &str =
        "General → Login Items & Extensions → Camera Extensions";
    /// `VIDEORC_CAMERA_TOAST_ID`: one toast, never stacked.
    pub const TOAST_ID: &str = "virtual-camera";
    /// Health's Remove Videorc Camera (plan 214 E3) and its confirmation.
    pub const REMOVE: &str = "Remove Videorc Camera";
    pub const REMOVE_TITLE: &str = "Remove Videorc Camera?";
    pub const REMOVE_DESCRIPTION: &str = "Videorc Camera turns off and other apps stop listing it. macOS may ask for your password. Turn it on in Output to install it again.";
    pub const REMOVING: &str = "Removing…";
    pub const REMOVED: &str = "Videorc Camera removed";

    /// `virtualCameraStateLabel`: Health's word for each state.
    pub fn state_label(state: videorc_protocol::VirtualCameraState) -> &'static str {
        use videorc_protocol::VirtualCameraState as State;
        match state {
            State::Off => "Off",
            State::Installing => "Installing",
            State::NeedsApproval => "Needs approval",
            State::NeedsSetup => "Needs setup",
            State::Ready => "Ready",
            State::Streaming => "In use",
            State::Unavailable => "Unavailable",
        }
    }

    pub fn in_use(apps: i64) -> String {
        format!(
            "In use by {}",
            super::super::health_page::plural(apps, "app")
        )
    }
    pub fn needs_restart(device_noun: &str) -> String {
        format!("Restart your {device_noun} to finish installing Videorc Camera.")
    }
    pub fn cant_run(device_noun: &str) -> String {
        format!("Videorc Camera can't run on this {device_noun}.")
    }
}

/// `virtualCameraHidden`: the backend says this computer can't have it.
pub fn camera_hidden(status: Option<&VirtualCameraStatus>) -> bool {
    status.is_none_or(|status| status.platform_step == Some(VirtualCameraPlatformStep::Unsupported))
}

/// `virtualCameraRunning`: showing the program to apps right now.
pub fn camera_running(status: Option<&VirtualCameraStatus>) -> bool {
    status.is_some_and(|status| {
        status.on
            && matches!(
                status.state,
                VirtualCameraState::Ready | VirtualCameraState::Streaming
            )
    })
}
