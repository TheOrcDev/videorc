//! Connection-owned preview handoff. An IOSurface ID alone does not keep its
//! storage alive when a resize replaces the compositor target ring.
use super::*;

/// The single source for Preview leases and the read-only pixel oracle.
///
/// Plan 212 S4: while the Preview holds for a performance check, the hold's
/// own store, whose latest is the frame presented when the hold began (or
/// nothing, when nothing was ever presented), whatever the run composes.
///
/// Plan 212 S6, the packaged backstop: a release backend never hands main a
/// frame composed from a scene with a test-pattern source. It returns an
/// empty store instead, so main keeps the last program frame it was given,
/// counts the refusal (`framePipeline.previewSyntheticRefused`) and logs it
/// once per run. Dev builds and the smokes keep presenting such frames.
///
/// Otherwise the program leg's store while the Preview's own picture is
/// current (plan 205 S6), else the primary's. Current means the program leg
/// published this tick or the one before: the loop publishes the primary
/// first and the twin last in one tick, and a twin tick that retained its
/// frame (the ring busy) still shows the program a tick late rather than
/// flipping to a primary without it. The first tick the leg is off empties
/// its store, so the switch back is immediate; neither switch drops a frame,
/// because the lease keeps the surface it holds until main takes the next
/// one.
pub(crate) fn presented_frame_store(compositor: &CompositorRuntime) -> CompositorFrameStore {
    presented_frame_store_for(compositor, packaged_build())
}

pub(crate) fn presented_frame_store_for(
    compositor: &CompositorRuntime,
    packaged: bool,
) -> CompositorFrameStore {
    if let Some(hold) = compositor.preview_hold.as_ref() {
        return hold.store();
    }
    let store = presented_frame_store_unguarded(compositor);
    if packaged
        && store
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .latest()
            .is_some_and(|frame| frame.metadata.has_test_pattern_scene())
    {
        if compositor.preview_backstop.note_refusal() {
            tracing::warn!(
                "preview backstop: refusing a frame composed from a test-pattern scene to the Preview on run {} (packaged build; the Preview keeps its last program frame)",
                compositor.run_id.as_deref().unwrap_or("none")
            );
        }
        return Arc::new(StdMutex::new(FrameStore::new(0)));
    }
    store
}

/// The run's presented store with no hold and no backstop: the program leg's
/// while current, else the primary's (see `presented_frame_store`).
pub(crate) fn presented_frame_store_unguarded(
    compositor: &CompositorRuntime,
) -> CompositorFrameStore {
    let latest_sequence = |store: &CompositorFrameStore| {
        store
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .latest()
            .map(|frame| frame.sequence)
    };
    let primary = latest_sequence(&compositor.frame_store);
    let program = latest_sequence(&compositor.program_frame_store);
    match (program, primary) {
        (Some(program), Some(primary)) if program.saturating_add(1) >= primary => {
            compositor.program_frame_store.clone()
        }
        (Some(_), None) => compositor.program_frame_store.clone(),
        _ => compositor.frame_store.clone(),
    }
}

pub(crate) struct CompositorPreviewFrameLease {
    pub frame: CompositorFrameReady,
    _retained: FrameHandle<CompositorPixelFormat, CompositorFrameExportHandle>,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

pub(crate) async fn acquire_preview_frame(
    state: &AppState,
    run_id: &str,
    scene_revision: Option<u64>,
) -> Option<CompositorPreviewFrameLease> {
    let compositor = state.compositor.lock().await;
    acquire(&compositor, run_id, scene_revision)
}

/// The frame a lease for `run_id` at `scene_revision` would hand main, with
/// its evidence: every rule of `acquire` but the lease permit and the Metal
/// handoff (tests read it; CPU frames have no handoff).
fn select_presented_frame(
    compositor: &CompositorRuntime,
    run_id: &str,
    scene_revision: Option<u64>,
) -> Option<(CompositorFrameHandle, CompositorFrameEvidence)> {
    // Plan 212 S4: under the hold, the run main knows is the one the held
    // frame came from (a fresh benchmark run may have replaced it since).
    let known_run_id = match compositor.preview_hold.as_ref() {
        Some(hold) => hold.run_id.as_deref(),
        None => compositor.run_id.as_deref(),
    };
    if known_run_id != Some(run_id)
        || (compositor.status.scene_revision.is_some()
            && compositor.status.scene_revision != scene_revision)
    {
        return None;
    }
    let frame = presented_frame_store(compositor)
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .latest()?;
    // Plan 212 S2: a benchmark's frame is never the Preview's, hold or not.
    if frame.metadata.is_benchmark() {
        return None;
    }
    let evidence = match compositor.preview_hold.as_ref() {
        Some(hold) => hold.evidence.filter(|e| e.sequence == frame.sequence),
        None => compositor
            .frame_evidence
            .iter()
            .find(|e| e.sequence == frame.sequence)
            .copied(),
    }?;
    if evidence.scene_revision != scene_revision {
        return None;
    }
    Some((frame, evidence))
}

fn acquire(
    compositor: &CompositorRuntime,
    run_id: &str,
    scene_revision: Option<u64>,
) -> Option<CompositorPreviewFrameLease> {
    let permit = compositor
        .preview_frame_lease_capacity
        .clone()
        .try_acquire_owned()
        .ok()?;
    let (frame, evidence) = select_presented_frame(compositor, run_id, scene_revision)?;
    let target = frame.metadata.metal_target_handoff()?;
    Some(CompositorPreviewFrameLease {
        frame: CompositorFrameReady {
            target_fps: compositor.status.target_fps,
            width: frame.width,
            height: frame.height,
            run_id: Some(run_id.to_string()),
            scene_revision,
            frame_scene_revision: evidence.scene_revision,
            frames_rendered: frame.sequence,
            frame_age_ms: Some(frame.captured_at.elapsed().as_millis() as u64),
            metal_target_iosurface_id: Some(target.iosurface_id),
            metal_target_width: Some(target.width),
            metal_target_height: Some(target.height),
            updated_at: Utc::now().to_rfc3339(),
        },
        _retained: frame,
        _permit: permit,
    })
}

#[cfg(test)]
mod presented_store_tests {
    use super::*;

    fn test_state() -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(16);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        )
    }

    fn publish(store: &CompositorFrameStore, sequence: u64) {
        store.lock().unwrap().publish_with_metadata(
            sequence,
            2,
            2,
            CompositorPixelFormat::yuv420p_cpu_buffer(),
            CompositorFrameExportHandle::default(),
            Instant::now(),
            vec![0; 6],
        );
    }

    /// Plan 205 S6: the presented store is the program leg's while its
    /// frame is current (this tick or the one before), the primary's else;
    /// emptying the program store switches back at once.
    #[test]
    fn presented_frame_store_follows_a_current_program_frame() {
        let runtime = initial_compositor_state();
        let is_program = |runtime: &CompositorRuntime| {
            Arc::ptr_eq(
                &presented_frame_store(runtime),
                &runtime.program_frame_store,
            )
        };
        assert!(!is_program(&runtime), "nothing published: the primary");
        publish(&runtime.frame_store, 5);
        assert!(!is_program(&runtime), "no program frame: the primary");
        publish(&runtime.program_frame_store, 5);
        assert!(is_program(&runtime), "the same tick: the program");
        publish(&runtime.frame_store, 6);
        assert!(
            is_program(&runtime),
            "one tick behind (a retained twin frame): still the program"
        );
        publish(&runtime.frame_store, 7);
        assert!(!is_program(&runtime), "two ticks behind: the primary");
        publish(&runtime.program_frame_store, 7);
        assert!(is_program(&runtime));
        *runtime.program_frame_store.lock().unwrap() = FrameStore::new(2);
        assert!(
            !is_program(&runtime),
            "emptied (the leg went off): the primary"
        );
    }

    fn publish_flagged(
        store: &CompositorFrameStore,
        sequence: u64,
        benchmark: bool,
        test_pattern: bool,
    ) {
        store.lock().unwrap().publish_with_metadata(
            sequence,
            2,
            2,
            CompositorPixelFormat::yuv420p_cpu_buffer(),
            CompositorFrameExportHandle::default().with_scene_flags(benchmark, test_pattern),
            Instant::now(),
            vec![0; 6],
        );
    }

    fn latest_sequence(store: &CompositorFrameStore) -> Option<u64> {
        store.lock().unwrap().latest().map(|frame| frame.sequence)
    }

    fn evidence(sequence: u64, scene_revision: Option<u64>) -> CompositorFrameEvidence {
        CompositorFrameEvidence {
            sequence,
            scene_revision,
            width: 2,
            height: 2,
            has_real_source: true,
            camera_sequence: None,
            screen_sequence: None,
            has_image_source: false,
            published_at: Instant::now(),
        }
    }

    /// Plan 212 S4: the hold returns the frame presented when it began,
    /// across a release and a re-arm (the primary store moves on, is
    /// replaced by a fresh run's, and composes benchmark frames), until the
    /// first program frame after it ends it. The oracle reads the same
    /// store.
    #[tokio::test]
    async fn the_preview_hold_returns_the_pre_hold_frame_until_the_next_program_frame() {
        let state = test_state();
        // A live run (its task never ends): the release waits for a frame.
        let run_task = tokio::spawn(std::future::pending::<()>());
        {
            let mut runtime = state.compositor.lock().await;
            runtime.run_id = Some("preview-run".into());
            runtime.render_task = Some(run_task);
            publish_flagged(&runtime.frame_store, 5, false, false);
            runtime.frame_evidence.push_back(evidence(5, Some(7)));
            runtime.status.scene_revision = Some(7);
        }
        let guard = PreviewHoldGuard::engage(&state).await;
        {
            let runtime = state.compositor.lock().await;
            assert_eq!(
                runtime.status.preview_hold,
                Some(crate::protocol::PreviewHoldReason::PerformanceCheck)
            );
            assert_eq!(latest_sequence(&presented_frame_store(&runtime)), Some(5));
        }
        // Rung 1 arms the run: the ring is resized, benchmark frames are
        // published into the same store, the evidence ring rolls over.
        {
            let mut runtime = state.compositor.lock().await;
            *runtime.frame_store.lock().unwrap() = FrameStore::new(2);
            publish_flagged(&runtime.frame_store, 6, true, true);
            runtime.frame_evidence.clear();
            runtime.frame_evidence.push_back(evidence(6, Some(99)));
            assert_eq!(latest_sequence(&presented_frame_store(&runtime)), Some(5));
            let (frame, evidence) = select_presented_frame(&runtime, "preview-run", Some(7))
                .expect("held frame leases");
            assert_eq!(frame.sequence, 5);
            assert_eq!(evidence.scene_revision, Some(7));
        }
        // Between rungs the release composes a program frame: still held.
        {
            let runtime = state.compositor.lock().await;
            publish_flagged(&runtime.frame_store, 7, false, false);
            assert_eq!(latest_sequence(&presented_frame_store(&runtime)), Some(5));
        }
        // Rung 2 on a fresh run (the in-place arm was refused): the run id
        // changes; main's run id still leases the held frame.
        {
            let mut runtime = state.compositor.lock().await;
            runtime.run_id = Some("benchmark-run".into());
            runtime.frame_store = Arc::new(StdMutex::new(FrameStore::new(2)));
            publish_flagged(&runtime.frame_store, 1, true, true);
            assert_eq!(latest_sequence(&presented_frame_store(&runtime)), Some(5));
            assert!(select_presented_frame(&runtime, "benchmark-run", Some(7)).is_none());
            assert!(select_presented_frame(&runtime, "preview-run", Some(7)).is_some());
        }
        guard.release().await;
        {
            let runtime = state.compositor.lock().await;
            assert!(
                runtime.preview_hold.is_some(),
                "releasing waits for a program frame"
            );
            assert_eq!(latest_sequence(&presented_frame_store(&runtime)), Some(5));
            // A benchmark frame after the release never ends the hold: the
            // tick only asks on a program frame.
            publish_flagged(&runtime.frame_store, 2, true, true);
            assert_eq!(latest_sequence(&presented_frame_store(&runtime)), Some(5));
        }
        // The first program frame ends it: the live store is presented again.
        {
            let mut runtime = state.compositor.lock().await;
            runtime.run_id = Some("preview-run-2".into());
            runtime.frame_store = Arc::new(StdMutex::new(FrameStore::new(2)));
            publish_flagged(&runtime.frame_store, 3, false, false);
            assert!(end_preview_hold_if_releasing(&mut runtime));
            assert!(runtime.status.preview_hold.is_none());
            assert_eq!(latest_sequence(&presented_frame_store(&runtime)), Some(3));
            if let Some(task) = runtime.render_task.take() {
                task.abort();
            }
        }
    }

    /// Plan 212 S4: nothing was ever presented when the hold began: the
    /// hold's store is empty (the Preview keeps its starting placeholder),
    /// never the benchmark's frame composed after it.
    #[tokio::test]
    async fn the_preview_hold_never_holds_a_benchmark_frame() {
        let state = test_state();
        {
            let mut runtime = state.compositor.lock().await;
            runtime.run_id = Some("run".into());
            publish_flagged(&runtime.frame_store, 1, true, true);
        }
        let guard = PreviewHoldGuard::engage(&state).await;
        {
            let runtime = state.compositor.lock().await;
            assert_eq!(latest_sequence(&presented_frame_store(&runtime)), None);
            publish_flagged(&runtime.frame_store, 2, true, true);
            assert_eq!(latest_sequence(&presented_frame_store(&runtime)), None);
            assert!(select_presented_frame(&runtime, "run", None).is_none());
        }
        guard.release().await;
        assert!(
            !compositor_preview_hold_active(&state).await,
            "no live run: the release ends the hold at once"
        );
    }

    /// Plan 212 S6: the backstop refuses a frame composed from a scene with
    /// a test-pattern source in packaged mode only, counts it and leaves
    /// the dev build (the smokes' build) alone. A benchmark frame is refused
    /// to the lease in every build.
    #[test]
    fn the_backstop_refuses_test_pattern_frames_in_packaged_mode_only() {
        let runtime = initial_compositor_state();
        publish_flagged(&runtime.frame_store, 4, false, true);
        assert_eq!(
            latest_sequence(&presented_frame_store_for(&runtime, false)),
            Some(4),
            "dev: the test pattern presents"
        );
        assert_eq!(runtime.preview_backstop.refused(), 0);
        assert_eq!(
            latest_sequence(&presented_frame_store_for(&runtime, true)),
            None,
            "packaged: refused"
        );
        assert_eq!(
            latest_sequence(&presented_frame_store_for(&runtime, true)),
            None
        );
        assert_eq!(runtime.preview_backstop.refused(), 2);
        publish_flagged(&runtime.frame_store, 5, false, false);
        assert_eq!(
            latest_sequence(&presented_frame_store_for(&runtime, true)),
            Some(5),
            "packaged: a program frame presents"
        );

        let mut runtime = initial_compositor_state();
        runtime.run_id = Some("run".into());
        publish_flagged(&runtime.frame_store, 6, true, true);
        runtime.frame_evidence.push_back(evidence(6, None));
        assert!(
            select_presented_frame(&runtime, "run", None).is_none(),
            "a benchmark frame never leases"
        );
        publish_flagged(&runtime.frame_store, 7, false, false);
        runtime.frame_evidence.push_back(evidence(7, None));
        assert!(select_presented_frame(&runtime, "run", None).is_some());
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn preview_frame_lease_retains_surface_across_resize_and_releases_exactly_once() {
        let Some(mut gpu) = new_gpu_compositor(false) else {
            return;
        };
        gpu.compose_bgra(64, 36, [0.0, 0.0, 0.0, 1.0], &[]).unwrap();
        let export =
            CompositorFrameExportHandle::metal_target(gpu.latest_target_pixel_buffer().unwrap());
        let backing = Arc::downgrade(export.metal_target.as_ref().unwrap());
        let mut runtime = initial_compositor_state();
        runtime.run_id = Some("preview-run".into());
        runtime.status.scene_revision = Some(7);
        runtime.frame_store.lock().unwrap().publish_with_metadata(
            42,
            64,
            36,
            CompositorPixelFormat::yuv420p_with_metal_iosurface_target(64, 36),
            export,
            Instant::now(),
            vec![],
        );
        runtime.frame_evidence.push_back(CompositorFrameEvidence {
            sequence: 42,
            scene_revision: Some(7),
            width: 64,
            height: 36,
            has_real_source: false,
            camera_sequence: None,
            screen_sequence: None,
            has_image_source: false,
            published_at: Instant::now(),
        });
        assert!(acquire(&runtime, "old-run", Some(7)).is_none());
        assert!(acquire(&runtime, "preview-run", Some(6)).is_none());
        runtime.status.scene_revision = Some(8);
        assert!(acquire(&runtime, "preview-run", Some(7)).is_none());
        // Reopening can reset the diagnostic scene revision while the retained
        // scene still produces frames. The published frame remains authoritative;
        // never substitute an unknown revision or accept a different one.
        runtime.status.scene_revision = None;
        assert!(acquire(&runtime, "preview-run", None).is_none());
        assert!(acquire(&runtime, "preview-run", Some(6)).is_none());
        let lease = acquire(&runtime, "preview-run", Some(7)).unwrap();
        // The oracle's store remains readable while main owns the only lease.
        let oracle_frame = presented_frame_store(&runtime)
            .lock()
            .unwrap()
            .latest()
            .unwrap();
        assert_eq!(oracle_frame.sequence, 42);
        assert_eq!(runtime.preview_frame_lease_capacity.available_permits(), 0);
        drop(oracle_frame);

        assert_eq!(lease.frame.scene_revision, Some(7));
        assert!(
            acquire(&runtime, "preview-run", Some(7)).is_none(),
            "one outstanding lease globally"
        );
        gpu.compose_bgra(128, 72, [0.0, 0.0, 0.0, 1.0], &[])
            .unwrap();
        runtime.frame_store = Arc::new(StdMutex::new(FrameStore::new(2)));
        assert!(
            backing.upgrade().is_some(),
            "queued preview must retain the retired surface"
        );
        assert!(
            gpu.make_preview_presenter()
                .unwrap()
                .import_iosurface_texture_handle(
                    lease.frame.metal_target_iosurface_id.unwrap(),
                    64,
                    36,
                )
                .is_some()
        );
        drop(lease);
        assert!(backing.upgrade().is_none());
        assert_eq!(runtime.preview_frame_lease_capacity.available_permits(), 1);
    }
}
