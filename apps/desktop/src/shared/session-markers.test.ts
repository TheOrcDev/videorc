import { describe, expect, it } from 'vitest'
import {
  classifyComposerDraft,
  createMarkerParamsSchema,
  markerLabel,
  markerRelayCommandSchema,
  markerTime
} from './session-markers'
import {
  validateBackendEventPayload,
  validateBackendRpcParams,
  validateBackendRpcResult
} from './backend-rpc-contract'
import { roleCanInvokeChannel } from './renderer-security-policy'

describe('named marker trust boundaries', () => {
  it('classifies local commands before provider send and escapes one slash', () => {
    expect(classifyComposerDraft('/marker Shadcn New Library')).toEqual({
      kind: 'marker',
      label: 'Shadcn New Library'
    })
    expect(classifyComposerDraft(' /MARKER ')).toEqual({ kind: 'marker', label: undefined })
    expect(classifyComposerDraft('/help')).toEqual({ kind: 'help' })
    expect(classifyComposerDraft('/unknown')).toMatchObject({ kind: 'error' })
    expect(classifyComposerDraft('//marker literal')).toEqual({
      kind: 'chat',
      text: '/marker literal'
    })
    expect(classifyComposerDraft('docs /marker https://ui.shadcn.com')).toEqual({
      kind: 'chat',
      text: 'docs /marker https://ui.shadcn.com'
    })
  })
  it('validates Unicode code points without truncation or losing punctuation', () => {
    expect(markerLabel('  Shadcn / 新 Library  ')).toBe('Shadcn / 新 Library')
    expect(markerLabel('😀'.repeat(120))).toBe('😀'.repeat(120))
    expect(() => markerLabel('😀'.repeat(121))).toThrow('120')
    for (const text of ['two\nlines', 'tab\there', 'bad\u2028line'])
      expect(() => markerLabel(text)).toThrow('one line')
    expect(markerLabel('   ')).toBeUndefined()
  })
  it('refuses renderer-selected timestamps, sources and paths in both RPC and IPC', () => {
    const params = {
      operationId: '9fd67b89-536c-483b-9a7f-c7aee6c46c24',
      sessionId: 's1',
      label: 'Title'
    }
    expect(createMarkerParamsSchema.parse(params)).toEqual(params)
    for (const extra of [{ atSeconds: 123 }, { source: 'voice' }, { outputPath: '/tmp/a' }]) {
      expect(() =>
        validateBackendRpcParams('session.marker.create', { ...params, ...extra })
      ).toThrow()
      expect(() =>
        markerRelayCommandSchema.parse({
          requestId: 'r1',
          action: 'create',
          params: { ...params, ...extra }
        })
      ).toThrow()
    }
    expect(() =>
      markerRelayCommandSchema.parse({ requestId: 'r1', action: 'rename', params })
    ).toThrow()
    expect(() =>
      validateBackendRpcResult('session.marker.get', { status: 'deleted', revision: -1 })
    ).toThrow()
    expect(roleCanInvokeChannel('comments', 'backend:get-connection')).toBe(false)
    expect(roleCanInvokeChannel('comments', 'comments-window:marker')).toBe(true)
    expect(roleCanInvokeChannel('comments', 'comments-window:marker-result-push')).toBe(false)
    expect(roleCanInvokeChannel('notes', 'comments-window:marker')).toBe(false)
  })
  it('formats stream timeline times', () => expect(markerTime(3672.7)).toBe('01:01:12'))
  it('accepts the renamed marker RPC receipt and separate change event shape', () => {
    const marker = {
      id: 'm1',
      sessionId: 's1',
      atSeconds: 12.345,
      label: 'Renamed title',
      source: 'manual',
      createdAt: '2026-10-05T12:00:00Z',
      revision: 2
    }
    expect(validateBackendRpcResult('session.marker.rename', marker)).toEqual(marker)
    const changed = {
      sessionId: 's1',
      markerId: 'm1',
      revision: 2,
      deleted: false,
      marker
    }
    expect(validateBackendEventPayload('session.marker.changed', changed)).toEqual(changed)
    expect(() => validateBackendRpcResult('session.marker.rename', changed)).toThrow()
  })
})
