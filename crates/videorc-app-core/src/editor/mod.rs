//! Plan 260 S1.6b part 4b (L7): the Scene editor's pure core, from
//! videorc-rust's `scenes::{stage, stage_copy, inspector}`, caught up with
//! Electron. The stage's picture geometry and gestures ([`stage`]), its words
//! ([`stage_copy`]), and the Scene page's inspector as data ([`inspector`]).
//! The Studio's editor actions (a drag's commit, a nudge, an inspector edit)
//! land on the scene switch with the stack.
//!
//! Nothing here knows the UI framework or the backend connection.

pub mod inspector;
pub mod stage;
pub mod stage_copy;
