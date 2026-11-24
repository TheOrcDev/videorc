//! S1.6c: the platform cleanup a livestream leaves behind (`use-studio.tsx`:
//! `endXBroadcastOnce`, `completeYouTubeBroadcastOnce`,
//! `endPreparedXBroadcasts`, `completePreparedPlatformBroadcasts`,
//! `settleClaimedPlatformLifecycleOwner`,
//! `settleRetainedPreparedPlatformLifecycles`,
//! `settlePreparedPlatformLifecycle`, `settlePreviousPlatformLifecycle`, the
//! stop's cleanup; `releaseScheduledXPreparations` in
//! `lib/scheduled-streams.ts`).
//!
//! - **Once per broadcast**: an X END and a YouTube complete are
//!   single-flight on `[accountId, broadcastId]`, and a finished one answers
//!   from its cache, so a retry never ends a broadcast twice. A publish or a
//!   prepare of that broadcast forgets it.
//! - **One settlement at a time**: the same owner's second settle joins the
//!   first; another owner's is refused (`LIVESTREAM_STILL_SETTLING`).
//! - **Complete or retained**: an X broadcast still to end, a YouTube
//!   completion that isn't settled (plan 094) or a saved X broadcast whose
//!   release failed leaves the cleanup incomplete, and its owner stays for
//!   the next start to settle first.
//! - **The stop**: X ends (4 s at most) before `session.stop`, YouTube
//!   completes after it. A saved X broadcast is ended, then its preparation
//!   released.
//! - **Handed off** (plan 243 D7): a session a hand-off stopped completes
//!   nothing; the show goes on from the other device.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures_util::future::{BoxFuture, FutureExt, Shared};
use serde_json::{Map, Value, json};
use tokio::sync::watch;

use super::go_live::{now_iso, target_value, text};
use super::{Studio, StudioBackend};
use crate::client::RpcError;
use crate::livestream::cloud_provider::{self, OutputStep};
use crate::livestream::lifecycle::{self, patch_prepared_target, status_patch};
use crate::livestream::lifecycle_copy::LIVESTREAM_STILL_SETTLING;
use crate::livestream::platform_owner::{
    CompletedResults, Owner, Owners, broadcast_key, is_prepared_owner,
};
use crate::livestream::{go_live_copy, methods, scheduled_copy};
use crate::notices::{NoticeAction, NoticeCommand, ToastRequest};
use crate::user_error::{Failure, START_THE_X_BROADCAST, UserErrorContext, user_error_message};

/// `PLATFORM_CLEANUP_X_END_TIMEOUT_MS`: an X END never holds the stop longer.
pub(super) const X_END_TIMEOUT: Duration = Duration::from_secs(4);
const CLOUD_STATUS: &str = "cloud.status";

/// `PlatformBroadcastCleanupResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct CleanupResult {
    pub streaming: Value,
    pub complete: bool,
}

type Flight = Shared<BoxFuture<'static, Result<Value, RpcError>>>;
/// A settlement's answer, once it has one.
type Done = watch::Receiver<Option<CleanupResult>>;

/// One kind of request made once per broadcast.
#[derive(Default)]
struct Flights {
    in_flight: HashMap<String, Flight>,
    completed: CompletedResults,
}

impl Flights {
    fn forget(&mut self, key: &str) {
        self.in_flight.remove(key);
        self.completed.remove(key);
    }
}

#[derive(Default)]
struct Book {
    owners: Owners,
    /// `platformLifecycleRun`: a stop, a hand-off or the show's end moves
    /// it on, and an activation that saw another run stops.
    run: u64,
    /// `platformLifecycleSettlementRef`: the owner being settled.
    settling: Option<(String, Done)>,
    /// `platformLifecycleMutationRef`: an X publish in flight for a session,
    /// whose answer the session's cleanup waits for.
    mutation: Option<(String, watch::Receiver<Option<Value>>)>,
    x_end: Flights,
    youtube_complete: Flights,
}

fn lock(book: &Mutex<Book>) -> MutexGuard<'_, Book> {
    book.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The livestream's platform owners, settlements and caches.
#[derive(Default)]
pub struct PlatformLifecycle {
    book: Arc<Mutex<Book>>,
}

impl PlatformLifecycle {
    pub(super) fn run(&self) -> u64 {
        lock(&self.book).run
    }

    pub(super) fn next_run(&self) {
        lock(&self.book).run += 1;
    }

    /// The session's owner, as the start installs it.
    pub(super) fn install(&self, owner: Owner) {
        lock(&self.book).owners.install(owner);
    }

    pub(super) fn update_streaming(&self, session_id: &str, streaming: &Value) {
        lock(&self.book)
            .owners
            .update_streaming(session_id, streaming);
    }

    pub(super) fn holds_owner(&self) -> bool {
        lock(&self.book).owners.current().is_some()
    }

    pub(super) fn claim(&self, session_id: &str) -> Option<Owner> {
        lock(&self.book).owners.claim(session_id)
    }

    fn retain(&self, owner: Owner) {
        lock(&self.book).owners.retain(owner);
    }

    /// `latchHandOff`: true when the session's owner was dropped.
    pub(super) fn drop_handed_off(&self, handed_off: &[String]) -> bool {
        let mut book = lock(&self.book);
        let dropped = book.owners.drop_handed_off(handed_off).is_some();
        if dropped {
            book.run += 1;
        }
        dropped
    }

    /// A publish answered for this broadcast: its END is due again.
    pub(super) fn forget_x_end(&self, key: &str) {
        lock(&self.book).x_end.forget(key);
    }

    /// A prepare answered for this broadcast: its completion is due again.
    pub(super) fn forget_youtube_completion(&self, key: &str) {
        lock(&self.book).youtube_complete.forget(key);
    }

    fn settling(&self) -> Option<(String, Done)> {
        lock(&self.book).settling.clone()
    }

    fn begin(&self, owner_id: &str) -> Begin {
        let mut book = lock(&self.book);
        if let Some((id, done)) = &book.settling {
            return if id == owner_id {
                Begin::Join(done.clone())
            } else {
                Begin::Busy(done.clone())
            };
        }
        let (sender, receiver) = watch::channel(None);
        book.settling = Some((owner_id.to_string(), receiver));
        Begin::Run(Settlement {
            book: Arc::clone(&self.book),
            owner_id: owner_id.to_string(),
            done: sender,
        })
    }

    /// An X publish for `session_id` starts: its cleanup waits for the
    /// answer.
    pub(super) fn begin_mutation(&self, session_id: &str) -> Mutation {
        let (sender, receiver) = watch::channel(None);
        lock(&self.book).mutation = Some((session_id.to_string(), receiver));
        Mutation {
            book: Arc::clone(&self.book),
            session_id: session_id.to_string(),
            done: sender,
        }
    }

    fn mutation_for(&self, session_id: &str) -> Option<watch::Receiver<Option<Value>>> {
        lock(&self.book)
            .mutation
            .as_ref()
            .filter(|(id, _)| id == session_id)
            .map(|(_, done)| done.clone())
    }

    /// The single-flight request for `key`: a finished one's answer, the
    /// running one joined, or `start` run.
    async fn once(
        &self,
        pick: fn(&mut Book) -> &mut Flights,
        key: String,
        start: impl FnOnce() -> BoxFuture<'static, Result<Value, RpcError>>,
    ) -> Result<Value, RpcError> {
        let flight = {
            let mut book = lock(&self.book);
            let flights = pick(&mut book);
            if let Some(result) = flights.completed.get(&key) {
                return Ok(result);
            }
            flights
                .in_flight
                .entry(key.clone())
                .or_insert_with(|| start().shared())
                .clone()
        };
        let result = flight.clone().await;
        let mut book = lock(&self.book);
        let flights = pick(&mut book);
        if flights
            .in_flight
            .get(&key)
            .is_some_and(|entry| entry.ptr_eq(&flight))
        {
            flights.in_flight.remove(&key);
            if let Ok(answer) = &result {
                flights.completed.insert(key, answer.clone());
            }
        }
        result
    }
}

enum Begin {
    Run(Settlement),
    /// This owner is being settled: its answer.
    Join(Done),
    /// Another owner is.
    Busy(Done),
}

/// The running settlement; dropped unfinished, whoever joined it is told
/// it is still settling.
pub(super) struct Settlement {
    book: Arc<Mutex<Book>>,
    owner_id: String,
    done: watch::Sender<Option<CleanupResult>>,
}

impl Settlement {
    fn finish(self, result: &CleanupResult) {
        self.done.send_replace(Some(result.clone()));
    }
}

impl Drop for Settlement {
    fn drop(&mut self) {
        let mut book = lock(&self.book);
        if book
            .settling
            .as_ref()
            .is_some_and(|(id, _)| *id == self.owner_id)
        {
            book.settling = None;
        }
    }
}

/// An X publish in flight; dropped unfinished, the cleanup keeps the
/// streaming it had.
pub(super) struct Mutation {
    book: Arc<Mutex<Book>>,
    session_id: String,
    done: watch::Sender<Option<Value>>,
}

impl Mutation {
    pub(super) fn finish(self, streaming: &Value) {
        self.done.send_replace(Some(streaming.clone()));
    }
}

impl Drop for Mutation {
    fn drop(&mut self) {
        let mut book = lock(&self.book);
        if book
            .mutation
            .as_ref()
            .is_some_and(|(id, _)| *id == self.session_id)
        {
            book.mutation = None;
        }
    }
}

/// What the stop claimed before `session.stop`: the owner, X already
/// ended.
pub(super) struct StopCleanup {
    settlement: Settlement,
    owner: Owner,
}

async fn joined(mut done: Done) -> Result<CleanupResult, String> {
    match done.wait_for(Option::is_some).await {
        Ok(result) => (*result)
            .clone()
            .ok_or_else(|| LIVESTREAM_STILL_SETTLING.to_string()),
        Err(_) => Err(LIVESTREAM_STILL_SETTLING.to_string()),
    }
}

impl<B: StudioBackend> Studio<B> {
    /// `reportError(new UserFacingError(LIVESTREAM_STILL_SETTLING), { action: 'go live' })`.
    pub(super) fn report_still_settling(&self, message: &str) {
        let copy = user_error_message(
            Failure::Sentence {
                text: message,
                warning: true,
            },
            Some(UserErrorContext {
                action: "go live",
                object: "",
            }),
        );
        self.post(vec![NoticeCommand::Show(
            ToastRequest::warning(copy.title)
                .description(copy.description)
                .finish(),
        )]);
    }

    /// The talk-show room is open (`cloudStatus.room.phase === 'open'`).
    pub(super) fn talk_show_room_open(&self) -> bool {
        self.cloud_now()
            .status
            .as_ref()
            .and_then(|status| status.room.as_ref())
            .and_then(|room| room.get("phase"))
            .and_then(Value::as_str)
            == Some("open")
    }

    /// `waitForCloudProviderOutput`: the show's leg for this destination is
    /// live on the cloud, or why it never will be.
    pub(super) async fn wait_for_cloud_provider_output(
        &self,
        show_id: &str,
        target_id: &str,
        run: u64,
    ) -> Result<(), RpcError> {
        let refused = |message: &'static str| RpcError::new(CLOUD_STATUS, "cloud-output", message);
        let mut interval = None;
        for attempt in 0..cloud_provider::OUTPUT_ATTEMPTS {
            if self.platform.run() != run {
                return Err(refused(cloud_provider::START_CANCELLED));
            }
            let status = self.cloud_request(CLOUD_STATUS, Value::Null).await?;
            if self.platform.run() != run {
                return Err(refused(cloud_provider::START_CANCELLED));
            }
            match cloud_provider::output_step(&status, show_id, target_id, &mut interval) {
                OutputStep::Live => return Ok(()),
                OutputStep::Fail(message) => return Err(refused(message)),
                OutputStep::Wait => {}
            }
            if attempt + 1 < cloud_provider::OUTPUT_ATTEMPTS {
                tokio::time::sleep(Duration::from_millis(cloud_provider::OUTPUT_INTERVAL_MS)).await;
            }
        }
        Err(refused(cloud_provider::DESTINATION_NOT_LIVE))
    }

    /// `endXBroadcastOnce`.
    async fn end_x_broadcast_once(
        &self,
        target: &Value,
        broadcast_id: &str,
        session_id: Option<&str>,
    ) -> Result<Value, RpcError> {
        let account = text(target, "accountId");
        let key = broadcast_key(account.as_deref(), broadcast_id);
        let params = json!({
            "accountId": account,
            "broadcastId": broadcast_id,
            "sessionId": session_id,
        });
        let backend = Arc::clone(&self.backend);
        self.platform
            .once(
                |book| &mut book.x_end,
                key,
                move || {
                    async move { backend.livestream_request(methods::X_END, params).await }.boxed()
                },
            )
            .await
    }

    /// `completeYouTubeBroadcastOnce`: only a confirmed `complete` counts.
    async fn complete_youtube_broadcast_once(
        &self,
        target: &Value,
        broadcast_id: &str,
    ) -> Result<Value, RpcError> {
        let account = text(target, "accountId");
        let key = broadcast_key(account.as_deref(), broadcast_id);
        let params = json!({
            "accountId": account,
            "broadcastId": broadcast_id,
            "status": "complete",
        });
        let backend = Arc::clone(&self.backend);
        self.platform
            .once(
                |book| &mut book.youtube_complete,
                key,
                move || {
                    async move {
                        let result = backend
                            .livestream_request(methods::YOUTUBE_TRANSITION, params)
                            .await?;
                        lifecycle::youtube_transition_confirmed(&result, "complete").map_err(
                            |message| {
                                RpcError::new(methods::YOUTUBE_TRANSITION, "not-confirmed", message)
                            },
                        )?;
                        Ok(result)
                    }
                    .boxed()
                },
            )
            .await
    }

    /// `endPreparedXBroadcasts`: X's documented order is END first, then
    /// stop the encoder. The streaming comes back with the ended targets
    /// patched, so a later pass never ends one twice; one too slow to wait
    /// for stays as it was, and a later cleanup rejoins its END.
    pub(super) async fn end_prepared_x(
        &self,
        mut streaming: Value,
        session_id: Option<&str>,
        timeout: Option<Duration>,
    ) -> Value {
        if !self.is_connected() {
            return streaming;
        }
        for id in lifecycle::x_completion_targets(&streaming) {
            let Some(target) = target_value(&streaming, &id).cloned() else {
                continue;
            };
            let Some(broadcast) = text(&target, "platformBroadcastId") else {
                continue;
            };
            self.save_target_patch(
                &id,
                status_patch("connecting", go_live_copy::ENDING_X_BROADCAST),
            )
            .await;
            let request = self.end_x_broadcast_once(&target, &broadcast, session_id);
            let ended = match timeout {
                Some(timeout) => match tokio::time::timeout(timeout, request).await {
                    Ok(ended) => ended,
                    Err(_) => continue,
                },
                None => request.await,
            };
            let patch = match ended {
                Ok(result) => {
                    status_patch("stopped", result["message"].as_str().unwrap_or_default())
                }
                Err(error) => {
                    let mut patch =
                        status_patch("warning", &go_live_copy::x_cleanup_review(&error.message));
                    if let Some(url) = target
                        .pointer("/status/redactedUrl")
                        .filter(|url| url.as_str().is_some_and(|u| !u.is_empty()))
                    {
                        patch["status"]["redactedUrl"] = url.clone();
                    }
                    self.toast_x_end_failed(&id, &error);
                    patch
                }
            };
            patch_prepared_target(&mut streaming, &id, &patch, &now_iso());
            self.save_target_patch(&id, patch).await;
        }
        streaming
    }

    /// `showXBroadcastProblem('end')`.
    fn toast_x_end_failed(&self, id: &str, error: &RpcError) {
        let copy = user_error_message(
            Failure::Rpc(error),
            Some(UserErrorContext {
                action: "end",
                ..START_THE_X_BROADCAST
            }),
        );
        self.post(vec![NoticeCommand::Show(
            ToastRequest::warning(copy.title)
                .id(format!("x-broadcast-end:{id}"))
                .description(go_live_copy::END_IT_IN_MEDIA_STUDIO)
                .action(
                    go_live_copy::OPEN_MEDIA_STUDIO,
                    NoticeAction::OpenUrl {
                        url: go_live_copy::X_MEDIA_STUDIO_URL.to_string(),
                    },
                )
                .finish(),
        )]);
    }

    /// `releaseScheduledXPreparations`: each saved X destination still
    /// holding a preparation releases it exactly once ("Upcoming broadcast
    /// preserved." when the event stays upcoming). A failed release is the
    /// destination's line alone and leaves the cleanup incomplete.
    async fn release_scheduled_x(
        &self,
        mut streaming: Value,
        session_id: Option<&str>,
    ) -> (Value, bool) {
        let mut complete = true;
        let held: Vec<Value> = streaming["targets"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|target| lifecycle::holds_scheduled_x_preparation(target))
            .cloned()
            .collect();
        for target in held {
            let (Some(id), Some(event_id)) =
                (text(&target, "id"), text(&target, "scheduledEventId"))
            else {
                continue;
            };
            let mut fields = json!({ "attemptId": target.get("scheduledAttemptId") });
            if let Some(session_id) = session_id {
                fields["sessionId"] = Value::String(session_id.to_string());
            }
            let patch = match self
                .scheduled_operation("releasePreparation", &event_id, fields)
                .await
            {
                Ok(released) => {
                    let message = if released["lifecycleStatus"].as_str() == Some("ready") {
                        scheduled_copy::UPCOMING_BROADCAST_PRESERVED
                    } else {
                        released["message"].as_str().unwrap_or_default()
                    };
                    let mut patch = status_patch("stopped", message);
                    patch.insert("scheduledAttemptId".into(), Value::Null);
                    patch
                }
                Err(error) => {
                    complete = false;
                    status_patch(
                        "warning",
                        &scheduled_copy::x_scheduled_cleanup_review(&error.message),
                    )
                }
            };
            patch_prepared_target(&mut streaming, &id, &patch, &now_iso());
            self.save_target_patch(&id, patch).await;
        }
        (streaming, complete)
    }

    /// `completePreparedPlatformBroadcasts`: YouTube's broadcasts complete
    /// (a saved event releases its preparation and may stay upcoming), X's
    /// end unless the caller already ended them, and saved X broadcasts
    /// release theirs.
    async fn complete_prepared(
        &self,
        mut streaming: Value,
        session_id: Option<&str>,
        skip_x: bool,
    ) -> CleanupResult {
        if !self.is_connected() {
            return CleanupResult {
                streaming,
                complete: false,
            };
        }
        let handed_off = session_id.is_some_and(|id| {
            self.cloud_now()
                .handed_off
                .iter()
                .any(|handed| handed == id)
        });
        if handed_off {
            return CleanupResult {
                streaming,
                complete: true,
            };
        }
        let scheduled_session = session_id.filter(|id| !is_prepared_owner(id));
        let mut complete = true;
        for id in lifecycle::youtube_completion_targets(&streaming) {
            let Some(target) = target_value(&streaming, &id).cloned() else {
                continue;
            };
            let Some(broadcast) = text(&target, "platformBroadcastId") else {
                continue;
            };
            let connecting = status_patch("connecting", go_live_copy::COMPLETING_YOUTUBE);
            patch_prepared_target(&mut streaming, &id, &connecting, &now_iso());
            self.save_target_patch(&id, connecting).await;
            let scheduled = text(&target, "scheduledEventId");
            let completed = match &scheduled {
                Some(event_id) => {
                    let mut fields = json!({ "attemptId": target.get("scheduledAttemptId") });
                    if let Some(session_id) = scheduled_session {
                        fields["sessionId"] = Value::String(session_id.to_string());
                    }
                    self.scheduled_operation("releasePreparation", event_id, fields)
                        .await
                        .map(|result| {
                            if result["lifecycleStatus"].as_str() == Some("ready") {
                                go_live_copy::UPCOMING_EVENT_PRESERVED
                            } else {
                                go_live_copy::YOUTUBE_ENDED
                            }
                        })
                }
                None => self
                    .complete_youtube_broadcast_once(&target, &broadcast)
                    .await
                    .map(|_| go_live_copy::YOUTUBE_ENDED),
            };
            let patch = match completed {
                Ok(message) => status_patch("stopped", message),
                Err(error) => {
                    // Plan 094: a `complete` refused on quota (not a saved
                    // event's) or for a gone broadcast is settled.
                    let (status, settled) = lifecycle::youtube_completion_failure(
                        Some(error.code.as_str()),
                        scheduled.is_some(),
                        &error.message,
                    );
                    complete &= settled;
                    self.toast_youtube_broadcast(false, &id, &target, &error.message);
                    let mut patch = Map::new();
                    patch.insert("status".into(), status);
                    patch
                }
            };
            patch_prepared_target(&mut streaming, &id, &patch, &now_iso());
            self.save_target_patch(&id, patch).await;
        }
        if !skip_x {
            streaming = self
                .end_prepared_x(streaming, session_id, Some(X_END_TIMEOUT))
                .await;
        }
        if !lifecycle::x_completion_targets(&streaming).is_empty() {
            complete = false;
        }
        let saved_x = lifecycle::typed_targets(&streaming)
            .iter()
            .any(|target| target.platform == "x" && target.scheduled_event_id.is_some());
        if saved_x {
            let (released, released_all) =
                self.release_scheduled_x(streaming, scheduled_session).await;
            streaming = released;
            complete &= released_all;
        }
        CleanupResult {
            streaming,
            complete,
        }
    }

    /// The owner with what an X publish in flight for it answered.
    async fn resolve_mutation(&self, owner: Owner) -> Owner {
        let Some(mut done) = self.platform.mutation_for(&owner.session_id) else {
            return owner;
        };
        let streaming = match done.wait_for(Option::is_some).await {
            Ok(streaming) => (*streaming).clone(),
            Err(_) => None,
        };
        match streaming {
            Some(streaming) => Owner {
                session_id: owner.session_id,
                streaming,
            },
            None => owner,
        }
    }

    /// `settleClaimedPlatformLifecycleOwner`: one settlement at a time; an
    /// incomplete one keeps its owner. Unlike Electron, an owner refused
    /// because another settles is retained too, so its broadcasts are never
    /// forgotten.
    pub(super) async fn settle_claimed_owner(&self, owner: Owner) -> Result<CleanupResult, String> {
        let settlement = match self.platform.begin(&owner.session_id) {
            Begin::Run(settlement) => settlement,
            Begin::Join(done) => return joined(done).await,
            Begin::Busy(_) => {
                self.platform.retain(owner);
                return Err(LIVESTREAM_STILL_SETTLING.to_string());
            }
        };
        let owner = self.resolve_mutation(owner).await;
        let session_id =
            (!is_prepared_owner(&owner.session_id)).then_some(owner.session_id.as_str());
        let result = self
            .complete_prepared(owner.streaming.clone(), session_id, false)
            .await;
        if !result.complete {
            self.platform.retain(Owner {
                session_id: owner.session_id.clone(),
                streaming: result.streaming.clone(),
            });
        }
        settlement.finish(&result);
        Ok(result)
    }

    /// `settleRetainedPreparedPlatformLifecycles`: the running settlement,
    /// then each prepared owner in turn; the first that can't finish stops.
    async fn settle_retained_prepared(&self) -> Result<(), String> {
        if let Some((_, done)) = self.platform.settling() {
            let _ = joined(done).await;
        }
        loop {
            let next = lock(&self.platform.book).owners.next_retained();
            let Some(owner) = next else {
                return Ok(());
            };
            let result = self.settle_claimed_owner(owner).await?;
            if !result.complete {
                return Err(LIVESTREAM_STILL_SETTLING.to_string());
            }
        }
    }

    /// `settlePreparedPlatformLifecycle`: what a Go Live prepared and never
    /// started (a cancelled partial setup, a refused start).
    pub(super) async fn settle_prepared_platforms(&self, streaming: Value) -> CleanupResult {
        let owner = lock(&self.platform.book).owners.prepared(streaming.clone());
        if let Err(message) = self.settle_retained_prepared().await {
            self.report_still_settling(&message);
            self.platform.retain(owner);
            return CleanupResult {
                streaming,
                complete: false,
            };
        }
        match self.settle_claimed_owner(owner).await {
            Ok(result) => result,
            Err(message) => {
                self.report_still_settling(&message);
                CleanupResult {
                    streaming,
                    complete: false,
                }
            }
        }
    }

    /// `settlePreviousPlatformLifecycle`: before a start, the last
    /// livestream's cleanup finishes, or the start is refused
    /// (`LIVESTREAM_STILL_SETTLING`, said here). L7's record start calls
    /// this too.
    pub(crate) async fn settle_previous_platform_lifecycle(&self) -> bool {
        let settled = async {
            self.settle_retained_prepared().await?;
            let previous = lock(&self.platform.book)
                .owners
                .current()
                .map(|owner| owner.session_id.clone());
            let Some(previous) = previous else {
                return Ok(());
            };
            let Some(owner) = self.platform.claim(&previous) else {
                return Err(LIVESTREAM_STILL_SETTLING.to_string());
            };
            match self.settle_claimed_owner(owner).await? {
                CleanupResult { complete: true, .. } => Ok(()),
                _ => Err(LIVESTREAM_STILL_SETTLING.to_string()),
            }
        }
        .await;
        match settled {
            Ok(()) => true,
            Err(message) => {
                self.report_still_settling(&message);
                false
            }
        }
    }

    /// The stop, before `session.stop`: the session's owner is claimed and
    /// its X broadcasts end while the feed is still up. Without an owner, a
    /// settlement already running for the session is waited for. Unlike
    /// Electron, another owner's settlement is waited for, never a refused
    /// stop.
    pub(super) async fn begin_platform_stop(
        &self,
        session_id: Option<String>,
    ) -> Option<StopCleanup> {
        self.platform.next_run();
        let session_id = session_id.filter(|id| !id.is_empty())?;
        loop {
            let owned = lock(&self.platform.book)
                .owners
                .current()
                .is_some_and(|owner| owner.session_id == session_id);
            if !owned {
                if let Some((id, done)) = self.platform.settling()
                    && id == session_id
                {
                    let _ = joined(done).await;
                }
                return None;
            }
            match self.platform.begin(&session_id) {
                Begin::Run(settlement) => {
                    let owner = self.platform.claim(&session_id)?;
                    let mut owner = self.resolve_mutation(owner).await;
                    owner.streaming = self
                        .end_prepared_x(owner.streaming, Some(&session_id), Some(X_END_TIMEOUT))
                        .await;
                    return Some(StopCleanup { settlement, owner });
                }
                Begin::Join(done) | Begin::Busy(done) => {
                    let _ = joined(done).await;
                }
            }
        }
    }

    /// The stop, after `session.stop`: YouTube completes and saved X
    /// broadcasts release. A stop that failed keeps the owner.
    pub(super) async fn finish_platform_stop(&self, cleanup: Option<StopCleanup>, stopped: bool) {
        let Some(StopCleanup { settlement, owner }) = cleanup else {
            return;
        };
        if !stopped {
            self.platform.retain(owner);
            return;
        }
        let result = self
            .complete_prepared(owner.streaming.clone(), Some(&owner.session_id), true)
            .await;
        if !result.complete {
            self.platform.retain(Owner {
                session_id: owner.session_id,
                streaming: result.streaming.clone(),
            });
        }
        settlement.finish(&result);
    }

    /// `commitCloudStatus`'s terminal owner: the ended show's cleanup, its
    /// failure said.
    pub(super) async fn settle_cloud_terminal(&self, owner: Owner) {
        if let Err(message) = self.settle_claimed_owner(owner).await {
            self.report_still_settling(&message);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[tokio::test]
    async fn a_broadcast_is_ended_once_and_a_retry_reads_the_answer() {
        let lifecycle = PlatformLifecycle::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let start = |calls: Arc<AtomicUsize>| {
            move || {
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    tokio::task::yield_now().await;
                    Ok::<Value, RpcError>(json!({ "message": "X broadcast ended." }))
                }
                .boxed()
            }
        };
        let key = broadcast_key(Some("a"), "b");
        let (first, second) = tokio::join!(
            lifecycle.once(
                |book| &mut book.x_end,
                key.clone(),
                start(Arc::clone(&calls))
            ),
            lifecycle.once(
                |book| &mut book.x_end,
                key.clone(),
                start(Arc::clone(&calls))
            ),
        );
        assert_eq!(first, second);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let cached = lifecycle
            .once(
                |book| &mut book.x_end,
                key.clone(),
                start(Arc::clone(&calls)),
            )
            .await;
        assert_eq!(cached, first);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // A publish of that broadcast makes its END due again.
        lifecycle.forget_x_end(&key);
        let _ = lifecycle
            .once(|book| &mut book.x_end, key, start(Arc::clone(&calls)))
            .await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_failed_end_is_not_cached_and_a_slow_one_is_rejoined() {
        let lifecycle = PlatformLifecycle::default();
        let key = broadcast_key(None, "b");
        let failed = lifecycle
            .once(
                |book| &mut book.youtube_complete,
                key.clone(),
                || async { Err::<Value, RpcError>(RpcError::new("m", "offline", "down")) }.boxed(),
            )
            .await;
        assert!(failed.is_err());
        let (release, wait) = tokio::sync::oneshot::channel::<()>();
        let slow = lifecycle.once(
            |book| &mut book.youtube_complete,
            key.clone(),
            move || {
                async move {
                    let _ = wait.await;
                    Ok::<Value, RpcError>(json!({ "lifecycleStatus": "complete" }))
                }
                .boxed()
            },
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(10), slow)
                .await
                .is_err()
        );
        let _ = release.send(());
        let rejoined = lifecycle
            .once(
                |book| &mut book.youtube_complete,
                key,
                || {
                    async {
                        Err::<Value, RpcError>(RpcError::new("m", "never", "a second request"))
                    }
                    .boxed()
                },
            )
            .await;
        assert_eq!(rejoined, Ok(json!({ "lifecycleStatus": "complete" })));
    }

    #[tokio::test]
    async fn one_owner_settles_at_a_time_and_a_dropped_one_frees_the_slot() {
        let lifecycle = PlatformLifecycle::default();
        let Begin::Run(first) = lifecycle.begin("s-1") else {
            panic!("the first settlement runs");
        };
        let Begin::Join(joining) = lifecycle.begin("s-1") else {
            panic!("the same owner joins");
        };
        assert!(matches!(lifecycle.begin("s-2"), Begin::Busy(_)));
        let result = CleanupResult {
            streaming: json!({}),
            complete: true,
        };
        first.finish(&result);
        assert_eq!(joined(joining).await, Ok(result));
        let Begin::Run(dropped) = lifecycle.begin("s-2") else {
            panic!("the slot is free");
        };
        let Begin::Join(joining) = lifecycle.begin("s-2") else {
            panic!("the same owner joins");
        };
        drop(dropped);
        assert_eq!(
            joined(joining).await,
            Err(LIVESTREAM_STILL_SETTLING.to_string())
        );
        assert!(matches!(lifecycle.begin("s-3"), Begin::Run(_)));
    }

    #[test]
    fn a_hand_off_drops_the_owner_and_moves_the_run_on() {
        let lifecycle = PlatformLifecycle::default();
        lifecycle.install(Owner {
            session_id: "s-1".into(),
            streaming: json!({}),
        });
        let run = lifecycle.run();
        assert!(!lifecycle.drop_handed_off(&["other".into()]));
        assert_eq!(lifecycle.run(), run);
        assert!(lifecycle.drop_handed_off(&["s-1".into()]));
        assert!(!lifecycle.holds_owner());
        assert_eq!(lifecycle.run(), run + 1);
    }

    #[tokio::test]
    async fn the_cleanup_waits_for_an_x_publish_in_flight() {
        let lifecycle = PlatformLifecycle::default();
        let mutation = lifecycle.begin_mutation("s-1");
        assert!(lifecycle.mutation_for("s-2").is_none());
        let mut done = lifecycle
            .mutation_for("s-1")
            .expect("the publish in flight");
        mutation.finish(&json!({ "published": true }));
        let streaming = done.wait_for(Option::is_some).await.unwrap().clone();
        assert_eq!(streaming, Some(json!({ "published": true })));
        assert!(lifecycle.mutation_for("s-1").is_none());
    }
}
