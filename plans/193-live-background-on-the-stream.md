# Plan 193: The live background moves on the stream, not only in Studio and the recording

> **Executor instructions**: Follow this plan slice by slice. Run every "Done
> when" check before moving on. If anything in "STOP conditions" happens, stop
> and report; do not improvise. When done, update this plan's row in
> `plans/README.md` and fill in "As built". Owner rule: write and commit
> every slice, then run the gates once in S4.
>
> **Drift check (run first)**:
> `git diff --stat 67c12b8c..origin/main -- crates/videorc-backend/src/compositor.rs crates/videorc-backend/src/live_background/metal.rs crates/videorc-backend/src/metal_compositor.rs crates/videorc-backend/src/windows_d3d11_session.rs crates/videorc-backend/src/recording.rs scripts/smoke-live-background-app.mjs docs/live-backgrounds.md`
> If an anchor quoted below has moved, re-find it by the symbol name. If a
> _behaviour_ changed (not just a line number), that is a STOP condition.

## Status

- **Priority**: P1, a shipped bug. Live backgrounds (plan 190, #779) shipped
  in 0.9.149 (macOS) and 0.9.150 (all three). Owner report, 2026-10-24:
  "Live backgrounds are not actually live on the live stream. They're just
  static behind the Screen recording … That one should be live also on the
  live stream and on the recording, not only inside the Videorc Studio."
- **Effort**: S–M. Four slices. About 150 lines of Rust plus tests, one smoke
  extension and a docs fix. No wire change, no UI change.
- **Risk**: MEDIUM. It touches the stream leg of every macOS record-and-stream
  session. It is bounded in three ways:
  - With no live background, the stream leg's inputs are byte-identical to
    today: one more `Option` that is `None`.
  - The stream leg never renders a shader. It draws a texture the primary leg
    already rendered this tick, so it adds no shader cost.
  - Any doubt (no frame this tick, another Metal device) draws the poster,
    exactly as today.
- **Depends on**: nothing.
- **Category**: bug (stream graphics)
- **Planned at**: commit `67c12b8c` (origin/main, the 0.9.150 record),
  2026-10-24
- **Route**: Diagnose → Implementation, fit 9 (recording output, the
  compositor's legs). Model lanes:
  - `fable-5` for S1 and S3: the stream output is release-critical. During
    plan 190 the Fable lane was out until 10-28. If it still is, run on the
    strongest available lane, as plan 190 S4 did.
  - `gpt-5.5` for S2 and S4 (smoke wiring, docs, gates).

## What the owner saw, and why

### The evidence (2026-10-24 session `f0a20bbf`)

The owner was live while this was planned. Nothing was run against the live
app; only its log and the growing recording file were read.

- **Topology**: the backend log shows `overlay leg plan … primary=true
aux=true` and "Buddy on stream: building the auxiliary atlas for a
  1920×1080 canvas". The recording is the primary leg at 3840×2160@30. The
  stream is the **auxiliary** leg at 1920×1080.
- **The recording moves.** The file
  `~/Movies/Videorc/Recordings/videorc-session-20261024-161939-f0a20bbf-….mkv`
  shows Liquid Chrome around 3:50 and Line Waves around 40:00 in the ring
  around the screen. Mean luma change of the ring (top-left 360×180) between
  consecutive frames at 30 fps:
  - Liquid Chrome: 0.8–1.2 on every frame;
  - Line Waves: 11–13 on every frame;
  - the static screen inside the ring, as a control: 0.00–0.10.

  So Studio (which shows the primary leg) and the recording both animate.

- **The stream does not.** Its leg is composed by code that never receives
  the live background (below), so it draws the poster: a still frame of the
  same look. Nothing reports this; status reads `rendering: "shader"` from the
  primary leg.

### The root cause (code, origin/main `67c12b8c`)

Plan 190 wired the live background to the primary leg only:

- `publish_compositor_frame` builds the auxiliary leg's inputs with
  `live_background: None` (`compositor.rs:8867`).
- `publish_auxiliary_compositor_frame` (`compositor.rs:9137`) calls
  `try_gpu_compose` (`compositor.rs:7132`), which passes `&mut None` as the
  live renderer. So the background block in `try_gpu_compose_with_chrome`
  (`compositor.rs:7254-7300`) falls through to `background_image_source`:
  the poster.
- `CompositorRenderCache.live_background` is documented as "the live
  background the primary leg draws this tick" (`compositor.rs:1109`).

Every macOS session that records **and** streams has an auxiliary leg, even
at one profile: "A proven same-profile stream still owns an auxiliary
compositor/encoder lane" (`recording.rs:22198-22210`). So on macOS:

| Session                                                         | Recording                               | Stream                                                               |
| --------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------- |
| Record only                                                     | moves                                   | n/a                                                                  |
| Stream only (horizontal)                                        | n/a                                     | moves                                                                |
| Stream with a vertical simulcast leg                            | n/a                                     | moves (horizontal); the vertical leg has no background (plan 190 D9) |
| **Record and stream** (same or split profile)                   | moves                                   | **the poster**                                                       |
| 4K60 recording, or a stream above 1080p60 (legacy FFmpeg graph) | the poster, with a notice (plan 190 D7) | the poster, with a notice                                            |

Why the gates missed it: `smoke:live-background` only records
(`scripts/smoke-live-background-app.mjs:325-327`, `streamEnabled: false`),
and no unit test composes an auxiliary leg with a live background.

### Other platforms (read, not run)

- **Windows**: the D3D11 media session composes one scene leg into
  `WindowsD3d11SceneOutputTargets::ALL` when there is one leg
  (`windows_d3d11_session.rs:3055-3064`), and the live layer is part of that
  leg's sources (`:2586-2600`). So a record-and-stream session should draw the
  live layer on the stream target too. Unproven: Windows has never run a live
  background. S3 pins it with a test.
- **Linux**: the raw path has no auxiliary encoder
  (`recording.rs:22141-22152`), so the stream and the recording share one
  composed frame and both move.

## Goal

A streamer on macOS records and streams with Silk on. The stream shows the
same moving satin as Studio and the recording, at the same phase, with no
extra shader cost. A streamer with no live background gets a byte-identical
stream leg.

## Owner decisions

**Answered 2026-10-24**: "Yes, go with both recommendations, execute the
entire plan, and create a PR". D1 and D2 are as recommended below.

| #   | Question                                                                                                                                | Recommendation                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | How does the stream leg get its live frame?                                                                                             | **Answered: reuse the primary leg's frame from the same tick.** The stream draws the texture the recording already rendered. Zero extra shader time, the two outputs can never disagree (same phase, same guard level, same still), and one guard judges one cost. The alternative, a second renderer for the stream leg, doubles the GPU cost and lets each leg fall to the poster on its own. |
| D2  | 4K60 recordings and streams above 1080p60 still show the poster (plan 190 D7: the legacy FFmpeg graph, with a start notice). Keep that? | **Answered: keep it for now.** Making that graph move needs a raw-video pipe from a GPU renderer into FFmpeg: a separate plan if the owner wants it. The owner's own setup (4K30 recording, 1080p30 stream) is inside the bridge and is fixed by this plan.                                                                                                                                     |

## Design (D1)

### One frame, two legs

- `LiveBackgroundMetalRenderer` (`live_background/metal.rs`) remembers the
  frame it drew this tick: `last_frame: Option<(Instant, LiveFrame)>`, stamped
  with `input.tick.at`.
  - Set in `render` when `draw` succeeds.
  - Cleared at the top of every `render` call, and in `release` and
    `drop_targets`, so a still, a forced still, a shader failure or a refused
    texture leaves nothing to reuse.
  - `pub fn frame_at(&self, at: Instant) -> Option<LiveFrame>` returns a
    retained clone only when the stamp equals `at`.
- `CompositorRenderInputs` gains `shared_live_frame: Option<&'a SharedLiveFrame>`.
  `SharedLiveFrame` is a cfg alias, the same pattern as
  `LiveBackgroundGpuRenderer` (`compositor.rs:6363-6370`): the Metal
  `LiveFrame` on macOS, an uninhabited enum elsewhere. Every existing
  constructor passes `None`.
- `try_gpu_compose_with_chrome`'s background block becomes "render this leg's
  live frame, **or** draw the shared one, **or** the poster". The shared frame
  goes through the same placement as the rendered one: full canvas, Fill,
  `GpuSourceSampler::Linear`.
- In `publish_compositor_frame`, the auxiliary leg's inputs get
  `shared_live_frame` from `live.renderer.as_ref()?.frame_at(published_at)`,
  only when `!stream_output.composes_simulcast_scene`. The vertical simulcast
  leg keeps no background (plan 190 D9). The ISO legs keep none (plan 157).
- The ordering is already safe; S1 adds a comment that says why. The live
  command buffer is committed on the primary queue before the primary compose,
  and `compose_target_with_timings` returns only after `waitUntilCompleted`
  (`metal_compositor.rs:1476-1486`). So the frame is finished before the
  auxiliary compose starts. The auxiliary compose is waited too, before the
  next tick's `draw` overwrites the texture (`metal.rs:850-853`). Both legs
  run in turn on the one loop thread.

### The device check

Both `GpuCompositor`s come from `MTLCreateSystemDefaultDevice()`
(`metal_compositor.rs:1202`), which returns the one default device. A texture
is only valid on the device that made it, so before drawing a shared frame
the auxiliary compose compares `frame.texture.device()` with `gpu.device()`.
On a mismatch it draws the poster and logs one warning per run:
"live background: the stream leg runs on another Metal device; it shows the
poster". Never silent.

### Sizes

The primary leg renders at `internal_size(id, primary output, level)`. The
soft four render at most 1080 on the short side, so a 1080p stream draws them
1:1 and a 4K recording draws them up, as today. Line Waves renders at the
primary's full size: from a 4K recording, the stream leg draws it at half
size. A plain 2× linear minify keeps its lines.

**If the stream leg is larger than the recording** (a companion stream
profile above the recording profile), Line Waves would draw up and go soft.
Then the primary renders at the larger leg's size:
`live_output = larger-area of (primary, auxiliary when it composes the same scene)`.
That is one `max` in `render_live_background`'s call. The guard then times
that larger render, which is what the tick really costs.

### What does not change

- No wire, status or contract change. Status keeps reporting the primary
  renderer, which now describes both legs. This avoids the strict-contract
  trap (a new status field must be added to `backend-rpc-contract.ts`).
- The guard, the clock, the looks, the previews and the UI.
- With no live background: `frame_at` is never called (`live.renderer` is
  `None`), `shared_live_frame` is `None`, and the auxiliary leg takes today's
  path.

## Slices

### S1: macOS, the stream leg draws this tick's live frame (`fable-5`)

Work in a worktree off `origin/main`.

- `live_background/metal.rs`: `last_frame`, `frame_at`, and the clears above.
- `compositor.rs`:
  - the `SharedLiveFrame` alias and the `shared_live_frame` field (every
    existing constructor passes `None`, tests included);
  - the background block: rendered, else shared (after the device check),
    else poster;
  - the auxiliary leg's inputs in `publish_compositor_frame`;
  - the larger-leg `live_output` rule;
  - correct the `CompositorRenderCache.live_background` doc comment.
- Tests (macOS, in the existing live background test module in
  `compositor.rs`):
  1. **The stream ring moves.** Drive `publish_compositor_frame` with a
     same-scene `CompositorAuxiliaryOutput` (the shape at
     `compositor.rs:14856`), a synthetic screen and Silk. Over two ticks 1 s
     apart (an injected tick instant), the auxiliary frame's ring differs and
     its stage is identical.
  2. **Same phase.** At one tick, the auxiliary ring, scaled to the primary's
     size, matches the primary's ring within the golden bounds (mean ≤ 2/255).
  3. **Split profile.** A 3840×2160 primary and a 1920×1080 auxiliary: the
     auxiliary ring moves. Line Waves included.
  4. **Still mirrors.** Forced still (`set_forced_still_for_test`): both
     legs draw the poster, and `frame_at` returns `None`.
  5. **Off is unchanged.** No live background: the auxiliary leg's
     `immutable_texture_uploads` and output bytes equal the pre-change
     path's (the poster or no background).
  6. **Vertical keeps none.** A `composes_simulcast_scene` auxiliary gets no
     shared frame.
  7. **No stale frame.** A tick whose `render` returned `None` (guard at
     Still) leaves `frame_at(that tick)` `None`, even though the texture
     still holds the last frame.

**Done when**: the seven tests pass. `cargo test -p videorc-backend
live_background` and `cargo test -p videorc-backend compositor::` pass
(targeted; the owner's directive is no full suite locally), and
`cargo clippy -p videorc-backend -- -D warnings` and `cargo fmt --check
--all` are clean.

### S2: the smoke covers record and stream (`gpt-5.5`)

Extend `scripts/smoke-live-background-app.mjs`:

- Add a **record-and-stream** case for each existing shader case. It reuses
  the local RTMP listener from `scripts/smoke-comment-highlight-stream-app.mjs`
  (`:214-243`, `ffmpeg -listen 1` into `stream-received.flv`):
  - Silk at 1080p30, record and stream at one profile (the same-profile
    auxiliary lane);
  - Liquid Chrome at 4K30 recording with a 1080p30 stream (the owner's
    setup, the split auxiliary);
  - Line Waves at 4K30 recording with a 1080p30 stream (the minified lines).
- Sample **both artifacts** with the existing ring checks (moves, never
  frozen above 0.5 s, stage is not background). Add one cross-check: the two
  rings' mean frame-to-frame change agree within a factor of 2, so a poster
  on either leg fails.
- Forced-still mode: both artifacts' rings are static.
- Keep the record-only cases as they are.

**Done when**: `node --check` passes, the analyzer unit tests pass
(`pnpm test:scripts`), and the new cases run in S4.

### S3: Windows, pin the stream target (`fable-5`, CI only)

Nothing can run on Windows locally. Read before writing:
`windows_d3d11_session.rs:2586-2600, 2955-2962, 3055-3085` and the WARP
golden test from plan 190 S4 (#781, #784).

- Add a WARP test: a same-scene record-and-stream plan (one leg, targets
  `ALL`) with Silk, two ticks 1 s apart. The `AUXILIARY` target's ring must
  differ between the ticks, and its stage must not.
- If it fails, this is the same bug on Windows. Fix it the same way: the
  auxiliary target draws the primary's live layer. Report it in "As built".
- Leave the vertical simulcast leg as it is (its poster is documented).

**Done when**: the test is written and runs in the PR's Windows CI job. Read
its log; do not assume it passed.

### S4: docs, gates and hand-off (`gpt-5.5`)

- `docs/live-backgrounds.md`: the table claims "macOS preview, recording,
  stream (Metal): Yes", which was false for record-and-stream. Add one line
  saying the stream leg draws the recording's frame from the same tick.
- `plans/README.md`: this plan's row. Also correct plan 190's row: it still
  says "DRAFT PR #779", but it merged as `2b6114e0` and shipped in 0.9.149
  (macOS) and 0.9.150.
- Gates, in this order, **on a quiet host and never while the owner is
  live** (the smoke is GPU-load-sensitive, and a running stream shares the
  GPU):
  1. `cargo fmt --check --all`, `cargo clippy -p videorc-backend -- -D warnings`,
     the targeted `cargo test` from S1, and
     `cargo build --release -p videorc-backend` (cfg edits).
  2. `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:scripts`.
  3. `pnpm smoke:live-background` (all cases, then once with
     `VIDEORC_LIVE_BACKGROUND_FORCE_STILL=1`).
  4. `pnpm smoke:multistream` and `pnpm smoke:comment-highlight-stream`:
     the auxiliary leg's other layers are unchanged.
  5. `pnpm smoke:banners` (banners on both legs, plan 186).
  6. `pnpm smoke:live-background-off-ab --base <an origin/main worktree>`:
     zero cost when off still holds.
  7. `pnpm smoke:recording-studio` (AGENTS.md: layout composition and
     recording output).
- Open a draft PR. The owner by-eye: go live to an unlisted YouTube stream
  with Silk on while recording. Watch the stream on another device and
  compare it with Studio. Check both themes in Assets (unchanged, but the
  standing rule).

**Done when**: every gate above passes or has a named, stated reason. Then
the PR is ready for the owner, and is a candidate for a 0.9.151 hotfix.

## STOP conditions

- The auxiliary compose turns out to be asynchronous (it doesn't wait), or the
  two legs run on different threads. Then the shared texture needs a fence or
  a second frame. Stop and re-plan.
- `MTLCreateSystemDefaultDevice` returns different devices for the two
  compositors on the owner's Mac. The device check would make the stream
  leg show the poster every time. Stop and report.
- The smoke shows the record-only cases slower or falling to the poster more
  often than on `origin/main` on a quiet host.
- The Windows test shows the stream target without the live layer, and the
  fix needs more than the primary's layer on the auxiliary target.

## As built

(Filled in by the executor.)
