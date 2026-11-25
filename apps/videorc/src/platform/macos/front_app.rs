//! The app in front, for Follow the app in front and the password-manager
//! hide (plan 210 D10/D11, `videorc_app_core::studio::follow_runner`): the
//! same AppKit reads as Electron's addon (`front_app.rs` in
//! `videorc-native-preview-addon`). Local foreground metadata only: it never
//! asks for Accessibility, captures pixels, or reads `kCGWindowName` (which
//! Screen Recording gates). Main thread only.

use std::cell::RefCell;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, NSObject};
use objc2::{ClassType, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_foundation::NSString;
use tokio::sync::mpsc::UnboundedSender;
use videorc_app_core::scenes::follow::FrontApp;

thread_local! {
    static SENDER: RefCell<Option<UnboundedSender<FrontApp>>> = const { RefCell::new(None) };
    static OBSERVER: RefCell<Option<Retained<FrontAppObserver>>> = const { RefCell::new(None) };
    /// The last app sent, so an unchanged front app is not sent twice.
    static LAST: RefCell<Option<FrontApp>> = const { RefCell::new(None) };
}

fn workspace() -> Option<Retained<AnyObject>> {
    let class = AnyClass::get(c"NSWorkspace")?;
    unsafe { msg_send![class, sharedWorkspace] }
}

unsafe fn field(dict: &AnyObject, key: &str) -> Option<Retained<AnyObject>> {
    unsafe { msg_send![dict, objectForKey: &*NSString::from_str(key)] }
}

unsafe fn number(dict: &AnyObject, key: &str) -> Option<f64> {
    unsafe { field(dict, key).map(|value| msg_send![&*value, doubleValue]) }
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGWindowListCopyWindowInfo(options: u32, relative_to: u32) -> *mut AnyObject;
}

/// The app's frontmost normal window of at least 400 × 300 points, as a
/// ScreenCaptureKit window id (`frontWindowForPid`).
fn front_window_for_pid(pid: i32) -> Option<String> {
    // On screen only (1) and excluding desktop elements (16); the list is
    // front to back. CG's copy rule hands over ownership.
    unsafe {
        let windows = Retained::from_raw(CGWindowListCopyWindowInfo(1 | 16, 0))?;
        let count: usize = msg_send![&*windows, count];
        for index in 0..count {
            let window: Retained<AnyObject> = msg_send![&*windows, objectAtIndex: index];
            if number(&window, "kCGWindowOwnerPID") != Some(f64::from(pid))
                || number(&window, "kCGWindowLayer") != Some(0.0)
            {
                continue;
            }
            let Some(bounds) = field(&window, "kCGWindowBounds") else {
                continue;
            };
            let width = number(&bounds, "Width").unwrap_or(0.0);
            let height = number(&bounds, "Height").unwrap_or(0.0);
            if width < 400.0 || height < 300.0 {
                continue;
            }
            if let Some(id) = number(&window, "kCGWindowNumber") {
                return Some(format!("window:screencapturekit:{}", id as u32));
            }
        }
    }
    None
}

fn app_metadata(app: &AnyObject) -> Option<FrontApp> {
    unsafe {
        let bundle: Option<Retained<NSString>> = msg_send![app, bundleIdentifier];
        let name: Option<Retained<NSString>> = msg_send![app, localizedName];
        let pid: i32 = msg_send![app, processIdentifier];
        // An app without a bundle id is never followed (Electron drops it).
        let bundle_id = bundle.map(|id| id.to_string())?;
        Some(FrontApp {
            bundle_id,
            name: name.map(|name| name.to_string()).unwrap_or_default(),
            pid,
            front_window_id: front_window_for_pid(pid),
        })
    }
}

/// Sends `app` unless it is the one sent last.
fn publish(app: FrontApp) {
    let fresh = LAST.with_borrow_mut(|last| {
        if last.as_ref() == Some(&app) {
            return false;
        }
        *last = Some(app.clone());
        true
    });
    if fresh {
        SENDER.with_borrow(|sender| {
            if let Some(sender) = sender {
                let _ = sender.send(app);
            }
        });
    }
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "VideorcGpuiFrontAppObserver"]
    struct FrontAppObserver;
    impl FrontAppObserver {
        #[unsafe(method(activated:))]
        fn activated(&self, notification: &AnyObject) {
            // The application in this notification, even if another one
            // activates before the follower reads it.
            let app = unsafe {
                let info: Option<Retained<AnyObject>> = msg_send![notification, userInfo];
                info.and_then(|info| field(&info, "NSWorkspaceApplicationKey"))
            };
            if let Some(app) = app.as_deref().and_then(app_metadata) {
                publish(app);
            }
        }
    }
);

/// The app in front now, with its front window.
pub fn frontmost() -> Option<FrontApp> {
    MainThreadMarker::new()?;
    let workspace = workspace()?;
    let app: Option<Retained<AnyObject>> = unsafe { msg_send![&*workspace, frontmostApplication] };
    app.as_deref().and_then(app_metadata)
}

/// This bundle's id, when the app runs from one (a bare dev binary has none).
pub fn self_bundle_id() -> Option<String> {
    MainThreadMarker::new()?;
    unsafe {
        let class = AnyClass::get(c"NSBundle")?;
        let bundle: Retained<AnyObject> = msg_send![class, mainBundle];
        let id: Option<Retained<NSString>> = msg_send![&*bundle, bundleIdentifier];
        id.map(|id| id.to_string())
    }
}

/// Starts watching app activations (`NSWorkspaceDidActivateApplication`) and
/// sends the app in front now. False off the main thread or without AppKit.
pub fn start(sender: UnboundedSender<FrontApp>) -> bool {
    let Some(_main) = MainThreadMarker::new() else {
        return false;
    };
    let Some(workspace) = workspace() else {
        return false;
    };
    SENDER.with_borrow_mut(|slot| *slot = Some(sender));
    unsafe {
        let observer: Retained<FrontAppObserver> = msg_send![FrontAppObserver::class(), new];
        let center: Retained<AnyObject> = msg_send![&*workspace, notificationCenter];
        let name = NSString::from_str("NSWorkspaceDidActivateApplicationNotification");
        let _: () = msg_send![
            &*center,
            addObserver: &*observer,
            selector: sel!(activated:),
            name: &*name,
            object: std::ptr::null::<AnyObject>()
        ];
        OBSERVER.with_borrow_mut(|slot| *slot = Some(observer));
    }
    if let Some(app) = frontmost() {
        publish(app);
    }
    true
}

/// The 500 ms window watch (`setFrontWindowWatch`): the app in front again,
/// sent only when it or its front window changed.
pub fn poll() {
    if let Some(app) = frontmost() {
        publish(app);
    }
}
