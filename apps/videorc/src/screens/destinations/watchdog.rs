//! Destinations → Watchdog settings (`WatchdogSection`, P783–P790).
//!
//! Words and view rules come from `livestream::watchdog_section`. The
//! Studio's `watchdog_settings` reads and saves them over
//! `watchdog.settings.*` and reads the phones once per Premium account.

use gpui::{AnyElement, ClipboardItem, Context, SharedString, Window, div, prelude::*, px};
use videorc_app_core::livestream::copy as page_copy;
use videorc_app_core::livestream::watchdog_section::{
    self, AI_CHAT_READ, AI_CHAT_READ_DESCRIPTION, ALERT_ME_AFTER, ALERT_ME_AFTER_DESCRIPTION,
    DESCRIPTION, LIVE_URL, MIC_MUTED_AFTER_OPTIONS, PHONE, PHONE_PREMIUM_REASON, QR_CODE_LABEL,
    SYSTEM_NOTIFICATIONS, SYSTEM_NOTIFICATIONS_DESCRIPTION, SectionView, TITLE,
};
use videorc_app_core::studio::watchdog_settings::WatchdogSettingsStore;
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::qr_code::QrCode;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::settings_row::{SettingsGroup, SettingsRow};
use videorc_kit::switch::Switch;

use super::DestinationsPanel;

impl DestinationsPanel {
    pub(super) fn watchdog_premium(studio: &super::AppStudio) -> bool {
        studio
            .cloud_now()
            .status
            .as_ref()
            .is_some_and(|status| status.entitled || status.plan.is_some())
    }

    pub(super) fn watchdog_view(
        store: &WatchdogSettingsStore,
        premium: bool,
    ) -> Option<SectionView> {
        watchdog_section::section_view(
            store.settings.as_ref(),
            premium,
            store.phone_devices,
            store.show_code,
            store.copied,
        )
    }

    pub(super) fn watchdog_section(
        &self,
        view: &SectionView,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let entity = cx.entity();
        let mut section = PanelSection::new("destinations-watchdog")
            .title(TITLE)
            .description(DESCRIPTION);

        let mut checks = SettingsGroup::new();
        for row in &view.checks {
            let id = row.id.to_string();
            let enabled = row.enabled;
            checks = checks.row(
                SettingsRow::new(format!("watchdog-check-{id}"), row.label)
                    .description(row.description)
                    .child(
                        Switch::new(format!("watchdog-check-switch-{id}"))
                            .accessibility_label(row.label)
                            .checked(enabled)
                            .on_change({
                                let entity = entity.clone();
                                let id = id.clone();
                                move |value, _, cx| {
                                    entity.update(cx, |this, _| {
                                        this.set_watchdog_check(id.clone(), value)
                                    });
                                }
                            }),
                    ),
            );
        }
        section = section.child(checks);

        let mic_value = view
            .mic_muted_after_seconds
            .map(|seconds| SharedString::from(seconds.to_string()));
        // Electron's `<SegmentedControl size="sm">` in a SettingsRow: `w-fit`.
        let mut mic_control = SegmentedControl::new("watchdog-mic-muted-after")
            .small(true)
            .fit(true)
            .accessibility_label(ALERT_ME_AFTER)
            .value(mic_value)
            .on_change({
                let entity = entity.clone();
                move |value: SharedString, _, cx| {
                    let Ok(seconds) = value.parse::<u32>() else {
                        return;
                    };
                    entity.update(cx, |this, _| this.set_watchdog_mic_muted_after(seconds));
                }
            });
        for (seconds, label) in &MIC_MUTED_AFTER_OPTIONS {
            mic_control = mic_control.option(Segment::new(seconds.to_string(), *label));
        }
        section = section.child(
            SettingsGroup::new()
                .row(
                    SettingsRow::new("watchdog-mic-muted-after", ALERT_ME_AFTER)
                        .description(ALERT_ME_AFTER_DESCRIPTION)
                        .child(mic_control),
                )
                .row(
                    SettingsRow::new("watchdog-system-notifications", SYSTEM_NOTIFICATIONS)
                        .description(SYSTEM_NOTIFICATIONS_DESCRIPTION)
                        .child(
                            Switch::new("watchdog-system-notifications")
                                .accessibility_label(SYSTEM_NOTIFICATIONS)
                                .checked(view.system_notifications)
                                .on_change({
                                    let entity = entity.clone();
                                    move |value, _, cx| {
                                        entity.update(cx, |this, _| {
                                            this.set_watchdog_system_notifications(value)
                                        });
                                    }
                                }),
                        ),
                ),
        );

        if view.locked {
            section = section.child(
                Alert::new("watchdog-phone-lock")
                    .variant(AlertVariant::Locked)
                    .title(PHONE_PREMIUM_REASON)
                    .action(
                        Button::new("watchdog-view-premium")
                            .label(page_copy::VIEW_PREMIUM)
                            .variant(ButtonVariant::Outline)
                            .on_click(|_, _, cx| cx.open_url("https://videorc.com/premium")),
                    ),
            );
        }

        let mut phone_group = SettingsGroup::new().row(
            SettingsRow::new("watchdog-phone", PHONE)
                .description(view.phone_description.clone())
                .child(
                    Switch::new("watchdog-phone-push")
                        .accessibility_label(PHONE)
                        .checked(view.phone_push)
                        .disabled(!view.premium_switches_enabled)
                        .on_change({
                            let entity = entity.clone();
                            move |value, _, cx| {
                                entity.update(cx, |this, _| this.set_watchdog_phone_push(value));
                            }
                        }),
                ),
        );

        if view.phone_actions {
            phone_group = phone_group.row(
                SettingsRow::new("watchdog-phone-code", "Phone alerts")
                    .description(if view.show_code {
                        LIVE_URL
                    } else {
                        "Show a link for videorc.com/live on your phone."
                    })
                    .child(
                        // `PhoneCode` beside the buttons: dark on light in
                        // both themes (the kit's QR), 112 px as `size-28`.
                        div()
                            .flex()
                            .items_center()
                            .gap(px(12.))
                            .when(view.show_code, |row| {
                                row.child(
                                    QrCode::new("watchdog-phone-qr", LIVE_URL)
                                        .size(112.)
                                        .accessibility_label(QR_CODE_LABEL),
                                )
                            })
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(4.))
                                    .child(
                                        Button::new("watchdog-show-code")
                                            .label(view.show_code_label)
                                            .variant(ButtonVariant::Outline)
                                            .on_click({
                                                let entity = entity.clone();
                                                let show = !view.show_code;
                                                move |_, _, cx| {
                                                    entity.update(cx, |this, _| {
                                                        this.set_watchdog_show_code(show)
                                                    });
                                                }
                                            }),
                                    )
                                    .child(
                                        Button::new("watchdog-copy-link")
                                            .label(view.copy_label)
                                            .variant(ButtonVariant::Ghost)
                                            .on_click({
                                                let entity = entity.clone();
                                                move |_, _, cx| {
                                                    cx.write_to_clipboard(
                                                        ClipboardItem::new_string(
                                                            LIVE_URL.to_string(),
                                                        ),
                                                    );
                                                    entity.update(cx, |this, _| {
                                                        this.note_watchdog_link_copied()
                                                    });
                                                }
                                            }),
                                    ),
                            ),
                    ),
            );
        }

        phone_group = phone_group.row(
            SettingsRow::new("watchdog-ai-chat-read", AI_CHAT_READ)
                .description(AI_CHAT_READ_DESCRIPTION)
                .child(
                    Switch::new("watchdog-ai-chat-read")
                        .accessibility_label(AI_CHAT_READ)
                        .checked(view.ai_chat_read)
                        .disabled(!view.premium_switches_enabled)
                        .on_change({
                            let entity = entity.clone();
                            move |value, _, cx| {
                                entity.update(cx, |this, _| this.set_watchdog_ai_chat_read(value));
                            }
                        }),
                ),
        );
        section = section.child(phone_group);
        section.into_any_element()
    }

    fn set_watchdog_check(&self, id: String, enabled: bool) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.set_watchdog_check(&id, enabled).await;
        });
    }

    fn set_watchdog_mic_muted_after(&self, seconds: u32) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.set_watchdog_mic_muted_after(seconds).await;
        });
    }

    fn set_watchdog_system_notifications(&self, on: bool) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.set_watchdog_system_notifications(on).await;
        });
    }

    fn set_watchdog_phone_push(&self, on: bool) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.set_watchdog_phone_push(on).await;
        });
    }

    fn set_watchdog_ai_chat_read(&self, on: bool) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.set_watchdog_ai_chat_read(on).await;
        });
    }

    fn set_watchdog_show_code(&self, show: bool) {
        self.studio.set_watchdog_show_code(show);
    }

    fn note_watchdog_link_copied(&self) {
        self.studio.note_watchdog_link_copied();
    }

    /// Every rebuild asks; the Studio answers `true` once per Premium
    /// account, so a failed or signed-out read is not sent again each tick.
    pub(super) fn refresh_watchdog_phone_if_needed(&self, premium: bool) {
        if !self.studio.claim_watchdog_phone_read(premium) {
            return;
        }
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.refresh_watchdog_phone_devices().await;
        });
    }
}
