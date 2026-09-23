#!/usr/bin/env bash
set -euo pipefail
[[ "${MSYSTEM:-}" == UCRT64 ]] || { echo 'Use MSYS2 UCRT64 to build the Windows capture worker.' >&2; exit 1; }
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_EXE="$(cygpath -u "${VIDEORC_NODE_EXECUTABLE:?Pass the Windows Node executable from the build wrapper}")"
PIN="${REPO_ROOT}/vendor/ffmpeg/windows-capture-pin.json"
VERSION="$("${NODE_EXE}" -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).version' "${PIN}")"
SOURCE_URL="$("${NODE_EXE}" -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).sourceUrl' "${PIN}")"
SOURCE_SHA="$("${NODE_EXE}" -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).sourceSha256' "${PIN}")"
ARCHIVE="${REPO_ROOT}/vendor/ffmpeg/_src/ffmpeg-${VERSION}.tar.xz"
WORK="${REPO_ROOT}/vendor/ffmpeg/_build/windows-capture"
DEST="${REPO_ROOT}/vendor/ffmpeg/windows-x64"
PATCH="${REPO_ROOT}/scripts/patches/dshow-capture-clock.patch"
[[ -f "${DEST}/bin/ffmpeg.exe" ]] || { echo 'Fetch the pinned output FFmpeg first (pnpm ffmpeg:fetch:windows).' >&2; exit 1; }
if [[ "${FFMPEG_CAPTURE_REBUILD:-0}" != 1 ]] && "${NODE_EXE}" "${REPO_ROOT}/scripts/ffmpeg-capture-windows.mjs" "${DEST}"; then
  echo 'Using verified Windows capture worker.'
  exit 0
fi
mkdir -p "$(dirname "${ARCHIVE}")"
[[ -f "${ARCHIVE}" ]] || curl -fL "${SOURCE_URL}" -o "${ARCHIVE}"
printf '%s  %s\n' "${SOURCE_SHA}" "${ARCHIVE}" | sha256sum -c -
rm -rf "${WORK}"
mkdir -p "${WORK}/source" "${WORK}/build"
tar -xJf "${ARCHIVE}" --strip-components=1 -C "${WORK}/source"
patch --batch --forward -d "${WORK}/source" -p1 < "${PATCH}"
mapfile -t CONFIGURE_FLAGS < <("${NODE_EXE}" "${REPO_ROOT}/scripts/ffmpeg-capture-windows.mjs" --configure-flags)
cd "${WORK}/build"
"${WORK}/source/configure" "${CONFIGURE_FLAGS[@]}" 2>&1 | tee "${WORK}/configure-output.log"
"${NODE_EXE}" "${REPO_ROOT}/scripts/ffmpeg-capture-windows.mjs" --check-configure-log "${WORK}/configure-output.log"
make -j"${JOBS:-2}"
mkdir -p "${DEST}/bin" "${DEST}/capture/source-patches"
cp ffmpeg.exe "${DEST}/bin/ffmpeg-capture.exe"
cp "${PATCH}" "${DEST}/capture/source-patches/dshow-capture-clock.patch"
cp "${WORK}/source/COPYING.LGPLv2.1" "${DEST}/capture/LICENSE.txt"
{ gcc --version; ld --version; nasm -v; make --version; pkgconf --version; } > "${DEST}/capture/TOOLCHAIN.txt"
"${NODE_EXE}" "${REPO_ROOT}/scripts/ffmpeg-capture-windows.mjs" --write-manifest "${DEST}"
"${NODE_EXE}" "${REPO_ROOT}/scripts/ffmpeg-capture-windows.mjs" "${DEST}"
