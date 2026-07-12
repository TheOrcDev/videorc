import {
  ArrowCounterClockwise,
  ArrowSquareOut,
  ArrowsClockwise,
  CheckCircle,
  Eye,
  ImageSquare,
  PencilSimple,
  SlidersHorizontal,
  Trash,
  UploadSimple,
  Warning,
  X
} from '@phosphor-icons/react'
import { useState, type ComponentProps, type ReactElement } from 'react'
import { toast } from 'sonner'

import { KebabMenu } from '@/components/kebab-menu'
import { Gallery } from '@/components/page'
import { PanelSection } from '@/components/panel-section'
import { PowerSlider } from '@/components/power-slider'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useBackgroundAssets } from '@/hooks/use-background-assets'
import {
  BACKGROUND_STYLE_FIELDS,
  applySlot,
  clearActiveSlot,
  createImportedAsset,
  defaultBackgroundStyle,
  importIntoSlot,
  backgroundAssetDisplayUrl,
  markSlotMissingIfAssetMatches,
  markSlotStatus,
  removeSlotAsset,
  renameAsset,
  setAssetStyle,
  slotAsset,
  slotDisplayStatus,
  slotName,
  type BackgroundAsset,
  type BackgroundAssetRegistry,
  type BackgroundAssetSlot,
  type BackgroundAssetSlotStatus,
  type BackgroundFit,
  firstEmptySlotId
} from '@/lib/background-assets'
import { TakeoverScreensSection } from '@/components/takeover-screens-section'
import { useStudioCore } from '@/hooks/use-studio'
import { cn } from '@/lib/utils'

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>['variant']>

const STATUS_BADGE: Record<BackgroundAssetSlotStatus, { label: string; variant: BadgeVariant }> = {
  empty: { label: 'Empty', variant: 'outline' },
  ready: { label: 'Ready', variant: 'secondary' },
  active: { label: 'Active', variant: 'success' },
  'missing-file': { label: 'File missing', variant: 'warning' },
  unsupported: { label: 'Unsupported', variant: 'destructive' }
}

const FIT_OPTIONS: { value: BackgroundFit; label: string }[] = [
  { value: 'fill', label: 'Fill' },
  { value: 'fit', label: 'Fit' },
  { value: 'stretch', label: 'Stretch' }
]

const imageUrl = backgroundAssetDisplayUrl

// assetPath/thumbnailPath are optional on the model (placeholders have neither);
// imported assets always carry both, so prefer the thumbnail and fall back.
function imageSrcOf(asset: BackgroundAsset): string | undefined {
  return asset.thumbnailPath ?? asset.assetPath
}

// A1 (UX rework): the 360px "Inspector" column is gone — clicking a tile
// already applies it, so the column's Apply button was permanently disabled and
// its style sliders acted on nothing visible. The gallery now uses the full
// width; low-frequency per-slot actions live in each tile's ⋯ menu, and the
// style controls moved to the Active background bar where they edit the one
// background that has a visible consequence.
export function AssetsTab(): ReactElement {
  const { registry, setRegistry } = useBackgroundAssets()
  const [importing, setImporting] = useState(false)
  const [renamingSlotId, setRenamingSlotId] = useState<string | null>(null)

  // An <img> load failure is only allowed to brand a slot "Missing" when the
  // file is genuinely gone — decode hiccups and transient read errors must
  // not (F4 honesty rule). Bundled/relative assets have no checkable path;
  // for those a load failure still marks missing (the bundle itself broke).
  const markMissing = (slotId: string): void => {
    const slot = registry.slots.find((entry) => entry.id === slotId)
    const asset = slot ? slotAsset(slot, registry) : null
    const checkedAssetId = asset?.id
    const expectedAssetReference = asset?.assetPath
    if (
      asset?.kind === 'imported' &&
      expectedAssetReference &&
      checkedAssetId &&
      window.videorc?.backgroundAssetExists
    ) {
      void window.videorc.backgroundAssetExists(checkedAssetId).then((exists) => {
        if (!exists) {
          setRegistry((current) =>
            markSlotMissingIfAssetMatches(current, slotId, checkedAssetId, expectedAssetReference)
          )
        }
      })
      return
    }
    setRegistry((current) => markSlotStatus(current, slotId, 'missing-file'))
  }

  const importInto = async (explicitSlotId: string | null): Promise<void> => {
    if (!window.videorc?.importBackgroundImage) {
      toast.error('Image import is unavailable outside Electron.')
      return
    }
    const target = explicitSlotId ?? firstEmptySlotId(registry)
    if (!target) {
      toast.error('All preset slots are full — replace one from its ⋯ menu.')
      return
    }

    try {
      setImporting(true)
      const result = await window.videorc.importBackgroundImage()
      if (!result) {
        return
      }
      const now = new Date().toISOString()
      const asset = createImportedAsset({
        id: result.id,
        name: result.name,
        assetPath: result.assetPath,
        thumbnailPath: result.thumbnailPath,
        createdAt: now,
        updatedAt: now
      })
      setRegistry((current) => importIntoSlot(current, target, asset))
      toast.success(`Imported ${asset.name}.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not import the background.')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Assets</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Backgrounds for your scenes and takeover screens for the output. Click a preset to apply
          it; tune the active one below.
        </p>
      </div>

      <PanelSection
        title="Background presets"
        icon={ImageSquare}
        description={`${registry.slots.length} slots`}
        action={
          <Button disabled={importing} size="sm" variant="outline" onClick={() => importInto(null)}>
            <UploadSimple data-icon="inline-start" />
            Import
          </Button>
        }
      >
        <Gallery className="gap-3">
          {registry.slots.map((slot) => (
            <PresetTile
              key={slot.id}
              slot={slot}
              registry={registry}
              importing={importing}
              renaming={renamingSlotId === slot.id}
              onActivate={() => {
                const status = slotDisplayStatus(slot, registry)
                if (status === 'empty') {
                  void importInto(slot.id)
                  return
                }
                setRegistry((current) => applySlot(current, slot.id))
              }}
              onMissing={() => markMissing(slot.id)}
              onStartRename={() => setRenamingSlotId(slot.id)}
              onRename={(assetId, name) => {
                setRegistry((current) => renameAsset(current, assetId, name))
                setRenamingSlotId(null)
              }}
              onCancelRename={() => setRenamingSlotId(null)}
              onReplace={() => void importInto(slot.id)}
              onResetStyle={(assetId) =>
                setRegistry((current) => setAssetStyle(current, assetId, defaultBackgroundStyle()))
              }
              onRemove={() => setRegistry((current) => removeSlotAsset(current, slot.id))}
            />
          ))}
        </Gallery>
      </PanelSection>

      <ActiveBackgroundBar
        registry={registry}
        onMissing={markMissing}
        onClear={() => setRegistry(clearActiveSlot)}
        onStyle={(assetId, patch) =>
          setRegistry((current) => setAssetStyle(current, assetId, patch))
        }
      />

      <TakeoverScreensSection />
    </div>
  )
}

function PresetTile({
  slot,
  registry,
  importing,
  renaming,
  onActivate,
  onMissing,
  onStartRename,
  onRename,
  onCancelRename,
  onReplace,
  onResetStyle,
  onRemove
}: {
  slot: BackgroundAssetSlot
  registry: BackgroundAssetRegistry
  importing: boolean
  renaming: boolean
  onActivate: () => void
  onMissing: () => void
  onStartRename: () => void
  onRename: (assetId: string, name: string) => void
  onCancelRename: () => void
  onReplace: () => void
  onResetStyle: (assetId: string) => void
  onRemove: () => void
}): ReactElement {
  const asset = slotAsset(slot, registry)
  const status = slotDisplayStatus(slot, registry)
  const name = slotName(slot, registry)
  const active = status === 'active'
  const imageSrc = asset ? imageSrcOf(asset) : undefined
  const badge = STATUS_BADGE[status]

  return (
    <div
      className={cn(
        'group relative flex aspect-[16/9] items-end overflow-hidden rounded-row border transition-colors',
        active
          ? 'border-success ring-1 ring-success/60'
          : 'border-border hover:border-foreground/30'
      )}
    >
      <button
        type="button"
        aria-pressed={active}
        title={status === 'empty' ? `Import into ${name}` : `Apply ${name} to the scene`}
        className="absolute inset-0 cursor-pointer"
        onClick={onActivate}
        onDoubleClick={() => asset && onStartRename()}
      >
        {imageSrc && status !== 'missing-file' ? (
          <img
            alt=""
            className="absolute inset-0 size-full object-cover"
            src={imageUrl(imageSrc)}
            onError={onMissing}
          />
        ) : (
          <span className="absolute inset-0 grid place-items-center bg-muted/30">
            {status === 'missing-file' ? (
              <Warning className="size-6 text-warning" weight="duotone" />
            ) : status === 'empty' ? (
              <UploadSimple className="size-6 text-muted-foreground/40" weight="duotone" />
            ) : (
              <ImageSquare className="size-6 text-muted-foreground/40" weight="duotone" />
            )}
          </span>
        )}
      </button>

      {active ? (
        <CheckCircle
          weight="fill"
          className="pointer-events-none absolute left-1.5 top-1.5 z-10 size-4 text-success"
        />
      ) : null}

      {asset ? (
        <div className="absolute right-1 top-1 z-10 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <KebabMenu
            label={`Actions for ${name}`}
            className="bg-background/70 backdrop-blur-sm"
            items={[
              { id: 'rename', label: 'Rename', icon: PencilSimple, onSelect: onStartRename },
              {
                id: 'replace',
                label: 'Replace image…',
                icon: ArrowsClockwise,
                disabled: importing,
                onSelect: onReplace
              },
              {
                id: 'reveal',
                label: 'Reveal in Finder',
                icon: Eye,
                disabled: asset.kind !== 'imported' || !asset.assetPath,
                onSelect: () => {
                  void window.videorc?.revealBackgroundAsset?.(asset.id)
                }
              },
              {
                id: 'reset-style',
                label: 'Reset style to defaults',
                icon: ArrowCounterClockwise,
                onSelect: () => onResetStyle(asset.id)
              },
              { id: 'remove', label: 'Remove', icon: Trash, destructive: true, onSelect: onRemove }
            ]}
          />
        </div>
      ) : null}

      <div className="pointer-events-none relative z-10 flex w-full items-center gap-1.5 bg-gradient-to-t from-background/95 via-background/70 to-transparent px-2 pb-1.5 pt-5">
        {renaming && asset ? (
          <Input
            autoFocus
            aria-label={`Rename ${asset.name}`}
            className="pointer-events-auto h-6 px-1.5 text-xs"
            defaultValue={asset.name}
            onBlur={(event) => onRename(asset.id, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur()
              }
              if (event.key === 'Escape') {
                onCancelRename()
              }
            }}
          />
        ) : (
          <>
            <span className="truncate text-xs font-medium">{name}</span>
            {status !== 'ready' && status !== 'active' ? (
              <Badge className="ml-auto shrink-0" variant={badge.variant}>
                {badge.label}
              </Badge>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

// The one place background style is edited (A1): fit + the style sliders act on
// the ACTIVE background, next to their only visible consequence — with the
// preview window one click away for ground truth.
function ActiveBackgroundBar({
  registry,
  onMissing,
  onClear,
  onStyle
}: {
  registry: BackgroundAssetRegistry
  onMissing: (slotId: string) => void
  onClear: () => void
  onStyle: (assetId: string, patch: Parameters<typeof setAssetStyle>[2]) => void
}): ReactElement {
  const { openPreviewWindow } = useStudioCore()
  const activeSlot = registry.slots.find((slot) => slot.id === registry.activeSlotId) ?? null
  const asset = activeSlot ? slotAsset(activeSlot, registry) : null
  const sceneSrc = asset ? imageSrcOf(asset) : undefined
  const missing = activeSlot ? slotDisplayStatus(activeSlot, registry) === 'missing-file' : false
  const style = asset?.styleDefaults
  const defaults = defaultBackgroundStyle()

  return (
    <PanelSection
      title="Active background"
      icon={ImageSquare}
      action={
        activeSlot ? (
          <Button size="sm" variant="outline" onClick={onClear}>
            <X data-icon="inline-start" />
            Remove from scene
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="grid aspect-[16/9] w-28 shrink-0 place-items-center overflow-hidden rounded-row border bg-muted/30">
          {activeSlot && sceneSrc && !missing ? (
            <img
              alt=""
              className="size-full object-cover"
              src={imageUrl(sceneSrc)}
              onError={() => onMissing(activeSlot.id)}
            />
          ) : (
            <ImageSquare className="size-5 text-muted-foreground/40" weight="duotone" />
          )}
        </div>
        <div className="min-w-0 flex-1 text-sm">
          {activeSlot && asset && !missing ? (
            <>
              <p className="truncate font-medium">{slotName(activeSlot, registry)}</p>
              <p className="text-xs text-muted-foreground">
                {FIT_OPTIONS.find((option) => option.value === style?.fit)?.label ?? 'Fill'}
                {typeof style?.visibilityPercent === 'number'
                  ? ` · ${style.visibilityPercent}% visible`
                  : ''}{' '}
                — changes show live in the preview window.
              </p>
            </>
          ) : missing ? (
            <p className="text-xs text-warning">
              The selected background file is missing. Recording continues without a digital
              background.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              No digital background. The recording fills the full canvas.
            </p>
          )}
        </div>
        {activeSlot && asset && !missing && style ? (
          <div className="flex shrink-0 items-center gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline">
                  <SlidersHorizontal data-icon="inline-start" />
                  Adjust style
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="flex w-80 flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label>Fit</Label>
                  <ToggleGroup
                    className="w-full"
                    type="single"
                    value={style.fit}
                    variant="outline"
                    onValueChange={(value) =>
                      value && onStyle(asset.id, { fit: value as BackgroundFit })
                    }
                  >
                    {FIT_OPTIONS.map((option) => (
                      <ToggleGroupItem key={option.value} className="flex-1" value={option.value}>
                        {option.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
                {BACKGROUND_STYLE_FIELDS.map((config) => (
                  <PowerSlider
                    key={config.key}
                    label={config.label}
                    value={style[config.key]}
                    min={config.min}
                    max={config.max}
                    suffix={config.suffix}
                    bipolar={config.bipolar}
                    numericInput
                    defaultValue={defaults[config.key]}
                    onChange={(next) => onStyle(asset.id, { [config.key]: next })}
                  />
                ))}
              </PopoverContent>
            </Popover>
            <Button size="sm" variant="outline" onClick={() => void openPreviewWindow()}>
              <ArrowSquareOut data-icon="inline-start" />
              Open preview
            </Button>
          </div>
        ) : null}
      </div>
    </PanelSection>
  )
}
