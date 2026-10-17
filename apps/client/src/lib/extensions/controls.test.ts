import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import controlsCss from '@appsoftwareltd/etherpk-extension-api/controls.css?raw'
import { describe, expect, it } from 'vitest'

/**
 * EtherPK's control classes (`controls.css` in the Extension API package, ADR 0151), which every
 * extension shadow root and the Client's own pages draw with. It must follow the Client's text and
 * colour rules on its own, since it reaches surfaces the Client's audits never render, and its
 * class names are Stable, so the README lists exactly what it defines.
 */

const appCss = readFileSync(fileURLToPath(new URL('../../app.css', import.meta.url)), 'utf8')
const readme = readFileSync(fileURLToPath(new URL('../../../../../packages/extension-api/README.md', import.meta.url)), 'utf8')

interface Rule {
    selector: string
    /** The at-rules it sits in, outermost first: `@layer components`, `@supports (…)`. */
    within: string[]
    declarations: { property: string; value: string }[]
}

/**
 * The style rules of a stylesheet, each with the at-rules around it, and its top-level statements
 * (`@layer a, b;`). Enough of CSS for this one file: blocks, declarations and comments.
 */
function parse(text: string): { rules: Rule[]; statements: string[] } {
    const source = text.replace(/\/\*[\s\S]*?\*\//g, '')
    const rules: Rule[] = []
    const statements: string[] = []
    const open: string[] = []
    let buffer = ''
    for (const ch of source) {
        if (ch === '{') {
            open.push(buffer.trim())
            buffer = ''
        } else if (ch === '}') {
            const prelude = open.pop()!
            if (!prelude.startsWith('@')) {
                const declarations = buffer
                    .split(';')
                    .map((part) => part.trim())
                    .filter((part) => part.includes(':'))
                    .map((part) => ({ property: part.slice(0, part.indexOf(':')).trim(), value: part.slice(part.indexOf(':') + 1).trim() }))
                rules.push({ selector: prelude, within: [...open], declarations })
            }
            buffer = ''
        } else if (ch === ';' && open.length === 0) {
            statements.push(buffer.trim())
            buffer = ''
        } else buffer += ch
    }
    return { rules, statements }
}

const sheet = parse(controlsCss)
const declarations = sheet.rules.flatMap((rule) => rule.declarations.map((declaration) => ({ ...declaration, selector: rule.selector })))

/** The custom properties `app.css` defines in the top-level blocks with this selector. */
function tokensIn(selector: string): Set<string> {
    const out = new Set<string>()
    for (let start = appCss.indexOf(`\n${selector} {`); start !== -1; start = appCss.indexOf(`\n${selector} {`, start + 1)) {
        const block = appCss.slice(start, appCss.indexOf('\n}', start + 1))
        for (const match of block.matchAll(/(--gk-[a-z0-9-]+)\s*:/g)) out.add(match[1])
    }
    return out
}

describe("EtherPK's control classes", () => {
    it('draw every colour from a token', () => {
        const literal = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab|lch|color)\(|\b(?:white|black|gray|grey|red|blue|green)\b/i
        const offending = declarations.filter(({ value }) => literal.test(value.replace(/var\([^)]*\)/g, '')))
        expect(offending).toEqual([])
    })

    it('use only tokens the Client defines in both themes', () => {
        const used = new Set(declarations.flatMap(({ value }) => [...value.matchAll(/var\((--gk-[a-z0-9-]+)\)/g)].map((match) => match[1])))
        expect(used.size).toBeGreaterThan(10)
        const light = tokensIn(':root')
        const dark = tokensIn('html.dark')
        expect([...used].filter((token) => !light.has(token))).toEqual([])
        expect([...used].filter((token) => !dark.has(token))).toEqual([])
    })

    it('set no text under 14px, and fade none with opacity', () => {
        const pixels = (value: string) => (value.endsWith('rem') ? parseFloat(value) * 16 : value.endsWith('px') ? parseFloat(value) : Number.NaN)
        const sizes = declarations.filter(({ property }) => property === 'font-size')
        expect(sizes.length).toBeGreaterThan(0)
        expect(sizes.filter(({ value }) => !(pixels(value) >= 14))).toEqual([])
        expect(declarations.filter(({ property, value }) => property === 'opacity' && value !== '1')).toEqual([])
    })

    it('are the classes the API README lists, no more and no fewer', () => {
        const defined = new Set(sheet.rules.flatMap((rule) => [...rule.selector.matchAll(/\.(gk-[a-z-]+)/g)].map((match) => match[1])))
        const start = readme.indexOf('\n## Controls')
        const end = readme.indexOf('\n## ', start + 1)
        const listed = new Set([...readme.slice(start, end === -1 ? undefined : end).matchAll(/`(gk-[a-z-]+)`/g)].map((match) => match[1]))
        expect(start).toBeGreaterThan(-1)
        expect([...defined].sort()).toEqual([...listed].sort())
    })

    it("sit in Tailwind's components layer, after Tailwind's layer order", () => {
        expect(sheet.statements[0]).toBe('@layer properties, theme, base, components, utilities')
        expect(sheet.rules.filter((rule) => !rule.within.includes('@layer components')).map((rule) => rule.selector)).toEqual([])
    })
})
