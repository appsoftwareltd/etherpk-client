import { describe, expect, it } from 'vitest'

import { typewriterFrames } from './typewriter'

const TIMING = { holdMs: 1000, deleteMs: 40, typeMs: 70 }

describe('typewriterFrames', () => {
    it('starts on the first word, held', () => {
        const [first] = typewriterFrames(['Garden', 'Kitchen'], TIMING)
        expect(first).toEqual({ text: 'Garden', waitMs: 1000, holding: true })
    })

    it('deletes a word one character at a time, then types the next one character at a time', () => {
        const frames = typewriterFrames(['Pea', 'Bean'], TIMING)
        expect(frames.slice(0, 8)).toEqual([
            { text: 'Pea', waitMs: 1000, holding: true },
            { text: 'Pe', waitMs: 40, holding: false },
            { text: 'P', waitMs: 40, holding: false },
            { text: '', waitMs: 70, holding: false },
            { text: 'B', waitMs: 70, holding: false },
            { text: 'Be', waitMs: 70, holding: false },
            { text: 'Bea', waitMs: 70, holding: false },
            { text: 'Bean', waitMs: 1000, holding: true },
        ])
    })

    it('shows every word in order and ends on the first word again', () => {
        const words = ['Everything', 'Garden', 'Kitchen Notes', 'Shed']
        const frames = typewriterFrames(words, TIMING)
        expect(frames.filter((frame) => frame.holding).map((frame) => frame.text)).toEqual([...words, 'Everything'])
        expect(frames.at(-1)?.text).toBe('Everything')
    })

    it('changes the text by exactly one character from one frame to the next', () => {
        const frames = typewriterFrames(['Everything', 'Your Garden', 'Shed'], TIMING)
        for (let i = 1; i < frames.length; i++) {
            const [shorter, longer] = [frames[i - 1].text, frames[i].text].sort((a, b) => a.length - b.length)
            expect(longer.length - shorter.length).toBe(1)
            expect(longer.startsWith(shorter)).toBe(true)
        }
    })

    it('shows a single word without animating it', () => {
        expect(typewriterFrames(['Garden'], TIMING)).toEqual([{ text: 'Garden', waitMs: 1000, holding: true }])
    })
})
