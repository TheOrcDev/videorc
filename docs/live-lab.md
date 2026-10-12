# Live lab: owner hookup

Plan 176 (`plans/176-live-youtube-test-lab.md`) runs real, attended live
streams on the lab YouTube channel. This page is the one-time setup. The
skill `videorc-live-lab` uses it; it runs only when a live test is asked for.

For the dedicated lab machine that runs unattended (plan 178), do this
hookup there as the lab user, then follow `docs/live-lab-machine.md` for the
accounts, auto-login, sleep, Focus, tools, the owner's policy file and the
doctor's machine section.

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
lab quota units (one `channels.list` per role), charged to the lab quota
ledger (`quota-ledger.json` next to the config, 0600, per Pacific day, cap
8,000 units); "lab quota today" warns from 75% and fails when the day is
spent. Checks for parts not built yet (build under test and its TCC grants)
print SKIP with the slice that adds them.

On the lab machine the "network faults" check (plan 178 U13) reads the lab's
pf anchor `com.videorc.live-lab` and dummynet pipe 2178 back with the allowed
`sudo -n` commands. A leftover rule or pipe is a FAIL with the two cleanup
commands, and the doctor flushes it itself when sudo lets it (then WARN: the
previous run leaked). With `faults.network` off and no sudoers file it prints
SKIP. Owner install, once, from the admin account: the root-owned rules file
(`config/live-lab/pf.anchor.example`, header has the commands), the two
`/etc/pf.conf` anchor lines, then `config/live-lab/sudoers.live-lab.example`
(`visudo -cf` first). The harness never writes pf rules and never runs a
command that is not in that file.

`pnpm live:hookup --show` prints what is stored, fingerprints only.

On the lab machine the doctor also runs the machine section (auto-login,
screen lock, sleep, display, Focus, disk, signing identity, policy, gh, kill
switch, run lock, STOP file); elsewhere it prints one SKIP line unless you
pass `--machine`. See `docs/live-lab-machine.md`.

## 7. Go windows

Attended (your Mac): tell Claude when it is OK to go live. Claude never
starts a run on its own.

Unattended (the lab machine): your policy file is the go. Claude may start
any run it allows, and reports a refusal instead of working around it. Stop
everything from anywhere with `control.json` `{"enabled": false}` or
`~/videorc-live-lab/STOP` on the lab machine.

Set `VIDEORC_LIVE_LAB_DIR` to use another config folder and
`VIDEORC_LIVE_LAB_WORK_DIR` for another run folder (the unit tests do).
`VIDEORC_LIVE_LAB_POLICY` points the doctor and the tests at another policy
file; a run never honours a policy the lab user could have written, whatever
its path.

## 8. Build under test (plan 178 U5)

`pnpm live:install` puts the build under test at `/Applications/Videorc.app`.
It installs only an app signed with the Videorc Developer ID (team
`C2PA37RB58`). Developer ID keeps the TCC grants from step 5 across builds;
an ad-hoc signed app is refused, because macOS would drop them.

```sh
pnpm live:install --build release                 # the public macOS feed, as the app's updater reads it
pnpm live:install --build candidate:<run-id|sha>  # a lab-candidate-macos.yml artifact
pnpm live:install --rollback                      # swap back to the app it replaced
```

- **release**: reads `https://www.videorc.com/api/updates/latest-mac.yml`,
  checks the zip against its sha512, then runs
  `codesign --verify --deep --strict` and `spctl -a -vv` (notarized).
- **candidate**: start a build of any branch, sha or same-repo PR head with
  `gh workflow run lab-candidate-macos.yml -f ref=<ref>`. It is signed in CI,
  not notarized, never uploaded anywhere but the Actions artifact
  `lab-candidate-<sha7>` (kept 7 days), and versioned `<base>-lab.<sha7>`.
  Fork PR heads are refused. The installer checks the run is green, the
  sidecar `lab-candidate.json` (sha, ref, version, zip sha256), the Team ID,
  and that the app has no quarantine flag.
- The previous app stays at `Videorc.previous.app`. Install and rollback
  refuse while Videorc runs from either path (checked with `lsof` on the
  bundle executables). The lab user must be able to write to
  `/Applications`.
- The record lands in `install.json` in the lab folder (version, sha,
  source, run, verifiedAt, and the app it replaced). `--app-path` installs
  somewhere else; `--json` prints the record.
- A candidate's version sorts below the release with the same base, so the
  app's background updater would replace it on quit. Launch candidates with
  `VIDEORC_DISABLE_AUTO_UPDATE=1`; the run harness (U6) has to set it.

Exit codes: 0 installed, 2 refused (the reason code is printed), 1 failed.

## 9. Test card and scripted speech (plan 178 U7)

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

## 10. On-demand runs and publishing (plan 178 U10)

From any dev machine with SSH (key login, Tailscale) to the lab user:

```sh
pnpm live:remote --host <lab> --scenario chat --build candidate:<sha> [--privacy unlisted] [--params '{"cycles":3}']
```

It checks out the harness (`--ref`, default `origin/main`) in `~/videorc`,
reinstalls dependencies only when the lockfile changed, installs the
candidate under the run lock, runs `live:run --trigger on-demand`, puts the
previous app back, and copies back only `verdict.json`, `report.md`,
`charts/` and `frames/` after the publish guard passes, into
`~/videorc-live-lab/remote-runs/<runId>`. SSH runs with `BatchMode=yes` and
no agent forwarding; no secret is ever on the command line. Exit codes:
run.mjs's 0 / 1 / 2 / 3, then 4 (copy-back failed or refused) and 5 (SSH or
setup failed before a run). Ctrl-C detaches; the run keeps going under the
lab's kill switches.

On the lab machine, `pnpm live:publish [--run <runDir>] [--since <iso>]
[--dry-run]` publishes every finished run without a complete
`published.json`: the guard (U9 `redact.mjs` plus `lib/publish-guard.mjs`,
fail closed), then the report, verdict, charts and frames to the reports
repo behind `killSwitchUrl` (`runs/<runId>/`), one `live-lab` issue per
incident signature in `TheOrcDev/videorc` (a repeat is a comment), a
Discord ping on a P0, the report link in the VOD description (51 lab
units, skipped when the ledger says no), and `published.json` (0600).
Boot doctor FAILs become `doctor:<check>` issues. Store the Discord webhook
with `pnpm live:hookup --discord-webhook` (from the clipboard; or set
`VIDEORC_LIVE_LAB_DISCORD_WEBHOOK`). `gh` on the lab machine needs write
access to the reports repo contents and to issues in `TheOrcDev/videorc`.
