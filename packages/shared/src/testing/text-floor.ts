/**
 * Keeps an app's source from setting text below the 14px floor or fading it with opacity.
 *
 * Nothing a person reads is smaller than 14px (the journal calendar's labels) or fainter than
 * WCAG's 4.5:1. A rendered audit, which measures each visible text's computed size and contrast
 * in a browser, is the authority on both, because only the page knows what an `em` chain or a
 * library stylesheet comes to. This scan is the fast
 * half: each app runs a unit test built on it, so a size that can be read off the source fails in
 * `pnpm test`, before any browser starts.
 *
 * It is lexical, not a parser, and it refuses four shapes:
 *
 *   - `text-xs`, behind any variant (`sm:text-xs`);
 *   - a literal size under 14px: `font-size: 13px`, `0.8125rem`, `smaller`, a Tailwind
 *     `text-[13px]`, or a custom property that sets one (`--dv-...-font-size: 13px`);
 *   - a relative size under 1em (`0.85em`, `90%`) that is not floored with `max(0.875rem, ...)`,
 *     since it shrinks with whatever it is relative to, the editor zoom included;
 *   - a bare `opacity-N` class (1 to 99) on an element that is not a graphic: fading text with
 *     opacity takes its contrast under 4.5:1 however dark the ink. `opacity-0` and `opacity-100`
 *     hide and show rather than fade, and a class behind a variant (`hover:`, `disabled:`) is a
 *     state, left to the rendered audit.
 *
 * A size built from a variable, `calc()` or a template expression cannot be evaluated here and is
 * left to the rendered audit. A comment reading `text-floor-exempt: <reason>` on the line, or the
 * line above, excuses that line; the reason is the point.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

/** The floor, in CSS px at the default 16px root. */
export const MIN_TEXT_PX = 14
const ROOT_PX = 16

export type TextFloorRule = 'xs-class' | 'small-size' | 'unfloored-em' | 'text-opacity'

export interface TextFloorViolation {
    file: string
    line: number
    rule: TextFloorRule
    /** The offending text, as written. */
    excerpt: string
}

const SOURCE_EXTENSIONS = new Set(['.svelte', '.ts', '.css'])
const EXEMPT = /text-floor-exempt:/
const GRAPHIC_TAGS = new Set(['svg', 'circle', 'path', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'g', 'img', 'video', 'canvas', 'picture'])
const SMALL_KEYWORDS = new Set(['smaller', 'small', 'x-small', 'xx-small'])

// text-floor-exempt: the rule's own pattern names the class it refuses.
const TEXT_XS = /(^|[\s"'`{:])((?:[a-z0-9-]+:)*text-xs)\b/g
const ARBITRARY_SIZE = /(^|[\s"'`{:])text-\[(\d*\.?\d+)(px|rem|em)\]/g
// `font-size:` in CSS, a style attribute or a string, including a custom property named for it.
const CSS_FONT_SIZE = /font-size['"]?\s*:\s*['"]?([^;}"'`\n]+)/g
// `fontSize: '...'` in a CodeMirror theme; an identifier after the colon is not a literal.
const JS_FONT_SIZE = /fontSize\s*:\s*(['"`])([^'"`]*)\1/g
const CLASS_VALUE = /\bclass(?:Name)?\s*=\s*("[^"]*"|'[^']*'|`[^`]*`|\{[^}]*\})/g
const OPACITY_CLASS = /(^|[\s"'`{])opacity-(\d+)\b/g

/** Comments blanked out, keeping every line where it was, so prose cannot pass for a rule. */
function withoutComments(source: string): string {
    const blank = (match: string) => match.replace(/[^\n]/g, ' ')
    return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/<!--[\s\S]*?-->/g, blank)
}

/** What a literal size is, against the floor; null when it cannot be told from the source. */
function judge(raw: string): TextFloorRule | null {
    const value = raw.trim().toLowerCase().replace(/\s*!important$/, '')
    if (value.startsWith('max(')) {
        // A floor: any absolute argument at or over the floor holds the result there.
        const floored = [...value.matchAll(/(\d*\.?\d+)(px|rem)/g)].some(
            ([, n, unit]) => Number(n) * (unit === 'rem' ? ROOT_PX : 1) >= MIN_TEXT_PX,
        )
        return floored ? null : 'unfloored-em'
    }
    if (/[${}]|var\(|calc\(|clamp\(|min\(|inherit|initial|unset|revert/.test(value)) return null
    if (SMALL_KEYWORDS.has(value)) return 'small-size'
    const length = /^(\d*\.?\d+)(px|rem|em|%)$/.exec(value)
    if (!length) return null
    const n = Number(length[1])
    switch (length[2]) {
        case 'px':
            return n < MIN_TEXT_PX ? 'small-size' : null
        case 'rem':
            return n * ROOT_PX < MIN_TEXT_PX ? 'small-size' : null
        case 'em':
            return n < 1 ? 'unfloored-em' : null
        default:
            return n < 100 ? 'unfloored-em' : null
    }
}

/** Every violation in one file's source. `file` is only carried into the result. */
export function findTextFloorViolations(source: string, file: string): TextFloorViolation[] {
    const lines = source.split('\n')
    const exempt = (line: number) => EXEMPT.test(lines[line - 1] ?? '') || EXEMPT.test(lines[line - 2] ?? '')
    const text = withoutComments(source)
    const lineAt = (index: number) => text.slice(0, index).split('\n').length
    const found: TextFloorViolation[] = []
    const add = (index: number, rule: TextFloorRule, excerpt: string) => {
        const line = lineAt(index)
        if (!exempt(line)) found.push({ file, line, rule, excerpt: excerpt.trim() })
    }

    for (const m of text.matchAll(TEXT_XS)) add(m.index + m[1].length, 'xs-class', m[2])
    for (const m of text.matchAll(ARBITRARY_SIZE)) {
        const px = Number(m[2]) * (m[3] === 'px' ? 1 : ROOT_PX)
        if (px < MIN_TEXT_PX) add(m.index + m[1].length, 'small-size', m[0].slice(m[1].length))
    }
    for (const m of text.matchAll(CSS_FONT_SIZE)) {
        const rule = judge(m[1])
        if (rule) add(m.index, rule, m[0])
    }
    for (const m of text.matchAll(JS_FONT_SIZE)) {
        const rule = judge(m[2])
        if (rule) add(m.index, rule, m[0])
    }
    for (const attribute of text.matchAll(CLASS_VALUE)) {
        const before = text.slice(0, attribute.index)
        const tag = /<([a-zA-Z][\w-]*)[^<]*$/.exec(before)?.[1].toLowerCase()
        if (tag && GRAPHIC_TAGS.has(tag)) continue
        for (const m of attribute[1].matchAll(OPACITY_CLASS)) {
            const n = Number(m[2])
            if (n > 0 && n < 100) add(attribute.index + attribute[0].indexOf(attribute[1]) + m.index + m[1].length, 'text-opacity', `opacity-${n}`)
        }
    }
    return found.sort((a, b) => a.line - b.line)
}

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) return name === 'node_modules' || name.startsWith('.') ? [] : sourceFiles(path)
        return SOURCE_EXTENSIONS.has(extname(name)) && !/\.test\.ts$/.test(name) ? [path] : []
    })
}

/** Every violation under the given source directories, test files excepted. */
export function scanTextFloor(roots: string[]): TextFloorViolation[] {
    return roots.flatMap((root) => sourceFiles(root).flatMap((file) => findTextFloorViolations(readFileSync(file, 'utf8'), file)))
}

/** The violations as a readable list, for an assertion's message. */
export function describeTextFloorViolations(violations: TextFloorViolation[]): string {
    return violations.map((v) => `${v.file}:${v.line} ${v.rule}: ${v.excerpt}`).join('\n')
}
