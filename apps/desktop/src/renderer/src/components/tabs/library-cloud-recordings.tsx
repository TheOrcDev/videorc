import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement
} from 'react'

import {
  DownloadIcon,
  ExternalLinkIcon,
  FolderIcon,
  RefreshIcon,
  VideoFileIcon
} from '@/components/icons'
import { GroupedList, ListRow } from '@/components/list-row'
import { LockAlert } from '@/components/lock-alert'
import { PanelSection } from '@/components/panel-section'
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { useStudioCore, useStudioDiagnostics } from '@/hooks/use-studio'
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
  cloudDownloadPercent,
  cloudOrientationLabel,
  CLOUD_RECORDING_POLL_MS,
  downloadsOnThisComputer,
  sortCloudRecordings,
  type CloudDownloadView
} from '@/lib/cloud-recordings-view'
import { lastCloudRecordingStop, subscribeCloudRecordingStop } from '@/lib/cloud-recordings-watch'
import { dayLabel, durationMsLabel } from '@/lib/format'
import { formatShortDate } from '@/lib/format-time'
import { lockAlertAction } from '@/lib/lock-view'
import { revealInFileManagerLabel } from '@/lib/platform'
import { toastUserError, UserFacingError, userErrorMessage } from '@/lib/user-error'
import { openVideorcWebLink, VIDEORC_WEB_LINKS } from '@/lib/videorc-web-links'

// Plan 234: the Library's "Cloud recordings" section. It lists the account's
// cloud recordings (`cloud.recordings.list`), newest first. A managed one
// (`format: "segments"`) downloads here as a backend job with its progress in
// the row, then Show in Finder; a node one downloads from the account page on
// videorc.com. The Library loads this module on its own (a lazy import), so
// none of it is in the eager bundle.

const FOLDER_UNAVAILABLE =
  'The recordings folder you chose isn’t available. Choose it again in Output → Where recordings go.'
const DOWNLOAD_CONTEXT = { action: 'download', object: 'the cloud recording' } as const

type LoadState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; text: string }

export function LibraryCloudRecordings(): ReactElement {
  const { account, settings, wsStatus } = useStudioCore()
  const { client } = useStudioDiagnostics()
  const signedIn = account?.status === 'signed-in'
  const online = wsStatus === 'connected'
  const [recordings, setRecordings] = useState<CloudRecordingItem[] | null>(null)
  const [load, setLoad] = useState<LoadState>({ kind: 'idle' })
  const [pollTick, setPollTick] = useState(0)
  const downloads = useSyncExternalStore(subscribeCloudDownloads, cloudDownloads)
  const stop = useSyncExternalStore(subscribeCloudRecordingStop, lastCloudRecordingStop)
  const mountedRef = useRef(true)

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

  // Refreshes when the Library opens, and when sign-in or the connection
  // comes back.
  useEffect(() => {
    if (!signedIn || !online) return
    void refresh(false)
  }, [online, refresh, signedIn])

  // After Stop recording on a cloud talk show: every 5 s, for up to 2
  // minutes, until the take's row is listed.
  useEffect(() => {
    if (!signedIn || !online || !client) return
    if (!awaitingCloudRecording(stop, recordings, Date.now())) return
    const timer = window.setTimeout(() => {
      void refresh(true).finally(() => {
        if (mountedRef.current) setPollTick((tick) => tick + 1)
      })
    }, CLOUD_RECORDING_POLL_MS)
    return () => window.clearTimeout(timer)
  }, [client, online, pollTick, recordings, refresh, signedIn, stop])

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

  const busy = load.kind === 'loading'
  return (
    <PanelSection
      action={
        signedIn ? (
          <Button disabled={!online || busy} variant="ghost" onClick={() => void refresh(false)}>
            <RefreshIcon data-icon="inline-start" />
            {busy ? 'Refreshing…' : 'Refresh'}
          </Button>
        ) : null
      }
      className="shrink-0 border-t"
      data-testid="library-cloud-recordings"
      description="Talk shows Videorc Cloud recorded. Each one is deleted on the date shown."
      title="Cloud recordings"
    >
      {!signedIn ? (
        <LockAlert
          action={lockAlertAction({ kind: 'sign-in' })}
          reason="Sign in to see your cloud recordings."
        />
      ) : load.kind === 'error' ? (
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
      ) : recordings === null ? (
        online ? (
          <Empty className="py-4">
            <EmptyDescription className="flex items-center gap-2">
              <Spinner aria-hidden />
              Loading cloud recordings…
            </EmptyDescription>
          </Empty>
        ) : null
      ) : recordings.length === 0 ? (
        <Empty className="py-4">
          <EmptyTitle>No cloud recordings yet</EmptyTitle>
          <EmptyDescription>
            Record a talk show with Videorc Cloud, and it shows up here.
          </EmptyDescription>
        </Empty>
      ) : (
        <div className="max-h-56 overflow-y-auto">
          <GroupedList aria-label="Cloud recordings">
            {recordings.map((recording) => (
              <CloudRecordingRow
                key={recording.id}
                disabled={!online}
                download={downloads.get(recording.id) ?? null}
                recording={recording}
                onCancel={(jobId) => {
                  if (client) void cancelCloudDownload(client, jobId)
                }}
                onDownload={() => void download(recording.id)}
              />
            ))}
          </GroupedList>
        </div>
      )}
    </PanelSection>
  )
}

function CloudRecordingRow({
  recording,
  download,
  disabled,
  onDownload,
  onCancel
}: {
  recording: CloudRecordingItem
  download: CloudDownloadView | null
  disabled: boolean
  onDownload: () => void
  onCancel: (jobId: string) => void
}): ReactElement {
  const expires = Date.parse(recording.expiresAt)
  const keptUntil = Number.isFinite(expires)
    ? `Kept until ${formatShortDate(expires, Date.now())}`
    : null
  return (
    <ListRow
      alias={<Badge variant="outline">{cloudOrientationLabel(recording.orientation)}</Badge>}
      context={dayLabel(recording.startedAt)}
      data-recording-id={recording.id}
      data-testid="library-cloud-recording"
      icon={<VideoFileIcon />}
      title="Talk show"
    >
      <span className="text-meta text-muted-foreground tabular-nums">
        {durationMsLabel(recording.seconds * 1000)}
      </span>
      {downloadsOnThisComputer(recording) ? (
        <DownloadControls
          disabled={disabled}
          download={download}
          keptUntil={keptUntil}
          onCancel={onCancel}
          onDownload={onDownload}
        />
      ) : (
        <>
          {keptUntil ? <span className="text-meta text-muted-foreground">{keptUntil}</span> : null}
          <Button
            size="xs"
            variant="outline"
            onClick={() => openVideorcWebLink(VIDEORC_WEB_LINKS.account)}
          >
            Open videorc.com
            <ExternalLinkIcon data-icon="inline-end" />
          </Button>
        </>
      )}
    </ListRow>
  )
}

function DownloadControls({
  download,
  keptUntil,
  disabled,
  onDownload,
  onCancel
}: {
  download: CloudDownloadView | null
  keptUntil: string | null
  disabled: boolean
  onDownload: () => void
  onCancel: (jobId: string) => void
}): ReactElement {
  if (download?.state === 'starting') {
    return (
      <span className="text-meta text-muted-foreground flex items-center gap-1.5">
        <Spinner aria-hidden />
        Starting…
      </span>
    )
  }
  if (download?.state === 'running') {
    const percent = cloudDownloadPercent(download)
    return (
      <>
        <Progress aria-label="Download progress" className="w-20" max={100} value={percent ?? 0} />
        <span className="text-meta text-muted-foreground w-24 tabular-nums">
          {percent === null ? 'Downloading…' : `Downloading ${percent}%`}
        </span>
        <Button size="xs" variant="ghost" onClick={() => onCancel(download.jobId)}>
          Cancel
        </Button>
      </>
    )
  }
  if (download?.state === 'done') {
    const jobId = download.jobId
    return (
      <>
        <span className="text-meta text-muted-foreground">Saved</span>
        <Button size="xs" variant="outline" onClick={() => revealCloudDownload(jobId)}>
          <FolderIcon data-icon="inline-start" />
          {revealInFileManagerLabel()}
        </Button>
      </>
    )
  }
  const failed = download?.state === 'failed'
  return (
    <>
      {failed ? (
        <span className="text-meta text-muted-foreground">Couldn't download</span>
      ) : keptUntil ? (
        <span className="text-meta text-muted-foreground">{keptUntil}</span>
      ) : null}
      <Button disabled={disabled} size="xs" variant="outline" onClick={onDownload}>
        <DownloadIcon data-icon="inline-start" />
        {failed ? 'Try again' : 'Download'}
      </Button>
    </>
  )
}
