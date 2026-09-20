import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  isUpdateTransportFailure,
  MIRROR_UPDATE_FEED_URL,
  PRIMARY_UPDATE_FEED_URL,
  shouldRetryUpdateOnMirror
} from './updater-mirror'

describe('update feed routes', () => {
  it('keeps the primary route identical to the feed baked into packaged builds', () => {
    const builderConfig = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'electron-builder.yml'),
      'utf8'
    )
    expect(builderConfig).toContain(`url: ${PRIMARY_UPDATE_FEED_URL}`)
    expect(MIRROR_UPDATE_FEED_URL).toBe(`${PRIMARY_UPDATE_FEED_URL}mirror/`)
  })
})

describe('isUpdateTransportFailure', () => {
  it.each([
    'net::ERR_CERT_AUTHORITY_INVALID',
    'net::ERR_CONNECTION_RESET',
    'net::ERR_TIMED_OUT',
    'Error: read ECONNRESET',
    'getaddrinfo ENOTFOUND e934.r2.cloudflarestorage.com',
    'self signed certificate in certificate chain',
    'socket hang up',
    'Request timed out',
    'HttpError: 403 Forbidden',
    'Cannot download "https://…/Videorc-0.9.97-mac-arm64.zip", status code 503'
  ])('retries %s', (message) => {
    expect(isUpdateTransportFailure(message)).toBe(true)
  })

  it.each([
    'Cannot find channel "latest-mac.yml" update info: HttpError: 404 Not Found',
    'sha512 checksum mismatch, expected abc, got def',
    'Could not get code signature for running application',
    'New version 0.9.98 is not signed by the application owner',
    'HttpError: 404 Not Found',
    'ENOSPC: no space left on device',
    'Update download cancelled',
    'Something else entirely'
  ])('does not retry %s', (message) => {
    expect(isUpdateTransportFailure(message)).toBe(false)
  })
})

describe('shouldRetryUpdateOnMirror', () => {
  const message = 'net::ERR_CERT_AUTHORITY_INVALID'

  it('retries a primary transport failure exactly once', () => {
    expect(shouldRetryUpdateOnMirror({ message, pilot: false, route: 'primary' })).toBe(true)
    expect(shouldRetryUpdateOnMirror({ message, pilot: false, route: 'mirror' })).toBe(false)
  })

  it('never moves the pilot bearer off the branded proxy', () => {
    expect(shouldRetryUpdateOnMirror({ message, pilot: true, route: 'primary' })).toBe(false)
  })

  it('never retries an integrity failure', () => {
    expect(
      shouldRetryUpdateOnMirror({
        message: 'sha512 checksum mismatch',
        pilot: false,
        route: 'primary'
      })
    ).toBe(false)
  })
})
