import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  CAPTURE_FLAGS,
  hasDshowClockProtocol,
  peImports,
  verifySystemImports,
  verifyNormalizedCapture,
  verifyWindowsCaptureManifest
} from '../ffmpeg-capture-windows.mjs'

function pe(dll = 'KERNEL32.dll') {
  const bytes = Buffer.alloc(1024)
  bytes.write('MZ')
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.write('PE\0\0', 0x80)
  bytes.writeUInt16LE(0x8664, 0x84)
  bytes.writeUInt16LE(1, 0x86)
  bytes.writeUInt16LE(240, 0x94)
  const optional = 0x98
  bytes.writeUInt16LE(0x20b, optional)
  bytes.writeUInt32LE(16, optional + 108)
  bytes.writeUInt32LE(0x1000, optional + 120)
  bytes.writeUInt32LE(40, optional + 124)
  const section = optional + 240
  bytes.writeUInt32LE(0x1000, section + 12)
  bytes.writeUInt32LE(512, section + 16)
  bytes.writeUInt32LE(512, section + 20)
  bytes.writeUInt32LE(0x1080, 512 + 12)
  bytes.write(dll + '\0', 640)
  return bytes
}
function tone(rate) {
  const bytes = Buffer.alloc(4800 * 8)
  for (let frame = 0; frame < 4800; frame++) {
    const sample = 0.12 * Math.sin((2 * Math.PI * 997 * frame) / rate)
    bytes.writeFloatLE(sample, frame * 8)
    bytes.writeFloatLE(sample, frame * 8 + 4)
  }
  return bytes
}

test('capture worker requires exact protocol, static minimal recipe, and measured48k stereo', () => {
  const help =
    '  -videorc_audio_clock <boolean> export exact packet capture clock metadata (Videorc DShow clock protocol 1) (default false)'
  assert.equal(hasDshowClockProtocol(help), true)
  for (const bad of [
    '',
    help.replace('protocol 1)', 'protocol 10)'),
    help.replace('protocol 1)', 'protocol 0)')
  ])
    assert.equal(hasDshowClockProtocol(bad), false)
  for (const required of [
    '--disable-network',
    '--disable-gpl',
    '--disable-nonfree',
    '--enable-static',
    '--extra-ldflags=-static'
  ])
    assert.ok(CAPTURE_FLAGS.includes(required))
  assert.ok(Math.abs(verifyNormalizedCapture(tone(48000)).measuredFrequency - 997) < 1)
  assert.throws(() => verifyNormalizedCapture(tone(44100)), /48 kHz/)
  assert.throws(() => verifyNormalizedCapture(Buffer.alloc(4800 * 8)), /tone/)
  const invalid = tone(48000)
  invalid.writeFloatLE(NaN, 32)
  assert.throws(() => verifyNormalizedCapture(invalid), /invalid stereo/)
  assert.throws(() => verifyNormalizedCapture(tone(48000).subarray(1)), /complete stereo/)
})

test('actual PE import table refuses wrong architecture malformed ranges and compiler runtime DLLs', () => {
  assert.deepEqual(peImports(pe()), ['kernel32.dll'])
  verifySystemImports(peImports(pe()))
  assert.throws(() => verifySystemImports(peImports(pe('libwinpthread-1.dll'))), /unbundled/)
  assert.throws(() => verifySystemImports(peImports(pe('msys-2.0.dll'))), /unbundled/)
  const arm = pe()
  arm.writeUInt16LE(0xaa64, 0x84)
  assert.throws(() => peImports(arm), /x64/)
  const small = pe()
  small.writeUInt16LE(16, 0x94)
  assert.throws(() => peImports(small), /Truncated/)
  const outside = pe()
  outside.writeUInt32LE(0x2000, 512 + 12)
  assert.throws(() => peImports(outside), /outside/)
  assert.throws(() => peImports(pe().subarray(0, 500)), /Malformed/)
})

test('capture manifests bind source recipe patch executable license and actual system dependencies', () => {
  const bundle = mkdtempSync(join(tmpdir(), 'videorc-capture-manifest-'))
  const hash = (value) => createHash('sha256').update(value).digest('hex')
  const patch = 'maintained exact patch'
  const expected = {
    version: '8.1.2',
    sourceSha256: 'source-hash',
    protocol: 1,
    configureFlags: CAPTURE_FLAGS,
    patchSha256: hash(patch),
    recipeSha256: 'recipe-hash'
  }
  const manifest = { ...expected, executableSha256: hash(pe()) }
  try {
    mkdirSync(join(bundle, 'bin'))
    mkdirSync(join(bundle, 'capture/source-patches'), { recursive: true })
    writeFileSync(join(bundle, 'bin/ffmpeg-capture.exe'), pe())
    writeFileSync(join(bundle, 'capture/MANIFEST.json'), JSON.stringify(manifest))
    writeFileSync(join(bundle, 'capture/source-patches/dshow-capture-clock.patch'), patch)
    writeFileSync(join(bundle, 'capture/LICENSE.txt'), 'GNU LESSER GENERAL PUBLIC LICENSE')
    writeFileSync(join(bundle, 'capture/TOOLCHAIN.txt'), 'GCC and make versions')
    assert.deepEqual(verifyWindowsCaptureManifest(bundle, expected).dependencies, ['kernel32.dll'])
    for (const key of [
      'version',
      'sourceSha256',
      'protocol',
      'configureFlags',
      'patchSha256',
      'recipeSha256',
      'executableSha256'
    ]) {
      writeFileSync(
        join(bundle, 'capture/MANIFEST.json'),
        JSON.stringify({ ...manifest, [key]: 'wrong' })
      )
      assert.throws(() => verifyWindowsCaptureManifest(bundle, expected), /match/)
    }
    writeFileSync(join(bundle, 'capture/MANIFEST.json'), JSON.stringify(manifest))
    writeFileSync(join(bundle, 'capture/source-patches/dshow-capture-clock.patch'), 'wrong patch')
    assert.throws(() => verifyWindowsCaptureManifest(bundle, expected), /patch/)
    rmSync(join(bundle, 'capture/MANIFEST.json'))
    assert.throws(() => verifyWindowsCaptureManifest(bundle, expected), /ENOENT/)
  } finally {
    rmSync(bundle, { recursive: true, force: true })
  }
})

test('build wrapper carries current Node into MSYS2 without installing machine tooling', () => {
  const wrapper = readFileSync(
    new URL('../build-ffmpeg-capture-windows.mjs', import.meta.url),
    'utf8'
  )
  const recipe = readFileSync(
    new URL('../build-ffmpeg-capture-windows.sh', import.meta.url),
    'utf8'
  )
  assert.match(wrapper, /VIDEORC_NODE_EXECUTABLE: process\.execPath/)
  assert.match(recipe, /NODE_EXE="\$\(cygpath -u/)
  assert.doesNotMatch(wrapper, /pacman|winget|choco/)
})
