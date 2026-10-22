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
import type {
  DiscordAnnounceSnapshot,
  DiscordLinkPreview,
  DiscordPing,
  StreamPlatform,
  StreamTargetSettings
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
 * Livestream → Setup → Discord (plan 187, issue #634): paste a webhook once,
 * and every public Go Live posts to the streamer's server under their own
 * name, with a link button per live destination. It stays editable while
 * live; changes apply to the next stream.
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

  return (
    <PanelSection
      description="Tell your server when you go live. Unlisted and private YouTube streams are never announced."
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
        ) : !snapshot.webhookPresent ? (
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
  onSave
}: {
  label?: string
  onSave: (url: string) => Promise<string | null>
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
      </div>
      <FieldDescription>
        In Discord: Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.
      </FieldDescription>
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  )
}

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
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [testState, setTestState] = useState<
    | { kind: 'idle' }
    | { kind: 'sending' }
    | { kind: 'sent'; messageUrl?: string }
    | { kind: 'failed'; error: string }
  >({ kind: 'idle' })
  const deleted = snapshot.lastError?.code === 'webhook-deleted'
  // The preview resolves the current choice, so it names Automatic only while
  // Automatic is the choice.
  const automatic = snapshot.postAs.kind === 'automatic'
  const sender = automatic ? discord.preview?.sender : undefined
  const automaticLabel = !automatic
    ? 'Automatic'
    : sender
      ? `Automatic · ${sender.name}`
      : "Automatic · the webhook's name"

  const sendTest = async (): Promise<void> => {
    setTestState({ kind: 'sending' })
    const result = await discord.sendTest()
    setTestState(
      result.error
        ? { kind: 'failed', error: result.error }
        : { kind: 'sent', messageUrl: result.messageUrl }
    )
  }

  return (
    <>
      <FieldGroup variant="grouped">
        <SettingsRow
          data-testid="discord-webhook-row"
          description={
            snapshot.webhookHint ? `Posts to its channel · ${snapshot.webhookHint}` : undefined
          }
          error={snapshot.lastError ? discordErrorLine(snapshot.lastError.code) : undefined}
          label={snapshot.webhookName ?? 'Webhook'}
        >
          <div className="flex shrink-0 items-center gap-2">
            <Button
              data-testid="discord-send-test"
              disabled={testState.kind === 'sending' || deleted}
              variant="outline"
              onClick={() => void sendTest()}
            >
              <SendIcon data-icon="inline-start" />
              {testState.kind === 'sending' ? 'Sending…' : 'Send test message'}
            </Button>
            <Button
              data-testid="discord-webhook-remove"
              variant="ghost"
              onClick={() => setConfirmRemove(true)}
            >
              Remove
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow
          description="One post when you're on air. It adds destinations as they come up and says when you stopped."
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
            value={postAsKey(snapshot.postAs)}
            onValueChange={(key) => void discord.update({ postAs: postAsFromKey(key) })}
          >
            <SelectTrigger className="w-56" data-testid="discord-post-as">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="automatic">
                <AvatarCircle
                  avatarUrl={sender?.avatarUrl}
                  className="size-5"
                  name={sender?.name ?? 'Webhook'}
                />
                {automaticLabel}
              </SelectItem>
              {snapshot.identities.map((identity) => (
                <SelectItem key={postAsKey(identity.postAs)} value={postAsKey(identity.postAs)}>
                  <AvatarCircle
                    avatarUrl={identity.avatarUrl}
                    className="size-5"
                    name={identity.name}
                  />
                  {identity.name}
                </SelectItem>
              ))}
              <SelectItem value="webhook">The webhook's own name</SelectItem>
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

      {deleted ? <WebhookPaste label="New webhook URL" onSave={discord.saveWebhook} /> : null}

      {testState.kind === 'sent' ? (
        <p className="flex items-center gap-2 text-meta text-muted-foreground" role="status">
          Test sent.
          {testState.messageUrl ? (
            <ViewInDiscord url={testState.messageUrl} />
          ) : (
            'Check the channel in Discord.'
          )}
        </p>
      ) : testState.kind === 'failed' ? (
        <FieldError>{testState.error}</FieldError>
      ) : null}

      <DiscordLinks discord={discord} platformById={platformById} snapshot={snapshot} />

      {discord.error ? <FieldError>{discord.error}</FieldError> : null}
      {snapshot.lastPost || sessionActive ? (
        <div className="flex flex-col gap-1 text-meta text-muted-foreground">
          {snapshot.lastPost ? (
            <p className="flex items-center gap-2" data-testid="discord-last-post">
              Last post {formatRelativeTime(snapshot.lastPost.at, Date.now())}
              {snapshot.lastPost.state === 'live' ? ', still live' : null}.
              {snapshot.lastPost.messageUrl ? (
                <ViewInDiscord url={snapshot.lastPost.messageUrl} />
              ) : null}
            </p>
          ) : null}
          {sessionActive ? <p>Changes apply to your next stream.</p> : null}
        </div>
      ) : null}

      <ConfirmDialog
        confirmLabel="Remove webhook"
        description="Videorc stops posting to this channel. The webhook itself stays in Discord."
        open={confirmRemove}
        testId="discord-remove"
        title="Remove the Discord webhook?"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false)
          setTestState({ kind: 'idle' })
          void discord.removeWebhook()
        }}
      />
    </>
  )
}

function ViewInDiscord({ url }: { url: string }): ReactElement {
  return (
    <Button size="xs" variant="ghost" onClick={() => void window.videorc.openOAuthUrl(url)}>
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
  const toggle = (
    <Switch
      aria-label={`Link ${row.label} in the post`}
      checked={row.included}
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
