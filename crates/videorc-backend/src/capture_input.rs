//! Per-platform ffmpeg capture-input construction.
//!
//! The one seam that knows which ffmpeg input device backs a Videorc source
//! on each platform: macOS today (`-f avfoundation` video, CoreAudio→FIFO or
//! `-f avfoundation` audio), with the Windows arms (`-f ddagrab` screens,
//! `-f dshow` cameras/microphones) landing here per
//! docs/windows-port-plan.md Phase 2. Output and encode argument chains stay
//! with their pipelines — only device inputs live in this module.

use std::path::PathBuf;

use crate::audio::{
    NATIVE_AUDIO_CHANNELS, NATIVE_AUDIO_FFMPEG_QUEUE_SIZE, NATIVE_AUDIO_SAMPLE_RATE,
};

pub const AVFOUNDATION_VIDEO_PIXEL_FORMAT: &str = "nv12";
pub const WINDOWS_DDAGRAB_PIXEL_FORMAT: &str = "bgra";

/// The primary video source a recording session captures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoInput {
    MacScreen {
        index: usize,
    },
    MacCamera {
        index: usize,
    },
    #[allow(dead_code)]
    WindowsScreen {
        backend: WindowsScreenCaptureBackend,
    },
    #[allow(dead_code)]
    WindowsCamera {
        device_name: String,
    },
    TestPattern,
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowsScreenCaptureBackend {
    Ddagrab { output_index: u32 },
    GdiGrabDesktop,
}

/// The microphone source feeding a session, in preference order: the native
/// capture path (CoreAudio today, WASAPI on Windows later) writing PCM to a
/// FIFO, or ffmpeg capturing the device directly as the fallback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MicrophoneInput {
    CoreAudio {
        device_id: u32,
        fifo_path: Option<PathBuf>,
    },
    AvFoundation {
        index: usize,
    },
    #[allow(dead_code)]
    WindowsDshow {
        device_name: String,
    },
}

// DirectShow otherwise uses the device's default audio buffer, commonly around
// 500ms. That made Windows recordings start with roughly half a second less
// audio than video and could deliver speech in audible bursts under encoder
// load. Keep enough cushion for consumer USB microphones without carrying the
// device-default latency into the recording pipeline.
const WINDOWS_DSHOW_AUDIO_BUFFER_MS: u32 = 100;

/// Low-latency session capture input for a screen or camera device
/// (macOS: avfoundation). The cursor is only meaningful for screens.
pub fn append_avfoundation_video_input(
    args: &mut Vec<String>,
    device_index: usize,
    fps: u32,
    capture_cursor: bool,
) {
    args.extend([
        "-fflags".to_string(),
        "nobuffer".to_string(),
        "-flags".to_string(),
        "low_delay".to_string(),
        "-probesize".to_string(),
        "32".to_string(),
        "-analyzeduration".to_string(),
        "0".to_string(),
        "-thread_queue_size".to_string(),
        "16".to_string(),
        "-f".to_string(),
        "avfoundation".to_string(),
        "-pixel_format".to_string(),
        AVFOUNDATION_VIDEO_PIXEL_FORMAT.to_string(),
        "-framerate".to_string(),
        fps.to_string(),
    ]);
    if capture_cursor {
        args.extend(["-capture_cursor".to_string(), "1".to_string()]);
    }
    args.extend(["-i".to_string(), format!("{device_index}:none")]);
}

pub fn append_windows_screen_video_input(
    args: &mut Vec<String>,
    backend: &WindowsScreenCaptureBackend,
    fps: u32,
    capture_cursor: bool,
) {
    args.extend([
        "-fflags".to_string(),
        "nobuffer".to_string(),
        "-flags".to_string(),
        "low_delay".to_string(),
        "-probesize".to_string(),
        "32".to_string(),
        "-analyzeduration".to_string(),
        "0".to_string(),
        "-thread_queue_size".to_string(),
        "16".to_string(),
    ]);
    match backend {
        WindowsScreenCaptureBackend::Ddagrab { output_index } => {
            args.extend([
                "-f".to_string(),
                "lavfi".to_string(),
                "-i".to_string(),
                format!(
                    "ddagrab=output_idx={output_index}:draw_mouse={}:framerate={fps},hwdownload,format={WINDOWS_DDAGRAB_PIXEL_FORMAT}",
                    ffmpeg_bool(capture_cursor)
                ),
            ]);
        }
        WindowsScreenCaptureBackend::GdiGrabDesktop => {
            args.extend([
                "-f".to_string(),
                "gdigrab".to_string(),
                "-framerate".to_string(),
                fps.to_string(),
                "-draw_mouse".to_string(),
                ffmpeg_bool(capture_cursor).to_string(),
                "-i".to_string(),
                "desktop".to_string(),
            ]);
        }
    }
}

pub fn append_windows_dshow_video_input(args: &mut Vec<String>, device_name: &str, fps: u32) {
    append_windows_dshow_video_input_opts(args, device_name, Some(fps));
}

/// dshow video input with an OPTIONAL requested framerate. Passing `None`
/// drops `-framerate`, letting dshow negotiate the device's default format —
/// the retry path for cameras whose default format does not match an exact
/// requested rate (a common zero-frames cause: dshow rejects `-framerate 30`
/// on a webcam that only offers, say, MJPEG@25 and never starts).
pub fn append_windows_dshow_video_input_opts(
    args: &mut Vec<String>,
    device_name: &str,
    fps: Option<u32>,
) {
    args.extend([
        "-fflags".to_string(),
        "nobuffer".to_string(),
        "-flags".to_string(),
        "low_delay".to_string(),
        "-probesize".to_string(),
        "32".to_string(),
        "-analyzeduration".to_string(),
        "0".to_string(),
        "-thread_queue_size".to_string(),
        "16".to_string(),
        "-f".to_string(),
        "dshow".to_string(),
    ]);
    if let Some(fps) = fps {
        args.extend(["-framerate".to_string(), fps.to_string()]);
    }
    args.extend(["-i".to_string(), format!("video={device_name}")]);
}

/// Appends the session's microphone input. The native-FIFO arm is
/// platform-neutral (raw f32le from a path — any native capture source can
/// feed it); the direct-device arm is the per-platform piece.
pub fn append_microphone_input(
    args: &mut Vec<String>,
    microphone: Option<&MicrophoneInput>,
    next_input_index: &mut usize,
) -> bool {
    let Some(microphone) = microphone else {
        return false;
    };

    match microphone {
        MicrophoneInput::CoreAudio {
            fifo_path: Some(fifo_path),
            ..
        } => {
            args.extend([
                "-f".to_string(),
                "f32le".to_string(),
                "-ar".to_string(),
                NATIVE_AUDIO_SAMPLE_RATE.to_string(),
                "-ac".to_string(),
                NATIVE_AUDIO_CHANNELS.to_string(),
                "-thread_queue_size".to_string(),
                NATIVE_AUDIO_FFMPEG_QUEUE_SIZE.to_string(),
                "-i".to_string(),
                fifo_path.display().to_string(),
            ]);
            *next_input_index += 1;
            true
        }
        MicrophoneInput::CoreAudio {
            fifo_path: None, ..
        } => false,
        MicrophoneInput::AvFoundation { index } => {
            args.extend([
                "-f".to_string(),
                "avfoundation".to_string(),
                "-thread_queue_size".to_string(),
                "512".to_string(),
                "-i".to_string(),
                format!(":{index}"),
            ]);
            *next_input_index += 1;
            true
        }
        MicrophoneInput::WindowsDshow { device_name } => {
            args.extend([
                "-f".to_string(),
                "dshow".to_string(),
                "-audio_buffer_size".to_string(),
                WINDOWS_DSHOW_AUDIO_BUFFER_MS.to_string(),
                "-thread_queue_size".to_string(),
                "512".to_string(),
                "-i".to_string(),
                format!("audio={device_name}"),
            ]);
            *next_input_index += 1;
            true
        }
    }
}

/// Whether this microphone's gain/mute must be applied in the ffmpeg filter
/// graph. The native CoreAudio path applies gain/mute in-process before
/// samples reach the FIFO, so adding a graph filter there would double-apply.
/// The Windows dshow mic is captured raw by ffmpeg and has no in-process
/// stage — without a volume leg the mute toggle records live audio. (The
/// macOS avfoundation fallback shares that gap today; it keeps its shipped
/// behavior until it gets its own slice.)
pub fn microphone_needs_graph_gain(microphone: Option<&MicrophoneInput>) -> bool {
    matches!(microphone, Some(MicrophoneInput::WindowsDshow { .. }))
}

pub fn microphone_channels(microphone: Option<&MicrophoneInput>) -> u16 {
    match microphone {
        Some(MicrophoneInput::CoreAudio { .. }) => NATIVE_AUDIO_CHANNELS,
        Some(MicrophoneInput::AvFoundation { .. }) => 1,
        Some(MicrophoneInput::WindowsDshow { .. }) => NATIVE_AUDIO_CHANNELS,
        None => 0,
    }
}

/// Live-render capture input for a camera device (macOS: avfoundation).
/// Plainer than the session input on purpose: the live render loop scales
/// and paces frames itself, so none of the low-latency input tuning applies.
pub fn append_live_avfoundation_video_input(args: &mut Vec<String>, device_index: usize, fps: u32) {
    args.extend([
        "-f".to_string(),
        "avfoundation".to_string(),
        "-framerate".to_string(),
        fps.to_string(),
        "-i".to_string(),
        format!("{device_index}:none"),
    ]);
}

fn ffmpeg_bool(value: bool) -> &'static str {
    if value { "1" } else { "0" }
}

// Arg order is the contract: ffmpeg input flags must precede their `-i`, and
// the Windows arms (ddagrab/dshow, windows-port-plan Phase 2) get the same
// exact-vector treatment.
#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn session_video_input_args_for_screen_include_cursor_capture() {
        let mut args = Vec::new();
        append_avfoundation_video_input(&mut args, 3, 30, true);
        assert_eq!(
            args,
            strings(&[
                "-fflags",
                "nobuffer",
                "-flags",
                "low_delay",
                "-probesize",
                "32",
                "-analyzeduration",
                "0",
                "-thread_queue_size",
                "16",
                "-f",
                "avfoundation",
                "-pixel_format",
                AVFOUNDATION_VIDEO_PIXEL_FORMAT,
                "-framerate",
                "30",
                "-capture_cursor",
                "1",
                "-i",
                "3:none",
            ])
        );
    }

    #[test]
    fn session_video_input_args_for_camera_omit_cursor_capture() {
        let mut args = Vec::new();
        append_avfoundation_video_input(&mut args, 0, 60, false);
        assert!(!args.contains(&"-capture_cursor".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("0:none"));
        assert_eq!(args[args.len() - 2], "-i");
    }

    #[test]
    fn windows_ddagrab_screen_input_downloads_bgra_frames() {
        let mut args = Vec::new();
        append_windows_screen_video_input(
            &mut args,
            &WindowsScreenCaptureBackend::Ddagrab { output_index: 2 },
            30,
            true,
        );

        assert_eq!(
            args,
            strings(&[
                "-fflags",
                "nobuffer",
                "-flags",
                "low_delay",
                "-probesize",
                "32",
                "-analyzeduration",
                "0",
                "-thread_queue_size",
                "16",
                "-f",
                "lavfi",
                "-i",
                "ddagrab=output_idx=2:draw_mouse=1:framerate=30,hwdownload,format=bgra",
            ])
        );
    }

    #[test]
    fn windows_gdigrab_screen_input_can_disable_cursor_capture() {
        let mut args = Vec::new();
        append_windows_screen_video_input(
            &mut args,
            &WindowsScreenCaptureBackend::GdiGrabDesktop,
            15,
            false,
        );

        assert_eq!(
            args,
            strings(&[
                "-fflags",
                "nobuffer",
                "-flags",
                "low_delay",
                "-probesize",
                "32",
                "-analyzeduration",
                "0",
                "-thread_queue_size",
                "16",
                "-f",
                "gdigrab",
                "-framerate",
                "15",
                "-draw_mouse",
                "0",
                "-i",
                "desktop",
            ])
        );
    }

    #[test]
    fn windows_dshow_camera_input_uses_video_device_name() {
        let mut args = Vec::new();
        append_windows_dshow_video_input(&mut args, "USB Camera", 60);

        assert_eq!(
            args,
            strings(&[
                "-fflags",
                "nobuffer",
                "-flags",
                "low_delay",
                "-probesize",
                "32",
                "-analyzeduration",
                "0",
                "-thread_queue_size",
                "16",
                "-f",
                "dshow",
                "-framerate",
                "60",
                "-i",
                "video=USB Camera",
            ])
        );
    }

    #[test]
    fn windows_dshow_camera_input_omits_framerate_for_default_format_retry() {
        let mut args = Vec::new();
        append_windows_dshow_video_input_opts(&mut args, "USB Camera", None);

        // The retry path must not pass -framerate (dshow negotiates the
        // device default), but everything else stays identical.
        assert!(!args.iter().any(|arg| arg == "-framerate"));
        assert_eq!(args.last().map(String::as_str), Some("video=USB Camera"));
        assert!(args.windows(2).any(|pair| pair == ["-f", "dshow"]));
    }

    #[test]
    fn native_fifo_microphone_args_use_native_audio_constants() {
        let fifo_path = PathBuf::from("/tmp/videorc-audio-test.f32le");
        let microphone = MicrophoneInput::CoreAudio {
            device_id: 42,
            fifo_path: Some(fifo_path.clone()),
        };
        let mut args = Vec::new();
        let mut next_input_index = 5;

        let appended = append_microphone_input(&mut args, Some(&microphone), &mut next_input_index);

        assert!(appended);
        assert_eq!(next_input_index, 6);
        assert_eq!(
            args,
            vec![
                "-f".to_string(),
                "f32le".to_string(),
                "-ar".to_string(),
                NATIVE_AUDIO_SAMPLE_RATE.to_string(),
                "-ac".to_string(),
                NATIVE_AUDIO_CHANNELS.to_string(),
                "-thread_queue_size".to_string(),
                NATIVE_AUDIO_FFMPEG_QUEUE_SIZE.to_string(),
                "-i".to_string(),
                fifo_path.display().to_string(),
            ]
        );
    }

    #[test]
    fn coreaudio_microphone_without_fifo_appends_nothing() {
        let microphone = MicrophoneInput::CoreAudio {
            device_id: 42,
            fifo_path: None,
        };
        let mut args = Vec::new();
        let mut next_input_index = 5;

        let appended = append_microphone_input(&mut args, Some(&microphone), &mut next_input_index);

        assert!(!appended);
        assert!(args.is_empty());
        assert_eq!(next_input_index, 5);
    }

    #[test]
    fn avfoundation_microphone_fallback_args() {
        let microphone = MicrophoneInput::AvFoundation { index: 2 };
        let mut args = Vec::new();
        let mut next_input_index = 0;

        let appended = append_microphone_input(&mut args, Some(&microphone), &mut next_input_index);

        assert!(appended);
        assert_eq!(next_input_index, 1);
        assert_eq!(
            args,
            strings(&[
                "-f",
                "avfoundation",
                "-thread_queue_size",
                "512",
                "-i",
                ":2",
            ])
        );
    }

    #[test]
    fn windows_dshow_microphone_args_negotiate_device_shape_before_output_normalization() {
        let microphone = MicrophoneInput::WindowsDshow {
            device_name: "Microphone Array".to_string(),
        };
        let mut args = Vec::new();
        let mut next_input_index = 2;

        let appended = append_microphone_input(&mut args, Some(&microphone), &mut next_input_index);

        assert!(appended);
        assert_eq!(next_input_index, 3);
        assert_eq!(
            args,
            vec![
                "-f".to_string(),
                "dshow".to_string(),
                "-audio_buffer_size".to_string(),
                WINDOWS_DSHOW_AUDIO_BUFFER_MS.to_string(),
                "-thread_queue_size".to_string(),
                "512".to_string(),
                "-i".to_string(),
                "audio=Microphone Array".to_string(),
            ]
        );
    }

    #[test]
    fn absent_microphone_appends_nothing() {
        let mut args = Vec::new();
        let mut next_input_index = 1;

        let appended = append_microphone_input(&mut args, None, &mut next_input_index);

        assert!(!appended);
        assert!(args.is_empty());
        assert_eq!(next_input_index, 1);
    }

    #[test]
    fn microphone_channels_per_variant() {
        let coreaudio = MicrophoneInput::CoreAudio {
            device_id: 1,
            fifo_path: None,
        };
        let avfoundation = MicrophoneInput::AvFoundation { index: 0 };
        let dshow = MicrophoneInput::WindowsDshow {
            device_name: "Microphone Array".to_string(),
        };

        assert_eq!(microphone_channels(Some(&coreaudio)), NATIVE_AUDIO_CHANNELS);
        assert_eq!(microphone_channels(Some(&avfoundation)), 1);
        assert_eq!(microphone_channels(Some(&dshow)), NATIVE_AUDIO_CHANNELS);
        assert_eq!(microphone_channels(None), 0);
    }

    #[test]
    fn live_video_input_args_are_plain() {
        let mut args = Vec::new();
        append_live_avfoundation_video_input(&mut args, 0, 30);
        assert_eq!(
            args,
            strings(&["-f", "avfoundation", "-framerate", "30", "-i", "0:none"])
        );
    }
}
