//! Plan 233 S0: the keyer's edge oracle.
//!
//! The owner's 0.22.1 stream keyed a 3840×2160 camera into the 720×405 Large
//! slot of a 1080p canvas: every output pixel covers 5.3 × 5.3 camera texels,
//! and the keyer judged one bilinear tap per output pixel on a picture it
//! never averaged. Along the subject's outline that left green specks in a
//! new place every frame ("snow") and a hard edge that flipped between kept
//! and keyed out from frame to frame ("the crawl").
//!
//! This module builds the plan's seeded synthetic 4K frame (the shape of its
//! `synth_subject.py`: a skin head with a hair cap and a black shirt on a lit
//! green screen, a σ 1.2 lens blur, 4:2:2 chroma, seeded camera noise and a
//! sub-texel shift per frame), draws it into the Large slot through a render
//! path, and measures three things against the exact area-average reference:
//! green on the outline, alpha flips between two shifted frames, and detail.
//! The numbers of the shipped blit are pinned so the thresholds (10 % of
//! today's green and flips, 90 % of the area reference's detail) are absolute.
//!
//! The footage this models stays out of the repo; the frame here is synthetic.

use super::*;
use crate::color::ycbcr_bt709_video_to_bgr;
use crate::scene_geometry::{chroma_key_alpha_rgb, chroma_key_despill};

pub(super) const CAMERA_WIDTH: u32 = 3840;
pub(super) const CAMERA_HEIGHT: u32 = 2160;
/// `scene_geometry::camera_box_size(Large, Rectangle, Source)` × 1.5, the
/// Large slot on a 1080p canvas.
pub(super) const SLOT_WIDTH: u32 = 720;
pub(super) const SLOT_HEIGHT: u32 = 405;

/// Camera noise per frame: luma per texel, chroma per 2×2 block (4:2:0).
const LUMA_NOISE_SIGMA: f32 = 1.5;
const CHROMA_NOISE_SIGMA: f32 = 1.5;
/// The flat colour under the camera (a dark UI), like the plan's simulation.
const BACKGROUND_GREY: u8 = 16;

/// Green on the outline and alpha flips per frame of the SHIPPED paths
/// (`origin/main` ed0cc2b10: the key judged per output pixel on one bilinear
/// tap's colour), measured by this module on 2026-11-13 on the owner's Mac.
/// The thresholds are 10 % of these. Green is counted on the YUV420p the CPU
/// blit writes (one chroma sample per 2×2 block), and on the BGRA the Metal
/// compositor renders, so the two paths' counts are not the same number.
pub(super) const SHIPPED_CPU_OUTLINE_GREEN_PER_FRAME: f64 = 22.0;
pub(super) const SHIPPED_CPU_OUTLINE_FLIPS_PER_FRAME: f64 = 58.0;
pub(super) const SHIPPED_METAL_OUTLINE_GREEN_PER_FRAME: f64 = 30.0;
pub(super) const SHIPPED_METAL_OUTLINE_FLIPS_PER_FRAME: f64 = 59.0;
/// The share of the shipped snow a path may keep (plan 233 S0).
pub(super) const ALLOWED_SHARE_OF_SHIPPED: f64 = 0.10;
/// The share of the exact area reference's detail a path must keep.
pub(super) const REQUIRED_SHARE_OF_AREA_DETAIL: f64 = 0.90;

/// A seeded xorshift64* stream with a Box–Muller normal.
struct Rng {
    state: u64,
    spare: Option<f32>,
}

impl Rng {
    fn new(seed: u64) -> Self {
        // SplitMix64 to spread a small seed over the state.
        let mut z = seed.wrapping_add(0x9e37_79b9_7f4a_7c15);
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        Self {
            state: (z ^ (z >> 31)) | 1,
            spare: None,
        }
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    /// Uniform in [0, 1).
    fn uniform(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }

    fn normal(&mut self, sigma: f32) -> f32 {
        if let Some(spare) = self.spare.take() {
            return spare * sigma;
        }
        let u1 = self.uniform().max(1e-7);
        let u2 = self.uniform();
        let radius = (-2.0 * u1.ln()).sqrt();
        let theta = std::f32::consts::TAU * u2;
        self.spare = Some(radius * theta.sin());
        radius * theta.cos() * sigma
    }
}

/// The clean synthetic camera frame: RGB, 3 bytes per texel, row-major.
pub(super) struct SyntheticCamera {
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) rgb: Vec<u8>,
}

impl SyntheticCamera {
    /// The plan's `synth_subject.py` at `width`×`height`.
    pub(super) fn build(width: u32, height: u32) -> Self {
        let (w, h) = (width as usize, height as usize);
        let skin = [196.0f32, 146.0, 118.0];
        let hair = [104.0f32, 74.0, 56.0];
        let shirt = [20.0f32, 20.0, 22.0];
        let arm = [28.0f32, 28.0, 30.0];
        let mut img = vec![[0.0f32; 3]; w * h];
        img.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
            let v = y as f32 / height as f32;
            for (x, texel) in row.iter_mut().enumerate() {
                let u = x as f32 / width as f32;
                // The screen gets darker to the right, like the owner's take.
                let fall = 1.0 - 0.45 * u;
                let mut colour = [40.0 * fall, 150.0 * fall, 72.0 * fall];
                let head = ((u - 0.40) / 0.085).powi(2) + ((v - 0.30) / 0.21).powi(2) <= 1.0;
                let hair_cap = head && v < 0.18 + 0.03 * ((u - 0.40) * 30.0).cos();
                let torso = v > 0.47
                    && (u - 0.40).abs() < 0.30 - 0.18 * ((0.62 - v) / 0.15).clamp(0.0, 1.0);
                let mic_arm = ((v - 0.95) + 1.2 * (u - 0.78)).abs() < 0.006 && u > 0.70;
                if torso {
                    colour = shirt;
                }
                if head {
                    colour = skin;
                }
                if hair_cap {
                    colour = hair;
                }
                if mic_arm {
                    colour = arm;
                }
                *texel = colour;
            }
        });
        // Lens blur: a separable Gaussian, σ 1.2 texels, radius 4, edges repeat.
        let radius = 4usize;
        let kernel: Vec<f32> = {
            let raw: Vec<f32> = (0..=2 * radius)
                .map(|i| (-0.5 * ((i as f32 - radius as f32) / 1.2).powi(2)).exp())
                .collect();
            let sum: f32 = raw.iter().sum();
            raw.into_iter().map(|k| k / sum).collect()
        };
        let mut across = vec![[0.0f32; 3]; w * h];
        across
            .par_chunks_mut(w)
            .zip(img.par_chunks(w))
            .for_each(|(out, row)| {
                for (x, texel) in out.iter_mut().enumerate() {
                    let mut sum = [0.0f32; 3];
                    for (i, k) in kernel.iter().enumerate() {
                        let sx = (x + i).saturating_sub(radius).min(w - 1);
                        for c in 0..3 {
                            sum[c] += k * row[sx][c];
                        }
                    }
                    *texel = sum;
                }
            });
        img.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
            for (x, texel) in row.iter_mut().enumerate() {
                let mut sum = [0.0f32; 3];
                for (i, k) in kernel.iter().enumerate() {
                    let sy = (y + i).saturating_sub(radius).min(h - 1);
                    let source = across[sy * w + x];
                    for c in 0..3 {
                        sum[c] += k * source[c];
                    }
                }
                *texel = sum;
            }
        });
        drop(across);
        // 4:2:2: average chroma over horizontal pairs, keep per-texel luma
        // (the camera's native `2vuy` before AVFoundation hands BGRA over).
        let mut rgb = vec![0u8; w * h * 3];
        rgb.par_chunks_mut(w * 3)
            .zip(img.par_chunks(w))
            .for_each(|(out, row)| {
                let ycc = |[r, g, b]: [f32; 3]| {
                    let y = 0.299 * r + 0.587 * g + 0.114 * b;
                    (y, (b - y) * 0.564, (r - y) * 0.713)
                };
                for pair in 0..w.div_ceil(2) {
                    let x0 = pair * 2;
                    let x1 = (x0 + 1).min(w - 1);
                    let (y0, cb0, cr0) = ycc(row[x0]);
                    let (y1, cb1, cr1) = ycc(row[x1]);
                    let (cb, cr) = (0.5 * (cb0 + cb1), 0.5 * (cr0 + cr1));
                    for (x, y) in [(x0, y0), (x1, y1)] {
                        let r = y + 1.403 * cr;
                        let g = y - 0.344 * cb - 0.714 * cr;
                        let b = y + 1.773 * cb;
                        for (c, value) in [r, g, b].into_iter().enumerate() {
                            out[x * 3 + c] = value.round().clamp(0.0, 255.0) as u8;
                        }
                    }
                }
            });
        Self { width, height, rgb }
    }

    /// The clean frame as RGBA (alpha 255), no shift and no noise.
    pub(super) fn clean_rgba(&self) -> Vec<u8> {
        self.rgb
            .chunks_exact(3)
            .flat_map(|rgb| [rgb[0], rgb[1], rgb[2], 255])
            .collect()
    }

    /// Frame `index` as the camera would deliver it: the picture moved by a
    /// seeded 0–2 texel sub-texel shift (micro-motion), plus luma noise per
    /// texel and chroma noise per 2×2 block. RGBA, alpha 255.
    pub(super) fn noisy_rgba(&self, index: u64) -> Vec<u8> {
        let (w, h) = (self.width as usize, self.height as usize);
        let mut seed_rng = Rng::new(11 + index);
        let (dx, dy) = (seed_rng.uniform() * 2.0, seed_rng.uniform() * 2.0);
        let (sx, sy) = (dx.floor() as usize, dy.floor() as usize);
        let (fx, fy) = (dx - sx as f32, dy - sy as f32);
        let base = |x: isize, y: isize| -> [f32; 3] {
            let x = x.clamp(0, w as isize - 1) as usize;
            let y = y.clamp(0, h as isize - 1) as usize;
            let i = (y * w + x) * 3;
            [
                f32::from(self.rgb[i]),
                f32::from(self.rgb[i + 1]),
                f32::from(self.rgb[i + 2]),
            ]
        };
        let mut out = vec![0u8; w * h * 4];
        out.par_chunks_mut(w * 4 * 2)
            .enumerate()
            .for_each(|(pair, rows)| {
                let mut luma_rng = Rng::new(0x1000 + index * 0x10000 + pair as u64);
                let mut chroma_rng = Rng::new(0x2000_0000 + index * 0x10000 + pair as u64);
                let chroma_noise: Vec<(f32, f32)> = (0..w.div_ceil(2))
                    .map(|_| {
                        (
                            chroma_rng.normal(CHROMA_NOISE_SIGMA),
                            chroma_rng.normal(CHROMA_NOISE_SIGMA),
                        )
                    })
                    .collect();
                for (row_in_pair, row) in rows.chunks_exact_mut(w * 4).enumerate() {
                    let y = (pair * 2 + row_in_pair) as isize;
                    for x in 0..w {
                        // The shifted picture: content moves down and right
                        // by (dx, dy), bilinear for the fraction.
                        let xi = x as isize - sx as isize;
                        let yi = y - sy as isize;
                        let mut colour = [0.0f32; 3];
                        for (ox, wx) in [(0, 1.0 - fx), (-1, fx)] {
                            for (oy, wy) in [(0, 1.0 - fy), (-1, fy)] {
                                let s = base(xi + ox, yi + oy);
                                for c in 0..3 {
                                    colour[c] += wx * wy * s[c];
                                }
                            }
                        }
                        let ny = luma_rng.normal(LUMA_NOISE_SIGMA);
                        let (ncb, ncr) = chroma_noise[x / 2];
                        let r = colour[0] + ny + 1.402 * ncr;
                        let g = colour[1] + ny - 0.344 * ncb - 0.714 * ncr;
                        let b = colour[2] + ny + 1.772 * ncb;
                        let o = x * 4;
                        row[o] = r.round().clamp(0.0, 255.0) as u8;
                        row[o + 1] = g.round().clamp(0.0, 255.0) as u8;
                        row[o + 2] = b.round().clamp(0.0, 255.0) as u8;
                        row[o + 3] = 255;
                    }
                }
            });
        out
    }
}

/// The owner's settings: Key out background with the defaults.
pub(super) fn default_key_spec() -> ChromaKeySpec {
    let mut layout = crate::protocol::default_layout_settings();
    layout.camera_chroma_key_enabled = true;
    camera_chroma_key(&layout).expect("keying enabled")
}

/// A render path's picture of the slot: straight RGB in 0..=255 units and
/// the alpha it drew the camera with, per output pixel.
pub(super) struct Rendered {
    pub(super) width: usize,
    pub(super) height: usize,
    pub(super) rgb: Vec<[f32; 3]>,
    pub(super) alpha: Vec<f32>,
}

/// Where the true outline is: output pixels within 2 px of a partially
/// covered pixel of the clean frame's exact area-averaged coverage.
pub(super) struct Outline {
    pub(super) width: usize,
    pub(super) height: usize,
    pub(super) band: Vec<bool>,
    /// The exact area-average reference composite of the clean frame over
    /// the background grey, and its coverage.
    pub(super) reference: Rendered,
}

/// `(input index, weight)` pairs of each output cell when `n_in` input cells
/// are area-averaged into `n_out`.
fn area_weights(n_out: usize, n_in: usize) -> Vec<Vec<(usize, f32)>> {
    let scale = n_in as f64 / n_out as f64;
    (0..n_out)
        .map(|i| {
            let (lo, hi) = (i as f64 * scale, (i + 1) as f64 * scale);
            (lo.floor() as usize..(hi.ceil() as usize).min(n_in))
                .map(|j| {
                    let overlap = (hi.min(j as f64 + 1.0) - lo.max(j as f64)).max(0.0);
                    (j, (overlap / scale) as f32)
                })
                .filter(|(_, weight)| *weight > 0.0)
                .collect()
        })
        .collect()
}

/// The honest picture of the slot: every texel of the frame keyed with the
/// reference keyer (plan 229's judged neighbourhood, the spec's despill),
/// premultiplied, and area-averaged exactly into the slot over the grey.
pub(super) fn area_render(
    frame_rgba: &[u8],
    width: u32,
    height: u32,
    spec: &ChromaKeySpec,
) -> Rendered {
    {
        let source = RgbaSource {
            bytes: frame_rgba,
            width,
            height,
            format: SourcePixelFormat::Rgba,
        };
        let judged = KeyJudgedPlane::build(&source);
        let (w, h) = (width as usize, height as usize);
        let (sw, sh) = (SLOT_WIDTH as usize, SLOT_HEIGHT as usize);
        let across = area_weights(sw, w);
        let down = area_weights(sh, h);
        // Premultiplied RGBA, reduced across first (per source row), then down.
        let mut rows = vec![[0.0f32; 4]; h * sw];
        rows.par_chunks_mut(sw).enumerate().for_each(|(y, row)| {
            let texel = |x: usize| -> [f32; 4] {
                let (r, g, b, _) = read_source_rgba(&source, x as u32, y as u32);
                let alpha =
                    f32::from(chroma_key_alpha_rgb(spec, judged.rgb(x as u32, y as u32))) / 255.0;
                let (r, g, b) = chroma_key_despill(spec, r, g, b);
                [
                    f32::from(r) * alpha,
                    f32::from(g) * alpha,
                    f32::from(b) * alpha,
                    alpha,
                ]
            };
            for (i, cell) in row.iter_mut().enumerate() {
                let mut sum = [0.0f32; 4];
                for &(x, weight) in &across[i] {
                    let t = texel(x);
                    for c in 0..4 {
                        sum[c] += weight * t[c];
                    }
                }
                *cell = sum;
            }
        });
        let mut premultiplied = vec![[0.0f32; 4]; sw * sh];
        premultiplied
            .par_chunks_mut(sw)
            .enumerate()
            .for_each(|(j, out)| {
                for (i, cell) in out.iter_mut().enumerate() {
                    let mut sum = [0.0f32; 4];
                    for &(y, weight) in &down[j] {
                        let t = rows[y * sw + i];
                        for c in 0..4 {
                            sum[c] += weight * t[c];
                        }
                    }
                    *cell = sum;
                }
            });
        let coverage: Vec<f32> = premultiplied.iter().map(|cell| cell[3]).collect();
        let grey = f32::from(BACKGROUND_GREY);
        let rgb: Vec<[f32; 3]> = premultiplied
            .iter()
            .map(|cell| {
                [
                    cell[0] + grey * (1.0 - cell[3]),
                    cell[1] + grey * (1.0 - cell[3]),
                    cell[2] + grey * (1.0 - cell[3]),
                ]
            })
            .collect();
        Rendered {
            width: sw,
            height: sh,
            rgb,
            alpha: coverage,
        }
    }
}

impl Outline {
    /// The clean frame's exact area-averaged coverage, and the band 2 px
    /// around every partially covered pixel of it.
    pub(super) fn of_clean_frame(camera: &SyntheticCamera, spec: &ChromaKeySpec) -> Self {
        let reference = area_render(&camera.clean_rgba(), camera.width, camera.height, spec);
        let (sw, sh) = (reference.width, reference.height);
        let edge: Vec<bool> = reference
            .alpha
            .iter()
            .map(|&c| c > 0.02 && c < 0.98)
            .collect();
        let mut band = vec![false; sw * sh];
        for j in 0..sh {
            for i in 0..sw {
                if !edge[j * sw + i] {
                    continue;
                }
                for dj in -2i64..=2 {
                    for di in -2i64..=2 {
                        let (ii, jj) = (i as i64 + di, j as i64 + dj);
                        if ii >= 0 && jj >= 0 && (ii as usize) < sw && (jj as usize) < sh {
                            band[jj as usize * sw + ii as usize] = true;
                        }
                    }
                }
            }
        }
        Self {
            width: sw,
            height: sh,
            band,
            reference,
        }
    }

    pub(super) fn band_pixels(&self) -> usize {
        self.band.iter().filter(|&&b| b).count()
    }
}

/// The plan's speck: a pixel whose green dominates both other channels.
fn is_green([r, g, b]: [f32; 3]) -> bool {
    g - r.max(b) > 8.0 && g > 20.0
}

/// Green pixels on the outline.
pub(super) fn green_on_outline(rendered: &Rendered, outline: &Outline) -> usize {
    assert_eq!(
        (rendered.width, rendered.height),
        (outline.width, outline.height)
    );
    rendered
        .rgb
        .iter()
        .zip(&outline.band)
        .filter(|(rgb, on_band)| **on_band && is_green(**rgb))
        .count()
}

/// Outline pixels whose alpha moves by more than a half between two frames.
pub(super) fn alpha_flips_on_outline(a: &Rendered, b: &Rendered, outline: &Outline) -> usize {
    a.alpha
        .iter()
        .zip(&b.alpha)
        .zip(&outline.band)
        .filter(|((a, b), on_band)| **on_band && (**a - **b).abs() > 0.5)
        .count()
}

/// Mean luma gradient inside the subject (fully covered, off the outline):
/// how much detail the shrink keeps. Above the area reference is aliasing.
pub(super) fn interior_detail(rendered: &Rendered, outline: &Outline) -> f64 {
    let (w, h) = (rendered.width, rendered.height);
    let luma = |i: usize| {
        let [r, g, b] = rendered.rgb[i];
        0.299 * r + 0.587 * g + 0.114 * b
    };
    let (mut sum, mut count) = (0.0f64, 0usize);
    for y in 0..h - 1 {
        for x in 0..w - 1 {
            let i = y * w + x;
            if rendered.alpha[i] <= 0.99 || outline.band[i] {
                continue;
            }
            sum += f64::from((luma(i + 1) - luma(i)).abs() + (luma(i + w) - luma(i)).abs());
            count += 1;
        }
    }
    sum / count.max(1) as f64
}

/// The CPU blit's picture of the slot: the keyed camera drawn over the grey
/// canvas for its colour (read back from the YUV420p it writes, one chroma
/// sample per 2×2 block), and over black and white for its alpha (the luma
/// difference is `(white − black) × (1 − alpha)`).
pub(super) fn cpu_render(
    frame_rgba: &[u8],
    width: u32,
    height: u32,
    spec: &ChromaKeySpec,
) -> Rendered {
    let source = RgbaSource {
        bytes: frame_rgba,
        width,
        height,
        format: SourcePixelFormat::Rgba,
    };
    let (sw, sh) = (SLOT_WIDTH, SLOT_HEIGHT);
    let blit = |background: u8| -> Vec<u8> {
        let (y, u, v) = rgb_to_yuv(background, background, background);
        let mut bytes = vec![0; raw_yuv420p_len(sw, sh)];
        fill_yuv420p(&mut bytes, sw, sh, y, u, v);
        assert!(blit_rgba_to_yuv420p(
            &source,
            &mut bytes,
            sw,
            sh,
            PixelRect {
                x: 0,
                y: 0,
                width: sw,
                height: sh,
            },
            SourceRenderOptions {
                crop: SceneCrop::none(),
                pan: (0.0, 0.0),
                contain: false,
                mirror_x: false,
                mask: SceneMask::None,
                chroma_key: Some(*spec),
                camera_look: crate::protocol::CameraLook::default(),
                // The camera's option (plan 200 D3).
                linear: true,
            },
        ));
        bytes
    };
    let grey = blit(BACKGROUND_GREY);
    let black = blit(0);
    let white = blit(255);
    let (sw, sh) = (sw as usize, sh as usize);
    let uv_width = sw.div_ceil(2);
    let y_len = sw * sh;
    let (black_y, _, _) = rgb_to_yuv(0, 0, 0);
    let (white_y, _, _) = rgb_to_yuv(255, 255, 255);
    let span = f32::from(white_y) - f32::from(black_y);
    let mut rgb = Vec::with_capacity(y_len);
    let mut alpha = Vec::with_capacity(y_len);
    for y in 0..sh {
        for x in 0..sw {
            let i = y * sw + x;
            let uv = y_len + (y / 2) * uv_width + x / 2;
            let (b, g, r) =
                ycbcr_bt709_video_to_bgr(grey[i], grey[uv], grey[uv + uv_width * sh.div_ceil(2)]);
            rgb.push([f32::from(r), f32::from(g), f32::from(b)]);
            let difference = f32::from(white[i]) - f32::from(black[i]);
            alpha.push((1.0 - difference / span).clamp(0.0, 1.0));
        }
    }
    Rendered {
        width: sw,
        height: sh,
        rgb,
        alpha,
    }
}

/// The Metal compositor's picture of the slot (a recording compositor: the
/// nearest scene sampler, so the scaled camera reads linear), the same way
/// as [`cpu_render`]: over grey for colour, over black and white for alpha.
/// `None` without a Metal device.
#[cfg(target_os = "macos")]
pub(super) fn metal_render(
    frame_rgba: &[u8],
    width: u32,
    height: u32,
    spec: &ChromaKeySpec,
    revision: u64,
) -> Option<Rendered> {
    use crate::metal_compositor::{
        GpuSource, GpuSourceContentKey, GpuSourceKind, GpuSourceSampler, MetalSceneCompositor,
        SourceMask,
    };
    let mut gpu = MetalSceneCompositor::new()?;
    let bgra: Vec<u8> = frame_rgba
        .chunks_exact(4)
        .flat_map(|p| [p[2], p[1], p[0], p[3]])
        .collect();
    let (sw, sh) = (SLOT_WIDTH as usize, SLOT_HEIGHT as usize);
    let mut compose = |background: f64| -> Vec<u8> {
        let source = GpuSource {
            kind: GpuSourceKind::Camera,
            bgra: &bgra,
            content_key: Some(GpuSourceContentKey {
                namespace: CAMERA_CAPTURE_STORAGE_CONTENT_NAMESPACE,
                revision,
                variant: 0,
            }),
            iosurface: None,
            pixel_buffer: None,
            texture: None,
            width: width as usize,
            height: height as usize,
            dest: [0.0, 0.0, 1.0, 1.0],
            crop: [0.0; 4],
            mirror: false,
            mask: SourceMask::None,
            blend: true,
            chroma_key: scene_chroma_key_into_metal(spec),
            camera_look: None,
            corners: None,
            sampler: GpuSourceSampler::Scene,
            opacity: 1.0,
        };
        gpu.compose_bgra(sw, sh, [background, background, background, 1.0], &[source])
            .expect("metal compose")
    };
    let grey = compose(f64::from(BACKGROUND_GREY) / 255.0);
    let black = compose(0.0);
    let white = compose(1.0);
    let mut rgb = Vec::with_capacity(sw * sh);
    let mut alpha = Vec::with_capacity(sw * sh);
    for i in 0..sw * sh {
        rgb.push([
            f32::from(grey[i * 4 + 2]),
            f32::from(grey[i * 4 + 1]),
            f32::from(grey[i * 4]),
        ]);
        // Any channel: white − black = 255 × (1 − alpha).
        let difference = f32::from(white[i * 4 + 1]) - f32::from(black[i * 4 + 1]);
        alpha.push((1.0 - difference / 255.0).clamp(0.0, 1.0));
    }
    Some(Rendered {
        width: sw,
        height: sh,
        rgb,
        alpha,
    })
}

/// One path's three numbers on the synthetic frame.
pub(super) struct EdgeSnowMetrics {
    pub(super) outline_green_per_frame: f64,
    pub(super) outline_flips_per_frame: f64,
    pub(super) detail: f64,
    pub(super) area_detail: f64,
}

impl EdgeSnowMetrics {
    pub(super) fn measure(
        camera: &SyntheticCamera,
        outline: &Outline,
        spec: &ChromaKeySpec,
        render: impl Fn(&[u8], u64) -> Rendered,
    ) -> Self {
        let frames = [camera.noisy_rgba(1), camera.noisy_rgba(2)];
        let first = render(&frames[0], 1);
        let second = render(&frames[1], 2);
        let green =
            (green_on_outline(&first, outline) + green_on_outline(&second, outline)) as f64 / 2.0;
        // Detail is measured on the noisy frames, like the plan's
        // simulation: across a smooth edge every normalized filter keeps the
        // same total variation, so on a clean frame every shrink reads the
        // same, and only the noise tells an aliased shrink (which keeps too
        // much of it) from the honest one.
        let detail = (interior_detail(&first, outline) + interior_detail(&second, outline)) / 2.0;
        let area_detail = frames
            .iter()
            .map(|frame| {
                interior_detail(
                    &area_render(frame, camera.width, camera.height, spec),
                    outline,
                )
            })
            .sum::<f64>()
            / 2.0;
        Self {
            outline_green_per_frame: green,
            outline_flips_per_frame: alpha_flips_on_outline(&first, &second, outline) as f64,
            detail,
            area_detail,
        }
    }

    pub(super) fn report(&self, label: &str, outline: &Outline) {
        eprintln!(
            "[plan 233 S0] {label}: outline band {} px, green on outline {:.1}/frame, alpha flips {:.1}/frame, detail {:.3} (area reference {:.3}, {:.0} %)",
            outline.band_pixels(),
            self.outline_green_per_frame,
            self.outline_flips_per_frame,
            self.detail,
            self.area_detail,
            100.0 * self.detail / self.area_detail.max(1e-9)
        );
    }

    /// The plan's thresholds against the shipped numbers.
    pub(super) fn assert_within(&self, label: &str, shipped_green: f64, shipped_flips: f64) {
        assert!(
            self.outline_green_per_frame <= ALLOWED_SHARE_OF_SHIPPED * shipped_green,
            "{label}: green on the outline {:.1}/frame, allowed {:.1} (10 % of the shipped {shipped_green:.1})",
            self.outline_green_per_frame,
            ALLOWED_SHARE_OF_SHIPPED * shipped_green
        );
        assert!(
            self.outline_flips_per_frame <= ALLOWED_SHARE_OF_SHIPPED * shipped_flips,
            "{label}: alpha flips on the outline {:.1}/frame, allowed {:.1} (10 % of the shipped {shipped_flips:.1})",
            self.outline_flips_per_frame,
            ALLOWED_SHARE_OF_SHIPPED * shipped_flips
        );
        assert!(
            self.detail >= REQUIRED_SHARE_OF_AREA_DETAIL * self.area_detail,
            "{label}: detail {:.3} under 90 % of the area reference's {:.3}",
            self.detail,
            self.area_detail
        );
    }
}

/// Plan 233 S0 on the CPU blit: the 4K synthetic camera in the Large slot
/// keeps at most 10 % of the shipped snow and 90 % of the honest detail.
#[test]
fn cpu_keyed_4k_camera_in_the_large_slot_has_no_edge_snow() {
    let camera = SyntheticCamera::build(CAMERA_WIDTH, CAMERA_HEIGHT);
    let spec = default_key_spec();
    let outline = Outline::of_clean_frame(&camera, &spec);
    assert!(
        outline.band_pixels() > 1000,
        "the synthetic subject has an outline to measure, got {} px",
        outline.band_pixels()
    );
    let metrics = EdgeSnowMetrics::measure(&camera, &outline, &spec, |frame, _| {
        cpu_render(frame, camera.width, camera.height, &spec)
    });
    metrics.report("CPU blit", &outline);
    metrics.assert_within(
        "CPU blit",
        SHIPPED_CPU_OUTLINE_GREEN_PER_FRAME,
        SHIPPED_CPU_OUTLINE_FLIPS_PER_FRAME,
    );
}

/// Plan 233 S2 on the Metal compositor: the same frame through the key pass
/// and the one-tap draw keeps at most 10 % of the shipped snow and 90 % of
/// the honest detail, and agrees with the CPU oracle on the slot within the
/// tolerance the CPU/Metal keyer tests use.
#[cfg(target_os = "macos")]
#[test]
fn metal_keyed_4k_camera_in_the_large_slot_has_no_edge_snow_or_skips() {
    let spec = default_key_spec();
    if metal_render(&[0u8; 16], 2, 2, &spec, 0).is_none() {
        eprintln!("skipping: no Metal device available in this environment");
        return;
    }
    let camera = SyntheticCamera::build(CAMERA_WIDTH, CAMERA_HEIGHT);
    let outline = Outline::of_clean_frame(&camera, &spec);
    let metrics = EdgeSnowMetrics::measure(&camera, &outline, &spec, |frame, revision| {
        metal_render(frame, camera.width, camera.height, &spec, revision).expect("metal")
    });
    metrics.report("Metal", &outline);
    metrics.assert_within(
        "Metal",
        SHIPPED_METAL_OUTLINE_GREEN_PER_FRAME,
        SHIPPED_METAL_OUTLINE_FLIPS_PER_FRAME,
    );
    // Parity with the CPU oracle on one noisy frame: luma within the
    // existing keyer tests' 4 levels on 99 % of the slot (the CPU reads its
    // colour back through 4:2:0 chroma and the GPU's keyed texture is
    // RGBA16F, so a few outline pixels round apart), and alpha within 0.1.
    let frame = camera.noisy_rgba(1);
    let cpu = cpu_render(&frame, camera.width, camera.height, &spec);
    let gpu = metal_render(&frame, camera.width, camera.height, &spec, 1).expect("metal");
    let luma = |[r, g, b]: [f32; 3]| rgb_to_y(r as u8, g as u8, b as u8);
    let mut luma_apart = 0usize;
    let mut alpha_apart = 0usize;
    for i in 0..cpu.rgb.len() {
        if (i16::from(luma(cpu.rgb[i])) - i16::from(luma(gpu.rgb[i]))).abs() > 4 {
            luma_apart += 1;
        }
        if (cpu.alpha[i] - gpu.alpha[i]).abs() > 0.1 {
            alpha_apart += 1;
        }
    }
    let pixels = cpu.rgb.len();
    eprintln!(
        "[plan 233 S2] CPU/Metal parity on the slot: luma apart {luma_apart} of {pixels}, alpha apart {alpha_apart}"
    );
    assert!(
        luma_apart * 100 <= pixels,
        "CPU and Metal luma differ by more than 4 on {luma_apart} of {pixels} pixels"
    );
    assert!(
        alpha_apart * 100 <= pixels,
        "CPU and Metal alpha differ by more than 0.1 on {alpha_apart} of {pixels} pixels"
    );
}

/// The compositor's render cost with a 4K keyed camera in the Large slot of
/// a 1080p canvas, p50 and p95 of `compose_target_with_timings`, reported
/// for plan 233 S2's budget (a rise of at most 1.5 ms). The spill moves by
/// a millionth per frame so a keyed-texture cache keyed on the spec must
/// re-key every frame; the camera texture itself uploads once.
#[cfg(target_os = "macos")]
#[test]
fn metal_keyed_4k_camera_compose_cost_report_or_skips() {
    use crate::metal_compositor::{
        GpuSource, GpuSourceContentKey, GpuSourceKind, GpuSourceSampler, MetalSceneCompositor,
        SourceMask,
    };
    let Some(mut gpu) = MetalSceneCompositor::new() else {
        eprintln!("skipping: no Metal device available in this environment");
        return;
    };
    let camera = SyntheticCamera::build(CAMERA_WIDTH, CAMERA_HEIGHT);
    let rgba = camera.noisy_rgba(1);
    let bgra: Vec<u8> = rgba
        .chunks_exact(4)
        .flat_map(|p| [p[2], p[1], p[0], p[3]])
        .collect();
    let spec = default_key_spec();
    let (canvas_w, canvas_h) = (1920usize, 1080usize);
    let dest = [
        1.0 - SLOT_WIDTH as f32 / canvas_w as f32,
        1.0 - SLOT_HEIGHT as f32 / canvas_h as f32,
        SLOT_WIDTH as f32 / canvas_w as f32,
        SLOT_HEIGHT as f32 / canvas_h as f32,
    ];
    let mut times = Vec::new();
    for frame in 0..70u64 {
        let mut key = scene_chroma_key_into_metal(&spec).expect("green key");
        key.spill += frame as f32 * 1e-6;
        let source = GpuSource {
            kind: GpuSourceKind::Camera,
            bgra: &bgra,
            content_key: Some(GpuSourceContentKey {
                namespace: CAMERA_CAPTURE_STORAGE_CONTENT_NAMESPACE,
                revision: 1,
                variant: 0,
            }),
            iosurface: None,
            pixel_buffer: None,
            texture: None,
            width: camera.width as usize,
            height: camera.height as usize,
            dest,
            crop: [0.0; 4],
            mirror: false,
            mask: SourceMask::None,
            blend: true,
            chroma_key: Some(key),
            camera_look: None,
            corners: None,
            sampler: GpuSourceSampler::Scene,
            opacity: 1.0,
        };
        let timings = gpu
            .compose_target_with_timings(canvas_w, canvas_h, [0.0, 0.0, 0.0, 1.0], &[source])
            .expect("metal compose");
        if frame >= 10 {
            times.push(timings.total_ms);
        }
    }
    times.sort_by(f64::total_cmp);
    let percentile = |p: f64| times[((times.len() - 1) as f64 * p).round() as usize];
    eprintln!(
        "[plan 233 S2] 4K keyed camera in the Large slot of a 1080p canvas, {} composes: p50 {:.2} ms, p95 {:.2} ms (debug build: {})",
        times.len(),
        percentile(0.5),
        percentile(0.95),
        cfg!(debug_assertions)
    );
}
