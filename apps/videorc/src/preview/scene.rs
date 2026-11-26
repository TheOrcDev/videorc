//! Which scene the preview shows (plan 260 S2.3a, S3.1b, S3.1e).
//!
//! The product follows the Studio's scene: [`follow_studio`] feeds
//! `SceneFeed::following` with the core's `preview_scene_request` from
//! every snapshot (the capture config's scene while nothing holds it, none
//! while a session, a start or a stop does). A scene the Studio's own layout
//! transaction already committed is adopted, not reloaded
//! (`skipNextConfigSceneReloadRef`), and each reload the feed commits is the
//! confirmed working setup (`note_scene_reloaded`, D11 autosave, #1784). A
//! pinned test pattern shows instead when `VIDEORC_PREVIEW_CANVAS=WxH[@fps]`
//! is set (the measurement's canvas, and what `probe:preview-lifecycle` and
//! `probe:preview-window` drive). The Scene page's canvas and the Studio's
//! slot show the same feed.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::watch;
use videorc_app_core::smoke;
use videorc_app_core::studio::capture_config::CaptureConfig;
use videorc_app_core::studio::preview_scene::preview_scene_reload;
use videorc_app_core::{BackendClient, Studio};
use videorc_preview::bounds::Canvas;
use videorc_preview::feed::{SceneCommitted, SceneFeed};
use videorc_protocol::{SceneConfigParams, SourceSelection, VideoPreset, VideoSettings};

type AppStudio = Studio<BackendClient>;

/// How long after a layout transaction's commit the capture config's next
/// scene is taken as that commit's (the settle writes the capture config
/// once the commit is proven). Electron's skip has no limit; a bound keeps
/// a later, unrelated change from being adopted instead of committed.
const ADOPT_WINDOW: Duration = Duration::from_secs(3);

/// The variable that pins the canvas to the test pattern.
pub const CANVAS_VAR: &str = "VIDEORC_PREVIEW_CANVAS";

/// What the feed starts with.
pub struct SceneChoice {
    pub feed: SceneFeed,
    pub canvas: Canvas,
    pub fps: u32,
    /// For the log.
    pub described: String,
}

/// `WxH` or `WxH@fps`; `None` for anything else.
pub fn parse_canvas(text: &str) -> Option<(u32, u32, u32)> {
    let (size, fps) = match text.trim().split_once('@') {
        Some((size, fps)) => (size, fps.parse::<u32>().ok()?),
        None => (text.trim(), 60),
    };
    let (width, height) = size.split_once('x')?;
    let width: u32 = width.parse().ok()?;
    let height: u32 = height.parse().ok()?;
    (width > 0 && height > 0 && fps > 0).then_some((width, height, fps))
}

/// The scene for this run: the pinned test pattern, or the Studio's scene
/// at the slot's own size.
pub fn choose(
    env: impl Fn(&str) -> Option<String>,
    studio: Option<(&Arc<AppStudio>, &tokio::runtime::Handle)>,
) -> SceneChoice {
    let config = CaptureConfig::default();
    if let Some((width, height, fps)) = env(CANVAS_VAR).as_deref().and_then(parse_canvas) {
        let params = SceneConfigParams {
            sources: SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: true,
            },
            layout: config.layout,
            video: Some(VideoSettings {
                preset: VideoPreset::Custom,
                width,
                height,
                fps,
                bitrate_kbps: config.video.bitrate_kbps.max(40_000),
            }),
            background: None,
            protected_overlay_window_ids: Vec::new(),
            transition_ms: None,
        };
        return SceneChoice {
            feed: SceneFeed::fixed(params),
            canvas: Canvas::Pinned { width, height },
            fps,
            described: format!("the test pattern pinned at {width}x{height}@{fps} ({CANVAS_VAR})"),
        };
    }
    let fps = config.video.fps.max(1);
    if let Some((studio, runtime)) = studio {
        let smoke_preview = env(smoke::vars::PREVIEW_MOTION).as_deref() == Some("1");
        return SceneChoice {
            feed: follow_studio(studio, runtime, smoke_preview),
            canvas: Canvas::Slot,
            fps,
            described: "the Studio's scene".to_string(),
        };
    }
    let params = SceneConfigParams {
        sources: config.sources,
        layout: config.layout,
        video: Some(config.video),
        background: None,
        protected_overlay_window_ids: Vec::new(),
        transition_ms: None,
    };
    SceneChoice {
        feed: SceneFeed::fixed(params),
        canvas: Canvas::Slot,
        fps,
        described: "the capture config's default scene".to_string(),
    }
}

/// S3.1b, S3.1e: the Studio's scene as it changes, the transaction commits
/// to adopt, and the working setup confirmed after each reload.
fn follow_studio(
    studio: &Arc<AppStudio>,
    runtime: &tokio::runtime::Handle,
    smoke_preview: bool,
) -> SceneFeed {
    let mut snapshots = studio.watch();
    let first = preview_scene_reload(&snapshots.borrow(), smoke_preview);
    // The capture config each request was made from: what its commit
    // confirms (`loadScene(config, config.sources)`), never the request's
    // protocol sources, which read as "Invalid source identity".
    let sent = Arc::new(Mutex::new(first.clone()));
    let (requests, request_rx) = watch::channel(first.map(|reload| reload.request));
    let (adopt, adopt_rx) = watch::channel::<Option<(u64, SceneConfigParams)>>(None);
    // `loadScene` reads the mark before its request: a reload a switch or
    // a key overtook confirms nothing.
    let mark = Arc::new(Mutex::new(studio.scene_reload_mark()));

    // The request the backend shows now (committed or adopted).
    let landed = Arc::new(Mutex::new(None::<SceneConfigParams>));

    let hook_studio = studio.clone();
    let hook_mark = mark.clone();
    let hook_sent = sent.clone();
    let hook_landed = landed.clone();
    let hook_runtime = runtime.clone();
    let on_committed: SceneCommitted = Arc::new(move |params: &SceneConfigParams| {
        if let Ok(mut landed) = hook_landed.lock() {
            *landed = Some(params.clone());
        }
        let Ok(mark) = hook_mark.lock().map(|mark| mark.clone()) else {
            return;
        };
        let Some((layout, sources)) = hook_sent.lock().ok().and_then(|sent| {
            let reload = sent.as_ref()?;
            let (layout, sources) = reload.confirms(params)?;
            Some((layout.clone(), sources.clone()))
        }) else {
            return;
        };
        let studio = hook_studio.clone();
        hook_runtime.spawn(async move {
            studio
                .note_preview_scene_reloaded(mark, &layout, &sources)
                .await;
        });
    });

    let studio = studio.clone();
    let confirm_runtime = runtime.clone();
    runtime.spawn(async move {
        let mut seen_commit = studio.layout_commit_revision();
        // A transaction committed: the request it leaves behind, when it
        // changes, is that commit's scene.
        let mut armed: Option<(u64, Option<SceneConfigParams>, Instant)> = None;
        loop {
            let reload = preview_scene_reload(&snapshots.borrow_and_update(), smoke_preview);
            let request = reload.as_ref().map(|reload| reload.request.clone());
            let commit = studio.layout_commit_revision();
            if commit > seen_commit {
                seen_commit = commit;
                armed = Some((commit, requests.borrow().clone(), Instant::now()));
            }
            if let Some((commit, before, at)) = &armed {
                if at.elapsed() > ADOPT_WINDOW {
                    armed = None;
                } else if let Some(params) =
                    request.as_ref().filter(|now| Some(*now) != before.as_ref())
                {
                    adopt.send_replace(Some((*commit, params.clone())));
                    if let Ok(mut landed) = landed.lock() {
                        *landed = Some(params.clone());
                    }
                    armed = None;
                }
            }
            let resend = *requests.borrow() != request;
            if resend {
                if let Ok(mut held) = mark.lock() {
                    *held = studio.scene_reload_mark();
                }
                requests.send_replace(request);
            }
            let Some(reload) = reload else {
                if snapshots.changed().await.is_err() {
                    break;
                }
                continue;
            };
            // `reloadSceneFromCaptureConfig` runs on every change of the
            // capture config's sources, and after the scene on stream
            // changed: a change the request doesn't carry (a camera or the
            // test pattern under the smoke's preview scene, a name) is
            // confirmed too once the backend shows the request, so the
            // scene on stream sees the pick (D2, D11).
            let now_mark = studio.scene_reload_mark();
            let reconfirm = !resend
                && landed
                    .lock()
                    .is_ok_and(|landed| landed.as_ref() == Some(&reload.request))
                && (sent.lock().is_ok_and(|held| {
                    held.as_ref().is_none_or(|held| {
                        held.layout != reload.layout || held.sources != reload.sources
                    })
                }) || mark.lock().is_ok_and(|held| *held != now_mark));
            if reconfirm {
                if let Ok(mut held) = mark.lock() {
                    *held = now_mark.clone();
                }
                let (studio, layout, sources) = (
                    studio.clone(),
                    reload.layout.clone(),
                    reload.sources.clone(),
                );
                confirm_runtime.spawn(async move {
                    studio
                        .note_preview_scene_reloaded(now_mark, &layout, &sources)
                        .await;
                });
            }
            if let Ok(mut held) = sent.lock() {
                *held = Some(reload);
            }
            if snapshots.changed().await.is_err() {
                break;
            }
        }
    });

    SceneFeed::following(request_rx)
        .with_adopted(adopt_rx)
        .on_committed(on_committed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_canvas_reads_size_and_rate() {
        assert_eq!(parse_canvas("3840x2160@60"), Some((3840, 2160, 60)));
        assert_eq!(parse_canvas("1920x1080"), Some((1920, 1080, 60)));
        assert_eq!(parse_canvas(" 1280x720@30 "), Some((1280, 720, 30)));
        assert_eq!(parse_canvas("0x1080"), None);
        assert_eq!(parse_canvas("1920x1080@0"), None);
        assert_eq!(parse_canvas("1920"), None);
        assert_eq!(parse_canvas("widexhigh"), None);
    }

    #[test]
    fn the_pinned_canvas_is_the_test_pattern() {
        let choice = choose(
            |name| (name == CANVAS_VAR).then(|| "1280x720@30".to_string()),
            None,
        );
        assert_eq!(
            choice.canvas,
            Canvas::Pinned {
                width: 1280,
                height: 720
            }
        );
        assert_eq!(choice.fps, 30);
        let params = choice.feed.current().expect("a fixed scene");
        assert!(params.sources.test_pattern);
        assert_eq!(params.video.map(|video| video.width), Some(1280));
    }

    #[test]
    fn without_a_pin_the_slot_sizes_the_canvas() {
        let choice = choose(|_| None, None);
        assert_eq!(choice.canvas, Canvas::Slot);
        assert!(choice.feed.current().is_some());
    }
}
