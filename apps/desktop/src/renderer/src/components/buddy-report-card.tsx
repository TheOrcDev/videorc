import {
  AlertIcon,
  type AppIcon,
  ChatIcon,
  ClipIcon,
  InfoIcon,
  MicrophoneIcon
} from '@/components/icons'
import { useMemo, useState, lazy, Suspense, type ReactElement, type ReactNode } from 'react'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import { GroupedList, ListRow } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useBuddyReport } from '@/hooks/use-buddy-report'
import { useStudioCore } from '@/hooks/use-studio'
import type { ClipMomentSource } from '@/lib/backend'
import {
  capReportList,
  formatReportCount,
  isAutoSessionTitle,
  newestStreamedSessionId,
  BUDDY_REPORT_DESCRIPTION,
  BUDDY_REPORT_EMPTY_TITLE,
  BUDDY_REPORT_LIST_CAP,
  buddyReportView,
  reportSessionChoice,
  reportSessionOptions,
  type BuddyReportSessionOption,
  type BuddyReportStat,
  type BuddyReportView
} from '@/lib/buddy-report-view'
import { cn } from '@/lib/utils'

const SessionMarkersDialog = lazy(async () => ({
  default: (await import('@/components/session-markers-dialog')).SessionMarkersDialog
}))

type ShownReport = Exclude<BuddyReportView, { kind: 'empty' }>

// Which part of a one-line row gives way first. A question keeps its words
// and lets the askers go; a moment or an alert keeps its short label and
// lets the excerpt go.
const ASKERS_YIELD =
  'select-text [&_[data-slot=list-row-context]]:max-w-32 [&_[data-slot=list-row-context]]:shrink-0'
const LABEL_STAYS = '[&_[data-slot=list-row-title]]:shrink-0'

/**
 * The Golem tab's Reports tab (plan 119 S3, plan 150 S6): what Golem caught in
 * the stream that ended last, or in any recent stream the picker names.
 * `sessionId` null follows the newest stream, so the next one that ends
 * replaces it on its own; the Library's "Golem report" passes one session.
 */
export function BuddyReportCard({
  sessionId,
  onSessionChange
}: {
  sessionId: string | null
  onSessionChange: (sessionId: string | null) => void
}): ReactElement {
  const { sessions, cohostSettings } = useStudioCore()
  const [markersOpen, setMarkersOpen] = useState(false)
  const newestId = useMemo(() => newestStreamedSessionId(sessions), [sessions])
  const ask = sessionId ?? newestId
  const { payload, loading, error, reload } = useBuddyReport(ask)
  const session = payload
    ? (sessions.find((entry) => entry.id === payload.sessionId) ?? null)
    : null
  const view = buddyReportView({ payload, session, buddyOn: cohostSettings?.enabled === true })
  const shown = view.kind === 'empty' ? null : view
  const options = reportSessionOptions(
    sessions,
    shown ? { id: shown.sessionId, title: shown.title, date: shown.date ?? '' } : null
  )
  const selectedId = ask ?? shown?.sessionId ?? null
  const showSwitcher = selectedId !== null && options.length > 0
  // The report's own actions sit in its header, beside the stream picker.
  const showMarkers = shown !== null && session !== null

  return (
    <PanelSection
      action={
        showMarkers || showSwitcher ? (
          <>
            {showMarkers ? (
              <Button
                data-testid="buddy-report-markers"
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => setMarkersOpen(true)}
              >
                <ClipIcon data-icon="inline-start" />
                Markers
              </Button>
            ) : null}
            {showSwitcher ? (
              <ReportSwitcher
                options={options}
                selectedId={selectedId}
                onSelect={(id) => onSessionChange(reportSessionChoice(id, newestId))}
              />
            ) : null}
          </>
        ) : null
      }
      description={BUDDY_REPORT_DESCRIPTION}
      title="Stream report"
    >
      <div
        aria-busy={loading || undefined}
        className="@container/buddy-report flex min-w-0 flex-col gap-4"
        data-slot="buddy-report"
        data-state={loading ? 'loading' : view.kind === 'empty' ? 'empty' : view.kind}
      >
        {error ? (
          <Alert role="status" variant="warning">
            <AlertIcon />
            <AlertTitle className="font-normal">{error}</AlertTitle>
            <AlertAction>
              <Button size="xs" type="button" variant="outline" onClick={reload}>
                Try again
              </Button>
            </AlertAction>
          </Alert>
        ) : null}
        {shown ? (
          <>
            {markersOpen && session ? (
              <Suspense fallback={null}>
                <SessionMarkersDialog session={session} onClose={() => setMarkersOpen(false)} />
              </Suspense>
            ) : null}
            <ReportBody key={shown.sessionId} view={shown} />
          </>
        ) : error ? null : loading ? (
          <p className="text-xs text-muted-foreground">Loading the report…</p>
        ) : view.kind === 'empty' ? (
          <div className="flex flex-col gap-1 py-6" data-slot="buddy-report-empty">
            <p className="text-sm font-medium text-foreground">{BUDDY_REPORT_EMPTY_TITLE}</p>
            <p className="text-xs text-muted-foreground">{view.message}</p>
          </div>
        ) : null}
      </div>
    </PanelSection>
  )
}

/** The stream picker: recent streams, newest first, named by when they ran. */
function ReportSwitcher({
  options,
  selectedId,
  onSelect
}: {
  options: readonly BuddyReportSessionOption[]
  selectedId: string
  onSelect: (sessionId: string) => void
}): ReactElement {
  const selected = options.find((option) => option.id === selectedId)
  return (
    <Select value={selectedId} onValueChange={onSelect}>
      <SelectTrigger aria-label="Stream" className="max-w-56" size="sm">
        <SelectValue>
          <span className="truncate">{selected?.date || selected?.title || 'Stream'}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end" position="popper">
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              <span className="max-w-64 truncate">{option.title}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{option.date}</span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

function ReportBody({ view }: { view: ShownReport }): ReactElement {
  return (
    <>
      <StreamLine view={view} />
      {view.note ? (
        <Alert data-testid="buddy-report-off" role="note">
          <InfoIcon />
          <AlertTitle>{view.note.title}</AlertTitle>
          <AlertDescription className="text-xs">{view.note.hint}</AlertDescription>
        </Alert>
      ) : (
        <ReportStats stats={view.stats} />
      )}
      <ReportCommands commands={view.commands} />
      {/* Plan 164 D10: what the Golem posted as you, every line. */}
      <ReportList
        id="posts"
        items={view.posts}
        label="Posted as you"
        render={(post) => (
          <ListRow
            key={post.id}
            className="select-text"
            context={<span title={post.text}>{post.text}</span>}
            data-post-result={post.result}
            interactive={false}
            meta={
              <span className="flex items-center gap-1.5">
                {post.platforms.map((platform) => (
                  <ChatPlatformIcon key={platform} platform={platform} />
                ))}
                <span>{post.resultLabel}</span>
                {post.at ? <span className="tabular-nums">{post.at}</span> : null}
              </span>
            }
            title={post.trigger}
          />
        )}
      />
      {/* Plan 150: what needs you (questions, promises) beside what happened
          (moments, alerts), two columns at lg when both sides have rows. */}
      <div
        className={cn(
          'grid min-w-0 gap-4',
          (view.missed.length > 0 || view.promises.length > 0) &&
            (view.moments.length > 0 || view.alerts.length > 0) &&
            'lg:grid-cols-2'
        )}
        data-slot="buddy-report-lists"
      >
        {view.missed.length > 0 || view.promises.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-4">
            <ReportList
              id="missed"
              items={view.missed}
              label="Missed questions"
              render={(question) => (
                <ListRow
                  key={question.id}
                  alias={question.high ? <Badge variant="outline">High</Badge> : undefined}
                  className={ASKERS_YIELD}
                  context={
                    question.askers ? (
                      <span title={question.askersTitle}>{question.askers}</span>
                    ) : undefined
                  }
                  interactive={false}
                  meta={
                    question.at ? <span className="tabular-nums">{question.at}</span> : undefined
                  }
                  statusIcons={
                    question.platforms.length > 0
                      ? question.platforms.map((platform) => (
                          <ChatPlatformIcon key={platform} platform={platform} />
                        ))
                      : undefined
                  }
                  title={<span title={question.text}>{question.text}</span>}
                />
              )}
            />
            <ReportList
              id="promises"
              items={view.promises}
              label="Open promises"
              render={(promise) => (
                <ListRow
                  key={promise.key}
                  className="select-text"
                  interactive={false}
                  meta={promise.at ? <span className="tabular-nums">{promise.at}</span> : undefined}
                  title={<span title={promise.text}>{promise.text}</span>}
                />
              )}
            />
          </div>
        ) : null}
        {view.moments.length > 0 || view.alerts.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-4">
            <ReportList
              id="moments"
              items={view.moments}
              label="Moments"
              render={(moment) => (
                <ListRow
                  key={moment.key}
                  className={cn('select-text', LABEL_STAYS)}
                  context={
                    moment.excerpt ? (
                      <span title={moment.excerpt}>{moment.excerpt}</span>
                    ) : undefined
                  }
                  data-moment={moment.kind}
                  icon={<MomentIcon kind={moment.kind} />}
                  interactive={false}
                  meta={<span className="tabular-nums">{moment.range}</span>}
                  title={moment.label}
                />
              )}
            />
            <ReportList
              id="alerts"
              items={view.alerts}
              label="Alerts"
              render={(alert) => (
                <ListRow
                  key={alert.key}
                  className={LABEL_STAYS}
                  context={alert.viewers}
                  icon={<AlertIcon className="text-muted-foreground" />}
                  interactive={false}
                  meta={alert.at ? <span className="tabular-nums">{alert.at}</span> : undefined}
                  title={alert.label}
                />
              )}
            />
          </div>
        ) : null}
      </div>
    </>
  )
}

/** Title, then how long it ran and where the chat came from. */
function StreamLine({ view }: { view: ShownReport }): ReactElement {
  const facts = [view.duration, view.chat.label].filter((fact): fact is string => Boolean(fact))
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-slot="buddy-report-stream">
      {isAutoSessionTitle(view.title) ? null : (
        <p className="truncate text-sm font-medium text-foreground select-text" title={view.title}>
          {view.title}
        </p>
      )}
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
        {facts.map((fact, index) => (
          <span key={fact} className="contents">
            {index > 0 ? <span aria-hidden>·</span> : null}
            <span>{fact}</span>
          </span>
        ))}
        {view.chat.platforms.length > 0 ? (
          <span
            className="ml-1 inline-flex items-center gap-2.5"
            data-slot="buddy-report-platforms"
          >
            {view.chat.platforms.map((entry) => (
              <span
                key={entry.platform}
                aria-label={entry.label}
                className="inline-flex items-center gap-1 tabular-nums"
                role="img"
                title={entry.label}
              >
                <ChatPlatformIcon decorative platform={entry.platform} />
                {/* One platform's count is the total already said. */}
                {view.chat.platforms.length > 1 ? formatReportCount(entry.messages) : null}
              </span>
            ))}
          </span>
        ) : null}
      </p>
    </div>
  )
}

/**
 * What voice commands did this stream (plan 140, S6): one row, counts only,
 * and only when Golem counted any.
 */
function ReportCommands({ commands }: { commands: ShownReport['commands'] }): ReactElement | null {
  if (!commands) return null
  return (
    <div className="flex min-w-0 flex-col gap-1" data-slot="buddy-report-commands">
      <GroupedList>
        <ListRow
          className={LABEL_STAYS}
          context={
            <span className="tabular-nums">
              {commands.counts.map((count) => `${count.label} ${count.value}`).join(' · ')}
            </span>
          }
          icon={<MicrophoneIcon aria-hidden className="text-muted-foreground" />}
          interactive={false}
          meta={<span className="tabular-nums">{commands.total}</span>}
          title="Commands"
        />
      </GroupedList>
    </div>
  )
}

/**
 * The stats as a row of tiles (a KPI row): each tile the number over its
 * label, in the grouped lists' tile (8 px, hairline, white 3%). Monochrome:
 * the number in primary ink and proportional figures (it stands alone), the
 * label and a ratio's whole in secondary ink; no deltas. The columns follow
 * the report's own width (2, 3, 5, then all 9 in one row), and every tile in
 * a row is as tall as the tallest.
 */
function ReportStats({ stats }: { stats: readonly BuddyReportStat[] }): ReactElement {
  return (
    <dl
      className="grid grid-cols-2 gap-2 @min-[30rem]/buddy-report:grid-cols-3 @min-[52rem]/buddy-report:grid-cols-5 @min-[90rem]/buddy-report:grid-cols-9"
      data-slot="buddy-report-stats"
    >
      {stats.map((stat) => (
        <div
          key={stat.id}
          className="flex min-w-0 flex-col-reverse justify-end gap-0.5 rounded-row border border-border bg-foreground/[0.03] px-3 py-2.5"
          data-stat={stat.id}
        >
          <dt className="text-xs text-muted-foreground">{stat.label}</dt>
          <dd className="text-xl leading-7 font-semibold text-foreground">
            {stat.value}
            {stat.of ? (
              <span className="text-base font-medium text-muted-foreground"> / {stat.of}</span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  )
}

const MOMENT_ICONS: Record<ClipMomentSource, AppIcon> = {
  voice: MicrophoneIcon,
  manual: ClipIcon,
  chat: ChatIcon
}

function MomentIcon({ kind }: { kind: ClipMomentSource }): ReactElement {
  const Glyph = MOMENT_ICONS[kind]
  return <Glyph aria-hidden className="text-muted-foreground" />
}

/** A grouped list that shows its first rows, with the rest behind "Show all". */
function ReportList<T>({
  id,
  label,
  items,
  render
}: {
  id: string
  label: string
  items: readonly T[]
  render: (item: T) => ReactNode
}): ReactElement | null {
  const [expanded, setExpanded] = useState(false)
  if (items.length === 0) return null
  const { visible } = capReportList(items, expanded)
  return (
    <div className="flex min-w-0 flex-col gap-1" data-slot={`buddy-report-${id}`}>
      <GroupedList
        label={
          <>
            {label} <span className="font-normal tabular-nums">· {items.length}</span>
          </>
        }
      >
        {visible.map(render)}
      </GroupedList>
      {items.length > BUDDY_REPORT_LIST_CAP ? (
        <Button
          aria-expanded={expanded}
          className="w-fit"
          size="xs"
          type="button"
          variant="ghost"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show fewer' : `Show all ${items.length}`}
        </Button>
      ) : null}
    </div>
  )
}
