//! Plan 260 S1.8c c6 (after S1.8d): the room's latency, measured by the
//! backend while it holds the host seat. A port of
//! `shared/room-latency.ts` (plan 253, `docs/cloud/253-latency-contract.md`)
//! and the renderer's `RoomLatencyHost`, held to the same cases
//! (`protocol-fixtures/room-latency.json`, which videorc-web copies too).
//!
//! Three parts, as the TypeScript: the `net` block a participant makes from
//! its own WebRTC stats (`read_net_stats`, `net_block`), its validation
//! (`parse_net_block`, `parse_latency_relay`), and the model, blocks in,
//! numbers out (`room_latency`). Every number is a duration on one machine's
//! own clock (D1). On a managed show (the record's own rule,
//! `cloud_latency::managed_show`) the task samples the host's own and
//! the guests' tracks every 10 s (LiveKit's `get_stats`), keeps the guest
//! and program pages' blocks the web relays on `videorc.latency.v1`, and
//! files each sample to the show's record (`cloud_latency::report`). On any
//! other show nothing runs (D10).

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use livekit::prelude::{Room, RoomEvent, TrackSource};
use livekit::webrtc::stats::{IceCandidatePairState, RtcStats};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::oneshot;

use crate::state::AppState;

pub(crate) const LATENCY_TOPIC: &str = "videorc.latency.v1";
const NET_BLOCK_VERSION: u8 = 1;
const LATENCY_SAMPLE: Duration = Duration::from_secs(10);
const LATENCY_TTL_MS: f64 = 25_000.0;
const SEND_AUDIO_MS: f64 = 40.0;
const SFU_MS: f64 = 5.0;
const PAGE_DRAW_MS: i64 = 33;
const NET_MAX_MS: f64 = 60_000.0;
const NET_MIN_WINDOW_MS: f64 = 1_000.0;
const NET_MAX_SENDERS: usize = 8;
const NET_IDENTITY_MAX_CHARS: usize = 128;
const LATENCY_RELAY_MAX_BYTES: usize = 4096;
const PROGRAM_PAGE_IDENTITY_PREFIX: &str = "EG_";
/// The record keeps at most this many people, and names this long.
const REPORT_PEOPLE_MAX: usize = 16;
const REPORT_NAME_MAX_CHARS: usize = 80;

// --- The block ---------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetSender {
    pub(crate) identity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) audio_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) video_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetSend {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) video_ms: Option<u32>,
}

/// What one participant measured over one window. Durations only (D1).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetBlock {
    pub(crate) v: u8,
    pub(crate) window_ms: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rtt_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) playout_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) partial: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) send: Option<NetSend>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) from: Option<Vec<NetSender>>,
}

/// `isMs`: a whole number of milliseconds, 0 to 60 000.
fn ms_of(value: &Value) -> Option<u32> {
    let number = value.as_f64()?;
    (number.fract() == 0.0 && (0.0..=NET_MAX_MS).contains(&number)).then_some(number as u32)
}

/// An optional key: absent is fine, present must be valid (`None` refuses).
fn optional_ms(object: &serde_json::Map<String, Value>, key: &str) -> Option<Option<u32>> {
    match object.get(key) {
        None => Some(None),
        Some(value) => ms_of(value).map(Some),
    }
}

/// `parseNetBlock`: a block as the contract allows it, rebuilt field by
/// field; unknown keys are left out, one bad known key refuses it.
pub(crate) fn parse_net_block(value: &Value) -> Option<NetBlock> {
    let object = value.as_object()?;
    if object.get("v")?.as_f64()? != f64::from(NET_BLOCK_VERSION) {
        return None;
    }
    let window_ms = ms_of(object.get("windowMs")?)?;
    if f64::from(window_ms) < NET_MIN_WINDOW_MS {
        return None;
    }
    let rtt_ms = optional_ms(object, "rttMs")?;
    let playout_ms = optional_ms(object, "playoutMs")?;
    let partial = match object.get("partial") {
        None => None,
        Some(value) => Some(value.as_bool()?),
    };
    let send_video_ms = match object.get("send") {
        None => None,
        Some(send) => optional_ms(send.as_object()?, "videoMs")?,
    };
    let from = match object.get("from") {
        None => None,
        Some(from) => {
            let items = from.as_array()?;
            if items.len() > NET_MAX_SENDERS {
                return None;
            }
            let mut senders: Vec<NetSender> = Vec::new();
            for item in items {
                let item = item.as_object()?;
                let identity = item.get("identity")?.as_str()?;
                if identity.is_empty()
                    || identity.encode_utf16().count() > NET_IDENTITY_MAX_CHARS
                    || senders.iter().any(|sender| sender.identity == identity)
                {
                    return None;
                }
                senders.push(NetSender {
                    identity: identity.to_string(),
                    audio_ms: optional_ms(item, "audioMs")?,
                    video_ms: optional_ms(item, "videoMs")?,
                });
            }
            Some(senders)
        }
    };
    Some(NetBlock {
        v: NET_BLOCK_VERSION,
        window_ms,
        rtt_ms,
        playout_ms,
        partial,
        send: send_video_ms.map(|video_ms| NetSend {
            video_ms: Some(video_ms),
        }),
        from,
    })
}

/// What the web relays the host: a checked block, from whom, and when.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LatencyRelay {
    pub(crate) identity: String,
    /// The web's receive time: for the record only, never subtracted (D1),
    /// so the host does not read it either.
    #[allow(dead_code)]
    pub(crate) at: f64,
    pub(crate) net: NetBlock,
}

/// `parseLatencyRelay`.
pub(crate) fn parse_latency_relay(value: &Value) -> Option<LatencyRelay> {
    let object = value.as_object()?;
    if object.get("v")?.as_f64()? != 1.0 {
        return None;
    }
    let identity = object.get("identity")?.as_str()?;
    let at = object.get("at")?.as_f64()?;
    if identity.is_empty()
        || identity.encode_utf16().count() > NET_IDENTITY_MAX_CHARS
        || !at.is_finite()
        || at < 0.0
    {
        return None;
    }
    Some(LatencyRelay {
        identity: identity.to_string(),
        at,
        net: parse_net_block(object.get("net")?)?,
    })
}

// --- The sampler's arithmetic -------------------------------------------------

/// One stats entry, the fields the sampler reads (never a candidate's
/// address, D12).
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct StatsEntry {
    pub(crate) kind: String,
    pub(crate) id: String,
    pub(crate) selected_candidate_pair_id: Option<String>,
    pub(crate) current_round_trip_time: Option<f64>,
    pub(crate) nominated: bool,
    pub(crate) succeeded: bool,
    pub(crate) round_trip_time: Option<f64>,
    pub(crate) total_encode_time: Option<f64>,
    pub(crate) frames_encoded: Option<f64>,
    pub(crate) total_packet_send_delay: Option<f64>,
    pub(crate) packets_sent: Option<f64>,
    pub(crate) frames_per_second: Option<f64>,
    pub(crate) total_playout_delay: Option<f64>,
    pub(crate) total_samples_count: Option<f64>,
    pub(crate) jitter_buffer_delay: Option<f64>,
    pub(crate) jitter_buffer_emitted_count: Option<f64>,
    pub(crate) total_processing_delay: Option<f64>,
    pub(crate) frames_decoded: Option<f64>,
}

/// `finite`: a number, finite and not negative.
fn finite(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && *value >= 0.0)
}

impl StatsEntry {
    /// An entry of a browser `RTCStatsReport`, as the fixture holds them.
    #[cfg(test)]
    fn from_json(value: &Value) -> Self {
        let number = |key: &str| value.get(key).and_then(Value::as_f64);
        Self {
            kind: value["type"].as_str().unwrap_or_default().to_string(),
            id: value["id"].as_str().unwrap_or_default().to_string(),
            selected_candidate_pair_id: value
                .get("selectedCandidatePairId")
                .and_then(Value::as_str)
                .map(str::to_string),
            current_round_trip_time: number("currentRoundTripTime"),
            nominated: value.get("nominated") == Some(&Value::Bool(true)),
            succeeded: value.get("state").and_then(Value::as_str) == Some("succeeded"),
            round_trip_time: number("roundTripTime"),
            total_encode_time: number("totalEncodeTime"),
            frames_encoded: number("framesEncoded"),
            total_packet_send_delay: number("totalPacketSendDelay"),
            packets_sent: number("packetsSent"),
            frames_per_second: number("framesPerSecond"),
            total_playout_delay: number("totalPlayoutDelay"),
            total_samples_count: number("totalSamplesCount"),
            jitter_buffer_delay: number("jitterBufferDelay"),
            jitter_buffer_emitted_count: number("jitterBufferEmittedCount"),
            total_processing_delay: number("totalProcessingDelay"),
            frames_decoded: number("framesDecoded"),
        }
    }

    /// An entry of LiveKit's stats. Its fields default to 0 when the stat is
    /// absent; a round trip of 0 is read as absent (no stat), every total
    /// and count as it is (a zero count makes no mean, as an absent one).
    fn from_rtc(stats: &RtcStats) -> Option<Self> {
        let rtt = |seconds: f64| (seconds > 0.0).then_some(seconds);
        Some(match stats {
            RtcStats::Transport(transport) => Self {
                kind: "transport".to_string(),
                id: transport.rtc.id.clone(),
                selected_candidate_pair_id: Some(
                    transport.transport.selected_candidate_pair_id.clone(),
                )
                .filter(|id| !id.is_empty()),
                ..Self::default()
            },
            RtcStats::CandidatePair(pair) => Self {
                kind: "candidate-pair".to_string(),
                id: pair.rtc.id.clone(),
                current_round_trip_time: rtt(pair.candidate_pair.current_round_trip_time),
                nominated: pair.candidate_pair.nominated,
                succeeded: pair.candidate_pair.state == Some(IceCandidatePairState::Succeeded),
                ..Self::default()
            },
            RtcStats::RemoteInboundRtp(remote) => Self {
                kind: "remote-inbound-rtp".to_string(),
                id: remote.rtc.id.clone(),
                round_trip_time: rtt(remote.remote_inbound.round_trip_time),
                ..Self::default()
            },
            RtcStats::OutboundRtp(out) => Self {
                kind: "outbound-rtp".to_string(),
                id: out.rtc.id.clone(),
                total_encode_time: Some(out.outbound.total_encode_time),
                frames_encoded: Some(f64::from(out.outbound.frames_encoded)),
                total_packet_send_delay: Some(out.outbound.total_packet_send_delay),
                packets_sent: Some(out.sent.packets_sent as f64),
                frames_per_second: Some(out.outbound.frames_per_second),
                ..Self::default()
            },
            RtcStats::MediaPlayout(playout) => Self {
                kind: "media-playout".to_string(),
                id: playout.rtc.id.clone(),
                total_playout_delay: Some(playout.audio_playout.total_playout_delay),
                total_samples_count: Some(playout.audio_playout.total_samples_count as f64),
                ..Self::default()
            },
            RtcStats::InboundRtp(inbound) => Self {
                kind: "inbound-rtp".to_string(),
                id: inbound.rtc.id.clone(),
                jitter_buffer_delay: Some(inbound.inbound.jitter_buffer_delay),
                jitter_buffer_emitted_count: Some(
                    inbound.inbound.jitter_buffer_emitted_count as f64,
                ),
                total_processing_delay: Some(inbound.inbound.total_processing_delay),
                frames_decoded: Some(f64::from(inbound.inbound.frames_decoded)),
                ..Self::default()
            },
            _ => return None,
        })
    }
}

/// One track's stats: a remote camera or microphone (`identity` set), or
/// this participant's own.
#[derive(Debug, Clone)]
pub(crate) struct StatsSource {
    pub(crate) identity: Option<String>,
    pub(crate) audio: bool,
    pub(crate) entries: Vec<StatsEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Ratio {
    total: f64,
    count: f64,
}

fn ratio(total: Option<f64>, count: Option<f64>) -> Option<Ratio> {
    Some(Ratio {
        total: finite(total)?,
        count: finite(count)?,
    })
}

fn add(a: Option<Ratio>, b: Option<Ratio>) -> Option<Ratio> {
    match (a, b) {
        (None, b) => b,
        (a, None) => a,
        (Some(a), Some(b)) => Some(Ratio {
            total: a.total + b.total,
            count: a.count + b.count,
        }),
    }
}

#[derive(Debug, Clone, Default)]
struct SenderRatios {
    audio: Option<Ratio>,
    video: Option<Ratio>,
}

/// Session totals at one moment (`NetReading`).
#[derive(Debug, Clone, Default)]
pub(crate) struct NetReading {
    rtt: Option<f64>,
    playout: Option<Ratio>,
    encode: Option<Ratio>,
    packet_send: Option<Ratio>,
    frames_per_second: Option<f64>,
    /// In the order first heard: the one that matters first.
    from: Vec<(String, SenderRatios)>,
}

/// `selectedPairRtt`: the selected candidate pair's round trip, seconds.
fn selected_pair_rtt(entries: &[StatsEntry]) -> Option<f64> {
    let mut selected: Option<&str> = None;
    for entry in entries {
        if entry.kind == "transport"
            && let Some(id) = entry.selected_candidate_pair_id.as_deref()
        {
            selected = Some(id);
        }
    }
    let mut nominated: Option<f64> = None;
    for entry in entries {
        if entry.kind != "candidate-pair" {
            continue;
        }
        let Some(rtt) = finite(entry.current_round_trip_time) else {
            continue;
        };
        if selected.is_some_and(|id| id == entry.id) {
            return Some(rtt);
        }
        if entry.nominated && entry.succeeded && nominated.is_none() {
            nominated = Some(rtt);
        }
    }
    nominated
}

/// `readNetStats`.
pub(crate) fn read_net_stats(sources: &[StatsSource]) -> NetReading {
    let mut reading = NetReading::default();
    let mut rtt: Option<f64> = None;
    let mut fallback_rtt: Option<f64> = None;
    for source in sources {
        if rtt.is_none() {
            rtt = selected_pair_rtt(&source.entries);
        }
        for entry in &source.entries {
            let Some(identity) = source.identity.as_ref() else {
                if entry.kind == "remote-inbound-rtp" && fallback_rtt.is_none() {
                    fallback_rtt = finite(entry.round_trip_time);
                }
                if entry.kind != "outbound-rtp" || source.audio {
                    continue;
                }
                // Simulcast: one entry per layer, the mean over all of them.
                reading.encode = add(
                    reading.encode,
                    ratio(entry.total_encode_time, entry.frames_encoded),
                );
                reading.packet_send = add(
                    reading.packet_send,
                    ratio(entry.total_packet_send_delay, entry.packets_sent),
                );
                if let Some(fps) = finite(entry.frames_per_second).filter(|fps| *fps > 0.0) {
                    reading.frames_per_second =
                        Some(reading.frames_per_second.unwrap_or(0.0).max(fps));
                }
                continue;
            };
            if entry.kind == "media-playout" {
                if reading.playout.is_none() {
                    reading.playout = ratio(entry.total_playout_delay, entry.total_samples_count);
                }
                continue;
            }
            if entry.kind != "inbound-rtp" {
                continue;
            }
            let index = match reading.from.iter().position(|(known, _)| known == identity) {
                Some(index) => index,
                None => {
                    if reading.from.len() >= NET_MAX_SENDERS {
                        continue;
                    }
                    reading
                        .from
                        .push((identity.clone(), SenderRatios::default()));
                    reading.from.len() - 1
                }
            };
            let sender = &mut reading.from[index].1;
            if source.audio {
                sender.audio = add(
                    sender.audio,
                    ratio(entry.jitter_buffer_delay, entry.jitter_buffer_emitted_count),
                );
            } else {
                sender.video = add(
                    sender.video,
                    ratio(entry.total_processing_delay, entry.frames_decoded),
                );
            }
        }
    }
    reading.rtt = rtt.or(fallback_rtt);
    reading
}

fn clamp_ms(ms: f64) -> u32 {
    ms.round().clamp(0.0, NET_MAX_MS) as u32
}

/// The mean over the window in ms: Δtotal / Δcount.
fn mean_of(before: Option<Ratio>, after: Option<Ratio>) -> Option<f64> {
    let (before, after) = (before?, after?);
    let count = after.count - before.count;
    let total = after.total - before.total;
    (count > 0.0 && total >= 0.0).then(|| total / count * 1000.0)
}

fn mean_ms(before: Option<Ratio>, after: Option<Ratio>) -> Option<u32> {
    mean_of(before, after).map(clamp_ms)
}

/// `netBlock`: the block for one window, from its two readings.
pub(crate) fn net_block(
    before: Option<&NetReading>,
    after: &NetReading,
    window_ms: f64,
) -> Option<NetBlock> {
    let before = before?;
    if !window_ms.is_finite() || !(NET_MIN_WINDOW_MS..=NET_MAX_MS).contains(&window_ms) {
        return None;
    }
    let playout_ms = mean_ms(before.playout, after.playout);
    let encode_ms = mean_of(before.encode, after.encode);
    let packet_send_ms = mean_of(before.packet_send, after.packet_send);
    let mut from = Vec::new();
    let mut hears = false;
    for (identity, now) in &after.from {
        let then = before
            .from
            .iter()
            .find(|(known, _)| known == identity)
            .map(|(_, ratios)| ratios);
        let audio_ms = mean_ms(then.and_then(|then| then.audio), now.audio);
        let video_ms = mean_ms(then.and_then(|then| then.video), now.video);
        if audio_ms.is_none() && video_ms.is_none() {
            continue;
        }
        hears |= audio_ms.is_some();
        from.push(NetSender {
            identity: identity.clone(),
            audio_ms,
            video_ms,
        });
    }
    // Encode, the pacer's queue, and half a frame of waiting for the next.
    let send_video_ms = encode_ms.map(|encode| {
        clamp_ms(
            encode
                + packet_send_ms.unwrap_or(0.0)
                + 500.0 / after.frames_per_second.unwrap_or(30.0),
        )
    });
    Some(NetBlock {
        v: NET_BLOCK_VERSION,
        window_ms: clamp_ms(window_ms),
        rtt_ms: after.rtt.map(|rtt| clamp_ms(rtt * 1000.0)),
        playout_ms,
        // Sound was received and its playout is unknown: a floor, said so.
        partial: Some(hears && playout_ms.is_none()),
        send: send_video_ms.map(|video_ms| NetSend {
            video_ms: Some(video_ms),
        }),
        from: (!from.is_empty()).then_some(from),
    })
}

// --- The model ------------------------------------------------------------------

/// A block and when its holder got it, on the holder's own clock.
#[derive(Debug, Clone)]
pub(crate) struct HeldNetBlock {
    pub(crate) identity: String,
    pub(crate) block: NetBlock,
    pub(crate) at_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VideoDelay {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) to_guest_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) from_guest_ms: Option<i64>,
}

/// N1 for one guest: `ms` is the worse direction.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationDelay {
    pub(crate) ms: i64,
    pub(crate) partial: bool,
    pub(crate) to_guest_ms: Option<i64>,
    pub(crate) from_guest_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) video: Option<VideoDelay>,
}

/// N2: the host's camera to the program page having drawn it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProgramDelay {
    pub(crate) ms: i64,
    pub(crate) audio_ms: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoomLatency {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) host_rtt_ms: Option<u32>,
    pub(crate) people: BTreeMap<String, ConversationDelay>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) program: Option<ProgramDelay>,
}

fn fresh(at_ms: f64, now_ms: f64) -> bool {
    now_ms >= at_ms && now_ms - at_ms <= LATENCY_TTL_MS
}

fn sender_of<'a>(block: &'a NetBlock, identity: &str) -> Option<&'a NetSender> {
    block
        .from
        .as_ref()?
        .iter()
        .find(|sender| sender.identity == identity)
}

/// D2, sound.
fn audio_path_delay(
    sender: &NetBlock,
    sender_identity: &str,
    receiver: &NetBlock,
) -> Option<(i64, bool)> {
    let buffer = sender_of(receiver, sender_identity)?.audio_ms?;
    let (sender_rtt, receiver_rtt) = (sender.rtt_ms?, receiver.rtt_ms?);
    let ms = SEND_AUDIO_MS
        + f64::from(sender_rtt) / 2.0
        + SFU_MS
        + f64::from(receiver_rtt) / 2.0
        + f64::from(buffer)
        + f64::from(receiver.playout_ms.unwrap_or(0));
    Some((
        ms.round() as i64,
        receiver.playout_ms.is_none() || receiver.partial == Some(true),
    ))
}

/// D2, picture.
fn video_path_delay(sender: &NetBlock, sender_identity: &str, receiver: &NetBlock) -> Option<i64> {
    let buffer = sender_of(receiver, sender_identity)?.video_ms?;
    let send = sender.send.as_ref()?.video_ms?;
    let (sender_rtt, receiver_rtt) = (sender.rtt_ms?, receiver.rtt_ms?);
    Some(
        (f64::from(send)
            + f64::from(sender_rtt) / 2.0
            + SFU_MS
            + f64::from(receiver_rtt) / 2.0
            + f64::from(buffer))
        .round() as i64,
    )
}

fn conversation_delay(host: &HeldNetBlock, guest: &HeldNetBlock) -> Option<ConversationDelay> {
    let to_guest = audio_path_delay(&host.block, &host.identity, &guest.block);
    let from_guest = audio_path_delay(&guest.block, &guest.identity, &host.block);
    if to_guest.is_none() && from_guest.is_none() {
        return None;
    }
    let video_to = video_path_delay(&host.block, &host.identity, &guest.block);
    let video_from = video_path_delay(&guest.block, &guest.identity, &host.block);
    Some(ConversationDelay {
        ms: to_guest
            .map_or(0, |(ms, _)| ms)
            .max(from_guest.map_or(0, |(ms, _)| ms)),
        partial: to_guest.is_none_or(|(_, partial)| partial)
            || from_guest.is_none_or(|(_, partial)| partial),
        to_guest_ms: to_guest.map(|(ms, _)| ms),
        from_guest_ms: from_guest.map(|(ms, _)| ms),
        video: (video_to.is_some() || video_from.is_some()).then_some(VideoDelay {
            to_guest_ms: video_to,
            from_guest_ms: video_from,
        }),
    })
}

fn program_delay(host: &HeldNetBlock, page: &NetBlock) -> Option<ProgramDelay> {
    let video = video_path_delay(&host.block, &host.identity, page)?;
    Some(ProgramDelay {
        ms: video + PAGE_DRAW_MS,
        audio_ms: audio_path_delay(&host.block, &host.identity, page).map(|(ms, _)| ms),
    })
}

/// `roomLatency`: everything the host knows now.
pub(crate) fn room_latency(
    now_ms: f64,
    host: Option<&HeldNetBlock>,
    reports: &[HeldNetBlock],
) -> RoomLatency {
    let mut latency = RoomLatency::default();
    let Some(host) = host.filter(|host| fresh(host.at_ms, now_ms)) else {
        return latency;
    };
    latency.host_rtt_ms = host.block.rtt_ms;
    for report in reports {
        if report.identity == host.identity || !fresh(report.at_ms, now_ms) {
            continue;
        }
        if report.identity.starts_with(PROGRAM_PAGE_IDENTITY_PREFIX) {
            if let Some(program) = program_delay(host, &report.block)
                && latency
                    .program
                    .as_ref()
                    .is_none_or(|known| program.ms > known.ms)
            {
                latency.program = Some(program);
            }
            continue;
        }
        if let Some(delay) = conversation_delay(host, report) {
            latency.people.insert(report.identity.clone(), delay);
        }
    }
    latency
}

/// `roomLatencyReport`: what the show's record keeps, or None with nothing
/// measured.
pub(crate) fn latency_report(
    show_id: &str,
    latency: &RoomLatency,
    name_of: impl Fn(&str) -> Option<String>,
) -> Option<crate::cloud_latency::LatencyReportParams> {
    let people: Vec<crate::cloud_latency::LatencyPerson> = latency
        .people
        .iter()
        .take(REPORT_PEOPLE_MAX)
        .map(|(identity, delay)| crate::cloud_latency::LatencyPerson {
            identity: identity.clone(),
            name: name_of(identity)
                .map(|name| {
                    name.trim()
                        .chars()
                        .take(REPORT_NAME_MAX_CHARS)
                        .collect::<String>()
                })
                .filter(|name| !name.is_empty()),
            ms: delay.ms.max(0) as u32,
            partial: delay.partial,
            to_guest_ms: delay.to_guest_ms.map(|ms| ms.max(0) as u32),
            from_guest_ms: delay.from_guest_ms.map(|ms| ms.max(0) as u32),
            video_to_guest_ms: delay
                .video
                .as_ref()
                .and_then(|video| video.to_guest_ms)
                .map(|ms| ms.max(0) as u32),
            video_from_guest_ms: delay
                .video
                .as_ref()
                .and_then(|video| video.from_guest_ms)
                .map(|ms| ms.max(0) as u32),
        })
        .collect();
    if latency.host_rtt_ms.is_none() && people.is_empty() && latency.program.is_none() {
        return None;
    }
    Some(crate::cloud_latency::LatencyReportParams {
        show_id: show_id.to_string(),
        host_rtt_ms: latency.host_rtt_ms,
        people,
        program: latency
            .program
            .as_ref()
            .map(|program| crate::cloud_latency::LatencyProgram {
                ms: program.ms.max(0) as u32,
                audio_ms: program.audio_ms.map(|ms| ms.max(0) as u32),
            }),
    })
}

// --- The host ---------------------------------------------------------------------

fn is_guest(identity: &str) -> bool {
    !identity.starts_with("runner:") && !identity.starts_with(PROGRAM_PAGE_IDENTITY_PREFIX)
}

fn conversation_track(source: TrackSource) -> Option<bool> {
    match source {
        TrackSource::Microphone => Some(true),
        TrackSource::Camera => Some(false),
        _ => None,
    }
}

fn entries(stats: Option<Vec<RtcStats>>) -> Vec<StatsEntry> {
    stats
        .unwrap_or_default()
        .iter()
        .filter_map(StatsEntry::from_rtc)
        .collect()
}

/// The guests' cameras and microphones as received, then the host's own:
/// camera and microphone only (a shared screen is not conversation).
async fn sample_sources(room: &Room) -> Vec<StatsSource> {
    let mut sources = Vec::new();
    for participant in room.remote_participants().values() {
        let identity = participant.identity().as_str().to_string();
        if !is_guest(&identity) {
            continue;
        }
        for publication in participant.track_publications().values() {
            let Some(audio) = conversation_track(publication.source()) else {
                continue;
            };
            let Some(track) = publication.track() else {
                continue;
            };
            let stats = track.get_stats().await.ok();
            sources.push(StatsSource {
                identity: Some(identity.clone()),
                audio,
                entries: entries(stats),
            });
        }
    }
    for publication in room.local_participant().track_publications().values() {
        let Some(audio) = conversation_track(publication.source()) else {
            continue;
        };
        let Some(track) = publication.track() else {
            continue;
        };
        let stats = track.get_stats().await.ok();
        sources.push(StatsSource {
            identity: None,
            audio,
            entries: entries(stats),
        });
    }
    sources
}

/// One connection's latency (S1.8c c6), on a managed show only: what the
/// renderer's `RoomLatencyHost` did while the renderer held the seat. Ends
/// when `done` fires or its sender drops.
pub(crate) async fn run(
    state: AppState,
    room: Arc<Room>,
    show_id: String,
    mut done: oneshot::Receiver<()>,
) {
    let host_identity = room.local_participant().identity().as_str().to_string();
    let origin = Instant::now();
    let now_ms = move || origin.elapsed().as_secs_f64() * 1000.0;
    let mut events = room.subscribe();
    let mut last: Option<(NetReading, f64)> = None;
    let mut host: Option<HeldNetBlock> = None;
    let mut reports: HashMap<String, HeldNetBlock> = HashMap::new();
    let mut pulse = tokio::time::interval(LATENCY_SAMPLE);
    pulse.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = &mut done => break,
            event = events.recv() => {
                let Some(event) = event else { break };
                match event {
                    // Relayed by the server only: a participant cannot send one.
                    RoomEvent::DataReceived { payload, topic, participant, .. }
                        if topic.as_deref() == Some(LATENCY_TOPIC) =>
                    {
                        if participant.is_some() || payload.len() > LATENCY_RELAY_MAX_BYTES {
                            continue;
                        }
                        let Some(relay) = serde_json::from_slice::<Value>(&payload)
                            .ok()
                            .and_then(|value| parse_latency_relay(&value))
                        else {
                            continue;
                        };
                        // From someone in the room now, never the host itself.
                        let present = room
                            .remote_participants()
                            .keys()
                            .any(|identity| identity.as_str() == relay.identity);
                        if relay.identity == host_identity
                            || !present
                            || !crate::cloud_latency::managed_show(&state, &show_id)
                        {
                            continue;
                        }
                        // Aged from its arrival here (D1): the web's `at` is
                        // for the record only.
                        let at_ms = now_ms();
                        reports.insert(
                            relay.identity.clone(),
                            HeldNetBlock { identity: relay.identity, block: relay.net, at_ms },
                        );
                    }
                    RoomEvent::ParticipantDisconnected(participant) => {
                        reports.remove(participant.identity().as_str());
                    }
                    // A replaced connection's counters start again.
                    RoomEvent::Reconnected => last = None,
                    _ => {}
                }
                continue;
            }
            _ = pulse.tick() => {}
        }
        if !crate::cloud_latency::managed_show(&state, &show_id) {
            last = None;
            host = None;
            reports.clear();
            continue;
        }
        // The window runs from one sample's start to the next, as the
        // renderer's NetSampler.
        let at = now_ms();
        let reading = read_net_stats(&sample_sources(&room).await);
        let window = last.as_ref().map_or(0.0, |(_, then)| at - then);
        if let Some(block) = net_block(last.as_ref().map(|(reading, _)| reading), &reading, window)
        {
            host = Some(HeldNetBlock {
                identity: host_identity.clone(),
                block,
                at_ms: at,
            });
        }
        last = Some((reading, at));
        reports.retain(|_, report| fresh(report.at_ms, at));
        let held: Vec<HeldNetBlock> = reports.values().cloned().collect();
        let latency = room_latency(at, host.as_ref(), &held);
        let names: HashMap<String, String> = room
            .remote_participants()
            .values()
            .map(|participant| {
                (
                    participant.identity().as_str().to_string(),
                    participant.name(),
                )
            })
            .collect();
        // Once per sample: a relay alone files nothing.
        if let Some(report) =
            latency_report(&show_id, &latency, |identity| names.get(identity).cloned())
            && let Err(problem) = crate::cloud_latency::report(&state, &report)
        {
            tracing::debug!("The room's latency was not kept: {problem}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../../protocol-fixtures/room-latency.json")).unwrap()
    }

    #[test]
    fn the_constants_are_the_contracts() {
        let fixture = fixture();
        let constants = &fixture["constants"];
        assert_eq!(fixture["topic"], LATENCY_TOPIC);
        assert_eq!(fixture["version"], u64::from(NET_BLOCK_VERSION));
        assert_eq!(constants["sampleMs"], LATENCY_SAMPLE.as_millis() as u64);
        assert_eq!(constants["ttlMs"].as_f64(), Some(LATENCY_TTL_MS));
        assert_eq!(constants["sendAudioMs"].as_f64(), Some(SEND_AUDIO_MS));
        assert_eq!(constants["sfuMs"].as_f64(), Some(SFU_MS));
        assert_eq!(constants["pageDrawMs"], PAGE_DRAW_MS);
        assert_eq!(constants["maxMs"].as_f64(), Some(NET_MAX_MS));
        assert_eq!(constants["minWindowMs"].as_f64(), Some(NET_MIN_WINDOW_MS));
        assert_eq!(constants["maxSenders"], NET_MAX_SENDERS);
        assert_eq!(constants["identityMaxChars"], NET_IDENTITY_MAX_CHARS);
        assert_eq!(constants["relayMaxBytes"], LATENCY_RELAY_MAX_BYTES);
        assert_eq!(
            constants["programPageIdentityPrefix"],
            PROGRAM_PAGE_IDENTITY_PREFIX
        );
    }

    #[test]
    fn blocks_parse_as_the_contract_allows() {
        for case in fixture()["blocks"].as_array().unwrap() {
            let parsed =
                parse_net_block(&case["in"]).map(|block| serde_json::to_value(block).unwrap());
            assert_eq!(
                parsed.unwrap_or(Value::Null),
                case["out"],
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn relays_parse_as_the_contract_allows() {
        for case in fixture()["relays"].as_array().unwrap() {
            let parsed = parse_latency_relay(&case["in"]);
            match (parsed, case["out"].is_null()) {
                (None, true) => {}
                (Some(relay), false) => {
                    let out = &case["out"];
                    assert_eq!(
                        relay.identity,
                        out["identity"].as_str().unwrap(),
                        "{}",
                        case["name"]
                    );
                    assert_eq!(relay.at, out["at"].as_f64().unwrap(), "{}", case["name"]);
                    assert_eq!(
                        serde_json::to_value(&relay.net).unwrap(),
                        out["net"],
                        "{}",
                        case["name"]
                    );
                }
                (parsed, _) => panic!("{}: {parsed:?}", case["name"]),
            }
        }
    }

    fn sources(value: &Value) -> Vec<StatsSource> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|source| StatsSource {
                identity: (source["direction"] == "in")
                    .then(|| source["identity"].as_str().unwrap().to_string()),
                audio: source["kind"] == "audio",
                entries: source["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(StatsEntry::from_json)
                    .collect(),
            })
            .collect()
    }

    #[test]
    fn samples_make_the_contracts_blocks() {
        for case in fixture()["samples"].as_array().unwrap() {
            let before = case["before"]
                .is_array()
                .then(|| read_net_stats(&sources(&case["before"])));
            let after = read_net_stats(&sources(&case["after"]));
            let block = net_block(before.as_ref(), &after, case["windowMs"].as_f64().unwrap())
                .map(|block| serde_json::to_value(block).unwrap());
            assert_eq!(
                block.unwrap_or(Value::Null),
                case["block"],
                "{}",
                case["name"]
            );
        }
    }

    fn held(value: &Value) -> HeldNetBlock {
        HeldNetBlock {
            identity: value["identity"].as_str().unwrap().to_string(),
            block: parse_net_block(&value["block"]).unwrap(),
            at_ms: value["atMs"].as_f64().unwrap(),
        }
    }

    #[test]
    fn the_room_gives_the_contracts_numbers() {
        for case in fixture()["room"].as_array().unwrap() {
            let host = (!case["host"].is_null()).then(|| held(&case["host"]));
            let reports: Vec<HeldNetBlock> = case["reports"]
                .as_array()
                .unwrap()
                .iter()
                .map(held)
                .collect();
            let latency = room_latency(case["nowMs"].as_f64().unwrap(), host.as_ref(), &reports);
            assert_eq!(
                serde_json::to_value(latency).unwrap(),
                case["expect"],
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn nothing_measured_reports_nothing() {
        assert!(latency_report("sh_1", &RoomLatency::default(), |_| None).is_none());
        let mut latency = RoomLatency {
            host_rtt_ms: Some(30),
            ..RoomLatency::default()
        };
        latency.people.insert(
            "g_ada".to_string(),
            ConversationDelay {
                ms: 120,
                partial: true,
                to_guest_ms: Some(120),
                from_guest_ms: None,
                video: None,
            },
        );
        let report = latency_report("sh_1", &latency, |_| Some("  Ada  ".to_string())).unwrap();
        assert_eq!(report.people[0].name.as_deref(), Some("Ada"));
        assert_eq!(report.host_rtt_ms, Some(30));
    }
}
