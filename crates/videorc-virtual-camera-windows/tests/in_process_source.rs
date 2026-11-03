//! Plan 214 C1's "done when": the media source opens in-process, the way
//! Microsoft's `VirtualCameraTest` does it, and a source reader pulls NV12
//! frames out of it. Without Videorc writing the ring the frames are the
//! "Videorc isn't running" still. Windows only; runs on `windows-latest`.
#![cfg(windows)]

use std::ptr::null_mut;

use videorc_virtual_camera_windows::ring::RingLayout;
use videorc_virtual_camera_windows::windows::dll::{
    DllCanUnloadNow, DllGetClassObject, SOURCE_CLSID_GUID,
};
use videorc_virtual_camera_windows::windows::media_source::LIVE_OBJECTS;
use videorc_virtual_camera_windows::{CAMERA_HEIGHT, CAMERA_WIDTH};
use windows::Win32::Foundation::{S_FALSE, S_OK};
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFMediaSource, IMFMediaSourceEx, IMFSample, MF_SOURCE_READER_FIRST_VIDEO_STREAM,
    MF_VERSION, MFCreateSourceReaderFromMediaSource, MFSTARTUP_NOSOCKET, MFShutdown, MFStartup,
};
use windows::Win32::System::Com::{
    COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize, IClassFactory,
};
use windows::core::{IUnknown, Interface};

struct MediaFoundation;

impl MediaFoundation {
    fn start() -> Self {
        // SAFETY: once per test thread, paired with the drop below.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET).expect("MFStartup");
        }
        Self
    }
}

impl Drop for MediaFoundation {
    fn drop(&mut self) {
        // SAFETY: paired with `start`.
        unsafe {
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}

fn class_factory() -> IClassFactory {
    let mut raw = null_mut();
    // SAFETY: the export is called the way COM calls it, with valid pointers.
    let result = unsafe { DllGetClassObject(&SOURCE_CLSID_GUID, &IClassFactory::IID, &mut raw) };
    assert_eq!(result, S_OK, "DllGetClassObject");
    assert!(!raw.is_null());
    // SAFETY: a fresh owned interface pointer.
    unsafe { IClassFactory::from_raw(raw) }
}

#[test]
fn the_source_opens_in_process_and_a_reader_pulls_nv12_frames() {
    let _mf = MediaFoundation::start();
    let layout = RingLayout::nv12(CAMERA_WIDTH, CAMERA_HEIGHT).unwrap();
    let factory = class_factory();
    // SAFETY: COM calls with alive objects throughout.
    unsafe {
        assert_eq!(DllCanUnloadNow(), S_FALSE, "a live factory pins the DLL");
        let activate: IMFActivate = factory.CreateInstance(None::<&IUnknown>).expect("activate");
        let source: IMFMediaSource = activate.ActivateObject().expect("media source");
        let extended: IMFMediaSourceEx = source.cast().expect("IMFMediaSourceEx");
        let attributes = extended.GetSourceAttributes().expect("source attributes");
        assert!(
            attributes.GetCount().expect("count") >= 1,
            "the sensor profile collection"
        );
        let stream_attributes = extended.GetStreamAttributes(0).expect("stream attributes");
        assert!(stream_attributes.GetCount().expect("count") >= 4);

        let reader = MFCreateSourceReaderFromMediaSource(
            &source,
            None::<&windows::Win32::Media::MediaFoundation::IMFAttributes>,
        )
        .expect("source reader");
        let mut got = 0;
        for _ in 0..6 {
            let mut stream_index = 0u32;
            let mut flags = 0u32;
            let mut timestamp = 0i64;
            let mut sample: Option<IMFSample> = None;
            reader
                .ReadSample(
                    MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                    0,
                    Some(&mut stream_index),
                    Some(&mut flags),
                    Some(&mut timestamp),
                    Some(&mut sample),
                )
                .expect("ReadSample");
            let Some(sample) = sample else {
                continue;
            };
            got += 1;
            assert_eq!(sample.GetSampleDuration().expect("duration"), 333_333);
            let buffer = sample
                .ConvertToContiguousBuffer()
                .expect("contiguous buffer");
            let mut data = null_mut();
            let mut length = 0u32;
            buffer
                .Lock(&mut data, None, Some(&mut length))
                .expect("lock");
            assert!(
                length as usize >= layout.frame_bytes,
                "a whole NV12 frame: {length}"
            );
            // No Videorc writes the ring here, so this is the still: a dark
            // luma plane with neutral chroma.
            let luma = std::slice::from_raw_parts(data, layout.width as usize);
            assert!(
                luma.iter().all(|byte| *byte == luma[0]),
                "the top row is one shade"
            );
            let chroma_start = layout.width as usize * layout.height as usize;
            let chroma = std::slice::from_raw_parts(data.add(chroma_start), 64);
            assert!(chroma.iter().all(|byte| *byte == 128), "neutral chroma");
            buffer.Unlock().expect("unlock");
            if got == 3 {
                break;
            }
        }
        assert_eq!(got, 3, "three frames in six requests");
        source.Shutdown().expect("shutdown");
        activate.DetachObject().expect("detach");
        drop(reader);
        drop(extended);
        drop(source);
        drop(activate);
    }
    drop(factory);
    assert_eq!(
        LIVE_OBJECTS.load(std::sync::atomic::Ordering::Acquire),
        0,
        "every object was released"
    );
    // SAFETY: no arguments.
    assert_eq!(unsafe { DllCanUnloadNow() }, S_OK);
}
