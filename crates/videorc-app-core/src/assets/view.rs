//! Pure Images-page helpers (`lib/banners.ts`, `lib/live-backgrounds.ts`,
//! `tabs/assets-tab.tsx` status badges).

use crate::scenes::background::LIVE_BACKGROUND_IDS;

use super::copy;

/// A background slot's status badge (`STATUS_BADGE` in assets-tab).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotStatus {
    Empty,
    Ready,
    Active,
    MissingFile,
    Unsupported,
}

impl SlotStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Empty => copy::STATUS_EMPTY,
            Self::Ready => copy::STATUS_READY,
            Self::Active => copy::STATUS_ACTIVE,
            Self::MissingFile => copy::STATUS_MISSING,
            Self::Unsupported => copy::STATUS_UNSUPPORTED,
        }
    }
}

/// Banner import kind (plan 232).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BannerImportKind {
    Image,
    Html,
}

/// Banner / background import phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ImportPhase {
    #[default]
    Idle,
    Choosing,
    Importing,
}

/// `bannerImportLabel`.
pub fn banner_import_label(
    phase: ImportPhase,
    kind: BannerImportKind,
    running: BannerImportKind,
) -> &'static str {
    let html = kind == BannerImportKind::Html;
    if running != kind || phase == ImportPhase::Idle {
        return if html {
            copy::IMPORT_HTML
        } else {
            copy::IMPORT_IMAGE
        };
    }
    match phase {
        ImportPhase::Importing => copy::IMPORTING,
        ImportPhase::Choosing => {
            if html {
                copy::CHOOSING_HTML
            } else {
                copy::CHOOSING_IMAGE
            }
        }
        ImportPhase::Idle => {
            if html {
                copy::IMPORT_HTML
            } else {
                copy::IMPORT_IMAGE
            }
        }
    }
}

/// Why banner Import is off (`bannerImportBlockedReason`).
pub fn banner_import_blocked_reason(
    offline: bool,
    phase: ImportPhase,
    count: usize,
) -> Option<&'static str> {
    if offline {
        return Some(crate::user_error::OFFLINE_REASON);
    }
    if phase != ImportPhase::Idle {
        return Some("Wait for this import to finish.");
    }
    if count >= 24 {
        return Some("You have 24 banners. Delete one to import another.");
    }
    None
}

/// Live background display name from the catalogue (`LIVE_BACKGROUND_CATALOG`).
pub fn live_background_name(id: &str) -> &'static str {
    match id {
        "silk" => "Silk",
        "side-rays" => "Side Rays",
        "plasma-wave" => "Plasma Wave",
        "liquid-chrome" => "Liquid Chrome",
        "line-waves" => "Line Waves",
        "beams" => "Beams",
        "color-bends" => "Color Bends",
        "dither" => "Dither",
        "ferrofluid" => "Ferrofluid",
        "ghost-fibers" => "Ghost Fibers",
        _ => "Live",
    }
}

/// `liveBackgroundLabel`: "Silk · Satin".
pub fn live_background_label(id: &str, look: &str) -> String {
    format!("{} · {}", live_background_name(id), look_name(id, look))
}

fn look_name(id: &str, look: &str) -> String {
    let known = match (id, look) {
        ("silk", "satin") => Some("Satin"),
        ("silk", "champagne") => Some("Champagne"),
        ("silk", "midnight") => Some("Midnight"),
        ("side-rays", "sunbeam") => Some("Sunbeam"),
        ("side-rays", "moonlight") => Some("Moonlight"),
        ("side-rays", "spotlight") => Some("Spotlight"),
        ("plasma-wave", "plasma") => Some("Plasma"),
        ("plasma-wave", "ember") => Some("Ember"),
        ("plasma-wave", "glacier") => Some("Glacier"),
        ("liquid-chrome", "polished") => Some("Polished"),
        ("liquid-chrome", "gold") => Some("Gold"),
        ("liquid-chrome", "mercury") => Some("Mercury"),
        ("line-waves", "silk") => Some("Silk"),
        ("line-waves", "gold") => Some("Gold"),
        ("line-waves", "aurora") => Some("Aurora"),
        ("beams", "studio") => Some("Studio"),
        ("beams", "chrome") => Some("Chrome"),
        ("beams", "ember") => Some("Ember"),
        ("color-bends", "default") => Some("Default"),
        ("color-bends", "ember") => Some("Ember"),
        ("color-bends", "ocean") => Some("Ocean"),
        ("dither", "classic") => Some("Classic"),
        ("dither", "amber") => Some("Amber"),
        ("dither", "blueprint") => Some("Blueprint"),
        ("ferrofluid", "studio") => Some("Studio"),
        ("ferrofluid", "ember") => Some("Ember"),
        ("ferrofluid", "frost") => Some("Frost"),
        ("ghost-fibers", "violet") => Some("Violet"),
        ("ghost-fibers", "fiber") => Some("Fiber Optic"),
        ("ghost-fibers", "ember") => Some("Ember"),
        _ => None,
    };
    known
        .map(str::to_string)
        .unwrap_or_else(|| look.to_string())
}

/// The ten live backgrounds the Images page offers, in catalogue order.
pub fn live_backgrounds_offered() -> &'static [&'static str] {
    &LIVE_BACKGROUND_IDS
}

/// Takeover import button label.
pub fn takeover_import_label(choosing: bool, importing: bool) -> &'static str {
    if choosing {
        "Choosing images…"
    } else if importing {
        copy::IMPORTING
    } else {
        copy::IMPORT_IMAGES
    }
}

/// Background import button label.
pub fn background_import_label(importing: bool) -> &'static str {
    if importing {
        copy::IMPORTING
    } else {
        copy::IMPORT_IMAGE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn banner_import_words() {
        assert_eq!(
            banner_import_label(
                ImportPhase::Idle,
                BannerImportKind::Image,
                BannerImportKind::Image
            ),
            "Import image…"
        );
        assert_eq!(
            banner_import_label(
                ImportPhase::Choosing,
                BannerImportKind::Html,
                BannerImportKind::Html
            ),
            "Choosing HTML…"
        );
        assert_eq!(
            banner_import_label(
                ImportPhase::Importing,
                BannerImportKind::Image,
                BannerImportKind::Image
            ),
            "Importing…"
        );
    }

    #[test]
    fn live_names() {
        assert_eq!(live_background_name("silk"), "Silk");
        assert_eq!(live_background_label("silk", "satin"), "Silk · Satin");
        assert_eq!(live_backgrounds_offered().len(), 10);
    }
}

/// The same initial look as Electron's LIVE_BACKGROUND_DEFAULT_LOOKS.
/// Resolve by saved identity so live shader metadata and all style defaults
/// follow the scene background normalizer.
pub fn live_background_style(id: &str) -> Option<serde_json::Value> {
    let look = match id {
        "silk" => "satin",
        "side-rays" => "sunbeam",
        "plasma-wave" => "plasma",
        "liquid-chrome" => "polished",
        "line-waves" => "silk",
        "beams" | "ferrofluid" => "studio",
        "color-bends" => "default",
        "dither" => "classic",
        "ghost-fibers" => "violet",
        _ => return None,
    };
    crate::scenes::background::normalize_saved_background(Some(&serde_json::json!({
        "assetId": format!("live-{id}-{look}"),
    })))
    .ok()
    .flatten()
}
