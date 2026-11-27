//! The Hide screen section (`hide-screen-section.tsx`; P616–P621): the
//! key, and on macOS the password-manager hide with its list. The view is
//! the core's `hide_screen_view`; Hide screen itself is the Studio's
//! Screen row. "Add app…" joins with the picker's open-app list.

use gpui::{AnyElement, Context, SharedString, Window, div, prelude::*, px};
use videorc_app_core::desktop::accelerator::accelerator_label;
use videorc_app_core::editor::inspector::{
    copy as inspector_copy, remove_password_manager, restore_built_in_password_managers,
};
use videorc_app_core::scenes::picker::app_choices_from_devices;
use videorc_app_core::settings_page::SettingsTab;
use videorc_app_core::studio::families::{PrivacySettings, add_password_manager};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::input_group::{InputGroup, InputGroupAddon};
use videorc_kit::kbd::Kbd;
use videorc_kit::kebab_menu::{KEBAB_HOST, KebabMenu, KebabMenuItem, KebabReveal};
use videorc_kit::list_row::{GroupedList, GroupedRow, ListRow};
use videorc_kit::navigable_row::NavigableRow;
use videorc_kit::panel_section::PanelSection;
use videorc_kit::popover::Popover;
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

        // P617: the key as one keycap (`ShortcutKeys`), or "Not set"; the
        // row opens Settings → Shortcuts.
        let key: AnyElement = if self.model.hide_accelerator.trim().is_empty() {
            div()
                .text_color(muted)
                .child(inspector_copy::NOT_SET)
                .into_any_element()
        } else {
            Kbd::new(accelerator_label(
                Some(self.model.hide_accelerator.as_str()),
                platform,
            ))
            .into_any_element()
        };
        let shortcut = NavigableRow::with_control("hide-screen-shortcut", copy::SHORTCUT, key)
            .hint([view.shortcut_hint])
            .on_navigate(cx.listener(|this, _, _, cx| {
                this.navigate(SceneNavigate::Settings(SettingsTab::Shortcuts), cx)
            }));

        // The key and, on macOS, the password-manager hide share one inset
        // group (`FieldGroup variant="grouped"`).
        let mut settings = GroupedList::new().row(shortcut);
        if view.mac {
            // P618: the password-manager hide.
            let switch_page = page.clone();
            settings = settings.item(
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
        }
        let mut section = PanelSection::new("hide-screen")
            .title(copy::HIDE_SCREEN_TITLE)
            .description(div().child(copy::HIDE_SCREEN_DESCRIPTION))
            .child(settings);

        if view.mac {
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
                            .icon(icon(IconName::LockKey, 16., muted))
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

            // P620: Add app… (the open apps from the device list; the app
            // pictures' request is not in the protocol yet). P621: Restore
            // built-in apps, once one was removed.
            let open_page = page.clone();
            let content_page = page.clone();
            let add = Popover::new("password-manager-add")
                .open(self.add_app_open)
                .trigger(
                    Button::new("password-manager-add-trigger")
                        .label(copy::ADD_APP)
                        .variant(ButtonVariant::Outline),
                )
                .on_open_change(move |open, window, cx| {
                    let _ = open_page.update(cx, |page, cx| {
                        page.add_app_open = open;
                        // Each opening starts a fresh search, focused
                        // (`autoFocus`).
                        if open {
                            page.add_app_search.update(cx, |search, cx| {
                                search.set_value("", window, cx);
                                search.focus(window, cx);
                            });
                        }
                        cx.notify();
                    });
                })
                .content(move |window, cx| {
                    content_page
                        .update(cx, |page, cx| page.add_app_content(window, cx))
                        .unwrap_or_else(|_| div().into_any_element())
                });
            let mut actions = div().flex().flex_wrap().gap(px(8.)).child(add);
            if view.restore_shown {
                let restore_page = page;
                actions = actions.child(
                    Button::new("restore-built-in-password-managers")
                        .label(copy::RESTORE_BUILT_IN)
                        .variant(ButtonVariant::Outline)
                        .on_click(move |_, _, cx| {
                            let _ = restore_page.update(cx, |page, _| {
                                page.update_privacy(restore_built_in_password_managers)
                            });
                        }),
                );
            }
            // The list and its buttons 8 px apart, as one block.
            section = section.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(list)
                    .child(actions),
            );
        }
        section.into_any_element()
    }

    /// Add app…'s list: open apps not on the list yet.
    fn add_app_content(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = theme::resolve(None, window, cx);
        let muted = hsla(t.muted_foreground);
        let snapshot = self.studio.watch().borrow().clone();
        let listed: Vec<String> = self
            .model
            .hide
            .entries
            .iter()
            .flat_map(|entry| entry.bundle_ids.iter().map(|id| id.to_lowercase()))
            .collect();
        let own = vec!["dev.theorcdev.videorc".to_string()];
        let offered: Vec<_> = app_choices_from_devices(&snapshot.sources.devices.devices, &own)
            .into_iter()
            .filter(|app| !listed.contains(&app.bundle_id.to_lowercase()))
            .collect();
        // The search matches the name or the bundle id (`keywords`).
        let query = self.add_app_search.read(cx).value().trim().to_lowercase();
        let matching: Vec<_> = offered
            .iter()
            .filter(|app| {
                query.is_empty()
                    || app.name.to_lowercase().contains(&query)
                    || app.bundle_id.to_lowercase().contains(&query)
            })
            .cloned()
            .collect();
        let status = if !snapshot.sources.devices_known {
            Some(inspector_copy::FINDING_APPS)
        } else if offered.is_empty() {
            Some(inspector_copy::EVERY_APP_LISTED)
        } else {
            None
        };
        let empty =
            (!offered.is_empty() && matching.is_empty()).then_some(inspector_copy::NO_APP_MATCHES);
        let search = InputGroup::new("add-app-search", &self.add_app_search)
            .accessibility_label(copy::SEARCH_OPEN_APPS_LABEL)
            .start(InputGroupAddon::start().child(icon(IconName::MagnifyingGlass, 14., muted)));
        // cmdk's `CommandList label`: a name for assistive tech only.
        let mut list = GroupedList::new().accessibility_label(copy::OPEN_APPS);
        for app in matching {
            let (bundle_id, name) = (app.bundle_id.clone(), app.name.clone());
            list = list.row(
                ListRow::new(
                    SharedString::from(format!("add-app-{bundle_id}")),
                    app.name.clone(),
                )
                .grouped()
                .on_click(cx.listener(move |this, _, _, cx| {
                    let (bundle_id, name) = (bundle_id.clone(), name.clone());
                    this.update_privacy(|settings| {
                        add_password_manager(settings, &bundle_id, &name)
                    });
                    this.add_app_open = false;
                    cx.notify();
                })),
            );
        }
        div()
            .w(px(288.))
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(search)
            .children(empty.map(|line| div().text_color(muted).child(line)))
            .child(list)
            .children(status.map(|line| div().text_color(muted).child(line)))
            .into_any_element()
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
