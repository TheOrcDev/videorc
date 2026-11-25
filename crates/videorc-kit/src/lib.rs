//! Videorc's design system on GPUI, synced from the GPUI flavour of videorc-ui (ui.videorc.com) with `pnpm ui:sync --flavour gpui`. Never edited here, as `apps/desktop/src/renderer/src/components/ui` is synced today. Only this crate and `apps/videorc` touch GPUI.
//!
//! Plan 260 S1.0 created it. This file is the crate's own: one `pub mod` per
//! synced module (`crates/videorc-kit/ui-registry.json` lists the items) and
//! the same re-exports as videorc-ui's `gpui/kit/src/lib.rs`.

pub mod alert;
pub mod avatar;
pub mod badge;
pub mod bar_visualizer;
pub mod button;
pub mod chat_platform;
pub mod checkbox;
pub mod chrome;
pub mod collapsible;
pub mod command;
pub mod context_menu;
pub mod dialog;
pub mod dropdown_menu;
pub mod empty;
pub mod field;
pub mod hover_card;
pub mod icon;
pub mod input;
pub mod input_group;
pub mod kbd;
pub mod kebab_context_menu;
pub mod kebab_menu;
pub mod label;
pub mod list_row;
pub mod live_waveform;
pub mod motion;
pub mod navigable_row;
pub mod page_tabs;
pub mod panel_section;
pub mod pin_window_button;
pub mod popover;
pub mod qr_code;
pub mod scroll_area;
pub mod section_label;
pub mod segmented_control;
pub mod select;
pub mod separator;
pub mod settings_row;
pub mod shortcut_keys;
pub mod skeleton;
pub mod slider;
pub mod sound_pad;
pub mod spinner;
pub mod status_bar;
pub mod status_bar_action;
pub mod status_dot;
pub mod switch;
pub mod tabs;
pub mod textarea;
pub mod theme;
pub mod toast;
pub mod toggle_group;
pub mod tokens;
pub mod tooltip;
pub mod window;
pub mod window_frame;

pub use alert::{Alert, AlertVariant};
pub use avatar::Avatar;
pub use badge::{Badge, BadgeVariant};
pub use bar_visualizer::{BarVisualizer, BarVisualizerState};
pub use button::{Button, ButtonSize, ButtonVariant};
pub use chat_platform::ChatPlatform;
pub use checkbox::{Checkbox, CheckboxChecked};
pub use collapsible::Collapsible;
pub use context_menu::ContextMenu;
pub use dialog::{Dialog, DialogHandle, DialogSize};
pub use dropdown_menu::{DropdownMenu, Menu, MenuAlign, MenuItem, MenuItemTone, MenuShortcut};
pub use empty::Empty;
pub use field::{Field, FieldGroup, FieldGroupVariant, FieldOrientation};
pub use hover_card::HoverCard;
pub use icon::{IconName, icon};
pub use input::{Input, InputState};
pub use input_group::{InputGroup, InputGroupAddon, InputGroupText};
pub use kbd::{Kbd, kbd_group};
pub use kebab_context_menu::KebabContextMenu;
pub use kebab_menu::{KEBAB_HOST, KebabMenu, KebabMenuItem, KebabReveal, kebab_menu_groups};
pub use label::Label;
pub use list_row::{GroupedList, GroupedRow, ListRow};
pub use live_waveform::LiveWaveform;
pub use navigable_row::NavigableRow;
pub use page_tabs::PageTabs;
pub use panel_section::PanelSection;
pub use pin_window_button::{PIN_WINDOW_LABEL, PinWindowButton};
pub use popover::Popover;
pub use scroll_area::ScrollArea;
pub use section_label::SectionLabel;
pub use segmented_control::{Segment, SegmentedControl};
pub use select::{Select, SelectOption};
pub use separator::{Separator, SeparatorOrientation};
pub use settings_row::{SettingsGroup, SettingsRow};
pub use shortcut_keys::{ShortcutKeys, ShortcutStyle};
pub use skeleton::Skeleton;
pub use slider::{Slider, SliderEvent, SliderState};
pub use sound_pad::{
    SoundPad, SoundPadGrid, SoundPadMode, SoundPadProgressVariant, SoundPadSize, SoundPadVariant,
};
pub use spinner::Spinner;
pub use status_bar::{StatusBar, StatusBarHint};
pub use status_bar_action::StatusBarAction;
pub use status_dot::{StatusDot, StatusTone};
pub use switch::Switch;
pub use tabs::{Tabs, TabsVariant};
pub use textarea::{Textarea, TextareaState};
pub use theme::{Appearance, FONT, IncreaseContrast, ReduceMotion, TypeScale, faded_over, hsla};
pub use toast::{ToastData, ToastKind, Toaster, toast_card};
pub use toggle_group::{ToggleGroup, ToggleItem};
pub use tooltip::{tooltip, tooltip_with_accelerator, tooltip_with_shortcut};
pub use window_frame::{WindowFrame, WindowHeader};

/// Install the kit's keyboard, focus and overlay behaviour once, before
/// opening a window. This is the entrypoint from videorc-ui's kit lib.rs;
/// the registry sync owns the modules, while this file wires the crate.
pub fn init(cx: &mut gpui::App) {
    gpui_base::LayoutDirection::Ltr.set_global(cx);
    gpui_base::init(cx);
    segmented_control::init(cx);
}
