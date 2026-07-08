# Plan 032: Bundled FFmpeg RTMPS TLS — the actual X spinner root cause

> **Executor instructions**: This closes the 2026-07-08 X spinner saga with a
> PROVEN root cause. Plans 030 (playback probe) and 031 (source hygiene,
> END-before-stop) were correct hardening but chased downstream symptoms.
> The cause was upstream all along: **the bundled ffmpeg is built without a
> TLS library**, so `rtmps://` rides Apple SecureTransport, whose writes
> stall on video-sized payloads to X's ingest. The app's fifo stream leg
> then drops the overflow silently, and X receives a ~2% trickle.
>
> **Proof chain (2026-07-08)**:
> 1. X's matured measurement of the failing sessions' source (`5nww…`):
>    video 125 kbps / **0.58 fps** / audio 3 kbps — vs the working session's
>    5.98 Mbps / 29.98 fps. X was starved, not confused.
> 2. Local captures of BOTH the tee and split fanout FLV legs
>    (`scripts/probe-split-flv-capture.mjs`) are fully valid (H.264 High +
>    32-byte avcC extradata, AAC-LC + ASC) — encoding/muxing was never the
>    problem, and early "codec must be AAC/H.264" compatibility errors were
>    transient analyzer noise that disappears on matured reads.
> 3. Controlled A/B, same file/source/network minutes apart:
>    - bundled ffmpeg (`--disable-gpl`, no TLS lib → SecureTransport):
>      writer logged "Resumed reading … after a lag of 47.814s"; X measured
>      **video 0.0 fps**.
>    - Homebrew ffmpeg (`--enable-openssl`): X measured **29.998 fps**.
> 4. Why "it worked the first time": the 08:39Z watchable session ran the
>    DEV app, which uses Homebrew's ffmpeg from PATH. Every failing session
>    ran the packaged app with the bundled ffmpeg. The fresh-source /
>    duration / teardown theories were confounded by build type.
>
> **Drift check**: `scripts/build-ffmpeg-macos.sh`, `vendor/ffmpeg/current`,
> `docs/distribution.md` (ffmpeg bundle section, licenses). Baseline
> `35df9167`.

## Status

- **Priority**: P0 — every packaged-app RTMPS stream (X native, and any
  manual rtmps target) is affected. Plain `rtmp://` targets (local smokes,
  most Twitch defaults) never exercised TLS, which is why gates stayed
  green.
- **Effort**: S.
- **Risk**: LOW-MEDIUM — build-config change to the vendored ffmpeg;
  licensing reviewed (LGPLv3 + Apache-2.0 OpenSSL, still no GPL/nonfree).
- **Depends on**: none (030/031 remain valuable hardening + measurement).
- **Planned at**: 2026-07-08, executed same session. Target release 0.9.23.

## Slices

### S0 — Second latent defect found by the new gate

The first gated rebuild refused to stage: configure had auto-detected
Homebrew's libX11/libxcb on the build host and hard-linked them. Inspection
of the SHIPPED 0.9.22 bundle shows the same five `/opt/homebrew/...` dylib
load commands — the bundled ffmpeg could never have launched on a user
machine without Homebrew. Fixed by pinning `--disable-xlib
--disable-libxcb --disable-sdl2`; the otool gate keeps it fixed.

### S1 — Build bundled ffmpeg with static OpenSSL

`scripts/build-ffmpeg-macos.sh`:
- require openssl@3 static libs (`VIDEORC_OPENSSL_PREFIX` override;
  Homebrew default), stage ONLY `libssl.a`/`libcrypto.a` into a private
  link dir so the linker cannot pick Homebrew dylibs;
- configure with `--enable-version3 --enable-openssl` (OpenSSL 3 is
  Apache-2.0 → requires LGPLv3; still no `--enable-gpl`/`--enable-nonfree`,
  and the existing gate stays);
- fail closed post-build unless: configuration contains
  `--enable-openssl`, `ffmpeg -protocols` lists `tls`, and `otool -L`
  shows no Homebrew/local dylib references;
- NOTICE.txt documents the OpenSSL static link and LGPLv3.

### S2 — Verification probe as a maintained script

`scripts/probe-split-flv-capture.mjs` (promoted from the investigation):
drives a real split-profile session (4K record + 1080p stream) against a
local RTMP listener and ffprobes the received FLV. Registered as
`pnpm probe:split-flv`.

### S3 — Acceptance

1. Rebuilt bundle passes the new gates.
2. A/B repush to the X test source with the NEW bundled ffmpeg: X must
   measure ~30 fps (was 0.0). No 40s+ writer lags.
3. Owner on 0.9.23: one short real X session — with plans 030+031 shipped,
   expect `x-playback-verified` within seconds and a watchable broadcast
   from another account. The 0.9.21 probe is the in-app judge.

## Notes

- Windows bundle (`fetch-ffmpeg-windows.mjs`) ships gyan/BtbN builds that
  already include TLS; unaffected.
- Keep plans 030/031: verification + hygiene stay correct regardless of
  transport health, and the probe is what finally surfaced the trickle.
