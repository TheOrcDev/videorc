/*
 * Live background phase clock (plan 190), mirroring
 * crates/videorc-backend/src/live_background/clock.rs.
 *
 * Plain JavaScript on purpose: the Electron preview surface inlines this file
 * as text (Windows idle preview, Linux preview) and the unit test evaluates
 * the same file against a stand-in global.
 *
 * Time is in seconds; a phase is in React Bits time units. A `spec` is the
 * layer's live description, { id, look, motion, rate, posterPhase }, with the
 * look already resolved and `rate` the look's phase per second at Normal.
 *
 * Usage:
 *   const clock = VideorcLiveBackgroundClock.start(spec, now)
 *   VideorcLiveBackgroundClock.phaseAt(clock, now)
 *   VideorcLiveBackgroundClock.update(clock, nextSpec, now)
 *   VideorcLiveBackgroundClock.hold(clock, now) / release(clock, now)
 */
;(function (root) {
  'use strict'

  /** Mirrors `looks::motion_factor`: Calm is half the React Bits speed. */
  function speed(spec) {
    return spec.rate * (spec.motion === 'calm' ? 0.5 : 1)
  }

  /**
   * A new clock starts at the look's poster phase, so the first frame is the
   * poster the streamer clicked.
   */
  function start(spec, now) {
    return {
      id: spec.id,
      look: spec.look,
      rate: speed(spec),
      anchor: now,
      anchorPhase: spec.posterPhase,
      heldPhase: null
    }
  }

  /** The phase at `at`, or the held phase while the clock is held. */
  function phaseAt(clock, at) {
    if (clock.heldPhase !== null) return clock.heldPhase
    return clock.anchorPhase + clock.rate * Math.max(0, at - clock.anchor)
  }

  /**
   * Follow a new spec without a jump: the same background keeps its phase
   * and changes only its rate (look or motion); a different background
   * starts again at its poster phase. Returns whether anything changed.
   */
  function update(clock, spec, now) {
    var rate = speed(spec)
    if (spec.id !== clock.id) {
      var wasHeld = clock.heldPhase !== null
      Object.assign(clock, start(spec, now))
      if (wasHeld) hold(clock, now)
      return true
    }
    if (spec.look === clock.look && rate === clock.rate) return false
    clock.anchorPhase = phaseAt(clock, now)
    clock.anchor = now
    clock.rate = rate
    clock.look = spec.look
    return true
  }

  /**
   * Freeze the phase (the document is hidden or the surface is suspended).
   * Not in the backend clock: a compositor never pauses.
   */
  function hold(clock, now) {
    if (clock.heldPhase === null) clock.heldPhase = phaseAt(clock, now)
  }

  /** Run again from the held phase: the time spent held never shows. */
  function release(clock, now) {
    if (clock.heldPhase === null) return
    clock.anchorPhase = clock.heldPhase
    clock.anchor = now
    clock.heldPhase = null
  }

  root.VideorcLiveBackgroundClock = {
    start: start,
    phaseAt: phaseAt,
    update: update,
    hold: hold,
    release: release
  }
})(typeof globalThis !== 'undefined' ? globalThis : this)
