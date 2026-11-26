use super::*;
use videorc_app_core::{
    library::copy,
    resources::{
        capability::{IssueOptions, ResourceKind},
        issue_capability,
    },
};
impl LibraryScreen {
    /// Open in Stream Manager (`openSessionCommentsWindow`): this stream's
    /// saved chat (`sessions.comments.history`) in the Stream Manager's
    /// History, the window opened if it is closed.
    fn open_in_stream_manager(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(row) = self.view().rows.into_iter().find(|r| r.id == id) else {
            return;
        };
        let title = row.title.clone();
        let started = row.meta.split(" · ").next().unwrap_or_default().to_string();
        let backend = self.studio.backend().clone();
        let session_id = id.clone();
        self.task(
            async move {
                let raw = backend
                    .request(
                        "sessions.comments.history",
                        serde_json::json!({ "sessionId": session_id }),
                    )
                    .await
                    .map_err(|_| "Couldn't open this stream's chat.".to_string())?;
                let messages: Vec<videorc_app_core::chat::model::LiveChatMessage> =
                    serde_json::from_value(raw.get("messages").cloned().unwrap_or_default())
                        .map_err(|_| "Couldn't read this stream's chat.".to_string())?;
                Ok(messages)
            },
            move |this, result, cx| match result {
                Ok(messages) => {
                    crate::screens::stream_manager::window::show(cx);
                    if let Some(window) = crate::screens::stream_manager::window::view(cx) {
                        let _ = window.update(cx, |manager, _, cx| {
                            manager.open_history(id, title, started, messages, cx)
                        });
                    }
                }
                Err(error) => this.message = Some(error),
            },
            cx,
        );
    }

    pub(super) fn action(
        &mut self,
        id: String,
        action: MenuId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.allowed(&id, action) {
            return;
        }
        self.message = None;
        match action {
            MenuId::Rename => {
                let Some(row) = self.view().rows.into_iter().find(|r| r.id == id) else {
                    return;
                };
                self.ui.rename = Some(p::RenameState {
                    session_id: id,
                    draft: row.title.clone(),
                    error: None,
                });
                self.rename_input
                    .update(cx, |input, cx| input.set_value(row.title, window, cx));
                self.rename_dialog.open(window, cx);
                cx.on_next_frame(window, |this, window, cx| {
                    this.rename_input
                        .read(cx)
                        .focus_handle(cx)
                        .focus(window, cx)
                });
            }
            MenuId::Delete => self.ask_delete(vec![id], window, cx),
            MenuId::Play => self.external_recording(id, cx),
            MenuId::BuddyReport => cx.emit(OpenSidekickReport(id)),
            MenuId::StreamManager => self.open_in_stream_manager(id, cx),
            MenuId::Markers => {
                if let Some(session) = self
                    .core
                    .data()
                    .sessions
                    .into_iter()
                    .find(|row| row.id == id)
                {
                    self.player
                        .update(cx, |player, cx| player.open(&session, window, cx));
                }
            }
            MenuId::Reveal => {
                let files = self.files.clone();
                let reveal = action == MenuId::Reveal;
                self.task(
                    async move { files.path(&id).await },
                    move |this, result, cx| match result {
                        Ok(path) => {
                            if reveal {
                                cx.reveal_path(&path)
                            } else {
                                cx.open_with_system(&path)
                            }
                        }
                        Err(_) => this.message = Some("Couldn't open the recording.".into()),
                    },
                    cx,
                );
            }
            MenuId::Duplicate
            | MenuId::ExportMp4
            | MenuId::Check
            | MenuId::Repair
            | MenuId::Restore => {
                self.busy.insert(id.clone());
                if action == MenuId::Duplicate {
                    self.ui.duplicating.insert(id.clone());
                }
                if matches!(action, MenuId::Check | MenuId::Repair) {
                    self.ui.repairs.entry(id.clone()).or_default().phase =
                        if action == MenuId::Check {
                            p::RepairPhase::Checking
                        } else {
                            p::RepairPhase::Repairing
                        };
                }
                let core = self.core.clone();
                let target = id.clone();
                self.task(
                    async move {
                        let result = match action {
                            MenuId::Duplicate => core.duplicate(&target).await.map(|_| None),
                            MenuId::ExportMp4 => core.remux(&target).await.map(|_| None),
                            MenuId::Check => core.assess(&target).await.map(Some),
                            MenuId::Repair => core.repair(&target).await.map(|_| None),
                            MenuId::Restore => core.restore(&target).await.map(|_| None),
                            _ => unreachable!(),
                        };
                        result.map_err(|_| "Couldn't finish that action. Try again.".into())
                    },
                    move |this, result, _| {
                        this.busy.remove(&id);
                        this.ui.duplicating.remove(&id);
                        this.ui.repairs.entry(id.clone()).or_default().phase = p::RepairPhase::Idle;
                        match result {
                            Ok(Some(assessment)) => {
                                this.ui.repairs.insert(
                                    id,
                                    p::RowRepair {
                                        phase: p::RepairPhase::Assessed,
                                        repairable: assessment.repairable,
                                        has_backup: assessment.has_backup,
                                    },
                                );
                                this.message = assessment.first_reason();
                            }
                            Ok(None) => {}
                            Err(error) => this.message = Some(error),
                        }
                    },
                    cx,
                );
            }
            _ => {}
        }
        cx.notify();
    }
    pub(super) fn external_recording(&mut self, id: String, cx: &mut Context<Self>) {
        if !self.allowed(&id, MenuId::Play) {
            return;
        }
        let files = self.files.clone();
        self.task(
            async move { files.path(&id).await },
            |this, result, cx| match result {
                Ok(path) => cx.open_with_system(&path),
                Err(_) => this.message = Some("Couldn't open the recording.".into()),
            },
            cx,
        );
    }
    pub(super) fn ask_delete(
        &mut self,
        ids: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let rows = self.view().rows;
        let rows = rows
            .into_iter()
            .filter(|row| ids.contains(&row.id) && self.allowed(&row.id, MenuId::Delete))
            .collect::<Vec<_>>();
        if rows.is_empty() {
            return;
        }
        self.ui.delete = Some(p::DeleteState {
            ids: rows.iter().map(|r| r.id.clone()).collect(),
            titles: rows.into_iter().map(|r| r.title).collect(),
            pending: false,
        });
        self.delete_dialog.open(window, cx);
        cx.notify();
    }
    pub(super) fn delete(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(question) = self.ui.delete.as_ref() else {
            return;
        };
        if question.pending
            || question
                .ids
                .iter()
                .any(|id| !self.allowed(id, MenuId::Delete))
        {
            return;
        }
        let ids = question.ids.clone();
        self.ui.delete.as_mut().unwrap().pending = true;
        self.busy.extend(ids.iter().cloned());
        // Close the question while the receipt is pending. No repeated confirm,
        // and Escape cannot turn an operation already sent into a cancellation.
        self.delete_dialog.close(window, cx);
        let core = self.core.clone();
        let targets = ids.clone();
        self.task(async move {core.delete(&targets).await.map_err(|_|"Couldn't move all the recordings to the Trash. The remaining files are still in Library.".into())},move |this,result,_| {for id in ids{this.busy.remove(&id);} this.ui.delete=None;this.ui.selection.selected.clear();this.message=result.err();},cx);
    }
    pub(super) fn rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(rename) = self.ui.rename.as_ref() else {
            return;
        };
        if rename.draft.trim().is_empty() || !self.allowed(&rename.session_id, MenuId::Rename) {
            return;
        }
        let id = rename.session_id.clone();
        let title = rename.draft.trim().to_owned();
        let core = self.core.clone();
        let target = id.clone();
        self.busy.insert(id.clone());
        self.rename_dialog.close(window, cx);
        self.task(
            async move {
                core.rename(&target, &title)
                    .await
                    .map_err(|_| "Couldn't rename the recording.".into())
            },
            move |this, result, _| {
                this.busy.remove(&id);
                this.message = result.err();
            },
            cx,
        );
    }
    pub(super) fn import(&mut self, cx: &mut Context<Self>) {
        if self.ui.importing || !self.core.data().online {
            return;
        }
        self.ui.importing = true;
        cx.notify();
        let picked = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(copy::IMPORT.into()),
        });
        cx.spawn(async move |entity, cx| {
            let paths = picked.await;
            let _ = entity.update(cx, |this, cx| {
                let Ok(Ok(Some(paths))) = paths else {
                    this.ui.importing = false;
                    cx.notify();
                    return;
                };
                let Some(path) = paths.into_iter().next() else {
                    this.ui.importing = false;
                    return;
                };
                let core = this.core.clone();
                let files = this.files.clone();
                let folder = this
                    .studio
                    .snapshot()
                    .recordings_folder
                    .folder
                    .map(|f| f.path);
                this.task(
                    async move {
                        let bootstrap = files.bootstrap()?;
                        let (_, input) = issue_capability(
                            &bootstrap,
                            &path,
                            ResourceKind::InputFile,
                            IssueOptions::default(),
                        )
                        .await?;
                        let output = if let Some(folder) = folder {
                            Some(
                                issue_capability(
                                    &bootstrap,
                                    &folder,
                                    ResourceKind::OutputDirectory,
                                    IssueOptions::default(),
                                )
                                .await?
                                .1,
                            )
                        } else {
                            None
                        };
                        core.import(
                            &input.capability_id,
                            output.as_ref().map(|cap| cap.capability_id.as_str()),
                        )
                        .await
                        .map_err(|_| "Couldn't import the recording.".into())
                    },
                    |this, result, _| {
                        this.ui.importing = false;
                        match result {
                            Ok(Some(id)) => this.ui.focus_session(&id),
                            Ok(None) => {}
                            Err(_) => this.message = Some("Couldn't import the recording.".into()),
                        }
                    },
                    cx,
                );
            });
        })
        .detach();
    }
}
