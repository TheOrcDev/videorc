//! The sidebar's account row and its menu (P024–P034, with P025's dot; Electron's
//! `account-menu-trigger.tsx` and `account-menu-body.tsx`): the trigger
//! shows the account's name or "Sign in"; the menu's header names the
//! account and its plan, then Account or Sign in, View Premium, Health,
//! Settings, and Sign out, locked while recording or live, with its reason
//! under it. Only the Videorc account is here, never a platform account.
//!
//! The picture is the initials (the kit's 20 px avatar): the account's
//! picture loads through an
//! avatar cache in Electron, never hot-linked, and the app has none yet.

use gpui::{App, FontWeight, WeakEntity, Window, div, prelude::*, px};
use videorc_app_core::accounts::{Account, AccountsState, MenuItem as Row, copy, menu_items};
use videorc_app_core::nav::PageId;
use videorc_app_core::studio::scenes_section::session_active;
use videorc_kit::{
    avatar::Avatar,
    button::{Button, ButtonVariant},
    dropdown_menu::{DropdownMenu, Menu, MenuItem, MenuItemTone},
    icon::{IconName, icon},
    status_dot::{StatusDot, StatusTone},
    theme::{TypeScale, hsla},
    tokens::{Theme, text},
};

use super::accounts::{self, Shared};
use super::shell::Shell;

/// The account's initials, for its avatar.
fn initials(name: &str) -> String {
    name.split_whitespace()
        .filter_map(|word| word.chars().next())
        .take(2)
        .flat_map(char::to_uppercase)
        .collect()
}

/// A recording or livestream runs (or starts, or stops): Sign out waits.
fn live(cx: &App) -> bool {
    cx.try_global::<Shared>()
        .is_some_and(|shared| session_active(&shared.studio.snapshot()))
}

/// The menu, built while it shows.
fn build_menu(
    account: &Account,
    tier: &'static str,
    health: StatusTone,
    health_label: &str,
    health_pulse: bool,
    shell: &WeakEntity<Shell>,
    cx: &App,
) -> Menu {
    let signed_in = account.is_signed_in();
    let header = if signed_in {
        account.display_name()
    } else {
        copy::NOT_SIGNED_IN.to_string()
    };
    let locked = videorc_app_core::accounts::sign_out_disabled(account, live(cx));
    let mut menu = Menu::new().label(format!("{header} · {tier}"));
    for row in menu_items(account) {
        menu = match row {
            Row::Account => menu.separator().item(
                MenuItem::new(copy::ACCOUNT)
                    .icon(|ink| icon(IconName::UserCircle, 16., ink))
                    .on_select(|_, cx| accounts::open_web(cx, |web| web.account())),
            ),
            Row::SignIn => menu.separator().item(
                MenuItem::new(copy::SIGN_IN)
                    .icon(|ink| icon(IconName::SignIn, 16., ink))
                    .on_select(|_, cx| accounts::sign_in(cx)),
            ),
            Row::ViewPremium => menu.item(
                MenuItem::new(copy::VIEW_PREMIUM)
                    .icon(|ink| icon(IconName::Sparkle, 16., ink))
                    .on_select(|_, cx| accounts::open_web(cx, |web| web.premium())),
            ),
            Row::Health => {
                let shell = shell.clone();
                let health_label = health_label.to_string();
                menu.separator().item(
                    MenuItem::new(copy::HEALTH)
                        .icon(|ink| icon(IconName::Pulse, 16., ink))
                        .end(move |_| {
                            StatusDot::new("account-menu-health")
                                .tone(health)
                                .label(health_label.clone())
                                .pulse(health_pulse)
                                .into_any_element()
                        })
                        .on_select(move |window, cx| {
                            let _ = shell.update(cx, |shell, cx| {
                                shell.open_page(PageId::Diagnostics, window, cx)
                            });
                        }),
                )
            }
            Row::Settings => {
                let shell = shell.clone();
                menu.item(
                    MenuItem::new(copy::SETTINGS)
                        .icon(|ink| icon(IconName::GearSix, 16., ink))
                        .on_select(move |window, cx| {
                            let _ = shell.update(cx, |shell, cx| {
                                shell.open_page(PageId::Settings, window, cx)
                            });
                        }),
                )
            }
            Row::SignOut => menu,
        };
    }
    if signed_in {
        menu = menu.separator().item(
            MenuItem::new(copy::SIGN_OUT)
                .tone(MenuItemTone::Destructive)
                .icon(|ink| icon(IconName::SignOut, 16., ink))
                .disabled(locked)
                .on_select(|_, cx| {
                    let live = live(cx);
                    accounts::sign_out(cx, live)
                }),
        );
        if locked {
            menu = menu.label(copy::SIGN_OUT_LOCKED);
        }
    }
    menu
}

/// The sidebar's account row: its trigger, and the menu it opens.
pub fn row(
    state: &AccountsState,
    needs_sign_in: bool,
    health: StatusTone,
    health_label: impl Into<String>,
    health_pulse: bool,
    shell: WeakEntity<Shell>,
    t: &Theme,
) -> impl IntoElement {
    let account = state.account.clone();
    let tier = state.tier_label();
    let name = account.display_name();
    let health_label = health_label.into();
    let picture = if account.is_signed_in() {
        // `size-5`: a 20 px face, so the initials keep the 11 px floor.
        Avatar::new(initials(&name)).xs().into_any_element()
    } else {
        icon(IconName::UserCircle, 16., hsla(t.muted_foreground)).into_any_element()
    };
    // `ACCOUNT_MENU_TRIGGER_CLASS`: `h-7` with a 6 px side pad (`px-1.5`).
    let trigger = Button::new("account-menu-trigger")
        .variant(ButtonVariant::Ghost)
        .dense(true)
        .accessibility_label(name.clone())
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .min_w(px(0.))
                .child(picture)
                // Electron's trigger (`account-menu-trigger.tsx`): a 28 px
                // row with the name at `text-xs font-medium`, 12/16 px.
                .child(
                    div()
                        .truncate()
                        .type_scale(text::META)
                        .font_weight(FontWeight::MEDIUM)
                        .child(name),
                )
                // P025: bare, so the trigger's name stays the words it shows;
                // the Go Live check, the toast and the chat row say why.
                .when(needs_sign_in, |row| {
                    row.child(StatusDot::new("account-needs-sign-in").tone(StatusTone::Warn))
                }),
        );
    DropdownMenu::new("account-menu")
        .trigger(trigger)
        .menu(move |_: &mut Window, cx: &mut App| {
            build_menu(
                &account,
                tier,
                health,
                &health_label,
                health_pulse,
                &shell,
                cx,
            )
        })
}
