import { describe, expect, it } from 'vitest'

import { UPDATE_INSTALL_BLOCKED, updateRowView } from './about-update-view'

describe('updateRowView (plan 174 I-20)', () => {
  it('says that an update installs the next time you quit', () => {
    const idle = updateRowView({ phase: 'idle' }, false)
    expect(idle).toMatchObject({
      kind: 'row',
      control: { kind: 'check', label: 'Check for updates' }
    })
    expect(idle.kind === 'row' && idle.description).toMatch(/next time you quit/)
  })

  it('shows a download as a progress bar with its percentage in words', () => {
    expect(updateRowView({ phase: 'downloading', percent: 41.6, version: '1.2.0' }, false)).toEqual(
      {
        kind: 'row',
        description: 'Downloading version 1.2.0… 42%',
        control: { kind: 'progress', percent: 41.6 }
      }
    )
  })

  it('installs a downloaded update now, or on quit', () => {
    const ready = updateRowView({ phase: 'downloaded', version: '1.2.0' }, false)
    expect(ready).toEqual({
      kind: 'row',
      description:
        'Version 1.2.0 is ready. Restart to install it now, or it installs the next time you quit Videorc.',
      control: { kind: 'install', label: 'Restart & install 1.2.0', disabledReason: null }
    })
  })

  it('waits for a recording or a livestream to finish, and says so', () => {
    const blocked = updateRowView({ phase: 'downloaded', version: '1.2.0' }, true)
    expect(blocked).toMatchObject({
      kind: 'row',
      control: { kind: 'install', disabledReason: UPDATE_INSTALL_BLOCKED }
    })
    expect(UPDATE_INSTALL_BLOCKED).toBe(
      'Finish your recording or stream first. Installing restarts Videorc.'
    )
    expect(blocked.kind === 'row' && blocked.description).toMatch(/recording or stream/)
  })

  it('turns a failure into copy with Try again, never the raw updater text', () => {
    const failed = updateRowView(
      { phase: 'error', message: 'HttpError: 503 "method: GET url: https://example.test"' },
      false
    )
    expect(failed).toEqual({
      kind: 'error',
      title: "Couldn't check for updates",
      description:
        'Check your internet connection, then try again. If it keeps happening, export a support bundle below.'
    })
    expect(JSON.stringify(failed)).not.toMatch(/HttpError|503/)
  })

  it('links a build that cannot update itself to where new builds are', () => {
    expect(updateRowView({ phase: 'unsupported' }, false)).toMatchObject({
      kind: 'row',
      control: { kind: 'link', label: 'Open downloads page', link: 'download' }
    })
    expect(
      updateRowView({ phase: 'unsupported', reason: 'windows-feed-unpublished' }, false)
    ).toMatchObject({
      kind: 'row',
      control: { kind: 'link', label: 'Open account page', link: 'account' }
    })
  })

  it('sends a Linux build to the downloads page for a newer release, never a download', () => {
    expect(
      updateRowView({ phase: 'download-available', version: '0.15.0-alpha.1' }, false)
    ).toEqual({
      kind: 'row',
      description: 'Videorc 0.15.0-alpha.1 is available — download it from videorc.com.',
      control: { kind: 'link', label: 'Open downloads page', link: 'download' }
    })
    const unknown = updateRowView({ phase: 'unsupported', reason: 'linux-version-unknown' }, false)
    expect(unknown).toMatchObject({
      kind: 'row',
      control: { kind: 'link', label: 'Open downloads page', link: 'download' }
    })
    // Not knowing is never "You're on the latest version".
    expect(unknown.kind === 'row' && unknown.description).not.toMatch(/latest/)
  })

  it('offers Check again once up to date', () => {
    expect(updateRowView({ phase: 'not-available', currentVersion: '1.1.0' }, false)).toEqual({
      kind: 'row',
      description: "You're on the latest version (1.1.0).",
      control: { kind: 'check', label: 'Check again' }
    })
  })
})
