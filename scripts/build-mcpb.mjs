#!/usr/bin/env node
// Plan 209 S22: build `videorc.mcpb`, the Claude Desktop extension, for this
// platform: the MCPB manifest and the `videorc-mcp` bridge in one zip.
//
//   pnpm build:mcpb [--bridge <path>] [--out <file>] [--icon <png>]
//
// `--bridge` defaults to `target/release/videorc-mcp` (`.exe` on Windows).
// A release must pass the signed, notarized bridge from the packaged app
// (`Videorc.app/Contents/Resources/videorc-mcp`), never the cargo build.
// `--out` defaults to `target/mcpb/videorc.mcpb`.
//
// Not part of the release pipeline yet; plan 209's As built (S22) lists what
// shipping it needs.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { buildMcpbManifest, createZip, mcpbBridgeFile, mcpbEntries } from './lib/mcpb.mjs'

const root = resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  options: {
    bridge: { type: 'string' },
    out: { type: 'string' },
    icon: { type: 'string' }
  }
})

const platform = process.platform
const bridgePath = resolve(
  values.bridge ?? resolve(root, 'target', 'release', mcpbBridgeFile(platform))
)
const outPath = resolve(values.out ?? resolve(root, 'target', 'mcpb', 'videorc.mcpb'))

const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'))
const { version } = readJson('apps/desktop/package.json')
const manifest = buildMcpbManifest({
  version,
  platform,
  catalog: readJson('protocol-fixtures/agent-tools.json'),
  prompts: readJson('protocol-fixtures/agent-prompts.json'),
  icon: Boolean(values.icon)
})

let bridge
try {
  bridge = readFileSync(bridgePath)
} catch {
  console.error(
    `No bridge at ${bridgePath}. Build it first (cargo build --release -p videorc-backend --bin videorc-mcp), or pass --bridge.`
  )
  process.exit(1)
}
const icon = values.icon ? readFileSync(resolve(values.icon)) : null

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, createZip(mcpbEntries({ manifest, bridge, icon })))
console.log(
  `Built ${outPath}: Videorc ${version} for ${platform}, ${manifest.tools.length} tools, ${manifest.prompts.length} prompts, bridge ${bridge.length} bytes.`
)
