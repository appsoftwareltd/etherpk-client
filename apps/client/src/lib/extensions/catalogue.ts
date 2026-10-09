/**
 * The catalogue of [[Built-in Extension]]s this Client ships (ADR 0121): every one it found, read
 * and checked, before any of their code runs.
 *
 * Two sources feed it. A compiled-in extension is a package in the repository's `extensions/`
 * folder with a `src/extension.ts`, found by a build-time glob and compiled with the Client
 * (`built-ins.ts`). A loaded extension is a prebuilt bundle the Client's build copied into its own
 * output from a package its package.json names (`extensions-plugin.ts`, beside the Vite config).
 * This module only judges them: a package whose manifest is wrong, whose module cannot start, or
 * which asks for a newer Client, is listed as broken with every reason, so Settings can say why
 * it is missing rather than the Client failing to open a graph.
 */
import { type ExtensionModule, type ExtensionPackage, readExtensionPackage } from '@appsoftwareltd/etherpk-extension-api'

/**
 * The first path segments of the Client's own workspace routes (`/g/<graph>/d/...` and so on),
 * which no extension may declare as its address. `x` is kept for the Extension Directory's
 * extensions (ADR 0123).
 */
export const RESERVED_SEGMENTS: readonly string[] = ['d', 'a', 't', 'x']

/** One extension the catalogue accepted. */
export type CatalogueEntry =
    | { id: string; package: ExtensionPackage; source: 'compiled-in'; module: ExtensionModule }
    | {
          id: string
          package: ExtensionPackage
          source: 'loaded'
          /** The address its package's root is served at, ending in `/`. */
          base: string
      }

/** One package the catalogue refused, and why. */
export interface BrokenExtension {
    /** The folder or package it came from: what someone fixing it looks for. */
    where: string
    errors: string[]
}

export interface Catalogue {
    extensions: CatalogueEntry[]
    broken: BrokenExtension[]
}

export interface CatalogueInput {
    /** The Client's own version, `x.y.z`. */
    clientVersion: string
    /** Each compiled-in package: its folder under `extensions/`, its package.json and its module. */
    compiledIn: { folder: string; packageJson: unknown; module: unknown }[]
    /** Each loaded package: its package.json and the address its root is served at. */
    loaded: { packageJson: unknown; base: string }[]
}

/** Read and check every built-in extension. Pure, so it is tested without a build. */
export function buildCatalogue(input: CatalogueInput): Catalogue {
    const extensions: CatalogueEntry[] = []
    const broken: BrokenExtension[] = []
    const ids = new Set<string>()
    const segments = new Map<string, string>()

    const admit = (where: string, packageJson: unknown, make: (extension: ExtensionPackage) => CatalogueEntry | string[]) => {
        const read = readExtensionPackage(packageJson)
        if (!read.ok) {
            broken.push({ where, errors: read.errors })
            return
        }
        const made = make(read.extension)
        if (Array.isArray(made)) {
            broken.push({ where, errors: made })
            return
        }
        const errors = clashes(made, ids, segments)
        if (errors.length > 0) {
            broken.push({ where, errors })
            return
        }
        ids.add(made.id)
        for (const view of made.package.manifest.views ?? []) if (view.address) segments.set(view.address.segment, made.id)
        extensions.push(made)
    }

    for (const { folder, packageJson, module } of input.compiledIn) {
        admit(`extensions/${folder}`, packageJson, (extension) =>
            isExtensionModule(module)
                ? { id: extension.manifest.id, package: extension, source: 'compiled-in', module }
                : ['src/extension.ts does not export an activate function.'],
        )
    }
    for (const { packageJson, base } of input.loaded) {
        const where = packageName(packageJson)
        admit(where, packageJson, (extension) => {
            const minimum = extension.manifest.minClientVersion
            if (minimum === undefined) return ['A loaded extension must name its minClientVersion.']
            if (compareVersions(minimum, input.clientVersion) > 0) {
                return [`It needs Client ${minimum} or later, and this Client is ${input.clientVersion}.`]
            }
            return { id: extension.manifest.id, package: extension, source: 'loaded', base }
        })
    }
    return { extensions, broken }
}

/** What an accepted entry would take that is already taken. */
function clashes(entry: CatalogueEntry, ids: Set<string>, segments: Map<string, string>): string[] {
    if (ids.has(entry.id)) return [`The id "${entry.id}" is taken by another extension.`]
    const errors: string[] = []
    for (const view of entry.package.manifest.views ?? []) {
        const segment = view.address?.segment
        if (segment === undefined) continue
        if (RESERVED_SEGMENTS.includes(segment)) errors.push(`The address "/${segment}" is the Client's own.`)
        else if (segments.has(segment)) errors.push(`The address "/${segment}" is taken by ${segments.get(segment)}.`)
    }
    return errors
}

function isExtensionModule(module: unknown): module is ExtensionModule {
    return typeof module === 'object' && module !== null && typeof (module as { activate?: unknown }).activate === 'function'
}

function packageName(packageJson: unknown): string {
    const name = (packageJson as { name?: unknown } | null)?.name
    return typeof name === 'string' && name !== '' ? name : 'an unnamed package'
}

/** Compare two `x.y.z` versions by number: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
    const left = a.split('.').map(Number)
    const right = b.split('.').map(Number)
    for (let part = 0; part < 3; part++) {
        const difference = (left[part] ?? 0) - (right[part] ?? 0)
        if (difference !== 0) return difference
    }
    return 0
}
