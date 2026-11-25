//! Sidekick → Clean cut: jobs, review, kept drafts (`cleanCut.*` +
//! `buddy::clean_cut_review` / `clean_cut_drafts`).

use std::path::PathBuf;

use gpui::{AnyElement, Context, Entity, Window, div, prelude::*, px};
use serde::Deserialize;
use videorc_app_core::buddy::clean_cut_drafts::{self, STORAGE_KEY};
use videorc_app_core::buddy::clean_cut_review::{
    self, Draft, effective_removals, kind_chips, toggle_kind_group, toggle_removal,
};
use videorc_app_core::buddy::copy as words;
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::input::{Input, InputState};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::settings_row::{SettingsGroup, SettingsRow};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{size, text};
use videorc_protocol::{
    CleanCutJob, CleanCutJobDetail, CleanCutJobState, CleanCutMode, CleanCutRemoval,
};

use super::SidekickScreen;
use super::live::{LiveView, UnlockAction};

const CLEAN_CUT: &str = "Clean cut";
const EVERY_RECORDING: &str = "Make a clean cut of every recording";
const RECORDINGS: &str = "Recordings";
const SEARCH_RECORDINGS: &str = "Search recordings…";
const NO_RECORDINGS: &str = "No recordings match";
const KIND_OF_CUT: &str = "Kind of cut";
const MAKE_CLEAN: &str = "Make a clean cut";
const MAKE_CONDENSED: &str = "Make a condensed cut";
const ALLOW_CLOUD: &str = "Allow cloud AI…";
const REVIEW: &str = "Review";
const CANCEL: &str = "Cancel";
const SAVE_CHANGES: &str = "Save changes";
const DISCARD: &str = "Discard";
const KINDS_OF_CUTS: &str = "Kinds of cuts";
const JOBS: &str = "Jobs";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingRow {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub started_at: Option<String>,
}

pub struct CleanCutState {
    pub jobs: Vec<CleanCutJob>,
    pub recordings: Vec<RecordingRow>,
    pub search: Entity<InputState>,
    pub mode: CleanCutMode,
    pub selected_session: Option<String>,
    pub review_job: Option<CleanCutJobDetail>,
    pub draft: Draft,
    pub saved_removals: Vec<CleanCutRemoval>,
    pub drafts_path: PathBuf,
    pub loaded: bool,
}

impl CleanCutState {
    pub fn new(
        local_dir: &std::path::Path,
        window: &mut Window,
        cx: &mut Context<SidekickScreen>,
    ) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder(SEARCH_RECORDINGS));
        cx.observe(&search, |_, _, cx| cx.notify()).detach();
        Self {
            jobs: Vec::new(),
            recordings: Vec::new(),
            search,
            mode: CleanCutMode::Clean,
            selected_session: None,
            review_job: None,
            draft: Draft::default(),
            saved_removals: Vec::new(),
            drafts_path: local_dir.join(format!("{STORAGE_KEY}.json")),
            loaded: false,
        }
    }

    pub fn load_drafts(&self) -> Vec<clean_cut_drafts::Stored> {
        let raw = std::fs::read_to_string(&self.drafts_path).ok();
        clean_cut_drafts::parse(raw.as_deref())
    }

    pub fn persist_drafts(&self, drafts: &[clean_cut_drafts::Stored]) {
        let _ = std::fs::write(&self.drafts_path, clean_cut_drafts::serialize(drafts));
    }
}

pub fn render_clean_cut(
    view: &LiveView,
    consented: bool,
    auto: bool,
    state: &CleanCutState,
    window: &mut Window,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let theme = theme::resolve(None, window, cx);
    let muted = hsla(theme.muted_foreground);
    let entity = cx.entity();
    let query = state.search.read(cx).value().to_string().to_lowercase();

    let mut lead = div().flex().flex_col().gap(px(8.)).p(px(size::GUTTER));
    if let Some(unlock) = view.unlock.as_ref() {
        let mut alert = Alert::new("sidekick-clean-cut-unlock")
            .variant(AlertVariant::Warning)
            .title(unlock.reason.clone());
        if let Some(action) = unlock.action {
            let label = match action {
                UnlockAction::SignIn => words::SIGN_IN,
                UnlockAction::ViewPremium => words::VIEW_PREMIUM,
            };
            alert = alert.action(
                Button::new("clean-cut-unlock-action")
                    .variant(ButtonVariant::Outline)
                    .size(ButtonSize::Xs)
                    .label(label)
                    .on_click(move |_, _, cx| match action {
                        UnlockAction::SignIn => {
                            eprintln!("[videorc-app] Sidekick Clean cut: Sign in (account UI next)")
                        }
                        UnlockAction::ViewPremium => cx.open_url("https://videorc.com/premium"),
                    }),
            );
        }
        lead = lead.child(alert);
    }
    if !consented {
        lead = lead.child(
            Alert::new("sidekick-clean-cut-consent")
                .variant(AlertVariant::Warning)
                .title("Clean cut needs cloud AI.")
                .action(
                    Button::new("clean-cut-allow-cloud")
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .label(ALLOW_CLOUD)
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| {
                                entity.update(cx, |screen, cx| screen.set_consent(true, cx));
                            }
                        }),
                ),
        );
    }

    let mode_value = state.mode.as_str();
    let settings = PanelSection::new("sidekick-clean-cut")
        .title(CLEAN_CUT)
        .child(
            SettingsGroup::new()
                .row(
                    SettingsRow::new("every-recording", EVERY_RECORDING).child(
                        Switch::new("every-recording")
                            .accessibility_label(EVERY_RECORDING)
                            .checked(auto)
                            .disabled(!consented)
                            .on_change({
                                let entity = entity.clone();
                                move |value, _, cx| {
                                    entity.update(cx, |screen, cx| {
                                        screen.set_clean_cut_auto(value, cx);
                                    });
                                }
                            }),
                    ),
                )
                .row(
                    SettingsRow::new("kind-of-cut", KIND_OF_CUT).child(
                        SegmentedControl::new("kind-of-cut")
                            .small(true)
                            .accessibility_label(KIND_OF_CUT)
                            .value(Some(mode_value))
                            .option(Segment::new("clean", "Clean"))
                            .option(Segment::new("condensed", "Condensed"))
                            .on_change({
                                let entity = entity.clone();
                                move |value, _, cx| {
                                    let mode = if value.as_ref() == "condensed" {
                                        CleanCutMode::Condensed
                                    } else {
                                        CleanCutMode::Clean
                                    };
                                    entity.update(cx, |screen, cx| {
                                        if let Some(clean) = screen.clean_cut.as_mut() {
                                            clean.mode = mode;
                                        }
                                        cx.notify();
                                    });
                                }
                            }),
                    ),
                ),
        )
        .child(
            Button::new("make-clean-cut")
                .variant(ButtonVariant::Default)
                .label(if state.mode == CleanCutMode::Condensed {
                    MAKE_CONDENSED
                } else {
                    MAKE_CLEAN
                })
                .disabled(!consented || state.selected_session.is_none())
                .on_click({
                    let entity = entity.clone();
                    move |_, _, cx| {
                        entity.update(cx, |screen, cx| screen.start_clean_cut(cx));
                    }
                }),
        );

    let mut recording_list = GroupedList::new().label(RECORDINGS);
    let matched: Vec<_> = state
        .recordings
        .iter()
        .filter(|row| {
            query.is_empty()
                || row.title.to_lowercase().contains(&query)
                || row.id.to_lowercase().contains(&query)
        })
        .collect();
    if matched.is_empty() {
        recording_list =
            recording_list.row(ListRow::new("no-recordings", NO_RECORDINGS).compact(true));
    } else {
        for row in matched {
            let id = row.id.clone();
            let selected = state.selected_session.as_deref() == Some(row.id.as_str());
            let title = if row.title.trim().is_empty() {
                row.id.clone()
            } else {
                row.title.clone()
            };
            recording_list = recording_list.row(
                ListRow::new(format!("rec-{}", row.id), title)
                    .compact(true)
                    .meta(if selected { "Selected" } else { "" })
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |screen, cx| {
                                if let Some(clean) = screen.clean_cut.as_mut() {
                                    clean.selected_session = Some(id.clone());
                                }
                                cx.notify();
                            });
                        }
                    }),
            );
        }
    }
    let recordings = PanelSection::new("sidekick-clean-cut-recordings")
        .title(RECORDINGS)
        .child(Input::new("clean-cut-search", &state.search).accessibility_label(SEARCH_RECORDINGS))
        .child(recording_list);

    let mut jobs_list = GroupedList::new().label(JOBS);
    if state.jobs.is_empty() {
        jobs_list = jobs_list.row(ListRow::new("no-jobs", "No clean cuts yet.").compact(true));
    } else {
        for job in &state.jobs {
            let job_id = job.id.clone();
            let label = format!(
                "{} · {} · {}",
                job.mode.as_str(),
                job.state.as_str(),
                job.source_session_id
            );
            let busy = job.state.is_active();
            let ready = job.state == CleanCutJobState::Ready;
            let action = if ready {
                Button::new(format!("review-{}", job.id))
                    .variant(ButtonVariant::Outline)
                    .size(ButtonSize::Xs)
                    .label(REVIEW)
                    .on_click({
                        let entity = entity.clone();
                        let job_id = job_id.clone();
                        move |_, _, cx| {
                            entity.update(cx, |screen, cx| {
                                screen.open_clean_cut_review(job_id.clone(), cx);
                            });
                        }
                    })
                    .into_any_element()
            } else if busy {
                Button::new(format!("cancel-{}", job.id))
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Xs)
                    .label(CANCEL)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |screen, cx| {
                                screen.cancel_clean_cut(job_id.clone(), cx);
                            });
                        }
                    })
                    .into_any_element()
            } else {
                div().into_any_element()
            };
            jobs_list = jobs_list.row(
                ListRow::new(format!("job-{}", job.id), label)
                    .compact(true)
                    .context(format!("{:.0}%", job.progress * 100.0))
                    .child(action),
            );
        }
    }
    let jobs = PanelSection::new("sidekick-clean-cut-jobs")
        .title(JOBS)
        .child(jobs_list);

    let review = if let Some(detail) = state.review_job.as_ref() {
        render_review(detail, state, muted, cx)
    } else {
        div().into_any_element()
    };

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
                .child(settings)
                .child(recordings)
                .child(jobs)
                .child(review),
        )
        .into_any_element()
}

fn render_review(
    detail: &CleanCutJobDetail,
    state: &CleanCutState,
    muted: gpui::Hsla,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let entity = cx.entity();
    let job_id = detail.job.id.clone();
    let saved = state.saved_removals.clone();
    let effective = effective_removals(&saved, &state.draft);
    let chips = kind_chips(&effective);
    let changes = state.draft.change_count();

    let mut chip_row = div().flex().flex_wrap().gap(px(6.));
    for chip in &chips {
        let group = chip.group;
        let label = format!("{} {}", group.label, chip.count_label());
        chip_row = chip_row.child(
            Button::new(format!("kind-{}", group.id.as_str()))
                .variant(ButtonVariant::Outline)
                .size(ButtonSize::Xs)
                .label(label)
                .disabled(chip.total == 0)
                .on_click({
                    let entity = entity.clone();
                    let saved = saved.clone();
                    move |_, _, cx| {
                        entity.update(cx, |screen, cx| {
                            if let Some(clean) = screen.clean_cut.as_mut() {
                                clean.draft = toggle_kind_group(&clean.draft, &saved, group.id);
                                screen.persist_clean_cut_draft(cx);
                            }
                            cx.notify();
                        });
                    }
                }),
        );
    }

    let mut removals = div().flex().flex_col().gap(px(4.));
    for removal in effective.iter().take(40) {
        let id = removal.id.clone();
        let title = clean_cut_review::removal_title(removal, removal.enabled);
        removals = removals.child(
            ListRow::new(format!("removal-{id}"), title)
                .compact(true)
                .context(format!("{}–{} ms", removal.start_ms, removal.end_ms))
                .child(
                    Button::new(format!("toggle-{id}"))
                        .variant(ButtonVariant::Ghost)
                        .size(ButtonSize::Xs)
                        .label(if removal.enabled { "Keep" } else { "Cut" })
                        .on_click({
                            let entity = entity.clone();
                            let saved = saved.clone();
                            move |_, _, cx| {
                                entity.update(cx, |screen, cx| {
                                    if let Some(clean) = screen.clean_cut.as_mut() {
                                        clean.draft = toggle_removal(&clean.draft, &saved, &id);
                                        screen.persist_clean_cut_draft(cx);
                                    }
                                    cx.notify();
                                });
                            }
                        }),
                ),
        );
    }
    if effective.is_empty() {
        removals = removals.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child("No removals in this cut."),
        );
    }

    PanelSection::new("sidekick-clean-cut-review")
        .title(format!("Review · {}", detail.job.id))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(KINDS_OF_CUTS),
                )
                .child(chip_row)
                .child(removals)
                .child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .child(
                            Button::new("save-clean-cut")
                                .variant(ButtonVariant::Default)
                                .label(SAVE_CHANGES)
                                .disabled(changes == 0)
                                .on_click({
                                    let entity = entity.clone();
                                    let job_id = job_id.clone();
                                    move |_, _, cx| {
                                        entity.update(cx, |screen, cx| {
                                            screen.save_clean_cut_review(job_id.clone(), cx);
                                        });
                                    }
                                }),
                        )
                        .child(
                            Button::new("discard-clean-cut")
                                .variant(ButtonVariant::Ghost)
                                .label(DISCARD)
                                .on_click({
                                    let entity = entity.clone();
                                    move |_, _, cx| {
                                        entity.update(cx, |screen, cx| {
                                            screen.discard_clean_cut_review(cx);
                                        });
                                    }
                                }),
                        ),
                ),
        )
        .into_any_element()
}
