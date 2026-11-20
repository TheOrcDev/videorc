import { describe, expect, it } from 'vitest'

import { roomLatencyReport } from './room-latency-report'
import {
  validateBackendRpcParams,
  validateBackendRpcResult
} from '../../../shared/backend-rpc-contract'
import type { RoomLatency } from '../../../shared/room-latency'

// Plan 253 S7: the report the room client hands the backend. Every report
// this builds must pass the strict contract, or the client refuses to send
// it and the show leaves no record.

const NAMES: Record<string, string> = { g_ada: '  Ada  ', g_bo: '' }
const nameOf = (identity: string): string | undefined => NAMES[identity]

const everything: RoomLatency = {
  hostRttMs: 42,
  people: {
    g_ada: {
      ms: 210,
      partial: false,
      toGuestMs: 210,
      fromGuestMs: 180,
      video: { toGuestMs: 96, fromGuestMs: 84 }
    },
    g_bo: { ms: 640, partial: true, toGuestMs: null, fromGuestMs: 640 }
  },
  program: { ms: 300, audioMs: 120 }
}

describe('roomLatencyReport', () => {
  it('carries each figure once, with the name the guest joined with', () => {
    const report = roomLatencyReport('sh_abc', everything, nameOf)
    expect(report).toEqual({
      showId: 'sh_abc',
      hostRttMs: 42,
      people: [
        {
          identity: 'g_ada',
          name: 'Ada',
          ms: 210,
          partial: false,
          toGuestMs: 210,
          fromGuestMs: 180,
          videoToGuestMs: 96,
          videoFromGuestMs: 84
        },
        { identity: 'g_bo', ms: 640, partial: true, fromGuestMs: 640 }
      ],
      program: { ms: 300, audioMs: 120 }
    })
    expect(() => validateBackendRpcParams('cloud.room.latency.report', report)).not.toThrow()
  })

  it('leaves out what was not measured, and never sends null', () => {
    const report = roomLatencyReport(
      'sh_abc',
      { hostRttMs: 42, people: {}, program: { ms: 300, audioMs: null } },
      nameOf
    )
    expect(report).toEqual({ showId: 'sh_abc', hostRttMs: 42, people: [], program: { ms: 300 } })
    expect(JSON.stringify(report)).not.toContain('null')
    expect(() => validateBackendRpcParams('cloud.room.latency.report', report)).not.toThrow()
  })

  it('is no report at all with nothing measured', () => {
    expect(roomLatencyReport('sh_abc', { people: {} }, nameOf)).toBeNull()
  })

  it('keeps a long name inside the contract', () => {
    const report = roomLatencyReport(
      'sh_abc',
      { people: { g_ada: { ms: 1, partial: false, toGuestMs: 1, fromGuestMs: 1 } } },
      () => 'A'.repeat(500)
    )
    expect(report?.people[0]?.name).toHaveLength(80)
    expect(() => validateBackendRpcParams('cloud.room.latency.report', report)).not.toThrow()
  })
})

describe('the cloud.room.latency.report contract', () => {
  const valid = roomLatencyReport('sh_abc', everything, nameOf)!

  it('refuses a key it does not know, at every level', () => {
    for (const bad of [
      { ...valid, at: 1_794_000_000_123 },
      { ...valid, people: [{ ...valid.people[0], address: '10.0.0.2' }] },
      { ...valid, program: { ...valid.program, videoMs: 4 } }
    ])
      expect(() => validateBackendRpcParams('cloud.room.latency.report', bad)).toThrow()
  })

  it('refuses null, a fraction and a duration out of bounds', () => {
    for (const bad of [
      { ...valid, hostRttMs: null },
      { ...valid, hostRttMs: 12.5 },
      { ...valid, hostRttMs: 60_001 },
      { ...valid, people: [{ ...valid.people[0], toGuestMs: null }] },
      { ...valid, people: [{ ...valid.people[0], ms: -1 }] },
      { ...valid, showId: '' },
      {
        ...valid,
        people: Array.from({ length: 17 }, (_, index) => ({
          identity: `g_${index}`,
          ms: 1,
          partial: false
        }))
      }
    ])
      expect(() => validateBackendRpcParams('cloud.room.latency.report', bad)).toThrow()
  })

  it('reads the answer strictly', () => {
    expect(validateBackendRpcResult('cloud.room.latency.report', { kept: true })).toEqual({
      kept: true
    })
    expect(() =>
      validateBackendRpcResult('cloud.room.latency.report', { kept: true, rows: 7 })
    ).toThrow()
  })
})
