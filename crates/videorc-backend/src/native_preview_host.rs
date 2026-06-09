use crate::protocol::{PreviewSurfaceBacking, PreviewSurfaceBounds, PreviewTransport};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePreviewHostBounds {
    pub screen_x: f64,
    pub screen_y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_height: Option<f64>,
    // Visible clip rect in the same screen coordinate space; absent = fully visible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_height: Option<f64>,
    // False = hide the surface entirely (slot scrolled away / document hidden).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
}

impl NativePreviewHostBounds {
    #[allow(dead_code)]
    pub fn from_surface_bounds(bounds: &PreviewSurfaceBounds) -> Self {
        Self {
            screen_x: bounds.screen_x,
            screen_y: bounds.screen_y,
            width: bounds.width.max(1.0),
            height: bounds.height.max(1.0),
            scale_factor: bounds.scale_factor.max(1.0),
            screen_height: bounds.screen_height,
            clip_x: bounds.clip_x,
            clip_y: bounds.clip_y,
            clip_width: bounds.clip_width.map(|width| width.max(0.0)),
            clip_height: bounds.clip_height.map(|height| height.max(0.0)),
            visible: bounds.visible,
        }
    }

    pub fn drawable_size(self) -> (f64, f64) {
        (
            self.width * self.scale_factor,
            self.height * self.scale_factor,
        )
    }

    // The full slot frame in AppKit coordinates (the window itself uses the clip
    // frame; this remains the reference for tests and future hosts).
    #[allow(dead_code)]
    pub fn appkit_frame(self) -> (f64, f64, f64, f64) {
        let appkit_y = self.appkit_y(self.screen_y, self.height);
        (self.screen_x, appkit_y, self.width, self.height)
    }

    /// Whether the surface should be on screen at all: the renderer's visibility
    /// verdict (absent = legacy caller = visible) plus a non-empty clip.
    pub fn is_visible(self) -> bool {
        if !self.visible.unwrap_or(true) {
            return false;
        }
        let (_, _, clip_width, clip_height) = self.clip_rect_screen();
        clip_width >= 1.0 && clip_height >= 1.0
    }

    /// The window frame in AppKit coordinates: the visible clip rect, so a slot that
    /// is half scrolled out of its container crops instead of floating over other UI.
    pub fn appkit_clip_frame(self) -> (f64, f64, f64, f64) {
        let (clip_x, clip_y, clip_width, clip_height) = self.clip_rect_screen();
        let appkit_y = self.appkit_y(clip_y, clip_height);
        (clip_x, appkit_y, clip_width.max(1.0), clip_height.max(1.0))
    }

    /// The layer view's frame inside the clip-sized window (AppKit bottom-left
    /// origin). The view keeps the full slot size; parts outside the window are
    /// clipped by the window surface, which is exactly the wanted crop.
    pub fn view_frame_in_clip(self) -> (f64, f64, f64, f64) {
        let (clip_x, clip_y, clip_height) = {
            let (x, y, _, h) = self.clip_rect_screen();
            (x, y, h)
        };
        let view_x = self.screen_x - clip_x;
        let slot_appkit_y = self.appkit_y(self.screen_y, self.height);
        let clip_appkit_y = self.appkit_y(clip_y, clip_height);
        (
            view_x,
            slot_appkit_y - clip_appkit_y,
            self.width,
            self.height,
        )
    }

    /// Clip rect in screen (top-left origin) coordinates; absent clip = full slot.
    fn clip_rect_screen(self) -> (f64, f64, f64, f64) {
        match (self.clip_x, self.clip_y, self.clip_width, self.clip_height) {
            (Some(x), Some(y), Some(width), Some(height)) => (x, y, width, height),
            _ => (self.screen_x, self.screen_y, self.width, self.height),
        }
    }

    fn appkit_y(self, top: f64, height: f64) -> f64 {
        self.screen_height
            .filter(|screen_height| screen_height.is_finite())
            .map(|screen_height| screen_height - top - height)
            .unwrap_or(top)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NativePreviewHostCommandKind {
    Create,
    UpdateBounds,
    Destroy,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePreviewHostCommand {
    pub kind: NativePreviewHostCommandKind,
    pub bounds: Option<NativePreviewHostBounds>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NativePreviewHostActivation {
    pub transport: PreviewTransport,
    pub backing: PreviewSurfaceBacking,
    pub presented_frame_id: u64,
    pub frame_polling_suppressed: bool,
    pub source_pixels_present: bool,
    pub message: Option<String>,
}

impl NativePreviewHostActivation {
    pub fn cametal_layer_presented(presented_frame_id: u64) -> Self {
        Self {
            transport: PreviewTransport::NativeSurface,
            backing: PreviewSurfaceBacking::CaMetalLayer,
            presented_frame_id,
            frame_polling_suppressed: true,
            source_pixels_present: true,
            message: Some(
                "Native CAMetalLayer preview surface is presenting compositor output.".to_string(),
            ),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativePreviewHostPresentFailure {
    MissingOverlay,
    IosurfaceImportFailed,
    DrawableUnavailable,
    CommandBufferUnavailable,
    EncodeFailed,
}

impl NativePreviewHostPresentFailure {
    #[allow(dead_code)]
    pub fn reason(self) -> &'static str {
        match self {
            Self::MissingOverlay => "missing-overlay",
            Self::IosurfaceImportFailed => "iosurface-import-failed",
            Self::DrawableUnavailable => "drawable-unavailable",
            Self::CommandBufferUnavailable => "command-buffer-unavailable",
            Self::EncodeFailed => "encode-failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct NativePreviewHostLifecycleUpdate {
    pub command: Option<NativePreviewHostCommand>,
    pub activation: Option<NativePreviewHostActivation>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct NativePreviewHostLifecycle {
    last_command: Option<NativePreviewHostCommandKind>,
    bounds: Option<NativePreviewHostBounds>,
}

impl NativePreviewHostLifecycle {
    pub fn create(&mut self, bounds: &PreviewSurfaceBounds) -> NativePreviewHostLifecycleUpdate {
        self.last_command = Some(NativePreviewHostCommandKind::Create);
        let bounds = NativePreviewHostBounds::from_surface_bounds(bounds);
        self.bounds = Some(bounds);
        NativePreviewHostLifecycleUpdate {
            command: Some(NativePreviewHostCommand {
                kind: NativePreviewHostCommandKind::Create,
                bounds: Some(bounds),
            }),
            activation: None,
        }
    }

    pub fn update_bounds(
        &mut self,
        bounds: &PreviewSurfaceBounds,
    ) -> NativePreviewHostLifecycleUpdate {
        self.last_command = Some(NativePreviewHostCommandKind::UpdateBounds);
        let bounds = NativePreviewHostBounds::from_surface_bounds(bounds);
        self.bounds = Some(bounds);
        NativePreviewHostLifecycleUpdate {
            command: Some(NativePreviewHostCommand {
                kind: NativePreviewHostCommandKind::UpdateBounds,
                bounds: Some(bounds),
            }),
            activation: None,
        }
    }

    pub fn destroy(&mut self) -> NativePreviewHostLifecycleUpdate {
        self.last_command = Some(NativePreviewHostCommandKind::Destroy);
        self.bounds = None;
        NativePreviewHostLifecycleUpdate {
            command: Some(NativePreviewHostCommand {
                kind: NativePreviewHostCommandKind::Destroy,
                bounds: None,
            }),
            activation: None,
        }
    }

    #[cfg(test)]
    pub fn last_command_kind(&self) -> Option<NativePreviewHostCommandKind> {
        self.last_command
    }

    #[cfg(test)]
    pub fn bounds(&self) -> Option<NativePreviewHostBounds> {
        self.bounds
    }
}

#[cfg(target_os = "macos")]
#[allow(dead_code)]
mod macos {
    use objc2::rc::Retained;
    use objc2::{ClassType, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSBackingStoreType, NSColor, NSFloatingWindowLevel, NSView, NSWindow,
        NSWindowCollectionBehavior, NSWindowStyleMask,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use objc2_quartz_core::{CALayer, CAMetalLayer};

    use super::{
        NativePreviewHostActivation, NativePreviewHostBounds, NativePreviewHostCommand,
        NativePreviewHostCommandKind, NativePreviewHostPresentFailure,
    };
    use crate::metal_compositor::{
        MetalImportedIosurfaceTexture, MetalPreviewPresentFailure, MetalPreviewPresenter,
        MetalSceneCompositor, make_preview_layer,
    };

    impl From<MetalPreviewPresentFailure> for NativePreviewHostPresentFailure {
        fn from(failure: MetalPreviewPresentFailure) -> Self {
            match failure {
                MetalPreviewPresentFailure::IosurfaceImportFailed => Self::IosurfaceImportFailed,
                MetalPreviewPresentFailure::DrawableUnavailable => Self::DrawableUnavailable,
                MetalPreviewPresentFailure::CommandBufferUnavailable => {
                    Self::CommandBufferUnavailable
                }
                MetalPreviewPresentFailure::EncodeFailed => Self::EncodeFailed,
            }
        }
    }

    #[derive(Debug)]
    pub struct NativePreviewLayerHost {
        view: Retained<NSView>,
        layer: Retained<CAMetalLayer>,
        bounds: NativePreviewHostBounds,
    }

    impl NativePreviewLayerHost {
        pub fn new(
            presenter: &MetalPreviewPresenter,
            bounds: NativePreviewHostBounds,
            mtm: MainThreadMarker,
        ) -> Self {
            let (drawable_width, drawable_height) = bounds.drawable_size();
            let layer = make_preview_layer(presenter.device(), drawable_width, drawable_height);
            let view = NSView::initWithFrame(NSView::alloc(mtm), view_frame(bounds));
            // Layer-HOSTING contract: setLayer must come before setWantsLayer,
            // otherwise the view is layer-backed and AppKit owns (and may replace)
            // the backing layer — presents then land in a detached CAMetalLayer
            // that composites as nothing/black.
            let ca_layer: &CALayer = layer.as_super();
            view.setLayer(Some(ca_layer));
            view.setWantsLayer(true);
            Self {
                view,
                layer,
                bounds,
            }
        }

        pub fn view(&self) -> &NSView {
            &self.view
        }

        pub fn layer(&self) -> &CAMetalLayer {
            &self.layer
        }

        pub fn bounds(&self) -> NativePreviewHostBounds {
            self.bounds
        }

        pub fn set_bounds(&mut self, bounds: NativePreviewHostBounds) {
            let (drawable_width, drawable_height) = bounds.drawable_size();
            self.layer.setDrawableSize(objc2_core_foundation::CGSize {
                width: drawable_width,
                height: drawable_height,
            });
            self.view.setFrame(view_frame(bounds));
            self.bounds = bounds;
        }
    }

    #[derive(Debug)]
    pub struct NativePreviewOverlayHost {
        window: Retained<NSWindow>,
        layer_host: NativePreviewLayerHost,
        bounds: NativePreviewHostBounds,
        // The overlay may only appear once a real present succeeded: an empty layer
        // on screen is a lie (and used to read as a black box over the fallback).
        presented: bool,
    }

    impl NativePreviewOverlayHost {
        pub fn new(
            presenter: &MetalPreviewPresenter,
            bounds: NativePreviewHostBounds,
            mtm: MainThreadMarker,
        ) -> Self {
            let layer_host = NativePreviewLayerHost::new(presenter, bounds, mtm);
            let window = unsafe {
                NSWindow::initWithContentRect_styleMask_backing_defer(
                    NSWindow::alloc(mtm),
                    window_frame(bounds),
                    NSWindowStyleMask::Borderless,
                    NSBackingStoreType::Buffered,
                    false,
                )
            };
            // The window is sized to the visible CLIP rect while the layer view keeps
            // the full slot frame (offset inside it). A content view always fills the
            // window, so the layer view must be a subview of a plain container — the
            // window surface then crops whatever extends past the clip. The container
            // must be layer-backed: hosting a CAMetalLayer view inside a
            // non-layer-backed superview renders black.
            let container = NSView::initWithFrame(
                NSView::alloc(mtm),
                NSRect::new(NSPoint::new(0.0, 0.0), window_frame(bounds).size),
            );
            container.setWantsLayer(true);
            container.addSubview(layer_host.view());
            window.setContentView(Some(&container));
            window.setOpaque(false);
            window.setBackgroundColor(Some(&NSColor::clearColor()));
            // The preview is glued to the studio slot: it never takes a click and is
            // never user-movable — its placement is owned entirely by the renderer's
            // slot-rect tracking (Studio Shell And Live Control Plan, slice B2).
            window.setIgnoresMouseEvents(true);
            window.setMovable(false);
            window.setMovableByWindowBackground(false);
            // The overlay has to sit above Studio's own content to be visible. Keep it
            // hidden outside Videorc and out of the window cycle.
            window.setLevel(NSFloatingWindowLevel);
            window.setHasShadow(false);
            // NEVER setHidesOnDeactivate(true) here: it tracks THIS helper app's
            // activation, and an accessory helper is never active — AppKit would keep
            // the window permanently hidden no matter how often it is ordered front.
            // Hiding when Videorc loses focus is the Electron side's job (it pushes
            // visible:false bounds on blur).
            window.setCollectionBehavior(
                NSWindowCollectionBehavior::Transient
                    | NSWindowCollectionBehavior::IgnoresCycle
                    | NSWindowCollectionBehavior::FullScreenAuxiliary,
            );
            unsafe {
                window.setReleasedWhenClosed(false);
            }
            Self {
                window,
                layer_host,
                bounds,
                presented: false,
            }
        }

        pub fn window(&self) -> &NSWindow {
            &self.window
        }

        pub fn layer_host(&self) -> &NativePreviewLayerHost {
            &self.layer_host
        }

        pub fn layer(&self) -> &CAMetalLayer {
            self.layer_host.layer()
        }

        pub fn set_bounds(&mut self, bounds: NativePreviewHostBounds) {
            self.bounds = bounds;
            self.layer_host.set_bounds(bounds);
            self.window.setFrame_display(window_frame(bounds), true);
        }

        /// The single visibility rule: on screen only while the bounds say visible
        /// AND at least one real frame has been presented into the layer.
        pub fn sync_visibility(&self) {
            if self.bounds.is_visible() && self.presented {
                if !self.window.isVisible() {
                    self.window.orderFrontRegardless();
                }
            } else {
                self.window.orderOut(None);
            }
        }

        /// Called by the present path after a successful layer present.
        pub fn mark_presented(&mut self) {
            if !self.presented {
                self.presented = true;
                self.sync_visibility();
            }
        }

        pub fn hide(&self) {
            self.window.orderOut(None);
        }
    }

    /// Main-thread presenter runtime for the real native preview path.
    ///
    /// This owns AppKit objects and therefore must only be driven from code that holds a
    /// `MainThreadMarker`. Creating/updating the overlay is not enough to claim OBS-native
    /// preview; activation is returned only after the compositor target is actually
    /// presented into the `CAMetalLayer`.
    #[derive(Debug)]
    pub struct NativePreviewPresenterRunner {
        presenter: MetalPreviewPresenter,
        overlay: Option<NativePreviewOverlayHost>,
    }

    impl NativePreviewPresenterRunner {
        pub fn new(compositor: &MetalSceneCompositor) -> Option<Self> {
            Some(Self {
                presenter: compositor.make_preview_presenter()?,
                overlay: None,
            })
        }

        pub fn apply_command(&mut self, command: NativePreviewHostCommand, mtm: MainThreadMarker) {
            apply_overlay_command(&self.presenter, &mut self.overlay, command, mtm);
        }

        pub fn present_latest(
            &mut self,
            compositor: &MetalSceneCompositor,
            presented_frame_id: u64,
        ) -> Option<NativePreviewHostActivation> {
            let overlay = self.overlay.as_ref()?;
            let presented = compositor.present_latest_to_layer(&self.presenter, overlay.layer());
            if presented && let Some(overlay) = self.overlay.as_mut() {
                overlay.mark_presented();
            }
            presented
                .then(|| NativePreviewHostActivation::cametal_layer_presented(presented_frame_id))
        }

        pub fn has_overlay(&self) -> bool {
            self.overlay.is_some()
        }
    }

    /// Main-thread native preview runtime for imported compositor IOSurface handoffs.
    ///
    /// This is the host shape needed by an Electron native addon or backend AppKit
    /// overlay that receives `metalTargetIosurfaceId` from compositor status. It still
    /// only returns activation after a real layer present succeeds.
    #[derive(Debug)]
    pub struct NativePreviewIosurfacePresenterRunner {
        presenter: MetalPreviewPresenter,
        overlay: Option<NativePreviewOverlayHost>,
        cached_texture: Option<MetalImportedIosurfaceTexture>,
    }

    impl NativePreviewIosurfacePresenterRunner {
        pub fn new() -> Option<Self> {
            Some(Self {
                presenter: MetalPreviewPresenter::new_default()?,
                overlay: None,
                cached_texture: None,
            })
        }

        pub fn apply_command(&mut self, command: NativePreviewHostCommand, mtm: MainThreadMarker) {
            self.cached_texture = None;
            apply_overlay_command(&self.presenter, &mut self.overlay, command, mtm);
        }

        pub fn present_iosurface(
            &mut self,
            iosurface_id: u32,
            width: usize,
            height: usize,
            presented_frame_id: u64,
        ) -> Option<NativePreviewHostActivation> {
            self.try_present_iosurface(iosurface_id, width, height, presented_frame_id)
                .ok()
        }

        pub fn try_present_iosurface(
            &mut self,
            iosurface_id: u32,
            width: usize,
            height: usize,
            presented_frame_id: u64,
        ) -> Result<NativePreviewHostActivation, NativePreviewHostPresentFailure> {
            if self.overlay.is_none() {
                return Err(NativePreviewHostPresentFailure::MissingOverlay);
            }
            let needs_import = self
                .cached_texture
                .as_ref()
                .is_none_or(|texture| !texture.matches(iosurface_id, width, height));
            if needs_import {
                let imported = self
                    .presenter
                    .import_iosurface_texture_handle(iosurface_id, width, height)
                    .ok_or(NativePreviewHostPresentFailure::IosurfaceImportFailed)?;
                self.cached_texture = Some(imported);
            }
            let overlay = self
                .overlay
                .as_ref()
                .ok_or(NativePreviewHostPresentFailure::MissingOverlay)?;
            let imported = self
                .cached_texture
                .as_ref()
                .ok_or(NativePreviewHostPresentFailure::IosurfaceImportFailed)?;
            self.presenter
                .try_present_imported_iosurface_to_layer(overlay.layer(), imported)
                .map_err(NativePreviewHostPresentFailure::from)?;
            // Real pixels are in the layer now — the overlay may come on screen.
            if let Some(overlay) = self.overlay.as_mut() {
                overlay.mark_presented();
            }
            Ok(NativePreviewHostActivation::cametal_layer_presented(
                presented_frame_id,
            ))
        }

        pub fn has_overlay(&self) -> bool {
            self.overlay.is_some()
        }
    }

    fn apply_overlay_command(
        presenter: &MetalPreviewPresenter,
        overlay: &mut Option<NativePreviewOverlayHost>,
        command: NativePreviewHostCommand,
        mtm: MainThreadMarker,
    ) {
        match command.kind {
            NativePreviewHostCommandKind::Create | NativePreviewHostCommandKind::UpdateBounds => {
                let Some(bounds) = command.bounds else {
                    return;
                };
                let host = match overlay.as_mut() {
                    Some(existing) => {
                        existing.set_bounds(bounds);
                        existing
                    }
                    None => {
                        *overlay = Some(NativePreviewOverlayHost::new(presenter, bounds, mtm));
                        overlay.as_mut().expect("overlay was just created")
                    }
                };
                // A slot scrolled fully away or a hidden document means the surface
                // must leave the screen — never float over unrelated UI. A surface
                // that has never presented stays hidden too (no empty box on screen).
                host.sync_visibility();
            }
            NativePreviewHostCommandKind::Destroy => {
                if let Some(overlay) = overlay.take() {
                    overlay.hide();
                }
            }
        }
    }

    fn view_frame(bounds: NativePreviewHostBounds) -> NSRect {
        let (x, y, width, height) = bounds.view_frame_in_clip();
        NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
    }

    fn window_frame(bounds: NativePreviewHostBounds) -> NSRect {
        let (x, y, width, height) = bounds.appkit_clip_frame();
        NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
    }
}

#[cfg(target_os = "macos")]
#[allow(unused_imports)]
pub use macos::{
    NativePreviewIosurfacePresenterRunner, NativePreviewLayerHost, NativePreviewOverlayHost,
    NativePreviewPresenterRunner,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_bounds_clamp_to_visible_drawable_size() {
        let bounds = PreviewSurfaceBounds {
            screen_x: 10.0,
            screen_y: 20.0,
            width: 0.0,
            height: 450.0,
            scale_factor: 2.0,
            screen_height: Some(1000.0),
            ..Default::default()
        };

        let host_bounds = NativePreviewHostBounds::from_surface_bounds(&bounds);

        assert_eq!(host_bounds.width, 1.0);
        assert_eq!(host_bounds.height, 450.0);
        assert_eq!(host_bounds.drawable_size(), (2.0, 900.0));
        assert_eq!(host_bounds.appkit_frame(), (10.0, 530.0, 1.0, 450.0));
    }

    #[test]
    fn clip_frame_and_view_offset_crop_the_scrolled_slot() {
        // Slot spans screen rows 20..380; the scroll container only shows rows 120..320.
        let bounds = NativePreviewHostBounds {
            screen_x: 10.0,
            screen_y: 20.0,
            width: 640.0,
            height: 360.0,
            scale_factor: 2.0,
            screen_height: Some(1000.0),
            clip_x: Some(10.0),
            clip_y: Some(120.0),
            clip_width: Some(640.0),
            clip_height: Some(200.0),
            visible: Some(true),
        };

        assert!(bounds.is_visible());
        // Window covers exactly the visible clip (AppKit y-flip applied).
        assert_eq!(bounds.appkit_clip_frame(), (10.0, 680.0, 640.0, 200.0));
        // The layer keeps the full slot size, shifted so the window crops the
        // scrolled-away 100px at the top and 60px at the bottom.
        assert_eq!(bounds.view_frame_in_clip(), (0.0, -60.0, 640.0, 360.0));
        // Drawable resolution stays slot-sized: cropping is placement, not scaling.
        assert_eq!(bounds.drawable_size(), (1280.0, 720.0));
    }

    #[test]
    fn legacy_bounds_without_clip_stay_fully_visible() {
        let bounds = NativePreviewHostBounds {
            screen_x: 10.0,
            screen_y: 20.0,
            width: 640.0,
            height: 360.0,
            scale_factor: 1.0,
            screen_height: Some(1000.0),
            ..Default::default()
        };

        assert!(bounds.is_visible());
        assert_eq!(bounds.appkit_clip_frame(), bounds.appkit_frame());
        assert_eq!(bounds.view_frame_in_clip(), (0.0, 0.0, 640.0, 360.0));
    }

    #[test]
    fn hidden_or_empty_clip_bounds_are_not_visible() {
        let hidden = NativePreviewHostBounds {
            screen_x: 10.0,
            screen_y: 20.0,
            width: 640.0,
            height: 360.0,
            scale_factor: 1.0,
            visible: Some(false),
            ..Default::default()
        };
        assert!(!hidden.is_visible());

        let scrolled_away = NativePreviewHostBounds {
            screen_x: 10.0,
            screen_y: 20.0,
            width: 640.0,
            height: 360.0,
            scale_factor: 1.0,
            clip_x: Some(10.0),
            clip_y: Some(20.0),
            clip_width: Some(0.0),
            clip_height: Some(0.0),
            visible: Some(true),
            ..Default::default()
        };
        assert!(!scrolled_away.is_visible());
        // The window frame stays well-formed even while hidden.
        let (_, _, width, height) = scrolled_away.appkit_clip_frame();
        assert_eq!((width, height), (1.0, 1.0));
    }

    #[test]
    fn host_bounds_carry_clip_and_visibility() {
        let bounds = PreviewSurfaceBounds {
            screen_x: 10.0,
            screen_y: 20.0,
            width: 640.0,
            height: 360.0,
            scale_factor: 2.0,
            screen_height: Some(1000.0),
            clip_x: Some(10.0),
            clip_y: Some(120.0),
            clip_width: Some(640.0),
            clip_height: Some(-4.0),
            visible: Some(true),
        };

        let host_bounds = NativePreviewHostBounds::from_surface_bounds(&bounds);

        assert_eq!(host_bounds.clip_x, Some(10.0));
        assert_eq!(host_bounds.clip_y, Some(120.0));
        assert_eq!(host_bounds.clip_width, Some(640.0));
        // Negative clip sizes clamp to an empty clip instead of poisoning AppKit math.
        assert_eq!(host_bounds.clip_height, Some(0.0));
        assert_eq!(host_bounds.visible, Some(true));
    }

    #[test]
    fn host_bounds_fall_back_to_reported_y_without_screen_height() {
        let host_bounds = NativePreviewHostBounds {
            screen_x: 10.0,
            screen_y: 20.0,
            width: 640.0,
            height: 360.0,
            scale_factor: 1.0,
            screen_height: None,
            ..Default::default()
        };

        assert_eq!(host_bounds.appkit_frame(), (10.0, 20.0, 640.0, 360.0));
    }

    #[test]
    fn lifecycle_records_create_update_destroy_commands() {
        let mut lifecycle = NativePreviewHostLifecycle::default();
        let create_bounds = PreviewSurfaceBounds {
            screen_x: 10.0,
            screen_y: 20.0,
            width: 640.0,
            height: 360.0,
            scale_factor: 2.0,
            screen_height: Some(1000.0),
            ..Default::default()
        };

        let create_update = lifecycle.create(&create_bounds);

        assert_eq!(create_update.activation, None);
        assert_eq!(
            create_update.command,
            Some(NativePreviewHostCommand {
                kind: NativePreviewHostCommandKind::Create,
                bounds: Some(NativePreviewHostBounds {
                    screen_x: 10.0,
                    screen_y: 20.0,
                    width: 640.0,
                    height: 360.0,
                    scale_factor: 2.0,
                    screen_height: Some(1000.0),
                    ..Default::default()
                }),
            })
        );
        assert_eq!(
            lifecycle.last_command_kind(),
            Some(NativePreviewHostCommandKind::Create)
        );
        assert_eq!(
            lifecycle
                .bounds()
                .map(NativePreviewHostBounds::appkit_frame),
            Some((10.0, 620.0, 640.0, 360.0))
        );

        let update_bounds = PreviewSurfaceBounds {
            width: 800.0,
            height: 450.0,
            ..create_bounds
        };

        let bounds_update = lifecycle.update_bounds(&update_bounds);

        assert_eq!(bounds_update.activation, None);
        assert_eq!(
            bounds_update.command,
            Some(NativePreviewHostCommand {
                kind: NativePreviewHostCommandKind::UpdateBounds,
                bounds: Some(NativePreviewHostBounds {
                    screen_x: 10.0,
                    screen_y: 20.0,
                    width: 800.0,
                    height: 450.0,
                    scale_factor: 2.0,
                    screen_height: Some(1000.0),
                    ..Default::default()
                }),
            })
        );
        assert_eq!(
            lifecycle.last_command_kind(),
            Some(NativePreviewHostCommandKind::UpdateBounds)
        );
        assert_eq!(
            lifecycle
                .bounds()
                .map(NativePreviewHostBounds::drawable_size),
            Some((1600.0, 900.0))
        );

        let destroy_update = lifecycle.destroy();

        assert_eq!(destroy_update.activation, None);
        assert_eq!(
            destroy_update.command,
            Some(NativePreviewHostCommand {
                kind: NativePreviewHostCommandKind::Destroy,
                bounds: None,
            })
        );
        assert_eq!(
            lifecycle.last_command_kind(),
            Some(NativePreviewHostCommandKind::Destroy)
        );
        assert_eq!(lifecycle.bounds(), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn iosurface_runner_without_overlay_never_claims_activation() {
        let Some(mut runner) = NativePreviewIosurfacePresenterRunner::new() else {
            eprintln!("skipping: Metal preview presenter unavailable");
            return;
        };

        assert!(!runner.has_overlay());
        assert_eq!(runner.present_iosurface(1, 8, 4, 12), None);
        assert_eq!(
            runner
                .try_present_iosurface(1, 8, 4, 12)
                .expect_err("missing overlay must not activate")
                .reason(),
            "missing-overlay"
        );
    }
}
