import type { Scene } from '@/lib/backend'
import type { TransformCommitResult } from '@/lib/scene-transform-commit'
export type { TransformCommitResult } from '@/lib/scene-transform-commit'
import {
  moveGhost,
  resizeGhost,
  roundRectForCommit,
  type GhostResult,
  type SnapTargets,
  type StageHandleId,
  type StageRect
} from './stage-transform'

export type StageCommit = (sourceId: string, rect: StageRect) => Promise<TransformCommitResult>
export const sameStageRect = (a: StageRect, b: StageRect): boolean =>
  (['x', 'y', 'width', 'height'] as const).every((key) => Math.abs(a[key] - b[key]) < 0.000001)

type Magnet = { target: number; edge: number }
/** Per-axis magnet ownership. Breaking away/releasing Alt rebases the grab offset. */
class SnapAxis {
  private magnet: Magnet | null = null
  private offset = 0
  private released: Magnet | null = null
  private enabled: boolean
  private last: number
  constructor(position: number, enabled: boolean) {
    this.last = position
    this.enabled = enabled
  }
  update(
    raw: number,
    size: number,
    pixels: number,
    targets: number[],
    enabled: boolean
  ): { position: number; target?: number } {
    if (enabled !== this.enabled) {
      this.offset = this.last - raw
      this.released = this.magnet
      this.magnet = null
      this.enabled = enabled
    }
    let position = raw + this.offset
    if (enabled && this.magnet) {
      const fixed = this.magnet.target - this.magnet.edge * size
      if (Math.abs(position - fixed) * pixels <= 9)
        return { position: (this.last = fixed), target: this.magnet.target }
      // Absorb the release distance rather than jumping by the magnet radius.
      this.offset = this.last - raw
      position = this.last
      this.released = this.magnet
      this.magnet = null
      return { position }
    }
    if (enabled) {
      if (
        this.released &&
        Math.abs(position + this.released.edge * size - this.released.target) * pixels > 9
      )
        this.released = null
      let best: { target: number; edge: number; distance: number } | null = null
      for (const target of targets)
        for (const edge of [0, 0.5, 1]) {
          if (this.released?.target === target && this.released.edge === edge) continue
          const distance = Math.abs(position + edge * size - target) * pixels
          if (distance <= 5 && (!best || distance < best.distance))
            best = { target, edge, distance }
        }
      if (best) {
        this.magnet = best
        position = best.target - best.edge * size
      }
    }
    this.last = position
    return { position, target: this.magnet?.target }
  }
}

/** Mutable only for one pointer ownership interval; never stores canonical scene state. */
export class StageGesture {
  rect: StageRect
  private origin: { x: number; y: number }
  private start: StageRect
  private shift = false
  private axis: 'x' | 'y' | null = null
  private snapX: SnapAxis
  private snapY: SnapAxis
  constructor(
    readonly sourceId: string,
    readonly pointerId: number,
    readonly kind: 'move' | StageHandleId,
    start: StageRect,
    point: { x: number; y: number },
    readonly pixels: { width: number; height: number },
    private targets: SnapTargets,
    private snap: boolean,
    private locked: boolean,
    private forced: boolean
  ) {
    this.start = this.rect = { ...start }
    this.origin = point
    this.snapX = new SnapAxis(start.x, snap)
    this.snapY = new SnapAxis(start.y, snap)
  }
  sample(
    point: { x: number; y: number },
    modifiers: { shiftKey: boolean; altKey: boolean }
  ): GhostResult {
    if (modifiers.shiftKey !== this.shift) {
      this.start = { ...this.rect }
      this.origin = point
      this.axis = null
      this.snapX = new SnapAxis(this.rect.x, this.snap && !modifiers.altKey)
      this.snapY = new SnapAxis(this.rect.y, this.snap && !modifiers.altKey)
      this.shift = modifiers.shiftKey
    }
    let dx = point.x - this.origin.x
    let dy = point.y - this.origin.y
    let result: GhostResult
    if (this.kind === 'move') {
      if (this.shift) {
        if (!this.axis && Math.hypot(dx * this.pixels.width, dy * this.pixels.height) >= 3)
          this.axis =
            Math.abs(dx * this.pixels.width) >= Math.abs(dy * this.pixels.height) ? 'x' : 'y'
        if (this.axis !== 'x') dx = 0
        if (this.axis !== 'y') dy = 0
      }
      const raw = moveGhost({
        start: this.start,
        dx,
        dy,
        constrainAxis: false,
        disableSnap: true,
        targets: this.targets
      }).rect
      const x = this.snapX.update(
        raw.x,
        raw.width,
        this.pixels.width,
        this.targets.x,
        this.snap && !modifiers.altKey
      )
      const y = this.snapY.update(
        raw.y,
        raw.height,
        this.pixels.height,
        this.targets.y,
        this.snap && !modifiers.altKey
      )
      result = moveGhost({
        start: raw,
        dx: x.position - raw.x,
        dy: y.position - raw.y,
        constrainAxis: false,
        disableSnap: true,
        targets: this.targets
      })
      if (x.target !== undefined && result.rect.x === x.position)
        result.guides.push({ axis: 'x', position: x.target })
      if (y.target !== undefined && result.rect.y === y.position)
        result.guides.push({ axis: 'y', position: y.target })
    } else
      result = resizeGhost({
        start: this.start,
        handle: this.kind,
        dx,
        dy,
        lockAspect: this.forced || (this.shift ? !this.locked : this.locked),
        canvasWidth: this.pixels.width,
        canvasHeight: this.pixels.height
      })
    this.rect = result.rect
    return result
  }
}

export interface StageDraft {
  sourceId: string
  rect: StageRect
  generation: number
}
/** Serialize released gestures and retain presentation until canonical props catch up. */
export class StageEdits {
  draft: StageDraft | null = null
  private generation = 0
  private epoch = 0
  private tail: Promise<void> = Promise.resolve()
  private acknowledged: { generation: number; scene: Scene } | null = null
  private canonical: Scene | null = null
  constructor(
    private commit: StageCommit,
    private changed: () => void,
    private failed: () => void
  ) {}
  configure(commit: StageCommit): void {
    this.commit = commit
  }
  observe(scene: Scene | null): void {
    this.canonical = scene
    const ack = this.acknowledged
    const draft = this.draft
    if (
      ack &&
      draft &&
      ack.generation === draft.generation &&
      scene?.id === ack.scene.id &&
      scene.sources.some(
        (source) => source.id === draft.sourceId && sameStageRect(source.transform, draft.rect)
      )
    ) {
      this.draft = null
      this.acknowledged = null
      this.changed()
    }
  }
  invalidate(): void {
    this.epoch++
    this.draft = null
    this.acknowledged = null
    this.changed()
  }
  submit(sourceId: string, rect: StageRect): void {
    const draft = { sourceId, rect: roundRectForCommit(rect), generation: ++this.generation }
    const epoch = this.epoch
    const commit = this.commit
    const sceneId = this.canonical?.id
    this.draft = draft
    this.changed()
    this.tail = this.tail.then(async () => {
      if (epoch !== this.epoch) return
      let result: TransformCommitResult
      try {
        result = await commit(sourceId, draft.rect)
      } catch {
        result = { ok: false }
      }
      if (epoch !== this.epoch) return
      if (
        !result.ok ||
        !result.status.applied ||
        (sceneId !== undefined && result.status.scene.id !== sceneId) ||
        !result.status.scene.sources.some((source) => source.id === sourceId)
      ) {
        this.invalidate()
        this.failed()
        return
      }
      this.acknowledged = { generation: draft.generation, scene: result.status.scene }
      if (this.draft?.generation === draft.generation) {
        const source = result.status.scene.sources.find((source) => source.id === sourceId)!
        this.draft = { ...draft, rect: source.transform }
      }
      this.observe(this.canonical)
      this.changed()
    })
  }
}

/** Drop edge handles before corners; a tiny source has one unambiguous target. */
export function visibleStageHandles(width: number, height: number): StageHandleId[] {
  if (width < 24 || height < 24) return ['se']
  if (width < 48 || height < 48) return ['nw', 'ne', 'se', 'sw']
  return ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
}

/** A tiny source must retain a body hit target separate from its resize target. */
export function stageHandleOffset(width: number, height: number): number {
  return width < 24 || height < 24 ? 12 : 0
}
