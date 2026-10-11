# Live lab machine: the one-time visit

Plan 178 (`plans/178-unattended-live-lab.md`) runs Videorc live on
`@VideorcApp` with nobody at the machine. This page is the owner's one-time
setup of that Mac (about 30 minutes at the console) and what `pnpm
live:doctor` checks afterwards. The attended hookup (channel, keys, lab
Google project, consent) is in `docs/live-lab.md` and is done on this machine
too, as the lab user.

**Never paste a key, token, secret or password into a chat.** Secrets go in
through `pnpm live:hookup` only. Nothing on this machine is personal: no
iCloud, no browser sign-ins, no password manager, no owner data. Everything
on its screen can end up on a public stream.

## What the policy file is

`/Library/Application Support/VideorcLab/policy.json` is the owner's standing
authorization. The harness refuses to start, and ends a running stream
within 60 s, when the policy is missing, invalid, or writable by the lab
user, when `enabled` is false, when `control.json` in the reports repo says
`{"enabled": false}` or cannot be read for 5 minutes while live, when
`~/videorc-live-lab/STOP` exists, or when a run would exceed its minutes,
the daily run count, the quota, or the allowed visibility and build. The
file belongs to the admin account and is read-only to the lab user, so
nothing running as the lab user (harness, agent, scheduled tick) can widen
it. A writable policy is a refusal, not a warning.

## 1. Accounts

Do these as the admin (owner) account, which already exists on the Mac.

1. System Settings > Users & Groups > Add User: **Standard** account, name
   `Videorc Lab`, account name `videorc-lab`, a long random password kept
   in the owner's password manager (never on this machine).
2. Users & Groups > Automatic login: `videorc-lab`. This needs FileVault
   off (Privacy & Security > FileVault). Accepted trade-off: the disk holds
   no personal data, only lab secrets that `live:hookup` can rotate.
3. Log in as `videorc-lab` for every step below unless it says admin.

## 2. The lab user's session

As `videorc-lab`:

- Lock Screen: "Start Screen Saver when inactive" Never; "Turn display off
  when inactive" Never; "Require password after screen saver begins or
  display is turned off" Never. Then in Terminal:
  `sysadminctl -screenLock off -password -` (asks for the lab password).
- Displays: the HDMI dummy plug is the only display, or the dummy plus a
  monitor. If a monitor stays attached it is **never** captured: make the
  dummy the lab display (`pnpm live:hookup --lab-display "<name>"`) and
  keep the monitor as the main display so the menu bar lives there.
- Focus: Control Center > Focus > Do Not Disturb > **until turned off**.
  It must stay on; the doctor fails when it is off.
- Notifications: everything off that can show a banner (Tips, Screen Time,
  Software Update).
- General > Software Update > Automatic updates: all off. Updates happen
  on the owner's terms, never mid-stream.
- Energy (admin, in Terminal): `sudo pmset -a displaysleep 0 sleep 0
disksleep 0 womp 1 autorestart 1`. The doctor fails when either sleep is
  not 0.
- No iCloud sign-in, no Apple ID, no browser profiles signed in, no password
  manager, no Mail.
- Sharing: Remote Login on, for `videorc-lab` only. Password login off, key
  login only: `/etc/ssh/sshd_config.d/videorc-lab.conf` with
  `PasswordAuthentication no`, `KbdInteractiveAuthentication no`,
  `AllowUsers videorc-lab`. Install the owner's public key in
  `~videorc-lab/.ssh/authorized_keys` (0600, dir 0700).
- Tailscale (brew install --cask tailscale, sign in with the lab's tailnet
  identity, key expiry disabled for this node in the admin console). The
  Mac is reached only over Tailscale; nothing is exposed to the LAN or
  the internet.

## 3. Tools

As `videorc-lab`:

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node pnpm ffmpeg yt-dlp gh blackhole-2ch
gh auth login        # device flow in the browser; the lab GitHub identity, not the owner's
git clone https://github.com/TheOrcDev/videorc.git ~/videorc
cd ~/videorc && pnpm install --frozen-lockfile
mkdir -p ~/videorc-live-lab/logs
```

`gh` needs the `repo` scope: write on the reports repo (`control.json`,
reports) and issue read/write on `TheOrcDev/videorc`. Use a fine-grained
token or a dedicated lab GitHub account, never the owner's personal
token. BlackHole asks for the admin password once and may need
`sudo killall coreaudiod`.

No Developer ID certificate goes on this machine, ever. Candidates are
signed in CI (U5) and pulled with `gh`. The doctor fails when
`security find-identity -v -p codesigning` lists a Developer ID.

## 4. Videorc

As `videorc-lab`:

1. Install the public release from videorc.com, launch it once, and grant
   Screen Recording, Microphone and System Audio when asked (System
   Settings > Privacy & Security). The Developer ID signature keeps the
   same designated requirement across versions, so these grants survive
   updates and signed candidates.
2. Quit it. The harness launches it with the lab profile and the debugging
   port; never use this install for anything personal.

## 5. Hookup and doctor

At the console (Google consent needs a browser), follow `docs/live-lab.md`
sections 1 to 5 as `videorc-lab`:

```sh
cd ~/videorc
pnpm live:hookup --client-json ~/Downloads/client_secret_XXXX.json   # then delete the file
pnpm live:hookup --stream-key horizontal --from-clipboard
pnpm live:hookup --stream-key vertical --from-clipboard
pnpm live:hookup --role broadcaster
pnpm live:hookup --role viewer
pnpm live:hookup --lab-display "<dummy display name>"
```

Decision D2: put the lab Google project **in production, unverified**, so
refresh tokens do not die every 7 days. The doctor then reports an old
token as WARN when the refresh still works. In YouTube Studio, turn on
Dual stream for the "Videorc lab vertical" key once (no API exists).

## 6. The policy file (admin)

As the admin account, in Terminal:

```sh
sudo mkdir -p "/Library/Application Support/VideorcLab"
sudo cp ~videorc-lab/videorc/config/live-lab/policy.example.json "/Library/Application Support/VideorcLab/policy.json"
sudo chown -R root:wheel "/Library/Application Support/VideorcLab"
sudo chmod 755 "/Library/Application Support/VideorcLab"
sudo chmod 644 "/Library/Application Support/VideorcLab/policy.json"
sudoedit "/Library/Application Support/VideorcLab/policy.json"   # set killSwitchUrl to the reports repo (D7), review the limits (D5)
```

The example matches plan 178's defaults (D5): Unlisted only, 8 on-demand
runs a day of at most 60 minutes, release and candidate builds, 8000 lab
quota units a day, zero shared-client units, no network faults, no camera,
no clip pulling. Edit it only as the admin and only on purpose; the lab user
must never be able to write it, and the doctor fails when it can. Keep the
`clipPull` key false until the YouTube Terms question is settled (U8).

Create `control.json` in the reports repo with `{"enabled": true}`. Flip it
to `false` from anywhere to stop every run within 60 s; the owner's
acceptance for plan 178 is exactly that flip.

## 7. Check it

As `videorc-lab`:

```sh
cd ~/videorc && pnpm live:doctor
```

The machine section runs by itself on this Mac (lab user, or policy file
present) and prints, besides the hookup checks:

| Check            | PASS means                                                     |
| ---------------- | -------------------------------------------------------------- |
| auto-login       | `autoLoginUser` is `videorc-lab`                               |
| screen lock      | `sysadminctl -screenLock status` says off                      |
| sleep            | `pmset -g`: displaysleep 0 and sleep 0                         |
| display awake    | at least one display online                                    |
| focus            | a Focus (Do Not Disturb) assertion is active                   |
| disk free        | over 100 GB in the lab home                                    |
| signing identity | no Developer ID in the keychain                                |
| policy           | present, schema v1, not owned or writable by the lab user      |
| gh auth          | logged in; write on the reports repo, read on TheOrcDev/videorc |
| kill switch      | `control.json` fetched and `enabled: true`                     |
| run lock         | `~/videorc-live-lab/run.lock` free (stale or held is WARN)     |
| stop file        | `~/videorc-live-lab/STOP` absent                               |

Prove each one fails: turn the screen lock on (FAIL), `sudo chmod 666` the
policy (FAIL), unplug the dummy (FAIL), then put everything back and get all
PASS. The remaining SKIPs (quota counter, build under test, fault rules) are
filled by U8, U6 and U13.

## 8. Schedule (after U11 lands)

As `videorc-lab`:

```sh
cp ~/videorc/config/live-lab/com.videorc.live-lab.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.videorc.live-lab.plist
```

As admin, the weekly reboot: `sudo pmset repeat restart Sun 03:30:00`.

## Stopping everything

Any one of these ends a live stream within 60 s and refuses new runs:

- `control.json` in the reports repo set to `{"enabled": false}` (from
  anywhere, no SSH needed);
- `touch ~/videorc-live-lab/STOP` over SSH;
- `enabled: false` in the policy, as admin;
- ending the broadcast in YouTube Studio (read as an incident; nothing
  restarts until the next scheduled or requested run);
- Ctrl-C on an attended `live:run`.

Remove the STOP file or flip `control.json` back to start again.
