import { mkdirSync, writeFileSync } from 'node:fs'
// Capture every workspace page as a PNG for visual review (UI rewrite W2 tooling).
//   node scripts/capture-ui-pages.mjs [--theme=light|dark]
// With --theme, the app switches theme first and every file name ends in the
// theme, so a light run never overwrites a dark one (plan 168 S-02).
//
// The page sweep (plan 213 C1, `pnpm capture:ui-sweep`):
//   node scripts/capture-ui-pages.mjs --sweep [--gate] [--out=DIR]
// shoots every page and every page tab at 960×660 (the main window's
// minimum), 1100×720 and 1280×800, light and dark, in one launch, and runs
// the layout check (scripts/lib/ui-layout-check.mjs) on each shot. File names
// end in `-{width}x{height}-{theme}`, and report.json beside them lists every
// finding. --gate exits 1 when a shot has a breaking finding. --sizes= and
// --themes= narrow the sweep; --check adds the layout check to any run. The
// size is set inside this run only: the app's own window size, minimum and
// placement are untouched.
import { launchDevApp, stopProcess } from './lib/app-launcher.mjs'
import {
  UI_SWEEP_SIZES,
  breakingFindings,
  layoutCheckSource,
  parseSizes
} from './lib/ui-layout-check.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const flag = (name) => process.argv.includes(`--${name}`)
const sweep = flag('sweep')
const themeArg = arg('theme')
const themes = (arg('themes') ?? (sweep ? 'light,dark' : themeArg ?? '')).split(',').filter(Boolean)
for (const theme of themes) {
  if (theme !== 'light' && theme !== 'dark') {
    console.error(`A theme is light or dark, got ${theme}`)
    process.exit(2)
  }
}
const sizesArg = arg('sizes')
const sizes = sizesArg ? parseSizes(sizesArg) : sweep ? UI_SWEEP_SIZES : [{ width: 1280, height: 860 }]
// One size keeps the old names (`studio-dark`); several add the size.
const sizeTag = sweep || sizes.length > 1 || sizesArg
const check = sweep || flag('check')
const gate = flag('gate')
const out = arg('out') ?? join(tmpdir(), sweep ? 'videorc-ui-sweep' : 'videorc-ui-shots')
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
const setTheme = async (theme) => {
  // next-themes follows its storage key; the event is what another window
  // would send, so the theme applies without a reload.
  const applied = await cmd('eval-js', {
    code: `localStorage.setItem('videorc.theme', '${theme}'); window.dispatchEvent(new StorageEvent('storage', { key: 'videorc.theme', newValue: '${theme}' })); await sleep(700); return document.documentElement.classList.contains('${theme}')`
  }).then(r => r.result === true, () => false)
  if (!applied) {
    await stopProcess(launched.process)
    console.error(`Could not switch the app to the ${theme} theme.`)
    process.exit(1)
  }
}
// Pages by tab id. The Buddy tab (id `ai`, ⌘9; plan 119) doubles as a probe:
// it must render the Buddy Live switch (its Live tab, the first-run default;
// plan 150), or the run fails at the end. The profile under the output folder
// outlives a run and the tab reopens on the sub-tab used last, so the probe
// selects Live itself.
const pages = [
  { tab: 'studio' },
  { tab: 'ai', name: 'buddy', subTab: 'live', mustShow: '[data-slot="buddy-live-status"]' },
  { tab: 'sources' },
  { tab: 'layout' },
  { tab: 'assets' },
  { tab: 'streaming' },
  { tab: 'captions' },
  { tab: 'recording' },
  { tab: 'library' },
  { tab: 'settings' },
  { tab: 'diagnostics', name: 'health' }
]
const failures = []
const report = []
const shoot = async (name, tag, size, theme) => {
  const shot = await cmd('capture-page', { name: `${name}${tag}` })
  if (!check) {
    console.log(shot.file)
    return
  }
  const { result } = await cmd('eval-js', { code: layoutCheckSource })
  const breaking = breakingFindings(result.findings)
  report.push({ page: name, ...size, theme: theme ?? null, file: shot.file, findings: result.findings })
  console.log(`${breaking.length === 0 ? 'ok  ' : 'BAD '} ${shot.file}${breaking.length ? ` (${breaking.length}: ${[...new Set(breaking.map((f) => f.kind))].join(', ')})` : ''}`)
}
// A page with a PageTabs strip (Settings, plan 064; Buddy, plan 150;
// Livestream, plan 174): shoot each of its tabs. Triggers are found by the
// page's data attribute when it has one, else by the strip's tab role.
const stripTabs = async (selector) => cmd('eval-js', {
  code: `return [...document.querySelectorAll(${JSON.stringify(selector)})].map((el, index) => ({ index, id: el.getAttribute('data-videorc-settings-tab') ?? el.getAttribute('data-videorc-buddy-tab') ?? el.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') }))`
}).then(r => r.result ?? [], () => [])
const shootStripTabs = async (name, selector, tag, size, theme) => {
  const tabs = await stripTabs(selector)
  for (const { index, id } of tabs) {
    try {
      await cmd('eval-js', {
        code: `const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); el.click(); await sleep(600); return true`
      })
      await shoot(`${name}-${id}`, tag, size, theme)
    } catch (e) { console.log(`SKIP ${name}-${id}: ${e.message}`) }
  }
  return tabs
}
const shootAll = async (tag, size, theme) => {
  for (const { tab, name = tab, subTab, mustShow } of pages) {
    try {
      if (subTab) {
        // The Buddy tab is a lazy chunk: its first open in the dev app can take
        // longer than open-tab's 8 s wait on a busy machine.
        await cmd('open-tab', { tab })
        const trigger = `[data-videorc-buddy-tab="${subTab}"]`
        await cmd('eval-js', {
          code: `(await waitFor(${JSON.stringify(trigger)}, 30000)).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); await waitFor(${JSON.stringify(mustShow)}, 30000); return true`
        })
      } else {
        await cmd('open-tab', mustShow ? { tab, waitFor: mustShow } : { tab })
      }
      await new Promise(r => setTimeout(r, 900))
      await shoot(name, tag, size, theme)
    } catch (e) {
      console.log(`SKIP ${name}: ${e.message}`)
      if (mustShow) failures.push(`${name}: ${e.message}`)
      continue
    }
    if (name === 'settings') {
      await shootStripTabs(name, '[data-videorc-settings-tab]', tag, size, theme)
    } else if (name === 'buddy') {
      const buddyTabs = await shootStripTabs(name, '[data-videorc-buddy-tab]', tag, size, theme)
      if (buddyTabs.length !== 5) failures.push(`buddy tabs: expected 5, found ${buddyTabs.length}`)
    } else if (name === 'streaming') {
      await shootStripTabs('livestream', 'main [data-slot="pane-strip"] [role="tab"]', tag, size, theme)
    }
  }
}
for (const theme of themes.length > 0 ? themes : [null]) {
  if (theme) await setTheme(theme)
  for (const size of sizes) {
    await cmd('resize-window', size)
    await new Promise(r => setTimeout(r, sizeTag ? 1200 : 2500))
    const tag = `${sizeTag ? `-${size.width}x${size.height}` : ''}${theme ? `-${theme}` : ''}`
    await shootAll(tag, size, theme)
  }
}
await stopProcess(launched.process)
if (check) {
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const bad = report.filter((shot) => breakingFindings(shot.findings).length > 0)
  console.log(`\n${report.length} shots, ${bad.length} with a breaking finding. Report: ${join(out, 'report.json')}`)
  for (const shot of bad) {
    console.log(`\n${shot.page} at ${shot.width}×${shot.height} ${shot.theme ?? ''}`)
    for (const finding of breakingFindings(shot.findings)) {
      const { kind, what, ...rest } = finding
      console.log(`  ${kind}: ${what} ${JSON.stringify(rest)}`)
    }
  }
  if (gate && bad.length > 0) failures.push(`${bad.length} shots break the layout check`)
}
if (failures.length > 0) {
  console.error(`The capture failed:\n${failures.join('\n')}`)
  process.exit(1)
}
process.exit(0)
