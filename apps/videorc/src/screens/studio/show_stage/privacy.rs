//! Hide screen on the Show stage (`StageScreenPrivacy`, plan 254 D4): the
//! same backend state as the scene's Screen field, which steps aside with
//! the Scenes while the room is open — a mirror, never a second state. It
//! sits in the Screens header beside Stop sharing: a 24 px outline button
//! with EyeSlash, its key beside it while shown, the key in the tooltip, its
//! reason on hover while refused. No toast: the chip says it.

use gpui::{AnyElement, Context, div, prelude::*, px};
use serde_json::Value;
use tokio::sync::broadcast::error::RecvError;
use videorc_app_core::BackendEvent;
use videorc_app_core::desktop::accelerator::accelerator_display_keys;
use videorc_app_core::studio::Connection;
use videorc_app_core::studio::scene_on_stream::{
    SCREEN_PRIVACY_CHANGED_EVENT, SCREEN_PRIVACY_GET_METHOD, ScreenPrivacyView,
    screen_privacy_outcome, screen_privacy_request, screen_privacy_view,
};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::kbd::{Kbd, kbd_group};
use videorc_kit::theme::hsla;
use videorc_kit::tokens::Theme;
use videorc_kit::tooltip::{tooltip, tooltip_with_accelerator};
use videorc_protocol::ScreenPrivacy;

use super::ShowStage;
use crate::app::hotkeys::node_platform;

impl ShowStage {
    /// The state, read now and on every connection, heard on every change
    /// (`useScreenPrivacy`).
    pub(super) fn watch_privacy(&mut self, cx: &mut Context<Self>) {
        let mut events = self.studio.backend().subscribe();
        cx.spawn(async move |this, cx| {
            loop {
                let event = match events.recv().await {
                    Ok(event) => Some(event),
                    Err(RecvError::Lagged(_)) => None,
                    Err(RecvError::Closed) => break,
                };
                let alive = this.update(cx, |stage, cx| match event {
                    None
                    | Some(BackendEvent::Ready(_))
                    | Some(BackendEvent::EventsLagged(_))
                    | Some(BackendEvent::ClientLagged { .. }) => stage.read_privacy(cx),
                    Some(BackendEvent::Untyped { event, payload })
                        if event == SCREEN_PRIVACY_CHANGED_EVENT =>
                    {
                        if let Ok(privacy) = serde_json::from_value::<ScreenPrivacy>(payload) {
                            stage.privacy_changed(privacy, cx);
                        }
                        stage.read_privacy(cx);
                    }
                    Some(_) => {}
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
        self.read_privacy(cx);
    }

    /// `screen.privacy.get`; a change heard meanwhile wins over the answer.
    fn read_privacy(&mut self, cx: &mut Context<Self>) {
        self.privacy_revision += 1;
        let expected = self.privacy_revision;
        let studio = self.studio.clone();
        let job = self.runtime.spawn(async move {
            studio
                .backend()
                .request(SCREEN_PRIVACY_GET_METHOD, Value::Null)
                .await
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(value)) = job.await else {
                return;
            };
            let Ok(privacy) = serde_json::from_value::<ScreenPrivacy>(value) else {
                return;
            };
            this.update(cx, |stage, cx| {
                if stage.privacy_revision == expected {
                    stage.privacy = privacy;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    fn privacy_changed(&mut self, privacy: ScreenPrivacy, cx: &mut Context<Self>) {
        self.privacy_revision += 1;
        self.privacy = privacy;
        cx.notify();
    }

    pub(super) fn privacy_view(&self) -> ScreenPrivacyView {
        let snapshot = self.studio.snapshot();
        let shortcuts = snapshot.settings.studio.global_shortcuts();
        screen_privacy_view(
            &self.privacy,
            None,
            &shortcuts,
            matches!(snapshot.connection, Connection::Connected { .. }),
        )
    }

    fn toggle_privacy(&mut self, cx: &mut Context<Self>) {
        let view = self.privacy_view();
        if view.disabled_reason.is_some() {
            return;
        }
        let hidden = view.hidden;
        let (method, params) = screen_privacy_request(hidden);
        let studio = self.studio.clone();
        let job = self
            .runtime
            .spawn(async move { studio.backend().request(method, params).await });
        cx.spawn(async move |this, cx| {
            let Ok(answer) = job.await else {
                return;
            };
            this.update(cx, |stage, cx| {
                let outcome = screen_privacy_outcome(!hidden, answer);
                if let Some(notice) = outcome.notice {
                    stage.studio.post_notices(vec![notice]);
                }
                if let Some(privacy) = outcome.privacy {
                    stage.privacy_changed(privacy, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    /// `ScreenHiddenChip`: a warn badge with EyeSlash while the hide holds.
    pub(super) fn privacy_chip(view: &ScreenPrivacyView, t: &Theme) -> Option<AnyElement> {
        view.chip.clone().map(|chip| {
            div()
                .id("show-stage-screen-hidden")
                .child(Badge::new(chip).variant(BadgeVariant::Warning).icon(icon(
                    IconName::EyeSlash,
                    14.,
                    hsla(t.warning),
                )))
                .when_some(view.chip_detail.clone(), |chip, detail| {
                    chip.tooltip(tooltip(detail))
                })
                .into_any_element()
        })
    }

    /// The key (while shown) and the Hide screen / Show screen button.
    pub(super) fn privacy_control(
        &self,
        view: &ScreenPrivacyView,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let entity = cx.entity();
        let button = Button::new("show-stage-screen-privacy")
            .icon(IconName::EyeSlash)
            .label(view.action_label)
            .variant(ButtonVariant::Outline)
            .size(ButtonSize::Xs)
            .disabled(view.disabled_reason.is_some())
            .on_click(move |_, _, cx| entity.update(cx, |stage, cx| stage.toggle_privacy(cx)));
        let button: AnyElement = match (view.disabled_reason.clone(), view.accelerator.clone()) {
            (Some(reason), _) => div()
                .id("show-stage-screen-privacy-reason")
                .child(button)
                .tooltip(tooltip(reason))
                .into_any_element(),
            (None, Some(accelerator)) => div()
                .id("show-stage-screen-privacy-tip")
                .child(button)
                .tooltip(tooltip_with_accelerator(view.action_label, accelerator))
                .into_any_element(),
            (None, None) => button.tooltip(view.action_label).into_any_element(),
        };
        // The key teaches itself while there is room for it (hidden, the
        // chip takes the room and the key lives in the tooltip).
        let keys = view
            .accelerator
            .as_deref()
            .filter(|_| !view.hidden)
            .map(|accelerator| {
                kbd_group(
                    accelerator_display_keys(Some(accelerator), Some(node_platform()))
                        .into_iter()
                        .map(Kbd::new),
                )
            });
        div()
            .flex()
            .items_center()
            .gap(px(8.))
            .children(keys)
            .child(button)
            .into_any_element()
    }
}
