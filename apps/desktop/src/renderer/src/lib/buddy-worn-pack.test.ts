import { describe, expect, it } from 'vitest'

import type { BuddyPetSummary } from '@/lib/backend'

import { buddyPackToWear, readBuddyWornPack, writeBuddyWornPack } from './buddy-worn-pack'

const pack = (packId: string, name: string): BuddyPetSummary => ({
  packId,
  name,
  cellSize: 640,
  gazeCount: 25,
  reactions: ['laugh'],
  source: 'page-pet-import',
  hasTalk: false
})

const MOSS = pack('0b9c6c34-5d7e-4b4f-9a7e-3c2d1e0f9a8b', 'Moss')
const EMBER = pack('7f3e2d1c-0b9a-4876-9543-210fedcba987', 'Ember')
const SHIPPED = pack('bundled:buddy', 'Buddy')

function memory(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    length: 0
  }
}

describe('the worn pack memory (plan 174 G-10)', () => {
  it('wears the pack worn last when it is still here, else the first own pack', () => {
    const storage = memory()
    expect(buddyPackToWear('p-1', [SHIPPED, MOSS, EMBER], storage)).toBe(MOSS)
    writeBuddyWornPack('p-1', EMBER.packId, storage)
    expect(readBuddyWornPack('p-1', storage)).toBe(EMBER.packId)
    expect(buddyPackToWear('p-1', [SHIPPED, MOSS, EMBER], storage)).toBe(EMBER)
    // Another Buddy has its own memory.
    expect(buddyPackToWear('p-2', [SHIPPED, MOSS, EMBER], storage)).toBe(MOSS)
    // The remembered pack was removed: back to the first own pack.
    expect(buddyPackToWear('p-1', [SHIPPED, MOSS], storage)).toBe(MOSS)
    expect(buddyPackToWear('p-1', [SHIPPED], storage)).toBe(SHIPPED)
    expect(buddyPackToWear('p-1', [], storage)).toBeNull()
  })

  it('survives blocked storage', () => {
    const blocked: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      }
    }
    expect(() => writeBuddyWornPack('p-1', MOSS.packId, blocked)).not.toThrow()
    expect(readBuddyWornPack('p-1', blocked)).toBeNull()
    expect(buddyPackToWear('p-1', [MOSS], null)).toBe(MOSS)
  })
})
