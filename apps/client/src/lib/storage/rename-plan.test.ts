/**
 * The pure half of a rename plan: the collision rule, and the one exception to it - a
 * [[Protected Document]] never merges (ADR 0062).
 */
import { describe, expect, it } from 'vitest'

import { aliasesAfterRename, planRename, refuseProtectedMerges, refuseUnreadableBlocks } from './rename-plan'
import { landedName, mergeCount, renameSteps } from './rename'

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
    const aliases = [{ name: 'Growing Vegetables', concept: 'Vegetable Growing' }]
    const withAliases = (from: string, to: string, kind: 'page' | null) =>
        planRename({ from, to, concepts: ['Vegetable Growing', 'Kitchen Garden'], aliases, kind, referencingDocuments: 0 })

    it('merges a page renamed onto another page\'s alias into that page', () => {
        const out = withAliases('Kitchen Garden', 'Growing Vegetables', 'page')
        expect(out.refusal).toBeNull()
        expect(out.direct).toMatchObject({
            merges: true,
            redirects: false,
            to: 'Growing Vegetables',
            into: 'Vegetable Growing',
        })
    })

    it('redirects a pageless concept renamed onto an alias to the page that answers to it', () => {
        const out = withAliases('Physcis', 'Growing Vegetables', null)
        expect(out.direct).toMatchObject({ merges: false, redirects: true, into: 'Vegetable Growing' })
    })

    it('treats a page renamed onto one of its OWN aliases as a plain retitle', () => {
        const out = withAliases('Vegetable Growing', 'Growing Vegetables', 'page')
        expect(out.direct).toMatchObject({ merges: false, redirects: false, into: 'Growing Vegetables' })
    })

    it('asks the protected-merge rule about the page that answers to the name, not the alias', async () => {
        const asked: string[] = []
        await refuseProtectedMerges(withAliases('Kitchen Garden', 'Growing Vegetables', 'page'), (c) => (asked.push(c), false))
        expect(asked).toContain('Vegetable Growing')
        expect(asked).not.toContain('Growing Vegetables')
    })
})

/**
 * A link that named a page by one of its aliases, edited, renames that alias (ADR 0065, amended
 * 2026-10-04). The page keeps its title, the alias is rewritten on the arm the user chooses, as an
 * alias the cascade carries is, and what the alias scopes comes along. The plan says whose alias it
 * is, so the preview and both stores read one answer.
 */
describe('planRename — renaming an alias', () => {
    const concepts = ['Kanban', 'Roadmap', '[[Board]] Notes']
    const aliases = [
        { name: 'Board', concept: 'Kanban' },
        { name: 'Desk', concept: 'Kanban' },
        { name: 'Plan', concept: 'Roadmap' },
        { name: 'Planning [[Board]]', concept: 'Roadmap' },
    ]
    // No document has the name as its title, so the caller passes no kind.
    const renameAlias = (to: string, from = 'Board') => planRename({ from, to, concepts, aliases, kind: null, referencingDocuments: 0 })

    it('renames the alias on the page that holds it, and retitles nothing', () => {
        const out = renameAlias('Boards')
        expect(out.refusal).toBeNull()
        expect(out.aliasOf).toBe('Kanban')
        expect(out.direct).toEqual({ from: 'Board', to: 'Boards', hasDocument: false, merges: false, redirects: false, into: 'Boards' })
        expect(out.aliases[0]).toEqual({ holder: 'Kanban', from: 'Board', to: 'Boards' })
        expect(mergeCount(out)).toBe(0)
    })

    it('carries what the alias scopes along, titles and aliases alike, as a title rename does', () => {
        const out = renameAlias('Boards')
        expect(out.cascade.map((step) => [step.from, step.to])).toEqual([['[[Board]] Notes', '[[Boards]] Notes']])
        expect(out.aliases).toEqual([
            { holder: 'Kanban', from: 'Board', to: 'Boards' },
            { holder: 'Roadmap', from: 'Planning [[Board]]', to: 'Planning [[Boards]]' },
        ])
    })

    it('spells the old alias as the page holds it, whatever case the link used', () => {
        expect(renameAlias('Boards', 'board').aliases[0]).toEqual({ holder: 'Kanban', from: 'Board', to: 'Boards' })
    })

    it("lets the alias become another of the same page's names: the duplicate is dropped when written", () => {
        expect(renameAlias('Desk').refusal).toBeNull()
        expect(renameAlias('Kanban').refusal).toBeNull()
    })

    it('refuses a new name another page answers to, by title or by alias, naming both pages', () => {
        expect(renameAlias('Roadmap').refusal).toContain("“Roadmap” is another page's name")
        expect(renameAlias('Plan').refusal).toContain('“Plan” is already an alias of “Roadmap”')
        for (const taken of ['Roadmap', 'Plan']) expect(renameAlias(taken).refusal).toContain("“Kanban”'s alias “Board”")
    })

    it('refuses a day as the new name, since a day names its journal entry', () => {
        expect(renameAlias('2026-09-01').refusal).toContain('“2026-09-01” is a date')
    })

    it("renames a journal entry's alias, and the entry keeps its date", () => {
        const out = planRename({
            from: 'Launch day',
            to: 'Launch',
            concepts: ['2026-06-02'],
            aliases: [{ name: 'Launch day', concept: '2026-06-02' }],
            kind: null,
            referencingDocuments: 0,
        })
        expect(out.refusal).toBeNull()
        expect(out.aliasOf).toBe('2026-06-02')
        expect(out.aliases).toEqual([{ holder: '2026-06-02', from: 'Launch day', to: 'Launch' }])
    })

    it("is a page's rename when the name is its title, though another page has it as an alias", () => {
        const out = planRename({ from: 'Plan', to: 'Plans', concepts: ['Plan', 'Roadmap'], aliases: [{ name: 'Plan', concept: 'Roadmap' }], kind: 'page', referencingDocuments: 0 })
        expect(out.aliasOf).toBeNull()
        expect(out.direct.hasDocument).toBe(true)
    })

    it('is a pageless rename when no page answers to the name', () => {
        const out = renameAlias('Somewhere', 'Nowhere')
        expect(out.aliasOf).toBeNull()
        expect(out.aliases).toEqual([])
    })

    // A page whose title names its own alias as a scope is renamed by the cascade of that alias:
    // what the rename reports names it as it is afterwards.
    it('names a holder the cascade retitles by its title afterwards', () => {
        const out = planRename({
            from: 'Old',
            to: 'New',
            concepts: ['[[Old]] Notes'],
            aliases: [{ name: 'Old', concept: '[[Old]] Notes' }],
            kind: null,
            referencingDocuments: 0,
        })
        expect(out.aliasOf).toBe('[[Old]] Notes')
        expect(landedName(out, '[[Old]] Notes')).toBe('[[New]] Notes')
        expect(landedName(out, 'Unrelated')).toBe('Unrelated')
    })

    it("refuses when the holder's frontmatter cannot be read, since its alias list is rewritten", async () => {
        const out = await refuseUnreadableBlocks(
            renameAlias('Boards'),
            async () => null,
            async (concept) => (concept === 'Kanban' ? '---\ntitle: [Kanban\n---\n- body' : null),
        )
        expect(out.refusal).toContain('“Kanban”')
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

/**
 * An alias scoped by the renamed concept is carried along like a scoped title (ADR 0038, amended
 * 2026-10-03), on whatever document holds it: the plan lists it, so the preview and both stores
 * read the same rewrites, and a new form another document answers to refuses the rename.
 */
describe('planRename — scoped aliases', () => {
    const graph = (aliases: { name: string; concept: string }[], concepts = ['Garden', 'P', 'Diary']) =>
        planRename({ from: 'Garden', to: 'Gardens', concepts, aliases, kind: concepts.includes('Garden') ? 'page' : null, referencingDocuments: 0 })

    it('plans an alias scoped by the renamed concept, on the document that holds it', () => {
        const out = graph([{ name: 'Planning [[Garden]]', concept: 'P' }])
        expect(out.refusal).toBeNull()
        expect(out.aliases).toEqual([{ holder: 'P', from: 'Planning [[Garden]]', to: 'Planning [[Gardens]]' }])
        expect(out.cascade).toEqual([]) // P's title is not scoped
    })

    it('at any depth, on a journal, and for a pageless concept', () => {
        expect(graph([{ name: '[[[[Garden]] Theory]] Notes', concept: '2026-01-05' }], ['Garden', '2026-01-05']).aliases).toEqual([
            { holder: '2026-01-05', from: '[[[[Garden]] Theory]] Notes', to: '[[[[Gardens]] Theory]] Notes' },
        ])
        const pageless = graph([{ name: 'Planning [[Garden]]', concept: 'P' }], ['P'])
        expect(pageless.direct.hasDocument).toBe(false)
        expect(pageless.aliases).toHaveLength(1)
    })

    it('leaves an alias that names the concept as plain text, not as a link, alone', () => {
        expect(graph([{ name: 'Garden notes', concept: 'P' }, { name: '[Garden] notes', concept: 'P' }]).aliases).toEqual([])
    })

    it('plans an alias on a document the cascade retitles, under its old name', () => {
        const out = graph([{ name: '[[Garden]] tools', concept: 'Tools [[Garden]]' }], ['Garden', 'Tools [[Garden]]'])
        expect(out.refusal).toBeNull()
        expect(out.cascade.map((s) => s.to)).toEqual(['Tools [[Gardens]]'])
        expect(out.aliases).toEqual([{ holder: 'Tools [[Garden]]', from: '[[Garden]] tools', to: '[[Gardens]] tools' }])
    })

    it('is no collision when the same document already answers to the new form', () => {
        const out = graph([
            { name: 'Planning [[Garden]]', concept: 'P' },
            { name: 'Planning [[Gardens]]', concept: 'P' },
        ])
        expect(out.refusal).toBeNull()
        expect(out.aliases).toEqual([{ holder: 'P', from: 'Planning [[Garden]]', to: 'Planning [[Gardens]]' }])
    })

    it("refuses one whose new form is another document's title, naming the alias and both documents", () => {
        const out = graph([{ name: 'Planning [[Garden]]', concept: 'P' }], ['Garden', 'P', 'Planning [[Gardens]]'])
        expect(out.refusal).toContain('“P”')
        expect(out.refusal).toContain('“Planning [[Garden]]”')
        expect(out.refusal).toContain('already a name of “Planning [[Gardens]]”')
    })

    it("refuses one whose new form is another document's alias", () => {
        const out = graph([
            { name: 'Planning [[Garden]]', concept: 'P' },
            { name: 'Planning [[Gardens]]', concept: 'Q' },
        ], ['Garden', 'P', 'Q'])
        expect(out.refusal).toContain('already a name of “Q”')
    })

    it('refuses one whose new form a title of the same rename lands on', () => {
        // The page Tools [[Garden]] and P's alias Tools [[Garden]] would both become Tools [[Gardens]].
        const out = graph([{ name: 'Tools [[Garden]]', concept: 'P' }], ['Garden', 'P', 'Tools [[Garden]]'])
        expect(out.refusal).toContain('“Tools [[Gardens]]”')
        expect(out.refusal).toContain('“Tools [[Garden]]”')
    })

    it("refuses when a holder's frontmatter cannot be read, as for a cascaded title", async () => {
        const unreadable = '---\ntitle: P\ntitle: P\n---\n- body'
        const out = await refuseUnreadableBlocks(graph([{ name: 'Planning [[Garden]]', concept: 'P' }]), async (concept) =>
            concept === 'P' ? unreadable : `---\ntitle: ${concept}\n---\n`,
        )
        expect(out.refusal).toContain('“P”')
    })
})

describe('aliasesAfterRename', () => {
    const rewrites = [{ holder: 'P', from: 'Planning [[Garden]]', to: 'Planning [[Gardens]]' }]

    it('replaces the alias in place under the rewrite arm', () => {
        expect(aliasesAfterRename(['First', 'planning [[GARDEN]]', 'Last'], rewrites, 'rewrite')).toEqual(['First', 'Planning [[Gardens]]', 'Last'])
    })

    it('keeps the old alias and adds the new form beside it under the alias arm', () => {
        expect(aliasesAfterRename(['First', 'Planning [[Garden]]'], rewrites, 'alias')).toEqual([
            'First',
            'Planning [[Garden]]',
            'Planning [[Gardens]]',
        ])
    })

    it('leaves a list with none of the rewritten aliases as it is', () => {
        expect(aliasesAfterRename(['First'], rewrites, 'rewrite')).toEqual(['First'])
    })
})

/**
 * A collision is judged on the documents each name ends up in: a holder and an "other" document
 * that the same rename merges into one are not two documents sharing a name (the review of
 * 2026-10-03 found parallel hierarchies refused).
 */
describe('planRename — scoped aliases where the rename merges', () => {
    const input = (concepts: string[], aliases: { name: string; concept: string }[], to = 'Orchard') =>
        planRename({ from: 'Garden', to, concepts, aliases, kind: 'page', referencingDocuments: 0 })

    it('lets a parallel hierarchy merge, each scoped page bringing its alias', () => {
        const out = input(['Garden', 'Orchard', '[[Garden]] y', '[[Orchard]] y'], [
            { name: '[[Garden]] q', concept: '[[Garden]] y' },
            { name: '[[Orchard]] q', concept: '[[Orchard]] y' },
        ])
        expect(out.refusal).toBeNull()
        expect(out.cascade[0]).toMatchObject({ from: '[[Garden]] y', merges: true, into: '[[Orchard]] y' })
        expect(out.aliases).toEqual([{ holder: '[[Garden]] y', from: '[[Garden]] q', to: '[[Orchard]] q' }])
    })

    it('lets a direct merge through when both pages hold the two forms', () => {
        const out = input(['Garden', 'Orchard'], [
            { name: '[[Garden]] q', concept: 'Garden' },
            { name: '[[Orchard]] q', concept: 'Orchard' },
        ])
        expect(out.refusal).toBeNull()
    })

    it('lets it through when the survivor holds the old form and the absorbed page the new one', () => {
        const out = input(['Garden', 'Orchard', '[[Garden]] y', '[[Orchard]] y'], [
            { name: '[[Garden]] q', concept: '[[Orchard]] y' },
            { name: '[[Orchard]] q', concept: '[[Garden]] y' },
        ])
        expect(out.refusal).toBeNull()
    })

    it('treats a re-casing as no collision, as a rename to a new name is', () => {
        const shared = [
            { name: '[[Garden]] z', concept: 'P' },
            { name: '[[Garden]] z', concept: 'Q' },
        ]
        expect(input(['Garden', 'P', 'Q'], shared, 'GARDEN').refusal).toBeNull()
        expect(input(['Garden', 'P', 'Q'], shared).refusal).toBeNull()
    })

    it('refuses two different old aliases that would become one new name', () => {
        const out = input(['Garden', 'Orchard', 'P', 'Q'], [
            { name: '[[Garden]] z', concept: 'P' },
            { name: '[[Orchard]] z', concept: 'Q' },
        ])
        // Q already has the new form: P's rewrite would land on it.
        expect(out.refusal).toContain('already a name of “Q”')
    })

    it('refuses two different aliases the rename would turn into the same name', () => {
        // The cascade's rule reads [[ Garden ]] as the link Garden, so both become [[Orchard]] z.
        const out = input(['Garden', 'P', 'Q'], [
            { name: '[[Garden]] z', concept: 'P' },
            { name: '[[ Garden ]] z', concept: 'Q' },
        ])
        expect(out.refusal).toContain('“P”')
        expect(out.refusal).toContain('“Q”')
        expect(out.refusal).toContain('“[[Orchard]] z”')
    })

    it('says a title step gives the name, rather than that it already has it', () => {
        const out = input(['Garden', 'P', 'Tools [[Garden]]'], [{ name: 'Tools [[Garden]]', concept: 'P' }])
        expect(out.refusal).toContain('the rename gives that name to “Tools [[Garden]]”')
    })
})
