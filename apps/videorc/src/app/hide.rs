//! Hide from stream (plan 260 S2.6a part 6): the core's rules
//! (`desktop::capture_protection`, Electron's
//! `window-capture-protection.ts` and `protected-overlay-windows.ts`) on
//! the app's windows. Two routes keep a window out of a capture:
//!
//! - **Content protection** (`NSWindow.sharingType = .none`,
//!   `WDA_EXCLUDEFROMCAPTURE`) hides it from every capture app and
//!   screenshot: Notes always, and the Stream Manager with its switch on
//!   where that is how it hides (Windows). Applied once per window instance
//!   and released only where this app applied it, so a Stream Manager
//!   toggle can never expose Notes.
//! - **Videorc's ScreenCaptureKit filter** (macOS) leaves the window out of
//!   Videorc's own captures only, so the streamer's screenshots still see
//!   it: Notes, and the Stream Manager with its switch on. The open
//!   windows' numbers are published on a watch; the Studio sends them as
//!   `protectedOverlayWindowIds` with `preview.screen.start` when it lands.
//!
//! The main window and Captions are part of the show. The windows that
//! call [`HideFromStream::apply`] (Notes, the Stream Manager, the Preview)
//! land with Phase 3; a closed window leaves both routes on its own.

use std::collections::BTreeMap;

use gpui::{App, Global, Window};
use tokio::sync::watch;
use videorc_app_core::desktop::capture_protection::{
    CaptureProtection, ContentProtectionWindow, ProtectionResult, WindowRole,
    window_in_capture_filter,
};
use videorc_app_core::desktop::permissions::PermissionPlatform;

use crate::platform;

/// A GPUI window, as the core's protection sees it.
struct NativeWindow<'a> {
    window: &'a Window,
}

impl ContentProtectionWindow for NativeWindow<'_> {
    fn instance_id(&self) -> u64 {
        self.window.window_handle().window_id().as_u64()
    }

    fn set_content_protection(&mut self, on: bool) -> Result<(), String> {
        platform::current()
            .set_hidden_from_capture(self.window, on)
            .map(|_| ())
    }
}

/// The windows this process protected, and the capture filter's list.
pub struct HideFromStream {
    protection: CaptureProtection,
    /// Window instance → its capture window number, while open.
    filtered: BTreeMap<u64, u32>,
    filter_ids: watch::Sender<Vec<u32>>,
}

impl Global for HideFromStream {}

impl HideFromStream {
    /// Sets the app's Hide from stream up and answers the capture filter's
    /// list (empty until a window asks).
    pub fn install(cx: &mut App) -> watch::Receiver<Vec<u32>> {
        let (filter_ids, ids) = watch::channel(Vec::new());
        cx.set_global(Self {
            protection: CaptureProtection::default(),
            filtered: BTreeMap::new(),
            filter_ids,
        });
        cx.on_window_closed(|cx, window_id| {
            let this = cx.global_mut::<Self>();
            let id = window_id.as_u64();
            this.protection.forget(id);
            if this.filtered.remove(&id).is_some() {
                this.publish();
            }
        })
        .detach();
        ids
    }

    /// Applies `role`'s rule to `window`: when it opens, and on every Hide
    /// from stream switch. Content protection goes on or comes off; the
    /// window joins or leaves the capture filter. The answer is the
    /// protection's, which says when the platform can't hide the window.
    #[allow(dead_code)]
    pub fn apply(
        window: &Window,
        role: WindowRole,
        hidden_from_stream: bool,
        cx: &mut App,
    ) -> ProtectionResult {
        let platform_name = PermissionPlatform::current().as_str();
        let this = cx.global_mut::<Self>();
        let mut native = NativeWindow { window };
        let result = this
            .protection
            .apply(&mut native, role, platform_name, hidden_from_stream);
        if result == ProtectionResult::NotRequired {
            // A switch turned off (Windows' Stream Manager); a window this
            // never protected is left alone.
            this.protection.release(&mut native);
        }
        let id = native.instance_id();
        let changed = if window_in_capture_filter(role, platform_name, hidden_from_stream) {
            match platform::current().capture_window_id(window) {
                Some(number) => this.filtered.insert(id, number) != Some(number),
                None => false,
            }
        } else {
            this.filtered.remove(&id).is_some()
        };
        if changed {
            this.publish();
        }
        result
    }

    /// The filter's list, sorted, to whoever starts the screen capture.
    fn publish(&self) {
        let mut ids: Vec<u32> = self.filtered.values().copied().collect();
        ids.sort_unstable();
        ids.dedup();
        self.filter_ids.send_replace(ids);
    }
}
