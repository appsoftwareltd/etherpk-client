import { describe, expect, it, vi } from 'vitest'

import { textToPrint } from '#lib/document/print/print-text.js'
import { fenceViewTarget } from '#lib/document/view/fence-hosting.js'

import { graphPrinting, plainPrinting, type GraphPrintParts } from './print-service'

const printPicture = vi.hoisted(() => vi.fn())
// The real renderer, with the part that needs a page replaced.
vi.mock('#lib/document/print/print-document.js', async () => {
    const { renderForPrint } = await import('#lib/document/print/render-for-print.js')
    return {
        printPicture,
        printDocument: async (doc: { name: string; text: string }, deps: { environment: object; onReady: () => void }) => {
            await renderForPrint(doc, deps.environment)
            deps.onReady()
            return 'printed'
        },
    }
})

const CIPHER = '```etherpk-cipher\nabc\n```\n'
const DRAWING = fenceViewTarget({ document: 'Garden', info: 'excalidraw.drawing', id: 'd1' })

function storeOf(text: string, isProtected = false) {
    return { open: () => ({ getText: () => text, isProtected, subscribe: () => () => {} }), whenReady: async () => {} } as never
}

const parts = (over: Partial<GraphPrintParts> = {}): GraphPrintParts => ({
    store: () => storeOf('beans'),
    isProtected: () => false,
    drawing: () => ({}),
    asset: async () => null,
    front: () => null,
    fence: () => null,
    ...over,
})

describe('what a graph prints', () => {
    it('is a document or a drawing in front, and no other View', () => {
        const front = (kind: string, target = 'x') => graphPrinting(parts({ front: () => ({ kind, target }) })).active()
        expect(front('document', 'Garden')).toEqual({ kind: 'document', target: 'Garden' })
        expect(front('fence', DRAWING)).toEqual({ kind: 'fence', target: DRAWING })
        expect(front('kanban.board')).toBeNull()
        expect(graphPrinting(parts()).active()).toBeNull()
    })

    it('is never a Protected Document, nor a drawing in one', () => {
        const printing = graphPrinting(parts({ isProtected: (concept) => concept === 'Garden', fence: () => ({ quote: vi.fn(), identify: vi.fn() }) as never }))
        expect(printing.printable({ kind: 'document', target: 'Garden' })).toBe('protected')
        expect(printing.printable({ kind: 'fence', target: DRAWING })).toBe('protected')
        expect(printing.printable({ kind: 'document', target: 'Kitchen' })).toBe('yes')
    })

    it('leaves a fence that gives no picture to the browser', () => {
        expect(graphPrinting(parts()).printable({ kind: 'fence', target: DRAWING })).toBe('no')
        expect(graphPrinting(parts({ fence: () => ({ identify: vi.fn() }) as never })).printable({ kind: 'fence', target: DRAWING })).toBe('no')
        expect(graphPrinting(parts()).printable({ kind: 'fence', target: 'not a fence' })).toBe('no')
    })

    it('names a drawing by its document', () => {
        expect(graphPrinting(parts()).nameOf({ kind: 'fence', target: DRAWING })).toBe('Garden')
    })
})

describe('what an extension is asked', () => {
    it('is what a quote shows, in the light theme, and never what it would publish', async () => {
        const publish = vi.fn()
        const quote = vi.fn(async () => null)
        const text = ['```excalidraw.drawing', '{}', '```'].join('\n')
        const printing = graphPrinting(parts({ store: () => storeOf(text), fence: () => ({ publish, quote, identify: () => 'd1' }) as never }))
        await expect(printing.print({ kind: 'fence', target: DRAWING }, () => {})).rejects.toThrow('It is empty')
        expect(quote).toHaveBeenCalledWith({ info: 'excalidraw.drawing', body: ['{}'], document: 'Garden', dark: false })
        expect(publish).not.toHaveBeenCalled()
    })
})

describe('protection that arrives while a print is prepared', () => {
    it('keeps the rest of the document from its extensions', async () => {
        let protectedYet = false
        const quote = vi.fn(async () => {
            protectedYet = true
            return null
        })
        const text = ['```excalidraw.drawing', '{"a":1}', '```', '', '```excalidraw.drawing', '{"b":2}', '```'].join('\n')
        const printing = graphPrinting(parts({ store: () => storeOf(text), isProtected: () => protectedYet, fence: () => ({ quote }) as never }))
        await expect(printing.print({ kind: 'document', target: 'Garden' }, () => {})).rejects.toMatchObject({ name: 'ProtectedPrintError' })
        expect(quote).toHaveBeenCalledTimes(1)
    })

    it('keeps a map of the document from being drawn', async () => {
        const renderMap = vi.fn()
        let asked = 0
        const printing = graphPrinting(parts({ store: () => storeOf('```map\npoint 1,2 Shed\n```'), isProtected: () => ++asked > 0, drawing: () => ({ renderMap }) }))
        await printing.print({ kind: 'document', target: 'Garden' }, () => {}).catch(() => {})
        expect(renderMap).not.toHaveBeenCalled()
    })

    it('stops as the dialog is about to open', async () => {
        let isProtected = false
        const shown = vi.fn()
        printPicture.mockImplementation(async (_picture: unknown, options: { onReady: () => void }) => {
            isProtected = true
            options.onReady()
            return 'printed'
        })
        const quote = vi.fn(async () => ({ kind: 'picture', type: 'image/png', bytes: new Uint8Array([1]), width: 1, height: 1, alt: '' }))
        const printing = graphPrinting(parts({ store: () => storeOf('```excalidraw.drawing\n{}\n```'), isProtected: () => isProtected, fence: () => ({ quote, identify: () => 'd1' }) as never }))
        await expect(printing.print({ kind: 'fence', target: DRAWING }, shown)).rejects.toMatchObject({ name: 'ProtectedPrintError' })
        expect(shown).not.toHaveBeenCalled()
    })
})

describe('the text of a document to print', () => {
    it('is refused while it is protected, locked or unlocked, whatever the menus knew', async () => {
        await expect(textToPrint(storeOf(CIPHER), 'Garden')).rejects.toMatchObject({ name: 'ProtectedPrintError' })
        await expect(textToPrint(storeOf('secret beans', true), 'Garden')).rejects.toMatchObject({ name: 'ProtectedPrintError' })
        expect(await textToPrint(storeOf('beans'), 'Garden')).toBe('beans')
    })

    it('keeps the document loaded only while it is read', async () => {
        const release = vi.fn()
        await textToPrint({ ...(storeOf('beans') as object), retainDocument: () => release } as never, 'Garden')
        expect(release).toHaveBeenCalledTimes(1)
    })
})

describe('what a Plain Folder prints', () => {
    it('is a file open in the Markdown Editor', () => {
        const printing = plainPrinting({ store: () => null, environment: () => ({}), isMarkdown: (path) => path.endsWith('.md'), file: async () => null, remoteImages: () => false, nameOf: (path) => path, front: () => null })
        expect(printing.printable({ kind: 'document', target: 'a.md' })).toBe('yes')
        expect(printing.printable({ kind: 'document', target: 'a.txt' })).toBe('no')
        expect(printing.printable({ kind: 'fence', target: DRAWING })).toBe('no')
    })
})
