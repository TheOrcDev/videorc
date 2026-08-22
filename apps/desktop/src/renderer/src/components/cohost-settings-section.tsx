import { Robot, WarningCircle } from '@phosphor-icons/react'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useStudioCore } from '@/hooks/use-studio'
import type { CohostTone } from '@/lib/backend'
import { cn } from '@/lib/utils'

export const COHOST_NOTES_MAX_CHARS = 4000

const TONE_LABELS: Record<CohostTone, string> = {
  friendly: 'Friendly',
  short: 'Short',
  professional: 'Professional'
}

/**
 * Settings → Co-host. Persisted per profile through `cohost.settings.get/set`
 * (the engine reads the same row when it builds a tick), NOT through local
 * settings — so what the streamer types here is what the model is given.
 */
export function CohostSettingsSection(): ReactElement | null {
  const { cohostSettings, cohostGate, patchCohostSettings } = useStudioCore()
  const [notesDraft, setNotesDraft] = useState('')
  const [notesError, setNotesError] = useState<string | null>(null)
  const savedNotesRef = useRef<string | null>(null)

  // Follow the backend value until the streamer starts typing; after that the
  // draft is the truth until it is saved.
  useEffect(() => {
    const notes = cohostSettings?.notes ?? ''
    if (savedNotesRef.current === notes) return
    savedNotesRef.current = notes
    setNotesDraft(notes)
  }, [cohostSettings?.notes])

  if (!cohostSettings) {
    return null
  }

  const locked = !cohostGate.allowed
  const notesOverLimit = notesDraft.length > COHOST_NOTES_MAX_CHARS
  const notesDirty = notesDraft !== (cohostSettings.notes ?? '')

  const save = (patch: Parameters<typeof patchCohostSettings>[0]): void => {
    setNotesError(null)
    void patchCohostSettings(patch).catch((error: unknown) =>
      setNotesError(error instanceof Error ? error.message : 'Could not save co-host settings.')
    )
  }

  return (
    <PanelSection
      description="Alpha — expect rough edges. An AI producer reads your live chat, groups the questions people are actually asking, and drafts replies you approve. Nothing is ever sent without you."
      icon={Robot}
      title="Co-host (alpha)"
    >
      {locked ? (
        <Alert variant="warning">
          <WarningCircle weight="fill" />
          <AlertTitle>Premium co-host</AlertTitle>
          <AlertDescription>
            {cohostGate.allowed ? null : cohostGate.reason}
            {!cohostGate.allowed && cohostGate.upgradeUrl ? (
              <Button
                className="ml-2 h-auto p-0 align-baseline"
                size="xs"
                variant="link"
                onClick={() => openExternalUrl(cohostGate.upgradeUrl as string)}
              >
                View Premium
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <FieldGroup>
        <Field>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <FieldLabel htmlFor="cohost-enabled">Enable co-host</FieldLabel>
              <p className="text-xs text-muted-foreground">
                Starts with your next livestream. Uses cloud AI, so it also needs the cloud-AI
                consent you set in Publish.
              </p>
            </div>
            <Switch
              checked={cohostSettings.enabled}
              disabled={locked}
              id="cohost-enabled"
              onCheckedChange={(enabled) => save({ enabled })}
            />
          </div>
        </Field>

        <Field>
          <FieldLabel htmlFor="cohost-tone">Reply tone</FieldLabel>
          <FieldDescription>How the drafted replies read before you edit them.</FieldDescription>
          <ToggleGroup
            className="w-fit"
            disabled={locked}
            id="cohost-tone"
            size="sm"
            type="single"
            value={cohostSettings.tone}
            onValueChange={(tone) => {
              if (tone) save({ tone: tone as CohostTone })
            }}
          >
            {(Object.keys(TONE_LABELS) as CohostTone[]).map((tone) => (
              <ToggleGroupItem key={tone} className="px-3 text-xs" value={tone}>
                {TONE_LABELS[tone]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>

        <Field>
          <FieldLabel htmlFor="cohost-notes">Co-host notes</FieldLabel>
          <FieldDescription>
            Facts the co-host answers from, one per line. For example:
            <br />
            <span className="text-subtle">Keyboard: Keychron Q1 with Boba U4T switches.</span>
            <br />
            <span className="text-subtle">
              Streaming schedule: Tuesdays and Fridays, 19:00 CET.
            </span>
          </FieldDescription>
          <Textarea
            className="min-h-28"
            disabled={locked}
            id="cohost-notes"
            maxLength={COHOST_NOTES_MAX_CHARS}
            placeholder="What people keep asking you — gear, schedule, links, prices…"
            value={notesDraft}
            onBlur={() => {
              if (!notesDirty || notesOverLimit) return
              savedNotesRef.current = notesDraft
              save({ notes: notesDraft })
            }}
            onChange={(event) => setNotesDraft(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'text-xs tabular-nums',
                notesOverLimit ? 'text-destructive' : 'text-subtle'
              )}
            >
              {notesDraft.length}/{COHOST_NOTES_MAX_CHARS}
            </span>
            {notesDirty ? (
              <span className="text-xs text-muted-foreground">Unsaved — click away to save.</span>
            ) : null}
            {notesError ? <span className="text-xs text-destructive">{notesError}</span> : null}
          </div>
        </Field>

        <Field>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <FieldLabel htmlFor="cohost-auto-highlight">
                Show questions on stream automatically
              </FieldLabel>
              <p className="text-xs text-muted-foreground">
                Puts one new high-priority question on the stream by itself. Off by default — with
                it off, you show a question with H.
              </p>
            </div>
            <Switch
              checked={cohostSettings.autoHighlight}
              disabled={locked}
              id="cohost-auto-highlight"
              onCheckedChange={(autoHighlight) => save({ autoHighlight })}
            />
          </div>
        </Field>
      </FieldGroup>
    </PanelSection>
  )
}

function openExternalUrl(url: string): void {
  const opener = window.videorc?.openOAuthUrl
  if (opener) {
    void opener(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
