import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import { ErrorIcon } from '@/components/icons'
import { PinWindowButton } from '@/components/pin-window-button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { Textarea } from '@/components/ui/textarea'
import { WindowHeader } from '@/components/window-frame'
import type { NotesFontScale, NotesWindowState } from '@/lib/backend'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { MAX_NOTES_TEXT_LENGTH } from '../../../shared/notes-limits'

// The detached Notes window (plan 050 S4): the private teleprompter, now a real
// renderer window on the same glass, header and controls as Chat and Captions.
// It is capture-protected by main (never in a recording) and follows the app theme.
// It says so, and says it loudly when main could not hide it (plan 174 I-2).
// The header carries the title only; text size and Keep on top sit in the
// footer status line (plan 174 S3.19).

const SAVE_DELAY_MS = 120

/** Where the notes are: written to disk, on their way, or not saved. */
export type NotesSaveState = 'saved' | 'saving' | 'failed'

/**
 * The footer's save word. Visual only (plan 174 I-24): a live region here
 * announced every keystroke. A failure gets its own status line with Retry.
 */
export const NOTES_SAVE_LABELS: Record<NotesSaveState, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  failed: 'Not saved'
}

/** Why Keep on top didn't take, said beside the pin. */
export type NotesPinError = 'failed' | 'unavailable'

const PIN_ERROR_LABELS: Record<NotesPinError, string> = {
  failed: "Couldn't keep on top",
  unavailable: "Keep on top isn't available"
}

// The Textarea is plain text-sm (plan 174 S1.8, J1-10), so one size wins.
const FONT_SIZE_CLASS: Record<NotesFontScale, string> = {
  sm: 'text-[18px]',
  md: 'text-[24px]',
  lg: 'text-[32px]'
}

// Full names (plan 174 I-24): each size is named "Small text" and so on; the
// visible word drops "text" so the footer fits the 360 px minimum width.
const FONT_SCALE_OPTIONS: SegmentedControlOption<NotesFontScale>[] = [
  { value: 'sm', label: 'Small', 'aria-label': 'Small text' },
  { value: 'md', label: 'Medium', 'aria-label': 'Medium text' },
  { value: 'lg', label: 'Large', 'aria-label': 'Large text' }
]

export function notesWordCount(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

function isFontScale(value: string): value is NotesFontScale {
  return value === 'sm' || value === 'md' || value === 'lg'
}

export function NotesWindow({
  smokeMarker = false,
  maxLength = MAX_NOTES_TEXT_LENGTH
}: {
  /** Recording-invisibility gate: paints the window loud red so a leak shows. */
  smokeMarker?: boolean
  maxLength?: number
}): ReactElement {
  const [text, setText] = useState('')
  const [fontScale, setFontScale] = useState<NotesFontScale>('md')
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)
  // Main's capture exclusion (`NotesWindowState.protected`); null until it reports.
  const [captureProtected, setCaptureProtected] = useState<boolean | null>(null)
  const [saveState, setSaveState] = useState<NotesSaveState>('saved')
  const [pinError, setPinError] = useState<NotesPinError | null>(null)
  const [loaded, setLoaded] = useState(false)
  const textRef = useRef(text)
  const fontScaleRef = useRef(fontScale)
  const saveTimerRef = useRef<number | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  textRef.current = text
  fontScaleRef.current = fontScale

  const save = useCallback(async (): Promise<void> => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    setSaveState('saving')
    try {
      await window.videorc?.saveNotesDocument?.({
        text: textRef.current,
        fontScale: fontScaleRef.current
      })
      setSaveState('saved')
    } catch {
      setSaveState('failed')
    }
  }, [])

  const queueSave = (): void => {
    setSaveState('saving')
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(() => void save(), SAVE_DELAY_MS)
  }

  useEffect(() => {
    let cancelled = false
    const applyState = (state: NotesWindowState | null | undefined): void => {
      if (cancelled || !state) return
      if (typeof state.alwaysOnTop === 'boolean') {
        setAlwaysOnTop(state.alwaysOnTop)
      }
      if (typeof state.protected === 'boolean') {
        setCaptureProtected(state.protected)
      }
    }
    void window.videorc
      ?.getNotesDocument?.()
      .then((document) => {
        if (cancelled || !document) return
        setText(document.text ?? '')
        setFontScale(isFontScale(document.fontScale) ? document.fontScale : 'md')
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setLoaded(true)
          textareaRef.current?.focus()
        }
      })
    void window.videorc
      ?.getNotesWindowState?.()
      .then(applyState)
      .catch(() => {})
    const offState = window.videorc?.onNotesWindowState?.(applyState)
    // Main asks for a last save before the window closes.
    const offFlush = window.videorc?.onNotesFlushRequest?.(() => void save())
    return () => {
      cancelled = true
      offState?.()
      offFlush?.()
    }
  }, [save])

  const togglePin = (): void => {
    const setPinned = window.videorc?.setNotesWindowAlwaysOnTop
    if (!setPinned) {
      setPinError('unavailable')
      return
    }
    const next = !alwaysOnTop
    setAlwaysOnTop(next)
    setPinError(null)
    void setPinned(next)
      .then((state) => state && setAlwaysOnTop(state.alwaysOnTop))
      .catch(() => {
        setAlwaysOnTop(!next)
        setPinError('failed')
      })
    textareaRef.current?.focus()
  }

  const retrySave = (): void => {
    void save()
    // The line and its button go while it saves: writing picks up again.
    textareaRef.current?.focus()
  }

  const words = notesWordCount(text)
  const marker = smokeMarker ? 'bg-[#ff0000] text-white border-[#ff0000]' : ''

  return (
    <div className="flex h-full flex-col text-foreground" data-smoke-marker={smokeMarker}>
      <WindowHeader className={marker} title="Notes" />
      <Textarea
        ref={textareaRef}
        aria-label="Notes for this recording"
        className={cn(
          // Arrow cursor, not an I-beam: the window is capture-protected, but
          // the OS draws the pointer separately, so an I-beam over "empty"
          // space would betray the hidden notes to viewers.
          'min-h-0 flex-1 cursor-default rounded-none border-0 bg-transparent px-[22px] py-5 shadow-none select-text field-sizing-fixed focus-visible:ring-0',
          FONT_SIZE_CLASS[fontScale],
          // After the size: tailwind-merge lets a later font size drop line-height.
          'leading-[1.45]',
          smokeMarker && 'bg-[#ff0000] text-[64px] leading-[1.05] font-black text-white uppercase'
        )}
        maxLength={maxLength}
        placeholder="Notes for this recording…"
        readOnly={!loaded}
        spellCheck={false}
        value={text}
        onBlur={() => void save()}
        onChange={(event) => {
          setText(event.target.value)
          textRef.current = event.target.value
          queueSave()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.currentTarget.blur()
          }
        }}
      />
      {/* Main could not exclude the window from capture (or the platform
          cannot). Below the text, so the teleprompter's first lines never
          move. */}
      {captureProtected === false ? (
        <div className={cn('shrink-0 border-t border-border p-2', marker)}>
          <Alert className={marker} data-testid="notes-capture-exposed" variant="destructive">
            <AlertTitle className="text-xs">These notes can appear in your recording</AlertTitle>
            <AlertDescription className="text-xs">
              Videorc couldn&apos;t hide this window from screen capture. Keep it off the screen you
              capture, or close it.
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      {/* A save that failed, said once (role="status") with its fix. The
          wrapper stays mounted so the line is announced when it appears. */}
      <div className="shrink-0" data-testid="notes-save-failure" role="status">
        {saveState === 'failed' ? (
          <div
            className={cn(
              'flex items-center gap-2 border-t border-border py-1 pr-1.5 pl-3 text-xs text-foreground',
              marker
            )}
          >
            <ErrorIcon aria-hidden className="size-3.5 shrink-0 text-destructive" weight="fill" />
            <span className="min-w-0 flex-1">
              Couldn&apos;t save your notes. Your text is still here.
            </span>
            <Button
              className="[-webkit-app-region:no-drag]"
              size="xs"
              type="button"
              variant="outline"
              onClick={retrySave}
            >
              Retry
            </Button>
          </div>
        ) : null}
      </div>
      <footer
        className={cn(
          'flex h-status-bar shrink-0 items-center gap-3 border-t border-border pr-1.5 pl-3 text-[11px] text-muted-foreground select-none',
          marker
        )}
      >
        <span className="shrink-0">{plural(words, 'word')}</span>
        <span className="shrink-0" data-testid="notes-save-state">
          {NOTES_SAVE_LABELS[saveState]}
        </span>
        {captureProtected ? (
          <span className="min-w-0 truncate" data-testid="notes-capture-hidden">
            Hidden from recordings and streams
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center">
          {/* SegmentedControl has no Radix, so it splits no shared chunk the
              main window loads eagerly (asset budget). A pick goes back to
              writing. */}
          <SegmentedControl
            activationMode="manual"
            aria-label="Text size"
            className={marker}
            options={FONT_SCALE_OPTIONS}
            size="sm"
            value={fontScale}
            onValueChange={(scale) => {
              setFontScale(scale)
              fontScaleRef.current = scale
              queueSave()
              textareaRef.current?.focus()
            }}
          />
          {/* A pin that didn't take says so beside the pin. */}
          <span
            className="ml-2 flex items-center gap-1 text-foreground empty:ml-0"
            data-testid="notes-pin-error"
            role="status"
          >
            {pinError ? (
              <>
                <ErrorIcon aria-hidden className="size-3 shrink-0 text-destructive" weight="fill" />
                {PIN_ERROR_LABELS[pinError]}
              </>
            ) : null}
          </span>
          <PinWindowButton
            className={cn('ml-1', marker)}
            pinned={alwaysOnTop}
            variant="status-bar"
            onPinnedChange={togglePin}
          />
        </div>
      </footer>
    </div>
  )
}
