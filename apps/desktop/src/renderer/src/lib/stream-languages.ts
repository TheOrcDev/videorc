// Twitch's broadcast languages (its `broadcaster_language` codes), named in
// words for the Stream details language Select (plan 174 S3.5b, D-30): the
// field used to be free text that took "en".

const TWITCH_LANGUAGE_CODES = [
  'ar',
  'bg',
  'ca',
  'cs',
  'da',
  'de',
  'el',
  'en',
  'es',
  'fi',
  'fr',
  'hi',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'ms',
  'nl',
  'no',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sv',
  'th',
  'tl',
  'tr',
  'uk',
  'vi',
  'zh',
  'zh-hk',
  'asl',
  'other'
] as const

const SPECIAL_NAMES: Record<string, string> = {
  asl: 'American Sign Language',
  'zh-hk': 'Chinese (Hong Kong)',
  other: 'Other'
}

/** A language code in words ("de" → "German"); the code itself when unknown. */
export function streamLanguageName(code: string): string {
  const key = code.trim().toLowerCase()
  if (SPECIAL_NAMES[key]) return SPECIAL_NAMES[key]
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(key)
    return name && name.toLowerCase() !== key ? name : code
  } catch {
    return code
  }
}

/**
 * The language choices, by name, with "Other" last. A saved code outside the
 * list stays a choice, so opening the page never changes it.
 */
export function streamLanguageOptions(current?: string): { value: string; label: string }[] {
  const codes: string[] = [...TWITCH_LANGUAGE_CODES]
  const saved = current?.trim().toLowerCase()
  if (saved && !codes.includes(saved)) codes.push(saved)
  return codes
    .map((value) => ({ value, label: streamLanguageName(value) }))
    .sort((a, b) =>
      a.value === 'other' ? 1 : b.value === 'other' ? -1 : a.label.localeCompare(b.label)
    )
}
