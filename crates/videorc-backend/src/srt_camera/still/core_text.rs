//! The stills' text on macOS: CoreText with the system UI font.

use std::ffi::c_void;
use std::ptr;

use objc2_core_foundation::{
    CFAttributedString, CFBoolean, CFDictionary, CFRetained, CFString, CFType,
};
use objc2_core_graphics::{CGBitmapContextCreate, CGColorSpace, CGContext, CGImageAlphaInfo};
use objc2_core_text::{
    CTFont, CTFontUIFontType, CTLine, kCTFontAttributeName,
    kCTForegroundColorFromContextAttributeName,
};

use super::{Mask, TextRenderer};

pub struct CoreText;

fn font(px: f32) -> Option<CFRetained<CTFont>> {
    // SAFETY: a plain constructor; no language means the user's own.
    unsafe { CTFont::new_ui_font_for_language(CTFontUIFontType::System, f64::from(px), None) }
}

/// One line of `text` in the system font at `px`, drawn in the context's
/// fill colour.
fn line(text: &str, px: f32) -> Option<CFRetained<CTLine>> {
    let font = font(px)?;
    let attributes = CFDictionary::<CFType, CFType>::from_slices(
        &[
            // SAFETY: CoreText's attribute keys are constant strings.
            unsafe { kCTFontAttributeName }.as_ref(),
            unsafe { kCTForegroundColorFromContextAttributeName }.as_ref(),
        ],
        &[font.as_ref(), CFBoolean::new(true).as_ref()],
    );
    let string = CFString::from_str(text);
    // SAFETY: the string and the dictionary of CoreText attributes outlive
    // the call; the attributed string copies what it keeps.
    let attributed =
        unsafe { CFAttributedString::new(None, Some(&string), Some(attributes.as_opaque())) }?;
    // SAFETY: a plain constructor from a valid attributed string.
    Some(unsafe { CTLine::with_attributed_string(&attributed) })
}

impl TextRenderer for CoreText {
    fn vertical_metrics(&self, px: f32) -> (f32, f32) {
        let Some(font) = font(px) else {
            return (px * 0.8, px * 0.2);
        };
        // SAFETY: plain queries on a live font.
        let (ascent, descent) = unsafe { (font.ascent(), font.descent()) };
        (ascent as f32, descent as f32)
    }

    fn line_width(&self, text: &str, px: f32) -> f32 {
        let Some(line) = line(text, px) else {
            return 0.0;
        };
        // SAFETY: null out-pointers are allowed; only the width is read.
        let width =
            unsafe { line.typographic_bounds(ptr::null_mut(), ptr::null_mut(), ptr::null_mut()) };
        width as f32
    }

    fn draw_line(&self, mask: &mut Mask, text: &str, px: f32, x: f32, baseline: f32) {
        let Some(line) = line(text, px) else {
            return;
        };
        let Some(gray) = CGColorSpace::new_device_gray() else {
            return;
        };
        // SAFETY: the context draws into `mask.coverage`, one byte per pixel
        // and `width` bytes per row, and is dropped before the mask is read.
        let Some(context) = (unsafe {
            CGBitmapContextCreate(
                mask.coverage.as_mut_ptr().cast::<c_void>(),
                mask.width,
                mask.height,
                8,
                mask.width,
                Some(&gray),
                CGImageAlphaInfo::None.0,
            )
        }) else {
            return;
        };
        CGContext::set_gray_fill_color(Some(&context), 1.0, 1.0);
        // CoreGraphics counts y from the bottom row.
        CGContext::set_text_position(
            Some(&context),
            f64::from(x),
            mask.height as f64 - f64::from(baseline),
        );
        // SAFETY: a live line drawn into a live context.
        unsafe { line.draw(&context) };
    }
}
