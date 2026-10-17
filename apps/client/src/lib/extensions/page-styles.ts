/**
 * A loaded extension that mounts in the page (`"isolation": "page"`, ADR 0121's amendment of
 * 2026-10-10): its stylesheets are adopted by the document instead of a shadow root, for a library
 * such as Excalidraw that breaks inside one. So that no rule of it can restyle the Client, every style
 * rule must style only elements with, or inside an element with, a class whose name starts with the
 * extension's id (`.excalidraw`, `.excalidraw-tooltip`, `scopedSelector`). Rules that select nothing
 * (`@font-face`, `@keyframes`, `@property`) pass, and so do grouping rules whose own rules pass. A
 * stylesheet with any other rule is refused, and the extension does not start: Settings names the
 * first rules that failed.
 */
import { extensionStyleSheets } from './styles'

/** What the check reads of a CSS rule: enough to tell a style rule, a group and the rest apart. */
export interface RuleLike {
    readonly cssText: string
    readonly selectorText?: string
    readonly cssRules?: Iterable<RuleLike>
}

/** Split a selector list at its top-level commas, leaving those inside `:is(…)` and the like. */
export function splitSelectors(selectorText: string): string[] {
    const out: string[] = []
    let depth = 0
    let start = 0
    for (let i = 0; i < selectorText.length; i++) {
        const ch = selectorText[i]
        if (ch === '(' || ch === '[') depth++
        else if (ch === ')' || ch === ']') depth--
        else if (ch === ',' && depth === 0) {
            out.push(selectorText.slice(start, i).trim())
            start = i + 1
        }
    }
    out.push(selectorText.slice(start).trim())
    return out.filter((selector) => selector !== '')
}

/** A selector's compound selectors and the combinators between them, read at the top level. */
function compounds(selector: string): { parts: string[]; combinators: string[] } {
    const parts: string[] = []
    const combinators: string[] = []
    let current = ''
    let depth = 0
    let quote: string | null = null
    for (let i = 0; i < selector.length; i++) {
        const ch = selector[i]
        if (quote) {
            current += ch
            if (ch === quote) quote = null
            continue
        }
        if (ch === '"' || ch === "'") quote = ch
        else if (ch === '(' || ch === '[') depth++
        else if (ch === ')' || ch === ']') depth--
        if (depth === 0 && (ch === ' ' || ch === '>' || ch === '~' || ch === '+')) {
            // A run of spaces and at most one combinator between two compounds.
            let combinator = ' '
            let j = i
            while (j < selector.length && /[\s>~+]/.test(selector[j])) {
                if (selector[j] !== ' ') combinator = selector[j]
                j++
            }
            if (current !== '') {
                parts.push(current)
                combinators.push(combinator)
            }
            current = ''
            i = j - 1
            continue
        }
        current += ch
    }
    if (current !== '') parts.push(current)
    return { parts, combinators: combinators.slice(0, Math.max(0, parts.length - 1)) }
}

/**
 * Whether a selector styles only the extension's own elements: the element it styles is, or sits
 * inside, an element with a class whose name starts with `id`. Its first compound selector with
 * such a class (`.excalidraw`, `.excalidraw-tooltip`, `body.excalidraw-cursor-resize`) may come
 * after anything (`:root[dir=rtl] .excalidraw .picker`), and must be followed by a descendant or
 * child combinator, or by nothing: a sibling combinator straight after it (`.excalidraw ~ p`) would
 * reach the Client's elements beside it. Siblings further in (`.excalidraw .tool + .tool`) are inside.
 */
export function scopedSelector(selector: string, id: string): boolean {
    const { parts, combinators } = compounds(selector.trim())
    const owned = new RegExp(`\\.${id}[\\w-]*(?![\\w-])`)
    const first = parts.findIndex((part) => owned.test(part.replace(/\([^)]*\)/g, '')))
    if (first === -1) return false
    const next = combinators[first]
    return next === undefined || next === ' ' || next === '>'
}

/**
 * Whether an `@property` rule registers one of the Client's own custom properties (`--gk-*`, its
 * theme's tokens). A registration applies to the whole document, so an extension's would change how
 * the Client's own styles read the token.
 */
export function claimsClientProperty(cssText: string): boolean {
    return /^@property\s+--gk-/i.test(cssText)
}

/** The rules of a stylesheet that reach outside the extension's own classes, by their text. */
export function scopeViolations(rules: Iterable<RuleLike>, id: string): string[] {
    const out: string[] = []
    for (const rule of rules) {
        const text = rule.cssText
        if (typeof rule.selectorText === 'string') {
            // A style rule (or a page rule, which selects pages and is refused with the rest).
            const unscoped = splitSelectors(rule.selectorText).filter((selector) => !scopedSelector(selector, id))
            if (unscoped.length > 0) out.push(firstLine(text))
            // Nested style rules are relative to their parent, which already passed.
            continue
        }
        if (claimsClientProperty(text)) {
            out.push(firstLine(text))
            continue
        }
        if (/^@(font-face|keyframes|-webkit-keyframes|property|layer\s+[^{]*;|charset)/i.test(text)) continue
        if (/^@import/i.test(text)) {
            out.push(firstLine(text))
            continue
        }
        if (rule.cssRules) {
            out.push(...scopeViolations(rule.cssRules, id))
            continue
        }
        out.push(firstLine(text))
    }
    return out
}

function firstLine(text: string): string {
    const line = text.split('\n')[0]
    return line.length > 80 ? `${line.slice(0, 77)}…` : line
}

/**
 * Fetch an extension's stylesheets, check their scope and have the document adopt them. Resolves to
 * the way to take them back out, or rejects naming the rules that reach outside the extension.
 */
export async function adoptPageStyleSheets(urls: readonly string[], id: string): Promise<() => void> {
    const sheets = await extensionStyleSheets(urls)
    const violations = sheets.flatMap((sheet) => scopeViolations(sheet.cssRules as unknown as Iterable<RuleLike>, id))
    if (violations.length > 0) {
        const shown = violations.slice(0, 3).join(' ')
        throw new Error(`its stylesheet styles things outside .${id} classes, which an extension mounted in the page may not do: ${shown}`)
    }
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, ...sheets]
    return () => {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => !sheets.includes(sheet))
    }
}
