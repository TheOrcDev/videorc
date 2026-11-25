//! Plan 249 S14 / 260 S1.8c: map a scene's native screen or window to the
//! room share (`room-screen-source.ts`).
//!
//! Native sources are ScreenCaptureKit ids on macOS
//! (`screen:screencapturekit:<CGDirectDisplayID>`,
//! `window:screencapturekit:<CGWindowID>`); Electron's capturer names the
//! same display or window `screen:<id>:0` / `window:<id>:0`. The backend
//! room (`cloud.room.screen.set`) shares by native id. Other platforms'
//! native ids do not map one to one: the share is kept and the reason said.

/// What the room should share for a scene's sources.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoomScreenWant {
    /// The scene names no screen: keep whatever the room shares.
    Keep,
    Source {
        capturer_id: String,
        source_kind: RoomScreenKind,
        /// Plan 260 S1.8c: the native id, for the backend's room.
        native_id: Option<String>,
    },
    Unsupported {
        reason: String,
    },
}

/// Screen vs window share.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoomScreenKind {
    Screen,
    Window,
}

impl RoomScreenKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Screen => "screen",
            Self::Window => "window",
        }
    }
}

/// How the room's screen is captured, measured facts only (V13).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoomScreenCaptureFacts {
    pub engine: &'static str,
    /// Chromium's capturer draws the pointer; the native cursor setting is
    /// not applied.
    pub cursor: &'static str,
    /// Videorc's own windows are left out only where they use content
    /// protection.
    pub own_windows: &'static str,
    pub production_qualified: bool,
}

/// `ROOM_SCREEN_CAPTURE_FACTS`.
pub const ROOM_SCREEN_CAPTURE_FACTS: RoomScreenCaptureFacts = RoomScreenCaptureFacts {
    engine: "browser-capturer",
    cursor: "capturer-default",
    own_windows: "content-protection-only",
    production_qualified: false,
};

const UNSUPPORTED_REASON: &str =
    "This scene's screen can't be shared into the room here. Share it yourself.";

fn parse_u32_id(text: &str) -> Option<u32> {
    if !(1..=10).contains(&text.len()) || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let id: u64 = text.parse().ok()?;
    if id == 0 || id > u64::from(u32::MAX) {
        return None;
    }
    Some(id as u32)
}

fn split_kind_id<'a>(text: &'a str, mid: &str) -> Option<(&'a str, &'a str)> {
    let (kind, rest) = text.split_once(':')?;
    if kind != "screen" && kind != "window" {
        return None;
    }
    let id = rest.strip_prefix(mid)?;
    Some((kind, id))
}

/// `screen:screencapturekit:5` → `screen:5:0`; `None` when the id does not map.
pub fn capturer_id_for_native(native_id: Option<&str>) -> Option<String> {
    let (kind, id) = split_kind_id(native_id?, "screencapturekit:")?;
    let id = parse_u32_id(id)?;
    Some(format!("{kind}:{id}:0"))
}

/// `screen:5:0` → `screen:screencapturekit:5` (plan 260 S1.8c); `None` when
/// the id does not map.
pub fn native_id_for_capturer(capturer_id: Option<&str>) -> Option<String> {
    let capturer_id = capturer_id?;
    let (kind, rest) = capturer_id.split_once(':')?;
    if kind != "screen" && kind != "window" {
        return None;
    }
    let (id, suffix) = rest.split_once(':')?;
    if suffix != "0" {
        return None;
    }
    let id = parse_u32_id(id)?;
    Some(format!("{kind}:screencapturekit:{id}"))
}

/// Inputs for [`room_screen_want`] (Electron `SourceSelection` + captureOff).
#[derive(Debug, Clone, Copy, Default)]
pub struct RoomScreenSources<'a> {
    pub screen_id: Option<&'a str>,
    pub window_id: Option<&'a str>,
    /// Capture is off in the Studio (no screen on the scene).
    pub capture_off: bool,
}

/// What the room should share for a scene's sources. A window wins over a
/// display, as natively.
pub fn room_screen_want(sources: RoomScreenSources<'_>) -> RoomScreenWant {
    let native = sources.window_id.filter(|id| !id.is_empty()).or_else(|| {
        if sources.capture_off {
            None
        } else {
            sources.screen_id.filter(|id| !id.is_empty())
        }
    });
    let Some(native) = native else {
        return RoomScreenWant::Keep;
    };
    let Some(capturer_id) = capturer_id_for_native(Some(native)) else {
        return RoomScreenWant::Unsupported {
            reason: UNSUPPORTED_REASON.to_string(),
        };
    };
    let source_kind = if capturer_id.starts_with("window:") {
        RoomScreenKind::Window
    } else {
        RoomScreenKind::Screen
    };
    RoomScreenWant::Source {
        capturer_id,
        source_kind,
        native_id: Some(native.to_string()),
    }
}

/// Switch only when the room shares something else (or nothing). `current`
/// is the capturer id (`screen:5:0`), as Electron's talk-show room tracks.
pub fn room_screen_needs_switch(want: &RoomScreenWant, current: Option<&str>) -> bool {
    match want {
        RoomScreenWant::Source { capturer_id, .. } => current != Some(capturer_id.as_str()),
        _ => false,
    }
}

/// Backend room path: compare the scene's native id to
/// [`crate::studio::room_media::RoomScreen::source_id`].
pub fn room_screen_needs_switch_native(
    want: &RoomScreenWant,
    current_native: Option<&str>,
) -> bool {
    match want {
        RoomScreenWant::Source {
            native_id: Some(native_id),
            ..
        } => current_native != Some(native_id.as_str()),
        RoomScreenWant::Source {
            native_id: None, ..
        } => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_screencapturekit_ids_to_capturer_ids() {
        assert_eq!(
            capturer_id_for_native(Some("screen:screencapturekit:5")).as_deref(),
            Some("screen:5:0")
        );
        assert_eq!(
            capturer_id_for_native(Some("window:screencapturekit:4294967293")).as_deref(),
            Some("window:4294967293:0")
        );
        assert_eq!(capturer_id_for_native(Some("screen:avfoundation:1")), None);
        assert_eq!(
            capturer_id_for_native(Some("window:screencapturekit:0")),
            None
        );
        assert_eq!(
            capturer_id_for_native(Some("window:screencapturekit:99999999999")),
            None
        );
        assert_eq!(capturer_id_for_native(None), None);
    }

    #[test]
    fn maps_capturer_ids_back_to_screencapturekit() {
        assert_eq!(
            native_id_for_capturer(Some("screen:5:0")).as_deref(),
            Some("screen:screencapturekit:5")
        );
        assert_eq!(
            native_id_for_capturer(Some("window:4294967293:0")).as_deref(),
            Some("window:screencapturekit:4294967293")
        );
        assert_eq!(native_id_for_capturer(Some("screen:5:1")), None);
        assert_eq!(native_id_for_capturer(Some("window:0:0")), None);
        assert_eq!(
            native_id_for_capturer(Some("web-contents-media-stream:1")),
            None
        );
        assert_eq!(native_id_for_capturer(None), None);
        for native in ["screen:screencapturekit:7", "window:screencapturekit:42"] {
            assert_eq!(
                native_id_for_capturer(capturer_id_for_native(Some(native)).as_deref()).as_deref(),
                Some(native)
            );
        }
    }

    #[test]
    fn window_wins_over_display_and_none_keeps() {
        assert_eq!(
            room_screen_want(RoomScreenSources {
                screen_id: Some("screen:screencapturekit:1"),
                window_id: Some("window:screencapturekit:42"),
                capture_off: false,
            }),
            RoomScreenWant::Source {
                capturer_id: "window:42:0".into(),
                source_kind: RoomScreenKind::Window,
                native_id: Some("window:screencapturekit:42".into()),
            }
        );
        assert_eq!(
            room_screen_want(RoomScreenSources {
                screen_id: Some("screen:screencapturekit:1"),
                window_id: None,
                capture_off: false,
            }),
            RoomScreenWant::Source {
                capturer_id: "screen:1:0".into(),
                source_kind: RoomScreenKind::Screen,
                native_id: Some("screen:screencapturekit:1".into()),
            }
        );
        assert_eq!(
            room_screen_want(RoomScreenSources {
                screen_id: Some("screen:screencapturekit:1"),
                window_id: None,
                capture_off: true,
            }),
            RoomScreenWant::Keep
        );
        assert_eq!(
            room_screen_want(RoomScreenSources::default()),
            RoomScreenWant::Keep
        );
    }

    #[test]
    fn unsupported_source_is_said() {
        let want = room_screen_want(RoomScreenSources {
            screen_id: Some("screen:wgc:0"),
            ..Default::default()
        });
        assert!(matches!(want, RoomScreenWant::Unsupported { .. }));
    }

    #[test]
    fn switches_only_when_the_room_shares_something_else() {
        let want = room_screen_want(RoomScreenSources {
            window_id: Some("window:screencapturekit:42"),
            ..Default::default()
        });
        assert!(!room_screen_needs_switch(&want, Some("window:42:0")));
        assert!(room_screen_needs_switch(&want, Some("screen:1:0")));
        assert!(room_screen_needs_switch(&want, None));
        assert!(!room_screen_needs_switch(&RoomScreenWant::Keep, None));
        assert!(room_screen_needs_switch_native(
            &want,
            Some("window:screencapturekit:7")
        ));
        assert!(!room_screen_needs_switch_native(
            &want,
            Some("window:screencapturekit:42")
        ));
    }

    #[test]
    fn states_capture_facts() {
        assert_eq!(ROOM_SCREEN_CAPTURE_FACTS.cursor, "capturer-default");
        assert_eq!(
            ROOM_SCREEN_CAPTURE_FACTS.own_windows,
            "content-protection-only"
        );
        assert!(!ROOM_SCREEN_CAPTURE_FACTS.production_qualified);
    }
}
