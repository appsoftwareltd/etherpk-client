import { describe, expect, it } from 'vitest'

import { claimsClientProperty, type RuleLike, scopedSelector, scopeViolations, splitSelectors } from './page-styles'

// An extension mounted in the page (ADR 0121, amended 2026-10-10) may style only its own classes.

const style = (selectorText: string): RuleLike => ({ selectorText, cssText: `${selectorText} { color: red; }` })
const group = (header: string, rules: RuleLike[]): RuleLike => ({ cssText: `${header} {\n…`, cssRules: rules })

describe('which selectors stay inside an extension', () => {
    it("are those styling an element with a class whose name starts with the extension's id, or one inside it", () => {
        for (const selector of [
            '.excalidraw',
            '.excalidraw .App-menu',
            '.excalidraw.theme--dark',
            '.excalidraw-tooltip',
            '.excalidraw > .layer-ui',
            '.excalidraw .tool + .tool',
            ':root[dir=rtl] .excalidraw .picker',
            '.ErrorSplash.excalidraw',
            'body.excalidraw-cursor-resize *',
            '.cm-editor .excalidraw',
        ]) {
            expect(scopedSelector(selector, 'excalidraw')).toBe(true)
        }
    })

    it('are not those reaching the Client, its page, or a sibling of the extension', () => {
        for (const selector of ['body', ':root', '*', '.excalidraw ~ p', '.excalidraw + .gk-interactive-fence', 'button', '.excalidra', '.zoom-button', ':root[dir=rtl] .zoom-out-button', ':not(.excalidraw) p']) {
            expect(scopedSelector(selector, 'excalidraw')).toBe(false)
        }
    })

    it('splits a selector list at its top-level commas only', () => {
        expect(splitSelectors('.a, .b:is(.c, .d), [data-x="1,2"]')).toEqual(['.a', '.b:is(.c, .d)', '[data-x="1,2"]'])
    })
})

describe('which rules a page-mounted extension may bring', () => {
    it('allows scoped style rules, fonts, keyframes, properties and groups whose rules pass', () => {
        const rules = [
            style('.excalidraw .App-menu, .excalidraw-tooltip'),
            { cssText: '@font-face { font-family: Excalifont; }' },
            { cssText: '@keyframes excalidraw-spin { from {} to {} }', cssRules: [] },
            { cssText: '@property --excalidraw-x { syntax: "*"; }' },
            group('@media (max-width: 730px)', [style('.excalidraw .mobile-misc-tools')]),
        ]
        expect(scopeViolations(rules, 'excalidraw')).toEqual([])
    })

    it('names every rule that reaches outside, inside groups too, and refuses imports', () => {
        const rules = [style('body'), group('@media print', [style('.excalidraw'), style(':root')]), { cssText: '@import url("other.css");' }]
        expect(scopeViolations(rules, 'excalidraw')).toEqual(['body { color: red; }', ':root { color: red; }', '@import url("other.css");'])
    })

    it("refuses a property that registers one of the Client's own, whose theme depends on it", () => {
        const rules = [{ cssText: '@property --gk-surface-0 { syntax: "*"; }' }]
        expect(scopeViolations(rules, 'excalidraw')).toEqual(['@property --gk-surface-0 { syntax: "*"; }'])
    })
})

describe("the Client's own custom properties", () => {
    it('are those named --gk-, which an extension may not register', () => {
        expect(claimsClientProperty('@property --gk-text-muted { syntax: "*"; }')).toBe(true)
        expect(claimsClientProperty('@property --excalidraw-x { syntax: "*"; }')).toBe(false)
        expect(claimsClientProperty('@property --tw-rotate-x { syntax: "*"; }')).toBe(false)
    })
})
