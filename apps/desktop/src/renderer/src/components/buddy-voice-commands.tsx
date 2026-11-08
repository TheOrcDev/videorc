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
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
} from '@/lib/buddy-command-view'
import {
  BUDDY_REMOVAL_FALLBACK,
  BUDDY_REMOVE_MESSAGES_NO_ACCOUNT,
  BUDDY_VOICE_COMMANDS,
  BUDDY_VOICE_COMMANDS_DESCRIPTION,
  BUDDY_VOICE_COMMANDS_OFF,
  BUDDY_VOICE_PREMIUM,
  buddyVoicePhrasesLabel,
  buddyWakeWordsLine,
  removeMessagesRows,
  type RemoveMessagesRow
} from '@/lib/buddy-tab-view'
import { buddyTabLabel } from '@/lib/buddy-tabs'
import { toastUserError } from '@/lib/user-error'
import { permissionReconnectOptions } from '../../../shared/platform-scopes'

const REMOVE_CONFIRM_MODES: readonly RemoveConfirmMode[] = ['confirm', 'countdown']

// A platform's name never gives way (they are one short word); the account
// name truncates first.
const PLATFORM_NAME_STAYS = '[&_[data-slot=list-row-title]]:shrink-0'

/**
 * The Buddy tab's Voice tab (plan 140 S6, plan 150 S5), in Settings' two
 * columns. Commands: what you can say, each phrase over what it does, then the
 * two settings (the wake word and how a removal is confirmed). Remove
 * messages: whether each platform lets Buddy remove messages (with its one
 * fix), its limits as the section's description. Above both, one reason when
 * voice commands can't run: locked (`lead`, from the tab), Buddy Live off, or
 * Videorc's kill switches.
 */
export function BuddyVoiceCommands({
  lead = null,
  onOpenLive
}: {
  /** The tab's locked alert, given only while Buddy is locked (plan 150, D7). */
  lead?: ReactNode
  /** Opens the first tab, where Buddy Live lives, from the "turn on Buddy Live" alert. */
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
      toastUserError(
        error,
        { action: 'save', object: 'the voice command setting' },
        { id: 'buddy-voice-setting' }
      )
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
        toastUserError(
          error,
          { action: 'open', object: `the ${row.label} page` },
          { id: `buddy-reconnect:${row.platform}` }
        )
      )
      .finally(() => setPending(null))
  }

  const hasLead = lead !== null || off || paused.length > 0

  return (
    <div className="flex flex-1 flex-col" data-slot="buddy-voice-commands">
      {hasLead ? (
        <div className="flex flex-col gap-2 border-b border-border p-gutter">
          {lead}
          {off ? (
            <Alert data-testid="buddy-voice-commands-off" variant="quiet">
              <AlertTitle>{BUDDY_VOICE_COMMANDS_OFF}</AlertTitle>
              {onOpenLive ? (
                <AlertAction>
                  <Button size="xs" type="button" variant="outline" onClick={onOpenLive}>
                    Go to {buddyTabLabel('live')}
                  </Button>
                </AlertAction>
              ) : null}
            </Alert>
          ) : null}
          {paused.map((line) => (
            <p
              key={line}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              data-slot="buddy-voice-commands-paused"
            >
              <StatusDot tone="warn" />
              {line}
            </p>
          ))}
        </div>
      ) : null}

      <ConfigGrid className={CONFIG_GRID_PAIR}>
        <PanelSection
          description={`${buddyWakeWordsLine(cohostSettings?.persona.name)} ${BUDDY_VOICE_COMMANDS_DESCRIPTION} ${COHOST_ACTS_ON_ASK_COPY}`}
          title="Commands"
        >
          <GroupedList label="What you can say">
            {/* Plan 174 F-28: a ListRow (the command and what it does), then
                every phrase in plain secondary text, never in a tooltip. */}
            {BUDDY_VOICE_COMMANDS.map((command) => (
              <div
                key={command.title}
                className="flex min-w-0 flex-col pb-2"
                data-command={command.title.toLowerCase()}
                data-slot="buddy-voice-command"
              >
                <ListRow compact context={command.result} title={command.title} />
                <p className="px-3 text-xs text-muted-foreground" data-slot="buddy-voice-phrases">
                  {buddyVoicePhrasesLabel(command.phrases)}
                </p>
              </div>
            ))}
          </GroupedList>

          <FieldGroup variant="grouped">
            <Field>
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <FieldLabel htmlFor="buddy-wake-word">{WAKE_WORD_LABEL}</FieldLabel>
                  <p className="text-xs text-muted-foreground">{WAKE_WORD_DESCRIPTION}</p>
                </div>
                <Switch
                  checked={cohostSettings?.wakeWordRequired === true}
                  disabled={locked}
                  id="buddy-wake-word"
                  onCheckedChange={(wakeWordRequired) => save({ wakeWordRequired })}
                />
              </div>
            </Field>
            <Field>
              <FieldLabel>Before Buddy removes a comment</FieldLabel>
              <FieldDescription>
                {REMOVE_CONFIRM_DESCRIPTIONS[removeConfirm]} {YOUTUBE_ALWAYS_CONFIRMS}
              </FieldDescription>
              <SegmentedControl
                className="w-fit"
                disabled={locked}
                id="buddy-remove-confirm"
                options={REMOVE_CONFIRM_MODES.map((mode) => ({
                  value: mode,
                  label: REMOVE_CONFIRM_LABELS[mode]
                }))}
                size="sm"
                value={removeConfirm}
                onValueChange={(next) => save({ removeConfirm: next })}
              />
            </Field>
          </FieldGroup>
        </PanelSection>

        <PanelSection
          description={
            <span className="flex flex-col gap-1">
              <span data-slot="buddy-voice-commands-notes">
                {removalLimitsLine(removeConfirm)} {BUDDY_REMOVAL_FALLBACK}
              </span>
              <span data-slot="buddy-voice-commands-premium">{BUDDY_VOICE_PREMIUM}</span>
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
                {BUDDY_REMOVE_MESSAGES_NO_ACCOUNT}
              </p>
            ) : (
              rows.map((row) => (
                <ListRow
                  key={row.platform}
                  compact
                  className={PLATFORM_NAME_STAYS}
                  context={row.accountLabel ?? undefined}
                  data-platform={row.platform}
                  data-ready={row.ready || undefined}
                  icon={<ChatPlatformIcon decorative platform={row.platform} />}
                  meta={
                    <StatusDot
                      className="whitespace-nowrap"
                      label={row.status}
                      tone={row.ready ? 'good' : 'warn'}
                    />
                  }
                  title={row.label}
                >
                  {row.action ? (
                    // The fix as a sentence stays on the button (its name and
                    // tooltip); the row itself says only the short status.
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-label={row.message}
                            disabled={pending !== null}
                            size="xs"
                            type="button"
                            variant="outline"
                            onClick={() => fix(row)}
                          />
                        }
                      >
                        {row.action.label}
                      </TooltipTrigger>
                      <TooltipContent>{row.message}</TooltipContent>
                    </Tooltip>
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
