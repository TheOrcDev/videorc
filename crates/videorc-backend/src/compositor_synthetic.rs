use std::time::Instant;

#[derive(Debug, Clone, PartialEq)]
pub struct SyntheticCompositorFrame {
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub marker_x: u32,
    pub marker_y: u32,
    pub captured_at: Instant,
}

#[derive(Debug, Default)]
pub struct SyntheticMovingSource;

impl SyntheticMovingSource {
    pub fn render(&self, sequence: u64, width: u32, height: u32) -> SyntheticCompositorFrame {
        let width = width.max(1);
        let height = height.max(1);
        SyntheticCompositorFrame {
            sequence,
            width,
            height,
            marker_x: (sequence as u32).wrapping_mul(7) % width,
            marker_y: (sequence as u32).wrapping_mul(5) % height,
            captured_at: Instant::now(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthetic_source_moves_between_frames() {
        let source = SyntheticMovingSource;

        let first = source.render(1, 1920, 1080);
        let second = source.render(2, 1920, 1080);

        assert_ne!(
            (first.marker_x, first.marker_y),
            (second.marker_x, second.marker_y)
        );
        assert_eq!(second.width, 1920);
        assert_eq!(second.height, 1080);
    }
}
