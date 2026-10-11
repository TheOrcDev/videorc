import { useStudioCore } from '@/hooks/use-studio'
import {
  AdjustIcon,
  DeleteIcon,
  EditIcon,
  FolderIcon,
  ImageIcon,
  ResetIcon,
  SyncIcon,
  UploadIcon,
  WarningIcon
} from '@/components/icons'
import { useState, type ComponentProps, type ReactElement } from 'react'
import { toastUserError } from '@/lib/user-error'

import { KebabMenu } from '@/components/kebab-menu'
import { Gallery, PageHeader, PageStack } from '@/components/page'
import { PanelSection } from '@/components/panel-section'
import { PowerSlider } from '@/components/power-slider'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { useBackgroundAssets } from '@/hooks/use-background-assets'
import {
  BACKGROUND_STYLE_FIELDS,
  createImportedAsset,
  defaultBackgroundStyle,
  importIntoSlot,
  backgroundAssetDisplayUrl,
  markSlotMissingIfAssetMatches,
  markSlotStatus,
  removeSlotAsset,
  removeSlotNeedsConfirm,
  restoreSlotDefault,
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
  backgroundImportTarget
} from '@/lib/background-assets'
import {
  BackgroundReplaceDialog,
  type PendingBackgroundReplace
} from '@/components/background-replace-dialog'
import {
  IN_USE_RING,
  InUseChip,
  TakeoverScreensSection
} from '@/components/takeover-screens-section'
import { plural } from '@/lib/format'
import { revealInFileManagerLabel } from '@/lib/platform'
import { cn } from '@/lib/utils'

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>['variant']>

const STATUS_BADGE: Record<BackgroundAssetSlotStatus, { label: string; variant: BadgeVariant }> = {
  empty: { label: 'Empty', variant: 'outline' },
  ready: { label: 'Ready', variant: 'secondary' },
  active: { label: 'In use', variant: 'secondary' },
  'missing-file': { label: 'File missing', variant: 'warning' },
  unsupported: { label: 'Unsupported', variant: 'destructive' }
}

const FIT_OPTIONS: SegmentedControlOption<BackgroundFit>[] = [
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
// style controls sit on the active tile (Adjust style), where they edit the one
// background that has a visible consequence.
export function AssetsTab(): ReactElement {
  const { applyBackgroundSlot, applyWorkingBackgroundStyle, runtimeInfo, scene } = useStudioCore()
  const { registry, setRegistry } = useBackgroundAssets()
  const [removingSlotId, setRemovingSlotId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [pendingReplace, setPendingReplace] = useState<PendingBackgroundReplace | null>(null)
  const [renamingSlotId, setRenamingSlotId] = useState<string | null>(null)
  // What the remove question is about: the slot on stage, or an imported file.
  const removingSlot = registry.slots.find((entry) => entry.id === removingSlotId) ?? null
  const removingAsset = removingSlot ? slotAsset(removingSlot, registry) : null
  const removingApplied =
    removingSlot !== null &&
    (registry.activeSlotId === removingSlot.id ||
      scene?.background?.assetId === removingSlot.assetId)

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
      console.warn('[assets] no image import in this renderer')
      return
    }
    // Plan 174 (C-2, D14): with every slot in use, which is every fresh
    // profile, the picked image waits for "Replace which background?".
    const target = explicitSlotId
      ? ({ kind: 'slot', slotId: explicitSlotId } as const)
      : backgroundImportTarget(registry)
    if (!target) return

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
      if (target.kind === 'replace') {
        setPendingReplace({ asset, preselectedSlotId: target.preselectedSlotId })
        return
      }
      // The new tile is the confirmation (plan 174 S2.4, J2-11).
      setRegistry((current) => importIntoSlot(current, target.slotId, asset))
    } catch (error) {
      toastUserError(error, { action: 'import', object: 'the image' }, { id: 'background-import' })
    } finally {
      setImporting(false)
    }
  }

  const replaceWithImport = (slotId: string, asset: BackgroundAsset): void => {
    setRegistry((current) => importIntoSlot(current, slotId, asset))
    setPendingReplace(null)
  }

  // The scene's own background, which may come from a saved scene rather
  // than a slot: its row sits inside Backgrounds (C-26).
  const sceneBackground = scene?.background ?? null
  const sceneBackgroundName = sceneBackground
    ? (registry.assets[sceneBackground.assetId]?.name ?? 'A background from a saved scene')
    : null

  return (
    <PageStack>
      <PageHeader
        description="Backgrounds for your scenes and takeovers for the output. Click a background to apply it, then tune it with Adjust style on its tile."
        title="Assets"
      />

      <PanelSection
        title="Backgrounds"
        icon={ImageIcon}
        description={`${plural(registry.slots.length, 'background')} · PNG, JPEG or WebP.`}
        action={
          <Button disabled={importing} size="sm" variant="outline" onClick={() => importInto(null)}>
            <ImageIcon data-icon="inline-start" />
            {importing ? 'Importing…' : 'Import image…'}
          </Button>
        }
      >
        {sceneBackground && sceneBackgroundName ? (
          <div className="flex min-w-0 items-center gap-2" data-videorc-scene-background="">
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              In this scene: <span className="text-foreground">{sceneBackgroundName}</span>
            </span>
            <BackgroundStylePopover
              name={sceneBackgroundName}
              asset={{
                id: sceneBackground.assetId,
                name: sceneBackgroundName,
                kind: 'imported',
                status: 'ready',
                createdAt: '',
                updatedAt: '',
                styleDefaults: sceneBackground
              }}
              onStyle={(_id, patch) => applyWorkingBackgroundStyle(patch)}
            />
            <Button variant="ghost" size="sm" onClick={() => applyBackgroundSlot(null)}>
              Use no background
            </Button>
          </div>
        ) : null}
        <Gallery className="gap-3">
          {registry.slots.map((slot) => (
            <PresetTile
              key={slot.id}
              slot={slot}
              registry={registry}
              importing={importing}
              platform={runtimeInfo?.platform}
              renaming={renamingSlotId === slot.id}
              onActivate={() => {
                const status = slotDisplayStatus(slot, registry)
                if (status === 'empty') {
                  void importInto(slot.id)
                  return
                }
                // Clicking the ACTIVE background removes it — the tile is a
                // toggle, matching its aria-pressed semantics (owner request,
                // 2026-08-19).
                if (status === 'active') {
                  applyBackgroundSlot(null)
                  return
                }
                applyBackgroundSlot(slot.id)
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
              onRemove={() => {
                // An applied background leaves the scene, and an imported one
                // loses its file (plan 174 C-12): both ask first. Emptying a
                // built-in slot is reversible (Restore default), so it just
                // happens.
                if (removeSlotNeedsConfirm(registry, slot.id, scene?.background?.assetId))
                  setRemovingSlotId(slot.id)
                else setRegistry((current) => removeSlotAsset(current, slot.id))
              }}
              onRestore={() => setRegistry((current) => restoreSlotDefault(current, slot.id))}
              onStyle={(assetId, patch) =>
                setRegistry((current) => setAssetStyle(current, assetId, patch))
              }
            />
          ))}
        </Gallery>
      </PanelSection>

      <ConfirmDialog
        confirmLabel="Remove background"
        description={
          removingApplied
            ? 'This empties the library slot and removes the background from the current scene, including a running recording or stream. Saved scenes keep their copy.'
            : 'The imported image is deleted from this computer. The slot stays empty until you restore its built-in background or import another.'
        }
        open={removingSlotId !== null}
        testId="background-remove"
        title={
          removingApplied
            ? 'Remove applied background?'
            : `Remove ${removingAsset?.name ?? 'this background'}?`
        }
        onCancel={() => setRemovingSlotId(null)}
        onConfirm={() => {
          if (removingSlotId) {
            const slot = registry.slots.find((entry) => entry.id === removingSlotId)
            if (
              slot?.assetId === scene?.background?.assetId &&
              registry.activeSlotId !== removingSlotId
            )
              applyBackgroundSlot(null)
            setRegistry((current) => removeSlotAsset(current, removingSlotId))
          }
          setRemovingSlotId(null)
        }}
      />
      <TakeoverScreensSection />
      <BackgroundReplaceDialog
        pending={pendingReplace}
        registry={registry}
        onCancel={() => setPendingReplace(null)}
        onReplace={replaceWithImport}
      />
    </PageStack>
  )
}

function PresetTile({
  slot,
  registry,
  importing,
  platform,
  renaming,
  onActivate,
  onMissing,
  onStartRename,
  onRename,
  onCancelRename,
  onReplace,
  onResetStyle,
  onRemove,
  onRestore,
  onStyle
}: {
  slot: BackgroundAssetSlot
  registry: BackgroundAssetRegistry
  importing: boolean
  platform?: string
  renaming: boolean
  onActivate: () => void
  onMissing: () => void
  onStartRename: () => void
  onRename: (assetId: string, name: string) => void
  onCancelRename: () => void
  onReplace: () => void
  onResetStyle: (assetId: string) => void
  onRemove: () => void
  onRestore: () => void
  onStyle: (assetId: string, patch: Parameters<typeof setAssetStyle>[2]) => void
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
        // `group/kebab-host`: the ⋯ menu shows on hover and while the tile
        // holds focus (C-11).
        'group/kebab-host relative flex aspect-video items-end overflow-hidden rounded-row border transition-colors',
        active
          ? cn('border-foreground/25', IN_USE_RING)
          : 'border-border hover:border-foreground/30'
      )}
      data-videorc-background-tile={slot.id}
    >
      <button
        type="button"
        aria-pressed={active}
        aria-label={
          status === 'empty'
            ? `Import into ${name}`
            : active
              ? `Remove ${name} from the scene`
              : `Apply ${name} to the scene`
        }
        // The tile clips its children, so the focus ring is drawn inset, on
        // top of the image (C-11).
        className="absolute inset-0 outline-none after:pointer-events-none after:absolute after:inset-0 after:rounded-row focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
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
              <WarningIcon className="size-6 text-warning" weight="duotone" />
            ) : status === 'empty' ? (
              <UploadIcon className="size-6 text-muted-foreground/40" weight="duotone" />
            ) : (
              <ImageIcon className="size-6 text-muted-foreground/40" weight="duotone" />
            )}
          </span>
        )}
      </button>

      {active ? <InUseChip className="pointer-events-none absolute top-1.5 left-1.5 z-10" /> : null}

      {!asset ? (
        <div className="absolute top-1 right-1 z-10 flex gap-1">
          <Button size="sm" variant="ghost" onClick={onReplace}>
            Add image…
          </Button>
          <Button size="sm" variant="ghost" onClick={onRestore}>
            Restore default
          </Button>
        </div>
      ) : null}

      {/* The name strip carries the tile's controls, so they never float on
          the picture with their own glass (C-40). */}
      <div className="pointer-events-none relative z-10 flex w-full items-center gap-1 bg-gradient-to-t from-background/95 via-background/70 to-transparent px-2 pt-5 pb-1">
        {renaming && asset ? (
          <Input
            autoFocus
            aria-label={`Rename ${asset.name}`}
            className="pointer-events-auto"
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
            <span className="min-w-0 truncate text-xs font-medium">{name}</span>
            {status !== 'ready' && status !== 'active' ? (
              <Badge className="ml-auto shrink-0" variant={badge.variant}>
                {badge.label}
              </Badge>
            ) : null}
            {asset ? (
              <span className="pointer-events-auto ml-auto flex shrink-0 items-center">
                {/* The active tile keeps its style control in view: it is
                    the only home for fit and the style sliders. */}
                {active ? (
                  <BackgroundStylePopover asset={asset} name={name} onStyle={onStyle} />
                ) : null}
                <KebabMenu
                  label={`Actions for ${name}`}
                  reveal={active ? 'always' : 'hover'}
                  items={[
                    { id: 'rename', label: 'Rename', icon: EditIcon, onSelect: onStartRename },
                    {
                      id: 'replace',
                      label: 'Replace image…',
                      icon: SyncIcon,
                      disabled: importing,
                      onSelect: onReplace
                    },
                    {
                      id: 'reveal',
                      label: revealInFileManagerLabel(platform),
                      icon: FolderIcon,
                      disabled: asset.kind !== 'imported' || !asset.assetPath,
                      onSelect: () => {
                        void window.videorc?.revealBackgroundAsset?.(asset.id)
                      }
                    },
                    {
                      id: 'reset-style',
                      label: 'Reset style to defaults',
                      icon: ResetIcon,
                      onSelect: () => onResetStyle(asset.id)
                    },
                    {
                      id: 'remove',
                      label: 'Remove',
                      icon: DeleteIcon,
                      destructive: true,
                      onSelect: onRemove
                    }
                  ]}
                />
              </span>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

// The one place background style is edited (A1): fit + the style sliders act on
// the ACTIVE background, from its own tile. Changes show live in the preview.
function BackgroundStylePopover({
  asset,
  name,
  onStyle
}: {
  asset: BackgroundAsset
  name: string
  onStyle: (assetId: string, patch: Parameters<typeof setAssetStyle>[2]) => void
}): ReactElement {
  const style = asset.styleDefaults
  const defaults = defaultBackgroundStyle()

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button aria-label={`Adjust style for ${name}`} size="icon-sm" variant="ghost">
              <AdjustIcon />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Adjust style</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="flex w-80 flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>Fit</Label>
          <SegmentedControl
            aria-label="Fit"
            className="w-full"
            options={FIT_OPTIONS}
            value={style.fit}
            onValueChange={(fit) => onStyle(asset.id, { fit })}
          />
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
  )
}
