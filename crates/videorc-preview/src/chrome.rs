//! The Scene editor's selection chrome as pixels (plan 260 L1, the Linux
//! live canvas): the selected box's frame, its handles, the lines that tie
//! pushed-out handles to their corners, and the snap guides, drawn into a
//! transparent premultiplied bitmap the Linux presenter shows in a surface
//! of its own above the video.
//!
//! On macOS the docked preview is a view under GPUI's drawing, so GPUI
//! draws the chrome over it. On Linux the presenter's child sits above the
//! window's drawing (a `wl_subsurface`; X11's child window is always on
//! top), so anything GPUI draws over the slot is hidden: the chrome goes in
//! a second subsurface stacked above the video instead. The shapes are the
//! stage's own (`screens/scene/stage/draw.rs`), in the stage layer's points;
//! item outlines and label chips stay off the live surface, as Electron's
//! `liveSurface && 'invisible'` keeps them (the toolbar's chips name the
//! items).
//!
//! Platform-free and pure, so its tests run everywhere.

use crate::LayerRect;

/// A straight-alpha colour, 0 to 1 per channel (GPUI's `Rgba`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rgba {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Rgba {
    pub const fn new(r: f32, g: f32, b: f32, a: f32) -> Self {
        Self { r, g, b, a }
    }
}

/// One piece of chrome, in the stage layer's points (top-left origin).
#[derive(Debug, Clone, PartialEq)]
pub enum ChromeShape {
    /// A one-point frame just inside the rect (`border_1`).
    Frame {
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        color: Rgba,
    },
    /// A handle: a square filled with `fill`, a one-point `border` inside.
    Square {
        x: f32,
        y: f32,
        size: f32,
        fill: Rgba,
        border: Rgba,
    },
    /// A one-point line from one point to another (the connector of a
    /// pushed-out handle runs at 45°).
    Line {
        from: (f32, f32),
        to: (f32, f32),
        color: Rgba,
    },
    /// A one-point dashed guide, vertical (`x0 == x1`) or horizontal.
    Dashed {
        from: (f32, f32),
        to: (f32, f32),
        color: Rgba,
    },
}

/// What the stage draws over the live video: where (the stage layer's rect
/// in the window, in points, as the presenter's placement takes it), at
/// which scale, and the shapes.
#[derive(Debug, Clone, PartialEq)]
pub struct ChromeScene {
    pub rect: LayerRect,
    /// Device pixels per point (the window's scale factor).
    pub scale: f32,
    pub shapes: Vec<ChromeShape>,
}

/// The rasterized chrome: premultiplied BGRA, little-endian ARGB8888 (the
/// `wl_shm` format the video uses too), `width * 4` bytes a row.
#[derive(Debug, Clone, PartialEq)]
pub struct ChromeBitmap {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

/// GPUI's dashed border: four points on, three off (`strokeDasharray="4 3"`).
const DASH_ON: f32 = 4.0;
const DASH_OFF: f32 = 3.0;

/// The bitmap size for a scene: its rect in device pixels, at least 1×1.
pub fn bitmap_size(scene: &ChromeScene) -> (u32, u32) {
    let scale = scene.scale.max(0.1) as f64;
    let width = (scene.rect.width * scale).ceil().max(1.0) as u32;
    let height = (scene.rect.height * scale).ceil().max(1.0) as u32;
    (width, height)
}

/// Draws every shape, in order, over a transparent bitmap (source-over).
pub fn rasterize(scene: &ChromeScene) -> ChromeBitmap {
    let (width, height) = bitmap_size(scene);
    let mut canvas = Canvas {
        width,
        height,
        pixels: vec![0; width as usize * height as usize * 4],
        scale: scene.scale.max(0.1),
    };
    for shape in &scene.shapes {
        canvas.shape(shape);
    }
    ChromeBitmap {
        width,
        height,
        pixels: canvas.pixels,
    }
}

struct Canvas {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
    scale: f32,
}

impl Canvas {
    /// One point in device pixels (a hairline stays one pixel).
    fn thickness(&self) -> i64 {
        (self.scale.round() as i64).max(1)
    }

    fn device(&self, points: f32) -> i64 {
        (points * self.scale).round() as i64
    }

    /// Source-over of a straight-alpha colour onto one pixel.
    fn blend(&mut self, x: i64, y: i64, color: Rgba) {
        if x < 0 || y < 0 || x >= self.width as i64 || y >= self.height as i64 {
            return;
        }
        let alpha = color.a.clamp(0.0, 1.0);
        if alpha <= 0.0 {
            return;
        }
        let at = (y as usize * self.width as usize + x as usize) * 4;
        let keep = 1.0 - alpha;
        // BGRA in memory; premultiplied.
        let source = [
            color.b.clamp(0.0, 1.0) * alpha,
            color.g.clamp(0.0, 1.0) * alpha,
            color.r.clamp(0.0, 1.0) * alpha,
            alpha,
        ];
        for (channel, value) in source.iter().enumerate() {
            let dest = f32::from(self.pixels[at + channel]) / 255.0;
            let out = value + dest * keep;
            self.pixels[at + channel] = (out * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }

    /// Fills `[x0, x1) × [y0, y1)` in device pixels.
    fn fill(&mut self, x0: i64, y0: i64, x1: i64, y1: i64, color: Rgba) {
        let (x0, x1) = (x0.max(0), x1.min(self.width as i64));
        let (y0, y1) = (y0.max(0), y1.min(self.height as i64));
        for y in y0..y1 {
            for x in x0..x1 {
                self.blend(x, y, color);
            }
        }
    }

    /// A band `t` pixels wide just inside `[x0, x1) × [y0, y1)`, each pixel
    /// once.
    fn frame(&mut self, x0: i64, y0: i64, x1: i64, y1: i64, color: Rgba) {
        let t = self.thickness();
        if x1 - x0 <= 2 * t || y1 - y0 <= 2 * t {
            self.fill(x0, y0, x1, y1, color);
            return;
        }
        self.fill(x0, y0, x1, y0 + t, color);
        self.fill(x0, y1 - t, x1, y1, color);
        self.fill(x0, y0 + t, x0 + t, y1 - t, color);
        self.fill(x1 - t, y0 + t, x1, y1 - t, color);
    }

    fn shape(&mut self, shape: &ChromeShape) {
        match *shape {
            ChromeShape::Frame {
                x,
                y,
                width,
                height,
                color,
            } => {
                let (x0, y0) = (self.device(x), self.device(y));
                let (x1, y1) = (self.device(x + width), self.device(y + height));
                self.frame(x0, y0, x1, y1, color);
            }
            ChromeShape::Square {
                x,
                y,
                size,
                fill,
                border,
            } => {
                let (x0, y0) = (self.device(x), self.device(y));
                let (x1, y1) = (self.device(x + size), self.device(y + size));
                self.fill(x0, y0, x1, y1, fill);
                self.frame(x0, y0, x1, y1, border);
            }
            ChromeShape::Line { from, to, color } => self.line(from, to, color),
            ChromeShape::Dashed { from, to, color } => self.dashed(from, to, color),
        }
    }

    /// A line of `t`-pixel dots, one per device pixel along its longer axis.
    fn line(&mut self, from: (f32, f32), to: (f32, f32), color: Rgba) {
        let t = self.thickness();
        let (x0, y0) = (from.0 * self.scale, from.1 * self.scale);
        let (x1, y1) = (to.0 * self.scale, to.1 * self.scale);
        let steps = (x1 - x0).abs().max((y1 - y0).abs()).round().max(1.0) as i64;
        let mut last = None;
        for step in 0..=steps {
            let k = step as f32 / steps as f32;
            let x = (x0 + (x1 - x0) * k).floor() as i64;
            let y = (y0 + (y1 - y0) * k).floor() as i64;
            if last == Some((x, y)) {
                continue;
            }
            last = Some((x, y));
            self.fill(x, y, x + t, y + t, color);
        }
    }

    /// An axis-aligned dashed line, starting with a dash at `from`.
    fn dashed(&mut self, from: (f32, f32), to: (f32, f32), color: Rgba) {
        let t = self.thickness();
        let on = self.device(DASH_ON).max(1);
        let off = self.device(DASH_OFF).max(1);
        let vertical = (to.0 - from.0).abs() < (to.1 - from.1).abs();
        let (fixed, start, end) = if vertical {
            (
                self.device(from.0),
                self.device(from.1.min(to.1)),
                self.device(from.1.max(to.1)),
            )
        } else {
            (
                self.device(from.1),
                self.device(from.0.min(to.0)),
                self.device(from.0.max(to.0)),
            )
        };
        let mut at = start;
        while at < end {
            let stop = (at + on).min(end);
            if vertical {
                self.fill(fixed, at, fixed + t, stop, color);
            } else {
                self.fill(at, fixed, stop, fixed + t, color);
            }
            at = stop + off;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WHITE: Rgba = Rgba::new(1.0, 1.0, 1.0, 1.0);
    const CLEAR: Rgba = Rgba::new(0.0, 0.0, 0.0, 0.0);

    fn scene(width: f64, height: f64, scale: f32, shapes: Vec<ChromeShape>) -> ChromeScene {
        ChromeScene {
            rect: LayerRect::new(0.0, 0.0, width, height),
            scale,
            shapes,
        }
    }

    fn alpha(bitmap: &ChromeBitmap, x: u32, y: u32) -> u8 {
        bitmap.pixels[((y * bitmap.width + x) * 4 + 3) as usize]
    }

    #[test]
    fn the_bitmap_is_the_rect_in_device_pixels() {
        let bitmap = rasterize(&scene(10.5, 4.0, 2.0, Vec::new()));
        assert_eq!((bitmap.width, bitmap.height), (21, 8));
        assert!(bitmap.pixels.iter().all(|byte| *byte == 0));
    }

    #[test]
    fn a_frame_is_a_one_point_band_inside_its_rect() {
        let frame = ChromeShape::Frame {
            x: 2.0,
            y: 2.0,
            width: 6.0,
            height: 6.0,
            color: WHITE,
        };
        let bitmap = rasterize(&scene(10.0, 10.0, 1.0, vec![frame]));
        assert_eq!(alpha(&bitmap, 2, 2), 255);
        assert_eq!(alpha(&bitmap, 7, 7), 255);
        assert_eq!(alpha(&bitmap, 4, 4), 0, "the inside stays clear");
        assert_eq!(alpha(&bitmap, 8, 8), 0, "nothing past the rect");
        // At 2×, the band is two pixels.
        let frame = ChromeShape::Frame {
            x: 1.0,
            y: 1.0,
            width: 4.0,
            height: 4.0,
            color: WHITE,
        };
        let bitmap = rasterize(&scene(6.0, 6.0, 2.0, vec![frame]));
        assert_eq!(alpha(&bitmap, 3, 5), 255);
        assert_eq!(alpha(&bitmap, 4, 5), 0);
    }

    #[test]
    fn colours_are_premultiplied_and_blend_source_over() {
        let half = Rgba::new(1.0, 0.0, 0.0, 0.5);
        let square = ChromeShape::Square {
            x: 0.0,
            y: 0.0,
            size: 4.0,
            fill: half,
            border: CLEAR,
        };
        let bitmap = rasterize(&scene(4.0, 4.0, 1.0, vec![square.clone()]));
        // BGRA: red lands third, at half its value.
        assert_eq!(&bitmap.pixels[0..4], &[0, 0, 128, 128]);
        let twice = rasterize(&scene(4.0, 4.0, 1.0, vec![square.clone(), square]));
        // 0.5 over 0.5: three quarters (191 or 192 after rounding).
        assert_eq!(&twice.pixels[0..2], &[0, 0]);
        assert!((i32::from(twice.pixels[2]) - 191).abs() <= 1);
        assert!((i32::from(twice.pixels[3]) - 191).abs() <= 1);
    }

    #[test]
    fn a_handle_has_its_fill_and_its_border() {
        let fill = Rgba::new(0.0, 0.0, 1.0, 1.0);
        let square = ChromeShape::Square {
            x: 0.0,
            y: 0.0,
            size: 6.0,
            fill,
            border: WHITE,
        };
        let bitmap = rasterize(&scene(6.0, 6.0, 1.0, vec![square]));
        assert_eq!(&bitmap.pixels[0..4], &[255, 255, 255, 255], "border");
        let middle = ((3 * 6 + 3) * 4) as usize;
        assert_eq!(
            &bitmap.pixels[middle..middle + 4],
            &[255, 0, 0, 255],
            "fill"
        );
    }

    #[test]
    fn a_connector_runs_diagonally() {
        let line = ChromeShape::Line {
            from: (0.0, 0.0),
            to: (4.0, 4.0),
            color: WHITE,
        };
        let bitmap = rasterize(&scene(6.0, 6.0, 1.0, vec![line]));
        for step in 0..=4 {
            assert_eq!(alpha(&bitmap, step, step), 255);
        }
        assert_eq!(alpha(&bitmap, 4, 0), 0);
    }

    #[test]
    fn a_guide_is_dashed_four_on_three_off() {
        let guide = ChromeShape::Dashed {
            from: (2.0, 0.0),
            to: (2.0, 14.0),
            color: WHITE,
        };
        let bitmap = rasterize(&scene(4.0, 14.0, 1.0, vec![guide]));
        let column: Vec<u8> = (0..14).map(|y| alpha(&bitmap, 2, y)).collect();
        assert_eq!(
            column,
            vec![255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0]
        );
    }

    #[test]
    fn shapes_off_the_bitmap_are_clipped() {
        let frame = ChromeShape::Frame {
            x: -5.0,
            y: -5.0,
            width: 30.0,
            height: 30.0,
            color: WHITE,
        };
        let bitmap = rasterize(&scene(10.0, 10.0, 1.0, vec![frame]));
        assert!(bitmap.pixels.iter().all(|byte| *byte == 0));
    }
}
