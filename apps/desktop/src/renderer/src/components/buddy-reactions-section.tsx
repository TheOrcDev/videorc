import { PlayIcon } from '@/components/icons'
import { useState, type ReactElement } from 'react'

import { GroupedList, ListRow } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { CohostPersona, BuddyTrigger } from '@/lib/backend'
import {
  BUDDY_REACTION_DEFAULT_VALUE,
  BUDDY_TRIGGER_COPY,
  BUDDY_TRIGGER_SECTIONS,
  buddyChoosableReactions,
  buddyOutcomeLabel,
  buddyReactionLabel,
  buddyTriggerOutcome,
  withBuddyTriggerReaction
} from '@/lib/buddy-pet-view'
import { BUDDY_REACTION_NONE } from '../../../shared/buddy-pet'

export interface BuddyReactionsSectionProps {
  persona: CohostPersona
  /** The active pack's reaction ids (Still: talk, laugh, think). */
  reactions: readonly string[]
  /** Play a reaction in the preview; false when nothing is there to play it. */
  onTry: ((reaction: string) => boolean) | null
  onSave: (next: CohostPersona) => Promise<void>
}

/**
 * Reactions (plan 168 S-D2, D14): what the Golem does on stream when
 * something happens, one row per trigger. Each row picks one of the active
 * pack's reactions, None, or the default (D14's chain: the first id the
 * pack has, else a motion-only hop), and Try plays it in the preview.
 * Saves `persona.reactions` with no success toast.
 */
export function BuddyReactionsSection({
  persona,
  reactions,
  onTry,
  onSave
}: BuddyReactionsSectionProps): ReactElement {
  const [error, setError] = useState<string | null>(null)
  const table = persona.reactions
  const choosable = buddyChoosableReactions(reactions)
  const save = (trigger: BuddyTrigger, value: string): void => {
    setError(null)
    const next = withBuddyTriggerReaction(table, trigger, value)
    onSave({ ...persona, reactions: next }).catch((failure: unknown) =>
      setError(failure instanceof Error ? failure.message : 'Could not save the reactions.')
    )
  }
  return (
    <PanelSection
      description="What your Golem does on stream when something happens. Try plays it here."
      title="Reactions"
    >
      {BUDDY_TRIGGER_SECTIONS.map((section) => (
        <GroupedList key={section.label} label={section.label}>
          {section.triggers.map((trigger) => {
            const copy = BUDDY_TRIGGER_COPY[trigger]
            const override = table[trigger]
            const value = override ?? BUDDY_REACTION_DEFAULT_VALUE
            const missing =
              override && override !== BUDDY_REACTION_NONE && !choosable.includes(override)
            const outcome = buddyTriggerOutcome(trigger, table, reactions)
            const fallback = buddyTriggerOutcome(trigger, {}, reactions)
            const label = `${copy.title} reaction`
            return (
              <ListRow
                key={trigger}
                // The trigger's name never truncates; its detail gives way first.
                className="[&_[data-slot=list-row-title]]:shrink-0"
                context={copy.detail}
                data-testid="buddy-reaction-row"
                data-trigger={trigger}
                interactive={false}
                title={copy.title}
              >
                <Select value={value} onValueChange={(next) => save(trigger, next)}>
                  <SelectTrigger aria-label={label} className="w-40" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={BUDDY_REACTION_DEFAULT_VALUE}>
                        Default: {buddyOutcomeLabel(fallback)}
                      </SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      {choosable.map((id) => (
                        <SelectItem key={id} value={id}>
                          {buddyReactionLabel(id)}
                        </SelectItem>
                      ))}
                      {missing ? (
                        <SelectItem value={override}>
                          {buddyReactionLabel(override)} (not in this pack)
                        </SelectItem>
                      ) : null}
                      <SelectItem value={BUDDY_REACTION_NONE}>None</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Button
                  aria-label={`Try the ${copy.title.toLowerCase()} reaction`}
                  data-testid="buddy-reaction-try"
                  disabled={!onTry || outcome.kind === 'none'}
                  size="xs"
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    if (outcome.kind !== 'none') onTry?.(outcome.id)
                  }}
                >
                  <PlayIcon data-icon="inline-start" />
                  Try
                </Button>
              </ListRow>
            )
          })}
        </GroupedList>
      ))}
      {error ? (
        <p className="text-xs text-destructive" data-testid="buddy-reactions-error">
          {error}
        </p>
      ) : null}
    </PanelSection>
  )
}
