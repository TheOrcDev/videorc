//! Web control (plan 234 D2, D8): the second kind of control transport.
//!
//! A show whose media runs on LiveKit Cloud has no node of ours to hold a
//! socket to. Its control is HTTPS routes on videorc.com, and its `state` is a
//! long-poll that answers with the shape the runner sent, plus a `rev`
//! beside it. The wire is `docs/cloud/managed-media-wire.md`, sections 2 and
//! 3; the constants both sides hold are pinned to
//! `protocol-fixtures/cloud-managed-wire.json`.
//!
//! What lives here:
//! - `WebControl`: one show's state poll. Its timings, its backoff, and what
//!   each answer means (section 3's table).
//! - `WebIntents`: an intent as its own HTTPS call, whose answer is its ack.
//!   There is no `hello`, `ack` or `ping`.
//! - `ControlLoop::run_web`: what the show does with each answer. A state is
//!   absorbed exactly as a socket frame is, so the status, the watchdog and
//!   the renderer see no difference.
//!
//! Stream keys: a destination URL crosses this module once, in the body of
//! `PUT …/destinations`, over TLS to the configured API base URL. It is
//! never logged and never part of an error: failures are worded from the
//! status and the code, and `DestinationsBody::scrub` blanks anything a
//! misbehaving answer echoes.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::cloud_show::{
    AckResult, CloudApiError, CloudWebApi, ControlConnector, ControlKind, ControlLoop,
    ControlRequest, HandoverDestination, HelloFailure, LoopExit, RECONNECT_BACKOFF_SECONDS,
    RunnerState, destinations_set_frame, install_control_loop, lock, new_intent_id, until,
};

/// `control.kind` of a show on web control (section 1). A create answer
/// without a kind means the node socket; any other value is a transport this
/// build does not know.
pub(crate) const CONTROL_KIND_WEB: &str = "web";
/// After a 200 the next poll starts this much later.
const STATE_POLL_REST: Duration = Duration::from_millis(250);
/// After a failed poll: 1, 2, 4, 8, then 15 s, reset by a 200. The socket's
/// reconnect backoff, by the contract's own reference.
const STATE_POLL_BACKOFF_SECONDS: [u64; 5] = RECONNECT_BACKOFF_SECONDS;
/// From this failed poll in a row on, `current` is asked after each one.
const ASK_CURRENT_FROM_FAILURE: usize = 2;
/// Section 2: after a network error or a 5xx a route is tried once more,
/// this much later. Never after a 4xx. Every route is safe to repeat.
const RETRY_DELAY: Duration = Duration::from_secs(1);
/// Section 8.4: a leg that asks for its address again gets it at most once
/// in this long.
const LEG_RESEND_SPACING: Duration = Duration::from_secs(30);
/// While a poll waits and the feed is up, how often the loop looks at the
/// feed's clock again: a feed that drops mid-poll must start the lost
/// report's 20 s then, not when a 25 s poll returns.
const FEED_CLOCK_LOOK: Duration = Duration::from_secs(1);
const CODE_SHOW_ENDED: &str = "cloud-show-ended";
const CODE_CONTROL_MISMATCH: &str = "cloud-control-mismatch";
/// Section 6.4: what `cloud.return.set` answers on a show on web control.
pub(crate) const RETURN_UNAVAILABLE_MESSAGE: &str =
    "The program return is not available on this show.";

pub(crate) fn state_path(show_id: &str) -> String {
    format!("/api/cloud/shows/{show_id}/state")
}

pub(crate) fn destinations_path(show_id: &str) -> String {
    format!("/api/cloud/shows/{show_id}/destinations")
}

pub(crate) fn hold_image_path(show_id: &str) -> String {
    format!("/api/cloud/shows/{show_id}/hold-image")
}

/// The query name of the state route's last-seen `rev`.
pub(crate) const STATE_SINCE_QUERY: &str = "since";

// --- Wire -----------------------------------------------------------------------

/// `GET …/state?since=<rev>` (section 3): the runner's `state`, unchanged,
/// with the show's `rev` beside it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlStateAnswer {
    pub rev: u64,
    #[serde(default)]
    pub state: RunnerState,
}

/// The body of `PUT …/destinations` (section 2.2): `{ destinations[],
/// replace? }`, field for field the `destinations.set` frame. Every `url`
/// carries a stream key, so the value lives in memory for the one request
/// and `Debug` shows ids only.
#[derive(Clone, PartialEq, Eq)]
pub struct DestinationsBody(Value);

impl DestinationsBody {
    /// From a `destinations.set` frame. `replace` rides only when true, as
    /// on the socket.
    pub(crate) fn from_frame(frame: &Value) -> Option<Self> {
        let destinations = frame.get("destinations")?.as_array()?;
        let mut body = json!({ "destinations": destinations });
        if frame.get("replace").and_then(Value::as_bool) == Some(true) {
            body["replace"] = Value::Bool(true);
        }
        Some(Self(body))
    }

    /// The JSON to send. It holds the keys: for the request body only.
    pub fn as_json(&self) -> &Value {
        &self.0
    }

    fn entries(&self) -> &[Value] {
        self.0["destinations"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    fn ids(&self) -> Vec<&str> {
        self.entries()
            .iter()
            .filter_map(|entry| entry["id"].as_str())
            .collect()
    }

    /// `text` with every address of this body blanked, and every key piece
    /// (the last path segment, with its query). Nothing the web answers is
    /// trusted not to echo the request.
    fn scrub(&self, text: &str) -> String {
        let mut scrubbed = text.to_string();
        for url in self
            .entries()
            .iter()
            .filter_map(|entry| entry["url"].as_str())
        {
            if url.is_empty() {
                continue;
            }
            scrubbed = scrubbed.replace(url, "••••");
            if let Some(key) = key_piece(url) {
                scrubbed = scrubbed.replace(key, "••••");
            }
        }
        scrubbed
    }
}

impl std::fmt::Debug for DestinationsBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DestinationsBody")
            .field("destinations", &self.ids())
            .field("replace", &self.0.get("replace").is_some())
            .finish()
    }
}

/// The key piece of a destination address (section 8.1): its last path
/// segment, with the query when there is one. Too short to be a key: none.
fn key_piece(url: &str) -> Option<&str> {
    let path = url.split_once("://").map_or(url, |(_, rest)| rest);
    let (_, key) = path.rsplit_once('/')?;
    (key.len() >= 4).then_some(key)
}

/// `PUT …/destinations` took the list. `refused` names the destinations the
/// guard turned down, by id and code; the others were applied.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DestinationsAnswer {
    #[serde(default)]
    pub rev: Option<u64>,
    #[serde(default)]
    pub refused: Vec<RefusedDestination>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RefusedDestination {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub code: String,
}

/// `PUT …/destinations` did not take the list: the error, and on a 422
/// (`cloud-destinations-refused`) the same `refused[]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DestinationsFailure {
    pub error: CloudApiError,
    pub refused: Vec<RefusedDestination>,
}

impl DestinationsFailure {
    /// From the failure's parsed body; `refused` is read leniently from the
    /// top level or from inside `error`.
    pub(crate) fn from_body(error: CloudApiError, body: &Value) -> Self {
        let refused = body
            .get("refused")
            .or_else(|| body.pointer("/error/refused"))
            .cloned()
            .and_then(|value| serde_json::from_value::<Vec<RefusedDestination>>(value).ok())
            .unwrap_or_default();
        Self { error, refused }
    }
}

// --- Failures in words ------------------------------------------------------------

/// A network error or a 5xx: worth the one retry, and never proof of
/// anything about the show.
fn retryable(error: &CloudApiError) -> bool {
    match error {
        CloudApiError::Transport(_)
        | CloudApiError::Disabled
        | CloudApiError::Full
        | CloudApiError::NodeUnreachable
        | CloudApiError::RoomsUnavailable => true,
        CloudApiError::Other { status, .. } => *status >= 500,
        _ => false,
    }
}

/// Section 2's retry rule around one call.
pub(crate) async fn with_one_retry<T, E, F, Fut>(
    mut call: F,
    retryable: impl Fn(&E) -> bool,
) -> std::result::Result<T, E>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = std::result::Result<T, E>>,
{
    match call().await {
        Err(error) if retryable(&error) => {
            tokio::time::sleep(RETRY_DELAY).await;
            call().await
        }
        answer => answer,
    }
}

/// `with_one_retry` for a route that fails with a `CloudApiError`.
pub(crate) async fn with_one_cloud_retry<T, F, Fut>(
    call: F,
) -> std::result::Result<T, CloudApiError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = std::result::Result<T, CloudApiError>>,
{
    with_one_retry(call, retryable).await
}

/// A failure as one line, from its status and code. The web's own `message`
/// is left out on purpose: this line reaches logs and error strings.
fn failure_line(error: &CloudApiError) -> String {
    match error {
        CloudApiError::Other { status, code, .. } => {
            format!("videorc.com answered {status} {code}")
        }
        other => other.to_string(),
    }
}

fn destinations_problem(failure: &DestinationsFailure) -> String {
    let mut codes: Vec<&str> = failure
        .refused
        .iter()
        .map(|refused| refused.code.as_str())
        .filter(|code| !code.is_empty())
        .collect();
    codes.sort_unstable();
    codes.dedup();
    let line = failure_line(&failure.error);
    if codes.is_empty() {
        line
    } else {
        format!("{line} ({})", codes.join(", "))
    }
}

fn refused_line(refused: &[RefusedDestination]) -> String {
    refused
        .iter()
        .map(|refused| format!("{} ({})", refused.id, refused.code))
        .collect::<Vec<_>>()
        .join(", ")
}

// --- Intents ----------------------------------------------------------------------

/// An intent's answer, on its way.
type IntentAnswer = Pin<Box<dyn Future<Output = AckResult> + Send>>;

/// An intent as a call: the socket's frame in, the route's answer out.
pub(crate) type WebIntentCall = Arc<dyn Fn(Value) -> IntentAnswer + Send + Sync>;

/// A show's intents on web control, as the slot holds them. Each one is its
/// own HTTPS call on the caller's task, so no intent waits behind the state
/// poll, and the call's own timeout is the only one.
#[derive(Clone)]
pub(crate) struct WebIntents {
    call: WebIntentCall,
    /// Never sent on. The show's poll watches the other end and stops when
    /// the slot has let go of every handle.
    _held: mpsc::UnboundedSender<ControlRequest>,
}

impl WebIntents {
    pub(crate) async fn send(&self, frame: Value) -> AckResult {
        (self.call)(frame).await
    }

    /// Test support: both lead to the same show's control.
    #[cfg(test)]
    pub(crate) fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.call, &other.call)
    }
}

/// One intent on web control (section 2): the route that replaces the
/// socket's frame, and its answer as the ack.
async fn send_web_intent<W: CloudWebApi>(
    web: &W,
    bearer: &str,
    show_id: &str,
    floor: &AtomicU64,
    frame: Value,
) -> AckResult {
    let kind = frame
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match kind {
        "destinations.set" => {
            let Some(body) = DestinationsBody::from_frame(&frame) else {
                return Err("the destinations could not be read".to_string());
            };
            let answer = with_one_retry(
                || web.set_destinations(bearer, show_id, &body),
                |failure: &DestinationsFailure| retryable(&failure.error),
            )
            .await;
            match answer {
                Ok(answer) => {
                    // Before the caller hears: a state older than this
                    // answer must not be read as the show's state.
                    if let Some(rev) = answer.rev {
                        floor.fetch_max(rev, Ordering::SeqCst);
                    }
                    if !answer.refused.is_empty() {
                        tracing::warn!(
                            show = show_id,
                            "Videorc Cloud refused {} of {} destinations: {}",
                            answer.refused.len(),
                            body.entries().len(),
                            body.scrub(&refused_line(&answer.refused))
                        );
                    }
                    Ok(None)
                }
                Err(failure) => Err(body.scrub(&destinations_problem(&failure))),
            }
        }
        "hold.image.set" => {
            let Some(png) = frame.get("pngBase64").and_then(Value::as_str) else {
                return Err("the hold image could not be read".to_string());
            };
            with_one_cloud_retry(|| web.set_hold_image(bearer, show_id, png))
                .await
                .map(|()| None)
                .map_err(|error| failure_line(&error))
        }
        // `POST …/end` is this intent's route, and every sender calls it
        // itself right after the intent (`end_current_show`, a failed
        // hand-over). Nothing is sent here, and nothing is confirmed.
        "show.end" => Err("a show on web control ends through videorc.com".to_string()),
        other => {
            tracing::warn!(
                intent = other,
                show = show_id,
                "This intent has no route on web control yet (plan 234 T3); nothing was sent"
            );
            Err(format!("{other} is not available on this show yet"))
        }
    }
}

// --- The state poll -----------------------------------------------------------------

/// What one poll's answer means (section 3's table).
#[derive(Debug)]
pub(crate) enum WebPoll {
    /// 200: the show's state, to absorb exactly as a socket frame. Boxed:
    /// the state carries the program and the room.
    State { rev: u64, state: Box<RunnerState> },
    /// 200 with `phase: "ended"`, or 409 `cloud-show-ended`: the show is
    /// over, with the reason when the answer named one.
    Ended(Option<String>),
    /// 401: this computer's sign-in was refused. Polling stops.
    Unauthorized,
    /// 404: videorc.com does not know the show's state. `current` decides.
    NotFound,
    /// 409 `cloud-control-mismatch`: the show is not on web control.
    Mismatch,
    /// A 5xx, a timeout, a network error, or anything else: unknown. Never
    /// "gone".
    Failed(String),
}

fn read_state_answer(answer: std::result::Result<ControlStateAnswer, CloudApiError>) -> WebPoll {
    match answer {
        Ok(answer) if answer.state.phase == "ended" => WebPoll::Ended(answer.state.end_reason),
        Ok(answer) => WebPoll::State {
            rev: answer.rev,
            state: Box::new(answer.state),
        },
        Err(CloudApiError::Unauthorized) => WebPoll::Unauthorized,
        Err(CloudApiError::Other { status: 404, .. }) => WebPoll::NotFound,
        Err(CloudApiError::Other {
            status: 409, code, ..
        }) if code == CODE_SHOW_ENDED => WebPoll::Ended(None),
        Err(CloudApiError::Other {
            status: 409, code, ..
        }) if code == CODE_CONTROL_MISMATCH => WebPoll::Mismatch,
        Err(error) => WebPoll::Failed(failure_line(&error)),
    }
}

/// One show's control over videorc.com: its state long-poll and the way to
/// its intents.
pub(crate) struct WebControl<W: CloudWebApi> {
    web: Arc<W>,
    bearer: String,
    show_id: String,
    /// The last answer's `rev`: the next poll's `since`. None after a
    /// failed poll.
    since: Option<u64>,
    /// Failed polls in a row.
    failures: usize,
    /// When the next poll may start: the rest after an answer, the backoff
    /// after a failure.
    next_at: tokio::time::Instant,
    /// The highest `rev` an intent's answer named. A state below it was read
    /// before that intent took effect.
    floor: Arc<AtomicU64>,
    call: WebIntentCall,
}

impl<W: CloudWebApi> WebControl<W> {
    /// Connect or resume: the first state, asked without `since`, which the
    /// web answers at once. This is the socket's `welcome`.
    pub(crate) async fn open(
        web: Arc<W>,
        bearer: &str,
        show_id: &str,
    ) -> std::result::Result<(Self, RunnerState), HelloFailure> {
        let first = with_one_cloud_retry(|| web.control_state(bearer, show_id, None)).await;
        let (rev, state) = match read_state_answer(first) {
            WebPoll::State { rev, state } => (rev, *state),
            WebPoll::Ended(_) => return Err(HelloFailure::NoSuchShow),
            // Gone only when `current` says so too; otherwise unknown.
            WebPoll::NotFound => {
                return Err(match web.current_show(bearer).await {
                    Ok(current)
                        if current
                            .show
                            .as_ref()
                            .is_none_or(|show| show.id != show_id || show.is_ended()) =>
                    {
                        HelloFailure::NoSuchShow
                    }
                    _ => HelloFailure::Transport(
                        "videorc.com does not know the show's state".to_string(),
                    ),
                });
            }
            WebPoll::Unauthorized => {
                return Err(HelloFailure::Transport(
                    "videorc.com refused this computer's sign-in".to_string(),
                ));
            }
            WebPoll::Mismatch => {
                return Err(HelloFailure::Transport(
                    "videorc.com says this show is not on web control".to_string(),
                ));
            }
            WebPoll::Failed(problem) => return Err(HelloFailure::Transport(problem)),
        };
        let floor = Arc::new(AtomicU64::new(0));
        let call = intent_call(
            web.clone(),
            bearer.to_string(),
            show_id.to_string(),
            floor.clone(),
        );
        Ok((
            Self {
                web,
                bearer: bearer.to_string(),
                show_id: show_id.to_string(),
                since: Some(rev),
                failures: 0,
                next_at: tokio::time::Instant::now() + STATE_POLL_REST,
                floor,
                call,
            },
            state,
        ))
    }

    /// The show's intents for the slot. `held` is the sender whose other
    /// end the poll watches.
    pub(crate) fn intents(&self, held: mpsc::UnboundedSender<ControlRequest>) -> WebIntents {
        WebIntents {
            call: self.call.clone(),
            _held: held,
        }
    }

    /// One poll: waits out the rest or the backoff, asks, and reads the
    /// answer. Dropping it mid-way loses nothing: the next call asks again
    /// with the same `since`.
    pub(crate) async fn poll(&mut self) -> WebPoll {
        tokio::time::sleep_until(self.next_at).await;
        let answer = self
            .web
            .control_state(&self.bearer, &self.show_id, self.since)
            .await;
        let poll = read_state_answer(answer);
        let now = tokio::time::Instant::now();
        match &poll {
            WebPoll::State { rev, .. } => {
                self.since = Some(*rev);
                self.failures = 0;
                self.next_at = now + STATE_POLL_REST;
            }
            WebPoll::Ended(_) | WebPoll::Unauthorized => {}
            WebPoll::NotFound | WebPoll::Mismatch | WebPoll::Failed(_) => {
                // The next poll asks without `since`, which the web answers
                // at once: a reconnect's `welcome`. With the last `rev` it
                // would wait out the long-poll before saying it is back.
                self.since = None;
                self.failures += 1;
                let step = (self.failures - 1).min(STATE_POLL_BACKOFF_SECONDS.len() - 1);
                self.next_at = now + Duration::from_secs(STATE_POLL_BACKOFF_SECONDS[step]);
            }
        }
        poll
    }

    /// A state with this `rev` was read before an intent this computer has
    /// had answered.
    fn is_stale(&self, rev: u64) -> bool {
        rev < self.floor.load(Ordering::SeqCst)
    }
}

fn intent_call<W: CloudWebApi>(
    web: Arc<W>,
    bearer: String,
    show_id: String,
    floor: Arc<AtomicU64>,
) -> WebIntentCall {
    Arc::new(move |frame: Value| -> IntentAnswer {
        let web = web.clone();
        let bearer = bearer.clone();
        let show_id = show_id.clone();
        let floor = floor.clone();
        Box::pin(
            async move { send_web_intent(web.as_ref(), &bearer, &show_id, &floor, frame).await },
        )
    })
}

// --- The show on web control --------------------------------------------------------

impl<W: CloudWebApi, C: ControlConnector> ControlLoop<W, C> {
    /// Web control until the show leaves it: the state long-poll of section
    /// 3 into the same slot the socket feeds. `rx` carries nothing; it ends
    /// when the slot lets go of the show.
    ///
    /// The lost report is on its own clock, as on the socket, but here it
    /// goes whatever the last poll said (section 15): this computer's feed
    /// down 20 s is what the web is told, with `controlLost` saying whether
    /// that poll failed.
    pub(crate) async fn run_web(
        &mut self,
        mut web: WebControl<W>,
        rx: &mut mpsc::UnboundedReceiver<ControlRequest>,
    ) -> LoopExit {
        let call = web.call.clone();
        // When each leg last got its address again (section 8.4).
        let mut resent: HashMap<String, tokio::time::Instant> = HashMap::new();
        let mut poll_failed = false;
        // The `rev` last dropped as stale: the same one a second time is the
        // web's current state, and is taken.
        let mut dropped: Option<u64> = None;
        loop {
            if !self.current() {
                return LoopExit::Superseded;
            }
            if let Some(destinations) = self.resend.take() {
                self.send_destinations_again_over_web(&call, &destinations);
            }
            let answer = {
                let poll = web.poll();
                tokio::pin!(poll);
                loop {
                    let lost_due = lock(&self.context.slot).lost_report_due_at();
                    tokio::select! {
                        answer = &mut poll => break answer,
                        request = rx.recv() => {
                            if request.is_none() {
                                return LoopExit::Superseded;
                            }
                        }
                        _ = until(lost_due) => {
                            if let Some(exit) = self.report_lost_show(poll_failed).await {
                                return exit;
                            }
                            if !self.current() {
                                return LoopExit::Superseded;
                            }
                        }
                        _ = tokio::time::sleep(FEED_CLOCK_LOOK), if lost_due.is_none() => {}
                    }
                }
            };
            if !self.current() {
                return LoopExit::Superseded;
            }
            match answer {
                WebPoll::State { rev, state } => {
                    poll_failed = false;
                    if dropped != Some(rev) && web.is_stale(rev) {
                        dropped = Some(rev);
                        continue;
                    }
                    let fresh = dropped == Some(rev);
                    if self.absorb_web_state(&web, rev, *state, fresh) {
                        dropped = None;
                        self.resend_legs_that_ask(&call, &mut resent);
                    } else {
                        dropped = Some(rev);
                    }
                }
                WebPoll::Ended(end_reason) => return LoopExit::Ended(end_reason),
                WebPoll::Unauthorized => return LoopExit::SignedOut,
                WebPoll::NotFound => {
                    poll_failed = true;
                    self.note_failed_poll("videorc.com does not know the show's state");
                    if self.confirm_show_gone().await == Some(true) {
                        return LoopExit::Gone;
                    }
                }
                WebPoll::Mismatch => {
                    poll_failed = true;
                    self.note_failed_poll("videorc.com says this show is not on web control");
                    if let Some(exit) = self.follow_current_control().await {
                        return exit;
                    }
                }
                WebPoll::Failed(problem) => {
                    poll_failed = true;
                    self.note_failed_poll(&problem);
                    if web.failures >= ASK_CURRENT_FROM_FAILURE
                        && self.confirm_show_gone().await == Some(true)
                    {
                        return LoopExit::Gone;
                    }
                }
            }
        }
    }

    /// A 200 into the slot, exactly as a socket frame, unless it was read
    /// before an intent this computer has had answered. False when dropped.
    ///
    /// The socket keeps frames and acks in one order; two HTTPS requests do
    /// not. Without this, a state read a moment before the hand-over's
    /// `PUT` took effect, arriving after its answer, would read as an
    /// egress that died: `destinationsSet: false` on a show that was handed
    /// over. `fresh` skips the check for a `rev` already dropped once.
    fn absorb_web_state(
        &mut self,
        web: &WebControl<W>,
        rev: u64,
        state: RunnerState,
        fresh: bool,
    ) -> bool {
        // One restart is handled once, as on a socket. Here nothing
        // reconnects to mark the next one, so the state does: the egress is
        // back, or it died again.
        if self.restart_seen_on_socket {
            let before = lock(&self.context.slot)
                .runner
                .as_ref()
                .and_then(|runner| runner.restarts);
            let died_again = matches!(
                (before, state.restarts),
                (Some(before), Some(now)) if now > before
            );
            if state.destinations_set == Some(true) || died_again {
                self.restart_seen_on_socket = false;
            }
        }
        self.absorb_state_if(state, || fresh || !web.is_stale(rev))
    }

    /// Section 8.4: a leg that reads `resend: true` and whose address this
    /// computer holds gets that one destination again, without `replace`,
    /// at most once in 30 s. The web removes and adds it, which forces a
    /// fresh connection to the platform.
    fn resend_legs_that_ask(
        &self,
        call: &WebIntentCall,
        resent: &mut HashMap<String, tokio::time::Instant>,
    ) {
        let asked: Vec<HandoverDestination> = {
            let runtime = lock(&self.context.slot);
            let (Some(show), Some(runner)) = (runtime.show.as_ref(), runtime.runner.as_ref())
            else {
                return;
            };
            show.destinations
                .iter()
                .filter(|destination| {
                    runner
                        .legs
                        .iter()
                        .any(|leg| leg.id == destination.id && leg.resend == Some(true))
                })
                .cloned()
                .collect()
        };
        let now = tokio::time::Instant::now();
        for destination in asked {
            if resent
                .get(&destination.id)
                .is_some_and(|at| now.saturating_duration_since(*at) < LEG_RESEND_SPACING)
            {
                continue;
            }
            resent.insert(destination.id.clone(), now);
            let id = new_intent_id();
            let frame = destinations_set_frame(&id, std::slice::from_ref(&destination), false);
            let call = call.clone();
            let leg = destination.id;
            tokio::spawn(async move {
                if let Err(problem) = call(frame).await {
                    tracing::warn!(
                        leg = %leg,
                        "Videorc Cloud did not take one destination again: {problem}"
                    );
                }
            });
        }
    }

    /// The whole list again after the egress died (section 15): the upsert,
    /// never `replace`. Off the loop, as the socket's ack is awaited: a
    /// refusal or silence marks the restart unrecovered.
    fn send_destinations_again_over_web(
        &self,
        call: &WebIntentCall,
        destinations: &[HandoverDestination],
    ) {
        let id = new_intent_id();
        let frame = destinations_set_frame(&id, destinations, false);
        let call = call.clone();
        let slot = self.context.slot.clone();
        let hooks = self.context.hooks.clone();
        let generation = self.generation;
        tokio::spawn(async move {
            let Err(problem) = call(frame).await else {
                return;
            };
            tracing::warn!("Videorc Cloud did not take the destinations again: {problem}");
            {
                let mut runtime = lock(&slot);
                if runtime.generation != generation {
                    return;
                }
                if let Some(restart) = runtime.restart.as_mut() {
                    restart.destinations_resent = false;
                }
            }
            hooks.emit_from(&slot);
        });
    }

    /// `CloudStatus.connected` is false from the first failed poll.
    fn note_failed_poll(&self, problem: &str) {
        tracing::info!("Videorc Cloud state poll failed: {problem}");
        let changed = {
            let mut runtime = lock(&self.context.slot);
            runtime.generation == self.generation
                && std::mem::replace(&mut runtime.connected, false)
        };
        if changed {
            self.context.hooks.emit_from(&self.context.slot);
        }
    }

    /// Section 3, the 409 `cloud-control-mismatch` row: ask `current` and
    /// use the control it names. `Some` ends this loop: the show is gone,
    /// or its control started over on the transport videorc.com named.
    /// `None` backs off and polls again.
    async fn follow_current_control(&mut self) -> Option<LoopExit> {
        let current = self.context.web.current_show(&self.bearer).await.ok()?;
        let Some(show) = current
            .show
            .filter(|show| show.id == self.show_id && !show.is_ended())
        else {
            return Some(LoopExit::Gone);
        };
        let control = current.control?;
        if control.transport_kind() == ControlKind::Web {
            return None;
        }
        tracing::warn!(
            show = %show.id,
            "Videorc Cloud names another control for this show; following it"
        );
        let opened = self
            .context
            .open_control(&self.bearer, &self.show_id, &control)
            .await;
        let (mut link, first) = opened.ok()?;
        let still_held = {
            let mut runtime = lock(&self.context.slot);
            let current = runtime.generation == self.generation;
            match runtime
                .show
                .as_mut()
                .filter(|active| current && active.record.id == self.show_id)
            {
                Some(active) => {
                    active.control = control.clone();
                    true
                }
                None => false,
            }
        };
        if !still_held {
            link.close().await;
            return Some(LoopExit::Superseded);
        }
        install_control_loop(
            &self.context,
            self.bearer.clone(),
            control,
            self.show_id.clone(),
            link,
            first,
        );
        Some(LoopExit::Superseded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "ytkey-SECRET-0f3a9b";

    fn frame(replace: bool) -> Value {
        destinations_set_frame(
            "intent-1",
            &[HandoverDestination {
                id: "youtube-main".to_string(),
                platform: "youtube".to_string(),
                label: "YouTube".to_string(),
                orientation: "horizontal".to_string(),
                url: format!("rtmps://a.rtmp.youtube.com/live2/{KEY}"),
            }],
            replace,
        )
    }

    /// Section 2.2: the body is the frame's fields, and nothing of the frame
    /// itself (`t`, `id`, `kind`). `replace` rides only when true.
    #[test]
    fn the_destinations_body_is_the_frames_fields_and_its_debug_shows_no_key() {
        let body = DestinationsBody::from_frame(&frame(true)).unwrap();
        assert_eq!(
            body.as_json(),
            &json!({
                "destinations": [{
                    "id": "youtube-main", "platform": "youtube", "label": "YouTube",
                    "orientation": "horizontal",
                    "url": format!("rtmps://a.rtmp.youtube.com/live2/{KEY}"),
                }],
                "replace": true,
            })
        );
        let upsert = DestinationsBody::from_frame(&frame(false)).unwrap();
        assert!(upsert.as_json().get("replace").is_none());
        let printed = format!("{body:?}");
        assert!(printed.contains("youtube-main"), "{printed}");
        assert!(!printed.contains(KEY), "{printed}");
        assert!(!printed.contains("rtmps://"), "{printed}");
        assert!(DestinationsBody::from_frame(&json!({ "kind": "destinations.set" })).is_none());
    }

    /// Section 8.5 from this side: whatever an answer echoes, neither the
    /// address nor its key reaches an error string or a log line.
    #[test]
    fn an_answer_that_echoes_the_request_is_scrubbed() {
        let body = DestinationsBody::from_frame(&frame(true)).unwrap();
        let echoed = format!(
            "could not start rtmps://a.rtmp.youtube.com/live2/{KEY} (key {KEY}, code destination-no-app)"
        );
        let scrubbed = body.scrub(&echoed);
        assert!(!scrubbed.contains(KEY), "{scrubbed}");
        assert!(!scrubbed.contains("a.rtmp.youtube.com"), "{scrubbed}");
        assert!(scrubbed.contains("destination-no-app"), "{scrubbed}");
        // A failure is worded from its status and code; the web's own
        // sentence is never repeated.
        let failure = DestinationsFailure {
            error: CloudApiError::Other {
                status: 422,
                code: "cloud-destinations-refused".to_string(),
                message: format!("refused rtmps://a.rtmp.youtube.com/live2/{KEY}"),
            },
            refused: vec![
                RefusedDestination {
                    id: "youtube-main".to_string(),
                    code: "destination-trailing-slash".to_string(),
                },
                RefusedDestination {
                    id: "custom-1".to_string(),
                    code: "destination-trailing-slash".to_string(),
                },
            ],
        };
        assert_eq!(
            destinations_problem(&failure),
            "videorc.com answered 422 cloud-destinations-refused (destination-trailing-slash)"
        );
        assert_eq!(
            key_piece("rtmp://live.twitch.tv/app/live_1_abc"),
            Some("live_1_abc")
        );
        assert_eq!(
            key_piece("rtmps://host/app/key?token=1"),
            Some("key?token=1")
        );
        assert_eq!(key_piece("not a url"), None);
    }

    /// A 422's `refused[]` is read from the top level or from inside
    /// `error`, and a body without one is a plain failure.
    #[test]
    fn a_refused_list_is_read_from_the_failure_body() {
        let error = || CloudApiError::Other {
            status: 422,
            code: "cloud-destinations-refused".to_string(),
            message: String::new(),
        };
        let refused = json!([{ "id": "custom-1", "code": "destination-scheme" }]);
        for body in [
            json!({ "error": { "code": "cloud-destinations-refused" }, "refused": refused }),
            json!({ "error": { "code": "cloud-destinations-refused", "refused": refused } }),
        ] {
            let failure = DestinationsFailure::from_body(error(), &body);
            assert_eq!(failure.refused.len(), 1, "{body}");
            assert_eq!(failure.refused[0].code, "destination-scheme");
        }
        assert!(
            DestinationsFailure::from_body(error(), &Value::Null)
                .refused
                .is_empty()
        );
    }

    fn other(status: u16, code: &str) -> CloudApiError {
        CloudApiError::Other {
            status,
            code: code.to_string(),
            message: "the web's own words".to_string(),
        }
    }

    /// Section 3's table, row by row, as the poll reads an answer.
    #[test]
    fn each_state_answer_reads_as_its_row_of_the_table() {
        let answer = |state: Value| -> ControlStateAnswer {
            serde_json::from_value(json!({ "rev": 42, "state": state })).unwrap()
        };
        let live = answer(json!({
            "phase": "hold", "liveSeconds": 1234,
            "hold": { "active": true, "since": "2026-11-13T20:20:34.000Z", "reason": "feed-lost", "remainingSeconds": 1741 },
            "feeds": [{ "orientation": "horizontal", "connected": false }],
            "legs": [{ "id": "youtube-main", "platform": "youtube", "label": "YouTube",
                       "orientation": "horizontal", "state": "reconnecting", "resend": true,
                       "since": "2026-11-13T20:00:07.000Z" }],
            "destinationsSet": true, "restarts": 0, "holdImageSet": false, "desktopConnected": true,
            "program": { "audioRmsDb": -100.0, "audioSilentSeconds": 59, "blackSeconds": 0 }
        }));
        match read_state_answer(Ok(live)) {
            WebPoll::State { rev, state } => {
                assert_eq!(rev, 42);
                assert_eq!(state.phase, "hold");
                assert_eq!(state.destinations_set, Some(true));
                assert_eq!(state.legs[0].resend, Some(true));
                assert_eq!(state.hold.as_ref().unwrap().remaining_seconds, Some(1741));
            }
            other => panic!("a 200 is a state, got {other:?}"),
        }
        // The show is over: a 200 that says so, with its reason, or the 409.
        let ended = answer(json!({
            "phase": "ended", "endReason": "hold-limit", "liveSeconds": 9, "feeds": [], "legs": []
        }));
        assert!(matches!(
            read_state_answer(Ok(ended)),
            WebPoll::Ended(Some(reason)) if reason == "hold-limit"
        ));
        assert!(matches!(
            read_state_answer(Err(other(409, CODE_SHOW_ENDED))),
            WebPoll::Ended(None)
        ));
        assert!(matches!(
            read_state_answer(Err(CloudApiError::Unauthorized)),
            WebPoll::Unauthorized
        ));
        assert!(matches!(
            read_state_answer(Err(other(404, "cloud-show-not-found"))),
            WebPoll::NotFound
        ));
        assert!(matches!(
            read_state_answer(Err(other(409, CODE_CONTROL_MISMATCH))),
            WebPoll::Mismatch
        ));
        // Unknown, never "gone": a 5xx, a timeout, a body that did not
        // parse, a refusal this build has no row for.
        for unknown in [
            other(503, "cloud-media-unavailable"),
            other(500, "internal"),
            other(200, "malformed-response"),
            other(400, "invalid-request"),
            other(409, "something-new"),
            CloudApiError::Transport("timed out".to_string()),
            CloudApiError::Full,
        ] {
            match read_state_answer(Err(unknown.clone())) {
                WebPoll::Failed(problem) => {
                    assert!(!problem.contains("the web's own words"), "{problem}")
                }
                other => panic!("{unknown:?} is unknown, got {other:?}"),
            }
        }
        // Section 2: only a network error or a 5xx is tried again.
        assert!(retryable(&CloudApiError::Transport("reset".to_string())));
        assert!(retryable(&other(503, "cloud-media-unavailable")));
        assert!(retryable(&CloudApiError::Full));
        for never in [
            other(400, "invalid-request"),
            other(404, "cloud-show-not-found"),
            other(409, CODE_SHOW_ENDED),
            other(422, "cloud-destinations-refused"),
            CloudApiError::Unauthorized,
        ] {
            assert!(!retryable(&never), "{never:?}");
        }
    }

    /// `protocol-fixtures/cloud-managed-wire.json` is what the web copies.
    /// The desktop's constants are pinned to it here; a value that differs
    /// is a bug in the code, never a reason to edit the fixture alone.
    #[test]
    fn cloud_managed_wire_fixture_pins_the_desktops_constants() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/cloud-managed-wire.json"
        ))
        .expect("the fixture parses");
        assert_eq!(fixture["version"], 1);
        let route = |name: &str| -> String {
            fixture["routes"][name]["path"]
                .as_str()
                .unwrap_or_else(|| panic!("the fixture names the {name} route"))
                .replace(":id", "sh_fixture")
        };
        assert_eq!(state_path("sh_fixture"), route("state"));
        assert_eq!(fixture["routes"]["state"]["method"], "GET");
        assert_eq!(fixture["routes"]["state"]["query"], STATE_SINCE_QUERY);
        assert_eq!(destinations_path("sh_fixture"), route("destinations"));
        assert_eq!(fixture["routes"]["destinations"]["method"], "PUT");
        assert_eq!(hold_image_path("sh_fixture"), route("holdImage"));
        assert_eq!(fixture["routes"]["holdImage"]["method"], "PUT");
        // The routes the desktop already had.
        assert_eq!(route("create"), "/api/cloud/shows");
        assert_eq!(route("current"), "/api/cloud/shows/current");
        assert_eq!(route("end"), "/api/cloud/shows/sh_fixture/end");
        assert_eq!(route("lost"), "/api/cloud/shows/sh_fixture/lost");

        assert_eq!(fixture["control"]["kinds"], json!([CONTROL_KIND_WEB]));
        assert_eq!(fixture["control"]["absentKindMeans"], "node");
        assert_eq!(
            fixture["control"]["unknownKindFallback"],
            serde_json::to_value(crate::cloud_show::CloudFallbackReason::CloudNodeUnreachable)
                .unwrap()
        );

        let codes = |list: &str| -> Vec<(u64, String)> {
            fixture["errors"][list]
                .as_array()
                .unwrap_or_else(|| panic!("the fixture lists {list} errors"))
                .iter()
                .map(|entry| {
                    (
                        entry["status"].as_u64().unwrap(),
                        entry["code"].as_str().unwrap().to_string(),
                    )
                })
                .collect()
        };
        // The codes this build branches on, at the status it expects them.
        let common = codes("common");
        assert!(common.contains(&(409, CODE_SHOW_ENDED.to_string())));
        assert!(common.contains(&(409, CODE_CONTROL_MISMATCH.to_string())));
        assert!(common.contains(&(404, "cloud-show-not-found".to_string())));
        assert!(common.contains(&(401, "unauthorized".to_string())));
        assert!(codes("create").contains(&(422, "cloud-quality".to_string())));
        assert_eq!(
            crate::cloud_show::classify_cloud_failure(
                422,
                "cloud-quality",
                String::new(),
                None,
                None
            )
            .fallback_reason(),
            Some(crate::cloud_show::CloudFallbackReason::CloudQuality)
        );
        assert!(codes("destinations").contains(&(422, "cloud-destinations-refused".to_string())));

        assert_eq!(fixture["retry"]["times"], 1);
        assert_eq!(
            fixture["retry"]["afterMs"].as_u64(),
            Some(RETRY_DELAY.as_millis() as u64)
        );
        let state = &fixture["state"];
        assert_eq!(state["answerFields"], json!(["rev", "state"]));
        assert_eq!(
            state["requestTimeoutMs"].as_u64(),
            Some(crate::videorc_api::CLOUD_STATE_POLL_TIMEOUT.as_millis() as u64)
        );
        // The request outlives the web's longest wait.
        assert!(
            crate::videorc_api::CLOUD_STATE_POLL_TIMEOUT.as_secs()
                > state["waitSeconds"]["calm"].as_u64().unwrap()
        );
        assert_eq!(
            state["restAfterAnswerMs"].as_u64(),
            Some(STATE_POLL_REST.as_millis() as u64)
        );
        assert_eq!(state["backoffSeconds"], json!(STATE_POLL_BACKOFF_SECONDS));
        assert_eq!(
            state["askCurrentFromFailure"].as_u64(),
            Some(ASK_CURRENT_FROM_FAILURE as u64)
        );
        assert_eq!(
            fixture["legs"]["resend"]["desktopSpacingSeconds"].as_u64(),
            Some(LEG_RESEND_SPACING.as_secs())
        );
        assert_eq!(
            fixture["timers"]["lostFeedDownSeconds"].as_u64(),
            Some(crate::cloud_show::LOST_SHOW_FEED_DOWN.as_secs())
        );
        assert_eq!(
            fixture["limits"]["holdMaxSecondsChoices"],
            json!(crate::cloud_show::HOLD_MAX_CHOICES)
        );
        assert_eq!(fixture["return"]["message"], RETURN_UNAVAILABLE_MESSAGE);

        // Every leg state the web may send has a place in the desktop's leg
        // model; only a state this list does not hold reads as a warning.
        for state in fixture["legs"]["states"].as_array().unwrap() {
            let leg = crate::cloud_show::RunnerLeg {
                id: "leg".to_string(),
                state: state.as_str().unwrap().to_string(),
                ..Default::default()
            };
            assert_ne!(
                crate::cloud_show::runner_leg_to_runtime(&leg).state,
                crate::streaming::StreamTargetState::Warning,
                "{state}"
            );
        }
        // The closed leg messages reach the status as they are.
        for (_, message) in fixture["legs"]["messages"].as_object().unwrap() {
            let leg = crate::cloud_show::RunnerLeg {
                id: "leg".to_string(),
                state: "failed".to_string(),
                error: message.as_str().map(str::to_string),
                ..Default::default()
            };
            assert_eq!(
                crate::cloud_show::runner_leg_to_runtime(&leg)
                    .message
                    .as_deref(),
                message.as_str()
            );
        }
    }
}
