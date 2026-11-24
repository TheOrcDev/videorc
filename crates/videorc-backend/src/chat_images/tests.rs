use std::convert::Infallible;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Uri};

use super::*;
use crate::test_temp_dir::TestTempDir;

const EMOTE_URL: &str = "https://static-cdn.jtvnw.net/emoticons/v2/smoke/default/dark/1.0";
const GIF_URL: &str = "https://media2.giphy.com/media/aUovxH8Vf9qDu/giphy.gif";
const ACCOUNT_AVATAR_URL: &str = "https://videorc.com/api/account/avatar/user/photo.png";
const NEON_HOST: &str = "br-smoke.storage.c-12.us-east-1.aws.neon.tech";
const NEON_AVATAR_URL: &str = "https://br-smoke.storage.c-12.us-east-1.aws.neon.tech/avatars/account-avatars/user/photo.png?X-Amz-Signature=secret";

fn png_bytes() -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    bytes.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R', 0, 0, 0, 1, 0, 0, 0, 1]);
    bytes
}

fn gif_bytes() -> Vec<u8> {
    let mut bytes = b"GIF89a".to_vec();
    bytes.extend_from_slice(&[1, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
    bytes
}

/// A local stand-in for every allowlisted CDN: the fetcher's fake origin
/// sends `https://<host>/<path>` here as `/<host>/<path>`. Counts requests
/// per path, so a refusal can prove nothing was fetched.
struct FakeCdn {
    origin: Url,
    hits: Arc<StdMutex<HashMap<String, usize>>>,
    total: Arc<AtomicUsize>,
}

impl FakeCdn {
    async fn start() -> Self {
        let hits = Arc::new(StdMutex::new(HashMap::<String, usize>::new()));
        let total = Arc::new(AtomicUsize::new(0));
        let (route_hits, route_total) = (hits.clone(), total.clone());
        let app = Router::new().fallback(move |uri: Uri| {
            let (hits, total) = (route_hits.clone(), route_total.clone());
            async move {
                let path = uri.path().to_string();
                *hits.lock().unwrap().entry(path.clone()).or_default() += 1;
                total.fetch_add(1, Ordering::SeqCst);
                fake_cdn_answer(&path).await
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            origin: Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap(),
            hits,
            total,
        }
    }

    fn fetcher(&self) -> ChatImageFetcher {
        ChatImageFetcher::new(PublicOnlyResolver::system(), Some(self.origin.clone())).unwrap()
    }

    fn hits(&self, path: &str) -> usize {
        self.hits.lock().unwrap().get(path).copied().unwrap_or(0)
    }

    fn total(&self) -> usize {
        self.total.load(Ordering::SeqCst)
    }
}

fn redirect(location: &str) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(header::LOCATION, location.parse().unwrap());
    (StatusCode::FOUND, headers).into_response()
}

async fn fake_cdn_answer(path: &str) -> Response {
    match path {
        "/static-cdn.jtvnw.net/emoticons/v2/smoke/default/dark/1.0"
        | "/static-cdn.jtvnw.net/emote.png"
        | "/yt3.ggpht.com/avatar.png" => png_bytes().into_response(),
        "/media2.giphy.com/media/aUovxH8Vf9qDu/giphy.gif" => gif_bytes().into_response(),
        "/yt3.ggpht.com/jpeg" => {
            let mut bytes = vec![0xff, 0xd8, 0xff, 0xe0];
            bytes.extend_from_slice(&[0; 12]);
            bytes.into_response()
        }
        "/yt3.ggpht.com/html" | "/media2.giphy.com/page" => (
            [(header::CONTENT_TYPE, "text/html")],
            "<!doctype html><html><body>not an image</body></html>",
        )
            .into_response(),
        "/yt3.ggpht.com/svg" => (
            [(header::CONTENT_TYPE, "image/svg+xml")],
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>",
        )
            .into_response(),
        "/media2.giphy.com/clip.mp4" => {
            let mut bytes = vec![0, 0, 0, 0x18];
            bytes.extend_from_slice(b"ftypisom");
            bytes.extend_from_slice(&[0; 12]);
            bytes.into_response()
        }
        "/yt3.ggpht.com/empty" => StatusCode::OK.into_response(),
        "/yt3.ggpht.com/missing" => StatusCode::NOT_FOUND.into_response(),
        "/yt3.ggpht.com/big" => {
            let mut bytes = png_bytes();
            bytes.resize(AVATAR_MAX_BYTES + 1, 0);
            bytes.into_response()
        }
        "/yt3.ggpht.com/big-chunked" => {
            let chunks = (0..3).map(|_| Ok::<_, Infallible>(Bytes::from(vec![0u8; 1024 * 1024])));
            Body::from_stream(futures_util::stream::iter(chunks)).into_response()
        }
        "/media2.giphy.com/large.gif" => {
            let mut bytes = gif_bytes();
            bytes.resize(3 * 1024 * 1024, 0);
            bytes.into_response()
        }
        // The web's account avatar route: a 302 to a presigned Neon URL.
        "/videorc.com/api/account/avatar/user/photo.png"
        | "/www.videorc.com/api/account/avatar/user/photo.png"
        | "/videorc.com/not-the-route/photo.png"
        | "/static-cdn.jtvnw.net/to-neon" => redirect(NEON_AVATAR_URL),
        "/br-smoke.storage.c-12.us-east-1.aws.neon.tech/avatars/account-avatars/user/photo.png" => {
            png_bytes().into_response()
        }
        "/br-smoke.storage.c-12.us-east-1.aws.neon.tech/avatars/hop.png" => {
            redirect(NEON_AVATAR_URL)
        }
        "/videorc.com/api/account/avatar/lookalike/photo.png" => redirect(
            "https://br-smoke.storage.c-12.us-east-1.aws.neon.tech.evil.com/avatars/photo.png",
        ),
        "/videorc.com/api/account/avatar/console/photo.png" => {
            redirect("https://console.neon.tech/avatars/photo.png")
        }
        "/videorc.com/api/account/avatar/bare/photo.png" => {
            redirect("https://storage.c-12.us-east-1.aws.neon.tech/avatars/photo.png")
        }
        "/videorc.com/api/account/avatar/http/photo.png" => {
            redirect("http://br-smoke.storage.c-12.us-east-1.aws.neon.tech/avatars/photo.png")
        }
        "/videorc.com/api/account/avatar/port/photo.png" => {
            redirect("https://br-smoke.storage.c-12.us-east-1.aws.neon.tech:8443/avatars/photo.png")
        }
        "/videorc.com/api/account/avatar/hop/photo.png" => {
            redirect("https://br-smoke.storage.c-12.us-east-1.aws.neon.tech/avatars/hop.png")
        }
        "/static-cdn.jtvnw.net/to-account-route" => {
            redirect("https://videorc.com/api/account/avatar/user/photo.png")
        }
        "/static-cdn.jtvnw.net/to-http" => redirect("http://static-cdn.jtvnw.net/emote.png"),
        "/static-cdn.jtvnw.net/to-file" => redirect("file:///etc/passwd"),
        "/static-cdn.jtvnw.net/to-loopback" => redirect("https://127.0.0.1/emote.png"),
        "/static-cdn.jtvnw.net/to-metadata" => redirect("https://169.254.169.254/latest/meta-data"),
        "/static-cdn.jtvnw.net/to-allowed" => redirect("https://static-cdn.jtvnw.net/emote.png"),
        "/static-cdn.jtvnw.net/relative" => redirect("/emote.png"),
        "/static-cdn.jtvnw.net/loop" => redirect("/loop"),
        "/static-cdn.jtvnw.net/slow" => {
            tokio::time::sleep(Duration::from_secs(10)).await;
            png_bytes().into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn fetch(cdn: &FakeCdn, kind: ChatImageKind, raw: &str) -> Result<ImageFormat, Rejection> {
    let (url, host) = url_decision(kind, raw)?;
    cdn.fetcher()
        .fetch(kind, url, host)
        .await
        .map(|(_, format)| format)
}

#[test]
fn the_allowlist_takes_only_https_on_the_platform_cdns() {
    for allowed in [
        "https://yt3.ggpht.com/abc=s88",
        "https://lh3.googleusercontent.com/a/photo",
        EMOTE_URL,
        "https://pbs.twimg.com/profile_images/1/me_normal.jpg",
        "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
        "https://files.kick.com/emotes/1/fullsize",
        "https://cdn.7tv.app/emote/01F6MZGCNG000255K4X1K96PFY/2x.webp",
        "https://abc.public.blob.vercel-storage.com/avatar.png",
        "https://videorc.com/api/account/avatar/user/photo.png",
        "https://YT3.GGPHT.COM/upper-case-host",
        "https://yt3.ggpht.com:443/default-port",
    ] {
        assert!(
            url_decision(ChatImageKind::Avatar, allowed).is_ok(),
            "{allowed} must be allowed"
        );
    }
    assert!(url_decision(ChatImageKind::Gif, GIF_URL).is_ok());
    assert!(url_decision(ChatImageKind::Gif, "https://i.giphy.com/x.gif").is_ok());
    assert!(url_decision(ChatImageKind::Gif, EMOTE_URL).is_ok());
}

#[test]
fn the_allowlist_refuses_every_other_target_before_any_fetch() {
    let refused = |kind, raw: &str| url_decision(kind, raw).unwrap_err();
    let avatar = ChatImageKind::Avatar;
    assert!(matches!(
        refused(avatar, "http://yt3.ggpht.com/a.png"),
        Rejection::Scheme { scheme, .. } if scheme == "http"
    ));
    assert!(matches!(
        refused(avatar, "file:///etc/passwd"),
        Rejection::Scheme { scheme, .. } if scheme == "file"
    ));
    assert!(matches!(
        refused(avatar, "data:image/png;base64,iVBORw0KGgo="),
        Rejection::Scheme { scheme, .. } if scheme == "data"
    ));
    assert!(matches!(
        refused(avatar, "javascript:alert(1)"),
        Rejection::Scheme { .. }
    ));
    assert!(matches!(
        refused(avatar, "ftp://yt3.ggpht.com/a.png"),
        Rejection::Scheme { .. }
    ));
    assert!(matches!(
        refused(avatar, "https://user:secret@yt3.ggpht.com/a.png"),
        Rejection::Credentials { .. }
    ));
    assert!(matches!(
        refused(avatar, "https://yt3.ggpht.com:8443/a.png"),
        Rejection::Port { .. }
    ));
    for host in [
        "https://127.0.0.1/a.png",
        "https://[::1]/a.png",
        "https://169.254.169.254/latest/meta-data",
        "https://10.0.0.8/a.png",
        "https://localhost/a.png",
        "https://evil.example.com/a.png",
        "https://static-cdn.jtvnw.net.evil.example.com/a.png",
        "https://evilstatic-cdn.jtvnw.net/a.png",
        "https://yt3.ggpht.com./trailing-dot",
        // An avatar never comes from GIPHY.
        GIF_URL,
    ] {
        assert!(
            matches!(refused(avatar, host), Rejection::Host { .. }),
            "{host} must be refused by host"
        );
    }
    // A GIF never comes from an avatar CDN other than Twitch's own.
    assert!(matches!(
        refused(ChatImageKind::Gif, "https://yt3.ggpht.com/a.gif"),
        Rejection::Host { .. }
    ));
    assert_eq!(refused(avatar, "not a url"), Rejection::NotAUrl);
    assert_eq!(refused(avatar, ""), Rejection::NotAUrl);
    let long = format!("https://yt3.ggpht.com/{}", "a".repeat(MAX_IMAGE_URL_CHARS));
    assert_eq!(refused(avatar, &long), Rejection::TooLong);
}

#[test]
fn file_names_are_the_ones_electron_main_gave_the_cache() {
    // `avatarCacheFileName` in apps/desktop/src/main/avatar-cache.ts: 32 hex
    // of sha256(url) and the extension from the URL path, `.img` otherwise.
    assert_eq!(
        cache_file_name("https://yt3.ggpht.com/videorc-smoke/comment-highlight-avatar.png"),
        "98055f44b2d4dfd30b9838bb1c56ee29.png"
    );
    assert_eq!(
        cache_file_name("https://files.kick.com/emotes/videorc-smoke-comment-highlight/fullsize"),
        "96832e86ff78ab1ff2edde4289535753.img"
    );
    assert!(cache_file_name(GIF_URL).ends_with(".gif"));
    assert!(cache_file_name("https://x.example/A.JPEG").ends_with(".jpeg"));
    for name in [
        "98055f44b2d4dfd30b9838bb1c56ee29.png",
        "96832e86ff78ab1ff2edde4289535753.img",
        "0123456789abcdef0123456789abcdef.webp",
    ] {
        assert!(is_cache_file_name(name), "{name}");
    }
    for name in [
        "",
        "../98055f44b2d4dfd30b9838bb1c56ee29.png",
        "98055F44B2D4DFD30B9838BB1C56EE29.png",
        "98055f44b2d4dfd30b9838bb1c56ee2.png",
        "98055f44b2d4dfd30b9838bb1c56ee29",
        "98055f44b2d4dfd30b9838bb1c56ee29.svg",
        "98055f44b2d4dfd30b9838bb1c56ee29.png.tmp",
        ".98055f44b2d4dfd30b9838bb1c56ee29.png.0123.tmp",
    ] {
        assert!(!is_cache_file_name(name), "{name}");
    }
}

#[test]
fn only_public_addresses_are_connectable() {
    for private in [
        "0.0.0.0",
        "10.1.2.3",
        "100.64.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "172.31.255.255",
        "192.0.0.8",
        "192.0.2.1",
        "192.168.1.10",
        "198.18.0.1",
        "198.51.100.7",
        "203.0.113.9",
        "224.0.0.1",
        "240.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "::ffff:127.0.0.1",
        "::ffff:192.168.0.1",
        "64:ff9b::a00:1",
        "2002:c0a8:0101::1",
        "2001::1",
        "2001:db8::1",
        "fc00::1",
        "fd12:3456::1",
        "fe80::1",
        "fec0::1",
        "ff02::1",
    ] {
        let address: IpAddr = private.parse().unwrap();
        assert!(!is_public_address(address), "{private} must not be public");
    }
    for public in [
        "1.1.1.1",
        "8.8.8.8",
        "151.101.1.1",
        "172.32.0.1",
        "::ffff:8.8.8.8",
        "64:ff9b::808:808",
        "2606:4700::1111",
        "2a00:1450:4001::200e",
    ] {
        let address: IpAddr = public.parse().unwrap();
        assert!(is_public_address(address), "{public} must be public");
    }
    let mixed = vec![
        "10.0.0.1:443".parse().unwrap(),
        "151.101.1.1:443".parse().unwrap(),
        "[::1]:443".parse().unwrap(),
    ];
    assert_eq!(
        public_addresses(mixed),
        vec!["151.101.1.1:443".parse::<SocketAddr>().unwrap()]
    );
}

#[tokio::test]
async fn an_allowlisted_name_that_resolves_to_a_private_address_is_never_connected() {
    // DNS rebinding: the name passes the allowlist, then resolves to the
    // loopback (or the LAN, or the metadata service). The resolver drops
    // every non-public address, so there is nothing to connect to.
    for addresses in [
        vec!["127.0.0.1:443"],
        vec!["169.254.169.254:443"],
        vec!["192.168.1.1:443", "[fe80::1]:443"],
    ] {
        let addresses = addresses
            .into_iter()
            .map(|address| address.parse::<SocketAddr>().unwrap())
            .collect::<Vec<_>>();
        let lookups = Arc::new(AtomicUsize::new(0));
        let counted = lookups.clone();
        let resolver =
            PublicOnlyResolver::with_lookup(Arc::new(move |_name: String| -> LookupFuture {
                counted.fetch_add(1, Ordering::SeqCst);
                let addresses = addresses.clone();
                Box::pin(async move { Ok(addresses) })
            }));
        let fetcher = ChatImageFetcher::new(resolver, None).unwrap();
        let (url, host) = url_decision(ChatImageKind::Avatar, EMOTE_URL).unwrap();
        let rejection = fetcher
            .fetch(ChatImageKind::Avatar, url, host)
            .await
            .unwrap_err();
        assert_eq!(
            rejection,
            Rejection::PrivateNetwork {
                host: "static-cdn.jtvnw.net".to_string()
            }
        );
        assert_eq!(lookups.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn the_fake_origin_is_dev_only_and_loopback_only() {
    assert_eq!(resolve_fake_origin(false, None), Ok(None));
    assert_eq!(resolve_fake_origin(true, Some("  ")), Ok(None));
    assert!(resolve_fake_origin(false, Some("http://127.0.0.1:4321")).is_err());
    assert_eq!(
        resolve_fake_origin(true, Some("http://127.0.0.1:4321"))
            .unwrap()
            .map(|url| url.to_string()),
        Some("http://127.0.0.1:4321/".to_string())
    );
    for refused in [
        "https://127.0.0.1:4321",
        "http://localhost:4321",
        "http://10.0.0.2:4321",
        "http://127.0.0.1",
        "http://127.0.0.1:4321/path",
        "http://127.0.0.1:4321/?q=1",
        "http://user@127.0.0.1:4321",
        "not a url",
    ] {
        assert!(
            resolve_fake_origin(true, Some(refused)).is_err(),
            "{refused}"
        );
    }
}

#[tokio::test]
async fn an_allowlisted_image_is_fetched_and_typed_by_its_bytes() {
    let cdn = FakeCdn::start().await;
    assert_eq!(
        fetch(&cdn, ChatImageKind::Avatar, EMOTE_URL).await,
        Ok(ImageFormat::Png)
    );
    assert_eq!(
        fetch(&cdn, ChatImageKind::Avatar, "https://yt3.ggpht.com/jpeg").await,
        Ok(ImageFormat::Jpeg)
    );
    assert_eq!(
        fetch(&cdn, ChatImageKind::Gif, GIF_URL).await,
        Ok(ImageFormat::Gif)
    );
    // A GIF may be bigger than an avatar.
    assert_eq!(
        fetch(
            &cdn,
            ChatImageKind::Gif,
            "https://media2.giphy.com/large.gif"
        )
        .await,
        Ok(ImageFormat::Gif)
    );
}

#[tokio::test]
async fn bodies_that_are_not_raster_images_or_are_too_large_are_refused() {
    let cdn = FakeCdn::start().await;
    let host = |name: &str| name.to_string();
    assert_eq!(
        fetch(&cdn, ChatImageKind::Avatar, "https://yt3.ggpht.com/html").await,
        Err(Rejection::NotAnImage {
            host: host("yt3.ggpht.com")
        })
    );
    assert_eq!(
        fetch(&cdn, ChatImageKind::Avatar, "https://yt3.ggpht.com/svg").await,
        Err(Rejection::NotAnImage {
            host: host("yt3.ggpht.com")
        })
    );
    assert_eq!(
        fetch(&cdn, ChatImageKind::Gif, "https://media2.giphy.com/page").await,
        Err(Rejection::NotAnImage {
            host: host("media2.giphy.com")
        })
    );
    assert_eq!(
        fetch(
            &cdn,
            ChatImageKind::Gif,
            "https://media2.giphy.com/clip.mp4"
        )
        .await,
        Err(Rejection::NotAnImage {
            host: host("media2.giphy.com")
        })
    );
    assert_eq!(
        fetch(&cdn, ChatImageKind::Avatar, "https://yt3.ggpht.com/empty").await,
        Err(Rejection::EmptyBody {
            host: host("yt3.ggpht.com")
        })
    );
    assert_eq!(
        fetch(&cdn, ChatImageKind::Avatar, "https://yt3.ggpht.com/missing").await,
        Err(Rejection::HttpStatus {
            host: host("yt3.ggpht.com"),
            status_class: "4xx".to_string()
        })
    );
    assert_eq!(
        fetch(&cdn, ChatImageKind::Avatar, "https://yt3.ggpht.com/big").await,
        Err(Rejection::TooLarge {
            host: host("yt3.ggpht.com"),
            bytes: AVATAR_MAX_BYTES as u64 + 1,
            cap: AVATAR_MAX_BYTES
        })
    );
    // No Content-Length: the cap holds while the body streams.
    assert!(matches!(
        fetch(&cdn, ChatImageKind::Avatar, "https://yt3.ggpht.com/big-chunked").await,
        Err(Rejection::TooLarge { bytes, cap, .. }) if bytes > cap as u64 && cap == AVATAR_MAX_BYTES
    ));
}

#[tokio::test]
async fn redirects_are_followed_only_onto_the_allowlist() {
    let cdn = FakeCdn::start().await;
    let avatar = ChatImageKind::Avatar;
    assert_eq!(
        fetch(&cdn, avatar, "https://static-cdn.jtvnw.net/to-allowed").await,
        Ok(ImageFormat::Png)
    );
    assert_eq!(
        fetch(&cdn, avatar, "https://static-cdn.jtvnw.net/relative").await,
        Ok(ImageFormat::Png)
    );
    let before = cdn.total();
    for (path, target) in [
        ("to-http", "http://static-cdn.jtvnw.net"),
        ("to-file", "file"),
        ("to-loopback", "https://127.0.0.1"),
        ("to-metadata", "https://169.254.169.254"),
    ] {
        assert_eq!(
            fetch(
                &cdn,
                avatar,
                &format!("https://static-cdn.jtvnw.net/{path}")
            )
            .await,
            Err(Rejection::Redirect {
                host: "static-cdn.jtvnw.net".to_string(),
                target: target.to_string()
            }),
            "{path}"
        );
    }
    // Only the four redirecting requests reached the fake; no refused target did.
    assert_eq!(cdn.total(), before + 4);
    assert_eq!(cdn.hits("/127.0.0.1/emote.png"), 0);
    // A presigned Neon URL is off the allowlist: from any host but the
    // account avatar route it is refused, and the message keeps no path or
    // query.
    let refused = fetch(&cdn, avatar, "https://static-cdn.jtvnw.net/to-neon")
        .await
        .unwrap_err();
    assert_eq!(
        refused,
        Rejection::Redirect {
            host: "static-cdn.jtvnw.net".to_string(),
            target: format!("https://{NEON_HOST}")
        }
    );
    let message = refused.message(avatar);
    assert!(
        !message.contains("Signature") && !message.contains("photo"),
        "{message}"
    );
    assert_eq!(
        fetch(&cdn, avatar, "https://static-cdn.jtvnw.net/loop").await,
        Err(Rejection::TooManyRedirects {
            host: "static-cdn.jtvnw.net".to_string()
        })
    );
}

#[tokio::test]
async fn a_stalled_cdn_meets_the_deadline() {
    let cdn = FakeCdn::start().await;
    let (url, host) =
        url_decision(ChatImageKind::Avatar, "https://static-cdn.jtvnw.net/slow").unwrap();
    let started = Instant::now();
    let rejection = cdn
        .fetcher()
        .with_deadline(Duration::from_millis(300))
        .fetch(ChatImageKind::Avatar, url, host)
        .await
        .unwrap_err();
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(
        matches!(&rejection, Rejection::FetchError { message, .. } if message.contains("300ms deadline")),
        "{rejection:?}"
    );
}

#[tokio::test]
async fn a_refused_url_never_reaches_the_network() {
    let cdn = FakeCdn::start().await;
    let root = TestTempDir::new("chat-images-refused");
    let images = Arc::new(ChatImages::with_fetcher(root.join("cache"), cdn.fetcher()));
    for raw in [
        "http://static-cdn.jtvnw.net/emote.png",
        "file:///etc/passwd",
        "https://127.0.0.1/emote.png",
        "https://evil.example.com/emote.png",
    ] {
        assert!(
            images.cache(ChatImageKind::Avatar, raw).await.is_err(),
            "{raw}"
        );
    }
    assert_eq!(cdn.total(), 0);
    assert!(!root.join("cache").exists());
}

#[tokio::test]
async fn an_image_is_fetched_once_and_stored_under_its_electron_name() {
    let cdn = FakeCdn::start().await;
    let root = TestTempDir::new("chat-images-cache");
    let dir = root.join("avatar-cache");
    let images = Arc::new(ChatImages::with_fetcher(dir.clone(), cdn.fetcher()));
    // Concurrent asks for one uncached image share one fetch.
    let (first, second) = tokio::join!(
        images.cache(ChatImageKind::Avatar, EMOTE_URL),
        images.cache(ChatImageKind::Avatar, EMOTE_URL)
    );
    let file_name = first.unwrap();
    assert_eq!(second.unwrap(), file_name);
    assert_eq!(file_name, cache_file_name(EMOTE_URL));
    assert_eq!(std::fs::read(dir.join(&file_name)).unwrap(), png_bytes());
    // Cached: answered from disk.
    assert_eq!(
        images
            .cache(ChatImageKind::Avatar, EMOTE_URL)
            .await
            .unwrap(),
        file_name
    );
    assert_eq!(
        cdn.hits("/static-cdn.jtvnw.net/emoticons/v2/smoke/default/dark/1.0"),
        1
    );
    // A refusal stores nothing.
    assert!(
        images
            .cache(ChatImageKind::Avatar, "https://yt3.ggpht.com/html")
            .await
            .is_err()
    );
    let stored = std::fs::read_dir(&dir).unwrap().count();
    assert_eq!(stored, 1, "only the image, no staged or refused file");
}

#[tokio::test]
async fn the_route_serves_cached_images_only_with_this_runs_key() {
    let root = TestTempDir::new("chat-images-route");
    let dir = root.join("avatar-cache");
    std::fs::create_dir_all(&dir).unwrap();
    let images = ChatImages::new(dir.clone(), None);
    let png_name = "0123456789abcdef0123456789abcdef.img";
    std::fs::write(dir.join(png_name), png_bytes()).unwrap();
    let html_name = "fedcba9876543210fedcba9876543210.png";
    std::fs::write(
        dir.join(html_name),
        b"<!doctype html><script>alert(1)</script>",
    )
    .unwrap();

    let url = images.route_url(4321, png_name);
    assert!(url.starts_with(
        "http://127.0.0.1:4321/chat-images/0123456789abcdef0123456789abcdef.img?key="
    ));
    let key = url.split_once("?key=").unwrap().1.to_string();
    assert_eq!(key.len(), 32);
    assert!(key.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_ne!(
        ChatImages::new(dir.clone(), None).key,
        images.key,
        "a fresh key per run"
    );

    let status = |response: Response| response.status();
    assert_eq!(
        status(serve_cached_image(&images, png_name, None).await),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        status(serve_cached_image(&images, png_name, Some("0123")).await),
        StatusCode::UNAUTHORIZED
    );
    // No answer about files without the key, not even a 404.
    assert_eq!(
        status(serve_cached_image(&images, "../videorc.sqlite3", Some("wrong")).await),
        StatusCode::UNAUTHORIZED
    );
    for refused in [
        "../videorc.sqlite3",
        "missing.png",
        "0123456789ABCDEF0123456789ABCDEF.img",
    ] {
        assert_eq!(
            status(serve_cached_image(&images, refused, Some(&key)).await),
            StatusCode::NOT_FOUND,
            "{refused}"
        );
    }
    // Not a missing file but not an image either: never served.
    assert_eq!(
        status(serve_cached_image(&images, html_name, Some(&key)).await),
        StatusCode::NOT_FOUND
    );
    let response = serve_cached_image(&images, png_name, Some(&key)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let headers = response.headers();
    assert_eq!(headers[header::CONTENT_TYPE], "image/png");
    assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        headers[header::CONTENT_SECURITY_POLICY],
        "default-src 'none'; sandbox"
    );
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(body.as_ref(), png_bytes().as_slice());
}

#[cfg(unix)]
#[tokio::test]
async fn the_route_never_follows_a_symlink_out_of_the_cache() {
    let root = TestTempDir::new("chat-images-symlink");
    let dir = root.join("avatar-cache");
    std::fs::create_dir_all(&dir).unwrap();
    let outside = root.join("outside.png");
    std::fs::write(&outside, png_bytes()).unwrap();
    let name = "0123456789abcdef0123456789abcdef.png";
    std::os::unix::fs::symlink(&outside, dir.join(name)).unwrap();
    let images = ChatImages::new(dir, None);
    let key = images.key.clone();
    assert_eq!(
        serve_cached_image(&images, name, Some(&key)).await.status(),
        StatusCode::NOT_FOUND
    );
}

#[test]
fn the_prune_keeps_the_newest_files_within_both_limits() {
    let at = |seconds: u64| SystemTime::UNIX_EPOCH + Duration::from_secs(seconds);
    let entry = |name: &str, seconds: u64, bytes: u64| CacheEntry {
        path: PathBuf::from(name),
        modified: at(seconds),
        bytes,
    };
    let entries = vec![
        entry("old", 1, 10),
        entry("new", 3, 10),
        entry("middle", 2, 10),
    ];
    assert!(prune_plan(&entries, 3, 30).is_empty());
    assert_eq!(prune_plan(&entries, 2, 1_000), vec![PathBuf::from("old")]);
    // 20 bytes fit 25; the third file would not.
    assert_eq!(prune_plan(&entries, 1_000, 25), vec![PathBuf::from("old")]);
    assert_eq!(
        prune_plan(&entries, 1_000, 15),
        vec![PathBuf::from("middle"), PathBuf::from("old")]
    );
    assert_eq!(prune_plan(&entries, 0, 1_000).len(), 3);
}

#[test]
fn fetch_errors_never_carry_a_url() {
    assert_eq!(
        redact_fetch_error("error sending request for url (https://cdn.example/a?token=secret)"),
        "error sending request for url <url>"
    );
    assert!(redact_fetch_error(&"x".repeat(400)).chars().count() <= 160);
}

#[test]
fn the_account_avatar_route_and_neon_storage_hosts_are_recognised_exactly() {
    let route = |raw: &str| is_account_avatar_route(&Url::parse(raw).unwrap());
    for accepted in [
        ACCOUNT_AVATAR_URL,
        "https://www.videorc.com/api/account/avatar/user/photo.png",
        "https://videorc.com/api/account/avatar/u_1-a.b=c/f.jpg",
        "https://videorc.com/api/account/avatar/user/photo.webp",
    ] {
        assert!(route(accepted), "{accepted}");
    }
    for refused in [
        "http://videorc.com/api/account/avatar/user/photo.png",
        "https://videorc.com:8443/api/account/avatar/user/photo.png",
        "https://user:secret@videorc.com/api/account/avatar/user/photo.png",
        "https://cdn.videorc.com/api/account/avatar/user/photo.png",
        "https://videorc.com.evil.com/api/account/avatar/user/photo.png",
        "https://videorc.com/api/account/avatar/user/photo.png?size=64",
        "https://videorc.com/api/account/avatar/user/photo.png#x",
        "https://videorc.com/api/account/avatar/user/photo.gif",
        "https://videorc.com/api/account/avatar/user/photo",
        "https://videorc.com/api/account/avatar/user/sub/photo.png",
        "https://videorc.com/api/account/avatar/../photo.png",
        "https://videorc.com/api/account/avatar/us%2Fer/photo.png",
        "https://videorc.com/api/account/avatarx/user/photo.png",
        "https://videorc.com/not-the-route/photo.png",
    ] {
        assert!(!route(refused), "{refused}");
    }
    for accepted in [
        NEON_HOST,
        "br-quiet-sun-a1b2c3d4.storage.c-3.eu-central-1.aws.neon.tech",
        "br-shiny-dew-aw8dwo3v.storage.c-12.us-east-1.aws.neon.tech",
        "br-x.storage.c-1.ap-southeast-1.aws.neon.tech",
    ] {
        assert!(is_neon_storage_host(accepted), "{accepted}");
    }
    for refused in [
        "storage.c-1.us-east-1.aws.neon.tech",
        "br-x.storage.c-1.us-east-1.aws.neon.tech.evil.com",
        "evil.br-x.storage.c-1.us-east-1.aws.neon.tech",
        "console.neon.tech",
        "br-x.api.c-1.us-east-1.aws.neon.tech",
        "ep-x.storage.c-1.us-east-1.aws.neon.tech",
        "br-.storage.c-1.us-east-1.aws.neon.tech",
        "br-x.storage.c-.us-east-1.aws.neon.tech",
        "br-x.storage.c-x.us-east-1.aws.neon.tech",
        "br-x.storage.c-1.useast1.aws.neon.tech",
        "br-x.storage.c-1.us-east-1.azure.neon.tech",
        "br-x.storage.c-1.us-east-1.aws.neon.tech.",
        "br-x.storage.c-1.us-east-1.aws.evilneon.tech",
    ] {
        assert!(!is_neon_storage_host(refused), "{refused}");
    }
}

#[tokio::test]
async fn the_account_avatar_route_alone_may_follow_its_redirect_to_neon_storage() {
    // Owner, 2026-11-09: the one redirect off the allowlist.
    let cdn = FakeCdn::start().await;
    let avatar = ChatImageKind::Avatar;
    let neon_path = format!("/{NEON_HOST}/avatars/account-avatars/user/photo.png");
    assert_eq!(
        fetch(&cdn, avatar, ACCOUNT_AVATAR_URL).await,
        Ok(ImageFormat::Png)
    );
    assert_eq!(
        fetch(
            &cdn,
            avatar,
            "https://www.videorc.com/api/account/avatar/user/photo.png"
        )
        .await,
        Ok(ImageFormat::Png)
    );
    assert_eq!(cdn.hits(&neon_path), 2);

    // Stored under the route's name, never the presigned URL's.
    let root = TestTempDir::new("chat-images-neon");
    let images = Arc::new(ChatImages::with_fetcher(root.join("cache"), cdn.fetcher()));
    assert_eq!(
        images.cache(avatar, ACCOUNT_AVATAR_URL).await,
        Ok(cache_file_name(ACCOUNT_AVATAR_URL))
    );

    // Never a direct fetch.
    assert_eq!(
        url_decision(avatar, NEON_AVATAR_URL),
        Err(Rejection::Host {
            host: NEON_HOST.to_string()
        })
    );
    let before = cdn.total();
    assert!(images.cache(avatar, NEON_AVATAR_URL).await.is_err());
    assert_eq!(cdn.total(), before);

    // Never from another allowlisted host, another videorc.com path, the
    // route with a query, or the route reached by a redirect.
    let neon_target = format!("https://{NEON_HOST}");
    for (raw, host) in [
        (
            "https://static-cdn.jtvnw.net/to-neon",
            "static-cdn.jtvnw.net",
        ),
        ("https://videorc.com/not-the-route/photo.png", "videorc.com"),
        (
            "https://videorc.com/api/account/avatar/user/photo.png?size=64",
            "videorc.com",
        ),
        (
            "https://static-cdn.jtvnw.net/to-account-route",
            "videorc.com",
        ),
        // Neon may not redirect onward to Neon either.
        (
            "https://videorc.com/api/account/avatar/hop/photo.png",
            NEON_HOST,
        ),
    ] {
        assert_eq!(
            fetch(&cdn, avatar, raw).await,
            Err(Rejection::Redirect {
                host: host.to_string(),
                target: neon_target.clone()
            }),
            "{raw}"
        );
    }

    // From the route, never to a look-alike or another neon.tech host, and
    // never over http or to a port.
    for (user, target) in [
        (
            "lookalike",
            "https://br-smoke.storage.c-12.us-east-1.aws.neon.tech.evil.com",
        ),
        ("console", "https://console.neon.tech"),
        ("bare", "https://storage.c-12.us-east-1.aws.neon.tech"),
        (
            "http",
            "http://br-smoke.storage.c-12.us-east-1.aws.neon.tech",
        ),
        (
            "port",
            "https://br-smoke.storage.c-12.us-east-1.aws.neon.tech",
        ),
    ] {
        assert_eq!(
            fetch(
                &cdn,
                avatar,
                &format!("https://videorc.com/api/account/avatar/{user}/photo.png")
            )
            .await,
            Err(Rejection::Redirect {
                host: "videorc.com".to_string(),
                target: target.to_string()
            }),
            "{user}"
        );
    }
    // A GIF never comes from the account route at all.
    assert_eq!(
        url_decision(ChatImageKind::Gif, ACCOUNT_AVATAR_URL),
        Err(Rejection::Host {
            host: "videorc.com".to_string()
        })
    );
    assert_eq!(
        cdn.hits(&neon_path),
        3,
        "only the three followed redirects reached Neon"
    );
}

// Plan 220 S1.2c: the overlays the backend draws read the cache folder only.
#[test]
fn a_drawn_overlay_reads_cached_images_and_never_anything_else() {
    let root = TestTempDir::new("chat-images-read-cached");
    let dir = root.join("avatar-cache");
    std::fs::create_dir_all(&dir).unwrap();
    let images = ChatImages::new(dir.clone(), None);
    let avatar = "https://yt3.ggpht.com/videorc-smoke/avatar.png";
    assert_eq!(images.read_cached_avatar(avatar), None, "not cached yet");
    std::fs::write(dir.join(cache_file_name(avatar)), png_bytes()).unwrap();
    assert_eq!(images.read_cached_avatar(avatar), Some(png_bytes()));
    // Off the allowlist: never read, even with a file under its name.
    let elsewhere = "https://example.com/avatar.png";
    std::fs::write(dir.join(cache_file_name(elsewhere)), png_bytes()).unwrap();
    assert_eq!(images.read_cached_avatar(elsewhere), None);
    // Not an image by its bytes, or over the avatar cap.
    std::fs::write(dir.join(cache_file_name(EMOTE_URL)), b"<html>").unwrap();
    assert_eq!(images.read_cached_avatar(EMOTE_URL), None);
    let mut large = png_bytes();
    large.resize(AVATAR_MAX_BYTES + 1, 0);
    std::fs::write(dir.join(cache_file_name(avatar)), large).unwrap();
    assert_eq!(images.read_cached_avatar(avatar), None);
}

// Plan 260 S1.5a: the YouTube built-in emote catalog (`assets/youtube-emotes.tsv`)
// is cached through this allowlist, with safe file names (moved here from
// Electron main's `youtube-emote-cache.test.ts` with the cache).
#[test]
fn the_youtube_emote_catalog_passes_the_allowlist_with_safe_file_names() {
    let catalog = include_str!("../../assets/youtube-emotes.tsv");
    let rows: Vec<(&str, &str)> = catalog
        .trim()
        .lines()
        .map(|line| line.split_once('\t').expect("alias and URL"))
        .collect();
    assert_eq!(rows.len(), 122);
    for (alias, url) in rows {
        assert!(alias.starts_with(':') && alias.ends_with(':'), "{alias}");
        assert!(
            url.starts_with("https://yt3.ggpht.com/") && url.ends_with("=w48-h48-c-k-nd"),
            "{url}"
        );
        let (_, host) = url_decision(ChatImageKind::Avatar, url).expect(url);
        assert_eq!(host, "yt3.ggpht.com");
        let name = cache_file_name(url);
        assert!(name.ends_with(".img") && name.len() == 36, "{name}");
        assert!(is_cache_file_name(&name), "{name}");
    }
    for refused in [
        "https://yt3.ggpht.com.attacker.test/blue",
        "https://yt3.ggpht.com@attacker.test/blue",
        "http://yt3.ggpht.com/blue",
        "data:image/svg+xml,<svg onload=alert(1)>",
        "javascript:alert(1)",
        "file:///etc/passwd",
    ] {
        assert!(
            url_decision(ChatImageKind::Avatar, refused).is_err(),
            "{refused}"
        );
    }
}
