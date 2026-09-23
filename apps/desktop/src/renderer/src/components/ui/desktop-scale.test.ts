import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Button } from './button'
import { Input } from './input'
import { Tabs, TabsList, TabsTrigger } from './tabs'
import { TooltipProvider } from './tooltip'

// Plan 050, D4/D5: one desktop scale, retuned once in components/ui.

const styles = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8')
const read = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')

describe('desktop scale', () => {
  it('defines the radius tiers 12 / 8 / 6 and the size tokens', () => {
    expect(styles).toContain('--radius-panel: calc(var(--radius) + 2px); /* 12px */')
    expect(styles).toContain('--radius-row: calc(var(--radius) - 2px); /* 8px */')
    expect(styles).toContain('--radius-chip: calc(var(--radius) - 4px); /* 6px */')
    for (const token of [
      '--spacing-toolbar: 2.5rem',
      '--spacing-status-bar: 1.625rem',
      '--spacing-row: 2rem',
      '--spacing-row-compact: 1.75rem',
      '--spacing-control: 1.75rem',
      '--spacing-gutter: 1rem'
    ]) {
      expect(styles).toContain(token)
    }
  })

  it('makes 28 px the default control height', () => {
    const button = renderToStaticMarkup(createElement(Button, null, 'Save'))
    expect(button).toContain('h-control')
    expect(button).not.toContain('translate-y-px')
    expect(renderToStaticMarkup(createElement(Input))).toContain('h-control')
    expect(read('select.tsx')).toContain('data-[size=default]:h-control')
  })

  it('draws the selected segment as a glass chip, keyed off data-state (#392)', () => {
    const markup = renderToStaticMarkup(
      createElement(
        Tabs,
        { defaultValue: 'a' },
        createElement(
          TabsList,
          null,
          createElement(TabsTrigger, { value: 'a' }, 'A'),
          createElement(TabsTrigger, { value: 'b' }, 'B')
        )
      )
    )
    expect(markup).toContain(
      'group-data-[variant=default]/tabs-list:data-[state=active]:glass-chip'
    )
    expect(markup).toContain('data-state="active"')
    expect(markup).not.toMatch(/data-active:/)
  })

  it('keeps floating surfaces on the popover tokens, never an inverted pill', () => {
    const tooltip = read('tooltip.tsx')
    expect(tooltip).toContain('bg-popover')
    expect(tooltip).not.toContain('bg-foreground')
    expect(tooltip).toContain('delayDuration = 600')
    for (const name of ['dropdown-menu.tsx', 'select.tsx', 'popover.tsx']) {
      const source = read(name)
      expect(source).toContain('rounded-lg bg-popover')
      expect(source).not.toMatch(/rounded-(2xl|3xl)/)
    }
    expect(read('dialog.tsx')).toContain('rounded-panel bg-popover p-5')
  })

  it('mounts the tooltip provider with the desktop delay', () => {
    expect(() =>
      renderToStaticMarkup(createElement(TooltipProvider, null, createElement('span')))
    ).not.toThrow()
  })
})
