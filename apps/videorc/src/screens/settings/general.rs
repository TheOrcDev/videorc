use super::*;
use gpui::{AnyElement, WindowAppearance};
use videorc_app_core::{
    nav::{PageId, ThemeChoice},
    studio::families,
};
use videorc_kit::{
    button::{Button, ButtonVariant},
    list_row::{GroupedList, ListRow},
    panel_section::PanelSection,
    switch::Switch,
};

impl SettingsScreen {
    fn studio_switch(
        &self,
        key: &'static str,
        label: &'static str,
        checked: bool,
        cx: &Context<Self>,
    ) -> Switch {
        let entity = cx.entity();
        Switch::new(key)
            .accessibility_label(label)
            .checked(checked)
            .disabled(self.disabled() || !self.studio.snapshot().settings.hydrated)
            .on_change(move |value, _, cx| {
                entity.update(cx, |this, cx| this.save_studio(key, value, cx))
            })
    }

    fn save_theme(&mut self, choice: ThemeChoice, cx: &mut Context<Self>) {
        if self.busy || !self.studio.snapshot().settings.hydrated {
            return;
        }
        self.busy = true;
        self.error = None;
        let studio = self.studio.clone();
        let job = self.runtime.spawn(async move {
            studio
                .write_settings(vec![families::write_theme(choice.as_str())])
                .await
                .is_ok()
        });
        self.finish_save(job, cx);
    }

    pub(super) fn general(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = theme::current(window, cx).theme();
        use view::copy as c;
        let snapshot = self.studio.snapshot();
        let settings = &snapshot.settings.studio;
        let model = view::general_view(&view::GeneralInput {
            platform: crate::app::hotkeys::node_platform(),
            theme: ThemeChoice::parse(snapshot.settings.theme.as_deref()),
            retro_lcd: settings.retro_lcd_studio(),
            studio_chat: settings.studio_chat(),
            open_stream_manager_on_live: settings.open_stream_manager_on_live(),
            stream_manager_enabled: true,
            chat: &self.chat,
            usage: &self.usage,
            session_active: snapshot.session.phase.is_active(),
            first_run_ported: false,
            account_name: None,
        });
        let entity = cx.entity();
        let theme = Tabs::new("settings-theme")
            .tab(c::THEME_LIGHT)
            .tab(c::THEME_DARK)
            .tab(c::THEME_SYSTEM)
            .selected(model.theme_index)
            .on_select(move |index, _, cx| {
                entity.update(cx, |this, cx| {
                    this.save_theme(
                        [ThemeChoice::Light, ThemeChoice::Dark, ThemeChoice::System][index],
                        cx,
                    )
                });
            });
        // Tabs have no group-wide disabled property. While hydration or a
        // write is pending, render all three segments disabled.
        let theme = if self.disabled() || !snapshot.settings.hydrated {
            Tabs::new("settings-theme")
                .disabled_tab(c::THEME_LIGHT)
                .disabled_tab(c::THEME_DARK)
                .disabled_tab(c::THEME_SYSTEM)
                .selected(model.theme_index)
        } else {
            theme
        };
        let appearance = PanelSection::new(c::APPEARANCE)
            .title(c::APPEARANCE)
            .description(c::APPEARANCE_DESCRIPTION)
            .child(
                GroupedList::new()
                    .item(
                        div()
                            .child(ListRow::new("theme-row", c::THEME).child(theme))
                            .child(
                                div()
                                    .px(px(12.))
                                    .pb(px(8.))
                                    .type_scale(text::META)
                                    .text_color(hsla(t.muted_foreground))
                                    .child(model.theme_description),
                            ),
                    )
                    .item(
                        div()
                            .child(ListRow::new("retro-row", c::RETRO_LCD).child(
                                self.studio_switch(
                                    "retroLcdStudio",
                                    c::RETRO_LCD,
                                    model.retro_lcd,
                                    cx,
                                ),
                            ))
                            .child(
                                div()
                                    .px(px(12.))
                                    .pb(px(8.))
                                    .type_scale(text::META)
                                    .text_color(hsla(t.muted_foreground))
                                    .child(c::RETRO_LCD_DESCRIPTION),
                            ),
                    )
                    .item(
                        ListRow::new("scene-link", c::ANIMATE_SCENE_CHANGES).child(
                            Button::new("open-scene")
                                .label(PageId::Layouts.label())
                                .disabled(!model.scene_ported)
                                .tooltip(view::NOT_IN_THIS_BUILD)
                                .variant(ButtonVariant::Outline)
                                .on_click(
                                    cx.listener(|_, _, _, cx| cx.emit(Navigate(PageId::Layouts))),
                                ),
                        ),
                    ),
            );
        let entity = cx.entity();
        let emotes = Switch::new("seven-tv")
            .accessibility_label(c::SEVEN_TV)
            .checked(model.seven_tv)
            .disabled(self.disabled() || !model.chat_loaded)
            .on_change(move |enabled, _, cx| {
                entity.update(cx, |this, cx| {
                    this.request(
                        "liveChat.emotes.set",
                        json!({"sevenTv":enabled}),
                        c::CHAT_SAVE_FAILED,
                        cx,
                    )
                });
            });
        let entity = cx.entity();
        let mut gifs = Tabs::new("twitch-gifs").selected(model.gif_index);
        for (_, label) in view::GIF_MODES {
            gifs = if self.disabled() || !model.chat_loaded {
                gifs.disabled_tab(label)
            } else {
                gifs.tab(label)
            };
        }
        let gifs = gifs.on_select(move |index, _, cx| {
            entity.update(cx, |this, cx| {
                this.request(
                    "liveChat.emotes.set",
                    json!({"twitchGifs":view::GIF_MODES[index].0}),
                    c::CHAT_SAVE_FAILED,
                    cx,
                )
            });
        });
        let chat = PanelSection::new(c::CHAT)
            .title(c::CHAT)
            .description(c::CHAT_DESCRIPTION)
            .children(
                model
                    .chat_error
                    .map(|error| videorc_kit::alert::Alert::new("chat-error").title(error)),
            )
            .child(
                GroupedList::new()
                    .item(
                        div()
                            .child(ListRow::new("emotes-row", c::SEVEN_TV).child(emotes))
                            .child(
                                div()
                                    .px(px(12.))
                                    .pb(px(8.))
                                    .type_scale(text::META)
                                    .text_color(hsla(t.muted_foreground))
                                    .child(c::SEVEN_TV_DESCRIPTION),
                            ),
                    )
                    .map(|group| {
                        (model
                            .seven_tv_line
                            .map(|line| ListRow::new("emote-status", line)))
                        .into_iter()
                        .fold(group, |group, row| group.item(row))
                    })
                    .item(
                        div()
                            .child(ListRow::new("gif-row", c::TWITCH_GIFS).child(gifs))
                            .child(
                                div()
                                    .px(px(12.))
                                    .pb(px(8.))
                                    .type_scale(text::META)
                                    .text_color(hsla(t.muted_foreground))
                                    .child(c::TWITCH_GIFS_DESCRIPTION),
                            ),
                    )
                    .item(
                        div()
                            .child(ListRow::new("studio-chat-row", c::CHAT_IN_STUDIO).child(
                                self.studio_switch(
                                    "studioChat",
                                    c::CHAT_IN_STUDIO,
                                    model.studio_chat,
                                    cx,
                                ),
                            ))
                            .child(
                                div()
                                    .px(px(12.))
                                    .pb(px(8.))
                                    .type_scale(text::META)
                                    .text_color(hsla(t.muted_foreground))
                                    .child(c::CHAT_IN_STUDIO_DESCRIPTION),
                            ),
                    )
                    .item(
                        div()
                            .child(
                                ListRow::new("stream-manager-row", c::OPEN_STREAM_MANAGER).child(
                                    self.studio_switch(
                                        "openStreamManagerOnLive",
                                        c::OPEN_STREAM_MANAGER,
                                        model.open_stream_manager_on_live,
                                        cx,
                                    ),
                                ),
                            )
                            .child(
                                div()
                                    .px(px(12.))
                                    .pb(px(8.))
                                    .type_scale(text::META)
                                    .text_color(hsla(t.muted_foreground))
                                    .child(c::OPEN_STREAM_MANAGER_DESCRIPTION),
                            ),
                    ),
            );
        let entity = cx.entity();
        let usage = Switch::new("usage-stats")
            .accessibility_label(c::USAGE_STATS)
            .checked(model.usage_enabled)
            .disabled(self.disabled() || !model.usage_loaded || model.usage_env_disabled)
            .on_change(move |enabled, _, cx| {
                entity.update(cx, |this, cx| {
                    this.request(
                        "usageStats.set",
                        json!({"enabled":enabled}),
                        c::USAGE_SAVE_FAILED,
                        cx,
                    )
                });
            });
        let privacy = PanelSection::new(c::PRIVACY)
            .title(c::PRIVACY)
            .description(c::PRIVACY_DESCRIPTION)
            .children(
                model
                    .usage_error
                    .map(|error| videorc_kit::alert::Alert::new("privacy-error").title(error)),
            )
            .child(
                GroupedList::new().item(
                    div()
                        .child(ListRow::new("usage-row", c::USAGE_STATS).child(usage))
                        .child(
                            div()
                                .px(px(12.))
                                .pb(px(8.))
                                .type_scale(text::META)
                                .text_color(hsla(t.muted_foreground))
                                .child(c::USAGE_STATS_DESCRIPTION),
                        ),
                ),
            )
            .when(model.usage_env_disabled, |section| {
                section.child(videorc_kit::alert::Alert::new("usage-env").title(c::USAGE_STATS_ENV))
            });
        let setup = PanelSection::new(c::SETUP)
            .title(c::SETUP)
            .description(c::SETUP_DESCRIPTION)
            .child(
                GroupedList::new().item(
                    div()
                        .child(
                            ListRow::new("setup-row", c::FIRST_RUN_SETUP).child(
                                Button::new("replay-setup")
                                    .label(c::RUN_SETUP_AGAIN)
                                    .variant(ButtonVariant::Outline)
                                    .disabled(true)
                                    .tooltip(model.setup_held.unwrap_or(view::NOT_IN_THIS_BUILD)),
                            ),
                        )
                        .child(
                            div()
                                .px(px(12.))
                                .pb(px(8.))
                                .type_scale(text::META)
                                .text_color(hsla(t.muted_foreground))
                                .child(model.setup_description),
                        ),
                ),
            );
        let import = PanelSection::new(c::IMPORT)
            .title(c::IMPORT)
            .description(c::IMPORT_DESCRIPTION)
            .child(
                GroupedList::new().item(
                    div()
                        .child(
                            ListRow::new("obs-row", c::OBS_STUDIO).child(
                                Button::new("import-obs")
                                    .label(c::IMPORT_FROM_OBS)
                                    .variant(ButtonVariant::Outline)
                                    .disabled(self.disabled() || snapshot.session.phase.is_active())
                                    .on_click(
                                        cx.listener(|this, _, window, cx| {
                                            this.open_obs(window, cx)
                                        }),
                                    ),
                            ),
                        )
                        .child(
                            div()
                                .px(px(12.))
                                .pb(px(8.))
                                .type_scale(text::META)
                                .text_color(hsla(t.muted_foreground))
                                .child(c::OBS_DESCRIPTION),
                        ),
                ),
            );
        let mut elsewhere = GroupedList::new();
        for row in model.elsewhere {
            let page = PageId::parse(row.id);
            elsewhere = elsewhere.item(
                ListRow::new(row.id, row.label).child(
                    Button::new(gpui::SharedString::from(format!("navigate-{}", row.id)))
                        .label(row.value)
                        .variant(ButtonVariant::Ghost)
                        .disabled(page.is_none() || !row.enabled)
                        .tooltip(view::NOT_IN_THIS_BUILD)
                        .on_click(cx.listener(move |_, _, _, cx| {
                            if let Some(page) = page {
                                cx.emit(Navigate(page));
                            }
                        })),
                ),
            );
        }
        // Wrapping at the same two-column breakpoint keeps rows usable at
        // narrow window sizes; the tab strip never joins the scrolling body.
        div()
            .flex()
            .flex_wrap()
            .items_start()
            .child(
                div()
                    .flex_1()
                    .min_w(px(360.))
                    .child(appearance)
                    .child(chat)
                    .child(setup),
            )
            .child(
                div()
                    .flex_1()
                    .min_w(px(360.))
                    .child(import)
                    .child(privacy)
                    .child(
                        PanelSection::new(c::ELSEWHERE)
                            .title(c::ELSEWHERE)
                            .description(c::ELSEWHERE_DESCRIPTION)
                            .child(elsewhere),
                    ),
            )
            .into_any_element()
    }

    pub fn apply_theme(&mut self, cx: &App) {
        let stored = self.studio.snapshot().settings.theme;
        let choice = ThemeChoice::parse(stored.as_deref());
        if self.applied_theme == Some(choice) {
            return;
        }
        self.applied_theme = Some(choice);
        cx.set_window_appearance(match choice {
            ThemeChoice::Light => Some(WindowAppearance::Light),
            ThemeChoice::Dark => Some(WindowAppearance::Dark),
            ThemeChoice::System => None,
        });
    }
}
