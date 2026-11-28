//! Going live without the dialog (plan 209 S10, D13; Electron's
//! `lib/go-live-headless.ts` and `studio-actions/run-the-show.ts`'s `goLive`).
//!
//! Runs the Go Live dialog's own preflight, gate, and confirm without opening
//! the dialog (`GoLiveState::open` stays false), honours `destinations`,
//! `title`, `allowPartial`, `withoutCaptions`, `allowNonPublic`, and stops
//! cleanly if `agent.intent.cancel` arrives before confirm or before start.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};
use videorc_protocol::streaming::StreamingSettings;

use super::agent::AgentIntentOutcome;
use super::captions_readiness;
use super::go_live::GoLiveState;
use super::remote::copy as remote_copy;
use super::session::SessionStartIntent;
use super::{Studio, StudioBackend, connection_blocked_reason};
use crate::account::entitlements::go_live_entitlement_gate;
use crate::livestream::accounts::{destination_label, platform_label};
use crate::livestream::details::MetadataDraft;
use crate::livestream::go_live_privacy;
use crate::livestream::golive::{self, Phase, Preflight};
use crate::livestream::lifecycle::{self, PartialSetup, SetupDecision};
use crate::livestream::targets::{Target, targets as stream_targets};

pub mod copy {
    pub const DIALOG_OPEN: &str =
        "The Go Live dialog is open in Videorc. Finish or cancel it there.";
    pub const IN_FLIGHT: &str = "Videorc is already going live.";
    pub const NO_DESTINATION: &str = "No destination is on. Turn one on in Destinations → Setup.";
    pub const DRAFT_LOADING: &str =
        "Videorc is still loading your stream details. Try again in a moment.";
    pub const CAPTIONS_TITLE: &str = "Captions can't start";
    pub const ALLOW_PARTIAL_HINT: &str = "Pass allowPartial: true to go live on the ready ones.";
    pub const WITHOUT_CAPTIONS_HINT: &str = "Pass withoutCaptions: true to go live without them.";
    pub const SCHEDULED_CHANGED: &str = "The scheduled event changed. Review its updated visibility and details in Videorc, then go live again.";
    pub const SETUP_FAILED: &str = "Some destinations couldn't be set up";
    pub const DID_NOT_START: &str = "The livestream didn't start. Check Studio on your computer.";
    pub const CANCELLED: &str = "Agents were stopped in Videorc, so it didn't go live.";
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeadlessDecision {
    Confirm,
    Exclude(Vec<String>),
    Refuse(String),
}

/// Joins non-empty parts with one space, ensuring each ends with punctuation.
fn sentences(parts: &[String]) -> String {
    parts
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| {
            if s.ends_with('.') || s.ends_with('!') || s.ends_with('?') || s.ends_with('…') {
                s.to_string()
            } else {
                format!("{s}.")
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Computes which enabled targets to exclude for `go_live`'s optional
/// `destinations` filter (`headlessExclusions`).
pub fn headless_exclusions(
    targets: &[Target],
    destinations: Option<&[String]>,
) -> Result<Vec<String>, String> {
    let Some(destinations) = destinations.filter(|d| !d.is_empty()) else {
        return Ok(Vec::new());
    };
    let on: Vec<&Target> = targets.iter().filter(|t| t.enabled).collect();
    let mut named = HashSet::new();
    for raw in destinations {
        let name = raw.trim();
        if let Some(by_id) = targets.iter().find(|t| t.id == name) {
            if !by_id.enabled {
                return Err(format!(
                    "{} is off. Turn it on in Destinations → Setup first.",
                    destination_label(&by_id.label)
                ));
            }
            named.insert(by_id.id.clone());
            continue;
        }
        let lower = name.to_lowercase();
        let by_platform: Vec<&&Target> = on.iter().filter(|t| t.platform == lower).collect();
        if by_platform.is_empty() {
            return Err(format!(
                "No destination that is on matches \"{name}\". Use an id from list_destinations."
            ));
        }
        for target in by_platform {
            named.insert(target.id.clone());
        }
    }
    Ok(on
        .into_iter()
        .filter(|t| !named.contains(&t.id))
        .map(|t| t.id.clone())
        .collect())
}

/// Inputs to [`decide_headless_go_live`].
pub struct HeadlessGoLiveInput<'a> {
    pub preflight: &'a Preflight,
    pub draft: Option<&'a MetadataDraft>,
    pub sent_targets: &'a [Target],
    pub captions_blocks_start: bool,
    pub captions_description: &'a str,
    pub entitlement_reason: Option<String>,
    pub allow_partial: bool,
    pub allow_non_public: bool,
}

/// Applies the dialog's confirm gate headlessly (`decideHeadlessGoLive`).
pub fn decide_headless_go_live(input: HeadlessGoLiveInput<'_>) -> HeadlessDecision {
    let HeadlessGoLiveInput {
        preflight,
        draft,
        sent_targets,
        captions_blocks_start,
        captions_description,
        entitlement_reason,
        allow_partial,
        allow_non_public,
    } = input;
    let gate = golive::confirm_gate(
        Some(preflight),
        draft,
        sent_targets,
        captions_blocks_start,
        entitlement_reason,
        false,
    );
    if !gate.blocked {
        if !gate.non_public_youtube.is_empty() && !allow_non_public {
            return HeadlessDecision::Refuse(go_live_privacy::headless_refusal(
                &gate.non_public_youtube,
            ));
        }
        return HeadlessDecision::Confirm;
    }
    if let Some(reason) = gate.entitlement {
        return HeadlessDecision::Refuse(reason);
    }
    if captions_blocks_start {
        return HeadlessDecision::Refuse(sentences(&[
            format!("{}: {}", copy::CAPTIONS_TITLE, captions_description),
            copy::WITHOUT_CAPTIONS_HINT.to_string(),
        ]));
    }
    if gate.has_instant && draft.is_none() {
        return HeadlessDecision::Refuse(copy::DRAFT_LOADING.to_string());
    }
    if let Some(problem) = gate.title_issue.or(gate.description_issue) {
        return HeadlessDecision::Refuse(problem);
    }
    if gate.view.destinations.is_empty() {
        let mut parts = vec![copy::NO_DESTINATION.to_string()];
        parts.extend(gate.view.general_errors);
        return HeadlessDecision::Refuse(sentences(&parts));
    }
    let not_ready: Vec<_> = gate.view.destinations.iter().filter(|r| !r.ready).collect();
    let ready_count = gate.view.destinations.len() - not_ready.len();
    if allow_partial
        && gate.view.general_errors.is_empty()
        && !not_ready.is_empty()
        && ready_count > 0
    {
        return HeadlessDecision::Exclude(
            not_ready
                .into_iter()
                .map(|r| r.destination.target_id.clone())
                .collect(),
        );
    }
    let mut parts: Vec<String> = not_ready
        .iter()
        .map(|row| {
            format!(
                "{}: {}",
                destination_label(&row.destination.label),
                row.problem.as_deref().unwrap_or(&row.destination.message)
            )
        })
        .collect();
    parts.extend(gate.view.general_errors.clone());
    if !allow_partial
        && ready_count > 0
        && !not_ready.is_empty()
        && gate.view.general_errors.is_empty()
    {
        parts.push(copy::ALLOW_PARTIAL_HINT.to_string());
    }
    HeadlessDecision::Refuse(sentences(&parts))
}

/// Decides a partial platform setup (`decideHeadlessPartialSetup`).
pub fn decide_headless_partial_setup(
    setup: &PartialSetup,
    allow_partial: bool,
) -> Result<(), String> {
    if allow_partial && !setup.ready_labels.is_empty() {
        return Ok(());
    }
    let mut parts = vec![format!("{}.", copy::SETUP_FAILED)];
    for failure in &setup.failures {
        parts.push(format!(
            "{}: {}. {}",
            platform_label(&failure.platform),
            failure.label,
            failure.message
        ));
    }
    if !setup.ready_labels.is_empty() {
        parts.push(format!(
            "Ready: {}. {}",
            setup.ready_labels.join(", "),
            copy::ALLOW_PARTIAL_HINT
        ));
    }
    Err(sentences(&parts))
}

struct ClearPending<'a, B: StudioBackend>(&'a Studio<B>);

impl<B: StudioBackend> Drop for ClearPending<'_, B> {
    fn drop(&mut self) {
        self.0.edit_go_live_state(|state| {
            state.pending = false;
            state.phase = None;
        });
    }
}

impl<B: StudioBackend> Studio<B> {
    pub(super) async fn agent_go_live(
        self: &Arc<Self>,
        args: &Value,
        cancelled: &Arc<AtomicBool>,
    ) -> AgentIntentOutcome {
        let snapshot = self.snapshot();
        if !self.is_connected() {
            let reason = connection_blocked_reason(&snapshot.connection).unwrap_or(copy::IN_FLIGHT);
            return AgentIntentOutcome::refused(reason);
        }
        if self.session_owns_transport() {
            return AgentIntentOutcome::refused(remote_copy::ALREADY_RUNNING);
        }
        let go_live_state = self.go_live_now();
        if go_live_state.open {
            return AgentIntentOutcome::refused(copy::DIALOG_OPEN);
        }
        if go_live_state.pending || self.start_in_flight() {
            return AgentIntentOutcome::refused(copy::IN_FLIGHT);
        }

        let destinations: Option<Vec<String>> = args.get("destinations").and_then(|v| {
            v.as_array().map(|arr| {
                arr.iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect()
            })
        });
        let title = args
            .get("title")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let allow_partial = args.get("allowPartial").and_then(Value::as_bool) == Some(true);
        let without_captions = args.get("withoutCaptions").and_then(Value::as_bool) == Some(true);
        let allow_non_public = args.get("allowNonPublic").and_then(Value::as_bool) == Some(true);

        let all_targets = stream_targets(&snapshot.settings.capture_doc);
        let mut excluded = match headless_exclusions(&all_targets, destinations.as_deref()) {
            Ok(ids) => ids,
            Err(message) => return AgentIntentOutcome::refused(message),
        };

        // Mark pending so the dialog cannot open over us while we check and confirm.
        self.edit_go_live_state(|state| {
            state.pending = true;
            state.phase = Some(Phase::Checking);
        });
        let _clear = ClearPending(self);

        let is_cancelled = || cancelled.load(Ordering::Acquire);
        if is_cancelled() {
            return AgentIntentOutcome::refused(copy::CANCELLED);
        }

        if let Some(new_title) = title {
            let title_owned = new_title.to_string();
            self.patch_metadata_draft(move |draft| draft.title = title_owned);
        }

        let mut preflight = match self.go_live_preflight(&excluded).await {
            Ok(preflight) => preflight,
            Err(message) => return AgentIntentOutcome::refused(message),
        };

        let sent_doc = self.sent_streaming(&excluded);
        let sent_targets = stream_targets(&json!({ "streaming": sent_doc }));
        let draft = self.details_now().draft;
        let snapshot_now = self.snapshot();

        let captions_as_shown = captions_readiness::decide_go_live_captions_readiness(
            captions_readiness::GoLiveCaptionsInput {
                persisted_enabled: snapshot_now.settings.capture.captions.enabled,
                suppress_for_session: false,
                capabilities: None,
                output_readiness: None,
                platform_unavailable: None,
            },
        );
        let suppress_captions = without_captions && captions_as_shown.blocks_start;
        let captions_ready = if suppress_captions {
            captions_readiness::decide_go_live_captions_readiness(
                captions_readiness::GoLiveCaptionsInput {
                    persisted_enabled: snapshot_now.settings.capture.captions.enabled,
                    suppress_for_session: true,
                    capabilities: None,
                    output_readiness: None,
                    platform_unavailable: None,
                },
            )
        } else {
            captions_as_shown
        };

        let enabled_ids: Vec<String> = all_targets
            .iter()
            .filter(|t| t.enabled)
            .map(|t| t.id.clone())
            .collect();
        let ent_gate = go_live_entitlement_gate(snapshot_now.entitlements.as_ref(), &enabled_ids);
        let entitlement_reason = (!ent_gate.allowed()).then(|| {
            ent_gate
                .reason()
                .unwrap_or("Livestreaming requires Videorc Premium.")
                .to_string()
        });

        let mut decision = decide_headless_go_live(HeadlessGoLiveInput {
            preflight: &preflight,
            draft: draft.as_ref(),
            sent_targets: &sent_targets,
            captions_blocks_start: captions_ready.blocks_start,
            captions_description: &captions_ready.description,
            entitlement_reason: entitlement_reason.clone(),
            allow_partial,
            allow_non_public,
        });
        if let HeadlessDecision::Exclude(extra) = decision {
            excluded.extend(extra);
            preflight = match self.go_live_preflight(&excluded).await {
                Ok(rechecked) => rechecked,
                Err(_) => return AgentIntentOutcome::refused(copy::DID_NOT_START),
            };
            let sent_doc = self.sent_streaming(&excluded);
            let sent_targets = stream_targets(&json!({ "streaming": sent_doc }));
            decision = decide_headless_go_live(HeadlessGoLiveInput {
                preflight: &preflight,
                draft: draft.as_ref(),
                sent_targets: &sent_targets,
                captions_blocks_start: captions_ready.blocks_start,
                captions_description: &captions_ready.description,
                entitlement_reason: entitlement_reason.clone(),
                allow_partial: false,
                allow_non_public,
            });
        }

        match decision {
            HeadlessDecision::Refuse(message) => return AgentIntentOutcome::refused(message),
            HeadlessDecision::Exclude(_) => return AgentIntentOutcome::refused(copy::IN_FLIGHT),
            HeadlessDecision::Confirm => {}
        }

        // Stop agents wins over confirm.
        if is_cancelled() {
            return AgentIntentOutcome::refused(copy::CANCELLED);
        }
        if self.go_live_now().open {
            return AgentIntentOutcome::refused(copy::DIALOG_OPEN);
        }

        // Fresh re-validation before preparing platforms (matches confirm_once).
        let sent = self.sent_streaming(&excluded);
        if let Err(error) = self.save_draft_for_go_live().await {
            return AgentIntentOutcome::refused(error.message);
        }
        let fresh = match self.validate_go_live(&sent).await {
            Ok(fresh) => fresh,
            Err(error) => return AgentIntentOutcome::refused(error.message),
        };
        let fingerprint = |p: &Preflight, id: &str| {
            p.destinations
                .iter()
                .find(|d| d.target_id == id)
                .and_then(|d| d.scheduled.as_ref())
                .and_then(|s| s.get("fingerprint"))
                .cloned()
        };
        let changed = fresh.destinations.iter().any(|destination| {
            destination.scheduled.is_some()
                && fingerprint(&preflight, &destination.target_id)
                    != destination
                        .scheduled
                        .as_ref()
                        .and_then(|s| s.get("fingerprint"))
                        .cloned()
        });
        if changed {
            return AgentIntentOutcome::refused(copy::SCHEDULED_CHANGED);
        }
        if !fresh.valid {
            let sent_targets = stream_targets(&json!({ "streaming": sent }));
            let blocked = decide_headless_go_live(HeadlessGoLiveInput {
                preflight: &fresh,
                draft: draft.as_ref(),
                sent_targets: &sent_targets,
                captions_blocks_start: captions_ready.blocks_start,
                captions_description: &captions_ready.description,
                entitlement_reason,
                allow_partial: false,
                allow_non_public,
            });
            let msg = match blocked {
                HeadlessDecision::Refuse(message) => message,
                _ => copy::DID_NOT_START.to_string(),
            };
            return AgentIntentOutcome::refused(msg);
        }
        if let Some(reason) = self.settle_output_check(&sent).await {
            return AgentIntentOutcome::refused(reason);
        }

        let setup = match self.prepare_targets(&fresh, &excluded).await {
            Ok(setup) => setup,
            Err(message) => return AgentIntentOutcome::refused(message),
        };

        if is_cancelled() {
            self.settle_prepared_platforms(setup.streaming).await;
            return AgentIntentOutcome::refused(copy::CANCELLED);
        }

        let streaming = match lifecycle::decide_prepared_setup(setup) {
            SetupDecision::Start(streaming) => streaming,
            SetupDecision::Partial(partial) => {
                if let Err(message) = decide_headless_partial_setup(&partial, allow_partial) {
                    self.settle_prepared_platforms(partial.streaming).await;
                    return AgentIntentOutcome::refused(message);
                }
                if is_cancelled() {
                    self.settle_prepared_platforms(partial.streaming).await;
                    return AgentIntentOutcome::refused(copy::CANCELLED);
                }
                partial.streaming
            }
            SetupDecision::NoReadyDestinations => {
                return AgentIntentOutcome::refused(
                    crate::livestream::go_live_copy::NO_READY_AFTER_SETUP,
                );
            }
        };

        let typed = match serde_json::from_value::<StreamingSettings>(streaming.clone()) {
            Ok(typed) => typed,
            Err(error) => {
                self.settle_prepared_platforms(streaming).await;
                return AgentIntentOutcome::refused(format!(
                    "The livestream settings didn't read: {error}"
                ));
            }
        };

        let record = self.snapshot().settings.capture.record_enabled;
        let run = self.platform.run();
        self.edit_go_live_state(|state| {
            *state = GoLiveState::default();
        });
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
            self.settle_prepared_platforms(streaming).await;
            return AgentIntentOutcome::refused(copy::DID_NOT_START);
        };
        self.activate_platforms(streaming.clone(), Some(session_id), run)
            .await;

        let live_destinations: Vec<Value> = stream_targets(&json!({ "streaming": streaming }))
            .into_iter()
            .filter(|t| t.enabled)
            .map(|t| {
                json!({
                    "id": t.id,
                    "platform": t.platform,
                    "label": destination_label(&t.label),
                })
            })
            .collect();
        let labels = live_destinations
            .iter()
            .filter_map(|d| d.get("label").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(", ");
        let message = format!(
            "You're live on {labels}.{}",
            if record { " Recording too." } else { "" }
        );
        AgentIntentOutcome::ok(
            message,
            json!({
                "live": true,
                "destinations": live_destinations,
                "recording": record,
            }),
        )
    }
}
