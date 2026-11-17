import { describe, expect, it } from 'vitest'
import type { CloudStatus, StreamTargetSettings } from './backend'
import { defaultCaptureConfig, type CaptureConfig } from './capture'
import { talkShowOutputPlan, talkShowOutputStartProblem } from './talk-show-outputs'
import { managedOutputProfile } from '../../../shared/cloud-output-profile'

const target = (patch: Partial<StreamTargetSettings>): StreamTargetSettings =>
  ({
    id: 'twitch',
    platform: 'twitch',
    label: 'Twitch',
    serverUrl: 'rtmp://live.twitch.tv/app',
    enabled: true,
    ...patch
  }) as StreamTargetSettings
const config = (
  targets: StreamTargetSettings[],
  patch: Partial<CaptureConfig> = {}
): CaptureConfig => {
  const base = structuredClone(defaultCaptureConfig)
  return {
    ...base,
    recordEnabled: false,
    ...patch,
    streaming: {
      ...base.streaming,
      enabled: true,
      targets,
      enabledTargetIds: targets.map((t) => t.id)
    }
  }
}
const status = (orientations: ('horizontal' | 'vertical')[]): CloudStatus =>
  ({
    show: {
      id: 'sh_x',
      nodeId: 'livekit',
      resumable: false,
      kind: 'talk',
      outputProfile: managedOutputProfile(
        orientations.map((orientation) =>
          orientation === 'vertical'
            ? { orientation, width: 1080, height: 1920, fps: 30, videoKbps: 6000 }
            : { orientation, width: 1920, height: 1080, fps: 30, videoKbps: 6000 }
        )
      )
    }
  }) as unknown as CloudStatus

describe('S17 room outputs, decided before the room is created', () => {
  it('a horizontal destination asks for one horizontal output', () => {
    const plan = talkShowOutputPlan(config([target({})]))
    expect(plan.problem).toBeNull()
    expect(plan.outputs.map((o) => o.orientation)).toEqual(['horizontal'])
    expect(plan.description).toMatch(/^Horizontal 1920×1080/)
  })
  it('a vertical destination adds a vertical output, horizontal first', () => {
    const plan = talkShowOutputPlan(
      config([
        target({}),
        target({
          id: 'tiktok',
          platform: 'tiktok',
          label: 'TikTok',
          serverUrl: '',
          outputOrientation: 'vertical'
        })
      ])
    )
    expect(plan.problem).toBeNull()
    expect(plan.outputs.map((o) => o.orientation)).toEqual(['horizontal', 'vertical'])
    expect(plan.outputs[1].height).toBeGreaterThan(plan.outputs[1].width)
    expect(plan.description).toContain('Each orientation is its own cloud output')
  })
  it('a 4K YouTube stream setting is refused before the room exists, with its reason', () => {
    const plan = talkShowOutputPlan(
      config([
        target({
          id: 'yt',
          platform: 'youtube',
          label: 'YouTube',
          serverUrl: 'rtmp://a.rtmp.youtube.com/live2',
          outputPreset: 'stream-youtube-4k30',
          outputBitrateKbps: 20000
        })
      ])
    )
    expect(plan.outputs[0]?.width).toBe(3840)
    expect(plan.problem).toMatch(/4K hasn't been measured/)
    expect(plan.description).toBe(plan.problem)
  })
  it('1080p60 at 8 Mbps opens, saying it sends a 30 fps picture at 6 Mbps', () => {
    const plan = talkShowOutputPlan(
      config([target({ outputPreset: 'stream-1080p60', outputBitrateKbps: 8000 })])
    )
    expect(plan.problem).toBeNull()
    expect(plan.description).toContain('differs from your settings: 30 fps picture, 6 Mbps')
  })
  it('a recording with no destination opens the canvas orientation', () => {
    const plan = talkShowOutputPlan(config([], { recordEnabled: true }))
    expect(plan.outputs).toHaveLength(1)
    expect(plan.problem).toBeNull()
  })
  it('a destination with a non-RTMP address is refused before the room', () => {
    const plan = talkShowOutputPlan(config([target({ serverUrl: 'srt://example.com:9000' })]))
    expect(plan.problem).toMatch(/rtmp:\/\/ or rtmps:\/\//)
  })
})

describe('S17 Go Live preflight in an open room, before any preparation', () => {
  const vertical = target({
    id: 'yt-v',
    platform: 'youtube',
    label: 'YouTube Vertical',
    serverUrl: 'rtmp://a.rtmp.youtube.com/live2',
    outputOrientation: 'vertical'
  })
  it('refuses a vertical destination the room did not open with', () => {
    const problem = talkShowOutputStartProblem(
      config([target({}), vertical]),
      status(['horizontal']),
      { record: false, stream: true }
    )
    expect(problem).toMatch(/YouTube Vertical is vertical, and this room opened without/)
  })
  it('admits it when the room has a vertical output', () => {
    expect(
      talkShowOutputStartProblem(
        config([target({}), vertical]),
        status(['horizontal', 'vertical']),
        { record: false, stream: true }
      )
    ).toBeNull()
  })
  it('a record-only start and a room without a reported profile are never blocked here', () => {
    const cfg = config([vertical])
    expect(
      talkShowOutputStartProblem(cfg, status(['horizontal']), { record: true, stream: false })
    ).toBeNull()
    expect(
      talkShowOutputStartProblem(
        cfg,
        { show: { id: 'sh', nodeId: 'eu', resumable: false } } as CloudStatus,
        {
          record: false,
          stream: true
        }
      )
    ).toBeNull()
  })
})
