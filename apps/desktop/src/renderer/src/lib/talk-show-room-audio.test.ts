import { describe, expect, it } from 'vitest'

import {
  RemoteAudioAttachments,
  isRunnerIdentity,
  playsRemoteAudio
} from '@/lib/talk-show-room-audio'

// Plan 224 D11 and the review of 2026-11-09 (H1): the runner's return is
// the program, the host's own voice included. A subscription to it must
// never reach the hidden audio host, or the host hears themselves back.

type FakeAudioElement = {
  attributes: Record<string, string>
  removed: boolean
  setAttribute(name: string, value: string): void
  remove(): void
}

function fakeTrack(): {
  attachCalls: number
  elements: FakeAudioElement[]
  attach(): FakeAudioElement
  detach(): FakeAudioElement[]
} {
  const elements: FakeAudioElement[] = []
  const track = {
    attachCalls: 0,
    elements,
    attach(): FakeAudioElement {
      track.attachCalls += 1
      const element: FakeAudioElement = {
        attributes: {},
        removed: false,
        setAttribute(name: string, value: string) {
          element.attributes[name] = value
        },
        remove() {
          element.removed = true
        }
      }
      elements.push(element)
      return element
    },
    detach(): FakeAudioElement[] {
      return [...elements]
    }
  }
  return track
}

function fakeHost(): {
  children: FakeAudioElement[]
  appendChild(element: FakeAudioElement): number
} {
  const children: FakeAudioElement[] = []
  return { children, appendChild: (element: FakeAudioElement) => children.push(element) }
}

describe('remote audio in the host room', () => {
  it('names the runner by its identity prefix only', () => {
    expect(isRunnerIdentity('runner:sh_0123456789abcdefghijkl')).toBe(true)
    expect(isRunnerIdentity('host:sh_0123456789abcdefghijkl')).toBe(false)
    expect(isRunnerIdentity('g_0123456789abcdefghijkl')).toBe(false)
    expect(isRunnerIdentity('g_runner:sh')).toBe(false)
    expect(playsRemoteAudio('runner:sh_abc')).toBe(false)
    expect(playsRemoteAudio('g_abc')).toBe(true)
  })

  it("a runner audio subscription attaches nothing: the return never plays through the host's speakers", () => {
    const host = fakeHost()
    const attachments = new RemoteAudioAttachments<FakeAudioElement>(() => host)
    const returnAudio = fakeTrack()
    expect(attachments.subscribed('runner:sh_abc', returnAudio)).toBeNull()
    expect(returnAudio.attachCalls).toBe(0)
    expect(host.children).toEqual([])
    expect(attachments.identities()).toEqual([])
    // Unsubscribing what was never attached is harmless.
    attachments.unsubscribed('runner:sh_abc', returnAudio)
    expect(attachments.identities()).toEqual([])
  })

  it('a guest or backstage voice plays, is marked with its identity and goes with its track', () => {
    const host = fakeHost()
    const attachments = new RemoteAudioAttachments<FakeAudioElement>(() => host)
    const ada = fakeTrack()
    const element = attachments.subscribed('g_ada', ada)
    expect(element).not.toBeNull()
    expect(ada.attachCalls).toBe(1)
    expect(element?.attributes['data-talk-show-audio']).toBe('g_ada')
    expect(host.children).toHaveLength(1)
    expect(attachments.identities()).toEqual(['g_ada'])
    attachments.unsubscribed('g_ada', ada)
    expect(ada.elements[0]?.removed).toBe(true)
    expect(attachments.identities()).toEqual([])
  })

  it('attaches nothing without an audio host and clears everything on leave', () => {
    const none = new RemoteAudioAttachments<FakeAudioElement>(() => null)
    const bo = fakeTrack()
    expect(none.subscribed('g_bo', bo)).toBeNull()
    expect(bo.attachCalls).toBe(0)
    const host = fakeHost()
    const attachments = new RemoteAudioAttachments<FakeAudioElement>(() => host)
    const ada = fakeTrack()
    const cy = fakeTrack()
    attachments.subscribed('g_ada', ada)
    attachments.subscribed('g_cy', cy)
    attachments.clear()
    expect(ada.elements[0]?.removed).toBe(true)
    expect(cy.elements[0]?.removed).toBe(true)
    expect(attachments.identities()).toEqual([])
  })
})
