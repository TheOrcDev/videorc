//! The GPUI app's own feed (plan 220 P5-D6, plan 260 S5.2).
//!
//! The GPUI app never reads Electron's feed. It reads a second feed of the
//! same shape ([`crate::feed`]'s files, the same storage origins, the same
//! mirror route), which only the bridge build and the GPUI app read. Without
//! it an old Electron build would update straight to the GPUI app and lose
//! what only Electron can read.
//!
//! The web's routes for it are S5.2d's (`videorc-web`, merged by the
//! owner). Until they exist, videorc.com answers both addresses below with
//! a 404, which the flow reads as "no update is published for this build"
//! ([`crate::mirror::UpdateFailure::MissingFeed`]): a quiet "this build
//! doesn't update itself", never an error, and nothing is downloaded.
//!
//! A rehearsal points a build at a feed on this computer with
//! [`UPDATE_FEED_URL_ENV`]. Only a loopback address is taken, so no build
//! can be pointed at another server.

use crate::mirror::FeedRoute;

/// The GPUI app's feed: `/api/updates/` with the app's own folder.
pub const GPUI_UPDATE_FEED_URL: &str = "https://www.videorc.com/api/updates/gpui/";
/// Its mirror route, under the mirror as today's feed is.
pub const GPUI_MIRROR_UPDATE_FEED_URL: &str = "https://www.videorc.com/api/updates/mirror/gpui/";
/// A feed on this computer, for a rehearsal: `http://127.0.0.1:<port>/…`.
pub const UPDATE_FEED_URL_ENV: &str = "VIDEORC_UPDATE_FEED_URL";

/// The two routes a check may take.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedBases {
    primary: String,
    mirror: String,
    local: bool,
}

impl FeedBases {
    /// The GPUI app's feed on videorc.com.
    pub fn gpui() -> Self {
        Self {
            primary: GPUI_UPDATE_FEED_URL.to_string(),
            mirror: GPUI_MIRROR_UPDATE_FEED_URL.to_string(),
            local: false,
        }
    }

    /// A feed on this computer. `None` for anything but an `http` or
    /// `https` address on a loopback host, with no user name in it. A local
    /// feed has no mirror: both routes are the same address.
    pub fn local(raw: &str) -> Option<Self> {
        let raw = raw.trim();
        let rest = raw
            .strip_prefix("http://")
            .or_else(|| raw.strip_prefix("https://"))?;
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        if authority.contains('@') {
            return None;
        }
        let host = if let Some(bracketed) = authority.strip_prefix('[') {
            bracketed.split(']').next().unwrap_or_default()
        } else {
            authority.split(':').next().unwrap_or_default()
        };
        if !matches!(
            host.to_ascii_lowercase().as_str(),
            "127.0.0.1" | "localhost" | "::1"
        ) {
            return None;
        }
        if raw.contains(['?', '#']) {
            return None;
        }
        let base = if raw.ends_with('/') {
            raw.to_string()
        } else {
            format!("{raw}/")
        };
        Some(Self {
            primary: base.clone(),
            mirror: base,
            local: true,
        })
    }

    /// The base a feed file is fetched from on a route.
    pub fn base(&self, route: FeedRoute) -> &str {
        match route {
            FeedRoute::Primary => &self.primary,
            FeedRoute::Mirror => &self.mirror,
        }
    }

    /// Whether this is a rehearsal's feed on this computer.
    pub fn is_local(&self) -> bool {
        self.local
    }
}

/// The feed a build reads: a loopback override when one is set (the value
/// of [`UPDATE_FEED_URL_ENV`]), else the GPUI app's feed. An override that
/// is not a loopback address is ignored, and the second value says so, for
/// the log.
pub fn feed_bases(override_url: Option<&str>) -> (FeedBases, bool) {
    match override_url.map(str::trim).filter(|raw| !raw.is_empty()) {
        None => (FeedBases::gpui(), false),
        Some(raw) => match FeedBases::local(raw) {
            Some(local) => (local, false),
            None => (FeedBases::gpui(), true),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mirror::{MIRROR_UPDATE_FEED_URL, PRIMARY_UPDATE_FEED_URL};

    #[test]
    fn the_gpui_feed_is_not_electrons() {
        let bases = FeedBases::gpui();
        assert_ne!(bases.base(FeedRoute::Primary), PRIMARY_UPDATE_FEED_URL);
        assert_ne!(bases.base(FeedRoute::Mirror), MIRROR_UPDATE_FEED_URL);
        assert!(
            bases
                .base(FeedRoute::Primary)
                .starts_with(PRIMARY_UPDATE_FEED_URL)
        );
        assert!(
            bases
                .base(FeedRoute::Mirror)
                .starts_with(MIRROR_UPDATE_FEED_URL)
        );
        assert!(!bases.is_local());
    }

    #[test]
    fn a_local_feed_takes_only_loopback_addresses() {
        for raw in [
            "http://127.0.0.1:8123/feed",
            "http://localhost:8123/feed/",
            "https://[::1]:8443/",
            "http://LOCALHOST/feed",
        ] {
            let bases = FeedBases::local(raw).unwrap_or_else(|| panic!("{raw}"));
            assert!(bases.is_local());
            assert!(bases.base(FeedRoute::Primary).ends_with('/'));
            assert_eq!(
                bases.base(FeedRoute::Primary),
                bases.base(FeedRoute::Mirror)
            );
        }
        for raw in [
            "https://www.videorc.com/api/updates/",
            "http://127.0.0.1.example.com/feed",
            "http://user@127.0.0.1/feed",
            "http://evil.example@localhost/",
            "file:///tmp/feed",
            "ftp://127.0.0.1/feed",
            "http://127.0.0.1/feed?x=1",
            "http://localhost.evil.example/",
            "",
        ] {
            assert_eq!(FeedBases::local(raw), None, "{raw}");
        }
    }

    #[test]
    fn an_override_that_is_not_local_is_ignored_and_said() {
        assert_eq!(feed_bases(None), (FeedBases::gpui(), false));
        assert_eq!(feed_bases(Some("  ")), (FeedBases::gpui(), false));
        assert_eq!(
            feed_bases(Some("https://example.com/feed/")),
            (FeedBases::gpui(), true)
        );
        let (local, ignored) = feed_bases(Some("http://127.0.0.1:9000/feed"));
        assert!(local.is_local() && !ignored);
        assert_eq!(
            local.base(FeedRoute::Primary),
            "http://127.0.0.1:9000/feed/"
        );
    }
}
