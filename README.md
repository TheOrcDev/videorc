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

**[Download for macOS →](https://videorc.com)** (macOS 13+, Apple Silicon)

**Beta status:** Videorc is still in beta. Expect fast-moving releases,
rough edges, and occasional recording/streaming bugs while the app is being
hardened.

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
- **Native preview.** A detached CAMetalLayer preview window driven directly by
  the Rust engine; raw media frames never cross Electron IPC.
- **Auto-updates.** Signed, notarized builds that update in place.

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

## Troubleshooting Windows Builds
If you launch the application on Windows (especially on Windows Insider or pre-release environments) and encounter a pitch-black screen or an immediate silent crash, the Chromium rendering engine is likely experiencing a GPU virtualization conflict.

You can automatically generate a corrected troubleshooting shortcut directly in your **Downloads** folder by running the following command in **PowerShell (Admin)**:
```powershell
$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut("$env:USERPROFILE\Downloads\Videorc Testing.lnk"); $Shortcut.TargetPath = "$env:LOCALAPPDATA\Programs\Videorc\Videorc.exe"; $Shortcut.Arguments = "--disable-gpu --disable-gpu-sandbox --no-sandbox --disable-features=GpuProcessHighPriorityPerWindow"; $Shortcut.WorkingDirectory = "$env:LOCALAPPDATA\Programs\Videorc"; $Shortcut.Save(); explorer "$env:USERPROFILE\Downloads"
```

## Build from source

Prerequisites: Node.js 24+, pnpm 11+, Rust stable (rustup), FFmpeg on `PATH`
for development.

```sh
pnpm install
pnpm dev
```

The app launches the Rust backend automatically. Recordings default to
`~/Movies/Videorc/Recordings`; session metadata lives in
`~/Library/Application Support/Videorc/videorc.sqlite3`.

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
default smokes require camera, microphone, or screen permissions.

## Contributing

Videorc is in beta and moving fast. Bug reports with reproduction steps are
very welcome; for larger changes, please open an issue first so we can agree
on the shape before you invest in a PR. Read [AGENTS.md](AGENTS.md) before
touching recording or native-preview code — those areas have non-negotiable
verification gates.

## License

Code: [AGPL-3.0](LICENSE). Brand: the Videorc name, logo, and app icon are not
part of the code license — see [TRADEMARK.md](TRADEMARK.md) before
distributing a modified build. The bundled FFmpeg is built LGPL-compliant; see
[docs/distribution.md](docs/distribution.md) for third-party licensing notes.
