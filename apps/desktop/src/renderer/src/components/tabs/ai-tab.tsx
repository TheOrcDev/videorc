import {
  Brain,
  CopySimple,
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
import { toast } from 'sonner'

import { PanelSection } from '@/components/panel-section'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldContent, FieldLabel } from '@/components/ui/field'
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
import { cloudAiReadiness } from '@/lib/ai-readiness'
import {
  activeAiWorkflowStatus,
  aiRunButtonLabel,
  latestAiProblemArtifact
} from '@/lib/ai-workflow-status'
import type { AiArtifact, SessionSummary } from '@/lib/backend'
import {
  artifactChapters,
  artifactField,
  artifactObjects,
  artifactText,
  dayLabel,
  latestArtifact,
  objectField
} from '@/lib/format'
import { VIDEORC_PREMIUM_URL } from '@/lib/premium-upgrade'
import { PUBLISH_PACK_CONTENTS, PUBLISH_PIPELINE, composeYouTubeDescription } from '@/lib/publish-pipeline'

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
    exportRunningSessionId,
    account,
    aiCapabilities,
    aiQuota,
    aiReadinessError,
    aiReadinessLoading
  } = useStudio()
  const cloudAi = cloudAiReadiness({
    account,
    capabilities: aiCapabilities,
    error: aiReadinessError,
    loading: aiReadinessLoading,
    quota: aiQuota
  })

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
        <Empty className="rounded-panel border py-10">
          <EmptyMedia variant="icon">
            <Brain weight="duotone" />
          </EmptyMedia>
          <EmptyTitle>Record something in Studio first</EmptyTitle>
          <EmptyDescription>
            Every recording can become a publishable upload. Here is what each step makes:
          </EmptyDescription>
        </Empty>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {PUBLISH_PIPELINE.map((step, index) => (
            <div key={step.kind} className="flex flex-col gap-1.5 rounded-panel border p-3">
              <span className="text-xs font-medium text-muted-foreground">{index + 1}</span>
              <span className="text-sm font-semibold">{step.name}</span>
              <p className="text-xs text-muted-foreground">{step.valueProp}</p>
              <p className="text-xs italic text-muted-foreground/70">{step.example}</p>
            </div>
          ))}
        </div>
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

          {/* D3: consent + quota as pipeline step 0 — one state-aware card with
              a single next action, instead of a two-alert wall. */}
          <PanelSection icon={ShieldCheck} title="Cloud AI — step 0">
            <div
              className={
                'flex flex-col gap-2 rounded-row border p-3 ' +
                (cloudAi.ready && aiConsent
                  ? 'border-success/40 bg-success/5'
                  : 'border-border bg-muted/20')
              }
            >
              <div className="flex items-center gap-2">
                <ShieldCheck
                  className={cloudAi.ready && aiConsent ? 'text-success' : 'text-muted-foreground'}
                  weight="fill"
                />
                <span className="flex-1 text-sm font-medium">
                  {cloudAi.ready && aiConsent
                    ? 'Cloud AI enabled for new runs'
                    : cloudAi.ready
                      ? 'One switch away'
                      : cloudAi.title}
                </span>
                {cloudAi.quotaLabel ? <Badge variant="outline">{cloudAi.quotaLabel}</Badge> : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {cloudAi.ready
                  ? 'Recordings stay local; with consent, extracted audio uploads for transcription and the artifacts land back in your library.'
                  : `${cloudAi.description} Local audio extraction always works without upload.`}
              </p>
              {cloudAi.state === 'premium-required' ? (
                <Button
                  className="w-fit"
                  size="xs"
                  variant="outline"
                  onClick={() => openExternalUrl(VIDEORC_PREMIUM_URL)}
                >
                  View Premium
                </Button>
              ) : null}
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="ai-consent">Allow cloud upload</FieldLabel>
                </FieldContent>
                <Switch
                  checked={aiConsent && cloudAi.ready}
                  disabled={!cloudAi.ready}
                  id="ai-consent"
                  onCheckedChange={setAiConsent}
                />
              </Field>
            </div>
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
        <h1 className="text-xl font-semibold tracking-tight">Publish</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Turn a finished recording into a publishable upload — transcript, title, summary,
          chapters, and highlights, bundled as a publish pack.
        </p>
      </div>
    )
  }

  function SessionActions({ session }: { session: SessionSummary }): ReactElement {
    const canRunAi = Boolean(
      session.status === 'completed' && (session.mp4Path || session.outputPath)
    )
    const hasReviewableArtifacts = session.aiArtifacts.some(
      (artifact) => artifact.status === 'ready' && artifact.kind !== 'audio-extract'
    )
    const hasFailedArtifacts = session.aiArtifacts.some((artifact) => artifact.status === 'failed')
    const canExportPublishPack = hasReviewableArtifacts
    const aiRunning = aiRunningSessionId === session.id
    const exportRunning = exportRunningSessionId === session.id
    const cloudAiBlocked = aiConsent && !cloudAi.ready
    const runningStatus = aiRunning ? activeAiWorkflowStatus(session) : null
    const runLabel = aiRunButtonLabel({
      aiRunning,
      cloudReady: cloudAi.ready,
      consent: aiConsent,
      hasFailedArtifacts,
      hasReviewableArtifacts
    })

    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!canRunAi || aiRunning || cloudAiBlocked}
            title={cloudAiBlocked ? cloudAi.description : undefined}
            onClick={() => runAiWorkflow(session.id)}
          >
            <Lightning data-icon="inline-start" weight="fill" />
            {runLabel}
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
        {runningStatus ? (
          <Alert
            className="py-2"
            variant={runningStatus.tone === 'warning' ? 'warning' : 'default'}
          >
            {runningStatus.tone === 'warning' ? (
              <Warning weight="fill" />
            ) : (
              <Lightning weight="fill" />
            )}
            <AlertTitle>{runningStatus.title}</AlertTitle>
            <AlertDescription>{runningStatus.description}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    )
  }
}

function openExternalUrl(url: string): void {
  const opener = window.videorc?.openOAuthUrl
  if (opener) {
    void opener(url)
    return
  }

  window.open(url, '_blank', 'noopener,noreferrer')
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
  const problemArtifact = latestAiProblemArtifact(session)

  const pipelineContent: Record<string, ReactNode> = {
    transcript: transcript ? (
      <p className="text-sm whitespace-pre-line text-muted-foreground">
        {artifactText(transcript)}
      </p>
    ) : null,
    'title-description':
      title || description ? (
        <>
          {title ? <p className="font-medium">{title}</p> : null}
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </>
      ) : null,
    summary: summary ? <p className="text-sm whitespace-pre-line">{artifactText(summary)}</p> : null,
    chapters: chapterItems.length ? (
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
    ) : null,
    highlights: highlightItems.length ? (
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
    ) : null
  }

  const copyActionsFor = copyActionsForArtifacts({
    title,
    description,
    summary: summary ? artifactText(summary) : '',
    transcript: transcript ? artifactText(transcript) : '',
    chapterItems
  })

  const labHasContent =
    smartZoomItems.length > 0 ||
    noiseCleanupItems.length > 0 ||
    silenceRemovalItems.length > 0 ||
    healthItems.length > 0

  return (
    <ScrollArea className="h-[calc(100vh-15rem)] pr-3">
      <div className="flex flex-col gap-2">
        {problemArtifact ? <ArtifactProblem artifact={problemArtifact} /> : null}

        {/* The five pipeline steps, in order — a card TEACHES until its
            artifact exists, then shows the content. */}
        {PUBLISH_PIPELINE.map((step, index) => {
          const content = pipelineContent[step.kind]
          return (
            <div key={step.kind} className="flex flex-col gap-2 rounded-panel border p-3">
              <div className="flex items-center gap-2">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">
                  {index + 1}
                </span>
                <span className="flex-1 text-sm font-semibold">{step.name}</span>
                <Badge variant={content ? 'success' : 'outline'}>
                  {content ? 'Ready' : 'Not run'}
                </Badge>
              </div>
              {content ?? (
                <div className="flex flex-col gap-1">
                  <p className="text-xs text-muted-foreground">{step.valueProp}</p>
                  <p className="text-xs italic text-muted-foreground/60">{step.example}</p>
                </div>
              )}
              {content ? (
                <div className="flex flex-wrap gap-1.5">
                  {copyActionsFor(step.kind).map((action) => (
                    <Button
                      key={action.label}
                      size="xs"
                      variant="outline"
                      onClick={() => void copyToClipboard(action.text(), action.label)}
                    >
                      <CopySimple data-icon="inline-start" />
                      {action.label}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}

        {/* Everything experimental lives in ONE collapsed Lab section. */}
        <Collapsible className="rounded-panel border border-dashed">
          <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2.5 text-sm font-medium">
            <span className="flex-1 text-left">Lab</span>
            <Badge variant="outline">Experimental</Badge>
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-2 px-3 pb-3">
            <p className="text-xs text-muted-foreground">
              Suggestions only — nothing here edits your recording.
            </p>
            {!labHasContent ? (
              <p className="text-xs text-muted-foreground/70">
                Zoom, cleanup, and health suggestions appear here after a workflow run.
              </p>
            ) : null}
        {smartZoomItems.length ? (
          <ArtifactSection title="Smart zoom">
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
          </CollapsibleContent>
        </Collapsible>

        {/* D4: the finale — what the pack bundles, plus the single most useful
            one-click in the tab. */}
        <div className="flex flex-col gap-2 rounded-panel border border-primary/30 bg-primary/5 p-3">
          <div className="flex items-center gap-2">
            <DownloadSimple className="text-primary" weight="duotone" />
            <span className="flex-1 text-sm font-semibold">Publish pack</span>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {PUBLISH_PACK_CONTENTS.map((entry) => {
              const present = Boolean(latestArtifact(session, entry.kind))
              return (
                <span
                  key={entry.file}
                  className={
                    'flex items-center gap-1 text-xs ' +
                    (present ? 'text-foreground' : 'text-muted-foreground/50')
                  }
                >
                  {present ? '✓' : '·'} {entry.file}
                </span>
              )
            })}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!title && !description && !chapterItems.length}
              size="sm"
              onClick={() =>
                void copyToClipboard(
                  composeYouTubeDescription({ description, chapters: chapterItems }),
                  'YouTube description'
                )
              }
            >
              <CopySimple data-icon="inline-start" />
              Copy YouTube description
            </Button>
          </div>
        </div>
      </div>
    </ScrollArea>
  )
}

// D4: per-artifact copy actions, computed against the rendered artifacts.
function copyActionsForArtifacts({
  title,
  description,
  summary,
  transcript,
  chapterItems
}: {
  title: string
  description: string
  summary: string
  transcript: string
  chapterItems: { timestamp: string; title: string }[]
}): (kind: string) => { label: string; text: () => string }[] {
  return (kind: string) => {
    switch (kind) {
      case 'title-description':
        return [
          { label: 'Copy title', text: () => title },
          { label: 'Copy description', text: () => description }
        ].filter((action) => action.text())
      case 'summary':
        return summary ? [{ label: 'Copy summary', text: () => summary }] : []
      case 'chapters':
        return chapterItems.length
          ? [
              {
                label: 'Copy YouTube chapters',
                text: () => chapterItems.map((c) => `${c.timestamp} ${c.title}`).join('\n')
              }
            ]
          : []
      case 'transcript':
        return transcript ? [{ label: 'Copy transcript', text: () => transcript }] : []
      default:
        return []
    }
  }
}

async function copyToClipboard(text: string, label: string): Promise<void> {
  await navigator.clipboard.writeText(text)
  toast.success(`${label} copied.`)
}

function ArtifactProblem({ artifact }: { artifact: AiArtifact }): ReactElement {
  const message =
    artifactField(artifact, 'message') ||
    artifactField(artifact, 'error') ||
    (artifact.status === 'pending-consent'
      ? 'Cloud AI upload is waiting for explicit consent. Enable consent and retry the workflow when ready.'
      : 'AI workflow failed before this artifact was ready. Check cloud AI readiness and retry the workflow.')
  const title =
    artifact.status === 'pending-consent' ? 'Cloud AI waiting for consent' : 'AI artifact failed'

  return (
    <Alert variant="warning">
      <Warning weight="fill" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
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
            className="flex gap-3 rounded-row border bg-muted/30 px-3 py-2"
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
    <Collapsible className="rounded-panel border border-border" defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2.5 text-sm font-medium">
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 px-3 pb-3">{children}</CollapsibleContent>
    </Collapsible>
  )
}
