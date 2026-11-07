//! Low-light compensation for Windows cameras (issue #1066).
//!
//! UVC webcams ship with auto-exposure priority on: in low light the camera
//! may hold the shutter open longer than one frame, so a 30 fps camera
//! delivers 15 (the owner's C920) or 11 (an HP HD Camera in an ordinary room,
//! 91 frames in 8 s against 244 with it off). Recordings and streams then get
//! a half-rate camera. OBS calls the control "Low light compensation".
//!
//! Videorc keeps the frame rate by default: every time it opens a Windows
//! camera it writes the camera's auto-exposure priority to match the user's
//! choice for that camera (off unless they turned it on). The value lives in
//! the device and its driver, so it holds for FFmpeg's DirectShow session in
//! its own process, and a write while that session runs takes effect within
//! a second. Measured on the HP HD Camera before this module was written.
//!
//! The choice is stored per camera id in `app_settings`; a camera with no
//! entry has compensation off.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use crate::protocol::CameraLowLightState;
use crate::storage::Database;

pub const CAMERA_LOW_LIGHT_SETTINGS_KEY: &str = "camera.lowLightCompensation";

/// The longest camera id `camera.lowLight.set` saves; the renderer's wire
/// schema holds it to the same length.
pub const CAMERA_LOW_LIGHT_CAMERA_ID_MAX_LEN: usize = 1024;

/// The most cameras that can have compensation on at once. Bounded like the
/// other stored per-device records (`windows_mf_rejections` keeps 64). At the
/// limit a saved camera can still be changed or turned off; only a new one
/// is refused, so nobody's choice is dropped to make room.
pub const CAMERA_LOW_LIGHT_MAX_CAMERAS: usize = 64;

/// How long `camera.lowLight.get` and `.set` wait for the camera. A driver
/// that stalls keeps only its camera's worker; the answer still comes back
/// well inside the backend's 10 s mutation deadline, so a stalled camera never
/// gets the backend restarted or holds up later commands.
pub const CAMERA_LOW_LIGHT_DEVICE_WAIT: Duration = Duration::from_secs(3);

/// Camera id → compensation on. Only `true` entries are kept: off is the
/// default, so turning it off removes the camera's entry.
type LowLightPrefs = BTreeMap<String, bool>;

/// What the device said when Videorc read or wrote its control.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceLowLight {
    /// The control exists and the device now holds `compensation`.
    /// `changed` is true when Videorc's write moved it.
    Holds { compensation: bool, changed: bool },
    /// The camera has no such control (or is not a camera Videorc can set),
    /// and why. Asking again will not change the answer.
    Unsupported(String),
    /// The camera may have the control, but this attempt failed (Media
    /// Foundation, the driver, a stall or a panic), and why. Worth retrying.
    Failed(String),
}

impl DeviceLowLight {
    /// True when the camera has the control.
    pub fn supported(&self) -> bool {
        matches!(self, Self::Holds { .. })
    }
}

/// The value written to `KSPROPERTY_CAMERACONTROL_AUTO_EXPOSURE_PRIORITY`:
/// 1 lets exposure lower the frame rate, 0 keeps the frame rate.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
fn auto_exposure_priority_value(compensation: bool) -> i32 {
    i32::from(compensation)
}

/// Reads the control's value back as a choice: any non-zero value lets
/// exposure lower the frame rate.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
fn compensation_from_priority(value: i32) -> bool {
    value != 0
}

/// Whether a failed `KsProperty` GET means the camera has no such control.
/// Kernel streaming answers a missing property with `ERROR_NOT_FOUND`
/// (`E_PROP_ID_UNSUPPORTED`) or `ERROR_SET_NOT_FOUND` (`E_PROP_SET_UNSUPPORTED`);
/// some drivers say `ERROR_NOT_SUPPORTED` or `E_NOTIMPL`. Any other error is
/// the driver failing this time, which is worth retrying.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
fn ks_get_error_means_unsupported(hresult: i32) -> bool {
    const E_PROP_ID_UNSUPPORTED: u32 = 0x8007_0490;
    const E_PROP_SET_UNSUPPORTED: u32 = 0x8007_0492;
    const HRESULT_ERROR_NOT_SUPPORTED: u32 = 0x8007_0032;
    const E_NOTIMPL: u32 = 0x8000_4001;
    matches!(
        hresult as u32,
        E_PROP_ID_UNSUPPORTED | E_PROP_SET_UNSUPPORTED | HRESULT_ERROR_NOT_SUPPORTED | E_NOTIMPL
    )
}

/// Every saved choice; a missing setting is none saved. An unreadable one is
/// an error: treating it as empty would let the next save drop every other
/// camera's choice, or a camera open turn off a choice that is on.
fn load_prefs(database: &Database) -> anyhow::Result<LowLightPrefs> {
    database
        .load_setting::<LowLightPrefs>(CAMERA_LOW_LIGHT_SETTINGS_KEY)
        .map(Option::unwrap_or_default)
        .map_err(|error| anyhow::anyhow!("the saved low-light choices are unreadable: {error}"))
}

/// The user's choice for this camera (off unless they turned it on).
pub fn stored_compensation(database: &Database, camera_id: &str) -> anyhow::Result<bool> {
    Ok(load_prefs(database)?
        .get(camera_id)
        .copied()
        .unwrap_or(false))
}

/// `prefs` with this camera's choice applied: on adds its entry, off removes it.
fn with_compensation(
    mut prefs: LowLightPrefs,
    camera_id: &str,
    compensation: bool,
) -> LowLightPrefs {
    if compensation {
        prefs.insert(camera_id.to_string(), true);
    } else {
        prefs.remove(camera_id);
    }
    prefs
}

/// Saves run one at a time: each reads, changes and writes the whole map,
/// so two cameras switched at once never drop each other's choice.
static PREF_SAVES: Mutex<()> = Mutex::new(());

/// Saves this camera's choice. Refuses a new camera once
/// [`CAMERA_LOW_LIGHT_MAX_CAMERAS`] have compensation on.
pub fn save_compensation(
    database: &Database,
    camera_id: &str,
    compensation: bool,
) -> anyhow::Result<()> {
    let _serialized = PREF_SAVES.lock().unwrap_or_else(PoisonError::into_inner);
    let prefs = load_prefs(database)?;
    if compensation && !prefs.contains_key(camera_id) && prefs.len() >= CAMERA_LOW_LIGHT_MAX_CAMERAS
    {
        anyhow::bail!(
            "it is already on for {CAMERA_LOW_LIGHT_MAX_CAMERAS} cameras; turn it off for one first"
        );
    }
    let prefs = with_compensation(prefs, camera_id, compensation);
    database.save_setting(CAMERA_LOW_LIGHT_SETTINGS_KEY, &prefs)
}

/// The answer to `camera.lowLight.get` / `.set`: the stored choice, and
/// whether this camera has the control at all.
pub fn state_for(
    camera_id: &str,
    compensation: bool,
    device: &DeviceLowLight,
) -> CameraLowLightState {
    CameraLowLightState {
        camera_id: camera_id.to_string(),
        supported: device.supported(),
        compensation,
    }
}

/// Reads the control without changing it.
pub fn read_device(camera_id: &str) -> DeviceLowLight {
    device_control(camera_id, None)
}

/// Writes the control when it differs from `compensation`.
pub fn write_device(camera_id: &str, compensation: bool) -> DeviceLowLight {
    device_control(camera_id, Some(compensation))
}

/// Reads the camera's control.
type ReadOp = dyn Fn(&str) -> DeviceLowLight + Send + Sync;
/// Writes the camera's control.
type WriteOp = dyn Fn(&str, bool) -> DeviceLowLight + Send + Sync;

/// The device calls a camera's worker makes. Production uses the real
/// camera ([`DeviceOps::camera`]); tests pass doubles that stall or panic.
#[derive(Clone)]
struct DeviceOps {
    read: Arc<ReadOp>,
    write: Arc<WriteOp>,
}

impl DeviceOps {
    /// The real camera control.
    fn camera() -> Self {
        Self {
            read: Arc::new(read_device),
            write: Arc::new(write_device),
        }
    }
}

/// Where a worker sends the result of the pass that served a request.
type DeviceReply = tokio::sync::oneshot::Sender<DeviceLowLight>;

/// What one request asks a camera's worker for.
enum DeviceRequest {
    /// Write the saved choice (read when the write runs), and maybe answer.
    Write(Option<DeviceReply>),
    /// Read the control and answer.
    Read(DeviceReply),
}

/// Work queued for a camera's next pass.
#[derive(Default)]
struct CameraWork {
    write: bool,
    replies: Vec<DeviceReply>,
}

/// Cameras whose worker thread is running, with the work queued for its next
/// pass. Each camera has at most one worker: requests that arrive while it
/// runs (or stalls in a driver) join its next pass instead of starting more
/// threads, so a stalled camera holds exactly one thread and nothing piles
/// up behind it, while other cameras keep their own workers. A write reads
/// the saved choice when its pass starts, so the camera always ends on the
/// latest choice saved before that pass.
static CAMERA_WORKERS: Mutex<BTreeMap<String, CameraWork>> = Mutex::new(BTreeMap::new());

/// The most callers that can wait on one camera at once. Callers stop waiting
/// after [`CAMERA_LOW_LIGHT_DEVICE_WAIT`], so this is only reached by a burst.
pub const CAMERA_LOW_LIGHT_MAX_WAITING: usize = 32;

/// When each running camera worker started its current pass.
static PASS_STARTED: Mutex<BTreeMap<String, Instant>> = Mutex::new(BTreeMap::new());

/// A pass running longer than this counts as stuck: a read does not wait on
/// it. A healthy write or read takes well under this (about 50 ms measured
/// on the HP HD Camera, enumeration included).
pub const CAMERA_LOW_LIGHT_STALLED_PASS: Duration = Duration::from_secs(1);

/// Queues `request` for `camera_id` and starts the camera's worker unless one
/// is running. A worker that cannot start drops its replies, which their
/// callers read as a failure. Replies whose callers already gave up are
/// dropped first, and at most [`CAMERA_LOW_LIGHT_MAX_WAITING`] wait, so a
/// camera stuck in a driver never grows its queue: a request past the limit
/// is answered at once as a failure (a write still queues).
fn request_device_work(
    database: &Database,
    camera_id: &str,
    ops: &DeviceOps,
    request: DeviceRequest,
) {
    let start = {
        let mut workers = CAMERA_WORKERS
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let start = !workers.contains_key(camera_id);
        let work = workers.entry(camera_id.to_string()).or_default();
        work.replies.retain(|reply| !reply.is_closed());
        let reply = match request {
            DeviceRequest::Write(reply) => {
                work.write = true;
                reply
            }
            DeviceRequest::Read(reply) => Some(reply),
        };
        // Dropping a reply past the limit answers its caller at once.
        if let Some(reply) = reply
            && work.replies.len() < CAMERA_LOW_LIGHT_MAX_WAITING
        {
            work.replies.push(reply);
        }
        start
    };
    if !start {
        return;
    }
    let database = database.clone();
    let worker_camera_id = camera_id.to_string();
    let ops = ops.clone();
    let spawned = std::thread::Builder::new()
        .name("videorc-camera-low-light".to_string())
        .spawn(move || run_camera_worker(&database, &worker_camera_id, &ops));
    if let Err(error) = spawned {
        CAMERA_WORKERS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(camera_id);
        tracing::warn!("Camera low-light worker did not start: {error}");
    }
}

/// A camera's worker: one pass per batch of queued work until none is left.
/// A pass writes when any queued request asked for a write (a write answers
/// reads too), otherwise it reads; every reply in the batch gets its result.
fn run_camera_worker(database: &Database, camera_id: &str, ops: &DeviceOps) {
    loop {
        let work = {
            let mut workers = CAMERA_WORKERS
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let Some(queued) = workers.get_mut(camera_id) else {
                return;
            };
            if !queued.write && queued.replies.is_empty() {
                workers.remove(camera_id);
                return;
            }
            std::mem::take(queued)
        };
        PASS_STARTED
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(camera_id.to_string(), Instant::now());
        let device = run_device_pass(database, camera_id, ops, work.write);
        PASS_STARTED
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(camera_id);
        if work.write {
            log_applied(camera_id, &device);
        }
        for reply in work.replies {
            let _ = reply.send(device.clone());
        }
    }
}

/// One device call. A panic in the driver call is a failure of this pass,
/// never the end of the camera's worker.
fn run_device_pass(
    database: &Database,
    camera_id: &str,
    ops: &DeviceOps,
    write: bool,
) -> DeviceLowLight {
    let call = || {
        if write {
            // An unreadable saved choice is never guessed at: the camera
            // keeps whatever it holds.
            match stored_compensation(database, camera_id) {
                Ok(compensation) => (ops.write)(camera_id, compensation),
                Err(error) => DeviceLowLight::Failed(error.to_string()),
            }
        } else {
            (ops.read)(camera_id)
        }
    };
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(call)).unwrap_or_else(|_| {
        DeviceLowLight::Failed("the camera's control call panicked".to_string())
    })
}

/// Logs what a write left on the camera.
fn log_applied(camera_id: &str, device: &DeviceLowLight) {
    match device {
        DeviceLowLight::Holds {
            compensation,
            changed,
        } => tracing::info!(
            camera = %camera_id,
            compensation,
            changed,
            "Camera low-light compensation applied"
        ),
        DeviceLowLight::Unsupported(reason) => tracing::info!(
            camera = %camera_id,
            "Camera low-light compensation not available: {reason}"
        ),
        DeviceLowLight::Failed(reason) => tracing::warn!(
            camera = %camera_id,
            "Camera low-light compensation was not applied: {reason}"
        ),
    }
}

/// Queues a read (or a write of the saved choice) and waits at most `wait`
/// for the pass that serves it. A camera that does not answer in time is a
/// [`DeviceLowLight::Failed`]; its pass keeps running on the camera's worker
/// and finishes on its own.
async fn device_answer(
    database: &Database,
    camera_id: &str,
    ops: &DeviceOps,
    wait: Duration,
    write: bool,
) -> DeviceLowLight {
    let (reply, answer) = tokio::sync::oneshot::channel();
    let request = if write {
        DeviceRequest::Write(Some(reply))
    } else {
        DeviceRequest::Read(reply)
    };
    request_device_work(database, camera_id, ops, request);
    match tokio::time::timeout(wait, answer).await {
        Ok(Ok(device)) => device,
        Ok(Err(_)) => DeviceLowLight::Failed("the camera is not taking more requests".to_string()),
        Err(_) => DeviceLowLight::Failed(format!(
            "the camera did not answer within {} s",
            wait.as_secs()
        )),
    }
}

/// True when the camera's worker has been in one pass for longer than `after`.
fn camera_pass_running_longer_than(camera_id: &str, after: Duration) -> bool {
    PASS_STARTED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(camera_id)
        .is_some_and(|started| started.elapsed() > after)
}

/// A read for `camera.lowLight.get`. It runs on the read-only request lane,
/// so it never waits on a camera already stuck in a pass: that answers "not
/// answering" at once (the renderer asks again later) instead of holding a
/// lane slot. Only the first read of a stall waits, at most `wait`.
async fn device_read_answer(
    database: &Database,
    camera_id: &str,
    ops: &DeviceOps,
    wait: Duration,
    stalled_after: Duration,
) -> DeviceLowLight {
    if camera_pass_running_longer_than(camera_id, stalled_after) {
        return DeviceLowLight::Failed("the camera is not answering".to_string());
    }
    device_answer(database, camera_id, ops, wait, false).await
}

/// `camera.lowLight.get`: the stored choice, and whether the camera has the
/// control (read from the device, without changing it). A failed read is an
/// error, not "no control", so the renderer can ask again.
pub async fn get(
    state: &crate::state::AppState,
    camera_id: String,
) -> Result<CameraLowLightState, String> {
    let compensation = stored_compensation(&state.database, &camera_id)
        .map_err(|error| format!("Low-light compensation could not be read: {error}."))?;
    let device = device_read_answer(
        &state.database,
        &camera_id,
        &DeviceOps::camera(),
        CAMERA_LOW_LIGHT_DEVICE_WAIT,
        CAMERA_LOW_LIGHT_STALLED_PASS,
    )
    .await;
    if let DeviceLowLight::Failed(reason) = &device {
        return Err(format!(
            "Low-light compensation could not be read: {reason}."
        ));
    }
    Ok(state_for(&camera_id, compensation, &device))
}

/// `camera.lowLight.set`: saves the choice and writes it to the device now,
/// whether or not Videorc has the camera open (the device keeps it).
pub async fn set(
    state: &crate::state::AppState,
    camera_id: String,
    compensation: bool,
) -> Result<CameraLowLightState, String> {
    if camera_id.trim().is_empty() {
        return Err("cameraId must name a camera.".to_string());
    }
    if camera_id.len() > CAMERA_LOW_LIGHT_CAMERA_ID_MAX_LEN {
        return Err(format!(
            "cameraId is longer than {CAMERA_LOW_LIGHT_CAMERA_ID_MAX_LEN} bytes."
        ));
    }
    save_compensation(&state.database, &camera_id, compensation)
        .map_err(|error| format!("Low-light compensation was not saved: {error}"))?;
    let device = device_answer(
        &state.database,
        &camera_id,
        &DeviceOps::camera(),
        CAMERA_LOW_LIGHT_DEVICE_WAIT,
        true,
    )
    .await;
    match &device {
        DeviceLowLight::Holds { changed, .. } => tracing::info!(
            camera = %camera_id,
            compensation,
            changed,
            "Camera low-light compensation set"
        ),
        DeviceLowLight::Unsupported(reason) => tracing::info!(
            camera = %camera_id,
            compensation,
            "Camera low-light compensation saved, not written: {reason}"
        ),
        // Saved; the camera's worker applies the saved choice when the
        // camera answers.
        DeviceLowLight::Failed(reason) => {
            tracing::warn!(
                camera = %camera_id,
                compensation,
                "Camera low-light compensation saved, not written yet: {reason}"
            );
            return Err(format!("Low-light compensation was saved, but {reason}."));
        }
    }
    Ok(state_for(&camera_id, compensation, &device))
}

/// Called as Videorc opens a camera: queues a write of the stored choice on
/// the camera's worker, so the camera's start never waits on it (a write
/// while FFmpeg already streams takes effect within a second).
pub fn apply_stored_on_open(database: &Database, camera_id: &str) {
    // Unit tests start cameras with made-up dshow names; they must never
    // write to a real camera on the machine running them.
    if cfg!(test) || crate::camera_capture::parse_windows_dshow_camera_id(camera_id).is_none() {
        return;
    }
    request_device_work(
        database,
        camera_id,
        &DeviceOps::camera(),
        DeviceRequest::Write(None),
    );
}

/// Off Windows there is no control to set.
#[cfg(not(target_os = "windows"))]
fn device_control(_camera_id: &str, _write: Option<bool>) -> DeviceLowLight {
    DeviceLowLight::Unsupported("Videorc sets low-light compensation on Windows only.".to_string())
}

/// Reads or writes the control of the Windows camera `camera_id` names.
#[cfg(target_os = "windows")]
fn device_control(camera_id: &str, write: Option<bool>) -> DeviceLowLight {
    let Some(device_name) = crate::camera_capture::parse_windows_dshow_camera_id(camera_id) else {
        return DeviceLowLight::Unsupported("Not a Windows camera.".to_string());
    };
    windows_device::control(&device_name, write)
}

#[cfg(target_os = "windows")]
mod windows_device {
    use super::{
        DeviceLowLight, auto_exposure_priority_value, compensation_from_priority,
        ks_get_error_means_unsupported,
    };
    use windows::Win32::Media::KernelStreaming::{
        IKsControl, KSIDENTIFIER, KSIDENTIFIER_0, KSIDENTIFIER_0_0,
        KSPROPERTY_CAMERACONTROL_AUTO_EXPOSURE_PRIORITY, KSPROPERTY_CAMERACONTROL_FLAGS_MANUAL,
        KSPROPERTY_CAMERACONTROL_S, KSPROPERTY_TYPE_GET, KSPROPERTY_TYPE_SET,
        PROPSETID_VIDCAP_CAMERACONTROL,
    };
    use windows::Win32::Media::MediaFoundation::{
        IMFActivate, IMFMediaSource, MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
        MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
        MF_VERSION, MFCreateAttributes, MFEnumDeviceSources, MFSTARTUP_FULL, MFShutdown, MFStartup,
    };
    use windows::Win32::System::Com::{
        COINIT_MULTITHREADED, CoInitializeEx, CoTaskMemFree, CoUninitialize,
    };
    use windows::core::Interface;

    /// Uninitializes COM on drop when this thread's initialization succeeded.
    struct ComScope(bool);

    impl Drop for ComScope {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    /// Balances this call's `MFStartup` on drop.
    struct MediaFoundationScope;

    impl Drop for MediaFoundationScope {
        fn drop(&mut self) {
            let _ = unsafe { MFShutdown() };
        }
    }

    /// Every camera whose DirectShow friendly name is `device_name` (the name
    /// FFmpeg opens). Two identical cameras share a name; both get the write.
    /// Media Foundation and driver errors are failures worth retrying; a
    /// camera that is missing or has no such control is unsupported.
    pub(super) fn control(device_name: &str, write: Option<bool>) -> DeviceLowLight {
        enumerate_and_control(device_name, write).unwrap_or_else(|device| device)
    }

    /// The body of [`control`]; `Err` carries the unsupported or failed answer.
    fn enumerate_and_control(
        device_name: &str,
        write: Option<bool>,
    ) -> Result<DeviceLowLight, DeviceLowLight> {
        let failed = DeviceLowLight::Failed;
        let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let _com = ComScope(com.is_ok());
        unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }
            .map_err(|error| failed(format!("Media Foundation did not start: {error}")))?;
        let _media_foundation = MediaFoundationScope;

        let mut attributes = None;
        unsafe { MFCreateAttributes(&mut attributes, 1) }
            .map_err(|error| failed(format!("Camera enumeration failed: {error}")))?;
        let attributes = attributes
            .ok_or_else(|| failed("Camera enumeration returned no attributes.".to_string()))?;
        unsafe {
            attributes.SetGUID(
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
            )
        }
        .map_err(|error| failed(format!("Camera enumeration failed: {error}")))?;
        let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count = 0;
        unsafe { MFEnumDeviceSources(&attributes, &mut activates, &mut count) }
            .map_err(|error| failed(format!("Camera enumeration failed: {error}")))?;
        let mut matches = Vec::new();
        for index in 0..count {
            // Reading takes ownership, so every activate is released.
            if let Some(activate) = unsafe { activates.add(index as usize).read() }
                && friendly_name(&activate).as_deref() == Some(device_name)
            {
                matches.push(activate);
            }
        }
        unsafe { CoTaskMemFree(Some(activates.cast())) };

        if matches.is_empty() {
            return Err(DeviceLowLight::Unsupported(format!(
                "No camera named `{device_name}` is connected."
            )));
        }
        let mut result = None;
        let mut last_error = None;
        for activate in matches {
            match control_one(&activate, write) {
                Ok(device) => {
                    result.get_or_insert(device);
                }
                Err(error) => last_error = Some(error),
            }
            let _ = unsafe { activate.ShutdownObject() };
        }
        result.ok_or_else(|| {
            last_error.unwrap_or_else(|| failed("The camera gave no answer.".to_string()))
        })
    }

    /// The camera's friendly name, the one DirectShow (and FFmpeg) shows.
    fn friendly_name(activate: &IMFActivate) -> Option<String> {
        let len =
            unsafe { activate.GetStringLength(&MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME) }.ok()?;
        let mut buffer = vec![0u16; len as usize + 1];
        let mut written = 0;
        unsafe {
            activate.GetString(
                &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
                &mut buffer,
                Some(&mut written),
            )
        }
        .ok()?;
        let name = String::from_utf16_lossy(&buffer[..written as usize]);
        let name = name.trim();
        (!name.is_empty()).then(|| name.to_string())
    }

    /// Reads one camera's control and writes it when `write` differs.
    fn control_one(
        activate: &IMFActivate,
        write: Option<bool>,
    ) -> Result<DeviceLowLight, DeviceLowLight> {
        // The camera's frame server shares the device, so this opens it
        // beside a running FFmpeg capture without taking it over.
        let source: IMFMediaSource = unsafe { activate.ActivateObject() }.map_err(|error| {
            DeviceLowLight::Failed(format!("The camera did not open for its controls: {error}"))
        })?;
        let outcome = source
            .cast::<IKsControl>()
            .map_err(|_| {
                DeviceLowLight::Unsupported(
                    "The camera's driver exposes no camera controls.".to_string(),
                )
            })
            .and_then(|control| {
                let current =
                    auto_exposure_priority(&control, KSPROPERTY_TYPE_GET, 0).map_err(|error| {
                        if ks_get_error_means_unsupported(error.code().0) {
                            DeviceLowLight::Unsupported(format!(
                                "The camera has no auto-exposure priority control: {error}"
                            ))
                        } else {
                            DeviceLowLight::Failed(format!(
                                "The camera did not report its auto-exposure priority: {error}"
                            ))
                        }
                    })?;
                let current = compensation_from_priority(current);
                match write {
                    Some(wanted) if wanted != current => {
                        auto_exposure_priority(
                            &control,
                            KSPROPERTY_TYPE_SET,
                            auto_exposure_priority_value(wanted),
                        )
                        .map_err(|error| {
                            DeviceLowLight::Failed(format!(
                                "The camera refused its auto-exposure priority: {error}"
                            ))
                        })?;
                        Ok(DeviceLowLight::Holds {
                            compensation: wanted,
                            changed: true,
                        })
                    }
                    _ => Ok(DeviceLowLight::Holds {
                        compensation: current,
                        changed: false,
                    }),
                }
            });
        let _ = unsafe { source.Shutdown() };
        outcome
    }

    /// One `KSPROPERTY_CAMERACONTROL_AUTO_EXPOSURE_PRIORITY` GET or SET; returns
    /// the value the driver reports.
    fn auto_exposure_priority(
        control: &IKsControl,
        kind: u32,
        value: i32,
    ) -> windows::core::Result<i32> {
        let property = KSPROPERTY_CAMERACONTROL_S {
            Property: KSIDENTIFIER {
                Anonymous: KSIDENTIFIER_0 {
                    Anonymous: KSIDENTIFIER_0_0 {
                        Set: PROPSETID_VIDCAP_CAMERACONTROL,
                        Id: KSPROPERTY_CAMERACONTROL_AUTO_EXPOSURE_PRIORITY.0 as u32,
                        Flags: kind,
                    },
                },
            },
            Value: value,
            Flags: KSPROPERTY_CAMERACONTROL_FLAGS_MANUAL as u32,
            Capabilities: 0,
        };
        let mut data = property;
        let size = std::mem::size_of::<KSPROPERTY_CAMERACONTROL_S>() as u32;
        let mut returned = 0u32;
        unsafe {
            control.KsProperty(
                &property.Property,
                size,
                (&mut data as *mut KSPROPERTY_CAMERACONTROL_S).cast(),
                size,
                &mut returned,
            )
        }?;
        Ok(data.Value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The saved choice in a test database that is always readable.
    fn stored(camera_id: &str, database: &Database) -> bool {
        stored_compensation(database, camera_id).unwrap()
    }
    use crate::protocol::{CameraLowLightParams, CameraLowLightSetParams};

    /// The shared wire fixture; the renderer's contract test reads it too.
    #[test]
    fn camera_low_light_fixture_matches_the_backend_types_field_for_field() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/camera-low-light.json"
        ))
        .expect("protocol-fixtures/camera-low-light.json is valid JSON");
        let camera_id = fixture["getParams"]["cameraId"].as_str().unwrap();
        assert_eq!(
            crate::camera_capture::parse_windows_dshow_camera_id(camera_id).as_deref(),
            Some("HP HD Camera")
        );

        let get: CameraLowLightParams =
            serde_json::from_value(fixture["getParams"].clone()).unwrap();
        assert_eq!(serde_json::to_value(&get).unwrap(), fixture["getParams"]);
        let set: CameraLowLightSetParams =
            serde_json::from_value(fixture["setParams"].clone()).unwrap();
        assert_eq!(serde_json::to_value(&set).unwrap(), fixture["setParams"]);

        let holds = DeviceLowLight::Holds {
            compensation: false,
            changed: false,
        };
        assert_eq!(
            serde_json::to_value(state_for(camera_id, false, &holds)).unwrap(),
            fixture["keepsFrameRate"]
        );
        assert_eq!(
            serde_json::to_value(state_for(camera_id, true, &holds)).unwrap(),
            fixture["compensating"]
        );
        let unsupported = DeviceLowLight::Unsupported("off Windows".to_string());
        assert_eq!(
            serde_json::to_value(state_for("camera:avfoundation:0", false, &unsupported)).unwrap(),
            fixture["unsupported"]
        );

        // Shape errors fail to parse; an empty id parses and `set` refuses it.
        for bad in fixture["rejectedParams"].as_array().unwrap() {
            let parsed = serde_json::from_value::<CameraLowLightParams>(bad.clone());
            assert!(
                parsed.is_err() || parsed.unwrap().camera_id.is_empty(),
                "{bad}"
            );
        }
        for bad in fixture["rejectedSetParams"].as_array().unwrap() {
            assert!(
                serde_json::from_value::<CameraLowLightSetParams>(bad.clone()).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn the_control_value_lets_exposure_lower_the_rate_only_when_compensation_is_on() {
        assert_eq!(auto_exposure_priority_value(true), 1);
        assert_eq!(auto_exposure_priority_value(false), 0);
        assert!(compensation_from_priority(1));
        assert!(!compensation_from_priority(0));
    }

    #[test]
    fn only_a_missing_property_reads_as_no_control() {
        // E_PROP_ID_UNSUPPORTED, E_PROP_SET_UNSUPPORTED, ERROR_NOT_SUPPORTED, E_NOTIMPL.
        for unsupported in [0x8007_0490_u32, 0x8007_0492, 0x8007_0032, 0x8000_4001] {
            assert!(
                ks_get_error_means_unsupported(unsupported as i32),
                "{unsupported:#x} means no control"
            );
        }
        // Device busy or not ready, a generic failure, a timeout, a lost
        // device, access denied: the driver failed this time.
        for failed in [
            0x8007_00AA_u32,
            0x8007_0015,
            0x8000_4005,
            0x8007_05B4,
            0x8007_048F,
            0x8007_0005,
        ] {
            assert!(
                !ks_get_error_means_unsupported(failed as i32),
                "{failed:#x} is a failure worth retrying"
            );
        }
    }

    #[test]
    fn a_camera_with_no_entry_keeps_its_frame_rate() {
        let database = Database::open_in_memory_for_tests();
        assert!(!stored("camera:windows-dshow:00", &database));
    }

    #[test]
    fn at_the_camera_limit_saved_choices_still_change_but_a_new_camera_is_refused() {
        let database = Database::open_in_memory_for_tests();
        let id = |n: usize| format!("camera:windows-dshow:limit-{n:03}");
        for n in 0..CAMERA_LOW_LIGHT_MAX_CAMERAS {
            save_compensation(&database, &id(n), true).unwrap();
        }
        let refused = save_compensation(&database, &id(CAMERA_LOW_LIGHT_MAX_CAMERAS), true)
            .expect_err("a new camera past the limit is refused");
        assert!(
            refused.to_string().contains("turn it off for one first"),
            "{refused}"
        );
        assert!(!stored(&id(CAMERA_LOW_LIGHT_MAX_CAMERAS), &database));

        save_compensation(&database, &id(0), true).expect("a saved camera can be set again");
        save_compensation(&database, &id(CAMERA_LOW_LIGHT_MAX_CAMERAS), false)
            .expect("turning one off is never refused");
        save_compensation(&database, &id(1), false).unwrap();
        save_compensation(&database, &id(CAMERA_LOW_LIGHT_MAX_CAMERAS), true)
            .expect("a freed place takes a new camera");
        for n in (0..CAMERA_LOW_LIGHT_MAX_CAMERAS).filter(|n| *n != 1) {
            assert!(stored(&id(n), &database), "camera {n} kept its choice");
        }
    }

    #[test]
    fn the_choice_is_kept_per_camera_and_off_removes_the_entry() {
        let database = Database::open_in_memory_for_tests();
        save_compensation(&database, "camera:windows-dshow:aa", true).unwrap();
        save_compensation(&database, "camera:windows-dshow:bb", false).unwrap();
        assert!(stored("camera:windows-dshow:aa", &database));
        assert!(!stored("camera:windows-dshow:bb", &database));

        save_compensation(&database, "camera:windows-dshow:aa", false).unwrap();
        let prefs: LowLightPrefs = database
            .load_setting(CAMERA_LOW_LIGHT_SETTINGS_KEY)
            .unwrap()
            .unwrap();
        assert!(prefs.is_empty(), "{prefs:?}");
    }

    #[test]
    fn saves_for_two_cameras_at_once_keep_both_choices() {
        let database = Database::open_in_memory_for_tests();
        let ids: Vec<String> = (0..8)
            .map(|n| format!("camera:windows-dshow:{n:02x}"))
            .collect();
        std::thread::scope(|scope| {
            for id in &ids {
                let database = database.clone();
                scope.spawn(move || save_compensation(&database, id, true).unwrap());
            }
        });
        for id in &ids {
            assert!(stored(id, &database), "{id} lost its choice");
        }
    }

    /// A device double: the first write to `stall_id` blocks until released
    /// (after saying it started); every write is recorded with its value.
    struct StallingCamera {
        ops: DeviceOps,
        writes: Arc<Mutex<Vec<(String, bool)>>>,
        reads: Arc<Mutex<usize>>,
        entered: std::sync::mpsc::Receiver<()>,
        release: std::sync::mpsc::Sender<()>,
    }

    fn stalling_camera(stall_id: &'static str) -> StallingCamera {
        let writes = Arc::new(Mutex::new(Vec::new()));
        let reads = Arc::new(Mutex::new(0));
        let (entered_tx, entered) = std::sync::mpsc::channel::<()>();
        let (release, release_rx) = std::sync::mpsc::channel::<()>();
        let gate = Arc::new(Mutex::new(Some((entered_tx, release_rx))));
        let recorded = writes.clone();
        let counted = reads.clone();
        let ops = DeviceOps {
            read: Arc::new(move |_: &str| {
                *counted.lock().unwrap() += 1;
                DeviceLowLight::Holds {
                    compensation: false,
                    changed: false,
                }
            }),
            write: Arc::new(move |camera_id: &str, compensation: bool| {
                recorded
                    .lock()
                    .unwrap()
                    .push((camera_id.to_string(), compensation));
                if camera_id == stall_id
                    && let Some((entered_tx, release_rx)) = gate.lock().unwrap().take()
                {
                    entered_tx.send(()).unwrap();
                    let _ = release_rx.recv();
                }
                DeviceLowLight::Holds {
                    compensation,
                    changed: true,
                }
            }),
        };
        StallingCamera {
            ops,
            writes,
            reads,
            entered,
            release,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stalled_camera_holds_one_worker_and_never_holds_up_another_camera() {
        let database = Database::open_in_memory_for_tests();
        let a = "camera:windows-dshow:test-stall-a";
        let b = "camera:windows-dshow:test-stall-b";
        let camera = stalling_camera(a);
        let short = Duration::from_millis(50);
        let long = Duration::from_secs(30);

        let first = device_answer(&database, a, &camera.ops, short, true).await;
        assert!(
            matches!(first, DeviceLowLight::Failed(ref reason) if reason.contains("did not answer")),
            "a stalled camera's answer is a bounded failure, not unsupported: {first:?}"
        );
        // Camera A's worker is inside its first write now.
        let entered = camera.entered;
        tokio::task::spawn_blocking(move || entered.recv().unwrap())
            .await
            .unwrap();

        // Repeated sets and reads while A stalls join A's next pass.
        for (n, on) in [true, false, true, false, true].into_iter().enumerate() {
            save_compensation(&database, a, on).unwrap();
            let set = device_answer(&database, a, &camera.ops, short, true).await;
            assert!(matches!(set, DeviceLowLight::Failed(_)), "set {n}: {set:?}");
            let read = device_answer(&database, a, &camera.ops, short, false).await;
            assert!(
                matches!(read, DeviceLowLight::Failed(_)),
                "read {n}: {read:?}"
            );
        }

        // Camera B has its own worker and answers meanwhile.
        let other = device_answer(&database, b, &camera.ops, long, true).await;
        assert_eq!(
            other,
            DeviceLowLight::Holds {
                compensation: false,
                changed: true
            },
            "camera B is written while camera A stalls"
        );

        camera.release.send(()).unwrap();
        // Served by A's next pass (or one after it): either way after the
        // queued write has run.
        let after = device_answer(&database, a, &camera.ops, long, false).await;
        assert!(after.supported(), "{after:?}");
        let a_writes: Vec<bool> = camera
            .writes
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _)| id == a)
            .map(|(_, on)| *on)
            .collect();
        assert_eq!(
            a_writes,
            vec![false, true],
            "five queued sets ran as one write of the latest saved choice"
        );
        assert!(
            *camera.reads.lock().unwrap() <= 1,
            "queued reads were answered by the write, not run one by one"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_panicking_driver_call_is_a_failure_and_the_camera_still_answers_after() {
        let database = Database::open_in_memory_for_tests();
        let id = "camera:windows-dshow:test-panic";
        let counted = std::sync::atomic::AtomicUsize::new(0);
        let ops = DeviceOps {
            read: Arc::new(move |_: &str| {
                let call = counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                assert!(call > 1, "the driver call panics once");
                DeviceLowLight::Holds {
                    compensation: false,
                    changed: false,
                }
            }),
            write: Arc::new(|_: &str, _: bool| unreachable!("this test only reads")),
        };
        let long = Duration::from_secs(30);
        let first = device_answer(&database, id, &ops, long, false).await;
        assert!(
            matches!(first, DeviceLowLight::Failed(ref reason) if reason.contains("panicked")),
            "{first:?}"
        );
        let second = device_answer(&database, id, &ops, long, false).await;
        assert!(
            second.supported(),
            "the camera's worker survives: {second:?}"
        );
    }

    #[test]
    fn unreadable_settings_are_never_overwritten_or_guessed_onto_a_camera() {
        let database = Database::open_in_memory_for_tests();
        database
            .save_setting(CAMERA_LOW_LIGHT_SETTINGS_KEY, &"not a map")
            .unwrap();
        let id = "camera:windows-dshow:aa";
        assert!(stored_compensation(&database, id).is_err());
        assert!(
            save_compensation(&database, id, true).is_err(),
            "a save must not replace choices it could not read"
        );
        let kept: String = database
            .load_setting(CAMERA_LOW_LIGHT_SETTINGS_KEY)
            .unwrap()
            .unwrap();
        assert_eq!(kept, "not a map");

        let ops = DeviceOps {
            read: Arc::new(|_: &str| unreachable!("a write pass only writes")),
            write: Arc::new(|_: &str, _: bool| {
                unreachable!("an unreadable choice is never written")
            }),
        };
        let device = run_device_pass(&database, id, &ops, true);
        assert!(
            matches!(device, DeviceLowLight::Failed(ref reason) if reason.contains("unreadable")),
            "{device:?}"
        );
    }

    #[test]
    fn a_missing_setting_is_off() {
        let database = Database::open_in_memory_for_tests();
        assert!(!stored("camera:windows-dshow:aa", &database));
    }

    /// How many callers wait on this camera's next pass.
    fn waiting_replies(camera_id: &str) -> usize {
        CAMERA_WORKERS
            .lock()
            .unwrap()
            .get(camera_id)
            .map_or(0, |work| work.replies.len())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stuck_camera_keeps_no_reply_its_caller_gave_up_on() {
        let database = Database::open_in_memory_for_tests();
        let id = "camera:windows-dshow:test-stuck-replies";
        let camera = stalling_camera(id);
        let short = Duration::from_millis(5);
        let first = device_answer(&database, id, &camera.ops, short, true).await;
        assert!(matches!(first, DeviceLowLight::Failed(_)), "{first:?}");
        let entered = camera.entered;
        tokio::task::spawn_blocking(move || entered.recv().unwrap())
            .await
            .unwrap();

        // Far more timed-out sets and reads than the limit, one after another.
        for n in 0..(CAMERA_LOW_LIGHT_MAX_WAITING * 3) {
            let set = device_answer(&database, id, &camera.ops, short, n % 2 == 0).await;
            assert!(matches!(set, DeviceLowLight::Failed(_)), "{n}: {set:?}");
            assert!(
                waiting_replies(id) <= 1,
                "{n}: replies of callers that gave up are dropped"
            );
        }

        // A burst of callers still waiting is held to the limit; the ones
        // past it are answered at once.
        let mut burst = Vec::new();
        for _ in 0..(CAMERA_LOW_LIGHT_MAX_WAITING + 8) {
            let (reply, answer) = tokio::sync::oneshot::channel();
            request_device_work(&database, id, &camera.ops, DeviceRequest::Read(reply));
            burst.push(answer);
        }
        assert_eq!(waiting_replies(id), CAMERA_LOW_LIGHT_MAX_WAITING);
        let refused = burst
            .iter_mut()
            .map(|answer| answer.try_recv())
            .filter(|answer| {
                matches!(
                    answer,
                    Err(tokio::sync::oneshot::error::TryRecvError::Closed)
                )
            })
            .count();
        assert_eq!(refused, 8, "callers past the limit are answered at once");

        // The burst's callers give up, which frees their places.
        drop(burst);
        camera.release.send(()).unwrap();
        let after = device_answer(&database, id, &camera.ops, Duration::from_secs(30), false).await;
        assert!(after.supported(), "{after:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_read_never_waits_on_a_camera_already_stuck_in_a_pass() {
        let database = Database::open_in_memory_for_tests();
        let id = "camera:windows-dshow:test-stuck-read";
        let camera = stalling_camera(id);
        let first =
            device_answer(&database, id, &camera.ops, Duration::from_millis(50), true).await;
        assert!(matches!(first, DeviceLowLight::Failed(_)), "{first:?}");
        let entered = camera.entered;
        tokio::task::spawn_blocking(move || entered.recv().unwrap())
            .await
            .unwrap();

        // The pass is running; with a zero threshold it already counts as
        // stuck, so the read answers at once without queuing.
        let started = Instant::now();
        let read = device_read_answer(
            &database,
            id,
            &camera.ops,
            Duration::from_secs(30),
            Duration::ZERO,
        )
        .await;
        assert!(
            matches!(read, DeviceLowLight::Failed(ref reason) if reason.contains("not answering")),
            "{read:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "the read did not wait for the stuck pass"
        );
        assert_eq!(*camera.reads.lock().unwrap(), 0, "no read was queued");
        camera.release.send(()).unwrap();
        let after = device_answer(&database, id, &camera.ops, Duration::from_secs(30), false).await;
        assert!(after.supported(), "{after:?}");
    }

    #[test]
    fn the_state_reports_support_from_the_device() {
        let held = DeviceLowLight::Holds {
            compensation: false,
            changed: true,
        };
        let state = state_for("camera:windows-dshow:aa", true, &held);
        assert!(state.supported);
        assert!(state.compensation);
        let missing = DeviceLowLight::Unsupported("no control".to_string());
        assert!(!state_for("camera:windows-dshow:aa", false, &missing).supported);
        assert!(!DeviceLowLight::Failed("stalled".to_string()).supported());
    }

    /// On a Windows box with a UVC camera that has the control:
    /// `VIDEORC_LOW_LIGHT_CAMERA="HP HD Camera" cargo test -p videorc-backend
    /// camera_low_light_on_box -- --ignored`. Flips the camera's control,
    /// reads it back from a fresh open, and puts the original value back.
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "needs a real camera named by VIDEORC_LOW_LIGHT_CAMERA"]
    fn camera_low_light_on_box_round_trip() {
        let name = std::env::var("VIDEORC_LOW_LIGHT_CAMERA")
            .expect("set VIDEORC_LOW_LIGHT_CAMERA to the camera's name");
        let id = crate::camera_capture::windows_dshow_camera_device_id(&name);
        let DeviceLowLight::Holds {
            compensation: original,
            ..
        } = read_device(&id)
        else {
            panic!("{name} has no low-light control: {:?}", read_device(&id));
        };
        let flipped = write_device(&id, !original);
        let reread = read_device(&id);
        let again = write_device(&id, !original);
        let restored = write_device(&id, original);
        assert_eq!(
            flipped,
            DeviceLowLight::Holds {
                compensation: !original,
                changed: true
            }
        );
        assert_eq!(
            reread,
            DeviceLowLight::Holds {
                compensation: !original,
                changed: false
            },
            "a fresh open must see the write"
        );
        assert_eq!(
            again,
            DeviceLowLight::Holds {
                compensation: !original,
                changed: false
            },
            "an unchanged value is not written twice"
        );
        assert_eq!(
            restored,
            DeviceLowLight::Holds {
                compensation: original,
                changed: true
            }
        );
    }

    #[test]
    fn non_windows_camera_ids_are_never_written() {
        // An AVFoundation or V4L2 id has no dshow name; the Windows path
        // refuses it and other platforms refuse every id.
        assert!(!read_device("camera:avfoundation:0").supported());
    }
}
