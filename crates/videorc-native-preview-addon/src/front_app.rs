//! Local foreground metadata only. Never requests Accessibility, captures pixels,
//! or reads kCGWindowName (which is gated by Screen Recording).
use std::cell::RefCell;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, NSObject};
use objc2::{ClassType, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::NSWorkspace;
use objc2_foundation::NSString;

type Callback = ThreadsafeFunction<FrontApp, (), FrontApp, Status, false, true>;
thread_local! {
    static CALLBACK: RefCell<Option<Callback>> = const { RefCell::new(None) };
    static OBSERVER: RefCell<Option<Retained<FrontAppObserver>>> = const { RefCell::new(None) };
}

#[napi(object)]
pub struct FrontApp {
    pub bundle_id: Option<String>,
    pub name: String,
    pub pid: i32,
}
#[napi(object)]
pub struct FrontWindow {
    pub window_id: String,
    pub width: f64,
    pub height: f64,
}

fn main_thread() -> Result<MainThreadMarker> {
    MainThreadMarker::new()
        .ok_or_else(|| Error::from_reason("Front-app APIs require the main thread"))
}

#[napi]
pub fn frontmost_app() -> Result<Option<FrontApp>> {
    main_thread()?;
    unsafe {
        let app: Option<Retained<AnyObject>> =
            msg_send![&*NSWorkspace::sharedWorkspace(), frontmostApplication];
        Ok(app.map(|app| app_metadata(&app)))
    }
}

fn app_metadata(app: &AnyObject) -> FrontApp {
    unsafe {
        let bundle: Option<Retained<NSString>> = msg_send![app, bundleIdentifier];
        let name: Option<Retained<NSString>> = msg_send![app, localizedName];
        FrontApp {
            bundle_id: bundle.map(|s| s.to_string()),
            name: name.map(|s| s.to_string()).unwrap_or_default(),
            pid: msg_send![app, processIdentifier],
        }
    }
}

#[napi]
pub fn self_bundle_id() -> Result<Option<String>> {
    main_thread()?;
    unsafe {
        let bundle: Retained<AnyObject> =
            msg_send![AnyClass::get(c"NSBundle").unwrap(), mainBundle];
        let id: Option<Retained<NSString>> = msg_send![&*bundle, bundleIdentifier];
        Ok(id.map(|s| s.to_string()))
    }
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "VideorcFrontAppObserver"]
    struct FrontAppObserver;
    impl FrontAppObserver {
        #[unsafe(method(activated:))]
        fn activated(&self, notification: &AnyObject) {
            // Preserve the application in this notification even if another
            // activation occurs before JS drains its threadsafe queue.
            let app = unsafe {
                let info: Option<Retained<AnyObject>> = msg_send![notification, userInfo];
                info.and_then(|info| field(&info, "NSWorkspaceApplicationKey"))
            };
            if let Some(app) = app {
                let app = app_metadata(&app);
                CALLBACK.with_borrow(|cb| {
                    if let Some(cb) = cb {
                        cb.call(app, ThreadsafeFunctionCallMode::NonBlocking);
                    }
                });
            }
        }
    }
);

#[napi]
pub fn start_front_app_observer(callback: Function<FrontApp, ()>) -> Result<()> {
    main_thread()?;
    stop_front_app_observer()?;
    let callback = callback
        .build_threadsafe_function()
        .callee_handled::<false>()
        .weak::<true>()
        .build()?;
    CALLBACK.with_borrow_mut(|cb| *cb = Some(callback));
    unsafe {
        let observer: Retained<FrontAppObserver> = msg_send![FrontAppObserver::class(), new];
        let center: Retained<AnyObject> =
            msg_send![&*NSWorkspace::sharedWorkspace(), notificationCenter];
        let _: () = msg_send![&*center, addObserver: &*observer, selector: sel!(activated:), name: &*NSString::from_str("NSWorkspaceDidActivateApplicationNotification"), object: std::ptr::null::<AnyObject>()];
        OBSERVER.with_borrow_mut(|slot| *slot = Some(observer));
    }
    Ok(())
}

#[napi]
pub fn stop_front_app_observer() -> Result<()> {
    main_thread()?;
    OBSERVER.with_borrow_mut(|slot| {
        if let Some(observer) = slot.take() {
            unsafe {
                let center: Retained<AnyObject> =
                    msg_send![&*NSWorkspace::sharedWorkspace(), notificationCenter];
                let _: () = msg_send![&*center, removeObserver: &*observer];
            }
        }
    });
    CALLBACK.with_borrow_mut(|cb| *cb = None);
    Ok(())
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGWindowListCopyWindowInfo(options: u32, relative_to: u32) -> *mut AnyObject;
}

unsafe fn field(dict: &AnyObject, key: &str) -> Option<Retained<AnyObject>> {
    unsafe { msg_send![dict, objectForKey: &*NSString::from_str(key)] }
}
unsafe fn number(dict: &AnyObject, key: &str) -> Option<f64> {
    unsafe { field(dict, key).map(|value| msg_send![&*value, doubleValue]) }
}

#[napi]
pub fn front_window_for_pid(
    pid: i32,
    min_width: Option<f64>,
    min_height: Option<f64>,
) -> Result<Option<FrontWindow>> {
    main_thread()?;
    // CG's copy rule transfers ownership; CFArray/CFDictionary are toll-free
    // bridged to NSArray/NSDictionary. The list is already front to back.
    unsafe {
        let Some(windows) = Retained::from_raw(CGWindowListCopyWindowInfo(1 | 16, 0)) else {
            return Ok(None);
        };
        let count: usize = msg_send![&*windows, count];
        for index in 0..count {
            let window: Retained<AnyObject> = msg_send![&*windows, objectAtIndex: index];
            if number(&window, "kCGWindowOwnerPID") != Some(pid as f64)
                || number(&window, "kCGWindowLayer") != Some(0.0)
            {
                continue;
            }
            let Some(bounds) = field(&window, "kCGWindowBounds") else {
                continue;
            };
            let width = number(&bounds, "Width").unwrap_or(0.0);
            let height = number(&bounds, "Height").unwrap_or(0.0);
            if width < min_width.unwrap_or(400.0) || height < min_height.unwrap_or(300.0) {
                continue;
            }
            if let Some(id) = number(&window, "kCGWindowNumber") {
                return Ok(Some(FrontWindow {
                    window_id: format!("window:screencapturekit:{}", id as u32),
                    width,
                    height,
                }));
            }
        }
    }
    Ok(None)
}
