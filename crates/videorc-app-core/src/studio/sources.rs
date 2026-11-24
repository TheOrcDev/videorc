//! Sources and the scene as the backend reports them: `devices.list` and
//! `devices.changed` for the capturable devices, `scene.get` and
//! `scene.changed` for the committed scene (`deviceList` and `scene` in
//! `use-studio.tsx`).
//!
//! The Studio's Sources mirror (`SourcesSectionView`), the pickers and the
//! live switch land with the scenes and sources (S1.6b).

use videorc_protocol::{Device, DeviceKind, DeviceList, DeviceStatus, Scene, SourceSelection};

#[derive(Debug, Clone)]
pub struct SourcesState {
    pub devices: DeviceList,
    /// Whether `devices.list` has answered on this connection; an empty
    /// list before that is not "no devices".
    pub devices_known: bool,
    /// Counts the device lists read (`deviceList.devices` changing).
    pub devices_revision: u64,
    pub scene: Option<Scene>,
}

impl Default for SourcesState {
    fn default() -> Self {
        Self {
            devices: DeviceList {
                devices: Vec::new(),
                warnings: Vec::new(),
            },
            devices_known: false,
            devices_revision: 0,
            scene: None,
        }
    }
}

/// What stands between a selection and a start (`findDevice` in
/// `lib/format.ts`, read for every selected id).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectionProblem {
    /// The selected id is not in the list.
    Missing { kind: DeviceKind, id: String },
    /// The device is listed but not available (permission, unplugged).
    Unavailable {
        kind: DeviceKind,
        id: String,
        status: DeviceStatus,
        detail: Option<String>,
    },
}

impl SourcesState {
    pub fn set_devices(&mut self, devices: DeviceList) {
        self.devices = devices;
        self.devices_known = true;
        self.devices_revision += 1;
    }

    /// The backend is gone: the list is stale until the next read.
    pub fn forget_devices(&mut self) {
        self.devices_known = false;
    }

    pub fn set_scene(&mut self, scene: Scene) {
        self.scene = Some(scene);
    }

    pub fn device(&self, id: &str) -> Option<&Device> {
        self.devices.devices.iter().find(|device| device.id == id)
    }

    pub fn of_kind<'a>(&'a self, kind: &'a DeviceKind) -> impl Iterator<Item = &'a Device> + 'a {
        self.devices
            .devices
            .iter()
            .filter(move |device| &device.kind == kind)
    }

    /// Every selected device that is missing or unavailable. The test
    /// pattern needs nothing. Unknown devices (no list yet) report nothing:
    /// the backend names the refusal at start.
    pub fn selection_problems(&self, selection: &SourceSelection) -> Vec<SelectionProblem> {
        if !self.devices_known {
            return Vec::new();
        }
        let selected = [
            (DeviceKind::Screen, selection.screen_id.as_deref()),
            (DeviceKind::Window, selection.window_id.as_deref()),
            (DeviceKind::Camera, selection.camera_id.as_deref()),
            (DeviceKind::Microphone, selection.microphone_id.as_deref()),
        ];
        selected
            .into_iter()
            .filter_map(|(kind, id)| {
                let id = id?;
                match self.device(id) {
                    None => Some(SelectionProblem::Missing {
                        kind,
                        id: id.to_string(),
                    }),
                    Some(device) if device.status != DeviceStatus::Available => {
                        Some(SelectionProblem::Unavailable {
                            kind,
                            id: id.to_string(),
                            status: device.status.clone(),
                            detail: device.detail.clone(),
                        })
                    }
                    Some(_) => None,
                }
            })
            .collect()
    }
}

/// The Sources mirror's words (P3-D2: Electron's exactly).
pub mod copy {
    pub const SOURCES: &str = "Sources";
    pub const OPEN_SOURCES: &str = "Open Sources";
    pub const SCREEN: &str = "Screen";
    pub const CAMERA: &str = "Camera";
    pub const CAPTIONS: &str = "Captions";
    pub const CHAT: &str = "Chat";
    pub const NONE: &str = "None";
    pub const OFF: &str = "Off";
    pub const TEST_PATTERN: &str = "Test pattern";
    /// `SCREEN_HIDDEN_LABEL`.
    pub const SCREEN_HIDDEN: &str = "Screen hidden";
    pub const HIDE_SCREEN: &str = "Hide screen";
    pub const SHOW_SCREEN: &str = "Show screen";
    /// `WINDOW_NAMES.streamManager`.
    pub const STREAM_MANAGER: &str = "Stream Manager";
    pub const OPEN_STREAM_MANAGER: &str = "Open Stream Manager";
    /// `shortcutAccelerator('comments-window')`.
    pub const STREAM_MANAGER_ACCELERATOR: &str = "CommandOrControl+Shift+J";
    /// `screenPrivacyDisabledReason` while Videorc is away.
    pub const RECONNECTING: &str = "Videorc is reconnecting. Try again in a moment.";
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(id: &str, kind: DeviceKind, status: DeviceStatus) -> Device {
        Device {
            app: None,
            window_title: None,
            display_uuid: None,
            id: id.to_string(),
            name: id.to_string(),
            kind,
            status,
            detail: None,
            width: None,
            height: None,
        }
    }

    #[test]
    fn selection_problems_name_missing_and_unavailable_devices() {
        let mut sources = SourcesState::default();
        let selection = SourceSelection {
            screen_id: Some("screen:1".to_string()),
            window_id: None,
            camera_id: Some("camera:gone".to_string()),
            microphone_id: Some("mic:1".to_string()),
            test_pattern: false,
        };
        assert!(
            sources.selection_problems(&selection).is_empty(),
            "nothing known yet"
        );
        sources.set_devices(DeviceList {
            devices: vec![
                device("screen:1", DeviceKind::Screen, DeviceStatus::Available),
                device(
                    "mic:1",
                    DeviceKind::Microphone,
                    DeviceStatus::PermissionRequired,
                ),
            ],
            warnings: Vec::new(),
        });
        assert!(sources.devices_known);
        let problems = sources.selection_problems(&selection);
        assert_eq!(problems.len(), 2);
        assert!(matches!(
            &problems[0],
            SelectionProblem::Missing { kind: DeviceKind::Camera, id } if id == "camera:gone"
        ));
        assert!(matches!(
            &problems[1],
            SelectionProblem::Unavailable {
                kind: DeviceKind::Microphone,
                status: DeviceStatus::PermissionRequired,
                ..
            }
        ));
        assert_eq!(sources.of_kind(&DeviceKind::Screen).count(), 1);
        sources.forget_devices();
        assert!(sources.selection_problems(&selection).is_empty());
    }
}
