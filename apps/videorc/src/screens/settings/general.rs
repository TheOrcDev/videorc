use super::*;
use gpui::SharedString;
use gpui::{AnyElement, Window, WindowAppearance};
use videorc_app_core::{
    nav::{PageId, ThemeChoice},
    studio::families,
};
use videorc_kit::{
    button::{Button, ButtonVariant},
    icon::{IconName, icon},
    list_row::GroupedList,
    navigable_row::NavigableRow,
    page::ConfigGrid,
    panel_section::PanelSection,
    select::Select,
    settings_row::SettingsRow,
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

    /// Sidebar / D: flip light ↔ dark; landing on the system look returns
    /// control to System (`next_toggled_theme`, P022 / P060).
    pub fn toggle_theme(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let system_dark = matches!(
            window.appearance(),
            WindowAppearance::Dark | WindowAppearance::VibrantDark
        );
        let stored = ThemeChoice::parse(self.studio.snapshot().settings.theme.as_deref());
        let next = videorc_app_core::nav::next_toggled_theme(
            stored.resolved_dark(system_dark),
            system_dark,
        );
        self.save_theme(next, cx);
        self.apply_theme(cx);
    }

    pub(super) fn general(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = theme::current(window, cx).theme();
        use view::copy as c;
        let snapshot = self.studio.snapshot();
        let settings = &snapshot.settings.studio;
        let model = view::general_view(&view::GeneralInput {
            platform: crate::app::hotkeys::node_platform(),
            theme: ThemeChoice::parse(snapshot.settings.theme.as_deref()),
            studio_chat: settings.studio_chat(),
            open_stream_manager_on_live: settings.open_stream_manager_on_live(),
            stream_manager_enabled: true,
            chat: &self.chat,
            usage: &self.usage,
            session_active: snapshot.session.phase.is_active(),
            first_run_ported: true,
            account_name: self.account_name(),
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
        // Settings rows are the kit's twins of `field.tsx`'s SettingsRow and
        // `navigable-row.tsx` (label and description on the left, the control
        // on the right), in one grouped list per section.
        let scene_row = NavigableRow::new(
            "scene-link",
            c::ANIMATE_SCENE_CHANGES,
            PageId::Layouts.label(),
        );
        let scene_row = if model.scene_ported {
            scene_row.on_navigate(cx.listener(|_, _, _, cx| cx.emit(Navigate(PageId::Layouts))))
        } else {
            scene_row
        };
        let appearance = PanelSection::new(c::APPEARANCE)
            .title(c::APPEARANCE)
            .description(c::APPEARANCE_DESCRIPTION)
            .child(
                GroupedList::new()
                    .item(
                        SettingsRow::new("theme-row", c::THEME)
                            .description(model.theme_description)
                            .child(theme),
                    )
                    .row(scene_row),
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
        // `seventv-emotes-field.tsx`: the 7TV status is the description's
        // second line.
        let seven_tv_description = match &model.seven_tv_line {
            Some(line) => format!("{}\n{}", c::SEVEN_TV_DESCRIPTION, line),
            None => c::SEVEN_TV_DESCRIPTION.to_string(),
        };
        // GIFs in Twitch chat is a Select (`w-32`), as Electron's.
        let entity = cx.entity();
        let mut gifs = Select::new("twitch-gifs")
            .accessibility_label(c::TWITCH_GIFS)
            .disabled(self.disabled() || !model.chat_loaded)
            .value(
                view::GIF_MODES
                    .get(model.gif_index)
                    .map(|(value, _)| SharedString::from(*value)),
            );
        for (value, label) in view::GIF_MODES {
            gifs = gifs.option(value, label);
        }
        let gifs = gifs.on_change(move |value, _, cx| {
            entity.update(cx, |this, cx| {
                this.request(
                    "liveChat.emotes.set",
                    json!({"twitchGifs": value.to_string()}),
                    c::CHAT_SAVE_FAILED,
                    cx,
                )
            });
        });
        // Electron's order: the section's own rows, then the emote fields.
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
                        SettingsRow::new("studio-chat-row", c::CHAT_IN_STUDIO)
                            .description(c::CHAT_IN_STUDIO_DESCRIPTION)
                            .child(self.studio_switch(
                                "studioChat",
                                c::CHAT_IN_STUDIO,
                                model.studio_chat,
                                cx,
                            )),
                    )
                    .item(
                        SettingsRow::new("stream-manager-row", c::OPEN_STREAM_MANAGER)
                            .description(c::OPEN_STREAM_MANAGER_DESCRIPTION)
                            .child(self.studio_switch(
                                "openStreamManagerOnLive",
                                c::OPEN_STREAM_MANAGER,
                                model.open_stream_manager_on_live,
                                cx,
                            )),
                    )
                    .item(
                        SettingsRow::new("emotes-row", c::SEVEN_TV)
                            .description(seven_tv_description)
                            .child(emotes),
                    )
                    .item(
                        SettingsRow::new("gif-row", c::TWITCH_GIFS)
                            .description(c::TWITCH_GIFS_DESCRIPTION)
                            .child(div().flex_none().w(px(128.)).child(gifs)),
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
        // `usage-stats-field.tsx`: the environment's refusal is a line of the
        // row's description, not an alert.
        let usage_description = if model.usage_env_disabled {
            format!("{}\n{}", c::USAGE_STATS_DESCRIPTION, c::USAGE_STATS_ENV)
        } else {
            c::USAGE_STATS_DESCRIPTION.to_string()
        };
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
                    SettingsRow::new("usage-row", c::USAGE_STATS)
                        .description(usage_description)
                        .child(usage),
                ),
            );
        let setup = PanelSection::new(c::SETUP)
            .title(c::SETUP)
            .description(c::SETUP_DESCRIPTION)
            .last(true)
            .child(
                GroupedList::new().item(
                    SettingsRow::new("setup-row", c::FIRST_RUN_SETUP)
                        .description(model.setup_description)
                        .child(
                            Button::new("replay-setup")
                                .label(c::RUN_SETUP_AGAIN)
                                .variant(ButtonVariant::Outline)
                                .disabled(self.disabled() || model.setup_held.is_some())
                                .tooltip(model.setup_held.unwrap_or(c::RUN_SETUP_AGAIN))
                                .on_click(
                                    cx.listener(|this, _, window, cx| this.open_setup(window, cx)),
                                ),
                        ),
                ),
            );
        // Leading DownloadIcon, then the words (a label would draw first).
        let import = PanelSection::new(c::IMPORT)
            .title(c::IMPORT)
            .description(c::IMPORT_DESCRIPTION)
            .child(
                GroupedList::new().item(
                    SettingsRow::new("obs-row", c::OBS_STUDIO)
                        .description(c::OBS_DESCRIPTION)
                        .child(
                            Button::new("import-obs")
                                .accessibility_label(c::IMPORT_FROM_OBS)
                                .variant(ButtonVariant::Outline)
                                .disabled(self.disabled() || snapshot.session.phase.is_active())
                                .child(icon(IconName::DownloadSimple, 16., hsla(t.foreground)))
                                .child(c::IMPORT_FROM_OBS)
                                .on_click(
                                    cx.listener(|this, _, window, cx| this.open_obs(window, cx)),
                                ),
                        ),
                ),
            );
        // `ElsewhereList`: navigable rows with the page's own mark (the
        // sidebar's), the label in secondary text and the page in front.
        let mut elsewhere = GroupedList::new();
        for row in model.elsewhere {
            let page = PageId::parse(row.id);
            let account = row.id == "account";
            let signed_in = account && self.account_name().is_some();
            let mark = match page {
                Some(page) => crate::app::shell::page_icon(page),
                None => IconName::UserCircle,
            };
            let mut line = NavigableRow::new(row.id, row.label, row.value).icon(icon(
                mark,
                16.,
                hsla(t.muted_foreground),
            ));
            // `onNavigate={signedIn ? openAccount : signIn}`: signed out, the
            // account row signs in, like the account menu's Sign in.
            if (page.is_some() || account) && row.enabled {
                line = line.on_navigate(cx.listener(move |_, _, _, cx| {
                    if signed_in {
                        crate::app::accounts::open_web(cx, |web| web.account());
                    } else if account {
                        crate::app::accounts::sign_in(cx);
                    }
                    if let Some(page) = page {
                        cx.emit(Navigate(page));
                    }
                }));
            }
            elsewhere = elsewhere.row(line);
        }
        // `CONFIG_GRID_PAIR`: two columns with a rule between them, wrapping
        // at the same breakpoint so rows stay usable on a narrow window.
        ConfigGrid::new("settings-general-grid")
            .pair(true)
            .child(div().child(appearance).child(chat).child(setup))
            .child(
                div().child(import).child(privacy).child(
                    PanelSection::new(c::ELSEWHERE)
                        .title(c::ELSEWHERE)
                        .description(c::ELSEWHERE_DESCRIPTION)
                        .last(true)
                        .child(elsewhere),
                ),
            )
            .into_any_element()
    }

    pub fn apply_theme(&mut self, cx: &mut App) {
        let stored = self.studio.snapshot().settings.theme;
        let choice = ThemeChoice::parse(stored.as_deref());
        if self.applied_theme == Some(choice) {
            return;
        }
        self.applied_theme = Some(choice);
        let appearance = match choice {
            ThemeChoice::Light => Some(WindowAppearance::Light),
            ThemeChoice::Dark => Some(WindowAppearance::Dark),
            ThemeChoice::System => None,
        };
        // macOS sets the windows' appearance; Linux can't, so the kit reads
        // the app's own choice first on every platform (`AppearanceOverride`).
        // Windows also updates DWM immersive dark mode on every open title bar.
        crate::platform::apply_window_appearance(appearance, cx);
    }
}
