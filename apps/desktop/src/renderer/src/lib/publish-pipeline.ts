// D1 (Publish rework): the single source of truth for the publish pipeline —
// the five first-class artifacts, in pipeline order, with the exact copy the
// desktop cards AND the videorc-web AI section use (W1 reuses these strings
// verbatim; a consistency check keeps them in lockstep). Everything else the
// workflow produces is a Lab suggestion, not a pipeline step.

import type { AiArtifactKind } from '@/lib/backend'

export interface PublishPipelineStep {
  kind: AiArtifactKind
  /** Display name — MUST match videorc-web's AI section verbatim. */
  name: string
  /** One-line value proposition — MUST match videorc-web verbatim. */
  valueProp: string
  /** Ghost example shown before the artifact exists, so an un-run card still teaches. */
  example: string
}

export const PUBLISH_PIPELINE: readonly PublishPipelineStep[] = [
  {
    kind: 'transcript',
    name: 'Transcript',
    valueProp: 'Every word, timestamped — the foundation the rest builds on.',
    example: '“Welcome back — today we’re building the whole thing from scratch…”'
  },
  {
    kind: 'title-description',
    name: 'Title & description',
    valueProp: 'A publish-ready title and description written from what you actually said.',
    example: '“How I Built X in 20 Minutes” · “In this video we take a blank repo and…”'
  },
  {
    kind: 'summary',
    name: 'Summary',
    valueProp: 'The whole recording in a few tight paragraphs — notes, docs, or show notes.',
    example: '“This session covers the three-step setup, the main pitfall with…”'
  },
  {
    kind: 'chapters',
    name: 'Chapters',
    valueProp: 'YouTube-ready chapter markers at the moments the topic changes.',
    example: '0:00 Intro · 2:14 Setup · 9:32 First run · 17:05 Wrap-up'
  },
  {
    kind: 'highlights',
    name: 'Highlights',
    valueProp: 'The strongest moments, found for you — clip-worthy quotes and beats.',
    example: '“12:40 — the demo actually works on the first try (great short candidate)”'
  }
] as const

/** Lab (experimental) artifact kinds — suggestions, never applied edits. */
export const LAB_KINDS: readonly AiArtifactKind[] = [
  'smart-zoom',
  'noise-cleanup',
  'silence-removal',
  'health-assistant'
] as const

/** What the exported publish pack bundles, in export order. */
export const PUBLISH_PACK_CONTENTS: readonly { file: string; kind: AiArtifactKind }[] = [
  { file: 'title.txt', kind: 'title-description' },
  { file: 'description.txt', kind: 'title-description' },
  { file: 'chapters.txt', kind: 'chapters' },
  { file: 'summary.md', kind: 'summary' },
  { file: 'transcript.txt', kind: 'transcript' }
] as const

/** The one-click most users came for: a paste-ready YouTube description. */
export function composeYouTubeDescription({
  description,
  chapters
}: {
  description: string
  chapters: { timestamp: string; title: string }[]
}): string {
  const parts: string[] = []
  if (description.trim()) {
    parts.push(description.trim())
  }
  if (chapters.length) {
    parts.push(['Chapters:', ...chapters.map((c) => `${c.timestamp} ${c.title}`)].join('\n'))
  }
  return parts.join('\n\n')
}
