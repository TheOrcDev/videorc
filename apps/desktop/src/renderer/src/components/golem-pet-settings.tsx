import { useRef, useState, type ReactElement } from 'react'

import { GolemAvatarSection, type GolemAvatarView } from '@/components/golem-avatar-section'
import { GolemLookSection } from '@/components/golem-look-section'
import { GolemMotionSection } from '@/components/golem-motion-section'
import type { GolemPetPreviewHandle, GolemPetPreviewInfo } from '@/components/golem-pet-preview'
import { GolemReactionsSection } from '@/components/golem-reactions-section'
import { ConfigGrid } from '@/components/page'
import { useGolemPets, type GolemPets } from '@/hooks/use-golem-pets'
import { useStudioCore } from '@/hooks/use-studio'
import type { CohostPersona, GolemPetImportResult } from '@/lib/backend'
import { GOLEM_STILL_PACK_ID, golemFirstPack } from '@/lib/golem-pet-view'
import { GOLEM_STILL_REACTION_IDS, type GolemMotionSettings } from '../../../shared/golem-pet'

/**
 * The living Golem's settings on the Golem tab (plan 168 S-D2): Avatar with
 * the preview, then Reactions beside Motion. One owner for what the three
 * share: the pack list, the preview (Try plays in it) and the Motion draft
 * (the preview follows the slider before it is saved).
 */
export function GolemPetSettings({
  pets: injectedPets,
  importFolder
}: {
  /** Tests inject the pack list; the app reads `cohost.pet.list`. */
  pets?: GolemPets
  importFolder?: (personaId: string) => Promise<GolemPetImportResult | null>
}): ReactElement | null {
  const { cohostSettings, patchCohostSettings } = useStudioCore()
  const connectedPets = useGolemPets()
  const pets = injectedPets ?? connectedPets
  const persona = cohostSettings?.persona ?? null
  const previewRef = useRef<GolemPetPreviewHandle>(null)
  // Alive picked with nothing to wear yet: the empty state, unsaved (the
  // wire's Alive always names a pack).
  const [aliveDraft, setAliveDraft] = useState(false)
  const [motionDraft, setMotionDraft] = useState<GolemMotionSettings | null>(null)
  const [previewInfo, setPreviewInfo] = useState<GolemPetPreviewInfo | null>(null)
  if (!persona) return null

  const save = (next: CohostPersona): Promise<void> => patchCohostSettings({ persona: next })
  const wornPackId = persona.avatar.kind === 'alive' ? persona.avatar.packId : null
  const view: GolemAvatarView = wornPackId || aliveDraft ? 'alive' : 'still'
  const previewPackId = view === 'still' ? GOLEM_STILL_PACK_ID : wornPackId

  const wear = async (packId: string): Promise<void> => {
    await save({ ...persona, avatar: { kind: 'alive', packId } })
    setAliveDraft(false)
  }
  const changeView = async (next: GolemAvatarView): Promise<void> => {
    if (next === view) return
    if (next === 'still') {
      setAliveDraft(false)
      if (persona.avatar.kind !== 'still') await save({ ...persona, avatar: { kind: 'still' } })
      return
    }
    // Alive wears a pack at once when there is one; else the empty state.
    const first = golemFirstPack(pets.packs ?? [])
    if (!first) {
      setAliveDraft(true)
      return
    }
    await wear(first.packId)
  }

  const activeReactions: readonly string[] =
    view === 'still'
      ? GOLEM_STILL_REACTION_IDS
      : (pets.packs?.find((pack) => pack.packId === wornPackId)?.reactions ??
        (previewInfo?.packId === wornPackId ? previewInfo.reactions : []))

  return (
    <>
      <GolemAvatarSection
        importFolder={importFolder}
        motion={motionDraft ?? persona.motion}
        persona={persona}
        pets={pets}
        previewPackId={previewPackId}
        previewRef={previewRef}
        stillPanel={<GolemLookSection />}
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
        <GolemReactionsSection
          persona={persona}
          reactions={activeReactions}
          onSave={save}
          onTry={previewPackId ? (reaction) => previewRef.current?.react(reaction) ?? false : null}
        />
        <GolemMotionSection persona={persona} onDraft={setMotionDraft} onSave={save} />
      </ConfigGrid>
    </>
  )
}
