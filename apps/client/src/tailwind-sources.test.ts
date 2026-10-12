import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The Client's stylesheet names the folders, beyond its own, where Tailwind looks for class names
// (`@source` in app.css). A pattern Tailwind reads as matching no file drops every class that only
// those folders use, silently: the compiled-in extensions' Kanban cards lost their padding that way.

const here = dirname(fileURLToPath(import.meta.url))
const requireHere = createRequire(import.meta.url)
// Tailwind's own scanner, reached through the Vite plugin that runs it, so a pattern is read here
// exactly as the build reads it.
const { Scanner } = createRequire(requireHere.resolve('@tailwindcss/vite'))('@tailwindcss/oxide') as {
    Scanner: new (options: { sources: { base: string; pattern: string; negated: boolean }[] }) => { scan(): string[]; files: string[] }
}

/** Every `@source` path in app.css, absolute. */
function sources(): string[] {
    const css = readFileSync(join(here, 'app.css'), 'utf8')
    return [...css.matchAll(/^@source\s+"([^"]+)";/gm)].map((match) => resolve(here, match[1]))
}

/** The folder a source starts in and the pattern beneath it, split at the first glob, as Tailwind splits it. */
function split(path: string): { base: string; pattern: string } {
    const segments = path.split(sep)
    const first = segments.findIndex((segment) => /[*?{[]/.test(segment))
    if (first < 0) return { base: path, pattern: '**/*' }
    return { base: segments.slice(0, first).join(sep), pattern: segments.slice(first).join('/') }
}

function scannedFiles(path: string): string[] {
    const scanner = new Scanner({ sources: [{ ...split(path), negated: false }] })
    scanner.scan()
    return scanner.files
}

describe("the stylesheet's Tailwind sources", () => {
    it('each reach at least one file', () => {
        for (const source of sources()) expect(scannedFiles(source).length, source).toBeGreaterThan(0)
    })

    it("reach every compiled-in extension's components", () => {
        const extensions = resolve(here, '../../../extensions')
        const scanned = new Set(sources().flatMap(scannedFiles))
        const components = readdirSync(extensions).flatMap((name) => {
            const src = join(extensions, name, 'src')
            try {
                return readdirSync(src)
                    .filter((file) => file.endsWith('.svelte'))
                    .map((file) => join(src, file))
            } catch {
                return []
            }
        })
        expect(components.length).toBeGreaterThan(0)
        expect(components.filter((file) => !scanned.has(file))).toEqual([])
    })
})
