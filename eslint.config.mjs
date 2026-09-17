import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

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
    ignores: ['apps/desktop/src/renderer/src/components/icons.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@phosphor-icons/react',
              message:
                'Import icons from @/components/icons instead. Add a new semantic slot there only if no existing slot already means the same thing.'
            }
          ]
        }
      ]
    }
  }
)
