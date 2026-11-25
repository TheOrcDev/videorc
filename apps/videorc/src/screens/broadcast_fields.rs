//! `BroadcastInfoFields` (`streaming/broadcast-info-fields.tsx`): the title
//! with its counter, the description, and YouTube's privacy, stacked 16 px
//! apart. Destinations' Stream details and the Go live dialog draw the same
//! fields from the same draft.
//!
//! Each field is the kit's `Field` (label, control, description, error),
//! the title's counter at the end of its label line.

use gpui::{AnyElement, App, Entity, SharedString, Window, div, prelude::*, px};
use videorc_app_core::livestream::copy as page_copy;
use videorc_app_core::livestream::details::Privacy;
use videorc_kit::field::Field;
use videorc_kit::input::{Input, InputState};
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::textarea::{Textarea, TextareaState};
use videorc_kit::theme::{TypeScale, hsla};
use videorc_kit::tokens::{Theme, text};

/// What the fields show.
pub struct Fields<'a> {
    /// Element ids start with this (`stream`, `go-live`).
    pub id: &'static str,
    pub title: &'a Entity<InputState>,
    /// `broadcastTitleCounter` ("0/100").
    pub title_counter: String,
    pub title_error: Option<String>,
    pub description: &'a Entity<TextareaState>,
    pub description_error: Option<String>,
    /// Drawn only while a YouTube destination is on (privacy is YouTube's).
    pub privacy: Option<Privacy>,
    pub disabled: bool,
}

type PrivacyChange = Box<dyn Fn(Privacy, &mut Window, &mut App)>;

/// The value a privacy segment carries.
pub fn privacy_value(privacy: Privacy) -> &'static str {
    match privacy {
        Privacy::Private => "private",
        Privacy::Unlisted => "unlisted",
        Privacy::Public => "public",
    }
}

pub fn privacy_from_value(value: &str) -> Privacy {
    match value {
        "unlisted" => Privacy::Unlisted,
        "public" => Privacy::Public,
        _ => Privacy::Private,
    }
}

/// The fields, 16 px apart (`flex flex-col gap-4`).
pub fn broadcast_info_fields(
    t: &Theme,
    fields: Fields<'_>,
    on_privacy: impl Fn(Privacy, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let id = fields.id;
    let on_privacy: PrivacyChange = Box::new(on_privacy);
    let title = Field::new(SharedString::from(format!("{id}-title-field")))
        .label(page_copy::TITLE)
        // The counter is a fact about the field, not its description.
        .label_end(
            div()
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(fields.title_counter),
        )
        .child(
            Input::new(SharedString::from(format!("{id}-title")), fields.title)
                .accessibility_label(page_copy::TITLE)
                .disabled(fields.disabled)
                .invalid(fields.title_error.is_some()),
        )
        .when_some(fields.title_error, |field, error| field.error(error));

    let description = Field::new(SharedString::from(format!("{id}-description-field")))
        .label(page_copy::DESCRIPTION)
        .child(
            Textarea::new(
                SharedString::from(format!("{id}-description")),
                fields.description,
            )
            .accessibility_label(page_copy::DESCRIPTION)
            .disabled(fields.disabled)
            .invalid(fields.description_error.is_some()),
        )
        .when_some(fields.description_error, |field, error| field.error(error));

    let privacy = fields.privacy.map(|privacy| {
        let mut control = SegmentedControl::new(SharedString::from(format!("{id}-privacy")))
            .accessibility_label(page_copy::PRIVACY)
            .disabled(fields.disabled)
            .value(Some(SharedString::from(privacy_value(privacy))))
            .on_change(move |value: SharedString, window, cx| {
                on_privacy(privacy_from_value(value.as_ref()), window, cx)
            });
        for option in Privacy::ALL {
            control = control.option(Segment::new(privacy_value(option), option.label()));
        }
        Field::new(SharedString::from(format!("{id}-privacy-field")))
            .label(page_copy::PRIVACY)
            .description(format!("{} {}", privacy.hint(), page_copy::PRIVACY_NOTE))
            .child(control)
    });

    div()
        .flex()
        .flex_col()
        .gap(px(16.))
        .child(title)
        .child(description)
        .children(privacy)
        .into_any_element()
}
