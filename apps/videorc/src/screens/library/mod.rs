//! Library projects app-core's list and action gates. The backend owns files,
//! pagination and finalization; this entity owns only the window's choices.
mod actions;
mod cloud;
pub mod files;
mod player;
mod render;

use gpui::{Context, Entity, FocusHandle, Focusable, Window, prelude::*};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    sync::Arc,
};
use videorc_app_core::library::{
    Library,
    page::{self as p, LibraryUi, LibraryView, MenuId},
    view as v,
};
use videorc_app_core::{
    BackendClient, Studio,
    studio::{StudioSnapshot, transport},
};
use videorc_kit::{command::InputEvent, dialog::DialogHandle, input::InputState};
use videorc_protocol::{CleanCutJob, RecordingStatus, SessionListItem};

pub type Core = Library<BackendClient, files::Files>;
#[derive(Clone)]
pub struct Navigate(pub videorc_app_core::nav::PageId);
pub struct LibraryScreen {
    pub(crate) core: Arc<Core>,
    pub(crate) files: Arc<files::Files>,
    studio: Arc<Studio<BackendClient>>,
    pub(crate) runtime: tokio::runtime::Handle,
    ui: LibraryUi,
    player: Entity<player::Player>,
    search: Entity<InputState>,
    rename_input: Entity<InputState>,
    rename_dialog: DialogHandle,
    delete_dialog: DialogHandle,
    focus: FocusHandle,
    busy: BTreeSet<String>,
    message: Option<String>,
    cloud: videorc_app_core::library::cloud::CloudTab,
    cloud_shown: bool,
    active: bool,
    cloud_loading: bool,
    cloud_signed_in: Option<bool>,
    cloud_busy: BTreeSet<String>,
    cloud_epoch: u64,
    posters: BTreeMap<(String, Option<i64>), Option<Arc<gpui::Image>>>,
}
impl gpui::EventEmitter<Navigate> for LibraryScreen {}
impl Focusable for LibraryScreen {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.focus.clone()
    }
}
impl LibraryScreen {
    pub fn new(
        core: Arc<Core>,
        files: Arc<files::Files>,
        studio: Arc<Studio<BackendClient>>,
        runtime: tokio::runtime::Handle,
        logger: videorc_app_core::Logger,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let player = cx.new(|cx| {
            player::Player::new(
                core.clone(),
                files.clone(),
                studio.clone(),
                runtime.clone(),
                logger,
                window,
                cx,
            )
        });
        let search = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(videorc_app_core::library::copy::SEARCH_PLACEHOLDER)
        });
        let rename_input = cx.new(|cx| InputState::new(window, cx));
        cx.subscribe(&search, |this, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.ui.change_view(
                    &this.core.data().sessions,
                    None,
                    Some(this.search.read(cx).value().to_string()),
                );
                cx.notify();
            }
        })
        .detach();
        cx.subscribe_in(
            &rename_input,
            window,
            |this, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::Change) {
                    if let Some(rename) = &mut this.ui.rename {
                        rename.draft = this.rename_input.read(cx).value().to_string();
                    }
                    cx.notify();
                }
                if matches!(event, InputEvent::PressEnter { .. }) && this.rename_dialog.is_open() {
                    this.rename(window, cx);
                }
            },
        )
        .detach();
        let mut events = studio.backend().subscribe();
        cx.spawn(async move |entity,cx| {
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => videorc_app_core::BackendEvent::ClientLagged { skipped },
                    Err(_) => break,
                };
                if matches!(&event, videorc_app_core::BackendEvent::Untyped{event,..} if event=="account.changed") || matches!(&event, videorc_app_core::BackendEvent::Ready(_) | videorc_app_core::BackendEvent::ConnectionClosed{..} | videorc_app_core::BackendEvent::ClientLagged{..} | videorc_app_core::BackendEvent::EventsLagged(_)) {
                    if entity.update(cx,|this,cx| {this.cloud_epoch+=1;this.cloud=Default::default();this.cloud_signed_in=None;if this.active&&this.cloud_shown{this.refresh_cloud(cx);}cx.notify();}).is_err(){break;}
                }
            }
        }).detach();
        let mut data = core.watch();
        let mut snapshots = studio.watch();
        cx.spawn(async move |entity, cx| {
            loop {
                tokio::select! {
                    changed = data.changed() => if changed.is_err() { break; },
                    changed = snapshots.changed() => if changed.is_err() { break; },
                }
                if entity
                    .update(cx, |this, cx| {
                        this.posters.retain(|(id, _), _| {
                            this.core.data().sessions.iter().any(|row| &row.id == id)
                        });
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        Self {
            core,
            files,
            studio,
            runtime,
            ui: LibraryUi::default(),
            player,
            search,
            rename_input,
            rename_dialog: DialogHandle::new(false),
            delete_dialog: DialogHandle::new(false),
            focus: cx.focus_handle(),
            busy: BTreeSet::new(),
            message: None,
            cloud: Default::default(),
            cloud_shown: false,
            active: false,
            cloud_loading: false,
            cloud_signed_in: None,
            cloud_busy: BTreeSet::new(),
            cloud_epoch: 0,
            posters: BTreeMap::new(),
        }
    }
    fn view(&self) -> LibraryView {
        let data = self.core.data();
        let snapshot = self.studio.snapshot();
        p::library_view(&p::ViewInput {
            data: data.facts(),
            session: &Session(&snapshot),
            clean_cut: &PendingCleanCut,
            ui: &self.ui,
            free_bytes: None,
            now: chrono::Utc::now(),
            clean_cuts: &[],
            noise_jobs: &data.noise_jobs,
            noise_premium_locked: Some("Noise cleanup needs Premium."),
        })
    }
    pub fn focus_session(&mut self, id: Option<&str>, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(id) = id {
            self.cloud_shown = false;
            self.core.cloud_view_shown(false);
            self.ui.focus_session(id);
            self.search
                .update(cx, |input, cx| input.set_value("", window, cx));
        }
        self.focus.focus(window, cx);
        cx.notify();
    }
    fn task<T: Send + 'static>(
        &self,
        future: impl Future<Output = Result<T, String>> + Send + 'static,
        done: impl FnOnce(&mut Self, Result<T, String>, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) {
        let task = self.runtime.spawn(future);
        cx.spawn(async move |entity, cx| {
            let result = task
                .await
                .unwrap_or_else(|_| Err("Couldn't finish that action. Try again.".into()));
            let _ = entity.update(cx, |this, cx| {
                done(this, result, cx);
                cx.notify();
            });
        })
        .detach();
    }
    fn pick(&mut self, id: &str, modifier: v::PickModifier, cx: &mut Context<Self>) {
        let view = self.view();
        let ordered = view.rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>();
        let selectable = view
            .rows
            .iter()
            .filter(|r| r.selectable)
            .map(|r| r.id.clone())
            .collect();
        self.ui.selection = v::pick_row(&self.ui.selection, id, modifier, &ordered, &selectable);
        self.ui.active = Some(id.into());
        cx.notify();
    }
    fn allowed(&self, id: &str, action: MenuId) -> bool {
        !self.busy.contains(id)
            && self
                .view()
                .rows
                .iter()
                .find(|row| row.id == id)
                .is_some_and(|row| {
                    !row.menu_disabled
                        && row
                            .menu
                            .iter()
                            .any(|item| item.id == action && !item.disabled)
                })
    }
    fn load(&mut self, all: bool, cx: &mut Context<Self>) {
        if self.ui.loading_all || self.core.data().loading_more || !self.core.data().online {
            return;
        }
        self.ui.loading_all = all;
        let core = self.core.clone();
        self.task(
            async move {
                loop {
                    let before = core.data().next_cursor;
                    if before.is_none() {
                        break;
                    }
                    core.load_more()
                        .await
                        .map_err(|_| "Couldn't load more recordings.".to_string())?;
                    if !all || core.data().next_cursor == before {
                        break;
                    }
                }
                Ok(())
            },
            |this, result, _| {
                this.ui.loading_all = false;
                this.message = result.err();
            },
            cx,
        );
    }
}
struct Session<'a>(&'a StudioSnapshot);
impl p::LibrarySession for Session<'_> {
    fn status(&self) -> &RecordingStatus {
        &self.0.session.status
    }
    fn status_pill(&self) -> (&'static str, p::StatusTone) {
        let (label, tone) = transport::session_status(&self.0.session, &self.0.connection);
        (
            label,
            match tone {
                transport::StatusTone::Neutral => p::StatusTone::Neutral,
                transport::StatusTone::Good => p::StatusTone::Good,
                transport::StatusTone::Live => p::StatusTone::Live,
                transport::StatusTone::Warn => p::StatusTone::Warn,
                transport::StatusTone::Error => p::StatusTone::Error,
            },
        )
    }
}
// Clean cut's controller is not installed in this window yet. Backend file
// actions still enforce job locks; do not invent eligibility or entitlements.
struct PendingCleanCut;
impl p::CleanCutRules for PendingCleanCut {
    fn is_active(&self, _: &CleanCutJob) -> bool {
        true
    }
    fn is_eligible(&self, _: &SessionListItem) -> bool {
        false
    }
    fn status_label(&self, _: &CleanCutJob, _: p::CleanCutCapture) -> String {
        String::new()
    }
}
