import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Button } from './button'
import { dialogContentVariants } from './dialog'
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

  it('puts every floating surface on the float glass, never an inverted pill', () => {
    const tooltip = read('tooltip.tsx')
    expect(tooltip).not.toContain('bg-foreground')
    expect(tooltip).toContain('delayDuration = 600')
    // Plan 072: one surface for everything that floats. The old near-opaque
    // popover coat read as a black slab on the plan 050 window glass.
    for (const name of [
      'tooltip.tsx',
      'hover-card.tsx',
      'popover.tsx',
      'dropdown-menu.tsx',
      'context-menu.tsx',
      'select.tsx',
      'chart.tsx'
    ]) {
      const source = read(name)
      // Plan 091 D6: the popup tier for everything that floats, the tooltip
      // tier for tooltips, the dialog tier for dialogs (and the palette).
      expect(source, name).toMatch(
        name === 'tooltip.tsx'
          ? /rounded-md border glass-float-tooltip /
          : /rounded-(lg|xl) border glass-float /
      )
      expect(source, name).not.toContain('bg-popover')
      expect(source, name).not.toMatch(/rounded-(2xl|3xl)/)
    }
    expect(read('dialog.tsx')).toContain('rounded-panel border glass-float-dialog p-5')
    // Command always sits inside a Dialog or Popover: it never paints a coat.
    expect(read('command.tsx')).not.toMatch(/\bbg-(popover|card|background)\b/)
  })

  it('sizes menu, select and context items at 6 px, concentric inside the 4 px inset (J1-14)', () => {
    for (const name of ['dropdown-menu.tsx', 'context-menu.tsx', 'select.tsx']) {
      const source = read(name)
      expect(source, name).not.toMatch(/\brounded-(?:sm|md)\b/)
      expect(source.match(/min-h-7[^"']*rounded-chip/g)?.length ?? 0, name).toBeGreaterThan(0)
      // One separator strength in every float: the hairline itself.
      expect(source, name).not.toContain('bg-border/50')
    }
    expect(read('command.tsx')).not.toContain('bg-border/50')
    expect(read('chart.tsx')).not.toContain('rounded-xl')
  })

  it('gives dialogs four widths and one height rule, shared with AlertDialog (J1-20)', () => {
    const widths = {
      sm: 'sm:max-w-sm',
      md: 'sm:max-w-md',
      lg: 'sm:max-w-xl',
      xl: 'sm:max-w-3xl'
    } as const
    for (const [size, width] of Object.entries(widths)) {
      const classes = dialogContentVariants({ size: size as keyof typeof widths })
      expect(classes).toContain(width)
      expect(classes).toContain('max-h-[calc(100vh-2rem)]')
      expect(classes).toContain('flex-col')
      expect(classes).toContain('rounded-panel border glass-float-dialog p-5')
    }
    expect(dialogContentVariants()).toContain('sm:max-w-md')
    expect(read('alert-dialog.tsx')).toContain('dialogContentVariants({ size })')
    expect(read('dialog.tsx')).toContain('data-slot="dialog-body"')
  })

  it('mounts the tooltip provider with the desktop delay', () => {
    expect(() =>
      renderToStaticMarkup(createElement(TooltipProvider, null, createElement('span')))
    ).not.toThrow()
  })
})
