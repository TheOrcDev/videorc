use super::*;
use videorc_app_core::protocol::{
    RecordingFinalizationState, ReplayBufferState, ReplaySaveFailedEvent, ReplaySavedEvent,
    ReplayStateEvent,
};

impl Hub {
    pub(super) fn backend(&mut self, state: BackendState) {
        use sources::app::BackendLifecycle as B;
        let state = match state {
            BackendState::Ready { .. } => B::Running,
            BackendState::Restarting { attempt, .. }
            | BackendState::Starting {
                attempt: Some(attempt),
                ..
            } => B::Restarting {
                attempt: Some(attempt),
            },
            BackendState::Failed { .. } => B::Failed,
            _ => return,
        };
        sources::app::publish_backend_lifecycle(&mut self.store, state, now());
    }
    pub(super) fn session(&mut self, effect: SessionEffect) {
        match effect {
            SessionEffect::SessionStarted { .. } => {
                let session = self.studio.snapshot().session;
                if !session_is_replay_only(&session.status) {
                    self.store.set_pressed();
                }
            }
            SessionEffect::SessionFinished {
                session_id,
                activity,
            } => {
                sources::session::session_finished(
                    &mut self.store,
                    activity.into(),
                    session_id.as_deref(),
                    self.microphone.as_ref(),
                    now(),
                );
                self.targets.clear();
            }
            SessionEffect::RecordingFailed(notice) => self
                .store
                .publish(sources::health::recording_failure(&notice), now()),
            SessionEffect::SessionEnded => {
                let live = self.studio.snapshot().session.activity.is_live();
                sources::health::session_ended_notifications(&mut self.store, live, now());
                self.targets.clear();
            }
            _ => {}
        }
    }
    pub(super) fn event(&mut self, event: BackendEvent, cx: &mut Context<Self>) {
        match event {
            BackendEvent::HealthEvent(event) => {
                let snapshot = self.studio.snapshot();
                let status = &snapshot.session.status;
                let current = status.session_id.as_ref().or(self.last_session.as_ref());
                if event
                    .session_id
                    .as_ref()
                    .is_some_and(|id| Some(id) != current)
                {
                    return;
                }
                let state = serde_json::to_value(&status.state)
                    .ok()
                    .and_then(|s| s.as_str().map(str::to_owned));
                let running = sources::session::RunningSession {
                    session_id: current.cloned(),
                    state,
                    replay_only: session_is_replay_only(status),
                };
                let quality_key = event.session_id.as_ref().unwrap_or(&event.message);
                match sources::session::route_session_health_event(
                    &mut self.store,
                    &event,
                    self.quality.contains(quality_key),
                    Some(&running),
                    now(),
                ) {
                    sources::session::SessionHealthOutcome::QualityShown(key) => {
                        self.quality.insert(key);
                    }
                    // The legacy stream supplies the same refused-start id,
                    // including Retry and its close callback. Do not race it.
                    sources::session::SessionHealthOutcome::Toast(_)
                    | sources::session::SessionHealthOutcome::Listed => {}
                }
            }
            BackendEvent::RecordingFinalization(event) => {
                let input = match event.state {
                    RecordingFinalizationState::Finalizing => sources::work::mp4_finalizing(
                        &event.session_id,
                        &n::finalizing_label(event.progress_percent),
                    ),
                    RecordingFinalizationState::Finalized => {
                        sources::work::mp4_ready(&event.session_id)
                    }
                    RecordingFinalizationState::Failed => {
                        sources::work::mp4_export_failed(&event.session_id, event.error.as_deref())
                    }
                    RecordingFinalizationState::None => return,
                };
                self.store.publish(input, now());
            }
            BackendEvent::Untyped { event, payload } => match event.as_str() {
                "stream.targets" => {
                    if let Ok(snapshot) =
                        serde_json::from_value::<n::StreamTargetsSnapshot>(payload)
                    {
                        let notices = sources::stream_targets::stream_target_notices(
                            &self.targets,
                            &snapshot.targets,
                        );
                        sources::stream_targets::publish_stream_target_notices(
                            &mut self.store,
                            &notices,
                            now(),
                        );
                        self.targets = snapshot
                            .targets
                            .into_iter()
                            .map(|t| (t.target_id, t.state))
                            .collect();
                    }
                }
                "replay.saved" => {
                    if let Ok(saved) = serde_json::from_value::<ReplaySavedEvent>(payload) {
                        self.store.publish(
                            sources::work::clip_saved(
                                &saved.save_id,
                                saved.complete,
                                &videorc_app_core::studio::timecode::format_timecode(
                                    (saved.covered_seconds * 1000.) as i64,
                                ),
                            ),
                            now(),
                        );
                    }
                }
                "replay.saveFailed" => {
                    if let Ok(failed) = serde_json::from_value::<ReplaySaveFailedEvent>(payload) {
                        self.store.publish(
                            sources::work::clip_save_failed(&failed.save_id, &failed.message),
                            now(),
                        );
                    }
                }
                "replay.state" => {
                    if let Ok(state) = serde_json::from_value::<ReplayStateEvent>(payload) {
                        if state.state == ReplayBufferState::Error {
                            self.store.publish(
                                sources::work::clips_stopped(state.reason.as_deref().unwrap_or("")),
                                now(),
                            );
                        } else if state.state == ReplayBufferState::On {
                            self.store
                                .resolve("clips", sources::work::clips_on_again(), now());
                        }
                    }
                }
                // P1443 (`AgentsWatcher`): an agent's on-air action, named.
                sources::app::AGENTS_ACTIVITY_EVENT => {
                    if let Some(input) = sources::app::agent_activity_notice(&payload) {
                        self.store.publish(input, now());
                    }
                }
                _ => {}
            },
            BackendEvent::EventsLagged(_) | BackendEvent::ClientLagged { .. } => {
                self.store.publish(sources::app::backend_error(), now())
            }
            _ => {}
        }
        let _ = cx;
    }
    pub(super) fn legacy(&mut self, command: NoticeCommand, cx: &mut Context<Self>) {
        let notice = match command {
            NoticeCommand::Dismiss(id) => {
                cx.emit(Delivery::Dismiss(id));
                return;
            }
            NoticeCommand::Show(notice) => notice,
        };
        let id = notice.id.as_deref().unwrap_or("");
        // Explicit answers only. No "recent click" heuristic can turn an
        // unrelated background warning into a press's answer.
        if id == videorc_app_core::studio::session::SESSION_START_FAILED_TOAST_ID {
            let session = self.studio.snapshot().session;
            if session.start_failure.is_some() && !session_is_replay_only(&session.status) {
                cx.emit(Delivery::Press(notice));
            }
            return;
        }
        if id == n::ids::END_LIVESTREAM_ARMED
            || id == n::ids::CLIP_MARKED
            || refused_layout_answer(id)
        {
            cx.emit(Delivery::Press(notice));
            return;
        }
        if id == n::ids::CLIPS {
            match notice.title.as_str() {
                "Clips stopped" => return, // replay.state is the typed owner.
                "Clips couldn't start" => {
                    self.store.publish(
                        sources::work::clips_could_not_start(
                            notice.description.as_deref().unwrap_or(""),
                        ),
                        now(),
                    );
                    return;
                }
                "Clips are off on this computer"
                | "Clips are off"
                | "Clips are still starting"
                | "Nothing to clip yet" => {
                    cx.emit(Delivery::Press(notice));
                    return;
                }
                _ => {}
            }
        }
        if typed_legacy(&notice) {
            return;
        }
        // Pre-bell APIs do not carry the initiating window or provenance.
        // Preserve unknown failures/news and buttons without inventing an
        // interruption. New sources should publish the typed core Input.
        let mut input = if matches!(notice.kind, NoticeKind::Warning | NoticeKind::Error) {
            sources::app::background_problem(&notice.title, notice.description.as_deref())
        } else {
            sources::app::app_news(
                &format!("legacy:{id}:{}", notice.title),
                &notice.title,
                notice.description.as_deref(),
                None,
            )
        };
        if !id.is_empty() {
            input.key = format!("legacy:{id}");
        }
        let mut actions = Vec::new();
        for (index, button) in [notice.action, notice.cancel]
            .into_iter()
            .flatten()
            .enumerate()
        {
            let action_id = format!("legacy-{index}");
            let kind = match button.action {
                NoticeAction::OpenHealth
                | NoticeAction::OpenPage(_)
                | NoticeAction::OpenUrl { .. }
                | NoticeAction::OpenLibrary { .. } => ActionKind::Door,
                _ => ActionKind::Fix,
            };
            self.legacy_actions
                .insert((input.key.clone(), action_id.clone()), button.action);
            actions.push(n::Action {
                id: action_id,
                label: button.label,
                kind,
            });
        }
        if !actions.is_empty() {
            input.actions = actions;
        }
        self.store.publish(input, now());
    }
}

/// A layout change refused before it was asked of the backend: the answer
/// to the layout the user chose, a warning toast in Electron
/// (`requestCameraPresetTransaction`, `use-studio.tsx`: `toast.warning(…,
/// { id: 'layout-source-unavailable' })` when a source it needs is missing,
/// `'scene-layout-no-screen'` when the scene shows no screen). Behind the
/// bell only, the refused press said nothing (L6, 2026-11-26).
fn refused_layout_answer(id: &str) -> bool {
    use videorc_app_core::studio::scene_switch::copy;
    id == copy::SOURCE_UNAVAILABLE_ID || id == copy::NO_SCREEN_ID
}

/// These old producers are replaced above (or by the microphone snapshot).
/// Filtering is by their stable ids, never timing or a last-click guess.
fn typed_legacy(notice: &Notice) -> bool {
    let id = notice.id.as_deref().unwrap_or("");
    matches!(
        id,
        n::ids::BACKEND_LIFECYCLE
            | n::ids::MICROPHONE_INPUT_LOST
            | n::ids::STREAM_OUTPUT
            | n::ids::STREAM_DELIVERY
            | n::ids::STREAM_UPLINK
            | n::ids::SCREEN_CAPTURE
            | n::ids::HOST_OVERLOADED
            | n::ids::DISK_SPACE_LOW
            | n::ids::SYSTEM_AUDIO_ECHO
            | n::ids::RECORDING_STARTUP_UNSTEADY
            | videorc_app_core::studio::session::RECORDING_STOPPED_UNEXPECTEDLY_TOAST_ID
    ) || [
        "finalization-",
        "stream-target:",
        "separate-file:",
        "separate-files-shed:",
        "clips-saved-",
        "clips-failed-",
        "microphone-noise-reduction-silenced",
        "audio-output-stalled",
        "microphone-timeline-recovered",
        "microphone-input-recovered",
        "microphone-signal-recovered",
        "microphone-capture-worker-unavailable",
    ]
    .iter()
    .any(|prefix| id.starts_with(prefix))
        || matches!(
            notice.title.as_str(),
            n::copy::RECORDING_SAVED
                | n::copy::DROPPED_FRAMES
                | n::copy::NO_SOUND
                | n::copy::MICROPHONE_SILENT
        )
}

#[cfg(test)]
mod tests {
    use super::refused_layout_answer;

    #[test]
    fn a_refused_layout_is_the_press_answer_electron_toasts() {
        assert!(refused_layout_answer("layout-source-unavailable"));
        assert!(refused_layout_answer("scene-layout-no-screen"));
        assert!(!refused_layout_answer("scene-delete-refused"));
        assert!(!refused_layout_answer(""));
    }
}
