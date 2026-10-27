import { describe, expect, it, vi } from 'vitest'

import { AGENT_TOOL_CATALOG, agentTool } from '../../../../shared/agent-tools'
import type { SessionSummary } from '../../../../shared/backend'
import { CAPTURE_HOLD_REASON } from '@/lib/library-view'
import { executeAgentIntent, type AgentIntent } from './agent'
import type { StudioActionContext, StudioLibraryAccess } from './context'
import { LIBRARY_TOOL_COPY } from './library'

// Plan 209 S15: the Library's own delete (to the Trash) and export.

function context(overrides: Partial<StudioActionContext> = {}): StudioActionContext {
  return {
    client: { request: vi.fn(async () => ({ valid: true, issues: [] }) as never) },
    sessionActive: false,
    recordBlockedReason: null,
    liveStreamBlockedReason: null,
    startRecording: vi.fn(async () => true),
    startLivestream: vi.fn(async () => false),
    stopSession: vi.fn(async () => true),
    setMicrophoneMuted: vi.fn(async () => true),
    systemAudio: ['available', false],
    setSystemAudioEnabled: vi.fn(),
    knownLayoutPresets: ['screen-camera'],
    applyLayoutPreset: vi.fn(async () => true),
    hasTakeover: vi.fn(() => false),
    activateTakeover: vi.fn(async () => true),
    clearTakeover: vi.fn(async () => true),
    openWindow: vi.fn(async () => true),
    showCommentHighlight: vi.fn(async () => ({ ok: true })),
    clearCommentHighlight: vi.fn(async () => ({ ok: true })),
    markClip: vi.fn(async () => ({ ok: true })),
    replayOn: false,
    banners: [],
    ...overrides
  }
}

const call = (tool: string, args: Record<string, unknown> = {}): AgentIntent => ({
  intentId: 'ai-1',
  agentId: 'agent-1',
  agentName: 'Claude Desktop',
  tool,
  args
})

// --- S15 delete_recording, export_recording -----------------------------------

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'take-1',
    title: 'MCP episode 1',
    status: 'completed',
    outputPath: '/Users/me/Movies/Videorc/take.mkv',
    ...overrides
  } as SessionSummary
}

function library(overrides: Partial<StudioLibraryAccess> = {}): StudioLibraryAccess {
  return {
    recordings: [session()],
    deleteRecordings: vi.fn(async () => undefined),
    exportMp4: vi.fn(async () => '/Users/me/Movies/Videorc/take.mp4'),
    ...overrides
  }
}

describe('delete_recording and export_recording (plan 209 S15)', () => {
  it('deletes through the Library to the Trash, and holds while a capture runs', async () => {
    const access = library()
    const outcome = await executeAgentIntent(
      call('delete_recording', { recordingId: 'take-1' }),
      context({ library: access })
    )
    expect(access.deleteRecordings).toHaveBeenCalledWith(['take-1'])
    expect(outcome.ok).toBe(true)
    expect(outcome.message).toMatch(/^Moved "MCP episode 1" to the (Trash|Recycle Bin)\./)
    expect(outcome.result).toEqual({ recordingId: 'take-1', trashed: true })
    expect(
      await executeAgentIntent(
        call('delete_recording', { recordingId: 'take-1' }),
        context({ library: library(), sessionActive: true })
      )
    ).toEqual({ ok: false, message: CAPTURE_HOLD_REASON })
    const failing = library({
      deleteRecordings: vi.fn(async () => {
        throw new Error("1 file couldn't be moved to the Trash, so its recording was kept.")
      })
    })
    expect(
      await executeAgentIntent(
        call('delete_recording', { recordingId: 'take-1' }),
        context({ library: failing })
      )
    ).toEqual({
      ok: false,
      message: "1 file couldn't be moved to the Trash, so its recording was kept."
    })
  })

  it('exports the MP4 like the menu, and answers with an MP4 that already exists', async () => {
    const access = library()
    expect(
      await executeAgentIntent(
        call('export_recording', { recordingId: 'take-1' }),
        context({ library: access })
      )
    ).toEqual({
      ok: true,
      message: 'Exported the MP4.',
      result: { recordingId: 'take-1', exported: true, path: '/Users/me/Movies/Videorc/take.mp4' }
    })
    expect(access.exportMp4).toHaveBeenCalledWith('take-1')
    const done = library({ recordings: [session({ mp4Path: '/m/take.mp4' })] })
    expect(
      await executeAgentIntent(
        call('export_recording', { recordingId: 'take-1' }),
        context({ library: done })
      )
    ).toMatchObject({ ok: true, result: { exported: true, path: '/m/take.mp4' } })
    expect(done.exportMp4).not.toHaveBeenCalled()
    const finalizing = library({
      recordings: [session({ finalizationState: 'finalizing' } as Partial<SessionSummary>)]
    })
    expect(
      await executeAgentIntent(
        call('export_recording', { recordingId: 'take-1' }),
        context({ library: finalizing })
      )
    ).toEqual({ ok: false, message: LIBRARY_TOOL_COPY.finalizing })
  })

  it('carries the D11 notice for a delete, and keeps Library tools from Buddy (D15)', () => {
    expect(agentTool('delete_recording')!.onAir).toBe(true)
    for (const name of [
      'rename_recording',
      'delete_recording',
      'export_recording',
      'start_clean_cut',
      'update_settings',
      'get_settings',
      'set_destinations',
      'schedule_stream',
      'get_recording'
    ]) {
      expect(agentTool(name)!.buddy, name).toBe(false)
    }
    for (const name of [
      'send_chat_message',
      'remove_chat_message',
      'buddy_say',
      'set_buddy',
      'update_stream_info'
    ]) {
      expect(agentTool(name)!.buddy, name).toBe(true)
    }
    expect(AGENT_TOOL_CATALOG.tools.length).toBeLessThanOrEqual(45)
  })
})
