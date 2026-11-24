//! Plan 260 S1.6b part 5c: what a takeover does to the host's voice
//! (`lib/takeover-microphone.ts`, live show 2026-11-20 #1601): the takeover
//! muted the owner and nothing in the Studio said so. The microphone rows
//! (the Studio's Audio section, the Sources page) say "Muted for takeover"
//! with when it ends.
//!
//! The hold reads the takeover's mute ownership as the store keeps it
//! (`videorc.screenTakeoverMuteOwnership.v1`, written by
//! `commitActiveScreen` in the same step as the screen and the mute). The
//! takeover on air is the caller's input: app-core holds no takeovers yet.
//! Rooms don't exist in app-core, so the `stream` hold (a room is open) is
//! only reachable through `room_open`, which the Studio never sets today.

use serde_json::Value;

use super::settings::UiSettingsCache;
use super::settings::keys::SCREEN_TAKEOVER_MUTE_OWNERSHIP;
use super::sources_page::{ChipTone, SourceStatus};

/// `ScreenTakeoverMuteOwnership`: whether the microphone was muted before
/// the takeover muted it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TakeoverMuteOwnership {
    pub prior_microphone_muted: bool,
}

/// `loadScreenTakeoverMuteOwnership`: the stored record, `None` when absent
/// or unreadable.
pub fn load_mute_ownership(stored: Option<&str>) -> Option<TakeoverMuteOwnership> {
    let parsed: Value = serde_json::from_str(stored?).ok()?;
    let prior = parsed.get("priorMicrophoneMuted")?.as_bool()?;
    Some(TakeoverMuteOwnership {
        prior_microphone_muted: prior,
    })
}

/// The record as the Studio's settings cache holds it.
pub fn stored_mute_ownership(settings: &UiSettingsCache) -> Option<TakeoverMuteOwnership> {
    load_mute_ownership(settings.get_item(SCREEN_TAKEOVER_MUTE_OWNERSHIP).as_deref())
}

/// `TakeoverMicrophoneHold`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TakeoverMicrophoneHold {
    /// A room is open, so the program page silences speech (D3); the
    /// microphone setting is untouched and guests still hear the host.
    Stream,
    /// No room, and the takeover itself muted a live microphone, so it
    /// comes back when the takeover ends.
    Microphone,
}

/// `takeoverMicrophoneHold({active, roomOpen, microphoneMuted, ownership})`.
pub fn takeover_microphone_hold(
    active: bool,
    room_open: bool,
    microphone_muted: bool,
    ownership: Option<TakeoverMuteOwnership>,
) -> Option<TakeoverMicrophoneHold> {
    if !active {
        return None;
    }
    if room_open {
        return Some(TakeoverMicrophoneHold::Stream);
    }
    (microphone_muted && ownership.is_some_and(|ownership| !ownership.prior_microphone_muted))
        .then_some(TakeoverMicrophoneHold::Microphone)
}

/// `TAKEOVER_MUTED_LABEL`: the one status word for both holds.
pub const TAKEOVER_MUTED_LABEL: &str = "Muted for takeover";

/// `TAKEOVER_MUTED_HINT[hold]`.
pub fn takeover_muted_hint(hold: TakeoverMicrophoneHold) -> &'static str {
    match hold {
        TakeoverMicrophoneHold::Stream => {
            "Your audience can't hear you until the takeover ends. Guests in the room still can."
        }
        TakeoverMicrophoneHold::Microphone => {
            "Your microphone comes back on when the takeover ends."
        }
    }
}

/// `takeoverMicrophoneStatus(hold)`: the Sources row's chip, with its line.
pub fn takeover_microphone_status(hold: Option<TakeoverMicrophoneHold>) -> Option<SourceStatus> {
    let hold = hold?;
    Some(SourceStatus::new(TAKEOVER_MUTED_LABEL, ChipTone::Neutral).hint(takeover_muted_hint(hold)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIVE: Option<TakeoverMuteOwnership> = Some(TakeoverMuteOwnership {
        prior_microphone_muted: false,
    });

    #[test]
    fn says_nothing_without_a_takeover() {
        assert_eq!(takeover_microphone_hold(false, true, true, LIVE), None);
    }

    #[test]
    fn holds_the_stream_while_a_room_is_open_whatever_the_microphone_setting() {
        assert_eq!(
            takeover_microphone_hold(true, true, false, None),
            Some(TakeoverMicrophoneHold::Stream)
        );
    }

    #[test]
    fn holds_the_microphone_only_when_the_takeover_muted_a_live_one() {
        assert_eq!(
            takeover_microphone_hold(true, false, true, LIVE),
            Some(TakeoverMicrophoneHold::Microphone)
        );
        // Already muted before the takeover: the mute is the streamer's.
        assert_eq!(
            takeover_microphone_hold(
                true,
                false,
                true,
                Some(TakeoverMuteOwnership {
                    prior_microphone_muted: true
                })
            ),
            None
        );
        // Unmuted by hand during the takeover: the microphone is live.
        assert_eq!(takeover_microphone_hold(true, false, false, LIVE), None);
    }

    #[test]
    fn is_one_word_for_both_holds_with_when_it_ends_as_its_line() {
        assert_eq!(takeover_microphone_status(None), None);
        assert_eq!(
            takeover_microphone_status(Some(TakeoverMicrophoneHold::Stream)),
            Some(SourceStatus {
                label: "Muted for takeover".into(),
                tone: ChipTone::Neutral,
                hint: Some(
                    "Your audience can't hear you until the takeover ends. Guests in the room still can."
                        .into()
                ),
            })
        );
        assert_eq!(
            takeover_microphone_status(Some(TakeoverMicrophoneHold::Microphone))
                .map(|status| status.label),
            Some("Muted for takeover".to_string())
        );
    }

    #[test]
    fn the_stored_ownership_reads_only_a_boolean() {
        assert_eq!(
            load_mute_ownership(Some(r#"{"priorMicrophoneMuted":false}"#)),
            LIVE
        );
        assert_eq!(
            load_mute_ownership(Some(r#"{"priorMicrophoneMuted":"no"}"#)),
            None
        );
        assert_eq!(load_mute_ownership(Some("not json")), None);
        assert_eq!(load_mute_ownership(None), None);
    }
}
