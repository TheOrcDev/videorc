//! Plan 260 S1.6b: the saved scenes as one core model, ported from
//! videorc-rust (plan 220 S3.1e) and caught up with Electron's plan 231
//! (`videorc.scenes.v2`).
//!
//! - [`model`]: plan 210's v1 library (`videorc.scene-presets.v1`) and the
//!   working scene (`videorc.working-scene.v1`), as the renderer reads and
//!   writes them. The v2 store reads its scenes' layouts, audio and
//!   background through it, and the migration reads v1 libraries with it.
//! - [`background`]: a saved scene's background, by id, never a path.
//! - [`v2`]: plan 231's scene (`lib/scenes.ts`): what it shows, both
//!   layouts, the library with the scene on stream.
//! - [`store`]: the v2 reader, the delete rule, the #1706 repair and the
//!   autosave (`lib/scenes-store.ts`).
//! - [`migration`]: the v1 to v2 migration (`lib/scenes-migration.ts`).
//! - [`section`]: the Scenes section's words (`lib/scene-section.ts`).
//! - [`view`]: a scene as the Studio applies it, and the D18/D19 rules for
//!   a scene that draws no screen (`lib/scene-studio.ts`).

pub mod background;
pub mod migration;
pub mod model;
pub mod section;
pub mod store;
pub mod v2;
pub mod view;

#[cfg(test)]
#[path = "model_tests.rs"]
mod model_tests;

#[cfg(test)]
#[path = "v2_tests.rs"]
mod v2_tests;

#[cfg(test)]
#[path = "section_tests.rs"]
mod section_tests;

#[cfg(test)]
#[path = "view_tests.rs"]
mod view_tests;
