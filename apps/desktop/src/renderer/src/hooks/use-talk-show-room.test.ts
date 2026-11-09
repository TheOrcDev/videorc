import { describe, expect, it } from 'vitest'

import type { CloudStage } from '@/lib/backend'
import { NO_TALK_SHOW, stageWith } from '@/hooks/use-talk-show-room'

const HOST = 'host:sh_talk'

// Plan 224 C-G4: Bring on and Send backstage edit the whole stage (D8); the
// host leads the list so Solo and Spotlight default to them, and a person
// who leaves the stage takes their spotlight and screen with them.
describe('stageWith', () => {
  it('brings a guest on after the host and sends them backstage again', () => {
    const empty: CloudStage = { layout: 'solo', onStage: [] }
    const hostOn = stageWith(empty, HOST, true, HOST)
    expect(hostOn.onStage).toEqual([HOST])
    const guestOn = stageWith(hostOn, 'g_ada', true, HOST)
    expect(guestOn.onStage).toEqual([HOST, 'g_ada'])
    // A second Bring on of the same person changes nothing.
    expect(stageWith(guestOn, 'g_ada', true, HOST).onStage).toEqual([HOST, 'g_ada'])
    expect(stageWith(guestOn, 'g_ada', false, HOST).onStage).toEqual([HOST])
  })

  it('keeps the host first whatever order they were added in', () => {
    const guestFirst = stageWith({ layout: 'side-by-side', onStage: ['g_ada'] }, HOST, true, HOST)
    expect(guestFirst.onStage).toEqual([HOST, 'g_ada'])
  })

  it('never drops the host: a Bring on into an empty stage names them, and backstage is refused', () => {
    // The runner composes only who the stage names (D8): a stage of one
    // guest would take the host's camera and mic out of the program.
    const empty: CloudStage = { layout: 'solo', onStage: [] }
    expect(stageWith(empty, 'g_ada', true, HOST).onStage).toEqual([HOST, 'g_ada'])
    const guestOnly: CloudStage = { layout: 'side-by-side', onStage: ['g_ada'] }
    expect(stageWith(guestOnly, 'g_bo', true, HOST).onStage).toEqual([HOST, 'g_ada', 'g_bo'])
    expect(stageWith({ layout: 'solo', onStage: [HOST] }, HOST, false, HOST).onStage).toEqual([
      HOST
    ])
    // Without a host identity (the room is not joined) nothing is invented.
    expect(stageWith(empty, 'g_ada', true, null).onStage).toEqual(['g_ada'])
  })

  it('drops the spotlight and the screen of a person sent backstage', () => {
    const stage: CloudStage = {
      layout: 'screen-people',
      onStage: [HOST, 'g_ada'],
      spotlight: 'g_ada',
      screen: 'g_ada'
    }
    const after = stageWith(stage, 'g_ada', false, HOST)
    expect(after.onStage).toEqual([HOST])
    expect(after.spotlight).toBeUndefined()
    expect(after.screen).toBeUndefined()
    expect(after.layout).toBe('screen-people')
  })

  it('is inert outside a provider', async () => {
    expect(NO_TALK_SHOW.room.state).toBe('idle')
    expect(NO_TALK_SHOW.previewReplaced).toBe(false)
    await expect(NO_TALK_SHOW.openRoom({})).resolves.toBeUndefined()
    await expect(NO_TALK_SHOW.listDisplaySources()).resolves.toEqual([])
  })
})
