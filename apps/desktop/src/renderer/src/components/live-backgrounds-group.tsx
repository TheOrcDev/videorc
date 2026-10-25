import { AdjustIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import { Gallery } from '@/components/page'
import { PowerSlider } from '@/components/power-slider'
import { SectionLabel } from '@/components/section-label'
import { IN_USE_RING, InUseChip } from '@/components/takeover-screens-section'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SegmentedControl } from '@/components/ui/segmented-control'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useBackgroundAssets } from '@/hooks/use-background-assets'
import { useStudioCore } from '@/hooks/use-studio'
import { liveBackgroundSettings, type LiveBackgroundSettings } from '@/lib/background-assets'
import {
  BACKGROUND_STYLE_FIELDS,
  defaultLiveBackgroundSettings,
  setLiveBackgroundSettings
} from '@/lib/background-library'
import {
  LIVE_BACKGROUND_CREDIT,
  LIVE_BACKGROUND_MOTION_OPTIONS,
  LIVE_BACKGROUND_OFFERED,
  liveBackgroundEntry,
  liveBackgroundLook,
  liveBackgroundStillLine,
  liveBackgroundThumbnail
} from '@/lib/live-backgrounds'
import { cn } from '@/lib/utils'
import type { LiveBackgroundId } from '../../../shared/live-background-ids'

// Live backgrounds in Assets → Backgrounds (plans 190 S8 and 194 S7): a Live
// group of ten tiles above the pictures, in two rows of five where five fit
// (the plan 190 five, then plan 194's). A click puts one on the scene and a
// click on the active tile takes it off, like the picture tiles. They are
// built in, so a tile has no ⋯ menu: no Remove, Rename or Replace. Adjust
// style holds the four choices a live background has (D8): Look, Motion,
// Visibility and Dim.

/**
 * KebabMenu's `reveal="hover"` recipe: a tile that isn't on the scene shows
 * its Adjust style on hover and focus, and keeps it while the popover is open.
 * Kept here, in the lazy Assets chunk, so the eager bundle exports nothing new.
 */
const REVEAL_ON_HOVER =
  'opacity-0 group-hover/kebab-host:opacity-100 group-focus-within/kebab-host:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100'

type LiveStyleField = (typeof BACKGROUND_STYLE_FIELDS)[number] & {
  key: 'visibilityPercent' | 'dimPercent'
}

/** Visibility and Dim, with the ranges and units the picture popover uses. */
const LIVE_STYLE_FIELDS = BACKGROUND_STYLE_FIELDS.filter(
  (field): field is LiveStyleField =>
    field.key === 'visibilityPercent' || field.key === 'dimPercent'
)

export function LiveBackgroundsGroup(): ReactElement {
  const { applyLiveBackground } = useStudioCore()
  const { registry } = useBackgroundAssets()

  return (
    <div className="flex flex-col gap-2" data-videorc-live-backgrounds="">
      <SectionLabel as="h3">Live</SectionLabel>
      <Gallery className="gap-3" rowsOfFive>
        {LIVE_BACKGROUND_OFFERED.map((entry) => {
          const active = registry.live.activeId === entry.id
          return (
            <LiveBackgroundTile
              key={entry.id}
              active={active}
              id={entry.id}
              look={liveBackgroundSettings(registry, entry.id).look}
              onToggle={() => applyLiveBackground(active ? null : entry.id)}
            />
          )
        })}
      </Gallery>
      <p className="text-meta text-muted-foreground">{LIVE_BACKGROUND_CREDIT}</p>
    </div>
  )
}

function LiveBackgroundTile({
  id,
  look,
  active,
  onToggle
}: {
  id: LiveBackgroundId
  look: string
  active: boolean
  onToggle: () => void
}): ReactElement {
  const { name } = liveBackgroundEntry(id)
  const shown = liveBackgroundLook(id, look)

  return (
    <div
      className={cn(
        // The picture tile's anatomy (assets-tab PresetTile): the image is the
        // button, the name strip carries the tile's one control.
        'group/kebab-host relative flex aspect-video items-end overflow-hidden rounded-row border transition-colors',
        active
          ? cn('border-foreground/25', IN_USE_RING)
          : 'border-border hover:border-foreground/30'
      )}
      data-videorc-live-background-tile={id}
      data-videorc-live-background-look={shown.id}
    >
      <button
        type="button"
        aria-pressed={active}
        aria-label={active ? `Remove ${name} from the scene` : `Apply ${name} to the scene`}
        className="absolute inset-0 outline-none after:pointer-events-none after:absolute after:inset-0 after:rounded-row focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
        onClick={onToggle}
      >
        {/* The look's thumbnail is its poster scaled down: the first frame a click shows. */}
        <img
          alt=""
          className="absolute inset-0 size-full object-cover"
          src={liveBackgroundThumbnail(id, shown.id)}
        />
      </button>

      {active ? <InUseChip className="pointer-events-none absolute top-1.5 left-1.5 z-10" /> : null}

      <div className="pointer-events-none relative z-10 flex w-full items-center gap-1.5 bg-gradient-to-t from-background/95 via-background/70 to-transparent px-2 pt-5 pb-1">
        <span className="min-w-0 truncate text-xs font-medium">{name}</span>
        <Badge className="shrink-0" variant="outline">
          Live
        </Badge>
        <span className="pointer-events-auto ml-auto flex shrink-0 items-center">
          <LiveBackgroundStyleControl id={id} name={name} revealOnHover={!active} />
        </span>
      </div>
    </div>
  )
}

/**
 * Adjust style for one live background, wired to the registry: an edit to
 * the background on the scene applies through the library sync, and an edit
 * to another one is only remembered for its next click. Assets' "In this
 * scene" row uses it too.
 */
export function LiveBackgroundStyleControl({
  id,
  name,
  revealOnHover = false
}: {
  id: LiveBackgroundId
  name: string
  /** A tile that isn't on the scene shows the control on hover and focus. */
  revealOnHover?: boolean
}): ReactElement {
  const { liveBackgroundStatus } = useStudioCore()
  const { registry, setRegistry } = useBackgroundAssets()
  const status = liveBackgroundStatus?.id === id ? liveBackgroundStatus : null

  return (
    <LiveBackgroundStylePopover
      id={id}
      name={name}
      revealOnHover={revealOnHover}
      settings={liveBackgroundSettings(registry, id)}
      stillLine={status?.rendering === 'still' ? liveBackgroundStillLine(status.reason) : null}
      onChange={(patch) => setRegistry((current) => setLiveBackgroundSettings(current, id, patch))}
    />
  )
}

export function LiveBackgroundStylePopover({
  id,
  name,
  settings,
  stillLine,
  revealOnHover = false,
  onChange
}: {
  id: LiveBackgroundId
  name: string
  settings: LiveBackgroundSettings
  /** Why the background on the scene shows a still frame, or null while it moves. */
  stillLine: string | null
  revealOnHover?: boolean
  onChange: (patch: Partial<LiveBackgroundSettings>) => void
}): ReactElement {
  const { looks } = liveBackgroundEntry(id)
  const look = liveBackgroundLook(id, settings.look)
  const defaults = defaultLiveBackgroundSettings(id)

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              aria-label={`Adjust style for ${name}`}
              className={cn(revealOnHover && REVEAL_ON_HOVER)}
              size="icon"
              variant="ghost"
            >
              <AdjustIcon />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Adjust style</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80" data-videorc-live-background-style={id}>
        <Field className="gap-1.5">
          <FieldLabel>Look</FieldLabel>
          <Select value={look.id} onValueChange={(next) => onChange({ look: next })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {looks.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field className="gap-1.5">
          <FieldLabel>Motion</FieldLabel>
          <SegmentedControl
            className="w-full"
            options={LIVE_BACKGROUND_MOTION_OPTIONS}
            value={settings.motion}
            onValueChange={(motion) => onChange({ motion })}
          />
        </Field>
        {LIVE_STYLE_FIELDS.map((field) => (
          <PowerSlider
            key={field.key}
            label={field.label}
            value={settings[field.key]}
            min={field.min}
            max={field.max}
            suffix={field.suffix}
            numericInput
            defaultValue={defaults[field.key]}
            onChange={(next) => onChange({ [field.key]: next })}
          />
        ))}
        {stillLine ? (
          <p className="text-meta text-muted-foreground" data-videorc-live-background-still="">
            {stillLine}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
