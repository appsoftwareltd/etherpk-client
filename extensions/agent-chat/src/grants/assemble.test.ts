import type { DocumentText, ExtensionDocuments } from '@appsoftwareltd/etherpk-extension-api'
import { describe, expect, it } from 'vitest'

import { assembleContext } from './assemble'
import { instructions } from './instructions'

function documents(texts: Record<string, string>, links: Record<string, string[]> = {}): ExtensionDocuments {
    const read = async (name: string): Promise<DocumentText | null> => (name in texts ? { name, kind: 'page', aliases: [], text: texts[name], truncated: false } : null)
    return {
        list: async () => ({ documents: [], total: 0, hasMore: false }),
        read,
        links: async (name) => (name in texts ? (links[name] ?? []) : null),
        search: async () => ({ results: [], total: 0, hasMore: false }),
        backlinks: async () => [],
        formatGuide: () => '### Document syntax\n\nBullets are `- `.',
        tasks: async () => ({ tasks: [], total: 0, hasMore: false }),
    }
}

describe('what each Context Grant puts in front of the model (ADR 0147)', () => {
    const graph = documents({ Garden: '- water the [[Kitchen]] herbs', Kitchen: '- basil', Shed: '- tools' }, { Garden: ['Kitchen', 'Shed'] })

    it('sends no document for Nothing', async () => {
        const context = await assembleContext('nothing', 'Garden', graph)
        expect(context.documents).toEqual([])
        expect(context.included).toEqual([])
    })

    it("sends the home document's current text for This document", async () => {
        const context = await assembleContext('document', 'Garden', graph)
        expect(context.documents).toEqual([{ name: 'Garden', text: '- water the [[Kitchen]] herbs', truncated: false }])
        expect(context.included).toEqual(['Garden'])
    })

    it('adds every document the home links to directly for its links, and the whole graph', async () => {
        for (const grant of ['links', 'graph'] as const) {
            const context = await assembleContext(grant, 'Garden', graph)
            expect(context.included).toEqual(['Garden', 'Kitchen', 'Shed'])
        }
    })

    it('leaves out what does not fit the budget, and says so, rather than cutting a document short', async () => {
        const big = documents({ Garden: 'g', Kitchen: 'k'.repeat(50), Shed: 's'.repeat(10) }, { Garden: ['Kitchen', 'Shed'] })
        const context = await assembleContext('links', 'Garden', big, 30)
        expect(context.included).toEqual(['Garden', 'Shed'])
        expect(context.leftOut).toEqual([{ name: 'Kitchen', reason: 'too long' }])
    })

    it("sends only the outline around the chat's bullet for Block siblings and ancestors, as part of the home document", async () => {
        const outline = '- Garden\n  - water the beans'
        const context = await assembleContext('block', 'Garden', graph, undefined, outline)
        expect(context.documents).toEqual([{ name: 'Garden', text: outline, truncated: false, excerpt: true }])
        expect(context.included).toEqual(['Garden'])
    })

    it('sends no outline once the home document cannot be read, as when it has been protected since', async () => {
        const context = await assembleContext('block', 'Gone', graph, undefined, '- the beans')
        expect(context.homeMissing).toBe(true)
        expect(context.documents).toEqual([])
    })

    it('says when the home document can no longer be read', async () => {
        const context = await assembleContext('document', 'Gone', graph)
        expect(context.homeMissing).toBe(true)
        expect(context.documents).toEqual([])
    })
})

describe("the model's instructions", () => {
    it('say it can only read, give the day, and ask for links by their exact name', async () => {
        const text = instructions({ grant: 'document', home: 'Garden', context: await assembleContext('document', 'Garden', documents({ Garden: '- beans' })), today: '2026-10-15', formatGuide: '### Document syntax', canSearchGraph: false })
        expect(text).toContain('2026-10-15')
        expect(text).toContain('only read')
        expect(text).toContain('[[Name]]')
        expect(text).toContain('<document name="Garden">\n- beans\n</document>')
        expect(text).toContain('### Document syntax')
    })

    it('tell the model about its tools only under the whole graph', async () => {
        const graph = documents({ Garden: '- beans' })
        const withTools = instructions({ grant: 'graph', home: 'Garden', context: await assembleContext('graph', 'Garden', graph), today: '2026-10-15', formatGuide: '', canSearchGraph: true })
        const without = instructions({ grant: 'links', home: 'Garden', context: await assembleContext('links', 'Garden', graph), today: '2026-10-15', formatGuide: '', canSearchGraph: false })
        expect(withTools).toContain('search the graph')
        expect(without).not.toContain('search the graph')
    })

    it("say that only part of the document was given under Block siblings and ancestors", async () => {
        const graph = documents({ Garden: '- beans\n- leeks' })
        const text = instructions({ grant: 'block', home: 'Garden', context: await assembleContext('block', 'Garden', graph, undefined, '- beans'), today: '2026-10-15', formatGuide: '', canSearchGraph: false })
        expect(text).toContain('<document name="Garden" part="the outline around the chat">\n- beans\n</document>')
        expect(text).toContain('The rest of the document was not given to you')
        expect(text).not.toContain('leeks')
    })

    it('say a chat without a document was started outside every document, and read nothing of one', async () => {
        const graph = documents({ Garden: '- beans' })
        const context = await assembleContext('graph', null, graph)
        expect(context.documents).toEqual([])
        const text = instructions({ grant: 'graph', home: null, context, today: '2026-10-20', formatGuide: '', canSearchGraph: true })
        expect(text).toContain('outside any of their documents')
        expect(text).toContain('search the graph')
        expect(text).not.toContain('deleted')
    })

    it('say a Draft has no text yet, rather than that it may have been deleted', async () => {
        const graph = documents({})
        const context = await assembleContext('document', '2026-10-16', graph)
        const draft = instructions({ grant: 'document', home: '2026-10-16', context, homeUnwritten: true, today: '2026-10-16', formatGuide: '', canSearchGraph: false })
        expect(draft).toContain('a new document called "2026-10-16", which has no text yet')
        expect(draft).not.toContain('deleted')
        const gone = instructions({ grant: 'document', home: '2026-10-16', context, today: '2026-10-16', formatGuide: '', canSearchGraph: false })
        expect(gone).toContain('deleted')
    })

        it('give no notes and no format guide for Nothing', async () => {
        const text = instructions({ grant: 'nothing', home: 'Garden', context: await assembleContext('nothing', 'Garden', documents({})), today: '2026-10-15', formatGuide: '### Document syntax', canSearchGraph: false })
        expect(text).not.toContain('<document')
        expect(text).not.toContain('### Document syntax')
        expect(text).toContain('has not given you any of their notes')
    })
})
