import { ChatIcon, ChevronRightIcon, LockIcon } from '@/components/icons'
import { lazy, Suspense, useState, type ReactElement } from 'react'

import {
  CleanCutCard,
  type CleanCutFocus,
  type CleanCutReviewTarget
} from '@/components/clean-cut/clean-cut-card'
import {
  CohostListenField,
  OrcleModerationSection,
  OrcleRepliesSection
} from '@/components/cohost-settings-section'
import { GolemGreetingsSection } from '@/components/golem-greetings-section'
import { GolemPersonaSection } from '@/components/golem-persona-section'
import { GolemPetCreator } from '@/components/golem-pet-creator'
import { GolemPetSettings } from '@/components/golem-pet-settings'
import { OrcleEmblem } from '@/components/orcle-emblem'
import { OrcleReportCard } from '@/components/orcle-report-card'
import { OrcleVoiceCommands } from '@/components/orcle-voice-commands'
import { ConfigGrid, CONFIG_GRID_PAIR, PageStack } from '@/components/page'
import { PanelSection } from '@/components/panel-section'
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle
} from '@/components/ui/field'
import { Kbd } from '@/components/ui/kbd'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { GOLEM_POSTS_PROMISE } from '@/lib/golem-auto-chat-view'
import { useVideorcAccount } from '@/hooks/use-account'
import { useCleanCut } from '@/hooks/use-clean-cut'
import {
  useStudioChat,
  useStudioCore,
  useStudioRecordingState,
  useStudioShell
} from '@/hooks/use-studio'
import {
  CLOUD_AI_KEEPS,
  CLOUD_AI_USES,
  ORCLE_LIVE_POWERS,
  orcleLiveView,
  type OrcleLiveStatus
} from '@/lib/orcle-tab-view'
import { displayKeyGlyph } from '@/lib/platform'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { openVideorcWebLink } from '@/lib/videorc-web-links'
import type { CleanCutTabRequest } from '@/lib/clean-cut-events'
import { ORCLE_TABS, isOrcleTabId, type OrcleTabId } from '@/lib/orcle-tabs'
import { closeGolemPetCreator, useGolemPetCreatorOpen } from '@/lib/golem-pet-creator-nav'
import { sessionIsLive } from '../../../../shared/capture-state'

// The review is the heaviest part of Clean cut (player, transcript editor):
// it loads the first time a cut is reviewed.
const CleanCutReview = lazy(async () => ({
  default: (await import('@/components/clean-cut/clean-cut-review')).CleanCutReview
}))

function reviewTargetOf(request: CleanCutTabRequest | null): CleanCutReviewTarget | null {
  if (!request?.review) return null
  return {
    sessionId: request.sessionId,
    mode: request.mode ?? 'clean',
    jobId: request.jobId ?? null
  }
}

/** The tab a deep link lands on, for a page rendered without the shell's tab. */
function initialTab(
  reportSessionId: string | null,
  cleanCutRequest: CleanCutTabRequest | null
): OrcleTabId {
  if (cleanCutRequest) return 'clean-cut'
  if (reportSessionId) return 'reports'
  return 'live'
}

/**
 * The Golem tab (plan 150): Videorc's AI tab, right under Studio, built like
 * Settings. Five tabs in a segmented strip under the toolbar, each answering
 * one question: Live (is Golem on), Chat (how it replies and moderates),
 * Voice (what you can say), Reports (what happened on your streams) and
 * Clean cut (edit your recordings). The strip never scrolls away: the shell
 * turns the pane body's scroll off, and only the region under the strip
 * scrolls. The selected tab lives in app-shell, so links open a named tab and
 * Golem reopens on the one used last.
 *
 * `reportSessionId` is the Library's "Golem report" ask: Reports opens on
 * that session. Without it the report follows the last stream.
 * `cleanCutRequest` is the Library's "Clean cut" (select that recording) or
 * the ready toast's Review (open that cut's review, inside Clean cut).
 */
export function OrcleTab({
  reportSessionId = null,
  cleanCutRequest = null,
  tab,
  onTabChange,
  onOpenLibrarySession
}: {
  reportSessionId?: string | null
  cleanCutRequest?: CleanCutTabRequest | null
  tab?: OrcleTabId
  onTabChange?: (tab: OrcleTabId) => void
  onOpenLibrarySession?: (sessionId: string) => void
}): ReactElement {
  // The shell owns the tab; a page rendered on its own (tests) keeps its own.
  const [ownTab, setOwnTab] = useState<OrcleTabId>(() =>
    initialTab(reportSessionId, cleanCutRequest)
  )
  const current = tab ?? ownTab
  const selectTab = (next: OrcleTabId): void => {
    if (onTabChange) onTabChange(next)
    else setOwnTab(next)
  }
  const [reportSession, setReportSession] = useState<string | null>(reportSessionId)
  // A new report ask while the page is open opens it, like a fresh visit.
  const [appliedReport, setAppliedReport] = useState<string | null>(reportSessionId)
  if (reportSessionId !== appliedReport) {
    setAppliedReport(reportSessionId)
    if (reportSessionId) {
      setReportSession(reportSessionId)
      setOwnTab('reports')
    }
  }
  const cleanCut = useCleanCut()
  const [review, setReview] = useState<CleanCutReviewTarget | null>(() =>
    reviewTargetOf(cleanCutRequest)
  )
  const [appliedRequest, setAppliedRequest] = useState<number | null>(
    cleanCutRequest?.nonce ?? null
  )
  if (cleanCutRequest && cleanCutRequest.nonce !== appliedRequest) {
    setAppliedRequest(cleanCutRequest.nonce)
    setReview(reviewTargetOf(cleanCutRequest))
    setOwnTab('clean-cut')
  }
  const focus: CleanCutFocus | null =
    cleanCutRequest && !cleanCutRequest.review
      ? { sessionId: cleanCutRequest.sessionId, nonce: cleanCutRequest.nonce }
      : null
  const openLibrarySession = onOpenLibrarySession ?? (() => undefined)
  const creatorOpen = useGolemPetCreatorOpen()

  return (
    <>
      <Tabs
        className="min-h-0 flex-1 gap-0"
        data-testid="orcle-tab"
        value={current}
        onValueChange={(value) => {
          if (isOrcleTabId(value)) selectTab(value)
        }}
      >
        {/* Settings' strip, verbatim; the toolbar carries only the title. */}
        <div className="shrink-0 border-b border-border px-gutter py-2">
          <TabsList aria-label="Golem sections">
            {ORCLE_TABS.map(({ id, label }) => (
              <TabsTrigger key={id} data-videorc-orcle-tab={id} value={id}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {/* Keyed by tab, so every tab change starts the new tab at the top. */}
        <div
          key={current}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
          data-slot="orcle-scroll"
        >
          <TabsContent className="flex flex-1 flex-col" value="live">
            {/* Plan 164 S-A4: the creation screen leads; the old Live switch
                and Cloud AI stay at the bottom until Stream Manager takes the
                switch (S-D6). */}
            {creatorOpen ? <GolemPetCreator onClose={closeGolemPetCreator} /> : null}
            <PageStack className={creatorOpen ? 'hidden' : undefined}>
              <GolemPersonaSection />
              <GolemPetSettings />
              <ConfigGrid className={CONFIG_GRID_PAIR}>
                <OrcleLiveSection />
                <div className="flex flex-col">
                  <OrcleLivePowers onSelectTab={selectTab} />
                  <CloudAiSection />
                </div>
              </ConfigGrid>
            </PageStack>
          </TabsContent>
          <TabsContent className="flex flex-1 flex-col" value="chat">
            <OrcleChatTab />
          </TabsContent>
          <TabsContent className="flex flex-1 flex-col" value="voice">
            <OrcleVoiceTab onOpenLive={() => selectTab('live')} />
          </TabsContent>
          <TabsContent className="flex flex-col" value="reports">
            <PageStack>
              <OrcleReportCard sessionId={reportSession} onSessionChange={setReportSession} />
            </PageStack>
          </TabsContent>
          <TabsContent className="flex flex-1 flex-col" value="clean-cut">
            {review ? (
              <Suspense fallback={<CleanCutReviewFallback />}>
                <CleanCutReview
                  client={cleanCut}
                  target={review}
                  onClose={() => setReview(null)}
                  onOpenLibrarySession={openLibrarySession}
                />
              </Suspense>
            ) : (
              <ConfigGrid className={CONFIG_GRID_PAIR}>
                <CleanCutCard
                  client={cleanCut}
                  focus={focus}
                  onOpenLibrarySession={openLibrarySession}
                  onReview={setReview}
                />
              </ConfigGrid>
            )}
          </TabsContent>
        </div>
      </Tabs>
      <OrcleConsentDialog />
    </>
  )
}

function CleanCutReviewFallback(): ReactElement {
  return (
    <div
      aria-live="polite"
      className="flex min-h-40 items-center justify-center text-xs text-muted-foreground"
      role="status"
    >
      Loading the review…
    </div>
  )
}

/**
 * Golem Live's state as the provider holds it, shared by the Live tab and the
 * locked alert every other settings tab leads with (plan 150, D7).
 */
function useOrcleLive(): ReturnType<typeof orcleLiveView> {
  const { account, aiConsent, cohostGate, cohostSettings } = useStudioCore()
  const { cohostState } = useStudioChat()
  const { recording } = useStudioRecordingState()
  return orcleLiveView({
    settings: cohostSettings,
    signedIn: account?.status === 'signed-in',
    gate: cohostGate,
    consented: aiConsent,
    live: sessionIsLive(recording),
    state: cohostState
  })
}

/**
 * Why Golem is locked, with its one action (sign in or Premium). Locked means
 * disabled with one reason (plan 150, D7): the tab's controls render disabled
 * under it, and nothing live-looking sits beside it.
 */
function OrcleUnlockAlert({
  testId = 'orcle-live-unlock'
}: {
  testId?: string
}): ReactElement | null {
  const { signIn } = useVideorcAccount()
  const view = useOrcleLive()
  if (!view.unlock) return null
  const unlockAction = view.unlock.action ?? null
  return (
    <Alert data-testid={testId}>
      <LockIcon />
      <AlertTitle className="font-normal text-muted-foreground">{view.unlock.reason}</AlertTitle>
      {unlockAction ? (
        <AlertAction>
          <Button
            size="xs"
            type="button"
            variant="outline"
            onClick={() =>
              unlockAction.kind === 'sign-in' ? signIn() : openVideorcWebLink(unlockAction.url)
            }
          >
            {unlockAction.kind === 'sign-in' ? 'Sign in' : 'View Premium'}
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  )
}

/**
 * The Chat tab (plan 150): Greetings (plan 164 S-D5, free) and Replies
 * beside Moderation. When Golem is locked, one alert above both columns says
 * why and every Premium field under it is disabled (D7), the same reason
 * Live shows; the greetings stay editable.
 */
function OrcleChatTab(): ReactElement {
  const locked = useOrcleLive().unlock !== null
  return (
    <>
      {locked ? (
        <div className="border-b border-border p-gutter" data-slot="orcle-tab-lock">
          <OrcleUnlockAlert testId="orcle-tab-unlock" />
        </div>
      ) : null}
      <ConfigGrid className={CONFIG_GRID_PAIR}>
        <div className="flex flex-col">
          <GolemGreetingsSection />
          <OrcleRepliesSection locked={locked} />
        </div>
        <OrcleModerationSection locked={locked} />
      </ConfigGrid>
    </>
  )
}

/** The Voice tab (plan 150): led by the same locked reason as Live and Chat. */
function OrcleVoiceTab({ onOpenLive }: { onOpenLive: () => void }): ReactElement {
  const locked = useOrcleLive().unlock !== null
  return (
    <OrcleVoiceCommands
      lead={locked ? <OrcleUnlockAlert testId="orcle-tab-unlock" /> : null}
      onOpenLive={onOpenLive}
    />
  )
}

/**
 * The Live tab's left column (plan 150): Golem's emblem beside its status,
 * then why it is locked, the Stream Manager, and whether Golem hears you.
 * The switch moved to Stream Manager (plan 164 S-D6): the chat mode there
 * is what turns the Golem on, so this column points at it.
 */
function OrcleLiveSection(): ReactElement {
  const { cohostSettings, runtimeInfo } = useStudioCore()
  const { openCommentsWindow } = useStudioShell()
  const view = useOrcleLive()
  const golemName = cohostSettings?.persona.name ?? 'Golem'
  const modKey = displayKeyGlyph('⌘', runtimeInfo?.platform)
  const shiftKey = displayKeyGlyph('⇧', runtimeInfo?.platform)

  return (
    <PanelSection
      action={<Badge variant="outline">Alpha</Badge>}
      description={`Your Golem reads your chat and hears you while you stream. ${GOLEM_POSTS_PROMISE}`}
      title="Joins my streams"
    >
      <div className="flex items-center gap-3" data-slot="orcle-live-status-block">
        <OrcleEmblem size="lg" />
        <Field className="min-w-0 flex-1" orientation="horizontal">
          <FieldContent>
            <FieldTitle>{golemName} joins my streams</FieldTitle>
            <OrcleLiveStatusLine status={view.status} />
            <FieldDescription className="text-xs" data-testid="orcle-live-pointer">
              Turn it on in Stream Manager: the Golem pane&apos;s chat mode, Suggest or Auto.
            </FieldDescription>
          </FieldContent>
        </Field>
      </div>

      <OrcleUnlockAlert />

      {runtimeInfo?.commentsWindowEnabled !== false ? (
        <Button
          className="w-fit"
          type="button"
          variant="outline"
          onClick={() => void openCommentsWindow()}
        >
          <ChatIcon data-icon="inline-start" />
          Open Stream Manager
          <Kbd className="ml-0.5">
            {shiftKey}
            {modKey}J
          </Kbd>
        </Button>
      ) : null}

      <CohostListenField locked={view.unlock !== null} />
    </PanelSection>
  )
}

/**
 * "What Golem does" (plan 150, D5): the powers as rows, each with a way to the
 * tab that holds its settings. Navigation, not a pitch.
 */
function OrcleLivePowers({
  onSelectTab
}: {
  onSelectTab: (tab: OrcleTabId) => void
}): ReactElement {
  return (
    <PanelSection title="What Golem does">
      <FieldGroup aria-label="What Golem Live does" role="list" variant="grouped">
        {ORCLE_LIVE_POWERS.map((power) => {
          const label = ORCLE_TABS.find((entry) => entry.id === power.tab)?.label ?? power.tab
          return (
            <Field
              key={power.title}
              data-power-tab={power.tab}
              orientation="horizontal"
              role="listitem"
            >
              <FieldContent>
                <FieldTitle>{power.title}</FieldTitle>
                <FieldDescription className="text-xs">{power.description}</FieldDescription>
              </FieldContent>
              <Button
                aria-label={`Open ${label} settings for ${power.title}`}
                className="shrink-0"
                size="xs"
                type="button"
                variant="ghost"
                onClick={() => onSelectTab(power.tab)}
              >
                {label}
                <ChevronRightIcon data-icon="inline-end" />
              </Button>
            </Field>
          )
        })}
      </FieldGroup>
    </PanelSection>
  )
}

const STATUS_TONE: Record<OrcleLiveStatus['kind'], string> = {
  off: 'tone-neutral',
  on: 'tone-neutral',
  live: 'tone-success',
  attention: 'tone-warning'
}

/** The glass dot carries the tone; the words stay monochrome. */
function OrcleLiveStatusLine({ status }: { status: OrcleLiveStatus }): ReactElement {
  return (
    <p
      className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground"
      data-slot="orcle-live-status"
      data-status={status.kind}
      title={status.detail ?? undefined}
    >
      <span
        aria-hidden
        className={cn('size-1.5 shrink-0 rounded-full glass-dot', STATUS_TONE[status.kind])}
      />
      <span className="font-medium text-foreground">{status.label}</span>
      {status.reason ? (
        <>
          <span aria-hidden>·</span>
          <span>{status.reason}</span>
        </>
      ) : null}
    </p>
  )
}

/**
 * Cloud AI: the single home of `aiConsent` (plan 119 decision 3), granted
 * here or through the switch's consent dialog and revoked only here. The copy
 * is the one list of uses the dialog shows too.
 */
function CloudAiSection(): ReactElement {
  const { aiConsent, setAiConsent } = useStudioCore()
  return (
    <PanelSection
      description="What Golem and Clean cut send to Videorc's cloud, and what is kept."
      title="Cloud AI"
    >
      <FieldGroup variant="grouped">
        <Field>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <FieldLabel htmlFor="orcle-cloud-ai">Allow cloud AI</FieldLabel>
              <ul className="flex list-disc flex-col gap-0.5 pl-4 text-xs text-muted-foreground">
                {CLOUD_AI_USES.map((use) => (
                  <li key={use}>{use}</li>
                ))}
              </ul>
              <p className="text-xs text-subtle">{CLOUD_AI_KEEPS}</p>
            </div>
            <Switch checked={aiConsent} id="orcle-cloud-ai" onCheckedChange={setAiConsent} />
          </div>
        </Field>
      </FieldGroup>
    </PanelSection>
  )
}

/**
 * The consent Golem Live asks for when it is turned on without it. Accepting
 * grants cloud-AI consent, then makes the one settings save; declining
 * changes nothing. The safe choice has the focus.
 */
function OrcleConsentDialog(): ReactElement {
  const { orcleConsentRequested, answerOrcleConsent } = useStudioCore()
  const answer = (accepted: boolean): void => {
    void answerOrcleConsent(accepted).catch((error: unknown) =>
      toast.error('Could not turn on Golem Live', {
        description: error instanceof Error ? error.message : undefined
      })
    )
  }
  return (
    <Dialog
      open={orcleConsentRequested}
      onOpenChange={(open) => {
        if (!open) answer(false)
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          {/* Golem's emblem leads, the way the Videorc logo leads
              permissions onboarding (plan 149). */}
          <div className="flex items-center gap-3">
            <OrcleEmblem size="lg" />
            <div className="flex flex-col gap-1">
              <DialogTitle>Turn on Golem Live?</DialogTitle>
              <DialogDescription>
                Golem uses Videorc&apos;s cloud AI while you&apos;re live.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-muted-foreground">
          {CLOUD_AI_USES.map((use) => (
            <li key={use}>{use}</li>
          ))}
        </ul>
        <p className="text-xs text-subtle">{CLOUD_AI_KEEPS}</p>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => answer(false)}>
            Not now
          </Button>
          <Button type="button" onClick={() => answer(true)}>
            Allow and turn on
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
