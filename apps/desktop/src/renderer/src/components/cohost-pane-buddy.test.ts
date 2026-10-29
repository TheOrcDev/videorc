// @vitest-environment happy-dom
import { act, createElement, createRef, useEffect, useImperativeHandle } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BuddyIdentity, BuddySayFooter } from '@/components/cohost-pane'
import { buddyOffOutputsNotice } from '@/lib/buddy-output-notice'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BuddyPetPreviewHandle, BuddyPetPreviewProps } from '@/components/buddy-pet-preview'
import type { CohostWindowBuddy } from '@/lib/backend'

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

function buddy(overrides: Partial<CohostWindowBuddy> = {}): CohostWindowBuddy {
  return {
    persona: { id: 'default', name: 'Grum', images: {}, bubbleStyle: 'speech', source: 'default' },
    state: 'idle',
    bubble: null,
    showOnStream: true,
    ...overrides
  }
}

/**
 * The header's identity and the footer, wired the way the Stream Manager
 * wires them (plan 174 S3.14c): one preview handle and one reaction list
 * shared between the two.
 */
function Surfaces({
  buddy: value,
  footer = {}
}: {
  buddy: CohostWindowBuddy
  footer?: Partial<Parameters<typeof BuddySayFooter>[0]>
}): ReturnType<typeof createElement> {
  const previewRef = createRef<BuddyPetPreviewHandle | null>()
  return createElement(
    TooltipProvider,
    null,
    createElement(BuddyIdentity, {
      buddy: value,
      previewRef,
      onPackReactions: (reactions) => {
        packReactions = reactions
      }
    }),
    createElement(BuddySayFooter, {
      buddy: value,
      previewRef,
      packReactions: preview.reactions,
      ...footer
    })
  )
}

let packReactions: readonly string[] | null = null

async function render(
  value: CohostWindowBuddy,
  footer: Partial<Parameters<typeof BuddySayFooter>[0]> = {}
): Promise<void> {
  await act(async () => root.render(createElement(Surfaces, { buddy: value, footer })))
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

describe('BuddyIdentity and BuddySayFooter (plan 164 S-C4, plan 174 S3.14c)', () => {
  it('shows the state image, the name and the bubble in the header, the switch in the footer', async () => {
    await render(buddy({ state: 'laugh', bubble: 'Welcome to the horde' }))
    const image = container.querySelector<HTMLImageElement>('[data-slot="buddy-state-image"]')
    expect(image?.getAttribute('data-state')).toBe('laugh')
    // The bundled pack's laughing drawing, not the idle one.
    const laughing = image?.getAttribute('src')
    expect(laughing).toBeTruthy()
    await render(buddy({ state: 'idle' }))
    const idle = container.querySelector<HTMLImageElement>('[data-slot="buddy-state-image"]')
    expect(idle?.getAttribute('data-state')).toBe('idle')
    expect(idle?.getAttribute('src')).not.toBe(laughing)
    await render(buddy({ state: 'laugh', bubble: 'Welcome to the horde' }))
    expect(container.querySelector('[data-slot="buddy-name"]')?.textContent).toBe('Grum')
    expect(container.querySelector('[data-slot="buddy-bubble"]')?.textContent).toContain(
      'Welcome to the horde'
    )
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="buddy-show-on-stream"]'
    )
    expect(toggle?.getAttribute('aria-checked')).toBe('true')
    // Plan 174 F-18: the overlay switch is named after the Buddy.
    expect(toggle?.getAttribute('aria-label')).toBe('Grum on stream')
    // Identity first, the footer last.
    const html = container.innerHTML
    expect(html.indexOf('data-slot="buddy-header"')).toBeLessThan(
      html.indexOf('data-slot="buddy-footer"')
    )
    expect(packReactions).toEqual(['laugh', 'proud', 'blink'])
  })

  it('says the draft talking on ↵ and laughing on ⌘↵, then clears it', async () => {
    const onSay = vi.fn(async () => undefined)
    await render(buddy(), { onSay })
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
    await render(buddy(), { onSay, sayPending: true })
    await type(sayInput(), 'wait')
    await press(sayInput())
    expect(onSay).toHaveBeenCalledTimes(3)
  })

  it('speaks in the bubble only, in every mode: never a word about chat (plan 211 D2)', async () => {
    await render(buddy(), { onSay: vi.fn() })
    expect(sayInput().getAttribute('placeholder')).toBe('Say something on stream')
    expect(sayInput().hasAttribute('aria-describedby')).toBe(false)
    expect(container.querySelector('[data-slot="buddy-say-posts"]')).toBeNull()
    const footer = container.querySelector('[data-slot="buddy-footer"]')?.textContent ?? ''
    expect(footer).not.toMatch(/chat/i)
    expect(footer).not.toContain('posts')
  })

  it('relays the switch and disables it without a handler', async () => {
    const onShowOnStreamChange = vi.fn()
    await render(buddy({ showOnStream: false }), { onShowOnStreamChange })
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="buddy-show-on-stream"]'
    )!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await act(async () => toggle.click())
    expect(onShowOnStreamChange).toHaveBeenCalledWith(true)
    await render(buddy())
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="buddy-show-on-stream"]')?.disabled
    ).toBe(true)
    expect(sayInput().disabled).toBe(true)
  })

  it('says in words when the Buddy is on no output, with the switch one click away', async () => {
    const onShowOnStreamChange = vi.fn()
    const offOutputsNotice = buddyOffOutputsNotice({
      enabled: true,
      onAir: true,
      showOnStream: false,
      showInRecording: false,
      name: 'Grum'
    })
    await render(buddy({ showOnStream: false }), { offOutputsNotice, onShowOnStreamChange })
    const notice = container.querySelector<HTMLElement>('[data-testid="buddy-off-outputs"]')!
    expect(notice.textContent).toContain("Grum isn't on stream.")
    expect(notice.textContent).toContain("Viewers can't see it")
    const show = [...notice.querySelectorAll('button')].find(
      (button) => button.textContent === 'Show on stream'
    )!
    await act(async () => show.click())
    expect(onShowOnStreamChange).toHaveBeenCalledWith(true)
    // Nothing without a notice: the footer is the same as before.
    await render(buddy({ showOnStream: true }), { onShowOnStreamChange })
    expect(container.querySelector('[data-testid="buddy-off-outputs"]')).toBeNull()
  })
})

describe('the living Buddy header (plan 168 S-D3)', () => {
  function chips(): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>('[data-testid="buddy-reaction-chip"]')]
  }

  it('shows the worn pack at 32 px, holding the frame of the state on air', async () => {
    await render(
      buddy({
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
    )
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
    await render(buddy())
    expect(preview.props).toMatchObject({ packId: 'still', pose: null })
  })

  it('relays a reaction chip and plays it in the preview; chips the pack lacks are off', async () => {
    const onReact = vi.fn()
    await render(buddy(), { onReact })
    expect(chips().map((chip) => [chip.textContent, chip.disabled])).toEqual([
      ['Laugh', false],
      ['Wave', true],
      ['Surprised', true],
      ['Proud', false]
    ])
    // Plan 174 F-12: an off chip says why on hover and keyboard focus.
    const reasons = chips().map((chip) => {
      const wrapper = chip.closest<HTMLElement>('[data-slot="disabled-reason"]')
      return wrapper
        ? document.getElementById(wrapper.getAttribute('aria-describedby') ?? '')?.textContent
        : null
    })
    expect(reasons).toEqual([
      null,
      'Only an Alive Buddy reacts. Make it Alive on the Buddy page.',
      'Only an Alive Buddy reacts. Make it Alive on the Buddy page.',
      null
    ])
    await act(async () => chips()[3]!.click())
    expect(onReact).toHaveBeenCalledWith('proud')
    expect(preview.react).toHaveBeenLastCalledWith('proud')
  })

  it('disables every chip without a relay', async () => {
    await render(buddy())
    expect(chips().every((chip) => chip.disabled)).toBe(true)
  })
})
