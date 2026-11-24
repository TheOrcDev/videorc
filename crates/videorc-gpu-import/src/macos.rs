//! macOS: an IOSurface id becomes a Metal texture on the device's `MTLDevice`,
//! wrapped for wgpu through `wgpu::hal::metal::Device::texture_from_raw`.

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_core_foundation::CFRetained;
use objc2_io_surface::IOSurfaceRef;
use objc2_metal::{
    MTLDevice, MTLPixelFormat, MTLTexture, MTLTextureDescriptor, MTLTextureType, MTLTextureUsage,
};

use crate::ImportError;

/// `kCVPixelFormatType_32BGRA`: the IOSurface pixel format of a BGRA8 surface.
const FOURCC_BGRA: u32 = u32::from_be_bytes(*b"BGRA");
/// `kCVPixelFormatType_32RGBA`.
const FOURCC_RGBA: u32 = u32::from_be_bytes(*b"RGBA");

/// Imports the IOSurface with `iosurface_id` as a `wgpu::Texture` on `device`.
///
/// `device` must run on the Metal backend. The texture reads the IOSurface's
/// memory directly: what the producer writes after the import is what the
/// texture shows. The IOSurface stays retained until the texture is dropped.
///
/// `width`, `height` and `format` must describe the surface. A surface of a
/// different size is refused with [`ImportError::GeometryMismatch`] (Metal
/// aborts the process on a descriptor that disagrees with its IOSurface, so
/// the check is made here) and a surface whose own pixel format is not
/// `format` with [`ImportError::FormatMismatch`]. A surface without a pixel
/// format or element size is taken at the caller's word.
pub fn import_iosurface(
    device: &wgpu::Device,
    iosurface_id: u32,
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
) -> Result<wgpu::Texture, ImportError> {
    let imported = {
        // SAFETY: the guard is dropped before the texture is handed back to
        // wgpu, and the Metal device is only used to create a texture.
        let hal_device = unsafe { device.as_hal::<wgpu::hal::api::Metal>() }.ok_or(
            ImportError::WrongBackend {
                expected: wgpu::Backend::Metal,
            },
        )?;
        import_iosurface_metal(hal_device.raw_device(), iosurface_id, width, height, format)?
    };
    let ImportedMetalTexture {
        texture: raw_texture,
        surface,
        ..
    } = imported;

    let keep_alive = SurfaceKeepAlive { _surface: surface };
    let drop_callback: wgpu::hal::DropCallback = Box::new(move || drop(keep_alive));
    // SAFETY: `raw_texture` is a 2D, single-level, single-layer texture of
    // `format` on this device's `MTLDevice`, as the descriptor below says.
    let hal_texture = unsafe {
        wgpu::hal::metal::Device::texture_from_raw(
            raw_texture,
            format,
            MTLTextureType::Type2D,
            1,
            1,
            wgpu::hal::CopyExtent {
                width,
                height,
                depth: 1,
            },
            Some(drop_callback),
        )
    };
    let descriptor = crate::imported_texture_descriptor(width, height, format);
    // SAFETY: the hal texture was created on this device and matches
    // `descriptor`; its contents are the producer's, so it is initialized.
    // Metal has no resource states, so the initial usage state is nominal.
    let texture = unsafe {
        device.create_texture_from_hal::<wgpu::hal::api::Metal>(
            hal_texture,
            &descriptor,
            wgpu::TextureUses::UNINITIALIZED,
        )
    };
    Ok(texture)
}

/// The raw-Metal half of [`import_iosurface`]: the `MTLTexture` created on
/// the IOSurface and the retained surface it reads. For presenters that draw
/// with Metal directly (plan 220 S0.2h, the native-layer route) instead of
/// through a wgpu device; the texture reads the IOSurface's memory in place
/// and the surface stays retained as long as this value lives.
pub struct ImportedMetalTexture {
    pub texture: Retained<ProtocolObject<dyn MTLTexture>>,
    pub surface: CFRetained<IOSurfaceRef>,
    pub iosurface_id: u32,
    pub width: u32,
    pub height: u32,
}

// SAFETY: a Metal texture and an IOSurface are reference-counted handles that
// Metal and IOKit share across threads; the import creates them and a
// presenter thread samples and releases them, which is how the backend's own
// compositor uses the same objects.
unsafe impl Send for ImportedMetalTexture {}
unsafe impl Sync for ImportedMetalTexture {}

/// Imports the IOSurface with `iosurface_id` as a Metal texture on `device`,
/// with the same checks as [`import_iosurface`] and no CPU copy.
pub fn import_iosurface_metal(
    device: &ProtocolObject<dyn MTLDevice>,
    iosurface_id: u32,
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
) -> Result<ImportedMetalTexture, ImportError> {
    crate::check_request(width, height, format)?;
    let surface =
        IOSurfaceRef::lookup(iosurface_id).ok_or(ImportError::SurfaceNotFound { iosurface_id })?;
    check_surface(&surface, width, height, format)?;
    let texture = create_metal_texture(device, &surface, width, height, format)?;
    Ok(ImportedMetalTexture {
        texture,
        surface,
        iosurface_id,
        width,
        height,
    })
}

/// Holds the IOSurface for the wgpu texture's lifetime; released from the
/// texture's drop callback.
struct SurfaceKeepAlive {
    _surface: CFRetained<IOSurfaceRef>,
}

// SAFETY: IOSurface objects are reference-counted, immutable handles designed
// to be shared across threads and processes; the keep-alive only releases its
// reference, from whichever thread drops the wgpu texture.
unsafe impl Send for SurfaceKeepAlive {}
unsafe impl Sync for SurfaceKeepAlive {}

fn check_surface(
    surface: &IOSurfaceRef,
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
) -> Result<(), ImportError> {
    let actual = (
        saturating_u32(surface.width()),
        saturating_u32(surface.height()),
    );
    if actual != (width, height) {
        return Err(ImportError::GeometryMismatch {
            expected: (width, height),
            actual,
        });
    }
    let planes = surface.plane_count();
    if planes > 1 {
        return Err(ImportError::FormatMismatch {
            requested: format,
            actual: format!("a {planes}-plane surface"),
        });
    }
    let fourcc = surface.pixel_format();
    if fourcc != 0 && fourcc != expected_fourcc(format) {
        return Err(ImportError::FormatMismatch {
            requested: format,
            actual: format!("pixel format '{}'", fourcc_string(fourcc)),
        });
    }
    let bytes_per_element = surface.bytes_per_element();
    if bytes_per_element != 0 && bytes_per_element != 4 {
        return Err(ImportError::FormatMismatch {
            requested: format,
            actual: format!("{bytes_per_element} bytes per element"),
        });
    }
    Ok(())
}

fn create_metal_texture(
    device: &ProtocolObject<dyn MTLDevice>,
    surface: &IOSurfaceRef,
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
) -> Result<Retained<ProtocolObject<dyn MTLTexture>>, ImportError> {
    // SAFETY: a plain descriptor constructor; `check_surface` made sure the
    // geometry is the IOSurface's own.
    let descriptor = unsafe {
        MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
            metal_pixel_format(format),
            width as usize,
            height as usize,
            false,
        )
    };
    descriptor.setUsage(MTLTextureUsage::ShaderRead | MTLTextureUsage::RenderTarget);
    device
        .newTextureWithDescriptor_iosurface_plane(&descriptor, surface, 0)
        .ok_or(ImportError::TextureCreationFailed)
}

fn metal_pixel_format(format: wgpu::TextureFormat) -> MTLPixelFormat {
    match format {
        wgpu::TextureFormat::Bgra8Unorm => MTLPixelFormat::BGRA8Unorm,
        wgpu::TextureFormat::Rgba8Unorm => MTLPixelFormat::RGBA8Unorm,
        other => unreachable!("check_request admits only the supported formats, not {other:?}"),
    }
}

fn expected_fourcc(format: wgpu::TextureFormat) -> u32 {
    match format {
        wgpu::TextureFormat::Bgra8Unorm => FOURCC_BGRA,
        wgpu::TextureFormat::Rgba8Unorm => FOURCC_RGBA,
        other => unreachable!("check_request admits only the supported formats, not {other:?}"),
    }
}

fn fourcc_string(fourcc: u32) -> String {
    fourcc
        .to_be_bytes()
        .iter()
        .map(|byte| {
            if byte.is_ascii_graphic() {
                char::from(*byte)
            } else {
                '?'
            }
        })
        .collect()
}

fn saturating_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fourcc_matches_core_video_constants() {
        // kCVPixelFormatType_32BGRA and kCVPixelFormatType_32RGBA.
        assert_eq!(FOURCC_BGRA, 0x4247_5241);
        assert_eq!(FOURCC_RGBA, 0x5247_4241);
        assert_eq!(fourcc_string(FOURCC_BGRA), "BGRA");
        assert_eq!(fourcc_string(0x0000_0001), "????");
    }
}
