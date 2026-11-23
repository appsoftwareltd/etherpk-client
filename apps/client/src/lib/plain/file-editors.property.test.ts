import fc from 'fast-check'
import { describe, it, expect } from 'vitest'

import { createPersonSettings } from '../person-settings/person-settings'
import { type FileEditor, createFileEditors } from './file-editors'

/**
 * Random choices, defaults, moves and deletions against a plain model of what a person would
 * expect: a file they chose an editor for keeps it, wherever the file goes; every other markdown
 * file follows the default; and a file that is not markdown is always text.
 */
const SEED = Number(process.env.PLAIN_FUZZ_SEED ?? 20261123)
const RUNS = Number(process.env.PLAIN_FUZZ_RUNS ?? 300)

const PATHS = ['README.md', 'guide/soil.md', 'guide/deep/bed.md', 'guidebook.md', 'guide/water.yaml', 'notes.txt']
const FREE = ['moved.md', 'other/soil.md', 'other.txt']

type Step =
    | { do: 'choose'; path: string; editor: FileEditor }
    | { do: 'default'; editor: FileEditor }
    | { do: 'move'; from: string; to: string }
    | { do: 'remove'; path: string }
    | { do: 'reopen' }

const editor = fc.constantFrom<FileEditor>('markdown', 'text')
const step: fc.Arbitrary<Step> = fc.oneof(
    { weight: 4, arbitrary: fc.record({ do: fc.constant('choose' as const), path: fc.constantFrom(...PATHS, ...FREE), editor }) },
    { weight: 2, arbitrary: fc.record({ do: fc.constant('default' as const), editor }) },
    { weight: 2, arbitrary: fc.record({ do: fc.constant('move' as const), from: fc.constantFrom(...PATHS, 'guide', 'guide/deep'), to: fc.constantFrom(...FREE, 'elsewhere') }) },
    { weight: 1, arbitrary: fc.record({ do: fc.constant('remove' as const), path: fc.constantFrom(...PATHS, 'guide') }) },
    { weight: 1, arbitrary: fc.record({ do: fc.constant('reopen' as const) }) },
)

const isMarkdown = (path: string) => path.endsWith('.md')
const isUnder = (path: string, at: string) => path === at || path.startsWith(`${at}/`)

describe('the editors of a Plain Folder’s files, at random', () => {
    it('answers as the person’s own choices say, through any run of choices, moves, deletions and visits', () => {
        fc.assert(
            fc.property(fc.array(step, { maxLength: 30 }), (steps) => {
                const held = new Map<string, string>()
                const storage = { getItem: (k: string) => held.get(k) ?? null, setItem: (k: string, v: string) => void held.set(k, v), removeItem: (k: string) => void held.delete(k) } as unknown as Storage
                const settings = createPersonSettings(() => storage)
                let editors = createFileEditors({ folderId: 'garden', settings, storage })

                let fallback: FileEditor = 'markdown'
                let chosen = new Map<string, FileEditor>()
                for (const each of steps) {
                    if (each.do === 'choose') {
                        editors.choose(each.path, each.editor)
                        if (isMarkdown(each.path)) {
                            if (each.editor === fallback) chosen.delete(each.path)
                            else chosen.set(each.path, each.editor)
                            expect(editors.editorOf(each.path)).toBe(each.editor)
                        }
                    } else if (each.do === 'default') {
                        editors.setDefault(each.editor)
                        fallback = each.editor
                    } else if (each.do === 'move') {
                        editors.moved(each.from, each.to)
                        const next = new Map<string, FileEditor>()
                        // What was already at the destination is what the move replaced.
                        for (const [path, value] of chosen) if (!isUnder(path, each.from) && !isUnder(path, each.to)) next.set(path, value)
                        for (const [path, value] of chosen) if (isUnder(path, each.from)) next.set(each.to + path.slice(each.from.length), value)
                        chosen = next
                    } else if (each.do === 'remove') {
                        editors.removed(each.path)
                        chosen = new Map([...chosen].filter(([path]) => !isUnder(path, each.path)))
                    } else {
                        editors.dispose()
                        editors = createFileEditors({ folderId: 'garden', settings, storage })
                    }
                    for (const path of [...PATHS, ...FREE]) {
                        expect(editors.editorOf(path), `${path} after ${JSON.stringify(each)}`).toBe(isMarkdown(path) ? (chosen.get(path) ?? fallback) : 'text')
                    }
                }
            }),
            { seed: SEED, numRuns: RUNS },
        )
    })
})
