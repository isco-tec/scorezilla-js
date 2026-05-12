import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  // ────────────────────────────────────────────────────────────────────────
  // Hard import gate — `src/**` may not pull in Node-only builtins.
  // tsup's `platform: 'neutral'` is one line of defense; this rule is
  // another. Bans `node:*` builtins + the common bare-specifier ones.
  // ────────────────────────────────────────────────────────────────────────
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message:
                'scorezilla targets browsers too. Use WebCrypto / fetch / URL / globalThis APIs — never node:* builtins.',
            },
          ],
          paths: [
            {
              name: 'fs',
              message: 'Browser-incompatible. No Node-only builtins in scorezilla src.',
            },
            {
              name: 'path',
              message: 'Browser-incompatible. No Node-only builtins in scorezilla src.',
            },
            {
              name: 'crypto',
              message:
                'Use globalThis.crypto (WebCrypto) — works in Node 20+, browsers, and Workers.',
            },
            { name: 'http', message: 'Use fetch.' },
            { name: 'https', message: 'Use fetch.' },
            { name: 'url', message: 'Use the URL global.' },
            {
              name: 'util',
              message: 'Browser-incompatible. No Node-only builtins.',
            },
            {
              name: 'os',
              message: 'Browser-incompatible. No Node-only builtins.',
            },
            {
              name: 'child_process',
              message: 'Browser-incompatible. No Node-only builtins.',
            },
            {
              name: 'stream',
              message: 'Use Web Streams (globalThis.ReadableStream).',
            },
            { name: 'buffer', message: 'Use Uint8Array / Web APIs.' },
          ],
        },
      ],
    },
  },
];
