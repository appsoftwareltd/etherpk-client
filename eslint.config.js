import js from '@eslint/js'
import globals from 'globals'
import svelte from 'eslint-plugin-svelte'
import svelteParser from 'svelte-eslint-parser'
import tseslint from 'typescript-eslint'

/**
 * Lint configuration for the workspace.
 *
 * Without it, the `// eslint-disable-next-line` directives scattered through the codebase would
 * be inert and the formatting conventions (4 space indent, no semicolons, single quotes) would
 * rest on habit alone. With several agents contributing, habit drifts.
 *
 * Deliberately NOT type-aware. The type-aware rules need a program per package and would
 * roughly double the run time for rules that `pnpm -r check` already covers far better:
 * svelte-check plus `tsc --noEmit` is the type authority here, and this is the correctness and
 * consistency layer beside it. If a type-aware rule is ever worth the cost, add it as a
 * separate, narrowly scoped config block rather than switching the whole thing over.
 *
 * Formatting is not enforced here either. Prettier and ESLint disagree about Svelte templates
 * often enough that adding one would mean reformatting 875 files in a change that is supposed
 * to be about correctness. `.editorconfig` carries the whitespace conventions for editors, and
 * the rules below are the ones that catch mistakes rather than preferences.
 */
export default tseslint.config(
    {
        ignores: [
            '**/node_modules/**',
            '**/build/**',
            '**/dist/**',
            '**/.svelte-kit/**',
            '**/playwright-report*/**',
            '**/test-results/**',
            // Generated: the dated report tree and the v8 coverage HTML it copies in.
            'reports/**',
            '**/coverage/**',
            'resources/**',
            // The explainer video is its own pnpm root with its own checks (ADR 0105).
            'video/**',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    ...svelte.configs.recommended,
    {
        languageOptions: {
            globals: { ...globals.browser, ...globals.node },
        },
        rules: {
            // The codebase's own convention, and the reason several directives above exist.
            '@typescript-eslint/no-explicit-any': 'error',
            // `catch {}` with no binding is used deliberately throughout; an unused CAUGHT
            // binding is the mistake worth flagging. Leading underscore is the opt-out.
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                    destructuredArrayIgnorePattern: '^_',
                },
            ],
            // `console.log` is the one to catch: on the server the structured logger is the
            // sanctioned path, and in the browser these diagnostics carry a subsystem prefix
            // and are read during development. warn/error/debug are deliberate; log is a
            // leftover.
            'no-console': ['error', { allow: ['debug', 'warn', 'error'] }],
            // Flags every Set and Map in a Svelte file. Every site it finds here is either
            // non-reactive bookkeeping (a `const` dismissal set, a listener registry, a pane
            // handle map) or a `$state` Set that is REASSIGNED rather than mutated, which is
            // already a correct reactivity pattern. The rule cannot tell those apart from the
            // mistake it is looking for, so it is only producing false positives here.
            'svelte/prefer-svelte-reactivity': 'off',
            // Every site it flags is a `$state` seeded by an $effect for a browser-only value
            // (btoa, WebAuthn support, a prop mirror already marked state_referenced_locally).
            // A writable $derived would evaluate during SSR, which is the thing the effect
            // exists to avoid. Worth revisiting per component, not as a blanket rewrite.
            'svelte/prefer-writable-derived': 'off',
            // Requires SvelteKit's resolve() around every href and goto. A reasonable
            // convention, and adopting it means touching 80 navigation sites across the three
            // apps, which is its own change with its own testing. Off rather than 'warn' so
            // the lint output stays a list of things to act on.
            'svelte/no-navigation-without-resolve': 'off',
        },
    },
    {
        files: ['**/*.svelte', '**/*.svelte.ts'],
        languageOptions: {
            parser: svelteParser,
            parserOptions: { parser: tseslint.parser },
        },
    },
    {
        // Tests reach into internals and stub globals, and print diagnostics. `any` stays an
        // error here though: the existing eslint-disable directives are almost all in test
        // files, and turning the rule off in tests would make those directives inert.
        files: ['**/*.test.ts', '**/*.spec.ts', 'tests-*/**/*.ts', '**/__mocks__/**'],
        rules: { 'no-console': 'off' },
    },
    {
        // Build scripts, one-off tools and the loggers themselves: console IS the output.
        files: [
            'scripts/**',
            '**/scripts/**',
            'deeprename.mjs',
            'apps/*/src/server.ts',
            'apps/*/src/migrate.ts',
            'packages/shared/src/logging/logger.ts',
            // The Headless Client's command line: stdout is the user's, stderr the operator's.
            'apps/mcp/src/main.ts',
            '*.config.ts',
            '*.config.js',
        ],
        rules: { 'no-console': 'off' },
    },
)
