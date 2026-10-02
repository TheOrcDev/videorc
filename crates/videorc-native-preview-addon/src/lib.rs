#[cfg(target_os = "macos")]
#[path = "../../videorc-backend/src/color.rs"]
mod color;
#[cfg(target_os = "macos")]
#[path = "../../videorc-backend/src/metal_compositor.rs"]
mod metal_compositor;
// metal_compositor re-exports crate::source_mask::SourceMask, so every crate
// that #[path]-includes it must also mount source_mask at its own root (the
// backend and the helper binary both do). allow(dead_code): the addon uses
// the type only through the re-export.
#[cfg(target_os = "macos")]
#[allow(dead_code)]
#[path = "../../videorc-backend/src/source_mask.rs"]
mod source_mask;
// metal_compositor's own tests drive crate::frame_store (the CVMetal cache
// tests), so the test build mounts it too; the addon itself never uses it.
#[cfg(all(test, target_os = "macos"))]
#[allow(dead_code)]
#[path = "../../videorc-backend/src/frame_store.rs"]
mod frame_store;

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::RefCell;
    use std::panic::AssertUnwindSafe;
    use std::sync::atomic::{AtomicU64, Ordering};

    use napi::bindgen_prelude::*;
    use napi_derive::napi;
    use objc2::exception::catch;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, NSObject, NSObjectProtocol};
    use objc2::{ClassType, MainThreadMarker, MainThreadOnly, define_class, msg_send};
    use objc2_app_kit::{
        NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
        NSColor, NSResponder, NSView, NSVisualEffectBlendingMode, NSVisualEffectState,
        NSVisualEffectView, NSWorkspace,
    };
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_core_graphics::CGColor;
    use objc2_foundation::{NSArray, NSNumber, NSString, ns_string};
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
        pub iosurface_import_live_count: u32,
        pub iosurface_import_peak_count: u32,
        pub iosurface_import_ceiling: u32,
        pub drawable_width: f64,
        pub drawable_height: f64,
        pub contents_scale: f64,
    }

    #[derive(Debug, Clone, Copy)]
    struct NativePreviewMetricState {
        iosurface_cache_hits: u32,
        iosurface_imports: u32,
        iosurface_invalidations: u32,
        iosurface_import_failures: u32,
        iosurface_import_live_count: u32,
        iosurface_import_peak_count: u32,
        iosurface_import_ceiling: u32,
    }

    impl NativePreviewMetricState {
        const fn new() -> Self {
            Self {
                iosurface_cache_hits: 0,
                iosurface_imports: 0,
                iosurface_invalidations: 0,
                iosurface_import_failures: 0,
                iosurface_import_live_count: 0,
                iosurface_import_peak_count: 0,
                iosurface_import_ceiling: IMPORTED_TEXTURE_CACHE_SIZE as u32,
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

        fn record_cache_state(&mut self, cached_entry_count: usize) {
            self.iosurface_import_live_count =
                u32::try_from(cached_entry_count).unwrap_or(u32::MAX);
            self.iosurface_import_peak_count = self
                .iosurface_import_peak_count
                .max(self.iosurface_import_live_count);
            debug_assert!(self.iosurface_import_live_count <= self.iosurface_import_ceiling);
        }
    }

    impl Default for NativePreviewMetricState {
        fn default() -> Self {
            Self::new()
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
                    metrics.record_cache_state(self.cached_textures.len());
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
            METRICS.with(|metrics| {
                let mut metrics = metrics.borrow_mut();
                if previous.is_some() {
                    metrics.record_invalidation();
                }
                metrics.record_cache_state(0);
            });
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
                METRICS.with(|metrics| {
                    let mut metrics = metrics.borrow_mut();
                    metrics.record_invalidation();
                    metrics.record_cache_state(0);
                });
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
            iosurface_import_live_count: metrics.iosurface_import_live_count,
            iosurface_import_peak_count: metrics.iosurface_import_peak_count,
            iosurface_import_ceiling: metrics.iosurface_import_ceiling,
            drawable_width,
            drawable_height,
            contents_scale,
        }
    }

    /// Pins one window's AppKit appearance: `dark`, `light`, or `system` (follow
    /// the app). `nativeTheme` is app-global in Electron, so without this the
    /// dark-always Preview window would get a light vibrancy material whenever
    /// the main window is in light theme (plan 050).
    /// Returns false when the view is not in a window yet.
    #[napi]
    pub fn set_window_appearance(native_window_handle: Buffer, appearance: String) -> Result<bool> {
        MainThreadMarker::new().ok_or_else(|| {
            Error::from_reason("Window appearance must be set on the macOS main thread.")
        })?;
        let view_pointer = native_view_pointer(&native_window_handle)?;
        let view = unsafe { Retained::retain(view_pointer) }
            .ok_or_else(|| Error::from_reason("Electron window NSView could not be retained."))?;
        let Some(window) = view.window() else {
            return Ok(false);
        };
        let named = match appearance.as_str() {
            "dark" => Some(unsafe { NSAppearanceNameDarkAqua }),
            "light" => Some(unsafe { NSAppearanceNameAqua }),
            "system" => None,
            other => {
                return Err(Error::from_reason(format!(
                    "Unknown window appearance {other:?}; expected dark, light or system."
                )));
            }
        };
        let resolved = match named {
            Some(name) => Some(NSAppearance::appearanceNamed(name).ok_or_else(|| {
                Error::from_reason(format!("AppKit has no appearance named {appearance:?}."))
            })?),
            None => None,
        };
        window.setAppearance(resolved.as_deref());
        Ok(true)
    }

    /// One NSVisualEffectView found in a window: what glass it paints, and
    /// (plan 091) what its layer tree holds, so the probe can tell a stripped
    /// backdrop from the material as AppKit draws it.
    #[napi(object)]
    pub struct WindowEffectView {
        /// `active`, `inactive` or `follows-window`.
        pub state: String,
        pub material: i64,
        pub blending_mode: i64,
        /// The view's runtime class.
        pub class_name: String,
        /// The view is a `VideorcClearGlassView`: the clear-glass strip runs on it.
        pub clear: bool,
        /// The gaussian blur radius read back from the backdrop's filter, if any.
        pub blur_radius: Option<f64>,
        /// Whether a wallpaper-tinting `CAChameleonLayer` is visible (null: none in the tree).
        pub chameleon_visible: Option<bool>,
        /// A saturation filter is still in the tree (the material's boost).
        pub saturate_present: bool,
        /// The root layer's background colour (the snapshot base), as components, if set.
        pub root_background: Option<String>,
        /// The layer tree, one line per layer: class, hidden, background, filters.
        pub layer_tree: Vec<String>,
    }

    /// Reads back the vibrancy views of one window (plan 050 diagnostics):
    /// the probe asserts the glass is really `active`, not following focus,
    /// and (plan 091) that the clear-glass strip holds.
    #[napi]
    pub fn window_effect_views(native_window_handle: Buffer) -> Result<Vec<WindowEffectView>> {
        MainThreadMarker::new().ok_or_else(|| {
            Error::from_reason("Window effect views must be read on the macOS main thread.")
        })?;
        let view_pointer = native_view_pointer(&native_window_handle)?;
        let view = unsafe { Retained::retain(view_pointer) }
            .ok_or_else(|| Error::from_reason("Electron window NSView could not be retained."))?;
        let Some(window) = view.window() else {
            return Ok(Vec::new());
        };
        let mut found = Vec::new();
        if let Some(content) = window.contentView() {
            for_each_effect_view(&content, 0, &mut |effect| {
                found.push(describe_effect_view(effect))
            });
        }
        Ok(found)
    }

    fn for_each_effect_view(
        view: &NSView,
        depth: usize,
        visit: &mut dyn FnMut(&NSVisualEffectView),
    ) {
        if depth > 4 {
            return;
        }
        if let Some(effect) = view.downcast_ref::<NSVisualEffectView>() {
            visit(effect);
        }
        for child in view.subviews().iter() {
            for_each_effect_view(&child, depth + 1, visit);
        }
    }

    fn describe_effect_view(effect: &NSVisualEffectView) -> WindowEffectView {
        let state = effect.state();
        let mut facts = LayerFacts::default();
        let root_background = effect.layer().map(|layer| {
            inspect_layer(&layer, 0, &mut facts);
            describe_color(layer.backgroundColor().as_deref())
        });
        WindowEffectView {
            state: if state == NSVisualEffectState::Active {
                "active".to_owned()
            } else if state == NSVisualEffectState::Inactive {
                "inactive".to_owned()
            } else {
                "follows-window".to_owned()
            },
            material: effect.material().0 as i64,
            blending_mode: effect.blendingMode().0 as i64,
            class_name: class_name(effect.class()),
            clear: std::ptr::eq(effect.class(), VideorcClearGlassView::class()),
            blur_radius: facts.blur_radius,
            chameleon_visible: facts.chameleon_visible,
            saturate_present: facts.saturate_present,
            root_background,
            layer_tree: facts.lines,
        }
    }

    // ----- Plan 091: clear glass, the Ghostex strip on Electron's vibrancy view -----
    //
    // Electron creates a plain NSVisualEffectView for `vibrancy` and hosts it
    // under the web contents. AppKit draws that material with a tint, a
    // wallpaper-tinting layer (CAChameleonLayer), a saturation boost and its
    // own blur. Ghostex (maddada/zed `BlurredView`, `remove_layer_background`)
    // subclasses the view and, after super's updateLayer, strips everything
    // but the blur, then widens the blur. Videorc re-classes Electron's own
    // view to that subclass (`object_setClass`), so Electron stays the view's
    // only owner: `setVibrancy(null)` still destroys it, a re-created view is
    // re-classed again, and the window keeps its shadow and resize edges.

    /// Ghostex's `BLURRED_VIEW_BLUR_RADIUS`: the backdrop's gaussian blur, in points.
    pub const DEFAULT_CLEAR_GLASS_BLUR_RADIUS: f64 = 60.0;

    /// The radius every `VideorcClearGlassView::updateLayer` applies. A global,
    /// not an ivar: the view is Electron's, re-classed in place, so the
    /// subclass must add no storage.
    static CLEAR_GLASS_BLUR_RADIUS: AtomicU64 =
        AtomicU64::new(DEFAULT_CLEAR_GLASS_BLUR_RADIUS.to_bits());

    fn clear_glass_blur_radius() -> f64 {
        f64::from_bits(CLEAR_GLASS_BLUR_RADIUS.load(Ordering::Relaxed))
    }

    /// The window's solid base (`--glass-solid`), painted on the view's own
    /// layer. Window snapshots (Mission Control, the app switcher) drop
    /// backdrop layers, so without it a stripped window would show there as
    /// nothing at all; the live blur covers it everywhere else.
    const DARK_SNAPSHOT_BASE: [f64; 3] = [
        0x0D as f64 / 255.0,
        0x0D as f64 / 255.0,
        0x0F as f64 / 255.0,
    ];
    const LIGHT_SNAPSHOT_BASE: [f64; 3] = [
        0xFA as f64 / 255.0,
        0xFA as f64 / 255.0,
        0xFB as f64 / 255.0,
    ];

    define_class!(
        // SAFETY:
        // - NSVisualEffectView has no subclassing requirement beyond calling
        //   super's updateLayer, which the override does first.
        // - The struct adds no ivars and no Drop, so its instance size equals
        //   NSVisualEffectView's and an existing view can take this class in
        //   place; set_window_glass_style checks the sizes before the swap.
        #[unsafe(super(NSVisualEffectView, NSView, NSResponder, NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "VideorcClearGlassView"]
        struct VideorcClearGlassView;

        impl VideorcClearGlassView {
            /// AppKit's updateLayer (re)builds the material; the strip then
            /// removes everything but the blur. AppKit calls this on every
            /// display pass it marks (appearance, size, state), so the strip
            /// re-applies itself whenever the material is rebuilt through it.
            #[unsafe(method(updateLayer))]
            fn update_layer(&self) {
                unsafe {
                    let _: () = msg_send![super(self), updateLayer];
                }
                clear_glass_strip(self);
            }
        }
    );

    /// Ghostex's `remove_layer_background`, then the snapshot base. Every step
    /// gives up quietly on what it does not recognise: a renamed private layer
    /// or filter leaves that part of AppKit's material in place, and the
    /// probe's `neutrality` and `nativeClear` checks catch it.
    fn clear_glass_strip(view: &NSVisualEffectView) {
        // Reduce Transparency: AppKit draws its solid material; keep it whole.
        if NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceTransparency() {
            return;
        }
        let Some(layer) = view.layer() else {
            return;
        };
        strip_layer(&layer, clear_glass_blur_radius());
        let [r, g, b] = if appearance_is_dark(view) {
            DARK_SNAPSHOT_BASE
        } else {
            LIGHT_SNAPSHOT_BASE
        };
        let base = NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, 1.0);
        layer.setBackgroundColor(Some(&base.CGColor()));
    }

    fn appearance_is_dark(view: &NSView) -> bool {
        let (aqua, dark_aqua) = unsafe { (NSAppearanceNameAqua, NSAppearanceNameDarkAqua) };
        view.effectiveAppearance()
            .bestMatchFromAppearancesWithNames(&NSArray::from_slice(&[aqua, dark_aqua]))
            .is_some_and(|name| name.isEqualToString(dark_aqua))
    }

    /// Strips one layer and its sublayers: no background tint, no wallpaper
    /// tinting, no saturation boost, and the blur at `radius`.
    fn strip_layer(layer: &CALayer, radius: f64) {
        layer.setBackgroundColor(None);
        if is_chameleon_layer(layer) {
            layer.setHidden(true);
            return;
        }
        if let Some(filters) = layer.filters() {
            let mut kept: Vec<Retained<AnyObject>> = Vec::with_capacity(filters.len());
            let mut changed = false;
            for filter in filters.iter() {
                let description = object_description(&filter);
                if filter_is_saturation(&description) {
                    changed = true;
                    continue;
                }
                if filter_is_blur(&description)
                    && set_number_for_key(&filter, ns_string!("inputRadius"), radius)
                {
                    changed = true;
                }
                kept.push(filter);
            }
            if changed {
                // Core Animation copies the array on set, so a radius changed
                // on a filter reaches the render tree only when the filters
                // are set again (Ghostex does the same).
                unsafe { layer.setFilters(Some(&NSArray::from_retained_slice(&kept))) };
            }
        }
        // SAFETY: the sublayers array is read on the main thread and not mutated while iterated.
        if let Some(sublayers) = unsafe { layer.sublayers() } {
            for sublayer in sublayers.iter() {
                strip_layer(&sublayer, radius);
            }
        }
    }

    /// The material's blur is a private `CAFilter`; its description names it
    /// (`gaussianBlur`), and would still contain `Blur` were it a `CIFilter`.
    fn filter_is_blur(description: &str) -> bool {
        description.contains("Blur")
    }

    /// `colorSaturate` today; `Saturat` also matches a `CIFilter`'s `inputSaturation`.
    fn filter_is_saturation(description: &str) -> bool {
        description.contains("Saturat")
    }

    fn is_chameleon_layer(layer: &CALayer) -> bool {
        AnyClass::get(c"CAChameleonLayer").is_some_and(|class| layer.isKindOfClass(class))
            || class_name(layer.class()) == "CAChameleonLayer"
    }

    fn class_name(class: &AnyClass) -> String {
        class.name().to_string_lossy().into_owned()
    }

    fn object_description(object: &AnyObject) -> String {
        catch(AssertUnwindSafe(|| {
            let description: Retained<NSString> = unsafe { msg_send![object, description] };
            description.to_string()
        }))
        .unwrap_or_default()
    }

    /// KVC on a private filter: an unknown key raises, which reads as "not applied".
    fn set_number_for_key(object: &AnyObject, key: &NSString, value: f64) -> bool {
        let number = NSNumber::new_f64(value);
        catch(AssertUnwindSafe(|| unsafe {
            let _: () = msg_send![object, setValue: &*number, forKey: key];
        }))
        .is_ok()
    }

    fn number_for_key(object: &AnyObject, key: &NSString) -> Option<f64> {
        catch(AssertUnwindSafe(|| unsafe {
            let value: Option<Retained<AnyObject>> = msg_send![object, valueForKey: key];
            value
        }))
        .ok()
        .flatten()
        .and_then(|value| value.downcast::<NSNumber>().ok())
        .map(|number| number.doubleValue())
    }

    #[derive(Default)]
    struct LayerFacts {
        blur_radius: Option<f64>,
        chameleon_visible: Option<bool>,
        saturate_present: bool,
        lines: Vec<String>,
    }

    /// Read-only walk for the diagnostics: what the tree holds, nothing changed.
    fn inspect_layer(layer: &CALayer, depth: usize, facts: &mut LayerFacts) {
        if is_chameleon_layer(layer) {
            facts.chameleon_visible =
                Some(facts.chameleon_visible.unwrap_or(false) || !layer.isHidden());
        }
        let mut filters = Vec::new();
        if let Some(found) = layer.filters() {
            for filter in found.iter() {
                let description = object_description(&filter);
                if filter_is_saturation(&description) {
                    facts.saturate_present = true;
                }
                if filter_is_blur(&description) {
                    let radius = number_for_key(&filter, ns_string!("inputRadius"));
                    if facts.blur_radius.is_none() {
                        facts.blur_radius = radius;
                    }
                    filters.push(format!(
                        "{} inputRadius={}",
                        without_addresses(&description),
                        radius.map_or_else(|| "?".to_owned(), |radius| format!("{radius}"))
                    ));
                } else {
                    filters.push(without_addresses(&description));
                }
            }
        }
        facts.lines.push(format!(
            "{indent}{class}{hidden} bg={bg} filters=[{filters}]",
            indent = "  ".repeat(depth),
            class = class_name(layer.class()),
            hidden = if layer.isHidden() { " hidden" } else { "" },
            bg = describe_color(layer.backgroundColor().as_deref()),
            filters = filters.join("; ")
        ));
        // SAFETY: the sublayers array is read on the main thread and not mutated while iterated.
        if let Some(sublayers) = unsafe { layer.sublayers() } {
            for sublayer in sublayers.iter() {
                inspect_layer(&sublayer, depth + 1, facts);
            }
        }
    }

    fn describe_color(color: Option<&CGColor>) -> String {
        let Some(color) = color else {
            return "none".to_owned();
        };
        let count = CGColor::number_of_components(Some(color));
        let components = CGColor::components(Some(color));
        if components.is_null() || count == 0 {
            return "set".to_owned();
        }
        let values: Vec<String> = (0..count)
            .map(|index| format!("{:.3}", unsafe { *components.add(index) }))
            .collect();
        format!("({})", values.join(","))
    }

    /// Drops the `0x…` addresses from an object description, so two dumps of
    /// the same tree compare equal.
    fn without_addresses(description: &str) -> String {
        let mut out = String::with_capacity(description.len());
        let mut rest = description;
        while let Some(index) = rest.find("0x") {
            out.push_str(rest[..index].trim_end());
            let after = &rest[index + 2..];
            let digits = after.chars().take_while(char::is_ascii_hexdigit).count();
            rest = &after[digits..];
        }
        out.push_str(rest);
        out
    }

    #[napi(object)]
    pub struct WindowGlassStyleOptions {
        /// The backdrop's gaussian blur radius in points (Ghostex: 60).
        pub blur_radius: Option<f64>,
    }

    #[napi(object)]
    pub struct WindowGlassStyleResult {
        /// At least one behind-window effect view now carries the clear-glass class.
        pub restyled: bool,
        /// Why a view was left alone: `no-window`, `no-effect-views`,
        /// `unsupported-class:<name>` (a KVO class or another subclass is never
        /// re-classed) or `instance-size-mismatch`.
        pub reason: Option<String>,
    }

    /// Re-classes the window's behind-window effect views to
    /// `VideorcClearGlassView` and asks them to redraw (plan 091, D1). Only a
    /// view whose class is exactly `NSVisualEffectView` is touched; a view
    /// already re-classed just redraws with the new radius.
    #[napi]
    pub fn set_window_glass_style(
        native_window_handle: Buffer,
        options: WindowGlassStyleOptions,
    ) -> Result<WindowGlassStyleResult> {
        MainThreadMarker::new().ok_or_else(|| {
            Error::from_reason("Window glass style must be set on the macOS main thread.")
        })?;
        let view_pointer = native_view_pointer(&native_window_handle)?;
        let view = unsafe { Retained::retain(view_pointer) }
            .ok_or_else(|| Error::from_reason("Electron window NSView could not be retained."))?;
        let Some(window) = view.window() else {
            return Ok(WindowGlassStyleResult {
                restyled: false,
                reason: Some("no-window".to_owned()),
            });
        };
        let radius = options
            .blur_radius
            .filter(|radius| radius.is_finite() && *radius >= 0.0)
            .unwrap_or(DEFAULT_CLEAR_GLASS_BLUR_RADIUS);
        CLEAR_GLASS_BLUR_RADIUS.store(radius.to_bits(), Ordering::Relaxed);
        let clear_class = VideorcClearGlassView::class();
        let plain_class = NSVisualEffectView::class();
        let mut restyled = 0_usize;
        let mut skipped: Vec<String> = Vec::new();
        if let Some(content) = window.contentView() {
            for_each_effect_view(&content, 0, &mut |effect| {
                // A within-window effect view is not the window material.
                if effect.blendingMode() != NSVisualEffectBlendingMode::BehindWindow {
                    return;
                }
                let current = effect.class();
                if std::ptr::eq(current, clear_class) {
                    restyled += 1;
                    effect.setNeedsDisplay(true);
                    return;
                }
                if !std::ptr::eq(current, plain_class) {
                    skipped.push(format!("unsupported-class:{}", class_name(current)));
                    return;
                }
                if current.instance_size() != clear_class.instance_size() {
                    skipped.push("instance-size-mismatch".to_owned());
                    return;
                }
                let object: &AnyObject = effect;
                // SAFETY: clear_class is a direct subclass of the view's current
                // class, adds no ivars (same instance size, checked above) and
                // overrides only updateLayer, which calls super first.
                unsafe { AnyObject::set_class(object, clear_class) };
                restyled += 1;
                effect.setNeedsDisplay(true);
            });
        }
        let reason = if skipped.is_empty() {
            (restyled == 0).then(|| "no-effect-views".to_owned())
        } else {
            Some(skipped.join(","))
        };
        Ok(WindowGlassStyleResult {
            restyled: restyled > 0,
            reason,
        })
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
            DARK_SNAPSHOT_BASE, DEFAULT_CLEAR_GLASS_BLUR_RADIUS, LIGHT_SNAPSHOT_BASE,
            NativePreviewMetricState, clear_glass_blur_radius, drawable_dimension, filter_is_blur,
            filter_is_saturation, preview_layer_visibility_transition, without_addresses,
        };

        #[test]
        fn clear_glass_defaults_match_ghostex_and_the_solid_palette() {
            assert_eq!(DEFAULT_CLEAR_GLASS_BLUR_RADIUS, 60.0);
            assert_eq!(
                clear_glass_blur_radius(),
                60.0,
                "the global starts at the default"
            );
            let hex = |base: [f64; 3]| -> [u8; 3] {
                [
                    (base[0] * 255.0).round() as u8,
                    (base[1] * 255.0).round() as u8,
                    (base[2] * 255.0).round() as u8,
                ]
            };
            assert_eq!(
                hex(DARK_SNAPSHOT_BASE),
                [0x0D, 0x0D, 0x0F],
                "--glass-solid dark"
            );
            assert_eq!(
                hex(LIGHT_SNAPSHOT_BASE),
                [0xFA, 0xFA, 0xFB],
                "--glass-solid light"
            );
        }

        #[test]
        fn the_strip_recognises_filters_by_description_as_ghostex_does() {
            assert!(filter_is_blur("<CAFilter 0x6000: gaussianBlur>"));
            assert!(filter_is_blur("CIGaussianBlur inputRadius = 30"));
            assert!(!filter_is_blur("<CAFilter: colorSaturate>"));
            assert!(filter_is_saturation("<CAFilter: colorSaturate>"));
            assert!(filter_is_saturation(
                "CIColorControls inputSaturation = 1.5"
            ));
            assert!(!filter_is_saturation("<CAFilter: gaussianBlur>"));
        }

        #[test]
        fn layer_dumps_drop_object_addresses() {
            assert_eq!(
                without_addresses("<CAFilter 0x600003a1c2d0: gaussianBlur>"),
                "<CAFilter: gaussianBlur>"
            );
            assert_eq!(without_addresses("no address here"), "no address here");
            assert_eq!(without_addresses("a 0xdead b 0xBEEF c"), "a b c");
        }

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
            metrics.record_cache_state(3);
            metrics.record_cache_state(0);

            assert_eq!(metrics.iosurface_cache_hits, 1);
            assert_eq!(metrics.iosurface_imports, 1);
            assert_eq!(metrics.iosurface_invalidations, 1);
            assert_eq!(metrics.iosurface_import_failures, 1);
            assert_eq!(metrics.iosurface_import_live_count, 0);
            assert_eq!(metrics.iosurface_import_peak_count, 3);
            assert_eq!(metrics.iosurface_import_ceiling, 3);
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

/// AppKit appearances exist only on macOS; elsewhere the pin never applies.
#[cfg(not(target_os = "macos"))]
#[napi_derive::napi]
pub fn set_window_appearance(
    _native_window_handle: napi::bindgen_prelude::Buffer,
    _appearance: String,
) -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
#[napi_derive::napi(object)]
pub struct WindowGlassStyleOptions {
    pub blur_radius: Option<f64>,
}

#[cfg(not(target_os = "macos"))]
#[napi_derive::napi(object)]
pub struct WindowGlassStyleResult {
    pub restyled: bool,
    pub reason: Option<String>,
}

/// The clear-glass strip works on an AppKit vibrancy view; elsewhere there is none.
#[cfg(not(target_os = "macos"))]
#[napi_derive::napi]
pub fn set_window_glass_style(
    _native_window_handle: napi::bindgen_prelude::Buffer,
    _options: WindowGlassStyleOptions,
) -> WindowGlassStyleResult {
    WindowGlassStyleResult {
        restyled: false,
        reason: Some("platform".to_owned()),
    }
}
