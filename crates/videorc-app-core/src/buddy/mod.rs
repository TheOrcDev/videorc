//! Sidekick and the avatar in the core (plan 260 S1.6e, from plan 220
//! S3.10): the avatar's look, name and personality, the account library, the
//! living preview's player and pack, and the test dialog's view. Pure state
//! and rules; the app sends the calls and feeds the events.
//!
//! Since Electron's #1356 and #1372 the co-host is "Sidekick" and the
//! character on stream is "the avatar", on two pages (Sidekick ⌘9, Avatar ⌘8);
//! the module keeps the code name `buddy`, as Electron's files do.
//!
//! Still to land in S1.6e: the chat and voice commands, Sidekick Live, the
//! reports, Clean cut's page and jobs, onboarding, the pet store and the
//! page store.

pub mod chat;
pub mod clean_cut_drafts;
pub mod clean_cut_review;
pub mod community;
pub mod copy;
pub mod library;
pub mod look;
pub mod moments;
/// The avatar's body motion, the backend's own file (its fixture,
/// `protocol-fixtures/buddy-motion.json`, pins it to Electron's
/// `shared/buddy-motion.ts`): the living preview moves as the stream does.
#[path = "../../../videorc-backend/src/buddy_motion.rs"]
pub mod motion;
pub mod persona;
pub mod pet_pack;
pub mod pet_player;
pub mod test_view;

/// `DEFAULT_AVATAR_NAME` (`shared/avatar-name.ts`, plan 239 D2): the official
/// stone golem's name, which a fresh install and Start over wear, and the
/// name any surface falls back to when a persona has none. Equal to the
/// backend's `COHOST_DEFAULT_PERSONA_NAME` and the golem's catalog entry.
pub const DEFAULT_AVATAR_NAME: &str = "Flint";

/// What `pet.rs` (the avatar's packs and moves) holds once it lands; the
/// shipped pack is all `persona` needs from it today.
pub mod pet {
    /// `BUDDY_DEFAULT_OFFICIAL_ID`'s shipped pack (`bundled:buddy`).
    pub const DEFAULT_BUNDLED_PACK: &str = "bundled:buddy";
}
