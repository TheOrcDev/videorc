//! What the SRT Camera shows and says (plan 250 D7, D8, D12, D14, D17).
//! Pure, with the clock passed in: frames are timed by their arrival, never
//! by the sender's PTS (a sender may stamp the nominal rate while sending
//! fewer frames).

use std::collections::VecDeque;
use std::net::IpAddr;
use std::time::{Duration, Instant};

use super::ts_demux::VideoCodec;
use crate::protocol::{SrtCameraSignal, SrtCameraStatus, SrtSenderRefusal};

/// D8: after the last frame, hold it this long, then show the still.
pub const HOLD: Duration = Duration::from_secs(2);
/// A gap shorter than this is still Receiving; a longer one is Holding.
const RECEIVING_GAP: Duration = Duration::from_millis(500);
/// The frame rate is measured over the arrivals of this window.
const FPS_WINDOW: Duration = Duration::from_secs(2);
/// How long a refusal leads the detail line.
pub const REFUSAL_NOTE: Duration = Duration::from_secs(10);

/// What the camera draws now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Picture {
    /// The newest decoded frame (new or held).
    Frame,
    /// "Waiting for SRT stream on port {PORT}".
    Waiting,
    /// "This SRT stream uses a codec Videorc can't show ({codec})."
    UnsupportedCodec(String),
}

/// Why the SRT Camera can't listen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListenerTrouble {
    /// The socket could not be made or set up, or the port not opened.
    Port,
    /// The listener was up, then closed or failed to accept.
    Stopped,
    /// libsrt itself did not load.
    Library,
    /// The passphrase did not load from the secret store.
    NoPassphrase,
}

#[derive(Debug, Default)]
pub struct SignalTracker {
    codec: Option<VideoCodec>,
    last_frame_at: Option<Instant>,
    size: Option<(u32, u32)>,
    arrivals: VecDeque<Instant>,
    refusal: Option<(SrtSenderRefusal, Instant)>,
    sender_connected: bool,
    sender_session: u32,
    frames_decoded: u64,
    /// The last access unit that could be decoded arrived then.
    last_unit_at: Option<Instant>,
    /// Why the receiver is not listening. Port, Stopped and Library try
    /// again by themselves (D18); NoPassphrase waits for a setting change,
    /// a renewal or a restart (see `load_saved`).
    listener_trouble: Option<ListenerTrouble>,
    /// Decode failures (errors, or a silent decoder's rebuild) since the
    /// last frame.
    decode_failures: u32,
}

/// Failed decodes in a row that make the detail line blame the decoder.
pub const DECODE_FAILURES_NAMED: u32 = 3;

impl SignalTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// The stream's PMT named its video codec.
    pub fn on_video(&mut self, codec: VideoCodec) {
        self.codec = Some(codec);
    }

    /// A frame was decoded and arrived at `now`.
    pub fn on_frame(&mut self, now: Instant, width: u32, height: u32) {
        self.frames_decoded = self.frames_decoded.saturating_add(1);
        self.decode_failures = 0;
        self.last_frame_at = Some(now);
        self.size = Some((width, height));
        self.arrivals.push_back(now);
        while self
            .arrivals
            .front()
            .is_some_and(|first| now.duration_since(*first) > FPS_WINDOW)
        {
            self.arrivals.pop_front();
        }
    }

    /// The sender left: the hold runs from its last frame. Its codec goes
    /// with it, so the next sender's stream decides the still.
    pub fn on_sender_left(&mut self) {
        self.codec = None;
        self.sender_connected = false;
    }

    /// A new sender: its own session, frame count and frame rate.
    pub fn on_sender_accepted(&mut self) {
        self.refusal = None;
        self.sender_connected = true;
        self.sender_session = self.sender_session.wrapping_add(1);
        self.frames_decoded = 0;
        self.decode_failures = 0;
        self.arrivals.clear();
    }

    #[cfg(test)]
    pub fn decode_failures(&self) -> u32 {
        self.decode_failures
    }

    /// A unit failed to decode, or the decoder stayed silent for the hold;
    /// it is rebuilt at the next key frame.
    pub fn on_decode_failed(&mut self) {
        self.decode_failures = self.decode_failures.saturating_add(1);
    }

    /// The current or last sender (the frame tap logs it).
    #[cfg(debug_assertions)]
    pub fn sender_session(&self) -> u32 {
        self.sender_session
    }

    pub fn on_refusal(&mut self, refusal: SrtSenderRefusal, now: Instant) {
        self.refusal = Some((refusal, now));
    }

    /// An access unit in a codec Videorc decodes arrived, picture or not.
    pub fn on_unit(&mut self, now: Instant) {
        self.last_unit_at = Some(now);
    }

    pub fn on_listener_failed(&mut self, trouble: ListenerTrouble) {
        self.listener_trouble = Some(trouble);
    }

    pub fn on_listening(&mut self) {
        self.listener_trouble = None;
    }

    /// Data arrives, but nothing has decoded for longer than the hold.
    fn data_without_picture(&self, now: Instant) -> bool {
        self.signal(now) == SrtCameraSignal::Waiting
            && self
                .last_unit_at
                .is_some_and(|at| now.saturating_duration_since(at) < RECEIVING_GAP)
    }

    fn since_last_frame(&self, now: Instant) -> Option<Duration> {
        self.last_frame_at
            .map(|last| now.saturating_duration_since(last))
    }

    pub fn signal(&self, now: Instant) -> SrtCameraSignal {
        if let Some(VideoCodec::Unsupported(_)) = self.codec {
            return SrtCameraSignal::UnsupportedCodec;
        }
        match self.since_last_frame(now) {
            Some(gap) if gap < RECEIVING_GAP => SrtCameraSignal::Receiving,
            Some(gap) if gap < HOLD => SrtCameraSignal::Holding,
            _ => SrtCameraSignal::Waiting,
        }
    }

    pub fn picture(&self, now: Instant) -> Picture {
        match self.signal(now) {
            SrtCameraSignal::Receiving | SrtCameraSignal::Holding => Picture::Frame,
            SrtCameraSignal::Waiting => Picture::Waiting,
            SrtCameraSignal::UnsupportedCodec => {
                Picture::UnsupportedCodec(self.codec.map(VideoCodec::label).unwrap_or_default())
            }
        }
    }

    /// Frames per second over the last arrivals, while receiving.
    pub fn fps(&self, now: Instant) -> Option<f64> {
        if self.signal(now) != SrtCameraSignal::Receiving || self.arrivals.len() < 2 {
            return None;
        }
        let first = *self.arrivals.front()?;
        let last = *self.arrivals.back()?;
        let span = last.duration_since(first).as_secs_f64();
        // Half a second of frames first: a start-up burst reads as twice the rate.
        (span >= 0.5).then(|| (self.arrivals.len() - 1) as f64 / span)
    }

    pub fn status(&self, now: Instant, listening: bool) -> SrtCameraStatus {
        let signal = self.signal(now);
        let showing_frames = matches!(
            signal,
            SrtCameraSignal::Receiving | SrtCameraSignal::Holding
        );
        let refusal = self
            .refusal
            .filter(|(_, at)| now.saturating_duration_since(*at) < REFUSAL_NOTE)
            .map(|(refusal, _)| refusal);
        // Whole frames per second, as the line says it: a status that only
        // changes when the line does keeps `srtInput.changed` quiet.
        let fps = self.fps(now).map(f64::round);
        let codec = self.codec.map(VideoCodec::label);
        let (width, height) = match (showing_frames, self.size) {
            (true, Some((width, height))) => (Some(width), Some(height)),
            _ => (None, None),
        };
        let trouble = self.listener_trouble.filter(|_| refusal.is_none());
        let detail = if let Some(trouble) = trouble {
            match trouble {
                ListenerTrouble::Port => "Can't open the port. Trying again.",
                ListenerTrouble::Stopped => "The SRT listener stopped. Trying again.",
                ListenerTrouble::Library => "The SRT library didn't load. Trying again.",
                ListenerTrouble::NoPassphrase => {
                    "The passphrase didn't load. Turn SRT input off and on in Settings → General to try again."
                }
            }
            .to_string()
        } else if refusal.is_none() && self.data_without_picture(now) {
            if self.decode_failures >= DECODE_FAILURES_NAMED {
                "Receiving, but the picture doesn't decode".to_string()
            } else {
                "Receiving, but no picture yet".to_string()
            }
        } else {
            detail_line(signal, refusal, width.zip(height), fps, codec.as_deref())
        };
        SrtCameraStatus {
            listening,
            signal,
            width,
            height,
            fps,
            codec,
            refusal,
            sender_connected: self.sender_connected,
            sender_session: self.sender_session,
            frames_decoded: self.frames_decoded,
            detail,
        }
    }
}

/// D17's detail line.
pub fn detail_line(
    signal: SrtCameraSignal,
    refusal: Option<SrtSenderRefusal>,
    size: Option<(u32, u32)>,
    fps: Option<f64>,
    codec: Option<&str>,
) -> String {
    // A refusal leads only while no feed arrives: a sender that keeps
    // dialling as a pairing check is refused every few seconds, and must not
    // hide a healthy feed (soak, 2026-11-15). The status keeps the refusal.
    match refusal.filter(|_| signal != SrtCameraSignal::Receiving) {
        Some(SrtSenderRefusal::WrongPassphrase) => {
            return "Sender refused: wrong passphrase".to_string();
        }
        Some(SrtSenderRefusal::SecondSender) => return "Second sender refused".to_string(),
        None => {}
    }
    match signal {
        SrtCameraSignal::Waiting => "Waiting".to_string(),
        SrtCameraSignal::Holding => "No frames: holding the last one".to_string(),
        SrtCameraSignal::UnsupportedCodec => unsupported_codec_line(codec.unwrap_or("")),
        SrtCameraSignal::Receiving => {
            let mut parts = vec!["Receiving".to_string()];
            if let Some((width, height)) = size {
                parts.push(format!("{width} × {height}"));
            }
            if let Some(fps) = fps {
                parts.push(format!("{} fps", fps.round() as u32));
            }
            if let Some(codec) = codec {
                parts.push(codec.to_string());
            }
            parts.join(" · ")
        }
    }
}

pub fn waiting_line(port: u16) -> String {
    format!("Waiting for SRT stream on port {port}")
}

pub fn unsupported_codec_line(codec: &str) -> String {
    format!("This SRT stream uses a codec Videorc can't show ({codec}).")
}

/// One sender at a time (D14), healing by itself (D18). Ids are the sockets
/// libsrt hands out. Another sender gets in when the current one has sent
/// nothing for [`HOLD`] (it died without a goodbye, and would otherwise keep
/// the camera until SRT's idle timeout), or at once when it calls from the
/// current sender's own address: a redial.
///
/// libsrt runs its listen callback before it checks the passphrase, so the
/// callback (`admit`) changes nothing: it only tells another address that the
/// camera is busy. Every change waits for `accepted`, which libsrt reaches
/// only with the right passphrase, so a caller with a wrong one never moves
/// the camera.
#[derive(Debug, Default, Clone)]
pub struct SenderGate {
    active: Option<ActiveSender>,
}

#[derive(Debug, Clone, Copy)]
struct ActiveSender {
    socket: i32,
    heard: Instant,
    peer: Option<IpAddr>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    Admit,
    Refuse,
}

/// What `accept` returning a sender means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Acceptance {
    /// The camera was free: this sender has it.
    Took,
    /// The sender before it had gone quiet or redialed: close that one,
    /// this one has it.
    Replaced(i32),
    /// Another sender has the camera: close this one.
    Refused,
}

impl SenderGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// The current sender keeps the camera from a caller at `peer`: it is
    /// live, and the caller is not its own redial.
    fn active_holds(&self, peer: Option<IpAddr>, now: Instant) -> bool {
        self.active.is_some_and(|active| {
            let live = now.saturating_duration_since(active.heard) < HOLD;
            let redial = peer.is_some() && peer == active.peer;
            live && !redial
        })
    }

    /// libsrt's listen callback: a caller at `peer` wants in. Busy (1402)
    /// while another address's sender is live; nothing else is decided here.
    pub fn admit(&self, peer: Option<IpAddr>, now: Instant) -> Admission {
        if self.active_holds(peer, now) {
            Admission::Refuse
        } else {
            Admission::Admit
        }
    }

    /// `accept` returned this sender, calling from `peer`: its passphrase was
    /// right. A redial or a caller on a free or quiet camera takes it; any
    /// other caller is refused while the current sender is live (two good
    /// callers from different addresses: the first accepted wins).
    pub fn accepted(&mut self, sender: i32, peer: Option<IpAddr>, now: Instant) -> Acceptance {
        if self.active_holds(peer, now) {
            return Acceptance::Refused;
        }
        let previous = self.active.replace(ActiveSender {
            socket: sender,
            heard: now,
            peer,
        });
        previous.map_or(Acceptance::Took, |previous| {
            Acceptance::Replaced(previous.socket)
        })
    }

    /// The active sender sent data at `now`.
    pub fn heard(&mut self, sender: i32, now: Instant) {
        if let Some(active) = self.active.as_mut()
            && active.socket == sender
        {
            active.heard = active.heard.max(now);
        }
    }

    /// The sender left, with or without sending anything (a pairing check).
    pub fn left(&mut self, sender: i32) {
        if self.active.is_some_and(|active| active.socket == sender) {
            self.active = None;
        }
    }

    #[cfg(test)]
    pub fn active(&self) -> Option<i32> {
        self.active.map(|active| active.socket)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    /// A distinct address per sender, unless a test says otherwise.
    fn peer(last: u8) -> Option<std::net::IpAddr> {
        Some(std::net::IpAddr::V4(std::net::Ipv4Addr::new(
            192, 168, 1, last,
        )))
    }

    #[test]
    fn srt_gate_the_same_peer_takes_over_at_once() {
        let now = Instant::now();
        let mut gate = SenderGate::new();
        assert_eq!(gate.accepted(1, peer(7), now), Acceptance::Took);
        gate.heard(1, now + ms(100));
        // The sender redials from the same address while its dead socket
        // still looks live: the new connection takes over at once.
        assert_eq!(gate.admit(peer(7), now + ms(200)), Admission::Admit);
        assert_eq!(
            gate.accepted(2, peer(7), now + ms(200)),
            Acceptance::Replaced(1)
        );
        assert_eq!(gate.active(), Some(2));
        // Another address still waits for the 2 s silent rule.
        assert_eq!(gate.admit(peer(8), now + ms(300)), Admission::Refuse);
        // An address libsrt did not give never counts as the same peer.
        assert_eq!(gate.admit(None, now + ms(300)), Admission::Refuse);
    }

    #[test]
    fn srt_signal_counts_each_senders_own_frames() {
        let start = Instant::now();
        let mut tracker = SignalTracker::new();
        tracker.on_sender_accepted();
        for frame in 0..10 {
            tracker.on_frame(start + ms(frame * 40), 1280, 720);
        }
        let first = tracker.status(start + ms(400), true);
        assert_eq!(first.sender_session, 1);
        assert_eq!(first.frames_decoded, 10);
        // A new sender right after the last frame: the old picture still
        // looks live, but the new sender has decoded nothing yet.
        tracker.on_sender_left();
        tracker.on_sender_accepted();
        let next = tracker.status(start + ms(420), true);
        assert_eq!(next.sender_session, 2);
        assert_eq!(next.frames_decoded, 0);
        assert_eq!(next.fps, None, "the rate is the new sender's alone");
        tracker.on_frame(start + ms(440), 1280, 720);
        tracker.on_frame(start + ms(480), 1280, 720);
        assert_eq!(tracker.status(start + ms(480), true).frames_decoded, 2);
    }

    #[test]
    fn srt_signal_data_without_pictures_shows_the_still_and_says_so() {
        let start = Instant::now();
        let mut tracker = SignalTracker::new();
        tracker.on_video(VideoCodec::Hevc);
        tracker.on_frame(start, 1920, 1080);
        // Data keeps coming, nothing decodes: never a frozen frame past 2 s.
        for step in 0..30 {
            tracker.on_unit(start + ms(step * 100));
        }
        let now = start + ms(2950);
        assert_eq!(tracker.picture(now), Picture::Waiting);
        assert_eq!(
            tracker.status(now, true).detail,
            "Receiving, but no picture yet"
        );
        // Once data stops too, it is plain waiting again.
        assert_eq!(tracker.status(now + ms(1000), true).detail, "Waiting");
    }

    #[test]
    fn srt_signal_names_a_decoder_that_keeps_failing() {
        let start = Instant::now();
        let mut tracker = SignalTracker::new();
        tracker.on_video(VideoCodec::Hevc);
        tracker.on_sender_accepted();
        tracker.on_unit(start);
        for _ in 1..DECODE_FAILURES_NAMED {
            tracker.on_decode_failed();
        }
        let detail = |tracker: &SignalTracker| tracker.status(start, true).detail;
        assert_eq!(detail(&tracker), "Receiving, but no picture yet");
        tracker.on_decode_failed();
        assert_eq!(
            detail(&tracker),
            "Receiving, but the picture doesn't decode"
        );
        // A frame clears the count: one failure after it is not enough.
        tracker.on_frame(start, 1920, 1080);
        tracker.on_decode_failed();
        let later = start + ms(3000);
        tracker.on_unit(later);
        assert_eq!(
            tracker.status(later, true).detail,
            "Receiving, but no picture yet"
        );
        // A new sender clears it too.
        for _ in 0..DECODE_FAILURES_NAMED {
            tracker.on_decode_failed();
        }
        tracker.on_sender_accepted();
        assert_eq!(
            tracker.status(later, true).detail,
            "Receiving, but no picture yet"
        );
    }

    #[test]
    fn srt_signal_says_when_the_port_cannot_open() {
        let now = Instant::now();
        let mut tracker = SignalTracker::new();
        tracker.on_listener_failed(ListenerTrouble::Port);
        assert_eq!(
            tracker.status(now, false).detail,
            "Can't open the port. Trying again."
        );
        tracker.on_listener_failed(ListenerTrouble::Stopped);
        assert_eq!(
            tracker.status(now, false).detail,
            "The SRT listener stopped. Trying again."
        );
        tracker.on_listener_failed(ListenerTrouble::Library);
        assert_eq!(
            tracker.status(now, false).detail,
            "The SRT library didn't load. Trying again."
        );
        tracker.on_listener_failed(ListenerTrouble::NoPassphrase);
        assert_eq!(
            tracker.status(now, false).detail,
            "The passphrase didn't load. Turn SRT input off and on in Settings → General to try again."
        );
        tracker.on_listening();
        assert_eq!(tracker.status(now, true).detail, "Waiting");
    }

    #[test]
    fn srt_signal_waits_until_the_first_frame() {
        let start = Instant::now();
        let tracker = SignalTracker::new();
        assert_eq!(tracker.signal(start), SrtCameraSignal::Waiting);
        assert_eq!(tracker.picture(start), Picture::Waiting);
        assert_eq!(tracker.status(start, true).detail, "Waiting");
    }

    #[test]
    fn srt_signal_receives_then_holds_two_seconds_then_waits() {
        let start = Instant::now();
        let mut tracker = SignalTracker::new();
        tracker.on_video(VideoCodec::Hevc);
        tracker.on_frame(start, 1920, 1080);
        assert_eq!(tracker.signal(start + ms(100)), SrtCameraSignal::Receiving);
        assert_eq!(tracker.signal(start + ms(600)), SrtCameraSignal::Holding);
        assert_eq!(tracker.picture(start + ms(1999)), Picture::Frame);
        assert_eq!(tracker.signal(start + ms(2000)), SrtCameraSignal::Waiting);
        assert_eq!(tracker.picture(start + ms(2000)), Picture::Waiting);
    }

    #[test]
    fn srt_signal_recovers_by_itself_on_the_next_frame() {
        let start = Instant::now();
        let mut tracker = SignalTracker::new();
        tracker.on_frame(start, 1280, 720);
        tracker.on_sender_left();
        assert_eq!(tracker.picture(start + ms(5000)), Picture::Waiting);
        tracker.on_frame(start + ms(5000), 1280, 720);
        assert_eq!(tracker.picture(start + ms(5010)), Picture::Frame);
    }

    #[test]
    fn srt_signal_measures_fps_from_arrivals_not_pts() {
        let start = Instant::now();
        let mut tracker = SignalTracker::new();
        tracker.on_video(VideoCodec::Hevc);
        for frame in 0..26 {
            tracker.on_frame(start + ms(frame * 40), 3840, 2160);
        }
        let now = start + ms(25 * 40 + 5);
        assert_eq!(tracker.fps(now).map(f64::round), Some(25.0));
        assert_eq!(
            tracker.status(now, true).detail,
            "Receiving · 3840 × 2160 · 25 fps · HEVC"
        );
    }

    #[test]
    fn srt_signal_holding_and_codec_lines() {
        assert_eq!(
            detail_line(SrtCameraSignal::Holding, None, None, None, None),
            "No frames: holding the last one"
        );
        assert_eq!(
            detail_line(
                SrtCameraSignal::UnsupportedCodec,
                None,
                None,
                None,
                Some("MPEG-2")
            ),
            "This SRT stream uses a codec Videorc can't show (MPEG-2)."
        );
        assert_eq!(waiting_line(9000), "Waiting for SRT stream on port 9000");
    }

    #[test]
    fn srt_signal_unknown_codec_shows_the_codec_still() {
        let start = Instant::now();
        let mut tracker = SignalTracker::new();
        tracker.on_video(VideoCodec::Unsupported(0x02));
        assert_eq!(
            tracker.picture(start),
            Picture::UnsupportedCodec("MPEG-2".to_string())
        );
        tracker.on_sender_left();
        assert_eq!(tracker.picture(start), Picture::Waiting);
    }

    #[test]
    fn srt_signal_refusal_leads_the_line_for_a_while() {
        let start = Instant::now();
        let mut tracker = SignalTracker::new();
        tracker.on_refusal(SrtSenderRefusal::WrongPassphrase, start);
        let status = tracker.status(start + ms(10), true);
        assert_eq!(status.detail, "Sender refused: wrong passphrase");
        assert_eq!(status.refusal, Some(SrtSenderRefusal::WrongPassphrase));
        assert_eq!(tracker.status(start + REFUSAL_NOTE, true).detail, "Waiting");
        tracker.on_refusal(SrtSenderRefusal::SecondSender, start);
        assert_eq!(tracker.status(start, true).detail, "Second sender refused");
        tracker.on_sender_accepted();
        assert_eq!(tracker.status(start, true).refusal, None);
    }

    /// Soak, 2026-11-15: a controller dials every 2 s as a pairing check
    /// and is refused as busy, so the refusal led the line for the whole
    /// stream and hid a healthy feed. While frames arrive, the line says
    /// so; with no feed, the refusal still leads. The refusal itself stays
    /// in the status either way.
    #[test]
    fn srt_signal_a_refusal_never_hides_a_receiving_feed() {
        let start = Instant::now();
        let mut tracker = SignalTracker::new();
        tracker.on_sender_accepted();
        tracker.on_video(VideoCodec::Hevc);
        for frame in 0..30 {
            tracker.on_frame(start + ms(frame * 33), 1920, 1080);
        }
        let now = start + ms(30 * 33);
        tracker.on_refusal(SrtSenderRefusal::SecondSender, now);
        let receiving = tracker.status(now + ms(10), true);
        assert_eq!(receiving.signal, SrtCameraSignal::Receiving);
        assert!(
            receiving.detail.starts_with("Receiving · 1920 × 1080 ·"),
            "{}",
            receiving.detail
        );
        assert!(receiving.detail.ends_with("· HEVC"), "{}", receiving.detail);
        assert_eq!(receiving.refusal, Some(SrtSenderRefusal::SecondSender));

        // No feed: the refusal leads, so the streamer sees why.
        let mut idle = SignalTracker::new();
        idle.on_refusal(SrtSenderRefusal::SecondSender, start);
        let waiting = idle.status(start + ms(10), true);
        assert_eq!(waiting.detail, "Second sender refused");
        assert_eq!(waiting.refusal, Some(SrtSenderRefusal::SecondSender));
    }

    /// Live QA, 2026-11-15: after the sender quit, Sources said "Receiving"
    /// beside "Second sender refused". The status's signal leaves Receiving
    /// as soon as frames stop: holding for the gap, then waiting, and the
    /// refusal leads the line through both (the badge follows this signal).
    #[test]
    fn srt_signal_leaves_receiving_when_frames_stop_and_a_refusal_leads() {
        let start = Instant::now();
        let mut tracker = SignalTracker::new();
        tracker.on_sender_accepted();
        tracker.on_video(VideoCodec::Hevc);
        for frame in 0..30 {
            tracker.on_frame(start + ms(frame * 33), 1920, 1080);
        }
        let last = start + ms(29 * 33);
        tracker.on_refusal(SrtSenderRefusal::SecondSender, last + ms(100));
        let gap = tracker.status(last + ms(600), true);
        assert_eq!(gap.signal, SrtCameraSignal::Holding);
        assert_eq!(gap.detail, "Second sender refused");
        let after = tracker.status(last + HOLD + ms(10), true);
        assert_eq!(after.signal, SrtCameraSignal::Waiting);
        assert_eq!(after.detail, "Second sender refused");
    }

    /// Live QA, 2026-11-15: the first status after a sender connected read
    /// 59 fps at 1080p30, from two frames of a start-up burst. The rate waits
    /// for half a second of frames.
    #[test]
    fn srt_signal_says_no_rate_until_half_a_second_of_frames() {
        let start = Instant::now();
        let mut tracker = SignalTracker::new();
        tracker.on_video(VideoCodec::Hevc);
        tracker.on_frame(start, 1920, 1080);
        tracker.on_frame(start + ms(17), 1920, 1080);
        assert_eq!(tracker.fps(start + ms(20)), None);
        assert_eq!(
            tracker.status(start + ms(20), true).detail,
            "Receiving · 1920 × 1080 · HEVC"
        );
    }

    #[test]
    fn srt_signal_says_whether_a_sender_is_connected() {
        let now = Instant::now();
        let mut tracker = SignalTracker::new();
        assert!(!tracker.status(now, true).sender_connected);
        // A pairing check: accepted, then gone without a frame.
        tracker.on_sender_accepted();
        let accepted = tracker.status(now, true);
        assert!(accepted.sender_connected);
        assert_eq!(accepted.signal, SrtCameraSignal::Waiting);
        tracker.on_sender_left();
        assert!(!tracker.status(now, true).sender_connected);
    }

    #[test]
    fn srt_gate_keeps_the_first_sender_and_refuses_a_second() {
        let now = Instant::now();
        let mut gate = SenderGate::new();
        assert_eq!(gate.admit(peer(1), now), Admission::Admit);
        assert_eq!(gate.accepted(1, peer(1), now), Acceptance::Took);
        gate.heard(1, now + ms(1000));
        assert_eq!(gate.admit(peer(2), now + ms(1500)), Admission::Refuse);
        gate.left(1);
        assert_eq!(gate.admit(peer(2), now + ms(1600)), Admission::Admit);
        assert_eq!(gate.accepted(2, peer(2), now + ms(1600)), Acceptance::Took);
        assert_eq!(gate.active(), Some(2));
    }

    #[test]
    fn srt_gate_two_good_callers_at_once_the_first_accepted_wins() {
        let now = Instant::now();
        let mut gate = SenderGate::new();
        assert_eq!(gate.admit(peer(1), now), Admission::Admit);
        assert_eq!(gate.admit(peer(2), now), Admission::Admit);
        assert_eq!(gate.accepted(2, peer(2), now), Acceptance::Took);
        assert_eq!(gate.accepted(1, peer(1), now + ms(10)), Acceptance::Refused);
        assert_eq!(gate.active(), Some(2));
    }

    #[test]
    fn srt_gate_a_pairing_check_frees_the_camera_at_once() {
        let now = Instant::now();
        let mut gate = SenderGate::new();
        assert_eq!(gate.accepted(1, peer(1), now), Acceptance::Took);
        gate.left(1);
        assert_eq!(gate.active(), None);
        assert_eq!(gate.admit(peer(2), now), Admission::Admit);
    }

    #[test]
    fn srt_gate_a_sender_gone_quiet_gives_way_to_the_next() {
        let now = Instant::now();
        let mut gate = SenderGate::new();
        gate.accepted(1, peer(1), now);
        gate.heard(1, now + ms(500));
        // Died without a goodbye: silent for the hold, it no longer keeps it.
        let later = now + ms(500) + HOLD;
        assert_eq!(gate.admit(peer(2), later), Admission::Admit);
        assert_eq!(gate.accepted(2, peer(2), later), Acceptance::Replaced(1));
        assert_eq!(gate.active(), Some(2));
        gate.left(1);
        assert_eq!(
            gate.active(),
            Some(2),
            "the old socket's close changes nothing"
        );
    }

    #[test]
    fn srt_gate_another_address_after_one_second_of_silence_is_busy() {
        let now = Instant::now();
        let mut gate = SenderGate::new();
        gate.accepted(1, peer(1), now);
        assert_eq!(gate.admit(peer(2), now + ms(1000)), Admission::Refuse);
        assert_eq!(gate.active(), Some(1));
    }

    #[test]
    fn srt_gate_a_pairing_check_then_the_real_sender_from_the_same_address() {
        let now = Instant::now();
        let mut gate = SenderGate::new();
        assert_eq!(gate.accepted(1, peer(1), now), Acceptance::Took);
        gate.left(1);
        assert_eq!(gate.admit(peer(1), now + ms(100)), Admission::Admit);
        assert_eq!(gate.accepted(2, peer(1), now + ms(200)), Acceptance::Took);
        assert_eq!(gate.active(), Some(2));
    }

    #[test]
    fn srt_gate_two_callers_from_one_address_leave_exactly_one_sender() {
        for (first, second) in [(1, 2), (2, 1)] {
            let now = Instant::now();
            let mut gate = SenderGate::new();
            assert_eq!(gate.accepted(first, peer(1), now), Acceptance::Took);
            assert_eq!(
                gate.accepted(second, peer(1), now + ms(10)),
                Acceptance::Replaced(first),
                "the listener closes the one replaced"
            );
            gate.left(first);
            assert_eq!(gate.active(), Some(second));
        }
    }
}
