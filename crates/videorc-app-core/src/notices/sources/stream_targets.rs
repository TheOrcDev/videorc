//! A destination is one notification (plan 250 S6, Electron's
//! `sources/stream-targets.ts` and `lib/stream-target-notices.ts`).
//! [`stream_target_notices`] decides what one `stream.targets` snapshot says;
//! [`publish_stream_target_notice`] puts it on the destination's subject,
//! where the watchdog's `destination-down` alert also lands, and "{X} is
//! back" resolves it.
//!
//! Caught up with today's Electron, past S1.6a's toast version: a down
//! destination is urgent when no other is on air (viewers see nothing), it
//! is said again when the others change, and this computer's feed to
//! Videorc Cloud is no destination ("Reconnecting to Videorc Cloud").

use std::collections::BTreeMap;

use videorc_protocol::streaming::StreamTargetState;

use super::devices::CURRENT_SESSION;
use super::{Door, HealthPage};
use crate::notices::Store;
use crate::notices::toasts::{StreamTargetRuntime, destination_label, other_destinations_line};
use crate::notices::types::{Action, ActionKind, Input, Resolution, Tone};

/// `STREAM_TARGETS_SOURCE`.
pub const STREAM_TARGETS_SOURCE: &str = "stream-targets";
/// `CLOUD_FEED_DOWN`.
pub const CLOUD_FEED_DOWN: &str = "Viewers see Be right back until this computer reconnects.";
/// The failed destination's words when nobody else is on air.
pub const NO_OTHER_DESTINATION: &str = "No other destination is streaming, so viewers see nothing.";
/// The not-receiving words.
pub const NOT_RECEIVING: &str = "Videorc is still sending it. Check the platform’s live dashboard.";

/// `StreamTargetNotice`: what one destination's change says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamTargetNotice {
    /// `stream-target:{targetId}`: every notice for one destination shares
    /// it, so "{X} is back" replaces the problem in place.
    pub key: String,
    pub target_id: String,
    /// It came back (`kind: 'success'`): the subject resolves.
    pub back: bool,
    pub title: String,
    pub description: String,
    /// No other destination is on air: viewers see nothing right now.
    pub urgent: bool,
}

/// recording.rs `CLOUD_FEED_TARGET_PREFIX`.
fn is_cloud_feed(target_id: &str) -> bool {
    target_id.starts_with("videorc-cloud-")
}

/// `otherDestinationsOnAir`: the destinations besides `target_id` that are
/// on air, the cloud feed not counted.
pub fn other_destinations_on_air<'a>(
    targets: impl IntoIterator<Item = (&'a str, StreamTargetState)>,
    target_id: &str,
) -> usize {
    targets
        .into_iter()
        .filter(|(id, state)| {
            *id != target_id && *state == StreamTargetState::Live && !is_cloud_feed(id)
        })
        .count()
}

/// `streamTargetNotices`: the notices one snapshot deserves, given each
/// destination's previous state.
pub fn stream_target_notices(
    previous: &BTreeMap<String, StreamTargetState>,
    targets: &[StreamTargetRuntime],
) -> Vec<StreamTargetNotice> {
    let was = || previous.iter().map(|(id, state)| (id.as_str(), *state));
    let now = || {
        targets
            .iter()
            .map(|target| (target.target_id.as_str(), target.state))
    };
    let down = |state: StreamTargetState| {
        matches!(
            state,
            StreamTargetState::Failed | StreamTargetState::Reconnecting
        )
    };
    let mut notices = Vec::new();
    for target in targets {
        let id = target.target_id.as_str();
        let before = previous.get(id).copied();
        // A destination still down follows the others: said again when
        // they change although its own state did not.
        let others_changed = down(target.state)
            && !is_cloud_feed(id)
            && other_destinations_on_air(was(), id) != other_destinations_on_air(now(), id);
        if before == Some(target.state) && !others_changed {
            continue;
        }
        let key = format!("stream-target:{id}");
        let label = destination_label(&target.label);
        let others_on_air = other_destinations_on_air(now(), id);
        let others = other_destinations_line(others_on_air);
        let urgent = others_on_air == 0;
        let notice =
            |back: bool, urgent: bool, title: String, description: String| StreamTargetNotice {
                key: key.clone(),
                target_id: id.to_string(),
                back,
                title,
                description,
                urgent,
            };
        if is_cloud_feed(id) && down(target.state) {
            notices.push(notice(
                false,
                false,
                "Reconnecting to Videorc Cloud".into(),
                CLOUD_FEED_DOWN.into(),
            ));
            continue;
        }
        match target.state {
            StreamTargetState::Failed => notices.push(notice(
                false,
                urgent,
                format!("Streaming to {label} stopped"),
                target
                    .message
                    .clone()
                    .or(others)
                    .unwrap_or_else(|| NO_OTHER_DESTINATION.into()),
            )),
            StreamTargetState::Reconnecting => notices.push(notice(
                false,
                urgent,
                format!("{label} is reconnecting"),
                match others {
                    Some(others) => format!("Viewers there see nothing until it's back. {others}"),
                    None => "Viewers see nothing until it's back.".into(),
                },
            )),
            StreamTargetState::Warning => notices.push(notice(
                false,
                false,
                format!("{label} isn't receiving your stream"),
                NOT_RECEIVING.into(),
            )),
            StreamTargetState::Live
                if matches!(
                    before,
                    Some(
                        StreamTargetState::Reconnecting
                            | StreamTargetState::Warning
                            | StreamTargetState::Failed
                    )
                ) =>
            {
                notices.push(notice(
                    true,
                    false,
                    format!("{label} is back"),
                    format!("Streaming to {label} resumed."),
                ));
            }
            _ => {}
        }
    }
    notices
}

/// `publishStreamTargetNotice`: a problem opens the destination's subject
/// (urgent when nobody else is on air) with Open Destinations; a return
/// resolves it.
pub fn publish_stream_target_notice(store: &mut Store, notice: &StreamTargetNotice, now: u64) {
    if notice.back {
        store.resolve(
            &notice.key,
            Resolution {
                source: Some(STREAM_TARGETS_SOURCE.into()),
                title: Some(notice.title.clone()),
                was: Some("It was down".into()),
                ..Resolution::default()
            },
            now,
        );
        return;
    }
    store.publish(
        Input {
            key: notice.key.clone(),
            kind: "stream-target".into(),
            source: STREAM_TARGETS_SOURCE.into(),
            tone: notice.urgent.then_some(Tone::Urgent),
            title: notice.title.clone(),
            detail: Some(notice.description.clone()),
            actions: vec![Action {
                id: "open-destinations".into(),
                label: "Open Destinations".into(),
                kind: ActionKind::Door,
            }],
            session_id: Some(CURRENT_SESSION.into()),
            ..Input::default()
        },
        now,
    );
}

/// `publishStreamTargetNotices`: every notice of one snapshot.
pub fn publish_stream_target_notices(store: &mut Store, notices: &[StreamTargetNotice], now: u64) {
    for notice in notices {
        publish_stream_target_notice(store, notice, now);
    }
}

/// Open Destinations, at the destination's card. False for another button.
pub fn run_action(key: &str, action_id: &str, pages: &mut dyn HealthPage) -> bool {
    let Some(target_id) = key.strip_prefix("stream-target:") else {
        return false;
    };
    if action_id != "open-destinations" {
        return false;
    }
    pages.open(Door::Destinations {
        target_id: Some(target_id.to_string()),
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notices::Effect;
    use crate::notices::types::State;

    fn target(id: &str, label: &str, state: StreamTargetState) -> StreamTargetRuntime {
        StreamTargetRuntime {
            target_id: id.into(),
            label: label.into(),
            state,
            message: None,
        }
    }

    fn states(pairs: &[(&str, StreamTargetState)]) -> BTreeMap<String, StreamTargetState> {
        pairs
            .iter()
            .map(|(id, state)| (id.to_string(), *state))
            .collect()
    }

    use StreamTargetState::{Failed, Live, Reconnecting, Warning};

    #[test]
    fn a_lone_destination_down_is_urgent_and_another_on_air_is_not() {
        let alone = stream_target_notices(
            &states(&[("tw", Live)]),
            &[target("tw", "Twitch", Reconnecting)],
        );
        assert_eq!(alone.len(), 1);
        assert!(alone[0].urgent);
        assert_eq!(alone[0].title, "Twitch is reconnecting");
        assert_eq!(alone[0].description, "Viewers see nothing until it's back.");

        let two = stream_target_notices(
            &states(&[("tw", Live), ("yt", Live)]),
            &[
                target("tw", "Twitch", Failed),
                target("yt", "YouTube", Live),
            ],
        );
        assert_eq!(two.len(), 1);
        assert!(!two[0].urgent);
        assert_eq!(two[0].description, "The other destination keeps streaming.");
    }

    #[test]
    fn a_down_destination_is_said_again_when_the_others_change() {
        let notices = stream_target_notices(
            &states(&[("tw", Failed), ("yt", Live)]),
            &[
                target("tw", "Twitch", Failed),
                target("yt", "YouTube", Reconnecting),
            ],
        );
        let twitch = notices
            .iter()
            .find(|notice| notice.target_id == "tw")
            .unwrap();
        assert!(twitch.urgent, "nobody is on air now");
    }

    #[test]
    fn the_cloud_feed_is_no_destination_and_a_return_resolves() {
        let cloud = stream_target_notices(
            &states(&[("videorc-cloud-1", Live)]),
            &[target("videorc-cloud-1", "Videorc Cloud", Reconnecting)],
        );
        assert_eq!(cloud[0].title, "Reconnecting to Videorc Cloud");
        assert!(!cloud[0].urgent);
        let warned =
            stream_target_notices(&states(&[("tw", Live)]), &[target("tw", "Twitch", Warning)]);
        assert_eq!(warned[0].description, NOT_RECEIVING);

        let mut store = Store::new(0, 0);
        let down =
            stream_target_notices(&states(&[("tw", Live)]), &[target("tw", "Twitch", Failed)]);
        publish_stream_target_notices(&mut store, &down, 1_000);
        let entry = &store.snapshot()[0];
        assert_eq!(entry.tone, Tone::Urgent);
        assert_eq!(entry.actions[0].id, "open-destinations");
        // Idle (nothing live in the store), it does not pop up.
        assert!(
            !store
                .take_effects()
                .iter()
                .any(|effect| matches!(effect, Effect::Show { .. }))
        );
        let back =
            stream_target_notices(&states(&[("tw", Failed)]), &[target("tw", "Twitch", Live)]);
        assert!(back[0].back);
        publish_stream_target_notices(&mut store, &back, 9_000);
        let entry = &store.snapshot()[0];
        assert_eq!(entry.state, State::Resolved);
        assert_eq!(entry.title, "Twitch is back");
    }

    #[test]
    fn open_destinations_goes_to_the_card() {
        struct Pages(Vec<Door>);
        impl HealthPage for Pages {
            fn open(&mut self, door: Door) {
                self.0.push(door);
            }
        }
        let mut pages = Pages(Vec::new());
        assert!(run_action(
            "stream-target:tw",
            "open-destinations",
            &mut pages
        ));
        assert!(!run_action("microphone", "open-destinations", &mut pages));
        assert_eq!(
            pages.0,
            [Door::Destinations {
                target_id: Some("tw".into())
            }]
        );
    }

    /// The words are Electron's.
    #[test]
    fn the_words_are_electrons() {
        const NOTICES: &str = include_str!(
            "../../../../../apps/desktop/src/renderer/src/lib/stream-target-notices.ts"
        );
        const SOURCE: &str = include_str!(
            "../../../../../apps/desktop/src/renderer/src/lib/notifications/sources/stream-targets.ts"
        );
        for words in [
            CLOUD_FEED_DOWN,
            NO_OTHER_DESTINATION,
            NOT_RECEIVING,
            "'Reconnecting to Videorc Cloud'",
            "`Streaming to ${label} stopped`",
            "`${label} is reconnecting`",
            "`Viewers there see nothing until it's back. ${others}`",
            "\"Viewers see nothing until it's back.\"",
            "`${label} isn't receiving your stream`",
            "`${label} is back`",
            "`Streaming to ${label} resumed.`",
        ] {
            assert!(
                NOTICES.contains(words),
                "stream-target-notices.ts lacks {words}"
            );
        }
        assert!(SOURCE.contains(&format!(
            "STREAM_TARGETS_SOURCE = '{STREAM_TARGETS_SOURCE}'"
        )));
        assert!(SOURCE.contains("was: 'It was down'"));
        assert!(SOURCE.contains("label: 'Open Destinations'"));
    }
}
