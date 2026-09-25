#!/usr/bin/env node
/**
 * Remove build-time tooling from a `pnpm deploy --prod` bundle before it ships.
 *
 * `--prod` prunes the resolvable tree correctly - the Client's deploy links 17 top-level
 * packages, all genuine runtime dependencies - but compilers and bundlers still come along for
 * the ride. They are not orphans that reachability analysis could find: `@sveltejs/kit`
 * declares `typescript` as a dependency and `vite` declares `esbuild`, so the graph edges are
 * real. What is not real is the need for them once `adapter-node` has produced `build/`,
 * because nothing on the serving path imports a compiler.
 *
 * That makes this a deliberate list rather than something derivable, so two things keep it
 * honest: every entry is named with the reason it is build-only, and both callers boot the
 * bundle and serve a page afterwards. Removing something that turns out to be needed fails
 * that smoke test rather than reaching a user.
 *
 * Two layouts have to be handled, because the two callers deploy differently. The image keeps
 * pnpm's default virtual store, where a package lives at `.pnpm/<name>@<version>/node_modules/`
 * and `@scope/name` is encoded `@scope+name`. The standalone bundle uses
 * `--config.node-linker=hoisted` for shorter paths (see the bundle job), which produces a flat
 * `node_modules/<name>` and leaves `.pnpm` holding nothing but a lockfile.
 *
 * Usage: node scripts/prune-build-tooling.mjs <bundle-directory>
 */

import { readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Package names to drop, `*` matching any suffix, each with why it is build-only. */
const BUILD_ONLY = [
    ['typescript', 'a compiler; declared by @sveltejs/kit, unused once the build has run'],
    ['tsx', 'a TypeScript runner for config files, not for serving'],
    ['esbuild', "Vite's dependency pre-bundler"],
    ['@esbuild/*', 'per-platform esbuild binaries'],
    ['@rolldown/binding-*', "Vite 8's bundler binding"],
    ['lightningcss*', "Tailwind's CSS transformer, already applied to the built assets"],
    ['@tailwindcss/oxide*', "Tailwind's native scanner, likewise"],
]

const bundle = resolve(process.argv[2] ?? '.')
const modules = join(bundle, 'node_modules')

try {
    statSync(modules)
} catch {
    console.error(`No node_modules at ${modules}.`)
    process.exit(1)
}

function matcher(pattern) {
    if (!pattern.endsWith('*')) return (name) => name === pattern
    const prefix = pattern.slice(0, -1)
    return (name) => name.startsWith(prefix)
}

/** Flat layout: `node_modules/<name>`, with `@scope/` expanded one level. */
function flatMatches(pattern) {
    const slash = pattern.indexOf('/')
    const dir = slash === -1 ? modules : join(modules, pattern.slice(0, slash))
    const matches = matcher(slash === -1 ? pattern : pattern.slice(slash + 1))
    try {
        return readdirSync(dir).filter(matches).map((name) => join(dir, name))
    } catch {
        return []
    }
}

/** Virtual store: `.pnpm/<name>@<version>`, where `@scope/name` is written `@scope+name`. */
function storeMatches(pattern) {
    const store = join(modules, '.pnpm')
    const encoded = pattern.replace('/', '+')
    // The version suffix means an exact name still needs a prefix match, so match on the
    // name up to the version separator rather than on the whole entry.
    const wildcard = encoded.endsWith('*')
    const stem = wildcard ? encoded.slice(0, -1) : `${encoded}@`
    try {
        return readdirSync(store)
            .filter((entry) => entry !== 'lock.yaml' && entry.startsWith(stem))
            .map((entry) => join(store, entry))
    } catch {
        return []
    }
}

let removed = 0

for (const [pattern, reason] of BUILD_ONLY) {
    const paths = [...flatMatches(pattern), ...storeMatches(pattern)]
    for (const path of paths) rmSync(path, { recursive: true, force: true })
    removed += paths.length
    console.log(`${paths.length ? `removed ${paths.length}` : 'not present'}: ${pattern} (${reason})`)
}

console.log(`Removed ${removed} build-only packages.`)
