//! Videorc's design system on GPUI, synced from the GPUI flavour of videorc-ui (ui.videorc.com) with `pnpm ui:sync --flavour gpui`. Never edited here, as `apps/desktop/src/renderer/src/components/ui` is synced today. Only this crate and `apps/videorc` touch GPUI.
//!
//! Plan 260 S1.0 created it. This file is the crate's own: one `pub mod` per
//! synced module (`crates/videorc-kit/ui-registry.json` lists the items) and
//! the same re-exports as videorc-ui's `gpui/kit/src/lib.rs`.

pub mod alert;
pub mod chrome;
pub mod icon;
pub mod kbd;
pub mod list_row;
pub mod motion;
pub mod navigable_row;
pub mod panel_section;
pub mod section_label;
pub mod shortcut_keys;
pub mod skeleton;
pub mod theme;
pub mod tokens;
pub mod tooltip;
pub mod window;

pub use alert::{Alert, AlertVariant};
pub use icon::{IconName, icon};
pub use kbd::{Kbd, kbd_group};
pub use list_row::{GroupedList, GroupedRow, ListRow};
pub use navigable_row::NavigableRow;
pub use panel_section::PanelSection;
pub use section_label::SectionLabel;
pub use shortcut_keys::{ShortcutKeys, ShortcutStyle};
pub use skeleton::Skeleton;
pub use theme::{Appearance, FONT, IncreaseContrast, ReduceMotion, TypeScale, faded_over, hsla};
pub use tooltip::{tooltip, tooltip_with_shortcut};
