import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { describeTintViolations, findTintViolations, isTinted, scanTints, type TintRule } from './no-tint'

const rules = (source: string): TintRule[] => findTintViolations(source, 'file.css').map((violation) => violation.rule)

describe('isTinted', () => {
    it.each([
        ['Tailwind gray-900', [16, 24, 40]],
        ['zinc-900', [24, 24, 27]],
        ['a pale blue wash', [206, 224, 243]],
        ['a navy selection', [44, 70, 95]],
        ['a pale purple wash', [243, 232, 255]],
    ])('calls %s tinted', (_name, rgb) => {
        expect(isTinted(rgb as [number, number, number])).toBe(true)
    })

    it.each([
        ['black', [0, 0, 0]],
        ['white', [255, 255, 255]],
        ['a neutral grey', [115, 115, 115]],
        ['the link blue', [10, 102, 194]],
        ['a saturated purple', [124, 58, 237]],
        ['a warm amber wash', [255, 251, 235]],
        ['a pale red wash', [254, 242, 242]],
        ['a green', [22, 163, 74]],
    ])('leaves %s alone', (_name, rgb) => {
        expect(isTinted(rgb as [number, number, number])).toBe(false)
    })
})

describe('findTintViolations', () => {
    it.each([
        ['a six-digit hex', 'color: #111827;'],
        ['a three-digit hex', 'color: #123;'],
        ['an eight-digit hex', 'background: #cee0f366;'],
        ['a Tailwind arbitrary value', '<div class="dark:bg-[#18181b]/90">'],
        ['a fallback', "color: 'var(--gk-text-muted, #6b7280)'"],
        ['an rgba() with commas', 'border: 1px solid rgba(3, 7, 18, 0.08);'],
        ['an rgb() with spaces', 'background: rgb(3 7 18 / 0.25);'],
    ])('refuses %s', (_name, source) => {
        expect(rules(source)).toEqual(['tinted-colour'])
    })

    it.each([
        ['a neutral hex', 'color: #171717;'],
        ['a saturated blue', 'color: var(--gk-accent, #0a66c2);'],
        ['an amber', 'background: #fcd34d;'],
        ['a selector in a stylesheet', '#main { color: red; }'],
    ])('leaves %s alone', (_name, source) => {
        expect(rules(source)).toEqual([])
    })

    it.each(['bg-gray-900', 'dark:hover:text-gray-400', 'bg-zinc-900/85', 'text-blue-700', 'hover:bg-blue-50', 'ring-blue-600/20', 'dark:!bg-blue-950/70', 'bg-purple-50', 'border-slate-200', 'text-indigo-600', 'text-sky-500', 'bg-violet-100', 'text-fuchsia-600'])(
        'refuses the class %s',
        (name) => {
            expect(rules(`<div class="${name}">`)).toEqual(['cool-class'])
        },
    )

    it.each(['bg-neutral-900', 'text-neutral-500', 'bg-red-50', 'text-amber-700', 'bg-green-50', 'text-blue', 'border-stone-200'])('leaves the class %s alone', (name) => {
        expect(rules(`<div class="${name}">`)).toEqual([])
    })

    it('refuses a typography colour with a tint', () => {
        expect(rules('<div class="prose prose-gray">')).toEqual(['cool-class'])
        expect(rules('<div class="prose prose-neutral">')).toEqual([])
    })

    it.each([
        ['a color-mix', 'background: color-mix(in srgb, var(--gk-accent, #2563eb) 12%, var(--gk-surface-1));'],
        ['a Tailwind opacity', "'bg-(--gk-accent)/5'"],
        ['a Tailwind opacity with a fallback', "'bg-(--gk-accent,#007ACC)/5'"],
    ])('refuses a wash of the accent, as %s', (_name, source) => {
        expect(rules(source)).toEqual(['accent-wash'])
    })

    it('leaves the accent itself alone', () => {
        expect(rules('color: var(--gk-accent, #2563eb); outline: 2px solid var(--gk-accent);')).toEqual([])
        expect(rules("class='border-(--gk-accent) text-(--gk-accent)'")).toEqual([])
    })

    it('ignores comments, and keeps the line numbers', () => {
        const found = findTintViolations('/* #111827 */\n<!-- bg-blue-50 -->\n// #111827\ncolor: #111827;', 'file.css')
        expect(found).toEqual([{ file: 'file.css', line: 4, rule: 'tinted-colour', excerpt: '#111827' }])
    })

    it('takes an exemption with a reason, on the line or the line above', () => {
        expect(rules('color: #111827; /* tint-exempt: a third party logo */')).toEqual([])
        expect(rules('// tint-exempt: a third party logo\ncolor: #111827;')).toEqual([])
        expect(rules('// tint-exempt: a third party logo\n\ncolor: #111827;')).toEqual(['tinted-colour'])
    })
})

describe('the shared package', () => {
    it('draws no tints', () => {
        const violations = scanTints([fileURLToPath(new URL('..', import.meta.url))])
        expect(violations, describeTintViolations(violations)).toEqual([])
    })
})
