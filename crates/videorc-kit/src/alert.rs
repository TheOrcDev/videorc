//! Alert: a flush inline status row on the row radius
//! (`components/ui/alert.tsx`), never a card. One neutral fill for every
//! tone, the icon in the tone and the text monochrome: a tone never tints
//! the row, as it never tints a toast.
//!
//! - The variant is the tone and brings its own icon, at Phosphor's fill
//!   weight. [`Alert::icon`] swaps in a subject's own mark (the microphone, a
//!   platform) and [`Alert::no_icon`] drops it.
//! - Destructive is the one assertive alert (AccessKit's alert role); every
//!   other variant is a polite status line (the status role).
//! - `Quiet` is a neutral note in secondary text. `Locked` says why the
//!   controls under it are off.
//! - A title alone is a message and reads in regular weight; a title over a
//!   description is a heading and reads in medium.

use gpui::{
    AnyElement, App, ElementId, FontWeight, IntoElement, Role, SharedString, Window, div,
    prelude::*, px,
};

use crate::{
    icon::{IconName, icon},
    theme::{Appearance, hsla, resolve, with_alpha},
    tokens::{Color, Theme, radius},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AlertVariant {
    #[default]
    Default,
    /// The one assertive alert.
    Destructive,
    /// Why the controls under it are off.
    Locked,
    /// A neutral note in secondary text.
    Quiet,
    Success,
    Warning,
}

impl AlertVariant {
    /// The tone's own glyph, from the icon registry's meanings.
    pub fn icon(self) -> IconName {
        match self {
            AlertVariant::Default | AlertVariant::Quiet => IconName::InfoFill,
            AlertVariant::Destructive => IconName::XCircleFill,
            AlertVariant::Locked => IconName::LockFill,
            AlertVariant::Success => IconName::CheckCircleFill,
            AlertVariant::Warning => IconName::WarningFill,
        }
    }

    /// The live-region role the alert announces with.
    pub fn role(self) -> Role {
        if self == AlertVariant::Destructive {
            Role::Alert
        } else {
            Role::Status
        }
    }

    /// The icon's colour: the tone, or secondary text for the neutral tones.
    fn icon_color(self, t: &Theme) -> Color {
        match self {
            AlertVariant::Destructive => t.destructive,
            AlertVariant::Success => t.success,
            AlertVariant::Warning => t.warning,
            AlertVariant::Default | AlertVariant::Locked | AlertVariant::Quiet => {
                t.muted_foreground
            }
        }
    }

    /// The title's colour: secondary for a quiet note or a locked reason.
    fn title_color(self, t: &Theme) -> Color {
        match self {
            AlertVariant::Locked | AlertVariant::Quiet => t.muted_foreground,
            _ => t.foreground,
        }
    }
}

enum AlertIcon {
    Tone,
    /// A subject's glyph, drawn as the tone's own is (fill weight, tone ink).
    Glyph(IconName),
    Own(AnyElement),
    None,
}

#[derive(IntoElement)]
pub struct Alert {
    id: ElementId,
    variant: AlertVariant,
    icon: AlertIcon,
    title: Option<SharedString>,
    description: Option<AnyElement>,
    action: Option<AnyElement>,
    appearance: Option<Appearance>,
}

impl Alert {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Alert {
            id: id.into(),
            variant: AlertVariant::Default,
            icon: AlertIcon::Tone,
            title: None,
            description: None,
            action: None,
            appearance: None,
        }
    }

    pub fn variant(mut self, variant: AlertVariant) -> Self {
        self.variant = variant;
        self
    }

    /// `AlertTitle`: the message, or the heading over a description.
    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// `AlertDescription`: secondary text under the title (words, or words
    /// with a link).
    pub fn description(mut self, description: impl IntoElement) -> Self {
        self.description = Some(description.into_any_element());
        self
    }

    /// `AlertAction`: a control pinned to the top right (Retry, Dismiss),
    /// out of flow as Electron's is.
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.action = Some(action.into_any_element());
        self
    }

    /// A subject's glyph in place of the tone's (Sparkle, UploadSimple,
    /// ArrowsClockwise), at Phosphor's fill weight in the tone's colour, as
    /// Electron's `icon` prop draws every alert icon (`weight="fill"`).
    pub fn glyph(mut self, name: IconName) -> Self {
        self.icon = AlertIcon::Glyph(name);
        self
    }

    /// A subject's own mark in place of the tone's icon, 16 px, drawn as
    /// given (a platform's brand mark).
    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = AlertIcon::Own(icon.into_any_element());
        self
    }

    /// No leading icon.
    pub fn no_icon(mut self) -> Self {
        self.icon = AlertIcon::None;
        self
    }

    /// Draws in this appearance instead of the window's (the gallery).
    pub fn appearance(mut self, appearance: Appearance) -> Self {
        self.appearance = Some(appearance);
        self
    }
}

impl RenderOnce for Alert {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = resolve(self.appearance, window, cx);
        let variant = self.variant;
        let has_description = self.description.is_some();
        let leading = match self.icon {
            AlertIcon::Tone => {
                Some(icon(variant.icon(), 16.0, hsla(variant.icon_color(t))).into_any_element())
            }
            AlertIcon::Glyph(name) => {
                Some(icon(name.filled(), 16.0, hsla(variant.icon_color(t))).into_any_element())
            }
            AlertIcon::Own(mark) => Some(mark),
            AlertIcon::None => None,
        };
        // Electron lays the alert out as a grid whose icon spans two rows
        // (`*:[svg]:row-span-2`): beside a single line of text the second row
        // is empty but its `gap-0.5` stays, so the row is 42 px, not 40.
        let lines = usize::from(self.title.is_some()) + usize::from(has_description);
        let empty_row = leading.is_some() && lines == 1;
        // The 16 px icon sits 2 px down, on the first line of 20 px text.
        let leading = leading.map(|mark| {
            div()
                .flex_none()
                .mt(px(2.0))
                .size(px(16.0))
                .flex()
                .items_center()
                .justify_center()
                .child(mark)
        });
        let body = div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(2.0))
            .children(self.title.map(|title| {
                div()
                    .text_color(hsla(variant.title_color(t)))
                    .font_weight(if has_description {
                        FontWeight::MEDIUM
                    } else {
                        FontWeight::NORMAL
                    })
                    .child(title)
            }))
            .children(self.description.map(|description| {
                div()
                    .text_color(hsla(t.muted_foreground))
                    .child(description)
            }));
        let has_action = self.action.is_some();
        div()
            .id(self.id)
            .role(variant.role())
            .relative()
            .w_full()
            .flex()
            .items_start()
            .gap(px(10.0))
            .px(px(12.0))
            .pt(px(10.0))
            .pb(px(if empty_row { 12.0 } else { 10.0 }))
            // The action's room: 72 px on the right (`pr-18`); the action
            // itself is absolute (`top-2.5 right-3`) and never grows the row.
            .when(has_action, |alert| alert.pr(px(72.0)))
            .rounded(px(radius::ROW))
            .bg(hsla(with_alpha(t.foreground, 0.04)))
            .text_color(hsla(t.foreground))
            .text_size(px(14.0))
            .line_height(px(20.0))
            .children(leading)
            .child(body)
            .children(
                self.action
                    .map(|action| div().absolute().top(px(10.0)).right(px(12.0)).child(action)),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_destructive_is_assertive() {
        for variant in [
            AlertVariant::Default,
            AlertVariant::Locked,
            AlertVariant::Quiet,
            AlertVariant::Success,
            AlertVariant::Warning,
        ] {
            assert_eq!(variant.role(), Role::Status, "{variant:?}");
        }
        assert_eq!(AlertVariant::Destructive.role(), Role::Alert);
    }

    #[test]
    fn each_tone_brings_its_glyph() {
        assert_eq!(AlertVariant::Default.icon(), IconName::InfoFill);
        assert_eq!(AlertVariant::Quiet.icon(), IconName::InfoFill);
        assert_eq!(AlertVariant::Destructive.icon(), IconName::XCircleFill);
        assert_eq!(AlertVariant::Locked.icon(), IconName::LockFill);
        assert_eq!(AlertVariant::Success.icon(), IconName::CheckCircleFill);
        assert_eq!(AlertVariant::Warning.icon(), IconName::WarningFill);
    }

    #[test]
    fn a_tone_never_tints_the_row_or_its_text() {
        let t = Appearance::DARK.theme();
        for variant in [
            AlertVariant::Default,
            AlertVariant::Destructive,
            AlertVariant::Success,
            AlertVariant::Warning,
        ] {
            assert_eq!(variant.title_color(t), t.foreground, "{variant:?}");
        }
        assert_eq!(AlertVariant::Quiet.title_color(t), t.muted_foreground);
        assert_eq!(AlertVariant::Locked.title_color(t), t.muted_foreground);
        assert_eq!(AlertVariant::Destructive.icon_color(t), t.destructive);
        assert_eq!(AlertVariant::Quiet.icon_color(t), t.muted_foreground);
    }
}
