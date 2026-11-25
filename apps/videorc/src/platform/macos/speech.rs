//! Edit → Speech (P1498): Start Speaking and Stop Speaking, Electron's
//! `startSpeaking` and `stopSpeaking` roles. AppKit's roles send
//! `startSpeaking:` to the first responder, an `NSTextView`; a GPUI text
//! field is not one, so the app speaks the focused field's text itself with
//! `NSSpeechSynthesizer`, the synthesizer those roles use, in the voice
//! System Settings picks. Menu actions run on the main thread, the only
//! thread the synthesizer is kept on.

use std::cell::RefCell;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send};
use objc2_foundation::NSString;

thread_local! {
    /// One synthesizer for the app, made on first use.
    static SYNTHESIZER: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
}

/// Speaks `text`, stopping whatever is being spoken first. Empty text says
/// nothing, as AppKit's role does with no text.
pub fn start_speaking(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    SYNTHESIZER.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            // SAFETY: an AppKit class and its designated `new`, on the main
            // thread.
            let made: Option<Retained<AnyObject>> =
                unsafe { msg_send![class!(NSSpeechSynthesizer), new] };
            *slot = made;
        }
        let synthesizer = slot
            .as_ref()
            .ok_or_else(|| "macOS has no speech synthesizer to speak with".to_string())?;
        let string = NSString::from_str(text);
        // SAFETY: a live synthesizer and its documented selectors, with an
        // NSString argument, on the main thread.
        let started: Bool = unsafe {
            let _: () = msg_send![&**synthesizer, stopSpeaking];
            msg_send![&**synthesizer, startSpeakingString: &*string]
        };
        if started.as_bool() {
            Ok(())
        } else {
            Err("macOS's speech synthesizer did not start".into())
        }
    })
}

/// Stops speaking, if anything is being spoken.
pub fn stop_speaking() {
    SYNTHESIZER.with(|slot| {
        if let Some(synthesizer) = slot.borrow().as_ref() {
            // SAFETY: a live synthesizer and a documented selector, on the
            // main thread.
            let _: () = unsafe { msg_send![&**synthesizer, stopSpeaking] };
        }
    });
}
