# S0b: the host app in a room (plan 224) — 2026-11-08

Plan 224 S0b asks two questions before Phase 3 starts: is publishing from
the renderer with `livekit-client` good enough (D6), and is hiding the
native Preview during a talk show right (D7)? This note answers both from
the desktop code and the runner's own rooms spike
(`videorc-cloud/docs/spike-rooms-2026-11.md`), says what was and was not
measured on this Mac, and records the decision Phase 3 is built on.

## Decision

**Hide the Preview while the room is open. The Show stage is the host's
picture.** The docked slot and the detached Preview window close when the
room opens and come back when it closes, only if the room closed them
(the first-run rule from plan 203 S5, `reopenPreviewAfterSetupRef`). The
`PreviewStage` reads one line meanwhile: "The Show stage replaces the
Preview while the room is open." with "Close the room". Status copy names
the reason (`AGENTS.md`: never a silent downgrade).

Renderer publishing stands as D6 wrote it. Nothing found here needs native
publishing from the backend (plan 184 X10).

## Why hide, not "the Preview shows the return"

1. **The native Preview shows the backend compositor's program, and in a
   talk show that is not the show.** The camera belongs to the renderer
   while the room is open (D6), the desktop composes nothing for the
   stream (D9), and the runner reads no feed on a talk show (wire notes,
   "A talk show still gets ingest pairs and feed paths"). A CAMetalLayer
   picture of a camera-less local program would be a lie next to the real
   stage.
2. **The renderer already holds the room's tracks.** It subscribes to every
   person in the room (the stage needs them, and backstage voices reach
   the host, D11), so `<video>` tiles placed by the shared geometry are
   the lowest-latency picture the host can have: 150 to 300 ms (D19). The
   return is about half a second behind and carries the host's own voice
   late; it stays a Program monitor, not the stage.
3. **Routing the return into the native layer costs a second subscription
   and a second decode** for a worse picture: the runner spike measured
   the return at 99 ms median after the publisher's flash (6/6) with the
   runner token `hidden: false`, and invisible with `hidden: true` (the
   web mints `hidden: true` today). So "the Preview window shows the
   return" would also wait on that open wire question; hiding does not.
4. **One mechanism, already proven.** Closing the Preview window through
   `closePreviewWindow()` and reopening through `openPreviewWindow()` is
   what first-run setup does; the dock reporter sees one unmount and one
   mount, and main bumps the dock epoch once at the reopen
   (`engageDockedPreviewPlacement`). `pnpm probe:preview-lifecycle` gains
   the two steps (C-G5).

## What the desktop code says about the host's media (D6)

- **Camera.** The backend owns the camera (`preview_camera.rs`,
  `source_registry.rs`: `SourceConsumerReason::{Preview, Recording,
  Streaming, Diagnostics}`). A renderer `preview.camera.stop` while a
  separate-source take records the camera is already refused
  (`stop_preview_camera_from_client`,
  `CAMERA_STOP_REFUSED_BY_SOURCE_TAKE_MESSAGE`; the ISO-take freeze of
  2026-11-03). The hand-over reuses that door: the room opens only after
  the backend lends the camera with reason `talk-show`, the lend is
  refused by the same take check, and `preview.camera.start` is refused
  while the camera is lent so a layout transaction cannot fight the
  renderer's `getUserMedia` for the device. Closing the room returns it.
- **Microphone.** The renderer already opens the Sources microphone for
  the visual meter (`lib/mic-stream.ts`), matched by its plain name
  against Chromium's decorated labels (`matchStrictAudioInput`, plan 080
  S3). The room's mic track uses the same matcher. The backend's mic stays
  open for the level meter only.
- **Web permissions.** The main renderer's web-platform permissions allow
  `media` for **audio only** and refuse display capture outright
  (`web-contents-security.ts`, `rendererWebPermissionAllowed`,
  `setDisplayMediaRequestHandler` answers `{}`). Camera video and the
  screen share therefore need a main-process grant that exists only while
  a talk-show room is open: main allows video `media` for the trusted
  main document under the grant, and the display-media handler answers
  with the one `desktopCapturer` source the renderer picked through a
  main-validated IPC, consumed once. Outside the grant the boundary is
  unchanged, and the security test pins both.
- **Screen share.** `desktopCapturer.getSources` runs in main only (the
  plan 203 permission prime); the renderer gets a list of ids, names and
  small thumbnails through IPC and asks for one. S0b's legibility and CPU
  numbers at 720p and 1080p (2, 4, 6 Mbps) are **not measured here**: the
  dev app has no camera TCC grant (AGENTS.md, record-latency) and this
  T3 session cannot post HID, so a real publish from the Electron
  renderer waits for the talk-show smoke's headless-Chrome guests (S-G1)
  or an attended run. The renderer publishes VP8 720p30 with simulcast
  (D3); the screen track is published at 1080p with `contentHint:
  'detail'` so text stays crisp, and the bitrate question stays open for
  S-G1.

## Measured here

| Question | Result |
| --- | --- |
| Backend releases and retakes the camera without a frozen Clips buffer | Covered by unit tests, not a live run: the lend is refused while a take records the camera (the ISO trap), and `preview.camera.status` reports `talk-show` while lent (C-G4). The dev app cannot open a real camera. |
| Renderer `getUserMedia({ video })` in the main window | Refused by the permission boundary today; allowed only under the room grant after C-G4. |
| `getDisplayMedia` in the main window | Refused today (`callback({})`); answered with the picked `desktopCapturer` source under the room grant after C-G4. |
| LiveKit on this Mac | `livekit-server` 1.13.10 and `lk` 2.19.0 installed; `livekit-client` 2.23.0 is the newest on npm (2026-11-08). The runner's devtool mints dev tokens with `devkey` / `secret`. |
| Return visibility | From the runner spike: visible to the host only with `hidden: false`; the web mints `hidden: true`. The Program monitor stays optional until that is settled (an owner/orchestrator call). |

## Not measured (owed)

- Shared text legibility at 720p and 1080p, VP8 and H.264, 2/4/6 Mbps, and
  the renderer's CPU while publishing camera plus screen: S-G1's harness
  on this Mac, or an attended run with the packaged app.
- The return in a `<video>` against the native Preview for smoothness: moot
  under the decision above, and the return is invisible with the current
  runner token anyway.

## What Phase 3 builds on this

- C-G4: the camera lend/return with reason `talk-show`, the room grant for
  video and display media, `desktopCapturer` sources over IPC, the room
  client in `lib/talk-show-room.ts` (lazy, never in the eager bundle).
- C-G5: the Preview hides and returns through the first-run mechanism; the
  lifecycle probe gains a scripted room open and close.
- The Program monitor (D7) is wired as optional: it subscribes to the
  `runner:<showId>` tracks when they are visible, and shows nothing while
  the runner is hidden.
