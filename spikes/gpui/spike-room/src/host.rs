//! The host's side of the room (see main.rs). Arguments, all optional:
//!
//! `token <identity> <room>`: prints a JWT signed with `SPIKE_API_KEY` /
//! `SPIKE_API_SECRET` and exits (the runner makes the guests' tokens).
//!
//! `host --url ws://127.0.0.1:17880 --room s08 --seconds 1800 --screen-at 120
//!  --screen-for 60 --overlay-at 60 --stage-every 15 --out DIR`: the host.
//! Its token comes from `SPIKE_ROOM_TOKEN` (never argv, never printed).

use crate::barcode;
use futures::StreamExt;
use livekit::data_stream::api::{StreamByteOptions, StreamWriter};
use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoding, VideoPreset};
use livekit::prelude::*;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::prelude::AudioFrame;
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use livekit::webrtc::video_stream::native::NativeVideoStream;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn arg(name: &str, default: &str) -> String {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
        .unwrap_or_else(|| default.to_string())
}

/// What the host saw from one remote participant.
#[derive(Default)]
struct Seen {
    video_tracks: u32,
    audio_tracks: u32,
    frames: u64,
    frames_since: u64,
    unreadable: u64,
    width: u32,
    height: u32,
    delays: Vec<u64>,
    audio_frames: u64,
    tone_frames: u64,
    expected_hz: f64,
}

type Stats = Arc<Mutex<BTreeMap<String, Seen>>>;

fn percentile(values: &[u64], p: f64) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let rank = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    Some(sorted[rank])
}

/// Guest `guest:<n>` sends a tone at 300 + 100 n Hz.
fn expected_hz(identity: &str) -> f64 {
    identity
        .strip_prefix("guest:")
        .and_then(|n| n.parse::<f64>().ok())
        .map_or(0.0, |n| 300.0 + 100.0 * n)
}

fn goertzel(samples: &[i16], rate: f64, hz: f64) -> f64 {
    let k = 2.0 * (2.0 * std::f64::consts::PI * hz / rate).cos();
    let (mut s1, mut s2) = (0.0, 0.0);
    for &x in samples {
        let s = f64::from(x) + k * s1 - s2;
        s2 = s1;
        s1 = s;
    }
    s1 * s1 + s2 * s2 - k * s1 * s2
}

pub async fn run() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("token") {
        let identity = std::env::args().nth(2).unwrap_or_default();
        let room = std::env::args().nth(3).unwrap_or_default();
        println!("{}", token(&identity, &room)?);
        return Ok(());
    }
    let url = arg("--url", "ws://127.0.0.1:17880");
    let room_name = arg("--room", "s08");
    let seconds: u64 = arg("--seconds", "60").parse()?;
    let screen_at: u64 = arg("--screen-at", "0").parse()?;
    let screen_for: u64 = arg("--screen-for", "30").parse()?;
    let overlay_at: u64 = arg("--overlay-at", "0").parse()?;
    let stage_every: u64 = arg("--stage-every", "15").parse()?;
    let out = std::path::PathBuf::from(arg("--out", "."));
    let token = std::env::var("SPIKE_ROOM_TOKEN")?;

    let started = Instant::now();
    let mut options = RoomOptions::default();
    options.auto_subscribe = false; // subscribe guest by guest, never the program page
    options.adaptive_stream = false;
    options.dynacast = true;
    let (room, mut events) = Room::connect(&url, &token, options).await?;
    drop(token);
    let connect_ms = started.elapsed().as_millis();
    println!("[spike] connected {}", json!({"connect_ms": connect_ms, "room": room_name}));
    let room = Arc::new(room);

    // Camera: 1280x720 I420 at 30 fps, simulcast 180p/360p as Electron.
    let camera = NativeVideoSource::new(VideoResolution { width: 1280, height: 720 }, false);
    let camera_track =
        LocalVideoTrack::create_video_track("camera", RtcVideoSource::Native(camera.clone()));
    let layer = |w, h, bitrate| VideoPreset::new(w, h, bitrate, 20.0);
    room.local_participant()
        .publish_track(
            LocalTrack::Video(camera_track),
            TrackPublishOptions {
                source: TrackSource::Camera,
                video_codec: VideoCodec::VP8,
                simulcast: true,
                simulcast_layers: Some(vec![layer(320, 180, 160_000), layer(640, 360, 450_000)]),
                video_encoding: Some(VideoEncoding { max_bitrate: 1_700_000, max_framerate: 30.0 }),
                ..Default::default()
            },
        )
        .await?;
    // Microphone: a 440 Hz tone, 48 kHz mono, 10 ms frames.
    let mic = NativeAudioSource::new(AudioSourceOptions::default(), 48_000, 1, 100);
    let mic_track = LocalAudioTrack::create_audio_track("microphone", RtcAudioSource::Native(mic.clone()));
    room.local_participant()
        .publish_track(
            LocalTrack::Audio(mic_track),
            TrackPublishOptions { source: TrackSource::Microphone, ..Default::default() },
        )
        .await?;

    let camera_frames = Arc::new(std::sync::atomic::AtomicU64::new(0));
    spawn_camera(camera, camera_frames.clone(), 1280, 720);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(10));
        let mut phase = 0.0f64;
        loop {
            tick.tick().await;
            let samples: Vec<i16> = (0..480)
                .map(|_| {
                    phase += 2.0 * std::f64::consts::PI * 440.0 / 48_000.0;
                    (phase.sin() * 6000.0) as i16
                })
                .collect();
            let frame = AudioFrame {
                data: samples.into(),
                sample_rate: 48_000,
                num_channels: 1,
                samples_per_channel: 480,
            };
            let _ = mic.capture_frame(&frame).await;
        }
    });

    let stats: Stats = Arc::new(Mutex::new(BTreeMap::new()));
    let program = Arc::new(Mutex::new(json!({"reports": 0, "tracks_published": 0, "tracks_subscribed": 0})));
    // Publications already in the room when the host joined: TrackPublished
    // only reports later ones.
    for participant in room.remote_participants().values() {
        for publication in participant.track_publications().values() {
            handle_event(
                RoomEvent::TrackPublished { publication: publication.clone(), participant: participant.clone() },
                &stats,
                &program,
            )
            .await;
        }
    }
    let overlays = Arc::new(Mutex::new(Vec::<Value>::new()));
    let mut screen: Option<(TrackSid, tokio::task::JoinHandle<()>)> = None;
    let mut stage_seq = 0u64;
    let mut next_stage = Instant::now();
    let mut overlay_done = overlay_at == 0;
    let mut report = tokio::time::interval(Duration::from_secs(10));
    let deadline = started + Duration::from_secs(seconds);

    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline.into()) => break,
            _ = report.tick() => print_stats(&stats, started, &camera_frames),
            event = events.recv() => {
                let Some(event) = event else { break };
                handle_event(event, &stats, &program).await;
            }
        }
        let elapsed = started.elapsed().as_secs();
        if Instant::now() >= next_stage {
            stage_seq += 1;
            let stage: Vec<String> = stats
                .lock()
                .unwrap()
                .keys()
                .filter(|id| id.starts_with("guest:"))
                .take(5)
                .cloned()
                .collect();
            let payload = json!({"v": 1, "seq": stage_seq, "stage": stage, "sentAt": now_ms()});
            room.local_participant()
                .publish_data(DataPacket {
                    payload: payload.to_string().into_bytes(),
                    topic: Some("videorc.stage".into()),
                    reliable: true,
                    ..Default::default()
                })
                .await?;
            next_stage = Instant::now() + Duration::from_secs(stage_every);
        }
        if screen_at > 0 && screen.is_none() && elapsed >= screen_at && elapsed < screen_at + screen_for {
            let source = NativeVideoSource::new(VideoResolution { width: 1920, height: 1080 }, true);
            let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source.clone()));
            let published = room
                .local_participant()
                .publish_track(
                    LocalTrack::Video(track),
                    TrackPublishOptions {
                        source: TrackSource::Screenshare,
                        video_codec: VideoCodec::VP8,
                        simulcast: false,
                        video_encoding: Some(VideoEncoding { max_bitrate: 4_000_000, max_framerate: 30.0 }),
                        ..Default::default()
                    },
                )
                .await?;
            let frames = Arc::new(std::sync::atomic::AtomicU64::new(0));
            let task = spawn_camera(source, frames, 1920, 1080);
            println!("[spike] screen published {}", json!({"at_s": elapsed}));
            screen = Some((published.sid(), task));
        }
        if let Some((sid, task)) = screen.as_ref()
            && elapsed >= screen_at + screen_for
        {
            task.abort();
            room.local_participant().unpublish_track(sid).await?;
            println!("[spike] screen unpublished {}", json!({"at_s": elapsed}));
            screen = None;
        }
        if !overlay_done && elapsed >= overlay_at {
            overlay_done = true;
            let room = room.clone();
            let overlays = overlays.clone();
            tokio::spawn(async move {
                let result = send_overlays(&room).await;
                overlays.lock().unwrap().extend(result);
            });
        }
    }

    // Track layers as the server holds them.
    let tracks = server_tracks(&url, &room_name).await.unwrap_or_else(|e| json!({"error": e.to_string()}));
    let summary = summary(&stats, &program, &overlays, &camera_frames, started, connect_ms, tracks);
    std::fs::write(out.join("summary-host.json"), serde_json::to_string_pretty(&summary)?)?;
    println!("[spike] summary {summary}");
    room.close().await?;
    Ok(())
}

fn token(identity: &str, room: &str) -> anyhow::Result<String> {
    use livekit_api::access_token::{AccessToken, VideoGrants};
    let key = std::env::var("SPIKE_API_KEY")?;
    let secret = std::env::var("SPIKE_API_SECRET")?;
    Ok(AccessToken::with_api_key(&key, &secret)
        .with_identity(identity)
        .with_name(identity)
        .with_grants(VideoGrants {
            room_join: true,
            room: room.to_string(),
            can_publish: true,
            can_subscribe: true,
            can_publish_data: true,
            ..Default::default()
        })
        .to_jwt()?)
}

/// Pushes 30 fps I420 frames with a moving bar and the wall-clock barcode.
fn spawn_camera(
    source: NativeVideoSource,
    frames: Arc<std::sync::atomic::AtomicU64>,
    width: u32,
    height: u32,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_micros(33_333));
        let mut n = 0u32;
        loop {
            tick.tick().await;
            let mut buffer = I420Buffer::new(width, height);
            let (stride_y, _, _) = buffer.strides();
            let (y, u, v) = buffer.data_mut();
            y.fill(90);
            u.fill(128);
            v.fill(160);
            let bar = (n * 8) % width;
            for row in 100..height as usize {
                let start = row * stride_y as usize + bar as usize;
                let end = (start + 40).min(row * stride_y as usize + width as usize);
                y[start..end].fill(200);
            }
            barcode::draw(y, stride_y as usize, now_ms());
            let frame = VideoFrame {
                rotation: VideoRotation::VideoRotation0,
                timestamp_us: 0,
                frame_metadata: None,
                buffer,
            };
            source.capture_frame(&frame);
            frames.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            n += 1;
        }
    })
}

async fn handle_event(event: RoomEvent, stats: &Stats, program: &Arc<Mutex<Value>>) {
    match event {
        RoomEvent::TrackPublished { publication, participant } => {
            let identity = participant.identity().as_str().to_string();
            if identity.starts_with("program:") {
                // The managed show's program page: read its reports, never its picture.
                let mut p = program.lock().unwrap();
                p["tracks_published"] = json!(p["tracks_published"].as_u64().unwrap_or(0) + 1);
            } else {
                publication.set_subscribed(true);
            }
        }
        RoomEvent::TrackSubscribed { track, participant, .. } => {
            let identity = participant.identity().as_str().to_string();
            if identity.starts_with("program:") {
                let mut p = program.lock().unwrap();
                p["tracks_subscribed"] = json!(p["tracks_subscribed"].as_u64().unwrap_or(0) + 1);
                return;
            }
            match track {
                RemoteTrack::Video(video) => {
                    stats.lock().unwrap().entry(identity.clone()).or_default().video_tracks += 1;
                    let stats = stats.clone();
                    tokio::spawn(async move {
                        let mut stream = NativeVideoStream::new(video.rtc_track());
                        while let Some(frame) = stream.next().await {
                            let i420 = frame.buffer.to_i420();
                            let (y, _, _) = i420.data();
                            let (stride, _, _) = i420.strides();
                            let width = frame.buffer.width();
                            let read = barcode::read(y, stride as usize, width);
                            let now = now_ms();
                            let mut all = stats.lock().unwrap();
                            let seen = all.entry(identity.clone()).or_default();
                            seen.frames += 1;
                            seen.frames_since += 1;
                            seen.width = width;
                            seen.height = frame.buffer.height();
                            match read {
                                Some(sent) if sent <= now && now - sent < 10_000 => seen.delays.push(now - sent),
                                _ => seen.unreadable += 1,
                            }
                        }
                    });
                }
                RemoteTrack::Audio(audio) => {
                    let hz = expected_hz(&identity);
                    {
                        let mut all = stats.lock().unwrap();
                        let seen = all.entry(identity.clone()).or_default();
                        seen.audio_tracks += 1;
                        seen.expected_hz = hz;
                    }
                    let stats = stats.clone();
                    tokio::spawn(async move {
                        let mut stream = NativeAudioStream::new(audio.rtc_track(), 48_000, 1);
                        while let Some(frame) = stream.next().await {
                            let target = goertzel(&frame.data, 48_000.0, hz);
                            let off = goertzel(&frame.data, 48_000.0, hz + 150.0);
                            let mut all = stats.lock().unwrap();
                            let seen = all.entry(identity.clone()).or_default();
                            seen.audio_frames += 1;
                            if hz > 0.0 && target > 10.0 * off && target > 1e9 {
                                seen.tone_frames += 1;
                            }
                        }
                    });
                }
            }
        }
        RoomEvent::DataReceived { topic, participant, .. } => {
            let from_program = participant
                .as_ref()
                .is_some_and(|p| p.identity().as_str().starts_with("program:"));
            if from_program && topic.as_deref() == Some("videorc.program") {
                let mut p = program.lock().unwrap();
                p["reports"] = json!(p["reports"].as_u64().unwrap_or(0) + 1);
            }
        }
        RoomEvent::Disconnected { reason } => println!("[spike] error {}", json!({"disconnected": format!("{reason:?}")})),
        RoomEvent::Reconnecting => println!("[spike] reconnecting {{}}"),
        RoomEvent::Reconnected => println!("[spike] reconnected {{}}"),
        _ => {}
    }
}

fn overlay_attributes(slot: &str) -> HashMap<String, String> {
    [
        ("v", "1"),
        ("slot", slot),
        ("o", "horizontal"),
        ("x", "0.050000"),
        ("y", "0.700000"),
        ("w", "0.400000"),
        ("h", "0.200000"),
        ("ttl", "8"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

/// The overlay byte streams: a whole 2 MiB PNG set, a clear, then two sets
/// cancelled half-way (one by dropping the writer, one closed with a
/// reason). The guests report what they saw.
async fn send_overlays(room: &Room) -> Vec<Value> {
    let png = barcode::noise_png(816, 816);
    let mut results = Vec::new();
    let options = |slot: &str| {
        let mut o = StreamByteOptions::new_with_topic("videorc.overlay.set");
        o.mime_type = Some("image/png".into());
        o.total_length = Some(png.len() as u64);
        o.attributes = overlay_attributes(slot);
        o
    };
    // 1. A whole set, in 16 KiB writes as Electron sends it.
    let started = Instant::now();
    let outcome = async {
        let writer = room.local_participant().stream_bytes(options("card")).await?;
        for chunk in png.chunks(16 * 1024) {
            writer.write(chunk).await?;
        }
        writer.close().await
    }
    .await;
    results.push(json!({"kind": "set", "slot": "card", "bytes": png.len(), "ms": started.elapsed().as_millis(), "ok": outcome.is_ok(), "error": outcome.err().map(|e| e.to_string())}));
    // 2. The clear.
    let started = Instant::now();
    let body = json!({"v": 1, "slot": "card", "o": "horizontal"}).to_string();
    let outcome = async {
        let mut o = StreamByteOptions::new_with_topic("videorc.overlay.clear");
        o.mime_type = Some("application/json".into());
        o.total_length = Some(body.len() as u64);
        let writer = room.local_participant().stream_bytes(o).await?;
        writer.write(body.as_bytes()).await?;
        writer.close().await
    }
    .await;
    results.push(json!({"kind": "clear", "ms": started.elapsed().as_millis(), "ok": outcome.is_ok()}));
    // 3. Cancelled by dropping the writer half-way (the SDK's drop sends a trailer).
    let outcome = async {
        let writer = room.local_participant().stream_bytes(options("cancel-drop")).await?;
        for chunk in png[..png.len() / 2].chunks(16 * 1024) {
            writer.write(chunk).await?;
        }
        drop(writer);
        Ok::<_, livekit::data_stream::api::StreamError>(())
    }
    .await;
    results.push(json!({"kind": "cancel-drop", "ok": outcome.is_ok()}));
    tokio::time::sleep(Duration::from_millis(500)).await;
    // 4. Cancelled with a reason.
    let outcome = async {
        let writer = room.local_participant().stream_bytes(options("cancel-reason")).await?;
        for chunk in png[..png.len() / 2].chunks(16 * 1024) {
            writer.write(chunk).await?;
        }
        writer.close_with_reason("cancelled").await
    }
    .await;
    results.push(json!({"kind": "cancel-reason", "ok": outcome.is_ok()}));
    println!("[spike] overlays {}", json!(results));
    results
}

async fn server_tracks(url: &str, room: &str) -> anyhow::Result<Value> {
    use livekit_api::services::room::RoomClient;
    let http = url.replace("ws://", "http://");
    let client = RoomClient::with_api_key(&http, &std::env::var("SPIKE_API_KEY")?, &std::env::var("SPIKE_API_SECRET")?);
    let participants = client.list_participants(room).await?;
    Ok(participants
        .iter()
        .filter(|p| p.identity.starts_with("host:"))
        .flat_map(|p| p.tracks.iter())
        .map(|t| {
            json!({
                "name": t.name, "source": t.source, "mime": t.mime_type, "simulcast": t.simulcast,
                "width": t.width, "height": t.height,
                "layers": t.layers.iter().map(|l| json!({"quality": l.quality, "w": l.width, "h": l.height, "bitrate": l.bitrate})).collect::<Vec<_>>()
            })
        })
        .collect())
}

fn print_stats(stats: &Stats, started: Instant, camera: &std::sync::atomic::AtomicU64) {
    let mut all = stats.lock().unwrap();
    let mut per = serde_json::Map::new();
    for (id, seen) in all.iter_mut() {
        let recent: Vec<u64> = seen.delays.iter().rev().take(300).copied().collect();
        per.insert(id.clone(), json!({
            "fps": seen.frames_since as f64 / 10.0, "frames": seen.frames, "size": format!("{}x{}", seen.width, seen.height),
            "delay_p50": percentile(&recent, 50.0), "delay_p95": percentile(&recent, 95.0),
            "unreadable": seen.unreadable, "tone": if seen.audio_frames > 0 { seen.tone_frames as f64 / seen.audio_frames as f64 } else { 0.0 },
        }));
        seen.frames_since = 0;
    }
    println!("[spike] stats {}", json!({"t_s": started.elapsed().as_secs(), "camera_frames": camera.load(std::sync::atomic::Ordering::Relaxed), "remotes": per}));
}

fn summary(
    stats: &Stats,
    program: &Arc<Mutex<Value>>,
    overlays: &Arc<Mutex<Vec<Value>>>,
    camera: &std::sync::atomic::AtomicU64,
    started: Instant,
    connect_ms: u128,
    tracks: Value,
) -> Value {
    let all = stats.lock().unwrap();
    let remotes: serde_json::Map<String, Value> = all
        .iter()
        .map(|(id, seen)| {
            let steady: Vec<u64> = seen.delays.iter().skip(60).copied().collect();
            (id.clone(), json!({
                "video_tracks": seen.video_tracks, "audio_tracks": seen.audio_tracks,
                "frames": seen.frames, "unreadable": seen.unreadable, "size": format!("{}x{}", seen.width, seen.height),
                "delay_p50_ms": percentile(&steady, 50.0), "delay_p95_ms": percentile(&steady, 95.0), "delay_max_ms": steady.iter().max(),
                "audio_frames": seen.audio_frames, "tone_fraction": if seen.audio_frames > 0 { seen.tone_frames as f64 / seen.audio_frames as f64 } else { 0.0 },
                "expected_hz": seen.expected_hz,
            }))
        })
        .collect();
    json!({
        "seconds": started.elapsed().as_secs(),
        "connect_ms": connect_ms,
        "camera_frames_sent": camera.load(std::sync::atomic::Ordering::Relaxed),
        "remotes": remotes,
        "program": *program.lock().unwrap(),
        "overlays": *overlays.lock().unwrap(),
        "host_tracks_on_server": tracks,
    })
}
