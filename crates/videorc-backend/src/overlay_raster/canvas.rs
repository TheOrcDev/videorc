//! The 2D canvas calls the overlays use, on tiny-skia: rounded rects, circles,
//! polygons, vertical gradients, strokes and canvas shadows (a Gaussian blur of
//! what the call drew, σ = shadowBlur / 2 as the canvas spec says, offset and
//! tinted, under the call). Colours are sRGB and blend in sRGB, like the
//! renderer's canvas.

use tiny_skia::{
    FillRule, GradientStop, LineCap, LineJoin, LinearGradient, Paint, Path, PathBuilder, Pixmap,
    Point, Shader, SpreadMode, Stroke, Transform,
};

/// A straight-alpha sRGB colour, the components of a CSS `rgba()`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Rgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: f32,
}

impl Rgba {
    pub(crate) const fn new(r: u8, g: u8, b: u8, a: f32) -> Self {
        Self { r, g, b, a }
    }

    /// `#RRGGBB`, opaque.
    pub(crate) const fn hex(rgb: u32) -> Self {
        Self::new((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8, 1.0)
    }

    fn skia(self) -> tiny_skia::Color {
        tiny_skia::Color::from_rgba8(self.r, self.g, self.b, unit_to_u8(self.a))
    }
}

pub(crate) fn unit_to_u8(value: f32) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// A canvas `shadowColor`, `shadowBlur` and `shadowOffsetX/Y`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Shadow {
    pub color: Rgba,
    pub blur: f32,
    pub offset_x: f32,
    pub offset_y: f32,
}

/// What fills a path: a colour or a vertical linear gradient.
pub(crate) enum Fill<'a> {
    Color(Rgba),
    /// From `y0` to `y1`, with `(offset, colour)` stops.
    VerticalGradient {
        y0: f32,
        y1: f32,
        stops: &'a [(f32, Rgba)],
    },
}

/// `ctx.roundRect(x, y, w, h, r)` as a path: circular corners, the radius
/// scaled down when it does not fit (the canvas spec's rule).
pub(crate) fn round_rect(x: f32, y: f32, w: f32, h: f32, radius: f32) -> Option<Path> {
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    let mut r = radius.max(0.0);
    let scale = (w / (2.0 * r)).min(h / (2.0 * r));
    if scale < 1.0 {
        r *= scale;
    }
    let mut path = PathBuilder::new();
    if r <= 0.0 {
        path.move_to(x, y);
        path.line_to(x + w, y);
        path.line_to(x + w, y + h);
        path.line_to(x, y + h);
        path.close();
        return path.finish();
    }
    // A quarter circle as one cubic (the usual 0.5523 handle).
    let k = r * 0.552_284_8;
    path.move_to(x + r, y);
    path.line_to(x + w - r, y);
    path.cubic_to(x + w - r + k, y, x + w, y + r - k, x + w, y + r);
    path.line_to(x + w, y + h - r);
    path.cubic_to(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h);
    path.line_to(x + r, y + h);
    path.cubic_to(x + r - k, y + h, x, y + h - r + k, x, y + h - r);
    path.line_to(x, y + r);
    path.cubic_to(x, y + r - k, x + r - k, y, x + r, y);
    path.close();
    path.finish()
}

/// `ctx.arc(cx, cy, r, 0, 2π)`.
pub(crate) fn circle(cx: f32, cy: f32, r: f32) -> Option<Path> {
    PathBuilder::from_circle(cx, cy, r)
}

/// `ctx.rect(x, y, w, h)`.
pub(crate) fn rect(x: f32, y: f32, w: f32, h: f32) -> Option<Path> {
    tiny_skia::Rect::from_xywh(x, y, w, h).map(PathBuilder::from_rect)
}

/// A closed polygon (`moveTo`, `lineTo`…, `closePath`).
pub(crate) fn polygon(points: &[(f32, f32)]) -> Option<Path> {
    let (first, rest) = points.split_first()?;
    let mut path = PathBuilder::new();
    path.move_to(first.0, first.1);
    for point in rest {
        path.line_to(point.0, point.1);
    }
    path.close();
    path.finish()
}

/// An open polyline (`moveTo`, `lineTo`…), for strokes.
pub(crate) fn polyline(segments: &[&[(f32, f32)]]) -> Option<Path> {
    let mut path = PathBuilder::new();
    for segment in segments {
        let Some((first, rest)) = segment.split_first() else {
            continue;
        };
        path.move_to(first.0, first.1);
        for point in rest {
            path.line_to(point.0, point.1);
        }
    }
    path.finish()
}

fn paint_for(fill: &Fill<'_>) -> Option<Paint<'static>> {
    let mut paint = Paint {
        anti_alias: true,
        ..Paint::default()
    };
    match fill {
        Fill::Color(color) => paint.set_color(color.skia()),
        Fill::VerticalGradient { y0, y1, stops } => {
            let stops = stops
                .iter()
                .map(|(offset, color)| GradientStop::new(*offset, color.skia()))
                .collect();
            paint.shader = LinearGradient::new(
                Point::from_xy(0.0, *y0),
                Point::from_xy(0.0, *y1),
                stops,
                SpreadMode::Pad,
                Transform::identity(),
            )
            .unwrap_or(Shader::SolidColor(tiny_skia::Color::TRANSPARENT));
        }
    }
    Some(paint)
}

/// `ctx.fill()`, the path moved by (`dx`, `dy`).
pub(crate) fn fill_path(target: &mut Pixmap, path: &Path, fill: &Fill<'_>, dx: f32, dy: f32) {
    if let Some(paint) = paint_for(fill) {
        target.fill_path(
            path,
            &paint,
            FillRule::Winding,
            Transform::from_translate(dx, dy),
            None,
        );
    }
}

/// The stroke style of `ctx.stroke()`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct StrokeStyle {
    pub color: Rgba,
    pub width: f32,
    pub join: LineJoin,
    pub cap: LineCap,
}

impl StrokeStyle {
    /// The canvas defaults: miter joins, butt caps.
    pub(crate) fn new(color: Rgba, width: f32) -> Self {
        Self {
            color,
            width,
            join: LineJoin::Miter,
            cap: LineCap::Butt,
        }
    }

    pub(crate) fn round(self) -> Self {
        Self {
            join: LineJoin::Round,
            cap: LineCap::Round,
            ..self
        }
    }

    pub(crate) fn round_join(self) -> Self {
        Self {
            join: LineJoin::Round,
            ..self
        }
    }
}

/// `ctx.stroke()`, the path moved by (`dx`, `dy`).
pub(crate) fn stroke_path(target: &mut Pixmap, path: &Path, style: StrokeStyle, dx: f32, dy: f32) {
    let mut paint = Paint {
        anti_alias: true,
        ..Paint::default()
    };
    paint.set_color(style.color.skia());
    let stroke = Stroke {
        width: style.width,
        line_join: style.join,
        line_cap: style.cap,
        ..Stroke::default()
    };
    target.stroke_path(
        path,
        &paint,
        &stroke,
        Transform::from_translate(dx, dy),
        None,
    );
}

/// One canvas call with the context's shadow: `draw` paints into the target it
/// is given, moved by the offset it is given. With a visible shadow the call is
/// painted once into a scratch layer at the shadow's offset, its alpha blurred
/// and tinted under the target, then painted for real, as Skia's draw looper
/// does for `ctx.fill()` and `ctx.fillText()` under a `shadowColor`.
pub(crate) fn with_shadow(
    target: &mut Pixmap,
    shadow: Option<Shadow>,
    mut draw: impl FnMut(&mut Pixmap, f32, f32),
) {
    if let Some(shadow) = shadow.filter(|shadow| shadow.color.a > 0.0)
        && let Some(mut layer) = Pixmap::new(target.width(), target.height())
    {
        draw(&mut layer, shadow.offset_x, shadow.offset_y);
        let mut alpha: Vec<f32> = layer
            .pixels()
            .iter()
            .map(|pixel| f32::from(pixel.alpha()) / 255.0)
            .collect();
        gaussian_blur(
            &mut alpha,
            target.width() as usize,
            target.height() as usize,
            shadow.blur / 2.0,
        );
        composite_tint(target, &alpha, shadow.color);
    }
    draw(target, 0.0, 0.0);
}

/// Source-over of `color` with per-pixel coverage `alpha` (0 to 1).
fn composite_tint(target: &mut Pixmap, alpha: &[f32], color: Rgba) {
    let (r, g, b) = (
        f32::from(color.r) / 255.0,
        f32::from(color.g) / 255.0,
        f32::from(color.b) / 255.0,
    );
    let data = target.data_mut();
    for (pixel, coverage) in data.chunks_exact_mut(4).zip(alpha) {
        let source_alpha = color.a * coverage;
        if source_alpha <= 0.0 {
            continue;
        }
        blend_premultiplied(
            pixel,
            [
                r * source_alpha,
                g * source_alpha,
                b * source_alpha,
                source_alpha,
            ],
        );
    }
}

/// Source-over of one premultiplied source pixel (components 0 to 1) onto a
/// premultiplied RGBA8 pixel.
pub(crate) fn blend_premultiplied(pixel: &mut [u8], source: [f32; 4]) {
    let keep = 1.0 - source[3];
    for (channel, value) in pixel.iter_mut().zip(source) {
        let blended = value * 255.0 + f32::from(*channel) * keep;
        *channel = blended.round().clamp(0.0, 255.0) as u8;
    }
}

/// An in-place separable Gaussian blur of a coverage plane.
fn gaussian_blur(plane: &mut [f32], width: usize, height: usize, sigma: f32) {
    if sigma < 0.1 || width == 0 || height == 0 {
        return;
    }
    let radius = (sigma * 3.0).ceil() as usize;
    let kernel: Vec<f32> = {
        let raw: Vec<f32> = (0..=radius * 2)
            .map(|index| {
                let x = index as f32 - radius as f32;
                (-(x * x) / (2.0 * sigma * sigma)).exp()
            })
            .collect();
        let sum: f32 = raw.iter().sum();
        raw.into_iter().map(|value| value / sum).collect()
    };
    let mut scratch = vec![0.0f32; plane.len()];
    // Rows into the scratch plane, then columns back.
    for y in 0..height {
        let row = &plane[y * width..(y + 1) * width];
        for x in 0..width {
            let mut sum = 0.0;
            for (index, weight) in kernel.iter().enumerate() {
                let sample = x as isize + index as isize - radius as isize;
                if sample >= 0 && (sample as usize) < width {
                    sum += row[sample as usize] * weight;
                }
            }
            scratch[y * width + x] = sum;
        }
    }
    for x in 0..width {
        for y in 0..height {
            let mut sum = 0.0;
            for (index, weight) in kernel.iter().enumerate() {
                let sample = y as isize + index as isize - radius as isize;
                if sample >= 0 && (sample as usize) < height {
                    sum += scratch[sample as usize * width + x] * weight;
                }
            }
            plane[y * width + x] = sum;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_round_rect_radius_shrinks_to_fit() {
        let path = round_rect(0.0, 0.0, 10.0, 4.0, 50.0).expect("path");
        let bounds = path.bounds();
        assert_eq!((bounds.width(), bounds.height()), (10.0, 4.0));
        assert!(round_rect(0.0, 0.0, 0.0, 4.0, 2.0).is_none());
    }

    #[test]
    fn a_shadow_lands_under_the_shape_and_spreads() {
        let mut pixmap = Pixmap::new(40, 40).expect("pixmap");
        let path = rect(10.0, 10.0, 20.0, 20.0).expect("rect");
        with_shadow(
            &mut pixmap,
            Some(Shadow {
                color: Rgba::new(0, 0, 0, 1.0),
                blur: 4.0,
                offset_x: 0.0,
                offset_y: 4.0,
            }),
            |target, dx, dy| {
                fill_path(
                    target,
                    &path,
                    &Fill::Color(Rgba::new(255, 255, 255, 1.0)),
                    dx,
                    dy,
                );
            },
        );
        // The shape is white and opaque; below it, the shadow is dark and soft.
        let inside = pixmap.pixel(20, 20).expect("pixel");
        assert_eq!((inside.red(), inside.alpha()), (255, 255));
        let below = pixmap.pixel(20, 32).expect("pixel");
        assert_eq!(below.red(), 0);
        assert!(below.alpha() > 100 && below.alpha() < 255, "{below:?}");
    }
}
