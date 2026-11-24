import type { BuddyPetSummary } from './backend'
import { buddyFirstPack } from './buddy-pet-view'
import { uiSettingsStorage } from './ui-settings-storage'

// Which moves the Buddy wore last (plan 174 S3.15a, G-10): Still forgets the
// pack on the wire (`avatar: { kind: 'still' }`), so switching back to Alive
// used to wear the first pack in the list. Remembered per Buddy on this
// device, like the other one-time Buddy choices.

const KEY_PREFIX = 'videorc.buddyWornPack:'

export function readBuddyWornPack(
  personaId: string,
  storage: Pick<Storage, 'getItem'> | null = uiSettingsStorage()
): string | null {
  try {
    const raw = storage?.getItem(KEY_PREFIX + personaId)
    return raw && raw.trim() ? raw : null
  } catch {
    return null
  }
}

/** Best effort: blocked storage only forgets which pack was worn. */
export function writeBuddyWornPack(
  personaId: string,
  packId: string,
  storage: Pick<Storage, 'setItem'> | null = uiSettingsStorage()
): void {
  try {
    storage?.setItem(KEY_PREFIX + personaId, packId)
  } catch {
    // Forgetting is harmless: Alive then wears the first pack again.
  }
}

/**
 * The pack Alive wears when it is switched on: the one worn last when it is
 * still here, else the first own pack, else the one Videorc ships.
 */
export function buddyPackToWear(
  personaId: string,
  packs: readonly BuddyPetSummary[],
  storage: Pick<Storage, 'getItem'> | null = uiSettingsStorage()
): BuddyPetSummary | null {
  const remembered = readBuddyWornPack(personaId, storage)
  return (
    (remembered ? packs.find((pack) => pack.packId === remembered) : undefined) ??
    buddyFirstPack(packs)
  )
}
