import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  BUDDY_LIBRARY_COPY,
  BUDDY_ONBOARDING_BUTTONS,
  BUDDY_ONBOARDING_GATES,
  BUDDY_ONBOARDING_STEP1,
  BUDDY_ONBOARDING_STEP2,
  BUDDY_ONBOARDING_STEP3,
  BUDDY_ONBOARDING_STEP4,
  BUDDY_ONBOARDING_STEP_TITLES,
  buddyLibraryAliveDownloading,
  buddyLibraryAliveUploading,
  buddyLibraryDeleteTitle,
  buddyLibraryFullLine,
  buddyLibraryImporting,
  buddyLibraryLocalOnly,
  buddyLibraryPickedElsewhere,
  buddyOnboardingAllowance,
  buddyOnboardingCounter,
  buddyOnboardingProgress
} from './buddy-onboarding-copy'

// Plan 170 D14: the app's copy is the shared document's, word for word. The
// document wraps its lines, so it is read with every run of whitespace as one
// space.
const doc = readFileSync(
  new URL('../../../../../../docs/buddy-onboarding-copy.md', import.meta.url),
  'utf8'
).replace(/\s+/g, ' ')

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings)
  return []
}

describe('buddy onboarding copy (plan 170 D14)', () => {
  it('pins the four step titles', () => {
    expect(BUDDY_ONBOARDING_STEP_TITLES).toEqual([
      'Meet your sidekick',
      'Describe it',
      'Give it a personality',
      'Create your Buddy'
    ])
    BUDDY_ONBOARDING_STEP_TITLES.forEach((title, index) => {
      expect(doc).toContain(`${index + 1}. ${title}`)
    })
  })

  it('takes every string from the shared document verbatim', () => {
    const all = strings([
      BUDDY_ONBOARDING_BUTTONS,
      BUDDY_ONBOARDING_STEP1,
      BUDDY_ONBOARDING_STEP2,
      BUDDY_ONBOARDING_STEP3,
      BUDDY_ONBOARDING_STEP4,
      BUDDY_ONBOARDING_GATES,
      BUDDY_LIBRARY_COPY
    ])
    expect(all.length).toBeGreaterThan(70)
    const missing = all.filter((line) => !doc.includes(line))
    expect(missing).toEqual([])
  })

  it('fills the templates the document names', () => {
    expect(doc).toContain('`Step {n} of 4`')
    expect(buddyOnboardingProgress(2)).toBe('Step 2 of 4')
    expect(doc).toContain('"Uses 4 of your {remaining} images left today."')
    expect(buddyOnboardingAllowance(20)).toBe('Uses 4 of your 20 images left today.')
    expect(doc).toContain('"Your library is full ({limit} Buddies). Delete one to make room."')
    expect(buddyLibraryFullLine(30)).toBe(
      'Your library is full (30 Buddies). Delete one to make room.'
    )
    expect(doc).toContain('title "Delete {name}?"')
    expect(buddyLibraryDeleteTitle('Grum')).toBe('Delete Grum?')
    expect(doc).toContain('"{name} was picked on videorc.com."')
    expect(buddyLibraryPickedElsewhere('Nib')).toBe('Nib was picked on videorc.com.')
    expect(doc).toContain('`{count}/600`')
    expect(buddyOnboardingCounter(12, 600)).toBe('12/600')
    // Plan 172: Save to my library and the pack jobs.
    expect(doc).toContain('"{name} is only on this computer."')
    expect(buddyLibraryLocalOnly('Mossback')).toBe('Mossback is only on this computer.')
    expect(doc).toContain(`"Downloading {name}'s moves."`)
    expect(buddyLibraryAliveDownloading('Golmar')).toBe("Downloading Golmar's moves.")
    expect(doc).toContain(`"Saving {name}'s moves to your library."`)
    expect(buddyLibraryAliveUploading('Grum')).toBe("Saving Grum's moves to your library.")
    expect(doc).toContain('"Saving {name} to your library."')
    expect(buddyLibraryImporting('Mossback')).toBe('Saving Mossback to your library.')
  })
})
