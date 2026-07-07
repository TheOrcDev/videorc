# Releasing Videorc (macOS beta) — Runbook

How to cut a new version and make existing users auto-update to it. This is the
repeatable per-release process. For one-time signing setup see
[macos-signing.md](macos-signing.md); for the broader packaging reference see
[../distribution.md](../distribution.md).

## What a release is

Two artifact sets in the same private R2 bucket (`videorc-releases`), fronted by
videorc-web:

| Artifacts | R2 keys | Web route | Audience |
| --- | --- | --- | --- |
| **Download** (dmg + sha256 + release.json) | `releases/macos/<releaseId>/` | `/api/downloads/macos/latest` (auth-gated, presigned) | New users |
| **Update feed** (`latest-mac.yml` + `.zip` + `.zip.blockmap`) | `updates/macos/` (stable, overwritten each release) | `/api/updates/*` (public, presigned) | Existing users auto-updating |

The desktop **Settings → About & updates** button — and the automatic launch
check (default in packaged builds since 0.9.10; opt out via
`VIDEORC_DISABLE_AUTO_UPDATE=1`) — read the feed.

## Versioning model

- **`apps/desktop/package.json` `version` is the update key.** electron-updater
  copies it into `latest-mac.yml` and compares it to the installed app's version.
  **A strictly higher version is what triggers an update offer** — to ship an
  update you bump this value. Same version installed = "you're up to date".
- `releaseId = <version>-beta.<N>` (e.g. `0.9.1-beta.1`) names the **download**
  archive path only; set `N` with `VIDEORC_RELEASE_BETA_NUMBER`. The feed compares
  on `<version>`, not the releaseId.
- Bump semver normally: `0.9.0 → 0.9.1` (patch), `→ 0.10.0` (minor).

## Prerequisites (per build machine)

- **Apple signing** — `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` in the env
  (team `C2PA37RB58` is baked by `dist:release`); Developer ID cert in the
  keychain (or `CSC_LINK`). See [macos-signing.md](macos-signing.md).
  **Auto-update requires a signed build** — electron-updater refuses to apply an
  unsigned/ad-hoc update.
- **R2 write creds** — the `VIDEORC_DOWNLOAD_S3_*` values (same bucket as
  videorc-web), with an **Object Read & Write** token. They live in the web app's
  `.env` (`~/projects/videorcweb/.env`).
- **YouTube OAuth secret** — `VIDEORC_BUNDLED_YOUTUBE_CLIENT_SECRET` must be in
  the build env (it lives in `~/.videorc-release.env`). The secret left source
  when the repo went public; `option_env!` compiles it into `videorc-backend`,
  and `release:validate:macos` **fails closed** if the built binary lacks the
  exact build-time secret from the release environment. Without it, YouTube
  connect in the shipped app reports a missing client secret.
- **⚠️ Bucket-less S3 endpoint** — `VIDEORC_DOWNLOAD_S3_ENDPOINT_URL` must be the
  ACCOUNT host only: `https://<account-id>.r2.cloudflarestorage.com` — **NOT**
  `.../videorc-releases`. The path-style client appends the bucket itself; an
  endpoint that already includes the bucket **doubles** it, so objects land at
  `videorc-releases/updates/...` (where nothing reads them) while the upload still
  reports success. If your `.env` endpoint has the bucket suffix, fix it there or
  override per-run (Step 3 below).

## Cut a release

```sh
cd ~/projects/videorc

# 1. Bump the version (the update key), write the changelog entry, and commit.
#    Edit apps/desktop/package.json -> "version": "0.9.1"
#    Write changelog/<releaseId>.md (user-facing; see changelog/README.md) —
#    validate + upload both FAIL without it (escape: VIDEORC_RELEASE_SKIP_CHANGELOG=1).
pnpm changelog:check
git commit -am "Release: bump desktop to 0.9.1"

# 2. Build + sign + notarize + staple, WITH the update feed, + write release.json.
#    (dist:desktop:release = the signed build incl. the zip/latest-mac.yml feed,
#    unlike dist:desktop:signed which is dmg-only.) Slow: rebuilds backend+ffmpeg.
export APPLE_ID=…  APPLE_APP_SPECIFIC_PASSWORD=…
pnpm dist:desktop:release

# 3. Validate the signed artifact (codesign / Gatekeeper / staple).
pnpm release:validate:macos

# 4. Load R2 creds and upload the download + feed.
set -a; . <(grep -E '^[[:space:]]*VIDEORC_DOWNLOAD_S3_' ~/projects/videorcweb/.env); set +a
# Force a bucket-less endpoint (skip if your .env endpoint is already host-only):
export VIDEORC_RELEASE_UPLOAD_S3_ENDPOINT_URL="https://<account-id>.r2.cloudflarestorage.com"
pnpm release:upload:preflight:macos
pnpm release:upload:macos       # uploads dmg + sha + release.json + latest-mac.yml + zip + blockmap
                                # + the compiled changelog -> changelog/changelog.json
```

`release:upload:macos` fails closed if the feed files are missing,
`latest-mac.yml` points at a stale zip, or there is no valid
`changelog/<releaseId>.md` entry — so a broken feed or an unannounced release
never publishes. The changelog JSON feeds videorc-web `/changelog` and the
desktop "What's new"; `VIDEORC_RELEASE_SKIP_CHANGELOG=1` is the loud emergency
escape.

Newsletter: `pnpm changelog:email <releaseId>` renders the entry to
email-ready HTML + plaintext under `dist/changelog/email/` (sending is manual —
no ESP is wired yet).

Discord announcement: after the feed is verified, `pnpm release:notify:discord`
posts a short "what's new" (release title + up to 4 changelog highlights) to the
Videorc Discord channel. `-- --dry-run` previews without posting; a releaseId
argument re-announces an older release. The webhook is a post-anywhere
credential and this repo is PUBLIC, so it is **never committed** — it lives in
`~/.videorc-release.env` as `VIDEORC_DISCORD_RELEASE_WEBHOOK` (gitignored,
already sourced by the build); the script refuses to run without it and never
echoes the URL.

## Verify (always follow the redirect to R2)

```sh
# Feed serves the NEW version:
curl -sL https://www.videorc.com/api/updates/latest-mac.yml | head
#   -> version: 0.9.1 ...
# The zip it references resolves (200, not 403/404):
curl -s -o /dev/null -w '%{http_code}\n' -L \
  https://www.videorc.com/api/updates/Videorc-0.9.1-mac-arm64.zip
```

The download page follows automatically: the upload also publishes the
manifest to the STABLE key `releases/macos/latest/release.json`, which
videorc-web's `VIDEORC_DOWNLOAD_MANIFEST_OBJECT_KEY` points at (one-time Vercel
setting — do NOT pin it to a versioned key, or the download page freezes on
that release while the update feed moves on).

## Acceptance gate

A signed beta is releasable only after a clean-machine pass recorded under
`docs/acceptance/` — use
[../acceptance/macos-release-candidate-template.md](../acceptance/macos-release-candidate-template.md).
Add a per-release note `docs/releases/<version>.md` (see
[0.9.0-beta.1.md](0.9.0-beta.1.md)).

### Release-candidate device + provider gates (plan 022)

Two gate groups are advisory in day-to-day runs but REQUIRED for a
release candidate:

- **Real-device screen gates** (host must have Screen Recording AND Camera
  TCC granted to the dev Electron and `target/debug/videorc-backend`, and
  the target display must not be otherwise in use). Run in order:
  1. `pnpm smoke:screen-recording-real`
  2. `pnpm smoke:notes-window-invisible`
  3. `pnpm smoke:recording-studio:devices`
  If the motion-stimulus signature fails, fix stimulus placement on the
  SELECTED display (`VIDEORC_SCREEN_MOTION_*`) — never loosen the
  signature assertion.
- **Provider live readiness, strict**: with the smoke-only provider
  credentials from [../oauth-live-smoke.md](../oauth-live-smoke.md) in the
  environment, run readiness with `VIDEORC_SMOKE_REQUIRE_PROVIDER_READY=1`
  so missing prerequisites FAIL the gate instead of printing advice.

## How users get the update

1. On launch — and on **Settings → About & updates → Check for updates** — the
   app GETs `latest-mac.yml` and compares `version` to its own.
2. If the feed is higher it downloads the `.zip` (302 → presigned R2) with
   progress.
3. It applies on the next quit (background path) or immediately via **Restart &
   install**, which is **blocked while a recording/stream is live**.

The installed app checks whichever feed URL was baked at **build time**
(`apps/desktop/electron-builder.yml` `publish.url`) — since 2026-07-07 that is
`https://www.videorc.com` (launch flip; builds ≤0.9.14 still check the old
Vercel host, so that host's `/api/updates/*` must KEEP working until those
installs age out). WWW is load-bearing: the apex 307-redirects every path to
www, and redirect hops drop Authorization headers in some clients. If the host
ever changes again, update `publish.url`, `videorc-web-links.ts`, and the Rust
`PRODUCTION_API_BASE_URL` together, then cut a build so the new URL ships.

## Gotchas (hard-won)

- **Bucket-less endpoint** (above) — the #1 silent failure: a doubled key uploads
  "successfully" but the feed/download then 404. Verify by *following the
  redirect* to R2, not just checking the route returns a 302.
- **Never cache the presigned redirect** — `/api/updates/*` 302s to a ~15-min
  presigned URL and is intentionally cached `max-age=60`. Do not restore a long /
  `immutable` cache, or the CDN serves an expired redirect (403). (videorc-web
  `lib/updates-route.ts`.)
- **Signed builds only** — unsigned/ad-hoc builds won't self-update.
- **arm64 only** — `latest-mac.yml` is arm64; Intel Macs are not served or
  updated. Add x64/universal before claiming Intel support.
- **Feed = package.json `version`, not `releaseId`** — bump `version` to ship an
  update; the `-beta.N` suffix only names the download archive.

## Rollback

Fail closed instead of mutating a bad release — see "Beta Download Rollback" in
[../distribution.md](../distribution.md): set
`VIDEORC_DOWNLOAD_STORAGE_PROVIDER=none` or repoint the manifest and redeploy, and
cut a `-beta.N+1` rather than overwriting. For the feed, publish a corrected build
with a **higher** version; the bad one stops being offered once a higher version
exists. (The flat `updates/macos/` prefix is overwritten each release, so the
feed always reflects the latest upload.)
