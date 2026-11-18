import { describe, expect, it } from 'vitest'

import type { GraphAddress } from '../navigation/graph-address'

import {
    parseTaskReference,
    resolveTaskReference,
    type TaskReference,
    type TaskReferenceSources,
    taskFingerprint,
    taskReferenceId,
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

    it('leave out Free Tags wherever they are, so adding, moving or removing one keeps the fingerprint', async () => {
        expect(taskWords('#P1 Fix the gate #bug')).toBe('Fix the gate')
        const plain = await taskFingerprint('Fix the gate')
        expect(await taskFingerprint('#bug #P1 Fix the gate')).toBe(plain)
        expect(await taskFingerprint('#P1 Fix #bug the gate #paint')).toBe(plain)
    })

    it('are the Free Tags when there is nothing else', () => {
        expect(taskWords('#P1 #bug #paint')).toBe('#bug #paint')
    })

    it('read composed and decomposed accents as the same words', async () => {
        expect(await taskFingerprint(`Caf${String.fromCodePoint(0xe9)} visit`)).toBe(await taskFingerprint(`Cafe${String.fromCodePoint(0x301)} visit`))
    })
})

describe('the reference', () => {
    const reference: TaskReference = { graph: { where: 'sync', name: 'g-1' }, document: '[[Acme]] Launch/Plan', line: 14, fingerprint: '3fa9c1e07b2d' }
    const id = 'etherpk:/graph/sync/g-1/d/%5B%5BAcme%5D%5D%20Launch/Plan#task=14-3fa9c1e07b2d'

    it('is the etherpk: path of the Document URL with the task in its fragment, never a web address', () => {
        expect(taskReferenceId(reference)).toBe(id)
    })

    it('reads back from the etherpk: form', () => {
        expect(parseTaskReference(id)).toEqual(reference)
    })

    it('reads the address a browser shows for the task, with any origin or none', () => {
        expect(parseTaskReference('Send the quote\nhttps://app.example.com/graph/sync/g-1/d/%5B%5BAcme%5D%5D%20Launch/Plan#task=14-3fa9c1e07b2d')).toEqual(reference)
        expect(parseTaskReference('/graph/sync/g-1/d/%5B%5BAcme%5D%5D%20Launch/Plan?autosaveMs=150#task=14-3fa9c1e07b2d')).toEqual(reference)
    })

    it('names a folder graph by its folder, and reads that back', () => {
        const inFolder: TaskReference = { ...reference, graph: { where: 'folder', name: 'Garden Notes' } }
        expect(taskReferenceId(inFolder)).toBe('etherpk:/graph/folder/Garden%20Notes/d/%5B%5BAcme%5D%5D%20Launch/Plan#task=14-3fa9c1e07b2d')
        expect(parseTaskReference(taskReferenceId(inFolder))).toEqual(inFolder)
    })

    it('still reads the shapes before ADR 0192: the etherpk: reference and the web address before it', () => {
        const old: TaskReference = { ...reference, graph: { where: 'legacy', name: 'g-1' } }
        expect(parseTaskReference('etherpk:/g/g-1/d/%5B%5BAcme%5D%5D%20Launch/Plan#task=14-3fa9c1e07b2d')).toEqual(old)
        expect(parseTaskReference('Send the quote\nhttps://app.example.com/g/g-1/d/%5B%5BAcme%5D%5D%20Launch/Plan#task=14-3fa9c1e07b2d')).toEqual(old)
        // Written back as it was read, so a reference a tool echoes still names the same graph.
        expect(taskReferenceId(old)).toBe('etherpk:/g/g-1/d/%5B%5BAcme%5D%5D%20Launch/Plan#task=14-3fa9c1e07b2d')
    })

    it('is nothing when the text holds no reference', () => {
        expect(parseTaskReference('Send the quote')).toBeNull()
        expect(parseTaskReference('https://app.example.com/graph/sync/g-1/d/Acme')).toBeNull()
        expect(parseTaskReference('/graph/sync/g-1/d/Acme#task=14-3fa9')).toBeNull()
        expect(parseTaskReference('/graph/sync/g-1/d/%E0%A4%A#task=1-3fa9c1e07b2d')).toBeNull()
        expect(parseTaskReference('etherpk:/graph/sync/g-1/d/%E0%A4%A#task=1-3fa9c1e07b2d')).toBeNull()
    })
})

describe('resolving', () => {
    /** A graph of documents by name (bodies only), with aliases, served at an address. */
    function graph(bodies: Record<string, string>, options: { served?: GraphAddress; aliases?: Record<string, string> } = {}): TaskReferenceSources {
        const byKey = new Map(Object.keys(bodies).map((name) => [name.toLowerCase(), name]))
        return {
            graph: options.served ?? { where: 'sync', name: 'g-1' },
            resolveDocument: (name) => byKey.get(name.toLowerCase()) ?? byKey.get((options.aliases?.[name] ?? '').toLowerCase()) ?? null,
            readBody: async (document) => bodies[document] ?? null,
            allTasks: async () =>
                Object.entries(bodies).flatMap(([document, body]) =>
                    body.split('\n').flatMap((line, i) => (/^\s*- \[[ xX]\] /.test(line) ? [{ document, line: i, label: line.replace(/^\s*- \[[ xX]\] /, '') }] : [])),
                ),
        }
    }

    async function referenceTo(document: string, line: number, words: string): Promise<TaskReference> {
        return { graph: { where: 'sync', name: 'g-1' }, document, line, fingerprint: await taskFingerprint(words) }
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

    it('refuses a reference to another graph, by where it is kept and by name', async () => {
        const here = await referenceTo('Acme', 0, 'Send the quote')
        const bodies = { Acme: '- [ ] Send the quote' }
        const other: TaskReference = { ...here, graph: { where: 'sync', name: 'g-2' } }
        expect(await resolveTaskReference(other, graph(bodies))).toEqual({ ok: false, code: 'other_graph', served: { where: 'sync', name: 'g-1' } })

        const reports: GraphAddress = { where: 'folder', name: 'reports' }
        const inReports: TaskReference = { ...here, graph: reports }
        expect(await resolveTaskReference(inReports, graph(bodies, { served: reports }))).toMatchObject({ ok: true, foundBy: 'at_line' })
        expect(await resolveTaskReference(inReports, graph(bodies, { served: { where: 'folder', name: 'notes' } }))).toMatchObject({ ok: false, code: 'other_graph' })
        // A synced graph's id that matches a folder's name is still another graph.
        expect(await resolveTaskReference(inReports, graph(bodies, { served: { where: 'sync', name: 'reports' } }))).toMatchObject({ ok: false, code: 'other_graph' })
    })

    it('reads a reference of the shape before ADR 0192: a synced id is checked, a folder is not', async () => {
        const here = await referenceTo('Acme', 0, 'Send the quote')
        const bodies = { Acme: '- [ ] Send the quote' }
        const old: TaskReference = { ...here, graph: { where: 'legacy', name: 'g-1' } }
        expect(await resolveTaskReference(old, graph(bodies))).toMatchObject({ ok: true })
        expect(await resolveTaskReference({ ...old, graph: { where: 'legacy', name: 'g-2' } }, graph(bodies))).toMatchObject({ ok: false, code: 'other_graph' })
        // Each browser gave a folder an id of its own, so the old shape cannot be checked there.
        expect(await resolveTaskReference({ ...old, graph: { where: 'legacy', name: 'anything' } }, graph(bodies, { served: { where: 'folder', name: 'reports' } }))).toMatchObject({ ok: true })
    })
})
