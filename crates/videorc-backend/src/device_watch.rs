use std::time::Duration;

use tokio::sync::watch;

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
        // Plan 213 F2: a captured display's new resolution or scale.
        crate::preview_screen::follow_display_size(&state, &devices.devices).await;
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
        for name in unsafe {
            [
                AVCaptureDeviceWasConnectedNotification,
                AVCaptureDeviceWasDisconnectedNotification,
            ]
        } {
            let changes = changes.clone();
            let block =
                RcBlock::new(move |_notification: NonNull<NSNotification>| changed(&changes));
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
