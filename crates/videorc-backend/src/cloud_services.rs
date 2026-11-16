//! Plan 249 S18: chat and Sidekick services follow the cloud show, not a
//! native capture session.
//!
//! A room's Go Live has no local recording, so the chat readers, the viewer
//! and audience samplers and Sidekick's automatic sends attach to the show id.
//! This module owns the two pure decisions behind that:
//!
//! - [`CloudServiceIdentity`]: the nonsecret provider/channel identity of the
//!   destinations this computer handed over, persisted with the show and its
//!   canonical live interval so a resume (including after a relaunch) can
//!   reattach the same readers. No URL, stream key, secret reference or token
//!   is reachable from it; credentials are resolved again from this computer's
//!   own accounts at attach time.
//! - [`plan_reattach`]: whether a resume keeps the readers it already has,
//!   attaches them again, or does nothing. It never allocates an interval id
//!   (S16 owns that) and never infers credentials from the fact that an output
//!   exists: a leg this computer holds no identity for is reported as
//!   unavailable here, with its reason, instead of being guessed at.
//!
//! [`failed_destination_platforms`] gives Sidekick's automatic-send guard the
//! actual cloud legs while a room owns the output, the same `failed` rule the
//! local session applies to its own legs.
use crate::cloud_show::CloudStatus;
use crate::streaming::{
    StreamAuthMode, StreamMode, StreamOutputOrientation, StreamPlatform, StreamTargetRuntime,
    StreamTargetSettings, StreamTargetState, StreamTargetsSnapshot, StreamingSettings,
};
use serde::{Deserialize, Serialize};

/// The backend-private `app_settings` row holding the last show's service
/// identity (`null` once its live interval ended here). Not a secret.
pub const CLOUD_SHOW_SERVICES_KEY: &str = "cloud.showServices";

const IDENTITY_VERSION: u32 = 1;

/// One handed-over destination, as much as chat, viewers and audience need to
/// find their channel again. Deliberately has no URL, key or secret ref.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudServiceDestination {
    pub target_id: String,
    pub platform: StreamPlatform,
    pub auth_mode: StreamAuthMode,
    /// The connected account the destination names (a provider channel id or
    /// the local account row id); `None` reads whichever account is connected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// YouTube's broadcast, which its chat and viewer count are bound to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform_broadcast_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_orientation: Option<StreamOutputOrientation>,
    pub label: String,
}

/// The services a show's live interval attached on this computer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudServiceIdentity {
    pub version: u32,
    pub show_id: String,
    /// S16's canonical interval when the server reported one; `None` from an
    /// older server, which stays unknown (never a polling-edge invention).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_interval_id: Option<String>,
    /// An ended interval the server still reported when this Go Live began:
    /// the previous one, never this identity's. Its late End cannot release
    /// the services of the interval that replaced it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_interval_id: Option<String>,
    /// The cloud device id of the computer that attached them.
    pub owner_device_id: String,
    /// When chat first attached for this interval: chat published before it
    /// is history, which commands never answer, across every resume.
    pub attached_at: String,
    pub destinations: Vec<CloudServiceDestination>,
}

impl CloudServiceIdentity {
    /// The enabled destinations of a Go Live, keys and URLs left behind.
    pub fn capture(
        show_id: &str,
        interval: Option<&LiveIntervalView>,
        owner_device_id: &str,
        attached_at: &str,
        streaming: &StreamingSettings,
    ) -> Self {
        let destinations = streaming
            .targets
            .iter()
            .filter(|target| streaming.enabled_target_ids.contains(&target.id))
            .map(|target| CloudServiceDestination {
                target_id: target.id.clone(),
                platform: target.platform,
                auth_mode: target.auth_mode,
                account_id: target.account_id.clone(),
                platform_broadcast_id: target.platform_broadcast_id.clone(),
                output_orientation: target.output_orientation,
                label: target.label.clone(),
            })
            .collect();
        // An interval already ended is the previous Go Live's, not this one's.
        let (live_interval_id, superseded_interval_id) = match interval {
            Some(interval) if interval.ended => (None, Some(interval.id.clone())),
            Some(interval) => (Some(interval.id.clone()), None),
            None => (None, None),
        };
        Self {
            version: IDENTITY_VERSION,
            show_id: show_id.to_string(),
            live_interval_id,
            superseded_interval_id,
            owner_device_id: owner_device_id.to_string(),
            attached_at: attached_at.to_string(),
            destinations,
        }
    }

    /// Record the X broadcast the renderer attached for one destination of
    /// this show (`liveChat.x.start`): a nonsecret id the X reader needs to
    /// attach again. Returns whether anything changed.
    pub fn note_broadcast(&mut self, target_id: &str, broadcast_id: &str) -> bool {
        let Some(destination) = self
            .destinations
            .iter_mut()
            .find(|destination| destination.target_id == target_id)
        else {
            return false;
        };
        if destination.platform_broadcast_id.as_deref() == Some(broadcast_id)
            || broadcast_id.trim().is_empty()
        {
            return false;
        }
        destination.platform_broadcast_id = Some(broadcast_id.to_string());
        true
    }

    /// The X readers to attach again: destinations whose broadcast is known.
    /// Auth stays with the X connector, which reads this computer's account
    /// and Videorc sign-in at runtime (it parks visibly without them).
    pub fn x_broadcasts(destinations: &[CloudServiceDestination]) -> Vec<(String, String)> {
        destinations
            .iter()
            .filter(|destination| {
                destination.platform == StreamPlatform::X
                    && destination.auth_mode == StreamAuthMode::Oauth
            })
            .filter_map(|destination| {
                destination
                    .platform_broadcast_id
                    .as_ref()
                    .map(|broadcast| (destination.target_id.clone(), broadcast.clone()))
            })
            .collect()
    }

    /// Keyless streaming settings naming exactly these destinations, the
    /// shape `prepare_session_live_chat` reads (id, platform, auth mode,
    /// account and broadcast). Server URL and key fields stay empty: nothing
    /// built from this can open an output.
    pub fn streaming_settings(
        &self,
        destinations: &[CloudServiceDestination],
    ) -> StreamingSettings {
        let targets: Vec<StreamTargetSettings> = destinations
            .iter()
            .map(|destination| StreamTargetSettings {
                id: destination.target_id.clone(),
                platform: destination.platform,
                label: destination.label.clone(),
                enabled: true,
                server_url: String::new(),
                url_mode: None,
                stream_key: String::new(),
                stream_key_secret_ref: None,
                stream_key_present: false,
                auth_mode: destination.auth_mode,
                account_id: destination.account_id.clone(),
                account_label: None,
                platform_broadcast_id: destination.platform_broadcast_id.clone(),
                platform_stream_id: None,
                output_preset: None,
                output_bitrate_kbps: None,
                output_orientation: destination.output_orientation,
                status: None,
                created_at: self.attached_at.clone(),
                updated_at: self.attached_at.clone(),
            })
            .collect();
        StreamingSettings {
            enabled: true,
            mode: StreamMode::Multi,
            enabled_target_ids: targets.iter().map(|target| target.id.clone()).collect(),
            selected_target_id: None,
            // Unused by chat: nothing built from these settings encodes.
            default_output_preset: crate::protocol::VideoPreset::Tutorial1080p30,
            default_bitrate_kbps: 0,
            targets,
        }
    }
}

/// A connected account on this computer, as `plan_reattach` needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalAccount {
    pub platform: StreamPlatform,
    /// The provider's channel/user id.
    pub account_id: String,
    /// The local account row id.
    pub id: String,
    pub has_credentials: bool,
}

impl LocalAccount {
    pub fn from_platform_account(account: &crate::streaming::PlatformAccount) -> Self {
        Self {
            platform: account.platform,
            account_id: account.account_id.clone(),
            id: account.id.clone(),
            has_credentials: account.access_token_present || account.refresh_token_present,
        }
    }
}

/// What a resume sees, read once under the cloud slot and the chat lock.
#[derive(Debug, Clone)]
pub struct ReattachFacts<'a> {
    pub show_id: Option<&'a str>,
    pub show_kind: Option<&'a str>,
    /// S16's canonical interval, when the server reports one.
    pub interval: Option<&'a LiveIntervalView>,
    pub device_id: &'a str,
    /// This computer holds the show: no other device is on air and nothing
    /// stopped it for a hand-off or takeover.
    pub this_device_owns: bool,
    /// The room holds platform legs (`CloudRoomStatus::live`).
    pub room_live: bool,
    pub legs: &'a [StreamTargetRuntime],
    /// The chat session the coordinator runs now, if any.
    pub chat_session_id: Option<&'a str>,
    pub accounts: &'a [LocalAccount],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnavailableReason {
    /// The show's identity for this leg lives on the computer that went live.
    IdentityOnAnotherDevice,
    /// The leg's account is not connected on this computer.
    CredentialsOnAnotherDevice,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnavailableDestination {
    pub target_id: String,
    pub platform: StreamPlatform,
    pub reason: UnavailableReason,
}

impl UnavailableDestination {
    /// The row's neutral notice: why there are no comments here, and what
    /// brings them. Never names the account or the channel.
    pub fn notice(&self) -> String {
        let platform = platform_name(self.platform);
        match self.reason {
            UnavailableReason::IdentityOnAnotherDevice => {
                format!("{platform} comments for this show stay on the computer that went live.")
            }
            UnavailableReason::CredentialsOnAnotherDevice => format!(
                "Connect the same {platform} account on this computer to read this show's comments."
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReattachDecision {
    /// The chat session for this show already runs here: one reader set.
    Keep,
    /// Attach again, keeping the show's history and its first attach time.
    Attach {
        identity: CloudServiceIdentity,
        destinations: Vec<CloudServiceDestination>,
        unavailable: Vec<UnavailableDestination>,
    },
    /// Nothing to attach, and why (for the log).
    Skip(&'static str),
}

pub fn plan_reattach(
    snapshot: Option<&CloudServiceIdentity>,
    facts: &ReattachFacts<'_>,
) -> ReattachDecision {
    let Some(show_id) = facts.show_id else {
        return ReattachDecision::Skip("no-show");
    };
    if facts.show_kind != Some("talk") {
        // A solo show reattaches through its own resumed capture session.
        return ReattachDecision::Skip("not-a-room");
    }
    if !facts.this_device_owns {
        return ReattachDecision::Skip("another-device-owns-the-show");
    }
    if !facts.room_live || facts.legs.is_empty() {
        return ReattachDecision::Skip("not-live");
    }
    if facts.chat_session_id == Some(show_id) {
        return ReattachDecision::Keep;
    }
    // An ended interval is no live interval to attach to.
    let current = facts.interval.filter(|interval| !interval.ended);
    if facts.interval.is_some() && current.is_none() {
        return ReattachDecision::Skip("interval-ended");
    }
    let interval_matches = |identity: &CloudServiceIdentity| match (
        identity.live_interval_id.as_deref(),
        current.map(|interval| interval.id.as_str()),
    ) {
        (Some(held), Some(current)) => held == current,
        // Recorded before the server named it: anything but the interval
        // this Go Live replaced.
        (None, Some(current)) => identity.superseded_interval_id.as_deref() != Some(current),
        // An older server reports no interval: unknown is not a mismatch.
        (_, None) => true,
    };
    let owned = snapshot.filter(|identity| {
        identity.version == IDENTITY_VERSION
            && identity.show_id == show_id
            && identity.owner_device_id == facts.device_id
            && interval_matches(identity)
    });
    let mut destinations = Vec::new();
    let mut unavailable = Vec::new();
    for leg in facts.legs {
        if leg.state == StreamTargetState::Stopped {
            continue;
        }
        let held = owned.and_then(|identity| {
            identity
                .destinations
                .iter()
                .find(|destination| destination.target_id == leg.target_id)
        });
        let Some(destination) = held.filter(|d| d.platform == leg.platform) else {
            unavailable.push(UnavailableDestination {
                target_id: leg.target_id.clone(),
                platform: leg.platform,
                reason: UnavailableReason::IdentityOnAnotherDevice,
            });
            continue;
        };
        if needs_account(destination) && !account_connected(destination, facts.accounts) {
            unavailable.push(UnavailableDestination {
                target_id: destination.target_id.clone(),
                platform: destination.platform,
                reason: UnavailableReason::CredentialsOnAnotherDevice,
            });
            continue;
        }
        destinations.push(destination.clone());
    }
    if destinations.is_empty() && unavailable.is_empty() {
        return ReattachDecision::Skip("no-live-destinations");
    }
    let mut identity = owned.cloned().unwrap_or_else(|| CloudServiceIdentity {
        version: IDENTITY_VERSION,
        show_id: show_id.to_string(),
        live_interval_id: None,
        superseded_interval_id: None,
        owner_device_id: facts.device_id.to_string(),
        attached_at: crate::cloud_show::now_rfc3339(),
        destinations: Vec::new(),
    });
    // Adopt the server's id once it names the interval (read, never made).
    if identity.live_interval_id.is_none() {
        identity.live_interval_id = current.map(|interval| interval.id.clone());
    }
    ReattachDecision::Attach {
        identity,
        destinations,
        unavailable,
    }
}

/// Destinations whose comments come from a connected account. A YouTube or X
/// stream key reads none (the attach marks those rows itself), so it needs no
/// account here either.
fn needs_account(destination: &CloudServiceDestination) -> bool {
    match destination.platform {
        StreamPlatform::Youtube | StreamPlatform::X => {
            destination.auth_mode == StreamAuthMode::Oauth
        }
        StreamPlatform::Twitch | StreamPlatform::Kick => true,
        StreamPlatform::Facebook
        | StreamPlatform::Tiktok
        | StreamPlatform::Instagram
        | StreamPlatform::Custom => false,
    }
}

/// The same match the chat config applies (`youtube_account_credentials`):
/// the provider id or the local row id; no id means any connected account.
fn account_connected(destination: &CloudServiceDestination, accounts: &[LocalAccount]) -> bool {
    accounts.iter().any(|account| {
        account.platform == destination.platform
            && account.has_credentials
            && destination
                .account_id
                .as_deref()
                .is_none_or(|id| account.account_id == id || account.id == id)
    })
}

/// S16's canonical live interval as S18 reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveIntervalView {
    pub id: String,
    /// `endedAt` is set: the stream output of this interval stopped (never a
    /// claim that providers completed).
    pub ended: bool,
}

/// The live interval the server reports for this show: S16's canonical
/// `CloudStatus::live_interval`, or `None` from an older server, which stays
/// unknown. Read only, never allocated or inferred from a polling edge here.
/// Only a confirmed End (`endedAt`) ends it; a requested End is pending.
pub fn canonical_live_interval(status: &CloudStatus) -> Option<LiveIntervalView> {
    let interval = status.live_interval.as_ref()?;
    let id = interval.id.trim();
    if id.is_empty() {
        return None;
    }
    Some(LiveIntervalView {
        id: id.to_string(),
        ended: interval
            .ended_at
            .as_deref()
            .is_some_and(|at| !at.trim().is_empty()),
    })
}

/// What the emit hook needs to know about the services this computer holds:
/// the show and interval of its saved identity. Kept in memory so the hook,
/// which runs on every cloud state change, decides without a database read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArmedServices {
    pub show_id: String,
    pub live_interval_id: Option<String>,
    pub superseded_interval_id: Option<String>,
}

impl From<&CloudServiceIdentity> for ArmedServices {
    fn from(identity: &CloudServiceIdentity) -> Self {
        Self {
            show_id: identity.show_id.clone(),
            live_interval_id: identity.live_interval_id.clone(),
            superseded_interval_id: identity.superseded_interval_id.clone(),
        }
    }
}

static ARMED: std::sync::Mutex<Option<ArmedServices>> = std::sync::Mutex::new(None);

/// Mirror of the saved identity (`None` once it is forgotten).
pub fn arm(identity: Option<&CloudServiceIdentity>) {
    *ARMED.lock().unwrap_or_else(|p| p.into_inner()) = identity.map(ArmedServices::from);
}

pub fn armed() -> Option<ArmedServices> {
    ARMED.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// What a cloud state change says about the services armed here.
#[derive(Debug, Clone, Copy)]
pub struct TerminalFacts<'a> {
    pub show_id: Option<&'a str>,
    /// The state says a show ended (`CloudStatus::end_reason`). No show and no
    /// end reason is the launch gap before the remembered show is restored,
    /// never an End.
    pub show_end_observed: bool,
    pub interval: Option<&'a LiveIntervalView>,
    /// The runner reports the room (`CloudRoomStatus::connected`): its
    /// `live` is an observation, not the pre-state gap after a relaunch.
    pub room_reported: bool,
    pub room_live: bool,
    /// Stopped for a hand-off or takeover: the camera-return path already
    /// stops this show's readers, and the identity stays for a take-back.
    pub stopped_for_continuation: bool,
    /// The chat session running here, if known.
    pub chat_session_id: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalAction {
    Keep,
    /// Stop only `show_id`'s readers (never a successor's) and forget the
    /// identity.
    Release {
        show_id: String,
        reason: &'static str,
    },
}

/// Plan 249 S18: a web, phone, quota or runner End reaches this computer only
/// as cloud state. Release the armed services when that state says *their*
/// show or interval ended; a stale End for a replaced interval, or a show
/// handed elsewhere, releases nothing a successor uses.
pub fn plan_terminal(armed: &ArmedServices, facts: &TerminalFacts<'_>) -> TerminalAction {
    let release = |reason| TerminalAction::Release {
        show_id: armed.show_id.clone(),
        reason,
    };
    if facts.stopped_for_continuation {
        return TerminalAction::Keep;
    }
    match facts.show_id {
        Some(show) if show != armed.show_id => return release("show-replaced"),
        // Ended on the website, by quota or by the runner (a talk show's
        // room closes with it).
        None if facts.show_end_observed => return release("show-ended"),
        // After a relaunch the show and its room are absent until the launch
        // check and Resume restore them: nothing is known yet.
        None => return TerminalAction::Keep,
        Some(_) => {}
    }
    match (armed.live_interval_id.as_deref(), facts.interval) {
        (Some(held), Some(current)) if current.id != held => release("interval-replaced"),
        (Some(_), Some(current)) if current.ended => release("interval-ended"),
        (Some(_), Some(_)) => TerminalAction::Keep,
        // Armed before the server named the interval: its previous,
        // already-ended interval is stale news, never this Go Live's End.
        (None, Some(current))
            if armed.superseded_interval_id.as_deref() == Some(current.id.as_str()) =>
        {
            TerminalAction::Keep
        }
        (None, Some(current)) if current.ended => release("interval-ended"),
        (None, Some(_)) => TerminalAction::Keep,
        // An older server: the runner reports the room with no legs while
        // this show's readers run here.
        (_, None)
            if facts.room_reported
                && !facts.room_live
                && facts.chat_session_id == Some(armed.show_id.as_str()) =>
        {
            release("legs-ended")
        }
        (_, None) => TerminalAction::Keep,
    }
}

/// `canonical_live_interval`'s id.
pub fn canonical_live_interval_id(status: &CloudStatus) -> Option<String> {
    canonical_live_interval(status).map(|interval| interval.id)
}

/// The platforms whose stream destination failed, for Sidekick's automatic
/// sends. While the chat session is the room's show, the cloud legs are the
/// actual destinations (the room has no native capture, so the native
/// snapshot is absent, and a stray native snapshot never answers for the
/// room); otherwise the native session's own legs, exactly as before.
pub fn failed_destination_platforms(
    chat_session_id: &str,
    native: Option<&StreamTargetsSnapshot>,
    cloud: &CloudStatus,
) -> Vec<StreamPlatform> {
    let room_owns = cloud
        .show
        .as_ref()
        .is_some_and(|show| show.id == chat_session_id)
        && cloud.room.is_some();
    let legs: &[StreamTargetRuntime] = if room_owns {
        &cloud.legs
    } else {
        // Unchanged local rule: the native session's legs, when one runs.
        match native {
            Some(snapshot) => snapshot.targets.as_slice(),
            None => &[],
        }
    };
    let mut failed: Vec<StreamPlatform> = legs
        .iter()
        .filter(|leg| leg.state == StreamTargetState::Failed)
        .map(|leg| leg.platform)
        .collect();
    failed.dedup();
    failed
}

fn platform_name(platform: StreamPlatform) -> &'static str {
    match platform {
        StreamPlatform::Youtube => "YouTube",
        StreamPlatform::Twitch => "Twitch",
        StreamPlatform::Kick => "Kick",
        StreamPlatform::X => "X",
        StreamPlatform::Facebook => "Facebook",
        StreamPlatform::Tiktok => "TikTok",
        StreamPlatform::Instagram => "Instagram",
        StreamPlatform::Custom => "Custom",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn target(id: &str, platform: &str, auth: &str, account: Option<&str>) -> serde_json::Value {
        let broadcast = (platform == "youtube").then_some("broadcast-1");
        json!({
            "id": id, "platform": platform, "label": format!("{id} label"), "enabled": true,
            "serverUrl": "rtmp://ingest.invalid/app", "streamKey": "",
            "streamKeySecretRef": format!("secret-ref-{id}"), "streamKeyPresent": true,
            "authMode": auth, "accountId": account, "platformBroadcastId": broadcast,
            "createdAt": "2026-11-16T00:00:00Z", "updatedAt": "2026-11-16T00:00:00Z"
        })
    }

    fn streaming() -> StreamingSettings {
        serde_json::from_value(json!({
            "enabled": true, "mode": "multi",
            "targets": [
                target("yt", "youtube", "oauth", Some("UC-channel")),
                target("tw", "twitch", "manual-rtmp", Some("tw-user")),
                target("off", "kick", "oauth", Some("kick-user"))
            ],
            "defaultOutputPreset": "tutorial-1080p30", "defaultBitrateKbps": 6000,
            "enabledTargetIds": ["yt", "tw"]
        }))
        .unwrap()
    }

    fn leg(id: &str, platform: StreamPlatform, state: StreamTargetState) -> StreamTargetRuntime {
        StreamTargetRuntime {
            target_id: id.to_string(),
            platform,
            label: id.to_string(),
            state,
            message: None,
            redacted_url: None,
            uplink_overflows: None,
            uplink_overflow_at: None,
        }
    }

    fn accounts() -> Vec<LocalAccount> {
        vec![
            LocalAccount {
                platform: StreamPlatform::Youtube,
                account_id: "UC-channel".into(),
                id: "row-yt".into(),
                has_credentials: true,
            },
            LocalAccount {
                platform: StreamPlatform::Twitch,
                account_id: "tw-user".into(),
                id: "row-tw".into(),
                has_credentials: true,
            },
        ]
    }

    /// A server interval for a test (leaked: tests only).
    fn view(id: &str, ended: bool) -> &'static LiveIntervalView {
        Box::leak(Box::new(LiveIntervalView {
            id: id.to_string(),
            ended,
        }))
    }

    fn identity(interval: Option<&str>) -> CloudServiceIdentity {
        CloudServiceIdentity::capture(
            "show-1",
            interval.map(|id| view(id, false)),
            "device-a",
            "2026-11-16T10:00:00Z",
            &streaming(),
        )
    }

    fn facts<'a>(
        legs: &'a [StreamTargetRuntime],
        accounts: &'a [LocalAccount],
    ) -> ReattachFacts<'a> {
        ReattachFacts {
            show_id: Some("show-1"),
            show_kind: Some("talk"),
            interval: Some(view("interval-a", false)),
            device_id: "device-a",
            this_device_owns: true,
            room_live: true,
            legs,
            chat_session_id: None,
            accounts,
        }
    }

    #[test]
    fn the_identity_keeps_channels_and_drops_every_key_url_and_secret_ref() {
        let identity = identity(Some("interval-a"));
        assert_eq!(
            identity
                .destinations
                .iter()
                .map(|d| d.target_id.as_str())
                .collect::<Vec<_>>(),
            ["yt", "tw"],
            "only enabled destinations"
        );
        let stored = serde_json::to_string(&identity).unwrap();
        for secret in ["rtmp://", "ingest.invalid", "secret-ref", "streamKey"] {
            assert!(!stored.contains(secret), "{secret} leaked into {stored}");
        }
        assert!(stored.contains("UC-channel") && stored.contains("broadcast-1"));
        let back: CloudServiceIdentity = serde_json::from_str(&stored).unwrap();
        assert_eq!(back, identity);
        let rebuilt = identity.streaming_settings(&identity.destinations);
        assert_eq!(rebuilt.enabled_target_ids, ["yt", "tw"]);
        assert!(rebuilt.targets.iter().all(|t| t.server_url.is_empty()
            && t.stream_key.is_empty()
            && t.stream_key_secret_ref.is_none()
            && !t.stream_key_present));
        assert_eq!(
            rebuilt.targets[0].platform_broadcast_id.as_deref(),
            Some("broadcast-1")
        );
    }

    #[test]
    fn a_resume_on_the_owning_computer_reattaches_the_same_destinations_once() {
        let legs = [
            leg("yt", StreamPlatform::Youtube, StreamTargetState::Live),
            leg("tw", StreamPlatform::Twitch, StreamTargetState::Failed),
        ];
        let accounts = accounts();
        let held = identity(Some("interval-a"));
        let ReattachDecision::Attach {
            identity,
            destinations,
            unavailable,
        } = plan_reattach(Some(&held), &facts(&legs, &accounts))
        else {
            panic!("expected attach");
        };
        assert_eq!(
            identity.attached_at, "2026-11-16T10:00:00Z",
            "history fence kept"
        );
        // A failed leg keeps its reader; automatic sends skip it separately.
        assert_eq!(destinations.len(), 2);
        assert!(unavailable.is_empty());
        // The chat already runs for this show: no second reader set.
        let mut running = facts(&legs, &accounts);
        running.chat_session_id = Some("show-1");
        assert_eq!(plan_reattach(Some(&held), &running), ReattachDecision::Keep);
    }

    #[test]
    fn another_computer_reports_every_leg_unavailable_instead_of_guessing() {
        let legs = [leg("yt", StreamPlatform::Youtube, StreamTargetState::Live)];
        let accounts = accounts();
        let mut other = facts(&legs, &accounts);
        other.device_id = "device-b";
        // The snapshot on this computer (if any) belongs to device A.
        for snapshot in [None, Some(identity(Some("interval-a")))] {
            let ReattachDecision::Attach {
                destinations,
                unavailable,
                identity,
            } = plan_reattach(snapshot.as_ref(), &other)
            else {
                panic!("expected explicit rows");
            };
            assert!(
                destinations.is_empty(),
                "no credentials inferred from a leg"
            );
            assert_eq!(
                unavailable[0].reason,
                UnavailableReason::IdentityOnAnotherDevice
            );
            assert_eq!(identity.owner_device_id, "device-b");
            assert_eq!(identity.live_interval_id.as_deref(), Some("interval-a"));
            assert!(!unavailable[0].notice().contains("UC-channel"));
        }
    }

    #[test]
    fn a_missing_account_is_explicit_and_keeps_the_other_readers() {
        let legs = [
            leg("yt", StreamPlatform::Youtube, StreamTargetState::Live),
            leg("tw", StreamPlatform::Twitch, StreamTargetState::Live),
        ];
        let only_youtube = vec![accounts().remove(0)];
        let held = identity(None);
        let ReattachDecision::Attach {
            destinations,
            unavailable,
            ..
        } = plan_reattach(Some(&held), &facts(&legs, &only_youtube))
        else {
            panic!("expected attach");
        };
        assert_eq!(destinations[0].target_id, "yt");
        assert_eq!(
            unavailable,
            [UnavailableDestination {
                target_id: "tw".into(),
                platform: StreamPlatform::Twitch,
                reason: UnavailableReason::CredentialsOnAnotherDevice,
            }]
        );
        assert!(
            unavailable[0]
                .notice()
                .starts_with("Connect the same Twitch account")
        );
    }

    #[test]
    fn a_newer_interval_or_a_stale_owner_never_reuses_the_old_identity() {
        let legs = [leg("yt", StreamPlatform::Youtube, StreamTargetState::Live)];
        let accounts = accounts();
        let old = identity(Some("interval-a"));
        let mut newer = facts(&legs, &accounts);
        newer.interval = Some(view("interval-b", false));
        let ReattachDecision::Attach {
            destinations,
            unavailable,
            identity,
        } = plan_reattach(Some(&old), &newer)
        else {
            panic!("expected explicit rows");
        };
        assert!(destinations.is_empty());
        assert_eq!(unavailable.len(), 1);
        assert_eq!(identity.live_interval_id.as_deref(), Some("interval-b"));
        // An older server has no interval: unknown is not a mismatch.
        let mut unknown = facts(&legs, &accounts);
        unknown.interval = None;
        assert!(matches!(
            plan_reattach(Some(&old), &unknown),
            ReattachDecision::Attach { ref destinations, .. } if destinations.len() == 1
        ));
        // Taken over or handed off: the old owner attaches nothing.
        let mut stale = facts(&legs, &accounts);
        stale.this_device_owns = false;
        assert_eq!(
            plan_reattach(Some(&old), &stale),
            ReattachDecision::Skip("another-device-owns-the-show")
        );
        // Off air (End livestream, record-only room) attaches nothing.
        let mut off_air = facts(&[], &accounts);
        off_air.room_live = false;
        assert_eq!(
            plan_reattach(Some(&old), &off_air),
            ReattachDecision::Skip("not-live")
        );
        let mut solo = facts(&legs, &accounts);
        solo.show_kind = Some("solo");
        assert_eq!(
            plan_reattach(Some(&old), &solo),
            ReattachDecision::Skip("not-a-room")
        );
    }

    #[test]
    fn stopped_legs_are_not_reattached() {
        let legs = [
            leg("yt", StreamPlatform::Youtube, StreamTargetState::Stopped),
            leg("tw", StreamPlatform::Twitch, StreamTargetState::Live),
        ];
        let accounts = accounts();
        let ReattachDecision::Attach { destinations, .. } =
            plan_reattach(Some(&identity(None)), &facts(&legs, &accounts))
        else {
            panic!("expected attach");
        };
        assert_eq!(destinations.len(), 1);
        assert_eq!(destinations[0].target_id, "tw");
    }

    fn cloud_with_room(legs: Vec<StreamTargetRuntime>) -> CloudStatus {
        let mut cloud = crate::cloud_show::CloudShowRuntime::default().status();
        cloud.show = Some(
            serde_json::from_value(json!({
                "id": "show-1", "nodeId": "managed", "resumable": false, "kind": "talk"
            }))
            .unwrap(),
        );
        cloud.room = Some(
            serde_json::from_value(json!({
                "phase": "open", "doorOpen": false, "declinedCount": 0,
                "stage": {"layout": "solo", "onStage": []}, "hostAway": false,
                "connected": true, "client": "connected", "returnEnabled": false,
                "stageSet": true, "live": true
            }))
            .unwrap(),
        );
        cloud.legs = legs;
        cloud
    }

    #[test]
    fn automatic_sends_read_the_room_legs_while_the_room_owns_the_chat() {
        let cloud = cloud_with_room(vec![
            leg("yt", StreamPlatform::Youtube, StreamTargetState::Failed),
            leg("tw", StreamPlatform::Twitch, StreamTargetState::Live),
        ]);
        assert_eq!(
            failed_destination_platforms("show-1", None, &cloud),
            [StreamPlatform::Youtube]
        );
        // A native snapshot of some other session never answers for the room.
        let native = StreamTargetsSnapshot {
            session_id: "native".into(),
            targets: vec![leg("tw", StreamPlatform::Twitch, StreamTargetState::Failed)],
        };
        assert_eq!(
            failed_destination_platforms("show-1", Some(&native), &cloud),
            [StreamPlatform::Youtube]
        );
        // A local session keeps its own rule.
        assert_eq!(
            failed_destination_platforms("native", Some(&native), &cloud),
            [StreamPlatform::Twitch]
        );
        assert!(failed_destination_platforms("native", None, &cloud).is_empty());
    }

    #[test]
    fn a_go_live_never_takes_the_previous_ended_interval_as_its_own() {
        let identity = CloudServiceIdentity::capture(
            "show-1",
            Some(view("interval-a", true)),
            "device-a",
            "2026-11-16T11:00:00Z",
            &streaming(),
        );
        assert_eq!(identity.live_interval_id, None);
        assert_eq!(
            identity.superseded_interval_id.as_deref(),
            Some("interval-a")
        );
        let legs = [leg("yt", StreamPlatform::Youtube, StreamTargetState::Live)];
        let accounts = accounts();
        // The server still names the old interval: never adopted as ours.
        let mut stale = facts(&legs, &accounts);
        stale.interval = Some(view("interval-a", false));
        let ReattachDecision::Attach { destinations, .. } = plan_reattach(Some(&identity), &stale)
        else {
            panic!("explicit rows expected");
        };
        assert!(
            destinations.is_empty(),
            "the old interval's identity is not ours"
        );
        // The new interval is adopted once the server names it.
        let mut named = facts(&legs, &accounts);
        named.interval = Some(view("interval-b", false));
        let ReattachDecision::Attach {
            destinations,
            identity: adopted,
            ..
        } = plan_reattach(Some(&identity), &named)
        else {
            panic!("attach expected");
        };
        assert_eq!(destinations.len(), 1);
        assert_eq!(adopted.live_interval_id.as_deref(), Some("interval-b"));
        // An ended interval attaches nothing.
        let mut ended = facts(&legs, &accounts);
        ended.interval = Some(view("interval-b", true));
        assert_eq!(
            plan_reattach(Some(&adopted), &ended),
            ReattachDecision::Skip("interval-ended")
        );
    }

    #[test]
    fn x_reattaches_from_its_recorded_broadcast_and_nothing_else() {
        let mut settings = streaming();
        settings
            .targets
            .push(serde_json::from_value(target("xo", "x", "oauth", Some("x-user"))).unwrap());
        settings
            .targets
            .push(serde_json::from_value(target("xk", "x", "manual-rtmp", None)).unwrap());
        settings.enabled_target_ids = vec!["xo".into(), "xk".into()];
        let mut identity = CloudServiceIdentity::capture(
            "show-1",
            None,
            "device-a",
            "2026-11-16T10:00:00Z",
            &settings,
        );
        assert!(CloudServiceIdentity::x_broadcasts(&identity.destinations).is_empty());
        assert!(identity.note_broadcast("xo", "x-broadcast-1"));
        assert!(!identity.note_broadcast("xo", "x-broadcast-1"), "unchanged");
        assert!(!identity.note_broadcast("unknown", "x-broadcast-2"));
        // A stream-key X destination reads no chat even with a broadcast.
        assert!(identity.note_broadcast("xk", "x-broadcast-3"));
        assert_eq!(
            CloudServiceIdentity::x_broadcasts(&identity.destinations),
            [("xo".to_string(), "x-broadcast-1".to_string())]
        );
        let stored = serde_json::to_string(&identity).unwrap();
        let back: CloudServiceIdentity = serde_json::from_str(&stored).unwrap();
        assert_eq!(back, identity, "the broadcast survives a relaunch");
        // With the X account connected here, the X leg reattaches.
        let legs = [leg("xo", StreamPlatform::X, StreamTargetState::Live)];
        let mut accounts = accounts();
        accounts.push(LocalAccount {
            platform: StreamPlatform::X,
            account_id: "x-user".into(),
            id: "row-x".into(),
            has_credentials: true,
        });
        let ReattachDecision::Attach { destinations, .. } =
            plan_reattach(Some(&identity), &facts(&legs, &accounts))
        else {
            panic!("attach expected");
        };
        assert_eq!(
            CloudServiceIdentity::x_broadcasts(&destinations),
            [("xo".to_string(), "x-broadcast-1".to_string())]
        );
        // Without it: an explicit row, never a silent wait.
        let ReattachDecision::Attach { unavailable, .. } =
            plan_reattach(Some(&identity), &facts(&legs, &accounts[..2]))
        else {
            panic!("explicit row expected");
        };
        assert_eq!(
            unavailable[0].reason,
            UnavailableReason::CredentialsOnAnotherDevice
        );
    }

    fn armed(interval: Option<&str>, superseded: Option<&str>) -> ArmedServices {
        ArmedServices {
            show_id: "show-1".into(),
            live_interval_id: interval.map(str::to_string),
            superseded_interval_id: superseded.map(str::to_string),
        }
    }

    fn terminal<'a>(interval: Option<&'a LiveIntervalView>) -> TerminalFacts<'a> {
        TerminalFacts {
            show_id: Some("show-1"),
            show_end_observed: false,
            interval,
            room_reported: true,
            room_live: true,
            stopped_for_continuation: false,
            chat_session_id: Some("show-1"),
        }
    }

    #[test]
    fn a_remote_end_releases_only_the_services_of_its_own_interval() {
        let held = armed(Some("interval-a"), None);
        let released = |reason| TerminalAction::Release {
            show_id: "show-1".into(),
            reason,
        };
        let live = terminal(Some(view("interval-a", false)));
        assert_eq!(plan_terminal(&held, &live), TerminalAction::Keep);
        // Web/phone/quota End: the server confirms this interval ended.
        assert_eq!(
            plan_terminal(&held, &terminal(Some(view("interval-a", true)))),
            released("interval-ended")
        );
        // End then Go Live elsewhere: ours ended even if we missed it.
        assert_eq!(
            plan_terminal(&held, &terminal(Some(view("interval-b", false)))),
            released("interval-replaced")
        );
        // The show ended on the website (or by quota, or the runner).
        let mut gone = live;
        gone.show_id = None;
        gone.interval = None;
        gone.show_end_observed = true;
        assert_eq!(plan_terminal(&held, &gone), released("show-ended"));
        // The launch gap: no show restored yet and no End observed.
        let mut launching = gone;
        launching.show_end_observed = false;
        launching.room_reported = false;
        assert_eq!(plan_terminal(&held, &launching), TerminalAction::Keep);
        // The show restored, its room not resumed yet: nothing is known.
        let mut restored = live;
        restored.interval = None;
        restored.room_reported = false;
        restored.room_live = false;
        restored.chat_session_id = None;
        assert_eq!(plan_terminal(&held, &restored), TerminalAction::Keep);
        // This computer now holds another show.
        let mut other = live;
        other.show_id = Some("show-2");
        assert_eq!(plan_terminal(&held, &other), released("show-replaced"));
        // Handed off or taken over: the existing path stops the readers and
        // the identity stays for a take-back.
        let mut handed = other;
        handed.stopped_for_continuation = true;
        assert_eq!(plan_terminal(&held, &handed), TerminalAction::Keep);
    }

    #[test]
    fn a_stale_end_never_stops_the_successor_go_live() {
        // Armed by a new Go Live while the server still reports the old,
        // ended interval: that End is old news.
        let fresh = armed(None, Some("interval-a"));
        assert_eq!(
            plan_terminal(&fresh, &terminal(Some(view("interval-a", true)))),
            TerminalAction::Keep
        );
        assert_eq!(
            plan_terminal(&fresh, &terminal(Some(view("interval-b", false)))),
            TerminalAction::Keep
        );
        assert_eq!(
            plan_terminal(&fresh, &terminal(Some(view("interval-b", true)))),
            TerminalAction::Release {
                show_id: "show-1".into(),
                reason: "interval-ended"
            }
        );
    }

    #[test]
    fn an_older_server_releases_only_on_an_observed_end_of_running_readers() {
        let held = armed(None, None);
        let mut off_air = terminal(None);
        off_air.room_live = false;
        assert_eq!(
            plan_terminal(&held, &off_air),
            TerminalAction::Release {
                show_id: "show-1".into(),
                reason: "legs-ended"
            }
        );
        // After a relaunch, before the runner reports the room: no guess.
        let mut unreported = off_air;
        unreported.room_reported = false;
        assert_eq!(plan_terminal(&held, &unreported), TerminalAction::Keep);
        // No readers of this show run here: nothing to release yet.
        let mut idle = off_air;
        idle.chat_session_id = None;
        assert_eq!(plan_terminal(&held, &idle), TerminalAction::Keep);
        assert_eq!(plan_terminal(&held, &terminal(None)), TerminalAction::Keep);
    }

    #[test]
    fn the_interval_is_read_from_s16_and_only_a_confirmed_end_ends_it() {
        let mut cloud = cloud_with_room(Vec::new());
        assert_eq!(
            canonical_live_interval(&cloud),
            None,
            "older server: unknown"
        );
        cloud.live_interval = Some(crate::cloud_show::CloudLiveInterval {
            id: "interval-a".into(),
            requested_at: "2026-11-16T10:00:00Z".into(),
            live_since: Some("2026-11-16T10:00:05Z".into()),
            end_requested_at: Some("2026-11-16T11:00:00Z".into()),
            ended_at: None,
        });
        assert_eq!(
            canonical_live_interval(&cloud),
            Some(LiveIntervalView {
                id: "interval-a".into(),
                ended: false
            }),
            "a requested End is pending, not ended"
        );
        cloud.live_interval.as_mut().unwrap().ended_at = Some("2026-11-16T11:00:02Z".into());
        assert!(canonical_live_interval(&cloud).unwrap().ended);
        assert_eq!(
            canonical_live_interval_id(&cloud).as_deref(),
            Some("interval-a")
        );
        cloud.live_interval.as_mut().unwrap().id = "  ".into();
        assert_eq!(canonical_live_interval(&cloud), None);
    }
}
