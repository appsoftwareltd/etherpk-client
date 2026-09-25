/**
 * The pure half of a rename plan: the collision rule, and the one exception to it - a
 * [[Protected Document]] never merges (ADR 0062).
 */
import { describe, expect, it } from 'vitest'

import { planRename, refuseProtectedMerges } from './rename-plan'
import { renameSteps } from './rename'

const plan = (from: string, to: string, concepts: string[]) =>
    planRename({ from, to, concepts, kind: 'page', referencingDocuments: 0 })

describe('refuseProtectedMerges', () => {
    it('lets a plan with no collision through without asking about anyone', async () => {
        const asked: string[] = []
        const input = plan('Notes', 'Diary', ['Notes', 'Vault'])
        const out = await refuseProtectedMerges(input, (c) => (asked.push(c), true))
        expect(out).toBe(input)
        expect(asked).toEqual([])
    })

    it('refuses a rename onto a protected page, naming the page', async () => {
        const out = await refuseProtectedMerges(plan('Notes', 'Vault', ['Notes', 'Vault']), (c) => c === 'Vault')
        expect(out.refusal).toContain('“Vault” is a protected document')
        expect(out.refusal).toContain('merged into')
    })

    it('refuses a protected page being renamed onto a taken name', async () => {
        const out = await refuseProtectedMerges(plan('Vault', 'Notes', ['Notes', 'Vault']), (c) => c === 'Vault')
        expect(out.refusal).toContain('“Vault” is a protected document')
        expect(out.refusal).toContain('“Notes”')
    })

    it('refuses a cascaded collision that touches a protected page, whichever side it is on', async () => {
        const concepts = ['Physics', '[[Physics]] Quantum', '[[Chemistry]] Quantum']
        const absorbedProtected = await refuseProtectedMerges(plan('Physics', 'Chemistry', concepts), (c) => c === '[[Physics]] Quantum')
        expect(absorbedProtected.refusal).toContain('“[[Physics]] Quantum” is a protected document')
        const survivorProtected = await refuseProtectedMerges(plan('Physics', 'Chemistry', concepts), (c) => c === '[[Chemistry]] Quantum')
        expect(survivorProtected.refusal).toContain('“[[Chemistry]] Quantum” is a protected document')
    })

    it('leaves the steps in place so the dialog can still show what would have collided', async () => {
        const out = await refuseProtectedMerges(plan('Notes', 'Vault', ['Notes', 'Vault']), async () => true)
        expect(renameSteps(out).some((s) => s.merges)).toBe(true)
    })

    it('does not second-guess an earlier refusal', async () => {
        const asked: string[] = []
        const refused = { ...plan('Notes', 'Vault', ['Notes', 'Vault']), refusal: 'no' }
        const out = await refuseProtectedMerges(refused, (c) => (asked.push(c), true))
        expect(out.refusal).toBe('no')
        expect(asked).toEqual([])
    })
})

/**
 * A [[Pageless Concept]] renames by rewriting its links (ADR 0064): there is no document to
 * alias, and landing on a taken name is a redirect rather than a [[Merge]].
 */
describe('planRename — a pageless concept', () => {
    const pageless = (from: string, to: string, concepts: string[]) =>
        planRename({ from, to, concepts, kind: null, referencingDocuments: 3 })

    it('plans a plain rename with no document behind the direct step', () => {
        const out = pageless('Physcis', 'Physics', ['Notes'])
        expect(out.refusal).toBeNull()
        expect(out.direct).toEqual({ from: 'Physcis', to: 'Physics', hasDocument: false, merges: false, redirects: false, into: 'Physics' })
        expect(out.referencingDocuments).toBe(3)
    })

    it('redirects rather than merges when the new name already has a page', () => {
        const out = pageless('Physcis', 'Physics', ['Physics', 'Notes'])
        expect(out.refusal).toBeNull()
        expect(out.direct.merges).toBe(false)
        expect(out.direct.redirects).toBe(true)
        // Nothing to join, so nothing for the protected-merge rule to ask about either.
        expect(renameSteps(out).some((s) => s.merges)).toBe(false)
    })

    it('still cascades over documented scoped concepts beneath it, which do merge', () => {
        const out = pageless('Physics', 'Chemistry', ['[[Physics]] Quantum', '[[Chemistry]] Quantum'])
        expect(out.cascade).toHaveLength(1)
        expect(out.cascade[0]).toMatchObject({
            from: '[[Physics]] Quantum',
            to: '[[Chemistry]] Quantum',
            hasDocument: true,
            merges: true,
            redirects: false,
        })
    })

    it('treats a pure re-casing as neither a merge nor a redirect', () => {
        const out = pageless('physics', 'Physics', ['Physics'])
        expect(out.direct).toMatchObject({ merges: false, redirects: false })
    })

    it('refuses a journal-shaped concept even though no entry exists', () => {
        const out = pageless('2026-09-13', 'Launch Day', [])
        expect(out.refusal).toContain('journal entry cannot be renamed')
    })

    it('lets a pageless concept take a day as its new name: only links move, and no page is written', () => {
        const out = pageless('Meetng', '2026-09-01', [])
        expect(out.refusal).toBeNull()
        expect(out.direct).toMatchObject({ hasDocument: false, into: '2026-09-01' })
    })

    it('a documented page landing on a taken name is still a merge, never a redirect', () => {
        const out = plan('Physcis', 'Physics', ['Physcis', 'Physics'])
        expect(out.direct).toMatchObject({ hasDocument: true, merges: true, redirects: false })
    })
})

/**
 * A name is taken by whatever document answers to it, by title OR by alias (ADR 0038 §4 as
 * refined): renaming onto another page's alias merges into that page under ITS title.
 */
describe('planRename — a name held as an alias', () => {
    const aliases = [{ name: 'Agent Accelerated Development', concept: 'Agentic Software Development' }]
    const withAliases = (from: string, to: string, kind: 'page' | null) =>
        planRename({ from, to, concepts: ['Agentic Software Development', 'Vibe Coding'], aliases, kind, referencingDocuments: 0 })

    it('merges a page renamed onto another page\'s alias into that page', () => {
        const out = withAliases('Vibe Coding', 'Agent Accelerated Development', 'page')
        expect(out.refusal).toBeNull()
        expect(out.direct).toMatchObject({
            merges: true,
            redirects: false,
            to: 'Agent Accelerated Development',
            into: 'Agentic Software Development',
        })
    })

    it('redirects a pageless concept renamed onto an alias to the page that answers to it', () => {
        const out = withAliases('Physcis', 'Agent Accelerated Development', null)
        expect(out.direct).toMatchObject({ merges: false, redirects: true, into: 'Agentic Software Development' })
    })

    it('treats a page renamed onto one of its OWN aliases as a plain retitle', () => {
        const out = withAliases('Agentic Software Development', 'Agent Accelerated Development', 'page')
        expect(out.direct).toMatchObject({ merges: false, redirects: false, into: 'Agent Accelerated Development' })
    })

    it('asks the protected-merge rule about the page that answers to the name, not the alias', async () => {
        const asked: string[] = []
        await refuseProtectedMerges(withAliases('Vibe Coding', 'Agent Accelerated Development', 'page'), (c) => (asked.push(c), false))
        expect(asked).toContain('Agentic Software Development')
        expect(asked).not.toContain('Agent Accelerated Development')
    })
})

/**
 * A day is the name of that day's [[Journal Entry]] (ADR 0056), so a page never takes one: the
 * rename would leave a page in `pages/` answering to the day, or merge a page's frontmatter
 * into the journal entry.
 */
describe('planRename — a page renamed to a day', () => {
    it('is refused, naming the day and saying what to do instead', () => {
        const out = plan('Meeting', '2026-09-01', ['Meeting'])
        expect(out.refusal).toContain('“2026-09-01” is a date')
        expect(out.refusal).toContain('journal entry')
        expect(out.refusal).toContain('Choose a different name')
    })

    it('is refused when the day already has an entry, rather than merged into it', () => {
        const out = plan('Meeting', '2026-09-01', ['Meeting', '2026-09-01'])
        expect(out.refusal).toContain('“2026-09-01” is a date')
        expect(renameSteps(out).some((s) => s.merges)).toBe(false)
    })

    it('is refused however the new name is padded', () => {
        expect(plan('Meeting', '  2026-09-01 ', ['Meeting']).refusal).toContain('“2026-09-01” is a date')
    })

    it('lets a date-shaped name that is no day through, since no journal entry could have it', () => {
        expect(plan('Meeting', '2026-13-45', ['Meeting']).refusal).toBeNull()
    })

    it('lets a page an older version named after a day be renamed away from it', () => {
        // The way out for a `pages/2026-09-01.md` written before ADR 0056.
        expect(plan('2026-09-01', 'Launch Day', ['2026-09-01']).refusal).toBeNull()
    })
})
