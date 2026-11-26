//! Native views on Windows: the platform half of `gpui::NativeView`.
//!
//! A native view is DirectComposition content, such as a swap chain another
//! thread presents to, shown beneath the window's GPUI content in the same
//! composition tree. Where GPUI paints the view, the renderer erases what was
//! drawn before it, so the view shows through, and everything painted after it
//! covers it. This module places each view's visuals from the drawn scene:
//!
//! ```text
//! root
//! ├── mask        clipped to the element's content mask   (one per view,
//! │   └── frame   at the element's bounds, rounded clip    beneath GPUI's
//! │       ├── background   a 1×1 surface stretched over the frame   visual)
//! │       └── content      the caller's content, unscaled
//! └── GPUI's own swap chain visual
//! ```

use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use anyhow::{Context as _, Result};
use gpui::{Hsla, NativeViewId, PaintNativeView, Rgba, Scene};
use windows::{
    Win32::{
        Foundation::{POINT, RECT},
        Graphics::{
            Direct3D11::{
                ID3D11Device, ID3D11DeviceContext, ID3D11DeviceContext1, ID3D11RenderTargetView,
                ID3D11Texture2D,
            },
            DirectComposition::*,
            Dxgi::Common::{DXGI_ALPHA_MODE_PREMULTIPLIED, DXGI_FORMAT_B8G8R8A8_UNORM},
        },
    },
    core::{IUnknown, Interface},
};
use windows_numerics::Matrix3x2;

/// What `gpui::NativeView::new` takes on Windows: its `view` must point to one
/// of these. GPUI reads it during the call and keeps its own reference to
/// `content` and `size`.
pub struct NativeVisual {
    /// What the view shows: anything `IDCompositionVisual::SetContent`
    /// accepts that no other DirectComposition device created, such as a swap
    /// chain from `IDXGIFactory2::CreateSwapChainForComposition`. Its owner
    /// presents to it from any thread; GPUI only places it.
    pub content: IUnknown,
    /// The radius of the view's rounded corners, in logical pixels.
    pub corner_radius: f32,
    /// The size GPUI lays the view out at, for the content's owner to follow.
    pub size: Arc<NativeVisualSize>,
}

/// The size, in device pixels, at which GPUI last laid out a native view.
///
/// GPUI shows the content unscaled from the view's top left corner, so its
/// owner should keep the content at this size. Until it catches up, the view's
/// background shows where the content falls short.
#[derive(Debug, Default)]
pub struct NativeVisualSize(AtomicU64);

impl NativeVisualSize {
    /// The last laid-out width and height, or `None` before the view's first
    /// paint.
    pub fn laid_out(&self) -> Option<(u32, u32)> {
        let packed = self.0.load(Ordering::Acquire);
        (packed != 0).then_some(((packed >> 32) as u32, packed as u32))
    }

    fn set(&self, width: u32, height: u32) {
        let packed = (u64::from(width) << 32) | u64::from(height);
        self.0.store(packed, Ordering::Release);
    }
}

/// The views attached to one window's renderer.
#[derive(Default)]
pub(crate) struct NativeViews {
    views: Vec<AttachedView>,
    /// The window's scale factor, for the corner radius.
    scale_factor: f32,
}

struct AttachedView {
    id: NativeViewId,
    content: IUnknown,
    corner_radius: f32,
    size: Arc<NativeVisualSize>,
    /// Built on the renderer's composition device at the first paint, and
    /// again after the device is lost.
    visuals: Option<ViewVisuals>,
}

struct ViewVisuals {
    mask: IDCompositionVisual,
    mask_clip: IDCompositionRectangleClip,
    frame: IDCompositionVisual,
    frame_clip: IDCompositionRectangleClip,
    background: IDCompositionVisual,
    background_surface: Option<IDCompositionSurface>,
    /// Whether `mask` is in the composition tree, which is while the view is
    /// painted.
    shown: bool,
    /// What the visuals show, to commit only changes.
    placed: Option<Placement>,
}

/// Where a painted view goes, in device pixels.
#[derive(Clone, Copy, PartialEq)]
struct Placement {
    bounds: [f32; 4],
    mask: [f32; 4],
    corner_radius: f32,
    background: [f32; 4],
}

impl NativeViews {
    pub(crate) fn set_scale_factor(&mut self, scale_factor: f32) {
        self.scale_factor = scale_factor;
    }

    pub(crate) fn attach(&mut self, id: NativeViewId, visual: &NativeVisual) {
        self.views.push(AttachedView {
            id,
            content: visual.content.clone(),
            corner_radius: visual.corner_radius.max(0.0),
            size: visual.size.clone(),
            visuals: None,
        });
    }

    /// Removes a view, and its visuals from `root` when there is one. Returns
    /// whether the composition tree changed.
    pub(crate) fn detach(
        &mut self,
        id: NativeViewId,
        root: Option<&IDCompositionVisual>,
    ) -> Result<bool> {
        let Some(index) = self.views.iter().position(|view| view.id == id) else {
            return Ok(false);
        };
        let view = self.views.remove(index);
        match (view.visuals, root) {
            (Some(visuals), Some(root)) if visuals.shown => {
                unsafe { root.RemoveVisual(&visuals.mask) }?;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    /// Forgets every view's visuals, which belonged to a lost device. The next
    /// update builds them again on the new one.
    pub(crate) fn device_lost(&mut self) {
        for view in &mut self.views {
            view.visuals = None;
        }
    }

    /// The radius, in device pixels, of the view's rounded corners.
    pub(crate) fn corner_radius(&self, id: NativeViewId) -> f32 {
        self.views
            .iter()
            .find(|view| view.id == id)
            .map_or(0.0, |view| view.corner_radius * self.scale_factor)
    }

    /// Places every view as `scene` paints it, beneath `gpui_visual`, and
    /// hides the ones it doesn't paint. Returns whether anything changed, in
    /// which case the caller commits the composition device.
    pub(crate) fn update(
        &mut self,
        scene: &Scene,
        comp_device: &IDCompositionDevice,
        root: &IDCompositionVisual,
        gpui_visual: &IDCompositionVisual,
        device: &ID3D11Device,
        device_context: &ID3D11DeviceContext,
    ) -> Result<bool> {
        let mut changed = false;
        for view in &mut self.views {
            let painted = scene
                .native_views
                .iter()
                .find(|painted| painted.id == view.id);
            if view.visuals.is_none() {
                if painted.is_none() {
                    continue;
                }
                view.visuals = Some(ViewVisuals::new(comp_device, &view.content)?);
            }
            let visuals = view.visuals.as_mut().expect("built above");
            let Some(painted) = painted else {
                if visuals.shown {
                    unsafe { root.RemoveVisual(&visuals.mask) }?;
                    visuals.shown = false;
                    changed = true;
                }
                continue;
            };
            let placement = Placement::new(painted, view.corner_radius * self.scale_factor);
            view.size.set(
                placement.width().round().max(1.0) as u32,
                placement.height().round().max(1.0) as u32,
            );
            if visuals.placed != Some(placement) {
                visuals.place(&placement, comp_device, device, device_context)?;
                changed = true;
            }
            if !visuals.shown {
                // Behind GPUI's visual, so GPUI's content covers the view.
                unsafe { root.AddVisual(&visuals.mask, false, gpui_visual) }?;
                visuals.shown = true;
                changed = true;
            }
        }
        Ok(changed)
    }
}

impl Placement {
    fn new(painted: &PaintNativeView, corner_radius: f32) -> Self {
        let rect = |bounds: &gpui::Bounds<gpui::ScaledPixels>| {
            [
                bounds.origin.x.0,
                bounds.origin.y.0,
                bounds.origin.x.0 + bounds.size.width.0,
                bounds.origin.y.0 + bounds.size.height.0,
            ]
        };
        Self::from_parts(
            rect(&painted.bounds),
            rect(&painted.content_mask.bounds),
            corner_radius,
            premultiplied(painted.background),
        )
    }

    fn from_parts(
        bounds: [f32; 4],
        mask: [f32; 4],
        corner_radius: f32,
        background: [f32; 4],
    ) -> Self {
        let half_side = ((bounds[2] - bounds[0]).min(bounds[3] - bounds[1]) / 2.0).max(0.0);
        Self {
            bounds,
            mask,
            corner_radius: corner_radius.clamp(0.0, half_side),
            background,
        }
    }

    fn width(&self) -> f32 {
        self.bounds[2] - self.bounds[0]
    }

    fn height(&self) -> f32 {
        self.bounds[3] - self.bounds[1]
    }
}

impl ViewVisuals {
    fn new(comp_device: &IDCompositionDevice, content: &IUnknown) -> Result<Self> {
        unsafe {
            let mask = comp_device.CreateVisual()?;
            let mask_clip = comp_device.CreateRectangleClip()?;
            mask.SetClip(&mask_clip)?;
            let frame = comp_device.CreateVisual()?;
            let frame_clip = comp_device.CreateRectangleClip()?;
            frame.SetClip(&frame_clip)?;
            let background = comp_device.CreateVisual()?;
            // A 1×1 surface stretched to the frame: one colour, no blur.
            background.SetBitmapInterpolationMode(
                DCOMPOSITION_BITMAP_INTERPOLATION_MODE_NEAREST_NEIGHBOR,
            )?;
            background.SetBorderMode(DCOMPOSITION_BORDER_MODE_HARD)?;
            let content_visual = comp_device.CreateVisual()?;
            content_visual
                .SetContent(content)
                .context("the native view's content is not composition content")?;
            frame.AddVisual(&background, false, None::<&IDCompositionVisual>)?;
            frame.AddVisual(&content_visual, true, &background)?;
            mask.AddVisual(&frame, false, None::<&IDCompositionVisual>)?;
            Ok(Self {
                mask,
                mask_clip,
                frame,
                frame_clip,
                background,
                background_surface: None,
                shown: false,
                placed: None,
            })
        }
    }

    fn place(
        &mut self,
        placement: &Placement,
        comp_device: &IDCompositionDevice,
        device: &ID3D11Device,
        device_context: &ID3D11DeviceContext,
    ) -> Result<()> {
        let [left, top, right, bottom] = placement.mask;
        let (width, height) = (placement.width(), placement.height());
        let radius = placement.corner_radius;
        unsafe {
            self.mask_clip.SetLeft2(left)?;
            self.mask_clip.SetTop2(top)?;
            self.mask_clip.SetRight2(right)?;
            self.mask_clip.SetBottom2(bottom)?;
            self.frame.SetOffsetX2(placement.bounds[0])?;
            self.frame.SetOffsetY2(placement.bounds[1])?;
            self.frame_clip.SetLeft2(0.0)?;
            self.frame_clip.SetTop2(0.0)?;
            self.frame_clip.SetRight2(width)?;
            self.frame_clip.SetBottom2(height)?;
            for set in [
                IDCompositionRectangleClip::SetTopLeftRadiusX2,
                IDCompositionRectangleClip::SetTopLeftRadiusY2,
                IDCompositionRectangleClip::SetTopRightRadiusX2,
                IDCompositionRectangleClip::SetTopRightRadiusY2,
                IDCompositionRectangleClip::SetBottomLeftRadiusX2,
                IDCompositionRectangleClip::SetBottomLeftRadiusY2,
                IDCompositionRectangleClip::SetBottomRightRadiusX2,
                IDCompositionRectangleClip::SetBottomRightRadiusY2,
            ] {
                set(&self.frame_clip, radius)?;
            }
        }
        let old_background = self.placed.map(|placed| placed.background);
        if placement.background[3] <= 0.0 {
            if self.background_surface.take().is_some() {
                unsafe { self.background.SetContent(None::<&IUnknown>) }?;
            }
        } else {
            if self.background_surface.is_none() || old_background != Some(placement.background) {
                let surface =
                    solid_surface(comp_device, device, device_context, placement.background)?;
                unsafe { self.background.SetContent(&surface) }?;
                self.background_surface = Some(surface);
            }
            let stretch = Matrix3x2 {
                M11: width,
                M12: 0.0,
                M21: 0.0,
                M22: height,
                M31: 0.0,
                M32: 0.0,
            };
            unsafe { self.background.SetTransform2(&stretch) }?;
        }
        self.placed = Some(*placement);
        Ok(())
    }
}

/// A one-pixel composition surface filled with a premultiplied colour.
fn solid_surface(
    comp_device: &IDCompositionDevice,
    device: &ID3D11Device,
    device_context: &ID3D11DeviceContext,
    color: [f32; 4],
) -> Result<IDCompositionSurface> {
    // Every Windows 10 and 11 device context is a D3D11.1 one.
    let context1: ID3D11DeviceContext1 = device_context
        .cast()
        .context("a native view's background needs Direct3D 11.1")?;
    unsafe {
        let surface = comp_device.CreateSurface(
            1,
            1,
            DXGI_FORMAT_B8G8R8A8_UNORM,
            DXGI_ALPHA_MODE_PREMULTIPLIED,
        )?;
        let mut offset = POINT::default();
        let texture: ID3D11Texture2D = surface.BeginDraw(None, &mut offset)?;
        let mut view: Option<ID3D11RenderTargetView> = None;
        let drawn = device
            .CreateRenderTargetView(&texture, None, Some(&mut view))
            .map(|()| {
                // The surface can be a pixel of a larger texture, at `offset`:
                // clear only that pixel.
                let pixel = RECT {
                    left: offset.x,
                    top: offset.y,
                    right: offset.x + 1,
                    bottom: offset.y + 1,
                };
                if let Some(view) = &view {
                    context1.ClearView(view, &color, Some(&[pixel]));
                }
            });
        surface.EndDraw()?;
        drawn.context("drawing a native view's background")?;
        Ok(surface)
    }
}

fn premultiplied(color: Hsla) -> [f32; 4] {
    let rgba = Rgba::from(color);
    [rgba.r * rgba.a, rgba.g * rgba.a, rgba.b * rgba.a, rgba.a]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn laid_out_size_round_trips_and_starts_empty() {
        let size = NativeVisualSize::default();
        assert_eq!(size.laid_out(), None);
        size.set(3840, 2160);
        assert_eq!(size.laid_out(), Some((3840, 2160)));
        size.set(1, u32::MAX);
        assert_eq!(size.laid_out(), Some((1, u32::MAX)));
    }

    #[test]
    fn corner_radius_stays_between_zero_and_half_the_shorter_side() {
        let bounds = [10.0, 20.0, 110.0, 60.0];
        let mask = [0.0, 0.0, 500.0, 500.0];
        let place = |radius| Placement::from_parts(bounds, mask, radius, [0.0; 4]);
        assert_eq!(place(64.0).corner_radius, 20.0);
        assert_eq!(place(6.0).corner_radius, 6.0);
        assert_eq!(place(-1.0).corner_radius, 0.0);
        assert_eq!((place(6.0).width(), place(6.0).height()), (100.0, 40.0));
    }

    #[test]
    fn background_is_premultiplied() {
        let half_red = Hsla::from(Rgba {
            r: 1.0,
            g: 0.0,
            b: 0.0,
            a: 0.5,
        });
        let [r, g, b, a] = premultiplied(half_red);
        assert!((r - 0.5).abs() < 1e-3 && g.abs() < 1e-3 && b.abs() < 1e-3);
        assert!((a - 0.5).abs() < 1e-3);
        assert_eq!(premultiplied(Hsla::transparent_black()), [0.0; 4]);
    }
}
