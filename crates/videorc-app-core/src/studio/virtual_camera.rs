//! Videorc Camera's words and its two plain facts (plan 260 S1.6a), from
//! `lib/virtual-camera-view.ts`: what Health's Videorc Camera group reads.
//! The Output page's camera row (`virtualCameraView`, the approval path, the
//! warning toast) lands with the Output page.

use videorc_protocol::room_program_camera::RoomProgramSource;
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

/// The status line's tone (`StatusTone`): the tone rides on the icon, the
/// words stay monochrome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CameraTone {
    Neutral,
    Good,
    Warn,
}

/// `VirtualCameraView['line']`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CameraLine {
    pub text: String,
    pub tone: CameraTone,
    /// A spinner instead of the icon: something is under way.
    pub busy: bool,
}

/// `VirtualCameraAction`: the one button beside the switch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CameraAction {
    /// macOS: System Settings' camera-extension approval.
    OpenApprovalSettings,
    /// Windows: the one-time driver setup (hidden until proven, plan 260).
    SetUp,
    /// Linux: `pkexec modprobe v4l2loopback …`.
    LoadModule,
}

impl CameraAction {
    pub fn label(self) -> &'static str {
        match self {
            Self::OpenApprovalSettings => "Open System Settings",
            Self::SetUp => camera_copy::SET_UP,
            Self::LoadModule => camera_copy::LOAD_MODULE,
        }
    }

    /// `PENDING_LABEL`: the button's words while it runs.
    pub fn pending_label(self) -> &'static str {
        match self {
            Self::OpenApprovalSettings => camera_copy::OPENING,
            Self::SetUp => "Setting up…",
            Self::LoadModule => "Loading…",
        }
    }
}

/// `virtualCameraView`: Output's Videorc Camera row. `os` is Node's name
/// (`darwin`, `win32`, `linux`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputCameraView {
    pub hidden: bool,
    pub checked: bool,
    pub disabled: bool,
    pub line: Option<CameraLine>,
    pub action: Option<CameraAction>,
    /// Linux: the distribution's install command, to copy into a terminal.
    pub command: Option<String>,
}

/// While the backend reconnects the row says so instead of a stale state.
pub const OFFLINE_LOCK: &str = "Videorc is reconnecting. These controls come back in a moment.";

impl OutputCameraView {
    pub fn of(status: Option<&VirtualCameraStatus>, connected: bool, os: &str) -> Self {
        use VirtualCameraPlatformStep as Step;
        let Some(status) = status.filter(|status| !camera_hidden(Some(status))) else {
            return Self {
                hidden: true,
                checked: false,
                disabled: true,
                line: None,
                action: None,
                command: None,
            };
        };
        let device_noun = crate::format::device_noun(os);
        let mut view = Self {
            hidden: false,
            // Locked means disabled: a camera that can't run never looks on.
            checked: status.on && status.available,
            disabled: !connected || !status.available,
            line: None,
            action: None,
            command: None,
        };
        let say =
            |text: String, tone: CameraTone, busy: bool| Some(CameraLine { text, tone, busy });
        let room = match status.source {
            Some(RoomProgramSource::RoomProgramPreview) => Some(camera_copy::ROOM_PROGRAM),
            Some(RoomProgramSource::RoomProgramPaused) => Some(camera_copy::ROOM_PROGRAM_PAUSED),
            None => None,
        };
        if !status.available {
            view.line = say(
                status
                    .message
                    .clone()
                    .filter(|_| status.platform_step == Some(Step::Failed))
                    .unwrap_or_else(|| camera_copy::cant_run(device_noun)),
                CameraTone::Warn,
                false,
            );
        } else {
            match status.state {
                VirtualCameraState::Off => {}
                VirtualCameraState::Installing => {
                    let text = if status.platform_step == Some(Step::Installing) {
                        camera_copy::INSTALLING
                    } else {
                        camera_copy::STARTING
                    };
                    view.line = say(text.into(), CameraTone::Neutral, true);
                }
                VirtualCameraState::NeedsApproval => {
                    if status.platform_step == Some(Step::NeedsReboot) {
                        view.line = say(
                            camera_copy::needs_restart(device_noun),
                            CameraTone::Warn,
                            false,
                        );
                    } else if os == "darwin" {
                        view.line = say(
                            format!(
                                "Allow {VIDEORC_CAMERA} in System Settings → {}.",
                                camera_copy::APPROVAL_PATH_MACOS_15
                            ),
                            CameraTone::Warn,
                            false,
                        );
                        view.action = Some(CameraAction::OpenApprovalSettings);
                    } else {
                        view.line = say(
                            camera_copy::WAITING_FOR_PASSWORD.into(),
                            CameraTone::Neutral,
                            true,
                        );
                    }
                }
                VirtualCameraState::NeedsSetup => {
                    if status.platform_step == Some(Step::SettingUp) {
                        view.line = say(camera_copy::SETTING_UP.into(), CameraTone::Neutral, true);
                    } else if os == "win32" {
                        view.line = say(camera_copy::WINDOWS_SETUP.into(), CameraTone::Warn, false);
                        view.action = Some(CameraAction::SetUp);
                    } else if os == "linux" {
                        // D1: the distro's install command arrives as the message.
                        view.command = status.message.clone().filter(|m| !m.is_empty());
                        view.line = say(
                            if view.command.is_some() {
                                camera_copy::LINUX_SETUP
                            } else {
                                camera_copy::LINUX_SETUP_NO_COMMAND
                            }
                            .into(),
                            CameraTone::Warn,
                            false,
                        );
                        view.action = Some(CameraAction::LoadModule);
                    } else {
                        view.line = say(camera_copy::NEEDS_SETUP.into(), CameraTone::Warn, false);
                    }
                }
                VirtualCameraState::Ready => {
                    view.line = say(
                        match room {
                            Some(room) => {
                                format!("{room} · choose Videorc Camera in the other app")
                            }
                            None => camera_copy::READY.into(),
                        },
                        CameraTone::Good,
                        false,
                    );
                }
                VirtualCameraState::Streaming => {
                    // D13: a platform that can't count apps (Linux) reads as ready.
                    let base = match status.viewers.filter(|count| *count > 0) {
                        Some(apps) => camera_copy::in_use(i64::from(apps)),
                        None => camera_copy::READY.to_string(),
                    };
                    view.line = say(
                        match room {
                            Some(room) => format!("{base} · {room}"),
                            None => base,
                        },
                        CameraTone::Good,
                        false,
                    );
                }
                VirtualCameraState::Unavailable => {
                    let detail = status.message.as_deref().unwrap_or(camera_copy::RETRYING);
                    view.line = say(
                        format!("{} {detail}", camera_copy::STOPPED),
                        CameraTone::Warn,
                        false,
                    );
                }
            }
        }
        if !connected {
            view.line = say(OFFLINE_LOCK.into(), CameraTone::Neutral, false);
        }
        view
    }
}

#[cfg(test)]
mod output_view_tests {
    use super::*;

    fn status(
        state: VirtualCameraState,
        step: Option<VirtualCameraPlatformStep>,
    ) -> VirtualCameraStatus {
        let mut status: VirtualCameraStatus = serde_json::from_value(serde_json::json!({
            "on": true,
            "available": true,
            "state": "off",
        }))
        .expect("status");
        status.state = state;
        status.platform_step = step;
        status
    }

    #[test]
    fn linux_setup_offers_load_module_and_the_install_command() {
        let mut needs = status(
            VirtualCameraState::NeedsSetup,
            Some(VirtualCameraPlatformStep::NeedsSetup),
        );
        needs.message = Some("sudo apt install v4l2loopback-dkms".into());
        let view = OutputCameraView::of(Some(&needs), true, "linux");
        assert_eq!(view.action, Some(CameraAction::LoadModule));
        assert_eq!(
            view.command.as_deref(),
            Some("sudo apt install v4l2loopback-dkms")
        );
        assert_eq!(view.line.unwrap().text, camera_copy::LINUX_SETUP);

        needs.message = None;
        let view = OutputCameraView::of(Some(&needs), true, "linux");
        assert_eq!(view.command, None);
        assert_eq!(view.line.unwrap().text, camera_copy::LINUX_SETUP_NO_COMMAND);

        let loading = status(
            VirtualCameraState::NeedsSetup,
            Some(VirtualCameraPlatformStep::SettingUp),
        );
        let view = OutputCameraView::of(Some(&loading), true, "linux");
        assert_eq!(view.action, None);
        assert!(view.line.unwrap().busy);
    }

    #[test]
    fn approval_is_macos_and_a_password_wait_elsewhere() {
        let approval = status(
            VirtualCameraState::NeedsApproval,
            Some(VirtualCameraPlatformStep::NeedsApproval),
        );
        let mac = OutputCameraView::of(Some(&approval), true, "darwin");
        assert_eq!(mac.action, Some(CameraAction::OpenApprovalSettings));
        let linux = OutputCameraView::of(Some(&approval), true, "linux");
        assert_eq!(linux.action, None);
        assert_eq!(linux.line.unwrap().text, camera_copy::WAITING_FOR_PASSWORD);
    }

    #[test]
    fn a_room_program_names_itself_and_offline_says_reconnecting() {
        let mut ready = status(VirtualCameraState::Ready, None);
        ready.source = Some(RoomProgramSource::RoomProgramPreview);
        let view = OutputCameraView::of(Some(&ready), true, "darwin");
        assert_eq!(
            view.line.unwrap().text,
            "Showing the room's Program preview · choose Videorc Camera in the other app"
        );
        let offline = OutputCameraView::of(Some(&ready), false, "darwin");
        assert!(offline.disabled);
        assert_eq!(offline.line.unwrap().text, OFFLINE_LOCK);
        assert!(OutputCameraView::of(None, true, "darwin").hidden);
    }
}
