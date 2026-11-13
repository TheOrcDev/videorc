import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  AccountIcon,
  ArrowLeftIcon,
  DeleteIcon,
  LinkIcon,
  SparkleIcon,
  TerminalIcon
} from '@/components/icons'
import { KebabMenu, type KebabMenuItem } from '@/components/kebab-menu'
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import type {
  CommunityMemory,
  CommunityAccount,
  CommunityPerson,
  CommunityPersonParams,
  CommunityPersonRow,
  CommunitySuggestion,
  StreamPlatform
} from '@/lib/backend'
import { memoryForgetCopy } from '@/components/community/community-copy'
import { monogramInitials, useCachedAvatar } from '@/lib/chat-avatar'
import {
  X_SELF_LINK_REASON,
  YOUTUBE_RETENTION_LINE,
  forgetCopy,
  linkEventLabel,
  personHasX,
  personRowContext,
  personStatsLine,
  rowHasX,
  supportLine
} from '@/lib/community-view'
import { platformLabel } from '@/lib/platform-copy'
import { toastUserError } from '@/lib/user-error'
import type { CommunityRelayCall } from '../../../../shared/community-relay'

/** Which person a card is about: by id, or by the account a chat row names. */
export type PersonCardTarget =
  | { personId: string; name: string }
  | { platform: StreamPlatform; authorId: string; name: string }

/**
 * The section-label recipe (`SectionLabel`, 11 px / 600, tertiary), spelled
 * here: the card is shared by the Stream Manager and the main window, and
 * importing the primitive split it into an eager chunk of its own (the
 * renderer budget, plan 225 C2).
 */
const CARD_LABEL = 'text-label font-semibold text-subtle'

export const NOTE_MAX_CHARS = 300

function personParams(target: PersonCardTarget): CommunityPersonParams {
  return 'personId' in target
    ? { personId: target.personId }
    : { platform: target.platform, authorId: target.authorId, name: target.name }
}

function accountLabel(account: Pick<CommunityAccount, 'platform' | 'handle' | 'name'>): string {
  return `${platformLabel(account.platform)} · ${account.handle?.trim() || account.name}`
}

/**
 * The person card (plan 225 D11), one body for every place it opens: the
 * Stream Manager's popover (Wide, Medium) and dialog (Narrow), and the
 * Community tab's dialog (D12, with the link history). It loads the person on
 * open (`cohost.community.person`), never per chat row. Nothing here posts to
 * chat: Wave is Buddy's bubble only, and every other action edits what this
 * computer remembers.
 */
export function PersonCardBody({
  target,
  call,
  memoryLock,
  showLinkHistory = false,
  startIn = 'card',
  onForgetRequest,
  onMemoryForgetRequest,
  onClose,
  onChanged
}: {
  target: PersonCardTarget
  call: CommunityRelayCall
  /**
   * "Buddy remembers" locked (Premium, D6): the host's lock alert, never
   * hidden. Null when unlocked.
   */
  memoryLock: ReactNode | null
  /** The Community dialog shows who linked what, and when. */
  showLinkHistory?: boolean
  /** "Same person as…" from a right-click opens straight on the search. */
  startIn?: 'card' | 'link'
  /**
   * The Stream Manager's popover hands the forget question to its host, so
   * the alert dialog outlives the popover. Absent: the card asks itself.
   */
  onForgetRequest?: (person: CommunityPerson) => void
  /**
   * D10: the forget question for one memory, handed to the host the same
   * way. Absent: the card asks itself.
   */
  onMemoryForgetRequest?: (person: CommunityPerson, memory: CommunityMemory) => void
  onClose?: () => void
  /** Something about the community changed (a list may refresh). */
  onChanged?: () => void
}): ReactElement {
  const [person, setPerson] = useState<CommunityPerson | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [view, setView] = useState<'card' | 'link'>(startIn)
  const [waved, setWaved] = useState(false)
  const [forgetOpen, setForgetOpen] = useState(false)
  const [memoryForget, setMemoryForget] = useState<CommunityMemory | null>(null)
  const params = personParams(target)
  const paramsKey = JSON.stringify(params)

  const load = useCallback(() => {
    setLoadError(false)
    call('cohost.community.person', JSON.parse(paramsKey) as CommunityPersonParams).then(
      setPerson,
      () => setLoadError(true)
    )
  }, [call, paramsKey])
  useEffect(load, [load])

  const run = async <T,>(
    id: string,
    work: () => Promise<T>,
    object: string,
    then?: (value: T) => void
  ): Promise<void> => {
    setBusy(id)
    try {
      const value = await work()
      then?.(value)
      onChanged?.()
    } catch (error) {
      toastUserError(error, { action: 'update', object }, { id: 'community-card' })
    } finally {
      setBusy(null)
    }
  }

  if (!person) {
    return (
      <div className="flex min-h-24 items-center justify-center" data-testid="person-card-loading">
        {loadError ? (
          <Alert variant="warning">
            <AlertTitle>Couldn't read what Videorc remembers about {target.name}.</AlertTitle>
            <AlertAction>
              <Button size="xs" type="button" variant="outline" onClick={load}>
                Try again
              </Button>
            </AlertAction>
          </Alert>
        ) : (
          <Spinner aria-label={`Loading ${target.name}`} />
        )}
      </div>
    )
  }

  const known = person.id !== ''
  const name = person.name || target.name
  const linked = person.accounts.length > 1
  const hasX = personHasX(person)
  const unknownReason = `Videorc starts remembering ${name} from their next message.`

  if (view === 'link' && known && !hasX) {
    return (
      <SamePersonPicker
        call={call}
        person={person}
        onBack={() => setView('card')}
        onLinked={(next) => {
          setPerson(next)
          setView('card')
          onChanged?.()
        }}
      />
    )
  }

  const menu: KebabMenuItem[] = [
    {
      id: 'bot',
      label: person.status === 'bot' ? 'Not a bot' : 'Mark as bot',
      icon: TerminalIcon,
      disabled: !known || busy !== null,
      disabledReason: known ? null : unknownReason,
      onSelect: () =>
        void run(
          'bot',
          () =>
            call('cohost.community.update', {
              personId: person.id,
              status: person.status === 'bot' ? 'normal' : 'bot'
            }),
          name,
          setPerson
        )
    },
    {
      id: 'forget',
      label: `Forget ${name}…`,
      icon: DeleteIcon,
      destructive: true,
      disabled: !known || busy !== null,
      disabledReason: known ? null : unknownReason,
      onSelect: () => (onForgetRequest ? onForgetRequest(person) : setForgetOpen(true))
    }
  ]
  const forget = forgetCopy(name)
  const support = supportLine(person.support)
  const suggestions = person.suggestions ?? []

  return (
    <div className="flex min-w-0 flex-col gap-3" data-person-id={person.id} data-slot="person-card">
      <PersonHeader linked={linked} name={name} person={person} />
      <AccountsList
        busy={busy !== null}
        linked={linked}
        person={person}
        onSplit={(account) =>
          void run(
            `split-${account.accountKey}`,
            () => call('cohost.community.unlink', { accountKey: account.accountKey }),
            name,
            () => load()
          )
        }
      />
      <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        <p data-testid="person-card-stats">{personStatsLine(person)}</p>
        {support ? <p data-testid="person-card-support">{support}</p> : null}
      </div>
      {suggestions.map((suggestion) => (
        <SuggestionRow
          key={`${suggestion.accountA.accountKey}|${suggestion.accountB.accountKey}`}
          busy={busy !== null}
          person={person}
          suggestion={suggestion}
          onAccept={() =>
            void run(
              'accept',
              () =>
                call('cohost.community.suggestion.accept', {
                  accountA: suggestion.accountA.accountKey,
                  accountB: suggestion.accountB.accountKey
                }),
              name,
              setPerson
            )
          }
          onDismiss={() =>
            void run(
              'dismiss',
              () =>
                call('cohost.community.suggestion.dismiss', {
                  accountA: suggestion.accountA.accountKey,
                  accountB: suggestion.accountB.accountKey
                }),
              name,
              () => load()
            )
          }
        />
      ))}
      <div className="flex flex-col gap-1.5" data-slot="person-card-memories">
        <span className={CARD_LABEL}>Buddy remembers</span>
        {memoryLock ? (
          <div data-testid="person-card-memory-lock">{memoryLock}</div>
        ) : (person.memories ?? []).length > 0 ? (
          <ul
            className="flex flex-col gap-1 text-xs text-foreground"
            data-testid="person-card-memory-list"
          >
            {(person.memories ?? []).map((memory) => (
              <li key={memory.id} className="flex items-start gap-1.5">
                <SparkleIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 break-words select-text">{memory.text}</span>
                {/* D10: every memory can be forgotten; it asks first. */}
                <Button
                  aria-label={`Forget “${memory.text}”`}
                  className="-my-1 shrink-0 text-muted-foreground"
                  data-testid="person-card-memory-forget"
                  disabled={busy !== null}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    onMemoryForgetRequest
                      ? onMemoryForgetRequest(person, memory)
                      : setMemoryForget(memory)
                  }
                >
                  <DeleteIcon aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            Nothing yet. Buddy learns from what {name} says about themselves in chat.
          </p>
        )}
      </div>
      <NoteField
        disabled={!known}
        disabledReason={unknownReason}
        name={name}
        note={person.note}
        onSave={(note) =>
          run(
            'note',
            () => call('cohost.community.update', { personId: person.id, note }),
            `${name}'s note`,
            setPerson
          )
        }
      />
      {person.youtube ? (
        <Alert data-testid="person-card-youtube" variant="quiet">
          <AlertTitle className="text-xs">{YOUTUBE_RETENTION_LINE}</AlertTitle>
        </Alert>
      ) : null}
      {showLinkHistory && (person.linkEvents ?? []).length > 0 ? (
        <div className="flex flex-col gap-1" data-slot="person-card-history">
          <span className={CARD_LABEL}>Links</span>
          <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {(person.linkEvents ?? []).map((event) => (
              <li key={event.id} className="flex min-w-0 gap-1.5">
                <span className="min-w-0 flex-1 truncate">
                  {linkEventLabel(event.kind)} · {event.accountKey.split(':')[0]}
                </span>
                <time className="shrink-0 tabular-nums" dateTime={event.at}>
                  {new Date(event.at).toLocaleDateString()}
                </time>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div
        className="flex flex-wrap items-center gap-1 border-t border-border pt-2.5"
        data-slot="person-card-actions"
      >
        <DisabledReason reason={known ? null : unknownReason}>
          <Button
            data-testid="person-card-wave"
            disabled={!known || busy !== null || waved}
            size="xs"
            type="button"
            variant="secondary"
            onClick={() =>
              void run(
                'wave',
                () => call('cohost.community.wave', { personId: person.id }),
                `a wave for ${name}`,
                () => {
                  setWaved(true)
                  window.setTimeout(() => setWaved(false), 3_000)
                }
              )
            }
          >
            {busy === 'wave' ? <Spinner aria-hidden data-icon="inline-start" /> : null}
            {waved ? 'Waved' : 'Wave'}
          </Button>
        </DisabledReason>
        <DisabledReason reason={!known ? unknownReason : hasX ? X_SELF_LINK_REASON : null}>
          <Button
            data-testid="person-card-same-person"
            disabled={!known || hasX || busy !== null}
            size="xs"
            type="button"
            variant="ghost"
            onClick={() => setView('link')}
          >
            <LinkIcon aria-hidden data-icon="inline-start" />
            Same person as…
          </Button>
        </DisabledReason>
        <span className="flex-1" />
        <KebabMenu items={menu} label={`More for ${name}`} />
      </div>
      {onMemoryForgetRequest ? null : (
        <ConfirmDialog
          confirmDisabled={busy === 'memory'}
          confirmLabel={busy === 'memory' ? 'Forgetting…' : memoryForgetCopy(name, '').confirm}
          description={memoryForget ? memoryForgetCopy(name, memoryForget.text).description : ''}
          open={memoryForget !== null}
          testId="person-memory-forget"
          title={memoryForgetCopy(name, '').title}
          onCancel={() => setMemoryForget(null)}
          onConfirm={() => {
            const memory = memoryForget
            if (!memory) return
            void run(
              'memory',
              () => call('cohost.community.memory.delete', { id: memory.id }),
              'that memory',
              () => {
                setMemoryForget(null)
                load()
              }
            )
          }}
        />
      )}
      {onForgetRequest ? null : (
        <ConfirmDialog
          confirmDisabled={busy === 'forget'}
          confirmLabel={busy === 'forget' ? 'Forgetting…' : forget.confirm}
          description={forget.description}
          open={forgetOpen}
          testId="person-forget"
          title={forget.title}
          onCancel={() => setForgetOpen(false)}
          onConfirm={() =>
            void run(
              'forget',
              () => call('cohost.community.forget', { personId: person.id }),
              name,
              () => {
                setForgetOpen(false)
                onClose?.()
              }
            )
          }
        />
      )}
    </div>
  )
}

function PersonHeader({
  person,
  name,
  linked
}: {
  person: CommunityPerson
  name: string
  linked: boolean
}): ReactElement {
  const avatar = useCachedAvatar(person.avatarUrl)
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Avatar aria-hidden size="lg">
        {avatar ? <AvatarImage alt="" src={avatar} /> : null}
        <AvatarFallback>{monogramInitials(name)}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-semibold text-foreground select-text">
            {name}
          </span>
          {person.regular ? (
            <Badge className="shrink-0" variant="outline">
              <AccountIcon aria-hidden data-icon="inline-start" />
              Regular
            </Badge>
          ) : null}
          {person.status === 'bot' ? (
            <Badge className="shrink-0" data-testid="person-card-bot" variant="outline">
              Bot
            </Badge>
          ) : null}
        </span>
        {linked ? (
          <span className="text-xs text-muted-foreground">
            One person on {person.accounts.length} platforms
          </span>
        ) : null}
      </div>
    </div>
  )
}

function AccountsList({
  person,
  linked,
  busy,
  onSplit
}: {
  person: CommunityPerson
  linked: boolean
  busy: boolean
  onSplit: (account: CommunityAccount) => void
}): ReactElement | null {
  if (person.accounts.length === 0) return null
  return (
    <ul className="flex flex-col gap-0.5" data-slot="person-card-accounts">
      {person.accounts.map((account) => (
        <li
          key={account.accountKey}
          className="flex h-6 min-w-0 items-center gap-1.5 text-xs text-foreground"
          data-platform={account.platform}
        >
          <ChatPlatformIcon className="mr-0" decorative platform={account.platform} />
          <span className="min-w-0 flex-1 truncate select-text">{accountLabel(account)}</span>
          {linked ? (
            <Button
              className="shrink-0"
              disabled={busy}
              size="xs"
              type="button"
              variant="ghost"
              onClick={() => onSplit(account)}
            >
              Not the same
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function SuggestionRow({
  person,
  suggestion,
  busy,
  onAccept,
  onDismiss
}: {
  person: CommunityPerson
  suggestion: CommunitySuggestion
  busy: boolean
  onAccept: () => void
  onDismiss: () => void
}): ReactElement {
  const mine = new Set(person.accounts.map((account) => account.accountKey))
  const other = mine.has(suggestion.accountA.accountKey) ? suggestion.accountB : suggestion.accountA
  const title =
    suggestion.reason === 'link-cancelled'
      ? `A !link with ${other.name} on ${platformLabel(other.platform)} needs you`
      : `Might be the same as ${other.name} on ${platformLabel(other.platform)}`
  return (
    <Alert data-testid="person-card-suggestion" variant="default">
      <AlertTitle className="text-xs">{title}</AlertTitle>
      {/* The answers sit under the words, like a Buddy card's: an action
          slot beside two buttons covered the title in a 320 px card. */}
      <div className="col-start-2 mt-1.5 flex flex-wrap gap-1">
        <Button disabled={busy} size="xs" type="button" variant="outline" onClick={onAccept}>
          Same person
        </Button>
        <Button disabled={busy} size="xs" type="button" variant="ghost" onClick={onDismiss}>
          Not the same
        </Button>
      </div>
    </Alert>
  )
}

function NoteField({
  note,
  name,
  disabled,
  disabledReason,
  onSave
}: {
  note: string
  name: string
  disabled: boolean
  disabledReason: string
  onSave: (note: string) => Promise<void>
}): ReactElement {
  const [draft, setDraft] = useState(note)
  const saved = useRef(note)
  useEffect(() => {
    saved.current = note
    setDraft(note)
  }, [note])
  const save = (): void => {
    const next = draft.trim().slice(0, NOTE_MAX_CHARS)
    if (next === saved.current.trim()) return
    saved.current = next
    void onSave(next)
  }
  const id = `person-note-${name.replace(/\W+/g, '-')}`
  return (
    <div className="flex flex-col gap-1.5" data-slot="person-card-note">
      <label className={CARD_LABEL} htmlFor={id}>
        Your note
      </label>
      <DisabledReason focusable={false} reason={disabled ? disabledReason : null}>
        <Textarea
          className="min-h-14 resize-none text-xs"
          disabled={disabled}
          id={id}
          maxLength={NOTE_MAX_CHARS}
          placeholder={`Only you see this. Buddy never changes it.`}
          rows={2}
          value={draft}
          onBlur={save}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              save()
            }
          }}
        />
      </DisabledReason>
    </div>
  )
}

/**
 * "Same person as…" (D4 a): a search over people, then one confirming
 * question. X accounts are never offered: X viewers link themselves.
 */
function SamePersonPicker({
  person,
  call,
  onBack,
  onLinked
}: {
  person: CommunityPerson
  call: CommunityRelayCall
  onBack: () => void
  onLinked: (person: CommunityPerson) => void
}): ReactElement {
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<CommunityPersonRow[] | null>(null)
  const [picked, setPicked] = useState<CommunityPersonRow | null>(null)
  const [busy, setBusy] = useState(false)
  const nowMs = Date.now()

  useEffect(() => {
    let current = true
    const timer = window.setTimeout(() => {
      call('cohost.community.list', {
        query: query.trim() || undefined,
        filter: 'everyone',
        sort: query.trim() ? 'name' : 'recent',
        limit: 30
      }).then(
        (page) => {
          if (current) setRows(page.people.filter((row) => row.id !== person.id))
        },
        () => {
          if (current) setRows([])
        }
      )
    }, 150)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [call, person.id, query])

  const mine = person.accounts[0]
  const describe = (row: { name: string; platforms: readonly StreamPlatform[] }): string =>
    `${row.name} (${row.platforms.map((platform) => platformLabel(platform)).join(', ')})`

  if (picked) {
    return (
      <div className="flex flex-col gap-3" data-slot="person-card-link-confirm">
        <p className="text-sm text-foreground">
          Treat {describe({ name: picked.name, platforms: picked.platforms })} and{' '}
          {describe({
            name: person.name,
            platforms: person.accounts.map((account) => account.platform)
          })}{' '}
          as one person?
        </p>
        <p className="text-xs text-muted-foreground">
          Their streams and messages count together. "Not the same" on the card splits them again.
        </p>
        <div className="flex justify-end gap-1">
          <Button autoFocus size="xs" type="button" variant="ghost" onClick={() => setPicked(null)}>
            Cancel
          </Button>
          <Button
            data-testid="person-card-link-confirm"
            disabled={busy}
            size="xs"
            type="button"
            onClick={() => {
              setBusy(true)
              call('cohost.community.link', { personId: person.id, otherPersonId: picked.id })
                .then(onLinked, (error: unknown) => {
                  toastUserError(
                    error,
                    { action: 'link', object: person.name },
                    { id: 'community-card' }
                  )
                })
                .finally(() => setBusy(false))
            }}
          >
            {busy ? <Spinner aria-hidden data-icon="inline-start" /> : null}
            Same person
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col" data-slot="person-card-link">
      <div className="flex h-8 items-center gap-1">
        <Button aria-label="Back" size="icon-xs" type="button" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon />
        </Button>
        <span className="min-w-0 truncate text-xs font-medium text-foreground">
          Same person as {person.name}
          {mine ? ` (${platformLabel(mine.platform)})` : ''}…
        </span>
      </div>
      <Command shouldFilter={false}>
        <CommandInput
          aria-label="Search people"
          autoFocus
          placeholder="Search people"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList className="max-h-64" label="People">
          {rows === null ? (
            <div className="flex justify-center py-4">
              <Spinner aria-label="Searching" />
            </div>
          ) : (
            <>
              <CommandEmpty>No one by that name.</CommandEmpty>
              <CommandGroup
                // Menu scale, not the palette's: a 4 px inset and 28 px rows.
                // oxlint-disable-next-line shadcn/no-restyle -- see above.
                className="p-1"
              >
                {rows.map((row) => {
                  const x = rowHasX(row)
                  return (
                    <CommandItem
                      key={row.id}
                      // oxlint-disable-next-line shadcn/no-restyle -- Menu scale, as above.
                      className="min-h-7 gap-2 px-2 py-1"
                      data-testid="person-card-link-row"
                      disabled={x}
                      value={row.id}
                      onSelect={() => setPicked(row)}
                    >
                      <span className="flex shrink-0 items-center gap-0.5">
                        {row.platforms.map((platform) => (
                          <ChatPlatformIcon
                            key={platform}
                            className="mr-0"
                            decorative
                            platform={platform}
                          />
                        ))}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{row.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {x ? X_SELF_LINK_REASON : personRowContext(row, nowMs)}
                      </span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </Command>
    </div>
  )
}
