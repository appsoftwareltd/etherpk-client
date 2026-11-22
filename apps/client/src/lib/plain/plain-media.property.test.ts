import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { createMemoryTreeAdapter } from './memory-tree-adapter'
import { createPlainMedia } from './plain-media'

/**
 * An open tab asks for its file again on every pass over the folder, between whatever another
 * program does to the file. Whatever the order, the URL handed back must be one made from the
 * bytes the file holds now, and a file that did not change must keep the URL it had: a new URL
 * makes a reader close its file and open it again.
 *
 * Fixed seed and run count. `PLAIN_FUZZ_RUNS` and `PLAIN_FUZZ_SEED` change them.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.PLAIN_FUZZ_SEED
    return { numRuns: Number(process.env.PLAIN_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261122 : Number(seed) }
}

type Step = { kind: 'ask' } | { kind: 'write'; text: string } | { kind: 'remove' }

const step: fc.Arbitrary<Step> = fc.oneof(
    { weight: 4, arbitrary: fc.constant<Step>({ kind: 'ask' }) },
    { weight: 2, arbitrary: fc.constantFrom('beans', 'peas', 'beans and peas').map((text): Step => ({ kind: 'write', text })) },
    { weight: 1, arbitrary: fc.constant<Step>({ kind: 'remove' }) },
)

describe('a file of a Plain Folder asked for again and again', () => {
    it('answers with a URL over the bytes the file holds now, and keeps the URL of a file that did not change', async () => {
        await fc.assert(
            fc.asyncProperty(fc.array(step, { maxLength: 30 }), async (steps) => {
                let t = 0
                const tree = createMemoryTreeAdapter({ now: () => (t += 1000), seed: { 'clips/rain.mp4': 'rain' } })
                /** What each URL was made over: the text the file held when its bytes were read. */
                const madeOver = new Map<string, string>()
                let lastRead = ''
                let n = 0
                const media = createPlainMedia(
                    {
                        stat: tree.stat,
                        async read(path) {
                            const file = await tree.read(path)
                            lastRead = new TextDecoder().decode(file.bytes)
                            return file
                        },
                    },
                    {
                        createObjectURL: () => {
                            const url = `blob:${++n}`
                            madeOver.set(url, lastRead)
                            return url
                        },
                        revokeObjectURL: (url) => void madeOver.delete(url),
                    },
                )
                let holds: string | null = 'rain'
                // In an object, so an assignment inside the loop is not narrowed away.
                const last: { answer: { url: string; version: number } | null } = { answer: null }
                let version = 0
                for (const next of steps) {
                    if (next.kind === 'write') {
                        await tree.write('clips/rain.mp4', new TextEncoder().encode(next.text))
                        holds = next.text
                        version++
                    } else if (next.kind === 'remove') {
                        if (holds !== null) await tree.remove('clips/rain.mp4')
                        holds = null
                        version++
                    } else {
                        const answer = await media.resolvePath('clips/rain.mp4')
                        if (holds === null) {
                            expect(answer).toBeNull()
                            continue
                        }
                        expect(answer).not.toBeNull()
                        // Not revoked, and made over what the file holds now.
                        expect(madeOver.get(answer!.url)).toBe(holds)
                        if (last.answer?.version === version) expect(answer!.url).toBe(last.answer.url)
                        last.answer = { url: answer!.url, version }
                    }
                }
            }),
            fuzz(500),
        )
    })
})
