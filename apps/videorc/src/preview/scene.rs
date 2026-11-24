//! Which scene the preview shows (plan 260 S2.3a).
//!
//! The product follows the Studio's scene: `SceneFeed::following` over the
//! Studio's request, with `note_scene_reloaded` called from the feed's
//! `on_committed` hook (D11 autosave, #1784; the plan's S2.3a note). The
//! Studio's state lands in the core with S1.6a, so until then the preview
//! shows the capture config's default scene, and a pinned test pattern when
//! `VIDEORC_PREVIEW_CANVAS=WxH[@fps]` is set (the measurement's canvas, and
//! what `probe:preview-lifecycle` and `probe:preview-window` drive).

use videorc_app_core::studio::capture_config::CaptureConfig;
use videorc_preview::bounds::Canvas;
use videorc_preview::feed::SceneFeed;
use videorc_protocol::{SceneConfigParams, SourceSelection, VideoPreset, VideoSettings};

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

/// The scene for this run: the pinned test pattern, or the capture
/// config's default scene at the slot's own size.
pub fn choose(env: impl Fn(&str) -> Option<String>) -> SceneChoice {
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
        described: "the capture config's default scene (the Studio's scene comes with S1.6a)"
            .to_string(),
    }
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
        let choice = choose(|name| (name == CANVAS_VAR).then(|| "1280x720@30".to_string()));
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
        let choice = choose(|_| None);
        assert_eq!(choice.canvas, Canvas::Slot);
        assert!(choice.feed.current().is_some());
    }
}
