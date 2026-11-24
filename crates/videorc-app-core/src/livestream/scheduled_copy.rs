//! S3.5d: Upcoming's and the Schedule dialog's words
//! (`components/scheduled-streams.tsx`, `schedule-stream-dialog.tsx`,
//! `lib/scheduled-streams.ts`, `hooks/use-scheduled-streams.ts`).

// The privacy words, as `lib/scheduled-streams.ts` writes them (the setup
// screen's `copy.rs` writes the same).
pub const PRIVATE: &str = "Private";
pub const UNLISTED: &str = "Unlisted";
pub const PUBLIC: &str = "Public";

// --- the list ---

pub const NEEDS_REVIEW: &str = "Needs review";
pub const DRAFT: &str = "Draft";
pub const SCHEDULED: &str = "Scheduled";
pub const PREPARING: &str = "Preparing";
pub const ON_AIR: &str = "On air";
pub const ENDED: &str = "Ended";
pub const CANCELED: &str = "Canceled";
pub fn deleted_on(platform: &str) -> String {
    format!("Deleted on {platform}")
}
pub const LAST_CHECKED_JUST_NOW: &str = "Last checked just now";
pub fn last_checked_ago(relative: &str) -> String {
    format!("Last checked {relative} ago")
}
pub fn last_checked(relative: &str) -> String {
    format!("Last checked {relative}")
}
pub const REFRESH: &str = "Refresh";
pub const REFRESHING: &str = "Refreshing…";
pub const UPCOMING: &str = "Upcoming";
pub const PAST: &str = "Past";
pub const PAST_DESCRIPTION: &str = "Streams that ended, were canceled, or drafts you moved here.";
pub const UPCOMING_DESCRIPTION: &str =
    "You choose when each stream goes live. Nothing starts on its own.";
pub const PAST_TITLE: &str = "Past streams";
pub const UPCOMING_TITLE: &str = "Upcoming streams";
pub fn schedule_on(platform: &str) -> String {
    format!("Schedule on {platform}")
}
pub fn drafts_stay(reason: &str) -> String {
    format!("{reason} Drafts for connected accounts stay available.")
}
pub fn none_past(platform: &str, noun: &str) -> String {
    format!("No past {platform} {noun}s.")
}
pub fn none_upcoming(platform: &str, noun: &str) -> String {
    format!("No upcoming {platform} {noun}s.")
}
pub const EDIT: &str = "Edit…";
pub const DUPLICATE: &str = "Duplicate";
pub const COPY_LINK: &str = "Copy link";
pub const COPY_FAILED: &str = "Couldn't copy the event link.";
pub fn open_on(platform: &str) -> String {
    format!("Open on {platform}")
}
pub fn cancel_noun(noun: &str) -> String {
    format!("Cancel {noun}")
}
pub const MOVE_TO_PAST: &str = "Move to Past";
pub const THUMBNAIL_UPLOAD_FAILED: &str = "Event created; thumbnail upload failed. ";
pub fn updating(noun: &str) -> String {
    format!("Updating {noun}…")
}
pub const RETRY_THUMBNAIL: &str = "Retry thumbnail";
pub const RECOVER: &str = "Recover";
pub const SCHEDULE: &str = "Schedule";
pub fn schedule_draft_on(platform: &str) -> String {
    format!("Schedule this draft on {platform}")
}
pub fn more_actions(title: &str) -> String {
    format!("More actions for {title}")
}
pub fn last_checked_at(at: &str) -> String {
    format!("Last checked {at}")
}
pub const REFRESH_FAILED: &str = "Some events couldn't refresh. Showing what was last confirmed. Check the account in Destinations → Setup, then refresh.";
pub const SHOWING_LOADED_LAST: &str = "Videorc is reconnecting. Showing the events loaded last.";

// --- Cancel, Use for Go Live, Recover ---

pub const KEEP_EVENT: &str = "Keep event";
pub const KEEP_DRAFT: &str = "Keep draft";
pub const CANCEL_EVENT: &str = "Cancel event";
pub fn cancel_title(platform: &str, noun: &str) -> String {
    format!("Cancel this {platform} {noun}?")
}
pub const MOVE_DRAFT_TO_PAST: &str = "Move draft to Past?";
pub fn cancel_description(platform: &str) -> String {
    format!(
        "The upcoming broadcast will be deleted from {platform} and its link will stop working."
    )
}
pub fn draft_description(platform: &str) -> String {
    format!("The draft moves to Past. Nothing on {platform} is deleted.")
}
pub fn use_title(platform: &str, noun: &str) -> String {
    format!("Use this {platform} {noun} for Go Live")
}
pub fn use_description(title: &str, account: &str) -> String {
    format!(
        "{title} · {account}. Choose its destination. When you're ready, click {} in Studio to check every destination and start.",
        super::go_live_copy::GO_LIVE_LABEL
    )
}
pub const LIVESTREAM_DESTINATION: &str = "Livestream destination";
pub fn choose_destination(platform: &str) -> String {
    format!("Choose {platform} destination")
}
pub fn no_destination_signs_in(platform: &str, account: &str) -> String {
    format!("No {platform} destination signs in as {account}")
}
pub const THIS_ACCOUNT: &str = "this account";
pub const NO_DESTINATION_HOWTO: &str =
    "In Destinations → Setup, set a destination to Sign in with this account, then come back.";
pub const OPEN_SETUP: &str = "Open Setup";
pub const USE_SAVED_EVENT: &str = "Use saved event";
pub const CANCEL: &str = "Cancel";
pub const CLOSE: &str = "Close";
pub fn find_stream_created(platform: &str) -> String {
    format!("Find the stream {platform} created")
}
pub fn find_created(noun: &str, platform: &str) -> String {
    format!("Find the {noun} {platform} created")
}
pub const FIND_STREAM_DESCRIPTION: &str = "YouTube may already have made the stream this event uses. Check it in YouTube Studio, then choose it. Only unused streams on this channel are listed, and your saved event keeps its link.";
pub fn find_description(platform: &str, site: &str) -> String {
    format!(
        "{platform} may already have created it. Check on {site}, then choose it. Videorc doesn't create another."
    )
}
pub const INGEST_TO_RECOVER: &str = "Ingest stream to recover";
pub const EVENT_TO_RECOVER: &str = "Event to recover";
pub const CHOOSE_MATCHING: &str = "Choose the matching one";
pub const NOTHING_MATCHES: &str = "Nothing matches yet";
pub const USE_SELECTED: &str = "Use selected candidate";

// --- the Schedule dialog ---

pub fn edit_title(platform: &str, noun: &str) -> String {
    format!("Edit {platform} {noun}")
}
pub const X_DESCRIPTION: &str = "Your broadcast appears on X. Start it manually from Videorc.";
pub const YOUTUBE_DESCRIPTION: &str =
    "Your event appears on YouTube. Start it manually from Videorc.";
pub const X_ACCOUNT: &str = "X account";
pub const YOUTUBE_CHANNEL: &str = "YouTube channel";
pub const CHOOSE_CONNECTED_ACCOUNT: &str = "Choose connected account";
pub const CHOOSE_CONNECTED_CHANNEL: &str = "Choose connected channel";
pub fn sign_in_first(platform: &str) -> String {
    format!("Sign in to {platform} in Destinations → Setup first.")
}
pub const WHEN: &str = "When";
pub const DATE_AND_TIME: &str = "Date and time";
pub const PLANNED_END: &str = "Planned end";
pub const PLANNED_LENGTH: &str = "X shows the planned length. Stop whenever you like.";
pub const TIME_ZONE: &str = "Time zone";
pub const HAPPENS_TWICE: &str = "This time happens twice";
pub fn first_at(offset: &str) -> String {
    format!("The first, at {offset}")
}
pub fn second_at(offset: &str) -> String {
    format!("The second, at {offset}")
}
pub const CHOOSE_WHICH: &str = "Choose which one";
pub const CLOCKS_GO_BACK: &str = "The clocks go back that night, so this time happens twice.";
pub fn provider_settings(platform: &str) -> String {
    format!("{platform} settings")
}
pub const KEEP_REPLAY: &str = "Keep replay available";
pub const MADE_FOR_KIDS: &str = "Made for kids";
pub const NOT_FOR_KIDS: &str = "No, not made for kids";
pub const FOR_KIDS: &str = "Yes, made for kids";
pub const CHOOSE_AUDIENCE_PLACEHOLDER: &str = "Choose audience";
pub const CHANGE_AUDIENCE: &str = "Change audience in YouTube Studio, then refresh.";
pub const ASKS_KIDS: &str = "YouTube asks every stream to say whether it's made for kids.";
pub const THUMBNAIL_ALT: &str = "Upcoming stream thumbnail";
pub const THUMBNAIL_HINT: &str = "JPEG or PNG, 16:9. Files over 2 MB are scaled down to fit.";
pub const EVENT_CREATED: &str = "Event created.";
pub fn open_event_on(platform: &str) -> String {
    format!("Open event on {platform}")
}
pub const CHANGED_WHILE_EDITING: &str = "This event changed while you were editing";
pub const CHANGED_DESCRIPTION: &str =
    "Your entries are kept. Reload the latest version to review it before saving.";
pub const RELOAD_LATEST: &str = "Reload latest changes";
pub const SAVE_DRAFT: &str = "Save draft";
pub const SAVING: &str = "Saving…";
pub fn update_noun(noun: &str) -> String {
    format!("Update {noun}")
}
pub fn scheduling_unavailable(platform: &str) -> String {
    format!("Scheduling on {platform} isn't available right now.")
}
pub const KEEP_EDITING: &str = "Keep editing";
pub const DISCARD_CHANGES: &str = "Discard changes";
pub const DISCARD_TITLE: &str = "Discard changes?";
pub const DISCARD_DESCRIPTION: &str = "Your unsaved form edits will be lost.";

// --- why it can't be sent (`scheduleBlockedReason`) ---

pub const CHOOSE_X_ACCOUNT: &str = "Choose an X account.";
pub const CHOOSE_YOUTUBE_CHANNEL: &str = "Choose a YouTube channel.";
pub const ADD_A_TITLE: &str = "Add a title.";
pub const CHOOSE_AUDIENCE: &str = "Choose whether it's made for kids.";
pub const CHECKING_THE_TIME: &str = "Checking the time…";
pub const CHOOSE_PLANNED_END: &str = "Choose a planned end.";
pub const END_AFTER_START: &str = "The planned end must be after the start.";
pub const CHOOSE_X_DESTINATION: &str =
    "Choose an X destination connected to this broadcast’s account.";
pub const CHOOSE_YOUTUBE_DESTINATION: &str =
    "Choose a YouTube destination connected to this event’s channel.";

// --- The connection (`use-scheduled-streams.ts`) ---

/// A read or a change while the backend is away.
pub const RECONNECTING: &str = "Videorc is reconnecting.";
/// The first read while the backend is away.
pub const RECONNECTING_REOPEN: &str = "Videorc is reconnecting. Reopen Upcoming in a moment.";

// --- S3.5e: a saved X broadcast after the livestream
// (`releaseScheduledXPreparations`) ---

/// The release kept the event upcoming (`lifecycleStatus: "ready"`).
pub const UPCOMING_BROADCAST_PRESERVED: &str = "Upcoming broadcast preserved.";
pub fn x_scheduled_cleanup_review(message: &str) -> String {
    format!("X scheduled cleanup needs review: {message}")
}

// --- The operation runner (`runScheduledOperation`) ---

pub const OPERATION_STILL_RUNNING: &str =
    "Operation is still running. Check Upcoming before retrying.";
pub const OPERATION_DID_NOT_FINISH: &str =
    "The operation did not finish. Check Upcoming before retrying.";
