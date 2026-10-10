// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KebabMenu, kebabMenuGroups, type KebabMenuItem } from './kebab-menu'

// Plan 174 S1.6b (E-PAT, A-PAT): one ⋯ menu anatomy with groups, a busy
// state, keys, and a trigger that can wait for hover or focus.

const item = (id: string, extra: Partial<KebabMenuItem> = {}): KebabMenuItem => ({
  id,
  label: id,
  onSelect: vi.fn(),
  ...extra
})

describe('kebabMenuGroups', () => {
  it('groups by first appearance and puts destructive items last, on their own', () => {
    const groups = kebabMenuGroups([
      item('play', { group: 'open' }),
      item('delete', { destructive: true }),
      item('rename', { group: 'edit' }),
      item('markers', { group: 'open' }),
      item('check', { group: 'repair' })
    ])
    expect(groups.map((group) => group.map(({ id }) => id))).toEqual([
      ['play', 'markers'],
      ['rename'],
      ['check'],
      ['delete']
    ])
  })

  it('keeps an ungrouped menu as one group, with Delete split off as before', () => {
    expect(
      kebabMenuGroups([item('rename'), item('delete', { destructive: true }), item('duplicate')])
    ).toEqual([
      [expect.objectContaining({ id: 'rename' }), expect.objectContaining({ id: 'duplicate' })],
      [expect.objectContaining({ id: 'delete' })]
    ])
  })
})

describe('KebabMenu', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  function trigger(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('button[aria-label="Session actions"]')
  }

  it('shows a spinner and stays reachable while an item works', () => {
    act(() =>
      root.render(
        createElement(KebabMenu, { busy: true, items: [item('play')], label: 'Session actions' })
      )
    )
    expect(trigger()?.getAttribute('aria-busy')).toBe('true')
    expect(trigger()?.querySelector('.animate-spin')).not.toBeNull()
    expect(trigger()?.disabled).toBe(false)
  })

  it('waits for the host row to be hovered or focused when asked', () => {
    act(() =>
      root.render(
        createElement(KebabMenu, {
          items: [item('play')],
          label: 'Session actions',
          reveal: 'hover'
        })
      )
    )
    const className = trigger()?.className ?? ''
    for (const token of [
      'opacity-0',
      'group-hover/kebab-host:opacity-100',
      'group-focus-within/kebab-host:opacity-100',
      'focus-visible:opacity-100',
      'data-[state=open]:opacity-100'
    ]) {
      expect(className).toContain(token)
    }
    act(() =>
      root.render(createElement(KebabMenu, { items: [item('play')], label: 'Session actions' }))
    )
    expect(trigger()?.className).not.toContain('opacity-0')
  })

  it('renders groups split by hairlines, keys on the right, and Delete last in red', () => {
    const items = [
      item('Play', { group: 'open', shortcut: '␣' }),
      item('Rename', { group: 'edit' }),
      item('Delete', { destructive: true })
    ]
    act(() => root.render(createElement(KebabMenu, { items, label: 'Session actions' })))
    act(() => {
      trigger()?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    const menu = document.querySelector('[role=menu]')
    expect(menu).not.toBeNull()
    expect(menu?.querySelectorAll('[role=group]')).toHaveLength(3)
    expect(menu?.querySelectorAll('[role=separator]')).toHaveLength(2)
    expect(menu?.querySelector('[data-slot=dropdown-menu-shortcut]')?.textContent).toBe('␣')
    const rows = [...(menu?.querySelectorAll('[role=menuitem]') ?? [])]
    expect(rows.map((row) => row.textContent)).toEqual(['Play␣', 'Rename', 'Delete'])
    expect(rows.at(-1)?.getAttribute('data-variant')).toBe('destructive')
  })
})
