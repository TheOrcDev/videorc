//! Soundboard sounds (plan 189): short sounds the streamer plays into the
//! recording and every stream. A sound is a row in `sounds` and one file
//! `userData/Sounds/<id>.wav`: 48 kHz stereo s16, already trimmed. The
//! original file is not kept.
//!
//! This module owns the domain rules: the import pipeline (decode with the
//! bundled FFmpeg, read back, trim, refuse, measure, level, publish), the
//! starter seeding rule, the hotkey assignment, the update validation, the
//! delete path guard and the one hook every mutation ends in. SQLite rows
//! live in `storage.rs`; the RPCs in `main.rs`; playback in
//! `sound_player.rs`.
//!
//! Refusals are ordinary `anyhow` errors whose message is the verbatim
//! sentence from the plan's "Import", so `sounds.*` callers can show them as
//! warnings unchanged. Never wrap one in `.context`.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use uuid::Uuid;

use crate::atomic_file;
use crate::process_job::output_owned_std_with_timeout;
use crate::protocol::{
    Sound, SoundMode, SoundStarterImport, SoundboardSettingsParams, SoundboardState,
    UpdateSoundParams,
};
use crate::sound_loudness;
use crate::state::AppState;
use crate::storage::{Database, metadata_is_symlink_or_reparse};

pub(crate) const SOUNDS_CHANGED_EVENT: &str = "sounds.changed";

// --- Limits (plan 189 D8) ------------------------------------------------------

pub(crate) const SOUND_MAX_COUNT: usize = 24;
pub(crate) const SOUND_MAX_DURATION_MS: u32 = 30_000;
pub(crate) const SOUND_TOTAL_MAX_DURATION_MS: u64 = 300_000;
pub(crate) const SOUND_MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
/// Shorter than this after the trim is silence, not a sound.
pub(crate) const SOUND_MIN_DURATION_MS: u32 = 50;
pub(crate) const SOUND_NAME_MAX_CHARS: usize = 64;
pub(crate) const SOUND_VOLUME_DB_MIN: i32 = -24;
pub(crate) const SOUND_VOLUME_DB_MAX: i32 = 6;
pub(crate) const SOUNDBOARD_VOLUME_DB_MIN: i32 = -24;
pub(crate) const SOUNDBOARD_VOLUME_DB_MAX: i32 = 12;
/// The keys a sound can take in Studio, in assignment order.
pub(crate) const SOUND_HOTKEYS: [&str; 9] = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
const STARTER_SLUG_MAX_CHARS: usize = 32;

/// The decode is bounded like the Screen image optimizer: the child is
/// killed and reaped past this.
const SOUND_DECODE_TIMEOUT: Duration = Duration::from_secs(20);
/// Decode half a second past the cap so a sound over 30 s is seen as such.
const SOUND_DECODE_CAP_SECONDS: &str = "30.5";
/// A sample at or under this magnitude is under -60 dBFS (32.77 in s16).
const TRIM_FLOOR: i32 = 32;
/// Kept either side of the first and last sound: 10 ms at 48 kHz.
const TRIM_KEEP_FRAMES: usize = 480;
const SAMPLE_RATE: u32 = 48_000;
/// The decode output is bounded by the cap: 30.5 s of 48 kHz stereo s16
/// plus the header; a little more is read so a longer file is detected.
const DECODED_WAV_MAX_BYTES: u64 = 32 * 48_000 * 4 + 4096;

// --- Refusal sentences (plan 189 "Import", verbatim) --------------------------

pub(crate) const REFUSAL_SOUND_NO_AUDIO: &str = "This file has no sound Videorc can play.";
pub(crate) const REFUSAL_SOUND_TOO_LONG: &str =
    "Sounds can be up to 30 seconds. Trim this one and try again.";
pub(crate) const REFUSAL_SOUND_SILENT: &str = "This file is silent.";
pub(crate) const REFUSAL_SOUND_TOO_MANY: &str = "You have 24 sounds. Remove one to add another.";
pub(crate) const REFUSAL_SOUNDS_TOTAL_TOO_LONG: &str =
    "Your sounds add up to 5 minutes. Remove one to add another.";
/// The plan pins no sentence for the 50 MB cap; this one follows the shape
/// of its neighbours.
pub(crate) const REFUSAL_SOUND_TOO_LARGE: &str = "This file is too large. Use one under 50 MB.";

// --- Rows -----------------------------------------------------------------------

/// Everything the row needs besides what SQLite assigns (sort order, the
/// key, timestamps). Built by the import, consumed by `Database::insert_sound`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NewSound {
    pub id: String,
    pub name: String,
    pub duration_ms: u32,
    pub loudness_lufs: f64,
    pub level_db: f64,
    /// The starter slug; `None` for the streamer's own sounds.
    pub starter: Option<String>,
    /// A starter's manifest key, taken when free.
    pub hotkey: Option<String>,
}

/// The one-row `sound_settings` table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SoundSettings {
    pub volume_db: i32,
    pub monitor: bool,
    pub starters_seeded: bool,
}

pub(crate) fn sound_file_name(id: &str) -> String {
    format!("{id}.wav")
}

/// The lowest key 1-9 no sound holds.
pub(crate) fn lowest_free_hotkey(taken: &[String]) -> Option<String> {
    SOUND_HOTKEYS
        .iter()
        .find(|key| !taken.iter().any(|taken| taken == *key))
        .map(|key| (*key).to_string())
}

/// A starter takes its manifest key when it is valid and free, else none.
pub(crate) fn starter_hotkey(wanted: Option<&str>, taken: &[String]) -> Option<String> {
    let key = wanted.filter(|key| is_sound_hotkey(key))?;
    (!taken.iter().any(|taken| taken == key)).then(|| key.to_string())
}

pub(crate) fn is_sound_hotkey(value: &str) -> bool {
    SOUND_HOTKEYS.contains(&value)
}

/// A starter slug: lowercase words joined by hyphens, at most 32 characters
/// (`isSoundStarterSlug` in `shared/sound-assets.ts`).
pub(crate) fn is_starter_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= STARTER_SLUG_MAX_CHARS
        && value.split('-').all(|word| {
            !word.is_empty()
                && word
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// The file stem at import, trimmed to 64 characters.
pub(crate) fn sound_name_from_path(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .trim();
    let name = stem
        .chars()
        .take(SOUND_NAME_MAX_CHARS)
        .collect::<String>()
        .trim_end()
        .to_string();
    if name.is_empty() {
        "Sound".to_string()
    } else {
        name
    }
}

/// Trimmed, 1 to 64 characters.
pub(crate) fn normalize_sound_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    let length = trimmed.chars().count();
    if length == 0 || length > SOUND_NAME_MAX_CHARS {
        bail!("Sound name must be 1 to {SOUND_NAME_MAX_CHARS} characters.");
    }
    Ok(trimmed.to_string())
}

// --- WAV -------------------------------------------------------------------------

/// A small RIFF reader for the decoder's own output: 48 kHz stereo s16 and
/// nothing else. Returns the interleaved samples.
pub(crate) fn read_wav_s16_stereo_48k(bytes: &[u8]) -> Result<Vec<i16>> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        bail!("Decoded sound is not a WAV file.");
    }
    let mut offset = 12;
    let mut format_seen = false;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let body_start = offset + 8;
        let body_end = body_start.saturating_add(size).min(bytes.len());
        let body = &bytes[body_start..body_end];
        match id {
            b"fmt " => {
                if body.len() < 16 {
                    bail!("Decoded WAV has a short format chunk.");
                }
                let tag = u16::from_le_bytes([body[0], body[1]]);
                let channels = u16::from_le_bytes([body[2], body[3]]);
                let rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
                let bits = u16::from_le_bytes([body[14], body[15]]);
                // WAVE_FORMAT_EXTENSIBLE carries the real tag in its subformat.
                let pcm = tag == 1
                    || (tag == 0xFFFE && body.len() >= 26 && body[24] == 1 && body[25] == 0);
                if !pcm || channels != 2 || rate != SAMPLE_RATE || bits != 16 {
                    bail!(
                        "Decoded WAV is not 48 kHz stereo s16 (tag {tag}, {channels} ch, {rate} Hz, {bits} bit)."
                    );
                }
                format_seen = true;
            }
            b"data" => {
                if !format_seen {
                    bail!("Decoded WAV has data before its format chunk.");
                }
                let frames = body.len() / 4;
                let mut samples = Vec::with_capacity(frames * 2);
                for sample in body[..frames * 4].chunks_exact(2) {
                    samples.push(i16::from_le_bytes([sample[0], sample[1]]));
                }
                return Ok(samples);
            }
            _ => {}
        }
        // Chunks are word aligned.
        offset = body_start.saturating_add(size).saturating_add(size % 2);
    }
    bail!("Decoded WAV has no data chunk.");
}

/// The managed file: a 44-byte canonical header and the samples.
pub(crate) fn write_wav_s16_stereo_48k(samples: &[i16]) -> Vec<u8> {
    let data_bytes = (samples.len() * 2) as u32;
    let mut bytes = Vec::with_capacity(44 + samples.len() * 2);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    bytes.extend_from_slice(&(SAMPLE_RATE * 4).to_le_bytes());
    bytes.extend_from_slice(&4u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_bytes.to_le_bytes());
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

// --- Trim and level -----------------------------------------------------------

fn frame_has_sound(samples: &[i16], frame: usize) -> bool {
    i32::from(samples[frame * 2]).abs() > TRIM_FLOOR
        || i32::from(samples[frame * 2 + 1]).abs() > TRIM_FLOOR
}

/// The frames to keep: from 10 ms before the first frame over -60 dBFS to
/// 10 ms after the last, clamped to the sound. `None` when nothing is over
/// the floor.
pub(crate) fn trim_bounds(samples: &[i16]) -> Option<(usize, usize)> {
    let frames = samples.len() / 2;
    let first = (0..frames).find(|frame| frame_has_sound(samples, *frame))?;
    let last = (0..frames)
        .rev()
        .find(|frame| frame_has_sound(samples, *frame))?;
    Some((
        first.saturating_sub(TRIM_KEEP_FRAMES),
        (last + 1 + TRIM_KEEP_FRAMES).min(frames),
    ))
}

/// A decoded sound after the trim, measured and levelled.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PreparedSound {
    pub pcm: Vec<i16>,
    pub duration_ms: u32,
    pub loudness_lufs: f64,
    pub level_db: f64,
}

/// Steps 4 to 6 of the import: trim, the length refusals, loudness and the
/// D5 level.
pub(crate) fn prepare_sound(decoded: Vec<i16>) -> Result<PreparedSound> {
    let Some((start, end)) = trim_bounds(&decoded) else {
        bail!(REFUSAL_SOUND_SILENT);
    };
    let pcm = decoded[start * 2..end * 2].to_vec();
    let frames = pcm.len() / 2;
    let duration_ms = (frames as u64 * 1_000).div_ceil(u64::from(SAMPLE_RATE));
    if duration_ms > u64::from(SOUND_MAX_DURATION_MS) {
        bail!(REFUSAL_SOUND_TOO_LONG);
    }
    if duration_ms < u64::from(SOUND_MIN_DURATION_MS) {
        bail!(REFUSAL_SOUND_SILENT);
    }
    let loudness = sound_loudness::integrated_loudness_lufs(&pcm);
    let peak = sound_loudness::peak_dbfs(&pcm);
    Ok(PreparedSound {
        pcm,
        duration_ms: duration_ms as u32,
        // The wire carries a number: an ungated sound reads at the gate.
        loudness_lufs: sound_loudness::round_tenth(loudness.unwrap_or(-70.0)),
        level_db: sound_loudness::round_tenth(sound_loudness::level_db(loudness, peak)),
    })
}

// --- Import ---------------------------------------------------------------------

/// Step 2: the bundled FFmpeg decodes anything it can into 48 kHz stereo
/// s16 WAV, capped half a second past the limit, as an owned child with a
/// deadline. Any failure (no audio stream, a corrupt file, a timeout) is the
/// one refusal.
fn decode_with_ffmpeg(ffmpeg_path: &str, source: &Path, destination: &Path) -> Result<()> {
    let mut command = Command::new(ffmpeg_path);
    command
        .arg("-nostdin")
        .arg("-hide_banner")
        .args(["-v", "error"])
        .arg("-i")
        .arg(source)
        .args(["-map", "0:a:0", "-vn", "-ac", "2", "-ar", "48000"])
        .args(["-t", SOUND_DECODE_CAP_SECONDS])
        .args(["-c:a", "pcm_s16le", "-f", "wav"])
        .arg(destination);
    let output = match output_owned_std_with_timeout(&mut command, SOUND_DECODE_TIMEOUT) {
        Ok(output) => output,
        Err(error) => {
            tracing::warn!("Sound decode did not finish: {error}");
            bail!(REFUSAL_SOUND_NO_AUDIO);
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        tracing::info!(
            source = %source.display(),
            "FFmpeg could not decode a sound import: {stderr}"
        );
        bail!(REFUSAL_SOUND_NO_AUDIO);
    }
    Ok(())
}

fn read_capped(path: &Path, cap: u64) -> Result<Vec<u8>> {
    let file =
        std::fs::File::open(path).with_context(|| format!("Could not open {}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(cap)
        .read_to_end(&mut bytes)
        .with_context(|| format!("Could not read {}", path.display()))?;
    Ok(bytes)
}

/// Publish `bytes` at `destination` through a staged sibling and an atomic
/// replace, so a crash never leaves a half-written sound behind.
fn write_file_atomically(destination: &Path, bytes: &[u8]) -> Result<()> {
    let parent = destination
        .parent()
        .context("Sound file has no parent directory")?;
    let staged_name = format!(
        ".{}.{}.tmp",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("sound"),
        Uuid::new_v4()
    );
    let staged = parent.join(staged_name);
    let outcome = (|| -> Result<()> {
        let mut file = std::fs::File::create(&staged)
            .with_context(|| format!("Could not create {}", staged.display()))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        atomic_file::replace_file(&staged, destination)
            .with_context(|| format!("Could not publish {}", destination.display()))?;
        Ok(())
    })();
    if outcome.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    outcome
}

/// The managed `Sounds` directory must be a real directory, never a symlink
/// or a reparse point, before anything is written into or deleted from it.
pub(crate) fn validate_managed_sound_root(root: &Path) -> Result<PathBuf> {
    let metadata = std::fs::symlink_metadata(root)
        .with_context(|| "Managed Sounds directory is unavailable.")?;
    if !metadata.is_dir() || metadata_is_symlink_or_reparse(&metadata) {
        bail!("Managed Sounds directory is not a direct regular directory.");
    }
    std::fs::canonicalize(root).context("Managed Sounds directory could not be resolved.")
}

/// The whole import ("Import" in plan 189), blocking: run it on the
/// AssetImport lane through `spawn_blocking`. A starter whose slug the
/// streamer already has is returned as it is (the seed and "Restore starter
/// sounds" rerun safely). Nothing is published half done: the row is
/// inserted last, and the file is removed if it is not.
pub(crate) fn import_sound(
    database: &Database,
    source_path: &Path,
    starter: Option<SoundStarterImport>,
    ffmpeg_path: &str,
) -> Result<Sound> {
    if let Some(starter) = starter.as_ref() {
        if !is_starter_slug(&starter.slug) {
            bail!("Starter slug is invalid.");
        }
        if let Some(existing) = database.sound_by_starter(&starter.slug)? {
            return Ok(existing);
        }
    }
    let size = std::fs::metadata(source_path)
        .with_context(|| format!("Could not read {}", source_path.display()))?
        .len();
    if size > SOUND_MAX_FILE_BYTES {
        bail!(REFUSAL_SOUND_TOO_LARGE);
    }
    if database.count_sounds()? >= SOUND_MAX_COUNT {
        bail!(REFUSAL_SOUND_TOO_MANY);
    }
    let root = database.sound_assets_dir();
    std::fs::create_dir_all(&root)
        .with_context(|| format!("Could not create {}", root.display()))?;
    let root = validate_managed_sound_root(&root)?;
    let id = Uuid::new_v4().to_string();
    // The decoder's output is a hidden sibling of the final file, removed
    // whatever happens next.
    let staged = root.join(format!(".{id}.decode.wav"));
    let decoded = (|| -> Result<Vec<i16>> {
        decode_with_ffmpeg(ffmpeg_path, source_path, &staged)?;
        let bytes = read_capped(&staged, DECODED_WAV_MAX_BYTES)?;
        read_wav_s16_stereo_48k(&bytes)
    })();
    let _ = std::fs::remove_file(&staged);
    let prepared = prepare_sound(decoded?)?;
    let total = database.total_sound_duration_ms()?;
    if total.saturating_add(u64::from(prepared.duration_ms)) > SOUND_TOTAL_MAX_DURATION_MS {
        bail!(REFUSAL_SOUNDS_TOTAL_TOO_LONG);
    }
    let name = match starter.as_ref() {
        Some(starter) => normalize_sound_name(&starter.name)
            .unwrap_or_else(|_| sound_name_from_path(source_path)),
        None => sound_name_from_path(source_path),
    };
    let path = root.join(sound_file_name(&id));
    let published = (|| -> Result<Sound> {
        write_file_atomically(&path, &write_wav_s16_stereo_48k(&prepared.pcm))?;
        database.insert_sound(NewSound {
            id: id.clone(),
            name,
            duration_ms: prepared.duration_ms,
            loudness_lufs: prepared.loudness_lufs,
            level_db: prepared.level_db,
            starter: starter.as_ref().map(|starter| starter.slug.clone()),
            hotkey: starter.and_then(|starter| starter.hotkey),
        })
    })();
    // Not inserted, or a starter that raced in first: the file is an orphan.
    if !published.as_ref().is_ok_and(|sound| sound.id == id) {
        let _ = std::fs::remove_file(&path);
    }
    published
}

// --- Files and delete --------------------------------------------------------

/// The path guard: a stored basename resolves to a file only when it is
/// exactly the managed name for this sound, inside the canonical managed
/// root, and a direct regular file. `Ok(None)` means the file is already
/// gone, which a delete tolerates. Anything else is refused, so a forged row
/// can never turn `sounds.delete` into an arbitrary file deletion, nor a
/// play into an arbitrary file read.
pub(crate) fn managed_sound_file(
    root: &Path,
    sound_id: &str,
    stored_name: &str,
) -> Result<Option<PathBuf>> {
    Uuid::parse_str(sound_id).context("Sound id is invalid.")?;
    let expected = sound_file_name(sound_id);
    if stored_name != expected {
        bail!("Sound file is outside the managed Sounds directory.");
    }
    let root = match std::fs::symlink_metadata(root) {
        Ok(_) => validate_managed_sound_root(root)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).context("Managed Sounds directory could not be inspected.");
        }
    };
    let path = root.join(&expected);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("Sound file could not be inspected."),
    };
    if !metadata.is_file() || metadata_is_symlink_or_reparse(&metadata) {
        bail!("Sound file is not a direct regular file.");
    }
    let canonical = std::fs::canonicalize(&path).context("Sound file could not be resolved.")?;
    if canonical.parent() != Some(root.as_path())
        || canonical.file_name() != Some(std::ffi::OsStr::new(&expected))
    {
        bail!("Sound file escaped the managed Sounds directory.");
    }
    Ok(Some(canonical))
}

/// The sound's PCM from its managed file, for the player's library.
pub(crate) fn load_sound_pcm(database: &Database, sound: &Sound) -> Result<Arc<[i16]>> {
    let root = database.sound_assets_dir();
    let path = managed_sound_file(&root, &sound.id, &sound.file)?
        .with_context(|| format!("The file for {} is missing.", sound.name))?;
    let bytes = read_capped(&path, DECODED_WAV_MAX_BYTES)?;
    Ok(read_wav_s16_stereo_48k(&bytes)?.into())
}

/// `sounds.delete`: refuses paths outside the managed dir, then removes the
/// row and, best effort once SQLite is authoritative, the file. The player
/// stops the sound's voices before this runs.
pub(crate) fn delete_sound(database: &Database, id: &str) -> Result<()> {
    let sound = database.sound_by_id(id)?;
    let root = database.sound_assets_dir();
    let file = managed_sound_file(&root, &sound.id, &sound.file)?;
    database.delete_sound_row(id)?;
    if let Some(path) = file
        && let Err(error) = std::fs::remove_file(&path)
    {
        tracing::warn!(
            path = %path.display(),
            "Could not remove deleted sound file after database commit: {error}"
        );
    }
    Ok(())
}

// --- Update validation -------------------------------------------------------

/// A validated `sounds.update`. `None` leaves a field alone; the key is
/// `Some(None)` when `""` cleared it.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct SoundUpdate {
    pub name: Option<String>,
    pub volume_db: Option<i32>,
    pub mode: Option<SoundMode>,
    pub hotkey: Option<Option<String>>,
}

impl SoundUpdate {
    pub(crate) fn from_params(params: &UpdateSoundParams) -> Result<Self> {
        let name = params
            .name
            .as_deref()
            .map(normalize_sound_name)
            .transpose()?;
        if let Some(volume_db) = params.volume_db
            && !(SOUND_VOLUME_DB_MIN..=SOUND_VOLUME_DB_MAX).contains(&volume_db)
        {
            bail!("Sound volume must be {SOUND_VOLUME_DB_MIN} to +{SOUND_VOLUME_DB_MAX} dB.");
        }
        let hotkey = match params.hotkey.as_deref() {
            None => None,
            Some("") => Some(None),
            Some(key) if is_sound_hotkey(key) => Some(Some(key.to_string())),
            Some(_) => bail!("Sound key must be 1 to 9, or empty for none."),
        };
        Ok(Self {
            name,
            volume_db: params.volume_db,
            mode: params.mode,
            hotkey,
        })
    }
}

/// `sounds.settings`: the board level stays in its fader's range.
pub(crate) fn validate_soundboard_settings(params: &SoundboardSettingsParams) -> Result<()> {
    if let Some(volume_db) = params.volume_db
        && !(SOUNDBOARD_VOLUME_DB_MIN..=SOUNDBOARD_VOLUME_DB_MAX).contains(&volume_db)
    {
        bail!(
            "Soundboard level must be {SOUNDBOARD_VOLUME_DB_MIN} to +{SOUNDBOARD_VOLUME_DB_MAX} dB."
        );
    }
    Ok(())
}

// --- The hook every mutation ends in ---------------------------------------------

/// After any change to the sounds or their settings (import, update, reorder,
/// delete, settings): the whole board is republished as `sounds.changed`
/// under one lock so an older snapshot is never emitted after a newer one.
pub(crate) fn on_sounds_changed(state: &AppState) -> Result<SoundboardState> {
    let _publication = state
        .sound_list_publication
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let board = state.database.soundboard_state()?;
    state.emit_event(SOUNDS_CHANGED_EVENT, board.clone());
    Ok(board)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("videorc-sounds-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn database_in(dir: &Path) -> Database {
        Database::open_file_for_tests(&dir.join("videorc.sqlite3"))
    }

    /// Stereo s16 frames of a 1 kHz tone at `amplitude` (full scale 1.0).
    fn tone(frames: usize, amplitude: f64) -> Vec<i16> {
        let mut samples = Vec::with_capacity(frames * 2);
        for frame in 0..frames {
            let value = amplitude
                * (std::f64::consts::TAU * 1_000.0 * frame as f64 / f64::from(SAMPLE_RATE)).sin();
            let sample = (value * 32_767.0).round() as i16;
            samples.push(sample);
            samples.push(sample);
        }
        samples
    }

    fn silence(frames: usize) -> Vec<i16> {
        vec![0; frames * 2]
    }

    /// The FFmpeg the import would use, when the test machine has one.
    fn ffmpeg_for_tests() -> Option<String> {
        let path = crate::ffmpeg::resolve_ffmpeg_path(None);
        let probe = Command::new(&path).arg("-version").output();
        match probe {
            Ok(output) if output.status.success() => Some(path),
            _ => {
                eprintln!("skipping: no FFmpeg at {path} on this machine");
                None
            }
        }
    }

    /// Whether this FFmpeg has an encoder, so the MP3 and Opus cases can
    /// make their own inputs.
    fn ffmpeg_has_encoder(ffmpeg: &str, encoder: &str) -> bool {
        Command::new(ffmpeg)
            .args(["-hide_banner", "-h", &format!("encoder={encoder}")])
            .output()
            .is_ok_and(|output| {
                output.status.success()
                    && !String::from_utf8_lossy(&output.stdout).contains("is not recognized")
            })
    }

    fn write_wav(dir: &Path, name: &str, samples: &[i16]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, write_wav_s16_stereo_48k(samples)).unwrap();
        path
    }

    #[test]
    fn wav_round_trips_and_refuses_other_shapes() {
        let samples = tone(1_000, 0.5);
        let bytes = write_wav_s16_stereo_48k(&samples);
        assert_eq!(bytes.len(), 44 + samples.len() * 2);
        assert_eq!(read_wav_s16_stereo_48k(&bytes).unwrap(), samples);
        // A header-only file has no data chunk.
        assert!(read_wav_s16_stereo_48k(&bytes[..44]).unwrap().is_empty());
        // Mono, 44.1 kHz and 24-bit are refused by the format chunk.
        let mut mono = bytes.clone();
        mono[22] = 1;
        assert!(read_wav_s16_stereo_48k(&mono).is_err());
        let mut rate = bytes.clone();
        rate[24..28].copy_from_slice(&44_100u32.to_le_bytes());
        assert!(read_wav_s16_stereo_48k(&rate).is_err());
        let mut bits = bytes.clone();
        bits[34] = 24;
        assert!(read_wav_s16_stereo_48k(&bits).is_err());
        assert!(read_wav_s16_stereo_48k(b"RIFFxxxxWAVX").is_err());
        assert!(read_wav_s16_stereo_48k(b"not a wav").is_err());
    }

    #[test]
    fn trim_keeps_10ms_around_the_sound() {
        // 1 s of silence, 100 ms of tone, 1 s of silence.
        let mut samples = silence(48_000);
        samples.extend(tone(4_800, 0.5));
        samples.extend(silence(48_000));
        let (start, end) = trim_bounds(&samples).unwrap();
        // Frame 48_000 is the tone's zero crossing; the first frame over the
        // floor is the next one.
        assert_eq!(start, 48_001 - 480);
        // The last frame of the tone may be a zero crossing; the end lands
        // within a few frames of the tone's end plus 10 ms.
        assert!((52_800 + 480 - 60..=52_800 + 480).contains(&end), "{end}");
        // Clamped at the edges.
        let short = tone(100, 0.5);
        assert_eq!(trim_bounds(&short), Some((0, 100)));
        // Under the floor everywhere: nothing to keep.
        assert_eq!(trim_bounds(&silence(4_800)), None);
        assert_eq!(trim_bounds(&vec![TRIM_FLOOR as i16; 9_600]), None);
        assert_eq!(trim_bounds(&[0, 33]), Some((0, 1)));
    }

    #[test]
    fn prepare_refuses_silence_and_length_and_levels_the_rest() {
        assert_eq!(
            prepare_sound(silence(48_000)).unwrap_err().to_string(),
            REFUSAL_SOUND_SILENT
        );
        // 20 ms of tone: a click, not a sound.
        assert_eq!(
            prepare_sound(tone(960, 0.5)).unwrap_err().to_string(),
            REFUSAL_SOUND_SILENT
        );
        // 30.5 s of tone: the decode cap was reached.
        assert_eq!(
            prepare_sound(tone(48_000 * 30 + 24_000, 0.5))
                .unwrap_err()
                .to_string(),
            REFUSAL_SOUND_TOO_LONG
        );
        // A -20 dBFS second: reads -20 LUFS, levelled +2 dB toward -18.
        let prepared = prepare_sound(tone(48_000, 0.1)).unwrap();
        assert_eq!(prepared.duration_ms, 1_000);
        assert!((prepared.loudness_lufs + 20.0).abs() <= 0.1, "{prepared:?}");
        assert!((prepared.level_db - 2.0).abs() <= 0.1, "{prepared:?}");
        assert_eq!(prepared.pcm.len(), 48_000 * 2);
    }

    #[test]
    fn hotkeys_take_the_lowest_free_key_and_starters_their_own() {
        let none: Vec<String> = Vec::new();
        assert_eq!(lowest_free_hotkey(&none).as_deref(), Some("1"));
        let taken = ["1", "2", "4"].map(String::from);
        assert_eq!(lowest_free_hotkey(&taken).as_deref(), Some("3"));
        let all = SOUND_HOTKEYS.map(String::from);
        assert_eq!(lowest_free_hotkey(&all), None);
        assert_eq!(starter_hotkey(Some("4"), &taken), None);
        assert_eq!(starter_hotkey(Some("5"), &taken).as_deref(), Some("5"));
        assert_eq!(starter_hotkey(Some("0"), &none), None);
        assert_eq!(starter_hotkey(None, &none), None);
        assert!(is_starter_slug("sad-trombone"));
        assert!(is_starter_slug("airhorn2"));
        assert!(!is_starter_slug("Airhorn"));
        assert!(!is_starter_slug("-bad"));
        assert!(!is_starter_slug(""));
        assert!(!is_starter_slug(&"a".repeat(33)));
    }

    #[test]
    fn names_come_from_the_stem_and_updates_are_validated() {
        assert_eq!(
            sound_name_from_path(Path::new("/x/ Air horn .wav")),
            "Air horn"
        );
        // A stem of blanks falls back; a dot-file keeps its dotted stem.
        assert_eq!(sound_name_from_path(Path::new("/x/   .wav")), "Sound");
        let long = format!("/x/{}.mp3", "n".repeat(80));
        assert_eq!(sound_name_from_path(Path::new(&long)).chars().count(), 64);
        assert_eq!(normalize_sound_name("  Boom ").unwrap(), "Boom");
        assert!(normalize_sound_name("   ").is_err());
        assert!(normalize_sound_name(&"n".repeat(65)).is_err());

        let update = SoundUpdate::from_params(&UpdateSoundParams {
            id: "s".into(),
            name: Some(" Gong ".into()),
            volume_db: Some(-3),
            mode: Some(SoundMode::Loop),
            hotkey: Some("".into()),
        })
        .unwrap();
        assert_eq!(
            update,
            SoundUpdate {
                name: Some("Gong".into()),
                volume_db: Some(-3),
                mode: Some(SoundMode::Loop),
                hotkey: Some(None),
            }
        );
        let moved = SoundUpdate::from_params(&UpdateSoundParams {
            id: "s".into(),
            hotkey: Some("7".into()),
            ..UpdateSoundParams::default()
        })
        .unwrap();
        assert_eq!(moved.hotkey, Some(Some("7".into())));
        for (volume_db, hotkey) in [(Some(7), None), (Some(-25), None), (None, Some("0"))] {
            assert!(
                SoundUpdate::from_params(&UpdateSoundParams {
                    id: "s".into(),
                    volume_db,
                    hotkey: hotkey.map(String::from),
                    ..UpdateSoundParams::default()
                })
                .is_err()
            );
        }
        assert!(
            validate_soundboard_settings(&SoundboardSettingsParams {
                volume_db: Some(12),
                ..Default::default()
            })
            .is_ok()
        );
        assert!(
            validate_soundboard_settings(&SoundboardSettingsParams {
                volume_db: Some(13),
                ..Default::default()
            })
            .is_err()
        );
    }

    #[test]
    fn rows_keep_order_keys_and_settings() {
        let dir = temp_dir("rows");
        let database = database_in(&dir);
        let state = database.soundboard_state().unwrap();
        assert!(state.sounds.is_empty());
        assert_eq!(
            (state.volume_db, state.monitor, state.starters_seeded),
            (0, true, false)
        );

        let new = |starter: Option<&str>, hotkey: Option<&str>| NewSound {
            id: Uuid::new_v4().to_string(),
            name: "Sound".into(),
            duration_ms: 1_000,
            loudness_lufs: -20.0,
            level_db: 2.0,
            starter: starter.map(String::from),
            hotkey: hotkey.map(String::from),
        };
        let first = database.insert_sound(new(None, None)).unwrap();
        assert_eq!(first.hotkey.as_deref(), Some("1"));
        assert_eq!(first.file, format!("{}.wav", first.id));
        assert_eq!(first.mode, SoundMode::OneShot);
        let airhorn = database
            .insert_sound(new(Some("airhorn"), Some("1")))
            .unwrap();
        assert_eq!(airhorn.hotkey, None, "the starter's key was taken");
        let tada = database.insert_sound(new(Some("tada"), Some("7"))).unwrap();
        assert_eq!(tada.hotkey.as_deref(), Some("7"));
        // The same starter again is the same row.
        let again = database.insert_sound(new(Some("tada"), Some("8"))).unwrap();
        assert_eq!(again.id, tada.id);
        assert_eq!(database.count_sounds().unwrap(), 3);
        assert_eq!(database.total_sound_duration_ms().unwrap(), 3_000);
        let ids: Vec<String> = database
            .soundboard_state()
            .unwrap()
            .sounds
            .iter()
            .map(|sound| sound.id.clone())
            .collect();
        assert_eq!(
            ids,
            vec![first.id.clone(), airhorn.id.clone(), tada.id.clone()]
        );

        // A taken key moves; "" clears.
        let moved = database
            .update_sound(
                &airhorn.id,
                SoundUpdate {
                    hotkey: Some(Some("1".into())),
                    mode: Some(SoundMode::Hold),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(moved.hotkey.as_deref(), Some("1"));
        assert_eq!(moved.mode, SoundMode::Hold);
        assert_eq!(database.sound_by_id(&first.id).unwrap().hotkey, None);
        let cleared = database
            .update_sound(
                &airhorn.id,
                SoundUpdate {
                    hotkey: Some(None),
                    name: Some("Horn".into()),
                    volume_db: Some(-6),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(cleared.hotkey, None);
        assert_eq!(cleared.name, "Horn");
        assert_eq!(cleared.volume_db, -6);
        assert_eq!(
            database.sound_by_id(&airhorn.id).unwrap().mode,
            SoundMode::Hold
        );

        // Reorder must name every sound once.
        assert!(database.reorder_sounds(&[first.id.clone()]).is_err());
        let reordered = database
            .reorder_sounds(&[tada.id.clone(), first.id.clone(), airhorn.id.clone()])
            .unwrap();
        assert_eq!(reordered[0].id, tada.id);
        assert_eq!(reordered[2].id, airhorn.id);

        // Settings keep untouched fields.
        let settings = database
            .update_sound_settings(&SoundboardSettingsParams {
                volume_db: Some(-6),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            settings,
            SoundSettings {
                volume_db: -6,
                monitor: true,
                starters_seeded: false
            }
        );
        let settings = database
            .update_sound_settings(&SoundboardSettingsParams {
                monitor: Some(false),
                starters_seeded: Some(true),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            settings,
            SoundSettings {
                volume_db: -6,
                monitor: false,
                starters_seeded: true
            }
        );
        assert_eq!(
            database.sound_by_starter("tada").unwrap().map(|s| s.id),
            Some(tada.id.clone())
        );
        assert_eq!(database.sound_by_starter("boom").unwrap(), None);

        database.delete_sound_row(&tada.id).unwrap();
        assert!(database.delete_sound_row(&tada.id).is_err());
        assert_eq!(database.count_sounds().unwrap(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_caps_refuse_the_25th_sound_and_the_sixth_minute() {
        let dir = temp_dir("caps");
        let database = database_in(&dir);
        let new = |duration_ms| NewSound {
            id: Uuid::new_v4().to_string(),
            name: "Sound".into(),
            duration_ms,
            loudness_lufs: -20.0,
            level_db: 2.0,
            starter: None,
            hotkey: None,
        };
        for _ in 0..24 {
            database.insert_sound(new(1_000)).unwrap();
        }
        assert_eq!(
            database.insert_sound(new(1_000)).unwrap_err().to_string(),
            REFUSAL_SOUND_TOO_MANY
        );
        let full = database_in(&temp_dir("caps-total"));
        for _ in 0..10 {
            full.insert_sound(new(29_000)).unwrap();
        }
        assert_eq!(full.total_sound_duration_ms().unwrap(), 290_000);
        assert_eq!(
            full.insert_sound(new(10_001)).unwrap_err().to_string(),
            REFUSAL_SOUNDS_TOTAL_TOO_LONG
        );
        full.insert_sound(new(10_000)).unwrap();
        // The import checks the same caps before decoding or after preparing.
        let path = write_wav(&dir, "one-more.wav", &tone(48_000, 0.3));
        assert_eq!(
            import_sound(&database, &path, None, "ffmpeg-never-run")
                .unwrap_err()
                .to_string(),
            REFUSAL_SOUND_TOO_MANY
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_refuses_paths_outside_the_managed_directory() {
        let dir = temp_dir("delete");
        let database = database_in(&dir);
        let root = database.sound_assets_dir();
        std::fs::create_dir_all(&root).unwrap();
        let id = Uuid::new_v4().to_string();
        let file = sound_file_name(&id);
        std::fs::write(root.join(&file), b"wav").unwrap();
        assert!(managed_sound_file(&root, &id, &file).unwrap().is_some());
        for forged in [
            "../videorc.sqlite3",
            "other.wav",
            "/etc/passwd",
            &format!("{id}.WAV"),
        ] {
            assert!(
                managed_sound_file(&root, &id, forged).is_err(),
                "{forged} must be refused"
            );
        }
        assert!(managed_sound_file(&root, "not-a-uuid", &file).is_err());
        // Missing is tolerated.
        let other = Uuid::new_v4().to_string();
        assert_eq!(
            managed_sound_file(&root, &other, &sound_file_name(&other)).unwrap(),
            None
        );
        #[cfg(unix)]
        {
            let link_id = Uuid::new_v4().to_string();
            std::os::unix::fs::symlink(root.join(&file), root.join(sound_file_name(&link_id)))
                .unwrap();
            assert!(managed_sound_file(&root, &link_id, &sound_file_name(&link_id)).is_err());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_through_ffmpeg_decodes_trims_levels_and_refuses() {
        let Some(ffmpeg) = ffmpeg_for_tests() else {
            return;
        };
        let dir = temp_dir("import");
        let database = database_in(&dir);
        // A WAV with a second of silence, a half second of tone and more
        // silence: trimmed to the tone plus 10 ms either side.
        let mut padded = silence(48_000);
        padded.extend(tone(24_000, 0.1));
        padded.extend(silence(24_000));
        let path = write_wav(&dir, "Padded tone.wav", &padded);
        let sound = import_sound(&database, &path, None, &ffmpeg).unwrap();
        assert_eq!(sound.name, "Padded tone");
        assert!(
            (500 + 20 - 2..=500 + 20).contains(&sound.duration_ms),
            "{sound:?}"
        );
        assert!((sound.loudness_lufs + 20.0).abs() <= 0.3, "{sound:?}");
        assert!((sound.level_db - 2.0).abs() <= 0.3, "{sound:?}");
        assert_eq!(sound.hotkey.as_deref(), Some("1"));
        assert_eq!(sound.starter, None);
        let stored = database.sound_assets_dir().join(&sound.file);
        let pcm = read_wav_s16_stereo_48k(&std::fs::read(&stored).unwrap()).unwrap();
        assert_eq!((pcm.len() / 2).div_ceil(48), sound.duration_ms as usize);
        assert_eq!(
            load_sound_pcm(&database, &sound).unwrap().len(),
            pcm.len(),
            "the player reads the same file"
        );
        // No decoder leftovers beside it.
        assert!(
            std::fs::read_dir(database.sound_assets_dir())
                .unwrap()
                .all(|entry| !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with('.'))
        );

        // A starter: its name, slug and key; a rerun returns the same row.
        let starter = SoundStarterImport {
            slug: "airhorn".into(),
            name: "Airhorn".into(),
            hotkey: Some("1".into()),
        };
        let seeded = import_sound(&database, &path, Some(starter.clone()), &ffmpeg).unwrap();
        assert_eq!(seeded.starter.as_deref(), Some("airhorn"));
        assert_eq!(seeded.name, "Airhorn");
        assert_eq!(seeded.hotkey, None, "key 1 was already taken");
        let again = import_sound(&database, &path, Some(starter), &ffmpeg).unwrap();
        assert_eq!(again.id, seeded.id);
        assert_eq!(database.count_sounds().unwrap(), 2);

        // 31 s of tone: the decode cap is reached and the file refused.
        let long = write_wav(&dir, "long.wav", &tone(48_000 * 31, 0.1));
        assert_eq!(
            import_sound(&database, &long, None, &ffmpeg)
                .unwrap_err()
                .to_string(),
            REFUSAL_SOUND_TOO_LONG
        );
        // Digital silence.
        let quiet = write_wav(&dir, "quiet.wav", &silence(48_000));
        assert_eq!(
            import_sound(&database, &quiet, None, &ffmpeg)
                .unwrap_err()
                .to_string(),
            REFUSAL_SOUND_SILENT
        );
        // A video with no audio stream.
        let video = dir.join("silent.avi");
        let made = Command::new(&ffmpeg)
            .args([
                "-nostdin",
                "-hide_banner",
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
            ])
            .arg("color=c=black:s=16x16:r=10:d=0.5")
            .args(["-c:v", "rawvideo", "-f", "avi"])
            .arg(&video)
            .status()
            .unwrap();
        assert!(made.success());
        assert_eq!(
            import_sound(&database, &video, None, &ffmpeg)
                .unwrap_err()
                .to_string(),
            REFUSAL_SOUND_NO_AUDIO
        );
        // Not a media file at all.
        let text = dir.join("notes.txt");
        std::fs::write(&text, b"hello").unwrap();
        assert_eq!(
            import_sound(&database, &text, None, &ffmpeg)
                .unwrap_err()
                .to_string(),
            REFUSAL_SOUND_NO_AUDIO
        );
        assert_eq!(
            database.count_sounds().unwrap(),
            2,
            "refusals publish nothing"
        );

        // MP3 and Opus in, when this FFmpeg can make them: 48 kHz stereo s16
        // out, at the same loudness.
        for (encoder, extension) in [("libmp3lame", "mp3"), ("libopus", "ogg")] {
            if !ffmpeg_has_encoder(&ffmpeg, encoder) {
                eprintln!("skipping {extension}: this FFmpeg has no {encoder}");
                continue;
            }
            let encoded = dir.join(format!("encoded.{extension}"));
            let made = Command::new(&ffmpeg)
                .args(["-nostdin", "-hide_banner", "-v", "error", "-y", "-i"])
                .arg(&path)
                .args(["-c:a", encoder, "-b:a", "128k"])
                .arg(&encoded)
                .status()
                .unwrap();
            assert!(made.success(), "{encoder} encode");
            let sound = import_sound(&database, &encoded, None, &ffmpeg).unwrap();
            assert_eq!(sound.name, "encoded");
            assert!((450..=600).contains(&sound.duration_ms), "{sound:?}");
            assert!((sound.loudness_lufs + 20.0).abs() <= 1.0, "{sound:?}");
            delete_sound(&database, &sound.id).unwrap();
            assert!(!database.sound_assets_dir().join(&sound.file).exists());
        }

        // Delete removes the row and the file.
        delete_sound(&database, &sound.id).unwrap();
        assert!(!stored.exists());
        assert!(database.sound_by_id(&sound.id).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
