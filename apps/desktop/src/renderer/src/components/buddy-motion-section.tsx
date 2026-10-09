import { useEffect, useState, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import type { CohostPersona } from '@/lib/backend'
import { BUDDY_MOTION_TICKS, buddySleepChoices, buddySleepLabel } from '@/lib/buddy-pet-view'
import type { BuddyMotionSettings } from '../../../shared/buddy-pet'

export interface BuddyMotionSectionProps {
  persona: CohostPersona
  /** The slider's value while it is dragged (null when it settles), so the
   * preview follows before anything is saved. */
  onDraft: (motion: BuddyMotionSettings | null) => void
  onSave: (next: CohostPersona) => Promise<void>
}

/**
 * Motion (plan 168 S-D2; D10, D13, D15): how much the Buddy moves, when it
 * falls asleep, and whether it breathes, on stream and in the preview.
 * Saves `persona.motion` with no success toast; the preview is the
 * confirmation.
 */
export function BuddyMotionSection({
  persona,
  onDraft,
  onSave
}: BuddyMotionSectionProps): ReactElement {
  const motion = persona.motion
  const [error, setError] = useState<string | null>(null)
  const [intensity, setIntensity] = useState(motion.intensity)
  useEffect(() => setIntensity(motion.intensity), [motion.intensity])
  const save = (next: BuddyMotionSettings): void => {
    setError(null)
    onSave({ ...persona, motion: next }).catch((failure: unknown) =>
      setError(failure instanceof Error ? failure.message : 'Could not save the motion.')
    )
  }
  const commitIntensity = (value: number): void => {
    const rounded = Math.round(value * 100) / 100
    setIntensity(rounded)
    onDraft(null)
    if (rounded !== motion.intensity) save({ ...motion, intensity: rounded })
  }
  return (
    <PanelSection
      description="How your Buddy moves on stream and here. Off keeps its poses and drops the bounce."
      title="Motion"
    >
      <FieldGroup variant="grouped">
        <Field>
          <div className="flex items-center justify-between gap-3">
            <FieldLabel htmlFor="buddy-motion">Motion</FieldLabel>
            <span className="text-xs tabular-nums text-muted-foreground">
              {Math.round(intensity * 100)}%
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <Slider
              aria-label="Motion"
              id="buddy-motion"
              max={1}
              min={0}
              step={0.05}
              value={[intensity]}
              onValueChange={([value]) => {
                if (value === undefined) return
                setIntensity(value)
                onDraft({ ...motion, intensity: value })
              }}
              onValueCommit={([value]) => {
                if (value !== undefined) commitIntensity(value)
              }}
            />
            <div className="relative h-6" data-testid="buddy-motion-ticks">
              {BUDDY_MOTION_TICKS.map((tick) => (
                <Button
                  key={tick.label}
                  className="absolute top-0 px-1.5 text-[11px] text-muted-foreground"
                  size="xs"
                  style={{
                    left: `${tick.value * 100}%`,
                    transform:
                      tick.value <= 0
                        ? 'translateX(-6px)'
                        : tick.value >= 1
                          ? 'translateX(calc(-100% + 6px))'
                          : 'translateX(-50%)'
                  }}
                  type="button"
                  variant="ghost"
                  onClick={() => commitIntensity(tick.value)}
                >
                  {tick.label}
                </Button>
              ))}
            </div>
          </div>
        </Field>
        <Field>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <FieldLabel htmlFor="buddy-sleep">Sleep after</FieldLabel>
              <FieldDescription>
                With no chat, activity or lines for this long. Anything wakes it.
              </FieldDescription>
            </div>
            <Select
              value={String(motion.sleepAfterSeconds)}
              onValueChange={(next) => {
                const seconds = Number(next)
                if (Number.isFinite(seconds) && seconds !== motion.sleepAfterSeconds) {
                  save({ ...motion, sleepAfterSeconds: seconds })
                }
              }}
            >
              <SelectTrigger aria-label="Sleep after" className="w-28" id="buddy-sleep">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {buddySleepChoices(motion.sleepAfterSeconds).map((seconds) => (
                    <SelectItem key={seconds} value={String(seconds)}>
                      {buddySleepLabel(seconds)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </Field>
        <Field>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <FieldLabel htmlFor="buddy-breathing">Breathing</FieldLabel>
              <FieldDescription>
                A slow breath between events, so it never looks frozen.
              </FieldDescription>
            </div>
            <Switch
              checked={motion.breathing}
              id="buddy-breathing"
              onCheckedChange={(breathing) => save({ ...motion, breathing })}
            />
          </div>
        </Field>
      </FieldGroup>
      {error ? (
        <p className="text-xs text-destructive" data-testid="buddy-motion-error">
          {error}
        </p>
      ) : null}
    </PanelSection>
  )
}
