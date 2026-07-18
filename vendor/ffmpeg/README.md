# Bundled FFmpeg

Videorc packages FFmpeg as a separate executable resource for the public macOS
Beta and for gated Windows Alpha candidates. Public users must not need a
separate Homebrew, Chocolatey, or manual FFmpeg installation.

The bundle must be built without `--enable-gpl` and without `--enable-nonfree`.
The macOS build script stages the current architecture at:

```text
vendor/ffmpeg/current/
```

That directory is intentionally ignored by git. Build it locally or in CI with:

```sh
pnpm ffmpeg:build:macos
```

The staged bundle includes:

- `bin/ffmpeg`
- `NOTICE.txt`
- `SOURCE.txt`
- `BUILD-CONFIG.txt`
- FFmpeg LGPL license texts and upstream license overview from the exact source archive

Do not commit generated FFmpeg binaries to this repository. Release artifacts
should include the staged bundle as an Electron extra resource.

## Windows Alpha bundle

Windows 11 x64 uses the prebuilt LGPL archive pinned by URL and SHA-256 in
`windows-pin.json`. Fetch and verify it with:

```sh
pnpm ffmpeg:fetch:windows
```

The ignored staging directory is:

```text
vendor/ffmpeg/windows-x64/
```

It must contain:

- `bin/ffmpeg.exe`
- `bin/ffprobe.exe`
- `LICENSE.txt`
- `SOURCE.txt`, including the exact archive URL and SHA-256

The fetcher refuses a non-LGPL asset and fails closed on a digest or archive
layout mismatch. `ffprobe.exe` is release-critical: recording analysis, repair,
and acceptance gates derive it as the sibling of the bundled `ffmpeg.exe`.

An installer built with this bundle is still only an Alpha candidate. FFmpeg
preflight, package notices, Authenticode, malware scanning, strict support-bundle
verification, and the complete Windows acceptance record must all pass before
publication. Keep downloaded archives and staged binaries out of git; publish
the corresponding-source breadcrumb beside the installer according to
[../../docs/distribution.md](../../docs/distribution.md).
