import type { ReactElement } from 'react'

import type { CohostBubbleStyle } from '@/lib/backend'
import { GOLEM_BUBBLE_LABELS } from '@/lib/golem-persona-view'

/**
 * A static two-line sample of the bubble (plan 164 S-A4). Phase C swaps in
 * the overlay rasterizer. The bubble is always the light variant: the stream
 * is not themed (D17).
 */
export function GolemBubbleSample({
  name,
  style
}: {
  name: string
  style: CohostBubbleStyle
}): ReactElement {
  const shape =
    style === 'shout'
      ? 'M14 10 L30 4 L40 12 L60 2 L72 12 L96 6 L112 14 L138 8 L150 16 L160 6 L170 18 L166 34 L176 44 L164 54 L170 66 L150 62 L136 72 L120 60 L100 70 L84 60 L66 70 L50 60 L34 68 L22 56 L8 60 L14 44 L4 34 L14 24 Z'
      : 'M12 8 Q12 2 18 2 L162 2 Q168 2 168 8 L168 58 Q168 64 162 64 L18 64 Q12 64 12 58 Z'
  return (
    <svg
      aria-label={`${GOLEM_BUBBLE_LABELS[style]} bubble sample`}
      className="h-20 w-auto shrink-0"
      data-slot="golem-bubble-sample"
      data-style={style}
      role="img"
      viewBox="0 0 180 84"
    >
      <path
        d={shape}
        fill="#FAFAFB"
        stroke="rgba(0,0,0,0.25)"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
      {style === 'thought' ? (
        <>
          <circle
            cx="40"
            cy="72"
            fill="#FAFAFB"
            r="5"
            stroke="rgba(0,0,0,0.25)"
            strokeWidth="1.5"
          />
          <circle
            cx="28"
            cy="80"
            fill="#FAFAFB"
            r="3"
            stroke="rgba(0,0,0,0.25)"
            strokeWidth="1.5"
          />
        </>
      ) : style === 'speech' ? (
        <path
          d="M40 63 L34 80 L58 63"
          fill="#FAFAFB"
          stroke="rgba(0,0,0,0.25)"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
      ) : null}
      <text
        fill="#0D0D0F"
        fontFamily="-apple-system, system-ui, sans-serif"
        fontSize="13"
        fontWeight={style === 'shout' ? 700 : 500}
        x="90"
        y="30"
        textAnchor="middle"
      >
        {style === 'shout' ? 'WELCOME TO THE HORDE!' : 'Welcome to the horde,'}
      </text>
      <text
        fill="#0D0D0F"
        fontFamily="-apple-system, system-ui, sans-serif"
        fontSize="13"
        fontWeight={500}
        x="90"
        y="48"
        textAnchor="middle"
      >
        {style === 'shout' ? `${name.toUpperCase()} IS HERE` : `${name} says hi.`}
      </text>
    </svg>
  )
}
