import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import { PinIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useTrafficLightGutter } from '@/components/window-frame'
import type { NotesFontScale, NotesWindowState } from '@/lib/backend'
import { cn } from '@/lib/utils'
import { MAX_NOTES_TEXT_LENGTH } from '../../../shared/notes-limits'

// The detached Notes window (plan 050 S4): the private teleprompter, now a real
// renderer window on the same glass, header and controls as Chat and Captions.
// It is capture-protected by main (never in a recording) and follows the app theme.

const SAVE_DELAY_MS = 120

export type NotesSaveStatus =
  | 'Saved'
  | 'Saving'
  | 'Unsaved'
  | 'Save failed'
  | 'Pin unavailable'
  | 'Pin failed'

// The md: twins beat the shadcn Textarea's own md:text-sm.
const FONT_SIZE_CLASS: Record<NotesFontScale, string> = {
  sm: 'text-[18px] md:text-[18px]',
  md: 'text-[24px] md:text-[24px]',
  lg: 'text-[32px] md:text-[32px]'
}

const FONT_SCALE_LABEL: Record<NotesFontScale, string> = { sm: 'S', md: 'M', lg: 'L' }

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
  const [status, setStatus] = useState<NotesSaveStatus>('Saved')
  const [loaded, setLoaded] = useState(false)
  const trafficLightGutter = useTrafficLightGutter()
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
    setStatus('Saving')
    try {
      await window.videorc?.saveNotesDocument?.({
        text: textRef.current,
        fontScale: fontScaleRef.current
      })
      setStatus('Saved')
    } catch {
      setStatus('Save failed')
    }
  }, [])

  const queueSave = (): void => {
    setStatus('Unsaved')
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(() => void save(), SAVE_DELAY_MS)
  }

  useEffect(() => {
    let cancelled = false
    const applyState = (state: NotesWindowState | null | undefined): void => {
      if (!cancelled && state && typeof state.alwaysOnTop === 'boolean') {
        setAlwaysOnTop(state.alwaysOnTop)
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
      setStatus('Pin unavailable')
      return
    }
    const next = !alwaysOnTop
    setAlwaysOnTop(next)
    void setPinned(next)
      .then((state) => state && setAlwaysOnTop(state.alwaysOnTop))
      .catch(() => {
        setAlwaysOnTop(!next)
        setStatus('Pin failed')
      })
    textareaRef.current?.focus()
  }

  const pinLabel = alwaysOnTop ? 'Allow notes behind other apps' : 'Keep notes in front of all apps'
  const words = notesWordCount(text)
  const marker = smokeMarker ? 'bg-[#ff0000] text-white border-[#ff0000]' : ''

  return (
    <div className="flex h-full flex-col text-foreground" data-smoke-marker={smokeMarker}>
      <header
        className={cn(
          'flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 select-none [-webkit-app-region:drag]',
          trafficLightGutter,
          marker
        )}
      >
        <span className="text-[13px] font-semibold">Notes</span>
        <span className="flex-1" />
        {/* Plain Buttons, not ToggleGroup: Radix roving focus would split a
            shared chunk the main window then loads eagerly (asset budget). */}
        <div
          aria-label="Text size"
          className="flex items-center rounded-chip border border-border [-webkit-app-region:no-drag]"
          role="group"
        >
          {(['sm', 'md', 'lg'] as const).map((scale) => (
            <Button
              key={scale}
              aria-label={`${FONT_SCALE_LABEL[scale]} text`}
              aria-pressed={fontScale === scale}
              className={cn(
                'h-6 min-w-7 rounded-none px-2 text-[11px] first:rounded-l-chip last:rounded-r-chip',
                fontScale === scale ? 'bg-accent text-foreground' : 'text-muted-foreground',
                marker
              )}
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => {
                setFontScale(scale)
                fontScaleRef.current = scale
                queueSave()
                textareaRef.current?.focus()
              }}
            >
              {FONT_SCALE_LABEL[scale]}
            </Button>
          ))}
        </div>
        <Button
          aria-label={pinLabel}
          aria-pressed={alwaysOnTop}
          className={cn(
            'size-7 [-webkit-app-region:no-drag]',
            alwaysOnTop && 'text-foreground',
            marker
          )}
          size="icon"
          title={pinLabel}
          type="button"
          variant="ghost"
          onClick={togglePin}
        >
          <PinIcon className="size-4" weight={alwaysOnTop ? 'fill' : 'regular'} />
        </Button>
      </header>
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
          smokeMarker &&
            'bg-[#ff0000] text-[64px] leading-[1.05] font-black text-white uppercase md:text-[64px]'
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
      <footer
        className={cn(
          'flex h-6 shrink-0 items-center gap-3 border-t border-border px-3 text-[11px] text-subtle select-none',
          marker
        )}
      >
        <span>
          {words} {words === 1 ? 'word' : 'words'}
        </span>
        <span aria-live="polite">{status}</span>
      </footer>
    </div>
  )
}
