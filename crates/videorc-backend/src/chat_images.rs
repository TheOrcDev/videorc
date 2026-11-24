//! Chat avatars, emotes and Twitch GIFs, fetched, cached and served by the
//! backend (plan 260 S1.5a, ported from plan 260 S1.5a in `videorc-rust`;
//! Electron main's `avatar-cache.ts` until then).
//!
//! No window ever hot-links a platform CDN. `chatImages.cache` takes the
//! remote URL a chat message carries, refuses anything off the allowlist,
//! fetches it once into `<data dir>/avatar-cache` and answers with this run's
//! loopback URL for the file,
//! `http://127.0.0.1:<port>/chat-images/<file>?key=<key>`, which a window's
//! `<img>` loads. The route only serves files already in the cache and never
//! fetches, so no local process can use it as a fetcher; the per-run key
//! (never the renderer's credential) keeps other local processes from reading
//! the cache through it.
//!
//! A fetch is refused, never attempted, unless the URL is `https` on the
//! default port, without credentials, at most 2,048 characters, on a host of
//! its kind's allowlist; a redirect is followed (three at most) only to a URL
//! that passes the same rule, with one exception (owner, 2026-11-09): the
//! web's account avatar route on videorc.com may send its first hop to a
//! presigned Neon Object Storage URL; names resolve only to public addresses (no
//! loopback, private, link-local or other special-use address) and no proxy is
//! used, so the address checked is the address connected to. The body is
//! capped (2 MB for avatars and emotes, 8 MB for GIFs) while it streams, must
//! be a PNG, JPEG, GIF, WebP or AVIF by its magic bytes (a GIF must be a GIF,
//! WebP or PNG), and the whole fetch has a deadline (4 s, the highlight relay's
//! avatar slice; 15 s for GIFs). Each refusal is logged once per host and
//! reason, never with the URL's path or query (CDN paths can carry tokens).
//!
//! The directory and the file names are the ones Electron main used
//! (`<32 hex of sha256(url)>.<extension from the URL path>`), and the data
//! dir is Electron's userData folder on macOS and Windows, so an existing
//! cache carries over as it is.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use reqwest::Url;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::state::AppState;

/// Hosts chat avatars and emotes may come from: the platforms' own CDNs and
/// Videorc's account avatar stores. The same list as Electron main's
/// `AVATAR_ALLOWED_HOST_SUFFIXES`; a host matches itself and its subdomains.
pub(crate) const AVATAR_ALLOWED_HOST_SUFFIXES: &[&str] = &[
    // YouTube channel avatars.
    "yt3.ggpht.com",
    "yt4.ggpht.com",
    "googleusercontent.com",
    // Twitch profile images and chat emotes (plan 055 S10).
    "static-cdn.jtvnw.net",
    // X profile images and X's default avatars (plan 095).
    "pbs.twimg.com",
    "abs.twimg.com",
    // Kick profile pictures (plan 063) and emotes (plan 085).
    "files.kick.com",
    "kick.com",
    // 7TV emotes (plan 089): the backend builds every URL itself.
    "cdn.7tv.app",
    // Videorc account avatars on Vercel Blob storage.
    "blob.vercel-storage.com",
    // Videorc account avatars served by the web's /api/account/avatar route.
    // That route answers with a 302 to a presigned Neon Object Storage URL,
    // which is not on this list: only that one redirect may follow it
    // (`account_avatar_neon_redirect`, owner 2026-11-09).
    "videorc.com",
];

/// The origins the web issues its account avatar route on (`siteConfig.url`
/// and the bare domain, `accountAvatarAppOrigins` in videorcweb
/// `lib/account/avatar.ts`).
const ACCOUNT_AVATAR_ROUTE_HOSTS: &[&str] = &["videorc.com", "www.videorc.com"];
/// `ACCOUNT_AVATAR_ROUTE_PREFIX` in videorcweb `lib/account/avatar.ts`.
const ACCOUNT_AVATAR_ROUTE_PREFIX: &str = "/api/account/avatar/";

/// A Twitch GIF Keyboard asset (plan 155) passes only the GIF rule: GIPHY's
/// media CDNs and Twitch's own, the list `twitch_chat.rs` gates the fragment
/// with. An avatar never comes from GIPHY.
pub(crate) const GIF_ALLOWED_HOST_SUFFIXES: &[&str] = crate::twitch_chat::TWITCH_GIF_ASSET_HOSTS;

/// Longer than this is not an image URL (the chat-link bound).
pub(crate) const MAX_IMAGE_URL_CHARS: usize = 2_048;
/// The web's account-avatar upload cap; the highlight card reads no more.
pub(crate) const AVATAR_MAX_BYTES: usize = 2 * 1024 * 1024;
/// A GIPHY rendition can run to several MB.
pub(crate) const GIF_MAX_BYTES: usize = 8 * 1024 * 1024;
/// The highlight relay's avatar slice (`COMMENTS_HIGHLIGHT_TIMING_CONTRACT.avatarFetchMs`).
pub(crate) const AVATAR_FETCH_TIMEOUT: Duration = Duration::from_secs(4);
/// GIFs never ride the highlight relay; a 5 MB file over a slow link needs longer.
pub(crate) const GIF_FETCH_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const MAX_REDIRECTS: usize = 3;
/// Emotes share the cache with avatars; 7TV chats are emote-dense (plan 089).
pub(crate) const CACHE_MAX_FILES: usize = 1_000;
/// A thousand multi-megabyte GIFs is not nothing (plan 155).
pub(crate) const CACHE_MAX_BYTES: u64 = 256 * 1024 * 1024;
/// A chat flooding new emotes prunes at most this often, with one trailing pass.
pub(crate) const PRUNE_MIN_INTERVAL: Duration = Duration::from_secs(5);
/// The folder beside the database (Electron's userData folder in production).
pub(crate) const CACHE_DIR_NAME: &str = "avatar-cache";
pub(crate) const ROUTE_PREFIX: &str = "/chat-images/";
/// Dev-only: fetch every allowlisted `https://<host>/<path>` from
/// `<origin>/<host>/<path>` instead, for the smokes' local fake image host.
/// Only a bare `http://127.0.0.1:<port>` origin is accepted, and packaged
/// (release) builds refuse it: a stray variable can never point the cache
/// anywhere else. The allowlist still judges the original URL.
pub(crate) const FAKE_ORIGIN_ENV: &str = "VIDEORC_CHAT_IMAGE_FAKE_ORIGIN";

const IMAGE_ACCEPT: &str = "image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5";
const CACHE_EXTENSIONS: &[&str] = &[".png", ".jpg", ".jpeg", ".webp", ".gif"];

/// Which rule a remote URL is judged by: avatars and emotes share one; Twitch
/// GIFs have their own hosts, cap, deadline and formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ChatImageKind {
    #[default]
    Avatar,
    Gif,
}

impl ChatImageKind {
    fn subject(self) -> &'static str {
        match self {
            Self::Avatar => "Chat avatar",
            Self::Gif => "Chat GIF",
        }
    }

    fn allowed_host_suffixes(self) -> &'static [&'static str] {
        match self {
            Self::Avatar => AVATAR_ALLOWED_HOST_SUFFIXES,
            Self::Gif => GIF_ALLOWED_HOST_SUFFIXES,
        }
    }

    fn max_bytes(self) -> usize {
        match self {
            Self::Avatar => AVATAR_MAX_BYTES,
            Self::Gif => GIF_MAX_BYTES,
        }
    }

    fn timeout(self) -> Duration {
        match self {
            Self::Avatar => AVATAR_FETCH_TIMEOUT,
            Self::Gif => GIF_FETCH_TIMEOUT,
        }
    }

    /// MP4 and SVG are never cached: an `<img>` cannot play the one, and the
    /// other is a document.
    fn accepts(self, format: ImageFormat) -> bool {
        match self {
            Self::Avatar => true,
            Self::Gif => matches!(
                format,
                ImageFormat::Gif | ImageFormat::Webp | ImageFormat::Png
            ),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChatImageCacheParams {
    pub url: String,
    #[serde(default)]
    pub kind: ChatImageKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ImageFormat {
    Png,
    Jpeg,
    Gif,
    Webp,
    Avif,
}

impl ImageFormat {
    pub(crate) fn content_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
            Self::Avif => "image/avif",
        }
    }
}

/// What an image body is by its magic bytes, or None. Allowlisted hosts as
/// wide as `giphy.com` or `kick.com` also serve HTML; only a raster is kept.
pub(crate) fn sniff_image(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.len() < 12 {
        return None;
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(ImageFormat::Gif);
    }
    if &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(ImageFormat::Webp);
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some(ImageFormat::Png);
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some(ImageFormat::Jpeg);
    }
    if &bytes[4..8] == b"ftyp" && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis") {
        return Some(ImageFormat::Avif);
    }
    None
}

/// Why an image was not cached. Carries only what support needs (host,
/// scheme, size, status class), never the path or query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Rejection {
    NotAUrl,
    TooLong,
    Scheme {
        scheme: String,
        host: String,
    },
    Credentials {
        host: String,
    },
    Port {
        host: String,
    },
    Host {
        host: String,
    },
    Redirect {
        host: String,
        target: String,
    },
    TooManyRedirects {
        host: String,
    },
    PrivateNetwork {
        host: String,
    },
    HttpStatus {
        host: String,
        status_class: String,
    },
    EmptyBody {
        host: String,
    },
    TooLarge {
        host: String,
        bytes: u64,
        cap: usize,
    },
    NotAnImage {
        host: String,
    },
    FetchError {
        host: String,
        message: String,
    },
}

impl Rejection {
    /// One log line per distinct (host, reason), so a busy chat from one
    /// blocked CDN does not flood the log ring.
    pub(crate) fn key(&self) -> String {
        match self {
            Self::NotAUrl => "not-a-url".to_string(),
            Self::TooLong => "too-long".to_string(),
            Self::Scheme { scheme, host } => format!("scheme:{scheme}:{host}"),
            Self::Credentials { host } => format!("credentials:{host}"),
            Self::Port { host } => format!("port:{host}"),
            Self::Host { host } => format!("host:{host}"),
            Self::Redirect { host, target } => format!("redirect:{host}:{target}"),
            Self::TooManyRedirects { host } => format!("too-many-redirects:{host}"),
            Self::PrivateNetwork { host } => format!("private-network:{host}"),
            Self::HttpStatus { host, status_class } => format!("http-status:{host}:{status_class}"),
            Self::EmptyBody { host } => format!("empty-body:{host}"),
            Self::TooLarge { host, .. } => format!("too-large:{host}"),
            Self::NotAnImage { host } => format!("not-an-image:{host}"),
            Self::FetchError { host, .. } => format!("fetch-error:{host}"),
        }
    }

    pub(crate) fn message(&self, kind: ChatImageKind) -> String {
        let prefix = format!("{} not cached:", kind.subject());
        match self {
            Self::NotAUrl => format!("{prefix} value is not a URL."),
            Self::TooLong => {
                format!("{prefix} the URL is longer than {MAX_IMAGE_URL_CHARS} characters.")
            }
            Self::Scheme { scheme, host } => {
                format!("{prefix} scheme {scheme} is not https (host {host}).")
            }
            Self::Credentials { host } => {
                format!("{prefix} the URL for {host} carries a user name or password.")
            }
            Self::Port { host } => format!("{prefix} the URL for {host} names a port."),
            Self::Host { host } => match kind {
                ChatImageKind::Avatar => {
                    format!("{prefix} host {host} is not an allowlisted avatar CDN.")
                }
                ChatImageKind::Gif => {
                    format!("{prefix} host {host} is not an allowlisted GIF host.")
                }
            },
            Self::Redirect { host, target } => format!(
                "{prefix} {host} redirected to {target}, which is not an allowlisted https host."
            ),
            Self::TooManyRedirects { host } => {
                format!("{prefix} {host} redirected more than {MAX_REDIRECTS} times.")
            }
            Self::PrivateNetwork { host } => {
                format!("{prefix} {host} resolves only to private-network addresses.")
            }
            Self::HttpStatus { host, status_class } => {
                format!("{prefix} {host} answered {status_class}.")
            }
            Self::EmptyBody { host } => format!("{prefix} {host} returned an empty body."),
            Self::TooLarge { host, bytes, cap } => {
                format!("{prefix} {host} returned {bytes} bytes (cap {cap}).")
            }
            Self::NotAnImage { host } => match kind {
                ChatImageKind::Avatar => format!(
                    "{prefix} {host} returned a body that is not a PNG, JPEG, GIF, WebP or AVIF."
                ),
                ChatImageKind::Gif => {
                    format!("{prefix} {host} returned a body that is not a GIF, WebP or PNG.")
                }
            },
            Self::FetchError { host, message } => {
                format!("{prefix} fetching from {host} failed ({message}).")
            }
        }
    }
}

/// The allowlist rule: the parsed URL and its host, or why it is refused.
/// Pure; every redirect hop is judged by it too.
pub(crate) fn url_decision(kind: ChatImageKind, raw: &str) -> Result<(Url, String), Rejection> {
    if raw.chars().count() > MAX_IMAGE_URL_CHARS {
        return Err(Rejection::TooLong);
    }
    let url = Url::parse(raw).map_err(|_| Rejection::NotAUrl)?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if url.scheme() != "https" {
        return Err(Rejection::Scheme {
            scheme: url.scheme().to_string(),
            host,
        });
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Rejection::Credentials { host });
    }
    if url.port().is_some() {
        return Err(Rejection::Port { host });
    }
    if !host_allowed(kind, &host) {
        return Err(Rejection::Host { host });
    }
    Ok((url, host))
}

/// The web's account avatar route exactly as it stores it in `user.image`:
/// `https://(www.)videorc.com/api/account/avatar/<userId>/<file>`, no port,
/// query or fragment, the segments its route accepts (`<file>` a `.jpg`,
/// `.png` or `.webp`). Pure.
pub(crate) fn is_account_avatar_route(url: &Url) -> bool {
    let segment = |value: &str, max: usize| {
        !value.is_empty()
            && value.len() <= max
            && value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'=' | b'-')
            })
    };
    let Some(rest) = url.path().strip_prefix(ACCOUNT_AVATAR_ROUTE_PREFIX) else {
        return false;
    };
    let mut parts = rest.split('/');
    let (Some(user), Some(file), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let Some((stem, extension)) = file.rsplit_once('.') else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url
            .host_str()
            .is_some_and(|host| ACCOUNT_AVATAR_ROUTE_HOSTS.contains(&host))
        && segment(user, 128)
        && !user.bytes().all(|byte| byte == b'.')
        && segment(stem, 123)
        && matches!(extension, "jpg" | "png" | "webp")
}

/// A Neon Object Storage branch endpoint, the host the account avatar route
/// presigns its GETs on: `br-<id>.storage.c-<N>.<region>.aws.neon.tech`
/// (path-style, so the bucket is in the path). Pure.
pub(crate) fn is_neon_storage_host(host: &str) -> bool {
    let labels = host.split('.').collect::<Vec<_>>();
    let [branch, "storage", cell, region, "aws", "neon", "tech"] = labels.as_slice() else {
        return false;
    };
    let lowercase_label = |label: &str| {
        !label.is_empty()
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    };
    let region_parts = region.split('-').collect::<Vec<_>>();
    branch.strip_prefix("br-").is_some_and(lowercase_label)
        && cell.strip_prefix("c-").is_some_and(|number| {
            !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
        })
        && region_parts.len() >= 3
        && region_parts[0].len() == 2
        && region_parts[..region_parts.len() - 1]
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_lowercase()))
        && region_parts[region_parts.len() - 1]
            .bytes()
            .all(|byte| byte.is_ascii_digit())
        && !region_parts[region_parts.len() - 1].is_empty()
}

/// The one redirect that may leave the allowlist (owner, 2026-11-09): an
/// avatar fetch that started at the web's account avatar route, on its first
/// hop, to a presigned Neon storage URL that is itself https, without
/// credentials or a port, and within the URL bound. Never a direct fetch,
/// never from any other host or hop. The URL and its host, or None.
pub(crate) fn account_avatar_neon_redirect(
    kind: ChatImageKind,
    from: &Url,
    redirects: usize,
    next: &Url,
) -> Option<(Url, String)> {
    let host = next.host_str()?.to_ascii_lowercase();
    (kind == ChatImageKind::Avatar
        && redirects == 0
        && is_account_avatar_route(from)
        && next.scheme() == "https"
        && next.username().is_empty()
        && next.password().is_none()
        && next.port().is_none()
        && next.as_str().chars().count() <= MAX_IMAGE_URL_CHARS
        && is_neon_storage_host(&host))
    .then(|| (next.clone(), host))
}

fn host_allowed(kind: ChatImageKind, host: &str) -> bool {
    !host.is_empty()
        && kind
            .allowed_host_suffixes()
            .iter()
            .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

/// Content-addressed by the URL so the same image is fetched once; the
/// extension comes from the URL path, never from remote headers. The same
/// name Electron main gave the file.
pub(crate) fn cache_file_name(raw: &str) -> String {
    let digest = Sha256::digest(raw.as_bytes());
    let hash = digest
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let path = Url::parse(raw)
        .map(|url| url.path().to_ascii_lowercase())
        .unwrap_or_default();
    let extension = CACHE_EXTENSIONS
        .iter()
        .find(|extension| path.ends_with(*extension))
        .copied()
        .unwrap_or(".img");
    format!("{hash}{extension}")
}

/// A name the route will serve: exactly what `cache_file_name` makes.
pub(crate) fn is_cache_file_name(name: &str) -> bool {
    let Some((hash, extension)) = name.split_once('.') else {
        return false;
    };
    hash.len() == 32
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && matches!(extension, "png" | "jpg" | "jpeg" | "webp" | "gif" | "img")
}

/// `2xx` / `4xx` / `5xx`: enough to tell auth from outage.
fn status_class(status: u16) -> String {
    if !(100..=999).contains(&status) {
        return "unknown".to_string();
    }
    format!("{}xx", status / 100)
}

/// Fetch errors occasionally quote the request URL; drop anything URL-shaped
/// so the log line never carries a token-bearing path.
fn redact_fetch_error(message: &str) -> String {
    let redacted = message
        .split_whitespace()
        .map(|word| if word.contains("://") { "<url>" } else { word })
        .collect::<Vec<_>>()
        .join(" ");
    redacted.chars().take(160).collect()
}

// --- Public-only name resolution ---------------------------------------------------------

/// Whether a resolved address is on the public internet. Loopback, private,
/// link-local, shared (CGNAT), documentation, benchmarking, multicast,
/// reserved and unspecified addresses are not, nor IPv6 addresses that embed
/// one of them (mapped, 6to4, NAT64) or tunnel to anywhere (Teredo).
pub(crate) fn is_public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 168)
        || (a == 198 && (18..=19).contains(&b))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

fn is_public_v6(address: Ipv6Addr) -> bool {
    if let Some(v4) = address.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let segments = address.segments();
    let embedded_v4 = |high: u16, low: u16| {
        Ipv4Addr::new((high >> 8) as u8, high as u8, (low >> 8) as u8, low as u8)
    };
    if address.is_unspecified() || address.is_loopback() || address.is_multicast() {
        return false;
    }
    match segments[0] {
        // IPv4-compatible (deprecated), discard-only and other ::/8 forms.
        0x0000 | 0x0100 => false,
        // NAT64 well-known prefix: judge the IPv4 it carries.
        0x0064 if segments[1] == 0xff9b => is_public_v4(embedded_v4(segments[6], segments[7])),
        // Teredo (2001::/32) tunnels anywhere; documentation is 2001:db8::/32.
        0x2001 if segments[1] == 0x0000 || segments[1] == 0x0db8 => false,
        // 6to4: judge the IPv4 it carries.
        0x2002 => is_public_v4(embedded_v4(segments[1], segments[2])),
        // Unique local (fc00::/7), link-local (fe80::/10), site-local (fec0::/10).
        first if (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80 => false,
        first if (first & 0xffc0) == 0xfec0 => false,
        _ => true,
    }
}

/// The resolved addresses a fetch may connect to: the public ones only.
pub(crate) fn public_addresses(addresses: Vec<SocketAddr>) -> Vec<SocketAddr> {
    addresses
        .into_iter()
        .filter(|address| is_public_address(address.ip()))
        .collect()
}

/// The error a name that resolves only to non-public addresses fails with.
#[derive(Debug)]
pub(crate) struct PrivateNetworkRefusal;

impl std::fmt::Display for PrivateNetworkRefusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("the name resolves only to private-network addresses")
    }
}

impl std::error::Error for PrivateNetworkRefusal {}

type LookupFuture = Pin<Box<dyn Future<Output = io::Result<Vec<SocketAddr>>> + Send>>;
type Lookup = Arc<dyn Fn(String) -> LookupFuture + Send + Sync>;

/// reqwest's resolver for chat image fetches: the system resolver, then only
/// public addresses. hyper connects to exactly what this returns, so a name
/// cannot pass the check and then connect somewhere private.
#[derive(Clone)]
pub(crate) struct PublicOnlyResolver {
    lookup: Lookup,
}

impl PublicOnlyResolver {
    pub(crate) fn system() -> Self {
        Self {
            lookup: Arc::new(|name: String| -> LookupFuture {
                Box::pin(async move {
                    Ok(tokio::net::lookup_host((name.as_str(), 0))
                        .await?
                        .collect::<Vec<_>>())
                })
            }),
        }
    }

    #[cfg(test)]
    fn with_lookup(lookup: Lookup) -> Self {
        Self { lookup }
    }
}

impl reqwest::dns::Resolve for PublicOnlyResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let lookup = self.lookup.clone();
        let name = name.as_str().to_string();
        Box::pin(async move {
            let resolved = lookup(name)
                .await
                .map_err(|error| Box::new(error) as Box<dyn std::error::Error + Send + Sync>)?;
            let public = public_addresses(resolved);
            if public.is_empty() {
                return Err(
                    Box::new(PrivateNetworkRefusal) as Box<dyn std::error::Error + Send + Sync>
                );
            }
            Ok(Box::new(public.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

// --- The fetcher ---------------------------------------------------------------------------

/// The HTTP side of the cache: no redirects followed by the client (each hop
/// is judged here), no proxy, the public-only resolver, https only.
pub(crate) struct ChatImageFetcher {
    client: reqwest::Client,
    /// Dev builds and tests: the fake image host every request goes to.
    fake_origin: Option<Url>,
    /// Tests: one deadline for every kind.
    deadline_override: Option<Duration>,
}

impl ChatImageFetcher {
    pub(crate) fn new(
        resolver: PublicOnlyResolver,
        fake_origin: Option<Url>,
    ) -> reqwest::Result<Self> {
        let builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .dns_resolver(Arc::new(resolver))
            .user_agent(crate::performance_check::desktop_user_agent())
            .connect_timeout(AVATAR_FETCH_TIMEOUT);
        let builder = if fake_origin.is_some() {
            builder
        } else {
            builder.https_only(true)
        };
        Ok(Self {
            client: builder.build()?,
            fake_origin,
            deadline_override: None,
        })
    }

    #[cfg(test)]
    pub(crate) fn with_deadline(mut self, deadline: Duration) -> Self {
        self.deadline_override = Some(deadline);
        self
    }

    /// The URL a request for `url` is sent to: itself, or the fake host's
    /// `<origin>/<host><path>?<query>`.
    fn transport_url(&self, url: &Url) -> Url {
        let Some(origin) = &self.fake_origin else {
            return url.clone();
        };
        let mut transport = origin.clone();
        transport.set_path(&format!(
            "/{}{}",
            url.host_str().unwrap_or_default(),
            url.path()
        ));
        transport.set_query(url.query());
        transport
    }

    fn timeout(&self, kind: ChatImageKind) -> Duration {
        self.deadline_override.unwrap_or_else(|| kind.timeout())
    }

    /// Fetch one allowlisted image within its kind's deadline: the bytes and
    /// what they are, or why not.
    pub(crate) async fn fetch(
        &self,
        kind: ChatImageKind,
        url: Url,
        host: String,
    ) -> Result<(Vec<u8>, ImageFormat), Rejection> {
        let deadline = self.timeout(kind);
        match tokio::time::timeout(deadline, self.fetch_hops(kind, url, host.clone())).await {
            Ok(result) => result,
            Err(_) => Err(Rejection::FetchError {
                host,
                message: format!(
                    "{} fetch exceeded its {}ms deadline.",
                    kind.subject(),
                    deadline.as_millis()
                ),
            }),
        }
    }

    async fn fetch_hops(
        &self,
        kind: ChatImageKind,
        url: Url,
        host: String,
    ) -> Result<(Vec<u8>, ImageFormat), Rejection> {
        let mut current = url;
        let mut current_host = host;
        let mut redirects = 0;
        loop {
            let mut response = self
                .client
                .get(self.transport_url(&current))
                .header(header::ACCEPT, IMAGE_ACCEPT)
                .send()
                .await
                .map_err(|error| send_rejection(error, &current_host))?;
            let status = response.status();
            if status.is_redirection() {
                let Some(location) = response
                    .headers()
                    .get(header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                else {
                    return Err(Rejection::HttpStatus {
                        host: current_host,
                        status_class: status_class(status.as_u16()),
                    });
                };
                if redirects >= MAX_REDIRECTS {
                    return Err(Rejection::TooManyRedirects { host: current_host });
                }
                let next = current.join(location).map_err(|_| Rejection::Redirect {
                    host: current_host.clone(),
                    target: "a value that is not a URL".to_string(),
                })?;
                let allowed = url_decision(kind, next.as_str())
                    .ok()
                    .or_else(|| account_avatar_neon_redirect(kind, &current, redirects, &next));
                match allowed {
                    Some((next, next_host)) => {
                        current = next;
                        current_host = next_host;
                        redirects += 1;
                        continue;
                    }
                    None => {
                        let target = match next.host_str().filter(|target| !target.is_empty()) {
                            Some(target) => {
                                format!("{}://{}", next.scheme(), target.to_ascii_lowercase())
                            }
                            None => next.scheme().to_string(),
                        };
                        return Err(Rejection::Redirect {
                            host: current_host,
                            target,
                        });
                    }
                }
            }
            if !status.is_success() {
                return Err(Rejection::HttpStatus {
                    host: current_host,
                    status_class: status_class(status.as_u16()),
                });
            }
            let cap = kind.max_bytes();
            if let Some(length) = response.content_length()
                && length > cap as u64
            {
                return Err(Rejection::TooLarge {
                    host: current_host,
                    bytes: length,
                    cap,
                });
            }
            let mut body = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|error| send_rejection(error, &current_host))?
            {
                if body.len() + chunk.len() > cap {
                    return Err(Rejection::TooLarge {
                        host: current_host,
                        bytes: (body.len() + chunk.len()) as u64,
                        cap,
                    });
                }
                body.extend_from_slice(&chunk);
            }
            if body.is_empty() {
                return Err(Rejection::EmptyBody { host: current_host });
            }
            return match sniff_image(&body) {
                Some(format) if kind.accepts(format) => Ok((body, format)),
                _ => Err(Rejection::NotAnImage { host: current_host }),
            };
        }
    }
}

fn send_rejection(error: reqwest::Error, host: &str) -> Rejection {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(&error);
    while let Some(current) = source {
        if current.is::<PrivateNetworkRefusal>() {
            return Rejection::PrivateNetwork {
                host: host.to_string(),
            };
        }
        source = current.source();
    }
    let error = error.without_url();
    let mut message = error.to_string();
    let mut source = std::error::Error::source(&error);
    while let Some(current) = source {
        message.push_str(": ");
        message.push_str(&current.to_string());
        source = current.source();
    }
    Rejection::FetchError {
        host: host.to_string(),
        message: redact_fetch_error(&message),
    }
}

/// The dev-only fake host a build honours for `VIDEORC_CHAT_IMAGE_FAKE_ORIGIN`.
/// Release builds refuse any value; debug builds accept a bare
/// `http://127.0.0.1:<port>` origin and nothing else. Pure.
pub(crate) fn resolve_fake_origin(
    dev_build: bool,
    value: Option<&str>,
) -> Result<Option<Url>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if !dev_build {
        return Err(format!(
            "{FAKE_ORIGIN_ENV} is refused in packaged builds; chat images come from their CDNs."
        ));
    }
    let url =
        Url::parse(value).map_err(|error| format!("{FAKE_ORIGIN_ENV} is not a URL: {error}"))?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(format!(
            "{FAKE_ORIGIN_ENV} must be a bare loopback origin such as http://127.0.0.1:4321."
        ));
    }
    Ok(Some(url))
}

// --- The cache -----------------------------------------------------------------------------

type CacheFuture = Shared<BoxFuture<'static, Result<String, Rejection>>>;

#[derive(Default)]
struct PruneSchedule {
    last: Option<Instant>,
    pending: bool,
}

/// The process's chat image cache: one directory, one file-name scheme, one
/// prune, one key for the route.
pub(crate) struct ChatImages {
    dir: PathBuf,
    key: String,
    fake_origin: Option<Url>,
    fetcher: OnceLock<Result<Arc<ChatImageFetcher>, String>>,
    in_flight: StdMutex<HashMap<String, CacheFuture>>,
    logged: StdMutex<HashSet<String>>,
    prune: StdMutex<PruneSchedule>,
}

impl ChatImages {
    /// The cache for this run: the folder, a fresh route key, and the
    /// dev-only fake host when this build honours one.
    pub(crate) fn for_run(dir: PathBuf) -> Self {
        let value = std::env::var(FAKE_ORIGIN_ENV).ok();
        let fake_origin = match resolve_fake_origin(cfg!(debug_assertions), value.as_deref()) {
            Ok(Some(origin)) => {
                tracing::warn!(
                    "[chat-images] dev override: every chat image fetch goes to {origin}"
                );
                Some(origin)
            }
            Ok(None) => None,
            Err(why) => {
                tracing::warn!("[chat-images] {why}");
                None
            }
        };
        Self::new(dir, fake_origin)
    }

    pub(crate) fn new(dir: PathBuf, fake_origin: Option<Url>) -> Self {
        Self {
            dir,
            key: uuid::Uuid::new_v4().simple().to_string(),
            fake_origin,
            fetcher: OnceLock::new(),
            in_flight: StdMutex::new(HashMap::new()),
            logged: StdMutex::new(HashSet::new()),
            prune: StdMutex::new(PruneSchedule::default()),
        }
    }

    #[cfg(test)]
    fn with_fetcher(dir: PathBuf, fetcher: ChatImageFetcher) -> Self {
        let images = Self::new(dir, None);
        let _ = images.fetcher.set(Ok(Arc::new(fetcher)));
        images
    }

    fn fetcher(&self) -> Result<Arc<ChatImageFetcher>, String> {
        self.fetcher
            .get_or_init(|| {
                ChatImageFetcher::new(PublicOnlyResolver::system(), self.fake_origin.clone())
                    .map(Arc::new)
                    .map_err(|error| error.to_string())
            })
            .clone()
    }

    /// The route URL of a cached file on this backend.
    pub(crate) fn route_url(&self, port: u16, file_name: &str) -> String {
        format!(
            "http://127.0.0.1:{port}{ROUTE_PREFIX}{file_name}?key={}",
            self.key
        )
    }

    /// The bytes of one cached avatar or emote, from the cache folder only:
    /// never the network (plan 220 S1.2c, the overlays the backend draws).
    /// None for a URL off the avatar allowlist, a file not cached yet, not a
    /// regular file, empty, over the avatar cap, or not an image by its magic
    /// bytes. Blocking: call it off the runtime.
    #[allow(
        dead_code,
        reason = "plan 260: the highlight card and the chat box read it once they switch (after S1.5a)"
    )]
    pub(crate) fn read_cached_avatar(&self, raw: &str) -> Option<Vec<u8>> {
        url_decision(ChatImageKind::Avatar, raw).ok()?;
        let path = self.dir.join(cache_file_name(raw));
        let metadata = std::fs::symlink_metadata(&path).ok()?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > AVATAR_MAX_BYTES as u64 {
            return None;
        }
        let bytes = std::fs::read(&path).ok()?;
        sniff_image(&bytes)?;
        Some(bytes)
    }

    pub(crate) fn key_matches(&self, supplied: &str) -> bool {
        crate::backend_authority::constant_time_equal(supplied.as_bytes(), self.key.as_bytes())
    }

    /// Cache one image: its cache file name once it is on disk, or why not.
    /// One fetch per file at a time; the fetch runs on its own task, so a
    /// caller that goes away never strands it.
    pub(crate) async fn cache(
        self: &Arc<Self>,
        kind: ChatImageKind,
        raw: &str,
    ) -> Result<String, Rejection> {
        let (url, host) = url_decision(kind, raw)?;
        let file_name = cache_file_name(raw);
        if cached_file_ready(&self.dir.join(&file_name)).await {
            return Ok(file_name);
        }
        let shared = {
            let mut in_flight = self
                .in_flight
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(existing) = in_flight.get(&file_name) {
                existing.clone()
            } else {
                let images = self.clone();
                let task_file_name = file_name.clone();
                let fallback_host = host.clone();
                let task = tokio::spawn(async move {
                    let result = images
                        .fetch_and_store(kind, url, host, &task_file_name)
                        .await;
                    images
                        .in_flight
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .remove(&task_file_name);
                    result
                });
                let shared = async move {
                    task.await.unwrap_or_else(|error| {
                        Err(Rejection::FetchError {
                            host: fallback_host,
                            message: redact_fetch_error(&error.to_string()),
                        })
                    })
                }
                .boxed()
                .shared();
                in_flight.insert(file_name.clone(), shared.clone());
                shared
            }
        };
        shared.await
    }

    async fn fetch_and_store(
        self: &Arc<Self>,
        kind: ChatImageKind,
        url: Url,
        host: String,
        file_name: &str,
    ) -> Result<String, Rejection> {
        let fetcher = self.fetcher().map_err(|message| Rejection::FetchError {
            host: host.clone(),
            message: redact_fetch_error(&message),
        })?;
        let (bytes, _format) = fetcher.fetch(kind, url, host.clone()).await?;
        let dir = self.dir.clone();
        let target = dir.join(file_name);
        let staged = dir.join(format!(
            ".{file_name}.{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        let written = tokio::task::spawn_blocking(move || -> io::Result<()> {
            std::fs::create_dir_all(&dir)?;
            std::fs::write(&staged, &bytes)?;
            if let Err(error) = crate::atomic_file::replace_file(&staged, &target) {
                let _ = std::fs::remove_file(&staged);
                return Err(error);
            }
            Ok(())
        })
        .await;
        match written {
            Ok(Ok(())) => {
                self.schedule_prune();
                Ok(file_name.to_string())
            }
            Ok(Err(error)) => Err(Rejection::FetchError {
                host,
                message: format!("the cache file could not be written: {error}"),
            }),
            Err(error) => Err(Rejection::FetchError {
                host,
                message: format!("the cache write did not finish: {error}"),
            }),
        }
    }

    /// Whether this refusal is the first of its kind this run (log it once).
    fn first_rejection(&self, kind: ChatImageKind, rejection: &Rejection) -> bool {
        self.logged
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(format!("{}:{}", kind.subject(), rejection.key()))
    }

    /// At most one prune per `PRUNE_MIN_INTERVAL`, with one trailing pass so
    /// the last burst of new files is still bounded.
    fn schedule_prune(self: &Arc<Self>) {
        let delay = {
            let mut schedule = self
                .prune
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if schedule.pending {
                return;
            }
            schedule.pending = true;
            schedule
                .last
                .map(|last| PRUNE_MIN_INTERVAL.saturating_sub(last.elapsed()))
                .unwrap_or_default()
        };
        let images = self.clone();
        tokio::spawn(async move {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            {
                let mut schedule = images
                    .prune
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                schedule.pending = false;
                schedule.last = Some(Instant::now());
            }
            let dir = images.dir.clone();
            let _ = tokio::task::spawn_blocking(move || prune_directory(&dir)).await;
        });
    }
}

async fn cached_file_ready(path: &Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CacheEntry {
    pub path: PathBuf,
    pub modified: SystemTime,
    pub bytes: u64,
}

/// Which cache files to remove so the folder fits both limits: the newest
/// are kept, and files go oldest-first once either the count or the bytes
/// would pass its cap. Pure.
pub(crate) fn prune_plan(entries: &[CacheEntry], max_files: usize, max_bytes: u64) -> Vec<PathBuf> {
    let mut newest_first = entries.to_vec();
    newest_first.sort_by_key(|entry| std::cmp::Reverse(entry.modified));
    let mut kept_bytes = 0u64;
    // `index` files are kept before this one.
    for (index, entry) in newest_first.iter().enumerate() {
        if index >= max_files || kept_bytes.saturating_add(entry.bytes) > max_bytes {
            return newest_first[index..]
                .iter()
                .map(|stale| stale.path.clone())
                .collect();
        }
        kept_bytes = kept_bytes.saturating_add(entry.bytes);
    }
    Vec::new()
}

/// Best effort: a prune never breaks chat. Staged writes (`.<name>.tmp`) are
/// left alone.
fn prune_directory(dir: &Path) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let entries = read
        .filter_map(Result::ok)
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then(|| CacheEntry {
                path: entry.path(),
                modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                bytes: metadata.len(),
            })
        })
        .collect::<Vec<_>>();
    for stale in prune_plan(&entries, CACHE_MAX_FILES, CACHE_MAX_BYTES) {
        let _ = std::fs::remove_file(stale);
    }
}

// --- The RPC and the route ----------------------------------------------------------------

/// `chatImages.cache`: the route URL of the cached image, or null when it is
/// refused (logged once per host and reason).
pub(crate) async fn cache_for_rpc(
    state: &AppState,
    params: ChatImageCacheParams,
) -> Option<String> {
    let images = state.chat_images.clone();
    match images.cache(params.kind, &params.url).await {
        Ok(file_name) => Some(images.route_url(state.port, &file_name)),
        Err(rejection) => {
            if images.first_rejection(params.kind, &rejection) {
                state.emit_log("warn", rejection.message(params.kind));
            }
            None
        }
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct ChatImageRouteQuery {
    #[serde(default)]
    key: Option<String>,
}

/// `GET /chat-images/<file>?key=<key>`: a cached image, typed by its magic
/// bytes. The key first (no answer about files without it), then a cache
/// file name and a regular file within the largest cap. Never fetches.
pub(crate) async fn serve_handler(
    State(state): State<AppState>,
    AxumPath(file_name): AxumPath<String>,
    Query(query): Query<ChatImageRouteQuery>,
) -> Response {
    serve_cached_image(&state.chat_images, &file_name, query.key.as_deref()).await
}

pub(crate) async fn serve_cached_image(
    images: &ChatImages,
    file_name: &str,
    key: Option<&str>,
) -> Response {
    if !key.is_some_and(|key| images.key_matches(key)) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if !is_cache_file_name(file_name) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = images.dir.join(file_name);
    let Ok(metadata) = tokio::fs::symlink_metadata(&path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > GIF_MAX_BYTES as u64 {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(bytes) = tokio::fs::read(&path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(format) = sniff_image(&bytes) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    (
        [
            (header::CONTENT_TYPE, format.content_type()),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; sandbox",
            ),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        bytes,
    )
        .into_response()
}

#[cfg(test)]
mod tests;
