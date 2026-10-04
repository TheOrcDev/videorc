import {
  AlertIcon,
  type AppIcon,
  ChatIcon,
  ClipIcon,
  InfoIcon,
  MicrophoneIcon
} from '@/components/icons'
import { useMemo, useState, type ReactElement, type ReactNode } from 'react'

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
import { useOrcleReport } from '@/hooks/use-orcle-report'
import { useStudioCore } from '@/hooks/use-studio'
import type { ClipMomentSource } from '@/lib/backend'
import {
  capReportList,
  formatReportCount,
  newestStreamedSessionId,
  ORCLE_REPORT_DESCRIPTION,
  ORCLE_REPORT_LIST_CAP,
  orcleReportView,
  reportSessionChoice,
  reportSessionOptions,
  type OrcleReportSessionOption,
  type OrcleReportStat,
  type OrcleReportView
} from '@/lib/orcle-report-view'
import { cn } from '@/lib/utils'

type ShownReport = Exclude<OrcleReportView, { kind: 'empty' }>

// Which part of a one-line row gives way first. A question keeps its words
// and lets the askers go; a moment or an alert keeps its short label and
// lets the excerpt go.
const ASKERS_YIELD =
  'select-text [&_[data-slot=list-row-context]]:max-w-32 [&_[data-slot=list-row-context]]:shrink-0'
const LABEL_STAYS = '[&_[data-slot=list-row-title]]:shrink-0'

/**
 * "Last stream" (plan 119 S3): what Orcle caught in the stream that ended
 * last, or in any recent stream the switcher picks. `sessionId` null follows
 * the newest stream, so the next one that ends replaces it on its own; the
 * Library's "Orcle report" passes one session.
 */
export function OrcleReportCard({
  sessionId,
  onSessionChange
}: {
  sessionId: string | null
  onSessionChange: (sessionId: string | null) => void
}): ReactElement {
  const { sessions, cohostSettings } = useStudioCore()
  const newestId = useMemo(() => newestStreamedSessionId(sessions), [sessions])
  const ask = sessionId ?? newestId
  const { payload, loading, error, reload } = useOrcleReport(ask)
  const session = payload
    ? (sessions.find((entry) => entry.id === payload.sessionId) ?? null)
    : null
  const view = orcleReportView({ payload, session, orcleOn: cohostSettings?.enabled === true })
  const shown = view.kind === 'empty' ? null : view
  const options = reportSessionOptions(
    sessions,
    shown ? { id: shown.sessionId, title: shown.title, date: shown.date ?? '' } : null
  )
  const selectedId = ask ?? shown?.sessionId ?? null
  const latest = sessionId === null || sessionId === newestId

  return (
    <PanelSection
      action={
        selectedId && options.length > 0 ? (
          <ReportSwitcher
            options={options}
            selectedId={selectedId}
            onSelect={(id) => onSessionChange(reportSessionChoice(id, newestId))}
          />
        ) : null
      }
      description={ORCLE_REPORT_DESCRIPTION}
      title={latest ? 'Last stream' : 'Stream report'}
    >
      <div
        aria-busy={loading || undefined}
        className="flex min-w-0 flex-col gap-4"
        data-slot="orcle-report"
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
          <ReportBody key={shown.sessionId} view={shown} />
        ) : error ? null : (
          <p className="text-xs text-muted-foreground">
            {loading ? 'Loading the report…' : view.kind === 'empty' ? view.message : null}
          </p>
        )}
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
  options: readonly OrcleReportSessionOption[]
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
        <Alert data-slot="orcle-report-off" role="note">
          <InfoIcon />
          <AlertTitle>{view.note.title}</AlertTitle>
          <AlertDescription className="text-xs">{view.note.hint}</AlertDescription>
        </Alert>
      ) : (
        <ReportStats stats={view.stats} />
      )}
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
            meta={question.at ? <span className="tabular-nums">{question.at}</span> : undefined}
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
      <ReportList
        id="moments"
        items={view.moments}
        label="Moments"
        render={(moment) => (
          <ListRow
            key={moment.key}
            className={cn('select-text', LABEL_STAYS)}
            context={
              moment.excerpt ? <span title={moment.excerpt}>{moment.excerpt}</span> : undefined
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
    </>
  )
}

/** Title, then how long it ran and where the chat came from. */
function StreamLine({ view }: { view: ShownReport }): ReactElement {
  const facts = [view.duration, view.chat.label].filter((fact): fact is string => Boolean(fact))
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-slot="orcle-report-stream">
      <p className="truncate text-sm font-medium text-foreground select-text" title={view.title}>
        {view.title}
      </p>
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
            data-slot="orcle-report-platforms"
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

/** Monochrome counts, the number over its label. */
function ReportStats({ stats }: { stats: readonly OrcleReportStat[] }): ReactElement {
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-3" data-slot="orcle-report-stats">
      {stats.map((stat) => (
        <div key={stat.id} className="flex flex-col-reverse gap-0.5" data-stat={stat.id}>
          <dt className="text-[11px] text-muted-foreground">{stat.label}</dt>
          <dd className="text-[15px] leading-5 font-semibold text-foreground tabular-nums">
            {stat.value}
            {stat.of ? (
              <span className="font-normal text-muted-foreground"> / {stat.of}</span>
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
    <div className="flex min-w-0 flex-col gap-1" data-slot={`orcle-report-${id}`}>
      <GroupedList
        label={
          <>
            {label} <span className="font-normal tabular-nums">· {items.length}</span>
          </>
        }
      >
        {visible.map(render)}
      </GroupedList>
      {items.length > ORCLE_REPORT_LIST_CAP ? (
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
