import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'

import type { BackendClient } from '@/backendClient'
import {
  CameraIcon,
  DisplayIcon,
  DownloadIcon,
  MicrophoneIcon,
  WaveformIcon
} from '@/components/icons'
import { ListRow } from '@/components/list-row'
import { SectionLabel } from '@/components/section-label'
import { StatusDot } from '@/components/status-dot'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { CloudIsoImportJournal, CloudRecordingItem } from '@/lib/backend'
import {
  ISO_FOLDER_UNAVAILABLE,
  ISO_LAYOUT_UNKNOWN_NOTE,
  ISO_OVERLAP_NOTE,
  isoErrorText,
  isoFileWord,
  isoImportAnswered,
  isoImportsFromJournal,
  isoImportStarting,
  isoJournalRows,
  isoLibraryRows,
  isoParsedTakes,
  isoTakeImport,
  isoTakeImportSummary,
  reduceIsoImportEvent,
  type IsoImports,
  type IsoLibraryRow,
  type IsoParsedTake,
  type IsoTakeImport
} from '@/lib/cloud-iso-view'
import { cloudRecordingAvailability } from '@/lib/cloud-recordings-view'
import { formatBytes } from '@/lib/format'
import { toastUserError, UserFacingError } from '@/lib/user-error'
import { cn } from '@/lib/utils'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

// Plan 249 S22: a cloud take's "Separate files" in the Library, under its row
// in Cloud recordings. The files come from `cloud.iso.status` (one call per
// show, for the newest shows listed) and this computer's import journal
// (`cloud.iso.imports`); Import is one backend job per take whose files
// report through `cloud.iso.import` events. A host camera file's layout is
// unknown in v1 (it may hold packed transparency): it gets a "Layout unknown"
// badge and no picture, preview or Library link, ever.

/** At most this many shows are asked about their separate files per load. */
const ISO_SHOWS_PER_LOAD = 8
const IMPORT_CONTEXT = { action: 'import', object: 'the separate files' } as const

export type CloudIsoLibraryTake = {
  showId: string
  takeId: string
  /** Null when the cloud listed the take but its file list couldn't be read. */
  rows: IsoLibraryRow[] | null
}

export type CloudIsoLibrary = {
  /** By cloud recording id (the take's mixed program recording). */
  takes: ReadonlyMap<string, CloudIsoLibraryTake>
  imports: IsoImports
  importTake: (take: CloudIsoLibraryTake) => Promise<void>
  cancelImport: (jobId: string) => Promise<void>
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** The newest shows' ids, in the list's order (the list is newest first). */
function showsToAsk(recordings: readonly CloudRecordingItem[] | null): string[] {
  const shows: string[] = []
  for (const recording of recordings ?? []) {
    if (cloudRecordingAvailability(recording) !== 'available') continue
    if (!recording.showId || shows.includes(recording.showId)) continue
    shows.push(recording.showId)
    if (shows.length === ISO_SHOWS_PER_LOAD) break
  }
  return shows
}

export function useCloudIsoLibrary({
  client,
  recordings,
  enabled,
  outputDirectoryHandle
}: {
  client: BackendClient | null
  recordings: readonly CloudRecordingItem[] | null
  enabled: boolean
  outputDirectoryHandle?: string
}): CloudIsoLibrary {
  const [byShow, setByShow] = useState<ReadonlyMap<string, IsoParsedTake[]>>(new Map())
  const [journals, setJournals] = useState<readonly CloudIsoImportJournal[]>([])
  const [imports, setImports] = useState<IsoImports>(new Map())
  const [checkedAt, setCheckedAt] = useState(() => Date.now())
  const showsKey = showsToAsk(recordings).join('\n')

  // Each listed show's separate files. A show the cloud no longer serves
  // (expired, or never asked for them) simply has none here; a take this
  // computer imported from still shows through the journal.
  useEffect(() => {
    if (!client || !enabled || !showsKey) return
    let live = true
    const shows = showsKey.split('\n')
    void Promise.all(
      shows.map(async (showId) => {
        try {
          const answer = await client.requestTyped('cloud.iso.status', { showId })
          return [showId, isoParsedTakes(answer.iso)] as const
        } catch (error) {
          console.warn('[library] separate files check failed:', errorCode(error) ?? error)
          return [showId, [] as IsoParsedTake[]] as const
        }
      })
    ).then((answers) => {
      if (!live) return
      setByShow(new Map(answers))
      setCheckedAt(Date.now())
    })
    return () => {
      live = false
    }
  }, [client, enabled, showsKey])

  // The journal, then every file's progress as its events come.
  useEffect(() => {
    if (!client || !enabled) return
    let live = true
    const reconcile = async (): Promise<void> => {
      try {
        const next = await client.requestTyped('cloud.iso.imports', {})
        if (!live) return
        setJournals(next)
        setImports((previous) => isoImportsFromJournal(previous, next))
      } catch (error) {
        // The next ready or lagged event tries again; the rows keep what they had.
        console.warn('[library] separate files journal failed:', errorCode(error) ?? error)
      }
    }
    const offEvent = client.on('cloud.iso.import', (event) => {
      setImports((previous) => reduceIsoImportEvent(previous, event))
    })
    const offReady = client.on('backend.ready', () => void reconcile())
    const offLagged = client.on('events.lagged', () => void reconcile())
    void reconcile()
    return () => {
      live = false
      offEvent()
      offReady()
      offLagged()
    }
  }, [client, enabled])

  const takes = useMemo(() => {
    const map = new Map<string, CloudIsoLibraryTake>()
    for (const journal of journals) {
      map.set(journal.programRecordingId, {
        showId: journal.showId,
        takeId: journal.takeId,
        rows: isoJournalRows(journal)
      })
    }
    // The cloud's list wins over the journal: it knows every file.
    for (const [showId, parsed] of byShow) {
      for (const take of parsed) {
        const known = map.get(take.programRecordingId)
        if (take.ok) {
          map.set(take.programRecordingId, {
            showId,
            takeId: take.manifest.takeId,
            rows: isoLibraryRows(take.manifest, checkedAt)
          })
        } else if (!known) {
          map.set(take.programRecordingId, { showId, takeId: '', rows: null })
        }
      }
    }
    return map
  }, [byShow, checkedAt, journals])

  const importTake = useCallback(
    async (take: CloudIsoLibraryTake): Promise<void> => {
      if (!client || !take.takeId) return
      const toastId = `cloud-iso-import:${take.takeId}`
      setImports((previous) => isoImportStarting(previous, take.takeId))
      let outputDirectoryCapability: string | undefined
      if (outputDirectoryHandle) {
        // Output's folder, as the capability main issues (never a path).
        const grant = await window.videorc
          ?.authorizeOutputDirectory?.(outputDirectoryHandle)
          .catch(() => null)
        if (!grant) {
          setImports((previous) => isoImportAnswered(previous, take.takeId, null))
          toastUserError(new UserFacingError(ISO_FOLDER_UNAVAILABLE), IMPORT_CONTEXT, {
            id: toastId
          })
          return
        }
        outputDirectoryCapability = grant.capabilityId
      }
      try {
        const { jobId } = await client.requestTyped('cloud.iso.import', {
          showId: take.showId,
          takeId: take.takeId,
          ...(outputDirectoryCapability ? { outputDirectoryCapability } : {})
        })
        setImports((previous) => isoImportAnswered(previous, take.takeId, jobId))
      } catch (error) {
        setImports((previous) => isoImportAnswered(previous, take.takeId, null))
        const known = isoErrorText(errorCode(error))
        toastUserError(known ? new UserFacingError(known) : error, IMPORT_CONTEXT, { id: toastId })
      }
    },
    [client, outputDirectoryHandle]
  )

  const cancelImport = useCallback(
    async (jobId: string): Promise<void> => {
      if (!client) return
      try {
        await client.requestTyped('cloud.iso.cancelImport', { jobId })
        const next = await client.requestTyped('cloud.iso.imports', {})
        setJournals(next)
        setImports((previous) => isoImportsFromJournal(previous, next))
      } catch (error) {
        toastUserError(error, { action: 'cancel', object: 'the import' })
      }
    },
    [client]
  )

  return { takes, imports, importTake, cancelImport }
}

function roleIcon(role: IsoLibraryRow['role']): ReactNode {
  if (role.endsWith('camera')) return <CameraIcon />
  if (role.endsWith('screen')) return <DisplayIcon />
  if (role.endsWith('microphone')) return <MicrophoneIcon />
  return <WaveformIcon />
}

/** A take's "Separate files" under its Cloud recordings row. */
export function LibraryCloudIsoTake({
  take,
  imports,
  disabled,
  onImport,
  onCancel,
  onOpenSession = (sessionId) => openWorkspaceTab('library', sessionId),
  className
}: {
  take: CloudIsoLibraryTake
  imports: IsoImports
  disabled: boolean
  onImport: () => void
  onCancel: (jobId: string) => void
  /** "Open in Library" on an imported file: the Library's Local tab. */
  onOpenSession?: (sessionId: string) => void
  className?: string
}): ReactElement {
  const state = isoTakeImport(imports, take.takeId)
  const rows = take.rows
  const summary = rows ? isoTakeImportSummary(rows, state) : null
  return (
    <div
      className={cn('flex flex-col gap-1.5 py-2 pr-3 pl-10', className)}
      data-take-id={take.takeId || undefined}
      data-testid="library-cloud-iso"
    >
      <div className="flex min-h-6 items-center gap-2">
        <SectionLabel>Separate files</SectionLabel>
        <span className="ml-auto flex items-center gap-2">
          {summary?.running && state.jobId ? (
            <Button size="xs" variant="ghost" onClick={() => onCancel(state.jobId as string)}>
              Cancel
            </Button>
          ) : null}
          {summary?.action ? (
            <Button
              data-testid="library-cloud-iso-import"
              disabled={disabled || summary.running}
              size="xs"
              variant="outline"
              onClick={onImport}
            >
              <DownloadIcon data-icon="inline-start" />
              {summary.action}
            </Button>
          ) : null}
        </span>
      </div>
      {rows === null ? (
        <p className="text-meta text-muted-foreground">
          Couldn&apos;t read this take&apos;s separate files. If it keeps happening, export a
          support bundle from Health.
        </p>
      ) : (
        <>
          {/* Rows of the take's own list: no second box inside Cloud recordings. */}
          <div aria-label="Separate files" className="flex flex-col" role="list">
            {rows.map((row) => (
              <IsoFileRow key={row.entryId} row={row} state={state} onOpenSession={onOpenSession} />
            ))}
          </div>
          {rows.some((row) => row.layoutUnknown) ? (
            <p className="text-meta text-muted-foreground" data-testid="library-cloud-iso-layout">
              {ISO_LAYOUT_UNKNOWN_NOTE}
            </p>
          ) : null}
          {rows.some((row) => row.overlap) ? (
            <p className="text-meta text-muted-foreground">{ISO_OVERLAP_NOTE}</p>
          ) : null}
        </>
      )}
    </div>
  )
}

function IsoFileRow({
  row,
  state,
  onOpenSession
}: {
  row: IsoLibraryRow
  state: IsoTakeImport
  onOpenSession: (sessionId: string) => void
}): ReactElement {
  const file = state.files.get(row.entryId)
  const word = isoFileWord(file, row.bytes)
  const imported = file?.state === 'complete'
  // A layout-unknown file is never opened as a picture: no Library link.
  const sessionId =
    imported && !row.layoutUnknown ? (file?.localSessionId ?? row.localSessionId) : null
  return (
    <ListRow
      role="listitem"
      alias={
        <>
          {row.partial ? <Badge variant="outline">Partial</Badge> : null}
          {row.overlap ? <Badge variant="outline">Overlaps</Badge> : null}
          {row.layoutUnknown ? (
            <Badge data-testid="library-cloud-iso-layout-unknown" variant="warning">
              Layout unknown
            </Badge>
          ) : null}
        </>
      }
      compact
      context={row.context}
      data-entry-id={row.entryId}
      data-testid="library-cloud-iso-file"
      icon={roleIcon(row.role)}
      meta={row.bytes !== null ? formatBytes(row.bytes) : null}
      title={row.title}
    >
      {sessionId ? (
        <Button size="xs" variant="outline" onClick={() => onOpenSession(sessionId)}>
          Open in Library
        </Button>
      ) : word ? (
        <StatusDot label={word.label} tone={word.tone} />
      ) : row.unavailable ? (
        <span className="text-meta text-muted-foreground">{row.unavailable}</span>
      ) : null}
    </ListRow>
  )
}
