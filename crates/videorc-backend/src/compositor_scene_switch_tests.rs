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
