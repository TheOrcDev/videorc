import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import { LockAlert } from '@/components/lock-alert'
import { PanelSection } from '@/components/panel-section'
import { Button } from '@/components/ui/button'
import { FieldGroup, SettingsRow } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { useStudioDiagnostics } from '@/hooks/use-studio'
import type { StreamReportEmailState, StreamReportSendResult } from '@/lib/backend'
import { toastUserError } from '@/lib/user-error'
import { beginVideorcSignIn } from '@/lib/videorc-web-links'

// Livestream → After the stream (plan 237 D7): one switch, "Email me a report
// after each stream", and "Send the last one". The choice lives on the
// videorc.com account, so the email's unsubscribe link and this switch are
// the same setting. The backend sends the report a minute after a live stream
// of 5 minutes or more ends (crates/videorc-backend/src/stream_report_email.rs).

export const STREAM_REPORT_SECTION_DESCRIPTION =
  'A minute after a live stream ends, Videorc emails you how many people watched at the peak and on average, and how many chatted, platform by platform. Numbers only: never chat messages or viewer names. Streams of 5 minutes or more.'

export const STREAM_REPORT_SIGNED_OUT_REASON = "Stream reports go to your Videorc account's email."

/** The switch row's description: where the email goes, or why it can't. */
export function streamReportEmailDescription(state: StreamReportEmailState | null): string {
  if (!state) return "To your Videorc account's email."
  if (state.envDisabled) return 'Turned off when Videorc started. Reopen Videorc to change it.'
  if (!state.signedIn) return "To your Videorc account's email."
  if (state.enabled === null) return "Couldn't reach videorc.com. Try again later."
  return state.email ? `To ${state.email}.` : "To your Videorc account's email."
}

export type StreamReportSendView = 'idle' | 'sending' | StreamReportSendResult

/** The "Send the last one" row's description: what the button does, or did. */
export function streamReportSendLine(view: StreamReportSendView): string {
  if (view === 'idle') return "Emails your latest live stream's report now."
  if (view === 'sending') return 'Sending…'
  switch (view.status) {
    case 'sent':
      return view.email ? `Sent to ${view.email}.` : 'Sent.'
    case 'already-sent':
      return 'Already sent.'
    case 'disabled':
      return 'Stream reports are off for your account.'
    case 'no-stream':
      return 'No live stream yet.'
    case 'signed-out':
      return 'Sign in to Videorc first.'
    case 'rate-limited':
      return "That's 10 reports today. Try again tomorrow."
    case 'unavailable':
      return "videorc.com can't send stream reports right now."
    case 'failed':
      return "Couldn't send it. Try again."
  }
}

export function StreamReportEmailSectionView({
  state,
  send,
  onEnabledChange,
  onSendLast
}: {
  /** `null` until the backend answers. */
  state: StreamReportEmailState | null
  send: StreamReportSendView
  onEnabledChange: (enabled: boolean) => void
  onSendLast: () => void
}): ReactElement {
  const signedOut = state !== null && !state.signedIn
  const usable = state !== null && state.signedIn && !state.envDisabled
  return (
    <PanelSection description={STREAM_REPORT_SECTION_DESCRIPTION} title="After the stream">
      {signedOut ? (
        <LockAlert
          action={{ kind: 'sign-in', onClick: beginVideorcSignIn }}
          data-testid="stream-report-email-lock"
          reason={STREAM_REPORT_SIGNED_OUT_REASON}
        />
      ) : null}
      <FieldGroup variant="grouped">
        <SettingsRow
          data-testid="stream-report-email"
          description={streamReportEmailDescription(state)}
          label="Email me a report after each stream"
        >
          <Switch
            checked={state?.enabled === true}
            disabled={!usable || state?.enabled === null}
            id="stream-report-email"
            onCheckedChange={onEnabledChange}
          />
        </SettingsRow>
        <SettingsRow
          data-testid="stream-report-send-last"
          description={streamReportSendLine(send)}
          label="Send the last one"
        >
          <Button
            disabled={!usable || send === 'sending'}
            size="xs"
            type="button"
            variant="outline"
            onClick={onSendLast}
          >
            {send === 'sending' ? 'Sending…' : 'Send'}
          </Button>
        </SettingsRow>
      </FieldGroup>
    </PanelSection>
  )
}

export function StreamReportEmailSection(): ReactElement {
  const { client } = useStudioDiagnostics()
  const [state, setState] = useState<StreamReportEmailState | null>(null)
  const [send, setSend] = useState<StreamReportSendView>('idle')
  // Only the latest answer may land: an older read must not undo a newer flip.
  const latest = useRef(0)

  const refresh = useCallback(() => {
    if (!client) return
    const request = ++latest.current
    void client
      .requestTyped('streamReport.email.get')
      .then((next) => {
        if (request === latest.current) setState(next)
      })
      .catch(() => undefined)
  }, [client])

  useEffect(() => {
    if (!client) return
    refresh()
    // Signing in or out changes where the report goes.
    const off = client.on('account.changed', () => {
      setSend('idle')
      refresh()
    })
    return off
  }, [client, refresh])

  const onEnabledChange = useCallback(
    (enabled: boolean) => {
      if (!client) return
      const request = ++latest.current
      setState((current) => current && { ...current, enabled })
      client
        .requestTyped('streamReport.email.set', { enabled })
        .then((next) => {
          if (request === latest.current) setState(next)
        })
        .catch((error: unknown) => {
          if (request !== latest.current) return
          toastUserError(error, { action: 'save', object: 'the stream report setting' })
          refresh()
        })
    },
    [client, refresh]
  )

  const onSendLast = useCallback(() => {
    if (!client) return
    setSend('sending')
    client
      .requestTyped('streamReport.email.sendLast')
      .then((result) => {
        setSend(result)
        // "Turned off" means the account's choice changed somewhere else.
        if (result.status === 'disabled' || result.status === 'signed-out') refresh()
      })
      .catch(() => setSend({ status: 'failed' }))
  }, [client, refresh])

  return (
    <StreamReportEmailSectionView
      send={send}
      state={state}
      onEnabledChange={onEnabledChange}
      onSendLast={onSendLast}
    />
  )
}
