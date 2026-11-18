import type { CloudStatus, CloudTestOutput, StreamingSettings } from '@/lib/backend'
import { coerceVideoToOrientation, streamOutputVideoForTarget, type CaptureConfig } from './capture'
import {
  managedDestinationProblem,
  managedOutputProblem,
  managedOutputProfile,
  managedProfileDescription
} from '../../../shared/cloud-output-profile'

/**
 * Plan 249 S17: the outputs a room opens with, decided before it is created.
 * A room's outputs are fixed at creation, so they come from everything the
 * show may use: one per orientation of the enabled destinations (at the
 * highest profile any of them asks for), and the canvas's orientation when
 * the show records or has no destination yet.
 */
export type TalkShowOutputPlan = {
  outputs: CloudTestOutput[]
  /** Why the room can't open with these settings, or null. */
  problem: string | null
  /** What viewers will get, or the problem, in words. */
  description: string
}

export function talkShowOutputPlan(config: CaptureConfig): TalkShowOutputPlan {
  const outputs: CloudTestOutput[] = []
  const add = (orientation: 'horizontal' | 'vertical', source: CaptureConfig['video']) => {
    const video = coerceVideoToOrientation(source, orientation)
    const previous = outputs.find((o) => o.orientation === orientation)
    if (!previous)
      outputs.push({
        orientation,
        width: video.width,
        height: video.height,
        fps: video.fps,
        videoKbps: video.bitrateKbps
      })
    else {
      previous.width = Math.max(previous.width, video.width)
      previous.height = Math.max(previous.height, video.height)
      previous.fps = Math.max(previous.fps, video.fps)
      previous.videoKbps = Math.max(previous.videoKbps, video.bitrateKbps)
    }
  }
  const refused = (problem: string): TalkShowOutputPlan => ({
    outputs,
    problem,
    description: problem
  })
  const enabledIds = config.streaming?.enabledTargetIds ?? []
  for (const target of (config.streaming?.targets ?? []).filter(
    (t) => t.enabled && enabledIds.includes(t.id)
  )) {
    const orientation = target.outputOrientation ?? 'horizontal'
    const problem = managedDestinationProblem(
      { label: target.label, orientation, url: target.serverUrl },
      [{ orientation }]
    )
    if (problem) return refused(problem)
    add(
      orientation,
      streamOutputVideoForTarget(config.video, { ...config.streaming, enabled: true }, target)
    )
  }
  if (config.recordEnabled || outputs.length === 0)
    add(config.video.height > config.video.width ? 'vertical' : 'horizontal', config.video)
  outputs.sort((a, b) =>
    a.orientation === b.orientation ? 0 : a.orientation === 'horizontal' ? -1 : 1
  )
  const problem = managedOutputProblem(outputs)
  if (problem) return refused(problem)
  return {
    outputs,
    problem: null,
    description: managedProfileDescription(managedOutputProfile(outputs))
  }
}

/**
 * Before anything is prepared on a platform (metadata, a YouTube broadcast)
 * in an open room: every destination this start uses must fit the outputs
 * the room opened with.
 */
export function talkShowOutputStartProblem(
  config: CaptureConfig,
  status: CloudStatus | null,
  intent: { record: boolean; stream: boolean },
  streaming: StreamingSettings = config.streaming
): string | null {
  const profile = status?.show?.outputProfile
  // A node show, or a web from before S17, reports no profile: its own
  // destination check still runs, and nothing here is guessed.
  if (!profile || profile.version !== 1 || !intent.stream) return null
  const enabledIds = streaming?.enabledTargetIds ?? []
  for (const target of (streaming?.targets ?? []).filter(
    (t) => t.enabled && enabledIds.includes(t.id)
  )) {
    const problem = managedDestinationProblem(
      {
        label: target.label,
        orientation: target.outputOrientation ?? 'horizontal',
        url: target.serverUrl
      },
      profile.effective
    )
    if (problem) return problem
  }
  return null
}
