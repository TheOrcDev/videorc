import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { avatarCacheFileName, avatarUrlDecision } from './avatar-cache'

const catalog = readFileSync(
  new URL('../../../../crates/videorc-backend/assets/youtube-emotes.tsv', import.meta.url),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => line.split('\t'))

describe('YouTube built-in emote cache contract', () => {
  it('accepts the entire pinned catalog using the existing cache and safe local filenames', () => {
    expect(catalog).toHaveLength(122)
    for (const [alias, url] of catalog) {
      expect(alias).toMatch(/^:[A-Za-z0-9-]+:$/)
      expect(url).toMatch(/^https:\/\/yt3\.ggpht\.com\/[A-Za-z0-9_-]+=w48-h48-c-k-nd$/)
      expect(avatarUrlDecision(url)).toEqual({ allowed: true, host: 'yt3.ggpht.com' })
      expect(avatarCacheFileName(url!)).toMatch(/^[a-f0-9]{32}\.img$/)
    }
  })

  it.each([
    'https://yt3.ggpht.com.attacker.test/blue',
    'https://yt3.ggpht.com@attacker.test/blue',
    'http://yt3.ggpht.com/blue',
    'data:image/svg+xml,<svg onload=alert(1)>',
    'javascript:alert(1)',
    'file:///etc/passwd'
  ])('rejects untrusted image source %s', (url) => {
    expect(avatarUrlDecision(url).allowed).toBe(false)
  })
})
