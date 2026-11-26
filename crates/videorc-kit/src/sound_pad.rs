//! SoundPad / SoundPadGrid (`components/ui/sound-pad.tsx`): audiocn-style
//! pads for the Studio soundboard. A pad triggers or stops by mode
//! (one-shot / toggle / hold / loop), shows a playing ring, an optional
//! hotkey chip, and progress (ring, bar, or fill). The grid lays pads in
//! columns; page-level hotkeys stay with the screen (Studio captures 1–9).

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, FontWeight, IntoElement, MouseButton, MouseDownEvent,
    MouseUpEvent, SharedString, Toggled, Window, canvas, div, prelude::*, px, relative,
};
use gpui_base::ElementExt as _;
use smallvec::SmallVec;

use crate::{
    chrome,
    kbd::Kbd,
    theme::{Appearance, faded_over, hsla, resolve, with_alpha},
    tokens::{Color, radius},
};

/// How presses map to trigger and stop.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SoundPadMode {
    #[default]
    OneShot,
    Toggle,
    Hold,
    Loop,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SoundPadVariant {
    #[default]
    Default,
    Ghost,
    Outline,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SoundPadSize {
    #[default]
    Default,
    Sm,
    Lg,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SoundPadProgressVariant {
    Bar,
    Fill,
    /// 20 px stroke ring in the corner (the kit default for C3).
    #[default]
    Ring,
}

type TriggerHandler = Rc<dyn Fn(&mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct SoundPadGrid {
    id: ElementId,
    columns: usize,
    children: SmallVec<[AnyElement; 8]>,
    appearance: Option<Appearance>,
}

impl SoundPadGrid {
    pub fn new(id: impl Into<ElementId>) -> Self {
        SoundPadGrid {
            id: id.into(),
            columns: 4,
            children: SmallVec::new(),
            appearance: None,
        }
    }

    /// Most pads in a row; a narrower grid drops columns to keep each pad
    /// at least 5.5rem wide.
    pub fn columns(mut self, columns: usize) -> Self {
        self.columns = columns.max(1);
        self
    }

    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl ParentElement for SoundPadGrid {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// The narrowest pad (`--pad-min-width`, 5.5rem).
const PAD_MIN_WIDTH: f32 = 88.0;
/// Between pads (`--pad-gap`, 0.5rem).
const PAD_GAP: f32 = 8.0;

/// How many equal tracks the grid lays across `width`:
/// `repeat(auto-fill, minmax(max(5.5rem, (100% - (n-1) gap) / n), 1fr))`.
/// At most `most`, fewer when a pad would be narrower than 5.5rem, never
/// none. Before the grid is measured (`width` 0) it assumes `most`.
pub fn sound_pad_columns(width: f32, most: usize) -> u16 {
    let most = most.clamp(1, u16::MAX as usize) as u16;
    if width <= 0.0 {
        return most;
    }
    let share = (width - f32::from(most - 1) * PAD_GAP) / f32::from(most);
    let track = PAD_MIN_WIDTH.max(share);
    // A hair of slack: `most` tracks of `share` fill `width` exactly.
    let fit = ((width + PAD_GAP) / (track + PAD_GAP) + 1e-3).floor();
    (fit as u16).clamp(1, most)
}

impl RenderOnce for SoundPadGrid {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        // A grid, as Electron's: every pad is one track wide, so a short
        // last row keeps the others' width instead of stretching.
        let width = crate::page::measured_width(&self.id, window, cx);
        let columns = sound_pad_columns(*width.read(cx), self.columns);
        div()
            .id(self.id)
            .role(gpui::Role::Group)
            .grid()
            .grid_cols(columns)
            .gap(px(PAD_GAP))
            .w_full()
            .on_prepaint(move |bounds, window, cx| {
                crate::page::record_width(&width, bounds, window, cx)
            })
            .children(self.children)
    }
}

#[derive(IntoElement)]
pub struct SoundPad {
    id: ElementId,
    label: SharedString,
    hotkey: Option<SharedString>,
    mode: SoundPadMode,
    variant: SoundPadVariant,
    size: SoundPadSize,
    playing: bool,
    loading: bool,
    disabled: bool,
    progress: Option<f32>,
    progress_variant: SoundPadProgressVariant,
    accent: Option<Color>,
    on_trigger: Option<TriggerHandler>,
    on_stop: Option<TriggerHandler>,
    accessibility_label: Option<SharedString>,
    children: SmallVec<[AnyElement; 2]>,
    appearance: Option<Appearance>,
}

impl SoundPad {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        SoundPad {
            id: id.into(),
            label: label.into(),
            hotkey: None,
            mode: SoundPadMode::OneShot,
            variant: SoundPadVariant::Default,
            size: SoundPadSize::Default,
            playing: false,
            loading: false,
            disabled: false,
            progress: None,
            progress_variant: SoundPadProgressVariant::Ring,
            accent: None,
            on_trigger: None,
            on_stop: None,
            accessibility_label: None,
            children: SmallVec::new(),
            appearance: None,
        }
    }

    pub fn mode(mut self, mode: SoundPadMode) -> Self {
        self.mode = mode;
        self
    }

    pub fn variant(mut self, variant: SoundPadVariant) -> Self {
        self.variant = variant;
        self
    }

    pub fn size(mut self, size: SoundPadSize) -> Self {
        self.size = size;
        self
    }

    pub fn hotkey(mut self, hotkey: impl Into<SharedString>) -> Self {
        self.hotkey = Some(hotkey.into());
        self
    }

    pub fn playing(mut self, playing: bool) -> Self {
        self.playing = playing;
        self
    }

    pub fn loading(mut self, loading: bool) -> Self {
        self.loading = loading;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// 0..=1 progress while playing; omit for loops / idle.
    pub fn progress(mut self, progress: f32) -> Self {
        self.progress = Some(progress.clamp(0.0, 1.0));
        self
    }

    pub fn progress_variant(mut self, variant: SoundPadProgressVariant) -> Self {
        self.progress_variant = variant;
        self
    }

    /// Accent for the fill mix and progress; theme primary when unset.
    pub fn accent(mut self, accent: Color) -> Self {
        self.accent = Some(accent);
        self
    }

    pub fn on_trigger(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_trigger = Some(Rc::new(handler));
        self
    }

    pub fn on_stop(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_stop = Some(Rc::new(handler));
        self
    }

    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.accessibility_label = Some(label.into());
        self
    }

    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl ParentElement for SoundPad {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

fn press_stops(mode: SoundPadMode, playing: bool) -> bool {
    playing && matches!(mode, SoundPadMode::Toggle | SoundPadMode::Loop)
}

impl RenderOnce for SoundPad {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let accent = self.accent.unwrap_or(t.primary);
        let ground = t.glass_solid;
        let inactive = self.disabled || self.loading;
        let fade = |color: Color| {
            if inactive {
                faded_over(color, ground, 0.5)
            } else {
                color
            }
        };
        let min_h = match self.size {
            SoundPadSize::Sm => 64.0,
            SoundPadSize::Default => 96.0,
            SoundPadSize::Lg => 128.0,
        };
        let pad_pad = match self.size {
            SoundPadSize::Sm => 8.0,
            SoundPadSize::Default => 12.0,
            SoundPadSize::Lg => 16.0,
        };

        let face = match self.variant {
            // Electron: color-mix accent into muted.
            SoundPadVariant::Default => chrome::mix(accent, t.muted, 0.14),
            SoundPadVariant::Ghost => with_alpha(t.muted, 0.0),
            SoundPadVariant::Outline => with_alpha(t.background, 0.0),
        };
        let face = fade(face);

        let mode = self.mode;
        let playing = self.playing;
        let on_trigger = self.on_trigger.clone();
        let on_stop = self.on_stop.clone();
        let appearance = self.appearance;

        let name = self
            .accessibility_label
            .clone()
            .unwrap_or_else(|| self.label.clone());

        let show_progress = self.progress.is_some() && playing;
        let progress = self.progress.unwrap_or(0.0);

        let mut pad = div()
            .id(self.id)
            .role(gpui::Role::Button)
            .aria_label(name)
            .when(
                matches!(mode, SoundPadMode::Toggle | SoundPadMode::Loop),
                |pad| {
                    pad.aria_toggled(if playing {
                        Toggled::True
                    } else {
                        Toggled::False
                    })
                },
            )
            .relative()
            .flex()
            .flex_col()
            .items_start()
            .justify_between()
            .gap(px(8.0))
            .w_full()
            .min_h(px(min_h))
            .p(px(pad_pad))
            .overflow_hidden()
            // Electron's twin uses rounded-xl (14); the guard's pad tier is panel (12).
            .rounded(px(radius::PANEL))
            .bg(hsla(face))
            .text_color(hsla(fade(t.foreground)))
            .when(self.variant == SoundPadVariant::Outline, |pad| {
                pad.border_1().border_color(hsla(fade(t.border)))
            })
            .when(playing, |pad| {
                pad.border_2().border_color(hsla(fade(accent)))
            })
            .when(inactive, |pad| pad.opacity(0.5))
            .when(!inactive, |pad| {
                let on_trigger_c = on_trigger.clone();
                let on_stop_c = on_stop.clone();
                pad.cursor_pointer()
                    .on_click(move |_: &ClickEvent, window, cx| {
                        if mode == SoundPadMode::Hold {
                            return;
                        }
                        if press_stops(mode, playing) {
                            if let Some(on_stop) = &on_stop_c {
                                on_stop(window, cx);
                            }
                        } else if let Some(on_trigger) = &on_trigger_c {
                            on_trigger(window, cx);
                        }
                    })
                    .on_mouse_down(MouseButton::Left, {
                        let on_trigger = on_trigger.clone();
                        move |_: &MouseDownEvent, window, cx| {
                            if mode == SoundPadMode::Hold
                                && let Some(on_trigger) = &on_trigger
                            {
                                on_trigger(window, cx);
                            }
                        }
                    })
                    .on_mouse_up(MouseButton::Left, {
                        let on_stop = on_stop.clone();
                        move |_: &MouseUpEvent, window, cx| {
                            if mode == SoundPadMode::Hold
                                && let Some(on_stop) = &on_stop
                            {
                                on_stop(window, cx);
                            }
                        }
                    })
            })
            .when_some(self.hotkey.clone(), |pad, key| {
                let mut chip = Kbd::new(key);
                if let Some(appearance) = appearance {
                    chip = chip.appearance(appearance);
                }
                pad.child(div().absolute().top(px(8.0)).right(px(8.0)).child(chip))
            })
            .child(
                div()
                    .relative()
                    .mt_auto()
                    .w_full()
                    .text_size(px(14.0))
                    .line_height(px(20.0))
                    .font_weight(FontWeight::MEDIUM)
                    .overflow_hidden()
                    .child(self.label),
            )
            .children(self.children);

        if show_progress {
            pad = pad.child(progress_layer(
                self.progress_variant,
                progress,
                fade(accent),
            ));
        }
        pad
    }
}

fn progress_layer(variant: SoundPadProgressVariant, progress: f32, accent: Color) -> AnyElement {
    let progress = progress.clamp(0.0, 1.0);
    match variant {
        SoundPadProgressVariant::Bar => div()
            .absolute()
            .left_0()
            .right_0()
            .bottom_0()
            .h(px(4.0))
            .child(div().h_full().w(relative(progress)).bg(hsla(accent)))
            .into_any_element(),
        SoundPadProgressVariant::Fill => div()
            .absolute()
            .inset_0()
            .bg(hsla(with_alpha(accent, 0.2 * progress)))
            .into_any_element(),
        SoundPadProgressVariant::Ring => div()
            .absolute()
            .right(px(8.0))
            .bottom(px(8.0))
            .size(px(20.0))
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, _, window, _| {
                        paint_progress_ring(window, bounds, progress, accent);
                    },
                )
                .size_full(),
            )
            .into_any_element(),
    }
}

fn paint_progress_ring(
    window: &mut Window,
    bounds: gpui::Bounds<gpui::Pixels>,
    progress: f32,
    accent: Color,
) {
    let size = bounds.size.width.min(bounds.size.height);
    if size <= px(0.0) {
        return;
    }
    let d = size.as_f32().round().max(1.0) as u32;
    let r = d as f32 / 2.0 - 1.5;
    let circ = std::f32::consts::TAU * r;
    let track = format!(
        "rgba({},{},{},0.2)",
        (accent >> 24) & 0xff,
        (accent >> 16) & 0xff,
        (accent >> 8) & 0xff
    );
    let half = d as f32 / 2.0;
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{d}" height="{d}" viewBox="0 0 {d} {d}">
  <circle cx="{half}" cy="{half}" r="{r}" fill="none" stroke="{track}" stroke-width="3"/>
  <circle cx="{half}" cy="{half}" r="{r}" fill="none" stroke="{accent}" stroke-width="3"
    stroke-linecap="round" stroke-dasharray="{circ}" stroke-dashoffset="{offset}"
    transform="rotate(-90 {half} {half})"/>
</svg>"##,
        offset = circ * (1.0 - progress),
    );
    if let Some(image) = chrome::rasterise_for_kit(&svg, d, d) {
        let _ = window.paint_image(bounds, bounds, gpui::Corners::default(), image, 0, false);
    }
}

#[cfg(test)]
mod tests {
    use super::sound_pad_columns;

    #[test]
    fn a_wide_grid_keeps_its_most_columns() {
        // The Studio's soundboard at the default window: six equal pads a row.
        assert_eq!(sound_pad_columns(718.0, 6), 6);
        assert_eq!(sound_pad_columns(2000.0, 6), 6);
    }

    #[test]
    fn exactly_six_minimum_pads_fit_six() {
        // 6 × 88 + 5 × 8: the formula's own edge, not one short of it.
        assert_eq!(sound_pad_columns(568.0, 6), 6);
        assert_eq!(sound_pad_columns(567.0, 6), 5);
    }

    #[test]
    fn a_narrow_grid_drops_columns_to_keep_pads_wide() {
        assert_eq!(sound_pad_columns(300.0, 6), 3);
        assert_eq!(sound_pad_columns(90.0, 6), 1);
        assert_eq!(sound_pad_columns(40.0, 6), 1);
    }

    #[test]
    fn an_unmeasured_grid_assumes_its_most_columns() {
        assert_eq!(sound_pad_columns(0.0, 6), 6);
        assert_eq!(sound_pad_columns(0.0, 0), 1);
    }
}
