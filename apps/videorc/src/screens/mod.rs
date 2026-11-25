//! The screens (plan 260 Phase 3), one folder each, owned by their lane.

pub mod avatar;
pub mod captions;
pub mod chat_media;
pub mod command_palette;
pub mod destinations;
pub mod dialogs;
pub mod error_panels;
pub mod first_run;
pub mod go_live;
pub mod guests;
pub mod health;
pub mod images_sounds;
pub mod library;
pub mod linux_setup;
pub mod notes;
pub mod notifications;
pub mod output;
pub mod scene;
pub mod session_player;
pub mod settings;
pub mod sidekick;
pub mod sources;

// The tabs, badges and Sidekick's cards are read by the kit's Tabs and Badge
// when the kit lands; their rules are tested now.
#[allow(dead_code)]
pub mod stream_manager;
pub mod studio;
