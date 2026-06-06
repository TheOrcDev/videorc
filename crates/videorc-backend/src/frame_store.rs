use std::sync::Arc;
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct StoredFrame<P, M = ()> {
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub pixel_format: P,
    #[allow(dead_code)]
    pub metadata: M,
    pub bytes: Vec<u8>,
    pub captured_at: Instant,
}

pub type FrameHandle<P, M = ()> = Arc<StoredFrame<P, M>>;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FrameStoreStats {
    pub buffer_count: u64,
    pub bytes_retained: u64,
    pub frames_dropped: u64,
    pub buffer_allocations: u64,
}

#[derive(Debug)]
pub struct FrameStore<P, M = ()> {
    latest: Option<FrameHandle<P, M>>,
    spare_buffers: Vec<Vec<u8>>,
    max_spare_buffers: usize,
    frames_replaced: u64,
    buffer_allocations: u64,
}

impl<P, M> Default for FrameStore<P, M> {
    fn default() -> Self {
        Self::new(1)
    }
}

impl<P, M> FrameStore<P, M> {
    pub fn new(max_spare_buffers: usize) -> Self {
        Self {
            latest: None,
            spare_buffers: Vec::new(),
            max_spare_buffers,
            frames_replaced: 0,
            buffer_allocations: 0,
        }
    }

    pub fn latest(&self) -> Option<FrameHandle<P, M>> {
        self.latest.clone()
    }

    pub fn checkout_buffer(&mut self, byte_len: usize) -> Vec<u8> {
        let mut buffer = self.spare_buffers.pop().unwrap_or_else(|| {
            self.buffer_allocations = self.buffer_allocations.saturating_add(1);
            Vec::with_capacity(byte_len)
        });
        if buffer.capacity() < byte_len {
            self.buffer_allocations = self.buffer_allocations.saturating_add(1);
            buffer = Vec::with_capacity(byte_len);
        }
        buffer.resize(byte_len, 0);
        buffer
    }

    pub fn checkout_spare_buffer(&mut self, byte_len: usize) -> Option<Vec<u8>> {
        let mut buffer = self.spare_buffers.pop()?;
        if buffer.capacity() < byte_len {
            return None;
        }
        buffer.resize(byte_len, 0);
        Some(buffer)
    }

    pub fn record_buffer_allocation(&mut self) {
        self.buffer_allocations = self.buffer_allocations.saturating_add(1);
    }

    pub fn publish(
        &mut self,
        sequence: u64,
        width: u32,
        height: u32,
        pixel_format: P,
        captured_at: Instant,
        bytes: Vec<u8>,
    ) -> FrameHandle<P, M>
    where
        M: Default,
    {
        self.publish_with_metadata(
            sequence,
            width,
            height,
            pixel_format,
            M::default(),
            captured_at,
            bytes,
        )
    }

    pub fn publish_with_metadata(
        &mut self,
        sequence: u64,
        width: u32,
        height: u32,
        pixel_format: P,
        metadata: M,
        captured_at: Instant,
        bytes: Vec<u8>,
    ) -> FrameHandle<P, M> {
        if let Some(previous) = self.latest.take() {
            self.frames_replaced = self.frames_replaced.saturating_add(1);
            if let Ok(previous) = Arc::try_unwrap(previous) {
                self.retain_spare_buffer(previous.bytes);
            }
        }

        let frame = Arc::new(StoredFrame {
            sequence,
            width,
            height,
            pixel_format,
            metadata,
            bytes,
            captured_at,
        });
        self.latest = Some(Arc::clone(&frame));
        frame
    }

    pub fn stats(&self) -> FrameStoreStats {
        let latest_bytes = self
            .latest
            .as_ref()
            .map(|frame| frame.bytes.len() as u64)
            .unwrap_or(0);
        let spare_bytes = self
            .spare_buffers
            .iter()
            .map(|buffer| buffer.capacity() as u64)
            .sum::<u64>();
        FrameStoreStats {
            buffer_count: self.latest.iter().count() as u64 + self.spare_buffers.len() as u64,
            bytes_retained: latest_bytes.saturating_add(spare_bytes),
            frames_dropped: self.frames_replaced,
            buffer_allocations: self.buffer_allocations,
        }
    }

    fn retain_spare_buffer(&mut self, mut bytes: Vec<u8>) {
        if self.spare_buffers.len() >= self.max_spare_buffers {
            return;
        }
        bytes.clear();
        self.spare_buffers.push(bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum TestPixelFormat {
        Rgba,
    }

    #[test]
    fn newest_frame_wins_and_old_frames_are_dropped() {
        let mut store: FrameStore<TestPixelFormat> = FrameStore::new(1);
        let first = store.checkout_buffer(4);
        store.publish(1, 1, 1, TestPixelFormat::Rgba, Instant::now(), first);
        let second = store.checkout_buffer(4);
        store.publish(2, 1, 1, TestPixelFormat::Rgba, Instant::now(), second);

        let latest = store.latest().expect("latest frame");

        assert_eq!(latest.sequence, 2);
        assert_eq!(store.stats().frames_dropped, 1);
    }

    #[test]
    fn retained_store_memory_is_bounded_after_warmup() {
        let mut store: FrameStore<TestPixelFormat> = FrameStore::new(1);

        for sequence in 1..=10 {
            let buffer = store.checkout_buffer(1024);
            store.publish(
                sequence,
                16,
                16,
                TestPixelFormat::Rgba,
                Instant::now(),
                buffer,
            );
        }

        let stats = store.stats();
        assert_eq!(stats.buffer_count, 2);
        assert!(stats.bytes_retained <= 2048);
        assert_eq!(stats.buffer_allocations, 2);
    }

    #[test]
    fn spare_checkout_reuses_existing_buffer_without_allocation() {
        let mut store: FrameStore<TestPixelFormat> = FrameStore::new(1);
        let buffer = store.checkout_buffer(1024);
        store.publish(1, 16, 16, TestPixelFormat::Rgba, Instant::now(), buffer);
        let replacement = store.checkout_buffer(1024);
        store.publish(
            2,
            16,
            16,
            TestPixelFormat::Rgba,
            Instant::now(),
            replacement,
        );

        let buffer = store
            .checkout_spare_buffer(512)
            .expect("spare buffer available");

        assert_eq!(buffer.len(), 512);
        assert!(buffer.capacity() >= 1024);
        assert_eq!(store.stats().buffer_allocations, 2);
    }

    #[test]
    fn spare_checkout_accounts_for_undersized_spare() {
        let mut store: FrameStore<TestPixelFormat> = FrameStore::new(1);
        let buffer = store.checkout_buffer(256);
        store.publish(1, 8, 8, TestPixelFormat::Rgba, Instant::now(), buffer);
        let replacement = store.checkout_buffer(256);
        store.publish(2, 8, 8, TestPixelFormat::Rgba, Instant::now(), replacement);

        assert!(store.checkout_spare_buffer(1024).is_none());
        store.record_buffer_allocation();
        assert_eq!(store.stats().buffer_allocations, 3);
    }

    #[test]
    fn external_handles_do_not_make_store_retention_unbounded() {
        let mut store: FrameStore<TestPixelFormat> = FrameStore::new(1);
        let mut handles = Vec::new();

        for sequence in 1..=5 {
            let buffer = store.checkout_buffer(256);
            handles.push(store.publish(
                sequence,
                8,
                8,
                TestPixelFormat::Rgba,
                Instant::now(),
                buffer,
            ));
        }

        let stats = store.stats();
        assert_eq!(stats.buffer_count, 1);
        assert_eq!(stats.bytes_retained, 256);
        assert_eq!(handles.len(), 5);
    }

    #[test]
    fn publish_with_metadata_retains_latest_frame_metadata() {
        let mut store: FrameStore<TestPixelFormat, &str> = FrameStore::new(1);
        let buffer = store.checkout_buffer(4);
        store.publish_with_metadata(
            7,
            1,
            1,
            TestPixelFormat::Rgba,
            "export-handle",
            Instant::now(),
            buffer,
        );

        let latest = store.latest().expect("latest frame");

        assert_eq!(latest.sequence, 7);
        assert_eq!(latest.metadata, "export-handle");
    }
}
