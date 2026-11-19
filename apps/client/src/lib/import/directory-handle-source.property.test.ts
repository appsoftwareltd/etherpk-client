import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { walkDirectory } from './directory-handle-source'
import { prepareSource } from './run-import'
import { contentFiles } from './source'
import { fakeDirectory } from './testing/fake-directory'

/** A fixed seed keeps CI deterministic; `WALK_FUZZ_SEED` and `WALK_FUZZ_RUNS` hunt for more. */
function params(runs = 300) {
    const seed = process.env.WALK_FUZZ_SEED
    return { numRuns: Number(process.env.WALK_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261119 : Number(seed) }
}

/** Path segments a graph folder holds, junk among them, so the filter is exercised at every depth. */
const SEGMENT = fc.constantFrom(
    'pages', 'journals', 'assets', 'etherpk', 'logseq', 'notes', 'deep',
    '.git', '.obsidian', 'node_modules', '__MACOSX', '.DS_Store',
    'Beans.md', 'Kitchen.md', 'seed.png', 'settings.json', 'config.edn',
)

/**
 * A folder tree as its file paths. A path that is a prefix folder of another is dropped, since one
 * name cannot be a file and a folder at once.
 */
const tree = fc
    .uniqueArray(fc.array(SEGMENT, { minLength: 1, maxLength: 4 }).map((segments) => segments.join('/')), { maxLength: 25 })
    .map((paths) => paths.filter((path) => !paths.some((other) => other.startsWith(`${path}/`))))

/** The same tree as a `webkitdirectory` input lists it: each file's path starts with the folder's name. */
function webkitList(folder: string, paths: string[]): File[] {
    return paths.map((path) => {
        const file = new File([path], path.slice(path.lastIndexOf('/') + 1))
        Object.defineProperty(file, 'webkitRelativePath', { value: `${folder}/${path}` })
        return file
    })
}

describe('walkDirectory, over any folder tree', () => {
    it('gives the content files a webkitdirectory pick of the same folder gives', async () => {
        await fc.assert(
            fc.asyncProperty(tree, async (paths) => {
                const walked = await walkDirectory(fakeDirectory('Garden', Object.fromEntries(paths.map((path) => [path, path]))))
                const picked = prepareSource(webkitList('Garden', paths))
                const expected = contentFiles(picked?.files ?? []).map((file) => file.path).sort()
                expect(walked.map((file) => file.path)).toEqual(expected)
                // Each path reads back the bytes of the file at that path.
                for (const file of walked) expect(await file.data.text()).toBe(file.path)
            }),
            params(),
        )
    })
})
