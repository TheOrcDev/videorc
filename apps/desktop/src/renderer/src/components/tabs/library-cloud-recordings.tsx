import { useLocalTime } from '@/lib/local-time'
import { LibraryCloudArchive } from './library-cloud-archive'
import { LibraryCloudIsoTake, useCloudIsoLibrary } from './library-cloud-iso'
import {
  fromRowControl,
  LIBRARY_HEADER_CLASS,
  LIBRARY_POSTER_CLASS,
  LIBRARY_ROW_CLASS
} from './library-table'
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactElement
} from 'react'

import { CloudMarkersButton, CloudMarkersDialog } from '@/components/cloud-markers-dialog'
import {
  CloseIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderIcon,
  LibraryIcon,
  MarkerIcon,
  RefreshIcon,
  VideoFileIcon,
  type AppIcon
} from '@/components/icons'
import { KebabContextMenu } from '@/components/kebab-context-menu'
import { KebabMenu, type KebabMenuItem } from '@/components/kebab-menu'
import { LockAlert, OfflineAlert } from '@/components/lock-alert'
import { PageHeader } from '@/components/page'
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useStudioCore, useStudioDiagnostics, useStudioCloud } from '@/hooks/use-studio'
import type { CloudRecordingItem } from '@/lib/backend'
import {
  attachCloudDownloads,
  cancelCloudDownload,
  cloudDownloads,
  failCloudDownload,
  holdCloudDownloadsView,
  revealCloudDownload,
  startCloudDownload,
  subscribeCloudDownloads
} from '@/lib/cloud-recording-downloads'
import {
  awaitingCloudRecording,
  cloudOrientationLabel,
  cloudRowView,
  cloudTakeLabel,
  CLOUD_RECORDING_POLL_MS,
  sortCloudRecordings,
  type CloudDownloadView,
  type CloudRowAction,
  type CloudRowView,
  type CloudRecordingStop
} from '@/lib/cloud-recordings-view'
import { lastCloudRecordingStop, subscribeCloudRecordingStop } from '@/lib/cloud-recordings-watch'
import { dayLabel, durationMsLabel, formatBytes, plural } from '@/lib/format'
import { formatShortDate } from '@/lib/format-time'
import { lockAlertAction } from '@/lib/lock-view'
import { revealInFileManagerLabel } from '@/lib/platform'
import { toastUserError, UserFacingError, userErrorMessage } from '@/lib/user-error'
import { cn } from '@/lib/utils'
import { openVideorcWebLink, VIDEORC_WEB_LINKS } from '@/lib/videorc-web-links'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

// The Library's Cloud tab (plan 234; Local | Cloud tabs, 2026-11-19): the
// account's cloud recordings (`cloud.recordings.list`), newest first, in the
// same table as the Local tab. A managed one (`format: "segments"`) downloads
// here as a backend job with its progress in the row, then opens in the Local
// tab; a node one downloads from the account page on videorc.com. Every row
// opens videorc.com. The Library loads this module only when the Cloud tab
// opens (a lazy import), so none of it is in the eager bundle.

const FOLDER_UNAVAILABLE =
  'The recordings folder you chose isn’t available. Choose it again in Output → Where recordings go.'
const DOWNLOAD_CONTEXT = { action: 'download', object: 'the cloud recording' } as const

/** Name, orientation, duration, size, status, actions: the Local tab's rhythm. */
const CLOUD_COLUMNS =
  'grid grid-cols-[minmax(0,1fr)_6rem_5.5rem_5.5rem_8.5rem_5rem] items-center gap-2 px-gutter min-[1280px]:grid-cols-[minmax(0,1fr)_6rem_5.5rem_5.5rem_8.5rem_13rem]'

type LoadState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; text: string }

export function LibraryCloudRecordings({
  onOpenLocal
}: {
  /** "Open in Library": the Local tab, on this session. */
  onOpenLocal?: (sessionId: string) => void
}): ReactElement {
  const { account, settings, wsStatus } = useStudioCore()
  const { cloudStatus } = useStudioCloud()
  const { client } = useStudioDiagnostics()
  const signedIn = account?.status === 'signed-in'
  const online = wsStatus === 'connected'
  const [recordings, setRecordings] = useState<CloudRecordingItem[] | null>(null)
  const [load, setLoad] = useState<LoadState>({ kind: 'idle' })
  const [pollTick, setPollTick] = useState(0)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [markersShowId, setMarkersShowId] = useState<string | null>(null)
  const rowElementsRef = useRef(new Map<string, HTMLDivElement>())
  const downloads = useSyncExternalStore(subscribeCloudDownloads, cloudDownloads)
  const stop = useSyncExternalStore(subscribeCloudRecordingStop, lastCloudRecordingStop)
  // The ids listed when a take stopped while this tab was open: the take's
  // own row is a new one (a take from a minute before may be listed already).
  // A stop from before the tab opened has none; any take then counts.
  const [listedAtStop, setListedAtStop] = useState<{
    stop: CloudRecordingStop | null
    ids: ReadonlySet<string> | undefined
  }>({ stop, ids: undefined })
  if (listedAtStop.stop !== stop) {
    setListedAtStop({
      stop,
      ids: recordings ? new Set(recordings.map((recording) => recording.id)) : undefined
    })
  }
  const mountedRef = useRef(true)
  // Plan 249 S22: each take's separate files, under its row.
  const iso = useCloudIsoLibrary({
    client,
    recordings,
    enabled: signedIn && online,
    outputDirectoryHandle: settings.outputDirectoryHandle
  })
  const openLocal = useCallback(
    (sessionId: string): void => {
      if (onOpenLocal) onOpenLocal(sessionId)
      else openWorkspaceTab('library', sessionId)
    },
    [onOpenLocal]
  )

  useEffect(() => {
    mountedRef.current = true
    const release = holdCloudDownloadsView()
    return () => {
      mountedRef.current = false
      release()
    }
  }, [])

  // The job events are subscribed before any Download can start.
  useEffect(() => {
    attachCloudDownloads(client)
  }, [client])

  const refresh = useCallback(
    async (quiet: boolean): Promise<void> => {
      if (!client) return
      if (!quiet) setLoad({ kind: 'loading' })
      try {
        const answer = await client.requestTyped('cloud.recordings.list')
        if (!mountedRef.current) return
        setRecordings(sortCloudRecordings(answer.recordings))
        setLoad({ kind: 'idle' })
      } catch (error) {
        if (!mountedRef.current) return
        const copy = userErrorMessage(error, { action: 'load', object: 'your cloud recordings' })
        console.warn('[library] cloud recordings failed:', copy.raw)
        // A quiet poll keeps the list it has; the next one tries again.
        if (!quiet) setLoad({ kind: 'error', text: copy.text })
      }
    },
    [client]
  )

  // Refreshes when the tab opens, and when sign-in or the connection comes back.
  useEffect(() => {
    if (!signedIn || !online) return
    void refresh(false)
  }, [online, refresh, signedIn])

  // After Stop recording on a cloud talk show: every 5 s, for up to 2
  // minutes, until the take's row is listed.
  const processing = awaitingCloudRecording(stop, recordings, Date.now(), listedAtStop.ids)
  useEffect(() => {
    if (!signedIn || !online || !client || !processing) return
    const timer = window.setTimeout(() => {
      void refresh(true).finally(() => {
        if (mountedRef.current) setPollTick((tick) => tick + 1)
      })
    }, CLOUD_RECORDING_POLL_MS)
    return () => window.clearTimeout(timer)
  }, [client, online, pollTick, processing, refresh, signedIn])

  const download = async (recordingId: string): Promise<void> => {
    if (!client) return
    let capability: string | undefined
    const handle = settings.outputDirectoryHandle
    if (handle) {
      // Output's folder, as the capability main issues (never a path).
      const grant = await window.videorc?.authorizeOutputDirectory?.(handle).catch(() => null)
      if (!grant) {
        failCloudDownload(recordingId)
        toastUserError(new UserFacingError(FOLDER_UNAVAILABLE), DOWNLOAD_CONTEXT, {
          id: `cloud-download:${recordingId}`
        })
        return
      }
      capability = grant.capabilityId
    }
    await startCloudDownload(client, recordingId, capability)
  }

  const orderedIds = recordings?.map((recording) => recording.id) ?? []
  const activeRowId =
    activeId !== null && orderedIds.includes(activeId) ? activeId : (orderedIds[0] ?? null)

  // ↑/↓, Home and End move between rows, as in the Local tab.
  const handleRowsKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target instanceof HTMLElement ? event.target : null
    if (!target?.dataset.videorcCloudRow || orderedIds.length === 0) return
    const index = orderedIds.indexOf(target.dataset.videorcCloudRow)
    const next =
      event.key === 'ArrowDown'
        ? orderedIds[Math.min(index + 1, orderedIds.length - 1)]
        : event.key === 'ArrowUp'
          ? orderedIds[Math.max(index - 1, 0)]
          : event.key === 'Home'
            ? orderedIds[0]
            : event.key === 'End'
              ? orderedIds[orderedIds.length - 1]
              : undefined
    if (!next) return
    event.preventDefault()
    setActiveId(next)
    const row = rowElementsRef.current.get(next)
    row?.focus({ preventScroll: true })
    row?.scrollIntoView({ block: 'nearest' })
  }

  const busy = load.kind === 'loading'
  const totalBytes = recordings?.reduce((sum, recording) => sum + recording.bytes, 0) ?? 0
  const currentShowId = cloudStatus?.show?.id
  return (
    <div className="flex flex-col" data-testid="library-cloud-recordings">
      <PageHeader
        action={
          signedIn ? (
            <>
              {currentShowId ? (
                <CloudMarkersButton disabled={!online} showId={currentShowId} />
              ) : null}
              <Button
                disabled={!online || busy}
                size="xs"
                variant="ghost"
                onClick={() => void refresh(false)}
              >
                <RefreshIcon data-icon="inline-start" />
                {busy ? 'Refreshing…' : 'Refresh'}
              </Button>
            </>
          ) : null
        }
        description="Talk shows Videorc Cloud recorded. Each one is deleted on the date shown."
        title="Cloud recordings"
      />

      {signedIn && !online ? (
        <div className="px-gutter pt-2">
          <OfflineAlert />
        </div>
      ) : null}

      {!signedIn ? (
        <div className="px-gutter py-4">
          <LockAlert
            action={lockAlertAction({ kind: 'sign-in' })}
            reason="Sign in to see your cloud recordings."
          />
        </div>
      ) : load.kind === 'error' ? (
        <div className="px-gutter py-4">
          <Alert data-testid="library-cloud-recordings-error" variant="destructive">
            <AlertTitle>{load.text}</AlertTitle>
            <AlertAction>
              <Button
                disabled={!online}
                size="xs"
                variant="outline"
                onClick={() => void refresh(false)}
              >
                Try again
              </Button>
            </AlertAction>
          </Alert>
        </div>
      ) : recordings === null ? (
        online ? (
          <Empty className="py-16">
            <EmptyDescription className="flex items-center gap-2">
              <Spinner aria-hidden />
              Loading cloud recordings…
            </EmptyDescription>
          </Empty>
        ) : null
      ) : recordings.length === 0 && !processing ? (
        <Empty className="py-16">
          <EmptyTitle>No cloud recordings yet</EmptyTitle>
          <EmptyDescription>
            Record a talk show with Videorc Cloud, and it shows up here.
          </EmptyDescription>
        </Empty>
      ) : (
        <>
          <div aria-label="Cloud recordings" className="mt-2 flex flex-col" role="grid">
            <div role="rowgroup">
              <div className={cn(CLOUD_COLUMNS, LIBRARY_HEADER_CLASS)} role="row">
                <div role="columnheader">Name</div>
                <div role="columnheader">Orientation</div>
                <div role="columnheader">Duration</div>
                <div role="columnheader">Size</div>
                <div role="columnheader">Status</div>
                <div className="text-right" role="columnheader">
                  Actions
                </div>
              </div>
            </div>
            <div role="rowgroup" onKeyDown={handleRowsKeyDown}>
              {processing ? <ProcessingRow /> : null}
              {recordings.map((recording) => {
                const isoTake = iso.takes.get(recording.id)
                return (
                  <Fragment key={recording.id}>
                    <CloudRecordingRow
                      active={activeRowId === recording.id}
                      disabled={!online}
                      download={downloads.get(recording.id) ?? null}
                      recording={recording}
                      registerRow={(element) => {
                        if (element) rowElementsRef.current.set(recording.id, element)
                        else rowElementsRef.current.delete(recording.id)
                      }}
                      onActivate={() => setActiveId(recording.id)}
                      onCancel={(jobId) => {
                        if (client) void cancelCloudDownload(client, jobId)
                      }}
                      onDownload={() => void download(recording.id)}
                      onOpenLocal={openLocal}
                      onShowMarkers={() => setMarkersShowId(recording.showId)}
                    />
                    {isoTake ? (
                      <div className="border-b border-border last:border-b-0" role="row">
                        <div role="gridcell">
                          <LibraryCloudIsoTake
                            className="pr-gutter pl-[calc(var(--spacing-gutter)+5.25rem)]"
                            disabled={!online}
                            imports={iso.imports}
                            take={isoTake}
                            onCancel={(jobId) => void iso.cancelImport(jobId)}
                            onImport={() => void iso.importTake(isoTake)}
                            onOpenSession={openLocal}
                          />
                        </div>
                      </div>
                    ) : null}
                  </Fragment>
                )
              })}
            </div>
          </div>
          {/* The same honest footer as the Local tab: what the cloud keeps. */}
          <div className="flex items-center border-t border-border px-gutter py-2 text-meta text-muted-foreground">
            {plural(recordings.length, 'cloud recording')} · {formatBytes(totalBytes)}
          </div>
        </>
      )}

      {signedIn ? (
        <div className="border-t border-border">
          <LibraryCloudArchive />
        </div>
      ) : null}

      {markersShowId ? (
        <CloudMarkersDialog
          key={markersShowId}
          showId={markersShowId}
          onClose={() => setMarkersShowId(null)}
        />
      ) : null}
    </div>
  )
}

/** A take that stopped a moment ago: the cloud is still saving it. */
function ProcessingRow(): ReactElement {
  return (
    <div
      className={cn(CLOUD_COLUMNS, LIBRARY_ROW_CLASS)}
      data-testid="library-cloud-processing"
      role="row"
    >
      <div className="flex min-w-0 items-center gap-3" role="gridcell">
        <span className={LIBRARY_POSTER_CLASS}>
          <Spinner aria-hidden className="text-muted-foreground" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">Latest take</p>
          <p className="truncate text-meta text-muted-foreground">Saving in the cloud…</p>
        </div>
      </div>
      <div role="gridcell" />
      <div role="gridcell" />
      <div role="gridcell" />
      <div role="gridcell">
        <Badge variant="outline">
          <Spinner data-icon="inline-start" />
          Processing
        </Badge>
      </div>
      <div role="gridcell" />
    </div>
  )
}

/** The direct action's words (the platform names the file manager). */
function actionLabel(action: CloudRowAction): string {
  switch (action) {
    case 'open-local':
      return 'Open in Library'
    case 'reveal':
      return revealInFileManagerLabel()
    case 'download':
      return 'Download'
    case 'retry':
      return 'Try again'
    case 'cancel':
      return 'Cancel'
    case 'open-web':
      return 'Open on videorc.com'
  }
}

const ACTION_ICON: Record<CloudRowAction, AppIcon> = {
  'open-local': LibraryIcon,
  reveal: FolderIcon,
  download: DownloadIcon,
  retry: DownloadIcon,
  cancel: CloseIcon,
  'open-web': ExternalLinkIcon
}

function CloudRecordingRow({
  recording,
  download,
  disabled,
  active,
  registerRow,
  onActivate,
  onDownload,
  onCancel,
  onOpenLocal,
  onShowMarkers
}: {
  recording: CloudRecordingItem
  download: CloudDownloadView | null
  /** Offline: nothing that needs the backend runs. */
  disabled: boolean
  /** The row that holds the list's one tab stop (roving focus). */
  active: boolean
  registerRow: (element: HTMLDivElement | null) => void
  onActivate: () => void
  onDownload: () => void
  onCancel: (jobId: string) => void
  onOpenLocal: (sessionId: string) => void
  onShowMarkers: () => void
}): ReactElement {
  useLocalTime()
  const view = cloudRowView(recording, download)
  const { status } = view
  const localSessionId = status.kind === 'downloaded' ? status.localSessionId : null
  const revealJobId = status.kind === 'downloaded' ? status.jobId : null
  const run = (action: CloudRowAction): void => {
    switch (action) {
      case 'open-local':
        if (localSessionId) onOpenLocal(localSessionId)
        return
      case 'reveal':
        if (revealJobId) revealCloudDownload(revealJobId)
        return
      case 'download':
      case 'retry':
        onDownload()
        return
      case 'cancel':
        if (status.kind === 'downloading') onCancel(status.jobId)
        return
      case 'open-web':
        openVideorcWebLink(VIDEORC_WEB_LINKS.cloudRecordings)
    }
  }
  const needsBackend = (action: CloudRowAction): boolean =>
    action === 'download' || action === 'retry' || action === 'cancel'

  // One list for the ⋯ menu and the right-click menu: open, then download,
  // then the show's markers.
  const items: KebabMenuItem[] = [
    ...(localSessionId
      ? [
          {
            id: 'open-local',
            group: 'open',
            icon: LibraryIcon,
            label: 'Open in Library',
            onSelect: () => run('open-local')
          }
        ]
      : []),
    ...(revealJobId
      ? [
          {
            id: 'reveal',
            group: 'open',
            icon: FolderIcon,
            label: revealInFileManagerLabel(),
            onSelect: () => run('reveal')
          }
        ]
      : []),
    {
      id: 'open-web',
      group: 'open',
      icon: ExternalLinkIcon,
      label: 'Open on videorc.com',
      onSelect: () => run('open-web')
    },
    ...(status.kind === 'in-cloud' || status.kind === 'failed'
      ? [
          {
            id: 'download',
            group: 'download',
            icon: DownloadIcon,
            label: status.kind === 'failed' ? 'Try the download again' : 'Download to Library',
            disabled,
            onSelect: () => run('download')
          }
        ]
      : []),
    ...(status.kind === 'downloading'
      ? [
          {
            id: 'cancel-download',
            group: 'download',
            icon: CloseIcon,
            label: 'Cancel download',
            disabled,
            onSelect: () => run('cancel')
          }
        ]
      : []),
    {
      id: 'markers',
      group: 'show',
      icon: MarkerIcon,
      label: 'Show markers',
      disabled,
      onSelect: onShowMarkers
    }
  ]
  const tabIndex = active ? undefined : -1
  const action = view.action
  const ActionIcon = action ? ACTION_ICON[action] : null

  return (
    <KebabContextMenu items={items}>
      <div
        ref={registerRow}
        className={cn(CLOUD_COLUMNS, LIBRARY_ROW_CLASS)}
        data-cloud-status={status.kind}
        data-recording-id={recording.id}
        data-testid="library-cloud-recording"
        data-videorc-cloud-row={recording.id}
        role="row"
        tabIndex={active ? 0 : -1}
        onDoubleClick={(event) => {
          if (fromRowControl(event)) return
          if (localSessionId) onOpenLocal(localSessionId)
        }}
        onFocus={onActivate}
      >
        <div className="flex min-w-0 items-center gap-3" role="gridcell">
          <span className={LIBRARY_POSTER_CLASS}>
            <VideoFileIcon className="size-4 text-muted-foreground" weight="duotone" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{cloudTakeLabel(recording)}</p>
            <p className="truncate text-meta text-muted-foreground">
              {dayLabel(recording.startedAt)}
              {view.keptUntilMs !== null
                ? ` · Kept until ${formatShortDate(view.keptUntilMs, Date.now())}`
                : ''}
            </p>
          </div>
        </div>
        <div role="gridcell">
          <Badge variant="outline">{cloudOrientationLabel(recording.orientation)}</Badge>
        </div>
        <div role="gridcell">
          <span className="text-meta text-muted-foreground tabular-nums">
            {durationMsLabel(recording.seconds * 1000)}
          </span>
        </div>
        <div role="gridcell">
          <span className="text-meta text-muted-foreground tabular-nums">
            {formatBytes(recording.bytes)}
          </span>
        </div>
        <div className="min-w-0" role="gridcell">
          <CloudStatusTag tabIndex={tabIndex} view={view} />
        </div>
        <div role="gridcell">
          <div className="flex items-center justify-end gap-0.5">
            {action && ActionIcon ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={action === 'cancel' ? 'Cancel download' : actionLabel(action)}
                      className="min-[1280px]:w-auto min-[1280px]:px-2"
                      data-cloud-action={action}
                      disabled={disabled && needsBackend(action)}
                      size="icon"
                      tabIndex={tabIndex}
                      variant="ghost"
                      onClick={() => run(action)}
                    />
                  }
                >
                  <ActionIcon data-icon="inline-start" />
                  <span className="hidden min-[1280px]:inline">{actionLabel(action)}</span>
                </TooltipTrigger>
                <TooltipContent>
                  {action === 'download' ? 'Download to Library' : actionLabel(action)}
                </TooltipContent>
              </Tooltip>
            ) : null}
            <KebabMenu items={items} label="Cloud recording actions" tabIndex={tabIndex} />
          </div>
        </div>
      </div>
    </KebabContextMenu>
  )
}

/** The Status column: the same tags as the Local tab's File column. */
function CloudStatusTag({
  view,
  tabIndex
}: {
  view: CloudRowView
  tabIndex: number | undefined
}): ReactElement {
  const kind = view.status.kind
  const working = kind === 'starting' || kind === 'downloading'
  const badge = (
    <Badge
      className="max-w-full"
      data-cloud-status-tag={kind}
      variant={kind === 'failed' ? 'destructive' : 'outline'}
    >
      {working ? <Spinner data-icon="inline-start" /> : null}
      <span className="truncate">{view.statusLabel}</span>
    </Badge>
  )
  return view.statusDetail ? (
    <InfoTooltip content={view.statusDetail} tabIndex={tabIndex ?? 0}>
      {badge}
    </InfoTooltip>
  ) : (
    badge
  )
}
