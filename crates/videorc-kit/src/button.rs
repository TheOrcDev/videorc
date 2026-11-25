//! Button (`components/ui/button.tsx`): gpui-base's Button for the
//! behaviour (pointer, Enter and Space, focus, the AccessKit role and
//! disabled state), Liquid Chrome for the look.
//!
//! - `Default`: polished chrome, the primary. `Record` and its stop button:
//!   metallic red, lit while a recording or livestream runs. `GoLive` and
//!   End livestream: polished copper. Each has no border, so its light and
//!   shade reach the edge; hover lifts it, pressed turns it concave.
//! - `Chromatic`: a face of the solid in a 2 px ring of liquid chrome that
//!   flows around it. It always moves: one per screen.
//! - `Solid`, `Secondary` (the chip glass), `Outline`, `Ghost`,
//!   `Destructive` and `Link`: flat.
//!
//! A disabled button is pre-blended over the ground it sits on (the
//! window's solid unless `ground` says otherwise): GPUI fades each layer on
//! its own, where Chromium fades the button as one group.

use std::{rc::Rc, time::Duration};

use gpui::{
    AnyElement, App, ClickEvent, ColorSpace, ElementId, FontWeight, IntoElement, ParentElement,
    SharedString, Window, canvas, div, linear_color_stop, linear_gradient, prelude::*, px,
};
use smallvec::SmallVec;

use crate::{
    chrome::{
        self, Direction, MASK_BLACK, MASK_WHITE, box_shadow, conic_mask, paint_corners,
        ring_sprite, sample,
    },
    theme::{Appearance, faded_over, hsla, is_dark, motion, resolve, with_alpha},
    tokens::{Color, Shadow, Stop, Theme, radius, size},
};

/// The group every button's layers answer to for hover and pressed.
const GROUP: &str = "videorc-kit-button";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ButtonVariant {
    /// Polished chrome: the primary.
    #[default]
    Default,
    /// The regular button: a flat fill in the primary ink.
    Solid,
    /// The chip glass, with the secondary tone under it on hover.
    Secondary,
    Outline,
    Ghost,
    Destructive,
    Link,
    /// Record and its stop button only: metallic red.
    Record,
    /// Go Live and End livestream only: polished copper.
    GoLive,
    /// A ring of liquid chrome that flows: one per screen.
    Chromatic,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ButtonSize {
    /// The desktop control height, 28 px.
    #[default]
    Default,
    /// 24 px, for dense rows only.
    Xs,
    Lg,
    /// A square at the control height.
    Icon,
    /// A 24 px square.
    IconXs,
}

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Button {
    id: ElementId,
    label: Option<SharedString>,
    variant: ButtonVariant,
    size: ButtonSize,
    /// Horizontal padding of 6 px at the control height (Electron account
    /// trigger `px-1.5`). Not a size: the twin Size enum stays the React cva.
    dense: bool,
    disabled: bool,
    lit: bool,
    selected: bool,
    ground: Option<Color>,
    accessibility_label: Option<SharedString>,
    tooltip: Option<SharedString>,
    on_click: Option<ClickHandler>,
    children: SmallVec<[AnyElement; 2]>,
    appearance: Option<Appearance>,
}

impl Button {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Button {
            id: id.into(),
            label: None,
            variant: ButtonVariant::Default,
            size: ButtonSize::Default,
            dense: false,
            disabled: false,
            lit: false,
            selected: false,
            ground: None,
            accessibility_label: None,
            tooltip: None,
            on_click: None,
            children: SmallVec::new(),
            appearance: None,
        }
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn variant(mut self, variant: ButtonVariant) -> Self {
        self.variant = variant;
        self
    }

    pub fn size(mut self, size: ButtonSize) -> Self {
        self.size = size;
        self
    }

    /// Pad 6 px horizontally while keeping the size's height (Electron's
    /// account-menu trigger: `h-7` + `px-1.5`). Default pad is 12 px.
    pub fn dense(mut self, dense: bool) -> Self {
        self.dense = dense;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Record only: lit while a recording or livestream runs.
    pub fn lit(mut self, lit: bool) -> Self {
        self.lit = lit;
        self
    }

    /// The colour the button sits on, for the disabled pre-blend and the
    /// chromatic ring's corners; the window's solid by default.
    pub fn ground(mut self, ground: Color) -> Self {
        self.ground = Some(ground);
        self
    }

    /// The name a screen reader reads, for an icon-only button.
    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.accessibility_label = Some(label.into());
        self
    }

    /// A tooltip in the float glass's tooltip tier.
    pub fn tooltip(mut self, text: impl Into<SharedString>) -> Self {
        self.tooltip = Some(text.into());
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

/// A button opens a popover or a menu: it shows as expanded while open
/// (`aria-expanded`), as the React variants do.
impl gpui_base::Selectable for Button {
    fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    fn is_selected(&self) -> bool {
        self.selected
    }
}

impl ParentElement for Button {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// One metal: its stops, its flat colour, its ink, its hover lift and its
/// light and shade.
struct Metal {
    stops: &'static [Stop],
    flat: Color,
    ink: Color,
    lift: Color,
    shadow: &'static [Shadow],
}

fn metal_of(t: &Theme, variant: ButtonVariant, lit: bool) -> Option<Metal> {
    match variant {
        ButtonVariant::Default => Some(Metal {
            stops: t.chrome_fill_stops,
            flat: t.chrome_fill_flat,
            ink: t.chrome_fill_ink,
            lift: t.chrome_fill_lift,
            shadow: t.chrome_fill_shadow,
        }),
        ButtonVariant::Record => Some(Metal {
            stops: if lit {
                t.chrome_led_stops
            } else {
                t.chrome_led_off_stops
            },
            flat: if lit {
                t.chrome_led_flat
            } else {
                t.chrome_led_off_flat
            },
            ink: t.live_foreground,
            lift: t.chrome_led_lift,
            shadow: t.chrome_led_shadow,
        }),
        ButtonVariant::GoLive => Some(Metal {
            stops: t.chrome_copper_stops,
            flat: t.chrome_copper_flat,
            ink: t.chrome_copper_ink,
            lift: t.chrome_copper_lift,
            shadow: t.chrome_copper_shadow,
        }),
        _ => None,
    }
}

/// The 1 px edge a disabled metal keeps: `0 0 0 1px var(--chrome-edge)`.
fn edge(color: Color) -> gpui::BoxShadow {
    box_shadow(&Shadow {
        inset: false,
        x: 0.0,
        y: 0.0,
        blur: 0.0,
        spread: 1.0,
        color,
    })
}

impl RenderOnce for Button {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let ground = self.ground.unwrap_or(t.glass_solid);
        let moving = motion(cx);
        let disabled = self.disabled;
        let fade = |color: Color| {
            if disabled {
                faded_over(color, ground, 0.5)
            } else {
                color
            }
        };
        let (height, mut pad, gap, text_size, line_height) = match self.size {
            ButtonSize::Default => (size::CONTROL, 12.0, 6.0, 14.0, 20.0),
            ButtonSize::Xs => (24.0, 10.0, 4.0, 12.0, 16.0),
            ButtonSize::Lg => (32.0, 16.0, 6.0, 14.0, 20.0),
            ButtonSize::Icon => (size::CONTROL, 0.0, 0.0, 14.0, 20.0),
            ButtonSize::IconXs => (24.0, 0.0, 0.0, 12.0, 16.0),
        };
        // Dense keeps height; only the horizontal pad shrinks (not icon squares).
        if self.dense && !matches!(self.size, ButtonSize::Icon | ButtonSize::IconXs) {
            pad = 6.0;
        }
        let square = matches!(self.size, ButtonSize::Icon | ButtonSize::IconXs);
        let r = radius::CHIP;

        let expanded = self.selected;
        let mut button = gpui_base::Button::new(self.id)
            .group(GROUP)
            .disabled(disabled)
            .selected(expanded)
            .relative()
            .flex_none()
            .h(px(height))
            .gap(px(gap))
            .rounded(px(r))
            .border_1()
            .border_color(gpui::transparent_black())
            .whitespace_nowrap()
            .text_size(px(text_size))
            .line_height(px(line_height))
            .font_weight(FontWeight::MEDIUM);
        button = if square {
            button.w(px(height))
        } else {
            button.px(px(pad))
        };
        if let Some(label) = self.accessibility_label {
            button = button.accessibility_label(label);
        }
        if let Some(text) = self.tooltip {
            button = button.tooltip(crate::tooltip::tooltip(text));
        }
        if let Some(on_click) = self.on_click {
            button = button.on_click(move |event, window, cx| on_click(event, window, cx));
        }

        // The words and icons, over every layer.
        let content = div()
            .relative()
            .flex()
            .items_center()
            .gap(px(gap))
            .children(self.label)
            .children(self.children);

        match self.variant {
            ButtonVariant::Default | ButtonVariant::Record | ButtonVariant::GoLive => {
                let Some(metal) = metal_of(t, self.variant, self.lit) else {
                    unreachable!("a metal variant")
                };
                if disabled {
                    // Flat: no image, the edge only, pre-blended.
                    button
                        .bg(hsla(fade(metal.flat)))
                        .shadow(vec![edge(with_alpha(t.chrome_edge, 0.5))])
                        .text_color(hsla(fade(metal.ink)))
                        .child(content)
                } else {
                    let lit_glow = self.variant == ButtonVariant::Record && self.lit;
                    button
                        .bg(hsla(metal.flat))
                        .shadow(chrome::shadows(metal.shadow))
                        .active(|style| style.shadow(chrome::shadows(t.chrome_pressed_shadow)))
                        .text_color(hsla(metal.ink))
                        // A lit Record's tally glow: 0 0 12px 1px at 85%.
                        // Steady: GPUI has no compositor-side opacity loop,
                        // and redrawing the window per frame for a breath
                        // costs what S0.4 measured (24 % of a core).
                        .when(lit_glow, |button| {
                            button.child(
                                div()
                                    .absolute()
                                    .top_0()
                                    .left_0()
                                    .size_full()
                                    .rounded(px(r))
                                    .shadow(vec![box_shadow(&Shadow {
                                        inset: false,
                                        x: 0.0,
                                        y: 0.0,
                                        blur: 12.0,
                                        spread: 1.0,
                                        color: with_alpha(t.chrome_led_glow, 0.85),
                                    })]),
                            )
                        })
                        .child(chrome::metal(metal.stops, [r; 4], Direction::Down))
                        // Pressed: the metal turns concave.
                        .child(
                            div()
                                .id("pressed")
                                .absolute()
                                .top_0()
                                .left_0()
                                .size_full()
                                .invisible()
                                .group_active(GROUP, |style| style.visible())
                                .child(chrome::metal(metal.stops, [r; 4], Direction::Up)),
                        )
                        // Hover: the lift over the metal.
                        .child(
                            chrome::layer(metal.lift, r)
                                .invisible()
                                .group_hover(GROUP, |style| style.visible()),
                        )
                        .child(content)
                }
            }
            ButtonVariant::Solid => button
                .bg(hsla(fade(if expanded {
                    with_alpha(t.primary, 0.85)
                } else {
                    t.primary
                })))
                .text_color(hsla(fade(t.primary_foreground)))
                .hover(|style| style.bg(hsla(with_alpha(t.primary, 0.85))))
                .active(|style| style.bg(hsla(with_alpha(t.primary, 0.75))))
                .child(content),
            ButtonVariant::Secondary => {
                if disabled {
                    button
                        .border_color(hsla(fade(t.chip_rim)))
                        .bg(hsla(fade(t.chip_fill_bottom)))
                        .text_color(hsla(fade(t.secondary_foreground)))
                        .child(content)
                } else {
                    // The chip glass (`glass-chip`).
                    button
                        .border_color(hsla(t.chip_rim))
                        .bg(linear_gradient(
                            180.0,
                            linear_color_stop(hsla(t.chip_fill_top), 0.0),
                            linear_color_stop(hsla(t.chip_fill_bottom), 1.0),
                        )
                        .color_space(ColorSpace::Oklab))
                        .shadow(crate::badge::chip_shadows(t))
                        .text_color(hsla(t.secondary_foreground))
                        .hover(|style| style.bg(hsla(t.secondary)))
                        .child(content)
                }
            }
            ButtonVariant::Outline => button
                .when(expanded, |button| button.bg(hsla(t.muted)))
                .border_color(hsla(fade(t.border)))
                .text_color(hsla(fade(t.foreground)))
                .hover(|style| style.bg(hsla(t.muted)))
                .child(content),
            ButtonVariant::Ghost => {
                let hover = if is_dark(t) {
                    with_alpha(t.muted, 0.5)
                } else {
                    t.muted
                };
                button
                    .when(expanded, |button| button.bg(hsla(hover)))
                    .text_color(hsla(fade(t.foreground)))
                    .hover(|style| style.bg(hsla(hover)))
                    .child(content)
            }
            ButtonVariant::Destructive => {
                let (rest, hover) = if is_dark(t) { (0.2, 0.3) } else { (0.1, 0.2) };
                button
                    .bg(hsla(fade(with_alpha(t.destructive, rest))))
                    .text_color(hsla(fade(t.destructive)))
                    .hover(|style| style.bg(hsla(with_alpha(t.destructive, hover))))
                    .child(content)
            }
            ButtonVariant::Link => button
                .text_color(hsla(fade(t.primary)))
                .hover(|style| style.underline())
                .child(content),
            ButtonVariant::Chromatic => {
                chromatic(button, t, ground, moving, disabled, r).child(content)
            }
        }
    }
}

/// The ring's bands turn once per 9 s clockwise; the glints 1.5 turns per
/// 9 s the other way, as `--chrome-chromatic-flow` turns them.
const BANDS_TURN: Duration = Duration::from_secs(9);
const GLINTS_TURN: Duration = Duration::from_secs(6);

/// `chrome-chromatic`: the ring (bands and glints, each a turning sprite),
/// its sheen, the face inside 2 px, the face's recess, and the rim.
fn chromatic(
    button: gpui_base::Button,
    t: &'static Theme,
    ground: Color,
    moving: bool,
    disabled: bool,
    r: f32,
) -> gpui_base::Button {
    if disabled {
        return button
            .bg(hsla(faded_over(
                t.chrome_chromatic_face_stops[0].color,
                ground,
                0.5,
            )))
            .shadow(vec![edge(with_alpha(t.chrome_edge, 0.5))])
            .text_color(hsla(faded_over(t.foreground, ground, 0.5)));
    }
    let key = if is_dark(t) { "dark" } else { "light" };
    let period = |stops: &[Stop]| stops.last().map_or(1.0, |stop| stop.at.max(0.01));
    let bands = t.chrome_chromatic_bands;
    let glints = t.chrome_chromatic_glints;
    let band_mask = conic_mask(&format!("bands-{key}"), move |turn| {
        sample(bands, turn.rem_euclid(period(bands)))[0]
    });
    let white_mask = conic_mask(&format!("glints-white-{key}"), move |turn| {
        let [r, _, _, a] = sample(glints, turn.rem_euclid(period(glints)));
        a * r
    });
    let black_mask = conic_mask(&format!("glints-black-{key}"), move |turn| {
        let [r, _, _, a] = sample(glints, turn.rem_euclid(period(glints)));
        a * (1.0 - r)
    });
    let sheen = t.chrome_chromatic_sheen;
    let (rim, edge_color) = (t.chrome_chromatic_rim, t.chrome_edge);
    let shadows: Vec<_> = t
        .chrome_chromatic_shadow
        .iter()
        .filter(|shadow| !shadow.inset && shadow.blur > 0.0)
        .map(box_shadow)
        .collect();
    button
        .text_color(hsla(t.foreground))
        .shadow(shadows)
        // The ring: the bands over black, then the glints.
        .child(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .overflow_hidden()
                .bg(hsla(MASK_BLACK))
                .child(ring_sprite(band_mask, MASK_WHITE, BANDS_TURN, true, moving))
                .child(ring_sprite(
                    white_mask,
                    MASK_WHITE,
                    GLINTS_TURN,
                    false,
                    moving,
                ))
                .child(ring_sprite(
                    black_mask,
                    MASK_BLACK,
                    GLINTS_TURN,
                    false,
                    moving,
                )),
        )
        .child(
            canvas(
                |_, _, _| (),
                move |bounds, _, window, _| {
                    paint_corners(window, bounds, r, ground);
                    chrome::paint_metal(window, bounds, sheen, [r; 4], Direction::Down);
                },
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full(),
        )
        // The face, inside the 2 px ring, with the recess under its top.
        .child(
            div()
                .absolute()
                .top(px(2.0))
                .left(px(2.0))
                .right(px(2.0))
                .bottom(px(2.0))
                .child(chrome::metal(
                    t.chrome_chromatic_face_stops,
                    [r - 2.0; 4],
                    Direction::Down,
                ))
                .child(
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .rounded(px(r - 2.0))
                        .shadow(vec![box_shadow(&Shadow {
                            inset: true,
                            x: 0.0,
                            y: 1.0,
                            blur: 3.0,
                            spread: 0.0,
                            color: t.chrome_chromatic_recess,
                        })]),
                ),
        )
        // The rim and the Increase Contrast edge: 1 px rings outside.
        .child(
            canvas(
                |_, _, _| (),
                move |bounds, _, window, _| {
                    chrome::paint_ring(window, bounds, r, rim);
                    chrome::paint_ring(window, bounds, r, edge_color);
                },
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full(),
        )
}
