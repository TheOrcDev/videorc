import { ChatIcon, ChevronRightIcon } from '@/components/icons'
import { useState, type ReactElement } from 'react'

import { CleanCutTab } from '@/components/clean-cut/clean-cut-tab'
import {
  CohostListenField,
  BuddyModerationSection,
  BuddyRepliesSection
} from '@/components/cohost-settings-section'
import { BuddyGreetingsSection } from '@/components/buddy-greetings-section'
import { BuddyLibrarySection } from '@/components/buddy-library-section'
import { BuddyPersonaSection } from '@/components/buddy-persona-section'
import { BuddyPetCreator } from '@/components/buddy-pet-creator'
import { BuddyPetSettings } from '@/components/buddy-pet-settings'
import { BuddyConsentDialog } from '@/components/buddy-consent-dialog'
import { BuddyEmblem } from '@/components/buddy-emblem'
import { BuddyLiveSwitch } from '@/components/cohost-status'
import { BuddyReportCard } from '@/components/buddy-report-card'
import { BuddyVoiceCommands } from '@/components/buddy-voice-commands'
import { ConfigGrid, CONFIG_GRID_PAIR, PageStack } from '@/components/page'
import { PageTabs } from '@/components/page-tabs'
import { LockAlert } from '@/components/lock-alert'
import { PanelSection } from '@/components/panel-section'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle
} from '@/components/ui/field'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { Switch } from '@/components/ui/switch'
import { TabsContent } from '@/components/ui/tabs'
import { BUDDY_POSTS_PROMISE, buddyDisplayName } from '@/lib/buddy-auto-chat-view'
import { useCleanCut } from '@/hooks/use-clean-cut'
import { BuddyLookClientProvider } from '@/hooks/use-buddy-look'
import {
  useStudioChat,
  useStudioCore,
  useStudioRecordingState,
  useStudioShell
} from '@/hooks/use-studio'
import {
  CLOUD_AI_KEEPS,
  CLOUD_AI_USES,
  BUDDY_CHAT_FREE_NOTE,
  BUDDY_LIVE_LOADING_REASON,
  BUDDY_LIVE_POWERS,
  buddyLiveView,
  type BuddyLiveStatus
} from '@/lib/buddy-tab-view'
import { shortcutAccelerator } from '@/lib/shortcuts'
import { toastUserError } from '@/lib/user-error'
import { cn } from '@/lib/utils'
import type { CleanCutTabRequest } from '@/lib/clean-cut-events'
import { BUDDY_TABS, type BuddyTabId } from '@/lib/buddy-tabs'
import { closeBuddyPetCreator, useBuddyPetCreatorOpen } from '@/lib/buddy-pet-creator-nav'
import { sessionIsLive } from '../../../../shared/capture-state'

/** The tab a deep link lands on, for a page rendered without the shell's tab. */
function initialTab(
  reportSessionId: string | null,
  cleanCutRequest: CleanCutTabRequest | null
): BuddyTabId {
  if (cleanCutRequest) return 'clean-cut'
  if (reportSessionId) return 'reports'
  return 'live'
}

/**
 * The Buddy tab (plan 150): Videorc's AI tab, right under Studio, built like
 * Settings. Five tabs in a segmented strip under the toolbar, each answering
 * one question: Live (is Buddy on), Chat (how it replies and moderates),
 * Voice (what you can say), Reports (what happened on your streams) and
 * Clean cut (edit your recordings). The strip never scrolls away: the shell
 * turns the pane body's scroll off, and only the region under the strip
 * scrolls. The selected tab lives in app-shell, so links open a named tab and
 * Buddy reopens on the one used last.
 *
 * `reportSessionId` is the Library's "Buddy report" ask: Reports opens on
 * that session. Without it the report follows the last stream.
 * `cleanCutRequest` is the Library's "Make a clean cut…" (select that
 * recording) or a Review ask (open that cut's review, inside Clean cut).
 */
export function BuddyTab({
  reportSessionId = null,
  cleanCutRequest = null,
  tab,
  onTabChange,
  onOpenLibrarySession
}: {
  reportSessionId?: string | null
  cleanCutRequest?: CleanCutTabRequest | null
  tab?: BuddyTabId
  onTabChange?: (tab: BuddyTabId) => void
  onOpenLibrarySession?: (sessionId: string) => void
}): ReactElement {
  // The shell owns the tab; a page rendered on its own (tests) keeps its own.
  const [ownTab, setOwnTab] = useState<BuddyTabId>(() =>
    initialTab(reportSessionId, cleanCutRequest)
  )
  const current = tab ?? ownTab
  const selectTab = (next: BuddyTabId): void => {
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
  const [appliedRequest, setAppliedRequest] = useState<number | null>(
    cleanCutRequest?.nonce ?? null
  )
  if (cleanCutRequest && cleanCutRequest.nonce !== appliedRequest) {
    setAppliedRequest(cleanCutRequest.nonce)
    setOwnTab('clean-cut')
  }
  const openLibrarySession = onOpenLibrarySession ?? (() => undefined)
  const creatorOpen = useBuddyPetCreatorOpen()

  return (
    <>
      <PageTabs
        label="Buddy sections"
        tabs={BUDDY_TABS}
        testId="buddy-tab"
        triggerAttribute="data-videorc-buddy-tab"
        value={current}
        onValueChange={selectTab}
      >
        <TabsContent className="flex flex-1 flex-col" value="live">
          {/* Profile (plan 174 D7, F-4): one status row leads, then My
                Buddies and the creation screen, then Buddy Live's details. */}
          {creatorOpen ? <BuddyPetCreator onClose={closeBuddyPetCreator} /> : null}
          {/* Plan 170: My Buddies, the look panel and the onboarding share
                one backend client and one look controller. */}
          <BuddyLookClientProvider>
            <PageStack className={creatorOpen ? 'hidden' : undefined}>
              <BuddyProfileStatus />
              <BuddyLibrarySection />
              <BuddyPersonaSection />
              <BuddyPetSettings />
              <ConfigGrid className={CONFIG_GRID_PAIR}>
                <BuddyLiveSection />
                <div className="flex flex-col">
                  <BuddyLivePowers onSelectTab={selectTab} />
                  <CloudAiSection />
                </div>
              </ConfigGrid>
            </PageStack>
          </BuddyLookClientProvider>
        </TabsContent>
        <TabsContent className="flex flex-1 flex-col" value="chat">
          <BuddyChatTab />
        </TabsContent>
        <TabsContent className="flex flex-1 flex-col" value="voice">
          <BuddyVoiceTab onOpenLive={() => selectTab('live')} />
        </TabsContent>
        <TabsContent className="flex flex-col" value="reports">
          <PageStack>
            <BuddyReportCard sessionId={reportSession} onSessionChange={setReportSession} />
          </PageStack>
        </TabsContent>
        <TabsContent className="flex flex-1 flex-col" value="clean-cut">
          <CleanCutTab
            client={cleanCut}
            request={cleanCutRequest}
            onOpenLibrarySession={openLibrarySession}
          />
        </TabsContent>
      </PageTabs>
      <BuddyTabConsentDialog />
    </>
  )
}

/**
 * Buddy Live's state as the provider holds it, shared by the Live tab and the
 * locked alert every other settings tab leads with (plan 150, D7).
 */
function useBuddyLive(): ReturnType<typeof buddyLiveView> {
  const { account, aiConsent, cohostGate, cohostSettings } = useStudioCore()
  const { cohostState } = useStudioChat()
  const { recording } = useStudioRecordingState()
  return buddyLiveView({
    settings: cohostSettings,
    signedIn: account?.status === 'signed-in',
    gate: cohostGate,
    consented: aiConsent,
    live: sessionIsLive(recording),
    state: cohostState
  })
}

/**
 * Why Buddy is locked, with its one action (sign in or Premium). Locked means
 * disabled with one reason (plan 150, D7): the tab's controls render disabled
 * under it, and nothing live-looking sits beside it.
 */
function BuddyUnlockAlert({
  testId = 'buddy-live-unlock',
  freeNote = null
}: {
  testId?: string
  /** What stays free under a Premium lock, after its reason (plan 174 F-19). */
  freeNote?: string | null
}): ReactElement | null {
  const view = useBuddyLive()
  if (!view.unlock) return null
  const premium = view.unlock.action?.kind === 'view-premium'
  const reason = premium && freeNote ? `${view.unlock.reason} ${freeNote}` : view.unlock.reason
  return <LockAlert action={view.unlock.action} data-testid={testId} reason={reason} />
}

/**
 * The Chat tab (plan 150): Greetings (plan 164 S-D5, free) and Replies
 * beside Moderation. When Buddy is locked, one alert above both columns says
 * why and every Premium field under it is disabled (D7), the same reason
 * Live shows; the greetings stay editable.
 */
function BuddyChatTab(): ReactElement {
  const locked = useBuddyLive().unlock !== null
  return (
    <>
      {locked ? (
        <div className="border-b border-border p-gutter" data-slot="buddy-tab-lock">
          <BuddyUnlockAlert freeNote={BUDDY_CHAT_FREE_NOTE} testId="buddy-tab-unlock" />
        </div>
      ) : null}
      <ConfigGrid className={CONFIG_GRID_PAIR}>
        <div className="flex flex-col">
          <BuddyGreetingsSection />
          <BuddyRepliesSection locked={locked} />
        </div>
        <BuddyModerationSection locked={locked} />
      </ConfigGrid>
    </>
  )
}

/** The Voice tab (plan 150): led by the same locked reason as Live and Chat. */
function BuddyVoiceTab({ onOpenLive }: { onOpenLive: () => void }): ReactElement {
  const locked = useBuddyLive().unlock !== null
  return (
    <BuddyVoiceCommands
      lead={locked ? <BuddyUnlockAlert testId="buddy-tab-unlock" /> : null}
      onOpenLive={onOpenLive}
    />
  )
}

/**
 * The Profile tab's one status row (plan 174 D7, F-4, G-2): Buddy's emblem
 * and name, Buddy Live's status in the one vocabulary (F-20) with its reason,
 * the Buddy Live switch (S3.14a), "Open Stream Manager" with its key, then
 * the one unlock action when the account is locked, and how to put the Buddy
 * on stream while it is not. The switch turns Buddy on and off and nothing
 * else: without cloud-AI consent it asks first, and listening stays its own
 * switch in the Buddy Live section below.
 */
function BuddyProfileStatus(): ReactElement {
  const { cohostSettings, overlayLayout, runtimeInfo, setBuddyLive } = useStudioCore()
  const { openCommentsWindow } = useStudioShell()
  const view = useBuddyLive()
  const buddyName = buddyDisplayName(cohostSettings?.persona.name)
  const turnBuddyLive = (on: boolean): void => {
    void setBuddyLive(on).catch((error: unknown) =>
      toastUserError(error, { action: on ? 'turn on' : 'turn off', object: 'Buddy Live' })
    )
  }

  return (
    <div
      className="flex flex-col gap-3 border-b border-border p-gutter"
      data-slot="buddy-profile-status"
    >
      <div className="flex flex-wrap items-center gap-3" data-slot="buddy-live-status-block">
        <BuddyEmblem size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className="truncate text-sm font-medium text-foreground"
            data-slot="buddy-profile-name"
          >
            {buddyName}
          </span>
          <BuddyLiveStatusLine status={view.status} />
        </div>
        <BuddyLiveSwitch
          checked={view.checked}
          disabledReason={
            view.switchDisabled ? (view.unlock?.reason ?? BUDDY_LIVE_LOADING_REASON) : null
          }
          size="default"
          onCheckedChange={turnBuddyLive}
        />
        {runtimeInfo?.commentsWindowEnabled !== false ? (
          <Button
            className="shrink-0"
            type="button"
            variant="outline"
            onClick={() => void openCommentsWindow()}
          >
            <ChatIcon data-icon="inline-start" />
            Open Stream Manager
            <ShortcutKeys
              accelerator={shortcutAccelerator('comments-window')}
              className="ml-0.5"
              platform={runtimeInfo?.platform}
            />
          </Button>
        ) : null}
      </div>
      <BuddyUnlockAlert />
      {!overlayLayout.buddy.showOnStream ? (
        // Plan 174 G-2: nothing else says how a Buddy gets on stream.
        <Alert data-testid="buddy-on-stream-note" variant="quiet">
          <AlertTitle>
            {buddyName} isn&apos;t on stream yet. In Stream Manager, turn on &ldquo;{buddyName} on
            stream&rdquo; to show it.
          </AlertTitle>
        </Alert>
      ) : null}
    </div>
  )
}

/**
 * Buddy Live's details (plan 150): what it does and whether Buddy hears you.
 * Its status and switch lead the tab (`BuddyProfileStatus`).
 */
function BuddyLiveSection(): ReactElement {
  const view = useBuddyLive()
  return (
    <PanelSection
      action={<Badge variant="outline">Alpha</Badge>}
      description={`Buddy reads your chat while you stream. ${BUDDY_POSTS_PROMISE}`}
      title="Buddy Live"
    >
      <CohostListenField locked={view.unlock !== null} />
    </PanelSection>
  )
}

/**
 * "What Buddy does" (plan 150, D5): the powers as rows, each with a way to the
 * tab that holds its settings. Navigation, not a pitch.
 */
function BuddyLivePowers({
  onSelectTab
}: {
  onSelectTab: (tab: BuddyTabId) => void
}): ReactElement {
  return (
    <PanelSection title="What Buddy does">
      <FieldGroup aria-label="What Buddy does" role="list" variant="grouped">
        {BUDDY_LIVE_POWERS.map((power) => {
          const label = BUDDY_TABS.find((entry) => entry.id === power.tab)?.label ?? power.tab
          return (
            <Field
              key={power.title}
              data-power-tab={power.tab}
              orientation="horizontal"
              role="listitem"
            >
              <FieldContent>
                <FieldTitle>{power.title}</FieldTitle>
                <FieldDescription>{power.description}</FieldDescription>
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

const STATUS_TONE: Record<BuddyLiveStatus['kind'], string> = {
  off: 'tone-neutral',
  on: 'tone-neutral',
  live: 'tone-success',
  attention: 'tone-warning'
}

/** The glass dot carries the tone; the words stay monochrome. */
function BuddyLiveStatusLine({ status }: { status: BuddyLiveStatus }): ReactElement {
  return (
    <p
      className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground"
      data-slot="buddy-live-status"
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
      description="What Buddy and Clean cut send to Videorc's cloud, and what is kept."
      title="Cloud AI"
    >
      <FieldGroup variant="grouped">
        <Field>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <FieldLabel htmlFor="buddy-cloud-ai">Allow cloud AI</FieldLabel>
              <ul className="flex list-disc flex-col gap-0.5 pl-4 text-xs text-muted-foreground">
                {CLOUD_AI_USES.map((use) => (
                  <li key={use}>{use}</li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">{CLOUD_AI_KEEPS}</p>
            </div>
            <Switch checked={aiConsent} id="buddy-cloud-ai" onCheckedChange={setAiConsent} />
          </div>
        </Field>
      </FieldGroup>
    </PanelSection>
  )
}

/**
 * The consent Buddy Live asks for when it is turned on without it: the one
 * dialog the Stream Manager opens too (`components/buddy-consent-dialog.tsx`).
 * Accepting grants cloud-AI consent, then makes the one settings save;
 * declining changes nothing.
 */
function BuddyTabConsentDialog(): ReactElement {
  const { buddyConsentRequested, answerBuddyConsent } = useStudioCore()
  const answer = (accepted: boolean): void => {
    void answerBuddyConsent(accepted).catch((error: unknown) =>
      toastUserError(
        error,
        { action: 'turn on', object: 'Buddy Live' },
        {
          id: 'buddy-live-consent',
          ...(accepted ? { action: { label: 'Retry', onClick: () => answer(true) } } : {})
        }
      )
    )
  }
  return <BuddyConsentDialog open={buddyConsentRequested} onAnswer={answer} />
}
