import { describe, expect, it } from 'vitest'

import type { ConceptCandidate, DbBacklinkGroup, TaskHit } from '$lib/document/index-db'

import { type AgentReadIndex, type AgentReadSource, createDocumentsReader } from './documents-reader'
import { READ_TEXT_CAP } from './read-rules'

const CIPHER = '```etherpk-cipher\nv1:abc\n```'

interface FakeDoc {
    concept: string
    kind: 'page' | 'journal'
    aliases?: string[]
    text: string
    protected?: boolean
}

function fakeGraph(docs: FakeDoc[], extra: Partial<AgentReadIndex> = {}) {
    const source: AgentReadSource = {
        list: () => docs.map((doc) => ({ concept: doc.concept, kind: doc.kind, aliases: doc.aliases ?? [] })),
        async texts(concepts) {
            return new Map(docs.filter((doc) => concepts.includes(doc.concept)).map((doc) => [doc.concept, doc.text]))
        },
    }
    const candidates: ConceptCandidate[] = docs.flatMap((doc) => [
        { display: doc.concept, key: doc.concept.toLowerCase(), kind: doc.kind, ...(doc.protected ? { protected: true as const } : {}) },
        ...(doc.aliases ?? []).map((alias) => ({
            display: alias,
            key: alias.toLowerCase(),
            kind: 'alias' as const,
            canonical: doc.concept,
            ...(doc.protected ? { protected: true as const } : {}),
        })),
    ])
    const index: AgentReadIndex = {
        allConcepts: () => candidates,
        propertyKeys: async () => [],
        propertyMatch: async () => [],
        searchText: async () => ({ groups: [], hasMore: false }),
        searchTextCount: async () => ({ total: 0, capped: false }),
        backlinks: async () => [],
        tasks: async () => ({ hits: [], hasMore: false, total: 0 }),
        ...extra,
    }
    return createDocumentsReader({ source, index: () => index, today: () => '2026-10-15' })
}

describe('the documents reader an Agent Chat reads the graph through (ADR 0147)', () => {
    it('lists journals newest first and then pages by name, a page at a time, with protected documents left out', async () => {
        const reader = fakeGraph([
            { concept: 'Kitchen', kind: 'page', text: '' },
            { concept: '2026-10-14', kind: 'journal', text: '' },
            { concept: 'Garden', kind: 'page', aliases: ['Allotment'], text: '' },
            { concept: 'Diary', kind: 'page', text: CIPHER, protected: true },
            { concept: '2026-10-15', kind: 'journal', text: '' },
        ])
        const all = await reader.list()
        expect(all.documents.map((doc) => doc.name)).toEqual(['2026-10-15', '2026-10-14', 'Garden', 'Kitchen'])
        expect(all.documents[2].aliases).toEqual(['Allotment'])
        expect(all.total).toBe(4)
        const page = await reader.list({ offset: 1, limit: 2 })
        expect(page.documents.map((doc) => doc.name)).toEqual(['2026-10-14', 'Garden'])
        expect(page.hasMore).toBe(true)
        expect((await reader.list({ kind: 'page' })).documents.map((doc) => doc.name)).toEqual(['Garden', 'Kitchen'])
    })

    it('reads a document by its name or an alias, whatever the case, without its frontmatter', async () => {
        const reader = fakeGraph([{ concept: 'Garden', kind: 'page', aliases: ['Allotment'], text: '---\ntitle: Garden\n---\n- water the beans' }])
        expect(await reader.read('garden')).toEqual({ name: 'Garden', kind: 'page', aliases: ['Allotment'], text: '- water the beans', truncated: false })
        expect((await reader.read('ALLOTMENT'))?.name).toBe('Garden')
        expect(await reader.read('Shed')).toBeNull()
    })

    it('never reads a protected document, whether the index flags it or only its text holds a cipher fence', async () => {
        const reader = fakeGraph([
            { concept: 'Diary', kind: 'page', aliases: ['Journal Notes'], text: CIPHER, protected: true },
            { concept: 'Mixed', kind: 'page', text: `- water the beans\n${CIPHER}` },
        ])
        expect(await reader.read('Diary')).toBeNull()
        expect(await reader.read('Journal Notes')).toBeNull()
        expect(await reader.read('Mixed')).toBeNull()
    })

    it('cuts a long document at the cap and says so', async () => {
        const reader = fakeGraph([{ concept: 'Garden', kind: 'page', text: 'x'.repeat(READ_TEXT_CAP + 10) }])
        const read = await reader.read('Garden')
        expect(read?.text.length).toBe(READ_TEXT_CAP)
        expect(read?.truncated).toBe(true)
    })

    it('names the documents a document links to directly: in order, once each, aliases as their pages, and nothing without a page or protected', async () => {
        const reader = fakeGraph([
            {
                concept: 'Garden',
                kind: 'page',
                text: '- [[Kitchen]] and [[allotment shed]]\n- [[Kitchen]] again, [[Nowhere]] and [[Diary]]\n- `[[Code Only]]` and [[Garden]]',
            },
            { concept: 'Kitchen', kind: 'page', text: '' },
            { concept: 'Shed', kind: 'page', aliases: ['Allotment Shed'], text: '' },
            { concept: 'Code Only', kind: 'page', text: '' },
            { concept: 'Diary', kind: 'page', text: CIPHER, protected: true },
        ])
        expect(await reader.links('Garden')).toEqual(['Kitchen', 'Shed'])
        expect(await reader.links('Diary')).toBeNull()
        expect(await reader.links('Nowhere')).toBeNull()
    })

    it('answers a search from the index, leaving out any protected document it names', async () => {
        const reader = fakeGraph([{ concept: 'Garden', kind: 'page', text: '' }, { concept: 'Diary', kind: 'page', text: CIPHER, protected: true }], {
            searchText: async () => ({
                groups: [
                    { concept: 'Garden', kind: 'page', matches: 1, hits: [{ line: 2, breadcrumb: ['Beds'], snippet: [{ text: 'water the ' }, { text: 'beans', match: true }] }] },
                    { concept: 'Diary', kind: 'page', matches: 1, hits: [] },
                ],
                hasMore: false,
            }),
            searchTextCount: async () => ({ total: 2, capped: false }),
        } as unknown as Partial<AgentReadIndex>)
        const found = await reader.search('beans')
        expect(found.results).toEqual([{ name: 'Garden', kind: 'page', matches: 1, hits: [{ line: 2, breadcrumb: ['Beds'], snippet: 'water the beans' }] }])
    })

    it('lists backlinks, but gives nothing for a protected document, not even who links to it', async () => {
        const groups: DbBacklinkGroup[] = [
            {
                sourceConcept: '2026-10-14',
                sourceKind: 'journal',
                refs: [{ sourceConcept: '2026-10-14', sourceKind: 'journal', line: 3, kind: 'block', breadcrumb: [], subtree: [{ text: '- water [[Garden]]' }], context: null }],
                bodyNames: ['garden'],
                sourceIsTarget: false,
                sourceIsTemplate: false,
            } as unknown as DbBacklinkGroup,
        ]
        const reader = fakeGraph(
            [
                { concept: 'Garden', kind: 'page', text: '' },
                { concept: 'Diary', kind: 'page', text: CIPHER, protected: true },
            ],
            { backlinks: async () => groups },
        )
        expect(await reader.backlinks('Garden')).toEqual([{ name: '2026-10-14', kind: 'journal', references: [{ line: 3, breadcrumb: [], text: '- water [[Garden]]' }] }])
        expect(await reader.backlinks('Diary')).toBeNull()
    })

    it("lists tasks with each one's status, open ones unless asked otherwise", async () => {
        let asked: unknown
        const hit = (over: Partial<TaskHit>): TaskHit =>
            ({
                pageId: 1,
                blockLocalId: 1,
                concept: 'Garden',
                kind: 'page',
                line: 4,
                done: false,
                text: 'water the beans',
                priority: null,
                waiting: false,
                doing: false,
                cancelled: false,
                due: null,
                completion: null,
                scheduled: null,
                breadcrumb: [],
                parentTask: null,
                ...over,
            }) as TaskHit
        const reader = fakeGraph([{ concept: 'Garden', kind: 'page', text: '' }], {
            tasks: async (query) => {
                asked = query
                return { hits: [hit({}), hit({ doing: true, priority: 1, due: '2026-10-20' })], hasMore: false, total: 2 }
            },
        })
        const listed = await reader.tasks({ concept: 'Garden' })
        expect(listed.tasks.map((task) => [task.status, task.priority, task.due])).toEqual([
            ['open', null, null],
            ['doing', 1, '2026-10-20'],
        ])
        expect(asked).toMatchObject({ concept: 'Garden', statuses: ['open', 'doing', 'waiting'], today: '2026-10-15' })
    })
})
