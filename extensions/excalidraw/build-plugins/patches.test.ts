import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ALL_PATCHES, CODE_PATCHES, FONT_PATCH, missingPatches, patchExcalidrawCode } from './patches'

// The patches run against the Excalidraw this repository pins, so a new version that moves the code
// they change fails here first, as well as in the build.
// Found from the package's entry, which a test runner may resolve to either build.
const entry = createRequire(import.meta.url).resolve('@excalidraw/excalidraw')
const production = join(entry.slice(0, entry.lastIndexOf(`${sep}dist${sep}`)), 'dist', 'prod')
const codeFiles = readdirSync(production).filter((file) => file.endsWith('.js'))
const fontFiles = (function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [relative(join(production, 'fonts'), join(dir, entry.name))]))
})(join(production, 'fonts'))

const address = (font: string) => `ADDRESS(${font})`

describe('patching Excalidraw', () => {
    const results = codeFiles.map((file) => patchExcalidrawCode(readFileSync(join(production, file), 'utf8'), address))
    const applied = new Set(results.flatMap((result) => [...result.applied]))

    it('applies every patch to the pinned production build', () => {
        expect(missingPatches(applied)).toEqual([])
    })

    it('applies each code patch exactly once', () => {
        for (const patch of CODE_PATCHES) {
            const count = codeFiles.reduce((sum, file) => sum + readFileSync(join(production, file), 'utf8').split(patch.find).length - 1, 0)
            expect(count, patch.name).toBe(1)
        }
    })

    it('gives every font the code names an address of its own, and leaves no font named relative to the package', () => {
        const named = results.flatMap((result) => result.fonts)
        expect(named.length).toBeGreaterThan(200)
        expect(new Set(named).size).toBe(named.length)
        for (const font of named) expect(fontFiles).toContain(font)
        for (const result of results) {
            expect(result.code).not.toMatch(/"\.\/fonts\//)
            for (const font of result.fonts) expect(result.code).toContain(`ADDRESS(${font})`)
        }
    })

    it('names no CDN for a font once patched', () => {
        for (const result of results) expect(result.code).not.toContain('ASSETS_FALLBACK_URL))')
    })

    it('reports what did not apply to code that has none of it', () => {
        const result = patchExcalidrawCode('const unrelated = 1', address)
        expect(result.code).toBe('const unrelated = 1')
        expect(missingPatches(result.applied)).toEqual(ALL_PATCHES)
    })

    it('rewrites a font name wherever it is, and nothing else', () => {
        const result = patchExcalidrawCode('var a="./fonts/Virgil/Virgil-Regular.woff2";var b="./font.woff2"', address)
        expect(result.code).toBe('var a=ADDRESS(Virgil/Virgil-Regular.woff2);var b="./font.woff2"')
        expect(result.fonts).toEqual(['Virgil/Virgil-Regular.woff2'])
        expect(result.applied).toEqual(new Set([FONT_PATCH]))
    })
})
