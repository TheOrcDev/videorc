//! S3.5c: the Go Live dialog as data (`go-live-dialog.tsx`,
//! `lib/go-live-dialog-view.ts`, `lib/go-live-flow.ts`,
//! `lib/go-live-exclusions.ts`, `lib/go-live-copy.ts`).
//!
//! The backend judges every destination (`streamTargets.confirmation.validate`:
//! ready, why not, what chat can do, the scheduled event); the dialog adds
//! the title it holds and what the Go Live leaves out for this livestream
//! only.

use serde::{Deserialize, Serialize};

use super::accounts::{destination_label, platform_label};
use super::captions_preflight::{Readiness, ReadinessKind};
use super::details::{MetadataDraft, info_issues};
use super::go_live_copy;
use super::go_live_privacy::{NonPublicYouTube, non_public_youtube};
use super::targets::Target;

/// `GoLiveDestinationPreflight`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DestinationPreflight {
    pub target_id: String,
    pub platform: String,
    pub label: String,
    pub auth_mode: String,
    pub scheduled: Option<serde_json::Value>,
    pub ready: bool,
    pub account_label: Option<String>,
    pub message: String,
    pub chat_read: String,
    pub chat_write: String,
    pub chat_message: String,
}

/// `GoLivePreflightIssue`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PreflightIssue {
    pub target_id: Option<String>,
    pub platform: Option<String>,
    pub severity: String,
    pub message: String,
}

/// `GoLivePreflight`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Preflight {
    pub valid: bool,
    pub destinations: Vec<DestinationPreflight>,
    pub issues: Vec<PreflightIssue>,
}

/// `goLiveConfirmLabel`.
pub fn confirm_label(count: usize) -> String {
    if count > 1 {
        go_live_copy::go_live_on(count)
    } else {
        go_live_copy::GO_LIVE.to_string()
    }
}

/// `goLiveOnReadyLabel`.
pub fn on_ready_label(labels: &[String]) -> String {
    match labels {
        [one] => go_live_copy::go_live_on_label(one),
        _ => confirm_label(labels.len()),
    }
}

/// `GoLivePhase`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Phase {
    Checking,
    Preparing(String),
    Starting,
}

/// `goLivePendingLabel`: through Videorc Cloud the start's one extra step is
/// the cloud show (plan 184 C4).
pub fn pending_label(phase: Option<&Phase>, through_cloud: bool) -> String {
    match phase {
        Some(Phase::Preparing(platform)) => go_live_copy::preparing(platform_label(platform)),
        Some(Phase::Starting) if through_cloud => go_live_copy::CONNECTING_TO_CLOUD.to_string(),
        Some(Phase::Starting) => go_live_copy::STARTING.to_string(),
        _ => go_live_copy::CHECKING.to_string(),
    }
}

/// `isTitleIssue`.
fn is_title_issue(message: &str) -> bool {
    message.to_lowercase().contains("title is required")
}

/// `GoLiveDestinationView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DestinationRow {
    pub destination: DestinationPreflight,
    pub ready: bool,
    pub problem: Option<String>,
}

/// `GoLiveDialogView`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DialogView {
    pub destinations: Vec<DestinationRow>,
    pub general_errors: Vec<String>,
    pub warnings: Vec<String>,
    pub summary: Option<String>,
    pub destinations_ready: bool,
}

fn with_platform(issue: &PreflightIssue) -> String {
    match &issue.platform {
        Some(platform) => format!("{}: {}", platform_label(platform), issue.message),
        None => issue.message.clone(),
    }
}

/// `verticalLegUnsupported`: the raw-frame encoder path (Linux, and Windows
/// without Media Foundation) has no second encoder for the vertical leg, so
/// the engine would refuse a start that streams both orientations (#691).
pub fn vertical_leg_unsupported(simulcast: bool, effective_bridge_output: Option<&str>) -> bool {
    simulcast && effective_bridge_output == Some("raw-yuv420p")
}

/// `goLiveDialogView`; `vertical_unsupported` lists the rows the engine
/// can't stream on this computer (`verticalLegUnsupported`).
pub fn dialog_view(
    preflight: Option<&Preflight>,
    title_field: bool,
    title_missing: bool,
    vertical_unsupported: &[String],
) -> DialogView {
    let Some(preflight) = preflight else {
        return DialogView::default();
    };
    let ids: Vec<&str> = preflight
        .destinations
        .iter()
        .map(|d| d.target_id.as_str())
        .collect();
    let errors: Vec<&PreflightIssue> = preflight
        .issues
        .iter()
        .filter(|i| i.severity == "error")
        .collect();
    let title_handled = |issue: &PreflightIssue| title_field && is_title_issue(&issue.message);
    let destinations: Vec<DestinationRow> = preflight
        .destinations
        .iter()
        .map(|destination| {
            let own: Vec<&&PreflightIssue> = errors
                .iter()
                .filter(|i| i.target_id.as_deref() == Some(destination.target_id.as_str()))
                .collect();
            let only_title = !own.is_empty() && own.iter().all(|i| title_handled(i));
            if destination.ready || (only_title && !title_missing) {
                if vertical_unsupported.contains(&destination.target_id) {
                    return DestinationRow {
                        destination: destination.clone(),
                        ready: false,
                        problem: Some(go_live_copy::VERTICAL_LEG_UNSUPPORTED.to_string()),
                    };
                }
                DestinationRow {
                    destination: destination.clone(),
                    ready: true,
                    problem: None,
                }
            } else {
                DestinationRow {
                    destination: destination.clone(),
                    ready: false,
                    problem: Some(if only_title {
                        go_live_copy::NEEDS_A_TITLE.to_string()
                    } else {
                        destination.message.clone()
                    }),
                }
            }
        })
        .collect();
    let general_errors = errors
        .iter()
        .filter(|i| {
            !(i.target_id.as_deref().is_some_and(|id| ids.contains(&id))) && !title_handled(i)
        })
        .map(|i| with_platform(i))
        .collect();
    let warnings = preflight
        .issues
        .iter()
        .filter(|i| i.severity == "warning")
        .map(with_platform)
        .collect();
    let ready = destinations.iter().filter(|r| r.ready).count();
    let total = destinations.len();
    let general_empty = errors
        .iter()
        .all(|i| i.target_id.as_deref().is_some_and(|id| ids.contains(&id)) || title_handled(i));
    DialogView {
        summary: (total > 0).then(|| go_live_copy::ready_of(ready, total)),
        destinations_ready: total > 0 && ready == total && general_empty,
        destinations,
        general_errors,
        warnings,
    }
}

/// `goLiveConfirmGate`: what holds the primary back, and the YouTube
/// destinations the privacy step names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmGate {
    /// The destinations this Go Live sends, ids in saved order.
    pub sent_target_ids: Vec<String>,
    pub has_scheduled: bool,
    pub has_instant: bool,
    pub instant_youtube: bool,
    pub title_issue: Option<String>,
    pub description_issue: Option<String>,
    pub view: DialogView,
    pub entitlement: Option<String>,
    pub blocked: bool,
    pub non_public_youtube: Vec<NonPublicYouTube>,
}

/// `sent_targets` are the sent streaming settings' targets (the enabled ones
/// are sent); `captions_block_start` is the session's captions readiness'
/// `blocksStart`; `vertical_leg_unsupported` is the output check's answer.
pub fn confirm_gate(
    preflight: Option<&Preflight>,
    draft: Option<&MetadataDraft>,
    sent_targets: &[Target],
    captions_block_start: bool,
    entitlement: Option<String>,
    vertical_leg_unsupported: bool,
) -> ConfirmGate {
    let sent: Vec<&Target> = sent_targets.iter().filter(|t| t.enabled).collect();
    let scheduled = |t: &Target| {
        t.scheduled_event_id
            .as_deref()
            .is_some_and(|id| !id.is_empty())
    };
    let has_scheduled = sent.iter().any(|t| scheduled(t));
    let has_instant = sent.iter().any(|t| !scheduled(t));
    let instant_youtube = sent
        .iter()
        .any(|t| !scheduled(t) && t.platform == "youtube");
    let (title_issue, description_issue) = match (has_instant, draft) {
        (true, Some(draft)) => info_issues(&draft.title, &draft.description, true),
        _ => (None, None),
    };
    let vertical_unsupported: Vec<String> = if vertical_leg_unsupported {
        sent.iter()
            .filter(|t| t.vertical())
            .map(|t| t.id.clone())
            .collect()
    } else {
        Vec::new()
    };
    let view = dialog_view(
        preflight,
        has_instant,
        has_instant && draft.is_none_or(|d| d.title.trim().is_empty()),
        &vertical_unsupported,
    );
    let blocked = entitlement.is_some()
        || captions_block_start
        || title_issue.is_some()
        || description_issue.is_some()
        || (has_instant && draft.is_none())
        || !view.destinations_ready;
    let destinations = preflight
        .map(|p| p.destinations.as_slice())
        .unwrap_or_default();
    ConfirmGate {
        sent_target_ids: sent.iter().map(|t| t.id.clone()).collect(),
        has_scheduled,
        has_instant,
        instant_youtube,
        title_issue,
        description_issue,
        view,
        entitlement,
        blocked,
        non_public_youtube: non_public_youtube(&sent, destinations, draft),
    }
}

/// `GoLiveCaptionsStatus`: what the dialog shows for this livestream's
/// captions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptionsStatus {
    /// "Captions can't start", the reason, and "Go live without captions".
    Blocked { description: String },
    /// "No captions this time" and why.
    Skipped { description: String },
    /// The "Captions" row: "Ready", good only when ready.
    Row { good: bool, description: String },
}

pub fn captions_status(readiness: &Readiness) -> CaptionsStatus {
    let description = readiness.description.clone();
    match readiness.kind {
        ReadinessKind::Blocked => CaptionsStatus::Blocked { description },
        ReadinessKind::Skipped => CaptionsStatus::Skipped { description },
        kind => CaptionsStatus::Row {
            good: kind == ReadinessKind::Ready,
            description,
        },
    }
}

/// `runGoLiveConfirmation`'s first check: a captions blocker stops the
/// confirm (with [`go_live_copy::CAPTIONS_NOT_READY`] and the reason) unless
/// the talk-show room is open.
pub fn captions_block(readiness: &Readiness, talk_show_room_open: bool) -> Option<&str> {
    (!talk_show_room_open && readiness.blocks_start).then_some(readiness.description.as_str())
}

/// `commentsReadLabel` and its tone (`READ_TONE`).
pub fn read_label(state: &str) -> (&'static str, &'static str) {
    match state {
        "ready" => ("Ready", "good"),
        "connecting" => ("Connecting", "neutral"),
        "waiting-for-broadcast-context" => ("After publish", "neutral"),
        "ended" => ("Ended", "neutral"),
        "failed" => ("Failed", "error"),
        "needs-sign-in" => ("Needs Sign in", "neutral"),
        "needs-videorc-sign-in" => ("Needs Videorc sign-in", "warn"),
        _ => ("Unavailable", "neutral"),
    }
}

/// `commentsWriteLabel` and its tone.
pub fn write_label(state: &str) -> (&'static str, &'static str) {
    match state {
        "ready" => ("Ready", "good"),
        "missing-scope" => ("Reconnect to send", "warn"),
        "read-only" => ("Read-only", "neutral"),
        "failed" => ("Failed", "error"),
        _ => ("Unavailable", "neutral"),
    }
}

/// `updateGoLiveExclusions`.
pub fn update_exclusions(excluded: &[String], target_id: &str, exclude: bool) -> Vec<String> {
    let has = excluded.iter().any(|id| id == target_id);
    if exclude == has {
        return excluded.to_vec();
    }
    if exclude {
        let mut next = excluded.to_vec();
        next.push(target_id.to_string());
        next
    } else {
        excluded
            .iter()
            .filter(|id| *id != target_id)
            .cloned()
            .collect()
    }
}

/// The destination's name in "Go live without …".
pub fn without_label(label: &str) -> String {
    go_live_copy::go_live_without(&destination_label(label))
}

/// `GoLiveSimulcastAdvisory`'s upstream estimate: the enabled destinations'
/// bitrates, in whole Mbps (at least 1).
pub fn simulcast_mbps(targets: &[Target], default_kbps: u32) -> u64 {
    let total: u64 = targets
        .iter()
        .filter(|t| t.enabled)
        .map(|t| u64::from(t.output_bitrate_kbps.unwrap_or(default_kbps)))
        .sum();
    ((total as f64 / 1000.0).round() as u64).max(1)
}

/// `GoLiveProducerReminder`: the Live Producer steps for the stream-key
/// Facebook and Instagram destinations this livestream sends.
pub fn producer_steps(targets: &[Target]) -> Vec<&'static str> {
    [
        ("facebook", go_live_copy::FACEBOOK_PRODUCER_STEP),
        ("instagram", go_live_copy::INSTAGRAM_PRODUCER_STEP),
    ]
    .into_iter()
    .filter(|(platform, _)| {
        targets
            .iter()
            .any(|t| t.platform == *platform && t.auth_mode == "manual-rtmp" && t.enabled)
    })
    .map(|(_, step)| step)
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn destination(id: &str, ready: bool, message: &str) -> DestinationPreflight {
        DestinationPreflight {
            target_id: id.into(),
            platform: id.into(),
            label: id.into(),
            auth_mode: "manual-rtmp".into(),
            ready,
            message: message.into(),
            ..DestinationPreflight::default()
        }
    }

    /// smoke:start-labels' `logic` row: the Go Live dialog's words
    /// (`lib/go-live-copy.ts`) and `decideGoLiveStart`.
    #[test]
    fn the_start_words_are_the_dialogs() {
        assert_eq!(go_live_copy::GO_LIVE, "Go live");
        assert_eq!(confirm_label(1), "Go live");
        assert_eq!(confirm_label(3), "Go live on 3 destinations");
        assert_eq!(on_ready_label(&["Twitch".into()]), "Go live on Twitch");
        assert_eq!(
            on_ready_label(&["Twitch".into(), "Kick".into()]),
            "Go live on 2 destinations"
        );
        assert_eq!(pending_label(None, false), "Checking…");
        assert_eq!(
            pending_label(Some(&Phase::Preparing("youtube".into())), false),
            "Preparing YouTube…"
        );
        assert_eq!(pending_label(Some(&Phase::Starting), false), "Starting…");
        assert_eq!(
            pending_label(Some(&Phase::Starting), true),
            "Connecting to Videorc Cloud…"
        );
        assert_eq!(super::go_live_copy::GO_LIVE_LABEL, "Go Live");
    }

    #[test]
    fn the_view_names_what_holds_the_start() {
        let preflight = Preflight {
            valid: false,
            destinations: vec![
                destination("twitch", true, ""),
                destination("kick", false, "Add a stream key."),
                destination("youtube", false, "Title is required."),
            ],
            issues: vec![
                PreflightIssue {
                    target_id: Some("youtube".into()),
                    platform: Some("youtube".into()),
                    severity: "error".into(),
                    message: "YouTube title is required.".into(),
                },
                PreflightIssue {
                    target_id: Some("kick".into()),
                    severity: "error".into(),
                    message: "Add a stream key.".into(),
                    ..PreflightIssue::default()
                },
                PreflightIssue {
                    platform: Some("twitch".into()),
                    severity: "warning".into(),
                    message: "Chat is read-only.".into(),
                    ..PreflightIssue::default()
                },
            ],
        };
        let view = dialog_view(Some(&preflight), true, false, &[]);
        let problems: Vec<Option<&str>> = view
            .destinations
            .iter()
            .map(|r| r.problem.as_deref())
            .collect();
        assert_eq!(problems, [None, Some("Add a stream key."), None]);
        assert_eq!(view.summary.as_deref(), Some("2 of 3 ready"));
        assert!(!view.destinations_ready);
        assert_eq!(view.warnings, ["Twitch: Chat is read-only."]);
        // With the title empty, YouTube says why.
        let view = dialog_view(Some(&preflight), true, true, &[]);
        assert_eq!(
            view.destinations[2].problem.as_deref(),
            Some("Needs a title.")
        );
        // The raw-frame path can't encode the vertical leg (#691): a ready
        // vertical row says so instead of "Ready".
        assert!(vertical_leg_unsupported(true, Some("raw-yuv420p")));
        assert!(!vertical_leg_unsupported(false, Some("raw-yuv420p")));
        assert!(!vertical_leg_unsupported(true, Some("nv12")));
        assert!(!vertical_leg_unsupported(true, None));
        let view = dialog_view(Some(&preflight), true, false, &["twitch".to_string()]);
        assert!(!view.destinations[0].ready);
        assert_eq!(
            view.destinations[0].problem.as_deref(),
            Some(
                "This computer can't encode a separate vertical stream yet, so this destination would get the landscape video."
            )
        );
        assert_eq!(view.summary.as_deref(), Some("1 of 3 ready"));
        assert_eq!(update_exclusions(&[], "kick", true), ["kick"]);
        assert!(update_exclusions(&["kick".into()], "kick", false).is_empty());
        assert_eq!(without_label("Kick"), "Go live without Kick");
    }

    fn sent(id: &str, platform: &str, orientation: Option<&str>) -> Target {
        Target {
            id: id.into(),
            platform: platform.into(),
            label: id.into(),
            enabled: true,
            output_orientation: orientation.map(str::to_string),
            ..Target::default()
        }
    }

    #[test]
    fn the_confirm_gate_holds_for_captions_and_names_non_public_youtube() {
        let preflight = Preflight {
            valid: true,
            destinations: vec![destination("yt", true, ""), destination("yt-v", true, "")],
            issues: Vec::new(),
        };
        let draft = MetadataDraft {
            title: "Show".into(),
            default_privacy: super::super::details::Privacy::Unlisted,
            ..MetadataDraft::default()
        };
        let targets = [
            sent("yt", "youtube", None),
            sent("yt-v", "youtube", Some("vertical")),
            Target {
                enabled: false,
                ..sent("off", "twitch", None)
            },
        ];
        let gate = confirm_gate(Some(&preflight), Some(&draft), &targets, false, None, false);
        assert_eq!(gate.sent_target_ids, ["yt", "yt-v"]);
        assert!(!gate.blocked);
        assert!(gate.instant_youtube && gate.has_instant && !gate.has_scheduled);
        assert_eq!(gate.non_public_youtube.len(), 2);

        assert!(confirm_gate(Some(&preflight), Some(&draft), &targets, true, None, false).blocked);
        let vertical = confirm_gate(Some(&preflight), Some(&draft), &targets, false, None, true);
        assert!(vertical.blocked);
    }

    #[test]
    fn captions_read_as_a_blocker_a_skip_or_a_row() {
        use super::super::captions_preflight::go_live_readiness;
        let blocked = go_live_readiness(true, false, None, None, None);
        assert!(matches!(
            captions_status(&blocked),
            CaptionsStatus::Blocked { .. }
        ));
        assert_eq!(
            captions_block(&blocked, false),
            Some(blocked.description.as_str())
        );
        assert_eq!(captions_block(&blocked, true), None);
        let skipped = go_live_readiness(true, true, None, None, None);
        assert!(matches!(
            captions_status(&skipped),
            CaptionsStatus::Skipped { .. }
        ));
        let off = go_live_readiness(false, false, None, None, None);
        assert!(matches!(
            captions_status(&off),
            CaptionsStatus::Row { good: false, .. }
        ));
        assert_eq!(captions_block(&off, false), None);
    }
}
