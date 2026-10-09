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

/**
 * The Client modules each compiled-in Built-in Extension imports (ADR 0121): recorded exceptions
 * to the rule that an extension reaches the Client only through the Extension API. Each is an
 * exact import specifier: a `$lib` module, a SvelteKit module or a package of this repository.
 * The list may only shrink, as the API grows to cover what an extension needs. A new import of
 * the Client from one of these extensions fails lint until it is added here, where a reviewer
 * sees it.
 */
const CLIENT_IMPORT_EXCEPTIONS = {
    kanban: [
        '$lib/document/active-editor',
        '$lib/document/backlinks',
        '$lib/document/caret-concepts',
        '$lib/document/commands/link-commands',
        '$lib/document/commands/task-reference-commands',
        '$lib/document/index-db',
        '$lib/document/index-db-sqlite',
        '$lib/document/index-derive',
        '$lib/document/index-worker/client',
        '$lib/document/inline-parts',
        '$lib/document/open-concept',
        '$lib/document/settle-scheduler',
        '$lib/document/task-tags',
        '$lib/document/task-write',
        '$lib/document/types',
        '$lib/document/view/augmentations/concept-picker',
        '$lib/document/view/DocumentView.svelte',
        '$lib/document/view/editor-document',
        '$lib/extensions/catalogue',
        '$lib/extensions/scoped-context',
        '$lib/extensions/svelte-view.svelte',
        '$lib/extensions/testing',
        '$lib/layout',
        '$lib/layout/breakpoint',
        '$lib/layout/view-ref',
        '$lib/surface/active-bus',
        '$lib/surface/command-menu',
        '$lib/surface/context-menu',
        '$lib/surface/context-menu-store',
        '$lib/surface/icons',
        '$lib/workspace/workspace-services',
    ],
    maps: [
        '$app/environment',
        '$env/dynamic/public',
        '$lib/document/active-asset-store',
        '$lib/document/active-editor',
        '$lib/document/backlinks',
        '$lib/document/backlinks/backlink-index',
        '$lib/document/caret-concepts',
        '$lib/document/commands/editor-commands',
        '$lib/document/fence-body',
        '$lib/document/index-map-items',
        '$lib/document/index-worker/client',
        '$lib/document/map-text',
        '$lib/document/outliner',
        '$lib/document/publish/map-picture-renderer',
        '$lib/document/publish/publish',
        '$lib/document/view/analysis/editor-analysis',
        '$lib/document/view/augmentations/concept-picker',
        '$lib/document/view/augmentations/interactive-fence',
        '$lib/document/view/augmentations/interactive-fence-contract',
        '$lib/document/view/augmentations/interactive-fence-state',
        '$lib/document/view/body-writable',
        '$lib/document/view/editor-document',
        '$lib/extensions/catalogue',
        '$lib/extensions/host',
        '$lib/extensions/scoped-context',
        '$lib/extensions/svelte-view.svelte',
        '$lib/extensions/switches',
        '$lib/extensions/testing',
        '$lib/layout/view-ref',
        '$lib/storage',
        '$lib/storage/fs/asset-store',
        '$lib/surface',
        '$lib/surface/command-menu',
        '$lib/surface/context-menu',
        '$lib/surface/contribution-registry',
        '$lib/surface/icons',
        '$lib/sync/sync-api',
        '$lib/sync/sync-deployment',
        '$lib/workspace/workspace-services',
        '@appsoftwareltd/etherpk-shared',
    ],
}

/** A regular expression source matching `text` exactly. */
const literally = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * What an extension may not import (ADR 0121): the Client, by its aliases (`$lib`, and SvelteKit's
 * `$env` and `$app`) or by a path into `apps/`, and any of the repository's own packages but the
 * Extension API, which takes in other extensions. `allowed` lists the exact specifiers a
 * compiled-in extension is still let import.
 */
function extensionImportRule(allowed = []) {
    const exceptions = allowed.length > 0 ? `(?!(${allowed.map(literally).join('|')})$)` : ''
    return [
        'error',
        {
            patterns: [
                {
                    regex: `^${exceptions}\\$(lib|env|app)(/|$)`,
                    message:
                        'An extension reaches the Client only through @appsoftwareltd/etherpk-extension-api (ADR 0121). A compiled-in extension may keep the imports eslint.config.js records, and no more.',
                },
                { regex: '(^|/)apps/', message: 'An extension reaches the Client only through @appsoftwareltd/etherpk-extension-api (ADR 0121).' },
                {
                    regex: `^${exceptions}@appsoftwareltd/etherpk-(?!extension-api(/|$))`,
                    message: "An extension imports no other package of this repository but the Extension API, so it never depends on another extension's code (ADR 0121).",
                },
            ],
        },
    ]
}

/**
 * What the Client may not import (ADR 0121): any extension's package or folder. It finds the
 * Built-in Extensions by a build-time glob and the Vite plugin instead, so an extension is added
 * or removed without the Client naming it. `allowed` lets the Headless Client, which loads no
 * extension, import the Graph View's pure model and maps' picture drawing.
 */
function clientImportRule(allowed = []) {
    const exceptions = ['api(/|$)', ...allowed.map((path) => `${literally(path)}$`)].join('|')
    return [
        'error',
        {
            patterns: [
                {
                    regex: `^@appsoftwareltd/etherpk-extension-(?!${exceptions})`,
                    message: 'The Client names no extension (ADR 0121): it finds the Built-in Extensions by their manifests (src/lib/extensions/built-ins.ts).',
                },
                { regex: '^(\\.\\./)+extensions/', message: 'The Client names no extension (ADR 0121): it finds the Built-in Extensions by their manifests (src/lib/extensions/built-ins.ts).' },
            ],
        },
    ]
}

/**
 * The HTML sinks Trusted Types guards (ADR 0130), as `no-restricted-syntax` entries. `message` gives
 * each sink's message: the Client points at its helper for that sink, an extension at what it
 * does instead.
 */
function htmlSinkRules(message) {
    return [
        { selector: 'AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]', message: message('innerHTML') },
        { selector: 'AssignmentExpression[left.property.name="srcdoc"], SvelteAttribute[key.name="srcdoc"]', message: message('srcdoc') },
        { selector: 'CallExpression[callee.property.name="parseFromString"]', message: message('parseFromString') },
        {
            selector:
                'CallExpression[callee.property.name="insertAdjacentHTML"], CallExpression[callee.object.name="document"][callee.property.name=/^(write|writeln)$/]',
            message: message('write'),
        },
    ]
}

/** `rule`, a `no-restricted-imports` setting, with `patterns` refused as well. */
function withPatterns(rule, ...patterns) {
    const [level, options] = rule
    return [level, { ...options, patterns: [...options.patterns, ...patterns] }]
}

/**
 * The `etherpk-icons` policy passes markup as it is, which is safe only because its one caller, the
 * icon table, holds constant text (ADR 0130). Every other icon comes from `iconSvg`.
 */
const TRUSTED_ICON_IMPORT = {
    group: ['**/security/trusted-types', '$lib/security/trusted-types'],
    importNames: ['trustedIconMarkup'],
    message: 'Icon markup comes from iconSvg in $lib/surface/icons, whose table is constant text (ADR 0130).',
}

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
            // Git worktrees Claude Code creates inside the repository: whole checkouts, each
            // linted by a run of its own. Relative to this file, so a run inside one still lints it.
            '.claude/worktrees/**',
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
        // Trusted Types (ADR 0130). The Client's CSP refuses a plain string at an HTML sink unless
        // a named policy made it, and its own sinks go through `lib/security/trusted-types.ts`, so
        // a string from a document reaches one only through the default policy, which sanitizes it.
        // The browser enforces that at run time; this says where at the line.
        files: ['apps/client/src/**/*.ts', 'apps/client/src/**/*.svelte'],
        ignores: ['apps/client/src/lib/security/trusted-types.ts', 'apps/client/src/**/*.test.ts'],
        rules: {
            'no-restricted-syntax': [
                'error',
                ...htmlSinkRules(
                    (sink) =>
                        ({
                            innerHTML: 'Use setTrustedMarkup from $lib/security/trusted-types (Trusted Types, ADR 0130).',
                            srcdoc: 'Use setSandboxedSrcdoc from $lib/security/trusted-types (Trusted Types, ADR 0130).',
                            parseFromString: 'Use parseInertHtml from $lib/security/trusted-types (Trusted Types, ADR 0130).',
                        })[sink] ?? 'Write markup through $lib/security/trusted-types (Trusted Types, ADR 0130).',
                ),
            ],
        },
    },
    {
        // Extension code runs under the Client's Trusted Types too (ADR 0130), with no policy of its
        // own and no reach to the Client's sink helpers, so it writes no HTML at all: it builds
        // elements with the DOM and draws icons with `context.icons.svg`, whose markup the Client
        // made. Nor may it create a policy.
        files: ['extensions/**/*.{ts,js,svelte}'],
        ignores: ['extensions/**/*.test.ts'],
        rules: {
            'no-restricted-syntax': [
                'error',
                ...htmlSinkRules(
                    () =>
                        'An extension writes no HTML (Trusted Types, ADR 0130): build elements with the DOM, and draw icons with context.icons.svg.',
                ),
                {
                    selector: 'CallExpression[callee.property.name="createPolicy"]',
                    message: 'An extension creates no Trusted Types policy (ADR 0130).',
                },
            ],
        },
    },
    {
        // Tests reach into internals and stub globals, and print diagnostics. `any` stays an
        // error here though: the existing eslint-disable directives are almost all in test
        // files, and turning the rule off in tests would make those directives inert.
        files: ['**/*.test.ts', '**/*.spec.ts', 'tests-*/**/*.ts', '**/__mocks__/**'],
        rules: { 'no-console': 'off' },
    },
    // The extension boundary (ADR 0121), both ways. Tests of the boundary's own code reach across it
    // as the app does, so the rules cover the tests too, but not the Playwright suites.
    {
        files: ['apps/**/*.{ts,js,svelte}', 'packages/**/*.{ts,js,svelte}'],
        rules: { 'no-restricted-imports': clientImportRule() },
    },
    {
        // A later `no-restricted-imports` replaces an earlier one, so the Client's own files take
        // the icon policy's import rule joined to the boundary's.
        files: ['apps/client/src/**/*.ts', 'apps/client/src/**/*.svelte'],
        ignores: ['apps/client/src/lib/surface/icons.ts', 'apps/client/src/**/*.test.ts'],
        rules: { 'no-restricted-imports': withPatterns(clientImportRule(), TRUSTED_ICON_IMPORT) },
    },
    {
        files: ['apps/mcp/**/*.ts'],
        rules: { 'no-restricted-imports': clientImportRule(['graph-view/model', 'maps/picture']) },
    },
    {
        files: ['extensions/**/*.{ts,js,svelte}'],
        rules: { 'no-restricted-imports': extensionImportRule() },
    },
    ...Object.entries(CLIENT_IMPORT_EXCEPTIONS).map(([folder, allowed]) => ({
        files: [`extensions/${folder}/**/*.{ts,js,svelte}`],
        rules: { 'no-restricted-imports': extensionImportRule(allowed) },
    })),
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
