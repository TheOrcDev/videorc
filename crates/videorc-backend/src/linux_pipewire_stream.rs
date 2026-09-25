//! The PipeWire half of Linux portal screen capture (Plan 0006): reads the
//! node the portal granted on the capture thread's own PipeWire main loop,
//! negotiates a packed RGB layout, and hands each buffer to the caller as
//! tightly packed BGRA for the shared screen frame store. Memcpy frames
//! only; DMA-BUF import is a follow-up.
#![cfg(target_os = "linux")]

use std::os::fd::OwnedFd;
use std::rc::Rc;
use std::sync::mpsc as std_mpsc;
use std::time::Duration;

use pipewire as pw;
use pw::spa;
use pw::spa::param::video::VideoFormat;
use pw::spa::pod::Pod;

use crate::linux_portal_capture::{PortalPixelLayout, copy_to_bgra};

/// One negotiated frame, already converted to packed BGRA.
pub struct PipewireFrame<'a> {
    pub width: u32,
    pub height: u32,
    pub bgra: &'a [u8],
}

#[derive(Default)]
struct StreamUserData {
    format: spa::param::video::VideoInfoRaw,
    layout: Option<PortalPixelLayout>,
    scratch: Vec<u8>,
    frames: u64,
}

fn layout_for(format: VideoFormat) -> Option<PortalPixelLayout> {
    match format {
        VideoFormat::BGRx => Some(PortalPixelLayout::Bgrx),
        VideoFormat::BGRA => Some(PortalPixelLayout::Bgra),
        VideoFormat::RGBx => Some(PortalPixelLayout::Rgbx),
        VideoFormat::RGBA => Some(PortalPixelLayout::Rgba),
        _ => None,
    }
}

/// Runs the stream until `stop_rx` fires (or its sender drops), calling
/// `on_frame` for every complete frame. `on_revoked` is polled from the loop
/// so a portal `Closed` signal ends the read within one tick.
pub fn run_pipewire_capture(
    fd: OwnedFd,
    node_id: u32,
    target_fps: u32,
    stop_rx: std_mpsc::Receiver<()>,
    on_revoked: impl FnMut() -> bool + 'static,
    mut on_frame: impl FnMut(PipewireFrame<'_>) + 'static,
) -> Result<(), String> {
    pw::init();
    let mainloop =
        pw::main_loop::MainLoopRc::new(None).map_err(|e| format!("PipeWire main loop: {e}"))?;
    let context = pw::context::ContextRc::new(&mainloop, None)
        .map_err(|e| format!("PipeWire context: {e}"))?;
    let core = context
        .connect_fd_rc(fd, None)
        .map_err(|e| format!("PipeWire connect over the portal fd: {e}"))?;

    let stream = pw::stream::StreamBox::new(
        &core,
        "videorc-portal-screen",
        pw::properties::properties! {
            *pw::keys::MEDIA_TYPE => "Video",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
        },
    )
    .map_err(|e| format!("PipeWire stream: {e}"))?;

    let _listener = stream
        .add_local_listener_with_user_data(StreamUserData::default())
        .param_changed(|_stream, user_data, id, param| {
            let Some(param) = param else { return };
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            let Ok((media_type, media_subtype)) = spa::param::format_utils::parse_format(param)
            else {
                return;
            };
            if media_type != spa::param::format::MediaType::Video
                || media_subtype != spa::param::format::MediaSubtype::Raw
            {
                return;
            }
            if user_data.format.parse(param).is_err() {
                return;
            }
            user_data.layout = layout_for(user_data.format.format());
            tracing::info!(
                format = ?user_data.format.format(),
                width = user_data.format.size().width,
                height = user_data.format.size().height,
                "portal PipeWire stream negotiated"
            );
        })
        .process(move |stream, user_data| {
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            let Some(layout) = user_data.layout else {
                return;
            };
            let width = user_data.format.size().width;
            let height = user_data.format.size().height;
            if width == 0 || height == 0 {
                return;
            }
            let datas = buffer.datas_mut();
            let Some(data) = datas.first_mut() else {
                return;
            };
            let chunk = data.chunk();
            let stride = chunk.stride().max(0) as usize;
            let offset = chunk.offset() as usize;
            let size = chunk.size() as usize;
            let Some(slice) = data.data() else { return };
            let end = offset.saturating_add(size).min(slice.len());
            if end <= offset {
                return;
            }
            let src = &slice[offset..end];
            let stride = if stride == 0 {
                width as usize * 4
            } else {
                stride
            };
            let mut scratch = std::mem::take(&mut user_data.scratch);
            if copy_to_bgra(
                layout,
                src,
                stride,
                width as usize,
                height as usize,
                &mut scratch,
            ) {
                user_data.frames = user_data.frames.saturating_add(1);
                on_frame(PipewireFrame {
                    width,
                    height,
                    bgra: &scratch,
                });
            }
            user_data.scratch = scratch;
        })
        .register()
        .map_err(|e| format!("PipeWire stream listener: {e}"))?;

    let fps = target_fps.clamp(1, 240);
    let obj = spa::pod::object!(
        spa::utils::SpaTypes::ObjectParamFormat,
        spa::param::ParamType::EnumFormat,
        spa::pod::property!(
            spa::param::format::FormatProperties::MediaType,
            Id,
            spa::param::format::MediaType::Video
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::MediaSubtype,
            Id,
            spa::param::format::MediaSubtype::Raw
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            VideoFormat::BGRx,
            VideoFormat::BGRx,
            VideoFormat::BGRA,
            VideoFormat::RGBx,
            VideoFormat::RGBA
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            spa::utils::Rectangle {
                width: 1920,
                height: 1080
            },
            spa::utils::Rectangle {
                width: 1,
                height: 1
            },
            spa::utils::Rectangle {
                width: 8192,
                height: 8192
            }
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            spa::utils::Fraction { num: fps, denom: 1 },
            spa::utils::Fraction { num: 0, denom: 1 },
            spa::utils::Fraction {
                num: 1000,
                denom: 1
            }
        ),
    );
    let values: Vec<u8> = spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(obj),
    )
    .map_err(|e| format!("PipeWire format pod: {e:?}"))?
    .0
    .into_inner();
    let mut params = [Pod::from_bytes(&values).ok_or("PipeWire format pod is not a pod")?];
    stream
        .connect(
            spa::utils::Direction::Input,
            Some(node_id),
            pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
            &mut params,
        )
        .map_err(|e| format!("PipeWire stream connect to node {node_id}: {e}"))?;

    // Bounded stop: poll the stop channel and the portal's Closed flag from
    // the loop itself, so the thread never blocks on a foreign wakeup.
    let on_revoked = Rc::new(std::cell::RefCell::new(on_revoked));
    let timer = {
        let quit_loop = mainloop.clone();
        mainloop.loop_().add_timer(move |_| {
            let stop = matches!(
                stop_rx.try_recv(),
                Ok(()) | Err(std_mpsc::TryRecvError::Disconnected)
            );
            if stop || (on_revoked.borrow_mut())() {
                quit_loop.quit();
            }
        })
    };
    timer
        .update_timer(
            Some(Duration::from_millis(50)),
            Some(Duration::from_millis(50)),
        )
        .into_result()
        .map_err(|e| format!("PipeWire stop timer: {e}"))?;

    mainloop.run();
    Ok(())
}
