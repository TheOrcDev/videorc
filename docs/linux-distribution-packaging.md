# Linux Distribution Packaging

Distribution-native packages for Videorc (Plan 071): `.deb` for Ubuntu/Debian
the app is built on (Ubuntu 24.04 LTS baseline), a checked-in AUR binary
`PKGBUILD` (`videorc-bin`) for Arch, and `.rpm` for Fedora/RHEL. Every package
carries the same payload and the same guarantees as the AppImage: the release
backend, the pinned **LGPL-only** bundled FFmpeg (VAAPI + OpenH264) with
LICENSE/SOURCE/BUILD-CONFIG, the AppStream metainfo, the desktop entry, and the
hicolor icon set. **No package ever depends on a distro ffmpeg.**

## Formats and targets

| Format | Target | Status | Acceptance |
| --- | --- | --- | --- |
| AppImage | `electron-builder --linux dir AppImage` | shipping lane (candidate-only) | Ubuntu 24.04 named box (L6) |
| deb | `electron-builder --linux dir AppImage deb rpm` | config + CI validation done | Ubuntu 24.04 named box: `dpkg -i` + launch + portal capture smoke |
| rpm | same run | config + CI structural validation done | blocked until a named Fedora/RHEL box records install/launch acceptance |
| AUR | checked-in `packaging/linux/arch/PKGBUILD` (`videorc-bin`) | checked in for submission | AUR submission + `makepkg -i` on an Arch host |

The AUR path is the checked-in binary PKGBUILD, never the electron-builder
`pacman` target: the PKGBUILD extracts the AppImage payload (no FUSE, no distro
ffmpeg) into `/opt/videorc` and wires freedesktop integration. The `source` URL
is the planned public downloads URL; the release lane uploads candidates to a
private prefix today, so `sha256sums` is `SKIP` only while that URL stays
private. **AUR submission gate:** before the downloads URL goes live or the
PKGBUILD is submitted to the AUR, `sha256sums` must be pinned to the release
lane's `<artifact>.sha256` sidecar value and verified by `makepkg` against the
fetched AppImage; submission while `sha256sums` is `SKIP` is not allowed.

## Install paths and integration

electron-builder installs the payload under `/opt/Videorc/` with a
`/usr/bin/videorc` launcher. deb/rpm post-install scripts copy the payload
metainfo (`resources/metainfo/dev.theorcdev.videorc.metainfo.xml`) into
`/usr/share/metainfo/` and refresh the icon/desktop caches. On upgrade, distro
package managers run the new package's post-install before the old package's
post-remove, so the post-remove scripts only delete the system metainfo when
the payload is already gone (guards in `packaging/linux/deb/after-remove.sh`
and `packaging/linux/rpm/after-remove.sh`).

- deb depends: `libgtk-3-0t64 libnss3 libasound2t64 libatk-bridge2.0-0t64`
  (Ubuntu 24.04 `t64` names — the `t64` runtime libs do not exist on older
  LTSes); Recommends: `libva2 pipewire xdg-desktop-portal`.
- rpm depends: `gtk3 nss alsa-lib at-spi2-core pipewire`;
  Recommends: `libva xdg-desktop-portal`. OpenH264 covers the software
  fallback, so the packages must install without VAAPI drivers or the portal.
- AUR `depends`: `gtk3 nss alsa-lib at-spi2-core pipewire`;
  optdepends: VAAPI drivers (Intel/AMD/NVIDIA) plus `xdg-desktop-portal` for
  Wayland screen capture.

## Update posture

`latest-linux.yml` is **AppImage-only**. Native installs are updated by the
distro package manager, never by the in-app updater:

- On a native Linux install (`process.platform === 'linux'` and no `APPIMAGE`
  env), `updater.ts` reports `unsupported` with reason `linux-native-install`
  and never probes the feed; background re-checks stay off for that reason.
- Settings → About & updates shows: "Updates are managed by your package
  manager on this install".
- DebUpdater/RpmUpdater artifacts are deliberately never published, so a native
  install cannot silently hit a feed that would never carry its artifacts.

## Release lane

`release-linux-alpha.yml` builds `AppImage + deb + rpm` in one
electron-builder run (`pnpm package:desktop:linux:dist`), validates each
payload, and stores deb/rpm beside the AppImage under the same immutable
private candidate prefix
(`candidates/linux-alpha/<releaseId>/<sourceCommit>/`). `release.json` and
`latest-linux.yml` stay AppImage-only; `upload-linux-dist-packages.mjs`
uploads exactly the deb/rpm objects and reuses the AppImage uploader's
immutability and collision rules.

## Validation

- `pnpm validate:linux:dist` inspects built deb/rpm payloads (naming contract
  `Videorc-<version>-linux-x64.{deb,rpm}`, positive size, `/usr/bin/videorc`,
  bundled backend, bundled ffmpeg/ffprobe + LICENSE/SOURCE/BUILD-CONFIG, payload
  metainfo, desktop entry, hicolor icons). Listing backends: `dpkg-deb -c` for
  deb, `rpm -qpl` for rpm, bsdtar fallback for both.
- `node --test scripts/lib/linux-dist-package.test.mjs` pins the pure contract
  + icon logic (`assertLinuxAppIconPng`, 512x512).
- `appstreamcli validate packaging/linux/metainfo/dev.theorcdev.videorc.metainfo.xml`
  runs in the Linux CI gate; the 512x512 PNG IHDR check runs there too.
- `makepkg --printsrcinfo > .SRCINFO` from `packaging/linux/arch/` regenerates
  the checked-in `.SRCINFO` after PKGBUILD edits; it must stay in sync.

## Version bumps per release

- `packaging/linux/metainfo/dev.theorcdev.videorc.metainfo.xml` `<releases>`
  entry: add one `<release version="..." date="..."/>` per shipped release.
- `packaging/linux/arch/PKGBUILD` `pkgver` (and regenerate `.SRCINFO`).
- Re-pin the AUR `sha256sums` from the release lane `<artifact>.sha256` sidecar
  once the public downloads URL exists; verify it with `makepkg` against the
  fetched AppImage before any AUR submission (see the submission gate above).

## Documented gates (AGENTS.md)

- Structural + unit gates run locally and in CI (`node --test`, appstreamcli).
- deb/rpm payload validation runs locally when a built package exists
  (`pnpm validate:linux:dist`).
- rpm install/launch acceptance is blocked until a named Fedora box is recorded
  here with its install/launch/record evidence.
- A full packaged run needs a real Ubuntu 24.04 box: `dpkg -i` the deb, launch,
  and drive a portal capture smoke.