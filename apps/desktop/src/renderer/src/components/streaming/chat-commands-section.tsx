import { useEffect, useState, type ReactElement } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { ChatIcon, DeleteIcon, EditIcon } from '@/components/icons'
import { KebabMenu, type KebabMenuItem } from '@/components/kebab-menu'
import { GroupedList, ListRow, ListRowButton } from '@/components/list-row'
import { OfflineAlert } from '@/components/lock-alert'
import { PanelSection } from '@/components/panel-section'
import { ChatCommandDialog } from '@/components/streaming/chat-command-dialog'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { FieldError, FieldGroup, SettingsRow } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { smoothScrollBehavior } from '@/hooks/use-reduced-motion'
import { useChatCommands } from '@/hooks/use-chat-commands'
import { CHAT_COMMANDS_SECTION_ID, type ChatCommandsStore } from '@/lib/chat-commands-store'
import { OFFLINE_REASON } from '@/lib/user-error'
import { CHAT_COMMAND_MAX_COUNT, type ChatCommand } from '../../../../shared/chat-commands'

/** The sentence under Add command…: what a command does, in one breath. */
export const CHAT_COMMANDS_HELP =
  'Viewers type !name in chat. Videorc answers as you, starting with @their name, in the chat they asked in.'

/** Why Add command… is off, or null when it can open. */
export function chatCommandAddBlockedReason(state: {
  offline: boolean
  /** The list has been read: a new name is checked against it. */
  loaded: boolean
  count: number
}): string | null {
  if (state.offline) return OFFLINE_REASON
  if (!state.loaded) return 'Your chat commands are still loading.'
  if (state.count >= CHAT_COMMAND_MAX_COUNT) {
    return `You can have up to ${CHAT_COMMAND_MAX_COUNT} commands. Delete one to add another.`
  }
  return null
}

/**
 * Livestream → Setup → Chat commands (plan 226 S3): a viewer types `!go` and
 * Videorc answers as the streamer with the reply saved here. The `!commands`
 * switch, the commands A–Z (each with its own switch, a click to edit and ⋯
 * Edit… and Delete), and Add command…. Free, and editable while live: a
 * change answers the next `!name`.
 */
export function ChatCommandsSection({ store }: { store?: ChatCommandsStore }): ReactElement {
  const view = useChatCommands(store)
  const { state, revealPending, revealHandled } = view
  const offline = !view.online
  const commands = state?.commands ?? []
  const [editing, setEditing] = useState<ChatCommand | 'new' | null>(null)
  const [deleting, setDeleting] = useState<ChatCommand | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const addReason = chatCommandAddBlockedReason({
    offline,
    loaded: state !== null,
    count: commands.length
  })

  // The Stream Manager's ⋯ Chat commands… lands here (plan 226 S4).
  useEffect(() => {
    if (!revealPending) return
    const section = document.getElementById(CHAT_COMMANDS_SECTION_ID)
    section?.scrollIntoView({ behavior: smoothScrollBehavior(), block: 'start' })
    section?.focus({ preventScroll: true })
    revealHandled()
  }, [revealHandled, revealPending])

  const deleteCommand = (): void => {
    const command = deleting
    if (!command || deletePending) return
    setDeletePending(true)
    void view.remove(command).finally(() => {
      setDeletePending(false)
      setDeleting(null)
    })
  }

  return (
    <div
      aria-label="Chat commands"
      className="outline-none"
      data-testid="chat-commands-section"
      id={CHAT_COMMANDS_SECTION_ID}
      role="group"
      tabIndex={-1}
    >
      <PanelSection icon={ChatIcon} title="Chat commands">
        {offline ? <OfflineAlert /> : null}
        {state ? (
          <>
            <FieldGroup variant="grouped">
              <SettingsRow description="Lists your commands in chat." label="Answer !commands">
                <Switch
                  checked={state.listEnabled}
                  data-testid="chat-commands-list-enabled"
                  disabled={offline}
                  onCheckedChange={(enabled) => void view.setListEnabled(enabled)}
                />
              </SettingsRow>
            </FieldGroup>
            {commands.length > 0 ? (
              <GroupedList data-testid="chat-commands-list">
                {commands.map((command) => (
                  <ChatCommandRow
                    command={command}
                    disabled={offline}
                    key={command.id}
                    onDelete={() => setDeleting(command)}
                    onEdit={() => setEditing(command)}
                    onToggle={(enabled) => void view.setEnabled(command, enabled)}
                  />
                ))}
              </GroupedList>
            ) : (
              <Empty className="py-4" data-testid="chat-commands-empty">
                <EmptyDescription>No commands yet.</EmptyDescription>
              </Empty>
            )}
          </>
        ) : view.loadFailed ? (
          <div className="flex flex-col items-start gap-2">
            <FieldError>Couldn&apos;t read your chat commands.</FieldError>
            <Button variant="outline" onClick={view.reload}>
              Try again
            </Button>
          </div>
        ) : offline ? null : (
          <p className="text-meta text-muted-foreground" role="status">
            Loading chat commands…
          </p>
        )}
        {view.error ? <FieldError>{view.error}</FieldError> : null}
        <div className="flex flex-col items-start gap-2">
          <DisabledReason reason={addReason}>
            <Button
              data-testid="chat-command-add"
              disabled={addReason !== null}
              variant="outline"
              onClick={() => setEditing('new')}
            >
              Add command…
            </Button>
          </DisabledReason>
          <p className="text-meta text-muted-foreground">{CHAT_COMMANDS_HELP}</p>
        </div>
      </PanelSection>
      {editing ? (
        <ChatCommandDialog
          command={editing === 'new' ? null : editing}
          existing={commands}
          onClose={() => setEditing(null)}
          onSave={view.save}
        />
      ) : null}
      <ConfirmDialog
        cancelDisabled={deletePending}
        confirmDisabled={deletePending}
        confirmLabel={deletePending ? 'Deleting…' : 'Delete command'}
        description={
          deleting
            ? `Its reply is deleted, and viewers who type !${deleting.name} get no answer.`
            : ''
        }
        open={deleting !== null}
        testId="chat-command-delete"
        title={deleting ? `Delete !${deleting.name}?` : 'Delete command?'}
        onCancel={() => {
          if (!deletePending) setDeleting(null)
        }}
        onConfirm={deleteCommand}
      />
    </div>
  )
}

/**
 * One command: `!name` and its description, its own switch, and ⋯ Edit… and
 * Delete. The name is the row's button, stretched over it, so a click
 * anywhere opens the editor; the switch and the ⋯ sit above it.
 */
export function ChatCommandRow({
  command,
  disabled,
  onEdit,
  onToggle,
  onDelete
}: {
  command: ChatCommand
  /** Videorc is reconnecting: the section's alert says so, and nothing here acts. */
  disabled: boolean
  onEdit: () => void
  onToggle: (enabled: boolean) => void
  onDelete: () => void
}): ReactElement {
  const items: KebabMenuItem[] = [
    { id: 'edit', label: 'Edit…', icon: EditIcon, onSelect: onEdit },
    { id: 'delete', label: 'Delete', icon: DeleteIcon, destructive: true, onSelect: onDelete }
  ]
  return (
    <ListRow
      className="group/kebab-host relative"
      context={command.description}
      data-chat-command={command.name}
      interactive={!disabled}
      title={
        <ListRowButton aria-label={`Edit !${command.name}`} disabled={disabled} onClick={onEdit}>
          !{command.name}
        </ListRowButton>
      }
    >
      {/* Its hit area spills only 4 px toward the ⋯ beside it (plan 213 A4). */}
      <Switch
        aria-label={`Answer !${command.name}`}
        checked={command.enabled}
        className="after:-right-1"
        disabled={disabled}
        onCheckedChange={onToggle}
      />
      <KebabMenu
        className="relative z-10"
        disabled={disabled}
        items={items}
        label={`Actions for !${command.name}`}
        reveal="hover"
      />
    </ListRow>
  )
}
