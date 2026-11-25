//! BarVisualizer (Electron `components/ui/bar-visualizer.tsx`): a row of
//! rounded bars whose heights are normalized levels from a central analyser.
//! Colour comes from the caller's ink (foreground / muted / warning); the
//! container is unstyled so it sits on the glass panel. No CSS height
//! transition — band updates are faster than any transition would finish.

use gpui::{
    App, Div, ElementId, IntoElement, SharedString, StyleRefinement, Window, div, prelude::*, px,
};
use smallvec::SmallVec;

use crate::{
    theme::{Appearance, hsla, resolve},
    tokens::Color,
};

/// Voice / meter state that drives highlight opacity (ElevenLabs agent states).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BarVisualizerState {
    Connecting,
    Initializing,
    Listening,
    #[default]
    Speaking,
    Thinking,
}

#[derive(IntoElement)]
pub struct BarVisualizer {
    id: ElementId,
    base: Div,
    levels: SmallVec<[f32; 32]>,
    bar_count: usize,
    min_height: f32,
    max_height: f32,
    center_align: bool,
    state: Option<BarVisualizerState>,
    color: Option<Color>,
    accessibility_label: SharedString,
    appearance: Option<Appearance>,
}

impl BarVisualizer {
    pub fn new(id: impl Into<ElementId>) -> Self {
        BarVisualizer {
            id: id.into(),
            base: div(),
            levels: SmallVec::new(),
            bar_count: 15,
            min_height: 20.0,
            max_height: 100.0,
            center_align: false,
            state: None,
            color: None,
            accessibility_label: "Audio level".into(),
            appearance: None,
        }
    }

    pub fn bar_count(mut self, count: usize) -> Self {
        self.bar_count = count.max(1);
        self
    }

    /// Normalized levels `0..=1`. Missing bars paint at the floor.
    pub fn levels(mut self, levels: impl IntoIterator<Item = f32>) -> Self {
        self.levels = levels.into_iter().collect();
        self
    }

    /// Min / max bar height as a percent of the container (defaults 20 / 100).
    pub fn height_range(mut self, min: f32, max: f32) -> Self {
        self.min_height = min;
        self.max_height = max;
        self
    }

    pub fn center_align(mut self, center: bool) -> Self {
        self.center_align = center;
        self
    }

    pub fn state(mut self, state: BarVisualizerState) -> Self {
        self.state = Some(state);
        self
    }

    /// Ink for the bars; the theme foreground when unset.
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

impl Styled for BarVisualizer {
    fn style(&mut self) -> &mut StyleRefinement {
        self.base.style()
    }
}

fn height_pct(level: f32, min: f32, max: f32) -> f32 {
    (level * 100.0 + 5.0).clamp(min, max)
}

impl RenderOnce for BarVisualizer {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let ink = self.color.unwrap_or(t.foreground);
        let count = self.bar_count;
        let speaking = matches!(self.state, None | Some(BarVisualizerState::Speaking));
        let container_h = 64.0;
        let bars = (0..count).map(|index| {
            let level = self.levels.get(index).copied().unwrap_or(0.0);
            let pct = height_pct(level, self.min_height, self.max_height);
            // Speaking / idle lights every bar; other states keep a soft floor.
            let opacity = if speaking { 0.9 } else { 0.3 };
            div()
                .id(("bar", index))
                .flex_1()
                .min_w(px(4.0))
                .max_w(px(8.0))
                .h(px(container_h * pct / 100.0))
                .rounded_full()
                .bg(hsla(ink))
                .opacity(opacity)
        });

        self.base
            .id(self.id)
            .role(gpui::Role::Image)
            .aria_label(self.accessibility_label)
            .relative()
            .flex()
            .h(px(container_h))
            .w_full()
            .justify_center()
            .gap(px(4.0))
            .overflow_hidden()
            .when(self.center_align, |row| row.items_center())
            .when(!self.center_align, |row| row.items_end())
            .children(bars)
    }
}
