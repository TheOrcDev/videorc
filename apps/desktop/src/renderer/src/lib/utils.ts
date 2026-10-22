import { clsx, type ClassValue } from 'clsx'
import { createTailwindMerge, getDefaultConfig } from 'tailwind-merge'

// The desktop size tokens (styles.css @theme --spacing-*, plan 050 D4).
// tailwind-merge must know them: otherwise a call site's `h-auto` cannot
// override a primitive's `h-control`, both classes survive, and stylesheet
// order picks the winner. createTailwindMerge with a config function adds
// them without extendTailwindMerge's config-merging code (eager JS budget).
const twMerge = createTailwindMerge(getDefaultConfig, (config) => {
  config.theme.spacing = [
    ...config.theme.spacing,
    'toolbar',
    'status-bar',
    'row',
    'row-compact',
    'control',
    'gutter'
  ]
  // The type tokens and radius tiers (plan 174 S1.6a): without them
  // `text-meta` reads as a colour and loses to `text-muted-foreground`, and a
  // call site's `rounded-full` cannot override a primitive's `rounded-tag`.
  config.theme.text = [...config.theme.text, 'label', 'section', 'meta']
  config.theme.radius = [...config.theme.radius, 'panel', 'row', 'chip', 'tag']
  return config
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
