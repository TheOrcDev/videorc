use std::time::Duration;

use tokio::sync::watch;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraConnectionEvent {
    pub unique_id: String,
    pub name: String,
    pub connected: bool,
    pub timestamp: String,
    pub device_type: String,
    pub transport: i32,
}

fn camera_events() -> &'static std::sync::Mutex<std::collections::VecDeque<CameraConnectionEvent>> {
    static EVENTS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::VecDeque<CameraConnectionEvent>>,
    > = std::sync::OnceLock::new();
    EVENTS.get_or_init(Default::default)
}

fn camera_history() -> &'static std::sync::Mutex<std::collections::VecDeque<CameraConnectionEvent>>
{
    static HISTORY: std::sync::OnceLock<
        std::sync::Mutex<std::collections::VecDeque<CameraConnectionEvent>>,
    > = std::sync::OnceLock::new();
    HISTORY.get_or_init(Default::default)
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn remember_camera_event(
    history: &mut std::collections::VecDeque<CameraConnectionEvent>,
    event: CameraConnectionEvent,
) {
    history.push_back(event);
    while history.len() > 20 {
        history.pop_front();
    }
}

pub(crate) fn recent_camera_connections() -> Vec<CameraConnectionEvent> {
    camera_history()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .cloned()
        .collect()
}

static CAMERA_EVENT_READY: tokio::sync::Notify = tokio::sync::Notify::const_new();

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn camera_changed(event: CameraConnectionEvent) {
    remember_camera_event(
        &mut camera_history().lock().unwrap_or_else(|p| p.into_inner()),
        event.clone(),
    );
    camera_events()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .push_back(event);
    CAMERA_EVENT_READY.notify_one();
}

async fn run_camera_events(state: crate::state::AppState) {
    loop {
        CAMERA_EVENT_READY.notified().await;
        loop {
            let event = camera_events()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .pop_front();
            let Some(event) = event else {
                break;
            };
            crate::preview_camera::camera_connection_changed(&state, &event).await;
        }
    }
}

const DEBOUNCE: Duration = Duration::from_millis(500);

pub fn channel() -> (watch::Sender<u64>, watch::Receiver<u64>) {
    watch::channel(0)
}

// A trailing edge debounce: camera and display bursts share one fresh snapshot.
async fn next_change(changes: &mut watch::Receiver<u64>) -> bool {
    if changes.changed().await.is_err() {
        return false;
    }
    loop {
        tokio::select! {
            result = changes.changed() => {
                if result.is_err() { return false; }
            }
            () = tokio::time::sleep(DEBOUNCE) => return true,
        }
    }
}

pub async fn run(mut changes: watch::Receiver<u64>, state: crate::state::AppState) {
    let camera_state = state.clone();
    state.spawn_process_task(async move { run_camera_events(camera_state).await });
    // Linux has no per-camera notification: the edges come from comparing
    // the openable cameras before and after each change.
    #[cfg(target_os = "linux")]
    let mut cameras =
        linux_cameras::available(&crate::camera_capture::list_native_cameras().devices);
    while next_change(&mut changes).await {
        #[cfg(target_os = "macos")]
        crate::devices::invalidate_avfoundation_probe_cache();
        #[cfg(target_os = "linux")]
        crate::linux_v4l2_camera::forget_v4l2_modes(None);
        let ffmpeg_path = crate::ffmpeg::resolve_ffmpeg_path_ref(None);
        let devices = crate::devices::list_devices(&ffmpeg_path).await;
        #[cfg(target_os = "linux")]
        {
            let now = linux_cameras::available(&devices.devices);
            let removed = linux::take_removed_nodes();
            for event in
                linux_cameras::edges(&cameras, &now, &removed, &chrono::Utc::now().to_rfc3339())
            {
                tracing::info!(
                    camera = %event.unique_id,
                    connected = event.connected,
                    "[device-watch] V4L2 camera {}",
                    if event.connected { "connected" } else { "disconnected" }
                );
                camera_changed(event);
            }
            cameras = now;
        }
        state
            .live_source_switch
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .observe_devices(&devices.devices);
        state.emit_event("devices.changed", &devices);
        // Plan 213 F2: a captured display's new resolution or scale.
        crate::preview_screen::follow_display_size(&state, &devices.devices).await;
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn install(_changes: watch::Sender<u64>) {}

#[cfg(target_os = "linux")]
pub use linux::install;

/// Connection edges between two camera snapshots (plan 257 S2). A camera
/// counts once it can be opened, so a node udev has not yet handed to the
/// `video` group connects when its permissions land, not before.
#[cfg(any(target_os = "linux", test))]
mod linux_cameras {
    use std::collections::{BTreeMap, BTreeSet};

    use super::CameraConnectionEvent;
    use crate::protocol::{Device, DeviceKind, DeviceStatus};

    /// An openable camera as one listing saw it.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct SeenCamera {
        pub name: String,
        /// The `/dev` node its path resolved to then (`video0`), so a node
        /// deleted and recreated between two listings is still seen to go.
        pub node: Option<String>,
    }

    /// Openable cameras by the unique id a running camera reports (the
    /// V4L2 device path).
    pub fn available(devices: &[Device]) -> BTreeMap<String, SeenCamera> {
        devices
            .iter()
            .filter(|device| {
                device.kind == DeviceKind::Camera && device.status == DeviceStatus::Available
            })
            .map(|device| {
                let path = crate::linux_v4l2_camera::parse_linux_v4l2_camera_id(&device.id)
                    .unwrap_or_else(|| device.id.clone());
                let node = std::fs::canonicalize(&path).ok().and_then(|resolved| {
                    resolved
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                });
                (
                    path,
                    SeenCamera {
                        name: device.name.clone(),
                        node,
                    },
                )
            })
            .collect()
    }

    /// Disconnects, then connects. A camera in both listings whose node was
    /// deleted in between (an unplug and replug inside one debounce) bounces:
    /// its capture child died with the old node, so it must reconnect.
    pub fn edges(
        before: &BTreeMap<String, SeenCamera>,
        after: &BTreeMap<String, SeenCamera>,
        removed_nodes: &BTreeSet<String>,
        timestamp: &str,
    ) -> Vec<CameraConnectionEvent> {
        let event = |unique_id: &String, camera: &SeenCamera, connected| CameraConnectionEvent {
            unique_id: unique_id.clone(),
            name: camera.name.clone(),
            connected,
            timestamp: timestamp.to_string(),
            device_type: "v4l2".to_string(),
            transport: 0,
        };
        let bounced = |id: &String, camera: &SeenCamera| {
            after.contains_key(id)
                && camera
                    .node
                    .as_ref()
                    .is_some_and(|node| removed_nodes.contains(node))
        };
        let gone = before
            .iter()
            .filter(|(id, camera)| !after.contains_key(*id) || bounced(id, camera))
            .map(|(id, camera)| event(id, camera, false));
        let came = after
            .iter()
            .filter(|(id, _)| before.get(*id).is_none_or(|camera| bounced(id, camera)))
            .map(|(id, camera)| event(id, camera, true));
        gone.chain(came).collect()
    }
}

/// Camera hotplug on Linux (plan 257 S2): inotify on `/dev` for `video*`
/// nodes appearing, going, or getting their permissions from udev, and on
/// `/dev/v4l` and `/dev/v4l/by-id` for the stable links udev adds last. Each
/// relevant event bumps the same revision the macOS observers do; the
/// debounce in `run` folds udev's burst into one fresh listing.
#[cfg(target_os = "linux")]
mod linux {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    use tokio::sync::watch;

    const DIR_MASK: u32 = libc::IN_CREATE
        | libc::IN_DELETE
        | libc::IN_ATTRIB
        | libc::IN_MOVED_FROM
        | libc::IN_MOVED_TO;

    /// `video*` nodes deleted since the last listing took them.
    fn removed_nodes() -> &'static std::sync::Mutex<std::collections::BTreeSet<String>> {
        static REMOVED: std::sync::OnceLock<std::sync::Mutex<std::collections::BTreeSet<String>>> =
            std::sync::OnceLock::new();
        REMOVED.get_or_init(Default::default)
    }

    pub(super) fn take_removed_nodes() -> std::collections::BTreeSet<String> {
        std::mem::take(
            &mut *removed_nodes()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }

    pub fn install(changes: watch::Sender<u64>) {
        if let Err(error) = spawn_watch(PathBuf::from("/dev"), changes) {
            tracing::warn!("Could not watch /dev for camera hotplug: {error}");
        }
    }

    fn add_watch(fd: i32, path: &Path) -> Option<i32> {
        let path = CString::new(path.as_os_str().as_bytes()).ok()?;
        // SAFETY: a valid NUL-terminated path on an inotify fd this thread owns.
        let wd = unsafe { libc::inotify_add_watch(fd, path.as_ptr(), DIR_MASK) };
        (wd >= 0).then_some(wd)
    }

    /// Whether an event in `/dev` names a V4L2 node or the `v4l` link tree.
    pub(super) fn dev_entry_is_camera(name: &[u8]) -> bool {
        name.starts_with(b"video") || name == b"v4l"
    }

    /// Watches `dev` until it goes away (tests remove theirs; `/dev` never
    /// does).
    pub(super) fn spawn_watch(
        dev: PathBuf,
        changes: watch::Sender<u64>,
    ) -> std::io::Result<std::thread::JoinHandle<()>> {
        // SAFETY: plain syscall; the fd is owned below and closed on exit.
        let fd = unsafe { libc::inotify_init1(libc::IN_CLOEXEC) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let Some(dev_wd) = add_watch(fd, &dev) else {
            let error = std::io::Error::last_os_error();
            // SAFETY: closing the fd created above.
            unsafe { libc::close(fd) };
            return Err(error);
        };
        let links = [dev.join("v4l"), dev.join("v4l/by-id")];
        for link_dir in &links {
            add_watch(fd, link_dir);
        }
        std::thread::Builder::new()
            .name("videorc-camera-hotplug".to_string())
            .spawn(move || {
                // Room for many events; each is 16 bytes plus a padded name.
                let mut buffer = [0_u8; 8192];
                'watch: loop {
                    // SAFETY: reads into a buffer this thread owns.
                    let read = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
                    if read < 0 {
                        if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                            continue;
                        }
                        break;
                    }
                    let read = read as usize;
                    let mut relevant = false;
                    let mut offset = 0;
                    while offset + 16 <= read {
                        let field = |at: usize| {
                            u32::from_ne_bytes(
                                buffer[offset + at..offset + at + 4].try_into().unwrap(),
                            )
                        };
                        let wd = field(0) as i32;
                        let mask = field(4);
                        let len = field(12) as usize;
                        let name_end = (offset + 16 + len).min(read);
                        let name = &buffer[offset + 16..name_end];
                        let name = &name[..name.iter().position(|b| *b == 0).unwrap_or(name.len())];
                        offset += 16 + len;
                        if wd == dev_wd {
                            if mask & libc::IN_IGNORED != 0 {
                                break 'watch;
                            }
                            let camera = dev_entry_is_camera(name);
                            relevant |= camera;
                            if camera
                                && name.starts_with(b"video")
                                && mask & (libc::IN_DELETE | libc::IN_MOVED_FROM) != 0
                            {
                                removed_nodes()
                                    .lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                                    .insert(String::from_utf8_lossy(name).into_owned());
                            }
                        } else if mask & libc::IN_IGNORED == 0 {
                            // Anything in /dev/v4l or /dev/v4l/by-id.
                            relevant = true;
                        }
                    }
                    if relevant {
                        // The link tree comes and goes with the first and
                        // last camera; re-adding an existing watch is a no-op.
                        for link_dir in &links {
                            add_watch(fd, link_dir);
                        }
                        changes.send_modify(|revision| *revision = revision.wrapping_add(1));
                    }
                }
                // SAFETY: closing the fd this thread owns.
                unsafe { libc::close(fd) };
            })
    }
}

#[cfg(target_os = "macos")]
pub use macos::install;

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_av_foundation::{
        AVCaptureDeviceWasConnectedNotification, AVCaptureDeviceWasDisconnectedNotification,
    };
    use objc2_core_graphics::{
        CGDirectDisplayID, CGDisplayChangeSummaryFlags, CGDisplayRegisterReconfigurationCallback,
        CGDisplayRemoveReconfigurationCallback, CGError,
    };
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol};
    use tokio::sync::watch;

    pub struct DeviceWatch {
        center: Retained<NSNotificationCenter>,
        observers: Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
        changes: Box<watch::Sender<u64>>,
        display_registered: bool,
    }

    fn changed(changes: &watch::Sender<u64>) {
        changes.send_modify(|revision| *revision = revision.wrapping_add(1));
    }

    unsafe extern "C-unwind" fn display_changed(
        _display: CGDirectDisplayID,
        flags: CGDisplayChangeSummaryFlags,
        context: *mut c_void,
    ) {
        // The begin callback precedes the new configuration; enumerate after it settles.
        if !flags.contains(CGDisplayChangeSummaryFlags::BeginConfigurationFlag) {
            // SAFETY: install owns this box until after callback removal in Drop.
            changed(unsafe { &*context.cast::<watch::Sender<u64>>() });
        }
    }

    // Called on the process main thread before its existing CFRunLoop starts.
    pub fn install(changes: watch::Sender<u64>) -> DeviceWatch {
        let center = NSNotificationCenter::defaultCenter();
        let mut observers = Vec::new();
        for (name, connected) in unsafe {
            [
                (AVCaptureDeviceWasConnectedNotification, true),
                (AVCaptureDeviceWasDisconnectedNotification, false),
            ]
        } {
            let changes = changes.clone();
            let block = RcBlock::new(move |notification: NonNull<NSNotification>| {
                // AVFoundation supplies the device as the notification object. Copy
                // identity only; capture teardown and restart run on the backend.
                if let Some(object) = unsafe { notification.as_ref() }.object() {
                    let camera: &objc2_av_foundation::AVCaptureDevice =
                        unsafe { &*objc2::rc::Retained::as_ptr(&object).cast() };
                    if unsafe {
                        camera.hasMediaType(objc2_av_foundation::AVMediaTypeVideo.unwrap())
                    } {
                        super::camera_changed(super::CameraConnectionEvent {
                            unique_id: unsafe { camera.uniqueID() }.to_string(),
                            name: unsafe { camera.localizedName() }.to_string(),
                            connected,
                            timestamp: chrono::Utc::now().to_rfc3339(),
                            device_type: unsafe { camera.deviceType() }.to_string(),
                            transport: unsafe { camera.transportType() },
                        });
                    }
                }
                changed(&changes);
            });
            // SAFETY: no object filter or queue; the block only signals a thread-safe channel.
            observers.push(unsafe {
                center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
            });
        }
        let mut changes = Box::new(changes);
        // SAFETY: stable box address, kept alive until the callback is removed.
        let result = unsafe {
            CGDisplayRegisterReconfigurationCallback(
                Some(display_changed),
                (&mut *changes as *mut watch::Sender<u64>).cast(),
            )
        };
        if result != CGError::Success {
            eprintln!("Could not watch display changes: {result:?}");
        }
        DeviceWatch {
            center,
            observers,
            changes,
            display_registered: result == CGError::Success,
        }
    }

    impl Drop for DeviceWatch {
        fn drop(&mut self) {
            // SAFETY: these are this watch's retained tokens and registered context.
            unsafe {
                if self.display_registered {
                    CGDisplayRemoveReconfigurationCallback(
                        Some(display_changed),
                        (&mut *self.changes as *mut watch::Sender<u64>).cast(),
                    );
                }
                for observer in &self.observers {
                    self.center.removeObserver(observer.as_ref());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camera_history_keeps_the_last_twenty_edges_with_times_and_identity() {
        let mut history = std::collections::VecDeque::new();
        for index in 0..25 {
            remember_camera_event(
                &mut history,
                CameraConnectionEvent {
                    unique_id: "stable-iPhone-id".to_string(),
                    name: "iPhone".to_string(),
                    device_type: "AVCaptureDeviceTypeContinuityCamera".to_string(),
                    transport: 0,
                    connected: index % 2 == 0,
                    timestamp: format!("2026-11-01T12:00:{index:02}Z"),
                },
            );
        }
        assert_eq!(history.len(), 20);
        let json = serde_json::to_value(&history).unwrap();
        assert_eq!(json[0]["timestamp"], "2026-11-01T12:00:05Z");
        assert_eq!(json[19]["uniqueId"], "stable-iPhone-id");
        assert_eq!(json[19]["connected"], true);
    }

    fn camera(
        path: &str,
        name: &str,
        status: crate::protocol::DeviceStatus,
    ) -> crate::protocol::Device {
        crate::protocol::Device {
            app: None,
            window_title: None,
            display_uuid: None,
            id: crate::linux_v4l2_camera::linux_v4l2_camera_id(path),
            name: name.to_string(),
            kind: crate::protocol::DeviceKind::Camera,
            status,
            detail: None,
            width: None,
            height: None,
        }
    }

    #[test]
    fn linux_camera_edges_follow_openable_cameras_by_device_path() {
        use crate::protocol::DeviceStatus;
        let lid = "/dev/v4l/by-id/usb-Apple_FaceTime-video-index0";
        let usb = "/dev/v4l/by-id/usb-Logitech_C920-video-index0";
        let before =
            linux_cameras::available(&[camera(lid, "FaceTime HD", DeviceStatus::Available)]);
        // udev has created the node but not yet handed it to `video`.
        let racing = linux_cameras::available(&[
            camera(lid, "FaceTime HD", DeviceStatus::Available),
            camera(usb, "C920", DeviceStatus::PermissionRequired),
        ]);
        let none = std::collections::BTreeSet::new();
        assert!(linux_cameras::edges(&before, &racing, &none, "t0").is_empty());
        let plugged = linux_cameras::available(&[
            camera(lid, "FaceTime HD", DeviceStatus::Available),
            camera(usb, "C920", DeviceStatus::Available),
        ]);
        let connected = linux_cameras::edges(&racing, &plugged, &none, "t1");
        assert_eq!(connected.len(), 1);
        // The unique id is the device path a running camera reports.
        assert_eq!(connected[0].unique_id, usb);
        assert_eq!(connected[0].name, "C920");
        assert!(connected[0].connected);
        assert_eq!(connected[0].timestamp, "t1");
        let unplugged = linux_cameras::edges(&plugged, &before, &none, "t2");
        assert_eq!(unplugged.len(), 1);
        assert_eq!(unplugged[0].unique_id, usb);
        assert!(!unplugged[0].connected);
    }

    #[test]
    fn a_camera_replugged_inside_one_debounce_still_bounces() {
        use linux_cameras::SeenCamera;
        let usb = "/dev/v4l/by-id/usb-Logitech_C920-video-index0".to_string();
        let seen = |node: &str| {
            std::collections::BTreeMap::from([(
                usb.clone(),
                SeenCamera {
                    name: "C920".to_string(),
                    node: Some(node.to_string()),
                },
            )])
        };
        // Both listings show the camera; its node went away in between (the
        // same number or a new one), so its capture child is gone.
        for after in ["video2", "video4"] {
            let removed = std::collections::BTreeSet::from(["video2".to_string()]);
            let events = linux_cameras::edges(&seen("video2"), &seen(after), &removed, "t");
            let order: Vec<_> = events
                .iter()
                .map(|event| (event.unique_id.as_str(), event.connected))
                .collect();
            assert_eq!(order, [(usb.as_str(), false), (usb.as_str(), true)]);
        }
        // Another camera's node going leaves this one alone.
        let removed = std::collections::BTreeSet::from(["video0".to_string()]);
        assert!(linux_cameras::edges(&seen("video2"), &seen("video2"), &removed, "t").is_empty());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_hotplug_watch_signals_video_nodes_and_links_only() {
        let dev = std::env::temp_dir().join(format!("videorc-dev-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dev).unwrap();
        let (sender, mut receiver) = channel();
        let handle = linux::spawn_watch(dev.clone(), sender).unwrap();
        let wait_for_change = |receiver: &mut watch::Receiver<u64>| {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while std::time::Instant::now() < deadline {
                if receiver.has_changed().unwrap() {
                    receiver.mark_unchanged();
                    return true;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            false
        };

        // An unrelated node: no change.
        std::fs::write(dev.join("ttyS9"), b"").unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(!receiver.has_changed().unwrap());

        // A camera appears: node, then udev's permissions, then its links.
        std::fs::write(dev.join("video4"), b"").unwrap();
        assert!(wait_for_change(&mut receiver), "node create");
        std::fs::set_permissions(
            dev.join("video4"),
            std::os::unix::fs::PermissionsExt::from_mode(0o660),
        )
        .unwrap();
        assert!(wait_for_change(&mut receiver), "udev chmod");
        std::fs::create_dir_all(dev.join("v4l/by-id")).unwrap();
        assert!(wait_for_change(&mut receiver), "link tree");
        // The by-id watch is added after the tree appears; give it a beat.
        std::thread::sleep(Duration::from_millis(100));
        while receiver.has_changed().unwrap() {
            receiver.mark_unchanged();
        }
        std::os::unix::fs::symlink("../../video4", dev.join("v4l/by-id/usb-cam-video-index0"))
            .unwrap();
        assert!(wait_for_change(&mut receiver), "stable link");

        // And goes.
        std::fs::remove_file(dev.join("v4l/by-id/usb-cam-video-index0")).unwrap();
        std::fs::remove_file(dev.join("video4")).unwrap();
        assert!(wait_for_change(&mut receiver), "unplug");

        std::fs::remove_dir_all(&dev).unwrap();
        handle.join().unwrap();
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn dev_entries_that_count_as_cameras() {
        assert!(linux::dev_entry_is_camera(b"video0"));
        assert!(linux::dev_entry_is_camera(b"v4l"));
        assert!(!linux::dev_entry_is_camera(b"v4l-subdev0"));
        assert!(!linux::dev_entry_is_camera(b"hidraw3"));
    }

    #[tokio::test(start_paused = true)]
    async fn device_watch_debounces_until_500_ms_after_the_last_change() {
        let (sender, mut receiver) = channel();
        let task = tokio::spawn(async move {
            assert!(next_change(&mut receiver).await);
            receiver
        });
        sender.send(1).unwrap();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(499)).await;
        assert!(!task.is_finished());
        sender.send(2).unwrap();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(499)).await;
        assert!(!task.is_finished());
        tokio::time::advance(Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert!(task.is_finished());
        let mut receiver = task.await.unwrap();
        drop(sender);
        assert!(!next_change(&mut receiver).await);
    }
}
