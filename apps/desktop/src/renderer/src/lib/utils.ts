import { clsx } from 'clsx'
import type { ClassValue } from 'clsx'
import { createTailwindMerge, getDefaultConfig } from 'tailwind-merge'

// Videorc's theme adds sizes, type tokens and radius tiers that
// tailwind-merge must know. Without them a call site's `h-auto` cannot
// override a primitive's `h-control`, `text-meta` reads as a colour and loses
// to `text-muted-foreground`, and `rounded-full` cannot override
// `rounded-tag`: both classes survive and stylesheet order picks the winner.
// createTailwindMerge with a config function adds them without
// extendTailwindMerge's config-merging code.
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
  config.theme.text = [...config.theme.text, 'label', 'section', 'meta']
  config.theme.radius = [...config.theme.radius, 'panel', 'row', 'chip', 'tag']
  return config
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
