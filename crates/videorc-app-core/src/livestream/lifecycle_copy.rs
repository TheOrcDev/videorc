//! S3.5c: the platforms' lifecycle words (`hooks/use-studio.tsx`:
//! `runGoLiveConfirmation`, `prepareOauthTargetsForGoLive`, the YouTube and X
//! activation and cleanup) and their toasts: a destination's status lines,
//! which the Livestream page's cards show. The Studio screen's table holds
//! them; the Go Live dialog's own words are `go_live_copy`'s.

/// `LIVESTREAM_STILL_SETTLING`.
pub const LIVESTREAM_STILL_SETTLING: &str =
    "Videorc is still ending your last livestream on its platforms. Try again in a moment.";
pub const NO_READY_AFTER_SETUP: &str = "No livestream destinations are ready after platform setup.";
/// `STREAM_OUTPUT_SPLIT_UNAVAILABLE_REASON`.
pub const SPLIT_UNAVAILABLE: &str = "This computer can't encode the recording and the livestream separately. Use the same quality for every destination, set captions to burn into both or neither, or turn off recording, then go live.";
pub fn output_check_failed(message: &str) -> String {
    format!("Livestream output check failed: {message}")
}
/// The check had no answer for this Go Live: offline, replaced by a newer
/// check, or abandoned.
pub const OUTPUT_CHECK_UNSETTLED: &str = "It didn't finish. Try again.";
pub const SCHEDULED_EVENT_CHANGED: &str = "The scheduled event changed";
pub const SCHEDULED_EVENT_CHANGED_DESCRIPTION: &str =
    "Review its updated visibility and details, then confirm again.";
/// The prepared targets' status lines (`prepareOauthTargetsForGoLive`).
pub const YOUTUBE_PREPARED: &str = "YouTube broadcast prepared.";
pub const TWITCH_PREPARED: &str = "Twitch channel prepared.";
pub const KICK_PREPARED: &str = "Kick channel prepared.";
pub const X_PREPARED: &str = "X source prepared.";
pub const X_PREPARED_ACTIVE: &str = "X source prepared; ingest is already active.";
pub const SAVED_X_PREPARED: &str = "Saved X broadcast prepared.";
pub const TWITCH_KEY_NO_ACCOUNT: &str =
    "Streaming over stream key. Connect Twitch to push title and category.";
/// A stream-key Twitch (else Kick) took the title through its account.
pub fn channel_metadata_updated(twitch: bool, title: &str) -> String {
    if twitch {
        format!("Twitch channel metadata updated (\"{title}\").")
    } else {
        format!("Kick channel metadata updated (\"{title}\").")
    }
}
pub fn channel_metadata_failed(message: &str) -> String {
    format!("Streaming over stream key; channel metadata update failed: {message}")
}
pub const WAITING_FOR_YOUTUBE_INGEST: &str = "Waiting for YouTube ingest.";
pub const YOUTUBE_INGEST_NOT_ACTIVE: &str = "YouTube ingest didn't become active yet.";
pub const YOUTUBE_LIVE: &str = "YouTube broadcast is live.";
pub fn youtube_needs_review(message: &str) -> String {
    format!("YouTube go-live needs review: {message}")
}
pub fn youtube_cleanup_review(message: &str) -> String {
    format!("YouTube cleanup needs review: {message}")
}
pub const YOUTUBE_ENDED: &str = "YouTube broadcast ended.";
pub const WAITING_FOR_X_INGEST: &str = "Waiting for X ingest.";
pub fn x_needs_review(message: &str) -> String {
    format!("X go-live needs review: {message}")
}
pub const COMPLETING_YOUTUBE: &str = "Completing YouTube broadcast.";
/// A scheduled YouTube event released and still upcoming.
pub const UPCOMING_EVENT_PRESERVED: &str = "Upcoming event preserved.";
/// The X producer reminder: an X stream key feeds X, which doesn't go live
/// from the feed alone.
pub const X_FEED_CONNECTED: &str = "X feed is connected: start the broadcast on X";
pub const X_FEED_CONNECTED_DESCRIPTION: &str = "X doesn't go live from the RTMP feed alone: open Media Studio → Producer → Broadcasts, create a broadcast from your source, and press Broadcast.";
/// The X destination's line once `x.publish` answered.
pub fn x_live(share_url: &str) -> String {
    format!("X broadcast is live: {share_url}")
}

/// `showXBroadcastProblem('chat')`: X went live but its chat did not
/// connect; the stream is fine (S3.2f).
pub fn x_chat_not_connected(label: &str) -> String {
    format!("X chat isn't connected for {label}")
}
/// #1357, #1528: now the notification's detail.
pub const X_CHAT_NOT_CONNECTED_DESCRIPTION: &str = "Your stream is fine. Check X in Destinations.";
pub const ENDING_X_BROADCAST: &str = "Ending X broadcast.";
/// S3.5e: X's playback check (`streamTargets.x.playback`) on the X
/// destination's status line.
pub fn x_watchable(share_url: &str) -> String {
    format!("Viewers can watch your X broadcast: {share_url}")
}
pub const X_PROVISIONING: &str = "X is still provisioning playback. Viewers may see a loading spinner. Keep streaming; this can take a few minutes.";
/// #1231: X ends the broadcast itself when no video reached it.
pub const X_NEVER_PLAYED: &str = "X ended your broadcast while Videorc was still streaming (usually no video reached X). Your local recording is unaffected.";
pub fn x_cleanup_review(message: &str) -> String {
    format!("X cleanup needs review: {message}")
}
/// `showXBroadcastProblem('end')` (`lib/studio-toasts.ts`).
pub const END_IT_IN_MEDIA_STUDIO: &str = "End it in X Media Studio.";
pub const OPEN_MEDIA_STUDIO: &str = "Open Media Studio";
/// `X_MEDIA_STUDIO_URL`: where an X broadcast is started and ended by hand.
pub const X_MEDIA_STUDIO_URL: &str = "https://studio.x.com";
pub const OPERATION_STILL_RUNNING: &str =
    "Operation is still running. Check Upcoming before retrying.";
pub const OPERATION_DID_NOT_FINISH: &str =
    "The operation did not finish. Check Upcoming before retrying.";
/// `youtubeBroadcastToast`: the destination named only when its label is
/// not the platform's name.
pub fn youtube_broadcast_toast(
    start: bool,
    label: &str,
    description: &str,
) -> (&'static str, String) {
    let label = label.trim();
    let named = if !label.is_empty() && !label.eq_ignore_ascii_case("YouTube") {
        format!("{label}: {description}")
    } else {
        description.to_string()
    };
    (
        if start {
            "Couldn't start the YouTube broadcast"
        } else {
            "Couldn't end the YouTube broadcast"
        },
        named,
    )
}
