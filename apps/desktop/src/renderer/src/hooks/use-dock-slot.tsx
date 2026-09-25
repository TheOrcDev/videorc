import { useCallback, useEffect, useRef } from 'react'

import type { DockSlot, DockSlotReport } from '@/lib/backend'
import {
  DOCK_BLOCKING_POPPER_SELECTOR,
  DOCK_BLOCKING_SCRIM_SELECTOR,
  buildDockSlotReport,
  dockSlotReportChanged,
  measureDockSlot,
  overlaysOccludeSlot,
  type SlotRect
} from '@/lib/dock-slot'

// Reports a dock slot (the Studio preview card or the Scene canvas) to main
// while the preview is docked.
//
// CONTRACT (see main/preview-dock.ts): reports carry WINDOW-RELATIVE CSS
// pixels and fire only when the slot's in-window geometry actually changes —
// layout, scroll, tab switches. Window drags change nothing here, so this hook
// is never in the movement path; that renderer-driven follow is what made the
// 2026-06-09 glued preview drift.
//
// Also watches portalled overlays (dialog scrims always; popper content when
// it overlaps the slot) and tells main to hide the docked surface under them,
// since in-page overlays would otherwise paint UNDER the native surface.
export function useDockSlotReporter(
  active: boolean,
  epoch: number,
  slot: DockSlot
): (element: HTMLElement | null) => void {
  const elementRef = useRef<HTMLElement | null>(null)
  const lastReportRef = useRef<DockSlotReport | null>(null)
  const lastOverlayRef = useRef<boolean | null>(null)
  const frameRef = useRef<number | null>(null)
  const activeRef = useRef(active)
  const epochRef = useRef(epoch)
  const slotRef = useRef(slot)
  activeRef.current = active
  epochRef.current = epoch
  slotRef.current = slot

  const send = useCallback((report: DockSlotReport) => {
    if (dockSlotReportChanged(lastReportRef.current, report)) {
      lastReportRef.current = report
      void window.videorc?.reportPreviewDockSlot?.(report)
    }
  }, [])

  const sendOverlay = useCallback((open: boolean) => {
    if (lastOverlayRef.current !== open) {
      lastOverlayRef.current = open
      void window.videorc?.setPreviewDockOverlayOpen?.(open)
    }
  }, [])

  const measureNow = useCallback(() => {
    if (!activeRef.current) {
      return
    }
    const element = elementRef.current
    if (!element || !element.isConnected) {
      return
    }
    const domRect = element.getBoundingClientRect()
    const rect: SlotRect = {
      x: domRect.x,
      y: domRect.y,
      width: domRect.width,
      height: domRect.height
    }
    const measurement = measureDockSlot(rect, {
      width: window.innerWidth,
      height: window.innerHeight
    })
    send(buildDockSlotReport(epochRef.current, slotRef.current, measurement, true))

    const scrims = document.querySelectorAll(DOCK_BLOCKING_SCRIM_SELECTOR).length
    const popperRects = Array.from(document.querySelectorAll(DOCK_BLOCKING_POPPER_SELECTOR)).map(
      (overlay) => {
        const overlayRect = overlay.getBoundingClientRect()
        return {
          x: overlayRect.x,
          y: overlayRect.y,
          width: overlayRect.width,
          height: overlayRect.height
        }
      }
    )
    sendOverlay(overlaysOccludeSlot(scrims, popperRects, rect))
  }, [send, sendOverlay])

  // Coalesce every trigger (scroll storms, resize, mutations) to one
  // measurement per animation frame.
  const queueMeasure = useCallback(() => {
    if (frameRef.current !== null) {
      return
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      measureNow()
    })
  }, [measureNow])

  useEffect(() => {
    if (!active) {
      return
    }
    lastReportRef.current = null
    lastOverlayRef.current = null
    queueMeasure()

    const element = elementRef.current
    const resizeObserver = new ResizeObserver(queueMeasure)
    if (element) {
      resizeObserver.observe(element)
    }
    // Portal mounts/unmounts (dialogs, menus) and data-state flips.
    const mutationObserver = new MutationObserver(queueMeasure)
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state']
    })
    // capture:true reaches scrolls inside nested scroll containers.
    window.addEventListener('scroll', queueMeasure, { capture: true, passive: true })
    window.addEventListener('resize', queueMeasure)
    // Position-only layout shifts (a sibling panel collapsing) move the slot
    // without resizing it or scrolling; no observer fires for those. This
    // low-cost heartbeat bounds how stale the slot rect can get.
    const heartbeat = window.setInterval(measureNow, 500)

    return () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('scroll', queueMeasure, { capture: true })
      window.removeEventListener('resize', queueMeasure)
      window.clearInterval(heartbeat)
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      // Tab switch / undock / close: tell main the slot is gone so the docked
      // surface hides with a stated reason instead of lingering.
      lastReportRef.current = null
      void window.videorc?.reportPreviewDockSlot?.(
        buildDockSlotReport(
          epochRef.current,
          slotRef.current,
          { rect: { x: 0, y: 0, width: 0, height: 0 }, visibleFraction: 0 },
          false
        )
      )
      if (lastOverlayRef.current) {
        lastOverlayRef.current = false
        void window.videorc?.setPreviewDockOverlayOpen?.(false)
      }
    }
  }, [active, epoch, slot, measureNow, queueMeasure])

  return useCallback(
    (element: HTMLElement | null) => {
      elementRef.current = element
      if (element) {
        queueMeasure()
      }
    },
    [queueMeasure]
  )
}
