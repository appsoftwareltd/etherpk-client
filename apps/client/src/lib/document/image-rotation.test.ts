import { describe, expect, it } from 'vitest'

import { canRotateImageRef, moveReferenceEdits, nextQuarterTurns, rotateAsset, rotatedFileName, undoRotation, type RotationDeps } from './image-rotation'

// Rotating a picture saves the turned picture as a new Asset and moves every reference to the old one
// that EtherPK can read onto it (ADR 0027, amended 2026-11-27). The old Asset is left as it was.

/** Apply edits in the order given (they come last first, so none moves the next). */
function applied(text: string, edits: { from: number; to: number; insert: string }[]): string {
    return edits.reduce((out, e) => out.slice(0, e.from) + e.insert + out.slice(e.to), text)
}

/** A folder-graph style identity: the file name the reference names. */
const identify = (ref: string) => {
    const match = /\.\.\/assets\/([^)#?\s]+)/.exec(ref)
    return match ? match[1] : null
}

describe('which pictures can be rotated', () => {
    for (const ref of ['../assets/beds.a1b2c3d4.png', '../assets/beds.a1b2c3d4.JPG', '../assets/beds.a1b2c3d4.jpeg', '../assets/beds.a1b2c3d4.webp']) {
        it(`a stored PNG, JPEG or WebP: ${ref}`, () => expect(canRotateImageRef(ref)).toBe(true))
    }
    for (const ref of ['../assets/beds.a1b2c3d4.gif', '../assets/plan.a1b2c3d4.svg', 'https://example.com/beds.png', '../assets/notes.a1b2c3d4.pdf']) {
        // A GIF would lose its frames and an SVG would become pixels; a web image is not stored here.
        it(`not ${ref}`, () => expect(canRotateImageRef(ref)).toBe(false))
    }
})

describe('turning', () => {
    it('goes a quarter turn clockwise each time, and back to none after four', () => {
        expect([0, 1, 2, 3].map(nextQuarterTurns)).toEqual([1, 2, 3, 0])
    })

    it('keeps the file name, with the extension of the format it was saved in', () => {
        expect(rotatedFileName('Garden beds.png', 'image/png')).toBe('Garden beds.png')
        expect(rotatedFileName('Garden beds.webp', 'image/png')).toBe('Garden beds.png')
        expect(rotatedFileName('Garden beds.jpeg', 'image/jpeg')).toBe('Garden beds.jpg')
        expect(rotatedFileName('Garden beds', 'image/webp')).toBe('Garden beds.webp')
    })
})

describe('moving the references', () => {
    it('points every reference to the old picture at the new one, keeping its words and its size hint', () => {
        const text = '- ![Beds|800](../assets/beds.png)\n- see [the beds](../assets/beds.png) and ![Shed](../assets/shed.png)'
        expect(applied(text, moveReferenceEdits(text, identify, 'beds.png', '../assets/beds.rot.png'))).toBe(
            '- ![Beds|800](../assets/beds.rot.png)\n- see [the beds](../assets/beds.rot.png) and ![Shed](../assets/shed.png)',
        )
    })

    it('leaves a text with no reference to it unchanged', () => {
        const text = '- ![Shed](../assets/shed.png)\n- water the beans'
        expect(moveReferenceEdits(text, identify, 'beds.png', '../assets/beds.rot.png')).toEqual([])
    })
})

/** A graph in memory: documents by name, assets by reference. */
function graph(documents: Record<string, string>, indexed: string[] | null = Object.keys(documents)) {
    const docs = { ...documents }
    const saved: { name: string; type: string }[] = []
    const deps: RotationDeps = {
        identify,
        readBytes: async (ref) => (identify(ref) ? { bytes: new Uint8Array([1, 2, 3]), name: 'beds.png', type: 'image/png' } : null),
        rotate: async (bytes, type, turns) => ({ bytes: new Uint8Array([...bytes, turns]), type }),
        save: async (file) => {
            saved.push({ name: file.name, type: file.type })
            return { ref: '../assets/beds.rot.png' }
        },
        documentsUsing: async (id) => (indexed === null ? null : indexed.filter((name) => docs[name].includes(id))),
        rewrite: async (concept, edits) => {
            docs[concept] = applied(docs[concept], edits(docs[concept]))
        },
    }
    return { deps, docs, saved }
}

describe('rotating a stored picture', () => {
    it('saves the turned picture as a new file and moves the references in every document that uses it', async () => {
        const { deps, docs, saved } = graph({
            Garden: '- ![Beds|800](../assets/beds.png)',
            Kitchen: '- the plan: ![Beds](../assets/beds.png)',
            Shed: '- ![Shed](../assets/shed.png)',
        })
        const result = await rotateAsset(deps, { ref: '../assets/beds.png', turns: 1, concept: 'Garden' })
        expect(saved).toEqual([{ name: 'beds.png', type: 'image/png' }])
        expect(result?.documents).toEqual(['Garden', 'Kitchen'])
        expect(docs).toEqual({
            Garden: '- ![Beds|800](../assets/beds.rot.png)',
            Kitchen: '- the plan: ![Beds](../assets/beds.rot.png)',
            Shed: '- ![Shed](../assets/shed.png)',
        })
    })

    it('includes the document it was rotated in, even before the index has it', async () => {
        const { deps, docs } = graph({ Garden: '- ![Beds](../assets/beds.png)' }, [])
        await rotateAsset(deps, { ref: '../assets/beds.png', turns: 3, concept: 'Garden' })
        expect(docs.Garden).toBe('- ![Beds](../assets/beds.rot.png)')
    })

    it('does nothing for a whole turn', async () => {
        const { deps, saved } = graph({ Garden: '- ![Beds](../assets/beds.png)' })
        expect(await rotateAsset(deps, { ref: '../assets/beds.png', turns: 4, concept: 'Garden' })).toBeNull()
        expect(saved).toEqual([])
    })

    it('refuses while the graph is still being read, before saving anything', async () => {
        const { deps, saved, docs } = graph({ Garden: '- ![Beds](../assets/beds.png)' }, null)
        await expect(rotateAsset(deps, { ref: '../assets/beds.png', turns: 1, concept: 'Garden' })).rejects.toThrow(/still being read/)
        expect(saved).toEqual([])
        expect(docs.Garden).toBe('- ![Beds](../assets/beds.png)')
    })

    it('is undone by moving the references back to the old picture, which was never changed', async () => {
        const { deps, docs } = graph({
            Garden: '- ![Beds|800](../assets/beds.png)',
            Kitchen: '- ![Beds](../assets/beds.png)',
        })
        const result = await rotateAsset(deps, { ref: '../assets/beds.png', turns: 1, concept: 'Garden' })
        await undoRotation(deps, result!)
        expect(docs).toEqual({ Garden: '- ![Beds|800](../assets/beds.png)', Kitchen: '- ![Beds](../assets/beds.png)' })
    })
})
