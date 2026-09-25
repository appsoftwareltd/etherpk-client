import { describe, expect, it } from 'vitest'

import type { Subdir } from '$lib/storage/fs/directory-adapter'
import {
    type MirrorDocument,
    type MirrorFile,
    baseFileName,
    claimedConcept,
    planMirrorNames,
} from './mirror-names'

function page(docId: string, concept: string): MirrorDocument {
    return { docId, kind: 'page', concept }
}
function journal(docId: string, date: string): MirrorDocument {
    return { docId, kind: 'journal', concept: date }
}
function folder(files: Partial<Record<Subdir, MirrorFile[]>>): Map<Subdir, MirrorFile[]> {
    return new Map<Subdir, MirrorFile[]>([
        ['journals', files.journals ?? []],
        ['pages', files.pages ?? []],
    ])
}
/** The whole plan as `docId → file name`, which is all a caller ever asks it for. */
function names(plan: ReturnType<typeof planMirrorNames>): Record<string, string> {
    return Object.fromEntries(plan.byDocId)
}

describe('claimedConcept', () => {
    it('reads the title a mirror file carries, and falls back to its own stem', () => {
        expect(claimedConcept('A_B.md', '---\ntitle: A/B\n---\nbody\n')).toBe('A/B')
        expect(claimedConcept('2026-09-09.md', '- did a thing\n')).toBe('2026-09-09')
        // A blank title is no claim, exactly as the Filesystem Backend's scan reads it.
        expect(claimedConcept('Plain.md', '---\ntitle: "  "\n---\n')).toBe('Plain')
        expect(claimedConcept('Broken.md', '---\ntitle: [unclosed\n---\n')).toBe('Broken')
    })
})

describe('baseFileName', () => {
    it('keeps the concept readable, replacing only what a filesystem cannot hold', () => {
        expect(baseFileName(page('1', 'Quantum Mechanics'))).toBe('Quantum Mechanics.md')
        expect(baseFileName(page('1', 'A/B'))).toBe('A_B.md')
        expect(baseFileName(journal('1', '2026-09-09'))).toBe('2026-09-09.md')
    })

    it('sidesteps names an operating system would refuse or silently change', () => {
        expect(baseFileName(page('1', 'CON'))).toBe('CON_.md')
        expect(baseFileName(page('1', 'Draft.'))).toBe('Draft.md')
        expect(baseFileName(page('1', '...'))).toBe('_.md')
        expect(baseFileName(page('1', 'x'.repeat(400))).length).toBeLessThanOrEqual(204)
        // A leading dot is a hidden file, and the import's junk filter would never bring it back.
        expect(baseFileName(page('1', '.profile'))).toBe('_profile.md')
        expect(baseFileName(page('1', '..'))).toBe('_.md')
    })
})

// `suffixedFileName` moved to `storage/file-names.ts` with its test: the Filesystem Backend
// allocates names by the same rule now.

describe('planMirrorNames', () => {
    it('names a fresh folder after the documents themselves', () => {
        const plan = planMirrorNames([page('p1', 'Quantum Mechanics'), journal('j1', '2026-09-09')], folder({}))
        expect(names(plan)).toEqual({ p1: 'Quantum Mechanics.md', j1: '2026-09-09.md' })
        expect(plan.collisions).toEqual([])
    })

    it('suffixes the file name of a second concept that maps to the same one', () => {
        const plan = planMirrorNames([page('p1', 'A/B'), page('p2', 'A_B')], folder({}))
        const allocated = names(plan)
        expect(new Set(Object.values(allocated))).toEqual(new Set(['A_B.md', 'A_B (2).md']))
        // Deterministic, by code unit: `A/B` sorts first, so it takes the unsuffixed name.
        expect(allocated).toEqual({ p1: 'A_B.md', p2: 'A_B (2).md' })
        expect(plan.collisions).toEqual([{ concept: 'A_B', fileName: 'A_B (2).md' }])
    })

    it('leaves an existing holder on its name when a colliding concept appears later', () => {
        // `A_B` was mirrored first and says so in its own frontmatter.
        const existing = folder({ pages: [{ name: 'A_B.md', concept: 'A_B' }] })
        const plan = planMirrorNames([page('p1', 'A/B'), page('p2', 'A_B')], existing)
        expect(names(plan)).toEqual({ p2: 'A_B.md', p1: 'A_B (2).md' })
        // ...and equally when it was the other one that got there first.
        const other = folder({ pages: [{ name: 'A_B.md', concept: 'A/B' }] })
        expect(names(planMirrorNames([page('p1', 'A/B'), page('p2', 'A_B')], other))).toEqual({
            p1: 'A_B.md',
            p2: 'A_B (2).md',
        })
    })

    it('keeps a suffixed holder on its suffix, and still reports it as a collision', () => {
        const existing = folder({
            pages: [
                { name: 'A_B.md', concept: 'A_B' },
                { name: 'A_B (2).md', concept: 'A/B' },
            ],
        })
        const plan = planMirrorNames([page('p1', 'A/B'), page('p2', 'A_B')], existing)
        expect(names(plan)).toEqual({ p2: 'A_B.md', p1: 'A_B (2).md' })
        expect(plan.collisions).toEqual([{ concept: 'A/B', fileName: 'A_B (2).md' }])
    })

    it('writes both of two documents that share one concept, rather than losing one', () => {
        // A concurrent creation race between devices: two registry entries, one title.
        const plan = planMirrorNames([page('b', 'Foo'), page('a', 'Foo')], folder({}))
        expect(names(plan)).toEqual({ a: 'Foo.md', b: 'Foo (2).md' })
        // Stable across passes: the same pair maps the same way once the files exist.
        const existing = folder({
            pages: [
                { name: 'Foo.md', concept: 'Foo' },
                { name: 'Foo (2).md', concept: 'Foo' },
            ],
        })
        expect(names(planMirrorNames([page('b', 'Foo'), page('a', 'Foo')], existing))).toEqual({
            a: 'Foo.md',
            b: 'Foo (2).md',
        })
    })

    it('does the same for two journals claiming one day', () => {
        const plan = planMirrorNames([journal('b', '2026-09-09'), journal('a', '2026-09-09')], folder({}))
        expect(names(plan)).toEqual({ a: '2026-09-09.md', b: '2026-09-09 (2).md' })
    })

    it('renames a file written under an older rule to the name its title gives it', () => {
        // An earlier mirror lower-cased and hyphenated everything. A folder like that, imported
        // as a local graph, would not look like one a local graph had written - so the file
        // follows the title, and the planner says which file to rename rather than write afresh.
        const existing = folder({
            pages: [
                { name: 'covariance-contravariance-in-c.md', concept: 'Covariance & Contravariance in C#' },
                { name: 'submeta-kimura.md', concept: 'Submeta Kimura' },
                { name: 'test-kanban.md', concept: 'Test [[Kanban]]' },
            ],
        })
        const plan = planMirrorNames(
            [page('p1', 'Covariance & Contravariance in C#'), page('p2', 'Submeta Kimura'), page('p3', 'Test [[Kanban]]')],
            existing,
        )
        expect(names(plan)).toEqual({
            p1: 'Covariance & Contravariance in C#.md',
            p2: 'Submeta Kimura.md',
            p3: 'Test [[Kanban]].md',
        })
        expect(Object.fromEntries(plan.renameFrom)).toEqual({
            p1: 'covariance-contravariance-in-c.md',
            p2: 'submeta-kimura.md',
            p3: 'test-kanban.md',
        })
        expect(plan.collisions).toEqual([])
    })

    it('treats a difference in case alone as a rename too, and not as a collision', () => {
        // Comparing the name case-sensitively against a claim recorded in lower case once made
        // each of these documents collide with itself; the tab listed 314 of them (2026-09-09).
        const existing = folder({
            pages: [
                { name: 'accessibility.md', concept: 'Accessibility' },
                { name: '7-zip.md', concept: '7-Zip' },
            ],
        })
        const plan = planMirrorNames([page('p1', 'Accessibility'), page('p2', '7-Zip')], existing)
        expect(names(plan)).toEqual({ p1: 'Accessibility.md', p2: '7-Zip.md' })
        expect(Object.fromEntries(plan.renameFrom)).toEqual({ p1: 'accessibility.md', p2: '7-zip.md' })
        expect(plan.collisions).toEqual([])
    })

    it('names nothing for renaming when the file is already called what its title says', () => {
        const existing = folder({ pages: [{ name: 'Accessibility.md', concept: 'Accessibility' }] })
        const plan = planMirrorNames([page('p1', 'Accessibility')], existing)
        expect(names(plan)).toEqual({ p1: 'Accessibility.md' })
        expect(plan.renameFrom.size).toBe(0)
    })

    it('reports a collision only when another document holds the name', () => {
        const plan = planMirrorNames([page('p1', 'A/B'), page('p2', 'A_B')], folder({}))
        expect(plan.collisions).toEqual([{ concept: 'A_B', fileName: 'A_B (2).md' }])
    })


    it('takes the name back off a file the graph no longer contains', () => {
        // `Old` was renamed to `New`: its file still claims `Old`, which is nobody's concept,
        // so the name is free and the leftover falls out of the claimed set for the sweep.
        const existing = folder({ pages: [{ name: 'New.md', concept: 'Old' }] })
        const plan = planMirrorNames([page('p1', 'New')], existing)
        expect(names(plan)).toEqual({ p1: 'New.md' })
        expect([...plan.claimed.get('pages')!]).toEqual(['new.md'])
    })

    it('claims only what it wrote, so everything else is a stray', () => {
        const existing = folder({
            pages: [
                { name: 'Kept.md', concept: 'Kept' },
                { name: 'Gone.md', concept: 'Gone' },
            ],
        })
        const plan = planMirrorNames([page('p1', 'Kept')], existing)
        expect([...plan.claimed.get('pages')!]).toEqual(['kept.md'])
    })

    it('compares names case-insensitively, as a Windows or macOS folder would', () => {
        const existing = folder({ pages: [{ name: 'foo.md', concept: 'Foo' }] })
        const plan = planMirrorNames([page('p1', 'Foo'), page('p2', 'FOO ')], existing)
        // The holder of the name keeps it (in its title's own case); the other is numbered,
        // because on a case-insensitive folder `FOO.md` and `Foo.md` are one file.
        expect(plan.byDocId.get('p1')).toBe('Foo.md')
        expect(plan.renameFrom.get('p1')).toBe('foo.md')
        expect(plan.byDocId.get('p2')).toBe('FOO (2).md')
    })
})
