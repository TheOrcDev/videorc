# Live Layout & Source Changes — LS0 Audit and Boundaries

Audit for the Live Layout/Source Changes plan
(`2026-06-02 - Videorc Live Layout And Source Changes Plan`). Establishes the
hot/warm/cold action matrix and the hard boundary: **no scene mutation reaches the
running output today.**

## Core finding: the active output is a frozen snapshot

`recording.rs::start_session` resolves sources once (`resolve_capture_inputs`) and
builds the FFmpeg argument vector once (`ffmpeg_args` → `recording_video_filter`),
then spawns the process. The `-filter_complex` graph — overlay position, camera
framing, side-by-side regions — is computed into literal strings at spawn time and
**never updated**. The running FFmpeg accepts only `q` (quit) on stdin; there is no
dynamic filter/source control.

Every `scene.*` command (`scene.source.transform.update`,
`scene.source.visibility.update`, `scene.sources.reorder`, `scene.source.nudge`,
`scene.source.transform.reset`, `scene.load_from_capture_config`) mutates the
**in-memory preview `Scene`** and emits `scene.changed` for the UI/preview. None of
them touch the recording/stream process. So today's "scene edits" are **preview/UI
only** while a session is live.

**Compatibility rule (from the plan):** no control may claim to change the live
recording/stream until the live render consumer (LS2+) actually consumes a committed
scene revision. Until then, live-only controls stay disabled or labelled
`Applies next session`.

## Action matrix

`Target` is the eventual classification once the live render path exists; `Today` is
the honest current behaviour on the FFmpeg-snapshot path.

| Control (active session) | Mutation kind | Target | Today |
| --- | --- | --- | --- |
| Camera drag / move / resize / crop | `source.transform.patch` | Hot | Disabled (`isSessionActive`) |
| Nudge / reset transform | `source.transform.patch` | Hot | Disabled |
| Source visibility (hide/show) | `source.visibility.set` | Hot | Clickable, preview-only |
| Source reorder (bring fwd/back) | `source.order.set` | Hot | Clickable, preview-only |
| Camera corner/size/shape/fit/mirror/zoom/pan/margin | `layout.patch` | Hot | Clickable, preview-only |
| Side-by-side split / camera side | `layout.patch` | Hot | Disabled (preset gating) |
| Layout preset (4 presets), sources already live | `layout.set_preset` | Hot | Disabled |
| Layout preset needing a not-yet-started source | `layout.set_preset` | Warm | Disabled |
| Screen / window switch | `source.device.switch` | Warm | Disabled |
| Camera switch | `source.device.switch` | Warm | Disabled |
| Microphone switch | `source.device.switch` | Warm | Disabled |
| Mic mute / gain | `audio.mic.patch` | Hot | Clickable; reaches the CoreAudio FIFO path only |
| Bitrate | `output.bitrate.patch` | Hot | Disabled |
| Output resolution | `output.resolution.patch` | **Cold** (LS7) | Disabled |
| Output FPS | `output.fps.patch` | **Cold** (LS7) | Disabled |
| Codec / major encoder settings | — | Cold | Disabled |
| Enable/disable recording after start | — | Cold | Clickable; next-session |
| Add/remove stream destination | — | Cold | Locked while live |
| Horizontal ↔ vertical canvas | — | Cold | n/a |

### Resolution / FPS classification decision

The plan lists output resolution/FPS under *Hot* ("should change live"), but they
require a full encoder + render-pipeline reconfiguration that does not exist yet and
is explicitly isolated into the advanced **LS7** phase. To honour the
"never pretend live" rule, LS1 classifies `output.resolution.patch` and
`output.fps.patch` as **Cold** (next-session) for now; LS7 can promote them to
warm/hot once dynamic reconfiguration lands. **Bitrate** is genuinely hot and stays
hot.

### Honesty gaps to close in the live-edit UI (LS6)

A few controls are clickable during a session and silently edit *next-session*
config (camera framing toggles, visibility, reorder, record toggle) while a
"Layout editing is paused" message shows. These are not false *live* claims, but LS6
should give them explicit `Applies live` / `Reconnects source` / `Next session`
badges so intent is unambiguous. No false "updates the live output" claim exists
today.

## What LS1 adds

`crates/videorc-backend/src/live_scene.rs` — the active-session revision model
(types + `classify_mutation` + `ActiveScene`). It owns the revision/event contract
only; it does **not** execute scene/output changes (LS2+ wires the live render
consumer). Mutations carry `expectedRevision`; stale ones are rejected with a
conflict, cold ones are rejected during an active session, hot ones advance the
committed revision, and every attempt is recorded as a `LiveEditEvent` for the
session timeline.
