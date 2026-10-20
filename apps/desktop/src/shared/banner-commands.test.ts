import { describe, expect, it } from 'vitest'

import {
  BANNER_COMMAND_USAGE,
  NO_BANNERS_YET,
  bannerCompletions,
  bannerSummaries,
  classifyBannerCommand,
  matchBannerName,
  type BannerSummary
} from './banner-commands'

// Plan 186 S7: the live controls see a banner as id, name and shown, and
// `/banner <name>` picks one the way the plan says.

const sponsor: BannerSummary = { id: 'sponsor', name: 'Sponsor', shown: true }
const spring: BannerSummary = { id: 'spring', name: 'Spring sale', shown: false }
const logo: BannerSummary = { id: 'logo', name: 'Logo', shown: false }
const banners = [sponsor, spring, logo]

describe('matchBannerName', () => {
  it('matches case-insensitively: an exact name wins, else a prefix only one banner has', () => {
    expect(matchBannerName('SPONSOR', banners)).toEqual({ kind: 'match', banner: sponsor })
    expect(matchBannerName('  lo ', banners)).toEqual({ kind: 'match', banner: logo })
    expect(matchBannerName('sp', banners)).toEqual({
      kind: 'ambiguous',
      names: ['Sponsor', 'Spring sale']
    })
    // "Sale" exactly beats "Sale banner" starting with it.
    const sale = { id: 'sale', name: 'Sale', shown: false }
    const saleBanner = { id: 'sale-banner', name: 'Sale banner', shown: false }
    expect(matchBannerName('sale', [saleBanner, sale])).toEqual({ kind: 'match', banner: sale })
    expect(matchBannerName('acme', banners)).toEqual({ kind: 'none' })
    expect(matchBannerName('   ', banners)).toEqual({ kind: 'none' })
  })
})

describe('classifyBannerCommand', () => {
  it('toggles the named banner with an explicit verb from the state the window shows', () => {
    expect(classifyBannerCommand('sponsor', banners)).toEqual({
      kind: 'banner',
      action: { action: 'hide', id: 'sponsor' }
    })
    expect(classifyBannerCommand('Logo', banners)).toEqual({
      kind: 'banner',
      action: { action: 'show', id: 'logo' }
    })
  })

  it('reserves "off" for hiding them all', () => {
    expect(classifyBannerCommand(' OFF ', banners)).toEqual({
      kind: 'banner',
      action: { action: 'hideAll' }
    })
    const named = [{ id: 'off', name: 'Off', shown: false }]
    expect(classifyBannerCommand('off', named)).toEqual({
      kind: 'banner',
      action: { action: 'hideAll' }
    })
  })

  it('says what it could not pick, in the plan words', () => {
    expect(classifyBannerCommand('acme', banners)).toEqual({
      kind: 'error',
      message: 'No banner called “acme”.'
    })
    expect(classifyBannerCommand('sp', banners)).toEqual({
      kind: 'error',
      message: '“sp” matches Sponsor and Spring sale.'
    })
    expect(
      classifyBannerCommand('s', [...banners, { id: 'socials', name: 'Socials', shown: false }])
    ).toEqual({ kind: 'error', message: '“s” matches Sponsor, Spring sale, and Socials.' })
    expect(classifyBannerCommand('', banners)).toEqual({
      kind: 'error',
      message: BANNER_COMMAND_USAGE
    })
    expect(classifyBannerCommand('sponsor', [])).toEqual({ kind: 'error', message: NO_BANNERS_YET })
  })
})

describe('bannerCompletions', () => {
  it('lists every banner under /banner with what Enter does, then /banner off', () => {
    expect(bannerCompletions('/banner', banners)).toEqual([
      { value: '/banner Sponsor', hint: ' · Hide' },
      { value: '/banner Spring sale', hint: ' · Show' },
      { value: '/banner Logo', hint: ' · Show' },
      { value: '/banner off', hint: ' · Hide all banners' }
    ])
    expect(bannerCompletions('/BANNER sp', banners)?.map(({ value }) => value)).toEqual([
      '/banner Sponsor',
      '/banner Spring sale'
    ])
    expect(bannerCompletions('/banner o', banners)?.map(({ value }) => value)).toEqual([
      '/banner off'
    ])
    expect(bannerCompletions('/banner', [])).toEqual([])
  })

  it('stays out of every other draft', () => {
    for (const draft of ['/b', '/bannerx', '/marker Sponsor', 'banner Sponsor', '//banner']) {
      expect(bannerCompletions(draft, banners)).toBeNull()
    }
  })
})

describe('bannerSummaries', () => {
  it('carries only id, name and shown, whatever the list had', () => {
    const full = { ...sponsor, imageFile: 'sponsor.png', thumbnailFile: 'sponsor.thumb.png' }
    expect(bannerSummaries([full])).toEqual([sponsor])
  })
})
