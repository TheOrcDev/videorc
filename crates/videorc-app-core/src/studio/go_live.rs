//! S3.5c: Go Live as the Studio runs it (`use-studio.tsx`:
//! `runGoLivePreflight` and `openGoLiveConfirmation` ~16069–16190,
//! `runGoLiveConfirmation` ~16299, `startOnReadyDestinations`,
//! `cancelGoLiveConfirmation`, `prepareOauthTargetsForGoLive` ~15725,
//! `activatePreparedYouTubeBroadcasts` ~14428, `activatePreparedXBroadcasts`,
//! `endPreparedXBroadcasts` and the YouTube completion in the stop).
//!
//! - **The dialog's state** (`GoLiveState`) lives on its own watch: open,
//!   pending with its phase, the preflight, a partial setup, the
//!   destinations left out of this livestream.
//! - **Opening** settles the output check, saves the stream details and asks
//!   the backend to judge every destination
//!   (`streamTargets.confirmation.validate`); a refusal says why.
//! - **Go live** asks again (a scheduled event that changed holds the
//!   start), prepares each signed-in destination on its platform (YouTube's
//!   broadcast, Twitch's and Kick's channel, X's source; a stream-key
//!   Twitch or Kick takes the title and category), then starts the session
//!   with what was prepared. A destination that couldn't be prepared leaves
//!   the dialog open with the ready ones offered.
//! - **On air**: YouTube's broadcast goes live once its ingest is active,
//!   X's is published; with the talk-show room open, each waits for the
//!   cloud's leg first. What the stop and the cleanup do is
//!   `platform_lifecycle`'s.

use std::time::Duration;

use serde_json::{Map, Value, json};

use super::platform_lifecycle::Mutation;
use super::{Studio, StudioBackend};
use crate::client::RpcError;
use crate::livestream::golive::{Phase, Preflight};
use crate::livestream::lifecycle::{
    self, PartialSetup, SetupDecision, SetupFailure, patch_prepared_target, status_patch,
};
use crate::livestream::platform_owner::{Owner, broadcast_key};
use crate::livestream::{go_live_copy, lifecycle_copy, methods, plan, ready::Topology};
use crate::notices::{NoticeAction, NoticeCommand, ToastRequest, XPlaybackEvent};
use crate::studio::session::SessionStartIntent;
use crate::user_error::{Failure, START_THE_X_BROADCAST, user_error_message};

/// S3.5e: X's playback check (`streamTargets.x.playback`), which the
/// backend sends after `x.publish` and again while it polls.
pub const X_PLAYBACK_EVENT: &str = "streamTargets.x.playback";

/// `streamTargets.youtube.prepare`'s quota refusal (plan 094, G5).
pub const YOUTUBE_QUOTA_PAUSED_CODE: &str = "youtube-quota-paused";
/// How long YouTube's ingest is waited for (`attempt < 8`, 2 s apart).
const YOUTUBE_INGEST_ATTEMPTS: usize = 8;
const YOUTUBE_INGEST_INTERVAL: Duration = Duration::from_secs(2);

/// The Go Live dialog's state.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct GoLiveState {
    pub open: bool,
    /// The preflight or a confirmed Go Live runs ("Checking…").
    pub pending: bool,
    pub phase: Option<Phase>,
    pub preflight: Option<Preflight>,
    /// Some destinations couldn't be set up; the ready ones are offered.
    pub partial: Option<PartialSetup>,
    /// Left out of this livestream only (B-8).
    pub excluded: Vec<String>,
    /// Destinations sent to sign in again: their row offers Check again.
    pub reconnected: Vec<String>,
}

/// One prepared answer's fields (`Prepared*` in `shared/capture-state.ts`).
pub(super) fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

pub(super) fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(super) fn target_value<'a>(streaming: &'a Value, id: &str) -> Option<&'a Value> {
    streaming
        .get("targets")
        .and_then(Value::as_array)?
        .iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(id))
}

impl<B: StudioBackend> Studio<B> {
    /// S3.5c: the Go Live dialog's state, as it changes.
    pub fn go_live(&self) -> tokio::sync::watch::Receiver<GoLiveState> {
        self.go_live_tx.subscribe()
    }

    pub fn go_live_now(&self) -> GoLiveState {
        self.go_live_tx.borrow().clone()
    }

    fn edit_go_live(&self, edit: impl FnOnce(&mut GoLiveState)) {
        self.go_live_tx.send_if_modified(|state| {
            let before = state.clone();
            edit(state);
            *state != before
        });
    }

    pub(super) fn edit_go_live_state(&self, edit: impl FnOnce(&mut GoLiveState)) {
        self.edit_go_live(edit);
    }

    /// `refuseStart`: Go Live asked while it cannot run. No destination
    /// ready gets the one fix (Open Destinations); anything else its reason.
    fn refuse_go_live(&self, reason: String) {
        let capture = self.snapshot().settings.capture_doc;
        let ready = lifecycle::ready_labels(&capture["streaming"]);
        let toast = if ready.is_empty() {
            ToastRequest::warning(go_live_copy::GO_LIVE_NO_DESTINATION_TITLE)
                .id("go-live-no-destination")
                .action(
                    go_live_copy::OPEN_DESTINATIONS_LABEL,
                    NoticeAction::OpenPage(crate::nav::PageId::Live),
                )
        } else {
            ToastRequest::warning(reason).id("session-start-blocked")
        };
        self.post(vec![NoticeCommand::Show(toast.finish())]);
    }

    /// `reportSessionStartFailure(…, goLive)`: a Go Live that failed before
    /// the start is a refused Go Live; Retry opens the dialog again.
    fn go_live_failed(&self, message: String) {
        let effects = {
            let mut inner = self.lock();
            inner.last_error = Some(message.clone());
            let intent =
                SessionStartIntent::livestream(inner.settings_view().capture.record_enabled);
            inner
                .session
                .fail_go_live(message, intent, std::time::Instant::now())
        };
        self.publish();
        self.emit_all(effects);
    }

    /// What this Go Live sends: the saved destinations minus the left-out.
    pub(super) fn sent_streaming(&self, excluded: &[String]) -> Value {
        let capture = self.snapshot().settings.capture_doc;
        lifecycle::streaming_without_targets(&capture["streaming"], excluded)
    }

    /// The output check settled for what this Go Live sends; the reason it
    /// can't go live, if any (`streamOutputTopologyBlockReason`).
    pub(super) async fn settle_output_check(&self, sent: &Value) -> Option<String> {
        let mut capture = self.snapshot().settings.capture_doc;
        capture["streaming"] = sent.clone();
        let params = plan::probe_params(&capture, false, false)?;
        // A check already running for this request is joined; one that
        // couldn't settle is no pass.
        match self.check_stream_output(params, false).await {
            Some(Topology::Ready { result, .. }) => {
                let split_rejected = result["outputRoles"]
                    .as_array()
                    .is_some_and(|roles| roles.iter().any(|r| r == "stream"))
                    && result["effectiveBridgeOutput"].as_str() == Some("raw-yuv420p");
                split_rejected.then(|| go_live_copy::SPLIT_UNAVAILABLE.to_string())
            }
            Some(Topology::Failed { message, .. }) => {
                Some(go_live_copy::output_check_failed(&message))
            }
            _ => Some(go_live_copy::output_check_failed(
                go_live_copy::OUTPUT_CHECK_UNSETTLED,
            )),
        }
    }

    /// `streamTargets.confirmation.validate` for what this Go Live sends.
    pub(super) async fn validate_go_live(&self, sent: &Value) -> Result<Preflight, RpcError> {
        let params = json!({
            "scheduledEventIds": lifecycle::scheduled_event_ids(sent),
            "streaming": sent,
        });
        let answer = self
            .backend
            .livestream_request(methods::CONFIRMATION_VALIDATE, params)
            .await?;
        super::backend::read_json(methods::CONFIRMATION_VALIDATE, answer)
    }

    /// `runGoLivePreflight`: the output check, the details saved and
    /// validated, every destination judged.
    pub(super) async fn go_live_preflight(&self, excluded: &[String]) -> Result<Preflight, String> {
        let sent = self.sent_streaming(excluded);
        if let Some(reason) = self.settle_output_check(&sent).await {
            return Err(reason);
        }
        self.save_draft_for_go_live()
            .await
            .map_err(|error| error.message)?;
        self.validate_go_live(&sent)
            .await
            .map_err(|error| error.message)
    }

    /// `openGoLiveConfirmation`: "Checking…" from the first click; the
    /// dialog opens on the preflight's answer. One at a time.
    pub async fn open_go_live(&self) {
        let state = self.go_live_now();
        if state.open || state.pending || self.session_owns_transport() {
            return;
        }
        if let Some(reason) = self.live_start_blocked_reason() {
            self.refuse_go_live(reason);
            return;
        }
        self.edit_go_live(|state| {
            *state = GoLiveState {
                pending: true,
                ..GoLiveState::default()
            };
        });
        match self.go_live_preflight(&[]).await {
            Ok(preflight) => self.edit_go_live(|state| {
                state.pending = false;
                state.preflight = Some(preflight);
                state.open = true;
            }),
            Err(message) => {
                self.edit_go_live(|state| state.pending = false);
                self.go_live_failed(message);
            }
        }
    }

    /// The preflight again (a destination left out or added back, Check
    /// again after a reconnect, a resolution); the dialog stays open.
    pub async fn recheck_go_live(&self) {
        let state = self.go_live_now();
        if !state.open || state.pending {
            return;
        }
        self.edit_go_live(|state| state.pending = true);
        let answer = self.go_live_preflight(&state.excluded).await;
        self.edit_go_live(|state| state.pending = false);
        match answer {
            Ok(preflight) => self.edit_go_live(|state| state.preflight = Some(preflight)),
            Err(message) => self.go_live_failed(message),
        }
    }

    /// `startBlockedReasonFor(LIVE_INTENT)` until L7's inspector lands
    /// (S1.6a part 5, `inspector::live_stream_blocked_reason`): the
    /// connection's reason. A running session is refused by the start itself.
    fn live_start_blocked_reason(&self) -> Option<String> {
        super::connection_blocked_reason(&self.snapshot().connection).map(str::to_string)
    }

    /// `cancelGoLiveConfirmation`: closes it (ignored while a confirmed Go
    /// Live runs); what a partial setup prepared is settled.
    pub async fn cancel_go_live(&self) {
        let state = self.go_live_now();
        if state.pending {
            return;
        }
        self.edit_go_live(|state| *state = GoLiveState::default());
        if let Some(partial) = state.partial {
            self.settle_prepared_platforms(partial.streaming).await;
        }
    }

    /// Leave a destination out of this livestream, add it back, or switch
    /// it to its stream key (`onResolveBlocker`), then check again.
    pub async fn resolve_go_live_blocker(&self, target_id: &str, resolution: &str) {
        match resolution {
            "exclude" | "include" => {
                let exclude = resolution == "exclude";
                self.edit_go_live(|state| {
                    state.excluded = crate::livestream::golive::update_exclusions(
                        &state.excluded,
                        target_id,
                        exclude,
                    );
                    state.partial = None;
                });
            }
            "manual-rtmp" => {
                let patch = crate::livestream::targets::TargetPatch::default()
                    .set("authMode", Value::String("manual-rtmp".into()));
                self.patch_stream_target(target_id, patch).await;
                self.edit_go_live(|state| state.partial = None);
            }
            _ => return,
        }
        self.recheck_go_live().await;
    }

    /// The streamer was sent to sign the platform in again.
    pub fn note_go_live_reconnect(&self, target_id: &str) {
        self.edit_go_live(|state| {
            if !state.reconnected.iter().any(|id| id == target_id) {
                state.reconnected.push(target_id.to_string());
            }
        });
    }

    /// `runGoLiveConfirmation`: Go live.
    pub async fn confirm_go_live(&self) {
        let state = self.go_live_now();
        if !state.open || state.pending || state.partial.is_some() {
            return;
        }
        self.edit_go_live(|state| {
            state.pending = true;
            state.phase = Some(Phase::Checking);
        });
        let outcome = self
            .confirm_once(state.preflight.as_ref(), &state.excluded)
            .await;
        self.edit_go_live(|state| {
            state.pending = false;
            state.phase = None;
        });
        match outcome {
            Ok(Some(streaming)) => self.start_prepared(streaming).await,
            Ok(None) => {}
            Err(message) => self.go_live_failed(message),
        }
    }

    /// The confirmation up to the start: `Some(streaming)` to start with.
    async fn confirm_once(
        &self,
        previous: Option<&Preflight>,
        excluded: &[String],
    ) -> Result<Option<Value>, String> {
        let sent = self.sent_streaming(excluded);
        self.save_draft_for_go_live()
            .await
            .map_err(|error| error.message)?;
        let preflight = self
            .validate_go_live(&sent)
            .await
            .map_err(|error| error.message)?;
        let fingerprint = |preflight: Option<&Preflight>, id: &str| {
            preflight
                .and_then(|p| p.destinations.iter().find(|d| d.target_id == id))
                .and_then(|d| d.scheduled.as_ref())
                .and_then(|s| s.get("fingerprint").cloned())
        };
        let changed = preflight.destinations.iter().any(|destination| {
            destination.scheduled.is_some()
                && fingerprint(previous, &destination.target_id)
                    != destination
                        .scheduled
                        .as_ref()
                        .and_then(|s| s.get("fingerprint").cloned())
        });
        self.edit_go_live(|state| state.preflight = Some(preflight.clone()));
        if changed {
            self.post(vec![NoticeCommand::Show(
                ToastRequest::warning(go_live_copy::SCHEDULED_EVENT_CHANGED)
                    .description(go_live_copy::SCHEDULED_EVENT_CHANGED_DESCRIPTION)
                    .finish(),
            )]);
            return Ok(None);
        }
        // Blocked: the fresh preflight says what to fix.
        if !preflight.valid {
            return Ok(None);
        }
        if let Some(reason) = self.settle_output_check(&sent).await {
            return Err(reason);
        }
        let setup = self.prepare_targets(&preflight, excluded).await?;
        match lifecycle::decide_prepared_setup(setup) {
            SetupDecision::Start(streaming) => Ok(Some(streaming)),
            SetupDecision::Partial(setup) => {
                self.edit_go_live(|state| state.partial = Some(setup));
                Ok(None)
            }
            SetupDecision::NoReadyDestinations => {
                Err(go_live_copy::NO_READY_AFTER_SETUP.to_string())
            }
        }
    }

    /// `continueGoLiveWithReadyDestinations`: "Go live on {ready}".
    pub async fn continue_go_live_partial(&self) {
        let state = self.go_live_now();
        let Some(partial) = state.partial.clone() else {
            return;
        };
        if state.pending {
            return;
        }
        self.start_prepared(partial.streaming).await;
    }

    /// The start with what was prepared; then YouTube and X go live.
    async fn start_prepared(&self, streaming: Value) {
        self.edit_go_live(|state| {
            state.pending = true;
            state.phase = Some(Phase::Starting);
        });
        let typed = match serde_json::from_value::<videorc_protocol::streaming::StreamingSettings>(
            streaming.clone(),
        ) {
            Ok(typed) => typed,
            Err(error) => {
                self.edit_go_live(|state| {
                    state.pending = false;
                    state.phase = None;
                });
                self.go_live_failed(format!("The livestream settings didn't read: {error}"));
                return;
            }
        };
        // The dialog closes as the start goes (`setGoLiveConfirmationOpen(false)`).
        self.edit_go_live(|state| *state = GoLiveState::default());
        let record = self.snapshot().settings.capture.record_enabled;
        // The run this Go Live's activations belong to, read before the
        // start (`lifecycleRunId`): a stop that waited for the start claims
        // the owner it installed and moves the run on, and no activation
        // starts after it.
        let run = self.platform.run();
        // The start installs the session's owner from its answer, before a
        // waiting stop runs (`sessionStartInFlightRef`).
        let outcome = self
            .start_via(
                SessionStartIntent::livestream(record),
                Some(typed),
                super::StartVia {
                    rpc: super::StartRpc::SessionStart,
                    owner: Some(streaming.clone()),
                },
            )
            .await;
        let session_id = self
            .snapshot()
            .session
            .status
            .session_id
            .clone()
            .filter(|id| !id.is_empty());
        let (super::StartOutcome::Started, Some(session_id)) = (outcome, session_id) else {
            // A refused start leaves no broadcast behind.
            self.settle_prepared_platforms(streaming).await;
            return;
        };
        self.activate_platforms(streaming, Some(session_id), run)
            .await;
    }

    /// The scripted tests' Go Live from the start on: what the dialog
    /// prepared goes out, the owner is installed by the start, then the
    /// activation.
    #[doc(hidden)]
    pub async fn start_prepared_for_tests(&self, streaming: Value) {
        self.start_prepared(streaming).await;
    }

    /// `resumeCloudShow` (plan 184 C5b): the Resume notice for a solo show
    /// that is live on Videorc Cloud. The runner holds every platform leg,
    /// so nothing is set up again: no dialog, no preflight, no metadata
    /// update, no broadcast (a new YouTube broadcast here split the live one
    /// and its VOD). The saved destinations go along as rows only; the
    /// backend binds the start to the show (`cloud.show.resume`) and feeds
    /// its ingest. Same guards as Go Live: busy, or blocked for a reason.
    /// True when the session runs.
    pub async fn resume_cloud_show(&self) -> bool {
        let state = self.go_live_now();
        if state.open || state.pending || self.start_in_flight() {
            return false;
        }
        if let Some(reason) = self.live_start_blocked_reason() {
            self.refuse_go_live(reason);
            return false;
        }
        let (intent, streaming) = {
            let capture = self.snapshot().settings.capture;
            (
                SessionStartIntent::livestream(capture.record_enabled),
                capture.streaming,
            )
        };
        let outcome = self
            .start_via(
                intent,
                streaming,
                super::StartVia {
                    rpc: super::StartRpc::CloudShowResume,
                    owner: None,
                },
            )
            .await;
        outcome == super::StartOutcome::Started
    }

    /// The scripted tests' way onto the air without a whole Go Live: the
    /// session's owner installed with `streaming`, then the activation, as
    /// after a Go Live's start.
    #[doc(hidden)]
    pub async fn activate_prepared_for_tests(&self, streaming: Value, session_id: &str) {
        self.platform.install(Owner {
            session_id: session_id.to_string(),
            streaming: streaming.clone(),
        });
        let run = self.platform.run();
        self.activate_platforms(streaming, Some(session_id.to_string()), run)
            .await;
    }

    /// The prepared statuses into the saved config too.
    pub(super) async fn save_target_patch(&self, target_id: &str, patch: Map<String, Value>) {
        let id = target_id.to_string();
        let now = now_iso();
        let _ = self
            .update_capture_config(move |config| {
                if let Some(streaming) = config.get_mut("streaming") {
                    patch_prepared_target(streaming, &id, &patch, &now);
                }
                crate::livestream::targets::bridge_streaming_to_legacy(config);
            })
            .await;
    }

    /// `prepareOauthTargetsForGoLive`.
    pub(super) async fn prepare_targets(
        &self,
        preflight: &Preflight,
        excluded: &[String],
    ) -> Result<PartialSetup, String> {
        if !self.settle_previous_platform_lifecycle().await {
            return Err(lifecycle_copy::LIVESTREAM_STILL_SETTLING.to_string());
        }
        let capture = self.snapshot().settings.capture_doc;
        let mut next = capture["streaming"].clone();
        let recording = plan::recording_video(&capture);
        let go_live = plan::go_live_plan(&capture, &recording, false);
        let mut failures = Vec::new();
        let targets = crate::livestream::targets::targets(&capture);
        let sent: Vec<_> = targets
            .iter()
            .filter(|t| t.enabled && !excluded.contains(&t.id))
            .collect();
        for target in sent.iter().filter(|t| t.auth_mode == "oauth") {
            self.edit_go_live(|state| {
                state.phase = Some(Phase::Preparing(target.platform.clone()))
            });
            let video = go_live
                .targets
                .iter()
                .find(|(id, ..)| *id == target.id)
                .map(|(.., vertical, video)| {
                    let video = if *vertical {
                        video.vertical()
                    } else {
                        video.clone()
                    };
                    json!({
                        "preset": video.preset,
                        "width": video.width,
                        "height": video.height,
                        "fps": video.fps,
                        "bitrateKbps": video.bitrate_kbps,
                    })
                });
            let fingerprint = preflight
                .destinations
                .iter()
                .find(|d| d.target_id == target.id)
                .and_then(|d| d.scheduled.as_ref())
                .and_then(|s| s.get("fingerprint").cloned());
            let answer = self.prepare_target(target, video, fingerprint).await;
            let now = now_iso();
            match answer {
                Ok(patch) => {
                    patch_prepared_target(&mut next, &target.id, &patch, &now);
                    self.save_target_patch(&target.id, patch).await;
                }
                Err(error) => {
                    let quota = error.code == YOUTUBE_QUOTA_PAUSED_CODE;
                    let mut patch =
                        status_patch(if quota { "warning" } else { "failed" }, &error.message);
                    patch.insert("enabled".into(), Value::Bool(false));
                    patch_prepared_target(&mut next, &target.id, &patch, &now);
                    // As Electron's: the saved destination goes off, saying why.
                    self.save_target_patch(&target.id, patch).await;
                    failures.push(SetupFailure {
                        target_id: target.id.clone(),
                        platform: target.platform.clone(),
                        label: target.label.clone(),
                        message: error.message,
                        manual_fallback: quota,
                    });
                }
            }
        }
        // A stream-key Twitch or Kick still takes the title and category
        // through the signed-in account (best effort).
        let platforms = self.platforms_now();
        for target in sent
            .iter()
            .filter(|t| t.auth_mode != "oauth" && matches!(t.platform.as_str(), "twitch" | "kick"))
        {
            let twitch = target.platform == "twitch";
            let Some(account) = platforms.account(&target.platform) else {
                if twitch {
                    let patch = status_patch("ready", go_live_copy::TWITCH_KEY_NO_ACCOUNT);
                    patch_prepared_target(&mut next, &target.id, &patch, &now_iso());
                }
                continue;
            };
            let method = if twitch {
                methods::TWITCH_APPLY_METADATA
            } else {
                methods::KICK_APPLY_METADATA
            };
            let message = match self
                .backend
                .livestream_request(method, json!({ "accountId": account.account_id }))
                .await
            {
                Ok(applied) => go_live_copy::channel_metadata_updated(
                    twitch,
                    &text(&applied, "title").unwrap_or_default(),
                ),
                Err(error) => go_live_copy::channel_metadata_failed(&error.message),
            };
            let patch = status_patch("ready", &message);
            patch_prepared_target(&mut next, &target.id, &patch, &now_iso());
        }
        let _ = self.refresh_platform_accounts().await;
        let prepared = lifecycle::streaming_without_targets(&next, excluded);
        Ok(PartialSetup {
            ready_labels: lifecycle::ready_labels(&prepared),
            streaming: prepared,
            failures,
        })
    }

    /// One signed-in destination prepared on its platform: the target's
    /// patch.
    async fn prepare_target(
        &self,
        target: &crate::livestream::targets::Target,
        video: Option<Value>,
        fingerprint: Option<Value>,
    ) -> Result<Map<String, Value>, RpcError> {
        let account = target.account_id.clone();
        let scheduled = target.scheduled_event_id.clone();
        let attempt = scheduled.as_ref().map(|_| uuid::Uuid::new_v4().to_string());
        let scheduled_prepare = json!({
            "accountId": account,
            "confirmationFingerprint": fingerprint,
            "attemptId": attempt,
            "targetId": target.id,
            "video": video,
        });
        let mut patch = Map::new();
        let ready = |message: &str| json!({ "state": "ready", "message": message });
        match target.platform.as_str() {
            "youtube" => {
                if let Some(reason) =
                    crate::livestream::accounts::oauth_unavailable_reason("youtube")
                {
                    return Err(RpcError::new(
                        "streamTargets.youtube.prepare",
                        "unavailable",
                        reason,
                    ));
                }
                let prepared = match &scheduled {
                    Some(event) => {
                        self.scheduled_operation(
                            "prepareForGoLive",
                            event,
                            scheduled_prepare.clone(),
                        )
                        .await?
                    }
                    None => self
                        .backend
                        .livestream_request(
                            methods::YOUTUBE_PREPARE,
                            json!({ "accountId": account, "targetId": target.id, "video": video }),
                        )
                        .await?,
                };
                // A fresh broadcast's completion is due again.
                if let Some(broadcast) = prepared.get("broadcastId").and_then(Value::as_str) {
                    self.platform.forget_youtube_completion(&broadcast_key(
                        prepared.get("accountId").and_then(Value::as_str),
                        broadcast,
                    ));
                }
                if scheduled.is_some() {
                    patch.insert("scheduledAttemptId".into(), json!(attempt));
                    patch.insert("scheduledEventTitle".into(), json!(prepared.get("title")));
                    patch.insert("scheduledPrivacy".into(), json!(prepared.get("privacy")));
                    patch.insert(
                        "scheduledStartUtc".into(),
                        json!(prepared.get("scheduledStartTime")),
                    );
                }
                patch.insert(
                    "platformBroadcastId".into(),
                    json!(prepared.get("broadcastId")),
                );
                patch.insert("platformStreamId".into(), json!(prepared.get("streamId")));
                patch.insert("status".into(), ready(go_live_copy::YOUTUBE_PREPARED));
                Self::prepared_common(&mut patch, &prepared);
            }
            "twitch" | "kick" => {
                let twitch = target.platform == "twitch";
                let prepared = self
                    .backend
                    .livestream_request(
                        if twitch {
                            methods::TWITCH_PREPARE
                        } else {
                            methods::KICK_PREPARE
                        },
                        json!({ "accountId": account }),
                    )
                    .await?;
                patch.insert("platformBroadcastId".into(), Value::Null);
                patch.insert("platformStreamId".into(), Value::Null);
                patch.insert(
                    "status".into(),
                    ready(if twitch {
                        go_live_copy::TWITCH_PREPARED
                    } else {
                        go_live_copy::KICK_PREPARED
                    }),
                );
                Self::prepared_common(&mut patch, &prepared);
            }
            "x" => {
                let prepared = match &scheduled {
                    Some(event) => {
                        self.scheduled_operation(
                            "prepareForGoLive",
                            event,
                            scheduled_prepare.clone(),
                        )
                        .await?
                    }
                    None => {
                        self.backend
                            .livestream_request(methods::X_PREPARE, json!({ "accountId": account }))
                            .await?
                    }
                };
                if scheduled.is_some() {
                    patch.insert("scheduledAttemptId".into(), json!(attempt));
                }
                patch.insert("platformBroadcastId".into(), json!(prepared.get("region")));
                patch.insert("platformStreamId".into(), json!(prepared.get("sourceId")));
                let message = if scheduled.is_some() {
                    go_live_copy::SAVED_X_PREPARED
                } else if prepared.get("isStreamActive").and_then(Value::as_bool) == Some(true) {
                    go_live_copy::X_PREPARED_ACTIVE
                } else {
                    go_live_copy::X_PREPARED
                };
                patch.insert("status".into(), ready(message));
                Self::prepared_common(&mut patch, &prepared);
            }
            _ => {}
        }
        Ok(patch)
    }

    /// The fields every prepared answer carries.
    fn prepared_common(patch: &mut Map<String, Value>, prepared: &Value) {
        for key in [
            "accountId",
            "accountLabel",
            "serverUrl",
            "streamKeySecretRef",
        ] {
            if let Some(value) = prepared.get(key).filter(|v| !v.is_null()) {
                patch.insert(key.into(), value.clone());
            }
        }
        patch.insert("streamKeyPresent".into(), Value::Bool(true));
    }

    /// On air: YouTube's broadcasts go live once their ingest is active
    /// (`activatePreparedYouTubeBroadcasts`), X's are published.
    /// `run` is the lifecycle run the activations belong to: once a stop, a
    /// hand-off or the show's end moved it on, nothing more is activated.
    pub(super) async fn activate_platforms(
        &self,
        mut streaming: Value,
        session_id: Option<String>,
        run: u64,
    ) {
        let talk_show = self.talk_show_room_open();
        for id in lifecycle::youtube_activation_targets(&streaming) {
            if self.platform.run() != run {
                return;
            }
            let Some(target) = target_value(&streaming, &id).cloned() else {
                continue;
            };
            let account = text(&target, "accountId");
            let broadcast = text(&target, "platformBroadcastId");
            let stream = text(&target, "platformStreamId");
            let scheduled = text(&target, "scheduledEventId");
            self.save_target_patch(
                &id,
                status_patch("connecting", go_live_copy::WAITING_FOR_YOUTUBE_INGEST),
            )
            .await;
            // `Ok(None)`: a stop, a hand-off or the show's end overtook it,
            // and the cleanup owns the destination's status from here.
            let result: Result<Option<Mutation>, RpcError> = async {
                if let (true, Some(show)) = (talk_show, &session_id) {
                    self.wait_for_cloud_provider_output(show, &id, run).await?;
                }
                if scheduled.is_none() {
                    let mut active = false;
                    let mut last = None;
                    for attempt in 0..YOUTUBE_INGEST_ATTEMPTS {
                        if !self.session_owns_transport() || self.platform.run() != run {
                            return Ok(None);
                        }
                        let status = self
                            .backend
                            .livestream_request(
                                methods::YOUTUBE_STREAM_STATUS,
                                json!({ "accountId": account, "streamId": stream }),
                            )
                            .await?;
                        // A stop that finished during the read wrote the
                        // destination's last status; a late reply never
                        // overwrites it.
                        if !self.session_owns_transport() || self.platform.run() != run {
                            return Ok(None);
                        }
                        active = status.get("active").and_then(Value::as_bool) == Some(true);
                        last = text(&status, "message");
                        self.save_target_patch(
                            &id,
                            status_patch(
                                if active { "connecting" } else { "warning" },
                                last.as_deref().unwrap_or_default(),
                            ),
                        )
                        .await;
                        if active {
                            break;
                        }
                        if attempt + 1 < YOUTUBE_INGEST_ATTEMPTS {
                            tokio::time::sleep(YOUTUBE_INGEST_INTERVAL).await;
                        }
                    }
                    if !active {
                        return Err(RpcError::new(
                            methods::YOUTUBE_STREAM_STATUS,
                            "not-active",
                            last.unwrap_or_else(|| go_live_copy::YOUTUBE_INGEST_NOT_ACTIVE.to_string()),
                        ));
                    }
                }
                // The LIVE transition (or the saved event's activate) is the
                // session's mutation: a stop that began during the ingest
                // reads stops it here, and a later one completes only after
                // it answers, so LIVE and COMPLETE never overlap.
                let Some(mutation) = self.platform.begin_mutation(session_id.as_deref(), run)
                else {
                    return Ok(None);
                };
                match &scheduled {
                    Some(event) => {
                        self.scheduled_operation(
                            "activate",
                            event,
                            json!({
                                "attemptId": text(&target, "scheduledAttemptId"),
                                "sessionId": session_id,
                            }),
                        )
                        .await?;
                    }
                    None => {
                        let result = self
                            .backend
                            .livestream_request(
                                methods::YOUTUBE_TRANSITION,
                                json!({ "accountId": account, "broadcastId": broadcast, "status": "live" }),
                            )
                            .await?;
                        // `assertYouTubeTransitionConfirmed(result, 'live')`.
                        lifecycle::youtube_transition_confirmed(&result, "live").map_err(
                            |message| {
                                RpcError::new(methods::YOUTUBE_TRANSITION, "not-confirmed", message)
                            },
                        )?;
                    }
                }
                Ok(Some(mutation))
            }
            .await;
            let patch = match result {
                Ok(None) => return,
                Ok(Some(mutation)) => {
                    let patch = status_patch("live", go_live_copy::YOUTUBE_LIVE);
                    patch_prepared_target(&mut streaming, &id, &patch, &now_iso());
                    mutation.finish(&streaming, None);
                    if self.platform.run() != run {
                        return;
                    }
                    self.save_target_patch(&id, patch).await;
                    continue;
                }
                Err(_) if self.platform.run() != run => return,
                Err(error) => {
                    let message = if error.code == YOUTUBE_QUOTA_PAUSED_CODE {
                        error.message.clone()
                    } else {
                        go_live_copy::youtube_needs_review(&error.message)
                    };
                    self.toast_youtube_broadcast(true, &id, &target, &error.message);
                    status_patch("warning", &message)
                }
            };
            patch_prepared_target(&mut streaming, &id, &patch, &now_iso());
            if let Some(session_id) = &session_id {
                self.platform.update_streaming(session_id, &streaming);
            }
            self.save_target_patch(&id, patch).await;
        }
        for id in lifecycle::x_activation_targets(&streaming) {
            if self.platform.run() != run {
                return;
            }
            let Some(target) = target_value(&streaming, &id).cloned() else {
                continue;
            };
            if text(&target, "platformStreamId").is_none()
                || text(&target, "platformBroadcastId").is_none()
            {
                continue;
            }
            self.save_target_patch(
                &id,
                status_patch("connecting", go_live_copy::WAITING_FOR_X_INGEST),
            )
            .await;
            let waited = match (talk_show, &session_id) {
                (true, Some(show)) => self.wait_for_cloud_provider_output(show, &id, run).await,
                _ => Ok(()),
            };
            if self.platform.run() != run {
                return;
            }
            // The publish is the session's mutation, admitted after every
            // awaited preparation and right before the request: a stop that
            // began during the save or the cloud wait stops it here, and a
            // later one ends the broadcast only after the publish answers.
            let mutation = match &waited {
                Ok(()) => match self.platform.begin_mutation(session_id.as_deref(), run) {
                    Some(mutation) => Some(mutation),
                    None => return,
                },
                Err(_) => None,
            };
            // S3.5d: a saved X broadcast goes live through its schedule
            // (`scheduledStreams.activate`, as Electron's
            // `scheduledTargetOperation('activate')`), never through the
            // instant publish.
            let published = match (waited, text(&target, "scheduledEventId")) {
                (Err(error), _) => Err(error),
                (Ok(()), Some(event)) => {
                    self.scheduled_operation(
                        "activate",
                        &event,
                        json!({
                            "attemptId": text(&target, "scheduledAttemptId"),
                            "sessionId": session_id,
                        }),
                    )
                    .await
                }
                (Ok(()), None) => {
                    let params = json!({
                        "accountId": text(&target, "accountId"),
                        "sourceId": text(&target, "platformStreamId"),
                        "sessionId": session_id,
                    });
                    self.backend
                        .livestream_request(methods::X_PUBLISH, params)
                        .await
                }
            };
            match published {
                Ok(published) => {
                    let share_url = published["shareUrl"].as_str().unwrap_or_default();
                    let mut patch = status_patch("live", &go_live_copy::x_live(share_url));
                    patch["status"]["redactedUrl"] = Value::String(share_url.to_string());
                    if let Some(account) = published.get("accountId").filter(|v| !v.is_null()) {
                        patch.insert("accountId".into(), account.clone());
                    }
                    if let Some(broadcast) = published.get("broadcastId").filter(|v| !v.is_null()) {
                        patch.insert("platformBroadcastId".into(), broadcast.clone());
                    }
                    if let Some(media_key) = published.get("mediaKey").filter(|v| !v.is_null()) {
                        patch.insert("platformStreamId".into(), media_key.clone());
                    }
                    patch_prepared_target(&mut streaming, &id, &patch, &now_iso());
                    // The published broadcast's END is due again, committed
                    // with the owner before a waiting cleanup hears of it.
                    let x_end_due =
                        published
                            .get("broadcastId")
                            .and_then(Value::as_str)
                            .map(|broadcast| {
                                broadcast_key(
                                    published.get("accountId").and_then(Value::as_str),
                                    broadcast,
                                )
                            });
                    if let Some(mutation) = mutation {
                        mutation.finish(&streaming, x_end_due.as_deref());
                    }
                    if self.platform.run() != run {
                        return;
                    }
                    self.save_target_patch(&id, patch).await;
                    // S3.2f: X's chat follows the broadcast (`liveChat.x.start`,
                    // only with a session); when it can't, the stream goes on
                    // and a warning says so (`showXBroadcastProblem('chat')`).
                    let Some(chat_session) = session_id.as_ref() else {
                        continue;
                    };
                    if let Err(error) = self
                        .backend
                        .livestream_request(
                            methods::X_CHAT_START,
                            json!({
                                "sessionId": chat_session,
                                "broadcastId": published.get("broadcastId").cloned().unwrap_or(Value::Null),
                                "mediaKey": published.get("mediaKey").cloned().unwrap_or(Value::Null),
                                "targetId": id,
                            }),
                        )
                        .await
                    {
                        let label = text(&target, "label").unwrap_or_else(|| id.clone());
                        self.config
                            .logger
                            .warn(format!("[x] chat failed for {label}: {}", error.message));
                        self.post(vec![NoticeCommand::Show(
                            ToastRequest::warning(go_live_copy::x_chat_not_connected(&label))
                            .id(format!("x-chat:{id}"))
                            .description(go_live_copy::X_CHAT_NOT_CONNECTED_DESCRIPTION)
                            .action(
                                go_live_copy::OPEN_DESTINATIONS_LABEL,
                                NoticeAction::OpenPage(crate::nav::PageId::Live),
                            )
                            .finish(),
                        )]);
                    }
                }
                Err(error) => {
                    if let Some(mutation) = mutation {
                        mutation.finish(&streaming, None);
                    }
                    // `showXBroadcastProblem('start')`: a warning, the
                    // stream goes on.
                    let copy =
                        user_error_message(Failure::Rpc(&error), Some(START_THE_X_BROADCAST));
                    self.post(vec![NoticeCommand::Show(
                        ToastRequest::warning(copy.title)
                            .id(format!("x-broadcast-start:{id}"))
                            .description(copy.description)
                            .finish(),
                    )]);
                    let patch =
                        status_patch("warning", &go_live_copy::x_needs_review(&error.message));
                    patch_prepared_target(&mut streaming, &id, &patch, &now_iso());
                    self.save_target_patch(&id, patch).await;
                }
            }
        }
        self.remind_x_producer(&streaming);
    }

    /// The X producer reminder: an X stream key only feeds X; the broadcast
    /// starts in Media Studio. Once per livestream (its activation).
    fn remind_x_producer(&self, streaming: &Value) {
        let x_feed = lifecycle::typed_targets(streaming)
            .iter()
            .any(|t| t.platform == "x" && t.enabled && t.auth_mode == "manual-rtmp");
        if !x_feed {
            return;
        }
        self.post(vec![NoticeCommand::Show(
            ToastRequest::info(go_live_copy::X_FEED_CONNECTED)
                .description(go_live_copy::X_FEED_CONNECTED_DESCRIPTION)
                .duration(crate::notices::NoticeLifetime::For(Duration::from_secs(20)))
                .action(
                    go_live_copy::OPEN_MEDIA_STUDIO,
                    NoticeAction::OpenUrl {
                        url: go_live_copy::X_MEDIA_STUDIO_URL.to_string(),
                    },
                )
                .finish(),
        )]);
    }

    /// S3.5e: X's playback check (`streamTargets.x.playback`): the signed-in
    /// X destination's line says whether viewers can watch, and a toast
    /// says it once per broadcast and status.
    pub(super) async fn apply_x_playback(&self, payload: &Value) {
        let event = match serde_json::from_value::<XPlaybackEvent>(payload.clone()) {
            Ok(event) => event,
            Err(error) => {
                self.config.logger.warn(format!(
                    "Studio: \"{X_PLAYBACK_EVENT}\" did not read ({error})."
                ));
                return;
            }
        };
        let (state, message) = match event.status.as_str() {
            "verified" => ("live", lifecycle_copy::x_watchable(&event.share_url)),
            "pending" => ("warning", lifecycle_copy::X_PROVISIONING.to_string()),
            _ => ("warning", lifecycle_copy::X_NEVER_PLAYED.to_string()),
        };
        let capture = self.snapshot().settings.capture_doc;
        let target = crate::livestream::targets::targets(&capture)
            .into_iter()
            .find(|t| t.platform == "x" && t.enabled && t.auth_mode == "oauth");
        if let Some(target) = target {
            let mut patch = status_patch(state, &message);
            patch["status"]["redactedUrl"] = Value::String(event.share_url.clone());
            self.save_target_patch(&target.id, patch).await;
        }
        let commands = self
            .lock()
            .notices
            .on_x_playback(&event, std::time::Instant::now());
        self.post(commands);
    }

    /// `showYouTubeBroadcastToast`.
    pub(super) fn toast_youtube_broadcast(
        &self,
        start: bool,
        id: &str,
        target: &Value,
        message: &str,
    ) {
        let (title, description) = go_live_copy::youtube_broadcast_toast(
            start,
            &text(target, "label").unwrap_or_default(),
            message,
        );
        let step = if start { "start" } else { "end" };
        self.post(vec![NoticeCommand::Show(
            ToastRequest::warning(title)
                .id(format!("youtube-broadcast-{step}:{id}"))
                .description(description)
                .finish(),
        )]);
    }

    /// `scheduledTargetOperation`: the event's revision, the operation, and
    /// its answer once it settles (500 ms polls, three minutes at most).
    pub(crate) async fn scheduled_operation(
        &self,
        action: &str,
        event_id: &str,
        fields: Value,
    ) -> Result<Value, RpcError> {
        let event = self
            .backend
            .livestream_request(methods::SCHEDULED_GET, json!({ "eventId": event_id }))
            .await?;
        let mut params = json!({
            "eventId": event_id,
            "expectedRevision": event.get("revision"),
        });
        if let (Some(params), Some(fields)) = (params.as_object_mut(), fields.as_object()) {
            for (key, value) in fields {
                params.insert(key.clone(), value.clone());
            }
        }
        // S3.5d: Upcoming's operation runner follows it to its end.
        self.run_scheduled_operation(action, params).await
    }

    /// Whether the platform lifecycle holds a prepared livestream.
    pub fn go_live_prepared(&self) -> bool {
        self.platform.holds_owner()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_target_is_found_by_its_id() {
        let streaming = json!({ "targets": [{ "id": "a", "x": 1 }, { "id": "b" }] });
        assert_eq!(target_value(&streaming, "a").unwrap()["x"], json!(1));
        assert!(target_value(&streaming, "c").is_none());
        assert!(now_iso().ends_with('Z'));
    }
}
