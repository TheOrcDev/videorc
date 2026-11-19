import { describe, it, expect, vi } from 'vitest'
import { cloudMarkerSchema, markerTarget, type CloudMarker } from './cloud-markers'
import { markerContextSchema, markerRelayCommandSchema } from './session-markers'
import { validateBackendRpcResult, validateBackendEventPayload } from './backend-rpc-contract'
import { createCommentsMarker, markerCreateParams } from '../renderer/src/lib/marker-command'
import { clipMarkedToast } from './clip-marks'
const id = '00000000-0000-4000-8000-000000000001'
const marker: CloudMarker = {
  id,
  showId: 'sh_fixture',
  atSeconds: 60,
  kind: 'clip',
  label: null,
  lookbackSeconds: 30,
  source: 'manual',
  authorUserId: 'owner',
  createdAt: '2026-11-17T12:01:00Z',
  revision: 1,
  deleted: false,
  target: {
    kind: 'cloud-show',
    showId: 'sh_fixture',
    liveIntervalId: null,
    takeIds: ['tk_one'],
    providerEgressIds: ['EG_one']
  },
  time: {
    basis: 'server-show-created-at',
    origin: '2026-11-17T12:00:00Z',
    atSeconds: 60,
    observation: 'server-accepted',
    mediaUncertaintyMs: null
  },
  sourcePosition: null,
  media: { status: 'unavailable', reason: 'clock-unconfirmed', extractable: false }
}
describe('cloud marker target and boundaries', () => {
  it('retains every identity separately without a native session or qualified range', () => {
    expect(cloudMarkerSchema.parse(marker)).toEqual(marker)
    expect(markerTarget(marker)).toEqual({ kind: 'cloud-show', showId: 'sh_fixture' })
    for (const patch of [
      { sessionId: 'fake' },
      { media: { status: 'available', extractable: true } },
      { time: { ...marker.time, mediaUncertaintyMs: 0 } }
    ])
      expect(() => cloudMarkerSchema.parse({ ...marker, ...patch })).toThrow()
  })
  it('validates new relay and receipts without widening native mutation schema', () => {
    expect(
      markerContextSchema.parse({ cloudShowId: 'sh_fixture', available: true, lastMarker: marker })
    ).toBeTruthy()
    expect(
      markerRelayCommandSchema.parse({
        requestId: 'one',
        action: 'cloudCreate',
        params: { showId: 'sh_fixture', operationId: id }
      })
    ).toBeTruthy()
    expect(validateBackendRpcResult('cloud.marker.get', { status: 'deleted' })).toEqual({
      status: 'deleted'
    })
    expect(validateBackendEventPayload('cloud.marker.created', marker)).toEqual(marker)
    expect(() => validateBackendRpcResult('session.marker.create', marker)).toThrow()
  })
  it('keeps cloud retries after Stop but never moves them to a different show', () => {
    const first = markerCreateParams(null, { cloudShowId: 'sh_a', available: true }, 'topic')
    expect('showId' in first && first.showId).toBe('sh_a')
    expect(markerCreateParams(first, null, 'topic')).toBe(first)
    const next = markerCreateParams(first, { cloudShowId: 'sh_b', available: true }, 'topic')
    expect(next.operationId).not.toBe(first.operationId)
  })
  it('recovers the authoritative server receipt after a lost response', async () => {
    const relay = vi.fn(async (command: { action: string }) => {
      if (command.action === 'cloudCreate') throw Error('lost')
      return { status: 'found' as const, marker }
    })
    const answer = await createCommentsMarker(
      { markerFromCommentsWindow: relay },
      { showId: marker.showId, operationId: id, kind: 'clip', lookbackSeconds: 30 }
    )
    expect(answer).toEqual(marker)
    expect(relay.mock.calls.map(([c]) => c.action)).toEqual(['cloudCreate', 'cloudGet'])
  })
  it('clip receipt says saved metadata, never saved clip media', () => {
    expect(
      clipMarkedToast({
        showId: marker.showId,
        markerId: id,
        atSeconds: 60,
        source: 'manual',
        saved: true,
        reason: 'cloud-marker-no-media'
      })
    ).toEqual({
      kind: 'success',
      title: 'Marker saved',
      description: 'Saved on the show timeline; no media to extract.'
    })
  })
})

// L2: a cloud clip mark used to drop its clip silently once 16 clips had
// been saved; the host now hears why, and the wire takes every cloud reason.
describe('cloud clip mark reasons', () => {
  const cloudMark = (reason: string, detail?: string) => ({
    showId: marker.showId,
    markerId: id,
    atSeconds: 60,
    source: 'manual',
    saved: true,
    reason,
    ...(detail ? { detail } : {})
  })
  it('the clip.mark reply and the clip.marked event take every cloud reason', () => {
    for (const reason of [
      'cloud-marker-no-media',
      'cloud-clip-saved',
      'cloud-clip-queued',
      'cloud-clip-interrupted'
    ]) {
      expect(validateBackendRpcResult('clip.mark', cloudMark(reason))).toEqual(cloudMark(reason))
      expect(validateBackendEventPayload('clip.marked', cloudMark(reason))).toEqual(
        cloudMark(reason)
      )
    }
    const refused = cloudMark('cloud-clip-interrupted', 'Another clip is still saving.')
    expect(validateBackendEventPayload('clip.marked', refused)).toEqual(refused)
    expect(() => validateBackendRpcResult('clip.mark', cloudMark('cloud-clip-lost'))).toThrow()
  })
  it('a mark carries why its clip was refused, and nothing else', () => {
    for (const clipRefused of ['busy', 'full', 'failed'] as const)
      expect(cloudMarkerSchema.parse({ ...marker, clipRefused }, 'm')).toEqual({
        ...marker,
        clipRefused
      })
    expect(() => cloudMarkerSchema.parse({ ...marker, clipRefused: 'other' }, 'm')).toThrow()
  })
  it('a refused clip says the marker is kept and why, in words', () => {
    const words = 'Retry or discard the unfinished clips in Clips on the Output page.'
    expect(clipMarkedToast(cloudMark('cloud-clip-interrupted', words) as never)).toEqual({
      kind: 'warning',
      title: 'Marker saved; clip interrupted',
      description: words
    })
    expect(clipMarkedToast(cloudMark('cloud-clip-interrupted') as never).description).toBe(
      'Retry or discard staging files from Clips on the Output page.'
    )
  })
})
