//! Sound pads for Studio → Soundboard (`SoundPad` / `SoundPadGrid` from kit).

use std::time::{SystemTime, UNIX_EPOCH};

use gpui::{AnyElement, prelude::*};
use videorc_app_core::protocol::{Sound, SoundMode, SoundVoice};
use videorc_app_core::soundboard::{self, pad_press_stops};
use videorc_kit::sound_pad::{SoundPad, SoundPadGrid, SoundPadMode, SoundPadSize};

/// Most pads in a row (`SoundPadBoard columns={6}`).
pub const COLUMNS: usize = 6;

/// The pad grid: six equal columns, fewer when a pad would be under 5.5rem.
pub fn grid(
    sounds: &[Sound],
    voices: &std::collections::BTreeMap<String, SoundVoice>,
    disabled: bool,
    entity: gpui::WeakEntity<super::SoundboardSection>,
) -> AnyElement {
    let now_ms = wall_now_ms();
    let mut board = SoundPadGrid::new("sound-pad-board").columns(COLUMNS);
    for sound in sounds {
        let voice = voices.get(&sound.id);
        let playing = voice.is_some();
        let stops = pad_press_stops(sound.mode, playing);
        let label = soundboard::pad_label(&sound.name, stops);
        let mode = pad_mode(sound.mode);
        let progress = voice.and_then(|v| voice_progress(v, now_ms));
        let play_entity = entity.clone();
        let stop_entity = entity.clone();
        let play_id = sound.id.clone();
        let stop_id = sound.id.clone();
        let mut pad = SoundPad::new(
            (gpui::ElementId::from("sound-pad"), sound.id.clone()),
            sound.name.clone(),
        )
        .mode(mode)
        .size(SoundPadSize::Sm)
        .playing(playing)
        .disabled(disabled)
        .accessibility_label(label)
        .on_trigger(move |_, cx| {
            // The kit's Play once pad always triggers: a playing one stops here.
            let _ = play_entity.update(cx, |section, cx| section.pad_click(play_id.clone(), cx));
        })
        .on_stop(move |_, cx| {
            let _ = stop_entity.update(cx, |section, cx| section.stop(stop_id.clone(), cx));
        });
        if let Some(key) = sound.hotkey.clone() {
            pad = pad.hotkey(key);
        }
        if let Some(progress) = progress {
            pad = pad.progress(progress);
        }
        board = board.child(pad);
    }
    board.into_any_element()
}

fn pad_mode(mode: SoundMode) -> SoundPadMode {
    match mode {
        SoundMode::OneShot => SoundPadMode::OneShot,
        SoundMode::Toggle => SoundPadMode::Toggle,
        SoundMode::Loop => SoundPadMode::Loop,
        SoundMode::Hold => SoundPadMode::Hold,
    }
}

/// 0..=1 through a non-loop voice; loops / idle omit progress (kit default).
fn voice_progress(voice: &SoundVoice, now_ms: u64) -> Option<f32> {
    if voice.r#loop || voice.duration_ms == 0 {
        return None;
    }
    let elapsed = now_ms.saturating_sub(voice.started_at_ms) as f32;
    Some((elapsed / voice.duration_ms as f32).clamp(0.0, 1.0))
}

fn wall_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
