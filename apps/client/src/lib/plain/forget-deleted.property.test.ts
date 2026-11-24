import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { sha256 } from '../crypto/digest'

import { forgetDeleted, readDeleted } from './forget-deleted'
import { createMemoryTreeAdapter } from './memory-tree-adapter'
import { fileOfItem, isAbout, PDF_ANNOTATIONS } from './plain-reader-state'
import { createPlainStateFolder } from './plain-state-folder'

/**
 * Deleting a file or a directory of a Plain Folder (forget-deleted.ts), over any folder of PDFs with
 * shared bytes and any items about them: every item a file left in the folder would show stays, and
 * every item that only a deleted file would show goes.
 */

function runs(fallback: number): fc.Parameters<unknown> {
    const seed = process.env.PLAIN_FUZZ_SEED
    return { numRuns: Number(process.env.PLAIN_FUZZ_RUNS ?? fallback), seed: seed === undefined ? 20261124 : Number(seed) }
}

// Few paths and few contents, so that copies, stale paths and directories that share a prefix are common.
const PATHS = ['a.pdf', 'b.pdf', 'shelf/a.pdf', 'shelf/b.pdf', 'shelf/deep/a.pdf', 'shelf2/a.pdf', 'shelf.pdf']
const CONTENTS = ['pump', 'seed', 'longer text', 'soil']
const DELETABLE = [...PATHS, 'shelf', 'shelf/deep', 'shelf2']

const hash = async (text: string) => [...(await sha256(new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('')

describe('what stays when a file is deleted', () => {
    it('is exactly what the files left in the folder show', async () => {
        const files = fc.dictionary(fc.constantFrom(...PATHS), fc.constantFrom(...CONTENTS), { maxKeys: PATHS.length })
        const items = fc.array(fc.record({ path: fc.constantFrom(...PATHS), content: fc.constantFrom(...CONTENTS) }), { maxLength: 8 })
        await fc.assert(
            fc.asyncProperty(files, items, fc.constantFrom(...DELETABLE), async (held, wanted, path) => {
                const seed: Record<string, string> = { ...held }
                for (const [at, entry] of wanted.entries()) seed[`.etherpk/${PDF_ANNOTATIONS}/i${at}.json`] = JSON.stringify({ file: { path: entry.path, hash: await hash(entry.content) } })
                const tree = createMemoryTreeAdapter({ now: () => 1, seed })
                const kept = createPlainStateFolder(tree)
                const before = await kept.list(PDF_ANNOTATIONS)
                const under = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`)
                const gone = await Promise.all(Object.entries(held).filter(([file]) => under(file)).map(async ([file, text]) => ({ path: file, hash: await hash(text) })))
                const left = await Promise.all(Object.entries(held).filter(([file]) => !under(file)).map(async ([file, text]) => ({ path: file, hash: await hash(text) })))

                const deleted = await readDeleted(tree, kept, path)
                await tree.remove(path)
                await forgetDeleted(tree, kept, deleted, [])

                const shown = (value: unknown, by: { path: string; hash: string }[]) => by.some((file) => isAbout(value, file))
                // An item naming a path under the deleted entry is the deleted file's, read or not.
                const about = (value: unknown) => shown(value, gone) || under(fileOfItem(value)!.path)
                const expected = before.filter(({ value }) => shown(value, left) || !about(value)).map(({ id }) => id)
                expect((await kept.list(PDF_ANNOTATIONS)).map(({ id }) => id)).toEqual(expected)
            }),
            runs(300),
        )
    })
})
