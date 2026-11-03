//! The "Videorc isn't running" still (plan 214 C1, D12 on Windows): what the
//! camera shows while the ring is absent or stale. Pure Rust: a dark NV12
//! frame with the title drawn from a small bitmap font, so the media source
//! needs no GDI and the still is testable on any OS.

/// The one line the still shows (the identifiers file's `notRunningTitle`).
pub const NOT_RUNNING_TITLE: &str = "Videorc isn't running";

/// BT.709 video range: a dark gray background, white text, neutral chroma.
const BACKGROUND_Y: u8 = 28;
const TEXT_Y: u8 = 235;
const NEUTRAL_UV: u8 = 128;

const GLYPH_WIDTH: usize = 5;
const GLYPH_HEIGHT: usize = 7;
/// One blank column between glyphs.
const GLYPH_ADVANCE: usize = GLYPH_WIDTH + 1;

/// 5×7 glyphs, one byte per row, bit 4 the leftmost pixel. Only what the
/// title needs plus a box for anything else.
fn glyph(character: char) -> [u8; GLYPH_HEIGHT] {
    match character {
        ' ' => [0, 0, 0, 0, 0, 0, 0],
        '\'' => [0b00100, 0b00100, 0b01000, 0, 0, 0, 0],
        'V' => [
            0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100,
        ],
        'c' => [0, 0, 0b01110, 0b10000, 0b10000, 0b10001, 0b01110],
        'd' => [
            0b00001, 0b00001, 0b01101, 0b10011, 0b10001, 0b10011, 0b01101,
        ],
        'e' => [0, 0, 0b01110, 0b10001, 0b11111, 0b10000, 0b01110],
        'g' => [0, 0, 0b01111, 0b10001, 0b01111, 0b00001, 0b01110],
        'i' => [0b00100, 0, 0b01100, 0b00100, 0b00100, 0b00100, 0b01110],
        'n' => [0, 0, 0b10110, 0b11001, 0b10001, 0b10001, 0b10001],
        'o' => [0, 0, 0b01110, 0b10001, 0b10001, 0b10001, 0b01110],
        'r' => [0, 0, 0b10110, 0b11001, 0b10000, 0b10000, 0b10000],
        's' => [0, 0, 0b01111, 0b10000, 0b01110, 0b00001, 0b11110],
        't' => [
            0b01000, 0b01000, 0b11100, 0b01000, 0b01000, 0b01001, 0b00110,
        ],
        'u' => [0, 0, 0b10001, 0b10001, 0b10001, 0b10011, 0b01101],
        _ => [
            0b11111, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11111,
        ],
    }
}

/// Where the title lands in a `width`×`height` frame: the pixel scale of
/// one glyph cell and the top-left corner of the text block.
fn text_placement(width: usize, height: usize, text: &str) -> (usize, usize, usize) {
    let characters = text.chars().count().max(1);
    let scale_for_height = height / 135;
    let scale_for_width = width / (characters * GLYPH_ADVANCE + 2 * GLYPH_ADVANCE);
    let scale = scale_for_height.min(scale_for_width).max(1);
    let text_width = characters * GLYPH_ADVANCE * scale;
    let text_height = GLYPH_HEIGHT * scale;
    let x = width.saturating_sub(text_width) / 2;
    let y = height.saturating_sub(text_height) / 2;
    (scale, x, y)
}

/// A tightly packed NV12 frame that says "Videorc isn't running".
pub fn not_running_still(width: u32, height: u32) -> Vec<u8> {
    still_with_title(width, height, NOT_RUNNING_TITLE)
}

/// A dark NV12 frame with `title` centred.
pub fn still_with_title(width: u32, height: u32, title: &str) -> Vec<u8> {
    let (width, height) = (width as usize, height as usize);
    let luma_len = width * height;
    let chroma_len = width.div_ceil(2) * 2 * height.div_ceil(2);
    let mut frame = vec![NEUTRAL_UV; luma_len + chroma_len];
    frame[..luma_len].fill(BACKGROUND_Y);
    if width == 0 || height == 0 {
        return frame;
    }
    let (scale, left, top) = text_placement(width, height, title);
    for (index, character) in title.chars().enumerate() {
        let rows = glyph(character);
        let cell_x = left + index * GLYPH_ADVANCE * scale;
        for (row, bits) in rows.iter().enumerate() {
            for column in 0..GLYPH_WIDTH {
                if bits & (1 << (GLYPH_WIDTH - 1 - column)) == 0 {
                    continue;
                }
                let x0 = cell_x + column * scale;
                let y0 = top + row * scale;
                for y in y0..(y0 + scale).min(height) {
                    let line = &mut frame[y * width..(y + 1) * width];
                    let end = (x0 + scale).min(width);
                    if x0 < end {
                        line[x0..end].fill(TEXT_Y);
                    }
                }
            }
        }
    }
    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_still_is_one_nv12_frame_with_neutral_chroma() {
        let still = not_running_still(1920, 1080);
        assert_eq!(still.len(), 1920 * 1080 * 3 / 2);
        assert!(still[1920 * 1080..].iter().all(|byte| *byte == NEUTRAL_UV));
    }

    #[test]
    fn the_title_sits_in_the_middle_on_a_dark_background() {
        let (width, height) = (1920usize, 1080usize);
        let still = not_running_still(width as u32, height as u32);
        let luma = &still[..width * height];
        let row = |y: usize| &luma[y * width..(y + 1) * width];
        assert!(
            row(0).iter().all(|byte| *byte == BACKGROUND_Y),
            "top row is background"
        );
        assert!(row(height - 1).iter().all(|byte| *byte == BACKGROUND_Y));
        let middle = row(height / 2);
        assert!(middle.contains(&TEXT_Y), "text crosses the middle row");
        assert!(
            middle[..200].iter().all(|byte| *byte == BACKGROUND_Y),
            "centred, not flush left"
        );
        assert!(
            middle[width - 200..]
                .iter()
                .all(|byte| *byte == BACKGROUND_Y)
        );
        let (scale, left, top) = text_placement(width, height, NOT_RUNNING_TITLE);
        assert_eq!(scale, 8);
        let text_width = NOT_RUNNING_TITLE.chars().count() * GLYPH_ADVANCE * scale;
        assert_eq!(left, (width - text_width) / 2);
        assert_eq!(top, (height - GLYPH_HEIGHT * scale) / 2);
        // The capital V's top-left pixel block is lit, the gap column is not.
        assert_eq!(luma[top * width + left], TEXT_Y);
        assert_eq!(luma[top * width + left + GLYPH_WIDTH * scale], BACKGROUND_Y);
    }

    #[test]
    fn every_title_character_has_a_glyph_of_its_own() {
        let box_glyph = glyph('#');
        for character in NOT_RUNNING_TITLE.chars() {
            assert_ne!(
                glyph(character),
                box_glyph,
                "{character:?} falls back to the box"
            );
        }
    }

    #[test]
    fn a_tiny_frame_still_fits_the_title() {
        let still = still_with_title(64, 32, NOT_RUNNING_TITLE);
        assert_eq!(still.len(), 64 * 32 * 3 / 2);
        let (scale, left, _) = text_placement(64, 32, NOT_RUNNING_TITLE);
        assert_eq!(scale, 1);
        assert_eq!(left, 0, "wider than the frame: flush left, never panics");
    }
}
