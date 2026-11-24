//! Space on the Studio page (P111, P112; `studio-space-shortcut.ts`,
//! `studio-tab.tsx` 137–152). The keymap binds an unmodified Space to
//! [`ToggleRecord`] in the page's context, so Shift-, Ctrl-, Alt- or
//! Cmd-Space never reach it. The page then yields unless it holds the focus
//! itself: a focused button, field, switch, slider, tab, menu, list or
//! dialog keeps its own Space, as Electron's widget and modal selectors do.

use gpui::actions;
use videorc_app_core::studio::transport::{RecordButtonState, TransportView};

actions!(studio, [ToggleRecord]);

/// The page's key context, where Space binds.
pub const KEY_CONTEXT: &str = "StudioPage";
pub const SPACE: &str = "space";

/// One Space press as the page sees it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SpacePress {
    /// The key is held (`event.repeat`).
    pub held: bool,
    /// The page itself has the focus, no control inside it.
    pub page_focused: bool,
    /// A preview stage gesture is in flight (dragging or pending).
    pub stage_gesture: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpaceAction {
    /// Not the page's: the key goes on to whoever wants it.
    Pass,
    /// The page's, but nothing happens (a running session that can't stop
    /// yet, or a Record that can't start).
    Swallow,
    /// Stop the session (while live, the core asks End livestream first).
    Stop,
    /// Start a recording. Space never starts Go Live.
    Record,
}

pub fn space_action(press: SpacePress, transport: &TransportView) -> SpaceAction {
    if press.held || !press.page_focused || press.stage_gesture {
        return SpaceAction::Pass;
    }
    if transport.active {
        let can_stop =
            transport.record_enabled && transport.record_state != RecordButtonState::Stopping;
        return if can_stop {
            SpaceAction::Stop
        } else {
            SpaceAction::Swallow
        };
    }
    if transport.record_enabled {
        SpaceAction::Record
    } else {
        SpaceAction::Swallow
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use videorc_app_core::studio::transport::GoLiveButtonState;

    fn transport(active: bool, state: RecordButtonState, enabled: bool) -> TransportView {
        TransportView {
            active,
            record_state: state,
            record_label: "Record",
            stop_label: "Stop recording",
            stop_note: None,
            record_enabled: enabled,
            record_blocked: None,
            go_live_shown: !active,
            go_live_state: GoLiveButtonState::Idle,
            go_live_label: "Go Live",
            go_live_enabled: !active,
            go_live_blocked: None,
            blocked_reason: None,
            blocked_jump: None,
            stop_overrun: false,
        }
    }

    const ON_PAGE: SpacePress = SpacePress {
        held: false,
        page_focused: true,
        stage_gesture: false,
    };

    #[test]
    fn space_records_at_idle_and_stops_a_running_session() {
        let idle = transport(false, RecordButtonState::Idle, true);
        assert_eq!(space_action(ON_PAGE, &idle), SpaceAction::Record);
        let running = transport(true, RecordButtonState::Running, true);
        assert_eq!(space_action(ON_PAGE, &running), SpaceAction::Stop);
    }

    #[test]
    fn space_is_swallowed_when_nothing_can_happen() {
        let blocked = transport(false, RecordButtonState::Idle, false);
        assert_eq!(space_action(ON_PAGE, &blocked), SpaceAction::Swallow);
        let stopping = transport(true, RecordButtonState::Stopping, true);
        assert_eq!(space_action(ON_PAGE, &stopping), SpaceAction::Swallow);
        let offline = transport(true, RecordButtonState::Running, false);
        assert_eq!(space_action(ON_PAGE, &offline), SpaceAction::Swallow);
    }

    #[test]
    fn space_yields_when_held_to_a_focused_control_or_a_stage_gesture() {
        let idle = transport(false, RecordButtonState::Idle, true);
        for press in [
            SpacePress {
                held: true,
                ..ON_PAGE
            },
            SpacePress {
                page_focused: false,
                ..ON_PAGE
            },
            SpacePress {
                stage_gesture: true,
                ..ON_PAGE
            },
        ] {
            assert_eq!(space_action(press, &idle), SpaceAction::Pass, "{press:?}");
        }
    }
}
