//! Connection-owned preview handoff. An IOSurface ID alone does not keep its
//! storage alive when a resize replaces the compositor target ring.
use super::*;

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

fn acquire(
    compositor: &CompositorRuntime,
    run_id: &str,
    scene_revision: Option<u64>,
) -> Option<CompositorPreviewFrameLease> {
    if compositor.run_id.as_deref() != Some(run_id)
        || (compositor.status.scene_revision.is_some()
            && compositor.status.scene_revision != scene_revision)
    {
        return None;
    }
    let permit = compositor
        .preview_frame_lease_capacity
        .clone()
        .try_acquire_owned()
        .ok()?;
    let frame = compositor
        .frame_store
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .latest()?;
    let evidence = compositor
        .frame_evidence
        .iter()
        .find(|e| e.sequence == frame.sequence)?;
    if evidence.scene_revision != scene_revision {
        return None;
    }
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
