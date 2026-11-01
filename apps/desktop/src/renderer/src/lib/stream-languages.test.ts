import { describe, expect, it } from 'vitest'

import { streamLanguageName, streamLanguageOptions } from './stream-languages'

// Plan 174 S3.5b (D-30): the Twitch language is a choice by name, not "en".

describe('stream languages', () => {
  it('names languages in words, Other last, and keeps a saved code', () => {
    expect(streamLanguageName('de')).toBe('German')
    expect(streamLanguageName('asl')).toBe('American Sign Language')
    const options = streamLanguageOptions()
    expect(options.find((option) => option.value === 'en')?.label).toBe('English')
    expect(options.at(-1)).toEqual({ value: 'other', label: 'Other' })
    expect(streamLanguageOptions('xx').some((option) => option.value === 'xx')).toBe(true)
    expect(streamLanguageOptions('EN').filter((option) => option.value === 'en')).toHaveLength(1)
  })
})
