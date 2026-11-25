//! Sidekick → Community: people list, person card, Same person, Mark as bot,
//! Forget — `cohost.community.*` plus `videorc_app_core::buddy::community`.

use chrono::Utc;
use gpui::{AnyElement, Context, Entity, Window, div, prelude::*, px};
use serde::Deserialize;
use videorc_app_core::buddy::community::{
    self, BUDDY_REMEMBERS_LOCK_REASON, COMMUNITY_DISCLOSURE_LINE, CommunitySummary,
    X_SELF_LINK_REASON, YOUTUBE_RETENTION_LINE, about_item, community_header_line, forget_copy,
    has_x, person_row_context, person_stats_line, support_line,
};
use videorc_app_core::buddy::copy as words;
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle};
use videorc_kit::input::{Input, InputState};
use videorc_kit::list_row::{GroupedList, ListRow};
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
const SAME_PERSON: &str = "Same person";
const SAME_PERSON_AS: &str = "Same person as…";
const NOT_THE_SAME: &str = "Not the same";
const MARK_AS_BOT: &str = "Mark as bot";
const NOT_A_BOT: &str = "Not a bot";
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
const FORGET_EVERYONE_TITLE: &str = "Forget everyone?";
const PEOPLE_EMPTY: &str = "People show up here after they chat in one of your streams.";
const CANCEL: &str = "Cancel";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonRow {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub streams: u64,
    #[serde(default)]
    pub regular: bool,
    #[serde(default)]
    pub last_seen_at: Option<String>,
    #[serde(default)]
    pub status: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PersonSupport {
    pub bits: u64,
    pub kicks: u64,
    pub gifted_subs: u64,
    pub sub_months: u64,
    pub tips: std::collections::BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PersonAccount {
    pub account_key: String,
    pub platform: String,
    #[serde(default)]
    pub author_id: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSuggestion {
    pub account_a: PersonAccount,
    pub account_b: PersonAccount,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonDetail {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub streams: u64,
    #[serde(default)]
    pub messages: u64,
    #[serde(default)]
    pub in_a_row: u64,
    #[serde(default)]
    pub first_seen_at: Option<String>,
    #[serde(default)]
    pub last_seen_at: Option<String>,
    #[serde(default)]
    pub support: Option<community::CommunitySupport>,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub accounts: Vec<PersonAccount>,
    #[serde(default)]
    pub suggestions: Vec<AccountSuggestion>,
    #[serde(default)]
    pub youtube: bool,
}

pub type LinkSuggestion = AccountSuggestion;

pub struct CommunityState {
    pub summary: Option<CommunitySummary>,
    pub people: Vec<PersonRow>,
    pub suggestions: Vec<LinkSuggestion>,
    pub selected: Option<PersonDetail>,
    pub search: Entity<InputState>,
    pub link_search: Entity<InputState>,
    pub link_hits: Vec<PersonRow>,
    pub linking: bool,
    pub forget: DialogHandle,
    pub forget_everyone: DialogHandle,
    pub forget_id: Option<String>,
    pub forget_name: String,
    pub loaded: bool,
}

impl CommunityState {
    pub fn new(window: &mut Window, cx: &mut Context<SidekickScreen>) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder(SEARCH_PEOPLE));
        let link_search = cx.new(|cx| InputState::new(window, cx).placeholder(SEARCH_PEOPLE));
        cx.observe(&search, |screen, _, cx| {
            screen.refresh_community_list(cx);
        })
        .detach();
        cx.observe(&link_search, |screen, _, cx| {
            screen.refresh_community_link_hits(cx);
        })
        .detach();
        Self {
            summary: None,
            people: Vec::new(),
            suggestions: Vec::new(),
            selected: None,
            search,
            link_search,
            link_hits: Vec::new(),
            linking: false,
            forget: DialogHandle::new(false),
            forget_everyone: DialogHandle::new(false),
            forget_id: None,
            forget_name: String::new(),
            loaded: false,
        }
    }
}

pub fn render_community(
    view: &LiveView,
    entitled: bool,
    state: &CommunityState,
    remember: bool,
    window: &mut Window,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let theme = theme::resolve(None, window, cx);
    let muted = hsla(theme.muted_foreground);
    let entity = cx.entity();
    let now = Utc::now();

    let mut lead = div().flex().flex_col().gap(px(8.)).p(px(size::GUTTER));
    if !entitled {
        let action = view
            .unlock
            .as_ref()
            .and_then(|u| u.action)
            .unwrap_or(UnlockAction::ViewPremium);
        let label = match action {
            UnlockAction::SignIn => words::SIGN_IN,
            UnlockAction::ViewPremium => words::VIEW_PREMIUM,
        };
        lead = lead.child(
            Alert::new("sidekick-community-premium")
                .variant(AlertVariant::Warning)
                .title(BUDDY_REMEMBERS_LOCK_REASON)
                .action(
                    Button::new("community-unlock-action")
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .label(label)
                        .on_click(move |_, _, cx| match action {
                            UnlockAction::SignIn => {
                                eprintln!(
                                    "[videorc-app] Sidekick Community: Sign in (account UI next)"
                                )
                            }
                            UnlockAction::ViewPremium => cx.open_url("https://videorc.com/premium"),
                        }),
                ),
        );
    }

    let header_line = community_header_line(state.summary.as_ref());
    let mut summary_block = div().flex().flex_col().gap(px(4.)).child(
        div()
            .type_scale(text::META)
            .text_color(muted)
            .child(header_line),
    );
    if let Some(backfill) = community::backfill_line(state.summary.as_ref()) {
        summary_block = summary_block.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(backfill),
        );
    }
    let summary = PanelSection::new("sidekick-your-community")
        .title(YOUR_COMMUNITY)
        .child(summary_block);

    let mut links = PanelSection::new("sidekick-links").title(LINKS_NEED_YOU);
    if state.suggestions.is_empty() {
        links = links.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child("No links waiting."),
        );
    } else {
        let mut list = GroupedList::new().label(LINKS_NEED_YOU);
        for suggestion in &state.suggestions {
            let account_a = suggestion.account_a.account_key.clone();
            let account_b = suggestion.account_b.account_key.clone();
            let title = format!(
                "{} ↔ {}",
                suggestion.account_a.name, suggestion.account_b.name
            );
            let key = format!("{account_a}|{account_b}");
            list = list.row(
                ListRow::new(format!("link-{key}"), title)
                    .context(suggestion.reason.clone())
                    .child(
                        Button::new(format!("accept-{key}"))
                            .variant(ButtonVariant::Outline)
                            .size(ButtonSize::Xs)
                            .label(SAME_PERSON)
                            .on_click({
                                let entity = entity.clone();
                                let account_a = account_a.clone();
                                let account_b = account_b.clone();
                                move |_, _, cx| {
                                    entity.update(cx, |screen, cx| {
                                        screen.community_accept_suggestion(
                                            account_a.clone(),
                                            account_b.clone(),
                                            cx,
                                        );
                                    });
                                }
                            }),
                    )
                    .child(
                        Button::new(format!("dismiss-{key}"))
                            .variant(ButtonVariant::Ghost)
                            .size(ButtonSize::Xs)
                            .label(NOT_THE_SAME)
                            .on_click({
                                let entity = entity.clone();
                                let account_a = account_a.clone();
                                let account_b = account_b.clone();
                                move |_, _, cx| {
                                    entity.update(cx, |screen, cx| {
                                        screen.community_dismiss_suggestion(
                                            account_a.clone(),
                                            account_b.clone(),
                                            cx,
                                        );
                                    });
                                }
                            }),
                    ),
            );
        }
        links = links.child(list);
    }

    let mut people_list = GroupedList::new().label(PEOPLE);
    if state.people.is_empty() {
        people_list = people_list.row(ListRow::new("people-empty", PEOPLE_EMPTY).compact(true));
    } else {
        for person in &state.people {
            let id = person.id.clone();
            let context = person_row_context(person.streams, person.last_seen_at.as_deref(), now);
            let meta = if person.status == "bot" {
                "Bot"
            } else if person.regular {
                "Regular"
            } else {
                ""
            };
            people_list = people_list.row(
                ListRow::new(format!("person-{}", person.id), person.name.clone())
                    .compact(true)
                    .context(context)
                    .meta(meta)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |screen, cx| {
                                screen.select_community_person(id.clone(), cx);
                            });
                        }
                    }),
            );
        }
    }

    let people = PanelSection::new("sidekick-people")
        .title(PEOPLE)
        .child(Input::new("community-search", &state.search).accessibility_label(SEARCH_PEOPLE))
        .child(people_list);

    let card = if let Some(person) = state.selected.as_ref() {
        render_person_card(person, state, muted, window, cx)
    } else {
        div().into_any_element()
    };

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
                                .checked(remember)
                                .disabled(!entitled)
                                .on_change({
                                    let entity = entity.clone();
                                    move |value, _, cx| {
                                        entity.update(cx, |screen, cx| {
                                            screen.patch_settings(
                                                serde_json::json!({
                                                    "community": { "remember": value }
                                                }),
                                                cx,
                                            );
                                        });
                                    }
                                }),
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
                                .on_click({
                                    let entity = entity.clone();
                                    move |_, window, cx| {
                                        entity.update(cx, |screen, cx| {
                                            if let Some(community) = screen.community.as_mut() {
                                                community.forget_everyone.open(window, cx);
                                            }
                                            cx.notify();
                                        });
                                    }
                                }),
                        ),
                ),
        );

    let forget = forget_dialog(state, cx);
    let forget_all = forget_everyone_dialog(state, cx);

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
                .child(card)
                .child(premium)
                .child(data),
        )
        .child(forget)
        .child(forget_all)
        .into_any_element()
}

fn render_person_card(
    person: &PersonDetail,
    state: &CommunityState,
    muted: gpui::Hsla,
    _window: &mut Window,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let entity = cx.entity();
    let id = person.id.clone();
    let name = person.name.clone();
    let is_bot = person.status == "bot";
    let stats = person_stats_line(
        person.streams,
        person.first_seen_at.as_deref(),
        person.in_a_row,
        person.messages,
    );
    let support = support_line(person.support.as_ref()).unwrap_or_default();
    let platforms: Vec<String> = if person.platforms.is_empty() {
        person
            .accounts
            .iter()
            .map(|account| account.platform.clone())
            .collect()
    } else {
        person.platforms.clone()
    };
    let blocks_x = has_x(platforms.iter().map(String::as_str));

    let mut body = div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(
            div()
                .type_scale(text::SECTION)
                .font_weight(gpui::FontWeight::MEDIUM)
                .child(about_item(&name)),
        )
        .child(div().type_scale(text::META).text_color(muted).child(stats));
    if !support.is_empty() {
        body = body.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(support),
        );
    }
    if person.youtube {
        body = body.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(YOUTUBE_RETENTION_LINE),
        );
    }
    if !person.note.is_empty() {
        body = body.child(
            div()
                .type_scale(text::META)
                .child(format!("Note: {}", person.note)),
        );
    }

    let mut actions = div().flex().flex_wrap().gap(px(8.)).child(
        Button::new("mark-bot")
            .variant(ButtonVariant::Outline)
            .size(ButtonSize::Xs)
            .label(if is_bot { NOT_A_BOT } else { MARK_AS_BOT })
            .on_click({
                let entity = entity.clone();
                let id = id.clone();
                move |_, _, cx| {
                    entity.update(cx, |screen, cx| {
                        screen.community_toggle_bot(id.clone(), is_bot, cx);
                    });
                }
            }),
    );
    actions = actions.child(
        Button::new("forget-person")
            .variant(ButtonVariant::Outline)
            .size(ButtonSize::Xs)
            .label(format!("Forget {name}…"))
            .on_click({
                let entity = entity.clone();
                let id = id.clone();
                let name = name.clone();
                move |_, window, cx| {
                    entity.update(cx, |screen, cx| {
                        screen.ask_forget_person(id.clone(), name.clone(), window, cx);
                    });
                }
            }),
    );
    if blocks_x {
        actions = actions.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(X_SELF_LINK_REASON),
        );
    } else {
        actions = actions.child(
            Button::new("same-person")
                .variant(ButtonVariant::Outline)
                .size(ButtonSize::Xs)
                .label(SAME_PERSON_AS)
                .on_click({
                    let entity = entity.clone();
                    move |_, _, cx| {
                        entity.update(cx, |screen, cx| {
                            if let Some(community) = screen.community.as_mut() {
                                community.linking = !community.linking;
                                if !community.linking {
                                    community.link_hits.clear();
                                }
                            }
                            cx.notify();
                        });
                    }
                }),
        );
    }
    body = body.child(actions);

    if state.linking && !blocks_x {
        let mut link_block = div().flex().flex_col().gap(px(6.)).child(
            Input::new("community-link-search", &state.link_search)
                .accessibility_label(SAME_PERSON_AS),
        );
        for hit in &state.link_hits {
            if hit.id == person.id {
                continue;
            }
            let other_id = hit.id.clone();
            let person_id = person.id.clone();
            link_block = link_block.child(
                ListRow::new(format!("link-hit-{}", hit.id), hit.name.clone())
                    .compact(true)
                    .child(
                        Button::new(format!("link-{}", hit.id))
                            .variant(ButtonVariant::Outline)
                            .size(ButtonSize::Xs)
                            .label(SAME_PERSON)
                            .on_click({
                                let entity = entity.clone();
                                move |_, _, cx| {
                                    entity.update(cx, |screen, cx| {
                                        screen.community_link(
                                            person_id.clone(),
                                            other_id.clone(),
                                            cx,
                                        );
                                    });
                                }
                            }),
                    ),
            );
        }
        body = body.child(link_block);
    }

    let mine: std::collections::HashSet<&str> = person
        .accounts
        .iter()
        .map(|account| account.account_key.as_str())
        .collect();
    for suggestion in &person.suggestions {
        let other = if mine.contains(suggestion.account_a.account_key.as_str()) {
            &suggestion.account_b
        } else {
            &suggestion.account_a
        };
        let account_a = suggestion.account_a.account_key.clone();
        let account_b = suggestion.account_b.account_key.clone();
        let key = format!("{account_a}|{account_b}");
        body = body.child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .min_w(px(0.))
                        .flex_1()
                        .type_scale(text::META)
                        .child(format!("{} — {}", other.name, suggestion.reason)),
                )
                .child(
                    Button::new(format!("card-accept-{key}"))
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .label(SAME_PERSON)
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| {
                                entity.update(cx, |screen, cx| {
                                    screen.community_accept_suggestion(
                                        account_a.clone(),
                                        account_b.clone(),
                                        cx,
                                    );
                                });
                            }
                        }),
                ),
        );
    }

    PanelSection::new("sidekick-person-card")
        .title(person.name.clone())
        .child(body)
        .into_any_element()
}

fn forget_dialog(state: &CommunityState, cx: &mut Context<SidekickScreen>) -> impl IntoElement {
    let entity = cx.entity();
    let copy = forget_copy(&state.forget_name);
    Dialog::new("forget-person", &state.forget, copy.title.clone())
        .description(copy.description.clone())
        .footer(
            Button::new("forget-cancel")
                .variant(ButtonVariant::Ghost)
                .label(CANCEL)
                .on_click({
                    let entity = entity.clone();
                    move |_, window, cx| {
                        entity.update(cx, |screen, cx| {
                            if let Some(community) = screen.community.as_mut() {
                                community.forget.close(window, cx);
                                community.forget_id = None;
                            }
                            cx.notify();
                        });
                    }
                }),
        )
        .footer(
            Button::new("forget-confirm")
                .variant(ButtonVariant::Default)
                .label(copy.confirm)
                .on_click(move |_, window, cx| {
                    entity.update(cx, |screen, cx| {
                        screen.confirm_forget_person(window, cx);
                    });
                }),
        )
}

fn forget_everyone_dialog(
    state: &CommunityState,
    cx: &mut Context<SidekickScreen>,
) -> impl IntoElement {
    let entity = cx.entity();
    Dialog::new(
        "forget-everyone",
        &state.forget_everyone,
        FORGET_EVERYONE_TITLE,
    )
    .description("Videorc deletes what it remembers about everyone on this computer.")
    .footer(
        Button::new("forget-everyone-cancel")
            .variant(ButtonVariant::Ghost)
            .label(CANCEL)
            .on_click({
                let entity = entity.clone();
                move |_, window, cx| {
                    entity.update(cx, |screen, cx| {
                        if let Some(community) = screen.community.as_mut() {
                            community.forget_everyone.close(window, cx);
                        }
                        cx.notify();
                    });
                }
            }),
    )
    .footer(
        Button::new("forget-everyone-confirm")
            .variant(ButtonVariant::Default)
            .label("Forget everyone")
            .on_click(move |_, window, cx| {
                entity.update(cx, |screen, cx| {
                    screen.community_forget_all(window, cx);
                });
            }),
    )
}
