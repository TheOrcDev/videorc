import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PROVIDER_CALLBACKS_READY_ENV,
  detectRunContext,
  evaluateProviderReadiness,
  formatProviderReadinessConsole,
  formatProviderReadinessMarkdown
} from './provider-readiness.mjs'

function completeEnv(overrides = {}) {
  return {
    VIDEORC_ENABLE_YOUTUBE_OAUTH: '1',
    VIDEORC_YOUTUBE_CLIENT_ID: 'youtube-client-secret-value',
    VIDEORC_SMOKE_YOUTUBE_CHANNEL_READY: '1',
    VIDEORC_BUNDLED_TWITCH_CLIENT_ID: 'twitch-bundled-client-value',
    VIDEORC_TWITCH_CLIENT_SECRET: 'twitch-secret-value',
    VIDEORC_SMOKE_TWITCH_ACCOUNT_READY: '1',
    VIDEORC_BUNDLED_X_CLIENT_ID: 'x-bundled-client-value',
    VIDEORC_SMOKE_X_LIVESTREAM_OAUTH1_READY: '1',
    VIDEORC_SMOKE_X_NATIVE_LIVE_ACCESS: '1',
    [PROVIDER_CALLBACKS_READY_ENV]: '1',
    ...overrides
  }
}

describe('provider readiness evidence', () => {
  it('passes when provider credentials, account flags, and callbacks are present', () => {
    const result = evaluateProviderReadiness({
      env: completeEnv(),
      generatedAt: '2026-06-13T00:00:00Z',
      commit: 'abc123'
    })

    assert.equal(result.ready, true)
    assert.equal(result.runContext, 'dev')
    assert.deepEqual(result.failures, [])
    assert.equal(
      result.providers.find((provider) => provider.label === 'YouTube').clientId.source,
      'environment'
    )
    assert.equal(result.providers.find((provider) => provider.label === 'YouTube').paused, false)
    assert.equal(
      result.providers.find((provider) => provider.label === 'Twitch').clientId.source,
      'bundled'
    )
  })

  it('reports missing prerequisites by env var name without printing values', () => {
    const result = evaluateProviderReadiness({
      env: {
        VIDEORC_YOUTUBE_CLIENT_ID: 'do-not-print-youtube-client',
        VIDEORC_TWITCH_CLIENT_SECRET: 'do-not-print-twitch-secret'
      },
      generatedAt: '2026-06-13T00:00:00Z',
      commit: 'abc123'
    })
    const markdown = formatProviderReadinessMarkdown(result)
    const consoleReport = formatProviderReadinessConsole(result)

    assert.equal(result.ready, false)
    assert.match(markdown, /VIDEORC_SMOKE_PROVIDER_CALLBACKS_READY=missing/)
    assert.match(markdown, /Paused Provider Paths/)
    assert.match(markdown, /YouTube OAuth is paused/)
    assert.match(markdown, /X Native Live Access/)
    assert.match(consoleReport, /Provider live-smoke readiness is incomplete/)
    assert.doesNotMatch(markdown, /do-not-print-youtube-client/)
    assert.doesNotMatch(markdown, /do-not-print-twitch-secret/)
    assert.doesNotMatch(consoleReport, /do-not-print-youtube-client/)
    assert.doesNotMatch(consoleReport, /do-not-print-twitch-secret/)
  })

  it('records packaged run context from smoke environment', () => {
    assert.equal(
      detectRunContext({ VIDEORC_PACKAGED_APP_EXECUTABLE: '/Applications/Videorc.app' }),
      'packaged'
    )
    assert.equal(detectRunContext({ VIDEORC_SMOKE_PACKAGED_APP: '1' }), 'packaged')
    assert.equal(
      detectRunContext({ VIDEORC_PROVIDER_READINESS_RUN_CONTEXT: 'release-candidate' }),
      'release-candidate'
    )
  })

  it('includes callback URLs and source fields in markdown evidence', () => {
    const result = evaluateProviderReadiness({
      env: completeEnv(),
      generatedAt: '2026-06-13T00:00:00Z',
      commit: 'abc123',
      runContext: 'packaged'
    })
    const markdown = formatProviderReadinessMarkdown(result)

    assert.match(markdown, /Run context: packaged/)
    assert.match(markdown, /http:\/\/127\.0\.0\.1:17995\/oauth\/callback/)
    assert.match(markdown, /Client ID source/)
    assert.match(markdown, /bundled/)
    assert.match(markdown, /VIDEORC_SMOKE_X_LIVESTREAM_OAUTH1_READY=1/)
    assert.match(markdown, /VIDEORC_SMOKE_X_NATIVE_LIVE_ACCESS=1/)
  })
})
