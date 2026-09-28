import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { describeTextFloorViolations, findTextFloorViolations, scanTextFloor } from './text-floor'

/** The rule names found in one file's source. */
const rules = (source: string, file = 'Example.svelte') => findTextFloorViolations(source, file).map((v) => v.rule)

describe('findTextFloorViolations', () => {
    it('refuses text-xs, whatever variant it hides behind', () => {
        expect(rules('<p class="text-xs text-gray-500">x</p>')).toEqual(['xs-class'])
        expect(rules('<p class="sm:text-xs">x</p>')).toEqual(['xs-class'])
        expect(rules('<p class="text-sm">x</p>')).toEqual([])
    })

    it('refuses an arbitrary Tailwind size under 14px, and allows one at or over it', () => {
        expect(rules('<p class="text-[13px]">x</p>')).toEqual(['small-size'])
        expect(rules('<p class="text-[0.8rem]">x</p>')).toEqual(['small-size'])
        expect(rules('<p class="text-[0.875rem] text-[15px]">x</p>')).toEqual([])
    })

    it('refuses a CSS font size under 14px, in px, rem or a keyword', () => {
        expect(rules('<style>.a { font-size: 13px; }</style>')).toEqual(['small-size'])
        expect(rules('<style>.a { font-size: 0.8125rem; }</style>')).toEqual(['small-size'])
        expect(rules('<style>.a { font-size: smaller; }</style>')).toEqual(['small-size'])
        expect(rules('<style>.a { font-size: 0.875rem; } .b { font-size: 14px; } .c { font-size: 1rem; }</style>')).toEqual([])
    })

    it('refuses a relative size under 1em unless it is floored at 14px', () => {
        expect(rules("const t = { '.a': { fontSize: '0.85em' } }", 'theme.ts')).toEqual(['unfloored-em'])
        expect(rules('<style>.a { font-size: 90%; }</style>')).toEqual(['unfloored-em'])
        expect(rules("const t = { '.a': { fontSize: 'max(0.875rem, 0.85em)' } }", 'theme.ts')).toEqual([])
        expect(rules('<style>.a { font-size: max(14px, 0.9em); } .b { font-size: 1.1em; }</style>')).toEqual([])
    })

    it('checks a custom property that sets a font size, such as a library theme variable', () => {
        expect(rules('.theme { --dv-tabs-and-actions-container-font-size: 13px; }', 'theme.css')).toEqual(['small-size'])
        expect(rules('.theme { --dv-tabs-and-actions-container-font-size: 0.875rem; }', 'theme.css')).toEqual([])
    })

    it('leaves a size it cannot evaluate to the rendered audit', () => {
        expect(rules("const t = { '.a': { fontSize: CODE_FONT_SIZE, x: `${SCALE}em` } }", 'theme.ts')).toEqual([])
        expect(rules('<style>.a { font-size: var(--editor-font-size); } .b { font-size: calc(1em * 0.8); }</style>')).toEqual([])
    })

    it('refuses an opacity class on an element that holds text, and allows it on graphics and states', () => {
        expect(rules('<span class="opacity-70">(Ctrl+K)</span>')).toEqual(['text-opacity'])
        expect(rules('<button class="text-sm opacity-60">Delete</button>')).toEqual(['text-opacity'])
        expect(rules('<svg class="h-4 w-4 opacity-70"></svg><circle class="opacity-25" />')).toEqual([])
        expect(rules('<button class="opacity-0 group-hover:opacity-100 disabled:opacity-40 hover:opacity-80">x</button>')).toEqual([])
    })

    it('ignores anything a comment marks as exempt, with its reason', () => {
        expect(rules('<!-- text-floor-exempt: a measuring probe -->\n<p class="text-xs">x</p>')).toEqual([])
        expect(rules('<style>\n/* text-floor-exempt: a measuring probe */\n.a { font-size: 10px; }\n</style>')).toEqual([])
    })

    it('reports where each violation is', () => {
        const [v] = findTextFloorViolations('<div>\n  <p class="text-xs">x</p>\n</div>', 'src/Example.svelte')
        expect(v).toMatchObject({ file: 'src/Example.svelte', line: 2, rule: 'xs-class' })
        expect(describeTextFloorViolations([v])).toContain('src/Example.svelte:2')
    })
})

describe('the shared package', () => {
    it('sets no text below 14px and fades no text with opacity', () => {
        const violations = scanTextFloor([fileURLToPath(new URL('..', import.meta.url))])
        expect(violations, describeTextFloorViolations(violations)).toEqual([])
    })
})
