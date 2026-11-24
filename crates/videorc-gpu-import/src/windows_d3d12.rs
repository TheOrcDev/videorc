//! Windows: a D3D11 shared NT handle is opened on the device's `ID3D12Device`
//! and wrapped for wgpu through `wgpu::hal::dx12::Device::texture_from_raw`.

use std::os::windows::io::RawHandle;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::Graphics::Direct3D12::{
    D3D12_RESOURCE_DESC, D3D12_RESOURCE_DIMENSION_TEXTURE2D, ID3D12Resource,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R8G8B8A8_UNORM,
};

use crate::ImportError;

/// Imports the texture behind a D3D11 shared NT handle as a `wgpu::Texture`
/// on `device`.
///
/// `device` must run on the D3D12 backend. The producer creates its texture
/// with `D3D11_RESOURCE_MISC_SHARED_NTHANDLE` and exports it with
/// `IDXGIResource1::CreateSharedHandle`; this opens that handle with
/// `ID3D12Device::OpenSharedHandle`. The opened `ID3D12Resource` keeps the
/// shared texture alive for as long as the wgpu texture lives; the caller
/// keeps ownership of `handle` itself and may close it after the import.
///
/// `width`, `height` and `format` must match the resource's own description;
/// a mismatch is refused with [`ImportError::GeometryMismatch`] or
/// [`ImportError::FormatMismatch`]. The import does not synchronise with the
/// producer: cross-API access to the texture still needs the keyed mutex or a
/// shared fence the producer and the UI agree on.
pub fn import_d3d11_nt_handle(
    device: &wgpu::Device,
    handle: RawHandle,
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
) -> Result<wgpu::Texture, ImportError> {
    crate::check_request(width, height, format)?;

    let resource = {
        // SAFETY: the guard is dropped before the texture is handed back to
        // wgpu, and the D3D12 device is only used to open the handle.
        let hal_device = unsafe { device.as_hal::<wgpu::hal::api::Dx12>() }.ok_or(
            ImportError::WrongBackend {
                expected: wgpu::Backend::Dx12,
            },
        )?;
        let mut resource: Option<ID3D12Resource> = None;
        // SAFETY: `OpenSharedHandle` validates the handle itself and writes a
        // resource interface, or nothing, into `resource`.
        unsafe {
            hal_device
                .raw_device()
                .OpenSharedHandle(HANDLE(handle), &mut resource)
        }
        .map_err(|error| ImportError::SharedHandleOpenFailed {
            code: error.code().0,
            message: error.message(),
        })?;
        resource.ok_or(ImportError::SharedHandleOpenFailed {
            code: 0,
            message: "OpenSharedHandle returned no resource".to_string(),
        })?
    };

    // SAFETY: `GetDesc` reads the resource's description into a value.
    let description = unsafe { resource.GetDesc() };
    check_resource(&description, width, height, format)?;

    let size = wgpu::Extent3d {
        width,
        height,
        depth_or_array_layers: 1,
    };
    // SAFETY: `check_resource` proved the resource is a 2D, single-level,
    // single-sample texture of `format` and `size`.
    let hal_texture = unsafe {
        wgpu::hal::dx12::Device::texture_from_raw(
            resource,
            format,
            wgpu::TextureDimension::D2,
            size,
            1,
            1,
        )
    };
    let descriptor = crate::imported_texture_descriptor(width, height, format);
    // SAFETY: the hal texture was opened on this device and matches
    // `descriptor`; its contents are the producer's, so it is initialized. A
    // shared resource is in `D3D12_RESOURCE_STATE_COMMON`, which is what the
    // dx12 backend maps `UNINITIALIZED` to for the first transition.
    let texture = unsafe {
        device.create_texture_from_hal::<wgpu::hal::api::Dx12>(
            hal_texture,
            &descriptor,
            wgpu::TextureUses::UNINITIALIZED,
        )
    };
    Ok(texture)
}

fn check_resource(
    description: &D3D12_RESOURCE_DESC,
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
) -> Result<(), ImportError> {
    if description.Dimension != D3D12_RESOURCE_DIMENSION_TEXTURE2D
        || description.DepthOrArraySize != 1
        || description.MipLevels != 1
        || description.SampleDesc.Count != 1
    {
        return Err(ImportError::FormatMismatch {
            requested: format,
            actual: format!(
                "a resource of dimension {}, {} slices, {} mip levels, {} samples",
                description.Dimension.0,
                description.DepthOrArraySize,
                description.MipLevels,
                description.SampleDesc.Count
            ),
        });
    }
    let actual = (
        u32::try_from(description.Width).unwrap_or(u32::MAX),
        description.Height,
    );
    if actual != (width, height) {
        return Err(ImportError::GeometryMismatch {
            expected: (width, height),
            actual,
        });
    }
    if description.Format != dxgi_format(format) {
        return Err(ImportError::FormatMismatch {
            requested: format,
            actual: format!("DXGI_FORMAT {}", description.Format.0),
        });
    }
    Ok(())
}

fn dxgi_format(format: wgpu::TextureFormat) -> DXGI_FORMAT {
    match format {
        wgpu::TextureFormat::Bgra8Unorm => DXGI_FORMAT_B8G8R8A8_UNORM,
        wgpu::TextureFormat::Rgba8Unorm => DXGI_FORMAT_R8G8B8A8_UNORM,
        other => unreachable!("check_request admits only the supported formats, not {other:?}"),
    }
}
