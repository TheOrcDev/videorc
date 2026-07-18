import {
  Brain,
  CopySimple,
  Crosshair,
  DownloadSimple,
  Info,
  Lightning,
  Scissors,
  ShieldCheck,
  Sparkle,
  Warning,
  Waveform,
  type Icon
} from '@phosphor-icons/react'
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { toast } from 'sonner'

import { PanelSection } from '@/components/panel-section'
import { SessionPoster } from '@/components/tabs/library-tab'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldContent, FieldLabel } from '@/components/ui/field'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { useVideorcAccount } from '@/hooks/use-account'
import { useStudioCore } from '@/hooks/use-studio'
import { cloudAiReadiness } from '@/lib/ai-readiness'
import {
  activeAiWorkflowStatus,
  aiRunButtonAction,
  latestAiProblemArtifact
} from '@/lib/ai-workflow-status'
import type {
  AiArtifact,
  AiCapabilities,
  ClipSuggestResult,
  SessionWithDetails
} from '@/lib/backend'
import {
  artifactChapters,
  artifactField,
  artifactObjects,
  artifactText,
  dayLabel,
  latestArtifact,
  latestArtifactAnyStatus,
  objectField
} from '@/lib/format'
import { VIDEORC_PREMIUM_URL } from '@/lib/premium-upgrade'
import {
  PUBLISH_PACK_CONTENTS,
  PUBLISH_PIPELINE,
  composeYouTubeDescription
} from '@/lib/publish-pipeline'

export function AiTab({
  selectedSessionId,
  setSelectedSessionId
}: {
  selectedSessionId: string | null
  setSelectedSessionId: (id: string | null) => void
}): ReactElement {
  const {
    sessions,
    sessionDetails,
    sessionDetailsLoading,
    sessionDetailError,
    loadSessionDetails,
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
  } = useStudioCore()
  const cloudAi = cloudAiReadiness({
    account,
    capabilities: aiCapabilities,
    error: aiReadinessError,
    loading: aiReadinessLoading,
    quota: aiQuota
  })

  useEffect(() => {
    if (!selectedSessionId && sessions.length > 0) {
      // D2: the newest COMPLETED recording is what you publish next.
      const completed = sessions.find((session) => session.status === 'completed')
      setSelectedSessionId((completed ?? sessions[0]).id)
    }
  }, [selectedSessionId, sessions, setSelectedSessionId])

  const selectedSummary = sessions.find((session) => session.id === selectedSessionId) ?? null
  const selectedSummaryId = selectedSummary?.id
  const selectedSummaryAiArtifactCount = selectedSummary?.aiArtifactCount
  const selectedDetails = selectedSessionId ? sessionDetails[selectedSessionId] : undefined
  const selectedDetailsError =
    selectedSessionId && sessionDetailError?.sessionId === selectedSessionId
      ? sessionDetailError.message
      : null
  const selected: SessionWithDetails | null =
    selectedSummary && selectedDetails ? { ...selectedSummary, ...selectedDetails } : null

  useEffect(() => {
    if (selectedSummaryId) {
      void loadSessionDetails(selectedSummaryId)
    }
  }, [loadSessionDetails, selectedSummaryAiArtifactCount, selectedSummaryId])

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
            {/* D2: rich rows instead of a mystery dropdown — you always see
                WHAT you're publishing. */}
            <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {sessions.map((session) => {
                const selectedRow = session.id === selectedSessionId
                const failed = session.status === 'failed'
                const readyKinds = new Set(session.readyAiArtifactKinds ?? [])
                return (
                  <button
                    key={session.id}
                    aria-pressed={selectedRow}
                    className={
                      'flex items-center gap-3 rounded-row border px-2.5 py-2 text-left transition-colors ' +
                      (selectedRow
                        ? 'border-ring bg-accent'
                        : 'border-transparent hover:bg-accent/60') +
                      (failed ? ' opacity-50' : '')
                    }
                    title={failed ? 'This session failed — nothing to publish.' : session.title}
                    type="button"
                    onClick={() => setSelectedSessionId(session.id)}
                  >
                    <SessionPoster session={session} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{session.title}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {dayLabel(session.startedAt)}
                        {session.sceneLabel
                          ? ` · ${session.sceneLabel}`
                          : ` · ${session.mode}`} · {session.status}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-0.5" title="Pipeline progress">
                      {PUBLISH_PIPELINE.map((step) => (
                        <span
                          key={step.kind}
                          className={
                            'size-1.5 rounded-full ' +
                            (readyKinds.has(step.kind) ? 'bg-success' : 'bg-muted-foreground/25')
                          }
                        />
                      ))}
                    </div>
                  </button>
                )
              })}
            </div>

            {selected ? <SessionActions session={selected} /> : null}
            {selectedDetailsError ? (
              <p className="text-xs text-destructive">{selectedDetailsError}</p>
            ) : !selected && selectedSessionId && sessionDetailsLoading.has(selectedSessionId) ? (
              <p className="text-xs text-muted-foreground">Loading session details…</p>
            ) : null}
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
                  ? 'Recordings stay local. With consent, the live-captions transcript uploads as text — or, without captions, the extracted audio — and the generated pack lands back in your library.'
                  : `${cloudAi.description} Transcripts from live captions always work locally without upload.`}
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
            <ArtifactView
              cloudReady={cloudAi.ready}
              running={aiRunningSessionId === selected.id}
              session={selected}
              workflow={aiCapabilities?.workflow ?? null}
              onRun={() => runAiWorkflow(selected.id)}
              onRunOutputs={(outputs, tone) => runAiWorkflow(selected.id, { outputs, tone })}
            />
          ) : selectedSessionId && sessionDetailsLoading.has(selectedSessionId) ? (
            <Empty className="border-0 py-6">
              <EmptyTitle>Loading session details…</EmptyTitle>
            </Empty>
          ) : selectedDetailsError ? (
            <Empty className="border-0 py-6">
              <EmptyTitle>Session details unavailable</EmptyTitle>
              <EmptyDescription>{selectedDetailsError}</EmptyDescription>
            </Empty>
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

  function SessionActions({ session }: { session: SessionWithDetails }): ReactElement {
    const { signIn } = useVideorcAccount()
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
    const runningStatus = aiRunning ? activeAiWorkflowStatus(session) : null
    // The primary button is the run OR the exact fix for whatever blocks the
    // run — never a half-run that only extracts audio and looks dead.
    const runAction = aiRunButtonAction({
      aiRunning,
      consent: aiConsent,
      hasFailedArtifacts,
      hasReviewableArtifacts,
      readinessState: cloudAi.state
    })

    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!canRunAi || aiRunning || runAction.kind === 'blocked'}
            title={runAction.kind === 'blocked' ? cloudAi.description : undefined}
            onClick={() => {
              switch (runAction.kind) {
                case 'run':
                  runAiWorkflow(session.id)
                  break
                case 'enable-consent':
                  setAiConsent(true)
                  toast.success('Cloud consent enabled.', {
                    description: 'Run it again — generation now uses your transcript or audio.'
                  })
                  break
                case 'sign-in':
                  signIn()
                  break
                case 'view-premium':
                  openExternalUrl(VIDEORC_PREMIUM_URL)
                  break
                case 'blocked':
                  break
              }
            }}
          >
            <Lightning data-icon="inline-start" weight="fill" />
            {runAction.label}
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

// Which server generation block regenerates each pipeline card. Transcript has
// no block of its own — every job returns it.
const CARD_OUTPUT_GROUP: Partial<Record<string, string[]>> = {
  'title-description': ['publish_pack'],
  summary: ['publish_pack'],
  chapters: ['publish_pack'],
  highlights: ['creator_intelligence']
}

const TONES = ['hooky', 'informative', 'casual'] as const
type Tone = (typeof TONES)[number]

function ArtifactView({
  session,
  running,
  cloudReady,
  workflow,
  onRun,
  onRunOutputs
}: {
  session: SessionWithDetails
  running: boolean
  cloudReady: boolean
  workflow: AiCapabilities['workflow'] | null
  onRun: () => void
  onRunOutputs: (outputs: string[], tone?: string) => void
}): ReactElement {
  const perKind = Boolean(workflow?.supportsOutputsFilter)
  const supportsTone = Boolean(workflow?.supportsTone)
  const [tone, setTone] = useState<Tone>('hooky')
  const titleDescription = latestArtifact(session, 'title-description')
  const audioExtract = latestArtifact(session, 'audio-extract')
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
  const titleDescriptionContent = (titleDescription?.content ?? {}) as Record<string, unknown>
  const titleVariants = Array.isArray(titleDescriptionContent.titleVariants)
    ? titleDescriptionContent.titleVariants.filter(
        (variant): variant is string => typeof variant === 'string' && variant.trim().length > 0
      )
    : []
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
          {titleVariants.length > 1 ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">More title options</span>
              {titleVariants
                .filter((variant) => variant !== title)
                .map((variant) => (
                  <button
                    key={variant}
                    className="flex items-center gap-2 rounded-row px-2 py-1 text-left text-sm hover:bg-muted/40"
                    title="Copy this title"
                    type="button"
                    onClick={() => void copyToClipboard(variant, 'Title')}
                  >
                    <CopySimple className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">{variant}</span>
                  </button>
                ))}
            </div>
          ) : null}
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </>
      ) : null,
    summary: summary ? (
      <p className="text-sm whitespace-pre-line">{artifactText(summary)}</p>
    ) : null,
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

  // A finished consent-off run leaves ONE pending-consent stub (the backend
  // writes it on the transcript); every cloud step is equally waiting, so the
  // whole pipeline shows that outcome instead of pretending it never ran.
  const sessionWaitingForConsent = session.aiArtifacts.some(
    (artifact) => artifact.status === 'pending-consent'
  )

  return (
    <ScrollArea className="h-[calc(100vh-15rem)] pr-3">
      <div className="flex flex-col gap-2">
        {problemArtifact ? <ArtifactProblem artifact={problemArtifact} /> : null}

        {/* What the last run PRODUCED, even when it was local-only: the audio
            extract is the run's tangible output — show it, name it, reveal it. */}
        {audioExtract ? (
          <div className="flex items-center gap-2 rounded-row border border-success/30 bg-success/5 px-3 py-2">
            <Waveform className="size-4 shrink-0 text-success" weight="duotone" />
            <span className="min-w-0 flex-1 truncate text-xs">
              Audio extracted
              {audioExtract.filePath ? (
                <span className="text-muted-foreground">
                  {' '}
                  — {audioExtract.filePath.split('/').at(-1)}
                </span>
              ) : null}
            </span>
            {audioExtract.filePath ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => void window.videorc?.revealSession?.(session.id)}
              >
                Reveal in Finder
              </Button>
            ) : null}
          </div>
        ) : null}

        {/* The five pipeline steps, in order — a card TEACHES until a run
            happens, then shows what that run produced for it: content,
            waiting-for-consent, or the failure. "Not run" after a finished
            run was the lie that made the pipeline feel dead. */}
        {PUBLISH_PIPELINE.map((step, index) => {
          const content = pipelineContent[step.kind]
          const stepArtifact = latestArtifactAnyStatus(session, step.kind)
          const waitingForConsent =
            !content && (stepArtifact?.status === 'pending-consent' || sessionWaitingForConsent)
          const stepFailed = !content && !waitingForConsent && stepArtifact?.status === 'failed'
          return (
            <div key={step.kind} className="flex flex-col gap-2 rounded-panel border p-3">
              <div className="flex items-center gap-2">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">
                  {index + 1}
                </span>
                <span className="flex-1 text-sm font-semibold">{step.name}</span>
                <Badge
                  variant={
                    content
                      ? 'success'
                      : waitingForConsent
                        ? 'warning'
                        : stepFailed
                          ? 'destructive'
                          : 'outline'
                  }
                >
                  {content
                    ? 'Ready'
                    : waitingForConsent
                      ? 'Waiting for consent'
                      : stepFailed
                        ? 'Failed'
                        : 'Not run'}
                </Badge>
              </div>
              {content ?? (
                <div className="flex flex-col gap-1.5">
                  {waitingForConsent ? (
                    // Never point at a switch the user cannot flip: when cloud
                    // AI is unreachable/blocked, step 0 explains WHY — send
                    // them to the reason, not to a disabled control.
                    <p className="text-xs text-muted-foreground">
                      {cloudReady
                        ? 'This step runs in the cloud. Flip “Allow cloud upload” in step 0, then run the pipeline again.'
                        : 'This step runs in the cloud, which is unavailable right now — the Cloud AI card (step 0) says why. Your audio is already extracted; once cloud AI is reachable, allow upload and run again.'}
                    </p>
                  ) : stepFailed ? (
                    <p className="text-xs text-muted-foreground">
                      The last run failed for this step — see the alert above, then run again.
                    </p>
                  ) : (
                    <>
                      <p className="text-xs text-muted-foreground">{step.valueProp}</p>
                      <p className="text-xs italic text-muted-foreground/60">{step.example}</p>
                    </>
                  )}
                  <Button
                    className="w-fit"
                    disabled={running}
                    size="xs"
                    title={
                      perKind && CARD_OUTPUT_GROUP[step.kind]
                        ? undefined
                        : 'Artifacts are generated together in one workflow run'
                    }
                    variant="outline"
                    onClick={() => {
                      const group = perKind ? CARD_OUTPUT_GROUP[step.kind] : undefined
                      if (group) {
                        onRunOutputs(group, supportsTone ? tone : undefined)
                      } else {
                        onRun()
                      }
                    }}
                  >
                    <Lightning data-icon="inline-start" weight="fill" />
                    {running
                      ? 'Running…'
                      : perKind && CARD_OUTPUT_GROUP[step.kind]
                        ? 'Generate'
                        : 'Run pipeline'}
                  </Button>
                </div>
              )}
              {content ? (
                <div className="flex flex-wrap items-center gap-1.5">
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
                  {perKind && CARD_OUTPUT_GROUP[step.kind] ? (
                    <>
                      {step.kind === 'title-description' && supportsTone ? (
                        <span className="flex items-center gap-0.5 rounded-row border p-0.5">
                          {TONES.map((option) => (
                            <Button
                              key={option}
                              size="xs"
                              variant={tone === option ? 'secondary' : 'ghost'}
                              onClick={() => setTone(option)}
                            >
                              {option}
                            </Button>
                          ))}
                        </span>
                      ) : null}
                      <Button
                        disabled={running}
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          onRunOutputs(
                            CARD_OUTPUT_GROUP[step.kind] ?? [],
                            supportsTone ? tone : undefined
                          )
                        }
                      >
                        <Lightning data-icon="inline-start" weight="fill" />
                        {running ? 'Running…' : 'Regenerate'}
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}

        <SocialPostsSection
          available={Boolean(workflow?.supportsSocialPosts)}
          running={running}
          session={session}
          onGenerate={() => onRunOutputs(['social_posts'], supportsTone ? tone : undefined)}
        />

        <ClipsSection highlightItems={highlightItems} session={session} />

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

// Announcement drafts, generated only on request (their own output kind).
function SocialPostsSection({
  session,
  available,
  running,
  onGenerate
}: {
  session: SessionWithDetails
  available: boolean
  running: boolean
  onGenerate: () => void
}): ReactElement | null {
  const socialPosts = latestArtifact(session, 'social-posts')
  const xPost = socialPosts ? artifactField(socialPosts, 'xPost') : ''
  const twitchTitle = socialPosts ? artifactField(socialPosts, 'twitchTitle') : ''
  const socialPostsContent = (socialPosts?.content ?? {}) as Record<string, unknown>
  const xThread = Array.isArray(socialPostsContent.xThread)
    ? socialPostsContent.xThread.filter(
        (post): post is string => typeof post === 'string' && post.trim().length > 0
      )
    : []
  if (!available && !socialPosts) {
    return null
  }
  const hasContent = Boolean(xPost || twitchTitle || xThread.length)

  return (
    <div className="flex flex-col gap-2 rounded-panel border p-3">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-sm font-semibold">Social posts</span>
        <Badge variant={hasContent ? 'success' : 'outline'}>
          {hasContent ? 'Ready' : 'Not run'}
        </Badge>
      </div>
      {hasContent ? (
        <div className="flex flex-col gap-2">
          {xPost ? <p className="text-sm whitespace-pre-line">{xPost}</p> : null}
          {xThread.length ? (
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
              {xThread.map((post) => (
                <li key={post}>{post}</li>
              ))}
            </ol>
          ) : null}
          {twitchTitle ? (
            <p className="text-xs text-muted-foreground">Twitch VOD title: {twitchTitle}</p>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Announcement drafts written from the video — an X post, a thread, and a Twitch VOD title.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {xPost ? (
          <Button size="xs" variant="outline" onClick={() => void copyToClipboard(xPost, 'X post')}>
            <CopySimple data-icon="inline-start" />
            Copy X post
          </Button>
        ) : null}
        {xThread.length ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => void copyToClipboard(xThread.join('\n\n'), 'X thread')}
          >
            <CopySimple data-icon="inline-start" />
            Copy X thread
          </Button>
        ) : null}
        {twitchTitle ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => void copyToClipboard(twitchTitle, 'Twitch title')}
          >
            <CopySimple data-icon="inline-start" />
            Copy Twitch title
          </Button>
        ) : null}
        {available ? (
          <Button disabled={running} size="xs" variant="outline" onClick={onGenerate}>
            <Lightning data-icon="inline-start" weight="fill" />
            {running ? 'Running…' : hasContent ? 'Regenerate' : 'Generate posts'}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function msToClock(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
}

// Clip-worthy moments: ranked locally from chat spikes + captions, plus any
// cloud highlights that carry timestamps. Every row exports a real file.
function ClipsSection({
  session,
  highlightItems
}: {
  session: SessionWithDetails
  highlightItems: Array<Record<string, unknown>>
}): ReactElement {
  const { suggestClips, exportClip } = useStudioCore()
  const [suggestion, setSuggestion] = useState<ClipSuggestResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [exportingKey, setExportingKey] = useState<string | null>(null)

  useEffect(() => {
    setSuggestion(null)
  }, [session.id])

  const timedHighlights = highlightItems.filter(
    (item): item is Record<string, unknown> & { startMs: number; endMs: number } =>
      typeof item.startMs === 'number' &&
      typeof item.endMs === 'number' &&
      item.endMs > item.startMs
  )
  const rows = [
    ...(suggestion?.moments ?? []).map((moment) => ({
      key: `chat-${moment.startMs}`,
      startMs: moment.startMs,
      endMs: moment.endMs,
      label: moment.reason,
      detail: moment.excerpt
    })),
    ...timedHighlights.map((item) => ({
      key: `highlight-${item.startMs}`,
      startMs: item.startMs,
      endMs: item.endMs,
      label: typeof item.title === 'string' ? item.title : 'Highlight',
      detail: typeof item.reason === 'string' ? item.reason : ''
    }))
  ]

  return (
    <div className="flex flex-col gap-2 rounded-panel border p-3">
      <div className="flex items-center gap-2">
        <Scissors className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
        <span className="flex-1 text-sm font-semibold">Clips</span>
        <Button
          disabled={loading}
          size="xs"
          variant="outline"
          onClick={() => {
            setLoading(true)
            void suggestClips(session.id)
              .then((result) => setSuggestion(result))
              .finally(() => setLoading(false))
          }}
        >
          {loading ? 'Ranking…' : 'Suggest clips from chat'}
        </Button>
      </div>
      {suggestion && suggestion.moments.length === 0 && timedHighlights.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {suggestion.chatMessageCount === 0
            ? 'No chat history for this session — clips are ranked from audience reaction. Generate Highlights instead.'
            : 'Chat stayed steady — no stand-out spike to clip. Generate Highlights for content-based moments.'}
        </p>
      ) : null}
      {!suggestion && rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          The strongest moments as exportable files — ranked from chat activity spikes, snapped to
          what you were saying.
        </p>
      ) : null}
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-3 rounded-row border px-3 py-2">
          <time className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
            {msToClock(row.startMs)}–{msToClock(row.endMs)}
          </time>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{row.label}</span>
            {row.detail ? (
              <span className="block truncate text-xs text-muted-foreground">{row.detail}</span>
            ) : null}
          </span>
          <Button
            disabled={exportingKey !== null}
            size="xs"
            variant="outline"
            onClick={() => {
              setExportingKey(row.key)
              void exportClip(session.id, row.startMs, row.endMs).finally(() =>
                setExportingKey(null)
              )
            }}
          >
            {exportingKey === row.key ? 'Exporting…' : 'Export clip'}
          </Button>
        </div>
      ))}
    </div>
  )
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

  // FX3: pending-consent is the EXPECTED outcome of a local-only run (the
  // audio extracted fine; cloud AI simply hasn't been consented to). A
  // warning here read as "your action failed" — keep warning tone for real
  // failures only.
  if (artifact.status === 'pending-consent') {
    return (
      <Alert>
        <Info weight="fill" />
        <AlertTitle>Audio extracted — cloud AI waiting for consent</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    )
  }

  return (
    <Alert variant="warning">
      <Warning weight="fill" />
      <AlertTitle>AI artifact failed</AlertTitle>
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
