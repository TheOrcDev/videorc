//! The SRT Camera's stills (plan 255 D7, D12): a dark frame with centred
//! text, wrapped into a 9:16 column in the middle.
//! A portrait canvas, a vertical leg or a square box crops a camera to its
//! middle; with no camera pan or zoom, that crop keeps the column whole.
//! The text is drawn with a font the system already has, so Videorc ships
//! no font file. With none found the still has no text; the camera's detail
//! line still says what it waits for.

use ab_glyph::{Font, FontVec, PxScale, ScaleFont, point};
use std::sync::OnceLock;

pub const STILL_WIDTH: u32 = 1280;
pub const STILL_HEIGHT: u32 = 720;
const BACKGROUND: [u8; 3] = [0x1c, 0x1a, 0x1a];
const TEXT: [u8; 3] = [0xd8, 0xd8, 0xd8];
const TEXT_PX: f32 = 40.0;
/// Room left on each side of the text, inside the column.
const COLUMN_MARGIN: f32 = 16.0;
const LINE_SPACING: f32 = 1.3;

/// System fonts to try, in order, per platform.
fn font_candidates() -> &'static [(&'static str, u32)] {
    if cfg!(target_os = "macos") {
        &[
            ("/System/Library/Fonts/SFNS.ttf", 0),
            ("/System/Library/Fonts/Helvetica.ttc", 0),
            ("/System/Library/Fonts/Geneva.ttf", 0),
        ]
    } else if cfg!(target_os = "windows") {
        &[
            ("C:\\Windows\\Fonts\\segoeui.ttf", 0),
            ("C:\\Windows\\Fonts\\arial.ttf", 0),
        ]
    } else {
        &[
            ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 0),
            ("/usr/share/fonts/TTF/DejaVuSans.ttf", 0),
        ]
    }
}

fn system_font() -> Option<&'static FontVec> {
    static FONT: OnceLock<Option<FontVec>> = OnceLock::new();
    FONT.get_or_init(|| {
        font_candidates().iter().find_map(|(path, index)| {
            let bytes = std::fs::read(path).ok()?;
            FontVec::try_from_vec_and_index(bytes, *index).ok()
        })
    })
    .as_ref()
}

/// A BGRA still of `width`×`height` with `text` centred, wrapped to fit.
/// `mirrored` flips it, so a mirrored camera shows the text the right way.
pub fn render_still(width: u32, height: u32, text: &str, mirrored: bool) -> Vec<u8> {
    render_still_with(system_font(), width, height, text, mirrored)
}

pub fn render_still_with(
    font: Option<&FontVec>,
    width: u32,
    height: u32,
    text: &str,
    mirrored: bool,
) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let mut bgra = Vec::with_capacity(w * h * 4);
    for _ in 0..w * h {
        bgra.extend_from_slice(&[BACKGROUND[2], BACKGROUND[1], BACKGROUND[0], 255]);
    }
    if let Some(font) = font {
        draw_centred(font, &mut bgra, w, h, text);
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
fn wrap(font: &FontVec, text: &str, room: f32) -> (Vec<String>, PxScale) {
    let full = PxScale::from(TEXT_PX);
    let mut lines: Vec<String> = Vec::new();
    for word in text.split_whitespace() {
        match lines.last_mut() {
            Some(line) if line_width(font, full, &format!("{line} {word}")) <= room => {
                line.push(' ');
                line.push_str(word);
            }
            _ => lines.push(word.to_string()),
        }
    }
    let widest = lines
        .iter()
        .map(|line| line_width(font, full, line))
        .fold(0.0, f32::max);
    let px = if widest > room {
        TEXT_PX * room / widest
    } else {
        TEXT_PX
    };
    (lines, PxScale::from(px))
}

/// The widest 9:16 column that fits in the middle of the still.
fn column_width(w: usize, h: usize) -> f32 {
    (w as f32).min(h as f32 * 9.0 / 16.0)
}

fn draw_centred(font: &FontVec, bgra: &mut [u8], w: usize, h: usize, text: &str) {
    let room = (column_width(w, h) - 2.0 * COLUMN_MARGIN).max(1.0);
    let (lines, scale) = wrap(font, text, room);
    let scaled = font.as_scaled(scale);
    let line_height = scaled.height() * LINE_SPACING;
    let block = line_height * lines.len().saturating_sub(1) as f32;
    let first_baseline = (h as f32 - block + scaled.ascent() + scaled.descent()) / 2.0;
    for (index, line) in lines.iter().enumerate() {
        let baseline = first_baseline + line_height * index as f32;
        draw_line(font, scale, bgra, w, h, line, baseline);
    }
}

fn draw_line(
    font: &FontVec,
    scale: PxScale,
    bgra: &mut [u8],
    w: usize,
    h: usize,
    text: &str,
    baseline: f32,
) {
    let scaled = font.as_scaled(scale);
    let mut x = (w as f32 - line_width(font, scale, text)) / 2.0;
    let mut previous = None;
    for character in text.chars() {
        let id = scaled.glyph_id(character);
        if let Some(previous) = previous {
            x += scaled.kern(previous, id);
        }
        let glyph = id.with_scale_and_position(scale, point(x, baseline));
        x += scaled.h_advance(id);
        previous = Some(id);
        let Some(outline) = font.outline_glyph(glyph) else {
            continue;
        };
        let bounds = outline.px_bounds();
        outline.draw(|gx, gy, coverage| {
            let px = bounds.min.x as i64 + i64::from(gx);
            let py = bounds.min.y as i64 + i64::from(gy);
            if px < 0 || py < 0 || px as usize >= w || py as usize >= h {
                return;
            }
            let offset = (py as usize * w + px as usize) * 4;
            let coverage = coverage.clamp(0.0, 1.0);
            for (channel, (&ink, &ground)) in [TEXT[2], TEXT[1], TEXT[0]]
                .iter()
                .zip(&[BACKGROUND[2], BACKGROUND[1], BACKGROUND[0]])
                .enumerate()
            {
                let mixed = f32::from(ground) + (f32::from(ink) - f32::from(ground)) * coverage;
                let current = &mut bgra[offset + channel];
                *current = (*current).max(mixed.round() as u8);
            }
        });
    }
}

fn line_width(font: &FontVec, scale: PxScale, text: &str) -> f32 {
    let scaled = font.as_scaled(scale);
    let mut width = 0.0;
    let mut previous = None;
    for character in text.chars() {
        let id = scaled.glyph_id(character);
        if let Some(previous) = previous {
            width += scaled.kern(previous, id);
        }
        width += scaled.h_advance(id);
        previous = Some(id);
    }
    width
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_still_without_a_font_is_the_plain_background() {
        let bgra = render_still_with(None, 4, 2, "Waiting", false);
        assert_eq!(bgra.len(), 4 * 2 * 4);
        assert!(
            bgra.chunks_exact(4)
                .all(|pixel| pixel == [BACKGROUND[2], BACKGROUND[1], BACKGROUND[0], 255])
        );
    }

    #[test]
    fn srt_still_draws_its_text_in_the_middle_when_a_font_exists() {
        let Some(font) = system_font() else {
            eprintln!("no system font on this machine; text drawing not checked");
            return;
        };
        let bgra = render_still_with(
            Some(font),
            STILL_WIDTH,
            STILL_HEIGHT,
            "Waiting for SRT",
            false,
        );
        let lit = |row: usize| {
            bgra[row * STILL_WIDTH as usize * 4..(row + 1) * STILL_WIDTH as usize * 4]
                .chunks_exact(4)
                .filter(|pixel| pixel[0] > 0x80)
                .count()
        };
        assert!(
            lit(STILL_HEIGHT as usize / 2) > 0,
            "text crosses the middle row"
        );
        assert_eq!(lit(10), 0, "nothing near the top");
        assert!(bgra.chunks_exact(4).all(|pixel| pixel[3] == 255));
    }

    fn lit_columns(bgra: &[u8], width: usize) -> Vec<usize> {
        let mut columns: Vec<usize> = bgra
            .chunks_exact(4)
            .enumerate()
            .filter(|(_, pixel)| pixel[0] > 0x80)
            .map(|(index, _)| index % width)
            .collect();
        columns.sort_unstable();
        columns.dedup();
        columns
    }

    fn lit_rows(bgra: &[u8], width: usize) -> Vec<usize> {
        let mut rows: Vec<usize> = bgra
            .chunks_exact(4)
            .enumerate()
            .filter(|(_, pixel)| pixel[0] > 0x80)
            .map(|(index, _)| index / width)
            .collect();
        rows.dedup();
        rows
    }

    const LONG: &str = "This SRT stream uses a codec Videorc can't show (stream type 0x42).";

    #[test]
    fn srt_still_wraps_a_long_line_inside_the_middle_column() {
        let Some(font) = system_font() else {
            return;
        };
        let (width, height) = (STILL_WIDTH as usize, STILL_HEIGHT as usize);
        let bgra = render_still_with(Some(font), STILL_WIDTH, STILL_HEIGHT, LONG, false);
        let column = column_width(width, height);
        let left = (width as f32 - column) / 2.0 + COLUMN_MARGIN - 2.0;
        let right = (width as f32 + column) / 2.0 - COLUMN_MARGIN + 2.0;
        let columns = lit_columns(&bgra, width);
        assert!(!columns.is_empty());
        assert!(columns[0] as f32 >= left, "inside the column on the left");
        assert!(*columns.last().unwrap() as f32 <= right, "and on the right");
        let rows = lit_rows(&bgra, width);
        assert!(
            rows.last().unwrap() - rows[0] > TEXT_PX as usize,
            "several lines, not one shrunk line"
        );
    }

    #[test]
    fn srt_still_mirrored_is_the_plain_still_flipped() {
        let Some(font) = system_font() else {
            return;
        };
        let (width, height) = (320, 180);
        let plain = render_still_with(Some(font), width, height, "Waiting", false);
        let mirrored = render_still_with(Some(font), width, height, "Waiting", true);
        assert_ne!(plain, mirrored);
        for (plain_row, mirrored_row) in plain
            .chunks_exact(width as usize * 4)
            .zip(mirrored.chunks_exact(width as usize * 4))
        {
            let mut flipped = plain_row.as_chunks::<4>().0.to_vec();
            flipped.reverse();
            assert_eq!(flipped.as_flattened(), mirrored_row);
        }
    }
}
