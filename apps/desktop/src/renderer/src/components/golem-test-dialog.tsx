import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'

import type { GolemPetPreviewHandle, GolemPetPreviewInfo } from '@/components/golem-pet-preview'
import { LazyGolemPetPreview } from '@/components/golem-pet-preview-lazy'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { CohostPersona } from '@/lib/backend'
import { renderGolemBubblePng } from '@/lib/golem-overlay'
import { golemReactionLabel } from '@/lib/golem-pet-view'
import {
  GOLEM_TEST_BUBBLE_CANVAS,
  GOLEM_TEST_BUBBLE_LINE,
  GOLEM_TEST_STATES,
  golemTestBubbleBox,
  golemTestReactions,
  golemTestStateForKey,
  golemTestStatePlan,
  type GolemTestState
} from '@/lib/golem-test-view'
import { DEFAULT_OVERLAY_LAYOUT } from '@/lib/overlay-layout'
import { cn } from '@/lib/utils'
import type { GolemMotionSettings } from '../../../shared/golem-pet'

/** The Golem on the stage: big, about the zoom dialog's size. */
export const GOLEM_TEST_PREVIEW_PX = 320
/** The bubble keeps its proportions at the Golem's default placement (the bubble sample's rule). */
const BUBBLE_RECT = DEFAULT_OVERLAY_LAYOUT.golem.horizontal

export interface GolemTestDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  persona: Pick<CohostPersona, 'id' | 'name' | 'images' | 'bubbleStyle'>
  /** What the Avatar section's preview plays: `still` or a pack id. */
  packId: string
  motion: GolemMotionSettings
}

interface BubbleRaster {
  src: string
  width: number
  height: number
}

/**
 * Test your Golem (plan 169 D14, narrowed by the owner on 2026-10-09): the
 * living preview big on a neutral stage, a States row that holds each state
 * as the stream shows it (1 to 4), a Reactions row with every reaction the
 * pack has plus Hop, and the comic bubble with a sample line while Talking.
 * A sandbox: it plays in this window only and never calls the backend, the
 * stream, chat or the settings. Its own chunk: the Avatar section loads it
 * on first open.
 */
export function GolemTestDialog({
  open,
  onOpenChange,
  persona,
  packId,
  motion
}: GolemTestDialogProps): ReactElement {
  const previewRef = useRef<GolemPetPreviewHandle>(null)
  const statesRef = useRef<HTMLDivElement>(null)
  const [info, setInfo] = useState<GolemPetPreviewInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  // `nonce` replays a state picked again (Laughing laughs once more).
  const [selection, setSelection] = useState<{ state: GolemTestState; nonce: number }>({
    state: 'idle',
    nonce: 0
  })
  const [showBubble, setShowBubble] = useState(true)
  const [bubbleSrc, setBubbleSrc] = useState<string | null>(null)
  const [bubble, setBubble] = useState<BubbleRaster | null>(null)
  const pack = info?.packId === packId ? info : null
  const plan = golemTestStatePlan(selection.state, pack)
  const pick = (state: GolemTestState): void =>
    setSelection((current) => ({ state, nonce: current.nonce + 1 }))

  // A state's own reaction (Laughing's laugh) plays over the hold. The
  // preview's pose effect runs first: a child's effects run before its
  // parent's, so the reaction lands on the held frame and returns to it.
  const stateReaction = plan.react
  useEffect(() => {
    if (stateReaction) previewRef.current?.react(stateReaction)
  }, [selection, stateReaction])

  // The sample bubble, drawn once by the stream's rasterizer.
  const style = persona.bubbleStyle
  useEffect(() => {
    if (!open || !showBubble) return
    let cancelled = false
    renderGolemBubblePng({
      bubble: GOLEM_TEST_BUBBLE_LINE,
      style,
      canvas: GOLEM_TEST_BUBBLE_CANVAS,
      rect: BUBBLE_RECT
    }).then(
      (png) => {
        if (!cancelled) setBubbleSrc(png ? `data:image/png;base64,${png}` : null)
      },
      () => {
        if (!cancelled) setBubbleSrc(null)
      }
    )
    return () => {
      cancelled = true
    }
  }, [open, showBubble, style])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const state = golemTestStateForKey(event.key)
    if (!state) return
    event.preventDefault()
    pick(state)
    // Focus on the States row follows the pick, so its ring marks the state shown.
    const states = statesRef.current
    if (states?.contains(document.activeElement)) {
      states.querySelector<HTMLElement>(`[data-golem-state="${state}"]`)?.focus()
    }
  }

  const bubbleShown = showBubble && selection.state === 'talk' && pack !== null
  const bubbleBox =
    bubble && bubble.src === bubbleSrc && pack
      ? golemTestBubbleBox({
          raster: bubble,
          rect: BUBBLE_RECT,
          previewPx: GOLEM_TEST_PREVIEW_PX,
          headTop: pack.headTop
        })
      : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl"
        data-testid="golem-test-dialog"
        onKeyDown={onKeyDown}
      >
        <DialogHeader>
          <DialogTitle>Test {persona.name}</DialogTitle>
          <DialogDescription>
            Each state as viewers see it. Nothing here reaches your stream or chat.
          </DialogDescription>
        </DialogHeader>

        <div
          className="relative flex h-[420px] items-end justify-center overflow-hidden rounded-row border border-border bg-foreground/[0.03] pb-6"
          data-golem-state={selection.state}
          data-testid="golem-test-stage"
        >
          <div
            className="relative"
            style={{ width: GOLEM_TEST_PREVIEW_PX, height: GOLEM_TEST_PREVIEW_PX }}
          >
            <LazyGolemPetPreview
              ref={previewRef}
              interactive={false}
              label={persona.name}
              motion={motion}
              packId={packId}
              personaId={persona.id}
              placeholder={<Skeleton className="size-full rounded-row" />}
              pose={plan.pose}
              size={GOLEM_TEST_PREVIEW_PX}
              stillImages={persona.images}
              talking={plan.talking}
              onError={setError}
              onLoad={(next) => {
                setError(null)
                setInfo(next)
              }}
            />
            {bubbleSrc ? (
              // The stream's own bubble bitmap; its tail tip sits on the head.
              <img
                alt=""
                aria-hidden
                className={cn(
                  'pointer-events-none absolute max-w-none select-none',
                  (!bubbleShown || !bubbleBox) && 'hidden'
                )}
                data-testid="golem-test-bubble"
                draggable={false}
                src={bubbleSrc}
                style={bubbleBox ?? undefined}
                onLoad={(event) =>
                  setBubble({
                    src: event.currentTarget.getAttribute('src') ?? '',
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight
                  })
                }
              />
            ) : null}
          </div>
          {error ? (
            <p
              className="absolute inset-x-4 bottom-2 text-center text-xs text-destructive"
              data-testid="golem-test-error"
            >
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-[11px] font-semibold text-subtle">States</h3>
          {/* The glass segmented control (design skill: Tabs), without panels. */}
          <Tabs
            value={selection.state}
            onValueChange={(next) => {
              const state = GOLEM_TEST_STATES.find((candidate) => candidate.id === next)?.id
              if (state) pick(state)
            }}
          >
            <TabsList
              ref={statesRef}
              aria-label="State"
              className="w-full"
              data-testid="golem-test-states"
            >
              {GOLEM_TEST_STATES.map((state) => (
                <TabsTrigger
                  key={state.id}
                  className="flex-1 gap-2"
                  data-golem-state={state.id}
                  value={state.id}
                  onMouseDown={() => {
                    // Picking the shown state again replays it (Laughing laughs again).
                    if (selection.state === state.id) pick(state.id)
                  }}
                >
                  {state.label}
                  <Kbd>{state.key}</Kbd>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {/* One line kept for the note, so the dialog never jumps as states change. */}
          <p className="min-h-4 text-xs text-subtle" data-testid="golem-test-note">
            {plan.note}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-[11px] font-semibold text-subtle">Reactions</h3>
          {pack ? (
            <div className="flex flex-wrap gap-1.5" data-testid="golem-test-reactions">
              {golemTestReactions(pack.reactions).map((id) => (
                <Button
                  key={id}
                  data-reaction={id}
                  data-testid="golem-test-reaction"
                  size="xs"
                  type="button"
                  variant="outline"
                  onClick={() => previewRef.current?.react(id)}
                >
                  {golemReactionLabel(id)}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-subtle" role="status">
              Loading {persona.name}…
            </p>
          )}
        </div>

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={showBubble}
            data-testid="golem-test-bubble-switch"
            size="sm"
            onCheckedChange={setShowBubble}
          />
          Show the bubble while Talking
        </label>
      </DialogContent>
    </Dialog>
  )
}

export default GolemTestDialog
