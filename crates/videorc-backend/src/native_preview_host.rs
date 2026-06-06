use crate::protocol::{PreviewSurfaceBacking, PreviewSurfaceBounds, PreviewTransport};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePreviewHostBounds {
    pub screen_x: f64,
    pub screen_y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
    pub screen_height: Option<f64>,
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
        }
    }

    pub fn drawable_size(self) -> (f64, f64) {
        (
            self.width * self.scale_factor,
            self.height * self.scale_factor,
        )
    }

    pub fn appkit_frame(self) -> (f64, f64, f64, f64) {
        let appkit_y = self
            .screen_height
            .filter(|screen_height| screen_height.is_finite())
            .map(|screen_height| screen_height - self.screen_y - self.height)
            .unwrap_or(self.screen_y);
        (self.screen_x, appkit_y, self.width, self.height)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NativePreviewHostCommandKind {
    Create,
    UpdateBounds,
    Destroy,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePreviewHostCommand {
    pub kind: NativePreviewHostCommandKind,
    pub bounds: Option<NativePreviewHostBounds>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NativePreviewHostActivation {
    pub transport: PreviewTransport,
    pub backing: PreviewSurfaceBacking,
    pub message: Option<String>,
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
        NSBackingStoreType, NSColor, NSFloatingWindowLevel, NSView, NSWindow, NSWindowStyleMask,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use objc2_quartz_core::{CALayer, CAMetalLayer};

    use super::{
        NativePreviewHostActivation, NativePreviewHostBounds, NativePreviewHostCommand,
        NativePreviewHostCommandKind,
    };
    use crate::metal_compositor::{
        MetalPreviewPresenter, MetalSceneCompositor, make_preview_layer,
    };
    use crate::protocol::{PreviewSurfaceBacking, PreviewTransport};

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
            view.setWantsLayer(true);
            let ca_layer: &CALayer = layer.as_super();
            view.setLayer(Some(ca_layer));
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
            window.setContentView(Some(layer_host.view()));
            window.setOpaque(false);
            window.setBackgroundColor(Some(&NSColor::clearColor()));
            window.setIgnoresMouseEvents(true);
            window.setLevel(NSFloatingWindowLevel);
            unsafe {
                window.setReleasedWhenClosed(false);
            }
            Self { window, layer_host }
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
            self.layer_host.set_bounds(bounds);
            self.window.setFrame_display(window_frame(bounds), true);
        }

        pub fn show(&self) {
            self.window.orderFrontRegardless();
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
            match command.kind {
                NativePreviewHostCommandKind::Create
                | NativePreviewHostCommandKind::UpdateBounds => {
                    let Some(bounds) = command.bounds else {
                        return;
                    };
                    match self.overlay.as_mut() {
                        Some(overlay) => {
                            overlay.set_bounds(bounds);
                            overlay.show();
                        }
                        None => {
                            let overlay =
                                NativePreviewOverlayHost::new(&self.presenter, bounds, mtm);
                            overlay.show();
                            self.overlay = Some(overlay);
                        }
                    }
                }
                NativePreviewHostCommandKind::Destroy => {
                    if let Some(overlay) = self.overlay.take() {
                        overlay.hide();
                    }
                }
            }
        }

        pub fn present_latest(
            &self,
            compositor: &MetalSceneCompositor,
        ) -> Option<NativePreviewHostActivation> {
            let overlay = self.overlay.as_ref()?;
            compositor
                .present_latest_to_layer(&self.presenter, overlay.layer())
                .then(|| NativePreviewHostActivation {
                    transport: PreviewTransport::NativeSurface,
                    backing: PreviewSurfaceBacking::CaMetalLayer,
                    message: Some(
                        "Native CAMetalLayer preview surface is presenting compositor output."
                            .to_string(),
                    ),
                })
        }

        pub fn has_overlay(&self) -> bool {
            self.overlay.is_some()
        }
    }

    fn view_frame(bounds: NativePreviewHostBounds) -> NSRect {
        NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(bounds.width, bounds.height),
        )
    }

    fn window_frame(bounds: NativePreviewHostBounds) -> NSRect {
        let (x, y, width, height) = bounds.appkit_frame();
        NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
    }
}

#[cfg(target_os = "macos")]
#[allow(unused_imports)]
pub use macos::{NativePreviewLayerHost, NativePreviewOverlayHost, NativePreviewPresenterRunner};

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
        };

        let host_bounds = NativePreviewHostBounds::from_surface_bounds(&bounds);

        assert_eq!(host_bounds.width, 1.0);
        assert_eq!(host_bounds.height, 450.0);
        assert_eq!(host_bounds.drawable_size(), (2.0, 900.0));
        assert_eq!(host_bounds.appkit_frame(), (10.0, 530.0, 1.0, 450.0));
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
}
