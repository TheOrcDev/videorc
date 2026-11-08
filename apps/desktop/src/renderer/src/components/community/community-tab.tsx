import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import { PersonCardBody } from '@/components/community/person-card-body'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyIcon, SearchIcon } from '@/components/icons'
import { GroupedList } from '@/components/list-row'
import { LockAlert, OfflineAlert } from '@/components/lock-alert'
import { ConfigGrid, CONFIG_GRID_PAIR } from '@/components/page'
import { PanelSection } from '@/components/panel-section'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { FieldGroup, SettingsRow } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SegmentedControl } from '@/components/ui/segmented-control'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useCommunityClient, type CommunityClientState } from '@/hooks/use-community'
import { useStudioCore } from '@/hooks/use-studio'
import type {
  CommunityListFilter,
  CommunityListSort,
  CommunityPersonRow,
  CommunitySettings,
  CommunitySuggestion
} from '@/lib/backend'
import { monogramInitials, useCachedAvatar } from '@/lib/chat-avatar'
import {
  BUDDY_REMEMBERS_LOCK_REASON,
  COMMUNITY_DISCLOSURE_LINE,
  YOUTUBE_RETENTION_LINE,
  backfillLine,
  communityHeaderLine,
  personRowContext
} from '@/lib/community-view'
import { useCopyText } from '@/lib/copy-text'
import { lockAlertAction, unlockActionForGate } from '@/lib/lock-view'
import { platformLabel } from '@/lib/platform-copy'
import { toastUserError } from '@/lib/user-error'
import { CommunityPreview } from '@/components/community/community-preview'

/** Rust's defaults (plan 225 Wire shape), for an older backend's settings. */
export const DEFAULT_COMMUNITY_SETTINGS: CommunitySettings = {
  enabled: true,
  regularStreams: 3,
  welcomeOnStream: true,
  milestoneCards: false,
  remember: false,
  sync: false
}

const FILTERS: { value: CommunityListFilter; label: string }[] = [
  { value: 'regulars', label: 'Regulars' },
  { value: 'everyone', label: 'Everyone' },
  { value: 'linked', label: 'Linked' },
  { value: 'bots', label: 'Bots' }
]

const SORT_ITEMS: Record<CommunityListSort, string> = {
  streams: 'Streams',
  recent: 'Last chat',
  name: 'Name'
}

const PAGE_SIZE = 100
const ROW_PX = 32

/**
 * Buddy → Community (plan 225 D12): who Videorc knows from your chat, on
 * this computer. One column for the people (the header, links that need
 * you, the list), one for the settings and the preview. Free: only Buddy
 * remembers and Community sync are Premium, and both stay on screen behind
 * their lock. Its own chunk, with its own backend client.
 */
export default function CommunityTab(): ReactElement {
  const community = useCommunityClient()
  const [openPerson, setOpenPerson] = useState<{ id: string; name: string } | null>(null)
  const { cohostGate } = useStudioCore()
  const memoryLock = cohostGate.allowed
    ? null
    : {
        reason: BUDDY_REMEMBERS_LOCK_REASON,
        action: lockAlertAction(unlockActionForGate(cohostGate))
      }

  return (
    <div className="flex flex-col" data-testid="community-tab">
      {community.offline ? (
        <div className="border-b border-border p-gutter">
          <OfflineAlert data-testid="community-offline" />
        </div>
      ) : null}
      <ConfigGrid className={CONFIG_GRID_PAIR}>
        <div className="flex min-w-0 flex-col">
          <CommunityOverview community={community} />
          <LinksThatNeedYou community={community} />
          <PeopleSection
            community={community}
            onOpen={(row) => setOpenPerson({ id: row.id, name: row.name })}
          />
        </div>
        <div className="flex min-w-0 flex-col">
          <CommunitySettingsSection community={community} />
          <CommunityPreview />
        </div>
      </ConfigGrid>
      <Dialog
        open={openPerson !== null}
        onOpenChange={(next) => (next ? undefined : setOpenPerson(null))}
      >
        <DialogContent data-testid="community-person-dialog" size="md">
          <DialogHeader>
            <DialogTitle>{openPerson?.name}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {openPerson ? (
              <PersonCardBody
                key={openPerson.id}
                call={community.call}
                memoryLock={memoryLock}
                showLinkHistory
                target={{ personId: openPerson.id, name: openPerson.name }}
                onChanged={community.bump}
                onClose={() => setOpenPerson(null)}
              />
            ) : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function CommunityOverview({ community }: { community: CommunityClientState }): ReactElement {
  const { summary } = community
  const backfill = backfillLine(summary)
  return (
    <PanelSection
      description={communityHeaderLine(summary)}
      title="Your community"
      data-testid="community-overview"
    >
      {backfill && summary ? (
        <div className="flex flex-col gap-1.5" data-slot="community-backfill">
          <p className="text-meta text-muted-foreground">{backfill}</p>
          <Progress
            aria-label="Reading your past streams"
            max={Math.max(1, summary.backfill.total)}
            value={summary.backfill.done}
          />
        </div>
      ) : null}
    </PanelSection>
  )
}

/** D-2: open suggestions and cancelled `!link`s, shown only when there are any. */
function LinksThatNeedYou({ community }: { community: CommunityClientState }): ReactElement | null {
  const { call, ready, revision } = community
  const [suggestions, setSuggestions] = useState<CommunitySuggestion[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    if (!ready) return
    let current = true
    call('cohost.community.suggestions', undefined).then(
      (page) => {
        if (current) setSuggestions(page.suggestions)
      },
      () => undefined
    )
    return () => {
      current = false
    }
  }, [call, ready, revision])
  if (suggestions.length === 0) return null
  const answer = (suggestion: CommunitySuggestion, accept: boolean): void => {
    const key = `${suggestion.accountA.accountKey}|${suggestion.accountB.accountKey}`
    setBusy(key)
    const params = {
      accountA: suggestion.accountA.accountKey,
      accountB: suggestion.accountB.accountKey
    }
    const request = accept
      ? call('cohost.community.suggestion.accept', params)
      : call('cohost.community.suggestion.dismiss', params)
    request
      .then(
        () => {
          setSuggestions((current) =>
            current.filter(
              (entry) => `${entry.accountA.accountKey}|${entry.accountB.accountKey}` !== key
            )
          )
          community.bump()
        },
        (error: unknown) =>
          toastUserError(error, { action: 'link', object: 'these accounts' }, { id: 'community' })
      )
      .finally(() => setBusy(null))
  }
  return (
    <PanelSection
      description="Accounts that might be one person. Videorc never links them on its own."
      title="Links that need you"
      data-testid="community-links"
    >
      <GroupedList aria-label="Links that need you">
        {suggestions.map((suggestion) => {
          const key = `${suggestion.accountA.accountKey}|${suggestion.accountB.accountKey}`
          return (
            <div
              key={key}
              className="flex min-h-row flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-1 text-sm"
              data-testid="community-link-row"
            >
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <ChatPlatformIcon className="mr-0" platform={suggestion.accountA.platform} />
                <span className="truncate font-medium text-foreground">
                  {suggestion.accountA.name}
                </span>
                <span className="shrink-0 text-muted-foreground">and</span>
                <ChatPlatformIcon className="mr-0" platform={suggestion.accountB.platform} />
                <span className="truncate font-medium text-foreground">
                  {suggestion.accountB.name}
                </span>
                {suggestion.reason === 'link-cancelled' ? (
                  <Badge className="shrink-0" variant="outline">
                    !link cancelled
                  </Badge>
                ) : null}
              </span>
              <span className="flex shrink-0 gap-1">
                <Button
                  disabled={busy !== null}
                  size="xs"
                  type="button"
                  variant="outline"
                  onClick={() => answer(suggestion, true)}
                >
                  Same person
                </Button>
                <Button
                  disabled={busy !== null}
                  size="xs"
                  type="button"
                  variant="ghost"
                  onClick={() => answer(suggestion, false)}
                >
                  Not the same
                </Button>
              </span>
            </div>
          )
        })}
      </GroupedList>
    </PanelSection>
  )
}

/** D-3: search, filter, sort; a virtualized list that pages as it scrolls. */
function PeopleSection({
  community,
  onOpen
}: {
  community: CommunityClientState
  onOpen: (row: CommunityPersonRow) => void
}): ReactElement {
  const { call, ready, revision } = community
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<CommunityListFilter>('regulars')
  const [sort, setSort] = useState<CommunityListSort>('streams')
  const [rows, setRows] = useState<CommunityPersonRow[] | null>(null)
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [loadingMore, setLoadingMore] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const nowMs = Date.now()

  useEffect(() => {
    if (!ready) return
    let current = true
    const timer = window.setTimeout(() => {
      call('cohost.community.list', {
        query: query.trim() || undefined,
        filter,
        sort,
        limit: PAGE_SIZE
      }).then(
        (page) => {
          if (!current) return
          setRows(page.people)
          setCursor(page.nextCursor)
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
  }, [call, filter, query, ready, revision, sort])

  const shown = rows ?? []
  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ROW_PX,
    overscan: 8
  })
  const items = virtualizer.getVirtualItems()
  const last = items.at(-1)
  useEffect(() => {
    if (!cursor || loadingMore || !last || last.index < shown.length - 10) return
    setLoadingMore(true)
    call('cohost.community.list', {
      query: query.trim() || undefined,
      filter,
      sort,
      cursor,
      limit: PAGE_SIZE
    })
      .then(
        (page) => {
          setRows((current) => [...(current ?? []), ...page.people])
          setCursor(page.nextCursor)
        },
        () => setCursor(undefined)
      )
      .finally(() => setLoadingMore(false))
  }, [call, cursor, filter, last, loadingMore, query, shown.length, sort])

  return (
    <PanelSection
      description="Everyone who chatted, as one person per human. Open someone to see their card."
      title="People"
      data-testid="community-people"
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <InputGroup className="min-w-40 flex-1">
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search people"
              placeholder="Search people"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </InputGroup>
          <Select
            items={SORT_ITEMS}
            value={sort}
            onValueChange={(next) => {
              if (next) setSort(next as CommunityListSort)
            }}
          >
            <SelectTrigger aria-label="Sort people" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_ITEMS) as CommunityListSort[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {SORT_ITEMS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <SegmentedControl
          aria-label="Show"
          options={FILTERS}
          value={filter}
          onValueChange={setFilter}
        />
        {rows === null ? (
          <div className="flex justify-center py-6">
            <Spinner aria-label="Loading people" />
          </div>
        ) : shown.length === 0 ? (
          <Empty className="py-6" data-testid="community-people-empty">
            <EmptyHeader>
              <EmptyTitle>
                {query.trim()
                  ? 'No one by that name'
                  : filter === 'regulars'
                    ? 'No regulars yet'
                    : 'No one here yet'}
              </EmptyTitle>
              <EmptyDescription>
                {query.trim()
                  ? 'Try another name, or show Everyone.'
                  : filter === 'regulars'
                    ? 'Someone becomes a regular after chatting in a few of your streams.'
                    : 'People show up here after they chat in one of your streams.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-hidden rounded-row border border-border bg-inset">
            <ScrollArea
              ref={viewportRef}
              aria-label="People"
              className="h-96"
              data-testid="community-people-list"
            >
              <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {items.map((item) => {
                  const row = shown[item.index]
                  if (!row) return null
                  return (
                    <div
                      key={row.id}
                      className="absolute top-0 left-0 w-full border-b border-border last:border-b-0"
                      style={{ height: ROW_PX, transform: `translateY(${item.start}px)` }}
                    >
                      <PersonRow nowMs={nowMs} row={row} onOpen={() => onOpen(row)} />
                    </div>
                  )
                })}
              </div>
            </ScrollArea>
          </div>
        )}
      </div>
    </PanelSection>
  )
}

function PersonRow({
  row,
  nowMs,
  onOpen
}: {
  row: CommunityPersonRow
  nowMs: number
  onOpen: () => void
}): ReactElement {
  const avatar = useCachedAvatar(row.avatarUrl)
  return (
    <button
      className="flex h-row w-full min-w-0 items-center gap-2.5 px-3 text-left text-sm outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      data-person-id={row.id}
      data-testid="community-person-row"
      type="button"
      onClick={onOpen}
    >
      <Avatar aria-hidden size="sm">
        {avatar ? <AvatarImage alt="" src={avatar} /> : null}
        <AvatarFallback>{monogramInitials(row.name)}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 truncate font-medium text-foreground">{row.name}</span>
      <span className="flex shrink-0 items-center gap-1" aria-hidden>
        {row.platforms.map((platform) => (
          <ChatPlatformIcon key={platform} className="mr-0" decorative platform={platform} />
        ))}
      </span>
      <span className="sr-only">{row.platforms.map(platformLabel).join(', ')}</span>
      {row.status === 'bot' ? (
        <Badge className="shrink-0" variant="outline">
          Bot
        </Badge>
      ) : row.regular ? (
        <Badge className="shrink-0" variant="outline">
          Regular
        </Badge>
      ) : null}
      <span className="ml-auto min-w-0 shrink truncate text-meta text-muted-foreground">
        {personRowContext(row, nowMs)}
      </span>
    </button>
  )
}

/** D-4: the switches, the threshold, retention, the Premium rows, forgetting. */
function CommunitySettingsSection({
  community
}: {
  community: CommunityClientState
}): ReactElement {
  const { cohostSettings, patchCohostSettings, cohostGate } = useStudioCore()
  const settings = cohostSettings?.community ?? DEFAULT_COMMUNITY_SETTINGS
  const [forgetAllOpen, setForgetAllOpen] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  const { copied, copy } = useCopyText()
  const premium = cohostGate.allowed
  const save = (patch: Partial<CommunitySettings>): void => {
    void patchCohostSettings({ community: { ...settings, ...patch } }).catch((error: unknown) =>
      toastUserError(error, { action: 'save', object: 'community settings' }, { id: 'community' })
    )
  }
  const off = !settings.enabled
  const offReason = 'Turn on Remember my community first.'
  const fileReason = 'Export and Import arrive with the file picker in a later update.'
  return (
    <>
      <PanelSection
        description="Free, and kept on this computer. Viewers can type !forgetme in chat anytime."
        title="Community settings"
        data-testid="community-settings"
      >
        <FieldGroup variant="grouped">
          <SettingsRow
            description="Count who comes back, so chat shows regulars and Buddy can welcome them."
            label="Remember my community"
          >
            <Switch checked={settings.enabled} onCheckedChange={(enabled) => save({ enabled })} />
          </SettingsRow>
          <SettingsRow
            description="Buddy waves and says hi to regulars in its bubble. Nothing goes to chat."
            label="Welcome regulars on stream"
          >
            <DisabledReason reason={off ? offReason : null}>
              <Switch
                checked={settings.welcomeOnStream}
                disabled={off}
                onCheckedChange={(welcomeOnStream) => save({ welcomeOnStream })}
              />
            </DisabledReason>
          </SettingsRow>
          <SettingsRow
            description="Put a milestone card on stream by itself. Off: you choose on Buddy's card."
            label="Show milestone cards automatically"
          >
            <DisabledReason reason={off ? offReason : null}>
              <Switch
                checked={settings.milestoneCards}
                disabled={off}
                onCheckedChange={(milestoneCards) => save({ milestoneCards })}
              />
            </DisabledReason>
          </SettingsRow>
          <SettingsRow
            description="Streams in the last 90 days before someone counts as a regular."
            label="Regular after"
          >
            <Select
              disabled={off}
              items={Object.fromEntries(
                Array.from({ length: 9 }, (_, index) => [String(index + 2), `${index + 2} streams`])
              )}
              value={String(settings.regularStreams)}
              onValueChange={(next) => {
                if (next) save({ regularStreams: Number(next) })
              }}
            >
              <SelectTrigger aria-label="Regular after" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 9 }, (_, index) => index + 2).map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {value} streams
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        </FieldGroup>
        <Alert data-testid="community-retention" variant="quiet">
          <AlertTitle>
            Twitch, Kick and X viewers are forgotten 12 months after their last chat.{' '}
            {YOUTUBE_RETENTION_LINE}
          </AlertTitle>
        </Alert>
      </PanelSection>
      <PanelSection
        description="Buddy remembers what regulars say about themselves, and your community follows you to your other computers, encrypted so Videorc can't read it."
        title="Premium"
        data-testid="community-premium"
      >
        {premium ? null : (
          <LockAlert
            action={lockAlertAction(unlockActionForGate(cohostGate))}
            reason={BUDDY_REMEMBERS_LOCK_REASON}
          />
        )}
        <FieldGroup variant="grouped">
          <SettingsRow
            description="After each stream, Buddy keeps a few short facts people told chat about themselves. Never from YouTube."
            label="Buddy remembers"
          >
            <DisabledReason
              reason={!premium ? BUDDY_REMEMBERS_LOCK_REASON : off ? offReason : null}
            >
              <Switch
                checked={premium && settings.remember}
                disabled={!premium || off}
                onCheckedChange={(remember) => save({ remember })}
              />
            </DisabledReason>
          </SettingsRow>
          <SettingsRow
            description="The same community on your other computers. YouTube viewers are not synced (YouTube's rules)."
            label="Community sync"
          >
            <DisabledReason
              reason={
                !premium
                  ? 'Community sync is part of Premium.'
                  : 'Community sync arrives in a later update.'
              }
            >
              <Switch checked={false} disabled />
            </DisabledReason>
          </SettingsRow>
        </FieldGroup>
      </PanelSection>
      <PanelSection
        description="Your community's file, and the line that tells viewers what Videorc keeps."
        title="Your data"
        data-testid="community-data"
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <p className="text-meta text-muted-foreground">
              For your channel description or a panel:
            </p>
            <p
              className="rounded-row bg-inset px-3 py-2 text-xs text-foreground select-text"
              data-testid="community-disclosure"
            >
              {COMMUNITY_DISCLOSURE_LINE}
            </p>
            <div>
              <Button
                size="xs"
                type="button"
                variant="secondary"
                onClick={() => void copy(COMMUNITY_DISCLOSURE_LINE)}
              >
                <CopyIcon data-icon="inline-start" />
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <DisabledReason reason={fileReason}>
              <Button disabled type="button" variant="outline">
                Export…
              </Button>
            </DisabledReason>
            <DisabledReason reason={fileReason}>
              <Button disabled type="button" variant="outline">
                Import…
              </Button>
            </DisabledReason>
            <span className="flex-1" />
            <Button
              data-testid="community-forget-all"
              disabled={!community.ready}
              type="button"
              variant="destructive"
              onClick={() => setForgetAllOpen(true)}
            >
              Forget everyone…
            </Button>
          </div>
        </div>
      </PanelSection>
      <ConfirmDialog
        confirmDisabled={forgetting}
        confirmLabel={forgetting ? 'Forgetting…' : 'Forget everyone'}
        description="Videorc deletes everything it remembers about your chat on this computer: people, links, notes and Buddy's memories. Your recordings and chat history stay."
        open={forgetAllOpen}
        testId="community-forget-all"
        title="Forget everyone?"
        onCancel={() => setForgetAllOpen(false)}
        onConfirm={() => {
          setForgetting(true)
          community
            .call('cohost.community.forgetAll', undefined)
            .then(
              () => {
                setForgetAllOpen(false)
                community.bump()
              },
              (error: unknown) =>
                toastUserError(error, { action: 'forget', object: 'everyone' }, { id: 'community' })
            )
            .finally(() => setForgetting(false))
        }}
      />
    </>
  )
}
