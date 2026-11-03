import { describe, expect, it } from 'vitest'

import {
    drawingAlt,
    drawingBounds,
    type ElementRecord,
    elementLine,
    headerLine,
    identifyDrawing,
    mergeDrawing,
    newDrawingText,
    objectsOnLine,
    planSkeletonWrite,
    planWrite,
    readDrawing,
    withMadeUpIdsFixed,
    withSkeletonIds,
} from './format'

const header = { type: 'excalidraw.drawing' as const, version: 1 as const, id: 'k3j9x2q8ab', background: '#ffffff' }
const el = (id: string, version: number, extra: Record<string, unknown> = {}): ElementRecord => ({ id, type: 'rectangle', version, versionNonce: version * 10, index: `a${id}`, x: 0, y: 0, width: 10, height: 10, ...extra })

/** Apply edits as the Client does: in order, each against the body the last left. */
function apply(body: string[], edits: ReturnType<typeof planWrite>): string[] {
    const next = [...body]
    for (const edit of edits) {
        if (edit.kind === 'insert') next.splice(edit.line, 0, edit.text)
        else {
            expect(next[edit.line]).toBe(edit.expect)
            if (edit.kind === 'replace') next[edit.line] = edit.text
            else next.splice(edit.line, 1)
        }
    }
    return next
}

describe('a new drawing', () => {
    it('is a fence holding its id and settings, which identify it', () => {
        const text = newDrawingText('k3j9x2q8ab')
        const lines = text.split('\n')
        expect(lines[0]).toBe('```excalidraw.drawing')
        expect(lines[2]).toBe('```')
        expect(identifyDrawing(lines.slice(1, 2))).toBe('k3j9x2q8ab')
    })
})

describe('reading a drawing', () => {
    it('reads its settings and one element per line, in stacking order', () => {
        const body = [headerLine(header), elementLine(el('2', 1)), elementLine(el('1', 1))]
        const drawing = readDrawing(body)
        expect(drawing.header).toEqual(header)
        expect(drawing.elements.map((e) => e.id)).toEqual(['1', '2'])
    })

    it('keeps the later version where two lines hold one element, and reads two elements joined on one line', () => {
        const body = [headerLine(header), elementLine(el('1', 2)), elementLine(el('1', 5)) + elementLine(el('2', 1))]
        expect(readDrawing(body).elements.map((e) => [e.id, e.version])).toEqual([
            ['1', 5],
            ['2', 1],
        ])
    })

    it('skips a broken line and a deleted element, and reads the rest', () => {
        const body = [headerLine(header), '{"id":"1",', elementLine(el('2', 1, { isDeleted: true })), elementLine(el('3', 1))]
        expect(readDrawing(body).elements.map((e) => e.id)).toEqual(['3'])
    })

    it('reads text with braces and quotes inside it as one element', () => {
        expect(objectsOnLine(elementLine(el('t', 1, { type: 'text', text: 'Beds {raised} "north"' })))).toHaveLength(1)
    })
})

describe('saving a drawing', () => {
    const body = [headerLine(header), elementLine(el('1', 1)), elementLine(el('2', 1)), elementLine(el('3', 1))]

    it('touches only the lines of elements that changed, removes deleted ones, and adds new ones at the end', () => {
        const edits = planWrite(body, { header, elements: [el('1', 1), el('2', 2), el('3', 2, { isDeleted: true }), el('4', 1)] })
        expect(edits.map((edit) => [edit.kind, edit.line])).toEqual([
            ['remove', 3],
            ['replace', 2],
            ['insert', 3],
        ])
        expect(readDrawing(apply(body, edits)).elements.map((e) => [e.id, e.version])).toEqual([
            ['1', 1],
            ['2', 2],
            ['4', 1],
        ])
    })

    it('changes nothing when nothing changed', () => {
        expect(planWrite(body, { header, elements: [el('1', 1), el('2', 1), el('3', 1)] })).toEqual([])
    })

    it('writes the settings line when the canvas colour changes', () => {
        const edits = planWrite(body, { header: { ...header, background: '#fdf6e3' }, elements: [el('1', 1), el('2', 1), el('3', 1)] })
        expect(edits).toEqual([{ kind: 'replace', line: 0, expect: body[0], text: headerLine({ ...header, background: '#fdf6e3' }) }])
    })

    it('writes one line again for an element a merge left on two', () => {
        const merged = [headerLine(header), elementLine(el('1', 2)), elementLine(el('1', 3))]
        const after = apply(merged, planWrite(merged, { header, elements: [el('1', 3)] }))
        expect(after).toEqual([headerLine(header), elementLine(el('1', 3))])
    })

    it('removes the line of an element only when the person deleted it', () => {
        const edits = planWrite(body, { header, elements: [el('1', 1), el('2', 2, { isDeleted: true }), el('3', 1)] })
        expect(apply(body, edits)).toEqual([headerLine(header), elementLine(el('1', 1)), elementLine(el('3', 1))])
    })

    it('leaves the line of an element Excalidraw did not load, as written', () => {
        // A shape newer than this Excalidraw, or text with no size, which it drops while loading.
        const unknown = elementLine(el('9', 1, { type: 'stickynote' }))
        const withUnknown = [...body, unknown]
        const edits = planWrite(withUnknown, { header, elements: [el('1', 1), el('2', 2), el('3', 1)] })
        expect(apply(withUnknown, edits)).toEqual([headerLine(header), elementLine(el('1', 1)), elementLine(el('2', 2)), elementLine(el('3', 1)), unknown])
    })

    it('leaves every line it could not read, as written', () => {
        const odd = [headerLine(header), '{"id":"1",', elementLine(el('2', 1)), 'a note in words', '', '{"kind":"not a shape"}']
        const edits = planWrite(odd, { header, elements: [el('2', 2)] })
        expect(apply(odd, edits)).toEqual([headerLine(header), '{"id":"1",', elementLine(el('2', 2)), 'a note in words', '', '{"kind":"not a shape"}'])
    })

    it('rewrites only the element on a line that holds other text too', () => {
        const mixed = [headerLine(header), `${elementLine(el('1', 1))} {"id":"broken`]
        const edits = planWrite(mixed, { header, elements: [el('1', 2)] })
        expect(apply(mixed, edits)).toEqual([headerLine(header), `${elementLine(el('1', 2))} {"id":"broken`])
    })

    it('leaves a shape written without its version for the browser to convert', () => {
        const sketch = '{"type":"rectangle","x":0,"y":0,"width":80,"height":40}'
        expect(planWrite([headerLine(header), sketch], { header, elements: [] })).toEqual([])
    })
})

describe('shapes written without Excalidraw’s bookkeeping', () => {
    const sketch = { type: 'rectangle', x: 0, y: 0, width: 80, height: 40, label: { text: 'Beds' } }
    const arrow = { type: 'arrow', x: 100, y: 20, start: { id: 'beds' }, end: { type: 'ellipse' } }

    it('are read apart from the elements, in order', () => {
        const body = [headerLine(header), JSON.stringify(sketch), elementLine(el('1', 1)), JSON.stringify({ id: 'beds', ...sketch }) + JSON.stringify(arrow)]
        const drawing = readDrawing(body)
        expect(drawing.elements.map((e) => e.id)).toEqual(['1'])
        expect(drawing.skeletons).toEqual([sketch, { id: 'beds', ...sketch }, arrow])
    })

    it('get the same ids on every device that reads the same lines', () => {
        const once = withSkeletonIds([sketch, { id: 'beds', ...sketch }, arrow])
        const again = withSkeletonIds([sketch, { id: 'beds', ...sketch }, arrow])
        expect(once).toEqual(again)
        expect(once[1].id).toBe('beds')
        expect(new Set(once.map((s) => s.id)).size).toBe(3)
        expect(withSkeletonIds([{ ...sketch, x: 5 }])[0].id).not.toBe(once[0].id)
    })

    it('give the elements a conversion made up the same ids on every device, references included', () => {
        const made = [
            { id: 'beds', type: 'rectangle', version: 1, versionNonce: 1, boundElements: [{ id: 'Zq4randomLabel', type: 'text' }] },
            { id: 'Zq4randomLabel', type: 'text', version: 1, versionNonce: 1, containerId: 'beds', text: 'Beds' },
            { id: 'Xy9randomArrow', type: 'arrow', version: 1, versionNonce: 1, startBinding: { elementId: 'beds' } },
        ] as ElementRecord[]
        const fixed = withMadeUpIdsFixed(made, new Set(['beds']), 'p1')
        expect(fixed.map((e) => e.id)).toEqual(['beds', 'p1-1', 'p1-2'])
        expect(fixed[0].boundElements).toEqual([{ id: 'p1-1', type: 'text' }])
        expect(fixed[1].containerId).toBe('beds')
    })

    it('are written back as the elements they became, and the lines of any that did not convert stay', () => {
        const body = [headerLine(header), JSON.stringify(sketch), elementLine(el('1', 1)), JSON.stringify(arrow)]
        const converted = [el('s1', 1), el('s2', 1)]
        const edits = planSkeletonWrite(body, (value) => JSON.stringify(value) === JSON.stringify(sketch), converted)
        expect(apply(body, edits)).toEqual([headerLine(header), elementLine(el('1', 1)), JSON.stringify(arrow), elementLine(el('s1', 1)), elementLine(el('s2', 1))])
    })
})

describe('merging a drawing changed elsewhere', () => {
    const base = [el('1', 1), el('2', 1), el('3', 1)]

    it('keeps the later version of an element both sides changed', () => {
        const merged = mergeDrawing(base, [el('1', 3), el('2', 1), el('3', 1)], [el('1', 2), el('2', 1), el('3', 1)])
        expect(merged.find((e) => e.id === '1')?.version).toBe(3)
    })

    it('keeps elements added on either side', () => {
        const merged = mergeDrawing(base, [...base, el('4', 1)], [...base, el('5', 1)])
        expect(merged.map((e) => e.id)).toEqual(['1', '2', '3', '4', '5'])
    })

    it('keeps an element deleted here deleted, though the other side still holds it, so the next save removes it', () => {
        const merged = mergeDrawing(base, [el('1', 1), el('2', 2, { isDeleted: true }), el('3', 1)], [...base, el('5', 1)])
        expect(merged.find((e) => e.id === '2')).toMatchObject({ isDeleted: true })
        expect(merged.map((e) => e.id)).toEqual(['1', '2', '3', '5'])
    })

    it('drops an element deleted elsewhere that was not changed here, and keeps one that was', () => {
        const merged = mergeDrawing(base, [el('1', 1), el('2', 4), el('3', 1)], [el('3', 1)])
        expect(merged.map((e) => e.id)).toEqual(['2', '3'])
    })
})

describe('what a picture of a drawing says', () => {
    it('is the drawing’s words, or that it is a drawing', () => {
        expect(drawingAlt([el('1', 1), el('t', 1, { type: 'text', text: 'Raised\nbeds' }), el('u', 1, { type: 'text', text: 'Compost' })])).toBe('Drawing: Raised beds, Compost')
        expect(drawingAlt([el('1', 1)])).toBe('Drawing')
    })

    it('measures the space the elements take, lines by their points', () => {
        expect(drawingBounds([el('1', 1, { x: 0, y: 0, width: 100, height: 50 }), el('2', 1, { type: 'line', x: 50, y: 10, points: [[0, 0], [100, 80]] })])).toEqual({ width: 150, height: 90 })
        expect(drawingBounds([])).toBeNull()
    })
})
