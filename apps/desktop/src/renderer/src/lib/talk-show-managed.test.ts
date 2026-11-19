import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { CloudStatus } from '@/lib/backend'
import { HOST, ada, guestParticipant, openRoom, talkStatus } from '@/lib/guests-room-fixtures'
import {
  MANAGED_NODE_ID,
  agentRoomProgram,
  isManagedShow,
  managedProgramPreview,
  managedProgramStageInput,
  programMonitorView,
  shownLayout
} from '@/lib/talk-show-managed'
import { effectiveStageLayout } from '@/lib/talk-show-layout'
import { stageKey } from '../../../shared/cloud-presentation-views'

// Plan 234 D6 (T3): a managed show has no return picture, so its Program
// monitor draws the Show stage as the program page reports it. These hold
// which picture the monitor shows, and when.

const wire = JSON.parse(
  readFileSync(
    new URL('../../../../../../protocol-fixtures/cloud-managed-wire.json', import.meta.url),
    'utf8'
  )
) as { control: { managedNodeId: string } }

type Room = NonNullable<CloudStatus['room']>

const show = (nodeId: string) => ({
  id: 'sh_talk',
  nodeId,
  resumable: false,
  kind: 'talk' as const
})

function node(room: Partial<Room> | null): CloudStatus {
  return talkStatus({ show: show('eu-hel-1'), ...(room ? { room: openRoom(room) } : {}) })
}

function managed(room: Partial<Room>, recording?: CloudStatus['recording']): CloudStatus {
  return talkStatus({
    show: show(MANAGED_NODE_ID),
    room: openRoom(room),
    ...(recording ? { recording } : {})
  })
}

describe('a managed show', () => {
  it("is named by the web's own marker", () => {
    expect(MANAGED_NODE_ID).toBe(wire.control.managedNodeId)
    expect(isManagedShow(managed({}))).toBe(true)
    expect(isManagedShow(node({ live: true }))).toBe(false)
    expect(isManagedShow(talkStatus({}))).toBe(false)
    expect(isManagedShow(null)).toBe(false)
    expect(isManagedShow(undefined)).toBe(false)
  })
})

describe('the Program monitor source', () => {
  it('is the return on a node show, whatever runs', () => {
    expect(programMonitorView(node({ live: true }))).toEqual({ source: 'return' })
    expect(programMonitorView(node({ live: true, shown: { onStage: ['host:sh_talk'] } }))).toEqual({
      source: 'return'
    })
    expect(programMonitorView(node(null))).toEqual({ source: 'return' })
    expect(programMonitorView(null)).toEqual({ source: 'return' })
  })

  it('is the stage on a managed show: empty, then waiting, then as the page draws it', () => {
    expect(programMonitorView(managed({}))).toEqual({ source: 'stage', state: 'empty' })
    expect(programMonitorView(managed({ live: true }))).toEqual({
      source: 'stage',
      state: 'waiting'
    })
    // A cloud recording alone runs the program too.
    expect(
      programMonitorView(
        managed({}, { active: true, seconds: 1, bytes: 0, orientations: ['horizontal'] })
      )
    ).toEqual({ source: 'stage', state: 'waiting' })
    expect(
      programMonitorView(managed({ live: true, shown: { onStage: ['host:sh_talk'] } }))
    ).toEqual({ source: 'stage', state: 'shown' })
  })

  it('does not call a stage the page reported the program while nothing runs', () => {
    expect(programMonitorView(managed({ shown: { onStage: ['host:sh_talk'] } }))).toEqual({
      source: 'stage',
      state: 'empty'
    })
  })
})

it('the managed Program follows shorter shown and never draws an identity absent from participants', () => {
  const room = openRoom()
  const host = HOST
  room.stage = {
    layout: 'side-by-side',
    onStage: [host, 'g_departed'],
    spotlight: 'g_departed',
    screen: 'g_departed'
  }
  room.shown = { onStage: [host], screen: 'g_departed' }
  expect(managedProgramStageInput(room)).toEqual({
    layout: 'side-by-side',
    people: [host],
    spotlight: null,
    screen: null
  })
  room.shown.onStage.push('g_departed')
  expect(managedProgramStageInput(room).people).toEqual([host])
  room.shown = { onStage: [] }
  expect(managedProgramStageInput(room).people).toEqual([])
  expect(managedProgramStageInput(undefined).people).toEqual([])
})

// Plan 249 S6: the preview draws the layout the page reports, and agents
// get the program by role and geometry only.
describe('the program preview (plan 249 S6)', () => {
  const managedOf = (room: Room) => talkStatus({ show: show(MANAGED_NODE_ID), room })
  const now = Date.parse('2026-11-16T12:00:30Z')

  it('draws the layout the page drew, and ignores a layout it does not know', () => {
    const room = openRoom({
      stage: { layout: 'spotlight', onStage: [HOST] },
      shown: { onStage: [HOST], layout: 'solo' }
    })
    expect(shownLayout(room)).toBe('solo')
    expect(managedProgramStageInput(room).layout).toBe('solo')
    const unknown = openRoom({
      stage: { layout: 'spotlight', onStage: [HOST] },
      shown: { onStage: [HOST], layout: 'carousel' }
    })
    expect(shownLayout(unknown)).toBeNull()
    expect(managedProgramStageInput(unknown).layout).toBe('spotlight')
  })

  it('draws both screens the page reports for a two-screens stage (plan 251)', () => {
    const base = openRoom()
    const room = openRoom({
      participants: [...(base.participants ?? []), guestParticipant(ada, { onStage: true })],
      stage: {
        layout: 'screen-people',
        onStage: [HOST, 'g_ada'],
        screen: 'g_ada',
        screens: ['g_ada', HOST]
      },
      shown: {
        onStage: [HOST, 'g_ada'],
        layout: 'two-screens',
        screen: 'g_ada',
        screens: ['g_ada', HOST]
      }
    })
    expect(shownLayout(room)).toBe('screen-people')
    const input = managedProgramStageInput(room)
    expect(input.layout).toBe('screen-people')
    expect(input.screens).toEqual(['g_ada', HOST])
    expect(effectiveStageLayout(input)).toBe('two-screens')
  })

  it('confirms only the stage this desktop sent', () => {
    const room = openRoom({ live: true })
    const key = stageKey(room.stage)
    const applied = managedProgramPreview(
      managedOf({ ...room, shown: { onStage: [HOST], stageKey: key, at: '2026-11-16T12:00:28Z' } }),
      now
    )
    expect(applied.state).toBe('applied')
    expect(applied.encodedOutput).toBe(false)
    expect(managedProgramPreview(managedOf(openRoom()), now).state).toBe('empty')
  })

  it('gives agents roles and normalized geometry, never identities', () => {
    const room = openRoom({ live: true, shown: { onStage: [HOST] } })
    const program = agentRoomProgram(managedOf(room), HOST, { width: 1920, height: 1080 }, now)
    expect(program).toEqual({
      source: 'program-page-report',
      encodedOutput: false,
      stage: 'unconfirmed',
      ageSeconds: null,
      layout: 'solo',
      screenShared: false,
      tiles: [{ kind: 'person', role: 'host', rect: { x: 0, y: 0, w: 1, h: 1 } }]
    })
    // A node show has its own return: no projection is made up for it.
    expect(
      agentRoomProgram(
        talkStatus({ show: show('eu-hel-1'), room }),
        HOST,
        { width: 1920, height: 1080 },
        now
      )
    ).toBeUndefined()
  })
})

describe('guest graphics line (plan 249 S6, D4)', () => {
  it('says off, recording only, waiting, all or some confirmed', async () => {
    const { guestGraphicsLine } = await import('./talk-show-managed')
    expect(guestGraphicsLine(undefined, 'stream')).toBe("Guests don't see the avatar")
    expect(guestGraphicsLine({ enabled: false, capable: 2, applied: 2 }, 'stream')).toBe(
      "Guests don't see the avatar"
    )
    expect(guestGraphicsLine({ enabled: true, capable: 2, applied: 0 }, 'recording')).toBe(
      'Recording only · Guests see nothing'
    )
    expect(guestGraphicsLine({ enabled: true, capable: 0, applied: 0 }, 'stream')).toBe(
      'Shown to guests · No guest page confirmed'
    )
    expect(guestGraphicsLine({ enabled: true, capable: 2, applied: 2 }, 'stream')).toBe(
      'Guests see the avatar'
    )
    expect(guestGraphicsLine({ enabled: true, capable: 3, applied: 1 }, null)).toBe(
      'Shown to guests · 1 of 3 confirmed'
    )
  })
})
