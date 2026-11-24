//! What a failed action says (plan 220 S3.1f): `lib/user-error.ts`'s
//! `userErrorMessage`, `toastUserError` and `toastOffline`, and
//! `showBackendError` (`lib/session-runtime-recovery.ts`), for the Studio's
//! takeover and soundboard actions. The toast names what failed and what to
//! do ("Couldn't show the takeover" over the next step); the raw text goes to
//! the log, never to the toast (plan 174 S2.4).

use crate::client::{RpcError, codes};
use crate::notices::{self, NoticeAction, NoticeCommand, NoticeLifetime, ToastRequest};

/// `UNKNOWN_REASON`: the next step when Videorc doesn't know why.
pub const UNKNOWN_REASON: &str = notices::copy::UNKNOWN_REASON;
/// `OFFLINE_REASON`.
pub const OFFLINE_REASON: &str = notices::copy::OFFLINE_REASON;
/// `OFFLINE_TOAST_ID`: one "reconnecting" toast, whatever asked.
pub const OFFLINE_TOAST_ID: &str = "videorc-offline";
/// `BUSY_REASON`.
pub const BUSY_REASON: &str = "Videorc was busy and didn't do it. Try again in a moment.";
/// `KNOWN_CODES['request-outcome-unknown']`.
pub const OUTCOME_UNKNOWN_REASON: &str =
    "Videorc didn't hear back in time. Check whether it worked before you try again.";
/// `SECURE_STORAGE_REASON`: the OS store refused to seal a grant or a
/// sign-in.
pub const SECURE_STORAGE_REASON: &str = "Videorc couldn't reach your system keyring to save this. Make sure a keyring is running and unlocked, then try again.";
/// `couldNotTitle(undefined)`: a failure with no action named.
pub const NO_CONTEXT_TITLE: &str = "Videorc hit a problem";
/// The offline copy without a context.
pub const OFFLINE_TITLE: &str = "Videorc is reconnecting";
pub const OFFLINE_NEXT_STEP: &str = "Try again in a moment.";
/// A canceled action (`AbortError`): never toasted.
pub const CANCELED: &str = "It was canceled.";

/// `KNOWN_CODES`: backend error codes with a cause the streamer can act on,
/// and whether each is a warning (`WARNING_CODES`: can't now) rather than an
/// error.
pub const KNOWN_CODES: [(&str, &str, bool); 24] = [
    (
        codes::REQUEST_OUTCOME_UNKNOWN,
        OUTCOME_UNKNOWN_REASON,
        false,
    ),
    ("command-expired-before-dispatch", BUSY_REASON, true),
    ("command-lane-full", BUSY_REASON, true),
    (
        "screen-import-busy",
        "Another file is already being imported. Wait for it to finish, then try again.",
        true,
    ),
    ("command-not-applied", BUSY_REASON, true),
    (
        "clean-cut-mutation-blocked",
        "Clean cut is still working on this recording. Try again when it finishes.",
        true,
    ),
    (
        "noise-cleanup-mutation-blocked",
        "Noise cleanup is still working on this recording. Try again when it finishes.",
        true,
    ),
    (
        "session-rename-invalid",
        "A title needs 1 to 120 characters.",
        false,
    ),
    (
        "youtube-quota-paused",
        "Videorc's daily YouTube API limit is used up. Try again after it resets.",
        false,
    ),
    (
        "layout-camera-not-ready",
        "Your camera isn't sending video. Check it in Sources, then try again.",
        false,
    ),
    (
        "layout-screen-not-ready",
        "Your screen isn't sending video. Check it in Sources, then try again.",
        false,
    ),
    // Plan 184 C6b: the Test cloud's refusals (the button is disabled for
    // each, so these cover a click that raced a change).
    (
        "cloud-test-session-active",
        "Locked while you're recording or live.",
        true,
    ),
    (
        "cloud-test-show-live",
        "A show is live through Videorc Cloud. End it first.",
        true,
    ),
    (
        "cloud-test-running",
        "A Videorc Cloud test is already running.",
        true,
    ),
    // Plan 224: Open the room's refusals (`RoomOpenRefusal`).
    (
        "cloud-room-session-active",
        "Stop the recording or the livestream, then open the room.",
        true,
    ),
    (
        "cloud-show-live",
        "A show is live through Videorc Cloud. End it first.",
        true,
    ),
    // Plan 243: continuing a show on another device (the web's refusals,
    // D8), and Go Live on a held show another device is on air for.
    (
        "cloud-handoff-update",
        "Update Videorc on the other computer first, or end the stream and go live again.",
        true,
    ),
    (
        "cloud-handoff-unsupported",
        "This show can't continue on another device.",
        true,
    ),
    // A feed that never arrived failed: the one cloud code that is an error.
    (
        "cloud-source-not-ready",
        "Videorc Cloud didn't get this computer's video in time. Try again.",
        false,
    ),
    (
        "cloud-not-on-air",
        "Your show is live from another device now.",
        true,
    ),
    (
        "cloud-nothing-to-resume",
        "Your show isn't live anymore.",
        true,
    ),
    (
        "cloud-show-live-elsewhere",
        "Your show is live on another device. Use Continue here, or end it first.",
        true,
    ),
    // #1276: a scene whose layout needs a source set to None or Off. Trying
    // again cannot help, so the copy says what to pick instead.
    (
        "layout-screen-not-selected",
        "This scene needs a screen or window. Pick one in Sources, or choose a camera-only scene.",
        true,
    ),
    (
        "layout-camera-not-selected",
        "This scene needs a camera. Turn one on in Sources, or choose a scene without a camera.",
        true,
    ),
];

/// `knownErrorReason` (plan 243 R2 A-M6): a coded backend error's known
/// cause, or `None`. A refused start says it instead of the backend's words,
/// which may name a device.
pub fn known_error_reason(error: &RpcError) -> Option<&'static str> {
    KNOWN_CODES
        .iter()
        .find(|(code, ..)| *code == error.code.as_str())
        .map(|(_, reason, _)| *reason)
}

/// `LINUX_KEYRING_REFUSAL` (plan 257 S18): main's Linux sign-in refusal,
/// matched by its opening; it already names what to install.
const LINUX_KEYRING_REFUSAL_PREFIX: &str = "Signing in needs a keyring";

/// `UserErrorContext`: the verb the streamer asked for and what it acted on,
/// with its article ("show", "the takeover").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UserErrorContext {
    pub action: &'static str,
    pub object: &'static str,
}

/// S3.5b: `saveStreamMetadataDraft`'s toasts (use-studio.tsx): Save before
/// the draft loaded, and a saved draft that still needs work before Go Live.
pub const DETAILS_STILL_LOADING: &str = "Stream details are still loading";
pub fn saved_needs_attention(count: usize) -> String {
    if count == 0 {
        return "Saved. Some details need attention before you go live".to_string();
    }
    format!(
        "Saved. {} {} attention before you go live",
        crate::studio::health_page::group_thousands(count as i64),
        if count == 1 {
            "detail needs"
        } else {
            "details need"
        }
    )
}

/// S3.5c: an X broadcast that didn't start (`showXBroadcastProblem`).
pub const START_THE_X_BROADCAST: UserErrorContext = UserErrorContext {
    action: "start",
    object: "the X broadcast",
};

/// S3.2b: the Stream Manager's chat contexts (`{ action: 'remove', object:
/// 'the message' }`, `{ action: 'send', … }`).
pub const REMOVE_THE_MESSAGE: UserErrorContext = UserErrorContext {
    action: "remove",
    object: "the message",
};
pub const SEND_THE_MESSAGE: UserErrorContext = UserErrorContext {
    action: "send",
    object: "the message",
};
/// S3.5a: the Livestream page's stream key (`saveManualStreamKey`,
/// `restorePreviousStreamKey`).
pub const SAVE_THE_STREAM_KEY: UserErrorContext = UserErrorContext {
    action: "save",
    object: "the stream key",
};
pub const RESTORE_THE_PREVIOUS_STREAM_KEY: UserErrorContext = UserErrorContext {
    action: "restore",
    object: "the previous stream key",
};

/// What failed: a request's error, Videorc away, or a reason that already
/// reads as copy (`UserFacingError`, a warning when it is a refusal).
#[derive(Debug, Clone, Copy)]
pub enum Failure<'a> {
    Rpc(&'a RpcError),
    Offline,
    Sentence { text: &'a str, warning: bool },
}

/// `UserError['kind']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserErrorKind {
    Offline,
    Known,
    Canceled,
    Unknown,
}

/// `UserError`: the toast's title and description, and its tone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserError {
    pub kind: UserErrorKind,
    pub title: String,
    pub description: String,
    pub warning: bool,
}

/// `couldNotTitle`: "Couldn't show the takeover", or "Videorc hit a
/// problem" without a context.
pub fn could_not_title(context: Option<UserErrorContext>) -> String {
    let Some(context) = context else {
        return NO_CONTEXT_TITLE.to_string();
    };
    let object = if context.object.is_empty() {
        String::new()
    } else {
        format!(" {}", context.object)
    };
    format!("Couldn't {}{}", context.action, object)
}

/// The transport's own texts for a connection that is down
/// (`OFFLINE_RAW`): all of them mean "reconnecting".
fn offline_raw(error: &RpcError) -> bool {
    matches!(
        error.code.as_str(),
        codes::NOT_CONNECTED | codes::CONNECTION_CLOSED | codes::NOT_SENT
    ) || error.message.trim() == OFFLINE_REASON
}

/// `userErrorMessage(error, context)`: a known cause keeps its sentence,
/// anything else gets the generic next step.
pub fn user_error_message(failure: Failure<'_>, context: Option<UserErrorContext>) -> UserError {
    let shape = |kind, description: &str, warning| UserError {
        kind,
        title: could_not_title(context),
        description: description.to_string(),
        warning,
    };
    let offline = || match context {
        Some(_) => shape(UserErrorKind::Offline, OFFLINE_REASON, true),
        None => UserError {
            kind: UserErrorKind::Offline,
            title: OFFLINE_TITLE.to_string(),
            description: OFFLINE_NEXT_STEP.to_string(),
            warning: true,
        },
    };
    match failure {
        Failure::Rpc(error) if error.code == "aborted" => {
            shape(UserErrorKind::Canceled, CANCELED, true)
        }
        Failure::Offline => offline(),
        Failure::Rpc(error) if offline_raw(error) => offline(),
        Failure::Sentence { text, warning } if !text.trim().is_empty() => {
            shape(UserErrorKind::Known, text.trim(), warning)
        }
        Failure::Sentence { .. } => shape(UserErrorKind::Unknown, UNKNOWN_REASON, false),
        Failure::Rpc(error) => match KNOWN_CODES
            .iter()
            .find(|(code, ..)| *code == error.code.as_str())
        {
            Some((_, reason, warning)) => shape(UserErrorKind::Known, reason, *warning),
            None if error.message.trim() == "Protected desktop persistence is unavailable." => {
                shape(UserErrorKind::Known, SECURE_STORAGE_REASON, false)
            }
            None if error
                .message
                .trim()
                .starts_with(LINUX_KEYRING_REFUSAL_PREFIX) =>
            {
                shape(UserErrorKind::Known, error.message.trim(), false)
            }
            None if error.message.trim().ends_with("its outcome is unknown.") => {
                shape(UserErrorKind::Known, OUTCOME_UNKNOWN_REASON, false)
            }
            None => shape(UserErrorKind::Unknown, UNKNOWN_REASON, false),
        },
    }
}

fn toast(copy: &UserError) -> ToastRequest {
    if copy.warning {
        ToastRequest::warning(copy.title.clone())
    } else {
        ToastRequest::error(copy.title.clone())
    }
    .description(copy.description.clone())
}

/// `toastUserError(error, context, {id})`: one toast typed by meaning (a
/// warning when it can't happen now, else an error); nothing for a cancel.
pub fn toast_user_error(
    failure: Failure<'_>,
    context: UserErrorContext,
    id: &str,
) -> Option<NoticeCommand> {
    let copy = user_error_message(failure, Some(context));
    (copy.kind != UserErrorKind::Canceled)
        .then(|| NoticeCommand::Show(toast(&copy).id(id).finish()))
}

/// `toastOffline(context)`: "Couldn't … · Videorc is reconnecting".
pub fn toast_offline(context: UserErrorContext) -> NoticeCommand {
    let copy = user_error_message(Failure::Offline, Some(context));
    NoticeCommand::Show(toast(&copy).id(OFFLINE_TOAST_ID).finish())
}

/// `showBackendError(error, wsStatus, context)` (`reportError`): nothing for
/// a dropped connection while the status already says reconnecting; the
/// offline toast; else one toast per failure (notifyOnce's key as its id),
/// and a failure Videorc can't explain opens Health on its timed life.
pub fn backend_error_toast(
    error: &RpcError,
    connected: bool,
    context: UserErrorContext,
) -> Option<NoticeCommand> {
    // `shouldToastBackendError`: a transient transport error while the
    // socket is down is the status bar's news, not a toast.
    if !connected && offline_raw(error) {
        return None;
    }
    let copy = user_error_message(Failure::Rpc(error), Some(context));
    if copy.kind == UserErrorKind::Canceled {
        return None;
    }
    if copy.kind == UserErrorKind::Offline {
        return Some(NoticeCommand::Show(
            toast(&copy).id(OFFLINE_TOAST_ID).finish(),
        ));
    }
    let mut request = toast(&copy).id(format!(
        "backend-error:{}:{}",
        copy.title,
        error.message.trim()
    ));
    if copy.kind == UserErrorKind::Unknown {
        request = request
            .action(
                crate::studio::health_page::OPEN_HEALTH_LABEL,
                NoticeAction::OpenHealth,
            )
            .duration(NoticeLifetime::For(notices::WITH_DESCRIPTION));
    }
    Some(NoticeCommand::Show(request.finish()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notices::NoticeKind;

    const SHOW: UserErrorContext = UserErrorContext {
        action: "show",
        object: "the takeover",
    };

    fn shown(command: NoticeCommand) -> crate::notices::Notice {
        command.notice().cloned().expect("a toast")
    }

    #[test]
    fn known_codes_say_their_copy_and_cloud_refusals_are_warnings() {
        let error = |code: &str| RpcError::new("session.start", code, "camera:FaceTime HD failed");
        assert_eq!(
            known_error_reason(&error("layout-camera-not-selected")),
            Some(
                "This scene needs a camera. Turn one on in Sources, or choose a scene without a camera."
            )
        );
        assert_eq!(known_error_reason(&error("encoder-failed")), None);
        let context = Some(UserErrorContext {
            action: "start",
            object: "the recording",
        });
        let refusal =
            user_error_message(Failure::Rpc(&error("cloud-show-live-elsewhere")), context);
        assert!(refusal.warning);
        let feed = user_error_message(Failure::Rpc(&error("cloud-source-not-ready")), context);
        assert!(!feed.warning, "a feed that never arrived failed");
        let keyring = RpcError::new(
            "account.signIn",
            "internal",
            "Signing in needs a keyring. Install gnome-keyring.",
        );
        assert_eq!(
            user_error_message(Failure::Rpc(&keyring), context).description,
            "Signing in needs a keyring. Install gnome-keyring."
        );
    }

    #[test]
    fn a_failure_says_what_failed_and_what_to_do() {
        let unknown = RpcError::new("screens.activate", "screen-not-found", "no such row");
        let copy = user_error_message(Failure::Rpc(&unknown), Some(SHOW));
        assert_eq!(copy.title, "Couldn't show the takeover");
        assert_eq!(copy.description, UNKNOWN_REASON);
        assert_eq!(copy.kind, UserErrorKind::Unknown);
        assert!(!copy.warning);

        let busy = RpcError::new("screens.activate", "command-lane-full", "full");
        let copy = user_error_message(Failure::Rpc(&busy), Some(SHOW));
        assert_eq!(copy.description, BUSY_REASON);
        assert!(copy.warning, "busy can't happen now: a warning");

        let away = RpcError::not_connected("screens.activate");
        let copy = user_error_message(Failure::Rpc(&away), Some(SHOW));
        assert_eq!(copy.kind, UserErrorKind::Offline);
        assert_eq!(copy.description, OFFLINE_REASON);

        let refusal = user_error_message(
            Failure::Sentence {
                text: "That sound isn't available anymore.",
                warning: true,
            },
            Some(UserErrorContext {
                action: "play",
                object: "the sound",
            }),
        );
        assert_eq!(refusal.title, "Couldn't play the sound");
        assert_eq!(refusal.description, "That sound isn't available anymore.");
        assert!(refusal.warning);

        // No context: Electron's generic titles.
        let away = user_error_message(Failure::Offline, None);
        assert_eq!(away.title, OFFLINE_TITLE);
        assert_eq!(away.description, OFFLINE_NEXT_STEP);
        let unknown = user_error_message(Failure::Rpc(&unknown), None);
        assert_eq!(unknown.title, NO_CONTEXT_TITLE);
        assert_eq!(
            could_not_title(Some(UserErrorContext {
                action: "stop",
                object: ""
            })),
            "Couldn't stop"
        );
        let canceled = RpcError::new("x", "aborted", "The operation was aborted.");
        assert!(toast_user_error(Failure::Rpc(&canceled), SHOW, "id").is_none());
        let keyring = RpcError::new("x", "y", "Protected desktop persistence is unavailable.");
        assert_eq!(
            user_error_message(Failure::Rpc(&keyring), Some(SHOW)).description,
            SECURE_STORAGE_REASON
        );
    }

    #[test]
    fn the_backend_error_toast_is_quiet_while_reconnecting_and_opens_health_when_unknown() {
        let away = RpcError::not_connected("screens.clear");
        assert!(backend_error_toast(&away, false, SHOW).is_none());
        let offline = shown(backend_error_toast(&away, true, SHOW).unwrap());
        assert_eq!(offline.id.as_deref(), Some(OFFLINE_TOAST_ID));
        assert_eq!(offline.kind, NoticeKind::Warning);

        let unknown = RpcError::new("screens.activate", "x", "boom");
        let toast = shown(backend_error_toast(&unknown, true, SHOW).unwrap());
        assert_eq!(toast.kind, NoticeKind::Error);
        assert_eq!(toast.title, "Couldn't show the takeover");
        assert_eq!(
            toast.action.as_ref().map(|button| button.action.clone()),
            Some(NoticeAction::OpenHealth)
        );
    }
}
