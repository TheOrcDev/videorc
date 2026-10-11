import { describe, expect, it } from 'vitest'

import type { StreamingSettings } from './backend'
import { defaultCaptureConfig } from './capture'
import { streamingWithoutTargets, updateGoLiveExclusions } from './go-live-exclusions'

function twoDestinations(): StreamingSettings {
  const base = defaultCaptureConfig.streaming
  const [first, second] = base.targets
  return {
    ...base,
    enabled: true,
    mode: 'multi',
    enabledTargetIds: [first!.id, second!.id],
    targets: base.targets.map((target) =>
      target.id === first!.id || target.id === second!.id ? { ...target, enabled: true } : target
    )
  }
}

describe('Go live without a destination (plan 174 S3.4, B-8)', () => {
  it('leaves a destination out of this livestream the way switching it off would', () => {
    const streaming = twoDestinations()
    const [left, kept] = streaming.enabledTargetIds
    const sent = streamingWithoutTargets(streaming, [left!])
    expect(sent.enabledTargetIds).toEqual([kept])
    expect(sent.targets.find((target) => target.id === left)?.enabled).toBe(false)
    expect(sent.targets.find((target) => target.id === kept)?.enabled).toBe(true)
    expect(sent.mode).toBe('single')
    expect(sent.enabled).toBe(true)
  })

  it('never touches the saved settings it was given', () => {
    const streaming = twoDestinations()
    const snapshot = JSON.parse(JSON.stringify(streaming)) as StreamingSettings
    streamingWithoutTargets(streaming, [...streaming.enabledTargetIds])
    expect(streaming).toEqual(snapshot)
  })

  it('is the saved settings themselves when nothing is left out', () => {
    const streaming = twoDestinations()
    expect(streamingWithoutTargets(streaming, [])).toBe(streaming)
  })

  it('says no destination is on when every one is left out', () => {
    const streaming = twoDestinations()
    const sent = streamingWithoutTargets(streaming, streaming.enabledTargetIds)
    expect(sent.enabled).toBe(false)
    expect(sent.enabledTargetIds).toEqual([])
  })

  it('adds and removes a destination from the list once', () => {
    expect(updateGoLiveExclusions([], 'twitch', true)).toEqual(['twitch'])
    const once = ['twitch']
    expect(updateGoLiveExclusions(once, 'twitch', true)).toBe(once)
    expect(updateGoLiveExclusions(once, 'twitch', false)).toEqual([])
    expect(updateGoLiveExclusions(once, 'kick', false)).toBe(once)
  })
})
