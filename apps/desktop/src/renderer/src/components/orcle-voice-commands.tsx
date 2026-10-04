import { useState, type ReactElement } from 'react'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import { GroupedList, ListRow } from '@/components/list-row'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useStudioChat, useStudioCore } from '@/hooks/use-studio'
import type { CohostSettingsPatch, RemoveConfirmMode } from '@/lib/backend'
import { COHOST_ACTS_ON_ASK_COPY } from '@/lib/cohost-view'
import {
  REMOVE_CONFIRM_DESCRIPTIONS,
  REMOVE_CONFIRM_LABELS,
  WAKE_WORD_DESCRIPTION,
  WAKE_WORD_LABEL,
  YOUTUBE_ALWAYS_CONFIRMS,
  commandAvailabilityLines,
  removalLimitsLine
} from '@/lib/orcle-command-view'
import {
  ORCLE_REMOVAL_FALLBACK,
  ORCLE_REMOVE_MESSAGES_NO_ACCOUNT,
  ORCLE_VOICE_COMMANDS,
  ORCLE_VOICE_COMMANDS_DESCRIPTION,
  ORCLE_VOICE_COMMANDS_OFF,
  ORCLE_VOICE_PREMIUM,
  orcleVoicePhrasesLabel,
  removeMessagesRows,
  type RemoveMessagesRow
} from '@/lib/orcle-tab-view'
import { toast } from '@/lib/toast'
import { permissionReconnectOptions } from '../../../shared/platform-scopes'

const REMOVE_CONFIRM_MODES: readonly RemoveConfirmMode[] = ['confirm', 'countdown']

/**
 * Voice commands inside Orcle Live (plan 140, S6): what you can say, whether
 * each platform lets Orcle remove messages (with its one fix), the two
 * settings (the wake word and how a removal is confirmed) and Videorc's kill
 * switches when they are on.
 */
export function OrcleVoiceCommands(): ReactElement {
  const {
    cohostSettings,
    cohostGate,
    patchCohostSettings,
    platformAccounts,
    xNativeCapability,
    connectPlatformAccount,
    authorizeXLive
  } = useStudioCore()
  const rows = removeMessagesRows(platformAccounts ?? [], {
    xLiveAuthorized: xNativeCapability?.nativeAvailable
  })
  const [pending, setPending] = useState<string | null>(null)
  const { cohostState } = useStudioChat()
  const paused = commandAvailabilityLines(cohostState?.commandAvailability)
  const locked = cohostGate?.allowed === false || !cohostSettings
  const removeConfirm = cohostSettings?.removeConfirm ?? 'confirm'
  const save = (patch: CohostSettingsPatch): void => {
    void patchCohostSettings?.(patch).catch((error: unknown) =>
      toast.error('Could not save the voice command setting', {
        description: error instanceof Error ? error.message : undefined
      })
    )
  }

  const fix = (row: RemoveMessagesRow): void => {
    const run =
      row.action?.kind === 'authorize-x'
        ? authorizeXLive?.()
        : connectPlatformAccount?.(row.platform, permissionReconnectOptions(row.platform))
    if (!run) return
    setPending(row.platform)
    void run
      .catch((error: unknown) =>
        toast.error(`Could not reconnect ${row.label}`, {
          description: error instanceof Error ? error.message : undefined
        })
      )
      .finally(() => setPending(null))
  }

  return (
    <div
      className="flex flex-col gap-3 border-t border-border pt-3"
      data-slot="orcle-voice-commands"
    >
      <header className="flex flex-col gap-0.5">
        <h4 className="text-[13px] leading-5 font-semibold text-foreground">Voice commands</h4>
        <p className="text-xs text-muted-foreground">
          {ORCLE_VOICE_COMMANDS_DESCRIPTION} {COHOST_ACTS_ON_ASK_COPY}
        </p>
        {cohostSettings?.enabled === true ? null : (
          <p className="text-xs text-subtle" data-slot="orcle-voice-commands-off">
            {ORCLE_VOICE_COMMANDS_OFF}
          </p>
        )}
        {paused.map((line) => (
          <p
            key={line}
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            data-slot="orcle-voice-commands-paused"
          >
            <StatusDot tone="warn" />
            {line}
          </p>
        ))}
      </header>

      <GroupedList label="What you can say">
        {ORCLE_VOICE_COMMANDS.map((command) => (
          <ListRow
            key={command.title}
            compact
            context={
              <span title={command.phrases.map((phrase) => `“${phrase}”`).join('\n')}>
                {orcleVoicePhrasesLabel(command.phrases, command.title === 'Answer' ? 4 : 1)}
              </span>
            }
            data-command={command.title.toLowerCase()}
            interactive={false}
            meta={command.result}
            title={command.title}
          />
        ))}
      </GroupedList>

      <GroupedList label="Remove messages">
        {rows.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground" data-slot="remove-messages-empty">
            {ORCLE_REMOVE_MESSAGES_NO_ACCOUNT}
          </p>
        ) : (
          rows.map((row) => (
            <ListRow
              key={row.platform}
              compact
              context={row.accountLabel ?? undefined}
              data-platform={row.platform}
              data-ready={row.ready || undefined}
              icon={<ChatPlatformIcon decorative platform={row.platform} />}
              interactive={false}
              meta={
                row.ready ? (
                  <StatusDot label={row.message} tone="good" />
                ) : (
                  <span className="text-muted-foreground">{row.message}</span>
                )
              }
              title={row.label}
            >
              {row.action ? (
                <Button
                  disabled={pending !== null}
                  size="xs"
                  type="button"
                  variant="outline"
                  onClick={() => fix(row)}
                >
                  {row.action.label}
                </Button>
              ) : null}
            </ListRow>
          ))
        )}
      </GroupedList>
      <p className="text-xs text-subtle" data-slot="orcle-voice-commands-notes">
        {removalLimitsLine(removeConfirm)} {ORCLE_REMOVAL_FALLBACK}
      </p>

      <FieldGroup variant="grouped" data-slot="orcle-voice-commands-settings">
        <Field>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <FieldLabel htmlFor="orcle-wake-word">{WAKE_WORD_LABEL}</FieldLabel>
              <p className="text-xs text-muted-foreground">{WAKE_WORD_DESCRIPTION}</p>
            </div>
            <Switch
              checked={cohostSettings?.wakeWordRequired === true}
              disabled={locked}
              id="orcle-wake-word"
              onCheckedChange={(wakeWordRequired) => save({ wakeWordRequired })}
            />
          </div>
        </Field>
        <Field>
          <FieldLabel htmlFor="orcle-remove-confirm">Before Orcle removes a comment</FieldLabel>
          <FieldDescription>
            {REMOVE_CONFIRM_DESCRIPTIONS[removeConfirm]} {YOUTUBE_ALWAYS_CONFIRMS}
          </FieldDescription>
          <ToggleGroup
            className="w-fit"
            disabled={locked}
            id="orcle-remove-confirm"
            size="sm"
            type="single"
            value={removeConfirm}
            onValueChange={(value) => {
              if (value === 'confirm' || value === 'countdown') save({ removeConfirm: value })
            }}
          >
            {REMOVE_CONFIRM_MODES.map((mode) => (
              <ToggleGroupItem key={mode} className="px-3 text-xs" value={mode}>
                {REMOVE_CONFIRM_LABELS[mode]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
      </FieldGroup>

      <p className="text-xs text-subtle" data-slot="orcle-voice-commands-premium">
        {ORCLE_VOICE_PREMIUM}
      </p>
    </div>
  )
}
