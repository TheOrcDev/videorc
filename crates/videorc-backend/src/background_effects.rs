//! A scene background picture's Blur, Saturation, Dim and Vignette, applied
//! once to the decoded picture so every program path (Metal, D3D11 and the
//! CPU fallback) draws the same graded pixels. The colour math is the D3D11
//! `ScenePs` grade with a neutral camera look; the vignette is centred on the
//! picture, not on the output frame. Live backgrounds are never graded here:
//! their Dim belongs to the live runtime.

use crate::protocol::EffectiveSceneBackground;

/// The UI offers 0-40 px; anything past this is clamped.
const MAX_BLUR_PX: f32 = 64.0;
const BOX_BLUR_PASSES: usize = 3;
const LUMA_WEIGHTS: [f32; 3] = [0.2126, 0.7152, 0.0722];
/// Steps per unit the controls are quantized to: hundredths of a blur pixel,
/// ten-thousandths of the saturation, dim and vignette factors. The cache
/// key prints exactly these digits.
const BLUR_STEPS: f32 = 100.0;
const GRADE_STEPS: f32 = 10_000.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct BackgroundPictureEffects {
    /// Gaussian sigma in picture pixels.
    blur_px: f32,
    /// 1.0 is unchanged, 0.0 is grey.
    saturation: f32,
    dim: f32,
    vignette: f32,
}

impl BackgroundPictureEffects {
    /// The grade a picture background asks for, or `None` when it is a live
    /// background or every control sits at its neutral value.
    pub(crate) fn for_background(background: &EffectiveSceneBackground) -> Option<Self> {
        if background.live.is_some() {
            return None;
        }
        // Quantized once, so the cache key and the grade read the same values.
        let effects = Self {
            blur_px: quantize(
                control(background.blur_px, 0.0, 0.0, f64::from(MAX_BLUR_PX)),
                BLUR_STEPS,
            ),
            saturation: quantize(
                control(background.saturation_percent, 100.0, 0.0, 200.0) / 100.0,
                GRADE_STEPS,
            ),
            dim: quantize(
                control(background.dim_percent, 0.0, 0.0, 100.0) / 100.0,
                GRADE_STEPS,
            ),
            vignette: quantize(
                control(background.vignette_percent, 0.0, 0.0, 100.0) / 100.0,
                GRADE_STEPS,
            ),
        };
        (!effects.is_neutral()).then_some(effects)
    }

    fn is_neutral(&self) -> bool {
        self.blur_px <= 0.01 && self.saturation == 1.0 && self.dim == 0.0 && self.vignette == 0.0
    }

    /// Appended to the picture's image-cache key, so a changed control misses
    /// the cache and the regraded picture gets a fresh content revision.
    pub(crate) fn cache_key_suffix(&self) -> String {
        format!(
            ":fx:b{:.2}:s{:.4}:d{:.4}:v{:.4}",
            self.blur_px, self.saturation, self.dim, self.vignette
        )
    }
}

fn control(value: f64, neutral: f64, min: f64, max: f64) -> f32 {
    let value = if value.is_finite() { value } else { neutral };
    value.clamp(min, max) as f32
}

fn quantize(value: f32, steps: f32) -> f32 {
    (value * steps).round() / steps
}

/// Grade a straight RGBA picture in place: blur, then saturation, dim and
/// vignette in the D3D11 shader's order. Alpha is blurred but never graded.
pub(crate) fn apply_background_picture_effects(
    rgba: &mut [u8],
    width: u32,
    height: u32,
    effects: BackgroundPictureEffects,
) {
    let (width, height) = (width as usize, height as usize);
    if width == 0 || height == 0 || rgba.len() != width * height * 4 {
        return;
    }
    if effects.blur_px > 0.01 {
        gaussian_blur(rgba, width, height, effects.blur_px);
    }
    if effects.saturation == 1.0 && effects.dim == 0.0 && effects.vignette == 0.0 {
        return;
    }
    let dim_scale = (1.0 - effects.dim).clamp(0.0, 1.0);
    let squared_offsets = |count: usize| -> Vec<f32> {
        (0..count)
            .map(|index| {
                let offset = (index as f32 + 0.5) / count as f32 - 0.5;
                offset * offset
            })
            .collect()
    };
    let column_offsets = squared_offsets(width);
    let row_offsets = squared_offsets(height);
    for (y, row) in rgba.chunks_exact_mut(width * 4).enumerate() {
        for (x, pixel) in row.chunks_exact_mut(4).enumerate() {
            let vignette = (1.0 - (column_offsets[x] + row_offsets[y]) * effects.vignette * 2.8)
                .clamp(0.0, 1.0);
            let rgb = [
                f32::from(pixel[0]) / 255.0,
                f32::from(pixel[1]) / 255.0,
                f32::from(pixel[2]) / 255.0,
            ];
            let luma =
                rgb[0] * LUMA_WEIGHTS[0] + rgb[1] * LUMA_WEIGHTS[1] + rgb[2] * LUMA_WEIGHTS[2];
            for (channel, value) in pixel.iter_mut().take(3).zip(rgb) {
                let graded = (luma + effects.saturation * (value - luma)).clamp(0.0, 1.0);
                *channel = (graded * dim_scale * vignette * 255.0).round() as u8;
            }
        }
    }
}

/// Three box passes per axis approximate a Gaussian of `sigma` (the widths
/// whose summed variance is closest to sigma squared).
fn box_blur_widths(sigma: f32) -> [usize; BOX_BLUR_PASSES] {
    let passes = BOX_BLUR_PASSES as f32;
    let variance = 12.0 * sigma * sigma;
    let mut lower = (variance / passes + 1.0).sqrt().floor() as i64;
    if lower % 2 == 0 {
        lower -= 1;
    }
    let lower = lower.max(1);
    let lower_f = lower as f32;
    let lower_count =
        ((variance - passes * lower_f * lower_f - 4.0 * passes * lower_f - 3.0 * passes)
            / (-4.0 * lower_f - 4.0))
            .round()
            .clamp(0.0, passes) as usize;
    std::array::from_fn(|pass| {
        if pass < lower_count {
            lower as usize
        } else {
            lower as usize + 2
        }
    })
}

fn gaussian_blur(rgba: &mut [u8], width: usize, height: usize, sigma: f32) {
    let mut scratch = vec![0u8; rgba.len()];
    for box_width in box_blur_widths(sigma) {
        let radius = (box_width - 1) / 2;
        if radius == 0 {
            continue;
        }
        box_blur_lines(rgba, &mut scratch, height, width, width * 4, 4, radius);
        box_blur_lines(&scratch, rgba, width, height, 4, width * 4, radius);
    }
}

/// One box pass along every line of an RGBA image, clamping at the edges
/// like the GPU's clamp sampler. `line_step` and `pixel_step` are byte
/// strides, so rows and columns share this loop.
fn box_blur_lines(
    source: &[u8],
    target: &mut [u8],
    lines: usize,
    line_len: usize,
    line_step: usize,
    pixel_step: usize,
    radius: usize,
) {
    let window = (2 * radius + 1) as u32;
    let last = line_len - 1;
    for line in 0..lines {
        let base = line * line_step;
        for channel in 0..4 {
            let at =
                |index: usize| u32::from(source[base + index.min(last) * pixel_step + channel]);
            let mut sum = at(0) * radius as u32;
            for index in 0..=radius {
                sum += at(index);
            }
            for index in 0..line_len {
                target[base + index * pixel_step + channel] = ((sum + window / 2) / window) as u8;
                sum += at(index + radius + 1);
                sum -= at(index.saturating_sub(radius));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{
        BackgroundFit, LiveBackgroundId, LiveBackgroundMotion, LiveBackgroundSpec,
    };

    fn background() -> EffectiveSceneBackground {
        EffectiveSceneBackground {
            asset_id: "asset".into(),
            managed_asset_path: "/tmp/asset.webp".into(),
            fit: BackgroundFit::Fill,
            scale: 100.0,
            offset_x: 0.0,
            offset_y: 0.0,
            blur_px: 0.0,
            dim_percent: 0.0,
            saturation_percent: 100.0,
            vignette_percent: 0.0,
            visibility_percent: 20.0,
            live: None,
        }
    }

    fn effects(blur_px: f32, saturation: f32, dim: f32, vignette: f32) -> BackgroundPictureEffects {
        BackgroundPictureEffects {
            blur_px,
            saturation,
            dim,
            vignette,
        }
    }

    fn solid(width: usize, height: usize, pixel: [u8; 4]) -> Vec<u8> {
        pixel.repeat(width * height)
    }

    #[test]
    fn neutral_controls_and_live_backgrounds_grade_nothing() {
        assert_eq!(
            BackgroundPictureEffects::for_background(&background()),
            None
        );
        let mut live = background();
        live.dim_percent = 40.0;
        live.blur_px = 12.0;
        live.live = Some(LiveBackgroundSpec {
            id: LiveBackgroundId::Silk,
            look: "satin".to_string(),
            motion: LiveBackgroundMotion::Calm,
        });
        assert_eq!(BackgroundPictureEffects::for_background(&live), None);
    }

    #[test]
    fn controls_map_from_percent_and_clamp_non_finite_values_to_neutral() {
        let mut graded = background();
        graded.blur_px = 500.0;
        graded.saturation_percent = 50.0;
        graded.dim_percent = 20.0;
        graded.vignette_percent = f64::NAN;
        assert_eq!(
            BackgroundPictureEffects::for_background(&graded),
            Some(effects(MAX_BLUR_PX, 0.5, 0.2, 0.0))
        );
        let mut broken = background();
        broken.saturation_percent = f64::INFINITY;
        broken.dim_percent = f64::NAN;
        assert_eq!(BackgroundPictureEffects::for_background(&broken), None);
    }

    #[test]
    fn values_that_share_a_cache_key_share_the_blur_kernel() {
        let with_blur = |blur_px: f64| {
            let mut graded = background();
            graded.blur_px = blur_px;
            BackgroundPictureEffects::for_background(&graded).unwrap()
        };
        let (low, high) = (with_blur(0.576), with_blur(0.579));
        assert_eq!(low.cache_key_suffix(), high.cache_key_suffix());
        assert_eq!(low, high);
        assert_eq!(low.blur_px, 0.58);
        assert_eq!(box_blur_widths(low.blur_px), box_blur_widths(high.blur_px));
        let mut faint = background();
        faint.blur_px = 0.004;
        faint.dim_percent = 0.004;
        assert_eq!(BackgroundPictureEffects::for_background(&faint), None);
    }

    #[test]
    fn each_distinct_grade_gets_its_own_cache_key_suffix() {
        let suffixes = [
            effects(8.0, 1.0, 0.0, 0.0),
            effects(0.0, 0.5, 0.0, 0.0),
            effects(0.0, 1.0, 0.3, 0.0),
            effects(0.0, 1.0, 0.0, 0.3),
        ]
        .map(|effects| effects.cache_key_suffix());
        for (index, suffix) in suffixes.iter().enumerate() {
            assert!(suffix.starts_with(":fx:"));
            assert!(suffixes[index + 1..].iter().all(|other| other != suffix));
        }
    }

    #[test]
    fn zero_saturation_is_the_shader_luma() {
        let mut pixels = solid(1, 1, [255, 0, 0, 255]);
        apply_background_picture_effects(&mut pixels, 1, 1, effects(0.0, 0.0, 0.0, 0.0));
        // 0.2126 * 255 = 54.2
        assert_eq!(pixels, [54, 54, 54, 255]);
    }

    #[test]
    fn over_saturation_pushes_away_from_luma_and_clamps() {
        let mut pixels = solid(1, 1, [200, 100, 100, 255]);
        apply_background_picture_effects(&mut pixels, 1, 1, effects(0.0, 1.5, 0.0, 0.0));
        // luma 0.4755: red 0.4755 + 1.5 * 0.3088 = 0.9387, green and blue
        // 0.4755 - 1.5 * 0.0834 = 0.3505.
        assert_eq!(pixels, [239, 89, 89, 255]);
        let mut pixels = solid(1, 1, [250, 10, 10, 255]);
        apply_background_picture_effects(&mut pixels, 1, 1, effects(0.0, 2.0, 0.0, 0.0));
        assert_eq!(pixels, [255, 0, 0, 255]);
    }

    #[test]
    fn dim_scales_colour_and_leaves_alpha() {
        let mut pixels = solid(1, 1, [200, 100, 50, 180]);
        apply_background_picture_effects(&mut pixels, 1, 1, effects(0.0, 1.0, 0.5, 0.0));
        assert_eq!(pixels, [100, 50, 25, 180]);
    }

    #[test]
    fn vignette_darkens_corners_by_the_shader_falloff_and_spares_the_centre() {
        let mut pixels = solid(3, 3, [200, 200, 200, 255]);
        apply_background_picture_effects(&mut pixels, 3, 3, effects(0.0, 1.0, 0.0, 1.0));
        // Centre texel: uv (0.5, 0.5), no falloff.
        assert_eq!(&pixels[16..20], &[200, 200, 200, 255]);
        // Corner texel: uv (1/6, 1/6), 1 - (2/9) * 2.8 = 0.3778.
        assert_eq!(&pixels[0..4], &[76, 76, 76, 255]);
        // Edge texel: uv (0.5, 1/6), 1 - (1/9) * 2.8 = 0.6889.
        assert_eq!(&pixels[4..8], &[138, 138, 138, 255]);
    }

    #[test]
    fn box_widths_approximate_the_gaussian_variance() {
        for sigma in [1.0f32, 4.0, 8.0, 20.0, 40.0, MAX_BLUR_PX] {
            let widths = box_blur_widths(sigma);
            assert!(widths.iter().all(|width| width % 2 == 1));
            let variance: f32 = widths
                .iter()
                .map(|&width| ((width * width) as f32 - 1.0) / 12.0)
                .sum();
            assert!(
                (variance.sqrt() - sigma).abs() <= sigma * 0.1 + 0.5,
                "sigma {sigma} got {}",
                variance.sqrt()
            );
        }
    }

    #[test]
    fn blur_keeps_a_flat_picture_flat() {
        let mut pixels = solid(17, 9, [90, 140, 30, 255]);
        apply_background_picture_effects(&mut pixels, 17, 9, effects(6.0, 1.0, 0.0, 0.0));
        assert_eq!(pixels, solid(17, 9, [90, 140, 30, 255]));
    }

    #[test]
    fn blur_spreads_a_point_symmetrically_and_keeps_its_energy() {
        let size = 41;
        let mut pixels = solid(size, size, [0, 0, 0, 255]);
        let centre = (size / 2 * size + size / 2) * 4;
        pixels[centre..centre + 3].copy_from_slice(&[255, 255, 255]);
        let mut wide = pixels.clone();
        apply_background_picture_effects(
            &mut pixels,
            size as u32,
            size as u32,
            effects(2.0, 1.0, 0.0, 0.0),
        );
        apply_background_picture_effects(
            &mut wide,
            size as u32,
            size as u32,
            effects(4.0, 1.0, 0.0, 0.0),
        );
        let red = |image: &[u8], x: usize, y: usize| image[(y * size + x) * 4];
        let c = size / 2;
        assert!(red(&pixels, c, c) < 255);
        assert!(red(&pixels, c, c) > red(&wide, c, c));
        for offset in 1..4 {
            assert_eq!(red(&pixels, c - offset, c), red(&pixels, c + offset, c));
            assert_eq!(red(&pixels, c, c - offset), red(&pixels, c, c + offset));
        }
        assert!(red(&pixels, c + 2, c) > 0);
        let energy: u32 = (0..size * size)
            .map(|index| u32::from(pixels[index * 4]))
            .sum();
        assert!((200..=310).contains(&energy), "energy {energy}");
        assert!((0..size * size).all(|index| pixels[index * 4 + 3] == 255));
    }

    #[test]
    fn mismatched_buffers_are_left_untouched() {
        let mut pixels = solid(2, 2, [10, 20, 30, 255]);
        apply_background_picture_effects(&mut pixels, 3, 2, effects(4.0, 0.0, 0.5, 1.0));
        assert_eq!(pixels, solid(2, 2, [10, 20, 30, 255]));
    }
}
