#[cfg(target_os = "macos")]
#[path = "../../videorc-backend/src/color.rs"]
mod color;
#[cfg(target_os = "macos")]
#[path = "../../videorc-backend/src/metal_compositor.rs"]
mod metal_compositor;

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::RefCell;

    use napi::bindgen_prelude::*;
    use napi_derive::napi;
    use objc2::rc::Retained;
    use objc2::{ClassType, MainThreadMarker};
    use objc2_app_kit::NSView;
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_quartz_core::{CALayer, CAMetalLayer, CATransaction};

    use crate::metal_compositor::{
        MetalImportedIosurfaceTexture, MetalPreviewPresenter, make_preview_layer,
    };

    const IMPORTED_TEXTURE_CACHE_SIZE: usize = 3;

    thread_local! {
        static HOST: RefCell<Option<InProcessPreviewHost>> = const { RefCell::new(None) };
        static METRICS: RefCell<NativePreviewMetricState> = const {
            RefCell::new(NativePreviewMetricState::new())
        };
    }

    #[napi(object)]
    pub struct NativePreviewPresentResult {
        pub presented: bool,
        pub reason: Option<String>,
    }

    #[napi(object)]
    pub struct NativePreviewMetrics {
        pub iosurface_cache_hits: u32,
        pub iosurface_imports: u32,
        pub iosurface_invalidations: u32,
        pub iosurface_import_failures: u32,
        pub drawable_width: f64,
        pub drawable_height: f64,
        pub contents_scale: f64,
    }

    #[derive(Debug, Clone, Copy, Default)]
    struct NativePreviewMetricState {
        iosurface_cache_hits: u32,
        iosurface_imports: u32,
        iosurface_invalidations: u32,
        iosurface_import_failures: u32,
    }

    impl NativePreviewMetricState {
        const fn new() -> Self {
            Self {
                iosurface_cache_hits: 0,
                iosurface_imports: 0,
                iosurface_invalidations: 0,
                iosurface_import_failures: 0,
            }
        }

        fn record_cache_hit(&mut self) {
            self.iosurface_cache_hits = self.iosurface_cache_hits.saturating_add(1);
        }

        fn record_import(&mut self) {
            self.iosurface_imports = self.iosurface_imports.saturating_add(1);
        }

        fn record_invalidation(&mut self) {
            self.iosurface_invalidations = self.iosurface_invalidations.saturating_add(1);
        }

        fn record_import_failure(&mut self) {
            self.iosurface_import_failures = self.iosurface_import_failures.saturating_add(1);
        }
    }

    struct InProcessPreviewHost {
        _host_view: Retained<NSView>,
        layer: Retained<CAMetalLayer>,
        presenter: MetalPreviewPresenter,
        cached_textures: Vec<MetalImportedIosurfaceTexture>,
        visible_requested: bool,
        presented: bool,
        width: f64,
        height: f64,
        scale_factor: f64,
        layer_hidden: bool,
    }

    impl Drop for InProcessPreviewHost {
        fn drop(&mut self) {
            without_implicit_layer_actions(|| self.layer.removeFromSuperlayer());
        }
    }

    impl InProcessPreviewHost {
        fn attached(&self) -> bool {
            let ca_layer: &CALayer = self.layer.as_super();
            ca_layer.superlayer().is_some() && self._host_view.window().is_some()
        }

        fn attach(
            native_window_handle: &Buffer,
            width: f64,
            height: f64,
            scale_factor: f64,
            visible: bool,
        ) -> Result<Self> {
            MainThreadMarker::new().ok_or_else(|| {
                Error::from_reason("Native preview must attach on the macOS main thread.")
            })?;
            let view_pointer = native_view_pointer(native_window_handle)?;
            let host_view = unsafe { Retained::retain(view_pointer) }.ok_or_else(|| {
                Error::from_reason("Electron native preview NSView could not be retained.")
            })?;
            host_view.setWantsLayer(true);
            let host_layer = host_view.layer().ok_or_else(|| {
                Error::from_reason("Electron native preview NSView has no backing CALayer.")
            })?;
            let presenter = MetalPreviewPresenter::new_default()
                .ok_or_else(|| Error::from_reason("Metal preview presenter is unavailable."))?;
            let layer = make_preview_layer(
                presenter.device(),
                drawable_dimension(width, scale_factor),
                drawable_dimension(height, scale_factor),
            );
            let ca_layer: &CALayer = layer.as_super();
            without_implicit_layer_actions(|| {
                ca_layer.setZPosition(10_000.0);
                // Never expose the layer's empty drawable between insertion and
                // the first successful present.
                ca_layer.setHidden(true);
                host_layer.addSublayer(ca_layer);
            });
            let mut host = Self {
                _host_view: host_view,
                layer,
                presenter,
                cached_textures: Vec::new(),
                visible_requested: visible,
                presented: false,
                width: 0.0,
                height: 0.0,
                scale_factor: 0.0,
                layer_hidden: true,
            };
            host.update(width, height, scale_factor, visible);
            Ok(host)
        }

        fn update(&mut self, width: f64, height: f64, scale_factor: f64, visible: bool) {
            let scale_factor = scale_factor.max(1.0);
            let width = width.max(1.0);
            let height = height.max(1.0);
            let drawable = CGSize {
                width: drawable_dimension(width, scale_factor),
                height: drawable_dimension(height, scale_factor),
            };
            let size_changed = self.width != width || self.height != height;
            let scale_changed = self.scale_factor != scale_factor;
            let visibility_transition =
                preview_layer_visibility_transition(self.layer_hidden, visible, self.presented);
            if !size_changed && !scale_changed && visibility_transition.is_none() {
                self.visible_requested = visible;
                return;
            }
            let ca_layer: &CALayer = self.layer.as_super();
            without_implicit_layer_actions(|| {
                if size_changed || scale_changed {
                    self.layer.setDrawableSize(drawable);
                }
                if scale_changed {
                    ca_layer.setContentsScale(scale_factor);
                }
                if size_changed {
                    ca_layer.setFrame(CGRect {
                        origin: CGPoint { x: 0.0, y: 0.0 },
                        size: CGSize { width, height },
                    });
                }
                if let Some(hidden) = visibility_transition {
                    ca_layer.setHidden(hidden);
                }
            });
            self.visible_requested = visible;
            self.width = width;
            self.height = height;
            self.scale_factor = scale_factor;
            if let Some(hidden) = visibility_transition {
                self.layer_hidden = hidden;
            }
        }

        fn present(
            &mut self,
            iosurface_id: u32,
            width: usize,
            height: usize,
            metrics: &mut NativePreviewMetricState,
        ) -> Result<()> {
            let cached_index = self
                .cached_textures
                .iter()
                .position(|texture| texture.matches(iosurface_id, width, height));
            let imported_index = match cached_index {
                Some(index) => {
                    metrics.record_cache_hit();
                    index
                }
                None => {
                    let Some(imported) =
                        self.presenter
                            .import_iosurface_texture_handle(iosurface_id, width, height)
                    else {
                        metrics.record_import_failure();
                        return Err(Error::from_reason("iosurface-import-failed"));
                    };
                    metrics.record_import();
                    self.cached_textures
                        .retain(|texture| texture.width() == width && texture.height() == height);
                    if self.cached_textures.len() >= IMPORTED_TEXTURE_CACHE_SIZE {
                        self.cached_textures.remove(0);
                    }
                    self.cached_textures.push(imported);
                    self.cached_textures.len() - 1
                }
            };
            let imported = self
                .cached_textures
                .get(imported_index)
                .ok_or_else(|| Error::from_reason("iosurface-import-failed"))?;
            self.presenter
                .try_present_imported_iosurface_to_layer(&self.layer, imported)
                .map_err(|failure| Error::from_reason(failure.reason()))?;
            self.presented = true;
            if let Some(hidden) = preview_layer_visibility_transition(
                self.layer_hidden,
                self.visible_requested,
                self.presented,
            ) {
                let ca_layer: &CALayer = self.layer.as_super();
                without_implicit_layer_actions(|| ca_layer.setHidden(hidden));
                self.layer_hidden = hidden;
            }
            Ok(())
        }
    }

    /// CAMetalLayer is inserted manually rather than managed by AppKit layout.
    /// Disable Core Animation's default property actions so resize/visibility and
    /// teardown are committed as one frame instead of animating behind the window.
    fn without_implicit_layer_actions(mutate: impl FnOnce()) {
        CATransaction::begin();
        CATransaction::setDisableActions(true);
        mutate();
        CATransaction::commit();
        CATransaction::flush();
    }

    #[napi]
    pub fn attach_native_preview(
        native_window_handle: Buffer,
        width: f64,
        height: f64,
        scale_factor: f64,
        visible: bool,
    ) -> Result<()> {
        let host = InProcessPreviewHost::attach(
            &native_window_handle,
            width,
            height,
            scale_factor,
            visible,
        )?;
        HOST.with(|slot| {
            let previous = slot.borrow_mut().replace(host);
            if previous.is_some() {
                METRICS.with(|metrics| metrics.borrow_mut().record_invalidation());
            }
        });
        Ok(())
    }

    #[napi]
    pub fn update_native_preview(
        width: f64,
        height: f64,
        scale_factor: f64,
        visible: bool,
    ) -> Result<()> {
        HOST.with(|slot| {
            let mut slot = slot.borrow_mut();
            let host = slot
                .as_mut()
                .ok_or_else(|| Error::from_reason("Native preview is not attached."))?;
            host.update(width, height, scale_factor, visible);
            Ok(())
        })
    }

    #[napi]
    pub fn present_native_preview(
        iosurface_id: u32,
        width: u32,
        height: u32,
        _frame_id: u32,
    ) -> NativePreviewPresentResult {
        let result = HOST.with(|slot| {
            let mut slot = slot.borrow_mut();
            let host = slot
                .as_mut()
                .ok_or_else(|| Error::from_reason("Native preview is not attached."))?;
            METRICS.with(|metrics| {
                host.present(
                    iosurface_id,
                    width as usize,
                    height as usize,
                    &mut metrics.borrow_mut(),
                )
            })
        });
        match result {
            Ok(()) => NativePreviewPresentResult {
                presented: true,
                reason: None,
            },
            Err(error) => NativePreviewPresentResult {
                presented: false,
                reason: Some(error.reason),
            },
        }
    }

    #[napi]
    pub fn destroy_native_preview() {
        HOST.with(|slot| {
            if slot.borrow_mut().take().is_some() {
                METRICS.with(|metrics| metrics.borrow_mut().record_invalidation());
            }
        });
    }

    #[napi]
    pub fn native_preview_attached() -> bool {
        HOST.with(|slot| {
            slot.borrow()
                .as_ref()
                .is_some_and(InProcessPreviewHost::attached)
        })
    }

    #[napi]
    pub fn native_preview_metrics() -> NativePreviewMetrics {
        let metrics = METRICS.with(|metrics| *metrics.borrow());
        let (drawable_width, drawable_height, contents_scale) = HOST.with(|slot| {
            let slot = slot.borrow();
            let Some(host) = slot.as_ref() else {
                return (0.0, 0.0, 0.0);
            };
            let drawable = host.layer.drawableSize();
            let ca_layer: &CALayer = host.layer.as_super();
            (drawable.width, drawable.height, ca_layer.contentsScale())
        });
        NativePreviewMetrics {
            iosurface_cache_hits: metrics.iosurface_cache_hits,
            iosurface_imports: metrics.iosurface_imports,
            iosurface_invalidations: metrics.iosurface_invalidations,
            iosurface_import_failures: metrics.iosurface_import_failures,
            drawable_width,
            drawable_height,
            contents_scale,
        }
    }

    fn native_view_pointer(buffer: &Buffer) -> Result<*mut NSView> {
        let pointer_size = std::mem::size_of::<usize>();
        if buffer.len() < pointer_size {
            return Err(Error::from_reason(format!(
                "Electron native window handle is {} bytes; expected at least {pointer_size}.",
                buffer.len()
            )));
        }
        let mut bytes = [0_u8; std::mem::size_of::<usize>()];
        bytes.copy_from_slice(&buffer[..pointer_size]);
        let pointer = usize::from_ne_bytes(bytes) as *mut NSView;
        if pointer.is_null() {
            return Err(Error::from_reason(
                "Electron native window handle contains a null NSView pointer.",
            ));
        }
        Ok(pointer)
    }

    fn drawable_dimension(points: f64, scale_factor: f64) -> f64 {
        (points.max(1.0) * scale_factor.max(1.0)).round().max(1.0)
    }

    fn preview_layer_visibility_transition(
        layer_hidden: bool,
        visible_requested: bool,
        presented: bool,
    ) -> Option<bool> {
        let desired_hidden = !visible_requested || !presented;
        (layer_hidden != desired_hidden).then_some(desired_hidden)
    }

    #[cfg(test)]
    mod tests {
        use super::{
            NativePreviewMetricState, drawable_dimension, preview_layer_visibility_transition,
        };

        #[test]
        fn drawable_dimension_uses_physical_pixels() {
            assert_eq!(drawable_dimension(960.0, 2.0), 1920.0);
            assert_eq!(drawable_dimension(440.4, 2.0), 881.0);
            assert_eq!(drawable_dimension(0.0, 0.0), 1.0);
        }

        #[test]
        fn metrics_distinguish_cache_reuse_from_import_and_invalidation() {
            let mut metrics = NativePreviewMetricState::default();
            metrics.record_cache_hit();
            metrics.record_import();
            metrics.record_invalidation();
            metrics.record_import_failure();

            assert_eq!(metrics.iosurface_cache_hits, 1);
            assert_eq!(metrics.iosurface_imports, 1);
            assert_eq!(metrics.iosurface_invalidations, 1);
            assert_eq!(metrics.iosurface_import_failures, 1);
        }

        #[test]
        fn visibility_transaction_happens_only_on_first_unhide_and_real_transitions() {
            let mut layer_hidden = true;
            assert_eq!(
                preview_layer_visibility_transition(layer_hidden, true, false),
                None,
                "attachment stays hidden before the first present"
            );

            let first_unhide = preview_layer_visibility_transition(layer_hidden, true, true);
            assert_eq!(first_unhide, Some(false));
            layer_hidden = first_unhide.unwrap();
            assert_eq!(
                preview_layer_visibility_transition(layer_hidden, true, true),
                None,
                "unchanged presents must not commit another CA transaction"
            );
            assert_eq!(
                preview_layer_visibility_transition(layer_hidden, false, true),
                Some(true),
                "an actual visibility transition still commits"
            );
        }
    }
}

#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(not(target_os = "macos"))]
#[napi_derive::napi]
pub fn native_preview_attached() -> bool {
    false
}
