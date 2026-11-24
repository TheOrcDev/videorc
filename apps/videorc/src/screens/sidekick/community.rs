//! Sidekick → Community (`community/community-tab.tsx`).

use gpui::{AnyElement, Context, Window, div, prelude::*, px};
use videorc_app_core::buddy::community::{
    BUDDY_REMEMBERS_LOCK_REASON, COMMUNITY_DISCLOSURE_LINE, NOTHING_YET_LINE, community_header_line,
};
use videorc_app_core::buddy::copy as words;
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::settings_row::{SettingsGroup, SettingsRow};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{size, text};

use super::SidekickScreen;
use super::live::{LiveView, UnlockAction};

const YOUR_COMMUNITY: &str = "Your community";
const PEOPLE: &str = "People";
const SEARCH_PEOPLE: &str = "Search people";
const LINKS_NEED_YOU: &str = "Links that need you";
const PREMIUM: &str = "Premium";
const SIDEKICK_REMEMBERS: &str = "Sidekick remembers";
const COMMUNITY_SYNC: &str = "Community sync";
const COMMUNITY_SYNC_REASON: &str = "Community sync is part of Premium.";
const PREMIUM_DESCRIPTION: &str = "Sidekick remembers what regulars say about themselves, and your community follows you to your other computers, encrypted so Videorc can't read it.";
const YOUR_DATA: &str = "Your data";
const YOUR_DATA_DESCRIPTION: &str =
    "Your community's file, and the line that tells viewers what Videorc keeps.";
const COPY: &str = "Copy";
const FORGET_EVERYONE: &str = "Forget everyone…";
const PEOPLE_EMPTY: &str = "People show up here after they chat in one of your streams.";

pub fn render_community(
    view: &LiveView,
    entitled: bool,
    window: &mut Window,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let theme = theme::resolve(None, window, cx);
    let muted = hsla(theme.muted_foreground);
    let entity = cx.entity();

    let mut lead = div().flex().flex_col().gap(px(8.)).p(px(size::GUTTER));
    if !entitled {
        let mut alert = Alert::new("sidekick-community-premium")
            .variant(AlertVariant::Warning)
            .title(BUDDY_REMEMBERS_LOCK_REASON);
        let action = view
            .unlock
            .as_ref()
            .and_then(|u| u.action)
            .unwrap_or(UnlockAction::ViewPremium);
        let label = match action {
            UnlockAction::SignIn => words::SIGN_IN,
            UnlockAction::ViewPremium => words::VIEW_PREMIUM,
        };
        alert = alert.action(
            Button::new("community-unlock-action")
                .variant(ButtonVariant::Outline)
                .size(ButtonSize::Xs)
                .label(label)
                .on_click(move |_, _, cx| match action {
                    UnlockAction::SignIn => {
                        eprintln!("[videorc-app] Sidekick Community: Sign in (account UI next)")
                    }
                    UnlockAction::ViewPremium => cx.open_url("https://videorc.com/premium"),
                }),
        );
        lead = lead.child(alert);
    }

    let summary = PanelSection::new("sidekick-your-community")
        .title(YOUR_COMMUNITY)
        .description(community_header_line(None))
        .child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(NOTHING_YET_LINE),
        );

    let links = PanelSection::new("sidekick-links")
        .title(LINKS_NEED_YOU)
        .child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child("No links waiting."),
        );

    let people = PanelSection::new("sidekick-people")
        .title(PEOPLE)
        .child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(SEARCH_PEOPLE),
        )
        .child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(PEOPLE_EMPTY),
        );

    let premium = PanelSection::new("sidekick-community-premium")
        .title(PREMIUM)
        .description(PREMIUM_DESCRIPTION)
        .child(
            SettingsGroup::new()
                .row(
                    SettingsRow::new("sidekick-remembers", SIDEKICK_REMEMBERS)
                        .description(BUDDY_REMEMBERS_LOCK_REASON)
                        .child(
                            Switch::new("sidekick-remembers")
                                .accessibility_label(SIDEKICK_REMEMBERS)
                                .checked(false)
                                .disabled(true),
                        ),
                )
                .row(
                    SettingsRow::new("community-sync", COMMUNITY_SYNC)
                        .description(COMMUNITY_SYNC_REASON)
                        .child(
                            Switch::new("community-sync")
                                .accessibility_label(COMMUNITY_SYNC)
                                .checked(false)
                                .disabled(true),
                        ),
                ),
        );

    let data = PanelSection::new("sidekick-your-data")
        .title(YOUR_DATA)
        .description(YOUR_DATA_DESCRIPTION)
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(COMMUNITY_DISCLOSURE_LINE),
                )
                .child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .child(
                            Button::new("copy-disclosure")
                                .variant(ButtonVariant::Outline)
                                .size(ButtonSize::Xs)
                                .label(COPY)
                                .on_click(|_, _, cx| {
                                    cx.write_to_clipboard(gpui::ClipboardItem::new_string(
                                        COMMUNITY_DISCLOSURE_LINE.to_string(),
                                    ));
                                }),
                        )
                        .child(
                            Button::new("forget-everyone")
                                .variant(ButtonVariant::Outline)
                                .size(ButtonSize::Xs)
                                .label(FORGET_EVERYONE)
                                .disabled(true)
                                .on_click({
                                    let _entity = entity.clone();
                                    move |_, _, _| {}
                                }),
                        ),
                ),
        );

    div()
        .flex()
        .flex_col()
        .child(lead)
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(size::GUTTER))
                .p(px(size::GUTTER))
                .child(summary)
                .child(links)
                .child(people)
                .child(premium)
                .child(data),
        )
        .into_any_element()
}
