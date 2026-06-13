import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { validateSupportBundle } from './support-bundle-verifier.mjs'

function validBundle(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-13T18:00:00Z',
    app: {
      version: '0.9.0',
      platform: 'darwin',
      runMode: 'dev'
    },
    health: {
      status: 'ok',
      databasePath: '<redacted:database-path>',
      secretStoreBackend: 'json-file'
    },
    entitlements: {
      tier: 'free'
    },
    recording: {
      state: 'idle',
      outputPath: '<redacted:path:session.mkv>'
    },
    diagnostics: {
      previewTransport: 'native-surface',
      previewSurfaceBacking: 'cametal-layer'
    },
    logs: [
      {
        level: 'info',
        message: 'Backend ready.',
        timestamp: '2026-06-13T18:00:00Z'
      }
    ],
    sessions: [
      {
        id: 'session-1',
        title: 'Test',
        startedAt: '2026-06-13T18:00:00Z',
        endedAt: null,
        status: 'completed',
        mode: 'record',
        outputFile: '<redacted:path:session.mkv>',
        mp4File: '<redacted:path:session.mp4>',
        streamPreset: null,
        container: 'mkv',
        durationMs: 1000,
        healthEvents: [],
        sessionLogs: [],
        aiArtifacts: [
          {
            id: 'artifact-1',
            sessionId: 'session-1',
            kind: 'summary',
            status: 'completed',
            file: '<redacted:path:summary.md>',
            createdAt: '2026-06-13T18:00:00Z'
          }
        ]
      }
    ],
    redactionSummary: {
      secretValues: 1,
      databasePaths: 1,
      mediaPaths: 3,
      homePaths: 0,
      urlCredentials: 1,
      aiArtifactBodies: 1
    },
    ...overrides
  }
}

describe('validateSupportBundle', () => {
  it('accepts a redacted support bundle with required sections', () => {
    const result = validateSupportBundle(validBundle())

    assert.equal(result.ok, true)
    assert.deepEqual(result.failures, [])
  })

  it('requires the support bundle top-level sections', () => {
    const bundle = validBundle()
    delete bundle.sessions

    const result = validateSupportBundle(bundle)

    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /Missing required top-level section: sessions/)
  })

  it('allows secretStoreBackend while rejecting raw secret-shaped values', () => {
    const bundle = validBundle({
      health: {
        databasePath: '<redacted:database-path>',
        secretStoreBackend: 'json-file',
        accessToken: 'sk-real-token-value'
      }
    })

    const result = validateSupportBundle(bundle)

    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /health\.accessToken/)
    assert.doesNotMatch(result.failures.join('\n'), /secretStoreBackend/)
  })

  it('rejects raw database and media paths', () => {
    const bundle = validBundle({
      health: {
        status: 'ok',
        databasePath: '/Users/orcdev/Library/Application Support/Videorc/videorc.sqlite3',
        secretStoreBackend: 'json-file'
      },
      sessions: [
        {
          ...validBundle().sessions[0],
          outputFile: '/Users/orcdev/Movies/Videorc/Recordings/session.mkv'
        }
      ]
    })

    const result = validateSupportBundle(bundle)

    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /health\.databasePath/)
    assert.match(result.failures.join('\n'), /sessions\.0\.outputFile/)
  })

  it('rejects raw RTMP URLs and URL credentials', () => {
    const bundle = validBundle({
      recording: {
        state: 'idle',
        streamUrl: 'rtmp://live.example.test/app/raw-stream-key',
        ingestUrl: 'https://user:pass@example.test/live'
      }
    })

    const result = validateSupportBundle(bundle)

    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /recording\.streamUrl/)
    assert.match(result.failures.join('\n'), /recording\.ingestUrl/)
  })

  it('rejects AI artifact bodies while allowing metadata', () => {
    const session = validBundle().sessions[0]
    const bundle = validBundle({
      sessions: [
        {
          ...session,
          aiArtifacts: [
            {
              ...session.aiArtifacts[0],
              content: 'Full transcript text should not be in a support bundle.'
            }
          ]
        }
      ]
    })

    const result = validateSupportBundle(bundle)

    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /sessions\.0\.aiArtifacts\.0\.content/)
  })
})
