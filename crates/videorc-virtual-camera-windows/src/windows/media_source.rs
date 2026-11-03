//! The COM objects the Frame Server drives (plan 214 C1), after Microsoft's
//! `Samples/VirtualCamera` `SimpleMediaSource`:
//!
//! - [`VideorcCameraClassFactory`]: what `DllGetClassObject` hands out for
//!   the CLSID; makes one [`VideorcCameraActivate`] per `CreateInstance`.
//! - [`VideorcCameraActivate`] (`IMFActivate`, so `IMFAttributes` too):
//!   `MFCreateVirtualCamera`'s source id names this class; the Frame Server
//!   activates it to get the media source and may hand it attributes first.
//! - [`VideorcCameraSource`] (`IMFMediaSourceEx`, `IMFGetService`,
//!   `IKsControl`, `IMFSampleAllocatorControl`): one live source with one
//!   stream, a presentation descriptor and an event queue.
//! - [`VideorcCameraStream`] (`IMFMediaStream2`): NV12 1920×1080 at 30 fps;
//!   every `RequestSample` fills a sample from the [`FrameSource`].
//!
//! Lifetimes follow the sample: the source holds its stream, the stream
//! holds its parent source, and `Shutdown` breaks the cycle and the queues.
//! Each object counts itself in [`LIVE_OBJECTS`] for `DllCanUnloadNow`.
//! Locks: a stream never calls into its source while holding its own lock,
//! and the source calls into the stream only through the stream's public
//! methods, so the order is always source then stream. `GetEvent` clones the
//! queue out and waits without any lock, as the sample does.
//!
//! The `_Impl` trait methods are safe `fn`s over raw pointers because that
//! is how `windows-rs` declares the COM ABI; the pointers are COM's own,
//! checked for null here and valid for the call by the COM contract.
#![allow(clippy::not_unsafe_ptr_arg_deref)]

use std::ffi::c_void;
use std::ptr::null_mut;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};

use windows::Win32::Foundation::{
    CLASS_E_NOAGGREGATION, E_INVALIDARG, E_NOTIMPL, E_POINTER, E_UNEXPECTED, ERROR_SET_NOT_FOUND,
    S_OK,
};
use windows::Win32::Media::KernelStreaming::{
    IKsControl, IKsControl_Impl, KSCAMERAPROFILE_Legacy, KSIDENTIFIER, PINNAME_VIDEO_CAPTURE,
};
use windows::Win32::Media::MediaFoundation::{
    IMF2DBuffer2, IMFActivate, IMFActivate_Impl, IMFAsyncCallback, IMFAsyncResult, IMFAttributes,
    IMFAttributes_Impl, IMFGetService, IMFGetService_Impl, IMFMediaEvent,
    IMFMediaEventGenerator_Impl, IMFMediaEventQueue, IMFMediaSource, IMFMediaSource_Impl,
    IMFMediaSourceEx, IMFMediaSourceEx_Impl, IMFMediaStream_Impl, IMFMediaStream2,
    IMFMediaStream2_Impl, IMFMediaType, IMFPresentationDescriptor, IMFSampleAllocatorControl,
    IMFSampleAllocatorControl_Impl, IMFStreamDescriptor, IMFVideoSampleAllocator,
    MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS, MEMediaSample, MENewStream, MESourceStarted,
    MESourceStopped, MEStreamStarted, MEStreamStopped, MEUpdatedStream, MF_ATTRIBUTE_TYPE,
    MF_ATTRIBUTES_MATCH_ALL_ITEMS, MF_ATTRIBUTES_MATCH_TYPE, MF_DEVICEMFT_SENSORPROFILE_COLLECTION,
    MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES, MF_DEVICESTREAM_FRAMESERVER_SHARED,
    MF_DEVICESTREAM_STREAM_CATEGORY, MF_DEVICESTREAM_STREAM_ID, MF_E_ALREADY_INITIALIZED,
    MF_E_INVALID_STATE_TRANSITION, MF_E_INVALIDREQUEST, MF_E_NOT_FOUND, MF_E_SHUTDOWN,
    MF_E_UNSUPPORTED_SERVICE, MF_E_UNSUPPORTED_TIME_FORMAT, MF_MT_ALL_SAMPLES_INDEPENDENT,
    MF_MT_AVG_BITRATE, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE,
    MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SAMPLE_SIZE,
    MF_MT_SUBTYPE, MF_MT_TRANSFER_FUNCTION, MF_MT_VIDEO_NOMINAL_RANGE, MF_MT_VIDEO_PRIMARIES,
    MF_MT_YUV_MATRIX, MF_STREAM_STATE, MF_STREAM_STATE_PAUSED, MF_STREAM_STATE_RUNNING,
    MF_STREAM_STATE_STOPPED, MF2DBuffer_LockFlags_Write, MFCreateAttributes, MFCreateEventQueue,
    MFCreateMediaType, MFCreatePresentationDescriptor, MFCreateSensorProfile,
    MFCreateSensorProfileCollection, MFCreateStreamDescriptor, MFCreateVideoSampleAllocatorEx,
    MFFrameSourceTypes_Color, MFGetSystemTime, MFMEDIASOURCE_IS_LIVE, MFMediaType_Video,
    MFNominalRange_16_235, MFSampleAllocatorUsage, MFSampleAllocatorUsage_UsesProvidedAllocator,
    MFSampleExtension_Token, MFVideoFormat_NV12, MFVideoInterlace_Progressive,
    MFVideoPrimaries_BT709, MFVideoTransFunc_709, MFVideoTransferMatrix_BT709,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{IClassFactory, IClassFactory_Impl};
use windows::core::{
    BOOL, ComObject, Error, GUID, HRESULT, IUnknown, Interface, PCWSTR, PWSTR, Ref, Result,
    implement, w,
};

use crate::ring::RingLayout;
use crate::{CAMERA_FPS, CAMERA_HEIGHT, CAMERA_WIDTH, FRAME_DURATION_100NS};

use super::frame_source::FrameSource;

/// How many of this module's objects are alive: half of `DllCanUnloadNow`'s
/// answer.
pub static LIVE_OBJECTS: AtomicUsize = AtomicUsize::new(0);
/// `IClassFactory::LockServer` holds: the other half.
pub static SERVER_LOCKS: AtomicUsize = AtomicUsize::new(0);

/// The one stream's identifier.
const STREAM_ID: u32 = 0;
/// Samples the allocator keeps in flight.
const ALLOCATOR_SAMPLES: u32 = 10;

fn hr(code: HRESULT) -> Error {
    Error::from_hresult(code)
}

fn win32_error(code: u32) -> Error {
    Error::from_hresult(HRESULT::from_win32(code))
}

fn lock_recovering<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `MFSetAttributeSize` / `MFSetAttributeRatio`: two u32 packed in a u64.
const fn packed(high: u32, low: u32) -> u64 {
    ((high as u64) << 32) | low as u64
}

struct LiveObject;

impl LiveObject {
    fn new() -> Self {
        LIVE_OBJECTS.fetch_add(1, Ordering::AcqRel);
        Self
    }
}

impl Drop for LiveObject {
    fn drop(&mut self) {
        LIVE_OBJECTS.fetch_sub(1, Ordering::AcqRel);
    }
}

// ---------------------------------------------------------------------------
// Class factory
// ---------------------------------------------------------------------------

#[implement(IClassFactory)]
pub struct VideorcCameraClassFactory {
    _live: LiveObject,
}

impl VideorcCameraClassFactory {
    pub fn new() -> Self {
        Self {
            _live: LiveObject::new(),
        }
    }
}

impl Default for VideorcCameraClassFactory {
    fn default() -> Self {
        Self::new()
    }
}

impl IClassFactory_Impl for VideorcCameraClassFactory_Impl {
    fn CreateInstance(
        &self,
        punkouter: Ref<'_, IUnknown>,
        riid: *const GUID,
        ppvobject: *mut *mut c_void,
    ) -> Result<()> {
        if ppvobject.is_null() || riid.is_null() {
            return Err(hr(E_POINTER));
        }
        // SAFETY: checked non-null; the caller owns the out pointer.
        unsafe { *ppvobject = null_mut() };
        if !punkouter.is_null() {
            return Err(hr(CLASS_E_NOAGGREGATION));
        }
        let activate: IMFActivate = VideorcCameraActivate::new()?.into();
        // SAFETY: `riid` and `ppvobject` are valid (checked above).
        unsafe { activate.query(riid, ppvobject) }.ok()
    }

    fn LockServer(&self, flock: BOOL) -> Result<()> {
        if flock.as_bool() {
            SERVER_LOCKS.fetch_add(1, Ordering::AcqRel);
        } else {
            // An unbalanced unlock is the caller's bug; never wrap below zero.
            let _ = SERVER_LOCKS.fetch_update(Ordering::AcqRel, Ordering::Acquire, |locks| {
                Some(locks.saturating_sub(1))
            });
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------

/// `IMFActivate` for the CLSID. Attributes the Frame Server sets before
/// activation are kept in `attributes` and copied into the source.
///
/// Lifetime as Microsoft's sample (`VirtualCameraMediaSourceActivate.cpp`):
/// every `ActivateObject` makes a new source and the activate keeps the
/// newest; `ShutdownObject` is a no-op (the Frame Server shuts the source
/// down itself); `DetachObject` lets the activate's reference go. A source
/// is never handed out twice, so a shut-down one is never handed back.
#[implement(IMFActivate)]
pub struct VideorcCameraActivate {
    attributes: IMFAttributes,
    source: Mutex<Option<ComObject<VideorcCameraSource>>>,
    _live: LiveObject,
}

impl VideorcCameraActivate {
    pub fn new() -> Result<Self> {
        let mut attributes = None;
        // SAFETY: `attributes` receives a new store.
        unsafe { MFCreateAttributes(&mut attributes, 1)? };
        Ok(Self {
            attributes: attributes.ok_or_else(|| hr(E_UNEXPECTED))?,
            source: Mutex::new(None),
            _live: LiveObject::new(),
        })
    }

    fn vtable(&self) -> &windows::Win32::Media::MediaFoundation::IMFAttributes_Vtbl {
        self.attributes.vtable()
    }

    fn raw(&self) -> *mut c_void {
        self.attributes.as_raw()
    }
}

impl IMFActivate_Impl for VideorcCameraActivate_Impl {
    fn ActivateObject(&self, riid: *const GUID, ppv: *mut *mut c_void) -> Result<()> {
        if ppv.is_null() || riid.is_null() {
            return Err(hr(E_POINTER));
        }
        // SAFETY: checked non-null.
        unsafe { *ppv = null_mut() };
        let source = VideorcCameraSource::create(&self.attributes)?;
        let unknown: IUnknown = source.cast()?;
        // SAFETY: valid pointers (checked above).
        unsafe { unknown.query(riid, ppv) }.ok()?;
        *lock_recovering(&self.source) = Some(source);
        Ok(())
    }

    fn ShutdownObject(&self) -> Result<()> {
        Ok(())
    }

    fn DetachObject(&self) -> Result<()> {
        *lock_recovering(&self.source) = None;
        Ok(())
    }
}

// The Frame Server talks to the activate through IMFAttributes before it
// activates; every call forwards to the inner store. Methods whose Rust
// wrapper reshapes the arguments go through the vtable so the raw contract
// (buffer pointers, lengths, out pointers) is passed on untouched.
impl IMFAttributes_Impl for VideorcCameraActivate_Impl {
    fn GetItem(&self, guidkey: *const GUID, pvalue: *mut PROPVARIANT) -> Result<()> {
        // SAFETY: forwarding the caller's pointers to the real store.
        unsafe { (self.vtable().GetItem)(self.raw(), guidkey, pvalue) }.ok()
    }

    fn GetItemType(&self, guidkey: *const GUID) -> Result<MF_ATTRIBUTE_TYPE> {
        // SAFETY: as above.
        unsafe { self.attributes.GetItemType(guidkey) }
    }

    fn CompareItem(&self, guidkey: *const GUID, value: *const PROPVARIANT) -> Result<BOOL> {
        // SAFETY: as above.
        unsafe { self.attributes.CompareItem(guidkey, value) }
    }

    fn Compare(
        &self,
        ptheirs: Ref<'_, IMFAttributes>,
        matchtype: MF_ATTRIBUTES_MATCH_TYPE,
    ) -> Result<BOOL> {
        // SAFETY: as above.
        unsafe { self.attributes.Compare(ptheirs.as_ref(), matchtype) }
    }

    fn GetUINT32(&self, guidkey: *const GUID) -> Result<u32> {
        // SAFETY: as above.
        unsafe { self.attributes.GetUINT32(guidkey) }
    }

    fn GetUINT64(&self, guidkey: *const GUID) -> Result<u64> {
        // SAFETY: as above.
        unsafe { self.attributes.GetUINT64(guidkey) }
    }

    fn GetDouble(&self, guidkey: *const GUID) -> Result<f64> {
        // SAFETY: as above.
        unsafe { self.attributes.GetDouble(guidkey) }
    }

    fn GetGUID(&self, guidkey: *const GUID) -> Result<GUID> {
        // SAFETY: as above.
        unsafe { self.attributes.GetGUID(guidkey) }
    }

    fn GetStringLength(&self, guidkey: *const GUID) -> Result<u32> {
        // SAFETY: as above.
        unsafe { self.attributes.GetStringLength(guidkey) }
    }

    fn GetString(
        &self,
        guidkey: *const GUID,
        pwszvalue: PWSTR,
        cchbufsize: u32,
        pcchlength: *mut u32,
    ) -> Result<()> {
        // SAFETY: as above.
        unsafe { (self.vtable().GetString)(self.raw(), guidkey, pwszvalue, cchbufsize, pcchlength) }
            .ok()
    }

    fn GetAllocatedString(
        &self,
        guidkey: *const GUID,
        ppwszvalue: *mut PWSTR,
        pcchlength: *mut u32,
    ) -> Result<()> {
        // SAFETY: as above.
        unsafe { (self.vtable().GetAllocatedString)(self.raw(), guidkey, ppwszvalue, pcchlength) }
            .ok()
    }

    fn GetBlobSize(&self, guidkey: *const GUID) -> Result<u32> {
        // SAFETY: as above.
        unsafe { self.attributes.GetBlobSize(guidkey) }
    }

    fn GetBlob(
        &self,
        guidkey: *const GUID,
        pbuf: *mut u8,
        cbbufsize: u32,
        pcbblobsize: *mut u32,
    ) -> Result<()> {
        // SAFETY: as above.
        unsafe { (self.vtable().GetBlob)(self.raw(), guidkey, pbuf, cbbufsize, pcbblobsize) }.ok()
    }

    fn GetAllocatedBlob(
        &self,
        guidkey: *const GUID,
        ppbuf: *mut *mut u8,
        pcbsize: *mut u32,
    ) -> Result<()> {
        // SAFETY: as above.
        unsafe { (self.vtable().GetAllocatedBlob)(self.raw(), guidkey, ppbuf, pcbsize) }.ok()
    }

    fn GetUnknown(
        &self,
        guidkey: *const GUID,
        riid: *const GUID,
        ppv: *mut *mut c_void,
    ) -> Result<()> {
        // SAFETY: as above.
        unsafe { (self.vtable().GetUnknown)(self.raw(), guidkey, riid, ppv) }.ok()
    }

    fn SetItem(&self, guidkey: *const GUID, value: *const PROPVARIANT) -> Result<()> {
        // SAFETY: as above.
        unsafe { self.attributes.SetItem(guidkey, value) }
    }

    fn DeleteItem(&self, guidkey: *const GUID) -> Result<()> {
        // SAFETY: as above.
        unsafe { self.attributes.DeleteItem(guidkey) }
    }

    fn DeleteAllItems(&self) -> Result<()> {
        // SAFETY: as above.
        unsafe { self.attributes.DeleteAllItems() }
    }

    fn SetUINT32(&self, guidkey: *const GUID, unvalue: u32) -> Result<()> {
        // SAFETY: as above.
        unsafe { self.attributes.SetUINT32(guidkey, unvalue) }
    }

    fn SetUINT64(&self, guidkey: *const GUID, unvalue: u64) -> Result<()> {
        // SAFETY: as above.
        unsafe { self.attributes.SetUINT64(guidkey, unvalue) }
    }

    fn SetDouble(&self, guidkey: *const GUID, fvalue: f64) -> Result<()> {
        // SAFETY: as above.
        unsafe { self.attributes.SetDouble(guidkey, fvalue) }
    }

    fn SetGUID(&self, guidkey: *const GUID, guidvalue: *const GUID) -> Result<()> {
        // SAFETY: as above.
        unsafe { self.attributes.SetGUID(guidkey, guidvalue) }
    }

    fn SetString(&self, guidkey: *const GUID, wszvalue: &PCWSTR) -> Result<()> {
        // SAFETY: as above.
        unsafe { (self.vtable().SetString)(self.raw(), guidkey, *wszvalue) }.ok()
    }

    fn SetBlob(&self, guidkey: *const GUID, pbuf: *const u8, cbbufsize: u32) -> Result<()> {
        // SAFETY: as above.
        unsafe { (self.vtable().SetBlob)(self.raw(), guidkey, pbuf, cbbufsize) }.ok()
    }

    fn SetUnknown(&self, guidkey: *const GUID, punknown: Ref<'_, IUnknown>) -> Result<()> {
        // SAFETY: as above.
        unsafe { self.attributes.SetUnknown(guidkey, punknown.as_ref()) }
    }

    fn LockStore(&self) -> Result<()> {
        // SAFETY: as above.
        unsafe { self.attributes.LockStore() }
    }

    fn UnlockStore(&self) -> Result<()> {
        // SAFETY: as above.
        unsafe { self.attributes.UnlockStore() }
    }

    fn GetCount(&self) -> Result<u32> {
        // SAFETY: as above.
        unsafe { self.attributes.GetCount() }
    }

    fn GetItemByIndex(
        &self,
        unindex: u32,
        pguidkey: *mut GUID,
        pvalue: *mut PROPVARIANT,
    ) -> Result<()> {
        // SAFETY: as above.
        unsafe { (self.vtable().GetItemByIndex)(self.raw(), unindex, pguidkey, pvalue) }.ok()
    }

    fn CopyAllItems(&self, pdest: Ref<'_, IMFAttributes>) -> Result<()> {
        // SAFETY: as above.
        unsafe { self.attributes.CopyAllItems(pdest.as_ref()) }
    }
}

// ---------------------------------------------------------------------------
// Media source
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourcePhase {
    Stopped,
    Started,
    Shutdown,
}

struct SourceState {
    phase: SourcePhase,
    event_queue: Option<IMFMediaEventQueue>,
    attributes: Option<IMFAttributes>,
    presentation: Option<IMFPresentationDescriptor>,
    stream: Option<ComObject<VideorcCameraStream>>,
}

impl SourceState {
    fn check_alive(&self) -> Result<()> {
        if self.phase == SourcePhase::Shutdown {
            return Err(hr(MF_E_SHUTDOWN));
        }
        if self.event_queue.is_none() || self.stream.is_none() {
            return Err(hr(E_UNEXPECTED));
        }
        Ok(())
    }

    fn queue(&self) -> Result<IMFMediaEventQueue> {
        self.event_queue.clone().ok_or_else(|| hr(E_UNEXPECTED))
    }

    fn stream(&self) -> Result<ComObject<VideorcCameraStream>> {
        self.stream.clone().ok_or_else(|| hr(E_UNEXPECTED))
    }

    fn presentation(&self) -> Result<IMFPresentationDescriptor> {
        self.presentation.clone().ok_or_else(|| hr(E_UNEXPECTED))
    }
}

#[implement(IMFMediaSourceEx, IMFGetService, IKsControl, IMFSampleAllocatorControl)]
pub struct VideorcCameraSource {
    state: Mutex<SourceState>,
    _live: LiveObject,
}

impl VideorcCameraSource {
    /// A ready source: attributes (the activate's plus the sensor profile),
    /// the event queue, the stream and the presentation descriptor.
    pub fn create(activate_attributes: &IMFAttributes) -> Result<ComObject<Self>> {
        let source = ComObject::new(Self {
            state: Mutex::new(SourceState {
                phase: SourcePhase::Stopped,
                event_queue: None,
                attributes: None,
                presentation: None,
                stream: None,
            }),
            _live: LiveObject::new(),
        });
        {
            let mut state = lock_recovering(&source.state);
            if state.event_queue.is_some() {
                return Err(hr(MF_E_ALREADY_INITIALIZED));
            }
            state.attributes = Some(source_attributes(activate_attributes)?);
            // SAFETY: plain creation call.
            state.event_queue = Some(unsafe { MFCreateEventQueue()? });
            let parent: IMFMediaSource = source.cast()?;
            let stream = VideorcCameraStream::create(parent, STREAM_ID)?;
            let descriptor = stream.descriptor()?;
            // SAFETY: one valid descriptor.
            state.presentation =
                Some(unsafe { MFCreatePresentationDescriptor(Some(&[Some(descriptor)]))? });
            state.stream = Some(stream);
        }
        Ok(source)
    }

    fn lock(&self) -> MutexGuard<'_, SourceState> {
        lock_recovering(&self.state)
    }
}

/// The source attributes: everything the activate carried, plus the sensor
/// profile collection (the legacy profile is mandatory so apps that know no
/// profiles still work; 30 fps is all this camera offers).
fn source_attributes(activate_attributes: &IMFAttributes) -> Result<IMFAttributes> {
    let mut attributes = None;
    // SAFETY: plain creation calls on fresh objects.
    unsafe {
        MFCreateAttributes(&mut attributes, 1)?;
        let attributes = attributes.ok_or_else(|| hr(E_UNEXPECTED))?;
        activate_attributes.CopyAllItems(&attributes)?;
        let collection = MFCreateSensorProfileCollection()?;
        let legacy = MFCreateSensorProfile(&KSCAMERAPROFILE_Legacy, 0, PCWSTR::null())?;
        legacy.AddProfileFilter(STREAM_ID, w!("((RES==;FRT<=30,1;SUT==))"))?;
        collection.AddProfile(&legacy)?;
        attributes.SetUnknown(&MF_DEVICEMFT_SENSORPROFILE_COLLECTION, &collection)?;
        Ok(attributes)
    }
}

impl IMFMediaEventGenerator_Impl for VideorcCameraSource_Impl {
    fn GetEvent(&self, dwflags: MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS) -> Result<IMFMediaEvent> {
        // GetEvent may block: take the queue out and wait without the lock.
        let queue = {
            let state = self.lock();
            state.check_alive()?;
            state.queue()?
        };
        // SAFETY: the queue is alive (cloned out above).
        unsafe { queue.GetEvent(dwflags.0) }
    }

    fn BeginGetEvent(
        &self,
        pcallback: Ref<'_, IMFAsyncCallback>,
        punkstate: Ref<'_, IUnknown>,
    ) -> Result<()> {
        let state = self.lock();
        state.check_alive()?;
        // SAFETY: the queue is alive; the refs are the caller's.
        unsafe {
            state
                .queue()?
                .BeginGetEvent(pcallback.as_ref(), punkstate.as_ref())
        }
    }

    fn EndGetEvent(&self, presult: Ref<'_, IMFAsyncResult>) -> Result<IMFMediaEvent> {
        let state = self.lock();
        state.check_alive()?;
        // SAFETY: as above.
        unsafe { state.queue()?.EndGetEvent(presult.as_ref()) }
    }

    fn QueueEvent(
        &self,
        met: u32,
        guidextendedtype: *const GUID,
        hrstatus: HRESULT,
        pvvalue: *const PROPVARIANT,
    ) -> Result<()> {
        let state = self.lock();
        state.check_alive()?;
        // SAFETY: as above.
        unsafe {
            state
                .queue()?
                .QueueEventParamVar(met, guidextendedtype, hrstatus, pvvalue)
        }
    }
}

impl IMFMediaSource_Impl for VideorcCameraSource_Impl {
    fn GetCharacteristics(&self) -> Result<u32> {
        let state = self.lock();
        state.check_alive()?;
        Ok(MFMEDIASOURCE_IS_LIVE.0 as u32)
    }

    fn CreatePresentationDescriptor(&self) -> Result<IMFPresentationDescriptor> {
        let state = self.lock();
        state.check_alive()?;
        // SAFETY: the descriptor is alive.
        unsafe { state.presentation()?.Clone() }
    }

    fn Start(
        &self,
        ppresentationdescriptor: Ref<'_, IMFPresentationDescriptor>,
        pguidtimeformat: *const GUID,
        pvarstartposition: *const PROPVARIANT,
    ) -> Result<()> {
        let mut state = self.lock();
        state.check_alive()?;
        let theirs = ppresentationdescriptor.ok().map_err(|_| hr(E_INVALIDARG))?;
        if pvarstartposition.is_null() {
            return Err(hr(E_INVALIDARG));
        }
        // SAFETY: a non-null time format pointer is the caller's GUID.
        if !pguidtimeformat.is_null() && unsafe { *pguidtimeformat } != GUID::zeroed() {
            return Err(hr(MF_E_UNSUPPORTED_TIME_FORMAT));
        }
        let ours = state.presentation()?;
        let queue = state.queue()?;
        let stream = state.stream()?;
        // SAFETY: both descriptors are alive for the calls below.
        unsafe {
            // Their descriptor must have our one stream.
            if theirs.GetStreamDescriptorCount()? != 1 {
                return Err(hr(E_INVALIDARG));
            }
            let mut selected = BOOL(0);
            let mut their_descriptor = None;
            theirs.GetStreamDescriptorByIndex(0, &mut selected, &mut their_descriptor)?;
            let their_descriptor = their_descriptor.ok_or_else(|| hr(E_UNEXPECTED))?;
            if their_descriptor.GetStreamIdentifier()? != STREAM_ID {
                return Err(hr(MF_E_NOT_FOUND));
            }
            let mut was_selected = BOOL(0);
            let mut our_descriptor = None;
            ours.GetStreamDescriptorByIndex(0, &mut was_selected, &mut our_descriptor)?;
            if selected.as_bool() {
                ours.SelectStream(0)?;
                let media_type = their_descriptor
                    .GetMediaTypeHandler()?
                    .GetCurrentMediaType()?;
                let event = if was_selected.as_bool() {
                    MEUpdatedStream
                } else {
                    MENewStream
                };
                let stream_unknown: IUnknown = stream.cast()?;
                queue.QueueEventParamUnk(event.0 as u32, &GUID::zeroed(), S_OK, &stream_unknown)?;
                stream.start(&media_type)?;
            } else if was_selected.as_bool() {
                ours.DeselectStream(0)?;
                stream.stop(false)?;
            }
            let start_time = PROPVARIANT::from(MFGetSystemTime());
            queue.QueueEventParamVar(
                MESourceStarted.0 as u32,
                &GUID::zeroed(),
                S_OK,
                &start_time,
            )?;
        }
        state.phase = SourcePhase::Started;
        Ok(())
    }

    fn Stop(&self) -> Result<()> {
        let mut state = self.lock();
        state.check_alive()?;
        if state.phase != SourcePhase::Started {
            return Err(hr(MF_E_INVALID_STATE_TRANSITION));
        }
        state.phase = SourcePhase::Stopped;
        let ours = state.presentation()?;
        let queue = state.queue()?;
        let stream = state.stream()?;
        stream.stop(true)?;
        // SAFETY: alive objects.
        unsafe {
            ours.DeselectStream(0)?;
            let stop_time = PROPVARIANT::from(MFGetSystemTime());
            queue.QueueEventParamVar(
                MESourceStopped.0 as u32,
                &GUID::zeroed(),
                S_OK,
                &stop_time,
            )?;
        }
        Ok(())
    }

    fn Pause(&self) -> Result<()> {
        Err(hr(MF_E_INVALID_STATE_TRANSITION))
    }

    fn Shutdown(&self) -> Result<()> {
        let mut state = self.lock();
        state.phase = SourcePhase::Shutdown;
        state.attributes = None;
        state.presentation = None;
        if let Some(queue) = state.event_queue.take() {
            // SAFETY: the queue is ours; a failed shutdown changes nothing.
            let _ = unsafe { queue.Shutdown() };
        }
        if let Some(stream) = state.stream.take() {
            stream.shutdown();
        }
        Ok(())
    }
}

impl IMFMediaSourceEx_Impl for VideorcCameraSource_Impl {
    fn GetSourceAttributes(&self) -> Result<IMFAttributes> {
        let state = self.lock();
        state.check_alive()?;
        // A video capture source returns its own store, never a copy.
        state.attributes.clone().ok_or_else(|| hr(E_UNEXPECTED))
    }

    fn GetStreamAttributes(&self, dwstreamidentifier: u32) -> Result<IMFAttributes> {
        let state = self.lock();
        state.check_alive()?;
        if dwstreamidentifier != STREAM_ID {
            return Err(hr(MF_E_NOT_FOUND));
        }
        state.stream()?.attributes()
    }

    fn SetD3DManager(&self, _pmanager: Ref<'_, IUnknown>) -> Result<()> {
        // Best effort by the framework; this source fills system memory.
        Err(hr(E_NOTIMPL))
    }
}

impl IMFGetService_Impl for VideorcCameraSource_Impl {
    fn GetService(
        &self,
        _guidservice: *const GUID,
        _riid: *const GUID,
        ppvobject: *mut *mut c_void,
    ) -> Result<()> {
        let state = self.lock();
        state.check_alive()?;
        if ppvobject.is_null() {
            return Err(hr(E_POINTER));
        }
        // SAFETY: checked non-null.
        unsafe { *ppvobject = null_mut() };
        Err(hr(MF_E_UNSUPPORTED_SERVICE))
    }
}

// No camera controls: answer as an AVStream driver without a handler does,
// which is what the Frame Server expects from a source without them.
impl IKsControl_Impl for VideorcCameraSource_Impl {
    fn KsProperty(
        &self,
        _property: *const KSIDENTIFIER,
        propertylength: u32,
        _propertydata: *mut c_void,
        _datalength: u32,
        _bytesreturned: *mut u32,
    ) -> Result<()> {
        if (propertylength as usize) < std::mem::size_of::<KSIDENTIFIER>() {
            return Err(hr(E_INVALIDARG));
        }
        Err(win32_error(ERROR_SET_NOT_FOUND.0))
    }

    fn KsMethod(
        &self,
        _method: *const KSIDENTIFIER,
        _methodlength: u32,
        _methoddata: *mut c_void,
        _datalength: u32,
        _bytesreturned: *mut u32,
    ) -> Result<()> {
        Err(win32_error(ERROR_SET_NOT_FOUND.0))
    }

    fn KsEvent(
        &self,
        _event: *const KSIDENTIFIER,
        _eventlength: u32,
        _eventdata: *mut c_void,
        _datalength: u32,
        _bytesreturned: *mut u32,
    ) -> Result<()> {
        Err(win32_error(ERROR_SET_NOT_FOUND.0))
    }
}

impl IMFSampleAllocatorControl_Impl for VideorcCameraSource_Impl {
    fn SetDefaultAllocator(
        &self,
        dwoutputstreamid: u32,
        pallocator: Ref<'_, IUnknown>,
    ) -> Result<()> {
        let state = self.lock();
        state.check_alive()?;
        if dwoutputstreamid != STREAM_ID {
            return Err(hr(MF_E_NOT_FOUND));
        }
        let allocator: IMFVideoSampleAllocator = pallocator.ok()?.cast()?;
        state.stream()?.set_sample_allocator(allocator)
    }

    fn GetAllocatorUsage(
        &self,
        dwoutputstreamid: u32,
        pdwinputstreamid: *mut u32,
        peusage: *mut MFSampleAllocatorUsage,
    ) -> Result<()> {
        let state = self.lock();
        state.check_alive()?;
        if pdwinputstreamid.is_null() || peusage.is_null() {
            return Err(hr(E_POINTER));
        }
        if dwoutputstreamid != STREAM_ID {
            return Err(hr(MF_E_NOT_FOUND));
        }
        // SAFETY: checked non-null.
        unsafe {
            *pdwinputstreamid = dwoutputstreamid;
            *peusage = MFSampleAllocatorUsage_UsesProvidedAllocator;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Media stream
// ---------------------------------------------------------------------------

struct StreamState {
    shutdown: bool,
    parent: Option<IMFMediaSource>,
    event_queue: Option<IMFMediaEventQueue>,
    attributes: Option<IMFAttributes>,
    descriptor: Option<IMFStreamDescriptor>,
    allocator: Option<IMFVideoSampleAllocator>,
    media_type: Option<IMFMediaType>,
    stream_state: MF_STREAM_STATE,
    selected: bool,
    frames: FrameSource,
}

impl StreamState {
    fn check_alive(&self) -> Result<()> {
        if self.shutdown {
            return Err(hr(MF_E_SHUTDOWN));
        }
        if self.event_queue.is_none() {
            return Err(hr(E_UNEXPECTED));
        }
        Ok(())
    }

    fn queue(&self) -> Result<IMFMediaEventQueue> {
        self.event_queue.clone().ok_or_else(|| hr(E_UNEXPECTED))
    }

    /// Into running: the allocator (provided, else our own), the ring, the
    /// start event when asked.
    fn start_internal(&mut self, send_event: bool, new_type: Option<&IMFMediaType>) -> Result<()> {
        let mut same_type = false;
        if let (Some(current), Some(new_type)) = (&self.media_type, new_type) {
            // SAFETY: both types are alive.
            same_type = unsafe { current.Compare(new_type, MF_ATTRIBUTES_MATCH_ALL_ITEMS) }
                .is_ok_and(|same| same.as_bool());
            if !same_type {
                self.media_type = Some(new_type.clone());
            }
        } else if let Some(new_type) = new_type {
            self.media_type = Some(new_type.clone());
        }
        if self.stream_state != MF_STREAM_STATE_RUNNING || !same_type {
            let media_type = self.media_type.clone().ok_or_else(|| hr(E_UNEXPECTED))?;
            let allocator = match &self.allocator {
                Some(allocator) => allocator.clone(),
                None => {
                    let mut raw = null_mut();
                    // SAFETY: `raw` receives the requested interface.
                    unsafe {
                        MFCreateVideoSampleAllocatorEx(&IMFVideoSampleAllocator::IID, &mut raw)?
                    };
                    if raw.is_null() {
                        return Err(hr(E_UNEXPECTED));
                    }
                    // SAFETY: a fresh, owned interface pointer.
                    let allocator = unsafe { IMFVideoSampleAllocator::from_raw(raw) };
                    self.allocator = Some(allocator.clone());
                    allocator
                }
            };
            // SAFETY: alive objects.
            unsafe { allocator.InitializeSampleAllocator(ALLOCATOR_SAMPLES, &media_type)? };
        }
        if send_event {
            // SAFETY: the queue is alive; no value.
            unsafe {
                self.queue()?.QueueEventParamVar(
                    MEStreamStarted.0 as u32,
                    &GUID::zeroed(),
                    S_OK,
                    std::ptr::null(),
                )?
            };
        }
        self.stream_state = MF_STREAM_STATE_RUNNING;
        self.frames.set_viewers(1);
        Ok(())
    }

    fn stop_internal(&mut self, send_event: bool) -> Result<()> {
        self.stream_state = MF_STREAM_STATE_STOPPED;
        self.frames.set_viewers(0);
        if send_event {
            // SAFETY: as above.
            unsafe {
                self.queue()?.QueueEventParamVar(
                    MEStreamStopped.0 as u32,
                    &GUID::zeroed(),
                    S_OK,
                    std::ptr::null(),
                )?
            };
        }
        Ok(())
    }
}

#[implement(IMFMediaStream2)]
pub struct VideorcCameraStream {
    state: Mutex<StreamState>,
    _live: LiveObject,
}

impl VideorcCameraStream {
    fn create(parent: IMFMediaSource, stream_id: u32) -> Result<ComObject<Self>> {
        let layout = RingLayout::nv12(CAMERA_WIDTH, CAMERA_HEIGHT).map_err(|_| hr(E_UNEXPECTED))?;
        let media_type = camera_media_type()?;
        let mut attributes = None;
        // SAFETY: plain creation calls on fresh objects.
        let (attributes, descriptor, event_queue) = unsafe {
            MFCreateAttributes(&mut attributes, 8)?;
            let attributes = attributes.ok_or_else(|| hr(E_UNEXPECTED))?;
            set_stream_attributes(&attributes, stream_id)?;
            let descriptor = MFCreateStreamDescriptor(stream_id, &[Some(media_type.clone())])?;
            descriptor
                .GetMediaTypeHandler()?
                .SetCurrentMediaType(&media_type)?;
            set_stream_attributes(&descriptor, stream_id)?;
            (attributes, descriptor, MFCreateEventQueue()?)
        };
        Ok(ComObject::new(Self {
            state: Mutex::new(StreamState {
                shutdown: false,
                parent: Some(parent),
                event_queue: Some(event_queue),
                attributes: Some(attributes),
                descriptor: Some(descriptor),
                allocator: None,
                media_type: Some(media_type),
                stream_state: MF_STREAM_STATE_STOPPED,
                selected: false,
                frames: FrameSource::new(layout),
            }),
            _live: LiveObject::new(),
        }))
    }

    fn lock(&self) -> MutexGuard<'_, StreamState> {
        lock_recovering(&self.state)
    }

    fn descriptor(&self) -> Result<IMFStreamDescriptor> {
        self.lock()
            .descriptor
            .clone()
            .ok_or_else(|| hr(E_UNEXPECTED))
    }

    fn attributes(&self) -> Result<IMFAttributes> {
        let state = self.lock();
        state.check_alive()?;
        state.attributes.clone().ok_or_else(|| hr(E_UNEXPECTED))
    }

    /// The source's Start for a selected stream.
    fn start(&self, media_type: &IMFMediaType) -> Result<()> {
        let mut state = self.lock();
        state.check_alive()?;
        state.selected = true;
        state.start_internal(true, Some(media_type))
    }

    fn stop(&self, send_event: bool) -> Result<()> {
        let mut state = self.lock();
        state.check_alive()?;
        state.selected = false;
        state.stop_internal(send_event)
    }

    fn shutdown(&self) {
        let mut state = self.lock();
        state.shutdown = true;
        state.parent = None;
        if let Some(queue) = state.event_queue.take() {
            // SAFETY: ours; a failed shutdown changes nothing.
            let _ = unsafe { queue.Shutdown() };
        }
        state.attributes = None;
        state.descriptor = None;
        state.allocator = None;
        state.stream_state = MF_STREAM_STATE_STOPPED;
        state.frames.close();
    }

    fn set_sample_allocator(&self, allocator: IMFVideoSampleAllocator) -> Result<()> {
        let mut state = self.lock();
        state.check_alive()?;
        if state.stream_state == MF_STREAM_STATE_RUNNING {
            return Err(hr(MF_E_INVALIDREQUEST));
        }
        state.allocator = Some(allocator);
        Ok(())
    }
}

/// NV12 1920×1080, 30/1, progressive, BT.709 video range.
fn camera_media_type() -> Result<IMFMediaType> {
    let frame_bytes = CAMERA_WIDTH * CAMERA_HEIGHT * 3 / 2;
    // SAFETY: plain attribute sets on a fresh media type.
    unsafe {
        let media_type = MFCreateMediaType()?;
        media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
        media_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        media_type.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)?;
        media_type.SetUINT64(&MF_MT_FRAME_SIZE, packed(CAMERA_WIDTH, CAMERA_HEIGHT))?;
        media_type.SetUINT64(&MF_MT_FRAME_RATE, packed(CAMERA_FPS, 1))?;
        media_type.SetUINT32(&MF_MT_AVG_BITRATE, frame_bytes * 8 * CAMERA_FPS)?;
        media_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, packed(1, 1))?;
        media_type.SetUINT32(&MF_MT_DEFAULT_STRIDE, CAMERA_WIDTH)?;
        media_type.SetUINT32(&MF_MT_SAMPLE_SIZE, frame_bytes)?;
        media_type.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
        media_type.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
        media_type.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
        media_type.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
        Ok(media_type)
    }
}

/// What the Frame Server reads off the stream and its descriptor: a colour
/// video capture pin, shared through the Frame Server.
unsafe fn set_stream_attributes(store: &IMFAttributes, stream_id: u32) -> Result<()> {
    // SAFETY: the caller hands an alive store.
    unsafe {
        store.SetGUID(&MF_DEVICESTREAM_STREAM_CATEGORY, &PINNAME_VIDEO_CAPTURE)?;
        store.SetUINT32(&MF_DEVICESTREAM_STREAM_ID, stream_id)?;
        store.SetUINT32(&MF_DEVICESTREAM_FRAMESERVER_SHARED, 1)?;
        store.SetUINT32(
            &MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES,
            MFFrameSourceTypes_Color.0 as u32,
        )?;
    }
    Ok(())
}

impl IMFMediaEventGenerator_Impl for VideorcCameraStream_Impl {
    fn GetEvent(&self, dwflags: MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS) -> Result<IMFMediaEvent> {
        let queue = {
            let state = self.lock();
            state.check_alive()?;
            state.queue()?
        };
        // SAFETY: alive queue, no lock held while it may block.
        unsafe { queue.GetEvent(dwflags.0) }
    }

    fn BeginGetEvent(
        &self,
        pcallback: Ref<'_, IMFAsyncCallback>,
        punkstate: Ref<'_, IUnknown>,
    ) -> Result<()> {
        let state = self.lock();
        state.check_alive()?;
        // SAFETY: as above.
        unsafe {
            state
                .queue()?
                .BeginGetEvent(pcallback.as_ref(), punkstate.as_ref())
        }
    }

    fn EndGetEvent(&self, presult: Ref<'_, IMFAsyncResult>) -> Result<IMFMediaEvent> {
        let state = self.lock();
        state.check_alive()?;
        // SAFETY: as above.
        unsafe { state.queue()?.EndGetEvent(presult.as_ref()) }
    }

    fn QueueEvent(
        &self,
        met: u32,
        guidextendedtype: *const GUID,
        hrstatus: HRESULT,
        pvvalue: *const PROPVARIANT,
    ) -> Result<()> {
        let state = self.lock();
        state.check_alive()?;
        // SAFETY: as above.
        unsafe {
            state
                .queue()?
                .QueueEventParamVar(met, guidextendedtype, hrstatus, pvvalue)
        }
    }
}

impl IMFMediaStream_Impl for VideorcCameraStream_Impl {
    fn GetMediaSource(&self) -> Result<IMFMediaSource> {
        let state = self.lock();
        state.check_alive()?;
        state.parent.clone().ok_or_else(|| hr(E_UNEXPECTED))
    }

    fn GetStreamDescriptor(&self) -> Result<IMFStreamDescriptor> {
        let state = self.lock();
        state.check_alive()?;
        state.descriptor.clone().ok_or_else(|| hr(E_UNEXPECTED))
    }

    fn RequestSample(&self, ptoken: Ref<'_, IUnknown>) -> Result<()> {
        let mut state = self.lock();
        state.check_alive()?;
        if state.stream_state != MF_STREAM_STATE_RUNNING {
            return Err(hr(MF_E_INVALIDREQUEST));
        }
        let allocator = state.allocator.clone().ok_or_else(|| hr(E_POINTER))?;
        let queue = state.queue()?;
        let layout = *state.frames.layout();
        // SAFETY: the allocator and the sample it hands out are alive for
        // the whole method; the locked buffer is written within its length.
        unsafe {
            let sample = allocator.AllocateSample()?;
            let buffer = sample.GetBufferByIndex(0)?;
            let frame = state.frames.next_frame();
            match buffer.cast::<IMF2DBuffer2>() {
                Ok(buffer2d) => {
                    let mut scanline0: *mut u8 = null_mut();
                    let mut pitch: i32 = 0;
                    let mut start: *mut u8 = null_mut();
                    let mut length: u32 = 0;
                    buffer2d.Lock2DSize(
                        MF2DBuffer_LockFlags_Write,
                        &mut scanline0,
                        &mut pitch,
                        &mut start,
                        &mut length,
                    )?;
                    let copied =
                        copy_nv12_pitched(frame, &layout, scanline0, pitch, length as usize);
                    buffer2d.Unlock2D()?;
                    copied?;
                }
                Err(_) => {
                    let mut data: *mut u8 = null_mut();
                    let mut max_length: u32 = 0;
                    buffer.Lock(&mut data, Some(&mut max_length), None)?;
                    let copied = copy_nv12_pitched(
                        frame,
                        &layout,
                        data,
                        layout.width as i32,
                        max_length as usize,
                    );
                    buffer.Unlock()?;
                    copied?;
                    buffer.SetCurrentLength(layout.frame_bytes as u32)?;
                }
            }
            sample.SetSampleTime(MFGetSystemTime())?;
            sample.SetSampleDuration(FRAME_DURATION_100NS)?;
            if let Some(token) = ptoken.as_ref() {
                sample.SetUnknown(&MFSampleExtension_Token, token)?;
            }
            queue.QueueEventParamUnk(MEMediaSample.0 as u32, &GUID::zeroed(), S_OK, &sample)?;
        }
        Ok(())
    }
}

impl IMFMediaStream2_Impl for VideorcCameraStream_Impl {
    fn SetStreamState(&self, value: MF_STREAM_STATE) -> Result<()> {
        let mut state = self.lock();
        state.check_alive()?;
        if state.stream_state == value {
            return Ok(());
        }
        match value {
            MF_STREAM_STATE_PAUSED => {
                if state.stream_state != MF_STREAM_STATE_RUNNING {
                    return Err(hr(MF_E_INVALID_STATE_TRANSITION));
                }
                state.stream_state = MF_STREAM_STATE_PAUSED;
                Ok(())
            }
            MF_STREAM_STATE_RUNNING => state.start_internal(false, None),
            MF_STREAM_STATE_STOPPED => state.stop_internal(false),
            _ => Err(hr(MF_E_INVALID_STATE_TRANSITION)),
        }
    }

    fn GetStreamState(&self) -> Result<MF_STREAM_STATE> {
        let state = self.lock();
        state.check_alive()?;
        Ok(state.stream_state)
    }
}

/// Copy a tightly packed NV12 frame into a buffer with `pitch` bytes per
/// row: `height` luma rows then `height / 2` chroma rows, the chroma plane
/// starting at `pitch × height` as Media Foundation's NV12 2D buffers lay
/// it out.
///
/// # Safety
///
/// `scanline0` must point at a writable buffer of `length` bytes.
unsafe fn copy_nv12_pitched(
    frame: &[u8],
    layout: &RingLayout,
    scanline0: *mut u8,
    pitch: i32,
    length: usize,
) -> Result<()> {
    let width = layout.width as usize;
    let height = layout.height as usize;
    if frame.len() != layout.frame_bytes || scanline0.is_null() || pitch < width as i32 {
        return Err(hr(E_UNEXPECTED));
    }
    let pitch = pitch as usize;
    let rows = height + height / 2;
    if length < pitch * rows {
        return Err(hr(E_UNEXPECTED));
    }
    for row in 0..rows {
        // SAFETY: `row × pitch + width ≤ length` (checked above); the source
        // row is within the packed frame.
        unsafe {
            std::ptr::copy_nonoverlapping(
                frame.as_ptr().add(row * width),
                scanline0.add(row * pitch),
                width,
            );
        }
    }
    Ok(())
}
