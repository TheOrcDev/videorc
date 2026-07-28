//! Hardware-only Windows Media Foundation H.264 encoder used by the compositor
//! bridge. All COM and Media Foundation objects stay on the creating MTA
//! thread; callers pass retained compositor bytes into `encode_frame`.

use std::collections::VecDeque;
use std::mem::ManuallyDrop;
use std::ptr;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail, ensure};
use windows::Win32::Foundation::VARIANT_BOOL;
use windows::Win32::Media::MediaFoundation::{
    CODECAPI_AVEncCommonLowLatency, CODECAPI_AVEncCommonMeanBitRate,
    CODECAPI_AVEncCommonRateControlMode, CODECAPI_AVEncCommonRealTime,
    CODECAPI_AVEncMPVDefaultBPictureCount, CODECAPI_AVEncMPVGOPSize, ICodecAPI, IMF2DBuffer2,
    IMFActivate, IMFMediaBuffer, IMFMediaEventGenerator, IMFSample, IMFTransform,
    METransformDrainComplete, METransformHaveOutput, METransformNeedInput,
    MF_E_NO_EVENTS_AVAILABLE, MF_EVENT_FLAG_NO_WAIT, MF_LOW_LATENCY, MF_MT_ALL_SAMPLES_INDEPENDENT,
    MF_MT_AVG_BITRATE, MF_MT_FIXED_SIZE_SAMPLES, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE,
    MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_MAX_KEYFRAME_SPACING, MF_MT_MPEG_SEQUENCE_HEADER,
    MF_MT_MPEG2_PROFILE, MF_MT_SUBTYPE, MF_TRANSFORM_ASYNC, MF_TRANSFORM_ASYNC_UNLOCK, MF_VERSION,
    MF2DBuffer_LockFlags_Write, MFCreate2DMediaBuffer, MFCreateMediaType, MFCreateMemoryBuffer,
    MFCreateSample, MFMediaType_Video, MFSTARTUP_FULL, MFShutdown, MFStartup,
    MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG, MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SORTANDFILTER,
    MFT_FRIENDLY_NAME_Attribute, MFT_MESSAGE_COMMAND_DRAIN, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
    MFT_MESSAGE_NOTIFY_END_OF_STREAM, MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_OUTPUT_DATA_BUFFER,
    MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES, MFT_OUTPUT_STREAM_PROVIDES_SAMPLES,
    MFT_REGISTER_TYPE_INFO, MFTEnumEx, MFVideoFormat_H264, MFVideoFormat_I420, MFVideoFormat_NV12,
    MFVideoInterlace_Progressive, eAVEncCommonRateControlMode_CBR, eAVEncH264VProfile_High,
};
use windows::Win32::System::Com::{
    COINIT_MULTITHREADED, CoInitializeEx, CoTaskMemFree, CoUninitialize,
};
use windows::Win32::System::Variant::{
    VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_BOOL, VT_UI4,
};
use windows::core::Interface;

const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(1);
const EVENT_TIMEOUT: Duration = Duration::from_secs(3);
pub const DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MediaFoundationInputSubtype {
    I420,
    Nv12,
}

impl MediaFoundationInputSubtype {
    pub const fn label(self) -> &'static str {
        match self {
            Self::I420 => "I420",
            Self::Nv12 => "NV12",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MediaFoundationEncoderConfig {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub low_latency: bool,
}

impl MediaFoundationEncoderConfig {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.width > 0
                && self.height > 0
                && self.width.is_multiple_of(2)
                && self.height.is_multiple_of(2),
            "Media Foundation H.264 requires non-zero even dimensions, got {}x{}",
            self.width,
            self.height
        );
        ensure!(self.fps > 0, "Media Foundation H.264 FPS must be positive");
        ensure!(
            self.bitrate_kbps > 0,
            "Media Foundation H.264 bitrate must be positive"
        );
        Ok(())
    }

    pub fn profile_label(&self) -> String {
        format!(
            "{}x{}@{} {}kbps",
            self.width, self.height, self.fps, self.bitrate_kbps
        )
    }

    fn i420_len(&self) -> Result<usize> {
        let pixels = u64::from(self.width)
            .checked_mul(u64::from(self.height))
            .context("Media Foundation I420 frame size overflowed")?;
        usize::try_from(pixels + pixels / 2)
            .context("Media Foundation I420 frame size does not fit memory")
    }
}

#[derive(Debug, Clone)]
pub struct MediaFoundationEncodedFrame {
    pub frame_index: u64,
    pub pts_100ns: i64,
    pub duration_100ns: i64,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct MediaFoundationProbe {
    pub encoder_identity: String,
    pub input_subtype: MediaFoundationInputSubtype,
    pub frames: Vec<MediaFoundationEncodedFrame>,
}

pub struct MediaFoundationH264Encoder {
    config: MediaFoundationEncoderConfig,
    activation: ManuallyDrop<IMFActivate>,
    transform: ManuallyDrop<IMFTransform>,
    events: ManuallyDrop<IMFMediaEventGenerator>,
    identity: String,
    input_subtype: MediaFoundationInputSubtype,
    sequence_header: Vec<u8>,
    submitted_pts: VecDeque<i64>,
    last_output_pts: Option<i64>,
    input_credits: usize,
    saw_first_idr: bool,
    drained: bool,
    mf_started: bool,
    com_started: bool,
}

impl MediaFoundationH264Encoder {
    /// Creates and configures the highest-merit hardware H.264 MFT. Call this
    /// only from the dedicated encoder thread that will own the session.
    pub fn new(config: MediaFoundationEncoderConfig) -> Result<Self> {
        config.validate()?;
        let profile = config.profile_label();
        unsafe {
            let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            if hr.is_err() {
                return Err(stage_error(
                    "com-initialize",
                    hr,
                    "<not-enumerated>",
                    None,
                    &profile,
                ));
            }
            if let Err(error) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                CoUninitialize();
                return Err(stage_windows_error(
                    "mf-startup",
                    &error,
                    "<not-enumerated>",
                    None,
                    &profile,
                ));
            }
        }

        let result = Self::create_after_startup(config.clone(), true, true);
        if result.is_err() {
            unsafe {
                let _ = MFShutdown();
                CoUninitialize();
            }
        }
        result
    }

    fn create_after_startup(
        config: MediaFoundationEncoderConfig,
        com_started: bool,
        mf_started: bool,
    ) -> Result<Self> {
        let profile = config.profile_label();
        let activations = enumerate_hardware_h264_activations(&profile)?;
        let mut failures = Vec::new();
        for activation in activations {
            let identity = activation_name(&activation)
                .unwrap_or_else(|_| "<unnamed hardware H.264 MFT>".to_string());
            match unsafe { activation.ActivateObject::<IMFTransform>() } {
                Ok(transform) => {
                    match Self::configure_transform(
                        config.clone(),
                        activation,
                        transform,
                        identity.clone(),
                        com_started,
                        mf_started,
                    ) {
                        Ok(encoder) => return Ok(encoder),
                        Err(error) => failures.push(error.to_string()),
                    }
                }
                Err(error) => failures.push(
                    stage_windows_error("activate", &error, &identity, None, &profile).to_string(),
                ),
            }
        }
        bail!(
            "Media Foundation hardware H.264 probe rejected every activation for {profile}: {}",
            failures.join(" | ")
        )
    }

    fn configure_transform(
        config: MediaFoundationEncoderConfig,
        activation: IMFActivate,
        transform: IMFTransform,
        identity: String,
        com_started: bool,
        mf_started: bool,
    ) -> Result<Self> {
        let profile = config.profile_label();
        let attributes = unsafe {
            transform.GetAttributes().map_err(|error| {
                stage_windows_error(
                    "get-transform-attributes",
                    &error,
                    &identity,
                    None,
                    &profile,
                )
            })?
        };
        let asynchronous = unsafe { attributes.GetUINT32(&MF_TRANSFORM_ASYNC) }.unwrap_or(0);
        ensure!(
            asynchronous != 0,
            "Media Foundation probe stage=async-contract encoder={identity:?} input=<unset> profile={profile}: hardware activation did not advertise an asynchronous MFT"
        );
        unsafe {
            attributes
                .SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)
                .map_err(|error| {
                    stage_windows_error("async-unlock", &error, &identity, None, &profile)
                })?;
            let _ = attributes.SetUINT32(&MF_LOW_LATENCY, u32::from(config.low_latency));
        }

        let output_type = create_video_type(
            &config,
            MFVideoFormat_H264,
            Some(eAVEncH264VProfile_High.0 as u32),
        )
        .map_err(|error| anyhow!("Media Foundation output type for {profile}: {error}"))?;
        unsafe {
            transform
                .SetOutputType(0, &output_type, 0)
                .map_err(|error| {
                    stage_windows_error("set-output-type", &error, &identity, None, &profile)
                })?;
        }

        let mut selected = None;
        let mut input_failures = Vec::new();
        for (subtype, guid) in [
            (MediaFoundationInputSubtype::I420, MFVideoFormat_I420),
            (MediaFoundationInputSubtype::Nv12, MFVideoFormat_NV12),
        ] {
            let input_type = create_video_type(&config, guid, None)?;
            match unsafe { transform.SetInputType(0, &input_type, 0) } {
                Ok(()) => {
                    selected = Some(subtype);
                    break;
                }
                Err(error) => input_failures.push(format!(
                    "{} HRESULT=0x{:08X}",
                    subtype.label(),
                    error.code().0 as u32
                )),
            }
        }
        let input_subtype = selected.with_context(|| {
            format!(
                "Media Foundation probe stage=set-input-type encoder={identity:?} input=I420/NV12 profile={profile}: {}",
                input_failures.join(", ")
            )
        })?;
        configure_codec_api(&transform, &config, &identity, input_subtype)?;
        let events: IMFMediaEventGenerator = transform.cast().map_err(|error| {
            stage_windows_error(
                "event-generator",
                &error,
                &identity,
                Some(input_subtype),
                &profile,
            )
        })?;
        unsafe {
            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                .map_err(|error| {
                    stage_windows_error(
                        "begin-streaming",
                        &error,
                        &identity,
                        Some(input_subtype),
                        &profile,
                    )
                })?;
            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                .map_err(|error| {
                    stage_windows_error(
                        "start-stream",
                        &error,
                        &identity,
                        Some(input_subtype),
                        &profile,
                    )
                })?;
        }
        let sequence_header = media_type_sequence_header(&output_type).unwrap_or_default();
        Ok(Self {
            config,
            activation: ManuallyDrop::new(activation),
            transform: ManuallyDrop::new(transform),
            events: ManuallyDrop::new(events),
            identity,
            input_subtype,
            sequence_header,
            submitted_pts: VecDeque::new(),
            last_output_pts: None,
            input_credits: 0,
            saw_first_idr: false,
            drained: false,
            mf_started,
            com_started,
        })
    }

    pub fn identity(&self) -> &str {
        &self.identity
    }

    pub const fn input_subtype(&self) -> MediaFoundationInputSubtype {
        self.input_subtype
    }

    pub fn pending_frame_count(&self) -> usize {
        self.submitted_pts.len()
    }

    pub fn encode_frame(
        &mut self,
        i420: &[u8],
        frame_index: u64,
    ) -> Result<Vec<MediaFoundationEncodedFrame>> {
        ensure!(
            !self.drained,
            "Media Foundation encoder {} was already drained",
            self.identity
        );
        ensure!(
            i420.len() == self.config.i420_len()?,
            "Media Foundation encoder {} expected {} I420 bytes, got {}",
            self.identity,
            self.config.i420_len()?,
            i420.len()
        );
        let mut output = self.wait_for_input_credit(EVENT_TIMEOUT)?;
        let pts = scheduled_time_100ns(frame_index, self.config.fps)?;
        let duration = scheduled_duration_100ns(frame_index, self.config.fps)?;
        let sample = create_input_sample(
            i420,
            self.input_subtype,
            self.config.width,
            self.config.height,
            pts,
            duration,
        )
        .map_err(|error| {
            anyhow!(
                "Media Foundation probe stage=create-input-sample encoder={:?} input={} profile={}: {error}",
                self.identity,
                self.input_subtype.label(),
                self.config.profile_label()
            )
        })?;
        unsafe {
            self.transform
                .ProcessInput(0, &sample, 0)
                .map_err(|error| {
                    stage_windows_error(
                        "process-input",
                        &error,
                        &self.identity,
                        Some(self.input_subtype),
                        &self.config.profile_label(),
                    )
                })?;
        }
        self.submitted_pts.push_back(pts);
        self.input_credits = self.input_credits.saturating_sub(1);
        output.extend(self.collect_available_events()?);
        Ok(output)
    }

    pub fn drain(&mut self, timeout: Duration) -> Result<Vec<MediaFoundationEncodedFrame>> {
        if self.drained {
            return Ok(Vec::new());
        }
        unsafe {
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0)
                .map_err(|error| {
                    stage_windows_error(
                        "end-of-stream",
                        &error,
                        &self.identity,
                        Some(self.input_subtype),
                        &self.config.profile_label(),
                    )
                })?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0)
                .map_err(|error| {
                    stage_windows_error(
                        "drain-command",
                        &error,
                        &self.identity,
                        Some(self.input_subtype),
                        &self.config.profile_label(),
                    )
                })?;
        }
        let deadline = Instant::now() + timeout;
        let mut output = Vec::new();
        let mut drain_complete = false;
        while Instant::now() < deadline {
            match self.next_event()? {
                Some(event_type) if event_type == METransformHaveOutput.0 as u32 => {
                    output.push(self.process_one_output()?);
                }
                Some(event_type) if event_type == METransformDrainComplete.0 as u32 => {
                    drain_complete = true;
                    break;
                }
                Some(_) => {}
                None => thread::sleep(EVENT_POLL_INTERVAL),
            }
        }
        ensure!(
            drain_complete && self.submitted_pts.is_empty(),
            "Media Foundation probe stage=drain encoder={:?} input={} profile={}: bounded drain did not complete in {}ms (pending timestamps={})",
            self.identity,
            self.input_subtype.label(),
            self.config.profile_label(),
            timeout.as_millis(),
            self.submitted_pts.len()
        );
        self.drained = true;
        Ok(output)
    }

    fn wait_for_input_credit(
        &mut self,
        timeout: Duration,
    ) -> Result<Vec<MediaFoundationEncodedFrame>> {
        if self.input_credits > 0 {
            return Ok(Vec::new());
        }
        let deadline = Instant::now() + timeout;
        let mut output = Vec::new();
        while Instant::now() < deadline {
            match self.next_event()? {
                Some(event_type) if event_type == METransformNeedInput.0 as u32 => {
                    self.input_credits = self.input_credits.saturating_add(1);
                    return Ok(output);
                }
                Some(event_type) if event_type == METransformHaveOutput.0 as u32 => {
                    output.push(self.process_one_output()?);
                }
                Some(_) => {}
                None => thread::sleep(EVENT_POLL_INTERVAL),
            }
        }
        bail!(
            "Media Foundation probe stage=need-input encoder={:?} input={} profile={}: no input credit within {}ms",
            self.identity,
            self.input_subtype.label(),
            self.config.profile_label(),
            timeout.as_millis()
        )
    }

    fn collect_available_events(&mut self) -> Result<Vec<MediaFoundationEncodedFrame>> {
        let mut output = Vec::new();
        while let Some(event_type) = self.next_event()? {
            if event_type == METransformHaveOutput.0 as u32 {
                output.push(self.process_one_output()?);
            } else if event_type == METransformNeedInput.0 as u32 {
                self.input_credits = self.input_credits.saturating_add(1);
            }
        }
        Ok(output)
    }

    fn next_event(&self) -> Result<Option<u32>> {
        let event = match unsafe { self.events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
            Ok(event) => event,
            Err(error) if error.code() == MF_E_NO_EVENTS_AVAILABLE => return Ok(None),
            Err(error) => {
                return Err(stage_windows_error(
                    "get-event",
                    &error,
                    &self.identity,
                    Some(self.input_subtype),
                    &self.config.profile_label(),
                ));
            }
        };
        let status = unsafe { event.GetStatus() }.map_err(|error| {
            stage_windows_error(
                "event-status",
                &error,
                &self.identity,
                Some(self.input_subtype),
                &self.config.profile_label(),
            )
        })?;
        if status.is_err() {
            return Err(stage_error(
                "event-status",
                status,
                &self.identity,
                Some(self.input_subtype),
                &self.config.profile_label(),
            ));
        }
        unsafe { event.GetType() }
            .map_err(|error| {
                stage_windows_error(
                    "event-type",
                    &error,
                    &self.identity,
                    Some(self.input_subtype),
                    &self.config.profile_label(),
                )
            })
            .map(Some)
    }

    fn process_one_output(&mut self) -> Result<MediaFoundationEncodedFrame> {
        let stream_info = unsafe { self.transform.GetOutputStreamInfo(0) }.map_err(|error| {
            stage_windows_error(
                "output-stream-info",
                &error,
                &self.identity,
                Some(self.input_subtype),
                &self.config.profile_label(),
            )
        })?;
        let transform_provides_sample = stream_info.dwFlags
            & ((MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0)
                as u32)
            != 0;
        let supplied_sample = if transform_provides_sample {
            None
        } else {
            let sample = unsafe { MFCreateSample() }?;
            let buffer = unsafe { MFCreateMemoryBuffer(stream_info.cbSize.max(1)) }?;
            unsafe { sample.AddBuffer(&buffer) }?;
            Some(sample)
        };
        let mut output_buffer = MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            pSample: ManuallyDrop::new(supplied_sample),
            dwStatus: 0,
            pEvents: ManuallyDrop::new(None),
        };
        let mut status = 0_u32;
        let process_result = unsafe {
            self.transform
                .ProcessOutput(0, std::slice::from_mut(&mut output_buffer), &mut status)
        };
        let sample = unsafe { ManuallyDrop::take(&mut output_buffer.pSample) };
        let _events = unsafe { ManuallyDrop::take(&mut output_buffer.pEvents) };
        process_result.map_err(|error| {
            stage_windows_error(
                "process-output",
                &error,
                &self.identity,
                Some(self.input_subtype),
                &self.config.profile_label(),
            )
        })?;
        let sample = sample.context("Media Foundation HaveOutput event returned no sample")?;
        let pts = unsafe { sample.GetSampleTime() }.map_err(|error| {
            stage_windows_error(
                "output-timestamp",
                &error,
                &self.identity,
                Some(self.input_subtype),
                &self.config.profile_label(),
            )
        })?;
        let expected_pts = self.submitted_pts.pop_front().with_context(|| {
            format!(
                "Media Foundation encoder {:?} produced output without a submitted timestamp",
                self.identity
            )
        })?;
        ensure!(
            pts == expected_pts,
            "Media Foundation probe stage=timestamp-order encoder={:?} input={} profile={}: expected PTS {}, got {} (reordered/B-frame-dependent output)",
            self.identity,
            self.input_subtype.label(),
            self.config.profile_label(),
            expected_pts,
            pts
        );
        if let Some(last) = self.last_output_pts {
            ensure!(
                pts > last,
                "Media Foundation probe stage=timestamp-regression encoder={:?} input={} profile={}: output PTS {} followed {}",
                self.identity,
                self.input_subtype.label(),
                self.config.profile_label(),
                pts,
                last
            );
        }
        self.last_output_pts = Some(pts);
        let duration = unsafe { sample.GetSampleDuration() }
            .unwrap_or_else(|_| scheduled_duration_100ns(0, self.config.fps).unwrap_or(1));
        let buffer = unsafe { sample.ConvertToContiguousBuffer() }?;
        let encoded = copy_media_buffer(&buffer)?;
        let mut bytes = normalize_annex_b(&encoded)?;
        if self.sequence_header.is_empty()
            && let Ok(output_type) = unsafe { self.transform.GetOutputCurrentType(0) }
        {
            self.sequence_header = media_type_sequence_header(&output_type).unwrap_or_default();
        }
        let contains_idr = annex_b_contains_nal_type(&bytes, 5);
        if contains_idr && !annex_b_has_parameter_sets(&bytes) {
            ensure!(
                annex_b_has_parameter_sets(&self.sequence_header),
                "Media Foundation probe stage=sequence-header encoder={:?} input={} profile={}: IDR had no SPS/PPS and MF_MT_MPEG_SEQUENCE_HEADER was unusable",
                self.identity,
                self.input_subtype.label(),
                self.config.profile_label()
            );
            let mut with_header = Vec::with_capacity(self.sequence_header.len() + bytes.len());
            with_header.extend_from_slice(&self.sequence_header);
            with_header.extend_from_slice(&bytes);
            bytes = with_header;
        }
        if contains_idr {
            self.saw_first_idr = true;
        }
        let frame_index = frame_index_from_100ns(pts, self.config.fps)?;
        Ok(MediaFoundationEncodedFrame {
            frame_index,
            pts_100ns: pts,
            duration_100ns: duration,
            bytes,
        })
    }
}

fn configure_codec_api(
    transform: &IMFTransform,
    config: &MediaFoundationEncoderConfig,
    identity: &str,
    input_subtype: MediaFoundationInputSubtype,
) -> Result<()> {
    let codec_api: ICodecAPI = transform.cast().map_err(|error| {
        stage_windows_error(
            "codec-api",
            &error,
            identity,
            Some(input_subtype),
            &config.profile_label(),
        )
    })?;
    let profile = config.profile_label();
    let settings = [
        (
            &CODECAPI_AVEncCommonRealTime,
            variant_bool(true),
            "real-time",
        ),
        (
            &CODECAPI_AVEncCommonLowLatency,
            variant_bool(config.low_latency),
            "low-latency",
        ),
        (
            &CODECAPI_AVEncMPVDefaultBPictureCount,
            variant_u32(0),
            "b-frame-count",
        ),
        (
            &CODECAPI_AVEncMPVGOPSize,
            variant_u32(config.fps.saturating_mul(2)),
            "gop-size",
        ),
        (
            &CODECAPI_AVEncCommonRateControlMode,
            variant_u32(eAVEncCommonRateControlMode_CBR.0 as u32),
            "rate-control",
        ),
        (
            &CODECAPI_AVEncCommonMeanBitRate,
            variant_u32(config.bitrate_kbps.saturating_mul(1_000)),
            "mean-bitrate",
        ),
    ];
    for (key, value, label) in settings {
        if unsafe { codec_api.IsSupported(key) }.is_ok() {
            unsafe { codec_api.SetValue(key, &value) }.map_err(|error| {
                stage_windows_error(
                    &format!("codec-api-{label}"),
                    &error,
                    identity,
                    Some(input_subtype),
                    &profile,
                )
            })?;
        }
    }
    Ok(())
}

fn variant_bool(value: bool) -> VARIANT {
    VARIANT {
        Anonymous: VARIANT_0 {
            Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                vt: VT_BOOL,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: VARIANT_0_0_0 {
                    boolVal: VARIANT_BOOL::from(value),
                },
            }),
        },
    }
}

fn variant_u32(value: u32) -> VARIANT {
    VARIANT {
        Anonymous: VARIANT_0 {
            Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                vt: VT_UI4,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: VARIANT_0_0_0 { ulVal: value },
            }),
        },
    }
}

impl Drop for MediaFoundationH264Encoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let activation = ManuallyDrop::take(&mut self.activation);
            let events = ManuallyDrop::take(&mut self.events);
            let transform = ManuallyDrop::take(&mut self.transform);
            let _ = activation.ShutdownObject();
            drop(events);
            drop(transform);
            drop(activation);
            if self.mf_started {
                let _ = MFShutdown();
                self.mf_started = false;
            }
            if self.com_started {
                CoUninitialize();
                self.com_started = false;
            }
        }
    }
}

pub fn probe_hardware_encoder(
    config: MediaFoundationEncoderConfig,
) -> Result<MediaFoundationProbe> {
    let frame_len = config.i420_len()?;
    let mut encoder = MediaFoundationH264Encoder::new(config.clone())?;
    let identity = encoder.identity().to_string();
    let input_subtype = encoder.input_subtype();
    let mut frames = Vec::new();
    for frame_index in 0..config.fps.clamp(3, 6) as u64 {
        let mut i420 = vec![0x10; frame_len];
        let y_len = usize::try_from(u64::from(config.width) * u64::from(config.height))?;
        i420[..y_len].fill(16_u8.saturating_add(frame_index as u8));
        i420[y_len..].fill(128);
        frames.extend(encoder.encode_frame(&i420, frame_index)?);
    }
    frames.extend(encoder.drain(DRAIN_TIMEOUT)?);
    ensure!(
        !frames.is_empty(),
        "Media Foundation hardware probe produced no H.264 output for {}",
        config.profile_label()
    );
    ensure!(
        frames
            .iter()
            .any(|frame| annex_b_contains_nal_type(&frame.bytes, 5)),
        "Media Foundation hardware probe produced no IDR for {}",
        config.profile_label()
    );
    Ok(MediaFoundationProbe {
        encoder_identity: identity,
        input_subtype,
        frames,
    })
}

fn enumerate_hardware_h264_activations(profile: &str) -> Result<Vec<IMFActivate>> {
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
    };
    let flags = MFT_ENUM_FLAG(MFT_ENUM_FLAG_HARDWARE.0 | MFT_ENUM_FLAG_SORTANDFILTER.0);
    let mut raw: *mut Option<IMFActivate> = ptr::null_mut();
    let mut count = 0_u32;
    unsafe {
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            flags,
            None,
            Some(&output),
            &mut raw,
            &mut count,
        )
        .map_err(|error| stage_windows_error("enumerate", &error, "<none>", None, profile))?;
    }
    ensure!(
        count > 0 && !raw.is_null(),
        "Media Foundation probe stage=enumerate encoder=<none> input=<unset> profile={profile}: no hardware H.264 MFT was available"
    );
    let mut activations = Vec::with_capacity(count as usize);
    unsafe {
        for slot in std::slice::from_raw_parts_mut(raw, count as usize) {
            if let Some(activation) = slot.take() {
                activations.push(activation);
            }
        }
        CoTaskMemFree(Some(raw.cast()));
    }
    Ok(activations)
}

fn activation_name(activation: &IMFActivate) -> Result<String> {
    let length = unsafe { activation.GetStringLength(&MFT_FRIENDLY_NAME_Attribute) }?;
    let mut value = vec![0_u16; length.saturating_add(1) as usize];
    unsafe { activation.GetString(&MFT_FRIENDLY_NAME_Attribute, &mut value, None) }?;
    let end = value
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(value.len());
    Ok(String::from_utf16_lossy(&value[..end]))
}

fn create_video_type(
    config: &MediaFoundationEncoderConfig,
    subtype: windows::core::GUID,
    profile: Option<u32>,
) -> Result<windows::Win32::Media::MediaFoundation::IMFMediaType> {
    let media_type = unsafe { MFCreateMediaType() }?;
    unsafe {
        media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &subtype)?;
        media_type.SetUINT64(
            &MF_MT_FRAME_SIZE,
            (u64::from(config.width) << 32) | u64::from(config.height),
        )?;
        media_type.SetUINT64(&MF_MT_FRAME_RATE, (u64::from(config.fps) << 32) | 1)?;
        media_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        media_type.SetUINT32(
            &MF_MT_AVG_BITRATE,
            config.bitrate_kbps.saturating_mul(1_000),
        )?;
        media_type.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 0)?;
        media_type.SetUINT32(&MF_MT_FIXED_SIZE_SAMPLES, u32::from(profile.is_none()))?;
        if let Some(profile) = profile {
            media_type.SetUINT32(&MF_MT_MPEG2_PROFILE, profile)?;
            media_type.SetUINT32(&MF_MT_MAX_KEYFRAME_SPACING, config.fps.saturating_mul(2))?;
        }
    }
    Ok(media_type)
}

fn create_input_sample(
    i420: &[u8],
    input_subtype: MediaFoundationInputSubtype,
    width: u32,
    height: u32,
    pts: i64,
    duration: i64,
) -> Result<IMFSample> {
    let buffer = match input_subtype {
        MediaFoundationInputSubtype::I420 => create_i420_input_buffer(i420)?,
        MediaFoundationInputSubtype::Nv12 => create_nv12_input_buffer(i420, width, height)?,
    };
    let sample = unsafe { MFCreateSample() }?;
    unsafe {
        sample.AddBuffer(&buffer)?;
        sample.SetSampleTime(pts)?;
        sample.SetSampleDuration(duration)?;
    }
    Ok(sample)
}

fn create_i420_input_buffer(i420: &[u8]) -> Result<IMFMediaBuffer> {
    let len = u32::try_from(i420.len()).context("Media Foundation input frame exceeded u32")?;
    let buffer = unsafe { MFCreateMemoryBuffer(len) }?;
    let mut target = ptr::null_mut();
    let mut max_len = 0_u32;
    unsafe {
        buffer.Lock(&mut target, Some(&mut max_len), None)?;
        if max_len < len {
            let _ = buffer.Unlock();
            bail!("Media Foundation input buffer was smaller than requested");
        }
        std::slice::from_raw_parts_mut(target, i420.len()).copy_from_slice(i420);
        buffer.Unlock()?;
        buffer.SetCurrentLength(len)?;
    }
    Ok(buffer)
}

fn create_nv12_input_buffer(i420: &[u8], width: u32, height: u32) -> Result<IMFMediaBuffer> {
    ensure!(
        width.is_multiple_of(2) && height.is_multiple_of(2),
        "NV12 input requires even dimensions"
    );
    let buffer = unsafe { MFCreate2DMediaBuffer(width, height, MFVideoFormat_NV12.data1, false) }?;
    let buffer_2d: IMF2DBuffer2 = buffer.cast()?;
    let mut scanline = ptr::null_mut();
    let mut pitch = 0_i32;
    let mut buffer_start = ptr::null_mut();
    let mut buffer_len = 0_u32;
    unsafe {
        buffer_2d.Lock2DSize(
            MF2DBuffer_LockFlags_Write,
            &mut scanline,
            &mut pitch,
            &mut buffer_start,
            &mut buffer_len,
        )?;
        let write_result = (|| {
            ensure!(
                pitch > 0,
                "NV12 input buffer returned non-positive pitch {pitch}"
            );
            ensure!(
                scanline == buffer_start,
                "NV12 input buffer returned an unexpected top-row offset"
            );
            let pitch = usize::try_from(pitch)?;
            let height = usize::try_from(height)?;
            let required_len = pitch
                .checked_mul(height + height / 2)
                .context("NV12 strided input buffer size overflowed")?;
            ensure!(
                required_len <= buffer_len as usize,
                "NV12 input buffer length {buffer_len} was smaller than required {required_len}"
            );
            let target = std::slice::from_raw_parts_mut(buffer_start, required_len);
            i420_to_nv12_strided(i420, width, height as u32, pitch, target)
        })();
        if let Err(error) = write_result {
            let _ = buffer_2d.Unlock2D();
            return Err(error);
        }
        buffer_2d.Unlock2D()?;
        buffer.SetCurrentLength(buffer_2d.GetContiguousLength()?)?;
    }
    Ok(buffer)
}

fn copy_media_buffer(buffer: &IMFMediaBuffer) -> Result<Vec<u8>> {
    let len = unsafe { buffer.GetCurrentLength() }?;
    let mut source = ptr::null_mut();
    unsafe {
        buffer.Lock(&mut source, None, None)?;
        let bytes = std::slice::from_raw_parts(source, len as usize).to_vec();
        buffer.Unlock()?;
        Ok(bytes)
    }
}

fn media_type_sequence_header(
    media_type: &windows::Win32::Media::MediaFoundation::IMFMediaType,
) -> Result<Vec<u8>> {
    let size = unsafe { media_type.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER) }?;
    let mut header = vec![0; size as usize];
    unsafe { media_type.GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut header, None) }?;
    normalize_annex_b(&header)
}

fn scheduled_time_100ns(frame_index: u64, fps: u32) -> Result<i64> {
    ensure!(fps > 0, "scheduled Media Foundation FPS must be positive");
    let value = u128::from(frame_index)
        .checked_mul(10_000_000)
        .context("Media Foundation timestamp overflowed")?
        / u128::from(fps);
    i64::try_from(value).context("Media Foundation timestamp exceeded i64")
}

fn scheduled_duration_100ns(frame_index: u64, fps: u32) -> Result<i64> {
    Ok(scheduled_time_100ns(frame_index.saturating_add(1), fps)?
        - scheduled_time_100ns(frame_index, fps)?)
}

fn frame_index_from_100ns(pts: i64, fps: u32) -> Result<u64> {
    ensure!(pts >= 0, "Media Foundation output PTS was negative");
    let value = u128::try_from(pts)?
        .checked_mul(u128::from(fps))
        .context("Media Foundation frame-index conversion overflowed")?
        / 10_000_000;
    u64::try_from(value).context("Media Foundation frame index exceeded u64")
}

fn i420_to_nv12_strided(
    i420: &[u8],
    width: u32,
    height: u32,
    pitch: usize,
    output: &mut [u8],
) -> Result<()> {
    ensure!(
        width.is_multiple_of(2) && height.is_multiple_of(2),
        "NV12 conversion requires even dimensions"
    );
    let y_len = usize::try_from(u64::from(width) * u64::from(height))?;
    let chroma_len = y_len / 4;
    ensure!(
        i420.len() == y_len + chroma_len * 2,
        "I420/NV12 conversion input length mismatch"
    );
    let width = usize::try_from(width)?;
    let height = usize::try_from(height)?;
    ensure!(
        pitch >= width,
        "I420/NV12 conversion pitch {pitch} was smaller than width {width}"
    );
    let output_len = pitch
        .checked_mul(height + height / 2)
        .context("I420/NV12 conversion output size overflowed")?;
    ensure!(
        output.len() == output_len,
        "I420/NV12 conversion output length mismatch"
    );
    for row in 0..height {
        let source_start = row * width;
        let target_start = row * pitch;
        output[target_start..target_start + width]
            .copy_from_slice(&i420[source_start..source_start + width]);
    }
    let u = &i420[y_len..y_len + chroma_len];
    let v = &i420[y_len + chroma_len..];
    let chroma_width = width / 2;
    let uv_offset = pitch * height;
    for row in 0..height / 2 {
        let source_start = row * chroma_width;
        let target_start = uv_offset + row * pitch;
        for column in 0..chroma_width {
            output[target_start + column * 2] = u[source_start + column];
            output[target_start + column * 2 + 1] = v[source_start + column];
        }
    }
    Ok(())
}

fn normalize_annex_b(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.starts_with(&[0, 0, 1]) || bytes.starts_with(&[0, 0, 0, 1]) {
        return Ok(bytes.to_vec());
    }
    let mut input = bytes;
    let mut output = Vec::with_capacity(bytes.len().saturating_add(16));
    while !input.is_empty() {
        ensure!(
            input.len() >= 4,
            "truncated length-prefixed H.264 access unit"
        );
        let len = u32::from_be_bytes(input[..4].try_into().unwrap()) as usize;
        input = &input[4..];
        ensure!(
            len > 0 && input.len() >= len,
            "invalid length-prefixed H.264 NAL size {len}"
        );
        output.extend_from_slice(&[0, 0, 0, 1]);
        output.extend_from_slice(&input[..len]);
        input = &input[len..];
    }
    ensure!(!output.is_empty(), "empty H.264 access unit");
    Ok(output)
}

fn annex_b_nal_types(bytes: &[u8]) -> Vec<u8> {
    let mut types = Vec::new();
    let mut index = 0;
    while index + 3 < bytes.len() {
        let start_len = if bytes[index..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if bytes[index..].starts_with(&[0, 0, 1]) {
            3
        } else {
            index += 1;
            continue;
        };
        let header = index + start_len;
        if header < bytes.len() {
            types.push(bytes[header] & 0x1f);
        }
        index = header.saturating_add(1);
    }
    types
}

fn annex_b_contains_nal_type(bytes: &[u8], nal_type: u8) -> bool {
    annex_b_nal_types(bytes).contains(&nal_type)
}

fn annex_b_has_parameter_sets(bytes: &[u8]) -> bool {
    let types = annex_b_nal_types(bytes);
    types.contains(&7) && types.contains(&8)
}

fn stage_windows_error(
    stage: &str,
    error: &windows::core::Error,
    identity: &str,
    subtype: Option<MediaFoundationInputSubtype>,
    profile: &str,
) -> anyhow::Error {
    stage_error(stage, error.code(), identity, subtype, profile)
}

fn stage_error(
    stage: &str,
    hresult: windows::core::HRESULT,
    identity: &str,
    subtype: Option<MediaFoundationInputSubtype>,
    profile: &str,
) -> anyhow::Error {
    anyhow!(
        "Media Foundation probe stage={stage} HRESULT=0x{:08X} encoder={identity:?} input={} profile={profile}",
        hresult.0 as u32,
        subtype.map_or("<unset>", MediaFoundationInputSubtype::label)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheduled_timestamps_do_not_regress_at_fractional_100ns_intervals() {
        let values = (0..120)
            .map(|index| scheduled_time_100ns(index, 60).unwrap())
            .collect::<Vec<_>>();
        assert!(values.windows(2).all(|pair| pair[1] > pair[0]));
        assert_eq!(values[60], 10_000_000);
    }

    #[test]
    fn converts_i420_chroma_to_nv12_interleaving() {
        let input = [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 20, 21];
        let mut output = [0; 12];
        i420_to_nv12_strided(&input, 4, 2, 4, &mut output).unwrap();
        assert_eq!(output, [1, 2, 3, 4, 5, 6, 7, 8, 10, 20, 11, 21]);
    }

    #[test]
    fn converts_i420_into_strided_nv12_rows_without_touching_padding() {
        let input = [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 20, 21];
        let mut output = [0xff; 24];
        i420_to_nv12_strided(&input, 4, 2, 8, &mut output).unwrap();
        assert_eq!(&output[..8], &[1, 2, 3, 4, 0xff, 0xff, 0xff, 0xff]);
        assert_eq!(&output[8..16], &[5, 6, 7, 8, 0xff, 0xff, 0xff, 0xff]);
        assert_eq!(&output[16..], &[10, 20, 11, 21, 0xff, 0xff, 0xff, 0xff]);
    }

    #[test]
    fn rejects_an_incorrect_strided_nv12_output_length() {
        let input = [1, 2, 3, 4, 5, 6];
        let mut output = [0; 11];
        let error = i420_to_nv12_strided(&input, 2, 2, 4, &mut output).unwrap_err();
        assert!(error.to_string().contains("output length mismatch"));
    }

    #[test]
    fn normalizes_length_prefixed_access_units_and_finds_parameter_sets() {
        let avcc = [
            0, 0, 0, 2, 0x67, 1, 0, 0, 0, 2, 0x68, 2, 0, 0, 0, 2, 0x65, 3,
        ];
        let annex_b = normalize_annex_b(&avcc).unwrap();
        assert!(annex_b_has_parameter_sets(&annex_b));
        assert!(annex_b_contains_nal_type(&annex_b, 5));
    }
}
