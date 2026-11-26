import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Plans 092 and 093: audiocn's meter and channel tokens are Videorc tokens, written by hand in
// styles.css. A re-install brings the shadcn CLI's own CSS (raw
// colours, plus self-referencing lines in @theme inline); these tests fail if
// any of it survives.

const styles = readFileSync(join(__dirname, 'styles.css'), 'utf8')
const TOKENS = [
  'meter-ok',
  'meter-warn',
  'meter-clip',
  'channel-mute',
  'channel-solo',
  'channel-monitor'
].flatMap((token) => [token, `${token}-foreground`])

function declarations(token: string): string[] {
  return [...styles.matchAll(new RegExp(`^\\s*--${token}:\\s*([^;]+);`, 'gm'))].map(
    (match) => match[1]
  )
}

describe('audiocn tokens (plans 092 and 093)', () => {
  it('aliases every meter and channel token to a Videorc token', () => {
    for (const token of TOKENS) {
      const values = declarations(token)
      expect(values, token).toHaveLength(1)
      expect(values[0], token).toMatch(/var\(--[a-z-]+\)/)
      expect(values[0], token).not.toMatch(/oklch\(|rgba?\(|hsla?\(|#[0-9a-f]{3,8}\b/i)
    }
  })

  it('maps each token into Tailwind once', () => {
    for (const token of TOKENS) {
      const mapping = `--color-${token}: var(--${token});`
      expect(styles.split(mapping), token).toHaveLength(2)
    }
  })

  it('has no self-referencing custom property', () => {
    expect(styles).not.toMatch(/--([a-z0-9-]+):\s*var\(--\1\)\s*;/)
  })
})

it('keeps LCD components out of the app screens', () => {
  function sources(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) return entry === 'ui' ? [] : sources(path)
      return /\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry) ? [path] : []
    })
  }
  for (const path of sources(__dirname)) {
    expect(readFileSync(path, 'utf8'), relative(__dirname, path)).not.toMatch(
      /<Lcd(?:Display|Meter)\b/
    )
  }
})
