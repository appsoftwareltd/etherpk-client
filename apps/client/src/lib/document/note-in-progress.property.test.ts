import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { AssetStore } from '#lib/storage/fs/asset-store.js'

import { NoteInProgress, type NoteStorage } from './note-in-progress'
import { getQuickNotes, resetQuickNotes, setQuickNotes } from './quick-notes'

/**
 * The note being written in Quick notes: over any order of typing, choosing files, adding, writes
 * that land or are refused later, and shares offered from outside, no words and no file are lost.
 * `DOCUMENT_FUZZ_SEED=<n>` and `DOCUMENT_FUZZ_RUNS=<n>` replay or lengthen a run.
 */
function params(runs: number) {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261123 : Number(seed) }
}

type Step = { do: 'type' } | { do: 'file' } | { do: 'add' } | { do: 'offer' } | { do: 'settle'; lands: boolean; which: number }

const step: fc.Arbitrary<Step> = fc.oneof(
    fc.constant<Step>({ do: 'type' }),
    fc.constant<Step>({ do: 'file' }),
    fc.constant<Step>({ do: 'add' }),
    fc.constant<Step>({ do: 'offer' }),
    fc.record({ do: fc.constant('settle' as const), lands: fc.boolean(), which: fc.nat(5) }),
)

describe('a note in progress', () => {
    it('loses no words and no file, whatever the order writes land or are refused in', async () => {
        await fc.assert(
            fc.asyncProperty(fc.array(step, { maxLength: 30 }), async (steps) => {
                const writes: { resolve(): void; reject(error: Error): void }[] = []
                resetQuickNotes()
                setQuickNotes([], { add: () => new Promise<void>((resolve, reject) => void writes.push({ resolve, reject })), remove: async () => {} })
                const storage: NoteStorage = {
                    assets: () => ({ save: async ({ name }: { name: string }) => ({ name, stem: name, isImage: false, ref: `../assets/${name}` }) }) as unknown as AssetStore,
                    imageSize: () => undefined,
                    optimize: async (given) => ({ file: given }) as never,
                }
                const note = new NoteInProgress()
                const words: string[] = []
                const files: string[] = []
                const adding: Promise<void>[] = []
                const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
                for (const taken of steps) {
                    const name = `w${words.length + files.length}w`
                    if (taken.do === 'type') {
                        words.push(name)
                        note.text = `${note.text} ${name}`
                    } else if (taken.do === 'offer') {
                        words.push(name)
                        note.offer(name)
                    } else if (taken.do === 'file') {
                        files.push(name)
                        note.files.add([new File(['x'], name)])
                    } else if (taken.do === 'add') {
                        adding.push(note.add(storage))
                        await settle()
                    } else {
                        const [write] = writes.splice(taken.which % Math.max(1, writes.length), 1)
                        if (taken.lands) write?.resolve()
                        else write?.reject(new Error('refused'))
                        await settle()
                    }
                }
                while (writes.length > 0) {
                    writes.pop()!.resolve()
                    await settle()
                }
                await Promise.all(adding)
                const kept = [...getQuickNotes().map((held) => held.text), note.text].join('\n')
                const keptFiles = `${kept}\n${note.files.files.map((held) => held.name).join('\n')}`
                for (const word of words) expect(kept).toContain(word)
                for (const name of files) expect(keptFiles).toContain(name)
                expect(note.storing).toBe(0)
            }),
            params(60),
        )
    }, 30_000)
})
