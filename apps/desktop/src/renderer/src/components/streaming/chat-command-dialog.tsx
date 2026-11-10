import { useLayoutEffect, useRef, useState, type ReactElement } from 'react'

import { AlertIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText
} from '@/components/ui/input-group'
import { Textarea } from '@/components/ui/textarea'
import type { ChatCommandSaveRefusal } from '@/hooks/use-chat-commands'
import { plural } from '@/lib/format'
import {
  chatCommandNeedsTwoXPosts,
  chatCommandOneLine,
  chatCommandReplyRoom,
  normalizeChatCommandName,
  validateChatCommandDraft,
  type ChatCommand,
  type ChatCommandDraftErrors,
  type ChatCommandSaveParams
} from '../../../../shared/chat-commands'

type FieldName = keyof ChatCommandDraftErrors
const EVERY_FIELD: Record<FieldName, true> = { name: true, description: true, reply: true }

/** The reply counter's words: what is left, or how far over it is. */
export function chatCommandRoomLabel(reply: string): string {
  const room = chatCommandReplyRoom(reply)
  return room >= 0 ? `${plural(room, 'character')} left` : `${plural(-room, 'character')} over`
}

/**
 * Add command and Edit (plan 226 S3): the name after a fixed `!`, the
 * description `!commands` shows, and the one-line reply with its room, the
 * X note and a preview of how chat shows it. A field's error waits for its
 * first blur or for Save; a refusal from Videorc goes under its field.
 */
export function ChatCommandDialog({
  command,
  existing,
  onSave,
  onClose
}: {
  /** The command being edited; null adds one. */
  command: ChatCommand | null
  /** Every saved command, for the duplicate name. */
  existing: readonly ChatCommand[]
  onSave: (params: ChatCommandSaveParams) => Promise<ChatCommandSaveRefusal | null>
  onClose: () => void
}): ReactElement {
  const [name, setName] = useState(command?.name ?? '')
  const [description, setDescription] = useState(command?.description ?? '')
  const [reply, setReply] = useState(command?.reply ?? '')
  const [touched, setTouched] = useState<Partial<Record<FieldName, true>>>({})
  const [refusal, setRefusal] = useState<ChatCommandSaveRefusal | null>(null)
  const [saving, setSaving] = useState(false)
  const draft = { id: command?.id, name, description, reply }
  const errors = validateChatCommandDraft(draft, existing) ?? {}
  const shown = (field: FieldName): string | undefined =>
    refusal?.field === field ? refusal.message : touched[field] ? errors[field] : undefined
  const touch = (field: FieldName) => () =>
    setTouched((current) => (current[field] ? current : { ...current, [field]: true }))
  const edited = (field: FieldName): void => {
    if (refusal?.field === field) setRefusal(null)
  }

  // A line break typed or pasted into the reply becomes a space where it was,
  // and the caret stays where the typing left it.
  const replyRef = useRef<HTMLTextAreaElement>(null)
  const replyCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (replyCaret.current === null) return
    replyRef.current?.setSelectionRange(replyCaret.current, replyCaret.current)
    replyCaret.current = null
  })

  const submit = async (): Promise<void> => {
    if (saving) return
    setTouched(EVERY_FIELD)
    setRefusal(null)
    if (validateChatCommandDraft(draft, existing)) return
    setSaving(true)
    const refused = await onSave({
      ...(command ? { id: command.id } : {}),
      name: normalizeChatCommandName(name),
      description: description.trim(),
      reply: reply.trim(),
      enabled: command?.enabled ?? true
    })
    setSaving(false)
    if (refused) setRefusal(refused)
    else onClose()
  }

  const room = chatCommandReplyRoom(reply)
  const nameError = shown('name')
  const descriptionError = shown('description')
  const replyError = shown('reply')
  const preview = reply.trim()

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent aria-describedby={undefined} data-testid="chat-command-dialog" size="md">
        <form
          className="flex min-h-0 flex-col gap-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <DialogHeader>
            <DialogTitle>{command ? `Edit !${command.name}` : 'Add command'}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <FieldGroup className="gap-4">
              <Field data-invalid={nameError ? true : undefined}>
                <FieldLabel>Name</FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <InputGroupText>!</InputGroupText>
                  </InputGroupAddon>
                  <InputGroupInput
                    aria-invalid={nameError ? true : undefined}
                    autoComplete="off"
                    className="select-text"
                    data-testid="chat-command-name"
                    placeholder="go"
                    spellCheck={false}
                    value={name}
                    onBlur={touch('name')}
                    onChange={(event) => {
                      // The `!` is already there: one typed or pasted in front is dropped.
                      setName(event.target.value.replace(/^!/, ''))
                      edited('name')
                    }}
                  />
                </InputGroup>
                {nameError ? <FieldError>{nameError}</FieldError> : null}
              </Field>
              <Field data-invalid={descriptionError ? true : undefined}>
                <FieldLabel>Description</FieldLabel>
                <Input
                  aria-invalid={descriptionError ? true : undefined}
                  autoComplete="off"
                  className="select-text"
                  data-testid="chat-command-description"
                  placeholder="why I'm learning Go"
                  value={description}
                  onBlur={touch('description')}
                  onChange={(event) => {
                    setDescription(event.target.value)
                    edited('description')
                  }}
                />
                <FieldDescription>!commands shows it after the name.</FieldDescription>
                {descriptionError ? <FieldError>{descriptionError}</FieldError> : null}
              </Field>
              <Field data-invalid={replyError ? true : undefined}>
                <FieldLabel>Reply</FieldLabel>
                <Textarea
                  ref={replyRef}
                  aria-invalid={replyError ? true : undefined}
                  className="select-text"
                  data-testid="chat-command-reply"
                  placeholder="I'm learning Go because…"
                  rows={3}
                  value={reply}
                  onBlur={touch('reply')}
                  onChange={(event) => {
                    const raw = event.currentTarget.value
                    const next = chatCommandOneLine(raw)
                    if (next !== raw) {
                      const caret = event.currentTarget.selectionStart ?? raw.length
                      replyCaret.current = chatCommandOneLine(raw.slice(0, caret)).length
                    }
                    setReply(next)
                    edited('reply')
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      void submit()
                    }
                  }}
                />
                <FieldDescription className="flex flex-wrap items-center gap-x-1.5">
                  <span
                    className="flex items-center gap-1 tabular-nums"
                    data-testid="chat-command-reply-room"
                  >
                    {/* Over the limit, the icon carries the tone (plan 174 S1.8). */}
                    {room < 0 ? (
                      <AlertIcon aria-hidden className="size-3 text-destructive" weight="fill" />
                    ) : null}
                    {chatCommandRoomLabel(reply)}
                  </span>
                  {chatCommandNeedsTwoXPosts(reply) ? (
                    <>
                      <span aria-hidden>·</span>
                      <span data-testid="chat-command-x-note">X gets this in 2 posts.</span>
                    </>
                  ) : null}
                </FieldDescription>
                {replyError ? <FieldError>{replyError}</FieldError> : null}
              </Field>
              <div className="flex flex-col gap-1.5">
                <FieldTitle>Preview</FieldTitle>
                <p
                  className="rounded-row bg-inset px-2.5 py-2 text-sm break-words select-text"
                  data-testid="chat-command-preview"
                >
                  <span className="text-muted-foreground">@viewer</span>{' '}
                  {preview || <span className="text-muted-foreground">Your reply</span>}
                </p>
              </div>
            </FieldGroup>
          </DialogBody>
          {refusal && !refusal.field ? <FieldError>{refusal.message}</FieldError> : null}
          <DialogFooter>
            <Button disabled={saving} type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button data-testid="chat-command-save" disabled={saving} type="submit">
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
