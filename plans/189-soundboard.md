# Plan 189: Soundboard (sound pads that play on stream)

> **Executor instructions**: Follow this plan slice by slice. Run every "Done
> when" check before moving on. If anything in "STOP conditions" happens, stop
> and report; do not improvise. When done, update this plan's row in
> `plans/README.md` and fill in "As built". Gates run once at the end
> (owner rule): write and commit S1–S10 first, then run S11.
>
> **Drift check (run first)**:
> `git diff --stat 6ea698a9..origin/main -- crates/videorc-backend/src/session_audio.rs crates/videorc-backend/src/audio.rs crates/videorc-backend/src/source_audio_tap.rs crates/videorc-backend/src/recording.rs crates/videorc-backend/src/storage.rs crates/videorc-backend/src/main.rs crates/videorc-backend/src/protocol.rs crates/videorc-backend/src/remote_control.rs crates/videorc-backend/src/ffmpeg.rs apps/desktop/src/main/index.ts apps/desktop/src/preload apps/desktop/src/shared/backend.ts apps/desktop/src/shared/backend-rpc-contract.ts apps/desktop/src/shared/electron-ipc-contract.ts apps/desktop/src/renderer/src/components/tabs/assets-tab.tsx apps/desktop/src/renderer/src/components/studio apps/desktop/src/renderer/src/components/sources apps/desktop/src/renderer/src/components/stream-manager apps/desktop/src/renderer/src/lib/remote-surface.ts apps/desktop/src/renderer/src/hooks/use-studio.tsx apps/streamdeck-plugin crates/videorc-backend/remote_web`
> If an anchor quoted below has moved, re-find it by the symbol name. If a
> _behaviour_ changed (not just a line number), that is a STOP condition.

## Status

- **Priority**: P1. Owner request, 2026-10-23: "let's plan out to make a
  soundboard in Videorc in studio where people can play sounds, we can have
  some most often used on streams in the beginning. use this for those sound
  pads https://www.audiocn.dev/docs/blocks/soundboard - plan it out
  properly", then "execute the entire plan when done and create a pr".
- **Effort**: L. Phase 1 is S1–S8: starter sounds, the backend store and
  import, the voice mixer in the session bus, contracts, the renderer
  monitor, and three UI homes. Phase 2 is S9–S10 in the same PR: the Stream
  Manager, `/sound`, ⌘K and the remotes. S11 is the gates.
- **Risk**: MEDIUM–HIGH. Sounds join the session audio bus, the one PCM
  timeline every recording and every stream is written from, on all three
  platforms. A bug is audible on stream and burned into recordings. It is
  bounded in four ways:
  - A session where no sound plays writes byte-identical PCM (the existing
    mic-only SHA golden test, plus a new one with a sound that never plays).
  - Sounds are summed after every existing tap: the microphone ISO file,
    captions, Buddy's ears, the echo guard and the mic meter never hear them.
  - The voice renderer is a pure function over pre-decoded PCM: no I/O, no
    locks and no allocation per chunk beyond the existing ones on the bus
    thread.
  - Sounds are decoded, trimmed and levelled once, at import, by the bundled
    FFmpeg on the existing `AssetImport` lane.
- **Depends on**: nothing open. Interacts with PR #694 (Clips, open) and
  plan 188 (polls, executing on `plan-188-*` branches): all three add rows to
  the remote intent list, the Stream Manager status bar, the composer's
  slash commands and ⌘K. Whoever lands second rebases those lists.
- **Category**: feature (stream audio)
- **Planned at**: commit `6ea698a9` (origin/main), 2026-10-23
- **Route**: Orchestrator, fit 10. The work spans the backend audio bus on
  every platform, import, the wire contracts, three renderer pages, the
  Stream Manager and the remotes. Model lanes per slice:
  - `fable-5`: S2 and S3. The store and the bus mixer are release-critical,
    and the bus has 10,800 lines of hard-won timing rules.
  - `gpt-5.5`: S1, S4 and S8. Sourcing, contracts and smokes are mechanical
    with clear acceptance.
  - `opus-4.8`: S5–S7 and S9–S10. Taste-heavy UI. Load
    `.claude/skills/videorc-design/SKILL.md`, `docs/ui-copy.md` and the
    shadcn skill first.
  - Escalate to `fable-5` without asking if a by-ear or by-eye pass comes
    back below the bar.

## Goal

A streamer presses a pad and everyone hears it: the recording, every
livestream leg and the streamer's own headphones, at the moment they
pressed it, at a sensible loudness. Videorc ships with a dozen of the sounds
streamers use most (airhorn, applause, laugh, rimshot, sad trombone…), and
the streamer can add their own from Assets.

## What the user will see

- **Studio → Soundboard.** A new section under Scenes, in the preview
  column: a grid of audiocn sound pads, one per sound, each with its name,
  its key (1–9) and a thin progress bar while it plays. Click a pad, or
  press its number while Studio is in front, and it plays. "Stop all" sits
  in the section header. The description says where the sound goes:
  - idle: "Only you hear sounds until you record or go live.";
  - recording or live: "Sounds play in your recording and stream.".
  With no sounds, the section says so and links to Assets.
- **Assets → Sounds.** The home of the sounds, next to Backgrounds, Banners
  and Takeovers: import, rename, reorder, set each sound's volume, how a
  press plays it (Play once, Play/stop, Loop, While held) and its key,
  remove (with Undo), and "Restore starter sounds".
- **Sources → Sounds.** The soundboard's level, beside Microphone and
  System audio (the owner's 2026-10-02 call: audio controls live on
  Sources): a Level fader, its meter, and a "Hear sounds yourself" switch,
  on by default.
- **Stream Manager.** A "Sounds" action in the status bar opens the same
  pads in a popover, and `/sound airhorn` in the composer plays one
  (`/sound stop` stops all).
- **⌘K, Stream Deck and the phone.** "Play sound: Airhorn", "Stop all
  sounds"; a Stream Deck "Play sound" key with a sound picker; a Sounds grid
  on the phone remote.
- **Nothing else moves.** No switch beside Record and Go Live… (owner call,
  2026-10-12), no tinted pads (colour is information), no new window.

## What exists today (verified at `6ea698a9`)

### audiocn: the pad is a trigger, not a player

- `@audiocn/sound-pad` (`~/projects/audiocn` `components/ui/sound-pad.tsx`,
  origin/main `521c03f`) exports `SoundPadGrid`, `SoundPad`, `SoundPadIcon`,
  `SoundPadLabel`, `SoundPadShortcut`, `SoundPadProgress` and the
  `SoundPadMode` type. Its own docs: "The pad plays nothing itself. It
  reports triggers; `useSound` or your own engine does the playback."
  - Modes (`one-shot`, `toggle`, `hold`, `loop`) map presses to `onTrigger`
    and `onStop`, given the `playing` prop.
  - The grid registers hotkeys (`focus` or `global` scope, never while
    typing in a field, held keys released on blur) and moves focus with the
    arrow keys.
  - `SoundPadProgress` takes a `FrameSource<number>` and writes a CSS
    variable per frame with no React renders.
  - It imports only `@/components/ui/kbd`, `@/hooks/use-frame-source`,
    `@/lib/audio/decibels` and `@/lib/audio/types`, all already vendored by
    plan 092. No Base UI, no Phosphor, no Web Audio.
  - Two style-guard facts: the pad root carries `rounded-xl` (off-tier, so
    the file joins `OFF_TIER_RADIUS_ALLOWLIST` with a reason, and Videorc
    passes `rounded-row` from outside, the `docs/audiocn.md` rule), and its
    default fill is `color-mix(--pad-accent 14%, --muted)` with
    `--pad-accent: var(--primary)`: chrome, not colour.
- `@audiocn/soundboard` (the block the owner linked) is the reference for
  the shape: a header with Stop all, a pad grid with an Add pad, drop to
  add, right-click for mode, volume and remove, and an Undo after a removal.
  Videorc does **not** install it: it plays through Web Audio
  (`useSound`, `useGainNode`), imports Phosphor directly and uses Base UI's
  `ContextMenuTrigger render`. Plan 092 already ruled every block "reference
  only".
- `~/projects/audiocn/public/sounds/peon-work-work.wav` is a Warcraft
  sample. **Never ship it**, or anything else that is not CC0 or the
  owner's own.

### The session audio bus (`session_audio.rs`, 10,807 lines)

- One normalized PCM timeline per recording or broadcast: 48 kHz stereo
  f32, 480-frame (10 ms) chunks (`CHUNK_FRAMES`, `:8`), written to a FIFO
  that FFmpeg reads for the Combined file and every stream leg.
- The cursor trails the wall clock by `PLAYOUT_DELAY` (50 ms, `:25`) or
  `SYSTEM_AUDIO_PLAYOUT_DELAY` (150 ms, `:30`) on platforms with System
  audio. `wall_cursor_at` (`:2064`): sample `s` is wall time
  `epoch + s/48000`, and the cursor sits `playout_delay` behind now.
- `mix_chunk` (`:3551`) sums the processed microphone and the gained
  system audio, then runs the `PeakLimiter` (−1 dBFS, `:3499`). The write
  loop (`:5106`–`:5240`) takes the mixed path only while a system slot is
  attached or the limiter is still releasing
  (`mixing = system_raw.is_some() || !limiter.idle()`); otherwise
  `write_chunk_with_clock` writes the microphone alone. A mic-only bus is
  byte-identical to before plan 069 (SHA golden test).
- After the write (`:5199`–`:5340`): the plan 157 ISO taps get the
  microphone and the system ingredients (`taps.offer_chunk`), the echo guard
  gets both, the caption tap and `record_live_peak` get the microphone only,
  and the master meter reads the written chunk.
- `SystemCommand` (`:3743`) is the recipe for a command channel into the
  bus thread (`try_recv` each pass, acknowledged through a oneshot). The
  session reaches it through `SessionAudio::system_audio()` (`:1434`), held
  by `ActiveRecording.native_audio` (`recording.rs:2057`).
- `AudioLevelsEvent` (`protocol.rs:1574`, about 20 Hz) carries
  `microphone`, `systemAudio` and `master` readings, each
  `skip_serializing_if = "Option::is_none"` (the serde-null trap: an absent
  field is omitted, never `null`).
- The bus exists only while a session runs. Between sessions there is the
  warm microphone, not a bus.

### Nothing in Videorc plays audio out loud

- No `HTMLAudioElement`, no `AudioContext` destination in the renderer: the
  only `AudioContext` is the visual mic analyser
  (`lib/browser-mic-visual-pipeline.ts`). The soundboard's monitor is the
  first audible output.
- Own-sound exclusion already holds for renderer audio:
  - macOS: Electron disables `AudioServiceOutOfProcess`
    (`main/chromium-disabled-features.ts`), so Chromium's audio runs in the
    main process that ScreenCaptureKit's own-app exclusion covers. The
    `self` case of `smoke:system-audio` proves a WebAudio tone from the
    renderer never reaches a recording.
  - Windows: the loopback client excludes the Electron main process tree
    (`system_audio_capture_windows.rs:27`,
    `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`).
  - So a monitored pad is in the recording **once** (the bus copy), never
    twice through System audio.
- The main window has `backgroundThrottling: false`
  (`main/electron-background-policy.ts`), so it reacts to backend events
  while hidden.

### FFmpeg can decode anything we import

- macOS bundles an LGPL build with the native decoders
  (`scripts/build-ffmpeg-macos.sh`); Windows and Linux fetch BtbN LGPL builds
  (`scripts/fetch-ffmpeg-windows.mjs`, `fetch-ffmpeg-linux.mjs`). The tiny
  Windows **capture worker** build (`scripts/ffmpeg-capture-windows.mjs`,
  `--disable-everything`, PCM decoders only) is a different binary: never
  decode with it.
- The backend resolves the recording FFmpeg with `ffmpeg::resolve_ffmpeg_path`
  (`ffmpeg.rs:37`).

### Import, assets and their homes

- Plans 182 and 186 set the import recipe: main's picker issues a resource
  capability (`issueResourceCapability`), the backend imports on its own
  `AssetImport` lane into SQLite plus a managed directory under `userData`,
  and the renderer reads the file through `videorc-asset://<kind>/<file>`.
  Nothing is published half done; refusals are warnings with verbatim
  sentences.
- `CONTEXT.md`: Assets → Takeovers and Assets → Banners manage; Studio's
  Takeover section and the Scene page operate. The soundboard follows the
  same split.
- The Studio layout (`components/tabs/studio-tab.tsx`): the preview column
  holds Preview and the deferred `StudioDashboardBottomRow` (Scenes, the
  vertical leg); the inspector holds Session, Microphone, QuickSettings and
  Takeover. Space records on this page only, through `spaceShortcutBlocked`.
- The Stream Manager status bar (`stream-manager-status-bar.tsx`) already
  carries a Banners menu (plan 186 S7) relayed to Studio through
  `shared/banner-commands.ts`, plus `/banner` in the composer.

## Owner decisions

The owner asked for execution right after planning, so S0 takes the
recommended default for each. Each is easy to change at the by-ear and
by-eye pass.

- **D1. Where it lives.** Recommended and taken: Studio plays (a Soundboard
  section under Scenes), Assets → Sounds manages, Sources → Sounds holds
  the level. This is the Takeover and Banner split (`CONTEXT.md`) and the
  2026-10-02 call that audio controls live on Sources. Alternative: the
  whole block in Studio (right-click for mode and volume, as audiocn's
  block does).
- **D2. Hear sounds yourself.** Recommended and taken: on by default. Off,
  the streamer hears nothing while recording or live (the stream still
  does); between sessions a press always plays locally, or the board would
  be silent to audition.
- **D3. Starter sounds.** Taken: twelve CC0 sounds from Freesound, the most
  downloaded CC0 match for each slot, verified on each sound's page (S1):
  Airhorn 1, Applause 2, Laugh 3, Rimshot 4, Sad trombone 5, Drumroll 6,
  Tada 7, Buzzer 8, Ding 9, Crickets, Boom, Woah. The owner's by-ear pass
  replaces any that are weak.
- **D4. Free.** Taken: the soundboard is free for everyone, like
  multistreaming and polls.
- **D5. Even out loudness.** Taken: every sound is levelled at import to
  −18 LUFS integrated (BS.1770, gated), capped at +12 dB of boost and so its
  peak lands at or under −1 dBFS. The starters measure from −28 to −8 LUFS
  raw, so without this the board would jump 20 dB between pads.
- **D6. Separate source recordings.** Taken: sounds are in the Combined file
  and every stream, not in the Microphone or System audio ISO files. A
  Sounds ISO file is Later.
- **D7. Pressing a playing one-shot again** restarts it (the old voice fades
  out in 5 ms). No pile-up of ten airhorns.
- **D8. Limits.** 24 sounds, 30 seconds each, 5 minutes in total, 50 MB per
  source file. The total keeps resident PCM under 58 MB.
- **D9. Phase 2 in the same PR** (Stream Manager, `/sound`, ⌘K, Stream
  Deck, phone). Buddy voice ("Buddy, play airhorn") and per-sound global
  shortcuts are Later: the digits in Studio and the Stream Deck cover the
  first release.

## Design

### What a sound is

A row in a new SQLite table `sounds` (in `storage.rs`, with a migration) and
one file `userData/Sounds/<id>.wav`: 48 kHz, stereo, 16-bit PCM, already
trimmed. The original file is not kept.

`Sound` on the wire (camelCase; pinned in
`protocol-fixtures/high-risk-contracts.json` → `sound.minimal`,
`sound.starter`):

```text
{ id, name, file, durationMs, loudnessLufs, levelDb, volumeDb, mode,
  hotkey?, starter?, sortOrder, createdAt, updatedAt }
```

- `levelDb`: the auto-level gain from D5, computed at import, read-only.
- `volumeDb`: the streamer's own trim, −24..+6 dB, whole numbers, default 0.
- `mode`: `"oneShot" | "toggle" | "loop" | "hold"` (UI: Play once,
  Play/stop, Loop, While held).
- `hotkey`: `"1"`–`"9"`, unique across sounds; omitted when none.
- `starter`: the starter slug (`"airhorn"`), omitted for imports.
- Optional fields are `skip_serializing_if`, never `null` (the serde-null
  trap took the app down three times).

`SoundboardState` = `{ sounds, volumeDb, monitor, startersSeeded }`, where
`volumeDb` is the board's level (−24..+12, default 0) and `monitor` is "Hear
sounds yourself" (default true). Both live in a one-row `sound_settings`
table.

The gain a voice plays at, on the bus and in the monitor alike, is
`levelDb + volumeDb + board volumeDb`, as linear gain.

### Import (backend, `AssetImport` lane)

1. Resolve the capability. Refuse a file over 50 MB.
2. Decode with the bundled FFmpeg (`resolve_ffmpeg_path`), owned child,
   20 s deadline:
   `ffmpeg -nostdin -hide_banner -v error -i <src> -map 0:a:0 -vn -ac 2 -ar 48000 -t 30.5 -c:a pcm_s16le -f wav <tmp>`.
   No audio stream, or an FFmpeg failure: "This file has no sound Videorc can
   play."
3. Read the WAV back (a small RIFF reader in `sound_store.rs`; refuse
   anything but 48 kHz stereo s16).
4. Trim leading and trailing near-silence (under −60 dBFS on both channels),
   keeping 10 ms either side, so a pad never feels late.
5. Duration over 30 s (the `-t 30.5` decode reached its cap): "Sounds can be
   up to 30 seconds. Trim this one and try again." Under 50 ms after the
   trim: "This file is silent."
6. Loudness: BS.1770-4 integrated, K-weighted, 400 ms blocks with 75%
   overlap, absolute (−70 LUFS) and relative (−10 LU) gates, in pure Rust
   (`sound_loudness.rs`). A sound shorter than one block is measured as one
   block. `levelDb = min(−18 − I, +12, −1 − peakDb)`.
7. Limits: 24 sounds ("You have 24 sounds. Remove one to add another."), 5
   minutes total ("Your sounds add up to 5 minutes. Remove one to add
   another.").
8. Write `<id>.wav` atomically (`atomic_file.rs`), insert the row at the end
   of the order, give it the lowest free key 1–9 if any, emit
   `sounds.changed`.

Every refusal is a warning toast with the verbatim sentence, never an error.

### Starter sounds

- Twelve Ogg Opus files (48 kHz stereo, 128 kb/s) in
  `apps/desktop/resources/sounds/starter/`, with `manifest.json` (slug,
  name, hotkey, file, sha256, source page, author, original title, licence
  `CC0-1.0`, the processing applied) and `LICENSES.md`. About 0.6 MB in all.
- The packaged app ships them as an `extraResources` folder, like the
  bundled backgrounds (`process.resourcesPath/sounds/starter`).
- **Seeding**: once per profile, by the main window. When `sounds.list`
  answers `startersSeeded: false`, the renderer asks main for the starter
  files (`sounds:starter-files`). Main reads the manifest and issues one
  single-use `input-file` capability per file. The renderer then calls
  `sounds.import {sourceCapability, starter: {slug, name, hotkey?}}` for each
  one (the same decode, trim and level path) and finishes with
  `sounds.settings {startersSeeded: true}`. The backend skips a slug it
  already has, so a rerun never duplicates. A starter the streamer removed
  stays removed; "Restore starter sounds" imports the missing slugs only.
- `scripts/build-starter-sounds.mjs` (`pnpm sounds:build-starters`)
  rebuilds the folder from the manifest: download, trim, fade, encode. A
  unit test checks every manifest row: the file exists, its sha256 matches,
  its licence is `CC0-1.0`, and its source is a freesound.org sound page.

### Playback: the player and the bus

`sound_player.rs` owns playback for the whole app:

- **Library**: decoded PCM per sound id (`Arc<[i16]>`), loaded from disk on
  the first press and kept (the 5-minute total bounds it). The load runs in
  the RPC handler, before the bus hears about the voice.
- **Voices**: at most 8 at once; a ninth stops the oldest. Each voice has a
  `voiceId`, its sound, its start (wall clock), its duration and whether it
  loops.
- **Press logic** (`sounds.press`, for keys, remotes and `/sound`): the same
  mapping as audiocn's pad, so every surface behaves the same. Play once
  restarts (D7); Play/stop and Loop stop a playing sound and start a stopped
  one; While held starts (and `sounds.stop` ends it on release). Pads call
  `sounds.play` and `sounds.stop` directly, because the pad already applied
  its mode.
- **Ending**: a timer ends each non-looping voice at its duration and
  emits `sounds.playback`. The bus renders by the same arithmetic, so no
  message comes back from the bus thread.
- **Session or not**: with no session bus, the voice exists only for the
  monitor and the UI (`onAir: false`). With one, the player sends
  `SoundCommand::Start` to the bus through `SessionAudio::soundboard()`, a
  handle shaped like `system_audio()`.

In the bus (`session_audio.rs`, plus a pure `sound_mix.rs`):

- **Placement**: a voice starts at the sample of the moment the backend
  received the press, `(received_at − epoch) × 48000`. That sample is
  ahead of the cursor by the playout delay, so the sound lands on the video
  frame the streamer saw and the words they were saying, not 50–150 ms
  early. A press that arrives after its sample has passed (an output stall)
  starts at the cursor. A press before the epoch is monitor only.
- **Render**: `SoundVoices::render(chunk_start, frames) -> Option<Vec<f32>>`
  sums every active voice into the chunk at its gain, with a 240-frame (5 ms)
  ramp to zero on a stop or a restart and exact unity in between. `None`
  when nothing plays, so the mic-only path stays byte-identical.
- **Mix**: `mixing = system || sounds || !limiter.idle()`. `mix_chunk` takes
  the sounds as a third ingredient, summed before the limiter. The board
  level is re-read per chunk; a change ramps across one chunk (no zipper).
- **Taps**: unchanged. `taps.offer_chunk(mic, system)`, the echo guard, the
  captions and `record_live_peak` never see sounds (D6). The master meter
  does, and a new `sounds` reading joins `AudioLevelsEvent`
  (`skip_serializing_if`).
- **Stop**: the drain silences sounds after the source boundary, like the
  microphone, and every voice ends with the session.
- **Clips (PR #694, open)**: if the always-on ring lands, its pre-session
  audio has no sounds. Note it in that PR when it rebases; nothing here
  depends on it.

### Hearing it yourself (the monitor)

`lib/sound-monitor.ts`, started by the **main window only** (Stream
Manager and other windows never play, so there is one copy):

- It follows `sounds.playback` and plays each new voice through one lazily
  created `AudioContext`: `fetch('videorc-asset://sound/<file>')` →
  `decodeAudioData` (cached per id and `updatedAt`) → `AudioBufferSourceNode`
  → `GainNode` (the same gain as the bus) → speakers. It stops the node when
  the voice leaves the list, with a 5 ms ramp.
- It plays when no session is running, or when `monitor` is on.
- It is the same WAV the bus mixes, so what you hear is what they hear,
  ahead by the playout delay.
- Speakers instead of headphones: the microphone may pick the sound up a
  second time. The Sources row says "Use headphones, or your microphone may
  pick the sound up again."

### Wire shape

**Backend RPCs** (strict schemas in `shared/backend-rpc-contract.ts`; rows
in the `main.rs` mutation and lane tables beside `banners.*`):

| Method | Lane | Params → result |
| ------ | ---- | --------------- |
| `sounds.list` | observation | → `SoundboardState` |
| `sounds.import` | AssetImport | `{sourceCapability, starter?: {slug, name, hotkey?}}` → `Sound` |
| `sounds.update` | mutation | `{id, name?, volumeDb?, mode?, hotkey?}` (`hotkey: ""` clears) → `Sound` |
| `sounds.reorder` | mutation | `{ids}` → `Sound[]` |
| `sounds.delete` | mutation | `{id}` → `Sound[]` (refuses a path outside `userData/Sounds`) |
| `sounds.settings` | mutation | `{volumeDb?, monitor?, startersSeeded?}` → `SoundboardState` |
| `sounds.play` | LiveControl | `{id}` → `{voiceId, onAir}` |
| `sounds.press` | LiveControl | `{id}` → `{voiceId?, onAir}` (`voiceId` omitted when the press stopped it) |
| `sounds.stop` | LiveControl | `{id?}` → `SoundsPlayback` (no `id` stops all) |

The Stream Manager never calls these itself. Like banners (plan 186 S7), the
Studio renderer pushes a read-only summary to it through main, and its
presses relay through main to the Studio renderer, which owns the socket
(`shared/sound-commands.ts`, the `banner-commands.ts` recipe).

**Events**: `sounds.changed` (the whole `SoundboardState`) and
`sounds.playback` (`{voices: [{voiceId, soundId, startedAtMs, durationMs,
loop, onAir}]}`, the whole list on every change). Both go to every window.

**Remote intents** (`remote_control.rs`, `docs/remote-control.md`):
`soundPlay {soundId}` (press semantics) and `soundStop {soundId?}`,
debounced in their own bucket at 80 ms so a fast drummer still gets every
press. `remote.describe` gains `sounds: [{id, name, playing}]`.

**Phone (LAN) leak argument**, which the PR repeats: ids are opaque UUIDs;
names are labels the streamer typed for sounds they play to viewers; no
file paths and no audio bytes cross the LAN; no route joins the LAN router
and nothing joins `LAN_EVENTS`. The intents ride the existing
`remote.intent` and `remote.describe`.

### UI

**Studio → Soundboard** (`components/studio/soundboard-section.tsx`, in
`StudioDashboardBottomRow` after `ScenesGallery`, so audiocn stays in the
deferred chunk):

- `PanelSection title="Soundboard"`, the description from "What the user
  will see", and one action: "Stop all" (ghost; disabled while nothing
  plays, with its `DisabledReason`).
- `SoundPadGrid columns={6}`, `size="sm"` pads (64 px), `rounded-row`.
  Each pad: `SoundPadLabel` (the name), `SoundPadShortcut` (the key, when it
  has one) and `SoundPadProgress` fed by a frame source from the voice's
  `startedAtMs` and `durationMs` (a loop shows no progress). `playing` comes
  from `sounds.playback`. Accessible name: "Play Airhorn" (or "Stop Airhorn"
  for a playing Play/stop or Loop pad).
- Keys: `1`–`9` with no modifier press the sound with that key while Studio
  is the page in front, through a guard that copies `spaceShortcutBlocked`
  (a focused field, an open dialog or menu, a stage gesture). The grid's own
  hotkeys stay off, so there is one listener. While held, a key's release
  stops a While held sound.
- Empty: `Empty` with "No sounds yet." and an "Add in Assets" action.
- Disconnected: pads disabled with the connection reason, like Takeover.

**Assets → Sounds** (`components/assets/sounds-section.tsx`, after
Takeovers):

- `PanelSection title="Sounds"`, description "{n} sounds · up to 30 seconds
  each · WAV, MP3, M4A, OGG or FLAC.", action "Import sounds…" (multi-select
  picker).
- One `GroupedList` row per sound: a play/stop `Button` (`icon-xs`), the
  name, the duration ("1.6 s", tabular), Mode (`Select` `xs`: Play once,
  Play/stop, Loop, While held), Volume (audiocn `Fader`, −24..+6 dB, 1 dB
  steps), Key (`Select` `xs`: None, 1–9; picking a taken key moves it), and
  a `KebabMenu`: Rename…, Move up, Move down, Remove.
- Remove waits behind an Undo toast ("Removed Airhorn", 5 s,
  `holdUndoableAction`) before `sounds.delete` runs.
- "Restore starter sounds" (ghost) under the list while any starter is
  missing.

**Sources → Sounds** (`SourceItem` in the Audio column, after System
audio): the title "Sounds", the Level `Fader` (−24..+12 dB) with the meter
from `audio.levels.sounds`, and the "Hear sounds yourself" `SettingsRow`
switch with the headphones line.

**Stream Manager** (S9): a "Sounds" `StatusBarAction` ("Play a sound (or
type /sound)") opens a `Popover` with the same grid at 4 columns and Stop
all; below 640 px it folds into the ⋯ menu as "Sounds…". The composer
accepts `/sound <name>` (case-insensitive prefix, the first match in board
order) and `/sound stop`; an unknown name says "No sound called
'{name}'.".

**⌘K** (S10): "Play sound: {name}" per sound (with its key chip) and "Stop
all sounds".

### Copy (verbatim)

| Where | String |
| ----- | ------ |
| Studio section | "Soundboard" |
| Studio idle line | "Only you hear sounds until you record or go live." |
| Studio session line | "Sounds play in your recording and stream." |
| Studio session line, monitor off | "Sounds play in your recording and stream. You don't hear them yourself." |
| Studio empty | "No sounds yet." / "Add in Assets" |
| Stop button | "Stop all" |
| Assets section | "Sounds" / "Import sounds…" / "Restore starter sounds" |
| Modes | "Play once", "Play/stop", "Loop", "While held" |
| Sources row | "Sounds" / "Level" / "Hear sounds yourself" / "Use headphones, or your microphone may pick the sound up again." |
| Undo toast | "Removed {name}" with "Undo" |
| ⌘K | "Play sound: {name}", "Stop all sounds" |

## Slices: Phase 1

### S0: Owner decisions

Taken on the recommended defaults (D1–D9). Record any later owner change
here before the slice it touches.

### S1: Starter sounds, `gpt-5.5`

- Add the twelve files, `manifest.json`, `LICENSES.md`,
  `scripts/build-starter-sounds.mjs` with `pnpm sounds:build-starters`, and
  the manifest test (`scripts/build-starter-sounds.test.mjs`, in
  `pnpm test:scripts`).
- Processing per file: decode the Freesound HQ preview, trim silence, cut
  to at most 5 s with a 300 ms fade-out where it was longer (Applause,
  Crickets), a 5 ms fade-in, Opus 128 kb/s 48 kHz stereo. No loudness
  change here: the import levels every sound the same way (D5).
- Package the folder in `electron-builder` `extraResources` and resolve it
  in dev from the repo.
- **Done when**: `pnpm test:scripts` passes the manifest test, and the
  packaged-resource path test resolves the folder in dev and packaged mode.

### S2: Backend store, import and RPCs, `fable-5`

- `sound_store.rs`: the `sounds` and `sound_settings` tables and their
  migration, the managed `userData/Sounds` directory, the WAV reader, trim,
  limits and refusals, `sounds.list/import/seedStarters/update/reorder/delete/settings`
  on their lanes, and `sounds.changed`.
- `sound_loudness.rs`: BS.1770-4 integrated loudness and the D5 level.
  Tests: a 1 kHz sine at −20 dBFS on both channels reads −20.0 ± 0.1 LUFS
  (−23.0 ± 0.1 on one channel); silence is ungated; a 100 ms tone is
  measured as one block; the level never pushes the peak over −1 dBFS.
- Import tests through a real FFmpeg (skip with a reason when none is on
  the test machine): WAV, MP3 and Opus in, 48 kHz stereo s16 out, trimmed;
  a 31 s file refused; a video file with no audio refused; 25th sound and
  5-minute refusals.
- **Done when**: the targeted `cargo test -p videorc-backend sound_` tests
  pass and clippy is clean on the new modules.

### S3: Player and the bus mixer, `fable-5`

- `sound_player.rs`: library, voices, press logic, end timers,
  `sounds.play/press/stop`, `sounds.playback`.
- `sound_mix.rs`: `SoundVoices` (pure) with tests: placement at the press
  sample, a late press starts at the cursor, restart ramps the old voice
  out over exactly 240 frames, loop wraps sample-exact, eight-voice cap,
  `None` when idle, gain arithmetic.
- `session_audio.rs`: `SoundCommand`, `SessionAudio::soundboard()`, the
  third mix ingredient, `mixing` extended, drain silence, `BusLevels.sounds`
  and `AudioLevelsEvent.sounds`. Tests: the mic-only golden SHA unchanged;
  a session with sounds armed and none played writes the same bytes; a
  played sound appears at the expected sample in the written chunk and is
  absent from both ISO tap outputs and the caption observer.
- **Done when**: the targeted `session_audio`, `sound_` and
  `source_audio_tap` tests pass.

### S4: Contracts, main process and asset protocol, `gpt-5.5`

- `shared/backend.ts` types, `backend-rpc-contract.ts` schemas, the
  fixtures (`sound.minimal`, `sound.starter`, `soundboardState.default`,
  `soundsPlayback.twoVoices`) and the Rust↔TS parity test rows.
- Main: `sounds:pick-files` (multi-select, audio extensions),
  `sounds:starter-files`, and `videorc-asset://sound/<file>`
  resolving only inside `userData/Sounds`.
- **Done when**: `pnpm typecheck` and the contract and fixture tests pass.

### S5: Renderer data and the monitor, `opus-4.8`

- Vendor `@audiocn/sound-pad` with the shadcn CLI (`docs/audiocn.md`
  Updating, steps 1–5); add it to `OFF_TIER_RADIUS_ALLOWLIST` with its
  reason, and to `docs/audiocn.md` "What is installed".
- `hooks/use-soundboard.tsx`: the state from `sounds.list` and
  `sounds.changed`, playing voices from `sounds.playback`, and actions.
  Only lazy chunks import it.
- `lib/sound-monitor.ts` and its start in the main window, with tests for
  the play/stop decisions and the gain.
- **Done when**: the desktop unit tests for the hook and monitor pass, and
  `pnpm build && pnpm check:renderer-assets` stays under the eager budget.

### S6: Studio Soundboard, `opus-4.8`

- The section, the key listener, empty and disconnected
  states, with DOM contracts `data-videorc-soundboard`,
  `data-videorc-sound-pad="<id>"` and `data-playing` for smokes.
- **Done when**: its unit tests pass and a by-eye in both themes (dark and
  light) shows monochrome pads with the chrome playing ring.

### S7: Assets → Sounds and Sources → Sounds, `opus-4.8`

- The Assets section, rows, Undo remove, Restore starter sounds; the
  Sources row with Level, meter and the monitor switch.
- **Done when**: unit tests pass, and the style, copy and shortcut guards
  pass.

### S8: Smokes and docs, `gpt-5.5`

- `pnpm smoke:soundboard-fixture` (`scripts/smoke-soundboard-fixture.mjs`):
  the real bus with a silent microphone and a 1 kHz fixture sound pressed
  at a known time, encoded through the production muxer; hard-fails a
  missing tone, a tone more than one chunk plus 5 ms from its expected file
  time, a tone in the Microphone ISO file, clipping, or an analyzer failure.
  Part of `smoke:recording-studio`.
- `pnpm smoke:soundboard` (`scripts/smoke-soundboard-app.mjs`): the dev
  app, Record through remote intents, `soundPlay` at 3 s, and System audio
  on when the grant exists: the tone once in the file (never doubled, the
  same length and level as without System audio), starting within
  −300..+300 ms of the press. That window is the wall-clock mapping's
  (plan 069's anchor at `recording.status(recording)`); the exact placement
  gate is the fixture smoke's. Missing grant: the System audio case SKIPS
  with the reason.
- Docs: `docs/soundboard.md`, `CONTEXT.md` (Sound, Soundboard),
  `docs/remote-control.md`, `docs/audiocn.md`, AGENTS.md (when to run the
  two smokes).
- **Done when**: both smokes pass on this Mac, or the app smoke's blocker is
  written down with the fixture smoke passing.

## Slices: Phase 2 (same PR, after Phase 1 is written)

### S9: Stream Manager and `/sound`, `opus-4.8`

- The status-bar action and popover, the relay to Studio (the
  `banner-commands` recipe), `/sound`, its composer hint, and the narrow ⋯
  fold.
- **Done when**: unit tests pass and `pnpm probe:comments-window` passes at
  every width.

### S10: ⌘K, Stream Deck and phone, `gpt-5.5`

- ⌘K commands; `soundPlay`/`soundStop` intents end to end (backend
  allowlist, renderer executor, `remote.describe`); a Stream Deck "Play
  sound" action with a picker; the phone's Sounds grid.
- **Done when**: `pnpm smoke:remote-control` and `pnpm smoke:remote-lan`
  pass with the new intents.

## S11: Gates (once, at the end)

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:scripts`,
  `pnpm --filter @videorc/desktop test`, `pnpm build`,
  `pnpm check:renderer-assets`.
- `cargo fmt --check --all`, `cargo clippy -p videorc-backend -- -D warnings`,
  targeted `cargo test -p videorc-backend` (session_audio, sound_,
  source_audio_tap, remote_control, storage; the owner's rule is no full
  suite locally).
- `pnpm smoke:soundboard-fixture`, `pnpm smoke:soundboard`,
  `pnpm smoke:separate-source-fixture`, `pnpm smoke:record-latency:gate`,
  `pnpm smoke:remote-control`, `pnpm smoke:remote-lan`,
  `pnpm probe:comments-window`.
- Owed to the owner: by-ear on the twelve starters and the loudness target,
  by-eye in both themes, and a real take with a pad in a livestream.

## Out of scope

- Viewers triggering sounds (channel points, bits, chat votes). A natural
  next plan once the player exists.
- Buddy voice ("Buddy, play airhorn") and per-sound global shortcuts (D9).
- Dropping audio files on the board or on Assets. No drop bridge exists
  (PR #704's takeover drop is unmerged), and a renderer-supplied path needs
  its own security review. Import goes through main's picker only.
- A Sounds ISO file (D6), ducking the microphone under sounds, effects,
  pitch, pan, or editing a sound's start and end in Videorc.
- Music beds and DMCA warnings: a 30-second cap keeps the board for
  effects.
- Sounds in the pre-session Clips ring (PR #694).

## STOP conditions

- The mic-only golden SHA changes, or a session with no sound played writes
  different bytes than before.
- A sound reaches the Microphone ISO file, captions, Buddy's ears or the
  echo guard.
- The fixture smoke places the tone more than one chunk plus 5 ms from
  where the press was.
- With System audio on, a monitored sound is in the file twice.
- `smoke:record-latency:gate` regresses past its budgets.
- The eager renderer budget is exceeded.

## Performance budget

- Bus thread: summing at most 8 voices into a 480-frame chunk is under
  10 µs; no I/O, no lock beyond `try_recv`, no allocation when idle.
- Memory: resident PCM at most 58 MB (D8), loaded lazily per sound.
- Renderer: the pads repaint only on `sounds.playback`; progress is a frame
  source, no React renders per frame, and it leaves the frame loop when
  nothing plays.

## In-flight work on these files

- PR #694 (Clips, open): `session_audio.rs` is untouched by it, but the
  remote intents, Stream Manager status bar, composer and ⌘K lists are.
- Plan 188 (polls, executing): `remote_control.rs`, the Stream Manager status
  bar and composer, ⌘K, `backend-rpc-contract.ts`.

## Model lane note

S2 and S3 run on `fable-5` in their own worktree; S5–S7 and S9 on
`opus-4.8` in another; the orchestrator owns S0, S1, S4 (the pinned
contract, first), S8, S10 wiring, the integration and the gates.

## As built (2026-10-23, branch `plan-189-soundboard`)

Every slice, both phases, on the recommended defaults (D1–D9). Three
worktrees were merged: the backend (S2, S3, the S10 intents and the S8
fixture smoke), the main process and renderer (S4 main side, S5–S7, S9,
S10), and the starters, app smoke and docs (S1, S8).

**Differences from the plan:**
- Starters seed through `sounds.import` with `starter`, then
  `sounds.settings {startersSeeded}`, instead of a separate
  `sounds.seedStarters`. Main adds `sounds:starter-list`, so "Restore starter
  sounds" can find the missing slugs without issuing twelve capabilities.
- Dropping files to import is out of scope: no drop bridge exists.
- The 50 MB refusal reads "This file is too large. Use one under 50 MB."
  The backend's "Sound not found." shows as "That sound isn't available
  anymore."
- The Sources fader reads "Level", like System audio's fader. `CONTEXT.md`
  calls a fader "Gain"; both audio rows match each other, not the glossary.
- A While held sound pressed from the Stream Deck or the phone plays to its
  end: `describe` carries no mode, so a remote has no release to send.
- The monitor keeps at most 64 MB of decoded audio, least recently played out
  first.
- **Eager budget.** Main already sat 196 bytes under the 390,000 gzip ceiling,
  and this branch added 1,175. The limits were not raised. The YouTube icon
  and the six X kit files now load as files in the React marks
  (`?no-inline`). The highlight card, which reads its canvas back on a
  file:// page, keeps data URIs through the lazy `lib/brand-mark-data.ts`.
  Eager JS: main 1,945,136 raw / 389,804 gzip; this branch 1,943,019 /
  389,295.
- On the both-theme by-eye, "Stop all"'s outline stop square read as a
  checkbox. It now uses the filled weight, like Stop recording.

**Gates (this Mac, 2026-10-23):**
- typecheck, lint (0 errors; one existing warning in untouched captions
  code), format:check: pass.
- `test:scripts`: 2,473 pass.
- Desktop: 5,172 pass.
- `build` and `check:renderer-assets`: pass.
- Rust: `cargo fmt --check` and clippy `-D warnings` pass. The targeted
  `cargo test` (sound, session_audio, source_audio_tap, storage,
  remote_control, remote_lan, protocol, websocket, audio_levels) passes 405.
  The mic-only golden SHA tests are unchanged, and a session with the board
  armed but no press writes the same bytes.
- `smoke:soundboard-fixture`: PASS. The press was placed at its exact sample
  (48,109); after AAC the onset is 42 frames from it; the Microphone file is
  silent.
- `smoke:soundboard`: PASS on all three cases:
  - idle: monitor only;
  - on-air: starts 3 ms after the press and lasts 600 ms;
  - system-audio: ran with the grant, and the sound is not doubled.
- `smoke:separate-source-fixture`, `smoke:remote-control`,
  `smoke:remote-lan`, `probe:comments-window`,
  `smoke:record-latency:gate` and `smoke:comment-highlight-stream`: PASS.
- Stream Deck plugin: tests and build pass.

**Owed:**
- The owner's by-ear pass on the twelve starters and the −18 LUFS target.
- A by-eye of the Stream Manager's Sounds popover in both themes. Studio,
  Assets and Sources were checked in both.
- A packaged-app take, and a real livestream with a pad pressed.
- Windows and Linux on-device runs: the bus code is shared and CI compiles
  and tests it, but no soundboard run has happened off macOS.
