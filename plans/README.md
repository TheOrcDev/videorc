# Implementation Plans

- 2026-10-28: [Plan 210](210-scenes-for-your-apps-and-hide-screen.md),
  Scenes for your apps, and Hide screen. Owner request: "our whole Scene tab
  needs to be much smarter", quoting a user who switches between T3 Code and
  Figma on stream and hides a sign-in behind a blurry picture in OBS. Today
  that takes about nine clicks, the scene breaks when the app relaunches (a
  window id), every switch stops one capture and starts another (a frozen
  picture, probably a black frame, never measured), saved scenes have no
  key, Deck or phone button, and nothing can blur the screen.
  - Phase A (macOS): New scene… makes one scene per app in your current look.
    The scene follows the app's front window and survives a relaunch. Swap in
    place on one capture, holding the last frame (no black). A scene list on
    the Scene page with auto-save. Keys, Deck and phone for saved scenes.
  - Phase B (all platforms): Hide screen, a frosted still of the screen on
    every output while the camera and microphone stay on, done at the
    capture source. A default key (⌃⌥H) and every other surface. Agents can
    hide, never show.
  - Phase C (macOS): Follow the app in front, and Hide screen when a password
    manager comes to the front on a display scene.
  - Phase D: the smoke, docs and acceptance.

  **EXECUTING** 2026-10-28: the owner took every recommended answer (D1
  to D13) and asked for the whole plan in one PR.

- 2026-10-27: [Plan 209](209-agents-control-videorc-mcp.md), Videorc MCP:
  agents and Buddy run the studio. Owner request: a complete MCP so people
  control everything from their agents, with Buddy using it too. Agents on
  this computer (Claude Desktop, Claude Code, Cursor, Codex, VS Code) connect
  through `videorc-mcp`, a stdio bridge shipped in the app, to a loopback-only
  `/mcp` endpoint with per-agent tokens. 43 tools cover looking (status,
  picture, chat, Library), running the show, arranging the picture ("move
  Buddy to the top left", "the banner to the bottom left", with the Scene
  canvas's own snaps), chat, Buddy, preparing and the Library. They run through the same executor as the buttons and Stream
  Deck, whose allowlists stay unchanged. The owner chose full control with no
  prompts, so actions are logged and attributed, one Stop cuts every agent,
  deletes go to the Trash, and YouTube removals still wait for a click (API
  policy). Free; Buddy's tool use is Premium, triggered only by the
  streamer's voice or `/buddy`, through a new videorc.com planner whose
  calls the desktop checks against Buddy's subset.
  **BUILT** 2026-10-28 as one desktop PR (all 23 slices, plus one-click
  Connect, a `.mcpb` and two MCP prompts) and a videorc.com PR (the planner
  route and an agents page; deploy it first). Local gates and smokes green;
  owner acceptance, packaged by-eye, the planner's live eval and
  Windows/Linux runs owed; the owner took all seven recommended answers
  (2026-10-28).
- 2026-10-27: [Plan 208](208-liquid-chrome-colours.md), Liquid Chrome
  colours. Owner request: redesign Videorc's colour after the Welcome
  screen's Liquid Chrome, metallic black with its shine, and the other way
  around in light mode. Owner calls from a rendered mockup:
  - every window sits on a solid, frosted still of Liquid Chrome under the
    coats, with no desktop showing through, the same on every platform;
  - polished chrome controls and edges (primary buttons, beads, plates, a
    red LED Record) while panels, menus and text stay flat;
  - light mode is the crisp pixel invert;
  - the phone remote and the OAuth page come along.

  Eight slices, from before pictures through the ground assets, opaque
  windows, the probe, controls, the Welcome invert and the served pages, to
  docs and gates. **EXECUTED** 2026-10-27 (S0 to S7) on
  `plan-208-liquid-chrome-colour`, PR #883: every window sits on the
  chrome ground, controls wear chrome, Record is the red LED, light
  Welcome is the invert, and the phone remote and OAuth page follow; the
  design skill is rewritten for it. `VIDEORC_GLASS=clear` keeps the old
  glass for one release. Gates in the
  [acceptance record](../docs/acceptance/2026-10-27-liquid-chrome-colours.md);
  the owner's by-eye in both themes and a Windows pass are owed.

- 2026-10-27: [Plan 207](207-first-run-setup-steps.md), First-run setup,
  steps 2 to 5. Owner request: after permissions, "What are you making?",
  "Your look", "Sound check" and "Where you stream". The goal (Recordings,
  Livestreams or Both) decides whether the streaming step shows. Your look
  picks orientation, layout, camera shape and a live background on the
  scene's own picture, with the background moving. Sound check is the
  microphone, its level with a verdict, "Set level for me", and System
  audio. Where you stream signs in to YouTube, Twitch, Kick or X and turns
  each one on. Nothing in setup opens a capture device. It also fixes
  "Clips couldn't start" on a fresh install without a screen. **BUILT IN PR**
  (unmerged); owner acceptance and the final smoke bundle are still owed.
  [Acceptance](../docs/acceptance/2026-10-27-first-run-steps.md).
- 2026-10-27: [Plan 206](206-facebook-live.md), Facebook Live in the
  Livestream tab. Owner request: a Facebook connector like the other
  platforms, stream key first, the rest once Meta approves. Phase 1 (one
  desktop PR, no Meta, no web change): a horizontal Facebook card after X,
  server filled in, key from Live Producer, a Go Live reminder to press Go
  live there; chat, viewers and title say they need sign-in. Phase 2: the
  owner's Meta app and Business Verification, plus a spike that picks device
  code or a website relay for sign-in. Phase 3 (dark in public builds):
  connect a Page, Go Live with our title, comments, viewers. Phase 4: App
  Review and the switch. Replaces plan 079 (#504, closed stale). **Phase 1
  BUILT** (S0 to S5, one desktop PR; owner live take owed); Phases 2 to 4
  wait on the owner's Meta setup (M1). Owner calls D6 (website) and D7
  (sign-in, after S6) open.
- 2026-10-27: [Plan 205](205-preview-is-the-source-of-truth.md), The
  preview is the source of truth. Owner request: a banner and Buddy put on
  the picture weren't visible in the preview; "our preview window should
  actually be the source of truth". Root causes, checked on the owner's
  profile: Clips (on by default) makes the idle preview a recording, so
  Buddy set to stream only never draws. The idle preview never draws Buddy
  at all, and draws it only while the Scene editor holds it. The banner
  was placed while hidden, and on the docked live canvas no label says so.
  One rule, "the Preview shows the program": every layer at least one
  running output carries, and at idle every layer with a switch on. Phase
  1 covers that rule in Rust and TS, Clips following Show in recording, "Hidden",
  "Off" and "Stream only" on the Scene chips, and a dev-only Preview pixel
  oracle with `smoke:preview-truth`. Phase 2 adds a macOS program leg for
  Clips at idle and record + stream with a split stream leg (measured spike
  first). Phase 3
  covers the Windows media session's preview and Buddy on the proof
  surface. **BUILT**, PR #880: S1 to S9. Owed: S10 (Windows tester pass,
  Linux box), the owner's by-eye, the 4K idle program-leg cost call.
- 2026-10-27: [Plan 204](204-chat-in-the-studio.md), Chat in the Studio.
  Owner request: live chat in the Studio in a small window, optional with a
  switch, a click putting a message on stream, less detail than the Stream
  Manager. With **Chat in Studio** on (Settings → General → Chat, off by
  default; ⌘K mirrors it), the inspector shows a Chat section under Session
  while on air. Each row has a small avatar, the name, the words and the
  platform mark. A click shows the message on stream through the same
  highlight the Stream Manager uses. The list follows the newest message,
  and the header has Open Stream Manager and a hide button with Undo. It
  keeps its default look under Retro LCD. The Stream Manager's list
  mechanics moved, unchanged, into one hook both lists share. Renderer
  only, in its own lazy chunk (+88 eager gzip bytes). `smoke:studio-chat`
  proves the card in the stream output. **BUILT IN PR**. Owed: the owner's
  by-eye on a real stream, the two-destination fit, and confirming that
  "yes" meant avatars.
- 2026-10-27: [Plan 203](203-first-run-permissions.md), First-run setup,
  step 1: permissions. Owner request: onboarding only on the first launch,
  a Settings button to run it again, and permissions done perfectly first.
  The Liquid Chrome live background fills the window (the shared WebGL2
  player, lazy, 30 fps cap, poster when still), and one centred card asks
  for Screen Recording, System audio, Microphone and Camera in place, with
  live states and proof. Launch requests were removed; Reopen and resume
  handle grants that require a relaunch. Existing installs skip it; smokes
  suppress it by default. "Run setup again…" sits in Settings → General
  and ⌘K. **SHIPPED IN PR**: S1 to S7 implemented, Polished at Normal
  chosen by the owner. Owner-owed: S0 clean macOS account (cold launch,
  main's identity, System audio and Reopen), light and dark by-eye, Windows
  tester pass, long refused-row copy, review of D2/D3/D5 to D7 shipped as
  recommended. [Acceptance](../docs/acceptance/2026-10-27-first-run-permissions.md).
- 2026-10-26: [Plan 202](202-buddy-talks-in-its-bubble.md), Buddy talks in
  its bubble. Owner request: a mode where Buddy talks only in its bubble, not
  in chat, and a switch for whether Buddy shows on takeover screens. A fourth
  mode, "Buddy talks: Off · Bubble · Suggest · Auto": greetings, answers and
  banter speak only in the on-stream bubble and never post to chat. It needs
  no posting consent, uses a settings field older apps survive, paces bubbles
  so none is cut short, and answers start with "@name". "Show on takeovers"
  in Layout → Buddy hides the pet and bubble while a takeover shows; it
  starts off for everyone, so the release notes must say so. Four desktop
  phases, no web change. **PLANNED**; owner answers recorded 2026-10-26.
- 2026-10-26: [Plan 201](201-studio-audio-balance.md), Balance the Microphone
  and System audio from the Studio. One Audio section puts both levels on
  one audiocn Mixer scale, each with the same Gain fader Sources uses, in
  the default and Retro LCD looks. System audio's idle level comes from the
  Clips bus; no new capture. The Sources mirror keeps Screen and Camera.
  **BUILT** 2026-10-27: S0 to S4 done. Owed: the granted System audio smoke,
  the Sources idle meter check, the owner's by-eye in both looks and themes
  (including D5's LCD faders), and the granted CPU comparison. The four CPU
  attempts and their failures are in the
  [acceptance record](../docs/acceptance/2026-10-27-studio-audio-balance.md).
- 2026-10-26: [Plan 200](200-better-recordings-export-separate-files-sound.md),
  Better recordings: exports, separate files and sound. Owner request: make
  exporting with separate sources, sound and system audio even better. Four
  audits plus measurements of real takes found: Clips squash a frame at every
  2 s join; the mic fold distorts 2-input interfaces; MP4 frame times sit on a
  1 ms grid (editors see VFR); 5.3 GB of leaked repair temps and backups;
  record+stream audio re-encoded AAC→AAC; separate files at 4K can damage
  Combined; the Camera file is upscaled with nearest sampling. Groups A
  (sound), B (Clips), C (export and files), D (separate files and picture),
  19 slices. **SHIPPED** 2026-10-26, D1–D7 at the recommendations. Open:
  the 4K separate-source runtime case, an intermittent runtime timing case
  and `1080p60:hard` in the recording matrix (see As built, slice E), and
  the owner-run checks.
- 2026-10-25: [Plan 199](199-one-minute-clips.md), A 1-minute clip beside
  the 30-second clip. Owner request: "Let's also add a 60-second clip." The
  ring always keeps 1 min, and each press says 30 or 60. There is a second
  global key (unbound), two Stream Manager buttons, two ⌘K items,
  `/clip 60`, "clip the last minute" by voice, and the optional `seconds` on
  `clip.mark`, `replay.save` and the remote `clipMark`. A 1-min mark spans
  the minute in Buddy's report. The Length setting goes away (D2). Disk use
  roughly doubles, and CPU does not change. Slices S0–S6. **EXECUTING**
  2026-10-25 on `plan-199-clip-length`, with D1–D9 at the recommendations
  (owner: "Execute the entire plan and create a PR"). Rebases onto plan
  198 when that lands.

- 2026-10-25: [Plan 198](198-separate-recordings-screen-file-and-clips.md),
  The Screen file dies at Record, and Clips loops after the take. Owner's
  first 0.11.0 take with Separate source recordings left Combined + Camera
  only: a capture-recovery latch from an hour earlier failed the Screen role
  12 ms in. Clips buffer-only starts arm the ISO legs and are refused, and the
  give-up limit never trips (62 refusals in 40 s). Plus a false "restart
  Videorc" leak warning. Slices S1 latch scoped to the take, S2 Clips never
  arms ISO, S3 Clips failure count, S4 leak snapshot, S5 toast + honest
  Library row, S6 acceptance. **BUILT** 2026-10-25 on
  `fix/198-screen-iso-startup`; owner's packaged take and by-eye owed;
  hotfix candidate (0.11.1).

- 2026-10-25: [Plan 195](195-windows-slow-microphone-breaks-recording-start.md),
  A slow Windows microphone makes Record fail. Tester bundle (0.9.150, Iris
  Xe, Cirrus Logic mic): the capture worker's fixed 2 s readiness never
  passes, so the mic falls back to FFmpeg's direct DirectShow input, and
  FFmpeg then needs 5-7 s to start against an 8 s deadline (0.5 s without a
  mic on the same PC). Also explains "Microphone can't be changed", "Videorc
  was busy" (liveControl expiries behind a 19 s poster) and the 3-31 s
  start delay. Slices: S0 Windows measurement script, S1 evidence, S2
  per-protocol readiness budget, S3 deadline per input topology (with PR
  #769), S4 busy toasts, S5 output right-sizing. Part W is a self-contained
  Windows test guide. **BUILT** 2026-10-25 on
  `fix/195-windows-slow-mic-recording-start`: S1–S5 done; S0/W3/W4 need
  Windows hardware; D1 (land #769) and D2 (Quick Sync default) are owner
  calls.

- 2026-10-25: [Plan 197](197-retro-lcd-studio.md), Retro LCD. Owner asked for
  the whole Studio in audiocn's LCD-display style, every dropdown included,
  then, on seeing it, for it to be an option. Settings → General → Retro LCD
  (off by default) draws each Studio inspector section on one LCD screen
  (titles, rows, the transport's keys, LCD dropdowns through `DevicePicker
trigger="lcd"`) and every level meter as plan 196's LCD meter. Off, the
  Studio is main's and the meters are the segmented bar again. **BUILT**
  2026-10-25 on `feat/studio-lcd-style`; owner's by-eye owed.

- 2026-10-25: [Plan 196](196-lcd-level-meter.md), The LCD meter for every
  audio level. Owner request: the Studio microphone meter and the meters on
  Sources become audiocn's LCD meter. `MicLevelMeter` stays the one meter
  component and draws `LcdDisplay` + `LcdMeter` in Videorc's `--primary`
  ink. A spike installed it on `4891fc53`: it builds, the eager bundle moves
  9 gzip bytes, and it trips only gates on the audiocn files (Base UI fence,
  colour literals, radii, one `cursor-pointer`, dock-slot coverage), fixed by
  one upstream line (U1) and allowlists (S1). S2 swaps the meter and
  measures the glow's CPU cost. The meter grows from 8 px to about 95 px.
  Owner calls D1 to D5 (ink, readout, size, clip colour, which Sources rows)
  have recommended defaults. **PR #800** 2026-10-25: built on the
  defaults, with audiocn PR #32 (U1). Owed: #32 merged and deployed, the CPU
  comparison and `smoke:sources` on a quiet host, owner by-eye.

- 2026-10-25: [Plan 194](194-five-more-live-backgrounds.md), Five more live
  backgrounds: Beams, Color Bends, Dither, Ferrofluid and Ghost Fibers from
  React Bits, on plan 190's machinery (free, three looks each, all three
  platforms). Beams, Dither and Ferrofluid are multi-pass like Silk and
  Plasma; Color Bends is one pass. Ferrofluid drops its spring simulation for
  React Bits' settled target (N1), so it stays a pure function of the phase.
  Ghost Fibers draws instanced quads with additive blending, so every
  renderer gains an instanced pass kind (N2), and the uniform block widens.
  S1 is a hard cost gate on the M4 before any port. **DRAFT PR #810**
  2026-10-25:
  all nine slices done. Owner calls: A (ship the two if Metal fits) and
  Ferrofluid at three quarters (at most 810 on its short side). Owed: Windows
  CI (the first fxc compile and WARP goldens), Linux GLES goldens, a
  quiet-host smoke with the budget (Ghost Fibers 1080p60), and the owner's
  by-eye check.

- 2026-10-24: [Plan 193](193-live-background-on-the-stream.md), The live
  background moves on the stream. Owner report: live backgrounds animate in
  Studio but sit still on the live stream. On macOS every record-and-stream
  session streams from an auxiliary compositor leg, and plan 190 wired the
  live background to the primary leg only (`live_background: None` on the
  auxiliary inputs), so the stream drew the poster. The owner's 10-24
  session proves it: its recording's ring moves on every frame, and the
  stream leg's code never sees the shader. Fix (D1): the stream leg draws the
  texture the recording rendered in the same tick, so no shader cost is
  added and the two can't disagree. Windows gets a WARP test that pins its
  stream target; Linux shares one frame already. The smoke gains
  record-and-stream cases (it only recorded). D2: 4K60 stays the poster.
  **MERGED** 2026-10-24 as #794 `a465a042`, shipped in 0.10.0. The smoke
  shows the stream ring moving like the recording's on every case. Owed: the
  Windows CI run of the S3 tests, a quiet-host p95 run and
  `smoke:recording-studio`, owner by-eye on a real stream.

- 2026-10-24: [Plan 192](192-buddy-greets-and-talks-on-its-own.md), Buddy
  greets and talks on its own. On the owner's 10-24 stream (0.9.150), Buddy
  was in Auto and posted nothing by itself, only the owner's two Say lines.
  There were five causes:
  - Greetings had no lines, so they posted nothing.
  - First-time chatters were never greeted automatically (only the "Say hi"
    nudge to the streamer).
  - Greetings never use AI (plan 164 D5).
  - Answers and Banter were off. Answers reply only when a viewer types
    Buddy's name; the "unanswered question" half of 164 D5 was never built.
  - About 10% of ticks failed with 502.

  The fix, in six phases:
  - built-in lines for every kind;
  - welcomes for first-time and returning chatters;
  - a Premium `/api/ai/cohost/greet` route that writes each greeting in the
    persona's voice, with the line as the fallback;
  - Answers from the streamer notes after 60 s;
  - a tick 502 diagnosis;
  - smokes and a live acceptance.

  **BUILT** 2026-10-24 (owner took every recommendation): web #93 and #92
  merged; the desktop PR carries Phases 0–3 and the smoke. Owed: a live
  acceptance stream and the next stream's tick failure rate.

- 2026-10-24: [Plan 190](190-live-backgrounds.md), Live backgrounds. The
  owner wants five animated React Bits backgrounds (Silk, Side Rays, Plasma
  Wave, Liquid Chrome, Line Waves) behind the screen and camera, free, on
  macOS, Windows and Linux in one plan, with no cost to anyone who doesn't
  turn one on. A live background is a bundled poster picture with a shader
  attached. The GLSL from React Bits is the source of truth. Metal and D3D11
  run hand ports, checked against golden grids. Linux runs the GLSL through
  EGL/GLES on a latest-wins readback thread, under `linux_vaapi.rs`'s
  render-node rules, because a CPU renderer measured far too slow. The two
  Electron previews run it in WebGL2. A budget guard drops to half size,
  then to the poster. Measured on an M4: 0.3–1.7 ms GPU per 1080p frame (a
  still is 0.05–0.08 ms), 0–1 MB extra for four of the five, about 13 MB for
  Plasma Wave. S1 is a hard cost gate on all three machines before any
  product code. S9 proves zero cost when off with an A/B against
  `origin/main`. Licence: the creator gave permission. D2–D6 answered.
  **MERGED** 2026-10-24 as #779 `2b6114e0`; shipped in 0.9.149 (macOS) and
  0.9.150 (all three). Every slice is built (S4 Windows and S5 Linux on
  Opus, never run on their platforms). The gates found and fixed a contract
  bug that retired main's present pump whenever a live background showed.
  The macOS stream leg drew the poster: fixed by plan 193. Owed: a
  quiet-host smoke run, the Windows and ogre checks, S1 cost on both, owner
  by-eye in both themes.

- 2026-10-24: [Plan 191](191-performance-pass.md), Performance pass. The
  owner asked for an inspection of leaks and waste that changes no feature,
  and then for one PR per confirmed problem. Seven read-only subsystem audits,
  each finding re-checked at its line by the orchestrator, with measurements
  on copies of the owner's real profile: a 2 GB Chromium cache of stale
  backend 404s, a Library page that scanned its whole history (111–144 ms →
  6 ms), rollback-journal writes (2.3 → ~0.3 ms in WAL), a `ps` fork every
  second (~42 ms → ~35 µs per sample) and a 9.5–56 ms per-frame Windows preview
  resize. **MERGED** 2026-10-24 (13 PRs plus #777, squashed; last
  `b9ae4d8b`): one executor and one PR per problem, each reviewed, then
  verified together on a merged tree (smoke:dev,
  probe:comments-window, session-decay A/B against the base, clippy). Three
  findings were closed after measurement showed no worthwhile win (#759,
  #762, and the proof-surface decode, which moved to Part B). Part B holds the
  owner decisions (Clips is on by default, so an idle Studio runs a full
  encode; process-wide renderer un-throttling) and the follow-up slices, which
  need a quiet host or a Windows box. Found on the way: CI's Rust job dies at
  `cargo audit` (RUSTSEC-2026-0386, tokio) on main and every PR; #777 fixed
  that, and the job now times out in its test build instead (N14).

- 2026-10-23: [Plan 189](189-soundboard.md), Soundboard. The owner wants
  a soundboard in Studio on audiocn's sound pads, with the sounds streamers
  use most built in. Sounds join the session audio bus as a third mix
  ingredient after every tap (never in the Microphone ISO file, captions,
  Buddy or the echo guard), placed at the press instant; a session with no
  sound played writes byte-identical PCM. Import decodes, trims and levels
  each sound to -18 LUFS with the bundled FFmpeg; twelve CC0 starters ship
  in the app. Studio plays, Assets → Sounds manages, Sources → Sounds holds
  the level and "Hear sounds yourself" (a main-window Web Audio monitor).
  Phase 2 in the same PR: Stream Manager, `/sound`, ⌘K, Stream Deck and the
  phone. 9 decisions (D1–D9), taken on the recommended defaults because the
  owner asked to execute the whole plan and open a PR. **EXECUTED**
  2026-10-23 (both phases) on `plan-189-soundboard`: every gate and both
  soundboard smokes pass; brand marks moved to files to keep the eager
  bundle under its unchanged ceiling; the owner's by-ear on the starters and
  a live take are owed.

- 2026-10-22: [Plan 187](187-discord-go-live-announcement.md), Discord
  go-live announcement (issue #634). One Discord webhook, free, automatic:
  the first ticked destination confirmed live posts one message sent as the
  streamer (name + avatar), with the title, the thumbnail, a ping (none /
  @here / @everyone) and a link button per live platform. It edits itself
  as more legs join and turns into "Was live · 1h 42m" on Stop. Public only
  (unlisted/private YouTube skipped), a 15-minute restart window never
  pings twice, and crash recovery is included. The backend owns the secret
  and the trigger; the Discord section sits on the Livestream page after
  Stream details. 14 owner decisions (D1–D14), 7 slices. **EXECUTED**
  2026-10-22 (whole plan) on `plan-187-discord-go-live`: gates and
  smoke:discord-announce pass; the test RPC is `discord.webhook.sendTest`
  (`.test` names are admin-only); real-Discord check and owner by-eye owed.

- 2026-10-20: [Plan 186](186-banners-on-the-picture.md), Banners. The
  owner wants their own images (a sponsor strip, "Follow me", a logo, a
  full-frame frame) placed anywhere on the picture, with recommended sizes.
  A banner is an overlay-style layer, not a source: a backend-owned
  `banners` table (alpha kept, 24 in Assets, 4 showing), rects per
  orientation and the overlay leg plan unchanged, prepared off the render
  thread to exact pixels and drawn 1:1 on Metal, CPU, D3D11, the legacy
  FFmpeg FIFO and the proof surface. Assets manages, Scene places and
  shows, with Stream Manager, `/banner`, ⌘K and Stream Deck/phone mirrors;
  sharp sizes plus a per-place "soft at this size" hint. Phase 2: timer
  (sponsor rotation) and Buddy voice. 11 decisions (D1–D11).
  **EXECUTED** 2026-10-21 (whole plan, both phases) in draft PR #728: free,
  one set of banners, the Scene page controls them, stacking as
  recommended; smoke:banners passes on recording, stream and the vertical
  stream; owner by-eye owed.

### Plan 182 Import takeovers while recording or live

- 2026-10-13: [Plan 182](182-import-takeovers-during-recording-and-livestreams.md)
  — implemented in [PR #696](https://github.com/TheOrcDev/videorc/pull/696) (draft).
  Live image import, bounded processing, explicit Studio activation and
  recording/local-RTMP artifacts passed; broader gate blockers are documented.

Generated by the improve skill.

- 2026-10-12: [Plan 181](181-replay-buffer.md), clips: the replay buffer.
  A user on X asked for the gamer workflow and the owner redesigned the
  first build (R1-R4): Videorc keeps the last 30 seconds whenever it is
  open (one switch on the Output page, on by default; the status bar shows
  "Clip · 0:30"), and one action saves them as a clip: the Stream Manager's
  Clip button, the Save a clip key, ⌘K, a deck `clipMark`, `/clip` in the
  streamer's composer, the spoken "clip that" while a session has captions
  or Buddy listening. While recording, the press also keeps the mark in the
  recording. The ring is one more `-f segment` output on the session's
  FFmpeg child (a stream copy behind the encoded bridges, a split plus a
  second encode on the raw paths); a buffer-only session composes like a
  record-only one and writes nothing permanent; Record and Go Live carry the
  ring and the backend hands over inside `session.start`; a software
  encoder path keeps the default off and says why. Clips go to
  `<recordings>/Clips/Clip YYYY-MM-DD HH-MM-SS.mp4` with a Library row.
  **EXECUTED** 2026-10-12 on `plan-181-replay-buffer` (PR #694): S0-S8,
  then the redesign slices RS1-RS5; gates with the ring on by default, the
  idle cost and the owner's by-eye are in the plan's "As built".
- 2026-10-12: [Plan 179](179-live-lab-on-linux.md), the live lab on Linux.
  The plan 178 harness runs on ogre (Omarchy, Hyprland) with the same safety
  guarantees: a Hyprland headless output as the lab display, captured through
  the ScreenCast portal and answered by a lab share picker (no restore token
  is ever reused); a PipeWire remap source as the lab mic; espeak-ng speech;
  `/etc/videorc-lab/policy.json`; a root-owned tc/netem fault helper behind
  four sudoers verbs; a systemd user timer; `live:install` from an AppImage
  (`file:`/`local:`, both candidates). **EXECUTED** offline on
  `feat/live-lab-linux`; every ogre check is owed (SSH key not authorized).
- 2026-10-12: [Plan 178](178-unattended-live-lab.md), the unattended live
  lab. The owner wants Claude to go live and test with nobody present, on a
  dedicated Mac. Merges plan 166 (soak) and plan 176 (attended lab): the lab
  Mac goes live on @VideorcApp on a schedule and on demand (`live:remote`
  over SSH from any session), clicking the real Go Live dialog through CDP,
  so plan 166's remote-Go-Live product setting is dropped. An owner-owned
  `policy.json` the lab user cannot write is the standing authorization
  (limits, visibility, quota, kill switch via `control.json`); candidates are
  Developer-ID signed in CI so the key never sits on the lab Mac and TCC
  grants survive; frame checks on pulled clips replace by-eye steps; reports,
  deduped `live-lab` issues, Discord P0. 16 slices in 3 phases.
  **EXECUTED** 2026-10-12: every code slice built (U0-U13, U15 step 1); the
  lab-machine visit, D1-D3 (machine, lab project In production, viewer
  account), the first unattended runs (U8a, U14) and 14 days of data for
  gates are owed.
- 2026-10-11: [Plan 177](177-activity-reward-rows.md), Activity reward
  rows. The owner wants a background behind channel point redemptions in
  Activity, and the row ⋯ menu is cut off. Cause: Radix ScrollArea's
  `display: table` wrapper lets long rows grow past the pane (Clean cut
  already overrides it). S1 adds a probe check (red first) and the override;
  S2 paints redemption rows `bg-reward/8` from a new `--reward` token (D1;
  alt: the reward's own Twitch colour via Helix). **EXECUTED** 2026-10-11 with
  D1 (a), then D2 (block layout in the shared ScrollArea) and D3 (tips paint
  the paid tint); probe red then green in light and dark; PR #664.

- 2026-10-11: [Plan 176](176-live-youtube-test-lab.md), the live lab.
  The owner made a Videorc YouTube channel for real live tests. Claude goes
  live on it, attended, from the owner's Mac: Videorc captures only a virtual
  lab display showing a test card, the mic is BlackHole fed scripted speech,
  and Go Live is clicked through CDP (`VIDEORC_REMOTE_DEBUG_PORT`). A lab
  Google project (Testing mode, runtime client override) carries every lab
  API call, so shared quota stays at zero: an observer reads broadcast and
  ingest health, a viewer bot chats, yt-dlp clips are analysed for freezes
  and A/V sync. Six suites (first light, OAuth Go Live, chat, on-stream
  features, resilience, long/vertical/scheduled) close the owed live
  acceptances, then a 20-min release suite. Builds plan 166's S1/S3/S6/S7
  first. **L0 BUILT** 2026-10-12 (`live:hookup`, `live:doctor`,
  `docs/live-lab.md`); continued as plan 178 (unattended).
- 2026-10-08: [Plan 166](166-unattended-live-soak-on-youtube.md), Videorc
  tests itself live on YouTube with nobody at the machine (daily soak on a
  dedicated Mac, metrics journal, receiver watch, public reports).
  **SUPERSEDED** by plan 178, which keeps its S1, S3, S6-S10 and drops S2.
- 2026-10-11: [Plan 175](175-instant-captions-gateway-streaming-transcription.md),
  instant live captions. The owner: captions are "3 - 5 seconds late". The
  lag is structural: production runs the 3-second chunked fallback because the
  voice-model realtime path was kill-switched in July (it created assistant
  turns and could not be metered). The gateway now has a transcription-only
  streaming WebSocket (`spacexai/grok-stt` $0.10/h, `openai/gpt-realtime-whisper`
  $1.02/h); the plan moves the desktop transport to its envelope, meters it
  with mint-time leases settled by `finish.durationInSeconds` and reconciled
  against the gateway report API, keeps chunked as the fallback, and starts
  with an owner bake-off (`pnpm probe:caption-stt`). **EXECUTED, in review** on
  `plan-175-streaming-captions` + videorc-web #80 (deploy web first); S1
  bake-off and rollout need the owner's gateway key.
- 2026-10-10: [Plan 174](174-ui-ux-pass.md), the UI/UX pass. A whole-app
  audit (347 findings with evidence in [the register](174-ui-ux-findings.md))
  becomes 53 slices: stop the harm first (11 P0s: a livestream ending on
  one key, Buddy posting or listening without the streamer, unconfirmed
  deletes, dead controls, screen-reader blockers), then shared primitives,
  one vocabulary, every page and window, and guards. Owner calls
  2026-10-10: Buddy stays directly under Studio and keeps Clean cut; a
  click on a live chat row puts it on stream. **EXECUTED** 2026-10-11
  inside #647 (owner call 2026-10-10): all slices landed, the register is
  fully marked (6 partials deferred with reasons), and the owner's by-eye
  pass is owed.
- 2026-10-10: [Plan 173](173-sources-tab-rewrite.md), the Sources tab
  rebuilt. The owner: "everything is just one on another". Video (Screen,
  Camera) now sits beside Audio (Microphone, System audio) at `lg`, the
  Config-grid page `page.tsx` always named, and every source takes one
  shape (`SourceItem`): a header with one status chip and one quick control,
  a body indented to the title, and the rare settings (Sync, the echo guard)
  folded into More. One status vocabulary (a missing device says "Not
  found"), a facts line (screen size, camera format and rate), no dead
  System audio meter, Calibrate in development builds only. Renderer only;
  every probe selector kept. **EXECUTED, in review** on
  `plan-173-sources-rewrite`.
- 2026-10-09: [Plan 172](172-make-buddy-alive.md), Make it Alive for
  real: a headless run of the creator's pipeline makes animated packs for
  the official five (owner review per row; Buddy the Golem bundled, the
  other four downloaded on first use), alive packs sync with the Buddy in
  the account library (presigned uploads to Neon), a pack player animates
  videorc.com, and a real creation plus a stream acceptance close plan 168.
  PLANNED.
- 2026-10-09: [Plan 171](171-golem-becomes-buddy.md), the companion's name
  becomes Buddy everywhere (copy, code, wire names, URLs, the wake word);
  the stone golem stays a golem creature named Buddy; the Buddy library's
  pictures live in a private Neon bucket with their own S3 settings.
- 2026-10-09: [Plan 170](170-golem-library-and-onboarding-on-web-and-app.md),
  one Golem library per Videorc account, shared by videorc.com and the app,
  plus the same four-step onboarding in both (meet your sidekick with a live
  stream demo, describe it with an optional picture, give it a personality
  and an about-you, generate the four still poses into the library). The
  official library (the Golem, then an Orc, a Goblin, a Pirate and a Robot
  in the house look, owner-reviewed) is free; creating your own is Premium
  on the shared daily image allowance. Picking an avatar on either side
  makes it the Golem; the app downloads it. Phase R renames Orcle to Golem
  everywhere first (web pages and URLs with redirects, prompts, docs, code
  names), keeping saved and wire values. EXECUTED 2026-10-09 in #647 and web
  #79; owner review of the official art and live acceptance owed.
- 2026-10-08: [Plan 168](168-living-golem-page-pet-sprites-and-creator.md),
  the Golem comes alive with [page-pet](https://github.com/gvastethecreator/page-pet-skill)
  sprite atlases (25 drawn look directions plus reactions in one
  transparent WebP, manifest v1 unchanged). The backend owns the atlas and
  an animator (viewer-plus-events gaze per leg, reactions from activity,
  talk frames, blink, sleep, page-pet's motion ported without GSAP) and
  draws one affine sprite quad on CPU, Metal and D3D11. Premium users
  create their own pet in an in-app creator (web generates 9 sheets,
  the desktop cuts, registers and packs them in Rust, the user reviews
  every row); anyone imports page-pet packs; our default Golem is made with
  the creator. Phase 0 first fixes the Golem settings padding (an
  overridden shadcn `data-slot` hid the card's row padding). Eight phases, built in the plan 164 PRs (#647, #75).
  **EXECUTED, in review** inside #647 and web #75 (owner call 2026-10-08).
  Owed: the web deploy with its migration and the two model env vars, the
  S-E1 cost probe, one real creation, the owner's frame review that makes
  our default Golem pack (Phase G), a by-eye pass on the Stream Manager
  header, and the D3D11 path's first Windows CI run.

- 2026-10-08: [Plan 167](167-x-partner-kit-mark-and-verified-checks.md), X's
  partner icon kit. The official X mark replaces three home-made drawings
  (a Phosphor glyph in the app, a stroked "x" on the stream highlight card, a
  letter on the phone remote), and X's Premium/Business/Government checks show
  beside verified X chat authors. The web relay already sends `verified_type`;
  the desktop starts keeping it. **EXECUTED, in review** on
  `plan-167-x-partner-kit` (web part on `plan-167-x-kit-web`).

- 2026-10-08: [Plan 164](164-golem-named-companion-avatar-and-auto-chat.md),
  the Orcle tab becomes **Golem**: each user names their own companion,
  gives it a personality and state images, places it on the Live Scene
  canvas with a comic speech bubble instead of a voice, and turns on
  automatic chat from Stream Manager. The highlight card, captions and the
  Golem all get a free rect per orientation plus "Show on stream" and "Show
  in recording" switches. **EXECUTED, in review** on `plan-164-golem-b`;
  the owner's by-eye acceptance and the live Suggest-then-Auto pass stay
  owed. Docs: `docs/golem.md`, `docs/overlays.md`.
  - Phase A (tab, persona, avatar images): the tab and every line of copy
    say Golem; `cohostSettings.persona` and `autoChat` on the wire with
    Rust validation; uploads through main into `userData/golem-assets`;
    generation as accept + event through the web's `/api/ai/cohost/avatar`;
    the creation screen; wake words are `golem` plus the persona's name,
    with the Orcle spellings as hidden aliases until 0.9.140.
  - Phase B (overlays as placeable per-output items): the backend-owned
    `overlayLayout` store and `overlays.layout.get/set` RPCs with a one-time
    highlight-anchor migration; one `overlay_leg_plan` for captions, the
    highlight card and the Golem, with the D13 fallbacks said in the Go Live
    sheet; rects blitted by one oracle on the CPU, Metal and D3D11 paths;
    three dashed items on the Live Scene canvas with an Orientation toggle,
    an inspector and a Snap menu; captions derive `burnTarget` from the
    switches.
  - Phase C (the Golem on stream): the `golem_overlay` state machine, slot
    and `cohost.golem.say`; the renderer rasterizes the avatar and its
    bubble per output canvas; the three paths blit it under the highlight
    card; the Stream Manager's Golem pane header and Say box. The item
    ships with both switches off (opt-in). The owner's stone golem is the
    emblem and the default avatar.
  - Phase D (automatic chat): the greeting engine with user-written
    templates and no model; the throttle and the send path with a
    Golem-owned `operationId`; answers on tick v4 only when the web says
    so; banter on dead air, default off; the greetings editor on the Chat
    tab; the chat mode (Off, Suggest, Auto) and consent in Stream Manager.
    Every message posts as the streamer's own account.
  - Phase E (docs, gates): `docs/golem.md` rewritten, `docs/overlays.md`
    new, the Cloud AI consent names avatar images and chat replies as you.
- 2026-10-08: [Plan 165](165-youtube-tos-report-official-icon.md), the reply
  to Google's YouTube API ToS Violations Report V.1. The one violation
  (III.F.2a) is fixed by showing the official YouTube icon, converted
  losslessly from the brand-site file, at 20px or taller on every desktop
  surface, including the flagged Stream Manager chat, activity and status bar
  and the YouTube / YouTube Vertical destination rows. The two confirmations
  (III.D.1c project numbers, III.E.4 refresh/delete cadence) get written
  answers, with no code. The owner scoped it to what the report names: no
  retention or deletion work. **EXECUTED, in review** on `plan-165-youtube-tos`.

- 2026-10-08: [Plan 163](163-channel-points-name-and-auto-show-redemptions.md),
  redemptions say the channel's own points name ("500 Orc Gold", "1,500
  Diamonds") and auto-show when the Activity switch is on. Helix has no field
  for the name; it is read once per stream from Twitch's own GQL, with only
  the public channel id, and falls back to "points" on any failure.
  **EXECUTED, in review** on `plan-163-channel-points-name`.

- 2026-10-07: [Plan 161](161-dead-stream-destination-reported-and-reconnected.md),
  a stream destination whose ingest closes mid-stream is reconnected and
  reported. **MERGED** via PR #637 (`fix/161-dead-stream-leg`); the owner's
  pull-the-cable acceptance stays owed.
  - Incident 2026-10-07: YouTube closed the RTMP connection eight minutes in;
    FFmpeg's fifo did not retry the EOF and the app stayed "On air".
  - Legs reconnect after any error on a keyframe; FFmpeg's per-leg reconnects
    and deaths are attributed exactly (`-loglevel level+info`).
  - YouTube (stream status) and Twitch (viewer poll) say when they stop
    receiving; the Streaming tab, cards, Stream Manager and toasts show it.
  - New `pnpm smoke:stream-leg-eof`.

- 2026-10-07: [Plan 162](162-twitch-bits-power-ups-and-channel-points-in-activity.md),
  Twitch Power-ups and channel point redemptions in Activity. Bits and a
  redemption on the 10-07 stream never reached Activity: Videorc subscribed
  only to chat EventSub types, and a Celebration or a redemption posts no chat
  cheer. **EXECUTED, in review** on `plan-162-twitch-bits-points`; owner
  acceptance on a live Twitch stream (S7) stays with the owner.
  - Optional `bits:read` + `channel:read:redemptions`; `channel.bits.use` and
    both redemption subscriptions, best-effort (a refusal never costs chat).
  - Activity-only rows: Power-ups under Tips (counted as bits), redemptions
    under a new Rewards chip (never summed); a reconnect hint in Activity.

### PR 632 separate-source recording review fixes

- 2026-10-07: [Plan 158](158-harden-separate-source-recordings.md)
  addresses all eight review findings on `b9ee699c`. **IN PROGRESS** with
  owner authorization to implement and push to PR #632. Execution order:
  deterministic tests, startup ownership, per-role failures, durable recovery,
  shared timeline, audio offsets, source removal, metadata, production smokes
  and final acceptance. The plan records dependencies and verification gates.
  The first three fix commits are pushed, latest `366721f0`. A reviewed
  corrective follow-up drains the exact PCM Stop boundary, seeds explicit
  Windows fixture selection authority and tests FIFO timing deterministically.
  Compile-check, strict Clippy and formatting pass. Full Rust remains in progress
  under an owned supervisor. The follow-up uses CI verification in parallel,
  with all acceptance gates retained. Focused native-latency 30/60 fps recordings
  and real crash/restart recovery pass. The follow-up passes all 19
  lifecycle cases and final full Rust, including the late-start rollback
  regression. The final collected runtime fails six recording cases and the
  Stop→Idle latency gate; corrections and app/device gates remain in progress.
  Three simultaneous 4K30 outputs
  remain blocked by measured M4 hardware throughput. Windows source/audio
  stability passed on `35b6f71d`; the corrective head still needs the Windows
  25×/3× gates and macOS full suite. The preceding head failed its Windows
  selection-authority fixture and a macOS FIFO wall-scheduler test.
  The latest runtime also overlaps the owner's active installed-app media
  session, so quiet-host performance qualification remains required.

- 2026-10-06: [Plan 157](157-separate-source-recordings.md), optional separate
  source recordings: one Record session also writes a Screen file (system
  audio) and a Camera file (microphone) beside the Combined file, for free
  editing later. **EXECUTED, in review** on `feat/separate-source-recordings`;
  the packaged-app camera take and `pnpm smoke:separate-source-take` on it
  stay with the owner (the dev app has no camera TCC grant).
  - Recording tab → Output → "Separate source recordings" switch, off by
    default, locked while live, with the exact reason when the scene lacks a
    camera or a screen/window. Free, no Premium gate.
  - Preview, Combined recording and every stream stay composed exactly as
    today; the ISO legs are extra compositor outputs on the same capture
    graph (recording canvas, fit/contain, no bubble/chroma/background), each
    with its own VideoToolbox bridge and MKV muxer fed by a mic or system tap
    off the audio bus.
  - Library lists the three files as one take (`takeId`, role badge); each
    ISO row runs the ordinary MKV → MP4 finalization. Refusals are explicit
    (no encoder bridge, record off, `keepCombined: false`, missing source).

- 2026-10-06: [Plan 156](156-auto-show-activity-on-stream.md), one switch
  that auto-shows Activity events (follows, subs, memberships, gifts, tips,
  raids, streaks) on stream through the existing highlight card. **EXECUTED,
  in review** on `cursor/auto-highlight-activity-46eb` (PR #626); the macOS
  probe/smoke runs and the by-eye check stay with the owner.
  - The switch lives in the Activity pane header, is owned by Electron main
    (persists like the highlight corner, default OFF), and works with the
    Stream Manager window closed.
  - Manual and Orcle cards always win: auto fires only into an idle slot,
    never un-pins, queues at most 3 pending and drops events older than 30 s.
  - Announcements, destination health rows and unnamed follower counts never
    auto-appear on stream.
  - Renderer-only: no backend change; the 10 s TTL and corner pick apply as-is.

- 2026-10-05: [Plan 155](155-giphy-gifs-in-stream-manager.md), Twitch GIF
  Keyboard GIFs (GIPHY) in the Stream Manager. **EXECUTED, in review** on
  `cursor/giphy-gifs-stream-manager-4f7e` (PR #622); the real-payload host
  check (S0), the privacy paragraph and live acceptance stay with the owner.
  - A GIF is its own fixed-height block under the viewer's words, through
    main's allowlisted cache; Twitch's URL is used unmodified but gated.
  - Settings → General → "GIFs in Twitch chat": Animated, Still or Off.
  - Orcle hears `sent a GIF: <title>`; the highlight card names the title.

- 2026-10-05: [Plan 154](154-member-row-tint.md), member and subscriber rows
  get a quiet tint in the Stream Manager chat. **EXECUTED, in review** on
  `cursor/member-row-tint-plan-bc7b` (PR #618).
  - One `--member` token (muted violet), one `bg-member/8` row fill, no ring.
  - One tint per row: member, then Orcle's pull-up, then paid; on-stream rows
    keep their button fill.
  - No backend change: every provider already normalizes membership to the
    `member` role.
  - Owed: `pnpm probe:comments-window` and the by-eye check in both themes on
    a macOS host (the agent environment is headless Linux).

- 2026-10-05: [Plan 153](153-youtube-4k-startup-split-quality-and-mp4-finalization.md),
  YouTube profile/latency preparation, HD streaming beside 4K recording, and
  visible MP4 completion. Implemented on `fix/152-stream-quality-finalization`;
  [acceptance evidence](../docs/acceptance/2026-10-05-stream-quality-finalization.md)
  records completed gates and remaining provider/device acceptance.

- 2026-10-05: [Plan 152](152-named-recording-markers-and-chat-commands.md),
  named points on recording and livestream timelines. Implemented on
  `feat/named-session-markers`; locally verified, with CI and merge tracked in PR #611.
  - `/marker [title]` in Stream Manager, including recordings without chat.
  - “Orcle, make a marker here for [title]” with authorized listening.
  - Library markers, original-video seeking, rename, delete and creation Undo.

- 2026-10-05: [Plan 151](151-watch-streaks-and-chat-links.md), Twitch watch
  streaks in Activity, and chat links you can open or copy. **EXECUTED, in
  review** on `feat/151-watch-streaks-chat-links`.
  - Streaks get their own chip and keep the viewer's words.
  - Right-clicking a link offers Open link and Copy link, through a new
    narrow `chat:open-link` IPC.
- 2026-10-04: [Plan 150](150-orcle-tab-in-tabs.md), the Orcle tab reorganized
  into tabs like Settings. **EXECUTED, in review** on `feat/150-orcle-tab-tabs`.
  - It has five tabs: Live, Chat, Voice, Reports and Clean cut.
  - Customize is gone, and every setting has one home.
  - The emblem sits beside Orcle Live's switch.
  - Locked means disabled, with one reason.
  - Orcle's behaviour is unchanged.

- 2026-10-04: [Plan 149](149-orcle-eye-emblem.md), the Orcle eye, Orcle's
  official mark. **EXECUTED, in review** on `feat/149-orcle-eye-emblem`
  (desktop and web PRs).
  - The full-colour emblem leads the Orcle tab and the Orcle Live consent
    dialog, at 32 or 56 px.
  - The real emblem image replaces plan 119's orc head as `OrcleIcon`
    everywhere else (the owner's call: the real image, not a glyph).
  - The web `/orcle` page and its social cards lead with the emblem.
  - Still owed by the owner: the rights to the image, and a by-eye check.

- 2026-10-04: [Plan 140](140-orcle-voice-commands-highlight-and-remove.md),
  Orcle voice commands. **EXECUTED, in review** on
  `feat/140-orcle-voice-commands` (desktop and web PRs).
  - Commands: "Orcle, highlight the comment from coders X", and "This one is
    toxic, remove it from our chat", which asks to confirm first.
  - Removal works on YouTube, Twitch, Kick and X, with a local hide when the
    platform can't remove a message.
  - Moderation is audited, and a remote kill switch can turn it off.
  - The Premium backend gaps are fixed.
  - The web `/orcle` docs gain "Talk to Orcle".
- 2026-10-03: [Plan 119](119-orcle-tab-orcle-live-and-clean-cut.md), the
  Orcle tab. It replaces Publish completely. **MERGED** (#579 `462cb480`, web #69 `ef0df149`); built on
  `feat/119-orcle-tab` (desktop) and `feat/119-orcle-clean-cut` (web). P1, XL,
  21 slices in 4 phases. Orcle sits directly under Studio.
  - Orcle Live: the existing live co-host, with one switch, consent and
    settings in the tab, and a report saved after every stream. "Clip that"
    marks live there too.
  - Publish: all code, copy and RPCs are deleted, while old desktops keep
    working against the web.
  - Clean cut: after Stop, an edited copy with silences, "um"s, false starts
    and retakes removed.
  - Condensed: a long stream cut down to about 15 minutes.
  - Still owed by the owner: S0 calibration, acceptance A1–A3 and the provider
    key.

### In-app QA sweep (2026-10-03)

The initial audit tested release 0.9.129 at `05ff9188` alongside the installed
macOS app. See [the QA ledger](qa-2026-10-03.md) for those original findings.
All 15 original fixes are implemented, with separately reviewed follow-ups.
[The fix ledger](qa-fixes-2026-10-03.md) tracks current verification and every retained failure.
The resumed recording repairs are merged in PRs 600/602/603 (main `08b600cb`).
The complete unchanged profile matrix passes 18/18, the original five latency cycles pass,
and current local/macOS CI Rust passes 3,080 tests / 13 ignored. All 1,935 Node cases pass.

Current studio/device verification passes its synthetic/native-preview prefix, then stops
before real-screen artifact qualification because the Mac lock screen covers its motion
stimulus. The operator has been asked to unlock. The complete local bundle previously
stopped at a separate display-off/no-display prerequisite; no complete aggregate pass
is claimed. Thirteen independent gates pass, including the final backend-recycle check.
The original 60-minute native-preview soak passes with 1,797 samples, zero degraded samples and no surface growth; owned release
counts return to zero. The original 15-minute hard-content recording gate also passes:
900.066 seconds, 27,002 distinct frames, 30 fps, 56 ms A/V tail and 450/450 runtime samples.

The reviewed queue-fix Windows source cohort passes actual 25/3 stability and audits.
The startup PR cohort fails three unchanged audio tests on repetition 22; the reader-cleanup
PR cohort fails one unchanged audio test on repetition 16. A subsequent automatic run on
identical merged-main source completes actual 25/3 and all source/audit gates; both audio
failures remain unattributed. Windows incident recording/receiver artifacts remain failed,
including the new main cohort, with verified executable/build-manifest provenance.
Original OBS, glass,
preview, camera, audio and shared-stop causes, physical Windows and remaining capability
checks keep final acceptance open. The original checkout and unrelated plans are preserved.

| Plan                                                                    | Fix                                                                      | Priority | Depends on                          | Status                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [098](098-apply-orcle-consent-changes-during-sessions.md)               | Apply active Orcle consent changes                                       | P1       | —                                   | IMPLEMENTED `9e015cb1` / PR 546; 317 focused tests; final E2E pending                                                                                                                                                                                                                                                                                                                                 |
| [111](111-cancel-detached-phone-stop-gestures.md)                       | Cancel retired Phone remote stop gestures                                | P1       | —                                   | IMPLEMENTED `5a81d166` / PR 545; 44 focused tests; final E2E and physical pointer verification pending                                                                                                                                                                                                                                                                                                |
| [102](102-bootstrap-idle-microphone-meter-fallback.md)                  | Bootstrap idle microphone analyser demand                                | P1       | —                                   | IMPLEMENTED `1a69b9d6` / PR 547; 104 focused tests; final E2E pending                                                                                                                                                                                                                                                                                                                                 |
| [104](104-refresh-source-reconciliation-smoke-contract.md)              | Repair source smoke's Camera Off fixture                                 | P1       | —                                   | IMPLEMENTED `9ba10371` / PR 548; CLI smoke and120 focused tests pass; current local aggregate Sources stage PASS                                                                                                                                                                                                                                                                                      |
| [105](105-make-scene-preset-smoke-state-cloneable.md)                   | Make scene smoke diagnostic state cloneable                              | P1       | —                                   | IMPLEMENTED `59a0cf0f` / PR 549; 140 focused tests; final E2E pending                                                                                                                                                                                                                                                                                                                                 |
| [106](106-diagnose-source-loss-audio-in-stream-artifacts.md)            | Diagnose source-loss audio in stream artifact                            | P1       | —                                   | IMPLEMENTED; PR 560; all source-switch modes and three fresh stream legs PASS; broader recording/A/V gates pending; Shadscan 37                                                                                                                                                                                                                                                                       |
| [107](107-diagnose-floating-preview-input-latency.md)                   | Diagnose floating native-preview input latency                           | P1       | —                                   | CAMERA FIX merged PR564; three post-fix native stress PASS unchanged100ms; current complete36-stage recording/device PASS; original samples retained                                                                                                                                                                                                                                                  |
| [110](110-reject-obstructed-glass-probe-evidence.md)                    | Reject system-dialog-obstructed glass evidence                           | P1       | —                                   | IMPLEMENTED `d91a7cb7` / PR 551; latest full bundle correctly INVALID at first glass sample due other-app overlap; zero scored rows; clean visual E2E pending                                                                                                                                                                                                                                         |
| [109](109-diagnose-live-layout-intent-buttons.md)                       | Diagnose live layout buttons blocking latest intent                      | P1       | —                                   | IMPLEMENTED PR553; three physical preview stress runs and current36-stage recording/device PASS; full local bundle pending                                                                                                                                                                                                                                                                            |
| [108](108-repair-obs-import-smoke-and-owned-teardown.md)                | Repair OBS import smoke and owned teardown                               | P1       | —                                   | IMPLEMENTED `205a6f5e` / PR 550; 47 Node + 43 OBS desktop tests; three current real-IPC runs FAIL at obsRead; private storage-boundary trace lacks complete owner proof; diagnosis open                                                                                                                                                                                                               |
| [101](101-restore-camera-off-in-saved-scenes.md)                        | Preserve saved Camera Off                                                | P1       | —                                   | IMPLEMENTED `43716ab3` / PR 552; 263 focused tests; final E2E pending                                                                                                                                                                                                                                                                                                                                 |
| [103](103-persist-source-visibility-in-scene-snapshots.md)              | Preserve saved source visibility                                         | P1       | —                                   | IMPLEMENTED PR554; current three full scene trials: one PASS including final camera artifacts, two hide timeouts; Plan133 cause open                                                                                                                                                                                                                                                                  |
| [097](097-scope-voice-clip-marks-to-recordings.md)                      | Scope clip matcher/dedupe to recording                                   | P1       | —                                   | IMPLEMENTED PR558; one current synthetic-native A-manual/B-voice diagnostic PASS with original caption/artifact checks and B dedupe; 11knownPIDs/two groups absent; full bundle still pending                                                                                                                                                                                                         |
| [099](099-count-new-chat-during-buffer-rollover.md)                     | Count unread chat beyond buffer rollover                                 | P1       | —                                   | IMPLEMENTED `d5729943` / PR 555; 272 root focused tests; current strict fake-provider and Comments-window PASS; complete bundle pending                                                                                                                                                                                                                                                               |
| [114](114-sync-source-visibility-protocol-fixture.md)                   | Synchronize source visibility protocol fixture                           | P1       | 103                                 | IMPLEMENTED `fef7bc40` / PR 556; focused and predecessor full logic gates pass; final app acceptance pending                                                                                                                                                                                                                                                                                          |
| [100](100-preserve-whole-session-stream-manager-totals.md)              | Keep durable session support/chat totals                                 | P1       | —                                   | IMPLEMENTED `bd85a1ef` / PR 557; 539 independent focused cases; current strict totals/rollover/finished-History and Comments-window PASS; complete bundle pending                                                                                                                                                                                                                                     |
| [115](115-fix-durable-chat-tip-sort-clippy.md)                          | Restore durable totals strict Rust lint                                  | P1       | 100                                 | IMPLEMENTED; PR 559; 12 root tests and strict local 1.98 Clippy; fresh macOS/Linux 1.99 gates pass; Shadscan 37                                                                                                                                                                                                                                                                                       |
| [113](113-restore-renderer-initial-asset-budget.md)                     | Restore initial renderer asset budget                                    | P1       | Remaining 097–111 implementations   | IMPLEMENTED; PR 562; unchanged asset limits, fresh build and full JS gates pass; final E2E pending                                                                                                                                                                                                                                                                                                    |
| [116](116-preserve-rollover-coverage-with-bounded-activity-fixtures.md) | Stabilize follow rollover integration fixture without weakening coverage | P1       | 099, 100, 113                       | IMPLEMENTED; PR 563; full desktop 2,808 pass / 1 existing skip and JS CI green; exact rollover/Activity identities preserved; final app acceptance pending                                                                                                                                                                                                                                            |
| [117](117-diagnose-preview-lifecycle-main-window-readiness.md)          | Diagnose main-window loss during preview lifecycle                       | P1       | Final 107 verification              | Diagnostics merged PR565; three instrumented100-cycle passes; original intermittent cause open                                                                                                                                                                                                                                                                                                        |
| [118](118-diagnose-listen-only-caption-contract-upload.md)              | Restore caption fixture sample clock                                     | P1       | Final recording-studio verification | FIX merged PR566; HTTP/listen-only/current36-stage device batch PASS; both Windows fixture cases each28PASS; whole-job audits tracked in124                                                                                                                                                                                                                                                           |
| [120](120-restore-detached-comments-probe-command-contract.md)          | Restore detached Comments probe command contract                         | P1       | Final recording-studio verification | FIX merged PR567; root118 desktop/10Node pass; unchanged app probe PASS in complete36-stage device batch                                                                                                                                                                                                                                                                                              |
| [121](121-diagnose-native-preview-scene-update-budget.md)               | Diagnose native scene-update budget failure                              | P1       | Final recording-studio verification | Five current-main trials PASS unchanged limits; original50.2ms cause open                                                                                                                                                                                                                                                                                                                             |
| [122](122-diagnose-blocked-worker-live-control-deadline-test.md)        | Enforce original mutation deadlines                                      | P1       | Final source verification           | FIX merged PR568; root13/neighbor24/fullRust2993pass; modern macOS/Linux and later Windows25/3 PASS; earlier audio failures retained in126                                                                                                                                                                                                                                                            |
| [123](123-update-deadline-production-wiring-contract-check.md)          | Update deadline production wiring contract check                         | P1       | Final script verification           | TEST FIX merged PR569; root9/fullNode1824 pass; complete36-stage device batch PASS; production unchanged                                                                                                                                                                                                                                                                                              |
| [124](124-allow-windows-source-gates-to-finish-required-audits.md)      | Allow Windows source gate audits to finish                               | P1       | Final source verification           | CI FIX merged PR570; actual Windows job111330354018 SUCCESS, all25/3 passes and audits; later source slices remain separate                                                                                                                                                                                                                                                                           |
| [125](125-diagnose-fake-provider-activity-accounting-contract.md)       | Repair fake-provider activity comparison                                 | P1       | Final local verification            | FIX merged PR571/main8dd2aa9d; correct RPC rejected solely by JSON property order; rootNode20/Rust14/strictClippy and Windows25/3/audits PASS; distinct readiness138 merged; current complete fake-provider app PASS, bundle INVALID at glass                                                                                                                                                         |
| [126](126-diagnose-windows-audio-mixer-stability-failures.md)           | Diagnose Windows audio mixer stability failures                          | P1       | Final Windows verification          | Observation-only repair merged PR573; earlier actual25/3 PASS retained; PR602 audio pass22/PR603 before-stall PCM pass16 FAIL retained; automatic identical main source actual25/3 PASS; no attributed audio repair, cause OPEN                                                                                                                                                                       |
| [112](112-diagnose-windows-incident-artifact-failures.md)               | Diagnose Windows CI artifact freezes and stop tails                      | P1       | —                                   | Four hash-joined cohorts FAIL; latest main controlled42/48/tone21/48, worst7633ms freeze/10742ms quiet; component49/50 after prior50/50 control; cause/physical Windows OPEN                                                                                                                                                                                                                          |
| [127](127-fix-legacy-oauth-smoke-startup-ownership.md)                  | Share OAuth smoke build/startup ownership                                | P1       | Final local verification            | FIX merged PR574/mainc51f9e5f; actual callers RED8/4 controls, final GREEN44; unchanged OAuth assertions/90-second limit; actual Windows25/3/all audits PASS including12newOAuthcases×25; latest actual OAuth/OAuthguardsPASS, whole bundleFAIL135                                                                                                                                                    |
| [128](128-diagnose-orcle-consent-smoke-caption-audio-startup.md)        | Repair Orcle consent caption-audio startup                               | P1       | Final feature verification          | FIX merged PR576/main60de246a; debug RPC switch and independent-caption start order; focused22PASS and actual maintained five-second audio gate PASS; next discrepancy129                                                                                                                                                                                                                             |
| [129](129-diagnose-orcle-consent-caption-final-event.md)                | Repair repeated caption fixture capture resets                           | P1       | Final feature verification          | DEBUG FIX merged PR577/main180b509c; root7/192 unique Rust/22 Node, strictClippy/fmt, Shadscan37; original full-smoke timing unproven; complete cohost/fresh36studio PASS; all7Rustfixturecases25times and fullWindows3 PASS on byte-identical current Rusttree; latest131all7pump Node cases×25/raw/fullWindows3/audits PASS                                                                         |
| [130](130-diagnose-orcle-consent-caption-socket-retirement.md)          | Diagnose held-consent caption socket retirement                          | P1       | Final feature verification          | FIX merged PR578/main1e8cb13f; focused25/root9/actualbackend preserves284context/twofinals; complete cohost/fresh36-stage device PASS; actualWindows all9fake-provider cases×25/three full suites/audits PASS; latest131pump separate                                                                                                                                                                 |
| [131](131-diagnose-spotlight-short-caption-final.md)                    | Diagnose missing short Spotlight breaker final                           | P1       | Final feature verification          | FIX merged946f6fee/PR581/main7f345759: confirmed stream uses native PCM clock, idle tap unchanged; same-body RED2fail/5controls→GREEN7, focused32PASS, actual stream/idle all3finals PASS after exact cleanup; complete unchanged cohost53321 PASS; fresh36-stage studio/device PASS; latestWindows all7pump/9fake/12OAuthcases×25,26Rustfilters×25/full3/audits rawPASS; remaining app gates pending |
| [132](132-diagnose-cohost-stream-startup-audio-stall.md)                | Diagnose stream-startup audio loss notice                                | P2       | Final feature verification          | INVESTIGATED: zero-only pre-injection fixture loss triggers existing Plan076 notice; complete cohost PASS; no supported new correction, encoded artifact absent and stall cause unassigned                                                                                                                                                                                                            |
| [133](133-diagnose-scene-camera-visibility-toggle.md)                   | Diagnose camera visibility UI timeout                                    | P1       | Final scene verification            | Four original timeouts retained; current three full trials: one PASS incl 52 visible/175 hidden frames, two hide timeouts; cause open; DOM-model diagnostic separate                                                                                                                                                                                                                                  |
| [134](134-dispose-losing-record-latency-waits.md)                       | Dispose record-latency smoke wait owners                                 | P2       | Full local verification             | ActualRED2fail/6controls then GREEN19/fullNode1879; owner repair merged326b988/PR585/maincacc3c7e/Shad37; current original5artifact enforcement PASS, exact controller exit unmeasured; Windowsraw pending                                                                                                                                                                                            |
| [135](135-diagnose-live-system-audio-toggle-dropout.md)                 | Diagnose live system-audio dropout                                       | P1       | Full local verification             | Original full bundle FAIL; three original six-case controls18/18 and current bundle6/6PASS; original stereo quiet gap/in-phase/continuous AAC confirmed; cause OPEN, later gates/full soaks pending                                                                                                                                                                                                   |
| [136](136-renew-scene-recording-output-capability.md)                   | Renew scene recording output authority                                   | P2       | Final scene verification            | SOURCE FIX mergedb2c985b/PR586/main37f49f45; exactRust1/static/Shad37PASS; full original run proves both final camera artifacts; current133 intermittent timeouts remain distinct                                                                                                                                                                                                                     |
| [137](137-clean-up-shared-remote-client-waits.md)                       | Dispose failed shared request/event owners                               | P2       | 134                                 | SOURCE FIX merged27d2942d/PR587/main6dbabec1; RED5/2 then root26/fullNode1886/static/Shad37PASS; real latency/remote-control/LAN PASS; actual Windows shared-client7/latency19 each25 and fullRust3 PASS, root raw verified; complete bundle pending                                                                                                                                                  |
| [138](138-await-complete-fake-activity-receipts.md)                     | Await complete fake activity receipts                                    | P2       | 125                                 | FIX merged5e875661/PR589/main26b296ad; actualRED6fail/24controls, rootfocused30/fullNode1897/static/Shad37PASS; unchanged app strict totals/rollover PASS; original Windows pass22 recovery failure retained in139; current main all30receipt cases×25/fullRust3 rawPASS; final bundle/soaks pending                                                                                                  |
| [139](139-retain-bounded-source-clock-recovery-evidence.md)             | Retain bounded source-clock recovery evidence                            | P1       | 126                                 | Diagnostic merged PR593; current Windows 26 filters ×25 / full3 and local 49 mixer PASS; earlier recovery/FIFO failures remain unassigned, complete raw evidence retained                                                                                                                                                                                                                             |
| [146](146-bound-legacy-pcm-recording-sync.md)                           | Bound legacy PCM recording synchronization                               | P1       | Final profile matrix                | FIX merged PR600/main2310b6fd; real-command RED→GREEN, full Rust/desktop/Node and actual Windows25/3 PASS; downstream unchanged matrix18/18 PASS; studio/device/full bundle blocked                                                                                                                                                                                                                   |
| [147](147-diagnose-shared-record-stream-stop.md)                        | Diagnose shared record/stream stop failure                               | P1       | Final profile matrix                | Original TERM/KILL/missing artifact retained; three isolated trials6/6 and later complete matrix18/18 PASS; restored original plan body; original cause OPEN                                                                                                                                                                                                                                          |
| [148](148-diagnose-legacy-recording-startup-admission.md)               | Diagnose legacy recording startup admission                              | P1       | 146                                 | FIX PR602 plus test cleanup PR603 merged; explicit pre-exec RED→GREEN, matrix18/18, latency5 and macOS reader25/fullRust PASS; failed PR audio cohorts retained; automatic identical main reader25/fullRust3/source gates PASS; visible-device/full bundle blocked                                                                                                                                    |

Execute privacy, remote gesture, and microphone-demand fixes first, repair
acceptance gates, then close scene
round trips and long-session chat/clip regressions. Plans 099 and 100 are
independent; repairing the visible unread count does not repair session totals.

- 2026-10-02: [Plan 096](096-youtube-quota-efficiency.md), YouTube quota
  efficiency after the merged outage hotfix. **PARTIALLY IMPLEMENTED, in review**
  on `feat/096-youtube-quota-efficiency`: per-attempt request accounting and
  independent statistics polling. Full-plan completion remains **BLOCKED** on
  live streaming protocol/billing evidence and release acceptance; compatible
  ingest reuse is deferred and disabled. See the
  [candidate evidence](../docs/acceptance/2026-10-02-youtube-efficiency.md) for
  exact validation and outstanding gates. Google Cloud daily-quota alerts at
  50% and 80% are enabled. The 1,000,000-unit application is submitted; no quota
  grant is assumed. This plan owns Plan 094's remaining streaming/reuse and
  measurement work. No release or production transport activation occurred.

- 2026-10-02: [Plan 095](095-highlight-card-activity-and-x-host.md), the
  on-stream highlight card, Activity, X Host and the Go Live session pill.
  **EXECUTED, in review** (S1-S5; owner live acceptance owed), P1, M, 5
  slices. The streamer's own X messages carry `owner` (Host) by exact author
  id. Activity shows On stream / Applying / Failed and "Remove from stream",
  with a tab dot for hidden follows, and Orcle's badge lights. Avatars reach
  the card through an `avatars:read` bytes IPC (the `videorc-asset:` fetch
  was cross-origin and silently monogrammed every card). Emotes are laid out
  inline from fragments (static first frame). Go Live (record+stream) reads
  "Streaming" + Rec, and the inspector clock ticks from `startedAt`.
  `smoke:comment-highlight-stream` now requires avatar and emote pixels.
- 2026-10-02: [Plan 094](094-youtube-quota-exhaustion.md), YouTube that
  keeps working for streamers (the shared Data API quota ran out mid-stream).
  **EXECUTING, in review** (S1-S4, S6, S7 desktop half on
  `fix/094-youtube-quota`; S5 and S8 blocked on live probes until the quota
  resets 09:00 CEST 2026-10-03; S0 owner actions, the hotfix release and
  A1-A4 owed). P0, L, 9 slices in 3 waves. One streamer's chat reader polled
  once a second and spent the project's 10,000 units; every user then lost
  YouTube chat, viewers, subscribers, sends, connect and Go Live prep until
  midnight Pacific, with raw Google HTML in a toast storm. Built: one shared
  classifier and breaker that parks every YouTube caller as Waiting with the
  local resume time and resumes on its own after a cheap probe; a 5 s poll
  floor; typed transition errors and a settled Stop so Record is never
  trapped; Go Live offering the stream key while paused; one toast per
  incident with a guard against HTML and JSON; a 2,500-unit per-install daily
  budget that sheds subscribers, thumbnails, viewers, then sends; remote
  service flags read every 30 minutes that fail open; and
  `pnpm smoke:youtube-quota`, a full outage drill against a fake YouTube API.
- 2026-10-02: [Plan 093](093-sources-audio-mixer-on-audiocn-controls.md), the
  Sources Audio mixer on audiocn controls. **EXECUTED, in review** (S1-S4 in
  one PR; S0, audiocn PR #2, merged 2026-10-02 as `d3736de`; Phase P not
  built, D1 = not now). P2, M. Each source is an audiocn channel strip: its state,
  the recorded level, a fader (Gain -24..+24 dB, Level -24..+12 dB), the
  mute toggle or the System audio switch. Sync is an audiocn parameter
  slider with a typed ms field; calibration folds under Calibrate. Not
  adopted, with reasons: pan (no pan in the backend), volume-control (a
  player volume), solo, monitor. Owed: the owner checklist on a packaged
  build.
- 2026-10-02: [Plan 092](092-audiocn-audio-components.md), the audio UI on
  audiocn, the owner's shadcn audio registry. **EXECUTED, in review** (U1 in
  audiocn PR #2; S1-S4 and Phase C in one Videorc PR; Phase B not built,
  D2 = no). P2, M. The Studio mixer is audiocn channel strips: a segmented
  level meter with peak hold, a dB readout and a clip light per source. The
  meter reads what the recording gets (Gain moves it now). During a session
  the backend's own bus levels drive it about 20 times a second, and a Mix
  strip shows the written mix. The session sliver and the mic preview draw
  with audiocn. Settled meters cost no frames. Eager JS is 2.1 KB smaller.
  Not adopted, with reasons: parameter-slider, audio-device-select, the
  blocks, the Web Audio hooks. Owed: owner by-eye on a packaged build, the
  live-mic perf check, D1/D4.
- 2026-10-02: [Plan 091](091-ghostex-glass-in-both-themes.md), Ghostex glass,
  a clean blur under one tint per region, dark and light. **EXECUTED, in
  review** (S0-S4; owner by-eye acceptance and the D8 light-mode decision
  owed), P2, M, 5 slices. The native addon strips Electron's vibrancy view
  to a neutral 60 pt blur, `styles.css` carries Ghostex's covers per region
  with the coats derived from them, the dark base is the OKLCH of `#0D0D0F`,
  and the floats are flat opaque tiers; `probe:ui-glass` gains neutrality,
  nativeClear, ghostexParity and a fixed-tone float check.
- 2026-10-01: [Plan 090](090-weak-windows-pcs-can-go-live.md), weak Windows
  PCs can go live. **EXECUTED, in review.** P1, L. One Windows user (Intel UHD 600) was refused Go Live at any bitrate: default captions made every
  record+stream session ask for two encoders, and his PC has no second one.
  Built: a rejected split shares one encode and Go Live waits for the output
  check; a 30 s deadline and a log line for the check; Intel Quick Sync through
  FFmpeg `h264_qsv` as an opt-in tier between Media Foundation and software
  (the pinned FFmpeg already ships it); a 540p30 floor under the performance
  check; a per-session step-down for CPU-encoded streams. Nothing ran on
  Windows hardware. Owed: the reporter's FFmpeg commands (C0) and a 10 minute
  Quick Sync stream on an Intel PC (C7). Not built: the extra Media Foundation
  probe rung (C8).
- 2026-10-01: [Plan 088](088-windows-go-live-blocked-by-output-check.md),
  the investigation behind Plan 090: the reporter's screenshots and support
  bundle, read against the code. **Superseded by Plan 090**, which executes it.
- 2026-10-01: [Plan 089](089-7tv-emotes-in-stream-manager.md), 7TV emotes
  in the Stream Manager. **EXECUTED, in review** (S1-S4; S5 owner live
  acceptance owed), P2, M, 5 slices. No platform marks 7TV
  emotes: viewers type plain words, so Videorc must find the streamer's 7TV
  set and match words itself. 7TV's v4 GraphQL (probed live) resolves the
  Twitch, Kick and YouTube channel in one request and returns a 1000-emote set
  in ~160 KB. v3 REST is "maintenance mode" and 2.4 MB, and the EventAPI acks
  nothing. Design: one pure Rust step in `try_deliver_messages` turns matching
  words into `emote` fragments (`cdn.7tv.app/emote/<ULID>/2x.webp`, built,
  never taken from the API). It covers Twitch, Kick and YouTube, never X, and
  never blocks chat. A 30 s `updatedAt` poll picks up new emotes. Zero-width
  emotes stack via one optional `zeroWidth` field. Wide emotes stop being
  squashed. Settings → General gets a toggle, default on. No 7TV account
  means no change. Owner decisions D1-D4 (incl. a privacy-page line) have
  recommended defaults.
- 2026-10-01: [Plan 087](087-live-stream-survives-host-overload.md), a live
  stream survives a host stall (the OBS-launch incident). **IMPLEMENTED, in
  review.** P0, L. Opening OBS on an overloaded Mac (load 70, 17 GB swap)
  starved FFmpeg for 2 s; the stream leg killed itself on that, could not
  restart, and `stream-output-failed` was only written at stop. Fix: the
  stream role waits out a stall (fails only after 30 s without progress);
  stream stopped / frozen / resumed are reported when they happen; a stopped
  ScreenCaptureKit stream restarts; live writer threads run at
  user-interactive QoS; a host-overload warning. Owed: device smokes on an
  idle Mac, a load probe, owner acceptance with OBS.
- 2026-10-01: [Plan 085](085-kick-chat-emotes.md), Kick emotes show as
  `[emote:ID:name]` text in the Stream Manager. **EXECUTED**, P2, S, 2
  slices. Kick puts emotes inline in `content`. The relay forwards it
  verbatim, but `kick_chat.rs` copied it into `message_text` with no
  fragments, so the pane never drew an image. Fix: a strict Rust token
  parser that builds emote fragments (`files.kick.com/emotes/<id>/fullsize`,
  already allowlisted) and readable text, applied to chat, Kicks gifts and
  stored rows. Desktop-only; owner live acceptance owed.
- 2026-10-01: [Plan 086](086-x-affiliation-badges.md), X organization
  (affiliation) badges on chat comments. **IMPLEMENTED, in review.** P2, S.
  A viewer's Neon badge never showed: XAA `broadcast.chat` sends
  `author.affiliation`, but the web relay, the desktop parser and the comment
  row all dropped it. Now relayed (https only), persisted
  (`author_affiliation_json`) and shown as a 16 px logo after the name. Owed:
  the owner's live check with an affiliated commenter.
- 2026-10-01: [Plan 083](083-youtube-live-thumbnail.md), YouTube thumbnail in
  Broadcast info for instant Go Live. **IMPLEMENTED, in review.** P2, M, 4 slices. Feasible
  with no new scope: `thumbnails.set` accepts `youtube.force-ssl` and a
  broadcast id as `videoId` (~50 quota units). Scheduled streams already ship
  the picker, managed storage and upload; the instant path never calls them.
  Order: draft field → shared Thumbnail field under Description → background
  upload after prepare with a retry toast (never blocks Go Live) → auto-fit
  images over 2 MB. Owner live acceptance on a Private stream owed; shared
  project quota to be checked before release.
- 2026-10-01: [Plan 082](082-windows-blank-main-window.md), Windows main
  window opens blank on 0.9.124 (one user report). **IMPLEMENTED, in review.**
  P1, M. Reproduced on a GitHub Windows runner: crashing the main renderer
  leaves a title bar over an empty window for ever, unlogged. Fix: bounded
  reload of a dead renderer or failed load, then a native Reload / Quit
  dialog; every renderer exit logged; software rendering never gets the
  transparent Mica window; a paint check drops a blank Mica window to solid
  for that version; `smoke:windows-main-window-recovery` in Windows CI. Owed:
  on-box Windows 11 pass, the Windows alpha, the reporter's confirmation.
- 2026-09-30: [Plan 080](080-owner-ui-fixes-batch.md), six owner fixes from
  screenshots. **IMPLEMENTED** 2026-09-30 on
  `plan/080-studio-live-settings-cleanup` (S1-S7; owner by-eye S8 owed), P1, L. (1) The sidebar update chip says
  "Restart to update" with the version in its tooltip. (2) Livestream
  destination cards drop raw OAuth scopes and the triple status; "Sign in" /
  "Stream key" replace "OAuth" / "Manual RTMP"; Disconnect shrinks. (3) The
  right column becomes "Ready to go live" plus a collapsed "Technical
  details". Its ready count stops ignoring sign-in destinations, and TikTok /
  Instagram stop showing as "Custom". (4) The idle mic preview has failed for
  real Mac mics since 0.9.101: the strict label match never equals Chromium's
  "AirPods Pro (Bluetooth)"-style labels, and every failure blamed
  permission. (5) Inputs gets separate Screen and Camera rows, and Camera
  Off sticks. (6) No heading icons in Settings. Owner decisions D1-D6
  confirmed 2026-09-30.

- 2026-09-29: [Plan 077](077-captions-on-dual-orientation-streams.md), live
  captions on both legs of a dual-orientation stream (owner stream
  2026-09-28: "captions were not working"). **IMPLEMENTED 2026-09-29** on
  `fix/077-captions-simulcast`. A captions-off session pre-armed the bar for
  the aux leg, which with a vertical destination is the vertical leg, and the
  compositor dropped it there. Captions now burn on the horizontal primary
  (so the recording carries them) and, as a portrait bar, on the vertical
  leg. Portrait overlays keep out of the TikTok/Shorts/Reels UI bands and
  caption text sizes off the long edge. Owner acceptance is owed.
  - P1, M. New `smoke:captions-dual-orientation`.

- 2026-09-28: [Plan 076](076-live-system-audio-mic-loss-and-echo.md), two owner
  live streams with System audio (0.9.120). In stream 1, a ~3 s output stall
  (FFmpeg stopped reading the audio FIFO while Kick's player loaded the Mac)
  made the bus drop every buffer ahead-of-cap. After 2 s it **retired the
  healthy mic for the rest of the stream**. Reproduced on main with a stalled
  FIFO reader and no system audio. In stream 2, System audio re-captured the
  owner's own Twitch tab, a 3.16 s loop with a second pass at 6.31 s.
  **IMPLEMENTED 2026-09-29** on `fix/076-live-mic-loss-and-echo`. The new
  `smoke:output-stall` passes on the branch and reproduces the owner's failure
  on main. Owner acceptance on a packaged build and a quiet-machine
  `smoke:system-audio` are owed.
  - P0 A0–A3: a bus-behind drop is not a source fault. A placement loss
    reports and recovers, never retires. Add a stall event and recovery copy.
  - P1 B1–B3: an echo detector (mic voice returning through System audio at
    0.3–30 s), an auto-pause with Resume (on by default, with a switch in
    Sources), and honest helper text. Per-app capture is the follow-up plan 077.

- 2026-09-28: [Plan 075](075-free-4k-live-streaming.md), 4K live streaming
  goes free on every plan — owner decision: streaming costs Videorc nothing to
  serve (encode and upload run on the user's machine, same argument as the
  2026-09-15 free-multistreaming move). Collapses the tiered streaming-quality
  rectangle (Basic 1080p30/6000 → the full 4K/60-ceiling/30,000 kbps), so
  Basic gets YouTube 4K30 and 1080p60; Premium keeps cloud AI, live captions,
  Orcle, Noise Cleanup. **IMPLEMENTED (desktop)** 2026-09-28 on the plan PR:
  one shared streaming ceiling in backend and renderer, no streaming reason
  can read as an upgrade prompt, docs/README/Plan-016 addendum updated. Owed:
  the release-time changelog entry, macOS `smoke:recording-matrix` +
  `smoke:multistream` + the Basic-forced dev-app proof (implemented on a
  headless Linux VM), and the videorc-web W1–W3 copy slices (repo not
  accessible from the implementation environment).
  - P1, M desktop + S web, 6 desktop slices plus 3 videorc-web slices by
    contract (premium/pricing copy, sales-surface audit, release comms). No
    API/token/schema change; true 4K stays YouTube-only exact-profile and
    per-platform caps stay.

- 2026-09-28: [Plan 074](074-comment-highlight-on-dual-orientation-streams.md),
  a highlighted comment said "On stream" but was on no video whenever a
  vertical simulcast leg ran (owner live stream, 0.9.120; broken since 0.9.94).
  **IMPLEMENTED 2026-09-28** on `fix/074-highlight-simulcast`. The leg plan
  sent the card to the aux, which with simulcast is the vertical leg, and the
  compositor never drew it there. The card now burns on the horizontal
  primary and, with its own portrait raster, on the vertical leg; availability
  follows the leg plan. Owner acceptance on a real dual stream is owed.
  - P0. New `dual-orientation-record-stream` smoke scenario checks both legs.

- 2026-09-28: [Plan 073](073-live-account-refresh-toast.md), a refresh during a
  live session toasts "Account maintenance is deferred…" (0.9.120) and throws
  away the whole batch, so Sources → Refresh does nothing while live.
  **IMPLEMENTED 2026-09-28** on `plan/073-live-account-refresh-toast`.

- 2026-09-28: [Plan 072](072-glass-floating-surfaces.md), floating surfaces
  (hover cards, popovers, menus, selects, tooltips, dialogs, toasts) read as
  black slabs on the plan 050 window glass: they all still paint the
  near-opaque `--popover` (dark 0.16 / 92%), and `Command` double-coats it.
  One `glass-float` utility moves 9 primitives onto a raised piece of the
  window glass. **IMPLEMENTED 2026-09-28** on
  `plan/072-glass-floating-surfaces`: an opaque coat one step above the
  measured window tone with the chip edge. CSS `backdrop-filter` no longer
  wedges, but it never reaches the screen on the vibrancy windows. Owner
  by-eye pass and a Windows look are owed.
  - P1, M, 6 slices. `probe:ui-glass --surfaces` (in `smoke:local-gates`)
    gates lift over the window, contrast and bleed. Planned against
    `4d36bd76`.

- 2026-09-28: [Plan 071](071-named-followers-with-avatars.md), Activity names
  each new follower, with their avatar, so the streamer can say "Thank you,
  @name". **IMPLEMENTED 2026-09-28** (PR #491, web #56/#57). The owner's
  "New follower" rows were count-only gains: X was count-only, and Twitch
  lacked the opt-in follow scope. The row also
  never renders `authorAvatarUrl`, and the Kick relay drops `profile_picture`.
  X can name followers through the X Activity API `follow.follow` (inbound)
  event, carried by the existing `broadcast.chat` relay.
  - P1, M-L, 6 slices. S1 row avatar, S2 in-place Twitch "Show who followed",
    S3 Kick avatar (web first), S4 X `follow.follow` over the existing XAA
    relay (web first, gated on S0 auth and tier), S5 `@handle` thanks and
    acceptance.

- 2026-09-28: [Plan 070](070-macos-system-audio-silent-recording.md), a static
  screen silenced the whole recording (0.9.119 incident: a valid AAC track of
  exact zeros). **IMPLEMENTED 2026-09-28** on `fix/070-static-screen-audio`.
  The epoch came from the held screen's old capture time, so every current
  sample was dropped ahead-of-cap. Held content is now current at its
  presentation, while live content keeps its capture time. Placement losses
  are reported as such and reach the quality verdict. Packaged acceptance is
  owed.
  - P0. The regression fails on the release rule. A 10 s-static real display
    passed 3 takes with mic and system audio.

- 2026-09-27: [Plan 069](069-system-audio-on-off.md), System audio on or
  off: the computer's sound in recordings and every stream leg.
  **IMPLEMENTED (macOS) 2026-09-28** on `feat/069-system-audio` (S0 to S7).
  `pnpm smoke:system-audio` passed 3 runs in a row. End-to-end o_sys is within
  gate, so the constant stays 0. Owner acceptance on the packaged app is owed:
  [2026-09-28 checklist](../docs/acceptance/2026-09-28-system-audio.md).
  Windows S8 (S8a producer, S8b session wiring) is in progress on
  `feat/069-windows-system-audio`, its own PR.
  - P1, L+, 9 slices. Default Off. The switch works mid-session.
  - Mixed in the Rust session audio bus (one track). Captions and Orcle stay
    mic-only, and mic-only output stays bit-identical.
  - macOS uses an audio-only ScreenCaptureKit stream, Windows uses WASAPI
    process loopback, and Linux comes later.
  - Supersedes Plan 017. Planned against `5aa38286`.

- 2026-09-27: [Plan 068](068-orcle-listens.md), Orcle listens for the whole
  live stream without captions. **IMPLEMENTED 2026-09-27** on
  `feat/orcle-listens` (desktop) and web `feat/orcle-listens`; owner
  acceptance stream owed. P1, XL across desktop + web, 10 slices. One
  transcription engine with captions and listen intents, silent chunks
  never uploaded, a separate listen allowance; then Clip that
  (voice + manual marks into Publish → Clips), tick v3 (transcript, promises,
  recap, on-topic questions, Kick fix), "Say hi" and dead-air nudges, and the
  post-stream pack running itself with a timed transcript. Planned against
  desktop `b772cb59` and web `af5191c6`.

- 2026-09-27: [Plan 067](067-windows-livestream-startup-failure.md), Windows livestream startup. **PARTIAL**: steps 1–2 merged in #464; independent MF probe and incident matrix tooling implemented in [PR #472](https://github.com/TheOrcDev/videorc/pull/472). The PR tracks final verification. Affected Windows hardware is unavailable; causal reproduction/fix and physical/provider acceptance remain BLOCKED.

- 2026-09-26: [Plan 066](066-fast-resumable-desktop-releases.md), fast,
  agent-operated and resumable desktop releases. **IMPLEMENTED; ROLLOUT PENDING**, P1, L,
  six slices across approval, frozen-source scheduling, caching, durable
  orchestration, publication recovery and production verification. Implementation
  branch: `feat/066-fast-resumable-releases`. Production cutover requires the
  controller readiness gate and the protected-main rehearsals documented in
  the plan; no release is authorized by this implementation entry.

- 2026-09-26: [Plan 066](066-kick-chat-live.md), Kick chat never
  connects, and the Stream Manager should show all of Kick. **PLANNED**
  2026-09-26, P0, M, 7 slices (S0 is owner-only). Root cause from the
  production logs: migration 0015 was never applied, so every relay call
  fails with `relation "kick_chat_bindings" does not exist`. The desktop
  retried a bare 500 as "Reconnecting" for the whole stream and never
  created the Kick event subscriptions. The Kick webhook URL also points at
  a 307 (`videorc.com` → `www`). S0 (apply 0015, www webhook URL) fixes chat
  on 0.9.115 with no release. Then: named relay errors, a migration runner
  and readiness check (S1), honest provider state (S2), relaying all 10
  Kick events (S3, S4: subs, gifted subs, KICKs, rewards, bans), no fake
  zero viewer count (S5), and a live acceptance run (S6).

- 2026-09-26: [Plan 065](065-windows-mic-capture-worker-and-mf-probe.md),
  Windows microphone acquisition and Media Foundation fallback. **PARTIAL**:
  A0–A4 and B1/B2 landed; B0 probe tooling is being implemented under Plan 067.
  Later 0.9.115 evidence still shows worker fallback and Intel E_UNEXPECTED,
  so device flags are not an established complete explanation of the rejection.
  B3/B4 media-policy work remains conditional on the Plan 067 reproduction;
  affected hardware and physical acceptance are unavailable. See both plans
  for the original evidence and the current diagnostic checkpoint.

- 2026-09-26: [Plan 064](064-settings-tabs.md), Settings gets tabs across
  the top. **EXECUTED** 2026-09-26 on `feat/settings-tabs` (owner by-eye
  pending), P2, M, 4 slices, renderer-only. Settings was 11 cards in one
  two-column scroll, and links into Settings could not say where to land.
  The owner picked seven tabs (General · Recording · Permissions · Shortcuts
  · Remote · Orcle · About) in the Livestream-style segmented strip, pinned
  under the toolbar (Settings owns its scroll, like Library). Settings
  reopens on the last tab used (localStorage). `openSettings(tab)` deep links
  cover the update chip, the FFmpeg banner and the shortcut-conflict toast,
  and a ⌘K "Settings" group replaces a search field.

- 2026-09-24: [Plan 058](058-live-scene-canvas.md), the Scene canvas shows
  the real picture. **EXECUTED** 2026-09-25 on `feat/scene-live-editor` (PR
  pending; owner by-eye pending), P1, L, 7 slices, macOS. Owner: see the live
  camera and screen while composing a Freeform scene, and Circle did not
  change from square in Freeform. Diagnosed: `camera_mask` /
  `effectiveCameraMaskShape` apply the bubble shape only on the two inset
  presets and never look at `arrangementMode`, so Freeform entered from any
  other preset stores Circle and draws a rectangle everywhere. Design: the
  docked native preview becomes the Scene canvas (no new pixel transport),
  the docked window passes pointer events to the SVG stage beneath, drags send
  a per-frame editor draft that the compositor applies at its snapshot choke
  point and draws the selection chrome as blended quads, release keeps one
  authoritative commit and the draft drops at that revision. Order: S0 spike
  (pass-through + blended quads) → S1 mask law in Freeform (ships alone) →
  S2 backend draft + chrome → S3 Scene canvas as dock slot → S4 live drafts →
  S5 design pass → S6 gates and owner checklist.

- 2026-09-24: [Plan 059](059-broadcast-info-accordions.md), Broadcast info
  is one form again. **EXECUTED** 2026-09-25 on
  `feat/broadcast-info-accordions`, P1, S-M, 5 slices. A user's recording
  showed four stacked metadata forms on the Livestream page and a YouTube
  title that "did not sync": the per-destination rows always rendered, and a
  custom title stayed visible after the switch was turned off. The owner could
  not reproduce it because their own draft has an empty override list,
  written by the OAuth guards smoke before it isolated its database
  (2026-06-03 to 06-20), and the loader never backfilled. Fix = backfill on
  load and save, per-destination accordions for connected destinations only,
  custom text hidden until chosen, Twitch category and language applied
  without a custom title.

- 2026-09-24: [Plan 057](057-stream-manager-focus.md), the Stream Manager
  puts chat first. **EXECUTED** 2026-09-24 on `feat/stream-manager-focus`
  (PR pending; owner by-eye review pending), P1, M, 6 slices. Owner feedback on plan 055: the stats strip is too tall and
  mostly empty (128 px, every tile stretched to the Health tile), the three
  numbers the owner watches (clock, viewers, health) sit far apart (health is
  last and missing below 640 px), and there are too many words to read on
  stream. Order: S1 one 32 px stats bar with the main three together, S2 chat
  and composer words, S3 activity short lines, S4 status bar, S5 rearrange and
  hide, S6 proof and docs.

- 2026-09-24: [Plan 056](056-session-audio-dropouts.md), microphone dropouts
  since 0.9.103. **IMPLEMENTED** 2026-09-24, P0, M. Every take since PR #389
  logged `N frames dropped` and carried exact-zero holes at the same session
  times (worst on 128-frame-callback mics like the Shure MV7+; not hardware,
  works in OBS). Two #389 changes compounded: FFmpeg's audio input queue went
  1024 → 4 packets, and the new paced session-audio bus capped buffering at 32
  packets / 100 ms and could not ingest while a non-blocking FIFO write spun.
  Fix = time-based bus buffering (1 s) + ingest while blocked + the FFmpeg
  queue restored + a per-reason loss log + a digital-zero analyzer gate.

- 2026-09-24: [Plan 055](055-stream-manager.md), a Stream Manager that
  replaces the Chat window: whole chat, live viewers, followers, supporters,
  tips, an activity feed and stream health across every destination.
  **EXECUTED** on `feat/stream-manager` (PR pending; S13 moderation deferred;
  owner live acceptance pending; drafted as 053 before main took that
  number). P1, L, 14 slices, modelled on Twitch's
  Stream Manager. Evidence: Twitch and
  YouTube already deliver subs, gifts, raids, cheers and Super Chats, but as
  flattened chat rows. Follower counts, follow events and moderation do not
  exist, and two viewer samplers make the total flip when X and Twitch are
  live together. Order: S0 provider facts, then data (viewer aggregator,
  structured event details, audience poller, token refresh), then the
  `LiveDashboardState` relay, then the window (shell, stats strip, chat,
  activity, Orcle), with moderation optional and live acceptance last.

- 2026-09-24: [Plan 054](054-x-viewer-count.md), the live X viewer count in
  the Chat window. **EXECUTED** in the Stream Manager PR (`feat/stream-manager`,
  owner request): the parser now unwraps the documented `data` envelope that
  every X poll in 19 real broadcasts missed, and a poll without a count logs
  its reason once. Its sampler fix is plan 055's viewer aggregator. Owner live
  check pending.

- 2026-09-24: [Plan 053](053-linux-l15-green-on-ogre.md), Linux L1.5 goes
  green on ogre. **IN PROGRESS** on `feat/linux-l15-green`, P0, 5 slices.
  Second ogre run on `a93c49ce`: OpenH264 records in-app and fails the
  matrix only on `color_primaries`/`color_transfer` (libopenh264 writes no
  VUI; the `h264_metadata` bsf the Windows MF copy path already uses is the
  fix); VAAPI on the Intel node fails honestly with encode issue 24 (bisect
  on the box, then a `Compat` arg profile chosen by the probe); the
  single-instance smoke greps for a `Reaping` line the app never writes
  (stale assertion, not a Linux bug); host gate and quarantine work. Order:
  S1 smoke assertion → S2 BT.709 VUI rewrite for the software arms on Linux
  and Windows → S3 probe command logged + standard-then-compat probe → S4
  `complete: true` evidence record and L1.5 marked proven → S5 doc drift.

- 2026-09-24: [Plan 052](052-linux-ogre-test-fixes.md), Linux after the
  ogre test (Omarchy / Hyprland, T2 MacBook Pro). **MERGED** 2026-09-24 as
  PR #400 (`a93c49ce`), P0, 7 slices. ogre re-run the same day: OpenH264
  in-app works, VAAPI@D128 fails honestly, the host gate passes, the
  quarantine holds; follow-ups in Plan 053. Findings: the host crash was
  the tester's standalone VAAPI probe on the amdgpu node, but the app
  re-probes every render node on every session with no pin, no cache and no
  memory of a crash, so it can reproduce the hang; in-app VAAPI recording
  failed on the safe Intel node while the CLI passed because the probe never
  runs the session's real encode args; the software path was never run
  in-app; the Ubuntu-only acceptance gate rejected ogre by design; the
  single-instance smoke most likely fails because the dev backend's identity
  is captured before the rustup cargo proxy execs. Order: S0 owner decisions
  (ogre is the named tester, no AMD blocklist) → S1 render-node safety
  (device pin, crash quarantine, probe once) → S2 honest probe + bridge
  diagnosis on ogre → S3 widen the gate and record the box → S4 Linux
  reaping → S5 honest Linux copy → S6 docs. L2–L6 stay with the vault
  handoff.

- 2026-09-23: [Plan 050](050-real-glass-in-every-window.md), real macOS glass
  and a native look in every window. **IN PROGRESS** on `feat/real-glass`, P1,
  XL, 22 slices. Evidence: real `under-window` vibrancy blurs through in
  Electron 39.8.10 on macOS 26.5.1, including inside the real Videorc window.
  The June "material paints opaque" premise is stale, and the shipped wallpaper
  frost still leaks faint text. Order:
  - Phase 1, `probe:ui-glass` first: real material in all five windows (main,
    Chat, Captions, Notes as a new renderer entry, Preview). Per-window dark
    appearance pin via the addon; the simulation deleted.
  - Phase 2: glass chips for every badge, status pill and key chip, the
    desktop-scale design language v2, pane primitives, the new shell, and
    Studio, with owner sign-off.
  - Phase 3: every screen and floating surface.
  - Phase 4: native feel.
  - Phase 5: Windows 11 Mica.
  - Phase 6: acceptance.

- 2026-09-23: [Plan 048](048-windows-auto-update.md), Windows auto-update for
  installed Alphas. P0. Root cause: Windows has only ever been promoted to pilot
  (13/13 runs), so the public feed every install checks never existed, and the
  404 showed as a quiet "unsupported". S1, S3 and S4 are **IMPLEMENTED**
  (desktop `fix/windows-auto-update` plus web
  `feat/windows-pilot-account-updates`): corrected release notes, signed-in
  installs follow the pilot feed, and honest missing-feed copy. S0 (owner
  waiver for 0.9.101-alpha.1) and S2 (public promotion plus a real Alpha→Alpha
  update on Windows) remain.

- 2026-09-23: [Plan 046](046-change-sources-during-recording-and-streaming.md)
  enables camera, microphone, and screen/window changes during recording and
  streaming. **IN PROGRESS** on `feat/live-source-switching`, based on current
  main `92190364`. Order: session transaction contract, continuous audio bus,
  platform input adapters, shared picker behavior, and artifact/device gates.
  [Draft PR #389](https://github.com/TheOrcDev/videorc/pull/389) contains S1–S3;
  S4–S6 implementation and final device acceptance continue.

- 2026-09-22: [Plan 045](045-schedule-livestream-events.md), YouTube-first
  scheduled livestream events with manual Go Live, is **IMPLEMENTED; final
  acceptance BLOCKED** on `feat/scheduled-livestreams` from `f0b775f98`.
  S1–S5 and the full recording-studio bundle pass. Real-channel macOS/Windows
  acceptance requires Google approval and an authorized test channel; the unchanged
  renderer asset budget also fails on base and branch. [Draft PR #386](https://github.com/TheOrcDev/videorc/pull/386); gates remain intact.

- 2026-09-22: [Plan 044](044-scene-presets-and-studio-usability.md), full visual
  scene presets and Studio usability, is executing on
  `feat/scene-presets-studio-usability` from `7b093ce9a`.
  User confirmed complete visual snapshots and configurable global shortcuts.
  Status: **BLOCKED for final acceptance** (implementation complete; native stress and asset-budget failures documented). Slice order: searchable sources → persistent background
  removal → independent layout framing → saved scenes → global layout shortcuts.
  Saved scenes depend on removal/framing; shortcuts depend on framing. Existing
  incident and release gates remain unchanged.

- 2026-09-22: [Plan 043](043-smooth-freeform-scene-editor.md), smooth Freeform
  Scene manipulation and design consistency. **IMPLEMENTED; native acceptance open**
  on `fix/freeform-editor-continuity`, integrated with `main` at `3b7a3529`.
  Freeform unit, integration, visual, pointer and recording checks passed; draft PR
  pending source-complete native recording CPU fallback investigation. Independent
  of missing-source output and scene-switch animation work; existing release/incident gates remain in force.

- 2026-06-12: Windows port slice audit, planned at `f0b88e5c`.
- 2026-06-13: native media/release/security deep audit, planned at `3d217933`.
- 2026-06-13: launch-readiness/open-core expansion, planned at `0ea3c66c`
  (source worktree had in-progress Plan 006 diagnostics edits; this update only
  created/edited files under `plans/`).
- 2026-07-28: external Windows livestream/OBS comparison, planned at
  `2b675488`; Plans 039 and 040 reconcile the partially landed encoder,
  proof-surface, and performance work in Plans 035, 036, and 038.
- 2026-08-24: macOS 4K screen+camera recording-source decay incident, planned
  at `92f91493`; Plan 041 blocks and partially supersedes Plan 034 until
  permissioned real-device acceptance closes the incident.

Execute in the order below unless dependencies say otherwise. Each executor:
read the plan fully before starting, honor its STOP conditions, and update your
row when done.

## Execution order & status

| Plan | Title                                                                                                                                                                                                                                                                                                               | Priority | Effort | Depends on                                                                                                                                                                   | Status                                                                                                                                                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 001  | Make `pnpm package` work on a Windows box (electron-builder resources, backend path, ffmpeg fetch)                                                                                                                                                                                                                  | P1       | M      | -                                                                                                                                                                            | DONE (2026-06-12; on-box gate is `pnpm package:desktop:windows` when hardware lands)                                                                                                                                                                                                                                           |
| 002  | Fix the two Windows window-chrome bugs (preview window frame, theme-toggle base color)                                                                                                                                                                                                                              | P1       | S      | -                                                                                                                                                                            | DONE (2026-06-12; verify preview drag + theme toggle on the Windows box)                                                                                                                                                                                                                                                       |
| 003  | Pin the new platform seams (fifo.rs, capture_input.rs) with unit tests                                                                                                                                                                                                                                              | P2       | S-M    | -                                                                                                                                                                            | DONE (2026-06-12; 12 tests added)                                                                                                                                                                                                                                                                                              |
| 004  | Bundle the native CAMetalLayer helper and gate packaged preview                                                                                                                                                                                                                                                     | P0       | M      | -                                                                                                                                                                            | DONE (2026-06-13; packaged helper bundled and `pnpm smoke:packaged:native-preview` passes)                                                                                                                                                                                                                                     |
| 005  | Make platform-safe livestreaming use VideoToolbox by default                                                                                                                                                                                                                                                        | P0       | L      | -                                                                                                                                                                            | DONE (2026-06-13; multistream passes; A/V gate blocked locally before encoding by ScreenCaptureKit stream-start timeout)                                                                                                                                                                                                       |
| 006  | Implement true 4K record plus 1080p stream split output                                                                                                                                                                                                                                                             | P0       | L      | 005                                                                                                                                                                          | BLOCKED (2026-06-13; code slices landed, latest gates still block before encoding: detected display is 3024x1964 below 4K, and forced ScreenCaptureKit start times out after 30s)                                                                                                                                              |
| 007  | Characterize Studio and session orchestration before refactoring                                                                                                                                                                                                                                                    | P1       | M      | -                                                                                                                                                                            | DONE (2026-06-13; pure session params, Go Live, native preview present policy helpers and tests landed)                                                                                                                                                                                                                        |
| 008  | Fix dependency advisory failures and add JS/Rust audit gates                                                                                                                                                                                                                                                        | P1       | S-M    | -                                                                                                                                                                            | DONE (2026-06-13; JS prod audit clean after build-only Tailwind tooling moved to dev deps, cargo-audit wired into CI/release)                                                                                                                                                                                                  |
| 009  | Harden stream/OAuth secret storage and legacy key migration                                                                                                                                                                                                                                                         | P1       | M      | -                                                                                                                                                                            | DONE (2026-06-13; explicit json-file backend, legacy stream-key migration, redacted persistence, and credential docs landed)                                                                                                                                                                                                   |
| 010  | Reconcile dead-code allowances and future media modules                                                                                                                                                                                                                                                             | P2       | S-M    | 005, 006                                                                                                                                                                     | IN PROGRESS (2026-06-13; stale streaming comment fixed, staged media allowance registry added; destructive cleanup waits on Plan 006 acceptance)                                                                                                                                                                               |
| 011  | Sandbox the main Electron renderer without breaking preload APIs                                                                                                                                                                                                                                                    | P2       | M      | 004                                                                                                                                                                          | DONE (2026-06-13; main renderer sandboxed, privileged preload work moved to main IPC, dev/OAuth/preview/package smokes passed)                                                                                                                                                                                                 |
| 012  | Validate a signed macOS release candidate on a clean machine                                                                                                                                                                                                                                                        | P0       | L      | 004, 006, 008, 009, 011                                                                                                                                                      | IN PROGRESS (2026-06-13; release preflight, signed-artifact validator, workflow validation, and clean-machine checklist/template landed; clean-machine evidence pending)                                                                                                                                                       |
| 013  | Close OBS parity acceptance with evidence and triage                                                                                                                                                                                                                                                                | P0       | M      | 006                                                                                                                                                                          | IN PROGRESS (2026-06-13; side-by-side harness manifest and acceptance-note template landed; automated gates and human visual evidence pending)                                                                                                                                                                                 |
| 014  | Add guided audio sync calibration and drift gates                                                                                                                                                                                                                                                                   | P1       | M      | 006, 007                                                                                                                                                                     | IN PROGRESS (2026-06-13; JSON recommendation, Sources-tab import/apply/reset flow, and drift classification evidence landed; real long-session gate evidence pending)                                                                                                                                                          |
| 015  | Prove real provider livestreaming end to end                                                                                                                                                                                                                                                                        | P1       | M      | 006, 009, 012                                                                                                                                                                | IN PROGRESS (2026-06-13; provider docs and release-grade readiness evidence landed, release credentials/packaged provider proof pending)                                                                                                                                                                                       |
| 016  | Add the open-core entitlement boundary for premium features                                                                                                                                                                                                                                                         | P1       | M      | 007, 009                                                                                                                                                                     | DONE (2026-06-13; free/premium capability model enforced, renderer wired, premium smokes opt in explicitly)                                                                                                                                                                                                                    |
| 017  | Add native system audio capture and a mixed audio graph                                                                                                                                                                                                                                                             | P1       | L      | 006, 007, 014                                                                                                                                                                | SUPERSEDED by 069                                                                                                                                                                                                                                                                                                              |
| 018  | Add a redacted support bundle and diagnostics export                                                                                                                                                                                                                                                                | P1       | M      | 007                                                                                                                                                                          | DONE (2026-06-13; backend export, Diagnostics action, verifier, docs, and required gates passed)                                                                                                                                                                                                                               |
| 019  | Finish Windows v1 capture and package acceptance                                                                                                                                                                                                                                                                    | P2       | L      | 001, 002, 003, 006, 012                                                                                                                                                      | IN PROGRESS (2026-07-08; Windows input/discovery/device-list/job-object seams started; real Windows package/capture/process/signing evidence pending)                                                                                                                                                                          |
| 020  | Remediate leaked Google OAuth desktop client secret                                                                                                                                                                                                                                                                 | P0       | M      | Google Cloud + release access                                                                                                                                                | IN PROGRESS (2026-07-06; env rotated + validation hardened, rotated release + old-secret disable pending)                                                                                                                                                                                                                      |
| 021  | Fix the first external-tester feedback batch (preview vanish, nudge d-pad, silent mic)                                                                                                                                                                                                                              | P0       | M      | Reporter support bundle (F3 attribution only)                                                                                                                                | DONE (2026-07-06; F1–F4 on main, gates PASS; pending owner: F0 Discord ask + reporter confirmation on the next shipped build)                                                                                                                                                                                                  |
| 022  | Full-app QA fix list: comments crash + gate hole, device-gate repeatability, toast/settings/light-theme/select polish                                                                                                                                                                                               | P0       | M      | Owner for Q1 TCC grants + Q2 provider accounts                                                                                                                               | DONE (2026-07-06; Q0–Q8 on main, gates PASS; pending owner: Q1 TCC grants + device-gate run, Q2 provider accounts, UI by-eye)                                                                                                                                                                                                  |
| 023  | Fix record+stream A/V: slideshow recordings (wallclock PTS on the Annex-B split path) and stream audio skew                                                                                                                                                                                                         | P0       | L      | none (by-eye needs a real Twitch stream)                                                                                                                                     | DONE (2026-07-07; L0/L1/L3/L4 on main, L2 unneeded — MpegTs default w/ fifo-muxer legs, gates PASS; pending owner: real Twitch+4K by-eye on next release)                                                                                                                                                                      |
| 024  | Preview start-stretch + click-flash hint, backend-lost toast stack on permission grant, version-blind support bundle                                                                                                                                                                                                | P0       | M      | none (preview by-eye needs a camera)                                                                                                                                         | DONE (2026-07-07; S1–S5 on main, adversarially-verified root causes, gates PASS; S6 owner-triage list; pending owner by-eye + deferred commit-SHA build step)                                                                                                                                                                  |
| 025  | Native preview breaks across displays: surface stuck on main display, "Waiting for preview" on the secondary (contentsScale never set + no display-change observer)                                                                                                                                                 | P1       | M      | dual-display Mac for repro/by-eye                                                                                                                                            | DONE (2026-07-07; S1-S4 on the plan-025 branch, S5 correctly deferred — deliberate self-capture design; gates PASS, preview probe GPU-flaked env-only; pending dual-display by-eye)                                                                                                                                            |
| 026  | Fix progressive A/V desync: encoder-bridge schedule re-anchor compresses the video timeline vs the wall-true mic clock (audio drifts ~0.6-0.8s/min late)                                                                                                                                                            | P0       | M      | 023                                                                                                                                                                          | TODO (2026-07-08; root cause CONFIRMED — encoder_bridge.rs:1200 re-anchor + synthetic index/30 PTS; 5.2s deficit in the 6m52s X session, 7.9s in the 12.5m Twitch VOD session; fix slices ready)                                                                                                                               |
| 027  | Make automatic source fallbacks silent product-wide; keep the explanation in diagnostics/support bundles                                                                                                                                                                                                            | P1       | S-M    | 018                                                                                                                                                                          | DONE (2026-07-07; startup/source fallback warning UI removed product-wide, recovery preserved, support-bundle diagnostics added; gates PASS)                                                                                                                                                                                   |
| 028  | Add native X Livestream API integration: OAuth 1.0a source/broadcast lifecycle + read-only chat                                                                                                                                                                                                                     | P1       | L      | 009, 015, 018                                                                                                                                                                | IN PROGRESS (2026-07-07; implementation branch ready for PR, external X live acceptance pending real credentials/account)                                                                                                                                                                                                      |
| 029  | X Livestream user OAuth: in-app 3-legged OAuth 1.0a (Authorize X Live) so any user can go live natively — bundled consumer pair + per-user stored token, release gate for the baked consumer                                                                                                                        | P0       | M      | 028                                                                                                                                                                          | DONE (2026-07-08; same branch as 028, gates PASS; pending owner: bake consumer pair into ~/.videorc-release.env, confirm 3-legged OAuth + loopback callbacks on the X app, fresh-profile by-eye)                                                                                                                               |
| 030  | X native playback verification + source health: pre-publish HLS gate + continuous watchability probe, conservative source health, full X lifecycle in session logs (2026-07-08 spinner incident: same source/params worked at 7 min and spun at 2 min — playback provisioning is the suspect, measured not guessed) | P0       | M-L    | 028, 029                                                                                                                                                                     | DONE (2026-07-08; S1-S4 shipped in 0.9.21-beta.1, gates PASS; pending owner S5: long-session measurement w/ second-account viewer, partner-manager escalation if a fresh source never verifies)                                                                                                                                |
| 031  | X source hygiene: fresh source per session (only condition that ever played from second one), END broadcast before encoder stop (docs order — we did the opposite), graceful RTMP teardown grace (every session ended in SIGKILL)                                                                                   | P0       | S-M    | 030                                                                                                                                                                          | DONE (2026-07-08; S1-S3 landed, gates PASS; acceptance: two consecutive short real sessions must x-playback-verify within seconds on fresh sources)                                                                                                                                                                            |
| 032  | Bundled FFmpeg RTMPS TLS + Homebrew-dylib leak: static OpenSSL (SecureTransport rtmps stalls — A/B proven 0.0 vs 29.998 fps reaching X, starving every packaged X stream into a spinner) AND shipped bundles hard-linked /opt/homebrew libX11/libxcb (could not launch without Homebrew)                            | P0       | S      | none                                                                                                                                                                         | DONE (2026-07-08; gates fail closed on missing openssl/tls + homebrew dylibs; A/B repush + owner short-session acceptance on 0.9.23)                                                                                                                                                                                           |
| 033  | Make Comments the authoritative YouTube/Twitch/X feed with truthful send delivery and acknowledged stream highlights                                                                                                                                                                                                | P0       | L      | shipped X-read code from 028/029 (their real-account acceptance is still pending), Google OAuth approval, documented X native-chat write contract for literal three-way send | BLOCKED (2026-07-10; Milestone A focused implementation/acceptance pass; aggregate gate has a stale out-of-scope Plan 027 smoke; real provider/device acceptance, Google approval, and X native-chat write contract pending)                                                                                                   |
| 034  | 4K pipeline headroom: async GPU completion, O(retain) camera callback, phase-keeping compositor tick, evidence-gated 4K quality posture                                                                                                                                                                             | P1       | L      | 041, then 2026-07 incident fixes (corroborated freezes + cadence mismatch) on main                                                                                           | BLOCKED (2026-08-24; Plan 041 owns the active capture-producer incident and supersedes U2; rebase U1/U3/U4 only after its real-device acceptance)                                                                                                                                                                              |
| 035  | Replace the Windows raw-video bottleneck with a verified encoded path                                                                                                                                                                                                                                               | P0       | L      | 038                                                                                                                                                                          | IN PROGRESS (2026-07-28; remainder executes only via Plan 039; do not run a separate RTMP/default-promotion/fallback lane)                                                                                                                                                                                                     |
| 036  | Bound Windows proof-surface transport and presentation work                                                                                                                                                                                                                                                         | P1       | M      | 038                                                                                                                                                                          | IN PROGRESS (2026-07-28; remainder executes only via Plans 039/040; do not reopen it outside the incident overlay)                                                                                                                                                                                                             |
| 037  | Make Windows Electron fallback and background work recoverable and scoped                                                                                                                                                                                                                                           | P1       | M      | 038                                                                                                                                                                          | DONE (2026-07-28; implementation [#167](https://github.com/TheOrcDev/videorc/pull/167), physical Windows A/B and recovery acceptance recorded; closes [#158](https://github.com/TheOrcDev/videorc/issues/158))                                                                                                                 |
| 038  | Establish an enforceable Windows packaged-performance baseline                                                                                                                                                                                                                                                      | P0       | M      | Plan 019 physical Windows acceptance evidence                                                                                                                                | IN PROGRESS (2026-07-28; PR #160 landed the measurement infrastructure; Plan 039 owns the RTMP/OBS workload and active release budget, and Plan 040 may derive only candidate-bound D3D profiles)                                                                                                                              |
| 039  | Make Windows 1080p livestreaming measurable and OBS-competitive                                                                                                                                                                                                                                                     | P0       | L      | landed PRs #160, #161, #169                                                                                                                                                  | IN PROGRESS (2026-08-02; Steps 1-5 rebased at `d85f9b4c`; physical OBS/performance acceptance remains pending)                                                                                                                                                                                                                 |
| 040  | Replace the Windows display media path with D3D11 shared textures                                                                                                                                                                                                                                                   | P1       | L      | 039 Steps 1-5                                                                                                                                                                | BLOCKED (2026-08-02; source and fail-closed tooling complete at `f2eaaf25`; portable/macOS gates and xwin compile check pass, while the physical Windows source lane, signed candidate, NVIDIA/Intel/OBS/presenter/performance matrices, active budget, and natural-fallback evidence remain unavailable; no release can ship) |
| 041  | Eliminate macOS 4K screen-and-camera recording source decay                                                                                                                                                                                                                                                         | P0       | L      | none; incident overlay blocks and partially supersedes 034                                                                                                                   | BLOCKED (2026-08-25; automated slices pass, but repeated permissioned ScreenCaptureKit proof saw only the animated wallpaper, so the mandatory STOP rule prevented the terminal 3+3 owner-device clips)                                                                                                                        |
| 044  | Save visual scenes and improve everyday Studio controls                                                                                                                                                                                                                                                             | P1       | L      | Scene editor PR #378                                                                                                                                                         | BLOCKED (2026-09-22; all five slices implemented; draft PR; native stress, asset budget and manual acceptance outstanding)                                                                                                                                                                                                     |
| 045  | Schedule YouTube livestream events with metadata and thumbnails; start manually                                                                                                                                                                                                                                     | P1       | L      | Current main; YouTube OAuth for real acceptance                                                                                                                              | IMPLEMENTED; S6 BLOCKED (2026-09-22; real YouTube acceptance and renderer budget; recording-studio passed)                                                                                                                                                                                                                     |
| 049  | Schedule X broadcasts in the livestream scheduler (second provider of Plan 045; manual go-live via `/2/broadcasts/scheduled/:id/live`; dedicated source per schedule)                                                                                                                                               | P1       | L      | 045; X Livestream access; owner S0 spike on the authorized account                                                                                                           | IMPLEMENTED (2026-09-23; S0/S5 real-account acceptance pending)                                                                                                                                                                                                                                                                |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (with one-line reason) |
REJECTED (with one-line rationale).

## 2026-07-28 Windows livestream incident overlay

Execute these in order:

1. **Plan 039 — release-safe 1080p livestreaming**
   - Add attributable live health and a real DXGI-motion/local-RTMP gate.
   - Exclude exact Videorc-owned control/preview windows from captured pixels.
   - Fix the current entitlement mismatch: Basic stays 1080p30/6000, while
     tested Premium/Developer sessions may use 1080p60; nominal YouTube 60 fps
     alone is not acceptance evidence.
   - Promote the opt-in Media Foundation path only after stream-only,
     record-plus-stream, and natural fallback evidence pass.
   - Apply provider-aware YouTube 1080p bitrate policy without weakening
     shared Twitch/X/manual outputs.
   - Close with a controlled, same-scene OBS A/B and an active physical
     Windows performance budget.
2. **Plan 040 — D3D11 shared-texture end state**
   - May begin after Plan 039 Steps 1-5 land, including observability, RTMP
     harness, self-capture exclusion, MF topology, entitlements, and provider
     profiles; Plan 039 does not need to reach release DONE first.
   - Before source work, execute Plan 040 Step 0 and refresh its planned-at SHA
     to the commit containing those Plan 039 steps.
   - Replace FFmpeg BGRA readback, CPU scene composition, system-memory MF
     input, and BMP polling with one adapter-owned GPU media path.
   - Keep the Plan 039 path as a truthful fallback until the physical
     GPU/device matrix and device-loss recovery pass.
   - Run Plan 039's OBS/calibration formulas on the final signed D3D candidate,
     then derive a separate digest-bound D3D budget with zero-BMP profiles for
     NVIDIA and Intel plus a non-OBS-parity natural-fallback policy; never
     reuse the rejected raw-path budget.
   - Require the protected Windows lane to discover a nonzero maintained D3D
     Rust test set, run the full backend suite and clippy, and reject
     forged/stale/foreign preview HWNDs outside Electron main's authority.

Plans 035, 036, and 038 remain the historical source for their individual
encoder, proof-surface, and measurement decisions. Plan 039 owns their
remaining integrated 1080p release acceptance; Plan 040 is the named
GPU-native escalation and must reuse that machinery so executors do not create
incompatible gates.

## Current execution queue

This is the practical queue as of 2026-06-13 after Plans 009 and 011 landed.
The plan files below remain the source of truth; this section is the operator
view for what to run next.

### Track A - Unblocked product boundary

Run this track now while media hardware gates are being arranged.

1. **Plan 016 - open-core entitlement boundary - DONE**
   - Slice A1: documented the free/premium capability matrix.
   - Slice A2: added backend entitlement snapshot/protocol.
   - Slice A3: enforced livestreaming and cloud AI server-side.
   - Slice A4: wired renderer premium/free states from backend data.
   - Slice A5: updated streaming smokes to opt into developer premium and
     stabilized dev smoke isolation.
   - Proof gates passed: `cargo test -p videorc-backend entitlement`,
     `cargo test -p videorc-backend`, `pnpm --filter @videorc/desktop test`,
     `pnpm typecheck`, `pnpm lint`, `pnpm smoke:dev`,
     `pnpm smoke:multistream`, `pnpm test:scripts`.

2. **Plan 018 - redacted support bundle**
   - Slice A6: DONE - define bundle schema and redaction helpers.
   - Slice A7: DONE - add backend/main export command.
   - Slice A8: DONE - add Diagnostics export action.
   - Slice A9: DONE - add script verifier.
   - Slice A10: DONE - document bundle contents/exclusions.
   - Proof gates passed: `cargo test -p videorc-backend diagnostics`,
     `pnpm --filter @videorc/desktop test`, `pnpm typecheck`, `pnpm lint`,
     `pnpm test:scripts`, `pnpm format:check`, `pnpm smoke:dev`.

### Track B - Media-core unblock

Do not claim OBS parity or release readiness until this track is green or has a
fresh, specific hardware/permission blocker.

1. **Plan 006 - complete the real-source gates**
   - Slice B1: re-run drift check and confirm current split-output code still
     matches Plan 006.
   - Slice B2: verify ScreenCaptureKit source discovery and permissions before
     running media gates.
   - Slice B3: run `pnpm baseline:real-source:4k30:av-sync -- --gate` on a
     detected 3840x2160 or better source.
   - Slice B4: run `pnpm baseline:stream:av-sync -- --gate`.
   - Slice B5: if both pass, mark Plan 006 DONE; if either fails before
     encoding, mark BLOCKED with exact source/permission reason; if either
     fails after encoding starts, create/fix the smallest code slice and rerun.

2. **Plan 010 - dead-code reconciliation**
   - Initial docs/comment slice landed while Plan 006 is blocked: the stale
     `streaming.rs` comment is fixed and staged media allowances are registered
     in `docs/native-4k-media-engine-refactor.md`.
   - Run the destructive reconciliation only after Plan 006 is accepted, because
     the final split-output engine decides which staged media modules are
     retained or retired.

### Track C - Acceptance and audio

This track converts subjective "looks good/bad" reports into evidence.

1. **Plan 013 - OBS parity evidence**
   - Step 1 is done: the side-by-side harness writes a comparable-settings
     manifest without mutating OBS settings.
   - Step 2 template is done: new runs can copy
     `docs/acceptance/obs-parity-acceptance-template.md`.
   - Continue after Plan 006. Automated gates first, then human OBS
     side-by-side.
   - Output must be PASS, FAIL, or BLOCKED with owner bucket.

2. **Plan 014 - guided audio sync calibration**
   - Step 1 is done: `measure-av-sync --json` emits a stable recommendation
     report for measured lag, current offset, recommended offset, thresholds,
     pass/fail, and sample counts.
   - Step 2 pure helpers are done: renderer code can format measured lag,
     decide apply/reset state, and preserve explicit user-set offsets.
   - Step 3 UI is done: Sources tab can import measurement JSON, apply the
     recommendation explicitly, and reset to the structural default.
   - Step 4 evidence shaping is done: stream A/V evidence classifies
     fixed-offset, drift, and stream-leg divergence with 30-minute drift
     estimates.
   - Continue the real long-session gate after Plans 006 and 007.
   - Use this when recordings are visually good but audio is late or drifting.
   - Do not hide pipeline issues behind a new nonzero default offset.

3. **Plan 017 - native system audio**
   - Run after Plans 006, 007, and 014.
   - Mac-first mixed audio graph; Windows loopback stays out of scope.

### Track D - Release and provider proof

This track is for public launch confidence, not local dev confidence.

1. **Plan 012 - signed macOS release validation**
   - P4-S1 preflight is done: signed distribution now runs a redacted
     credentials/tools/path preflight before packaging.
   - P4-S2 artifact validation is done: release workflow validates signed
     `.app`/DMG artifacts with codesign, Gatekeeper, and stapler before upload.
   - P4-S3 workflow/docs wiring is done: distribution docs now define the
     clean-machine procedure and acceptance-note template.
   - Continue clean-machine release proof after Plans 004, 006, 008, 009, and
     011 are release-ready.
   - Must prove signed/notarized/stapled app, bundled backend/FFmpeg, and
     packaged native CAMetalLayer preview on a clean machine.

2. **Plan 015 - real provider livestreaming**
   - Step 1 is done: provider assumptions were refreshed from official
     YouTube, Twitch, and X docs on 2026-06-13.
   - Step 2 is done: readiness evidence reports credential source, callback
     coverage, account flags, X native access, and run context without printing
     secret values.
   - Continue after Plans 006, 009, and 012.
   - Must prove YouTube/Twitch/X eligibility or record exact non-code blockers.
   - Manual RTMP must not masquerade as native provider success.

### Track E - Windows follow-through

Run after macOS v1 stabilization unless business priority changes.

1. **Plan 019 - Windows v1 capture/package acceptance**
   - Step 1 is done: `docs/windows-port-plan.md` now separates completed
     packaging/chrome/seam work from missing Windows capture/package/signing
     acceptance.
   - Step 2 is done: `smoke:local-gates:windows` exists and drives the
     Windows-box unit/seam/package/preflight/packaged-recording gate. On-box
     execution is still pending.
   - Packaging scaffolds are done; capture parity is not.
   - Needs a Windows 11 x64 box and dated recording evidence.

## Master phase roadmap

This roadmap is the execution overlay for the plans above. The individual plan
files remain the source of truth for exact files, commands, STOP conditions, and
done criteria.

### Phase 0 - Foundation already landed

Goal: remove known platform/package blockers and establish the native media
baseline.

- **P0-S1 Windows package scaffold**: Plans 001 and 002 are done. Windows can
  build/package far enough to keep the future port honest, but Windows capture
  is not product-ready yet.
- **P0-S2 Platform seam tests**: Plan 003 is done. Capture-input and FIFO seams
  have unit coverage before more platform arms are added.
- **P0-S3 Packaged native preview**: Plan 004 is done. Production preview means
  detached native CAMetalLayer; JPEG/MJPEG remains fallback/debug only.
- **P0-S4 VideoToolbox livestream default**: Plan 005 is done. Platform-safe
  streaming uses VideoToolbox by default instead of the raw-YUV product path.

### Phase 1 - Finish the OBS-class media core

Goal: make the core promise real: smooth 4K local recording, perfect native
preview, and 1080p livestream output without raw-video fallback.

- **P1-S1 Split-output profile resolver**: Plan 006 Step 1 is done. Recording
  and stream profiles can resolve separately.
- **P1-S2 Split-output proof fields**: Plan 006 Step 2 is done. Diagnostics can
  expose recording/stream output settings and per-output VideoToolbox counters.
- **P1-S3 Real dual output path**: Plan 006 Step 3 is done. The compositor can
  publish an auxiliary stream-sized output store, recording starts separate
  recording/stream VideoToolbox bridge writers with independent encoded FIFOs,
  and FFmpeg muxes the local recording separately from stream FLV legs without
  product rawvideo scaling.
- **P1-S4 Validation unlock**: Plan 006 Step 4 is done. 4K local recording plus
  an explicit stream-safe 1080p-or-lower profile is allowed only when the
  encoder bridge split-output path is not disabled and the stream FPS does not
  exceed the recording FPS; custom/stream-only 4K remains blocked for v1.
- **P1-S5 Evidence wiring**: Plan 006 Step 5 is done. Scripts classify
  `record-stream-split-output` only when diagnostics prove zero-copy output,
  zero raw-video copies, two active VideoToolbox output encoders, nonzero
  recording/stream encoder frames and bytes, and a stream output at 1080p or
  lower. Stream A/V evidence exports the split-output proof fields.
- **P1-S6 Real-source gates**: BLOCKED locally on 2026-06-13. After Plan 018
  landed, `pnpm baseline:real-source:4k30:av-sync -- --gate` discovered
  `screen:screencapturekit:1` but blocked before encoding because the selected
  display was `3024x1964`, below the required `3840x2160`. Evidence:
  `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-real-source-baseline-1781376334685/latest-real-source-evidence.json`.
  `system_profiler SPDisplaysDataType` confirms the only online display on this
  machine is the built-in `3024 x 1964 Retina` panel, so the 4K gate cannot pass
  here until a real 3840x2160-or-larger display is connected/selected.
  `pnpm baseline:stream:av-sync -- --gate` first blocked before encoding
  because ScreenCaptureKit source discovery timed out and the fallback screen
  reached session start as `source-missing`. A forced rerun with
  `VIDEORC_BASELINE_SCREEN_ID=screen:screencapturekit:1` selected the
  ScreenCaptureKit display, then blocked before encoding because the
  ScreenCaptureKit stream start timed out after 30s while the camera stayed
  healthy. Evidence:
  `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-stream-av-sync-1781376411913/record-only/latest-real-source-evidence.json`.
  A follow-up preflight slice added `CGPreflightScreenCaptureAccess()` checks
  before ScreenCaptureKit discovery/start. A short forced screen-only rerun still
  timed out after the permission preflight passed, so the remaining local screen
  blocker is post-permission ScreenCaptureKit start/discovery, not missing TCC
  permission. Evidence:
  `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-real-source-baseline-1781377036578/latest-real-source-evidence.json`.
  Re-run these gates only after the machine presents a detected 3840x2160 or
  larger ScreenCaptureKit display and ScreenCaptureKit can start live screen
  frames before recording.

Do not move to release signoff until Phase 1 is done or explicitly blocked by
hardware rather than code.

### Phase 2 - Stabilize the app around the media core

Goal: make future changes safer before adding premium, provider, and support
surface area.

- **P2-S1 Characterize Studio orchestration**: Plan 007 is done. Pure helpers
  now cover session params, Go Live decisions, and native preview present policy.
- **P2-S2 Dependency/advisory gates**: Plan 008 is done. JS/Rust advisory gates
  are wired into CI/release checks.
- **P2-S3 Secret storage posture**: Plan 009 is done. Credential storage is
  explicit, legacy renderer-persisted stream keys migrate through the backend,
  and masked hints/delete flows are preserved.
- **P2-S4 Main renderer sandbox**: Plan 011 is done. Privileged preload work
  moved to main IPC and the main Studio window now runs with `sandbox: true`.
- **P2-S5 Dead-code reconciliation**: The behavior-free Plan 010 docs/comment
  slice is in progress. Execute the destructive cleanup only after Plan 006
  lands, because the fate of the staged live media modules depends on the final
  split-output architecture.

Plan 018 is done. Plan 010's destructive cleanup waits on Plan 006.

### Phase 3 - Close acceptance, not vibes

Goal: convert "looks good" or "looks bad" into repeatable release evidence.

- **P3-S1 OBS parity harness/evidence**: Execute Plan 013 after Plan 006. Run
  automated gates first, then human OBS side-by-side visual/currentness checks.
- **P3-S2 Audio sync calibration**: Execute Plan 014 after Plans 006 and 007,
  especially if OBS parity or manual testing shows late audio. Add JSON
  recommendations, UI apply/reset, and drift reporting.
- **P3-S3 Acceptance decision**: Update the dated acceptance note with PASS,
  FAIL, or BLOCKED. Failed items must map to owner buckets: preview/compositor,
  encoder bridge, stream path, audio calibration, or Studio orchestration.

This phase is allowed to fail. A clean FAIL with owner and evidence is better
than another round of subjective debugging.

### Phase 4 - Release candidate hardening

Goal: prove a creator can install and run the packaged macOS app cleanly.

- **P4-S1 Release preflight**: Done. Check signing,
  notarization, stapler, codesign, spctl, entitlements, and writable outputs
  without printing secrets.
- **P4-S2 Artifact validation**: Done. Validate signed app
  and DMG with codesign, stapler, and Gatekeeper.
- **P4-S3 Workflow/docs wiring**: Done. Signed artifact validation is in
  workflow/docs, and the clean-machine release-candidate operator procedure has
  an acceptance-note template.
- **P4-S4 Clean-machine smoke**: Execute Plan 012 Step 5. Packaged backend,
  bundled FFmpeg, native CAMetalLayer preview, permissions, and one real-source
  recording must all have dated evidence.

Plan 012's release-preflight slice is done. The remaining release validation
depends on Plans 006, 008, 009, and 011 because release validation should test
the real media path, real credential posture, advisory gates, and sandboxed
renderer.

### Phase 5 - Open-core product boundary and real livestreaming

Goal: ship free local recording honestly, and gate premium livestreaming/cloud
AI in backend-enforced code.

- **P5-S1 Capability matrix - DONE**: Plan 016 Step 1. Free/core remains local
  recording, native preview, source/layout controls, and library. Premium is
  livestreaming and cloud AI.
- **P5-S2 Entitlement protocol - DONE**: Plan 016 Step 2. Backend exposes
  deterministic free/premium/developer capabilities.
- **P5-S3 Backend enforcement - DONE**: Plan 016 Step 3. Streaming and cloud
  AI are rejected server-side without entitlement; local recording stays free.
- **P5-S4 Renderer states and smokes - DONE**: Plan 016 Steps 4 and 5. UI reads
  the backend model; streaming smokes opt into developer premium explicitly.
- **P5-S5 Provider live acceptance - IN PROGRESS**: Plan 015 Steps 1 and 2 are
  done. Continue after Plans 006, 009, and 012. Prove YouTube/Twitch and any
  eligible X native path in a packaged app, or record exact non-code blockers.

Do not build payment/licensing infrastructure in this phase. The boundary must
exist first; billing can replace the local entitlement provider later.

### Phase 6 - Supportability and creator audio completeness

Goal: make future debugging and creator workflows less dependent on chat logs
and manual reconstruction.

- **P6-S1 Support bundle**: Execute Plan 018 after Plan 007. Export redacted
  diagnostics/log/session summaries from the Diagnostics tab, excluding secrets,
  recordings, DB files, extracted audio, and AI artifact bodies.
- **P6-S2 Native system audio**: Execute Plan 017 after Plans 006, 007, and 014.
  Add protocol selection, native mixer, macOS system-audio adapter, recording
  integration, honest UI state, diagnostics, and manual acceptance.

Support bundle can land before system audio; system audio should not land before
the sync story is measured and stable.

### Phase 7 - Windows follow-through

Goal: avoid confusing "packages on Windows" with "works like a product on
Windows."

- **P7-S1 Reconcile Windows docs - DONE**: Plan 019 Step 1. Completed
  Windows package/seam slices are marked, and missing capture/package/signing
  acceptance remains explicit.
- **P7-S2 Windows gate script - DONE**: Plan 019 Step 2. A Windows-local gate
  exists separately from macOS gates and includes package preflight, packaging,
  and packaged recording smoke.
- **P7-S3 Windows capture MVP**: Execute Plan 019 Step 3. Implement source,
  camera, mic, and capture-input seams without forking recording policy.
- **P7-S4 Windows package recording acceptance**: Execute Plan 019 Step 4 on a
  Windows 11 x64 box with evidence.
- **P7-S5 Signing decision**: Execute Plan 019 Step 5. Document unsigned
  internal vs Authenticode/Trusted Signing path.

Windows remains after macOS v1 stabilization unless the product priority
changes.

## Global execution rules

- Finish and verify one slice before relaxing validation or claiming a mode is
  production-ready.
- Do not silently downgrade native preview. CAMetalLayer is production; JPEG
  polling is fallback/debug.
- Do not claim split output unless diagnostics prove separate VideoToolbox
  outputs and zero raw-video copied frames.
- Do not stage user-local files, secrets, recordings, generated media, or
  scratch probes.
- For each code slice, update the relevant row in this file and run the smallest
  focused gate first, then the broader gate required by the plan.

## Dependency notes

- The immediate media/release blockers are 004 and 005. They can run in
  parallel because 004 is packaging/smoke work and 005 is backend stream media
  behavior.
- 006 depends on 005 because true record/stream split output should build on a
  non-raw VideoToolbox streaming baseline.
- 007 is a stabilizer: it can run before 005/006 if you want safer seams first,
  or in parallel if another executor owns the media work.
- 008 is independent and should be done soon because the current JS advisory
  audit fails and Rust advisory audit is absent.
- 009 is independent from media performance, but it should land before a public
  premium livestreaming launch.
- 010 has an initial docs/comment slice in progress. Its destructive cleanup
  waits for 005 and 006 because the fate of the live-render/live-pipeline
  scaffolding depends on the accepted stream engine.
- 011 waits for 004 because sandboxing should be verified against the packaged
  native preview path, not only the dev shell.
- 012 is the macOS release-candidate gate. It should wait until media evidence
  (006), advisory gates (008), credential posture (009), and sandboxing (011)
  are settled enough for a public build.
- 013 can run as soon as 006 lands. It is the human OBS side-by-side signoff
  and should not be replaced by more synthetic metrics.
- 014 follows 006/007 because sync calibration should sit on the accepted
  split-output timeline and the characterized Studio state helpers.
- 015 needs the packaged release candidate and secret-storage posture from 009
  before real provider credentials are exercised.
- 016 is independent of the media engine but should follow 007/009 so feature
  gates use tested Studio helpers and do not weaken credential handling.
- 017 waits for 014 because system audio can introduce cross-source clock drift;
  do not add it before microphone sync has a guided measurement story.
- 018 is useful before broader manual testing, but it depends on 007 so the
  export command does not deepen the current Studio orchestration knot.
- 019 is explicitly post-macOS stabilization. Windows packaging work is not the
  same as Windows capture acceptance.
- 033 builds on 028/029's native X read path but does not depend on media Plan
  006 for its internal domain/UI work. Google OAuth approval gates production
  YouTube comments. The literal three-native-chat outbound acceptance remains
  blocked until X supplies a documented write contract; do not substitute X
  Posts. If the legacy >30fps stream path must support highlights, report that
  focused media dependency instead of widening 033 silently.

## Recommended first slice

Current next move: finish Plan 006. After that, run Plan 013 to close the OBS
by-eye acceptance gap, and Plan 012 when you are ready to cut a signed macOS
release candidate. Plans 014-018 are the product-readiness stack around that
core; Plan 019 is later Windows follow-through. For the current Comments work,
start Plan 033 at U0: repair the stale X gate and event-lag recovery before
changing provider or UI behavior.

## Findings considered and rejected

From the 2026-06-12 Windows audit:

- **Win11 version-floor parsing edge cases** (`enforceWindowsVersionFloor`,
  apps/desktop/src/main/index.ts ~2455): a malformed `os.release()` makes the
  parse NaN, which FAIL-CLOSES (dialog + quit) - the behavior is already the
  safe one. Not worth doing.
- **Trivial `source_zerocopy_enabled` stubs untested** (preview_camera.rs /
  preview_screen.rs): one-line constant stubs, already exercised through their
  callers' tests on macOS. Not worth standalone work.
- **Three platform-gating styles** (cfg blocks vs `cfg!()` vs Unsupported
  stubs): consistency note only; pattern guidance belongs in the Phase 2 work
  that next touches these files, not a refactor now.
- **`check:windows` hardcodes `/opt/homebrew/opt/llvm/bin`**: machine-specific
  but this is a solo-dev repo and the path is the Homebrew default; revisit
  only if another contributor appears.
- **Multi-size `icon.ico`**: current single-entry 256px PNG-ICO is valid on
  Win10+; small sizes are OS-downscaled. Cosmetic; noted in plan 001's
  maintenance notes.
- **electron-builder `win.extraResources` "does not inherit" claim**: rejected
  as stated - verified that global and platform resource lists concatenate,
  which is the opposite problem and is what plan 001 fixed.

From the 2026-06-13 native media/release/security audit:

- **6000 kbps livestream limit is not a bug**: both frontend and backend enforce
  the v1 platform-safe path. Plans 005 and 006 improve the media path without
  removing platform-safe limits.
- **Secret JSON file is not an accidental leak**: `secrets.rs` documents it as
  an owner decision. Plan 009 hardens or formalizes it for premium release
  instead of treating it as an emergency credential spill.
- **Native helper process driver leak/crash claim rejected**: the current driver
  already has timeout/error cleanup and owned-PID callbacks. Plan 004 targets
  packaging/gating, not helper process lifecycle internals.
- **Electron was not identified as the core media-quality failure**: the
  immediate problems are missing native packaged proof and raw-YUV streaming
  fallback. Plan 011 still hardens Electron later.
