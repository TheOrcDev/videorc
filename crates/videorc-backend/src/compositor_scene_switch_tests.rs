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
        selected_sources: None,
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
        buddy_overlay: None,
        buddy_leg: None,
        banners: &[],
        live_background: None,
        shared_live_frame: None,
        shared_live_output: None,
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
        None,
        None,
        None,
        false,
        false,
        false,
        false,
        false,
        false,
        super::LiveBackgroundLeg::unmeasured(&mut None),
        super::ProgramLeg::off(&mut None),
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
async fn source_switch_holds_the_last_frame_and_never_proves_the_previous_device() {
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
    // Plan 210 S3: the frame on air holds while the next device is not
    // delivering, under contention too. It is no evidence for `screen:next`.
    assert_eq!(
        publish(&state, &mut sources, &mut cache)
            .await
            .fingerprint
            .screen,
        None
    );
    assert_eq!(latest_bytes(&state).await, green);
    drop(held);
    // The old device is still installed. Its perfectly valid frame must not
    // masquerade as the selected device after the registry becomes accessible;
    // it still draws, as the last picture on air.
    assert_eq!(
        publish(&state, &mut sources, &mut cache)
            .await
            .fingerprint
            .screen,
        None
    );
    assert_eq!(latest_bytes(&state).await, green);
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

    // Rapid A→B→A: a late B producer cannot prove the now-selected A scene;
    // its last frame holds on air until A delivers again.
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
    assert_eq!(latest_bytes(&state).await, blue);
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

/// Plan 210 S3: a window switch changes the running capture in place. The
/// store is the same; frames of the next window carry the next generation.
/// The compositor keeps the previous window's last frame until the scene
/// commit names the next window and a frame of its generation is there,
/// then cuts: never the next window under the previous layout, never black.
#[tokio::test]
async fn a_window_swap_holds_the_last_frame_until_the_commit_then_cuts() {
    let state = state();
    let mut scene = snapshot(SceneSourceKind::Window);
    scene.scene.as_mut().unwrap().sources[0].device_id = Some("window:alpha".into());
    state.compositor.lock().await.scene = Some(scene.clone());
    install_screen(&state, "window:alpha", 1, 11, [0, 255, 0, 255]).await;
    let mut sources = CompositorLiveSources::default();
    let mut cache = CompositorRenderCache::refresh_initial(&state).await;
    assert_eq!(
        publish(&state, &mut sources, &mut cache)
            .await
            .fingerprint
            .screen,
        Some(11)
    );
    let alpha = latest_bytes(&state).await;
    assert!(sources.screen_frame_is_current());

    // The stream changes target: generation 2 from here, same store.
    crate::preview_screen::test_swap_live_screen_generation(&state, "window:beta", 2).await;
    // Beta's first frame lands while the scene still names Alpha. The
    // periodic refresh may adopt the new identity before the commit does.
    crate::preview_screen::test_publish_screen_pixels(&state, 22, [255, 0, 0, 255], Instant::now())
        .await;
    let (refreshed, _, change) = std::mem::take(&mut sources).refresh_sources_nonblocking(&state);
    sources = refreshed;
    assert!(matches!(
        change,
        Some(CompositorScreenSourceChange::Adopted { generation: 2, .. })
    ));
    let result = publish(&state, &mut sources, &mut cache).await;
    assert_eq!(
        result.fingerprint.screen, None,
        "Beta is no evidence for Alpha's scene"
    );
    assert_eq!(
        latest_bytes(&state).await,
        alpha,
        "Alpha's last frame holds, never Beta, never black"
    );
    assert!(!sources.screen_frame_is_current());

    // The commit names Beta: the first publish after it cuts.
    scene.revision = 2;
    scene.scene.as_mut().unwrap().sources[0].device_id = Some("window:beta".into());
    state.compositor.lock().await.scene = Some(scene);
    let result = publish(&state, &mut sources, &mut cache).await;
    assert_eq!(result.fingerprint.screen, Some(22));
    let beta = latest_bytes(&state).await;
    assert_ne!(beta, alpha);
    assert!(sources.screen_frame_is_current());
    // And the cut holds: the next tick draws Beta again, as live.
    publish(&state, &mut sources, &mut cache).await;
    assert_eq!(latest_bytes(&state).await, beta);
}

/// Publish one tick of a dual-orientation session: the program at 64x36 and
/// the vertical leg (its own scene) at 36x64 into the stream frame store.
async fn publish_dual(
    state: &AppState,
    sources: &mut CompositorLiveSources,
    cache: &mut CompositorRenderCache,
    sequence: u64,
) -> CompositorPublishResult {
    publish_compositor_frame(
        state,
        "scene-switch-test",
        sequence,
        64,
        36,
        sources,
        cache,
        None,
        CompositorFrameConsumer::RawYuvEncoder,
        Some(CompositorAuxiliaryOutput {
            width: 36,
            height: 64,
            frame_consumer: CompositorFrameConsumer::RawYuvEncoder,
            composes_simulcast_scene: true,
        }),
        None,
        None,
        None,
        None,
        false,
        false,
        false,
        false,
        false,
        false,
        super::LiveBackgroundLeg::unmeasured(&mut None),
        super::ProgramLeg::off(&mut None),
    )
    .await
}

/// Plan 210 S3 follow-up: in a dual-orientation session the vertical leg
/// composes its own scene, and the renderer sends that scene after the
/// program commit. Each leg adopts the next window only when its OWN scene
/// names it; until then it keeps the frame it drew before the cut. Never the
/// next window under the vertical leg's previous layout, and the same rule
/// the other way round when the vertical commit lands first.
#[tokio::test]
async fn each_leg_cuts_to_the_next_window_only_when_its_own_scene_names_it() {
    let state = state();
    let mut program = snapshot(SceneSourceKind::Window);
    program.scene.as_mut().unwrap().sources[0].device_id = Some("window:alpha".into());
    let mut vertical = program.clone();
    let stream_store = Arc::new(StdMutex::new(FrameStore::new(2)));
    {
        let mut compositor = state.compositor.lock().await;
        compositor.scene = Some(program.clone());
        compositor.simulcast_scene = Some(vertical.clone());
        compositor.stream_frame_store = Some(stream_store.clone());
    }
    install_screen(&state, "window:alpha", 1, 11, [0, 255, 0, 255]).await;
    let mut sources = CompositorLiveSources::default();
    let mut cache = CompositorRenderCache::refresh_initial(&state).await;
    let vertical_bytes = || {
        stream_store
            .lock()
            .unwrap()
            .latest()
            .unwrap()
            .bytes
            .to_vec()
    };

    let result = publish_dual(&state, &mut sources, &mut cache, 1).await;
    assert_eq!(result.fingerprint.screen, Some(11));
    let alpha_program = latest_bytes(&state).await;
    let alpha_vertical = vertical_bytes();

    // Alpha -> Beta: the program commit lands first.
    crate::preview_screen::test_swap_live_screen_generation(&state, "window:beta", 2).await;
    crate::preview_screen::test_publish_screen_pixels(&state, 22, [255, 0, 0, 255], Instant::now())
        .await;
    let (refreshed, _, change) = std::mem::take(&mut sources).refresh_sources_nonblocking(&state);
    sources = refreshed;
    assert!(matches!(
        change,
        Some(CompositorScreenSourceChange::Adopted { generation: 2, .. })
    ));
    program.revision = 2;
    program.scene.as_mut().unwrap().sources[0].device_id = Some("window:beta".into());
    state.compositor.lock().await.scene = Some(program.clone());
    let result = publish_dual(&state, &mut sources, &mut cache, 2).await;
    assert_eq!(
        result.fingerprint.screen,
        Some(22),
        "the program cuts to Beta"
    );
    let beta_program = latest_bytes(&state).await;
    assert_ne!(beta_program, alpha_program);
    assert_eq!(
        vertical_bytes(),
        alpha_vertical,
        "the vertical leg still names Alpha: it keeps Alpha's last frame, never Beta under Alpha's layout"
    );
    // Another tick before the vertical commit: the hold is steady.
    publish_dual(&state, &mut sources, &mut cache, 3).await;
    assert_eq!(latest_bytes(&state).await, beta_program);
    assert_eq!(vertical_bytes(), alpha_vertical);

    // The vertical commit names Beta: that leg cuts now.
    vertical.revision = 2;
    vertical.scene.as_mut().unwrap().sources[0].device_id = Some("window:beta".into());
    state.compositor.lock().await.simulcast_scene = Some(vertical.clone());
    publish_dual(&state, &mut sources, &mut cache, 4).await;
    let beta_vertical = vertical_bytes();
    assert_ne!(beta_vertical, alpha_vertical);
    assert_eq!(latest_bytes(&state).await, beta_program);
    publish_dual(&state, &mut sources, &mut cache, 5).await;
    assert_eq!(vertical_bytes(), beta_vertical);

    // Beta -> Alpha: this time the vertical commit lands first. The program
    // holds Beta until its own scene names Alpha.
    crate::preview_screen::test_swap_live_screen_generation(&state, "window:alpha", 3).await;
    crate::preview_screen::test_publish_screen_pixels(&state, 33, [0, 255, 0, 255], Instant::now())
        .await;
    let (refreshed, _, change) = std::mem::take(&mut sources).refresh_sources_nonblocking(&state);
    sources = refreshed;
    assert!(matches!(
        change,
        Some(CompositorScreenSourceChange::Adopted { generation: 3, .. })
    ));
    vertical.revision = 3;
    vertical.scene.as_mut().unwrap().sources[0].device_id = Some("window:alpha".into());
    state.compositor.lock().await.simulcast_scene = Some(vertical);
    let result = publish_dual(&state, &mut sources, &mut cache, 6).await;
    assert_eq!(
        result.fingerprint.screen, None,
        "Alpha's frame is no evidence for the program, which still names Beta"
    );
    assert_eq!(
        vertical_bytes(),
        alpha_vertical,
        "the vertical leg cuts to Alpha"
    );
    assert_eq!(
        latest_bytes(&state).await,
        beta_program,
        "the program still names Beta: it keeps Beta's last frame, never Alpha under Beta's layout"
    );
    program.revision = 3;
    program.scene.as_mut().unwrap().sources[0].device_id = Some("window:alpha".into());
    state.compositor.lock().await.scene = Some(program);
    let result = publish_dual(&state, &mut sources, &mut cache, 7).await;
    assert_eq!(result.fingerprint.screen, Some(33));
    assert_eq!(latest_bytes(&state).await, alpha_program);
    assert_eq!(vertical_bytes(), alpha_vertical);
}

/// Plan 210 D5: the commit can land a tick or more before the compositor
/// adopts the next capture (the preview slot's lock is contended; the
/// stop-then-start path installs the new capture later still). For those
/// ticks the leg must not draw the previous window under the next layout:
/// it keeps the scene it drew, with its frame, and cuts layout and window
/// together. Red before the fix: Alpha's frame drawn inside Beta's shrunk
/// layout for one tick.
#[tokio::test]
async fn a_leg_cuts_layout_and_window_together_when_adoption_lags_the_commit() {
    let state = state();
    let mut scene = snapshot(SceneSourceKind::Window);
    scene.scene.as_mut().unwrap().sources[0].device_id = Some("window:alpha".into());
    state.compositor.lock().await.scene = Some(scene.clone());
    install_screen(&state, "window:alpha", 1, 11, [0, 255, 0, 255]).await;
    let mut sources = CompositorLiveSources::default();
    let mut cache = CompositorRenderCache::refresh_initial(&state).await;
    assert_eq!(
        publish(&state, &mut sources, &mut cache)
            .await
            .fingerprint
            .screen,
        Some(11)
    );
    let alpha_full = latest_bytes(&state).await;
    assert!(
        alpha_full[0] > 100,
        "Alpha fills the canvas: a bright corner"
    );

    // Beta's capture replaces Alpha's in place and delivers its first frame.
    crate::preview_screen::test_swap_live_screen_generation(&state, "window:beta", 2).await;
    crate::preview_screen::test_publish_screen_pixels(&state, 22, [255, 0, 0, 255], Instant::now())
        .await;
    // The commit names Beta in a shrunk freeform layout...
    let mut shrunk = scene.clone();
    shrunk.revision = 2;
    shrunk.layout.arrangement_mode = crate::protocol::ArrangementMode::Freeform;
    {
        let source = &mut shrunk.scene.as_mut().unwrap().sources[0];
        source.device_id = Some("window:beta".into());
        source.transform = SceneTransform {
            x: 0.25,
            y: 0.25,
            width: 0.5,
            height: 0.5,
            crop_left: 0.0,
            crop_top: 0.0,
            crop_right: 0.0,
            crop_bottom: 0.0,
        };
    }
    state.compositor.lock().await.scene = Some(shrunk.clone());
    // ...but the compositor cannot adopt the capture this tick: the preview
    // slot is busy (a swap installing, a metrics poll, a status read).
    let busy_slot = state.preview_screen.lock().await;
    let result = publish(&state, &mut sources, &mut cache).await;
    assert_eq!(
        result.fingerprint.screen, None,
        "no Beta frame proves anything yet"
    );
    assert_eq!(
        latest_bytes(&state).await,
        alpha_full,
        "Alpha's frame stays under Alpha's layout: never Alpha inside Beta's shrunk layout"
    );
    publish(&state, &mut sources, &mut cache).await;
    assert_eq!(latest_bytes(&state).await, alpha_full, "the hold is steady");
    drop(busy_slot);

    // The next tick adopts Beta: layout and window cut together.
    let result = publish(&state, &mut sources, &mut cache).await;
    assert_eq!(result.fingerprint.screen, Some(22));
    let beta_shrunk = latest_bytes(&state).await;
    assert_ne!(beta_shrunk, alpha_full);
    assert!(
        beta_shrunk[0] < 40,
        "Beta's shrunk layout leaves the corner dark"
    );
    publish(&state, &mut sources, &mut cache).await;
    assert_eq!(latest_bytes(&state).await, beta_shrunk, "and the cut holds");

    // A layout edit on the same, delivering capture cuts at once: no hold.
    let mut edited = shrunk.clone();
    edited.revision = 3;
    edited.scene.as_mut().unwrap().sources[0].transform.x = 0.0;
    state.compositor.lock().await.scene = Some(edited);
    publish(&state, &mut sources, &mut cache).await;
    assert_ne!(latest_bytes(&state).await, beta_shrunk);
}

/// Plan 210 D5: the hold is bounded. A scene naming a capture that never
/// delivers takes the layout after `LEG_SCENE_HOLD_MAX`, with the frame on
/// air, rather than pinning the previous layout for good.
#[test]
fn a_leg_scene_hold_is_bounded() {
    let drawn = snapshot(SceneSourceKind::Window);
    let mut next = drawn.clone();
    next.revision = 2;
    next.scene.as_mut().unwrap().sources[0].device_id = Some("window:gone".into());
    let t0 = Instant::now();
    let frame = crate::frame_store::FrameHandle::pin_for_test(crate::frame_store::StoredFrame {
        storage: crate::frame_store::FrameStorage::untracked(),
        sequence: 1,
        width: 1,
        height: 1,
        pixel_format: PreviewScreenPixelFormat::Bgra8,
        metadata: (),
        bytes: vec![0, 0, 0, 255],
        source_iosurface: None,
        source_pixel_buffer: None,
        source_d3d11_texture: None,
        recycle_pool: None,
        captured_at: t0,
    });
    let hold = LegScreenHold {
        frame: Some(frame),
        scene: Some(drawn.clone()),
        waiting_since: None,
    };
    let (scene, since) = leg_scene_for_tick(Some(next.clone()), &hold, false, None, t0);
    assert_eq!(
        scene.as_ref().map(|s| s.revision),
        Some(1),
        "holds the drawn scene"
    );
    assert_eq!(since, Some(t0));
    let waiting = LegScreenHold {
        waiting_since: since,
        ..hold.clone()
    };
    let (scene, since) = leg_scene_for_tick(
        Some(next.clone()),
        &waiting,
        false,
        None,
        t0 + LEG_SCENE_HOLD_MAX / 2,
    );
    assert_eq!(scene.as_ref().map(|s| s.revision), Some(1));
    assert_eq!(since, Some(t0), "the wait keeps its start");
    let (scene, since) = leg_scene_for_tick(
        Some(next.clone()),
        &waiting,
        false,
        None,
        t0 + LEG_SCENE_HOLD_MAX,
    );
    assert_eq!(
        scene.as_ref().map(|s| s.revision),
        Some(2),
        "the bound releases"
    );
    assert_eq!(since, None);
    // A current frame of the named capture cuts at once.
    let key = crate::source_registry::SourceKey {
        kind: crate::source_registry::SourceKind::Window,
        id: "window:gone".into(),
    };
    let (scene, since) = leg_scene_for_tick(Some(next), &hold, true, Some(&key), t0);
    assert_eq!(scene.as_ref().map(|s| s.revision), Some(2));
    assert_eq!(since, None);
}

/// Plan 210 S3: the stop-then-start fallback retires the old capture before
/// the new one exists. The frame on air holds through the gap instead of
/// going black, and the new capture's first frame cuts in at its commit.
#[tokio::test]
async fn a_capture_retired_mid_switch_keeps_the_last_frame_on_air() {
    let state = state();
    let mut scene = snapshot(SceneSourceKind::Window);
    scene.scene.as_mut().unwrap().sources[0].device_id = Some("window:alpha".into());
    state.compositor.lock().await.scene = Some(scene.clone());
    install_screen(&state, "window:alpha", 1, 11, [0, 255, 0, 255]).await;
    let mut sources = CompositorLiveSources::default();
    let mut cache = CompositorRenderCache::refresh_initial(&state).await;
    publish(&state, &mut sources, &mut cache).await;
    let alpha = latest_bytes(&state).await;

    crate::preview_screen::test_detach_live_screen(&state).await;
    let (refreshed, _, change) = std::mem::take(&mut sources).refresh_sources_nonblocking(&state);
    sources = refreshed;
    assert_eq!(change, Some(CompositorScreenSourceChange::Removed));
    let result = publish(&state, &mut sources, &mut cache).await;
    assert_eq!(result.fingerprint.screen, None);
    assert_eq!(
        latest_bytes(&state).await,
        alpha,
        "no capture, but the last frame holds"
    );

    install_screen(&state, "window:beta", 2, 22, [255, 0, 0, 255]).await;
    scene.revision = 2;
    scene.scene.as_mut().unwrap().sources[0].device_id = Some("window:beta".into());
    state.compositor.lock().await.scene = Some(scene);
    let result = publish(&state, &mut sources, &mut cache).await;
    assert_eq!(result.fingerprint.screen, Some(22));
    assert_ne!(latest_bytes(&state).await, alpha);
}

/// Plan 210 S3 under S7: a swap while the screen is hidden is a fresh
/// capture for the gate. The next window's first frame publishes frosted,
/// stamped with the new generation (so the switch completes), and its live
/// pixels are held for the show.
#[tokio::test]
async fn a_swap_while_hidden_cuts_to_a_frosted_still_never_the_live_window() {
    const WIDTH: u32 = 64;
    const HEIGHT: u32 = 36;
    let stripes = || {
        let mut bytes = vec![0_u8; (WIDTH * HEIGHT * 4) as usize];
        for (index, px) in bytes.chunks_exact_mut(4).enumerate() {
            let value = if (index % WIDTH as usize) / 2 % 2 == 0 {
                255
            } else {
                0
            };
            px[..3].fill(value);
            px[3] = 255;
        }
        bytes
    };
    let state = state();
    let mut scene = snapshot(SceneSourceKind::Window);
    scene.scene.as_mut().unwrap().sources[0].device_id = Some("window:alpha".into());
    state.compositor.lock().await.scene = Some(scene.clone());
    install_screen(&state, "window:alpha", 1, 11, [0, 255, 0, 255]).await;
    let mut sources = CompositorLiveSources::default();
    let mut cache = CompositorRenderCache::refresh_initial(&state).await;
    publish(&state, &mut sources, &mut cache).await;
    let alpha = latest_bytes(&state).await;

    state
        .screen_privacy
        .hide(crate::protocol::ScreenPrivacyReason::You, "t".into());
    assert!(crate::preview_screen::hold_screen_now(&state).await);
    crate::preview_screen::test_swap_live_screen_generation(&state, "window:beta", 2).await;
    assert!(
        crate::preview_screen::test_publish_screen_bgra(&state, 22, stripes(), Instant::now())
            .await
    );
    scene.revision = 2;
    scene.scene.as_mut().unwrap().sources[0].device_id = Some("window:beta".into());
    state.compositor.lock().await.scene = Some(scene);
    let result = publish(&state, &mut sources, &mut cache).await;
    assert_eq!(
        result.fingerprint.screen,
        Some(22),
        "the frosted still completes the switch"
    );
    let on_air = latest_bytes(&state).await;
    assert_ne!(on_air, alpha);
    // Luma along one row: the live stripes alternate every two pixels; the
    // frost is smooth.
    let row: Vec<u8> = (8..WIDTH - 8)
        .map(|x| on_air[(18 * WIDTH + x) as usize])
        .collect();
    let max_step = row
        .windows(2)
        .map(|pair| pair[0].abs_diff(pair[1]))
        .max()
        .unwrap_or(0);
    assert!(
        max_step < 40,
        "the next window's live stripes reached the program: max step {max_step}"
    );
    assert_eq!(
        crate::preview_screen::test_privacy_held_frames(&state).await,
        1
    );

    state.screen_privacy.show();
    assert!(crate::preview_screen::release_screen_now(&state).await);
    publish(&state, &mut sources, &mut cache).await;
    let shown = latest_bytes(&state).await;
    let row: Vec<u8> = (8..WIDTH - 8)
        .map(|x| shown[(18 * WIDTH + x) as usize])
        .collect();
    let max_step = row
        .windows(2)
        .map(|pair| pair[0].abs_diff(pair[1]))
        .max()
        .unwrap_or(0);
    assert!(
        max_step > 100,
        "the show publishes the held live frame: max step {max_step}"
    );
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
                None,
                None,
                None,
                false,
                false,
                false,
                false,
                false,
                false,
                super::LiveBackgroundLeg::unmeasured(&mut None),
                super::ProgramLeg::off(&mut None),
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

/// Plan 157. Also consumed by smoke:separate-source-fixture. A camera-in-screen
/// scene renders the primary leg plus both ISO legs through the CPU and Metal
/// publishers; every tick proves the Screen ISO carries no camera inset, the
/// Camera ISO is the camera alone, and the primary still has both. The smoke
/// encodes the dumped frames into a three-file take and gates it.
///
/// Plan 200 D2: the fixture camera is 4:3 (48x36) on the 16:9 canvas, so the
/// Camera ISO is the camera's own size, edge to edge, never pillarboxed.
#[tokio::test]
async fn source_iso_artifact_fixture() {
    use std::io::Write;
    const WIDTH: u32 = 64;
    const HEIGHT: u32 = 36;
    // Mirrored in scripts/smoke-separate-source-fixture.mjs (CAMERA_WIDTH/HEIGHT).
    const CAMERA_WIDTH: u32 = 48;
    const CAMERA_HEIGHT: u32 = 36;
    assert_eq!(
        crate::source_iso::camera_leg_size(Some((CAMERA_WIDTH, CAMERA_HEIGHT)), (WIDTH, HEIGHT)),
        (CAMERA_WIDTH, CAMERA_HEIGHT),
        "the fixture camera fits the canvas at its own size"
    );
    let directory =
        std::env::var_os("VIDEORC_SOURCE_ISO_ARTIFACT_DIR").map(std::path::PathBuf::from);
    for metal in [false, true] {
        if metal && !cfg!(target_os = "macos") {
            continue;
        }
        let mut gpus = if metal {
            (0..3)
                .map(|_| new_gpu_compositor(false))
                .collect::<Vec<_>>()
        } else {
            vec![None, None, None]
        };
        if metal && gpus.iter().any(Option::is_none) {
            assert!(
                directory.is_none(),
                "Metal is required for this artifact smoke"
            );
            eprintln!("SKIP: Metal fixture unavailable");
            continue;
        }
        let state = state();
        // Combined: the screen full-frame with the camera inset top-right.
        let mut combined = snapshot(SceneSourceKind::Screen);
        combined.layout.layout_preset = crate::protocol::LayoutPreset::ScreenCamera;
        let mut camera_source = snapshot(SceneSourceKind::Camera).scene.unwrap().sources[0].clone();
        camera_source.id = "source:camera".into();
        camera_source.device_id = Some("camera:fixture".into());
        camera_source.transform.x = 0.7;
        camera_source.transform.y = 0.0;
        camera_source.transform.width = 0.3;
        camera_source.transform.height = 0.3;
        camera_source.default_transform = camera_source.transform.clone();
        combined.scene.as_mut().unwrap().sources.push(camera_source);
        crate::preview_camera::test_install_live_camera_for_layout(
            &state,
            "camera:fixture",
            &combined.layout,
            &crate::protocol::VideoSettings {
                width: CAMERA_WIDTH,
                height: CAMERA_HEIGHT,
                ..video()
            },
        )
        .await;
        install_screen(&state, "screen:fixture", 1, 1, [0, 255, 0, 255]).await;
        let iso_stores = CompositorSourceIsoFrameStores {
            batches: Arc::new(crate::compositor::source_iso_batch::SourceIsoBatchStore::default()),
            screen: Arc::new(StdMutex::new(FrameStore::new(2))),
            camera: Arc::new(StdMutex::new(FrameStore::new(2))),
            camera_size: (CAMERA_WIDTH, CAMERA_HEIGHT),
        };
        {
            let mut compositor = state.compositor.lock().await;
            compositor.source_iso_frame_stores = Some(iso_stores.clone());
            compositor.scene = Some(combined.clone());
        }
        let mut sources = CompositorLiveSources::default();
        let mut cache = CompositorRenderCache::refresh_initial(&state).await;
        let mode = if metal { "metal" } else { "cpu" };
        let mut files = directory.as_ref().map(|dir| {
            std::fs::create_dir_all(dir).unwrap();
            [
                std::fs::File::create(dir.join(format!("{mode}-combined.yuv"))).unwrap(),
                std::fs::File::create(dir.join(format!("{mode}-screen.yuv"))).unwrap(),
                std::fs::File::create(dir.join(format!("{mode}-camera.yuv"))).unwrap(),
            ]
        });
        let luma_at = |bytes: &[u8], x: u32, y: u32| bytes[(y * WIDTH + x) as usize];
        let camera_luma_at = |bytes: &[u8], x: u32, y: u32| bytes[(y * CAMERA_WIDTH + x) as usize];
        let (inset_x, inset_y) = (55, 3);
        let (screen_x, screen_y) = (10, 30);
        let mut observed_source_luma = std::collections::HashSet::new();
        install_screen(&state, "screen:fixture", 1, 1, [0, 220, 0, 255]).await;
        for tick in 0..90_u64 {
            crate::preview_screen::test_publish_screen_pixels(
                &state,
                tick + 1,
                [0, 220 + (tick % 35) as u8, 0, 255],
                Instant::now(),
            )
            .await;
            crate::preview_camera::test_publish_camera_pixels(
                &state,
                tick + 1,
                [0, 0, 100 + (tick % 120) as u8, 255],
                Instant::now(),
            )
            .await;
            let [gpu, iso_screen_gpu, iso_camera_gpu] = gpus.as_mut_slice() else {
                unreachable!()
            };
            let result = publish_compositor_frame(
                &state,
                "source-iso-test",
                tick + 1,
                WIDTH,
                HEIGHT,
                &mut sources,
                &mut cache,
                gpu.as_mut(),
                CompositorFrameConsumer::RawYuvEncoder,
                None,
                None,
                Some(CompositorSourceIsoOutput {
                    width: WIDTH,
                    height: HEIGHT,
                    camera_width: CAMERA_WIDTH,
                    camera_height: CAMERA_HEIGHT,
                    frame_consumer: CompositorFrameConsumer::RawYuvEncoder,
                }),
                iso_screen_gpu.as_mut(),
                iso_camera_gpu.as_mut(),
                false,
                false,
                false,
                false,
                false,
                false,
                super::LiveBackgroundLeg::unmeasured(&mut None),
                super::ProgramLeg::off(&mut None),
            )
            .await;
            if metal {
                assert_eq!(result.compositor_backend, CompositorBackend::Metal);
            }
            let primary = latest_bytes(&state).await;
            let latest = |store: &CompositorFrameStore| {
                store.lock().unwrap().latest().unwrap().bytes.to_vec()
            };
            let screen_iso = latest(&iso_stores.screen);
            let camera_iso = latest(&iso_stores.camera);
            assert_eq!(primary.len(), raw_yuv420p_len(WIDTH, HEIGHT));
            assert_eq!(screen_iso.len(), raw_yuv420p_len(WIDTH, HEIGHT));
            // Plan 200 D2: the Camera ISO is the camera's own 4:3 size.
            assert_eq!(
                camera_iso.len(),
                raw_yuv420p_len(CAMERA_WIDTH, CAMERA_HEIGHT)
            );
            let screen_luma = luma_at(&primary, screen_x, screen_y);
            let camera_luma = luma_at(&primary, inset_x, inset_y);
            observed_source_luma.insert((screen_luma, camera_luma));
            assert!(
                screen_luma.abs_diff(camera_luma) > 40,
                "{mode} tick {tick}: the fixture colors must be distinguishable (screen {screen_luma}, camera {camera_luma})"
            );
            // Screen ISO: the screen everywhere, including where the inset sat.
            assert!(
                luma_at(&screen_iso, inset_x, inset_y).abs_diff(screen_luma) <= 2,
                "{mode} tick {tick}: the Screen ISO carried the camera inset"
            );
            assert!(
                luma_at(&screen_iso, screen_x, screen_y).abs_diff(screen_luma) <= 2,
                "{mode} tick {tick}: the Screen ISO lost the screen"
            );
            // Camera ISO: the camera alone, edge to edge at its own size: no
            // pillarbox or letterbox on any side (plan 200 D2).
            for (x, y) in [
                (0, 0),
                (CAMERA_WIDTH - 1, 0),
                (0, CAMERA_HEIGHT - 1),
                (CAMERA_WIDTH - 1, CAMERA_HEIGHT - 1),
                (CAMERA_WIDTH / 2, CAMERA_HEIGHT / 2),
            ] {
                assert!(
                    camera_luma_at(&camera_iso, x, y).abs_diff(camera_luma) <= 2,
                    "{mode} tick {tick}: the Camera ISO is not the camera edge to edge at {x},{y}"
                );
            }
            if let Some([combined_file, screen_file, camera_file]) = files.as_mut() {
                combined_file.write_all(&primary).unwrap();
                screen_file.write_all(&screen_iso).unwrap();
                camera_file.write_all(&camera_iso).unwrap();
            }
        }
        assert!(
            observed_source_luma
                .iter()
                .map(|(screen, _)| *screen)
                .collect::<std::collections::HashSet<_>>()
                .len()
                > 10,
            "{mode}: screen publisher must advance changing content"
        );
        assert!(
            observed_source_luma
                .iter()
                .map(|(_, camera)| *camera)
                .collect::<std::collections::HashSet<_>>()
                .len()
                > 10,
            "{mode}: camera publisher must advance changing content"
        );
        // Plan 200 D1: once the separate files are shed, their legs stop
        // rendering and the primary keeps publishing.
        assert!(iso_stores.batches.shed_separate_files());
        let [gpu, iso_screen_gpu, iso_camera_gpu] = gpus.as_mut_slice() else {
            unreachable!()
        };
        publish_compositor_frame(
            &state,
            "source-iso-test",
            91,
            WIDTH,
            HEIGHT,
            &mut sources,
            &mut cache,
            gpu.as_mut(),
            CompositorFrameConsumer::RawYuvEncoder,
            None,
            None,
            Some(CompositorSourceIsoOutput {
                width: WIDTH,
                height: HEIGHT,
                camera_width: CAMERA_WIDTH,
                camera_height: CAMERA_HEIGHT,
                frame_consumer: CompositorFrameConsumer::RawYuvEncoder,
            }),
            iso_screen_gpu.as_mut(),
            iso_camera_gpu.as_mut(),
            false,
            false,
            false,
            false,
            false,
            false,
            super::LiveBackgroundLeg::unmeasured(&mut None),
            super::ProgramLeg::off(&mut None),
        )
        .await;
        let latest_sequence =
            |store: &CompositorFrameStore| store.lock().unwrap().latest().unwrap().sequence;
        assert_eq!(
            latest_sequence(&compositor_frame_store(&state).await),
            91,
            "{mode}: the primary keeps publishing"
        );
        assert_eq!(
            latest_sequence(&iso_stores.screen),
            90,
            "{mode}: a shed Screen leg stops rendering"
        );
        assert_eq!(
            latest_sequence(&iso_stores.camera),
            90,
            "{mode}: a shed Camera leg stops rendering"
        );
    }
}

#[test]
fn source_edit_camera_none_round_trip_preserves_every_scene_field_on_both_legs() {
    use crate::live_source_switch::SourceKind;
    let mut primary = snapshot(SceneSourceKind::Camera);
    primary.selected_sources = Some(crate::protocol::SourceSelection {
        camera_id: Some("camera:A".into()),
        screen_id: None,
        window_id: None,
        microphone_id: None,
        test_pattern: false,
    });
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
            None,
            None,
            None,
            false,
            false,
            false,
            false,
            false,
            false,
            super::LiveBackgroundLeg::unmeasured(&mut None),
            super::ProgramLeg::off(&mut None),
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
            None,
            None,
            None,
            false,
            false,
            false,
            false,
            false,
            false,
            super::LiveBackgroundLeg::unmeasured(&mut None),
            super::ProgramLeg::off(&mut None),
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

/// Plan 210 S7: while the screen is hidden every leg carries the frosted
/// still and never a live frame: the program (which Clips and the native
/// preview read), the vertical aux leg (its own composition from the
/// simulcast snapshot) and the Screen ISO leg, on CPU and on Metal. The
/// camera inset is untouched.
#[tokio::test]
async fn hidden_screen_frost_reaches_every_leg() {
    const WIDTH: u32 = 64;
    const HEIGHT: u32 = 36;
    const AUX_WIDTH: u32 = 36;
    const AUX_HEIGHT: u32 = 64;
    const CAMERA_WIDTH: u32 = 48;
    const CAMERA_HEIGHT: u32 = 36;
    let stripes = || {
        let mut bytes = vec![0_u8; (WIDTH * HEIGHT * 4) as usize];
        for (index, px) in bytes.chunks_exact_mut(4).enumerate() {
            let value = if (index % WIDTH as usize) / 2 % 2 == 0 {
                255
            } else {
                0
            };
            px[..3].fill(value);
            px[3] = 255;
        }
        bytes
    };
    let white = || vec![0xff_u8; (WIDTH * HEIGHT * 4) as usize];
    for metal in [false, true] {
        if metal && !cfg!(target_os = "macos") {
            continue;
        }
        let mut gpus = if metal {
            (0..4)
                .map(|_| new_gpu_compositor(false))
                .collect::<Vec<_>>()
        } else {
            vec![None, None, None, None]
        };
        if metal && gpus.iter().any(Option::is_none) {
            eprintln!("SKIP: Metal fixture unavailable");
            continue;
        }
        let mode = if metal { "metal" } else { "cpu" };
        let state = state();
        // Program: the screen full-frame with the camera inset top-right.
        let mut combined = snapshot(SceneSourceKind::Screen);
        combined.layout.layout_preset = crate::protocol::LayoutPreset::ScreenCamera;
        let mut camera_source = snapshot(SceneSourceKind::Camera).scene.unwrap().sources[0].clone();
        camera_source.id = "source:camera".into();
        camera_source.device_id = Some("camera:fixture".into());
        camera_source.transform.x = 0.7;
        camera_source.transform.y = 0.0;
        camera_source.transform.width = 0.3;
        camera_source.transform.height = 0.3;
        camera_source.default_transform = camera_source.transform.clone();
        combined.scene.as_mut().unwrap().sources.push(camera_source);
        // The vertical leg: its own scene, the screen alone on a portrait canvas.
        let mut vertical = snapshot(SceneSourceKind::Screen);
        vertical.revision = 2;
        crate::preview_camera::test_install_live_camera_for_layout(
            &state,
            "camera:fixture",
            &combined.layout,
            &crate::protocol::VideoSettings {
                width: CAMERA_WIDTH,
                height: CAMERA_HEIGHT,
                ..video()
            },
        )
        .await;
        install_screen(&state, "screen:fixture", 1, 1, [0, 255, 0, 255]).await;
        let stream_store = Arc::new(StdMutex::new(FrameStore::new(2)));
        let iso_stores = CompositorSourceIsoFrameStores {
            batches: Arc::new(crate::compositor::source_iso_batch::SourceIsoBatchStore::default()),
            screen: Arc::new(StdMutex::new(FrameStore::new(2))),
            camera: Arc::new(StdMutex::new(FrameStore::new(2))),
            camera_size: (CAMERA_WIDTH, CAMERA_HEIGHT),
        };
        {
            let mut compositor = state.compositor.lock().await;
            compositor.stream_frame_store = Some(stream_store.clone());
            compositor.source_iso_frame_stores = Some(iso_stores.clone());
            compositor.scene = Some(combined.clone());
            compositor.simulcast_scene = Some(vertical.clone());
        }
        let mut sources = CompositorLiveSources::default();
        let mut cache = CompositorRenderCache::refresh_initial(&state).await;
        let stream_output = CompositorAuxiliaryOutput {
            width: AUX_WIDTH,
            height: AUX_HEIGHT,
            frame_consumer: CompositorFrameConsumer::RawYuvEncoder,
            composes_simulcast_scene: true,
        };
        let latest =
            |store: &CompositorFrameStore| store.lock().unwrap().latest().unwrap().bytes.to_vec();
        // Luma samples of the screen on each leg, away from the mirrored
        // borders: the program below and left of the inset, the aux leg's
        // middle row, the Screen ISO frame's interior columns.
        let program_screen = |bytes: &[u8]| -> Vec<u8> {
            (24..36)
                .flat_map(|y| (8..40).map(move |x| (y, x)))
                .map(|(y, x)| bytes[(y * WIDTH + x) as usize])
                .collect()
        };
        let aux_screen = |bytes: &[u8]| -> Vec<u8> {
            (6..AUX_WIDTH - 6)
                .map(|x| bytes[(32 * AUX_WIDTH + x) as usize])
                .collect()
        };
        let iso_screen = |bytes: &[u8]| -> Vec<u8> {
            (0..HEIGHT)
                .flat_map(|y| (8..WIDTH - 8).map(move |x| (y, x)))
                .map(|(y, x)| bytes[(y * WIDTH + x) as usize])
                .collect()
        };
        let mean = |samples: &[u8]| {
            samples.iter().map(|&v| f64::from(v)).sum::<f64>() / samples.len() as f64
        };
        let max_step = |samples: &[u8]| {
            samples
                .windows(2)
                .map(|pair| pair[0].abs_diff(pair[1]))
                .max()
                .unwrap_or(0)
        };
        // 1. Visible: the live stripes reach every leg.
        assert!(
            crate::preview_screen::test_publish_screen_bgra(&state, 2, stripes(), Instant::now())
                .await
        );
        crate::preview_camera::test_publish_camera_pixels(
            &state,
            2,
            [0, 0, 200, 255],
            Instant::now(),
        )
        .await;
        hide_screen_render(
            &state,
            1,
            &mut gpus,
            &mut sources,
            &mut cache,
            stream_output,
            metal,
        )
        .await;
        let program = latest(&compositor_frame_store(&state).await);
        let aux = latest(&stream_store);
        let iso = latest(&iso_stores.screen);
        assert_eq!(program.len(), raw_yuv420p_len(WIDTH, HEIGHT));
        assert_eq!(aux.len(), raw_yuv420p_len(AUX_WIDTH, AUX_HEIGHT));
        assert_eq!(iso.len(), raw_yuv420p_len(WIDTH, HEIGHT));
        assert!(
            max_step(&program_screen(&program)) > 150,
            "{mode}: live stripes on the program"
        );
        assert!(
            max_step(&aux_screen(&aux)) > 100,
            "{mode}: live stripes on the vertical leg"
        );
        assert!(
            max_step(&iso_screen(&iso)) > 150,
            "{mode}: live stripes on the Screen ISO"
        );
        let inset_live = program[(3 * WIDTH + 55) as usize];

        // 2. Hide: the still replaces the stripes on every leg, and the live
        //    frames published while hidden (pure white) never show.
        state
            .screen_privacy
            .hide(crate::protocol::ScreenPrivacyReason::You, "t".into());
        assert!(crate::preview_screen::hold_screen_now(&state).await);
        for tick in 2..6_u64 {
            assert!(
                crate::preview_screen::test_publish_screen_bgra(
                    &state,
                    tick + 1,
                    white(),
                    Instant::now()
                )
                .await
            );
            crate::preview_camera::test_publish_camera_pixels(
                &state,
                tick + 1,
                [0, 0, 200, 255],
                Instant::now(),
            )
            .await;
            hide_screen_render(
                &state,
                tick,
                &mut gpus,
                &mut sources,
                &mut cache,
                stream_output,
                metal,
            )
            .await;
            let program = latest(&compositor_frame_store(&state).await);
            let aux = latest(&stream_store);
            let iso = latest(&iso_stores.screen);
            for (leg, samples) in [
                ("program", program_screen(&program)),
                ("vertical leg", aux_screen(&aux)),
                ("Screen ISO", iso_screen(&iso)),
            ] {
                let mean = mean(&samples);
                assert!(
                    (70.0..=190.0).contains(&mean),
                    "{mode} tick {tick}: the {leg} does not carry the frost (mean luma {mean})"
                );
                assert!(
                    max_step(&samples) < 24,
                    "{mode} tick {tick}: live stripes on the {leg} while hidden"
                );
                assert!(
                    samples.iter().all(|&v| v < 200),
                    "{mode} tick {tick}: a live white frame reached the {leg} while hidden"
                );
            }
            let inset = program[(3 * WIDTH + 55) as usize];
            assert!(
                inset.abs_diff(inset_live) <= 2,
                "{mode} tick {tick}: the camera inset changed while hidden ({inset} vs {inset_live})"
            );
        }
        assert_eq!(
            crate::preview_screen::test_privacy_held_frames(&state).await,
            4
        );

        // 3. Show: the held live frame (white) is on every leg at once.
        state.screen_privacy.show();
        assert!(crate::preview_screen::release_screen_now(&state).await);
        hide_screen_render(
            &state,
            6,
            &mut gpus,
            &mut sources,
            &mut cache,
            stream_output,
            metal,
        )
        .await;
        let program = latest(&compositor_frame_store(&state).await);
        let aux = latest(&stream_store);
        let iso = latest(&iso_stores.screen);
        for (leg, samples) in [
            ("program", program_screen(&program)),
            ("vertical leg", aux_screen(&aux)),
            ("Screen ISO", iso_screen(&iso)),
        ] {
            assert!(
                samples.iter().all(|&v| v > 200),
                "{mode}: the {leg} did not return to the live picture after show"
            );
        }
    }
}

/// One program + vertical aux + Screen/Camera ISO tick for the Hide screen
/// fixture, at the fixture's canvas sizes.
async fn hide_screen_render(
    state: &AppState,
    tick: u64,
    gpus: &mut [Option<GpuCompositor>],
    sources: &mut CompositorLiveSources,
    cache: &mut CompositorRenderCache,
    stream_output: CompositorAuxiliaryOutput,
    metal: bool,
) -> CompositorPublishResult {
    let [gpu, stream_gpu, iso_screen_gpu, iso_camera_gpu] = gpus else {
        unreachable!()
    };
    let result = publish_compositor_frame(
        state,
        "hide-screen-test",
        tick,
        64,
        36,
        sources,
        cache,
        gpu.as_mut(),
        CompositorFrameConsumer::RawYuvEncoder,
        Some(stream_output),
        stream_gpu.as_mut(),
        Some(CompositorSourceIsoOutput {
            width: 64,
            height: 36,
            camera_width: 48,
            camera_height: 36,
            frame_consumer: CompositorFrameConsumer::RawYuvEncoder,
        }),
        iso_screen_gpu.as_mut(),
        iso_camera_gpu.as_mut(),
        false,
        false,
        false,
        false,
        false,
        false,
        super::LiveBackgroundLeg::unmeasured(&mut None),
        super::ProgramLeg::off(&mut None),
    )
    .await;
    if metal {
        assert_eq!(result.compositor_backend, CompositorBackend::Metal);
    }
    result
}
