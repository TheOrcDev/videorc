import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { AiArtifact, AiWorkflowResult } from './backend'
import {
  decidePostStreamPackAutoRun,
  parseAttemptedSessionIds,
  POST_STREAM_PACK_ATTEMPTED_STORAGE_KEY,
  POST_STREAM_PACK_AUTO_STORAGE_KEY,
  postStreamPackAutoFromStorage,
  postStreamPackOutcome,
  postStreamPackOutputs,
  runPostStreamPackOnce,
  TRANSCRIPT_WRITTEN_HEALTH_CODE,
  withAttemptedSessionId,
  type PostStreamPackInput,
  type PostStreamPackRunDeps,
  type PostStreamPackRunInput,
  type PostStreamPackStorage
} from './post-stream-pack'

function input(overrides: Partial<PostStreamPackInput> = {}): PostStreamPackInput {
  return {
    event: { sessionId: 'session-1', state: 'finalized', mp4Path: '/rec/session-1.mp4' },
    session: { mode: 'record+stream', aiArtifactCount: 0 },
    transcriptWritten: true,
    orcleListened: true,
    consent: true,
    autoEnabled: true,
    attempted: false,
    running: false,
    readiness: { state: 'ready', description: 'Cloud AI ready.' },
    ...overrides
  }
}

function artifact(overrides: Partial<AiArtifact>): AiArtifact {
  return {
    id: 'artifact',
    sessionId: 'session-1',
    kind: 'title-description',
    status: 'ready',
    content: {},
    createdAt: '2026-09-27T00:00:00Z',
    ...overrides
  }
}

function result(artifacts: AiArtifact[]): AiWorkflowResult {
  return { sessionId: 'session-1', audioPath: '', artifacts }
}

describe('decidePostStreamPackAutoRun', () => {
  it('runs for a finalized, streamed and recorded session with a transcript and consent', () => {
    expect(decidePostStreamPackAutoRun(input())).toEqual({ kind: 'run' })
    // Stream-only-by-name modes still count as streamed.
    expect(
      decidePostStreamPackAutoRun(input({ session: { mode: 'stream', aiArtifactCount: 0 } }))
    ).toEqual({ kind: 'run' })
    // The row may carry the file when the event does not.
    expect(
      decidePostStreamPackAutoRun(
        input({
          event: { sessionId: 'session-1', state: 'finalized' },
          session: { mode: 'record+stream', aiArtifactCount: 0, outputPath: '/rec/s.mkv' }
        })
      )
    ).toEqual({ kind: 'run' })
    // Readiness still loading: the backend validates capabilities itself.
    expect(
      decidePostStreamPackAutoRun(
        input({ readiness: { state: 'checking', description: 'Checking.' } })
      )
    ).toEqual({ kind: 'run' })
  })

  it.each([
    ['not-finalized', { event: { sessionId: 'session-1', state: 'finalizing' as const } }],
    ['setting-off', { autoEnabled: false }],
    ['no-consent', { consent: false }],
    ['already-attempted', { attempted: true }],
    ['unknown-session', { session: null }],
    ['not-streamed', { session: { mode: 'record', aiArtifactCount: 0 } }],
    [
      'no-recording',
      {
        event: { sessionId: 'session-1', state: 'finalized' as const },
        session: { mode: 'record+stream', aiArtifactCount: 0 }
      }
    ],
    // A captions-only stream: an SRT exists, but Orcle never listened.
    ['orcle-not-listening', { orcleListened: false }],
    ['no-transcript', { transcriptWritten: false }],
    ['already-has-artifacts', { session: { mode: 'record+stream', aiArtifactCount: 3 } }],
    ['already-has-artifacts', { running: true }],
    [
      'cloud-unavailable',
      { readiness: { state: 'premium-required' as const, description: 'Upgrade.' } }
    ],
    ['cloud-unavailable', { readiness: { state: 'signed-out' as const, description: 'Sign in.' } }]
  ] satisfies [string, Partial<PostStreamPackInput>][])(
    'skips quietly: %s',
    (reason, overrides) => {
      expect(decidePostStreamPackAutoRun(input(overrides))).toEqual({ kind: 'skip', reason })
    }
  )

  it('reports a quota or server block once instead of running', () => {
    expect(
      decidePostStreamPackAutoRun(
        input({ readiness: { state: 'quota-exhausted', description: 'Daily AI limit reached.' } })
      )
    ).toEqual({ kind: 'blocked', reason: 'Daily AI limit reached.' })
    expect(
      decidePostStreamPackAutoRun(
        input({
          attempted: true,
          readiness: { state: 'quota-exhausted', description: 'Daily AI limit reached.' }
        })
      )
    ).toEqual({ kind: 'skip', reason: 'already-attempted' })
  })
})

describe('post-stream pack storage', () => {
  it('follows Orcle listening by default and an explicit choice wins', () => {
    expect(postStreamPackAutoFromStorage(null, true)).toBe(true)
    expect(postStreamPackAutoFromStorage(null, false)).toBe(false)
    expect(postStreamPackAutoFromStorage('garbage', true)).toBe(true)
    expect(postStreamPackAutoFromStorage('garbage', false)).toBe(false)
    expect(postStreamPackAutoFromStorage('1', false)).toBe(true)
    expect(postStreamPackAutoFromStorage('0', true)).toBe(false)
  })

  it('parses the attempted list defensively and keeps it bounded', () => {
    expect(parseAttemptedSessionIds(null)).toEqual([])
    expect(parseAttemptedSessionIds('not json')).toEqual([])
    expect(parseAttemptedSessionIds('{"a":1}')).toEqual([])
    expect(parseAttemptedSessionIds('["a", 2, "", "b"]')).toEqual(['a', 'b'])
    expect(withAttemptedSessionId(['a', 'b'], 'a')).toEqual(['b', 'a'])
    const many = Array.from({ length: 60 }, (_, index) => `s-${index}`)
    const bounded = withAttemptedSessionId(many, 'new')
    expect(bounded).toHaveLength(50)
    expect(bounded.at(-1)).toBe('new')
    expect(bounded[0]).toBe('s-11')
  })
})

describe('post-stream pack wiring', () => {
  it('asks for social posts only when the server offers them', () => {
    expect(postStreamPackOutputs(true)).toEqual(['publish_pack', 'social_posts'])
    expect(postStreamPackOutputs(false)).toEqual(['publish_pack'])
    expect(postStreamPackOutputs(undefined)).toEqual(['publish_pack'])
  })

  it('is no longer wired into the studio: the auto-run went with Publish (plan 119 S2)', () => {
    // Its switch left with Publish, so the studio must not run the pack on
    // its own. Plan 119 S4 deletes this module and this test.
    const root = join(__dirname, '..', '..', '..', '..', '..', '..')
    const studio = readFileSync(
      join(root, 'apps/desktop/src/renderer/src/hooks/use-studio.tsx'),
      'utf8'
    )
    expect(studio).not.toContain("import('@/lib/post-stream-pack')")
    expect(studio).not.toContain(`event.code === '${TRANSCRIPT_WRITTEN_HEALTH_CODE}'`)
    expect(studio).not.toContain('autoRunPostStreamPack')
  })
})

describe('postStreamPackOutcome', () => {
  it('is ready when the pack came back', () => {
    expect(
      postStreamPackOutcome(
        result([
          artifact({ kind: 'transcript' }),
          artifact({ kind: 'title-description' }),
          artifact({ kind: 'social-posts' })
        ])
      )
    ).toEqual({ ok: true })
  })

  it('carries the failed artifact reason (the workflow resolves on cloud failure)', () => {
    expect(
      postStreamPackOutcome(
        result([
          artifact({ kind: 'transcript' }),
          artifact({
            kind: 'title-description',
            status: 'failed',
            content: { message: 'Daily AI job limit reached.' }
          })
        ])
      )
    ).toEqual({ ok: false, reason: 'Daily AI job limit reached.' })
    expect(postStreamPackOutcome(result([artifact({ kind: 'transcript' })]))).toEqual({
      ok: false,
      reason: 'Cloud AI returned nothing for this recording.'
    })
  })
})

class MemoryStorage implements PostStreamPackStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function runInput(sessionId: string): PostStreamPackRunInput {
  const base = input({ event: { sessionId, state: 'finalized', mp4Path: `/rec/${sessionId}.mp4` } })
  return {
    event: base.event,
    session: base.session,
    transcriptWritten: base.transcriptWritten,
    orcleListened: base.orcleListened,
    listenOn: true,
    consent: base.consent,
    running: base.running,
    readiness: base.readiness
  }
}

function fakeDeps(
  storage: PostStreamPackStorage | null,
  workflow: () => Promise<AiWorkflowResult>
) {
  const runWorkflow = vi.fn((_sessionId: string) => workflow())
  const deps = {
    storage,
    runWorkflow,
    onStart: vi.fn(),
    onSettled: vi.fn(),
    onReady: vi.fn(),
    onFailed: vi.fn()
  } satisfies PostStreamPackRunDeps
  return deps
}

describe('runPostStreamPackOnce', () => {
  it('makes exactly one workflow call per session, even for repeated finalized events', async () => {
    const storage = new MemoryStorage()
    const deps = fakeDeps(storage, async () =>
      result([artifact({ kind: 'title-description' }), artifact({ kind: 'social-posts' })])
    )

    const [first, second] = await Promise.all([
      runPostStreamPackOnce(runInput('once-a'), deps),
      runPostStreamPackOnce(runInput('once-a'), deps)
    ])
    const third = await runPostStreamPackOnce(runInput('once-a'), deps)

    expect(first).toEqual({ kind: 'run' })
    expect(second).toEqual({ kind: 'skip', reason: 'already-attempted' })
    expect(third).toEqual({ kind: 'skip', reason: 'already-attempted' })
    expect(deps.runWorkflow).toHaveBeenCalledTimes(1)
    expect(deps.runWorkflow).toHaveBeenCalledWith('once-a')
    expect(deps.onStart).toHaveBeenCalledWith('once-a')
    expect(deps.onReady).toHaveBeenCalledWith('once-a')
    expect(deps.onSettled).toHaveBeenCalledWith('once-a')
    expect(deps.onFailed).not.toHaveBeenCalled()
    expect(
      parseAttemptedSessionIds(storage.getItem(POST_STREAM_PACK_ATTEMPTED_STORAGE_KEY))
    ).toEqual(['once-a'])

    // A different session still gets its own single run.
    await runPostStreamPackOnce(runInput('once-b'), deps)
    expect(deps.runWorkflow).toHaveBeenCalledTimes(2)
  })

  it('never retries a failed run and says why, quietly', async () => {
    const storage = new MemoryStorage()
    const deps = fakeDeps(storage, async () => {
      throw new Error('Backend WebSocket is not connected.')
    })

    await runPostStreamPackOnce(runInput('fails-a'), deps)
    await runPostStreamPackOnce(runInput('fails-a'), deps)

    expect(deps.runWorkflow).toHaveBeenCalledTimes(1)
    expect(deps.onFailed).toHaveBeenCalledTimes(1)
    expect(deps.onFailed).toHaveBeenCalledWith('fails-a', 'Backend WebSocket is not connected.')
    expect(deps.onReady).not.toHaveBeenCalled()
    expect(deps.onSettled).toHaveBeenCalledTimes(1)
  })

  it('reports a cloud failure carried in the result as a failure', async () => {
    const deps = fakeDeps(new MemoryStorage(), async () =>
      result([
        artifact({ kind: 'transcript' }),
        artifact({
          kind: 'title-description',
          status: 'failed',
          content: { message: 'Cloud AI requires Videorc Premium.' }
        })
      ])
    )

    await runPostStreamPackOnce(runInput('cloud-fails'), deps)

    expect(deps.onFailed).toHaveBeenCalledWith('cloud-fails', 'Cloud AI requires Videorc Premium.')
    expect(deps.onReady).not.toHaveBeenCalled()
  })

  it('honours the stored preference and remembers nothing for a skip', async () => {
    const storage = new MemoryStorage()
    storage.setItem(POST_STREAM_PACK_AUTO_STORAGE_KEY, '0')
    const deps = fakeDeps(storage, async () => result([artifact({})]))

    expect(await runPostStreamPackOnce(runInput('pref-off'), deps)).toEqual({
      kind: 'skip',
      reason: 'setting-off'
    })
    expect(deps.runWorkflow).not.toHaveBeenCalled()
    expect(storage.getItem(POST_STREAM_PACK_ATTEMPTED_STORAGE_KEY)).toBeNull()
  })

  it('without a choice in Publish, runs only while Orcle listening is on', async () => {
    const storage = new MemoryStorage()
    const deps = fakeDeps(storage, async () => result([artifact({})]))

    expect(
      await runPostStreamPackOnce({ ...runInput('listen-off'), listenOn: false }, deps)
    ).toEqual({ kind: 'skip', reason: 'setting-off' })
    expect(deps.runWorkflow).not.toHaveBeenCalled()

    // An explicit on in Publish wins over listening being off.
    storage.setItem(POST_STREAM_PACK_AUTO_STORAGE_KEY, '1')
    expect(
      await runPostStreamPackOnce({ ...runInput('listen-off'), listenOn: false }, deps)
    ).toEqual({ kind: 'run' })
    expect(deps.runWorkflow).toHaveBeenCalledTimes(1)
  })

  it('never runs for a stream Orcle did not listen to, even with captions', async () => {
    const storage = new MemoryStorage()
    const deps = fakeDeps(storage, async () => result([artifact({})]))

    expect(
      await runPostStreamPackOnce({ ...runInput('captions-only'), orcleListened: false }, deps)
    ).toEqual({ kind: 'skip', reason: 'orcle-not-listening' })
    expect(deps.runWorkflow).not.toHaveBeenCalled()
    expect(storage.getItem(POST_STREAM_PACK_ATTEMPTED_STORAGE_KEY)).toBeNull()
  })

  it('tells a quota block once without calling the workflow', async () => {
    const deps = fakeDeps(new MemoryStorage(), async () => result([artifact({})]))
    const blocked = {
      ...runInput('quota'),
      readiness: { state: 'quota-exhausted' as const, description: 'Daily AI limit reached.' }
    }

    await runPostStreamPackOnce(blocked, deps)
    await runPostStreamPackOnce(blocked, deps)

    expect(deps.runWorkflow).not.toHaveBeenCalled()
    expect(deps.onFailed).toHaveBeenCalledTimes(1)
    expect(deps.onFailed).toHaveBeenCalledWith('quota', 'Daily AI limit reached.')
  })

  it('still runs once when storage is unavailable', async () => {
    const throwing: PostStreamPackStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    }
    const deps = fakeDeps(throwing, async () => result([artifact({})]))

    await runPostStreamPackOnce(runInput('no-storage'), deps)
    await runPostStreamPackOnce(runInput('no-storage'), deps)

    expect(deps.runWorkflow).toHaveBeenCalledTimes(1)
    expect(deps.onReady).toHaveBeenCalledTimes(1)
  })
})
