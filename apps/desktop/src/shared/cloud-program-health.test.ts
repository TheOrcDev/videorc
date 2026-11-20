import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { CloudOutputHealth } from './backend'
import { validateBackendEventPayload, validateBackendRpcResult } from './backend-rpc-contract'
import {
  PROGRAM_PREVIEW_NOTE,
  programHealthRows,
  programHealthVerdict,
  type ProgramHealthInput
} from './cloud-program-health'
import { cloudRoomActivityFromCloudStatus } from './cloud-room-activity'

// Plan 249 S26: the shared vectors (`protocol-fixtures/cloud-parity-health.json`,
// the web's `tests/fixtures/cloud-parity-health.json` byte for byte): the web
// builds `outputs`, this app turns them into Health's rows (`layers`).

type LayerVector = {
  name: string
  input: ProgramHealthInput
  expected: [string, string, string][]
  detailIncludes?: Record<string, string>
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../protocol-fixtures/cloud-parity-health.json', import.meta.url),
    'utf8'
  )
) as { outputs: { expected: CloudOutputHealth }[]; layers: LayerVector[] }

const CLOUD_BASE = {
  phase: 'live',
  entitled: true,
  settings: { enabled: true, holdMaxSeconds: 1800, holdMaxChoices: [300, 900, 1800, 3600] },
  connected: true,
  directFallbackAvailable: false
}

describe('cloud program health rows (plan 249 S26)', () => {
  for (const vector of fixture.layers) {
    it(`${vector.name}`, () => {
      const rows = programHealthRows(vector.input)
      expect(rows.map((row) => [row.id, row.status, row.tone])).toEqual(vector.expected)
      for (const [id, words] of Object.entries(vector.detailIncludes ?? {})) {
        expect(rows.find((row) => row.id === id)?.detail).toContain(words)
      }
      // Every status is a word a person reads, never a machine value.
      for (const row of rows) expect(row.status).not.toMatch(/^[a-z-]+$/u)
    })
  }

  it('says no row and no note is proof of the encoded audio', () => {
    expect(PROGRAM_PREVIEW_NOTE).toContain("isn't the encoded stream")
    for (const vector of fixture.layers) {
      for (const row of programHealthRows(vector.input)) {
        expect(row.detail).not.toMatch(/viewers hear (it|you|sound)\b/iu)
        expect(row.detail).not.toMatch(/skew|drift/iu)
      }
    }
  })

  it('folds the rows into one verdict, worst first', () => {
    const [healthy, micLoss] = fixture.layers
    expect(programHealthVerdict(programHealthRows(healthy.input))).toBe('good')
    expect(programHealthVerdict(programHealthRows(micLoss.input))).toBe('error')
    expect(programHealthVerdict([])).toBe('neutral')
  })

  it('reads an output it does not know as nothing, never as healthy', () => {
    const rows = programHealthRows({
      room: { participants: [] },
      outputHealth: [
        {
          output: 'archive',
          orientation: 'square',
          egress: 'active',
          page: 'reporting',
          joined: true,
          audio: 'measured'
        }
      ]
    })
    expect(rows.map((row) => row.id)).toEqual(['host-microphone'])
  })
})

describe('cloud.state carries outputHealth strictly (plan 249 S26)', () => {
  it('accepts every web vector, absent never null', () => {
    const outputHealth = fixture.outputs.map((vector) => vector.expected)
    const status = { ...CLOUD_BASE, outputHealth }
    expect(validateBackendEventPayload('cloud.state', status)).toEqual(status)
    expect(validateBackendRpcResult('cloud.status', status)).toEqual(status)
  })

  it('refuses nulls, unknown keys and more than four outputs', () => {
    const entry = fixture.outputs[0].expected
    for (const bad of [
      [{ ...entry, stageKey: null }],
      [{ ...entry, faults: { drop: 1, name: 'logo.png' } }],
      [{ ...entry, page: '' }],
      [{ ...entry, url: 'wss://x' }],
      [entry, entry, entry, entry, entry]
    ]) {
      expect(() =>
        validateBackendEventPayload('cloud.state', { ...CLOUD_BASE, outputHealth: bad })
      ).toThrow()
    }
  })

  it('accepts the two new watchdog checks', () => {
    for (const check of ['program-unreported', 'contribution-missing']) {
      const view = {
        sessionId: 'sh_0123456789abcdefghijkl',
        alerts: [
          {
            id: `watchdog:${check}:1`,
            check,
            severity: 'warning',
            state: 'open',
            since: '2026-11-17T12:00:00.000Z',
            title: 'The cloud horizontal stream page isn’t reporting',
            detail: 'Its last report was 0:40 ago.',
            source: 'cloud',
            targetId: 'stream-horizontal',
            fixes: [{ kind: 'open-health', label: 'Open Health' }]
          }
        ]
      }
      expect(validateBackendEventPayload('watchdog.alerts', view)).toEqual(view)
    }
  })
})

describe('the room as live activity for the app guards (plan 249 S26)', () => {
  const room = (live: boolean) => ({ phase: 'open', live })
  it('is live on air, recording when only the cloud records, else nothing', () => {
    expect(cloudRoomActivityFromCloudStatus({ room: room(true) })).toBe('live')
    expect(
      cloudRoomActivityFromCloudStatus({ room: room(false), recording: { active: true } })
    ).toBe('recording')
    expect(cloudRoomActivityFromCloudStatus({ room: room(false) })).toBeNull()
    expect(cloudRoomActivityFromCloudStatus({ room: { phase: 'closed', live: true } })).toBeNull()
    expect(cloudRoomActivityFromCloudStatus(null)).toBeNull()
  })
  it('belongs to this computer only', () => {
    expect(
      cloudRoomActivityFromCloudStatus({ room: room(true), stoppedBy: 'taken-over' })
    ).toBeNull()
    expect(
      cloudRoomActivityFromCloudStatus({
        room: room(true),
        onAir: { thisDevice: false, waiting: false }
      })
    ).toBeNull()
    expect(
      cloudRoomActivityFromCloudStatus({
        room: room(true),
        onAir: { thisDevice: true, waiting: true }
      })
    ).toBeNull()
    expect(
      cloudRoomActivityFromCloudStatus({
        room: room(true),
        onAir: { thisDevice: true, waiting: false }
      })
    ).toBe('live')
  })
})

// Plan 253 S7: the Commands row, and the two status fields the backend adds
// on a managed talk show. Both are optional and strict: absent never null.

const ROOM = {
  phase: 'open',
  doorOpen: false,
  declinedCount: 0,
  stage: { layout: 'solo', onStage: ['host:sh_abc'] },
  hostAway: false,
  connected: true,
  client: 'connected',
  returnEnabled: false,
  stageSet: true,
  live: true
}

describe('the Commands row (plan 253 S7)', () => {
  const commands = (commandTimes: ProgramHealthInput['commandTimes']) =>
    programHealthRows({ room: { participants: [] }, commandTimes }).find(
      (row) => row.id === 'commands'
    )

  it('is not drawn until a command was timed', () => {
    expect(commands(undefined)).toBeUndefined()
    expect(commands(null)).toBeUndefined()
    // Every shared vector is a show without command times: no row is added.
    for (const vector of fixture.layers)
      expect(programHealthRows(vector.input).some((row) => row.layer === 'control')).toBe(false)
  })

  it('says how long the last and the slowest command took', () => {
    expect(commands({ lastMs: 420, slowestMs: 3412 })).toEqual({
      id: 'commands',
      layer: 'control',
      label: 'Commands',
      status: 'Normal',
      tone: 'good',
      detail: 'Last answered in 420 ms. Slowest this show: 3.4 s.'
    })
  })

  it('reads Slow from two seconds, on the last command only', () => {
    expect(commands({ lastMs: 1999, slowestMs: 9000 })?.tone).toBe('good')
    const slow = commands({ lastMs: 2000, slowestMs: 2000 })
    expect([slow?.status, slow?.tone]).toEqual(['Slow', 'warn'])
    expect(slow?.detail).toBe('Last answered in 2.0 s. Slowest this show: 2.0 s.')
    expect(programHealthVerdict([slow!])).toBe('warn')
  })
})

describe('cloud.state carries the latency fields strictly (plan 253 S7)', () => {
  it('reads a status with neither field exactly as before', () => {
    const status = { ...CLOUD_BASE, room: { ...ROOM, shown: { onStage: ['host:sh_abc'] } } }
    expect(validateBackendEventPayload('cloud.state', status)).toEqual(status)
  })

  it('accepts command times and a stage apply time', () => {
    const status = {
      ...CLOUD_BASE,
      commandTimes: { lastMs: 420, slowestMs: 3412 },
      room: {
        ...ROOM,
        shown: {
          onStage: ['host:sh_abc'],
          stageKey: 'k1',
          at: '2026-11-20T10:00:00Z',
          applyMs: 412
        }
      }
    }
    expect(validateBackendEventPayload('cloud.state', status)).toEqual(status)
    expect(validateBackendRpcResult('cloud.status', status)).toEqual(status)
  })

  it('refuses null, a fraction, an unknown key and a time out of bounds', () => {
    for (const commandTimes of [
      null,
      { lastMs: 420 },
      { lastMs: 420, slowestMs: null },
      { lastMs: 4.2, slowestMs: 5 },
      { lastMs: 420, slowestMs: 420, kind: 'stage.set' }
    ])
      expect(() =>
        validateBackendEventPayload('cloud.state', { ...CLOUD_BASE, commandTimes })
      ).toThrow()
    for (const applyMs of [null, -1, 12.5, '412', 86_400_001])
      expect(() =>
        validateBackendEventPayload('cloud.state', {
          ...CLOUD_BASE,
          room: { ...ROOM, shown: { onStage: [], applyMs } }
        })
      ).toThrow()
  })
})
