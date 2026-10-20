import { ArrowRightIcon, ImageIcon, WarningIcon } from '@/components/icons'
import { useRef, useState, type ReactElement } from 'react'

import { BannerThumbnail } from '@/components/banner-thumbnail'
import { GroupedList, ListRow, ListRowButton } from '@/components/list-row'
import { LockAlert, OfflineAlert } from '@/components/lock-alert'
import { PanelSection } from '@/components/panel-section'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Empty, EmptyContent } from '@/components/ui/empty'
import { Field, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import {
  ParameterSlider,
  ParameterSliderControl,
  ParameterSliderHeader,
  ParameterSliderLabel,
  ParameterSliderValue
} from '@/components/ui/parameter-slider'
import { Switch } from '@/components/ui/switch'
import {
  BANNER_OPACITY_MAX,
  BANNER_OPACITY_MIN,
  type Banner,
  type BannerUpdateParams
} from '@/lib/backend'
import { BANNER_SNAPS, BANNER_SNAP_LABELS, type BannerSnap } from '@/lib/banner-place'
import type { BannerSizeAdvice } from '@/lib/banner-size'

// Banners on the Scene page (plan 186, "UI → Scene page"): the inspector's
// Banners list, and the inspector for the selected banner. Both are plain
// props-in components; the Scene page wires them to the Studio's banner
// actions. Banners change live: nothing here waits for a recording or a
// livestream to end (D9), and only Videorc reconnecting turns them off.

/** Videorc's slider knob on the audiocn thumb (docs/audiocn.md: the skin comes from outside). */
const PARAMETER_THUMB =
  '[&_[data-slot=parameter-slider-thumb]]:bg-knob [&_[data-slot=parameter-slider-thumb]]:ring-knob-ring'

const OPACITY_MIN_PCT = Math.round(BANNER_OPACITY_MIN * 100)
const OPACITY_MAX_PCT = Math.round(BANNER_OPACITY_MAX * 100)

/** Why Bring to front or Send to back is off. */
export const BANNER_IN_FRONT_REASON = 'This banner is already in front.'
export const BANNER_AT_BACK_REASON = 'This banner is already at the back.'

/** The banner's two switches and its opacity: what the inspector changes in place. */
export type BannerInspectorPatch = Pick<
  BannerUpdateParams,
  'opacity' | 'showOnStream' | 'showInRecording'
>

/** The "Showing" chip: the one in-use treatment (Assets' `InUseChip`). */
function ShowingChip(): ReactElement {
  return (
    <Badge className="shrink-0" data-videorc-in-use="">
      Showing
    </Badge>
  )
}

/**
 * The Scene inspector's Banners section: every banner in Assets order, each a
 * 32 px row with its picture, its name, "Showing" while it is, and Show or
 * Hide. A click on a row selects that banner on the stage. Assets imports and
 * orders them; this list only places, shows and hides.
 */
export function SceneBannersSection({
  banners,
  loaded,
  offline,
  selectedId,
  showLimitReason,
  onSelect,
  onShowChange,
  onOpenAssets
}: {
  banners: readonly Banner[]
  /** `banners.list` has answered: "No banners yet." waits for it. */
  loaded: boolean
  /** Videorc is reconnecting: the alert says so, and Show and Hide wait. */
  offline: boolean
  selectedId: string | null
  /** Why a hidden banner can't show now (four are showing), or null. */
  showLimitReason: string | null
  onSelect: (id: string) => void
  onShowChange: (banner: Banner, shown: boolean) => void
  onOpenAssets: () => void
}): ReactElement {
  return (
    <PanelSection
      className="min-w-0"
      description="Your images on the picture. Click one to place it on the stage."
      icon={ImageIcon}
      title="Banners"
    >
      {offline ? <OfflineAlert /> : null}
      {banners.length > 0 ? (
        <GroupedList aria-label="Banners" data-videorc-scene-banners="">
          {banners.map((banner) => {
            const showReason = !banner.shown ? showLimitReason : null
            return (
              // The name is the row's button, stretched over the row; Show or
              // Hide is its sibling, never inside it (plan 174 S0.5).
              <ListRow
                key={banner.id}
                className="relative"
                data-videorc-scene-banner-row={banner.id}
                icon={
                  <BannerThumbnail
                    banner={banner}
                    className="aspect-video h-5 rounded-chip bg-size-[8px_8px] [&_img]:p-0.5"
                  />
                }
                interactive
                selected={banner.id === selectedId}
                title={
                  <ListRowButton
                    aria-current={banner.id === selectedId ? 'true' : undefined}
                    onClick={() => onSelect(banner.id)}
                  >
                    {banner.name}
                  </ListRowButton>
                }
              >
                {banner.shown ? <ShowingChip /> : null}
                <span className="relative flex shrink-0">
                  <DisabledReason reason={showReason}>
                    <Button
                      aria-label={`${banner.shown ? 'Hide' : 'Show'} ${banner.name}`}
                      disabled={offline || showReason !== null}
                      size="xs"
                      variant="outline"
                      onClick={() => onShowChange(banner, !banner.shown)}
                    >
                      {banner.shown ? 'Hide' : 'Show'}
                    </Button>
                  </DisabledReason>
                </span>
              </ListRow>
            )
          })}
        </GroupedList>
      ) : !loaded ? (
        // Never "No banners yet." before the list is known (J2-8). Offline,
        // the alert above already says why.
        offline ? null : (
          <p className="text-meta text-muted-foreground" data-videorc-scene-banners-loading="">
            Loading banners…
          </p>
        )
      ) : (
        <Empty className="p-4" data-videorc-scene-banners-empty="">
          <p className="text-meta text-muted-foreground">No banners yet.</p>
          <EmptyContent>
            <Button variant="outline" onClick={onOpenAssets}>
              Open Assets
            </Button>
          </EmptyContent>
        </Empty>
      )}
    </PanelSection>
  )
}

/**
 * The inspector for the banner selected on the stage (plan 186): Show or
 * Hide, the seven places, the size it needs where it is, opacity, where it
 * appears, and its order. A snap keeps the banner's size and only moves it;
 * Full frame fills the canvas. Opacity commits once, on release.
 */
export function BannerInspector({
  banner,
  placeLabel,
  sizeAdvice,
  blockedReason = null,
  showLimitReason = null,
  inFront,
  atBack,
  onShowChange,
  onSnap,
  onPatch,
  onBringToFront,
  onSendToBack,
  onManage
}: {
  banner: Banner
  /** "Place", or "Place on the vertical stream" while the stage shows it. */
  placeLabel: string
  sizeAdvice: BannerSizeAdvice
  /** Why every control is off (Videorc reconnecting); null while a change can be saved. */
  blockedReason?: string | null
  /** Why a hidden banner can't show now (four are showing), or null. */
  showLimitReason?: string | null
  /** Last in Assets order: drawn on top of every other banner. */
  inFront: boolean
  /** First in Assets order: drawn under every other banner. */
  atBack: boolean
  onShowChange: (shown: boolean) => void
  onSnap: (snap: BannerSnap) => void
  /** Resolves when the change has landed or failed (the Studio's `updateBanner`). */
  onPatch: (patch: BannerInspectorPatch) => Promise<unknown> | void
  onBringToFront: () => void
  onSendToBack: () => void
  onManage: () => void
}): ReactElement {
  const blocked = blockedReason !== null
  const showReason = blocked ? null : banner.shown ? null : showLimitReason
  const committedOpacity = Math.round(banner.opacity * 100)
  // The slider's value while a drag runs and its one update lands. A newer
  // drag supersedes an older update, which then leaves the value alone.
  const [opacityDraft, setOpacityDraft] = useState<number | null>(null)
  const opacityEdit = useRef(0)
  const opacityInFlight = useRef(0)
  const commitOpacity = (pct: number): void => {
    const edit = ++opacityEdit.current
    // Back where it started, with nothing on its way: no update to send.
    if (pct === committedOpacity && opacityInFlight.current === 0) {
      setOpacityDraft(null)
      return
    }
    opacityInFlight.current++
    void Promise.resolve(onPatch({ opacity: pct / 100 })).finally(() => {
      opacityInFlight.current--
      if (opacityEdit.current === edit) setOpacityDraft(null)
    })
  }
  const streamId = `banner-${banner.id}-stream`
  const recordingId = `banner-${banner.id}-recording`
  return (
    <PanelSection
      action={
        <DisabledReason reason={showReason}>
          <Button
            data-videorc-banner-show-toggle=""
            disabled={blocked || showReason !== null}
            variant="outline"
            onClick={() => onShowChange(!banner.shown)}
          >
            {banner.shown ? 'Hide' : 'Show'}
          </Button>
        </DisabledReason>
      }
      className="min-w-0"
      description={banner.shown ? 'Showing' : 'Hidden'}
      icon={ImageIcon}
      title={banner.name}
    >
      <div className="flex flex-col gap-4" data-videorc-banner-inspector={banner.id}>
        {blockedReason ? <LockAlert reason={blockedReason} /> : null}
        <Field>
          <FieldLabel>{placeLabel}</FieldLabel>
          {/* One-shot moves, so plain Buttons: nothing stays selected (plan 174 C-37). */}
          <div aria-label="Place banner" className="flex w-full flex-wrap gap-2" role="group">
            {BANNER_SNAPS.map((snap) => (
              <Button
                key={snap}
                data-videorc-banner-snap={snap}
                disabled={blocked}
                variant="outline"
                onClick={() => onSnap(snap)}
              >
                {BANNER_SNAP_LABELS[snap]}
              </Button>
            ))}
          </div>
        </Field>
        <div className="flex flex-col gap-1 text-meta" data-videorc-banner-size="">
          <p className="text-muted-foreground">{sizeAdvice.sizeLine}</p>
          <p
            className="flex items-start gap-1.5 text-foreground"
            data-videorc-banner-size-verdict={sizeAdvice.sharp ? 'sharp' : 'soft'}
          >
            {sizeAdvice.sharp ? null : (
              <WarningIcon aria-hidden className="mt-px size-3.5 shrink-0 text-warning" />
            )}
            <span>{sizeAdvice.verdictLine}</span>
          </p>
        </div>
        <ParameterSlider
          className={PARAMETER_THUMB}
          data-videorc-banner-opacity=""
          disabled={blocked}
          largeStep={10}
          max={OPACITY_MAX_PCT}
          min={OPACITY_MIN_PCT}
          resetValue={OPACITY_MAX_PCT}
          step={1}
          unit="%"
          value={opacityDraft ?? committedOpacity}
          onValueChange={(pct) => {
            opacityEdit.current++
            setOpacityDraft(pct)
          }}
          onValueCommitted={commitOpacity}
        >
          <ParameterSliderHeader>
            <ParameterSliderLabel>Opacity</ParameterSliderLabel>
            <ParameterSliderValue />
          </ParameterSliderHeader>
          <ParameterSliderControl />
        </ParameterSlider>
        <FieldSet className="gap-0">
          <FieldLegend variant="label">Appears in</FieldLegend>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Field className="w-auto" orientation="horizontal">
              <Switch
                checked={banner.showOnStream}
                disabled={blocked}
                id={streamId}
                onCheckedChange={(showOnStream) => void onPatch({ showOnStream })}
              />
              <FieldLabel htmlFor={streamId}>Stream</FieldLabel>
            </Field>
            <Field className="w-auto" orientation="horizontal">
              <Switch
                checked={banner.showInRecording}
                disabled={blocked}
                id={recordingId}
                onCheckedChange={(showInRecording) => void onPatch({ showInRecording })}
              />
              <FieldLabel htmlFor={recordingId}>Recording</FieldLabel>
            </Field>
          </div>
        </FieldSet>
        <Field>
          {/* Assets order is the drawing order: later is on top (D5). */}
          <FieldLabel>Order</FieldLabel>
          <div aria-label="Banner order" className="flex flex-wrap gap-2" role="group">
            <DisabledReason reason={!blocked && inFront ? BANNER_IN_FRONT_REASON : null}>
              <Button disabled={blocked || inFront} variant="outline" onClick={onBringToFront}>
                Bring to front
              </Button>
            </DisabledReason>
            <DisabledReason reason={!blocked && atBack ? BANNER_AT_BACK_REASON : null}>
              <Button disabled={blocked || atBack} variant="outline" onClick={onSendToBack}>
                Send to back
              </Button>
            </DisabledReason>
          </div>
        </Field>
        <Button className="self-end" variant="ghost" onClick={onManage}>
          Manage in Assets
          <ArrowRightIcon data-icon="inline-end" />
        </Button>
      </div>
    </PanelSection>
  )
}
