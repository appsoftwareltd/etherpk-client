import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DirectoryAdapter } from './directory-adapter'
import { createFilesystemDocumentStore } from './filesystem-store'
import { createMemoryDirectoryAdapter } from './memory-adapter'

/**
 * A folder is written by other programs too: an editor, an agent, a git checkout. Whatever order
 * a person's edits, the autosave, a rescan and those outside writes come in, the app never writes
 * over text another program put in the file unless the person has seen it: the buffer reloaded
 * it, or a conflict showed it to them (spec/folder-save, `NoUnseenVersionOverwritten`).
 *
 * Fixed seed and run count, so a failure reproduces. `SAVE_FUZZ_RUNS` and `SAVE_FUZZ_SEED` change
 * them for a longer run, or to repeat one.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.SAVE_FUZZ_SEED
    return { numRuns: Number(process.env.SAVE_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261121 : Number(seed) }
}

type Step = 'edit' | 'outside-write' | 'outside-remove' | 'autosave' | 'flush' | 'rescan' | 'keep-mine' | 'take-disk'

const steps = fc.array(
    fc.constantFrom<Step>('edit', 'outside-write', 'outside-remove', 'autosave', 'flush', 'rescan', 'keep-mine', 'take-disk'),
    { minLength: 1, maxLength: 24 },
)

describe('A save never writes over what another program wrote unseen', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('holds for any order of edits, saves, rescans and outside writes', async () => {
        await fc.assert(
            fc.asyncProperty(steps, async (run) => {
                let t = 1000
                const fs = createMemoryDirectoryAdapter({ now: () => (t += 1000), seed: { pages: { 'Garden.md': 'beans' } } })
                /** Texts another program wrote, and those of them the person has been shown. */
                const outside = new Set<string>()
                const seen = new Set<string>()
                const lost: string[] = []
                // The store's own writes go through here; the outside program writes to `fs` itself.
                const watched: DirectoryAdapter = {
                    ...fs,
                    write: async (subdir, name, text) => {
                        if (await fs.exists(subdir, name)) {
                            const before = (await fs.read(subdir, name)).text
                            if (outside.has(before) && !seen.has(before) && before !== text) lost.push(before)
                        }
                        return fs.write(subdir, name, text)
                    },
                }
                const store = createFilesystemDocumentStore(watched, { autosaveMs: 400, onConflict: (c) => seen.add(c.diskText) })
                await store.scan()
                const doc = store.open('Garden')
                doc.subscribe((text) => seen.add(text))
                await store.whenReady('Garden')

                let n = 0
                for (const step of run) {
                    n++
                    if (step === 'edit') doc.applyChange({ from: 0, to: 0, insert: `e${n} ` })
                    else if (step === 'outside-write') {
                        const text = `outside ${n}`
                        outside.add(text)
                        await fs.write('pages', 'Garden.md', text)
                    } else if (step === 'outside-remove') await fs.remove('pages', 'Garden.md')
                    else if (step === 'autosave') await vi.advanceTimersByTimeAsync(400)
                    else if (step === 'flush') await store.flushDocument('Garden').catch(() => undefined)
                    else if (step === 'rescan') await store.reconcile()
                    else await store.resolveConflict('Garden', step).catch(() => undefined)
                }
                expect(lost).toEqual([])
            }),
            fuzz(300),
        )
    })
})
