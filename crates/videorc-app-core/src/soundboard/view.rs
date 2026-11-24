//! Pure Sounds-page helpers (`lib/sounds.ts`).

use videorc_protocol::SoundMode;

use crate::format::plural;

use super::copy;

/// Sound import phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ImportPhase {
    #[default]
    Idle,
    Choosing,
    Importing,
}

/// `SOUND_MODE_LABELS`.
pub fn mode_label(mode: SoundMode) -> &'static str {
    match mode {
        SoundMode::OneShot => copy::MODE_ONE_SHOT,
        SoundMode::Toggle => copy::MODE_TOGGLE,
        SoundMode::Loop => copy::MODE_LOOP,
        SoundMode::Hold => copy::MODE_HOLD,
    }
}

/// Every mode in Electron's order.
pub fn modes() -> &'static [SoundMode] {
    &[
        SoundMode::OneShot,
        SoundMode::Toggle,
        SoundMode::Loop,
        SoundMode::Hold,
    ]
}

/// `soundImportLabel`.
pub fn import_label(phase: ImportPhase) -> &'static str {
    match phase {
        ImportPhase::Choosing => copy::CHOOSING,
        ImportPhase::Importing => copy::IMPORTING,
        ImportPhase::Idle => copy::IMPORT,
    }
}

/// `soundImportBlockedReason`.
pub fn import_blocked_reason(
    offline: bool,
    phase: ImportPhase,
    count: usize,
) -> Option<&'static str> {
    if offline {
        return Some(crate::user_error::OFFLINE_REASON);
    }
    if phase != ImportPhase::Idle {
        return Some(copy::WAIT_FOR_IMPORT);
    }
    if count >= copy::SOUND_MAX_COUNT {
        return Some(copy::SOUND_COUNT_LIMIT_REASON);
    }
    None
}

/// `soundsSectionDescription`.
pub fn section_description(count: Option<usize>) -> String {
    let rules = "up to 30 seconds each · WAV, MP3, M4A, OGG or FLAC.";
    match count {
        None => format!("Sounds {rules}"),
        Some(n) => format!("{} · {rules}", plural(n as i64, "sound", None)),
    }
}

/// `formatSoundDuration`: "1.6 s".
pub fn format_duration(duration_ms: u32) -> String {
    format!("{:.1} s", duration_ms as f64 / 1000.0)
}

/// `soundPadLabel`: "Play Airhorn" / "Stop Airhorn".
pub fn pad_label(name: &str, stops: bool) -> String {
    format!("{} {name}", if stops { "Stop" } else { "Play" })
}

/// `soundOrderAfterMove`.
pub fn order_after_move(ids: &[String], id: &str, target_index: usize) -> Option<Vec<String>> {
    let mut next = ids.to_vec();
    let from = next.iter().position(|entry| entry == id)?;
    let to = target_index.min(next.len().saturating_sub(1));
    if from == to {
        return None;
    }
    let item = next.remove(from);
    next.insert(to, item);
    Some(next)
}

/// Starter slugs the board no longer has (`missingStarterSlugs`).
pub fn missing_starter_slugs(
    starters: &[impl AsRef<str>],
    present: &[Option<impl AsRef<str>>],
) -> Vec<String> {
    let have: std::collections::BTreeSet<&str> = present
        .iter()
        .filter_map(|slug| slug.as_ref().map(|s| s.as_ref()))
        .collect();
    starters
        .iter()
        .map(|s| s.as_ref())
        .filter(|slug| !have.contains(slug))
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_and_description() {
        assert_eq!(import_label(ImportPhase::Idle), "Import sounds…");
        assert_eq!(import_label(ImportPhase::Choosing), "Choosing sounds…");
        assert_eq!(
            section_description(None),
            "Sounds up to 30 seconds each · WAV, MP3, M4A, OGG or FLAC."
        );
        assert!(section_description(Some(2)).starts_with("2 sounds ·"));
        assert_eq!(format_duration(1600), "1.6 s");
        assert_eq!(pad_label("Airhorn", false), "Play Airhorn");
        assert_eq!(mode_label(SoundMode::Hold), "While held");
    }

    #[test]
    fn reorder() {
        let ids = vec!["a".into(), "b".into(), "c".into()];
        assert_eq!(
            order_after_move(&ids, "a", 2).as_deref(),
            Some(["b".to_string(), "c".to_string(), "a".to_string()].as_slice())
        );
        assert_eq!(order_after_move(&ids, "a", 0), None);
    }
}
