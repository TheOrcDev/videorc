import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

import { FuseV1Options } from '@electron/fuses'
import { load as loadYaml } from 'js-yaml'

import {
  BUILD_FLAGS_ASAR_PATH,
  FUSE_STATE,
  REQUIRED_FUSES,
  buildFlagsProblems,
  builderFuseConfigProblems,
  describeFuseWire,
  fuseWireProblems,
  readAsarEntry,
  resourcesDirForApp
} from './packaged-app-hardening.mjs'

const repoRoot = resolve(import.meta.dirname, '..', '..')

// Electron 39's untouched wire: every fuse at its default.
function defaultWire() {
  return {
    [FuseV1Options.RunAsNode]: FUSE_STATE.ENABLE,
    [FuseV1Options.EnableCookieEncryption]: FUSE_STATE.DISABLE,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FUSE_STATE.ENABLE,
    [FuseV1Options.EnableNodeCliInspectArguments]: FUSE_STATE.ENABLE,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FUSE_STATE.DISABLE,
    [FuseV1Options.OnlyLoadAppFromAsar]: FUSE_STATE.DISABLE,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: FUSE_STATE.DISABLE,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: FUSE_STATE.ENABLE
  }
}

function hardenedWire() {
  return {
    ...defaultWire(),
    [FuseV1Options.RunAsNode]: FUSE_STATE.DISABLE,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FUSE_STATE.DISABLE,
    [FuseV1Options.EnableNodeCliInspectArguments]: FUSE_STATE.DISABLE,
    [FuseV1Options.OnlyLoadAppFromAsar]: FUSE_STATE.ENABLE
  }
}

/** A minimal asar archive in the real on-disk layout. */
function asarArchive(files) {
  const bodies = []
  let offset = 0
  const tree = { files: {} }
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split('/')
    let node = tree
    for (const dir of parts.slice(0, -1)) {
      node.files[dir] ??= { files: {} }
      node = node.files[dir]
    }
    const body = Buffer.from(text)
    node.files[parts.at(-1)] = { size: body.length, offset: String(offset) }
    bodies.push(body)
    offset += body.length
  }
  const json = Buffer.from(JSON.stringify(tree))
  const padded = Math.ceil(json.length / 4) * 4
  const headerPickle = Buffer.alloc(8 + padded)
  headerPickle.writeUInt32LE(4 + padded, 0)
  headerPickle.writeUInt32LE(json.length, 4)
  json.copy(headerPickle, 8)
  const sizePickle = Buffer.alloc(8)
  sizePickle.writeUInt32LE(4, 0)
  sizePickle.writeUInt32LE(headerPickle.length, 4)
  return Buffer.concat([sizePickle, headerPickle, ...bodies])
}

describe('packaged app fuses', () => {
  it('fails every fuse Electron leaves open by default', () => {
    assert.deepEqual(fuseWireProblems(defaultWire(), FuseV1Options), [
      'RunAsNode is enabled, expected disabled',
      'EnableNodeOptionsEnvironmentVariable is enabled, expected disabled',
      'EnableNodeCliInspectArguments is enabled, expected disabled',
      'OnlyLoadAppFromAsar is disabled, expected enabled'
    ])
  })

  it('passes the hardened wire and reports a fuse the binary does not carry', () => {
    assert.deepEqual(fuseWireProblems(hardenedWire(), FuseV1Options), [])
    const short = hardenedWire()
    delete short[FuseV1Options.OnlyLoadAppFromAsar]
    assert.deepEqual(fuseWireProblems(short, FuseV1Options), [
      'OnlyLoadAppFromAsar is missing, expected enabled'
    ])
    assert.equal(describeFuseWire(hardenedWire(), FuseV1Options).RunAsNode, 'disabled')
  })

  it('electron-builder.yml flips exactly the fuses the gate requires', () => {
    const config = loadYaml(
      readFileSync(join(repoRoot, 'apps/desktop/electron-builder.yml'), 'utf8')
    )
    assert.deepEqual(builderFuseConfigProblems(config.electronFuses), [])
    assert.equal(Object.keys(REQUIRED_FUSES).length, Object.keys(config.electronFuses).length)
    assert.deepEqual(builderFuseConfigProblems({ runAsNode: true }).length, 4)
  })

  it('both Windows configs inherit the fuses instead of overriding them', () => {
    for (const name of [
      'electron-builder.windows-signed.cjs',
      'electron-builder.windows-unsigned.cjs'
    ]) {
      const source = readFileSync(join(repoRoot, 'apps/desktop', name), 'utf8')
      assert.match(source, /extends: '\.\/electron-builder\.yml'/)
      assert.doesNotMatch(source, /electronFuses|disableFuses/)
    }
  })
})

describe('packaged build flags', () => {
  it('refuses a test build unless the caller asked for one', () => {
    assert.deepEqual(buildFlagsProblems({ packagedTestHooks: false }), [])
    assert.equal(buildFlagsProblems({ packagedTestHooks: true }).length, 1)
    assert.deepEqual(buildFlagsProblems({ packagedTestHooks: true }, { allowTestHooks: true }), [])
    assert.match(buildFlagsProblems(null)[0], /missing or malformed/)
    assert.match(buildFlagsProblems({ packagedTestHooks: 'no' })[0], /missing or malformed/)
  })

  it('reads the flags file out of an asar archive', () => {
    const archive = asarArchive({
      'package.json': '{"name":"videorc"}',
      [BUILD_FLAGS_ASAR_PATH]: '{"packagedTestHooks":false}\n'
    })
    assert.deepEqual(JSON.parse(readAsarEntry(archive, BUILD_FLAGS_ASAR_PATH).toString()), {
      packagedTestHooks: false
    })
    assert.equal(readAsarEntry(archive, 'package.json').toString(), '{"name":"videorc"}')
    assert.equal(readAsarEntry(archive, 'out/main/absent.json'), null)
    assert.equal(readAsarEntry(archive, 'out/main'), null)
    assert.throws(() => readAsarEntry(Buffer.from('not an archive at all'), 'x'), /Not an asar/)
  })

  it('finds resources beside each platform layout', () => {
    assert.equal(
      resourcesDirForApp('/r/Videorc.app', 'darwin'),
      resolve('/r/Videorc.app/Contents/Resources')
    )
    assert.equal(
      resourcesDirForApp('/r/Videorc.app/Contents/MacOS/Videorc', 'darwin'),
      resolve('/r/Videorc.app/Contents/Resources')
    )
    assert.equal(
      resourcesDirForApp('/r/linux-unpacked/videorc', 'linux'),
      resolve('/r/linux-unpacked/resources')
    )
    assert.equal(
      resourcesDirForApp('/r/win-unpacked/Videorc.exe', 'win32'),
      resolve('/r/win-unpacked/resources')
    )
  })
})
