//! Plan 249 S24: this computer as a managed show's controller.
//!
//! The web keeps one controller per show (`/api/cloud/shows/:id/controller`):
//! a positive `controllerEpoch` that only grows, moved by one compare-and-set
//! per takeover, and a 45 s lease the holder renews. Every managed request
//! this process sends about the show it controls carries the epoch it holds
//! (`videorc-controller-epoch`), and the web refuses one that is no longer
//! current. So a computer that lost the show can never change, and never end,
//! what its successor runs.
//!
//! A restarted process of the same computer is the same controller: the
//! epoch it was granted is kept in the settings ([`KeptController`]) and the
//! restarted process renews it (the web renews for the same device and epoch,
//! lapsed lease or not). Before 2026-11-19 the epoch lived in memory only, so
//! a backend restart in the middle of a live show left this computer refused
//! (`cloud-controller-required`, `cloud-controller-held`) by its own show, and
//! "Continue here" had to take the show over from itself, which switched the
//! camera and the microphone off like a takeover from another computer.
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
    #[cfg(test)]
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

/// Pure: the show a request to `path` is about, when the controller fence
/// applies to it. The controller route itself is never held back: it is the
/// request the others wait for.
fn fenced_show(path: &str) -> Option<&str> {
    let rest = path
        .trim_start_matches('/')
        .strip_prefix("api/cloud/shows/")?;
    let mut parts = rest.split(['/', '?']);
    let show = parts.next().filter(|show| !show.is_empty())?;
    (parts.next() != Some("controller")).then_some(show)
}

/// How long a request waits for a claim that never answers. The claim's own
/// requests time out on their own; this only bounds the wait, so a claim
/// that is never made (signed out, the show gone) holds nothing for good.
pub(crate) const RENEWAL_WAIT: std::time::Duration = std::time::Duration::from_secs(15);

/// Plan 254 S6: the window between a backend start and its controller
/// claim. A restarted process holds no epoch until its kept one is renewed
/// (`first_intent`), so a write it sends about its own show in that window
/// carries no epoch and the web refuses it (`cloud-controller-required`; on
/// 2026-11-19 the Discord announcement claim went out in the same
/// millisecond as the renewal). While a claim for a show is awaited, writes
/// about that show wait for it here, for at most [`RENEWAL_WAIT`].
pub(crate) struct RenewalGate {
    /// The show whose claim is awaited, and when the wait for it runs out.
    awaited: tokio::sync::watch::Sender<Option<(String, tokio::time::Instant)>>,
}

impl RenewalGate {
    pub(crate) fn new() -> Self {
        Self {
            awaited: tokio::sync::watch::channel(None).0,
        }
    }

    /// A claim for `show_id` is coming (a kept record read at start) or in
    /// flight: writes about the show wait from now.
    pub(crate) fn expect(&self, show_id: &str) {
        self.awaited.send_replace(Some((
            show_id.to_string(),
            tokio::time::Instant::now() + RENEWAL_WAIT,
        )));
    }

    /// The claim for `show_id` answered, whatever it answered (empty: any).
    pub(crate) fn settle(&self, show_id: &str) {
        self.awaited.send_if_modified(|awaited| {
            let ours = awaited
                .as_ref()
                .is_some_and(|(show, _)| show_id.is_empty() || show == show_id);
            if ours {
                *awaited = None;
            }
            ours
        });
    }

    /// When the wait for `show_id`'s claim runs out; `None` when no claim
    /// for it is awaited (or the wait already ran out).
    fn deadline(&self, show_id: &str) -> Option<tokio::time::Instant> {
        self.awaited
            .borrow()
            .as_ref()
            .filter(|(show, deadline)| show == show_id && *deadline > tokio::time::Instant::now())
            .map(|(_, deadline)| *deadline)
    }

    /// Whether a claim for the show `path` is about is awaited right now.
    #[cfg(test)]
    pub(crate) fn awaits(&self, path: &str) -> bool {
        fenced_show(path).is_some_and(|show| self.deadline(show).is_some())
    }

    /// Waits until the claim for the show `path` is about has answered, or
    /// its wait ran out. Returns at once for any other path, for the
    /// controller route, and when nothing is awaited. Never waits longer
    /// than [`RENEWAL_WAIT`] past the claim's start, so a claim that fails,
    /// hangs or is never made delays a request and never blocks it.
    pub(crate) async fn settled(&self, path: &str) {
        let Some(show) = fenced_show(path) else {
            return;
        };
        let mut watch = self.awaited.subscribe();
        while let Some(deadline) = self.deadline(show) {
            if tokio::time::timeout_at(deadline, watch.changed())
                .await
                .is_err()
            {
                return;
            }
        }
    }
}

static RENEWAL: LazyLock<RenewalGate> = LazyLock::new(RenewalGate::new);

/// The gate every cloud request of this process passes (`cloud_send`).
pub(crate) fn renewal_gate() -> &'static RenewalGate {
    &RENEWAL
}

/// Settles the claim for its show when dropped, so no return path of a claim
/// leaves requests waiting.
pub(crate) struct RenewalInFlight(String);

impl Drop for RenewalInFlight {
    fn drop(&mut self) {
        RENEWAL.settle(&self.0);
    }
}

/// A claim for `show_id` starts: writes about the show wait until the
/// returned guard drops.
pub(crate) fn renewal_in_flight(show_id: &str) -> RenewalInFlight {
    RENEWAL.expect(show_id);
    RenewalInFlight(show_id.to_string())
}

/// The setting that keeps this computer's controllership across a restart.
pub(crate) const KEPT_CONTROLLER_KEY: &str = "cloud.controller.kept";

/// What a restarted process of this computer needs to stay the controller it
/// was: the show, the epoch it was granted, and the device that was granted
/// it. No secret: the epoch means nothing without this account's session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeptController {
    pub show_id: String,
    pub epoch: u64,
    pub device_id: String,
}

/// Pure: what a claim for `show_id` sends first. An epoch held in memory is
/// renewed; so is one kept from before a restart, for the same show and
/// device; anything else is a plain claim.
pub(crate) fn first_intent(
    held: Option<&HeldController>,
    kept: Option<&KeptController>,
    show_id: &str,
    device_id: &str,
) -> ControllerIntent {
    if let Some(held) = held.filter(|held| held.show_id == show_id && !held.lost) {
        return ControllerIntent::Renew(held.epoch);
    }
    match kept {
        Some(kept) if kept.show_id == show_id && kept.device_id == device_id && kept.epoch > 0 => {
            ControllerIntent::Renew(kept.epoch)
        }
        _ => ControllerIntent::Claim,
    }
}

/// How one claim ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClaimRun {
    /// The grant, or why not.
    pub outcome: Result<ControllerAnswer, &'static str>,
    /// The web refused the kept epoch as stale: another computer took the
    /// show since, so the kept record is dead whatever the outcome.
    pub kept_refused: bool,
}

/// Runs one claim to its answer: `first`, then what [`next_claim_step`] says.
/// `send` posts one body to the controller route and answers the HTTP status
/// with the body. `kept` says `first` renews an epoch kept from before a
/// restart; when the web calls a kept epoch stale, an explicit resume goes
/// on as a process without one would, and a plain claim stops.
pub(crate) async fn run_claim<Send, Answer>(
    resume: bool,
    device_id: &str,
    first: ControllerIntent,
    kept: bool,
    mut send: Send,
) -> ClaimRun
where
    Send: FnMut(serde_json::Value) -> Answer,
    Answer: std::future::Future<Output = (u16, serde_json::Value)>,
{
    let mut intent = first;
    let mut reclaiming = kept;
    let mut kept_refused = false;
    // Three decisions (claim, takeover, a lost race), one more when a kept
    // epoch is tried first, and up to ten 1 s waits while the old
    // controller's last command finishes on the web.
    let max_decisions = if kept { 4 } else { 3 };
    let (mut decisions, mut waits) = (0, 0);
    while decisions < max_decisions && waits <= 10 {
        let (status, answer) = send(intent_body(device_id, intent)).await;
        let code = answer
            .pointer("/error/code")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
        let controller = answer
            .get("controller")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok());
        let step = next_claim_step(resume, intent, status, &code, controller);
        let kept_stale = reclaiming && status == 409 && code == "cloud-controller-stale";
        reclaiming = false;
        if kept_stale {
            kept_refused = true;
            // The web named no controller to take over from (the show's
            // controller row is new): an explicit resume claims it. A plain
            // claim stops here; it never moves a show this process only
            // remembers holding.
            if resume && matches!(step, ClaimStep::Stop(_)) {
                intent = ControllerIntent::Claim;
                decisions += 1;
                continue;
            }
        }
        match step {
            ClaimStep::Granted(granted) => {
                return ClaimRun {
                    outcome: Ok(granted),
                    kept_refused,
                };
            }
            ClaimStep::Next(next) => {
                intent = next;
                decisions += 1;
            }
            ClaimStep::Wait(same) => {
                intent = same;
                waits += 1;
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
            ClaimStep::Stop(reason) => {
                return ClaimRun {
                    outcome: Err(reason),
                    kept_refused,
                };
            }
        }
    }
    ClaimRun {
        outcome: Err("raced"),
        kept_refused,
    }
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

    const DEVICE: &str = "AAAAAAAAAAAAAAAAAAAAAA";
    const OTHER_DEVICE: &str = "BBBBBBBBBBBBBBBBBBBBBB";

    /// The web's controller rules, as `decideController` and
    /// `controllerAnswer` state them (videorcweb `lib/cloud/media/controller.ts`):
    /// a 45 s lease; a claim of a live lease is refused as held, even for the
    /// device that holds it; a renewal needs the same epoch and device and
    /// ignores the lease; a takeover needs the current epoch, moves it by one
    /// and switches off what the old controller had on.
    #[derive(Default)]
    struct FakeWeb {
        now: u64,
        epoch: u64,
        device: String,
        lease_until: u64,
        previous_device: Option<String>,
        enabled: Vec<String>,
        previous_enabled: Vec<String>,
        intents: Vec<String>,
    }

    impl FakeWeb {
        fn answer_for(&self, device: &str) -> serde_json::Value {
            let this_device = self.device == device;
            serde_json::json!({
                "controllerEpoch": self.epoch,
                "thisDevice": this_device,
                "leaseLive": self.lease_until > self.now,
                "takenOverFrom": self.previous_device.as_deref().map(|previous| {
                    if previous == device { "this-device" } else { "another-device" }
                }),
                "needsEnable": if this_device { self.previous_enabled.clone() } else { Vec::new() },
            })
        }

        fn refuse(&self, device: &str, code: &str) -> (u16, serde_json::Value) {
            let controller = (self.epoch > 0).then(|| self.answer_for(device));
            (
                409,
                serde_json::json!({ "controller": controller, "error": { "code": code } }),
            )
        }

        fn take(&mut self, device: &str) -> (u16, serde_json::Value) {
            self.previous_device = (self.epoch > 0).then(|| self.device.clone());
            self.previous_enabled = std::mem::take(&mut self.enabled);
            self.epoch += 1;
            self.device = device.to_string();
            self.lease_until = self.now + 45;
            (
                200,
                serde_json::json!({ "controller": self.answer_for(device) }),
            )
        }

        fn post(&mut self, body: &serde_json::Value) -> (u16, serde_json::Value) {
            let device = body["device"]["id"].as_str().unwrap().to_string();
            let intent = body["intent"].as_str().unwrap().to_string();
            let epoch = body["epoch"].as_u64();
            self.intents.push(intent.clone());
            match intent.as_str() {
                "claim" if self.epoch > 0 && self.lease_until > self.now => {
                    self.refuse(&device, "cloud-controller-held")
                }
                "claim" => self.take(&device),
                "takeover" if epoch == Some(self.epoch) => self.take(&device),
                "renew" if epoch == Some(self.epoch) && device == self.device => {
                    self.lease_until = self.now + 45;
                    (
                        200,
                        serde_json::json!({ "controller": self.answer_for(&device) }),
                    )
                }
                _ => self.refuse(&device, "cloud-controller-stale"),
            }
        }
    }

    /// One claim of this process against the fake web.
    async fn claim(
        web: &std::cell::RefCell<FakeWeb>,
        device: &str,
        kept: Option<&KeptController>,
        resume: bool,
    ) -> ClaimRun {
        let first = first_intent(None, kept, SHOW, device);
        let reclaiming = matches!(first, ControllerIntent::Renew(_));
        run_claim(resume, device, first, reclaiming, |body| {
            let answer = web.borrow_mut().post(&body);
            async move { answer }
        })
        .await
    }

    /// The kept record as a restarted process reads it: through the settings
    /// table, which is all that survives the restart.
    fn kept_after_restart(
        database: &crate::storage::Database,
        granted: &ControllerAnswer,
    ) -> Option<KeptController> {
        database
            .save_setting(
                KEPT_CONTROLLER_KEY,
                &Some(KeptController {
                    show_id: SHOW.to_string(),
                    epoch: granted.controller_epoch,
                    device_id: DEVICE.to_string(),
                }),
            )
            .unwrap();
        database
            .load_setting::<Option<KeptController>>(KEPT_CONTROLLER_KEY)
            .unwrap()
            .flatten()
    }

    #[tokio::test]
    async fn a_backend_restart_mid_show_keeps_the_controller_and_continue_here_takes_nothing_over()
    {
        // Live talk show, 2026-11-19: the backend recycled at 14:21:19 and
        // came back 30 s later, inside its own 45 s lease.
        let web = std::cell::RefCell::new(FakeWeb::default());
        let database = crate::storage::Database::open_in_memory_for_tests();

        // The room opens: a first claim, then the camera and microphone go on.
        let opened = claim(&web, DEVICE, None, false).await;
        let granted = opened.outcome.expect("the first claim is granted");
        assert_eq!(granted.controller_epoch, 1);
        web.borrow_mut().enabled = vec!["camera".to_string(), "microphone".to_string()];
        let kept = kept_after_restart(&database, &granted);

        // The backend restarts mid-show: nothing is held in memory, the lease
        // of the dead process is still live.
        web.borrow_mut().now += 30;
        web.borrow_mut().intents.clear();

        // Without the kept epoch (0.32.1) this computer is a stranger to its
        // own show: a plain claim is refused for as long as the lease lives.
        let stranger = claim(&web, DEVICE, None, false).await;
        assert_eq!(stranger.outcome, Err("held-elsewhere"));

        // With it, the restarted process renews what it held.
        assert_eq!(
            first_intent(None, kept.as_ref(), SHOW, DEVICE),
            ControllerIntent::Renew(1)
        );
        let reclaimed = claim(&web, DEVICE, kept.as_ref(), false).await;
        assert!(!reclaimed.kept_refused);
        assert_eq!(
            reclaimed
                .outcome
                .as_ref()
                .map(|answer| answer.controller_epoch),
            Ok(1)
        );

        // "Continue here": the same controller again. Nothing is taken over,
        // so nothing that captures is switched off.
        let continued = claim(&web, DEVICE, kept.as_ref(), true).await;
        let answer = continued.outcome.expect("Continue here is granted");
        let facts = facts_of(&answer, None);
        assert_eq!(facts.controller_epoch, 1, "the epoch never moved");
        assert_eq!(facts.taken_over_from, None, "not a takeover");
        assert!(
            facts.needs_enable.is_empty(),
            "camera and microphone stay on"
        );
        let web = web.borrow();
        assert_eq!(web.epoch, 1);
        assert_eq!(web.enabled, ["camera", "microphone"]);
        assert_eq!(
            web.intents,
            ["claim", "renew", "renew"],
            "the restarted process never sends a takeover"
        );
    }

    #[tokio::test]
    async fn without_a_kept_epoch_continue_here_takes_the_show_over_from_itself() {
        // What 0.32.1 did after its backend restarted: the takeover moved
        // the epoch and switched the camera and the microphone off, like a
        // takeover from another computer.
        let web = std::cell::RefCell::new(FakeWeb::default());
        claim(&web, DEVICE, None, false).await.outcome.unwrap();
        web.borrow_mut().enabled = vec!["camera".to_string(), "microphone".to_string()];
        web.borrow_mut().now += 30;

        let continued = claim(&web, DEVICE, None, true).await;
        let facts = facts_of(&continued.outcome.unwrap(), None);
        assert_eq!(facts.controller_epoch, 2);
        assert_eq!(facts.taken_over_from.as_deref(), Some("this-device"));
        assert_eq!(facts.needs_enable, ["camera", "microphone"]);
        assert!(web.borrow().enabled.is_empty());
    }

    #[tokio::test]
    async fn a_kept_epoch_another_computer_took_is_dropped_and_continue_here_takes_the_show_back() {
        let web = std::cell::RefCell::new(FakeWeb::default());
        let database = crate::storage::Database::open_in_memory_for_tests();
        let granted = claim(&web, DEVICE, None, false).await.outcome.unwrap();
        let kept = kept_after_restart(&database, &granted);

        // Another computer continues the show while this one is down.
        let other = claim(&web, OTHER_DEVICE, None, true).await;
        assert_eq!(other.outcome.unwrap().controller_epoch, 2);

        // Back up: the kept epoch is stale. A plain claim never takes the
        // show from the other computer, and the kept record is dead.
        let reclaimed = claim(&web, DEVICE, kept.as_ref(), false).await;
        assert!(reclaimed.kept_refused);
        assert_eq!(reclaimed.outcome, Err("stale"));
        assert_eq!(web.borrow().epoch, 2);

        // "Continue here" takes it over from the epoch the web named.
        let continued = claim(&web, DEVICE, kept.as_ref(), true).await;
        assert!(continued.kept_refused);
        let facts = facts_of(&continued.outcome.unwrap(), None);
        assert_eq!(facts.controller_epoch, 3);
        assert_eq!(facts.taken_over_from.as_deref(), Some("another-device"));
    }

    #[test]
    fn a_kept_epoch_is_renewed_only_for_its_own_show_and_device() {
        let kept = KeptController {
            show_id: SHOW.to_string(),
            epoch: 7,
            device_id: DEVICE.to_string(),
        };
        assert_eq!(
            first_intent(None, Some(&kept), SHOW, DEVICE),
            ControllerIntent::Renew(7)
        );
        assert_eq!(
            first_intent(None, Some(&kept), "sh_another", DEVICE),
            ControllerIntent::Claim
        );
        assert_eq!(
            first_intent(None, Some(&kept), SHOW, OTHER_DEVICE),
            ControllerIntent::Claim
        );
        assert_eq!(
            first_intent(None, None, SHOW, DEVICE),
            ControllerIntent::Claim
        );
        // What this process holds wins over what an earlier one kept.
        assert_eq!(
            first_intent(Some(&held_for_test(9)), Some(&kept), SHOW, DEVICE),
            ControllerIntent::Renew(9)
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

    const GATED: &str = "sh_fixture";
    const EFFECTS: &str = "/api/cloud/shows/sh_fixture/effects";

    #[test]
    fn the_gate_reads_the_show_of_a_path_and_never_holds_the_controller_route() {
        assert_eq!(fenced_show(EFFECTS), Some("sh_fixture"));
        assert_eq!(
            fenced_show("api/cloud/shows/sh_fixture/presentation?asset=abc"),
            Some("sh_fixture")
        );
        assert_eq!(
            fenced_show("/api/cloud/shows/sh_fixture"),
            Some("sh_fixture")
        );
        assert_eq!(fenced_show("/api/cloud/shows/sh_fixture/controller"), None);
        assert_eq!(
            fenced_show("/api/cloud/shows/sh_fixture/controller?desired=1"),
            None
        );
        assert_eq!(fenced_show("/api/cloud/shows"), None);
        assert_eq!(fenced_show("/api/account"), None);
    }

    #[tokio::test(start_paused = true)]
    async fn a_request_about_the_awaited_show_waits_for_its_claim_and_no_other_does() {
        let gate = std::sync::Arc::new(RenewalGate::new());
        // Nothing awaited: nothing waits.
        gate.settled(EFFECTS).await;
        gate.expect(GATED);
        assert!(gate.awaits(EFFECTS));
        assert!(!gate.awaits("/api/cloud/shows/sh_other/effects"));
        assert!(!gate.awaits("/api/cloud/shows/sh_fixture/controller"));
        // Another show, the claim itself and other routes go at once.
        gate.settled("/api/cloud/shows/sh_other/effects").await;
        gate.settled("/api/cloud/shows/sh_fixture/controller").await;
        gate.settled("/api/cloud/shows/current").await;
        let waiter = tokio::spawn({
            let gate = gate.clone();
            async move { gate.settled(EFFECTS).await }
        });
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        assert!(!waiter.is_finished(), "held until the claim answers");
        // Another show's claim settling changes nothing here.
        gate.settle("sh_other");
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        assert!(!waiter.is_finished());
        gate.settle(GATED);
        waiter.await.unwrap();
        assert!(!gate.awaits(EFFECTS));
    }

    #[tokio::test(start_paused = true)]
    async fn a_claim_that_never_answers_delays_a_request_and_never_blocks_it() {
        let gate = RenewalGate::new();
        gate.expect(GATED);
        let started = tokio::time::Instant::now();
        gate.settled(EFFECTS).await;
        assert_eq!(started.elapsed(), RENEWAL_WAIT);
        // The wait ran out with the claim's start: later requests go at once.
        let later = tokio::time::Instant::now();
        gate.settled(EFFECTS).await;
        assert_eq!(later.elapsed(), std::time::Duration::ZERO);
        assert!(!gate.awaits(EFFECTS));
    }

    #[tokio::test(start_paused = true)]
    async fn a_claim_in_flight_settles_on_every_return_path() {
        // The process gate: only this test arms it, for a show of its own.
        let path = "/api/cloud/shows/sh_in_flight/stage";
        let claim = renewal_in_flight("sh_in_flight");
        assert!(renewal_gate().awaits(path));
        drop(claim);
        assert!(!renewal_gate().awaits(path));
        renewal_gate().settled(path).await;
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
