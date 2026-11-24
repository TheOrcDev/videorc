//! Which of Videorc's windows stay out of screen capture (plan 260 S1.6s /
//! S2.6a "Hide from stream", from Electron's
//! `main/window-capture-protection.ts` and `shared/capture-protection.ts`).
//!
//! - Notes, the private teleprompter, never enters a captured display, on
//!   every platform.
//! - The Stream Manager, Captions and the rest are part of the show and stay
//!   visible by default (owner call, 2026-08-19).
//! - Plan 215 D6 adds one choice: the Stream Manager's Hide from stream
//!   switch. On macOS Videorc's own ScreenCaptureKit filter leaves the window
//!   out of every capture it starts, so content protection is never applied
//!   there (it would hide the window from the streamer's own tools too). On
//!   Windows content protection (`WDA_EXCLUDEFROMCAPTURE`) is the only route.
//!   Linux has neither, and says so.
//!
//! [`CaptureProtection`] applies the window's protection once per window
//! instance and releases only what it applied, so a Stream Manager toggle can
//! never expose Notes. The call itself (`NSWindow.sharingType`,
//! `SetWindowDisplayAffinity`) is the app's ([`ContentProtectionWindow`]).

use std::collections::BTreeSet;

/// `CAPTURE_PROTECTION_UNSUPPORTED_REASON`: the one user-facing reason.
pub const UNSUPPORTED_REASON: &str = "This system cannot hide a window from screen capture.";

/// The reason a failed call reports when the platform gave none.
pub const REJECTED_REASON: &str = "Electron rejected content protection.";

/// Failure reasons are kept to this many characters.
const REASON_MAX_CHARS: usize = 512;

/// `VideorcWindowRole`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum WindowRole {
    Main,
    Preview,
    /// The Stream Manager.
    Comments,
    Notes,
    Captions,
    ProofSurface,
}

impl WindowRole {
    pub const ALL: [WindowRole; 6] = [
        WindowRole::Main,
        WindowRole::Preview,
        WindowRole::Comments,
        WindowRole::Notes,
        WindowRole::Captions,
        WindowRole::ProofSurface,
    ];

    /// `WINDOW_CAPTURE_PROTECTION_SMOKE_MARKERS`: one unusual colour per role,
    /// used only by the installed-app acceptance harness, so one protected
    /// window can never stand in as evidence for another.
    pub fn smoke_marker(self) -> &'static str {
        match self {
            WindowRole::Main => "#8b1e3f",
            WindowRole::Preview => "#2e8b57",
            WindowRole::Comments => "#5f4b8b",
            WindowRole::Notes => "#c41e3a",
            WindowRole::Captions => "#d2691e",
            WindowRole::ProofSurface => "#1e90a8",
        }
    }
}

/// `StreamManagerHideMethod`: how the Stream Manager leaves the stream when
/// Hide from stream is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HideMethod {
    /// macOS: Videorc's own capture filter, applied live.
    CaptureFilter,
    /// Windows: content protection, which hides it from every capture app.
    ContentProtection,
    Unsupported,
}

impl HideMethod {
    /// The wire's word (`hideFromStreamMethod`).
    pub fn id(self) -> &'static str {
        match self {
            HideMethod::CaptureFilter => "capture-filter",
            HideMethod::ContentProtection => "content-protection",
            HideMethod::Unsupported => "unsupported",
        }
    }
}

/// `streamManagerHideMethod` (`platform` as Node names it: `darwin`,
/// `win32`, `linux`).
pub fn stream_manager_hide_method(platform: &str) -> HideMethod {
    match platform {
        "darwin" => HideMethod::CaptureFilter,
        "win32" => HideMethod::ContentProtection,
        _ => HideMethod::Unsupported,
    }
}

/// `videorcWindowRequiresCaptureProtection`: Notes always; the Stream
/// Manager while Hide from stream is on, where content protection is how
/// it hides; nothing else.
pub fn window_requires_capture_protection(
    role: WindowRole,
    platform: &str,
    hidden_from_stream: bool,
) -> bool {
    match role {
        WindowRole::Notes => true,
        WindowRole::Comments => {
            hidden_from_stream
                && stream_manager_hide_method(platform) == HideMethod::ContentProtection
        }
        _ => false,
    }
}

/// Plan 260 S2.6a: whether Videorc's own ScreenCaptureKit filter leaves the
/// open window out (its id in `protectedOverlayWindowIds`), as the Studio
/// renderer lists them (`protected-overlay-windows.ts`, `use-studio.tsx`):
/// Notes always, the Stream Manager while Hide from stream is on
/// (`streamManagerProtectedOverlayWindow`). The filter is macOS's only; a
/// window id means nothing to another platform's capture.
pub fn window_in_capture_filter(
    role: WindowRole,
    platform: &str,
    hidden_from_stream: bool,
) -> bool {
    if stream_manager_hide_method(platform) != HideMethod::CaptureFilter {
        return false;
    }
    match role {
        WindowRole::Notes => true,
        WindowRole::Comments => hidden_from_stream,
        _ => false,
    }
}

/// `platformSupportsCaptureProtection`: macOS and Windows only. A window
/// that says "Hidden from recordings and streams" must be hidden, so a
/// platform without it reports the window as visible (plan 174 I-2).
pub fn platform_supports_capture_protection(platform: &str) -> bool {
    matches!(platform, "darwin" | "win32")
}

/// `WindowCaptureProtectionResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtectionResult {
    Protected,
    AlreadyProtected,
    NotRequired,
    Failed(String),
    Unsupported(String),
}

impl ProtectionResult {
    /// The window is out of capture now.
    pub fn protected(&self) -> bool {
        matches!(
            self,
            ProtectionResult::Protected | ProtectionResult::AlreadyProtected
        )
    }
}

/// One window, as the protection sees it: the app's handle.
pub trait ContentProtectionWindow {
    /// The window instance. A re-created window is a new instance.
    fn instance_id(&self) -> u64;
    /// Excludes the window from screen capture, or lets it back in.
    fn set_content_protection(&mut self, on: bool) -> Result<(), String>;
}

/// `applyVideorcWindowCaptureProtection` and its release: the windows this
/// process protected, by instance.
#[derive(Debug, Clone, Default)]
pub struct CaptureProtection {
    protected: BTreeSet<u64>,
}

impl CaptureProtection {
    /// Whether this instance is protected now.
    pub fn is_protected(&self, instance_id: u64) -> bool {
        self.protected.contains(&instance_id)
    }

    /// Protects the window if its role needs it, once per instance. A
    /// failure is not remembered (the next call tries again) and its reason
    /// is kept short; a platform without protection says so instead of
    /// claiming it.
    pub fn apply(
        &mut self,
        window: &mut impl ContentProtectionWindow,
        role: WindowRole,
        platform: &str,
        hidden_from_stream: bool,
    ) -> ProtectionResult {
        if !window_requires_capture_protection(role, platform, hidden_from_stream) {
            return ProtectionResult::NotRequired;
        }
        let id = window.instance_id();
        if self.protected.contains(&id) {
            return ProtectionResult::AlreadyProtected;
        }
        if !platform_supports_capture_protection(platform) {
            return ProtectionResult::Unsupported(UNSUPPORTED_REASON.to_string());
        }
        match window.set_content_protection(true) {
            Ok(()) => {
                self.protected.insert(id);
                ProtectionResult::Protected
            }
            Err(error) => {
                let trimmed = error.trim();
                let reason = if trimmed.is_empty() {
                    REJECTED_REASON.to_string()
                } else {
                    trimmed.chars().take(REASON_MAX_CHARS).collect()
                };
                ProtectionResult::Failed(reason)
            }
        }
    }

    /// `releaseVideorcWindowCaptureProtection`: takes the protection off
    /// again (Hide from stream turned off on Windows). A window this never
    /// protected is left alone, so Notes can never be exposed by a Stream
    /// Manager toggle. Answers whether the window is still protected.
    pub fn release(&mut self, window: &mut impl ContentProtectionWindow) -> bool {
        let id = window.instance_id();
        if !self.protected.contains(&id) {
            return false;
        }
        match window.set_content_protection(false) {
            Ok(()) => {
                self.protected.remove(&id);
                false
            }
            Err(_) => true,
        }
    }

    /// The window closed: forget its instance.
    pub fn forget(&mut self, instance_id: u64) {
        self.protected.remove(&instance_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A window that records its calls and fails on demand.
    struct FakeWindow {
        id: u64,
        calls: Vec<bool>,
        fail: Option<String>,
    }

    impl FakeWindow {
        fn new(id: u64) -> Self {
            Self {
                id,
                calls: Vec::new(),
                fail: None,
            }
        }
    }

    impl ContentProtectionWindow for FakeWindow {
        fn instance_id(&self) -> u64 {
            self.id
        }

        fn set_content_protection(&mut self, on: bool) -> Result<(), String> {
            self.calls.push(on);
            match &self.fail {
                Some(reason) => Err(reason.clone()),
                None => Ok(()),
            }
        }
    }

    const PLATFORMS: [&str; 3] = ["darwin", "win32", "linux"];

    #[test]
    fn only_the_notes_teleprompter_by_default_on_every_platform() {
        for platform in PLATFORMS {
            for role in WindowRole::ALL {
                assert_eq!(
                    window_requires_capture_protection(role, platform, false),
                    role == WindowRole::Notes,
                    "{role:?} on {platform}"
                );
            }
        }
    }

    #[test]
    fn the_stream_manager_with_hide_from_stream_on_windows_only() {
        assert_eq!(
            stream_manager_hide_method("darwin"),
            HideMethod::CaptureFilter
        );
        assert_eq!(
            stream_manager_hide_method("win32"),
            HideMethod::ContentProtection
        );
        assert_eq!(stream_manager_hide_method("linux"), HideMethod::Unsupported);
        assert_eq!(
            stream_manager_hide_method("freebsd"),
            HideMethod::Unsupported
        );
        assert!(window_requires_capture_protection(
            WindowRole::Comments,
            "win32",
            true
        ));
        assert!(!window_requires_capture_protection(
            WindowRole::Comments,
            "darwin",
            true
        ));
        assert!(!window_requires_capture_protection(
            WindowRole::Comments,
            "linux",
            true
        ));
        let mut protection = CaptureProtection::default();
        let mut window = FakeWindow::new(1);
        assert_eq!(
            protection.apply(&mut window, WindowRole::Comments, "win32", true),
            ProtectionResult::Protected
        );
        assert_eq!(window.calls, [true]);
    }

    #[test]
    fn releases_only_what_it_protected() {
        let mut protection = CaptureProtection::default();
        let mut stranger = FakeWindow::new(7);
        assert!(!protection.release(&mut stranger));
        assert!(stranger.calls.is_empty());

        let mut manager = FakeWindow::new(1);
        protection.apply(&mut manager, WindowRole::Comments, "win32", true);
        assert!(!protection.release(&mut manager));
        assert_eq!(manager.calls, [true, false]);
        assert!(!protection.is_protected(1));
        protection.apply(&mut manager, WindowRole::Comments, "win32", true);
        assert_eq!(manager.calls, [true, false, true]);

        let mut stuck = FakeWindow::new(2);
        protection.apply(&mut stuck, WindowRole::Notes, "win32", false);
        stuck.fail = Some("busy".into());
        assert!(protection.release(&mut stuck));
        assert!(protection.is_protected(2));
    }

    #[test]
    fn once_per_instance_and_a_recreated_window_again() {
        let mut protection = CaptureProtection::default();
        let mut window = FakeWindow::new(1);
        assert_eq!(
            protection.apply(&mut window, WindowRole::Notes, "win32", false),
            ProtectionResult::Protected
        );
        assert_eq!(
            protection.apply(&mut window, WindowRole::Notes, "win32", false),
            ProtectionResult::AlreadyProtected
        );
        assert_eq!(window.calls, [true]);
        let mut recreated = FakeWindow::new(2);
        protection.apply(&mut recreated, WindowRole::Notes, "win32", false);
        assert_eq!(recreated.calls, [true]);
        protection.forget(1);
        assert!(!protection.is_protected(1));
    }

    #[test]
    fn a_failure_is_not_remembered_and_its_reason_is_bounded() {
        let mut protection = CaptureProtection::default();
        let mut window = FakeWindow::new(1);
        window.fail = Some(format!("  {}  ", "x".repeat(600)));
        let ProtectionResult::Failed(reason) =
            protection.apply(&mut window, WindowRole::Notes, "darwin", false)
        else {
            panic!("a failure");
        };
        assert_eq!(reason, "x".repeat(512));
        window.fail = Some("   ".into());
        assert_eq!(
            protection.apply(&mut window, WindowRole::Notes, "darwin", false),
            ProtectionResult::Failed(REJECTED_REASON.into())
        );
        assert_eq!(window.calls.len(), 2);
    }

    #[test]
    fn a_platform_without_protection_says_so() {
        assert!(platform_supports_capture_protection("darwin"));
        assert!(platform_supports_capture_protection("win32"));
        assert!(!platform_supports_capture_protection("linux"));
        let mut protection = CaptureProtection::default();
        let mut window = FakeWindow::new(1);
        assert_eq!(
            protection.apply(&mut window, WindowRole::Notes, "linux", false),
            ProtectionResult::Unsupported(UNSUPPORTED_REASON.into())
        );
        assert!(window.calls.is_empty());
        assert_eq!(
            protection.apply(&mut window, WindowRole::Captions, "linux", false),
            ProtectionResult::NotRequired
        );
        assert!(!ProtectionResult::NotRequired.protected());
        assert!(ProtectionResult::AlreadyProtected.protected());
    }

    #[test]
    fn every_role_has_its_own_marker() {
        let markers: BTreeSet<&str> = WindowRole::ALL.iter().map(|r| r.smoke_marker()).collect();
        assert_eq!(markers.len(), WindowRole::ALL.len());
        assert!(markers.iter().all(|m| {
            m.len() == 7
                && m.starts_with('#')
                && m[1..]
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        }));
    }

    /// The rules and words are still Electron's.
    #[test]
    fn the_rules_and_words_are_electrons() {
        let main = include_str!("../../../../apps/desktop/src/main/window-capture-protection.ts");
        let shared = include_str!("../../../../apps/desktop/src/shared/capture-protection.ts");
        assert!(shared.contains(&format!("'{UNSUPPORTED_REASON}'")));
        assert!(main.contains(&format!("'{REJECTED_REASON}'")));
        assert!(main.contains(".slice(0, 512)"));
        for role in WindowRole::ALL {
            assert!(main.contains(role.smoke_marker()), "{role:?}");
        }
        for method in [
            HideMethod::CaptureFilter,
            HideMethod::ContentProtection,
            HideMethod::Unsupported,
        ] {
            assert!(
                main.contains(&format!("return '{}'", method.id())),
                "{method:?}"
            );
        }
    }

    #[test]
    fn the_capture_filter_lists_notes_and_a_hidden_stream_manager_on_macos_only() {
        for role in WindowRole::ALL {
            let always = role == WindowRole::Notes;
            assert_eq!(
                window_in_capture_filter(role, "darwin", false),
                always,
                "{role:?}"
            );
            let hidden = always || role == WindowRole::Comments;
            assert_eq!(
                window_in_capture_filter(role, "darwin", true),
                hidden,
                "{role:?}"
            );
            for other in ["win32", "linux"] {
                assert!(
                    !window_in_capture_filter(role, other, true),
                    "{role:?} {other}"
                );
            }
        }
        // The two routes never overlap for the Stream Manager: the filter on
        // macOS, content protection on Windows.
        assert!(!window_requires_capture_protection(
            WindowRole::Comments,
            "darwin",
            true
        ));
        assert!(window_requires_capture_protection(
            WindowRole::Comments,
            "win32",
            true
        ));
    }
}
