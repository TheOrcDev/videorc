// Live backgrounds in Assets (plans 190 S8 and 194 S6): names, looks,
// thumbnails and the words for a still frame. Lazy: only the Assets page
// imports this module, so the catalogue and the thirty thumbnails stay out of
// the eager bundle. The eager registry (`background-assets.ts`) knows ids and
// default looks only.

import beamsChrome from '../assets/backgrounds/live-thumbs/live-beams-chrome.webp'
import beamsEmber from '../assets/backgrounds/live-thumbs/live-beams-ember.webp'
import beamsStudio from '../assets/backgrounds/live-thumbs/live-beams-studio.webp'
import colorBendsDefault from '../assets/backgrounds/live-thumbs/live-color-bends-default.webp'
import colorBendsEmber from '../assets/backgrounds/live-thumbs/live-color-bends-ember.webp'
import colorBendsOcean from '../assets/backgrounds/live-thumbs/live-color-bends-ocean.webp'
import ditherAmber from '../assets/backgrounds/live-thumbs/live-dither-amber.webp'
import ditherBlueprint from '../assets/backgrounds/live-thumbs/live-dither-blueprint.webp'
import ditherClassic from '../assets/backgrounds/live-thumbs/live-dither-classic.webp'
import ferrofluidEmber from '../assets/backgrounds/live-thumbs/live-ferrofluid-ember.webp'
import ferrofluidFrost from '../assets/backgrounds/live-thumbs/live-ferrofluid-frost.webp'
import ferrofluidStudio from '../assets/backgrounds/live-thumbs/live-ferrofluid-studio.webp'
import ghostFibersEmber from '../assets/backgrounds/live-thumbs/live-ghost-fibers-ember.webp'
import ghostFibersFiber from '../assets/backgrounds/live-thumbs/live-ghost-fibers-fiber.webp'
import ghostFibersViolet from '../assets/backgrounds/live-thumbs/live-ghost-fibers-violet.webp'
import lineWavesAurora from '../assets/backgrounds/live-thumbs/live-line-waves-aurora.webp'
import lineWavesGold from '../assets/backgrounds/live-thumbs/live-line-waves-gold.webp'
import lineWavesSilk from '../assets/backgrounds/live-thumbs/live-line-waves-silk.webp'
import liquidChromeGold from '../assets/backgrounds/live-thumbs/live-liquid-chrome-gold.webp'
import liquidChromeMercury from '../assets/backgrounds/live-thumbs/live-liquid-chrome-mercury.webp'
import liquidChromePolished from '../assets/backgrounds/live-thumbs/live-liquid-chrome-polished.webp'
import plasmaWaveEmber from '../assets/backgrounds/live-thumbs/live-plasma-wave-ember.webp'
import plasmaWaveGlacier from '../assets/backgrounds/live-thumbs/live-plasma-wave-glacier.webp'
import plasmaWavePlasma from '../assets/backgrounds/live-thumbs/live-plasma-wave-plasma.webp'
import sideRaysMoonlight from '../assets/backgrounds/live-thumbs/live-side-rays-moonlight.webp'
import sideRaysSpotlight from '../assets/backgrounds/live-thumbs/live-side-rays-spotlight.webp'
import sideRaysSunbeam from '../assets/backgrounds/live-thumbs/live-side-rays-sunbeam.webp'
import silkChampagne from '../assets/backgrounds/live-thumbs/live-silk-champagne.webp'
import silkMidnight from '../assets/backgrounds/live-thumbs/live-silk-midnight.webp'
import silkSatin from '../assets/backgrounds/live-thumbs/live-silk-satin.webp'

import type { LiveBackgroundStillReason } from '@/lib/backend'
import {
  LIVE_BACKGROUND_CATALOG,
  liveBackgroundEntry,
  type LiveBackgroundEntry,
  type LiveBackgroundLook
} from '../../../shared/live-background-catalog'
import {
  livePosterAssetId,
  type LiveBackgroundId,
  type LiveBackgroundMotion
} from '../../../shared/live-background-ids'

export { LIVE_BACKGROUND_CATALOG, liveBackgroundEntry }
export type { LiveBackgroundEntry, LiveBackgroundLook }

/**
 * Each look's 384 × 216 thumbnail, by its poster's asset id. A thumbnail is
 * its poster scaled down, so a tile shows exactly what a click applies.
 */
export const LIVE_BACKGROUND_THUMBNAILS: Readonly<Record<string, string>> = {
  'live-silk-satin': silkSatin,
  'live-silk-champagne': silkChampagne,
  'live-silk-midnight': silkMidnight,
  'live-side-rays-sunbeam': sideRaysSunbeam,
  'live-side-rays-moonlight': sideRaysMoonlight,
  'live-side-rays-spotlight': sideRaysSpotlight,
  'live-plasma-wave-plasma': plasmaWavePlasma,
  'live-plasma-wave-ember': plasmaWaveEmber,
  'live-plasma-wave-glacier': plasmaWaveGlacier,
  'live-liquid-chrome-polished': liquidChromePolished,
  'live-liquid-chrome-gold': liquidChromeGold,
  'live-liquid-chrome-mercury': liquidChromeMercury,
  'live-line-waves-silk': lineWavesSilk,
  'live-line-waves-gold': lineWavesGold,
  'live-line-waves-aurora': lineWavesAurora,
  'live-beams-studio': beamsStudio,
  'live-beams-chrome': beamsChrome,
  'live-beams-ember': beamsEmber,
  'live-color-bends-default': colorBendsDefault,
  'live-color-bends-ember': colorBendsEmber,
  'live-color-bends-ocean': colorBendsOcean,
  'live-dither-classic': ditherClassic,
  'live-dither-amber': ditherAmber,
  'live-dither-blueprint': ditherBlueprint,
  'live-ferrofluid-studio': ferrofluidStudio,
  'live-ferrofluid-ember': ferrofluidEmber,
  'live-ferrofluid-frost': ferrofluidFrost,
  'live-ghost-fibers-violet': ghostFibersViolet,
  'live-ghost-fibers-fiber': ghostFibersFiber,
  'live-ghost-fibers-ember': ghostFibersEmber
}

/**
 * The live backgrounds Assets offers: those with a bundled thumbnail for
 * every look, in catalogue order. All ten have them (plan 194 S6); a
 * background added to the catalogue without its pictures stays out of the
 * Live group, so a tile without a picture is never shown.
 */
export const LIVE_BACKGROUND_OFFERED: readonly LiveBackgroundEntry[] =
  LIVE_BACKGROUND_CATALOG.filter((entry) =>
    entry.looks.every((look) => livePosterAssetId(entry.id, look.id) in LIVE_BACKGROUND_THUMBNAILS)
  )

/**
 * The look this build shows for a stored look id: the look itself, or the
 * background's first look when a stored id names one this build doesn't have
 * (the backend renders the first look then too).
 */
export function liveBackgroundLook(id: LiveBackgroundId, look: string): LiveBackgroundLook {
  const looks = liveBackgroundEntry(id).looks
  return looks.find((entry) => entry.id === look) ?? looks[0]
}

/** The thumbnail of a background's look. */
export function liveBackgroundThumbnail(id: LiveBackgroundId, look: string): string {
  return LIVE_BACKGROUND_THUMBNAILS[livePosterAssetId(id, liveBackgroundLook(id, look).id)]
}

/** "Silk · Satin": a live background with its look, as the scene row names it. */
export function liveBackgroundLabel(id: LiveBackgroundId, look: string): string {
  return `${liveBackgroundEntry(id).name} · ${liveBackgroundLook(id, look).name}`
}

/** Motion (plan 190 D5): Calm, the default, is half the React Bits speed. */
export const LIVE_BACKGROUND_MOTION_OPTIONS: readonly {
  value: LiveBackgroundMotion
  label: string
}[] = [
  { value: 'calm', label: 'Calm' },
  { value: 'normal', label: 'Normal' }
]

/** The one Live group credit line (plan 190 D3). */
export const LIVE_BACKGROUND_CREDIT = 'From React Bits by David Haz.'

const STILL_FRAME_REASONS: Readonly<Record<LiveBackgroundStillReason, string>> = {
  forced: 'Showing a still frame: animation is turned off for testing.',
  'legacy-graph': "Showing a still frame: it can't move at this resolution and frame rate.",
  'cpu-fallback': 'Showing a still frame: Videorc is drawing this scene without the graphics card.',
  'no-gpu': "Showing a still frame: Videorc couldn't find a graphics card it can use.",
  'software-gpu':
    'Showing a still frame: the graphics driver runs in software, and animating would slow everything down.',
  'quarantined-node':
    'Showing a still frame: this graphics card stopped responding once, so Videorc leaves it alone.',
  'shader-compile-failed':
    "Showing a still frame: the graphics card couldn't prepare the animation.",
  'gpu-budget': 'Showing a still frame: your graphics card is too busy to animate it.'
}

/**
 * Why a live background shows a still frame, as one line for its Adjust
 * style (plan 190 S8). A reason this build doesn't know still says what
 * shows.
 */
export function liveBackgroundStillLine(reason: LiveBackgroundStillReason | undefined): string {
  return (reason && STILL_FRAME_REASONS[reason]) || 'Showing a still frame.'
}
