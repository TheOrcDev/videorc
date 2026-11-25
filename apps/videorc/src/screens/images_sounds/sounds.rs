//! Sounds ⇧⌘S: the soundboard's sounds.

use std::sync::Arc;

use gpui::{Context, SharedString, Window, div, prelude::*, px};
use serde_json::json;
use videorc_app_core::protocol::{Sound, SoundMode, SoundboardState};
use videorc_app_core::soundboard::{self, ImportPhase};
use videorc_app_core::studio::StudioBackend;
use videorc_app_core::{BackendClient, Studio};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle, DialogSize};
use videorc_kit::empty::Empty;
use videorc_kit::input::{Input, InputState};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::scroll_area::ScrollArea;
use videorc_kit::select::Select;
use videorc_kit::theme::{self, FONT, TypeScale, hsla};
use videorc_kit::tokens::{size, text};

pub type AppStudio = Studio<BackendClient>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BoardState {
    Loading,
    Ready,
    Failed,
}

pub struct SoundsPanel {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    connected: bool,
    board: Option<SoundboardState>,
    board_state: BoardState,
    playing: std::collections::BTreeSet<String>,
    import_phase: ImportPhase,
    restoring: bool,
    load_epoch: u64,
    load_failures: usize,
    rename: DialogHandle,
    rename_id: Option<String>,
    rename_input: gpui::Entity<InputState>,
}

impl SoundsPanel {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let studio_watch = studio.clone();
        cx.spawn(async move |this, cx| {
            let mut studio_rx = studio_watch.watch();
            loop {
                if studio_rx.changed().await.is_err() {
                    break;
                }
                let _ = this.update(cx, |panel, cx| panel.rebuild(cx));
            }
        })
        .detach();
        let rename_input = cx.new(|cx| InputState::new(window, cx));
        let mut panel = Self {
            studio,
            runtime,
            connected: false,
            board: None,
            board_state: BoardState::Loading,
            playing: std::collections::BTreeSet::new(),
            import_phase: ImportPhase::Idle,
            restoring: false,
            load_epoch: 0,
            load_failures: 0,
            rename: DialogHandle::new(false),
            rename_id: None,
            rename_input,
        };
        panel.rebuild(cx);
        panel.refresh(cx);
        panel
    }

    fn rebuild(&mut self, cx: &mut Context<Self>) {
        let connected = self.studio.is_connected();
        let was = self.connected;
        if self.connected != connected {
            self.connected = connected;
            if connected && !was {
                self.load_failures = 0;
                self.refresh(cx);
            }
            if !connected {
                self.board_state = BoardState::Loading;
            }
            cx.notify();
        }
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        if !self.connected {
            return;
        }
        self.load_epoch = self.load_epoch.wrapping_add(1);
        let epoch = self.load_epoch;
        self.board_state = BoardState::Loading;
        cx.notify();

        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let result = runtime
                .spawn(async move { studio.backend().sounds_list().await })
                .await;
            let _ = this.update(cx, |panel, cx| {
                if panel.load_epoch != epoch {
                    return;
                }
                match result {
                    Ok(Ok(board)) => {
                        panel.board = Some(board);
                        panel.board_state = BoardState::Ready;
                        panel.load_failures = 0;
                    }
                    _ => {
                        panel.load_failures = panel.load_failures.saturating_add(1);
                        panel.board_state = if panel.load_failures >= 3 {
                            BoardState::Failed
                        } else {
                            BoardState::Loading
                        };
                        if panel.board_state == BoardState::Loading {
                            panel.schedule_retry(cx);
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn schedule_retry(&mut self, cx: &mut Context<Self>) {
        let waits = [3_000u64, 6_000, 15_000];
        let wait = waits
            .get(self.load_failures.saturating_sub(1))
            .copied()
            .unwrap_or(15_000);
        let epoch = self.load_epoch;
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(wait))
                .await;
            let _ = this.update(cx, |panel, cx| {
                if panel.load_epoch == epoch && panel.board_state == BoardState::Loading {
                    panel.refresh(cx);
                }
            });
        })
        .detach();
    }

    fn sounds(&self) -> &[Sound] {
        self.board
            .as_ref()
            .map(|b| b.sounds.as_slice())
            .unwrap_or(&[])
    }

    fn play_or_stop(&mut self, id: String, cx: &mut Context<Self>) {
        let stop = self.playing.contains(&id);
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        if stop {
            self.playing.remove(&id);
        } else {
            self.playing.insert(id.clone());
        }
        cx.notify();
        let method = if stop { "sounds.stop" } else { "sounds.play" };
        runtime.spawn(async move {
            let _ = studio
                .backend()
                .sounds_request(method, json!({ "id": id }))
                .await;
        });
    }

    fn update_sound(&self, id: String, patch: serde_json::Value) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let mut params = patch;
            if let Some(obj) = params.as_object_mut() {
                obj.insert("id".into(), json!(id));
            }
            let _ = studio
                .backend()
                .sounds_request("sounds.update", params)
                .await;
            let _ = studio.backend().sounds_list().await;
        });
    }

    fn move_sound(&mut self, id: String, target: usize, cx: &mut Context<Self>) {
        let ids: Vec<String> = self.sounds().iter().map(|s| s.id.clone()).collect();
        let Some(order) = soundboard::order_after_move(&ids, &id, target) else {
            return;
        };
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let _ = runtime
                .spawn(async move {
                    let _ = studio
                        .backend()
                        .sounds_request("sounds.reorder", json!({ "ids": order }))
                        .await;
                    studio.backend().sounds_list().await.ok()
                })
                .await;
            let _ = this.update(cx, |panel, cx| panel.refresh(cx));
        })
        .detach();
    }

    fn remove_sound(&mut self, id: String, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let _ = runtime
                .spawn(async move {
                    let _ = studio
                        .backend()
                        .sounds_request("sounds.delete", json!({ "id": id }))
                        .await;
                })
                .await;
            let _ = this.update(cx, |panel, cx| panel.refresh(cx));
        })
        .detach();
    }

    fn open_rename(&mut self, sound: &Sound, window: &mut Window, cx: &mut Context<Self>) {
        self.rename_id = Some(sound.id.clone());
        self.rename_input.update(cx, |input, cx| {
            input.set_value(sound.name.clone(), window, cx);
        });
        self.rename.open(window, cx);
    }

    fn save_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.rename_id.clone() else {
            return;
        };
        let name = self.rename_input.read(cx).value().trim().to_string();
        if name.is_empty() {
            return;
        }
        self.rename.close(window, cx);
        self.rename_id = None;
        self.update_sound(id, json!({ "name": name }));
        self.refresh(cx);
    }
}

impl Render for SoundsPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current(window, cx).theme();
        let offline = !self.connected;
        let sounds = self.sounds().to_vec();
        let loaded = self.board_state == BoardState::Ready;
        let import_reason =
            soundboard::import_blocked_reason(offline, self.import_phase, sounds.len());
        let entity = cx.entity();
        let description =
            soundboard::section_description(if loaded { Some(sounds.len()) } else { None });

        let import_button = |id: &'static str, reason: Option<&'static str>, phase: ImportPhase| {
            Button::new(id)
                .label(soundboard::import_label(phase))
                .variant(ButtonVariant::Outline)
                .disabled(reason.is_some())
        };

        let mut notices = div().flex().flex_col().gap(px(8.));
        if offline {
            notices = notices.child(
                Alert::new("sounds-offline")
                    .variant(AlertVariant::Locked)
                    .title(soundboard::OFFLINE_LOCK),
            );
        }

        let mut section = PanelSection::new("sounds-section")
            .title(soundboard::SECTION)
            .description(description)
            .last(true)
            .action(import_button(
                "sound-import",
                import_reason,
                self.import_phase,
            ));

        if !sounds.is_empty() {
            let mut list = GroupedList::new().label(soundboard::SECTION);
            for (index, sound) in sounds.iter().enumerate() {
                let playing = self.playing.contains(&sound.id);
                let id = sound.id.clone();
                let first = index == 0;
                let last = index + 1 == sounds.len();
                let pad = soundboard::pad_label(&sound.name, playing);
                let duration = soundboard::format_duration(sound.duration_ms);
                let mode = sound.mode;
                let hotkey = sound.hotkey.clone().unwrap_or_else(|| "none".into());
                let name = sound.name.clone();

                let mut mode_select = Select::new(format!("sound-mode-{}", sound.id))
                    .accessibility_label(format!("How {name} plays"))
                    .disabled(offline)
                    .width(112.)
                    .value(Some(SharedString::from(mode_value(mode))));
                for m in soundboard::modes() {
                    mode_select = mode_select.option(mode_value(*m), soundboard::mode_label(*m));
                }
                mode_select = mode_select.on_change({
                    let entity = entity.clone();
                    let id = id.clone();
                    move |value, _, cx| {
                        if let Some(mode) = parse_mode(value.as_ref()) {
                            entity.update(cx, |panel, _| {
                                panel.update_sound(id.clone(), json!({ "mode": mode_wire(mode) }));
                            });
                        }
                    }
                });

                let mut key_select = Select::new(format!("sound-key-{}", sound.id))
                    .accessibility_label(format!("{name} key"))
                    .disabled(offline)
                    .width(80.)
                    .value(Some(SharedString::from(hotkey.clone())))
                    .option("none", soundboard::NO_KEY);
                for key in soundboard::SOUND_HOTKEYS {
                    key_select = key_select.option(key, key);
                }
                key_select = key_select.on_change({
                    let entity = entity.clone();
                    let id = id.clone();
                    move |value, _, cx| {
                        let hotkey = if value.as_ref() == "none" {
                            ""
                        } else {
                            value.as_ref()
                        };
                        entity.update(cx, |panel, _| {
                            panel.update_sound(id.clone(), json!({ "hotkey": hotkey }));
                        });
                    }
                });

                let row = ListRow::new(format!("sound-{}", sound.id), sound.name.clone())
                    .context(duration)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .child(
                                Button::new(format!("sound-play-{}", sound.id))
                                    .label(if playing { "Stop" } else { "Play" })
                                    .size(ButtonSize::Xs)
                                    .variant(ButtonVariant::Ghost)
                                    .disabled(offline)
                                    .tooltip(pad)
                                    .on_click({
                                        let entity = entity.clone();
                                        let id = id.clone();
                                        move |_, _, cx| {
                                            entity.update(cx, |panel, cx| {
                                                panel.play_or_stop(id.clone(), cx)
                                            })
                                        }
                                    }),
                            )
                            .child(mode_select)
                            .child(
                                div()
                                    .w(px(56.))
                                    .type_scale(text::META)
                                    .text_color(hsla(t.muted_foreground))
                                    .child(format!("{:+} dB", sound.volume_db)),
                            )
                            .child(key_select)
                            .child(
                                Button::new(format!("sound-rename-{}", sound.id))
                                    .label(soundboard::RENAME_ELLIPSIS)
                                    .size(ButtonSize::Xs)
                                    .variant(ButtonVariant::Ghost)
                                    .disabled(offline)
                                    .on_click({
                                        let entity = entity.clone();
                                        let sound = sound.clone();
                                        move |_, window, cx| {
                                            entity.update(cx, |panel, cx| {
                                                panel.open_rename(&sound, window, cx)
                                            })
                                        }
                                    }),
                            )
                            .child(
                                Button::new(format!("sound-up-{}", sound.id))
                                    .label(soundboard::MOVE_UP)
                                    .size(ButtonSize::Xs)
                                    .variant(ButtonVariant::Ghost)
                                    .disabled(offline || first)
                                    .on_click({
                                        let entity = entity.clone();
                                        let id = id.clone();
                                        let target = index.saturating_sub(1);
                                        move |_, _, cx| {
                                            entity.update(cx, |panel, cx| {
                                                panel.move_sound(id.clone(), target, cx)
                                            })
                                        }
                                    }),
                            )
                            .child(
                                Button::new(format!("sound-down-{}", sound.id))
                                    .label(soundboard::MOVE_DOWN)
                                    .size(ButtonSize::Xs)
                                    .variant(ButtonVariant::Ghost)
                                    .disabled(offline || last)
                                    .on_click({
                                        let entity = entity.clone();
                                        let id = id.clone();
                                        let target = index + 1;
                                        move |_, _, cx| {
                                            entity.update(cx, |panel, cx| {
                                                panel.move_sound(id.clone(), target, cx)
                                            })
                                        }
                                    }),
                            )
                            .child(
                                Button::new(format!("sound-remove-{}", sound.id))
                                    .label(soundboard::REMOVE)
                                    .size(ButtonSize::Xs)
                                    .variant(ButtonVariant::Ghost)
                                    .disabled(offline)
                                    .on_click({
                                        let entity = entity.clone();
                                        let id = id.clone();
                                        move |_, _, cx| {
                                            entity.update(cx, |panel, cx| {
                                                panel.remove_sound(id.clone(), cx)
                                            })
                                        }
                                    }),
                            ),
                    );
                list = list.item(row);
            }
            section = section.child(list);
        } else if !loaded {
            if !offline {
                match self.board_state {
                    BoardState::Failed => {
                        section = section.child(
                            Empty::new().title(soundboard::LOAD_FAILED).child(
                                Button::new("sounds-retry")
                                    .label(soundboard::RETRY)
                                    .variant(ButtonVariant::Outline)
                                    .on_click({
                                        let entity = entity.clone();
                                        move |_, _, cx| {
                                            entity.update(cx, |panel, cx| {
                                                panel.load_failures = 0;
                                                panel.refresh(cx);
                                            })
                                        }
                                    }),
                            ),
                        );
                    }
                    _ => {
                        section = section.child(Empty::new().title(soundboard::LOADING));
                    }
                }
            }
        } else {
            section = section.child(Empty::new().title(soundboard::NO_SOUNDS).child(
                import_button("sound-import-empty", import_reason, self.import_phase),
            ));
        }

        // Starter restore shows when the board is known; without a starters
        // manifest in app-core yet, offer it whenever the board is empty after
        // a successful load (Electron shows it when starters are missing).
        if loaded && sounds.is_empty() {
            section = section.child(
                Button::new("sound-restore-starters")
                    .label(if self.restoring {
                        soundboard::RESTORING
                    } else {
                        soundboard::RESTORE_STARTERS
                    })
                    .variant(ButtonVariant::Ghost)
                    .disabled(offline || self.restoring),
            );
        }

        let rename_dialog = Dialog::new("sound-rename", &self.rename, soundboard::RENAME_TITLE)
            .size(DialogSize::Sm)
            .child(
                Input::new("sound-rename-name", &self.rename_input)
                    .accessibility_label(soundboard::NAME),
            )
            .footer(
                Button::new("sound-rename-cancel")
                    .label(soundboard::CANCEL)
                    .variant(ButtonVariant::Ghost)
                    .on_click({
                        let entity = entity.clone();
                        move |_, window, cx| {
                            entity.update(cx, |panel, cx| panel.rename.close(window, cx))
                        }
                    }),
            )
            .footer(
                Button::new("sound-rename-save")
                    .label(soundboard::SAVE)
                    .on_click({
                        let entity = entity.clone();
                        move |_, window, cx| {
                            entity.update(cx, |panel, cx| panel.save_rename(window, cx))
                        }
                    }),
            );

        div()
            .id("sounds-page")
            .flex()
            .flex_col()
            .size_full()
            .min_h(px(0.))
            .font_family(FONT)
            .bg(hsla(t.glass_solid))
            .text_color(hsla(t.foreground))
            .type_scale(text::META)
            .child(
                ScrollArea::new("sounds-scroll").child(
                    div()
                        .flex()
                        .flex_col()
                        .px(px(size::GUTTER))
                        .py(px(8.))
                        .gap(px(16.))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(4.))
                                .child(
                                    div()
                                        .type_scale(text::SECTION)
                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                        .child(soundboard::TITLE),
                                )
                                .child(
                                    div()
                                        .type_scale(text::META)
                                        .text_color(hsla(t.muted_foreground))
                                        .child(soundboard::PAGE_DESCRIPTION),
                                ),
                        )
                        .child(notices)
                        .child(section),
                ),
            )
            .child(rename_dialog)
    }
}

fn mode_value(mode: SoundMode) -> &'static str {
    match mode {
        SoundMode::OneShot => "oneShot",
        SoundMode::Toggle => "toggle",
        SoundMode::Loop => "loop",
        SoundMode::Hold => "hold",
    }
}

fn mode_wire(mode: SoundMode) -> &'static str {
    mode_value(mode)
}

fn parse_mode(value: &str) -> Option<SoundMode> {
    match value {
        "oneShot" => Some(SoundMode::OneShot),
        "toggle" => Some(SoundMode::Toggle),
        "loop" => Some(SoundMode::Loop),
        "hold" => Some(SoundMode::Hold),
        _ => None,
    }
}
