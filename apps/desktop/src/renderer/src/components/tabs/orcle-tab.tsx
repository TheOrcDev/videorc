import { ChatIcon, ChevronDownIcon, LockIcon } from '@/components/icons'
import { useState, type ReactElement } from 'react'

import { CohostSettingsSection } from '@/components/cohost-settings-section'
import { OrcleReportCard } from '@/components/orcle-report-card'
import { PageHeader } from '@/components/page'
import { PanelSection } from '@/components/panel-section'
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldContent, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Kbd } from '@/components/ui/kbd'
import { Switch } from '@/components/ui/switch'
import { useVideorcAccount } from '@/hooks/use-account'
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
  ORCLE_TAB_DESCRIPTION,
  orcleLiveView,
  type OrcleLiveStatus
} from '@/lib/orcle-tab-view'
import { displayKeyGlyph } from '@/lib/platform'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { openVideorcWebLink } from '@/lib/videorc-web-links'
import { sessionIsLive } from '../../../../shared/capture-state'

/**
 * The Orcle tab (plan 119 S2): Videorc's AI tab, right under Studio. Phase 1
 * holds Orcle Live (one switch, consent, settings under Customize) and the
 * last stream's report (S3); Clean cut (phase 2) joins it here. The toolbar
 * names the page; nothing sits in its corner.
 *
 * `reportSessionId` is the Library's "Orcle report" ask: the report opens on
 * that session. Without it the report follows the last stream.
 */
export function OrcleTab({
  reportSessionId = null
}: {
  reportSessionId?: string | null
}): ReactElement {
  const [reportSession, setReportSession] = useState<string | null>(reportSessionId)
  return (
    <div className="flex flex-col" data-slot="orcle-tab">
      <PageHeader description={ORCLE_TAB_DESCRIPTION} title="Orcle" />
      <OrcleLiveSection />
      <OrcleReportCard sessionId={reportSession} onSessionChange={setReportSession} />
      <OrcleCustomize />
      <OrcleConsentDialog />
    </div>
  )
}

function OrcleLiveSection(): ReactElement {
  const { account, aiConsent, cohostGate, cohostSettings, runtimeInfo, setOrcleLive } =
    useStudioCore()
  const { cohostState } = useStudioChat()
  const { recording } = useStudioRecordingState()
  const { openCommentsWindow } = useStudioShell()
  const { signIn } = useVideorcAccount()
  const [pending, setPending] = useState(false)
  const view = orcleLiveView({
    settings: cohostSettings,
    signedIn: account?.status === 'signed-in',
    gate: cohostGate,
    consented: aiConsent,
    live: sessionIsLive(recording),
    state: cohostState
  })
  const unlockAction = view.unlock?.action ?? null
  const modKey = displayKeyGlyph('⌘', runtimeInfo?.platform)
  const shiftKey = displayKeyGlyph('⇧', runtimeInfo?.platform)

  // Without consent, on only opens the consent dialog: nothing is written
  // until the streamer accepts it there.
  const turn = (on: boolean): void => {
    setPending(true)
    void setOrcleLive(on)
      .catch((error: unknown) =>
        toast.error('Could not change Orcle Live', {
          description: error instanceof Error ? error.message : undefined
        })
      )
      .finally(() => setPending(false))
  }

  return (
    <PanelSection
      action={<Badge variant="outline">Alpha</Badge>}
      description="Orcle reads your chat and hears you while you stream. It never posts on its own."
      title="Orcle Live"
    >
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="orcle-live-switch">Orcle joins my streams</FieldLabel>
          <OrcleLiveStatusLine status={view.status} />
        </FieldContent>
        <Switch
          checked={view.checked}
          disabled={view.switchDisabled || pending}
          id="orcle-live-switch"
          onCheckedChange={turn}
        />
      </Field>

      {view.unlock ? (
        <Alert data-slot="orcle-live-unlock">
          <LockIcon />
          <AlertTitle className="font-normal text-muted-foreground">
            {view.unlock.reason}
          </AlertTitle>
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
      ) : null}

      {view.streamManager && runtimeInfo?.commentsWindowEnabled !== false ? (
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

      <ul aria-label="What Orcle Live does" className="grid gap-x-6 gap-y-3 lg:grid-cols-3">
        {ORCLE_LIVE_POWERS.map((power) => (
          <li key={power.title} className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">{power.title}</span>
            <span className="text-xs text-muted-foreground">{power.description}</span>
          </li>
        ))}
      </ul>
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

/** Every Orcle setting, collapsed until asked for (plan 119 decision 4). */
function OrcleCustomize(): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible
      className="border-b border-border"
      data-slot="orcle-customize"
      open={open}
      onOpenChange={setOpen}
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-gutter py-3 text-left text-[13px] font-semibold text-foreground hover:bg-accent">
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        <span className="flex-1">Customize</span>
        <span className="truncate text-xs font-normal text-muted-foreground">
          Cloud AI, listening, replies and rules
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <CloudAiSection />
        <CohostSettingsSection />
      </CollapsibleContent>
    </Collapsible>
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
    <PanelSection>
      <FieldGroup variant="grouped">
        <Field>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <FieldLabel htmlFor="orcle-cloud-ai">Cloud AI</FieldLabel>
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
 * The consent Orcle Live asks for when it is turned on without it. Accepting
 * grants cloud-AI consent, then makes the one settings save; declining
 * changes nothing. The safe choice has the focus.
 */
function OrcleConsentDialog(): ReactElement {
  const { orcleConsentRequested, answerOrcleConsent } = useStudioCore()
  const answer = (accepted: boolean): void => {
    void answerOrcleConsent(accepted).catch((error: unknown) =>
      toast.error('Could not turn on Orcle Live', {
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
          <DialogTitle>Turn on Orcle Live?</DialogTitle>
          <DialogDescription>
            Orcle uses Videorc&apos;s cloud AI while you&apos;re live.
          </DialogDescription>
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
