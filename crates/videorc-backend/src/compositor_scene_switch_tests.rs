//! Pixel and adoption regressions for production scene switches. No native
//! capture, sleeps, or process timing are needed to arrange the handoff gap.
use super::*;

fn snapshot(kind: SceneSourceKind) -> CompositorSceneSnapshot {
    let mut scene = crate::scene::default_scene();
    let transform = SceneTransform {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
        crop_left: 0.0,
        crop_top: 0.0,
        crop_right: 0.0,
        crop_bottom: 0.0,
    };
    scene.sources.push(SceneSource {
        id: "source:base".into(),
        name: "Fixture".into(),
        kind,
        device_id: Some("screen:fixture".into()),
        transform: transform.clone(),
        default_transform: transform,
        visible: true,
        locked: false,
    });
    let mut layout = crate::protocol::default_layout_settings();
    layout.layout_preset = crate::protocol::LayoutPreset::ScreenOnly;
    CompositorSceneSnapshot {
        revision: 1,
        scene: Some(scene),
        layout,
        active_screen: None,
    }
}

fn inputs(snapshot: Option<&CompositorSceneSnapshot>) -> CompositorRenderInputs<'_> {
    CompositorRenderInputs {
        sequence: 33,
        width: 64,
        height: 36,
        snapshot,
        active_image_source: None,
        background_image_source: None,
        camera_frame: None,
        screen_frame: None,
        caption_overlay: None,
        highlight_overlay: None,
    }
}

fn assert_black(bytes: &[u8], width: u32, height: u32) {
    let luma = (width * height) as usize;
    assert_eq!(bytes.len(), raw_yuv420p_len(width, height));
    assert!(
        bytes[..luma].iter().all(|v| v.abs_diff(16) <= 1),
        "nonblack luma in unavailable-source output"
    );
    assert!(
        bytes[luma..].iter().all(|v| v.abs_diff(128) <= 1),
        "colored chroma in unavailable-source output"
    );
}

#[test]
fn unavailable_scene_is_black_on_cpu() {
    for kind in [
        SceneSourceKind::Screen,
        SceneSourceKind::Window,
        SceneSourceKind::Camera,
    ] {
        let scene = snapshot(kind);
        let mut bytes = vec![0; raw_yuv420p_len(64, 36)];
        render_compositor_yuv420p_frame(inputs(Some(&scene)), &mut bytes);
        assert_black(&bytes, 64, 36);
    }
    for scene in [
        None,
        Some(CompositorSceneSnapshot {
            scene: None,
            ..snapshot(SceneSourceKind::Screen)
        }),
    ] {
        let mut bytes = vec![0; raw_yuv420p_len(64, 36)];
        render_compositor_yuv420p_frame(inputs(scene.as_ref()), &mut bytes);
        assert_black(&bytes, 64, 36);
    }
}

#[cfg(target_os = "macos")]
#[test]
fn unavailable_scene_is_black_on_metal() {
    let Some(mut gpu) = new_gpu_compositor(false) else {
        eprintln!("SKIP: no Metal device; native black-output evidence unavailable");
        return;
    };
    for kind in [
        SceneSourceKind::Screen,
        SceneSourceKind::Window,
        SceneSourceKind::Camera,
    ] {
        let scene = snapshot(kind);
        let frame = try_gpu_compose(Some(&mut gpu), &inputs(Some(&scene)), true).unwrap();
        assert_black(&frame.yuv, 64, 36);
    }
}

#[test]
fn explicit_test_pattern_still_moves() {
    let scene = snapshot(SceneSourceKind::TestPattern);
    let mut first = vec![0; raw_yuv420p_len(64, 36)];
    let mut next = first.clone();
    render_compositor_yuv420p_frame(inputs(Some(&scene)), &mut first);
    render_compositor_yuv420p_frame(
        CompositorRenderInputs {
            sequence: 34,
            ..inputs(Some(&scene))
        },
        &mut next,
    );
    assert_ne!(first, next);
}

#[cfg(target_os = "macos")]
#[test]
fn empty_scene_clears_previous_frame_on_metal_without_cpu_fallback() {
    let Some(mut gpu) = new_gpu_compositor(false) else {
        eprintln!("SKIP: no Metal device; empty-scene output evidence unavailable");
        return;
    };
    let populated = snapshot(SceneSourceKind::TestPattern);
    let mut hidden = snapshot(SceneSourceKind::TestPattern);
    hidden.scene.as_mut().unwrap().sources[0].visible = false;
    let mut empty = snapshot(SceneSourceKind::TestPattern);
    empty.scene.as_mut().unwrap().sources.clear();
    let absent = CompositorSceneSnapshot {
        scene: None,
        ..snapshot(SceneSourceKind::TestPattern)
    };
    for scene in [None, Some(&absent), Some(&empty), Some(&hidden)] {
        // Reuse a previously painted target, as startup and live scene switches do.
        try_gpu_compose(Some(&mut gpu), &inputs(Some(&populated)), false).unwrap();
        let frame = try_gpu_compose(Some(&mut gpu), &inputs(scene), false)
            .expect("an empty scene must clear the Metal target without CPU fallback");
        assert!(frame.pixel_format.has_metal_iosurface_target());
        assert!(frame.yuv.is_empty());
        assert_eq!(frame.timings.gpu_readbacks, 0);
        let readable = try_gpu_compose(Some(&mut gpu), &inputs(scene), true).unwrap();
        assert_black(&readable.yuv, 64, 36);
    }
}

#[test]
fn missing_screen_opaquely_covers_the_layer_below_on_cpu() {
    let mut scene = snapshot(SceneSourceKind::Screen);
    let mut underlay = scene.scene.as_ref().unwrap().sources[0].clone();
    underlay.kind = SceneSourceKind::TestPattern;
    scene.scene.as_mut().unwrap().sources.insert(0, underlay);
    let mut bytes = vec![0; raw_yuv420p_len(64, 36)];
    render_compositor_yuv420p_frame(inputs(Some(&scene)), &mut bytes);
    assert_black(&bytes, 64, 36);
}

#[cfg(target_os = "macos")]
#[test]
fn missing_portrait_screen_opaquely_covers_the_layer_below_on_metal() {
    let Some(mut gpu) = new_gpu_compositor(false) else {
        eprintln!("SKIP: no Metal device; native black-output evidence unavailable");
        return;
    };
    let mut scene = snapshot(SceneSourceKind::Screen);
    let mut underlay = scene.scene.as_ref().unwrap().sources[0].clone();
    underlay.kind = SceneSourceKind::TestPattern;
    scene.scene.as_mut().unwrap().sources.insert(0, underlay);
    let frame = try_gpu_compose(
        Some(&mut gpu),
        &CompositorRenderInputs {
            width: 36,
            height: 64,
            ..inputs(Some(&scene))
        },
        true,
    )
    .unwrap();
    assert_black(&frame.yuv, 36, 64);
}

fn missing_image() -> CompositorImageSource {
    CompositorImageSource {
        image_path: "missing.png".into(),
        file_revision: None,
        width: None,
        height: None,
        rgba: None,
        bgra: None,
        content_revision: 1,
        state: "source-missing".into(),
        message: Some("Image unavailable".into()),
    }
}

#[test]
fn missing_takeover_does_not_expose_underlying_scene_on_cpu() {
    let scene = snapshot(SceneSourceKind::TestPattern);
    let image = missing_image();
    let mut bytes = vec![0; raw_yuv420p_len(64, 36)];
    render_compositor_yuv420p_frame(
        CompositorRenderInputs {
            active_image_source: Some(&image),
            ..inputs(Some(&scene))
        },
        &mut bytes,
    );
    assert_black(&bytes, 64, 36);
}

fn state() -> AppState {
    let (events, _) = tokio::sync::broadcast::channel(16);
    AppState::new(
        "test-token".into(),
        1234,
        events,
        crate::storage::Database::open_in_memory_for_tests(),
    )
}

async fn publish(
    state: &AppState,
    sources: &mut CompositorLiveSources,
    cache: &mut CompositorRenderCache,
) -> CompositorPublishResult {
    publish_compositor_frame(
        state,
        "scene-switch-test",
        1,
        64,
        36,
        sources,
        cache,
        None,
        CompositorFrameConsumer::RawYuvEncoder,
        None,
        None,
        false,
        false,
        false,
        false,
    )
    .await
}

#[tokio::test]
async fn ready_screen_is_adopted_on_first_scene_frame_before_periodic_refresh() {
    let state = state();
    let mut sources = CompositorLiveSources::default();
    let mut cache = CompositorRenderCache::refresh_initial(&state).await;
    let video = crate::protocol::VideoSettings {
        preset: crate::protocol::VideoPreset::Custom,
        width: 64,
        height: 36,
        fps: 30,
        bitrate_kbps: 2000,
    };
    crate::preview_screen::test_install_live_screen_generation(
        &state,
        "screen:fixture",
        7,
        41,
        &video,
    )
    .await;
    state.compositor.lock().await.scene = Some(snapshot(SceneSourceKind::Screen));
    // Deliberately do NOT run the periodic source refresh. Production must
    // adopt a ready source along with the scene at the publish boundary.
    let result = publish(&state, &mut sources, &mut cache).await;
    assert_eq!(result.fingerprint.screen, Some(41));
    let store = compositor_frame_store(&state).await;
    let frame = store.lock().unwrap().latest().unwrap();
    assert_black(&frame.bytes, 64, 36); // Fixture capture contains real black pixels.
}

fn video() -> crate::protocol::VideoSettings {
    crate::protocol::VideoSettings {
        preset: crate::protocol::VideoPreset::Custom,
        width: 64,
        height: 36,
        fps: 30,
        bitrate_kbps: 2000,
    }
}

async fn install_screen(
    state: &AppState,
    id: &str,
    generation: u64,
    sequence: u64,
    pixel: [u8; 4],
) {
    crate::preview_screen::test_install_live_screen_generation(
        state,
        id,
        generation,
        sequence,
        &video(),
    )
    .await;
    crate::preview_screen::test_publish_screen_pixels(
        state,
        sequence,
        pixel,
        Instant::now() - Duration::from_secs(10),
    )
    .await; // Static screen is valid at any age.
}

async fn latest_bytes(state: &AppState) -> Vec<u8> {
    compositor_frame_store(state)
        .await
        .lock()
        .unwrap()
        .latest()
        .unwrap()
        .bytes
        .to_vec()
}

#[tokio::test]
async fn source_switch_retries_contention_and_never_exposes_previous_device() {
    let state = state();
    let mut scene = snapshot(SceneSourceKind::Screen);
    state.compositor.lock().await.scene = Some(scene.clone());
    install_screen(&state, "screen:fixture", 1, 11, [0, 255, 0, 255]).await;
    let mut sources = CompositorLiveSources::default();
    let mut cache = CompositorRenderCache::refresh_initial(&state).await;
    assert_eq!(
        publish(&state, &mut sources, &mut cache)
            .await
            .fingerprint
            .screen,
        Some(11)
    );
    let green = latest_bytes(&state).await;
    assert!(green[64 * 18 + 32] > 100);

    scene.revision = 2;
    scene.scene.as_mut().unwrap().sources[0].device_id = Some("screen:next".into());
    state.compositor.lock().await.scene = Some(scene.clone());
    let held = state.preview_screen.lock().await;
    assert_eq!(
        publish(&state, &mut sources, &mut cache)
            .await
            .fingerprint
            .screen,
        None
    );
    assert_black(&latest_bytes(&state).await, 64, 36);
    drop(held);
    // The old device is still installed. Its perfectly valid frame must not
    // masquerade as the selected device after the registry becomes accessible.
    assert_eq!(
        publish(&state, &mut sources, &mut cache)
            .await
            .fingerprint
            .screen,
        None
    );
    assert_black(&latest_bytes(&state).await, 64, 36);
    install_screen(&state, "screen:next", 2, 22, [255, 0, 0, 255]).await;
    assert_eq!(
        publish(&state, &mut sources, &mut cache)
            .await
            .fingerprint
            .screen,
        Some(22)
    );
    let blue = latest_bytes(&state).await;
    assert_ne!(blue, green);

    // Rapid A→B→A: a late B producer cannot paint the now-selected A scene.
    scene.revision = 3;
    scene.scene.as_mut().unwrap().sources[0].device_id = Some("screen:fixture".into());
    state.compositor.lock().await.scene = Some(scene);
    assert_eq!(
        publish(&state, &mut sources, &mut cache)
            .await
            .fingerprint
            .screen,
        None
    );
    install_screen(&state, "screen:fixture", 3, 33, [0, 255, 0, 255]).await;
    assert_eq!(
        publish(&state, &mut sources, &mut cache)
            .await
            .fingerprint
            .screen,
        Some(33)
    );
    assert_eq!(latest_bytes(&state).await, green);
}

#[tokio::test]
async fn same_device_new_generation_is_adopted_at_scene_commit() {
    let state = state();
    let mut scene = snapshot(SceneSourceKind::Screen);
    state.compositor.lock().await.scene = Some(scene.clone());
    install_screen(&state, "screen:fixture", 1, 11, [0, 255, 0, 255]).await;
    let mut sources = CompositorLiveSources::default();
    let mut cache = CompositorRenderCache::refresh_initial(&state).await;
    publish(&state, &mut sources, &mut cache).await;
    install_screen(&state, "screen:fixture", 2, 22, [255, 0, 0, 255]).await;
    scene.revision += 1;
    state.compositor.lock().await.scene = Some(scene);
    assert_eq!(
        publish(&state, &mut sources, &mut cache)
            .await
            .fingerprint
            .screen,
        Some(22)
    );
    assert_eq!(sources.screen.as_ref().unwrap().generation(), 2);
    assert!(matches!(
        sources.pending_screen_change,
        Some(CompositorScreenSourceChange::Adopted { generation: 2, .. })
    ));
}

#[tokio::test]
async fn stale_camera_is_black_but_static_screen_stays_visible() {
    let state = state();
    let mut scene = snapshot(SceneSourceKind::Camera);
    scene.layout.layout_preset = crate::protocol::LayoutPreset::CameraOnly;
    crate::preview_camera::test_install_live_camera_for_layout(
        &state,
        "screen:fixture",
        &scene.layout,
        &video(),
    )
    .await;
    crate::preview_camera::test_publish_camera_pixels(
        &state,
        11,
        [0, 0, 255, 255],
        Instant::now() - Duration::from_secs(10),
    )
    .await;
    state.compositor.lock().await.scene = Some(scene);
    let mut sources = CompositorLiveSources::default();
    let mut cache = CompositorRenderCache::refresh_initial(&state).await;
    let result = publish(&state, &mut sources, &mut cache).await;
    assert_eq!(result.fingerprint.camera, None);
    assert_black(&latest_bytes(&state).await, 64, 36);
}

/// Also consumed by smoke:scene-switch-pixels. It renders both actual output
/// stores through the CPU and Metal publishers; the smoke encodes the bytes,
/// receives the stream locally and checks every decoded frame against them.
#[tokio::test]
async fn scene_switch_artifact_fixture() {
    use std::io::Write;
    let directory =
        std::env::var_os("VIDEORC_SCENE_SWITCH_ARTIFACT_DIR").map(std::path::PathBuf::from);
    for metal in [false, true] {
        if metal && !cfg!(target_os = "macos") {
            continue;
        }
        let mut gpu = if metal {
            new_gpu_compositor(false)
        } else {
            None
        };
        let mut stream_gpu = if metal {
            new_gpu_compositor(false)
        } else {
            None
        };
        if metal && (gpu.is_none() || stream_gpu.is_none()) {
            assert!(
                directory.is_none(),
                "Metal is required for this artifact smoke"
            );
            eprintln!("SKIP: Metal fixture unavailable");
            continue;
        }
        let state = state();
        let mut camera = snapshot(SceneSourceKind::Camera);
        camera.scene.as_mut().unwrap().sources[0].device_id = Some("camera:fixture".into());
        camera.layout.layout_preset = crate::protocol::LayoutPreset::CameraOnly;
        crate::preview_camera::test_install_live_camera_for_layout(
            &state,
            "camera:fixture",
            &camera.layout,
            &video(),
        )
        .await;
        let mut combined = snapshot(SceneSourceKind::Screen);
        let mut inset = camera.scene.as_ref().unwrap().sources[0].clone();
        inset.transform.x = 0.7;
        inset.transform.y = 0.0;
        inset.transform.width = 0.3;
        inset.transform.height = 0.3;
        combined.scene.as_mut().unwrap().sources.push(inset);
        let start = Instant::now();
        let transition = SceneTransition {
            from: camera.scene.clone().unwrap(),
            started_at: start,
            duration: Duration::from_millis(320),
        };
        let stream_store = Arc::new(StdMutex::new(FrameStore::new(2)));
        state.compositor.lock().await.stream_frame_store = Some(stream_store.clone());
        let mut sources = CompositorLiveSources::default();
        let mut cache = CompositorRenderCache::refresh_initial(&state).await;
        let mode = if metal { "metal" } else { "cpu" };
        let mut files = directory.as_ref().map(|dir| {
            std::fs::create_dir_all(dir).unwrap();
            (
                std::fs::File::create(dir.join(format!("{mode}-primary.yuv"))).unwrap(),
                std::fs::File::create(dir.join(format!("{mode}-stream.yuv"))).unwrap(),
            )
        });
        for tick in 0..120_u64 {
            // Four rapid cycles: camera-only → missing-screen + camera →
            // delayed ready screen → screen-only. A/B screen identities alternate.
            let phase = tick % 30;
            let cycle = tick / 30;
            let id = if cycle % 2 == 0 {
                "screen:fixture"
            } else {
                "screen:other"
            };
            let mut target = if phase < 5 {
                camera.clone()
            } else {
                combined.clone()
            };
            if phase >= 5 {
                target.scene.as_mut().unwrap().sources[0].device_id = Some(id.into());
                if phase >= 25 {
                    target.scene.as_mut().unwrap().sources.truncate(1);
                } else {
                    target.scene = Some(scene_with_transition(
                        target.scene.take().unwrap(),
                        &transition,
                        start + Duration::from_millis((phase - 5) * 33),
                    ));
                }
            }
            target.revision = tick + 1;
            if phase == 0 {
                // Stop a fixture-owned slot without spawning any native process.
                crate::preview_screen::stop_preview_screen(&state).await;
            }
            if phase == 10 {
                install_screen(
                    &state,
                    id,
                    cycle + 1,
                    tick + 1,
                    if cycle % 2 == 0 {
                        [0, 255, 0, 255]
                    } else {
                        [255, 0, 0, 255]
                    },
                )
                .await;
            }
            crate::preview_camera::test_publish_camera_pixels(
                &state,
                tick + 1,
                [0, 0, 255, 255],
                Instant::now(),
            )
            .await;
            {
                let mut compositor = state.compositor.lock().await;
                compositor.scene = Some(target.clone());
                compositor.simulcast_scene = Some(target);
            }
            let result = publish_compositor_frame(
                &state,
                "scene-switch-test",
                tick + 1,
                64,
                36,
                &mut sources,
                &mut cache,
                gpu.as_mut(),
                CompositorFrameConsumer::RawYuvEncoder,
                Some(CompositorAuxiliaryOutput {
                    width: 36,
                    height: 64,
                    frame_consumer: CompositorFrameConsumer::RawYuvEncoder,
                    composes_simulcast_scene: true,
                }),
                stream_gpu.as_mut(),
                false,
                false,
                false,
                false,
            )
            .await;
            if metal {
                assert_eq!(result.compositor_backend, CompositorBackend::Metal);
            }
            assert_eq!(result.fingerprint.screen.is_some(), phase >= 10);
            let primary = latest_bytes(&state).await;
            let stream = stream_store
                .lock()
                .unwrap()
                .latest()
                .unwrap()
                .bytes
                .to_vec();
            // Lower center is outside the moving camera after its first 3
            // transition frames. It must be black until the screen arrives.
            if (8..10).contains(&phase) {
                assert!(primary[34 * 64 + 20].abs_diff(16) <= 1);
            }
            if let Some((primary_file, stream_file)) = files.as_mut() {
                primary_file.write_all(&primary).unwrap();
                stream_file.write_all(&stream).unwrap();
            }
        }
    }
}

#[test]
fn source_edit_camera_none_round_trip_preserves_every_scene_field_on_both_legs() {
    use crate::live_source_switch::SourceKind;
    let mut primary = snapshot(SceneSourceKind::Camera);
    primary.scene.as_mut().unwrap().sources[0].device_id = Some("camera:A".into());
    primary.scene.as_mut().unwrap().sources[0]
        .transform
        .crop_left = 0.17;
    primary.scene.as_mut().unwrap().sources[0].transform.width = 0.42;
    primary.scene.as_mut().unwrap().sources[0].locked = true;
    let mut auxiliary = primary.clone();
    auxiliary.scene.as_mut().unwrap().sources[0].visible = false;
    auxiliary.scene.as_mut().unwrap().sources[0].transform.y = 0.63;
    auxiliary.layout.layout_preset = crate::protocol::LayoutPreset::VerticalCameraOnly;
    let expected_primary = primary.clone();
    let expected_auxiliary = auxiliary.clone();
    let mut edit = CompositorSourceEdit {
        primary,
        auxiliary: Some(auxiliary),
    };
    let mut sources = crate::protocol::SourceSelection {
        camera_id: None,
        screen_id: None,
        window_id: None,
        microphone_id: None,
        test_pattern: false,
    };
    edit.patch(SourceKind::Camera, None, &sources);
    assert!(!crate::live_layout::required_scene_sources(edit.primary()).camera);
    assert!(!scene_needs_live_camera_frame(Some(&edit.primary), None));
    let mut bytes = vec![0; raw_yuv420p_len(64, 36)];
    let mut store = FrameStore::new(1);
    store.publish(
        55,
        64,
        36,
        PreviewCameraPixelFormat::Bgra8,
        Instant::now(),
        vec![255; 64 * 36 * 4],
    );
    let old = store.latest().unwrap();
    render_compositor_yuv420p_frame(
        CompositorRenderInputs {
            camera_frame: Some(&old),
            ..inputs(Some(&edit.primary))
        },
        &mut bytes,
    );
    assert_black(&bytes, 64, 36);
    #[cfg(target_os = "macos")]
    if let Some(mut gpu) = new_gpu_compositor(false) {
        let frame = try_gpu_compose(
            Some(&mut gpu),
            &CompositorRenderInputs {
                camera_frame: Some(&old),
                ..inputs(Some(&edit.primary))
            },
            true,
        )
        .unwrap();
        assert_black(&frame.yuv, 64, 36);
    }
    sources.camera_id = Some("camera:A".into());
    edit.patch(SourceKind::Camera, Some("camera:A"), &sources);
    assert_eq!(edit.primary, expected_primary);
    assert_eq!(edit.auxiliary, Some(expected_auxiliary));
}

#[test]
fn source_edit_inserts_only_a_never_created_camera_slot_and_keeps_auxiliary_demand() {
    let mut primary = snapshot(SceneSourceKind::Screen);
    primary.layout.layout_preset = crate::protocol::LayoutPreset::ScreenCamera;
    let base = primary.scene.as_ref().unwrap().sources[0].clone();
    let mut auxiliary = primary.clone();
    auxiliary.layout.layout_preset = crate::protocol::LayoutPreset::VerticalCameraOnly;
    let mut edit = CompositorSourceEdit {
        primary,
        auxiliary: Some(auxiliary),
    };
    let sources = crate::protocol::SourceSelection {
        camera_id: Some("camera:B".into()),
        screen_id: Some("screen:fixture".into()),
        window_id: None,
        microphone_id: None,
        test_pattern: false,
    };
    edit.patch(
        crate::live_source_switch::SourceKind::Camera,
        Some("camera:B"),
        &sources,
    );
    assert_eq!(edit.primary().sources[0], base);
    assert_eq!(
        edit.primary()
            .sources
            .iter()
            .filter(|source| source.kind == SceneSourceKind::Camera)
            .count(),
        1
    );
    assert!(
        edit.scenes()
            .all(|scene| crate::live_layout::required_scene_sources(scene).camera)
    );
    let added = edit.primary().clone();
    edit.patch(
        crate::live_source_switch::SourceKind::Camera,
        Some("camera:B"),
        &sources,
    );
    assert_eq!(edit.primary(), &added);
}

#[test]
fn source_edit_inserts_missing_capture_only_where_the_existing_layout_admits_it() {
    let mut primary = snapshot(SceneSourceKind::Camera);
    primary.layout.layout_preset = crate::protocol::LayoutPreset::ScreenCamera;
    let base = primary.scene.as_ref().unwrap().sources[0].clone();
    let mut auxiliary = primary.clone();
    auxiliary.layout.layout_preset = crate::protocol::LayoutPreset::VerticalCameraOnly;
    let mut edit = CompositorSourceEdit {
        primary,
        auxiliary: Some(auxiliary),
    };
    let sources = crate::protocol::SourceSelection {
        camera_id: base.device_id.clone(),
        screen_id: Some("screen:B".into()),
        window_id: None,
        microphone_id: None,
        test_pattern: false,
    };
    edit.patch(
        crate::live_source_switch::SourceKind::Capture,
        Some("screen:B"),
        &sources,
    );
    assert_eq!(edit.primary().sources[0], base);
    assert!(crate::live_layout::required_scene_sources(edit.primary()).screen);
    assert!(
        !crate::live_layout::required_scene_sources(
            edit.auxiliary.as_ref().unwrap().scene.as_ref().unwrap()
        )
        .screen
    );
    let once = edit.clone();
    edit.patch(
        crate::live_source_switch::SourceKind::Capture,
        Some("screen:B"),
        &sources,
    );
    assert!(edit == once);
}

#[test]
fn camera_only_initial_none_never_reveals_retained_screen_after_round_trip() {
    use crate::live_source_switch::SourceKind;
    for preset in [
        crate::protocol::LayoutPreset::CameraOnly,
        crate::protocol::LayoutPreset::VerticalCameraOnly,
    ] {
        let mut primary = snapshot(SceneSourceKind::Screen);
        primary.layout.layout_preset = preset;
        primary.layout.arrangement_mode = crate::protocol::ArrangementMode::Preset;
        let mut sources = crate::protocol::SourceSelection {
            camera_id: None,
            screen_id: Some("screen:retained".into()),
            window_id: None,
            microphone_id: None,
            test_pattern: false,
        };
        primary.scene = Some(crate::scene::scene_from_capture_config(
            crate::protocol::SceneConfigParams {
                sources: sources.clone(),
                layout: primary.layout.clone(),
                video: Some(video()),
                background: None,
                protected_overlay_window_ids: vec![],
                transition_ms: None,
            },
        ));
        let mut edit = CompositorSourceEdit {
            primary,
            auxiliary: None,
        };
        assert_eq!(edit.primary().sources.len(), 1);
        assert_eq!(edit.primary().sources[0].kind, SceneSourceKind::Camera);
        assert!(edit.primary().sources[0].device_id.is_none());
        sources.camera_id = Some("camera:B".into());
        edit.patch(SourceKind::Camera, Some("camera:B"), &sources);
        sources.camera_id = None;
        edit.patch(SourceKind::Camera, None, &sources);
        assert!(!crate::live_layout::required_scene_sources(edit.primary()).screen);
        let mut store = FrameStore::new(1);
        store.publish(
            99,
            64,
            36,
            PreviewScreenPixelFormat::Bgra8,
            Instant::now(),
            vec![255; 64 * 36 * 4],
        );
        let screen = store.latest().unwrap();
        let mut bytes = vec![0; raw_yuv420p_len(64, 36)];
        render_compositor_yuv420p_frame(
            CompositorRenderInputs {
                screen_frame: Some(&screen),
                ..inputs(Some(&edit.primary))
            },
            &mut bytes,
        );
        assert_black(&bytes, 64, 36);
    }
}

#[tokio::test]
async fn source_edit_required_capture_none_is_rejected_before_any_mutation() {
    let state = state();
    let original = snapshot(SceneSourceKind::Screen);
    state.compositor.lock().await.scene = Some(original.clone());
    let error = crate::live_layout::switch_session_video_source(
        &state,
        &crate::live_source_switch::SourceSwitchParams {
            session_id: "not-started".into(),
            request_id: "required-none".into(),
            expected_source_revision: 0,
            kind: crate::live_source_switch::SourceKind::Capture,
            device_id: None,
            protected_overlay_window_ids: vec![],
        },
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("requires a screen or window"));
    assert!(state.compositor.lock().await.scene.as_ref() == Some(&original));
    assert_eq!(state.latest_layout_intent_id(), 0);
}

#[test]
fn source_edit_proof_requires_exact_generation_revision_and_renderable_camera() {
    let mut scene = snapshot(SceneSourceKind::Camera);
    scene.scene.as_mut().unwrap().sources[0].device_id = Some("camera:B".into());
    let key = SourceKey::camera("camera:B");
    let receipt = SourceEditReceipt {
        session_id: "session".into(),
        request_id: "switch".into(),
        revision: 1,
        auxiliary_revision: None,
        kind: crate::live_source_switch::SourceKind::Camera,
        device_id: Some("camera:B".into()),
        camera: Some((key.clone(), 3)),
        screen: None,
    };
    assert!(source_edit_frame_matches(
        &receipt,
        Some(&scene),
        Some((&key, 3)),
        None,
        true,
        false
    ));
    assert!(!source_edit_frame_matches(
        &receipt,
        Some(&scene),
        Some((&key, 2)),
        None,
        true,
        false
    ));
    assert!(!source_edit_frame_matches(
        &receipt,
        Some(&scene),
        Some((&key, 3)),
        None,
        false,
        false
    ));
    let stale = Instant::now() - Duration::from_secs(5);
    assert!(!source_edit_frame_matches(
        &receipt,
        Some(&scene),
        Some((&key, 3)),
        None,
        !source_frame_is_too_stale(stale),
        false
    ));
    scene.revision = 2;
    assert!(!source_edit_frame_matches(
        &receipt,
        Some(&scene),
        Some((&key, 3)),
        None,
        true,
        false
    ));
}

#[tokio::test]
async fn source_edit_publication_refuses_stale_camera_and_failed_auxiliary_output() {
    use crate::live_source_switch::{SourceKind, SourceSwitchParams};
    for case in [
        "stale-camera",
        "native-authority",
        "native-authority-gap",
        "empty-auxiliary",
        "missing-auxiliary",
        "layout-before-frame",
        "layout-replaced-source",
        "healthy",
    ] {
        let state = state();
        let mut scene = snapshot(SceneSourceKind::Camera);
        scene.scene.as_mut().unwrap().sources[0].device_id = Some("camera:B".into());
        scene.layout.layout_preset = crate::protocol::LayoutPreset::CameraOnly;
        crate::preview_camera::test_install_live_camera_for_layout(
            &state,
            "camera:B",
            &scene.layout,
            &video(),
        )
        .await;
        crate::preview_camera::test_publish_camera_pixels(
            &state,
            8,
            [0, 0, 255, 255],
            if case == "stale-camera" {
                Instant::now() - Duration::from_secs(5)
            } else {
                Instant::now()
            },
        )
        .await;
        let camera = crate::preview_camera::preview_camera_frame_source(&state)
            .await
            .unwrap();
        let selected = crate::protocol::SourceSelection {
            camera_id: Some("camera:B".into()),
            screen_id: None,
            window_id: None,
            microphone_id: None,
            test_pattern: false,
        };
        let request = SourceSwitchParams {
            session_id: "proof-session".into(),
            request_id: "proof-switch".into(),
            expected_source_revision: 0,
            kind: SourceKind::Camera,
            device_id: Some("camera:B".into()),
            protected_overlay_window_ids: vec![],
        };
        {
            let mut coordinator = state.live_source_switch.lock().unwrap();
            coordinator.start(request.session_id.clone(), selected);
            coordinator.enable_video();
            coordinator.admit(&request).unwrap();
            coordinator.commit_video(&request).unwrap();
        }
        {
            let mut compositor = state.compositor.lock().await;
            compositor.run_id = Some("scene-switch-test".into());
            compositor.scene = Some(scene.clone());
            compositor.simulcast_scene = Some(scene.clone());
            compositor.stream_frame_store =
                (case != "missing-auxiliary").then(|| Arc::new(StdMutex::new(FrameStore::new(2))));
            compositor.source_edit_receipt = Some(SourceEditReceipt {
                session_id: request.session_id.clone(),
                request_id: request.request_id.clone(),
                revision: 1,
                auxiliary_revision: Some(1),
                kind: crate::live_source_switch::SourceKind::Camera,
                device_id: Some("camera:B".into()),
                camera: Some((SourceKey::camera("camera:B"), camera.generation())),
                screen: None,
            });
        }
        let mut native_lease = if matches!(case, "native-authority" | "native-authority-gap") {
            Some(
                state
                    .compositor
                    .lock()
                    .await
                    .claim_native_source_output("proof-session", 7),
            )
        } else {
            None
        };
        if case == "native-authority-gap" {
            drop(native_lease.take());
        }
        if matches!(case, "layout-before-frame" | "layout-replaced-source") {
            let mut changed = scene.scene.clone().unwrap();
            changed.sources[0].transform.width = 0.6;
            if case == "layout-replaced-source" {
                changed.sources[0].device_id = Some("camera:C".into());
            }
            update_compositor_scene(
                &state,
                crate::protocol::CompositorSceneUpdateParams {
                    revision: 2,
                    scene: Some(changed),
                    layout: scene.layout.clone(),
                    active_screen: None,
                    transition_ms: None,
                },
            )
            .await;
            assert!(
                !state
                    .live_source_switch
                    .lock()
                    .unwrap()
                    .snapshot("proof-session")
                    .unwrap()
                    .last_operation
                    .unwrap()
                    .output_observed
            );
        }
        let mut sources = CompositorLiveSources::default();
        let mut cache = CompositorRenderCache::refresh_initial(&state).await;
        publish_compositor_frame(
            &state,
            "scene-switch-test",
            1,
            64,
            36,
            &mut sources,
            &mut cache,
            None,
            CompositorFrameConsumer::RawYuvEncoder,
            Some(CompositorAuxiliaryOutput {
                width: 36,
                height: 64,
                frame_consumer: if case == "empty-auxiliary" {
                    CompositorFrameConsumer::NativePreview
                } else {
                    CompositorFrameConsumer::RawYuvEncoder
                },
                composes_simulcast_scene: true,
            }),
            None,
            false,
            false,
            false,
            false,
        )
        .await;
        let snapshot = state
            .live_source_switch
            .lock()
            .unwrap()
            .snapshot("proof-session")
            .unwrap();
        assert_eq!(
            snapshot.last_operation.as_ref().unwrap().output_observed,
            matches!(case, "healthy" | "layout-before-frame"),
            "{case}"
        );
        assert_eq!(
            snapshot.last_operation.unwrap().output_superseded,
            case == "layout-replaced-source"
        );
        if matches!(case, "native-authority" | "native-authority-gap") {
            let mut compositor = state.compositor.lock().await;
            let recovered_lease = compositor.claim_native_source_output("proof-session", 8);
            let edit = compositor.source_edit_snapshot().unwrap();
            let mut coordinator = state.live_source_switch.lock().unwrap();
            for (session, generation, both_legs) in [
                ("old-session", 7, true),
                ("proof-session", 6, true),
                ("proof-session", 8, false),
            ] {
                compositor.observe_windows_source_publication(
                    &mut coordinator,
                    &edit,
                    session,
                    generation,
                    camera.source_key().map(|key| (key, camera.generation())),
                    None,
                    true,
                    false,
                    both_legs,
                );
                assert!(
                    !coordinator
                        .snapshot("proof-session")
                        .unwrap()
                        .last_operation
                        .unwrap()
                        .output_observed
                );
            }
            compositor.observe_windows_source_publication(
                &mut coordinator,
                &edit,
                "proof-session",
                8,
                camera.source_key().map(|key| (key, camera.generation())),
                None,
                true,
                false,
                true,
            );
            assert!(
                coordinator
                    .snapshot("proof-session")
                    .unwrap()
                    .last_operation
                    .unwrap()
                    .output_observed
            );
            drop(native_lease); // guaranteed even while the compositor mutex is held
            drop(recovered_lease);
            assert!(
                !compositor
                    .native_source_output_authority
                    .is_generic_for("proof-session")
            );
            compositor
                .native_source_output_authority
                .release_session("proof-session");
            assert!(
                compositor
                    .native_source_output_authority
                    .is_generic_for("proof-session")
            );
        }
        crate::preview_camera::stop_preview_camera(&state).await;
    }
}

#[tokio::test]
async fn source_edit_takeover_pixels_do_not_prove_hidden_capture_and_clear_reveals_target() {
    use crate::live_source_switch::{SourceKind, SourceSwitchParams};
    let state = state();
    install_screen(&state, "screen:fixture", 7, 40, [0, 255, 0, 255]).await;
    let mut scene = snapshot(SceneSourceKind::Screen);
    scene.active_screen = Some(crate::protocol::StreamScreen {
        id: "takeover".into(),
        name: "Takeover".into(),
        image_path: "fixture.png".into(),
        thumbnail_path: None,
        sort_order: 0,
        status: crate::protocol::StreamScreenStatus::Ready,
        created_at: String::new(),
        updated_at: String::new(),
    });
    let request = SourceSwitchParams {
        session_id: "proof".into(),
        request_id: "capture-B".into(),
        expected_source_revision: 0,
        kind: SourceKind::Capture,
        device_id: Some("screen:fixture".into()),
        protected_overlay_window_ids: vec![],
    };
    {
        let mut coordinator = state.live_source_switch.lock().unwrap();
        coordinator.start(
            "proof".into(),
            crate::protocol::SourceSelection {
                camera_id: None,
                screen_id: Some("screen:fixture".into()),
                window_id: None,
                microphone_id: None,
                test_pattern: false,
            },
        );
        coordinator.enable_video();
        coordinator.admit(&request).unwrap();
        coordinator.commit_video(&request).unwrap();
    }
    {
        let mut compositor = state.compositor.lock().await;
        compositor.run_id = Some("scene-switch-test".into());
        compositor.scene = Some(scene.clone());
        compositor.simulcast_scene = Some(scene.clone());
        compositor.stream_frame_store = Some(Arc::new(StdMutex::new(FrameStore::new(2))));
        compositor.cache_prepared_image(
            "takeover".into(),
            CompositorImageSource {
                width: Some(2),
                height: Some(2),
                rgba: Some(Arc::new(vec![255; 16])),
                bgra: Some(Arc::new(vec![255; 16])),
                ..missing_image()
            },
        );
        compositor.source_edit_receipt = Some(SourceEditReceipt {
            session_id: "proof".into(),
            request_id: "capture-B".into(),
            revision: 1,
            auxiliary_revision: Some(1),
            kind: SourceKind::Capture,
            device_id: Some("screen:fixture".into()),
            camera: None,
            screen: Some((SourceKey::screen("screen:fixture"), 7)),
        });
    }
    let mut sources = CompositorLiveSources::default();
    let mut cache = CompositorRenderCache::refresh_initial(&state).await;
    for takeover in [true, false] {
        if !takeover {
            state
                .compositor
                .lock()
                .await
                .scene
                .as_mut()
                .unwrap()
                .active_screen = None;
        }
        publish_compositor_frame(
            &state,
            "scene-switch-test",
            if takeover { 1 } else { 2 },
            64,
            36,
            &mut sources,
            &mut cache,
            None,
            CompositorFrameConsumer::RawYuvEncoder,
            Some(CompositorAuxiliaryOutput {
                width: 36,
                height: 64,
                frame_consumer: CompositorFrameConsumer::RawYuvEncoder,
                composes_simulcast_scene: true,
            }),
            None,
            false,
            false,
            false,
            false,
        )
        .await;
        let observed = state
            .live_source_switch
            .lock()
            .unwrap()
            .snapshot("proof")
            .unwrap()
            .last_operation
            .unwrap()
            .output_observed;
        assert_eq!(observed, !takeover);
        let pixels = latest_bytes(&state).await;
        if takeover {
            assert!(
                pixels[18 * 64 + 32] > 220,
                "white takeover center is rendered"
            );
        } else {
            assert!(
                pixels[18 * 64 + 32] < 200,
                "the green capture replaces the takeover center"
            );
        }
    }
    crate::preview_screen::stop_preview_screen(&state).await;
}

#[tokio::test]
async fn windows_source_binding_rejects_failed_cached_source_but_accepts_static_live_screen() {
    let state = state();
    install_screen(&state, "screen:fixture", 7, 40, [0, 255, 0, 255]).await;
    let mut screen = state.preview_screen.lock().await;
    screen.status.state = crate::protocol::PreviewScreenState::Live;
    screen.status.frame_age_ms = Some(10_000);
    assert!(
        crate::preview_screen::available_frame_source_locked(&screen)
            .unwrap()
            .latest_frame_blocking()
            .is_some()
    );
    screen.status.state = crate::protocol::PreviewScreenState::Failed;
    assert!(
        crate::preview_screen::frame_source_locked(&screen).is_some(),
        "failed adapter retains cached frame store"
    );
    assert!(
        crate::preview_screen::available_frame_source_locked(&screen).is_none(),
        "failed store is not an on-air source"
    );
    drop(screen);
    let scene = snapshot(SceneSourceKind::Camera);
    crate::preview_camera::test_install_live_camera_for_layout(
        &state,
        "camera:B",
        &scene.layout,
        &video(),
    )
    .await;
    let mut camera = state.preview_camera.lock().await;
    assert!(crate::preview_camera::available_frame_source_locked(&camera).is_some());
    camera.status.state = crate::protocol::PreviewCameraState::Failed;
    assert!(crate::preview_camera::available_frame_source_locked(&camera).is_none());
    drop(camera);
    crate::preview_camera::stop_preview_camera(&state).await;
}

#[tokio::test]
async fn windows_source_render_edit_samples_glide_without_mutating_committed_proof() {
    let state = state();
    let now = Instant::now();
    let mut target = snapshot(SceneSourceKind::Camera);
    target.scene.as_mut().unwrap().sources[0].transform.x = 0.5;
    let mut from = target.scene.clone().unwrap();
    from.sources[0].transform.x = 0.0;
    let mut compositor = state.compositor.lock().await;
    compositor.scene = Some(target.clone());
    compositor.scene_transition = Some(SceneTransition {
        from,
        started_at: now,
        duration: Duration::from_secs(2),
    });
    let committed = compositor.source_edit_snapshot().unwrap();
    let rendered = compositor
        .source_render_edit(now + Duration::from_secs(1))
        .unwrap();
    assert_eq!(
        rendered.primary.scene.as_ref().unwrap().sources[0]
            .transform
            .x,
        0.25
    );
    assert_eq!(
        committed.primary.scene.as_ref().unwrap().sources[0]
            .transform
            .x,
        0.5
    );
    assert!(compositor.source_edit_is_current(&committed));
    assert!(!compositor.source_edit_is_current(&rendered));
}
