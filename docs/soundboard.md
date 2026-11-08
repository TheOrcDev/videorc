# Soundboard

The soundboard plays short sounds into your recording and every livestream:
an airhorn, applause, a laugh track (plan 189). It is free for everyone.

## Using it

- **Play** in Studio → Soundboard, under Scenes: click a pad, or press its
  key (1–9) while Studio is in front. A thin bar shows how far a sound has
  played. "Stop all" stops every sound. While you're recording or live, the
  Stream Manager's **Sounds** action, `/sound <name>` or `/sound stop` in the
  chat composer, ⌘K ("Play sound: Airhorn", "Stop all sounds"), a Stream
  Deck **Play sound** key and the phone remote play the same sounds.
- **Where it goes**: while you record or stream, a sound goes into the
  recording and every stream, at the moment you pressed it. Between
  sessions only you hear it, so you can try sounds out.
- **Manage** in Assets → Sounds: "Import sounds…" takes WAV, MP3, M4A, OGG
  or FLAC, up to 30 seconds each, 24 sounds and 5 minutes in all. Each row
  sets the sound's name, volume, key and how a press plays it:
  - **Play once**: every press plays it from the start;
  - **Play/stop**: a press starts it, the next press stops it;
  - **Loop**: like Play/stop, and it repeats until stopped;
  - **While held**: it plays while you hold the pad or the key.
  Remove has an Undo. "Restore starter sounds" brings back any of the
  twelve starters you removed.
- **Level** on Sources → Sounds, beside Microphone and System audio: the
  soundboard's Level, its meter, and **Hear sounds yourself** (on by
  default). Off, you don't hear sounds while recording or live, but your
  viewers still do. Use headphones: through speakers your microphone may
  pick a sound up a second time.
- **Even loudness**: Videorc measures every sound when you add it and
  levels it to the same loudness (−18 LUFS, never more than +12 dB and
  never past −1 dBFS), so pads don't jump in volume. Each sound's Volume
  and the board's Level adjust from there.
- **Starter sounds**: Airhorn, Applause, Laugh, Rimshot, Sad trombone,
  Drumroll, Tada, Buzzer and Ding (keys 1–9), then Crickets, Boom and Woah.
  All are CC0 from Freesound
  ([licences](../apps/desktop/resources/sounds/starter/LICENSES.md)).
- Sounds are in the combined recording and every stream. They are not in
  the separate Microphone or System audio files, captions never transcribe
  them, and Buddy never hears them.

## For developers

**One owner.** The backend owns the sounds (SQLite `sounds` and
`sound_settings`, files in `userData/Sounds/<id>.wav`, 48 kHz stereo s16,
trimmed) and their playback (`sound_player.rs`). The Studio renderer owns
the socket; the Stream Manager never calls the backend and relays through
main (`shared/sound-commands.ts`, the banners recipe). Wire shapes are
pinned in `protocol-fixtures/high-risk-contracts.json` → `sound`.

**Import** (`sounds.import`, the `AssetImport` lane): main's picker issues a
single-use `input-file` capability; the backend decodes the file with the
bundled FFmpeg (never the Windows capture-worker build) to 48 kHz stereo,
trims near-silence at both ends, measures BS.1770-4 integrated loudness
(`sound_loudness.rs`) and stores the level as `levelDb`. Refusals are
verbatim sentences, shown as warnings.

**Playback.** A press arrives as `sounds.play` (a pad, which already
applied its mode) or `sounds.press` (a key, a remote, `/sound`: the backend
applies the mode). The player keeps at most 8 voices and emits the whole
list as `sounds.playback` on every change. During a session it hands each
voice to the session audio bus (`SessionAudio::soundboard()`):

- the voice starts at the sample of the press,
  `(received_at - epoch) * 48000`, which is ahead of the bus cursor by the
  playout delay, so the sound lands on the frame the streamer saw;
- `sound_mix.rs` renders the voices into each 10 ms chunk as a third mix
  ingredient, summed before the limiter, after the microphone ISO tap, the
  echo guard, the caption tap and `record_live_peak` (none of them hear
  sounds); the master meter does, and `audio.levels` carries `sounds`;
- with no voice the renderer returns `None` and the bus writes exactly what
  it wrote before: the mic-only SHA golden test holds.

**The monitor** (`lib/sound-monitor.ts`) runs in the main window only and
plays each voice from `sounds.playback` through Web Audio, from the same
WAV (`videorc-asset://sound/<file>`), at the same gain. It plays between
sessions always, and during one when "Hear sounds yourself" is on. Renderer
audio is kept out of System audio capture already (macOS: Electron's audio
service runs in the excluded main process; Windows: the loopback excludes
the Electron process tree), so a monitored sound is in a recording once.

**Starter sounds** live in `apps/desktop/resources/sounds/starter/` with
`manifest.json` (source page, author, licence, hash, processing) and a
generated `LICENSES.md`. `pnpm sounds:build-starters` rebuilds them
reproducibly; `scripts/lib/starter-sounds.test.mjs` pins every hash and
refuses anything that is not CC0 from a Freesound page. The main window
imports them once per profile (`sounds:starter-files`, then
`sounds.import` with `starter`, then `sounds.settings {startersSeeded}`).

**Proof.** `pnpm smoke:soundboard-fixture` (the real bus, a fixture press,
placement within one chunk plus 5 ms, never in the Microphone file) is part
of `smoke:recording-studio`. `pnpm smoke:soundboard` drives the dev app:
idle presses are monitor-only, a press lands once in a recording, and with
System audio on the monitor never doubles it.
