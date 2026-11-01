import { describe, expect, it } from 'vitest'

import type { StreamTargetSettings } from './backend'
import { isStreamTargetReady, streamServerUrlIssue } from './capture'
import { destinationSetup, destinationSetupHint } from './destination-readiness'

// Plan 174 S3.5a (D-19): a server URL is checked as it is typed, with the
// backend's own rule (rtmp:// or rtmps:// and a server name), not at Go Live.

function keyTarget(patch: Partial<StreamTargetSettings> = {}): StreamTargetSettings {
  return {
    id: 'custom',
    platform: 'custom',
    label: 'Custom RTMP',
    enabled: true,
    serverUrl: 'rtmp://live.example.com/app',
    streamKey: 'abc123',
    streamKeyPresent: false,
    authMode: 'manual-rtmp',
    ...patch
  } as StreamTargetSettings
}

describe('streamServerUrlIssue', () => {
  it('accepts rtmp and rtmps URLs with a server name, and an empty field', () => {
    expect(streamServerUrlIssue('')).toBeNull()
    expect(streamServerUrlIssue('   ')).toBeNull()
    expect(streamServerUrlIssue('rtmp://live.twitch.tv/app')).toBeNull()
    expect(streamServerUrlIssue('RTMPS://a.example:443/app')).toBeNull()
  })

  it('names the scheme rule, and the missing server name', () => {
    expect(streamServerUrlIssue('https://live.example.com/app')).toBe(
      'Server URLs start with rtmp:// or rtmps://.'
    )
    expect(streamServerUrlIssue('live.example.com/app', true)).toBe(
      'Full URLs start with rtmp:// or rtmps://.'
    )
    expect(streamServerUrlIssue('rtmp://')).toBe(
      'Add the server name after rtmp://, as your platform shows it.'
    )
  })
})

describe('destinationSetup with a server URL', () => {
  it('is not ready with a bad server URL, and says to fix it', () => {
    const bad = keyTarget({ serverUrl: 'http://live.example.com/app' })
    expect(isStreamTargetReady(bad)).toBe(false)
    expect(destinationSetup(bad, undefined)).toEqual({ ready: false, reason: 'server-url' })
    expect(destinationSetupHint(destinationSetup(bad, undefined))).toBe('fix the server URL')
  })

  it('is not ready with a key but no server URL, and says to add the server', () => {
    // X, TikTok and Custom start with an empty server URL; a pasted key alone
    // used to read as "add a stream key".
    const noServer = keyTarget({ serverUrl: '   ' })
    expect(isStreamTargetReady(noServer)).toBe(false)
    expect(destinationSetup(noServer, undefined)).toEqual({
      ready: false,
      reason: 'server-url-missing'
    })
    expect(destinationSetupHint(destinationSetup(noServer, undefined))).toBe('add the server URL')
  })

  it('is ready with a good URL and a key, and never checks a full URL it cannot read', () => {
    expect(destinationSetup(keyTarget(), undefined)).toEqual({ ready: true })
    const fullUrl = keyTarget({ urlMode: 'full-url', serverUrl: '', streamKeyPresent: true })
    expect(destinationSetup(fullUrl, undefined)).toEqual({ ready: true })
  })
})
