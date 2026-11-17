//! Host-only speech admission from the already processed, published room mic.
//! This module never opens an input device or subscribes to a remote track.
use super::*;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

static CONTROL: Mutex<()> = Mutex::const_new(());
const OWNER_LEASE: Duration = Duration::from_secs(2);
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sync {
    show_id: String,
    source_id: String,
    generation: u64,
    published: bool,
    muted: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pcm {
    source_id: String,
    sequence: u64,
    sample_rate: u32,
    samples: Vec<f32>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    upload_allowed: bool,
    source_id: Option<String>,
    reason: &'static str,
    production_qualified: bool,
}
#[derive(Debug)]
pub(super) struct Owner {
    pub show_id: String,
    pub source_id: String,
    generation: u64,
    pub origin: Instant,
    pub clock: serde_json::Value,
    inner: std::sync::Mutex<Admission>,
}
#[derive(Debug)]
struct Admission {
    until: Instant,
    enabled: bool,
    sequence: u64,
    samples: u64,
    sample_budget: f64,
    budget_at: Instant,
    sample_rate: Option<u32>,
}
fn show_owned(state: &AppState, show: &str) -> bool {
    let status = crate::cloud_show::lock(&state.cloud_show).status();
    !state.process_shutdown_requested()
        && status.show.as_ref().is_some_and(|s| s.id == show)
        && status
            .room
            .as_ref()
            .is_some_and(|r| matches!(r.phase, crate::cloud_talk::CloudRoomPhase::Open))
        && status.on_air.as_ref().is_none_or(|air| air.this_device)
        && !matches!(
            status.phase,
            crate::cloud_show::CloudPhase::Ending
                | crate::cloud_show::CloudPhase::Failed
                | crate::cloud_show::CloudPhase::Off
        )
}
impl Owner {
    pub(super) fn valid(&self, state: &AppState) -> bool {
        self.inner
            .lock()
            .is_ok_and(|a| a.enabled && a.until > Instant::now())
            && show_owned(state, &self.show_id)
    }
    fn revoke(&self) {
        if let Ok(mut a) = self.inner.lock() {
            a.enabled = false;
        }
    }
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_:".contains(&c))
}

/// Source synchronization is not consent: only existing captions/listen intents
/// can admit audio. A muted/off/lost source cancels queued and in-flight speech.
pub async fn sync(state: &AppState, input: Sync) -> Result<Status> {
    // Privacy closes admission before waiting behind an earlier source start/join.
    if input.muted || !input.published {
        let c = state.captions.lock().await;
        if c.room_owner
            .as_ref()
            .is_some_and(|o| o.source_id == input.source_id)
        {
            c.room_owner.as_ref().unwrap().revoke();
            if let Some(stop) = c.stop.as_ref() {
                stop.store(true, Ordering::Release);
            }
        }
    }
    let _serial = CONTROL.lock().await;
    if !show_owned(state, &input.show_id) {
        ownership_lost(state, &input.show_id).await;
    }
    anyhow::ensure!(
        valid_id(&input.show_id)
            && valid_id(&input.source_id)
            && input.generation > 0
            && input.generation <= 9_007_199_254_740_991,
        "Invalid speech owner."
    );
    let available = input.published && !input.muted && show_owned(state, &input.show_id);
    let changed;
    {
        let c = state.captions.lock().await;
        if let Some(o) = c.room_owner.as_ref() {
            anyhow::ensure!(
                input.generation >= o.generation
                    && (input.generation != o.generation || input.source_id == o.source_id),
                "Stale host speech generation."
            );
        }
        changed = c
            .room_owner
            .as_ref()
            .is_none_or(|o| o.source_id != input.source_id || o.show_id != input.show_id);
        if changed || !available {
            if let Some(o) = c.room_owner.as_ref() {
                o.revoke();
            }
            if c.room_owner.is_some()
                && let Some(stop) = c.stop.as_ref()
            {
                stop.store(true, Ordering::Release);
            }
        }
    }
    if changed || !available {
        let _control = CAPTION_CONTROL.lock().await;
        if !finish_caption_task(state, true, false).await {
            bail!("Previous speech provider cleanup is unconfirmed.");
        }
        let mut c = state.captions.lock().await;
        if changed {
            c.room_chunks = true;
            c.capture_epoch = c.capture_epoch.saturating_add(1);
            c.chunks.clear();
            let created_at = crate::cloud_show::lock(&state.cloud_show)
                .status()
                .show
                .and_then(|s| s.created_at);
            let observed = chrono::Utc::now();
            let show_offset_seconds = created_at
                .as_deref()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .map(|created| {
                    (observed.timestamp_millis() - created.timestamp_millis()) as f64 / 1000.0
                })
                .filter(|offset| *offset >= 0.0);
            let clock = serde_json::json!({"basis":"show-created-at-wall-estimate","showCreatedAt":created_at,
                "sourceObservedAt":observed.to_rfc3339(),"showOffsetSeconds":show_offset_seconds,"uncertaintyMs":null});
            c.room_owner = Some(Arc::new(Owner {
                show_id: input.show_id.clone(),
                source_id: input.source_id.clone(),
                generation: input.generation,
                origin: Instant::now(),
                clock,
                inner: std::sync::Mutex::new(Admission {
                    until: Instant::now(),
                    enabled: false,
                    sequence: 0,
                    samples: 0,
                    sample_budget: 0.0,
                    budget_at: Instant::now(),
                    sample_rate: None,
                }),
            }));
        }
        let status = if c.desired_enabled {
            CaptionsStatus::ready()
        } else {
            CaptionsStatus::idle()
        };
        c.status = Some(status.clone());
        c.room_presentation = None;
        if c.listen_wanted && !available {
            spawn_listening_publish(
                state,
                c.listen_epoch,
                crate::cohost::CohostListening::blocked(
                    "host-microphone-unavailable",
                    "The published host microphone is muted or unavailable.",
                ),
            );
        }
        publish_caption_boundary(state, &status, "room-source-changed");
    }
    let (wanted, captions, language, resume) = {
        let c = state.captions.lock().await;
        let wanted = c.desired_enabled || c.listen_wanted;
        let mut resume = false;
        if let Some(owner) = c.room_owner.as_ref() {
            let mut a = owner
                .inner
                .lock()
                .map_err(|_| anyhow::anyhow!("Speech owner unavailable."))?;
            resume = (!a.enabled || a.until <= Instant::now()) && available && wanted;
            a.enabled = available && wanted;
            a.until = Instant::now() + OWNER_LEASE;
        }
        (wanted, c.desired_enabled, c.language.clone(), resume)
    };
    if resume {
        if captions {
            start_captions(state, language).await?;
        } else {
            resume_listen_for_capture(state).await;
        }
    }
    let task_alive = coordinator_task_alive(&*state.captions.lock().await);
    Ok(Status {
        upload_allowed: available && wanted && task_alive,
        source_id: Some(input.source_id),
        reason: if !available {
            "host-microphone-unavailable"
        } else if !wanted {
            "consent-off"
        } else if !task_alive {
            "speech-service-unavailable"
        } else {
            "host-only"
        },
        production_qualified: false,
    })
}

pub async fn audio(state: &AppState, input: Pcm) -> Result<Status> {
    anyhow::ensure!(
        (16_000..=48_000).contains(&input.sample_rate)
            && !input.samples.is_empty()
            && input.samples.len() <= input.sample_rate as usize / 10
            && input
                .samples
                .iter()
                .all(|s| s.is_finite() && s.abs() <= 1.0),
        "Invalid bounded host PCM."
    );
    let c = state.captions.lock().await;
    let owner = c
        .room_owner
        .as_ref()
        .filter(|o| o.source_id == input.source_id && o.valid(state))
        .ok_or_else(|| anyhow::anyhow!("Host speech owner expired."))?;
    anyhow::ensure!(
        (c.desired_enabled || c.listen_wanted) && coordinator_task_alive(&c),
        "Speech consent is off."
    );
    let mut a = owner
        .inner
        .lock()
        .map_err(|_| anyhow::anyhow!("Speech owner unavailable."))?;
    anyhow::ensure!(
        input.sequence > a.sequence && a.sample_rate.is_none_or(|r| r == input.sample_rate),
        "Stale speech frame."
    );
    let samples = a.samples.saturating_add(input.samples.len() as u64);
    let now = Instant::now();
    let budget = (a.sample_budget
        + now.duration_since(a.budget_at).as_secs_f64() * f64::from(input.sample_rate))
    .min(f64::from(input.sample_rate) * 0.2);
    anyhow::ensure!(
        input.samples.len() as f64 <= budget,
        "Speech input exceeded realtime budget."
    );
    a.sample_budget = budget - input.samples.len() as f64;
    a.budget_at = now;
    a.sequence = input.sequence;
    a.samples = samples;
    a.sample_rate = Some(input.sample_rate);
    let frame = AudioFrame {
        timestamp_micros: owner.origin.elapsed().as_micros() as u64,
        captured_at: Instant::now(),
        sample_rate: input.sample_rate,
        channels: 1,
        samples: input.samples,
    };
    offer_caption_frame_to_tap(
        &frame,
        &TAP_ACTIVE,
        &TAP_FRAMES_SEEN,
        &TAP_FRAMES_DROPPED,
        &TAP_LAST_FRAME_MICROS,
        &TAP,
    );
    Ok(Status {
        upload_allowed: true,
        source_id: Some(input.source_id),
        reason: "host-only",
        production_qualified: false,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptRequest {
    show_id: String,
}
pub async fn transcript(
    state: &AppState,
    input: TranscriptRequest,
) -> Result<Vec<crate::storage::HostTranscriptCue>> {
    anyhow::ensure!(
        valid_id(&input.show_id) && show_owned(state, &input.show_id),
        "Host transcript belongs to another show."
    );
    state.database.host_transcript(&input.show_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn room_input_never_falls_back_to_native_capture() {
        assert!(!host_input_eligible(true, false, true));
        assert!(host_input_eligible(true, true, false));
        assert!(host_input_eligible(false, false, true));
    }
    #[test]
    fn refuses_unknown_speaker_and_unsafe_owner_input() {
        assert!(serde_json::from_value::<Sync>(serde_json::json!({"showId":"s","sourceId":"p","generation":1,"published":true,"muted":false,"guestId":"g"})).is_err());
        assert!(!valid_id("../../other"));
        assert!(!valid_id(""));
        assert!(valid_id("show-1_source:2"));
    }
    #[test]
    fn revocation_is_immediate_and_never_rewrites_source_origin() {
        let origin = Instant::now();
        let owner = Owner {
            show_id: "s".into(),
            source_id: "p".into(),
            generation: 1,
            origin,
            clock: serde_json::json!({"uncertaintyMs":null}),
            inner: std::sync::Mutex::new(Admission {
                until: origin + OWNER_LEASE,
                enabled: true,
                sequence: 9,
                samples: 4800,
                sample_budget: 0.0,
                budget_at: origin,
                sample_rate: Some(48000),
            }),
        };
        owner.revoke();
        let admission = owner.inner.lock().unwrap();
        assert!(!admission.enabled);
        assert_eq!(admission.sequence, 9);
        assert_eq!(owner.origin, origin);
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Presentation {
    pub session: String,
    pub expires_at: i64,
    pub stream: bool,
    pub recording: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Overlay {
    session_client_id: String,
    expires_at: i64,
    stream: bool,
    recording: bool,
    frame: SetCaptionOverlayParams,
}
pub async fn install_overlay(
    state: &AppState,
    input: Overlay,
) -> Result<CaptionOverlayTargetsInfo> {
    let mut c = state.captions.lock().await;
    let now = chrono::Utc::now().timestamp_millis();
    anyhow::ensure!(
        c.desired_enabled
            && c.room_owner.as_ref().is_some_and(|o| o.valid(state))
            && c.shadow_status
                .as_ref()
                .and_then(|s| s.session_client_id.as_deref())
                == Some(input.session_client_id.as_str())
            && input.expires_at > now
            && input.expires_at <= now + 10_000,
        "Caption source or cue expired."
    );
    anyhow::ensure!(
        input.frame.png_base64.len() <= 1024 * 1024,
        "Caption raster exceeds the room budget."
    );
    let result = install_caption_overlays(&state.caption_overlay, input.frame)?;
    c.room_presentation = Some(Presentation {
        session: input.session_client_id,
        expires_at: input.expires_at,
        stream: input.stream,
        recording: input.recording,
    });
    Ok(result)
}
pub async fn presentation(state: &AppState) -> Option<Presentation> {
    let c = state.captions.lock().await;
    c.room_presentation
        .as_ref()
        .filter(|p| {
            c.desired_enabled
                && p.expires_at > chrono::Utc::now().timestamp_millis()
                && c.room_owner.as_ref().is_some_and(|o| o.valid(state))
                && c.shadow_status
                    .as_ref()
                    .and_then(|s| s.session_client_id.as_deref())
                    == Some(p.session.as_str())
        })
        .cloned()
}

/// S24 handoff seam: retire consent before joining a losing provider task.
/// Source-generation and controller-epoch identities deliberately stay separate.
pub async fn ownership_lost(state: &AppState, show_id: &str) {
    {
        let mut c = state.captions.lock().await;
        if !c.room_owner.as_ref().is_some_and(|o| o.show_id == show_id) {
            return;
        }
        c.room_owner.as_ref().unwrap().revoke();
        if let Some(stop) = c.stop.as_ref() {
            stop.store(true, Ordering::Release);
        }
        c.desired_enabled = false;
        c.listen_wanted = false;
        c.listen_epoch = c.listen_epoch.saturating_add(1);
        c.room_presentation = None;
    }
    let _control = CAPTION_CONTROL.lock().await;
    finish_caption_task(state, false, false).await;
    let status = CaptionsStatus::idle();
    publish_caption_boundary(state, &status, "room-ownership-lost");
}
