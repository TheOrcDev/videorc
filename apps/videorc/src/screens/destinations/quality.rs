//! Output quality on Destinations Setup (`StreamQualityControl`, P764–P765).

use gpui::{AnyElement, Context, SharedString, Window, div, prelude::*, px};
use videorc_app_core::livestream::copy as page_copy;
use videorc_app_core::livestream::targets::QualityView;
use videorc_kit::label::Label;
use videorc_kit::panel_section::PanelSection;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::DestinationsPanel;

/// `StreamQualityControl`'s field label.
const STREAM_QUALITY: &str = "Stream quality";

impl DestinationsPanel {
    pub(super) fn quality_section(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::current(window, cx).theme();
        let quality = &self.setup.quality;
        let enabled = self.setup.quality_enabled;
        let entity = cx.entity();
        let control = quality_control("setup-output-quality", quality, !enabled, {
            let entity = entity.clone();
            move |value: SharedString, _, cx| {
                let preset = value.to_string();
                entity.update(cx, |this, _| this.set_page_quality(preset));
            }
        });
        PanelSection::new("destinations-output-quality")
            .title(page_copy::OUTPUT_QUALITY)
            .child(quality_field(
                &t,
                control.small(false),
                quality.description.clone(),
                !enabled,
            ))
            .into_any_element()
    }

    fn set_page_quality(&self, preset: String) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.set_stream_quality(&preset).await;
        });
    }
}

/// `StreamQualityControl`: a vertical Field (`gap-3`, 12 px) with its label,
/// the control filling the column, and the description under it. The page's
/// Output quality and an open destination's card (Electron's `inherit`) both
/// show this one field.
pub(super) fn quality_field(
    t: &videorc_kit::tokens::Theme,
    control: SegmentedControl,
    description: impl IntoElement,
    disabled: bool,
) -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(Label::new(STREAM_QUALITY).disabled(disabled))
        .child(control)
        .child(
            div()
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(description),
        )
}

pub(super) fn quality_control(
    id: impl Into<gpui::ElementId>,
    quality: &QualityView,
    disabled: bool,
    on_change: impl Fn(SharedString, &mut Window, &mut gpui::App) + 'static,
) -> SegmentedControl {
    let selected = quality
        .options
        .get(quality.selected.max(0) as usize)
        .filter(|_| quality.selected >= 0)
        .map(|option| option.value.clone());
    // Electron's StreamQualityControl is the default size (13 px words, 12 px
    // sides, a 28 px track): at that size its three options wrap onto two
    // rows of the Output quality column, as Electron's do.
    let mut control = SegmentedControl::new(id)
        // Electron fills it (`w-full`, or a vertical Field's `*:w-full`).
        .full(true)
        .accessibility_label(page_copy::OUTPUT_QUALITY)
        .disabled(disabled)
        .value(selected.map(SharedString::from))
        .on_change(on_change);
    for option in &quality.options {
        control = control.option(Segment::new(option.value.clone(), option.label.clone()));
    }
    control
}
