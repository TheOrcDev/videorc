//! Wire types from `videorc-backend`'s `buddy_pet` module (plan 260 S1.1).
//! The backend re-exports them under their old paths.

use serde::{Deserialize, Serialize};

/// The Buddy's avatar kind (D2): `still` renders the persona's state images
/// (as a flat pack, S-A4), `alive` a pet pack by id. A settings row from
/// before plan 168 loads as Still.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum BuddyAvatar {
    #[default]
    Still,
    Alive {
        #[serde(rename = "packId")]
        pack_id: String,
    },
}

/// What an event makes the Buddy react to (D14). Closed: an unknown
/// trigger never deserializes. Moderation flags are never a trigger (they
/// are private and never on air).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum BuddyTrigger {
    Follow,
    /// Sub, resub, membership.
    Subscription,
    /// Sub gift, community gift.
    Gift,
    /// Cheer, bits, kicks, Super Chat, Super Sticker, Power-up.
    Tip,
    Raid,
    WatchStreak,
    Redemption,
    DestinationFailed,
    /// Plan 225 D9: a regular's arrival.
    Regular,
    /// Plan 225 D9: back after 30 days or more.
    Comeback,
    /// Plan 225 D9: the Nth stream, N in a row, or an anniversary.
    Milestone,
}

impl BuddyTrigger {
    #[cfg_attr(not(test), allow(dead_code))] // tests walk every trigger
    pub const ALL: [BuddyTrigger; 11] = [
        Self::Follow,
        Self::Subscription,
        Self::Gift,
        Self::Tip,
        Self::Raid,
        Self::WatchStreak,
        Self::Redemption,
        Self::DestinationFailed,
        Self::Regular,
        Self::Comeback,
        Self::Milestone,
    ];

    /// D14's default reaction, as a fallback chain: the first id the pack
    /// has wins, then a motion-only hop. Empty means none (a failed
    /// destination, owner default 4).
    pub fn default_reactions(self) -> &'static [&'static str] {
        match self {
            Self::Follow => &["wave", "proud"],
            Self::Subscription | Self::Gift => &["excited"],
            Self::Tip | Self::Raid => &["surprised"],
            Self::WatchStreak => &["proud"],
            Self::Redemption => &["wink"],
            Self::DestinationFailed => &[],
            Self::Regular => &["wave", "proud"],
            Self::Comeback => &["excited", "wave"],
            Self::Milestone => &["excited", "proud"],
        }
    }
}

/// Motion defaults (D10, D13, D15; owner defaults 2 and 3).
pub const BUDDY_MOTION_INTENSITY_DEFAULT: f64 = 0.45;

pub const BUDDY_SLEEP_AFTER_DEFAULT_SECONDS: u32 = 180;

fn default_motion_intensity() -> f64 {
    BUDDY_MOTION_INTENSITY_DEFAULT
}

fn default_sleep_after_seconds() -> u32 {
    BUDDY_SLEEP_AFTER_DEFAULT_SECONDS
}

fn default_breathing() -> bool {
    true
}

/// How the Buddy moves on air (D10, D13, D15), per persona.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BuddyMotionSettings {
    /// 0 to 1; multiplies every transform; 0 keeps frame changes only.
    #[serde(default = "default_motion_intensity")]
    pub intensity: f64,
    /// 0 = never, else 30 to 1800.
    #[serde(default = "default_sleep_after_seconds")]
    pub sleep_after_seconds: u32,
    #[serde(default = "default_breathing")]
    pub breathing: bool,
}

impl Eq for BuddyMotionSettings {}

impl Default for BuddyMotionSettings {
    fn default() -> Self {
        Self {
            intensity: BUDDY_MOTION_INTENSITY_DEFAULT,
            sleep_after_seconds: BUDDY_SLEEP_AFTER_DEFAULT_SECONDS,
            breathing: true,
        }
    }
}
