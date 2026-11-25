//! Community "Preview" (P1201): Play a welcome / Play a milestone on the
//! Sidekick page only — bubble line + living preview reaction, never live.

use std::path::Path;

use gpui::{AnyElement, Context, Entity, SharedString, Window, div, prelude::*, px};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{radius, text};
use videorc_protocol::buddy_pet::BuddyAvatar;
use videorc_protocol::cohost::{CohostPersona, CohostWelcomes, WelcomeLine};

use crate::screens::avatar::pictures;
use crate::screens::avatar::preview::PetPreview;

use super::SidekickScreen;

const PREVIEW_PX: f32 = 72.;
const TITLE: &str = "Preview";
const DESCRIPTION: &str = "Hear how Sidekick welcomes a regular and celebrates a milestone. Only here: nothing goes live.";
const PICK_ONE: &str = "Pick one to play.";
const PLAY_WELCOME: &str = "Play a welcome";
const PLAY_MILESTONE: &str = "Play a milestone";
const BUILTIN_REGULAR: &str = "Welcome back, {name}!";
const BUILTIN_MILESTONE: &str = "{name}'s {nth} stream with us! Thank you!";
const DEFAULT_REACTION_REGULAR: &str = "wave";
const DEFAULT_REACTION_MILESTONE: &str = "excited";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreviewKind {
    Regular,
    Milestone,
}

pub(super) struct CommunityPreview {
    preview: Entity<PetPreview>,
    said: Option<(PreviewKind, String)>,
    /// Last persona key the preview loaded, so a same persona skips a reload.
    loaded: Option<String>,
}

impl CommunityPreview {
    pub(super) fn new(cx: &mut Context<SidekickScreen>) -> Self {
        Self {
            preview: cx.new(|_| PetPreview::new(PREVIEW_PX, "Sidekick")),
            said: None,
            loaded: None,
        }
    }

    pub(super) fn set_active(&self, active: bool, cx: &mut Context<SidekickScreen>) {
        self.preview
            .update(cx, |preview, cx| preview.set_active(active, cx));
    }
}

impl SidekickScreen {
    pub(super) fn ensure_community_preview(&mut self, cx: &mut Context<Self>) {
        if self.community.as_ref().is_some_and(|c| c.preview.is_some()) {
            return;
        }
        let preview = CommunityPreview::new(cx);
        if let Some(community) = self.community.as_mut() {
            community.preview = Some(preview);
        }
    }

    /// Tick the living preview only while Sidekick is on screen on Community.
    pub(super) fn sync_community_preview_active(&mut self, cx: &mut Context<Self>) {
        let active = self.page_shown && self.tab == super::Tab::Community;
        if let Some(preview) = self
            .community
            .as_ref()
            .and_then(|community| community.preview.as_ref())
        {
            preview.set_active(active, cx);
        }
    }

    pub(super) fn render_community_preview(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.ensure_community_preview(cx);
        self.sync_community_preview_active(cx);
        let persona = self.settings.as_ref().and_then(|s| s.persona.clone());
        let local_dir = self.local_dir.clone();
        let Some(community) = self.community.as_mut() else {
            return div().into_any_element();
        };
        let Some(preview_ui) = community.preview.as_mut() else {
            return div().into_any_element();
        };
        let theme = theme::resolve(None, window, cx);
        let muted = hsla(theme.muted_foreground);
        sync_preview(
            &preview_ui.preview,
            persona.as_ref(),
            &local_dir,
            &mut preview_ui.loaded,
            cx,
        );
        let said = preview_ui.said.clone();
        let preview = preview_ui.preview.clone();
        let entity = cx.entity();
        let line = said
            .as_ref()
            .map(|(_, text)| text.clone())
            .unwrap_or_else(|| PICK_ONE.to_string());
        let line_muted = said.is_none();
        let avatar = if persona.is_some() {
            div()
                .size(px(PREVIEW_PX))
                .overflow_hidden()
                .rounded(px(radius::ROW))
                .child(preview)
                .into_any_element()
        } else {
            div()
                .size(px(PREVIEW_PX))
                .flex_shrink_0()
                .rounded(px(radius::ROW))
                .bg(hsla(theme.inset))
                .into_any_element()
        };

        PanelSection::new("sidekick-community-preview")
            .title(TITLE)
            .description(DESCRIPTION)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .child(avatar)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(8.))
                            .flex_1()
                            .min_w(px(0.))
                            .child(
                                div()
                                    .min_h(px(40.))
                                    .rounded(px(radius::ROW))
                                    .bg(hsla(theme.inset))
                                    .px(px(12.))
                                    .py(px(8.))
                                    .type_scale(text::META)
                                    .text_color(if line_muted {
                                        muted
                                    } else {
                                        hsla(theme.foreground)
                                    })
                                    .child(line),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_wrap()
                                    .gap(px(6.))
                                    .child(
                                        Button::new("community-preview-regular")
                                            .label(PLAY_WELCOME)
                                            .variant(ButtonVariant::Secondary)
                                            .size(ButtonSize::Xs)
                                            .on_click({
                                                let entity = entity.clone();
                                                move |_, _, cx| {
                                                    entity.update(cx, |screen, cx| {
                                                        screen.play_community_preview(
                                                            PreviewKind::Regular,
                                                            cx,
                                                        );
                                                    });
                                                }
                                            }),
                                    )
                                    .child(
                                        Button::new("community-preview-milestone")
                                            .label(PLAY_MILESTONE)
                                            .variant(ButtonVariant::Secondary)
                                            .size(ButtonSize::Xs)
                                            .on_click({
                                                let entity = entity.clone();
                                                move |_, _, cx| {
                                                    entity.update(cx, |screen, cx| {
                                                        screen.play_community_preview(
                                                            PreviewKind::Milestone,
                                                            cx,
                                                        );
                                                    });
                                                }
                                            }),
                                    ),
                            ),
                    ),
            )
            .into_any_element()
    }

    fn play_community_preview(&mut self, kind: PreviewKind, cx: &mut Context<Self>) {
        let welcomes = self
            .settings
            .as_ref()
            .and_then(|s| s.auto_chat.as_ref())
            .map(|auto| auto.greetings.welcomes.clone())
            .unwrap_or_default();
        let (text, reaction) = preview_words(&welcomes, kind);
        let Some(community) = self.community.as_mut() else {
            return;
        };
        let Some(preview_ui) = community.preview.as_mut() else {
            return;
        };
        preview_ui.said = Some((kind, text));
        if reaction != "none" {
            preview_ui.preview.update(cx, |preview, cx| {
                preview.react(&reaction, cx);
            });
        }
        cx.notify();
    }
}

fn sync_preview(
    preview: &Entity<PetPreview>,
    persona: Option<&CohostPersona>,
    user_data: &Path,
    loaded: &mut Option<String>,
    cx: &mut Context<SidekickScreen>,
) {
    let Some(persona) = persona else {
        if loaded.take().is_some() {
            preview.update(cx, |preview, cx| preview.clear(cx));
        }
        return;
    };
    let key = match &persona.avatar {
        BuddyAvatar::Alive { pack_id } => format!("alive:{}:{pack_id}", persona.id),
        BuddyAvatar::Still => format!("still:{}:{:?}", persona.id, persona.images),
    };
    if loaded.as_deref() == Some(key.as_str()) {
        return;
    }
    *loaded = Some(key);
    let user_data = user_data.to_path_buf();
    let persona = persona.clone();
    preview.update(cx, |preview, cx| {
        preview.set_label(SharedString::from(persona.name.clone()));
        preview.set_motion(persona.motion);
        match &persona.avatar {
            BuddyAvatar::Alive { pack_id } => {
                preview.show_pack(&user_data, &persona.id, pack_id, cx);
            }
            BuddyAvatar::Still => {
                let stills = still_pictures(&persona, &user_data);
                let key = format!("{}:{:?}", persona.id, persona.images);
                preview.show_still(key, stills, cx);
            }
        }
    });
}

fn still_pictures(persona: &CohostPersona, user_data: &Path) -> Vec<(String, gpui::ImageSource)> {
    ["idle", "talk", "laugh", "think"]
        .into_iter()
        .filter_map(|state| {
            let path = match state {
                "idle" => persona.images.idle.as_deref(),
                "talk" => persona.images.talk.as_deref(),
                "laugh" => persona.images.laugh.as_deref(),
                "think" => persona.images.think.as_deref(),
                _ => None,
            }
            .or(persona.images.idle.as_deref())
            .and_then(|picture| pictures::managed_path(user_data, picture));
            let picture = match path {
                Some(path) => path.into(),
                None => pictures::default_state(state)?.into(),
            };
            Some((state.to_string(), picture))
        })
        .collect()
}

fn preview_words(welcomes: &CohostWelcomes, kind: PreviewKind) -> (String, String) {
    let (line, builtin, default_reaction, samples): (&WelcomeLine, &str, &str, &[(&str, &str)]) =
        match kind {
            PreviewKind::Regular => (
                &welcomes.regular,
                BUILTIN_REGULAR,
                DEFAULT_REACTION_REGULAR,
                &[
                    ("name", "Ada"),
                    ("handle", "@ada"),
                    ("platform", "Twitch"),
                    ("nth", "14th"),
                    ("streams", "14"),
                    ("row", "5"),
                    ("since", "March 2026"),
                ],
            ),
            PreviewKind::Milestone => (
                &welcomes.milestone,
                BUILTIN_MILESTONE,
                DEFAULT_REACTION_MILESTONE,
                &[
                    ("name", "Kim"),
                    ("handle", "@kim"),
                    ("platform", "Twitch"),
                    ("nth", "10th"),
                    ("streams", "10"),
                    ("row", "3"),
                    ("since", "February 2026"),
                ],
            ),
        };
    let raw = line
        .text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or(builtin);
    let reaction = line
        .reaction
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or(default_reaction)
        .to_string();
    (fill_sample(raw, samples), reaction)
}

/// Electron `resolveGreetingPreview`: known braces fill, unknown stay
/// literal, `{ name }` trims, empty known fields drop, space runs collapse.
fn fill_sample(text: &str, samples: &[(&str, &str)]) -> String {
    let known: std::collections::BTreeMap<&str, &str> = samples.iter().copied().collect();
    let empty_known = [
        "months", "streak", "count", "amount", "reward", "away", "others",
    ];
    let resolved = regex_replace_fields(text, |field| {
        if let Some(value) = known.get(field) {
            return Some((*value).to_string());
        }
        if field == "names" {
            return known.get("name").map(|v| (*v).to_string());
        }
        if empty_known.contains(&field) {
            return Some(String::new());
        }
        None
    });
    resolved.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn regex_replace_fields(text: &str, mut fill: impl FnMut(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('}') {
            Some(end) if !after[..end].contains('{') => {
                let field = after[..end].trim();
                if let Some(value) = fill(field) {
                    out.push_str(&value);
                    rest = &after[end + 1..];
                    continue;
                }
                out.push('{');
                rest = after;
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}
