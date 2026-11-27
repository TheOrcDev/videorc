//! Library → Cloud → Show markers (P1363, `CloudMarkersDialog`): a show's
//! server marks with Save clip, Remove and Refresh. Words and rows from
//! `library::cloud_markers`; the Studio sends `cloud.markers.list`,
//! `cloud.marker.delete`, `cloud.clips.status` and `cloud.clips.save`.
//! A `cloud.marker.created` for the open show reads the list again.

use super::*;
use crate::screens::dialogs::after_open_change;
use gpui::{AnyElement, SharedString, div, px};
use videorc_app_core::BackendEvent;
use videorc_app_core::library::cloud_markers::{
    self as m, CloudMarker, DESCRIPTION, EMPTY, LIST_LABEL, LOADING, RECONNECT, REFRESH, REMOVE,
    SAVE_CLIP, SAVE_FAILED, TITLE,
};
use videorc_app_core::studio::cloud_clips::CloudClipsStatus;
use videorc_kit::{
    alert::{Alert, AlertVariant},
    button::{Button, ButtonSize, ButtonVariant},
    dialog::{Dialog, DialogSize},
    list_row::{GroupedList, ListRow},
};

/// Each opening's number: a `cloud.marker.created` listener ends with its
/// own opening, so reopening the same show never doubles the reads.
static OPENINGS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The open dialog's show and what it last read.
pub(super) struct MarkersState {
    opening: u64,
    show_id: String,
    /// `None` while the first list is loading.
    marks: Option<Vec<CloudMarker>>,
    clips: Option<CloudClipsStatus>,
    failure: Option<String>,
    pending: bool,
    /// Only the latest read lands.
    read: u64,
}

impl LibraryScreen {
    /// A cloud row's Show markers.
    pub(super) fn open_markers(
        &mut self,
        show_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let opening = OPENINGS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        self.markers = Some(MarkersState {
            opening,
            show_id: show_id.clone(),
            marks: None,
            clips: None,
            failure: None,
            pending: false,
            read: 0,
        });
        self.markers_dialog.open(window, cx);
        self.read_markers(cx);
        self.follow_created_markers(opening, show_id, cx);
    }

    /// The show's Clips status and its marks, together (`useEffect` on
    /// `refresh`).
    fn read_markers(&mut self, cx: &mut Context<Self>) {
        let online = self.core.data().online;
        let Some(state) = self.markers.as_mut() else {
            return;
        };
        state.failure = None;
        if !online {
            state.failure = Some(RECONNECT.to_string());
            return;
        }
        state.read += 1;
        let read = state.read;
        let show = state.show_id.clone();
        let studio = self.studio.clone();
        self.task(
            async move {
                let (clips, marks) = tokio::join!(
                    studio.cloud_clips_status(&show),
                    studio.cloud_markers_list(&show)
                );
                Ok((clips, marks))
            },
            move |this, result, _| {
                let Some(state) = this.markers.as_mut() else {
                    return;
                };
                if state.read != read {
                    return;
                }
                let Ok((clips, marks)) = result else {
                    return;
                };
                state.clips = clips;
                match marks {
                    Ok(marks) => state.marks = Some(marks),
                    Err(error) => state.failure = Some(error),
                }
            },
            cx,
        );
    }

    /// A new mark on the open show reads the list again; the listener ends
    /// with the dialog (or another show's).
    fn follow_created_markers(&self, opening: u64, show_id: String, cx: &mut Context<Self>) {
        let mut events = self.studio.backend().subscribe();
        cx.spawn(async move |this, cx| {
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                let BackendEvent::Untyped { event, payload } = event else {
                    continue;
                };
                if event != m::CREATED_EVENT {
                    continue;
                }
                let ours = payload["showId"].as_str() == Some(show_id.as_str());
                let open = this.update(cx, |this, cx| {
                    let open = this
                        .markers
                        .as_ref()
                        .is_some_and(|state| state.opening == opening);
                    if open && ours {
                        this.read_markers(cx);
                        cx.notify();
                    }
                    open
                });
                if !matches!(open, Ok(true)) {
                    break;
                }
            }
        })
        .detach();
    }

    fn save_marker_clip(&mut self, marker_id: String, cx: &mut Context<Self>) {
        let Some(state) = self.markers.as_mut() else {
            return;
        };
        let Some(generation) =
            m::save_generation(state.pending, state.clips.as_ref()).map(str::to_string)
        else {
            return;
        };
        state.pending = true;
        state.failure = None;
        let show = state.show_id.clone();
        let studio = self.studio.clone();
        self.task(
            async move {
                studio
                    .cloud_clips_retry(&show, &marker_id, &generation)
                    .await
                    .map_err(|_| SAVE_FAILED.to_string())
            },
            move |this, result, cx| {
                let Some(state) = this.markers.as_mut() else {
                    return;
                };
                state.pending = false;
                match result {
                    Ok(()) => this.read_markers(cx),
                    Err(error) => state.failure = Some(error),
                }
            },
            cx,
        );
    }

    fn remove_marker(&mut self, marker_id: String, cx: &mut Context<Self>) {
        let Some(state) = self.markers.as_mut() else {
            return;
        };
        if state.pending {
            return;
        }
        state.pending = true;
        let show = state.show_id.clone();
        let studio = self.studio.clone();
        self.task(
            async move { studio.cloud_marker_delete(&show, &marker_id).await },
            move |this, result, cx| {
                let Some(state) = this.markers.as_mut() else {
                    return;
                };
                state.pending = false;
                match result {
                    Ok(()) => this.read_markers(cx),
                    Err(error) => state.failure = Some(error),
                }
            },
            cx,
        );
    }

    pub(super) fn markers_dialog_view(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(state) = &self.markers else {
            return div().into_any_element();
        };
        let entity = cx.entity();
        let mut body = div().flex().flex_col().gap(px(8.));
        if let Some(failure) = &state.failure {
            body = body.child(
                Alert::new("cloud-markers-failure")
                    .variant(AlertVariant::Destructive)
                    .title(failure.clone()),
            );
        }
        body = body.child(
            div().child(
                Button::new("cloud-markers-refresh")
                    .label(REFRESH)
                    .variant(ButtonVariant::Outline)
                    .size(ButtonSize::Xs)
                    .on_click(cx.listener(|this, _, _, cx| this.read_markers(cx))),
            ),
        );
        let save_ready = m::save_generation(state.pending, state.clips.as_ref()).is_some();
        body = match &state.marks {
            None => body.child(LOADING),
            Some(marks) if marks.is_empty() => body.child(EMPTY),
            Some(marks) => {
                let mut list = GroupedList::new().label(LIST_LABEL);
                for mark in marks {
                    let row = m::marker_row(mark);
                    let mut line = ListRow::new(
                        SharedString::from(format!("cloud-marker-{}", row.id)),
                        row.title.clone(),
                    )
                    .context(row.context.clone())
                    .meta(row.meta);
                    if row.clip {
                        let id = row.id.clone();
                        let entity = entity.clone();
                        line = line.child(
                            Button::new(SharedString::from(format!(
                                "cloud-marker-save-{}",
                                row.id
                            )))
                            .label(SAVE_CLIP)
                            .variant(ButtonVariant::Outline)
                            .size(ButtonSize::Xs)
                            .disabled(!save_ready)
                            .on_click(move |_, _, cx| {
                                let id = id.clone();
                                entity.update(cx, |this, cx| this.save_marker_clip(id, cx));
                            }),
                        );
                    }
                    let id = row.id.clone();
                    let entity = entity.clone();
                    line = line.child(
                        Button::new(SharedString::from(format!(
                            "cloud-marker-remove-{}",
                            row.id
                        )))
                        .label(REMOVE)
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .disabled(state.pending)
                        .on_click(move |_, _, cx| {
                            let id = id.clone();
                            entity.update(cx, |this, cx| this.remove_marker(id, cx));
                        }),
                    );
                    list = list.row(line);
                }
                body.child(list)
            }
        };
        let closing = entity.downgrade();
        Dialog::new("cloud-markers-dialog", &self.markers_dialog, TITLE)
            .size(DialogSize::Lg)
            .description(DESCRIPTION)
            .on_open_change(move |open, _, window, cx| {
                if !open {
                    after_open_change(&closing, window, cx, |this, _, cx| {
                        if !this.markers_dialog.is_open() {
                            this.markers = None;
                            cx.notify();
                        }
                    });
                }
            })
            .child(body)
            .into_any_element()
    }
}
