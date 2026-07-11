use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::Instant;

#[cfg(target_os = "macos")]
mod source_iosurface {
    use objc2_core_foundation::CFRetained;
    use objc2_io_surface::IOSurfaceRef;

    /// A retained capture-source IOSurface, kept alive so the GPU compositor can import it
    /// zero-copy (no BGRA byte re-upload). Mirrors the retained-target wrapper in
    /// `metal_compositor.rs`: the capture and compositor run in the same process, so the surface
    /// reference is handed straight to Metal without a global IOSurface lookup.
    #[derive(Clone)]
    pub struct RetainedIoSurface(CFRetained<IOSurfaceRef>);

    impl RetainedIoSurface {
        pub fn new(surface: CFRetained<IOSurfaceRef>) -> Self {
            Self(surface)
        }

        pub fn surface(&self) -> &IOSurfaceRef {
            self.0.as_ref()
        }
    }

    impl std::fmt::Debug for RetainedIoSurface {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("RetainedIoSurface(..)")
        }
    }

    // SAFETY: IOSurface is a kernel-backed object that is safe to retain/release and reference
    // across threads; the wrapper only exposes shared references for GPU texture import. This
    // matches the existing `unsafe impl Send` retained-CoreVideo wrappers in this crate.
    unsafe impl Send for RetainedIoSurface {}
    unsafe impl Sync for RetainedIoSurface {}
}

#[cfg(target_os = "macos")]
pub use source_iosurface::RetainedIoSurface;

#[cfg(target_os = "macos")]
mod source_pixel_buffer {
    use objc2_core_foundation::CFRetained;
    use objc2_core_video::CVPixelBuffer;

    /// A retained capture-source CVPixelBuffer, kept alive so the GPU compositor can import it
    /// through CVMetalTextureCache before falling back to the copied BGRA bytes.
    #[derive(Clone)]
    pub struct RetainedPixelBuffer(CFRetained<CVPixelBuffer>);

    impl RetainedPixelBuffer {
        pub fn new(pixel_buffer: CFRetained<CVPixelBuffer>) -> Self {
            Self(pixel_buffer)
        }

        pub fn pixel_buffer(&self) -> &CVPixelBuffer {
            self.0.as_ref()
        }
    }

    impl std::fmt::Debug for RetainedPixelBuffer {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("RetainedPixelBuffer(..)")
        }
    }

    // SAFETY: CoreVideo pixel buffers are retained reference-counted objects whose backing
    // storage is stable while retained. The wrapper only exposes shared references for GPU import.
    unsafe impl Send for RetainedPixelBuffer {}
    unsafe impl Sync for RetainedPixelBuffer {}
}

#[cfg(target_os = "macos")]
pub use source_pixel_buffer::RetainedPixelBuffer;

/// Off-macOS stub so `StoredFrame` stays portable; never constructed.
#[cfg(not(target_os = "macos"))]
#[derive(Debug, Clone)]
pub struct RetainedIoSurface;

#[cfg(not(target_os = "macos"))]
#[derive(Debug, Clone)]
pub struct RetainedPixelBuffer;

#[derive(Debug)]
pub(crate) struct FrameBufferPool {
    spare_buffers: Vec<Vec<u8>>,
    max_spare_buffers: usize,
    buffer_allocations: u64,
}

impl FrameBufferPool {
    fn checkout(&mut self, byte_len: usize, zero_fill: bool) -> Vec<u8> {
        let mut buffer = self.spare_buffers.pop().unwrap_or_else(|| {
            self.buffer_allocations = self.buffer_allocations.saturating_add(1);
            Vec::with_capacity(byte_len)
        });
        if buffer.capacity() < byte_len {
            self.buffer_allocations = self.buffer_allocations.saturating_add(1);
            buffer = Vec::with_capacity(byte_len);
        }
        buffer.resize(byte_len, 0);
        if zero_fill {
            buffer.fill(0);
        }
        buffer
    }

    fn retain(&mut self, bytes: Vec<u8>) {
        if self.spare_buffers.len() < self.max_spare_buffers {
            self.spare_buffers.push(bytes);
        }
    }
}

#[derive(Debug, Clone)]
pub struct StoredFrame<P, M = ()> {
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub pixel_format: P,
    #[allow(dead_code)]
    pub metadata: M,
    pub bytes: Vec<u8>,
    /// Zero-copy capture-source surface, when retained (see `RetainedIoSurface`). `None` keeps
    /// the existing BGRA `bytes` upload path.
    pub source_iosurface: Option<RetainedIoSurface>,
    /// Retained source CVPixelBuffer for CoreVideo-to-Metal import where the source path supports
    /// it. `bytes` remains the fallback and artifact path.
    pub source_pixel_buffer: Option<RetainedPixelBuffer>,
    #[doc(hidden)]
    pub(crate) recycle_pool: Option<Weak<StdMutex<FrameBufferPool>>>,
    pub captured_at: Instant,
}

impl<P, M> Drop for StoredFrame<P, M> {
    fn drop(&mut self) {
        let Some(pool) = self.recycle_pool.as_ref().and_then(Weak::upgrade) else {
            return;
        };
        let bytes = std::mem::take(&mut self.bytes);
        if bytes.capacity() == 0 {
            return;
        }
        pool.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retain(bytes);
    }
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
    buffer_pool: Arc<StdMutex<FrameBufferPool>>,
    frames_replaced: u64,
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
            buffer_pool: Arc::new(StdMutex::new(FrameBufferPool {
                spare_buffers: Vec::new(),
                max_spare_buffers,
                buffer_allocations: 0,
            })),
            frames_replaced: 0,
        }
    }

    pub fn latest(&self) -> Option<FrameHandle<P, M>> {
        self.latest.clone()
    }

    pub fn checkout_buffer(&mut self, byte_len: usize) -> Vec<u8> {
        self.buffer_pool
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .checkout(byte_len, true)
    }

    /// Checkout a buffer for an operation such as `read_exact` that overwrites
    /// every byte. Reused buffers keep their initialized length without paying
    /// for a redundant full-frame zero fill.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn checkout_overwrite_buffer(&mut self, byte_len: usize) -> Vec<u8> {
        self.buffer_pool
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .checkout(byte_len, false)
    }

    pub fn checkout_spare_buffer(&mut self, byte_len: usize) -> Option<Vec<u8>> {
        let mut pool = self
            .buffer_pool
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut buffer = pool.spare_buffers.pop()?;
        if buffer.capacity() < byte_len {
            return None;
        }
        buffer.resize(byte_len, 0);
        buffer.fill(0);
        Some(buffer)
    }

    pub fn record_buffer_allocation(&mut self) {
        let mut pool = self
            .buffer_pool
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pool.buffer_allocations = pool.buffer_allocations.saturating_add(1);
    }

    #[cfg(test)]
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

    #[allow(clippy::too_many_arguments)]
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
        self.publish_full(
            sequence,
            width,
            height,
            pixel_format,
            metadata,
            captured_at,
            bytes,
            None,
            None,
        )
    }

    /// Publish a frame that retains source handles for zero-copy GPU import where supported.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_with_source_handles(
        &mut self,
        sequence: u64,
        width: u32,
        height: u32,
        pixel_format: P,
        captured_at: Instant,
        bytes: Vec<u8>,
        source_iosurface: Option<RetainedIoSurface>,
        source_pixel_buffer: Option<RetainedPixelBuffer>,
    ) -> FrameHandle<P, M>
    where
        M: Default,
    {
        self.publish_full(
            sequence,
            width,
            height,
            pixel_format,
            M::default(),
            captured_at,
            bytes,
            source_iosurface,
            source_pixel_buffer,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn publish_full(
        &mut self,
        sequence: u64,
        width: u32,
        height: u32,
        pixel_format: P,
        metadata: M,
        captured_at: Instant,
        bytes: Vec<u8>,
        source_iosurface: Option<RetainedIoSurface>,
        source_pixel_buffer: Option<RetainedPixelBuffer>,
    ) -> FrameHandle<P, M> {
        if self.latest.take().is_some() {
            self.frames_replaced = self.frames_replaced.saturating_add(1);
        }

        let frame = Arc::new(StoredFrame {
            sequence,
            width,
            height,
            pixel_format,
            metadata,
            bytes,
            source_iosurface,
            source_pixel_buffer,
            recycle_pool: Some(Arc::downgrade(&self.buffer_pool)),
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
        let pool = self
            .buffer_pool
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let spare_bytes = pool
            .spare_buffers
            .iter()
            .map(|buffer| buffer.capacity() as u64)
            .sum::<u64>();
        FrameStoreStats {
            buffer_count: self.latest.iter().count() as u64 + pool.spare_buffers.len() as u64,
            bytes_retained: latest_bytes.saturating_add(spare_bytes),
            frames_dropped: self.frames_replaced,
            buffer_allocations: pool.buffer_allocations,
        }
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
    fn released_external_handles_return_buffers_to_the_store_pool() {
        let mut store: FrameStore<TestPixelFormat> = FrameStore::new(2);
        let first = store.checkout_buffer(1024);
        let retained = store.publish(1, 16, 16, TestPixelFormat::Rgba, Instant::now(), first);
        let second = store.checkout_buffer(1024);
        store.publish(2, 16, 16, TestPixelFormat::Rgba, Instant::now(), second);

        assert_eq!(store.stats().buffer_allocations, 2);
        drop(retained);

        let recycled = store.checkout_buffer(1024);
        assert_eq!(recycled.len(), 1024);
        assert_eq!(store.stats().buffer_allocations, 2);
    }

    #[test]
    fn overlapping_consumers_stabilize_buffer_allocations_after_warmup() {
        let mut store: FrameStore<TestPixelFormat> = FrameStore::new(2);
        let mut buffer = store.checkout_buffer(1024);
        let mut retained_consumer = None;

        for sequence in 1..=120 {
            let next_consumer = store.publish(
                sequence,
                16,
                16,
                TestPixelFormat::Rgba,
                Instant::now(),
                buffer,
            );
            buffer = store.checkout_buffer(1024);
            // Keep frame N alive through publication of frame N+1, matching a
            // compositor/PNG consumer that overlaps the capture callback.
            drop(retained_consumer.take());
            retained_consumer = Some(next_consumer);
        }
        drop(retained_consumer);

        assert!(store.stats().buffer_allocations <= 3);
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
