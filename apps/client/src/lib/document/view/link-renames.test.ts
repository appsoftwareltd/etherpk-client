import { describe, expect, it } from 'vitest'

import type { RenamePlan, RenameStep } from '../../storage/rename'
import { previewPlans, runInOrder, scopeRenamesInTypedName, usesScopeBeyondPage, type RunStatus } from './link-renames'

const step = (from: string, to: string, merges = false): RenameStep => ({ from, to, hasDocument: true, merges, redirects: false, into: to })
const plan = (direct: RenameStep, cascade: RenameStep[] = []): RenamePlan => ({ direct, cascade, aliases: [], aliasOf: null, referencingDocuments: 0, refusal: null })

describe('previewPlans: a row previews what its rename will do after the ticked rows above it', () => {
    // [[Planning [[Garden]]]] → [[Budgeting [[Gardens]]]]: the outer rename runs first and takes
    // the page `Planning [[Garden]]` (and what it scopes) to its new name, so the inner rename no
    // longer cascades into them.
    const outer = plan(step('Planning [[Garden]]', 'Budgeting [[Gardens]]'), [step('[[Planning [[Garden]]]] Notes', '[[Budgeting [[Gardens]]]] Notes')])
    const inner = plan(step('Garden', 'Gardens'), [
        step('Planning [[Garden]]', 'Planning [[Gardens]]'),
        step('[[Planning [[Garden]]]] Notes', '[[Planning [[Gardens]]]] Notes', true),
        step('Theory of [[Garden]]', 'Theory of [[Gardens]]'),
    ])

    it('leaves out of a row\'s cascade the names a ticked row above it renames', () => {
        const [first, second] = previewPlans([
            { plan: outer, ticked: true },
            { plan: inner, ticked: true },
        ])
        expect(first).toBe(outer)
        expect(second?.cascade.map((s) => s.from)).toEqual(['Theory of [[Garden]]'])
    })

    it('keeps them when the row above is unticked, and leaves a row with no plan yet alone', () => {
        const [, second] = previewPlans([
            { plan: outer, ticked: false },
            { plan: inner, ticked: true },
        ])
        expect(second).toBe(inner)
        expect(previewPlans([{ plan: null, ticked: true }, { plan: inner, ticked: true }])[1]).toBe(inner)
    })
})

describe('runInOrder: the ticked renames run in turn and stop at the first failure', () => {
    function rows(...ticked: boolean[]) {
        return ticked.map((t) => ({ ticked: t, status: 'waiting' as RunStatus }))
    }

    it('runs the ticked rows in order and reports each as it lands', async () => {
        const ran: number[] = []
        const reported: string[] = []
        const done = await runInOrder(
            rows(true, false, true),
            async (index) => void ran.push(index),
            (index, status) => reported.push(`${index} ${status}`),
        )
        expect(done).toBe(true)
        expect(ran).toEqual([0, 2])
        expect(reported).toEqual(['0 done', '2 done'])
    })

    it('stops at a failure, and a retry runs the failed row and the ones after it', async () => {
        const state = rows(true, true, true)
        const report = (index: number, status: RunStatus, error: string | null) => {
            state[index] = { ...state[index], status }
            if (error) errors.push(`${index}: ${error}`)
        }
        const errors: string[] = []
        let failSecond = true
        const apply = async (index: number) => {
            if (index === 1 && failSecond) throw new Error('could not be confirmed')
        }
        expect(await runInOrder(state, apply, report)).toBe(false)
        expect(state.map((r) => r.status)).toEqual(['done', 'failed', 'waiting'])
        expect(errors).toEqual(['1: could not be confirmed'])

        failSecond = false
        const ran: number[] = []
        expect(await runInOrder(state, async (index) => void ran.push(index), report)).toBe(true)
        expect(ran).toEqual([1, 2])
        expect(state.map((r) => r.status)).toEqual(['done', 'done', 'done'])
    })
})

/**
 * A page's Rename dialog and its title edit take a whole name (ADR 0065, amended 2026-10-04). The
 * page always takes the name typed; what else the name renames is each scope it changed, read as
 * an edited link reads.
 */
describe('scopeRenamesInTypedName: the scopes a name typed for a page renames', () => {
    it('is the changed scope, not the page', () => {
        expect(scopeRenamesInTypedName('[[Kitchen]] Project', '[[Kitchen 2]] Project')).toEqual([{ before: 'Kitchen', after: 'Kitchen 2' }])
    })

    it('leaves the page out when its own text changed too', () => {
        expect(scopeRenamesInTypedName('[[Kitchen]] Project', '[[Kitchen 2]] Projects')).toEqual([{ before: 'Kitchen', after: 'Kitchen 2' }])
    })

    it('is nothing for a plain retitle, an unlinked scope or the same name', () => {
        expect(scopeRenamesInTypedName('Physics', 'Physical Science')).toEqual([])
        expect(scopeRenamesInTypedName('[[Kitchen]] Project', 'Kitchen Project')).toEqual([])
        expect(scopeRenamesInTypedName('[[Kitchen]] Project', '[[Kitchen]] Project')).toEqual([])
    })
})

/**
 * Whether a document uses a scope on its own, or only as part of the page's name (ADR 0065,
 * amended 2026-10-04): a link to the page carries the scope, and renaming just the page updates
 * that link, so only a use outside such links makes renaming the scope everywhere mean more.
 */
describe('usesScopeBeyondPage: a scope used on its own, not only in links to the page', () => {
    const page = '[[Garden Tools]] Project'

    it('is false for links to the page, and to what the page scopes', () => {
        expect(usesScopeBeyondPage('- see [[[[Garden Tools]] Project]]\n', 'Garden Tools', page)).toBe(false)
        expect(usesScopeBeyondPage('- see [[[[[[Garden Tools]] Project]] Notes]]\n', 'Garden Tools', page)).toBe(false)
        expect(usesScopeBeyondPage('- nothing here\n', 'Garden Tools', page)).toBe(false)
    })

    it('is true for the scope linked on its own, or in another concept\'s name', () => {
        expect(usesScopeBeyondPage('- see [[Garden Tools]]\n', 'Garden Tools', page)).toBe(true)
        expect(usesScopeBeyondPage('- see [[[[Garden Tools]] Ideas]]\n', 'Garden Tools', page)).toBe(true)
        expect(usesScopeBeyondPage('- [[[[Garden Tools]] Project]] and [[Garden Tools]]\n', 'Garden Tools', page)).toBe(true)
    })

    it('reads names case-insensitively and leaves the frontmatter and code out', () => {
        expect(usesScopeBeyondPage('- see [[garden tools]]\n', 'Garden Tools', page)).toBe(true)
        expect(usesScopeBeyondPage('- see [[[[garden tools]] project]]\n', 'Garden Tools', page)).toBe(false)
        expect(usesScopeBeyondPage('---\ntitle: "[[Garden Tools]] Project"\n---\n- body\n', 'Garden Tools', page)).toBe(false)
        expect(usesScopeBeyondPage('- `[[Garden Tools]]`\n', 'Garden Tools', page)).toBe(false)
    })
})
