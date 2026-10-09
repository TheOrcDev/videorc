// @vitest-environment happy-dom
import { act, createElement, useEffect, useImperativeHandle } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CohostPane } from '@/components/cohost-pane'
import type { BuddyPetPreviewProps } from '@/components/buddy-pet-preview'
import type { CohostState, CohostWindowBuddy } from '@/lib/backend'
import { EMPTY_COHOST_STATE } from '@/lib/cohost-view'

// The living preview has its own test; here it is a stub that reports the
// pack's reactions and records what the header asks of it (plan 168 S-D3).
const preview = vi.hoisted(() => ({
  reactions: ['laugh', 'proud', 'blink'] as string[],
  react: vi.fn((_reaction: string) => true),
  props: null as BuddyPetPreviewProps | null
}))
vi.mock('@/components/buddy-pet-preview-lazy', () => ({
  LazyBuddyPetPreview: (props: BuddyPetPreviewProps) => {
    preview.props = props
    useImperativeHandle(props.ref, () => ({ react: preview.react }))
    const { onLoad, packId } = props
    useEffect(() => {
      onLoad?.({
        packId,
        name: 'Pack',
        reactions: preview.reactions,
        gazeCount: 1,
        frameCount: 1 + preview.reactions.length,
        neutral: 'idle',
        gazes: [{ id: 'idle', gaze: [0, 0] }],
        headTop: 0,
        notes: []
      })
    }, [onLoad, packId])
    return createElement(
      'div',
      { 'data-testid': 'buddy-pet-preview', 'data-pack': packId },
      props.placeholder
    )
  }
}))

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function state(overrides: Partial<CohostState> = {}): CohostState {
  return { ...EMPTY_COHOST_STATE, sessionId: 'session-1', status: 'listening', ...overrides }
}

function buddy(overrides: Partial<CohostWindowBuddy> = {}): CohostWindowBuddy {
  return {
    persona: { id: 'default', name: 'Grum', images: {}, bubbleStyle: 'speech', source: 'default' },
    state: 'idle',
    bubble: null,
    showOnStream: true,
    ...overrides
  }
}

async function renderPane(props: Partial<Parameters<typeof CohostPane>[0]> = {}): Promise<void> {
  await act(async () =>
    root.render(
      createElement(CohostPane, {
        consented: true,
        enabled: true,
        gate: { allowed: true },
        state: state(),
        onAnswered: () => undefined,
        onDismissFlag: () => undefined,
        onDismissQuestion: () => undefined,
        onReply: () => undefined,
        ...props
      })
    )
  )
}

function sayInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('[data-slot="buddy-say"] input')
  expect(input).toBeTruthy()
  return input!
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function press(input: HTMLInputElement, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
    )
  })
}

describe('CohostPane: the Golem header (plan 164 S-C4)', () => {
  it('shows the state image, the name and the switch above the AI rows', async () => {
    await renderPane({ buddy: buddy({ state: 'laugh', bubble: 'Welcome to the horde' }) })
    const image = container.querySelector<HTMLImageElement>('[data-slot="buddy-state-image"]')
    expect(image?.getAttribute('data-state')).toBe('laugh')
    // The bundled pack's laughing drawing, not the idle one.
    const laughing = image?.getAttribute('src')
    expect(laughing).toBeTruthy()
    await renderPane({ buddy: buddy({ state: 'idle' }) })
    const idle = container.querySelector<HTMLImageElement>('[data-slot="buddy-state-image"]')
    expect(idle?.getAttribute('data-state')).toBe('idle')
    expect(idle?.getAttribute('src')).not.toBe(laughing)
    await renderPane({ buddy: buddy({ state: 'laugh', bubble: 'Welcome to the horde' }) })
    expect(container.querySelector('[data-slot="buddy-name"]')?.textContent).toBe('Grum')
    expect(container.querySelector('[data-slot="buddy-bubble"]')?.textContent).toContain(
      'Welcome to the horde'
    )
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="buddy-show-on-stream"]'
    )
    expect(toggle?.getAttribute('aria-checked')).toBe('true')
    // The header comes first; the AI pane follows it.
    const html = container.innerHTML
    expect(html.indexOf('data-slot="buddy-header"')).toBeLessThan(
      html.indexOf('data-testid="cohost-pane"')
    )
  })

  it('is absent without a Golem, and stays alone when the AI side is off', async () => {
    await renderPane()
    expect(container.querySelector('[data-slot="buddy-header"]')).toBeNull()
    await renderPane({ buddy: buddy(), enabled: false })
    expect(container.querySelector('[data-slot="buddy-header"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="cohost-pane"]')).toBeNull()
    // Not Premium: the header stays above the upsell line (the overlay is free).
    await renderPane({
      buddy: buddy(),
      gate: {
        allowed: false,
        featureId: 'live-cohost',
        reason: 'Golem requires Videorc Premium.',
        upgradeUrl: 'https://www.videorc.com/premium'
      }
    })
    expect(container.querySelector('[data-slot="buddy-header"]')).toBeTruthy()
    expect(container.querySelector('[data-slot="cohost-notice"]')).toBeTruthy()
  })

  it('says the draft talking on ↵ and laughing on ⌘↵, then clears it', async () => {
    const onSay = vi.fn(async () => undefined)
    await renderPane({ buddy: buddy(), onSay })
    await type(sayInput(), '  Hello horde  ')
    await press(sayInput())
    expect(onSay).toHaveBeenLastCalledWith('Hello horde', 'talk')
    expect(sayInput().value).toBe('')
    await type(sayInput(), 'ha')
    await press(sayInput(), { metaKey: true })
    expect(onSay).toHaveBeenLastCalledWith('ha', 'laugh')
    await type(sayInput(), 'ctrl too')
    await press(sayInput(), { ctrlKey: true })
    expect(onSay).toHaveBeenLastCalledWith('ctrl too', 'laugh')
    // Nothing is said for an empty draft or while one is on its way.
    await press(sayInput())
    expect(onSay).toHaveBeenCalledTimes(3)
    await renderPane({ buddy: buddy(), onSay, sayPending: true })
    await type(sayInput(), 'wait')
    await press(sayInput())
    expect(onSay).toHaveBeenCalledTimes(3)
  })

  it('relays the switch and disables it without a handler', async () => {
    const onShowOnStreamChange = vi.fn()
    await renderPane({ buddy: buddy({ showOnStream: false }), onShowOnStreamChange })
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="buddy-show-on-stream"]'
    )!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await act(async () => toggle.click())
    expect(onShowOnStreamChange).toHaveBeenCalledWith(true)
    await renderPane({ buddy: buddy() })
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="buddy-show-on-stream"]')?.disabled
    ).toBe(true)
    expect(sayInput().disabled).toBe(true)
  })
})

describe('CohostPane: the living Golem header (plan 168 S-D3)', () => {
  function chips(): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>('[data-testid="buddy-reaction-chip"]')]
  }

  it('shows the worn pack at 32 px, holding the frame of the state on air', async () => {
    await renderPane({
      buddy: buddy({
        state: 'talk',
        persona: {
          id: 'p-1',
          name: 'Grum',
          images: {},
          bubbleStyle: 'speech',
          source: 'default',
          avatar: { kind: 'alive', packId: 'bundled:buddy' },
          motion: { intensity: 0.8, sleepAfterSeconds: 60, breathing: false }
        }
      })
    })
    expect(preview.props).toMatchObject({
      personaId: 'p-1',
      packId: 'bundled:buddy',
      size: 32,
      pose: 'talk',
      motion: { intensity: 0.8, sleepAfterSeconds: 60, breathing: false }
    })
    expect(container.querySelector('[data-slot="buddy-avatar"]')?.getAttribute('data-state')).toBe(
      'talk'
    )
    // An older Studio sends no avatar: the Still pack, idle not held.
    await renderPane({ buddy: buddy() })
    expect(preview.props).toMatchObject({ packId: 'still', pose: null })
  })

  it('relays a reaction chip and plays it in the preview; chips the pack lacks are off', async () => {
    const onReact = vi.fn()
    await renderPane({ buddy: buddy(), onReact })
    expect(chips().map((chip) => [chip.textContent, chip.disabled])).toEqual([
      ['Laugh', false],
      ['Wave', true],
      ['Surprised', true],
      ['Proud', false]
    ])
    await act(async () => chips()[3]!.click())
    expect(onReact).toHaveBeenCalledWith('proud')
    expect(preview.react).toHaveBeenLastCalledWith('proud')
  })

  it('disables every chip without a relay', async () => {
    await renderPane({ buddy: buddy() })
    expect(chips().every((chip) => chip.disabled)).toBe(true)
  })
})
