# Plan 048: Windows auto-update works for installed Alphas

> Executor: S0 is the release owner's action. S1–S2 follow
> `.claude/skills/videorc-release/SKILL.md` and `docs/releases/windows-alpha-runbook.md`.
> S3–S4 are code: implement them in an isolated worktree of current main.
> Read AGENTS.md first. Planning authorizes no merge, promotion or release.

## Status and decisions

- Status: S1, S3 and S4 IMPLEMENTED 2026-09-23 on `fix/windows-auto-update`
  (desktop) and `feat/windows-pilot-account-updates` (web). S0 waits on the
  owner's waiver record; S2 (public promotion plus the real-hardware update)
  follows it. Investigated against `origin/main` `14d8ffad` (release notes for
  0.9.101) and videorc-web `origin/main` `426a2c6b`.
- S3 as built: the web mints a one-hour `wpu1.` token
  (`POST /api/desktop/updates/windows-pilot-token`, signed-in session, only
  while `VIDEORC_WINDOWS_ALPHA_STATE=pilot`, HMAC keyed from the auth secret).
  The pilot route accepts it in addition to the operator token. The backend's
  admin-only RPC `account.windows_pilot_update_token` exchanges the stored
  session for it, so the session never reaches main. The updater checks public
  first and probes the pilot feed only when public is missing or up to date.
  **Deploy the web before shipping the desktop.** An older web answers 404,
  which the desktop treats as "no pilot".
- Priority P0: no installed Windows app has ever updated itself. Effort: S0–S2
  are release operations only (hours). S3 is M, S4 is S.
- Owner routes: S0–S2 **Release** (fit 10, `fable-5`, release-critical).
  S3 **Implementation** across desktop and web (fit 8, `gpt-5.5`; escalate to
  `fable-5` if the auth hand-off gets complicated). S4 **UI/Product Design**
  (fit 7, `opus-4.8`).
- **Decision needed from the owner (S0):** publish Windows `0.9.101-alpha.1`
  publicly by writing the owner-waiver acceptance record, as already chosen in
  `docs/releases/0.9.101.md` ("signed candidate plus an owner waiver"). Only
  the owner may write that record. The release agent is not permitted to.
- **Decision needed from the owner (S3):** should signed-in Windows users follow
  the pilot update feed? Recommended: yes. They already download pilot
  installers from `/account/download`, so their updates should match.

## Problem (measured, 2026-09-23)

1. **The public Windows feed has never existed.**
   `GET https://www.videorc.com/api/updates/latest.yml` redirects to Neon
   `releases/updates/windows/latest.yml`, which returns `NoSuchKey`. Only a
   public promotion writes that object (`scripts/lib/windows-release-upload.mjs`:
   stage `public` → `updates/windows`, stage `pilot` → `updates/windows/pilot`).
2. **Every promotion ever run was a pilot.** All 13 `promote-windows-alpha.yml`
   runs, 2026-08-12 → 2026-09-21 (latest 35586561321, 0.9.98-alpha.1), logged
   `RELEASE_STAGE: pilot`. Public promotion needs an acceptance record (PASS or
   owner waiver) in `docs/acceptance/windows-alpha/`, and none has ever been
   committed.
3. **Installed apps only look at the public feed.** Every Windows build bakes
   `https://www.videorc.com/api/updates/` (`electron-builder.yml` → generated
   `app-update.yml`). The pilot feed `/api/updates/windows-pilot/` is used only
   when a tester sets `VIDEORC_WINDOWS_PILOT_UPDATE=1` plus an operator bearer
   token in the environment (`apps/desktop/src/main/windows-pilot-update.ts`).
   No normal user has that.
4. **The failure is silent.** `isMissingUpdateFeedError` maps the 404 to the
   `unsupported` state. Settings says "Automatic updates aren't available for
   this build yet", and the background check stops there. Nobody sees an error.
5. **The downloads and the updater disagree.** With
   `VIDEORC_WINDOWS_ALPHA_STATE=pilot`, every signed-in user downloads the
   current pilot installer from `/account/download`. That installer can never
   update itself, so each Windows release strands everyone on the version they
   installed.

Checked and ruled out:

- **The web routes are fine.** `lib/updates-route.ts` maps `latest.yml` and
  `Videorc-<ver>-win-x64.exe(.blockmap)` to `updates/windows/` by file name, so
  it matches the upload layout. The public updates route has no pilot/public
  gate.
- **Signature verification should pass.** `app-update.yml` `publisherName` and
  the Azure signing identity both come from `VIDEORC_WINDOWS_PUBLISHER_NAME`
  (`Uros Miric`).
- **Version comparison is fine.** The feed `version` is the numeric bundle
  version (`0.9.101`), and installed pilots report numeric versions (`0.9.98`).
  No prerelease-channel mismatch.
- **The promotion code allows a first public release.**
  `assertWindowsFeedTransition` only raises `published-feed-missing` when a
  committed acceptance record proves an earlier public version, and none exists.
  The warning in `docs/releases/0.9.100.md` and `0.9.101.md` ("pointer recovery
  must be resolved before public promotion") is based on a false premise. The
  old Windows entries in the public changelog came from macOS uploads publishing
  held entries, not from a Windows public release. `first-public-alpha` is
  the correct `releaseSequence`.

## Slices

### S0: Owner writes the waiver for the exact candidate (owner only)

The `0.9.101-alpha.1` candidate was building at investigation time
(`release-windows-alpha.yml` run 35845643459 from `14d8ffad`). After it is
signed and stored, the owner writes and commits
`docs/acceptance/windows-alpha/0.9.101-alpha.1.json`. Use the
`videorc-windows-alpha-owner-waiver` kind (#374), `acceptanceStatus: waived`,
`releaseSequence: {"kind": "first-public-alpha"}`, and the candidate's exact
source commit, installer SHA-256 and publisher.

Done when: the record is on main and `node scripts/windows-acceptance-record-resolve.mjs`
validates it for that candidate.

### S1: Correct the release records (docs, release agent)

Replace the "pointer recovery" paragraphs in `docs/releases/0.9.100.md` and
`docs/releases/0.9.101.md` with the evidence above: pilot-only promotion
history, no accepted record, the promotion guard's first-release path. Keep the
remaining gate statements unchanged.

Done when: no release doc tells the release agent to recover a public pointer
that never existed.

### S2: Public promotion and a real update on Windows (release agent + one Windows box)

1. Dispatch `promote-windows-alpha.yml` with stage `public`, the pinned
   candidate identity and the committed record URL. Verify through the web
   route: `latest.yml` → 0.9.101, installer and blockmap SHA match the feed,
   `Range` returns 206, mirror route agrees.
2. Flip Vercel `VIDEORC_WINDOWS_ALPHA_STATE` from `pilot` to `public` and
   redeploy (prod). Check `/windows-alpha` and `/account/download`.
3. **Real-update proof** (runbook §4, Alpha→Alpha): on a Windows 11 box with
   the 0.9.98-alpha.1 pilot installed and no pilot env vars, go to Settings →
   About & updates → Check. Expected: `available 0.9.101` → download →
   Restart & install → relaunch reports 0.9.101, and the recording library is
   intact. Repeat once with a background launch check, then a normal quit, to
   cover `autoInstallOnAppQuit`.
4. Discord Windows announcement and release record, per the runbook.

Done when: an installed pilot updated itself to 0.9.101 on real hardware, and
the release record says so with the run links.

### S3: Signed-in Windows installs follow the pilot feed (desktop + web)

This keeps future pilot releases from stranding users.

- **Web** (`app/api/updates/windows-pilot/[[...path]]/route.ts`): accept a
  valid desktop account bearer as well as the operator token. Allow exactly the
  users `/account/download` serves pilot installers to (reuse that predicate;
  don't add a second rule). Keep proxying bytes through the branded route,
  never redirecting, so the bearer never reaches storage. Unauthenticated
  requests stay 401.
- **Desktop** (`updater.ts`, `windows-pilot-update.ts`): on packaged Windows
  with a signed-in account, check the pilot feed with the account bearer and
  `disableDifferentialDownload` (same reason as today). Otherwise use the
  public feed. Refresh the header before every check, because the account token
  rotates. The env-var operator mode stays as it is. Sign-out returns to the
  public feed. Never log or forward the bearer (same rules as
  `consumeWindowsUpdaterStartupConfig`).
- Existing installs can't pick this up until they update once through S2.
  That is why S2 comes first.

Done when: unit tests cover feed selection (signed in / signed out / operator
env / macOS unaffected) and header refresh. Web route tests cover account
bearer allowed, a non-entitled account refused, and no redirect. A packaged
Windows build signed in to a test account moves from pilot N to pilot N+1 via
a staging pilot feed.

### S4: Honest status when no Windows feed is published

When the Windows feed is missing, say so specifically instead of the generic
`unsupported` copy. For example: "Windows Alpha updates are published when a
release goes public. Download the newest build from your account page." Link
to `/account/download`, and log the 404 once per launch.

Keep the renderer asset budget in mind. Initial eager JS is within ~30 gzip
bytes of the 385000 limit, and CI's gzip reads ~3 bytes higher than local.
Settings copy must stay in a lazily loaded chunk; check with
`pnpm build && pnpm check:renderer-assets`.

Done when: a unit test maps a Windows missing-feed error to the new state and
copy, and the asset budget passes.

## Verification

- S1: docs-only diff review.
- S2: runbook verification plus the real-hardware update in S2.3. There is no
  substitute for S2.3: no updater smoke runs on macOS for NSIS.
- S3/S4: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
  `pnpm --filter @videorc/desktop test`, `pnpm build`,
  `pnpm check:renderer-assets`. On the web: its test suite plus a preview
  deploy check of the pilot route with an account bearer.

## Out of scope

- Changing the acceptance-record policy itself.
- Moving candidates off R2 (Neon plan N8).
- The macOS feed, which is healthy.
