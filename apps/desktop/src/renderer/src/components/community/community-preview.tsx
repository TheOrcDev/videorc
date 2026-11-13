import { useRef, useState, type ReactElement } from 'react'

import type { BuddyPetPreviewHandle } from '@/components/buddy-pet-preview'
import { LazyBuddyPetPreview } from '@/components/buddy-pet-preview-lazy'
import { PanelSection } from '@/components/panel-section'
import { Button } from '@/components/ui/button'
import { useStudioCore } from '@/hooks/use-studio'
import type { CohostGreetingWelcomes, CohostWelcomeLine } from '@/lib/backend'
import {
  BUDDY_SAMPLE_FIELDS,
  builtinGreeting,
  resolveGreetingPreview
} from '@/lib/buddy-auto-chat-view'
import { BUDDY_STILL_PACK_ID } from '@/lib/buddy-pet-view'

type PreviewKind = 'regular' | 'milestone'

const PREVIEW_PX = 72

/** The reaction each sample plays when the welcome names none (D9 defaults). */
const DEFAULT_REACTION: Record<PreviewKind, string> = {
  regular: 'wave',
  milestone: 'excited'
}

/** The line a welcome kind says: your own, else the built-in one (plan 192 D1). */
export function welcomePreviewLine(
  welcomes: CohostGreetingWelcomes | undefined,
  kind: PreviewKind
): string {
  const line: CohostWelcomeLine | undefined = welcomes?.[kind]
  const text = line?.text?.trim() || builtinGreeting(kind).text
  return resolveGreetingPreview(text, BUDDY_SAMPLE_FIELDS[kind]).text
}

/**
 * D-5: a sample welcome and a milestone on the Buddy's living preview, on
 * this page only. Never live, never in chat: the line shows in a bubble
 * beside the preview, and the reaction plays on it.
 */
export function CommunityPreview(): ReactElement {
  const { cohostSettings } = useStudioCore()
  const previewRef = useRef<BuddyPetPreviewHandle | null>(null)
  const [said, setSaid] = useState<{ kind: PreviewKind; text: string } | null>(null)
  const persona = cohostSettings?.persona
  const welcomes = cohostSettings?.autoChat.greetings.welcomes
  const play = (kind: PreviewKind): void => {
    const reaction = welcomes?.[kind]?.reaction?.trim() || DEFAULT_REACTION[kind]
    if (reaction !== 'none') previewRef.current?.react(reaction)
    setSaid({ kind, text: welcomePreviewLine(welcomes, kind) })
  }
  const packId = persona?.avatar?.kind === 'alive' ? persona.avatar.packId : BUDDY_STILL_PACK_ID
  return (
    <PanelSection
      description="Hear how Buddy welcomes a regular and celebrates a milestone. Only here: nothing goes live."
      title="Preview"
      data-testid="community-preview"
    >
      <div className="flex min-w-0 items-center gap-3">
        {persona ? (
          <LazyBuddyPetPreview
            ref={previewRef}
            className="shrink-0"
            interactive={false}
            label={persona.name}
            motion={persona.motion}
            packId={packId}
            personaId={persona.id}
            size={PREVIEW_PX}
            stillImages={persona.images}
          />
        ) : (
          <div className="size-18 shrink-0 rounded-row bg-inset" />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p
            aria-live="polite"
            className="min-h-10 rounded-row bg-inset px-3 py-2 text-sm text-foreground"
            data-testid="community-preview-line"
          >
            {said ? said.text : <span className="text-muted-foreground">Pick one to play.</span>}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Button
              data-testid="community-preview-regular"
              type="button"
              variant="secondary"
              onClick={() => play('regular')}
            >
              Play a welcome
            </Button>
            <Button
              data-testid="community-preview-milestone"
              type="button"
              variant="secondary"
              onClick={() => play('milestone')}
            >
              Play a milestone
            </Button>
          </div>
        </div>
      </div>
    </PanelSection>
  )
}
