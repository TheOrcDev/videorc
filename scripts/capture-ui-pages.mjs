import { mkdirSync } from 'node:fs'
// Capture every workspace page as a PNG for visual review (UI rewrite W2 tooling).
//   node scripts/capture-ui-pages.mjs [--theme=light|dark]
// With --theme, the app switches theme first and every file name ends in the
// theme, so a light run never overwrites a dark one (plan 168 S-02).
import { launchDevApp, stopProcess } from './lib/app-launcher.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const themeArg = process.argv.find((arg) => arg.startsWith('--theme='))?.slice('--theme='.length)
if (themeArg !== undefined && themeArg !== 'light' && themeArg !== 'dark') {
  console.error(`--theme must be light or dark, got ${themeArg}`)
  process.exit(2)
}
const suffix = themeArg ? `-${themeArg}` : ''
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
if (themeArg) {
  // next-themes follows its storage key; the event is what another window
  // would send, so the theme applies without a reload.
  const applied = await cmd('eval-js', {
    code: `localStorage.setItem('videorc.theme', '${themeArg}'); window.dispatchEvent(new StorageEvent('storage', { key: 'videorc.theme', newValue: '${themeArg}' })); await sleep(700); return document.documentElement.classList.contains('${themeArg}')`
  }).then(r => r.result === true, () => false)
  if (!applied) {
    await stopProcess(launched.process)
    console.error(`Could not switch the app to the ${themeArg} theme.`)
    process.exit(1)
  }
}
// Pages by tab id. The Golem tab (id `ai`, ⌘9; plan 119) doubles as a probe:
// it must render the Golem Live switch (its Live tab, the first-run default;
// plan 150), or the run fails at the end. The profile under the output folder
// outlives a run and the tab reopens on the sub-tab used last, so the probe
// selects Live itself.
const pages = [
  { tab: 'studio' },
  { tab: 'ai', name: 'golem', subTab: 'live', mustShow: '[data-slot="golem-live-status"]' },
  { tab: 'sources' },
  { tab: 'layout' },
  { tab: 'streaming' },
  { tab: 'recording' },
  { tab: 'library' },
  { tab: 'settings' }
]
const failures = []
for (const { tab, name = tab, subTab, mustShow } of pages) {
  try {
    if (subTab) {
      // The Golem tab is a lazy chunk: its first open in the dev app can take
      // longer than open-tab's 8 s wait on a busy machine.
      await cmd('open-tab', { tab })
      const trigger = `[data-videorc-golem-tab="${subTab}"]`
      await cmd('eval-js', {
        code: `(await waitFor(${JSON.stringify(trigger)}, 30000)).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); await waitFor(${JSON.stringify(mustShow)}, 30000); return true`
      })
    } else {
      await cmd('open-tab', mustShow ? { tab, waitFor: mustShow } : { tab })
    }
    await new Promise(r => setTimeout(r, 900))
    const shot = await cmd('capture-page', { name: `${name}${suffix}` })
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
    const shot = await cmd('capture-page', { name: `settings-${id}${suffix}` })
    console.log(shot.file)
  } catch (e) { console.log(`SKIP settings-${id}: ${e.message}`) }
}
// The Golem tab has Settings' strip too (plan 150): shoot each of its tabs.
try {
  await cmd('open-tab', { tab: 'ai', waitFor: '[data-videorc-golem-tab]' })
  const golemTabs = await cmd('eval-js', {
    code: `return [...document.querySelectorAll('[data-videorc-golem-tab]')].map((el) => el.getAttribute('data-videorc-golem-tab'))`
  }).then(r => r.result ?? [], () => [])
  if (golemTabs.length !== 5) failures.push(`golem tabs: expected 5, found ${golemTabs.length}`)
  for (const id of golemTabs) {
    try {
      await cmd('eval-js', {
        code: `document.querySelector('[data-videorc-golem-tab="${id}"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); await sleep(600); return true`
      })
      const shot = await cmd('capture-page', { name: `golem-${id}${suffix}` })
      console.log(shot.file)
    } catch (e) { console.log(`SKIP golem-${id}: ${e.message}`) }
  }
} catch (e) {
  failures.push(`golem tabs: ${e.message}`)
}
await stopProcess(launched.process)
if (failures.length > 0) {
  console.error(`Required pages did not render:\n${failures.join('\n')}`)
  process.exit(1)
}
process.exit(0)
