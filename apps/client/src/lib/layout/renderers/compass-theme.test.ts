import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The Compass theme has to beat dockview's own base theme on specificity, not on
 * stylesheet order.
 *
 * Both stylesheets define the SAME `--dv-*` variables on the SAME element (dockview's
 * root carries `dockview-theme-light|dark` *and* `dockview-theme-compass`). At equal
 * specificity the later sheet wins, and their order is Vite's to choose: the dev server
 * follows this module's import order (Compass last, Compass wins), while a production
 * build emits two chunks and links the base theme LAST — which handed dockview's
 * literal `white` / `#ececec` back to every tab. Those literals come from the base
 * theme class, which is stamped on when the renderer is built, so the tabs then stopped
 * following the app's light/dark toggle: the bug this guards against.
 *
 * A cheap, order-proof rule keeps that from coming back: every `--dv-*` override must
 * be declared under a selector worth more than one class.
 */

const css = readFileSync(
    fileURLToPath(new URL('./compass-theme.css', import.meta.url)),
    'utf8',
)

/** Every top-level rule as `[selector, body]`, comments stripped. */
function rules(): Array<[string, string]> {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const out: Array<[string, string]> = []
    for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        out.push([match[1].trim(), match[2]])
    }
    return out
}

/** How many classes a selector's most specific compound scores. */
function classCount(selector: string): number {
    // One selector per rule here; each is a simple descendant chain of classes.
    return (selector.match(/\.[A-Za-z_-][\w-]*/g) ?? []).length
}

describe('the Compass dockview theme', () => {
    it('declares every --dv-* override above single-class specificity', () => {
        const weak = rules()
            .filter(([, body]) => /(^|\s|;)--dv-/.test(body))
            .filter(([selector]) => classCount(selector) < 2)
            .map(([selector]) => selector)

        expect(weak).toEqual([])
    })

    it('maps the tab surfaces onto the app tokens rather than fixed colours', () => {
        // The tab backgrounds are resolved through these variables in every case:
        // dockview's own rule for them outscores anything this file writes directly.
        for (const variable of [
            '--dv-activegroup-visiblepanel-tab-background-color',
            '--dv-activegroup-hiddenpanel-tab-background-color',
            '--dv-inactivegroup-visiblepanel-tab-background-color',
            '--dv-inactivegroup-hiddenpanel-tab-background-color',
        ]) {
            expect(css).toMatch(new RegExp(`${variable}:\\s*var\\(--gk-`))
        }
    })
})
