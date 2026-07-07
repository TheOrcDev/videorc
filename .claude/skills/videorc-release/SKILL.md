---
name: videorc-release
description: Cut and publish a new signed + notarized macOS release of the Videorc desktop app so installed users auto-update — bump version, build, sign, notarize, upload to R2, verify the electron-updater feed. Use when the user wants to cut/ship/publish a new release or version, deploy the desktop app, or make an update available to users. Covers macOS + the videorc-web feed dependency; docs/releases/release-runbook.md has the full detail.
---

# Videorc release

Ship a new macOS version so existing users auto-update. This is the **executable
procedure**; `docs/releases/release-runbook.md` (in the videorc repo) is the
source of truth — read it for the versioning model, rollback, and the "why".
Keep this skill thin: point there, don't duplicate it.

## Prerequisites — verify before starting

- `~/.videorc-release.env` holds `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` (an
  app-specific password from appleid.apple.com). If it's missing, ask the user to
  create it — notarization cannot run without it, and you must not fabricate it
  or ship an un-notarized build.
- `~/.videorc-release.env` also holds `VIDEORC_BUNDLED_YOUTUBE_CLIENT_SECRET` —
  compiled into videorc-backend at build time (the secret is NOT in source since
  the repo went public). `release:validate:macos` fails closed if the built
  binary lacks it.
- Developer ID cert in the keychain (`security find-identity -v -p codesigning`
  → "Uros Miric (C2PA37RB58)"). It signs directly; no `CSC_LINK` needed.
- R2 write creds in `~/projects/videorcweb/.env` (`VIDEORC_DOWNLOAD_S3_*`).

## Steps

### 1. Bump the version + write the changelog entry — commit + push
electron-updater compares `apps/desktop/package.json` `version` against the
installed app, so a strictly higher version is what triggers the update. Bump it
(e.g. 0.9.0 → 0.9.1).

Write `changelog/<releaseId>.md` (user-facing entry; format + voice rules in
`changelog/README.md`) and run `pnpm changelog:check`. Both
`release:validate:macos` and `release:upload:macos` **fail closed without it**
(emergency escape: `VIDEORC_RELEASE_SKIP_CHANGELOG=1`). The upload publishes the
compiled changelog to R2 `changelog/changelog.json` for the website and in-app
"What's new". Commit, push.

### 2–5. Build → validate → upload → verify (run in the background)
The build (Rust backend + electron-builder + **notarization**) is long and
unpredictable — run it in the background. It bypasses `release:preflight:macos`
on purpose: that gate demands `CSC_LINK`, which local builds don't have (the
keychain cert signs instead).

```sh
cd ~/projects/videorc
set -a
. ~/.videorc-release.env
. <(grep -E '^[[:space:]]*VIDEORC_DOWNLOAD_S3_' ~/projects/videorcweb/.env)
set +a
export APPLE_TEAM_ID=C2PA37RB58
# bucket-less endpoint (the .env one includes /videorc-releases → keys would double):
export VIDEORC_RELEASE_UPLOAD_S3_ENDPOINT_URL="https://$(printf '%s' "$VIDEORC_DOWNLOAD_S3_ENDPOINT_URL" | sed -E 's#^https?://([^/]+).*#\1#')"
export PATH=/opt/homebrew/bin:$PATH
pnpm package:backend:macos && pnpm ffmpeg:build:macos && pnpm package:preflight:macos \
  && pnpm --filter @videorc/desktop dist:release && pnpm release:manifest:macos \
  && pnpm release:validate:macos && pnpm release:upload:macos
```

Verify the feed serves the new version (follow the redirect to R2):

```sh
curl -sL https://www.videorc.com/api/updates/latest-mac.yml | head   # -> version: <new>
```

**Also verify the web download/admin page shows the new version** (ask the
owner to check the signed-in download page). The upload publishes the manifest
to the STABLE key `releases/macos/latest/release.json`, so the page follows
each release automatically — IF videorc-web's Vercel env is set to it
(one-time): `VIDEORC_DOWNLOAD_MANIFEST_OBJECT_KEY=releases/macos/latest/release.json`.
If admin still shows an old version (it sat on "0.9.0 beta 1" for three
releases), that env is pinned to a versioned key — fix the env + redeploy,
never hand-edit per release.

### 6. Announce on Discord
After the feed is verified, post a short "what's new" to the Videorc Discord:

```sh
set -a; . ~/.videorc-release.env; set +a   # loads VIDEORC_DISCORD_RELEASE_WEBHOOK
pnpm release:notify:discord -- --dry-run    # preview the message first
pnpm release:notify:discord                 # posts the newest changelog entry
```

It posts the release title + up to 4 changelog highlights (short — full notes
live on the site). The webhook URL is a **post-anywhere credential and the repo
is PUBLIC**, so it is NEVER committed — it lives in `~/.videorc-release.env` as
`VIDEORC_DISCORD_RELEASE_WEBHOOK` (gitignored, already sourced by the build).
The script refuses to run without it and never echoes the URL. Pass a releaseId
to re-announce an older one: `pnpm release:notify:discord 0.9.17-beta.1`.

### 7. Commit the release note
Update `docs/releases/<version>.md` (check off build/upload/verify/announce),
commit + push (via a PR — `main` is branch-protected since 2026-07-07).

## Gotchas (each cost real debugging)

- **Bucket-less S3 endpoint** — the path-style client appends the bucket, so an
  endpoint ending in `/videorc-releases` DOUBLES it; objects silently land where
  nothing reads them while the upload still prints PASS. The command above strips
  it. Always verify by *following the 302 to R2*, not by the 302 alone.
- **Bypass `release:preflight:macos`** for local builds — it requires `CSC_LINK`;
  the keychain cert signs without it. (Do not use `pnpm dist:desktop:release`
  as-is locally; it starts with that preflight.)
- **Feed = `package.json` `version`, not releaseId** — bump `version` to ship an
  update; the `-beta.N` suffix only names the download archive.
- **Feed URL is `https://www.videorc.com`** (flipped at launch, 2026-07-07) —
  WWW is load-bearing: the apex 307-redirects every path to www, and redirect
  hops drop Authorization headers in some clients. The app's baked
  `publish.url` (electron-builder.yml), `videorc-web-links.ts`, and the Rust
  `PRODUCTION_API_BASE_URL` all point at the www host.
- **Never cache the presigned redirect** — videorc-web `/api/updates/*` uses
  `max-age=60`; a long / `immutable` cache serves an expired 403.
- **Notarization is a network round-trip to Apple** — the build sits for minutes
  near the end; that's normal, not a hang.
