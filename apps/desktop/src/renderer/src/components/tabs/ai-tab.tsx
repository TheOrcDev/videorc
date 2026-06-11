import {
  Brain,
  Crosshair,
  DownloadSimple,
  Lightning,
  Scissors,
  ShieldCheck,
  Sparkle,
  Warning,
  Waveform,
  type Icon
} from '@phosphor-icons/react'
import { useEffect, type ReactElement, type ReactNode } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useStudio } from '@/hooks/use-studio'
import type { SessionSummary } from '@/lib/backend'
import {
  artifactChapters,
  artifactField,
  artifactObjects,
  artifactText,
  dayLabel,
  latestArtifact,
  objectField
} from '@/lib/format'

export function AiTab({
  selectedSessionId,
  setSelectedSessionId
}: {
  selectedSessionId: string | null
  setSelectedSessionId: (id: string | null) => void
}): ReactElement {
  const {
    sessions,
    aiConsent,
    setAiConsent,
    runAiWorkflow,
    exportPublishPack,
    aiRunningSessionId,
    exportRunningSessionId
  } = useStudio()

  useEffect(() => {
    if (!selectedSessionId && sessions.length > 0) {
      setSelectedSessionId(sessions[0].id)
    }
  }, [selectedSessionId, sessions, setSelectedSessionId])

  const selected = sessions.find((session) => session.id === selectedSessionId) ?? null

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col gap-5">
        <AiHeader />
        <Empty className="rounded-xl border py-16">
          <EmptyMedia variant="icon">
            <Brain weight="duotone" />
          </EmptyMedia>
          <EmptyTitle>No sessions to analyze</EmptyTitle>
          <EmptyDescription>
            Record a session first, then run transcript, summary, and chapters here.
          </EmptyDescription>
        </Empty>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <AiHeader />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="flex flex-col gap-4">
          <PanelSection
            description="Pick a recording, then run or review its AI artifacts."
            icon={Sparkle}
            title="Session"
          >
            <Field>
              <FieldLabel htmlFor="ai-session">Recording</FieldLabel>
              <Select
                value={selectedSessionId ?? ''}
                onValueChange={(value) => setSelectedSessionId(value)}
              >
                <SelectTrigger className="w-full" id="ai-session">
                  <SelectValue placeholder="Select a session" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {sessions.map((session) => (
                      <SelectItem key={session.id} value={session.id}>
                        {session.title} · {dayLabel(session.startedAt)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            {selected ? <SessionActions session={selected} /> : null}
          </PanelSection>

          <PanelSection icon={ShieldCheck} title="Cloud AI consent">
            <Alert variant="warning">
              <ShieldCheck weight="fill" />
              <AlertTitle>Recordings stay local by default</AlertTitle>
              <AlertDescription>
                Without consent, Videorc only extracts local audio. Uses OPENAI_API_KEY when
                present; artifacts are stored locally with each session.
              </AlertDescription>
            </Alert>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="ai-consent">Allow cloud upload</FieldLabel>
                <FieldDescription>
                  Upload extracted audio and transcript for summaries, chapters, highlights, and
                  suggestions.
                </FieldDescription>
              </FieldContent>
              <Switch checked={aiConsent} id="ai-consent" onCheckedChange={setAiConsent} />
            </Field>
          </PanelSection>
        </div>

        <PanelSection icon={Brain} title="Publish & intelligence">
          {selected ? (
            <ArtifactView session={selected} />
          ) : (
            <Empty className="border-0 py-6">
              <EmptyTitle>No session selected</EmptyTitle>
            </Empty>
          )}
        </PanelSection>
      </div>
    </div>
  )

  function AiHeader(): ReactElement {
    return (
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">AI</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Turn a recording into a transcript, summary, chapters, and a publish pack.
        </p>
      </div>
    )
  }

  function SessionActions({ session }: { session: SessionSummary }): ReactElement {
    const canRunAi = Boolean(
      session.status === 'completed' && (session.mp4Path || session.outputPath)
    )
    const canExportPublishPack = session.aiArtifacts.some(
      (artifact) => artifact.status === 'ready' && artifact.kind !== 'audio-extract'
    )
    const aiRunning = aiRunningSessionId === session.id
    const exportRunning = exportRunningSessionId === session.id

    return (
      <div className="flex flex-wrap gap-2">
        <Button disabled={!canRunAi || aiRunning} onClick={() => runAiWorkflow(session.id)}>
          <Lightning data-icon="inline-start" weight="fill" />
          {aiRunning ? 'Running…' : 'Run AI workflow'}
        </Button>
        <Button
          disabled={!canExportPublishPack || exportRunning}
          variant="outline"
          onClick={() => exportPublishPack(session.id)}
        >
          <DownloadSimple data-icon="inline-start" />
          {exportRunning ? 'Exporting…' : 'Export pack'}
        </Button>
      </div>
    )
  }
}

function ArtifactView({ session }: { session: SessionSummary }): ReactElement {
  const titleDescription = latestArtifact(session, 'title-description')
  const transcript = latestArtifact(session, 'transcript')
  const summary = latestArtifact(session, 'summary')
  const chapters = latestArtifact(session, 'chapters')
  const highlights = latestArtifact(session, 'highlights')
  const smartZoom = latestArtifact(session, 'smart-zoom')
  const noiseCleanup = latestArtifact(session, 'noise-cleanup')
  const silenceRemoval = latestArtifact(session, 'silence-removal')
  const healthAssistant = latestArtifact(session, 'health-assistant')
  const chapterItems = chapters ? artifactChapters(chapters) : []
  const highlightItems = artifactObjects(highlights, 'highlights')
  const smartZoomItems = artifactObjects(smartZoom, 'suggestions')
  const noiseCleanupItems = artifactObjects(noiseCleanup, 'suggestions')
  const silenceRemovalItems = artifactObjects(silenceRemoval, 'suggestions')
  const healthItems = artifactObjects(healthAssistant, 'explanations')
  const title = titleDescription ? artifactField(titleDescription, 'title') : ''
  const description = titleDescription ? artifactField(titleDescription, 'description') : ''

  if (!session.aiArtifacts.length) {
    return (
      <Empty className="border-0 py-6">
        <EmptyTitle>No artifacts yet</EmptyTitle>
        <EmptyDescription>
          Run the AI workflow to generate transcript, summary, chapters, and creator intelligence.
        </EmptyDescription>
      </Empty>
    )
  }

  return (
    <ScrollArea className="h-[calc(100vh-15rem)] pr-3">
      <div className="flex flex-col gap-2">
        {title || description ? (
          <ArtifactSection defaultOpen title="Title & description">
            {title ? <p className="font-medium">{title}</p> : null}
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          </ArtifactSection>
        ) : null}
        {summary ? (
          <ArtifactSection defaultOpen title="Summary">
            <p className="text-sm whitespace-pre-line">{artifactText(summary)}</p>
          </ArtifactSection>
        ) : null}
        {chapterItems.length ? (
          <ArtifactSection title="Chapters">
            <ol className="flex flex-col gap-1.5">
              {chapterItems.map((chapter) => (
                <li className="flex gap-3 text-sm" key={`${chapter.timestamp}-${chapter.title}`}>
                  <time className="font-mono text-xs text-muted-foreground tabular-nums">
                    {chapter.timestamp}
                  </time>
                  <span>{chapter.title}</span>
                </li>
              ))}
            </ol>
          </ArtifactSection>
        ) : null}
        {highlightItems.length ? (
          <ArtifactSection defaultOpen title="Highlights">
            <InsightList
              badgeField="timestamp"
              details={[
                ['reason', 'Reason'],
                ['suggestedUse', 'Use']
              ]}
              icon={Lightning}
              items={highlightItems}
              primaryField="title"
            />
          </ArtifactSection>
        ) : null}
        {smartZoomItems.length ? (
          <ArtifactSection title="Smart zoom prototype">
            <InsightList
              badgeField="timestamp"
              details={[
                ['subject', 'Subject'],
                ['reason', 'Why']
              ]}
              icon={Crosshair}
              items={smartZoomItems}
              primaryField="action"
            />
          </ArtifactSection>
        ) : null}
        {noiseCleanupItems.length || silenceRemovalItems.length ? (
          <ArtifactSection title="Cleanup suggestions">
            <div className="flex flex-col gap-3">
              {noiseCleanupItems.length ? (
                <InsightList
                  details={[
                    ['suggestion', 'Suggestion'],
                    ['confidence', 'Confidence']
                  ]}
                  icon={Waveform}
                  items={noiseCleanupItems}
                  primaryField="issue"
                />
              ) : null}
              {silenceRemovalItems.length ? (
                <InsightList
                  badgeField="timestamp"
                  details={[
                    ['reason', 'Reason'],
                    ['editSuggestion', 'Edit']
                  ]}
                  icon={Scissors}
                  items={silenceRemovalItems}
                  primaryField="reason"
                />
              ) : null}
            </div>
          </ArtifactSection>
        ) : null}
        {healthItems.length ? (
          <ArtifactSection title="Health assistant">
            <InsightList
              badgeField="level"
              details={[
                ['explanation', 'Explanation'],
                ['action', 'Action']
              ]}
              icon={Warning}
              items={healthItems}
              primaryField="issue"
            />
          </ArtifactSection>
        ) : null}
        {transcript ? (
          <ArtifactSection title="Transcript">
            <p className="text-sm whitespace-pre-line text-muted-foreground">
              {artifactText(transcript)}
            </p>
          </ArtifactSection>
        ) : null}
      </div>
    </ScrollArea>
  )
}

function InsightList({
  items,
  icon: LeadingIcon,
  primaryField,
  badgeField,
  details
}: {
  items: Record<string, unknown>[]
  icon: Icon
  primaryField: string
  badgeField?: string
  details: Array<[string, string]>
}): ReactElement {
  return (
    <ol className="flex flex-col gap-2">
      {items.map((item, index) => {
        const title = objectField(item, primaryField) || 'Suggestion'
        const badge = badgeField ? objectField(item, badgeField) : ''

        return (
          <li
            className="flex gap-3 rounded-lg border bg-muted/30 px-3 py-2"
            key={`${title}-${index}`}
          >
            <LeadingIcon className="mt-0.5 shrink-0 text-muted-foreground" weight="duotone" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-medium">{title}</span>
                {badge ? <Badge variant="outline">{badge}</Badge> : null}
              </div>
              {details.map(([field, label]) => {
                const value = objectField(item, field)
                return value ? (
                  <p className="text-xs text-muted-foreground" key={field}>
                    <span className="font-medium text-foreground">{label}:</span> {value}
                  </p>
                ) : null
              })}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function ArtifactSection({
  title,
  defaultOpen = false,
  children
}: {
  title: string
  defaultOpen?: boolean
  children: ReactNode
}): ReactElement {
  return (
    <Collapsible className="rounded-xl border border-border" defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2.5 text-sm font-medium">
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 px-3 pb-3">{children}</CollapsibleContent>
    </Collapsible>
  )
}
