//! The SRT Camera's stills (plan 255 D7, D12): a dark frame with centred
//! text, wrapped into a 9:16 column in the middle.
//! A portrait canvas, a vertical leg or a square box crops a camera to its
//! middle; with no camera pan or zoom, that crop keeps the column whole.
//! The layout is shared; each platform draws the text with its own
//! `TextRenderer` and a font the system already has, so Videorc ships no
//! font file. A platform with no renderer gets stills with no text; the
//! camera's detail line still says what it waits for.

#[cfg(target_os = "macos")]
mod core_text;

pub const STILL_WIDTH: u32 = 1280;
pub const STILL_HEIGHT: u32 = 720;
const BACKGROUND: [u8; 3] = [0x1c, 0x1a, 0x1a];
const TEXT: [u8; 3] = [0xd8, 0xd8, 0xd8];
const TEXT_PX: f32 = 40.0;
/// Room left on each side of the text, inside the column.
const COLUMN_MARGIN: f32 = 16.0;
const LINE_SPACING: f32 = 1.3;

/// Text coverage, one byte per pixel (0 none, 255 full), top row first.
pub struct Mask {
    pub width: usize,
    pub height: usize,
    pub coverage: Vec<u8>,
}

impl Mask {
    fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            coverage: vec![0; width * height],
        }
    }
}

/// How one platform measures and draws the stills' text.
pub trait TextRenderer: Sync {
    /// The font's ascent and descent at `px`, both positive, in pixels.
    fn vertical_metrics(&self, px: f32) -> (f32, f32);
    /// How wide `text` is at `px`, in pixels.
    fn line_width(&self, text: &str, px: f32) -> f32;
    /// Draws `text` at `px` into `mask`, its left end at `x` and its
    /// baseline `baseline` pixels from the top.
    fn draw_line(&self, mask: &mut Mask, text: &str, px: f32, x: f32, baseline: f32);
}

/// This platform's renderer, or None where the stills have no text yet.
fn system_renderer() -> Option<&'static dyn TextRenderer> {
    #[cfg(target_os = "macos")]
    {
        Some(&core_text::CoreText)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// A BGRA still of `width`×`height` with `text` centred, wrapped to fit.
/// `mirrored` flips it, so a mirrored camera shows the text the right way.
pub fn render_still(width: u32, height: u32, text: &str, mirrored: bool) -> Vec<u8> {
    render_still_with(system_renderer(), width, height, text, mirrored)
}

pub fn render_still_with(
    renderer: Option<&dyn TextRenderer>,
    width: u32,
    height: u32,
    text: &str,
    mirrored: bool,
) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let mut mask = Mask::new(w, h);
    if let Some(renderer) = renderer {
        draw_centred(renderer, &mut mask, text);
    }
    let mut bgra = Vec::with_capacity(w * h * 4);
    for &coverage in &mask.coverage {
        let ink = f32::from(coverage) / 255.0;
        let mix = |channel: usize| {
            let ground = f32::from(BACKGROUND[channel]);
            (ground + (f32::from(TEXT[channel]) - ground) * ink).round() as u8
        };
        bgra.extend_from_slice(&[mix(2), mix(1), mix(0), 255]);
    }
    if mirrored {
        for row in bgra.chunks_exact_mut(w * 4) {
            row.as_chunks_mut::<4>().0.reverse();
        }
    }
    bgra
}

/// Words go on one line while they fit; a word wider than the room
/// shrinks the text for every line.
fn wrap(renderer: &dyn TextRenderer, text: &str, room: f32) -> (Vec<String>, f32) {
    let mut lines: Vec<String> = Vec::new();
    for word in text.split_whitespace() {
        match lines.last_mut() {
            Some(line) if renderer.line_width(&format!("{line} {word}"), TEXT_PX) <= room => {
                line.push(' ');
                line.push_str(word);
            }
            _ => lines.push(word.to_string()),
        }
    }
    let widest = lines
        .iter()
        .map(|line| renderer.line_width(line, TEXT_PX))
        .fold(0.0, f32::max);
    let px = if widest > room {
        TEXT_PX * room / widest
    } else {
        TEXT_PX
    };
    (lines, px)
}

/// The widest 9:16 column that fits in the middle of the still.
fn column_width(w: usize, h: usize) -> f32 {
    (w as f32).min(h as f32 * 9.0 / 16.0)
}

fn draw_centred(renderer: &dyn TextRenderer, mask: &mut Mask, text: &str) {
    let (w, h) = (mask.width as f32, mask.height as f32);
    let room = (column_width(mask.width, mask.height) - 2.0 * COLUMN_MARGIN).max(1.0);
    let (lines, px) = wrap(renderer, text, room);
    let (ascent, descent) = renderer.vertical_metrics(px);
    let line_height = (ascent + descent) * LINE_SPACING;
    let block = line_height * lines.len().saturating_sub(1) as f32;
    let first_baseline = (h - block + ascent - descent) / 2.0;
    for (index, line) in lines.iter().enumerate() {
        let x = (w - renderer.line_width(line, px)) / 2.0;
        let baseline = first_baseline + line_height * index as f32;
        renderer.draw_line(mask, line, px, x, baseline);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A renderer of solid boxes: every character is `px / 2` wide and
    /// fills its box from the ascent to the descent.
    struct Boxes;

    impl TextRenderer for Boxes {
        fn vertical_metrics(&self, px: f32) -> (f32, f32) {
            (px * 0.8, px * 0.2)
        }

        fn line_width(&self, text: &str, px: f32) -> f32 {
            text.chars().count() as f32 * px / 2.0
        }

        fn draw_line(&self, mask: &mut Mask, text: &str, px: f32, x: f32, baseline: f32) {
            let (ascent, descent) = self.vertical_metrics(px);
            let left = x.round().max(0.0) as usize;
            let right = ((x + self.line_width(text, px)).round() as usize).min(mask.width);
            let top = (baseline - ascent).round().max(0.0) as usize;
            let bottom = ((baseline + descent).round() as usize).min(mask.height);
            for row in top..bottom {
                mask.coverage[row * mask.width + left..row * mask.width + right].fill(255);
            }
        }
    }

    fn lit(bgra: &[u8]) -> impl Iterator<Item = usize> + '_ {
        bgra.chunks_exact(4)
            .enumerate()
            .filter(|(_, pixel)| pixel[0] > 0x80)
            .map(|(index, _)| index)
    }

    fn lit_columns(bgra: &[u8], width: usize) -> Vec<usize> {
        let mut columns: Vec<usize> = lit(bgra).map(|index| index % width).collect();
        columns.sort_unstable();
        columns.dedup();
        columns
    }

    fn lit_rows(bgra: &[u8], width: usize) -> Vec<usize> {
        let mut rows: Vec<usize> = lit(bgra).map(|index| index / width).collect();
        rows.dedup();
        rows
    }

    const LONG: &str = "This SRT stream uses a codec Videorc can't show (stream type 0x42).";

    #[test]
    fn srt_still_without_a_renderer_is_the_plain_background() {
        let bgra = render_still_with(None, 4, 2, "Waiting", false);
        assert_eq!(bgra.len(), 4 * 2 * 4);
        assert!(
            bgra.chunks_exact(4)
                .all(|pixel| pixel == [BACKGROUND[2], BACKGROUND[1], BACKGROUND[0], 255])
        );
    }

    #[test]
    fn srt_still_centres_its_text() {
        let (width, height) = (STILL_WIDTH as usize, STILL_HEIGHT as usize);
        let bgra = render_still_with(Some(&Boxes), STILL_WIDTH, STILL_HEIGHT, "Waiting", false);
        let columns = lit_columns(&bgra, width);
        let rows = lit_rows(&bgra, width);
        let middle = |first: usize, last: usize| (first + last) as f32 / 2.0;
        assert!((middle(columns[0], *columns.last().unwrap()) - width as f32 / 2.0).abs() <= 1.0);
        assert!((middle(rows[0], *rows.last().unwrap()) - height as f32 / 2.0).abs() <= 1.0);
        assert!(bgra.chunks_exact(4).all(|pixel| pixel[3] == 255));
    }

    #[test]
    fn srt_still_wraps_a_long_line_inside_the_middle_column() {
        let (width, height) = (STILL_WIDTH as usize, STILL_HEIGHT as usize);
        let bgra = render_still_with(Some(&Boxes), STILL_WIDTH, STILL_HEIGHT, LONG, false);
        let column = column_width(width, height);
        let left = (width as f32 - column) / 2.0 + COLUMN_MARGIN - 1.0;
        let right = (width as f32 + column) / 2.0 - COLUMN_MARGIN + 1.0;
        let columns = lit_columns(&bgra, width);
        assert!(columns[0] as f32 >= left, "inside the column on the left");
        assert!(*columns.last().unwrap() as f32 <= right, "and on the right");
        let rows = lit_rows(&bgra, width);
        assert!(
            rows.last().unwrap() - rows[0] > TEXT_PX as usize,
            "several lines, not one shrunk line"
        );
    }

    #[test]
    fn srt_still_shrinks_a_word_wider_than_the_column() {
        let width = 200;
        let bgra = render_still_with(
            Some(&Boxes),
            width,
            400,
            "Waaaaaaaaaaaaaaaaaaaaaaaaiting",
            false,
        );
        let columns = lit_columns(&bgra, width as usize);
        let room = column_width(width as usize, 400) - 2.0 * COLUMN_MARGIN;
        assert!((columns.last().unwrap() - columns[0]) as f32 <= room + 1.0);
    }

    #[test]
    fn srt_still_mirrored_is_the_plain_still_flipped() {
        let (width, height) = (320, 180);
        let plain = render_still_with(Some(&Boxes), width, height, "Wait", false);
        let mirrored = render_still_with(Some(&Boxes), width, height, "Wait", true);
        for (plain_row, mirrored_row) in plain
            .chunks_exact(width as usize * 4)
            .zip(mirrored.chunks_exact(width as usize * 4))
        {
            let mut flipped = plain_row.as_chunks::<4>().0.to_vec();
            flipped.reverse();
            assert_eq!(flipped.as_flattened(), mirrored_row);
        }
    }

    /// The platform's own renderer, where there is one, draws real text
    /// inside the column.
    #[test]
    fn srt_still_draws_system_text_in_the_middle() {
        let Some(renderer) = system_renderer() else {
            return;
        };
        let (width, height) = (STILL_WIDTH as usize, STILL_HEIGHT as usize);
        let bgra = render_still_with(Some(renderer), STILL_WIDTH, STILL_HEIGHT, LONG, false);
        let rows = lit_rows(&bgra, width);
        assert!(!rows.is_empty(), "the system renderer drew nothing");
        assert!(rows[0] > 10 && *rows.last().unwrap() < height - 10);
        let columns = lit_columns(&bgra, width);
        let column = column_width(width, height);
        assert!(columns[0] as f32 >= (width as f32 - column) / 2.0);
        assert!(*columns.last().unwrap() as f32 <= (width as f32 + column) / 2.0);
    }
}
