//! A slow camera (issue #1066, #1271/#1277): a live camera can deliver half
//! its rate for minutes (a webcam's auto exposure stretches each frame in low
//! light) while Sources says Receiving. The camera row and Health say so once
//! the measured rate stays low, and go back once it stays recovered. Two
//! lines and two holds, so a rate near the line never flickers.
//! `lib/camera-frame-rate.ts`, word for word.

use serde_json::Value;

/// Under this share of the expected rate, the camera is slow.
pub const LOW_FPS_RATIO: f64 = 0.8;
/// At or over this share, a slow camera has recovered.
pub const RECOVERED_FPS_RATIO: f64 = 0.9;
/// How long the rate stays low before the row says so.
pub const LOW_FPS_HOLD_MS: u64 = 5_000;
/// How long a slow camera stays recovered before the row goes back.
pub const RECOVERED_FPS_HOLD_MS: u64 = 3_000;

/// What the camera row says about a slow camera (`CameraLowFrameRate`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraLowFrameRate {
    /// The mean measured rate while it has been low.
    pub fps: f64,
    /// The rate the camera runs at ([`camera_expected_fps`]).
    pub expected_fps: f64,
}

/// `CameraFrameRateWatch`: the camera and rate this watch is about (either
/// changing starts over), the low and recovered spans, and the verdict.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CameraFrameRateWatch {
    pub camera_id: Option<String>,
    pub expected_fps: Option<f64>,
    pub low_since_ms: Option<u64>,
    pub recovered_since_ms: Option<u64>,
    pub low_fps_sum: f64,
    pub low_samples: u32,
    /// Set while the row says the camera is slow.
    pub low: Option<CameraLowFrameRate>,
}

fn positive(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|fps| fps.is_finite() && *fps > 0.0)
}

/// `cameraExpectedFps`: the requested rate, capped by what the selected
/// format can do. A format that can't reach the request is the format
/// shortfall's news, not a slow camera.
pub fn camera_expected_fps(status: &Value) -> Option<f64> {
    [
        positive(status.get("targetFps")),
        positive(status.get("selectedFormatMaxFps")),
    ]
    .into_iter()
    .flatten()
    .reduce(f64::min)
}

/// `nextCameraFrameRateWatch`: one `preview.camera.status` sample (about
/// four a second), applied. Pure.
pub fn next_camera_frame_rate_watch(
    watch: &CameraFrameRateWatch,
    status: &Value,
    now_ms: u64,
) -> CameraFrameRateWatch {
    let expected_fps = camera_expected_fps(status);
    let fps = status
        .get("sourceFps")
        .and_then(Value::as_f64)
        .filter(|fps| fps.is_finite());
    // A camera that sends nothing has its own chip (plan 216 D2).
    let (Some(expected_fps), Some(fps)) = (expected_fps, fps) else {
        return CameraFrameRateWatch::default();
    };
    if status.get("state").and_then(Value::as_str) != Some("live")
        || status.get("noVideo") == Some(&Value::Bool(true))
    {
        return CameraFrameRateWatch::default();
    }
    let camera_id = status
        .get("cameraId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let idle = CameraFrameRateWatch::default();
    let current = if watch.camera_id == camera_id && watch.expected_fps == Some(expected_fps) {
        watch
    } else {
        &idle
    };
    let fresh = CameraFrameRateWatch {
        camera_id,
        expected_fps: Some(expected_fps),
        ..CameraFrameRateWatch::default()
    };
    if fps < expected_fps * LOW_FPS_RATIO {
        let low_since_ms = current.low_since_ms.unwrap_or(now_ms);
        let low_fps_sum = current.low_fps_sum + fps;
        let low_samples = current.low_samples + 1;
        let low = (current.low.is_some() || now_ms.saturating_sub(low_since_ms) >= LOW_FPS_HOLD_MS)
            .then(|| CameraLowFrameRate {
                fps: low_fps_sum / f64::from(low_samples),
                expected_fps,
            });
        return CameraFrameRateWatch {
            low_since_ms: Some(low_since_ms),
            low_fps_sum,
            low_samples,
            low,
            ..fresh
        };
    }
    // Not slow yet: any sample over the line starts the low span over.
    if current.low.is_none() {
        return fresh;
    }
    if fps >= expected_fps * RECOVERED_FPS_RATIO {
        let recovered_since_ms = current.recovered_since_ms.unwrap_or(now_ms);
        return if now_ms.saturating_sub(recovered_since_ms) >= RECOVERED_FPS_HOLD_MS {
            fresh
        } else {
            CameraFrameRateWatch {
                recovered_since_ms: Some(recovered_since_ms),
                ..current.clone()
            }
        };
    }
    // Between the lines: still slow, and recovery starts over.
    CameraFrameRateWatch {
        recovered_since_ms: None,
        ..current.clone()
    }
}

/// JavaScript's `Math.round` for the rates shown.
fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

/// `cameraLowFrameRateLine`: "C920 is sending 15 of 30 fps. More light
/// usually helps." With Low-light compensation on, the camera may be trading
/// frames for exposure on purpose, so the line names the switch.
pub fn camera_low_frame_rate_line(
    name: Option<&str>,
    low: CameraLowFrameRate,
    low_light_compensation: bool,
) -> String {
    let expected = js_round(low.expected_fps);
    let name = name.map(str::trim).filter(|name| !name.is_empty());
    let sending = format!(
        "{} is sending {} of {expected} fps.",
        name.unwrap_or("Your camera"),
        js_round(low.fps)
    );
    if low_light_compensation {
        format!("{sending} Turning off Low-light compensation can bring it back to {expected} fps.")
    } else {
        format!("{sending} More light usually helps.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample(fps: f64) -> Value {
        json!({"state": "live", "cameraId": "cam", "targetFps": 30, "selectedFormatMaxFps": 60, "sourceFps": fps})
    }

    #[test]
    fn the_expected_rate_is_the_request_capped_by_the_format() {
        assert_eq!(
            camera_expected_fps(&json!({"targetFps": 30, "selectedFormatMaxFps": 24})),
            Some(24.0)
        );
        assert_eq!(camera_expected_fps(&json!({"targetFps": 30})), Some(30.0));
        assert_eq!(camera_expected_fps(&json!({"targetFps": 0})), None);
    }

    #[test]
    fn a_rate_held_low_for_five_seconds_reads_slow_and_three_recovered_clear_it() {
        let mut watch = CameraFrameRateWatch::default();
        for at in [0, 1_000, 4_999] {
            watch = next_camera_frame_rate_watch(&watch, &sample(15.0), at);
            assert_eq!(watch.low, None, "{at}");
        }
        watch = next_camera_frame_rate_watch(&watch, &sample(15.0), 5_000);
        assert_eq!(
            watch.low,
            Some(CameraLowFrameRate {
                fps: 15.0,
                expected_fps: 30.0
            })
        );
        // Between the lines: still slow.
        watch = next_camera_frame_rate_watch(&watch, &sample(25.0), 6_000);
        assert!(watch.low.is_some());
        // Recovered for 3 s: back.
        watch = next_camera_frame_rate_watch(&watch, &sample(29.0), 7_000);
        assert!(watch.low.is_some());
        watch = next_camera_frame_rate_watch(&watch, &sample(29.0), 10_000);
        assert_eq!(watch.low, None);
        // Another camera, or not live, starts over.
        let other = json!({"state": "live", "cameraId": "other", "targetFps": 30, "sourceFps": 15});
        assert_eq!(
            next_camera_frame_rate_watch(&watch, &other, 11_000).low_samples,
            1
        );
        let stopped =
            json!({"state": "stopped", "cameraId": "cam", "targetFps": 30, "sourceFps": 15});
        assert_eq!(
            next_camera_frame_rate_watch(&watch, &stopped, 11_000),
            CameraFrameRateWatch::default()
        );
    }

    #[test]
    fn the_line_names_the_camera_and_the_switch() {
        let low = CameraLowFrameRate {
            fps: 14.6,
            expected_fps: 30.0,
        };
        assert_eq!(
            camera_low_frame_rate_line(Some(" C920 "), low, false),
            "C920 is sending 15 of 30 fps. More light usually helps."
        );
        assert_eq!(
            camera_low_frame_rate_line(None, low, true),
            "Your camera is sending 15 of 30 fps. Turning off Low-light compensation can bring it back to 30 fps."
        );
    }
}
