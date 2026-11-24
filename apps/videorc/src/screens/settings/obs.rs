use super::*;
use gpui::{AnyElement, SharedString};
use videorc_app_core::desktop::camera_extension::admin_request;
use videorc_app_core::settings_page::obs_import::{self as o, copy as c};
use videorc_app_core::studio::{
    recordings_folder::StoredFolder,
    settings::{SettingWrite, keys},
};
use videorc_kit::{
    button::{Button, ButtonVariant},
    dialog::{Dialog, DialogSize},
    select::Select,
};

pub(super) struct ObsImport {
    pub state: o::ObsDialogState,
    pub dialog: DialogHandle,
    error: Option<String>,
}
impl Default for ObsImport {
    fn default() -> Self {
        Self {
            state: o::ObsDialogState::default(),
            dialog: DialogHandle::new(false),
            error: None,
        }
    }
}
struct Quality;
impl o::QualityLabel for Quality {
    fn video_quality_full(&self, width: u32, height: u32, fps: u32) -> String {
        videorc_app_core::account::entitlements::format_video_quality_full(width, height, fps, None)
    }
}
impl SettingsScreen {
    fn obs_plan(&self) -> Option<o::ObsImportPlan> {
        let setup = self.obs.state.setup()?;
        let mut plan = o::map_obs_setup(
            setup,
            &self.studio.snapshot().sources.devices.devices,
            None,
            &Quality,
        );
        // The core's Assets registry adapter has not landed. Say that in the
        // report rather than blaming a readable image or promising an apply.
        for source in &setup.sources {
            if source.kind == "image" {
                for line in &mut plan.report {
                    if line.subject == source.name
                        && line.note.starts_with("The image couldn't be copied")
                    {
                        line.note = view::NOT_IN_THIS_BUILD.into();
                    }
                }
            }
        }
        Some(plan)
    }

    pub(super) fn open_obs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.disabled()
            || self.obs.state.applying
            || self.studio.snapshot().session.phase.is_active()
        {
            return;
        }
        self.obs.state.opened();
        self.obs.error = None;
        self.obs.dialog.open(window, cx);
        let ticket = self.obs.state.read_ticket;
        let bootstrap = self.backend.borrow().bootstrap().cloned();
        let job = self.runtime.spawn(async move {
            let bootstrap = bootstrap.ok_or(c::NO_ANSWER)?;
            let value = admin_request(&bootstrap, "obs.discover", json!({}), o::OBS_IMPORT_TIMEOUT)
                .await
                .map_err(|_| c::NO_ANSWER)?;
            serde_json::from_value::<o::ObsDiscovery>(value).map_err(|_| c::NO_ANSWER)
        });
        cx.spawn(async move |entity, cx| {
            let answer = job.await.ok().and_then(Result::ok);
            let _ = entity.update(cx, |this, cx| {
                if !this.obs.dialog.is_open() || this.obs.state.read_ticket != ticket {
                    return;
                }
                if let Some(found) = answer {
                    let read = this.obs.state.discovered(found);
                    this.read_obs(read, cx);
                } else {
                    this.obs.state.discovery = o::DiscoveryState::Failed(c::NO_ANSWER.into());
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn read_obs(&mut self, read: Option<(String, String, u64)>, cx: &mut Context<Self>) {
        let Some((collection, profile, ticket)) = read else {
            return;
        };
        let bootstrap = self.backend.borrow().bootstrap().cloned();
        let studio = self.studio.clone();
        let job = self.runtime.spawn(async move {
            let bootstrap = bootstrap.ok_or(c::NO_ANSWER.to_string())?;
            studio.refresh_sources().await.ok();
            let value = admin_request(
                &bootstrap,
                "obs.read",
                json!({"collection":collection,"profile":profile}),
                o::OBS_IMPORT_TIMEOUT,
            )
            .await
            .map_err(|_| c::PROFILE_UNREADABLE.to_string())?;
            let mut setup: Option<o::ObsSetup> =
                serde_json::from_value(value).map_err(|_| c::PROFILE_UNREADABLE.to_string())?;
            if let Some(setup) = &mut setup {
                if let Some(path) = setup.recording_path.take() {
                    let path = PathBuf::from(path);
                    if let Ok(selection) =
                        videorc_app_core::resources::authorize_output_directory(&bootstrap, &path)
                            .await
                    {
                        setup.recording_directory = Some(o::RecordingDirectory {
                            path,
                            display_name: selection.display_name,
                        });
                    }
                }
            }
            Ok(setup)
        });
        cx.spawn(async move |entity, cx| {
            let answer = job
                .await
                .unwrap_or_else(|_| Err(c::PROFILE_UNREADABLE.into()));
            let _ = entity.update(cx, |this, cx| {
                if this.obs.dialog.is_open() {
                    this.obs.state.read_answered(ticket, answer);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn apply_obs(&mut self, cx: &mut Context<Self>) {
        if self.disabled()
            || !self.obs.dialog.is_open()
            || self.obs.state.applying
            || self.studio.snapshot().session.phase.is_active()
        {
            return;
        }
        let Some(plan) = self.obs_plan() else {
            return;
        };
        let Some(profile) = self.obs.state.profile.clone() else {
            return;
        };
        let Some(bootstrap) = self.backend.borrow().bootstrap().cloned() else {
            return;
        };
        self.obs.state.applying = true;
        self.busy = true;
        self.obs.error = None;
        let studio = self.studio.clone();
        let generation = studio.snapshot().connection_generation;
        let job = self.runtime.spawn(async move {
            // Never store or log the raw key in UI state. Fetch only on consent.
            let raw_key = if plan.stream.as_ref().is_some_and(o::StreamPlan::has_key) {
                let value = admin_request(
                    &bootstrap,
                    "obs.readStreamKey",
                    json!({"profile":profile}),
                    o::OBS_IMPORT_TIMEOUT,
                )
                .await
                .map_err(|_| ())?;
                Some(
                    value
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or(())?
                        .to_string(),
                )
            } else {
                None
            };
            let state = studio.snapshot();
            if state.session.phase.is_active()
                || state.connection_generation != generation
                || !studio.is_connected()
            {
                return Err(());
            }
            if let Some(key) = raw_key {
                let target = plan
                    .stream
                    .as_ref()
                    .and_then(o::StreamPlan::key_platform)
                    .ok_or(())?;
                if !studio.save_manual_stream_key(target, &key).await {
                    return Err(());
                }
            }
            let state = studio.snapshot();
            if state.session.phase.is_active() || state.connection_generation != generation {
                return Err(());
            }
            studio
                .update_capture_config(|config| {
                    o::merge_obs_import_into_config(config, &plan, &chrono::Utc::now().to_rfc3339())
                })
                .await
                .map_err(|_| ())?;
            if let Some(directory) = plan.output_directory {
                let folder = StoredFolder {
                    path: directory.path,
                    display_name: directory.display_name,
                };
                studio
                    .write_settings(vec![SettingWrite::Put {
                        key: keys::RECORDINGS_FOLDER.into(),
                        value: serde_json::to_value(folder).map_err(|_| ())?,
                    }])
                    .await
                    .map_err(|_| ())?;
            }
            Ok::<_, ()>(())
        });
        cx.spawn(async move |entity, cx| {
            let ok = matches!(job.await, Ok(Ok(())));
            let _ = entity.update(cx, |this, cx| {
                this.busy = false;
                this.obs.state.applying = false;
                this.obs.error = Some(if ok {
                    format!("{}. {}", c::IMPORTED_TITLE, c::IMPORTED_DESCRIPTION)
                } else {
                    c::read_failed(c::NO_ANSWER)
                });
                if ok {
                    this.obs.state.read = o::ReadState::Idle;
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn obs_dialog(&self, cx: &mut Context<Self>) -> AnyElement {
        let plan = self.obs_plan();
        let model = o::obs_dialog_view(&self.obs.state, plan.as_ref());
        let mut body = div().flex().flex_col().gap(px(8.));
        if model.pickers {
            for (is_collection, label, options, selected) in [
                (
                    true,
                    c::SCENE_COLLECTION,
                    model.collections,
                    self.obs.state.collection.clone(),
                ),
                (
                    false,
                    c::PROFILE,
                    model.profiles,
                    self.obs.state.profile.clone(),
                ),
            ] {
                let mut select = Select::new(label)
                    .value(selected.map(SharedString::from))
                    .disabled(model.applying);
                for name in options {
                    select = select.option(name.clone(), name);
                }
                let entity = cx.entity();
                body = body.child(div().child(label).child(select.on_change(
                    move |value, _, cx| {
                        entity.update(cx, |this, cx| {
                            if this.obs.state.applying {
                                return;
                            }
                            this.obs.error = None;
                            let read = if is_collection {
                                this.obs.state.pick(Some(value.to_string()), None)
                            } else {
                                this.obs.state.pick(None, Some(value.to_string()))
                            };
                            this.read_obs(read, cx);
                            cx.notify();
                        });
                    },
                )));
            }
        }
        for message in [model.status, model.discovery_error, model.read_error]
            .into_iter()
            .filter(|s| !s.is_empty())
        {
            body = body.child(message);
        }
        for (verdict, lines) in model.groups {
            let mut group = div().flex().flex_col().gap(px(6.)).child(verdict.title());
            for line in lines {
                group = group.child(format!("{} · {}", line.subject, line.note));
            }
            body = body.child(group);
        }
        body = body.children(self.obs.error.clone());
        Dialog::new("obs-import", &self.obs.dialog, c::TITLE)
            .size(DialogSize::Lg)
            .description(c::DESCRIPTION)
            .child(body)
            .footer(
                Button::new("obs-retry")
                    .label(c::TRY_AGAIN)
                    .variant(ButtonVariant::Ghost)
                    .disabled(self.busy)
                    .on_click(cx.listener(|this, _, window, cx| this.open_obs(window, cx))),
            )
            .footer(
                Button::new("obs-cancel")
                    .label(c::CANCEL)
                    .variant(ButtonVariant::Ghost)
                    .disabled(model.applying)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.obs.state.closed();
                        this.obs.dialog.close(window, cx);
                        cx.notify();
                    })),
            )
            .footer(
                Button::new("obs-apply")
                    .label(if model.applying {
                        c::IMPORTING
                    } else {
                        c::IMPORT
                    })
                    .disabled(
                        !model.can_import
                            || self.disabled()
                            || self.studio.snapshot().session.phase.is_active(),
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.apply_obs(cx))),
            )
            .into_any_element()
    }
}
