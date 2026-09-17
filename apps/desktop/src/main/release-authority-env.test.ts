import { describe, expect, it } from 'vitest'

import {
  sanitizedChildProcessEnvironment,
  scrubReleaseAuthorityEnvironment
} from './release-authority-env'

describe('release authority environment scrubbing', () => {
  it('removes signing, storage, and pilot bearer authority from child processes', () => {
    expect(
      sanitizedChildProcessEnvironment({
        AZURE_CLIENT_SECRET: 'secret',
        VIDEORC_RELEASE_UPLOAD_S3_SECRET_ACCESS_KEY: 'secret',
        VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN: 'secret',
        VIDEORC_RELEASE_ID: '0.9.45-alpha.1',
        PATH: 'safe'
      })
    ).toEqual({ VIDEORC_RELEASE_ID: '0.9.45-alpha.1', PATH: 'safe' })
  })

  it('can preserve the pilot token only until the updater copies it', () => {
    const env = {
      AZURE_CLIENT_SECRET: 'secret',
      VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN: 'pilot',
      PATH: 'safe'
    }
    scrubReleaseAuthorityEnvironment(env, { preservePilotToken: true })
    expect(env).toEqual({ VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN: 'pilot', PATH: 'safe' })
  })
})
