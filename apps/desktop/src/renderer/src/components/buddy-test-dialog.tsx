import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'

import type { BuddyPetPreviewHandle, BuddyPetPreviewInfo } from '@/components/buddy-pet-preview'
import { LazyBuddyPetPreview } from '@/components/buddy-pet-preview-lazy'
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
import { renderBuddyBubblePng } from '@/lib/buddy-overlay'
import { buddyReactionLabel } from '@/lib/buddy-pet-view'
import {
  BUDDY_TEST_BUBBLE_CANVAS,
  BUDDY_TEST_BUBBLE_LINE,
  BUDDY_TEST_STATES,
  buddyTestBubbleBox,
  buddyTestReactions,
  buddyTestStateForKey,
  buddyTestStatePlan,
  type BuddyTestState
} from '@/lib/buddy-test-view'
import { DEFAULT_OVERLAY_LAYOUT } from '@/lib/overlay-layout'
import { cn } from '@/lib/utils'
import type { BuddyMotionSettings } from '../../../shared/buddy-pet'

/** The Buddy on the stage: big, about the zoom dialog's size. */
export const BUDDY_TEST_PREVIEW_PX = 320
/** The bubble keeps its proportions at the Buddy's default placement (the bubble sample's rule). */
const BUBBLE_RECT = DEFAULT_OVERLAY_LAYOUT.buddy.horizontal

export interface BuddyTestDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  persona: Pick<CohostPersona, 'id' | 'name' | 'images' | 'bubbleStyle'>
  /** What the Avatar section's preview plays: `still` or a pack id. */
  packId: string
  motion: BuddyMotionSettings
}

interface BubbleRaster {
  src: string
  width: number
  height: number
}

/**
 * Test your Buddy (plan 169 D14, narrowed by the owner on 2026-10-09): the
 * living preview big on a neutral stage, a States row that holds each state
 * as the stream shows it (1 to 4), a Reactions row with every reaction the
 * pack has plus Hop, and the comic bubble with a sample line while Talking.
 * A sandbox: it plays in this window only and never calls the backend, the
 * stream, chat or the settings. Its own chunk: the Avatar section loads it
 * on first open.
 */
export function BuddyTestDialog({
  open,
  onOpenChange,
  persona,
  packId,
  motion
}: BuddyTestDialogProps): ReactElement {
  const previewRef = useRef<BuddyPetPreviewHandle>(null)
  const statesRef = useRef<HTMLDivElement>(null)
  const [info, setInfo] = useState<BuddyPetPreviewInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  // `nonce` replays a state picked again (Laughing laughs once more).
  const [selection, setSelection] = useState<{ state: BuddyTestState; nonce: number }>({
    state: 'idle',
    nonce: 0
  })
  const [showBubble, setShowBubble] = useState(true)
  const [bubbleSrc, setBubbleSrc] = useState<string | null>(null)
  const [bubble, setBubble] = useState<BubbleRaster | null>(null)
  const pack = info?.packId === packId ? info : null
  const plan = buddyTestStatePlan(selection.state, pack)
  const pick = (state: BuddyTestState): void =>
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
    renderBuddyBubblePng({
      bubble: BUDDY_TEST_BUBBLE_LINE,
      style,
      canvas: BUDDY_TEST_BUBBLE_CANVAS,
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
    const state = buddyTestStateForKey(event.key)
    if (!state) return
    event.preventDefault()
    pick(state)
    // Focus on the States row follows the pick, so its ring marks the state shown.
    const states = statesRef.current
    if (states?.contains(document.activeElement)) {
      states.querySelector<HTMLElement>(`[data-buddy-state="${state}"]`)?.focus()
    }
  }

  const bubbleShown = showBubble && selection.state === 'talk' && pack !== null
  const bubbleBox =
    bubble && bubble.src === bubbleSrc && pack
      ? buddyTestBubbleBox({
          raster: bubble,
          rect: BUBBLE_RECT,
          previewPx: BUDDY_TEST_PREVIEW_PX,
          headTop: pack.headTop
        })
      : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl"
        data-testid="buddy-test-dialog"
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
          data-buddy-state={selection.state}
          data-testid="buddy-test-stage"
        >
          <div
            className="relative"
            style={{ width: BUDDY_TEST_PREVIEW_PX, height: BUDDY_TEST_PREVIEW_PX }}
          >
            <LazyBuddyPetPreview
              ref={previewRef}
              interactive={false}
              label={persona.name}
              motion={motion}
              packId={packId}
              personaId={persona.id}
              placeholder={<Skeleton className="size-full rounded-row" />}
              pose={plan.pose}
              size={BUDDY_TEST_PREVIEW_PX}
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
                data-testid="buddy-test-bubble"
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
              data-testid="buddy-test-error"
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
              const state = BUDDY_TEST_STATES.find((candidate) => candidate.id === next)?.id
              if (state) pick(state)
            }}
          >
            <TabsList
              ref={statesRef}
              aria-label="State"
              className="w-full"
              data-testid="buddy-test-states"
            >
              {BUDDY_TEST_STATES.map((state) => (
                <TabsTrigger
                  key={state.id}
                  className="flex-1 gap-2"
                  data-buddy-state={state.id}
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
          <p className="min-h-4 text-xs text-subtle" data-testid="buddy-test-note">
            {plan.note}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-[11px] font-semibold text-subtle">Reactions</h3>
          {pack ? (
            <div className="flex flex-wrap gap-1.5" data-testid="buddy-test-reactions">
              {buddyTestReactions(pack.reactions).map((id) => (
                <Button
                  key={id}
                  data-reaction={id}
                  data-testid="buddy-test-reaction"
                  size="xs"
                  type="button"
                  variant="outline"
                  onClick={() => previewRef.current?.react(id)}
                >
                  {buddyReactionLabel(id)}
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
            data-testid="buddy-test-bubble-switch"
            size="sm"
            onCheckedChange={setShowBubble}
          />
          Show the bubble while Talking
        </label>
      </DialogContent>
    </Dialog>
  )
}

export default BuddyTestDialog
