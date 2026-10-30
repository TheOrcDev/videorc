import { readFileSync } from 'node:fs'

import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

const PHOSPHOR_RESTRICTION = {
  name: '@phosphor-icons/react',
  message:
    'Import icons from @/components/icons instead. Add a new semantic slot there only if no existing slot already means the same thing.'
}

// Base UI is the primitive layer of the registries Videorc installs from:
// audiocn (plan 092) and @videorc (videorc-ui). Until a family moves to
// @videorc, Videorc's own UI is Radix (components.json: radix-rhea), so only
// registry files may import it: the audiocn files docs/audiocn.md lists, and
// the items in apps/desktop/ui-registry.json (pnpm ui:sync).
const BASE_UI_RESTRICTION = {
  group: ['@base-ui/react', '@base-ui/react/*'],
  message:
    "Base UI is the registries' primitive layer; Videorc UI not yet synced from @videorc uses Radix. Only files installed from @audiocn (docs/audiocn.md) or listed in apps/desktop/ui-registry.json may import it."
}

const AUDIOCN_BASE_UI_FILES = [
  'channel-strip',
  'channel-toggle',
  'clip-indicator',
  'fader',
  'lcd-display',
  'parameter-slider'
].map((name) => `apps/desktop/src/renderer/src/components/ui/${name}.tsx`)

// A @videorc item's file is named after it (a videorc-ui registry rule), in
// components/ui/ or components/.
const VIDEORC_UI_BASE_UI_FILES = JSON.parse(
  readFileSync(new URL('./apps/desktop/ui-registry.json', import.meta.url), 'utf8')
).items.flatMap((name) => [
  `apps/desktop/src/renderer/src/components/ui/${name}.{ts,tsx}`,
  `apps/desktop/src/renderer/src/components/${name}.tsx`
])

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'target/**',
      'vendor/**',
      'apps/desktop/out/**',
      'apps/desktop/release/**'
    ]
  },
  {
    files: ['apps/desktop/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        }
      }
    },
    plugins: {
      'react-hooks': reactHooks
    },
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_'
        }
      ],
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/rules-of-hooks': 'error'
    }
  },
  {
    // The icon set is licence-counted (Nucleo's open-source allowance is 100
    // glyphs) and meaning-managed: every icon is named once in the registry so
    // the app cannot grow a third warning variant or a second pin by accident.
    // Importing the icon package directly bypasses both — so it is an error
    // everywhere except inside the registry itself.
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    ignores: [
      'apps/desktop/src/renderer/src/components/icons.tsx',
      // The Stream Manager's own glyphs stay out of every window's eager chunk.
      'apps/desktop/src/renderer/src/components/stream-manager/activity-icons.tsx'
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [PHOSPHOR_RESTRICTION], patterns: [BASE_UI_RESTRICTION] }
      ]
    }
  },
  {
    // Registry files may build on Base UI (plan 092; videorc-ui). Flat config
    // does not merge rule options, so this block re-declares the rule with the
    // icon ban only.
    files: [...AUDIOCN_BASE_UI_FILES, ...VIDEORC_UI_BASE_UI_FILES],
    rules: {
      'no-restricted-imports': ['error', { paths: [PHOSPHOR_RESTRICTION] }]
    }
  }
)
