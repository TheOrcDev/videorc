import type { CloudStageLayout } from '@/lib/backend'

// The talk-show geometry (plan 224 D8), mirrored from the runner's
// `talk_show_layout.rs` so the Show stage draws the picture the cloud sends.
// `protocol-fixtures/talk-show-layout.json` is the runner's own fixture, and
// the test holds this module to it case by case.
//
// Rules: tiles are 16:9 and fitted inside their cell, centred; every rect has
// even coordinates and sizes; nothing overlaps and nothing leaves the canvas.
// The gutter and the corner radius scale with the canvas (24 px and 20 px at
// 1080 lines). A name plate's box runs along its tile's bottom edge; the stage
// draws a pill as wide as the name inside it. Pure: no DOM, no React.

export type StageCanvas = { width: number; height: number }
export type StageRect = { x: number; y: number; w: number; h: number }
export type StageTileKind = 'person' | 'screen'

export type StageTile = {
  identity: string
  kind: StageTileKind
  rect: StageRect
  /** None on a screen tile and on a full-frame solo tile. */
  plate?: StageRect
  /** 0 on a full-frame tile. */
  cornerRadius: number
}

export type StagePlan = { tiles: StageTile[] }

export type StageInput = {
  layout: CloudStageLayout
  /** The on-stage identities, in order. */
  people: readonly string[]
  spotlight?: string | null
  /** The identity whose screen is shared, when one is. */
  screen?: string | null
}

const even = (value: number): number => Math.floor(value) & ~1
const shortSide = (canvas: StageCanvas): number => Math.min(canvas.width, canvas.height)

/** The gap between tiles and from the canvas edge: 24 px at 1080 lines. */
export function stageGutter(canvas: StageCanvas): number {
  return Math.max(4, even(Math.round((shortSide(canvas) * 24) / 1080)))
}

/** Tile corner radius: 20 px at 1080 lines. */
export function stageCornerRadius(canvas: StageCanvas): number {
  return Math.round((shortSide(canvas) * 20) / 1080)
}

/** A name plate's height: 44 px at 1080 lines. */
export function stagePlateHeight(canvas: StageCanvas): number {
  return Math.max(12, even(Math.round((shortSide(canvas) * 44) / 1080)))
}

const right = (rect: StageRect): number => rect.x + rect.w
const bottom = (rect: StageRect): number => rect.y + rect.h

/** The largest 16:9 rect that fits `cell`, centred in it, even-sized. */
function fit16x9(cell: StageRect): StageRect {
  const [rawW, rawH] =
    cell.w * 9 <= cell.h * 16
      ? [cell.w, Math.floor((cell.w * 9) / 16)]
      : [Math.floor((cell.h * 16) / 9), cell.h]
  const w = even(rawW)
  const h = even(rawH)
  return {
    x: even(cell.x + Math.floor((cell.w - w) / 2)),
    y: even(cell.y + Math.floor((cell.h - h) / 2)),
    w,
    h
  }
}

/**
 * A grid of `count` equal cells in `area`, `cols` wide, rows filled top to
 * bottom, the last row centred when it is short.
 */
function gridCells(
  area: StageRect,
  count: number,
  colsWanted: number,
  gutter: number
): StageRect[] {
  const cols = Math.min(Math.max(colsWanted, 1), Math.max(count, 1))
  const rows = Math.max(Math.ceil(count / cols), 1)
  const cellW = Math.floor(Math.max(0, area.w - gutter * (cols - 1)) / cols)
  const cellH = Math.floor(Math.max(0, area.h - gutter * (rows - 1)) / rows)
  const cells: StageRect[] = []
  for (let index = 0; index < count; index += 1) {
    const row = Math.floor(index / cols)
    const inRow = row === rows - 1 ? count - row * cols : cols
    const col = index % cols
    const rowW = inRow * cellW + gutter * (inRow - 1)
    const x0 = area.x + Math.floor((area.w - rowW) / 2)
    cells.push({
      x: x0 + col * (cellW + gutter),
      y: area.y + row * (cellH + gutter),
      w: cellW,
      h: cellH
    })
  }
  return cells
}

function plateFor(canvas: StageCanvas, tile: StageRect): StageRect | undefined {
  const inset = Math.floor(stageGutter(canvas) / 2)
  const h = stagePlateHeight(canvas)
  if (tile.h < h + 2 * inset + 8 || tile.w < 4 * inset) return undefined
  return {
    x: tile.x + inset,
    y: even(bottom(tile) - inset - h),
    w: even(tile.w - 2 * inset),
    h
  }
}

function person(canvas: StageCanvas, identity: string, rect: StageRect): StageTile {
  const plate = plateFor(canvas, rect)
  return {
    identity,
    kind: 'person',
    rect,
    ...(plate ? { plate } : {}),
    cornerRadius: stageCornerRadius(canvas)
  }
}

function insetArea(canvas: StageCanvas): StageRect {
  const g = stageGutter(canvas)
  return { x: g, y: g, w: canvas.width - 2 * g, h: canvas.height - 2 * g }
}

/** Columns for a side-by-side grid of `n` people. */
function gridCols(n: number, portrait: boolean): number {
  if (n <= 1) return 1
  if (!portrait) {
    if (n <= 3) return n
    if (n === 4) return 2
    return 3
  }
  return n <= 3 ? 1 : 2
}

/** The layout the runner actually draws for this input (its fallbacks). */
export function effectiveStageLayout(input: StageInput): CloudStageLayout {
  const people = input.people.filter((identity) => identity.length > 0)
  if (input.layout === 'screen-people' && !input.screen) return 'side-by-side'
  if (input.layout === 'solo' && people.length > 1) return 'side-by-side'
  return input.layout
}

/**
 * The plan for one canvas. People missing from the room still get a tile
 * (the stage draws "Back in a moment" or a dark tile).
 */
export function planStage(canvas: StageCanvas, input: StageInput): StagePlan {
  const people = input.people.filter((identity) => identity.length > 0)
  if (people.length === 0 && !input.screen) return { tiles: [] }
  const gutter = stageGutter(canvas)
  const area = insetArea(canvas)
  const portrait = canvas.height > canvas.width
  const tiles: StageTile[] = []
  const layout = effectiveStageLayout(input)

  if (layout === 'solo') {
    tiles.push({
      identity: people[0] ?? '',
      kind: 'person',
      rect: { x: 0, y: 0, w: even(canvas.width), h: even(canvas.height) },
      cornerRadius: 0
    })
  } else if (layout === 'side-by-side') {
    const cells = gridCells(area, people.length, gridCols(people.length, portrait), gutter)
    people.forEach((identity, index) => tiles.push(person(canvas, identity, fit16x9(cells[index]))))
  } else if (layout === 'screen-people') {
    const screenIdentity = input.screen ?? ''
    if (portrait) {
      // The screen on top, full width; people stacked under it.
      const screen = fit16x9({
        x: area.x,
        y: area.y,
        w: area.w,
        h: Math.floor((area.w * 9) / 16)
      })
      tiles.push({
        identity: screenIdentity,
        kind: 'screen',
        rect: screen,
        cornerRadius: stageCornerRadius(canvas)
      })
      const below: StageRect = {
        x: area.x,
        y: bottom(screen) + gutter,
        w: area.w,
        h: Math.max(0, bottom(area) - (bottom(screen) + gutter))
      }
      const cells = gridCells(below, people.length, people.length <= 2 ? 1 : 2, gutter)
      people.forEach((identity, index) =>
        tiles.push(person(canvas, identity, fit16x9(cells[index])))
      )
    } else {
      // The screen large on the left, people in a column on the right.
      const columnW = even(Math.floor(area.w / 4))
      const screen = fit16x9({ x: area.x, y: area.y, w: area.w - columnW - gutter, h: area.h })
      tiles.push({
        identity: screenIdentity,
        kind: 'screen',
        rect: screen,
        cornerRadius: stageCornerRadius(canvas)
      })
      // Each person 16:9 at the column's width while they fit; a longer
      // column shrinks the tiles so everyone stays on.
      const n = people.length
      const naturalH = even(Math.floor((columnW * 9) / 16))
      const groupH = n * naturalH + gutter * Math.max(0, n - 1)
      const column: StageRect =
        groupH <= area.h
          ? {
              x: right(area) - columnW,
              y: area.y + Math.floor((area.h - groupH) / 2),
              w: columnW,
              h: groupH
            }
          : { x: right(area) - columnW, y: area.y, w: columnW, h: area.h }
      const cells = gridCells(column, n, 1, gutter)
      people.forEach((identity, index) =>
        tiles.push(person(canvas, identity, fit16x9(cells[index])))
      )
    }
  } else {
    const spotlit =
      (input.spotlight && people.includes(input.spotlight) ? input.spotlight : people[0]) ?? ''
    const rest = people.filter((identity) => identity !== spotlit)
    if (rest.length === 0) {
      tiles.push(person(canvas, spotlit, fit16x9(area)))
    } else if (portrait) {
      const big = fit16x9({ x: area.x, y: area.y, w: area.w, h: Math.floor((area.w * 9) / 16) })
      tiles.push(person(canvas, spotlit, big))
      const below: StageRect = {
        x: area.x,
        y: bottom(big) + gutter,
        w: area.w,
        h: Math.max(0, bottom(area) - (bottom(big) + gutter))
      }
      const cells = gridCells(below, rest.length, rest.length <= 1 ? 1 : 2, gutter)
      rest.forEach((identity, index) => tiles.push(person(canvas, identity, fit16x9(cells[index]))))
    } else {
      // The strip along the bottom takes 22% of the canvas height.
      const stripH = even(Math.floor(canvas.height * 0.22))
      const big = fit16x9({ x: area.x, y: area.y, w: area.w, h: area.h - stripH - gutter })
      tiles.push(person(canvas, spotlit, big))
      const strip: StageRect = { x: area.x, y: bottom(area) - stripH, w: area.w, h: stripH }
      const cells = gridCells(strip, rest.length, rest.length, gutter)
      rest.forEach((identity, index) => tiles.push(person(canvas, identity, fit16x9(cells[index]))))
    }
  }
  return { tiles }
}

/** A rect as percentages of the canvas, for a stage drawn at any size. */
export function stageRectPercent(
  canvas: StageCanvas,
  rect: StageRect
): { left: string; top: string; width: string; height: string } {
  const pct = (value: number, of: number): string => `${(value / of) * 100}%`
  return {
    left: pct(rect.x, canvas.width),
    top: pct(rect.y, canvas.height),
    width: pct(rect.w, canvas.width),
    height: pct(rect.h, canvas.height)
  }
}
