import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Plan 213 A4: the compact controls take a click across at least 28 × 28 px
// through an invisible spill, and never over a neighbour. The primitives are
// synced from @videorc, so the rule lives in styles.css, keyed on the
// attributes they write; these pins keep it from drifting off them.

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const styles = read('./styles.css')
const components = styles.slice(styles.indexOf('@layer components {'))
const compact = `:is(button, a)[data-variant]:is([data-size='xs'], [data-size='icon-xs'])`

describe('the compact controls’ hit area (plan 213 A4)', () => {
  it('spills each xs and icon-xs button to 28 px, below the call site’s own classes', () => {
    expect(components.startsWith('@layer components {')).toBe(true)
    const rule = components.slice(components.indexOf(compact))
    expect(rule).toMatch(
      /^:is\(button, a\)\[data-variant\][^{]*:not\(\s*\[data-variant='link'\]\s*\)/
    )
    expect(rule).toMatch(/position: relative;\s*&::before \{\s*content: '';\s*position: absolute;/)
    expect(rule).toContain('inset: min(0px, calc((100% - 28px) / 2));')
  })

  it('keeps a button in an input group out of its field', () => {
    expect(components).toMatch(
      new RegExp(
        `\\[data-slot='input-group-addon'\\]\\s*${compact.replace(/[[\]().*]/g, '\\$&')}::before \\{\\s*inset-inline: 0;`
      )
    )
  })

  it('spills the status bar’s actions only up and down', () => {
    expect(components).toMatch(
      /:is\(\[data-slot='status-bar-hint'\], \[data-slot='status-bar-action'\]\) \{\s*position: relative;\s*&::before \{\s*content: '';\s*position: absolute;\s*inset: -3px 0;/
    )
    expect(components).toMatch(
      /\[data-slot='stream-manager-actions'\]\s*:is\(\[data-slot='status-bar-hint'\], \[data-slot='status-bar-action'\]\)::before \{\s*inset-block: -4px;/
    )
  })

  it('opts out where a spill would reach a neighbour', () => {
    // Marker pins can touch; the View in Discord lines stack with no gap.
    expect(read('./components/media/marker-pins.tsx')).toMatch(
      /const PIN_CLASS =\s*'[^']*before:hidden'/
    )
    const discord = read('./components/streaming/discord-section.tsx')
    expect(discord).toMatch(/<Button\s+className="before:hidden"[^<]*View in Discord/)
    // A Discord row's Switch spills 4 px toward the edit and remove buttons.
    expect(discord).toMatch(
      /aria-label=\{`Link \$\{row\.label\} in the post`\}[^/]*className="after:-left-1"/
    )
  })
})
