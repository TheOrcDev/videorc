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
import type { CohostPersona, GolemTrigger } from '@/lib/backend'
import {
  GOLEM_REACTION_DEFAULT_VALUE,
  GOLEM_TRIGGER_COPY,
  GOLEM_TRIGGER_SECTIONS,
  golemChoosableReactions,
  golemOutcomeLabel,
  golemReactionLabel,
  golemTriggerOutcome,
  withGolemTriggerReaction
} from '@/lib/golem-pet-view'
import { GOLEM_REACTION_NONE } from '../../../shared/golem-pet'

export interface GolemReactionsSectionProps {
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
export function GolemReactionsSection({
  persona,
  reactions,
  onTry,
  onSave
}: GolemReactionsSectionProps): ReactElement {
  const [error, setError] = useState<string | null>(null)
  const table = persona.reactions
  const choosable = golemChoosableReactions(reactions)
  const save = (trigger: GolemTrigger, value: string): void => {
    setError(null)
    const next = withGolemTriggerReaction(table, trigger, value)
    onSave({ ...persona, reactions: next }).catch((failure: unknown) =>
      setError(failure instanceof Error ? failure.message : 'Could not save the reactions.')
    )
  }
  return (
    <PanelSection
      description="What your Golem does on stream when something happens. Try plays it here."
      title="Reactions"
    >
      {GOLEM_TRIGGER_SECTIONS.map((section) => (
        <GroupedList key={section.label} label={section.label}>
          {section.triggers.map((trigger) => {
            const copy = GOLEM_TRIGGER_COPY[trigger]
            const override = table[trigger]
            const value = override ?? GOLEM_REACTION_DEFAULT_VALUE
            const missing =
              override && override !== GOLEM_REACTION_NONE && !choosable.includes(override)
            const outcome = golemTriggerOutcome(trigger, table, reactions)
            const fallback = golemTriggerOutcome(trigger, {}, reactions)
            const label = `${copy.title} reaction`
            return (
              <ListRow
                key={trigger}
                // The trigger's name never truncates; its detail gives way first.
                className="[&_[data-slot=list-row-title]]:shrink-0"
                context={copy.detail}
                data-testid="golem-reaction-row"
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
                      <SelectItem value={GOLEM_REACTION_DEFAULT_VALUE}>
                        Default: {golemOutcomeLabel(fallback)}
                      </SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      {choosable.map((id) => (
                        <SelectItem key={id} value={id}>
                          {golemReactionLabel(id)}
                        </SelectItem>
                      ))}
                      {missing ? (
                        <SelectItem value={override}>
                          {golemReactionLabel(override)} (not in this pack)
                        </SelectItem>
                      ) : null}
                      <SelectItem value={GOLEM_REACTION_NONE}>None</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Button
                  aria-label={`Try the ${copy.title.toLowerCase()} reaction`}
                  data-testid="golem-reaction-try"
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
        <p className="text-xs text-destructive" data-testid="golem-reactions-error">
          {error}
        </p>
      ) : null}
    </PanelSection>
  )
}
