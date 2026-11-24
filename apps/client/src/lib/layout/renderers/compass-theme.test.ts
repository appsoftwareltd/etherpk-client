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

    it('never ties with a rule of dockview\'s own on the same element and property', () => {
        // The order-proof rule again, for every other property. Where a rule here and a rule of
        // dockview's score the same and set the same property on the same element, the later sheet
        // wins, and that is this one under `vite dev` and dockview's in a production build. The
        // Primary Sidebar's title row hid its tab's close cross with three classes against
        // dockview's three: hidden in development, drawn in every release.
        //
        // A tie is fixed here by naming more of the chain, as dockview's rule does:
        // `.dv-tab .dv-default-tab .dv-default-tab-action`, not `.dv-default-tab-action` alone.
        const ties: string[] = []
        for (const mine of selectorsOf(css)) {
            for (const theirs of dockviewRules) {
                if (!sameElement(mine.selector, theirs.selector)) continue
                const shared = mine.properties.filter((property) => theirs.properties.includes(property))
                if (shared.length > 0 && specificity(mine.selector) === specificity(theirs.selector)) {
                    ties.push(`${mine.selector}  ties with dockview's  ${theirs.selector}  on ${shared.join(', ')}`)
                }
            }
        }
        expect([...new Set(ties)]).toEqual([])
    })
})

interface CssRule {
    selector: string
    properties: string[]
}

/** Every selector of every rule, with the properties its rule sets. A rule inside `@media` is a rule. */
function selectorsOf(sheet: string): CssRule[] {
    const out: CssRule[] = []
    for (const match of sheet.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = match[1].trim()
        if (selectors.startsWith('@')) continue
        // Custom properties are held by the first test: they are set on the root, by theme class.
        const properties = [...match[2].matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)].map((declaration) => declaration[1]).filter((name) => !name.startsWith('--'))
        for (const selector of selectors.split(',')) out.push({ selector: selector.trim(), properties })
    }
    return out
}

/**
 * Classes dockview's sheet names that the app never puts on an element: its other themes, its
 * spaced layout and vertical tab strips. A rule that needs one can never apply here.
 */
const NEVER_APPLIED = /\.dockview-theme-(?!(?:light|dark)(?![\w-]))[\w-]+|\.dockview-spaced(?![\w-])|\.dv-tabs-container-vertical(?![\w-])/

const dockviewRules = selectorsOf(readFileSync(fileURLToPath(new URL('../../../../node_modules/dockview-core/dist/styles/dockview.css', import.meta.url)), 'utf8')).filter(
    (rule) => !NEVER_APPLIED.test(rule.selector),
)

/** A selector's last compound: the element it styles. */
const subject = (selector: string) => selector.split(/[\s>+~]+/).pop() ?? ''
const classesOf = (compound: string): string[] => compound.match(/\.[\w-]+/g) ?? []
const pseudoOf = (compound: string) => (compound.match(/::?[\w-]+/g) ?? []).join('')

/**
 * Whether a rule here and a rule of dockview's can style the same element: dockview's names no
 * class on it that this one does not, and both name the same state or pseudo-element.
 */
function sameElement(mine: string, theirs: string): boolean {
    const theirClasses = classesOf(subject(theirs))
    const myClasses = classesOf(subject(mine))
    return theirClasses.length > 0 && theirClasses.every((name) => myClasses.includes(name)) && pseudoOf(subject(mine)) === pseudoOf(subject(theirs))
}

/** A selector's specificity as one number: ids, then classes, attributes and pseudo-classes. Neither sheet styles by element name. */
function specificity(selector: string): number {
    const ids = (selector.match(/#[\w-]+/g) ?? []).length
    const classes = (selector.replace(/::[\w-]+/g, '').match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) ?? []).length
    return ids * 1000 + classes
}
