import { mkdirSync } from 'node:fs'
// Capture every workspace page as a PNG for visual review (UI rewrite W2 tooling).
//   node scripts/capture-ui-pages.mjs
import { launchDevApp, stopProcess } from './lib/app-launcher.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = join(tmpdir(), 'videorc-ui-shots')
mkdirSync(out, { recursive: true })
const launched = await launchDevApp({
  timeoutMs: 180000,
  requiredMarkers: ['backend-ready', 'preview-motion-ready'],
  env: {
    VIDEORC_SMOKE_OUTPUT_DIR: out,
    VIDEORC_SMOKE_COMMAND_SERVER: '1',
    VIDEORC_DISABLE_AUTO_PREVIEW: '1'
  },
  onLine: () => {}
})
const smoke = launched.connections['preview-motion-ready']
const cmd = async (command, params = {}) => {
  const r = await fetch(`http://${smoke.host}:${smoke.port}/command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${smoke.capability}` },
    body: JSON.stringify({ command, params })
  })
  const j = await r.json()
  if (!j.ok) throw new Error(`${command}: ${j.error}`)
  return j.result
}
await cmd('resize-window', { width: 1280, height: 860 })
await new Promise(r => setTimeout(r, 2500))
for (const tab of ['studio', 'sources', 'layout', 'streaming', 'recording', 'library', 'settings']) {
  try {
    await cmd('open-tab', { tab })
    await new Promise(r => setTimeout(r, 900))
    const shot = await cmd('capture-page', { name: tab })
    console.log(shot.file)
  } catch (e) { console.log(`SKIP ${tab}: ${e.message}`) }
}
await stopProcess(launched.process)
process.exit(0)
