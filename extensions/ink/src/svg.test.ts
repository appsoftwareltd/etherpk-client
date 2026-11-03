import { describe, expect, it } from 'vitest'

import { readInk, strokeLine, type InkStroke } from './format'
import { outlinePath, strokeOptions, strokePath } from './outline'
import { inkPicture, PICTURE_MARGIN, svgMarkup } from './svg'

const header = (paper = 'plain') => `{"type":"ink.drawing","version":1,"id":"garden0001","paper":"${paper}"}`
const stroke = (id: string, tool: 'pen' | 'highlighter', colour: string, pts: number[], size = 4): string => strokeLine({ id, tool, colour, size, pts } satisfies InkStroke)

const body = [
    header(),
    stroke('aaaaaaaa', 'highlighter', '#ffd43b', [20, 20, 0.5, 120, 20, 0.5], 20),
    stroke('bbbbbbbb', 'pen', '#1971c2', [10, 10, 0.3, 60, 40, 0.8, 110, 10, 0.5], 4),
]

describe('the picture', () => {
    it('is the same for the same body', () => {
        expect(svgMarkup(inkPicture(readInk(body)).root)).toBe(svgMarkup(inkPicture(readInk([...body])).root))
    })

    it('fits its viewBox to the ink, with a margin', () => {
        const picture = inkPicture(readInk(body))
        // The highlighter reaches 10 past its points (half of 20); the margin is added round that.
        expect(picture.view).toEqual({ minX: 8 - PICTURE_MARGIN, minY: 8 - PICTURE_MARGIN, maxX: 130 + PICTURE_MARGIN, maxY: 42 + PICTURE_MARGIN })
        expect(picture.root.attrs.viewBox).toBe('-8 -8 154 66')
        expect(picture.width).toBe(154)
        expect(picture.height).toBe(66)
    })

    it('lays white paper beneath everything, whatever the theme', () => {
        const [paper] = inkPicture(readInk(body)).root.children!
        expect(paper).toEqual({ tag: 'rect', attrs: { x: '-8', y: '-8', width: '154', height: '66', fill: '#ffffff' } })
    })

    it('draws highlighters translucent and beneath the pens', () => {
        const paths = inkPicture(readInk(body)).root.children!.filter((node) => node.tag === 'path')
        expect(paths.map((p) => [p.attrs.fill, p.attrs['fill-opacity']])).toEqual([
            ['#ffd43b', '0.35'],
            ['#1971c2', undefined],
        ])
        expect(paths[1].attrs.d).toMatch(/^M[\d.,-]+ Q.* T.*Z$/)
    })

    it('patterns dotted and lined paper from the sheet’s origin', () => {
        const dotted = svgMarkup(inkPicture(readInk([header('dots'), ...body.slice(1)])).root)
        expect(dotted).toContain('<pattern id="ink-paper" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">')
        expect(dotted).toContain('fill="url(#ink-paper)"')
        const lined = svgMarkup(inkPicture(readInk([header('lines'), ...body.slice(1)])).root)
        expect(lined).toContain('width="32" height="32"')
        expect(svgMarkup(inkPicture(readInk(body)).root)).not.toContain('pattern')
    })

    it('writes a well-formed file that starts with the SVG namespace', () => {
        const markup = svgMarkup(inkPicture(readInk(body)).root)
        expect(markup.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox=')).toBe(true)
        expect(markup.endsWith('</svg>')).toBe(true)
        expect(svgMarkup({ tag: 'text', attrs: { title: '"<Garden>&' } })).toBe('<text title="&quot;&lt;Garden&gt;&amp;"/>')
    })

    it('is a blank sheet of the size asked when nothing is drawn', () => {
        const picture = inkPicture(readInk([header()]), { emptyWidth: 200, emptyHeight: 100 })
        expect(picture.root.attrs.viewBox).toBe('0 0 200 100')
        expect(picture.root.children!.filter((node) => node.tag === 'path')).toHaveLength(0)
    })
})

describe('outlines', () => {
    it('draws a pen without pressure with pressure from its speed, and a highlighter at one width', () => {
        expect(strokeOptions({ tool: 'pen', size: 4, pts: [1, 2, 0.5, 3, 4, 0.5] }).simulatePressure).toBe(true)
        expect(strokeOptions({ tool: 'pen', size: 4, pts: [1, 2, 0.4, 3, 4, 0.5] }).simulatePressure).toBe(false)
        expect(strokeOptions({ tool: 'highlighter', size: 20, pts: [1, 2, 0.4] }).thinning).toBe(0)
    })

    it('draws a stroke too short for an outline as a dot', () => {
        expect(outlinePath([], { x: 10, y: 10, r: 2 })).toBe('M8,10a2,2 0 1,0 4,0a2,2 0 1,0 -4,0Z')
        expect(strokePath({ tool: 'pen', size: 4, pts: [10, 10, 0.5] })).toMatch(/^M/)
    })
})
