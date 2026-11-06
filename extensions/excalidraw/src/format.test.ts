import { describe, expect, it } from 'vitest'

import {
    drawingAlt,
    drawingBounds,
    type ElementRecord,
    elementLine,
    elementsToSave,
    headerLine,
    identifyDrawing,
    imageAsset,
    imageAssets,
    imageFileId,
    imageReferences,
    imagesToKeep,
    isDrawableSkeleton,
    mergeDrawing,
    newDrawingText,
    objectsOnLine,
    planSkeletonWrite,
    planWrite,
    readDrawing,
    stackedAbove,
    withImageFile,
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

describe('an image in a drawing', () => {
    const ref = '../assets/garden-plan.a1b2c3d4.webp'
    const saved = el('i1', 2, { type: 'image', fileId: 'f1', status: 'saved', customData: { asset: ref } })
    const pasted = el('i2', 1, { type: 'image', fileId: 'f2', status: 'pending' })

    it('names its Asset in its own data, and nothing else does', () => {
        expect(imageAsset(saved)).toBe(ref)
        expect(imageAsset(pasted)).toBeNull()
        expect(imageAsset(el('1', 1, { customData: { asset: ref } }))).toBeNull()
        expect(imageAsset(el('i3', 1, { type: 'image', customData: { asset: 7 } }))).toBeNull()
    })

    it('is written with a reference to its Asset, never with the image itself', () => {
        const [line] = elementsToSave([pasted], new Map([['f2', ref]])).map(elementLine)
        expect(JSON.parse(line)).toMatchObject({ id: 'i2', fileId: 'f2', status: 'saved', customData: { asset: ref } })
        expect(line).not.toContain('data:')
    })

    it('keeps what else its customData holds', () => {
        const [written] = elementsToSave([{ ...pasted, customData: { note: 'keep' } }], new Map([['f2', ref]]))
        expect(written.customData).toEqual({ note: 'keep', asset: ref })
    })

    it('is held back from a save until its Asset is known, and everything else is written', () => {
        const rectangle = el('r1', 1)
        const starting = el('i4', 1, { type: 'image', fileId: null })
        expect(elementsToSave([rectangle, pasted, starting], new Map()).map((e) => e.id)).toEqual(['r1'])
    })

    it('held back and then deleted is passed on as deleted, so a save can tell', () => {
        const gone = { ...pasted, isDeleted: true }
        expect(elementsToSave([gone], new Map())).toEqual([gone])
    })

    it('is to be kept when it has a file and no known Asset, with the reference a paste brought', () => {
        const copied = el('i5', 1, { type: 'image', fileId: 'f5', customData: { asset: '../assets/elsewhere.png' } })
        expect(imagesToKeep([saved, pasted, copied], imageAssets([saved]))).toEqual([
            { fileId: 'f2', claimed: null },
            { fileId: 'f5', claimed: '../assets/elsewhere.png' },
        ])
    })

    it('is not to be kept when deleted, starting, or the same file as one already asked for', () => {
        const again = el('i6', 1, { type: 'image', fileId: 'f2' })
        const gone = el('i7', 1, { type: 'image', fileId: 'f7', isDeleted: true })
        const starting = el('i8', 1, { type: 'image', fileId: null })
        expect(imagesToKeep([pasted, again, gone, starting], new Map())).toEqual([{ fileId: 'f2', claimed: null }])
    })

    it('gets a file id made from its reference where it has none, the same on every device', () => {
        const body = [headerLine(header), elementLine(el('i9', 1, { type: 'image', fileId: null, customData: { asset: ref } }))]
        const [read] = readDrawing(body).elements
        expect(read.fileId).toBe(imageFileId(ref))
        expect(imageFileId(ref)).toBe(imageFileId(ref))
        expect(imageFileId(ref)).not.toBe(imageFileId('../assets/other.png'))
    })

    it('has a file id that can name an element in an SVG', () => {
        expect(imageFileId('../assets/Raised Beds (2).png')).toMatch(/^[a-z][a-z0-9-]*$/)
    })

    it('is listed by its reference for whatever must read it, written by hand or not', () => {
        const byHand = { type: 'image', customData: { asset: '../assets/shed.png' }, x: 0, y: 0, width: 10, height: 10 }
        const body = [headerLine(header), elementLine(saved), JSON.stringify(byHand), elementLine(el('r1', 1))]
        expect(imageReferences(body)).toEqual([ref, '../assets/shed.png'])
    })

    describe('written by hand', () => {
        const byHand = { type: 'image', customData: { asset: ref }, x: 0, y: 0, width: 640, height: 400 }

        it('is drawn only with its Asset and its size', () => {
            expect(isDrawableSkeleton(byHand)).toBe(true)
            expect(isDrawableSkeleton({ type: 'rectangle', x: 0, y: 0 })).toBe(true)
            expect(isDrawableSkeleton({ ...byHand, customData: undefined })).toBe(false)
            expect(isDrawableSkeleton({ type: 'image', customData: { asset: ref }, x: 0, y: 0, width: 640 })).toBe(false)
            expect(isDrawableSkeleton({ ...byHand, height: 0 })).toBe(false)
        })

        it('gets its file and is saved as a reference, as a pasted one is', () => {
            expect(withImageFile(byHand)).toMatchObject({ fileId: imageFileId(ref), status: 'saved', customData: { asset: ref } })
            expect(withImageFile({ type: 'rectangle', x: 0 })).toEqual({ type: 'rectangle', x: 0 })
        })
    })
})

describe('shapes added to a drawing that holds others', () => {
    const made = [el('s1', 1, { index: 'a0' }), el('s2', 1, { index: 'a1' }), el('s3', 1, { index: 'a2' })]

    it('stack above what is there, in the order they were written', () => {
        const existing = [el('1', 1, { index: 'a0' }), el('2', 1, { index: 'a4' })]
        const stacked = stackedAbove(existing, made)
        const all = readDrawing([headerLine(header), ...[...existing, ...stacked].map(elementLine)]).elements
        expect(all.map((e) => e.id)).toEqual(['1', '2', 's1', 's2', 's3'])
    })

    it('stay below anything that would come after the top, and every index is a fraction Excalidraw can read', () => {
        const [first] = stackedAbove([el('2', 1, { index: 'a4' })], made)
        expect(first.index! > 'a4').toBe(true)
        expect(first.index! < 'a5').toBe(true)
        expect(first.index).toMatch(/^a4[1-9A-Za-z]+$/)
    })

    it('come out the same on every device', () => {
        const existing = [el('2', 1, { index: 'a4' })]
        expect(stackedAbove(existing, made)).toEqual(stackedAbove(existing, made))
    })

    it('keep their own indices in an empty drawing', () => {
        expect(stackedAbove([], made)).toEqual(made)
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

    it('says when it holds an image, since no words say what the image shows', () => {
        const image = el('i', 1, { type: 'image', fileId: 'f' })
        expect(drawingAlt([image])).toBe('Drawing with an image')
        expect(drawingAlt([image, el('t', 1, { type: 'text', text: 'Beds' })])).toBe('Drawing with an image: Beds')
        expect(drawingAlt([image, el('j', 1, { type: 'image', fileId: 'g' })])).toBe('Drawing with 2 images')
    })

    it('measures the space the elements take, lines by their points', () => {
        expect(drawingBounds([el('1', 1, { x: 0, y: 0, width: 100, height: 50 }), el('2', 1, { type: 'line', x: 50, y: 10, points: [[0, 0], [100, 80]] })])).toEqual({ width: 150, height: 90 })
        expect(drawingBounds([])).toBeNull()
    })
})
