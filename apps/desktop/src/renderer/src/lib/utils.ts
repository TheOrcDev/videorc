import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// The desktop size tokens (styles.css @theme --spacing-*, plan 050 D4).
// tailwind-merge must know them: otherwise a call site's `h-auto` cannot
// override a primitive's `h-control`, both classes survive, and stylesheet
// order picks the winner.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      spacing: ['toolbar', 'status-bar', 'row', 'row-compact', 'control', 'gutter']
    }
  }
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
