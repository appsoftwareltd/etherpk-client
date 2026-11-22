import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { AGENTS_MD_BEGIN } from '../storage/fs/agents-md'

import { classifyFolder, isGraphFolder, probeFolder } from './classify-folder'
import type { FolderTreeAdapter } from './folder-tree-adapter'
import { createMemoryTreeAdapter } from './memory-tree-adapter'

/**
 * Choosing a folder must be safe before the person has answered anything (ADR 0194). Whatever a
 * folder holds: looking inside changes nothing in it, and a folder EtherPK has written a graph
 * into is never offered as a Plain Folder, where its files would be edited without the graph's
 * rules.
 *
 * Fixed seed and run count. `PLAIN_FUZZ_RUNS` and `PLAIN_FUZZ_SEED` change them.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.PLAIN_FUZZ_SEED
    return { numRuns: Number(process.env.PLAIN_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261121 : Number(seed) }
}

const name = fc.constantFrom('etherpk', 'journals', 'pages', 'assets', 'logseq', '.obsidian', '.asnotes', '.git', 'node_modules', 'guide', 'notes')
const fileName = fc.constantFrom('Garden.md', 'settings.json', '2026-11-21.md', '2026_11_21.md', 'bed.png', 'pump.pdf', 'AGENTS.md', 'README.md', '.DS_Store')
const content = fc.constantFrom('water the beans', `${AGENTS_MD_BEGIN}\nrules`, '{}', '')
const files = fc.dictionary(
    fc.tuple(fc.array(name, { maxLength: 3 }), fileName).map(([dirs, file]) => [...dirs, file].join('/')),
    content,
    { maxKeys: 12 },
)

/** A tree whose every changing method fails the test, over one that works. */
function readOnly(tree: FolderTreeAdapter): FolderTreeAdapter {
    const refuse = (what: string) => () => {
        throw new Error(`a look inside a folder must not ${what}`)
    }
    return { ...tree, write: refuse('write a file'), createDirectory: refuse('create a directory'), remove: refuse('remove anything'), move: refuse('move anything') }
}

describe('choosing a folder', () => {
    it('looking inside never changes it', async () => {
        await fc.assert(
            fc.asyncProperty(files, async (seed) => {
                const tree = createMemoryTreeAdapter({ now: () => 1000, seed })
                const listing = async (dir: string): Promise<string[]> => {
                    const out: string[] = []
                    for (const entry of await tree.list(dir)) {
                        const path = dir === '' ? entry.name : `${dir}/${entry.name}`
                        out.push(`${entry.kind}:${path}`)
                        if (entry.kind === 'directory') out.push(...(await listing(path)))
                    }
                    return out.sort()
                }
                const before = await listing('')
                await probeFolder(readOnly(tree))
                expect(await listing('')).toEqual(before)
            }),
            fuzz(300),
        )
    })

    it('a folder holding a graph is never offered as a Plain Folder', async () => {
        await fc.assert(
            fc.asyncProperty(files, async (seed) => {
                const probe = await probeFolder(createMemoryTreeAdapter({ now: () => 1000, seed }))
                const verdict = classifyFolder(probe, null)
                // Read from the files themselves, not from the probe under test.
                const paths = Object.keys(seed)
                const hasGraphDirectory = paths.some((path) => path.startsWith('etherpk/'))
                const hasManagedSection = seed['AGENTS.md']?.includes(AGENTS_MD_BEGIN) === true
                const hasLayout = paths.some((path) => path.startsWith('journals/')) && paths.some((path) => path.startsWith('pages/'))
                if (hasGraphDirectory || (hasLayout && hasManagedSection)) expect(verdict.kind).toBe('graph-folder')
                if (verdict.kind === 'ask') {
                    expect(verdict.choices).toContain(verdict.preferred)
                    expect(isGraphFolder(verdict.probe)).toBe(false)
                }
            }),
            fuzz(500),
        )
    })
})
