//! LS2 + LS3a: the live render consumer and compositor.
//!
//! Proves the architecture the live-editing feature depends on: an output that
//! consumes committed scene revisions *continuously*, so a hot transform/visibility/
//! order edit changes the next rendered frame **without restarting the output**.
//!
//! - LS2: a solid-colour painter's-algorithm compositor + [`LiveRenderConsumer`], so
//!   the revision→frame loop is provable in deterministic tests with fake sources.
//! - LS3a: [`composite_frames`] composites real source pixel buffers (scale, crop,
//!   position, painter order), and an `#[ignore]`d test proves the full
//!   FFmpeg-capture → Rust-composite → FFmpeg-encode pipeline applies a live edit
//!   mid-recording without restarting the output.
//!
//! The real session pipeline wires this in next (LS3b); `allow(dead_code)` until then.
#![allow(dead_code)]

use std::collections::HashMap;

use crate::live_scene::{
    ActiveScene, LiveEditDecision, LiveEditEvent, MutationContext, SceneMutation, decode_op,
};
use crate::protocol::{SceneSource, SceneTransform};

/// The background colour where no visible source covers a pixel.
const BACKGROUND: [u8; 3] = [0, 0, 0];

/// A composited frame: the colour of the topmost visible source at each pixel.
#[derive(Debug, Clone, PartialEq)]
pub struct RenderedFrame {
    pub revision: u64,
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<[u8; 3]>,
}

impl RenderedFrame {
    pub fn pixel(&self, x: usize, y: usize) -> [u8; 3] {
        self.pixels[y * self.width + x]
    }

    /// Samples the colour at a normalized (0..1) point.
    pub fn sample(&self, nx: f64, ny: f64) -> [u8; 3] {
        let x = ((nx * self.width as f64) as usize).min(self.width.saturating_sub(1));
        let y = ((ny * self.height as f64) as usize).min(self.height.saturating_sub(1));
        self.pixel(x, y)
    }

    /// Flattened RGB bytes, ready to feed a rawvideo encoder (LS3).
    pub fn rgb_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(self.pixels.len() * 3);
        for px in &self.pixels {
            bytes.extend_from_slice(px);
        }
        bytes
    }
}

/// A stable, distinct-ish colour for a source id, so tests can predict what a source
/// paints. The high bit per channel is forced on so no source is mistaken for the
/// black background.
pub fn source_color(id: &str) -> [u8; 3] {
    let mut hash: u32 = 2_166_136_261;
    for byte in id.bytes() {
        hash = (hash ^ u32::from(byte)).wrapping_mul(16_777_619);
    }
    [
        ((hash >> 16) as u8) | 0x80,
        ((hash >> 8) as u8) | 0x80,
        (hash as u8) | 0x80,
    ]
}

fn covers(transform: &SceneTransform, x: f64, y: f64) -> bool {
    x >= transform.x
        && x < transform.x + transform.width
        && y >= transform.y
        && y < transform.y + transform.height
}

/// Composites the scene into a frame. Sources are painted in list order (painter's
/// algorithm), so the last visible source covering a pixel wins — reordering a source
/// to the end brings it to the top.
pub fn composite(
    sources: &[SceneSource],
    revision: u64,
    width: usize,
    height: usize,
) -> RenderedFrame {
    let mut pixels = vec![BACKGROUND; width * height];
    for py in 0..height {
        let cy = (py as f64 + 0.5) / height as f64;
        for px in 0..width {
            let cx = (px as f64 + 0.5) / width as f64;
            for source in sources {
                if source.visible && covers(&source.transform, cx, cy) {
                    pixels[py * width + px] = source_color(&source.id);
                }
            }
        }
    }
    RenderedFrame {
        revision,
        width,
        height,
        pixels,
    }
}

/// A source's current pixel frame — a captured screen/camera frame, or a synthetic
/// fill. Real frames flow in from FFmpeg capture (rawvideo) in the LS3 session
/// pipeline; tests build them directly.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceFrame {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<[u8; 3]>,
}

impl SourceFrame {
    pub fn solid(width: usize, height: usize, color: [u8; 3]) -> Self {
        Self {
            width,
            height,
            pixels: vec![color; width * height],
        }
    }

    /// Builds a frame from interleaved rgb24 bytes (one captured rawvideo frame).
    pub fn from_rgb24(width: usize, height: usize, bytes: &[u8]) -> Self {
        let pixels = bytes
            .as_chunks::<3>()
            .0
            .iter()
            .map(|chunk| [chunk[0], chunk[1], chunk[2]])
            .collect();
        Self {
            width,
            height,
            pixels,
        }
    }

    /// Nearest-neighbour sample at a normalized (u, v) point in 0..1.
    fn sample(&self, u: f64, v: f64) -> [u8; 3] {
        if self.width == 0 || self.height == 0 {
            return BACKGROUND;
        }
        let x = ((u.clamp(0.0, 1.0) * self.width as f64) as usize).min(self.width - 1);
        let y = ((v.clamp(0.0, 1.0) * self.height as f64) as usize).min(self.height - 1);
        self.pixels[y * self.width + x]
    }
}

/// Composites real source frames onto the output canvas per the scene: each visible
/// source's frame is scaled into its transform rect, with crop applied to the sampled
/// region. Sources are painted in list order (painter's algorithm), so a later source
/// overwrites an earlier one where they overlap — matching the opaque FFmpeg overlay.
/// A source without a supplied frame is skipped (it contributes nothing this frame).
pub fn composite_frames(
    sources: &[SceneSource],
    frames: &HashMap<String, SourceFrame>,
    revision: u64,
    out_width: usize,
    out_height: usize,
) -> RenderedFrame {
    let mut pixels = vec![BACKGROUND; out_width * out_height];
    for source in sources {
        if !source.visible {
            continue;
        }
        let Some(frame) = frames.get(&source.id) else {
            continue;
        };
        let t = &source.transform;
        if t.width <= 0.0 || t.height <= 0.0 {
            continue;
        }
        // The visible width of the source after cropping (fraction of the frame kept).
        let kept_u = (1.0 - t.crop_left - t.crop_right).max(0.0);
        let kept_v = (1.0 - t.crop_top - t.crop_bottom).max(0.0);
        let x0 = (t.x * out_width as f64).floor().max(0.0) as usize;
        let y0 = (t.y * out_height as f64).floor().max(0.0) as usize;
        let x1 = (((t.x + t.width) * out_width as f64).ceil() as usize).min(out_width);
        let y1 = (((t.y + t.height) * out_height as f64).ceil() as usize).min(out_height);
        for py in y0..y1 {
            let within_y = ((py as f64 + 0.5) / out_height as f64 - t.y) / t.height;
            if !(0.0..1.0).contains(&within_y) {
                continue;
            }
            let v = t.crop_top + within_y * kept_v;
            for px in x0..x1 {
                let within_x = ((px as f64 + 0.5) / out_width as f64 - t.x) / t.width;
                if !(0.0..1.0).contains(&within_x) {
                    continue;
                }
                let u = t.crop_left + within_x * kept_u;
                pixels[py * out_width + px] = frame.sample(u, v);
            }
        }
    }
    RenderedFrame {
        revision,
        width: out_width,
        height: out_height,
        pixels,
    }
}

/// An output that consumes committed scene revisions continuously. Submitting a hot
/// mutation changes the *next* rendered frame; the consumer is never recreated for hot
/// changes, so its `generation` stays constant (a true restart — a cold output-mode
/// change in LS7 — would bump it).
#[derive(Debug, Clone)]
pub struct LiveRenderConsumer {
    scene: ActiveScene,
    width: usize,
    height: usize,
    generation: u64,
    frames_rendered: u64,
}

impl LiveRenderConsumer {
    pub fn start(scene: ActiveScene, width: usize, height: usize) -> Self {
        Self {
            scene,
            width,
            height,
            generation: 1,
            frames_rendered: 0,
        }
    }

    /// Submits a live mutation: the contract validates/classifies/logs it, then a
    /// committed hot mutation is executed so the next frame reflects it. The output is
    /// not restarted.
    pub fn submit(
        &mut self,
        mutation: &SceneMutation,
        ctx: &MutationContext,
        now: &str,
    ) -> LiveEditDecision {
        let decision = self.scene.apply(mutation, ctx, now);
        if decision.committed
            && let Some(op) = decode_op(mutation)
        {
            self.scene.execute_op(&op);
        }
        decision
    }

    /// Renders the next frame from the current committed scene using fake solid-colour
    /// sources (the LS2 deterministic loop).
    pub fn render_next(&mut self) -> RenderedFrame {
        self.frames_rendered += 1;
        composite(
            self.scene.sources(),
            self.scene.revision(),
            self.width,
            self.height,
        )
    }

    /// Renders the next frame from the current committed scene using real per-source
    /// pixel frames (one captured frame per source id). This is what the LS3b session
    /// pipeline drives: capture → `render_frames` → encode.
    pub fn render_frames(&mut self, frames: &HashMap<String, SourceFrame>) -> RenderedFrame {
        self.frames_rendered += 1;
        composite_frames(
            self.scene.sources(),
            frames,
            self.scene.revision(),
            self.width,
            self.height,
        )
    }

    pub fn revision(&self) -> u64 {
        self.scene.revision()
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn frames_rendered(&self) -> u64 {
        self.frames_rendered
    }

    pub fn timeline(&self) -> &[LiveEditEvent] {
        self.scene.events()
    }
}

/// A capture input that feeds one source's frames into the render pipeline as
/// rawvideo. The LS3b session spawns one FFmpeg capture per source.
#[derive(Debug, Clone, PartialEq)]
pub enum CaptureInput {
    /// A synthetic lavfi source (tests / placeholders), e.g. `testsrc2=size=...`.
    Lavfi(String),
    /// A macOS avfoundation video device index (real screen/camera).
    AvFoundationVideo(usize),
}

/// FFmpeg args to capture one source as rgb24 rawvideo at the canvas size, written to
/// stdout. Every capture emits same-size frames so the render loop can read a fixed
/// number of bytes per source per tick and composite them.
pub fn capture_ffmpeg_args(
    input: &CaptureInput,
    width: usize,
    height: usize,
    fps: u32,
) -> Vec<String> {
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
    ];
    match input {
        CaptureInput::Lavfi(pattern) => {
            args.extend([
                "-f".to_string(),
                "lavfi".to_string(),
                "-i".to_string(),
                pattern.clone(),
            ]);
        }
        CaptureInput::AvFoundationVideo(index) => {
            crate::capture_input::append_live_avfoundation_video_input(&mut args, *index, fps);
        }
    }
    args.extend([
        "-vf".to_string(),
        format!("scale={width}:{height},format=rgb24"),
        "-r".to_string(),
        fps.to_string(),
        "-f".to_string(),
        "rawvideo".to_string(),
        "-pix_fmt".to_string(),
        "rgb24".to_string(),
        "pipe:1".to_string(),
    ]);
    args
}

/// FFmpeg args to encode composited rgb24 frames (read from stdin) to a local MKV with
/// the streaming-safe encode: 2-second keyframes + global headers (the same settings
/// proven for the tee fan-out). LS3b-2 adds the `tee` to stream targets on top of this
/// single-output base.
pub fn render_encode_ffmpeg_args(
    width: usize,
    height: usize,
    fps: u32,
    bitrate_kbps: u32,
    output_path: &str,
) -> Vec<String> {
    vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-f".to_string(),
        "rawvideo".to_string(),
        "-pix_fmt".to_string(),
        "rgb24".to_string(),
        "-s".to_string(),
        format!("{width}x{height}"),
        "-r".to_string(),
        fps.to_string(),
        "-i".to_string(),
        "pipe:0".to_string(),
        "-c:v".to_string(),
        "h264_videotoolbox".to_string(),
        "-allow_sw".to_string(),
        "1".to_string(),
        "-realtime".to_string(),
        "1".to_string(),
        "-prio_speed".to_string(),
        "1".to_string(),
        "-b:v".to_string(),
        format!("{bitrate_kbps}k"),
        "-maxrate".to_string(),
        format!("{bitrate_kbps}k"),
        "-bufsize".to_string(),
        format!("{}k", bitrate_kbps.saturating_mul(2)),
        "-g".to_string(),
        fps.saturating_mul(2).to_string(),
        "-force_key_frames".to_string(),
        "expr:gte(t,n_forced*2)".to_string(),
        "-flags".to_string(),
        "+global_header".to_string(),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        output_path.to_string(),
    ]
}

/// FFmpeg args to encode composited rgb24 frames (stdin) and fan them out to a local
/// recording and/or RTMP stream targets via `tee` — the same proven settings as the
/// avfoundation recorder (2s keyframes, `+global_header`, `use_fifo` slave isolation).
/// This is what the LS3b session pipeline uses to record + multistream one composite.
/// Errors only when neither a recording path nor any stream target is supplied.
pub fn render_tee_encode_args(
    width: usize,
    height: usize,
    fps: u32,
    bitrate_kbps: u32,
    output_path: Option<&str>,
    stream_urls: &[String],
) -> Result<Vec<String>, String> {
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-f".to_string(),
        "rawvideo".to_string(),
        "-pix_fmt".to_string(),
        "rgb24".to_string(),
        "-s".to_string(),
        format!("{width}x{height}"),
        "-r".to_string(),
        fps.to_string(),
        "-i".to_string(),
        "pipe:0".to_string(),
        "-c:v".to_string(),
        "h264_videotoolbox".to_string(),
        "-allow_sw".to_string(),
        "1".to_string(),
        "-realtime".to_string(),
        "1".to_string(),
        "-prio_speed".to_string(),
        "1".to_string(),
        "-b:v".to_string(),
        format!("{bitrate_kbps}k"),
        "-maxrate".to_string(),
        format!("{bitrate_kbps}k"),
        "-bufsize".to_string(),
        format!("{}k", bitrate_kbps.saturating_mul(2)),
        "-g".to_string(),
        fps.saturating_mul(2).to_string(),
        "-force_key_frames".to_string(),
        "expr:gte(t,n_forced*2)".to_string(),
        "-flags".to_string(),
        "+global_header".to_string(),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
    ];

    let stream_legs = stream_urls
        .iter()
        .map(|url| {
            format!(
                "[f=flv:onfail=ignore:flvflags=no_duration_filesize]{}",
                escape_tee_render_target(url)
            )
        })
        .collect::<Vec<_>>();

    match (output_path, stream_urls.is_empty()) {
        // Local recording only.
        (Some(path), true) => args.push(path.to_string()),
        // Recording + one or more streams: tee the MKV (onfail=abort) and every flv
        // leg (onfail=ignore so a failing platform can't kill the recording or peers).
        (Some(path), false) => {
            let mut legs = vec![format!(
                "[f=matroska:onfail=abort]{}",
                escape_tee_render_target(path)
            )];
            legs.extend(stream_legs);
            args.extend(tee_render_output_args(legs.join("|")));
        }
        // A single stream with no recording uses a plain flv output.
        (None, false) if stream_urls.len() == 1 => {
            args.extend([
                "-flvflags".to_string(),
                "no_duration_filesize".to_string(),
                "-f".to_string(),
                "flv".to_string(),
                stream_urls[0].clone(),
            ]);
        }
        // Multiple streams with no recording: tee of flv legs only.
        (None, false) => args.extend(tee_render_output_args(stream_legs.join("|"))),
        (None, true) => {
            return Err("render encode needs a recording path or a stream target".to_string());
        }
    }
    Ok(args)
}

/// Wraps a tee spec with the same FIFO slave isolation as the avfoundation recorder so
/// a slow stream target cannot back-pressure the encoder or the recording.
fn tee_render_output_args(spec: String) -> Vec<String> {
    vec![
        "-f".to_string(),
        "tee".to_string(),
        "-use_fifo".to_string(),
        "1".to_string(),
        "-fifo_options".to_string(),
        "queue_size=512:drop_pkts_on_overflow=1".to_string(),
        spec,
    ]
}

/// Escapes a tee slave target (`\ | [ ]`) so a URL/path can't break the filtergraph.
fn escape_tee_render_target(target: &str) -> String {
    target
        .replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace('[', "\\[")
        .replace(']', "\\]")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_scene::{ActiveSceneState, MutationKind, SessionMode};
    use crate::protocol::{
        SceneOutputKind, SceneSourceKind, SceneTransform, default_layout_settings,
    };
    use std::collections::HashMap;

    fn transform(x: f64, y: f64, width: f64, height: f64) -> SceneTransform {
        SceneTransform {
            x,
            y,
            width,
            height,
            crop_left: 0.0,
            crop_top: 0.0,
            crop_right: 0.0,
            crop_bottom: 0.0,
        }
    }

    fn source(id: &str, kind: SceneSourceKind, t: SceneTransform, visible: bool) -> SceneSource {
        SceneSource {
            id: id.to_string(),
            name: id.to_string(),
            kind,
            device_id: None,
            transform: t.clone(),
            default_transform: t,
            visible,
            locked: false,
        }
    }

    /// A screen + camera scene: full-frame screen with a small bottom-right camera.
    fn screen_camera_scene() -> ActiveScene {
        ActiveScene::new(ActiveSceneState {
            session_id: "session-1".to_string(),
            scene_id: "scene:default".to_string(),
            revision: 0,
            layout: default_layout_settings(),
            sources: vec![
                source(
                    "source:base",
                    SceneSourceKind::Screen,
                    transform(0.0, 0.0, 1.0, 1.0),
                    true,
                ),
                source(
                    "source:camera",
                    SceneSourceKind::Camera,
                    transform(0.6, 0.6, 0.3, 0.3),
                    true,
                ),
            ],
            outputs: vec![SceneOutputKind::Recording],
            mode: SessionMode::Recording,
            updated_at: "t0".to_string(),
        })
    }

    fn screen_camera_consumer() -> LiveRenderConsumer {
        LiveRenderConsumer::start(screen_camera_scene(), 32, 32)
    }

    fn transform_mutation(id: &str, expected_revision: u64, x: f64, y: f64) -> SceneMutation {
        SceneMutation {
            id: id.to_string(),
            expected_revision,
            kind: MutationKind::SourceTransformPatch,
            apply_mode: None,
            payload: serde_json::json!({
                "sourceId": "source:camera",
                "transform": { "x": x, "y": y, "width": 0.3, "height": 0.3 },
            }),
            created_at: "t".to_string(),
        }
    }

    #[test]
    fn composite_paints_topmost_visible_source() {
        let consumer = screen_camera_consumer();
        let frame = composite(consumer.scene.sources(), 0, 32, 32);
        // Camera (on top) wins inside its rect; screen wins elsewhere.
        assert_eq!(frame.sample(0.75, 0.75), source_color("source:camera"));
        assert_eq!(frame.sample(0.5, 0.5), source_color("source:base"));
    }

    #[test]
    fn moving_a_source_changes_the_next_frame_without_restart() {
        let mut consumer = screen_camera_consumer();
        let before = consumer.render_next();
        assert_eq!(before.sample(0.75, 0.75), source_color("source:camera"));
        assert_eq!(before.revision, 0);

        // Move the camera to the top-left corner.
        let decision = consumer.submit(
            &transform_mutation("m1", 0, 0.0, 0.0),
            &MutationContext::default(),
            "t1",
        );
        assert!(decision.committed);

        let after = consumer.render_next();
        assert_eq!(after.revision, 1, "the committed revision advanced");
        // Camera now paints the top-left and has left the bottom-right.
        assert_eq!(after.sample(0.1, 0.1), source_color("source:camera"));
        assert_eq!(after.sample(0.75, 0.75), source_color("source:base"));

        // Same consumer instance, no restart.
        assert_eq!(consumer.generation(), 1);
        assert_eq!(consumer.frames_rendered(), 2);
    }

    #[test]
    fn hiding_a_source_removes_it_from_the_frame() {
        let mut consumer = screen_camera_consumer();
        consumer.submit(
            &SceneMutation {
                id: "hide".to_string(),
                expected_revision: 0,
                kind: MutationKind::SourceVisibilitySet,
                apply_mode: None,
                payload: serde_json::json!({ "sourceId": "source:camera", "visible": false }),
                created_at: "t".to_string(),
            },
            &MutationContext::default(),
            "t1",
        );
        let frame = consumer.render_next();
        // Where the camera was now shows the screen beneath it.
        assert_eq!(frame.sample(0.75, 0.75), source_color("source:base"));
        assert_eq!(consumer.generation(), 1);
    }

    #[test]
    fn reordering_changes_which_source_is_on_top() {
        // Two fully-overlapping sources; the later one wins.
        let scene = ActiveScene::new(ActiveSceneState {
            session_id: "session-1".to_string(),
            scene_id: "scene:default".to_string(),
            revision: 0,
            layout: default_layout_settings(),
            sources: vec![
                source(
                    "a",
                    SceneSourceKind::Screen,
                    transform(0.0, 0.0, 1.0, 1.0),
                    true,
                ),
                source(
                    "b",
                    SceneSourceKind::Window,
                    transform(0.0, 0.0, 1.0, 1.0),
                    true,
                ),
            ],
            outputs: vec![SceneOutputKind::Recording],
            mode: SessionMode::Streaming,
            updated_at: "t0".to_string(),
        });
        let mut consumer = LiveRenderConsumer::start(scene, 8, 8);
        assert_eq!(consumer.render_next().sample(0.5, 0.5), source_color("b"));

        // Reorder so "a" is last (on top).
        consumer.submit(
            &SceneMutation {
                id: "reorder".to_string(),
                expected_revision: 0,
                kind: MutationKind::SourceOrderSet,
                apply_mode: None,
                payload: serde_json::json!({ "sourceIds": ["b", "a"] }),
                created_at: "t".to_string(),
            },
            &MutationContext::default(),
            "t1",
        );
        assert_eq!(consumer.render_next().sample(0.5, 0.5), source_color("a"));
        assert_eq!(consumer.generation(), 1);
    }

    #[test]
    fn timeline_records_every_live_edit() {
        let mut consumer = screen_camera_consumer();
        consumer.submit(
            &transform_mutation("m1", 0, 0.0, 0.0),
            &MutationContext::default(),
            "t1",
        );
        consumer.submit(
            &transform_mutation("m2", 1, 0.3, 0.3),
            &MutationContext::default(),
            "t2",
        );
        assert_eq!(consumer.timeline().len(), 2);
        assert!(
            consumer
                .timeline()
                .iter()
                .all(|e| e.session_id == "session-1")
        );
    }

    #[test]
    fn stale_edit_does_not_change_the_frame() {
        let mut consumer = screen_camera_consumer();
        consumer.submit(
            &transform_mutation("m1", 0, 0.0, 0.0),
            &MutationContext::default(),
            "t1",
        );
        // A second edit still expecting revision 0 is stale and is ignored.
        let decision = consumer.submit(
            &transform_mutation("m2", 0, 0.5, 0.5),
            &MutationContext::default(),
            "t2",
        );
        assert!(!decision.accepted);
        let frame = consumer.render_next();
        // Camera stayed where the first (accepted) edit put it: top-left.
        assert_eq!(frame.sample(0.1, 0.1), source_color("source:camera"));
        assert_eq!(frame.revision, 1);
    }

    /// End-to-end render → encode proof (the architectural crux of live editing):
    /// render a screen+camera scene, move the camera halfway through, and pipe the
    /// rgb24 frames to ffmpeg as rawvideo. Confirms a real encoder consumes the live
    /// render output continuously and the recording finalizes, without restart.
    /// Ignored by default (spawns ffmpeg + writes a file); run with `--ignored`.
    #[test]
    #[ignore = "spawns ffmpeg and writes a file; run with --ignored"]
    fn fake_recording_encodes_a_moving_source() {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let (width, height, fps, total_frames) = (320usize, 180usize, 30usize, 60usize);
        let output = std::env::temp_dir().join("videorc-ls2-fake-recording.mkv");
        let _ = std::fs::remove_file(&output);

        let mut child = Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-s",
                &format!("{width}x{height}"),
                "-r",
                &fps.to_string(),
                "-i",
                "pipe:0",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&output)
            .stdin(Stdio::piped())
            .spawn()
            .expect("ffmpeg should be on PATH for this ignored test");

        let mut stdin = child.stdin.take().expect("ffmpeg stdin");
        let mut consumer = LiveRenderConsumer::start(screen_camera_scene(), width, height);
        for frame_index in 0..total_frames {
            if frame_index == total_frames / 2 {
                // Move the camera to the top-left mid-recording, without restarting.
                consumer.submit(
                    &transform_mutation("move", 0, 0.0, 0.0),
                    &MutationContext::default(),
                    "mid",
                );
            }
            let frame = consumer.render_next();
            stdin.write_all(&frame.rgb_bytes()).expect("write frame");
        }
        drop(stdin);

        let status = child.wait().expect("ffmpeg wait");
        assert!(status.success(), "ffmpeg should finalize the recording");
        let size = std::fs::metadata(&output).expect("recording exists").len();
        assert!(size > 0, "the fake recording should contain encoded video");
        assert_eq!(consumer.generation(), 1, "the output never restarted");
    }

    fn frames_map(pairs: &[(&str, SourceFrame)]) -> HashMap<String, SourceFrame> {
        pairs
            .iter()
            .map(|(id, frame)| (id.to_string(), frame.clone()))
            .collect()
    }

    #[test]
    fn composites_real_frames_with_overlay() {
        let sources = vec![
            source(
                "screen",
                SceneSourceKind::Screen,
                transform(0.0, 0.0, 1.0, 1.0),
                true,
            ),
            source(
                "camera",
                SceneSourceKind::Camera,
                transform(0.6, 0.6, 0.3, 0.3),
                true,
            ),
        ];
        let frames = frames_map(&[
            ("screen", SourceFrame::solid(4, 4, [200, 0, 0])),
            ("camera", SourceFrame::solid(2, 2, [0, 200, 0])),
        ]);
        let out = composite_frames(&sources, &frames, 0, 32, 32);
        // Camera (green) wins inside its rect; screen (red) elsewhere.
        assert_eq!(out.sample(0.75, 0.75), [0, 200, 0]);
        assert_eq!(out.sample(0.2, 0.2), [200, 0, 0]);
    }

    #[test]
    fn crop_restricts_the_sampled_region() {
        // A 2x1 source: left red, right blue. Cropping the left half away leaves only
        // blue across the whole output rect.
        let mut sources = vec![source(
            "s",
            SceneSourceKind::Screen,
            transform(0.0, 0.0, 1.0, 1.0),
            true,
        )];
        sources[0].transform.crop_left = 0.5;
        let frames = frames_map(&[(
            "s",
            SourceFrame {
                width: 2,
                height: 1,
                pixels: vec![[200, 0, 0], [0, 0, 200]],
            },
        )]);
        let out = composite_frames(&sources, &frames, 0, 16, 16);
        assert_eq!(out.sample(0.2, 0.5), [0, 0, 200]);
        assert_eq!(out.sample(0.8, 0.5), [0, 0, 200]);
    }

    #[test]
    fn hidden_source_frame_is_skipped() {
        let sources = vec![
            source(
                "screen",
                SceneSourceKind::Screen,
                transform(0.0, 0.0, 1.0, 1.0),
                true,
            ),
            source(
                "camera",
                SceneSourceKind::Camera,
                transform(0.6, 0.6, 0.3, 0.3),
                false,
            ),
        ];
        let frames = frames_map(&[
            ("screen", SourceFrame::solid(2, 2, [200, 0, 0])),
            ("camera", SourceFrame::solid(2, 2, [0, 200, 0])),
        ]);
        let out = composite_frames(&sources, &frames, 0, 16, 16);
        assert_eq!(
            out.sample(0.75, 0.75),
            [200, 0, 0],
            "hidden camera is skipped"
        );
    }

    #[test]
    fn missing_source_frame_is_skipped() {
        let sources = vec![source(
            "camera",
            SceneSourceKind::Camera,
            transform(0.0, 0.0, 1.0, 1.0),
            true,
        )];
        // No frame supplied for "camera" this tick → background, no panic.
        let out = composite_frames(&sources, &HashMap::new(), 0, 8, 8);
        assert_eq!(out.sample(0.5, 0.5), [0, 0, 0]);
    }

    /// End-to-end capture → composite → encode proof (the LS3 architecture): FFmpeg
    /// *captures* a moving test pattern as the screen source (rawvideo to stdout), Rust
    /// reads each frame, composites a synthetic camera overlay that *moves mid-session*,
    /// and pipes the result to a second FFmpeg that *encodes* it. Confirms real
    /// captured frames flow through the Rust compositor to a finalized recording while a
    /// live edit takes effect — no output restart. Ignored by default (spawns two
    /// ffmpeg processes + writes a file); run with `--ignored`.
    #[test]
    #[ignore = "spawns two ffmpeg processes and writes a file; run with --ignored"]
    fn capture_composite_encode_pipeline_applies_a_live_edit() {
        use std::io::{Read, Write};
        use std::process::{Command, Stdio};

        let (width, height, fps, seconds) = (320usize, 180usize, 30usize, 2usize);
        let total_frames = fps * seconds;
        let frame_bytes = width * height * 3;

        // FFmpeg "capture": a moving test pattern stands in for a screen source.
        let mut capture = Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                &format!("testsrc2=size={width}x{height}:rate={fps}"),
                "-t",
                &seconds.to_string(),
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "pipe:1",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("capture ffmpeg should be on PATH for this ignored test");
        let mut capture_out = capture.stdout.take().expect("capture stdout");

        // FFmpeg encoder: composited rgb24 frames in, MKV out.
        let output = std::env::temp_dir().join("videorc-ls3-capture-composite-encode.mkv");
        let _ = std::fs::remove_file(&output);
        let mut encode = Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-s",
                &format!("{width}x{height}"),
                "-r",
                &fps.to_string(),
                "-i",
                "pipe:0",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&output)
            .stdin(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("encode ffmpeg");
        let mut encode_in = encode.stdin.take().expect("encode stdin");

        let mut sources = vec![
            source(
                "source:screen",
                SceneSourceKind::Screen,
                transform(0.0, 0.0, 1.0, 1.0),
                true,
            ),
            source(
                "source:camera",
                SceneSourceKind::Camera,
                transform(0.6, 0.6, 0.3, 0.3),
                true,
            ),
        ];
        let camera = SourceFrame::solid(64, 36, [40, 220, 120]);
        let mut revision = 0u64;
        let mut buffer = vec![0u8; frame_bytes];
        let mut produced = 0usize;

        for index in 0..total_frames {
            if capture_out.read_exact(&mut buffer).is_err() {
                break;
            }
            if index == total_frames / 2 {
                // Move the camera to the top-left corner mid-recording, no restart.
                if let Some(cam) = sources.iter_mut().find(|s| s.id == "source:camera") {
                    cam.transform.x = 0.0;
                    cam.transform.y = 0.0;
                }
                revision += 1;
            }
            let frames = frames_map(&[
                (
                    "source:screen",
                    SourceFrame::from_rgb24(width, height, &buffer),
                ),
                ("source:camera", camera.clone()),
            ]);
            let composed = composite_frames(&sources, &frames, revision, width, height);
            if encode_in.write_all(&composed.rgb_bytes()).is_err() {
                break;
            }
            produced += 1;
        }
        drop(encode_in);
        let _ = capture.wait();
        let status = encode.wait().expect("encode wait");

        assert!(
            status.success(),
            "the encoder should finalize the recording"
        );
        assert_eq!(
            produced, total_frames,
            "every captured frame was composited"
        );
        let size = std::fs::metadata(&output).expect("recording exists").len();
        assert!(size > 0, "the recording should contain encoded video");
    }

    #[test]
    fn render_frames_reflects_a_live_edit() {
        let mut consumer = LiveRenderConsumer::start(screen_camera_scene(), 32, 32);
        let frames = frames_map(&[
            ("source:base", SourceFrame::solid(2, 2, [200, 0, 0])),
            ("source:camera", SourceFrame::solid(2, 2, [0, 200, 0])),
        ]);
        let before = consumer.render_frames(&frames);
        assert_eq!(before.sample(0.75, 0.75), [0, 200, 0]);

        consumer.submit(
            &transform_mutation("m", 0, 0.0, 0.0),
            &MutationContext::default(),
            "t",
        );
        let after = consumer.render_frames(&frames);
        assert_eq!(
            after.sample(0.1, 0.1),
            [0, 200, 0],
            "camera moved to top-left"
        );
        assert_eq!(
            after.sample(0.75, 0.75),
            [200, 0, 0],
            "base shows where camera was"
        );
    }

    #[test]
    fn capture_args_cover_lavfi_and_avfoundation() {
        let lavfi = capture_ffmpeg_args(
            &CaptureInput::Lavfi("testsrc2=size=320x180:rate=30".to_string()),
            320,
            180,
            30,
        );
        assert!(lavfi.windows(2).any(|w| w[0] == "-f" && w[1] == "lavfi"));
        assert!(lavfi.contains(&"testsrc2=size=320x180:rate=30".to_string()));
        assert!(lavfi.contains(&"rawvideo".to_string()) && lavfi.contains(&"pipe:1".to_string()));
        assert!(lavfi.iter().any(|arg| arg.contains("scale=320:180")));

        let av = capture_ffmpeg_args(&CaptureInput::AvFoundationVideo(0), 1920, 1080, 30);
        assert!(
            av.windows(2)
                .any(|w| w[0] == "-f" && w[1] == "avfoundation")
        );
        assert!(av.contains(&"0:none".to_string()));
    }

    #[test]
    fn render_encode_args_use_rawvideo_input_and_keyframes() {
        let args = render_encode_ffmpeg_args(1920, 1080, 30, 6000, "/tmp/out.mkv");
        assert!(args.windows(2).any(|w| w[0] == "-f" && w[1] == "rawvideo"));
        assert!(args.contains(&"pipe:0".to_string()));
        assert!(args.contains(&"h264_videotoolbox".to_string()));
        assert!(args.windows(2).any(|w| w[0] == "-allow_sw" && w[1] == "1"));
        assert!(args.windows(2).any(|w| w[0] == "-g" && w[1] == "60"));
        assert!(
            args.windows(2)
                .any(|w| w[0] == "-force_key_frames" && w[1] == "expr:gte(t,n_forced*2)")
        );
        assert!(
            args.windows(2)
                .any(|w| w[0] == "-flags" && w[1] == "+global_header")
        );
        assert_eq!(args.last().unwrap(), "/tmp/out.mkv");
    }

    #[test]
    fn render_tee_encode_records_only_without_streams() {
        let args = render_tee_encode_args(1280, 720, 30, 4500, Some("/tmp/rec.mkv"), &[]).unwrap();
        assert!(
            !args.contains(&"tee".to_string()),
            "no streams -> plain mkv"
        );
        assert_eq!(args.last().unwrap(), "/tmp/rec.mkv");
    }

    #[test]
    fn render_tee_encode_tees_recording_and_streams() {
        let streams = vec![
            "rtmp://a.rtmp.youtube.com/live2/yt".to_string(),
            "rtmp://live.twitch.tv/app/tw".to_string(),
        ];
        let args =
            render_tee_encode_args(1920, 1080, 30, 6000, Some("/tmp/rec.mkv"), &streams).unwrap();
        assert!(args.contains(&"tee".to_string()));
        let spec = args.iter().find(|a| a.contains("[f=matroska")).unwrap();
        assert!(spec.contains("[f=matroska:onfail=abort]/tmp/rec.mkv"));
        assert_eq!(
            spec.matches("[f=flv:onfail=ignore").count(),
            2,
            "two flv legs: {spec}"
        );
        assert!(spec.contains("/yt") && spec.contains("/tw"));
        // Same proven safeguards as the avfoundation tee.
        assert!(args.windows(2).any(|w| w[0] == "-use_fifo" && w[1] == "1"));
        assert!(
            args.windows(2)
                .any(|w| w[0] == "-flags" && w[1] == "+global_header")
        );
    }

    #[test]
    fn render_tee_encode_stream_only_multi_has_no_recording_leg() {
        let streams = vec!["rtmp://x/app/a".to_string(), "rtmp://y/app/b".to_string()];
        let args = render_tee_encode_args(1280, 720, 30, 4500, None, &streams).unwrap();
        let spec = args.iter().find(|a| a.contains("[f=flv")).unwrap();
        assert!(!spec.contains("[f=matroska"));
        assert_eq!(spec.matches("[f=flv").count(), 2);
    }

    #[test]
    fn render_tee_encode_requires_an_output() {
        assert!(render_tee_encode_args(1280, 720, 30, 4500, None, &[]).is_err());
    }

    /// The realistic LS3b case: two real capture inputs (screen + camera) composited
    /// live, using the actual `capture_ffmpeg_args` / `render_encode_ffmpeg_args`
    /// builders. Reads both captures in lockstep, composites via `render_frames` with a
    /// camera move mid-recording, and encodes. Ignored by default (spawns three ffmpeg
    /// processes + writes a file); run with `--ignored`.
    #[test]
    #[ignore = "spawns three ffmpeg processes and writes a file; run with --ignored"]
    fn two_source_capture_composite_encode_pipeline() {
        use std::io::{Read, Write};
        use std::process::{Command, Stdio};

        let (width, height, fps) = (320usize, 180usize, 30u32);
        let total_frames = 60usize;
        let frame_bytes = width * height * 3;

        let mut screen_cap = Command::new("ffmpeg")
            .args(capture_ffmpeg_args(
                &CaptureInput::Lavfi("testsrc2=size=320x180:rate=30".to_string()),
                width,
                height,
                fps,
            ))
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("screen capture ffmpeg should be on PATH for this ignored test");
        let mut camera_cap = Command::new("ffmpeg")
            .args(capture_ffmpeg_args(
                &CaptureInput::Lavfi("color=c=green:size=320x180:rate=30".to_string()),
                width,
                height,
                fps,
            ))
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("camera capture ffmpeg");
        let mut screen_out = screen_cap.stdout.take().expect("screen stdout");
        let mut camera_out = camera_cap.stdout.take().expect("camera stdout");

        let output = std::env::temp_dir().join("videorc-ls3b-two-source.mkv");
        let _ = std::fs::remove_file(&output);
        let mut encode = Command::new("ffmpeg")
            .args(render_encode_ffmpeg_args(
                width,
                height,
                fps,
                4000,
                output.to_str().expect("output path"),
            ))
            .stdin(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("encode ffmpeg");
        let mut encode_in = encode.stdin.take().expect("encode stdin");

        let mut consumer = LiveRenderConsumer::start(screen_camera_scene(), width, height);
        let mut screen_buf = vec![0u8; frame_bytes];
        let mut camera_buf = vec![0u8; frame_bytes];
        let mut produced = 0usize;

        for index in 0..total_frames {
            if screen_out.read_exact(&mut screen_buf).is_err()
                || camera_out.read_exact(&mut camera_buf).is_err()
            {
                break;
            }
            if index == total_frames / 2 {
                consumer.submit(
                    &transform_mutation("move", 0, 0.0, 0.0),
                    &MutationContext::default(),
                    "mid",
                );
            }
            let frames = frames_map(&[
                (
                    "source:base",
                    SourceFrame::from_rgb24(width, height, &screen_buf),
                ),
                (
                    "source:camera",
                    SourceFrame::from_rgb24(width, height, &camera_buf),
                ),
            ]);
            let composed = consumer.render_frames(&frames);
            if encode_in.write_all(&composed.rgb_bytes()).is_err() {
                break;
            }
            produced += 1;
        }
        drop(encode_in);
        let _ = screen_cap.kill();
        let _ = camera_cap.kill();
        let _ = screen_cap.wait();
        let _ = camera_cap.wait();
        let status = encode.wait().expect("encode wait");

        assert!(
            status.success(),
            "the encoder should finalize the recording"
        );
        assert_eq!(
            produced, total_frames,
            "every paired capture frame was composited"
        );
        let size = std::fs::metadata(&output).expect("recording exists").len();
        assert!(size > 0, "the recording should contain encoded video");
    }
}
