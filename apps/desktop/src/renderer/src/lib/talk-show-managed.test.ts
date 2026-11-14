import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { CloudStatus } from '@/lib/backend'
import { openRoom, talkStatus } from '@/lib/guests-room-fixtures'
import { MANAGED_NODE_ID, isManagedShow, programMonitorView } from '@/lib/talk-show-managed'

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
