//! What the stream hands the Frame Server for every sample request: the
//! newest frame from the ring, the previous one while nothing newer landed,
//! or the "Videorc isn't running" still while the ring is absent or stale
//! for a second (plan 214 C1, D12).
//!
//! The media source owns the section: it creates it (with the camera DACL)
//! the first time a stream starts and keeps it until shutdown, so a
//! restarted source meets a surviving ring and Videorc's writer sees one
//! name for the life of the camera.

use crate::ring::{ReadOutcome, RingLayout, RingReader};
use crate::still::not_running_still;

use super::boot_clock_ms;
use super::section::SharedSection;

/// How long after a failed section create the next attempt waits.
const CREATE_RETRY_MS: u64 = 1000;

pub struct FrameSource {
    layout: RingLayout,
    ring: Option<(SharedSection, RingReader)>,
    still: Vec<u8>,
    last: Vec<u8>,
    have_last: bool,
    next_create_attempt_ms: u64,
    viewers: u32,
    last_error: Option<String>,
}

impl FrameSource {
    pub fn new(layout: RingLayout) -> Self {
        Self {
            layout,
            ring: None,
            still: not_running_still(layout.width, layout.height),
            last: vec![0; layout.frame_bytes],
            have_last: false,
            next_create_attempt_ms: 0,
            viewers: 0,
            last_error: None,
        }
    }

    pub fn layout(&self) -> &RingLayout {
        &self.layout
    }

    /// The last failure to create the section, for the debugger.
    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    /// Create the section when it is not open yet; a failure is retried once
    /// a second so a transient refusal never pins the still forever.
    fn ensure_ring(&mut self, now_ms: u64) -> bool {
        if self.ring.is_some() {
            return true;
        }
        if now_ms < self.next_create_attempt_ms {
            return false;
        }
        match SharedSection::create(&self.layout.section_name(), self.layout.total_bytes()) {
            Ok(section) => match RingReader::initialize(section.region(), self.layout) {
                Ok(reader) => {
                    reader.set_viewers(self.viewers);
                    self.ring = Some((section, reader));
                    self.last_error = None;
                    true
                }
                Err(error) => {
                    self.last_error = Some(error.to_string());
                    self.next_create_attempt_ms = now_ms + CREATE_RETRY_MS;
                    false
                }
            },
            Err(error) => {
                self.last_error = Some(error.to_string());
                self.next_create_attempt_ms = now_ms + CREATE_RETRY_MS;
                false
            }
        }
    }

    /// D13: how many started streams hold the camera. Written into the ring
    /// header as soon as there is one.
    pub fn set_viewers(&mut self, viewers: u32) {
        self.viewers = viewers;
        if let Some((_, reader)) = &self.ring {
            reader.set_viewers(viewers);
        }
    }

    /// The frame for the next sample, tightly packed NV12.
    pub fn next_frame(&mut self) -> &[u8] {
        let now_ms = boot_clock_ms();
        if !self.ensure_ring(now_ms) {
            return &self.still;
        }
        let Some((_, reader)) = self.ring.as_mut() else {
            return &self.still;
        };
        match reader.read_latest_into(&mut self.last, now_ms) {
            ReadOutcome::Fresh { .. } => {
                self.have_last = true;
                &self.last
            }
            ReadOutcome::Unchanged if self.have_last => &self.last,
            ReadOutcome::Unchanged | ReadOutcome::Stale | ReadOutcome::Empty => {
                // A stale ring forgets its last frame: when Videorc comes
                // back it starts from the still, never from a minute-old
                // picture.
                self.have_last = false;
                &self.still
            }
        }
    }

    /// Shutdown: nobody views, the section goes (Videorc's own handle keeps
    /// the memory alive until it closes too).
    pub fn close(&mut self) {
        self.set_viewers(0);
        self.ring = None;
        self.have_last = false;
    }
}
