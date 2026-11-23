//! LS3b-2: the threaded live session render pipeline.
//!
//! Brings the LS3b-1 pieces into one runnable engine: it spawns one FFmpeg capture
//! per source plus one FFmpeg encoder, then runs a render thread that reads a frame
//! from each capture in lockstep, composites them through a shared
//! [`LiveRenderConsumer`] (so live edits applied via [`LiveSessionPipeline::apply_edit`]
//! take effect on the next frame), and writes the result to the encoder's stdin.
//!
//! This is the engine in isolation — it is not yet wired into `start_session` / the
//! protocol (LS3b-3), and a single MKV is the only output (the `tee` fan-out to stream
//! targets is layered on in LS3b-3). Hence `allow(dead_code)` for now.
#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use crate::live_render::{CaptureInput, LiveRenderConsumer, SourceFrame, capture_ffmpeg_args};
use crate::live_scene::{
    ActiveScene, LiveEditDecision, LiveEditEvent, MutationContext, SceneMutation,
};
use crate::process_job::spawn_owned_std;

/// The canvas the pipeline renders at. Every capture is scaled to this size so the
/// render loop can read fixed-size frames.
#[derive(Debug, Clone, Copy)]
pub struct RenderConfig {
    pub width: usize,
    pub height: usize,
    pub fps: u32,
}

/// One capture feeding a specific scene source.
#[derive(Debug, Clone)]
pub struct CaptureSpec {
    pub source_id: String,
    pub input: CaptureInput,
}

/// A running capture → composite → encode pipeline with a live-mutable scene.
pub struct LiveSessionPipeline {
    consumer: Arc<Mutex<LiveRenderConsumer>>,
    captures: Vec<Child>,
    encode: Child,
    stop: Arc<AtomicBool>,
    render_thread: Option<JoinHandle<()>>,
}

impl LiveSessionPipeline {
    /// Spawns the captures + encoder and starts the render thread. `encode_args` is the
    /// caller-built encoder command (see `render_encode_ffmpeg_args`); `max_frames`
    /// bounds the run for tests (`None` runs until [`LiveSessionPipeline::stop`]).
    pub fn start(
        ffmpeg_path: &str,
        scene: ActiveScene,
        captures: Vec<CaptureSpec>,
        encode_args: Vec<String>,
        config: RenderConfig,
        max_frames: Option<usize>,
    ) -> io::Result<Self> {
        let mut capture_children = Vec::with_capacity(captures.len());
        let mut capture_streams: Vec<(String, ChildStdout)> = Vec::with_capacity(captures.len());
        for spec in &captures {
            let mut command = Command::new(ffmpeg_path);
            command
                .args(capture_ffmpeg_args(
                    &spec.input,
                    config.width,
                    config.height,
                    config.fps,
                ))
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            match spawn_owned_std(&mut command) {
                Ok(mut child) => {
                    let stdout = child.stdout.take().expect("capture stdout is piped");
                    capture_streams.push((spec.source_id.clone(), stdout));
                    capture_children.push(child);
                }
                Err(error) => {
                    // Don't leak already-spawned captures on a partial start.
                    for child in &mut capture_children {
                        let _ = child.kill();
                    }
                    return Err(error);
                }
            }
        }

        let mut command = Command::new(ffmpeg_path);
        command
            .args(&encode_args)
            .stdin(Stdio::piped())
            .stderr(Stdio::null());
        let mut encode = spawn_owned_std(&mut command)?;
        let encode_in = encode.stdin.take().expect("encode stdin is piped");

        let consumer = Arc::new(Mutex::new(LiveRenderConsumer::start(
            scene,
            config.width,
            config.height,
        )));
        let stop = Arc::new(AtomicBool::new(false));

        let render_thread = {
            let consumer = Arc::clone(&consumer);
            let stop = Arc::clone(&stop);
            std::thread::spawn(move || {
                render_loop(
                    capture_streams,
                    encode_in,
                    consumer,
                    stop,
                    config.width,
                    config.height,
                    max_frames,
                );
            })
        };

        Ok(Self {
            consumer,
            captures: capture_children,
            encode,
            stop,
            render_thread: Some(render_thread),
        })
    }

    /// Applies a live edit to the shared scene; the render thread reflects it on the
    /// next frame. No output restart.
    pub fn apply_edit(
        &self,
        mutation: &SceneMutation,
        ctx: &MutationContext,
        now: &str,
    ) -> LiveEditDecision {
        self.consumer
            .lock()
            .expect("consumer mutex poisoned")
            .submit(mutation, ctx, now)
    }

    pub fn revision(&self) -> u64 {
        self.consumer.lock().expect("consumer mutex").revision()
    }

    pub fn frames_rendered(&self) -> u64 {
        self.consumer
            .lock()
            .expect("consumer mutex")
            .frames_rendered()
    }

    pub fn timeline(&self) -> Vec<LiveEditEvent> {
        self.consumer
            .lock()
            .expect("consumer mutex")
            .timeline()
            .to_vec()
    }

    /// Signals the render loop to stop, finalizes the encoder, and waits for every
    /// process. Use this for a live (unbounded) session.
    pub fn stop(&mut self) -> io::Result<ExitStatus> {
        self.stop.store(true, Ordering::SeqCst);
        // Kill the captures so a render thread blocked on `read_exact` unblocks.
        for capture in &mut self.captures {
            let _ = capture.kill();
        }
        self.join_and_wait()
    }

    /// Waits for the render loop to finish on its own (capture EOF or `max_frames`),
    /// then finalizes. Used by bounded tests.
    pub fn finish(&mut self) -> io::Result<ExitStatus> {
        self.join_and_wait()
    }

    fn join_and_wait(&mut self) -> io::Result<ExitStatus> {
        if let Some(handle) = self.render_thread.take() {
            let _ = handle.join();
        }
        // The render thread dropped the encoder's stdin on exit, so the encoder sees
        // EOF and finalizes. Reap the (possibly still-running) captures first.
        for capture in &mut self.captures {
            let _ = capture.kill();
            let _ = capture.wait();
        }
        self.encode.wait()
    }
}

impl Drop for LiveSessionPipeline {
    fn drop(&mut self) {
        // Best-effort teardown if the pipeline is dropped without stop()/finish().
        self.stop.store(true, Ordering::SeqCst);
        for capture in &mut self.captures {
            let _ = capture.kill();
        }
        if let Some(handle) = self.render_thread.take() {
            let _ = handle.join();
        }
        let _ = self.encode.kill();
        let _ = self.encode.wait();
    }
}

fn render_loop(
    mut captures: Vec<(String, ChildStdout)>,
    mut encode_in: ChildStdin,
    consumer: Arc<Mutex<LiveRenderConsumer>>,
    stop: Arc<AtomicBool>,
    width: usize,
    height: usize,
    max_frames: Option<usize>,
) {
    let frame_bytes = width * height * 3;
    let mut buffers: Vec<Vec<u8>> = (0..captures.len())
        .map(|_| vec![0u8; frame_bytes])
        .collect();
    let mut rendered = 0usize;

    while !stop.load(Ordering::SeqCst) {
        if max_frames.is_some_and(|max| rendered >= max) {
            break;
        }

        // Read one frame from every capture in lockstep.
        let mut read_failed = false;
        for (index, (_, stdout)) in captures.iter_mut().enumerate() {
            if stdout.read_exact(&mut buffers[index]).is_err() {
                read_failed = true;
                break;
            }
        }
        if read_failed {
            break;
        }

        let mut frames = HashMap::with_capacity(captures.len());
        for (index, (source_id, _)) in captures.iter().enumerate() {
            frames.insert(
                source_id.clone(),
                SourceFrame::from_rgb24(width, height, &buffers[index]),
            );
        }

        let composed = {
            let mut consumer = consumer.lock().expect("consumer mutex poisoned");
            consumer.render_frames(&frames)
        };
        if encode_in.write_all(&composed.rgb_bytes()).is_err() {
            break;
        }
        rendered += 1;
    }
    // `encode_in` is dropped here → the encoder sees EOF and finalizes the file.
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_render::render_encode_ffmpeg_args;
    use crate::live_scene::{ActiveSceneState, LiveEditStatus, MutationKind, SessionMode};
    use crate::protocol::{
        SceneOutputKind, SceneSource, SceneSourceKind, SceneTransform, default_layout_settings,
    };

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

    fn source(id: &str, kind: SceneSourceKind, t: SceneTransform) -> SceneSource {
        SceneSource {
            id: id.to_string(),
            name: id.to_string(),
            kind,
            device_id: None,
            transform: t.clone(),
            default_transform: t,
            visible: true,
            locked: false,
        }
    }

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
                ),
                source(
                    "source:camera",
                    SceneSourceKind::Camera,
                    transform(0.6, 0.6, 0.3, 0.3),
                ),
            ],
            outputs: vec![SceneOutputKind::Recording],
            mode: SessionMode::Recording,
            updated_at: "t0".to_string(),
        })
    }

    fn move_camera_mutation() -> SceneMutation {
        SceneMutation {
            id: "move-camera".to_string(),
            expected_revision: 0,
            kind: MutationKind::SourceTransformPatch,
            apply_mode: None,
            payload: serde_json::json!({
                "sourceId": "source:camera",
                "transform": { "x": 0.0, "y": 0.0, "width": 0.3, "height": 0.3 },
            }),
            created_at: "t".to_string(),
        }
    }

    /// End-to-end engine proof: the threaded pipeline reads two real lavfi captures,
    /// composites them live, applies a camera move via `apply_edit`, and finalizes a
    /// valid recording — all on one `LiveSessionPipeline` instance (no restart).
    /// Ignored by default (spawns three ffmpeg processes + a thread); run with
    /// `--ignored`.
    #[test]
    #[ignore = "spawns three ffmpeg processes and a render thread; run with --ignored"]
    fn pipeline_runs_and_applies_a_live_edit() {
        // The encoder `ffmpeg` ships: no bundled build has VideoToolbox off
        // macOS or libx264 anywhere (#1635).
        let Some(encoder) = crate::repair::probe_repair_encoder("ffmpeg") else {
            eprintln!(
                "pipeline_runs_and_applies_a_live_edit: skipped, ffmpeg on PATH has no H.264 encoder"
            );
            return;
        };
        let config = RenderConfig {
            width: 320,
            height: 180,
            fps: 30,
        };
        let output = std::env::temp_dir().join("videorc-ls3b2-pipeline.mkv");
        let _ = std::fs::remove_file(&output);

        let captures = vec![
            CaptureSpec {
                source_id: "source:base".to_string(),
                input: CaptureInput::Lavfi("testsrc2=size=320x180:rate=30".to_string()),
            },
            CaptureSpec {
                source_id: "source:camera".to_string(),
                input: CaptureInput::Lavfi("color=c=green:size=320x180:rate=30".to_string()),
            },
        ];
        let encode_args = render_encode_ffmpeg_args(
            encoder,
            config.width,
            config.height,
            config.fps,
            4000,
            output.to_str().expect("output path"),
        );

        let mut pipeline = LiveSessionPipeline::start(
            "ffmpeg",
            screen_camera_scene(),
            captures,
            encode_args,
            config,
            Some(60),
        )
        .expect("pipeline should start (ffmpeg on PATH)");

        // Apply a live edit; it lands within the first rendered frames.
        let decision =
            pipeline.apply_edit(&move_camera_mutation(), &MutationContext::default(), "mid");
        assert!(decision.committed, "the hot edit should commit");

        let status = pipeline.finish().expect("pipeline finishes");
        assert!(
            status.success(),
            "the encoder should finalize the recording"
        );

        assert!(
            pipeline
                .timeline()
                .iter()
                .any(|event| event.status == LiveEditStatus::Applied),
            "the live edit is on the session timeline"
        );
        assert!(
            pipeline.frames_rendered() > 0,
            "the render loop produced frames"
        );
        let size = std::fs::metadata(&output).expect("recording exists").len();
        assert!(size > 0, "the recording should contain encoded video");
    }
}
