//! Plan 260 S0.8: LiveKit's Rust SDK as the host of a talk-show room, the
//! way the backend would hold it (D9). Measures plan 220's room spike Part 2
//! (`videorc-rust:docs/rust-ui/spike-guests-room.md`) against a local
//! `livekit-server` with browser guests.
//!
//! The host publishes a synthetic camera (VP8, simulcast 180p/360p under
//! 720p, as Electron) and microphone (a 440 Hz tone), and a screen on
//! request (VP8, no simulcast, 4 Mbps). Every frame carries a 48-bit
//! wall-clock barcode in its top rows; the guests draw the same, so each
//! side measures camera-to-screen delay. It subscribes to every guest,
//! decodes every frame, checks each guest's tone, sends the stage message,
//! the overlay byte streams (a 2 MiB PNG, a clear, two cancelled sets), and
//! never subscribes to the program page.
//!
//! Built without the `room` feature it is the same program minus the SDK:
//! the size baseline.

#[cfg(feature = "room")]
mod host;

fn main() -> anyhow::Result<()> {
    #[cfg(feature = "room")]
    {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?
            .block_on(host::run())
    }
    #[cfg(not(feature = "room"))]
    {
        // The baseline links what the host links besides the SDK.
        let png = barcode::noise_png(816, 816);
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
        rt.block_on(async {
            let value = serde_json::json!({"baseline": true, "png": png.len()});
            println!("{value}");
            futures::future::ready(()).await;
        });
        Ok(())
    }
}

/// The barcode both sides draw and read, and the overlay image.
pub mod barcode {
    pub const BLOCK: u32 = 24;
    pub const LEFT: u32 = 16;
    pub const ROW_A: u32 = 8;
    pub const ROW_B: u32 = 40;
    pub const BITS: u32 = 48;
    pub const REFERENCE_WIDTH: u32 = 1280;

    /// Writes `value` into an I420 luma plane laid out at 1280 wide.
    pub fn draw(y: &mut [u8], stride: usize, value: u64) {
        for bit in 0..BITS {
            let on = (value >> (BITS - 1 - bit)) & 1 == 1;
            let x0 = (LEFT + bit * BLOCK) as usize;
            for (row, level) in [(ROW_A, on), (ROW_B, !on)] {
                let luma = if level { 235 } else { 16 };
                for line in row as usize..(row + BLOCK) as usize {
                    y[line * stride + x0..line * stride + x0 + BLOCK as usize].fill(luma);
                }
            }
        }
    }

    /// Reads it back at any scale; `None` when any bit is unclear.
    pub fn read(y: &[u8], stride: usize, width: u32) -> Option<u64> {
        let scale = f64::from(width) / f64::from(REFERENCE_WIDTH);
        let at = |x: f64, row: u32| {
            let cy = ((f64::from(row) + f64::from(BLOCK) / 2.0) * scale) as usize;
            let cx = x as usize;
            let mut sum = 0u32;
            for dy in 0..2 {
                for dx in 0..2 {
                    sum += u32::from(y[(cy + dy) * stride + cx + dx]);
                }
            }
            sum / 4
        };
        let mut value = 0u64;
        for bit in 0..BITS {
            let x = (f64::from(LEFT + bit * BLOCK) + f64::from(BLOCK) / 2.0) * scale;
            let (a, b) = (at(x, ROW_A), at(x, ROW_B));
            if a.abs_diff(b) < 40 {
                return None;
            }
            value = (value << 1) | u64::from(a > b);
        }
        Some(value)
    }

    /// An incompressible PNG (noise), RGB: 816 x 816 gives about 2.0 MB.
    pub fn noise_png(width: u32, height: u32) -> Vec<u8> {
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let pixels: Vec<u8> = (0..width * height * 3)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state as u8
            })
            .collect();
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, width, height);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.set_compression(png::Compression::Fast);
            let mut writer = encoder.write_header().expect("png header");
            writer.write_image_data(&pixels).expect("png data");
        }
        out
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn barcode_round_trips_at_full_and_half_scale() {
            let (w, h) = (1280usize, 720usize);
            let mut y = vec![128u8; w * h];
            let value = 1_764_000_123_456u64;
            super::draw(&mut y, w, value);
            assert_eq!(super::read(&y, w, 1280), Some(value));
            let half: Vec<u8> = (0..h / 2)
                .flat_map(|row| (0..w / 2).map(move |col| (row, col)))
                .map(|(row, col)| y[row * 2 * w + col * 2])
                .collect();
            assert_eq!(super::read(&half, w / 2, 640), Some(value));
        }
    }
}
