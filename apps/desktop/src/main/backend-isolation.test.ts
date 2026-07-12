import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { backendIsolationEnv } from './backend-isolation'

describe('backendIsolationEnv', () => {
  it('adds nothing for a normal (non-isolated) launch', () => {
    expect(backendIsolationEnv({})).toEqual({})
    expect(backendIsolationEnv({ VIDEORC_APP_DATA_DIR: '  ' })).toEqual({})
  })

  it('pins backend sqlite + secrets + recordings inside the isolated app-data dir', () => {
    const appDataDir = '/tmp/smoke/app-data'
    const resolvedAppDataDir = resolve(appDataDir)
    expect(backendIsolationEnv({ VIDEORC_APP_DATA_DIR: '/tmp/smoke/app-data' })).toEqual({
      VIDEORC_DATABASE_PATH: join(resolvedAppDataDir, 'videorc.sqlite3'),
      VIDEORC_SECRETS_PATH: join(resolvedAppDataDir, 'videorc-secrets.json'),
      VIDEORC_RECORDINGS_DIR: join(resolvedAppDataDir, 'recordings')
    })
  })

  it('falls back to the isolated user-data dir when only that is set', () => {
    const userDataDir = '/tmp/probe/user-data'
    const resolvedUserDataDir = resolve(userDataDir)
    expect(backendIsolationEnv({ VIDEORC_USER_DATA_DIR: userDataDir })).toEqual({
      VIDEORC_DATABASE_PATH: join(resolvedUserDataDir, 'videorc.sqlite3'),
      VIDEORC_SECRETS_PATH: join(resolvedUserDataDir, 'videorc-secrets.json'),
      VIDEORC_RECORDINGS_DIR: join(resolvedUserDataDir, 'recordings')
    })
  })

  it('respects explicit backend path overrides inside either isolated root', () => {
    const appDataDir = '/tmp/smoke/app-data'
    const userDataDir = '/tmp/smoke/user-data'
    const resolvedAppDataDir = resolve(appDataDir)
    expect(
      backendIsolationEnv({
        VIDEORC_APP_DATA_DIR: appDataDir,
        VIDEORC_USER_DATA_DIR: userDataDir,
        VIDEORC_DATABASE_PATH: join(userDataDir, 'custom/db.sqlite')
      })
    ).toEqual({
      VIDEORC_SECRETS_PATH: join(resolvedAppDataDir, 'videorc-secrets.json'),
      VIDEORC_RECORDINGS_DIR: join(resolvedAppDataDir, 'recordings')
    })
    expect(
      backendIsolationEnv({
        VIDEORC_APP_DATA_DIR: appDataDir,
        VIDEORC_DATABASE_PATH: join(appDataDir, 'custom/db.sqlite'),
        VIDEORC_SECRETS_PATH: join(appDataDir, 'custom/secrets.json'),
        VIDEORC_RECORDINGS_DIR: join(appDataDir, 'custom/recordings')
      })
    ).toEqual({})
  })

  it('replaces every explicit backend path that escapes the isolated roots', () => {
    const appDataDir = '/tmp/smoke/app-data'
    const resolvedAppDataDir = resolve(appDataDir)
    expect(
      backendIsolationEnv({
        VIDEORC_APP_DATA_DIR: appDataDir,
        VIDEORC_USER_DATA_DIR: '/tmp/smoke/user-data',
        VIDEORC_DATABASE_PATH: '/real/profile/db.sqlite',
        VIDEORC_SECRETS_PATH: '/real/profile/secrets.json',
        VIDEORC_RECORDINGS_DIR: '/real/profile/recordings'
      })
    ).toEqual({
      VIDEORC_DATABASE_PATH: join(resolvedAppDataDir, 'videorc.sqlite3'),
      VIDEORC_SECRETS_PATH: join(resolvedAppDataDir, 'videorc-secrets.json'),
      VIDEORC_RECORDINGS_DIR: join(resolvedAppDataDir, 'recordings')
    })
  })
})
