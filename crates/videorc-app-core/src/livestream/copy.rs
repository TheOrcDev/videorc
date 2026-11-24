//! The Destinations page's words (the Livestream page until #1357), byte
//! for byte as the renderer has them
//! (`components/tabs/streaming-tab.tsx`, `components/streaming/destination-card.tsx`,
//! `stream-quality-control.tsx`, `lib/platform-copy.ts`, `lib/capture.ts`,
//! `lib/stream-key-format.ts`, `lib/destination-readiness.ts`,
//! `lib/lock-reason.ts`, `shared/platform-scopes.ts`). The string-table diff
//! (`cargo test -p videorc-ui-lint --test strings -- livestream-setup`) reads
//! this file.

/// `LIVESTREAM_VIEWS`' labels and the strip's name (#1357, #1591).
pub const VIEWS_LABEL: &str = "Destinations view";
pub const VIEW_SETUP: &str = "Setup";
pub const VIEW_UPCOMING: &str = "Upcoming";
pub const VIEW_DISCORD: &str = "Discord";

/// The Destinations section.
pub const DESTINATIONS: &str = "Destinations";

/// `Where the stream goes. ${destinationCap.rule} Open a destination for its account or key.`
pub fn destinations_description(rule: &str) -> String {
    format!("Where the stream goes. {rule} Open a destination for its account or key.")
}

/// `LIVESTREAM_SETUP_LOCKS`: what the session lock covers on Setup (D-15).
/// Plan 184: Videorc Cloud joined the lock.
pub const SETUP_LOCKS: &str = "Destinations, stream quality, Videorc Cloud and stream details";

/// `sessionLockReason(locks)`.
pub fn session_lock_reason(locks: &str) -> String {
    format!(
        "{locks} are locked while you're recording or live. Changes apply the next time you record or go live."
    )
}

/// `unlockActionLabel`'s Premium word.
pub const VIEW_PREMIUM: &str = "View Premium";

/// The scheduled event's notice (`Use instant broadcast`).
pub const USE_INSTANT_BROADCAST: &str = "Use instant broadcast";

/// `StreamFailureBanner`.
pub const FAILURE_TITLE: &str = "Some destinations aren’t on air";
pub const NOTHING_ELSE_ON_AIR: &str = "No other destination is streaming, so viewers see nothing.";
pub fn failure_reconnecting(names: &str) -> String {
    format!("Reconnecting: {names}. Viewers there see nothing until it’s back.")
}
pub fn failure_not_receiving(state_label: &str, names: &str) -> String {
    format!(
        "{state_label}: {names}. Videorc is still sending; check the platform’s live dashboard."
    )
}
pub const END_LIVESTREAM: &str = "End livestream";
pub const CONTINUE_STREAMING: &str = "Continue streaming";

// --- The destination card -------------------------------------------------

/// `URL_MODE_OPTIONS`.
pub const URL_MODE: &str = "URL mode";
pub const URL_MODE_SERVER_AND_KEY: &str = "Server + key";
pub const URL_MODE_FULL_URL: &str = "Full URL";

/// `AUTH_MODE_OPTIONS` and `X_AUTH_MODE_OPTIONS`.
pub const CONNECT_WITH: &str = "Connect with";
pub const AUTH_SIGN_IN: &str = "Sign in";
pub const AUTH_STREAM_KEY: &str = "Stream key";
pub const X_AUTH_SIGN_IN: &str = "Sign in · Chat works";
pub const X_AUTH_STREAM_KEY: &str = "Stream key · No chat";

/// The row's inline context when it connects with a key.
pub const ROW_STREAM_KEY: &str = "Stream key";
/// The vertical twin's 9:16, in words beside how it connects (V-2).
pub const ROW_VERTICAL: &str = "9:16";

/// `idleDestinationBadge` and `streamTargetStatusBadge`.
pub const NEEDS_SETUP: &str = "Needs setup";
pub const PREPARED: &str = "Prepared";
pub const UPDATING: &str = "Updating";
pub const REVIEW: &str = "Review";
pub const IDLE: &str = "Idle";
pub const API_PAUSED: &str = "API paused";
pub const FALLING_BEHIND: &str = "Falling behind";
/// The quality tag's name for a screen reader (`sr-only`).
pub const STREAM_QUALITY_PREFIX: &str = "Stream quality: ";

/// `destinationUplinkLine`.
pub fn uplink_line(count: u64) -> Option<String> {
    match count {
        0 => None,
        1 => Some(
            "Your connection fell behind on this destination once; its viewers skipped a few seconds."
                .to_string(),
        ),
        count => Some(format!(
            "Your connection fell behind on this destination {count} times; its viewers skipped a few seconds each time."
        )),
    }
}

/// The switch's name.
pub fn enable_label(label: &str) -> String {
    format!("Enable {label}")
}

/// `FACEBOOK_SIGN_IN_UNAVAILABLE`: the card's sign-in note; the backend
/// refuses with the same words.
pub const FACEBOOK_SIGN_IN_UNAVAILABLE: &str =
    "Signing in with Facebook isn't available yet. Use a stream key.";
pub const CUSTOM_SIGN_IN_UNAVAILABLE: &str =
    "Custom RTMP uses a stream key. There's no account to sign in to.";
/// `${platformLabel(platform)} livestreams use a stream key. …` (TikTok, Instagram).
pub fn key_only_sign_in_unavailable(platform_name: &str) -> String {
    format!("{platform_name} livestreams use a stream key. There's no account to sign in to.")
}
/// The card's key-only line.
pub fn uses_a_stream_key(platform_name: &str) -> String {
    format!("{platform_name} uses a stream key.")
}
pub fn sign_in_not_in_build(platform_name: &str) -> String {
    format!("Signing in to {platform_name} isn't available in this build. Use a stream key.")
}

/// `manualKeyGuidance`: where each platform's key comes from (D-20).
pub const YOUTUBE_STREAM_KEY_URL: &str = "https://studio.youtube.com";
pub const YOUTUBE_STREAM_KEY_LINK_LABEL: &str = "YouTube Studio → Go live → Stream key";
pub const FACEBOOK_LIVE_PRODUCER_URL: &str = "https://www.facebook.com/live/producer";
pub const GUIDANCE_YOUTUBE: &str = "Copy the stream key from YouTube Studio: Go live, then Stream.";
pub const GUIDANCE_YOUTUBE_LINK: &str = "YouTube Studio";
pub const GUIDANCE_TWITCH: &str =
    "Copy the primary stream key from your Twitch dashboard: Settings, then Stream.";
pub const GUIDANCE_TWITCH_URL: &str = "https://dashboard.twitch.tv/settings/stream";
pub const GUIDANCE_TWITCH_LINK: &str = "Twitch dashboard";
pub const GUIDANCE_KICK: &str = "Kick keys live in Creator Dashboard → Settings → Stream Key.";
pub const GUIDANCE_KICK_URL: &str = "https://dashboard.kick.com/channel/stream";
pub const GUIDANCE_KICK_LINK: &str = "Kick dashboard";
pub const GUIDANCE_X: &str =
    "Copy the server URL and key from an RTMP source in X Media Studio Producer.";
pub const GUIDANCE_X_URL: &str = "https://studio.x.com";
pub const GUIDANCE_X_LINK: &str = "Media Studio";
pub const GUIDANCE_TIKTOK: &str = "TikTok keys change every broadcast and need LIVE access on your account. Paste a fresh server URL and key each time.";
pub const GUIDANCE_TIKTOK_URL: &str = "https://livecenter.tiktok.com";
pub const GUIDANCE_TIKTOK_LINK: &str = "TikTok LIVE Center";
pub const GUIDANCE_INSTAGRAM: &str = "Instagram keys come from Live Producer (professional accounts). Start the stream here, then press \"Go live\" there.";
pub const GUIDANCE_INSTAGRAM_URL: &str = "https://www.instagram.com/live/producer/";
pub const GUIDANCE_LIVE_PRODUCER_LINK: &str = "Live Producer";
pub const GUIDANCE_FACEBOOK: &str = "Facebook keys come from Live Producer: choose Streaming software, and turn on Persistent stream key to reuse it. Start the stream here, then press \"Go live\" there. Pages and professional profiles need 100 followers.";
pub const GUIDANCE_CUSTOM: &str = "Your streaming server gives you its server URL and stream key.";

/// The key fields.
pub const FULL_RTMP_URL: &str = "Full RTMP URL";
pub const SERVER_URL: &str = "Server URL";
pub const PLACEHOLDER_REPLACE_URL: &str = "Paste a new URL to replace it";
pub const PLACEHOLDER_FULL_URL: &str = "rtmp://server/app/key";
pub const PLACEHOLDER_SERVER_URL: &str = "rtmp://server/app";
pub const SAVE_URL: &str = "Save URL";
pub const CLEAR: &str = "Clear";
pub const SAVED_FULL_URL_HINT: &str = "Saved securely, since a full URL includes the stream key.";
pub fn saved_securely(hint: &str) -> String {
    format!("Saved securely · ends {hint}")
}
pub const STREAM_KEY: &str = "Stream key";
pub const PLACEHOLDER_REPLACE_KEY: &str = "Paste a new key to replace it";
pub const PLACEHOLDER_KEY: &str = "Paste your stream key";
pub const SAVE_KEY: &str = "Save key";
/// A hint the backend never sent (`'••••'`).
pub const NO_HINT: &str = "••••";
/// The credential's two names.
pub const CREDENTIAL_KEY: &str = "stream key";
pub const CREDENTIAL_URL: &str = "RTMP URL";
/// `Restore previous {credentialLabel}` and its hint.
pub fn restore_previous(credential: &str, hint: Option<&str>) -> String {
    let ends = hint
        .map(|hint| format!(" (ends {hint})"))
        .unwrap_or_default();
    format!("Restore previous {credential}{ends}")
}

/// `streamServerUrlIssue`.
pub const SERVER_URLS_START: &str = "Server URLs start with rtmp:// or rtmps://.";
pub const FULL_URLS_START: &str = "Full URLs start with rtmp:// or rtmps://.";
pub const ADD_SERVER_NAME: &str = "Add the server name after rtmp://, as your platform shows it.";

/// The key save and removal questions (`ConfirmDialog`s).
pub fn replace_title(label: &str, credential: &str) -> String {
    format!("Replace the {label} {credential}?")
}
pub fn save_title(credential: &str, label: &str) -> String {
    format!("Save this {credential} to {label}?")
}
pub fn replace_confirm(credential: &str) -> String {
    format!("Replace {credential}")
}
pub fn save_confirm(credential: &str) -> String {
    format!("Save {credential}")
}
pub fn replace_description(credential: &str, saved_hint: Option<&str>, new_hint: &str) -> String {
    let ending = saved_hint
        .map(|hint| format!(" ending {hint}"))
        .unwrap_or_default();
    format!(
        "The saved {credential}{ending} will be replaced by the new one ending {new_hint}. The old one is kept as your previous {credential}, so you can restore it."
    )
}
pub fn save_description(new_hint: &str, label: &str) -> String {
    format!("The key ending {new_hint} will be saved to {label}.")
}
pub fn remove_title(label: &str, credential: &str) -> String {
    format!("Remove the {label} {credential}?")
}
pub fn remove_confirm(credential: &str) -> String {
    format!("Remove {credential}")
}
pub fn remove_description(credential: &str, saved_hint: Option<&str>) -> String {
    let ending = saved_hint
        .map(|hint| format!(" ending {hint}"))
        .unwrap_or_default();
    format!(
        "The saved {credential}{ending} is kept as your previous {credential} after removal, so you can restore it."
    )
}

/// `streamKeyPlatformMismatch`.
pub fn key_mismatch(detected: &str, field: &str) -> String {
    format!("This looks like a {detected} stream key, but you're saving it to {field}.")
}

// --- Signing in ---------------------------------------------------------

pub const SIGN_IN_LINE: &str = "Videorc sets your title and gets the stream key for you.";
pub fn connect_platform(platform_name: &str) -> String {
    format!("Connect {platform_name}")
}
pub const ENVIRONMENT_OVERRIDE: &str = "Environment override";
/// `SignInPending`.
pub const WAITING_FOR_BROWSER: &str = "Waiting for your browser…";
pub const COPY_LINK: &str = "Copy link";
pub const COPIED: &str = "Copied";
pub const CANCEL: &str = "Cancel";
pub fn other_browser(platform_name: &str) -> String {
    format!("Signed in to {platform_name} in another browser? Copy the link and open it there.")
}
pub const COPY_LINK_FAILED: &str = "Couldn't copy the link";
pub const COPY_LINK_FAILED_DESCRIPTION: &str = "The page is already open in your default browser.";

/// The signed-in account.
pub const CONNECTED: &str = "Connected";
pub const NEEDS_RECONNECT: &str = "Needs reconnect";
pub const RECONNECT: &str = "Reconnect";
pub const DISCONNECT: &str = "Disconnect";
pub const LOST_ACCESS: &str =
    "Videorc lost access to this account. Reconnect to keep streaming here.";
pub fn disconnect_title(platform_name: &str) -> String {
    format!("Disconnect {platform_name}?")
}
pub fn disconnect_confirm(platform_name: &str) -> String {
    format!("Disconnect {platform_name}")
}
pub const DISCONNECT_YOUTUBE: &str = "Videorc signs out of YouTube and YouTube Vertical. To stream there again, connect the account again.";
pub fn disconnect_description(platform_name: &str) -> String {
    format!(
        "Videorc signs out of {platform_name}. To stream there again, connect the account again."
    )
}
/// `disconnectPlatformAccount`'s success toast.
pub fn disconnected(platform_name: &str) -> String {
    format!("Disconnected {platform_name}")
}
pub fn same_account_as(label: &str) -> String {
    format!("Same account and channel as {label}.")
}
pub const CHANNEL: &str = "Channel";
pub const LOADING_CHANNELS: &str = "Loading channels…";
pub const REFRESH_TO_LOAD_CHANNELS: &str = "Refresh to load your channels";
pub const CHOOSE_A_CHANNEL: &str = "Choose a channel";
pub const REFRESH_CHANNELS: &str = "Refresh channels";

/// X Live.
pub const X_LIVE_READY: &str = "X Live ready";
pub const X_AUTHORIZATION_NEEDED: &str = "Authorization needed";
pub const X_CREDENTIALS_NEEDED: &str = "Credentials needed";
pub const X_ACCOUNT_MISMATCH: &str = "Account mismatch";
pub const X_NOT_CHECKED: &str = "Not checked yet";
pub const CHECKING: &str = "Checking…";
pub const CHECK_AGAIN: &str = "Check again";
pub const AUTHORIZE_X_LIVE: &str = "Authorize X Live";
pub const AUTHORIZE_X_LIVE_HINT: &str =
    "Opens x.com to approve live broadcasting for this account.";
pub const USE_STREAM_KEY_INSTEAD: &str = "Use a stream key instead";
pub const X_PRODUCER_DOCS: &str = "X Producer docs";
pub const X_API_OVERVIEW: &str = "X API overview";

/// The permissions row (plan 140, S5; Sidekick since #1356).
pub fn remove_messages_reconnect(platform_name: &str) -> String {
    format!("Reconnect {platform_name} to let Sidekick remove messages.")
}
pub const ACTIVITY_ALL: &str = "Follow alerts, the sub count, Power-ups and channel points";
pub const ACTIVITY_AUDIENCE: &str = "Follow alerts and the sub count";
pub const ACTIVITY_BITS: &str = "Power-ups and channel points";
pub fn alongside(remove_messages: &str, what: &str) -> String {
    format!("{remove_messages} {what} need it too.")
}
pub const WHAT_ALL: &str = "Follow alerts, sub count, Power-ups and channel points";
pub const WHAT_AUDIENCE: &str = "Follow alerts and sub count";
pub fn one_more_twitch_permission(what: &str) -> String {
    format!("{what} need one more Twitch permission.")
}
pub const RECONNECT_TWITCH: &str = "Reconnect Twitch";

/// `YouTubeConsentDialog`: the consent Google reviewed. Its words never
/// change outside a new review.
pub const YOUTUBE_CONSENT_TITLE: &str = "Connect YouTube to Videorc";
pub const YOUTUBE_CONSENT_DESCRIPTION: &str = "Videorc uses YouTube API Services to identify your channel and manage your live broadcasts and chat. The requested YouTube permission is stored locally on this computer and can be revoked with Disconnect at any time.";
pub const PRIVACY_POLICY: &str = "Privacy Policy";
pub const VIDEORC_TERMS: &str = "Videorc Terms";
pub const YOUTUBE_TERMS: &str = "YouTube Terms";
pub const YOUTUBE_TERMS_URL: &str = "https://www.youtube.com/t/terms";
pub const GOOGLE_PRIVACY: &str = "Google Privacy";
pub const GOOGLE_PRIVACY_URL: &str = "https://policies.google.com/privacy";
pub const YOUTUBE_CONSENT_AGREE: &str =
    "I agree to the Videorc and YouTube terms and want to connect my YouTube account.";
pub const CONTINUE_TO_GOOGLE: &str = "Continue to Google";

/// The browser toasts (`showBrowserApproval`).
pub const APPROVE_X_LIVE: &str = "Approve X Live in your browser";

/// `reportError` contexts.
pub const ACTION_CONNECT: &str = "connect";
pub const ACTION_DISCONNECT: &str = "disconnect";

// --- Stream quality -----------------------------------------------------

pub const OUTPUT_QUALITY: &str = "Output quality";
pub const STREAM_QUALITY: &str = "Stream quality";
pub const USE_DEFAULT: &str = "Use default";
pub const CUSTOM_PROFILE: &str = "Using a saved custom profile. ";
pub const QUALITY_4K_NOTE: &str =
    "4K needs normal latency on YouTube. Other destinations keep their supported quality.";
pub const QUALITY_NOTE: &str = "Your recording keeps its own quality when this computer can run two encodes. Otherwise it matches the stream.";

/// `destinationSetupHint`.
pub const HINT_SIGN_IN: &str = "sign in or add a stream key";
pub const HINT_RECONNECT: &str = "reconnect your account";
pub const HINT_STREAM_KEY: &str = "add a stream key";
pub const HINT_SERVER_URL: &str = "fix the server URL";
pub const HINT_SERVER_URL_MISSING: &str = "add the server URL";

// --- S3.5b: Stream details (`MetadataEditor`, `BroadcastInfoFields`) ------

pub const STREAM_DETAILS: &str = "Stream details";
pub const SAVE: &str = "Save";
pub const SAVING: &str = "Saving…";
pub const LOADING_DETAILS: &str = "Loading stream details…";
pub const THUMBNAIL_ALT: &str = "Livestream thumbnail";
pub const DETAILS_FOR_EACH: &str = "Details for each destination";
pub const NEEDS_ATTENTION: &str = "Needs attention";
pub const TURN_ON_FOR_DETAILS: &str =
    "Turn on YouTube, Twitch, Kick or X in Destinations to set details for each.";
pub const CUSTOM_TITLE: &str = "Custom title and description";
pub fn custom_title_for(label: &str) -> String {
    format!("Custom title and description for {label}")
}
pub const TITLE: &str = "Title";
pub const UNTITLED: &str = "Untitled livestream";
pub const TWITCH_SUPPORTS: &str = "Twitch supports title, category, and language.";
pub const X_TITLE_ONLY: &str =
    "X broadcasts carry a title only; it doubles as the announcement post text.";
pub const DESCRIPTION: &str = "Description";
pub const OPTIONAL: &str = "Optional";
pub const PRIVACY: &str = "Privacy";
pub const MADE_FOR_KIDS: &str = "Made for kids";
pub const CATEGORY: &str = "Category";
pub const TWITCH_CATEGORY: &str = "Twitch category";
pub const KICK_CATEGORY: &str = "Kick category";
pub const LANGUAGE: &str = "Language";
pub const CHOOSE_LANGUAGE: &str = "Choose a language";
pub const KICK_NEEDS_CATEGORY: &str = "Kick needs a category from its list.";
pub const ANNOUNCE_ON_X: &str = "Announce on X timeline";
pub const X_ALWAYS_PUBLIC: &str =
    "X broadcasts are always public. Off skips the announcement post.";
pub const PRIVATE: &str = "Private";
pub const UNLISTED: &str = "Unlisted";
pub const PUBLIC: &str = "Public";
pub const PRIVACY_NOTE: &str = "Twitch, Kick and X are always public.";
pub fn replaces_title_description_privacy(label: &str) -> String {
    format!("Replaces the title, description and privacy above for {label}.")
}
pub fn replaces_title(label: &str) -> String {
    format!("Replaces the title above for {label}.")
}
pub const USES_TITLE_DESCRIPTION_PRIVACY: &str = "Uses the title, description and privacy above.";
pub const USES_TITLE: &str = "Uses the title above.";

/// `broadcastInfoIssues`, `broadcastPrivacyHint`, `broadcastThumbnailHint`.
pub const ADD_A_TITLE: &str = "Add a title before you go live.";
pub fn keep_title_to(max: usize) -> String {
    format!("Keep the title to {max} characters.")
}
pub const TITLE_ANGLES: &str = "Titles can't contain < or >.";
pub fn keep_description_to(max: &str) -> String {
    format!("Keep the description to {max} characters.")
}
pub const DESCRIPTION_ANGLES: &str = "Descriptions can't contain < or >.";
pub const PRIVACY_PUBLIC_HINT: &str = "Anyone can find it on YouTube.";
pub const PRIVACY_UNLISTED_HINT: &str = "Only people with the link can watch it on YouTube.";
pub const PRIVACY_PRIVATE_HINT: &str = "Only you can watch it on YouTube.";
pub const THUMBNAIL_HINT_SIGNED_IN: &str =
    "Shown on YouTube. JPEG or PNG, 16:9, 1280 × 720 or larger.";
pub const THUMBNAIL_HINT_KEY: &str = "Stream key destinations can't receive a thumbnail. Connect the YouTube account, or set it in YouTube Studio.";

/// `metadataOverrideSummary` and `streamDetailsStatus`.
pub const OWN_TITLE: &str = "Own title";
pub const SHARED_TITLE: &str = "Shared title";
pub const NO_ANNOUNCEMENT: &str = "No announcement";
pub const ANNOUNCES: &str = "Announces";
pub const UNSAVED_CHANGES: &str = "Unsaved changes";
pub const CHECKED: &str = "Checked";
pub const ONE_DETAIL_NEEDS_ATTENTION: &str = "1 detail needs attention";
pub fn details_need_attention(count: usize) -> String {
    format!("{count} details need attention")
}

// --- S3.5b: the thumbnail (`ThumbnailField`) and the category picker ------

pub const THUMBNAIL: &str = "Thumbnail";
pub const REPLACE_THUMBNAIL: &str = "Replace thumbnail…";
pub const CHOOSE_THUMBNAIL: &str = "Choose thumbnail…";
pub const REMOVE_THUMBNAIL: &str = "Remove thumbnail";
pub const THUMBNAIL_MISSING: &str = "The thumbnail file is missing. Choose it again.";
pub const NOT_SIXTEEN_NINE: &str = "This image isn't 16:9. YouTube will add bars.";
pub const CHOOSE_CATEGORY: &str = "Choose a category…";
pub const SEARCH_CATEGORIES: &str = "Search categories…";
pub const CLEAR_CATEGORY: &str = "Clear category";
pub const TYPE_TO_SEARCH: &str = "Type 2 or more letters to search.";
pub const SEARCHING: &str = "Searching…";
pub const NO_CATEGORIES: &str = "No categories match.";
// --- S3.5b: Ready to go live (`GoLivePanel`; Technical details moved to
// Health in #1592) ---

pub const READY_TO_GO_LIVE: &str = "Ready to go live";
pub const READY_DESTINATIONS: &str = "Destinations";
pub const TURN_ON_A_DESTINATION: &str = "Turn on at least one destination";
pub fn ready_of(ready: usize, total: usize) -> String {
    format!("{ready} of {total} ready")
}
pub const STREAM_SETTINGS: &str = "Stream settings";
pub const COULDNT_CHECK: &str = "Couldn't check";
pub const CHECKS_AGAIN_AT_START: &str = "Go Live checks again when you start.";
pub const RETRY: &str = "Retry";
pub const NOT_CHECKED_YET: &str = "Not checked yet. Go Live checks it first.";
pub const QUALITY: &str = "Quality";
pub fn choose_stream_safe(quality: &str) -> String {
    format!("{quality} · choose a stream-safe preset")
}
pub const VARIES_BY_DESTINATION: &str = "Varies by destination";
pub const RECORDING: &str = "Recording";
pub fn matches_the_stream(quality: &str) -> String {
    format!("{quality} · matches the stream")
}
pub const UPLOAD_NEEDED: &str = "Upload needed";
pub fn about_mbps(mbps: f64) -> String {
    format!("About {} Mbps", trim_number(mbps))
}
pub const DISK: &str = "Disk";
pub fn about_gb_per_hour(gb: f64) -> String {
    format!("About {} GB per hour", trim_number(gb))
}
/// JavaScript's number to string for a rounded decimal.
pub fn trim_number(value: f64) -> String {
    let text = format!("{value}");
    text.strip_suffix(".0").map(str::to_string).unwrap_or(text)
}
pub const FFMPEG: &str = "FFmpeg";
pub const MISSING: &str = "Missing";
/// `videoProfileCompatibility`'s warning (lib/capture.ts).
pub const FOUR_K_RECORDING_WARNING: &str = "4K local recording while livestreaming is known to drop recorded video to ~8fps (audio keeps running). Until the split-output fix ships, record at 1080p/2K while streaming, stream without local 4K recording, or record 4K without streaming.";
pub const ENCODER: &str = "Encoder";
pub const STREAM: &str = "Stream";
pub fn requested(effective: &str, requested: &str) -> String {
    format!("{effective} (requested {requested})")
}
pub const BADGE_READY: &str = "Ready";
pub const BADGE_UNKNOWN: &str = "Unknown";
pub const BADGE_FALLBACK: &str = "Fallback";

// --- S3.5e: the stream on air (`go-live-panel.tsx`: `LiveStreamRow`,
// `streamHealthBadge`, `streamHealthDescription`) ---

pub const BADGE_HEALTHY: &str = "Healthy";
/// `streamHealthBadge`'s other verdicts: the attribution, capitalised.
pub const BADGE_DEVICE: &str = "Device";
pub const BADGE_AUDIO: &str = "Audio";
pub const BADGE_CAPTURE: &str = "Capture";
pub const BADGE_RENDER: &str = "Render";
pub const BADGE_ENCODER: &str = "Encoder";
pub const BADGE_NETWORK: &str = "Network";
pub const BADGE_PREVIEW: &str = "Preview";
pub const LIVE_DEVICE: &str = "A disconnected capture device is interrupting the stream.";
pub const LIVE_AUDIO: &str = "Audio capture is dropping data before the stream encode.";
pub const LIVE_CHOPPY: &str = "The stream is skipping frames that could not be sent in time, so viewers see a stutter. The recording is unaffected.";
pub const LIVE_UPLINK: &str = "Your connection can’t carry this stream to every destination. Videorc lowers the stream’s bitrate to keep it moving; fewer destinations give it more room.";
pub const LIVE_CAPTURE: &str = "Capture is running below the target frame rate.";
pub const LIVE_RENDER: &str = "The scene is rendering below the target frame rate.";
pub const LIVE_ENCODER: &str = "The encoder or its output queue is losing frames.";
pub const LIVE_FALLBACK: &str = "The stream is using a confirmed fallback output path.";
pub const LIVE_NETWORK: &str = "Media is healthy, but delivery or a destination is degraded.";
pub const LIVE_PREVIEW: &str = "The stream is healthy; only the local preview is degraded.";
pub const LIVE_HEALTHY: &str = "Media and delivery are healthy.";
pub const LIVE_UNKNOWN: &str = "Waiting for enough evidence to judge the stream.";
pub const BITRATE: &str = "Bitrate";
pub const ENCODER_SPEED: &str = "Encoder speed";
pub const DROPPED_FRAMES: &str = "Dropped frames";
/// `formatDeliveredFps`: "21 of 30 fps".
pub fn delivered_fps(delivered: i64, target: &str) -> String {
    format!("{delivered} of {target} fps")
}
/// `formatLoweredBitrate`: "4.8 of 6 Mbps".
pub fn lowered_bitrate(current: &str, chosen: &str) -> String {
    format!("{current} of {chosen} Mbps")
}

// --- S3.5b: Discord (`discord-section.tsx`, `lib/discord-announce.ts`) ---

/// #1591: Discord is its own view; the page header's title.
pub const DISCORD: &str = "Discord announcements";
pub fn discord_description(several: bool) -> String {
    let servers = if several { "servers" } else { "server" };
    format!(
        "Tell your {servers} when you go live. Unlisted and private YouTube streams are never announced."
    )
}
pub const LOADING_DISCORD: &str = "Loading Discord settings…";
pub const DISCORD_UNREADABLE: &str =
    "Couldn't read the Discord settings. Reopen Destinations to try again.";
pub const WEBHOOK_URL: &str = "Webhook URL";
pub const NEW_WEBHOOK_URL: &str = "New webhook URL";
pub const ANOTHER_WEBHOOK_URL: &str = "Another webhook URL";
pub const WEBHOOK_PLACEHOLDER: &str = "https://discord.com/api/webhooks/…";
pub const CONNECTING: &str = "Connecting…";
pub const CONNECT: &str = "Connect";
pub const WEBHOOK_HOWTO: &str =
    "In Discord: Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.";
pub const NOT_A_WEBHOOK: &str = "That isn't a Discord webhook URL.";
pub fn webhook_cap(max: usize) -> String {
    format!("You can connect up to {max} webhooks. Remove one to add another.")
}
pub const ADD_WEBHOOK: &str = "Add webhook…";
pub const ANNOUNCE_WHEN_LIVE: &str = "Announce when I go live";
pub const ANNOUNCE_DESCRIPTION: &str = "One post in every connected server when you're on air. It adds destinations as they come up and says when you stopped.";
pub const POST_AS: &str = "Post as";
pub const POST_AS_DESCRIPTION: &str = "Whose name and picture the post shows.";
pub const AUTOMATIC: &str = "Automatic";
pub fn automatic_with(name: &str) -> String {
    format!("Automatic · {name}")
}
pub const WEBHOOK_OWN_NAME: &str = "The webhook's own name";
pub const PING: &str = "Ping";
pub const PING_DESCRIPTION: &str = "Edits and test messages never ping.";
pub const NO_PING: &str = "No ping";
pub const PING_HERE: &str = "@here";
pub const PING_EVERYONE: &str = "@everyone";
pub const VIDEORC_FOOTER: &str = "Videorc footer";
pub const FOOTER_DESCRIPTION: &str = "Adds \"Live with Videorc\" under the post.";
pub const NEXT_STREAM: &str = "Changes apply to your next stream.";
pub const REMOVE_WEBHOOK: &str = "Remove webhook";
pub const REMOVE_WEBHOOK_DESCRIPTION: &str =
    "Videorc stops posting to its channel. The webhook itself stays in Discord.";
pub fn remove_named_webhook(name: &str) -> String {
    format!("Remove the {name} webhook?")
}
pub const REMOVE_DISCORD_WEBHOOK: &str = "Remove the Discord webhook?";
pub const WEBHOOK: &str = "Webhook";
pub fn posts_to_channel(hint: &str) -> String {
    format!("Posts to its channel · {hint}")
}
pub fn last_post(when: &str, live: bool) -> String {
    let still = if live { ", still live" } else { "" };
    format!("Last post {when}{still}.")
}
pub const TEST_SENT: &str = "Test sent.";
pub const CHECK_THE_CHANNEL: &str = "Check the channel in Discord.";
pub const WEBHOOK_DELETED_LINE: &str = "This webhook was deleted in Discord. Paste a new one.";
pub const UNREACHABLE_LINE: &str = "The last post couldn't reach Discord.";
pub const REJECTED_LINE: &str =
    "Discord refused the last post. Check the webhook, or paste a new one.";
pub const PASTE_NEW_FIRST: &str = "Paste a new webhook URL first.";
pub const SENDING: &str = "Sending…";
pub const SEND_TEST: &str = "Send test message";
pub const REMOVE: &str = "Remove";
pub const VIEW_IN_DISCORD: &str = "View in Discord";
pub const LINKS_IN_THE_POST: &str = "Links in the post";
pub fn link_in_post(label: &str) -> String {
    format!("Link {label} in the post")
}
pub const LINK_AT_GO_LIVE: &str = "Link made when you go live";
pub const NO_PUBLIC_LINK: &str = "No public link";
pub fn link_of(label: &str) -> String {
    format!("{label} link")
}
pub const LINK_PLACEHOLDER: &str = "https://…";
pub const ADD_LINK: &str = "Add link…";
pub fn type_a_link(label: &str) -> String {
    format!("Type a link for {label}")
}
pub fn remove_typed_link(label: &str) -> String {
    format!("Remove the typed link for {label}")
}

/// `failureCopy` (lib/discord-announce.ts): a go-live post that failed.
pub const COULDNT_POST_TO_DISCORD: &str = "Couldn't post to Discord";
/// `The ${name} webhook`, or `The webhook`.
pub fn the_webhook(name: Option<&str>) -> String {
    match name {
        Some(name) => format!("The {name} webhook"),
        None => "The webhook".to_string(),
    }
}
pub fn webhook_deleted_toast(webhook: &str) -> String {
    format!("{webhook} was deleted in Discord. Paste a new one in Destinations → Discord.")
}
pub fn unreachable_toast(name: Option<&str>) -> String {
    match name {
        Some(name) => {
            format!("Discord couldn't be reached for 5 minutes ({name}). Your stream is fine.")
        }
        None => "Discord couldn't be reached for 5 minutes. Your stream is fine.".to_string(),
    }
}
pub fn rejected_toast(name: Option<&str>) -> String {
    match name {
        Some(name) => {
            format!(
                "Discord refused the post to {name}. Check the webhook in Destinations → Discord."
            )
        }
        None => {
            "Discord refused the post. Check the webhook in Destinations → Discord.".to_string()
        }
    }
}
/// `CategoryCombobox`'s search field.
pub fn search_category(label: &str) -> String {
    format!("Search {label}")
}

// --- S3.5c: the sign-in's answer (`showOAuthCallbackResult`,
// lib/session-runtime-recovery.ts; `youtubeConnectPausedMessage`,
// lib/youtube-quota-copy.ts) ---

pub fn connected_platform(platform: &str) -> String {
    format!("Connected {platform}")
}
pub const ACCOUNT_CONNECTED: &str = "Account connected";
pub const X_LIVE_ON: &str = "X Live is on";
pub fn couldnt_finish_connecting(platform: &str) -> String {
    format!("Couldn't finish connecting {platform}")
}
pub const THE_ACCOUNT: &str = "the account";
pub const CONNECTION_NOT_COMPLETED: &str = "Connection couldn't be completed.";
pub fn youtube_connect_paused(resume: &str) -> String {
    format!(
        "Couldn't finish connecting YouTube. Videorc's daily YouTube API limit is used up. Try again after {resume}."
    )
}
pub const THE_RESET: &str = "the reset";
pub fn tomorrow_at(time: &str) -> String {
    format!("tomorrow {time}")
}

/// `formatResumeTime`: the time, "tomorrow" and the time, or the date and
/// the time (the system's local zone).
pub fn format_resume_time(at: &str, now: chrono::DateTime<chrono::Local>) -> String {
    let Ok(date) = chrono::DateTime::parse_from_rfc3339(at) else {
        return THE_RESET.to_string();
    };
    let date = date.with_timezone(&chrono::Local);
    let time = date.format("%I:%M %p").to_string();
    if date.date_naive() == now.date_naive() {
        return time;
    }
    if now.date_naive().succ_opt() == Some(date.date_naive()) {
        return tomorrow_at(&time);
    }
    format!("{} {time}", date.format("%b %-d"))
}

/// S3.5c: YouTube's API paused on a card (`youtubeDestinationPausedMessage`,
/// lib/youtube-quota-copy.ts).
pub fn youtube_destination_paused(resume: &str) -> String {
    format!(
        "YouTube's API is paused until {resume}: Videorc's daily YouTube API limit is used up. Chat, viewers and subscribers resume on their own; to go live on YouTube before then, use your stream key."
    )
}
pub const USE_STREAM_KEY: &str = "Use stream key";
