import { describe, expect, it } from 'vitest'

import {
  SIGNED_OUT_ACCOUNT,
  accountDisplayName,
  accountFromSnapshot,
  accountMenuItems,
  entitlementTierLabel,
  isSignOutDisabled,
  isSignedIn,
  type VideorcAccount
} from './account'
import { VIDEORC_PREMIUM_URL, VIDEORC_WEB_LINKS } from './videorc-web-links'

const signedIn: VideorcAccount = { status: 'signed-in', username: 'orc_dev' }

describe('account display', () => {
  it('shows the sign-in call to action when signed out, never a fake name', () => {
    expect(accountDisplayName(SIGNED_OUT_ACCOUNT)).toBe('Sign in')
    expect(isSignedIn(SIGNED_OUT_ACCOUNT)).toBe(false)
  })

  it('prefers the display name, falling back to the username', () => {
    expect(accountDisplayName(signedIn)).toBe('orc_dev')
    expect(accountDisplayName({ ...signedIn, displayName: 'Orc Dev' })).toBe('Orc Dev')
    // Blank/whitespace display name falls back to the username, not an empty label.
    expect(accountDisplayName({ ...signedIn, displayName: '   ' })).toBe('orc_dev')
    expect(isSignedIn(signedIn)).toBe(true)
  })

  it('labels the local entitlement tier without implying sign-in', () => {
    expect(entitlementTierLabel('basic')).toBe('Basic')
    expect(entitlementTierLabel('developer')).toBe('Developer')
    expect(entitlementTierLabel('premium')).toBe('Premium')
    expect(entitlementTierLabel(null)).toBe('Basic')
    expect(entitlementTierLabel(undefined)).toBe('Basic')
  })
})

describe('account menu items', () => {
  it('signed-out menu offers Sign in, View Premium, Health, Settings — and no Sign out', () => {
    expect(accountMenuItems(SIGNED_OUT_ACCOUNT)).toEqual([
      'sign-in',
      'view-premium',
      'health',
      'settings'
    ])
  })

  it('signed-in menu swaps Sign in for Account + Sign out', () => {
    expect(accountMenuItems(signedIn)).toEqual([
      'account',
      'sign-out',
      'view-premium',
      'health',
      'settings'
    ])
  })

  it('disables Sign out only when signed in and a session is live', () => {
    expect(isSignOutDisabled(SIGNED_OUT_ACCOUNT, true)).toBe(false)
    expect(isSignOutDisabled(signedIn, false)).toBe(false)
    expect(isSignOutDisabled(signedIn, true)).toBe(true)
  })
})

describe('accountFromSnapshot', () => {
  it('treats null, signed-out, or username-less snapshots as signed-out', () => {
    expect(accountFromSnapshot(null)).toBe(SIGNED_OUT_ACCOUNT)
    expect(accountFromSnapshot(undefined)).toBe(SIGNED_OUT_ACCOUNT)
    expect(accountFromSnapshot({ status: 'signed-out' })).toBe(SIGNED_OUT_ACCOUNT)
    // A signed-in snapshot with no username is not a usable account.
    expect(accountFromSnapshot({ status: 'signed-in' })).toBe(SIGNED_OUT_ACCOUNT)
  })

  it('maps a signed-in snapshot to the renderer account, defaulting optionals to null', () => {
    expect(accountFromSnapshot({ status: 'signed-in', username: 'orc_dev' })).toEqual({
      status: 'signed-in',
      username: 'orc_dev',
      displayName: null,
      email: null,
      avatarUrl: null
    })
    expect(
      accountFromSnapshot({
        status: 'signed-in',
        username: 'orc_dev',
        displayName: 'Orc Dev',
        email: 'orc@videorc.com',
        avatarUrl: 'https://abc.public.blob.vercel-storage.com/a.jpg'
      })
    ).toEqual({
      status: 'signed-in',
      username: 'orc_dev',
      displayName: 'Orc Dev',
      email: 'orc@videorc.com',
      avatarUrl: 'https://abc.public.blob.vercel-storage.com/a.jpg'
    })
  })
})

describe('videorc web links', () => {
  it('points the account links at the Videorc web origin', () => {
    expect(VIDEORC_WEB_LINKS).toEqual({
      account: 'https://www.videorc.com/account',
      login: 'https://www.videorc.com/login',
      desktopAuthorize: 'https://www.videorc.com/desktop/authorize/v2',
      premium: 'https://www.videorc.com/premium',
      privacy: 'https://www.videorc.com/privacy',
      terms: 'https://www.videorc.com/terms',
      billing: 'https://www.videorc.com/account/billing',
      changelogApi: 'https://www.videorc.com/api/changelog',
      changelog: 'https://www.videorc.com/changelog'
    })
  })

  it('keeps VIDEORC_PREMIUM_URL value-compatible with premium-upgrade callers', () => {
    expect(VIDEORC_PREMIUM_URL).toBe('https://www.videorc.com/premium')
    expect(VIDEORC_PREMIUM_URL).toBe(VIDEORC_WEB_LINKS.premium)
  })
})
