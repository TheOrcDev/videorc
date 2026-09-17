use std::marker::PhantomPinned;
use std::ops::Deref;
use std::pin::Pin;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::Instant;

static NEXT_FRAME_STORAGE_IDENTITY: AtomicU64 = AtomicU64::new(1);

fn next_frame_storage_identity() -> u64 {
    NEXT_FRAME_STORAGE_IDENTITY
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |identity| {
            identity.checked_add(1)
        })
        .expect("frame storage identity space exhausted")
}

#[derive(Debug, Default)]
struct SurfaceBackingTrackerState {
    oldest: Option<NonNull<SurfaceBackingNode>>,
    newest: Option<NonNull<SurfaceBackingNode>>,
    live_count: u64,
    live_estimated_bytes: u64,
    peak_count: u64,
    peak_estimated_bytes: u64,
}

// SAFETY: The intrusive pointers are never accessed without the owning
// `SurfaceBackingTracker::state` mutex. Every pointer names a node pinned in an
// `Pin<Arc<StoredFrame>>` owned by `FrameHandle`; that node unlinks itself under
// the same mutex before the allocation can be released. Moving the mutex state
// between threads therefore cannot expose an unpinned or concurrently-mutated
// node.
unsafe impl Send for SurfaceBackingTrackerState {}

#[derive(Debug, Default)]
struct SurfaceBackingTracker {
    state: StdMutex<SurfaceBackingTrackerState>,
}

#[derive(Debug)]
struct SurfaceBackingNode {
    tracker: Arc<SurfaceBackingTracker>,
    captured_at: Instant,
    estimated_bytes: u64,
    older: AtomicPtr<SurfaceBackingNode>,
    newer: AtomicPtr<SurfaceBackingNode>,
    linked: AtomicBool,
    _pinned: PhantomPinned,
}

impl SurfaceBackingTracker {
    /// Link one already-pinned frame node at the newest edge.
    ///
    /// This is fixed-cost callback work: one short mutex section, pointer
    /// rewrites, and scalar accounting. It performs no heap allocation.
    unsafe fn register(&self, node: NonNull<SurfaceBackingNode>) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // SAFETY: The caller pins `node` for its entire linked lifetime, and
        // every existing endpoint is protected by this same mutex.
        let node_ref = unsafe { node.as_ref() };
        debug_assert!(!node_ref.linked.load(Ordering::Relaxed));
        node_ref.older.store(
            state.newest.map_or(std::ptr::null_mut(), NonNull::as_ptr),
            Ordering::Relaxed,
        );
        node_ref
            .newer
            .store(std::ptr::null_mut(), Ordering::Relaxed);
        if let Some(newest) = state.newest {
            // SAFETY: Linked endpoints remain pinned and alive until they
            // unlink while holding this mutex.
            unsafe { newest.as_ref() }
                .newer
                .store(node.as_ptr(), Ordering::Relaxed);
        } else {
            state.oldest = Some(node);
        }
        state.newest = Some(node);
        state.live_count = state.live_count.saturating_add(1);
        state.live_estimated_bytes = state
            .live_estimated_bytes
            .saturating_add(node_ref.estimated_bytes);
        state.peak_count = state.peak_count.max(state.live_count);
        state.peak_estimated_bytes = state.peak_estimated_bytes.max(state.live_estimated_bytes);
        node_ref.linked.store(true, Ordering::Release);
    }

    fn snapshot(&self) -> SurfaceBackingStats {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        SurfaceBackingStats {
            live_count: state.live_count,
            peak_count: state.peak_count,
            estimated_bytes: state.live_estimated_bytes,
            peak_estimated_bytes: state.peak_estimated_bytes,
            oldest_age_ms: state.oldest.map(|oldest| {
                // SAFETY: Snapshot holds the tracker mutex, so a linked
                // endpoint cannot unlink or be released while borrowed.
                let captured_at = unsafe { oldest.as_ref() }.captured_at;
                now.saturating_duration_since(captured_at).as_millis() as u64
            }),
        }
    }
}

impl SurfaceBackingNode {
    fn new(
        tracker: Arc<SurfaceBackingTracker>,
        captured_at: Instant,
        estimated_bytes: u64,
    ) -> Self {
        Self {
            tracker,
            captured_at,
            estimated_bytes,
            older: AtomicPtr::new(std::ptr::null_mut()),
            newer: AtomicPtr::new(std::ptr::null_mut()),
            linked: AtomicBool::new(false),
            _pinned: PhantomPinned,
        }
    }
}

impl Drop for SurfaceBackingNode {
    fn drop(&mut self) {
        if !self.linked.load(Ordering::Acquire) {
            return;
        }
        let mut state = self
            .tracker
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let older = NonNull::new(self.older.load(Ordering::Relaxed));
        let newer = NonNull::new(self.newer.load(Ordering::Relaxed));
        if let Some(older) = older {
            // SAFETY: A linked neighbour is pinned and remains alive while
            // this tracker mutex is held.
            unsafe { older.as_ref() }.newer.store(
                newer.map_or(std::ptr::null_mut(), NonNull::as_ptr),
                Ordering::Relaxed,
            );
        } else {
            state.oldest = newer;
        }
        if let Some(newer) = newer {
            // SAFETY: A linked neighbour is pinned and remains alive while
            // this tracker mutex is held.
            unsafe { newer.as_ref() }.older.store(
                older.map_or(std::ptr::null_mut(), NonNull::as_ptr),
                Ordering::Relaxed,
            );
        } else {
            state.newest = older;
        }
        state.live_count = state.live_count.saturating_sub(1);
        state.live_estimated_bytes = state
            .live_estimated_bytes
            .saturating_sub(self.estimated_bytes);
        self.linked.store(false, Ordering::Release);
    }
}

#[derive(Debug)]
pub(crate) struct FrameStorage {
    identity: u64,
    surface_backing: Option<SurfaceBackingNode>,
}

impl FrameStorage {
    fn new(
        tracker: &Arc<SurfaceBackingTracker>,
        captured_at: Instant,
        surface_backing_estimated_bytes: Option<u64>,
    ) -> Self {
        let identity = next_frame_storage_identity();
        let surface_backing = surface_backing_estimated_bytes
            .map(|bytes| SurfaceBackingNode::new(Arc::clone(tracker), captured_at, bytes));
        Self {
            identity,
            surface_backing,
        }
    }

    /// Register the embedded surface node after its `StoredFrame` has reached
    /// its final address inside an `Arc` allocation.
    ///
    /// # Safety
    ///
    /// The containing `StoredFrame` must not move until this `FrameStorage`
    /// drops. `publish_full` calls this only after `Arc::pin`, and never exposes
    /// a movable `StoredFrame`, so the intrusive pointer remains stable.
    unsafe fn register_surface_backing(&self) {
        let Some(surface_backing) = self.surface_backing.as_ref() else {
            return;
        };
        // SAFETY: The caller guarantees this embedded node is pinned by the
        // containing `FrameHandle` until its Drop implementation unlinks.
        unsafe {
            surface_backing
                .tracker
                .register(NonNull::from(surface_backing));
        }
    }

    #[cfg(test)]
    pub(crate) fn untracked() -> Self {
        Self {
            identity: next_frame_storage_identity(),
            surface_backing: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SurfaceBackingStats {
    pub live_count: u64,
    pub peak_count: u64,
    pub estimated_bytes: u64,
    pub peak_estimated_bytes: u64,
    pub oldest_age_ms: Option<u64>,
}

/// Source-owned view of surface-backed frame lifetimes. Keeping this handle
/// outside a `FrameStore` preserves both current and peak accounting while the
/// store is replaced and until the final external frame handle drops.
#[derive(Debug, Clone, Default)]
pub struct SurfaceBackingTrackerHandle {
    tracker: Arc<SurfaceBackingTracker>,
}

impl SurfaceBackingTrackerHandle {
    pub fn snapshot(&self) -> SurfaceBackingStats {
        self.tracker.snapshot()
    }
}

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

#[cfg(target_os = "windows")]
mod source_d3d11_texture {
    use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;

    /// A captured D3D11 texture retained with the logical source frame.
    ///
    /// The capture device is created with D3D11 multithread protection. Consumers
    /// may therefore retain this COM reference across the capture/compositor
    /// boundary instead of forcing the source through a BGRA byte pipe first.
    #[derive(Clone)]
    pub struct RetainedD3D11Texture {
        texture: ID3D11Texture2D,
        adapter_luid: u64,
    }

    impl RetainedD3D11Texture {
        pub fn new(texture: ID3D11Texture2D, adapter_luid: u64) -> Self {
            Self {
                texture,
                adapter_luid,
            }
        }

        /// The direct encoder/GPU compositor consumer lands in the next issue
        /// slice; retaining this accessor now makes the frame handoff contract
        /// explicit without forcing a second wrapper change.
        #[allow(dead_code)]
        pub fn texture(&self) -> &ID3D11Texture2D {
            &self.texture
        }

        #[allow(dead_code)]
        pub const fn adapter_luid(&self) -> u64 {
            self.adapter_luid
        }
    }

    impl std::fmt::Debug for RetainedD3D11Texture {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("RetainedD3D11Texture")
                .field("adapter_luid", &format_args!("{:016x}", self.adapter_luid))
                .finish_non_exhaustive()
        }
    }
}

#[cfg(target_os = "windows")]
pub use source_d3d11_texture::RetainedD3D11Texture;

/// Off-Windows stub so `StoredFrame` keeps one portable shape.
#[cfg(not(target_os = "windows"))]
#[derive(Debug, Clone)]
pub struct RetainedD3D11Texture;

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

#[derive(Debug)]
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
    /// Retained Windows capture texture for D3D11 composition or direct Media
    /// Foundation submission. `bytes` remains the explicit CPU fallback.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub source_d3d11_texture: Option<RetainedD3D11Texture>,
    #[doc(hidden)]
    pub(crate) recycle_pool: Option<Weak<StdMutex<FrameBufferPool>>>,
    /// Declared after the retained source handles so its final-drop accounting
    /// is released only after those backing handles themselves are released.
    #[doc(hidden)]
    pub(crate) storage: FrameStorage,
    pub captured_at: Instant,
}

impl<P, M> StoredFrame<P, M> {
    /// Process-monotonic identity of this published storage allocation.
    /// Unlike a source sequence, this never resets when a capture session restarts.
    pub fn storage_identity(&self) -> u64 {
        self.storage.identity
    }
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

/// Cloneable, pinned ownership of one stored frame.
///
/// The private `Pin<Arc<_>>` is deliberate: surface-backed frames contain an
/// intrusive tracker node, so safe consumers must never obtain an owned
/// `StoredFrame` through `Arc::try_unwrap` and move that node. The wrapper
/// exposes shared frame access and cloning while keeping the pin invariant
/// structural.
#[derive(Debug)]
pub struct FrameHandle<P, M = ()>(Pin<Arc<StoredFrame<P, M>>>);

impl<P, M> FrameHandle<P, M> {
    fn new(frame: StoredFrame<P, M>) -> Self {
        Self(Arc::pin(frame))
    }

    #[cfg(test)]
    pub fn ptr_eq(left: &Self, right: &Self) -> bool {
        std::ptr::eq(&**left, &**right)
    }

    pub fn as_ptr(&self) -> *const StoredFrame<P, M> {
        std::ptr::from_ref(&**self)
    }

    #[cfg(test)]
    pub(crate) fn pin_for_test(frame: StoredFrame<P, M>) -> Self {
        Self::new(frame)
    }

    #[cfg(test)]
    pub(crate) fn strong_count(&self) -> usize {
        let cloned = self.0.clone();
        // SAFETY: This temporary Arc is used only to read its count and is
        // dropped without moving the pinned `StoredFrame` out of the allocation.
        let arc = unsafe { Pin::into_inner_unchecked(cloned) };
        Arc::strong_count(&arc).saturating_sub(1)
    }
}

impl<P, M> Clone for FrameHandle<P, M> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<P, M> Deref for FrameHandle<P, M> {
    type Target = StoredFrame<P, M>;

    fn deref(&self) -> &Self::Target {
        self.0.as_ref().get_ref()
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FrameStoreStats {
    /// CPU buffers retained directly by the store (the latest frame plus its
    /// spare-buffer pool). Frames kept alive only by external handles are not
    /// included, and zero-copy surface backing is reported separately below.
    pub buffer_count: u64,
    /// Allocated CPU `Vec` capacity retained directly by the latest frame and
    /// spare-buffer pool. This excludes external frame handles and all
    /// IOSurface/CVPixelBuffer storage.
    pub bytes_retained: u64,
    pub frames_dropped: u64,
    pub buffer_allocations: u64,
    /// Distinct IOSurface/CVPixelBuffer-backed frame storages whose final
    /// `Arc<StoredFrame>` (including external handles) has not dropped.
    pub surface_backing_live_count: u64,
    pub surface_backing_peak_count: u64,
    /// Estimated BGRA backing bytes (`width * height * 4`), counted once even
    /// when the frame carries both IOSurface and CVPixelBuffer handles.
    pub surface_backing_estimated_bytes: u64,
    pub surface_backing_peak_estimated_bytes: u64,
    pub surface_backing_oldest_age_ms: Option<u64>,
}

impl FrameStoreStats {
    /// Build the source-level view used while a capture store is between
    /// sessions. CPU-buffer fields are empty, while surface backing retained
    /// by external frame handles remains visible through the shared tracker.
    pub fn from_surface_backing(surface_backing: SurfaceBackingStats) -> Self {
        Self {
            surface_backing_live_count: surface_backing.live_count,
            surface_backing_peak_count: surface_backing.peak_count,
            surface_backing_estimated_bytes: surface_backing.estimated_bytes,
            surface_backing_peak_estimated_bytes: surface_backing.peak_estimated_bytes,
            surface_backing_oldest_age_ms: surface_backing.oldest_age_ms,
            ..Self::default()
        }
    }
}

#[derive(Debug)]
pub struct FrameStore<P, M = ()> {
    latest: Option<FrameHandle<P, M>>,
    buffer_pool: Arc<StdMutex<FrameBufferPool>>,
    surface_backing_tracker: SurfaceBackingTrackerHandle,
    frames_replaced: u64,
}

impl<P, M> Default for FrameStore<P, M> {
    fn default() -> Self {
        Self::new(1)
    }
}

impl<P, M> FrameStore<P, M> {
    pub fn new(max_spare_buffers: usize) -> Self {
        Self::new_with_surface_backing_tracker(
            max_spare_buffers,
            SurfaceBackingTrackerHandle::default(),
        )
    }

    pub fn new_with_surface_backing_tracker(
        max_spare_buffers: usize,
        surface_backing_tracker: SurfaceBackingTrackerHandle,
    ) -> Self {
        Self {
            latest: None,
            buffer_pool: Arc::new(StdMutex::new(FrameBufferPool {
                spare_buffers: Vec::new(),
                max_spare_buffers,
                buffer_allocations: 0,
            })),
            surface_backing_tracker,
            frames_replaced: 0,
        }
    }

    #[cfg(test)]
    pub fn surface_backing_tracker(&self) -> SurfaceBackingTrackerHandle {
        self.surface_backing_tracker.clone()
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
        let surface_backing_estimated_bytes =
            (source_iosurface.is_some() || source_pixel_buffer.is_some()).then(|| {
                u64::from(width)
                    .saturating_mul(u64::from(height))
                    .saturating_mul(4)
            });
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
            None,
            surface_backing_estimated_bytes,
        )
    }

    #[cfg(test)]
    fn publish_test_surface_backed(
        &mut self,
        sequence: u64,
        width: u32,
        height: u32,
        pixel_format: P,
        captured_at: Instant,
        surface_backing_estimated_bytes: u64,
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
            Vec::new(),
            None,
            None,
            None,
            Some(surface_backing_estimated_bytes),
        )
    }

    #[cfg(target_os = "windows")]
    #[allow(clippy::too_many_arguments)]
    pub fn publish_with_d3d11_texture(
        &mut self,
        sequence: u64,
        width: u32,
        height: u32,
        pixel_format: P,
        captured_at: Instant,
        bytes: Vec<u8>,
        source_d3d11_texture: RetainedD3D11Texture,
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
            None,
            None,
            Some(source_d3d11_texture),
            None,
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
        source_d3d11_texture: Option<RetainedD3D11Texture>,
        surface_backing_estimated_bytes: Option<u64>,
    ) -> FrameHandle<P, M> {
        if self.latest.take().is_some() {
            self.frames_replaced = self.frames_replaced.saturating_add(1);
        }

        let storage = FrameStorage::new(
            &self.surface_backing_tracker.tracker,
            captured_at,
            surface_backing_estimated_bytes,
        );
        let frame = FrameHandle::new(StoredFrame {
            sequence,
            width,
            height,
            pixel_format,
            metadata,
            bytes,
            source_iosurface,
            source_pixel_buffer,
            source_d3d11_texture,
            recycle_pool: Some(Arc::downgrade(&self.buffer_pool)),
            storage,
            captured_at,
        });
        // SAFETY: `frame` now owns the storage at a stable heap address, and
        // callers can only retain it through the structurally pinned wrapper.
        unsafe {
            frame.storage.register_surface_backing();
        }
        self.latest = Some(frame.clone());
        frame
    }

    pub fn stats(&self) -> FrameStoreStats {
        let latest_bytes = self
            .latest
            .as_ref()
            .map(|frame| frame.bytes.capacity() as u64)
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
        let surface_backing = self.surface_backing_tracker.snapshot();
        FrameStoreStats {
            buffer_count: self.latest.iter().count() as u64 + pool.spare_buffers.len() as u64,
            bytes_retained: latest_bytes.saturating_add(spare_bytes),
            frames_dropped: self.frames_replaced,
            buffer_allocations: pool.buffer_allocations,
            surface_backing_live_count: surface_backing.live_count,
            surface_backing_peak_count: surface_backing.peak_count,
            surface_backing_estimated_bytes: surface_backing.estimated_bytes,
            surface_backing_peak_estimated_bytes: surface_backing.peak_estimated_bytes,
            surface_backing_oldest_age_ms: surface_backing.oldest_age_ms,
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
    fn surface_backing_lifecycle_tracks_external_handles_until_final_drop() {
        let mut store: FrameStore<TestPixelFormat> = FrameStore::new(1);
        let captured_at = Instant::now() - std::time::Duration::from_secs(2);
        let retained =
            store.publish_test_surface_backed(1, 8, 8, TestPixelFormat::Rgba, captured_at, 256);
        let current =
            store.publish_test_surface_backed(2, 8, 8, TestPixelFormat::Rgba, Instant::now(), 256);
        drop(current);

        let under_overlap = store.stats();
        assert_eq!(under_overlap.surface_backing_live_count, 2);
        assert_eq!(under_overlap.surface_backing_peak_count, 2);
        assert_eq!(under_overlap.surface_backing_estimated_bytes, 512);
        assert_eq!(under_overlap.surface_backing_peak_estimated_bytes, 512);
        assert!(under_overlap.surface_backing_oldest_age_ms >= Some(2_000));
        assert_ne!(
            retained.storage_identity(),
            store.latest().unwrap().storage_identity()
        );

        let replacement =
            store.publish(3, 8, 8, TestPixelFormat::Rgba, Instant::now(), vec![0; 256]);
        drop(replacement);
        assert_eq!(store.stats().surface_backing_live_count, 1);

        drop(retained);
        let released = store.stats();
        assert_eq!(released.surface_backing_live_count, 0);
        assert_eq!(released.surface_backing_estimated_bytes, 0);
        assert_eq!(released.surface_backing_oldest_age_ms, None);
        assert_eq!(released.surface_backing_peak_count, 2);
    }

    #[test]
    fn surface_backing_lifecycle_unlinks_middle_handles_in_constant_time_order() {
        let mut store: FrameStore<TestPixelFormat> = FrameStore::new(1);
        let oldest = store.publish_test_surface_backed(
            1,
            8,
            8,
            TestPixelFormat::Rgba,
            Instant::now() - std::time::Duration::from_secs(3),
            256,
        );
        let middle = store.publish_test_surface_backed(
            2,
            8,
            8,
            TestPixelFormat::Rgba,
            Instant::now() - std::time::Duration::from_secs(2),
            256,
        );
        let newest = store.publish_test_surface_backed(
            3,
            8,
            8,
            TestPixelFormat::Rgba,
            Instant::now() - std::time::Duration::from_secs(1),
            256,
        );
        drop(newest);

        drop(middle);
        let without_middle = store.stats();
        assert_eq!(without_middle.surface_backing_live_count, 2);
        assert_eq!(without_middle.surface_backing_estimated_bytes, 512);
        assert!(without_middle.surface_backing_oldest_age_ms >= Some(3_000));

        drop(oldest);
        let newest_only = store.stats();
        assert_eq!(newest_only.surface_backing_live_count, 1);
        assert_eq!(newest_only.surface_backing_estimated_bytes, 256);
        assert!(newest_only.surface_backing_oldest_age_ms >= Some(1_000));
        assert!(
            newest_only.surface_backing_oldest_age_ms
                < without_middle.surface_backing_oldest_age_ms
        );

        let replacement =
            store.publish(4, 8, 8, TestPixelFormat::Rgba, Instant::now(), vec![0; 256]);
        drop(replacement);
        assert_eq!(store.stats().surface_backing_live_count, 0);
        assert_eq!(store.stats().surface_backing_peak_count, 3);
    }

    #[test]
    fn surface_backing_lifecycle_stays_observable_across_store_replacement() {
        let mut store: FrameStore<TestPixelFormat> = FrameStore::new(1);
        let tracker = store.surface_backing_tracker();
        let retained =
            store.publish_test_surface_backed(1, 8, 8, TestPixelFormat::Rgba, Instant::now(), 256);

        drop(store);
        assert_eq!(tracker.snapshot().live_count, 1);
        assert_eq!(tracker.snapshot().estimated_bytes, 256);

        let replacement: FrameStore<TestPixelFormat> =
            FrameStore::new_with_surface_backing_tracker(1, tracker.clone());
        assert_eq!(replacement.stats().surface_backing_live_count, 1);
        assert_eq!(replacement.stats().surface_backing_estimated_bytes, 256);

        drop(retained);
        assert_eq!(tracker.snapshot().live_count, 0);
        assert_eq!(replacement.stats().surface_backing_live_count, 0);
        assert_eq!(replacement.stats().surface_backing_estimated_bytes, 0);
        assert_eq!(replacement.stats().surface_backing_peak_count, 1);
    }

    #[test]
    fn storage_identity_is_process_monotonic_across_stores_and_sequence_resets() {
        let mut camera_store: FrameStore<TestPixelFormat> = FrameStore::new(1);
        let mut screen_store: FrameStore<TestPixelFormat> = FrameStore::new(1);

        let camera_before_restart =
            camera_store.publish(99, 1, 1, TestPixelFormat::Rgba, Instant::now(), vec![0; 4]);
        let screen =
            screen_store.publish(1, 1, 1, TestPixelFormat::Rgba, Instant::now(), vec![0; 4]);
        let camera_after_restart =
            camera_store.publish(1, 1, 1, TestPixelFormat::Rgba, Instant::now(), vec![0; 4]);

        assert!(screen.storage_identity() > camera_before_restart.storage_identity());
        assert!(camera_after_restart.storage_identity() > screen.storage_identity());
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
