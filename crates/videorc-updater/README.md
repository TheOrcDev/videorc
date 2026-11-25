# videorc-updater

**Lane: L2 (Backend and contracts).** Only that lane edits this crate ([plan 260, Lanes](../../plans/260-gpui-rewrite.md#lanes-at-least-four-agents-at-once)).

The GPUI app's updater: Electron's update rules in Rust, on today's feed
format (plan 220 P5-D3), reading a second feed of its own (P5-D6). Plan
260 S5.2.

**Status on 2026-11-25.** The rules came over from the plan 220 port
(`videorc-rust:crates/videorc-updater`, last changed 2026-11-15) with their
tests; Electron's updater files have not changed since. They are wired:

- `videorc_app_core::updater::feed` is the driver: `FeedDriver` (one check,
  the download it starts, the platform's own check before "ready"),
  `LinuxNotice`, and `background_checks` (at launch, then every thirty
  minutes from a settled status). Its tests run on fixtures; none reaches a
  server.
- `apps/videorc/src/app/update_feed.rs` is the app's half: the requests
  (reqwest on the app's runtime), the macOS install and its helper, and
  which driver each build runs.

Nothing has been published to the second feed, and videorc.com has no route
for it yet (S5.2d, a `videorc-web` pull request the owner merges). Until it
does, both addresses answer 404, which the flow reads as "no update is
published for this build": the row says this build doesn't update itself,
and nothing is downloaded.

## The modules

| Module | What it decides | Source | Runs on |
| --- | --- | --- | --- |
| `status` | The status a streamer sees, when a check starts a download, when the background check runs again, and the "ready" notice | `updater-status.ts`, with its tests | all |
| `install` | An update installs only under the backend's interruption lease, never while something records or streams | `updater-install.ts`, with its tests | all |
| `mirror` | The feed's two routes, and which failures are tried again on the mirror | `updater-mirror.ts`, by kind of failure | all |
| `second_feed` | Where the GPUI app's feed is, and the loopback-only override for a rehearsal | new (P5-D6) | all |
| `feed` | Reading `latest-mac.yml` and `latest.yml`, which file to take, whether a version is newer, and the size and SHA-512 of a download | `electron-updater`'s format | all |
| `flow` | One check and one download in order, with the mirror fallback and, on Windows, the pilot feed after the public one | `updater.ts` | all |
| `launch` | What the updater does by itself from launch on, and whether Check, Download and Restart to install run | `updater.ts` (it has no tests) | all |
| `log` | The last 40 lines, for the support bundle | `updater-log.ts`, with its tests | all |
| `about_view` | What Settings → About's update row says and offers in each state | `about-update-view.ts`, with its tests | all |
| `chip` | The sidebar's update chip | `update-ui.ts` | all |
| `signature` | Whether a bundle is signed by Videorc's team for Videorc's bundle id | new; `codesign` does the checking | macOS |
| `macos_install` | Whether this copy can be replaced where it is; unpacking; the unpacked app's version; the staging folder; the swap and its way back | new; Squirrel.Mac does this for Electron | macOS |
| `macos_apply` | The helper's run once the app has quit: wait, check again, swap, open | new | macOS |
| `windows_pilot` | Who may read the Windows pilot feed, and when it is asked | `windows-pilot-update.ts`, with its tests | rules: all |
| `windows_signature` | Whether an installer is signed by Videorc's publisher | `updater-signature.ts`, with its tests | rules: all; the PowerShell run: Windows |
| `linux_notice` | Linux never updates itself; it reads the public changelog | `linux-update-notice.ts`, with its tests | all |

## The order of calls in the app

### macOS

1. **At launch** (`update_feed::start`). A build that is not installed
   (`smoke::shell::packaged`), that is not an app bundle, or that can't be
   replaced where it is (`install_location_refusal`: run from the disk
   image, or from a folder this account can't change) runs `NoFeed`: the
   row says this build doesn't update itself, and the reason goes to the
   log. `VIDEORC_UPDATE_FEED_URL` points a build at a feed on this
   computer; only a loopback address is taken. Otherwise `launch_plan`
   decides: background checks, or on request only with
   `VIDEORC_DISABLE_AUTO_UPDATE=1`. The running version is the bundle's
   `CFBundleShortVersionString`.
2. **Check.** `UpdateFlow::check_all_feeds` asks the primary route and, on
   a transport failure, the mirror. Each status goes to the window as it is
   set, and to the updater's log.
3. **Download.** `UpdateFlow::download` saves the zip to
   `<data>/updater/download/`, checks its size and SHA-512
   (`feed::verify_download`), then asks `admit`:
   `macos_install::prepare_update` unpacks it in
   `<data>/updater/videorc-update/` and checks the app in it
   (`signature::verify_videorc_bundle` with team `C2PA37RB58` and bundle id
   `dev.theorcdev.videorc`, then the version). Only when it passes is the
   status `Downloaded`, and only then may the update-ready notice show. The
   zip is removed either way.
4. **Restart & install.** The backend's interruption lease first
   (`UpdateInstall`, through `run_interrupting_action`); a refusal leaves
   everything as it is. Admitted, the app quits the normal way.
5. **At any quit with an update ready** (Electron's `autoInstallOnAppQuit`),
   after the backend has stopped, the app starts its own executable as the
   helper (`macos_apply::ApplyPlan::to_arguments`, the flag first) and
   goes. The helper (`run_helper_if_asked`, the first thing `main` does)
   waits for the app to be gone, checks the new app once more, swaps it in
   (`macos_install::swap_bundle`, with its way back) and opens it after
   Restart & install. What it did is written to
   `<data>/updater/last-install.log`, which the next launch moves into the
   updater's log.

### Linux

`LinuxNotice`: an installed build asks `https://www.videorc.com/api/changelog`
(a dev run asks only `VIDEORC_LINUX_UPDATE_NOTICE_URL`), at launch and every
thirty minutes, and says whether a newer Linux release is out. Download and
Restart to install do nothing.

### Windows

Not wired: the build runs `NoFeed` until WC-4.3 brings the installer's run
(the arguments Electron's NSIS updater passes, the publisher check through
`windows_signature`, and the pilot feed's grant from the account).

## What has run, and what has not

In the crate's and app-core's tests, on fixtures: the rules' tests from
plan 220, the second feed's addresses and override, and the driver against
a fixture feed (a download that is admitted and installed, a tampered
download, a refused signature, an unpublished feed, the mirror fallback, an
up-to-date build, the Linux notice and the silent checks' timing).

Not run anywhere yet:

- A request to a real feed (there is none for the GPUI app).
- An update of a real, signed GPUI app in `/Applications`, with the helper
  outliving the app. That is S5.0's crossover proof and S5.3's week on the
  signed builds. A rehearsal serves two signed builds' `latest-mac.yml` and
  zip from a local server and sets `VIDEORC_UPDATE_FEED_URL`.

## Open for the owner

- The row for a copy that can't be replaced where it is. Today it says
  "doesn't update itself", with the reason in the log; plan 220 suggested a
  state of its own with the sentences in `macos_install::LocationRefusal`.
- A download that isn't signed by Videorc shows the same calm "Couldn't
  check for updates" alert as a connection problem. Electron has the same
  flaw.
