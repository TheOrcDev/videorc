//! Sounds ⇧⌘S: the soundboard's sounds.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Arc;

use gpui::{Context, Entity, PathPromptOptions, SharedString, Window, div, prelude::*, px};
use serde_json::json;
use tokio::sync::watch;
use videorc_app_core::protocol::{Sound, SoundMode, SoundboardState};
use videorc_app_core::resources::{
    capability::{IssueOptions, ResourceKind},
    issue_capability,
};
use videorc_app_core::soundboard::starters::{
    RESTORE_TOAST_ID, STARTER_IMPORT_FAILED, StarterImportOutcome, StarterRow, is_offline_message,
    limit_refusal, read_starter_rows, starter_import_params,
};
use videorc_app_core::soundboard::{self, ImportPhase, SOUND_VOLUME_DB_MAX, SOUND_VOLUME_DB_MIN};
use videorc_app_core::studio::StudioBackend;
use videorc_app_core::studio::audio_mixer::format_db;
use videorc_app_core::user_error::{
    Failure, OFFLINE_REASON, UserErrorContext, toast_offline, toast_user_error,
};
use videorc_app_core::{BackendClient, BackendState, Studio};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle, DialogSize};
use videorc_kit::empty::Empty;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::input::{Input, InputState};
use videorc_kit::kebab_menu::{KEBAB_HOST, KebabMenu, KebabMenuItem, KebabReveal};
use videorc_kit::list_row::{GroupedList, GroupedRow, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::scroll_area::ScrollArea;
use videorc_kit::select::Select;
use videorc_kit::slider::{Slider, SliderEvent, SliderState};
use videorc_kit::spinner::Spinner;
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
    backend: watch::Receiver<BackendState>,
    connected: bool,
    board: Option<SoundboardState>,
    board_state: BoardState,
    playing: std::collections::BTreeSet<String>,
    import_phase: ImportPhase,
    restoring: bool,
    /// The starter sounds the app ships (`sounds/starter`), read once.
    starters: Vec<(StarterRow, PathBuf)>,
    /// The once-per-profile seeding ran (or is running) on this connection.
    seed_tried: bool,
    load_epoch: u64,
    load_failures: usize,
    rename: DialogHandle,
    rename_id: Option<String>,
    rename_input: Entity<InputState>,
    /// Per-sound volume faders (P1312).
    volume: BTreeMap<String, Entity<SliderState>>,
    /// Sound id whose fader is mid-drag; skip sync from board while set.
    volume_live: Option<String>,
}

impl SoundsPanel {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        backend: watch::Receiver<BackendState>,
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
            backend,
            connected: false,
            board: None,
            board_state: BoardState::Loading,
            playing: std::collections::BTreeSet::new(),
            import_phase: ImportPhase::Idle,
            restoring: false,
            starters: {
                let (rows, refused) =
                    read_starter_rows(&videorc_app_core::bundled::current().starter_sounds);
                for line in refused {
                    eprintln!("[videorc-app] starter sounds: {line}");
                }
                rows
            },
            seed_tried: false,
            load_epoch: 0,
            load_failures: 0,
            rename: DialogHandle::new(false),
            rename_id: None,
            rename_input,
            volume: BTreeMap::new(),
            volume_live: None,
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
                self.seed_tried = false;
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
                        panel.seed_starters(cx);
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

    /// The shipped starters the board doesn't have (`missingStarterSlugs`),
    /// with their files, in manifest order.
    fn missing_starters(&self) -> Vec<(StarterRow, PathBuf)> {
        let have: BTreeSet<&str> = self
            .sounds()
            .iter()
            .filter_map(|sound| sound.starter.as_deref())
            .collect();
        self.starters
            .iter()
            .filter(|(row, _)| !have.contains(row.slug.as_str()))
            .cloned()
            .collect()
    }

    /// The keys the board's sounds already have.
    fn taken_hotkeys(&self) -> BTreeSet<String> {
        self.sounds()
            .iter()
            .filter_map(|sound| sound.hotkey.clone())
            .collect()
    }

    /// `seedStarterSounds`: once per profile, quietly (nothing toasts at
    /// first launch), the starters are imported and the board marked seeded.
    /// A run cut short by the connection, or a build without the starter
    /// files, marks nothing and tries again on the next connection.
    fn seed_starters(&mut self, cx: &mut Context<Self>) {
        let seeded = self
            .board
            .as_ref()
            .is_none_or(|board| board.starters_seeded);
        if seeded || self.seed_tried || self.starters.is_empty() {
            return;
        }
        self.seed_tried = true;
        let files = self.missing_starters();
        let taken = self.taken_hotkeys();
        let studio = self.studio.clone();
        let backend = self.backend.clone();
        let job = self.runtime.spawn(async move {
            let outcome = import_starters(&studio, &backend, files, taken).await;
            if outcome.offline {
                return false;
            }
            studio
                .backend()
                .sounds_request("sounds.settings", json!({ "startersSeeded": true }))
                .await
                .is_ok()
        });
        cx.spawn(async move |this, cx| {
            let _ = job.await;
            let _ = this.update(cx, |panel, cx| panel.refresh(cx));
        })
        .detach();
    }

    /// Restore starter sounds (`restoreStarters`): the starters the board
    /// no longer has. A limit refusal, a lost connection or a failed import
    /// says so in the one restore toast.
    fn restore_starters(&mut self, cx: &mut Context<Self>) {
        if self.restoring || !self.connected {
            return;
        }
        let files = self.missing_starters();
        if files.is_empty() {
            return;
        }
        self.restoring = true;
        cx.notify();
        let taken = self.taken_hotkeys();
        let studio = self.studio.clone();
        let backend = self.backend.clone();
        let job = self
            .runtime
            .spawn(async move { import_starters(&studio, &backend, files, taken).await });
        cx.spawn(async move |this, cx| {
            let outcome = job.await.unwrap_or_default();
            let _ = this.update(cx, |panel, cx| {
                panel.restoring = false;
                let context = UserErrorContext {
                    action: "restore",
                    object: "the starter sounds",
                };
                let notice = if let Some(refusal) = outcome.refusal.as_deref() {
                    toast_user_error(
                        Failure::Sentence {
                            text: refusal,
                            warning: true,
                        },
                        context,
                        RESTORE_TOAST_ID,
                    )
                } else if outcome.offline {
                    Some(toast_offline(context))
                } else if outcome.failed > 0 {
                    toast_user_error(
                        Failure::Sentence {
                            text: STARTER_IMPORT_FAILED,
                            warning: false,
                        },
                        context,
                        RESTORE_TOAST_ID,
                    )
                } else {
                    None
                };
                if let Some(notice) = notice {
                    panel.studio.post_notices(vec![notice]);
                }
                panel.refresh(cx);
                cx.notify();
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

    fn ensure_volume_sliders(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let sounds: Vec<(String, i32)> = self
            .sounds()
            .iter()
            .map(|sound| (sound.id.clone(), sound.volume_db))
            .collect();
        let ids: std::collections::BTreeSet<_> = sounds.iter().map(|(id, _)| id.clone()).collect();
        self.volume.retain(|id, _| ids.contains(id));
        for (id, volume_db) in sounds {
            if let Some(slider) = self.volume.get(&id) {
                if self.volume_live.as_ref() != Some(&id) {
                    let current = slider.read(cx).value().end().round() as i32;
                    if current != volume_db {
                        slider.update(cx, |state, cx| {
                            state.set_value(volume_db as f32, window, cx);
                        });
                    }
                }
                continue;
            }
            let slider = cx.new(|_| {
                SliderState::new()
                    .min(SOUND_VOLUME_DB_MIN as f32)
                    .max(SOUND_VOLUME_DB_MAX as f32)
                    .step(1.)
                    .default_value(volume_db as f32)
            });
            let sound_id = id.clone();
            cx.subscribe(&slider, move |this, _, event: &SliderEvent, cx| {
                let value = match event {
                    SliderEvent::Change(v) | SliderEvent::Release(v) => v.end().round() as i32,
                };
                this.volume_live = match event {
                    SliderEvent::Change(_) => Some(sound_id.clone()),
                    SliderEvent::Release(_) => None,
                };
                if matches!(event, SliderEvent::Release(_)) {
                    this.update_sound(sound_id.clone(), json!({ "volumeDb": value }));
                    if let Some(sound) = this.board.as_mut().and_then(|board| {
                        board.sounds.iter_mut().find(|sound| sound.id == sound_id)
                    }) {
                        sound.volume_db = value;
                    }
                }
                cx.notify();
            })
            .detach();
            self.volume.insert(id, slider);
        }
    }

    fn import_sounds(&mut self, cx: &mut Context<Self>) {
        if self.import_phase != ImportPhase::Idle
            || soundboard::import_blocked_reason(false, ImportPhase::Idle, self.sounds().len())
                .is_some()
        {
            return;
        }
        self.import_phase = ImportPhase::Choosing;
        cx.notify();
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some(soundboard::IMPORT.into()),
        });
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        let backend = self.backend.clone();
        cx.spawn(async move |this, cx| {
            let paths = match picked.await {
                Ok(Ok(Some(paths))) if !paths.is_empty() => paths,
                _ => {
                    let _ = this.update(cx, |panel, cx| {
                        panel.import_phase = ImportPhase::Idle;
                        cx.notify();
                    });
                    return;
                }
            };
            let _ = this.update(cx, |panel, cx| {
                panel.import_phase = ImportPhase::Importing;
                cx.notify();
            });
            let job = runtime.spawn(async move {
                let bootstrap = backend
                    .borrow()
                    .bootstrap()
                    .cloned()
                    .ok_or_else(|| "Videorc is reconnecting.".to_string())?;
                for path in paths {
                    let (_, issued) = issue_capability(
                        &bootstrap,
                        &path,
                        ResourceKind::InputFile,
                        IssueOptions::default(),
                    )
                    .await?;
                    let _ = studio
                        .backend()
                        .sounds_request(
                            "sounds.import",
                            json!({ "sourceCapability": issued.capability_id }),
                        )
                        .await
                        .map_err(|error| error.message)?;
                }
                Ok::<(), String>(())
            });
            let _ = job.await;
            let _ = this.update(cx, |panel, cx| {
                panel.import_phase = ImportPhase::Idle;
                panel.refresh(cx);
                cx.notify();
            });
        })
        .detach();
    }
}

impl Render for SoundsPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.ensure_volume_sliders(window, cx);
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
            let entity = entity.clone();
            let glyph = if phase == ImportPhase::Idle {
                icon(IconName::UploadSimple, 16., hsla(t.foreground)).into_any_element()
            } else {
                Spinner::new(SharedString::from(format!("{id}-spinner")))
                    .size(16.)
                    .into_any_element()
            };
            let mut button = Button::new(id)
                .variant(ButtonVariant::Outline)
                .disabled(reason.is_some())
                .child(glyph)
                .child(soundboard::import_label(phase));
            // `DisabledReason`: why it is off, on hover.
            if let Some(reason) = reason {
                button = button.tooltip(reason);
            }
            button.on_click(move |_, _, cx| {
                if reason.is_none() {
                    entity.update(cx, |panel, cx| panel.import_sounds(cx));
                }
            })
        };

        // `PanelSection` with its SpeakerOn mark; the offline alert leads
        // its content.
        let mut section = PanelSection::new("sounds-section")
            .icon(icon(IconName::SpeakerHigh, 16., hsla(t.muted_foreground)))
            .title(soundboard::SECTION)
            .description(description)
            .last(true)
            .action(import_button(
                "sound-import",
                import_reason,
                self.import_phase,
            ));
        if offline {
            section = section.child(
                Alert::new("sounds-offline")
                    .variant(AlertVariant::Locked)
                    .title(soundboard::OFFLINE_LOCK),
            );
        }

        if !sounds.is_empty() {
            // Electron names the list for assistive tech only (`aria-label`).
            let mut list = GroupedList::new();
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

                // `SoundRow`: play or stop at the start, the name and its
                // length, then how a press plays it, its volume, its key and
                // the rare actions in ⋯.
                let volume_db = self
                    .volume
                    .get(&sound.id)
                    .map(|slider| slider.read(cx).value().end().round() as i32)
                    .unwrap_or(sound.volume_db);
                let mut volume = div()
                    .flex_none()
                    .w(px(144.))
                    .flex()
                    .items_center()
                    .gap(px(8.));
                if let Some(slider) = self.volume.get(&sound.id) {
                    volume = volume.child(
                        div().flex_1().min_w(px(0.)).child(
                            Slider::new(slider)
                                .accessibility_label(format!("{} volume", sound.name))
                                .disabled(offline),
                        ),
                    );
                }
                let volume = volume.child(
                    div()
                        .flex_none()
                        // `w-[7ch] text-right font-mono text-xs`.
                        .w(px(52.))
                        .flex()
                        .justify_end()
                        .font_family(crate::lcd::SCREEN_FONT)
                        .text_size(px(12.))
                        .line_height(px(16.))
                        .font_weight(gpui::FontWeight::NORMAL)
                        .text_color(hsla(t.muted_foreground))
                        .child(format_db(volume_db as f32)),
                );

                let rename = KebabMenuItem::new("rename", soundboard::RENAME_ELLIPSIS, {
                    let entity = entity.clone();
                    let sound = sound.clone();
                    move |window, cx| {
                        entity.update(cx, |panel, cx| panel.open_rename(&sound, window, cx))
                    }
                })
                .group("edit");
                let mut move_up = KebabMenuItem::new("move-up", soundboard::MOVE_UP, {
                    let entity = entity.clone();
                    let id = id.clone();
                    let target = index.saturating_sub(1);
                    move |_, cx| {
                        entity.update(cx, |panel, cx| panel.move_sound(id.clone(), target, cx))
                    }
                })
                .group("order");
                if first {
                    move_up = move_up
                        .disabled(true)
                        .disabled_reason(soundboard::ALREADY_FIRST);
                }
                let mut move_down = KebabMenuItem::new("move-down", soundboard::MOVE_DOWN, {
                    let entity = entity.clone();
                    let id = id.clone();
                    let target = index + 1;
                    move |_, cx| {
                        entity.update(cx, |panel, cx| panel.move_sound(id.clone(), target, cx))
                    }
                })
                .group("order");
                if last {
                    move_down = move_down
                        .disabled(true)
                        .disabled_reason(soundboard::ALREADY_LAST);
                }
                let remove = KebabMenuItem::new("remove", soundboard::REMOVE, {
                    let entity = entity.clone();
                    let id = id.clone();
                    move |_, cx| entity.update(cx, |panel, cx| panel.remove_sound(id.clone(), cx))
                })
                .destructive(true)
                .group("remove");

                let row = ListRow::new(format!("sound-{}", sound.id), sound.name.clone())
                    .grouped()
                    .leading(
                        Button::new(format!("sound-play-{}", sound.id))
                            .size(ButtonSize::IconXs)
                            .variant(ButtonVariant::Ghost)
                            .disabled(offline)
                            .accessibility_label(pad.clone())
                            .tooltip(pad)
                            .child(icon(
                                if playing {
                                    IconName::StopFill
                                } else {
                                    IconName::Play
                                },
                                12.,
                                hsla(t.foreground),
                            ))
                            .on_click({
                                let entity = entity.clone();
                                let id = id.clone();
                                move |_, _, cx| {
                                    entity
                                        .update(cx, |panel, cx| panel.play_or_stop(id.clone(), cx))
                                }
                            }),
                    )
                    .context(duration)
                    .child(mode_select)
                    .child(volume)
                    .child(key_select)
                    .child(
                        KebabMenu::new(
                            SharedString::from(format!("sound-actions-{}", sound.id)),
                            vec![rename, move_up, move_down, remove],
                        )
                        .label(format!("Actions for {name}"))
                        .disabled(offline)
                        .reveal(KebabReveal::Hover),
                    );
                list = list.item(
                    div()
                        .id(SharedString::from(format!("sound-host-{}", sound.id)))
                        .group(KEBAB_HOST)
                        .child(row),
                );
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

        // Restore starter sounds shows while a shipped starter is missing
        // from the loaded board (`missingStarters.length > 0`).
        if loaded && !self.missing_starters().is_empty() {
            let glyph = if self.restoring {
                Spinner::new("sound-restore-spinner")
                    .size(16.)
                    .into_any_element()
            } else {
                icon(IconName::ArrowCounterClockwise, 16., hsla(t.foreground)).into_any_element()
            };
            let mut restore = Button::new("sound-restore-starters")
                .variant(ButtonVariant::Ghost)
                .disabled(offline || self.restoring)
                .child(glyph)
                .child(if self.restoring {
                    soundboard::RESTORING
                } else {
                    soundboard::RESTORE_STARTERS
                })
                .on_click({
                    let entity = entity.clone();
                    move |_, _, cx| entity.update(cx, |panel, cx| panel.restore_starters(cx))
                });
            // `DisabledReason`: why it is off, on hover.
            if offline {
                restore = restore.tooltip(OFFLINE_REASON);
            }
            section = section.child(div().flex().child(restore));
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
            // The title is the shell's toolbar band (#2206), not the page's.
            .child(
                div().flex_1().min_h(px(0.)).child(
                    ScrollArea::new("sounds-scroll").child(
                        div()
                            .flex()
                            .flex_col()
                            // `PageHeader`: `px-gutter pt-3 pb-1`, text-xs.
                            .child(
                                div()
                                    .px(px(size::GUTTER))
                                    .pt(px(12.))
                                    .pb(px(4.))
                                    .text_size(px(12.))
                                    .line_height(px(16.))
                                    .text_color(hsla(t.muted_foreground))
                                    .child(soundboard::PAGE_DESCRIPTION),
                            )
                            .child(section),
                    ),
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

/// `importStarterFiles`: the starters one after another (the backend's one
/// AssetImport lane). A key another sound already has is left off; a limit
/// refusal or a lost connection ends the run.
async fn import_starters(
    studio: &AppStudio,
    backend: &watch::Receiver<BackendState>,
    files: Vec<(StarterRow, PathBuf)>,
    mut taken: BTreeSet<String>,
) -> StarterImportOutcome {
    let mut outcome = StarterImportOutcome::default();
    for (row, path) in files {
        let bootstrap = backend.borrow().bootstrap().cloned();
        let Some(bootstrap) = bootstrap else {
            outcome.offline = true;
            return outcome;
        };
        let issued = match issue_capability(
            &bootstrap,
            &path,
            ResourceKind::InputFile,
            IssueOptions::default(),
        )
        .await
        {
            Ok((_, issued)) => issued,
            Err(message) => {
                if is_offline_message(&message) {
                    outcome.offline = true;
                    return outcome;
                }
                outcome.failed += 1;
                eprintln!(
                    "[videorc-app] the starter sound {} was not added: {message}",
                    row.slug
                );
                continue;
            }
        };
        let params = starter_import_params(&row, &issued.capability_id, &taken);
        match studio
            .backend()
            .sounds_request("sounds.import", params)
            .await
        {
            Ok(_) => {
                outcome.imported += 1;
                if let Some(hotkey) = &row.hotkey {
                    taken.insert(hotkey.clone());
                }
            }
            Err(error) => {
                if let Some(refusal) = limit_refusal(&error.message) {
                    outcome.refusal = Some(refusal.to_string());
                    return outcome;
                }
                if is_offline_message(&error.message) {
                    outcome.offline = true;
                    return outcome;
                }
                outcome.failed += 1;
                eprintln!(
                    "[videorc-app] the starter sound {} was not added: {}",
                    row.slug, error.message
                );
            }
        }
    }
    outcome
}
