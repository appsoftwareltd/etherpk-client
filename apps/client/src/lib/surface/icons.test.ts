import { afterEach, describe, expect, it, vi } from 'vitest'

import { sanitizedIconMarkup, trustedIconMarkup } from '$lib/security/trusted-types'
import { iconSvg, registerIcons } from './icons'

// Spies on the two ways an icon becomes trusted markup, each still doing its real work.
vi.mock('$lib/security/trusted-types', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/security/trusted-types')>()
    return {
        ...actual,
        trustedIconMarkup: vi.fn(actual.trustedIconMarkup),
        sanitizedIconMarkup: vi.fn(actual.sanitizedIconMarkup),
    }
})

afterEach(() => vi.clearAllMocks())

describe('extension icons under Trusted Types (ADR 0130)', () => {
    it("sends an extension's icon through DOMPurify, never through the Client's pass-through icon policy", () => {
        const undo = registerIcons({ 'kanban.lanes': '<rect x="1" y="1" width="3" height="9"/>' })
        iconSvg('kanban.lanes')
        expect(sanitizedIconMarkup).toHaveBeenCalledWith(expect.stringContaining('<rect x="1" y="1" width="3" height="9"/>'))
        expect(trustedIconMarkup).not.toHaveBeenCalled()
        undo()
    })

    it("keeps the Client's own icons, constant text in this repository, on the pass-through policy", () => {
        iconSvg('task')
        iconSvg('backlinks')
        iconSvg('no-such-icon')
        expect(trustedIconMarkup).toHaveBeenCalledTimes(3)
        expect(sanitizedIconMarkup).not.toHaveBeenCalled()
    })
})

describe('extension icons', () => {
    it("draws an icon an extension's manifest added, under its own name, on the 16-unit grid", () => {
        const undo = registerIcons({ 'kanban.lanes': '<rect x="1" y="1" width="3" height="9"/>' })
        expect(iconSvg('kanban.lanes')).toContain('<rect x="1" y="1" width="3" height="9"/>')
        expect(iconSvg('kanban.lanes')).toContain('viewBox="0 0 16 16"')
        undo()
        expect(iconSvg('kanban.lanes')).toContain('<circle cx="8" cy="8" r="2"')
    })

    it("never lets an extension's icon replace one of the Client's", () => {
        expect(() => registerIcons({ close: '<path d="M1 1"/>' })).toThrow('The icon "close" is the Client\'s own.')
    })
})

describe('iconSvg', () => {
    it('draws the table’s own icons on its 16-unit grid', () => {
        const svg = iconSvg('task')
        expect(svg).toContain('viewBox="0 0 16 16"')
        expect(svg).toContain('stroke-width="1.4"')
    })

    it('draws a Heroicon on its 24-unit grid with the stroke scaled, so it weighs the same beside the others', () => {
        // Heroicons 2.2.0 outline `link`, verbatim.
        const svg = iconSvg('backlinks')
        expect(svg).toContain('viewBox="0 0 24 24"')
        expect(svg).toContain('stroke-width="2.1"')
        expect(svg).toContain('d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"')
        // A caller's own stroke width is scaled the same way.
        expect(iconSvg('backlinks', { strokeWidth: 1.2 })).toContain('stroke-width="1.8"')
    })

    it('escapes the label, the one value in the markup that is not a number or a table entry', () => {
        expect(String(iconSvg('lock', { label: 'A "quoted" <b>name</b> & more' }))).toContain(
            'aria-label="A &quot;quoted&quot; &lt;b&gt;name&lt;/b&gt; &amp; more"',
        )
    })
})
