import { PlayIcon } from '@/components/icons'
import { useState, type ReactElement } from 'react'

import { GroupedList, ListRow } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
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
import { inlineUserError } from '@/lib/user-error'
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
 * Reactions (plan 168 S-D2, D14): what the Buddy does on stream when
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
      setError(
        inlineUserError(failure, { action: 'save', object: 'the reactions' }, 'buddy-reactions')
      )
    )
  }
  return (
    <PanelSection
      description={`What ${persona.name} does on stream when something happens. Try plays it here.`}
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
            const defaultItem = {
              value: BUDDY_REACTION_DEFAULT_VALUE,
              label: `Default: ${buddyOutcomeLabel(fallback)}`
            }
            const reactionItems = [
              ...choosable.map((id) => ({ value: id, label: buddyReactionLabel(id) })),
              ...(missing
                ? [
                    {
                      value: override,
                      label: `${buddyReactionLabel(override)} (not in these moves)`
                    }
                  ]
                : []),
              { value: BUDDY_REACTION_NONE, label: 'None' }
            ]
            return (
              <ListRow
                key={trigger}
                // The trigger's name never truncates; its detail gives way first.
                className="[&_[data-slot=list-row-title]]:shrink-0"
                context={copy.detail}
                data-testid="buddy-reaction-row"
                data-trigger={trigger}
                title={copy.title}
              >
                <Select
                  items={[defaultItem, ...reactionItems]}
                  value={value}
                  onValueChange={(next) => {
                    if (next !== null) save(trigger, next)
                  }}
                >
                  <SelectTrigger aria-label={label} className="w-40" size="xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={defaultItem.value}>{defaultItem.label}</SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      {reactionItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
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
      {error ? <FieldError data-testid="buddy-reactions-error">{error}</FieldError> : null}
    </PanelSection>
  )
}
