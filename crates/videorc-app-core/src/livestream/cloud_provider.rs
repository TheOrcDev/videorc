//! S1.6c: the cloud's provider output as Go Live and the cleanup read it
//! (`lib/cloud-provider-lifecycle.ts`).
//!
//! - **The wait** (`waitForCloudProviderOutput`): while the talk-show room
//!   is open, X's publish and YouTube's transition wait until the cloud's leg
//!   for that destination is live. Only the destination's own facts count,
//!   never the encoder's readiness or the room's live flag.
//! - **The terminal owner** (`cloudTerminalOwner`): the show whose end
//!   settles its platform cleanup. A disappearance or a disconnect alone is
//!   not an end, and a hand-off never is.

use super::cloud_status::CloudStatus;

/// `waitForCloudProviderOutput`: eight reads, 2 s apart.
pub const OUTPUT_ATTEMPTS: usize = 8;
pub const OUTPUT_INTERVAL_MS: u64 = 2_000;

pub const START_CANCELLED: &str = "The livestream start was cancelled.";
pub const OUTPUT_NOT_OWNED: &str = "This computer no longer owns that cloud output.";
pub const OUTPUT_INTERVAL_CHANGED: &str = "The cloud output interval changed.";
pub const DESTINATION_FAILED: &str = "The cloud destination failed before it went live.";
pub const DESTINATION_NOT_LIVE: &str =
    "The cloud destination is not live yet. Going live is still pending.";

/// End reasons that are a lost link, not the show's end.
const NOT_AN_END: [&str; 3] = [
    "handover-failed",
    "node-unreachable",
    "cloud-node-unreachable",
];

/// One read of the cloud's status during the wait.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutputStep {
    /// The destination's leg is live on a connected cloud.
    Live,
    /// Not yet: read again.
    Wait,
    /// The wait fails with these words.
    Fail(&'static str),
}

/// One step of `waitForCloudProviderOutput`. `interval` is the live
/// interval the first read saw; a later read on another one fails.
pub fn output_step(
    status: &CloudStatus,
    show_id: &str,
    target_id: &str,
    interval: &mut Option<String>,
) -> OutputStep {
    let interval_now = status.live_interval.as_ref();
    let not_owned = status.show.as_ref().map(|show| show.id.as_str()) != Some(show_id)
        || status.stopped_by.is_some()
        || status
            .on_air
            .as_ref()
            .is_some_and(|on_air| !on_air.this_device)
        || interval_now.is_some_and(|interval| {
            interval
                .end_requested_at
                .as_deref()
                .is_some_and(|at| !at.is_empty())
        })
        || matches!(status.phase.as_str(), "ending" | "failed" | "off");
    if not_owned {
        return OutputStep::Fail(OUTPUT_NOT_OWNED);
    }
    let id_now = interval_now.map(|interval| interval.id.clone());
    if interval.is_some() && id_now != *interval {
        return OutputStep::Fail(OUTPUT_INTERVAL_CHANGED);
    }
    if interval.is_none() {
        *interval = id_now;
    }
    let leg = status.legs.iter().find(|leg| leg.target_id == target_id);
    match leg.map(|leg| leg.state.as_str()) {
        Some("failed" | "stopped") => OutputStep::Fail(DESTINATION_FAILED),
        Some("live") if status.connected => OutputStep::Live,
        _ => OutputStep::Wait,
    }
}

fn room_live(status: &CloudStatus) -> Option<bool> {
    status
        .room
        .as_ref()
        .and_then(|room| room.get("live"))
        .and_then(serde_json::Value::as_bool)
}

/// `cloudTerminalOwner`: the show id whose platform cleanup is due, if the
/// show ended (it is gone with a real end reason, or its room stopped being
/// live while connected).
pub fn cloud_terminal_owner(previous: Option<&CloudStatus>, next: &CloudStatus) -> Option<String> {
    let previous = previous?;
    let id = previous.show.as_ref().map(|show| show.id.as_str())?;
    if id.is_empty()
        || next.stopped_by.is_some()
        || next
            .on_air
            .as_ref()
            .is_some_and(|on_air| !on_air.this_device)
    {
        return None;
    }
    let ended = next.show.is_none()
        && next
            .end_reason
            .as_deref()
            .is_some_and(|reason| !reason.is_empty() && !NOT_AN_END.contains(&reason));
    let room_stopped = next.show.as_ref().is_some_and(|show| show.id == id)
        && room_live(previous) == Some(true)
        && room_live(next) == Some(false)
        && next.connected;
    (ended || room_stopped).then(|| id.to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn status(value: serde_json::Value) -> CloudStatus {
        CloudStatus::from_value(&value).expect("a cloud status")
    }

    fn live(leg_state: &str) -> CloudStatus {
        status(json!({
            "phase": "live",
            "connected": true,
            "show": { "id": "show-1", "nodeId": "n" },
            "liveInterval": { "id": "i-1", "requestedAt": "t" },
            "legs": [{ "targetId": "x-1", "platform": "x", "label": "X", "state": leg_state }],
        }))
    }

    #[test]
    fn the_wait_ends_when_the_destinations_own_leg_is_live() {
        let mut interval = None;
        assert_eq!(
            output_step(&live("connecting"), "show-1", "x-1", &mut interval),
            OutputStep::Wait
        );
        assert_eq!(interval.as_deref(), Some("i-1"));
        assert_eq!(
            output_step(&live("live"), "show-1", "x-1", &mut interval),
            OutputStep::Live
        );
        // Another destination's live leg is not this one's.
        assert_eq!(
            output_step(&live("live"), "show-1", "yt-1", &mut None),
            OutputStep::Wait
        );
        let mut offline = live("live");
        offline.connected = false;
        assert_eq!(
            output_step(&offline, "show-1", "x-1", &mut None),
            OutputStep::Wait
        );
    }

    #[test]
    fn the_wait_fails_when_the_output_is_not_this_computers_any_more() {
        let fail = |status: &CloudStatus| output_step(status, "show-1", "x-1", &mut None);
        assert_eq!(
            output_step(&live("live"), "show-2", "x-1", &mut None),
            OutputStep::Fail(OUTPUT_NOT_OWNED)
        );
        let mut handed = live("live");
        handed.stopped_by = Some("hand-off".into());
        assert_eq!(fail(&handed), OutputStep::Fail(OUTPUT_NOT_OWNED));
        let mut ending = live("live");
        ending.phase = "ending".into();
        assert_eq!(fail(&ending), OutputStep::Fail(OUTPUT_NOT_OWNED));
        let mut end_asked = live("live");
        end_asked.live_interval.as_mut().unwrap().end_requested_at = Some("t".into());
        assert_eq!(fail(&end_asked), OutputStep::Fail(OUTPUT_NOT_OWNED));
        assert_eq!(fail(&live("failed")), OutputStep::Fail(DESTINATION_FAILED));
        let mut interval = Some("i-0".to_string());
        assert_eq!(
            output_step(&live("live"), "show-1", "x-1", &mut interval),
            OutputStep::Fail(OUTPUT_INTERVAL_CHANGED)
        );
    }

    #[test]
    fn a_show_ends_on_a_real_end_reason_or_its_room_stopping_never_on_a_hand_off() {
        let previous = status(json!({
            "show": { "id": "show-1" },
            "connected": true,
            "room": { "live": true },
        }));
        let gone = |reason: &str| status(json!({ "endReason": reason }));
        assert_eq!(
            cloud_terminal_owner(Some(&previous), &gone("ended")).as_deref(),
            Some("show-1")
        );
        assert_eq!(
            cloud_terminal_owner(Some(&previous), &gone("node-unreachable")),
            None
        );
        assert_eq!(
            cloud_terminal_owner(Some(&previous), &status(json!({}))),
            None
        );
        assert_eq!(cloud_terminal_owner(None, &gone("ended")), None);
        let handed = status(json!({ "endReason": "ended", "stoppedBy": "hand-off" }));
        assert_eq!(cloud_terminal_owner(Some(&previous), &handed), None);
        let room_off = status(json!({
            "show": { "id": "show-1" },
            "connected": true,
            "room": { "live": false },
        }));
        assert_eq!(
            cloud_terminal_owner(Some(&previous), &room_off).as_deref(),
            Some("show-1")
        );
        let mut room_off_offline = room_off.clone();
        room_off_offline.connected = false;
        assert_eq!(
            cloud_terminal_owner(Some(&previous), &room_off_offline),
            None
        );
    }
}
