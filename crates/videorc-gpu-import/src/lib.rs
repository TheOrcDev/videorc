//! Imports the backend's shared preview surface as a [`wgpu::Texture`] on a
//! caller-supplied [`wgpu::Device`], with no CPU copy (plan 220, S0.2a).
//!
//! The backend renders the preview into a shared GPU surface and hands the UI
//! a handle to it: an IOSurface id on macOS, a D3D11 NT handle on Windows, a
//! dma-buf file descriptor on Linux. This crate turns that handle into a
//! `wgpu::Texture` that reads the same memory, so the UI can draw the preview
//! as an ordinary element of whichever framework owns the device. The crate
//! knows no UI framework.
//!
//! - macOS: [`import_iosurface`] wraps a Metal texture created on the
//!   IOSurface with `newTextureWithDescriptor:iosurface:plane:`. The IOSurface
//!   is retained for as long as the texture lives.
//! - Windows: [`import_d3d11_nt_handle`] opens the NT handle on the device's
//!   D3D12 device (`OpenSharedHandle`). The opened resource holds the shared
//!   texture alive for as long as the wgpu texture lives.
//! - Linux: [`import_dmabuf`] imports the dma-buf through Vulkan
//!   (`VK_EXT_external_memory_dma_buf`); Vulkan takes ownership of the fd.
//!
//! Two formats are accepted: [`wgpu::TextureFormat::Bgra8Unorm`], the
//! backend's format (`MTLPixelFormatBGRA8Unorm` / `DXGI_FORMAT_B8G8R8A8_UNORM`),
//! and [`wgpu::TextureFormat::Rgba8Unorm`]. Every imported texture carries
//! [`IMPORTED_TEXTURE_USAGES`]: it can be sampled, copied from and rendered to.
//!
//! The import never synchronises with the producer. The frame-id handshake and
//! the 3-slot ring the backend keeps today decide when a surface may be read.

use std::fmt;

/// The formats an import accepts. `Bgra8Unorm` is what the backend renders.
pub const SUPPORTED_FORMATS: [wgpu::TextureFormat; 2] = [
    wgpu::TextureFormat::Bgra8Unorm,
    wgpu::TextureFormat::Rgba8Unorm,
];

/// The usages every imported texture is created with.
///
/// `TEXTURE_BINDING` lets the UI sample it, `COPY_SRC` lets tests and
/// diagnostics read it back, and `RENDER_ATTACHMENT` is what Slint's
/// `Image::try_from(wgpu::Texture)` requires of a foreign texture.
pub const IMPORTED_TEXTURE_USAGES: wgpu::TextureUsages = wgpu::TextureUsages::TEXTURE_BINDING
    .union(wgpu::TextureUsages::COPY_SRC)
    .union(wgpu::TextureUsages::RENDER_ATTACHMENT);

const LABEL: &str = "videorc-gpu-import preview surface";

/// Why an import was refused. Every variant names what was asked and what was
/// found, so the UI can show the reason instead of a blank preview.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ImportError {
    /// The requested format is not one of [`SUPPORTED_FORMATS`].
    UnsupportedFormat(wgpu::TextureFormat),
    /// Width or height is zero.
    ZeroSize { width: u32, height: u32 },
    /// The device does not run on the backend this platform imports through
    /// (Metal on macOS, D3D12 on Windows, Vulkan on Linux).
    WrongBackend { expected: wgpu::Backend },
    /// macOS: `IOSurfaceLookup` found no surface with this id. The producer
    /// has released it, or it is not lookupable from this process.
    SurfaceNotFound { iosurface_id: u32 },
    /// The shared surface is not the size the caller asked for. Metal aborts
    /// the process when a texture descriptor disagrees with its IOSurface, so
    /// the check happens here and the caller decides what to do with a stale
    /// frame description.
    GeometryMismatch {
        expected: (u32, u32),
        actual: (u32, u32),
    },
    /// The shared surface's own pixel layout is not the requested format.
    FormatMismatch {
        requested: wgpu::TextureFormat,
        actual: String,
    },
    /// The platform API returned no texture for a surface that passed every
    /// check.
    TextureCreationFailed,
    /// Windows: `ID3D12Device::OpenSharedHandle` failed with this HRESULT.
    SharedHandleOpenFailed { code: i32, message: String },
    /// Linux: the device was created without a feature the import needs.
    MissingDeviceFeature(wgpu::Features),
    /// The driver refused the import (wgpu-hal's `DeviceError`).
    Device(String),
}

impl fmt::Display for ImportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedFormat(format) => write!(
                f,
                "unsupported texture format {format:?}; the import accepts {SUPPORTED_FORMATS:?}"
            ),
            Self::ZeroSize { width, height } => {
                write!(f, "a {width}x{height} surface has no pixels to import")
            }
            Self::WrongBackend { expected } => {
                write!(
                    f,
                    "the wgpu device does not run on the {expected:?} backend"
                )
            }
            Self::SurfaceNotFound { iosurface_id } => {
                write!(f, "no IOSurface with id {iosurface_id} is lookupable")
            }
            Self::GeometryMismatch { expected, actual } => write!(
                f,
                "the shared surface is {}x{} but the frame says {}x{}",
                actual.0, actual.1, expected.0, expected.1
            ),
            Self::FormatMismatch { requested, actual } => {
                write!(f, "the shared surface holds {actual}, not {requested:?}")
            }
            Self::TextureCreationFailed => {
                write!(f, "the platform returned no texture for the shared surface")
            }
            Self::SharedHandleOpenFailed { code, message } => {
                write!(f, "OpenSharedHandle failed ({code:#010x}): {message}")
            }
            Self::MissingDeviceFeature(features) => write!(
                f,
                "the wgpu device was created without {features:?}, which the import needs"
            ),
            Self::Device(message) => write!(f, "the driver refused the import: {message}"),
        }
    }
}

impl std::error::Error for ImportError {}

/// The descriptor every imported texture is registered with: a 2D,
/// single-level, single-sample texture of `format` with
/// [`IMPORTED_TEXTURE_USAGES`]. Callers that need to know what they got
/// (Slint checks the usage) can build the same descriptor.
pub fn imported_texture_descriptor(
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
) -> wgpu::TextureDescriptor<'static> {
    wgpu::TextureDescriptor {
        label: Some(LABEL),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: IMPORTED_TEXTURE_USAGES,
        view_formats: &[],
    }
}

/// Rejects a request before any platform call: zero sizes and formats the
/// import does not carry.
fn check_request(width: u32, height: u32, format: wgpu::TextureFormat) -> Result<(), ImportError> {
    if !SUPPORTED_FORMATS.contains(&format) {
        return Err(ImportError::UnsupportedFormat(format));
    }
    if width == 0 || height == 0 {
        return Err(ImportError::ZeroSize { width, height });
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{ImportedMetalTexture, import_iosurface, import_iosurface_metal};

#[cfg(target_os = "windows")]
mod windows_d3d12;
#[cfg(target_os = "windows")]
pub use windows_d3d12::import_d3d11_nt_handle;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{DmabufPlane, import_dmabuf};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_check_names_the_refused_format() {
        assert_eq!(
            check_request(16, 8, wgpu::TextureFormat::Rgba16Float),
            Err(ImportError::UnsupportedFormat(
                wgpu::TextureFormat::Rgba16Float
            ))
        );
        assert_eq!(
            check_request(16, 8, wgpu::TextureFormat::Bgra8Unorm),
            Ok(())
        );
        assert_eq!(
            check_request(16, 8, wgpu::TextureFormat::Rgba8Unorm),
            Ok(())
        );
    }

    #[test]
    fn request_check_refuses_an_empty_surface() {
        assert_eq!(
            check_request(0, 8, wgpu::TextureFormat::Bgra8Unorm),
            Err(ImportError::ZeroSize {
                width: 0,
                height: 8
            })
        );
        assert_eq!(
            check_request(16, 0, wgpu::TextureFormat::Bgra8Unorm),
            Err(ImportError::ZeroSize {
                width: 16,
                height: 0
            })
        );
    }

    #[test]
    fn imported_descriptor_is_a_single_2d_level_with_the_shared_usages() {
        let descriptor = imported_texture_descriptor(1920, 1080, wgpu::TextureFormat::Bgra8Unorm);
        assert_eq!(descriptor.size.width, 1920);
        assert_eq!(descriptor.size.height, 1080);
        assert_eq!(descriptor.size.depth_or_array_layers, 1);
        assert_eq!(descriptor.mip_level_count, 1);
        assert_eq!(descriptor.sample_count, 1);
        assert_eq!(descriptor.dimension, wgpu::TextureDimension::D2);
        assert_eq!(descriptor.format, wgpu::TextureFormat::Bgra8Unorm);
        assert!(
            descriptor
                .usage
                .contains(wgpu::TextureUsages::TEXTURE_BINDING)
        );
        assert!(
            descriptor
                .usage
                .contains(wgpu::TextureUsages::RENDER_ATTACHMENT)
        );
        assert!(descriptor.usage.contains(wgpu::TextureUsages::COPY_SRC));
    }

    #[test]
    fn errors_read_as_sentences() {
        let message = ImportError::GeometryMismatch {
            expected: (1920, 1080),
            actual: (1280, 720),
        }
        .to_string();
        assert_eq!(
            message,
            "the shared surface is 1280x720 but the frame says 1920x1080"
        );
        let message = ImportError::SharedHandleOpenFailed {
            code: -2147024809,
            message: "The parameter is incorrect.".to_string(),
        }
        .to_string();
        assert_eq!(
            message,
            "OpenSharedHandle failed (0x80070057): The parameter is incorrect."
        );
    }
}
