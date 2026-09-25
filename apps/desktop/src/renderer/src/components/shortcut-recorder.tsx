import { useCallback, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'

import type { AcceleratorKeyInput, AcceleratorModifier } from '../../../shared/accelerator'
import { acceleratorDisplayKeys, acceleratorModifierLabels } from '../../../shared/accelerator'
import { CloseIcon } from '@/components/icons'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupButton } from '@/components/ui/input-group'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { shortcutRecorderStep } from '@/lib/shortcut-recorder'
import { cn } from '@/lib/utils'

interface ShortcutRecorderFieldProps {
  id: string
  label: string
  /** Stored Electron accelerator; empty or undefined means unassigned. */
  value: string | undefined
  platform: string | undefined
  /** Extra refusal on top of the shared rules (the duplicate check). */
  validate: (accelerator: string) => string | null
  /** Exactly one call per committed combination; '' clears the binding. */
  onChange: (accelerator: string) => void
  /** The OS refused this binding (another app owns it). */
  registrationFailed?: boolean
}

function domKeyInput(event: KeyboardEvent, type: 'keyDown' | 'keyUp'): AcceleratorKeyInput {
  return {
    type,
    code: event.code,
    meta: event.metaKey,
    control: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey
  }
}

/**
 * Plan 062: a global shortcut is set by pressing it. Click (or Enter/Space)
 * arms the field; main then owns key capture (see `setShortcutRecorderArmed`)
 * so a combination that is already bound, ⌘1–9 or the studio's Space key
 * reach the field instead of firing. Esc cancels, Backspace clears.
 */
export function ShortcutRecorderField({
  id,
  label,
  value,
  platform,
  validate,
  onChange,
  registrationFailed = false
}: ShortcutRecorderFieldProps): ReactElement {
  const [armed, setArmed] = useState(false)
  const [held, setHeld] = useState<AcceleratorModifier[]>([])
  const [message, setMessage] = useState<string | null>(null)
  // Tears down the current capture (IPC subscriptions + main's arm). Also
  // identifies it: a late arm reply for an older capture is ignored.
  const teardownRef = useRef<(() => void) | null>(null)

  const disarm = useCallback((): void => {
    const teardown = teardownRef.current
    teardownRef.current = null
    teardown?.()
    setArmed(false)
    setHeld([])
  }, [])

  const handleKey = (input: AcceleratorKeyInput): void => {
    const step = shortcutRecorderStep(input, platform, validate)
    switch (step.type) {
      case 'held':
        setHeld(step.modifiers)
        return
      case 'reject':
        setHeld([])
        setMessage(step.message)
        return
      case 'commit':
        setMessage(null)
        disarm()
        if (step.accelerator !== value) onChange(step.accelerator)
        return
      case 'clear':
        setMessage(null)
        disarm()
        if (value) onChange('')
        return
      case 'cancel':
        setMessage(null)
        disarm()
    }
  }

  const arm = (): void => {
    if (teardownRef.current) return
    setMessage(null)
    setHeld([])
    setArmed(true)
    const api = window.videorc
    if (!api?.setShortcutRecorderArmed || !api.onShortcutRecorderKey) {
      // No bridge (browser dev): the DOM handlers below record the keys.
      teardownRef.current = () => undefined
      return
    }
    const offKey = api.onShortcutRecorderKey(handleKey)
    const offDisarmed = api.onShortcutRecorderDisarmed?.(() => {
      if (teardownRef.current === teardown) disarm()
    })
    const teardown = (): void => {
      offKey()
      offDisarmed?.()
      void api.setShortcutRecorderArmed?.(false)
    }
    teardownRef.current = teardown
    void api.setShortcutRecorderArmed(true).then(
      (result) => {
        // Main refuses when the window is not focused; the DOM handlers
        // still work, but a bound global combo would fire, so stop.
        if (!result.armed && teardownRef.current === teardown) disarm()
      },
      () => {
        if (teardownRef.current === teardown) disarm()
      }
    )
  }

  // Unmounting mid-capture (tab switch) must hand global shortcuts back.
  // A stable ref callback with cleanup runs only on mount/unmount.
  const lifecycleRef = useCallback(
    (node: HTMLButtonElement | null) => {
      if (!node) return
      return () => {
        if (teardownRef.current) disarm()
      }
    },
    [disarm]
  )

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!armed) {
      if (event.key === 'Enter' || event.key === ' ') {
        // Keep Space from also reaching the studio's start/stop handler.
        event.preventDefault()
        event.stopPropagation()
        arm()
      }
      return
    }
    // Only reached before main confirms the arm, or with no bridge.
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat) handleKey(domKeyInput(event, 'keyDown'))
  }

  const onKeyUp = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!armed) return
    event.preventDefault()
    event.stopPropagation()
    handleKey(domKeyInput(event, 'keyUp'))
  }

  const keys = acceleratorDisplayKeys(value, platform)
  const heldLabels = acceleratorModifierLabels(held, platform)

  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <InputGroup
          className={cn(
            'w-44 shrink-0',
            armed && 'border-ring ring-3 ring-ring/30',
            registrationFailed && !armed && 'border-destructive'
          )}
        >
          <button
            ref={lifecycleRef}
            aria-invalid={registrationFailed || undefined}
            aria-label={
              armed ? `${label}: press the new shortcut` : `${label}: click to record a shortcut`
            }
            className="flex h-full min-w-0 flex-1 cursor-default items-center gap-1 rounded-chip px-2.5 text-left text-xs outline-none"
            data-slot="input-group-control"
            id={id}
            type="button"
            onBlur={() => {
              if (teardownRef.current) disarm()
            }}
            onClick={arm}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
          >
            {armed ? (
              heldLabels.length > 0 ? (
                <KbdGroup>
                  {heldLabels.map((glyph) => (
                    <Kbd key={glyph}>{glyph}</Kbd>
                  ))}
                  <span className="text-muted-foreground">…</span>
                </KbdGroup>
              ) : (
                <span className="truncate text-muted-foreground">Press shortcut…</span>
              )
            ) : keys.length > 0 ? (
              <KbdGroup>
                {keys.map((glyph, index) => (
                  <Kbd key={`${glyph}-${index}`}>{glyph}</Kbd>
                ))}
              </KbdGroup>
            ) : (
              <span className="truncate text-muted-foreground">Unassigned</span>
            )}
          </button>
          {value && !armed ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                aria-label={`Clear the ${label} shortcut`}
                size="icon-xs"
                onClick={() => {
                  setMessage(null)
                  onChange('')
                }}
              >
                <CloseIcon />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>
      {message ? (
        <FieldDescription className="text-right text-xs">{message}</FieldDescription>
      ) : registrationFailed && !armed ? (
        <FieldError className="text-right text-xs">
          Another app already uses this shortcut. Pick another.
        </FieldError>
      ) : null}
    </Field>
  )
}
