//! Update feed routes.
//!
//! videorc-web answers `/api/updates/*` with a redirect to the primary
//! release storage origin and `/api/updates/mirror/*` with a redirect to the
//! second one. Court-ordered IP blocks (Spain, matchday evenings) intercept
//! whole storage providers, so when the primary route fails in transport the
//! updater retries once on the mirror. The update file is resolved against
//! the feed's base, which is why the mirror is a path and not a query string.

/// Electron's feed. The GPUI app reads a second feed of the same shape
/// ([`crate::second_feed`], P5-D6); its mirror is under it in the same way.
pub const PRIMARY_UPDATE_FEED_URL: &str = "https://www.videorc.com/api/updates/";
pub const MIRROR_UPDATE_FEED_URL: &str = "https://www.videorc.com/api/updates/mirror/";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedRoute {
    Primary,
    Mirror,
}

/// The base a feed file is fetched from on a route.
pub fn feed_url(route: FeedRoute) -> &'static str {
    match route {
        FeedRoute::Primary => PRIMARY_UPDATE_FEED_URL,
        FeedRoute::Mirror => MIRROR_UPDATE_FEED_URL,
    }
}

/// What went wrong with a check or a download.
///
/// Electron tells these apart by the words in `electron-updater`'s message.
/// The Rust updater makes the requests itself, so it knows which it was.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateFailure {
    /// The connection: a name that does not resolve, a refusal, a reset, a
    /// timeout, a certificate the system does not trust.
    Transport,
    /// The storage origin answered the redirected request with this status.
    Status(u16),
    /// No update-info file is published for this build: a 404 on the feed
    /// file itself.
    MissingFeed,
    /// The update-info file could not be read.
    Feed,
    /// The bytes are not what the feed says: their size or their SHA-512.
    Integrity,
    /// The new app is not signed as this one is.
    Signature,
    /// The streamer cancelled.
    Cancelled,
    /// The disk: no space left, no permission.
    Disk,
    /// Anything else.
    Other,
}

/// Whether a failure is about the road and not about the update.
///
/// A second origin serves the same signed bytes, so retrying a failure of
/// the update itself elsewhere is never the answer, and an integrity failure
/// must stay loud. The storage origin refusing or failing the redirected
/// request (an expired presign or an outage: 403 or 5xx) is the road. A 404
/// is a missing object, not a blocked path.
pub fn is_update_transport_failure(failure: UpdateFailure) -> bool {
    match failure {
        UpdateFailure::Transport => true,
        UpdateFailure::Status(status) => status == 403 || (500..=599).contains(&status),
        UpdateFailure::MissingFeed
        | UpdateFailure::Feed
        | UpdateFailure::Integrity
        | UpdateFailure::Signature
        | UpdateFailure::Cancelled
        | UpdateFailure::Disk
        | UpdateFailure::Other => false,
    }
}

/// Whether a failed check or download is tried again on the mirror.
///
/// The pilot feed carries an operator bearer that must stay on the branded
/// proxy, and a failure on the mirror has nowhere further to go.
pub fn should_retry_update_on_mirror(
    failure: UpdateFailure,
    pilot: bool,
    route: FeedRoute,
) -> bool {
    !pilot && route == FeedRoute::Primary && is_update_transport_failure(failure)
}

#[cfg(test)]
mod tests {
    use super::*;

    // update feed routes

    #[test]
    fn keeps_the_mirror_under_the_primary_route() {
        assert_eq!(
            MIRROR_UPDATE_FEED_URL,
            format!("{PRIMARY_UPDATE_FEED_URL}mirror/")
        );
        assert_eq!(feed_url(FeedRoute::Primary), PRIMARY_UPDATE_FEED_URL);
        assert_eq!(feed_url(FeedRoute::Mirror), MIRROR_UPDATE_FEED_URL);
    }

    // isUpdateTransportFailure

    #[test]
    fn retries_a_failure_of_the_road() {
        // A certificate, a reset, a timeout, a name that does not resolve.
        assert!(is_update_transport_failure(UpdateFailure::Transport));
        // "HttpError: 403 Forbidden" and "status code 503".
        assert!(is_update_transport_failure(UpdateFailure::Status(403)));
        assert!(is_update_transport_failure(UpdateFailure::Status(503)));
        assert!(is_update_transport_failure(UpdateFailure::Status(500)));
        assert!(is_update_transport_failure(UpdateFailure::Status(599)));
    }

    #[test]
    fn does_not_retry_a_failure_of_the_update_itself() {
        for failure in [
            // "Cannot find channel latest-mac.yml": no feed for this build.
            UpdateFailure::MissingFeed,
            UpdateFailure::Feed,
            // "sha512 checksum mismatch".
            UpdateFailure::Integrity,
            // "not signed by the application owner".
            UpdateFailure::Signature,
            // "HttpError: 404 Not Found": a missing object.
            UpdateFailure::Status(404),
            UpdateFailure::Status(401),
            UpdateFailure::Status(600),
            // "ENOSPC: no space left on device".
            UpdateFailure::Disk,
            UpdateFailure::Cancelled,
            UpdateFailure::Other,
        ] {
            assert!(!is_update_transport_failure(failure), "{failure:?}");
        }
    }

    // shouldRetryUpdateOnMirror

    #[test]
    fn retries_a_primary_transport_failure_exactly_once() {
        assert!(should_retry_update_on_mirror(
            UpdateFailure::Transport,
            false,
            FeedRoute::Primary
        ));
        assert!(!should_retry_update_on_mirror(
            UpdateFailure::Transport,
            false,
            FeedRoute::Mirror
        ));
    }

    #[test]
    fn never_moves_the_pilot_bearer_off_the_branded_proxy() {
        assert!(!should_retry_update_on_mirror(
            UpdateFailure::Transport,
            true,
            FeedRoute::Primary
        ));
    }

    #[test]
    fn never_retries_an_integrity_failure() {
        assert!(!should_retry_update_on_mirror(
            UpdateFailure::Integrity,
            false,
            FeedRoute::Primary
        ));
    }
}
