//! ChannelToggle (`components/ui/channel-toggle.tsx`, audiocn's mixer
//! toggle): gpui-base's Toggle for the behaviour (pointer, Space and Enter,
//! focus, the pressed state for assistive tech), Electron's look: 28 px,
//! `bg-muted` ink at rest, and pressed in its channel's tone (a 15% wash and
//! the tone's ink; Solo 20%). [`mute_toggle`], [`solo_toggle`] and
//! [`monitor_toggle`] are React's MuteToggle, SoloToggle and MonitorToggle.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, FontWeight, IntoElement, SharedString, Window, div,
    prelude::*, px,
};
use smallvec::SmallVec;

use crate::{
    chrome::focus_ring,
    icon::{IconName, icon},
    theme::{Appearance, hsla, resolve, with_alpha},
    tokens::{Color, Theme, radius},
    tooltip::tooltip,
};

type ChangeHandler = Rc<dyn Fn(bool, &ClickEvent, &mut Window, &mut App)>;

/// React's cva `variant`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ChannelToggleVariant {
    /// `bg-muted text-muted-foreground`.
    #[default]
    Default,
    /// No fill until hovered.
    Ghost,
    /// A hairline rim, no fill.
    Outline,
}

/// React's cva `size`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ChannelToggleSize {
    /// 28 px tall, at least square, 6 px sides.
    #[default]
    Default,
    /// 28 px square.
    Icon,
    /// 32 px.
    Lg,
    /// 24 px.
    Sm,
}

/// React's cva `tone`: the colour it wears pressed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ChannelToggleTone {
    Monitor,
    Mute,
    /// Pressed is the inverted chip (`bg-foreground text-background`).
    #[default]
    Neutral,
    Solo,
}

impl ChannelToggleTone {
    /// (rim, wash, ink) while pressed.
    fn pressed(self, t: &Theme) -> (Color, Color, Color) {
        match self {
            ChannelToggleTone::Mute => (
                with_alpha(t.channel_mute, 0.4),
                with_alpha(t.channel_mute, 0.15),
                t.channel_mute_foreground,
            ),
            ChannelToggleTone::Solo => (
                with_alpha(t.channel_solo, 0.5),
                with_alpha(t.channel_solo, 0.2),
                t.channel_solo_foreground,
            ),
            ChannelToggleTone::Monitor => (
                with_alpha(t.channel_monitor, 0.4),
                with_alpha(t.channel_monitor, 0.15),
                t.channel_monitor_foreground,
            ),
            ChannelToggleTone::Neutral => (t.foreground, t.foreground, t.background),
        }
    }
}

#[derive(IntoElement)]
pub struct ChannelToggle {
    id: ElementId,
    pressed: bool,
    disabled: bool,
    tone: ChannelToggleTone,
    variant: ChannelToggleVariant,
    size: ChannelToggleSize,
    icon: Option<(IconName, IconName)>,
    label: Option<SharedString>,
    accessibility_label: Option<SharedString>,
    tooltip: Option<SharedString>,
    on_change: Option<ChangeHandler>,
    children: SmallVec<[AnyElement; 2]>,
    appearance: Option<Appearance>,
}

impl ChannelToggle {
    pub fn new(id: impl Into<ElementId>) -> Self {
        ChannelToggle {
            id: id.into(),
            pressed: false,
            disabled: false,
            tone: ChannelToggleTone::Neutral,
            variant: ChannelToggleVariant::Default,
            size: ChannelToggleSize::Default,
            icon: None,
            label: None,
            accessibility_label: None,
            tooltip: None,
            on_change: None,
            children: SmallVec::new(),
            appearance: None,
        }
    }

    pub fn pressed(mut self, pressed: bool) -> Self {
        self.pressed = pressed;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn tone(mut self, tone: ChannelToggleTone) -> Self {
        self.tone = tone;
        self
    }

    pub fn variant(mut self, variant: ChannelToggleVariant) -> Self {
        self.variant = variant;
        self
    }

    pub fn size(mut self, size: ChannelToggleSize) -> Self {
        self.size = size;
        self
    }

    /// One glyph, 16 px, in the toggle's ink.
    pub fn icon(mut self, name: IconName) -> Self {
        self.icon = Some((name, name));
        self
    }

    /// A glyph for each state: the speaker at rest, the struck speaker
    /// pressed (Studio's mute: SpeakerHighDuotone / SpeakerSlashDuotone).
    pub fn icons(mut self, off: IconName, on: IconName) -> Self {
        self.icon = Some((off, on));
        self
    }

    /// Words beside or instead of the glyph (`text-xs font-semibold`).
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.accessibility_label = Some(label.into());
        self
    }

    pub fn tooltip(mut self, text: impl Into<SharedString>) -> Self {
        self.tooltip = Some(text.into());
        self
    }

    /// Called with the next pressed state.
    pub fn on_change(
        mut self,
        handler: impl Fn(bool, &ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl ParentElement for ChannelToggle {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for ChannelToggle {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let (height, pad, square) = match self.size {
            ChannelToggleSize::Default => (28.0, 6.0, false),
            ChannelToggleSize::Icon => (28.0, 0.0, true),
            ChannelToggleSize::Lg => (32.0, 8.0, false),
            ChannelToggleSize::Sm => (24.0, 4.0, false),
        };
        let pressed = self.pressed;
        let disabled = self.disabled;
        let (rim, wash, pressed_ink) = self.tone.pressed(t);
        let outline = self.variant == ChannelToggleVariant::Outline;
        let ink = if pressed {
            pressed_ink
        } else {
            t.muted_foreground
        };
        let name = self
            .accessibility_label
            .clone()
            .or_else(|| self.label.clone());
        let glyph = self
            .icon
            .map(|(off, on)| icon(if pressed { on } else { off }, 16.0, hsla(ink)));
        let ring = focus_ring(t);

        let mut toggle = gpui_base::Toggle::new(self.id)
            .pressed(pressed)
            .disabled(disabled)
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .gap(px(4.0))
            .h(px(height))
            .when(square, |toggle| toggle.w(px(height)))
            .when(!square, |toggle| toggle.min_w(px(height)).px(px(pad)))
            .rounded(px(radius::CHIP))
            .text_size(px(12.0))
            .line_height(px(16.0))
            .font_weight(FontWeight::SEMIBOLD)
            .whitespace_nowrap()
            .text_color(hsla(ink))
            .when(outline, |toggle| {
                toggle
                    .border_1()
                    .border_color(hsla(if pressed { rim } else { t.border }))
            })
            .map(|toggle| {
                if pressed {
                    toggle.bg(hsla(wash))
                } else {
                    match self.variant {
                        ChannelToggleVariant::Default => toggle
                            .bg(hsla(t.muted))
                            .hover(|style| style.text_color(hsla(t.foreground))),
                        ChannelToggleVariant::Ghost | ChannelToggleVariant::Outline => toggle
                            .hover(|style| style.bg(hsla(t.muted)).text_color(hsla(t.foreground))),
                    }
                }
            })
            .when(disabled, |toggle| toggle.opacity(0.5))
            .focus_visible(move |style| style.shadow(vec![ring]))
            .children(glyph)
            .children(self.label.map(|label| div().child(label)))
            .children(self.children);
        if let Some(name) = name {
            toggle = toggle.accessibility_label(name);
        }
        if let Some(text) = self.tooltip {
            toggle = toggle.tooltip(tooltip(text));
        }
        if let Some(on_change) = self.on_change {
            toggle =
                toggle.on_change(move |next, event, window, cx| on_change(next, event, window, cx));
        }
        toggle
    }
}

/// `MuteToggle`: the mute tone, named "Mute" (Studio's microphone and system
/// audio rows, the Sources mixer).
pub fn mute_toggle(id: impl Into<ElementId>) -> ChannelToggle {
    ChannelToggle::new(id)
        .tone(ChannelToggleTone::Mute)
        .accessibility_label("Mute")
}

/// `SoloToggle`: the solo tone, named "Solo".
pub fn solo_toggle(id: impl Into<ElementId>) -> ChannelToggle {
    ChannelToggle::new(id)
        .tone(ChannelToggleTone::Solo)
        .accessibility_label("Solo")
}

/// `MonitorToggle`: the monitor tone, named "Monitor".
pub fn monitor_toggle(id: impl Into<ElementId>) -> ChannelToggle {
    ChannelToggle::new(id)
        .tone(ChannelToggleTone::Monitor)
        .accessibility_label("Monitor")
}
