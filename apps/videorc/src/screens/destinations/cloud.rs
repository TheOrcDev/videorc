//! Videorc Cloud on Destinations Setup (`CloudSection`, P777–P782).

use gpui::{AnyElement, Context, SharedString, Window, div, prelude::*};
use serde_json::json;
use videorc_app_core::livestream::cloud_view::{
    self, CLOUD_PREMIUM_REASON, HOLD_IMAGE_DESCRIPTION, HOLD_IMAGE_LABEL, HOLD_MAX_DESCRIPTION,
    HOLD_MAX_LABEL, SECTION_DESCRIPTION, STREAM_THROUGH_LABEL, SectionState, SectionView,
    TEST_BUTTON, TEST_LABEL,
};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::select::Select;
use videorc_kit::settings_row::{SettingsGroup, SettingsRow};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::DestinationsPanel;

impl DestinationsPanel {
    pub(super) fn cloud_section(
        &self,
        view: &SectionView,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::current(window, cx).theme();
        let entity = cx.entity();
        let mut section = PanelSection::new("destinations-cloud")
            .title("Videorc Cloud")
            .description(SECTION_DESCRIPTION);

        match &view.state {
            SectionState::Upsell => {
                section = section.child(
                    Alert::new("cloud-upsell")
                        .variant(AlertVariant::Locked)
                        .title(CLOUD_PREMIUM_REASON)
                        .action(
                            Button::new("cloud-view-premium")
                                .label(videorc_app_core::livestream::copy::VIEW_PREMIUM)
                                .variant(ButtonVariant::Outline)
                                .on_click(|_, _, cx| cx.open_url("https://videorc.com/premium")),
                        ),
                );
            }
            SectionState::Unavailable { reason } => {
                section = section.child(
                    Alert::new("cloud-unavailable")
                        .variant(AlertVariant::Locked)
                        .title(reason.clone()),
                );
            }
            SectionState::Available { hours } => {
                if let Some(hours) = hours {
                    section =
                        section.action(Badge::new(hours.clone()).variant(BadgeVariant::Outline));
                }
            }
        }

        let switch_desc = if view.switch_lines.is_empty() {
            None
        } else {
            Some(view.switch_lines.join("\n"))
        };
        let enabled = view.enabled;
        let disabled = view.disabled;
        section = section.child(
            SettingsGroup::new().row(
                SettingsRow::new("cloud-stream-through", STREAM_THROUGH_LABEL)
                    .description(switch_desc.unwrap_or_default())
                    .child(
                        Switch::new("cloud-enabled")
                            .accessibility_label(STREAM_THROUGH_LABEL)
                            .checked(enabled)
                            .disabled(disabled)
                            .on_change({
                                let entity = entity.clone();
                                move |value, _, cx| {
                                    entity.update(cx, |this, _| this.set_cloud_enabled(value));
                                }
                            }),
                    ),
            ),
        );

        let test_desc = view
            .test_lines
            .error
            .clone()
            .or_else(|| view.test_lines.description.clone())
            .unwrap_or_default();
        let test_blocked = view.test_blocked;
        let test_running = view.test_running;
        let mut test_row = SettingsRow::new("cloud-test", TEST_LABEL).description(test_desc);
        if let Some(reason) = test_blocked {
            test_row = test_row.description(reason);
        }
        section = section.child(
            SettingsGroup::new().row(
                test_row.child(
                    Button::new("cloud-test-run")
                        .label(if test_running {
                            "Testing…"
                        } else {
                            TEST_BUTTON
                        })
                        .variant(ButtonVariant::Outline)
                        .disabled(disabled || test_blocked.is_some() || test_running)
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| entity.update(cx, |this, _| this.run_cloud_test())
                        }),
                ),
            ),
        );

        if view.show_hold {
            let hold_choices = cloud_view::hold_image_choices(&[]);
            let hold_image = view.hold_image.clone();
            let mut image_select = Select::new("cloud-hold-image")
                .accessibility_label(HOLD_IMAGE_LABEL)
                .disabled(disabled)
                .width(180.0)
                .value(Some(SharedString::from(hold_image)))
                .on_change({
                    let entity = entity.clone();
                    move |value: SharedString, _, cx| {
                        entity.update(cx, |this, _| {
                            this.patch_cloud(cloud_view::hold_image_patch(value.as_ref()))
                        });
                    }
                });
            for (id, label) in &hold_choices {
                image_select = image_select.option(id.clone(), label.clone());
            }
            section = section.child(
                SettingsGroup::new()
                    .row(
                        SettingsRow::new("cloud-hold-image", HOLD_IMAGE_LABEL)
                            .description(HOLD_IMAGE_DESCRIPTION)
                            .child(image_select),
                    )
                    .row({
                        let mut max_select = Select::new("cloud-hold-max")
                            .accessibility_label(HOLD_MAX_LABEL)
                            .disabled(disabled)
                            .width(140.0)
                            .value(Some(SharedString::from(view.hold_max_seconds.to_string())))
                            .on_change({
                                let entity = entity.clone();
                                move |value: SharedString, _, cx| {
                                    let Ok(seconds) = value.parse::<u32>() else {
                                        return;
                                    };
                                    entity.update(cx, |this, _| {
                                        this.patch_cloud(json!({ "holdMaxSeconds": seconds }))
                                    });
                                }
                            });
                        for (seconds, label) in &view.hold_max_choices {
                            max_select = max_select.option(seconds.to_string(), label.clone());
                        }
                        SettingsRow::new("cloud-hold-max", HOLD_MAX_LABEL)
                            .description(HOLD_MAX_DESCRIPTION)
                            .child(max_select)
                    }),
            );
        }

        section
            .child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(videorc_app_core::livestream::copy::NEXT_STREAM),
            )
            .into_any_element()
    }

    fn set_cloud_enabled(&self, enabled: bool) {
        self.patch_cloud(json!({ "enabled": enabled }));
    }

    fn patch_cloud(&self, patch: serde_json::Value) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.set_cloud_settings(patch).await;
        });
    }

    fn run_cloud_test(&self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.run_cloud_test().await;
        });
    }
}
