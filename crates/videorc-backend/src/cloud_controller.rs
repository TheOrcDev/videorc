//! Plan 249 S24: this computer as a managed show's controller.
//!
//! The web keeps one controller per show (`/api/cloud/shows/:id/controller`):
//! a positive `controllerEpoch` that only grows, moved by one compare-and-set
//! per takeover, and a 45 s lease the holder renews. Every managed request
//! this process sends about the show it controls carries the epoch it holds
//! (`videorc-controller-epoch`), and the web refuses one that is no longer
//! current. So a computer that lost the show can never change, and never end,
//! what its successor runs; a relaunched process is a new controller too (the
//! epoch is held in memory only, and Resume takes the show over explicitly).
//!
//! What a takeover keeps and what it never carries over (decision D9):
//! - the accepted public presentation (static layers, the avatar layer) is
//!   kept by the web and read back here, unapplied, to be re-sent under this
//!   controller's own delivery envelope;
//! - one-shots (bubbles, cards, reactions, sounds) are never kept or replayed;
//! - what captured or played on the old computer (camera, microphone,
//!   screen, sounds, system audio, HTML) starts off here and is switched on
//!   explicitly (`needsEnable`);
//! - private Sidekick context and local files never move.
//!
//! Nothing here ends a show, a broadcast, a recording or another computer's
//! readers; S16 owns ends, S18 owns chat ownership.

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex, PoisonError};

use serde::{Deserialize, Serialize};

/// The HTTP status of a cloud failure, as far as the controller rules read it.
pub(crate) fn status_of(error: &crate::cloud_show::CloudApiError) -> u16 {
    use crate::cloud_show::CloudApiError;
    match error {
        CloudApiError::Other { status, .. } => *status,
        CloudApiError::Unauthorized => 401,
        CloudApiError::ShowLive(_) => 409,
        _ => 0,
    }
}

/// The header a controller sends with every request about its show.
pub(crate) const CONTROLLER_EPOCH_HEADER: &str = "videorc-controller-epoch";
/// How often the holder renews its 45 s lease.
pub(crate) const RENEW_EVERY: std::time::Duration = std::time::Duration::from_secs(15);

/// What this process holds: the show and the epoch it was granted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HeldController {
    pub show_id: String,
    pub epoch: u64,
    pub device_id: String,
    /// PNG hashes the web already has for this show (sent once).
    pub sent_hashes: HashSet<String>,
    /// What the takeover answered, for the status and the renderer.
    pub facts: ControllerFacts,
    /// The kept presentation read back after the grant (`GET …/presentation`).
    pub restore: Option<serde_json::Value>,
    /// The web said another device controls the show now. The stale epoch
    /// stays, so the fence keeps refusing this process's commands.
    pub lost: bool,
    /// The last acceptance order handed out under this epoch (see
    /// [`next_sequence`]).
    pub sequence: u64,
}

/// The renderer-facing facts of this computer's controllership.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerFacts {
    pub controller_epoch: u64,
    /// `this-device` (a relaunch) or `another-device`; `None` on a first claim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub taken_over_from: Option<String>,
    /// What the previous controller had switched on, that this one must
    /// switch on itself: camera, microphone, screen, sounds, system, html.
    #[serde(default)]
    pub needs_enable: Vec<String>,
    /// Kept output views read back after the takeover (never applied yet).
    #[serde(default)]
    pub restored_views: u32,
    /// Live desktop sources the kept presentation cleared (the chat box).
    #[serde(default)]
    pub cleared: Vec<String>,
    /// This process lost the show to another device: it controls nothing.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub lost: bool,
}

/// Plan 249 S24: whether this process controls a show, for the services
/// that must stop the moment it does not (S15 captions listening, uploads).
/// Subscribe with [`ownership`]; [`Ownership::controls`] is the only test a
/// service needs before it sends anything about a show.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Ownership {
    /// No managed room show is controlled here (or the web has no
    /// controller route: an older web, unfenced as before S24).
    #[default]
    None,
    /// This process holds `epoch` for `show_id`.
    Held { show_id: String, epoch: u64 },
    /// Another device took `show_id` over; `epoch` is what this one held.
    Lost {
        show_id: String,
        epoch: u64,
        reason: &'static str,
    },
}

impl Ownership {
    /// True only while this process holds `show_id`.
    pub fn controls(&self, show_id: &str) -> bool {
        matches!(self, Ownership::Held { show_id: held, .. } if held == show_id)
    }
}

static OWNERSHIP: LazyLock<tokio::sync::watch::Sender<Ownership>> =
    LazyLock::new(|| tokio::sync::watch::channel(Ownership::None).0);

/// Shows this process has held, latched: a loss after holding never reads
/// as the "never claimed" state again (bounded; one show at a time).
static EVER_HELD: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn ever_held(show_id: &str) -> bool {
    EVER_HELD
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .any(|held| held == show_id)
}

/// Pure: may a service act for `show_id` under `now`, given whether this
/// process ever held it? Held for it: yes. Lost: no. `None` before it was
/// ever held (no controller route, a solo node show, a claim not answered
/// yet): the service's own policy decides (`true` here). `None` after it was
/// held (forgotten, ended), or another show held: no.
pub fn ownership_allows_with(now: &Ownership, show_id: &str, ever_held: bool) -> bool {
    match now {
        Ownership::Held { show_id: held, .. } => held == show_id,
        Ownership::Lost { .. } => false,
        Ownership::None => !ever_held,
    }
}

/// The synchronous gate for services (S15 captions admission and every
/// provider send): closes the gap between the watch publishing a loss and a
/// watcher task running.
pub fn ownership_allows(show_id: &str) -> bool {
    ownership_allows_with(&ownership_now(), show_id, ever_held(show_id))
}

/// A receiver that sees every change of this process's controllership.
pub fn ownership() -> tokio::sync::watch::Receiver<Ownership> {
    OWNERSHIP.subscribe()
}

/// What this process controls right now.
pub fn ownership_now() -> Ownership {
    OWNERSHIP.borrow().clone()
}

fn announce(next: Ownership) {
    OWNERSHIP.send_if_modified(|current| {
        let changed = *current != next;
        *current = next;
        changed
    });
}

static HELD: Mutex<Option<HeldController>> = Mutex::new(None);

fn held() -> std::sync::MutexGuard<'static, Option<HeldController>> {
    HELD.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Records the grant; replaces whatever was held (one show at a time).
pub(crate) fn hold(show_id: &str, device_id: &str, facts: ControllerFacts) {
    let mut held = held();
    let sent_hashes = held
        .as_ref()
        .filter(|current| current.show_id == show_id)
        .map(|current| current.sent_hashes.clone())
        .unwrap_or_default();
    *held = Some(HeldController {
        show_id: show_id.to_string(),
        epoch: facts.controller_epoch,
        device_id: device_id.to_string(),
        sent_hashes,
        facts,
        restore: None,
        lost: false,
        sequence: 0,
    });
    {
        let mut ever = EVER_HELD.lock().unwrap_or_else(PoisonError::into_inner);
        if !ever.iter().any(|held| held == show_id) {
            if ever.len() >= 16 {
                ever.remove(0);
            }
            ever.push(show_id.to_string());
        }
    }
    announce(Ownership::Held {
        show_id: show_id.to_string(),
        epoch: held.as_ref().map_or(0, |current| current.epoch),
    });
}

/// Keeps what the grant read back, while `epoch` is still what is held.
pub(crate) fn set_restore(
    show_id: &str,
    epoch: u64,
    restore: serde_json::Value,
    facts: ControllerFacts,
) {
    if let Some(current) = held()
        .as_mut()
        .filter(|current| current.show_id == show_id && current.epoch == epoch && !current.lost)
    {
        current.restore = Some(restore);
        current.facts = facts;
    }
}

/// Lets go of `show_id` (empty: of anything held). Returns what was held.
pub(crate) fn forget(show_id: &str) -> Option<HeldController> {
    let mut held = held();
    if held
        .as_ref()
        .is_some_and(|current| show_id.is_empty() || current.show_id == show_id)
    {
        let taken = held.take();
        announce(Ownership::None);
        taken
    } else {
        None
    }
}

/// The web answered that `epoch` is no longer current (a renewal or a fenced
/// request refused as stale, or the lease held by another device). Keeps the
/// stale epoch for the fence and tells every service. Returns whether this
/// changed anything (`false` for an epoch this process no longer holds).
pub(crate) fn mark_lost(epoch: u64, reason: &'static str) -> bool {
    let mut held = held();
    let Some(current) = held
        .as_mut()
        .filter(|current| current.epoch == epoch && !current.lost)
    else {
        return false;
    };
    current.lost = true;
    current.facts.lost = true;
    announce(Ownership::Lost {
        show_id: current.show_id.clone(),
        epoch,
        reason,
    });
    true
}

/// A copy of what is held for `show_id`, while this process still controls
/// it (a lost show is not held: nothing more is renewed, kept or sent).
pub(crate) fn held_for(show_id: &str) -> Option<HeldController> {
    held()
        .as_ref()
        .filter(|current| current.show_id == show_id && !current.lost)
        .cloned()
}

/// The renderer-facing facts for `show_id` (`lost` once another device took
/// it over).
pub(crate) fn facts_for(show_id: &str) -> Option<ControllerFacts> {
    held()
        .as_ref()
        .filter(|current| current.show_id == show_id)
        .map(|current| current.facts.clone())
}

/// The next acceptance order for a kept view of `show_id`, with what is
/// held, taken in the order the renderer's acknowledgements arrive. The web
/// orders kept views by it within the epoch, so a write that finishes late
/// (or comes from an older LiveKit session) never replaces a newer one.
/// `None` once this process no longer controls the show.
pub(crate) fn next_sequence(show_id: &str) -> Option<(HeldController, u64)> {
    let mut held = held();
    let current = held
        .as_mut()
        .filter(|current| current.show_id == show_id && !current.lost)?;
    current.sequence += 1;
    Some((current.clone(), current.sequence))
}

pub(crate) fn note_sent_hashes(show_id: &str, epoch: u64, hashes: &[String]) {
    if let Some(current) = held()
        .as_mut()
        .filter(|current| current.show_id == show_id && current.epoch == epoch)
    {
        current.sent_hashes.extend(hashes.iter().cloned());
    }
}

/// Pure: the epoch a request to `path` carries under `held`: only requests
/// about the held show (`/api/cloud/shows/<id>` and below).
pub(crate) fn fence_epoch(held: Option<&HeldController>, path: &str) -> Option<u64> {
    let held = held?;
    let rest = path
        .trim_start_matches('/')
        .strip_prefix("api/cloud/shows/")?;
    let show = rest.split(['/', '?']).next()?;
    (show == held.show_id).then_some(held.epoch)
}

/// The epoch header for a request to `path`, from what this process holds.
pub(crate) fn fence_header_for(path: &str) -> Option<u64> {
    fence_epoch(held().as_ref(), path)
}

/// One controller request body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ControllerIntent {
    Claim,
    Renew(u64),
    Takeover(u64),
}

pub(crate) fn intent_body(device_id: &str, intent: ControllerIntent) -> serde_json::Value {
    let (name, epoch) = match intent {
        ControllerIntent::Claim => ("claim", None),
        ControllerIntent::Renew(epoch) => ("renew", Some(epoch)),
        ControllerIntent::Takeover(epoch) => ("takeover", Some(epoch)),
    };
    let mut body = serde_json::json!({ "device": { "id": device_id }, "intent": name });
    if let Some(epoch) = epoch {
        body["epoch"] = serde_json::json!(epoch);
    }
    body
}

/// The web's controller answer (`controller` in the body, also on a 409).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControllerAnswer {
    pub controller_epoch: u64,
    #[serde(default)]
    pub taken_over_from: Option<String>,
    #[serde(default)]
    pub needs_enable: Vec<String>,
}

/// Pure: what a claim attempt leads to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ClaimStep {
    /// Granted: hold this epoch.
    Granted(ControllerAnswer),
    /// Send this next (an explicit resume takes over a held show).
    Next(ControllerIntent),
    /// A command of the old controller is still running on the web: the
    /// takeover waits for it (it lands before the epoch moves), then sends
    /// the same intent again.
    Wait(ControllerIntent),
    /// Stop: the show is ending/over, or the web has no controller route
    /// (an older web: run as before S24, without a fence).
    Stop(&'static str),
}

/// Pure: the next step of `resume` (`true`: the streamer asked to continue
/// here, which may take the show; `false`: a plain claim, which never does)
/// after the answer `(status, code, controller)` to `sent`.
pub(crate) fn next_claim_step(
    resume: bool,
    sent: ControllerIntent,
    status: u16,
    code: &str,
    controller: Option<ControllerAnswer>,
) -> ClaimStep {
    if (200..300).contains(&status) {
        return match controller {
            Some(answer) => ClaimStep::Granted(answer),
            None => ClaimStep::Stop("malformed-answer"),
        };
    }
    match (status, code, controller) {
        (409, "cloud-show-ending" | "cloud-show-ended", _) => ClaimStep::Stop("show-ending"),
        (409, "cloud-controller-busy", _) if resume => ClaimStep::Wait(sent),
        (409, "cloud-controller-busy", _) => ClaimStep::Stop("held-elsewhere"),
        (404, _, _) | (405, _, _) => ClaimStep::Stop("no-controller-route"),
        // Held by another process (or this computer's earlier one): only an
        // explicit resume takes it, and only from the epoch just read.
        (409, "cloud-controller-held", Some(current)) if resume => {
            ClaimStep::Next(ControllerIntent::Takeover(current.controller_epoch))
        }
        (409, "cloud-controller-held", _) => ClaimStep::Stop("held-elsewhere"),
        // Another takeover won the race, or this process's own epoch is
        // old (it lost the show and the streamer resumes here): take it from
        // the epoch just read.
        (409, "cloud-controller-stale", Some(current))
            if resume
                && matches!(
                    sent,
                    ControllerIntent::Takeover(_) | ControllerIntent::Renew(_)
                ) =>
        {
            ClaimStep::Next(ControllerIntent::Takeover(current.controller_epoch))
        }
        (409, "cloud-controller-stale", _) => ClaimStep::Stop("stale"),
        _ => ClaimStep::Stop("refused"),
    }
}

/// Pure: the renderer facts of a grant plus what the restore read back.
pub(crate) fn facts_of(
    answer: &ControllerAnswer,
    restore: Option<&serde_json::Value>,
) -> ControllerFacts {
    let views = restore
        .and_then(|value| value.get("views"))
        .and_then(serde_json::Value::as_array);
    let mut cleared: Vec<String> = views
        .into_iter()
        .flatten()
        .filter_map(|view| view.get("cleared").and_then(serde_json::Value::as_array))
        .flatten()
        .filter_map(|layer| layer.get("kind").and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .collect();
    cleared.sort();
    cleared.dedup();
    ControllerFacts {
        controller_epoch: answer.controller_epoch,
        taken_over_from: answer.taken_over_from.clone(),
        needs_enable: answer
            .needs_enable
            .iter()
            .filter(|key| ENABLES.contains(&key.as_str()))
            .cloned()
            .collect(),
        restored_views: views.map_or(0, |views| u32::try_from(views.len()).unwrap_or(u32::MAX)),
        cleared,
        lost: false,
    }
}

/// What a controller can have switched on, in the web's order.
pub(crate) const ENABLES: [&str; 6] =
    ["sounds", "system", "html", "camera", "microphone", "screen"];

/// Pure: a renderer's accepted view as the web's ingest body, with the PNG of
/// every hash the web already has removed (it is sent once per show).
pub(crate) fn ingest_body(
    epoch: u64,
    sequence: u64,
    view: &serde_json::Value,
    sent: &HashSet<String>,
) -> Option<(serde_json::Value, Vec<String>)> {
    let mut body = view.clone();
    let object = body.as_object_mut()?;
    object.remove("showId");
    object.insert("controllerEpoch".to_string(), serde_json::json!(epoch));
    object.insert("sequence".to_string(), serde_json::json!(sequence));
    let mut carried = Vec::new();
    for layer in object.get_mut("layers")?.as_array_mut()?.iter_mut() {
        let Some(asset) = layer
            .get_mut("asset")
            .and_then(serde_json::Value::as_object_mut)
        else {
            continue;
        };
        let Some(hash) = asset
            .get("hash")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        if sent.contains(&hash) {
            asset.remove("png");
        } else if asset.contains_key("png") {
            carried.push(hash);
        }
    }
    Some((body, carried))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHOW: &str = "sh_0123456789abcdefghijkl";

    fn held_for_test(epoch: u64) -> HeldController {
        HeldController {
            show_id: SHOW.to_string(),
            epoch,
            device_id: "AAAAAAAAAAAAAAAAAAAAAA".to_string(),
            sent_hashes: HashSet::new(),
            facts: ControllerFacts {
                controller_epoch: epoch,
                ..ControllerFacts::default()
            },
            restore: None,
            lost: false,
            sequence: 0,
        }
    }

    #[test]
    fn services_act_only_while_held_and_never_again_after_a_loss() {
        let held = Ownership::Held {
            show_id: SHOW.to_string(),
            epoch: 2,
        };
        let lost = Ownership::Lost {
            show_id: SHOW.to_string(),
            epoch: 2,
            reason: "taken-over",
        };
        assert!(ownership_allows_with(&held, SHOW, true));
        assert!(!ownership_allows_with(&held, "sh_other", false));
        assert!(!ownership_allows_with(&lost, SHOW, true));
        // Never claimed here: the service's own policy (pre-S24) decides.
        assert!(ownership_allows_with(&Ownership::None, SHOW, false));
        // Held once, then nothing: latched off.
        assert!(!ownership_allows_with(&Ownership::None, SHOW, true));
    }

    #[test]
    fn only_requests_about_the_held_show_carry_its_epoch() {
        let held = held_for_test(4);
        assert_eq!(
            fence_epoch(Some(&held), &format!("/api/cloud/shows/{SHOW}/end")),
            Some(4)
        );
        assert_eq!(
            fence_epoch(Some(&held), &format!("/api/cloud/shows/{SHOW}")),
            Some(4)
        );
        assert_eq!(
            fence_epoch(
                Some(&held),
                &format!("/api/cloud/shows/{SHOW}/state?since=3")
            ),
            Some(4)
        );
        assert_eq!(
            fence_epoch(Some(&held), "/api/cloud/shows/sh_another/end"),
            None
        );
        assert_eq!(fence_epoch(Some(&held), "/api/cloud/shows"), None);
        assert_eq!(fence_epoch(Some(&held), "/api/cloud/current"), None);
        assert_eq!(
            fence_epoch(None, &format!("/api/cloud/shows/{SHOW}/end")),
            None
        );
    }

    fn answer(epoch: u64) -> Option<ControllerAnswer> {
        Some(ControllerAnswer {
            controller_epoch: epoch,
            ..ControllerAnswer::default()
        })
    }

    #[test]
    fn only_an_explicit_resume_takes_a_held_show_and_never_an_ending_one() {
        use ControllerIntent::{Claim, Takeover};
        assert_eq!(
            next_claim_step(true, Claim, 200, "", answer(1)),
            ClaimStep::Granted(answer(1).unwrap())
        );
        // A plain claim never steals; a resume takes over from the epoch read.
        assert_eq!(
            next_claim_step(false, Claim, 409, "cloud-controller-held", answer(3)),
            ClaimStep::Stop("held-elsewhere")
        );
        assert_eq!(
            next_claim_step(true, Claim, 409, "cloud-controller-held", answer(3)),
            ClaimStep::Next(Takeover(3))
        );
        // Lost a takeover race: try once more from the winner's epoch.
        assert_eq!(
            next_claim_step(true, Takeover(3), 409, "cloud-controller-stale", answer(4)),
            ClaimStep::Next(Takeover(4))
        );
        // This process lost the show earlier; Resume here takes it back.
        assert_eq!(
            next_claim_step(
                true,
                ControllerIntent::Renew(2),
                409,
                "cloud-controller-stale",
                answer(5)
            ),
            ClaimStep::Next(Takeover(5))
        );
        assert_eq!(
            next_claim_step(
                false,
                ControllerIntent::Renew(2),
                409,
                "cloud-controller-stale",
                answer(5)
            ),
            ClaimStep::Stop("stale")
        );
        // The old controller's last command is still running: wait, resend.
        assert_eq!(
            next_claim_step(true, Takeover(3), 409, "cloud-controller-busy", answer(3)),
            ClaimStep::Wait(Takeover(3))
        );
        assert_eq!(
            next_claim_step(false, Claim, 409, "cloud-controller-busy", answer(3)),
            ClaimStep::Stop("held-elsewhere")
        );
        assert_eq!(
            next_claim_step(true, Claim, 409, "cloud-show-ending", None),
            ClaimStep::Stop("show-ending")
        );
        // An older web without the route: no fence, as before S24.
        assert_eq!(
            next_claim_step(true, Claim, 404, "", None),
            ClaimStep::Stop("no-controller-route")
        );
    }

    #[test]
    fn a_takeover_names_what_to_switch_on_and_what_was_cleared() {
        let granted = ControllerAnswer {
            controller_epoch: 5,
            taken_over_from: Some("another-device".to_string()),
            needs_enable: vec![
                "microphone".to_string(),
                "sounds".to_string(),
                "private-sidekick".to_string(),
            ],
        };
        let restore = serde_json::json!({
            "views": [
                { "topic": "static", "cleared": [{ "id": "chat", "kind": "chat" }] },
                { "topic": "avatar", "cleared": [] }
            ]
        });
        let facts = facts_of(&granted, Some(&restore));
        assert_eq!(facts.controller_epoch, 5);
        assert_eq!(facts.taken_over_from.as_deref(), Some("another-device"));
        assert_eq!(facts.needs_enable, vec!["microphone", "sounds"]);
        assert_eq!(facts.restored_views, 2);
        assert_eq!(facts.cleared, vec!["chat"]);
    }

    #[test]
    fn pixels_go_once_per_show_and_the_body_names_the_epoch() {
        let view = serde_json::json!({
            "showId": SHOW,
            "topic": "avatar",
            "layers": [
                { "kind": "avatar", "asset": { "hash": "aa", "png": "AAAA" } },
                { "kind": "avatar", "asset": { "hash": "bb", "png": "BBBB" } }
            ]
        });
        let sent: HashSet<String> = ["aa".to_string()].into_iter().collect();
        let (body, carried) = ingest_body(7, 3, &view, &sent).unwrap();
        assert_eq!(body["controllerEpoch"], 7);
        assert_eq!(body["sequence"], 3);
        assert!(body.get("showId").is_none());
        assert!(body["layers"][0]["asset"].get("png").is_none());
        assert_eq!(body["layers"][1]["asset"]["png"], "BBBB");
        assert_eq!(carried, vec!["bb"]);
        assert_eq!(
            intent_body("AAAAAAAAAAAAAAAAAAAAAA", ControllerIntent::Takeover(2)),
            serde_json::json!({
                "device": { "id": "AAAAAAAAAAAAAAAAAAAAAA" },
                "intent": "takeover",
                "epoch": 2
            })
        );
        assert_eq!(
            intent_body("AAAAAAAAAAAAAAAAAAAAAA", ControllerIntent::Claim),
            serde_json::json!({ "device": { "id": "AAAAAAAAAAAAAAAAAAAAAA" }, "intent": "claim" })
        );
    }

    // The only test that touches the process-global holder.
    #[test]
    fn a_lost_show_keeps_its_stale_fence_and_tells_every_service() {
        let mut watch = ownership();
        let facts = ControllerFacts {
            controller_epoch: 3,
            ..ControllerFacts::default()
        };
        hold(SHOW, "AAAAAAAAAAAAAAAAAAAAAA", facts);
        assert!(ownership_now().controls(SHOW));
        // Acceptance order only grows within the epoch.
        assert_eq!(next_sequence(SHOW).map(|(_, n)| n), Some(1));
        assert_eq!(next_sequence(SHOW).map(|(_, n)| n), Some(2));
        assert!(watch.has_changed().unwrap());
        watch.mark_unchanged();
        // An epoch this process does not hold changes nothing.
        assert!(!mark_lost(2, "stale-command"));
        assert!(!watch.has_changed().unwrap());
        assert!(mark_lost(3, "taken-over"));
        assert_eq!(
            ownership_now(),
            Ownership::Lost {
                show_id: SHOW.to_string(),
                epoch: 3,
                reason: "taken-over"
            }
        );
        assert!(!ownership_now().controls(SHOW));
        assert!(watch.has_changed().unwrap());
        // Nothing is renewed, kept or sent for it any more, but its requests
        // still carry the stale epoch, so the web keeps refusing them.
        assert!(held_for(SHOW).is_none());
        assert!(next_sequence(SHOW).is_none(), "nothing is kept once lost");
        assert!(facts_for(SHOW).is_some_and(|facts| facts.lost));
        assert_eq!(
            fence_header_for(&format!("/api/cloud/shows/{SHOW}/end")),
            Some(3)
        );
        assert!(!mark_lost(3, "taken-over"), "announced once");
        forget(SHOW);
        assert_eq!(ownership_now(), Ownership::None);
        // Latched: once held, `None` never reads as "never claimed" again.
        assert!(!ownership_allows(SHOW));
        assert_eq!(
            fence_header_for(&format!("/api/cloud/shows/{SHOW}/end")),
            None
        );
    }
}
