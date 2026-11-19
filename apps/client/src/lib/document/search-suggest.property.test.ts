import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { applySearchSuggestion, keyCompletion, suggestionContext } from './search-suggest'

/**
 * The ghost text after the caret is a promise about Tab: whatever the box holds, where a completion
 * is shown, accepting it writes exactly what was on screen (the typed letters and the ghost, read
 * without case), puts the caret straight after it, and leaves everything else in the box alone.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261119 : Number(seed) }
}

const KEYS = ['title', 'template', 'status', 'stage', 'tags', 'date', 'author']
const keyInfo = fc.shuffledSubarray(KEYS, { minLength: 1 }).map((list) => list.map((key, k) => ({ key, documents: 10 - k })))
const word = fc.constantFrom('t', 'ti', 'te', 'S', 'sta', 'da', 'beans', 'garden', '-t', '-sta', 'AU', 'x')
const words = fc.array(word, { minLength: 1, maxLength: 4 })

describe('keyCompletion', () => {
    it('writes on Tab exactly the letters and the ghost the box showed, and nothing else', () => {
        fc.assert(
            fc.property(keyInfo, words, fc.nat(), (keys, parts, pick) => {
                const input = parts.join(' ')
                // The caret at the end of one of the words.
                const ends = parts.map((_, k) => parts.slice(0, k + 1).join(' ').length)
                const caret = ends[pick % ends.length]
                const known = new Set(keys.map((info) => info.key))
                const context = suggestionContext(input, caret, known)
                const ghost = keyCompletion(input, caret, context, keys)
                fc.pre(ghost !== null && context !== null)
                const next = applySearchSuggestion(input, context!, ghost!.suggestion)
                const shown = input.slice(0, caret) + ghost!.rest
                expect(next.value.slice(0, next.caret).toLowerCase()).toBe(shown.toLowerCase())
                expect(next.value.slice(next.caret)).toBe(input.slice(caret))
            }),
            fuzz(500),
        )
    })
})
