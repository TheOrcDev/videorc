use super::*;
use videorc_app_core::library::{
    copy,
    markers::{SessionMarker, marker_failure_detail},
};
impl Player {
    pub(super) fn load_markers(&mut self, more: bool, cx: &mut Context<Self>) {
        let Some(markers) = self.markers.as_mut() else {
            return;
        };
        if more && markers.loading {
            return;
        }
        let cursor = if more { markers.cursor.clone() } else { None };
        let generation = markers.begin_load();
        let id = markers.session_id.clone();
        let core = self.core.clone();
        let epoch = self.marker_epoch;
        let job = self.runtime.spawn(async move {
            core.markers(&id, cursor.as_deref())
                .await
                .map_err(|e| (cursor, e))
        });
        cx.spawn(async move |entity, cx| {
            let result = job.await;
            let _ = entity.update(cx, |this, cx| {
                if epoch != this.marker_epoch {
                    return;
                }
                if let Some(markers) = this.markers.as_mut() {
                    match result {
                        Ok(Ok((rows, cursor))) => markers.loaded(generation, more, rows, cursor),
                        Ok(Err((cursor, error))) => markers.load_failed(generation, cursor, &error),
                        Err(_) => {
                            markers.loading = false;
                            this.error = Some(copy::COULDNT_LOAD_MARKERS.into());
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub(super) fn select_marker(&mut self, id: &str, cx: &mut Context<Self>) {
        if let Some(ms) = self.markers.as_mut().and_then(|m| m.select(id)) {
            self.seek(ms);
            cx.notify();
        }
    }
    pub(super) fn edit_marker(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(markers) = self.markers.as_mut() else {
            return;
        };
        if markers.pending || !self.core.data().online {
            return;
        }
        markers.start_rename(id);
        let draft = markers.draft.clone();
        self.input
            .update(cx, |input, cx| input.set_value(draft, window, cx));
        cx.on_next_frame(window, |this, window, cx| {
            this.input.read(cx).focus_handle(cx).focus(window, cx)
        });
        cx.notify();
    }
    pub(super) fn rename_marker(&mut self, cx: &mut Context<Self>) {
        let Some(markers) = self.markers.as_mut() else {
            return;
        };
        if markers.pending || !self.core.data().online {
            return;
        }
        let Some(id) = markers.editing.clone() else {
            return;
        };
        let session = markers.session_id.clone();
        let draft = markers.draft.trim().to_owned();
        let core = self.core.clone();
        let epoch = self.marker_epoch;
        markers.pending = true;
        let job = self.runtime.spawn(async move {
            core.rename_marker(&session, &id, (!draft.is_empty()).then_some(draft.as_str()))
                .await
        });
        cx.spawn(async move |entity, cx| {
            let result = job.await;
            let _ = entity.update(cx, |this, cx| {
                if epoch != this.marker_epoch {
                    return;
                }
                if let Some(markers) = this.markers.as_mut() {
                    markers.pending = false;
                    match result {
                        Ok(Ok(())) => markers.editing = None,
                        Ok(Err(error)) => {
                            this.error = Some(format!(
                                "{}: {}",
                                copy::COULDNT_RENAME_MARKER,
                                marker_failure_detail(&error)
                            ))
                        }
                        Err(_) => this.error = Some(copy::COULDNT_RENAME_MARKER.into()),
                    }
                }
                this.load_markers(false, cx);
                cx.notify();
            });
        })
        .detach();
    }
    pub(super) fn remove_marker(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(markers) = self.markers.as_mut() else {
            return;
        };
        if !self.core.data().online || markers.pending || self.deleting.contains_key(id) {
            return;
        }
        let Some(marker) = markers.hide(id) else {
            return;
        };
        let session = markers.session_id.clone();
        let epoch = self.marker_epoch;
        let gate = std::rc::Rc::new(std::cell::Cell::new(false));
        self.deleting.insert(id.to_owned(), gate.clone());
        let weak = cx.entity().downgrade();
        let undo_weak = weak.clone();
        let undo_marker = marker.clone();
        let undo_gate = gate.clone();
        let toast_id = videorc_app_core::library::markers::marker_delete_toast_id(id);
        let undo_toast = toast_id.clone();
        let mut toast = videorc_kit::toast::ToastData::new(
            videorc_kit::toast::ToastKind::Plain,
            copy::marker_deleted(&videorc_app_core::library::markers::marker_name(&marker)),
        )
        .description(videorc_app_core::library::markers::marker_time(
            marker.at_seconds,
        ))
        .action(copy::UNDO, move |_, cx| {
            if undo_gate.replace(true) {
                return;
            }
            let _ = undo_weak.update(cx, |this, cx| {
                this.deleting.remove(&undo_marker.id);
                this.delete_flushes.remove(&undo_marker.id);
                this.restore_marker(epoch, &undo_marker);
                cx.notify();
            });
            let hub = cx
                .global::<crate::screens::notifications::Shared>()
                .0
                .clone();
            hub.update(cx, |_, cx| {
                cx.emit(crate::screens::notifications::Delivery::Dismiss(
                    undo_toast.clone(),
                ))
            });
        });
        toast.timeout = Some(Some(std::time::Duration::from_millis(
            videorc_app_core::library::markers::MARKER_DELETE_UNDO_MS,
        )));
        let core = self.core.clone();
        let runtime = self.runtime.clone();
        let flush: std::rc::Rc<dyn Fn(&mut gpui::App)> = std::rc::Rc::new(move |cx| {
            if gate.replace(true) {
                return;
            }
            let target = marker.id.clone();
            let core = core.clone();
            let session = session.clone();
            let item = marker.clone();
            let weak = weak.clone();
            let job = runtime.spawn(async move { core.delete_marker(&session, &target).await });
            cx.spawn(async move |cx| {
                let result = job.await;
                let _ = weak.update(cx, |this, cx| {
                    this.deleting.remove(&item.id);
                    this.delete_flushes.remove(&item.id);
                    if !matches!(result, Ok(Ok(()))) {
                        this.restore_marker(epoch, &item);
                        this.error = Some(copy::COULDNT_DELETE_MARKER.into());
                    }
                    if this.active {
                        this.load_markers(false, cx);
                    }
                    cx.notify();
                });
            })
            .detach();
        });
        self.delete_flushes.insert(id.to_owned(), flush.clone());
        let finish: videorc_kit::toast::ActionHandler = std::rc::Rc::new(move |_, cx| flush(cx));
        toast.on_close = Some(finish.clone());
        toast.on_auto_close = Some(finish);
        let hub = cx
            .global::<crate::screens::notifications::Shared>()
            .0
            .clone();
        hub.update(cx, |hub, cx| hub.press_toast(toast_id, toast, cx));
        cx.notify();
    }
    pub(super) fn flush_deletes(&mut self, cx: &mut gpui::App) {
        let pending = std::mem::take(&mut self.delete_flushes);
        for (id, flush) in pending {
            flush(cx);
            if let Some(shared) = cx.try_global::<crate::screens::notifications::Shared>() {
                let hub = shared.0.clone();
                hub.update(cx, |_, cx| {
                    cx.emit(crate::screens::notifications::Delivery::Dismiss(
                        videorc_app_core::library::markers::marker_delete_toast_id(&id),
                    ))
                });
            }
        }
    }
    fn restore_marker(&mut self, epoch: u64, marker: &SessionMarker) {
        if epoch != self.marker_epoch {
            return;
        }
        if let Some(markers) = self.markers.as_mut() {
            markers.hidden.remove(&marker.id);
            if !markers.markers.iter().any(|row| row.id == marker.id) {
                markers.markers.push(marker.clone());
                markers
                    .markers
                    .sort_by(|a, b| a.at_seconds.total_cmp(&b.at_seconds));
            }
        }
    }
}
