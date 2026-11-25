//! What a preview slot says while no frame presents (plan 220 S3.0h):
//! `components/preview-stage.tsx`'s honest states, a title and a detail,
//! byte for byte.
//!
//! The element's status carries the truthful reason (the first-frame
//! contract's blocked link, a connection's error), which goes to the log
//! and to `preview-window-state` (`firstFrameReason`, the lifecycle's
//! `fallbackReason` and `lastError`). A slot never shows it: it shows the
//! state those reasons add up to, in the renderer's words.
//!
//! - The Studio slot hosting the layer: the docked frame
//!   (`DockedPreviewFrame`): why the layer is hidden (`dockHiddenDisplay`),
//!   else the element's state.
//! - The Studio slot while the Preview window hosts the layer: the card
//!   Electron shows for an open Preview window (`previewSupervisorDisplay`).
//! - The Preview window: the element's state, or the permission it waits
//!   for.
//!
//! Electron's renderer reads its supervisor's lifecycle, which never hears
//! of the first-frame contract (main writes the contract's reason into the
//! Preview window's own document). The Rust slots read the element's phase,
//! which does: waiting, starting and healing are "Opening preview…" (the
//! supervisor's `starting-surface`; the open window's card says "Waiting
//! for the first frame…" while the first-frame contract runs, its
//! `open-no-surface`), a declared fallback or stall is "Preview failed" (its
//! `failed`), and a frame on screen says nothing.

use crate::element::Phase;
use crate::lifecycle::{DockHiddenReason, PermissionStatus};

/// A slot's words: `status.title` and `status.detail` (empty: no detail).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreviewWords {
    pub title: &'static str,
    pub detail: &'static str,
}

const fn words(title: &'static str, detail: &'static str) -> PreviewWords {
    PreviewWords { title, detail }
}

/// `opening-window` and `starting-surface`.
pub const OPENING: PreviewWords = words("Opening preview…", "");
/// `surface-live`: the Studio's card while the Preview window shows the
/// video (`PREVIEW_FLOATING_TITLE` and `_DETAIL` since issue #1273).
pub const OPEN_IN_ITS_OWN_WINDOW: PreviewWords = words(
    "Preview is open in its own window",
    "Show it here to watch it in the Studio.",
);
/// `open-no-surface`: the Preview window is open and its first frame is
/// on the way.
pub const WAITING_FOR_FIRST_FRAME: PreviewWords = words(
    "Preview is open in its own window",
    "Waiting for the first frame…",
);
/// `failed` with no message of its own.
pub const FAILED: PreviewWords = words("Preview failed", "The preview couldn’t start.");
/// S3.1b: the Studio's card while the Preview window is closed
/// (`PREVIEW_CLOSED_COPY` since issue #1273: it names both places the
/// Preview can open).
pub const LIVES_IN_ITS_OWN_WINDOW: PreviewWords = words(
    "Preview is closed",
    "Show it here or in its own window to watch your scene as viewers see it.",
);
/// A stall the presenting watch declared after its ladder ran out: the
/// preview had started, so the title stands alone (`failed`'s detail says
/// it couldn't start).
pub const STALLED: PreviewWords = words("Preview failed", "");
/// `permission-required`'s title.
pub const NEEDS_PERMISSION: &str = "Preview needs permission";

/// The element's state in the slot that hosts the layer, or nothing while a
/// frame presents.
pub fn phase(phase: Phase) -> Option<PreviewWords> {
    match phase {
        Phase::Presenting => None,
        Phase::Disconnected | Phase::Starting | Phase::Healing => Some(OPENING),
        Phase::Fallback => Some(FAILED),
        Phase::Stalled => Some(STALLED),
    }
}

/// The Studio slot while the Preview window hosts the layer: the open
/// window's card, by the element's state.
pub fn away(phase: Phase) -> PreviewWords {
    match phase {
        Phase::Presenting => OPEN_IN_ITS_OWN_WINDOW,
        Phase::Starting => WAITING_FOR_FIRST_FRAME,
        Phase::Disconnected | Phase::Healing => OPENING,
        Phase::Fallback => FAILED,
        Phase::Stalled => STALLED,
    }
}

/// `dockHiddenDisplay`: why the docked layer is hidden. `slot-unmounted`
/// and `main-window-hidden` have no words: the slot itself is not on screen
/// then (another page shows, or the window is hidden).
pub fn dock_hidden(reason: DockHiddenReason) -> Option<PreviewWords> {
    match reason {
        DockHiddenReason::NoSlotReport => Some(words("Placing preview…", "")),
        DockHiddenReason::OverlayOpen => Some(words(
            "Preview hidden under this window",
            "It returns as soon as it closes. Recording and streaming keep going.",
        )),
        DockHiddenReason::ScrolledAway => Some(words(
            "Preview hidden while scrolled away",
            "Scroll the panel fully into view to see it again.",
        )),
        DockHiddenReason::MainWindowFullscreen => Some(words(
            "Preview hidden in fullscreen",
            "Pop the preview out to watch it in fullscreen.",
        )),
        DockHiddenReason::SlotUnmounted | DockHiddenReason::MainWindowHidden => None,
    }
}

/// `permission-required` (P141): the title, and what the source waits for.
pub fn needs_permission(status: PermissionStatus) -> PreviewWords {
    words(NEEDS_PERMISSION, permission_message(status))
}

/// The grant the preview's sources wait for: the screen's or window's
/// first, then the camera's, or none. Electron's supervisor hears it from
/// the surface; the GPUI host reads it off the device list.
pub fn permission_wait(screen_waits: bool, camera_waits: bool) -> Option<PermissionStatus> {
    if screen_waits {
        Some(PermissionStatus::ScreenRecordingRequired)
    } else if camera_waits {
        Some(PermissionStatus::CameraRequired)
    } else {
        None
    }
}

/// `previewPermissionMessage`: what the source waits for.
pub fn permission_message(status: PermissionStatus) -> &'static str {
    match status {
        PermissionStatus::ScreenRecordingRequired => {
            "Screen Recording permission is required for screen and window sources."
        }
        PermissionStatus::CameraRequired => "Camera permission is required for camera sources.",
        PermissionStatus::Unknown | PermissionStatus::Ok => {
            "Permission is required before this source can preview."
        }
    }
}

/// `permission-required`: "Preview needs permission" with what it waits
/// for. Electron puts the reported message first (`supervisor.lastError`);
/// the Rust slot says the renderer's own sentence for the status, so a
/// reported message stays in the status.
pub fn permission(status: PermissionStatus) -> PreviewWords {
    words(NEEDS_PERMISSION, permission_message(status))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_screen_grant_is_named_before_a_camera_grant() {
        assert_eq!(
            permission_wait(true, true),
            Some(PermissionStatus::ScreenRecordingRequired)
        );
        assert_eq!(
            permission_wait(false, true),
            Some(PermissionStatus::CameraRequired)
        );
        assert_eq!(permission_wait(false, false), None);
        let camera = needs_permission(PermissionStatus::CameraRequired);
        assert_eq!(camera.title, "Preview needs permission");
        assert_eq!(
            camera.detail,
            "Camera permission is required for camera sources."
        );
    }

    const PREVIEW_STAGE: &str =
        include_str!("../../../apps/desktop/src/renderer/src/components/preview-stage.tsx");

    const PHASES: [Phase; 6] = [
        Phase::Disconnected,
        Phase::Starting,
        Phase::Presenting,
        Phase::Healing,
        Phase::Stalled,
        Phase::Fallback,
    ];
    const REASONS: [DockHiddenReason; 6] = [
        DockHiddenReason::MainWindowFullscreen,
        DockHiddenReason::MainWindowHidden,
        DockHiddenReason::OverlayOpen,
        DockHiddenReason::NoSlotReport,
        DockHiddenReason::SlotUnmounted,
        DockHiddenReason::ScrolledAway,
    ];
    const STATUSES: [PermissionStatus; 4] = [
        PermissionStatus::Ok,
        PermissionStatus::ScreenRecordingRequired,
        PermissionStatus::CameraRequired,
        PermissionStatus::Unknown,
    ];

    fn every_word() -> Vec<PreviewWords> {
        let mut all: Vec<PreviewWords> = PHASES.iter().filter_map(|p| phase(*p)).collect();
        all.extend(PHASES.iter().map(|p| away(*p)));
        all.extend(REASONS.iter().filter_map(|r| dock_hidden(*r)));
        all.extend(STATUSES.iter().map(|s| permission(*s)));
        all.push(LIVES_IN_ITS_OWN_WINDOW);
        all
    }

    /// Every word is the renderer's, byte for byte (a straight apostrophe
    /// for its curly one fails here).
    #[test]
    fn every_title_and_detail_is_in_preview_stage() {
        for words in every_word() {
            for text in [words.title, words.detail] {
                if text.is_empty() {
                    continue;
                }
                assert!(
                    PREVIEW_STAGE.contains(&format!("'{text}'"))
                        || PREVIEW_STAGE.contains(&format!(">{text}<"))
                        || PREVIEW_STAGE.contains(&format!("title: '{text}'")),
                    "{text:?} is not preview-stage.tsx's"
                );
            }
        }
    }

    /// A slot never shows a contract's reason or an engine's word.
    #[test]
    fn no_word_names_an_internal() {
        for words in every_word() {
            for text in [words.title, words.detail] {
                let lower = text.to_lowercase();
                for internal in [
                    "backend",
                    "compositor",
                    "socket",
                    "revision",
                    "native",
                    "metal",
                ] {
                    assert!(!lower.contains(internal), "{text:?} says {internal}");
                }
            }
        }
    }

    #[test]
    fn a_presenting_slot_says_nothing_and_the_away_card_says_where_it_is() {
        assert_eq!(phase(Phase::Presenting), None);
        assert_eq!(away(Phase::Presenting), OPEN_IN_ITS_OWN_WINDOW);
        for waiting in [Phase::Disconnected, Phase::Starting, Phase::Healing] {
            assert_eq!(phase(waiting), Some(OPENING));
        }
        assert_eq!(away(Phase::Disconnected), OPENING);
        assert_eq!(away(Phase::Healing), OPENING);
        assert_eq!(away(Phase::Starting), WAITING_FOR_FIRST_FRAME);
        assert_eq!(phase(Phase::Fallback), Some(FAILED));
        assert_eq!(phase(Phase::Stalled), Some(STALLED));
        assert_eq!(away(Phase::Stalled).detail, "");
    }

    #[test]
    fn the_dock_reasons_on_screen_say_why_and_the_others_say_nothing() {
        assert_eq!(
            dock_hidden(DockHiddenReason::OverlayOpen).map(|w| w.title),
            Some("Preview hidden under this window")
        );
        assert_eq!(dock_hidden(DockHiddenReason::SlotUnmounted), None);
        assert_eq!(dock_hidden(DockHiddenReason::MainWindowHidden), None);
    }

    #[test]
    fn a_permission_names_the_source_it_waits_for() {
        assert_eq!(
            permission(PermissionStatus::CameraRequired),
            PreviewWords {
                title: "Preview needs permission",
                detail: "Camera permission is required for camera sources.",
            }
        );
        assert_eq!(
            permission(PermissionStatus::Unknown).detail,
            "Permission is required before this source can preview."
        );
    }
}
