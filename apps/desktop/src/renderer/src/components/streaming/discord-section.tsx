import { useId, useMemo, useState, type KeyboardEvent, type ReactElement } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { CloseIcon, EditIcon, ExternalLinkIcon, SendIcon } from '@/components/icons'
import { GroupedList, ListRow } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { PlatformGlyph } from '@/components/platform-glyph'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  SettingsRow
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useDiscordAnnounce } from '@/hooks/use-discord-announce'
import {
  DISCORD_MAX_WEBHOOKS,
  type DiscordAnnounceSnapshot,
  type DiscordLinkPreview,
  type DiscordPing,
  type DiscordWebhookSnapshot,
  type StreamPlatform,
  type StreamTargetSettings
} from '@/lib/backend'
import { AvatarCircle } from '@/lib/chat-avatar'
import {
  DISCORD_PING_OPTIONS,
  discordErrorLine,
  discordLinkTargets,
  discordWebhookFormatError,
  nextExcludedTargetIds,
  postAsFromKey,
  postAsKey
} from '@/lib/discord-announce'
import { formatRelativeTime } from '@/lib/format-time'

/**
 * Livestream → Setup → Discord (plan 187, issue #634): paste a webhook per
 * server, and every public Go Live posts to each of them under the
 * streamer's own name, with a link button per live destination. It stays
 * editable while live; changes apply to the next stream.
 */
export function DiscordSection({
  targets,
  sessionActive
}: {
  targets: readonly StreamTargetSettings[]
  sessionActive: boolean
}): ReactElement {
  const linkTargets = useMemo(() => discordLinkTargets(targets), [targets])
  const discord = useDiscordAnnounce(linkTargets)
  const { snapshot } = discord
  const several = (snapshot?.webhooks.length ?? 0) > 1

  return (
    <PanelSection
      description={`Tell your ${several ? 'servers' : 'server'} when you go live. Unlisted and private YouTube streams are never announced.`}
      icon={SendIcon}
      title="Discord"
    >
      <div className="flex flex-col gap-3" data-testid="discord-section">
        {!snapshot ? (
          discord.error ? (
            <FieldError>{discord.error}</FieldError>
          ) : (
            <p className="text-meta text-muted-foreground" role="status">
              Loading Discord settings…
            </p>
          )
        ) : snapshot.webhooks.length === 0 ? (
          <WebhookPaste onSave={discord.saveWebhook} />
        ) : (
          <ConnectedDiscord
            discord={discord}
            platformById={new Map(targets.map((target) => [target.id, target.platform]))}
            sessionActive={sessionActive}
            snapshot={snapshot}
          />
        )}
      </div>
    </PanelSection>
  )
}

function WebhookPaste({
  label = 'Webhook URL',
  onSave,
  onCancel
}: {
  label?: string
  onSave: (url: string) => Promise<string | null>
  /** Hides the field again; absent while it is the only way in. */
  onCancel?: () => void
}): ReactElement {
  const id = useId()
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const formatError = discordWebhookFormatError(value)
  const error = refusal ?? formatError
  const canSave = value.trim().length > 0 && !formatError && !pending

  const save = async (): Promise<void> => {
    if (!canSave) return
    setPending(true)
    setRefusal(null)
    const refused = await onSave(value)
    setPending(false)
    if (refused) setRefusal(refused)
    // Never keep the URL around once the backend has it.
    else setValue('')
  }

  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex gap-2">
        <Input
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          autoFocus={onCancel !== undefined}
          className="min-w-0 flex-1 select-text"
          data-testid="discord-webhook-input"
          id={id}
          placeholder="https://discord.com/api/webhooks/…"
          spellCheck={false}
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            setRefusal(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save()
            if (event.key === 'Escape') onCancel?.()
          }}
        />
        <Button
          data-testid="discord-webhook-connect"
          disabled={!canSave}
          variant="secondary"
          onClick={() => void save()}
        >
          {pending ? 'Connecting…' : 'Connect'}
        </Button>
        {onCancel ? (
          <Button data-testid="discord-webhook-add-cancel" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
      <FieldDescription>
        In Discord: Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.
      </FieldDescription>
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  )
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; messageUrl?: string }
  | { kind: 'failed'; error: string }

const TEST_IDLE: TestState = { kind: 'idle' }

function ConnectedDiscord({
  snapshot,
  discord,
  platformById,
  sessionActive
}: {
  snapshot: DiscordAnnounceSnapshot
  discord: ReturnType<typeof useDiscordAnnounce>
  platformById: ReadonlyMap<string, StreamPlatform>
  sessionActive: boolean
}): ReactElement {
  const [confirmRemove, setConfirmRemove] = useState<DiscordWebhookSnapshot | null>(null)
  const [adding, setAdding] = useState(false)
  // Each webhook's test runs and reports on its own row.
  const [tests, setTests] = useState<ReadonlyMap<string, TestState>>(new Map())
  const anyDeleted = snapshot.webhooks.some(
    (webhook) => webhook.lastError?.code === 'webhook-deleted'
  )
  const full = snapshot.webhooks.length >= DISCORD_MAX_WEBHOOKS
  // A webhook deleted in Discord wants a replacement, so the field shows itself.
  const pasting = !full && (adding || anyDeleted)
  // The preview resolves the current choice, so it names Automatic only while
  // Automatic is the choice.
  const automatic = snapshot.postAs.kind === 'automatic'
  const sender = automatic ? discord.preview?.sender : undefined
  const automaticLabel = sender ? `Automatic · ${sender.name}` : 'Automatic'
  const postAsItems = [
    {
      value: 'automatic',
      label: (
        <>
          <AvatarCircle
            avatarUrl={sender?.avatarUrl}
            className="size-5"
            name={sender?.name ?? 'Webhook'}
          />
          {automaticLabel}
        </>
      )
    },
    ...snapshot.identities.map((identity) => ({
      value: postAsKey(identity.postAs),
      label: (
        <>
          <AvatarCircle avatarUrl={identity.avatarUrl} className="size-5" name={identity.name} />
          {identity.name}
        </>
      )
    })),
    { value: 'webhook', label: "The webhook's own name" }
  ]

  const setTest = (webhookId: string, state: TestState): void => {
    setTests((previous) => new Map(previous).set(webhookId, state))
  }

  const sendTest = async (webhookId: string): Promise<void> => {
    setTest(webhookId, { kind: 'sending' })
    const result = await discord.sendTest(webhookId)
    setTest(
      webhookId,
      result.error
        ? { kind: 'failed', error: result.error }
        : { kind: 'sent', messageUrl: result.messageUrl }
    )
  }

  const addWebhook = async (url: string): Promise<string | null> => {
    const refused = await discord.saveWebhook(url)
    if (!refused) setAdding(false)
    return refused
  }

  return (
    <>
      <FieldGroup data-testid="discord-webhooks" variant="grouped">
        {snapshot.webhooks.map((webhook) => (
          <WebhookRow
            key={webhook.id}
            test={tests.get(webhook.id) ?? TEST_IDLE}
            webhook={webhook}
            onRemove={() => setConfirmRemove(webhook)}
            onSendTest={() => void sendTest(webhook.id)}
          />
        ))}
      </FieldGroup>

      {pasting ? (
        <WebhookPaste
          label={anyDeleted ? 'New webhook URL' : 'Another webhook URL'}
          onCancel={adding && !anyDeleted ? () => setAdding(false) : undefined}
          onSave={addWebhook}
        />
      ) : (
        <div className="flex">
          <DisabledReason
            reason={
              full
                ? `You can connect up to ${DISCORD_MAX_WEBHOOKS} webhooks. Remove one to add another.`
                : undefined
            }
          >
            <Button
              data-testid="discord-webhook-add"
              disabled={full}
              variant="outline"
              onClick={() => setAdding(true)}
            >
              Add webhook…
            </Button>
          </DisabledReason>
        </div>
      )}

      <FieldGroup variant="grouped">
        <SettingsRow
          description="One post in every connected server when you're on air. It adds destinations as they come up and says when you stopped."
          label="Announce when I go live"
        >
          <Switch
            checked={snapshot.enabled}
            data-testid="discord-enabled"
            onCheckedChange={(enabled) => void discord.update({ enabled })}
          />
        </SettingsRow>
        <SettingsRow description="Whose name and picture the post shows." label="Post as">
          <Select
            items={postAsItems}
            value={postAsKey(snapshot.postAs)}
            onValueChange={(key) => {
              if (key !== null) void discord.update({ postAs: postAsFromKey(key) })
            }}
          >
            <SelectTrigger className="w-56" data-testid="discord-post-as">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {postAsItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow description="Edits and test messages never ping." label="Ping">
          <SegmentedControl<DiscordPing>
            options={DISCORD_PING_OPTIONS}
            value={snapshot.ping}
            onValueChange={(ping) => void discord.update({ ping })}
          />
        </SettingsRow>
        <SettingsRow
          description={'Adds "Live with Videorc" under the post.'}
          label="Videorc footer"
        >
          <Switch
            checked={snapshot.branding}
            data-testid="discord-branding"
            onCheckedChange={(branding) => void discord.update({ branding })}
          />
        </SettingsRow>
      </FieldGroup>

      <DiscordLinks discord={discord} platformById={platformById} snapshot={snapshot} />

      {discord.error ? <FieldError>{discord.error}</FieldError> : null}
      {sessionActive ? (
        <p className="text-meta text-muted-foreground">Changes apply to your next stream.</p>
      ) : null}

      <ConfirmDialog
        confirmLabel="Remove webhook"
        description="Videorc stops posting to its channel. The webhook itself stays in Discord."
        open={confirmRemove !== null}
        testId="discord-remove"
        title={
          confirmRemove?.name
            ? `Remove the ${confirmRemove.name} webhook?`
            : 'Remove the Discord webhook?'
        }
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => {
          const removed = confirmRemove
          setConfirmRemove(null)
          if (!removed) return
          setTest(removed.id, TEST_IDLE)
          void discord.removeWebhook(removed.id)
        }}
      />
    </>
  )
}

/**
 * One connected webhook: Discord's name for it, where it posts, its own
 * last post and failure, and its own test and Remove.
 */
function WebhookRow({
  webhook,
  test,
  onSendTest,
  onRemove
}: {
  webhook: DiscordWebhookSnapshot
  test: TestState
  onSendTest: () => void
  onRemove: () => void
}): ReactElement {
  const deleted = webhook.lastError?.code === 'webhook-deleted'
  const failure = webhook.lastError ? discordErrorLine(webhook.lastError.code) : null
  const testFailure = test.kind === 'failed' ? test.error : null
  return (
    <SettingsRow
      data-testid={`discord-webhook-row-${webhook.id}`}
      description={
        <>
          Posts to its channel · {webhook.hint}
          {webhook.lastPost ? (
            <span
              className="flex items-center gap-2"
              data-testid={`discord-last-post-${webhook.id}`}
            >
              Last post {formatRelativeTime(webhook.lastPost.at, Date.now())}
              {webhook.lastPost.state === 'live' ? ', still live' : null}.
              {webhook.lastPost.messageUrl ? (
                <ViewInDiscord url={webhook.lastPost.messageUrl} />
              ) : null}
            </span>
          ) : null}
          {test.kind === 'sent' ? (
            <span className="flex items-center gap-2" role="status">
              Test sent.
              {test.messageUrl ? (
                <ViewInDiscord url={test.messageUrl} />
              ) : (
                'Check the channel in Discord.'
              )}
            </span>
          ) : null}
        </>
      }
      error={
        failure || testFailure ? (
          <>
            {failure ? <span className="block">{failure}</span> : null}
            {testFailure ? <span className="block">{testFailure}</span> : null}
          </>
        ) : undefined
      }
      label={webhook.name ?? 'Webhook'}
    >
      <div className="flex shrink-0 items-center gap-2">
        <DisabledReason reason={deleted ? 'Paste a new webhook URL first.' : undefined}>
          <Button
            data-testid={`discord-send-test-${webhook.id}`}
            disabled={test.kind === 'sending' || deleted}
            variant="outline"
            onClick={onSendTest}
          >
            <SendIcon data-icon="inline-start" />
            {test.kind === 'sending' ? 'Sending…' : 'Send test message'}
          </Button>
        </DisabledReason>
        <Button
          data-testid={`discord-webhook-remove-${webhook.id}`}
          variant="ghost"
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
    </SettingsRow>
  )
}

function ViewInDiscord({ url }: { url: string }): ReactElement {
  return (
    // Its lines stack with no gap: no compact-button spill (plan 213 A4), or
    // it would reach the line above.
    <Button
      className="before:hidden"
      size="xs"
      variant="ghost"
      onClick={() => void window.videorc.openOAuthUrl(url)}
    >
      View in Discord
      <ExternalLinkIcon data-icon="inline-end" />
    </Button>
  )
}

/** The destinations the post links, each with its link (D8). */
function DiscordLinks({
  snapshot,
  discord,
  platformById
}: {
  snapshot: DiscordAnnounceSnapshot
  discord: ReturnType<typeof useDiscordAnnounce>
  platformById: ReadonlyMap<string, StreamPlatform>
}): ReactElement | null {
  const [editing, setEditing] = useState<{ targetId: string; draft: string } | null>(null)
  const [linkError, setLinkError] = useState<{ targetId: string; message: string } | null>(null)
  const rows = discord.preview?.links ?? []
  if (rows.length === 0) return null

  const saveLink = async (targetId: string, link: string | undefined): Promise<void> => {
    const refused = await discord.update({
      linkOverride: link?.trim() ? { targetId, link: link.trim() } : { targetId }
    })
    if (refused) {
      setLinkError({ targetId, message: refused })
      return
    }
    setLinkError(null)
    setEditing(null)
  }

  const errorLabel = linkError
    ? rows.find((row) => row.targetId === linkError.targetId)?.label
    : null

  return (
    <div className="flex flex-col gap-1.5">
      <GroupedList data-testid="discord-links" label="Links in the post">
        {rows.map((row) => (
          <DiscordLinkRow
            editing={editing?.targetId === row.targetId ? editing.draft : null}
            key={row.targetId}
            platform={platformById.get(row.targetId)}
            row={row}
            onCancel={() => {
              setEditing(null)
              setLinkError(null)
            }}
            onDraftChange={(draft) => setEditing({ targetId: row.targetId, draft })}
            onEdit={() =>
              setEditing({
                targetId: row.targetId,
                draft: row.linkKind === 'typed' || row.linkKind === 'auto' ? (row.link ?? '') : ''
              })
            }
            onRemoveTyped={() => void saveLink(row.targetId, undefined)}
            onSave={(draft) => void saveLink(row.targetId, draft)}
            onToggle={(included) =>
              void discord.update({
                excludedTargetIds: nextExcludedTargetIds(
                  snapshot.excludedTargetIds,
                  row.targetId,
                  included
                )
              })
            }
          />
        ))}
      </GroupedList>
      {linkError ? (
        <FieldError>
          {errorLabel ? `${errorLabel}: ` : null}
          {linkError.message}
        </FieldError>
      ) : null}
    </div>
  )
}

function DiscordLinkRow({
  row,
  platform,
  editing,
  onToggle,
  onEdit,
  onDraftChange,
  onSave,
  onCancel,
  onRemoveTyped
}: {
  row: DiscordLinkPreview
  platform: StreamPlatform | undefined
  editing: string | null
  onToggle: (included: boolean) => void
  onEdit: () => void
  onDraftChange: (draft: string) => void
  onSave: (draft: string) => void
  onCancel: () => void
  onRemoveTyped: () => void
}): ReactElement {
  const linkable = row.linkKind !== 'none'
  // Its hit area spills only 4 px toward the edit and remove buttons 8 px
  // before it, never over them (plan 213 A4).
  const toggle = (
    <Switch
      aria-label={`Link ${row.label} in the post`}
      checked={row.included}
      className="after:-left-1"
      disabled={!linkable}
      onCheckedChange={onToggle}
    />
  )
  const context =
    editing !== null
      ? null
      : row.linkKind === 'at-go-live'
        ? 'Link made when you go live'
        : row.linkKind === 'none'
          ? 'No public link'
          : row.link

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') onSave(editing ?? '')
    if (event.key === 'Escape') onCancel()
  }

  return (
    <ListRow
      context={context ? <span className="select-text">{context}</span> : undefined}
      data-testid={`discord-link-${row.targetId}`}
      icon={platform ? <PlatformGlyph platform={platform} /> : undefined}
      title={row.label}
    >
      {editing !== null ? (
        <span className="flex items-center gap-1.5">
          <Input
            aria-label={`${row.label} link`}
            autoComplete="off"
            autoFocus
            className="w-64 select-text"
            placeholder="https://…"
            spellCheck={false}
            value={editing}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <Button size="xs" variant="secondary" onClick={() => onSave(editing)}>
            Save
          </Button>
          <Button size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </span>
      ) : row.linkKind === 'none' ? (
        <Button size="xs" variant="outline" onClick={onEdit}>
          Add link…
        </Button>
      ) : (
        <span className="flex items-center gap-1">
          <Button
            aria-label={`Type a link for ${row.label}`}
            size="icon-xs"
            variant="ghost"
            onClick={onEdit}
          >
            <EditIcon />
          </Button>
          {row.linkKind === 'typed' ? (
            <Button
              aria-label={`Remove the typed link for ${row.label}`}
              size="icon-xs"
              variant="ghost"
              onClick={onRemoveTyped}
            >
              <CloseIcon />
            </Button>
          ) : null}
        </span>
      )}
      <span className="flex shrink-0 items-center" data-slot="discord-link-toggle">
        {linkable ? (
          toggle
        ) : (
          <DisabledReason reason="Add its public link to include it.">{toggle}</DisabledReason>
        )}
      </span>
    </ListRow>
  )
}
