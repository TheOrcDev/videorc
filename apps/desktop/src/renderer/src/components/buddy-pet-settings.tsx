import { useRef, useState, type ReactElement } from 'react'

import { BuddyAvatarSection, type BuddyAvatarView } from '@/components/buddy-avatar-section'
import { BuddyLookSection } from '@/components/buddy-look-section'
import { BuddyMotionSection } from '@/components/buddy-motion-section'
import type { BuddyPetPreviewHandle, BuddyPetPreviewInfo } from '@/components/buddy-pet-preview'
import { BuddyReactionsSection } from '@/components/buddy-reactions-section'
import { ConfigGrid } from '@/components/page'
import { useBuddyPets, type BuddyPets } from '@/hooks/use-buddy-pets'
import { useStudioCore } from '@/hooks/use-studio'
import type { CohostPersona, BuddyPetImportResult } from '@/lib/backend'
import { BUDDY_STILL_PACK_ID, buddyFirstPack } from '@/lib/buddy-pet-view'
import { BUDDY_STILL_REACTION_IDS, type BuddyMotionSettings } from '../../../shared/buddy-pet'

/**
 * The living Buddy's settings on the Buddy tab (plan 168 S-D2): Avatar with
 * the preview, then Reactions beside Motion. One owner for what the three
 * share: the pack list, the preview (Try plays in it) and the Motion draft
 * (the preview follows the slider before it is saved).
 */
export function BuddyPetSettings({
  pets: injectedPets,
  importFolder
}: {
  /** Tests inject the pack list; the app reads `cohost.pet.list`. */
  pets?: BuddyPets
  importFolder?: (personaId: string) => Promise<BuddyPetImportResult | null>
}): ReactElement | null {
  const { cohostSettings, patchCohostSettings } = useStudioCore()
  const connectedPets = useBuddyPets()
  const pets = injectedPets ?? connectedPets
  const persona = cohostSettings?.persona ?? null
  const previewRef = useRef<BuddyPetPreviewHandle>(null)
  // Alive picked with nothing to wear yet: the empty state, unsaved (the
  // wire's Alive always names a pack).
  const [aliveDraft, setAliveDraft] = useState(false)
  const [motionDraft, setMotionDraft] = useState<BuddyMotionSettings | null>(null)
  const [previewInfo, setPreviewInfo] = useState<BuddyPetPreviewInfo | null>(null)
  if (!persona) return null

  const save = (next: CohostPersona): Promise<void> => patchCohostSettings({ persona: next })
  const wornPackId = persona.avatar.kind === 'alive' ? persona.avatar.packId : null
  const view: BuddyAvatarView = wornPackId || aliveDraft ? 'alive' : 'still'
  const previewPackId = view === 'still' ? BUDDY_STILL_PACK_ID : wornPackId

  const wear = async (packId: string): Promise<void> => {
    await save({ ...persona, avatar: { kind: 'alive', packId } })
    setAliveDraft(false)
  }
  const changeView = async (next: BuddyAvatarView): Promise<void> => {
    if (next === view) return
    if (next === 'still') {
      setAliveDraft(false)
      if (persona.avatar.kind !== 'still') await save({ ...persona, avatar: { kind: 'still' } })
      return
    }
    // Alive wears a pack at once when there is one; else the empty state.
    const first = buddyFirstPack(pets.packs ?? [])
    if (!first) {
      setAliveDraft(true)
      return
    }
    await wear(first.packId)
  }

  const activeReactions: readonly string[] =
    view === 'still'
      ? BUDDY_STILL_REACTION_IDS
      : (pets.packs?.find((pack) => pack.packId === wornPackId)?.reactions ??
        (previewInfo?.packId === wornPackId ? previewInfo.reactions : []))

  return (
    <>
      <BuddyAvatarSection
        importFolder={importFolder}
        motion={motionDraft ?? persona.motion}
        persona={persona}
        pets={pets}
        previewPackId={previewPackId}
        previewRef={previewRef}
        stillPanel={<BuddyLookSection />}
        view={view}
        onPreviewLoad={setPreviewInfo}
        onUnwear={async () => {
          await save({ ...persona, avatar: { kind: 'still' } })
          setAliveDraft(true)
        }}
        onViewChange={changeView}
        onWear={wear}
      />
      {/* One hairline under both columns, as the column pair ends level. */}
      <ConfigGrid className="border-b border-border lg:[&>*]:border-b-0">
        <BuddyReactionsSection
          persona={persona}
          reactions={activeReactions}
          onSave={save}
          onTry={previewPackId ? (reaction) => previewRef.current?.react(reaction) ?? false : null}
        />
        <BuddyMotionSection persona={persona} onDraft={setMotionDraft} onSave={save} />
      </ConfigGrid>
    </>
  )
}
