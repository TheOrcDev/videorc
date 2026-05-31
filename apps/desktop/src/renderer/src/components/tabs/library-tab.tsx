import { FileVideo, FilmReel, Sparkle } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useStudio } from '@/hooks/use-studio'
import type { SessionSummary } from '@/lib/backend'
import { dayLabel, durationMsLabel } from '@/lib/format'

export function LibraryTab({ onOpenInAi }: { onOpenInAi: (sessionId: string) => void }): ReactElement {
  const { sessions, remuxSession } = useStudio()

  return (
    <PanelSection
      description="Every recording and stream becomes a local session. Files stay on disk; AI work happens in the AI tab."
      icon={FilmReel}
      title="Session library"
    >
      {sessions.length === 0 ? (
        <Empty className="py-10">
          <EmptyMedia variant="icon">
            <FileVideo weight="duotone" />
          </EmptyMedia>
          <EmptyTitle>No sessions yet</EmptyTitle>
          <EmptyDescription>Record or stream from the Studio tab to populate the library.</EmptyDescription>
        </Empty>
      ) : (
        <ScrollArea className="h-[calc(100vh-15rem)] pr-3">
          <div className="flex flex-col gap-2">
            {sessions.map((session) => (
              <SessionRow
                key={session.id}
                onOpenInAi={() => onOpenInAi(session.id)}
                onRemux={() => remuxSession(session.id)}
                session={session}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </PanelSection>
  )
}

function SessionRow({
  session,
  onRemux,
  onOpenInAi
}: {
  session: SessionSummary
  onRemux: () => void
  onOpenInAi: () => void
}): ReactElement {
  const canRemux = Boolean(session.status === 'completed' && session.outputPath?.endsWith('.mkv') && !session.mp4Path)

  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-card p-3">
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
          {session.container ? <Badge variant="outline">{session.container.toUpperCase()}</Badge> : null}
          {typeof session.durationMs === 'number' ? (
            <Badge variant="secondary">{durationMsLabel(session.durationMs)}</Badge>
          ) : null}
          {session.mp4Path ? <Badge variant="success">MP4</Badge> : null}
        </div>
      </div>
      <p className="truncate rounded-lg bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
        {session.outputPath ?? session.streamPreset ?? 'No local file'}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={!canRemux} size="sm" variant="outline" onClick={onRemux}>
          Remux MP4
        </Button>
        <Button size="sm" variant="secondary" onClick={onOpenInAi}>
          <Sparkle data-icon="inline-start" weight="fill" />
          Open in AI
        </Button>
      </div>
    </div>
  )
}
