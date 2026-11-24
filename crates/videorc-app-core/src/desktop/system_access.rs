//! What the permission rows say and offer (plan 220 S2.6b), as the renderer
//! decides it: `lib/system-access.ts` (the rows, their states and details,
//! and which action a row's button runs) and `lib/system-access-view.ts`
//! (the chip's word and the button's label).
//!
//! The rows' homes (the first-run setup, Settings → Permissions, the Sources
//! page's alerts) are Phase 3's pages; the Rust app computes them here from
//! the OS's exact grants ([`MediaAccessSnapshot`]) and the backend's device
//! evidence, with Electron's copy byte for byte.
//!
//! macOS: the exact TCC value decides never-asked against denied; after a
//! grant the backend's evidence still has to prove the device works. A
//! screen granted in the OS while the backend's listing still says
//! permission-required needs a relaunch (macOS honours it per launch).
//! Windows has no per-app screen grant; Linux shows no rows at all.

use serde::Serialize;
use videorc_protocol::{AudioMeterResult, AudioMeterStatus, Device, DeviceKind, DeviceStatus};

use super::permissions::{
    MediaAccessSnapshot, MediaAccessStatus, PermissionPlatform, SystemPermissionPane,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SystemAccessState {
    Granted,
    NotGranted,
    FirstUse,
    DeviceIssue,
    Waiting,
    NeedsRelaunch,
    NotRequired,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SystemAccessRowId {
    ScreenRecording,
    SystemAudio,
    Camera,
    Microphone,
}

impl SystemAccessRowId {
    /// The pane a row's grant and button belong to (System audio rides the
    /// screen's).
    pub fn pane(self) -> SystemPermissionPane {
        match self {
            SystemAccessRowId::ScreenRecording | SystemAccessRowId::SystemAudio => {
                SystemPermissionPane::ScreenRecording
            }
            SystemAccessRowId::Camera => SystemPermissionPane::Camera,
            SystemAccessRowId::Microphone => SystemPermissionPane::Microphone,
        }
    }
}

/// `SystemAccessAction`: what a row's button runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SystemAccessAction {
    RequestMediaAccess,
    OpenSettings,
    Relaunch,
}

/// `SystemAccessRow`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAccessRow {
    pub id: SystemAccessRowId,
    pub label: &'static str,
    /// One line of why this permission matters.
    pub purpose: &'static str,
    pub state: SystemAccessState,
    pub detail: String,
    pub required: bool,
    pub checking: bool,
}

/// `SystemAccessContext`: what the page knows beyond the grants.
#[derive(Debug, Clone, Default)]
pub struct SystemAccessContext {
    pub pending_pane: Option<SystemPermissionPane>,
    pub capture_restarting: bool,
    pub screen_grant_stale: bool,
    pub last_known_states: Vec<(SystemAccessRowId, SystemAccessState)>,
}

/// Everything the rows are computed from.
pub struct SystemAccessInput<'a> {
    pub devices: &'a [Device],
    pub audio_meter: Option<&'a AudioMeterResult>,
    pub platform: PermissionPlatform,
    /// `os.release()`: Darwin 24 (macOS 15) renamed the screen pane.
    pub os_release: Option<&'a str>,
    /// `runtimeInfo.permissionTargetName`: the name the OS lists.
    pub permission_target_name: &'a str,
    pub media_access: Option<&'a MediaAccessSnapshot>,
    pub context: SystemAccessContext,
}

/// `mediaAccessStatusForPane`.
pub fn media_access_status_for_pane(
    media_access: Option<&MediaAccessSnapshot>,
    pane: SystemPermissionPane,
) -> Option<MediaAccessStatus> {
    let snapshot = media_access?;
    pane.permission()
        .map(|permission| snapshot.for_permission(permission))
}

/// `isMediaAccessSnapshotReady`.
pub fn is_media_access_snapshot_ready(media_access: Option<&MediaAccessSnapshot>) -> bool {
    media_access.is_some_and(|snapshot| {
        snapshot.camera != MediaAccessStatus::Unknown
            && snapshot.microphone != MediaAccessStatus::Unknown
    })
}

fn screen_devices(devices: &[Device]) -> impl Iterator<Item = &Device> {
    devices
        .iter()
        .filter(|device| matches!(device.kind, DeviceKind::Screen | DeviceKind::Window))
}

/// `screenAccessState`: the backend's listing.
pub fn screen_access_state(devices: &[Device]) -> SystemAccessState {
    if screen_devices(devices).any(|device| device.status == DeviceStatus::PermissionRequired) {
        return SystemAccessState::NotGranted;
    }
    if screen_devices(devices).any(|device| {
        device.status == DeviceStatus::Available && device.id.contains("screencapturekit")
    }) {
        return SystemAccessState::Granted;
    }
    SystemAccessState::FirstUse
}

/// `cameraAccessState`.
pub fn camera_access_state(devices: &[Device]) -> SystemAccessState {
    let cameras = || {
        devices
            .iter()
            .filter(|device| device.kind == DeviceKind::Camera)
    };
    if cameras().any(|device| device.status == DeviceStatus::PermissionRequired) {
        return SystemAccessState::NotGranted;
    }
    if cameras().any(|device| device.status == DeviceStatus::Available) {
        return SystemAccessState::Granted;
    }
    SystemAccessState::FirstUse
}

/// `microphoneAccessState`: the meter's probe, never a guessed green.
pub fn microphone_access_state(audio_meter: Option<&AudioMeterResult>) -> SystemAccessState {
    match audio_meter.map(|meter| &meter.status) {
        None => SystemAccessState::FirstUse,
        Some(AudioMeterStatus::PermissionRequired) => SystemAccessState::NotGranted,
        Some(AudioMeterStatus::NoFrames) => SystemAccessState::DeviceIssue,
        Some(AudioMeterStatus::Ready | AudioMeterStatus::Silent) => SystemAccessState::Granted,
        Some(AudioMeterStatus::Unavailable) => SystemAccessState::FirstUse,
    }
}

/// `mediaAccessToState`.
pub fn media_access_to_state(status: Option<MediaAccessStatus>) -> SystemAccessState {
    match status {
        Some(MediaAccessStatus::Granted) => SystemAccessState::Granted,
        Some(MediaAccessStatus::Denied | MediaAccessStatus::Restricted) => {
            SystemAccessState::NotGranted
        }
        _ => SystemAccessState::FirstUse,
    }
}

fn windows_media_access_state(
    status: Option<MediaAccessStatus>,
    backend: SystemAccessState,
) -> SystemAccessState {
    match status {
        None | Some(MediaAccessStatus::Unknown) => backend,
        status => media_access_to_state(status),
    }
}

/// `macosMediaAccessState`: the TCC value decides never-asked against
/// denied; a grant still needs the backend's proof.
pub fn macos_media_access_state(
    status: Option<MediaAccessStatus>,
    backend: SystemAccessState,
) -> SystemAccessState {
    match status {
        Some(MediaAccessStatus::NotDetermined) => SystemAccessState::FirstUse,
        Some(MediaAccessStatus::Denied | MediaAccessStatus::Restricted) => {
            SystemAccessState::NotGranted
        }
        Some(MediaAccessStatus::Granted) => {
            if backend == SystemAccessState::Granted {
                SystemAccessState::Granted
            } else {
                SystemAccessState::DeviceIssue
            }
        }
        _ => backend,
    }
}

/// `systemAccessAction`: the row's button, or none. `pane` is the row's
/// pane, `None` for System audio (which never has one).
pub fn system_access_action(
    pane: Option<SystemPermissionPane>,
    state: Option<SystemAccessState>,
    platform: PermissionPlatform,
    media_access_status: Option<MediaAccessStatus>,
    checking: bool,
) -> Option<SystemAccessAction> {
    let pane = pane?;
    if checking || media_access_status == Some(MediaAccessStatus::Restricted) {
        return None;
    }
    if pane == SystemPermissionPane::ScreenRecording
        && state == Some(SystemAccessState::NeedsRelaunch)
    {
        return Some(SystemAccessAction::Relaunch);
    }
    if matches!(
        state,
        Some(SystemAccessState::NotRequired | SystemAccessState::Unavailable)
    ) {
        return None;
    }
    if state == Some(SystemAccessState::Waiting) {
        return Some(SystemAccessAction::OpenSettings);
    }
    if pane == SystemPermissionPane::Privacy {
        return Some(SystemAccessAction::OpenSettings);
    }
    let media = matches!(
        pane,
        SystemPermissionPane::Camera | SystemPermissionPane::Microphone
    );
    if media && media_access_status == Some(MediaAccessStatus::Granted) {
        return None;
    }
    if matches!(
        state,
        Some(SystemAccessState::Granted | SystemAccessState::DeviceIssue)
    ) {
        return None;
    }
    let mac = platform == PermissionPlatform::MacOs;
    if mac
        && media
        && state == Some(SystemAccessState::FirstUse)
        && media_access_status == Some(MediaAccessStatus::NotDetermined)
    {
        return Some(SystemAccessAction::RequestMediaAccess);
    }
    // Plan 203 S2: a never-asked screen is asked in place too; until the
    // request, Videorc isn't in the list System Settings shows.
    if mac
        && pane == SystemPermissionPane::ScreenRecording
        && media_access_status == Some(MediaAccessStatus::NotDetermined)
    {
        return Some(SystemAccessAction::RequestMediaAccess);
    }
    Some(SystemAccessAction::OpenSettings)
}

/// The row's own action (`systemAccessAction` with the row's pane and its
/// exact grant).
pub fn row_action(
    row: &SystemAccessRow,
    platform: PermissionPlatform,
    media_access: Option<&MediaAccessSnapshot>,
) -> Option<SystemAccessAction> {
    let pane = (row.id != SystemAccessRowId::SystemAudio).then(|| row.id.pane());
    system_access_action(
        pane,
        Some(row.state),
        platform,
        pane.and_then(|pane| media_access_status_for_pane(media_access, pane)),
        row.checking,
    )
}

/// `screenRecordingPaneName`: Darwin 24 is macOS 15, when Apple renamed it.
pub fn screen_recording_pane_name(os_release: Option<&str>) -> &'static str {
    let major = os_release
        .and_then(|release| {
            let digits: String = release
                .trim_start()
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            digits.parse::<u32>().ok()
        })
        .unwrap_or(0);
    if major >= 24 {
        "Screen & System Audio Recording"
    } else {
        "Screen Recording"
    }
}

/// `checkingAccessState`: a restart keeps a useful chip, never a stale
/// refusal from capture.
pub fn checking_access_state(previous: Option<SystemAccessState>) -> SystemAccessState {
    match previous {
        Some(SystemAccessState::NotGranted) => SystemAccessState::Waiting,
        Some(state) => state,
        None => SystemAccessState::FirstUse,
    }
}

/// `osSettingsName`.
pub fn os_settings_name(platform: PermissionPlatform) -> &'static str {
    match platform {
        PermissionPlatform::MacOs => "System Settings",
        PermissionPlatform::Windows => "Windows Settings",
        PermissionPlatform::Other => "system settings",
    }
}

/// `systemAccessRows`: four rows on macOS and Windows, none on Linux.
pub fn system_access_rows(input: &SystemAccessInput<'_>) -> Vec<SystemAccessRow> {
    let os = input.platform;
    if os == PermissionPlatform::Other {
        return Vec::new();
    }
    let windows = os == PermissionPlatform::Windows;
    let media = input.media_access;
    let backend_screen = screen_access_state(input.devices);
    let backend_camera = camera_access_state(input.devices);
    let backend_microphone = if input.audio_meter.is_none()
        && input.devices.iter().any(|device| {
            device.kind == DeviceKind::Microphone && device.status == DeviceStatus::Available
        }) {
        SystemAccessState::Granted
    } else {
        microphone_access_state(input.audio_meter)
    };
    let screen_status = media.map(|snapshot| snapshot.screen);
    let screen = if windows {
        SystemAccessState::NotRequired
    } else if screen_status == Some(MediaAccessStatus::Granted)
        && backend_screen == SystemAccessState::NotGranted
    {
        SystemAccessState::NeedsRelaunch
    } else {
        macos_media_access_state(screen_status, backend_screen)
    };
    let microphone_status = media.map(|snapshot| snapshot.microphone);
    let camera_status = media.map(|snapshot| snapshot.camera);
    let (microphone, camera) = if windows {
        (
            windows_media_access_state(microphone_status, backend_microphone),
            windows_media_access_state(camera_status, backend_camera),
        )
    } else {
        (
            macos_media_access_state(microphone_status, backend_microphone),
            macos_media_access_state(camera_status, backend_camera),
        )
    };
    let mut rows = vec![
        SystemAccessRow {
            id: SystemAccessRowId::ScreenRecording,
            label: "Screen Recording",
            purpose: "Record your displays and app windows.",
            state: screen,
            required: !windows,
            detail: String::new(),
            checking: false,
        },
        SystemAccessRow {
            id: SystemAccessRowId::SystemAudio,
            label: "System audio",
            purpose: if windows {
                "The sound your PC plays: games, music and calls."
            } else {
                "The sound your Mac plays: games, music and calls."
            },
            state: screen,
            required: false,
            detail: String::new(),
            checking: false,
        },
        SystemAccessRow {
            id: SystemAccessRowId::Microphone,
            label: "Microphone",
            purpose: "Your voice in recordings, livestreams and captions.",
            state: microphone,
            required: true,
            detail: String::new(),
            checking: false,
        },
        SystemAccessRow {
            id: SystemAccessRowId::Camera,
            label: "Camera",
            purpose: "Put yourself in your scenes.",
            state: camera,
            required: false,
            detail: String::new(),
            checking: false,
        },
    ];
    let target = input.permission_target_name;
    let context = &input.context;
    for row in &mut rows {
        let pane = row.id.pane();
        let status = media_access_status_for_pane(media, pane);
        row.checking = !windows
            && status == Some(MediaAccessStatus::Granted)
            && (context.capture_restarting
                || (pane == SystemPermissionPane::ScreenRecording && context.screen_grant_stale));
        if row.checking {
            let previous = context
                .last_known_states
                .iter()
                .find(|(id, _)| *id == row.id)
                .map(|(_, state)| *state);
            row.state = checking_access_state(previous);
            continue;
        }
        if !windows
            && context.pending_pane == Some(pane)
            && status != Some(MediaAccessStatus::Granted)
            && status != Some(MediaAccessStatus::Restricted)
        {
            row.state = SystemAccessState::Waiting;
        }
        let pane_name = if pane == SystemPermissionPane::ScreenRecording {
            screen_recording_pane_name(input.os_release)
        } else {
            row.label
        };
        row.detail = if row.state == SystemAccessState::Waiting {
            format!(
                "Turn on {target} in System Settings → Privacy & Security → {pane_name}, then come back here."
            )
        } else if row.state == SystemAccessState::NeedsRelaunch {
            "macOS turns this on after Videorc reopens.".to_string()
        } else if os == PermissionPlatform::MacOs && status == Some(MediaAccessStatus::Restricted) {
            "Restricted by macOS policy and may not be changeable here.".to_string()
        } else if windows && row.state == SystemAccessState::NotRequired {
            "Windows doesn't ask for this.".to_string()
        } else if row.state == SystemAccessState::NotGranted && !windows {
            format!(
                "System Settings is blocking {pane_name}. Turn on {target} in System Settings → Privacy & Security → {pane_name}."
            )
        } else if row.state == SystemAccessState::DeviceIssue {
            match row.id {
                SystemAccessRowId::Camera => "Granted, but no camera is connected.",
                SystemAccessRowId::Microphone => {
                    "Microphone permission is granted, but no usable input is currently available."
                }
                _ => "Granted, but no display or app window is available.",
            }
            .to_string()
        } else if row.state == SystemAccessState::Granted && row.id == SystemAccessRowId::Camera {
            input
                .devices
                .iter()
                .find(|device| {
                    device.kind == DeviceKind::Camera && device.status == DeviceStatus::Available
                })
                .map(|device| device.name.clone())
                .unwrap_or_default()
        } else if windows
            && matches!(
                row.state,
                SystemAccessState::NotGranted | SystemAccessState::FirstUse
            )
        {
            let noun = if row.id == SystemAccessRowId::Camera {
                "camera"
            } else {
                "microphone"
            };
            format!(
                "In {} → Privacy & security → {}, turn on access and “Let desktop apps access your {noun}”. Videorc is a desktop app, so it isn’t listed by name.",
                os_settings_name(os),
                row.label
            )
        } else {
            String::new()
        };
    }
    let audio_device = input
        .devices
        .iter()
        .find(|device| device.kind == DeviceKind::SystemAudio);
    let system_audio = &mut rows[1];
    if !system_audio.checking
        && (windows
            || screen_status == Some(MediaAccessStatus::Granted)
            || screen == SystemAccessState::Granted)
        && audio_device.is_some_and(|device| device.status == DeviceStatus::Unavailable)
    {
        system_audio.state = SystemAccessState::Unavailable;
        system_audio.detail = audio_device
            .and_then(|device| device.detail.clone())
            .unwrap_or_else(|| "System audio is not available on this computer.".to_string());
    } else if !system_audio.checking && !windows && system_audio.state != SystemAccessState::Granted
    {
        system_audio.detail = "Comes with Screen Recording.".to_string();
    }
    rows
}

/// `systemAccessStatus`: one word and one tone per state.
pub fn system_access_status(state: SystemAccessState) -> (&'static str, &'static str) {
    match state {
        SystemAccessState::Granted => ("Granted", "good"),
        SystemAccessState::NotGranted => ("Not granted", "warn"),
        SystemAccessState::DeviceIssue => ("Device issue", "warn"),
        SystemAccessState::FirstUse => ("Not asked yet", "neutral"),
        SystemAccessState::Waiting => ("Waiting", "neutral"),
        SystemAccessState::NeedsRelaunch => ("Reopen needed", "warn"),
        SystemAccessState::NotRequired => ("Ready", "good"),
        SystemAccessState::Unavailable => ("Not available", "neutral"),
    }
}

/// `systemAccessActionLabel`: the button, named for where it goes.
pub fn system_access_action_label(
    action: Option<SystemAccessAction>,
    platform: PermissionPlatform,
) -> Option<String> {
    match action? {
        SystemAccessAction::RequestMediaAccess => Some("Allow…".to_string()),
        SystemAccessAction::Relaunch => Some("Reopen Videorc".to_string()),
        SystemAccessAction::OpenSettings => Some(format!("Open {}…", os_settings_name(platform))),
    }
}

/// `systemAccessVisibleDetail`: a granted row needs none unless it names the
/// camera.
pub fn system_access_visible_detail(row: &SystemAccessRow) -> Option<&str> {
    if row.checking || row.detail.is_empty() {
        return None;
    }
    if row.state == SystemAccessState::Granted && row.id != SystemAccessRowId::Camera {
        return None;
    }
    Some(&row.detail)
}

/// The toasts `runSystemPermissionAction` shows.
pub mod copy {
    /// `Couldn't check ${label} permission`, for the camera and microphone.
    pub fn check_failed_title(label: &str) -> String {
        format!("Couldn't check {label} permission")
    }
    pub const CHECK_FAILED_DESCRIPTION: &str = "Try again before changing access.";
    pub const RELAUNCH_REFUSED_TITLE: &str = "Couldn't reopen Videorc";
    pub const RELAUNCH_REFUSED_ID: &str = "permission-relaunch-refused";
    pub const RELAUNCH_REFUSED_CAPTURE_ACTIVE: &str = "Finish your recording or livestream first.";
    pub const RELAUNCH_REFUSED_BUSY: &str = "Videorc is busy. Try again in a moment.";
}

#[cfg(test)]
mod tests {
    use super::*;
    use MediaAccessStatus::*;
    use PermissionPlatform::*;
    use SystemAccessState as S;

    fn device(id: &str, kind: DeviceKind, status: DeviceStatus) -> Device {
        let mut device: Device = serde_json::from_value(serde_json::json!({
            "id": id,
            "name": format!("{id} name"),
            "kind": "camera",
            "status": "available",
        }))
        .unwrap();
        device.kind = kind;
        device.status = status;
        device
    }

    fn meter(status: AudioMeterStatus) -> AudioMeterResult {
        AudioMeterResult {
            status,
            level: None,
            peak_db: None,
            mean_db: None,
            message: None,
        }
    }

    fn rows(
        devices: &[Device],
        audio_meter: Option<&AudioMeterResult>,
        platform: PermissionPlatform,
        media_access: Option<&MediaAccessSnapshot>,
        context: SystemAccessContext,
    ) -> Vec<SystemAccessRow> {
        system_access_rows(&SystemAccessInput {
            devices,
            audio_meter,
            platform,
            os_release: Some("25.5.0"),
            permission_target_name: "Videorc",
            media_access,
            context,
        })
    }

    fn snapshot(
        camera: MediaAccessStatus,
        microphone: MediaAccessStatus,
        screen: MediaAccessStatus,
    ) -> MediaAccessSnapshot {
        MediaAccessSnapshot {
            camera,
            microphone,
            screen,
        }
    }

    #[test]
    fn the_backend_evidence_reads_honestly() {
        let blocked = device(
            "screen:screencapturekit-missing",
            DeviceKind::Screen,
            DeviceStatus::PermissionRequired,
        );
        let available = device(
            "screen:screencapturekit:1",
            DeviceKind::Screen,
            DeviceStatus::Available,
        );
        assert_eq!(
            screen_access_state(std::slice::from_ref(&blocked)),
            S::NotGranted
        );
        assert_eq!(
            screen_access_state(std::slice::from_ref(&available)),
            S::Granted
        );
        assert_eq!(screen_access_state(&[]), S::FirstUse);
        assert_eq!(
            camera_access_state(&[
                device("a", DeviceKind::Camera, DeviceStatus::PermissionRequired),
                device("b", DeviceKind::Camera, DeviceStatus::Available)
            ]),
            S::NotGranted
        );
        assert_eq!(microphone_access_state(None), S::FirstUse);
        assert_eq!(
            microphone_access_state(Some(&meter(AudioMeterStatus::PermissionRequired))),
            S::NotGranted
        );
        assert_eq!(
            microphone_access_state(Some(&meter(AudioMeterStatus::NoFrames))),
            S::DeviceIssue
        );
        assert_eq!(
            microphone_access_state(Some(&meter(AudioMeterStatus::Silent))),
            S::Granted
        );
        assert_eq!(media_access_to_state(Some(Restricted)), S::NotGranted);
        assert_eq!(media_access_to_state(Some(NotDetermined)), S::FirstUse);
        assert_eq!(media_access_to_state(None), S::FirstUse);
        assert!(!is_media_access_snapshot_ready(Some(&snapshot(
            Unknown, Granted, Granted
        ))));
        assert!(is_media_access_snapshot_ready(Some(&snapshot(
            Denied, Granted, Unknown
        ))));
    }

    #[test]
    fn four_macos_rows_with_purposes_and_the_blocking_sentence() {
        let devices = [
            device(
                "screen:screencapturekit:1",
                DeviceKind::Screen,
                DeviceStatus::Available,
            ),
            device("cam", DeviceKind::Camera, DeviceStatus::PermissionRequired),
        ];
        let rows = rows(&devices, None, MacOs, None, SystemAccessContext::default());
        let ids: Vec<_> = rows.iter().map(|row| row.id).collect();
        assert_eq!(
            ids,
            [
                SystemAccessRowId::ScreenRecording,
                SystemAccessRowId::SystemAudio,
                SystemAccessRowId::Microphone,
                SystemAccessRowId::Camera
            ]
        );
        assert_eq!(rows[0].state, S::Granted);
        assert_eq!(rows[3].state, S::NotGranted);
        assert_eq!(
            rows[3].detail,
            "System Settings is blocking Camera. Turn on Videorc in System Settings → Privacy & Security → Camera."
        );
        assert_eq!(rows[2].state, S::FirstUse);
        assert_eq!(rows[2].detail, "");
    }

    #[test]
    fn the_exact_tcc_value_decides_on_macos() {
        // This Mac on 2026-11-09: camera granted, microphone denied, screen granted.
        let devices = [
            device(
                "screen:screencapturekit:1",
                DeviceKind::Screen,
                DeviceStatus::Available,
            ),
            device("FaceTime", DeviceKind::Camera, DeviceStatus::Available),
        ];
        let media = snapshot(Granted, Denied, Granted);
        let rows = rows(
            &devices,
            None,
            MacOs,
            Some(&media),
            SystemAccessContext::default(),
        );
        assert_eq!(rows[0].state, S::Granted);
        assert_eq!(rows[2].state, S::NotGranted);
        assert_eq!(
            rows[2].detail,
            "System Settings is blocking Microphone. Turn on Videorc in System Settings → Privacy & Security → Microphone."
        );
        assert_eq!(
            row_action(&rows[2], MacOs, Some(&media)),
            Some(SystemAccessAction::OpenSettings)
        );
        assert_eq!(
            system_access_action_label(row_action(&rows[2], MacOs, Some(&media)), MacOs).as_deref(),
            Some("Open System Settings…")
        );
        assert_eq!(rows[3].state, S::Granted);
        assert_eq!(rows[3].detail, "FaceTime name");
        assert_eq!(
            system_access_visible_detail(&rows[3]),
            Some("FaceTime name")
        );
        assert_eq!(system_access_visible_detail(&rows[0]), None);
        assert_eq!(row_action(&rows[3], MacOs, Some(&media)), None);

        // A never-asked camera is asked in place.
        let fresh = snapshot(NotDetermined, NotDetermined, Denied);
        let rows = super::system_access_rows(&SystemAccessInput {
            devices: &[],
            audio_meter: None,
            platform: MacOs,
            os_release: Some("25.5.0"),
            permission_target_name: "Videorc",
            media_access: Some(&fresh),
            context: SystemAccessContext::default(),
        });
        assert_eq!(rows[3].state, S::FirstUse);
        assert_eq!(
            row_action(&rows[3], MacOs, Some(&fresh)),
            Some(SystemAccessAction::RequestMediaAccess)
        );
        assert_eq!(
            system_access_action_label(Some(SystemAccessAction::RequestMediaAccess), MacOs)
                .as_deref(),
            Some("Allow…")
        );
        assert_eq!(rows[0].state, S::NotGranted);
        assert_eq!(
            rows[0].detail,
            "System Settings is blocking Screen & System Audio Recording. Turn on Videorc in System Settings → Privacy & Security → Screen & System Audio Recording."
        );
        assert_eq!(rows[1].detail, "Comes with Screen Recording.");
    }

    #[test]
    fn a_screen_granted_after_launch_needs_a_reopen() {
        let devices = [device(
            "screen:screencapturekit-missing",
            DeviceKind::Screen,
            DeviceStatus::PermissionRequired,
        )];
        let media = snapshot(Granted, Granted, Granted);
        let rows = rows(
            &devices,
            None,
            MacOs,
            Some(&media),
            SystemAccessContext::default(),
        );
        assert_eq!(rows[0].state, S::NeedsRelaunch);
        assert_eq!(rows[0].detail, "macOS turns this on after Videorc reopens.");
        assert_eq!(
            row_action(&rows[0], MacOs, Some(&media)),
            Some(SystemAccessAction::Relaunch)
        );
        assert_eq!(
            system_access_action_label(Some(SystemAccessAction::Relaunch), MacOs).as_deref(),
            Some("Reopen Videorc")
        );
        assert_eq!(
            system_access_status(S::NeedsRelaunch),
            ("Reopen needed", "warn")
        );
        // System audio rides the screen's grant but never offers a button.
        assert_eq!(row_action(&rows[1], MacOs, Some(&media)), None);
    }

    #[test]
    fn waiting_and_checking_rows() {
        let media = snapshot(Denied, Granted, Denied);
        let rows = rows(
            &[],
            None,
            MacOs,
            Some(&media),
            SystemAccessContext {
                pending_pane: Some(SystemPermissionPane::Camera),
                ..SystemAccessContext::default()
            },
        );
        assert_eq!(rows[3].state, S::Waiting);
        assert_eq!(
            rows[3].detail,
            "Turn on Videorc in System Settings → Privacy & Security → Camera, then come back here."
        );
        assert_eq!(
            row_action(&rows[3], MacOs, Some(&media)),
            Some(SystemAccessAction::OpenSettings)
        );

        let rows = super::system_access_rows(&SystemAccessInput {
            devices: &[],
            audio_meter: None,
            platform: MacOs,
            os_release: Some("23.0.0"),
            permission_target_name: "Videorc",
            media_access: Some(&media),
            context: SystemAccessContext {
                capture_restarting: true,
                last_known_states: vec![(SystemAccessRowId::Microphone, S::NotGranted)],
                ..SystemAccessContext::default()
            },
        });
        assert!(rows[2].checking);
        assert_eq!(rows[2].state, S::Waiting);
        assert_eq!(system_access_visible_detail(&rows[2]), None);
        assert_eq!(row_action(&rows[2], MacOs, Some(&media)), None);
        assert_eq!(
            screen_recording_pane_name(Some("23.0.0")),
            "Screen Recording"
        );
    }

    #[test]
    fn restricted_says_so_and_offers_nothing() {
        let media = snapshot(Restricted, Granted, Granted);
        let rows = rows(
            &[],
            None,
            MacOs,
            Some(&media),
            SystemAccessContext::default(),
        );
        assert_eq!(
            rows[3].detail,
            "Restricted by macOS policy and may not be changeable here."
        );
        assert_eq!(row_action(&rows[3], MacOs, Some(&media)), None);
    }

    #[test]
    fn windows_rows_follow_the_os_and_never_say_macos() {
        let devices = [device("cam", DeviceKind::Camera, DeviceStatus::Available)];
        let unavailable = meter(AudioMeterStatus::Unavailable);
        let media = snapshot(Granted, Denied, NotApplicable);
        let rows = rows(
            &devices,
            Some(&unavailable),
            Windows,
            Some(&media),
            SystemAccessContext::default(),
        );
        assert_eq!(rows[0].state, S::NotRequired);
        assert_eq!(rows[0].detail, "Windows doesn't ask for this.");
        assert_eq!(rows[3].state, S::Granted);
        assert_eq!(rows[2].state, S::NotGranted);
        assert_eq!(
            rows[2].detail,
            "In Windows Settings → Privacy & security → Microphone, turn on access and “Let desktop apps access your microphone”. Videorc is a desktop app, so it isn’t listed by name."
        );
        for row in &rows {
            assert!(!row.detail.contains("macOS") && !row.detail.contains("System Settings"));
        }
        assert_eq!(
            system_access_action_label(row_action(&rows[2], Windows, Some(&media)), Windows)
                .as_deref(),
            Some("Open Windows Settings…")
        );
    }

    #[test]
    fn linux_has_no_rows() {
        let media = snapshot(NotApplicable, NotApplicable, NotApplicable);
        assert!(
            rows(
                &[],
                None,
                Other,
                Some(&media),
                SystemAccessContext::default()
            )
            .is_empty()
        );
    }

    #[test]
    fn the_action_table_matches_the_renderer() {
        let cam = Some(SystemPermissionPane::Camera);
        let mic = Some(SystemPermissionPane::Microphone);
        let screen = Some(SystemPermissionPane::ScreenRecording);
        let privacy = Some(SystemPermissionPane::Privacy);
        assert_eq!(
            system_access_action(cam, Some(S::FirstUse), MacOs, Some(NotDetermined), false),
            Some(SystemAccessAction::RequestMediaAccess)
        );
        assert_eq!(
            system_access_action(mic, Some(S::FirstUse), MacOs, Some(NotDetermined), false),
            Some(SystemAccessAction::RequestMediaAccess)
        );
        assert_eq!(
            system_access_action(cam, Some(S::NotGranted), MacOs, None, false),
            Some(SystemAccessAction::OpenSettings)
        );
        assert_eq!(
            system_access_action(screen, Some(S::FirstUse), MacOs, None, false),
            Some(SystemAccessAction::OpenSettings)
        );
        assert_eq!(
            system_access_action(privacy, Some(S::FirstUse), MacOs, None, false),
            Some(SystemAccessAction::OpenSettings)
        );
        assert_eq!(
            system_access_action(cam, Some(S::FirstUse), Windows, None, false),
            Some(SystemAccessAction::OpenSettings)
        );
        assert_eq!(
            system_access_action(cam, Some(S::Granted), MacOs, None, false),
            None
        );
        assert_eq!(
            system_access_action(mic, Some(S::DeviceIssue), MacOs, None, false),
            None
        );
        assert_eq!(
            system_access_action(mic, Some(S::FirstUse), MacOs, Some(Granted), false),
            None
        );
        assert_eq!(
            system_access_action(mic, Some(S::FirstUse), MacOs, Some(Unknown), false),
            Some(SystemAccessAction::OpenSettings)
        );
        assert_eq!(
            system_access_action(
                screen,
                Some(S::NotGranted),
                MacOs,
                Some(NotDetermined),
                false
            ),
            Some(SystemAccessAction::RequestMediaAccess)
        );
        assert_eq!(
            system_access_action(screen, Some(S::NotGranted), MacOs, Some(Denied), false),
            Some(SystemAccessAction::OpenSettings)
        );
        assert_eq!(
            system_access_action(screen, Some(S::Granted), MacOs, Some(Granted), false),
            None
        );
        assert_eq!(
            system_access_action(
                screen,
                Some(S::NotGranted),
                Windows,
                Some(NotDetermined),
                false
            ),
            Some(SystemAccessAction::OpenSettings)
        );
        assert_eq!(
            system_access_action(None, Some(S::NotGranted), MacOs, None, false),
            None
        );
        assert_eq!(
            system_access_action(cam, Some(S::NotGranted), MacOs, None, true),
            None
        );
    }

    #[test]
    fn the_renderer_sources_still_say_the_same() {
        let access = include_str!("../../../../apps/desktop/src/renderer/src/lib/system-access.ts");
        for sentence in [
            "Record your displays and app windows.",
            "The sound your Mac plays: games, music and calls.",
            "The sound your PC plays: games, music and calls.",
            "Your voice in recordings, livestreams and captions.",
            "Put yourself in your scenes.",
            "macOS turns this on after Videorc reopens.",
            "Restricted by macOS policy and may not be changeable here.",
            "Windows doesn't ask for this.",
            "Granted, but no camera is connected.",
            "Microphone permission is granted, but no usable input is currently available.",
            "Granted, but no display or app window is available.",
            "System audio is not available on this computer.",
            "Comes with Screen Recording.",
            "Screen & System Audio Recording",
            "then come back here.",
            "Videorc is a desktop app, so it isn’t listed by name.",
        ] {
            assert!(access.contains(sentence), "{sentence}");
        }
        let view =
            include_str!("../../../../apps/desktop/src/renderer/src/lib/system-access-view.ts");
        for word in [
            "Not asked yet",
            "Reopen needed",
            "Device issue",
            "'Allow…'",
            "'Reopen Videorc'",
        ] {
            assert!(view.contains(word), "{word}");
        }
        let orchestration = include_str!(
            "../../../../apps/desktop/src/renderer/src/lib/system-permission-orchestration.ts"
        );
        for sentence in [
            copy::CHECK_FAILED_DESCRIPTION,
            copy::RELAUNCH_REFUSED_TITLE,
            copy::RELAUNCH_REFUSED_ID,
            copy::RELAUNCH_REFUSED_CAPTURE_ACTIVE,
            copy::RELAUNCH_REFUSED_BUSY,
        ] {
            assert!(orchestration.contains(sentence), "{sentence}");
        }
        assert!(orchestration.contains("`Couldn't check ${label} permission`"));
    }
}
