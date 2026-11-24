//! The Stream Manager's core (plan 260 S1.6e, from plan 220 S3.9): the chat
//! list's rows and their links, removal from chat, the pane's filter and
//! window, sending, and Sidekick's cards. Pure state and rules; the window is
//! the app's.
//!
//! Still to land in S1.6e: the activity pane, the composer, the stats and
//! status bar, the dashboard, the chat commands and the window prefs (they
//! need the Studio, S1.6a, behind a trait).

pub mod buddy;
pub mod copy;
pub mod format;
pub mod links;
pub mod list_window;
pub mod pane;
pub mod removal;
pub mod rows;
pub mod send;
