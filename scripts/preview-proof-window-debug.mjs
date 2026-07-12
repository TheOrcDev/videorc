#!/usr/bin/env node
// One-shot diagnostic: create the preview surface and dump the proof window state.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

import { launchDevApp, stopProcess } from './lib/app-launcher.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const timeoutMs = 180000
const outputDirectory = join(tmpdir(), `videorc-proof-debug-${Date.now()}`)
mkdirSync(outputDirectory, { recursive: true })

let launched
try {
  launched = await launchDevApp({
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    env: {
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_NATIVE_PREVIEW_SURFACE: '1',
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_NATIVE_PREVIEW_SUSPENDED: '1'
    },
    onLine: () => {}
  })
  const ws = await connectBackend(launched.connections['backend-ready'], timeoutMs)
  const smoke = launched.connections['preview-motion-ready']
  const smokeCommand = async (command, params = {}) => {
    const response = await fetch(`http://${smoke.host}:${smoke.port}/command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${smoke.capability}`
      },
      body: JSON.stringify({ command, params })
    })
    const payload = await response.json()
    if (!response.ok || !payload.ok) throw new Error(payload?.error ?? `${command} failed`)
    return payload.result
  }

  const bounds = {
    screenX: 211, screenY: 173, width: 642, height: 414, scaleFactor: 2, screenHeight: 982,
    clipX: 211, clipY: 173, clipWidth: 642, clipHeight: 414, visible: true
  }
  await request(ws, timeoutMs, 'preview.surface.create', { bounds, targetFps: 60, source: 'synthetic' })
  const commands = await request(ws, timeoutMs, 'preview.surface.take_native_host_commands')
  console.log('host commands:', JSON.stringify(commands))
  const applied = await smokeCommand('apply-native-preview-host-commands', { commands })
  console.log('apply status transport:', applied?.transport, 'state:', applied?.state)

  // Wait for native presents to pump, then dump the FULL window list.
  let state = null
  for (let i = 0; i < 25; i += 1) {
    state = await smokeCommand('proof-window-state')
    if (state.nativePresentConfirmedAtMs > 0) break
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  console.log('proof-window-state:', JSON.stringify(state, null, 2))

  const { spawnSync } = await import('node:child_process')
  const { writeFileSync } = await import('node:fs')
  const swift = `
import CoreGraphics
import Foundation
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in list {
  let pid = w[kCGWindowOwnerPID as String] as? Int ?? 0
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  let layer = w[kCGWindowLayer as String] as? Int ?? 0
  let alpha = w[kCGWindowAlpha as String] as? Double ?? -1
  let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
  print("pid=\\(pid) owner=\\(owner) layer=\\(layer) alpha=\\(alpha) rect=\\(b["X"] ?? -1),\\(b["Y"] ?? -1),\\(b["Width"] ?? -1),\\(b["Height"] ?? -1)")
}
`
  const file = join(outputDirectory, 'all-windows.swift')
  writeFileSync(file, swift)
  const result = spawnSync('swift', [file], { encoding: 'utf8', timeout: 60000 })
  console.log('=== FULL WINDOW LIST ===')
  console.log(result.stdout)
  console.log(result.stderr?.slice(0, 300) ?? '')
  // Which helper processes are alive?
  const ps = spawnSync('pgrep', ['-fl', 'native_preview_host_helper'], { encoding: 'utf8' })
  console.log('helper processes:', ps.stdout || '(none)')
  ws.close()
} catch (error) {
  console.error('debug failed:', error?.message ?? error)
} finally {
  if (launched) await stopProcess(launched.process)
}
