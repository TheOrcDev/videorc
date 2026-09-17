<p align="center">
  <a href="https://videorc.com"><img src="assets/social/videorc-x-cover.png" alt="Videorc — AI-native recording & streaming studio" /></a>
</p>

<p align="center">
  <a href="https://videorc.com"><img src="https://shieldcn.dev/badge/download-videorc.com-e11d48.svg?variant=branded&logo=apple" alt="Download at videorc.com" /></a>
</p>

# Videorc

Videorc is an open-source, AI-native desktop studio for creators: record your
screen and camera, stream to multiple platforms at once, and walk away with a
transcript, titles, chapters, and a ready-to-paste publish pack — all from one
window.

**Current release tracks**

- **[macOS Beta →](https://www.videorc.com/download/mac)** — macOS 13+, Apple
  Silicon. Signed and notarized beta builds are the current public desktop
  release.
- **[Windows Alpha guide →](https://www.videorc.com/windows-alpha)** — Windows
  11 x64 only. A Windows installer is published only after the signed candidate,
  clean-machine, malware-scan, update, uninstall, and real-device acceptance
  gates pass. A CI artifact or unsigned local package is not a public alpha.

Both tracks are pre-release software. Expect fast-moving releases, rough edges,
and occasional recording or streaming bugs while the app is being hardened.

## Why Videorc

Most capture tools make you choose between "simple but shallow" and "powerful
but a cockpit". Videorc aims for the third option: a studio that is genuinely
simple to run — pick a scene, hit record — while the heavy lifting (a native
capture engine, multi-platform streaming, live captions, post-recording AI)
happens underneath.

- **Scenes, not knobs.** Screen + camera, screen only, camera only, or
  side-by-side splits — with draggable camera placement, corner snapping,
  shapes, and framing controls.
- **Backgrounds with taste.** Bring your own wallpaper (PNG/WebP/JPEG), tune
  its visibility with one slider, or remove it for a full-bleed recording.
- **Record and stream in one pipeline.** Local MKV recording (with automatic
  MP4 remux), RTMP streaming, or both from a single encode — including
  simulcast fan-out to multiple destinations with per-target health status.
- **Live captions.** Streaming speech-to-text (~1s latency) with optional
  caption burn-in on the stream, the recording, both, or neither.
- **Post-recording AI.** Transcript, title/description suggestions, summaries,
  chapters, highlights, and an exportable publish pack — explicit-consent,
  post-recording only.
- **Platform-aware preview.** macOS uses a detached native CAMetalLayer preview.
  Windows Alpha currently uses the documented uncompressed, latest-wins Electron
  proof surface; it must not be described as CAMetalLayer or as final native
  parity.
- **Gated auto-updates.** Signed, notarized macOS Beta builds update in place.
  Windows updating is a release-candidate gate and is enabled only for an
  accepted, signed Alpha feed.

## How it works

- **Electron + React** desktop shell (TypeScript, shadcn/ui) for the studio UI.
- **Rust backend** owns capture, composition, recording, and streaming; the
  shell talks to it over an authenticated localhost WebSocket protocol.
- **FFmpeg** (an LGPL-compliant build, bundled) drives encoding and output.
- **SQLite** local session library — your recordings and AI artifacts stay on
  your machine.

## Open source & pricing

The desktop app — capture, scenes, recording, streaming, captions UI — is free
software under **AGPL-3.0**. You can build it, run it, and audit every line
that touches your camera, microphone, and screen.

Cloud AI features (transcription, titles, chapters, highlights) run through a
signed-in Videorc account: the desktop app never holds AI provider keys, and
nothing is uploaded without explicit per-session consent. Local audio
extraction works without any account. Hosted AI is what funds the project.

## Build from source

Prerequisites: Node.js 24.x and Rust stable (rustup). macOS source development
uses FFmpeg on `PATH`; Windows development fetches the pinned LGPL bundle with
`pnpm ffmpeg:fetch:windows`. The checked-in `.node-version`, `engines`, and
`packageManager` fields keep local tools aligned with CI; Corepack installs the
pinned pnpm 11.

```sh
corepack enable
corepack install
pnpm install
pnpm dev
```

The app launches the Rust backend automatically. On macOS, recordings default
to `~/Movies/Videorc/Recordings` and session metadata lives in
`~/Library/Application Support/Videorc/videorc.sqlite3`; Windows uses its native
user data and Videos locations.

Developing on Windows? See [docs/windows-dev-loop.md](docs/windows-dev-loop.md)
for setup, the version-floor escape hatch, and the fast verify loop.

To produce a local unsigned macOS app bundle:

```sh
pnpm ffmpeg:build:macos   # build or reuse the bundled LGPL FFmpeg
pnpm package:desktop
```

See [docs/distribution.md](docs/distribution.md) for signing, notarization,
and FFmpeg distribution details.

## Development & verification

[AGENTS.md](AGENTS.md) is the contributor guide: verification gates, recording
and native-preview rules, and repo conventions. The short loop:

```sh
pnpm typecheck
pnpm build
pnpm smoke:dev          # records a test-pattern MKV per layout preset — no permissions needed
cargo fmt --check
cargo test
cargo clippy -- -D warnings
```

The full non-packaged acceptance gate (what CI runs) is:

```sh
pnpm smoke:local-gates
```

Notable smokes: `pnpm smoke:multistream` proves simulcast fan-out end to end
against local RTMP listeners (including the offline-destination failure
guarantee), and `pnpm smoke:packaged` exercises a packaged build. None of the
default cross-platform smokes require camera, microphone, or screen permissions.
The Windows installer lane additionally runs `pnpm smoke:windows-native-screen`
against DXGI (gdigrab fallback) and keeps the packaged proof preview live during
a real ScreenOnly recording.

## Contributing

Videorc's macOS track is in Beta and its gated Windows track is in Alpha. Bug
reports with reproduction steps are very welcome; Windows testers should use
the privacy-safe Windows Alpha issue form and never attach credentials,
recordings, or an unverified support bundle to a public issue. For larger
changes, please open an issue first so we can agree on the shape before you
invest in a PR. Read [AGENTS.md](AGENTS.md) before touching recording or
native-preview code — those areas have non-negotiable verification gates.

## Contributors

- **[TheOrcDev](https://github.com/TheOrcDev)** — Warchief
- **[Jay](https://github.com/radiumcoders)** — Grunt

<p align="center">
  <a href="https://github.com/TheOrcDev/videorc/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=TheOrcDev/videorc" alt="Contributors" /> 
  </a>
</p>

## License

Code: [AGPL-3.0](LICENSE). Brand: the Videorc name, logo, and app icon are not
part of the code license — see [TRADEMARK.md](TRADEMARK.md) before
distributing a modified build. The bundled FFmpeg is built LGPL-compliant; see
[docs/distribution.md](docs/distribution.md) for third-party licensing notes.
