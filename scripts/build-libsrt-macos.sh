#!/usr/bin/env bash
# Plan 255: builds libsrt (Haivision SRT, MPL-2.0) for the SRT Camera and
# stages it at vendor/libsrt/current/, the way build-ffmpeg-macos.sh stages
# FFmpeg. OpenSSL 3 is linked statically, so the packaged app never needs
# Homebrew. The backend loads the dylib at run time (srt_camera/libsrt.rs).
set -euo pipefail

SRT_VERSION="${SRT_VERSION:-1.5.7}"
SRT_SOURCE_SHA256="${SRT_SOURCE_SHA256:-017cd1e437ef2073a4dd10ddf7b55e86bc3d6ebac0393d13bd22f6a57055d32b}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="$(uname -m)"
SOURCE_URL="https://github.com/Haivision/srt/archive/refs/tags/v${SRT_VERSION}.tar.gz"
SOURCE_DIR="${REPO_ROOT}/vendor/libsrt/_src"
BUILD_DIR="${REPO_ROOT}/vendor/libsrt/_build/macos-${ARCH}"
CURRENT_DIR="${REPO_ROOT}/vendor/libsrt/current"
TARBALL="${SOURCE_DIR}/srt-${SRT_VERSION}.tar.gz"
EXTRACTED_DIR="${SOURCE_DIR}/srt-${SRT_VERSION}"
JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The libsrt bundle build must run on macOS." >&2
  exit 1
fi

if [[ -f "${CURRENT_DIR}/lib/libsrt.dylib" && -f "${CURRENT_DIR}/SOURCE.txt" && "${LIBSRT_REBUILD:-0}" != "1" ]]; then
  if grep -q "SRT version: ${SRT_VERSION}$" "${CURRENT_DIR}/SOURCE.txt"; then
    echo "Using existing libsrt ${SRT_VERSION} at ${CURRENT_DIR}/lib/libsrt.dylib"
    exit 0
  fi
  echo "Rebuilding libsrt: the staged copy is not ${SRT_VERSION}." >&2
fi

if ! command -v cmake >/dev/null 2>&1; then
  echo "cmake is required (brew install cmake)." >&2
  exit 1
fi

OPENSSL_PREFIX="${VIDEORC_OPENSSL_PREFIX:-$(brew --prefix openssl@3 2>/dev/null || true)}"
if [[ -z "${OPENSSL_PREFIX}" || ! -f "${OPENSSL_PREFIX}/lib/libcrypto.a" ]]; then
  echo "OpenSSL static libraries not found. Install openssl@3 (brew install openssl@3) or set VIDEORC_OPENSSL_PREFIX." >&2
  exit 1
fi

mkdir -p "${SOURCE_DIR}"
if [[ ! -f "${TARBALL}" ]]; then
  echo "Downloading ${SOURCE_URL}"
  curl -fL "${SOURCE_URL}" -o "${TARBALL}"
fi
ACTUAL_SHA256="$(shasum -a 256 "${TARBALL}" | awk '{print $1}')"
if [[ "${ACTUAL_SHA256}" != "${SRT_SOURCE_SHA256}" ]]; then
  echo "libsrt source checksum mismatch." >&2
  echo "Expected: ${SRT_SOURCE_SHA256}" >&2
  echo "Actual:   ${ACTUAL_SHA256}" >&2
  exit 1
fi

rm -rf "${EXTRACTED_DIR}" "${BUILD_DIR}" "${CURRENT_DIR}"
tar -xzf "${TARBALL}" -C "${SOURCE_DIR}"

# Only the static archive is visible to the linker: with the .dylib beside
# it, the linker would pick Homebrew's dylib.
OPENSSL_STATIC_DIR="${BUILD_DIR}/openssl-static"
mkdir -p "${OPENSSL_STATIC_DIR}/lib"
cp "${OPENSSL_PREFIX}/lib/libcrypto.a" "${OPENSSL_STATIC_DIR}/lib/"
ln -s "${OPENSSL_PREFIX}/include" "${OPENSSL_STATIC_DIR}/include"

CMAKE_FLAGS=(
  "-DCMAKE_BUILD_TYPE=Release"
  "-DCMAKE_INSTALL_PREFIX=${BUILD_DIR}/install"
  "-DCMAKE_OSX_ARCHITECTURES=${ARCH}"
  "-DCMAKE_OSX_DEPLOYMENT_TARGET=${MACOSX_DEPLOYMENT_TARGET:-13.0}"
  "-DCMAKE_INSTALL_NAME_DIR=@rpath"
  "-DENABLE_SHARED=ON"
  "-DENABLE_STATIC=OFF"
  "-DENABLE_APPS=OFF"
  "-DENABLE_ENCRYPTION=ON"
  "-DUSE_ENCLIB=openssl-evp"
  "-DUSE_OPENSSL_PC=OFF"
  "-DOPENSSL_USE_STATIC_LIBS=ON"
  "-DOPENSSL_ROOT_DIR=${OPENSSL_STATIC_DIR}"
  "-DOPENSSL_CRYPTO_LIBRARY=${OPENSSL_STATIC_DIR}/lib/libcrypto.a"
  "-DOPENSSL_INCLUDE_DIR=${OPENSSL_PREFIX}/include"
  "-DENABLE_BONDING=OFF"
  "-DENABLE_CXX_DEPS=OFF"
)

cmake -S "${EXTRACTED_DIR}" -B "${BUILD_DIR}/cmake" "${CMAKE_FLAGS[@]}"
cmake --build "${BUILD_DIR}/cmake" --parallel "${JOBS}"
cmake --install "${BUILD_DIR}/cmake"

DYLIB="$(find "${BUILD_DIR}/install/lib" -name 'libsrt.*.dylib' -type f | head -1)"
if [[ -z "${DYLIB}" ]]; then
  echo "The libsrt build produced no dylib." >&2
  exit 1
fi

# Fail closed: the packaged app must not depend on Homebrew.
if otool -L "${DYLIB}" | tail -n +2 | grep -Eq '/(opt/homebrew|usr/local)/'; then
  echo "Refusing to stage libsrt linked against Homebrew or /usr/local dylibs:" >&2
  otool -L "${DYLIB}" >&2
  exit 1
fi
if ! nm -gU "${DYLIB}" | grep -q ' _srt_listen_callback$'; then
  echo "Refusing to stage libsrt without srt_listen_callback." >&2
  exit 1
fi

mkdir -p "${CURRENT_DIR}/lib" "${CURRENT_DIR}/licenses"
cp "${DYLIB}" "${CURRENT_DIR}/lib/libsrt.dylib"
install_name_tool -id "@rpath/libsrt.dylib" "${CURRENT_DIR}/lib/libsrt.dylib"
codesign --force --sign - "${CURRENT_DIR}/lib/libsrt.dylib"
cp "${EXTRACTED_DIR}/LICENSE" "${CURRENT_DIR}/licenses/LICENSE-libsrt-MPL-2.0.txt"

cat > "${CURRENT_DIR}/NOTICE.txt" <<NOTICE
This product includes libsrt, the Secure Reliable Transport library by
Haivision Systems Inc., licensed under the Mozilla Public License 2.0
(licenses/LICENSE-libsrt-MPL-2.0.txt). Its source files are unmodified; the
exact source archive is named in SOURCE.txt.

This build statically links OpenSSL (https://www.openssl.org/), licensed
under the Apache License 2.0, for SRT encryption.

SRT project: https://github.com/Haivision/srt
NOTICE

cat > "${CURRENT_DIR}/SOURCE.txt" <<SOURCE
SRT source archive: ${SOURCE_URL}
SRT version: ${SRT_VERSION}
Source SHA-256: ${SRT_SOURCE_SHA256}

Exact CMake configuration:
cmake ${CMAKE_FLAGS[*]}
SOURCE

echo "Staged libsrt ${SRT_VERSION} at ${CURRENT_DIR}/lib/libsrt.dylib"
otool -L "${CURRENT_DIR}/lib/libsrt.dylib"
