//! macOS: the preview's layer in a GPUI `NativeView` (plan 260 S2.3a).
//!
//! What S0.1 measured (`spikes/gpui/spike-preview-backend`, #1718): a
//! layer-hosting `NSView` with a flipped root layer goes to `NativeView`,
//! the element attaches its `CAMetalLayer` to that view (not to the window's
//! GPUI view), and the layer then follows the view in the same Core
//! Animation transaction GPUI moves it in (an autoresizing mask), with the
//! slot's corner radius on the layer itself (a native view ignores GPUI's
//! clipping). GPUI paints the scene editor's chrome over it.

use std::ffi::c_void;
use std::ptr::NonNull;

use gpui::{App, Bounds, NativeView, Pixels, Window};
use objc2::rc::Retained;
use objc2::{ClassType, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::NSView;
use objc2_foundation::{NSObjectProtocol, NSPoint, NSRect, NSSize};
use objc2_quartz_core::{CAAutoresizingMask, CALayer, CAMetalLayer, CATransaction};
use raw_window_handle::{
    AppKitWindowHandle, HandleError, HasWindowHandle, RawWindowHandle, WindowHandle as RawHandle,
};
use videorc_kit::theme::hsla;
use videorc_kit::tokens::DARK;
use videorc_preview::bounds::WindowGeometry;

/// One place the layer can live: the `NSView` given to GPUI, and GPUI's
/// handle on it (the element to paint where the video shows).
pub struct HostView {
    pub view: Retained<NSView>,
    pub native: NativeView,
}

impl HostView {
    /// A host in `window`. Main thread only; GPUI retains the view and
    /// decides its frame, visibility and stacking from now on.
    pub fn new(window: &mut Window, cx: &mut App) -> Result<Self, String> {
        let mtm = MainThreadMarker::new().ok_or("the preview host needs the main thread")?;
        let view = make_host_view(mtm);
        // SAFETY: a live NSView in no hierarchy; GPUI retains it.
        let native = unsafe { NativeView::new(NonNull::from(&*view).cast(), window, cx) }
            .map_err(|error| format!("GPUI could not host the preview: {error:#}"))?;
        // What shows for a frame or two while GPUI moves the view: the
        // slot's own black.
        native.set_background(hsla(DARK.video_ground), cx);
        // The video takes no mouse input, as Electron's preview window
        // (`setIgnoresMouseEvents`): the scroll wheel over the docked slot
        // scrolls the page, and a press reaches what is behind the slot.
        native.set_ignores_mouse(true, cx);
        Ok(Self { view, native })
    }
}

/// A raw AppKit handle on one `NSView`: what `PreviewElement::attach`
/// takes, so the element adds its layer to the host view and not to the
/// window's GPUI view.
pub struct ViewHost(NonNull<c_void>);

impl ViewHost {
    pub fn of(view: &NSView) -> Self {
        Self(NonNull::from(view).cast())
    }
}

impl HasWindowHandle for ViewHost {
    fn window_handle(&self) -> Result<RawHandle<'_>, HandleError> {
        let handle = AppKitWindowHandle::new(self.0);
        // SAFETY: the view outlives this borrow (its `HostView` keeps it).
        Ok(unsafe { RawHandle::borrow_raw(RawWindowHandle::AppKit(handle)) })
    }
}

/// A layer-hosting `NSView` whose root layer is flipped (top-left origin),
/// so the element's sublayer keeps its place whatever height GPUI gives the
/// view.
fn make_host_view(mtm: MainThreadMarker) -> Retained<NSView> {
    let view = NSView::initWithFrame(
        NSView::alloc(mtm),
        NSRect::new(NSPoint::new(0., 0.), NSSize::new(640., 360.)),
    );
    let root = CALayer::new();
    root.setGeometryFlipped(true);
    view.setLayer(Some(&root));
    view.setWantsLayer(true);
    view
}

/// After `PreviewElement::attach` (or a native path reset): the element's
/// `CAMetalLayer` keeps the frame the element gives it (the slot) and its
/// top-left corner when GPUI resizes the view, and gets the host's corner
/// radius. False when no layer was
/// found (the element is not attached here).
pub fn tune_video_layer(host: &NSView, radius: f64) -> bool {
    let Some(root) = host.layer() else {
        return false;
    };
    // SAFETY: reading the sublayers of a layer this app owns, on the main
    // thread.
    let Some(sublayers) = (unsafe { root.sublayers() }) else {
        return false;
    };
    // The layer keeps its size and its top-left corner when the host view
    // resizes: the element sets its frame to the slot, often while the host
    // still has its old size, so a width/height-sizable layer took the
    // host's resize on top of that (L6 11-25: 574 shown for a 607 slot, 1280
    // in a 960 window). Unflipped, the origin is the bottom-left, so the
    // bottom margin flexes to hold the top.
    let mask = if root.isGeometryFlipped() {
        CAAutoresizingMask::LayerNotSizable
    } else {
        CAAutoresizingMask::LayerMinYMargin
    };
    let mut found = false;
    for layer in sublayers.iter() {
        if layer.isKindOfClass(CAMetalLayer::class()) {
            CATransaction::begin();
            CATransaction::setDisableActions(true);
            layer.setAutoresizingMask(mask);
            layer.setCornerRadius(radius);
            layer.setMasksToBounds(radius > 0.0);
            CATransaction::commit();
            found = true;
        }
    }
    found
}

/// Where the slot sits, for the surface's record: the window's content on
/// the screen plus the slot's origin in it, the content size, the screen's
/// height and the backing scale.
pub fn geometry_of(window: &Window, slot: Bounds<Pixels>, cx: &App) -> WindowGeometry {
    let bounds = window.bounds();
    let viewport = window.viewport_size();
    let screen_height = window
        .display(cx)
        .map(|display| f64::from(display.bounds().size.height))
        .unwrap_or(0.0);
    // `bounds` is the window's frame; a title bar above the content (the
    // Preview window's) is the frame's height the viewport doesn't have.
    // Without it the floating surface's screen rect sat a title bar too high.
    let title_bar = (f64::from(bounds.size.height) - f64::from(viewport.height)).max(0.0);
    WindowGeometry {
        screen_x: f64::from(bounds.origin.x) + f64::from(slot.origin.x),
        screen_y: f64::from(bounds.origin.y) + title_bar + f64::from(slot.origin.y),
        content_width: f64::from(viewport.width),
        content_height: f64::from(viewport.height),
        screen_height,
        scale_factor: f64::from(window.scale_factor()),
    }
}
