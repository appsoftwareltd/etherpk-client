import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The stacking order of the layers drawn over a page (layers.css). Toasts sit between a dialog's
// backdrop and its panel, which only works while the numbers keep that order and every surface
// takes its layer from the sheet rather than from a number of its own.

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../../..')

function layers(): Map<string, number> {
    const css = readFileSync(join(here, 'layers.css'), 'utf8')
    return new Map([...css.matchAll(/(--z-[a-z-]+):\s*(\d+);/g)].map((match) => [match[1], Number(match[2])]))
}

describe('layers.css', () => {
    it('stacks window < backdrop < toast < dialog < menu < search', () => {
        const order = ['--z-window', '--z-backdrop', '--z-toast', '--z-dialog', '--z-menu', '--z-search']
        const values = order.map((name) => layers().get(name))
        expect(values.every((value) => value !== undefined), `every layer is defined: ${values.join(', ')}`).toBe(true)
        expect([...values].sort((a, b) => a! - b!)).toEqual(values)
        expect(new Set(values).size).toBe(values.length)
    })

    it.each(['client', 'sync', 'corporate'])('is imported by the %s app stylesheet', (app) => {
        const css = readFileSync(join(repo, 'apps', app, 'src/app.css'), 'utf8')
        expect(css).toMatch(/^@import "@appsoftwareltd\/etherpk-shared\/layers\.css";$/m)
    })

    // A number written into one of these instead of its token is how the order drifts apart.
    it.each([
        ['packages/shared/src/components/Dialog.svelte', ['--z-backdrop', '--z-dialog']],
        ['apps/client/src/lib/activity/ui/ActivityToastHost.svelte', ['--z-toast']],
        ['apps/client/src/lib/surface/ui/ContextMenu.svelte', ['--z-menu']],
        ['apps/client/src/lib/document/view/SearchModal.svelte', ['--z-search']],
        ['apps/client/src/lib/components/FullWindow.svelte', ['--z-window']],
    ])('%s takes its layer from the sheet', (file, tokens) => {
        const source = readFileSync(join(repo, file), 'utf8')
        for (const token of tokens) expect(source).toContain(token)
        expect(source).not.toMatch(/\bz-(50|\[5\d\]|\[6\d\])|z-index:\s*[56]\d\b/)
    })
})
