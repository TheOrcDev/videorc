import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  GOLEM_LIBRARY_COPY,
  GOLEM_ONBOARDING_BUTTONS,
  GOLEM_ONBOARDING_GATES,
  GOLEM_ONBOARDING_STEP1,
  GOLEM_ONBOARDING_STEP2,
  GOLEM_ONBOARDING_STEP3,
  GOLEM_ONBOARDING_STEP4,
  GOLEM_ONBOARDING_STEP_TITLES,
  golemLibraryDeleteTitle,
  golemLibraryFullLine,
  golemLibraryPickedElsewhere,
  golemOnboardingAllowance,
  golemOnboardingCounter,
  golemOnboardingProgress
} from './golem-onboarding-copy'

// Plan 170 D14: the app's copy is the shared document's, word for word. The
// document wraps its lines, so it is read with every run of whitespace as one
// space.
const doc = readFileSync(
  new URL('../../../../../../docs/golem-onboarding-copy.md', import.meta.url),
  'utf8'
).replace(/\s+/g, ' ')

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings)
  return []
}

describe('golem onboarding copy (plan 170 D14)', () => {
  it('pins the four step titles', () => {
    expect(GOLEM_ONBOARDING_STEP_TITLES).toEqual([
      'Meet your sidekick',
      'Describe it',
      'Give it a personality',
      'Create your Golem'
    ])
    GOLEM_ONBOARDING_STEP_TITLES.forEach((title, index) => {
      expect(doc).toContain(`${index + 1}. ${title}`)
    })
  })

  it('takes every string from the shared document verbatim', () => {
    const all = strings([
      GOLEM_ONBOARDING_BUTTONS,
      GOLEM_ONBOARDING_STEP1,
      GOLEM_ONBOARDING_STEP2,
      GOLEM_ONBOARDING_STEP3,
      GOLEM_ONBOARDING_STEP4,
      GOLEM_ONBOARDING_GATES,
      GOLEM_LIBRARY_COPY
    ])
    expect(all.length).toBeGreaterThan(70)
    const missing = all.filter((line) => !doc.includes(line))
    expect(missing).toEqual([])
  })

  it('fills the templates the document names', () => {
    expect(doc).toContain('`Step {n} of 4`')
    expect(golemOnboardingProgress(2)).toBe('Step 2 of 4')
    expect(doc).toContain('"Uses 4 of your {remaining} images left today."')
    expect(golemOnboardingAllowance(20)).toBe('Uses 4 of your 20 images left today.')
    expect(doc).toContain('"Your library is full ({limit} Golems). Delete one to make room."')
    expect(golemLibraryFullLine(30)).toBe(
      'Your library is full (30 Golems). Delete one to make room.'
    )
    expect(doc).toContain('title "Delete {name}?"')
    expect(golemLibraryDeleteTitle('Grum')).toBe('Delete Grum?')
    expect(doc).toContain('"{name} was picked on videorc.com."')
    expect(golemLibraryPickedElsewhere('Nib')).toBe('Nib was picked on videorc.com.')
    expect(doc).toContain('`{count}/600`')
    expect(golemOnboardingCounter(12, 600)).toBe('12/600')
  })
})
