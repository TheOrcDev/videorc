//! D9's boundary on macOS: VideoToolbox decodes H.264 and HEVC (Main 10
//! included) to IOSurface-backed BGRA, and the frame goes into the camera
//! frame store without a copy where the compositor can import it (D12).

use std::ffi::c_void;
use std::ptr::{self, NonNull};
use std::sync::Mutex;

use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFRetained, CFType};
use objc2_core_media::{
    CMBlockBuffer, CMFormatDescription, CMSampleBuffer, CMSampleTimingInfo, CMTime, CMTimeFlags,
    CMVideoFormatDescription, CMVideoFormatDescriptionCreateFromH264ParameterSets,
    CMVideoFormatDescriptionCreateFromHEVCParameterSets, kCMBlockBufferAssureMemoryNowFlag,
    kCMTimeInvalid,
};
use objc2_core_video::{
    CVImageBuffer, CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
    CVPixelBufferGetHeight, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress,
    CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress, kCVPixelBufferIOSurfacePropertiesKey,
    kCVPixelBufferMetalCompatibilityKey, kCVPixelBufferPixelFormatTypeKey,
    kCVPixelFormatType_32BGRA,
};
use objc2_video_toolbox::{
    VTDecodeFrameFlags, VTDecodeInfoFlags, VTDecompressionOutputCallbackRecord,
    VTDecompressionSession, kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder,
};

use super::annexb::{ParameterSets, ParsedAccessUnit};
use super::camera::FrameDecoder;
use super::ts_demux::VideoCodec;
use crate::frame_store::RetainedPixelBuffer;

/// A decoded BGRA frame.
#[derive(Clone)]
pub struct DecodedFrame {
    pub pixel_buffer: RetainedPixelBuffer,
    pub width: u32,
    pub height: u32,
    /// The frame's own PTS, in 90 kHz ticks (the development frame tap reads it).
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    pub pts: i64,
}

/// What the output callback reported for one submitted frame.
#[derive(Debug, PartialEq)]
enum Output<F> {
    Frame(i64, F),
    /// VideoToolbox could not decode it (a nonzero status).
    Failed(i32),
    /// No image and no error: VideoToolbox dropped it.
    Dropped,
}

/// Where the output callback leaves its reports for `decode` to collect.
type Outputs = Mutex<Vec<Output<CFRetained<CVPixelBuffer>>>>;

/// The frames, oldest first, or the first failure the callback reported:
/// a failure goes back to the receiver, which rebuilds the session (D18).
/// Dropped frames are not failures; the receiver rebuilds a decoder that
/// gives nothing back for too long.
fn decode_outcome<F>(outputs: Vec<Output<F>>) -> Result<Vec<F>, String> {
    let mut frames = Vec::new();
    for output in outputs {
        match output {
            Output::Frame(pts, frame) => frames.push((pts, frame)),
            Output::Failed(status) => {
                return Err(format!("VideoToolbox could not decode a frame ({status})"));
            }
            Output::Dropped => {}
        }
    }
    frames.sort_by_key(|(pts, _)| *pts);
    Ok(frames.into_iter().map(|(_, frame)| frame).collect())
}

struct Session {
    session: CFRetained<VTDecompressionSession>,
    format: CFRetained<CMFormatDescription>,
    codec: VideoCodec,
    parameter_sets: ParameterSets,
}

pub struct VideoToolboxDecoder {
    session: Option<Session>,
    /// Boxed so its address is stable for the callback's refcon.
    outputs: Box<Outputs>,
    next_pts: i64,
}

impl Default for VideoToolboxDecoder {
    fn default() -> Self {
        Self {
            session: None,
            outputs: Box::new(Mutex::new(Vec::new())),
            next_pts: 0,
        }
    }
}

impl Drop for VideoToolboxDecoder {
    fn drop(&mut self) {
        self.close();
    }
}

unsafe extern "C-unwind" fn on_decoded(
    refcon: *mut c_void,
    _frame_refcon: *mut c_void,
    status: i32,
    _flags: VTDecodeInfoFlags,
    image: *mut CVImageBuffer,
    pts: CMTime,
    _duration: CMTime,
) {
    if refcon.is_null() {
        return;
    }
    // SAFETY: `refcon` is the decoder's boxed `Outputs`, alive until the
    // session is invalidated; `image` is a CVPixelBuffer VideoToolbox lends
    // us, retained here before the callback returns.
    let outputs = unsafe { &*(refcon as *const Outputs) };
    let output = callback_output(status, NonNull::new(image), pts.value, |image| unsafe {
        CFRetained::retain(image.cast::<CVPixelBuffer>())
    });
    outputs
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(output);
}

/// What one decode callback means: any non-zero status is a failure, even
/// with an image; no image is a dropped frame.
fn callback_output<I, F>(
    status: i32,
    image: Option<I>,
    pts: i64,
    keep: impl FnOnce(I) -> F,
) -> Output<F> {
    match image {
        _ if status != 0 => Output::Failed(status),
        None => Output::Dropped,
        Some(image) => Output::Frame(pts, keep(image)),
    }
}

fn format_description(
    codec: VideoCodec,
    sets: &ParameterSets,
) -> Result<CFRetained<CMFormatDescription>, String> {
    let ordered: Vec<&Vec<u8>> = match codec {
        VideoCodec::H264 => [&sets.sps, &sets.pps].into_iter().flatten().collect(),
        VideoCodec::Hevc => [&sets.vps, &sets.sps, &sets.pps]
            .into_iter()
            .flatten()
            .collect(),
        VideoCodec::Unsupported(_) => return Err("unsupported codec".to_string()),
    };
    let mut pointers: Vec<NonNull<u8>> = ordered
        .iter()
        .map(|set| NonNull::new(set.as_ptr().cast_mut()).expect("a parameter set is not empty"))
        .collect();
    let mut sizes: Vec<usize> = ordered.iter().map(|set| set.len()).collect();
    let mut format: *const CMVideoFormatDescription = ptr::null();
    // SAFETY: the arrays and their bytes outlive the call; 4-byte NAL
    // lengths match `ParsedAccessUnit::length_prefixed`.
    let status = unsafe {
        let pointers = NonNull::new(pointers.as_mut_ptr()).expect("non-empty");
        let sizes = NonNull::new(sizes.as_mut_ptr()).expect("non-empty");
        match codec {
            VideoCodec::H264 => CMVideoFormatDescriptionCreateFromH264ParameterSets(
                None,
                ordered.len(),
                pointers,
                sizes,
                4,
                NonNull::from(&mut format),
            ),
            _ => CMVideoFormatDescriptionCreateFromHEVCParameterSets(
                None,
                ordered.len(),
                pointers,
                sizes,
                4,
                None,
                NonNull::from(&mut format),
            ),
        }
    };
    NonNull::new(format.cast_mut())
        .filter(|_| status == 0)
        // SAFETY: a Create call returns +1.
        .map(|format| unsafe { CFRetained::from_raw(format) })
        .ok_or_else(|| format!("the parameter sets were refused ({status})"))
}

impl VideoToolboxDecoder {
    fn close(&mut self) {
        if let Some(session) = self.session.take() {
            // SAFETY: invalidating before the outputs box goes ends callbacks.
            unsafe { session.session.invalidate() };
        }
    }

    fn open(&mut self, codec: VideoCodec, sets: &ParameterSets) -> Result<(), String> {
        if let Some(session) = self.session.as_ref()
            && session.codec == codec
            && session.parameter_sets == *sets
        {
            return Ok(());
        }
        let format = format_description(codec, sets)?;
        if let Some(session) = self.session.as_mut() {
            // SAFETY: plain query on a live session.
            if session.codec == codec
                && unsafe { session.session.can_accept_format_description(&format) }
            {
                session.format = format;
                session.parameter_sets = sets.clone();
                return Ok(());
            }
        }
        self.close();
        let empty = CFDictionary::<CFType, CFType>::from_slices(&[], &[]);
        let bgra = CFNumber::new_i64(i64::from(kCVPixelFormatType_32BGRA));
        let attributes = CFDictionary::<CFType, CFType>::from_slices(
            &[
                unsafe { kCVPixelBufferPixelFormatTypeKey }.as_ref(),
                unsafe { kCVPixelBufferIOSurfacePropertiesKey }.as_ref(),
                unsafe { kCVPixelBufferMetalCompatibilityKey }.as_ref(),
            ],
            &[bgra.as_ref(), empty.as_ref(), CFBoolean::new(true).as_ref()],
        );
        let specification = CFDictionary::<CFType, CFType>::from_slices(
            &[
                unsafe { kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder }
                    .as_ref(),
            ],
            &[CFBoolean::new(true).as_ref()],
        );
        let callback = VTDecompressionOutputCallbackRecord {
            decompressionOutputCallback: Some(on_decoded),
            decompressionOutputRefCon: (&*self.outputs as *const Outputs).cast_mut().cast(),
        };
        let mut raw: *mut VTDecompressionSession = ptr::null_mut();
        // SAFETY: every argument outlives the call; the refcon outlives the
        // session (see `close`).
        let status = unsafe {
            VTDecompressionSession::create(
                None,
                &format,
                Some(specification.as_ref()),
                Some(attributes.as_ref()),
                &callback,
                NonNull::from(&mut raw),
            )
        };
        let session = NonNull::new(raw)
            .filter(|_| status == 0)
            // SAFETY: a Create call returns +1.
            .map(|session| unsafe { CFRetained::from_raw(session) })
            .ok_or_else(|| {
                format!(
                    "VideoToolbox can't decode this {} stream ({status})",
                    codec.label()
                )
            })?;
        self.session = Some(Session {
            session,
            format,
            codec,
            parameter_sets: sets.clone(),
        });
        Ok(())
    }

    fn sample(
        &self,
        unit: &ParsedAccessUnit,
        pts: i64,
    ) -> Result<CFRetained<CMSampleBuffer>, String> {
        let session = self.session.as_ref().ok_or("no session")?;
        let length = unit.length_prefixed.len();
        let mut block: *mut CMBlockBuffer = ptr::null_mut();
        // SAFETY: a NULL memory block with AssureMemoryNow makes CoreMedia
        // allocate `length` bytes, which the copy below fills.
        let status = unsafe {
            CMBlockBuffer::create_with_memory_block(
                None,
                ptr::null_mut(),
                length,
                None,
                ptr::null(),
                0,
                length,
                kCMBlockBufferAssureMemoryNowFlag,
                NonNull::from(&mut block),
            )
        };
        let block = NonNull::new(block)
            .filter(|_| status == 0)
            .map(|block| unsafe { CFRetained::from_raw(block) })
            .ok_or_else(|| format!("CMBlockBuffer failed ({status})"))?;
        // SAFETY: the source holds `length` bytes; the block was sized for it.
        let status = unsafe {
            CMBlockBuffer::replace_data_bytes(
                NonNull::new(unit.length_prefixed.as_ptr().cast_mut().cast()).ok_or("empty")?,
                &block,
                0,
                length,
            )
        };
        if status != 0 {
            return Err(format!("CMBlockBuffer copy failed ({status})"));
        }
        let timing = CMSampleTimingInfo {
            duration: unsafe { kCMTimeInvalid },
            presentationTimeStamp: CMTime {
                value: pts,
                timescale: 90_000,
                flags: CMTimeFlags::Valid,
                epoch: 0,
            },
            decodeTimeStamp: unsafe { kCMTimeInvalid },
        };
        let mut sample: *mut CMSampleBuffer = ptr::null_mut();
        // SAFETY: one sample, one timing entry, one size entry, all alive.
        let status = unsafe {
            CMSampleBuffer::create_ready(
                None,
                Some(&block),
                Some(&session.format),
                1,
                1,
                &timing,
                1,
                &length,
                NonNull::from(&mut sample),
            )
        };
        NonNull::new(sample)
            .filter(|_| status == 0)
            .map(|sample| unsafe { CFRetained::from_raw(sample) })
            .ok_or_else(|| format!("CMSampleBuffer failed ({status})"))
    }
}

impl FrameDecoder for VideoToolboxDecoder {
    type Frame = DecodedFrame;

    fn decode(
        &mut self,
        codec: VideoCodec,
        parameter_sets: &ParameterSets,
        unit: &ParsedAccessUnit,
        pts: Option<u64>,
    ) -> Result<Vec<DecodedFrame>, String> {
        self.open(codec, parameter_sets)?;
        let pts = match pts {
            Some(pts) => i64::try_from(pts).unwrap_or(i64::MAX),
            None => self.next_pts + 3000,
        };
        self.next_pts = pts;
        let sample = self.sample(unit, pts)?;
        let session = self.session.as_ref().ok_or("no session")?;
        // Temporal processing lets VideoToolbox hand frames back in display
        // order when the stream has B-frames; the newest one wins.
        let mut info = VTDecodeInfoFlags(0);
        let flags = VTDecodeFrameFlags::Frame_EnableTemporalProcessing;
        // SAFETY: the sample and info pointer outlive the synchronous call.
        let status = unsafe {
            session
                .session
                .decode_frame(&sample, flags, ptr::null_mut(), &mut info)
        };
        if status != 0 {
            return Err(format!("VideoToolbox refused the frame ({status})"));
        }
        let outputs = std::mem::take(
            &mut *self
                .outputs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
        // Each frame keeps its own PTS (the frame tap logs it).
        let outputs = outputs
            .into_iter()
            .map(|output| match output {
                Output::Frame(pts, frame) => Output::Frame(pts, (pts, frame)),
                Output::Failed(status) => Output::Failed(status),
                Output::Dropped => Output::Dropped,
            })
            .collect();
        Ok(decode_outcome(outputs)?
            .into_iter()
            .map(|(pts, pixel_buffer)| DecodedFrame {
                width: CVPixelBufferGetWidth(&pixel_buffer) as u32,
                height: CVPixelBufferGetHeight(&pixel_buffer) as u32,
                pixel_buffer: RetainedPixelBuffer::new(pixel_buffer),
                pts,
            })
            .collect())
    }

    fn frame_size(frame: &DecodedFrame) -> (u32, u32) {
        (frame.width, frame.height)
    }

    fn reset(&mut self) {
        self.close();
        self.outputs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }
}

/// The frame's BGRA rows, for the paths that cannot import the pixel buffer.
pub fn copy_bgra(frame: &DecodedFrame) -> Option<Vec<u8>> {
    let pixel_buffer = frame.pixel_buffer.pixel_buffer();
    // SAFETY: lock, read within the locked bounds, unlock.
    unsafe {
        if CVPixelBufferLockBaseAddress(pixel_buffer, CVPixelBufferLockFlags::ReadOnly) != 0 {
            return None;
        }
        let base = CVPixelBufferGetBaseAddress(pixel_buffer).cast::<u8>();
        let stride = CVPixelBufferGetBytesPerRow(pixel_buffer);
        let row = frame.width as usize * 4;
        let copied = (!base.is_null() && stride >= row).then(|| {
            let mut bytes = Vec::with_capacity(row * frame.height as usize);
            for y in 0..frame.height as usize {
                bytes.extend_from_slice(std::slice::from_raw_parts(base.add(y * stride), row));
            }
            bytes
        });
        CVPixelBufferUnlockBaseAddress(pixel_buffer, CVPixelBufferLockFlags::ReadOnly);
        copied
    }
}

/// A grayscale sample of `rect` (every `step`th pixel), for the frame tap.
#[cfg(debug_assertions)]
pub fn copy_gray_crop(frame: &DecodedFrame, rect: super::frame_tap::CropRect) -> Option<Vec<u8>> {
    let pixel_buffer = frame.pixel_buffer.pixel_buffer();
    // SAFETY: lock, read within the locked bounds (the rect lies inside the
    // frame), unlock.
    unsafe {
        if CVPixelBufferLockBaseAddress(pixel_buffer, CVPixelBufferLockFlags::ReadOnly) != 0 {
            return None;
        }
        let base = CVPixelBufferGetBaseAddress(pixel_buffer).cast::<u8>();
        let stride = CVPixelBufferGetBytesPerRow(pixel_buffer);
        let inside = rect.x0 + rect.width <= frame.width
            && rect.y0 + rect.height <= frame.height
            && stride >= frame.width as usize * 4;
        let gray = (!base.is_null() && inside).then(|| {
            let mut gray = Vec::with_capacity((rect.out_width * rect.out_height) as usize);
            for y in (rect.y0..rect.y0 + rect.height).step_by(rect.step as usize) {
                let row = base.add(y as usize * stride);
                for x in (rect.x0..rect.x0 + rect.width).step_by(rect.step as usize) {
                    let pixel = row.add(x as usize * 4);
                    gray.push(super::frame_tap::luma(*pixel, *pixel.add(1), *pixel.add(2)));
                }
            }
            gray
        });
        CVPixelBufferUnlockBaseAddress(pixel_buffer, CVPixelBufferLockFlags::ReadOnly);
        gray
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_decoder_hands_back_frames_oldest_first() {
        let outputs = vec![
            Output::Frame(2, 'b'),
            Output::Dropped,
            Output::Frame(1, 'a'),
        ];
        assert_eq!(decode_outcome(outputs), Ok(vec!['a', 'b']));
    }

    #[test]
    fn srt_decoder_a_callback_failure_reaches_the_receiver() {
        // decode_frame accepted the submission; the callback says it failed
        // (kVTVideoDecoderBadDataErr, then kVTInvalidSessionErr after a
        // sleep). Either must come back as an error, never as no frame.
        let outputs = vec![Output::Frame(1, 'a'), Output::Failed(-12909)];
        assert_eq!(
            decode_outcome(outputs),
            Err("VideoToolbox could not decode a frame (-12909)".to_string())
        );
    }

    #[test]
    fn srt_decoder_callback_status_wins_over_its_image() {
        let keep = |image: char| image;
        for status in [-12909, -12903, 1] {
            assert_eq!(
                callback_output(status, Some('a'), 3, keep),
                Output::Failed(status)
            );
        }
        assert_eq!(callback_output(0, None::<char>, 3, keep), Output::Dropped);
        assert_eq!(
            callback_output(0, Some('a'), 3, keep),
            Output::Frame(3, 'a')
        );
    }

    #[test]
    fn srt_decoder_a_dropped_frame_is_no_error() {
        assert_eq!(decode_outcome::<char>(vec![Output::Dropped]), Ok(vec![]));
    }
}
