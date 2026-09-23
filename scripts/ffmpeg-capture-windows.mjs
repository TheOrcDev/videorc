import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export function verifyCaptureConfigureOutput(output) {
  const unmatched = output.match(
    /^WARNING: Option --(?:enable|disable)-[^\r\n]*did not match anything[^\r\n]*$/m
  )
  if (unmatched)
    throw new Error(`Capture worker configure rejected an explicit component: ${unmatched[0]}`)
}

export const CAPTURE_FLAGS = [
  '--disable-everything',
  '--disable-autodetect',
  '--disable-doc',
  '--disable-debug',
  '--disable-ffplay',
  '--disable-ffprobe',
  '--disable-network',
  '--disable-shared',
  '--enable-static',
  '--disable-gpl',
  '--disable-nonfree',
  '--enable-ffmpeg',
  '--enable-avdevice',
  '--enable-indev=dshow,lavfi',
  '--enable-filter=aresample,aformat,ashowinfo,anullsrc,sine,atrim,anull',
  '--enable-decoder=pcm_u8,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le',
  '--enable-encoder=pcm_f32le',
  '--enable-muxer=pcm_f32le',
  '--enable-protocol=pipe',
  '--extra-cflags=-D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00',
  '--extra-ldflags=-static',
  '--pkg-config-flags=--static'
]
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Read the actual PE import table; never trust a staged dependency inventory. */
export function peImports(bytes) {
  const need = (offset, length) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > bytes.length)
      throw new Error('Malformed PE import table.')
    return offset
  }
  if (bytes.toString('ascii', 0, 2) !== 'MZ')
    throw new Error('Capture worker is not a PE executable.')
  const pe = bytes.readUInt32LE(need(0x3c, 4))
  if (bytes.toString('ascii', need(pe, 4), pe + 4) !== 'PE\0\0')
    throw new Error('Missing PE signature.')
  if (bytes.readUInt16LE(need(pe + 4, 2)) !== 0x8664)
    throw new Error('Capture worker must target x64.')
  const count = bytes.readUInt16LE(need(pe + 6, 2))
  const optionalSize = bytes.readUInt16LE(need(pe + 20, 2))
  const optional = pe + 24
  if (optionalSize < 128) throw new Error('Truncated PE optional header.')
  need(optional, optionalSize)
  if (bytes.readUInt32LE(optional + 108) < 2) throw new Error('Missing PE data directories.')
  const magic = bytes.readUInt16LE(need(optional, 2))
  if (magic !== 0x20b) throw new Error('Capture worker must be a Windows x64 PE executable.')
  const importsRva = bytes.readUInt32LE(need(optional + 120, 4))
  const importsSize = bytes.readUInt32LE(need(optional + 124, 4))
  if (!importsRva || importsSize < 20 || count < 1 || count > 96)
    throw new Error('Capture worker has no valid import table.')
  const sections = Array.from({ length: count }, (_, index) => {
    const at = need(optional + optionalSize + index * 40, 40)
    return {
      rva: bytes.readUInt32LE(at + 12),
      size: bytes.readUInt32LE(at + 16),
      raw: bytes.readUInt32LE(at + 20)
    }
  })
  const fileOffset = (rva, size) => {
    const section = sections.find(
      (section) => rva >= section.rva && rva + size <= section.rva + section.size
    )
    if (!section) throw new Error('PE import points outside a file section.')
    return need(section.raw + rva - section.rva, size)
  }
  const imports = []
  for (let index = 0; index < Math.min(512, Math.floor(importsSize / 20)); index++) {
    const descriptor = fileOffset(importsRva + index * 20, 20)
    if (bytes.subarray(descriptor, descriptor + 20).every((byte) => byte === 0)) return imports
    const nameRva = bytes.readUInt32LE(descriptor + 12)
    const start = fileOffset(nameRva, 1)
    const end = bytes.indexOf(0, start)
    if (end < start || end - start > 256) throw new Error('Invalid imported DLL name.')
    fileOffset(nameRva, end - start + 1)
    const name = bytes.toString('ascii', start, end).toLowerCase()
    if (!/^[a-z0-9_.-]+\.dll$/.test(name)) throw new Error('Invalid imported DLL name.')
    imports.push(name)
  }
  throw new Error('Unterminated PE import table.')
}

export function verifySystemImports(imports) {
  const system = new Set([
    'kernel32.dll',
    'advapi32.dll',
    'bcrypt.dll',
    'ole32.dll',
    'oleaut32.dll',
    'user32.dll',
    'gdi32.dll',
    'msvcrt.dll',
    'ucrtbase.dll',
    'shell32.dll',
    'shlwapi.dll',
    'ws2_32.dll',
    'secur32.dll',
    'psapi.dll',
    'winmm.dll',
    'version.dll',
    'ntdll.dll',
    'strmiids.dll'
  ])
  if (imports.length === 0) throw new Error('Capture worker dependency proof is empty.')
  const unsupported = imports.filter(
    (name) => !system.has(name) && !/^(api|ext)-ms-win-[a-z0-9-]+\.dll$/.test(name)
  )
  if (unsupported.length)
    throw new Error(
      `Capture worker depends on unbundled/non-system DLLs: ${unsupported.join(', ')}`
    )
}

export function hasDshowClockProtocol(help) {
  return /^\s*-videorc_audio_clock\s+<boolean>.*Videorc DShow clock protocol 1\).*$/m.test(help)
}

export function expectedManifest(root = repo) {
  const pin = JSON.parse(readFileSync(join(root, 'vendor/ffmpeg/windows-capture-pin.json'), 'utf8'))
  return {
    ...pin,
    configureFlags: CAPTURE_FLAGS,
    patchSha256: sha(readFileSync(join(root, 'scripts/patches/dshow-capture-clock.patch'))),
    recipeSha256: sha(
      Buffer.concat(
        ['scripts/build-ffmpeg-capture-windows.sh', 'scripts/build-ffmpeg-capture-windows.mjs'].map(
          (path) => readFileSync(join(root, path))
        )
      )
    )
  }
}

export function verifyWindowsCaptureManifest(bundle, expected = expectedManifest()) {
  const manifest = JSON.parse(readFileSync(join(bundle, 'capture/MANIFEST.json'), 'utf8'))
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(manifest[key]) !== JSON.stringify(value))
      throw new Error(`Capture worker ${key} does not match the maintained build.`)
  }
  const binary = readFileSync(join(bundle, 'bin/ffmpeg-capture.exe'))
  if (manifest.executableSha256 !== sha(binary))
    throw new Error('Capture executable hash does not match its manifest.')
  if (
    sha(readFileSync(join(bundle, 'capture/source-patches/dshow-capture-clock.patch'))) !==
    expected.patchSha256
  )
    throw new Error('Capture distributed source patch does not match its manifest.')
  if (
    !readFileSync(join(bundle, 'capture/LICENSE.txt'), 'utf8').includes(
      'GNU LESSER GENERAL PUBLIC LICENSE'
    )
  )
    throw new Error('Capture worker LGPL license is missing.')
  if (!readFileSync(join(bundle, 'capture/TOOLCHAIN.txt'), 'utf8').trim())
    throw new Error('Capture worker toolchain evidence is missing.')
  const dependencies = peImports(binary)
  verifySystemImports(dependencies)
  return { manifest, dependencies }
}

export function probeWindowsCaptureWorker(bundle, run = execFileSync) {
  const binary = join(bundle, 'bin/ffmpeg-capture.exe')
  const options = {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  }
  if (!hasDshowClockProtocol(run(binary, ['-hide_banner', '-h', 'demuxer=dshow'], options)))
    throw new Error('Capture worker lacks DShow clock protocol 1.')
  const output = run(
    binary,
    [
      '-hide_banner',
      '-nostdin',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=997:sample_rate=44100',
      '-af',
      'aresample=48000:async=0,aformat=sample_fmts=flt:channel_layouts=stereo',
      '-frames:a',
      '5',
      '-c:a',
      'pcm_f32le',
      '-f',
      'f32le',
      'pipe:1'
    ],
    { ...options, encoding: undefined }
  )
  return verifyNormalizedCapture(output)
}

export function verifyNormalizedCapture(output) {
  if (output.length < 8 * 480 || output.length % 8 !== 0)
    throw new Error('Capture worker did not produce complete stereo float PCM.')
  let peak = 0
  const crossings = []
  let previous = 0
  for (let offset = 0; offset < output.length; offset += 8) {
    const left = output.readFloatLE(offset),
      right = output.readFloatLE(offset + 4)
    if (!Number.isFinite(left) || left !== right)
      throw new Error('Capture normalization produced invalid stereo samples.')
    peak = Math.max(peak, Math.abs(left))
    if (previous < 0 && left >= 0) crossings.push(offset / 8 - 1 + -previous / (left - previous))
    previous = left
  }
  if (peak < 0.01 || peak > 1) throw new Error('Capture normalization has no valid tone signal.')
  if (crossings.length < 10) throw new Error('Insufficient normalized tone cycles.')
  const measuredFrequency = ((crossings.length - 1) * 48000) / (crossings.at(-1) - crossings[0])
  if (Math.abs(measuredFrequency - 997) > 3)
    throw new Error('Capture worker did not normalize its tone to 48 kHz.')
  return { protocol: 1, normalizedFrames: output.length / 8, peak, measuredFrequency }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--configure-flags') console.log(CAPTURE_FLAGS.join('\n'))
  else if (process.argv[2] === '--check-configure-log')
    verifyCaptureConfigureOutput(readFileSync(process.argv[3], 'utf8'))
  else {
    const writing = process.argv[2] === '--write-manifest'
    const bundle = resolve(process.argv[writing ? 3 : 2] ?? 'vendor/ffmpeg/windows-x64')
    if (writing) {
      const expected = expectedManifest()
      writeFileSync(
        join(bundle, 'capture/MANIFEST.json'),
        JSON.stringify(
          {
            ...expected,
            executableSha256: sha(readFileSync(join(bundle, 'bin/ffmpeg-capture.exe')))
          },
          null,
          2
        ) + '\n'
      )
      writeFileSync(
        join(bundle, 'capture/SOURCE.txt'),
        `Videorc capture-only FFmpeg ${expected.version}\nSource: ${expected.sourceUrl}\nSource SHA-256: ${expected.sourceSha256}\nModified with distributed source-patches/dshow-capture-clock.patch (SHA-256 ${expected.patchSha256}).\nBuild flags/toolchain and binary fingerprint: MANIFEST.json and TOOLCHAIN.txt.\nCorresponding source consists of the exact upstream archive and this patch.\n`
      )
    }
    console.log(
      JSON.stringify({
        ...verifyWindowsCaptureManifest(bundle),
        ...probeWindowsCaptureWorker(bundle)
      })
    )
  }
}
