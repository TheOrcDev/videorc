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
// Pages by tab id. The Orcle tab (id `ai`, ⌘9; plan 119) doubles as a probe:
// it must render the Orcle Live switch (its Live tab, the first-run default;
// plan 150), or the run fails at the end.
const pages = [
  { tab: 'studio' },
  { tab: 'ai', name: 'orcle', mustShow: '#orcle-live-switch' },
  { tab: 'sources' },
  { tab: 'layout' },
  { tab: 'streaming' },
  { tab: 'recording' },
  { tab: 'library' },
  { tab: 'settings' }
]
const failures = []
for (const { tab, name = tab, mustShow } of pages) {
  try {
    await cmd('open-tab', mustShow ? { tab, waitFor: mustShow } : { tab })
    await new Promise(r => setTimeout(r, 900))
    const shot = await cmd('capture-page', { name })
    console.log(shot.file)
  } catch (e) {
    console.log(`SKIP ${name}: ${e.message}`)
    if (mustShow) failures.push(`${name}: ${e.message}`)
  }
}
// Settings has tabs (plan 064): shoot each one. Radix tab triggers switch on
// mousedown, not click.
const settingsTabs = await cmd('eval-js', {
  code: `return [...document.querySelectorAll('[data-videorc-settings-tab]')].map((el) => el.getAttribute('data-videorc-settings-tab'))`
}).then(r => r.result ?? [], () => [])
for (const id of settingsTabs) {
  try {
    await cmd('eval-js', {
      code: `document.querySelector('[data-videorc-settings-tab="${id}"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); await sleep(600); return true`
    })
    const shot = await cmd('capture-page', { name: `settings-${id}` })
    console.log(shot.file)
  } catch (e) { console.log(`SKIP settings-${id}: ${e.message}`) }
}
// The Orcle tab has Settings' strip too (plan 150): shoot each of its tabs.
try {
  await cmd('open-tab', { tab: 'ai', waitFor: '[data-videorc-orcle-tab]' })
  const orcleTabs = await cmd('eval-js', {
    code: `return [...document.querySelectorAll('[data-videorc-orcle-tab]')].map((el) => el.getAttribute('data-videorc-orcle-tab'))`
  }).then(r => r.result ?? [], () => [])
  if (orcleTabs.length !== 5) failures.push(`orcle tabs: expected 5, found ${orcleTabs.length}`)
  for (const id of orcleTabs) {
    try {
      await cmd('eval-js', {
        code: `document.querySelector('[data-videorc-orcle-tab="${id}"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); await sleep(600); return true`
      })
      const shot = await cmd('capture-page', { name: `orcle-${id}` })
      console.log(shot.file)
    } catch (e) { console.log(`SKIP orcle-${id}: ${e.message}`) }
  }
} catch (e) {
  failures.push(`orcle tabs: ${e.message}`)
}
await stopProcess(launched.process)
if (failures.length > 0) {
  console.error(`Required pages did not render:\n${failures.join('\n')}`)
  process.exit(1)
}
process.exit(0)
