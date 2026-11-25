//! The Hide screen section (`hide-screen-section.tsx`; P616–P621): the
//! key, and on macOS the password-manager hide with its list. The view is
//! the core's `hide_screen_view`; Hide screen itself is the Studio's
//! Screen row. "Add app…" joins with the picker's open-app list.

use gpui::{AnyElement, Context, SharedString, Window, div, prelude::*, px};
use videorc_app_core::desktop::accelerator::accelerator_display_keys;
use videorc_app_core::editor::inspector::{
    copy as inspector_copy, remove_password_manager, restore_built_in_password_managers,
};
use videorc_app_core::settings_page::SettingsTab;
use videorc_app_core::studio::families::PrivacySettings;
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::kbd::{Kbd, kbd_group};
use videorc_kit::kebab_menu::{KEBAB_HOST, KebabMenu, KebabMenuItem, KebabReveal};
use videorc_kit::list_row::{GroupedList, GroupedRow, ListRow};
use videorc_kit::navigable_row::NavigableRow;
use videorc_kit::panel_section::PanelSection;
use videorc_kit::settings_row::SettingsRow;
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, hsla};

use super::model::copy;
use super::{SceneNavigate, ScenePage};

impl ScenePage {
    pub(super) fn hide_screen_section(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::resolve(None, window, cx);
        let muted = hsla(t.muted_foreground);
        let view = self.model.hide.clone();
        let platform = self.model.platform;
        let page = cx.entity().downgrade();

        // P617: the key, or "Not set"; the row opens Settings → Shortcuts.
        let key: AnyElement = if self.model.hide_accelerator.trim().is_empty() {
            div()
                .text_color(muted)
                .child(inspector_copy::NOT_SET)
                .into_any_element()
        } else {
            kbd_group(
                accelerator_display_keys(Some(self.model.hide_accelerator.as_str()), platform)
                    .into_iter()
                    .map(Kbd::new),
            )
            .into_any_element()
        };
        let shortcut = NavigableRow::with_control("hide-screen-shortcut", copy::SHORTCUT, key)
            .hint([view.shortcut_hint])
            .on_navigate(cx.listener(|this, _, _, cx| {
                this.navigate(SceneNavigate::Settings(SettingsTab::Shortcuts), cx)
            }));

        let mut section = PanelSection::new("hide-screen")
            .title(copy::HIDE_SCREEN_TITLE)
            .description(div().child(copy::HIDE_SCREEN_DESCRIPTION))
            .child(GroupedList::new().row(shortcut));

        if view.mac {
            // P618: the password-manager hide.
            let switch_page = page.clone();
            section = section.child(
                SettingsRow::new("hide-for-password-managers", copy::PASSWORD_MANAGER_SWITCH)
                    .description(copy::PASSWORD_MANAGER_DESCRIPTION)
                    .child(
                        Switch::new("hide-for-password-managers-switch")
                            .accessibility_label(copy::PASSWORD_MANAGER_SWITCH)
                            .checked(view.hide_for_password_managers)
                            .on_change(move |on, _, cx| {
                                let _ = switch_page.update(cx, |page, _| {
                                    page.update_privacy(|settings| {
                                        let mut next = settings.clone();
                                        next.hide_for_password_managers = on;
                                        next
                                    })
                                });
                            }),
                    ),
            );

            // P619: the list, never empty; the last row can't be removed.
            let mut list = GroupedList::new().label(copy::PASSWORD_MANAGERS);
            for entry in &view.entries {
                let remove_page = page.clone();
                let remove_id = entry.id.clone();
                let mut remove = KebabMenuItem::new("remove", copy::REMOVE, move |_, cx| {
                    let id = remove_id.clone();
                    let _ = remove_page.update(cx, |page, _| {
                        page.update_privacy(|settings| remove_password_manager(settings, &id))
                    });
                })
                .destructive(true);
                if !view.removable {
                    remove = remove
                        .disabled(true)
                        .disabled_reason(inspector_copy::LAST_APP_REASON);
                }
                list = list.item(
                    div()
                        .id(SharedString::from(format!("password-manager-{}", entry.id)))
                        .group(KEBAB_HOST)
                        .child(
                            ListRow::new(
                                SharedString::from(format!("password-manager-row-{}", entry.id)),
                                entry.name.clone(),
                            )
                            .grouped()
                            .icon(icon(IconName::LockKey, 14., muted))
                            .child(
                                KebabMenu::new(
                                    SharedString::from(format!(
                                        "password-manager-actions-{}",
                                        entry.id
                                    )),
                                    vec![remove],
                                )
                                .label(copy::actions_for(&entry.name))
                                .reveal(KebabReveal::Hover),
                            ),
                        ),
                );
            }
            section = section.child(list);

            // P621: Restore built-in apps, once one was removed.
            if view.restore_shown {
                let restore_page = page;
                section = section.child(
                    div().flex().flex_wrap().gap(px(8.)).child(
                        Button::new("restore-built-in-password-managers")
                            .label(copy::RESTORE_BUILT_IN)
                            .variant(ButtonVariant::Ghost)
                            .on_click(move |_, _, cx| {
                                let _ = restore_page.update(cx, |page, _| {
                                    page.update_privacy(restore_built_in_password_managers)
                                });
                            }),
                    ),
                );
            }
        }
        section.into_any_element()
    }

    /// `updatePrivacySettings`: the next settings from the stored ones.
    fn update_privacy(&self, edit: impl FnOnce(&PrivacySettings) -> PrivacySettings) {
        let studio = self.studio.clone();
        let next = edit(&studio.watch().borrow().settings.families.privacy);
        self.run(async move {
            let result = studio.set_privacy_settings(&next).await;
            eprintln!("[videorc-app] Privacy settings: {result:?}");
        });
    }
}
