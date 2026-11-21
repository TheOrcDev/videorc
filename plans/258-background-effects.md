# Plan 258: Background effects without a green screen

The owner, 2026-11-22: "Let's plan out background insert like we have for
green and blue screen but it needs to be without anything like we had in
Google Meet. In Google Meet we have mute background at different levels and
we have adding backgrounds behind you so people are not seeing what is
actually behind you. I want you to investigate thoroughly how other apps are
doing this and to come up with a plan for how we can do it in Videorc. This
one needs to be available for recording, for live streaming, for rooms, and
also for our guests. It also needs to have good placement inside of our app
(UI/UX)."

## Status and scope

- **Status: PLANNED 2026-11-22.** Research and plan only; no product code
  changed. Decisions D3–D11 DECIDED 2026-11-22: the owner said "start with
  the defaults", so every recommended default below stands.
- **Mockup:** [258-background-effects-mockup.html](258-background-effects-mockup.html)
  (the Studio control, the Scene page's home section, the two status lines,
  the guest green room and the call bar, in dark and light). Checked with
  `ghostex visual check` at 360, 600, 900 and 1280 px and 130 % text, both
  themes: nothing overflows.
- **What it is:** person segmentation on the camera, so the streamer and
  their guests can blur what is behind them (two strengths and a slider), put
  a picture or a looping video behind them, or cut themselves out over the
  scene, with no green screen. The green and blue screen key stays and
  becomes two choices of the same control.
- **Surfaces:** the host's camera in the recording, every stream leg, Clips,
  the Camera ISO file, Videorc Camera and the Preview; the host's camera in a
  talk-show room; and every guest on the guest page.
- **Out of scope:** face touch-up, auto light, auto framing and Center Stage
  (a later plan; the research below notes low-light companions); effects on a
  screen or window source; post-recording effects in the Library; Videorc
  Cloud runner changes (guests' and the host's tracks reach it already
  processed); the separate Rust UI app.
- **Base:** `origin/main` at `a6ae381fa` (2026-11-22). Web: `TheOrcDev/videorc-web`
  `origin/main` at `39ccdc87`.
- **Branch:** `plan/258-background-effects`; the plan PR merges once 0.36.1
  is cut (main was frozen for that release).

## Research: how others do it

### Video calls

| Product                | Blur                                                                                                                                                           | Pictures                                 | Video                                                                                                                                | Where the control lives                                                                                                                                                                                        | Failure, weak machines                                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Meet            | "Slightly blur" and "Blur", plus a one-click Blur on the self-view ([help](https://support.google.com/meet/answer/10058482?hl=en&co=GENIE.Platform%3DDesktop)) | Own images (30), curated, AI             | Three Google loops since 2021 ([update](https://workspaceupdates.googleblog.com/2021/06/replace-your-background-with-video-in.html)) | Pre-join preview and in-call effects panel; tiles under a live preview                                                                                                                                         | Needs WebGL; on ≤4-core machines it moves effects to Google's cloud ([update](https://workspaceupdates.googleblog.com/2022/08/improved-performance-for-google-meet-effects-web.html)), so frames leave the device unprocessed |
| Zoom                   | Blur                                                                                                                                                           | PNG/JPG ≤15 MB                           | MP4/MOV ≤1080p, "more system resources" ([KB](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060387))            | Settings → Video & effects, or the arrow next to Video                                                                                                                                                         | When a required background can't run, "their video will be turned off" ([KB](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0067433)); "I have a green screen" stays a toggle                              |
| Microsoft Teams        | Standard blur and Portrait blur                                                                                                                                | JPG/PNG/BMP, AI restyle                  | Not documented                                                                                                                       | "Effects and avatars" on the join screen; Preview → Apply in call; persists across meetings ([support](https://support.microsoft.com/en-us/teams/meetings/change-your-background-in-microsoft-teams-meetings)) | Option missing on unsupported devices; uses the NPU through Windows Studio Effects when present                                                                                                                               |
| macOS Video Effects    | Portrait with a strength slider                                                                                                                                | Colour, built-in or own image (macOS 15) | No                                                                                                                                   | The menu-bar Video menu, for every app ([Apple](https://support.apple.com/en-us/105117))                                                                                                                       | Apple silicon only; apps can't opt out ([forum](https://developer.apple.com/forums/thread/805786))                                                                                                                            |
| Windows Studio Effects | Standard (Gaussian) and Portrait (bokeh)                                                                                                                       | No                                       | No                                                                                                                                   | Quick Settings; applied in the camera driver for every app ([Learn](https://learn.microsoft.com/en-us/windows/apps/develop/windows-integration/studio-effects))                                                | Weak NPUs get Standard only; Microsoft asks apps to detect it and turn it off to avoid double blur                                                                                                                            |

### Streaming and recording tools

- **OBS, obs-backgroundremoval** ([repo](https://github.com/royshil/obs-backgroundremoval),
  [FAQ](https://github.com/royshil/obs-backgroundremoval/blob/main/FAQ.md)):
  a filter on the camera source with a choice of models (MediaPipe, SINet,
  PP-HumanSeg, RVM, TCMonoDepth), CPU or CoreML, threshold, feather, "mask
  every X frames", blur. "Optimized for single-person"; accuracy drops in low
  light; no published costs.
- **NVIDIA Broadcast / Maxine** ([FAQ](https://www.nvidia.com/en-us/geforce/broadcasting/broadcast-app/faq/),
  [AI Green Screen](https://docs.nvidia.com/maxine/vfx/1.0.0/Filters/AIGreenScreen.html)):
  blur, replace, remove; RTX only; Quality and Performance modes; stateful
  per stream; added temporal information so the background stops "popping in
  and out" ([news](https://www.nvidia.com/en-us/geforce/news/jan-2023-nvidia-broadcast-update)).
- **Streamlabs:** no own segmentation; it points to NVIDIA's filter
  ([post](https://streamlabs.com/content-hub/post/how-to-use-nvidia-background-remover)).
- **StreamYard** ([help](https://support.streamyard.com/hc/en-us/articles/4411078786836-How-to-Use-Virtual-Backgrounds)):
  guests pick blur or images in the browser; desktop only; admits it "can
  cause flickering or … turn completely black"; video only as the studio's
  background, not per camera ([blog](https://streamyard.com/blog/streaming-software-that-supports-virtual-backgrounds)).
- **Restream Studio** ([help](https://support.restream.io/en/articles/5947716-add-a-virtual-background-to-your-camera)):
  one Virtual background panel with Key colour Auto (no green screen) next to
  the physical green screen's Similarity, Smoothness and Spill.
- **Riverside** ([help](https://support.riverside.com/hc/en-us/articles/17848782645917-Add-a-background-blur-in-the-studio),
  [limits](https://support.riverside.com/hc/en-us/articles/16276048716701-I-cannot-use-visual-effects-or-add-a-background-to-my-video)):
  effects in the lobby preview, baked into the recording, each participant
  controls only their own; ≥8 cores; not in 4K studios; says "Visual effects
  unavailable" under strain.
- **Ecamm Live** ([help](https://support.ecamm.com/en/articles/3323565-camera-effects)):
  documents only a physical-screen key with image or video replacement.
- **Descript** ([help](https://help.descript.com/hc/en-us/articles/10327693275405-Green-Screen)):
  "Green Screen" is an AI effect after recording, in the cloud.
- **Camo** ([help](https://camo.com/support/camo/adjusting-video-settings)):
  Portrait (strength slider), Privacy blur, Replace with a Physical green
  screen toggle; effects capped at 1080p30.

### Libraries and models

- **Apple Vision `VNGeneratePersonSegmentationRequest`** (macOS 12+,
  [docs](https://developer.apple.com/documentation/vision/vngeneratepersonsegmentationrequest),
  [WWDC21 10040](https://developer.apple.com/videos/play/wwdc2021/10040/)):
  `.accurate` (photos), `.balanced` ("frame-by-frame video"), `.fast`
  ("streaming"); a soft matte as `OneComponent8/16Half/32Float` that goes
  straight into Metal; a stateful request reused across frames smooths it in
  time. Apple publishes no timings or mask sizes (third-party figures are
  unverified), so S0 measures them.
- **macOS system effects** ([WWDC21 10047](https://developer.apple.com/videos/play/wwdc2021/10047/),
  [isBackgroundReplacementActive](https://developer.apple.com/documentation/avfoundation/avcapturedevice/isbackgroundreplacementactive)):
  every app is opted in; `isPortraitEffectActive` (12+) and
  `isBackgroundReplacementActive` (15+) are observable; there is no opt-out.
- **MediaPipe Image Segmenter** ([guide](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter),
  [web](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter/web_js),
  [model card](https://huggingface.co/litert-community/MediaPipe-ImageSegmenter-Selfie-Landscape)):
  the selfie landscape model (144×256, ~250 KB, Apache-2.0) is the one Meet
  grew from; `@mediapipe/tasks-vision` runs it as WASM with a WebGL delegate;
  VIDEO mode keeps temporal state. Meet's pipeline: 8.3 ms inference,
  14.3 ms total on a 2018 MacBook Pro, joint bilateral mask refinement,
  light wrap, and a bokeh blur weighted to avoid halos
  ([Google Research](https://research.google/blog/background-features-in-google-meet-powered-by-web-ml/));
  the later HD model (not released) gave crisper hair and fingers
  ([HD post](https://research.google/blog/high-definition-segmentation-in-google-meet/)).
- **ONNX models:** Robust Video Matting is the best temporal matte but
  **GPL-3.0** ([repo](https://github.com/PeterL1n/RobustVideoMatting)): never
  in Videorc. MODNet ([Apache-2.0](https://github.com/ZHKKKe/MODNet)),
  PP-HumanSeg V2 ([Apache-2.0](https://github.com/PaddlePaddle/PaddleSeg/tree/release/2.9/contrib/PP-HumanSeg))
  and SINet (MIT, stale) are licence-safe but unbenchmarked for temporal
  stability. ONNX Runtime's DirectML provider is in sustained engineering
  with Windows ML as successor ([docs](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html),
  [Windows ML](https://learn.microsoft.com/en-us/windows/ai/new-windows-ml/overview)).
- **TensorFlow.js BodyPix** is deprecated in favour of body-segmentation,
  which wraps MediaPipe ([repo](https://github.com/tensorflow/tfjs-models/tree/master/body-pix)).
- **`@livekit/track-processors` 0.8.3** (Apache-2.0,
  [docs](https://github.com/livekit/track-processors-js/blob/main/processor-docs/video-processors.md)):
  blur radius or one image (no video), MediaPipe square selfie model on
  WebGL, loads WASM and model from a CDN unless `assetPaths` is set. **Two
  privacy holes for us:** it enqueues the raw frame before segmentation is
  ready and passes raw frames through in `disabled` mode; and if a
  processor's `init` throws, livekit-client keeps sending the raw track
  ([LocalTrack.ts](https://github.com/livekit/client-sdk-js/blob/main/src/room/track/LocalTrack.ts)).
  Soft-alpha blending and temporal smoothing are on `main`, not released.
- **NVIDIA Maxine** is RTX only, with redistribution terms we could not
  verify: not a dependency.

### Five takeaways

1. **Two named blur strengths plus a slider** is the norm (Meet's
   Slight/Blur, Teams' Standard/Portrait, Apple's and Camo's slider). Images
   are universal; video backgrounds are rarer and cost more (Zoom, Meet).
2. **Everyone keeps the physical green screen beside the AI path** and puts
   both in one control (Zoom's "I have a green screen", Restream, Camo).
3. **Process before frames leave the device** (OBS, LiveKit, Apple,
   Microsoft). Meet's cloud fallback and Descript are the exceptions, and
   they are exactly what a privacy promise can't do.
4. **Failure is where products differ:** Zoom turns video off, Riverside
   says "unavailable", StreamYard flickers or goes black, track-processors
   passes raw frames. For a privacy feature only the first is safe: fail
   closed.
5. **The OS may already be doing it** (macOS Video Effects, Windows Studio
   Effects): detect it, say so, and on Windows turn it off as Microsoft asks,
   or the streamer gets double blur and a toggle that lies.

## Where Videorc stands

- **No segmentation anywhere** in either repo (plan 257's parity matrix
  already lists it as missing on both platforms). The only ML is RNNoise for
  the microphone. No check of macOS or Windows system effects.
- **Green screen** is a per-scene layout field (`cameraChromaKeyEnabled`,
  colour, Similarity, Smoothness, Spill, Hide edges; `LayoutSettings` in
  `apps/desktop/src/shared/backend.ts`), saved with each scene, and copied to
  the vertical leg as a program source key (`PROGRAM_SOURCE_KEYS` in
  `lib/capture.ts`). Its picks: the Studio Camera row's segmented line (Off,
  Green screen, Blue screen; plan 248, `components/studio/quick-settings.tsx`)
  and the Scene page camera inspector's Green screen section with the tuning
  (`components/tabs/layout-tab.tsx`). ⌘K finds it by "remove background",
  "chroma" and the rest (`lib/green-screen.ts`).
- **One spec, many keyers.** `ChromaKeySpec` (`scene_geometry.rs`) feeds the
  CPU compositor, the Metal shader (plans 229/233: neighbourhood, reduction,
  speck cleanup, edge despill), the D3D11 HLSL, an FFmpeg `chromakey`
  approximation and the room's WebGL shader. The key runs **per leg, per
  draw**: each compositor instance keys its own snapshot.
- **The camera fans out raw.** Frames land in one depth-1 `FrameStore` on
  the `videorc-preview-camera` thread (`preview_camera.rs`; macOS keeps the
  `CVPixelBuffer` zero-copy, Windows and Linux read BGRA from an FFmpeg
  child). Nothing processes them once before every consumer reads them.
  Consumers that would carry the real room even with today's key on:
  - the **Camera ISO file**, raw by design (`source_iso_snapshot` turns the
    key off);
  - the **legacy FFmpeg graph**, which opens the camera itself
    (`capture_input.rs`) and keys only some layouts;
  - the **Electron fallback preview** off macOS and the debug
    `/preview/camera/*.png|bmp` routes.
- **The precedent is Hide screen** (plan 210, `screen_privacy.rs`): gate at
  the capture publish point so every leg gets the still, and refuse the
  legacy FFmpeg path (`SCREEN_HIDE_UNAVAILABLE_LEGACY`). Background effects
  copy that shape for the camera.
- **Rooms.** When a room opens the backend lends the camera and the renderer
  opens it with `getUserMedia` (`talk-show-room.ts` `#publishCamera`, plan
  224 D6). `TalkShowKeyProcessor` (`lib/talk-show-camera-effects.ts`) is a
  LiveKit `TrackProcessor` on WebGL2 that keys the host over the scene
  background before publishing, and **fails closed**: no raw fallback, the
  camera is muted with "Green screen failed: …". A dev-only native path
  (`#publishFrameCamera`, `room_camera_source.rs`) publishes the backend's
  processed camera instead. The renderer CSP is `script-src 'self'` with no
  `'wasm-unsafe-eval'`.
- **Guests** (web, plan 246): the green room makes one `LocalVideoTrack`
  (`use-guest-media.ts`) and the same track is published on join
  (`use-guest-connection.ts`), so a processor attached in the green room
  carries into the call. Round controls (mic, camera, Devices) sit on the
  preview (`guest-card.tsx`) and in the call bar (`guest-controls.tsx`).
  shadcn (radix-rhea) and Phosphor. No CSP on the guest page. Plan 246 put
  "background blur and effects" out of scope.
- **Backgrounds** are images (10 bundled WebP plus imports in
  `userData/background-assets/`) and live shaders; the room and the program
  page draw the scene background (`lib/room-background.ts`,
  `lib/cloud/program/stage-background.ts`). There are no video backgrounds
  yet.
- **Platforms.** Windows' camera is a dshow FFmpeg child into BGRA, composed
  by D3D11; Linux is v4l2 into the CPU compositor (plan 257 is taking Linux to
  Beta). Neither has a GPU inference runtime today.

## Decisions

Recommended defaults first. The owner said "start with the defaults"
(2026-11-22): D3–D11 are DECIDED as recommended.

- **D1 Engines.** macOS: Apple Vision person segmentation, stateful,
  `OneComponent16Half` into Metal (no model to ship, free on the Neural
  Engine/GPU). Windows and Linux: ONNX Runtime through the `ort` crate with
  the MediaPipe selfie landscape model (Apache-2.0), DirectML on Windows (CPU
  fallback), CPU on Linux. Browser (the room's host and guests): Videorc's
  own LiveKit processor on `@mediapipe/tasks-vision` with self-hosted WASM
  and model, **not** `@livekit/track-processors`, because of the raw-frame
  holes above. Never GPL (RVM) or Maxine.
- **D2 Where it runs for the local camera: once, at the camera publish
  point.** A camera effect stage sits between capture and `FrameStore`, so
  every consumer (all compositors and legs, Clips, the ISO file, Videorc
  Camera, the Preview, agent looks, debug samples) reads only processed
  frames. Raw frames never enter the store while an effect is on. Same rule
  as Hide screen; no compositor cover a leg can miss.
  - **Activation swaps the stored frame.** The store is depth-1, so turning
    an effect on (or arming one at camera start) first replaces the frame
    already in `FrameStore` with the cover, under the store's own lock and
    before the call returns. A reader between activation and the first
    processed capture gets the cover, never the raw frame captured before
    it. The setting only takes effect once that swap is done.
- **D3 One setting per camera, kept in every scene (DECIDED 2026-11-22: recommended default).** Like the
  camera look (`cameraLooks`, keyed by camera id): your background follows
  you across scenes and both stream legs. Alternative: per scene, as the key
  is today (a scene could blur and another not). Recommended: per camera,
  because the effect is about the room behind you, not the scene.
- **D4 Green screen joins the same choice (DECIDED 2026-11-22: recommended default).** Background is one
  pick: Off, Slight blur, Strong blur, an image, a video, Cut out, Green
  screen, Blue screen. Never two at once (`camera_background_treatment` picks
  exactly one). The key moves to the camera with D3; on first launch the
  camera's choice becomes Green or Blue screen with its tuning from the
  scene on stream if that scene keys it, else from the first scene that
  does. The per-scene fields stay readable for one release so a rollback
  loses nothing. Alternative: keep the key per scene and let a scene that
  keys override the camera's effect. Recommended: migrate, because a
  per-scene key beside a per-camera blur can show the room when switching to
  an old keyed scene without the screen up.
- **D5 What the choices are (DECIDED 2026-11-22: recommended default).** Off (default), Slight blur
  (30 %), Strong blur (70 %), Blur strength slider at the home, images
  (bundled set plus the Images library), videos (two bundled loops plus
  imported MP4/MOV, macOS first), Cut out (the scene shows behind you, the
  green screen without one), Green screen, Blue screen. Recommended: all,
  in that slice order; Cut out and video come after blur and images.
- **D6 Fail closed (DECIDED 2026-11-22: recommended default).** If the stage has no
  mask newer than 100 ms (3 frames at 30 fps), or has not produced its first
  mask since the effect, the camera or the session started, it outputs the
  **cover** instead of the camera: for blur, the whole frame at Strong blur
  plus 50 % more (you and the room, unrecognisable); for a picture or video,
  the picture alone; for Cut out, nothing (the scene shows). The cover is
  drawn by the same Metal or D3D11 pass, never by the CPU on the render
  thread. After 2 s of cover the Studio line says so (mockup §3). Turning the
  effect Off is the only way raw frames return.
- **D7 The Camera ISO file carries the effect (DECIDED 2026-11-22: recommended default).** With an effect
  on, the Camera file is the processed camera (blur or picture behind you;
  Cut out over the neutral `--video-ground`). Alternative: keep a clean
  camera file for editing. Recommended: processed, because the file goes
  into editors and shares; a later opt-in "Also keep an unprocessed camera
  file" could follow, off by default.
- **D8 Paths that can't keep the promise refuse (DECIDED 2026-11-22: recommended default).** With an effect on, a
  session that would take the legacy FFmpeg graph refuses with a named
  reason (as Hide screen does); the Electron fallback preview and the debug
  camera routes serve processed frames.
- **D9 The host in a room runs the browser processor for now (DECIDED 2026-11-22: recommended default).** While a room
  is open the renderer owns the camera, so the host's background runs in the
  same processor as guests', composed with today's key in
  `TalkShowCameraEffects` (one or the other). The renderer CSP gains
  `'wasm-unsafe-eval'` and the WASM and model ship in the app (no CDN). When
  the native frame camera path (`#publishFrameCamera`) graduates, the room
  switches to the native stage and the local and room looks become one.
- **D10 Guests choose their own (DECIDED 2026-11-22: recommended default).** Off, Slight blur, Strong
  blur, the host's scene background ("Show set", so a talk show looks like
  one set), the bundled images and Upload… (kept in the browser, never
  uploaded). No video for guests in v1. The host can't force a guest's
  effect; a later plan may let the host suggest Show set.
- **D11 Free, not Premium (DECIDED 2026-11-22: recommended default).** Meet, Zoom, Teams and StreamYard
  give it away, and a guest feature can't be locked to the host's plan.
  Recommended: free on every platform.
- **D12 System effects.** macOS: observe `isPortraitEffectActive` and
  `isBackgroundReplacementActive` on the camera in use and show the line in
  mockup §3; Videorc's effect still works on top (apps can't turn macOS's
  off). Windows: when Videorc's effect is on, set
  `KSPROPERTY_CAMERACONTROL_EXTENDED_BACKGROUNDSEGMENTATION` off at camera
  start, as Microsoft asks, and say so; leave it alone when ours is Off.
- **D13 Order.** macOS first (the owner streams there), the browser
  processor next (rooms and guests), then Windows, then Linux. Linux Beta
  (plan 257) does not wait for this.

## Architecture per surface

### The host's camera, macOS (recording, stream, Preview, Clips, ISO, Videorc Camera)

```
AVCaptureVideoDataOutput (BGRA, zero-copy CVPixelBuffer)
  └─ CameraEffectStage (new, preview_camera.rs publish point)
       ├─ segment queue: VNGeneratePersonSegmentationRequest (stateful, one per camera)
       │     input: a downscaled IOSurface (≈512 px long side), output: 16-bit half matte
       ├─ Metal pass (own command queue): matte refine (joint bilateral on the
       │     camera's luma) + temporal EMA, then blur (quarter-res separable,
       │     mask-weighted so the person never bleeds) / picture / video + light wrap
       │     → BGRA CVPixelBuffer from a pool (IOSurface, zero-copy kept)
       └─ cover when the matte is stale or absent (D6)
  └─ FrameStore (only processed frames while an effect is on)
       └─ every compositor, leg and reader, unchanged
```

- Segmentation runs on its own serial queue, never the capture queue or the
  render thread; the composite uses the newest finished matte (pipelined).
  Matte age is measured per frame and drives D6.
- Cut out publishes BGRA with alpha = the matte (premultiplied) and a flag on
  the frame; the CPU, Metal and D3D11 compositors honour camera alpha the way
  they honour the key today. The three must agree (the camera circle mask
  lesson): one shared spec in `scene_geometry.rs` and parity tests.
- Status gains `cameraBackground: { mode, state: 'running' | 'cover' |
'unavailable', maskAgeMs, segmentMsP95, composeMsP95, systemEffect }` for
  the Studio line, Health and the support bundle.

### The host's camera, Windows and Linux

Same stage at `publish_bgra_frame` (Windows dshow and Linux v4l2 read loops).
Windows: the BGRA frame is uploaded to D3D11 once; `ort` with DirectML runs
the 144×256 model; the composite is an HLSL pass; CPU fallback through `ort`
CPU. Linux: `ort` CPU, mask at up to 15 Hz with the EMA carrying the frames
between, composite on the CPU in SIMD off the render thread (the CPU
compositor already owns BGRA). Both bundle the ONNX model (~0.5 MB) and the
ORT runtime (size to be measured in S10).

### The host's camera in a room

`TalkShowCameraEffects` takes one processor: the existing key or the new
`BackgroundProcessor` (a LiveKit `TrackProcessor`, WebGL2 plus tasks-vision
VIDEO mode, GPU delegate). Fail-closed rules, tested: no frame is enqueued
before the first matte; a stale matte draws the D6 cover; an `init` failure
throws before `publishTrack`, so the camera is never published raw; a
context loss mutes the camera with a named line (as the key does today). The
Show stage's own tile shows the processed track.

### Guests

The same processor, mirrored into the web repo (`lib/background/` with a
parity test against the desktop copy, as `stage-background.ts` mirrors the
desktop shader). Attached to the green room's preview track before Ask to
join, so it carries into the call; `restartTrack` on a device switch keeps
it; rejoin rebuilds it before publishing. WASM and model are served from the
web app's own origin. The choice is remembered in the browser. The program
page never post-processes guests: by then the frames have left the guest's
machine.

### Privacy invariants (each one a test)

1. With an effect on, no raw camera frame enters `FrameStore` (stage unit
   test with a fake segmenter that stalls, errors and returns empty mattes).
2. The first frame after enabling, a camera switch, a session start, a room
   open and a relaunch is the cover or processed, never raw. That includes a
   read between activation and the next capture, which gets the swapped
   cover, not the frame stored before it.
3. A stalled or failed segmenter yields the cover within 100 ms and never
   raw; Off is the only path back to raw.
4. Legacy FFmpeg sessions refuse while an effect is on.
5. The browser processor enqueues nothing before its first matte and throws
   before publish on any init failure.
6. Green screen and an effect are never both applied
   (`camera_background_treatment` table test).

### Performance budgets (judged in a release build on a quiet host)

| Platform                     | Segmentation                                | Composite                                 | Added latency | Mask fresh                               | Notes                                                                                                |
| ---------------------------- | ------------------------------------------- | ----------------------------------------- | ------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| macOS, Apple silicon         | ≤ 6 ms p95 per matte, off the capture queue | ≤ 1.0 ms GPU at 1080p, ≤ 2.0 ms at 4K     | ≤ 1 frame     | every frame at 30 fps, every other at 60 | Quality level picked in S0 (`.balanced` if it fits, else `.fast`)                                    |
| macOS, Intel                 | `.fast`, ≤ 12 ms                            | ≤ 2 ms                                    | ≤ 1 frame     | ≥ 15 Hz                                  | Offered with the S0 numbers; Cut out off if over                                                     |
| Windows                      | ≤ 5 ms GPU (DirectML), ≤ 10 ms CPU fallback | ≤ 1.5 ms D3D11 at 1080p                   | ≤ 1 frame     | ≥ 15 Hz                                  | Issue #1088's awake-display rule applies to its smoke                                                |
| Linux (ogre)                 | ≤ 10 ms CPU per matte, `-j3` box limits     | ≤ 3 ms CPU at 1080p off the render thread | ≤ 2 frames    | ≥ 15 Hz                                  | Quiet-box timing only (plan 257)                                                                     |
| Browser (guest or room host) | ≤ 10 ms tasks-vision GPU at 720p            | in the same WebGL pass                    | ≤ 1 frame     | ≥ 15 Hz                                  | After 2 s behind: halve the matte rate; after 5 s more: stop the camera with a named line, never raw |

The compositor's own budgets (plan 233's key pass, PH-01/04) are unchanged:
the stage runs before the compositor, and the compositor draws one camera
texture as it does with no key. The camera captures at the output canvas
size, so 4K canvases pay the composite at 4K; segmentation always runs on the
downscaled copy.

## UX

### Placement (one home per control)

- **Home: the Scene page's camera inspector**, where Green screen lives
  today, renamed **Background** and kept right under the camera's name
  (mockup §2). Tiles (`MediaCard`'s look, since each choice has a picture),
  then the tuning for the pick folded open under them: Blur strength
  (Slight 30 % to Strong 70 % marks) and Edges (Soft, Balanced, Sharp) for a
  blur; Fit and Choose image… or Choose video… for a picture; Edges for Cut
  out; today's Similarity, Smoothness, Spill removal and Hide edges for a
  screen. Its description names every output it covers and "This camera
  keeps it in every scene."
- **Mirror: the Studio's Camera row** (mockup §1). Plan 248's segmented line
  becomes one select-style trigger, "Background · Strong blur" with a small
  picture of the effect. It opens a popover (popup tier, 320 px) with a live
  "What viewers see" picture (the processed camera, so it reads true even
  with the Preview closed) over the tiles in three groups: Blur (Off, Slight,
  Strong, Cut out), Images and videos (recent ones and Choose…), Screen behind
  you (Green screen, Blue screen); a lock line, "Done on this Mac, before
  anything is recorded or sent.", and Settings (opens the home). A pick applies
  at once; the stage confirms it, so no toast (the 2026-07-16 call). The
  Retro LCD Studio gets the same control in its look (plan 197: a Studio
  change lands in both looks).
- **Status lines** on the Camera row, never toasts (mockup §3): the cover
  ("Background is catching up. Viewers see your whole camera blurred until
  it's back.", amber icon), unavailable ("Background effects need macOS 12
  or later." / "… a graphics card that supports DirectX 12."), and a system
  effect ("macOS is blurring this camera (Video menu, Portrait). Turn it off
  there to use Videorc's background.").
- **⌘K:** "Blur background" / "Turn off background effect" by state,
  "Background settings", and the green-screen words already there
  (`GREEN_SCREEN_KEYWORDS` gains "blur", "virtual background", "background
  blur", "replace background").
- **The room's Show stage:** no new control. The host's own tile shows the
  processed camera, and the Studio's Background control still works (the
  room re-reads it, as it does the key today). Until S8 lands, the room
  can't apply an effect: see S5.
- **Guest page** (mockup §4, §5): a round Background button after Camera, in
  the green room's preview controls and in the call bar, with Phosphor's
  `UserFocus` glyph; pressed while an effect is on. Its popover: the choices
  in one row of tiles and "Done in your browser, before your video is sent."
  The preview is the processed track. If the browser
  can't run it (no WebGL2), the button is disabled with the reason in its
  tooltip ("Background effects need a browser with graphics acceleration
  on."); if it fails mid-call, the camera turns off with "Your background
  effect stopped, so your camera was turned off. Turn it on to try again."
- **No stronger promise than the processing.** The copy says where and when
  the effect runs (on this computer, before anything is recorded or sent),
  never that the room is invisible: a blur can still show large shapes and
  colours, and Meet and Teams say the same. The home and the guest popover
  say it once: "A blur can still show large shapes and colours behind you.
  For full privacy, pick a picture."
- **Both themes:** every control is a token or a shared primitive; the
  pictures inside tiles are on-stream pixels and don't follow the theme
  (like the Hide screen still).

### Copy (docs/ui-copy.md voice)

- Choices: Off, Slight blur, Strong blur, Cut out, Choose image…, Choose
  video…, Green screen, Blue screen. Section: Background. Slider: Blur
  strength. Field: Edges (Soft, Balanced, Sharp).
- Home description: "Blurs or replaces what's behind you in the recording, the
  livestream, Clips, Videorc Camera and the room. This camera keeps it in
  every scene."
- Hint: "Works best with light on your face. Done on this Mac, before
  anything is recorded or sent."
- Blur caveat (home and guest popover): "A blur can still show large shapes
  and colours behind you. For full privacy, pick a picture." Cut out hint: "Your scene shows behind you, like a green screen
  without one."
- Legacy refusal: "Background effects can't run with this recording
  setting. Turn off the background effect or choose 30 fps."

## Slices

Each slice is one PR to `TheOrcDev/videorc` `main` (S9 to
`TheOrcDev/videorc-web` `main`), leaves `main` green and follows `AGENTS.md`.
The privacy pieces come first: the leak detector exists before the stage, and
the stage exists before any control can turn it on. Routes and lanes follow
`CLAUDE.md`.

| #   | Slice                                                    | Route · lane · fit                 | Depends on |
| --- | -------------------------------------------------------- | ---------------------------------- | ---------- |
| S0  | Spike: Vision and tasks-vision measured on real hardware | Research · `fable-5.1` · 8         | —          |
| S1  | The setting, the one-choice rule and the migration       | Implementation · `gpt-6.1-sol` · 8 | D3, D4     |
| S2  | Fixture camera and leak detector, smoke skeleton         | Implementation · `fable-5.1` · 9   | —          |
| S3  | macOS camera effect stage: blur and images, fail closed  | Implementation · `fable-5.1` · 9   | S0, S1, S2 |
| S4  | System effects: macOS detection, Windows turn-off        | Implementation · `gpt-6.1-sol` · 8 | S1         |
| S5  | Studio, Scene page, ⌘K and Retro LCD controls            | UI/Product Design · `opus-5.5` · 9 | S3         |
| S6  | Video backgrounds and Edges (macOS)                      | Implementation · `fable-5.1` · 8   | S3         |
| S7  | Cut out: camera alpha through every compositor           | Implementation · `fable-5.1` · 9   | S3         |
| S8  | Browser processor and the host in a room                 | Implementation · `fable-5.1` · 9   | S0, S1     |
| S9  | Guest page Background control (web)                      | Implementation · `fable-5.1` · 9   | S8         |
| S10 | Windows stage: ORT DirectML and D3D11                    | Implementation · `fable-5.1` · 8   | S3         |
| S11 | Linux stage: ORT CPU                                     | Implementation · `fable-5.1` · 8   | S10        |
| S12 | Owner acceptance take                                    | Review · `fable-5.1` · 9 + owner   | S5, S6, S9 |

S0, S2 and S4 can run in parallel; S8 can start once S0 and S1 land, beside
S3.

### S0: Spike, measured on real hardware

**Goal:** numbers that pick the quality level and prove the budgets are
reachable before anything ships.
**Steps:** a scratch harness (kept out of the tree, or promoted to
`scripts/probe-person-segmentation.mjs` with a package script if it earns it)
that runs `VNGeneratePersonSegmentationRequest` at `.fast` and `.balanced`
on 720p, 1080p and 4K camera frames on the owner's M4 and on one Intel Mac if
available: matte size, wall time p50/p95, Neural Engine or GPU use, and a
60 s owner-recorded clip (hair, hands waving, a mug, standing up, low light)
with the mattes written out. Same clip through tasks-vision in Electron's
Chromium and in Chrome (GPU delegate). Evidence stays outside the repo
(owner footage), summary in `docs/acceptance/2026-11-xx-segmentation-spike.md`.
**Done when:** the acceptance note names the macOS quality level, the matte
input size and whether 4K holds the budget, with a recommendation for Intel.

### S1: The setting, the one-choice rule and the migration

**Goal:** a per-camera `CameraBackground` the whole app agrees on.
**Steps:** type `{ mode: 'off' | 'blur' | 'image' | 'video' | 'cutout' |
'green' | 'blue', blurPct, edges, assetId?, key? }` stored per camera beside
`cameraLooks`, injected at the output boundary like the look; mirrors in the
Rust protocol, `shared/backend.ts`, both contract schemas and normalization,
with a test that every field survives each mirror. Pure
`camera_background_treatment(setting, systemEffect, stage)` → `Raw |
Processed | Cover | Key` with its table test. The D4 migration with tests
for: no keyed scene, the scene on stream keyed, another scene keyed, both
colours.
**Verify:** `pnpm typecheck`, `pnpm lint`, `pnpm --filter @videorc/desktop
test`, `cargo test -p videorc-backend`, clippy.
**Done when:** the setting round-trips through RPC and storage, the
migration tests pass, and nothing renders differently yet.

### S2: Fixture camera and leak detector, smoke skeleton

**Goal:** a way to prove "the room never reaches an output" before the stage
exists.
**Steps:** a dev-only fixture camera (`VIDEORC_FIXTURE_CAMERA=<dir>`,
refused in packaged builds like `VIDEORC_YOUTUBE_API_BASE_URL`) that
publishes a looping sequence into `FrameStore` as a real camera would: a
licence-clean photo of a person (moving a little) over a "room" made of a
high-frequency magenta/cyan code pattern, tiny and committed under
`scripts/fixtures/camera-background/`. A detector in
`scripts/lib/camera-background-leak.mjs` (with Node tests) that finds the
pattern's energy outside the person band in any frame. `pnpm
smoke:camera-background` records, streams to a local FFmpeg RTMP sink, saves
a Clip, writes the ISO Camera file and samples the Preview, and with the
effect Off asserts the pattern IS found everywhere (the detector works).
**Done when:** the smoke runs green with Off and the detector's Node tests
pass.

### S3: macOS camera effect stage: blur and images, fail closed

**Goal:** D2 and D6 on macOS: Slight blur, Strong blur, the slider and image
backgrounds in every output.
**Steps:** the stage at the macOS publish point (`copy_sample_buffer`):
Vision on its own queue, the Metal refine/blur/picture pass into pooled
IOSurface buffers, the cover, matte-age diagnostics in status. ISO gets the
processed camera (D7). Legacy FFmpeg refuses (D8); fallback preview and debug
routes read the store. Privacy invariant tests 1–4 and 6 with a fake
segmenter. The smoke grows the effect-on passes: Strong blur and an image,
then a forced stall (`VIDEORC_DEBUG_SEGMENTATION_STALL=1`, dev only), a
camera switch, Record pressed with the effect already on, and a relaunch;
zero pattern frames in every artifact, cover within 100 ms of the stall.
**Verify:** the S1 gates plus `pnpm smoke:camera-background` against the
dev app or an unpackaged release build (it needs `VIDEORC_FIXTURE_CAMERA`,
which packaged builds refuse), `pnpm smoke:recording-studio`, `pnpm
smoke:record-latency:gate` and `pnpm smoke:preview-check-invisible`. Against
the packaged, signed app, separately: `pnpm smoke:virtual-camera` with a real
camera and an effect on, and a by-eye check that no frame of the room shows
in Videorc Camera at enable and camera switch. The S0 budget table is
re-measured in a release build.
Add the AGENTS.md rule paragraph for the new smoke (beside Hide screen).
**Done when:** every output passes the leak smoke with blur and image, the
stall shows the cover, and the budgets hold in a release build.

### S4: System effects

**Goal:** D12.
**Steps:** macOS KVO on `isPortraitEffectActive` and
`isBackgroundReplacementActive` for the camera in use, into
`cameraBackground.systemEffect`; Windows: read and, while Videorc's effect is
on, set the Studio Effects background-segmentation property off at camera
start, restoring it on stop. Unit tests on the decision; Windows CI compile.
**Done when:** the status field flips with the macOS Video menu on the owner's
Mac, and a Windows box with Studio Effects (if one exists) shows it turned
off, or the PR says no such box was available.

### S5: Studio, Scene page, ⌘K and Retro LCD controls

**Goal:** the UX section, as in the mockup.
**Steps:** read `.claude/skills/videorc-design/SKILL.md` and
`docs/ui-copy.md` first. Scene page Background section replaces Green screen
in place; the Studio Camera row's trigger and popover with the live "What
viewers see" picture (a small processed-camera feed from the store, never a
raw one); status lines; ⌘K entries and keywords; Retro LCD control; Images
library tiles reuse the background assets. Update the design skill's "Where
things live" with the Background home and mirror.
**Rooms before S8:** if S8 has not landed, the room can't apply an effect,
so it fails closed: while a room is open the effect tiles are disabled with
"Background effects come to rooms in a later update." (Off, Green screen and
Blue screen stay), and a room opened with an effect already on publishes no
camera, with that line on the Show stage. S8 removes both.
**Verify:** desktop unit tests, `pnpm typecheck`, `pnpm lint`, `pnpm
format:check`, `pnpm probe:ui-glass --gate --surfaces`, by-eye screenshots in
both themes and both looks, `pnpm smoke:camera-background`.
**Done when:** a streamer can pick every S3 choice from the Studio in two
clicks and tune it at the home, in light and dark, Retro LCD on and off; and
before S8 a room never publishes a camera the effect was meant to cover.

### S6: Video backgrounds and Edges

**Goal:** looping video behind the person and the Edges choice.
**Steps:** two bundled loops (licence-clean, small) and MP4/MOV import into
the Images library (thumbnail, size cap, ≤1080p like Zoom); an
AVAssetReader decode loop into IOSurfaces on its own thread, paced to the
camera clock; Edges maps to the refine radius and light wrap. Leak smoke gains
a video pass.
**Done when:** a video background plays smoothly in recording and stream with
the budgets held, and the leak smoke is green.

### S7: Cut out

**Goal:** the scene shows behind you, no green screen.
**Steps:** the stage publishes premultiplied alpha; CPU, Metal and D3D11
compositors honour camera alpha through one spec with parity tests (the
camera circle mask rule); the ISO file and the room flatten Cut out over the
neutral ground; the vertical leg agrees.
**Verify:** compositor parity tests, the edge-snow oracle style harness for
alpha flips at the outline, `pnpm smoke:recording-studio`, leak smoke with Cut
out.
**Done when:** Cut out reads the same on every path and leg and passes the
leak smoke.

### S8: Browser processor and the host in a room

**Goal:** D9 and the shared processor.
**Steps:** `lib/background-processor.ts` (tasks-vision VIDEO mode, GPU
delegate, WASM and model bundled, worker where the browser allows), with the
fail-closed rules and invariant 5 as tests; `TalkShowCameraEffects` takes
either processor; renderer CSP adds `'wasm-unsafe-eval'` (with a test of the
CSP string); the Show stage's own tile shows the processed track. `pnpm
smoke:cloud-talk-show` gains a host-blur step: the host on Chromium's fake
camera fed a Y4M of the S2 fixture, and the cloud recording and the program
pixel probes find no pattern.
**Done when:** the talk-show smoke is green with the host blurred and with
an image, and a forced processor failure mutes the camera instead of
publishing.

### S9: Guest page Background control (web)

**Goal:** guests blur or replace before anything is sent.
**Steps:** mirror the processor into the web repo with a parity test;
the round Background button and popover in the green room and the call bar
(shadcn, Phosphor, both themes); attach before Ask to join; keep across
`restartTrack` and rejoin; refuse to publish on init failure; Show set comes
from the room's background (`room-background.ts` already sends it); Upload…
stays in the browser; remember the choice. Extend the guest-call harness
(memory: web gate baselines and guest call harness) with a headless Chrome
guest on a Y4M fixture, asserting the host's room and the program page never
see the pattern. Coordinate the deploy with the desktop release (no protocol
change needed: the guest's track is just processed).
**Verify:** web typecheck, lint, tests, `next build`, the guest harness, by-eye
in Chrome, Safari and Firefox.
**Done when:** a guest's real background never appears on the host, the
program page or the cloud recording in the harness, in all three browsers or
with the button disabled and its reason where one can't run it.

### S10: Windows stage

**Goal:** D1 on Windows.
**Steps:** `ort` with DirectML and CPU fallback at the dshow publish point,
D3D11 composite, the bundled model, installer size measured; the leak smoke
on a Windows box (awake display, issue #1088). Windows async test rules from
AGENTS.md apply.
**Done when:** the leak smoke passes on a Windows box with blur and image,
and the budget table's Windows row holds.

### S11: Linux stage

**Goal:** D1 on Linux.
**Steps:** `ort` CPU at the v4l2 publish point; composite off the render
thread; the leak smoke and the matrix command on ogre (quiet box, `-j3`).
**Done when:** the leak smoke passes on ogre and the Linux row holds.

### S12: Owner acceptance take

**Goal:** the owner's eye on edges, hair, hands, motion and low light.
**Steps:** a packaged build; a 2-minute recording and a local-sink stream
with Slight blur, Strong blur, an image, a video and Cut out; a room with one
guest blurring in Chrome; evening light. Never live unless the owner asks
(AGENTS.md).
**Done when:** the owner signs off, or the fixes become plan 258b slices.

## Risks

- **Edge quality and flicker** are the whole product. S0 measures before
  building; the refine, the EMA and Edges are tuning knobs, not afterthoughts.
- **Two looks in a room** (Vision locally, MediaPipe in the room) until the
  native room camera graduates. Acceptable for v1; the room line says nothing
  about it.
- **4K canvases** composite at 4K. If S3 can't hold 2 ms at 4K, the
  composite runs at the camera box's drawn size instead (the box is rarely
  full canvas).
- **Bundle size** of ORT on Windows and Linux; measured in S10.
- **`'wasm-unsafe-eval'`** widens the renderer CSP a little; it allows
  compiling WASM, not `eval`. S8's test pins the exact string.
