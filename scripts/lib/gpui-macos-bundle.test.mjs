import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BUNDLE_ID,
  URL_SCHEME,
  USAGE_DESCRIPTIONS,
  bundleCopies,
  infoPlistValues,
  isBundleVersion,
  matchesFilter,
  plistXml
} from './gpui-macos-bundle.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('the bundle keeps Electron bundle id and permission words', () => {
  const values = infoPlistValues({ version: '0.38.0', year: 2026 })
  assert.equal(values.CFBundleIdentifier, BUNDLE_ID)
  assert.equal(values.CFBundleIdentifier, 'dev.theorcdev.videorc')
  assert.equal(values.CFBundleShortVersionString, '0.38.0')
  assert.equal(values.CFBundleExecutable, 'Videorc')
  // Electron's mac.extendInfo, word for word.
  const builder = fs.readFileSync(path.join(root, 'apps/desktop/electron-builder.yml'), 'utf8')
  for (const key of [
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription',
    'NSScreenCaptureDescription',
    'NSDocumentsFolderUsageDescription',
    'NSDownloadsFolderUsageDescription'
  ]) {
    assert.ok(builder.includes(`${key}: ${USAGE_DESCRIPTIONS[key]}`), key)
    assert.equal(values[key], USAGE_DESCRIPTIONS[key])
  }
  assert.equal(values.NSCameraUseContinuityCameraDeviceType, true)
  // None of Electron's own keys.
  for (const key of ['ElectronAsarIntegrity', 'NSMainNibFile', 'LSEnvironment']) {
    assert.equal(key in values, false, key)
  }
  assert.equal(values.NSPrincipalClass, 'NSApplication')
})

test('the bundle declares the sign-in callback scheme Electron registers', () => {
  const values = infoPlistValues({ version: '0.38.0' })
  const main = fs.readFileSync(path.join(root, 'apps/desktop/src/main/index.ts'), 'utf8')
  const electronScheme = main.match(/const OAUTH_CALLBACK_PROTOCOL = '([^']+)'/)?.[1]
  assert.equal(electronScheme, URL_SCHEME)
  assert.deepEqual(values.CFBundleURLTypes, [
    { CFBundleURLName: 'dev.theorcdev.videorc', CFBundleURLSchemes: ['videorc'] }
  ])
  const xml = plistXml({ CFBundleURLTypes: values.CFBundleURLTypes })
  assert.ok(
    xml.includes(
      [
        '  <array>',
        '    <dict>',
        '      <key>CFBundleURLName</key>',
        '      <string>dev.theorcdev.videorc</string>',
        '      <key>CFBundleURLSchemes</key>',
        '      <array>',
        '        <string>videorc</string>',
        '      </array>',
        '    </dict>',
        '  </array>'
      ].join('\n')
    ),
    xml
  )
})

test('only release versions go into the bundle', () => {
  assert.ok(isBundleVersion('0.38.0'))
  assert.ok(isBundleVersion('0.38.0-beta.1'))
  for (const bad of ['0.38', 'v0.38.0', '', undefined, '0.38.0 ']) {
    assert.equal(isBundleVersion(bad), false, String(bad))
  }
  assert.throws(() => infoPlistValues({ version: '0.38' }))
})

test('the property list is well formed and escaped', () => {
  const xml = plistXml({ B: 'a & <b>', A: true, C: false })
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'))
  assert.ok(xml.indexOf('<key>A</key>') < xml.indexOf('<key>B</key>'))
  assert.ok(xml.includes('<string>a &amp; &lt;b&gt;</string>'))
  assert.ok(xml.includes('<true/>') && xml.includes('<false/>'))
  assert.throws(() => plistXml({ D: 1 }))
})

test('filters match as electron-builder takes these patterns', () => {
  assert.ok(matchesFilter('focus.webp', ['*.webp']))
  assert.equal(matchesFilter('live-thumbs/live-silk.webp', ['*.webp']), false)
  assert.ok(matchesFilter('pets/orc/atlas.png', ['**']))
  assert.equal(matchesFilter('pets/.gitkeep', ['**'], ['.gitkeep']), false)
  assert.equal(matchesFilter('README.md', ['**'], ['README.md']), false)
  assert.ok(matchesFilter('bin/ffmpeg', ['bin/ffmpeg']))
  assert.equal(matchesFilter('bin/ffplay', ['bin/ffmpeg', 'bin/ffprobe']), false)
  assert.ok(matchesFilter('licenses/x/LICENSE', ['licenses/**']))
})

test('the layout is where the app looks', () => {
  const binaries = path.resolve('/build')
  const copies = bundleCopies({
    root: '/repo',
    binaries,
    bridge: path.join(binaries, 'videorc-mcp'),
    ffmpeg: '/repo/vendor/ffmpeg/current'
  })
  const to = Object.fromEntries(copies.map((copy) => [copy.to, copy]))
  // main.rs: the backend beside the app; the bridge beside the backend.
  assert.equal(to['MacOS/Videorc'].from, path.join(binaries, 'Videorc'))
  assert.equal(to['MacOS/videorc-backend'].from, path.join(binaries, 'videorc-backend'))
  assert.equal(to['MacOS/videorc-mcp'].required, false)
  // bundled.rs: electron-builder's names under Resources.
  for (const folder of [
    'Resources/background-assets/bundled',
    'Resources/buddy-assets/bundled',
    'Resources/sounds/starter'
  ]) {
    assert.ok(to[folder]?.required, folder)
  }
  assert.equal(to['Resources/ffmpeg'].required, false)
  // Every required source exists in this checkout.
  for (const copy of bundleCopies({
    root,
    binaries,
    bridge: path.join(binaries, 'videorc-mcp'),
    ffmpeg: '/nowhere'
  })) {
    if (copy.required && path.dirname(copy.from) !== binaries) {
      assert.ok(fs.existsSync(copy.from), copy.from)
    }
  }
})

test('the bundled names match the app core', () => {
  const bundled = fs.readFileSync(path.join(root, 'crates/videorc-app-core/src/bundled.rs'), 'utf8')
  const tos = bundleCopies({ root, binaries: '/b', bridge: '/b/m', ffmpeg: '/f' }).map(
    (copy) => copy.to
  )
  for (const constant of [
    'BACKGROUNDS_IN_RESOURCES',
    'BUDDY_IN_RESOURCES',
    'STARTER_SOUNDS_IN_RESOURCES',
    'FFMPEG_IN_RESOURCES'
  ]) {
    const match = bundled.match(new RegExp(`${constant}: &str = "([^"]+)"`))
    assert.ok(match, constant)
    const folder = match[1].split('/bin/')[0]
    assert.ok(tos.includes(`Resources/${folder}`), `${constant} (${match[1]}) is not in the bundle`)
  }
})
