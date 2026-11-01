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
    static EVENTS: std::sync::OnceLock<std::sync::Mutex<std::collections::VecDeque<CameraConnectionEvent>>> = std::sync::OnceLock::new();
    EVENTS.get_or_init(Default::default)
}

fn camera_history() -> &'static std::sync::Mutex<std::collections::VecDeque<CameraConnectionEvent>> {
    static HISTORY: std::sync::OnceLock<std::sync::Mutex<std::collections::VecDeque<CameraConnectionEvent>>> = std::sync::OnceLock::new();
    HISTORY.get_or_init(Default::default)
}

#[cfg(any(target_os = "macos", test))]
fn remember_camera_event(history: &mut std::collections::VecDeque<CameraConnectionEvent>, event: CameraConnectionEvent) {
    history.push_back(event);
    while history.len() > 20 { history.pop_front(); }
}

pub(crate) fn recent_camera_connections() -> Vec<CameraConnectionEvent> {
    camera_history().lock().unwrap_or_else(|p| p.into_inner()).iter().cloned().collect()
}

static CAMERA_EVENT_READY: tokio::sync::Notify = tokio::sync::Notify::const_new();

#[cfg(target_os = "macos")]
fn camera_changed(event: CameraConnectionEvent) {
    remember_camera_event(&mut camera_history().lock().unwrap_or_else(|p| p.into_inner()), event.clone());
    camera_events().lock().unwrap_or_else(|p| p.into_inner()).push_back(event);
    CAMERA_EVENT_READY.notify_one();
}

async fn run_camera_events(state: crate::state::AppState) {
    loop {
        CAMERA_EVENT_READY.notified().await;
        loop {
            let event = camera_events().lock().unwrap_or_else(|p| p.into_inner()).pop_front();
            let Some(event) = event else { break; };
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
    while next_change(&mut changes).await {
        crate::devices::invalidate_avfoundation_probe_cache();
        let ffmpeg_path = crate::ffmpeg::resolve_ffmpeg_path_ref(None);
        let devices = crate::devices::list_devices(&ffmpeg_path).await;
        state
            .live_source_switch
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .observe_devices(&devices.devices);
        state.emit_event("devices.changed", &devices);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn install(_changes: watch::Sender<u64>) {}

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
                    let camera: &objc2_av_foundation::AVCaptureDevice = unsafe {
                        &*objc2::rc::Retained::as_ptr(&object).cast()
                    };
                    if unsafe { camera.hasMediaType(objc2_av_foundation::AVMediaTypeVideo.unwrap()) } {
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
            remember_camera_event(&mut history, CameraConnectionEvent {
                unique_id: "stable-iPhone-id".to_string(), name: "iPhone".to_string(),
                device_type: "AVCaptureDeviceTypeContinuityCamera".to_string(), transport: 0,
                connected: index % 2 == 0, timestamp: format!("2026-11-01T12:00:{index:02}Z"),
            });
        }
        assert_eq!(history.len(), 20);
        let json = serde_json::to_value(&history).unwrap();
        assert_eq!(json[0]["timestamp"], "2026-11-01T12:00:05Z");
        assert_eq!(json[19]["uniqueId"], "stable-iPhone-id");
        assert_eq!(json[19]["connected"], true);
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
