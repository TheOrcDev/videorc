//! S3.5c: the Go Live dialog's words (`components/go-live-dialog.tsx`,
//! `lib/go-live-dialog-view.ts`), the platforms' lifecycle lines
//! (`prepareOauthTargetsForGoLive`, the activation and the cleanup) and
//! their toasts, and the going-live vocabulary every surface shares
//! (`lib/go-live-copy.ts`): the Studio transport reads its Go Live words from
//! here (plan 260 S1.6c; `videorc-rust` kept them in `studio::transport`).

// --- S3.5c: the Go Live dialog (`go-live-dialog.tsx`, `lib/go-live-copy.ts`,
// `lib/go-live-dialog-view.ts`) ---

/// `GO_LIVE_DIALOG_TITLE`, and `goLiveConfirmLabel(1)`.
pub const GO_LIVE: &str = "Go live";
pub const GO_LIVE_LABEL: &str = "Go Live";
/// `GO_LIVE_COMMAND`: ⌘K keeps the "…".
pub const GO_LIVE_COMMAND: &str = "Go live…";
/// `goLiveConfirmLabel`'s plural: the Go Live dialog's primary.
pub fn go_live_on(count: usize) -> String {
    format!("Go live on {count} destinations")
}
/// `goLiveOnReadyLabel` with one destination ready.
pub fn go_live_on_label(label: &str) -> String {
    format!("Go live on {label}")
}
/// `goLiveConfirmLabel`.
pub fn go_live_confirm_label(count: usize) -> String {
    if count > 1 {
        go_live_on(count)
    } else {
        GO_LIVE.to_string()
    }
}
/// `goLiveOnReadyLabel`: after a partial setup, one ready destination is
/// named.
pub fn go_live_on_ready_label(ready: &[String]) -> String {
    match ready {
        [one] => go_live_on_label(one),
        _ => go_live_confirm_label(ready.len()),
    }
}
/// `USE_FOR_GO_LIVE_LABEL`: an Upcoming event's action.
pub const USE_FOR_GO_LIVE_LABEL: &str = "Use for Go Live…";
/// `GO_LIVE_SHORTCUT_LABEL`: Settings → Shortcuts' global hotkey.
pub const GO_LIVE_SHORTCUT_LABEL: &str = "Go Live / end livestream";
/// `GO_LIVE_NO_DESTINATION_TITLE`: Go Live asked with no destination ready
/// (the hotkey, ⌘K, a remote).
pub const GO_LIVE_NO_DESTINATION_TITLE: &str = "Set up a destination to go live";
/// `OPEN_DESTINATIONS_LABEL` (#1357: was "Open Livestream").
pub const OPEN_DESTINATIONS_LABEL: &str = "Open Destinations";
/// `GO_LIVE_CHECKING_LABEL`: the Go Live button while its first checks run.
pub const GO_LIVE_CHECKING_LABEL: &str = "Checking…";
/// `goLivePendingLabel`.
pub fn preparing(platform: &str) -> String {
    format!("Preparing {platform}…")
}
pub const STARTING: &str = "Starting…";
/// `goLivePendingLabel('starting', throughCloud)`: plan 184 C4, the start's
/// one extra step is the cloud show.
pub const CONNECTING_TO_CLOUD: &str = "Connecting to Videorc Cloud…";
/// `goLivePendingLabel`'s default: the checks run.
pub const CHECKING: &str = "Checking…";
/// The destinations' summary (`goLiveDialogView`).
pub fn ready_of(ready: usize, total: usize) -> String {
    format!("{ready} of {total} ready")
}
/// `VERTICAL_LEG_UNSUPPORTED_PROBLEM` (#691).
pub const VERTICAL_LEG_UNSUPPORTED: &str = "This computer can't encode a separate vertical stream yet, so this destination would get the landscape video.";
pub const NEEDS_A_TITLE: &str = "Needs a title.";
pub fn go_live_without(label: &str) -> String {
    format!("Go live without {label}")
}
pub const GO_LIVE_DESCRIPTION: &str =
    "Check your destinations and stream details before Videorc starts the livestream.";
pub const GO_LIVE_BLOCKED_REASON: &str = "Fix the items above, then go live.";
pub const GO_LIVE_EXCLUDED_NOTE: &str = "Only for this livestream. Your destination stays on.";
/// The scheduled note: `others` is SCHEDULED_OTHERS when instant
/// destinations go too, else "".
pub fn scheduled_starts_now(others: &str) -> String {
    format!("A scheduled event starts now, even if its time is earlier or later.{others}")
}
pub const SCHEDULED_OTHERS: &str = " The stream details above go to the other destinations.";
pub const NO_DESTINATION_ON: &str = "No destination is on. Turn one on in Destinations → Setup.";
pub const FIX_BEFORE_GOING_LIVE: &str = "Fix before going live";
pub const CHAT_LIMITS: &str = "Chat limits";
pub const SOME_COULDNT_BE_SET_UP: &str = "Some destinations couldn't be set up";
pub fn ready_list(labels: &str) -> String {
    format!("Ready: {labels}")
}
pub fn setup_failure(platform: &str, label: &str, message: &str) -> String {
    format!("{platform}: {label}. {message}")
}
pub const SCHEDULED_EVENT: &str = "Scheduled event";
pub fn scheduled_title(title: &str) -> String {
    format!("Scheduled: {title}")
}
pub const NEEDS_ATTENTION_BADGE: &str = "Needs attention";
pub const LEFT_OUT: &str = "Left out";
pub const ADD_BACK: &str = "Add back";
/// Go Live's row: sign the platform in (again), in the browser.
pub fn connect_platform_again(platform: &str, signed_in: bool) -> String {
    let verb = if signed_in { "Reconnect" } else { "Connect" };
    format!("{verb} {platform}…")
}
pub const STREAMING_BOTH: &str = "Streaming both orientations";
pub fn simulcast_advice(mbps: u64) -> String {
    format!(
        "The horizontal scene streams to your landscape destinations while the saved vertical scene streams to the vertical ones, about {mbps} Mbps upstream across all legs."
    )
}
pub const PUBLISH_IN_LIVE_PRODUCER: &str = "Publish in Live Producer";
pub const FACEBOOK_PRODUCER_STEP: &str = "Facebook: once Videorc starts sending, press “Go live” in Facebook Live Producer to publish the stream.";
pub const INSTAGRAM_PRODUCER_STEP: &str = "Instagram: once Videorc starts sending, press “Go live” in Instagram Live Producer to publish the stream to your profile.";

/// `GoLiveCaptionsStatus`: the blocker, the session skip and the ready row.
pub const CAPTIONS_CANT_START: &str = "Captions can't start";
pub const GO_LIVE_WITHOUT_CAPTIONS: &str = "Go live without captions";
pub const NO_CAPTIONS_THIS_TIME: &str = "No captions this time";
pub const CAPTIONS: &str = "Captions";
/// The toast when a Go Live outside the dialog meets a captions blocker.
pub const CAPTIONS_NOT_READY: &str = "Live captions aren't ready";

// The lifecycle's words are use-studio's (the Studio screen's table).
pub use super::lifecycle_copy::*;

/// S3.6c: `GoLiveOutputAdvice`'s warnings (the step-down's and the shared
/// encode's words wait on the owner: S3.6c.1).
pub const MAY_NOT_KEEP_UP: &str = "This computer may not keep up";
pub fn below_floor_advice(floor: &str) -> String {
    format!(
        "Nothing held steady in its performance check, not even {floor}. Viewers will likely see a stuttering picture. Close other apps, or check again in Output."
    )
}
pub fn may_stutter_live(output: &str) -> String {
    format!("{output} may stutter while live")
}
pub fn go_live_heavy_advice(holds: &str) -> String {
    format!(
        "Going live takes about twice the work of a recording on this computer, and its performance check found no room for that. Viewers may see a stuttering picture. {holds} holds steady."
    )
}
