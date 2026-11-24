//! Plan 260 S1.6d: guests and rooms (plan 224's talk show). The Guests
//! page, the Show stage and the Studio's guests row as values, ported from
//! the renderer (`lib/guests-view.ts`, `lib/stage-screens.ts`,
//! `lib/talk-show-layout.ts`). The room's transport (LiveKit) is S1.8's, in
//! the backend; nothing here talks to a room.

pub mod iso;
pub mod layout;
pub mod presentation;
pub mod program;
pub mod session;
pub mod stage_screens;
pub mod tile;
pub mod view;
pub mod wire;
