import { describe, expect, it } from 'vitest'

import { iconSvg } from './icons'

describe('iconSvg', () => {
    it('draws the table’s own icons on its 16-unit grid', () => {
        const svg = iconSvg('kanban')
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
})
