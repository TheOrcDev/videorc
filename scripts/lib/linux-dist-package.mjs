// Pure helpers for the Linux distro package lanes (deb/rpm, plan 071).
//
// The AppImage contract functions in linux-alpha-release.mjs are intentionally
// untouched; this module owns the deb/rpm filename contract and the payload
// facts that release validation and the CI lane both rely on. Everything here
// is pure so `node --test scripts/lib/*.test.mjs` covers it without a distro
// toolchain — the CLI wrapper (scripts/validate-linux-dist-package.mjs) turns
// package listings into these facts.

export class LinuxDistPackageError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LinuxDistPackageError'
    this.code = code
  }
}

export const LINUX_DIST_FORMATS = ['deb', 'rpm']

// Same hard-x64 rule as the AppImage contract: the Linux Alpha release lane
// stores Videorc-<version>-linux-x64.* and the electron-builder template must
// not expand ${arch} (which becomes x86_64 on Linux).
const LINUX_DIST_ARTIFACT_RE = /^Videorc-[A-Za-z0-9][A-Za-z0-9.+-]*-linux-x64\.(deb|rpm)$/

export function linuxDistPackageFilename(bundleVersion, format) {
  if (!LINUX_DIST_FORMATS.includes(format)) {
    throw new LinuxDistPackageError(
      'unsupported-format',
      `format must be one of ${LINUX_DIST_FORMATS.join(', ')}, got ${format}.`
    )
  }
  return `Videorc-${bundleVersion}-linux-x64.${format}`
}

export function isLinuxDistPackageFilename(filename) {
  return LINUX_DIST_ARTIFACT_RE.test(filename ?? '')
}

// Local mirror of expandElectronBuilderArtifactName (linux-alpha-release.mjs)
// so the AppImage contract functions stay untouched. Pure and tiny; the test
// suite pins the deb/rpm expansion behaviour.
export function expandElectronBuilderArtifactName(template, vars) {
  return template
    .replaceAll('${productName}', vars.productName)
    .replaceAll('${version}', vars.version)
    .replaceAll('${os}', vars.os)
    .replaceAll('${arch}', vars.arch)
    .replaceAll('${ext}', vars.ext)
}

export function assertLinuxDistArtifactNameTemplate(template) {
  if (typeof template !== 'string' || template.trim().length === 0) {
    throw new LinuxDistPackageError(
      'missing-artifact-name',
      'electron-builder linux.artifactName must be non-empty.'
    )
  }
  if (template.includes('${arch}')) {
    throw new LinuxDistPackageError(
      'arch-placeholder-artifact-name',
      'linux.artifactName must hardcode x64; ${arch} expands to x86_64 and breaks the Videorc-<version>-linux-x64.<ext> contract.'
    )
  }
  for (const format of LINUX_DIST_FORMATS) {
    const expanded = expandElectronBuilderArtifactName(template, {
      productName: 'Videorc',
      version: '0.10.0',
      os: 'linux',
      arch: 'x86_64',
      ext: format
    })
    const expected = linuxDistPackageFilename('0.10.0', format)
    if (expanded !== expected) {
      throw new LinuxDistPackageError(
        'artifact-name-template',
        `linux.artifactName "${template}" expands to "${expanded}" for ${format}; expected "${expected}".`
      )
    }
  }
}

// Normalize a package member path so comparisons are stable between deb
// (data.tar listings: ./usr/bin/...) and rpm (cpio listings: usr/bin/...).
export function normalizePackageMemberPath(member) {
  return (member ?? '').replace(/^\.\//, '').replace(/^\/+/, '')
}

// Payload members that every Videorc deb/rpm must carry. Derived purely from
// the listing so the same function validates a dpkg-deb -c output on Ubuntu,
// an rpm -qpl output on Fedora, or a bsdtar listing on a runner.
const METADATA_METAINFO_SUFFIX = 'dev.theorcdev.videorc.metainfo.xml'

export function assessLinuxDistPackageFacts({ filename, format, payloadPaths = [], sizeBytes }) {
  const problems = []
  const paths = payloadPaths.map(normalizePackageMemberPath)
  const hasMember = (suffix) => paths.includes(suffix)
  const desktopEntry = paths.find(
    (member) => member.startsWith('usr/share/applications/') && member.endsWith('.desktop')
  )
  const hasHicolorIcons = paths.some((member) => member.startsWith('usr/share/icons/hicolor/'))
  const hasMetainfoPayload = hasMember(`opt/Videorc/resources/metainfo/${METADATA_METAINFO_SUFFIX}`)

  if (!LINUX_DIST_FORMATS.includes(format)) {
    problems.push(`format must be one of ${LINUX_DIST_FORMATS.join(', ')}, got ${format}.`)
  }
  if (!filename.endsWith(`.${format}`)) {
    problems.push(`artifact filename "${filename}" does not end with .${format}.`)
  }
  if (!isLinuxDistPackageFilename(filename)) {
    problems.push(
      `artifact filename "${filename}" does not match the Videorc-<version>-linux-x64.<ext> contract.`
    )
  }
  if (!(Number.isFinite(sizeBytes) && sizeBytes > 0)) {
    problems.push('artifact is empty or unreadable (sizeBytes must be a positive number).')
  }
  if (!hasMember('usr/bin/videorc')) {
    problems.push('package is missing the /usr/bin/videorc launcher.')
  }
  if (!hasMember('opt/Videorc/resources/videorc-backend')) {
    problems.push('package is missing the bundled videorc-backend.')
  }
  if (!hasMember('opt/Videorc/resources/ffmpeg/bin/ffmpeg')) {
    problems.push('package is missing the bundled LGPL ffmpeg.')
  }
  if (!hasMember('opt/Videorc/resources/ffmpeg/bin/ffprobe')) {
    problems.push('package is missing the bundled ffprobe.')
  }
  if (!hasMember('opt/Videorc/resources/ffmpeg/LICENSE.txt')) {
    problems.push('package is missing the LGPL FFmpeg LICENSE.txt.')
  }
  if (!hasMember('opt/Videorc/resources/ffmpeg/SOURCE.txt')) {
    problems.push('package is missing the FFmpeg SOURCE.txt.')
  }
  if (!hasMember('opt/Videorc/resources/ffmpeg/BUILD-CONFIG.txt')) {
    problems.push('package is missing the FFmpeg BUILD-CONFIG.txt.')
  }
  if (!hasMetainfoPayload) {
    problems.push(`package is missing ${METADATA_METAINFO_SUFFIX} in the payload.`)
  }
  if (!desktopEntry) {
    problems.push('package is missing a desktop entry under usr/share/applications/.')
  }
  if (!hasHicolorIcons) {
    problems.push('package is missing the hicolor icon set under usr/share/icons/hicolor/.')
  }

  return {
    ok: problems.length === 0,
    problems,
    facts: {
      desktopEntry: desktopEntry ? normalizePackageMemberPath(desktopEntry) : null,
      hasHicolorIcons,
      hasMetainfoPayload,
      payloadMemberCount: paths.length
    }
  }
}

export function formatLinuxDistPackageReport(filename, result) {
  const lines = [`Linux distro package ${filename}: ${result.ok ? 'OK' : 'FAILED'}`]
  for (const problem of result.problems) {
    lines.push(`  ✘ ${problem}`)
  }
  if (result.ok && result.facts) {
    lines.push(
      `  payload members: ${result.facts.payloadMemberCount}; desktop: ${result.facts.desktopEntry}; icons: ${result.facts.hasHicolorIcons}; metainfo: ${result.facts.hasMetainfoPayload}`
    )
  }
  return lines.join('\n')
}

// PNG header helpers for the 512x512 build-resources/icon.png that drives the
// hicolor icon set in deb/rpm/AUR. Pure (Buffer in, result out) so the CI
// structural gate needs no ImageMagick.
export function readPngDimensions(buffer) {
  if (!buffer || buffer.length < 24) {
    return null
  }
  // PNG signature (8 bytes) then the IHDR chunk: type at 12, width at 16,
  // height at 20, all big-endian per the PNG spec.
  if (buffer.readUInt32BE(12) !== 0x49484452) {
    return null
  }
  return { height: buffer.readUInt32BE(20), width: buffer.readUInt32BE(16) }
}

export function assertLinuxAppIconPng(buffer) {
  const dimensions = readPngDimensions(buffer)
  if (!dimensions) {
    throw new LinuxDistPackageError(
      'icon-not-png',
      'apps/desktop/build-resources/icon.png must be a PNG image.'
    )
  }
  if (dimensions.width !== 512 || dimensions.height !== 512) {
    throw new LinuxDistPackageError(
      'icon-dimensions',
      `apps/desktop/build-resources/icon.png must be exactly 512x512, got ${dimensions.width}x${dimensions.height}.`
    )
  }
}