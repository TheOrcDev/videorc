//! LiveWaveform (Electron `components/ui/live-waveform.tsx`): imperative
//! waveform painter as a GPUI twin. The screen owns analyser frames and
//! passes normalized levels each paint; this draws centred bars in the
//! caller's ink. Idle shows a dotted midline; `processing` shows a soft
//! preparation shape before the first frame.

use gpui::{
    App, Div, ElementId, IntoElement, SharedString, StyleRefinement, Window, div, prelude::*, px,
};
use smallvec::SmallVec;

use crate::{
    theme::{Appearance, hsla, resolve, with_alpha},
    tokens::Color,
};

#[derive(IntoElement)]
pub struct LiveWaveform {
    id: ElementId,
    base: Div,
    levels: SmallVec<[f32; 64]>,
    active: bool,
    processing: bool,
    bar_width: f32,
    bar_gap: f32,
    bar_radius: f32,
    base_bar_height: f32,
    height: f32,
    color: Option<Color>,
    accessibility_label: SharedString,
    appearance: Option<Appearance>,
}

impl LiveWaveform {
    pub fn new(id: impl Into<ElementId>) -> Self {
        LiveWaveform {
            id: id.into(),
            base: div(),
            levels: SmallVec::new(),
            active: false,
            processing: false,
            bar_width: 3.0,
            bar_gap: 1.0,
            bar_radius: 1.5,
            base_bar_height: 4.0,
            height: 64.0,
            color: None,
            accessibility_label: "Audio waveform idle".into(),
            appearance: None,
        }
    }

    /// Normalized levels `0..=1` for a static paint.
    pub fn levels(mut self, levels: impl IntoIterator<Item = f32>) -> Self {
        self.levels = levels.into_iter().collect();
        self
    }

    pub fn active(mut self, active: bool) -> Self {
        self.active = active;
        if active {
            self.accessibility_label = "Live audio waveform".into();
        }
        self
    }

    pub fn processing(mut self, processing: bool) -> Self {
        self.processing = processing;
        if processing && !self.active {
            self.accessibility_label = "Preparing audio preview".into();
        }
        self
    }

    pub fn bar_width(mut self, width: f32) -> Self {
        self.bar_width = width;
        self
    }

    pub fn bar_gap(mut self, gap: f32) -> Self {
        self.bar_gap = gap;
        self
    }

    pub fn height(mut self, height: f32) -> Self {
        self.height = height;
        self
    }

    pub fn color(mut self, color: Color) -> Self {
        self.color = Some(color);
        self
    }

    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.accessibility_label = label.into();
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl Styled for LiveWaveform {
    fn style(&mut self) -> &mut StyleRefinement {
        self.base.style()
    }
}

fn preparation_levels(bar_count: usize) -> Vec<f32> {
    if bar_count == 0 {
        return Vec::new();
    }
    let center = ((bar_count - 1) as f32) / 2.0;
    (0..bar_count)
        .map(|index| {
            let distance = (index as f32 - center).abs() / center.max(1.0);
            0.12 + (1.0 - distance) * 0.18
        })
        .collect()
}

impl RenderOnce for LiveWaveform {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let ink = self.color.unwrap_or(t.foreground);
        let height = self.height;
        let step = self.bar_width + self.bar_gap;
        // Gallery / fixed paints: enough bars for a ~200 px wide strip.
        let bar_count = ((200.0 / step).floor() as usize).max(1);

        let values: Vec<f32> = if self.active {
            if self.levels.is_empty() {
                vec![0.0; bar_count]
            } else {
                resample(&self.levels, bar_count)
            }
        } else if self.processing {
            preparation_levels(bar_count)
        } else {
            Vec::new()
        };

        let idle = !self.active && !self.processing;
        let bars = values.into_iter().enumerate().map(|(index, value)| {
            let normalized = value.clamp(0.0, 1.0);
            let drawn = (self.base_bar_height).max(normalized * height * 0.8);
            let opacity = 0.4 + normalized * 0.6;
            div()
                .id(("wave-bar", index))
                .w(px(self.bar_width))
                .h(px(drawn))
                .rounded(px(self.bar_radius))
                .bg(hsla(ink))
                .opacity(opacity)
        });

        self.base
            .id(self.id)
            .role(gpui::Role::Image)
            .aria_label(self.accessibility_label)
            .relative()
            .flex()
            .w_full()
            .h(px(height))
            .items_center()
            .justify_center()
            .gap(px(self.bar_gap))
            .overflow_hidden()
            .when(idle, |row| {
                row.child(
                    div()
                        .absolute()
                        .left_0()
                        .top(px(height / 2.0 - 1.0))
                        .w_full()
                        .h(px(2.0))
                        .bg(hsla(with_alpha(t.muted_foreground, 0.2))),
                )
            })
            .children(bars)
    }
}

fn resample(levels: &[f32], count: usize) -> Vec<f32> {
    if levels.is_empty() || count == 0 {
        return vec![0.0; count];
    }
    if levels.len() == count {
        return levels.to_vec();
    }
    (0..count)
        .map(|index| {
            let pos = index as f32 * (levels.len() - 1) as f32 / (count - 1).max(1) as f32;
            let lo = pos.floor() as usize;
            let hi = (lo + 1).min(levels.len() - 1);
            let t = pos - lo as f32;
            levels[lo] * (1.0 - t) + levels[hi] * t
        })
        .collect()
}
