//! A development tap on the SRT Camera's decoded frames, for latency work.
//! Compiled into development builds only, and off unless
//! `VIDEORC_SRT_FRAME_TAP=<dir>` is set.
//! For every decoded frame it appends a timing line to `<dir>/frames.csv`,
//! and every Nth frame it writes a downscaled grayscale crop as
//! `<dir>/<decoded_ms>.pgm`, named by the same timestamp as its line.
//! The files are written on a thread of their own; when it falls behind,
//! lines and samples are dropped, never waited for.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The CSV's first line; `csv_line` writes the rest in this order.
pub const CSV_HEADER: &str = "decoded_ms,pts,width,height,sender_session,arrived_ms";

/// A development setting.
pub fn dev_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

/// A region of the frame in normalised 0 to 1 coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Crop {
    pub const WHOLE: Crop = Crop {
        x: 0.0,
        y: 0.0,
        w: 1.0,
        h: 1.0,
    };
}

/// `x,y,w,h` in 0 to 1; None for anything else, or an empty region.
pub fn parse_crop(text: &str) -> Option<Crop> {
    let parts: Vec<f64> = text
        .split(',')
        .map(|part| part.trim().parse::<f64>())
        .collect::<Result<_, _>>()
        .ok()?;
    let [x, y, w, h] = parts[..] else {
        return None;
    };
    let unit = |value: f64| value.is_finite() && (0.0..=1.0).contains(&value);
    (unit(x) && unit(y) && unit(w) && unit(h) && w > 0.0 && h > 0.0).then_some(Crop { x, y, w, h })
}

/// The pixels a crop reads from a frame, and the sample it makes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CropRect {
    pub x0: u32,
    pub y0: u32,
    pub width: u32,
    pub height: u32,
    /// Every `step`th pixel in both directions.
    pub step: u32,
    pub out_width: u32,
    pub out_height: u32,
}

/// The crop on a `frame_width` x `frame_height` frame, clamped to it, read
/// every `step`th pixel so the sample is at most `max_width` wide. None when
/// nothing of it falls on the frame.
pub fn crop_rect(
    crop: Crop,
    frame_width: u32,
    frame_height: u32,
    max_width: u32,
) -> Option<CropRect> {
    let x0 = ((crop.x * f64::from(frame_width)).floor() as u32).min(frame_width);
    let y0 = ((crop.y * f64::from(frame_height)).floor() as u32).min(frame_height);
    let x1 = (((crop.x + crop.w) * f64::from(frame_width)).ceil() as u32).min(frame_width);
    let y1 = (((crop.y + crop.h) * f64::from(frame_height)).ceil() as u32).min(frame_height);
    let width = x1.checked_sub(x0).filter(|width| *width > 0)?;
    let height = y1.checked_sub(y0).filter(|height| *height > 0)?;
    let step = width.div_ceil(max_width.max(1)).max(1);
    Some(CropRect {
        x0,
        y0,
        width,
        height,
        step,
        out_width: width.div_ceil(step),
        out_height: height.div_ceil(step),
    })
}

/// BT.601 luma of one BGRA pixel, in integers.
pub fn luma(blue: u8, green: u8, red: u8) -> u8 {
    ((77 * u32::from(red) + 150 * u32::from(green) + 29 * u32::from(blue)) >> 8) as u8
}

/// A wall clock reading (`SystemTime`, as a script on this Mac reads it) for
/// an `Instant`, from one pair of readings taken together.
#[derive(Debug, Clone, Copy)]
pub struct WallClock {
    instant: Instant,
    since_epoch: Duration,
}

impl WallClock {
    pub fn now() -> Self {
        Self {
            instant: Instant::now(),
            since_epoch: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default(),
        }
    }

    /// Milliseconds since the Unix epoch, with fractions.
    pub fn ms(&self, at: Instant) -> f64 {
        let since = match at.checked_duration_since(self.instant) {
            Some(after) => self.since_epoch + after,
            None => self.since_epoch.saturating_sub(self.instant - at),
        };
        since.as_secs_f64() * 1000.0
    }
}

/// One decoded frame's timing.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TapRow {
    /// When the frame left the decoder.
    pub decoded_ms: f64,
    /// The frame's PTS, in 90 kHz ticks.
    pub pts: i64,
    pub width: u32,
    pub height: u32,
    pub sender_session: u32,
    /// When the access unit whose decode returned the frame finished arriving.
    pub arrived_ms: f64,
}

/// The timestamp text a row and its sample share.
pub fn stamp(ms: f64) -> String {
    format!("{ms:.3}")
}

pub fn csv_line(row: &TapRow) -> String {
    format!(
        "{},{},{},{},{},{}",
        stamp(row.decoded_ms),
        row.pts,
        row.width,
        row.height,
        row.sender_session,
        stamp(row.arrived_ms)
    )
}

/// A binary PGM (P5) of an 8-bit grayscale sample.
pub fn pgm(width: u32, height: u32, gray: &[u8]) -> Vec<u8> {
    let mut out = format!("P5\n{width} {height}\n255\n").into_bytes();
    out.extend_from_slice(gray);
    out
}

/// The tap's settings, from the environment (debug builds only).
#[derive(Debug, Clone, PartialEq)]
pub struct TapConfig {
    pub dir: std::path::PathBuf,
    pub every: u32,
    pub crop: Crop,
    pub max_width: u32,
}

impl TapConfig {
    pub fn from_env() -> Option<Self> {
        Self::from_values(
            dev_env("VIDEORC_SRT_FRAME_TAP"),
            dev_env("VIDEORC_SRT_FRAME_TAP_EVERY"),
            dev_env("VIDEORC_SRT_FRAME_TAP_CROP"),
            dev_env("VIDEORC_SRT_FRAME_TAP_WIDTH"),
        )
    }

    fn from_values(
        dir: Option<String>,
        every: Option<String>,
        crop: Option<String>,
        max_width: Option<String>,
    ) -> Option<Self> {
        let parse = |value: Option<String>, default: u32| {
            value
                .and_then(|text| text.trim().parse::<u32>().ok())
                .filter(|value| *value > 0)
                .unwrap_or(default)
        };
        Some(Self {
            dir: dir?.into(),
            every: parse(every, 3),
            crop: crop.as_deref().and_then(parse_crop).unwrap_or(Crop::WHOLE),
            max_width: parse(max_width, 640),
        })
    }
}

#[cfg(target_os = "macos")]
pub use runtime::FrameTap;

#[cfg(target_os = "macos")]
mod runtime {
    use super::*;
    use crate::srt_camera::apple_decode::{DecodedFrame, copy_gray_crop};
    use crate::srt_camera::camera::DecodedMeta;
    use std::io::{BufWriter, Write};
    use std::sync::mpsc::{RecvTimeoutError, SyncSender, sync_channel};

    /// Few enough that a queued sample never holds back many of the
    /// decoder's buffers.
    const QUEUE: usize = 16;

    enum Item {
        Row(TapRow),
        Sample { stamp: String, frame: DecodedFrame },
    }

    pub struct FrameTap {
        items: SyncSender<Item>,
        every: u32,
        decoded: u64,
        dropped: u64,
        clock: WallClock,
    }

    impl FrameTap {
        /// The tap as the environment sets it, or None (off, or its folder
        /// can't be written).
        pub fn from_env() -> Option<Self> {
            let config = TapConfig::from_env()?;
            let opened = std::fs::create_dir_all(&config.dir).and_then(|()| {
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(config.dir.join("frames.csv"))
            });
            let file = match opened {
                Ok(file) => file,
                Err(error) => {
                    tracing::warn!(
                        "[srt-camera] frame tap off: {}: {error}",
                        config.dir.display()
                    );
                    return None;
                }
            };
            let fresh = file.metadata().map(|meta| meta.len() == 0).unwrap_or(true);
            let mut csv = BufWriter::new(file);
            if fresh {
                let _ = writeln!(csv, "{CSV_HEADER}");
            }
            let (items, queue) = sync_channel(QUEUE);
            let writer_config = config.clone();
            std::thread::Builder::new()
                .name("videorc-srt-frame-tap".to_string())
                .spawn(move || write_loop(&queue, csv, &writer_config))
                .ok()?;
            tracing::info!(
                "[srt-camera] frame tap on: {} (a sample every {} frames)",
                config.dir.display(),
                config.every
            );
            Some(Self {
                items,
                every: config.every,
                decoded: 0,
                dropped: 0,
                clock: WallClock::now(),
            })
        }

        /// On the receive thread: a line for every frame, a sample for
        /// every Nth. Never waits; drops when the writer falls behind.
        pub fn on_frame(&mut self, frame: &DecodedFrame, meta: DecodedMeta) {
            let row = TapRow {
                decoded_ms: self.clock.ms(meta.decoded_at),
                pts: frame.pts,
                width: frame.width,
                height: frame.height,
                sender_session: meta.sender_session,
                arrived_ms: self.clock.ms(meta.arrived_at),
            };
            let sample = self.decoded.is_multiple_of(u64::from(self.every));
            self.decoded += 1;
            let mut sent = self.items.try_send(Item::Row(row)).is_ok();
            if sample {
                sent &= self
                    .items
                    .try_send(Item::Sample {
                        stamp: stamp(row.decoded_ms),
                        frame: frame.clone(),
                    })
                    .is_ok();
            }
            if !sent {
                self.dropped += 1;
                if self.dropped == 1 {
                    tracing::warn!("[srt-camera] frame tap fell behind; dropping lines or samples");
                }
            }
        }
    }

    impl Drop for FrameTap {
        fn drop(&mut self) {
            if self.dropped > 0 {
                tracing::warn!(
                    "[srt-camera] frame tap dropped {} of {} frames' lines or samples",
                    self.dropped,
                    self.decoded
                );
            }
        }
    }

    fn write_loop(
        queue: &std::sync::mpsc::Receiver<Item>,
        mut csv: BufWriter<std::fs::File>,
        config: &TapConfig,
    ) {
        let mut flushed_at = Instant::now();
        loop {
            match queue.recv_timeout(Duration::from_millis(250)) {
                Ok(Item::Row(row)) => {
                    let _ = writeln!(csv, "{}", csv_line(&row));
                }
                Ok(Item::Sample { stamp, frame }) => {
                    if let Some(rect) =
                        crop_rect(config.crop, frame.width, frame.height, config.max_width)
                        && let Some(gray) = copy_gray_crop(&frame, rect)
                    {
                        let path = config.dir.join(format!("{stamp}.pgm"));
                        let _ = std::fs::write(path, pgm(rect.out_width, rect.out_height, &gray));
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    let _ = csv.flush();
                    return;
                }
            }
            if flushed_at.elapsed() >= Duration::from_secs(1) {
                let _ = csv.flush();
                flushed_at = Instant::now();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_tap_reads_a_crop_in_normalised_coordinates() {
        assert_eq!(
            parse_crop("0.1, 0.2,0.5,0.25"),
            Some(Crop {
                x: 0.1,
                y: 0.2,
                w: 0.5,
                h: 0.25
            })
        );
        for refused in [
            "",
            "0.1,0.2,0.3",
            "0,0,0,1",
            "-0.1,0,1,1",
            "0,0,1.5,1",
            "a,b,c,d",
        ] {
            assert_eq!(parse_crop(refused), None, "{refused}");
        }
    }

    #[test]
    fn srt_tap_crop_rect_clamps_and_downscales() {
        // A quarter of a 4K frame, at most 640 wide: every 3rd pixel.
        let rect = crop_rect(
            Crop {
                x: 0.5,
                y: 0.5,
                w: 0.5,
                h: 0.5,
            },
            3840,
            2160,
            640,
        )
        .unwrap();
        assert_eq!(
            rect,
            CropRect {
                x0: 1920,
                y0: 1080,
                width: 1920,
                height: 1080,
                step: 3,
                out_width: 640,
                out_height: 360
            }
        );
        // A small crop is read whole.
        let small = crop_rect(
            Crop {
                x: 0.0,
                y: 0.0,
                w: 0.1,
                h: 0.1,
            },
            1920,
            1080,
            640,
        )
        .unwrap();
        assert_eq!((small.width, small.step, small.out_width), (192, 1, 192));
        // Past the edge: clamped to the frame.
        let edge = crop_rect(
            Crop {
                x: 0.9,
                y: 0.9,
                w: 0.5,
                h: 0.5,
            },
            1000,
            1000,
            640,
        )
        .unwrap();
        assert_eq!(
            (edge.x0, edge.width, edge.y0, edge.height),
            (900, 100, 900, 100)
        );
        // An odd width that does not divide: the last column still counts.
        let odd = crop_rect(Crop::WHOLE, 1281, 720, 640).unwrap();
        assert_eq!((odd.step, odd.out_width), (3, 427));
        // Nothing on the frame.
        assert_eq!(crop_rect(Crop::WHOLE, 0, 720, 640), None);
    }

    #[test]
    fn srt_tap_csv_line_and_sample_share_one_stamp() {
        let row = TapRow {
            decoded_ms: 1_794_737_756_028.456_7,
            pts: 900_000,
            width: 3840,
            height: 2160,
            sender_session: 2,
            arrived_ms: 1_794_737_756_011.25,
        };
        assert_eq!(
            csv_line(&row),
            "1794737756028.457,900000,3840,2160,2,1794737756011.250"
        );
        assert!(csv_line(&row).starts_with(&stamp(row.decoded_ms)));
        assert_eq!(
            CSV_HEADER.split(',').count(),
            csv_line(&row).split(',').count()
        );
    }

    #[test]
    fn srt_tap_wall_clock_is_one_offset_from_instants() {
        let clock = WallClock::now();
        let later = clock.instant + Duration::from_millis(250);
        assert!((clock.ms(later) - clock.ms(clock.instant) - 250.0).abs() < 0.001);
    }

    #[test]
    fn srt_tap_pgm_and_luma() {
        assert_eq!(pgm(2, 1, &[0, 255]), b"P5\n2 1\n255\n\x00\xff".to_vec());
        assert_eq!(luma(0, 0, 0), 0);
        assert!(luma(255, 255, 255) >= 254);
        assert!(luma(0, 0, 255) < luma(0, 255, 0), "green weighs most");
    }

    #[test]
    fn srt_tap_settings_default_to_every_third_frame_whole() {
        assert_eq!(TapConfig::from_values(None, None, None, None), None);
        let config = TapConfig::from_values(Some("/tmp/tap".into()), None, None, None).unwrap();
        assert_eq!(config.every, 3);
        assert_eq!(config.crop, Crop::WHOLE);
        assert_eq!(config.max_width, 640);
        let set = TapConfig::from_values(
            Some("/tmp/tap".into()),
            Some("5".into()),
            Some("0,0,0.5,0.5".into()),
            Some("0".into()),
        )
        .unwrap();
        assert_eq!((set.every, set.crop.w, set.max_width), (5, 0.5, 640));
    }
}
