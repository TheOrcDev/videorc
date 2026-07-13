use std::ffi::{c_int, c_void};
use std::ptr::{self, NonNull};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};

use anyhow::{Context, Result, bail, ensure};
use block2::RcBlock;
use objc2_core_foundation::{CFBoolean, CFNumber, CFRetained, CFString, CFType};
use objc2_core_media::{
    CMSampleBuffer, CMTime, CMVideoFormatDescriptionGetH264ParameterSetAtIndex, kCMTimeInvalid,
    kCMVideoCodecType_H264,
};
use objc2_core_video::{CVPixelBufferGetHeight, CVPixelBufferGetWidth};
use objc2_video_toolbox::{
    VTCompressionSession, VTEncodeInfoFlags, VTSession, VTSessionSetProperty,
    kVTCompressionPropertyKey_AllowFrameReordering, kVTCompressionPropertyKey_AverageBitRate,
    kVTCompressionPropertyKey_ExpectedFrameRate, kVTCompressionPropertyKey_MaxFrameDelayCount,
    kVTCompressionPropertyKey_MaxKeyFrameInterval,
    kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality,
    kVTCompressionPropertyKey_RealTime,
};

use crate::metal_compositor::MetalCompositorTargetPixelBuffer;

const NO_ERR: OSStatus = 0;
type OSStatus = i32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VideoToolboxRealtimePropertyStatuses {
    pub real_time: OSStatus,
    pub allow_frame_reordering: OSStatus,
    pub expected_frame_rate: OSStatus,
    pub max_key_frame_interval: OSStatus,
    pub average_bit_rate: Option<OSStatus>,
    pub prioritize_encoding_speed: OSStatus,
    pub max_frame_delay_count: OSStatus,
    pub expected_frame_rate_value: i32,
    pub max_key_frame_interval_value: i32,
    pub average_bit_rate_value: Option<i64>,
    pub max_frame_delay_count_value: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VideoToolboxFrameTiming {
    pub presentation_time_value: i64,
    pub presentation_time_scale: i32,
    pub duration_value: i64,
    pub duration_time_scale: i32,
}

impl VideoToolboxFrameTiming {
    pub const fn new(
        presentation_time_value: i64,
        presentation_time_scale: i32,
        duration_value: i64,
        duration_time_scale: i32,
    ) -> Self {
        Self {
            presentation_time_value,
            presentation_time_scale,
            duration_value,
            duration_time_scale,
        }
    }

    pub fn frame_index(frame_index: i64, frames_per_second: i32) -> Result<Self> {
        ensure!(
            frame_index >= 0,
            "VideoToolbox frame index must be non-negative"
        );
        ensure!(
            frames_per_second > 0,
            "VideoToolbox frame rate must be positive"
        );
        Ok(Self::new(
            frame_index,
            frames_per_second,
            1,
            frames_per_second,
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoToolboxH264ProbeResult {
    pub width: usize,
    pub height: usize,
    pub create_status: OSStatus,
    pub property_statuses: VideoToolboxRealtimePropertyStatuses,
    pub frame_timing: Option<VideoToolboxFrameTiming>,
    pub prepare_status: OSStatus,
    pub encode_status: Option<OSStatus>,
    pub complete_status: Option<OSStatus>,
    pub encode_info_flags: Option<u32>,
    pub callback_count: usize,
    pub callback_status: Option<OSStatus>,
    pub callback_info_flags: Option<u32>,
    pub sample_buffer_count: usize,
    pub sample_total_size_bytes: usize,
    pub block_buffer_data_bytes: usize,
    pub copied_sample_count: usize,
    pub copied_sample_bytes: usize,
    pub copied_sample_prefix: Vec<u8>,
    pub copied_sample_payload: Vec<u8>,
    pub copied_sample_avcc_nal_count: usize,
    pub copied_sample_avcc_payload_bytes: usize,
    pub copied_sample_avcc_nal_types: Vec<u8>,
    pub h264_parameter_set_count: usize,
    pub h264_parameter_set_copied_count: usize,
    pub h264_parameter_set_total_bytes: usize,
    pub h264_parameter_set_nal_unit_header_length: Option<i32>,
    pub h264_parameter_set_nal_types: Vec<u8>,
    pub h264_parameter_sets: Vec<Vec<u8>>,
    pub h264_parameter_set_error_status: Option<OSStatus>,
    pub annex_b_sample_bytes: usize,
    pub annex_b_sample_prefix: Vec<u8>,
    pub annex_b_sample: Vec<u8>,
    pub sample_copy_error_status: Option<OSStatus>,
    pub frame_dropped: bool,
    pub iosurface_backed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoToolboxH264AnnexBFrame {
    pub timing: VideoToolboxFrameTiming,
    pub bytes: Vec<u8>,
    pub nal_types: Vec<u8>,
    pub is_idr: bool,
}

#[derive(Debug)]
pub struct VideoToolboxH264AsyncAnnexBFrame {
    pub frame_index: u64,
    pub result: std::result::Result<VideoToolboxH264AnnexBFrame, String>,
}

fn send_bounded_async_annex_b_frame(
    sender: &mpsc::SyncSender<VideoToolboxH264AsyncAnnexBFrame>,
    rejected_frames: &AtomicU64,
    frame: VideoToolboxH264AsyncAnnexBFrame,
) {
    if sender.try_send(frame).is_err() {
        // VideoToolbox callbacks must never block: complete_pending_frames may
        // wait for this callback while the bridge thread is not draining. The
        // bridge observes this counter on its next drain and explicitly fails
        // the affected output; silently dropping an encoded access unit would
        // corrupt any H.264 frames that reference it.
        rejected_frames.fetch_add(1, Ordering::Release);
    }
}

impl VideoToolboxH264ProbeResult {
    fn prepared(
        width: usize,
        height: usize,
        property_statuses: VideoToolboxRealtimePropertyStatuses,
        prepare_status: OSStatus,
    ) -> Self {
        Self {
            width,
            height,
            create_status: NO_ERR,
            property_statuses,
            frame_timing: None,
            prepare_status,
            encode_status: None,
            complete_status: None,
            encode_info_flags: None,
            callback_count: 0,
            callback_status: None,
            callback_info_flags: None,
            sample_buffer_count: 0,
            sample_total_size_bytes: 0,
            block_buffer_data_bytes: 0,
            copied_sample_count: 0,
            copied_sample_bytes: 0,
            copied_sample_prefix: Vec::new(),
            copied_sample_payload: Vec::new(),
            copied_sample_avcc_nal_count: 0,
            copied_sample_avcc_payload_bytes: 0,
            copied_sample_avcc_nal_types: Vec::new(),
            h264_parameter_set_count: 0,
            h264_parameter_set_copied_count: 0,
            h264_parameter_set_total_bytes: 0,
            h264_parameter_set_nal_unit_header_length: None,
            h264_parameter_set_nal_types: Vec::new(),
            h264_parameter_sets: Vec::new(),
            h264_parameter_set_error_status: None,
            annex_b_sample_bytes: 0,
            annex_b_sample_prefix: Vec::new(),
            annex_b_sample: Vec::new(),
            sample_copy_error_status: None,
            frame_dropped: false,
            iosurface_backed: false,
        }
    }

    pub fn annex_b_frame(&self) -> Option<VideoToolboxH264AnnexBFrame> {
        let timing = self.frame_timing?;
        if self.annex_b_sample.is_empty() {
            return None;
        }
        let nal_types = annex_b_nal_types(&self.annex_b_sample);
        Some(VideoToolboxH264AnnexBFrame {
            timing,
            bytes: self.annex_b_sample.clone(),
            is_idr: nal_types.contains(&5),
            nal_types,
        })
    }
}

#[derive(Debug, Default)]
struct EncodeCallbackState {
    callback_count: usize,
    status: Option<OSStatus>,
    info_flags: Option<u32>,
    sample_buffer_count: usize,
    sample_total_size_bytes: usize,
    block_buffer_data_bytes: usize,
    copied_sample_count: usize,
    copied_sample_bytes: usize,
    copied_sample_prefix: Vec<u8>,
    copied_sample_payload: Vec<u8>,
    copied_sample_avcc_nal_count: usize,
    copied_sample_avcc_payload_bytes: usize,
    copied_sample_avcc_nal_types: Vec<u8>,
    h264_parameter_set_count: usize,
    h264_parameter_set_copied_count: usize,
    h264_parameter_set_total_bytes: usize,
    h264_parameter_set_nal_unit_header_length: Option<i32>,
    h264_parameter_set_nal_types: Vec<u8>,
    h264_parameter_sets: Vec<Vec<u8>>,
    h264_parameter_set_error_status: Option<OSStatus>,
    sample_copy_error_status: Option<OSStatus>,
    frame_dropped: bool,
}

pub struct VideoToolboxH264Session {
    session: CFRetained<VTCompressionSession>,
    width: usize,
    height: usize,
    property_statuses: VideoToolboxRealtimePropertyStatuses,
}

impl VideoToolboxH264Session {
    pub fn new(width: usize, height: usize) -> Result<Self> {
        Self::new_realtime(width, height, 30, 60)
    }

    pub fn new_realtime(
        width: usize,
        height: usize,
        expected_frame_rate: i32,
        max_key_frame_interval: i32,
    ) -> Result<Self> {
        Self::new_realtime_configured(
            width,
            height,
            expected_frame_rate,
            max_key_frame_interval,
            None,
        )
    }

    pub fn new_realtime_with_bitrate(
        width: usize,
        height: usize,
        expected_frame_rate: i32,
        max_key_frame_interval: i32,
        average_bit_rate_bps: i64,
    ) -> Result<Self> {
        ensure!(
            average_bit_rate_bps > 0,
            "VideoToolbox average bit rate must be positive"
        );
        Self::new_realtime_configured(
            width,
            height,
            expected_frame_rate,
            max_key_frame_interval,
            Some(average_bit_rate_bps),
        )
    }

    fn new_realtime_configured(
        width: usize,
        height: usize,
        expected_frame_rate: i32,
        max_key_frame_interval: i32,
        average_bit_rate_bps: Option<i64>,
    ) -> Result<Self> {
        ensure!(width > 0, "VideoToolbox session width must be non-zero");
        ensure!(height > 0, "VideoToolbox session height must be non-zero");
        ensure!(
            expected_frame_rate > 0,
            "VideoToolbox expected frame rate must be positive"
        );
        ensure!(
            max_key_frame_interval > 0,
            "VideoToolbox max keyframe interval must be positive"
        );
        ensure!(
            width <= i32::MAX as usize && height <= i32::MAX as usize,
            "VideoToolbox session dimensions exceed i32 range: {width}x{height}"
        );

        let mut raw_session: *mut VTCompressionSession = ptr::null_mut();
        let status = unsafe {
            VTCompressionSession::create(
                None,
                width as i32,
                height as i32,
                kCMVideoCodecType_H264,
                None,
                None,
                None,
                None,
                ptr::null_mut(),
                NonNull::from(&mut raw_session),
            )
        };
        if status != NO_ERR {
            bail!("VTCompressionSessionCreate(H.264 {width}x{height}) failed with {status}");
        }
        let raw_session =
            NonNull::new(raw_session).context("VTCompressionSessionCreate returned null")?;
        let session = unsafe { CFRetained::from_raw(raw_session) };
        let mut session = Self {
            session,
            width,
            height,
            property_statuses: VideoToolboxRealtimePropertyStatuses {
                real_time: NO_ERR,
                allow_frame_reordering: NO_ERR,
                expected_frame_rate: NO_ERR,
                max_key_frame_interval: NO_ERR,
                average_bit_rate: None,
                prioritize_encoding_speed: NO_ERR,
                max_frame_delay_count: NO_ERR,
                expected_frame_rate_value: expected_frame_rate,
                max_key_frame_interval_value: max_key_frame_interval,
                average_bit_rate_value: average_bit_rate_bps,
                max_frame_delay_count_value: 1,
            },
        };
        session.property_statuses = session.configure_realtime_low_latency(
            expected_frame_rate,
            max_key_frame_interval,
            average_bit_rate_bps,
        )?;
        Ok(session)
    }

    pub fn prepare(&self) -> Result<VideoToolboxH264ProbeResult> {
        let status = unsafe { self.session.prepare_to_encode_frames() };
        if status != NO_ERR {
            bail!(
                "VTCompressionSessionPrepareToEncodeFrames(H.264 {}x{}) failed with {status}",
                self.width,
                self.height
            );
        }
        Ok(VideoToolboxH264ProbeResult::prepared(
            self.width,
            self.height,
            self.property_statuses,
            status,
        ))
    }

    pub fn encode_retained_target(
        &self,
        target: &MetalCompositorTargetPixelBuffer,
    ) -> Result<VideoToolboxH264ProbeResult> {
        self.encode_retained_target_with_timing(target, VideoToolboxFrameTiming::new(0, 60, 1, 60))
    }

    pub fn encode_retained_target_with_timing(
        &self,
        target: &MetalCompositorTargetPixelBuffer,
        timing: VideoToolboxFrameTiming,
    ) -> Result<VideoToolboxH264ProbeResult> {
        ensure!(
            timing.presentation_time_scale > 0 && timing.duration_time_scale > 0,
            "VideoToolbox CMTime scales must be positive"
        );
        let pixel_buffer = target.pixel_buffer();
        let width = CVPixelBufferGetWidth(pixel_buffer);
        let height = CVPixelBufferGetHeight(pixel_buffer);
        ensure!(
            width == self.width && height == self.height,
            "target dimensions {width}x{height} do not match VideoToolbox session {}x{}",
            self.width,
            self.height
        );
        let iosurface_backed = target.has_iosurface();
        ensure!(
            iosurface_backed,
            "retained Metal target is not IOSurface-backed"
        );

        let state = Arc::new(Mutex::new(EncodeCallbackState::default()));
        let callback_state = state.clone();
        let output_handler: RcBlock<dyn Fn(OSStatus, VTEncodeInfoFlags, *mut CMSampleBuffer)> =
            RcBlock::new(
                move |status: OSStatus,
                      info_flags: VTEncodeInfoFlags,
                      sample_buffer: *mut CMSampleBuffer| {
                    let mut state = callback_state
                        .lock()
                        .expect("encode callback state poisoned");
                    state.callback_count += 1;
                    state.status = Some(status);
                    state.info_flags = Some(info_flags.0);
                    if !sample_buffer.is_null() {
                        state.sample_buffer_count += 1;
                        let sample_buffer = unsafe { &*sample_buffer };
                        state.sample_total_size_bytes +=
                            unsafe { sample_buffer.total_sample_size() };
                        if let Some(data_buffer) = unsafe { sample_buffer.data_buffer() } {
                            state.block_buffer_data_bytes += unsafe { data_buffer.data_length() };
                        }
                        match copy_h264_parameter_sets(sample_buffer) {
                            Ok(parameter_sets) => {
                                state.h264_parameter_set_count =
                                    state.h264_parameter_set_count.max(parameter_sets.count);
                                state.h264_parameter_set_copied_count +=
                                    parameter_sets.copied_count;
                                state.h264_parameter_set_total_bytes += parameter_sets.total_bytes;
                                if state.h264_parameter_set_nal_unit_header_length.is_none() {
                                    state.h264_parameter_set_nal_unit_header_length =
                                        parameter_sets.nal_unit_header_length;
                                }
                                if state.h264_parameter_sets.is_empty() {
                                    state.h264_parameter_sets = parameter_sets.parameter_sets;
                                }
                                if state.h264_parameter_set_nal_types.is_empty() {
                                    state
                                        .h264_parameter_set_nal_types
                                        .extend_from_slice(&parameter_sets.nal_types);
                                }
                            }
                            Err(status) => {
                                state.h264_parameter_set_error_status = Some(status);
                            }
                        }
                        match copy_encoded_sample_buffer_bytes(sample_buffer) {
                            Ok(bytes) if !bytes.is_empty() => {
                                state.copied_sample_count += 1;
                                state.copied_sample_bytes += bytes.len();
                                if state.copied_sample_prefix.is_empty() {
                                    let prefix_len = bytes.len().min(16);
                                    state
                                        .copied_sample_prefix
                                        .extend_from_slice(&bytes[..prefix_len]);
                                }
                                if state.copied_sample_payload.is_empty() {
                                    state.copied_sample_payload = bytes.clone();
                                }
                                if let Some(header_len) = state
                                    .h264_parameter_set_nal_unit_header_length
                                    .and_then(|length| usize::try_from(length).ok())
                                    && let Some(avcc) = summarize_avcc_nal_units(&bytes, header_len)
                                {
                                    state.copied_sample_avcc_nal_count += avcc.nal_count;
                                    state.copied_sample_avcc_payload_bytes += avcc.payload_bytes;
                                    if state.copied_sample_avcc_nal_types.is_empty() {
                                        state
                                            .copied_sample_avcc_nal_types
                                            .extend_from_slice(&avcc.nal_types);
                                    }
                                }
                            }
                            Ok(_) => {}
                            Err(status) => {
                                state.sample_copy_error_status = Some(status);
                            }
                        }
                    }
                    state.frame_dropped |= info_flags.contains(VTEncodeInfoFlags::FrameDropped);
                },
            );

        let mut encode_info_flags = VTEncodeInfoFlags::empty();
        let presentation_time = unsafe {
            CMTime::new(
                timing.presentation_time_value,
                timing.presentation_time_scale,
            )
        };
        let duration = unsafe { CMTime::new(timing.duration_value, timing.duration_time_scale) };
        let encode_status = unsafe {
            self.session.encode_frame_with_output_handler(
                pixel_buffer,
                presentation_time,
                duration,
                None,
                &mut encode_info_flags,
                RcBlock::as_ptr(&output_handler),
            )
        };
        if encode_status != NO_ERR {
            bail!(
                "VTCompressionSessionEncodeFrameWithOutputHandler(H.264 {}x{}) failed with {encode_status}",
                self.width,
                self.height
            );
        }
        let complete_status = unsafe { self.session.complete_frames(kCMTimeInvalid) };
        if complete_status != NO_ERR {
            bail!(
                "VTCompressionSessionCompleteFrames(H.264 {}x{}) failed with {complete_status}",
                self.width,
                self.height
            );
        }

        let state = state.lock().expect("encode callback state poisoned");
        let annex_b_sample = state
            .h264_parameter_set_nal_unit_header_length
            .and_then(|length| usize::try_from(length).ok())
            .and_then(|header_len| {
                h264_avcc_sample_to_annex_b(
                    &state.h264_parameter_sets,
                    &state.copied_sample_payload,
                    header_len,
                    true,
                )
            })
            .unwrap_or_default();
        let annex_b_prefix_len = annex_b_sample.len().min(16);
        Ok(VideoToolboxH264ProbeResult {
            width,
            height,
            create_status: NO_ERR,
            property_statuses: self.property_statuses,
            frame_timing: Some(timing),
            prepare_status: NO_ERR,
            encode_status: Some(encode_status),
            complete_status: Some(complete_status),
            encode_info_flags: Some(encode_info_flags.0),
            callback_count: state.callback_count,
            callback_status: state.status,
            callback_info_flags: state.info_flags,
            sample_buffer_count: state.sample_buffer_count,
            sample_total_size_bytes: state.sample_total_size_bytes,
            block_buffer_data_bytes: state.block_buffer_data_bytes,
            copied_sample_count: state.copied_sample_count,
            copied_sample_bytes: state.copied_sample_bytes,
            copied_sample_prefix: state.copied_sample_prefix.clone(),
            copied_sample_payload: state.copied_sample_payload.clone(),
            copied_sample_avcc_nal_count: state.copied_sample_avcc_nal_count,
            copied_sample_avcc_payload_bytes: state.copied_sample_avcc_payload_bytes,
            copied_sample_avcc_nal_types: state.copied_sample_avcc_nal_types.clone(),
            h264_parameter_set_count: state.h264_parameter_set_count,
            h264_parameter_set_copied_count: state.h264_parameter_set_copied_count,
            h264_parameter_set_total_bytes: state.h264_parameter_set_total_bytes,
            h264_parameter_set_nal_unit_header_length: state
                .h264_parameter_set_nal_unit_header_length,
            h264_parameter_set_nal_types: state.h264_parameter_set_nal_types.clone(),
            h264_parameter_sets: state.h264_parameter_sets.clone(),
            h264_parameter_set_error_status: state.h264_parameter_set_error_status,
            annex_b_sample_bytes: annex_b_sample.len(),
            annex_b_sample_prefix: annex_b_sample[..annex_b_prefix_len].to_vec(),
            annex_b_sample,
            sample_copy_error_status: state.sample_copy_error_status,
            frame_dropped: state.frame_dropped
                || encode_info_flags.contains(VTEncodeInfoFlags::FrameDropped),
            iosurface_backed,
        })
    }

    pub fn encode_retained_target_annex_b_with_timing(
        &self,
        target: &MetalCompositorTargetPixelBuffer,
        timing: VideoToolboxFrameTiming,
    ) -> Result<VideoToolboxH264AnnexBFrame> {
        self.encode_retained_target_with_timing(target, timing)?
            .annex_b_frame()
            .context("VideoToolbox retained-target encode returned no Annex B frame")
    }

    pub fn submit_retained_target_annex_b_with_timing(
        &self,
        target: Arc<MetalCompositorTargetPixelBuffer>,
        timing: VideoToolboxFrameTiming,
        frame_index: u64,
        sender: mpsc::SyncSender<VideoToolboxH264AsyncAnnexBFrame>,
        rejected_frames: Arc<AtomicU64>,
    ) -> Result<()> {
        let pixel_buffer = target.pixel_buffer();
        let width = CVPixelBufferGetWidth(pixel_buffer);
        let height = CVPixelBufferGetHeight(pixel_buffer);
        ensure!(
            width == self.width && height == self.height,
            "target dimensions {width}x{height} do not match VideoToolbox session {}x{}",
            self.width,
            self.height
        );
        ensure!(
            target.has_iosurface(),
            "retained Metal target is not IOSurface-backed"
        );

        let presentation_time = unsafe {
            CMTime::new(
                timing.presentation_time_value,
                timing.presentation_time_scale,
            )
        };
        let duration = unsafe { CMTime::new(timing.duration_value, timing.duration_time_scale) };
        let retained_target = target.clone();
        let output_handler: RcBlock<dyn Fn(OSStatus, VTEncodeInfoFlags, *mut CMSampleBuffer)> =
            RcBlock::new(
                move |status: OSStatus,
                      info_flags: VTEncodeInfoFlags,
                      sample_buffer: *mut CMSampleBuffer| {
                    let _retained_target = &retained_target;
                    let result = async_annex_b_result_from_callback(
                        status,
                        info_flags,
                        sample_buffer,
                        timing,
                    );
                    send_bounded_async_annex_b_frame(
                        &sender,
                        &rejected_frames,
                        VideoToolboxH264AsyncAnnexBFrame {
                            frame_index,
                            result,
                        },
                    );
                },
            );

        let mut encode_info_flags = VTEncodeInfoFlags::empty();
        let encode_status = unsafe {
            self.session.encode_frame_with_output_handler(
                pixel_buffer,
                presentation_time,
                duration,
                None,
                &mut encode_info_flags,
                RcBlock::as_ptr(&output_handler),
            )
        };
        if encode_status != NO_ERR {
            bail!(
                "VTCompressionSessionEncodeFrameWithOutputHandler(H.264 {}x{}) failed with {encode_status}",
                self.width,
                self.height
            );
        }
        Ok(())
    }

    pub fn complete_pending_frames(&self) -> Result<()> {
        let complete_status = unsafe { self.session.complete_frames(kCMTimeInvalid) };
        if complete_status != NO_ERR {
            bail!(
                "VTCompressionSessionCompleteFrames(H.264 {}x{}) failed with {complete_status}",
                self.width,
                self.height
            );
        }
        Ok(())
    }

    fn configure_realtime_low_latency(
        &self,
        expected_frame_rate: i32,
        max_key_frame_interval: i32,
        average_bit_rate_bps: Option<i64>,
    ) -> Result<VideoToolboxRealtimePropertyStatuses> {
        let real_time = self.set_property(
            "RealTime",
            unsafe { kVTCompressionPropertyKey_RealTime },
            CFBoolean::new(true).as_ref(),
        )?;
        let allow_frame_reordering = self.set_property(
            "AllowFrameReordering",
            unsafe { kVTCompressionPropertyKey_AllowFrameReordering },
            CFBoolean::new(false).as_ref(),
        )?;
        let expected_frame_rate_value = CFNumber::new_i32(expected_frame_rate);
        let expected_frame_rate_status = self.set_property(
            "ExpectedFrameRate",
            unsafe { kVTCompressionPropertyKey_ExpectedFrameRate },
            expected_frame_rate_value.as_ref(),
        )?;
        let max_key_frame_interval_value = CFNumber::new_i32(max_key_frame_interval);
        let max_key_frame_interval_status = self.set_property(
            "MaxKeyFrameInterval",
            unsafe { kVTCompressionPropertyKey_MaxKeyFrameInterval },
            max_key_frame_interval_value.as_ref(),
        )?;
        let average_bit_rate = average_bit_rate_bps.map(|bit_rate| {
            let average_bit_rate_value = CFNumber::new_i64(bit_rate);
            self.set_property_status(
                unsafe { kVTCompressionPropertyKey_AverageBitRate },
                average_bit_rate_value.as_ref(),
            )
        });
        let prioritize_encoding_speed = self.set_property_status(
            unsafe { kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality },
            CFBoolean::new(true).as_ref(),
        );
        let max_frame_delay_count_value = 1;
        let max_frame_delay_count = self.set_property_status(
            unsafe { kVTCompressionPropertyKey_MaxFrameDelayCount },
            CFNumber::new_i32(max_frame_delay_count_value).as_ref(),
        );

        Ok(VideoToolboxRealtimePropertyStatuses {
            real_time,
            allow_frame_reordering,
            expected_frame_rate: expected_frame_rate_status,
            max_key_frame_interval: max_key_frame_interval_status,
            average_bit_rate,
            prioritize_encoding_speed,
            max_frame_delay_count,
            expected_frame_rate_value: expected_frame_rate,
            max_key_frame_interval_value: max_key_frame_interval,
            average_bit_rate_value: average_bit_rate_bps,
            max_frame_delay_count_value,
        })
    }

    fn set_property(
        &self,
        name: &str,
        property_key: &CFString,
        property_value: &CFType,
    ) -> Result<OSStatus> {
        let compression_session: &VTCompressionSession = &self.session;
        let session: &VTSession = compression_session.as_ref();
        let status = unsafe { VTSessionSetProperty(session, property_key, Some(property_value)) };
        if status != NO_ERR {
            bail!("VTSessionSetProperty({name}) failed with {status}");
        }
        Ok(status)
    }

    fn set_property_status(&self, property_key: &CFString, property_value: &CFType) -> OSStatus {
        let compression_session: &VTCompressionSession = &self.session;
        let session: &VTSession = compression_session.as_ref();
        unsafe { VTSessionSetProperty(session, property_key, Some(property_value)) }
    }
}

fn copy_encoded_sample_buffer_bytes(
    sample_buffer: &CMSampleBuffer,
) -> std::result::Result<Vec<u8>, OSStatus> {
    let Some(data_buffer) = (unsafe { sample_buffer.data_buffer() }) else {
        return Ok(Vec::new());
    };
    let data_len = unsafe { data_buffer.data_length() };
    if data_len == 0 {
        return Ok(Vec::new());
    }

    let mut bytes = vec![0u8; data_len];
    let destination = NonNull::new(bytes.as_mut_ptr().cast::<c_void>())
        .expect("non-empty Vec must expose a non-null pointer");
    let status = unsafe { data_buffer.copy_data_bytes(0, data_len, destination) };
    if status != NO_ERR {
        return Err(status);
    }
    Ok(bytes)
}

fn async_annex_b_result_from_callback(
    status: OSStatus,
    info_flags: VTEncodeInfoFlags,
    sample_buffer: *mut CMSampleBuffer,
    timing: VideoToolboxFrameTiming,
) -> std::result::Result<VideoToolboxH264AnnexBFrame, String> {
    if status != NO_ERR {
        return Err(format!("VideoToolbox encode callback failed with {status}"));
    }
    if info_flags.contains(VTEncodeInfoFlags::FrameDropped) {
        return Err("VideoToolbox dropped the encoded frame".to_string());
    }
    if sample_buffer.is_null() {
        return Err("VideoToolbox encode callback returned no sample buffer".to_string());
    }
    let sample_buffer = unsafe { &*sample_buffer };
    annex_b_frame_from_sample_buffer(sample_buffer, timing)
        .map_err(|error| format!("VideoToolbox sample conversion failed: {error}"))
}

fn annex_b_frame_from_sample_buffer(
    sample_buffer: &CMSampleBuffer,
    timing: VideoToolboxFrameTiming,
) -> std::result::Result<VideoToolboxH264AnnexBFrame, String> {
    let parameter_sets = copy_h264_parameter_sets(sample_buffer)
        .map_err(|status| format!("copy H.264 parameter sets failed with {status}"))?;
    let header_len = parameter_sets
        .nal_unit_header_length
        .and_then(|length| usize::try_from(length).ok())
        .ok_or_else(|| "missing H.264 NAL unit length header".to_string())?;
    let sample = copy_encoded_sample_buffer_bytes(sample_buffer)
        .map_err(|status| format!("copy H.264 sample bytes failed with {status}"))?;
    let bytes =
        h264_avcc_sample_to_annex_b(&parameter_sets.parameter_sets, &sample, header_len, true)
            .ok_or_else(|| "empty or invalid Annex B sample".to_string())?;
    let nal_types = annex_b_nal_types(&bytes);
    Ok(VideoToolboxH264AnnexBFrame {
        timing,
        is_idr: nal_types.contains(&5),
        bytes,
        nal_types,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct H264ParameterSetSummary {
    count: usize,
    copied_count: usize,
    total_bytes: usize,
    nal_unit_header_length: Option<i32>,
    nal_types: Vec<u8>,
    parameter_sets: Vec<Vec<u8>>,
}

fn copy_h264_parameter_sets(
    sample_buffer: &CMSampleBuffer,
) -> std::result::Result<H264ParameterSetSummary, OSStatus> {
    let Some(format_description) = (unsafe { sample_buffer.format_description() }) else {
        return Ok(H264ParameterSetSummary {
            count: 0,
            copied_count: 0,
            total_bytes: 0,
            nal_unit_header_length: None,
            nal_types: Vec::new(),
            parameter_sets: Vec::new(),
        });
    };

    let mut parameter_set_count = 0usize;
    let mut nal_unit_header_length: c_int = 0;
    let status = unsafe {
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format_description.as_ref(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut parameter_set_count,
            &mut nal_unit_header_length,
        )
    };
    if status != NO_ERR {
        return Err(status);
    }

    let mut copied_count = 0usize;
    let mut total_bytes = 0usize;
    let mut nal_types = Vec::new();
    let mut parameter_sets = Vec::new();
    for parameter_set_index in 0..parameter_set_count {
        let mut parameter_set_pointer: *const u8 = ptr::null();
        let mut parameter_set_size = 0usize;
        let mut ignored_count = 0usize;
        let mut ignored_header_length: c_int = 0;
        let status = unsafe {
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                format_description.as_ref(),
                parameter_set_index,
                &mut parameter_set_pointer,
                &mut parameter_set_size,
                &mut ignored_count,
                &mut ignored_header_length,
            )
        };
        if status != NO_ERR {
            return Err(status);
        }
        if parameter_set_pointer.is_null() || parameter_set_size == 0 {
            continue;
        }

        let parameter_set =
            unsafe { std::slice::from_raw_parts(parameter_set_pointer, parameter_set_size) };
        copied_count += 1;
        total_bytes += parameter_set.len();
        nal_types.push(parameter_set[0] & 0x1f);
        parameter_sets.push(parameter_set.to_vec());
    }

    Ok(H264ParameterSetSummary {
        count: parameter_set_count,
        copied_count,
        total_bytes,
        nal_unit_header_length: (nal_unit_header_length > 0).then_some(nal_unit_header_length),
        nal_types,
        parameter_sets,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AvccNalSummary {
    nal_count: usize,
    payload_bytes: usize,
    nal_types: Vec<u8>,
}

fn summarize_avcc_nal_units(bytes: &[u8], nal_unit_header_length: usize) -> Option<AvccNalSummary> {
    if bytes.is_empty() || !(1..=4).contains(&nal_unit_header_length) {
        return None;
    }

    let mut offset = 0usize;
    let mut nal_count = 0usize;
    let mut payload_bytes = 0usize;
    let mut nal_types = Vec::new();
    while offset < bytes.len() {
        if bytes.len().saturating_sub(offset) < nal_unit_header_length {
            return None;
        }
        let mut nal_size = 0usize;
        for byte in &bytes[offset..offset + nal_unit_header_length] {
            nal_size = (nal_size << 8) | usize::from(*byte);
        }
        offset += nal_unit_header_length;
        if nal_size == 0 || bytes.len().saturating_sub(offset) < nal_size {
            return None;
        }
        nal_count += 1;
        payload_bytes += nal_size;
        nal_types.push(bytes[offset] & 0x1f);
        offset += nal_size;
    }

    (nal_count > 0).then_some(AvccNalSummary {
        nal_count,
        payload_bytes,
        nal_types,
    })
}

pub fn h264_avcc_sample_to_annex_b(
    parameter_sets: &[Vec<u8>],
    sample: &[u8],
    nal_unit_header_length: usize,
    include_parameter_sets: bool,
) -> Option<Vec<u8>> {
    if sample.is_empty() || !(1..=4).contains(&nal_unit_header_length) {
        return None;
    }

    let mut annex_b = Vec::new();
    append_annex_b_access_unit_delimiter(&mut annex_b);
    if include_parameter_sets {
        for parameter_set in parameter_sets {
            if parameter_set.is_empty() {
                return None;
            }
            append_annex_b_nal(&mut annex_b, parameter_set);
        }
    }

    let mut offset = 0usize;
    while offset < sample.len() {
        if sample.len().saturating_sub(offset) < nal_unit_header_length {
            return None;
        }
        let mut nal_size = 0usize;
        for byte in &sample[offset..offset + nal_unit_header_length] {
            nal_size = (nal_size << 8) | usize::from(*byte);
        }
        offset += nal_unit_header_length;
        if nal_size == 0 || sample.len().saturating_sub(offset) < nal_size {
            return None;
        }
        append_annex_b_nal(&mut annex_b, &sample[offset..offset + nal_size]);
        offset += nal_size;
    }

    (!annex_b.is_empty()).then_some(annex_b)
}

fn append_annex_b_nal(output: &mut Vec<u8>, nal: &[u8]) {
    output.extend_from_slice(&[0, 0, 0, 1]);
    output.extend_from_slice(nal);
}

fn append_annex_b_access_unit_delimiter(output: &mut Vec<u8>) {
    // primary_pic_type 7 is valid for I/P/B/SI/SP slices and lets the raw H.264 demuxer
    // recover access-unit boundaries when packets arrive through a FIFO.
    append_annex_b_nal(output, &[0x09, 0xf0]);
}

fn annex_b_nal_types(bytes: &[u8]) -> Vec<u8> {
    let mut nal_types = Vec::new();
    let mut offset = 0usize;
    while let Some(start_code_offset) = find_annex_b_start_code(bytes, offset) {
        let nal_start = start_code_offset + 4;
        let nal_end = find_annex_b_start_code(bytes, nal_start).unwrap_or(bytes.len());
        if nal_start < nal_end {
            nal_types.push(bytes[nal_start] & 0x1f);
        }
        offset = nal_end;
    }
    nal_types
}

fn find_annex_b_start_code(bytes: &[u8], from: usize) -> Option<usize> {
    bytes
        .get(from..)?
        .windows(4)
        .position(|window| window == [0, 0, 0, 1])
        .map(|position| from + position)
}

impl Drop for VideoToolboxH264Session {
    fn drop(&mut self) {
        unsafe { self.session.invalidate() };
    }
}

#[allow(dead_code)]
pub fn probe_h264_session_ready(
    width: usize,
    height: usize,
) -> Result<VideoToolboxH264ProbeResult> {
    let session = VideoToolboxH264Session::new(width, height)?;
    session.prepare()
}

#[allow(dead_code)]
pub fn probe_h264_encode_retained_target(
    target: &MetalCompositorTargetPixelBuffer,
) -> Result<VideoToolboxH264ProbeResult> {
    let session = VideoToolboxH264Session::new(target.width(), target.height())?;
    let mut result = session.prepare()?;
    result.iosurface_backed = target.has_iosurface();
    let encode_result = session.encode_retained_target(target)?;
    Ok(VideoToolboxH264ProbeResult {
        prepare_status: result.prepare_status,
        iosurface_backed: result.iosurface_backed,
        ..encode_result
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metal_compositor::{GpuSource, GpuSourceKind, MetalSceneCompositor};

    #[test]
    fn bounded_async_output_rejects_without_blocking_and_counts_pressure() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let rejected_frames = AtomicU64::new(0);
        let frame = |frame_index| VideoToolboxH264AsyncAnnexBFrame {
            frame_index,
            result: Err("fixture".to_string()),
        };

        send_bounded_async_annex_b_frame(&sender, &rejected_frames, frame(1));
        send_bounded_async_annex_b_frame(&sender, &rejected_frames, frame(2));

        assert_eq!(
            receiver
                .try_recv()
                .expect("first frame remains queued")
                .frame_index,
            1
        );
        assert_eq!(rejected_frames.load(Ordering::Acquire), 1);
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn video_toolbox_h264_session_prepares_or_skips() {
        match probe_h264_session_ready(64, 64) {
            Ok(result) => {
                assert_eq!(result.width, 64);
                assert_eq!(result.height, 64);
                assert_eq!(result.create_status, NO_ERR);
                assert_eq!(result.property_statuses.real_time, NO_ERR);
                assert_eq!(result.property_statuses.allow_frame_reordering, NO_ERR);
                assert_eq!(result.property_statuses.expected_frame_rate, NO_ERR);
                assert_eq!(result.property_statuses.max_key_frame_interval, NO_ERR);
                assert_eq!(result.property_statuses.expected_frame_rate_value, 30);
                assert_eq!(result.property_statuses.max_key_frame_interval_value, 60);
                assert_eq!(result.prepare_status, NO_ERR);
            }
            Err(error) => {
                eprintln!("skipping: VideoToolbox H.264 session unavailable: {error:#}");
            }
        }
    }

    #[test]
    fn video_toolbox_accepts_retained_metal_target_or_skips() {
        let Some(mut compositor) = MetalSceneCompositor::new() else {
            eprintln!("skipping: no Metal device available in this environment");
            return;
        };
        let red = [0u8, 0, 255, 255];
        let sources = [GpuSource {
            kind: GpuSourceKind::Image,
            bgra: &red,
            content_key: None,
            iosurface: None,
            pixel_buffer: None,
            width: 1,
            height: 1,
            dest: [0.0, 0.0, 1.0, 1.0],
            crop: [0.0; 4],
            mirror: false,
            mask: crate::metal_compositor::SourceMask::None,
            blend: false,
            chroma_key: None,
        }];
        compositor
            .compose_bgra(64, 64, [0.0, 0.0, 0.0, 1.0], &sources)
            .expect("compose retained Metal target");
        let Some(target) = compositor.latest_target_pixel_buffer() else {
            eprintln!("skipping: IOSurface-backed Metal target unavailable");
            return;
        };

        match probe_h264_encode_retained_target(&target) {
            Ok(result) => {
                assert_eq!(result.width, 64);
                assert_eq!(result.height, 64);
                assert_eq!(result.create_status, NO_ERR);
                assert_eq!(result.property_statuses.real_time, NO_ERR);
                assert_eq!(result.property_statuses.allow_frame_reordering, NO_ERR);
                assert_eq!(result.property_statuses.expected_frame_rate, NO_ERR);
                assert_eq!(result.property_statuses.max_key_frame_interval, NO_ERR);
                assert_eq!(result.prepare_status, NO_ERR);
                assert_eq!(result.encode_status, Some(NO_ERR));
                assert_eq!(result.complete_status, Some(NO_ERR));
                assert!(result.iosurface_backed);
                assert!(
                    !result.frame_dropped,
                    "VideoToolbox dropped the retained target frame: {result:?}"
                );
                assert!(
                    result.callback_count > 0,
                    "VideoToolbox did not invoke the encode callback: {result:?}"
                );
                assert_eq!(result.callback_status, Some(NO_ERR));
                assert!(
                    result.sample_buffer_count > 0,
                    "VideoToolbox accepted the frame but returned no sample buffer: {result:?}"
                );
                assert!(
                    result.sample_total_size_bytes > 0,
                    "VideoToolbox sample buffer had no encoded sample bytes: {result:?}"
                );
                assert!(
                    result.block_buffer_data_bytes > 0,
                    "VideoToolbox sample buffer had no accessible CMBlockBuffer bytes: {result:?}"
                );
                assert_eq!(result.sample_copy_error_status, None);
                assert!(
                    result.copied_sample_count > 0,
                    "VideoToolbox sample bytes were not copied from CMBlockBuffer: {result:?}"
                );
                assert!(
                    result.copied_sample_bytes > 0,
                    "VideoToolbox copied sample byte count stayed at zero: {result:?}"
                );
                assert!(
                    !result.copied_sample_prefix.is_empty(),
                    "VideoToolbox copied sample prefix is empty: {result:?}"
                );
                assert_h264_muxable_probe_result(&result);
            }
            Err(error) => {
                eprintln!(
                    "skipping: VideoToolbox could not encode retained Metal target: {error:#}"
                );
            }
        }
    }

    #[test]
    fn video_toolbox_encodes_retained_target_sequence_with_monotonic_timestamps_or_skips() {
        let Some(mut compositor) = MetalSceneCompositor::new() else {
            eprintln!("skipping: no Metal device available in this environment");
            return;
        };
        let session = match VideoToolboxH264Session::new_realtime(64, 64, 30, 60) {
            Ok(session) => session,
            Err(error) => {
                eprintln!("skipping: VideoToolbox H.264 session unavailable: {error:#}");
                return;
            }
        };
        if let Err(error) = session.prepare() {
            eprintln!("skipping: VideoToolbox H.264 session could not prepare: {error:#}");
            return;
        }

        let colors = [[0u8, 0, 255, 255], [0u8, 255, 0, 255]];
        let mut copied_sequence_bytes = 0usize;
        for (frame_index, color) in colors.iter().enumerate() {
            let sources = [GpuSource {
                kind: GpuSourceKind::Image,
                bgra: color,
                content_key: None,
                iosurface: None,
                pixel_buffer: None,
                width: 1,
                height: 1,
                dest: [0.0, 0.0, 1.0, 1.0],
                crop: [0.0; 4],
                mirror: false,
                mask: crate::metal_compositor::SourceMask::None,
                blend: false,
                chroma_key: None,
            }];
            compositor
                .compose_bgra(64, 64, [0.0, 0.0, 0.0, 1.0], &sources)
                .expect("compose retained Metal target");
            let Some(target) = compositor.latest_target_pixel_buffer() else {
                eprintln!("skipping: IOSurface-backed Metal target unavailable");
                return;
            };
            let timing = VideoToolboxFrameTiming::frame_index(frame_index as i64, 30)
                .expect("valid frame timing");
            let result = match session.encode_retained_target_with_timing(&target, timing) {
                Ok(result) => result,
                Err(error) => {
                    eprintln!(
                        "skipping: VideoToolbox could not encode retained Metal target sequence: {error:#}"
                    );
                    return;
                }
            };

            assert_eq!(result.frame_timing, Some(timing));
            assert_eq!(result.encode_status, Some(NO_ERR));
            assert_eq!(result.complete_status, Some(NO_ERR));
            assert_eq!(result.callback_status, Some(NO_ERR));
            assert!(
                !result.frame_dropped,
                "VideoToolbox dropped frame {frame_index}: {result:?}"
            );
            assert!(
                result.copied_sample_bytes > 0,
                "VideoToolbox copied no sample bytes for frame {frame_index}: {result:?}"
            );
            assert_h264_muxable_probe_result(&result);
            copied_sequence_bytes += result.copied_sample_bytes;
        }

        assert!(
            copied_sequence_bytes > 0,
            "VideoToolbox sequence copied no encoded bytes"
        );
    }

    #[test]
    fn avcc_summary_parses_length_prefixed_nal_units() {
        let bytes = [
            0, 0, 0, 2, 0x65, 0xaa, // IDR slice
            0, 0, 0, 1, 0x41, // non-IDR slice
        ];
        let summary = summarize_avcc_nal_units(&bytes, 4).expect("valid AVCC summary");

        assert_eq!(summary.nal_count, 2);
        assert_eq!(summary.payload_bytes, 3);
        assert_eq!(summary.nal_types, [5, 1]);
        assert!(summarize_avcc_nal_units(&bytes[..bytes.len() - 1], 4).is_none());
    }

    #[test]
    fn avcc_sample_converts_to_annex_b_with_parameter_sets() {
        let parameter_sets = vec![vec![0x67, 0x42, 0x00], vec![0x68, 0xce]];
        let sample = [
            0, 0, 0, 2, 0x65, 0xaa, // IDR slice
            0, 0, 0, 1, 0x41, // non-IDR slice
        ];
        let annex_b =
            h264_avcc_sample_to_annex_b(&parameter_sets, &sample, 4, true).expect("annex b");

        assert_eq!(
            annex_b,
            [
                0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x67, 0x42, 0x00, 0, 0, 0, 1, 0x68, 0xce, 0, 0,
                0, 1, 0x65, 0xaa, 0, 0, 0, 1, 0x41,
            ]
        );
        assert_eq!(annex_b_nal_types(&annex_b), [9, 7, 8, 5, 1]);
        assert!(
            h264_avcc_sample_to_annex_b(&parameter_sets, &sample[..sample.len() - 1], 4, true)
                .is_none()
        );
    }

    #[test]
    fn video_toolbox_returns_annex_b_frame_for_retained_target_or_skips() {
        let Some(mut compositor) = MetalSceneCompositor::new() else {
            eprintln!("skipping: no Metal device available in this environment");
            return;
        };
        let blue = [255u8, 0, 0, 255];
        let sources = [GpuSource {
            kind: GpuSourceKind::Image,
            bgra: &blue,
            content_key: None,
            iosurface: None,
            pixel_buffer: None,
            width: 1,
            height: 1,
            dest: [0.0, 0.0, 1.0, 1.0],
            crop: [0.0; 4],
            mirror: false,
            mask: crate::metal_compositor::SourceMask::None,
            blend: false,
            chroma_key: None,
        }];
        compositor
            .compose_bgra(64, 64, [0.0, 0.0, 0.0, 1.0], &sources)
            .expect("compose retained Metal target");
        let Some(target) = compositor.latest_target_pixel_buffer() else {
            eprintln!("skipping: IOSurface-backed Metal target unavailable");
            return;
        };
        let session = match VideoToolboxH264Session::new_realtime(64, 64, 30, 60) {
            Ok(session) => session,
            Err(error) => {
                eprintln!("skipping: VideoToolbox H.264 session unavailable: {error:#}");
                return;
            }
        };
        if let Err(error) = session.prepare() {
            eprintln!("skipping: VideoToolbox H.264 session could not prepare: {error:#}");
            return;
        }
        let timing = VideoToolboxFrameTiming::frame_index(0, 30).expect("valid timing");
        let frame = match session.encode_retained_target_annex_b_with_timing(&target, timing) {
            Ok(frame) => frame,
            Err(error) => {
                eprintln!("skipping: VideoToolbox could not return Annex B frame: {error:#}");
                return;
            }
        };

        assert_eq!(frame.timing, timing);
        assert!(frame.bytes.starts_with(&[0, 0, 0, 1]));
        assert!(frame.nal_types.contains(&7), "missing SPS: {frame:?}");
        assert!(frame.nal_types.contains(&8), "missing PPS: {frame:?}");
        assert_eq!(frame.is_idr, frame.nal_types.contains(&5));
        assert!(
            frame
                .nal_types
                .iter()
                .any(|nal_type| *nal_type == 5 || *nal_type == 1),
            "missing coded slice: {frame:?}"
        );
    }

    fn assert_h264_muxable_probe_result(result: &VideoToolboxH264ProbeResult) {
        assert_eq!(result.h264_parameter_set_error_status, None);
        assert!(
            result.h264_parameter_set_count >= 2,
            "VideoToolbox returned too few H.264 parameter sets: {result:?}"
        );
        assert!(
            result.h264_parameter_set_copied_count >= 2,
            "VideoToolbox copied too few H.264 parameter sets: {result:?}"
        );
        assert!(
            result.h264_parameter_set_total_bytes > 0,
            "VideoToolbox H.264 parameter sets were empty: {result:?}"
        );
        assert!(
            matches!(
                result.h264_parameter_set_nal_unit_header_length,
                Some(1..=4)
            ),
            "VideoToolbox did not report a usable H.264 NAL length header: {result:?}"
        );
        assert!(
            result.h264_parameter_set_nal_types.contains(&7),
            "VideoToolbox H.264 parameter sets did not include SPS: {result:?}"
        );
        assert!(
            result.h264_parameter_set_nal_types.contains(&8),
            "VideoToolbox H.264 parameter sets did not include PPS: {result:?}"
        );
        assert!(
            result.h264_parameter_sets.len() >= 2,
            "VideoToolbox did not retain copied SPS/PPS bytes: {result:?}"
        );
        assert!(
            result.copied_sample_avcc_nal_count > 0,
            "VideoToolbox copied sample was not parsed as AVCC NAL units: {result:?}"
        );
        assert!(
            !result.copied_sample_payload.is_empty(),
            "VideoToolbox did not retain copied sample payload bytes: {result:?}"
        );
        assert!(
            result.copied_sample_avcc_payload_bytes > 0,
            "VideoToolbox AVCC sample payload was empty: {result:?}"
        );
        assert!(
            !result.copied_sample_avcc_nal_types.is_empty(),
            "VideoToolbox AVCC sample NAL types were empty: {result:?}"
        );
        assert!(
            result.annex_b_sample_bytes > result.copied_sample_avcc_payload_bytes,
            "VideoToolbox Annex B sample did not include start codes and parameter sets: {result:?}"
        );
        assert!(
            result.annex_b_sample_prefix.starts_with(&[0, 0, 0, 1]),
            "VideoToolbox Annex B sample did not start with a start code: {result:?}"
        );
        assert!(
            !result.annex_b_sample.is_empty(),
            "VideoToolbox did not retain Annex B sample bytes: {result:?}"
        );
        let annex_b_frame = result.annex_b_frame().expect("Annex B frame");
        assert_eq!(annex_b_frame.bytes.len(), result.annex_b_sample_bytes);
        assert_eq!(annex_b_frame.is_idr, annex_b_frame.nal_types.contains(&5));
        assert!(
            annex_b_frame.nal_types.contains(&7),
            "VideoToolbox Annex B frame did not include SPS: {result:?}"
        );
        assert!(
            annex_b_frame.nal_types.contains(&8),
            "VideoToolbox Annex B frame did not include PPS: {result:?}"
        );
    }
}
