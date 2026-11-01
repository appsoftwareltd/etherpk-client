/**
 * Keeps an app's `.env.example` honest against the settings its source code reads.
 *
 * `.env.example` is the configuration reference a self-hoster copies, and the one file under an
 * app that documents its settings in the Public Repositories (ADR 0096), where the design record is
 * not published. Nothing enforces it at runtime, so each app runs a unit test built on these
 * functions: every setting the source names must appear in the example (set, or commented out as
 * optional), and every key in the example must still be read by something.
 *
 * The source scan is lexical, not a parser. It takes three shapes as setting names:
 *
 *   - a property read on `env`, `environment`, `privateEnv`, `publicEnv` or `process.env`
 *     (`env.LOG_LEVEL`);
 *   - a name imported from `$app/env/private` or `$app/env/public` (`import { LOG_LEVEL } from …`);
 *   - a quoted upper-snake string with at least one underscore (`'CORPORATE_ISSUER'`), which is how
 *     every reader helper in the apps names its variable (`getEnv('X')`, `required(environment, 'X')`).
 *
 * All three need an underscore, so `'GET'` or `env.DEV` never count. The example file accepts
 * any upper-case key, because the Node adapter reads single-word settings such as `PORT`.
 *
 * The second shape also matches constants that are not settings (error codes such as
 * `'STALE_GENERATION'`); each app lists those in `notEnvironment`, with the reason, so an
 * unrecognised new constant fails loudly and gets a decision. Comments are removed first, so a
 * usage example in a doc comment is not mistaken for a read.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

const NAME = '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+'
const ASSIGNMENT = /^#?\s*([A-Z][A-Z0-9_]*)=/
const PROPERTY_READ = new RegExp(`\\b(?:process\\.env|environment|env|privateEnv|publicEnv)\\.([A-Z][A-Z0-9_]*)\\b`, 'g')
const QUOTED_NAME = new RegExp(`['"\`](${NAME})['"\`]`, 'g')
const ENV_MODULE_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]\$app\/env\/(?:private|public)['"]/g
const IMPORTED_NAME = new RegExp(`^\\s*(${NAME})\\b`)
const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.svelte'])

/**
 * Keys an example file declares: `KEY=value` for a setting it sets, `# KEY=value` for one it
 * documents as optional. Prose comments are skipped because an assignment must start the line.
 */
export function parseEnvExampleKeys(text: string): Set<string> {
    const keys = new Set<string>()
    for (const line of text.split(/\r?\n/)) {
        const match = ASSIGNMENT.exec(line.trim())
        if (match) keys.add(match[1])
    }
    return keys
}

/**
 * Removes whole-line `//` comments, then block comments; a trailing comment after code is kept.
 * Line comments go first, so a `/**` inside one (`// Handle /api/auth/** requests`) does not open a
 * block comment that hides the code after it.
 */
function stripComments(source: string): string {
    return source
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Setting names one source file reads, by the two shapes described at the top of this module. */
export function environmentNamesInSource(source: string): Set<string> {
    const code = stripComments(source)
    const names = new Set<string>()
    for (const match of code.matchAll(PROPERTY_READ)) {
        // A single word (`env.DEV`) is a flag Vite provides, not a setting. The Node adapter's
        // single-word settings (`PORT`, `HOST`) are listed by each app in `readOutsideSource`.
        if (match[1].includes('_')) names.add(match[1])
    }
    for (const match of code.matchAll(ENV_MODULE_IMPORT)) {
        for (const specifier of match[1].split(',')) {
            const imported = IMPORTED_NAME.exec(specifier)
            if (imported) names.add(imported[1])
        }
    }
    for (const match of code.matchAll(QUOTED_NAME)) names.add(match[1])
    return names
}

function isSourceFile(path: string): boolean {
    return (
        SOURCE_EXTENSIONS.has(extname(path)) &&
        !path.endsWith('.test.ts') &&
        !path.endsWith('.d.ts')
    )
}

function* sourceFiles(root: string): Generator<string> {
    if (!statSync(root).isDirectory()) {
        if (isSourceFile(root)) yield root
        return
    }
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name)
        if (entry.isDirectory()) {
            // Test doubles name settings the app only pretends to have.
            if (entry.name !== '__mocks__' && entry.name !== 'node_modules') yield* sourceFiles(path)
        } else if (isSourceFile(path)) {
            yield path
        }
    }
}

/** Setting names read anywhere under the given directories or files. */
export function environmentNamesInTree(roots: readonly string[]): Set<string> {
    const names = new Set<string>()
    for (const root of roots) {
        for (const file of sourceFiles(root)) {
            for (const name of environmentNamesInSource(readFileSync(file, 'utf8'))) names.add(name)
        }
    }
    return names
}

export interface EnvExampleComparison {
    /** Read by the source but absent from `.env.example`. */
    missingFromExample: string[]
    /** In `.env.example` but read by nothing the scan covers. */
    unreadInExample: string[]
    /** In `.env.example` although the app keeps it out of the example on purpose. */
    listedButKeptOut: string[]
}

export function compareEnvExample(input: {
    exampleKeys: ReadonlySet<string>
    sourceNames: ReadonlySet<string>
    /** Upper-snake constants in the source that are not settings, each with the reason. */
    notEnvironment: Readonly<Record<string, string>>
    /** Settings read by something other than the scanned source (the Node adapter, the runtime). */
    readOutsideSource: Readonly<Record<string, string>>
    /**
     * Settings the source reads that the example leaves out on purpose: those of a deployment the
     * public example does not describe. Neither required in the example nor allowed in it.
     */
    keptOutOfExample?: readonly string[]
}): EnvExampleComparison {
    const keptOut = new Set(input.keptOutOfExample ?? [])
    const missingFromExample = [...input.sourceNames]
        .filter((name) => !(name in input.notEnvironment) && !keptOut.has(name) && !input.exampleKeys.has(name))
        .sort()
    const unreadInExample = [...input.exampleKeys]
        .filter((key) => !input.sourceNames.has(key) && !(key in input.readOutsideSource))
        .sort()
    const listedButKeptOut = [...input.exampleKeys].filter((key) => keptOut.has(key)).sort()
    return { missingFromExample, unreadInExample, listedButKeptOut }
}

/**
 * Settings the source reads that the app's `src/env.ts` does not declare. SvelteKit 3 serves only
 * declared settings through `$app/env/private` and `$app/env/public`, so a read of an undeclared one
 * finds nothing, whatever the environment holds.
 */
export function undeclaredSettings(input: {
    sourceNames: ReadonlySet<string>
    declared: Iterable<string>
    /** Upper-snake constants in the source that are not settings, as for `compareEnvExample`. */
    notEnvironment: Readonly<Record<string, string>>
    /** Settings read by something other than SvelteKit's modules (the Node adapter, `process.env`). */
    readOutsideSvelteKit: Readonly<Record<string, string>>
}): string[] {
    const declared = new Set(input.declared)
    return [...input.sourceNames]
        .filter((name) => !declared.has(name) && !(name in input.notEnvironment) && !(name in input.readOutsideSvelteKit))
        .sort()
}
