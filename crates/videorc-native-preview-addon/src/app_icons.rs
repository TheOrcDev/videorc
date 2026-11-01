//! Resolve bundle ids and render app icons without a shell or filesystem
//! search. Everything runs on the main thread: Electron's `app.getFileIcon`
//! rasterises the NSImage on a thread-pool worker, and AppKit traps there on
//! macOS 26 (plan 210 S4 crash), so main never calls it.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use objc2::exception::catch;
use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSCalibratedRGBColorSpace, NSCompositingOperation,
    NSGraphicsContext, NSWorkspace,
};
use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};

const MIN_PIXELS: u32 = 16;
const MAX_PIXELS: u32 = 256;

fn main_thread() -> Result<MainThreadMarker> {
    MainThreadMarker::new().ok_or_else(|| Error::from_reason("App icons require the main thread"))
}

fn valid_bundle_id(bundle_id: &str) -> bool {
    !bundle_id.is_empty() && bundle_id.len() <= 512
}

fn app_path(bundle_id: &str) -> Option<String> {
    let url = NSWorkspace::sharedWorkspace()
        .URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle_id))?;
    url.path().map(|path| path.to_string())
}

#[napi]
pub fn app_path_for_bundle_id(bundle_id: String) -> Result<Option<String>> {
    main_thread()?;
    if !valid_bundle_id(&bundle_id) {
        return Ok(None);
    }
    Ok(catch(|| app_path(&bundle_id)).ok().flatten())
}

/// The app's icon as PNG bytes, `pixels`×`pixels` (clamped to 16..=256), drawn
/// on the main thread. `None` for an app that is not installed or an icon AppKit
/// cannot draw; an Objective-C exception is a miss, never a crash.
#[napi]
pub fn app_icon_png_for_bundle_id(bundle_id: String, pixels: u32) -> Result<Option<Buffer>> {
    main_thread()?;
    if !valid_bundle_id(&bundle_id) {
        return Ok(None);
    }
    let pixels = pixels.clamp(MIN_PIXELS, MAX_PIXELS);
    let png = catch(|| render_icon_png(&bundle_id, pixels)).ok().flatten();
    Ok(png.map(Buffer::from))
}

fn render_icon_png(bundle_id: &str, pixels: u32) -> Option<Vec<u8>> {
    let path = app_path(bundle_id)?;
    let icon = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(&path));
    let side = pixels as isize;
    // AppKit allocates and owns the pixel storage (null planes). Premultiplied
    // RGBA: CoreGraphics refuses a drawing context over a non-premultiplied
    // 8-bit bitmap, and the PNG encoder un-premultiplies on export.
    let bitmap = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            std::ptr::null_mut(),
            side,
            side,
            8,
            4,
            true,
            false,
            NSCalibratedRGBColorSpace,
            side * 4,
            32,
        )
    }?;
    bitmap.setSize(NSSize::new(pixels as f64, pixels as f64));
    let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&bitmap)?;
    let target = NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(pixels as f64, pixels as f64),
    );
    let whole = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0));
    NSGraphicsContext::saveGraphicsState_class();
    NSGraphicsContext::setCurrentContext(Some(&context));
    icon.drawInRect_fromRect_operation_fraction(
        target,
        whole,
        NSCompositingOperation::SourceOver,
        1.0,
    );
    context.flushGraphics();
    NSGraphicsContext::restoreGraphicsState_class();
    let data = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }?;
    Some(data.to_vec())
}
