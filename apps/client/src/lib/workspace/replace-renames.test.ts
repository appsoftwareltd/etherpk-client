import { describe, expect, it, vi } from 'vitest'

import { createReplaceRenames, type ReplaceRenamesDeps, type ReplaceRequest } from './replace-renames'

type Plan = ReturnType<ReplaceRequest['plan']>

/** A replace whose plan the test sets, one per call if a list is given, recording what applied. */
function request(plans: Plan | Plan[], applies = true) {
    const queue = Array.isArray(plans) ? [...plans] : [plans]
    const applied: string[] = []
    const req: ReplaceRequest = {
        target: 'Notes',
        plan: () => (queue.length > 1 ? queue.shift()! : queue[0]),
        apply: (mode) => {
            applied.push(mode)
            return applies
        },
    }
    return { req, applied }
}

function deps(overrides: Partial<ReplaceRenamesDeps> = {}) {
    const calls = { asked: [] as unknown[], moved: [] as [string, string][], ran: 0 }
    const d: ReplaceRenamesDeps = {
        sameDocument: () => false,
        usedBeyond: async () => true,
        conceptMoved: async (before, after) => {
            calls.moved.push([before, after])
        },
        ask: async (_target, renames, context) => {
            calls.asked.push({ renames, context })
            return 'confirm'
        },
        runRenames: async () => {
            calls.ran++
        },
        ...overrides,
    }
    return { d, calls }
}

const garden = { edits: [{ before: 'Garden', after: 'Gardens' }], textAfter: '- [[Gardens]]', replaced: 1 }

describe('a replace that changes no link name', () => {
    it('applies at once and asks nothing', async () => {
        const { d, calls } = deps()
        const { req, applied } = request({ edits: [], textAfter: 'Yard', replaced: 1 })
        expect(await createReplaceRenames(d).replace(req)).toEqual({ kind: 'replaced', renamed: false })
        expect(applied).toEqual(['all'])
        expect(calls.asked).toEqual([])
    })

    it('says so when the editor refused the edit', async () => {
        const { d } = deps()
        const { req } = request({ edits: [], textAfter: 'Yard', replaced: 1 }, false)
        expect(await createReplaceRenames(d).replace(req)).toEqual({ kind: 'refused' })
    })
})

describe('a replace that changes a link name', () => {
    it('asks first, with the renames and the size of the replace, before any text changes', async () => {
        const order: string[] = []
        const { d, calls } = deps({
            ask: async (_t, renames, context) => {
                order.push('ask')
                calls.asked.push({ renames, context })
                return 'confirm'
            },
            runRenames: async () => {
                order.push('rename')
            },
        })
        const { req } = request(garden)
        const original = req.apply
        req.apply = (mode) => {
            order.push('apply')
            return original(mode)
        }
        expect(await createReplaceRenames(d).replace(req)).toEqual({ kind: 'replaced', renamed: true })
        expect(order).toEqual(['ask', 'apply', 'rename'])
        expect(calls.asked).toEqual([{ renames: [{ before: 'Garden', after: 'Gardens' }], context: { replaced: 1, notice: null } }])
    })

    it('checks where else the old name is used against the text the replace leaves', async () => {
        const usedBeyond = vi.fn(async () => true)
        const { d } = deps({ usedBeyond })
        await createReplaceRenames(d).replace(request(garden).req)
        expect(usedBeyond).toHaveBeenCalledWith('Notes', 'Garden', '- [[Gardens]]')
    })

    it('changes nothing on Cancel', async () => {
        const { d, calls } = deps({ ask: async () => 'cancel' })
        const { req, applied } = request(garden)
        expect(await createReplaceRenames(d).replace(req)).toEqual({ kind: 'cancelled' })
        expect(applied).toEqual([])
        expect(calls.ran).toBe(0)
    })

    it('replaces outside wikilinks only, and renames nothing, when asked to', async () => {
        const { d, calls } = deps({ ask: async () => 'outside' })
        const { req, applied } = request(garden)
        expect(await createReplaceRenames(d).replace(req)).toEqual({ kind: 'replaced', renamed: false })
        expect(applied).toEqual(['outside-links'])
        expect(calls.ran).toBe(0)
    })

    it('moves a name used nowhere else rather than asking, as an edited link does', async () => {
        const { d, calls } = deps({ usedBeyond: async () => false })
        const { req, applied } = request(garden)
        expect(await createReplaceRenames(d).replace(req)).toEqual({ kind: 'replaced', renamed: false })
        expect(applied).toEqual(['all'])
        expect(calls.asked).toEqual([])
        expect(calls.moved).toEqual([['Garden', 'Gardens']])
    })

    it('asks nothing for a name the same page already has, and nothing for padding', async () => {
        const { d, calls } = deps({ sameDocument: (before, after) => before === 'Garden' && after === 'Yard' })
        const plan = { edits: [{ before: 'Garden', after: 'Yard' }, { before: 'Kitchen', after: 'Kitchen ' }], textAfter: '', replaced: 2 }
        await createReplaceRenames(d).replace(request(plan).req)
        expect(calls.asked).toEqual([])
        expect(calls.moved).toEqual([])
    })

    it('asks again, saying why, when the document changed the renames while the dialog was open', async () => {
        const { d, calls } = deps()
        const changed = { edits: [{ before: 'Garden', after: 'Gardens' }, { before: 'Kitchen', after: 'Kitchens' }], textAfter: '', replaced: 2 }
        const { req, applied } = request([garden, changed, changed])
        expect(await createReplaceRenames(d).replace(req)).toEqual({ kind: 'replaced', renamed: true })
        expect(calls.asked).toHaveLength(2)
        expect(calls.asked[1]).toEqual({
            renames: changed.edits,
            context: { replaced: 2, notice: 'The document changed while this was open. Check the renames again.' },
        })
        expect(applied).toEqual(['all'])
    })

    // A collaborator removed the link while the dialog was open, or the index caught up and the
    // old name turns out to be used nowhere else: there is nothing left to ask, and no empty
    // dialog to show.
    it('replaces without asking again when nothing is left to ask after Confirm', async () => {
        const { d, calls } = deps()
        const gone = { edits: [], textAfter: '', replaced: 1 }
        const { req, applied } = request([garden, gone, gone])
        expect(await createReplaceRenames(d).replace(req)).toEqual({ kind: 'replaced', renamed: false })
        expect(calls.asked).toHaveLength(1)
        expect(applied).toEqual(['all'])
        expect(calls.ran).toBe(0)
    })

    it('says so when the editor refused the edit after the dialog, and renames nothing', async () => {
        const { d, calls } = deps()
        expect(await createReplaceRenames(d).replace(request(garden, false).req)).toEqual({ kind: 'refused' })
        expect(calls.ran).toBe(0)
    })
})
