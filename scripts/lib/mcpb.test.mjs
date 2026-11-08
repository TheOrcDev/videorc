import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { inflateRawSync } from 'node:zlib'

import {
  MCPB_MANIFEST_VERSION,
  buildMcpbManifest,
  crc32,
  createZip,
  mcpbBridgeFile,
  mcpbEntries
} from './mcpb.mjs'

// Plan 209 S22: the Claude Desktop extension's manifest and zip.

const root = resolve(import.meta.dirname, '..', '..')
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'))
const catalog = readJson('protocol-fixtures/agent-tools.json')
const prompts = readJson('protocol-fixtures/agent-prompts.json')

const manifestFor = (platform, extra = {}) =>
  buildMcpbManifest({ version: '0.14.0', platform, catalog, prompts, ...extra })

/** Read a zip back from its central directory (what an unzip tool does). */
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(end >= 0, 'an end of central directory record')
  const count = buffer.readUInt16LE(end + 10)
  let at = buffer.readUInt32LE(end + 16)
  const files = new Map()
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50)
    const madeBy = buffer.readUInt16LE(at + 4)
    const method = buffer.readUInt16LE(at + 10)
    const crc = buffer.readUInt32LE(at + 16)
    const compressed = buffer.readUInt32LE(at + 20)
    const size = buffer.readUInt32LE(at + 24)
    const nameLength = buffer.readUInt16LE(at + 28)
    const external = buffer.readUInt32LE(at + 38)
    const localAt = buffer.readUInt32LE(at + 42)
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    const localNameLength = buffer.readUInt16LE(localAt + 26)
    const localExtra = buffer.readUInt16LE(localAt + 28)
    const start = localAt + 30 + localNameLength + localExtra
    const body = buffer.subarray(start, start + compressed)
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body)
    assert.equal(data.length, size)
    assert.equal(crc32(data), crc, `${name} crc`)
    files.set(name, { data, mode: (external >>> 16) & 0o7777, madeBy: madeBy >> 8 })
    at += 46 + nameLength
  }
  return files
}

test('the manifest is MCPB 0.3, a binary server named videorc with the app version', () => {
  const manifest = manifestFor('darwin')
  assert.equal(manifest.manifest_version, MCPB_MANIFEST_VERSION)
  assert.equal(manifest.manifest_version, '0.3')
  assert.equal(manifest.name, 'videorc')
  assert.equal(manifest.display_name, 'Videorc')
  assert.equal(manifest.version, '0.14.0')
  assert.equal(manifest.author.name, 'Videorc')
  assert.ok(manifest.description.length > 0)
  assert.deepEqual(manifest.server, {
    type: 'binary',
    entry_point: 'server/videorc-mcp',
    mcp_config: {
      command: '${__dirname}/server/videorc-mcp',
      args: [],
      env: { VIDEORC_AGENT_TOKEN: '${user_config.agent_token}' }
    }
  })
  assert.deepEqual(manifest.compatibility, { platforms: ['darwin'] })
  assert.equal('icon' in manifest, false)
  assert.equal(manifestFor('linux', { icon: true }).icon, 'icon.png')
})

test('the token is a required, sensitive string the server reads as VIDEORC_AGENT_TOKEN', () => {
  const { user_config: userConfig, server } = manifestFor('darwin')
  assert.deepEqual(Object.keys(userConfig), ['agent_token'])
  assert.equal(userConfig.agent_token.type, 'string')
  assert.equal(userConfig.agent_token.sensitive, true)
  assert.equal(userConfig.agent_token.required, true)
  assert.match(userConfig.agent_token.description, /Settings → Remote → Agents/)
  assert.equal(server.mcp_config.env.VIDEORC_AGENT_TOKEN, '${user_config.agent_token}')
  // Never a default token, and never a path on the build machine.
  assert.equal('default' in userConfig.agent_token, false)
  assert.doesNotMatch(JSON.stringify(manifestFor('darwin')), /vrc_agent_[0-9a-f]{8}|\/Users\//)
})

test('Windows bundles the .exe, and each bundle names only its own platform', () => {
  assert.equal(mcpbBridgeFile('win32'), 'videorc-mcp.exe')
  const manifest = manifestFor('win32')
  assert.equal(manifest.server.entry_point, 'server/videorc-mcp.exe')
  assert.equal(manifest.server.mcp_config.command, '${__dirname}/server/videorc-mcp.exe')
  assert.deepEqual(manifest.compatibility.platforms, ['win32'])
  assert.throws(() => manifestFor('freebsd'), /no platform/)
  assert.throws(
    () => buildMcpbManifest({ version: 'next', platform: 'darwin', catalog, prompts }),
    /semver/
  )
})

test('every catalog tool and prompt is listed, without the catalog-only fields', () => {
  const manifest = manifestFor('darwin')
  assert.deepEqual(
    manifest.tools.map((tool) => tool.name),
    catalog.tools.map((tool) => tool.name)
  )
  for (const tool of manifest.tools) assert.deepEqual(Object.keys(tool), ['name', 'description'])
  assert.equal(manifest.tools_generated, false)
  assert.deepEqual(
    manifest.prompts.map((prompt) => prompt.name),
    ['go_live_checklist', 'stream_recap']
  )
  for (const prompt of manifest.prompts) {
    assert.deepEqual(Object.keys(prompt), ['name', 'description', 'text'])
    assert.ok(prompt.text.length > 0)
  }
  assert.equal(manifest.prompts_generated, false)
})

test('the zip holds the manifest and an executable bridge, readable back', () => {
  const manifest = manifestFor('darwin')
  const bridge = Buffer.from('#!/bin/sh\necho bridge\n'.repeat(200))
  const zip = createZip(mcpbEntries({ manifest, bridge, icon: Buffer.from([0x89, 0x50, 0x4e]) }))
  const files = readZip(zip)
  assert.deepEqual([...files.keys()], ['manifest.json', 'server/videorc-mcp', 'icon.png'])
  assert.deepEqual(JSON.parse(files.get('manifest.json').data.toString('utf8')), manifest)
  assert.ok(files.get('server/videorc-mcp').data.equals(bridge))
  assert.equal(files.get('server/videorc-mcp').mode, 0o755)
  assert.equal(files.get('server/videorc-mcp').madeBy, 3, 'made by Unix, so the mode is read')
  assert.equal(files.get('manifest.json').mode, 0o644)
  // The same input gives the same bytes (a fixed timestamp).
  assert.ok(
    zip.equals(createZip(mcpbEntries({ manifest, bridge, icon: Buffer.from([0x89, 0x50, 0x4e]) })))
  )
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})

test(
  'a system unzip reads the bundle and keeps the bridge executable',
  { skip: process.platform === 'win32' || spawnSync('unzip', ['-v']).status !== 0 },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'videorc-mcpb-'))
    try {
      const bundle = join(directory, 'videorc.mcpb')
      const bridge = Buffer.from('#!/bin/sh\necho ok\n')
      writeFileSync(bundle, createZip(mcpbEntries({ manifest: manifestFor('darwin'), bridge })))
      const tested = spawnSync('unzip', ['-t', bundle], { encoding: 'utf8' })
      assert.equal(tested.status, 0, tested.stdout + tested.stderr)
      const out = join(directory, 'out')
      const extracted = spawnSync('unzip', ['-q', bundle, '-d', out], { encoding: 'utf8' })
      assert.equal(extracted.status, 0, extracted.stderr)
      assert.equal(statSync(join(out, 'server', 'videorc-mcp')).mode & 0o111, 0o111)
      assert.equal(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).name, 'videorc')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
