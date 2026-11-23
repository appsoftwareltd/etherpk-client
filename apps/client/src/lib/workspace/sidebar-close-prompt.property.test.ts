import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { closePrompt, reopeningChord } from './sidebar-close-prompt'

/** `DOCUMENT_FUZZ_SEED=<n>` and `DOCUMENT_FUZZ_RUNS=<n>` replay or lengthen a run. */
function params(runs: number) {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261123 : Number(seed) }
}

// Names with no letter in common with the sentence around them, so a search for one finds only it.
const views = fc
    .uniqueArray(fc.integer({ min: 100, max: 999 }), { minLength: 1, maxLength: 6 })
    .chain((ids) => fc.tuple(...ids.map((id) => fc.record({ name: fc.constant(`[${id}]`), chord: fc.oneof(fc.constant(null), fc.constant(`<${id}>`)) }))))

describe('what closing Sidebar Views asks', () => {
    it('names every View once in the question, and tells the way back to each one once', () => {
        fc.assert(
            fc.property(views, fc.constantFrom('Close' as const, 'Hide' as const), (closing, verb) => {
                const { title, message, confirmLabel } = closePrompt(closing, verb)
                expect(confirmLabel).toBe(verb)
                expect(title.startsWith(`${verb} `) && title.endsWith('?')).toBe(true)
                for (const view of closing) {
                    expect(title.split(view.name)).toHaveLength(2)
                    if (view.chord !== null) expect(message.split(view.chord)).toHaveLength(2)
                    if (closing.length > 1) expect(message.split(view.name)).toHaveLength(2)
                }
                expect(message.includes('Activity Bar')).toBe(closing.some((view) => view.chord === null))
                expect(message).not.toContain('null')
            }),
            params(300),
        )
    })

    it('never names a shortcut the app cannot hear', () => {
        const key = fc.record({ mods: fc.subarray(['Mod', 'Ctrl', 'Alt', 'Shift']), letter: fc.constantFrom('B', 'K', 'C') }).map(({ mods, letter }) => [...mods, letter].join('+'))
        fc.assert(
            fc.property(fc.array(fc.record({ key, command: fc.constantFrom('a', 'b') }), { maxLength: 6 }), fc.boolean(), (bindings, apple) => {
                const named = reopeningChord(bindings, 'a', apple)
                const heard = bindings.filter((binding) => binding.command === 'a' && !(apple && binding.key.includes('Alt') && !/Mod|Ctrl/.test(binding.key)))
                expect(named === null).toBe(heard.length === 0)
            }),
            params(300),
        )
    })
})
