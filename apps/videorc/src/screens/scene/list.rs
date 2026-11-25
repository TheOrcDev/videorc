//! The Scenes section (`scene-list.tsx`, `scene-entries.tsx`; P455–P475):
//! every scene in library order, the one on stream checked. A click puts a
//! scene on stream; ⌥↑ and ⌥↓ move it; its ⋯ menu renames, follows, keeps
//! the audio, duplicates and deletes it.

use std::collections::HashMap;

use gpui::{
    AnyElement, Context, FontWeight, KeyDownEvent, SharedString, Window, div, prelude::*, px,
};
use serde_json::Value;
use videorc_app_core::desktop::accelerator::{
    accelerator_display_keys, accelerator_label, global_shortcut_conflict_reason,
};
use videorc_app_core::nav::PageId;
use videorc_app_core::scenes::list::{duplicated_scene, scene_with_audio, scene_with_follow};
use videorc_app_core::scenes::model::scene_audio;
use videorc_app_core::scenes::store::DeleteRule;
use videorc_app_core::studio::scenes_section::copy::EDIT_SCENE;
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::kbd::{Kbd, kbd_group};
use videorc_kit::kebab_menu::{KEBAB_HOST, KebabMenu, KebabMenuItem, KebabReveal};
use videorc_kit::list_row::{GroupedList, GroupedRow, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::spinner::Spinner;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;
use videorc_kit::tooltip::tooltip;

use super::model::{RowMeta, SceneRow, copy};
use super::{SceneNavigate, ScenePage, now_iso};

/// `sceneMoveKeyStep`: ⌥↑ is -1 and ⌥↓ is +1; any other modifier is not a
/// move.
fn move_step(event: &KeyDownEvent) -> Option<isize> {
    let modifiers = &event.keystroke.modifiers;
    if !modifiers.alt || modifiers.control || modifiers.platform || modifiers.shift {
        return None;
    }
    match event.keystroke.key.as_str() {
        "up" => Some(-1),
        "down" => Some(1),
        _ => None,
    }
}

impl ScenePage {
    pub(super) fn scenes_section(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::resolve(None, window, cx);
        let muted = hsla(t.muted_foreground);
        let list = self.model.list.clone();
        let platform = self.model.platform;

        // `ScenesLine`: the default position keys, or the sentence for
        // customised ones.
        let description = match &list.keys_line {
            Some((first, last)) => div()
                .child(copy::SCENES_LINE_LEAD)
                .child(
                    div()
                        .font_weight(FontWeight::MEDIUM)
                        .child(accelerator_label(Some(first.as_str()), platform)),
                )
                .child(copy::SCENES_LINE_TO)
                .child(
                    div()
                        .font_weight(FontWeight::MEDIUM)
                        .child(accelerator_label(Some(last.as_str()), platform)),
                )
                .child(copy::SCENES_LINE_TAIL)
                .flex()
                .flex_wrap()
                .into_any_element(),
            None => div().child(copy::SCENES_LINE_CUSTOM).into_any_element(),
        };

        // P453/P454: Add scene…, off with Electron's reason when read-only.
        let mut add = Button::new("scene-new")
            .label(copy::ADD_SCENE)
            .variant(ButtonVariant::Outline)
            .disabled(list.read_only)
            .on_click(cx.listener(|this, _, window, cx| this.open_add(window, cx)));
        if list.read_only {
            add = add.tooltip(copy::READ_ONLY_REASON);
        }
        // P452 / X2: Edit scene, kept in place but hidden while the editor
        // is open, so the header never moves at the first grab.
        let editing = self.studio.watch().borrow().scene_edit_mode;
        let edit = div().when(editing, |slot| slot.invisible()).child(
            Button::new("scene-edit")
                .label(EDIT_SCENE)
                .variant(ButtonVariant::Ghost)
                .disabled(editing)
                .on_click(cx.listener(|this, _, _, cx| this.edit_scene(cx))),
        );
        let mut section = PanelSection::new("scenes")
            .title(copy::SCENES_TITLE)
            .description(description)
            .action(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(edit)
                    .child(add),
            );

        if let Some(error) = list.error {
            section = section.child(
                div()
                    .id("scene-library-error")
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(error),
            );
        }

        let mut rows = GroupedList::new().label(copy::SCENES_TITLE);
        for row in &list.rows {
            rows = rows.item(self.scene_row(row, list.read_only, window, cx));
        }
        section = section.child(rows);

        if let Some(reason) = list.camera_reason.clone() {
            section = section.child(
                div()
                    .id("scene-gallery-reason")
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(4.))
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(reason)
                    .child(
                        Button::new("scene-gallery-open-sources")
                            .label(copy::OPEN_SOURCES)
                            .variant(ButtonVariant::Ghost)
                            .size(ButtonSize::Xs)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.navigate(SceneNavigate::Page(PageId::Sources), cx)
                            })),
                    ),
            );
        }
        section.into_any_element()
    }

    fn scene_row(
        &mut self,
        row: &SceneRow,
        read_only: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::resolve(None, window, cx);
        let muted = hsla(t.muted_foreground);
        let ink = hsla(t.foreground);
        let platform = self.model.platform;
        let id = row.id.clone();

        let mut line = ListRow::new(SharedString::from(format!("scene-{id}")), row.name.clone())
            .selected(row.on_stream)
            .disabled(row.disabled)
            .grouped();
        match &row.meta {
            RowMeta::None => {}
            RowMeta::Text(words) => line = line.context(words.clone()),
            RowMeta::Pending => {
                line = line.alias(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .text_color(muted)
                        .child(
                            Spinner::new(SharedString::from(format!("scene-pending-{id}")))
                                .size(14.),
                        )
                        .child(copy::APPLYING),
                )
            }
        }
        if row.follows == Some(true) {
            line = line.child(Badge::new(copy::FOLLOWS).variant(BadgeVariant::Outline));
        }
        // P461: each key, or why the OS refused it (Settings' words).
        let registered = self.hotkeys.registration().registered;
        for (index, (action, accelerator)) in row.keys.iter().enumerate() {
            let chip = div().id(SharedString::from(format!("scene-key-{id}-{index}")));
            let conflict = global_shortcut_conflict_reason(
                Some(accelerator.as_str()),
                platform,
                registered.get(action) == Some(&false),
            );
            line = line.child(match conflict {
                Some(reason) => chip.type_scale(text::META).text_color(muted).child(reason),
                None => chip.child(kbd_group(
                    accelerator_display_keys(Some(accelerator.as_str()), platform)
                        .into_iter()
                        .map(Kbd::new),
                )),
            });
        }
        line = line.child(
            KebabMenu::new(
                SharedString::from(format!("scene-actions-{id}")),
                self.menu_items(row, read_only, cx),
            )
            .label(copy::actions_for(&row.name))
            .reveal(KebabReveal::Hover),
        );
        if row.on_stream {
            line = line.status_icon(
                div()
                    .id(SharedString::from(format!("scene-on-stream-{id}")))
                    .tooltip(tooltip(copy::ON_STREAM))
                    .child(icon(IconName::Check, 16., ink)),
            );
        }
        if !row.disabled {
            let apply = id.clone();
            let needs_sources = row.meta == RowMeta::Text(copy::RESOLVE_SOURCES.to_string());
            line = line.on_click(cx.listener(move |this, _, window, cx| {
                this.select_scene(&apply, needs_sources, window, cx)
            }));
        }

        let index = row.index;
        let count = self.model.list.rows.len();
        let mut host = div()
            .id(SharedString::from(format!("scene-row-{id}")))
            .group(KEBAB_HOST)
            .child(line);
        if let Some(reason) = row.disabled_reason.clone() {
            host = host.tooltip(tooltip(reason));
        }
        if !read_only {
            let moved = id.clone();
            host = host.on_key_down(cx.listener(move |this, event: &KeyDownEvent, _, cx| {
                let Some(step) = move_step(event) else {
                    return;
                };
                let target = index as isize + step;
                if target < 0 || target as usize >= count {
                    return;
                }
                cx.stop_propagation();
                this.move_scene(&moved, target as usize);
            }));
        }
        host.into_any_element()
    }

    /// The ⋯ menu (`dialogs.menuItems`): edit, keeps, copy, then Delete.
    /// Change screen…, Set key… and Guests in the room… join with the
    /// picker and their dialogs.
    fn menu_items(
        &mut self,
        row: &SceneRow,
        read_only: bool,
        cx: &mut Context<Self>,
    ) -> Vec<KebabMenuItem> {
        let page = cx.entity().downgrade();
        let mut items = Vec::new();
        let read_only_reason = read_only.then_some(copy::READ_ONLY_REASON);

        let (rename_id, rename_name) = (row.id.clone(), row.name.clone());
        let rename_page = page.clone();
        let mut rename = KebabMenuItem::new("rename", copy::RENAME, move |window, cx| {
            let _ = rename_page.update(cx, |page, cx| {
                page.open_rename(&rename_id, &rename_name, window, cx)
            });
        })
        .group("edit");
        if let Some(reason) = read_only_reason {
            rename = rename.disabled(true).disabled_reason(reason);
        }
        items.push(rename);

        let change_id = row.id.clone();
        let change_page = page.clone();
        let mut change =
            KebabMenuItem::new("change-screen", copy::CHANGE_SCREEN, move |window, cx| {
                let _ = change_page.update(cx, |page, cx| {
                    page.open_change_screen(&change_id, None, window, cx)
                });
            })
            .group("edit");
        if let Some(reason) = read_only_reason
            .map(str::to_string)
            .or_else(|| row.change_screen_reason.clone())
        {
            change = change.disabled(true).disabled_reason(reason);
        }
        items.push(change);

        // Set key… is never off, even read-only.
        let (key_id, key_name) = (row.id.clone(), row.name.clone());
        let key_page = page.clone();
        items.push(
            KebabMenuItem::new(
                "set-key",
                super::dialogs::SET_KEY_LABEL,
                move |window, cx| {
                    let _ = key_page.update(cx, |page, cx| {
                        page.open_set_key(&key_id, &key_name, window, cx)
                    });
                },
            )
            .group("edit"),
        );

        if let Some(follows) = row.follows {
            let follow_id = row.id.clone();
            let follow_page = page.clone();
            let mut follow = KebabMenuItem::new(
                "follow",
                if follows {
                    copy::STOP_FOLLOWING
                } else {
                    copy::FOLLOW_THE_APP
                },
                move |_, cx| {
                    let _ =
                        follow_page.update(cx, |page, _| page.set_follows(&follow_id, !follows));
                },
            )
            .group("keeps");
            if let Some(reason) = read_only_reason {
                follow = follow.disabled(true).disabled_reason(reason);
            }
            items.push(follow);
        }

        let audio_id = row.id.clone();
        let audio_page = page.clone();
        let mut save_audio = KebabMenuItem::new("save-audio", copy::SAVE_AUDIO, move |_, cx| {
            let _ = audio_page.update(cx, |page, _| page.save_audio(&audio_id));
        })
        .group("keeps");
        if let Some(reason) = read_only_reason.or(row.save_audio_reason) {
            save_audio = save_audio.disabled(true).disabled_reason(reason);
        }
        items.push(save_audio);

        let guests_id = row.id.clone();
        let guests_page = page.clone();
        let mut guests =
            KebabMenuItem::new("guests", super::dialogs::GUESTS_LABEL, move |window, cx| {
                let _ = guests_page.update(cx, |page, cx| page.open_guests(&guests_id, window, cx));
            })
            .group("keeps");
        if let Some(reason) = read_only_reason {
            guests = guests.disabled(true).disabled_reason(reason);
        }
        items.push(guests);

        let duplicate_id = row.id.clone();
        let duplicate_page = page.clone();
        let mut duplicate = KebabMenuItem::new("duplicate", copy::DUPLICATE, move |_, cx| {
            let _ = duplicate_page.update(cx, |page, _| page.duplicate(&duplicate_id));
        })
        .group("copy");
        if let Some(reason) = read_only_reason {
            duplicate = duplicate.disabled(true).disabled_reason(reason);
        }
        items.push(duplicate);

        let (delete_id, delete_name, next) = (
            row.id.clone(),
            row.name.clone(),
            row.delete_switch_to.clone(),
        );
        let delete_page = page;
        let mut delete = KebabMenuItem::new("delete", copy::DELETE, move |window, cx| {
            let _ = delete_page.update(cx, |page, cx| {
                page.open_delete(&delete_id, &delete_name, next.clone(), window, cx)
            });
        })
        .destructive(true);
        let refused = match &row.delete {
            DeleteRule::Allowed { .. } => None,
            DeleteRule::Refused(reason) => Some(reason.unwrap_or_default()),
        };
        if let Some(reason) = read_only_reason.or(refused) {
            delete = delete.disabled(true);
            if !reason.is_empty() {
                delete = delete.disabled_reason(reason);
            }
        }
        items.push(delete);
        items
    }

    /// A row click (`dialogs.select`): a scene that needs sources opens
    /// Resolve scene sources; any other goes on stream, and a failure with
    /// no words of its own opens Resolve with its line (never for an app
    /// scene, whose window is found when it goes on).
    fn select_scene(
        &mut self,
        id: &str,
        needs_sources: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(scene) = self
            .studio
            .watch()
            .borrow()
            .scenes
            .scenes
            .iter()
            .find(|scene| scene.id == id)
            .cloned()
        else {
            return;
        };
        if needs_sources {
            self.open_resolve_for(&scene.id, false, window, cx);
            return;
        }
        let studio = self.studio.clone();
        let applied = scene.id.clone();
        let (done, answer) = tokio::sync::oneshot::channel();
        self.run(async move {
            let result = studio
                .apply_saved_scene(&applied, None, Default::default())
                .await;
            let _ = done.send(!result.ok && result.message.is_none() && !result.superseded);
        });
        cx.spawn_in(window, async move |this, cx| {
            let failed = answer.await.unwrap_or(false);
            if failed && scene.app().is_none() {
                let _ = this.update_in(cx, |page, window, cx| {
                    page.open_resolve_for(&scene.id, true, window, cx)
                });
            }
        })
        .detach();
    }

    fn move_scene(&self, id: &str, to_index: usize) {
        let studio = self.studio.clone();
        let id = id.to_string();
        self.run(async move {
            let moved = studio.move_scene(&id, to_index).await;
            eprintln!("[videorc-app] Scene move: {moved}");
        });
    }

    /// Follow the app / Stop following (`sceneWithFollow`).
    fn set_follows(&self, id: &str, follows: bool) {
        let studio = self.studio.clone();
        let Some(scene) = studio
            .watch()
            .borrow()
            .scenes
            .scenes
            .iter()
            .find(|scene| scene.id == id)
            .cloned()
        else {
            return;
        };
        self.run(async move {
            let next = scene_with_follow(&scene, follows, &now_iso());
            let saved = studio.replace_listed_scene(&next).await;
            eprintln!("[videorc-app] Scene follow: {saved}");
        });
    }

    /// Save audio to scene (`sceneWithAudio` with the working audio).
    fn save_audio(&self, id: &str) {
        let studio = self.studio.clone();
        let (scene, working) = {
            let snapshot = studio.watch().borrow().clone();
            let capture = &snapshot.settings.capture_doc;
            let working = scene_audio(
                &capture["sources"],
                capture["audio"]["systemAudioEnabled"] == Value::Bool(true),
            );
            let scene = snapshot
                .scenes
                .scenes
                .iter()
                .find(|scene| scene.id == id)
                .cloned();
            (scene, working)
        };
        let Some(scene) = scene else {
            return;
        };
        self.run(async move {
            let next = scene_with_audio(&scene, working, &now_iso());
            let saved = studio.replace_listed_scene(&next).await;
            eprintln!("[videorc-app] Scene save audio: {saved}");
        });
    }

    /// Duplicate: a deep copy named "{name} 2", at the end of the list,
    /// without its custom key.
    fn duplicate(&self, id: &str) {
        let studio = self.studio.clone();
        let copy = {
            let snapshot = studio.watch().borrow().clone();
            snapshot.scenes.library.as_ref().and_then(|library| {
                library
                    .scenes
                    .iter()
                    .find(|scene| scene.id == id)
                    .map(|stored| {
                        duplicated_scene(
                            stored,
                            &library.scenes,
                            &uuid::Uuid::new_v4().to_string(),
                            &now_iso(),
                        )
                    })
            })
        };
        let Some(copy) = copy else {
            return;
        };
        self.run(async move {
            let added = studio.insert_scenes(&[copy], None, &HashMap::new()).await;
            eprintln!("[videorc-app] Scene duplicate: {added}");
        });
    }
}
