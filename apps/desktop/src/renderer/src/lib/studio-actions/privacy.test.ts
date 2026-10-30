import { describe, it, expect, vi } from 'vitest'
import { screenPrivacyAction, SCREEN_HIDE_UNAVAILABLE } from './privacy'
import { REMOTE_INTENT_EXECUTORS } from './remote'
import { STUDIO_AGENT_TOOLS } from './tools'
import type { StudioActionContext } from './context'

describe('privacy callers', () => {
  for (const caller of ['agent', 'buddy'] as const) {
    it(`${caller} can hide but never show`, async () => {
      const request = vi.fn().mockResolvedValue({ hidden: true })
      expect((await screenPrivacyAction({ request }, 'hide', caller)).ok).toBe(true)
      request.mockClear()
      expect(await screenPrivacyAction({ request }, 'show', caller)).toEqual({
        ok: false,
        message: 'Only you can show your screen again.'
      })
      expect(request).not.toHaveBeenCalled()
      expect((await screenPrivacyAction({ request }, 'toggle', caller)).ok).toBe(false)
      expect(request).toHaveBeenCalledExactlyOnceWith('screen.privacy.get')
    })
  }
  it('allows the streamer and paired devices to show', async () => {
    for (const caller of ['you', 'remote'] as const) {
      const request = vi.fn().mockResolvedValue({ hidden: false })
      expect((await screenPrivacyAction({ request }, 'show', caller)).ok).toBe(true)
      expect(request).toHaveBeenCalledWith('screen.show', undefined)
    }
  })
  it('maps the legacy refusal to exact copy', async () => {
    const request = vi.fn().mockRejectedValue({ code: 'screen-hide-unavailable' })
    expect(await screenPrivacyAction({ request }, 'hide', 'you')).toEqual({
      ok: false,
      message: SCREEN_HIDE_UNAVAILABLE
    })
  })
  it('all three remote intents use the remote caller', async () => {
    const runScreenPrivacy = vi.fn().mockResolvedValue({ ok: true })
    const context = { runScreenPrivacy } as unknown as StudioActionContext
    for (const [kind, mode] of [
      ['screenHide', 'hide'],
      ['screenShow', 'show'],
      ['screenHideToggle', 'toggle']
    ]) {
      await REMOTE_INTENT_EXECUTORS[kind](context, {})
      expect(runScreenPrivacy).toHaveBeenLastCalledWith(mode, 'remote')
    }
  })
})

it('the agent catalog executor marks Buddy separately and offers no show tool', async () => {
  const runScreenPrivacy = vi.fn().mockResolvedValue({ ok: true })
  const context = { runScreenPrivacy } as unknown as StudioActionContext
  for (const agentId of ['buddy', 'agent']) {
    expect(
      await STUDIO_AGENT_TOOLS.hide_screen(
        context,
        {},
        { intentId: '1', agentId, agentName: agentId, tool: 'hide_screen', args: {} }
      )
    ).toMatchObject({ ok: true, result: { hidden: true } })
    expect(runScreenPrivacy).toHaveBeenLastCalledWith('hide', agentId)
  }
  expect(STUDIO_AGENT_TOOLS).not.toHaveProperty('show_screen')
})
