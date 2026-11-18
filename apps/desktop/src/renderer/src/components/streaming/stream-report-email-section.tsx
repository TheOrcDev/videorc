import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import { LockAlert } from '@/components/lock-alert'
import { PanelSection } from '@/components/panel-section'
import { Button } from '@/components/ui/button'
import { FieldGroup, SettingsRow } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { useStudioDiagnostics } from '@/hooks/use-studio'
import type { StreamReportEmailState, StreamReportSendResult } from '@/lib/backend'
import { toastUserError } from '@/lib/user-error'
import { beginVideorcSignIn, openVideorcWebLink, VIDEORC_WEB_LINKS } from '@/lib/videorc-web-links'

// Livestream → After the stream (plan 237 D7): one switch, "Email me a report
// after each stream", and "Send the last one". The choice lives on the
// videorc.com account, so the email's unsubscribe link and this switch are
// the same setting. The backend sends the report a minute after a live stream
// of 5 minutes or more ends (crates/videorc-backend/src/stream_report_email.rs).
// Plan 241 D7 adds "Save my streams on videorc.com": the same report, kept on
// videorc.com/live for 90 days. Its own switch, on the same account.

export const STREAM_REPORT_SECTION_DESCRIPTION =
  'A minute after a live stream ends, Videorc emails you how many people watched at the peak and on average, and how many chatted, platform by platform. Numbers only: never chat messages or viewer names. Streams of 5 minutes or more.'

export const STREAM_REPORT_SIGNED_OUT_REASON = "Stream reports go to your Videorc account's email."

/** The first read of the account's choices failed (QA F13). */
export const STREAM_REPORT_LOAD_FAILED = "Couldn't load these settings."

/**
 * QA F13: a failed first read retries itself after these waits (ms), then
 * stops; Try again starts the cycle over.
 */
export const STREAM_REPORT_LOAD_RETRY_MS: readonly number[] = [2_000, 5_000, 15_000]

/** The switch row's description: where the email goes, or why it can't. */
export function streamReportEmailDescription(
  state: StreamReportEmailState | null,
  loadFailed = false
): string {
  if (!state) return loadFailed ? STREAM_REPORT_LOAD_FAILED : "To your Videorc account's email."
  if (state.envDisabled) return 'Turned off when Videorc started. Reopen Videorc to change it.'
  if (!state.signedIn) return "To your Videorc account's email."
  if (state.enabled === null) return "Couldn't reach videorc.com."
  return state.email ? `To ${state.email}.` : "To your Videorc account's email."
}

export const STREAM_HISTORY_DESCRIPTION =
  "Keeps each stream's report on videorc.com/live for 90 days (YouTube's numbers for 30). Never chat messages or viewer names."

/** The history row's description: what it keeps, or why it can't say. */
export function streamHistoryDescription(state: StreamReportEmailState | null): string {
  if (!state || !state.signedIn) return STREAM_HISTORY_DESCRIPTION
  if (state.envDisabled) return 'Turned off when Videorc started. Reopen Videorc to change it.'
  if (state.history === undefined) return "Couldn't reach videorc.com."
  return STREAM_HISTORY_DESCRIPTION
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
      return 'No finished live stream yet.'
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
  loadFailed = false,
  send,
  onEnabledChange,
  onHistoryChange,
  onRetry,
  onSendLast
}: {
  /** `null` until the backend answers. */
  state: StreamReportEmailState | null
  /** The first read failed: no choices to show yet, so the row offers Try again. */
  loadFailed?: boolean
  send: StreamReportSendView
  onEnabledChange: (enabled: boolean) => void
  /** "Save my streams on videorc.com" (plan 241 D7). */
  onHistoryChange: (enabled: boolean) => void
  /** Reads the account's choice again after videorc.com didn't answer. */
  onRetry: () => void
  onSendLast: () => void
}): ReactElement {
  const signedOut = state !== null && !state.signedIn
  const usable = state !== null && state.signedIn && !state.envDisabled
  // Signed in, but the choice couldn't be read: a switch would show "off"
  // for an account that may be on, so the row offers another read instead.
  const unread = (usable && state?.enabled === null) || (state === null && loadFailed)
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
          description={streamReportEmailDescription(state, loadFailed)}
          label="Email me a report after each stream"
        >
          {unread ? (
            <Button size="xs" type="button" variant="outline" onClick={onRetry}>
              Try again
            </Button>
          ) : (
            <Switch
              checked={state?.enabled === true}
              disabled={!usable || state?.enabled === null}
              id="stream-report-email"
              onCheckedChange={onEnabledChange}
            />
          )}
        </SettingsRow>
        <SettingsRow
          data-testid="stream-history"
          description={streamHistoryDescription(state)}
          label="Save my streams on videorc.com"
        >
          <Switch
            checked={state?.history === true}
            // Unknown until videorc.com answers: a switch would show "off".
            disabled={!usable || state?.history === undefined}
            id="stream-history"
            onCheckedChange={onHistoryChange}
          />
        </SettingsRow>
        <SettingsRow
          data-testid="stream-history-open"
          description="Your last stream and your history, on the web."
          label="Your streams"
        >
          <Button
            size="xs"
            type="button"
            variant="outline"
            onClick={() => openVideorcWebLink(VIDEORC_WEB_LINKS.live)}
          >
            Open
          </Button>
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
  // The first read failed (QA F13); a later failure keeps the last choices.
  const [loadFailed, setLoadFailed] = useState(false)
  // QA F13: the pending automatic retry of a failed first read, and how many ran.
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retries = useRef(0)
  const refreshRef = useRef<() => void>(() => undefined)
  const [send, setSend] = useState<StreamReportSendView>('idle')
  // Only the latest answer may land: an older read must not undo a newer flip.
  const latest = useRef(0)
  // What the backend last said, so a failed save puts the switch back.
  const confirmed = useRef<StreamReportEmailState | null>(null)
  // Only the latest send may land: an account change or unmount retires one.
  const sendGeneration = useRef(0)

  const accept = useCallback((next: StreamReportEmailState) => {
    confirmed.current = next
    retries.current = 0
    setLoadFailed(false)
    setState(next)
  }, [])

  const cancelRetry = useCallback(() => {
    if (retryTimer.current !== null) clearTimeout(retryTimer.current)
    retryTimer.current = null
  }, [])

  const refresh = useCallback(() => {
    if (!client) return
    cancelRetry()
    const request = ++latest.current
    void client
      .requestTyped('streamReport.email.get')
      .then((next) => {
        if (request === latest.current) accept(next)
      })
      .catch(() => {
        // A failed re-read keeps the choices already shown; a failed first
        // read says so and tries again a few times on its own.
        if (request !== latest.current || confirmed.current !== null) return
        setLoadFailed(true)
        const wait = STREAM_REPORT_LOAD_RETRY_MS[retries.current]
        if (wait === undefined) return
        retries.current += 1
        retryTimer.current = setTimeout(() => refreshRef.current(), wait)
      })
  }, [accept, cancelRetry, client])
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  // Try again: a fresh cycle of automatic retries after this read.
  const retry = useCallback(() => {
    retries.current = 0
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!client) return
    retries.current = 0
    refresh()
    // Signing in or out changes where the report goes.
    const off = client.on('account.changed', () => {
      sendGeneration.current += 1
      setSend('idle')
      // Another account's choices are not this one's: forget them, so a
      // failed read says so instead of showing the old account's switches.
      confirmed.current = null
      setState(null)
      setLoadFailed(false)
      retries.current = 0
      refresh()
    })
    return () => {
      sendGeneration.current += 1
      // Retire a read still in flight, so it neither lands nor retries.
      latest.current += 1
      cancelRetry()
      off()
    }
  }, [cancelRetry, client, refresh])

  const onEnabledChange = useCallback(
    (enabled: boolean) => {
      if (!client) return
      const request = ++latest.current
      setState((current) => current && { ...current, enabled })
      client
        .requestTyped('streamReport.email.set', { enabled })
        .then((next) => {
          if (request === latest.current) accept(next)
        })
        .catch((error: unknown) => {
          if (request !== latest.current) return
          toastUserError(error, { action: 'save', object: 'the stream report setting' })
          // The account still has its old choice: show that, then read it again.
          setState(confirmed.current)
          refresh()
        })
    },
    [accept, client, refresh]
  )

  const onHistoryChange = useCallback(
    (enabled: boolean) => {
      if (!client) return
      const request = ++latest.current
      setState((current) => current && { ...current, history: enabled })
      client
        .requestTyped('streamReport.history.set', { enabled })
        .then((next) => {
          if (request === latest.current) accept(next)
        })
        .catch((error: unknown) => {
          if (request !== latest.current) return
          toastUserError(error, { action: 'save', object: 'the saved streams setting' })
          setState(confirmed.current)
          refresh()
        })
    },
    [accept, client, refresh]
  )

  const onSendLast = useCallback(() => {
    if (!client) return
    const generation = ++sendGeneration.current
    setSend('sending')
    client
      .requestTyped('streamReport.email.sendLast')
      .then((result) => {
        if (generation !== sendGeneration.current) return
        setSend(result)
        // "Turned off" means the account's choice changed somewhere else.
        if (result.status === 'disabled' || result.status === 'signed-out') refresh()
      })
      .catch(() => {
        if (generation === sendGeneration.current) setSend({ status: 'failed' })
      })
  }, [client, refresh])

  return (
    <StreamReportEmailSectionView
      loadFailed={loadFailed}
      send={send}
      state={state}
      onEnabledChange={onEnabledChange}
      onHistoryChange={onHistoryChange}
      onRetry={retry}
      onSendLast={onSendLast}
    />
  )
}
