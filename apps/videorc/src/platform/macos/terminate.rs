//! The Dock's Quit, a logout and a restart while on air (P1515, P1496):
//! they reach `NSApplication terminate:`, which asks the app delegate
//! `applicationShouldTerminate:` first. GPUI 0.3.14's delegate
//! (`GPUIApplicationDelegate`, gpui-pre-macos `platform.rs`) answers only
//! `applicationWillTerminate:`, which can't cancel, so the app adds the
//! question to GPUI's class at launch instead of patching GPUI (plan 260
//! D1 keeps the patches to a minimum).
//!
//! The answer is the app's exit guard's: "now" unless it holds the quit,
//! in which case it has already put the End livestream question up and the
//! reply is "cancel". A yes quits again through GPUI, whose `quit()` sends
//! `terminate:` from the main queue (never inside an `App` borrow), and the
//! guard lets that one through. AppKit asks on the main thread, the only
//! thread the hook is kept on.

use std::cell::RefCell;
use std::ffi::{c_char, c_void};

use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
use objc2::sel;

/// `NSApplicationTerminateReply`.
const TERMINATE_CANCEL: usize = 0;
const TERMINATE_NOW: usize = 1;

/// GPUI's app delegate class (gpui-pre-macos 0.3.14 `platform.rs`).
const GPUI_DELEGATE_CLASS: &std::ffi::CStr = c"GPUIApplicationDelegate";

/// `NSApplicationTerminateReply (id, SEL, NSApplication *)`.
const SHOULD_TERMINATE_TYPES: &std::ffi::CStr = c"Q@:@";

#[link(name = "objc")]
unsafe extern "C" {
    fn class_addMethod(
        cls: *const AnyClass,
        name: Sel,
        imp: *const c_void,
        types: *const c_char,
    ) -> Bool;
}

thread_local! {
    /// Whether the app may terminate now; `None` until installed.
    static MAY_TERMINATE: RefCell<Option<Box<dyn Fn() -> bool>>> = const { RefCell::new(None) };
}

extern "C-unwind" fn should_terminate(_: &AnyObject, _: Sel, _: *mut AnyObject) -> usize {
    let may = MAY_TERMINATE.with(|hook| hook.borrow().as_ref().map(|may| may()));
    if may == Some(false) {
        TERMINATE_CANCEL
    } else {
        TERMINATE_NOW
    }
}

/// Answers `applicationShouldTerminate:` with `may_terminate`. Call on the
/// main thread once GPUI has made its delegate class (inside `run`).
pub fn hold_terminate(may_terminate: Box<dyn Fn() -> bool>) -> Result<(), String> {
    let class = AnyClass::get(GPUI_DELEGATE_CLASS)
        .ok_or_else(|| "GPUI's app delegate class is not registered".to_string())?;
    MAY_TERMINATE.with(|hook| *hook.borrow_mut() = Some(may_terminate));
    let imp = should_terminate as extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize;
    // SAFETY: a registered class, a selector, a function with the
    // selector's signature (`SHOULD_TERMINATE_TYPES`), on the main thread.
    let added = unsafe {
        class_addMethod(
            class,
            sel!(applicationShouldTerminate:),
            imp as *const c_void,
            SHOULD_TERMINATE_TYPES.as_ptr(),
        )
    };
    if added.as_bool() {
        Ok(())
    } else {
        Err("GPUI's app delegate already answers applicationShouldTerminate:".into())
    }
}
