//! Plan 231 S5, D7, D17: the scene cards' still pictures
//! (`hooks/use-scene-pictures.ts`, `scene-entries.tsx`'s targets), as rules
//! a UI follows. One still per thing shown (three scenes on Display 1 share
//! one), asked of `sources.scene_pictures` 240 px wide:
//!
//! - only on macOS, while Videorc is connected, and never while a
//!   recording or livestream runs or while Hide screen holds
//!   ([`pictures_eligible`]); the stills already shown stay;
//! - asked again when a target is added, a session ends or the screen
//!   shows again ([`pictures_refresh_due`]), and when the window comes back
//!   to the front at most every 30 s ([`visibility_refresh_due`]);
//! - an answer that says the screen is hidden keeps the stills, one that
//!   says this Mac can't take them clears them and stops asking
//!   ([`pictures_answer`]).
//!
//! The UI owns the request (one at a time) and draws the JPEGs; which card
//! shows which still is [`picture_key`] of the card's
//! [`crate::scenes::section::scene_picture_target`].

use std::collections::HashMap;

use videorc_protocol::scene_pictures::{
    ScenePictureOutcome, ScenePictureTarget, ScenePicturesParams, ScenePicturesResult,
};

use crate::captions::decode_base64;

/// The stills' width (`maxWidth: 240`).
pub const PICTURE_MAX_WIDTH: u32 = 240;
/// A window coming back to the front asks again at most this often.
pub const VISIBILITY_COOLDOWN_MS: u64 = 30_000;

/// `scenePictureTargetKey`: one key per thing shown.
pub fn picture_key(target: &ScenePictureTarget) -> String {
    match target {
        ScenePictureTarget::App { bundle_id } => format!("app:{bundle_id}"),
        ScenePictureTarget::Window { window_id } => format!("window:{window_id}"),
        ScenePictureTarget::Display { screen_id } => format!("display:{screen_id}"),
    }
}

/// What the stills are asked for: each thing shown once, in key order (so a
/// reorder of the cards asks nothing again), with the two holds.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PictureInputs {
    pub targets: Vec<ScenePictureTarget>,
    /// Hide screen holds (`screenPrivacy.hidden`).
    pub hidden: bool,
    /// A recording or livestream runs (`isSessionActive`).
    pub busy: bool,
}

impl PictureInputs {
    pub fn of(
        targets: impl IntoIterator<Item = ScenePictureTarget>,
        hidden: bool,
        busy: bool,
    ) -> Self {
        let mut keyed: Vec<(String, ScenePictureTarget)> = targets
            .into_iter()
            .map(|target| (picture_key(&target), target))
            .collect();
        keyed.sort_by(|a, b| a.0.cmp(&b.0));
        keyed.dedup_by(|a, b| a.0 == b.0);
        Self {
            targets: keyed.into_iter().map(|(_, target)| target).collect(),
            hidden,
            busy,
        }
    }

    /// The request (`{ targets, maxWidth: 240 }`).
    pub fn params(&self) -> ScenePicturesParams {
        ScenePicturesParams {
            targets: self.targets.clone(),
            max_width: Some(PICTURE_MAX_WIDTH),
        }
    }
}

/// `eligible()`: macOS, connected, a Mac that takes stills, neither hold,
/// and something to ask for.
pub fn pictures_eligible(
    platform: Option<&str>,
    connected: bool,
    unsupported: bool,
    inputs: &PictureInputs,
) -> bool {
    platform == Some("darwin")
        && connected
        && !unsupported
        && !inputs.hidden
        && !inputs.busy
        && !inputs.targets.is_empty()
}

/// The inputs' effect: a target added (one more of a key counts), a session
/// that ended, or the screen shown again asks again. A target removed or a
/// hold starting asks nothing.
pub fn pictures_refresh_due(previous: &PictureInputs, next: &PictureInputs) -> bool {
    let mut remaining: HashMap<String, usize> = HashMap::new();
    for target in &previous.targets {
        *remaining.entry(picture_key(target)).or_default() += 1;
    }
    let added = next.targets.iter().any(|target| {
        let count = remaining.entry(picture_key(target)).or_default();
        if *count == 0 {
            return true;
        }
        *count -= 1;
        false
    });
    added || (previous.busy && !next.busy) || (previous.hidden && !next.hidden)
}

/// The window came back to the front: ask again unless the last such ask
/// (`last_ms`) is under 30 s old. The first one always asks.
pub fn visibility_refresh_due(last_ms: Option<u64>, now_ms: u64) -> bool {
    last_ms.is_none_or(|last| now_ms.saturating_sub(last) >= VISIBILITY_COOLDOWN_MS)
}

/// What an answer does to the stills.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PicturesAnswer {
    /// The screen was hidden while it was asked: keep what is shown.
    Keep,
    /// This Mac takes no stills: clear them and stop asking.
    Unsupported,
    /// The stills, each JPEG's bytes by [`picture_key`]; a target with no
    /// picture (or one that won't decode) has none.
    Pictures(HashMap<String, Vec<u8>>),
}

pub fn pictures_answer(result: &ScenePicturesResult) -> PicturesAnswer {
    if result.hidden == Some(true) {
        return PicturesAnswer::Keep;
    }
    if result.unsupported == Some(true) {
        return PicturesAnswer::Unsupported;
    }
    PicturesAnswer::Pictures(
        result
            .pictures
            .iter()
            .filter_map(|picture| match &picture.outcome {
                ScenePictureOutcome::JpegBase64(jpeg) => {
                    Some((picture_key(&picture.target), decode_base64(jpeg)?))
                }
                ScenePictureOutcome::Unavailable(_) => None,
            })
            .collect(),
    )
}

#[cfg(test)]
#[path = "pictures_tests.rs"]
mod tests;
