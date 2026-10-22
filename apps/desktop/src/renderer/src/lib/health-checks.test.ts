import { describe, expect, it } from 'vitest'

import type { DiagnosticStats, StreamTargetRuntime } from '@/lib/backend'

import {
  RECORDING_AT_RISK_ADVICE,
  checkNeedsAttention,
  destinationsCheck,
  encoderCheck,
  fileRepairCheck,
  healthVerdict,
  logLevelLabel,
  logTruncationNote,
  memoryCheck,
  permissionWarnings,
  pipelineStageLabel,
  pipelineStateWords,
  previewCheck,
  previewPathCheck,
  previewSourceCheck,
  slowdownAdvice,
  slowdownCheck,
  type HealthCheck
} from './health-checks'

// Plan 174 S3.18 (I-4, I-25, V-7): Health's checks are words with a tone,
// transitional states are neutral, and one verdict leads the page.

const check = (id: HealthCheck['id'], label: string, tone: HealthCheck['tone']): HealthCheck => ({
  id,
  label,
  value: 'Value',
  tone
})

describe('healthVerdict', () => {
  it('says everything looks healthy when nothing is amber or red', () => {
    expect(
      healthVerdict({
        checks: [check('recording', 'Recording', 'good'), check('memory', 'Memory', 'neutral')]
      })
    ).toEqual({ variant: 'success', title: 'Everything looks healthy', description: null })
  })

  it('counts and names what needs attention, warnings first', () => {
    expect(
      healthVerdict({
        checks: [
          check('encoder', 'Encoder', 'warn'),
          check('rendering', 'Rendering', 'good'),
          check('destinations', 'Destinations', 'warn')
        ],
        warnings: ['Camera permission'],
        advice: 'Lower the bitrate.'
      })
    ).toEqual({
      variant: 'warning',
      title: '3 things need attention: Camera permission, Encoder, Destinations',
      description: 'Lower the bitrate.'
    })
  })

  it('agrees in the singular and turns red when a check is red', () => {
    expect(healthVerdict({ checks: [check('recording', 'Recording', 'error')] })).toMatchObject({
      variant: 'destructive',
      title: '1 thing needs attention: Recording'
    })
  })

  it('never lets a neutral, in-passing state count', () => {
    expect(checkNeedsAttention({ tone: 'neutral' })).toBe(false)
    expect(checkNeedsAttention({ tone: 'good' })).toBe(false)
    expect(checkNeedsAttention({ tone: 'warn' })).toBe(true)
    expect(checkNeedsAttention({ tone: 'error' })).toBe(true)
  })
})

describe('Health check words', () => {
  it('names the slowdown in words, measuring as neutral', () => {
    expect(slowdownCheck('audio')).toEqual({ value: 'Microphone', tone: 'warn' })
    expect(slowdownCheck('unknown')).toEqual({ value: 'Measuring…', tone: 'neutral' })
    expect(slowdownCheck('none')).toEqual({ value: 'None found', tone: 'good' })
    expect(slowdownAdvice('none')).toBeNull()
    expect(slowdownAdvice('encoder')).toContain('slower than real time')
    expect(RECORDING_AT_RISK_ADVICE).toContain('Technical details')
  })

  it('says dropped frames with a real plural', () => {
    const stats = { droppedFrames: 12 } as DiagnosticStats
    expect(encoderCheck(stats, null)).toEqual({ value: '12 dropped frames', tone: 'warn' })
    expect(encoderCheck({ droppedFrames: 1 } as DiagnosticStats, null).value).toBe(
      '1 dropped frame'
    )
    expect(encoderCheck({ droppedFrames: 0, encoderSpeed: 1 } as DiagnosticStats, null)).toEqual({
      value: '1.00×',
      tone: 'good'
    })
    expect(encoderCheck({ droppedFrames: 0 } as DiagnosticStats, null)).toEqual({
      value: 'Idle',
      tone: 'neutral'
    })
  })

  it('keeps transitional states neutral, not amber (I-4)', () => {
    expect(fileRepairCheck({ ffmpegMaintenanceRunning: true } as DiagnosticStats)).toEqual({
      value: 'Running',
      tone: 'neutral'
    })
    expect(previewCheck({ state: 'connecting' }, { state: 'live' }, { state: 'live' })).toEqual({
      value: 'Connecting…',
      tone: 'neutral'
    })
    expect(previewCheck({ state: 'unavailable' }, { state: 'live' }, { state: 'live' }).tone).toBe(
      'warn'
    )
    expect(previewSourceCheck('source-missing')).toEqual({ value: 'Not running', tone: 'neutral' })
    expect(previewSourceCheck('permission-needed')).toEqual({
      value: 'Needs permission',
      tone: 'error'
    })
    expect(pipelineStateWords('starting')).toEqual({ value: 'Starting…', tone: 'neutral' })
    expect(pipelineStateWords('finalizing')).toEqual({ value: 'Finishing…', tone: 'neutral' })
    expect(pipelineStateWords('failed')).toEqual({ value: 'Failed', tone: 'error' })
  })

  it('counts destinations in glossary words', () => {
    const target = (state: StreamTargetRuntime['state']): StreamTargetRuntime => ({
      targetId: state,
      platform: 'youtube',
      label: state,
      state
    })
    expect(destinationsCheck([])).toEqual({ value: 'Idle', tone: 'neutral' })
    expect(destinationsCheck([target('live'), target('ready')])).toEqual({
      value: '1 of 2 on air',
      tone: 'good'
    })
    expect(destinationsCheck([target('connecting')])).toEqual({
      value: '1 connecting',
      tone: 'neutral'
    })
    expect(destinationsCheck([target('failed'), target('live')]).tone).toBe('warn')
  })

  it('names the preview path without jargon, and never calls the fallback window native', () => {
    expect(previewPathCheck('native-surface', 'cametal-layer', undefined, 'darwin')).toEqual({
      value: 'Native',
      tone: 'good'
    })
    expect(previewPathCheck('native-surface', 'none', undefined, 'darwin')).toEqual({
      value: 'Native, unconfirmed',
      tone: 'warn'
    })
    expect(
      previewPathCheck('electron-proof-surface', 'electron-browser-window', undefined, 'win32')
    ).toEqual({ value: 'Fallback window', tone: 'warn' })
    expect(previewPathCheck(undefined, undefined)).toEqual({ value: 'Off', tone: 'neutral' })
  })

  it('shows the placeholder for memory it could not read', () => {
    expect(memoryCheck(undefined)).toEqual({ value: '–', tone: 'neutral' })
    expect(memoryCheck(3 * 1024 * 1024 * 1024).tone).toBe('error')
  })

  it('names pipeline stages and log levels in words (V-7)', () => {
    expect(pipelineStageLabel('muxer')).toBe('File writer')
    expect(pipelineStageLabel('video-encoder')).toBe('Video encoder')
    expect(logLevelLabel('info')).toBe('Info')
    expect(logLevelLabel('warn')).toBe('Warning')
    expect(logLevelLabel('error')).toBe('Error')
    expect(logLevelLabel('debug-trace')).toBe('Debug trace')
  })

  it('says when a log was cut, and says nothing when it was not (I-25)', () => {
    expect(logTruncationNote(120, 342)).toBe('Showing the last 120 of 342 lines.')
    expect(logTruncationNote(40, 40)).toBeNull()
  })
})

describe('permissionWarnings', () => {
  it('asks once per permission, skips dismissed events and those with nothing to do', () => {
    const events = [
      { id: 'a', permissionPane: 'camera' as const, createdAt: '2026-10-11T10:00:00Z' },
      { id: 'b', permissionPane: 'camera' as const, createdAt: '2026-10-11T10:05:00Z' },
      { id: 'c', permissionPane: 'microphone' as const, createdAt: '2026-10-11T10:01:00Z' },
      { id: 'd', permissionPane: 'screen-recording' as const, createdAt: '2026-10-11T10:02:00Z' },
      { id: 'e', permissionPane: null, createdAt: '2026-10-11T10:03:00Z' }
    ]
    expect(
      permissionWarnings(events, (pane) => pane !== 'screen-recording', new Set(['c']))
    ).toEqual([{ pane: 'camera', eventIds: ['a', 'b'], createdAt: '2026-10-11T10:05:00Z' }])
  })
})
