# Plan 247: fixes from the first live talk show test (2026-11-16)

Status: DRAFT, written from logs and a read-only code trace while the owner was live.
The key claims were spot-checked in the code: findings 1, 3, 9 and 13. Nothing here
has been reproduced or changed yet.

Code read at: desktop `origin/main` af321b6e7 (installed 0.30.0 = bd1b19ae6),
web `origin/main` 1394567a (production).
Evidence: `~/cloud-test/reports/2026-11-16/live-talk-test/` (Vercel request and
runtime logs) and `~/Library/Application Support/Videorc/logs/backend.log`
(2026-11-16 11:34–12:40 UTC).

## Goal

A host can open the room, let a guest in, go live, and end the show without the
guest freezing, the picture disagreeing between the app and the stream, or the
show failing to end.

## Owner decisions (2026-11-16)

- **D-1 Green screen:** "should just work if I am using it." When the camera's key
  is on (`layout.cameraChromaKeyEnabled`), the talk-show camera is keyed too, with
  the same settings. F1 is in scope.
- **D-2 Circle camera:** the stream is right; keep it. The app's own view must show
  the same circle: the Show stage that replaces Preview, and the Program monitor.
  No change to which shape is sent.
- **D-3 Library:** a cloud show gets its own Library entry next to its cloud
  recording, backed by the `sessions` row D3 creates.

## The test (UTC)

The owner was the host in Videorc 0.30.0 and also the guest, in Firefox 159 on
the same Mac. The Mac sat at load average 40–68 with 8 GB of swap in use the
whole time. Three other jobs ran during the show:

- two Videorc repair passes (FFmpeg `freezedetect` and a remux of the
  2026-11-15 recording, 70–97% CPU);
- another session's dev Electron app running the plan 231 S11 smoke;
- a `rustc` build.

**First try**

| Time     | What happened                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------ |
| 11:34:54 | The host opens the room (`sh_n2F…`).                                                                   |
| 11:35:41 | The guest is let in.                                                                                   |
| 11:36:22 | The host takes a moderation action on the guest.                                                       |
| 11:36:38 | **The show is ended from the /live page in Firefox** (End, then the `confirm`). This was never on air. |
| 11:36:39 | The Clips ring comes back.                                                                             |

**Second try**

| Time               | What happened                                                                 |
| ------------------ | ----------------------------------------------------------------------------- |
| 12:14:08           | The Clips ring steps aside and the room opens (`sh_pJ9…`).                    |
| 12:18:10           | The show goes live on YouTube through the cloud.                              |
| 12:21:58           | The guest is let in.                                                          |
| 12:22:20           | The guest goes on stage.                                                      |
| 12:26:00           | LiveKit `listParticipants` times out (harmless).                              |
| 12:28:19           | Every 5 s, chat messages fail to save locally ("references missing session"). |
| 12:30:44           | /live End returns 503.                                                        |
| 12:30:57, 12:30:59 | The desktop's `legs/end` returns 503, twice.                                  |
| 12:31:24           | /live End returns 200.                                                        |
| 12:31:26           | The Clips ring comes back.                                                    |

## Findings

| #   | Owner's words                                               | Verdict                    | Cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Fix ships as                                 |
| --- | ----------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1   | "The guest is completely blocked", "connection is used"     | LIKELY                     | The guest page restarts the camera whenever its own quality reads `Poor` (`components/guest/guest-room.tsx:521-534`): `restartTrack({resolution: h360})` stops the camera and reopens it with a bare `getUserMedia`, which loses the picked device. On recovery it restarts again at 720p. Nothing awaits or catches it, so a failed reopen leaves a dead camera while the page still shows "on". On a loaded Mac the quality flaps, so the camera is torn down again and again. The alert the guest sees is "Your connection is weak. Your video may pause." The 12:26:29 fetch is the normal 270 s token refresh, so the guest was still in the room.                                                                                                                                                                                                                         | web deploy                                   |
| 1b  | (not seen today)                                            | CONFIRMED in code          | If `connect()` throws in the asking loop (`guest-room.tsx` ~620-660), the retry opens a second Room with the same identity. The first Room is kicked with `DUPLICATE_IDENTITY`, the guest sees "Connection lost. Reload to rejoin.", and a zombie participant stays behind.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | web deploy                                   |
| 2   | "We are seeing a screenshot from our guest" (on the stream) | CONFIRMED by design        | The program page keeps the last decoded frame when frames stop (`lib/cloud/program/stage-media.ts`). It shows "Back in a moment" only at 5 s and reflows only 60 s after that (`stage-presence.ts`, `wire.ts:243-249`). A camera that stalls or dies without muting, which is finding 1's failure, stays a frozen frame. The in-flight P0 camera-off fix only handles `publication.isMuted`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | web deploy                                   |
| 3   | The guest freezes in the app                                | LIKELY                     | The host Room uses `adaptiveStream: true` (`apps/desktop/src/renderer/src/lib/talk-show-room.ts:217, :586`). The stage sets `video.srcObject = new MediaStream([track])` itself and never calls `track.attach()` (`components/studio/show-stage.tsx:265`). livekit-client sees no element, reports the video as not visible, and the server pauses that guest's video to the host. The program page sets `adaptiveStream: false` and is not affected.                                                                                                                                                                                                                                                                                                                                                                                                                           | desktop release                              |
| 4   | "I'm hearing myself"                                        | NOT A BUG (one-Mac test)   | The desktop plays only remote guests and Firefox plays only the host, so on one machine each copy of your voice comes back through the other app. Neither app's echo canceller can hear the other's playback. Muting the guest's mic stops one copy; Firefox still plays the host. Mute the Firefox tab, or wear headphones, or join as the guest from another device.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | none                                         |
| 5   | "Circle on the stream, rectangle in Videorc"                | CONFIRMED                  | The program page clips the host tile to a circle from `hostShape` (`lib/cloud/program/stage-view.ts:166-178`). The desktop Show stage ignores `hostShape` and only sets `borderRadius` (`show-stage.tsx:207-212`). Plan 224 D8 says the host tile takes the Sources shape, so the desktop is the side that is wrong. A second mismatch: the cloud reads the raw `cameraShape`, while local paths use `effectiveCameraMaskShape`, so a stored circle on a non-inset preset is a rectangle locally and a circle in the cloud.                                                                                                                                                                                                                                                                                                                                                     | desktop release                              |
| 6   | "Green screen is also not working"                          | CONFIRMED scope cut        | The room publishes the raw 720p `getUserMedia` camera (`talk-show-room.ts:458-474`). The chroma key lives only in the native compositor. Plan 224 lists chroma key in a talk show as out of scope (`plans/224-guests-from-a-link.md:1422`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | new feature, owner decision                  |
| 7   | "Everything stopped when I added a new person"              | NOT A BUG in code; UX risk | The first show was ended by the /live page's End button in the same Firefox profile as the guest tab (`components/live/end-stream-button.tsx`, behind `confirm("End the stream on every platform?")`). That came 16 s after a moderation action, on a show that was not on air yet. The Clips ring stepping aside at room open and coming back at the end is #1375 working as designed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | web deploy (copy/visibility)                 |
| 8   | Show would not end                                          | CONFIRMED                  | Two silent 503 paths, neither a LiveKit timeout. **(a)** `/end`: `tearDownManagedShow` (`lib/cloud/media/lifecycle.ts` ~119-226) stops the egresses, re-lists them at once, and returns false with no log while any egress is still ENDING. `handleEndCloudShow` then answers 503 "still stopping" (`lib/cloud/shows-route.ts` ~799-806). So the first End of any show with a running egress normally fails. **(b)** `legs/end`: once `endRequested` is set, `withShowLease` returns `MEDIA_UNAVAILABLE` ("could not reach its media service") with no log (`lib/cloud/managed-route.ts:387`; same check at :275). Both desktop calls were refused that way. Between the first 503 and the 200 retry, the show was half-ended for about 40 s: the egresses stopped, but the room, the guest and the row stayed. A retry is safe, and the reaper probably finishes it otherwise. | web deploy                                   |
| 9   | (log) chat not saved                                        | CONFIRMED                  | `cloud.show.goLive` starts live chat with the show id as the session id (`crates/videorc-backend/src/main.rs:12082-12091`). Saving a message requires a `sessions` row with that id (`storage.rs:4369-4384`), and nothing creates one for a show. On failure the ingest rolls back (`live_chat.rs:3835-3838`) and the YouTube cursor does not advance (`youtube_chat.rs:1465-1469`). **So the first chat message blocks YouTube chat for the whole show:** no comments reach the app, and the same message was retried 89 times, each one a YouTube list call against the 2,500-unit daily budget.                                                                                                                                                                                                                                                                              | desktop release                              |
| 10  | (log) heavy work during a live show                         | CONFIRMED                  | Boot-resumed repair jobs wait 30 s, then `begin_maintenance_when_idle` (`recording.rs:14536-14537`). That gate only knows local capture (`ffmpeg_work.rs:98-102`), and a cloud show holds no capture permit. The Clips ring's light permit allows maintenance by design (`ffmpeg_work.rs:111-128`). Repair FFmpeg runs at normal priority.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | desktop release                              |
| 11  | (log) Clips ring after the show                             | CONFIRMED                  | When the web ends a show, the desktop's state poll exit (`cloud_show.rs:3233` → `:3102`, `forget_talk_show` + `clear_show`) never calls `live_chat::stop_live_chat`. Chat kept polling until 12:35:55, and the next ring's Buddy picked up the stale `sh_pJ9…` id. The ring's mic timeline then re-anchored 22 times, with "after N seconds" growing from 21 to 512 under load (`session_audio.rs:5991`). No cap was found, so this looks unbounded. "Stream-only session" in the log is the no-recording-file branch (`recording.rs:12962`); the wording is misleading.                                                                                                                                                                                                                                                                                                        | desktop release                              |
| 13  | (from the trace) End livestream failure                     | CONFIRMED                  | In a talk show, End livestream completes the platforms' broadcasts **before** `cloud.show.legs.end` (`apps/desktop/src/renderer/src/hooks/use-studio.tsx:17501-17507`), and `destinations_generation.stop()` has already run (`cloud_talk.rs:2012`). When `legs.end` fails (the two 503s), YouTube is already marked complete while the cloud keeps pushing. The host sees "Couldn't end the livestream … Try again, or close the room." and stays on air with no owner left to retry against.                                                                                                                                                                                                                                                                                                                                                                                  | desktop release                              |
| 14  | (from the trace) show ended elsewhere                       | CONFIRMED gap              | When the show is ended from videorc.com, `clear_show` sets `end_reason` (`cloud_show.rs:2279`) but the renderer never reads it. The room and guests vanish and Preview returns with no message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | desktop release                              |
| 12  | (log) push alerts                                           | CONFIRMED config           | Every desktop `/api/alerts/notify` returns 503 because `VIDEORC_VAPID_*` is not set in production.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | owner: set env, or the desktop stops calling |

## Slices

Order by harm:

1. D3 (chat is dead in every cloud show) and D4 (End can strand YouTube).
2. W3 (the first End fails) and W1 + W2 (the guest freezes).
3. D1, D2, F1, D5, D6, W4, W5, D7.

F1 is the largest slice. If it is not ready, it may follow in 0.30.2; the other
desktop slices do not wait for it.

Web slices ship with a deploy. Desktop slices go into one release (0.30.1).
The P0 camera-off fix is still uncommitted in `~/projects/videorcweb-wt-guest-cam` and
`~/projects/videorc-wt-guest-cam` (another session). W1, W2 and D2 touch the same
files (`guest-room.tsx`, `stage-presence.ts`, `show-stage.tsx`). Land P0 first, or fold
these into it, and never edit those worktrees from another lane.

### W1. The guest's camera survives a weak connection (web; Diagnose, fit 9, fable-5.1)

- Remove both `restartTrack` calls from the `ConnectionQualityChanged` handler
  (`components/guest/guest-room.tsx:521-534`) and keep only the "weak" notice.
  Simulcast and dynacast already adapt. If a downshift is still wanted, use sender
  parameters, never a re-capture.
- In the asking loop, disconnect a Room whose `connect()` threw before retrying (1b).
- Every remaining `restartTrack` (the device pickers at :852 and :875) gets awaited,
  with a catch that shows the camera or mic as off.
- **Done when:** `tests/guest-page.test.ts` emits `Poor` then `Good` on a fake room and
  asserts `restartTrack` is never called and the `MediaStreamTrack` identity is
  unchanged. A connect that throws once leaves exactly one Room. The browser guest
  suite passes.

### W2. A stalled camera never shows a frozen frame on the stream (web; fable-5.1)

- Extend P0: a person whose video delivers no frame for N s (N ≤ 3), muted or not,
  gets the camera-off look (avatar or name) instead of the held frame. Keep the
  500 ms copy for short hiccups.
- **Done when:** `tests/cloud-program-stage.test.ts` and `run-stage.mjs` stall a track
  without muting it, and there is no stale frame after N s. A track that recovers
  returns to video.

### W3. Ending a show never fails silently (web; fable-5.1)

- In `tearDownManagedShow`, after the stop calls, poll `listEgress` about once a
  second until every egress is terminal or the 45 s deadline passes, instead of one
  immediate re-list.
- If the end is still pending at the deadline, answer 200 or 202 with
  `{ ok: true, ending: true }`, not 503. The end is durable and the reaper completes it.
- Add a `console.error` with the cause on every silent `false` branch: lease busy,
  egress ids still ending, objects not removed.
- In `withShowLease`, when `endRequested` is set, answer 409 `cloud-show-ending` and log
  it, instead of the misleading `MEDIA_UNAVAILABLE`. The desktop treats 409 as
  "already ending" and does not report it as a failure (desktop half folds into D5).
- **Done when:** a fake LiveKit whose `stopEgress` acknowledges ENDING and whose list
  turns COMPLETE on the second read gives a 200 End on the first call. A `legs/end`
  during a pending end gets a 409 and a log line.

### W4. /live's End matches what is on air (web; opus-5.5)

- Show "End stream" only while the show is on air. Before that, the button says
  "Close the room", with its own confirm text.
- **Done when:** /live renders the right label for a room that is open but not on
  air, and for one that is on air.

### W5. Small web items (gpt-6.1-sol)

- `lib/cloud/media/participants.ts`: on a `listParticipants` failure, drop the cache
  entry so the next poll retries.
- `/api/alerts/notify`: when VAPID is not configured, answer with a code the desktop
  treats as "push off". Or the owner sets `VIDEORC_VAPID_*` in production. Today the
  desktop only logs `watchdog-push-failed` once per stream and shows nothing
  (`crates/videorc-backend/src/watchdog/mod.rs` ~1197-1213).

### D1. The host sees a live guest (desktop; Diagnose, fit 9, fable-5.1)

- Set `adaptiveStream: false` in both Room constructors (`talk-show-room.ts:217, :586`),
  or render the stage with `track.attach(element)`. The first is the smaller change.
  Dynacast stays on.
- **Done when:** a unit test asserts the option. The talk-show smoke hides and shows
  the window with a guest on stage, and `framesDecoded` keeps rising.

### D2. The host tile in the app matches the stream (desktop; UI, fit 9, opus-5.5)

- In `StageTileView` (`show-stage.tsx`), when the tile is the host's person tile,
  `room.stage.hostShape === 'circle'` and `cornerRadius > 0`, clip to
  `circle(closest-side at 50% 50%)`. Keep the name plate visible, the same way the
  program page does.
- Per D-2, what is sent does not change: the stream keeps its circle, and the app
  copies the stream. Use the same rule as `stage-view.ts:166-178` (circle only when
  `hostShape === 'circle'` and `cornerRadius > 0`, so never in Solo), so the two
  cannot drift. Also check the detached preview window, if it shows the stage
  during a show.
- **Done when:** `show-stage.test.ts` covers a host circle side by side, and none in
  Solo. With a show open, the Show stage and the Program monitor show the same circle
  as the program page. Checked by eye in light and dark.

### D3. Chat works in a cloud show (desktop; Implementation, fit 9, fable-5.1). Do this first.

- In `cloud.show.goLive` and in resume, create a `sessions` row for the show id before
  `start_live_chat`. Close it on legs end or show end.
- Make `MissingLiveChatSession` terminal, not retried for ever: the provider reads
  Failed, and no YouTube call repeats.
- Library (D-3): the show's row is its own Library entry, listed with its cloud
  recording: title, platforms, duration and chat. It has no local media file, so
  local-file actions (export, Finder, repair) are hidden for it. The repair queue,
  probe and export must skip a session with no file.
- **Done when:** a backend test runs `goLive` on a managed show, delivers one YouTube
  message, and asserts it persists and reaches the renderer event. A missing session
  stops after one failure.

### D4. Ending a talk show never strands YouTube (desktop; fable-5.1)

- Call `cloud.show.legs.end` first, then `completePreparedPlatformBroadcasts` after it
  succeeds (`use-studio.tsx:17501-17507`). On failure, keep the platform owner and offer
  "Close the room" in the toast.
- Treat W3's 409 `cloud-show-ending` as success ("already ending").
- **Done when:** a renderer test shows a `legs.end` rejection leaves the platform owner
  intact and no broadcast completed, and that a 409 counts as ended.

### D5. A show ended elsewhere is ended cleanly here (desktop; fable-5.1)

- On the state poll's `LoopExit::Ended` for a talk show (`cloud_show.rs:3233`, `:3102`):
  stop live chat, clear the cohost or Buddy session id, and emit a status message.
  The renderer toasts "The show was ended from videorc.com."
- **Done when:** a `cloud_show` test where web state `ended` gives the message and
  stopped chat. A renderer toast test. The next Clips ring logs its own session id.

### D6. No heavy maintenance during a show (desktop; gpt-6.1-sol)

- Add a live hold on `FfmpegWork`, taken at room open and released in
  `forget_talk_show`. It refuses `try_begin_maintenance` and cancels a running repair,
  the same as full capture does.
- Also defer repairs while the 1-minute load is above the core count.
- Run repair FFmpeg at background priority (`nice`, or a QoS class).
- **Done when:** an `ffmpeg_work` unit test shows the hold deferring and cancelling
  maintenance, and a repair started while a room is open waits.

### D7. The mic re-anchor loop has a floor (desktop; Diagnose, fable-5.1)

- Under sustained overload, `session_audio` re-anchored 22 times in a row with a
  growing gap (finding 11). Find why each re-anchor fails to hold. Cap the loop with
  a clear warning, or re-anchor to the current cursor.
- **Done when:** a session-audio test that starves the FIFO reader for 30 s recovers
  in at most two re-anchors once the reader resumes.

### F1. Green screen works in a talk show (desktop; Implementation, fit 9, fable-5.1)

Per D-1. Today the room publishes the raw 720p `getUserMedia` camera
(`talk-show-room.ts:458-474`), and the key lives only in the native compositor
(Rust CPU, Metal, FFmpeg: `scene_geometry.rs` `ChromaKeySpec`, the angle model with
a luma-scaled saturation floor, spill, and Hide edges). The renderer has the
settings (`lib/green-screen.ts`, `LayoutSettings.cameraChromaKey*`) but no key.

- **The fourth key path:** a LiveKit track processor (`LocalVideoTrack.setProcessor`)
  that runs the camera through a WebGL2 shader. The shader mirrors the Rust spec
  exactly: key colour, `max_angle_deg`, `band_deg`, the saturation floor
  (`CHROMA_KEY_SATURATION_FLOOR_*`), spill, and edges with the mirror resolved once.
  A processor keeps device switching and mute working, and the published track is
  the processor's output.
- **Background:** VP8 has no alpha, so composite before publishing, onto what the
  local scene draws behind the camera: its background colour, image, or live
  background. The live background already renders on ANGLE in the renderer. With no
  background, use the stage ground colour. The guest page, program page and the
  app's own stage all show that same track, so they agree.
- **Live toggles:** turning the key on or off, or changing its settings during a
  show, applies within one frame (processor options, no republish).
- **Parity:** the Rust tests export a table of spec vectors (pixel in → alpha and
  spill out). A JS reference of the shader math must match it within 1/255, so the
  four paths stay in step. Same rule as the camera circle mask's three paths.
- **Load:** 720p at 30 fps on the GPU; driven by `requestVideoFrameCallback`; no
  per-frame canvas readback (`getImageData`).
- **Done when:**
  - The parity test passes.
  - `pnpm smoke:cloud-talk-show` with a green fake camera and the key on gives a
    host tile on the program page with no green, checked by a pixel probe.
  - The key off gives the raw camera.
  - A device switch during a show keeps the key.
  - The owner checks it by eye on a real green screen.

## Delivery and verification (owner, 2026-11-16)

- One PR per slice, with the plan itself as its own docs PR. Desktop PRs target
  `TheOrcDev/videorc` main; web PRs target `TheOrcDev/videorc-web` main.
- **No heavy gates per PR** (owner: "we are going to run it after we merge all of
  these"). Each PR runs only cheap checks:
  - type-check, lint and format-check on the touched files;
  - the unit test files it touches or adds;
  - for Rust, `cargo fmt` and one `cargo check -p videorc-backend --tests` through
    `pnpm cargo:slot`.
    No `cargo test` suites, clippy, `pnpm build`, smokes, probes or browser suites.
    New Rust tests are written but run in the batch.
- **After all PRs merge, one batch on main:**
  - Rust: `cargo fmt --check --all`, `cargo test -p videorc-backend`,
    `cargo clippy -p videorc-backend -- -D warnings`.
  - Desktop: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
    `pnpm --filter @videorc/desktop test`, `pnpm test:scripts`, `pnpm build` (renderer
    budget).
  - Smokes: `pnpm smoke:cloud-talk-show`, with the F1 green-camera pixel probe.
  - Web: typecheck, lint, `pnpm test`, the cloud-program browser suites, `next build`.
  - Then a release (0.30.1) and the owner's second live test, with the guest on
    another device.
- Merge order for conflicts: desktop #1421 (camera-off) and #1419 (room takeover)
  first, then D2. D3 before D5. Later PRs rebase.

## Out of scope

The one-Mac echo (finding 4). LiveKit plan limits. The Rust UI.

## How to run the next live test

- Join as the guest from a phone or a second computer, with headphones.
- Nothing else heavy on the Mac: no smokes, Rust builds or repair jobs. Check
  `uptime` before going live.
- Keep the /live tab out of the guest's browser window.
