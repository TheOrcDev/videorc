# Live lab: owner hookup

Plan 176 (`plans/176-live-youtube-test-lab.md`) runs real, attended live
streams on the lab YouTube channel. This page is the one-time setup. The
skill `videorc-live-lab` uses it; it runs only when a live test is asked for.

**Never paste a key, token, secret or password into the chat.** Everything
secret goes in through `pnpm live:hookup` and lands only in
`~/.videorc-live-lab/config.json` (dir 0700, file 0600). The lab prints the
last 4 characters of a secret, never more.

## 1. Channel

The lab channel is `@VideorcApp` (change it with
`pnpm live:hookup --handle <@handle>`). In YouTube Studio check: live
streaming is enabled and the 24 h wait is over, the channel is **not**
"made for kids" (that turns chat off), and no live-streaming restriction
shows.

## 2. Stream keys

Studio > Create > Go live > Stream > create two persistent keys,
**Videorc lab** and **Videorc lab vertical**. Defaults: visibility Unlisted,
Auto-start on, Auto-stop on, chat on, slow mode 30 s, hold potentially
inappropriate messages.

Store each key straight from the clipboard. This works from Claude Code's
`!` prompt, which has no terminal for hidden input:

```sh
# Copy "Videorc lab" in Studio, then:
pnpm live:hookup --stream-key horizontal --from-clipboard
# Copy "Videorc lab vertical", then:
pnpm live:hookup --stream-key vertical --from-clipboard
```

The key is checked, saved, and then the clipboard is cleared. In a real
terminal (Terminal.app), `pnpm live:hookup --keys-only` asks for both with
hidden input instead; a blank answer keeps the stored key.

## 3. Lab Google Cloud project (about 15 min)

1. Create project `videorc-live-lab` and enable **YouTube Data API v3**.
2. Google Auth Platform > Audience: External, **Testing**. Add two test
   users: the Google account that owns the channel, and your personal
   account (the "viewer"; it needs a YouTube channel of its own to chat).
3. Data Access: add `https://www.googleapis.com/auth/youtube.force-ssl`.
4. Clients: create a **Desktop app** client and click **Download JSON**.
5. Import it, then delete the downloaded file:

```sh
pnpm live:hookup --client-json ~/Downloads/client_secret_XXXX.json
```

(Or `pnpm live:hookup --client` in Terminal.app to type the id and a hidden
secret.)

## 4. Authorize the two accounts

```sh
pnpm live:hookup --role broadcaster   # sign in as the channel account, pick @VideorcApp
pnpm live:hookup --role viewer        # sign in as your personal account
```

Each opens Google consent in the browser and waits on a 127.0.0.1 loopback
port (PKCE, offline access, up to 5 minutes). The broadcaster must come back
as the lab channel and the viewer as any other channel, or nothing is saved.
Testing-mode refresh tokens expire after 7 days: `live:doctor` warns on day
6, and you rerun the `--role` command.

## 5. This Mac

- A lab display: BetterDisplay virtual screen (or an HDMI dummy plug). It
  must not be the main display. If its name does not say "virtual" or
  "dummy", name it: `pnpm live:hookup --lab-display "<name as macOS shows it>"`.
- `brew install yt-dlp ffmpeg blackhole-2ch` (BlackHole asks for your
  password and may need a Core Audio restart).
- Grant the Videorc build under test Screen Recording, Microphone and System
  Audio once. Turn on a Focus mode during runs.

## 6. Check it

```sh
pnpm live:doctor
```

PASS / WARN / FAIL / SKIP per check, non-zero exit on any FAIL. It spends 2
lab quota units (one `channels.list` per role). Checks for parts not built
yet (lab quota counter, build under test and its TCC grants, network fault
rules) print SKIP with the slice that adds them.

`pnpm live:hookup --show` prints what is stored, fingerprints only.

## 7. Go windows

Tell Claude when it is OK to go live. Claude never starts a run on its own.

Set `VIDEORC_LIVE_LAB_DIR` to use another config folder (the unit tests do).

## 8. Test card and scripted speech (plan 178 U7)

The lab streams a test card, not a desktop. `lib/card-server.mjs` serves
`scripts/live-lab/card/` on `127.0.0.1` (no build step, no network assets,
strict CSP) and pushes the card state over SSE. Look at it locally with:

```sh
node scripts/live-lab/card.mjs --demo     # prints http://127.0.0.1:<port>/
```

What viewers see: run id, scenario, app version, uptime, step, a large UTC
clock with milliseconds, a dot that never stops moving, sparklines (memory
per process, bitrate, dropped frames, encoder speed), the last 5 health
event codes, the open incident count, and an "Automated test" label. Only
allowlisted fields reach the page (`lib/card-state.mjs`); anything shaped
like a key, token, email, stream URL or home path is dropped before it is
drawn, and `card-view.test.mjs` fails if a hostile fixture leaks.

**Sync pulse.** On every 10 s wall-clock boundary the whole card flashes
white for 50 ms and the page plays a 1 kHz click (the same stimulus as
`scripts/lib/av-sync-stimulus.mjs`), so `node scripts/measure-av-sync.mjs
<recording>` measures lip sync on any recording or pulled clip. The click is
audio played by the page, so:

- Open the card in Chrome with `--autoplay-policy=no-user-gesture-required`
  (fullscreen or `--app` on the lab display, `--force-device-scale-factor=1`).
- The click must reach Videorc as **captured system audio**: turn System
  audio on in the lab profile and keep the Mac's default output a real
  device (the HDMI dummy or speakers), never BlackHole. BlackHole is the
  microphone and carries only the scripted speech.
- The stream mixes the microphone in, and `measure-av-sync` pairs any sound
  onset within 500 ms of a flash. So scripted speech never plays within 1 s
  of a pulse: wait `speechStartDelay(Date.now(), durationMs)` (from
  `lib/speech.mjs`) before each phrase.
- The page reports each pulse to `POST /pulse` (audio state, focus,
  visibility); `card.lastPulse()` proves the card is running with live audio.

**Markers.** `card/markers.json` documents fixed regions drawn in pure
black and white above the flash layer: four corner fiducials (distinct L
patterns, so a mirrored or flipped frame fails), a 4-bit scene id code and a
10-bit step code (guard, data MSB first, even parity, guard). The harness
sets them with `card.setStep({ index, total, name, sceneId })`.
`decodeMarkers(rgbFrame, width, height)` in `lib/card-markers.mjs` reads
them from an rgb24 frame (`ffmpeg -pix_fmt rgb24 -f rawvideo`) without OCR
and reports `{ ok, aligned, step, sceneId, flash }`.

**Speech.** `lib/speech.mjs` renders phrases with `say -o` and plays them
into `BlackHole 2ch` with ffmpeg's AudioToolbox output
(`-f audiotoolbox -audio_device_index N`, the index looked up by device
name). Nothing extra to install: ffmpeg is already a lab dependency,
`afplay` cannot choose a device, and switching the system output would move
the card's click too. Each play is logged as
`{ phraseId, text, playedAt, endedAt, device }` (no file paths).
`scripts/live-lab/phrases.json` holds the voice command phrases, copied
from the parser tests in `cohost_command.rs` and `clip_marks.rs`
(`phrases.test.mjs` fails if they drift), and plain caption phrases.
