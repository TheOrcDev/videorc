import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  APP_RUN,
  BACKEND,
  BRIDGE,
  DESKTOP_FILE,
  DESKTOP_ICON_FILE,
  EXECUTABLE,
  MANAGED_KEY,
  URL_MIME_TYPE,
  URL_SCHEME,
  appRunScript,
  desktopEntryText,
  isElf,
  isPackageVersion,
  matchesFilter,
  packageCopies
} from './gpui-linux-package.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('only release versions go into the package', () => {
  assert.ok(isPackageVersion('0.38.0'))
  assert.ok(isPackageVersion('0.38.0-beta.1'))
  for (const bad of ['0.38', 'v0.38.0', '', undefined, '0.38.0 ']) {
    assert.equal(isPackageVersion(bad), false, String(bad))
  }
  assert.throws(() => desktopEntryText({ version: '0.38' }))
})

test('the desktop entry matches the core and Electron mime types', () => {
  const text = desktopEntryText({ version: '0.38.0' })
  assert.ok(text.includes(`Exec=${EXECUTABLE} %U`))
  assert.ok(text.includes(`TryExec=${EXECUTABLE}`))
  assert.ok(text.includes('Icon=videorc'))
  assert.ok(text.includes(`MimeType=${URL_MIME_TYPE};`))
  assert.ok(text.includes(`${MANAGED_KEY}=true`))
  assert.ok(text.includes('X-AppImage-Version=0.38.0'))
  assert.ok(text.endsWith('\n'))

  const core = fs.readFileSync(
    path.join(root, 'crates/videorc-app-core/src/desktop/linux/desktop_entry.rs'),
    'utf8'
  )
  assert.ok(core.includes(`"${URL_MIME_TYPE}"`))
  assert.ok(core.includes(`"${MANAGED_KEY}"`))
  assert.ok(core.includes('Icon={DESKTOP_ICON_NAME}') || core.includes('Icon=videorc'))

  const builder = fs.readFileSync(path.join(root, 'apps/desktop/electron-builder.yml'), 'utf8')
  assert.ok(builder.includes('x-scheme-handler/videorc'))
  assert.equal(URL_SCHEME, 'videorc')
})

test('AppRun execs the GPUI binary beside itself', () => {
  const script = appRunScript()
  assert.ok(script.startsWith('#!/bin/sh\n'))
  assert.ok(script.includes(`exec "$HERE/${EXECUTABLE}" "$@"`))
  assert.equal(script.includes('--no-sandbox'), false)
})

test('filters match as electron-builder takes these patterns', () => {
  assert.ok(matchesFilter('focus.webp', ['*.webp']))
  assert.equal(matchesFilter('live-thumbs/live-silk.webp', ['*.webp']), false)
  assert.ok(matchesFilter('bin/ffmpeg', ['bin/ffmpeg']))
  assert.ok(matchesFilter('licenses/x/LICENSE', ['licenses/**']))
})

test('the layout is where the app looks', () => {
  const binaries = path.resolve('/build')
  const copies = packageCopies({
    root: '/repo',
    binaries,
    bridge: path.join(binaries, 'videorc-mcp'),
    ffmpeg: '/repo/vendor/ffmpeg/linux-x64'
  })
  const to = Object.fromEntries(copies.map((copy) => [copy.to, copy]))
  // main.rs: the backend beside the app; the bridge beside the backend.
  assert.equal(to[EXECUTABLE].from, path.join(binaries, EXECUTABLE))
  assert.equal(to[BACKEND].from, path.join(binaries, BACKEND))
  assert.equal(to[BRIDGE].required, false)
  // bundled.rs: electron-builder's names under resources/ beside the exe.
  for (const folder of [
    'resources/background-assets/bundled',
    'resources/buddy-assets/bundled',
    'resources/sounds/starter'
  ]) {
    assert.ok(to[folder]?.required, folder)
  }
  assert.equal(to['resources/ffmpeg'].required, false)
  assert.ok(to['resources/videorc-logo.png']?.required)
  assert.ok(to[DESKTOP_ICON_FILE]?.required)
  // Every required source exists in this checkout.
  for (const copy of packageCopies({
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
  const tos = packageCopies({ root, binaries: '/b', bridge: '/b/m', ffmpeg: '/f' }).map(
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
    assert.ok(
      tos.includes(`resources/${folder}`),
      `${constant} (${match[1]}) is not in the package`
    )
  }
})

test('desktop and AppRun names stay stable for AppImage tooling', () => {
  assert.equal(DESKTOP_FILE, 'videorc.desktop')
  assert.equal(DESKTOP_ICON_FILE, 'videorc.png')
  assert.equal(APP_RUN, 'AppRun')
})

test('isElf accepts ELF magic and refuses other headers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpui-linux-elf-'))
  try {
    const elf = path.join(dir, 'elf')
    const macho = path.join(dir, 'macho')
    fs.writeFileSync(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]))
    fs.writeFileSync(macho, Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 0]))
    assert.equal(isElf(elf), true)
    assert.equal(isElf(macho), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
