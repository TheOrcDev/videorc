use sha2::{Digest, Sha256};

use crate::windows_d3d11_device::{
    WindowsD3d11BgraTextureDescriptor, WindowsD3d11TextureDimensions,
};
#[cfg(target_os = "windows")]
use crate::windows_d3d11_device::{WindowsD3d11Error, WindowsD3d11ErrorCode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11TestPatternColor {
    pub(crate) red: u8,
    pub(crate) green: u8,
    pub(crate) blue: u8,
    pub(crate) alpha: u8,
}

impl WindowsD3d11TestPatternColor {
    const fn bgra(self) -> [u8; 4] {
        [self.blue, self.green, self.red, self.alpha]
    }

    #[cfg(target_os = "windows")]
    fn normalized_rgba(self) -> [f32; 4] {
        [
            f32::from(self.red) / 255.0,
            f32::from(self.green) / 255.0,
            f32::from(self.blue) / 255.0,
            f32::from(self.alpha) / 255.0,
        ]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11TestPatternSample {
    pub(crate) x: u32,
    pub(crate) y: u32,
    pub(crate) expected_bgra: [u8; 4],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowsD3d11TestPatternMetadata {
    pub(crate) sequence: u64,
    dimensions: WindowsD3d11TextureDimensions,
    pub(crate) quadrants: [WindowsD3d11TestPatternColor; 4],
    pub(crate) samples: [WindowsD3d11TestPatternSample; 4],
    pub(crate) expected_bgra_sha256: String,
}

impl WindowsD3d11TestPatternMetadata {
    pub(crate) const fn dimensions(&self) -> WindowsD3d11TextureDimensions {
        self.dimensions
    }
}

pub(crate) fn d3d11_test_pattern_metadata(
    descriptor: WindowsD3d11BgraTextureDescriptor,
    sequence: u64,
) -> WindowsD3d11TestPatternMetadata {
    let dimensions = descriptor.dimensions();
    let quadrants = test_pattern_colors(sequence);
    let split_x = dimensions.width / 2;
    let split_y = dimensions.height / 2;
    let samples = [
        WindowsD3d11TestPatternSample {
            x: split_x.saturating_sub(1) / 2,
            y: split_y.saturating_sub(1) / 2,
            expected_bgra: quadrants[0].bgra(),
        },
        WindowsD3d11TestPatternSample {
            x: split_x + dimensions.width.saturating_sub(split_x + 1) / 2,
            y: split_y.saturating_sub(1) / 2,
            expected_bgra: quadrants[1].bgra(),
        },
        WindowsD3d11TestPatternSample {
            x: split_x.saturating_sub(1) / 2,
            y: split_y + dimensions.height.saturating_sub(split_y + 1) / 2,
            expected_bgra: quadrants[2].bgra(),
        },
        WindowsD3d11TestPatternSample {
            x: split_x + dimensions.width.saturating_sub(split_x + 1) / 2,
            y: split_y + dimensions.height.saturating_sub(split_y + 1) / 2,
            expected_bgra: quadrants[3].bgra(),
        },
    ];
    WindowsD3d11TestPatternMetadata {
        sequence,
        dimensions,
        quadrants,
        samples,
        expected_bgra_sha256: expected_bgra_sha256(dimensions, quadrants),
    }
}

fn test_pattern_colors(sequence: u64) -> [WindowsD3d11TestPatternColor; 4] {
    let bytes = sequence.to_le_bytes();
    [
        WindowsD3d11TestPatternColor {
            red: bytes[0] ^ 0x21,
            green: bytes[1] ^ 0x43,
            blue: bytes[4] ^ 0xe7,
            alpha: 255,
        },
        WindowsD3d11TestPatternColor {
            red: bytes[2] ^ 0x65,
            green: bytes[3] ^ 0x87,
            blue: bytes[5] ^ 0xc5,
            alpha: 255,
        },
        WindowsD3d11TestPatternColor {
            red: bytes[4] ^ 0xa9,
            green: bytes[5] ^ 0xcb,
            blue: bytes[6] ^ 0x83,
            alpha: 255,
        },
        WindowsD3d11TestPatternColor {
            red: bytes[6] ^ 0xed,
            green: bytes[7] ^ 0x0f,
            blue: bytes[7] ^ 0x41,
            alpha: 255,
        },
    ]
}

fn expected_bgra_sha256(
    dimensions: WindowsD3d11TextureDimensions,
    quadrants: [WindowsD3d11TestPatternColor; 4],
) -> String {
    let split_x = dimensions.width / 2;
    let split_y = dimensions.height / 2;
    let row_len =
        usize::try_from(dimensions.width).expect("validated D3D11 texture width fits usize") * 4;
    let mut top_row = Vec::with_capacity(row_len);
    let mut bottom_row = Vec::with_capacity(row_len);
    append_pixels(&mut top_row, quadrants[0], split_x);
    append_pixels(&mut top_row, quadrants[1], dimensions.width - split_x);
    append_pixels(&mut bottom_row, quadrants[2], split_x);
    append_pixels(&mut bottom_row, quadrants[3], dimensions.width - split_x);
    let mut hasher = Sha256::new();
    for _ in 0..split_y {
        hasher.update(&top_row);
    }
    for _ in split_y..dimensions.height {
        hasher.update(&bottom_row);
    }
    format!("{:x}", hasher.finalize())
}

fn append_pixels(row: &mut Vec<u8>, color: WindowsD3d11TestPatternColor, count: u32) {
    let pixel = color.bgra();
    for _ in 0..count {
        row.extend_from_slice(&pixel);
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn render_bgra_test_pattern(
    device: &crate::windows_d3d11_device::WindowsD3d11Device,
    texture: &windows::Win32::Graphics::Direct3D11::ID3D11Texture2D,
    descriptor: WindowsD3d11BgraTextureDescriptor,
    sequence: u64,
) -> Result<WindowsD3d11TestPatternMetadata, WindowsD3d11Error> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Direct3D11::ID3D11RenderTargetView;

    let metadata = d3d11_test_pattern_metadata(descriptor, sequence);
    let dimensions = metadata.dimensions();
    let split_x = i32::try_from(dimensions.width / 2).map_err(|error| {
        WindowsD3d11Error::new(
            WindowsD3d11ErrorCode::InvalidTextureDescriptor,
            format!("test-pattern split X does not fit Win32 RECT: {error}"),
        )
    })?;
    let split_y = i32::try_from(dimensions.height / 2).map_err(|error| {
        WindowsD3d11Error::new(
            WindowsD3d11ErrorCode::InvalidTextureDescriptor,
            format!("test-pattern split Y does not fit Win32 RECT: {error}"),
        )
    })?;
    let width = i32::try_from(dimensions.width).map_err(|error| {
        WindowsD3d11Error::new(
            WindowsD3d11ErrorCode::InvalidTextureDescriptor,
            format!("test-pattern width does not fit Win32 RECT: {error}"),
        )
    })?;
    let height = i32::try_from(dimensions.height).map_err(|error| {
        WindowsD3d11Error::new(
            WindowsD3d11ErrorCode::InvalidTextureDescriptor,
            format!("test-pattern height does not fit Win32 RECT: {error}"),
        )
    })?;
    let rectangles = [
        RECT {
            left: 0,
            top: 0,
            right: split_x,
            bottom: split_y,
        },
        RECT {
            left: split_x,
            top: 0,
            right: width,
            bottom: split_y,
        },
        RECT {
            left: 0,
            top: split_y,
            right: split_x,
            bottom: height,
        },
        RECT {
            left: split_x,
            top: split_y,
            right: width,
            bottom: height,
        },
    ];
    let mut render_target: Option<ID3D11RenderTargetView> = None;
    // SAFETY: the texture belongs to the same device/media thread and the
    // output Option remains valid for the duration of the call.
    unsafe {
        device
            .raw_device()
            .CreateRenderTargetView(texture, None, Some(&mut render_target))
    }
    .map_err(|error| {
        WindowsD3d11Error::new(
            WindowsD3d11ErrorCode::TextureCreationFailed,
            format!("creating test-pattern render-target view failed: {error}"),
        )
    })?;
    let render_target = render_target.ok_or_else(|| {
        WindowsD3d11Error::new(
            WindowsD3d11ErrorCode::TextureCreationFailed,
            "creating test-pattern render-target view returned no view",
        )
    })?;
    for (rectangle, color) in rectangles.iter().zip(metadata.quadrants) {
        // SAFETY: the view/context are thread-confined and each RECT is within
        // the validated texture dimensions.
        unsafe {
            device.immediate_context().ClearView(
                &render_target,
                &color.normalized_rgba(),
                Some(std::slice::from_ref(rectangle)),
            );
        }
    }
    Ok(metadata)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_d3d11_test_pattern_changes_every_frame() {
        let descriptor = WindowsD3d11BgraTextureDescriptor::new(16, 8).unwrap();
        for sequence in [0, 1, 255, 256, u32::MAX as u64, u64::MAX - 1] {
            let current = d3d11_test_pattern_metadata(descriptor, sequence);
            let next = d3d11_test_pattern_metadata(descriptor, sequence.wrapping_add(1));
            assert_ne!(current.quadrants, next.quadrants);
            assert_ne!(current.expected_bgra_sha256, next.expected_bgra_sha256);
        }
    }

    #[test]
    fn two_by_two_hash_matches_quadrant_bgra_order() {
        let descriptor = WindowsD3d11BgraTextureDescriptor::new(2, 2).unwrap();
        let metadata = d3d11_test_pattern_metadata(descriptor, 0x0123_4567_89ab_cdef);
        let expected_pixels = [
            metadata.quadrants[0].bgra(),
            metadata.quadrants[1].bgra(),
            metadata.quadrants[2].bgra(),
            metadata.quadrants[3].bgra(),
        ]
        .concat();
        assert_eq!(
            metadata.expected_bgra_sha256,
            format!("{:x}", Sha256::digest(expected_pixels))
        );
        assert_eq!(
            metadata.samples.map(|sample| sample.expected_bgra),
            metadata.quadrants.map(WindowsD3d11TestPatternColor::bgra)
        );
    }

    #[test]
    fn odd_bgra_dimensions_are_covered_without_gaps() {
        let descriptor = WindowsD3d11BgraTextureDescriptor::new(3, 3).unwrap();
        let metadata = d3d11_test_pattern_metadata(descriptor, 7);
        assert_eq!(metadata.dimensions().width, 3);
        assert_eq!(metadata.dimensions().height, 3);
        assert!(
            metadata
                .samples
                .iter()
                .all(|sample| sample.x < 3 && sample.y < 3)
        );
        assert_eq!(metadata.expected_bgra_sha256.len(), 64);
    }
}
