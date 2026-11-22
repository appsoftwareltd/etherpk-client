import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FolderTreeAdapter } from './folder-tree-adapter'
import { createMemoryTreeAdapter } from './memory-tree-adapter'
import { createPlainFolderStore } from './plain-folder-store'

/**
 * A Plain Folder is written by other programs: an editor, an agent, a git checkout. Whatever
 * order a person's edits, the autosave, a rescan, a conflict choice and those outside writes and
 * removals come in, the store never writes over text another program put in the file unless the
 * person has been shown it, and never brings back a file another program removed unless they asked
 * (spec/folder-save, `PlainFolder.cfg`).
 *
 * Fixed seed and run count. `PLAIN_FUZZ_RUNS` and `PLAIN_FUZZ_SEED` change them.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.PLAIN_FUZZ_SEED
    return { numRuns: Number(process.env.PLAIN_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261121 : Number(seed) }
}

type Step = 'edit' | 'outside-write' | 'outside-remove' | 'autosave' | 'flush' | 'rescan' | 'keep-mine' | 'take-disk' | 'restore'

const steps = fc.array(
    fc.constantFrom<Step>('edit', 'outside-write', 'outside-remove', 'autosave', 'flush', 'rescan', 'keep-mine', 'take-disk', 'restore'),
    { minLength: 1, maxLength: 24 },
)

describe('A Plain Folder save and what another program wrote', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('never replaces unseen text, and never brings back a removed file unasked', async () => {
        await fc.assert(
            fc.asyncProperty(steps, async (run) => {
                let t = 1000
                const tree = createMemoryTreeAdapter({ now: () => (t += 1000), seed: { 'garden.md': 'beans\r\n' } })
                const text = async () => new TextDecoder().decode((await tree.read('garden.md')).bytes)
                /** Texts another program wrote (line feeds only, as a conflict shows them), and those the person has seen. */
                const outside = new Set<string>()
                const seen = new Set<string>()
                const lost: string[] = []
                const broughtBack: string[] = []
                /** A removal by another program that the person has not answered with Restore or Keep mine. */
                let removedUnanswered = false
                const watched: FolderTreeAdapter = {
                    ...tree,
                    write: async (path, bytes) => {
                        const next = new TextDecoder().decode(bytes)
                        if ((await tree.stat(path)) === null) {
                            if (removedUnanswered) broughtBack.push(next)
                        } else {
                            const before = (await text()).replace(/\r\n/g, '\n')
                            if (outside.has(before) && !seen.has(before) && before !== next.replace(/\r\n/g, '\n')) lost.push(before)
                        }
                        return tree.write(path, bytes)
                    },
                }
                const store = createPlainFolderStore(watched, { autosaveMs: 400, onConflict: (c) => seen.add(c.diskText) })
                const doc = store.open('garden.md')
                doc.subscribe((shown) => seen.add(shown))
                await store.whenReady('garden.md')

                let n = 0
                for (const step of run) {
                    n++
                    if (step === 'edit') doc.applyChange({ from: 0, to: 0, insert: `e${n} ` })
                    else if (step === 'outside-write') {
                        outside.add(`outside ${n}\n`)
                        await tree.write('garden.md', new TextEncoder().encode(`outside ${n}\r\n`))
                        removedUnanswered = false
                    } else if (step === 'outside-remove') {
                        await tree.remove('garden.md')
                        removedUnanswered = true
                    } else if (step === 'autosave') await vi.advanceTimersByTimeAsync(400)
                    else if (step === 'flush') await store.flushDocument('garden.md')
                    else if (step === 'rescan') await store.reconcile()
                    else if (step === 'restore') {
                        removedUnanswered = false
                        await store.restore('garden.md')
                    } else {
                        // Keeping your version over a file that is gone is asking for it back.
                        if (step === 'keep-mine' && store.stateOf('garden.md')?.conflict) removedUnanswered = false
                        await store.resolveConflict('garden.md', step).catch(() => undefined)
                    }
                }
                expect(lost).toEqual([])
                expect(broughtBack).toEqual([])
            }),
            fuzz(400),
        )
    })
})
