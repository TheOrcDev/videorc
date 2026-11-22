//! Plan 258 S4 (D12): the operating system's own camera effects.
//!
//! macOS Video Effects (Portrait, background replacement, Studio Light) and
//! Windows Studio Effects run inside the system's camera pipeline, before
//! Videorc sees a frame. The picture alone can't tell them apart from the
//! room, so Videorc asks the device it has open:
//!
//! - **macOS:** `AVCaptureDevice`'s `isPortraitEffectActive` (macOS 12),
//!   `isStudioLightActive` (macOS 13) and `isBackgroundReplacementActive`
//!   (macOS 15), read every [`MACOS_POLL_INTERVAL`] on the camera's own
//!   thread. Apps can't turn these off; the Studio says so, and where.
//! - **Windows:** `KSPROPERTY_CAMERACONTROL_EXTENDED_BACKGROUNDSEGMENTATION`
//!   through Media Foundation's extended camera controller, read at camera
//!   start and every [`WINDOWS_POLL_INTERVAL`] after. While Videorc's own
//!   background effect runs on the camera, the blur is turned off at camera
//!   start, as Microsoft asks of apps with their own blur, and put back when
//!   the camera stops. With Videorc's effect Off it is never touched.
//!
//! What Videorc turned off is written to [`STUDIO_EFFECTS_RESTORE_KEY`]
//! before the write and cleared after the restore, so a crash or a forced
//! quit still gives the streamer their blur back at the next launch.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::protocol::{CameraSystemEffect, CameraSystemEffectProvider};
use crate::storage::Database;

/// How often the macOS camera thread reads the device's effect flags. The
/// reads are property getters on an open device (no I/O), and a second is
/// quicker than anyone finds the Studio after flipping the Video menu.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const MACOS_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// How often a Windows camera with Studio Effects is read again. Each read
/// opens the camera's controls through Media Foundation (about 50 ms
/// measured for the low-light control), so it runs far less often than on
/// macOS, and never again on a camera that has no Studio Effects.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const WINDOWS_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// How long a Windows camera session waits before its first Studio Effects
/// read, so FFmpeg's DirectShow capture has the camera open first.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const WINDOWS_FIRST_READ_DELAY: Duration = Duration::from_secs(1);

/// Camera id → what Videorc wrote and what to put back, for every camera
/// whose Studio Effects blur Videorc turned off and has not restored yet.
pub const STUDIO_EFFECTS_RESTORE_KEY: &str = "camera.studioEffectsRestore";

/// `KSCAMERA_EXTENDEDPROP_BACKGROUNDSEGMENTATION_BLUR`: standard blur.
pub const BACKGROUND_SEGMENTATION_BLUR: u64 = 1;
/// `KSCAMERA_EXTENDEDPROP_BACKGROUNDSEGMENTATION_MASK`: the driver attaches a
/// segmentation mask as frame metadata. The picture doesn't change, so the
/// decisions never name it; the tests use it to prove it is kept.
#[cfg_attr(not(test), allow(dead_code))]
pub const BACKGROUND_SEGMENTATION_MASK: u64 = 2;
/// `KSCAMERA_EXTENDEDPROP_BACKGROUNDSEGMENTATION_SHALLOWFOCUS`: portrait blur
/// (set together with the blur flag).
pub const BACKGROUND_SEGMENTATION_SHALLOW_FOCUS: u64 = 4;
/// The flags that change the picture.
const BACKGROUND_BLUR_FLAGS: u64 =
    BACKGROUND_SEGMENTATION_BLUR | BACKGROUND_SEGMENTATION_SHALLOW_FOCUS;

/// What the camera thread is told to do with Windows Studio Effects for one
/// camera session. Off Windows nothing reads it.
#[derive(Clone, Default)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub struct StudioEffectsPolicy {
    /// True while Videorc's own background effect runs on this camera: the
    /// Studio Effects blur is turned off at start (D12). The Windows stage
    /// (plan 258 S10) sets it; until then Videorc's effect never runs on
    /// Windows, so the blur is only reported.
    pub turn_off_background_blur: bool,
    /// Where a turn-off is recorded until it is put back. `None` in unit
    /// tests that never touch a device.
    pub restore_ledger: Option<Database>,
}

/// macOS: the device's flags as the status reports them.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub fn macos_effect(
    portrait: bool,
    background_replacement: bool,
    studio_light: bool,
) -> CameraSystemEffect {
    CameraSystemEffect {
        provider: CameraSystemEffectProvider::MacosVideoEffects,
        background_blur: portrait,
        background_replacement,
        studio_light,
        turned_off_by_videorc: false,
    }
}

/// Windows: the camera's background segmentation flags as the status reports
/// them.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
pub fn windows_effect(flags: u64, turned_off_by_videorc: bool) -> CameraSystemEffect {
    CameraSystemEffect {
        provider: CameraSystemEffectProvider::WindowsStudioEffects,
        background_blur: flags & BACKGROUND_BLUR_FLAGS != 0,
        background_replacement: false,
        studio_light: false,
        turned_off_by_videorc,
    }
}

/// What to do with a Windows camera's Studio Effects as it opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StudioEffectsStart {
    /// The camera can't blur its background (no Studio Effects, or the
    /// driver offers only the mask): nothing to report or change.
    Unsupported,
    /// Leave the camera as it is and report `flags`.
    Leave { flags: u64 },
    /// Write `write` now and put `restore` back when the camera stops.
    TurnOff { write: u64, restore: u64 },
}

/// The start decision from the control's capabilities and current flags.
/// The blur is turned off only while Videorc's own effect runs and the
/// camera is blurring; the mask flag is kept, since it doesn't change the
/// picture and another part of the system may want it.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
pub fn studio_effects_start(
    capabilities: u64,
    flags: u64,
    videorc_effect_running: bool,
) -> StudioEffectsStart {
    if capabilities & BACKGROUND_BLUR_FLAGS == 0 {
        return StudioEffectsStart::Unsupported;
    }
    if videorc_effect_running && flags & BACKGROUND_BLUR_FLAGS != 0 {
        StudioEffectsStart::TurnOff {
            write: flags & !BACKGROUND_BLUR_FLAGS,
            restore: flags,
        }
    } else {
        StudioEffectsStart::Leave { flags }
    }
}

/// The flags to write when the camera stops, if any. Put back only when the
/// camera still holds what Videorc wrote: someone who turned the blur back
/// on (or changed it) during the session keeps their own choice.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
pub fn studio_effects_restore(current: u64, written: u64, restore: u64) -> Option<u64> {
    (current == written && current != restore).then_some(restore)
}

/// One owed restore: what Videorc wrote, and what the camera held before.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwedRestore {
    pub written: u64,
    pub restore: u64,
}

type RestoreLedger = BTreeMap<String, OwedRestore>;

/// Every owed restore. An unreadable ledger reads as empty: the worst case
/// is one camera left as Videorc set it, which the streamer can turn back
/// on in Quick Settings, and refusing would block every camera start.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
fn load_ledger(database: &Database) -> RestoreLedger {
    database
        .load_setting::<RestoreLedger>(STUDIO_EFFECTS_RESTORE_KEY)
        .map_err(|error| tracing::warn!("Studio Effects restore ledger unreadable: {error}"))
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// Records (or with `None`, clears) the restore owed to `camera_id`.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
fn set_owed_restore(
    database: &Database,
    camera_id: &str,
    owed: Option<OwedRestore>,
) -> anyhow::Result<()> {
    static LEDGER_WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _serialized = LEDGER_WRITES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut ledger = load_ledger(database);
    match owed {
        Some(owed) => {
            ledger.insert(camera_id.to_string(), owed);
        }
        None => {
            if ledger.remove(camera_id).is_none() {
                return Ok(());
            }
        }
    }
    if ledger.is_empty() {
        database.delete_setting(STUDIO_EFFECTS_RESTORE_KEY)
    } else {
        database.save_setting(STUDIO_EFFECTS_RESTORE_KEY, &ledger)
    }
}

/// The camera's background segmentation control, as the Windows module
/// reads and writes it. Tests pass a double.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
pub trait SegmentationControl {
    /// `(capabilities, flags)`, or why the camera has no such control
    /// (`Ok(None)`) or did not answer (`Err`).
    fn read(&mut self) -> Result<Option<(u64, u64)>, String>;
    /// Writes `flags` and commits them.
    fn write(&mut self, flags: u64) -> Result<(), String>;
}

/// What a session's start left on the camera.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StudioEffectsSession {
    /// No Studio Effects blur on this camera: stop asking.
    Unsupported,
    /// Reported; `owed` is set when Videorc turned the blur off.
    Active {
        effect: CameraSystemEffect,
        owed: Option<OwedRestore>,
    },
}

/// Puts back what an earlier session (one that crashed or was force-quit)
/// turned off on this camera, if the camera still holds Videorc's write.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
pub fn settle_owed_restore(
    control: &mut dyn SegmentationControl,
    ledger: Option<&Database>,
    camera_id: &str,
) {
    let Some(database) = ledger else { return };
    let Some(owed) = load_ledger(database).get(camera_id).copied() else {
        return;
    };
    match control.read() {
        Ok(Some((_, current))) => {
            if let Some(flags) = studio_effects_restore(current, owed.written, owed.restore)
                && let Err(error) = control.write(flags)
            {
                tracing::warn!(camera = %camera_id, "Studio Effects blur not put back: {error}");
                return;
            }
            tracing::info!(camera = %camera_id, "Studio Effects blur from an earlier session settled");
        }
        // The camera lost the control: nothing left to put back.
        Ok(None) => {}
        // Try again at the next open or launch.
        Err(error) => {
            tracing::warn!(camera = %camera_id, "Studio Effects blur not put back yet: {error}");
            return;
        }
    }
    if let Err(error) = set_owed_restore(database, camera_id, None) {
        tracing::warn!("Studio Effects restore ledger not cleared: {error}");
    }
}

/// The start of a camera session: settle any restore owed from before, read
/// the control, and turn the blur off when the policy asks and the camera
/// blurs. The turn-off is recorded before it is written.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
pub fn start_studio_effects_session(
    control: &mut dyn SegmentationControl,
    policy: &StudioEffectsPolicy,
    camera_id: &str,
) -> Result<StudioEffectsSession, String> {
    settle_owed_restore(control, policy.restore_ledger.as_ref(), camera_id);
    let Some((capabilities, flags)) = control.read()? else {
        return Ok(StudioEffectsSession::Unsupported);
    };
    match studio_effects_start(capabilities, flags, policy.turn_off_background_blur) {
        StudioEffectsStart::Unsupported => Ok(StudioEffectsSession::Unsupported),
        StudioEffectsStart::Leave { flags } => Ok(StudioEffectsSession::Active {
            effect: windows_effect(flags, false),
            owed: None,
        }),
        StudioEffectsStart::TurnOff { write, restore } => {
            let owed = OwedRestore {
                written: write,
                restore,
            };
            // Without a ledger entry a crash would leave the streamer's blur
            // off for good, so no ledger, no write.
            let Some(database) = policy.restore_ledger.as_ref() else {
                return Ok(StudioEffectsSession::Active {
                    effect: windows_effect(flags, false),
                    owed: None,
                });
            };
            if let Err(error) = set_owed_restore(database, camera_id, Some(owed)) {
                tracing::warn!(
                    camera = %camera_id,
                    "Studio Effects blur left on: its restore could not be recorded: {error}"
                );
                return Ok(StudioEffectsSession::Active {
                    effect: windows_effect(flags, false),
                    owed: None,
                });
            }
            match control.write(write) {
                Ok(()) => {
                    tracing::info!(
                        camera = %camera_id,
                        "Studio Effects blur turned off while Videorc's background effect runs"
                    );
                    Ok(StudioEffectsSession::Active {
                        effect: windows_effect(write, true),
                        owed: Some(owed),
                    })
                }
                Err(error) => {
                    let _ = set_owed_restore(database, camera_id, None);
                    tracing::warn!(camera = %camera_id, "Studio Effects blur not turned off: {error}");
                    Ok(StudioEffectsSession::Active {
                        effect: windows_effect(flags, false),
                        owed: None,
                    })
                }
            }
        }
    }
}

/// What one read during the session found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StudioEffectsPoll {
    /// The flags as they are now, for the status.
    Effect(CameraSystemEffect),
    /// The camera answered that it has no such control: stop asking.
    Unsupported,
    /// The read failed this time (driver, Media Foundation, the camera
    /// unplugged); ask again at the next poll.
    Failed,
}

/// A later read during the session: the flags as they are now. A blur the
/// streamer turned back on is reported, never fought. When the camera holds
/// anything but Videorc's write, the streamer changed it themselves, so
/// Videorc gives up its restore (and the ledger entry): stop then leaves the
/// camera as they set it, even if they later go back to Off.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
pub fn poll_studio_effects(
    control: &mut dyn SegmentationControl,
    owed: &mut Option<OwedRestore>,
    ledger: Option<&Database>,
    camera_id: &str,
) -> StudioEffectsPoll {
    match control.read() {
        Ok(Some((_, flags))) => {
            if owed.is_some_and(|owed| owed.written != flags) {
                *owed = None;
                if let Some(database) = ledger
                    && let Err(error) = set_owed_restore(database, camera_id, None)
                {
                    tracing::warn!("Studio Effects restore ledger not cleared: {error}");
                }
                tracing::info!(
                    camera = %camera_id,
                    "Studio Effects changed by the streamer; Videorc will not put its blur back"
                );
            }
            StudioEffectsPoll::Effect(windows_effect(flags, owed.is_some()))
        }
        Ok(None) => StudioEffectsPoll::Unsupported,
        Err(error) => {
            tracing::debug!("Studio Effects read failed: {error}");
            StudioEffectsPoll::Failed
        }
    }
}

/// The end of a session: put the blur back when Videorc turned it off and
/// the camera still holds Videorc's write, then clear the ledger entry. A
/// failed read keeps the entry, so the next open or launch tries again.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
pub fn finish_studio_effects_session(
    control: &mut dyn SegmentationControl,
    policy: &StudioEffectsPolicy,
    camera_id: &str,
    owed: Option<OwedRestore>,
) {
    if owed.is_some() {
        settle_owed_restore(control, policy.restore_ledger.as_ref(), camera_id);
    }
}

/// At launch: put back every blur an earlier run turned off and never
/// restored (it crashed or was force-quit). Runs on its own thread so a
/// stalled driver never holds up the backend's start.
pub fn settle_owed_restores_at_launch(database: &Database) {
    #[cfg(target_os = "windows")]
    {
        if cfg!(test) || load_ledger(database).is_empty() {
            return;
        }
        let database = database.clone();
        let spawned = std::thread::Builder::new()
            .name("videorc-studio-effects-restore".to_string())
            .spawn(move || {
                for camera_id in load_ledger(&database).into_keys() {
                    windows_device::settle(&database, &camera_id);
                }
            });
        if let Err(error) = spawned {
            tracing::warn!("Studio Effects restore did not start: {error}");
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = database;
}

#[cfg(target_os = "windows")]
pub mod windows_device {
    //! The real control: Media Foundation's extended camera controller on
    //! the camera FFmpeg opens by its DirectShow name. The frame server
    //! shares the device, so this opens its controls beside a running
    //! FFmpeg capture without taking it over (as the low-light control does).

    use super::{
        SegmentationControl, StudioEffectsPolicy, StudioEffectsPoll, StudioEffectsSession,
        WINDOWS_FIRST_READ_DELAY, WINDOWS_POLL_INTERVAL, finish_studio_effects_session,
        poll_studio_effects, settle_owed_restore, start_studio_effects_session,
    };
    use crate::camera_low_light::windows_device::{CameraLookupError, MatchingCameras};
    use crate::protocol::CameraSystemEffect;
    use crate::storage::Database;
    use windows::Win32::Media::KernelStreaming::KSPROPERTY_CAMERACONTROL_EXTENDED_BACKGROUNDSEGMENTATION;
    use windows::Win32::Media::MediaFoundation::{
        IMFExtendedCameraController, IMFGetService, IMFMediaSource, MF_CAPTURE_ENGINE_MEDIASOURCE,
    };
    use windows::core::{GUID, Interface};

    /// Whether a failed controller call means the camera has no such
    /// control (rather than failing this time).
    fn means_unsupported(error: &windows::core::Error) -> bool {
        const E_NOINTERFACE: u32 = 0x8000_4002;
        const MF_E_UNSUPPORTED_SERVICE: u32 = 0xC00D_36BA;
        const E_PROP_ID_UNSUPPORTED: u32 = 0x8007_0490;
        const E_PROP_SET_UNSUPPORTED: u32 = 0x8007_0492;
        const HRESULT_ERROR_NOT_SUPPORTED: u32 = 0x8007_0032;
        const E_NOTIMPL: u32 = 0x8000_4001;
        matches!(
            error.code().0 as u32,
            E_NOINTERFACE
                | MF_E_UNSUPPORTED_SERVICE
                | E_PROP_ID_UNSUPPORTED
                | E_PROP_SET_UNSUPPORTED
                | HRESULT_ERROR_NOT_SUPPORTED
                | E_NOTIMPL
        )
    }

    /// The Studio Effects control of every camera with this DirectShow
    /// name, opened for one read or write pass.
    struct DeviceControl {
        device_name: String,
    }

    impl DeviceControl {
        /// Runs `each` on each matching camera until one answers `Some`;
        /// `each` answers `None` when that camera lacks the property, so a
        /// second camera of the same name is still asked. `Ok(None)` means
        /// every connected match lacks it. A camera that is not connected
        /// is an error, worth retrying, never "no control": a restore owed
        /// to an unplugged camera must survive until it is back.
        fn with_controller<R>(
            &self,
            mut each: impl FnMut(&IMFExtendedCameraController) -> Result<Option<R>, String>,
        ) -> Result<Option<R>, String> {
            let cameras = match MatchingCameras::open(&self.device_name) {
                Ok(cameras) => cameras,
                Err(CameraLookupError::NotConnected(reason)) => return Err(reason),
                Err(CameraLookupError::Failed(reason)) => return Err(reason),
            };
            let mut last_error = None;
            for activate in &cameras.activates {
                let source: IMFMediaSource = match unsafe { activate.ActivateObject() } {
                    Ok(source) => source,
                    Err(error) => {
                        last_error = Some(format!("the camera did not open its controls: {error}"));
                        continue;
                    }
                };
                let controller = source.cast::<IMFGetService>().and_then(|service| unsafe {
                    service.GetService::<IMFExtendedCameraController>(&GUID::zeroed())
                });
                let outcome = match controller {
                    Ok(controller) => Some(each(&controller)),
                    Err(error) if means_unsupported(&error) => None,
                    Err(error) => Some(Err(format!(
                        "the camera's extended controls did not open: {error}"
                    ))),
                };
                let _ = unsafe { source.Shutdown() };
                match outcome {
                    Some(Ok(Some(value))) => return Ok(Some(value)),
                    Some(Err(error)) => last_error = Some(error),
                    Some(Ok(None)) | None => {}
                }
            }
            match last_error {
                Some(error) => Err(error),
                None => Ok(None),
            }
        }
    }

    impl SegmentationControl for DeviceControl {
        fn read(&mut self) -> Result<Option<(u64, u64)>, String> {
            let read = self.with_controller(|controller| {
                match unsafe {
                    controller.GetExtendedCameraControl(
                        MF_CAPTURE_ENGINE_MEDIASOURCE.0,
                        KSPROPERTY_CAMERACONTROL_EXTENDED_BACKGROUNDSEGMENTATION.0 as u32,
                    )
                } {
                    Ok(control) => Ok(Some(unsafe {
                        (control.GetCapabilities(), control.GetFlags())
                    })),
                    Err(error) if means_unsupported(&error) => Ok(None),
                    Err(error) => Err(format!("background segmentation did not answer: {error}")),
                }
            })?;
            Ok(read)
        }

        fn write(&mut self, flags: u64) -> Result<(), String> {
            let written = self.with_controller(|controller| {
                let control = unsafe {
                    controller.GetExtendedCameraControl(
                        MF_CAPTURE_ENGINE_MEDIASOURCE.0,
                        KSPROPERTY_CAMERACONTROL_EXTENDED_BACKGROUNDSEGMENTATION.0 as u32,
                    )
                };
                let control = match control {
                    Ok(control) => control,
                    // This camera lacks it; a same-named one may have it.
                    Err(error) if means_unsupported(&error) => return Ok(None),
                    Err(error) => {
                        return Err(format!("background segmentation did not open: {error}"));
                    }
                };
                unsafe { control.SetFlags(flags) }
                    .and_then(|()| unsafe { control.CommitSettings() })
                    .map(Some)
                    .map_err(|error| format!("the camera refused the change: {error}"))
            })?;
            written.ok_or_else(|| "no camera of that name has the control".to_string())
        }
    }

    /// The control for the Windows camera `camera_id` names, or `None` when
    /// it is not a DirectShow camera.
    fn device_control(camera_id: &str) -> Option<DeviceControl> {
        crate::camera_capture::parse_windows_dshow_camera_id(camera_id)
            .map(|device_name| DeviceControl { device_name })
    }

    /// Runs a call, turning a panic in the driver into a failure.
    fn guarded<R>(call: impl FnOnce() -> R) -> Option<R> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(call)).ok()
    }

    /// Settles one camera's owed restore at launch.
    pub(super) fn settle(database: &Database, camera_id: &str) {
        let Some(mut control) = device_control(camera_id) else {
            return;
        };
        let _ = guarded(|| settle_owed_restore(&mut control, Some(database), camera_id));
    }

    /// One camera session's Studio Effects watch, run on its own thread from
    /// camera start until `stop_rx` answers (or its sender is gone): start
    /// (and maybe turn off), then a read every poll interval, then put back
    /// what was turned off. `publish` receives each answer for the camera's
    /// status. It may return early (no control, no camera); the capture
    /// never waits on it: the camera's stop is delivered on its own thread,
    /// so a driver call stalled here can't hold up stopping FFmpeg.
    pub fn watch_session(
        camera_id: &str,
        policy: &StudioEffectsPolicy,
        stop_rx: &std::sync::mpsc::Receiver<()>,
        mut publish: impl FnMut(Option<CameraSystemEffect>),
    ) {
        // Unit tests start cameras with made-up dshow names; they must never
        // touch a real camera on the machine running them.
        if cfg!(test) {
            return;
        }
        let Some(mut control) = device_control(camera_id) else {
            return;
        };
        // Let FFmpeg open the camera first, as the low-light write does: the
        // controls are opened beside a running capture, never ahead of it.
        if !matches!(
            stop_rx.recv_timeout(WINDOWS_FIRST_READ_DELAY),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ) {
            return;
        }
        let started = guarded(|| start_studio_effects_session(&mut control, policy, camera_id));
        let mut owed = match started {
            Some(Ok(StudioEffectsSession::Active { effect, owed })) => {
                publish(Some(effect));
                owed
            }
            // No Studio Effects on this camera: never ask again this session.
            Some(Ok(StudioEffectsSession::Unsupported)) => return,
            Some(Err(error)) => {
                tracing::debug!(camera = %camera_id, "Studio Effects not read: {error}");
                None
            }
            None => {
                tracing::warn!(camera = %camera_id, "Studio Effects read panicked");
                return;
            }
        };
        let ledger = policy.restore_ledger.as_ref();
        // Anything but a timeout (the stop, or the sender gone) ends it.
        while let Err(std::sync::mpsc::RecvTimeoutError::Timeout) =
            stop_rx.recv_timeout(WINDOWS_POLL_INTERVAL)
        {
            match guarded(|| poll_studio_effects(&mut control, &mut owed, ledger, camera_id)) {
                Some(StudioEffectsPoll::Effect(effect)) => publish(Some(effect)),
                // The camera has no such control after all: stop asking,
                // and owe nothing (there is nothing to put back).
                Some(StudioEffectsPoll::Unsupported) => {
                    publish(None);
                    if owed.is_none() {
                        return;
                    }
                }
                Some(StudioEffectsPoll::Failed) | None => {}
            }
        }
        let _ = guarded(|| finish_studio_effects_session(&mut control, policy, camera_id, owed));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A camera's background segmentation control, in memory.
    struct FakeControl {
        capabilities: u64,
        flags: u64,
        /// `Some` makes every read fail with this reason.
        read_error: Option<String>,
        write_error: Option<String>,
        /// `false` reads as a camera without the control.
        present: bool,
        writes: Vec<u64>,
    }

    impl FakeControl {
        fn studio_effects(flags: u64) -> Self {
            Self {
                capabilities: BACKGROUND_SEGMENTATION_BLUR
                    | BACKGROUND_SEGMENTATION_SHALLOW_FOCUS
                    | BACKGROUND_SEGMENTATION_MASK,
                flags,
                read_error: None,
                write_error: None,
                present: true,
                writes: Vec::new(),
            }
        }
    }

    impl SegmentationControl for FakeControl {
        fn read(&mut self) -> Result<Option<(u64, u64)>, String> {
            if let Some(error) = &self.read_error {
                return Err(error.clone());
            }
            Ok(self.present.then_some((self.capabilities, self.flags)))
        }

        fn write(&mut self, flags: u64) -> Result<(), String> {
            if let Some(error) = &self.write_error {
                return Err(error.clone());
            }
            self.writes.push(flags);
            self.flags = flags;
            Ok(())
        }
    }

    const PORTRAIT_BLUR: u64 = BACKGROUND_SEGMENTATION_BLUR | BACKGROUND_SEGMENTATION_SHALLOW_FOCUS;

    fn policy(turn_off: bool, database: &Database) -> StudioEffectsPolicy {
        StudioEffectsPolicy {
            turn_off_background_blur: turn_off,
            restore_ledger: Some(database.clone()),
        }
    }

    #[test]
    fn macos_flags_map_onto_the_status() {
        let effect = macos_effect(true, false, true);
        assert_eq!(
            effect.provider,
            CameraSystemEffectProvider::MacosVideoEffects
        );
        assert!(effect.background_blur);
        assert!(!effect.background_replacement);
        assert!(effect.studio_light);
        assert!(!effect.turned_off_by_videorc);
        assert!(macos_effect(false, true, false).background_replacement);
    }

    #[test]
    fn windows_blur_is_the_blur_or_portrait_flag_never_the_mask() {
        assert!(!windows_effect(0, false).background_blur);
        assert!(!windows_effect(BACKGROUND_SEGMENTATION_MASK, false).background_blur);
        assert!(windows_effect(BACKGROUND_SEGMENTATION_BLUR, false).background_blur);
        assert!(windows_effect(PORTRAIT_BLUR, false).background_blur);
        let effect = windows_effect(0, true);
        assert_eq!(
            effect.provider,
            CameraSystemEffectProvider::WindowsStudioEffects
        );
        assert!(effect.turned_off_by_videorc);
        assert!(!effect.background_replacement && !effect.studio_light);
    }

    #[test]
    fn start_decision_table() {
        let caps = BACKGROUND_SEGMENTATION_BLUR | BACKGROUND_SEGMENTATION_SHALLOW_FOCUS;
        // A camera that can't blur: nothing to report, whatever Videorc runs.
        assert_eq!(
            studio_effects_start(0, 0, true),
            StudioEffectsStart::Unsupported
        );
        assert_eq!(
            studio_effects_start(
                BACKGROUND_SEGMENTATION_MASK,
                BACKGROUND_SEGMENTATION_MASK,
                true
            ),
            StudioEffectsStart::Unsupported
        );
        // Videorc's effect Off: never touched, blurring or not.
        assert_eq!(
            studio_effects_start(caps, PORTRAIT_BLUR, false),
            StudioEffectsStart::Leave {
                flags: PORTRAIT_BLUR
            }
        );
        assert_eq!(
            studio_effects_start(caps, 0, false),
            StudioEffectsStart::Leave { flags: 0 }
        );
        // Videorc's effect on, Studio Effects not blurring: nothing to do.
        assert_eq!(
            studio_effects_start(caps, 0, true),
            StudioEffectsStart::Leave { flags: 0 }
        );
        // Videorc's effect on and Studio Effects blurring: off, mask kept.
        assert_eq!(
            studio_effects_start(caps, PORTRAIT_BLUR | BACKGROUND_SEGMENTATION_MASK, true),
            StudioEffectsStart::TurnOff {
                write: BACKGROUND_SEGMENTATION_MASK,
                restore: PORTRAIT_BLUR | BACKGROUND_SEGMENTATION_MASK
            }
        );
        assert_eq!(
            studio_effects_start(caps, BACKGROUND_SEGMENTATION_BLUR, true),
            StudioEffectsStart::TurnOff {
                write: 0,
                restore: BACKGROUND_SEGMENTATION_BLUR
            }
        );
    }

    #[test]
    fn restore_only_when_the_camera_still_holds_videorcs_write() {
        assert_eq!(
            studio_effects_restore(0, 0, PORTRAIT_BLUR),
            Some(PORTRAIT_BLUR)
        );
        // The streamer turned it back on (or changed it) during the session.
        assert_eq!(
            studio_effects_restore(BACKGROUND_SEGMENTATION_BLUR, 0, PORTRAIT_BLUR),
            None
        );
        assert_eq!(
            studio_effects_restore(PORTRAIT_BLUR, 0, PORTRAIT_BLUR),
            None
        );
    }

    #[test]
    fn effect_off_leaves_a_blurring_camera_alone_and_reports_it() {
        let database = Database::open_in_memory_for_tests();
        let mut control = FakeControl::studio_effects(PORTRAIT_BLUR);
        let session =
            start_studio_effects_session(&mut control, &policy(false, &database), "cam").unwrap();
        assert_eq!(
            session,
            StudioEffectsSession::Active {
                effect: windows_effect(PORTRAIT_BLUR, false),
                owed: None
            }
        );
        assert!(control.writes.is_empty());
        assert!(load_ledger(&database).is_empty());
        finish_studio_effects_session(&mut control, &policy(false, &database), "cam", None);
        assert!(control.writes.is_empty());
    }

    #[test]
    fn effect_on_turns_the_blur_off_records_it_and_puts_it_back_at_stop() {
        let database = Database::open_in_memory_for_tests();
        let policy = policy(true, &database);
        let mut control = FakeControl::studio_effects(PORTRAIT_BLUR);
        let session = start_studio_effects_session(&mut control, &policy, "cam").unwrap();
        let StudioEffectsSession::Active { effect, mut owed } = session else {
            panic!("expected an active session, got {session:?}");
        };
        assert!(!effect.background_blur);
        assert!(effect.turned_off_by_videorc);
        assert_eq!(control.writes, vec![0]);
        assert_eq!(
            load_ledger(&database).get("cam"),
            Some(&OwedRestore {
                written: 0,
                restore: PORTRAIT_BLUR
            })
        );
        // A poll mid-session still says Videorc turned it off, and keeps
        // the restore.
        assert_eq!(
            poll_studio_effects(&mut control, &mut owed, Some(&database), "cam"),
            StudioEffectsPoll::Effect(windows_effect(0, true))
        );
        assert!(owed.is_some());

        finish_studio_effects_session(&mut control, &policy, "cam", owed);
        assert_eq!(control.writes, vec![0, PORTRAIT_BLUR]);
        assert!(load_ledger(&database).is_empty());
    }

    #[test]
    fn a_blur_turned_back_on_mid_session_is_reported_and_kept() {
        let database = Database::open_in_memory_for_tests();
        let policy = policy(true, &database);
        let mut control = FakeControl::studio_effects(PORTRAIT_BLUR);
        let StudioEffectsSession::Active { mut owed, .. } =
            start_studio_effects_session(&mut control, &policy, "cam").unwrap()
        else {
            panic!("expected an active session");
        };
        // The streamer turns standard blur back on in Quick Settings.
        control.flags = BACKGROUND_SEGMENTATION_BLUR;
        assert_eq!(
            poll_studio_effects(&mut control, &mut owed, Some(&database), "cam"),
            StudioEffectsPoll::Effect(windows_effect(BACKGROUND_SEGMENTATION_BLUR, false))
        );
        assert_eq!(owed, None, "their change ends Videorc's claim");
        finish_studio_effects_session(&mut control, &policy, "cam", owed);
        assert_eq!(
            control.writes,
            vec![0],
            "their own choice is never overwritten"
        );
        assert!(load_ledger(&database).is_empty());
    }

    #[test]
    fn a_change_then_back_to_off_is_still_the_streamers_choice() {
        let database = Database::open_in_memory_for_tests();
        let policy = policy(true, &database);
        let mut control = FakeControl::studio_effects(PORTRAIT_BLUR);
        let StudioEffectsSession::Active { mut owed, .. } =
            start_studio_effects_session(&mut control, &policy, "cam").unwrap()
        else {
            panic!("expected an active session");
        };
        // Standard blur, then Off again: the camera ends on Videorc's value,
        // but the streamer chose it.
        control.flags = BACKGROUND_SEGMENTATION_BLUR;
        poll_studio_effects(&mut control, &mut owed, Some(&database), "cam");
        control.flags = 0;
        assert_eq!(
            poll_studio_effects(&mut control, &mut owed, Some(&database), "cam"),
            StudioEffectsPoll::Effect(windows_effect(0, false))
        );
        finish_studio_effects_session(&mut control, &policy, "cam", owed);
        assert_eq!(control.writes, vec![0], "Off stays Off");
        assert!(load_ledger(&database).is_empty());
    }

    #[test]
    fn a_poll_tells_no_control_from_a_failed_read() {
        let mut owed = None;
        let mut control = FakeControl::studio_effects(0);
        control.read_error = Some("busy".to_string());
        assert_eq!(
            poll_studio_effects(&mut control, &mut owed, None, "cam"),
            StudioEffectsPoll::Failed
        );
        control.read_error = None;
        control.present = false;
        assert_eq!(
            poll_studio_effects(&mut control, &mut owed, None, "cam"),
            StudioEffectsPoll::Unsupported
        );
    }

    #[test]
    fn a_crashed_session_is_settled_at_the_next_start() {
        let database = Database::open_in_memory_for_tests();
        let policy_on = policy(true, &database);
        let mut control = FakeControl::studio_effects(PORTRAIT_BLUR);
        start_studio_effects_session(&mut control, &policy_on, "cam").unwrap();
        // The app dies here: no finish. The next run opens the camera with
        // Videorc's effect Off.
        let session =
            start_studio_effects_session(&mut control, &policy(false, &database), "cam").unwrap();
        assert_eq!(control.writes, vec![0, PORTRAIT_BLUR]);
        assert_eq!(
            session,
            StudioEffectsSession::Active {
                effect: windows_effect(PORTRAIT_BLUR, false),
                owed: None
            }
        );
        assert!(load_ledger(&database).is_empty());
    }

    #[test]
    fn a_failed_read_keeps_the_owed_restore_for_later() {
        let database = Database::open_in_memory_for_tests();
        set_owed_restore(
            &database,
            "cam",
            Some(OwedRestore {
                written: 0,
                restore: PORTRAIT_BLUR,
            }),
        )
        .unwrap();
        let mut control = FakeControl::studio_effects(0);
        control.read_error = Some("driver busy".to_string());
        settle_owed_restore(&mut control, Some(&database), "cam");
        assert!(control.writes.is_empty());
        assert!(load_ledger(&database).contains_key("cam"));
        control.read_error = None;
        settle_owed_restore(&mut control, Some(&database), "cam");
        assert_eq!(control.writes, vec![PORTRAIT_BLUR]);
        assert!(load_ledger(&database).is_empty());
    }

    #[test]
    fn no_ledger_means_no_turn_off() {
        let mut control = FakeControl::studio_effects(PORTRAIT_BLUR);
        let policy = StudioEffectsPolicy {
            turn_off_background_blur: true,
            restore_ledger: None,
        };
        let session = start_studio_effects_session(&mut control, &policy, "cam").unwrap();
        assert!(control.writes.is_empty());
        assert_eq!(
            session,
            StudioEffectsSession::Active {
                effect: windows_effect(PORTRAIT_BLUR, false),
                owed: None
            }
        );
    }

    #[test]
    fn a_refused_write_reports_the_blur_and_owes_nothing() {
        let database = Database::open_in_memory_for_tests();
        let mut control = FakeControl::studio_effects(PORTRAIT_BLUR);
        control.write_error = Some("refused".to_string());
        let session =
            start_studio_effects_session(&mut control, &policy(true, &database), "cam").unwrap();
        assert_eq!(
            session,
            StudioEffectsSession::Active {
                effect: windows_effect(PORTRAIT_BLUR, false),
                owed: None
            }
        );
        assert!(load_ledger(&database).is_empty());
    }

    #[test]
    fn a_camera_without_studio_effects_is_unsupported() {
        let database = Database::open_in_memory_for_tests();
        let mut control = FakeControl::studio_effects(0);
        control.present = false;
        assert_eq!(
            start_studio_effects_session(&mut control, &policy(true, &database), "cam").unwrap(),
            StudioEffectsSession::Unsupported
        );
        let mut mask_only = FakeControl::studio_effects(0);
        mask_only.capabilities = BACKGROUND_SEGMENTATION_MASK;
        assert_eq!(
            start_studio_effects_session(&mut mask_only, &policy(true, &database), "cam").unwrap(),
            StudioEffectsSession::Unsupported
        );
    }

    #[test]
    fn ledger_keeps_other_cameras_entries() {
        let database = Database::open_in_memory_for_tests();
        let owed = OwedRestore {
            written: 0,
            restore: PORTRAIT_BLUR,
        };
        set_owed_restore(&database, "a", Some(owed)).unwrap();
        set_owed_restore(&database, "b", Some(owed)).unwrap();
        set_owed_restore(&database, "a", None).unwrap();
        let ledger = load_ledger(&database);
        assert!(!ledger.contains_key("a"));
        assert_eq!(ledger.get("b"), Some(&owed));
    }

    #[test]
    fn status_wire_shape_is_camel_case() {
        let json = serde_json::to_value(windows_effect(PORTRAIT_BLUR, false)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "provider": "windows-studio-effects",
                "backgroundBlur": true,
                "backgroundReplacement": false,
                "studioLight": false,
                "turnedOffByVideorc": false
            })
        );
        let json = serde_json::to_value(macos_effect(true, false, false)).unwrap();
        assert_eq!(json["provider"], "macos-video-effects");
    }

    /// The shared wire fixture; the renderer's contract test reads it too.
    #[test]
    fn camera_system_effect_fixture_round_trips_through_the_camera_status() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/camera-system-effect.json"
        ))
        .expect("protocol-fixtures/camera-system-effect.json is valid JSON");
        for (name, effect) in [
            ("macosPortrait", macos_effect(true, false, true)),
            ("windowsTurnedOff", windows_effect(0, true)),
        ] {
            let status: crate::protocol::PreviewCameraStatus =
                serde_json::from_value(fixture[name].clone()).unwrap();
            assert_eq!(status.system_effect, Some(effect), "{name}");
            assert_eq!(
                serde_json::to_value(&status).unwrap(),
                fixture[name],
                "{name}"
            );
        }
    }

    #[test]
    fn a_camera_status_without_a_system_effect_keeps_its_wire_shape() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/camera-system-effect.json"
        ))
        .unwrap();
        let mut status: crate::protocol::PreviewCameraStatus =
            serde_json::from_value(fixture["macosPortrait"].clone()).unwrap();
        status.system_effect = None;
        let json = serde_json::to_value(&status).unwrap();
        assert!(json.get("systemEffect").is_none(), "absent, never null");
    }

    #[test]
    fn the_constants_match_the_windows_sdk() {
        // Pinned here so the decision tests run on every platform; the
        // Windows build checks them against the SDK's own values.
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::Media::KernelStreaming::{
                KSCAMERA_EXTENDEDPROP_BACKGROUNDSEGMENTATION_BLUR,
                KSCAMERA_EXTENDEDPROP_BACKGROUNDSEGMENTATION_MASK,
                KSCAMERA_EXTENDEDPROP_BACKGROUNDSEGMENTATION_SHALLOWFOCUS,
            };
            assert_eq!(
                BACKGROUND_SEGMENTATION_BLUR,
                KSCAMERA_EXTENDEDPROP_BACKGROUNDSEGMENTATION_BLUR
            );
            assert_eq!(
                BACKGROUND_SEGMENTATION_MASK,
                KSCAMERA_EXTENDEDPROP_BACKGROUNDSEGMENTATION_MASK
            );
            assert_eq!(
                BACKGROUND_SEGMENTATION_SHALLOW_FOCUS,
                KSCAMERA_EXTENDEDPROP_BACKGROUNDSEGMENTATION_SHALLOWFOCUS
            );
        }
        assert_eq!(BACKGROUND_SEGMENTATION_BLUR, 1);
        assert_eq!(BACKGROUND_SEGMENTATION_MASK, 2);
        assert_eq!(BACKGROUND_SEGMENTATION_SHALLOW_FOCUS, 4);
    }
}
