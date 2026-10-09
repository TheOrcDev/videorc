import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  assessLinuxDistPackageFacts,
  assertLinuxAppIconPng,
  assertLinuxDistArtifactNameTemplate,
  expandElectronBuilderArtifactName,
  isLinuxDistPackageFilename,
  linuxDistPackageFilename,
  LinuxDistPackageError,
  normalizePackageMemberPath,
  readPngDimensions
} from './linux-dist-package.mjs'

const FULL_DEB_PAYLOAD = [
  './usr/bin/videorc',
  './opt/Videorc/videorc',
  './opt/Videorc/resources/videorc-backend',
  './opt/Videorc/resources/ffmpeg/bin/ffmpeg',
  './opt/Videorc/resources/ffmpeg/bin/ffprobe',
  './opt/Videorc/resources/ffmpeg/LICENSE.txt',
  './opt/Videorc/resources/ffmpeg/SOURCE.txt',
  './opt/Videorc/resources/ffmpeg/BUILD-CONFIG.txt',
  './opt/Videorc/resources/metainfo/dev.theorcdev.videorc.metainfo.xml',
  './usr/share/applications/videorc.desktop',
  './usr/share/icons/hicolor/512x512/apps/videorc.png',
  './usr/share/icons/hicolor/256x256/apps/videorc.png',
  './usr/share/icons/hicolor/128x128/apps/videorc.png',
  './usr/share/icons/hicolor/64x64/apps/videorc.png',
  './usr/share/icons/hicolor/48x48/apps/videorc.png'
]

function rpmPayload(payload = FULL_DEB_PAYLOAD) {
  // rpm cpio listings have no ./ prefix.
  return payload.map((member) => member.replace(/^\.\//, ''))
}

describe('linux distro package filename contract', () => {
  it('formats the exact Videorc-<version>-linux-x64.<ext> names', () => {
    assert.equal(linuxDistPackageFilename('0.9.120', 'deb'), 'Videorc-0.9.120-linux-x64.deb')
    assert.equal(linuxDistPackageFilename('0.9.120', 'rpm'), 'Videorc-0.9.120-linux-x64.rpm')
    assert.throws(() => linuxDistPackageFilename('0.9.120', 'flatpak'), LinuxDistPackageError)
  })

  it('recognizes only the contract filenames', () => {
    assert.equal(isLinuxDistPackageFilename('Videorc-0.9.120-linux-x64.deb'), true)
    assert.equal(isLinuxDistPackageFilename('Videorc-0.9.120-linux-x64.rpm'), true)
    // Electron-builder's natural (unfixed) expansion and non-contract names fail.
    assert.equal(isLinuxDistPackageFilename('Videorc-0.9.120-linux-x86_64.deb'), false)
    assert.equal(isLinuxDistPackageFilename('Videorc-0.9.120-linux-x64.AppImage'), false)
    assert.equal(isLinuxDistPackageFilename('Videorc-0.9.120-amd64.rpm'), false)
    assert.equal(isLinuxDistPackageFilename(''), false)
  })

  it('rejects an artifactName template that expands ${arch}', () => {
    assert.throws(
      () => assertLinuxDistArtifactNameTemplate('${productName}-${version}-${os}-${arch}.${ext}'),
      LinuxDistPackageError
    )
  })

  it('accepts the hardcoded-x64 template used by the release lane', () => {
    assert.doesNotThrow(() =>
      assertLinuxDistArtifactNameTemplate('${productName}-${version}-${os}-x64.${ext}')
    )
  })

  it('pins the exact expansion for deb and rpm', () => {
    const vars = {
      productName: 'Videorc',
      version: '0.9.120',
      os: 'linux',
      arch: 'x86_64'
    }
    assert.equal(
      expandElectronBuilderArtifactName('${productName}-${version}-${os}-x64.${ext}', {
        ...vars,
        ext: 'deb'
      }),
      'Videorc-0.9.120-linux-x64.deb'
    )
    assert.equal(
      expandElectronBuilderArtifactName('${productName}-${version}-${os}-x64.${ext}', {
        ...vars,
        ext: 'rpm'
      }),
      'Videorc-0.9.120-linux-x64.rpm'
    )
  })
})

describe('package member path normalization', () => {
  it('strips the leading ./ and / prefixes', () => {
    assert.equal(normalizePackageMemberPath('./usr/bin/videorc'), 'usr/bin/videorc')
    assert.equal(normalizePackageMemberPath('usr/bin/videorc'), 'usr/bin/videorc')
    assert.equal(normalizePackageMemberPath('/opt/Videorc/videorc'), 'opt/Videorc/videorc')
  })
})

describe('assessLinuxDistPackageFacts', () => {
  it('accepts a complete deb payload (dpkg-deb -c shape)', () => {
    const result = assessLinuxDistPackageFacts({
      filename: 'Videorc-0.9.120-linux-x64.deb',
      format: 'deb',
      payloadPaths: FULL_DEB_PAYLOAD,
      sizeBytes: 180_000_000
    })
    assert.equal(result.ok, true, result.problems.join('\n'))
    assert.equal(result.facts.desktopEntry, 'usr/share/applications/videorc.desktop')
    assert.equal(result.facts.payloadMemberCount, FULL_DEB_PAYLOAD.length)
  })

  it('accepts a complete rpm payload (rpm -qpl / bsdtar shape)', () => {
    const result = assessLinuxDistPackageFacts({
      filename: 'Videorc-0.9.120-linux-x64.rpm',
      format: 'rpm',
      payloadPaths: rpmPayload(),
      sizeBytes: 180_000_000
    })
    assert.equal(result.ok, true, result.problems.join('\n'))
  })

  it('flags a missing bundled FFmpeg and missing metainfo', () => {
    const withoutFfmpeg = FULL_DEB_PAYLOAD.filter(
      (member) =>
        !member.includes('/resources/ffmpeg/') &&
        !member.includes('/resources/metainfo/')
    )
    const result = assessLinuxDistPackageFacts({
      filename: 'Videorc-0.9.120-linux-x64.deb',
      format: 'deb',
      payloadPaths: withoutFfmpeg,
      sizeBytes: 180_000_000
    })
    assert.equal(result.ok, false)
    assert.match(result.problems.join('\n'), /bundled LGPL ffmpeg/)
    assert.match(result.problems.join('\n'), /metainfo/)
  })

  it('flags a deb payload with no icon set or desktop entry', () => {
    const sparse = FULL_DEB_PAYLOAD.filter((member) => {
      if (member.startsWith('./usr/share/icons/')) return false
      if (member.startsWith('./usr/share/applications/')) return false
      return true
    })
    const result = assessLinuxDistPackageFacts({
      filename: 'Videorc-0.9.120-linux-x64.deb',
      format: 'deb',
      payloadPaths: sparse,
      sizeBytes: 180_000_000
    })
    assert.equal(result.ok, false)
    assert.match(result.problems.join('\n'), /hicolor icon set/)
    assert.match(result.problems.join('\n'), /desktop entry/)
  })

  it('flags a zero-size artifact', () => {
    const result = assessLinuxDistPackageFacts({
      filename: 'Videorc-0.9.120-linux-x64.deb',
      format: 'deb',
      payloadPaths: FULL_DEB_PAYLOAD,
      sizeBytes: 0
    })
    assert.equal(result.ok, false)
    assert.match(result.problems.join('\n'), /empty or unreadable/)
  })

  it('flags the wrong extension for the asserted format', () => {
    const result = assessLinuxDistPackageFacts({
      filename: 'Videorc-0.9.120-linux-x64.rpm',
      format: 'deb',
      payloadPaths: FULL_DEB_PAYLOAD,
      sizeBytes: 180_000_000
    })
    assert.equal(result.ok, false)
    assert.match(result.problems.join('\n'), /does not end with \.deb/)
  })
})

describe('linux app icon PNG', () => {
  function pngHeader(width, height) {
    const buffer = Buffer.alloc(24)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
    buffer.writeUInt32BE(0x49484452, 12)
    buffer.writeUInt32BE(width, 16)
    buffer.writeUInt32BE(height, 20)
    return buffer
  }

  it('reads PNG dimensions from the IHDR chunk', () => {
    assert.deepEqual(readPngDimensions(pngHeader(512, 512)), { width: 512, height: 512 })
    assert.deepEqual(readPngDimensions(pngHeader(1024, 1024)), { width: 1024, height: 1024 })
    assert.equal(readPngDimensions(Buffer.alloc(23)), null)
    assert.equal(readPngDimensions(Buffer.from('not a png at all here...')), null)
  })

  it('accepts exactly the 512x512 icon electron-builder expects', () => {
    assert.doesNotThrow(() => assertLinuxAppIconPng(pngHeader(512, 512)))
    assert.throws(() => assertLinuxAppIconPng(pngHeader(256, 256)), LinuxDistPackageError)
    assert.throws(() => assertLinuxAppIconPng(Buffer.from('garbage')), LinuxDistPackageError)
  })
})