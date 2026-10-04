import { useState, type ReactElement } from 'react'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import { GroupedList, ListRow } from '@/components/list-row'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { useStudioCore } from '@/hooks/use-studio'
import { COHOST_ACTS_ON_ASK_COPY } from '@/lib/cohost-view'
import {
  ORCLE_REMOVAL_FALLBACK,
  ORCLE_REMOVAL_LIMITS,
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

/**
 * Voice commands inside Orcle Live (plan 140, S6 part A): what you can say,
 * and whether each platform lets Orcle remove messages, with its one fix.
 *
 * Part B adds, in the marked slot below: the settings ("Commands need
 * "Orcle" first", and the confirmation mode "Confirm first" / "5-second
 * countdown") and the kill-switch status line.
 */
export function OrcleVoiceCommands(): ReactElement {
  const {
    cohostSettings,
    platformAccounts,
    xNativeCapability,
    connectPlatformAccount,
    authorizeXLive
  } = useStudioCore()
  const rows = removeMessagesRows(platformAccounts ?? [], {
    xLiveAuthorized: xNativeCapability?.nativeAvailable
  })
  const [pending, setPending] = useState<string | null>(null)

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
        {ORCLE_REMOVAL_LIMITS} {ORCLE_REMOVAL_FALLBACK}
      </p>

      {/* Plan 140, S6 part B: the voice-command settings go here, under the
          readiness rows: the "Commands need "Orcle" first" switch
          (`wakeWordRequired`) and the confirmation mode, "Confirm first" or
          "5-second countdown" (`removeConfirm`, a segmented Tabs), plus the
          kill-switch status line ("Removing messages is paused by Videorc.").
          The 20-second line above then names the countdown when it is on. */}

      <p className="text-xs text-subtle" data-slot="orcle-voice-commands-premium">
        {ORCLE_VOICE_PREMIUM}
      </p>
    </div>
  )
}
