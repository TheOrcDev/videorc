//! Linux: a dma-buf file descriptor is imported through Vulkan with wgpu 30's
//! `wgpu::hal::vulkan::Device::texture_from_dmabuf_fd`.

use std::os::fd::OwnedFd;

use crate::ImportError;

/// One plane of a dma-buf, as the producer exports it (a `wl_buffer`'s
/// `zwp_linux_dmabuf` parameters, a PipeWire `SPA_DATA_DmaBuf` chunk, or a
/// GBM bo's fd, stride, offset and modifier).
///
/// Only single-plane layouts are supported, which covers every 32-bit RGB
/// format. `Bgra8Unorm` is `DRM_FORMAT_ARGB8888`; `Rgba8Unorm` is
/// `DRM_FORMAT_ABGR8888`.
#[derive(Debug)]
pub struct DmabufPlane {
    /// The dma-buf. Vulkan takes ownership on success and closes it on
    /// failure.
    pub fd: OwnedFd,
    /// Byte offset of the plane within the dma-buf.
    pub offset: u64,
    /// Bytes per row.
    pub stride: u64,
    /// The DRM format modifier (`DRM_FORMAT_MOD_LINEAR` is 0).
    pub modifier: u64,
}

/// Imports `plane` as a `wgpu::Texture` on `device`.
///
/// `device` must run on the Vulkan backend and have been created with
/// [`wgpu::Features::VULKAN_EXTERNAL_MEMORY_DMA_BUF`]; without it the import
/// is refused with [`ImportError::MissingDeviceFeature`].
///
/// The texture's image starts in `VK_IMAGE_LAYOUT_UNDEFINED`; the first use
/// transitions it. Whether the driver preserves the dma-buf's contents across
/// that transition is the driver's promise for imported memory, not this
/// crate's, and is what S0.2's Linux run measures.
///
/// # Safety
///
/// `plane` must describe a real dma-buf of `width` x `height` pixels in
/// `format` with the given stride, offset and modifier. The GPU reads the
/// memory as described; nothing validates the layout against the fd.
pub unsafe fn import_dmabuf(
    device: &wgpu::Device,
    plane: DmabufPlane,
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
) -> Result<wgpu::Texture, ImportError> {
    crate::check_request(width, height, format)?;
    let required = wgpu::Features::VULKAN_EXTERNAL_MEMORY_DMA_BUF;
    if !device.features().contains(required) {
        return Err(ImportError::MissingDeviceFeature(required));
    }

    let size = wgpu::Extent3d {
        width,
        height,
        depth_or_array_layers: 1,
    };
    let hal_texture = {
        // SAFETY: the guard is dropped before the texture is handed back to
        // wgpu.
        let hal_device = unsafe { device.as_hal::<wgpu::hal::api::Vulkan>() }.ok_or(
            ImportError::WrongBackend {
                expected: wgpu::Backend::Vulkan,
            },
        )?;
        let hal_descriptor = wgpu::hal::TextureDescriptor {
            label: Some(crate::LABEL),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUses::RESOURCE
                | wgpu::TextureUses::COLOR_TARGET
                | wgpu::TextureUses::COPY_SRC,
            memory_flags: wgpu::hal::MemoryFlags::empty(),
            view_formats: Vec::new(),
        };
        // SAFETY: the caller vouches for the dma-buf's layout (this
        // function's contract); the device has the dma-buf feature.
        unsafe {
            hal_device.texture_from_dmabuf_fd(
                plane.fd,
                &hal_descriptor,
                plane.modifier,
                plane.stride,
                plane.offset,
            )
        }
        .map_err(|error| ImportError::Device(error.to_string()))?
    };

    let descriptor = crate::imported_texture_descriptor(width, height, format);
    // SAFETY: the hal texture was created on this device and matches
    // `descriptor`; the image is in the undefined layout until first use,
    // which `UNINITIALIZED` maps to.
    let texture = unsafe {
        device.create_texture_from_hal::<wgpu::hal::api::Vulkan>(
            hal_texture,
            &descriptor,
            wgpu::TextureUses::UNINITIALIZED,
        )
    };
    Ok(texture)
}
