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

## 8. Schedule

The schedule is one launchd agent in the lab user's GUI session
(`config/live-lab/com.videorc.live-lab.plist`). It runs
`scripts/live-lab/schedule.mjs tick` every 300 s and once at login. Each tick
reads the policy (`enabled` and `schedule.enabled` must both be true, slots are
read in `schedule.timezone`) and the table in `config/live-lab/schedule.json`
(D9):

| Local time | Slot           | What runs                                                |
| ---------- | -------------- | -------------------------------------------------------- |
| 04:00      | `update-check` | `live:install --build release` under the run lock        |
| 04:30      | `churn`        | `live:run --scenario churn --trigger schedule`           |
| 06:00      | `marathon`     | `live:run --scenario marathon` (`marathonHours` 4)       |
| 11:00      | `idle`         | `live:run --scenario idle`                               |
| 13:30      | `report`       | `live:publish --since <last good report>` (6 h window)   |

A slot runs once a day, inside its window (slot time plus 15 minutes unless
the table says otherwise). A slot whose window closes unrun (machine off,
asleep, or still busy with the run before it) is recorded as `missed` and
skipped; it never runs late. When the run lock is held (an on-demand run), the
slot is `deferred-lock` and retried on the next tick while its window lasts.
The tick runs each slot to completion; launchd never starts a second instance
of the agent while one runs (a `StartInterval` firing during a run is
skipped), and the tick holds `~/videorc-live-lab/schedule-tick.lock` against a
hand-typed `tick`. Scenario parameters reach `live:run` as JSON in
`VIDEORC_LIVE_LAB_SCENARIO_PARAMS`.

The report slot has a 6 h window so a long marathon cannot starve it. When the
marathon moves to 8 h (D9, after two weeks) it runs past 11:00 and the idle
slot is recorded as missed on those days; move idle in the table then.

Install it as `videorc-lab` (the command refuses any other user):

```sh
cd ~/videorc
pnpm live:schedule install-agent
```

It renders the template with this checkout's paths into
`~/Library/LaunchAgents/com.videorc.live-lab.plist`, creates
`~/videorc-live-lab/logs` (launchd does not create the folder of its log
file), lints the plist and runs `launchctl bootstrap gui/$(id -u)`. It refuses
while a run holds the run lock, because replacing the agent would kill the
run (`--force` overrides). `pnpm live:schedule uninstall-agent` boots it out
and removes the file.

Check it:

```sh
pnpm live:schedule status          # add --json for agents, --no-control offline
```

`status` prints today's and tomorrow's slots with their outcomes, the last 7
run folders with their verdicts, today's lab quota, the run lock, the STOP
file, `control.json`, the last tick and the last boot doctor. Files:

- `~/videorc-live-lab/schedule-state.json`: what ran on which day (14 days);
- `~/videorc-live-lab/logs/schedule.log`: the tick's own lines (launchd);
- `~/videorc-live-lab/logs/schedule-<date>.log`: each slot's full output
  (30 days kept);
- `~/videorc-live-lab/doctor/boot-<time>.txt`: the doctor run after each boot.

Weekly reboot, as the **admin** account (once):

```sh
sudo pmset repeat restart U 03:30:00
pmset -g sched                     # shows the repeating restart
```

`U` is Sunday. Auto-login brings the lab user's session back, the agent's
login tick runs `live:doctor` once for the new boot and keeps the output for
the next report, and the 04:00 slot follows as usual.

To pause the schedule without touching anything else, the owner sets
`schedule.enabled: false` in the policy; the tick then records
`schedule-disabled` and does nothing. The STOP file and `control.json` stop
scheduled runs the same way they stop any run.

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

## Linux lab machine (plan 179)

The same lab runs on a Linux box (`ogre`: Omarchy, which is Arch with
Hyprland). Every safety rule above holds unchanged: the owner's root-owned
policy, `control.json`, the STOP file, the run lock, the quota caps, secret
redaction, and nothing personal on the account the lab runs as. Only the
mechanics differ:

| Piece            | macOS lab                                         | Linux lab                                                                                    |
| ---------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Lab display      | BetterDisplay virtual screen or HDMI dummy        | Hyprland headless output `videorc-lab`                                                       |
| Screen grant     | TCC Screen Recording (once)                       | ScreenCast portal, answered by the lab share picker on every run                             |
| Lab mic          | BlackHole 2ch                                     | `videorc_lab_mic`, a remap source over the `videorc_lab_speech` null sink                    |
| Card's sync click | captured system audio                            | the lab mic (Linux Videorc has no system-audio capture yet)                                  |
| Speech           | `say` + ffmpeg AudioToolbox                       | `espeak-ng` + ffmpeg PulseAudio output into `videorc_lab_speech`                             |
| Keep awake       | `caffeinate`                                      | `systemd-inhibit` (sleep, idle, lid) for the run                                             |
| Policy           | `/Library/Application Support/VideorcLab/policy.json` | `/etc/videorc-lab/policy.json`                                                           |
| Network faults   | pf anchor + dummynet pipe 2178                    | root helper `/usr/local/sbin/videorc-lab-netfault`: nft table `inet videorc_lab` + tc prio/netem `2178:` |
| Schedule         | launchd agent                                     | systemd user timer `videorc-live-lab.timer`                                                  |
| Weekly reboot    | `pmset repeat restart`                            | system timer `videorc-lab-weekly-reboot.timer`                                               |
| Build under test | `/Applications/Videorc.app`, Developer ID checked | extracted AppImage in `~/.local/share/videorc-lab/Videorc`, hash checked                     |

Why not Xvfb: Linux Videorc captures a screen only through the
xdg-desktop-portal ScreenCast portal (`linux_portal_capture.rs`); it has no
x11grab path and never enumerates outputs itself. So the lab display is an
output of the real compositor, and the lab needs a logged-in Hyprland
session.

Why no restore token: a portal token is opaque, so one saved from a hand pick
could point at the real desktop. Every Linux run deletes the lab profile's
token and writes the lab output's name to `~/videorc-live-lab/portal-pick`
(always that path, even with `VIDEORC_LIVE_LAB_WORK_DIR` set, because the
picker runs in the portal's environment);
the lab share picker answers the portal with exactly that output, and the
file is removed at teardown. Without the file (any other app sharing the
screen, or no run) the picker hands over to the normal
`hyprland-share-picker`. A stale file can only ever share the lab output.

### L1. The lab account

Recommended: a dedicated account that is not in `wheel`/`sudo`, with nothing
personal in it (no browser sign-ins, no SSH keys of yours, no personal `gh`
token), exactly like the Mac.

```sh
sudo useradd -m -s /bin/bash videorc-lab
sudo passwd videorc-lab                   # long random password, kept in your password manager
sudo loginctl enable-linger videorc-lab   # its user manager (and the schedule timer) starts at boot
```

Running the lab as your own account works too: add `"labUser": "orcdev"` to
the policy. The doctor then WARNs that the account is an admin, and FAILs if
it has passwordless sudo, because then anything running as it could rewrite
the policy. Everything that account can read (browser sessions, keys, the
`gh` token) is in reach of the harness and the triage agent, so prefer the
dedicated account.

Auto-login into Hyprland as the lab account. On Omarchy (SDDM), as root:

```ini
# /etc/sddm.conf.d/autologin.conf
# Session: a file name from /usr/share/wayland-sessions, without .desktop.
[Autologin]
User=videorc-lab
Session=hyprland-uwsm
```

greetd (`[initial_session] user = "videorc-lab"`) and a getty
`--autologin videorc-lab` override are recognised too.

Disk encryption: Omarchy installs on LUKS, so every boot waits for the
passphrase at the console and an unattended reboot never comes back. The
doctor WARNs about it ("unattended boot"). Either skip the weekly reboot
timer below, or enrol the TPM (`sudo systemd-cryptenroll --tpm2-device=auto
<luks partition>`), which ogre cannot do (a T2 MacBook Pro has no TPM that
Linux can use).

### L2. The lab account's session

As root:

```sh
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

This also stops a closed lid from suspending (logind starts
`suspend.target`). The doctor fails while any of the four is not masked.

As the lab account:

- Stop `hypridle` for this account (Omarchy starts it from its Hyprland
  autostart; remove that line, then log out and back in). It would lock the
  session or power the outputs off between runs; a locked session draws the
  lock screen on every output, the lab output included. Runs also hold a
  systemd idle inhibitor, which hypridle honours.
- Notifications off: `makoctl mode -a do-not-disturb`, and make it stick by
  adding `exec-once = makoctl mode -a do-not-disturb` to the Hyprland config
  (dunst: `dunstctl set-paused true`; swaync: `swaync-client -dn`).
- SSH: key login only, as on the Mac (`/etc/ssh/sshd_config.d/videorc-lab.conf`
  with `PasswordAuthentication no`, `KbdInteractiveAuthentication no`,
  `AllowUsers videorc-lab`). `sudo -u` and `su` give no user bus: reach the
  account over SSH or with `sudo machinectl shell videorc-lab@`.

### L3. Tools

Arch / Omarchy:

```sh
sudo pacman -S --needed git nodejs pnpm ffmpeg yt-dlp github-cli espeak-ng chromium \
  nftables iproute2 wl-clipboard xdg-desktop-portal-hyprland
```

Debian / Ubuntu (the Hyprland lab display still needs Hyprland):

```sh
sudo apt install git ffmpeg gh espeak-ng nftables iproute2 wl-clipboard pipx
pipx install yt-dlp       # apt's yt-dlp is usually too old for YouTube
# Chrome: Google's .deb (the chromium snap cannot be driven reliably); node 24 via mise; corepack enable for pnpm
```

Node from mise works. The schedule unit pins the node binary it was
installed with, so rerun `pnpm live:schedule install-agent` after a node
upgrade. Then, as the lab account:

```sh
gh auth login        # the lab GitHub identity, never the owner's
git clone https://github.com/TheOrcDev/videorc.git ~/videorc
cd ~/videorc && pnpm install --frozen-lockfile
mkdir -p ~/videorc-live-lab/logs
```

### L4. The lab display, the screen grant and the lab audio

As the lab account, from `~/videorc`:

```sh
# Display: a 1920x1080 headless output far to the right of the real screen.
cp config/live-lab/linux/hyprland.videorc-lab.conf ~/.config/hypr/videorc-lab.conf
echo 'source = ~/.config/hypr/videorc-lab.conf' >> ~/.config/hypr/hyprland.conf
hyprctl reload && hyprctl output create headless videorc-lab
pnpm live:hookup --lab-display videorc-lab

# Screen grant: the lab share picker for xdg-desktop-portal-hyprland.
install -D -m 0755 config/live-lab/linux/videorc-lab-share-picker ~/.local/bin/videorc-lab-share-picker
cp config/live-lab/linux/xdph.conf.example ~/.config/hypr/xdph.conf   # fix the path if the home differs
systemctl --user restart xdg-desktop-portal-hyprland

# Audio: the speech sink and the lab mic.
mkdir -p ~/.config/pipewire/pipewire-pulse.conf.d
cp config/live-lab/linux/pipewire-pulse.videorc-lab.conf ~/.config/pipewire/pipewire-pulse.conf.d/videorc-lab.conf
systemctl --user restart pipewire-pulse
pactl get-default-sink; pactl get-default-source   # must be real devices, never the lab ones
```

The headless output must not hold focus (the doctor WARNs when it does): new
windows and notifications land on the focused output. The harness focuses it
only while it opens the card, makes the card fullscreen there (a run is
refused when it cannot), then gives focus back. `systemd-inhibit` holds
sleep, idle and the lid for the run; polkit may refuse it outside the seat's
active session (SSH, a user unit), which the run log says, and then the
masked sleep targets and the stopped hypridle are what keep the box awake.

### L5. The build under test

```sh
# The Linux Alpha AppImage, downloaded while signed in to videorc.com, with its
# .sha256 (or release.json) next to it; else pass --sha256 <hex>:
pnpm live:install --build file:~/Downloads/Videorc-<version>-linux-x64.AppImage

# Or a branch built on this box:
pnpm package:desktop:linux
pnpm live:install --build local:apps/desktop/release/linux-unpacked

pnpm live:install --rollback
```

`--build release` reads `latest-linux.yml` from the update feed and is refused
(`linux-feed-unavailable`) until the Linux Alpha feed is public; today it
answers 404, so the 04:00 `update-check` slot records a refusal. There is no
Linux lab-candidate workflow: `candidate:` is refused on Linux. Linux builds
are unsigned, so a `file:` AppImage is only checked against a hash that sits
next to it and a `local:` build against nothing: both count as **candidate**
for the policy's `allowedBuilds`. An owner who allows only `release` keeps
them off the air.

The AppImage is extracted (no FUSE) and the harness spawns its `videorc`
directly, in its own process group, so the app PID is the one it started.
Electron's sandbox then relies on unprivileged user namespaces, which Arch
allows; if a distro refuses them (Ubuntu 24.04's AppArmor), the app fails at
launch with a SUID sandbox error: that is a known gap.

### L6. Hookup, policy and doctor

Hookup is the same as on the Mac (`docs/live-lab.md` sections 1 to 5). Google
consent opens with `xdg-open` in the lab session and waits on a 127.0.0.1
port of this box, so do it at the console (or forward that port over SSH).
`--from-clipboard` reads the Wayland clipboard (`wl-paste`).

The policy, as root:

```sh
sudo install -d -o root -g root -m 0755 /etc/videorc-lab
sudo install -o root -g root -m 0644 ~videorc-lab/videorc/config/live-lab/policy.example.json /etc/videorc-lab/policy.json
sudoedit /etc/videorc-lab/policy.json   # killSwitchUrl (D7), limits (D5), "labUser" if not videorc-lab
```

Then, as the lab account, `cd ~/videorc && pnpm live:doctor`. On Linux it
prints:

| Check             | PASS means                                                                       |
| ----------------- | -------------------------------------------------------------------------------- |
| desktop session   | a Hyprland session with Wayland and a session bus (found even over SSH)          |
| lab display       | the lab output exists, is on, at least 1280x720, and (WARN) does not hold focus  |
| screen grant      | xdph's `custom_picker_binary` is the lab share picker (it reads `portal-pick`)   |
| lab audio         | `videorc_lab_speech` and `videorc_lab_mic` exist, neither is the system default  |
| espeak-ng, chrome | installed                                                                         |
| auto-login        | SDDM, greetd or getty logs the lab account in                                    |
| linger            | `loginctl` linger is on (WARN when off)                                          |
| unattended boot   | no LUKS passphrase at boot (WARN when there is one)                              |
| screen lock       | neither hypridle nor hyprlock runs                                               |
| sleep             | the four sleep targets are masked                                                |
| focus             | mako / dunst / swaync is in do not disturb                                       |
| lab user rights   | no passwordless sudo beyond the fault helper's verbs (FAIL); admin group (WARN)  |
| policy, network faults, gh auth, kill switch, run lock, stop file | as on the Mac              |

Prove the important ones fail: `chmod 666` the policy as root (FAIL), unmask
`suspend.target` (FAIL), `hyprctl output remove videorc-lab` (FAIL), start
hypridle (FAIL); then put everything back.

### L7. Schedule

```sh
pnpm live:schedule install-agent     # as the lab account, over SSH (not sudo -u)
systemctl --user list-timers videorc-live-lab.timer
pnpm live:schedule status
pnpm live:schedule uninstall-agent   # --force while a run holds the lock
```

`install-agent` renders `config/live-lab/linux/videorc-live-lab.service` and
`.timer` with this checkout's paths into `~/.config/systemd/user/`, verifies
them with `systemd-analyze --user verify`, reloads and enables the timer, and
warns when linger is off. The timer ticks 60 s after the user manager starts
and every 300 s after that; a tick that is still running (a marathon) is
never started twice. On stop, `KillMode=mixed` sends SIGTERM to the tick
only, which ends the stream and tears down within the 90 s
`TimeoutStopSec`. Logs: `~/videorc-live-lab/logs/schedule.log` as on the Mac.
`schedule.timezone` in the policy is read for the slots; set the box's clock
to match (`sudo timedatectl set-timezone Europe/Madrid`).

Weekly reboot, as root (skip it on a LUKS disk without TPM unlock):

```sh
sudo install -m 0644 -o root -g root config/live-lab/linux/videorc-lab-weekly-reboot.service /etc/systemd/system/
sudo install -m 0644 -o root -g root config/live-lab/linux/videorc-lab-weekly-reboot.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now videorc-lab-weekly-reboot.timer
```

### L8. Network faults (only with `faults.network: true`)

The Linux twin of the pf anchor is one root-owned helper with four fixed
verbs. As root:

```sh
sudo install -o root -g root -m 0755 config/live-lab/linux/videorc-lab-netfault /usr/local/sbin/videorc-lab-netfault
sudo visudo -cf config/live-lab/linux/sudoers.live-lab.example
sudo install -o root -g root -m 0440 config/live-lab/linux/sudoers.live-lab.example /etc/sudoers.d/videorc-live-lab
sudo /usr/local/sbin/videorc-lab-netfault status    # table=absent, no qdisc line
```

The lab account may run exactly `videorc-lab-netfault loss|throttle|clear|status`
(a unit test checks the sudoers file against the code both ways), never
`nft` or `tc`. `loss` and `throttle` resolve YouTube's four ingest hosts,
set one dedicated mark bit (`0x20000000`, OR-ed in, so other tools' marks
survive and cannot hide a packet) on outbound TCP 443/1935 to them in nft
table `inet videorc_lab`, and send only packets carrying that bit through a
netem band (`loss 100%` or `rate 1000kbit`) under a root `prio` qdisc
`2178:` on the interface that routes there. Nothing else is shaped. The API,
chat and the kill switch use other host names, but Google may serve one of
them from the same front-end address as `a.rtmps.youtube.com`; then the
lab's own API polls stall for the 30 s too (the macOS pf table has the same
property), which reads as a YouTube-side incident in that window.
The deadline timer, the detached watchdog (`sleep N; sudo -n ... clear`) and
the read-back after removal are the same as on the Mac. The doctor reports a
leftover table or qdisc as FAIL with `sudo -n
/usr/local/sbin/videorc-lab-netfault clear`, runs it itself when it can,
and FAILs when the helper, or any directory on its path, is not root's or is
writable by the lab account. With `faults.network` off the doctor never calls
sudo: it reads `tc qdisc show` (no privilege needed) for a leftover `2178:`
qdisc and SKIPs otherwise. A reboot clears any fault.

### Stopping everything on Linux

Exactly as on the Mac: `control.json` `{"enabled": false}`, `touch
~/videorc-live-lab/STOP` over SSH, `enabled: false` in
`/etc/videorc-lab/policy.json` as root, ending the broadcast in YouTube
Studio, or Ctrl-C on an attended `live:run`. `systemctl --user stop
videorc-live-lab.service` stops a scheduled run the same way (SIGTERM to the
tick, which ends the stream first).
