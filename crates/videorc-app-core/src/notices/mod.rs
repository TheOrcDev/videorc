//! Notifications (plan 260 S1.6e; Electron's plan 250 notification center,
//! `lib/notifications/`): what Videorc tells the streamer, kept as entries
//! behind the bell, and the one rule that lets an entry pop up as a toast.
//!
//! - [`guard`]: a provider's raw error never reaches a toast or the list.
//! - [`types`]: the entry, the report that makes it, the bell's count.
//! - [`kinds`]: the registry, one row per kind with its tone and life.
//! - [`policy`]: what pops up, what the number counts, merging two reports
//!   on one subject, the list's order and size, and the words.
//! - [`store`]: one entry per subject, updated in place; the app hands it
//!   the clock and the session's state, and drains its effects.
//!
//! The owner's rules hold here: anything Videorc notices on its own is a
//! bell entry, never a toast, while nothing is recording or live; nothing it
//! found on its own pops up in the first 60 s of a run; a toast answers a
//! press or says an urgent problem in a session the streamer started; a
//! toast's tone colours its icon only, never its card. Plan 250 D11's six
//! (Sidekick's three nudges and the "Remove this message?" question with its
//! two outcomes) stay their own toasts, outside this module.
//!
//! `toasts` keeps the session's toasts as S1.6a (L7) ported them, with
//! their words in `copy`; its names are re-exported here as they were when
//! it was `notices.rs`. [`guard`] is its raw-text guard, in the shape the
//! store takes. The sources land in the next parts.

pub mod guard;
pub mod kinds;
pub mod policy;
pub mod store;
pub mod types;

mod toasts;
pub use toasts::*;

pub use policy::{LAUNCH_QUIET_MS, pop_up_decision};
pub use store::{Effect, Store};
pub use types::{Action, ActionKind, Count, Entry, Input, Resolution, Tone};
