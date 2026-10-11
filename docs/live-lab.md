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
lab quota units (one `channels.list` per role), charged to the lab quota
ledger (`quota-ledger.json` next to the config, 0600, per Pacific day, cap
8,000 units); "lab quota today" warns from 75% and fails when the day is
spent. Checks for parts not built yet (build under test and its TCC grants,
network fault rules) print SKIP with the slice that adds them.

`pnpm live:hookup --show` prints what is stored, fingerprints only.

## 7. Go windows

Tell Claude when it is OK to go live. Claude never starts a run on its own.

Set `VIDEORC_LIVE_LAB_DIR` to use another config folder (the unit tests do).

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
