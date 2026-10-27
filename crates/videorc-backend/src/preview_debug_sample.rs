//! Read-only development oracle for the frame handed to the Preview.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::compositor::CompositorFrameStore;
use crate::compositor::preview_frame_lease::presented_frame_store;
use crate::state::AppState;

/// A rectangle in canvas fractions; the oracle reads its middle fifth.
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Rect {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) w: f64,
    pub(crate) h: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Params {
    rects: Vec<Rect>,
}

// Clamp the centred fifth to the canvas, keeping at least one pixel even for
// a rectangle entirely outside it. Reject non-finite and inverted geometry.
fn bounds(rect: Rect, width: usize, height: usize) -> Result<(usize, usize, usize, usize), String> {
    if width == 0
        || height == 0
        || ![rect.x, rect.y, rect.w, rect.h]
            .iter()
            .all(|v| v.is_finite())
        || rect.w <= 0.0
        || rect.h <= 0.0
    {
        return Err("Expected finite rectangles with positive width and height.".into());
    }
    let axis = |start: f64, size: f64, pixels: usize| {
        let lo = ((start + size * 0.4) * pixels as f64)
            .floor()
            .clamp(0.0, (pixels - 1) as f64) as usize;
        let hi = ((start + size * 0.6) * pixels as f64)
            .ceil()
            .clamp((lo + 1) as f64, pixels as f64) as usize;
        (lo, hi)
    };
    let (x0, x1) = axis(rect.x, rect.w, width);
    let (y0, y1) = axis(rect.y, rect.h, height);
    Ok((x0, y0, x1, y1))
}

fn mean(
    rect: Rect,
    width: usize,
    height: usize,
    pixel: impl Fn(usize, usize) -> [u8; 3],
) -> Result<Value, String> {
    let (x0, y0, x1, y1) = bounds(rect, width, height)?;
    let mut sum = [0_u64; 3];
    for y in y0..y1 {
        for x in x0..x1 {
            for (total, value) in sum.iter_mut().zip(pixel(x, y)) {
                *total += u64::from(value);
            }
        }
    }
    let n = ((x1 - x0) * (y1 - y0)) as f64;
    Ok(json!({"r":sum[0] as f64 / n,"g":sum[1] as f64 / n,"b":sum[2] as f64 / n}))
}

#[cfg(any(target_os = "macos", test))]
fn bgra(
    bytes: &[u8],
    stride: usize,
    width: usize,
    height: usize,
    rects: &[Rect],
) -> Result<Vec<Value>, String> {
    if stride < width * 4 || bytes.len() < stride * height {
        return Err("Preview BGRA storage is incomplete.".into());
    }
    rects
        .iter()
        .map(|rect| {
            mean(*rect, width, height, |x, y| {
                let i = y * stride + x * 4;
                [bytes[i + 2], bytes[i + 1], bytes[i]]
            })
        })
        .collect()
}

fn yuv420p(
    bytes: &[u8],
    width: usize,
    height: usize,
    rects: &[Rect],
) -> Result<Vec<Value>, String> {
    let luma = width * height;
    let cw = width.div_ceil(2);
    let chroma = cw * height.div_ceil(2);
    if bytes.len() < luma + 2 * chroma {
        return Err("Preview YUV420p storage is incomplete.".into());
    }
    rects
        .iter()
        .map(|rect| {
            mean(*rect, width, height, |x, y| {
                let uv = (y / 2) * cw + x / 2;
                let (b, g, r) = crate::color::ycbcr_bt709_video_to_bgr(
                    bytes[y * width + x],
                    bytes[luma + uv],
                    bytes[luma + chroma + uv],
                );
                [r, g, b]
            })
        })
        .collect()
}

pub(crate) async fn sample(state: &AppState, params: Value) -> Result<Value, String> {
    let params: Params = serde_json::from_value(params).map_err(|e| e.to_string())?;
    if params.rects.len() > 32 {
        return Err("At most 32 rectangles may be sampled.".into());
    }
    let store = presented_frame_store(&*state.compositor.lock().await);
    sample_frame_store(&store, &params.rects)
}

/// The mean colour of each rect's middle fifth in `store`'s latest frame:
/// the IOSurface on Metal (locked read-only), else the CPU yuv420p frame.
/// The oracle reads the presented store; the compositor's own tests read
/// one leg's store each (plan 205 S6).
pub(crate) fn sample_frame_store(
    store: &CompositorFrameStore,
    rects: &[Rect],
) -> Result<Value, String> {
    // A transient FrameHandle retains storage, never the connection's lease
    // permit. Release the store lock before touching pixels.
    let frame = store
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .latest()
        .ok_or("No Preview frame has been published.")?;
    let width = frame.width as usize;
    let height = frame.height as usize;
    #[cfg(target_os = "macos")]
    if let Some(target) = &frame.metadata.metal_target {
        use objc2_core_video::{
            CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow, CVPixelBufferLockBaseAddress,
            CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
        };
        let buffer = target.pixel_buffer();
        // The retained target is the lease's IOSurface-backed BGRA buffer.
        // CoreVideo's read-only lock synchronizes CPU access to that storage.
        unsafe {
            if CVPixelBufferLockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly) != 0 {
                return Err("Could not lock Preview IOSurface read-only.".into());
            }
            let base = CVPixelBufferGetBaseAddress(buffer);
            let stride = CVPixelBufferGetBytesPerRow(buffer);
            let samples = if base.is_null() {
                Err("Preview IOSurface has no CPU base address.".into())
            } else {
                bgra(
                    std::slice::from_raw_parts(base.cast::<u8>(), stride * height),
                    stride,
                    width,
                    height,
                    rects,
                )
            };
            CVPixelBufferUnlockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly);
            return Ok(
                json!({"frameId":frame.sequence,"width":width,"height":height,"samples":samples?}),
            );
        }
    }
    let samples = yuv420p(&frame.bytes, width, height, rects)?;
    Ok(json!({"frameId":frame.sequence,"width":width,"height":height,"samples":samples}))
}

#[cfg(test)]
mod tests {
    use super::*;
    const FULL: Rect = Rect {
        x: 0.0,
        y: 0.0,
        w: 1.0,
        h: 1.0,
    };

    #[test]
    fn preview_debug_bgra_samples_only_middle_fifth_and_respects_stride() {
        let mut bytes = vec![0; 48 * 10];
        for y in 4..6 {
            for x in 4..6 {
                bytes[y * 48 + x * 4..y * 48 + x * 4 + 4].copy_from_slice(&[20, 40, 200, 255]);
            }
        }
        assert_eq!(
            bgra(&bytes, 48, 10, 10, &[FULL]).unwrap(),
            vec![json!({"r":200.0,"g":40.0,"b":20.0})]
        );
    }

    #[test]
    fn preview_debug_yuv420p_decodes_bt709_and_rejects_short_storage() {
        let mut bytes = vec![63; 100];
        bytes.extend(vec![102; 25]);
        bytes.extend(vec![240; 25]);
        let samples = yuv420p(&bytes, 10, 10, &[FULL]).unwrap();
        assert!(samples[0]["r"].as_f64().unwrap() >= 250.0);
        assert!(samples[0]["b"].as_f64().unwrap() <= 4.0);
        assert!(yuv420p(&bytes[..149], 10, 10, &[FULL]).is_err());
    }

    #[test]
    fn preview_debug_rect_clamping_and_validation() {
        assert_eq!(
            bounds(
                Rect {
                    x: -4.0,
                    y: 2.0,
                    ..FULL
                },
                10,
                10
            )
            .unwrap(),
            (0, 9, 1, 10)
        );
        assert!(bounds(Rect { w: 0.0, ..FULL }, 10, 10).is_err());
        assert!(
            bounds(
                Rect {
                    x: f64::NAN,
                    ..FULL
                },
                10,
                10
            )
            .is_err()
        );
    }
}
