//! The player's picture: on macOS the native element (IOSurface frames on
//! a layer of the player's own view), on Windows and Linux the CPU-ring
//! element (`videorc_preview::cpu_playback`: the backend's playback ring,
//! put on the screen by the live preview's Linux presenter). Both have the
//! same API, so the open, resume and visibility rules below are one.

use super::*;
#[cfg(target_os = "macos")]
use crate::preview::macos::{HostView, ViewHost, tune_video_layer};
#[cfg(not(target_os = "macos"))]
use videorc_preview::cpu_playback::{PlaybackElement, PlaybackView};
#[cfg(target_os = "macos")]
use videorc_preview::playback::{PlaybackElement, PlaybackView};

pub(super) struct Native {
    pub element: Option<PlaybackElement>,
    #[cfg(target_os = "macos")]
    pub host: HostView,
    pub before_frame: u64,
    last_status: Option<PlaybackStatus>,
}
impl Drop for Native {
    fn drop(&mut self) {
        if let Some(element) = self.element.take() {
            element.stop();
        }
    }
}
impl Player {
    #[cfg(target_os = "macos")]
    pub(super) fn start_native(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let host = HostView::new(window, cx)?;
        let mut element = PlaybackElement::start(
            &self.runtime,
            self.files.backend.clone(),
            self.logger.clone(),
        )?;
        if element.attach(&ViewHost::of(&host.view)).is_err() {
            element.stop();
            return Err("Playback isn't available in this window.".into());
        }
        tune_video_layer(&host.view, 0.);
        element.set_visible(false);
        let mut watch = element
            .view_watch()
            .ok_or("Playback isn't available in this window.")?;
        self.native = Some(Native {
            element: Some(element),
            host,
            before_frame: 0,
            last_status: None,
        });
        cx.spawn(async move |entity, cx| {
            loop {
                let view = watch.borrow_and_update().clone();
                if entity
                    .update(cx, |this, cx| this.note_playback(view, cx))
                    .is_err()
                {
                    break;
                }
                if watch.changed().await.is_err() {
                    break;
                }
            }
        })
        .detach();
        Ok(())
    }
    /// Windows and Linux: the CPU-ring element. On Linux its presenter's
    /// child goes into this window, above GPUI's drawing, hidden until the
    /// first frame of the recording is presented; Windows has no presenter
    /// yet, so the slot says so and the sound and controls work.
    #[cfg(not(target_os = "macos"))]
    pub(super) fn start_native(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let mut element = PlaybackElement::start(
            &self.runtime,
            self.files.backend.clone(),
            self.logger.clone(),
        )?;
        element.set_visible(false);
        if let Err(error) = element.attach(&*window) {
            self.logger.log(
                videorc_app_core::Level::Error,
                &format!("[player] the presenter did not attach: {error}"),
            );
            element.stop();
            return Err("Playback isn't available in this window.".into());
        }
        let mut watch = element
            .view_watch()
            .ok_or("Playback isn't available in this window.")?;
        self.native = Some(Native {
            element: Some(element),
            before_frame: 0,
            last_status: None,
        });
        cx.spawn(async move |entity, cx| {
            loop {
                let view = watch.borrow_and_update().clone();
                if entity
                    .update(cx, |this, cx| this.note_playback(view, cx))
                    .is_err()
                {
                    break;
                }
                if watch.changed().await.is_err() {
                    break;
                }
            }
        })
        .detach();
        Ok(())
    }
    pub(super) fn open_native(&mut self) {
        if !self.active || !self.playable || !self.need_open {
            return;
        }
        let Some(native) = self.native.as_mut() else {
            return;
        };
        let Some(element) = native.element.as_mut() else {
            return;
        };
        let view = element.view();
        if !view.connected {
            return;
        }
        let Some(session) = &self.session else {
            return;
        };
        native.before_frame = view.presented_frames;
        element.set_visible(false);
        self.opening_from = view.status.playback_id;
        self.need_open = false;
        self.resume_in_flight = None;
        self.status = PlaybackStatus::closed(String::new());
        element.open(&session.session_id, Some(1920), Some(1080));
    }
    fn note_playback(&mut self, view: PlaybackView, cx: &mut Context<Self>) {
        // Frame notifications can repeat an unchanged failure/open reply.
        // Only a new status may consume the one automatic retry or update
        // remembered resume state (especially before a queued seek answers).
        let new_status = self.native.as_mut().is_some_and(|native| {
            let changed = native.last_status.as_ref() != Some(&view.status);
            native.last_status = Some(view.status.clone());
            changed
        });
        let was_connected = self.connected;
        self.connected = view.connected;
        if !self.active {
            return;
        }
        if !was_connected && view.connected && self.playable {
            self.need_open = true;
            self.resume = self.session.as_mut().map(p::PlayerSession::retry);
        }
        if self.need_open {
            self.open_native();
            cx.notify();
            return;
        }
        let belongs = self
            .session
            .as_ref()
            .is_some_and(|p| view.status.session_id.as_deref() == Some(p.session_id.as_str()));
        let fresh = belongs
            && view.status.playback_id.is_some()
            && view.status.playback_id != self.opening_from;
        let ready = fresh
            && matches!(
                view.status.state,
                PlaybackState::Paused | PlaybackState::Playing | PlaybackState::Ended
            );
        if let Some(native) = self.native.as_mut() {
            if let Some(element) = native.element.as_mut() {
                element.set_visible(ready && view.presented_frames > native.before_frame);
            }
        }
        let resuming = ready && self.resume.is_some();
        if ready {
            if let Some(mut resume) = self.resume.take() {
                resume.at_ms = resume.at_ms.min(view.status.duration_ms);
                self.resume_in_flight = Some(resume);
                if let Some(element) = self.native.as_ref().and_then(|n| n.element.as_ref()) {
                    element.set_muted(self.desired_muted);
                    if resume.at_ms > 0 {
                        element.seek(resume.at_ms.min(view.status.duration_ms));
                    }
                    if resume.playing {
                        element.play();
                    }
                }
            }
        }
        if let Some(resume) = self.resume_in_flight {
            let positioned = if resume.playing {
                view.status.position_ms >= resume.at_ms.saturating_sub(100)
            } else {
                view.status.position_ms.abs_diff(resume.at_ms) <= 100
            };
            let playing = (view.status.state == PlaybackState::Playing) == resume.playing
                || view.status.state == PlaybackState::Ended;
            if ready && positioned && playing && !resuming {
                self.resume_in_flight = None;
            }
        }
        if !resuming
            && (self.resume_in_flight.is_none() || view.status.state == PlaybackState::Failed)
            && new_status
            && (fresh
                || (view.status.state == PlaybackState::Failed
                    && (belongs || view.status.session_id.is_none())))
        {
            if let Some(resume) = self.session.as_mut().and_then(|p| p.note(&view.status)) {
                self.resume = Some(resume);
                self.need_open = true;
                self.open_native();
                cx.notify();
                return;
            }
        }
        let changed = self.status.state != view.status.state
            || self.status.position_ms / 100 != view.status.position_ms / 100
            || self.status.duration_ms != view.status.duration_ms
            || self.status.muted != view.status.muted
            || self.status.refusal != view.status.refusal
            || self.connected != was_connected;
        if fresh
            || (new_status
                && matches!(
                    view.status.state,
                    PlaybackState::Failed | PlaybackState::Closed
                ))
        {
            self.status = view.status;
        }
        let failed = view.last_error.is_some();
        let had_error = self.error.is_some();
        if failed {
            self.error = Some(p::media_error_copy(None).into());
        } else if ready && self.error.as_deref() == Some(p::media_error_copy(None)) {
            self.error = None;
        }
        if changed || failed != had_error {
            cx.notify();
        }
    }
    #[cfg(target_os = "macos")]
    pub(super) fn slot(&self, cx: &Context<Self>) -> gpui::AnyElement {
        let mut slot = gpui::div()
            .relative()
            .w_full()
            .h(gpui::px(300.))
            .overflow_hidden();
        if self.active {
            if let Some(native) = self.native.as_ref() {
                let weak = cx.entity().downgrade();
                slot = slot.child(native.host.native.clone()).child(
                    gpui::canvas(
                        move |bounds, _, cx| {
                            let _ = weak.update(cx, |this, _| {
                                if let Some(native) = this.native.as_mut() {
                                    if let Some(element) = native.element.as_mut() {
                                        element.place(videorc_preview::LayerRect {
                                            x: 0.,
                                            y: 0.,
                                            width: f64::from(bounds.size.width),
                                            height: f64::from(bounds.size.height),
                                        });
                                        tune_video_layer(&native.host.view, 0.);
                                    }
                                }
                            });
                        },
                        |_, _, _, _| {},
                    )
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full(),
                );
            }
        }
        slot.into_any_element()
    }

    /// Windows and Linux: the slot the presenter's child follows. GPUI
    /// draws nothing under it but the video ground; on Windows, where no
    /// presenter draws yet, the slot says the picture is missing.
    #[cfg(not(target_os = "macos"))]
    pub(super) fn slot(&self, cx: &Context<Self>) -> gpui::AnyElement {
        let t = videorc_kit::tokens::DARK;
        let mut slot = gpui::div()
            .relative()
            .w_full()
            .h(gpui::px(300.))
            .overflow_hidden()
            .rounded(gpui::px(videorc_kit::tokens::radius::ROW))
            .bg(videorc_kit::theme::hsla(t.video_ground));
        if !videorc_preview::cpu_playback::DRAWS_PICTURE {
            slot = slot.flex().items_center().justify_center().child(
                gpui::div()
                    .px(gpui::px(16.))
                    .text_color(videorc_kit::theme::hsla(t.video_ground_muted))
                    .child(p::NO_PICTURE_HERE_YET),
            );
        }
        if self.active && self.native.is_some() {
            let weak = cx.entity().downgrade();
            slot = slot.child(
                gpui::canvas(
                    move |bounds, window, cx| {
                        let scale = f64::from(window.scale_factor());
                        let _ = weak.update(cx, |this, _| {
                            if let Some(element) =
                                this.native.as_mut().and_then(|n| n.element.as_mut())
                            {
                                // The presenter places in the window's own
                                // logical points.
                                element.place(
                                    videorc_preview::LayerRect {
                                        x: f64::from(bounds.origin.x),
                                        y: f64::from(bounds.origin.y),
                                        width: f64::from(bounds.size.width),
                                        height: f64::from(bounds.size.height),
                                    },
                                    scale,
                                );
                            }
                        });
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            );
        }
        slot.into_any_element()
    }
}
