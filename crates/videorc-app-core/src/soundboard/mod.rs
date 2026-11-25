//! Sounds page (⇧⌘S; Electron `tabs/sounds-tab.tsx`, `sounds-section.tsx`)
//! and the Studio soundboard's shared words (`lib/sounds.ts`). Plan 260
//! Phase 3: the GPUI screen draws these; the backend owns the board.
//!
//! Studio → Soundboard and room routing live in [`studio`] and [`room`].

pub mod copy;
pub mod room;
pub mod starters;
pub mod studio;
pub mod view;

pub use copy::*;
pub use room::*;
pub use studio::*;
pub use view::*;
