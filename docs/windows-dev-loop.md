# Windows dev loop

How to develop and verify Videorc on a Windows box. First proven on-box
2026-07-08 (Windows 10 x64, unsupported configuration — see the floor note).

## One-time setup

Prerequisites: Node 24.x (the `.node-version` and `engines` line used by CI),
Rust stable with the MSVC toolchain (Visual Studio Build Tools), and git.
Corepack installs the repository's pinned pnpm 11 version.

```powershell
corepack enable
corepack install
pnpm install
pnpm ffmpeg:fetch:windows   # pinned LGPL FFmpeg -> vendor/ffmpeg/windows-x64
```

Dev mode wires the vendored `ffmpeg.exe`/`ffprobe.exe` in automatically
(`resolvePackagedFfmpegBinDir` in `apps/desktop/src/main/index.ts` and
`scripts/smoke-dev-app.mjs` both prefer it) — no PATH edits needed.

## The Windows version floor

Videorc supports Windows 11 (build 22000+) only. On older builds the app quits
at startup with a dialog. For development on a Windows 10 box, set:

```powershell
$env:VIDEORC_ALLOW_UNSUPPORTED_WINDOWS = '1'
```

This bypasses the startup floor (`enforceWindowsVersionFloor`) and the
`smoke:local-gates:windows` host check. It is a dev/lab escape hatch, not a
supported configuration: Mica/acrylic and Windows.Graphics.Capture behavior
below build 22000 is unverified.

## Run the app

```powershell
pnpm dev   # electron-vite + cargo run of the backend (first run compiles Rust)
```

## Fast change -> is-it-fixed loop

Keep the app running with the smoke command server, then drive it without
relaunching anything:

```powershell
# terminal 1 — stays up; prints "UI driver ready" when the command server is live
$env:VIDEORC_ALLOW_UNSUPPORTED_WINDOWS = '1'
pnpm ui:driver
```

```powershell
# terminal 2 — one command per check, results in ~1s
node scripts/ui-cmd.mjs eval-js '{"code":"return document.title"}'
node scripts/ui-cmd.mjs capture-page '{"name":"my-check"}'   # PNG into docs/acceptance/sweeps/.staging
node scripts/ui-cmd.mjs open-tab '{"tab":"settings"}'
```

Call `node scripts/ui-cmd.mjs` directly rather than `pnpm ui:cmd` on Windows —
the pnpm/cmd shim layer mangles quoted JSON arguments.

Renderer changes hot-reload via electron-vite, so the loop for UI work is:
edit -> save -> `capture-page`/`eval-js` -> look. Backend (Rust) changes need a
driver restart (`cargo run` recompiles incrementally).

## Verify gates that work on Windows

Cheap, no Electron (run these first):

```powershell
pnpm typecheck
pnpm test:scripts
pnpm --filter @videorc/desktop test
cargo test -p videorc-backend
cargo clippy -p videorc-backend -- -D warnings
```

Real-app gate (boots the dev app, records a test pattern, gates on quality):

```powershell
$env:VIDEORC_ALLOW_UNSUPPORTED_WINDOWS = '1'
pnpm smoke:dev
```

Packaged native-screen acceptance (requires `VIDEORC_PERF_APP_EXECUTABLE` plus
the bundled FFmpeg/FFprobe paths, as configured in `.github/workflows/windows.yml`):

```powershell
pnpm smoke:windows-native-screen
pnpm smoke:recording-native-preview
pnpm smoke:windows-live-audio-controls
```

The first command selects DXGI (gdigrab fallback), validates decoded BMP pixels
and frame advancement during a real ScreenOnly recording, then inspects the final
artifact. The second keeps the detached Electron proof surface mounted and fed by
that real source throughout recording. The third requires a physical DirectShow
microphone and a steady, unclipped calibration tone. It records and streams while
checking acknowledged gain, mute, unmute, and stop-during-update behavior against
the resulting audio artifacts. No available physical microphone is an explicit
blocked gate, not a synthetic pass.

Full Windows merge gate (release build + package + packaged smoke; slow):

```powershell
$env:VIDEORC_ALLOW_UNSUPPORTED_WINDOWS = '1'   # only needed below Windows 11
pnpm smoke:local-gates:windows
```

## Windows-specific launcher rules (for smoke/script authors)

Learned on-box 2026-07-08; encoded in `scripts/lib/app-launcher.mjs`:

- Spawn `pnpm` with `shell: true` on win32 (the pnpm shim is a `.cmd`; Node
  also blocks direct `.cmd` spawns without a shell — CVE-2024-27980).
- Never combine `detached: true` with `shell: true` on win32: the child runs
  but its piped stdout/stderr silently never arrive, so marker handshakes
  (`[smoke] backend-ready …`) time out with zero output. `detached` is
  POSIX-only in `devAppSpawnOptions`.
- There are no POSIX process groups: `stopProcess` tree-kills via
  `taskkill /PID <pid> /T` (`/F` on escalation). Killing only the direct child
  leaks the pnpm -> electron -> cargo -> backend chain.
- Derive `ffprobe` from a configured ffmpeg path with `.exe` awareness
  (`resolveSiblingFfprobe` in `scripts/smoke-recording-session.mjs`), and use
  `basename()` instead of `split('/')` for path math (`recording-analyzer.mjs`).
- Do **not** write package scripts as `VAR=1 node script.mjs` — pnpm on Windows
  runs those through `cmd.exe`, which treats `VAR=1` as a command name
  (`'VAR' is not recognized…`). Package aliases use the dependency-free
  `scripts/run-with-env.mjs` launcher instead. Its `--platform=darwin` guard
  makes macOS-only capture and VideoToolbox aliases fail with a clear message
  before they spawn anything. Prefer ordinary CLI flags when the script already
  exposes them, or set env in the parent Node `spawn({ env })`.

## electron-builder winCodeSign / symlink privilege

Packaging used to pull the legacy `winCodeSign` tool bundle (for rcedit /
signtool). That archive contains macOS dylib **symlinks**. On Windows without
**Developer Mode** (or an elevated shell), 7-Zip fails with:

```text
ERROR: Cannot create symbolic link : A required privilege is not held by the client.
... winCodeSign\...\darwin\10.12\lib\libcrypto.dylib
```

Unsigned local packages set `win.signAndEditExecutable: false` in
`apps/desktop/electron-builder.yml` so packaging never downloads that bundle.
When Authenticode signing / exe resource editing is re-enabled, either:

1. Turn on **Settings → System → For developers → Developer Mode**, then clear
   the broken cache and rebuild:

   ```powershell
   Remove-Item "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign" -Recurse -Force -ErrorAction SilentlyContinue
   pnpm --filter @videorc/desktop package
   ```

2. Or run the first package once from an **Administrator** PowerShell so the
   extract can create those links.

## FFmpeg pin rot

`vendor/ffmpeg/windows-pin.json` pins a BtbN autobuild URL + sha256. BtbN
deletes old autobuild releases, so the pin 404s over time. Re-pin by picking a
current `ffmpeg-n8.x-*-win64-lgpl-8.x.zip` from
https://github.com/BtbN/FFmpeg-Builds/releases, downloading it, and recording
its sha256 in the pin (LGPL-only assets — repo policy).
