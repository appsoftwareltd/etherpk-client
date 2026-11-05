/**
 * Keeps an app's source from drawing a tinted grey, or a pale wash of blue or purple.
 *
 * The interface is black, white and neutral grey (ADR 0179), and the colours that remain are
 * obvious ones with a job: a red error, an amber warning, a blue link. What gets in by accident is
 * the subtle kind. Tailwind's `gray`, `zinc` and `slate`, the hex values copied from them, and an
 * accent mixed down to a tint all read as grey in the source and as a faint blue or purple on the
 * screen. Tailwind's `neutral` scale is the grey to use. A rendered audit (tests-shared/text-audit.ts) measures what the
 * page shows. This scan is the fast half, so a tint that can be read off the source fails in
 * `pnpm test`, before any browser starts.
 *
 * It is lexical, not a parser, and it refuses three shapes:
 *
 *   - a hex or `rgb()` colour that {@link isTinted} calls tinted;
 *   - a Tailwind class on a scale with a blue or purple cast, behind any variant, and `prose-gray`
 *     and its like;
 *   - a wash of the accent, which is the accent's blue at a strength that reads as a tint.
 *
 * A comment reading `tint-exempt: <reason>` on the line, or the line above, excuses that line; the
 * reason is the point.
 */
import { readFileSync } from 'node:fs'

import { sourceFiles, withoutComments } from './text-floor'

export type TintRule = 'tinted-colour' | 'cool-class' | 'accent-wash'

export interface TintViolation {
    file: string
    line: number
    rule: TintRule
    /** The offending text, as written. */
    excerpt: string
}

/** The hues counted as blue through purple, in OKLCH degrees. Cyan and pink fall outside. */
const TINT_HUES = { from: 195, to: 335 }
/** Below this a colour is neutral to the eye. */
const NEUTRAL_CHROMA = 0.0015
/** From here up a colour reads as a colour someone chose, not as a grey gone blue. */
const OBVIOUS_CHROMA = 0.06

function linear(byte: number): number {
    const c = byte / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** Whether a colour is a tinted grey or a pale wash in the blue to purple range. */
export function isTinted([r, g, b]: readonly [number, number, number]): boolean {
    const [R, G, B] = [linear(r), linear(g), linear(b)]
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
    const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
    const chroma = Math.hypot(a, bb)
    if (chroma < NEUTRAL_CHROMA || chroma >= OBVIOUS_CHROMA) return false
    const hue = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360
    return hue >= TINT_HUES.from && hue <= TINT_HUES.to
}

const EXEMPT = /tint-exempt:/
// A `#` after a word character or a `.` is part of a name; `{` after it makes it a selector.
const HEX = /(?<![\w.&])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b(?!\s*\{)/g
const RGB = /\brgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/g
const COOL_CLASS = /(?<![\w-])(?:[a-z0-9-]+:)*!?(?:bg|text|border|ring|from|to|via|fill|stroke|outline|divide|decoration|accent|caret|shadow|placeholder)-(?:gray|slate|zinc|sky|blue|indigo|violet|purple|fuchsia|agent)-\d+(?:\/\d+)?(?![\w-])/g
const TINTED_PROSE = /(?<![\w-])(?:[a-z0-9-]+:)*prose-(?:gray|slate|zinc)(?![\w-])/g
const ACCENT_WASH = /color-mix\([^;\n]*--gk-accent|\(--gk-accent[^)\s]*\)\/\d+/g

function hexBytes(hex: string): [number, number, number] {
    const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join('') : hex
    return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)) as [number, number, number]
}

/** Every violation in one file's source. `file` is only carried into the result. */
export function findTintViolations(source: string, file: string): TintViolation[] {
    const lines = source.split('\n')
    const exempt = (line: number) => EXEMPT.test(lines[line - 1] ?? '') || EXEMPT.test(lines[line - 2] ?? '')
    const text = withoutComments(source).replace(/^[ \t]*\/\/.*$/gm, (line) => ' '.repeat(line.length))
    const found: TintViolation[] = []
    const add = (index: number, rule: TintRule, excerpt: string) => {
        const line = text.slice(0, index).split('\n').length
        if (!exempt(line)) found.push({ file, line, rule, excerpt })
    }

    for (const m of text.matchAll(ACCENT_WASH)) add(m.index, 'accent-wash', m[0])
    // Spans already reported as a wash: the fallback colour inside one is the same finding.
    const washes = [...text.matchAll(ACCENT_WASH)].map((m) => [m.index, m.index + m[0].length])
    const inWash = (index: number) => washes.some(([from, to]) => index >= from && index < to)
    for (const m of text.matchAll(HEX)) if (!inWash(m.index) && isTinted(hexBytes(m[1]))) add(m.index, 'tinted-colour', m[0])
    for (const m of text.matchAll(RGB)) {
        if (!inWash(m.index) && isTinted([Number(m[1]), Number(m[2]), Number(m[3])])) add(m.index, 'tinted-colour', m[0])
    }
    for (const m of text.matchAll(COOL_CLASS)) add(m.index, 'cool-class', m[0])
    for (const m of text.matchAll(TINTED_PROSE)) add(m.index, 'cool-class', m[0])
    return found.sort((a, b) => a.line - b.line)
}

/** Every violation under the given source directories, test files excepted. */
export function scanTints(roots: string[]): TintViolation[] {
    return roots.flatMap((root) => sourceFiles(root).flatMap((file) => findTintViolations(readFileSync(file, 'utf8'), file)))
}

/** The violations as a readable list, for an assertion's message. */
export function describeTintViolations(violations: TintViolation[]): string {
    return violations.map((v) => `${v.file}:${v.line} ${v.rule}: ${v.excerpt}`).join('\n')
}
