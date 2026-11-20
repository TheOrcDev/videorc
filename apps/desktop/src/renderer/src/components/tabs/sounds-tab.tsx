import type { ReactElement } from 'react'

import { PageHeader, PageStack } from '@/components/page'
import { SoundsSection } from '@/components/sounds-section'

/**
 * The Sounds page (owner 2026-11-20): the soundboard's sounds, in the
 * sidebar's Assets group beside Images. It holds the section that sat at the
 * foot of the old Assets page (plan 189 S7), unchanged: the one home that
 * imports, renames, orders, trims and removes the sounds and sets their keys.
 */
export function SoundsTab(): ReactElement {
  return (
    <PageStack className="min-h-full">
      <PageHeader
        description="What the soundboard plays. Studio's Soundboard, Stream Manager and Search play them; Sources sets their level."
        title="Sounds"
      />
      <SoundsSection />
    </PageStack>
  )
}
