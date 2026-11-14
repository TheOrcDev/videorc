import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { CloudStatus } from '@/lib/backend'
import { openRoom, talkStatus } from '@/lib/guests-room-fixtures'
import { MANAGED_NODE_ID, isManagedShow } from '@/lib/talk-show-managed'

// Plan 234 T3: a show on managed media has no node of ours. The web names
// it by `show.nodeId`, and that is the only thing the renderer goes by.

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
