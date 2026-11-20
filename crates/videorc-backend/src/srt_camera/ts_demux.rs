//! A small MPEG-TS demuxer for the SRT Camera (plan 255): PAT, PMT and the
//! first video stream's PES. Every other PID, audio included, is dropped
//! (D10). No FFmpeg in this path (D12).

const TS_PACKET_LEN: usize = 188;
const SYNC_BYTE: u8 = 0x47;
const PAT_PID: u16 = 0x0000;
const NULL_PID: u16 = 0x1fff;
const PTS_MODULO: u64 = 1 << 33;
/// A video PES with no length ends at the next payload start; a broken
/// stream must not grow this without bound.
const MAX_PES_BYTES: usize = 32 * 1024 * 1024;
/// The room a PES buffer keeps between units: a 4K key frame several times
/// over. A unit that grew it past this gives the excess back.
const PES_KEEP_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCodec {
    H264,
    Hevc,
    /// A video stream type Videorc can't show (D12), by its PMT stream type.
    Unsupported(u8),
}

impl VideoCodec {
    /// The PMT stream type of a video stream, or None for audio and data.
    pub fn from_stream_type(stream_type: u8) -> Option<Self> {
        match stream_type {
            0x1b => Some(Self::H264),
            0x24 => Some(Self::Hevc),
            0x01 | 0x02 | 0x10 | 0x1e | 0x1f | 0x20 | 0x33 | 0x42 | 0xd1 | 0xea => {
                Some(Self::Unsupported(stream_type))
            }
            _ => None,
        }
    }

    /// The codec's name, as the status line and the codec still say it.
    pub fn label(self) -> String {
        match self {
            Self::H264 => "H.264".to_string(),
            Self::Hevc => "HEVC".to_string(),
            Self::Unsupported(0x01) => "MPEG-1".to_string(),
            Self::Unsupported(0x02) => "MPEG-2".to_string(),
            Self::Unsupported(0x10) => "MPEG-4".to_string(),
            Self::Unsupported(0x33) => "VVC".to_string(),
            Self::Unsupported(0x42) => "AVS".to_string(),
            Self::Unsupported(0xd1) => "Dirac".to_string(),
            Self::Unsupported(0xea) => "VC-1".to_string(),
            Self::Unsupported(other) => format!("stream type 0x{other:02x}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DemuxEvent {
    /// The PMT named the video stream, or changed it.
    Video(VideoCodec),
    /// One video PES: an access unit in Annex B form.
    AccessUnit {
        codec: VideoCodec,
        /// 90 kHz, unwrapped across the 33-bit wrap.
        pts: Option<u64>,
        data: Vec<u8>,
    },
    /// Video packets went missing: the PES in progress was dropped, so the
    /// decoder should wait for the next key frame.
    Discontinuity,
}

#[derive(Debug, Default)]
struct SectionBuffer {
    bytes: Vec<u8>,
    active: bool,
}

#[derive(Debug, Default)]
pub struct TsDemuxer {
    carry: Vec<u8>,
    pat: SectionBuffer,
    pmt_pid: Option<u16>,
    pmt: SectionBuffer,
    video: Option<(u16, VideoCodec)>,
    video_continuity: Option<u8>,
    /// The last video packet taken, as `duplicate_key` reads it, while the
    /// next packet may still repeat it: a true repeat (the same packet
    /// again, PCR aside) from a gap of 16 that brings the counter round.
    last_video_packet: Option<[u8; TS_PACKET_LEN]>,
    pes: Vec<u8>,
    pes_open: bool,
    last_pts: Option<(u64, u64)>,
}

impl TsDemuxer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed bytes in any chunking; events come out in stream order.
    pub fn push(&mut self, bytes: &[u8], events: &mut Vec<DemuxEvent>) {
        self.carry.extend_from_slice(bytes);
        let mut offset = 0;
        while self.carry.len() - offset >= TS_PACKET_LEN {
            let next = offset + TS_PACKET_LEN;
            let next_in_sync = next >= self.carry.len() || self.carry[next] == SYNC_BYTE;
            if self.carry[offset] != SYNC_BYTE || !next_in_sync {
                offset += 1;
                continue;
            }
            let packet: [u8; TS_PACKET_LEN] = self.carry[offset..offset + TS_PACKET_LEN]
                .try_into()
                .expect("a full packet");
            self.packet(&packet, events);
            offset += TS_PACKET_LEN;
        }
        self.carry.drain(..offset);
    }

    fn packet(&mut self, packet: &[u8; TS_PACKET_LEN], events: &mut Vec<DemuxEvent>) {
        let transport_error = packet[1] & 0x80 != 0;
        let unit_start = packet[1] & 0x40 != 0;
        let pid = (u16::from(packet[1] & 0x1f) << 8) | u16::from(packet[2]);
        let adaptation = (packet[3] >> 4) & 0x03;
        let continuity = packet[3] & 0x0f;
        if pid == NULL_PID {
            return;
        }
        let mut payload_start = 4;
        let mut discontinuity_flag = false;
        if adaptation & 0x02 != 0 {
            let length = usize::from(packet[4]);
            if length > 0 {
                discontinuity_flag = packet[5] & 0x80 != 0;
            }
            payload_start = 5 + length;
        }
        let payload = if adaptation & 0x01 != 0 && payload_start < TS_PACKET_LEN {
            &packet[payload_start..]
        } else {
            &[][..]
        };

        if pid == PAT_PID {
            if let Some(section) = collect_section(&mut self.pat, unit_start, payload)
                && let Some(pmt_pid) = parse_pat(&section)
            {
                self.pmt_pid = Some(pmt_pid);
            }
            return;
        }
        if Some(pid) == self.pmt_pid {
            if let Some(section) = collect_section(&mut self.pmt, unit_start, payload)
                && let Some(video) = parse_pmt(&section)
                && self.video != Some(video)
            {
                self.flush_pes(events);
                self.video = Some(video);
                self.video_continuity = None;
                events.push(DemuxEvent::Video(video.1));
            }
            return;
        }
        let Some((video_pid, _)) = self.video else {
            return;
        };
        if pid != video_pid {
            return;
        }
        if discontinuity_flag {
            // The sender says what follows does not continue what came
            // before (a reset counter, a splice), with or without a payload
            // in this packet: the open PES ends here unread, the decoder
            // waits for a key frame, and data resumes at the next PES start.
            self.reset_pes();
            self.video_continuity = None;
            events.push(DemuxEvent::Discontinuity);
        }
        if adaptation & 0x01 == 0 {
            // No payload: the counter stays, but a repeat must follow its
            // original directly.
            self.last_video_packet = None;
            return;
        }
        if transport_error {
            self.last_video_packet = None;
            self.drop_pes(events);
            return;
        }
        let key = duplicate_key(packet);
        match self.video_continuity {
            // The same counter: a repeat when it is the same packet again,
            // else 16 packets went missing.
            Some(last) if last == continuity => {
                if self.last_video_packet == Some(key) {
                    return;
                }
                self.drop_pes(events);
            }
            Some(last) if (last + 1) & 0x0f != continuity => self.drop_pes(events),
            _ => {}
        }
        self.video_continuity = Some(continuity);
        self.last_video_packet = Some(key);

        if unit_start {
            self.flush_pes(events);
            self.pes_open = true;
        }
        if self.pes_open {
            self.pes.extend_from_slice(payload);
            if self.pes.len() > MAX_PES_BYTES {
                self.drop_pes(events);
            } else if pes_complete(&self.pes) {
                self.flush_pes(events);
            }
        }
    }

    /// Video went missing or arrived broken: whatever was being gathered is
    /// dropped, and the decoder is told even when no PES was open, since a
    /// whole PES may be the part that went missing.
    fn drop_pes(&mut self, events: &mut Vec<DemuxEvent>) {
        events.push(DemuxEvent::Discontinuity);
        self.reset_pes();
    }

    /// Ready for the next PES. The buffer keeps its room for the next unit,
    /// but an outsized one gives the excess back.
    fn reset_pes(&mut self) {
        self.pes.clear();
        self.pes_open = false;
        if self.pes.capacity() > PES_KEEP_BYTES {
            self.pes.shrink_to(PES_KEEP_BYTES);
        }
    }

    fn flush_pes(&mut self, events: &mut Vec<DemuxEvent>) {
        if !self.pes_open {
            return;
        }
        // A PES that says how long it is but ended short lost its tail; an
        // unbounded one ends at the next start.
        if pes_ends_short(&self.pes) {
            self.drop_pes(events);
            return;
        }
        // The unit is copied out and the buffer kept, so the next one reuses
        // its room instead of growing a new one from nothing every frame.
        let parsed = parse_pes(&self.pes).map(|(raw_pts, data)| (raw_pts, data.to_vec()));
        self.reset_pes();
        let Some((_, codec)) = self.video else {
            return;
        };
        let Some((raw_pts, data)) = parsed else {
            return;
        };
        if data.is_empty() {
            return;
        }
        let pts = raw_pts.map(|raw| self.unwrap_pts(raw));
        events.push(DemuxEvent::AccessUnit { codec, pts, data });
    }

    fn unwrap_pts(&mut self, raw: u64) -> u64 {
        let unwrapped = match self.last_pts {
            None => raw,
            Some((last_raw, last_unwrapped)) => {
                let forward = (raw + PTS_MODULO - last_raw) % PTS_MODULO;
                if forward < PTS_MODULO / 2 {
                    last_unwrapped + forward
                } else {
                    last_unwrapped.saturating_sub(PTS_MODULO - forward)
                }
            }
        };
        self.last_pts = Some((raw, unwrapped));
        unwrapped
    }
}

/// Gathers one PSI section across packets; Some when it is whole.
fn collect_section(
    buffer: &mut SectionBuffer,
    unit_start: bool,
    payload: &[u8],
) -> Option<Vec<u8>> {
    if unit_start {
        let pointer = usize::from(*payload.first()?);
        buffer.bytes.clear();
        buffer.bytes.extend_from_slice(payload.get(1 + pointer..)?);
        buffer.active = true;
    } else if buffer.active {
        buffer.bytes.extend_from_slice(payload);
    } else {
        return None;
    }
    if buffer.bytes.len() < 3 {
        return None;
    }
    let total = 3 + ((usize::from(buffer.bytes[1] & 0x0f) << 8) | usize::from(buffer.bytes[2]));
    if buffer.bytes.len() < total {
        return None;
    }
    buffer.active = false;
    Some(buffer.bytes[..total].to_vec())
}

/// The first program's PMT PID.
fn parse_pat(section: &[u8]) -> Option<u16> {
    if section.first() != Some(&0x00) || section.len() < 12 {
        return None;
    }
    let programs = section.get(8..section.len() - 4)?;
    programs.chunks_exact(4).find_map(|entry| {
        let program = u16::from_be_bytes([entry[0], entry[1]]);
        (program != 0).then(|| (u16::from(entry[2] & 0x1f) << 8) | u16::from(entry[3]))
    })
}

/// The first video stream's PID and codec.
fn parse_pmt(section: &[u8]) -> Option<(u16, VideoCodec)> {
    if section.first() != Some(&0x02) || section.len() < 16 {
        return None;
    }
    let end = section.len() - 4;
    let program_info = (usize::from(section[10] & 0x0f) << 8) | usize::from(section[11]);
    let mut offset = 12 + program_info;
    while offset + 5 <= end {
        let stream_type = section[offset];
        let pid = (u16::from(section[offset + 1] & 0x1f) << 8) | u16::from(section[offset + 2]);
        let info =
            (usize::from(section[offset + 3] & 0x0f) << 8) | usize::from(section[offset + 4]);
        if let Some(codec) = VideoCodec::from_stream_type(stream_type) {
            return Some((pid, codec));
        }
        offset += 5 + info;
    }
    None
}

/// True when the PES says how long it is and all of it is here.
fn pes_complete(pes: &[u8]) -> bool {
    if pes.len() < 6 {
        return false;
    }
    let length = usize::from(u16::from_be_bytes([pes[4], pes[5]]));
    length != 0 && pes.len() >= 6 + length
}

/// A packet as a repeat must match it: every byte but the PCR, which a
/// legal repeat may carry anew (H.222.0 2.4.3.3).
fn duplicate_key(packet: &[u8; TS_PACKET_LEN]) -> [u8; TS_PACKET_LEN] {
    let mut key = *packet;
    let has_adaptation = packet[3] & 0x20 != 0;
    let length = usize::from(packet[4]);
    if has_adaptation && length >= 7 && packet[5] & 0x10 != 0 {
        key[6..12].fill(0);
    }
    key
}

/// True when the PES says how long it is and some of it never came.
fn pes_ends_short(pes: &[u8]) -> bool {
    if pes.len() < 6 {
        return false;
    }
    let length = usize::from(u16::from_be_bytes([pes[4], pes[5]]));
    length != 0 && pes.len() < 6 + length
}

/// The PTS and the payload of one PES packet.
fn parse_pes(pes: &[u8]) -> Option<(Option<u64>, &[u8])> {
    if pes.len() < 9 || pes[..3] != [0, 0, 1] {
        return None;
    }
    let declared = usize::from(u16::from_be_bytes([pes[4], pes[5]]));
    let end = if declared == 0 {
        pes.len()
    } else {
        (6 + declared).min(pes.len())
    };
    let header_len = usize::from(pes[8]);
    let start = 9 + header_len;
    if start > end {
        return None;
    }
    let pts = (pes[7] & 0x80 != 0 && header_len >= 5).then(|| read_timestamp(&pes[9..14]));
    Some((pts, &pes[start..end]))
}

fn read_timestamp(bytes: &[u8]) -> u64 {
    (u64::from((bytes[0] >> 1) & 0x07) << 30)
        | (u64::from(bytes[1]) << 22)
        | (u64::from(bytes[2] >> 1) << 15)
        | (u64::from(bytes[3]) << 7)
        | u64::from(bytes[4] >> 1)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const VIDEO_PID: u16 = 0x100;
    const AUDIO_PID: u16 = 0x101;
    const PMT_PID: u16 = 0x1000;

    fn packet(pid: u16, unit_start: bool, continuity: u8, payload: &[u8]) -> Vec<u8> {
        assert!(payload.len() <= 184);
        let mut out = vec![
            SYNC_BYTE,
            (if unit_start { 0x40 } else { 0 }) | ((pid >> 8) as u8 & 0x1f),
            pid as u8,
            0,
        ];
        if payload.len() == 184 {
            out[3] = 0x10 | (continuity & 0x0f);
            out.extend_from_slice(payload);
        } else {
            out[3] = 0x30 | (continuity & 0x0f);
            let stuffing = 184 - payload.len() - 1;
            out.push(stuffing as u8);
            if stuffing > 0 {
                out.push(0);
                out.extend(std::iter::repeat_n(0xff, stuffing - 1));
            }
            out.extend_from_slice(payload);
        }
        assert_eq!(out.len(), TS_PACKET_LEN);
        out
    }

    fn psi(table: &[u8]) -> Vec<u8> {
        let mut out = vec![0];
        out.extend_from_slice(table);
        out.extend_from_slice(&[0, 0, 0, 0]);
        out
    }

    fn pat() -> Vec<u8> {
        let section_length = 5 + 4 + 4;
        psi(&[
            0x00,
            0xb0,
            section_length,
            0,
            1,
            0xc1,
            0,
            0,
            0,
            1,
            0xe0 | (PMT_PID >> 8) as u8,
            PMT_PID as u8,
        ])
    }

    fn pmt(streams: &[(u8, u16)]) -> Vec<u8> {
        let mut body = vec![0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00];
        for (stream_type, pid) in streams {
            body.extend_from_slice(&[*stream_type, 0xe0 | (pid >> 8) as u8, *pid as u8, 0xf0, 0]);
        }
        let mut table = vec![0x02, 0xb0, (body.len() + 4) as u8];
        table.extend_from_slice(&body);
        psi(&table)
    }

    fn pes(pts: u64, data: &[u8]) -> Vec<u8> {
        let mut out = vec![0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5];
        out.extend_from_slice(&[
            0x21 | (((pts >> 30) & 0x07) << 1) as u8,
            (pts >> 22) as u8,
            ((((pts >> 15) & 0x7f) << 1) | 1) as u8,
            (pts >> 7) as u8,
            (((pts & 0x7f) << 1) | 1) as u8,
        ]);
        out.extend_from_slice(data);
        out
    }

    /// A TS with one H.264 or HEVC video PID, split into packets.
    pub fn stream(stream_type: u8, frames: &[(u64, Vec<u8>)]) -> Vec<u8> {
        let mut out = packet(PAT_PID, true, 0, &pat());
        out.extend(packet(
            PMT_PID,
            true,
            0,
            &pmt(&[(0x0f, AUDIO_PID), (stream_type, VIDEO_PID)]),
        ));
        let mut continuity = 0u8;
        for (pts, data) in frames {
            let bytes = pes(*pts, data);
            for (index, chunk) in bytes.chunks(184).enumerate() {
                out.extend(packet(VIDEO_PID, index == 0, continuity, chunk));
                continuity = (continuity + 1) & 0x0f;
            }
        }
        out
    }

    fn demux(bytes: &[u8]) -> Vec<DemuxEvent> {
        let mut demuxer = TsDemuxer::new();
        let mut events = Vec::new();
        demuxer.push(bytes, &mut events);
        events
    }

    fn units(events: &[DemuxEvent]) -> Vec<(Option<u64>, Vec<u8>)> {
        events
            .iter()
            .filter_map(|event| match event {
                DemuxEvent::AccessUnit { pts, data, .. } => Some((*pts, data.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn srt_demux_finds_the_video_pid_through_pat_and_pmt() {
        let events = demux(&stream(0x24, &[(9000, vec![1, 2, 3])]));
        assert_eq!(events[0], DemuxEvent::Video(VideoCodec::Hevc));
    }

    #[test]
    fn srt_demux_joins_a_pes_split_across_packets_at_the_next_start() {
        let big: Vec<u8> = (0..1000u32).map(|n| n as u8).collect();
        let events = demux(&stream(0x1b, &[(3000, big.clone()), (6000, vec![9])]));
        // The second PES has no successor yet: an unbounded PES ends only at
        // the next payload start.
        assert_eq!(units(&events), vec![(Some(3000), big)]);
    }

    #[test]
    fn srt_demux_keeps_chunking_independent() {
        let bytes = stream(
            0x1b,
            &[(10, vec![7; 400]), (20, vec![8; 10]), (30, vec![1])],
        );
        let mut demuxer = TsDemuxer::new();
        let mut events = Vec::new();
        for chunk in bytes.chunks(97) {
            demuxer.push(chunk, &mut events);
        }
        assert_eq!(units(&events), units(&demux(&bytes)));
        assert_eq!(units(&events).len(), 2);
    }

    #[test]
    fn srt_demux_unwraps_the_33_bit_pts() {
        let near_wrap = PTS_MODULO - 1500;
        let events = demux(&stream(
            0x1b,
            &[
                (near_wrap, vec![1]),
                (1500, vec![2]),
                (4500, vec![3]),
                (0, vec![4]),
            ],
        ));
        let pts: Vec<_> = units(&events).into_iter().map(|(pts, _)| pts).collect();
        assert_eq!(
            pts,
            vec![
                Some(near_wrap),
                Some(PTS_MODULO + 1500),
                Some(PTS_MODULO + 4500)
            ]
        );
    }

    /// A video packet whose adaptation field sets discontinuity_indicator:
    /// with a payload, or adaptation only.
    fn discontinuity_packet(continuity: u8, payload: Option<&[u8]>) -> Vec<u8> {
        let mut out = vec![SYNC_BYTE, (VIDEO_PID >> 8) as u8 & 0x1f, VIDEO_PID as u8];
        let payload = payload.unwrap_or(&[]);
        let control = if payload.is_empty() { 0x20 } else { 0x30 };
        out.push(control | (continuity & 0x0f));
        let adaptation_length = 184 - payload.len() - 1;
        out.push(adaptation_length as u8);
        out.push(0x80);
        out.extend(std::iter::repeat_n(0xff, adaptation_length - 1));
        out.extend_from_slice(payload);
        assert_eq!(out.len(), TS_PACKET_LEN);
        out
    }

    /// PAT, PMT, then the first packet of a 400-byte PES (more to come).
    fn stream_with_open_pes() -> Vec<u8> {
        let mut bytes = stream(0x1b, &[]);
        let first = pes(10, &[5; 400]);
        bytes.extend(packet(VIDEO_PID, true, 0, &first[..184]));
        bytes
    }

    #[test]
    fn srt_demux_an_explicit_discontinuity_drops_the_open_pes() {
        // The sender resets its continuity counter mid-PES: the bytes after
        // the reset belong to something else and must never join the PES.
        let mut bytes = stream_with_open_pes();
        bytes.extend(discontinuity_packet(9, Some(&[0xee; 50])));
        bytes.extend(packet(VIDEO_PID, true, 10, &pes(20, &[6; 10])));
        bytes.extend(packet(VIDEO_PID, true, 11, &pes(30, &[1])));
        let events = demux(&bytes);
        assert!(events.contains(&DemuxEvent::Discontinuity));
        assert_eq!(units(&events), vec![(Some(20), vec![6; 10])]);
    }

    #[test]
    fn srt_demux_an_adaptation_only_discontinuity_drops_the_open_pes() {
        // The next payload's counter happens to look continuous; the
        // discontinuity still ends the PES, and data resumes at a PES start.
        let mut bytes = stream_with_open_pes();
        bytes.extend(discontinuity_packet(0, None));
        bytes.extend(packet(VIDEO_PID, false, 1, &[0xee; 50]));
        bytes.extend(packet(VIDEO_PID, true, 2, &pes(20, &[6; 10])));
        bytes.extend(packet(VIDEO_PID, true, 3, &pes(30, &[1])));
        let events = demux(&bytes);
        assert!(events.contains(&DemuxEvent::Discontinuity));
        assert_eq!(units(&events), vec![(Some(20), vec![6; 10])]);
    }

    /// A PES that says how long it is.
    fn bounded_pes(pts: u64, data: &[u8]) -> Vec<u8> {
        let mut out = pes(pts, data);
        let length = (out.len() - 6) as u16;
        out[4..6].copy_from_slice(&length.to_be_bytes());
        out
    }

    /// Memory probe (2026-11-14): a fresh PES buffer per access unit grew
    /// from nothing in 184-byte steps every frame, so a 4K stream churned
    /// allocations of every size and RSS crept up. One buffer, kept.
    #[test]
    fn srt_demux_keeps_its_pes_buffer_from_one_access_unit_to_the_next() {
        let large = vec![0x42_u8; 50_000];
        let bytes = stream(0x24, &[(0, large.clone()), (1, large), (2, vec![1, 2, 3])]);
        let mut demuxer = TsDemuxer::new();
        let mut events = Vec::new();
        demuxer.push(&bytes, &mut events);
        let units = events
            .iter()
            .filter(|event| matches!(event, DemuxEvent::AccessUnit { .. }))
            .count();
        assert_eq!(units, 2, "both large units came out whole");
        assert!(
            demuxer.pes.capacity() >= 50_000,
            "the open unit reuses the buffer the last one grew ({} bytes)",
            demuxer.pes.capacity()
        );
    }

    #[test]
    fn srt_demux_a_whole_pes_lost_between_two_is_reported() {
        // Three bounded PES, one packet each; the middle one never arrives.
        // The first is complete before the gap, so no PES is open when the
        // counter jumps; the gap must still be reported.
        let mut bytes = stream(0x1b, &[]);
        bytes.extend(packet(VIDEO_PID, true, 0, &bounded_pes(10, &[5; 20])));
        bytes.extend(packet(VIDEO_PID, true, 2, &bounded_pes(30, &[7; 20])));
        let events = demux(&bytes);
        assert_eq!(units(&events).first(), Some(&(Some(10), vec![5; 20])));
        assert!(
            events.contains(&DemuxEvent::Discontinuity),
            "a lost PES between two complete ones is a discontinuity"
        );
    }

    /// A PES grown huge (an unbounded one near the limit)
    /// gives its room back once it is done or dropped; normal room stays.
    #[test]
    fn srt_demux_gives_back_the_room_of_an_outsized_pes() {
        let huge = vec![0x42_u8; 12 * 1024 * 1024];
        // Flushed at the next start.
        let bytes = stream(0x24, &[(0, huge.clone()), (1, vec![1, 2, 3]), (2, vec![4])]);
        let mut demuxer = TsDemuxer::new();
        let mut events = Vec::new();
        demuxer.push(&bytes, &mut events);
        assert!(
            demuxer.pes.capacity() <= PES_KEEP_BYTES,
            "after a flush ({} bytes)",
            demuxer.pes.capacity()
        );
        // Dropped after a lost packet near its end.
        let mut bytes = stream(0x24, &[(0, huge), (1, vec![1, 2, 3]), (2, vec![4])]);
        let near_end = bytes.len() - 6 * TS_PACKET_LEN;
        bytes.drain(near_end..near_end + TS_PACKET_LEN);
        let mut demuxer = TsDemuxer::new();
        let mut events = Vec::new();
        demuxer.push(&bytes, &mut events);
        assert!(events.contains(&DemuxEvent::Discontinuity));
        assert!(
            demuxer.pes.capacity() <= PES_KEEP_BYTES,
            "after a drop ({} bytes)",
            demuxer.pes.capacity()
        );
    }

    /// 15 lost packets bring the counter round to the last
    /// one's value. A different payload under the same counter is a gap,
    /// not a repeat: the PES is dropped and the decoder told.
    #[test]
    fn srt_demux_sixteen_packets_apart_is_a_gap_not_a_repeat() {
        // Varying bytes, as video has: no two packets alike.
        let first: Vec<u8> = (0..5000_u32).map(|i| (i % 251) as u8).collect();
        let mut bytes = stream(0x1b, &[(10, first), (20, vec![6; 10]), (30, vec![1])]);
        // PAT and PMT, then video from packet 2 with counters from 0: the
        // packet after the 15 removed carries packet 3's counter.
        bytes.drain(4 * TS_PACKET_LEN..19 * TS_PACKET_LEN);
        let events = demux(&bytes);
        assert!(events.contains(&DemuxEvent::Discontinuity));
        assert_eq!(units(&events), vec![(Some(20), vec![6; 10])]);
    }

    /// A PES that says how long it is and ends short (the
    /// next one starts before its bytes are all here) is damaged.
    #[test]
    fn srt_demux_drops_a_bounded_pes_that_ends_short() {
        let mut short = bounded_pes(10, &[5; 20]);
        let declared = u16::from_be_bytes([short[4], short[5]]) + 100;
        short[4..6].copy_from_slice(&declared.to_be_bytes());
        let mut bytes = stream(0x1b, &[]);
        bytes.extend(packet(VIDEO_PID, true, 0, &short));
        bytes.extend(packet(VIDEO_PID, true, 1, &bounded_pes(30, &[7; 20])));
        let events = demux(&bytes);
        assert!(events.contains(&DemuxEvent::Discontinuity));
        assert_eq!(units(&events), vec![(Some(30), vec![7; 20])]);
    }

    #[test]
    fn srt_demux_drops_the_pes_after_a_continuity_gap() {
        let mut bytes = stream(
            0x1b,
            &[(10, vec![5; 400]), (20, vec![6; 10]), (30, vec![1])],
        );
        // Remove the second video packet of the first PES (packets: PAT, PMT,
        // then video).
        bytes.drain(3 * TS_PACKET_LEN..4 * TS_PACKET_LEN);
        let events = demux(&bytes);
        assert!(events.contains(&DemuxEvent::Discontinuity));
        assert_eq!(units(&events), vec![(Some(20), vec![6; 10])]);
    }

    /// A video packet whose adaptation field carries a PCR, then `payload`.
    fn packet_with_pcr(unit_start: bool, continuity: u8, pcr: [u8; 6], payload: &[u8]) -> Vec<u8> {
        let length = 184 - 1 - payload.len();
        assert!(length >= 7);
        let mut out = vec![
            SYNC_BYTE,
            (if unit_start { 0x40 } else { 0 }) | ((VIDEO_PID >> 8) as u8 & 0x1f),
            VIDEO_PID as u8,
            0x30 | (continuity & 0x0f),
            length as u8,
            0x10,
        ];
        out.extend_from_slice(&pcr);
        out.extend(std::iter::repeat_n(0xff, length - 7));
        out.extend_from_slice(payload);
        assert_eq!(out.len(), TS_PACKET_LEN);
        out
    }

    /// A video packet with only an adaptation field: its counter stays.
    fn adaptation_only(continuity: u8) -> Vec<u8> {
        let mut out = vec![
            SYNC_BYTE,
            (VIDEO_PID >> 8) as u8 & 0x1f,
            VIDEO_PID as u8,
            0x20 | (continuity & 0x0f),
            183,
            0,
        ];
        out.extend(std::iter::repeat_n(0xff, 182));
        out
    }

    /// A legal repeat may carry a new PCR (H.222.0
    /// 2.4.3.3); any other changed byte makes it a gap.
    #[test]
    fn srt_demux_a_repeat_may_change_only_its_pcr() {
        let data: Vec<u8> = (0..300_u32).map(|i| (i % 251) as u8).collect();
        let unit = pes(10, &data);
        let (head, tail) = unit.split_at(170);
        let run = |repeat: Vec<u8>| {
            let mut bytes = stream(0x1b, &[]);
            bytes.extend(packet_with_pcr(true, 0, [1, 2, 3, 4, 5, 6], head));
            bytes.extend(repeat);
            bytes.extend(packet(VIDEO_PID, false, 1, tail));
            bytes.extend(packet(VIDEO_PID, true, 2, &bounded_pes(20, &[6; 10])));
            demux(&bytes)
        };
        let new_pcr = run(packet_with_pcr(true, 0, [9, 9, 9, 9, 9, 9], head));
        assert!(!new_pcr.contains(&DemuxEvent::Discontinuity));
        assert_eq!(units(&new_pcr).first(), Some(&(Some(10), data.clone())));

        let mut changed_head = head.to_vec();
        *changed_head.last_mut().unwrap() ^= 0xff;
        let other_byte = run(packet_with_pcr(true, 0, [1, 2, 3, 4, 5, 6], &changed_head));
        assert!(other_byte.contains(&DemuxEvent::Discontinuity));
    }

    /// Only consecutive packets are repeats. A packet
    /// equal to one from before an adaptation-only packet (and 15 lost
    /// ones that bring the counter round) is a gap.
    #[test]
    fn srt_demux_a_repeat_must_follow_its_original() {
        let data: Vec<u8> = (0..300_u32).map(|i| (i % 251) as u8).collect();
        let unit = pes(10, &data);
        let (head, tail) = unit.split_at(184);
        let first = packet(VIDEO_PID, true, 0, head);
        let mut bytes = stream(0x1b, &[]);
        bytes.extend(first.clone());
        bytes.extend(adaptation_only(0));
        bytes.extend(first);
        bytes.extend(packet(VIDEO_PID, false, 1, tail));
        bytes.extend(packet(VIDEO_PID, true, 2, &bounded_pes(20, &[6; 10])));
        assert!(demux(&bytes).contains(&DemuxEvent::Discontinuity));
    }

    #[test]
    fn srt_demux_ignores_a_repeated_packet() {
        let mut bytes = stream(0x1b, &[(10, vec![5; 10]), (20, vec![6])]);
        let first_video = bytes[2 * TS_PACKET_LEN..3 * TS_PACKET_LEN].to_vec();
        bytes.splice(3 * TS_PACKET_LEN..3 * TS_PACKET_LEN, first_video);
        let events = demux(&bytes);
        assert!(!events.contains(&DemuxEvent::Discontinuity));
        assert_eq!(units(&events), vec![(Some(10), vec![5; 10])]);
    }

    #[test]
    fn srt_demux_drops_audio_and_other_pids() {
        let mut bytes = stream(0x1b, &[(10, vec![5]), (20, vec![6])]);
        bytes.extend(packet(
            AUDIO_PID,
            true,
            0,
            &[0, 0, 1, 0xc0, 0, 0, 0x80, 0, 0, 0xaa],
        ));
        bytes.extend(packet(0x1234, true, 0, &[0xbb; 20]));
        let events = demux(&bytes);
        assert_eq!(units(&events), vec![(Some(10), vec![5])]);
    }

    #[test]
    fn srt_demux_names_a_codec_it_cannot_show() {
        let events = demux(&stream(0x02, &[(10, vec![5])]));
        assert_eq!(events[0], DemuxEvent::Video(VideoCodec::Unsupported(0x02)));
        assert_eq!(VideoCodec::Unsupported(0x02).label(), "MPEG-2");
        assert_eq!(VideoCodec::Unsupported(0x77).label(), "stream type 0x77");
        assert_eq!(VideoCodec::from_stream_type(0x0f), None, "AAC is not video");
    }

    #[test]
    fn srt_demux_resyncs_after_garbage() {
        let mut bytes = vec![0x00, 0x13, 0x47];
        bytes.extend(stream(0x24, &[(10, vec![5]), (20, vec![6])]));
        assert_eq!(units(&demux(&bytes)), vec![(Some(10), vec![5])]);
    }
}
