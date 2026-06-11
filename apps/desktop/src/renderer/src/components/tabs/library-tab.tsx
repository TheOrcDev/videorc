import {
  ArrowCounterClockwise,
  CheckCircle,
  CircleNotch,
  FileVideo,
  Sparkle,
  WarningCircle,
  Wrench
} from '@phosphor-icons/react'
import { type ReactElement, useState } from 'react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useStudio } from '@/hooks/use-studio'
import type { FileAssessment, GateStatus, SessionSummary } from '@/lib/backend'
import { dayLabel, durationMsLabel, isActiveRecordingState } from '@/lib/format'

export function LibraryTab({
  onOpenInAi
}: {
  onOpenInAi: (sessionId: string) => void
}): ReactElement {
  const { sessions } = useStudio()

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Library</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Every recording and stream becomes a local session. Files stay on disk; AI work happens in
          the AI tab.
        </p>
      </div>
      {sessions.length === 0 ? (
        <Empty className="rounded-xl border py-16">
          <EmptyMedia variant="icon">
            <FileVideo weight="duotone" />
          </EmptyMedia>
          <EmptyTitle>No sessions yet</EmptyTitle>
          <EmptyDescription>
            Record or stream from the Studio tab to populate the library.
          </EmptyDescription>
        </Empty>
      ) : (
        <ScrollArea className="h-[calc(100vh-12rem)] pr-3">
          <div className="flex flex-col gap-2">
            {sessions.map((session) => (
              <SessionRow
                key={session.id}
                onOpenInAi={() => onOpenInAi(session.id)}
                session={session}
              />
            ))}
          </div>
        </ScrollArea>
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
  const filePath = session.mp4Path ?? session.outputPath ?? null

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold">{session.title}</span>
          <span className="text-xs text-muted-foreground">
            {dayLabel(session.startedAt)} · {session.mode} · {session.status}
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {session.healthEvents.length ? (
            <Badge variant="outline">{session.healthEvents.length} health</Badge>
          ) : null}
          {session.aiArtifacts.length ? (
            <Badge variant="secondary">{session.aiArtifacts.length} AI</Badge>
          ) : null}
          {session.container ? (
            <Badge variant="outline">{session.container.toUpperCase()}</Badge>
          ) : null}
          {typeof session.durationMs === 'number' ? (
            <Badge variant="secondary">{durationMsLabel(session.durationMs)}</Badge>
          ) : null}
          {session.mp4Path ? <Badge variant="success">MP4</Badge> : null}
        </div>
      </div>
      <p className="truncate rounded-lg bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
        {session.mp4Path ?? session.outputPath ?? session.streamPreset ?? 'No local file'}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={onOpenInAi}>
          <Sparkle data-icon="inline-start" weight="fill" />
          Open in AI
        </Button>
      </div>
      {filePath ? <RepairControls filePath={filePath} /> : null}
    </div>
  )
}

type RepairPhase = 'idle' | 'checking' | 'assessed' | 'repairing' | 'done'

function RepairControls({ filePath }: { filePath: string }): ReactElement {
  const { assessRecording, repairRecording, restoreRecording, recording, wsStatus } = useStudio()
  const [phase, setPhase] = useState<RepairPhase>('idle')
  const [assessment, setAssessment] = useState<FileAssessment | null>(null)
  const [result, setResult] = useState<GateStatus | null>(null)
  const [hasBackup, setHasBackup] = useState(false)

  const busy = phase === 'checking' || phase === 'repairing'
  const disconnected = wsStatus !== 'connected'
  const captureProtected = isActiveRecordingState(recording.state)
  const canRepair = assessment?.repairable ?? false

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

  const reasons = repairReasons(result, assessment)

  return (
    <div className="flex flex-col gap-2 border-t pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={busy || disconnected || captureProtected}
          size="sm"
          variant="outline"
          onClick={runCheck}
        >
          {phase === 'checking' ? (
            <CircleNotch className="animate-spin" data-icon="inline-start" />
          ) : (
            <CheckCircle data-icon="inline-start" />
          )}
          {phase === 'checking' ? 'Checking…' : 'Check quality'}
        </Button>
        {canRepair ? (
          <Button disabled={busy || disconnected || captureProtected} size="sm" onClick={runRepair}>
            {phase === 'repairing' ? (
              <CircleNotch className="animate-spin" data-icon="inline-start" />
            ) : (
              <Wrench data-icon="inline-start" />
            )}
            {phase === 'repairing' ? 'Repairing…' : 'Repair & fix'}
          </Button>
        ) : null}
        {hasBackup ? (
          <Button
            disabled={busy || disconnected || captureProtected}
            size="sm"
            variant="ghost"
            onClick={runRestore}
          >
            <ArrowCounterClockwise data-icon="inline-start" />
            Restore original
          </Button>
        ) : null}
        {captureProtected ? <Badge variant="outline">Deferred while recording</Badge> : null}
        <RepairBadge assessment={assessment} result={result} />
      </div>
      {reasons.length > 0 ? (
        <Alert variant={result?.status === 'failed' ? 'destructive' : 'warning'}>
          <WarningCircle />
          <AlertTitle>
            {result?.status === 'failed'
              ? 'The quality check could not run'
              : 'Why this is not 100%'}
          </AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}

function repairReasons(result: GateStatus | null, assessment: FileAssessment | null): string[] {
  if (result) {
    if (result.status === 'not-hundred-percent') {
      return result.reasons
    }
    if (result.status === 'failed') {
      return [result.reason]
    }
    return []
  }
  if (assessment && assessment.verdict !== 'clean') {
    return assessment.reasons
  }
  return []
}

function RepairBadge({
  assessment,
  result
}: {
  assessment: FileAssessment | null
  result: GateStatus | null
}): ReactElement | null {
  if (result) {
    if (result.status === 'ready') {
      return <Badge variant="success">100%</Badge>
    }
    if (result.status === 'repaired') {
      return (
        <Badge variant="success">
          {result.interpolated ? 'Repaired · interpolated' : 'Repaired'}
        </Badge>
      )
    }
    if (result.status === 'not-hundred-percent') {
      return <Badge variant="warning">Not 100%</Badge>
    }
    return <Badge variant="destructive">Check failed</Badge>
  }
  if (assessment) {
    if (assessment.verdict === 'clean') {
      return <Badge variant="success">100%</Badge>
    }
    if (assessment.verdict === 'repairable') {
      return <Badge variant="warning">Needs repair</Badge>
    }
    return <Badge variant="destructive">Not 100%</Badge>
  }
  return null
}
