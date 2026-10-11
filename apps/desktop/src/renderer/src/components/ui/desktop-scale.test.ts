import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Button } from './button'
import { dialogContentVariants } from './dialog'
import { Input } from './input'
import { Switch } from './switch'
import { Tabs, TabsList, TabsTrigger } from './tabs'
import { Textarea } from './textarea'
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

  it('defines the type tokens, the tag radius and the inset fill (plan 174 S1.6a)', () => {
    for (const token of [
      '--text-label: 0.6875rem; /* 11px */',
      '--text-label--font-weight: 600;',
      '--text-section: 0.8125rem; /* 13px */',
      '--text-section--font-weight: 600;',
      '--text-meta: 0.75rem; /* 12px */',
      '--radius-tag: 7px;',
      '--color-inset: color-mix(in oklab, var(--foreground) 3%, transparent);'
    ]) {
      expect(styles).toContain(token)
    }
    // The 3% inset fill has one name now; its ~30 copies moved onto it.
    expect(read('field.tsx')).toContain('bg-inset')
    expect(read('field.tsx')).not.toContain('bg-foreground/[0.03]')
    expect(read('badge.tsx')).toContain('rounded-tag')
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
          ? /rounded-row border glass-float-tooltip /
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

  it('fades and scales every float from 0.98 in 100 ms, with no slide (plan 174 S1.8, J1-23)', () => {
    for (const name of [
      'tooltip.tsx',
      'hover-card.tsx',
      'popover.tsx',
      'dropdown-menu.tsx',
      'context-menu.tsx',
      'select.tsx'
    ]) {
      const source = read(name)
      expect(source, name).not.toMatch(/slide-in-from|zoom-(?:in|out)-95/)
      expect(source, name).toContain('data-open:zoom-in-[0.98]')
      expect(source, name).toContain('duration-100')
    }
    for (const name of ['switch.tsx', 'accordion.tsx']) {
      expect(read(name), name).not.toContain('transition-all')
    }
  })

  it('keeps the switch knob white on its rim in both themes, like the slider (J1-15)', () => {
    const markup = renderToStaticMarkup(createElement(Switch, { checked: true }))
    expect(markup).toContain('bg-knob shadow-sm ring-1 ring-knob-ring')
    expect(markup).not.toMatch(
      /bg-background|bg-primary-foreground|dark:data-\[state=unchecked\]:bg-foreground/
    )
  })

  it('sets inputs and text areas at 14 px at every width, never the mobile 16 px (J1-10)', () => {
    for (const markup of [
      renderToStaticMarkup(createElement(Input)),
      renderToStaticMarkup(createElement(Textarea))
    ]) {
      expect(markup).toContain('text-sm')
      expect(markup).not.toMatch(/text-base|md:text-/)
    }
  })

  it('keeps the feedback primitives on the desktop scale (plan 174 S1.5)', () => {
    // Alert: a flush inline row on the row radius, never a card.
    expect(read('alert.tsx')).toContain('rounded-row px-3 py-2.5')
    expect(read('alert.tsx')).not.toMatch(/\bshadow|rounded-(lg|xl|panel)/)
    // Empty: 14 px text, no media tile, no oversized title.
    const empty = read('empty.tsx')
    expect(empty).not.toContain('EmptyMedia')
    expect(empty).not.toMatch(/text-(lg|base)|rounded-|border-dashed/)
    // Spinner and Progress are the shadcn primitives on the registry glyph.
    expect(read('spinner.tsx')).toContain("from '@/components/icons'")
    expect(read('progress.tsx')).toContain('rounded-full')
  })

  it('mounts the tooltip provider with the desktop delay', () => {
    expect(() =>
      renderToStaticMarkup(createElement(TooltipProvider, null, createElement('span')))
    ).not.toThrow()
  })
})
