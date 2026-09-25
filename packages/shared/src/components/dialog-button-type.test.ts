import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { untypedDialogButtons } from '../ui/dialog-buttons'

/**
 * Guards the shared surfaces against the untyped-button trap described in
 * `../ui/dialog-buttons.ts`. Its client-side sibling covers the client's own components.
 *
 * Reusable components are scanned in full, because any of them can be rendered into someone
 * else's dialog. Pages are scanned only inside their dialog snippets: their other buttons sit
 * outside any form, where the HTML default is harmless.
 */

function surfaces(): Array<{ label: string; path: string; wholeFile: boolean }> {
    const root = new URL('../', import.meta.url).pathname
    const collect = (dir: string, wholeFile: boolean) =>
        readdirSync(join(root, dir))
            .filter((name) => name.endsWith('.svelte'))
            .map((name) => ({ label: `${dir}/${name}`, path: join(root, dir, name), wholeFile }))
    return [...collect('components', true), ...collect('pages', false), ...collect('navigation', true)].sort((a, b) =>
        a.label.localeCompare(b.label),
    )
}

describe('shared dialog buttons declare their type', () => {
    it.each(surfaces().map((s) => [s.label, s]))('%s', (_label, surface) => {
        const untyped = untypedDialogButtons(readFileSync(surface.path, 'utf8'), {
            wholeFile: surface.wholeFile,
        })
        expect(untyped, `untyped <button> at line(s) ${untyped.join(', ')}`).toEqual([])
    })
})
