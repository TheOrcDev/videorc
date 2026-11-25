//! MediaCard (`components/media-card.tsx`): a card for an object with a
//! picture (a scene thumbnail, a background, a takeover screen). Lists of
//! like things stay rows; only a picture earns a card. One recipe: the row
//! radius (8 px), a 4% fill, a 1 px hairline and no shadow. The one in use
//! wears the chrome plate with a brighter rim, never a colour. A card with
//! `on_click` is one button (Enter and Space, focus ring) and takes the hover
//! block, as React's `interactive` does.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ColorSpace, Div, ElementId, IntoElement, SharedString,
    StyleRefinement, Window, div, linear_color_stop, linear_gradient, prelude::*, px,
};
use smallvec::SmallVec;

use crate::{
    badge::plate_shadows,
    chrome::focus_ring,
    theme::{Appearance, hsla, resolve, with_alpha},
    tokens::radius,
};

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct MediaCard {
    id: ElementId,
    selected: bool,
    interactive: Option<bool>,
    disabled: bool,
    accessibility_label: Option<SharedString>,
    on_click: Option<ClickHandler>,
    children: SmallVec<[AnyElement; 2]>,
    /// The call site's own layout (a width, a gap, padding), as `className`.
    base: Div,
    appearance: Option<Appearance>,
}

impl MediaCard {
    pub fn new(id: impl Into<ElementId>) -> Self {
        MediaCard {
            id: id.into(),
            selected: false,
            interactive: None,
            disabled: false,
            accessibility_label: None,
            on_click: None,
            children: SmallVec::new(),
            base: div(),
            appearance: None,
        }
    }

    /// The one in use: the chrome plate and a brighter rim, never a colour.
    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    /// The hover block. On by default for a card with `on_click`.
    pub fn interactive(mut self, interactive: bool) -> Self {
        self.interactive = Some(interactive);
        self
    }

    /// A card that is a button, disabled (faded, no hover).
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// The card's name when it is a button and its picture says nothing.
    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.accessibility_label = Some(label.into());
        self
    }

    /// Makes the whole card one button.
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

impl ParentElement for MediaCard {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl Styled for MediaCard {
    /// The call site's own layout (a width, a gap, padding), as `className`.
    fn style(&mut self) -> &mut StyleRefinement {
        self.base.style()
    }
}

impl RenderOnce for MediaCard {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let selected = self.selected;
        let is_button = self.on_click.is_some();
        let interactive = self.interactive.unwrap_or(is_button) && !self.disabled;
        // `rounded-row border border-border bg-foreground/4 flex min-w-0
        // flex-col`; selected: `chrome-plate border-foreground/25`.
        let look = move |card: gpui::Stateful<Div>| {
            let card = card
                .flex()
                .flex_col()
                .min_w(px(0.0))
                .rounded(px(radius::ROW))
                .border_1();
            if selected {
                card.border_color(hsla(with_alpha(t.foreground, 0.25)))
                    .bg(linear_gradient(
                        180.0,
                        linear_color_stop(hsla(t.chrome_plate_top), 0.0),
                        linear_color_stop(hsla(t.chrome_plate_bottom), 1.0),
                    )
                    .color_space(ColorSpace::Oklab))
                    .shadow(plate_shadows(t))
            } else {
                card.border_color(hsla(t.border))
                    .bg(hsla(with_alpha(t.foreground, 0.04)))
                    .when(interactive, |card| {
                        card.hover(|style| style.bg(hsla(t.accent)))
                    })
            }
        };
        match self.on_click {
            Some(on_click) => {
                let ring = focus_ring(t);
                let inner_id = SharedString::from(format!("{}/card", self.id));
                let mut card = gpui_base::Button::new(self.id)
                    .disabled(self.disabled)
                    .selected(selected)
                    .w_full()
                    .h_full()
                    .flex()
                    .flex_col()
                    .justify_start()
                    .rounded(px(radius::ROW))
                    .when(self.disabled, |card| card.opacity(0.5))
                    .focus_visible(move |style| style.shadow(vec![ring]))
                    .on_click(move |event, window, cx| on_click(event, window, cx));
                if let Some(label) = self.accessibility_label {
                    card = card.accessibility_label(label);
                }
                let inner = look(self.base.id(inner_id))
                    .size_full()
                    .children(self.children);
                card.child(inner).into_any_element()
            }
            None => look(self.base.id(self.id))
                .children(self.children)
                .into_any_element(),
        }
    }
}
