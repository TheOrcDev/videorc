import {
  ArrowCounterClockwise,
  ChatCircle,
  CheckCircle,
  CircleNotch,
  DotsThree,
  FileVideo,
  FolderOpen,
  Sparkle,
  WarningCircle,
  Wrench
} from '@phosphor-icons/react'
import { type ReactElement, useState } from 'react'
import { toast } from 'sonner'

import { PageHeader } from '@/components/page'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { useStudio } from '@/hooks/use-studio'
import type { FileAssessment, GateStatus, SessionSummary } from '@/lib/backend'
import { dayLabel, durationMsLabel, isActiveRecordingState } from '@/lib/format'
import { recordingQualityState, type RecordingQualityState } from '@/lib/recording-quality'

export function LibraryTab({
  onOpenInAi
}: {
  onOpenInAi: (sessionId: string) => void
}): ReactElement {
  const { sessions } = useStudio()

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Library"
        description="Every recording and stream becomes a local session. Files stay on disk; AI work happens in the AI tab."
      />
      {sessions.length === 0 ? (
        <Empty className="rounded-panel border py-16">
          <EmptyMedia variant="icon">
            <FileVideo weight="duotone" />
          </EmptyMedia>
          <EmptyTitle>No sessions yet</EmptyTitle>
          <EmptyDescription>
            Record or stream from the Studio tab to populate the library.
          </EmptyDescription>
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              onOpenInAi={() => onOpenInAi(session.id)}
              session={session}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SessionRow({
  session,
  onOpenInAi
}: {
  session: SessionSummary
  onOpenInAi: () => void
}): ReactElement {
  const { openSessionCommentsWindow } = useStudio()
  const filePath = session.mp4Path ?? session.outputPath ?? null
  const format = session.mp4Path
    ? 'MP4'
    : session.container
      ? session.container.toUpperCase()
      : null

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-row border border-border p-3">
      {session.title ? (
        <span className="truncate text-sm font-semibold">{session.title}</span>
      ) : null}
      {/* Date / mode / status on one clamped line at full card width — it no
          longer shares a row with the badges, so it can't be crushed into a
          token-per-line wrap the way it was in the old justify-between layout. */}
      <span className="truncate text-xs text-muted-foreground">
        {dayLabel(session.startedAt)} · {session.mode} · {session.status}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {format ? <Badge variant={session.mp4Path ? 'success' : 'outline'}>{format}</Badge> : null}
        {typeof session.durationMs === 'number' ? (
          <Badge variant="secondary">{durationMsLabel(session.durationMs)}</Badge>
        ) : null}
        {session.aiArtifacts.length ? (
          <Badge variant="secondary">{session.aiArtifacts.length} AI</Badge>
        ) : null}
        {session.commentCount ? (
          <Badge variant="secondary">
            {session.commentCount} {session.commentCount === 1 ? 'comment' : 'comments'}
          </Badge>
        ) : null}
      </div>
      <p
        className="truncate rounded-row bg-muted/40 px-2.5 py-1.5 font-mono text-xs text-muted-foreground"
        title={session.mp4Path ?? session.outputPath ?? undefined}
      >
        {session.mp4Path ?? session.outputPath ?? session.streamPreset ?? 'No local file'}
      </p>
      {filePath ? (
        <SessionActions filePath={filePath} session={session} onOpenInAi={onOpenInAi} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={onOpenInAi}>
            <Sparkle data-icon="inline-start" weight="fill" />
            Open in AI
          </Button>
          {session.commentCount ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void openSessionCommentsWindow(session.id)}
            >
              <ChatCircle data-icon="inline-start" />
              Open Comments
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}

type RepairPhase = 'idle' | 'checking' | 'assessed' | 'repairing' | 'done'

// One actions surface per session: Open-in-AI stays the visible primary,
// everything file-shaped (export, quality check, repair, restore) lives in
// the row menu. Library is the single home of session artifacts (ux-ia plan
// slice 3 — Export MP4 moved here from the old Recording artifacts grid).
function SessionActions({
  filePath,
  session,
  onOpenInAi
}: {
  filePath: string
  session: SessionSummary
  onOpenInAi: () => void
}): ReactElement {
  const {
    assessRecording,
    repairRecording,
    restoreRecording,
    recording,
    wsStatus,
    remuxSession,
    openSessionCommentsWindow
  } = useStudio()
  const [phase, setPhase] = useState<RepairPhase>('idle')
  const [assessment, setAssessment] = useState<FileAssessment | null>(null)
  const [result, setResult] = useState<GateStatus | null>(null)
  const [hasBackup, setHasBackup] = useState(false)

  const busy = phase === 'checking' || phase === 'repairing'
  const disconnected = wsStatus !== 'connected'
  const captureProtected = isActiveRecordingState(recording.state)
  const canRepair = assessment?.repairable ?? false
  const persistedRepaired = session.qualityStatus?.status === 'repaired'
  const canExportMp4 = Boolean(
    session.status === 'completed' && session.outputPath?.endsWith('.mkv') && !session.mp4Path
  )
  const canOpenComments = session.commentCount > 0
  const quality = recordingQualityState({
    qualityStatus: session.qualityStatus,
    assessment,
    result
  })

  const runCheck = async (): Promise<void> => {
    setPhase('checking')
    try {
      const next = await assessRecording(filePath)
      setAssessment(next)
      setResult(null)
      setHasBackup(next.hasBackup)
      setPhase('assessed')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Quality check failed.')
      setPhase('idle')
    }
  }

  const runRepair = async (): Promise<void> => {
    setPhase('repairing')
    try {
      const next = await repairRecording(filePath)
      setResult(next)
      setPhase('done')
      if (next.status === 'repaired') {
        setHasBackup(true)
        toast.success(
          next.interpolated ? 'Repaired with interpolated frames.' : 'Recording repaired.'
        )
      } else if (next.status === 'ready') {
        toast.success('Recording already passes every quality gate.')
      } else if (next.status === 'not-hundred-percent') {
        toast.warning('Kept the original — it could not reach 100%.')
      } else {
        toast.error('The quality check could not run.')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Repair failed.')
      setPhase('assessed')
    }
  }

  const runRestore = async (): Promise<void> => {
    try {
      const restored = await restoreRecording(filePath)
      if (restored) {
        toast.success('Restored the original recording from backup.')
        setHasBackup(false)
        setAssessment(null)
        setResult(null)
        setPhase('idle')
      } else {
        toast.info('No backup was found for this recording.')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Restore failed.')
    }
  }

  const revealFile = (): void => {
    const reveal = window.videorc?.revealPath
    if (!reveal) {
      toast.error('Reveal is not available on this platform.')
      return
    }
    void reveal(filePath)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={onOpenInAi}>
          <Sparkle data-icon="inline-start" weight="fill" />
          Open in AI
        </Button>
        <Button size="sm" variant="outline" onClick={revealFile}>
          <FolderOpen data-icon="inline-start" />
          Reveal
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {captureProtected ? <Badge variant="outline">Deferred while recording</Badge> : null}
          <RepairBadge quality={quality} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label="Session actions"
                className="size-8"
                disabled={disconnected}
                size="icon"
                variant="ghost"
              >
                {busy ? (
                  <CircleNotch className="size-4 animate-spin" />
                ) : (
                  <DotsThree className="size-4" weight="bold" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={!canExportMp4 || busy}
                onClick={() => void remuxSession(session.id)}
              >
                <FileVideo />
                Export MP4
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!canOpenComments || busy || disconnected}
                onClick={() => void openSessionCommentsWindow(session.id)}
              >
                <ChatCircle />
                Open Comments
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={busy || captureProtected} onClick={() => void runCheck()}>
                <CheckCircle />
                {phase === 'checking' ? 'Checking…' : 'Check quality'}
              </DropdownMenuItem>
              {canRepair ? (
                <DropdownMenuItem
                  disabled={busy || captureProtected}
                  onClick={() => void runRepair()}
                >
                  <Wrench />
                  {phase === 'repairing' ? 'Repairing…' : 'Repair & fix'}
                </DropdownMenuItem>
              ) : null}
              {hasBackup || persistedRepaired ? (
                <DropdownMenuItem
                  disabled={busy || captureProtected}
                  onClick={() => void runRestore()}
                >
                  <ArrowCounterClockwise />
                  Restore original
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {quality && quality.reasons.length > 0 ? (
        <Alert variant={quality.alertVariant ?? 'warning'}>
          <WarningCircle />
          <AlertTitle>{quality.alertTitle ?? 'Recording quality'}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {quality.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}

function RepairBadge({ quality }: { quality: RecordingQualityState | null }): ReactElement | null {
  if (!quality) {
    return null
  }
  return <Badge variant={quality.badgeVariant}>{quality.label}</Badge>
}
