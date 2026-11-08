// Plan 209 S22: the Claude Desktop extension (`videorc.mcpb`).
//
// An MCPB bundle is a zip with `manifest.json` at its root and the server
// beside it (https://github.com/modelcontextprotocol/mcpb, MANIFEST.md).
// Videorc's server is the `videorc-mcp` bridge binary (S4), so the manifest
// uses the `binary` server type, and the agent token the streamer pastes is
// a sensitive `user_config` string that Claude Desktop keeps in the OS
// keychain and passes as VIDEORC_AGENT_TOKEN.
//
// Pure helpers only: `scripts/build-mcpb.mjs` reads the files and writes the
// bundle. The zip writer is a small store/deflate writer (no zip64: the
// bridge is a few megabytes) so the build needs no dependency.

import { deflateRawSync } from 'node:zlib'

/** MCPB manifest spec 0.3 (2025-12-02), the newest without the `uv` type. */
export const MCPB_MANIFEST_VERSION = '0.3'

/** The `user_config` key the token is stored under. */
export const MCPB_TOKEN_KEY = 'agent_token'

const PLATFORMS = new Set(['darwin', 'win32', 'linux'])

/** The bridge's file name inside the bundle for `platform`. */
export function mcpbBridgeFile(platform) {
  return platform === 'win32' ? 'videorc-mcp.exe' : 'videorc-mcp'
}

/**
 * The manifest for one platform's bundle: the app's version, the catalog's
 * server name and title, every tool and prompt by name and description, and
 * the token as a sensitive setting.
 */
export function buildMcpbManifest({ version, platform, catalog, prompts, icon = false }) {
  if (!PLATFORMS.has(platform)) throw new Error(`MCPB has no platform called ${platform}.`)
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
    throw new Error(`The version must be semver: ${version}`)
  }
  const bridge = `server/${mcpbBridgeFile(platform)}`
  return {
    manifest_version: MCPB_MANIFEST_VERSION,
    name: catalog.serverName,
    display_name: catalog.serverTitle,
    version,
    description:
      'Let Claude run Videorc on this computer: scenes, sounds, recording, going live, chat and your Library.',
    long_description: [
      'Videorc MCP connects Claude Desktop to Videorc, the recording and livestreaming app, on this computer.',
      'Ask "What\'s on my stream right now?" or "Switch to the camera scene and play the airhorn", and Claude runs it in Videorc.',
      '',
      'Before you install: in Videorc, open Settings → Remote → Agents, turn on "Let AI agents control Videorc", press Connect an agent… and choose Claude Desktop. Paste the agent token from the line it shows when Claude Desktop asks for it.',
      '',
      "Videorc listens on this computer only (127.0.0.1). Every action shows in Videorc's Activity list, and Stop in the Studio cuts every agent at once. Chat text comes back marked as written by viewers, and Claude is told never to follow it."
    ].join('\n'),
    author: { name: 'Videorc', url: 'https://videorc.com' },
    homepage: 'https://videorc.com',
    documentation: 'https://videorc.com/agents',
    support: 'https://github.com/TheOrcDev/videorc/issues',
    repository: { type: 'git', url: 'https://github.com/TheOrcDev/videorc' },
    ...(icon ? { icon: 'icon.png' } : {}),
    server: {
      type: 'binary',
      entry_point: bridge,
      mcp_config: {
        command: `\${__dirname}/${bridge}`,
        args: [],
        env: { VIDEORC_AGENT_TOKEN: `\${user_config.${MCPB_TOKEN_KEY}}` }
      }
    },
    tools: catalog.tools.map((tool) => ({ name: tool.name, description: tool.description })),
    tools_generated: false,
    prompts: prompts.prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      text: prompt.text
    })),
    prompts_generated: false,
    keywords: ['videorc', 'streaming', 'livestream', 'recording', 'obs', 'youtube', 'twitch'],
    license: 'AGPL-3.0-only',
    compatibility: { platforms: [platform] },
    user_config: {
      [MCPB_TOKEN_KEY]: {
        type: 'string',
        title: 'Agent token',
        description:
          'In Videorc, open Settings → Remote → Agents, press Connect an agent… and choose Claude Desktop. Paste the token from the line it shows (it starts with vrc_agent_).',
        sensitive: true,
        required: true
      }
    }
  }
}

// ---------------------------------------------------------------------------
// A minimal zip writer
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** DOS date and time for `date` (local fields, as zip tools read them). */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  }
}

/**
 * A zip of `entries` (`{ name, data, mode }`, `mode` the Unix permission
 * bits, 0o644 by default). Deflated unless that would grow the entry. The
 * "made by Unix" header keeps the mode, so the bridge stays executable when
 * Claude Desktop unpacks it. A fixed `modified` makes the bundle
 * reproducible.
 */
export function createZip(entries, { modified = new Date(2026, 0, 1) } = {}) {
  const { time, date } = dosDateTime(modified)
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.data)
    const deflated = deflateRawSync(data, { level: 9 })
    const stored = deflated.length >= data.length
    const body = stored ? data : deflated
    const crc = crc32(data)
    const mode = (entry.mode ?? 0o644) & 0o7777
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed: 2.0
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // made by Unix, 2.0
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(stored ? 0 : 8, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attributes
    central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38) // a regular file, its mode
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + body.length
  }
  const centralSize = centrals.reduce((size, part) => size + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, ...centrals, end])
}

/** The bundle's files: the manifest, the bridge (executable) and the icon. */
export function mcpbEntries({ manifest, bridge, icon }) {
  const entries = [
    { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    { name: manifest.server.entry_point, data: bridge, mode: 0o755 }
  ]
  if (icon) entries.push({ name: 'icon.png', data: icon })
  return entries
}
