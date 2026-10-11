import { useCallback, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'

import type { AcceleratorKeyInput, AcceleratorModifier } from '../../../shared/accelerator'
import { acceleratorModifiersLabel } from '../../../shared/accelerator'
import { CloseIcon } from '@/components/icons'
import { SettingsRow } from '@/components/ui/field'
import { useFieldControlId, useFieldDescribedBy } from '@/components/ui/field-context'
import { InputGroup, InputGroupAddon, InputGroupButton } from '@/components/ui/input-group'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { shortcutRecorderName, shortcutRecorderStep } from '@/lib/shortcut-recorder'
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
 *
 * Plan 174 S3.17 (I-7, I-17): one SettingsRow. The field's name carries the
 * binding it holds, and a refusal or a failed registration is the row's
 * FieldError, which a screen reader announces when it appears.
 */
export function ShortcutRecorderField(props: ShortcutRecorderFieldProps): ReactElement {
  const { label, registrationFailed = false } = props
  const [message, setMessage] = useState<string | null>(null)
  const [armed, setArmed] = useState(false)
  return (
    <SettingsRow
      error={
        message ??
        (registrationFailed && !armed
          ? 'Another app already uses this shortcut. Pick another.'
          : null)
      }
      label={label}
    >
      <ShortcutRecorderControl
        {...props}
        armed={armed}
        onArmedChange={setArmed}
        onMessageChange={setMessage}
      />
    </SettingsRow>
  )
}

/** The recorder itself, inside its row's Field so the label names it. */
function ShortcutRecorderControl({
  id,
  label,
  value,
  platform,
  validate,
  onChange,
  registrationFailed = false,
  armed,
  onArmedChange: setArmed,
  onMessageChange: setMessage
}: ShortcutRecorderFieldProps & {
  armed: boolean
  onArmedChange: (armed: boolean) => void
  onMessageChange: (message: string | null) => void
}): ReactElement {
  const [held, setHeld] = useState<AcceleratorModifier[]>([])
  // Registered with the row's Field: its label points here, and its
  // description (none today) would describe the field.
  const controlId = useFieldControlId(id)
  const describedBy = useFieldDescribedBy(undefined)
  // Tears down the current capture (IPC subscriptions + main's arm). Also
  // identifies it: a late arm reply for an older capture is ignored.
  const teardownRef = useRef<(() => void) | null>(null)

  const disarm = useCallback((): void => {
    const teardown = teardownRef.current
    teardownRef.current = null
    teardown?.()
    setArmed(false)
    setHeld([])
  }, [setArmed])

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
        // Main refused (no main window): a bound global combo would still
        // fire instead of reaching the field, so stop.
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

  const heldLabel = acceleratorModifiersLabel(held, platform)

  return (
    <InputGroup
      className={cn(
        'w-44 shrink-0',
        armed && 'border-ring ring-3 ring-ring/30',
        registrationFailed && !armed && 'border-destructive'
      )}
    >
      <button
        ref={lifecycleRef}
        aria-describedby={describedBy}
        aria-invalid={registrationFailed || undefined}
        aria-label={shortcutRecorderName({ label, value, armed, platform })}
        className="flex h-full min-w-0 flex-1 cursor-default items-center gap-1 rounded-chip px-2.5 text-left text-xs outline-none"
        data-slot="input-group-control"
        id={controlId}
        type="button"
        onBlur={() => {
          if (teardownRef.current) disarm()
        }}
        onClick={arm}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      >
        {armed ? (
          heldLabel ? (
            <KbdGroup>
              <Kbd>{heldLabel}</Kbd>
              <span className="text-muted-foreground">…</span>
            </KbdGroup>
          ) : (
            <span className="truncate text-muted-foreground">Press shortcut…</span>
          )
        ) : value ? (
          <ShortcutKeys accelerator={value} platform={platform} />
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
  )
}
