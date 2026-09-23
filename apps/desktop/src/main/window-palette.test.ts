import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { DARK_GLASS_COATS } from './window-palette'

// styles.css is the source of truth; main-side documents mirror it here.
const styles = readFileSync(join(__dirname, '../renderer/src/styles.css'), 'utf8')

function darkToken(name: string): string | undefined {
  const dark = styles.slice(styles.indexOf('\n.dark {'))
  const block = dark.slice(0, dark.indexOf('\n}'))
  return new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim()
}

describe('window palette mirrors styles.css', () => {
  it('keeps the dark glass coats in step with the stylesheet', () => {
    expect(darkToken('glass-window')).toBe(DARK_GLASS_COATS.window)
    expect(darkToken('glass-content')).toBe(DARK_GLASS_COATS.content)
  })
})
