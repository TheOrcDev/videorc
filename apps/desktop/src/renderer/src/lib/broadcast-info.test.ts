import { describe, expect, it } from 'vitest'

import {
  BROADCAST_TITLE_MAX,
  broadcastInfoIssues,
  broadcastPrivacyHint,
  broadcastTextLength,
  broadcastThumbnailHint,
  broadcastTitleCounter
} from './broadcast-info'

describe('stream details rules (plan 174 S3.4, B-19 and D-21)', () => {
  it('asks for a title only where it is about to go live', () => {
    expect(broadcastInfoIssues({ title: ' ', description: '' }).title).toBeNull()
    expect(
      broadcastInfoIssues({ title: ' ', description: '' }, { titleRequired: true }).title
    ).toBe('Add a title before you go live.')
  })

  it('counts characters as people see them, against one limit', () => {
    expect(broadcastTextLength('🎮 Live')).toBe(6)
    const long = 'a'.repeat(BROADCAST_TITLE_MAX + 1)
    expect(broadcastInfoIssues({ title: long, description: '' }).title).toBe(
      'Keep the title to 100 characters.'
    )
    expect(broadcastInfoIssues({ title: 'a'.repeat(100), description: '' }).title).toBeNull()
    expect(broadcastTitleCounter('Hello')).toBe('5/100')
  })

  it('refuses < and > in the title and the description', () => {
    const issues = broadcastInfoIssues({ title: 'a <b>', description: 'x > y' })
    expect(issues.title).toBe("Titles can't contain < or >.")
    expect(issues.description).toBe("Descriptions can't contain < or >.")
    expect(broadcastInfoIssues({ title: 'Fine', description: 'Fine' })).toEqual({
      title: null,
      description: null
    })
  })

  it('caps the description at 5,000 characters', () => {
    expect(broadcastInfoIssues({ title: 'a', description: 'a'.repeat(5001) }).description).toBe(
      'Keep the description to 5,000 characters.'
    )
  })

  it('says what each privacy means, and gives one thumbnail hint', () => {
    expect(broadcastPrivacyHint('public')).toContain('Anyone can find it')
    expect(broadcastPrivacyHint('unlisted')).toContain('with the link')
    expect(broadcastPrivacyHint('private')).toContain('Only you')
    expect(broadcastThumbnailHint({ youtubeSignedIn: true })).toContain('16:9')
    expect(broadcastThumbnailHint({ youtubeSignedIn: false })).toContain("can't receive")
  })
})
