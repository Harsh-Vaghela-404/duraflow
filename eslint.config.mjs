// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
    // Ignore generated files and build artifacts
    {
        ignores: [
            '**/dist/**',
            '**/node_modules/**',
            'packages/proto/generated/**',
            'docs/**',
            '**/*.js',
            '**/*.mjs',
            '**/*.cjs',
        ],
    },

    js.configs.recommended,
    ...tseslint.configs.recommended,

    // Disable ESLint formatting rules - Prettier owns formatting
    prettierConfig,

    // Project-wide TypeScript rules (no type-info needed)
    {
        files: ['**/*.ts'],
        rules: {
            // The project uses console.log with TAG convention - not a quality issue
            'no-console': 'off',

            // `any` is allowed at mock boundaries and proto-loader edges WITH a comment
            '@typescript-eslint/no-explicit-any': 'warn',

            // Catch unused vars - TS strict catches these but ESLint shows them inline
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                },
            ],

            // Enforce const for variables that are never reassigned
            'prefer-const': 'error',

            // No var
            'no-var': 'error',

            // Don't require explicit return types - TypeScript infers them
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',

            // Allow require() at specific call sites (e.g. @grpc/reflection)
            '@typescript-eslint/no-require-imports': 'warn',
        },
    },

    // Type-aware rules - uses TypeScript project service to resolve tsconfig per file
    {
        files: ['apps/**/*.ts', 'packages/**/*.ts'],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: __dirname,
            },
        },
        rules: {
            // Require await or explicit void for floating Promises
            '@typescript-eslint/no-floating-promises': 'error',
        },
    },

    // Relax rules in test files - mocks, any, non-null assertions are fine there
    {
        files: ['**/tests/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/no-floating-promises': 'off',
        },
    },
);
