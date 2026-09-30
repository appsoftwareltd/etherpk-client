import { describe, expect, it } from 'vitest'

import {
    formatTaskReference,
    parseTaskReference,
    resolveTaskReference,
    type TaskReference,
    type TaskReferenceSources,
    taskFingerprint,
    taskWords,
} from './task-reference'

// A Task Reference (ADR 0114): a task handed to an agent as its words and an address, found again
// by position and words. Nothing is written into the document, so the reference has to survive the
// lines added above the task and the tags rewritten on it, and must never land on the wrong task.

describe('the words and the fingerprint', () => {
    it('are the text after the checkbox and the tag run, whitespace collapsed', () => {
        expect(taskWords('#P1 #D   Send  the quote ')).toBe('Send the quote')
        expect(taskWords('Send the quote')).toBe('Send the quote')
    })

    it('stay the same while the tags change, and differ when the words do', async () => {
        const plain = await taskFingerprint('Send the quote')
        expect(plain).toMatch(/^[0-9a-f]{12}$/)
        expect(await taskFingerprint('#P2 #W Send the   quote')).toBe(plain)
        expect(await taskFingerprint('Send the quote today')).not.toBe(plain)
    })

    it('read composed and decomposed accents as the same words', async () => {
        expect(await taskFingerprint(`Caf${String.fromCodePoint(0xe9)} visit`)).toBe(await taskFingerprint(`Cafe${String.fromCodePoint(0x301)} visit`))
    })
})

describe('the reference as copied', () => {
    const reference: TaskReference = { graphId: 'g-1', document: '[[Acme]] Launch/Plan', line: 14, fingerprint: '3fa9c1e07b2d' }

    it('is the words, then the Document URL with the task in its fragment', () => {
        expect(formatTaskReference(reference, '#P1 Send the quote', 'https://app.example.com')).toBe(
            'Send the quote\nhttps://app.example.com/g/g-1/d/%5B%5BAcme%5D%5D%20Launch/Plan#task=14-3fa9c1e07b2d',
        )
    })

    it('reads back from the two lines, the address alone, or a path without an origin', () => {
        const copied = formatTaskReference(reference, 'Send the quote', 'https://app.example.com')
        expect(parseTaskReference(copied)).toEqual(reference)
        expect(parseTaskReference(copied.split('\n')[1])).toEqual(reference)
        expect(parseTaskReference('/g/g-1/d/%5B%5BAcme%5D%5D%20Launch/Plan?fs=opfs#task=14-3fa9c1e07b2d')).toEqual(reference)
    })

    it('is nothing when the text holds no reference', () => {
        expect(parseTaskReference('Send the quote')).toBeNull()
        expect(parseTaskReference('https://app.example.com/g/g-1/d/Acme')).toBeNull()
        expect(parseTaskReference('/g/g-1/d/Acme#task=14-3fa9')).toBeNull()
        expect(parseTaskReference('/g/g-1/d/%E0%A4%A#task=1-3fa9c1e07b2d')).toBeNull()
    })
})

describe('resolving', () => {
    /** A graph of documents by name (bodies only), with aliases, served under `graphId`. */
    function graph(bodies: Record<string, string>, options: { graphId?: string | null; aliases?: Record<string, string> } = {}): TaskReferenceSources {
        const byKey = new Map(Object.keys(bodies).map((name) => [name.toLowerCase(), name]))
        return {
            graphId: options.graphId === undefined ? 'g-1' : options.graphId,
            resolveDocument: (name) => byKey.get(name.toLowerCase()) ?? byKey.get((options.aliases?.[name] ?? '').toLowerCase()) ?? null,
            readBody: async (document) => bodies[document] ?? null,
            allTasks: async () =>
                Object.entries(bodies).flatMap(([document, body]) =>
                    body.split('\n').flatMap((line, i) => (/^\s*- \[[ xX]\] /.test(line) ? [{ document, line: i, label: line.replace(/^\s*- \[[ xX]\] /, '') }] : [])),
                ),
        }
    }

    async function referenceTo(document: string, line: number, words: string): Promise<TaskReference> {
        return { graphId: 'g-1', document, line, fingerprint: await taskFingerprint(words) }
    }

    it('finds the task at its line, whatever its tags now say', async () => {
        const found = await resolveTaskReference(await referenceTo('Acme', 1, 'Send the quote'), graph({ Acme: '- Call\n- [ ] #D #P1 Send the quote' }))
        expect(found).toMatchObject({ ok: true, document: 'Acme', line: 1, foundBy: 'at_line' })
    })

    it('follows the task down its document when lines are added above it', async () => {
        const found = await resolveTaskReference(await referenceTo('Acme', 1, 'Send the quote'), graph({ Acme: '- New\n- Call\n- [ ] Send the quote' }))
        expect(found).toMatchObject({ ok: true, line: 2, foundBy: 'moved' })
    })

    it('follows it to another document, and through a rename or an alias of its own', async () => {
        const moved = await resolveTaskReference(await referenceTo('Acme', 0, 'Send the quote'), graph({ Acme: '- Call', Sales: '- [ ] Send the quote' }))
        expect(moved).toMatchObject({ ok: true, document: 'Sales', line: 0, foundBy: 'other_document' })
        const renamed = await resolveTaskReference(await referenceTo('Acme', 0, 'Send the quote'), graph({ 'Acme Corp': '- [ ] Send the quote' }))
        expect(renamed).toMatchObject({ ok: true, document: 'Acme Corp', foundBy: 'other_document' })
        const aliased = await resolveTaskReference(
            await referenceTo('ACME', 0, 'Send the quote'),
            graph({ 'Acme Corp': '- [ ] Send the quote' }, { aliases: { ACME: 'Acme Corp' } }),
        )
        expect(aliased).toMatchObject({ ok: true, document: 'Acme Corp', foundBy: 'at_line' })
    })

    it('refuses to choose between two tasks with the same words, naming both', async () => {
        const inOne = await resolveTaskReference(await referenceTo('Acme', 5, 'Send the quote'), graph({ Acme: '- [ ] Send the quote\n- [x] Send the quote' }))
        expect(inOne).toEqual({ ok: false, code: 'task_ambiguous', candidates: [{ document: 'Acme', line: 0 }, { document: 'Acme', line: 1 }] })
        const inTwo = await resolveTaskReference(await referenceTo('Gone', 0, 'Send the quote'), graph({ A: '- [ ] Send the quote', B: '- [ ] Send the quote' }))
        expect(inTwo).toMatchObject({ ok: false, code: 'task_ambiguous' })
    })

    it('finds nothing when the words were edited, or the line is inside a code fence', async () => {
        const edited = await resolveTaskReference(await referenceTo('Acme', 0, 'Send the quote'), graph({ Acme: '- [ ] Send the new quote' }))
        expect(edited).toEqual({ ok: false, code: 'task_not_found' })
        const fenced = await resolveTaskReference(await referenceTo('Acme', 1, 'Send the quote'), graph({ Acme: '```\n- [ ] Send the quote\n```' }))
        expect(fenced).toEqual({ ok: false, code: 'task_not_found' })
    })

    it('refuses a reference to another synced graph, and checks none on a folder graph', async () => {
        const other = { ...(await referenceTo('Acme', 0, 'Send the quote')), graphId: 'g-2' }
        expect(await resolveTaskReference(other, graph({ Acme: '- [ ] Send the quote' }))).toEqual({ ok: false, code: 'other_graph', servedGraphId: 'g-1' })
        expect(await resolveTaskReference(other, graph({ Acme: '- [ ] Send the quote' }, { graphId: null }))).toMatchObject({ ok: true, foundBy: 'at_line' })
    })
})
