import { describe, expect, it } from 'vitest'

import { cn } from './utils'

describe('cn', () => {
  it('lets a call site override the desktop size tokens (plan 050 D4)', () => {
    expect(cn('h-control', 'h-auto')).toBe('h-auto')
    expect(cn('size-control', 'size-7')).toBe('size-7')
    expect(cn('h-row', 'h-row-compact')).toBe('h-row-compact')
    expect(cn('px-gutter', 'px-2')).toBe('px-2')
    expect(cn('h-toolbar', 'h-12')).toBe('h-12')
  })

  it('still merges ordinary classes', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4')
    expect(cn('text-sm', 'text-xs')).toBe('text-xs')
  })
})
