use super::*;
use gpui::{SharedString, div, px};
use videorc_app_core::library::cloud as c;
use videorc_kit::{
    alert::Alert,
    button::Button,
    empty::Empty,
    kebab_menu::{KebabMenu, KebabMenuItem},
    list_row::{GroupedList, GroupedRow, ListRow},
    page_tabs::PageTabs,
    scroll_area::ScrollArea,
};
impl LibraryScreen {
    /// `PageTabs`: Local | Cloud in the strip under the toolbar, and the
    /// region under it.
    pub(super) fn tabs(&self, cx: &mut Context<Self>) -> PageTabs {
        let entity = cx.entity();
        PageTabs::new("library-tabs", videorc_app_core::library::copy::VIEW_LABEL)
            .tab(c::LOCAL_VIEW)
            .tab(c::CLOUD_VIEW)
            .selected(usize::from(self.cloud_shown))
            .on_select(move |index, _, cx| {
                entity.update(cx, |this, cx| {
                    let shown = index == 1;
                    if this.cloud_shown != shown {
                        this.cloud_shown = shown;
                        this.core.cloud_view_shown(this.active && shown);
                        if shown {
                            this.refresh_cloud(cx);
                        }
                        cx.notify();
                    }
                })
            })
    }
    pub fn set_active(&mut self, active: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.active = active;
        if !active {
            self.player
                .update(cx, |player, cx| player.dismiss(window, cx));
        }
        self.core.cloud_view_shown(active && self.cloud_shown);
        if active && self.cloud_shown {
            self.refresh_cloud(cx);
        }
        cx.notify();
    }
    pub(super) fn refresh_cloud(&mut self, cx: &mut Context<Self>) {
        self.refresh_cloud_quiet(false, cx);
    }
    pub(super) fn refresh_cloud_quiet(&mut self, quiet: bool, cx: &mut Context<Self>) {
        if self.cloud_loading || !self.core.data().online {
            return;
        }
        self.cloud_loading = true;
        self.cloud.begin_refresh(quiet);
        let epoch = self.cloud_epoch;
        let backend = self.studio.backend().clone();
        self.task(
            async move {
                let raw = backend
                    .request("account.get", serde_json::json!({}))
                    .await
                    .map_err(|_| "Couldn't load your cloud recordings.".to_string())?;
                let account: videorc_protocol::VideorcAccountSnapshot = serde_json::from_value(raw)
                    .map_err(|_| "Couldn't read your account.".to_string())?;
                let signed_in = account.status == videorc_protocol::AccountStatus::SignedIn;
                let rows = if signed_in {
                    c::list_cloud_recordings(backend.as_ref())
                        .await
                        .map_err(|_| "Couldn't load your cloud recordings.".to_string())?
                } else {
                    Vec::new()
                };
                Ok((signed_in, rows))
            },
            move |this, result, cx| {
                this.cloud_loading = false;
                if epoch != this.cloud_epoch {
                    if this.active && this.cloud_shown {
                        this.refresh_cloud(cx);
                    }
                    return;
                }
                match result {
                    Ok((signed_in, rows)) => {
                        this.cloud_signed_in = Some(signed_in);
                        this.cloud.refreshed(&rows);
                    }
                    Err(error) => this.cloud.refresh_failed(quiet, &error),
                }
                this.ensure_cloud_poll(cx);
            },
            cx,
        );
    }
    pub(super) fn ensure_cloud_poll(&mut self, cx: &mut Context<Self>) {
        let now_ms = chrono::Utc::now().timestamp_millis();
        if self.cloud_poll_running
            || !self.active
            || !self.cloud_shown
            || !self.cloud.should_poll(
                self.cloud_signed_in == Some(true),
                self.core.data().online,
                now_ms,
            )
        {
            return;
        }
        self.cloud_poll_running = true;
        let runtime = self.runtime.clone();
        cx.spawn(async move |entity, cx| {
            loop {
                let delay = runtime.spawn(async {
                    tokio::time::sleep(std::time::Duration::from_millis(
                        c::CLOUD_RECORDING_POLL_MS as u64,
                    ))
                    .await;
                });
                let _ = delay.await;
                let keep_going = entity
                    .update(cx, |this, cx| {
                        let now_ms = chrono::Utc::now().timestamp_millis();
                        let should = this.active
                            && this.cloud_shown
                            && this.cloud.should_poll(
                                this.cloud_signed_in == Some(true),
                                this.core.data().online,
                                now_ms,
                            );
                        if should {
                            this.refresh_cloud_quiet(true, cx);
                        } else {
                            this.cloud_poll_running = false;
                        }
                        should
                    })
                    .unwrap_or(false);
                if !keep_going {
                    break;
                }
            }
        })
        .detach();
    }
    fn cloud_action(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.cloud_signed_in != Some(true) || self.cloud_busy.contains(&id) {
            return;
        }
        let data = self.core.data();
        let Some(row) = self
            .cloud
            .recordings
            .as_ref()
            .and_then(|rows| rows.iter().find(|row| row.id == id))
        else {
            return;
        };
        let view = c::cloud_row_view(
            row,
            data.cloud_downloads.get(&id),
            chrono::Utc::now().timestamp_millis(),
        );
        let Some(action) = view.action else {
            return;
        };
        if action.needs_backend() && !data.online {
            return;
        }
        match action {
            c::CloudRowAction::OpenLocal => {
                if let c::CloudRowStatus::Downloaded {
                    local_session_id: Some(session),
                    ..
                } = view.status
                {
                    self.cloud_shown = false;
                    self.core.cloud_view_shown(false);
                    self.focus_session(Some(&session), window, cx);
                }
            }
            c::CloudRowAction::Download | c::CloudRowAction::Retry => {
                let core = self.core.clone();
                let files = self.files.clone();
                let folder = self
                    .studio
                    .snapshot()
                    .recordings_folder
                    .folder
                    .map(|f| f.path);
                let target = id.clone();
                self.cloud_busy.insert(id.clone());
                self.task(async move {let output=if let Some(folder)=folder{Some(videorc_app_core::resources::issue_capability(&files.bootstrap()?,&folder,videorc_app_core::resources::capability::ResourceKind::OutputDirectory,Default::default()).await?.1)}else{None};core.start_cloud_download(&target,output.as_ref().map(|cap|cap.capability_id.as_str())).await.map_err(|_|"Couldn't download the cloud recording.".into())},move|this,result,_|{this.cloud_busy.remove(&id);this.message=result.err();},cx);
            }
            c::CloudRowAction::Cancel => {
                if let c::CloudRowStatus::Downloading { job_id, .. } = view.status {
                    let core = self.core.clone();
                    self.cloud_busy.insert(id.clone());
                    self.task(
                        async move {
                            core.cancel_cloud_download(&job_id)
                                .await
                                .map_err(|_| "Couldn't cancel the download.".into())
                        },
                        move |this, result, _| {
                            this.cloud_busy.remove(&id);
                            this.message = result.err();
                        },
                        cx,
                    );
                }
            }
            // Saved downloads with no local session need the admin download
            // resolver; never treat a backend-supplied path as a renderer URL.
            c::CloudRowAction::Reveal | c::CloudRowAction::OpenWeb => {}
        }
        cx.notify();
    }
    pub(super) fn cloud_body(&mut self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let data = self.core.data();
        let view = c::cloud_tab_view(
            &self.cloud,
            &data.cloud_downloads,
            self.cloud_signed_in.unwrap_or(true),
            data.online,
            None,
            chrono::Utc::now().timestamp_millis(),
        );
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(c::TITLE)
            .child(c::DESCRIPTION)
            .child(
                Button::new("cloud-refresh")
                    .label(view.refresh_label)
                    .disabled(!view.refresh_enabled || self.cloud_loading)
                    .on_click(cx.listener(|this, _, _, cx| this.refresh_cloud(cx))),
            );
        if let Some(message) = &self.message {
            body = body.child(Alert::new("cloud-action-error").title(message.clone()));
        }
        if view.offline_alert {
            body = body.child(Alert::new("cloud-offline").title("Videorc is reconnecting…"));
        }
        body = match view.body {
            c::CloudBody::SignIn => body.child(
                Alert::new("cloud-sign-in").title(c::SIGN_IN_REASON).action(
                    Button::new("cloud-account")
                        .label("Sign in")
                        .on_click(cx.listener(|_, _, _, cx| {
                            cx.emit(Navigate(videorc_app_core::nav::PageId::Settings))
                        })),
                ),
            ),
            c::CloudBody::Loading => body.child(
                videorc_kit::spinner::Spinner::new("cloud-loading").accessibility_label(c::LOADING),
            ),
            c::CloudBody::Failed(error) => body.child(
                Alert::new("cloud-error").title(error).action(
                    Button::new("cloud-retry")
                        .label(c::TRY_AGAIN)
                        .on_click(cx.listener(|this, _, _, cx| this.refresh_cloud(cx))),
                ),
            ),
            c::CloudBody::Empty => body.child(
                Empty::new()
                    .title(c::EMPTY_TITLE)
                    .description(c::EMPTY_DESCRIPTION),
            ),
            _ => body,
        };
        let mut rows = GroupedList::new();
        for (item, row) in view.rows {
            let take_label = c::cloud_take_label(&item);
            let mut line = ListRow::new(
                SharedString::from(format!("cloud-row-inner-{}", item.id)),
                take_label.clone(),
            )
            .context(c::cloud_orientation_label(&item.orientation))
            .meta(row.status_label.clone());
            if let Some(action) = row.action {
                let id = item.id.clone();
                let unavailable = matches!(
                    action,
                    c::CloudRowAction::Reveal | c::CloudRowAction::OpenWeb
                );
                line = line.child(
                    Button::new(SharedString::from(format!("cloud-action-{id}")))
                        .label(action.label())
                        .accessibility_label(action.aria_label())
                        .disabled(
                            unavailable
                                || self.cloud_busy.contains(&id)
                                || action.needs_backend() && !data.online,
                        )
                        .tooltip(if unavailable {
                            "This action isn't available in this window yet."
                        } else {
                            action.tooltip()
                        })
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.cloud_action(id.clone(), window, cx)
                        })),
                );
            }
            // `cloudRowMenu`'s Show markers (P1363); the row's other menu
            // items stay on its button above.
            let show = item.show_id.clone();
            let entity = cx.entity();
            line = line.child(
                KebabMenu::new(
                    SharedString::from(format!("cloud-menu-{}", item.id)),
                    vec![
                        KebabMenuItem::new("markers", c::SHOW_MARKERS, move |window, cx| {
                            let show = show.clone();
                            entity.update(cx, |this, cx| this.open_markers(show, window, cx));
                        })
                        .disabled(!data.online || item.show_id.is_empty()),
                    ],
                )
                .label(c::ROW_MENU_LABEL),
            );
            rows = rows.item(
                div()
                    .id(SharedString::from(format!("cloud-row-{}", item.id)))
                    .role(gpui::Role::ListItem)
                    .aria_label(SharedString::from(format!(
                        "{take_label} · {}",
                        row.status_label
                    )))
                    .child(line.grouped()),
            );
        }
        body = body.child(rows);
        if let Some(footer) = view.footer {
            body = body.child(footer);
        }
        ScrollArea::new("cloud-library-scroll")
            .child(body)
            .into_any_element()
    }
}
