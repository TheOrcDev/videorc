//! Avatar (`components/ui/avatar.tsx`): a round face with an optional image
//! and a letter fallback. Sizes match the React twin (`sm` 24, default 32,
//! `lg` 40) plus `xs` 20 for the sidebar account face (Electron `size-5`).

use gpui::{
    AnyElement, App, Div, ImageSource, IntoElement, SharedString, StyleRefinement, Window, div,
    img, prelude::*, px,
};

use crate::theme::{Appearance, FONT, hsla, resolve};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Face {
    /// 20 px — sidebar account trigger (Electron AvatarCircle `size-5`).
    Xs,
    Sm,
    #[default]
    Default,
    Lg,
}

impl Face {
    fn px(self) -> f32 {
        match self {
            Self::Xs => 20.0,
            Self::Sm => 24.0,
            Self::Default => 32.0,
            Self::Lg => 40.0,
        }
    }

    fn text(self) -> f32 {
        match self {
            // Floor is 11 px (design guards); the face is only 20 px wide.
            Self::Xs | Self::Sm => 11.0,
            Self::Default => 14.0,
            Self::Lg => 16.0,
        }
    }
}

#[derive(IntoElement)]
pub struct Avatar {
    base: Div,
    face: Face,
    image: Option<ImageSource>,
    fallback: SharedString,
    appearance: Option<Appearance>,
}

impl Avatar {
    /// `fallback` is the letter(s) shown when there is no image.
    pub fn new(fallback: impl Into<SharedString>) -> Self {
        Avatar {
            base: div(),
            face: Face::Default,
            image: None,
            fallback: fallback.into(),
            appearance: None,
        }
    }

    /// 20 px, sidebar account face (Electron `size-5`).
    pub fn xs(mut self) -> Self {
        self.face = Face::Xs;
        self
    }

    /// 24 px, React `size="sm"`.
    pub fn sm(mut self) -> Self {
        self.face = Face::Sm;
        self
    }

    /// 40 px, React `size="lg"`.
    pub fn lg(mut self) -> Self {
        self.face = Face::Lg;
        self
    }

    pub fn image(mut self, image: impl Into<ImageSource>) -> Self {
        self.image = Some(image.into());
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl Styled for Avatar {
    fn style(&mut self) -> &mut StyleRefinement {
        self.base.style()
    }
}

impl RenderOnce for Avatar {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let side = self.face.px();
        let body: AnyElement = if let Some(image) = self.image {
            img(image)
                .size(px(side))
                .rounded(px(side / 2.0))
                .object_fit(gpui::ObjectFit::Cover)
                .into_any_element()
        } else {
            div()
                .size(px(side))
                .rounded(px(side / 2.0))
                .bg(hsla(t.muted))
                .flex()
                .items_center()
                .justify_center()
                .font_family(FONT)
                .text_size(px(self.face.text()))
                .text_color(hsla(t.muted_foreground))
                .child(self.fallback)
                .into_any_element()
        };
        self.base
            .relative()
            .flex_none()
            .size(px(side))
            .rounded(px(side / 2.0))
            .overflow_hidden()
            .child(body)
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .rounded(px(side / 2.0))
                    .border_1()
                    .border_color(hsla(t.border)),
            )
    }
}
