import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

const PHOSPHOR_RESTRICTION = {
  name: '@phosphor-icons/react',
  message:
    'Import icons from @/components/icons instead. Add a new semantic slot there only if no existing slot already means the same thing.'
}

// Base UI is audiocn's primitive layer (plan 092). Videorc's own UI is Radix
// (components.json: radix-rhea), so only files installed from the @audiocn
// registry may import it. docs/audiocn.md lists them.
const BASE_UI_RESTRICTION = {
  group: ['@base-ui/react', '@base-ui/react/*'],
  message:
    "Base UI is audiocn's primitive layer; Videorc UI uses Radix. Only files installed from @audiocn may import it (docs/audiocn.md)."
}

const AUDIOCN_BASE_UI_FILES = [
  'apps/desktop/src/renderer/src/components/ui/channel-strip.tsx',
  'apps/desktop/src/renderer/src/components/ui/clip-indicator.tsx'
]

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
    // audiocn files may build on Base UI (plan 092). Flat config does not merge
    // rule options, so this block re-declares the rule with the icon ban only.
    files: AUDIOCN_BASE_UI_FILES,
    rules: {
      'no-restricted-imports': ['error', { paths: [PHOSPHOR_RESTRICTION] }]
    }
  }
)
