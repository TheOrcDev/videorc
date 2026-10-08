import { InfoIcon } from '@/components/icons'
import { useState, type ReactElement, type ReactNode } from 'react'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import { GroupedList, ListRow } from '@/components/list-row'
import { ConfigGrid, CONFIG_GRID_PAIR } from '@/components/page'
import { PanelSection } from '@/components/panel-section'
import { StatusDot } from '@/components/status-dot'
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
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
 * The Golem tab's Voice tab (plan 140 S6, plan 150 S5), in Settings' two
 * columns. Commands: what you can say, each phrase over what it does, then the
 * two settings (the wake word and how a removal is confirmed). Remove
 * messages: whether each platform lets Golem remove messages (with its one
 * fix), its limits as the section's description. Above both, one reason when
 * voice commands can't run: locked (`lead`, from the tab), Golem Live off, or
 * Videorc's kill switches.
 */
export function OrcleVoiceCommands({
  lead = null,
  onOpenLive
}: {
  /** The tab's locked alert, given only while Golem is locked (plan 150, D7). */
  lead?: ReactNode
  /** Opens the Live tab, from the "turn on Golem Live" alert. */
  onOpenLive?: () => void
}): ReactElement {
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
  const locked = lead !== null || cohostGate?.allowed === false || !cohostSettings
  const off = !locked && cohostSettings?.enabled !== true
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

  const hasLead = lead !== null || off || paused.length > 0

  return (
    <div className="flex flex-1 flex-col" data-slot="orcle-voice-commands">
      {hasLead ? (
        <div className="flex flex-col gap-2 border-b border-border p-gutter">
          {lead}
          {off ? (
            <Alert data-testid="orcle-voice-commands-off">
              <InfoIcon />
              <AlertTitle className="font-normal text-muted-foreground">
                {ORCLE_VOICE_COMMANDS_OFF}
              </AlertTitle>
              {onOpenLive ? (
                <AlertAction>
                  <Button size="xs" type="button" variant="outline" onClick={onOpenLive}>
                    Go to Live
                  </Button>
                </AlertAction>
              ) : null}
            </Alert>
          ) : null}
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
        </div>
      ) : null}

      <ConfigGrid className={CONFIG_GRID_PAIR}>
        <PanelSection
          description={`${ORCLE_VOICE_COMMANDS_DESCRIPTION} ${COHOST_ACTS_ON_ASK_COPY}`}
          title="Commands"
        >
          <GroupedList label="What you can say">
            {ORCLE_VOICE_COMMANDS.map((command) => (
              <div
                key={command.title}
                className="flex min-w-0 flex-col gap-0.5 px-3 py-2"
                data-command={command.title.toLowerCase()}
                data-slot="orcle-voice-command"
              >
                <p className="flex min-w-0 items-baseline gap-2 text-sm">
                  <span className="shrink-0 font-medium text-foreground">{command.title}</span>
                  <span
                    className="truncate text-muted-foreground"
                    title={command.phrases.map((phrase) => `“${phrase}”`).join('\n')}
                  >
                    {orcleVoicePhrasesLabel(command.phrases, command.title === 'Answer' ? 4 : 1)}
                  </span>
                </p>
                <p className="text-xs text-subtle">{command.result}</p>
              </div>
            ))}
          </GroupedList>

          <FieldGroup variant="grouped">
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
              <FieldLabel htmlFor="orcle-remove-confirm">Before Golem removes a comment</FieldLabel>
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
        </PanelSection>

        <PanelSection
          description={
            <span className="flex flex-col gap-1">
              <span data-slot="orcle-voice-commands-notes">
                {removalLimitsLine(removeConfirm)} {ORCLE_REMOVAL_FALLBACK}
              </span>
              <span data-slot="orcle-voice-commands-premium">{ORCLE_VOICE_PREMIUM}</span>
            </span>
          }
          title="Remove messages"
        >
          <GroupedList>
            {rows.length === 0 ? (
              <p
                className="px-3 py-2 text-xs text-muted-foreground"
                data-slot="remove-messages-empty"
              >
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
        </PanelSection>
      </ConfigGrid>
    </div>
  )
}
